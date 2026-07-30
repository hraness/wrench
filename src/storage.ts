import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  manifestHash,
  parseDiagnosticManifest,
  parseRuntimeManifest,
  sha256,
  type ParseResult,
  type WrenchManifest,
} from "./model";
import {
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
} from "./process-identity";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";

function requireManifestRegistry(
  registry: ProviderPluginRegistry | undefined,
): ProviderPluginRegistry {
  if (registry === undefined) {
    throw new Error("manifest validation requires an explicit provider plugin registry");
  }
  return registry;
}

export const MAX_WRENCH_JSON_BYTES = 1024 * 1024;
export const MAX_PRIVATE_STATE_BATCH_FILES = 1_000;
export const MAX_PRIVATE_STATE_BATCH_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PRIVATE_STATE_BATCH_NAME_BYTES = 256 * 1024;
const MAX_PRIVATE_STATE_BATCH_STDOUT_BYTES = 96 * 1024 * 1024;
const TEST_STATE_HELPER_TIMEOUT_MS = 120_000;

export interface PrivateDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

type StateRootIdentity = PrivateDirectoryIdentity;

type StateDirectoryExpectation = StateRootIdentity | null;

type EmptyDirectoryRemovalRaceForTest =
  | "insert-after-quarantine"
  | "replace-target-after-validation";
type PrivateStateBatchReadFaultForTest =
  | "malformed-response"
  | "remove-first-file-after-open"
  | "replace-first-file-after-open"
  | "replace-first-child-after-bind"
  | "replace-directory-after-bind";
type PrivateStateCasFaultForTest = "pause-after-cas-claim";
type StateHelperFaultForTest =
  | EmptyDirectoryRemovalRaceForTest
  | PrivateStateBatchReadFaultForTest
  | PrivateStateCasFaultForTest;

interface StateRootRecord {
  readonly claimed: boolean;
  readonly creationAnchor: {
    readonly identity: StateRootIdentity;
    readonly path: string;
    readonly segments: readonly string[];
  } | null;
  readonly identity: StateRootIdentity | null;
}

const knownStateRoots = new Map<string, StateRootRecord>();
const stateDirectoryNames = [
  "adapter-generations",
  "adapters",
  "auth",
  "browser-snapshots",
  "derivations",
  "idempotency",
  "linked-device-stores",
  "plan-assets",
  "plans",
  "provider-plugin-state",
  "provider-plugins",
  "recovery",
  "run-journals",
  "runs",
  "session-secrets",
  "tools",
] as const;
const stateMarkerName = ".io-state.json";
const stateMarkerText = '{"kind":"io-state","schemaVersion":1}\n';
const stateHelperPath = join(dirname(fileURLToPath(import.meta.url)), "state-helper.ts");
const stateHelperConfigPath = join(dirname(fileURLToPath(import.meta.url)), "state-helper.bunfig.toml");
const pathHelperPath = join(dirname(fileURLToPath(import.meta.url)), "path-helper.ts");
const wrenchSourcePackageRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

function isWithinPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    );
}

type StateHelperOperation =
  | { readonly kind: "claim" }
  | { readonly kind: "create-root"; readonly segments: readonly string[] }
  | {
      readonly kind: "ensure-directories";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
    }
  | {
      readonly kind: "read-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly maximumBytes: number;
    }
  | {
      readonly kind: "read-file-if-present";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly maximumBytes: number;
    }
  | {
      readonly kind: "batch-read-files";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly names: readonly string[];
      readonly maximumBytesPerFile: number;
      readonly maximumTotalBytes: number;
    }
  | {
      readonly kind: "batch-read-child-files";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly files: readonly {
        readonly directoryName: string;
        readonly directoryIdentity: PrivateDirectoryIdentity;
        readonly fileName: string;
      }[];
      readonly maximumBytesPerFile: number;
      readonly maximumTotalBytes: number;
    }
  | {
      readonly kind: "write-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly content: string;
      readonly createOnly: boolean;
      readonly expectedContentSha256: string | null;
    }
  | {
      readonly kind: "create-directory";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
    }
  | {
      readonly kind: "remove-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
    }
  | {
      readonly kind: "remove-file-if-unchanged";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly expectedContentSha256: string;
    }
  | {
      readonly kind: "remove-empty-directory";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
    }
  | {
      readonly kind: "list-directory";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
    }
  | {
      readonly kind: "remove-directory-tree";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
    };

export type PrivateStateDirectoryEntry = {
  readonly name: string;
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly identity?: PrivateDirectoryIdentity;
};

export type PrivateStateDirectorySnapshot = {
  readonly identity: PrivateDirectoryIdentity | null;
  readonly entries: readonly PrivateStateDirectoryEntry[];
};

export type PrivateStateBatchReadInvalidReason =
  | StateHelperBatchReadInvalidReason
  | "invalid-utf8";

export type PrivateStateBatchReadResult =
  | {
      readonly name: string;
      readonly status: "present";
      readonly content: string;
    }
  | {
      readonly name: string;
      readonly status: "absent";
    }
  | {
      readonly name: string;
      readonly status: "invalid";
      readonly reason: PrivateStateBatchReadInvalidReason;
    };

export type PrivateStateBatchChildFile = {
  readonly directoryName: string;
  readonly directoryIdentity: PrivateDirectoryIdentity;
  readonly fileName: string;
};

export type PrivateStateBatchChildReadResult =
  | {
      readonly directoryName: string;
      readonly fileName: string;
      readonly status: "present";
      readonly content: string;
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
      readonly reason: PrivateStateBatchReadInvalidReason;
    };

type StateHelperBatchReadInvalidReason =
  | "unsafe-file"
  | "unreadable"
  | "file-byte-bound"
  | "aggregate-byte-bound"
  | "changed-during-read";
type StateHelperBatchReadFile =
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
      readonly reason: StateHelperBatchReadInvalidReason;
    };
type StateHelperBatchChildReadFile =
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
      readonly reason: StateHelperBatchReadInvalidReason;
    };

interface StateHelperResponse {
  readonly ok: true;
  readonly identity: StateRootIdentity;
  readonly created?: boolean;
  readonly removed?: boolean;
  readonly present?: boolean;
  readonly contentBase64?: string;
  readonly entries?: readonly PrivateStateDirectoryEntry[];
  readonly files?: readonly StateHelperBatchReadFile[];
  readonly childFiles?: readonly StateHelperBatchChildReadFile[];
  readonly targetIdentity?: PrivateDirectoryIdentity;
}

type PathHelperOperation =
  | {
      readonly kind: "ensure-directories";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly requireFinalPrivate: boolean;
    }
  | {
      readonly kind: "read-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly maximumBytes: number;
    }
  | {
      readonly kind: "write-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
      readonly content: string;
      readonly createOnly: boolean;
    }
  | {
      readonly kind: "remove-directory-tree";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly StateDirectoryExpectation[];
    };

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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

function pathInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function stateRootFor(path: string): string | null {
  const lexicalTarget = resolve(path);
  let selected: string | null = null;
  for (const root of knownStateRoots.keys()) {
    if (pathInside(root, lexicalTarget) && (selected === null || root.length > selected.length)) selected = root;
  }
  if (selected !== null) return selected;
  const target = canonicalNonStatePath(path);
  for (const root of knownStateRoots.keys()) {
    if (pathInside(root, target) && (selected === null || root.length > selected.length)) selected = root;
  }
  return selected;
}

function sameIdentity(left: StateRootIdentity | null, right: StateRootIdentity | null): boolean {
  return left === null || right === null
    ? left === right
    : left.device === right.device && left.inode === right.inode;
}

function exactObjectKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayAtRuntime(value: unknown): boolean {
  return Array.isArray(value);
}

function isSafeBatchFileName(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value === ""
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\uFFFD")
    || Buffer.byteLength(value, "utf8") > 255
  ) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return false;
    }
  }
  return true;
}

