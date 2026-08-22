import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { detectMediaType } from "./plan-assets";

export const MAX_DERIVATION_FIXTURES = 20;
export const MAX_DERIVATION_FIXTURE_BYTES = 50 * 1024 * 1024;
export const MAX_DERIVATION_FIXTURE_TOTAL_BYTES = 200 * 1024 * 1024;

const fixtureReferencePattern = /^fixture:(?:[1-9]|1[0-9]|20)$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const unsignedIntegerPattern = /^\d{1,40}$/u;

const mediaTypeExtensions = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
} as const;

export type DerivationFixtureMediaType = keyof typeof mediaTypeExtensions;

export type DerivationFixture = {
  readonly reference: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly mediaType: DerivationFixtureMediaType;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
};

export type DerivationFixtureSummary = Pick<
  DerivationFixture,
  "reference" | "bytes" | "mediaType" | "sha256"
>;

function fixtureError(message: string): Error {
  return new Error(`derivation fixture ${message}`);
}

function currentUserOwns(uid: number | bigint): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return currentUid === undefined || uid === (typeof uid === "bigint" ? BigInt(currentUid) : currentUid);
}

function sourceDescriptor(sourceReference: string): number {
  if (
    sourceReference.length < 1
    || sourceReference.length > 4_096
    || sourceReference.includes("\u0000")
    || fixtureReferencePattern.test(sourceReference)
  ) throw fixtureError("source is invalid");
  const source = isAbsolute(sourceReference) ? sourceReference : resolve(sourceReference);
  try {
    return openSync(
      source,
      constants.O_RDONLY
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
        | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
    );
  } catch {
    throw fixtureError("could not be opened safely");
  }
}

function fixedFileName(index: number, mediaType: DerivationFixtureMediaType): string {
  return `fixture-${String(index).padStart(2, "0")}${mediaTypeExtensions[mediaType]}`;
}

function isFixtureMediaType(value: string): value is DerivationFixtureMediaType {
  return Object.hasOwn(mediaTypeExtensions, value);
}

function stageOneFixture(
  sourceReference: string,
  directory: string,
  index: number,
  remainingBytes: number,
): DerivationFixture {
  const input = sourceDescriptor(sourceReference);
  const temporaryFileName = `fixture-${String(index).padStart(2, "0")}.tmp`;
  const temporaryPath = join(directory, temporaryFileName);
  let output: number | null = null;
  let temporaryPresent = false;
  try {
    const before = fstatSync(input, { bigint: true });
    const maximum = Math.min(MAX_DERIVATION_FIXTURE_BYTES, remainingBytes);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(maximum)) {
      throw fixtureError(`must be a non-empty regular supported media file no larger than ${maximum} bytes`);
    }
    try {
      output = openSync(
        temporaryPath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
        0o600,
      );
      temporaryPresent = true;
      fchmodSync(output, 0o600);
    } catch {
      throw fixtureError("private copy could not be created safely");
    }

    const buffer = Buffer.allocUnsafe(64 * 1024);
    const prefix = Buffer.allocUnsafe(Math.min(4_096, Number(before.size)));
    let prefixBytes = 0;
    let total = 0;
    const hash = createHash("sha256");
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > maximum) throw fixtureError(`grew beyond ${maximum} bytes while being copied`);
      const value = buffer.subarray(0, count);
      if (prefixBytes < prefix.byteLength) {
        const retained = Math.min(value.byteLength, prefix.byteLength - prefixBytes);
        value.copy(prefix, prefixBytes, 0, retained);
        prefixBytes += retained;
      }
      hash.update(value);
      let written = 0;
      while (written < value.byteLength) {
        written += writeSync(output, value, written, value.byteLength - written);
      }
    }
    const after = fstatSync(input, { bigint: true });
    if (
      total !== Number(before.size)
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) throw fixtureError("changed while being copied");
    fsyncSync(output);
    closeSync(output);
    output = null;

    const detected = detectMediaType(prefix.subarray(0, prefixBytes));
    if (!isFixtureMediaType(detected)) {
      throw fixtureError("content type must be PNG, JPEG, GIF, WebP, or MP4");
    }
    const fileName = fixedFileName(index, detected);
    try {
      renameSync(temporaryPath, join(directory, fileName));
      temporaryPresent = false;
    } catch {
      throw fixtureError("private copy could not be finalized safely");
    }
    const copied = lstatSync(join(directory, fileName), { bigint: true });
    if (
      !copied.isFile()
      || copied.isSymbolicLink()
      || !currentUserOwns(copied.uid)
      || (copied.mode & 0o777n) !== 0o600n
      || copied.size !== before.size
    ) throw fixtureError("private copy is unsafe");
    return {
      reference: `fixture:${index}`,
      fileName,
      bytes: total,
      mediaType: detected,
      sha256: hash.digest("hex"),
      device: copied.dev.toString(),
      inode: copied.ino.toString(),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("derivation fixture ")) throw error;
    throw fixtureError("could not be copied safely");
  } finally {
    if (output !== null) closeSync(output);
    closeSync(input);
    if (temporaryPresent) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The enclosing derivation setup owns fail-closed cleanup of its private directory.
      }
    }
  }
}

