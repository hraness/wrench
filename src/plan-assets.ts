import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { createHash } from "node:crypto";
import { extname, isAbsolute, join, resolve } from "node:path";

import type {
  FileInputField,
  FileInputValue,
  InputSchema,
  OperationInput,
} from "./model";
import {
  ensurePrivateDirectory,
  removePrivateStateDirectoryTree,
  wrenchStateHome,
  type PrivateDirectoryIdentity,
} from "./storage";

export const MAX_PLAN_ASSET_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_PLAN_ASSET_AGGREGATE_BYTES = 2 * 1024 * 1024 * 1024;
export const PLAN_ASSET_GC_GRACE_MS = 15 * 60_000;
const FILE_REFERENCE_PREFIX = "sf1";
const MAX_ASSET_COUNT = 25;
const MAX_ASSET_ROOT_ENTRIES = 4_096;
const MAX_ASSET_DIRECTORY_ENTRIES = 64;
const MAX_ASSET_GC_REMOVALS = 256;
const ASSET_LOCK_NAME = ".asset-lock";

type BoundAsset = {
  readonly index: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly fileName: string;
};

export type PlanFileSummary = {
  readonly kind: "file";
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
};

export type StagedPlanAssets = {
  readonly input: OperationInput;
  readonly count: number;
  readonly totalBytes: number;
  commit: (planDigest: string) => void;
  abort: () => void;
};

export type PlanAssetGcResult = {
  readonly scanned: number;
  readonly removed: number;
  readonly retained: number;
  readonly incomplete: boolean;
};

type AssetLock = {
  readonly path: string;
  readonly identity: PrivateDirectoryIdentity;
  heartbeat: () => void;
  release: () => void;
};

type BoundedDirectoryEntries = {
  readonly names: readonly string[];
  readonly overflow: boolean;
};

function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("plan asset digest must be 64 lowercase hexadecimal characters");
  }
}

