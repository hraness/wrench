import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { dlopen, ptr } from "bun:ffi";

import {
  exportBeeperMessageLikeMeBundle,
  type BeeperMessageLikeMeBundleProgress,
} from "./beeper-message-like-me-export";
import {
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeDirectoryLease,
  type BeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";
import { canonicalJson, sha256 } from "./canonical-json";
import { removePrivateDirectoryTree } from "./storage";
import {
  WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS,
  WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT,
  WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS,
  WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
  WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
  WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
  parseWhatsAppMessageBundleV2Completion,
  parseWhatsAppMessageBundleV2Descriptor,
  parseWhatsAppMessageBundleV2Manifest,
  parseWhatsAppMessageBundleV2Record,
  toLocalMessageBundleV1Record,
  whatsAppMessageBundleV2BundleSha256,
  type WhatsAppMessageBundleV2Artifact,
  type WhatsAppMessageBundleV2Manifest,
} from "./whatsapp-message-bundle-v2";
import type { WhatsAppMessageLikeMeExportSource } from "./whatsapp-message-like-me-source";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DARWIN_RENAME_EXCL = 0x0000_0004;
const LINUX_RENAME_NOREPLACE = 0x0000_0001;
const AT_FDCWD = -100;

type NativeExclusiveRename = (source: Uint8Array, destination: Uint8Array) => number;
let cachedRename: NativeExclusiveRename | undefined;

export type WhatsAppMessageLikeMeBundleProgress =
  | BeeperMessageLikeMeBundleProgress
  | Readonly<{ phase: "v2-conversion"; artifact: number; artifacts: number; records: number }>;

export type WhatsAppMessageLikeMeExportRequest = Readonly<{
  outputRoot: string;
  source: WhatsAppMessageLikeMeExportSource;
  signal?: AbortSignal;
  onProgress?: (progress: WhatsAppMessageLikeMeBundleProgress) => void;
  clock?: () => Date;
  recoveryEnvironment?: Readonly<Record<string, string | undefined>>;
}>;

export type WhatsAppMessageLikeMeExportResult = Readonly<{
  outputRoot: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: WhatsAppMessageBundleV2Manifest;
}>;

type ArtifactWriter = {
  readonly specification: typeof WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS[number];
  readonly handle: FileHandle;
  readonly hash: ReturnType<typeof createHash>;
  records: number;
  bytes: number;
};

type PrivateDirectoryIdentity = Readonly<{
  device: number;
  inode: number;
}>;

type ValidatedOutputRoot = Readonly<{
  outputRoot: string;
  parent: string;
  parentIdentity: PrivateDirectoryIdentity;
}>;

type PrivateDirectory = Readonly<{
  path: string;
  identity: PrivateDirectoryIdentity;
}>;

type StagedManifest = Readonly<{
  bytes: number;
  sha256: string;
}>;

function fail(message: string): never {
  throw new Error(`WhatsApp Message Like Me export: ${message}`);
}

function isErrno(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) return fail("export was cancelled");
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw error;
  }
}

async function validateOutputRoot(value: unknown): Promise<ValidatedOutputRoot> {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || resolve(value) !== value
    || value === sep
    || value.length > 4_096
    || basename(value).includes("\0")
  ) return fail("--output must be a normalized absolute new directory");
  const parent = dirname(value);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(parent) !== parent) {
    return fail("output parent must be one canonical real directory");
  }
  const uid = process.getuid?.();
  if (uid === undefined) return fail("private exports require a POSIX user identity");
  if (metadata.uid !== uid) return fail("output parent must be owned by the current user");
  if ((metadata.mode & 0o022) !== 0) {
    return fail("output parent must not be writable by the group or other users");
  }
  if (!(await absent(value))) return fail("output directory already exists");
  return Object.freeze({
    outputRoot: value,
    parent,
    parentIdentity: Object.freeze({ device: metadata.dev, inode: metadata.ino }),
  });
}

async function assertParentUnchanged(output: ValidatedOutputRoot): Promise<void> {
  try {
    const metadata = await lstat(output.parent);
    const uid = process.getuid?.();
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || uid === undefined
      || metadata.uid !== uid
      || (metadata.mode & 0o022) !== 0
      || metadata.dev !== output.parentIdentity.device
      || metadata.ino !== output.parentIdentity.inode
      || await realpath(output.parent) !== output.parent
    ) return fail("output parent changed during export");
  } catch {
    return fail("output parent changed during export");
  }
}

