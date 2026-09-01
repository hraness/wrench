import { constants, type Stats } from "node:fs";
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
import { createHash } from "node:crypto";
import { dlopen, ptr } from "bun:ffi";

import {
  exportBeeperMessageLikeMeBundle,
  type BeeperMessageLikeMeArtifact,
  type BeeperMessageLikeMeBundleProgress,
  type BeeperMessageLikeMeExportResult,
} from "./beeper-message-like-me-export";
import {
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeDirectoryLease,
  type BeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";
import { parseBeeperMessageLikeMeRecord } from "./beeper-message-bundle-v1";
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

type PrivateFileIdentity = Readonly<{
  device: number;
  inode: number;
  uid: number;
  mode: number;
  nlink: number;
  bytes: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

type BoundV1Artifact = {
  readonly path: string;
  readonly manifest: BeeperMessageLikeMeArtifact;
  readonly identity: PrivateFileIdentity;
  readonly handle: FileHandle;
  closed: boolean;
};

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

function samePrivateFileMetadata(
  metadata: Stats,
  identity: PrivateFileIdentity,
): boolean {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.dev === identity.device
    && metadata.ino === identity.inode
    && metadata.uid === identity.uid
    && (metadata.mode & 0o777) === identity.mode
    && metadata.nlink === identity.nlink
    && metadata.size === identity.bytes
    && metadata.mtimeMs === identity.mtimeMs
    && metadata.ctimeMs === identity.ctimeMs;
}

async function assertBoundV1Artifact(
  root: PrivateDirectory,
  input: BoundV1Artifact,
): Promise<void> {
  await assertPrivateDirectory(root.path, root.identity);
  let opened: Stats;
  let entry: Stats;
  try {
    opened = await input.handle.stat();
    entry = await lstat(input.path);
  } catch {
    return fail(`${input.manifest.path} changed after v1 validation`);
  }
  if (
    input.closed
    || !samePrivateFileMetadata(opened, input.identity)
    || !samePrivateFileMetadata(entry, input.identity)
  ) return fail(`${input.manifest.path} changed after v1 validation`);
}

async function openBoundV1Artifact(
  root: PrivateDirectory,
  artifact: BeeperMessageLikeMeArtifact,
): Promise<BoundV1Artifact> {
  await assertPrivateDirectory(root.path, root.identity);
  const path = resolve(root.path, artifact.path);
  if (!path.startsWith(`${root.path}${sep}`)) {
    return fail("validated v1 artifact path escaped its private bundle");
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail(`${artifact.path} changed before v1 conversion`);
  }
  try {
    const uid = process.getuid?.();
    const before = await handle.stat();
    const entry = await lstat(path);
    const after = await handle.stat();
    if (
      uid === undefined
      || !before.isFile()
      || before.isSymbolicLink()
      || before.uid !== uid
      || before.nlink !== 1
      || (before.mode & 0o777) !== PRIVATE_FILE_MODE
      || before.size !== artifact.bytes
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.uid !== after.uid
      || before.nlink !== after.nlink
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || (before.mode & 0o777) !== (after.mode & 0o777)
      || !entry.isFile()
      || entry.isSymbolicLink()
      || entry.dev !== after.dev
      || entry.ino !== after.ino
      || entry.uid !== after.uid
      || entry.nlink !== after.nlink
      || entry.size !== after.size
      || entry.mtimeMs !== after.mtimeMs
      || entry.ctimeMs !== after.ctimeMs
      || (entry.mode & 0o777) !== PRIVATE_FILE_MODE
    ) return fail(`${artifact.path} changed before v1 conversion`);
    const input: BoundV1Artifact = {
      path,
      manifest: artifact,
      identity: Object.freeze({
        device: after.dev,
        inode: after.ino,
        uid: after.uid,
        mode: after.mode & 0o777,
        nlink: after.nlink,
        bytes: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
      }),
      handle,
      closed: false,
    };
    await assertBoundV1Artifact(root, input);
    return input;
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "WhatsApp Message Like Me export: v1 artifact validation and close both failed",
      );
    }
    throw error;
  }
}

async function closeBoundV1Artifacts(inputs: readonly BoundV1Artifact[]): Promise<void> {
  const errors: unknown[] = [];
  for (const input of inputs) {
    if (input.closed) continue;
    input.closed = true;
    try {
      await input.handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "WhatsApp Message Like Me export: validated v1 artifact handles could not be closed",
    );
  }
}