function assetRoot(environment: Readonly<Record<string, string | undefined>>): string {
  return join(wrenchStateHome(environment), "plan-assets");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function directoryIdentity(stats: BigIntStats): PrivateDirectoryIdentity {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function boundedDirectoryEntries(path: string, maximum: number): BoundedDirectoryEntries {
  const directory = opendirSync(path);
  const names: string[] = [];
  let overflow = false;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (names.length >= maximum) {
        overflow = true;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return { names, overflow };
}

function acquireAssetLock(
  environment: Readonly<Record<string, string | undefined>>,
): AssetLock {
  const root = assetRoot(environment);
  ensurePrivateDirectory(root);
  const path = join(root, ASSET_LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | null = null;
    let createdIdentity: PrivateDirectoryIdentity | null = null;
    try {
      mkdirSync(path, { mode: 0o700 });
      descriptor = openSync(
        path,
        constants.O_RDONLY
          | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
          | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
      );
      const stats = fstatSync(descriptor, { bigint: true });
      if (!stats.isDirectory()) throw new Error("plan asset lock is unsafe");
      const identity = directoryIdentity(stats);
      createdIdentity = identity;
      chmodSync(path, 0o700);
      let released = false;
      let descriptorClosed = false;
      let lastHeartbeat = Date.now();
      return {
        path,
        identity,
        heartbeat: (): void => {
          const current = Date.now();
          if (current - lastHeartbeat < 1_000) return;
          const timestamp = new Date(current);
          if (descriptor === null || descriptorClosed) throw new Error("plan asset lock is not active");
          futimesSync(descriptor, timestamp, timestamp);
          lastHeartbeat = current;
        },
        release: (): void => {
          if (released) return;
          if (descriptor !== null && !descriptorClosed) {
            closeSync(descriptor);
            descriptorClosed = true;
          }
          if (!removePrivateStateDirectoryTree(path, environment, identity)) {
            throw new Error("plan asset lock ownership was lost");
          }
          released = true;
        },
      };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (createdIdentity !== null) {
        try {
          removePrivateStateDirectoryTree(path, environment, createdIdentity);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "plan asset lock setup failed and cleanup was incomplete");
        }
      }
      if (!hasCode(error, "EEXIST")) throw error;
      let stats: BigIntStats;
      try {
        stats = lstatSync(path, { bigint: true });
      } catch (inspectionError) {
        if (hasCode(inspectionError, "ENOENT")) continue;
        throw inspectionError;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("plan asset lock is unsafe");
      const age = Date.now() - Number(stats.mtimeMs);
      if (!Number.isFinite(age) || age < PLAN_ASSET_GC_GRACE_MS) {
        throw new Error("plan asset maintenance is busy; retry the command");
      }
      try {
        if (!removePrivateStateDirectoryTree(path, environment, directoryIdentity(stats))) {
          throw new Error("plan asset maintenance is busy; retry the command");
        }
      } catch (removalError) {
        throw new Error("plan asset maintenance is busy; retry the command", { cause: removalError });
      }
    }
  }
  throw new Error("plan asset maintenance is busy; retry the command");
}

function addAssetBytes(total: number, size: bigint): number {
  if (size < 0n || size > BigInt(MAX_PLAN_ASSET_AGGREGATE_BYTES - total)) {
    throw new Error(`plan attachment storage exceeds its ${MAX_PLAN_ASSET_AGGREGATE_BYTES}-byte aggregate quota`);
  }
  return total + Number(size);
}

function assetDirectoryBytes(path: string): number {
  const entries = boundedDirectoryEntries(path, MAX_ASSET_DIRECTORY_ENTRIES);
  if (entries.overflow) throw new Error("plan attachment directory exceeds its bounded entry count");
  let total = 0;
  for (const name of entries.names) {
    let stats: BigIntStats;
    try {
      stats = lstatSync(join(path, name), { bigint: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("plan attachment storage contains an unsupported entry");
    }
    total = addAssetBytes(total, stats.size);
  }
  return total;
}

function currentAssetBytes(root: string): number {
  const entries = boundedDirectoryEntries(root, MAX_ASSET_ROOT_ENTRIES);
  if (entries.overflow) throw new Error("plan attachment storage exceeds its bounded bundle count");
  let total = 0;
  for (const name of entries.names) {
    if (name === ASSET_LOCK_NAME) continue;
    const path = join(root, name);
    let stats: BigIntStats;
    try {
      stats = lstatSync(path, { bigint: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (stats.isFile() && !stats.isSymbolicLink()) total = addAssetBytes(total, stats.size);
    else if (stats.isDirectory() && !stats.isSymbolicLink()) {
      total = addAssetBytes(total, BigInt(assetDirectoryBytes(path)));
    } else throw new Error("plan attachment storage contains an unsupported root entry");
  }
  return total;
}

/**
 * Remove only old, unreferenced staging/bundle directories. The grace window
 * covers the short plan-to-receipt handoff where no durable reference exists.
 */
export function purgeOrphanedPlanAssets(
  protectedDigests: ReadonlySet<string> | (() => ReadonlySet<string>),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): PlanAssetGcResult {
  const root = assetRoot(environment);
  if (!existsSync(root)) return { scanned: 0, removed: 0, retained: 0, incomplete: false };
  const lock = acquireAssetLock(environment);
  let resolvedProtectedDigests: ReadonlySet<string> | null = null;
  const isProtected = (planDigest: string): boolean => {
    resolvedProtectedDigests ??= typeof protectedDigests === "function" ? protectedDigests() : protectedDigests;
    return resolvedProtectedDigests.has(planDigest);
  };
  let scanned = 0;
  let removed = 0;
  let retained = 0;
  let incomplete = false;
  try {
    const entries = boundedDirectoryEntries(root, MAX_ASSET_ROOT_ENTRIES);
    incomplete = entries.overflow;
    for (const name of entries.names) {
      if (name === ASSET_LOCK_NAME) continue;
      const staged = /^\.stage-[A-Za-z0-9_-]{1,64}$/u.test(name);
      const planDigest = /^[a-f0-9]{64}$/u.test(name) ? name : null;
      if (!staged && planDigest === null) continue;
      scanned += 1;
      const path = join(root, name);
      let stats: BigIntStats;
      try {
        stats = lstatSync(path, { bigint: true });
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        throw error;
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        retained += 1;
        incomplete = true;
        continue;
      }
      const age = now.getTime() - Number(stats.mtimeMs);
      if (
        (planDigest !== null && age >= PLAN_ASSET_GC_GRACE_MS && isProtected(planDigest))
        || !Number.isFinite(age)
        || age < PLAN_ASSET_GC_GRACE_MS
        || removed >= MAX_ASSET_GC_REMOVALS
      ) {
        retained += 1;
        if (removed >= MAX_ASSET_GC_REMOVALS && age >= PLAN_ASSET_GC_GRACE_MS) incomplete = true;
        continue;
      }
      if (removePrivateStateDirectoryTree(path, environment, directoryIdentity(stats))) removed += 1;
      else {
        retained += 1;
        incomplete = true;
      }
    }
    return { scanned, removed, retained, incomplete };
  } finally {
    lock.release();
  }
}

export function planAssetBundlePath(
  planDigest: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  digest(planDigest);
  return join(assetRoot(environment), planDigest);
}

function safeExtension(mediaType: string): string {
  const extensions: Readonly<Record<string, string>> = {
    "application/octet-stream": ".bin",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "text/plain": ".txt",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  return extensions[mediaType] ?? ".bin";
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString("ascii");
}

export function detectMediaType(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && (ascii(buffer, 0, 6) === "GIF87a" || ascii(buffer, 0, 6) === "GIF89a")) return "image/gif";
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WAVE") return "audio/wav";
  if (buffer.length >= 5 && ascii(buffer, 0, 5) === "%PDF-") return "application/pdf";
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return "application/zip";
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "video/webm";
  if (buffer.length >= 4 && ascii(buffer, 0, 4) === "OggS") return "audio/ogg";
  if (buffer.length >= 3 && ascii(buffer, 0, 3) === "ID3") return "audio/mpeg";
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] ?? 0) >= 0xe0) return "audio/mpeg";
  if (buffer.length >= 12 && ascii(buffer, 4, 8) === "ftyp") {
    const brand = ascii(buffer, 8, 12);
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    return "video/mp4";
  }
  if (buffer.length > 0 && !buffer.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return "text/plain";
    } catch {
      // Binary data without a recognized signature remains opaque.
    }
  }
  return "application/octet-stream";
}

const OOXML_CENTRAL_DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;
const ZIP_EOCD_MAX_BYTES = 65_557;

function readExactAt(descriptor: number, length: number, position: number): Buffer {
  const output = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, output, offset, length - offset, position + offset);
    if (count === 0) throw new Error("ZIP container ended before its declared central directory");
    offset += count;
  }
  return output;
}

/** Inspect only bounded ZIP central-directory names; no archive entry is extracted. */
export function detectOfficeOpenXmlMediaType(path: string): string | null {
  const descriptor = sourceDescriptor(path);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size < 22) return null;
    const tailLength = Math.min(stats.size, ZIP_EOCD_MAX_BYTES);
    const tail = readExactAt(descriptor, tailLength, stats.size - tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x0605_4b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) return null;
    const entries = tail.readUInt16LE(eocd + 10);
    const centralBytes = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (
      entries < 1
      || entries > 10_000
      || centralBytes < 46
      || centralBytes > OOXML_CENTRAL_DIRECTORY_MAX_BYTES
      || centralOffset + centralBytes > stats.size
    ) return null;
    const central = readExactAt(descriptor, centralBytes, centralOffset);
    const names = new Set<string>();
    let offset = 0;
    for (let index = 0; index < entries; index += 1) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x0201_4b50) return null;
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (nameLength < 1 || nameLength > 4_096 || end > central.length) return null;
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(central.subarray(offset + 46, offset + 46 + nameLength));
      } catch {
        return null;
      }
      if (name.includes("\u0000") || name.startsWith("/") || name.includes("../")) return null;
      names.add(name);
      offset = end;
    }
    if (!names.has("[Content_Types].xml") || !names.has("_rels/.rels")) return null;
    const roots = [
      { prefix: "word/", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { prefix: "ppt/", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
      { prefix: "xl/", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    ] as const;
    const matched = roots.filter((root) => [...names].some((name) => name.startsWith(root.prefix)));
    return matched.length === 1 ? matched[0]?.mediaType ?? null : null;
  } finally {
    closeSync(descriptor);
  }
}

function mediaTypeAllowed(detected: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined) return true;
  return allowed.some((candidate) => candidate === detected || (candidate.endsWith("/*") && detected.startsWith(candidate.slice(0, -1))));
}

