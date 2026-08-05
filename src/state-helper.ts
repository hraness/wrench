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
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";

import {
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
} from "./process-identity";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_FILES = 1_000;
const MAX_BATCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_NAME_BYTES = 256 * 1024;
const MAX_BATCH_STDOUT_BYTES = 96 * 1024 * 1024;
const MAX_STATE_MUTATION_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_STATE_MUTATION_EXPECTED_CONTENT_BYTES = 4 * 1024 * 1024;
const stateDirectories = new Set([
  "adapter-generations",
  "adapters",
  "auth",
  "browser-snapshots",
  "captures",
  "derivations",
  "idempotency",
  "linked-device-stores",
  "omni-read-projections",
  "plan-assets",
  "plans",
  "provider-plugin-state",
  "provider-plugins",
  "read-projection-control",
  "read-projections",
  "recovery",
  "run-journals",
  "runs",
  "session-secrets",
  "tools",
]);
const markerName = ".io-state.json";
const markerText = '{"kind":"io-state","schemaVersion":1}\n';
const emptyDirectoryRemovalRaceForTest = process.env.NODE_ENV === "test"
  ? process.env.WRENCH_TEST_EMPTY_DIRECTORY_REMOVAL_RACE
  : undefined;
const batchReadFaultForTest = process.env.NODE_ENV === "test"
  ? process.env.WRENCH_TEST_BATCH_READ_FAULT
  : undefined;
const casOverlapFaultForTest = process.env.NODE_ENV === "test"
  ? process.env.WRENCH_TEST_CAS_FAULT
  : undefined;
const TEST_BARRIER_TIMEOUT_MS = 90_000;
const writeTemporaryFaultForTest = process.env.NODE_ENV === "test"
  ? process.env.WRENCH_TEST_WRITE_TEMP_FAULT
  : undefined;
const writeTemporaryNamePattern =
  /^\.io-write-([1-9][0-9]{0,9})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;
const stateMutationStageNamePattern =
  /^\.io-mutation-stage-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([1-9][0-9]{0,9})\.tmp$/u;
const removeQuarantineNamePattern =
  /^\.io-remove-tree-([1-9][0-9]{0,9})-([1-9][0-9]{0,15})-([0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15})\.quarantine$/u;
const REMOVE_QUARANTINE_SCAN_MAXIMUM = 10_000;

type Identity = { readonly device: string; readonly inode: string };
type DirectoryExpectation = Identity | null;
type StateMutationClaimPhase = "waiting" | "candidate" | "held";
type StateMutationClaim = ProcessOwnerIdentity & {
  readonly kind: "io-state-mutation-claim";
  readonly schemaVersion: 1;
  readonly targetSha256: string;
  readonly claimId: string;
};
type StateMutationStageSnapshot = {
  readonly claim: StateMutationClaim | null;
  readonly content: Buffer;
  readonly identity: Identity;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mode: bigint;
};
type DirectoryEntry = {
  readonly name: string;
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly identity?: Identity;
};
type BatchReadInvalidReason =
  | "unsafe-file"
  | "unreadable"
  | "file-byte-bound"
  | "aggregate-byte-bound"
  | "changed-during-read";
type BatchReadFileResult =
  | {
      readonly name: string;
      readonly status: "present";
      readonly contentBase64: string;
    }
  | {
      readonly name: string;
      readonly status: "absent";
    }
  | {
      readonly name: string;
      readonly status: "invalid";
      readonly reason: BatchReadInvalidReason;
    };
type BatchReadChildFile = {
  readonly directoryName: string;
  readonly directoryIdentity: Identity;
  readonly fileName: string;
};
type BatchReadChildFileResult =
  | {
      readonly directoryName: string;
      readonly fileName: string;
      readonly status: "present";
      readonly contentBase64: string;
    }
  | {
      readonly directoryName: string;
      readonly fileName: string;
      readonly status: "absent";
    }
  | {
      readonly directoryName: string;
      readonly fileName: string;
      readonly status: "invalid";
      readonly reason: BatchReadInvalidReason;
    };

type Request = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly expected: Identity;
  readonly operation:
    | { readonly kind: "claim" }
    | { readonly kind: "create-root"; readonly segments: readonly string[] }
    | {
      readonly kind: "ensure-directories";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
    }
    | {
      readonly kind: "read-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly maximumBytes: number;
    }
    | {
      readonly kind: "read-file-if-present";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly maximumBytes: number;
    }
    | {
      readonly kind: "batch-read-files";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly names: readonly string[];
      readonly maximumBytesPerFile: number;
      readonly maximumTotalBytes: number;
    }
    | {
      readonly kind: "batch-read-child-files";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly files: readonly BatchReadChildFile[];
      readonly maximumBytesPerFile: number;
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
      readonly kind: "create-directory";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
    }
    | {
      readonly kind: "remove-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
    }
    | {
      readonly kind: "remove-file-if-unchanged";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly expectedContentSha256: string;
    }
    | {
      readonly kind: "remove-empty-directory";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
    }
    | {
      readonly kind: "list-directory";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
      readonly recoverOrphanedMutationClaims: boolean;
    }
    | {
      readonly kind: "remove-directory-tree";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly DirectoryExpectation[];
    };
};

type Response = {
  readonly ok: true;
  readonly identity: Identity;
  readonly created?: boolean;
  readonly removed?: boolean;
  readonly present?: boolean;
  readonly contentBase64?: string;
  readonly entries?: readonly DirectoryEntry[];
  readonly files?: readonly BatchReadFileResult[];
  readonly childFiles?: readonly BatchReadChildFileResult[];
  readonly targetIdentity?: Identity;
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

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode;
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

function parseSegments(value: unknown, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 32) {
    throw new Error("state path segment count is invalid");
  }
  const segments = value.map((candidate) => {
    if (
      typeof candidate !== "string"
      || candidate === ""
      || candidate === "."
      || candidate === ".."
      || candidate.includes("/")
      || candidate.includes("\\")
      || candidate.includes("\u0000")
      || Buffer.byteLength(candidate, "utf8") > 255
    ) throw new Error("state path segment is invalid");
    return candidate;
  });
  return segments;
}

function parseDirectoryExpectations(
  value: unknown,
  expectedLength: number,
): readonly DirectoryExpectation[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error("directory expectation count does not match the state path");
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

function parseBatchFileNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH_FILES) {
    throw new Error("batch file count is invalid");
  }
  let totalBytes = 0;
  const names = value.map((candidate) => {
    if (typeof candidate !== "string") {
      throw new Error("batch file name is invalid");
    }
    assertSafeDirectoryEntryName(candidate);
    totalBytes += Buffer.byteLength(candidate, "utf8");
    if (totalBytes > MAX_BATCH_NAME_BYTES) {
      throw new Error("batch file names exceed their byte bound");
    }
    return candidate;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("batch file names must be unique");
  }
  return names;
}

function parseBatchChildFiles(value: unknown): readonly BatchReadChildFile[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH_FILES) {
    throw new Error("batch child-file count is invalid");
  }
  let totalBytes = 0;
  const keys = new Set<string>();
  return value.map((candidate) => {
    if (
      !isRecord(candidate)
      || !exactKeys(candidate, [
        "directoryName",
        "directoryIdentity",
        "fileName",
      ])
      || typeof candidate.directoryName !== "string"
      || typeof candidate.fileName !== "string"
    ) {
      throw new Error("batch child-file request is invalid");
    }
    assertSafeDirectoryEntryName(candidate.directoryName);
    assertSafeDirectoryEntryName(candidate.fileName);
    totalBytes += Buffer.byteLength(candidate.directoryName, "utf8")
      + Buffer.byteLength(candidate.fileName, "utf8");
    if (totalBytes > MAX_BATCH_NAME_BYTES) {
      throw new Error("batch child-file names exceed their byte bound");
    }
    const key = `${candidate.directoryName}\u0000${candidate.fileName}`;
    if (keys.has(key)) {
      throw new Error("batch child-file requests must be unique");
    }
    keys.add(key);
    return {
      directoryName: candidate.directoryName,
      directoryIdentity: parseIdentity(candidate.directoryIdentity),
      fileName: candidate.fileName,
    };
  });
}