export function stageDerivationFixtures(
  sourceReferences: readonly string[],
  directory: string,
): readonly DerivationFixture[] {
  if (sourceReferences.length > MAX_DERIVATION_FIXTURES) {
    throw fixtureError(`count exceeds ${MAX_DERIVATION_FIXTURES}`);
  }
  const fixtures: DerivationFixture[] = [];
  let totalBytes = 0;
  for (const [offset, sourceReference] of sourceReferences.entries()) {
    const fixture = stageOneFixture(
      sourceReference,
      directory,
      offset + 1,
      MAX_DERIVATION_FIXTURE_TOTAL_BYTES - totalBytes,
    );
    totalBytes += fixture.bytes;
    fixtures.push(fixture);
  }
  return Object.freeze(fixtures);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function parseDerivationFixtures(value: unknown): readonly DerivationFixture[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_DERIVATION_FIXTURES) {
    throw fixtureError("metadata is malformed");
  }
  let totalBytes = 0;
  const fixtures = value.map((candidate, offset): DerivationFixture => {
    if (
      typeof candidate !== "object"
      || candidate === null
      || Array.isArray(candidate)
      || !exactKeys(candidate as Record<string, unknown>, [
        "reference", "fileName", "bytes", "mediaType", "sha256", "device", "inode",
      ])
    ) throw fixtureError("metadata is malformed");
    const record = candidate as Record<string, unknown>;
    const index = offset + 1;
    if (
      record.reference !== `fixture:${index}`
      || typeof record.mediaType !== "string"
      || !isFixtureMediaType(record.mediaType)
      || record.fileName !== fixedFileName(index, record.mediaType)
      || typeof record.bytes !== "number"
      || !Number.isSafeInteger(record.bytes)
      || record.bytes < 1
      || record.bytes > MAX_DERIVATION_FIXTURE_BYTES
      || typeof record.sha256 !== "string"
      || !sha256Pattern.test(record.sha256)
      || typeof record.device !== "string"
      || !unsignedIntegerPattern.test(record.device)
      || typeof record.inode !== "string"
      || !unsignedIntegerPattern.test(record.inode)
    ) throw fixtureError("metadata is malformed");
    totalBytes += record.bytes;
    if (totalBytes > MAX_DERIVATION_FIXTURE_TOTAL_BYTES) {
      throw fixtureError("metadata exceeds its aggregate byte bound");
    }
    return {
      reference: record.reference,
      fileName: record.fileName,
      bytes: record.bytes,
      mediaType: record.mediaType,
      sha256: record.sha256,
      device: record.device,
      inode: record.inode,
    };
  });
  return Object.freeze(fixtures);
}

export function derivationFixtureSummaries(
  fixtures: readonly DerivationFixture[],
): readonly DerivationFixtureSummary[] {
  return fixtures.map((fixture) => ({
    reference: fixture.reference,
    bytes: fixture.bytes,
    mediaType: fixture.mediaType,
    sha256: fixture.sha256,
  }));
}

export function assertDerivationFixtureFile(
  directory: string,
  fixture: DerivationFixture,
): string {
  const path = join(directory, fixture.fileName);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
        | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
    );
  } catch {
    throw fixtureError("private copy is unavailable or unsafe");
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || !currentUserOwns(before.uid)
      || (before.mode & 0o777n) !== 0o600n
      || before.dev.toString() !== fixture.device
      || before.ino.toString() !== fixture.inode
      || before.size !== BigInt(fixture.bytes)
    ) throw fixtureError("private copy changed identity or metadata");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > fixture.bytes) throw fixtureError("private copy changed size");
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      total !== fixture.bytes
      || hash.digest("hex") !== fixture.sha256
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) throw fixtureError("private copy changed content");
    return `./${fixture.fileName}`;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("derivation fixture ")) throw error;
    throw fixtureError("private copy could not be verified safely");
  } finally {
    closeSync(descriptor);
  }
}