function encodedMediaType(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeMediaType(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("plan-bound file reference is malformed");
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/u.test(decoded)) {
    throw new Error("plan-bound file media type is malformed");
  }
  return decoded;
}

function encodeReference(asset: BoundAsset): string {
  return [
    FILE_REFERENCE_PREFIX,
    String(asset.index),
    asset.sha256,
    String(asset.bytes),
    encodedMediaType(asset.mediaType),
    asset.fileName,
  ].join(":");
}

function decodeReference(reference: string): BoundAsset {
  const parts = reference.split(":");
  if (parts.length !== 6 || parts[0] !== FILE_REFERENCE_PREFIX) {
    throw new Error("plan-bound file reference is malformed");
  }
  const [, rawIndex, sha256, rawBytes, rawMediaType, fileName] = parts;
  const index = Number(rawIndex);
  const bytes = Number(rawBytes);
  if (
    !Number.isSafeInteger(index)
    || index < 1
    || index > MAX_ASSET_COUNT
    || typeof sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(sha256)
    || !Number.isSafeInteger(bytes)
    || bytes < 1
    || bytes > MAX_PLAN_ASSET_TOTAL_BYTES
    || typeof fileName !== "string"
    || !/^asset-(?:0[1-9]|1[0-9]|2[0-5])\.[a-z0-9]{1,8}$/u.test(fileName)
    || fileName !== `asset-${String(index).padStart(2, "0")}${extname(fileName)}`
    || rawMediaType === undefined
  ) throw new Error("plan-bound file reference is malformed");
  return { index, sha256, bytes, mediaType: decodeMediaType(rawMediaType), fileName };
}

