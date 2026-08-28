#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 128 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const writeTemporaryFaultForTest = process.env.NODE_ENV === "test"
  ? process.env.WRENCH_TEST_WRITE_TEMP_FAULT
  : undefined;
const pathMutationFaultForTest = process.env.NODE_ENV === "test"
  ? process.env.WRENCH_TEST_PATH_MUTATION_FAULT
  : undefined;
const removeDirectoryFaultForTest = process.env.NODE_ENV === "test"
  ? process.env.WRENCH_TEST_REMOVE_DIRECTORY_FAULT
  : undefined;
const removeQuarantineScanMaximum = (() => {
  const testValue = process.env.NODE_ENV === "test"
    ? process.env.WRENCH_TEST_REMOVE_QUARANTINE_SCAN_MAXIMUM
    : undefined;
  if (testValue === undefined) return 100_000;
  if (!/^[1-9][0-9]{0,5}$/u.test(testValue)) {
    throw new Error("test recursive-removal scan bound is invalid");
  }
  return Number(testValue);
})();
const writeTemporaryNamePattern =
  /^\.io-write-([1-9][0-9]{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;
const pathMutationStageNamePattern =
  /^\.io-path-mutation-stage-([a-f0-9]{64})-([1-9][0-9]{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;
const removeQuarantineNamePattern =
  /^\.io-remove-([1-9][0-9]{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.quarantine$/u;

type Identity = { readonly device: string; readonly inode: string };
type DirectoryExpectation = Identity | null;
type FileExpectation = {
  readonly identity: Identity;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
};
type DirectoryEntry = {
  readonly name: string;
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly identity: Identity;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
};
type TreeEntry = Omit<DirectoryEntry, "name"> & {
  readonly path: string;
};
type PathMutationClaim = {
  readonly kind: "io-path-mutation-claim";
  readonly schemaVersion: 1;
  readonly targetSha256: string;
  readonly requestId: string;
  readonly pid: number;
};
type PathMutationClaimSnapshot = {
  readonly claim: PathMutationClaim;
  readonly content: Buffer;
  readonly stats: BigIntStats;
};
type BatchReadFile = {
  readonly segments: readonly string[];
  readonly directoryExpectations: readonly Identity[];
  readonly maximumBytes: number;
  readonly fileExpectation: FileExpectation;
};

type Request = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly expected: Identity;
  readonly operation:
    | {
      readonly kind: "ensure-directories";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly requireFinalPrivate: boolean;
    }
    | {
      readonly kind: "read-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly Identity[];
      readonly maximumBytes: number;
      readonly fileExpectation?: FileExpectation;
    }
    | {
      readonly kind: "list-directory";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly Identity[];
      readonly maximumEntries: number;
    }
    | {
      readonly kind: "snapshot-tree";
      readonly maximumEntries: number;
      readonly maximumDirectories: number;
      readonly maximumDepth: number;
      readonly maximumPathBytes: number;
    }
    | {
      readonly kind: "batch-read-files";
      readonly files: readonly BatchReadFile[];
      readonly maximumTotalBytes: number;
    }
    | {
      readonly kind: "write-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly content: string;
      readonly createOnly: boolean;
      readonly expectedContentSha256: string | null;
      readonly maximumExpectedContentBytes: number;
    }
    | {
      readonly kind: "remove-directory-tree";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly expectedTargetBirthtimeNs: string | null;
    };
};

type Response = {
  readonly ok: true;
  readonly identity: Identity;
  readonly created?: boolean;
  readonly removed?: boolean;
  readonly contentBase64?: string;
  readonly entries?: readonly DirectoryEntry[];
  readonly targetIdentity?: Identity;
  readonly treeEntries?: readonly TreeEntry[];
  readonly fileContentsBase64?: readonly string[];
};

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function ownedByCurrentUser(stats: { readonly uid: number | bigint }): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return currentUid === undefined || stats.uid === (typeof stats.uid === "bigint" ? BigInt(currentUid) : currentUid);
}

function identity(stats: { readonly dev: number | bigint; readonly ino: number | bigint }): Identity {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function directoryEntry(name: string, stats: BigIntStats): DirectoryEntry {
  return {
    name,
    kind: stats.isFile()
      ? "file"
      : stats.isDirectory()
        ? "directory"
        : stats.isSymbolicLink()
          ? "symbolic-link"
          : "other",
    identity: identity(stats),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function matchesFileExpectation(
  stats: BigIntStats,
  expected: FileExpectation,
): boolean {
  return sameIdentity(identity(stats), expected.identity)
    && stats.size.toString() === expected.size
    && stats.mtimeNs.toString() === expected.mtimeNs
    && stats.ctimeNs.toString() === expected.ctimeNs;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function hasPrivateDirectoryMode(stats: { readonly mode: number | bigint }): boolean {
  return typeof stats.mode === "bigint"
    ? (stats.mode & 0o777n) === 0o700n
    : (stats.mode & 0o777) === 0o700;
}

function readBoundedStdin(): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.byteLength, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_REQUEST_BYTES) throw new Error("request exceeds its byte bound");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
}

function readDescriptorBounded(descriptor: number, maximumBytes: number): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
  let total = 0;
  for (;;) {
    const remaining = maximumBytes + 1 - total;
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, remaining), null);
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > maximumBytes) throw new Error("file grew beyond its byte bound");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseIdentity(value: unknown): Identity {
  if (
    !isRecord(value)
    || !exactKeys(value, ["device", "inode"])
    || typeof value.device !== "string"
    || !/^\d{1,40}$/u.test(value.device)
    || typeof value.inode !== "string"
    || !/^\d{1,40}$/u.test(value.inode)
  ) throw new Error("expected directory identity is invalid");
  return { device: value.device, inode: value.inode };
}

function parseFileExpectation(value: unknown): FileExpectation {
  if (
    !isRecord(value)
    || !exactKeys(value, ["identity", "size", "mtimeNs", "ctimeNs"])
    || typeof value.size !== "string"
    || !/^[0-9]{1,40}$/u.test(value.size)
    || typeof value.mtimeNs !== "string"
    || !/^-?[0-9]{1,40}$/u.test(value.mtimeNs)
    || typeof value.ctimeNs !== "string"
    || !/^-?[0-9]{1,40}$/u.test(value.ctimeNs)
  ) throw new Error("expected file identity is invalid");
  return {
    identity: parseIdentity(value.identity),
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function parseSegments(value: unknown, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 64) {
    throw new Error("path segment count is invalid");
  }
  return value.map((candidate) => {
    if (
      typeof candidate !== "string"
      || candidate === ""
      || candidate === "."
      || candidate === ".."
      || candidate.includes("/")
      || candidate.includes("\\")
      || candidate.includes("\u0000")
      || Buffer.byteLength(candidate, "utf8") > 255
    ) throw new Error("path segment is invalid");
    return candidate;
  });
}

function parseDirectoryExpectations(
  value: unknown,
  expectedLength: number,
): readonly DirectoryExpectation[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error("directory expectation count does not match the path");
  }
  let sawAbsent = false;
  return value.map((candidate) => {
    if (candidate === null) {
      sawAbsent = true;
      return null;
    }
    if (sawAbsent) throw new Error("an existing directory cannot follow an absent directory expectation");
    return parseIdentity(candidate);
  });
}

function parseExistingDirectoryExpectations(value: unknown, expectedLength: number): readonly Identity[] {
  const parsed = parseDirectoryExpectations(value, expectedLength);
  return parsed.map((candidate) => {
    if (candidate === null) throw new Error("this operation cannot create an absent directory");
    return candidate;
  });
}

function parseBatchReadFile(value: unknown): BatchReadFile {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "segments",
      "directoryExpectations",
      "maximumBytes",
      "fileExpectation",
    ])
    || typeof value.maximumBytes !== "number"
    || !Number.isSafeInteger(value.maximumBytes)
    || value.maximumBytes < 0
    || value.maximumBytes > MAX_READ_BYTES
  ) throw new Error("batch read file request is invalid");
  const segments = parseSegments(value.segments);
  const fileExpectation = parseFileExpectation(value.fileExpectation);
  if (BigInt(fileExpectation.size) > BigInt(value.maximumBytes)) {
    throw new Error("batch read file expectation exceeds its byte bound");
  }
  return {
    segments,
    directoryExpectations: parseExistingDirectoryExpectations(
      value.directoryExpectations,
      segments.length - 1,
    ),
    maximumBytes: value.maximumBytes,
    fileExpectation,
  };
}

function parseRequest(value: unknown): Request {
  if (
    !isRecord(value)
    || !exactKeys(value, ["schemaVersion", "requestId", "expected", "operation"])
    || value.schemaVersion !== 1
    || typeof value.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.requestId)
    || !isRecord(value.operation)
    || typeof value.operation.kind !== "string"
  ) throw new Error("request envelope is invalid");
  const expected = parseIdentity(value.expected);
  const operation = value.operation;
  if (
    operation.kind === "ensure-directories"
    && exactKeys(operation, ["kind", "segments", "directoryExpectations", "requireFinalPrivate"])
    && typeof operation.requireFinalPrivate === "boolean"
  ) {
    const segments = parseSegments(operation.segments, true);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "ensure-directories",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length),
        requireFinalPrivate: operation.requireFinalPrivate,
      },
    };
  }
  if (
    operation.kind === "read-file"
    && (
      exactKeys(operation, ["kind", "segments", "directoryExpectations", "maximumBytes"])
      || exactKeys(operation, [
        "kind",
        "segments",
        "directoryExpectations",
        "maximumBytes",
        "fileExpectation",
      ])
    )
    && typeof operation.maximumBytes === "number"
    && Number.isSafeInteger(operation.maximumBytes)
    && operation.maximumBytes >= 0
    && operation.maximumBytes <= MAX_READ_BYTES
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "read-file",
        segments,
        directoryExpectations: parseExistingDirectoryExpectations(
          operation.directoryExpectations,
          segments.length - 1,
        ),
        maximumBytes: operation.maximumBytes,
        ...("fileExpectation" in operation
          ? { fileExpectation: parseFileExpectation(operation.fileExpectation) }
          : {}),
      },
    };
  }
  if (
    operation.kind === "list-directory"
    && exactKeys(operation, ["kind", "segments", "directoryExpectations", "maximumEntries"])
    && typeof operation.maximumEntries === "number"
    && Number.isSafeInteger(operation.maximumEntries)
    && operation.maximumEntries >= 1
    && operation.maximumEntries <= 10_000
  ) {
    const segments = parseSegments(operation.segments, true);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "list-directory",
        segments,
        directoryExpectations: parseExistingDirectoryExpectations(
          operation.directoryExpectations,
          segments.length,
        ),
        maximumEntries: operation.maximumEntries,
      },
    };
  }
  if (
    operation.kind === "snapshot-tree"
    && exactKeys(operation, [
      "kind",
      "maximumEntries",
      "maximumDirectories",
      "maximumDepth",
      "maximumPathBytes",
    ])
    && typeof operation.maximumEntries === "number"
    && Number.isSafeInteger(operation.maximumEntries)
    && operation.maximumEntries >= 1
    && operation.maximumEntries <= 10_000
    && typeof operation.maximumDirectories === "number"
    && Number.isSafeInteger(operation.maximumDirectories)
    && operation.maximumDirectories >= 0
    && operation.maximumDirectories <= operation.maximumEntries
    && typeof operation.maximumDepth === "number"
    && Number.isSafeInteger(operation.maximumDepth)
    && operation.maximumDepth >= 1
    && operation.maximumDepth <= 64
    && typeof operation.maximumPathBytes === "number"
    && Number.isSafeInteger(operation.maximumPathBytes)
    && operation.maximumPathBytes >= 1
    && operation.maximumPathBytes <= 4_096
  ) {
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "snapshot-tree",
        maximumEntries: operation.maximumEntries,
        maximumDirectories: operation.maximumDirectories,
        maximumDepth: operation.maximumDepth,
        maximumPathBytes: operation.maximumPathBytes,
      },
    };
  }
  if (
    operation.kind === "batch-read-files"
    && exactKeys(operation, ["kind", "files", "maximumTotalBytes"])
    && Array.isArray(operation.files)
    && operation.files.length >= 1
    && operation.files.length <= 1_000
    && typeof operation.maximumTotalBytes === "number"
    && Number.isSafeInteger(operation.maximumTotalBytes)
    && operation.maximumTotalBytes >= 1
    && operation.maximumTotalBytes <= MAX_READ_BYTES
  ) {
    const files = operation.files.map(parseBatchReadFile);
    const paths = files.map((file) => file.segments.join("/"));
    if (new Set(paths).size !== paths.length) {
      throw new Error("batch read file paths must be unique");
    }
    const expectedTotal = files.reduce(
      (total, file) => total + BigInt(file.fileExpectation.size),
      0n,
    );
    if (expectedTotal > BigInt(operation.maximumTotalBytes)) {
      throw new Error("batch read file expectations exceed the total byte bound");
    }
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "batch-read-files",
        files,
        maximumTotalBytes: operation.maximumTotalBytes,
      },
    };
  }
  if (
    operation.kind === "write-file"
    && (
      exactKeys(operation, ["kind", "segments", "directoryExpectations", "content", "createOnly"])
      || exactKeys(operation, [
        "kind", "segments", "directoryExpectations", "content", "createOnly",
        "expectedContentSha256", "maximumExpectedContentBytes",
      ])
    )
    && typeof operation.content === "string"
    && Buffer.byteLength(operation.content, "utf8") <= MAX_WRITE_BYTES
    && typeof operation.createOnly === "boolean"
    && (
      operation.expectedContentSha256 === undefined
      || operation.expectedContentSha256 === null
      || typeof operation.expectedContentSha256 === "string"
        && /^[a-f0-9]{64}$/u.test(operation.expectedContentSha256)
    )
    && (
      operation.maximumExpectedContentBytes === undefined
      || typeof operation.maximumExpectedContentBytes === "number"
        && Number.isSafeInteger(operation.maximumExpectedContentBytes)
        && operation.maximumExpectedContentBytes >= 0
        && operation.maximumExpectedContentBytes <= MAX_READ_BYTES
    )
    && (!operation.createOnly || operation.expectedContentSha256 == null)
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "write-file",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length - 1),
        content: operation.content,
        createOnly: operation.createOnly,
        expectedContentSha256: operation.expectedContentSha256 ?? null,
        maximumExpectedContentBytes:
          operation.maximumExpectedContentBytes ?? MAX_WRITE_BYTES,
      },
    };
  }
  if (
    operation.kind === "remove-directory-tree"
    && (
      exactKeys(operation, ["kind", "segments", "directoryExpectations"])
      || exactKeys(operation, [
        "kind",
        "segments",
        "directoryExpectations",
        "expectedTargetBirthtimeNs",
      ])
    )
  ) {
    const segments = parseSegments(operation.segments);
    if (segments.length < 2) throw new Error("recursive removal target is too broad");
    const expectedTargetBirthtimeNs = "expectedTargetBirthtimeNs" in operation
      ? operation.expectedTargetBirthtimeNs
      : null;
    if (
      expectedTargetBirthtimeNs !== null
      && (
        typeof expectedTargetBirthtimeNs !== "string"
        || !/^[1-9]\d{0,39}$/u.test(expectedTargetBirthtimeNs)
      )
    ) throw new Error("recursive removal target birth time is invalid");
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "remove-directory-tree",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length),
        expectedTargetBirthtimeNs,
      },
    };
  }
  throw new Error("request operation is invalid");
}