async function openBoundV1Artifacts(
  root: PrivateDirectory,
  result: BeeperMessageLikeMeExportResult,
): Promise<BoundV1Artifact[]> {
  if (
    result.outputRoot !== root.path
    || result.manifestPath !== resolve(root.path, "manifest.json")
    || result.manifest.artifacts.length !== WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS.length
  ) return fail("validated v1 bundle result does not identify the expected private bundle");
  await assertPrivateDirectory(root.path, root.identity);
  const expectedNames = [
    ...result.manifest.artifacts.map((artifact) => artifact.path),
    "manifest.json",
  ].sort();
  const observedNames = (await readdir(root.path)).sort();
  if (
    observedNames.length !== expectedNames.length
    || observedNames.some((name, index) => name !== expectedNames[index])
  ) return fail("validated v1 bundle no longer contains its exact seven-file inventory");

  const manifestText = `${canonicalJson(result.manifest)}\n`;
  const expectedManifestSha256 = sha256(manifestText);
  if (
    result.manifestSha256 !== expectedManifestSha256
    || await privateFileSha256(result.manifestPath, Buffer.byteLength(manifestText, "utf8"))
      !== expectedManifestSha256
  ) return fail("validated v1 manifest changed before conversion");

  const inputs: BoundV1Artifact[] = [];
  try {
    for (const [index, specification] of WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS.entries()) {
      const artifact = result.manifest.artifacts[index];
      if (
        artifact === undefined
        || artifact.path !== specification.path
        || artifact.mediaType !== "application/x-ndjson"
        || artifact.recordKind !== specification.kind
        || artifact.records !== result.manifest.counts[specification.kind]
      ) return fail("validated v1 manifest changed its fixed artifact binding");
      inputs.push(await openBoundV1Artifact(root, artifact));
    }
    await assertPrivateDirectory(root.path, root.identity);
    return inputs;
  } catch (error) {
    try {
      await closeBoundV1Artifacts(inputs);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "WhatsApp Message Like Me export: v1 bundle binding and close both failed",
      );
    }
    throw error;
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
  inputRoot: PrivateDirectory,
  input: BoundV1Artifact,
  staging: PrivateDirectory,
  specification: typeof WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS[number],
  signal: AbortSignal | undefined,
  onRecord: (records: number) => void,
): Promise<WhatsAppMessageBundleV2Artifact> {
  if (
    input.manifest.path !== specification.path
    || input.manifest.mediaType !== "application/x-ndjson"
    || input.manifest.recordKind !== specification.kind
  ) return fail("validated v1 artifact does not match its v2 conversion slot");
  await assertBoundV1Artifact(inputRoot, input);
  const writer = await createWriter(staging, specification);
  let failure: unknown;
  try {
    const inputHash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    let pending = Buffer.alloc(0);
    let inputBytes = 0;
    while (inputBytes < input.manifest.bytes) {
      throwIfAborted(signal);
      const length = Math.min(readBuffer.byteLength, input.manifest.bytes - inputBytes);
      const { bytesRead } = await input.handle.read(
        readBuffer,
        0,
        length,
        inputBytes,
      );
      if (bytesRead === 0) {
        return fail(`${specification.path} ended before its manifested byte count`);
      }
      const chunk = readBuffer.subarray(0, bytesRead);
      inputHash.update(chunk);
      inputBytes += bytesRead;
      const buffered = pending.byteLength === 0
        ? chunk
        : Buffer.concat([pending, chunk], pending.byteLength + chunk.byteLength);
      let lineStart = 0;
      for (;;) {
        const lineEnd = buffered.indexOf(0x0a, lineStart);
        if (lineEnd < 0) break;
        const lineBytes = buffered.subarray(lineStart, lineEnd);
        if (lineBytes.byteLength === 0) {
          return fail(`${specification.path} contains an empty line`);
        }
        let raw: unknown;
        try {
          raw = JSON.parse(decoder.decode(lineBytes)) as unknown;
        } catch {
          return fail(`${specification.path} contains malformed UTF-8 JSON`);
        }
        const v1 = parseBeeperMessageLikeMeRecord(raw, writer.records);
        if (v1.kind !== specification.kind) {
          return fail(`${specification.path} contains the wrong v1 record kind`);
        }
        const v2 = parseWhatsAppMessageBundleV2Record({
          ...v1,
          schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
        }, writer.records);
        if (v2.kind !== specification.kind) {
          return fail(`${specification.path} contains the wrong v2 record kind`);
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
        lineStart = lineEnd + 1;
      }
      pending = Buffer.from(buffered.subarray(lineStart));
      if (pending.byteLength > WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.recordBytes) {
        return fail(`${specification.path} contains an overlong record`);
      }
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await input.handle.read(extra, 0, 1, inputBytes)).bytesRead !== 0) {
      return fail(`${specification.path} exceeded its manifested byte count`);
    }
    if (pending.byteLength !== 0) {
      return fail(`${specification.path} does not end at an NDJSON record boundary`);
    }
    if (writer.records !== input.manifest.records) {
      return fail(`${specification.path} record count changed after v1 validation`);
    }
    if (inputHash.digest("hex") !== input.manifest.sha256) {
      return fail(`${specification.path} digest changed after v1 validation`);
    }
    await assertBoundV1Artifact(inputRoot, input);
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
  let v1Inputs: BoundV1Artifact[] = [];
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
    const v1Directory = Object.freeze({
      path: v1Root,
      identity: await assertPrivateDirectory(v1Root),
    });
    if (
      dirname(v1Directory.path) !== working.path
      || v1Directory.identity.device !== working.identity.device
    ) return fail("validated v1 bundle escaped its owned private working directory");
    v1Inputs = await openBoundV1Artifacts(v1Directory, v1);
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
      const input = v1Inputs[index];
      if (input === undefined) return fail("validated v1 artifact binding is incomplete");
      artifacts.push(await convertArtifact(
        v1Directory,
        input,
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
    await closeBoundV1Artifacts(v1Inputs);
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
    try {
      await closeBoundV1Artifacts(v1Inputs);
    } catch (error) {
      cleanupErrors.push(error);
    }
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