function sourceDescriptor(path: string): number {
  const flags = constants.O_RDONLY
    | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
    | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0);
  try {
    return openSync(path, flags);
  } catch (error) {
    throw new Error("could not safely open attachment", { cause: error });
  }
}

function copyOne(
  sourceReference: string,
  field: FileInputField,
  directory: string,
  index: number,
  remainingBytes: number,
  heartbeat: () => void,
): { readonly value: FileInputValue; readonly bytes: number } {
  if (sourceReference.startsWith(`${FILE_REFERENCE_PREFIX}:`)) {
    throw new Error("raw attachment input cannot impersonate a plan-bound file reference");
  }
  const source = isAbsolute(sourceReference) ? sourceReference : resolve(sourceReference);
  const input = sourceDescriptor(source);
  let output: number | null = null;
  try {
    const stats = fstatSync(input);
    const maximum = Math.min(field.maxBytes, remainingBytes);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maximum) {
      throw new Error(`attachment must be a non-empty regular file no larger than ${maximum} bytes`);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    const textDecoder = new TextDecoder("utf-8", { fatal: true });
    let validText = true;
    let total = 0;
    const hash = createHash("sha256");
    const temporaryName = `asset-${String(index).padStart(2, "0")}.tmp`;
    const temporaryPath = join(directory, temporaryName);
    output = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
      0o600,
    );
    fchmodSync(output, 0o600);
    heartbeat();
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > maximum) throw new Error(`attachment grew beyond ${maximum} bytes while being staged`);
      const value = buffer.subarray(0, count);
      if (retainedBytes < 4_096) {
        const retained = Math.min(value.byteLength, 4_096 - retainedBytes);
        if (retained > 0) {
          chunks.push(Buffer.from(value.subarray(0, retained)));
          retainedBytes += retained;
        }
      }
      hash.update(value);
      if (validText) {
        if (value.includes(0)) validText = false;
        else {
          try {
            textDecoder.decode(value, { stream: true });
          } catch {
            validText = false;
          }
        }
      }
      let written = 0;
      while (written < value.byteLength) written += writeSync(output, value, written, value.byteLength - written);
      heartbeat();
    }
    if (total !== stats.size) throw new Error("attachment changed size while being staged");
    fsyncSync(output);
    closeSync(output);
    output = null;
    const prefix = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, retainedBytes);
    if (validText) {
      try {
        textDecoder.decode();
      } catch {
        validText = false;
      }
    }
    const detectedContainer = detectMediaType(prefix);
    const detected = detectedContainer === "application/zip"
      ? detectOfficeOpenXmlMediaType(temporaryPath) ?? detectedContainer
      : detectedContainer;
    const mediaType = detected === "text/plain" || detected === "application/octet-stream"
      ? validText ? "text/plain" : "application/octet-stream"
      : detected;
    if (!mediaTypeAllowed(mediaType, field.mediaTypes)) {
      throw new Error(`attachment content type ${mediaType} is not allowed by the adapter`);
    }
    const fileName = `asset-${String(index).padStart(2, "0")}${safeExtension(mediaType)}`;
    renameSync(temporaryPath, join(directory, fileName));
    const asset: BoundAsset = {
      index,
      sha256: hash.digest("hex"),
      bytes: total,
      mediaType,
      fileName,
    };
    return { value: { kind: "file", reference: encodeReference(asset) }, bytes: total };
  } finally {
    if (output !== null) closeSync(output);
    closeSync(input);
  }
}

