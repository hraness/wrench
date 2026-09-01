import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { dlopen, ptr } from "bun:ffi";

import {
  exportBeeperMessageLikeMeBundle,
  type BeeperMessageLikeMeBundleProgress,
} from "./beeper-message-like-me-export";
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

async function validateOutputRoot(value: unknown): Promise<Readonly<{
  outputRoot: string;
  parent: string;
}>> {
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
  if (!(await absent(value))) return fail("output directory already exists");
  return Object.freeze({ outputRoot: value, parent });
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
  staging: string,
  specification: typeof WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS[number],
): Promise<ArtifactWriter> {
  const handle = await open(
    resolve(staging, specification.path),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  await handle.chmod(PRIVATE_FILE_MODE);
  return { specification, handle, hash: createHash("sha256"), records: 0, bytes: 0 };
}

async function convertArtifact(
  inputRoot: string,
  staging: string,
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

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removePrivate(path: string): Promise<void> {
  if (!(await absent(path))) removePrivateDirectoryTree(path);
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
  const working = await mkdtemp(join(output.parent, ".wrench-whatsapp-mlm-work-"));
  await chmod(working, PRIVATE_DIRECTORY_MODE);
  const v1Root = resolve(working, "validated-v1");
  let staging: string | undefined;
  let published = false;
  let operationError: unknown;
  try {
    const v1 = await exportBeeperMessageLikeMeBundle({
      outputRoot: v1Root,
      source: translatedSource(request.source),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.clock === undefined ? {} : { clock: request.clock }),
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    });
    throwIfAborted(request.signal);
    staging = await mkdtemp(join(output.parent, ".wrench-whatsapp-mlm-stage-"));
    await chmod(staging, PRIVATE_DIRECTORY_MODE);
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
        bundleSha256: sha256(canonicalJson(manifestProjection)),
      }),
    }));
    const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
    if (manifestBytes.byteLength > WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.manifestBytes) {
      return fail("manifest exceeded its byte bound");
    }
    const manifestHandle = await open(
      resolve(staging, "manifest.json"),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await manifestHandle.chmod(PRIVATE_FILE_MODE);
      await writeAll(manifestHandle, manifestBytes);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    const expected = [...WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS.map((item) => item.path), "manifest.json"].sort();
    const observed = (await readdir(staging)).sort();
    if (observed.length !== expected.length || observed.some((name, index) => name !== expected[index])) {
      return fail("staging directory does not contain the exact seven-file bundle");
    }
    await syncDirectory(staging);
    throwIfAborted(request.signal);
    await publishExclusive(staging, output.outputRoot);
    published = true;
    staging = undefined;
    await syncDirectory(output.parent);
    return Object.freeze({
      outputRoot: output.outputRoot,
      manifestPath: resolve(output.outputRoot, "manifest.json"),
      manifestSha256: sha256(manifestBytes.toString("utf8")),
      manifest,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (!published && staging !== undefined) {
      try {
        await removePrivate(staging);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await removePrivate(working);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        "WhatsApp Message Like Me export cleanup could not be verified",
      );
    }
  }
}