function parseRequest(value: unknown): Request {
  if (
    !isRecord(value)
    || !exactKeys(value, ["schemaVersion", "requestId", "expected", "operation"])
    || value.schemaVersion !== 1
    || typeof value.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.requestId)
    || !isRecord(value.operation)
    || typeof value.operation.kind !== "string"
  ) throw new Error("request envelope is invalid");
  const expected = parseIdentity(value.expected);
  const operation = value.operation;
  if (operation.kind === "claim" && exactKeys(operation, ["kind"])) {
    return { schemaVersion: 1, requestId: value.requestId, expected, operation: { kind: "claim" } };
  }
  if (operation.kind === "create-root" && exactKeys(operation, ["kind", "segments"])) {
    return { schemaVersion: 1, requestId: value.requestId, expected, operation: { kind: "create-root", segments: parseSegments(operation.segments) } };
  }
  if (operation.kind === "ensure-directories" && exactKeys(operation, ["kind", "segments", "directoryExpectations"])) {
    const segments = parseSegments(operation.segments, true);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "ensure-directories",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length),
      },
    };
  }
  if (
    (operation.kind === "read-file" || operation.kind === "read-file-if-present")
    && exactKeys(operation, ["kind", "segments", "directoryExpectations", "maximumBytes"])
    && typeof operation.maximumBytes === "number"
    && Number.isSafeInteger(operation.maximumBytes)
    && operation.maximumBytes >= 0
    && operation.maximumBytes <= 128 * 1024 * 1024
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: operation.kind,
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length - 1),
        maximumBytes: operation.maximumBytes,
      },
    };
  }
  if (
    operation.kind === "batch-read-files"
    && exactKeys(operation, [
      "kind",
      "segments",
      "directoryExpectations",
      "names",
      "maximumBytesPerFile",
      "maximumTotalBytes",
    ])
    && typeof operation.maximumBytesPerFile === "number"
    && Number.isSafeInteger(operation.maximumBytesPerFile)
    && operation.maximumBytesPerFile >= 0
    && operation.maximumBytesPerFile <= MAX_BATCH_FILE_BYTES
    && typeof operation.maximumTotalBytes === "number"
    && Number.isSafeInteger(operation.maximumTotalBytes)
    && operation.maximumTotalBytes >= 0
    && operation.maximumTotalBytes <= MAX_BATCH_TOTAL_BYTES
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "batch-read-files",
        segments,
        directoryExpectations: parseDirectoryExpectations(
          operation.directoryExpectations,
          segments.length,
        ),
        names: parseBatchFileNames(operation.names),
        maximumBytesPerFile: operation.maximumBytesPerFile,
        maximumTotalBytes: operation.maximumTotalBytes,
      },
    };
  }
  if (
    operation.kind === "batch-read-child-files"
    && exactKeys(operation, [
      "kind",
      "segments",
      "directoryExpectations",
      "files",
      "maximumBytesPerFile",
      "maximumTotalBytes",
    ])
    && typeof operation.maximumBytesPerFile === "number"
    && Number.isSafeInteger(operation.maximumBytesPerFile)
    && operation.maximumBytesPerFile >= 0
    && operation.maximumBytesPerFile <= MAX_BATCH_FILE_BYTES
    && typeof operation.maximumTotalBytes === "number"
    && Number.isSafeInteger(operation.maximumTotalBytes)
    && operation.maximumTotalBytes >= 0
    && operation.maximumTotalBytes <= MAX_BATCH_TOTAL_BYTES
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "batch-read-child-files",
        segments,
        directoryExpectations: parseDirectoryExpectations(
          operation.directoryExpectations,
          segments.length,
        ),
        files: parseBatchChildFiles(operation.files),
        maximumBytesPerFile: operation.maximumBytesPerFile,
        maximumTotalBytes: operation.maximumTotalBytes,
      },
    };
  }
  if (
    operation.kind === "write-file"
    && exactKeys(operation, [
      "kind",
      "segments",
      "directoryExpectations",
      "content",
      "createOnly",
      "expectedContentSha256",
      "maximumExpectedContentBytes",
    ])
    && typeof operation.content === "string"
    && Buffer.byteLength(operation.content, "utf8") <= MAX_STATE_MUTATION_CONTENT_BYTES
    && typeof operation.createOnly === "boolean"
    && (operation.expectedContentSha256 === null
      || (typeof operation.expectedContentSha256 === "string" && /^[0-9a-f]{64}$/u.test(operation.expectedContentSha256)))
    && typeof operation.maximumExpectedContentBytes === "number"
    && Number.isSafeInteger(operation.maximumExpectedContentBytes)
    && operation.maximumExpectedContentBytes >= 0
    && operation.maximumExpectedContentBytes <= MAX_STATE_MUTATION_EXPECTED_CONTENT_BYTES
    && (!operation.createOnly || operation.expectedContentSha256 === null)
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
        expectedContentSha256: operation.expectedContentSha256,
        maximumExpectedContentBytes: operation.maximumExpectedContentBytes,
      },
    };
  }
  if (operation.kind === "remove-file" && exactKeys(operation, ["kind", "segments", "directoryExpectations"])) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "remove-file",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length - 1),
      },
    };
  }
  if (
    operation.kind === "remove-file-if-unchanged"
    && exactKeys(operation, [
      "kind",
      "segments",
      "directoryExpectations",
      "expectedContentSha256",
    ])
    && typeof operation.expectedContentSha256 === "string"
    && /^[0-9a-f]{64}$/u.test(operation.expectedContentSha256)
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "remove-file-if-unchanged",
        segments,
        directoryExpectations: parseDirectoryExpectations(
          operation.directoryExpectations,
          segments.length - 1,
        ),
        expectedContentSha256: operation.expectedContentSha256,
      },
    };
  }
  if (operation.kind === "create-directory" && exactKeys(operation, ["kind", "segments", "directoryExpectations"])) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "create-directory",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length),
      },
    };
  }
  if (
    operation.kind === "remove-empty-directory"
    && exactKeys(operation, ["kind", "segments", "directoryExpectations"])
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "remove-empty-directory",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length),
      },
    };
  }
  if (
    operation.kind === "list-directory"
    && exactKeys(operation, [
      "kind",
      "segments",
      "directoryExpectations",
      "recoverOrphanedMutationClaims",
    ])
    && typeof operation.recoverOrphanedMutationClaims === "boolean"
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "list-directory",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length),
        recoverOrphanedMutationClaims:
          operation.recoverOrphanedMutationClaims,
      },
    };
  }
  if (
    operation.kind === "remove-directory-tree"
    && exactKeys(operation, ["kind", "segments", "directoryExpectations"])
  ) {
    const segments = parseSegments(operation.segments);
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      expected,
      operation: {
        kind: "remove-directory-tree",
        segments,
        directoryExpectations: parseDirectoryExpectations(operation.directoryExpectations, segments.length),
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
      | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0)
      | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
  );
  const stats = fstatSync(descriptor, { bigint: true });
  if (!stats.isDirectory() || !ownedByCurrentUser(stats)) {
    closeSync(descriptor);
    throw new Error("state directory is not an owned real directory");
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

/**
 * A write temporary is recoverable only when its filename is exact, its owner
 * PID is definitely absent, and the leaf is still a private owned regular
 * file. Live, reused, or uninspectable PIDs are retained.
 */
function recoverDefinitelyOrphanedWriteTemporaries(): void {
  const names = readdirSync(".");
  let removed = false;
  for (const name of names) {
    const match = writeTemporaryNamePattern.exec(name);
    const pidText = match?.[1];
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

/**
 * A recursive-removal quarantine is helper-owned only when its complete name
 * is exact. Reclaim it only after proving its PID absent and revalidating that
 * the leaf is still one private, current-user directory. Live, reused, and
 * uninspectable PIDs remain untouched.
 */
function recoverDefinitelyOrphanedDirectoryQuarantines(): void {
  let entriesRead = 0;
  let removed = false;
  const directory = opendirSync(".");
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      entriesRead += 1;
      if (entriesRead > REMOVE_QUARANTINE_SCAN_MAXIMUM) {
        throw new Error(
          `directory quarantine recovery exceeds its ${REMOVE_QUARANTINE_SCAN_MAXIMUM} entry bound`,
        );
      }
      const pidText = removeQuarantineNamePattern.exec(entry.name)?.[1];
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
        stats = lstatSync(entry.name, { bigint: true });
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        throw error;
      }
      if (
        stats.isSymbolicLink()
        || !stats.isDirectory()
        || !ownedByCurrentUser(stats)
        || !hasPrivateDirectoryMode(stats)
      ) continue;
      try {
        rmSync(entry.name, { recursive: true, force: false, maxRetries: 0 });
        removed = true;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
  } finally {
    directory.closeSync();
  }
  if (removed) syncDirectory(".");
}

function pauseAfterWriteTemporaryForTest(): void {
  if (writeTemporaryFaultForTest !== "pause-after-temp-fsync") return;
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitState, 0, 0, 60_000);
}

function assertExpectedCwd(expected: Identity): Identity {
  const descriptor = openBoundDirectory(".");
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const actual = identity(stats);
    if (!sameIdentity(actual, expected)) throw new Error("bound state directory identity does not match");
    return actual;
  } finally {
    closeSync(descriptor);
  }
}