function fileReference(value: unknown, label: string): string {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (value as { readonly kind?: unknown }).kind !== "file"
    || typeof (value as { readonly reference?: unknown }).reference !== "string"
  ) throw new Error(`${label} is not a validated file input`);
  return (value as FileInputValue).reference;
}

export function stagePlanAssets(
  input: OperationInput,
  schema: InputSchema,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StagedPlanAssets {
  const hasFileFields = Object.values(schema.properties).some((field) =>
    field.type === "file" || (field.type === "array" && field.items.type === "file"));
  if (!hasFileFields) {
    return { input, count: 0, totalBytes: 0, commit: () => {}, abort: () => {} };
  }
  const root = assetRoot(environment);
  const lock = acquireAssetLock(environment);
  let existingBytes: number;
  let temporary: string | null = null;
  try {
    existingBytes = currentAssetBytes(root);
    temporary = mkdtempSync(join(root, ".stage-"));
    chmodSync(temporary, 0o700);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (temporary !== null && existsSync(temporary)) {
      try {
        removePrivateStateDirectoryTree(temporary, environment);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      lock.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "plan attachment staging failed and cleanup was incomplete");
    }
    throw error;
  }
  if (temporary === null) throw new Error("plan attachment staging directory was not initialized");
  let currentPath = temporary;
  let committed = false;
  let count = 0;
  let totalBytes = 0;
  const output: Record<string, OperationInput[string]> = { ...input };
  const remainingCapacity = (): number => {
    const aggregate = MAX_PLAN_ASSET_AGGREGATE_BYTES - existingBytes - totalBytes;
    if (aggregate < 1) {
      throw new Error(`plan attachment storage exceeds its ${MAX_PLAN_ASSET_AGGREGATE_BYTES}-byte aggregate quota`);
    }
    return Math.min(MAX_PLAN_ASSET_TOTAL_BYTES - totalBytes, aggregate);
  };
  const abort = (): void => {
    try {
      if (existsSync(currentPath)) removePrivateStateDirectoryTree(currentPath, environment);
    } finally {
      lock.release();
    }
  };
  try {
    for (const [name, field] of Object.entries(schema.properties)) {
      if (field.type !== "file" && (field.type !== "array" || field.items.type !== "file")) continue;
      const value = input[name];
      if (value === undefined) continue;
      if (field.type === "file") {
        count += 1;
        if (count > MAX_ASSET_COUNT) throw new Error(`a plan can bind at most ${MAX_ASSET_COUNT} attachments`);
        const copied = copyOne(
          fileReference(value, `input.${name}`),
          field,
          temporary,
          count,
          remainingCapacity(),
          lock.heartbeat,
        );
        totalBytes += copied.bytes;
        output[name] = copied.value;
        continue;
      }
      if (field.items.type !== "file" || !Array.isArray(value)) throw new Error(`input.${name} is not a validated file array`);
      const copiedValues: FileInputValue[] = [];
      for (const [index, item] of value.entries()) {
        count += 1;
        if (count > MAX_ASSET_COUNT) throw new Error(`a plan can bind at most ${MAX_ASSET_COUNT} attachments`);
        const copied = copyOne(
          fileReference(item, `input.${name}[${index}]`),
          field.items,
          temporary,
          count,
          remainingCapacity(),
          lock.heartbeat,
        );
        totalBytes += copied.bytes;
        copiedValues.push(copied.value);
      }
      output[name] = copiedValues;
    }
    if (count === 0) abort();
  } catch (error) {
    abort();
    throw error;
  }
  return {
    input: output,
    count,
    totalBytes,
    commit: (planDigest): void => {
      if (count === 0) return;
      if (committed) throw new Error("plan asset bundle was already committed");
      const target = planAssetBundlePath(planDigest, environment);
      if (existsSync(target)) throw new Error("plan asset bundle already exists");
      renameSync(temporary, target);
      currentPath = target;
      committed = true;
      lock.release();
    },
    abort,
  };
}

function verifyAsset(path: string, expected: BoundAsset): void {
  const descriptor = sourceDescriptor(path);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== expected.bytes) {
      throw new Error("plan-bound attachment no longer matches its confirmed metadata");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > expected.bytes) throw new Error("plan-bound attachment grew after confirmation");
      hash.update(buffer.subarray(0, count));
    }
    if (total !== expected.bytes || hash.digest("hex") !== expected.sha256) {
      throw new Error("plan-bound attachment failed its content hash");
    }
  } finally {
    closeSync(descriptor);
  }
}