function decodeCanonicalBase64(
  value: unknown,
  maximumBytes: number,
): Buffer | null {
  if (
    typeof value !== "string"
    || value.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength <= maximumBytes
    && decoded.toString("base64") === value
    ? decoded
    : null;
}

function parseStateHelperBatchFiles(value: unknown): readonly StateHelperBatchReadFile[] {
  if (!Array.isArray(value) || value.length > MAX_PRIVATE_STATE_BATCH_FILES) {
    throw new Error("state helper returned a malformed response");
  }
  const names = new Set<string>();
  const files: StateHelperBatchReadFile[] = [];
  let contentBytes = 0;
  const invalidReasons = new Set<StateHelperBatchReadInvalidReason>([
    "unsafe-file",
    "unreadable",
    "file-byte-bound",
    "aggregate-byte-bound",
    "changed-during-read",
  ]);
  for (const candidate of value) {
    if (!isRecord(candidate) || !isSafeBatchFileName(candidate.name)) {
      throw new Error("state helper returned a malformed response");
    }
    const name = candidate.name;
    if (names.has(name)) {
      throw new Error("state helper returned a malformed response");
    }
    names.add(name);
    if (
      candidate.status === "present"
      && exactObjectKeys(candidate, ["name", "status", "contentBase64"])
    ) {
      const content = decodeCanonicalBase64(
        candidate.contentBase64,
        MAX_PRIVATE_STATE_BATCH_FILE_BYTES,
      );
      if (content === null) {
        throw new Error("state helper returned a malformed response");
      }
      contentBytes += content.byteLength;
      if (contentBytes > MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES) {
        throw new Error("state helper returned a malformed response");
      }
      files.push({
        name,
        status: "present",
        contentBase64: candidate.contentBase64 as string,
      });
      continue;
    }
    if (
      candidate.status === "absent"
      && exactObjectKeys(candidate, ["name", "status"])
    ) {
      files.push({ name, status: "absent" });
      continue;
    }
    if (
      candidate.status === "invalid"
      && exactObjectKeys(candidate, ["name", "status", "reason"])
      && invalidReasons.has(candidate.reason as StateHelperBatchReadInvalidReason)
    ) {
      files.push({
        name,
        status: "invalid",
        reason: candidate.reason as StateHelperBatchReadInvalidReason,
      });
      continue;
    }
    throw new Error("state helper returned a malformed response");
  }
  return files;
}

function parseStateHelperBatchChildFiles(
  value: unknown,
): readonly StateHelperBatchChildReadFile[] {
  if (!Array.isArray(value) || value.length > MAX_PRIVATE_STATE_BATCH_FILES) {
    throw new Error("state helper returned a malformed response");
  }
  const keys = new Set<string>();
  const files: StateHelperBatchChildReadFile[] = [];
  let contentBytes = 0;
  const invalidReasons = new Set<StateHelperBatchReadInvalidReason>([
    "unsafe-file",
    "unreadable",
    "file-byte-bound",
    "aggregate-byte-bound",
    "changed-during-read",
  ]);
  for (const candidate of value) {
    if (
      !isRecord(candidate)
      || !isSafeBatchFileName(candidate.directoryName)
      || !isSafeBatchFileName(candidate.fileName)
    ) {
      throw new Error("state helper returned a malformed response");
    }
    const directoryName = candidate.directoryName;
    const fileName = candidate.fileName;
    const key = `${directoryName}\u0000${fileName}`;
    if (keys.has(key)) {
      throw new Error("state helper returned a malformed response");
    }
    keys.add(key);
    if (
      candidate.status === "present"
      && exactObjectKeys(candidate, [
        "directoryName",
        "fileName",
        "status",
        "contentBase64",
      ])
    ) {
      const content = decodeCanonicalBase64(
        candidate.contentBase64,
        MAX_PRIVATE_STATE_BATCH_FILE_BYTES,
      );
      if (content === null) {
        throw new Error("state helper returned a malformed response");
      }
      contentBytes += content.byteLength;
      if (contentBytes > MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES) {
        throw new Error("state helper returned a malformed response");
      }
      files.push({
        directoryName,
        fileName,
        status: "present",
        contentBase64: candidate.contentBase64 as string,
      });
      continue;
    }
    if (
      candidate.status === "absent"
      && exactObjectKeys(candidate, [
        "directoryName",
        "fileName",
        "status",
      ])
    ) {
      files.push({ directoryName, fileName, status: "absent" });
      continue;
    }
    if (
      candidate.status === "invalid"
      && exactObjectKeys(candidate, [
        "directoryName",
        "fileName",
        "status",
        "reason",
      ])
      && invalidReasons.has(
        candidate.reason as StateHelperBatchReadInvalidReason,
      )
    ) {
      files.push({
        directoryName,
        fileName,
        status: "invalid",
        reason: candidate.reason as StateHelperBatchReadInvalidReason,
      });
      continue;
    }
    throw new Error("state helper returned a malformed response");
  }
  return files;
}

function parseResponseIdentity(value: unknown): PrivateDirectoryIdentity | null {
  if (
    !isRecord(value)
    || !exactObjectKeys(value, ["device", "inode"])
    || typeof value.device !== "string"
    || !/^\d{1,40}$/u.test(value.device)
    || typeof value.inode !== "string"
    || !/^\d{1,40}$/u.test(value.inode)
  ) return null;
  return { device: value.device, inode: value.inode };
}

function parseStateHelperResponse(value: unknown): StateHelperResponse {
  if (!isRecord(value) || !exactObjectKeys(
    value,
    ["ok", "identity"],
    ["created", "removed", "present", "contentBase64", "entries", "files", "childFiles", "targetIdentity"],
  )) {
    throw new Error("state helper returned a malformed response");
  }
  const identityValue = value.identity;
  const parsedIdentity = parseResponseIdentity(identityValue);
  if (value.ok !== true || parsedIdentity === null) throw new Error("state helper returned a malformed response");
  const created = value.created;
  const removed = value.removed;
  const present = value.present;
  const contentBase64 = value.contentBase64;
  const entries = value.entries;
  const files = value.files;
  const childFiles = value.childFiles;
  const targetIdentityValue = value.targetIdentity;
  const targetIdentity = targetIdentityValue === undefined ? undefined : parseResponseIdentity(targetIdentityValue);
  if (created !== undefined && typeof created !== "boolean") throw new Error("state helper returned a malformed response");
  if (removed !== undefined && typeof removed !== "boolean") throw new Error("state helper returned a malformed response");
  if (present !== undefined && typeof present !== "boolean") throw new Error("state helper returned a malformed response");
  if (contentBase64 !== undefined && typeof contentBase64 !== "string") throw new Error("state helper returned a malformed response");
  if (targetIdentityValue !== undefined && targetIdentity === null) {
    throw new Error("state helper returned a malformed response");
  }
  const responseShape = Object.keys(value)
    .filter((key) => key !== "ok" && key !== "identity")
    .sort()
    .join(",");
  if (!new Set([
    "",
    "contentBase64",
    "contentBase64,present",
    "created",
    "created,targetIdentity",
    "entries",
    "entries,targetIdentity",
    "childFiles,targetIdentity",
    "files,targetIdentity",
    "present",
    "removed",
    "targetIdentity",
  ]).has(responseShape)) throw new Error("state helper returned a malformed response");
  if ((present === true) !== (responseShape === "contentBase64,present")) {
    if (present !== undefined) throw new Error("state helper returned a malformed response");
  }
  if (
    entries !== undefined
    && (
      !Array.isArray(entries)
      || entries.length > 10_000
      || entries.some((entry) => (
        !isRecord(entry)
        || !exactObjectKeys(entry, ["name", "kind"], ["identity"])
        || typeof entry.name !== "string"
        || entry.name === ""
        || entry.name === "."
        || entry.name === ".."
        || entry.name.includes("/")
        || entry.name.includes("\\")
        || entry.name.includes("\u0000")
        || Buffer.byteLength(entry.name, "utf8") > 255
        || (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symbolic-link" && entry.kind !== "other")
        || (entry.kind === "directory") !== (parseResponseIdentity(entry.identity) !== null)
      ))
    )
  ) throw new Error("state helper returned a malformed response");
  const parsedFiles = files === undefined
    ? undefined
    : parseStateHelperBatchFiles(files);
  const parsedChildFiles = childFiles === undefined
    ? undefined
    : parseStateHelperBatchChildFiles(childFiles);
  return {
    ok: true,
    identity: parsedIdentity,
    ...(created === undefined ? {} : { created }),
    ...(removed === undefined ? {} : { removed }),
    ...(present === undefined ? {} : { present }),
    ...(contentBase64 === undefined ? {} : { contentBase64 }),
    ...(entries === undefined ? {} : { entries: entries as PrivateStateDirectoryEntry[] }),
    ...(parsedFiles === undefined ? {} : { files: parsedFiles }),
    ...(parsedChildFiles === undefined ? {} : { childFiles: parsedChildFiles }),
    ...(targetIdentity === undefined || targetIdentity === null ? {} : { targetIdentity }),
  };
}

function runStateHelper(
  directory: string,
  expected: StateRootIdentity,
  operation: StateHelperOperation,
  expectCreatedIdentity = false,
  faultForTest?: StateHelperFaultForTest,
): StateHelperResponse {
  // Generate before cwd binding so deterministic fault injection can force the
  // exact pre-spawn swap that the helper must reject without touching it.
  const requestId = crypto.randomUUID();
  const child = spawnSync(process.execPath, [
    "--no-env-file",
    "--no-install",
    "--no-macros",
    "--no-addons",
    `--config=${stateHelperConfigPath}`,
    stateHelperPath,
  ], {
    cwd: directory,
    encoding: "utf8",
    env: faultForTest === undefined
      ? { NODE_ENV: "production" }
      : {
          NODE_ENV: "test",
          ...(faultForTest === "insert-after-quarantine"
            || faultForTest === "replace-target-after-validation"
            ? { WRENCH_TEST_EMPTY_DIRECTORY_REMOVAL_RACE: faultForTest }
            : faultForTest === "pause-after-cas-claim"
              ? { WRENCH_TEST_CAS_FAULT: faultForTest }
              : { WRENCH_TEST_BATCH_READ_FAULT: faultForTest }),
        },
    input: JSON.stringify({ schemaVersion: 1, requestId, expected, operation }),
    maxBuffer: operation.kind === "batch-read-files"
      || operation.kind === "batch-read-child-files"
      ? MAX_PRIVATE_STATE_BATCH_STDOUT_BYTES
      : 180 * 1024 * 1024,
    shell: false,
    timeout: faultForTest === "pause-after-cas-claim"
      ? TEST_STATE_HELPER_TIMEOUT_MS
      : 30_000,
    windowsHide: true,
  });
  const current = inspectRealDirectoryIdentity(directory);
  if (!sameIdentity(current, expected)) throw new Error(`WRENCH_STATE_HOME changed identity after validation: ${directory}`);
  if (child.error !== undefined) throw new Error("bound state helper failed to start", { cause: child.error });
  if (child.status !== 0) {
    const detail = child.stderr.trim().slice(0, 512);
    throw new Error(detail === "" ? "bound state helper rejected the operation" : detail);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(child.stdout) as unknown;
  } catch (error) {
    throw new Error("state helper returned invalid JSON", { cause: error });
  }
  const response = parseStateHelperResponse(parsed);
  if (!expectCreatedIdentity && !sameIdentity(response.identity, expected)) {
    throw new Error("state helper response came from the wrong directory identity");
  }
  return response;
}

function runPathHelper(
  directory: string,
  expected: StateRootIdentity,
  operation: PathHelperOperation,
): StateHelperResponse {
  const requestId = crypto.randomUUID();
  const child = spawnSync(process.execPath, [
    "--no-env-file",
    "--no-install",
    "--no-macros",
    "--no-addons",
    `--config=${stateHelperConfigPath}`,
    pathHelperPath,
  ], {
    cwd: directory,
    encoding: "utf8",
    env: { NODE_ENV: "production" },
    input: JSON.stringify({ schemaVersion: 1, requestId, expected, operation }),
    maxBuffer: 180 * 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  const current = inspectRealDirectoryIdentity(directory);
  if (!sameIdentity(current, expected)) throw new Error(`bound path root changed identity after validation: ${directory}`);
  if (child.error !== undefined) throw new Error("bound path helper failed to start", { cause: child.error });
  if (child.status !== 0) {
    const detail = child.stderr.trim().slice(0, 512);
    throw new Error(detail === "" ? "bound path helper rejected the operation" : detail);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(child.stdout) as unknown;
  } catch (error) {
    throw new Error("path helper returned invalid JSON", { cause: error });
  }
  const response = parseStateHelperResponse(parsed);
  if (!sameIdentity(response.identity, expected)) throw new Error("path helper response came from the wrong directory identity");
  return response;
}

function stateSegments(root: string, path: string): readonly string[] {
  const child = relative(root, canonicalNonStatePath(path));
  if (child === "") return [];
  if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) throw new Error(`state path escapes its root: ${path}`);
  return child.split(sep);
}

/**
 * Snapshot every existing directory identity before the helper process is
 * spawned. The helper replays this chain from its inode-bound cwd, so a rename
 * or replacement at any depth is rejected before the requested mutation.
 */
function captureStateDirectoryExpectations(
  root: string,
  segments: readonly string[],
): readonly StateDirectoryExpectation[] {
  const expectations: StateDirectoryExpectation[] = [];
  let current = root;
  let missing = false;
  for (const segment of segments) {
    current = join(current, segment);
    if (missing) {
      expectations.push(null);
      continue;
    }
    let stats: BigIntStats;
    try {
      stats = lstatSync(current, { bigint: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      missing = true;
      expectations.push(null);
      continue;
    }
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || !ownedByCurrentUser(stats)
      || (stats.mode & 0o777n) !== 0o700n
    ) {
      throw new Error(`wrench state directory must be an owned real directory with mode 0700: ${current}`);
    }
    expectations.push({ device: stats.dev.toString(), inode: stats.ino.toString() });
  }
  return expectations;
}

function inspectStateRootIdentity(root: string): StateRootIdentity | null {
  let stats: BigIntStats;
  try {
    stats = lstatSync(root, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || !ownedByCurrentUser(stats)) {
    throw new Error(`WRENCH_STATE_HOME must be an owned real directory: ${root}`);
  }
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function inspectRealDirectoryIdentity(path: string): StateRootIdentity | null {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`path must be a real directory: ${path}`);
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function findCreationAnchor(root: string): NonNullable<StateRootRecord["creationAnchor"]> {
  const segments: string[] = [];
  let current = root;
  for (;;) {
    let stats: BigIntStats;
    try {
      stats = lstatSync(current, { bigint: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`WRENCH_STATE_HOME has no real existing creation anchor: ${root}`);
      segments.unshift(basename(current));
      current = parent;
      continue;
    }
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || !ownedByCurrentUser(stats)
      || (stats.mode & 0o022n) !== 0n
    ) {
      throw new Error(`WRENCH_STATE_HOME creation path contains a non-owned real directory: ${current}`);
    }
    return {
      identity: { device: stats.dev.toString(), inode: stats.ino.toString() },
      path: current,
      segments,
    };
  }
}

function assertStateRootIdentity(root: string): StateRootRecord {
  const expected = knownStateRoots.get(root);
  if (expected === undefined) throw new Error(`wrench state root has not been validated: ${root}`);
  const actual = inspectStateRootIdentity(root);
  if (!sameIdentity(actual, expected.identity)) {
    throw new Error(`WRENCH_STATE_HOME changed identity after validation: ${root}`);
  }
  if (expected.identity === null) {
    const anchor = findCreationAnchor(root);
    if (
      expected.creationAnchor === null
      || anchor.path !== expected.creationAnchor.path
      || !sameIdentity(anchor.identity, expected.creationAnchor.identity)
      || anchor.segments.join("\u0000") !== expected.creationAnchor.segments.join("\u0000")
    ) throw new Error(`WRENCH_STATE_HOME creation path changed after validation: ${root}`);
  }
  if (expected.claimed) {
    if (actual === null) throw new Error(`WRENCH_STATE_HOME disappeared after validation: ${root}`);
    const stats = lstatSync(root);
    if ((stats.mode & 0o777) !== 0o700) throw new Error(`WRENCH_STATE_HOME must remain private (mode 0700): ${root}`);
    readStateMarker(join(root, stateMarkerName));
  }
  return expected;
}

function assertNoSymbolicLinks(
  root: string,
  target: string,
  includeTarget: boolean,
  requirePrivateDirectories = false,
): void {
  const canonicalRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (!pathInside(canonicalRoot, absoluteTarget)) throw new Error(`state path escapes its root: ${absoluteTarget}`);
  const checkedTarget = includeTarget ? absoluteTarget : dirname(absoluteTarget);
  const child = relative(canonicalRoot, checkedTarget);
  const components = child === "" ? [] : child.split(sep);
  let current = canonicalRoot;
  const paths = [current, ...components.map((component) => {
    current = join(current, component);
    return current;
  })];
  for (const [index, path] of paths.entries()) {
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`wrench state path contains a symbolic link: ${path}`);
    if (stats.isDirectory() && requirePrivateDirectories && (!ownedByCurrentUser(stats) || (stats.mode & 0o777) !== 0o700)) {
      throw new Error(`wrench state directory must be owned and private (mode 0700): ${path}`);
    }
    if (index < paths.length - 1 && !stats.isDirectory()) {
      throw new Error(`wrench state ancestor is not a directory: ${path}`);
    }
  }
}

function assertKnownStatePath(path: string, includeTarget: boolean): void {
  const root = stateRootFor(path);
  if (root !== null) {
    assertStateRootIdentity(root);
    assertNoSymbolicLinks(root, path, includeTarget, true);
    assertStateRootIdentity(root);
  }
}

/** Refuse a state path whose existing components below the canonical state root contain a symlink. */
export function assertSafeStatePath(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  includeTarget = true,
): void {
  const root = wrenchStateHome(environment);
  assertStateRootIdentity(root);
  assertNoSymbolicLinks(root, path, includeTarget, true);
  assertStateRootIdentity(root);
}

function canonicalPotentialPath(value: string): string {
  const suffix: string[] = [];
  let ancestor = resolve(value);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`path has no existing ancestor: ${value}`);
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
    ancestor = parent;
  }
  const stats = lstatSync(ancestor);
  if (stats.isSymbolicLink()) return resolve(realpathSync(ancestor), ...suffix);
  return resolve(realpathSync(ancestor), ...suffix);
}

function ownedByCurrentUser(stats: { readonly uid: number | bigint }): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return currentUid === undefined || stats.uid === (typeof stats.uid === "bigint" ? BigInt(currentUid) : currentUid);
}

function readStateMarker(path: string): void {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > 256 || !ownedByCurrentUser(stats) || (stats.mode & 0o077) !== 0) {
      throw new Error("wrench state marker must be a private, owned regular file");
    }
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(readDescriptorBounded(descriptor, 256));
    if (content !== stateMarkerText) throw new Error("wrench state marker is malformed");
    const value = JSON.parse(content) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "kind,schemaVersion"
      || !("schemaVersion" in value)
      || value.schemaVersion !== 1
      || !("kind" in value)
      || value.kind !== "io-state"
    ) throw new Error("wrench state marker is malformed");
  } finally {
    closeSync(descriptor);
  }
}

function hasWrenchPathIdentity(path: string): boolean {
  return resolve(path)
    .split(sep)
    .filter((segment) => segment !== "")
    .slice(-3)
    .some((segment) =>
      /(?:^|[^a-z0-9])(?:wrench|oh|io)(?:[^a-z0-9]|$)/iu.test(segment),
    );
}