async function assertPrivateDirectory(
  path: string,
  expected?: PrivateDirectoryIdentity,
): Promise<PrivateDirectoryIdentity> {
  try {
    const metadata = await lstat(path);
    const uid = process.getuid?.();
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || uid === undefined
      || metadata.uid !== uid
      || (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
      || (expected !== undefined
        && (metadata.dev !== expected.device || metadata.ino !== expected.inode))
      || await realpath(path) !== path
    ) return fail("private export directory changed");
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } catch {
    return fail("private export directory changed");
  }
}

async function removeOwnedPrivateDirectory(
  path: string,
  identity: PrivateDirectoryIdentity,
): Promise<void> {
  try {
    const removed = removePrivateDirectoryTree(path, Object.freeze({
      device: String(identity.device),
      inode: String(identity.inode),
    }));
    if (!removed) return fail("private export directory could not be removed safely");
  } catch {
    return fail("private export directory could not be removed safely");
  }
}

async function createPrivateDirectory(
  output: ValidatedOutputRoot,
  prefix: string,
): Promise<PrivateDirectory> {
  await assertParentUnchanged(output);
  const candidate = await mkdtemp(resolve(output.parent, prefix));
  let identity: PrivateDirectoryIdentity | undefined;
  try {
    await chmod(candidate, PRIVATE_DIRECTORY_MODE);
    identity = await assertPrivateDirectory(candidate);
    if (
      dirname(candidate) !== output.parent
      || identity.device !== output.parentIdentity.device
      || candidate === output.outputRoot
    ) return fail("private export directory must be a distinct sibling on the output filesystem");
    await assertParentUnchanged(output);
    return Object.freeze({ path: candidate, identity });
  } catch (error) {
    if (identity === undefined) {
      try {
        await rmdir(candidate);
      } catch {
        // Never recursively remove a directory whose identity was not captured.
      }
    } else {
      await removeOwnedPrivateDirectory(candidate, identity);
    }
    throw error;
  }
}

async function assertPrivateFile(path: string, expectedBytes: number): Promise<void> {
  try {
    const metadata = await lstat(path);
    const uid = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || uid === undefined
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
      || metadata.size !== expectedBytes
    ) return fail("private staged artifact changed");
  } catch {
    return fail("private staged artifact changed");
  }
}

async function privateFileSha256(path: string, expectedBytes: number): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("private staged artifact changed before validation");
  }
  try {
    const uid = process.getuid?.();
    const before = await handle.stat();
    const entryBefore = await lstat(path);
    if (
      !before.isFile()
      || uid === undefined
      || before.uid !== uid
      || before.nlink !== 1
      || (before.mode & 0o777) !== PRIVATE_FILE_MODE
      || before.size !== expectedBytes
      || !entryBefore.isFile()
      || entryBefore.isSymbolicLink()
      || entryBefore.dev !== before.dev
      || entryBefore.ino !== before.ino
      || entryBefore.nlink !== 1
    ) return fail("private staged artifact changed before validation");

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(buffer.byteLength, expectedBytes - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) return fail("private staged artifact ended during validation");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const after = await handle.stat();
    const entryAfter = await lstat(path);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || !after.isFile()
      || after.uid !== before.uid
      || after.nlink !== 1
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || (after.mode & 0o777) !== PRIVATE_FILE_MODE
      || !entryAfter.isFile()
      || entryAfter.isSymbolicLink()
      || entryAfter.dev !== after.dev
      || entryAfter.ino !== after.ino
      || entryAfter.nlink !== 1
    ) return fail("private staged artifact changed during validation");
    return hash.digest("hex");
  } catch {
    return fail("private staged artifact changed during validation");
  } finally {
    await handle.close();
  }
}

async function validateCompleteBundle(
  root: string,
  identity: PrivateDirectoryIdentity,
  artifacts: readonly WhatsAppMessageBundleV2Artifact[],
  manifest: StagedManifest,
): Promise<void> {
  await assertPrivateDirectory(root, identity);
  const expectedNames = [
    ...artifacts.map((artifact) => artifact.path),
    "manifest.json",
  ].sort();
  const observedNames = (await readdir(root)).sort();
  if (
    observedNames.length !== expectedNames.length
    || observedNames.some((name, index) => name !== expectedNames[index])
  ) return fail("private staging directory does not contain the exact seven-file bundle");
  for (const artifact of artifacts) {
    const path = resolve(root, artifact.path);
    await assertPrivateFile(path, artifact.bytes);
    if (await privateFileSha256(path, artifact.bytes) !== artifact.sha256) {
      return fail(`${artifact.path} changed before publication`);
    }
  }
  const manifestPath = resolve(root, "manifest.json");
  await assertPrivateFile(manifestPath, manifest.bytes);
  if (await privateFileSha256(manifestPath, manifest.bytes) !== manifest.sha256) {
    return fail("manifest.json changed before publication");
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten < 1) return fail("private output stopped accepting bytes");
    offset += result.bytesWritten;
  }
}