function openBoundDirectory(path: string): number {
  const descriptor = openSync(
    path,
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
  );
  const stats = fstatSync(descriptor);
  if (!stats.isDirectory()) {
    closeSync(descriptor);
    throw new Error("bound path is not a real directory");
  }
  return descriptor;
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openBoundDirectory(path);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function processIsDefinitelyMissing(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ESRCH"
    );
  }
}

function recoverDefinitelyOrphanedWriteTemporaries(): void {
  let removed = false;
  for (const name of readdirSync(".")) {
    const pidText = writeTemporaryNamePattern.exec(name)?.[1];
    if (pidText === undefined) continue;
    const pid = Number(pidText);
    if (
      !Number.isSafeInteger(pid)
      || pid < 1
      || pid > 2_147_483_647
      || !processIsDefinitelyMissing(pid)
    ) continue;
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(name, { bigint: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || !ownedByCurrentUser(stats)
      || (stats.mode & 0o077n) !== 0n
    ) continue;
    try {
      unlinkSync(name);
      removed = true;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  if (removed) syncDirectory(".");
}

function pauseAfterWriteTemporaryForTest(): void {
  if (writeTemporaryFaultForTest !== "pause-after-temp-fsync") return;
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitState, 0, 0, 60_000);
}

function pauseAfterRemoveQuarantineForTest(): void {
  if (removeDirectoryFaultForTest !== "pause-after-quarantine-fsync") return;
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitState, 0, 0, 60_000);
}

function assertExpectedCwd(expected: Identity): Identity {
  const descriptor = openBoundDirectory(".");
  try {
    const actual = identity(fstatSync(descriptor, { bigint: true }));
    if (!sameIdentity(actual, expected)) throw new Error("bound directory identity does not match");
    return actual;
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateCurrentDirectory(): void {
  const descriptor = openBoundDirectory(".");
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!ownedByCurrentUser(stats) || !hasPrivateDirectoryMode(stats)) {
      throw new Error("preexisting private directory must be current-user-owned with mode 0700");
    }
  } finally {
    closeSync(descriptor);
  }
}

function enterExpectedDirectory(segment: string, expected: Identity): void {
  const before = lstatSync(segment, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory() || !sameIdentity(identity(before), expected)) {
    throw new Error("directory path no longer matches its validated identity");
  }
  process.chdir(segment);
  const descriptor = openBoundDirectory(".");
  try {
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity(after), expected)) {
      throw new Error("directory changed identity while being bound");
    }
  } finally {
    closeSync(descriptor);
  }
}