function validateUnmarkedStateRoot(root: string): boolean {
  if (!hasWrenchPathIdentity(root)) {
    throw new Error(`WRENCH_STATE_HOME is not marked as wrench-owned and its path does not identify dedicated wrench state: ${root}`);
  }
  const allowed = new Set<string>([
    ...stateDirectoryNames,
    ".cursor-encryption-key",
    ".plan-encryption-key",
    ".recovery-encryption-key",
    ".session-encryption-key",
  ]);
  const entries: Dirent<string>[] = [];
  const directory = opendirSync(root);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entries.length >= 10_000) throw new Error("WRENCH_STATE_HOME contains more than 10000 entries");
      if (entry.name.includes("\uFFFD") || Buffer.byteLength(entry.name, "utf8") > 255) {
        throw new Error("WRENCH_STATE_HOME contains an unsafe entry name");
      }
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`WRENCH_STATE_HOME contains a symbolic link: ${join(root, entry.name)}`);
    if (/^\.io-state\.stage-\d+-[0-9a-f-]{36}\.json$/u.test(entry.name)) {
      const stats = lstatSync(join(root, entry.name));
      if (!stats.isFile() || !ownedByCurrentUser(stats) || (stats.mode & 0o077) !== 0 || stats.size > 256) {
        throw new Error(`WRENCH_STATE_HOME contains an invalid interrupted state-marker stage: ${entry.name}`);
      }
      continue;
    }
    if (!allowed.has(entry.name)) {
      throw new Error(`WRENCH_STATE_HOME is not an empty or recognizable dedicated wrench state directory: ${root}`);
    }
    if (stateDirectoryNames.includes(entry.name as typeof stateDirectoryNames[number]) && !entry.isDirectory()) {
      throw new Error(`WRENCH_STATE_HOME contains an invalid state entry: ${entry.name}`);
    }
    if (
      (
        entry.name === ".plan-encryption-key"
        || entry.name === ".cursor-encryption-key"
        || entry.name === ".recovery-encryption-key"
        || entry.name === ".session-encryption-key"
      )
      && !entry.isFile()
    ) {
      throw new Error("WRENCH_STATE_HOME contains an invalid encryption key entry");
    }
    const stats = lstatSync(join(root, entry.name));
    const hasPrivateMode = entry.isDirectory()
      ? (stats.mode & 0o777) === 0o700
      : (stats.mode & 0o077) === 0;
    if (!ownedByCurrentUser(stats) || !hasPrivateMode) {
      throw new Error(`WRENCH_STATE_HOME contains a state entry that is not owned and private: ${entry.name}`);
    }
  }
  return entries.length > 0;
}

function validateStateRoot(root: string): StateRootRecord {
  if (!existsSync(root)) return { claimed: false, creationAnchor: findCreationAnchor(root), identity: null };
  const stats = lstatSync(root, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || !ownedByCurrentUser(stats)) {
    throw new Error(`WRENCH_STATE_HOME must be an owned real directory: ${root}`);
  }
  const marker = join(root, stateMarkerName);
  const claimed = existsSync(marker);
  const hasUnmarkedState = claimed ? false : validateUnmarkedStateRoot(root);
  if (claimed) readStateMarker(marker);
  if (!claimed && !hasUnmarkedState && (stats.mode & 0o022n) !== 0n) {
    throw new Error(`an unclaimed WRENCH_STATE_HOME must not be group/world-writable: ${root}`);
  }
  if ((claimed || hasUnmarkedState) && (stats.mode & 0o777n) !== 0o700n) {
    throw new Error(`WRENCH_STATE_HOME must be private (mode 0700) before trusted state is read: ${root}`);
  }
  return { claimed, creationAnchor: null, identity: { device: stats.dev.toString(), inode: stats.ino.toString() } };
}

export function wrenchStateHome(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const configuredRoots = [
    ["WRENCH_STATE_HOME", environment.WRENCH_STATE_HOME],
    ["OH_STATE_HOME", environment.OH_STATE_HOME],
    ["IO_HOME", environment.IO_HOME],
  ] as const satisfies readonly (readonly [string, string | undefined])[];
  const requestedRoots = configuredRoots.flatMap(([name, value]) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? [] : [{ name, root: canonicalPotentialPath(trimmed) }];
  });
  const distinctRequestedRoots = new Set(requestedRoots.map(({ root }) => root));
  if (distinctRequestedRoots.size > 1) {
    throw new Error(
      `${requestedRoots.map(({ name }) => name).join(", ")} select different state roots`,
    );
  }
  const dataRoot = environment.XDG_DATA_HOME !== undefined
      && environment.XDG_DATA_HOME.trim() !== ""
    ? resolve(environment.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
  const currentDefault = canonicalPotentialPath(join(dataRoot, "wrench"));
  const legacyDefaults = [
    canonicalPotentialPath(join(dataRoot, "oh")),
    canonicalPotentialPath(join(dataRoot, "io")),
  ] as const;
  let root = requestedRoots[0]?.root ?? null;
  if (root === null) {
    const existingDefaults = [currentDefault, ...legacyDefaults].filter(
      (candidate) => existsSync(candidate),
    );
    if (existingDefaults.length > 1) {
      throw new Error(
        `multiple Wrench and legacy state roots exist; set WRENCH_STATE_HOME explicitly after reconciling ${existingDefaults.join(", ")}`,
      );
    }
    root = existingDefaults[0] ?? currentDefault;
  }
  const home = canonicalPotentialPath(homedir());
  const forbiddenRoots = new Set([
    parse(root).root,
    home,
    dirname(home),
    canonicalPotentialPath(tmpdir()),
    canonicalPotentialPath(process.cwd()),
    ...["Desktop", "Documents", "Downloads", "Library", ".cache", ".config", ".local"]
      .map((name) => canonicalPotentialPath(join(home, name))),
    ...(environment.XDG_DATA_HOME === undefined || environment.XDG_DATA_HOME.trim() === ""
      ? []
      : [canonicalPotentialPath(environment.XDG_DATA_HOME)]),
  ]);
  if (forbiddenRoots.has(root) || isWithinPath(wrenchSourcePackageRoot, root)) {
    throw new Error(`WRENCH_STATE_HOME must be a dedicated child directory, not a filesystem, home, temporary, repository, or shared data root: ${root}`);
  }
  const inspected = validateStateRoot(root);
  const remembered = knownStateRoots.get(root);
  if (remembered !== undefined) {
    if (!sameIdentity(remembered.identity, inspected.identity)) {
      throw new Error(`WRENCH_STATE_HOME changed identity after validation: ${root}`);
    }
    if (
      remembered.identity === null
      && (
        remembered.creationAnchor === null
        || inspected.creationAnchor === null
        || remembered.creationAnchor.path !== inspected.creationAnchor.path
        || !sameIdentity(remembered.creationAnchor.identity, inspected.creationAnchor.identity)
        || remembered.creationAnchor.segments.join("\u0000") !== inspected.creationAnchor.segments.join("\u0000")
      )
    ) throw new Error(`WRENCH_STATE_HOME creation path changed after validation: ${root}`);
    if (remembered.claimed && !inspected.claimed) {
      throw new Error(`WRENCH_STATE_HOME lost its ownership marker after validation: ${root}`);
    }
    knownStateRoots.set(root, { ...inspected, claimed: remembered.claimed || inspected.claimed });
  } else {
    knownStateRoots.set(root, inspected);
  }
  for (const name of stateDirectoryNames) assertNoSymbolicLinks(root, join(root, name), true);
  return root;
}

function ensureClaimedStateRoot(root: string): StateRootIdentity {
  let remembered = assertStateRootIdentity(root);
  if (remembered.identity === null) {
    const anchor = remembered.creationAnchor;
    if (anchor === null) throw new Error(`WRENCH_STATE_HOME has no validated creation anchor: ${root}`);
    const response = runStateHelper(
      anchor.path,
      anchor.identity,
      { kind: "create-root", segments: anchor.segments },
      true,
    );
    const current = inspectStateRootIdentity(root);
    if (!sameIdentity(current, response.identity)) throw new Error(`WRENCH_STATE_HOME changed identity while being created: ${root}`);
    remembered = { claimed: true, creationAnchor: null, identity: response.identity };
    knownStateRoots.set(root, remembered);
  } else if (!remembered.claimed) {
    validateUnmarkedStateRoot(root);
    const descriptor = openSync(
      root,
      constants.O_RDONLY
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
        | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
    );
    try {
      const stats = fstatSync(descriptor, { bigint: true });
      const actual = { device: stats.dev.toString(), inode: stats.ino.toString() };
      if (!sameIdentity(actual, remembered.identity) || !ownedByCurrentUser(stats)) {
        throw new Error(`WRENCH_STATE_HOME changed identity while being claimed: ${root}`);
      }
      fchmodSync(descriptor, 0o700);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (!sameIdentity(inspectStateRootIdentity(root), remembered.identity)) {
      throw new Error(`WRENCH_STATE_HOME changed identity while being claimed: ${root}`);
    }
    runStateHelper(root, remembered.identity, { kind: "claim" });
    if (!sameIdentity(inspectStateRootIdentity(root), remembered.identity)) {
      throw new Error(`WRENCH_STATE_HOME changed identity while being claimed: ${root}`);
    }
    remembered = { claimed: true, creationAnchor: null, identity: remembered.identity };
    knownStateRoots.set(root, remembered);
  }
  if (remembered.identity === null) throw new Error(`WRENCH_STATE_HOME is unavailable after being claimed: ${root}`);
  assertStateRootIdentity(root);
  return remembered.identity;
}

/**
 * Resolve immutable system-owned compatibility links (for example macOS
 * `/var -> /private/var`) while rejecting links controlled by the invoking
 * user. All subsequent helper operations use the returned real-prefix path,
 * never the original alias.
 */
function canonicalNonStatePath(value: string): string {
  const absolute = resolve(value);
  const filesystemRoot = parse(absolute).root;
  const child = relative(filesystemRoot, absolute);
  const segments = child === "" ? [] : child.split(sep);
  let current = filesystemRoot;
  for (const [index, segment] of segments.entries()) {
    const candidate = join(current, segment);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(candidate);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      return join(current, ...segments.slice(index));
    }
    if (stats.isSymbolicLink()) {
      if (process.platform === "win32" || Number(stats.uid) !== 0) {
        throw new Error(`private path is not a real directory (symbolic link): ${candidate}`);
      }
      current = realpathSync(candidate);
      continue;
    }
    current = candidate;
  }
  return current;
}

function genericPathParts(path: string): {
  readonly canonical: string;
  readonly root: string;
  readonly rootIdentity: StateRootIdentity;
  readonly segments: readonly string[];
} {
  const canonical = canonicalNonStatePath(path);
  const root = parse(canonical).root;
  const rootIdentity = inspectRealDirectoryIdentity(root);
  if (rootIdentity === null) throw new Error(`path filesystem root is unavailable: ${root}`);
  const child = relative(root, canonical);
  return {
    canonical,
    root,
    rootIdentity,
    segments: child === "" ? [] : child.split(sep),
  };
}