async function createWriter(
  staging: PrivateDirectory,
  specification: typeof WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS[number],
): Promise<ArtifactWriter> {
  await assertPrivateDirectory(staging.path, staging.identity);
  const path = resolve(staging.path, specification.path);
  if (!path.startsWith(`${staging.path}${sep}`)) return fail("artifact path escaped private staging");
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    const metadata = await handle.stat();
    const uid = process.getuid?.();
    if (
      !metadata.isFile()
      || uid === undefined
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) return fail(`could not create private staged ${specification.path}`);
    return { specification, handle, hash: createHash("sha256"), records: 0, bytes: 0 };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function convertArtifact(
  inputRoot: string,
  staging: PrivateDirectory,
  specification: typeof WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS[number],
  signal: AbortSignal | undefined,
  onRecord: (records: number) => void,
): Promise<WhatsAppMessageBundleV2Artifact> {
  const writer = await createWriter(staging, specification);
  const inputHandle = await open(
    resolve(inputRoot, specification.path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let failure: unknown;
  try {
    const lines = createInterface({
      input: inputHandle.createReadStream({ autoClose: false }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      throwIfAborted(signal);
      if (line.length === 0) return fail(`${specification.path} contains an empty line`);
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        return fail(`${specification.path} contains malformed JSON`);
      }
      const v1 = raw as Readonly<Record<string, unknown>>;
      const v2 = parseWhatsAppMessageBundleV2Record({
        ...v1,
        schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      }, writer.records);
      if (v2.kind !== specification.kind) {
        return fail(`${specification.path} contains the wrong record kind`);
      }
      const bytes = Buffer.from(`${canonicalJson(v2)}\n`, "utf8");
      if (bytes.byteLength > WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.recordBytes) {
        return fail("one v2 record exceeded its byte bound");
      }
      await writeAll(writer.handle, bytes);
      writer.hash.update(bytes);
      writer.records += 1;
      writer.bytes += bytes.byteLength;
      onRecord(writer.records);
    }
    await writer.handle.sync();
    const metadata = await writer.handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
      || metadata.size !== writer.bytes
    ) return fail(`${specification.path} changed during conversion`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await inputHandle.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await writer.handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  await assertPrivateDirectory(staging.path, staging.identity);
  await assertPrivateFile(resolve(staging.path, specification.path), writer.bytes);
  return Object.freeze({
    path: specification.path,
    mediaType: "application/x-ndjson",
    recordKind: specification.kind,
    records: writer.records,
    bytes: writer.bytes,
    sha256: writer.hash.digest("hex"),
  });
}

function nativeExclusiveRename(): NativeExclusiveRename {
  if (cachedRename !== undefined) return cachedRename;
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: ["cstring", "cstring", "u32"], returns: "int" },
    } as const);
    cachedRename = (source, destination) => library.symbols.renamex_np(
      ptr(source), ptr(destination), DARWIN_RENAME_EXCL,
    );
    return cachedRename;
  }
  if (process.platform === "linux") {
    const library = dlopen("libc.so.6", {
      renameat2: { args: ["int", "cstring", "int", "cstring", "u32"], returns: "int" },
    } as const);
    cachedRename = (source, destination) => library.symbols.renameat2(
      AT_FDCWD, ptr(source), AT_FDCWD, ptr(destination), LINUX_RENAME_NOREPLACE,
    );
    return cachedRename;
  }
  return fail("atomic no-clobber publication is unsupported on this platform");
}

async function publishExclusive(source: string, destination: string): Promise<void> {
  const encode = (value: string): Buffer => {
    if (value.includes("\0")) return fail("publication path is invalid");
    return Buffer.from(`${value}\0`, "utf8");
  };
  if (nativeExclusiveRename()(encode(source), encode(destination)) === 0) return;
  if (!(await absent(destination))) return fail("output directory appeared before publication");
  return fail("atomic no-clobber publication failed");
}

async function syncDirectory(
  path: string,
  expected: PrivateDirectoryIdentity,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return fail("directory changed before synchronization");
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory()
      || metadata.dev !== expected.device
      || metadata.ino !== expected.inode
    ) return fail("directory changed before synchronization");
    await handle.sync();
  } catch {
    return fail("directory changed before synchronization");
  } finally {
    await handle.close();
  }
}