function readMarker(): void {
  const descriptor = openSync(
    markerName,
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
  );
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || !ownedByCurrentUser(stats) || (stats.mode & 0o077n) !== 0n || stats.size > 256n) {
      throw new Error("state marker is not a private owned file");
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(readDescriptorBounded(descriptor, 256));
    if (content !== markerText) throw new Error("state marker is malformed");
  } finally {
    closeSync(descriptor);
  }
}

function assertClaimedRoot(expected: Identity): Identity {
  const actual = assertExpectedCwd(expected);
  const stats = lstatSync(".", { bigint: true });
  if (!hasPrivateDirectoryMode(stats)) throw new Error("state root mode is not 0700");
  readMarker();
  return actual;
}

function validateUnclaimedRoot(): void {
  const allowed = new Set([
    ...stateDirectories,
    ".cursor-encryption-key",
    ".plan-encryption-key",
    ".projection-encryption-key",
    ".recovery-encryption-key",
    ".session-encryption-key",
  ]);
  const directory = opendirSync(".");
  let count = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      count += 1;
      if (count > 10_000) throw new Error("unclaimed state root contains too many entries");
      assertSafeDirectoryEntryName(entry.name);
      if (entry.isSymbolicLink()) throw new Error("unclaimed state root contains a symbolic link");
      if (/^\.io-state\.stage-\d+-[0-9a-f-]{36}\.json$/u.test(entry.name)) {
        const stats = lstatSync(entry.name);
        if (!stats.isFile() || !ownedByCurrentUser(stats) || (stats.mode & 0o077) !== 0 || stats.size > 256) {
          throw new Error("unclaimed state root contains an invalid marker stage");
        }
        continue;
      }
      if (!allowed.has(entry.name)) throw new Error("unclaimed state root contains unrelated data");
      const stats = lstatSync(entry.name);
      if (!ownedByCurrentUser(stats)) throw new Error("unclaimed state root contains non-owned data");
      if (
        stateDirectories.has(entry.name)
          ? !stats.isDirectory() || stats.isSymbolicLink() || !hasPrivateDirectoryMode(stats)
          : !stats.isFile() || (stats.mode & 0o077) !== 0
      ) {
        throw new Error("unclaimed state root contains an invalid state entry");
      }
    }
  } finally {
    directory.closeSync();
  }
}

function publishMarker(): void {
  try {
    readMarker();
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  validateUnclaimedRoot();
  const temporary = `.io-state.stage-${process.pid}-${crypto.randomUUID()}.json`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, markerText, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporary, markerName);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      readMarker();
    }
    syncDirectory(".");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
      syncDirectory(".");
    } catch {
      // A private, strictly named interrupted stage is accepted by the next claim.
    }
  }
}

function claim(expected: Identity): Response {
  const actual = assertExpectedCwd(expected);
  try {
    readMarker();
    if (!hasPrivateDirectoryMode(lstatSync(".", { bigint: true }))) {
      throw new Error("claimed state root mode is not 0700");
    }
    return { ok: true, identity: actual };
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  validateUnclaimedRoot();
  const descriptor = openBoundDirectory(".");
  try {
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  publishMarker();
  return { ok: true, identity: actual };
}

function assertPrivateDirectory(
  stats: {
    readonly mode: number | bigint;
    readonly uid: number | bigint;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  },
): void {
  if (stats.isSymbolicLink()) throw new Error("state path contains a symbolic link");
  if (!stats.isDirectory() || !ownedByCurrentUser(stats)) {
    throw new Error("state path contains a non-owned real directory");
  }
  if (!hasPrivateDirectoryMode(stats)) throw new Error("existing state directory mode is not 0700");
}

function assertCurrentDirectory(expected: Identity): void {
  assertExpectedCwd(expected);
  assertPrivateDirectory(lstatSync(".", { bigint: true }));
}

function currentPrivateDirectoryIdentity(): Identity {
  const descriptor = openBoundDirectory(".");
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    assertPrivateDirectory(stats);
    return identity(stats);
  } finally {
    closeSync(descriptor);
  }
}

function bindExistingDirectory(segment: string, expected: Identity): void {
  const stats = lstatSync(segment, { bigint: true });
  assertPrivateDirectory(stats);
  if (!sameIdentity(identity(stats), expected)) throw new Error("state directory identity does not match its expectation");
  process.chdir(segment);
  assertCurrentDirectory(expected);
}

function createAndBindDirectory(segment: string): Identity {
  try {
    lstatSync(segment);
    throw new Error("state directory appeared where absence was required");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  try {
    mkdirSync(segment, { mode: 0o700 });
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new Error("state directory appeared while being created");
    throw error;
  }

  const createdStats = lstatSync(segment, { bigint: true });
  if (createdStats.isSymbolicLink() || !createdStats.isDirectory() || !ownedByCurrentUser(createdStats)) {
    throw new Error("new state path is not an owned real directory");
  }
  const createdIdentity = identity(createdStats);
  const descriptor = openBoundDirectory(segment);
  try {
    if (!sameIdentity(identity(fstatSync(descriptor, { bigint: true })), createdIdentity)) {
      throw new Error("new state directory changed identity before it could be bound");
    }
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(".");
  process.chdir(segment);
  assertCurrentDirectory(createdIdentity);
  return createdIdentity;
}

function assertDirectoryAbsent(segment: string): void {
  try {
    lstatSync(segment);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("state directory appeared where absence was expected");
}

function createRoot(expected: Identity, segments: readonly string[]): Response {
  assertExpectedCwd(expected);
  const anchorStats = lstatSync(".", { bigint: true });
  if ((anchorStats.mode & 0o022n) !== 0n) {
    throw new Error("state creation anchor must not be group- or world-writable");
  }
  let actual = expected;
  for (const segment of segments) actual = createAndBindDirectory(segment);
  assertCurrentDirectory(actual);
  validateUnclaimedRoot();
  publishMarker();
  return { ok: true, identity: actual };
}

function assertStatePath(segments: readonly string[]): void {
  const first = segments[0];
  if (
    first === undefined
    || (
      !stateDirectories.has(first)
      && !(
        segments.length === 1
        && (
          first === ".plan-encryption-key"
          || first === ".cursor-encryption-key"
          || first === ".projection-encryption-key"
          || first === ".recovery-encryption-key"
          || first === ".session-encryption-key"
        )
      )
    )
  ) {
    throw new Error("state path is outside the owned state layout");
  }
}

function assertStateDirectoryPath(segments: readonly string[]): void {
  const first = segments[0];
  if (first === undefined || !stateDirectories.has(first)) {
    throw new Error("state directory is outside the owned state layout");
  }
}

function traverseDirectories(
  segments: readonly string[],
  expectations: readonly DirectoryExpectation[],
  createAbsent: boolean,
): boolean {
  if (segments.length !== expectations.length) throw new Error("directory expectation count does not match the state path");
  if (segments.length > 0) assertStateDirectoryPath(segments);
  recoverDefinitelyOrphanedDirectoryQuarantines();
  for (const [index, segment] of segments.entries()) {
    const expected = expectations[index];
    if (expected === undefined) throw new Error("directory expectation is missing");
    if (expected === null) {
      if (createAbsent) {
        createAndBindDirectory(segment);
      } else {
        assertDirectoryAbsent(segment);
        return false;
      }
    } else {
      bindExistingDirectory(segment, expected);
    }
    recoverDefinitelyOrphanedDirectoryQuarantines();
  }
  return true;
}

function fileName(segments: readonly string[]): string {
  assertStatePath(segments);
  const name = segments.at(-1);
  if (name === undefined) throw new Error("state file path is empty");
  return name;
}

function readStablePrivateFile(descriptor: number, maximumBytes: number): Buffer {
  const before = fstatSync(descriptor, { bigint: true });
  if (
    !before.isFile()
    || !ownedByCurrentUser(before)
    || (before.mode & 0o077n) !== 0n
    || before.size > BigInt(maximumBytes)
  ) {
    throw new Error("state file is not a bounded private owned file");
  }
  const content = readDescriptorBounded(descriptor, maximumBytes);
  const after: BigIntStats = fstatSync(descriptor, { bigint: true });
  if (
    !sameIdentity(identity(before), identity(after))
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
    || before.mode !== after.mode
  ) {
    throw new Error("state file changed while it was read");
  }
  return content;
}

function stateMutationTargetSha256(name: string): string {
  return createHash("sha256")
    .update("io-state-mutation", "utf8")
    .update("\0", "utf8")
    .update(name, "utf8")
    .digest("hex");
}

function stateMutationClaimPrefix(targetSha256: string): string {
  return `.io-mutation-${targetSha256}-`;
}

function stateMutationClaimName(
  targetSha256: string,
  phase: StateMutationClaimPhase,
  claimId: string,
): string {
  return `${stateMutationClaimPrefix(targetSha256)}${phase}-${claimId}.lock`;
}

function parseStateMutationClaimName(
  name: string,
  targetSha256: string,
): {
  readonly phase: StateMutationClaimPhase;
  readonly claimId: string;
} {
  const prefix = stateMutationClaimPrefix(targetSha256);
  if (!name.startsWith(prefix)) {
    throw new Error("state mutation claim does not match its target");
  }
  const match =
    /^(waiting|candidate|held)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lock$/u
      .exec(name.slice(prefix.length));
  if (match === null) throw new Error("state mutation claim filename is invalid");
  return {
    phase: match[1] as StateMutationClaimPhase,
    claimId: match[2]!,
  };
}

function renderStateMutationClaim(claim: StateMutationClaim): string {
  return `${JSON.stringify(claim)}\n`;
}

function parseStateMutationClaim(
  content: Buffer,
  targetSha256: string,
  claimId: string,
): StateMutationClaim {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(content);
  } catch (error) {
    throw new Error("state mutation claim is not valid UTF-8", {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("state mutation claim is not valid JSON", {
      cause: error,
    });
  }
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "bootId",
      "claimId",
      "kind",
      "pid",
      "processStartId",
      "schemaVersion",
      "targetSha256",
    ])
    || value.kind !== "io-state-mutation-claim"
    || value.schemaVersion !== 1
    || value.targetSha256 !== targetSha256
    || value.claimId !== claimId
    || !Number.isSafeInteger(value.pid)
    || typeof value.pid !== "number"
    || value.pid < 1
    || typeof value.bootId !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.bootId)
    || typeof value.processStartId !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.processStartId)
  ) {
    throw new Error("state mutation claim is invalid");
  }
  const claim: StateMutationClaim = {
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    targetSha256: value.targetSha256,
    claimId: value.claimId,
    pid: value.pid,
    bootId: value.bootId,
    processStartId: value.processStartId,
  };
  if (text !== renderStateMutationClaim(claim)) {
    throw new Error("state mutation claim is not canonical JSON");
  }
  return claim;
}