function captureGenericDirectoryExpectations(
  root: string,
  segments: readonly string[],
): readonly StateDirectoryExpectation[] {
  const expectations: StateDirectoryExpectation[] = [];
  let current = root;
  let missing = false;
  for (const segment of segments) {
    current = join(current, segment);
    if (missing) {
      expectations.push(null);
      continue;
    }
    let stats: BigIntStats;
    try {
      stats = lstatSync(current, { bigint: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      missing = true;
      expectations.push(null);
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`private path ancestor is not a real directory: ${current}`);
    }
    expectations.push({ device: stats.dev.toString(), inode: stats.ino.toString() });
  }
  return expectations;
}

function ensureBoundNonStateDirectory(path: string, requireFinalPrivate: boolean): ReturnType<typeof genericPathParts> {
  const parts = genericPathParts(path);
  runPathHelper(parts.root, parts.rootIdentity, {
    kind: "ensure-directories",
    segments: parts.segments,
    directoryExpectations: captureGenericDirectoryExpectations(parts.root, parts.segments),
    requireFinalPrivate,
  });
  return genericPathParts(parts.canonical);
}

export function removePrivateDirectoryTree(
  path: string,
  expectedTarget?: Readonly<StateRootIdentity>,
): boolean {
  const parts = genericPathParts(path);
  if (parts.segments.length < 2) throw new Error("private recursive removal target is too broad");
  const captured = [...captureGenericDirectoryExpectations(parts.root, parts.segments)];
  if (expectedTarget !== undefined) captured[captured.length - 1] = expectedTarget;
  const response = runPathHelper(parts.root, parts.rootIdentity, {
    kind: "remove-directory-tree",
    segments: parts.segments,
    directoryExpectations: captured,
  });
  return response.removed === true;
}

export function ensurePrivateDirectory(path: string): void {
  const target = resolve(path);
  const root = stateRootFor(target);
  if (root !== null) {
    const identity = ensureClaimedStateRoot(root);
    const segments = stateSegments(root, target);
    if (segments.length > 0) {
      runStateHelper(root, identity, {
        kind: "ensure-directories",
        segments,
        directoryExpectations: captureStateDirectoryExpectations(root, segments),
      });
    }
    assertKnownStatePath(target, true);
    return;
  }
  ensureBoundNonStateDirectory(target, true);
}

export function ensurePrivateStateDirectory(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PrivateDirectoryIdentity {
  assertSafeStatePath(path, environment);
  const root = wrenchStateHome(environment);
  const identity = ensureClaimedStateRoot(root);
  const segments = stateSegments(root, path);
  if (segments.length === 0) return identity;
  const response = runStateHelper(root, identity, {
    kind: "ensure-directories",
    segments,
    directoryExpectations: captureStateDirectoryExpectations(root, segments),
  });
  if (response.targetIdentity === undefined) {
    throw new Error("state helper omitted the ensured directory identity");
  }
  return response.targetIdentity;
}

export function createPrivateStateDirectory(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedParent?: Readonly<PrivateDirectoryIdentity>,
): PrivateDirectoryIdentity {
  assertSafeStatePath(path, environment, false);
  const root = wrenchStateHome(environment);
  const identity = ensureClaimedStateRoot(root);
  const segments = stateSegments(root, path);
  if (segments.length < 2) throw new Error("only a nested wrench state directory can be created exclusively");
  const directoryExpectations = [...captureStateDirectoryExpectations(root, segments)];
  if (directoryExpectations.at(-1) !== null) throw new Error("private state directory already exists");
  if (expectedParent !== undefined) {
    directoryExpectations[directoryExpectations.length - 2] = expectedParent;
  }
  const response = runStateHelper(root, identity, {
    kind: "create-directory",
    segments,
    directoryExpectations,
  });
  if (response.created !== true || response.targetIdentity === undefined) {
    throw new Error("state helper omitted the created directory identity");
  }
  return response.targetIdentity;
}

export function readPrivateStateFileIfPresent(
  path: string,
  maximumBytes: number,
  label: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedStateDirectories?: readonly Readonly<PrivateDirectoryIdentity>[],
): string | null {
  assertSafeStatePath(path, environment);
  const root = wrenchStateHome(environment);
  const identity = ensureClaimedStateRoot(root);
  const segments = stateSegments(root, path);
  if (segments.length < 2) throw new Error(`${label} must be nested inside an wrench state directory`);
  const directoryExpectations = [...captureStateDirectoryExpectations(root, segments.slice(0, -1))];
  if (expectedStateDirectories !== undefined) {
    if (expectedStateDirectories.length !== directoryExpectations.length) {
      throw new Error(`optional ${label} directory identity count does not match its state path`);
    }
    directoryExpectations.splice(0, directoryExpectations.length, ...expectedStateDirectories);
  }
  let response: StateHelperResponse;
  try {
    response = runStateHelper(root, identity, {
      kind: "read-file-if-present",
      segments,
      directoryExpectations,
      maximumBytes,
    });
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(`could not safely open optional ${label}: ${path}${detail}`, { cause: error });
  }
  if (response.present === false) {
    if (response.contentBase64 !== undefined) throw new Error(`optional ${label} returned content while absent`);
    return null;
  }
  if (response.present !== true) throw new Error(`optional ${label} omitted its presence state`);
  const encoded = response.contentBase64;
  if (
    encoded === undefined
    || encoded.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) throw new Error(`optional ${label} returned malformed bounded content`);
  const content = Buffer.from(encoded, "base64");
  if (content.byteLength > maximumBytes) throw new Error(`optional ${label} grew beyond ${maximumBytes} bytes while being read`);
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(content);
  } catch (error) {
    throw new Error(`optional ${label} is not valid UTF-8`, { cause: error });
  }
}

export function readRegularFile(
  path: string,
  maximumBytes: number,
  label = "file",
  expectedStateParent?: Readonly<PrivateDirectoryIdentity>,
): string {
  let stateRoot: string | null;
  try {
    stateRoot = stateRootFor(path);
  } catch (error) {
    const reason = error instanceof Error && error.message.includes("symbolic link")
      ? " (state path contains a symbolic link)"
      : "";
    throw new Error(`could not safely open ${label}: ${path}${reason}`, { cause: error });
  }
  if (stateRoot !== null) {
    ensurePrivateDirectory(stateRoot);
    const record = assertStateRootIdentity(stateRoot);
    if (record.identity === null || !record.claimed) throw new Error("wrench state root is not claimed");
    const segments = stateSegments(stateRoot, path);
    if (segments.length === 0) {
      throw new Error(`${label} must be a regular file no larger than ${maximumBytes} bytes`);
    }
    let response: StateHelperResponse;
    try {
      const directoryExpectations = [...captureStateDirectoryExpectations(stateRoot, segments.slice(0, -1))];
      if (expectedStateParent !== undefined && directoryExpectations.length > 0 && directoryExpectations.at(-1) !== null) {
        directoryExpectations[directoryExpectations.length - 1] = expectedStateParent;
      }
      response = runStateHelper(stateRoot, record.identity, {
        kind: "read-file",
        segments,
        directoryExpectations,
        maximumBytes,
      });
    } catch (error) {
      const reason = error instanceof Error && error.message.includes("symbolic link")
        ? " (state path contains a symbolic link)"
        : "";
      throw new Error(`could not safely open ${label}: ${path}${reason}`, { cause: error });
    }
    const encoded = response.contentBase64;
    if (
      encoded === undefined
      || encoded.length > Math.ceil(maximumBytes / 3) * 4 + 4
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
    ) throw new Error(`${label} returned malformed bounded content`);
    const content = Buffer.from(encoded, "base64");
    if (content.byteLength > maximumBytes) throw new Error(`${label} grew beyond ${maximumBytes} bytes while being read`);
    try {
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(content);
    } catch (error) {
      throw new Error(`${label} is not valid UTF-8`, { cause: error });
    }
  }
  const parts = genericPathParts(path);
  if (parts.segments.length === 0) throw new Error(`${label} must be a regular file`);
  let response: StateHelperResponse;
  try {
    response = runPathHelper(parts.root, parts.rootIdentity, {
      kind: "read-file",
      segments: parts.segments,
      directoryExpectations: captureGenericDirectoryExpectations(parts.root, parts.segments.slice(0, -1)),
      maximumBytes,
    });
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message.includes("bounded regular file")
        || error.message.includes("byte bound")
        || error.message.includes("no longer matches its validated file identity")
      )
    ) {
      throw new Error(`${label} must be a regular file no larger than ${maximumBytes} bytes`, { cause: error });
    }
    throw new Error(`could not safely open ${label}: ${path}`, { cause: error });
  }
  const encoded = response.contentBase64;
  if (
    encoded === undefined
    || encoded.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) throw new Error(`${label} returned malformed bounded content`);
  const content = Buffer.from(encoded, "base64");
  if (content.byteLength > maximumBytes) throw new Error(`${label} grew beyond ${maximumBytes} bytes while being read`);
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(content);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readRegularFile(path, MAX_WRENCH_JSON_BYTES, "JSON file")) as unknown;
}

export function writePrivateJson(path: string, value: unknown, options: { readonly privateParent?: boolean } = {}): void {
  const parent = dirname(path);
  const stateRoot = stateRootFor(path);
  if (stateRoot !== null) {
    const identity = ensureClaimedStateRoot(stateRoot);
    const segments = stateSegments(stateRoot, path);
    runStateHelper(stateRoot, identity, {
      kind: "write-file",
      segments,
      directoryExpectations: captureStateDirectoryExpectations(stateRoot, segments.slice(0, -1)),
      content: `${canonicalJson(value)}\n`,
      createOnly: false,
      expectedContentSha256: null,
    });
    return;
  }
  const parentParts = ensureBoundNonStateDirectory(parent, options.privateParent === true);
  const destination = genericPathParts(join(parentParts.canonical, basename(path)));
  runPathHelper(destination.root, destination.rootIdentity, {
    kind: "write-file",
    segments: destination.segments,
    directoryExpectations: captureGenericDirectoryExpectations(destination.root, destination.segments.slice(0, -1)),
    content: `${canonicalJson(value)}\n`,
    createOnly: false,
  });
}

/**
 * Atomically replace one private state JSON file only when its complete
 * current bytes still match the caller's snapshot.
 *
 * The content hash includes the canonical trailing newline written by this
 * module. A false result is an ordinary compare-and-swap conflict; every
 * filesystem, ownership, permission, or helper failure still throws.
 */
export function writePrivateJsonIfUnchanged(
  path: string,
  value: unknown,
  options: {
    readonly expectedCurrentContentSha256: string;
    /** Test-only seam that pauses the winning helper after exclusive admission. */
    readonly pauseAfterClaimForTest?: boolean;
  },
): boolean {
  if (!/^[0-9a-f]{64}$/u.test(options.expectedCurrentContentSha256)) {
    throw new Error("expected private state content hash is invalid");
  }
  if (
    options.pauseAfterClaimForTest === true
    && process.env.NODE_ENV !== "test"
  ) {
    throw new Error("state CAS fault injection is available only in tests");
  }
  const stateRoot = stateRootFor(path);
  if (stateRoot === null) {
    throw new Error("compare-and-swap writes require a validated WRENCH_STATE_HOME path");
  }
  const identity = ensureClaimedStateRoot(stateRoot);
  const segments = stateSegments(stateRoot, path);
  try {
    runStateHelper(
      stateRoot,
      identity,
      {
        kind: "write-file",
        segments,
        directoryExpectations: captureStateDirectoryExpectations(
          stateRoot,
          segments.slice(0, -1),
        ),
        content: `${canonicalJson(value)}\n`,
        createOnly: false,
        expectedContentSha256: options.expectedCurrentContentSha256,
      },
      false,
      options.pauseAfterClaimForTest === true
        ? "pause-after-cas-claim"
        : undefined,
    );
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes("state file content no longer matches the expected hash")
    ) {
      return false;
    }
    throw error;
  }
}