function createAndEnterDirectory(segment: string): void {
  try {
    mkdirSync(segment, { mode: 0o700 });
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new Error("an absent directory appeared while being created");
    throw error;
  }
  const created = lstatSync(segment, { bigint: true });
  if (created.isSymbolicLink() || !created.isDirectory() || !ownedByCurrentUser(created)) {
    throw new Error("new directory is not a current-user-owned real directory");
  }
  const expected = identity(created);
  syncDirectory(".");
  process.chdir(segment);
  const descriptor = openBoundDirectory(".");
  try {
    const bound = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity(bound), expected) || !ownedByCurrentUser(bound)) {
      throw new Error("new directory changed identity before it was bound");
    }
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function traverseDirectories(
  segments: readonly string[],
  expectations: readonly DirectoryExpectation[],
  requireFinalPrivate: boolean,
  createAbsent = true,
): boolean {
  for (const [index, segment] of segments.entries()) {
    const expected = expectations[index];
    if (expected === undefined) throw new Error("directory expectation is missing");
    if (expected === null) {
      if (!createAbsent) {
        try {
          lstatSync(segment);
        } catch (error) {
          if (hasCode(error, "ENOENT")) return false;
          throw error;
        }
        throw new Error("directory appeared where absence was expected");
      }
      createAndEnterDirectory(segment);
    }
    else enterExpectedDirectory(segment, expected);
  }
  if (requireFinalPrivate) assertPrivateCurrentDirectory();
  return true;
}