export function resolvePlanAssetFiles(
  files: readonly FileInputValue[],
  planDigest: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  if (files.length < 1 || files.length > MAX_ASSET_COUNT) throw new Error("file resolution requires 1-25 plan-bound attachments");
  const bundle = planAssetBundlePath(planDigest, environment);
  const bundleStats = lstatSync(bundle);
  if (!bundleStats.isDirectory() || bundleStats.isSymbolicLink()) throw new Error("plan asset bundle is not a real directory");
  return files.map((file) => {
    const expected = decodeReference(file.reference);
    const path = join(bundle, expected.fileName);
    verifyAsset(path, expected);
    return path;
  });
}

export function cleanupPlanAssets(
  planDigest: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const path = planAssetBundlePath(planDigest, environment);
  return existsSync(path) ? removePrivateStateDirectoryTree(path, environment) : false;
}

export function isPlanBoundFile(value: unknown): value is FileInputValue {
  try {
    const reference = (value as { readonly reference?: unknown } | null)?.reference;
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || (value as { readonly kind?: unknown }).kind !== "file"
      || typeof reference !== "string"
    ) return false;
    decodeReference(reference);
    return true;
  } catch {
    return false;
  }
}

export function summarizePlanFile(value: FileInputValue): PlanFileSummary {
  const asset = decodeReference(value.reference);
  return {
    kind: "file",
    sha256: asset.sha256,
    bytes: asset.bytes,
    mediaType: asset.mediaType,
  };
}