function readStateMutationClaim(
  name: string,
  targetSha256: string,
  claimId: string,
): StateMutationClaim | null {
  let descriptor: number;
  try {
    descriptor = openPrivateFileForRead(name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    return parseStateMutationClaim(
      readStablePrivateFile(descriptor, 4 * 1024),
      targetSha256,
      claimId,
    );
  } finally {
    closeSync(descriptor);
  }
}

function stateMutationOwnerStatus(
  claim: StateMutationClaim,
): ReturnType<typeof processOwnerStatus> {
  let status = processOwnerStatus(claim);
  for (let attempt = 0; status === "unknown" && attempt < 3; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    status = processOwnerStatus(claim);
  }
  return status;
}

function readStateMutationStageSnapshot(
  name: string,
  claimId: string,
  pid: number,
): StateMutationStageSnapshot | null {
  let descriptor: number;
  try {
    descriptor = openPrivateFileForRead(name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const content = readStablePrivateFile(descriptor, 4 * 1024);
    const stats = fstatSync(descriptor, { bigint: true });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(content)) as unknown;
    } catch {
      value = null;
    }
    let claim: StateMutationClaim | null = null;
    if (
      isRecord(value)
      && typeof value.targetSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(value.targetSha256)
    ) {
      try {
        const parsed = parseStateMutationClaim(
          content,
          value.targetSha256,
          claimId,
        );
        if (parsed.pid === pid) claim = parsed;
      } catch {
        // A stable malformed stage is recoverable only from a definitely
        // absent filename PID because it has not published ownership.
      }
    }
    return {
      claim,
      content,
      identity: identity(stats),
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
      mode: stats.mode,
    };
  } finally {
    closeSync(descriptor);
  }
}

function sameStateMutationStageSnapshot(
  left: StateMutationStageSnapshot,
  right: StateMutationStageSnapshot,
): boolean {
  return left.content.equals(right.content)
    && sameIdentity(left.identity, right.identity)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode;
}

function stateMutationStageOwnerIsDefinitelyGone(
  snapshot: StateMutationStageSnapshot,
  pid: number,
): boolean {
  return snapshot.claim === null
    ? processIsDefinitelyMissing(pid)
    : stateMutationOwnerStatus(snapshot.claim) === "different-or-dead";
}

/**
 * A mutation-claim stage has not published arbitration ownership, but an
 * active helper still needs it for the atomic rename that publishes its
 * claim. A canonical stage uses its complete process identity. An empty,
 * partial, or malformed stage can use only its exact filename PID, so reclaim
 * it after two stable snapshots only when that PID is definitely absent.
 * Live, reused, changing, and uninspectable stages remain visible.
 */