function ensureDirectories(
  expected: Identity,
  segments: readonly string[],
  expectations: readonly DirectoryExpectation[],
  requireFinalPrivate: boolean,
): Response {
  const actual = assertExpectedCwd(expected);
  traverseDirectories(segments, expectations, requireFinalPrivate);
  return { ok: true, identity: actual };
}

function readBoundLeaf(
  leaf: string,
  maximumBytes: number,
  fileExpectation?: FileExpectation,
): Buffer {
  const pathStats = lstatSync(leaf, { bigint: true });
  if (
    pathStats.isSymbolicLink()
    || !pathStats.isFile()
    || (fileExpectation !== undefined
      && !matchesFileExpectation(pathStats, fileExpectation))
  ) {
    throw new Error("read target no longer matches its validated file identity");
  }
  const descriptor = openSync(
    leaf,
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
  );
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (
      !stats.isFile()
      || stats.size > BigInt(maximumBytes)
      || (fileExpectation !== undefined
        && !matchesFileExpectation(stats, fileExpectation))
    ) {
      throw new Error("read target is not a bounded regular file");
    }
    const content = readDescriptorBounded(descriptor, maximumBytes);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(stats, after)) {
      throw new Error("read target changed while it was being read");
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function pathMutationTargetSha256(leaf: string): string {
  return createHash("sha256")
    .update("io-path-mutation", "utf8")
    .update("\0", "utf8")
    .update(leaf, "utf8")
    .digest("hex");
}

function pathMutationLockName(targetSha256: string): string {
  return `.io-path-mutation-${targetSha256}.lock`;
}

function renderPathMutationClaim(claim: PathMutationClaim): string {
  return `${JSON.stringify(claim)}\n`;
}

function parsePathMutationClaim(
  content: Buffer,
  targetSha256: string,
): PathMutationClaim {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(content)) as unknown;
  } catch (error) {
    throw new Error("path mutation claim is not canonical JSON", { cause: error });
  }
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "kind",
      "schemaVersion",
      "targetSha256",
      "requestId",
      "pid",
    ])
    || value.kind !== "io-path-mutation-claim"
    || value.schemaVersion !== 1
    || value.targetSha256 !== targetSha256
    || typeof value.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value.requestId)
    || typeof value.pid !== "number"
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || value.pid > 2_147_483_647
  ) throw new Error("path mutation claim is invalid");
  const claim: PathMutationClaim = {
    kind: "io-path-mutation-claim",
    schemaVersion: 1,
    targetSha256,
    requestId: value.requestId,
    pid: value.pid,
  };
  if (renderPathMutationClaim(claim) !== content.toString("utf8")) {
    throw new Error("path mutation claim is not canonical JSON");
  }
  return claim;
}