async function createDirectoryLease(
  request: Readonly<{
    directory: PrivateDirectory;
    parentIdentity: PrivateDirectoryIdentity;
    outputRoot?: string;
    recoveryEnvironment?: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<BeeperMessageLikeMeDirectoryLease | undefined> {
  if (request.recoveryEnvironment === undefined) return undefined;
  await assertPrivateDirectory(request.directory.path, request.directory.identity);
  const createdAtMs = Date.now();
  const lease = await createBeeperMessageLikeMeDirectoryLease({
    role: request.outputRoot === undefined ? "raw-working" : "bundle-stage",
    path: request.directory.path,
    ...(request.outputRoot === undefined ? {} : { outputRoot: request.outputRoot }),
    recoverAfterMs: createdAtMs,
    nowMs: createdAtMs,
    environment: request.recoveryEnvironment,
  });
  const bound = lease.claim.directoryIdentity.device === String(request.directory.identity.device)
    && lease.claim.directoryIdentity.inode === String(request.directory.identity.inode)
    && lease.claim.parentIdentity.device === String(request.parentIdentity.device)
    && lease.claim.parentIdentity.inode === String(request.parentIdentity.inode);
  if (!bound) {
    try {
      releaseBeeperMessageLikeMeDirectoryLease(lease);
    } catch (error) {
      throw new AggregateError(
        [new Error("WhatsApp Message Like Me export: directory lease identity mismatch"), error],
        "WhatsApp Message Like Me export: directory lease binding and release both failed",
      );
    }
    return fail("directory lease identity mismatch");
  }
  await assertPrivateDirectory(request.directory.path, request.directory.identity);
  return lease;
}

function translatedSource(source: WhatsAppMessageLikeMeExportSource) {
  parseWhatsAppMessageBundleV2Descriptor(source.descriptor);
  let index = 0;
  return Object.freeze({
    descriptor: Object.freeze({
      source: Object.freeze({ id: "beeper-local", version: "1.1.0" }),
      provider: Object.freeze({ id: "beeper", version: "0.15.0" }),
    }),
    records: (async function* () {
      for await (const raw of source.records) {
        const parsed = parseWhatsAppMessageBundleV2Record(raw, index);
        index += 1;
        yield toLocalMessageBundleV1Record(parsed);
      }
    })(),
    completion: async () => parseWhatsAppMessageBundleV2Completion(await source.completion()),
  });
}

export async function exportWhatsAppMessageLikeMeBundle(
  request: WhatsAppMessageLikeMeExportRequest,
): Promise<WhatsAppMessageLikeMeExportResult> {
  const output = await validateOutputRoot(request.outputRoot);
  throwIfAborted(request.signal);
  const working = await createPrivateDirectory(output, ".wrench-whatsapp-mlm-work-");
  const v1Root = resolve(working.path, "validated-v1");
  let staging: PrivateDirectory | undefined;
  let workingLease: BeeperMessageLikeMeDirectoryLease | undefined;
  let stagingLease: BeeperMessageLikeMeDirectoryLease | undefined;
  let renamed = false;
  let published = false;
  let operationError: unknown;
  try {
    workingLease = await createDirectoryLease({
      directory: working,
      parentIdentity: output.parentIdentity,
      ...(request.recoveryEnvironment === undefined
        ? {}
        : { recoveryEnvironment: request.recoveryEnvironment }),
    });
    await assertParentUnchanged(output);
    const v1 = await exportBeeperMessageLikeMeBundle({
      outputRoot: v1Root,
      source: translatedSource(request.source),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.clock === undefined ? {} : { clock: request.clock }),
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      ...(request.recoveryEnvironment === undefined
        ? {}
        : { recoveryEnvironment: request.recoveryEnvironment }),
    });
    throwIfAborted(request.signal);
    await assertPrivateDirectory(working.path, working.identity);
    await assertParentUnchanged(output);
    staging = await createPrivateDirectory(output, ".wrench-whatsapp-mlm-stage-");
    stagingLease = await createDirectoryLease({
      directory: staging,
      parentIdentity: output.parentIdentity,
      outputRoot: output.outputRoot,
      ...(request.recoveryEnvironment === undefined
        ? {}
        : { recoveryEnvironment: request.recoveryEnvironment }),
    });
    const artifacts: WhatsAppMessageBundleV2Artifact[] = [];
    let totalRecords = 0;
    for (const [index, specification] of WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS.entries()) {
      artifacts.push(await convertArtifact(
        v1Root,
        staging,
        specification,
        request.signal,
        () => {
          totalRecords += 1;
          if (totalRecords === 1 || totalRecords % 5_000 === 0) {
            request.onProgress?.(Object.freeze({
              phase: "v2-conversion",
              artifact: index + 1,
              artifacts: WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS.length,
              records: totalRecords,
            }));
          }
        },
      ));
    }
    const counts = Object.freeze(Object.fromEntries(
      artifacts.map((artifact) => [artifact.recordKind, artifact.records]),
    )) as WhatsAppMessageBundleV2Manifest["counts"];
    const manifestProjection = Object.freeze({
      schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      format: WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT,
      source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
      provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
      timestamps: v1.manifest.timestamps,
      completeness: v1.manifest.completeness,
      warnings: v1.manifest.warnings,
      privacy: Object.freeze({
        classification: "private-local" as const,
        attachments: "metadata-only" as const,
        providerUrls: "excluded" as const,
        credentials: "excluded" as const,
      }),
      counts,
      artifacts: Object.freeze(artifacts),
    });
    const manifest = parseWhatsAppMessageBundleV2Manifest(Object.freeze({
      ...manifestProjection,
      integrity: Object.freeze({
        algorithm: "sha256",
        bundleSha256: whatsAppMessageBundleV2BundleSha256(manifestProjection),
      }),
    }));
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
    if (manifestBytes.byteLength > WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.manifestBytes) {
      return fail("manifest exceeded its byte bound");
    }
    await assertPrivateDirectory(staging.path, staging.identity);
    const manifestPath = resolve(staging.path, "manifest.json");
    const manifestHandle = await open(
      manifestPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await manifestHandle.chmod(PRIVATE_FILE_MODE);
      await writeAll(manifestHandle, manifestBytes);
      await manifestHandle.sync();
      const metadata = await manifestHandle.stat();
      const uid = process.getuid?.();
      if (
        !metadata.isFile()
        || uid === undefined
        || metadata.uid !== uid
        || metadata.nlink !== 1
        || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
        || metadata.size !== manifestBytes.byteLength
      ) return fail("manifest changed during creation");
    } finally {
      await manifestHandle.close();
    }
    const stagedManifest = Object.freeze({
      bytes: manifestBytes.byteLength,
      sha256: sha256(manifestBytes.toString("utf8")),
    });
    await assertPrivateFile(manifestPath, stagedManifest.bytes);
    await validateCompleteBundle(staging.path, staging.identity, artifacts, stagedManifest);
    await syncDirectory(staging.path, staging.identity);
    throwIfAborted(request.signal);
    await assertParentUnchanged(output);
    await publishExclusive(staging.path, output.outputRoot);
    renamed = true;
    request.onProgress?.(Object.freeze({
      phase: "bundle-publishing",
      elapsedSeconds: 0,
      records: totalRecords,
      bytes: artifacts.reduce((total, artifact) => total + artifact.bytes, 0) + manifestBytes.byteLength,
    }));
    await validateCompleteBundle(output.outputRoot, staging.identity, artifacts, stagedManifest);
    throwIfAborted(request.signal);
    await assertParentUnchanged(output);
    await syncDirectory(output.parent, output.parentIdentity);
    published = true;
    return Object.freeze({
      outputRoot: output.outputRoot,
      manifestPath: resolve(output.outputRoot, "manifest.json"),
      manifestSha256: stagedManifest.sha256,
      manifest,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (!published && staging !== undefined) {
      let removalDurable = true;
      try {
        await removeOwnedPrivateDirectory(
          renamed ? output.outputRoot : staging.path,
          staging.identity,
        );
      } catch (error) {
        removalDurable = false;
        cleanupErrors.push(error);
      }
      try {
        await syncDirectory(output.parent, output.parentIdentity);
      } catch (error) {
        removalDurable = false;
        cleanupErrors.push(error);
      }
      if (removalDurable && stagingLease !== undefined) {
        try {
          releaseBeeperMessageLikeMeDirectoryLease(stagingLease);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } else if (published && operationError === undefined && stagingLease !== undefined) {
      try {
        releaseBeeperMessageLikeMeDirectoryLease(stagingLease);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    let workingRemovalDurable = true;
    try {
      await removeOwnedPrivateDirectory(working.path, working.identity);
    } catch (error) {
      workingRemovalDurable = false;
      cleanupErrors.push(error);
    }
    try {
      await syncDirectory(output.parent, output.parentIdentity);
    } catch (error) {
      workingRemovalDurable = false;
      cleanupErrors.push(error);
    }
    if (workingRemovalDurable && workingLease !== undefined) {
      try {
        releaseBeeperMessageLikeMeDirectoryLease(workingLease);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        "WhatsApp Message Like Me export cleanup could not be verified",
      );
    }
  }
}