function recoverDefinitelyOrphanedStateMutationStages(): void {
  let entriesRead = 0;
  let removed = false;
  for (const name of readdirSync(".")) {
    entriesRead += 1;
    if (entriesRead > 10_000) {
      throw new Error("state mutation stage recovery exceeds its entry bound");
    }
    const match = stateMutationStageNamePattern.exec(name);
    const claimId = match?.[1];
    const pidText = match?.[2];
    if (claimId === undefined || pidText === undefined) continue;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) {
      continue;
    }
    let snapshot: StateMutationStageSnapshot | null;
    try {
      snapshot = readStateMutationStageSnapshot(name, claimId, pid);
    } catch {
      continue;
    }
    if (
      snapshot === null
      || !stateMutationStageOwnerIsDefinitelyGone(snapshot, pid)
    ) continue;
    let revalidated: StateMutationStageSnapshot | null;
    try {
      revalidated = readStateMutationStageSnapshot(name, claimId, pid);
    } catch {
      continue;
    }
    if (
      revalidated === null
      || !sameStateMutationStageSnapshot(snapshot, revalidated)
      || !stateMutationStageOwnerIsDefinitelyGone(revalidated, pid)
    ) continue;
    let current: BigIntStats;
    try {
      current = lstatSync(name, { bigint: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || !sameIdentity(revalidated.identity, identity(current))
      || revalidated.size !== current.size
      || revalidated.mtimeNs !== current.mtimeNs
      || revalidated.ctimeNs !== current.ctimeNs
      || revalidated.mode !== current.mode
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

function listLiveStateMutationClaims(
  targetSha256: string,
): readonly {
  readonly name: string;
  readonly phase: StateMutationClaimPhase;
  readonly claim: StateMutationClaim;
}[] {
  const prefix = stateMutationClaimPrefix(targetSha256);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const names = readdirSync(".")
      .filter((name) => name.startsWith(prefix))
      .sort();
    if (names.length > 1_024) {
      throw new Error("state mutation claim count exceeds its bound");
    }
    let retry = false;
    let removedStaleClaim = false;
    const live: {
      readonly name: string;
      readonly phase: StateMutationClaimPhase;
      readonly claim: StateMutationClaim;
    }[] = [];
    for (const name of names) {
      const parsedName = parseStateMutationClaimName(name, targetSha256);
      const claim = readStateMutationClaim(
        name,
        targetSha256,
        parsedName.claimId,
      );
      if (claim === null) {
        retry = true;
        break;
      }
      const status = stateMutationOwnerStatus(claim);
      if (status === "unknown") {
        throw new Error(
          "state mutation claim owner cannot be inspected safely",
        );
      }
      if (status === "different-or-dead") {
        try {
          unlinkSync(name);
          removedStaleClaim = true;
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
          retry = true;
          break;
        }
        continue;
      }
      live.push({ name, phase: parsedName.phase, claim });
    }
    if (removedStaleClaim) syncDirectory(".");
    if (retry || removedStaleClaim) continue;
    return live;
  }
  throw new Error("state mutation claims did not reach a stable snapshot");
}

/**
 * Directory readers can otherwise strand behind a mutation claim left by a
 * helper that died after publishing its claim. Inspect only exact claim
 * filenames, then reuse the target-scoped arbitration logic so a claim is
 * removed only when its complete process identity is definitely dead. Live,
 * malformed, and uninspectable state remains visible or fails closed.
 */
function recoverDefinitelyOrphanedStateMutationClaims(): void {
  const targets = new Set<string>();
  for (const name of readdirSync(".")) {
    const match =
      /^\.io-mutation-([a-f0-9]{64})-(?:waiting|candidate|held)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.lock$/u
        .exec(name);
    const targetSha256 = match?.[1];
    if (targetSha256 === undefined) continue;
    targets.add(targetSha256);
    if (targets.size > 10_000) {
      throw new Error("state mutation recovery exceeds its target bound");
    }
  }
  for (const targetSha256 of [...targets].sort()) {
    listLiveStateMutationClaims(targetSha256);
  }
}

function writeStateMutationClaim(
  name: string,
  claim: StateMutationClaim,
): void {
  const temporary =
    `.io-mutation-stage-${claim.claimId}-${process.pid}.tmp`;
  let descriptor: number | null = null;
  let temporaryExists = false;
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
    writeFileSync(descriptor, renderStateMutationClaim(claim), "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    assertDirectoryAbsent(name);
    renameSync(temporary, name);
    temporaryExists = false;
    syncDirectory(".");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
        syncDirectory(".");
      } catch {
        // The unique unpublished claim stage conveys no mutation ownership.
      }
    }
  }
}

function pauseAfterStateMutationClaimForTest(): void {
  if (casOverlapFaultForTest !== "pause-after-cas-claim") return;
  const readyName = ".wrench-test-cas-ready";
  const releaseName = ".wrench-test-cas-release";
  const descriptor = openSync(
    readyName,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
    0o600,
  );
  try {
    writeFileSync(descriptor, "ready\n", "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(".");
  const deadline = Date.now() + TEST_BARRIER_TIMEOUT_MS;
  for (;;) {
    try {
      const release = lstatSync(releaseName);
      if (
        release.isSymbolicLink()
        || !release.isFile()
        || !ownedByCurrentUser(release)
        || (release.mode & 0o077) !== 0
      ) {
        throw new Error("state CAS test release is not one private file");
      }
      break;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("state CAS overlap test timed out");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  unlinkSync(readyName);
  unlinkSync(releaseName);
  syncDirectory(".");
}

function currentStateMutationProcessIdentity(): ReturnType<
  typeof currentProcessStartIdentity
> {
  let failure: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return currentProcessStartIdentity();
    } catch (error) {
      failure = error;
      if (attempt < 3) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  throw new Error("state mutation process identity is unavailable", {
    cause: failure,
  });
}

function acquireStateMutationClaim(
  targetName: string,
  requestId: string,
): (() => void) | null {
  recoverDefinitelyOrphanedStateMutationStages();
  const targetSha256 = stateMutationTargetSha256(targetName);
  const processIdentity = currentStateMutationProcessIdentity();
  const claim: StateMutationClaim = {
    kind: "io-state-mutation-claim",
    schemaVersion: 1,
    targetSha256,
    claimId: requestId,
    pid: process.pid,
    ...processIdentity,
  };
  let claimName = stateMutationClaimName(
    targetSha256,
    "waiting",
    requestId,
  );
  writeStateMutationClaim(claimName, claim);
  const release = (): void => {
    try {
      unlinkSync(claimName);
      syncDirectory(".");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  };
  try {
    const waitingClaims = listLiveStateMutationClaims(targetSha256);
    if (
      waitingClaims.some((candidate) =>
        candidate.claim.claimId !== requestId
        && (
          candidate.phase !== "waiting"
          || candidate.claim.claimId < requestId
        )
      )
    ) {
      release();
      return null;
    }

    const candidateName = stateMutationClaimName(
      targetSha256,
      "candidate",
      requestId,
    );
    renameSync(claimName, candidateName);
    claimName = candidateName;
    syncDirectory(".");
    const candidateClaims = listLiveStateMutationClaims(targetSha256);
    if (
      candidateClaims.some((candidate) =>
        candidate.claim.claimId !== requestId
        && (
          candidate.phase === "held"
          || candidate.claim.claimId < requestId
        )
      )
    ) {
      release();
      return null;
    }

    const heldName = stateMutationClaimName(
      targetSha256,
      "held",
      requestId,
    );
    renameSync(claimName, heldName);
    claimName = heldName;
    syncDirectory(".");
    const heldClaims = listLiveStateMutationClaims(targetSha256);
    if (
      heldClaims.some((candidate) =>
        candidate.claim.claimId !== requestId
        && candidate.phase === "held"
      )
    ) {
      throw new Error("state mutation arbitration admitted two owners");
    }
    pauseAfterStateMutationClaimForTest();
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function openPrivateFileForRead(name: string): number {
  return openSync(
    name,
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
  );
}

function readFile(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  maximumBytes: number,
): Response {
  const actual = assertClaimedRoot(expected);
  const name = fileName(segments);
  if (!traverseDirectories(segments.slice(0, -1), directoryExpectations, false)) {
    throw new Error("state file parent directory is absent");
  }
  const descriptor = openPrivateFileForRead(name);
  try {
    const content = readStablePrivateFile(descriptor, maximumBytes);
    return { ok: true, identity: actual, contentBase64: content.toString("base64") };
  } finally {
    closeSync(descriptor);
  }
}

function readFileIfPresent(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  maximumBytes: number,
): Response {
  const actual = assertClaimedRoot(expected);
  const name = fileName(segments);
  if (!traverseDirectories(segments.slice(0, -1), directoryExpectations, false)) {
    return { ok: true, identity: actual, present: false };
  }
  let descriptor: number;
  try {
    descriptor = openPrivateFileForRead(name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { ok: true, identity: actual, present: false };
    throw error;
  }
  try {
    const content = readStablePrivateFile(descriptor, maximumBytes);
    return {
      ok: true,
      identity: actual,
      present: true,
      contentBase64: content.toString("base64"),
    };
  } finally {
    closeSync(descriptor);
  }
}

function releaseStateMutationAfterWrite(
  release: () => void,
  mutationDurable: boolean,
): void {
  try {
    if (
      mutationDurable
      && casOverlapFaultForTest === "fail-after-cas-commit"
    ) {
      throw new Error("state CAS test fault while releasing a durable claim");
    }
    release();
  } catch (error) {
    if (!mutationDurable) throw error;
    // The target rename and parent-directory sync are authoritative. A dead
    // helper's exact claim is recoverable by the next arbitration operation.
  }
}

function writeFile(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  content: string,
  createOnly: boolean,
  expectedContentSha256: string | null,
  maximumExpectedContentBytes: number,
  requestId: string,
): Response {
  const actual = assertClaimedRoot(expected);
  const name = fileName(segments);
  traverseDirectories(segments.slice(0, -1), directoryExpectations, true);
  recoverDefinitelyOrphanedWriteTemporaries();
  const temporary = `.io-write-${process.pid}-${crypto.randomUUID()}.tmp`;
  let descriptor: number | null = null;
  let temporaryExists = false;
  let releaseMutation: (() => void) | null = null;
  let mutationDurable = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
      0o600,
    );
    temporaryExists = true;
    writeFileSync(descriptor, content, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    pauseAfterWriteTemporaryForTest();
    releaseMutation = acquireStateMutationClaim(name, requestId);
    if (releaseMutation === null) {
      if (expectedContentSha256 !== null) {
        throw new Error(
          "state file content no longer matches the expected hash",
        );
      }
      throw new Error("state file mutation is already active");
    }
    if (createOnly) {
      try {
        linkSync(temporary, name);
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
        let current: number;
        try {
          current = openPrivateFileForRead(name);
        } catch (error) {
          if (hasCode(error, "ENOENT")) {
            throw new Error("state file content no longer matches the expected hash");
          }
          throw error;
        }
        try {
          const currentContent = readStablePrivateFile(
            current,
            maximumExpectedContentBytes,
          );
          const currentSha256 = createHash("sha256").update(currentContent).digest("hex");
          if (currentSha256 !== expectedContentSha256) {
            throw new Error("state file content no longer matches the expected hash");
          }
        } finally {
          closeSync(current);
        }
      }
      renameSync(temporary, name);
      temporaryExists = false;
    }
    syncDirectory(".");
    mutationDurable = true;
    return { ok: true, identity: actual, created: true };
  } finally {
    if (releaseMutation !== null) {
      releaseStateMutationAfterWrite(releaseMutation, mutationDurable);
    }
    if (descriptor !== null) closeSync(descriptor);
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
        syncDirectory(".");
      } catch {
        // The private state remains bound to this helper's current directory.
      }
    }
  }
}

function removeFile(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  requestId: string,
): Response {
  const actual = assertClaimedRoot(expected);
  const name = fileName(segments);
  if (!traverseDirectories(segments.slice(0, -1), directoryExpectations, false)) {
    return { ok: true, identity: actual, removed: false };
  }
  const releaseMutation = acquireStateMutationClaim(name, requestId);
  if (releaseMutation === null) {
    throw new Error("state file mutation is already active");
  }
  try {
  let stats;
  try {
    stats = lstatSync(name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { ok: true, identity: actual, removed: false };
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || !ownedByCurrentUser(stats) || (stats.mode & 0o077) !== 0) {
    throw new Error("state removal target is not a private owned regular file");
  }
  unlinkSync(name);
  syncDirectory(".");
  return { ok: true, identity: actual, removed: true };
  } finally {
    releaseMutation();
  }
}

function removeFileIfUnchanged(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  expectedContentSha256: string,
  requestId: string,
): Response {
  const actual = assertClaimedRoot(expected);
  const name = fileName(segments);
  if (!traverseDirectories(segments.slice(0, -1), directoryExpectations, false)) {
    return { ok: true, identity: actual, removed: false };
  }
  const releaseMutation = acquireStateMutationClaim(name, requestId);
  if (releaseMutation === null) {
    return { ok: true, identity: actual, removed: false };
  }
  try {
  let descriptor: number;
  try {
    descriptor = openPrivateFileForRead(name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { ok: true, identity: actual, removed: false };
    }
    throw error;
  }
  try {
    const content = readStablePrivateFile(descriptor, 2 * 1024 * 1024);
    if (
      createHash("sha256").update(content).digest("hex")
      !== expectedContentSha256
    ) {
      return { ok: true, identity: actual, removed: false };
    }
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    let current: BigIntStats;
    try {
      current = lstatSync(name, { bigint: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return { ok: true, identity: actual, removed: false };
      }
      throw error;
    }
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || !sameIdentity(identity(descriptorStats), identity(current))
      || descriptorStats.size !== current.size
      || descriptorStats.mtimeNs !== current.mtimeNs
      || descriptorStats.ctimeNs !== current.ctimeNs
      || descriptorStats.mode !== current.mode
    ) {
      return { ok: true, identity: actual, removed: false };
    }

    const quarantine = `.io-remove-file-${requestId}.quarantine`;
    assertDirectoryAbsent(quarantine);
    try {
      renameSync(name, quarantine);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return { ok: true, identity: actual, removed: false };
      }
      throw error;
    }
    const quarantined = lstatSync(quarantine, { bigint: true });
    if (
      quarantined.isSymbolicLink()
      || !quarantined.isFile()
      || !sameIdentity(identity(descriptorStats), identity(quarantined))
      || descriptorStats.size !== quarantined.size
      || descriptorStats.mtimeNs !== quarantined.mtimeNs
      || descriptorStats.mode !== quarantined.mode
      || !ownedByCurrentUser(quarantined)
      || (quarantined.mode & 0o077n) !== 0n
    ) {
      throw new Error("conditional state-file removal lost its inode claim");
    }
    syncDirectory(".");
    unlinkSync(quarantine);
    syncDirectory(".");
    return { ok: true, identity: actual, removed: true };
  } finally {
    closeSync(descriptor);
  }
  } finally {
    releaseMutation();
  }
}

function createDirectory(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
): Response {
  const actual = assertClaimedRoot(expected);
  assertStateDirectoryPath(segments);
  if (segments.length < 2) throw new Error("refusing to create a top-level state directory exclusively");
  const targetExpectation = directoryExpectations.at(-1);
  if (targetExpectation !== null) throw new Error("exclusive state directory creation requires an absent target");
  if (!traverseDirectories(segments.slice(0, -1), directoryExpectations.slice(0, -1), false)) {
    throw new Error("state directory parent is absent");
  }
  const name = segments.at(-1);
  if (name === undefined) throw new Error("state directory creation target is missing");
  const targetIdentity = createAndBindDirectory(name);
  return { ok: true, identity: actual, created: true, targetIdentity };
}

function removeEmptyDirectory(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  requestId: string,
): Response {
  const actual = assertClaimedRoot(expected);
  assertStateDirectoryPath(segments);
  if (!traverseDirectories(segments, directoryExpectations, false)) {
    return { ok: true, identity: actual, removed: false };
  }
  const targetExpected = directoryExpectations.at(-1);
  if (targetExpected === undefined || targetExpected === null) {
    throw new Error("directory removal target expectation is missing");
  }
  const parentExpected = directoryExpectations.length === 1
    ? expected
    : directoryExpectations.at(-2);
  if (parentExpected === undefined || parentExpected === null) {
    throw new Error("directory removal parent expectation is missing");
  }
  const name = segments.at(-1);
  if (name === undefined) throw new Error("directory removal target is missing");

  process.chdir("..");
  assertCurrentDirectory(parentExpected);
  const stats = lstatSync(name, { bigint: true });
  assertPrivateDirectory(stats);
  if (!sameIdentity(identity(stats), targetExpected)) {
    throw new Error("directory removal target changed identity after it was bound");
  }

  if (emptyDirectoryRemovalRaceForTest === "replace-target-after-validation") {
    const preserved = `.wrench-test-preserved-${requestId}`;
    assertDirectoryAbsent(preserved);
    renameSync(name, preserved);
    mkdirSync(name, { mode: 0o700 });
  }

  const quarantine = `.io-remove-${process.pid}-${Date.now()}-${crypto.randomUUID().replaceAll("-", "")}.quarantine`;
  assertDirectoryAbsent(quarantine);
  renameSync(name, quarantine);
  syncDirectory(".");

  if (emptyDirectoryRemovalRaceForTest === "insert-after-quarantine") {
    writeFileSync(`${quarantine}/arrived-late`, "keep", { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  const quarantinedStats = lstatSync(quarantine, { bigint: true });
  assertPrivateDirectory(quarantinedStats);
  if (!sameIdentity(identity(quarantinedStats), targetExpected)) {
    throw new Error("directory removal quarantine has the wrong identity");
  }

  let removalError: Error | null = null;
  let remainedNonempty = false;
  try {
    rmdirSync(quarantine);
  } catch (error) {
    remainedNonempty = hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST");
    if (!remainedNonempty) {
      removalError = error instanceof Error
        ? error
        : new Error("empty-directory removal failed with a non-error value", { cause: error });
    }
  }
  let syncError: Error | null = null;
  try {
    syncDirectory(".");
  } catch (error) {
    syncError = error instanceof Error
      ? error
      : new Error("empty-directory parent sync failed with a non-error value", { cause: error });
  }
  if (removalError !== null && syncError !== null) {
    throw new AggregateError([removalError, syncError], "empty-directory removal and parent sync both failed");
  }
  if (removalError !== null) throw removalError;
  if (syncError !== null) throw syncError;
  return { ok: true, identity: actual, removed: !remainedNonempty };
}

function removeDirectoryTree(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
): Response {
  const actual = assertClaimedRoot(expected);
  assertStateDirectoryPath(segments);
  if (segments.length < 2) throw new Error("refusing to recursively remove a top-level state directory");
  if (!traverseDirectories(segments, directoryExpectations, false)) {
    return { ok: true, identity: actual, removed: false };
  }
  const targetExpected = directoryExpectations.at(-1);
  if (targetExpected === undefined || targetExpected === null) {
    throw new Error("directory-tree removal target expectation is missing");
  }
  const parentExpected = directoryExpectations.length === 1
    ? expected
    : directoryExpectations.at(-2);
  if (parentExpected === undefined || parentExpected === null) {
    throw new Error("directory-tree removal parent expectation is missing");
  }
  const name = segments.at(-1);
  if (name === undefined) throw new Error("directory-tree removal target is missing");

  process.chdir("..");
  assertCurrentDirectory(parentExpected);
  const stats = lstatSync(name, { bigint: true });
  assertPrivateDirectory(stats);
  if (!sameIdentity(identity(stats), targetExpected)) {
    throw new Error("directory-tree removal target changed identity after it was bound");
  }

  const quarantine = `.io-remove-tree-${process.pid}-${Date.now()}-${crypto.randomUUID().replaceAll("-", "")}.quarantine`;
  assertDirectoryAbsent(quarantine);
  renameSync(name, quarantine);
  const quarantinedStats = lstatSync(quarantine, { bigint: true });
  assertPrivateDirectory(quarantinedStats);
  if (!sameIdentity(identity(quarantinedStats), targetExpected)) {
    throw new Error("directory-tree removal quarantine has the wrong identity");
  }
  syncDirectory(".");

  let removalError: Error | null = null;
  try {
    rmSync(quarantine, { recursive: true, force: false, maxRetries: 0 });
  } catch (error) {
    removalError = error instanceof Error
      ? error
      : new Error("directory-tree removal failed with a non-error value", { cause: error });
  }
  let syncError: Error | null = null;
  try {
    syncDirectory(".");
  } catch (error) {
    syncError = error instanceof Error
      ? error
      : new Error("directory-tree parent sync failed with a non-error value", { cause: error });
  }
  if (removalError !== null && syncError !== null) {
    throw new AggregateError([removalError, syncError], "directory-tree removal and parent sync both failed");
  }
  if (removalError !== null) throw removalError;
  if (syncError !== null) throw syncError;
  return { ok: true, identity: actual, removed: true };
}

function directoryEntryKind(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): DirectoryEntry["kind"] {
  if (entry.isSymbolicLink()) return "symbolic-link";
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return "other";
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function assertSafeDirectoryEntryName(name: string): void {
  if (
    name === ""
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\uFFFD")
    || containsControlCharacter(name)
    || Buffer.byteLength(name, "utf8") > 255
  ) throw new Error("state directory contains an unsafe entry name");
}

function listDirectory(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  recoverOrphanedMutationClaims: boolean,
): Response {
  const actual = assertClaimedRoot(expected);
  assertStateDirectoryPath(segments);
  if (!traverseDirectories(segments, directoryExpectations, false)) {
    return { ok: true, identity: actual, entries: [] };
  }
  recoverDefinitelyOrphanedWriteTemporaries();
  recoverDefinitelyOrphanedStateMutationStages();
  if (recoverOrphanedMutationClaims) {
    recoverDefinitelyOrphanedStateMutationClaims();
  }
  const targetIdentity = currentPrivateDirectoryIdentity();
  const entries: DirectoryEntry[] = [];
  const directory = opendirSync(".");
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entries.length >= 10_000) throw new Error("state directory contains more than 10000 entries");
      assertSafeDirectoryEntryName(entry.name);
      const kind = directoryEntryKind(entry);
      if (kind !== "directory") {
        entries.push({ name: entry.name, kind });
        continue;
      }
      const descriptor = openBoundDirectory(entry.name);
      try {
        const stats = fstatSync(descriptor, { bigint: true });
        assertPrivateDirectory(stats);
        entries.push({ name: entry.name, kind, identity: identity(stats) });
      } finally {
        closeSync(descriptor);
      }
    }
  } finally {
    directory.closeSync();
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return { ok: true, identity: actual, entries, targetIdentity };
}

function invalidBatchFile(
  name: string,
  reason: BatchReadInvalidReason,
): BatchReadFileResult {
  return { name, status: "invalid", reason };
}

function applyBatchFileFaultForTest(
  name: string,
  index: number,
  requestId: string,
): void {
  if (index !== 0) return;
  if (batchReadFaultForTest === "remove-first-file-after-open") {
    unlinkSync(name);
    return;
  }
  if (batchReadFaultForTest === "replace-first-file-after-open") {
    const preserved = `.wrench-test-batch-file-${requestId}`;
    assertDirectoryAbsent(preserved);
    renameSync(name, preserved);
    writeFileSync(name, "replacement must not be returned\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
}

function readOneBatchFile(
  name: string,
  index: number,
  requestId: string,
  maximumBytes: number,
  remainingAggregateBytes: number,
): {
  readonly result: BatchReadFileResult;
  readonly contentBytes: number;
} {
  let descriptor: number;
  try {
    descriptor = openPrivateFileForRead(name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { result: { name, status: "absent" }, contentBytes: 0 };
    }
    return {
      result: invalidBatchFile(
        name,
        hasCode(error, "ELOOP") ? "unsafe-file" : "unreadable",
      ),
      contentBytes: 0,
    };
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || !ownedByCurrentUser(before)
      || (before.mode & 0o077n) !== 0n
    ) {
      return {
        result: invalidBatchFile(name, "unsafe-file"),
        contentBytes: 0,
      };
    }
    if (before.size > BigInt(maximumBytes)) {
      return {
        result: invalidBatchFile(name, "file-byte-bound"),
        contentBytes: 0,
      };
    }
    if (before.size > BigInt(remainingAggregateBytes)) {
      return {
        result: invalidBatchFile(name, "aggregate-byte-bound"),
        contentBytes: 0,
      };
    }
    applyBatchFileFaultForTest(name, index, requestId);
    const effectiveMaximum = Math.min(
      maximumBytes,
      remainingAggregateBytes,
    );
    let content: Buffer;
    try {
      content = readDescriptorBounded(descriptor, effectiveMaximum);
    } catch {
      return {
        result: invalidBatchFile(
          name,
          effectiveMaximum < maximumBytes
            ? "aggregate-byte-bound"
            : "file-byte-bound",
        ),
        contentBytes: 0,
      };
    }
    const after = fstatSync(descriptor, { bigint: true });
    let current: BigIntStats;
    try {
      current = lstatSync(name, { bigint: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return { result: { name, status: "absent" }, contentBytes: 0 };
      }
      return {
        result: invalidBatchFile(name, "unreadable"),
        contentBytes: 0,
      };
    }
    if (
      !sameIdentity(identity(before), identity(after))
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || before.mode !== after.mode
      || content.byteLength !== Number(after.size)
      || current.isSymbolicLink()
      || !current.isFile()
      || !sameIdentity(identity(after), identity(current))
      || current.size !== after.size
      || current.mtimeNs !== after.mtimeNs
      || current.ctimeNs !== after.ctimeNs
      || current.mode !== after.mode
    ) {
      return {
        result: invalidBatchFile(name, "changed-during-read"),
        contentBytes: 0,
      };
    }
    return {
      result: {
        name,
        status: "present",
        contentBase64: content.toString("base64"),
      },
      contentBytes: content.byteLength,
    };
  } catch {
    return {
      result: invalidBatchFile(name, "unreadable"),
      contentBytes: 0,
    };
  } finally {
    closeSync(descriptor);
  }
}

function replaceBoundBatchDirectoryForTest(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  requestId: string,
  targetIdentity: Identity,
): void {
  if (batchReadFaultForTest !== "replace-directory-after-bind") return;
  const targetName = segments.at(-1);
  const parentExpected = segments.length === 1
    ? expected
    : directoryExpectations.at(-2);
  if (
    targetName === undefined
    || parentExpected === undefined
    || parentExpected === null
  ) {
    throw new Error("batch directory fault injection is missing an identity");
  }
  process.chdir("..");
  assertCurrentDirectory(parentExpected);
  const preserved = `.wrench-test-batch-directory-${requestId}`;
  assertDirectoryAbsent(preserved);
  renameSync(targetName, preserved);
  mkdirSync(targetName, { mode: 0o700 });
  syncDirectory(".");
  process.chdir(preserved);
  assertCurrentDirectory(targetIdentity);
}

function batchReadFiles(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  names: readonly string[],
  maximumBytesPerFile: number,
  maximumTotalBytes: number,
  requestId: string,
): Response {
  const actual = assertClaimedRoot(expected);
  assertStateDirectoryPath(segments);
  if (!traverseDirectories(segments, directoryExpectations, false)) {
    throw new Error("batch state directory is absent");
  }
  const targetIdentity = currentPrivateDirectoryIdentity();
  replaceBoundBatchDirectoryForTest(
    expected,
    segments,
    directoryExpectations,
    requestId,
    targetIdentity,
  );
  const files: BatchReadFileResult[] = [];
  let contentBytes = 0;
  for (const [index, name] of names.entries()) {
    const read = readOneBatchFile(
      name,
      index,
      requestId,
      maximumBytesPerFile,
      maximumTotalBytes - contentBytes,
    );
    files.push(read.result);
    contentBytes += read.contentBytes;
  }
  return {
    ok: true,
    identity: actual,
    files,
    targetIdentity,
  };
}

function invalidBatchChildFile(
  file: BatchReadChildFile,
  reason: BatchReadInvalidReason,
): BatchReadChildFileResult {
  return {
    directoryName: file.directoryName,
    fileName: file.fileName,
    status: "invalid",
    reason,
  };
}

function readOneBatchChildFile(
  file: BatchReadChildFile,
  index: number,
  requestId: string,
  parentIdentity: Identity,
  maximumBytes: number,
  remainingAggregateBytes: number,
): {
  readonly result: BatchReadChildFileResult;
  readonly contentBytes: number;
} {
  let entered = false;
  let read: ReturnType<typeof readOneBatchFile> | null = null;
  try {
    const before = lstatSync(file.directoryName, { bigint: true });
    assertPrivateDirectory(before);
    if (!sameIdentity(identity(before), file.directoryIdentity)) {
      return {
        result: invalidBatchChildFile(file, "changed-during-read"),
        contentBytes: 0,
      };
    }
    process.chdir(file.directoryName);
    entered = true;
    assertCurrentDirectory(file.directoryIdentity);
    if (
      index === 0
      && batchReadFaultForTest === "replace-first-child-after-bind"
    ) {
      process.chdir("..");
      assertCurrentDirectory(parentIdentity);
      const preserved = `.wrench-test-batch-child-${requestId}`;
      assertDirectoryAbsent(preserved);
      renameSync(file.directoryName, preserved);
      mkdirSync(file.directoryName, { mode: 0o700 });
      process.chdir(preserved);
      assertCurrentDirectory(file.directoryIdentity);
    }
    read = readOneBatchFile(
      file.fileName,
      index,
      requestId,
      maximumBytes,
      remainingAggregateBytes,
    );
  } catch {
    return {
      result: invalidBatchChildFile(file, "unreadable"),
      contentBytes: 0,
    };
  } finally {
    if (entered) {
      process.chdir("..");
      assertCurrentDirectory(parentIdentity);
    }
  }

  let current: BigIntStats;
  try {
    current = lstatSync(file.directoryName, { bigint: true });
    assertPrivateDirectory(current);
  } catch {
    return {
      result: invalidBatchChildFile(file, "changed-during-read"),
      contentBytes: 0,
    };
  }
  if (!sameIdentity(identity(current), file.directoryIdentity)) {
    return {
      result: invalidBatchChildFile(file, "changed-during-read"),
      contentBytes: 0,
    };
  }
  if (read === null) {
    return {
      result: invalidBatchChildFile(file, "unreadable"),
      contentBytes: 0,
    };
  }
  if (read.result.status === "present") {
    return {
      result: {
        directoryName: file.directoryName,
        fileName: file.fileName,
        status: "present",
        contentBase64: read.result.contentBase64,
      },
      contentBytes: read.contentBytes,
    };
  }
  if (read.result.status === "absent") {
    return {
      result: {
        directoryName: file.directoryName,
        fileName: file.fileName,
        status: "absent",
      },
      contentBytes: 0,
    };
  }
  return {
    result: invalidBatchChildFile(file, read.result.reason),
    contentBytes: 0,
  };
}

function batchReadChildFiles(
  expected: Identity,
  segments: readonly string[],
  directoryExpectations: readonly DirectoryExpectation[],
  requestedFiles: readonly BatchReadChildFile[],
  maximumBytesPerFile: number,
  maximumTotalBytes: number,
  requestId: string,
): Response {
  const actual = assertClaimedRoot(expected);
  assertStateDirectoryPath(segments);
  if (!traverseDirectories(segments, directoryExpectations, false)) {
    throw new Error("batch child-file parent directory is absent");
  }
  const targetIdentity = currentPrivateDirectoryIdentity();
  replaceBoundBatchDirectoryForTest(
    expected,
    segments,
    directoryExpectations,
    requestId,
    targetIdentity,
  );
  const childFiles: BatchReadChildFileResult[] = [];
  let contentBytes = 0;
  for (const [index, file] of requestedFiles.entries()) {
    const read = readOneBatchChildFile(
      file,
      index,
      requestId,
      targetIdentity,
      maximumBytesPerFile,
      maximumTotalBytes - contentBytes,
    );
    childFiles.push(read.result);
    contentBytes += read.contentBytes;
  }
  return {
    ok: true,
    identity: actual,
    childFiles,
    targetIdentity,
  };
}

function execute(request: Request): Response {
  const operation = request.operation;
  if (operation.kind === "claim") return claim(request.expected);
  if (operation.kind === "create-root") return createRoot(request.expected, operation.segments);
  if (operation.kind === "ensure-directories") {
    const actual = assertClaimedRoot(request.expected);
    traverseDirectories(operation.segments, operation.directoryExpectations, true);
    return { ok: true, identity: actual, targetIdentity: currentPrivateDirectoryIdentity() };
  }
  if (operation.kind === "read-file") {
    return readFile(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.maximumBytes,
    );
  }
  if (operation.kind === "read-file-if-present") {
    return readFileIfPresent(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.maximumBytes,
    );
  }
  if (operation.kind === "batch-read-files") {
    return batchReadFiles(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.names,
      operation.maximumBytesPerFile,
      operation.maximumTotalBytes,
      request.requestId,
    );
  }
  if (operation.kind === "batch-read-child-files") {
    return batchReadChildFiles(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.files,
      operation.maximumBytesPerFile,
      operation.maximumTotalBytes,
      request.requestId,
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
  if (operation.kind === "remove-file") {
    return removeFile(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      request.requestId,
    );
  }
  if (operation.kind === "remove-file-if-unchanged") {
    return removeFileIfUnchanged(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.expectedContentSha256,
      request.requestId,
    );
  }
  if (operation.kind === "create-directory") {
    return createDirectory(request.expected, operation.segments, operation.directoryExpectations);
  }
  if (operation.kind === "remove-empty-directory") {
    return removeEmptyDirectory(request.expected, operation.segments, operation.directoryExpectations, request.requestId);
  }
  if (operation.kind === "list-directory") {
    return listDirectory(
      request.expected,
      operation.segments,
      operation.directoryExpectations,
      operation.recoverOrphanedMutationClaims,
    );
  }
  return removeDirectoryTree(request.expected, operation.segments, operation.directoryExpectations);
}

function main(): void {
  const request = parseRequest(JSON.parse(readBoundedStdin()) as unknown);
  if (
    (
      request.operation.kind === "batch-read-files"
      || request.operation.kind === "batch-read-child-files"
    )
    && batchReadFaultForTest === "malformed-response"
  ) {
    process.stdout.write('{"files":"malformed","identity":null,"ok":true}\n');
    return;
  }
  const encoded = `${JSON.stringify(execute(request))}\n`;
  if (
    (
      request.operation.kind === "batch-read-files"
      || request.operation.kind === "batch-read-child-files"
    )
    && Buffer.byteLength(encoded, "utf8") > MAX_BATCH_STDOUT_BYTES
  ) {
    throw new Error("batch response exceeds its stdout byte bound");
  }
  process.stdout.write(encoded);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`state helper: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  }
}