function readPathMutationClaimSnapshot(
  name: string,
  targetSha256: string,
): PathMutationClaimSnapshot | null {
  let before: BigIntStats;
  try {
    before = lstatSync(name, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || !ownedByCurrentUser(before)
    || (before.mode & 0o077n) !== 0n
    || (before.nlink !== 1n && before.nlink !== 2n)
  ) throw new Error("path mutation claim is not one private owned file");
  const content = readBoundLeaf(name, 4 * 1024);
  const after = lstatSync(name, { bigint: true });
  if (
    !sameFileSnapshot(before, after)
    || before.mode !== after.mode
    || before.uid !== after.uid
    || before.gid !== after.gid
    || before.nlink !== after.nlink
  ) throw new Error("path mutation claim changed while it was read");
  return {
    claim: parsePathMutationClaim(content, targetSha256),
    content,
    stats: after,
  };
}

function samePathMutationClaimSnapshot(
  left: PathMutationClaimSnapshot,
  right: PathMutationClaimSnapshot,
): boolean {
  return left.content.equals(right.content)
    && sameFileSnapshot(left.stats, right.stats)
    && left.stats.mode === right.stats.mode
    && left.stats.uid === right.stats.uid
    && left.stats.gid === right.stats.gid
    && left.stats.nlink === right.stats.nlink;
}

function recoverDefinitelyOrphanedPathMutationStages(): void {
  let removed = false;
  for (const name of readdirSync(".")) {
    const pidText = pathMutationStageNamePattern.exec(name)?.[2];
    if (pidText === undefined) continue;
    const pid = Number(pidText);
    if (
      !Number.isSafeInteger(pid)
      || pid < 1
      || pid > 2_147_483_647
      || !processIsDefinitelyMissing(pid)
    ) continue;
    let stats: BigIntStats;
    try {
      stats = lstatSync(name, { bigint: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || !ownedByCurrentUser(stats)
      || (stats.mode & 0o077n) !== 0n
    ) continue;
    try {
      unlinkSync(name);
      removed = true;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  if (removed) syncDirectory(".");
}

function recoverDefinitelyOrphanedPathMutationClaim(
  lockName: string,
  targetSha256: string,
): boolean {
  const first = readPathMutationClaimSnapshot(lockName, targetSha256);
  if (first === null) return true;
  if (!processIsDefinitelyMissing(first.claim.pid)) return false;
  const second = readPathMutationClaimSnapshot(lockName, targetSha256);
  if (second === null) return true;
  if (
    !samePathMutationClaimSnapshot(first, second)
    || !processIsDefinitelyMissing(second.claim.pid)
  ) return false;
  const quarantine =
    `.io-path-mutation-recovery-${targetSha256}-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    renameSync(lockName, quarantine);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
  const moved = lstatSync(quarantine, { bigint: true });
  if (!sameIdentity(identity(moved), identity(second.stats))) {
    throw new Error("path mutation claim changed while it was quarantined");
  }
  unlinkSync(quarantine);
  syncDirectory(".");
  recoverDefinitelyOrphanedPathMutationStages();
  return true;
}

function pauseAfterPathMutationClaimForTest(
  targetSha256: string,
  requestId: string,
): void {
  if (pathMutationFaultForTest !== "pause-after-claim") return;
  const prefix = `.wrench-test-path-mutation-${targetSha256}-${requestId}`;
  const readyName = `${prefix}-ready`;
  const releaseName = `${prefix}-release`;
  const descriptor = openSync(
    readyName,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(".");
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const release = lstatSync(releaseName);
      if (
        release.isSymbolicLink()
        || !release.isFile()
        || !ownedByCurrentUser(release)
        || (release.mode & 0o077) !== 0
      ) throw new Error("path mutation test release is not one private file");
      break;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("path mutation overlap test timed out");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  unlinkSync(readyName);
  unlinkSync(releaseName);
  syncDirectory(".");
}

function acquirePathMutationClaim(
  leaf: string,
  requestId: string,
): (() => void) | null {
  const targetSha256 = pathMutationTargetSha256(leaf);
  const lockName = pathMutationLockName(targetSha256);
  recoverDefinitelyOrphanedPathMutationStages();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claim: PathMutationClaim = {
      kind: "io-path-mutation-claim",
      schemaVersion: 1,
      targetSha256,
      requestId,
      pid: process.pid,
    };
    const stage =
      `.io-path-mutation-stage-${targetSha256}-${process.pid}-${crypto.randomUUID()}.tmp`;
    let descriptor: number | null = null;
    let stageExists = false;
    try {
      descriptor = openSync(
        stage,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
        0o600,
      );
      stageExists = true;
      writeFileSync(descriptor, renderPathMutationClaim(claim), "utf8");
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      try {
        linkSync(stage, lockName);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        unlinkSync(stage);
        stageExists = false;
        syncDirectory(".");
        if (recoverDefinitelyOrphanedPathMutationClaim(lockName, targetSha256)) {
          continue;
        }
        return null;
      }
      unlinkSync(stage);
      stageExists = false;
      syncDirectory(".");
      pauseAfterPathMutationClaimForTest(targetSha256, requestId);
      return () => {
        const held = readPathMutationClaimSnapshot(lockName, targetSha256);
        if (
          held === null
          || held.claim.pid !== process.pid
          || held.claim.requestId !== requestId
        ) throw new Error("path mutation claim changed before release");
        const releaseName =
          `.io-path-mutation-release-${targetSha256}-${process.pid}-${crypto.randomUUID()}.tmp`;
        renameSync(lockName, releaseName);
        const moved = lstatSync(releaseName, { bigint: true });
        if (!sameIdentity(identity(moved), identity(held.stats))) {
          throw new Error("path mutation claim changed while it was released");
        }
        unlinkSync(releaseName);
        syncDirectory(".");
      };
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      if (stageExists) {
        try {
          unlinkSync(stage);
          syncDirectory(".");
        } catch {
          // A dead helper's private stage is recoverable by the next writer.
        }
      }
    }
  }
  return null;
}

function readFile(
  expected: Identity,
  segments: readonly string[],
  expectations: readonly Identity[],
  maximumBytes: number,
  fileExpectation?: FileExpectation,
): Response {
  const actual = assertExpectedCwd(expected);
  traverseDirectories(segments.slice(0, -1), expectations, false);
  const leaf = segments.at(-1);
  if (leaf === undefined) throw new Error("file path is missing its leaf");
  const content = readBoundLeaf(leaf, maximumBytes, fileExpectation);
  return { ok: true, identity: actual, contentBase64: content.toString("base64") };
}

function listDirectory(
  expected: Identity,
  segments: readonly string[],
  expectations: readonly Identity[],
  maximumEntries: number,
): Response {
  const actual = assertExpectedCwd(expected);
  traverseDirectories(segments, expectations, false);
  const targetDescriptor = openBoundDirectory(".");
  let targetIdentity: Identity;
  try {
    targetIdentity = identity(fstatSync(targetDescriptor, { bigint: true }));
  } finally {
    closeSync(targetDescriptor);
  }
  return {
    ok: true,
    identity: actual,
    targetIdentity,
    entries: readCurrentDirectoryEntries(maximumEntries),
  };
}

function readCurrentDirectoryEntries(
  maximumEntries: number,
): readonly DirectoryEntry[] {
  recoverDefinitelyOrphanedWriteTemporaries();
  const entries: DirectoryEntry[] = [];
  const directory = opendirSync(".");
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entries.length >= maximumEntries) {
        throw new Error(`directory exceeds its ${maximumEntries} entry bound`);
      }
      entries.push(directoryEntry(entry.name, lstatSync(entry.name, { bigint: true })));
    }
  } finally {
    directory.closeSync();
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return entries;
}

function sameDirectoryEntrySnapshot(
  stats: BigIntStats,
  expected: DirectoryEntry,
): boolean {
  return sameIdentity(identity(stats), expected.identity)
    && stats.size.toString() === expected.size
    && stats.mtimeNs.toString() === expected.mtimeNs
    && stats.ctimeNs.toString() === expected.ctimeNs;
}

function snapshotTree(
  expected: Identity,
  maximumEntries: number,
  maximumDirectories: number,
  maximumDepth: number,
  maximumPathBytes: number,
): Response {
  const actual = assertExpectedCwd(expected);
  const treeEntries: TreeEntry[] = [];
  let directories = 0;
  const visit = (
    expectedCurrent: Identity,
    parentSegments: readonly string[],
  ): void => {
    assertExpectedCwd(expectedCurrent);
    const remainingEntries = maximumEntries - treeEntries.length;
    const currentEntries = readCurrentDirectoryEntries(
      Math.max(1, remainingEntries),
    );
    for (const entry of currentEntries) {
      if (treeEntries.length >= maximumEntries) {
        throw new Error(`directory tree exceeds its ${maximumEntries} entry bound`);
      }
      const segments = [...parentSegments, entry.name];
      const path = segments.join("/");
      if (Buffer.byteLength(path, "utf8") > maximumPathBytes) {
        throw new Error(`directory tree path exceeds its ${maximumPathBytes} byte bound`);
      }
      treeEntries.push({
        path,
        kind: entry.kind,
        identity: entry.identity,
        size: entry.size,
        mtimeNs: entry.mtimeNs,
        ctimeNs: entry.ctimeNs,
      });
      if (entry.kind !== "directory") continue;
      directories += 1;
      if (directories > maximumDirectories) {
        throw new Error(
          `directory tree exceeds its ${maximumDirectories} directory bound`,
        );
      }
      if (segments.length > maximumDepth) {
        throw new Error(`directory tree exceeds its ${maximumDepth} level depth bound`);
      }
      enterExpectedDirectory(entry.name, entry.identity);
      visit(entry.identity, segments);
      process.chdir("..");
      assertExpectedCwd(expectedCurrent);
      const after = lstatSync(entry.name, { bigint: true });
      if (
        after.isSymbolicLink()
        || !after.isDirectory()
        || !sameDirectoryEntrySnapshot(after, entry)
      ) {
        throw new Error(
          `directory ${path} changed while its tree was being snapshotted`,
        );
      }
    }
  };
  visit(expected, []);
  treeEntries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    ok: true,
    identity: actual,
    treeEntries,
  };
}

function batchReadFiles(
  expected: Identity,
  files: readonly BatchReadFile[],
  maximumTotalBytes: number,
): Response {
  const actual = assertExpectedCwd(expected);
  const fileContentsBase64: string[] = [];
  let totalBytes = 0;
  for (const file of files) {
    assertExpectedCwd(expected);
    const parentSegments = file.segments.slice(0, -1);
    traverseDirectories(parentSegments, file.directoryExpectations, false);
    const leaf = file.segments.at(-1);
    if (leaf === undefined) throw new Error("batch read file path is missing its leaf");
    const content = readBoundLeaf(
      leaf,
      file.maximumBytes,
      file.fileExpectation,
    );
    totalBytes += content.byteLength;
    if (totalBytes > maximumTotalBytes) {
      throw new Error(`batch read exceeds its ${maximumTotalBytes} total byte bound`);
    }
    fileContentsBase64.push(content.toString("base64"));
    for (
      let index = file.directoryExpectations.length - 1;
      index >= 0;
      index -= 1
    ) {
      process.chdir("..");
      const parentExpected = index === 0
        ? expected
        : file.directoryExpectations[index - 1];
      if (parentExpected === undefined) {
        throw new Error("batch read directory expectation is missing");
      }
      assertExpectedCwd(parentExpected);
    }
  }
  assertExpectedCwd(expected);
  return {
    ok: true,
    identity: actual,
    fileContentsBase64,
  };
}

function assertReplaceableLeaf(leaf: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(leaf);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("write target must be an absent path or a real regular file");
  }
}

function writeFile(
  expected: Identity,
  segments: readonly string[],
  expectations: readonly DirectoryExpectation[],
  content: string,
  createOnly: boolean,
  expectedContentSha256: string | null,
  maximumExpectedContentBytes: number,
  requestId: string,
): Response {
  const actual = assertExpectedCwd(expected);
  traverseDirectories(segments.slice(0, -1), expectations, false);
  const leaf = segments.at(-1);
  if (leaf === undefined) throw new Error("file path is missing its leaf");
  if (!createOnly) assertReplaceableLeaf(leaf);
  recoverDefinitelyOrphanedWriteTemporaries();

  const temporary = `.io-write-${process.pid}-${crypto.randomUUID()}.tmp`;
  let descriptor: number | null = null;
  let temporaryExists = false;
  let releaseMutation: (() => void) | null = null;
  let mutationDurable = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
      0o600,
    );
    temporaryExists = true;
    writeFileSync(descriptor, content, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    pauseAfterWriteTemporaryForTest();
    releaseMutation = acquirePathMutationClaim(leaf, requestId);
    if (releaseMutation === null) {
      if (expectedContentSha256 !== null) {
        throw new Error("file content no longer matches the expected hash");
      }
      throw new Error("file mutation is already active");
    }
    if (createOnly) {
      try {
        linkSync(temporary, leaf);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        unlinkSync(temporary);
        temporaryExists = false;
        syncDirectory(".");
        return { ok: true, identity: actual, created: false };
      }
      unlinkSync(temporary);
      temporaryExists = false;
    } else {
      if (expectedContentSha256 !== null) {
        let current: Buffer;
        try {
          current = readBoundLeaf(leaf, maximumExpectedContentBytes);
        } catch (error) {
          if (hasCode(error, "ENOENT")) {
            throw new Error("file content no longer matches the expected hash");
          }
          throw error;
        }
        if (
          createHash("sha256").update(current).digest("hex")
          !== expectedContentSha256
        ) {
          throw new Error("file content no longer matches the expected hash");
        }
      }
      renameSync(temporary, leaf);
      temporaryExists = false;
    }
    syncDirectory(".");
    mutationDurable = true;
    return { ok: true, identity: actual, created: true };
  } finally {
    if (releaseMutation !== null) {
      try {
        releaseMutation();
      } catch (error) {
        if (!mutationDurable) throw error;
        // The target rename and directory sync are authoritative. A dead
        // helper's exact private claim is recoverable by the next writer.
      }
    }
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
        syncDirectory(".");
      } catch {
        // The staged file is private and remains inside the helper's bound cwd.
      }
    }
  }
}

function removeDirectoryTree(
  expected: Identity,
  segments: readonly string[],
  expectations: readonly DirectoryExpectation[],
  expectedTargetBirthtimeNs: string | null,
): Response {
  const actual = assertExpectedCwd(expected);
  const targetExpected = expectations.at(-1);
  const parentSegments = segments.slice(0, -1);
  const parentExpectations = expectations.slice(0, -1);
  if (!traverseDirectories(parentSegments, parentExpectations, false, false)) {
    if (targetExpected !== null && targetExpected !== undefined) {
      throw new Error("recursive removal parent is absent for an identity-bound target");
    }
    return { ok: true, identity: actual, removed: false };
  }
  const parentExpected = parentExpectations.at(-1);
  const name = segments.at(-1);
  if (
    targetExpected === undefined
    || parentExpected === undefined
    || parentExpected === null
    || name === undefined
  ) {
    throw new Error("recursive removal identity chain is incomplete");
  }
  const parentDescriptor = openBoundDirectory(".");
  try {
    if (!sameIdentity(identity(fstatSync(parentDescriptor, { bigint: true })), parentExpected)) {
      throw new Error("recursive removal parent changed identity");
    }
  } finally {
    closeSync(parentDescriptor);
  }

  let removalSource = name;
  let target: BigIntStats | null;
  try {
    target = lstatSync(name, { bigint: true });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    target = null;
  }

  if (target === null) {
    if (targetExpected === null) {
      return { ok: true, identity: actual, removed: false };
    }
    const directory = opendirSync(".");
    try {
      for (let entriesRead = 0;; entriesRead += 1) {
        const entry = directory.readSync();
        if (entry === null) break;
        if (entriesRead >= removeQuarantineScanMaximum) {
          throw new Error(
            `recursive removal recovery exceeds its ${removeQuarantineScanMaximum} entry bound`,
          );
        }
        const pidText = removeQuarantineNamePattern.exec(entry.name)?.[1];
        if (pidText === undefined) continue;
        let candidate: BigIntStats;
        try {
          candidate = lstatSync(entry.name, { bigint: true });
        } catch (error) {
          if (hasCode(error, "ENOENT")) continue;
          throw error;
        }
        if (
          !sameIdentity(identity(candidate), targetExpected)
          || (
            expectedTargetBirthtimeNs !== null
            && candidate.birthtimeNs.toString() !== expectedTargetBirthtimeNs
          )
        ) continue;
        if (
          candidate.isSymbolicLink()
          || !candidate.isDirectory()
          || !ownedByCurrentUser(candidate)
          || !hasPrivateDirectoryMode(candidate)
        ) {
          throw new Error("recursive removal quarantine is not a private current-user directory");
        }
        const pid = Number(pidText);
        if (
          !Number.isSafeInteger(pid)
          || pid < 1
          || pid > 2_147_483_647
          || !processIsDefinitelyMissing(pid)
        ) {
          throw new Error("recursive removal quarantine owner is live or cannot be proven dead");
        }
        if (removalSource !== name) {
          throw new Error("recursive removal identity has multiple quarantine paths");
        }
        removalSource = entry.name;
      }
    } finally {
      directory.closeSync();
    }
    if (removalSource === name) {
      return { ok: true, identity: actual, removed: false };
    }
  } else {
    if (targetExpected === null) {
      throw new Error("recursive removal target appeared where absence was expected");
    }
    if (
      target.isSymbolicLink()
      || !target.isDirectory()
      || !ownedByCurrentUser(target)
      || !hasPrivateDirectoryMode(target)
      || !sameIdentity(identity(target), targetExpected)
      || (
        expectedTargetBirthtimeNs !== null
        && target.birthtimeNs.toString() !== expectedTargetBirthtimeNs
      )
    ) throw new Error("recursive removal target changed identity");
  }

  if (targetExpected === null) {
    throw new Error("recursive removal target identity is unavailable");
  }
  const quarantine = `.io-remove-${process.pid}-${crypto.randomUUID()}.quarantine`;
  renameSync(removalSource, quarantine);
  const moved = lstatSync(quarantine, { bigint: true });
  if (
    !moved.isDirectory()
    || moved.isSymbolicLink()
    || !ownedByCurrentUser(moved)
    || !hasPrivateDirectoryMode(moved)
    || !sameIdentity(identity(moved), targetExpected)
    || (
      expectedTargetBirthtimeNs !== null
      && moved.birthtimeNs.toString() !== expectedTargetBirthtimeNs
    )
  ) throw new Error("recursive removal quarantine changed identity");
  syncDirectory(".");
  pauseAfterRemoveQuarantineForTest();
  rmSync(quarantine, { recursive: true, force: false, maxRetries: 0 });
  syncDirectory(".");
  return { ok: true, identity: actual, removed: true };
}

function execute(request: Request): Response {
  const operation = request.operation;
  if (operation.kind === "ensure-directories") {
    return ensureDirectories(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.requireFinalPrivate,
    );
  }
  if (operation.kind === "read-file") {
    return readFile(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.maximumBytes,
      operation.fileExpectation,
    );
  }
  if (operation.kind === "list-directory") {
    return listDirectory(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.maximumEntries,
    );
  }
  if (operation.kind === "snapshot-tree") {
    return snapshotTree(
      request.expected,
      operation.maximumEntries,
      operation.maximumDirectories,
      operation.maximumDepth,
      operation.maximumPathBytes,
    );
  }
  if (operation.kind === "batch-read-files") {
    return batchReadFiles(
      request.expected,
      operation.files,
      operation.maximumTotalBytes,
    );
  }
  if (operation.kind === "write-file") {
    return writeFile(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.content,
      operation.createOnly,
      operation.expectedContentSha256,
      operation.maximumExpectedContentBytes,
      request.requestId,
    );
  }
  return removeDirectoryTree(
    request.expected,
    operation.segments,
    operation.directoryExpectations,
    operation.expectedTargetBirthtimeNs,
  );
}

function main(): void {
  const request = parseRequest(JSON.parse(readBoundedStdin()) as unknown);
  process.stdout.write(`${JSON.stringify(execute(request))}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`path helper: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  }
}