export function createPrivateJsonIfAbsent(
  path: string,
  value: unknown,
  options: {
    /** Test seam for deterministic publication interleavings. Production callers must leave this unset. */
    readonly beforePublish?: (temporaryPath: string) => void;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    /** Bind the immediate legacy-schema state parent to an identity already validated by the caller. */
    readonly expectedStateParent?: Readonly<PrivateDirectoryIdentity>;
    readonly expectedStateDirectories?: readonly Readonly<PrivateDirectoryIdentity>[];
    readonly privateParent?: boolean;
  } = {},
): { readonly created: boolean } {
  const parent = dirname(path);
  // An explicit environment means the caller intends a dedicated Wrench state path.
  // Register and validate that root before classifying the destination.
  if (options.environment !== undefined) wrenchStateHome(options.environment);
  const stateRoot = stateRootFor(path);
  if (stateRoot !== null) {
    const identity = ensureClaimedStateRoot(stateRoot);
    if (options.beforePublish !== undefined) {
      const previewDirectory = mkdtempSync(join(tmpdir(), "wrench-create-preview-"));
      const previewPath = join(previewDirectory, "value.json");
      try {
        const directoryDescriptor = openSync(
          previewDirectory,
          constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0) | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
        );
        try {
          fchmodSync(directoryDescriptor, 0o700);
        } finally {
          closeSync(directoryDescriptor);
        }
        writeFileSync(previewPath, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        options.beforePublish(previewPath);
      } finally {
        rmSync(previewDirectory, { recursive: true, force: true });
      }
    }
    const segments = stateSegments(stateRoot, path);
    const directoryExpectations = [...captureStateDirectoryExpectations(stateRoot, segments.slice(0, -1))];
    if (options.expectedStateParent !== undefined && options.expectedStateDirectories !== undefined) {
      throw new Error("expected state parent cannot be combined with expected state directories");
    }
    if (options.expectedStateDirectories !== undefined) {
      if (options.expectedStateDirectories.length !== directoryExpectations.length) {
        throw new Error("expected state-directory identity count does not match the JSON path");
      }
      directoryExpectations.splice(0, directoryExpectations.length, ...options.expectedStateDirectories);
    }
    if (options.expectedStateParent !== undefined) {
      if (directoryExpectations.length === 0) throw new Error("expected state parent requires a nested JSON path");
      directoryExpectations[directoryExpectations.length - 1] = options.expectedStateParent;
    }
    const response = runStateHelper(stateRoot, identity, {
      kind: "write-file",
      segments,
      directoryExpectations,
      content: `${canonicalJson(value)}\n`,
      createOnly: true,
      expectedContentSha256: null,
    });
    return { created: response.created === true };
  }
  if (options.expectedStateParent !== undefined || options.expectedStateDirectories !== undefined) {
    throw new Error("state-directory identity expectations require an wrench state path");
  }
  if (options.environment !== undefined) assertSafeStatePath(path, options.environment);
  if (options.beforePublish !== undefined) {
    const previewDirectory = mkdtempSync(join(tmpdir(), "wrench-create-preview-"));
    const previewPath = join(previewDirectory, "value.json");
    try {
      chmodSync(previewDirectory, 0o700);
      writeFileSync(previewPath, `${canonicalJson(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      options.beforePublish(previewPath);
    } finally {
      rmSync(previewDirectory, { recursive: true, force: true });
    }
  }
  const parentParts = ensureBoundNonStateDirectory(parent, options.privateParent === true);
  const destination = genericPathParts(join(parentParts.canonical, basename(path)));
  const response = runPathHelper(destination.root, destination.rootIdentity, {
    kind: "write-file",
    segments: destination.segments,
    directoryExpectations: captureGenericDirectoryExpectations(destination.root, destination.segments.slice(0, -1)),
    content: `${canonicalJson(value)}\n`,
    createOnly: true,
  });
  return { created: response.created === true };
}

export function removePrivateStateFile(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedStateParent?: Readonly<PrivateDirectoryIdentity>,
): boolean {
  assertSafeStatePath(path, environment);
  const root = wrenchStateHome(environment);
  ensurePrivateDirectory(root);
  const record = assertStateRootIdentity(root);
  if (record.identity === null || !record.claimed) throw new Error("wrench state root is not claimed");
  const segments = stateSegments(root, path);
  const directoryExpectations = [...captureStateDirectoryExpectations(root, segments.slice(0, -1))];
  if (expectedStateParent !== undefined && directoryExpectations.length > 0 && directoryExpectations.at(-1) !== null) {
    directoryExpectations[directoryExpectations.length - 1] = expectedStateParent;
  }
  const response = runStateHelper(root, record.identity, {
    kind: "remove-file",
    segments,
    directoryExpectations,
  });
  return response.removed === true;
}

export function removePrivateStateFileIfUnchanged(
  path: string,
  options: {
    readonly expectedCurrentContentSha256: string;
  },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!/^[0-9a-f]{64}$/u.test(options.expectedCurrentContentSha256)) {
    throw new Error("expected private state content hash is invalid");
  }
  assertSafeStatePath(path, environment);
  const root = wrenchStateHome(environment);
  const identity = ensureClaimedStateRoot(root);
  const segments = stateSegments(root, path);
  if (segments.length < 2) {
    throw new Error("conditional state-file removal requires a nested state path");
  }
  const response = runStateHelper(root, identity, {
    kind: "remove-file-if-unchanged",
    segments,
    directoryExpectations: captureStateDirectoryExpectations(
      root,
      segments.slice(0, -1),
    ),
    expectedContentSha256: options.expectedCurrentContentSha256,
  });
  return response.removed === true;
}

export function listPrivateStateDirectory(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedTarget?: Readonly<PrivateDirectoryIdentity>,
): readonly PrivateStateDirectoryEntry[] {
  return snapshotPrivateStateDirectory(
    path,
    environment,
    expectedTarget,
  ).entries;
}

export function snapshotPrivateStateDirectory(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedTarget?: Readonly<PrivateDirectoryIdentity>,
): PrivateStateDirectorySnapshot {
  const root = wrenchStateHome(environment);
  const identity = ensureClaimedStateRoot(root);
  const segments = stateSegments(root, path);
  if (segments.length === 0) throw new Error("the wrench state root cannot be listed as a state collection");
  const directoryExpectations = [...captureStateDirectoryExpectations(root, segments)];
  if (expectedTarget !== undefined && directoryExpectations.at(-1) !== null) {
    directoryExpectations[directoryExpectations.length - 1] = expectedTarget;
  }
  const response = runStateHelper(root, identity, {
    kind: "list-directory",
    segments,
    directoryExpectations,
  });
  if (response.entries === undefined) throw new Error("state helper omitted its directory entries");
  return Object.freeze({
    identity: response.targetIdentity ?? null,
    entries: response.entries,
  });
}

/**
 * Read an exact caller-ordered set of files through one inode-bound helper.
 *
 * File disappearance and unsafe or unstable file state are inert per-file
 * results. A changed directory identity rejects the whole snapshot.
 */
export function readPrivateStateFilesBatch(
  path: string,
  names: readonly string[],
  options: {
    readonly maximumBytesPerFile: number;
    readonly maximumTotalBytes: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly expectedDirectoryIdentity?: Readonly<PrivateDirectoryIdentity>;
    /** Narrow child-helper interleaving used only by deterministic tests. */
    readonly faultForTest?: PrivateStateBatchReadFaultForTest;
  },
): readonly PrivateStateBatchReadResult[] {
  if (
    !Number.isSafeInteger(options.maximumBytesPerFile)
    || options.maximumBytesPerFile < 0
    || options.maximumBytesPerFile > MAX_PRIVATE_STATE_BATCH_FILE_BYTES
  ) {
    throw new Error("private state batch per-file byte bound is invalid");
  }
  if (
    !Number.isSafeInteger(options.maximumTotalBytes)
    || options.maximumTotalBytes < 0
    || options.maximumTotalBytes > MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES
  ) {
    throw new Error("private state batch aggregate byte bound is invalid");
  }
  if (
    !Array.isArray(names)
    || names.length > MAX_PRIVATE_STATE_BATCH_FILES
  ) {
    throw new Error("private state batch file count is invalid");
  }
  let nameBytes = 0;
  const validatedNames: string[] = [];
  for (const name of names as readonly unknown[]) {
    if (!isSafeBatchFileName(name)) {
      throw new Error("private state batch contains an invalid file name");
    }
    nameBytes += Buffer.byteLength(name, "utf8");
    if (nameBytes > MAX_PRIVATE_STATE_BATCH_NAME_BYTES) {
      throw new Error("private state batch file names exceed their byte bound");
    }
    validatedNames.push(name);
  }
  if (new Set(validatedNames).size !== validatedNames.length) {
    throw new Error("private state batch file names must be unique");
  }
  if (options.faultForTest !== undefined && process.env.NODE_ENV !== "test") {
    throw new Error("private state batch fault injection is available only under the test runtime");
  }

  const environment = options.environment ?? process.env;
  let root: string;
  let identity: StateRootIdentity;
  let segments: readonly string[];
  let directoryExpectations: StateDirectoryExpectation[];
  try {
    assertSafeStatePath(path, environment);
    root = wrenchStateHome(environment);
    identity = ensureClaimedStateRoot(root);
    segments = stateSegments(root, path);
    if (segments.length === 0) {
      throw new Error("root is not a state collection");
    }
    directoryExpectations = [
      ...captureStateDirectoryExpectations(root, segments),
    ];
  } catch {
    throw new Error("private state batch directory is unsafe");
  }
  const capturedTarget = directoryExpectations.at(-1);
  if (capturedTarget === undefined || capturedTarget === null) {
    throw new Error("private state batch directory is absent");
  }
  const expectedTarget = options.expectedDirectoryIdentity ?? capturedTarget;
  if (!sameIdentity(capturedTarget, expectedTarget)) {
    throw new Error("private state batch directory changed identity");
  }
  directoryExpectations[directoryExpectations.length - 1] = expectedTarget;

  let response: StateHelperResponse;
  try {
    response = runStateHelper(root, identity, {
      kind: "batch-read-files",
      segments,
      directoryExpectations,
      names: validatedNames,
      maximumBytesPerFile: options.maximumBytesPerFile,
      maximumTotalBytes: options.maximumTotalBytes,
    }, false, options.faultForTest);
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message.includes("malformed response")
        || error.message.includes("invalid JSON")
      )
    ) {
      throw new Error("state helper returned a malformed batch response");
    }
    throw new Error("private state batch helper rejected the snapshot");
  }
  if (
    response.targetIdentity === undefined
    || !sameIdentity(response.targetIdentity, expectedTarget)
  ) {
    throw new Error("private state batch directory changed identity");
  }
  let currentTarget: StateRootIdentity | null;
  try {
    currentTarget = inspectRealDirectoryIdentity(path);
  } catch {
    throw new Error("private state batch directory changed identity");
  }
  if (!sameIdentity(currentTarget, expectedTarget)) {
    throw new Error("private state batch directory changed identity");
  }
  const files = response.files;
  if (
    files === undefined
    || files.length !== validatedNames.length
    || files.some((file, index) => file.name !== validatedNames[index])
  ) {
    throw new Error("state helper returned a malformed batch response");
  }

  const results: PrivateStateBatchReadResult[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (file.status === "absent") {
      results.push(Object.freeze({ name: file.name, status: "absent" }));
      continue;
    }
    if (file.status === "invalid") {
      results.push(Object.freeze({
        name: file.name,
        status: "invalid",
        reason: file.reason,
      }));
      continue;
    }
    const content = decodeCanonicalBase64(
      file.contentBase64,
      options.maximumBytesPerFile,
    );
    if (content === null) {
      throw new Error("state helper returned a malformed batch response");
    }
    totalBytes += content.byteLength;
    if (totalBytes > options.maximumTotalBytes) {
      throw new Error("state helper returned a malformed batch response");
    }
    try {
      results.push(Object.freeze({
        name: file.name,
        status: "present",
        content: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(content),
      }));
    } catch {
      results.push(Object.freeze({
        name: file.name,
        status: "invalid",
        reason: "invalid-utf8",
      }));
    }
  }
  return Object.freeze(results);
}

export function readPrivateStateFilesBatched(
  path: string,
  names: readonly string[],
  options: {
    readonly maximumBytesPerFile: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly expectedDirectoryIdentity: Readonly<PrivateDirectoryIdentity>;
  },
): readonly PrivateStateBatchReadResult[] {
  if (!Array.isArray(names) || names.length > 10_000) {
    throw new Error("private state collection file count is invalid");
  }
  if (
    (names as readonly unknown[]).some(
      (name) => !isSafeBatchFileName(name),
    )
  ) {
    throw new Error("private state collection contains an invalid file name");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("private state collection file names must be unique");
  }
  if (
    !Number.isSafeInteger(options.maximumBytesPerFile)
    || options.maximumBytesPerFile < 0
    || options.maximumBytesPerFile > MAX_PRIVATE_STATE_BATCH_FILE_BYTES
  ) {
    throw new Error("private state collection per-file byte bound is invalid");
  }
  const filesPerBatch = options.maximumBytesPerFile === 0
    ? MAX_PRIVATE_STATE_BATCH_FILES
    : Math.min(
        MAX_PRIVATE_STATE_BATCH_FILES,
        Math.floor(
          MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES / options.maximumBytesPerFile,
        ),
      );
  const results: PrivateStateBatchReadResult[] = [];
  for (let index = 0; index < names.length; index += filesPerBatch) {
    const batchNames = names.slice(index, index + filesPerBatch);
    results.push(...readPrivateStateFilesBatch(path, batchNames, {
      maximumBytesPerFile: options.maximumBytesPerFile,
      maximumTotalBytes: options.maximumBytesPerFile * batchNames.length,
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
      expectedDirectoryIdentity: options.expectedDirectoryIdentity,
    }));
  }
  return Object.freeze(results);
}

export function readPrivateStateChildFilesBatch(
  path: string,
  files: readonly PrivateStateBatchChildFile[],
  options: {
    readonly maximumBytesPerFile: number;
    readonly maximumTotalBytes: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly expectedDirectoryIdentity?: Readonly<PrivateDirectoryIdentity>;
    /** Narrow child-helper interleaving used only by deterministic tests. */
    readonly faultForTest?: PrivateStateBatchReadFaultForTest;
  },
): readonly PrivateStateBatchChildReadResult[] {
  if (
    !Number.isSafeInteger(options.maximumBytesPerFile)
    || options.maximumBytesPerFile < 0
    || options.maximumBytesPerFile > MAX_PRIVATE_STATE_BATCH_FILE_BYTES
  ) {
    throw new Error("private state child batch per-file byte bound is invalid");
  }
  if (
    !Number.isSafeInteger(options.maximumTotalBytes)
    || options.maximumTotalBytes < 0
    || options.maximumTotalBytes > MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES
  ) {
    throw new Error("private state child batch aggregate byte bound is invalid");
  }
  if (!Array.isArray(files) || files.length > MAX_PRIVATE_STATE_BATCH_FILES) {
    throw new Error("private state child batch file count is invalid");
  }
  let nameBytes = 0;
  const keys = new Set<string>();
  const validatedFiles: PrivateStateBatchChildFile[] = [];
  for (const file of files as readonly unknown[]) {
    if (
      !isRecord(file)
      || !exactObjectKeys(file, [
        "directoryName",
        "directoryIdentity",
        "fileName",
      ])
      || !isSafeBatchFileName(file.directoryName)
      || !isSafeBatchFileName(file.fileName)
    ) {
      throw new Error("private state child batch request is invalid");
    }
    const directoryIdentity = parseResponseIdentity(file.directoryIdentity);
    if (directoryIdentity === null) {
      throw new Error("private state child batch directory identity is invalid");
    }
    nameBytes += Buffer.byteLength(file.directoryName, "utf8")
      + Buffer.byteLength(file.fileName, "utf8");
    if (nameBytes > MAX_PRIVATE_STATE_BATCH_NAME_BYTES) {
      throw new Error("private state child batch names exceed their byte bound");
    }
    const key = `${file.directoryName}\u0000${file.fileName}`;
    if (keys.has(key)) {
      throw new Error("private state child batch requests must be unique");
    }
    keys.add(key);
    validatedFiles.push({
      directoryName: file.directoryName,
      directoryIdentity,
      fileName: file.fileName,
    });
  }
  if (options.faultForTest !== undefined && process.env.NODE_ENV !== "test") {
    throw new Error("private state child batch fault injection is available only under the test runtime");
  }

  const environment = options.environment ?? process.env;
  let root: string;
  let identity: StateRootIdentity;
  let segments: readonly string[];
  let directoryExpectations: StateDirectoryExpectation[];
  try {
    assertSafeStatePath(path, environment);
    root = wrenchStateHome(environment);
    identity = ensureClaimedStateRoot(root);
    segments = stateSegments(root, path);
    if (segments.length === 0) {
      throw new Error("root is not a state collection");
    }
    directoryExpectations = [
      ...captureStateDirectoryExpectations(root, segments),
    ];
  } catch {
    throw new Error("private state child batch directory is unsafe");
  }
  const capturedTarget = directoryExpectations.at(-1);
  if (capturedTarget === undefined || capturedTarget === null) {
    throw new Error("private state child batch directory is absent");
  }
  const expectedTarget = options.expectedDirectoryIdentity ?? capturedTarget;
  if (!sameIdentity(capturedTarget, expectedTarget)) {
    throw new Error("private state child batch directory changed identity");
  }
  directoryExpectations[directoryExpectations.length - 1] = expectedTarget;

  let response: StateHelperResponse;
  try {
    response = runStateHelper(root, identity, {
      kind: "batch-read-child-files",
      segments,
      directoryExpectations,
      files: validatedFiles,
      maximumBytesPerFile: options.maximumBytesPerFile,
      maximumTotalBytes: options.maximumTotalBytes,
    }, false, options.faultForTest);
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message.includes("malformed response")
        || error.message.includes("invalid JSON")
      )
    ) {
      throw new Error("state helper returned a malformed child batch response");
    }
    throw new Error("private state child batch helper rejected the snapshot");
  }
  if (
    response.targetIdentity === undefined
    || !sameIdentity(response.targetIdentity, expectedTarget)
  ) {
    throw new Error("private state child batch directory changed identity");
  }
  let currentTarget: StateRootIdentity | null;
  try {
    currentTarget = inspectRealDirectoryIdentity(path);
  } catch {
    throw new Error("private state child batch directory changed identity");
  }
  if (!sameIdentity(currentTarget, expectedTarget)) {
    throw new Error("private state child batch directory changed identity");
  }
  const childFiles = response.childFiles;
  if (
    childFiles === undefined
    || childFiles.length !== validatedFiles.length
    || childFiles.some((file, index) => (
      file.directoryName !== validatedFiles[index]?.directoryName
      || file.fileName !== validatedFiles[index]?.fileName
    ))
  ) {
    throw new Error("state helper returned a malformed child batch response");
  }

  const results: PrivateStateBatchChildReadResult[] = [];
  let totalBytes = 0;
  for (const file of childFiles) {
    if (file.status === "absent") {
      results.push(Object.freeze({
        directoryName: file.directoryName,
        fileName: file.fileName,
        status: "absent",
      }));
      continue;
    }
    if (file.status === "invalid") {
      results.push(Object.freeze({
        directoryName: file.directoryName,
        fileName: file.fileName,
        status: "invalid",
        reason: file.reason,
      }));
      continue;
    }
    const content = decodeCanonicalBase64(
      file.contentBase64,
      options.maximumBytesPerFile,
    );
    if (content === null) {
      throw new Error("state helper returned a malformed child batch response");
    }
    totalBytes += content.byteLength;
    if (totalBytes > options.maximumTotalBytes) {
      throw new Error("state helper returned a malformed child batch response");
    }
    try {
      results.push(Object.freeze({
        directoryName: file.directoryName,
        fileName: file.fileName,
        status: "present",
        content: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(content),
      }));
    } catch {
      results.push(Object.freeze({
        directoryName: file.directoryName,
        fileName: file.fileName,
        status: "invalid",
        reason: "invalid-utf8",
      }));
    }
  }
  return Object.freeze(results);
}

export function readPrivateStateChildFilesBatched(
  path: string,
  files: readonly PrivateStateBatchChildFile[],
  options: {
    readonly maximumBytesPerFile: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly expectedDirectoryIdentity: Readonly<PrivateDirectoryIdentity>;
  },
): readonly PrivateStateBatchChildReadResult[] {
  if (!Array.isArray(files) || files.length > 10_000) {
    throw new Error("private state child collection file count is invalid");
  }
  const keys = new Set<string>();
  for (const file of files as readonly unknown[]) {
    if (
      !isRecord(file)
      || !exactObjectKeys(file, [
        "directoryName",
        "directoryIdentity",
        "fileName",
      ])
      || !isSafeBatchFileName(file.directoryName)
      || !isSafeBatchFileName(file.fileName)
      || parseResponseIdentity(file.directoryIdentity) === null
    ) {
      throw new Error("private state child collection request is invalid");
    }
    const key = `${file.directoryName}\u0000${file.fileName}`;
    if (keys.has(key)) {
      throw new Error("private state child collection requests must be unique");
    }
    keys.add(key);
  }
  if (
    !Number.isSafeInteger(options.maximumBytesPerFile)
    || options.maximumBytesPerFile < 0
    || options.maximumBytesPerFile > MAX_PRIVATE_STATE_BATCH_FILE_BYTES
  ) {
    throw new Error("private state child collection per-file byte bound is invalid");
  }
  const filesPerBatch = options.maximumBytesPerFile === 0
    ? Math.min(
        MAX_PRIVATE_STATE_BATCH_FILES,
        Math.floor(MAX_PRIVATE_STATE_BATCH_NAME_BYTES / (2 * 255)),
      )
    : Math.min(
        MAX_PRIVATE_STATE_BATCH_FILES,
        Math.floor(MAX_PRIVATE_STATE_BATCH_NAME_BYTES / (2 * 255)),
        Math.floor(
          MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES / options.maximumBytesPerFile,
        ),
      );
  const results: PrivateStateBatchChildReadResult[] = [];
  for (let index = 0; index < files.length; index += filesPerBatch) {
    const batchFiles = files.slice(index, index + filesPerBatch);
    results.push(...readPrivateStateChildFilesBatch(path, batchFiles, {
      maximumBytesPerFile: options.maximumBytesPerFile,
      maximumTotalBytes: options.maximumBytesPerFile * batchFiles.length,
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
      expectedDirectoryIdentity: options.expectedDirectoryIdentity,
    }));
  }
  return Object.freeze(results);
}

export function removePrivateStateDirectoryTree(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedTarget?: Readonly<StateRootIdentity>,
  expectedParent?: Readonly<StateRootIdentity>,
): boolean {
  const root = wrenchStateHome(environment);
  const identity = ensureClaimedStateRoot(root);
  const segments = stateSegments(root, path);
  if (segments.length < 2) throw new Error("only a nested wrench state directory can be recursively removed");
  const captured = [...captureStateDirectoryExpectations(root, segments)];
  if (expectedTarget !== undefined && captured.at(-1) !== null) captured[captured.length - 1] = expectedTarget;
  if (expectedParent !== undefined && captured.length > 1 && captured.at(-2) !== null) {
    captured[captured.length - 2] = expectedParent;
  }
  const response = runStateHelper(root, identity, {
    kind: "remove-directory-tree",
    segments,
    directoryExpectations: captured,
  });
  return response.removed === true;
}

export function removePrivateEmptyStateDirectory(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  expectedTarget?: Readonly<StateRootIdentity>,
  expectedParent?: Readonly<StateRootIdentity>,
  options: {
    /** Narrow child-helper interleave for deterministic inode-race coverage. */
    readonly raceForTest?: EmptyDirectoryRemovalRaceForTest;
  } = {},
): boolean {
  if (options.raceForTest !== undefined && process.env.NODE_ENV !== "test") {
    throw new Error("empty-directory race injection is available only under the test runtime");
  }
  const root = wrenchStateHome(environment);
  const identity = ensureClaimedStateRoot(root);
  const segments = stateSegments(root, path);
  if (segments.length < 2) throw new Error("only a nested wrench state directory can be removed");
  const captured = [...captureStateDirectoryExpectations(root, segments)];
  if (expectedTarget !== undefined && captured.at(-1) !== null) captured[captured.length - 1] = expectedTarget;
  if (expectedParent !== undefined && captured.length > 1 && captured.at(-2) !== null) {
    captured[captured.length - 2] = expectedParent;
  }
  const response = runStateHelper(root, identity, {
    kind: "remove-empty-directory",
    segments,
    directoryExpectations: captured,
  }, false, options.raceForTest);
  return response.removed === true;
}

export function adapterDirectory(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(wrenchStateHome(environment), "adapters");
}

export function adapterManifestPath(id: string, environment: Readonly<Record<string, string | undefined>> = process.env): string {
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(id)) throw new Error("adapter ID must be lowercase kebab-case");
  // This filename is persisted state, not product copy. Keep the schema-v1
  // spelling byte-stable so interrupted upgrades and existing installations
  // remain readable after the Wrench rename. Source/scaffold manifests use the new
  // `wrench-adapter.json` name and are normalized into this compatibility mirror.
  return join(adapterDirectory(environment), id, "io-adapter.json");
}

// These discriminants are part of the persisted schema-v1 contract. Branding
// changes must not create a new meaning under the same schema version.
const adapterGenerationKind = "io-adapter-generation";
const adapterGenerationTransactionKind = "io-adapter-generation-transaction";
const adapterGenerationSchemaVersion = 1;
const adapterGenerationMaximumEntries = 1_000;
const adapterGenerationMaximumIndexBytes = 1024 * 1024;
const adapterGenerationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const contentSha256Pattern = /^[0-9a-f]{64}$/u;

type AdapterGenerationPresentEntry = {
  readonly id: string;
  readonly state: "present";
  readonly objectContentSha256: string;
  readonly manifestHash: string;
  readonly sourceContentSha256: string;
};

type AdapterGenerationAbsentEntry = {
  readonly id: string;
  readonly state: "absent";
};

type AdapterGenerationEntry =
  | AdapterGenerationPresentEntry
  | AdapterGenerationAbsentEntry;

type AdapterGenerationIndex = {
  readonly kind: typeof adapterGenerationKind;
  readonly schemaVersion: typeof adapterGenerationSchemaVersion;
  readonly commitId: string;
  readonly entries: readonly AdapterGenerationEntry[];
};

type AdapterGenerationTransaction = {
  readonly kind: typeof adapterGenerationTransactionKind;
  readonly schemaVersion: typeof adapterGenerationSchemaVersion;
  readonly transactionId: string;
  readonly beforeCommitId: string | null;
  readonly owner: ProcessOwnerIdentity;
};

type AdapterGenerationTransactionClaim = {
  readonly record: AdapterGenerationTransaction;
  readonly contentSha256: string;
};

const activeAdapterGenerationTransactions = new Map<
  string,
  AdapterGenerationTransactionClaim
>();

export type BundledAdapterGenerationSelection =
  | {
      readonly id: string;
      readonly state: "present";
      /** Runtime-valid current or diagnostic-only preserved manifest. */
      readonly manifest: WrenchManifest;
      /** Hash of the exact source bytes parsed to produce `manifest`. */
      readonly sourceContentSha256: string;
      /**
       * Exact active bytes observed while deciding whether to install,
       * upgrade, or preserve this adapter. `null` means it was absent.
       *
       * Callers that classify mutable installed state must provide this so a
       * concurrent user edit cannot be overwritten by a later generation
       * commit. Omission is retained for internal unconditional publication.
       */
      readonly expectedCurrentContentSha256?: string | null;
    }
  | {
      readonly id: string;
      /**
       * Leave this ID on the legacy flat-file layout. This is reserved for a
       * malformed user-owned install that cannot be copied into an immutable
       * canonical object without changing its bytes.
       */
      readonly state: "legacy";
      /** Exact malformed flat-file bytes that were classified as legacy. */
      readonly expectedCurrentContentSha256?: string | null;
    };

type AdapterGenerationInstallTestOptions = {
  /** Exact catalog used to validate every current or retired manifest. */
  readonly registry?: ProviderPluginRegistry;
  /** Test-only fault seam after each immutable object reaches durable storage. */
  readonly afterObjectForTest?: (completedObjects: number) => void;
  /** Test-only fault seam immediately after the generation pointer commits. */
  readonly afterCommitForTest?: () => void;
};

function isAdapterId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/u.test(value);
}

function adapterGenerationDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(wrenchStateHome(environment), "adapter-generations");
}

function adapterGenerationIndexPath(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(adapterGenerationDirectory(environment), "current.json");
}

function adapterGenerationTransactionPath(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(adapterGenerationDirectory(environment), "transaction.json");
}

function adapterGenerationObjectsDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(adapterGenerationDirectory(environment), "objects");
}

function adapterGenerationObjectPath(
  contentSha256: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (!contentSha256Pattern.test(contentSha256)) {
    throw new Error("adapter generation object hash is invalid");
  }
  return join(
    adapterGenerationObjectsDirectory(environment),
    `${contentSha256}.json`,
  );
}

function parseAdapterGenerationEntry(value: unknown): AdapterGenerationEntry {
  if (!isRecord(value)) {
    throw new Error("adapter generation entry must be an object");
  }
  if (!("state" in value) || value.state === "absent") {
    if (
      !exactObjectKeys(value, ["id", "state"])
      || !isAdapterId(value.id)
      || value.state !== "absent"
    ) {
      throw new Error("adapter generation absent entry is malformed");
    }
    return Object.freeze({ id: value.id, state: "absent" });
  }
  if (
    !exactObjectKeys(value, [
      "id",
      "manifestHash",
      "objectContentSha256",
      "sourceContentSha256",
      "state",
    ])
    || !isAdapterId(value.id)
    || value.state !== "present"
    || typeof value.objectContentSha256 !== "string"
    || !contentSha256Pattern.test(value.objectContentSha256)
    || typeof value.manifestHash !== "string"
    || !contentSha256Pattern.test(value.manifestHash)
    || typeof value.sourceContentSha256 !== "string"
    || !contentSha256Pattern.test(value.sourceContentSha256)
  ) {
    throw new Error("adapter generation present entry is malformed");
  }
  return Object.freeze({
    id: value.id,
    state: "present",
    objectContentSha256: value.objectContentSha256,
    manifestHash: value.manifestHash,
    sourceContentSha256: value.sourceContentSha256,
  });
}

function parseAdapterGenerationIndex(value: unknown): AdapterGenerationIndex {
  if (
    !isRecord(value)
    || !exactObjectKeys(value, ["commitId", "entries", "kind", "schemaVersion"])
    || value.kind !== adapterGenerationKind
    || value.schemaVersion !== adapterGenerationSchemaVersion
    || typeof value.commitId !== "string"
    || !adapterGenerationIdPattern.test(value.commitId)
    || !Array.isArray(value.entries)
    || value.entries.length > adapterGenerationMaximumEntries
  ) {
    throw new Error("adapter generation index is malformed");
  }
  const entries = value.entries.map(parseAdapterGenerationEntry);
  const ids = entries.map((entry) => entry.id);
  if (
    new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)
  ) {
    throw new Error("adapter generation entries must have unique sorted IDs");
  }
  return Object.freeze({
    kind: adapterGenerationKind,
    schemaVersion: adapterGenerationSchemaVersion,
    commitId: value.commitId,
    entries: Object.freeze(entries),
  });
}

function parseProcessOwnerIdentity(value: unknown): ProcessOwnerIdentity {
  if (
    !isRecord(value)
    || !exactObjectKeys(value, ["bootId", "pid", "processStartId"])
    || typeof value.pid !== "number"
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || typeof value.bootId !== "string"
    || !contentSha256Pattern.test(value.bootId)
    || typeof value.processStartId !== "string"
    || !contentSha256Pattern.test(value.processStartId)
  ) {
    throw new Error("adapter generation transaction owner is malformed");
  }
  return Object.freeze({
    pid: value.pid,
    bootId: value.bootId,
    processStartId: value.processStartId,
  });
}

function parseAdapterGenerationTransaction(
  value: unknown,
): AdapterGenerationTransaction {
  if (
    !isRecord(value)
    || !exactObjectKeys(value, [
      "beforeCommitId",
      "kind",
      "owner",
      "schemaVersion",
      "transactionId",
    ])
    || value.kind !== adapterGenerationTransactionKind
    || value.schemaVersion !== adapterGenerationSchemaVersion
    || typeof value.transactionId !== "string"
    || !adapterGenerationIdPattern.test(value.transactionId)
    || (
      value.beforeCommitId !== null
      && (
        typeof value.beforeCommitId !== "string"
        || !adapterGenerationIdPattern.test(value.beforeCommitId)
      )
    )
  ) {
    throw new Error("adapter generation transaction is malformed");
  }
  return Object.freeze({
    kind: adapterGenerationTransactionKind,
    schemaVersion: adapterGenerationSchemaVersion,
    transactionId: value.transactionId,
    beforeCommitId: value.beforeCommitId,
    owner: parseProcessOwnerIdentity(value.owner),
  });
}

function readOptionalAdapterGenerationJson(
  path: string,
  label: string,
  environment: Readonly<Record<string, string | undefined>>,
): {
  readonly content: string;
  readonly contentSha256: string;
  readonly value: unknown;
} | null {
  const content = readPrivateStateFileIfPresent(
    path,
    adapterGenerationMaximumIndexBytes,
    label,
    environment,
  );
  if (content === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  return Object.freeze({
    content,
    contentSha256: sha256(content),
    value,
  });
}

function readAdapterGenerationIndex(
  environment: Readonly<Record<string, string | undefined>>,
): AdapterGenerationIndex | null {
  const record = readOptionalAdapterGenerationJson(
    adapterGenerationIndexPath(environment),
    "adapter generation index",
    environment,
  );
  if (record === null) return null;
  if (`${canonicalJson(record.value)}\n` !== record.content) {
    throw new Error("adapter generation index is not canonical JSON");
  }
  return parseAdapterGenerationIndex(record.value);
}

function readAdapterGenerationTransaction(
  environment: Readonly<Record<string, string | undefined>>,
): AdapterGenerationTransactionClaim | null {
  const record = readOptionalAdapterGenerationJson(
    adapterGenerationTransactionPath(environment),
    "adapter generation transaction",
    environment,
  );
  if (record === null) return null;
  if (`${canonicalJson(record.value)}\n` !== record.content) {
    throw new Error("adapter generation transaction is not canonical JSON");
  }
  return Object.freeze({
    record: parseAdapterGenerationTransaction(record.value),
    contentSha256: record.contentSha256,
  });
}

function acquireAdapterGenerationTransaction(
  environment: Readonly<Record<string, string | undefined>>,
): AdapterGenerationTransactionClaim {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = readAdapterGenerationIndex(environment);
    const processIdentity = currentProcessStartIdentity();
    const record: AdapterGenerationTransaction = Object.freeze({
      kind: adapterGenerationTransactionKind,
      schemaVersion: adapterGenerationSchemaVersion,
      transactionId: crypto.randomUUID(),
      beforeCommitId: current?.commitId ?? null,
      owner: Object.freeze({
        pid: process.pid,
        ...processIdentity,
      }),
    });
    const created = createPrivateJsonIfAbsent(
      adapterGenerationTransactionPath(environment),
      record,
      { environment, privateParent: true },
    );
    if (created.created) {
      return Object.freeze({
        record,
        contentSha256: sha256(`${canonicalJson(record)}\n`),
      });
    }
    const existing = readAdapterGenerationTransaction(environment);
    if (existing === null) continue;
    const status = processOwnerStatus(existing.record.owner);
    if (status === "exact-live-owner") {
      throw new Error("another adapter generation transaction is active");
    }
    if (status === "unknown") {
      throw new Error("adapter generation transaction owner cannot be inspected safely");
    }
    const currentIndex = readAdapterGenerationIndex(environment);
    if (
      currentIndex !== null
      && existing.record.beforeCommitId !== null
      && currentIndex.commitId !== existing.record.beforeCommitId
      && currentIndex.commitId !== existing.record.transactionId
    ) {
      throw new Error("stale adapter generation transaction does not match the active generation");
    }
    removePrivateStateFileIfUnchanged(
      adapterGenerationTransactionPath(environment),
      { expectedCurrentContentSha256: existing.contentSha256 },
      environment,
    );
  }
  throw new Error("adapter generation transaction could not be acquired");
}

function releaseAdapterGenerationTransaction(
  claim: AdapterGenerationTransactionClaim,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const removed = removePrivateStateFileIfUnchanged(
    adapterGenerationTransactionPath(environment),
    { expectedCurrentContentSha256: claim.contentSha256 },
    environment,
  );
  if (!removed) {
    throw new Error("adapter generation transaction ownership changed before release");
  }
}

function withAdapterGenerationTransaction<T>(
  environment: Readonly<Record<string, string | undefined>>,
  operation: (
    claim: AdapterGenerationTransactionClaim,
    current: AdapterGenerationIndex | null,
  ) => T,
): T {
  const generationDirectory = adapterGenerationDirectory(environment);
  const active = activeAdapterGenerationTransactions.get(generationDirectory);
  if (active !== undefined) {
    return operation(active, readAdapterGenerationIndex(environment));
  }
  const claim = acquireAdapterGenerationTransaction(environment);
  activeAdapterGenerationTransactions.set(generationDirectory, claim);
  try {
    const current = readAdapterGenerationIndex(environment);
    if ((current?.commitId ?? null) !== claim.record.beforeCommitId) {
      throw new Error("adapter generation changed while transaction ownership was acquired");
    }
    return operation(claim, current);
  } finally {
    activeAdapterGenerationTransactions.delete(generationDirectory);
    releaseAdapterGenerationTransaction(claim, environment);
  }
}

function writeAdapterGenerationIndex(
  entries: readonly AdapterGenerationEntry[],
  commitId: string,
  environment: Readonly<Record<string, string | undefined>>,
): AdapterGenerationIndex {
  const index = parseAdapterGenerationIndex({
    kind: adapterGenerationKind,
    schemaVersion: adapterGenerationSchemaVersion,
    commitId,
    entries,
  });
  const content = `${canonicalJson(index)}\n`;
  if (Buffer.byteLength(content, "utf8") > adapterGenerationMaximumIndexBytes) {
    throw new Error("adapter generation index exceeds its byte bound");
  }
  writePrivateJson(adapterGenerationIndexPath(environment), index);
  return index;
}

function publishAdapterGenerationObject(
  manifest: WrenchManifest,
  sourceContentSha256: string,
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): AdapterGenerationPresentEntry {
  if (!contentSha256Pattern.test(sourceContentSha256)) {
    throw new Error("adapter generation source hash is invalid");
  }
  const diagnostic = parseDiagnosticManifest(manifest, registry);
  if (!diagnostic.ok) {
    throw new Error(`adapter generation manifest is invalid: ${diagnostic.issues.join("; ")}`);
  }
  if (canonicalJson(diagnostic.value) !== canonicalJson(manifest)) {
    throw new Error("adapter generation manifest is not canonical");
  }
  const content = `${canonicalJson(diagnostic.value)}\n`;
  const objectContentSha256 = sha256(content);
  const path = adapterGenerationObjectPath(objectContentSha256, environment);
  const created = createPrivateJsonIfAbsent(path, diagnostic.value, {
    environment,
    privateParent: true,
  });
  if (!created.created) {
    const stored = readPrivateStateFileIfPresent(
      path,
      MAX_WRENCH_JSON_BYTES,
      "adapter generation object",
      environment,
    );
    if (
      stored === null
      || sha256(stored) !== objectContentSha256
      || stored !== content
    ) {
      throw new Error("adapter generation object content does not match its address");
    }
  }
  return Object.freeze({
    id: diagnostic.value.id,
    state: "present",
    objectContentSha256,
    manifestHash: manifestHash(diagnostic.value),
    sourceContentSha256,
  });
}

function readAdapterGenerationObject(
  entry: AdapterGenerationPresentEntry,
  environment: Readonly<Record<string, string | undefined>>,
  parseInstalled: (value: unknown) => ParseResult<WrenchManifest>,
): InstalledManifestSnapshot {
  let content: string | null;
  try {
    content = readPrivateStateFileIfPresent(
      adapterGenerationObjectPath(entry.objectContentSha256, environment),
      MAX_WRENCH_JSON_BYTES,
      "adapter generation object",
      environment,
    );
  } catch (error) {
    return {
      result: {
        ok: false,
        issues: [error instanceof Error ? error.message : String(error)],
      },
      availability: "unsafe",
      contentSha256: entry.objectContentSha256,
    };
  }
  return parseAdapterGenerationObjectContent(entry, content, parseInstalled);
}

function parseAdapterGenerationObjectContent(
  entry: AdapterGenerationPresentEntry,
  content: string | null,
  parseInstalled: (value: unknown) => ParseResult<WrenchManifest>,
): InstalledManifestSnapshot {
  if (content === null || sha256(content) !== entry.objectContentSha256) {
    return {
      result: {
        ok: false,
        issues: ["adapter generation object is missing or hash-mismatched"],
      },
      availability: "unsafe",
      contentSha256: entry.objectContentSha256,
    };
  }
  try {
    const value = JSON.parse(content) as unknown;
    if (`${canonicalJson(value)}\n` !== content) {
      throw new Error("adapter generation object is not canonical JSON");
    }
    const result = parseInstalled(value);
    if (
      result.ok
      && (
        result.value.id !== entry.id
        || manifestHash(result.value) !== entry.manifestHash
      )
    ) {
      return {
        result: {
          ok: false,
          issues: ["adapter generation object identity does not match its index"],
        },
        availability: "unsafe",
        contentSha256: entry.objectContentSha256,
      };
    }
    return {
      result,
      availability: "present",
      contentSha256: entry.objectContentSha256,
    };
  } catch (error) {
    return {
      result: {
        ok: false,
        issues: [error instanceof Error ? error.message : String(error)],
      },
      availability: "unsafe",
      contentSha256: entry.objectContentSha256,
    };
  }
}

function generationEntryById(
  index: AdapterGenerationIndex | null,
  id: string,
): AdapterGenerationEntry | undefined {
  return index?.entries.find((entry) => entry.id === id);
}

function activeAdapterContentSha256(
  index: AdapterGenerationIndex | null,
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const entry = generationEntryById(index, id);
  if (entry?.state === "absent") return null;
  if (entry?.state === "present") {
    const content = readPrivateStateFileIfPresent(
      adapterGenerationObjectPath(entry.objectContentSha256, environment),
      MAX_WRENCH_JSON_BYTES,
      "adapter generation object",
      environment,
    );
    if (
      content === null
      || sha256(content) !== entry.objectContentSha256
    ) {
      throw new Error(
        `installed adapter ${id} generation object is missing or hash-mismatched`,
      );
    }
    return entry.objectContentSha256;
  }
  const content = readPrivateStateFileIfPresent(
    adapterManifestPath(id, environment),
    MAX_WRENCH_JSON_BYTES,
    "installed adapter manifest",
    environment,
  );
  return content === null ? null : sha256(content);
}

function activeAdapterContentSha256Batch(
  index: AdapterGenerationIndex | null,
  ids: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, string | null> {
  const generationEntries = ids
    .map((id) => generationEntryById(index, id))
    .filter(
      (entry): entry is AdapterGenerationPresentEntry =>
        entry?.state === "present",
    );
  const objectContents = new Map<string, string>();
  if (generationEntries.length > 0) {
    const objectsDirectory = adapterGenerationObjectsDirectory(environment);
    const objectNames = [...new Set(generationEntries.map(
      (entry) => `${entry.objectContentSha256}.json`,
    ))];
    const singleBatchMaximum = Math.floor(
      MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES / MAX_WRENCH_JSON_BYTES,
    );
    const files = objectNames.length <= singleBatchMaximum
      ? readPrivateStateFilesBatch(
          objectsDirectory,
          objectNames,
          {
            maximumBytesPerFile: MAX_WRENCH_JSON_BYTES,
            maximumTotalBytes: MAX_WRENCH_JSON_BYTES * objectNames.length,
            environment,
          },
        )
      : (() => {
          const directory = snapshotPrivateStateDirectory(
            objectsDirectory,
            environment,
          );
          if (directory.identity === null) {
            throw new Error(
              `installed adapter ${generationEntries[0]!.id} generation object is missing or hash-mismatched`,
            );
          }
          return readPrivateStateFilesBatched(
            objectsDirectory,
            objectNames,
            {
              maximumBytesPerFile: MAX_WRENCH_JSON_BYTES,
              environment,
              expectedDirectoryIdentity: directory.identity,
            },
          );
        })();
    for (const file of files) {
      if (file.status === "present") {
        objectContents.set(file.name, file.content);
      }
    }
  }

  const results = new Map<string, string | null>();
  for (const id of ids) {
    const entry = generationEntryById(index, id);
    if (entry?.state === "present") {
      const content = objectContents.get(
        `${entry.objectContentSha256}.json`,
      );
      if (
        content === undefined
        || sha256(content) !== entry.objectContentSha256
      ) {
        throw new Error(
          `installed adapter ${id} generation object is missing or hash-mismatched`,
        );
      }
      results.set(id, entry.objectContentSha256);
      continue;
    }
    results.set(
      id,
      activeAdapterContentSha256(index, id, environment),
    );
  }
  return results;
}

export function installBundledAdapterGeneration(
  selections: readonly BundledAdapterGenerationSelection[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: AdapterGenerationInstallTestOptions = {},
): {
  readonly commitId: string;
  readonly installed: number;
  readonly preservedLegacy: number;
} {
  if (
    (options.afterObjectForTest !== undefined || options.afterCommitForTest !== undefined)
    && process.env.NODE_ENV !== "test"
  ) {
    throw new Error("adapter generation fault injection is available only under the test runtime");
  }
  if (
    !isArrayAtRuntime(selections)
    || selections.length < 1
    || selections.length > adapterGenerationMaximumEntries
  ) {
    throw new Error("bundled adapter generation selection count is invalid");
  }
  const ids = selections.map((selection) => selection.id);
  if (
    ids.some((id) => !isAdapterId(id))
    || new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)
  ) {
    throw new Error("bundled adapter generation selections require unique sorted IDs");
  }
  for (const selection of selections) {
    const expected = selection.expectedCurrentContentSha256;
    if (
      expected !== undefined
      && expected !== null
      && !contentSha256Pattern.test(expected)
    ) {
      throw new Error(
        `bundled adapter ${selection.id} expected content hash is invalid`,
      );
    }
  }

  return withAdapterGenerationTransaction(environment, (claim, current) => {
    const guardedIds = selections
      .filter((selection) =>
        selection.expectedCurrentContentSha256 !== undefined
      )
      .map((selection) => selection.id);
    const activeContentSha256 = activeAdapterContentSha256Batch(
      current,
      guardedIds,
      environment,
    );
    const entries = new Map(
      (current?.entries ?? []).map((entry) => [entry.id, entry] as const),
    );
    const changedIds = new Set<string>();
    let installed = 0;
    let preservedLegacy = 0;
    let completedObjects = 0;
    for (const selection of selections) {
      if (selection.expectedCurrentContentSha256 !== undefined) {
        const actual = activeContentSha256.get(selection.id);
        if (actual !== selection.expectedCurrentContentSha256) {
          throw new Error(
            `installed adapter ${selection.id} changed after it was classified; retry the bundled adapter sync`,
          );
        }
      }
      if (selection.state === "legacy") {
        if (entries.delete(selection.id)) changedIds.add(selection.id);
        preservedLegacy += 1;
        continue;
      }
      if (selection.manifest.id !== selection.id) {
        throw new Error("bundled adapter generation selection ID does not match its manifest");
      }
      const canonicalContent = `${canonicalJson(selection.manifest)}\n`;
      const candidateObjectHash = sha256(canonicalContent);
      const candidateManifestHash = manifestHash(selection.manifest);
      const existing = entries.get(selection.id);
      const entry = existing?.state === "present"
        && existing.objectContentSha256 === candidateObjectHash
        && existing.manifestHash === candidateManifestHash
        && existing.sourceContentSha256 === selection.sourceContentSha256
        ? existing
        : publishAdapterGenerationObject(
            selection.manifest,
            selection.sourceContentSha256,
            environment,
            requireManifestRegistry(options.registry),
          );
      if (entry !== existing) changedIds.add(selection.id);
      entries.set(selection.id, entry);
      installed += 1;
      if (entry !== existing) {
        completedObjects += 1;
        options.afterObjectForTest?.(completedObjects);
      }
    }
    const nextEntries = [...entries.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const pointerChanged = current === null
      || canonicalJson(current.entries) !== canonicalJson(nextEntries);
    const commitId = pointerChanged
      ? claim.record.transactionId
      : current.commitId;
    if (pointerChanged) {
      writeAdapterGenerationIndex(nextEntries, commitId, environment);
      options.afterCommitForTest?.();
    }

    // Keep the historical flat layout as a compatibility mirror. The atomic
    // generation index is already authoritative, so interruption here cannot
    // expose a mixed generation to Wrench readers.
    for (const selection of selections) {
      if (
        selection.state !== "present"
        || !changedIds.has(selection.id)
      ) {
        continue;
      }
      writePrivateJson(
        adapterManifestPath(selection.id, environment),
        selection.manifest,
        { privateParent: true },
      );
    }
    return Object.freeze({ commitId, installed, preservedLegacy });
  });
}

export function readManifestFile(
  path: string,
  registry?: ProviderPluginRegistry,
): ParseResult<WrenchManifest> {
  try {
    return parseRuntimeManifest(readJsonFile(path), requireManifestRegistry(registry));
  } catch (error) {
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Parse a retired manifest only as inert migration evidence.
 *
 * Callers must never return this value from installed-state loading or pass it
 * to an execution boundary. Runtime validation remains `readManifestFile`.
 */
export function readDiagnosticManifestFile(
  path: string,
  registry?: ProviderPluginRegistry,
): ParseResult<WrenchManifest> {
  try {
    return parseDiagnosticManifest(
      readJsonFile(path),
      requireManifestRegistry(registry),
    );
  } catch (error) {
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

export type InstalledManifestSnapshot = {
  readonly result: ParseResult<WrenchManifest>;
  readonly availability: "absent" | "present" | "unsafe";
  /** Hash of the exact private file bytes read for this snapshot. */
  readonly contentSha256: string | null;
};

function loadInstalledManifestSnapshotWith(
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
  parseInstalled: (value: unknown) => ParseResult<WrenchManifest>,
): InstalledManifestSnapshot {
  let index: AdapterGenerationIndex | null;
  try {
    index = readAdapterGenerationIndex(environment);
  } catch (error) {
    return {
      result: {
        ok: false,
        issues: [error instanceof Error ? error.message : String(error)],
      },
      availability: "unsafe",
      contentSha256: null,
    };
  }
  const generationEntry = generationEntryById(index, id);
  if (generationEntry?.state === "absent") {
    return {
      result: {
        ok: false,
        issues: [`adapter ${id} is not installed`],
      },
      availability: "absent",
      contentSha256: null,
    };
  }
  if (generationEntry?.state === "present") {
    return readAdapterGenerationObject(
      generationEntry,
      environment,
      parseInstalled,
    );
  }
  const path = adapterManifestPath(id, environment);
  let content: string | null;
  try {
    content = readPrivateStateFileIfPresent(
      path,
      MAX_WRENCH_JSON_BYTES,
      "installed adapter manifest",
      environment,
    );
  } catch (error) {
    return {
      result: { ok: false, issues: [error instanceof Error ? error.message : String(error)] },
      availability: "unsafe",
      contentSha256: null,
    };
  }
  if (content === null) {
    return {
      result: { ok: false, issues: [`adapter ${id} is not installed`] },
      availability: "absent",
      contentSha256: null,
    };
  }
  try {
    return {
      result: parseInstalled(JSON.parse(content) as unknown),
      availability: "present",
      contentSha256: sha256(content),
    };
  } catch (error) {
    return {
      result: { ok: false, issues: [error instanceof Error ? error.message : String(error)] },
      availability: "present",
      contentSha256: sha256(content),
    };
  }
}

export function loadInstalledManifestSnapshot(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  registry?: ProviderPluginRegistry,
): InstalledManifestSnapshot {
  return loadInstalledManifestSnapshotWith(
    id,
    environment,
    (value) => parseRuntimeManifest(value, requireManifestRegistry(registry)),
  );
}

/**
 * Read installed bytes as inert migration evidence. The result is unsafe for
 * capability listing or execution and exists only to compare an archived hash
 * before replacing it with a runtime-valid manifest.
 */
export function loadInstalledDiagnosticManifestSnapshot(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  registry?: ProviderPluginRegistry,
): InstalledManifestSnapshot {
  const resolvedRegistry = requireManifestRegistry(registry);
  return loadInstalledManifestSnapshotWith(
    id,
    environment,
    (value) => parseDiagnosticManifest(value, resolvedRegistry),
  );
}

export function listInstalledDiagnosticManifestSnapshots(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  registry?: ProviderPluginRegistry,
): readonly {
  readonly id: string;
  readonly snapshot: InstalledManifestSnapshot;
}[] {
  const results = new Map<string, InstalledManifestSnapshot>();
  const directory = adapterDirectory(environment);
  const legacyDirectory = snapshotPrivateStateDirectory(directory, environment);
  if (legacyDirectory.identity !== null) {
    const entries = legacyDirectory.entries.filter((entry) =>
      entry.kind === "directory" && isAdapterId(entry.name)
    );
    const readable = entries.filter(
      (entry): entry is PrivateStateDirectoryEntry & {
        readonly identity: PrivateDirectoryIdentity;
      } => entry.identity !== undefined,
    );
    const files = readPrivateStateChildFilesBatched(
      directory,
      readable.map((entry) => ({
        directoryName: entry.name,
        directoryIdentity: entry.identity,
        fileName: "io-adapter.json",
      })),
      {
        maximumBytesPerFile: MAX_WRENCH_JSON_BYTES,
        environment,
        expectedDirectoryIdentity: legacyDirectory.identity,
      },
    );
    const byId = new Map(files.map((file) => [file.directoryName, file]));
    for (const entry of entries) {
      const file = byId.get(entry.name);
      if (file?.status !== "present") {
        results.set(entry.name, {
          result: {
            ok: false,
            issues: ["installed adapter manifest is unavailable"],
          },
          availability: "unsafe",
          contentSha256: null,
        });
        continue;
      }
      const contentSha256 = sha256(file.content);
      try {
        results.set(entry.name, {
          result: parseDiagnosticManifest(
            JSON.parse(file.content) as unknown,
            requireManifestRegistry(registry),
          ),
          availability: "present",
          contentSha256,
        });
      } catch (error) {
        results.set(entry.name, {
          result: {
            ok: false,
            issues: [error instanceof Error ? error.message : String(error)],
          },
          availability: "present",
          contentSha256,
        });
      }
    }
  }

  const generation = readAdapterGenerationIndex(environment);
  const presentEntries = (generation?.entries ?? []).filter(
    (entry): entry is AdapterGenerationPresentEntry =>
      entry.state === "present",
  );
  const objectContents = new Map<string, string | null>();
  if (presentEntries.length > 0) {
    const objectsDirectory = adapterGenerationObjectsDirectory(environment);
    const objectsSnapshot = snapshotPrivateStateDirectory(
      objectsDirectory,
      environment,
    );
    if (objectsSnapshot.identity !== null) {
      const names = [...new Set(presentEntries.map((entry) =>
        `${entry.objectContentSha256}.json`
      ))];
      const files = readPrivateStateFilesBatched(
        objectsDirectory,
        names,
        {
          maximumBytesPerFile: MAX_WRENCH_JSON_BYTES,
          environment,
          expectedDirectoryIdentity: objectsSnapshot.identity,
        },
      );
      for (const file of files) {
        objectContents.set(
          file.name,
          file.status === "present" ? file.content : null,
        );
      }
    }
  }
  for (const entry of generation?.entries ?? []) {
    if (entry.state === "absent") {
      results.delete(entry.id);
      continue;
    }
    results.set(
      entry.id,
      parseAdapterGenerationObjectContent(
        entry,
        objectContents.get(`${entry.objectContentSha256}.json`) ?? null,
        (value) => parseDiagnosticManifest(
          value,
          requireManifestRegistry(registry),
        ),
      ),
    );
  }
  return Object.freeze(
    [...results.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, snapshot]) => Object.freeze({ id, snapshot })),
  );
}

export function loadInstalledManifest(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  registry?: ProviderPluginRegistry,
): ParseResult<WrenchManifest> {
  return loadInstalledManifestSnapshot(id, environment, registry).result;
}

export function installManifest(
  manifest: WrenchManifest,
  options: {
    readonly force: boolean;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    /** Exact private-file hash returned by loadInstalledManifestSnapshot. */
    readonly expectedCurrentContentSha256?: string;
    /** Test seam for deterministic same-UID replacement interleavings. */
    readonly beforeReplace?: () => void;
    /** Registry that owns any non-built-in provider contracts in this manifest. */
    readonly registry?: ProviderPluginRegistry;
  },
): string {
  const registry = requireManifestRegistry(options.registry);
  const parsed = parseRuntimeManifest(manifest, registry);
  if (!parsed.ok) throw new Error(`invalid runtime manifest: ${parsed.issues.join("; ")}`);
  if (canonicalJson(parsed.value) !== canonicalJson(manifest)) {
    throw new Error("runtime manifest contains unsupported or non-canonical state");
  }
  manifest = parsed.value;
  if (
    options.expectedCurrentContentSha256 !== undefined
    && !contentSha256Pattern.test(options.expectedCurrentContentSha256)
  ) throw new Error("expected installed manifest content hash is invalid");
  if (
    !options.force
    && (
      options.expectedCurrentContentSha256 !== undefined
      || options.beforeReplace !== undefined
    )
  ) {
    throw new Error("conditional manifest replacement requires force");
  }
  const environment = options.environment ?? process.env;
  const path = adapterManifestPath(manifest.id, environment);
  return withAdapterGenerationTransaction(environment, (claim, index) => {
    const generationEntry = generationEntryById(index, manifest.id);
    if (generationEntry !== undefined) {
      const installed = generationEntry.state === "present"
        ? readAdapterGenerationObject(
            generationEntry,
            environment,
            (value) => parseRuntimeManifest(value, registry),
          )
        : {
            result: {
              ok: false as const,
              issues: [`adapter ${manifest.id} is not installed`],
            },
            contentSha256: null,
          };
      if (!options.force) {
        if (
          installed.result.ok
          && canonicalJson(installed.result.value) === canonicalJson(manifest)
        ) {
          writePrivateJson(path, manifest, { privateParent: true });
          return path;
        }
        if (generationEntry.state === "present") {
          throw new Error(
            `adapter ${manifest.id} is already installed and differs; pass --force to replace it`,
          );
        }
      }
      if (
        options.expectedCurrentContentSha256 !== undefined
        && installed.contentSha256 !== options.expectedCurrentContentSha256
      ) {
        throw new Error("state file content no longer matches the expected hash");
      }
      options.beforeReplace?.();
      if (
        options.beforeReplace !== undefined
        && canonicalJson(readAdapterGenerationIndex(environment))
          !== canonicalJson(index)
      ) {
        throw new Error("adapter generation changed before manifest replacement");
      }
      const canonicalContentSha256 = sha256(`${canonicalJson(manifest)}\n`);
      const nextEntry = publishAdapterGenerationObject(
        manifest,
        canonicalContentSha256,
        environment,
        registry,
      );
      const entries = new Map(
        (index?.entries ?? []).map((entry) => [entry.id, entry] as const),
      );
      entries.set(manifest.id, nextEntry);
      writeAdapterGenerationIndex(
        [...entries.values()].sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
        claim.record.transactionId,
        environment,
      );
      writePrivateJson(path, manifest, { privateParent: true });
      return path;
    }

    if (!options.force) {
      const result = createPrivateJsonIfAbsent(path, manifest, {
        privateParent: true,
        environment,
      });
      if (result.created) return path;
      const installed = readManifestFile(path, options.registry);
      if (
        installed.ok
        && canonicalJson(installed.value) === canonicalJson(manifest)
      ) {
        return path;
      }
      throw new Error(
        `adapter ${manifest.id} is already installed and differs; pass --force to replace it`,
      );
    }
    const root = wrenchStateHome(environment);
    const identity = ensureClaimedStateRoot(root);
    const segments = stateSegments(root, path);
    const directoryExpectations = captureStateDirectoryExpectations(
      root,
      segments.slice(0, -1),
    );
    options.beforeReplace?.();
    runStateHelper(root, identity, {
      kind: "write-file",
      segments,
      directoryExpectations,
      content: `${canonicalJson(manifest)}\n`,
      createOnly: false,
      expectedContentSha256: options.expectedCurrentContentSha256 ?? null,
    });
    return path;
  });
}

export function removeInstalledManifest(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return withAdapterGenerationTransaction(environment, (claim, index) => {
    const path = adapterManifestPath(id, environment);
    const generationEntry = generationEntryById(index, id);
    if (generationEntry !== undefined) {
      if (generationEntry.state === "absent") return false;
      const entries = new Map(
        (index?.entries ?? []).map((entry) => [entry.id, entry] as const),
      );
      entries.set(id, Object.freeze({ id, state: "absent" }));
      writeAdapterGenerationIndex(
        [...entries.values()].sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
        claim.record.transactionId,
        environment,
      );
      removePrivateStateFile(path, environment);
      removePrivateEmptyStateDirectory(dirname(path), environment);
      return true;
    }
    const removed = removePrivateStateFile(path, environment);
    if (!removed) return false;
    removePrivateEmptyStateDirectory(dirname(path), environment);
    return true;
  });
}

export function listInstalledManifests(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  registry?: ProviderPluginRegistry,
): readonly { readonly id: string; readonly result: ParseResult<WrenchManifest> }[] {
  return Object.freeze(
    listInstalledDiagnosticManifestSnapshots(environment, registry).map(
      ({ id, snapshot }) => Object.freeze({
        id,
        result: snapshot.result.ok
          ? parseRuntimeManifest(
              snapshot.result.value,
              requireManifestRegistry(registry),
            )
          : snapshot.result,
      }),
    ),
  );
}
