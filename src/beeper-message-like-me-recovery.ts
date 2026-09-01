import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  captureProcessOwnerIdentity,
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
  type ProcessOwnerStatus,
} from "./process-identity";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateDirectory,
  readPrivateStateFileIfPresent,
  removePrivateDirectoryTree,
  removePrivateStateFileIfUnchanged,
  snapshotPrivateStateDirectory,
  readPrivateStateFilesBatch,
  wrenchStateHome,
  writePrivateJsonIfUnchanged,
} from "./storage";

const CLAIM_KIND = "beeper-message-like-me-directory-lease";
const CLAIM_SCHEMA_VERSION = 2;
const EXPORT_ADMISSION_KIND = "beeper-message-like-me-export-admission";
const EXPORT_ADMISSION_SCHEMA_VERSION = 2;
const EXPORT_ADMISSION_FILE = "active.json";
const MAX_EXPORT_ADMISSION_ACQUIRE_ATTEMPTS = 8;
const MAX_CLAIMS = 64;
const MAX_CLAIM_BYTES = 16 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

type LeaseRole = "raw-working" | "bundle-stage";
type RawPhase = "preparing" | "launching" | "running" | "settled";

type LegacyExportAdmissionClaim = Readonly<{
  schemaVersion: 1;
  kind: typeof EXPORT_ADMISSION_KIND;
  id: string;
  owner: ProcessOwnerIdentity;
}>;

export type BeeperMessageLikeMeExportAdmissionPhase =
  | "parent-owned"
  | "helper-launching"
  | "helper-active"
  | "cleanup-unsafe";

type LegacyExportAdmissionClaimV2 = Readonly<{
  schemaVersion: 2;
  kind: typeof EXPORT_ADMISSION_KIND;
  id: string;
  owner: ProcessOwnerIdentity;
  helperOwner: ProcessOwnerIdentity | null;
  phase: BeeperMessageLikeMeExportAdmissionPhase;
}>;

type ExportAdmissionClaimV2 = Readonly<{
  schemaVersion: 2;
  kind: typeof EXPORT_ADMISSION_KIND;
  id: string;
  owner: ProcessOwnerIdentity;
  helperOwner: ProcessOwnerIdentity | null;
  phase: BeeperMessageLikeMeExportAdmissionPhase;
  /** Rotated on every lifecycle write so a stale controller cannot win an ABA CAS. */
  revision: string;
}>;

type ExportAdmissionClaim =
  | LegacyExportAdmissionClaim
  | LegacyExportAdmissionClaimV2
  | ExportAdmissionClaimV2;

type ExportAdmissionSnapshot = Readonly<{
  claim: ExportAdmissionClaim;
  contentSha256: string;
}>;

export type BeeperMessageLikeMeExportAdmission = {
  readonly claimPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly claimId: string;
  claim: ExportAdmissionClaimV2;
  contentSha256: string;
  released: boolean;
};

type LeaseDirectoryIdentity = Readonly<{
  device: string;
  inode: string;
  /** Stable across rename and distinct across inode reuse. */
  birthtimeNs: string;
}>;

type DirectoryLeaseClaim = Readonly<{
  schemaVersion: 2;
  kind: typeof CLAIM_KIND;
  id: string;
  role: LeaseRole;
  path: string;
  parentPath: string;
  parentIdentity: LeaseDirectoryIdentity;
  directoryIdentity: LeaseDirectoryIdentity;
  outputRoot: string | null;
  owner: ProcessOwnerIdentity;
  childOwner: ProcessOwnerIdentity | null;
  phase: RawPhase;
  createdAtMs: number;
  recoverAfterMs: number;
}>;

export type BeeperMessageLikeMeDirectoryLease = {
  readonly claimPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  claim: DirectoryLeaseClaim;
  contentSha256: string;
  released: boolean;
};

export type BeeperMessageLikeMeRecoveryReport = Readonly<{
  recovered: number;
  published: number;
  active: number;
  indeterminate: number;
}>;

function fail(message: string): never {
  throw new Error(`Beeper Message Like Me recovery: ${message}`);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return fail(`${label} must be a plain object`);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) fail(`${label} has an unsupported shape`);
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || resolve(value) !== value
    || value.length > 4_096
    || /[\0\r\n]/u.test(value)
  ) return fail(`${label} is invalid`);
  return value;
}

function identity(value: unknown, label: string): LeaseDirectoryIdentity {
  const source = record(value, label);
  exactKeys(source, ["birthtimeNs", "device", "inode"], label);
  if (
    typeof source.device !== "string"
    || !/^\d{1,40}$/u.test(source.device)
    || typeof source.inode !== "string"
    || !/^\d{1,40}$/u.test(source.inode)
    || typeof source.birthtimeNs !== "string"
    || !/^[1-9]\d{0,39}$/u.test(source.birthtimeNs)
  ) return fail(`${label} is invalid`);
  return Object.freeze({
    device: source.device,
    inode: source.inode,
    birthtimeNs: source.birthtimeNs,
  });
}

function owner(value: unknown, label: string): ProcessOwnerIdentity {
  const source = record(value, label);
  exactKeys(source, ["bootId", "pid", "processStartId"], label);
  if (
    typeof source.pid !== "number"
    || !Number.isSafeInteger(source.pid)
    || source.pid < 1
    || source.pid > 2_147_483_647
    || typeof source.bootId !== "string"
    || !DIGEST_PATTERN.test(source.bootId)
    || typeof source.processStartId !== "string"
    || !DIGEST_PATTERN.test(source.processStartId)
  ) return fail(`${label} is invalid`);
  return Object.freeze({
    pid: source.pid,
    bootId: source.bootId,
    processStartId: source.processStartId,
  });
}

function parseExportAdmission(value: unknown): ExportAdmissionClaim {
  const source = record(value, "export admission");
  const legacy = source.schemaVersion === 1;
  const currentV2 = source.schemaVersion === 2 && Object.hasOwn(source, "revision");
  exactKeys(
    source,
    legacy
      ? ["id", "kind", "owner", "schemaVersion"]
      : currentV2
        ? ["helperOwner", "id", "kind", "owner", "phase", "revision", "schemaVersion"]
        : ["helperOwner", "id", "kind", "owner", "phase", "schemaVersion"],
    "export admission",
  );
  if (
    (source.schemaVersion !== 1 && source.schemaVersion !== EXPORT_ADMISSION_SCHEMA_VERSION)
    || source.kind !== EXPORT_ADMISSION_KIND
    || typeof source.id !== "string"
    || !UUID_PATTERN.test(source.id)
  ) return fail("export admission identity is invalid");
  if (legacy) {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: EXPORT_ADMISSION_KIND,
      id: source.id,
      owner: owner(source.owner, "export admission owner"),
    });
  }
  if (
    !["parent-owned", "helper-launching", "helper-active", "cleanup-unsafe"].includes(
      typeof source.phase === "string" ? source.phase : "",
    )
    || (source.phase === "helper-active" && source.helperOwner === null)
    || ((source.phase === "parent-owned" || source.phase === "helper-launching")
      && source.helperOwner !== null)
  ) return fail("export admission lifecycle is invalid");
  const parsed = {
    schemaVersion: 2 as const,
    kind: EXPORT_ADMISSION_KIND,
    id: source.id,
    owner: owner(source.owner, "export admission owner"),
    helperOwner: source.helperOwner === null
      ? null
      : owner(source.helperOwner, "export admission helper owner"),
    phase: source.phase as BeeperMessageLikeMeExportAdmissionPhase,
  } as const;
  if (!currentV2) return Object.freeze(parsed);
  if (typeof source.revision !== "string" || !UUID_PATTERN.test(source.revision)) {
    return fail("export admission revision is invalid");
  }
  return Object.freeze({ ...parsed, revision: source.revision });
}

function milliseconds(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) return fail(`${label} is invalid`);
  return value;
}

function parseClaim(value: unknown): DirectoryLeaseClaim {
  const source = record(value, "directory lease");
  exactKeys(source, [
    "childOwner",
    "createdAtMs",
    "directoryIdentity",
    "id",
    "kind",
    "outputRoot",
    "owner",
    "parentIdentity",
    "parentPath",
    "path",
    "phase",
    "recoverAfterMs",
    "role",
    "schemaVersion",
  ], "directory lease");
  if (
    source.schemaVersion !== CLAIM_SCHEMA_VERSION
    || source.kind !== CLAIM_KIND
    || typeof source.id !== "string"
    || !UUID_PATTERN.test(source.id)
    || (source.role !== "raw-working" && source.role !== "bundle-stage")
    || !["preparing", "launching", "running", "settled"].includes(
      typeof source.phase === "string" ? source.phase : "",
    )
  ) return fail("directory lease identity is invalid");
  const path = boundedPath(source.path, "directory lease path");
  const parentPath = boundedPath(source.parentPath, "directory lease parent");
  const outputRoot = source.outputRoot === null
    ? null
    : boundedPath(source.outputRoot, "directory lease output");
  const createdAtMs = milliseconds(source.createdAtMs, "directory lease creation time");
  const recoverAfterMs = milliseconds(
    source.recoverAfterMs,
    "directory lease recovery time",
  );
  if (
    dirname(path) !== parentPath
    || recoverAfterMs < createdAtMs
    || (source.role === "bundle-stage") !== (outputRoot !== null)
    || (outputRoot !== null && dirname(outputRoot) !== parentPath)
    || (source.role === "bundle-stage" && source.phase !== "preparing")
    || (source.role === "bundle-stage" && source.childOwner !== null)
    || (source.phase === "running") !== (source.childOwner !== null)
  ) return fail("directory lease coordinates are inconsistent");
  return Object.freeze({
    schemaVersion: 2,
    kind: CLAIM_KIND,
    id: source.id,
    role: source.role,
    path,
    parentPath,
    parentIdentity: identity(source.parentIdentity, "directory lease parent identity"),
    directoryIdentity: identity(
      source.directoryIdentity,
      "directory lease directory identity",
    ),
    outputRoot,
    owner: owner(source.owner, "directory lease owner"),
    childOwner: source.childOwner === null
      ? null
      : owner(source.childOwner, "directory lease child owner"),
    phase: source.phase as RawPhase,
    createdAtMs,
    recoverAfterMs,
  });
}

function claimBytes(claim: DirectoryLeaseClaim): string {
  return `${canonicalJson(claim)}\n`;
}

function claimSha256(claim: DirectoryLeaseClaim): string {
  return sha256(claimBytes(claim));
}

function leaseRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(
    wrenchStateHome(environment),
    "recovery",
    "beeper-message-like-me-directory-leases",
  );
}

function exportAdmissionRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(
    wrenchStateHome(environment),
    "recovery",
    "beeper-message-like-me-export-admission",
  );
}

function exportAdmissionBytes(claim: ExportAdmissionClaim): string {
  return `${canonicalJson(claim)}\n`;
}

function readExportAdmission(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
): ExportAdmissionSnapshot | null {
  const content = readPrivateStateFileIfPresent(
    join(root, EXPORT_ADMISSION_FILE),
    MAX_CLAIM_BYTES,
    "Beeper Message Like Me export admission",
    environment,
  );
  if (content === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch {
    return fail("export admission is not valid JSON");
  }
  const claim = parseExportAdmission(decoded);
  if (content !== exportAdmissionBytes(claim)) {
    return fail("export admission is not canonical");
  }
  return Object.freeze({ claim, contentSha256: sha256(content) });
}

function stateMutationCreateContention(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("state file mutation is already active");
}

function acquiredExportAdmission(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  snapshot: ExportAdmissionSnapshot,
): BeeperMessageLikeMeExportAdmission {
  if (snapshot.claim.schemaVersion !== 2 || !("revision" in snapshot.claim)) {
    return fail("a legacy export admission cannot be acquired as current ownership");
  }
  return {
    claimPath: join(root, EXPORT_ADMISSION_FILE),
    environment,
    claimId: snapshot.claim.id,
    claim: snapshot.claim,
    contentSha256: snapshot.contentSha256,
    released: false,
  };
}

function exportAdmissionDisposition(
  claim: ExportAdmissionClaim,
  inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
  currentBootId: string,
): "active" | "indeterminate" | "recoverable" {
  const parent = inspectOwner(claim.owner);
  if (parent === "exact-live-owner") return "active";
  if (parent === "unknown") return "indeterminate";
  if (claim.schemaVersion === 1) {
    // The released v1 admission recorded only the parent even though its
    // detached per-page helper could outlive that parent. Only a kernel reboot
    // proves that an unrecorded legacy helper cannot still be running.
    return claim.owner.bootId === currentBootId ? "indeterminate" : "recoverable";
  }
  if (
    claim.helperOwner !== null
    && claim.helperOwner.bootId !== claim.owner.bootId
  ) return "indeterminate";
  if (claim.phase === "cleanup-unsafe") {
    // cleanup-unsafe means the recorded helper is not a complete ownership
    // proof: a descendant or process-group member may have survived after the
    // recorded child exited. Only a reboot proves every such process is gone.
    return claim.owner.bootId === currentBootId ? "indeterminate" : "recoverable";
  }
  if (claim.phase === "parent-owned") return "recoverable";
  // Only a reboot proves that an unjoined helper, its streams, and its process
  // group cannot still retain private work after the supervising parent exits.
  if (claim.owner.bootId !== currentBootId) return "recoverable";
  if (claim.helperOwner === null) return "indeterminate";
  const helper = inspectOwner(claim.helperOwner);
  return helper === "exact-live-owner"
    ? "active"
    : "indeterminate";
}

export function acquireBeeperMessageLikeMeExportAdmission(options: Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  /** Test-only process-liveness seam. */
  inspectOwnerForTest?: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus;
  /** Test-only exact kernel boot identity seam. */
  currentBootIdForTest?: string;
}> = {}): BeeperMessageLikeMeExportAdmission {
  if (
    (options.inspectOwnerForTest !== undefined || options.currentBootIdForTest !== undefined)
    && process.env.NODE_ENV !== "test"
  ) return fail("export admission liveness injection is available only in tests");
  const environment = options.environment ?? process.env;
  const inspectOwner = options.inspectOwnerForTest ?? processOwnerStatus;
  const currentBootId = options.currentBootIdForTest
    ?? currentProcessStartIdentity().bootId;
  if (!DIGEST_PATTERN.test(currentBootId)) return fail("current boot identity is invalid");
  const root = exportAdmissionRoot(environment);
  try {
    ensurePrivateDirectory(root);
    for (
      let attempt = 0;
      attempt < MAX_EXPORT_ADMISSION_ACQUIRE_ATTEMPTS;
      attempt += 1
    ) {
      const observed = readExportAdmission(root, environment);
      if (observed !== null) {
        const disposition = exportAdmissionDisposition(
          observed.claim,
          inspectOwner,
          currentBootId,
        );
        if (disposition === "active") {
          return fail("another export is active");
        }
        if (disposition === "indeterminate") {
          return fail("prior export owner cannot be inspected safely");
        }
        if (!removePrivateStateFileIfUnchanged(
          join(root, EXPORT_ADMISSION_FILE),
          { expectedCurrentContentSha256: observed.contentSha256 },
          environment,
        )) continue;
      }

      const processIdentity = currentProcessStartIdentity();
      const claim = Object.freeze({
        schemaVersion: 2 as const,
        kind: EXPORT_ADMISSION_KIND,
        id: randomUUID(),
        owner: Object.freeze({ pid: process.pid, ...processIdentity }),
        helperOwner: null,
        phase: "parent-owned" as const,
        revision: randomUUID(),
      });
      const snapshot = Object.freeze({
        claim,
        contentSha256: sha256(exportAdmissionBytes(claim)),
      });
      let created = false;
      try {
        created = createPrivateJsonIfAbsent(
          join(root, EXPORT_ADMISSION_FILE),
          claim,
          { environment },
        ).created;
      } catch (error) {
        const committed = readExportAdmission(root, environment);
        if (
          committed !== null
          && committed.contentSha256 === snapshot.contentSha256
        ) return acquiredExportAdmission(root, environment, snapshot);
        if (!stateMutationCreateContention(error)) throw error;
      }
      if (created) return acquiredExportAdmission(root, environment, snapshot);
    }
    return fail("export admission could not be acquired after bounded contention");
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Beeper Message Like Me recovery:")
    ) throw error;
    return fail("export admission could not be acquired safely");
  }
}

function updateExportAdmission(
  admission: BeeperMessageLikeMeExportAdmission,
  phase: BeeperMessageLikeMeExportAdmissionPhase,
  helperOwner: ProcessOwnerIdentity | null,
): void {
  if (admission.released) return fail("released export admission cannot change lifecycle");
  const current = admission.claim.phase;
  const valid =
    (phase === "helper-launching" && current === "parent-owned" && helperOwner === null)
    || (phase === "helper-active" && current === "helper-launching" && helperOwner !== null)
    || (phase === "parent-owned"
      && (current === "helper-launching" || current === "helper-active")
      && helperOwner === null)
    || (phase === "cleanup-unsafe"
      && current !== "parent-owned"
      && (helperOwner === null || current === "helper-active"));
  if (!valid) return fail("export admission lifecycle transition is invalid");
  const next = Object.freeze({
    ...admission.claim,
    phase,
    helperOwner,
    revision: randomUUID(),
  });
  try {
    if (!writePrivateJsonIfUnchanged(admission.claimPath, next, {
      expectedCurrentContentSha256: admission.contentSha256,
    })) return fail("export admission changed before lifecycle update");
    admission.claim = next;
    admission.contentSha256 = sha256(exportAdmissionBytes(next));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Beeper Message Like Me recovery:")) {
      throw error;
    }
    return fail("export admission lifecycle could not be updated safely");
  }
}

export function beginBeeperMessageLikeMeHelperLaunch(
  admission: BeeperMessageLikeMeExportAdmission,
): void {
  updateExportAdmission(admission, "helper-launching", null);
}

export function bindBeeperMessageLikeMeHelperOwner(
  admission: BeeperMessageLikeMeExportAdmission,
  childPid: number,
): void {
  if (!Number.isSafeInteger(childPid) || childPid < 1 || childPid > 2_147_483_647) {
    return fail("export admission helper PID is invalid");
  }
  updateExportAdmission(admission, "helper-active", captureProcessOwnerIdentity(childPid));
}

export function settleBeeperMessageLikeMeHelper(
  admission: BeeperMessageLikeMeExportAdmission,
): void {
  updateExportAdmission(admission, "parent-owned", null);
}

export function markBeeperMessageLikeMeHelperCleanupUnsafe(
  admission: BeeperMessageLikeMeExportAdmission,
): void {
  updateExportAdmission(admission, "cleanup-unsafe", admission.claim.helperOwner);
}

export function releaseBeeperMessageLikeMeExportAdmission(
  admission: BeeperMessageLikeMeExportAdmission,
): void {
  if (admission.released) return;
  if (admission.claim.phase !== "parent-owned" || admission.claim.helperOwner !== null) {
    return fail("export admission cannot release an unsettled helper lifecycle");
  }
  try {
    if (!removePrivateStateFileIfUnchanged(admission.claimPath, {
      expectedCurrentContentSha256: admission.contentSha256,
    }, admission.environment)) return fail("export admission changed before release");
    admission.released = true;
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Beeper Message Like Me recovery:")
    ) throw error;
    return fail("export admission could not be released safely");
  }
}

async function physicalDirectoryIdentity(
  path: string,
  privateMode: boolean,
): Promise<LeaseDirectoryIdentity> {
  const canonical = await realpath(path);
  const metadata = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    canonical !== path
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || uid === undefined
    || metadata.uid !== BigInt(uid)
    || metadata.birthtimeNs <= 0n
    || (privateMode
      ? (metadata.mode & 0o777n) !== 0o700n
      : (metadata.mode & 0o022n) !== 0n)
  ) return fail("directory lease target is not an owned physical directory");
  return Object.freeze({
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    birthtimeNs: metadata.birthtimeNs.toString(),
  });
}

function sameIdentity(
  left: LeaseDirectoryIdentity,
  right: LeaseDirectoryIdentity,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNs === right.birthtimeNs;
}

export async function createBeeperMessageLikeMeDirectoryLease(request: Readonly<{
  role: LeaseRole;
  path: string;
  outputRoot?: string;
  recoverAfterMs: number;
  environment?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
}>): Promise<BeeperMessageLikeMeDirectoryLease> {
  const environment = request.environment ?? process.env;
  const path = boundedPath(request.path, "directory lease path");
  const parentPath = dirname(path);
  const outputRoot = request.outputRoot === undefined
    ? null
    : boundedPath(request.outputRoot, "directory lease output");
  const nowMs = milliseconds(request.nowMs ?? Date.now(), "directory lease creation time");
  if (
    !Number.isSafeInteger(request.recoverAfterMs)
    || request.recoverAfterMs < nowMs
    || (request.role === "bundle-stage") !== (outputRoot !== null)
    || (outputRoot !== null && dirname(outputRoot) !== parentPath)
  ) return fail("directory lease request is invalid");
  const processIdentity = currentProcessStartIdentity();
  const claim = Object.freeze({
    schemaVersion: 2 as const,
    kind: CLAIM_KIND,
    id: randomUUID(),
    role: request.role,
    path,
    parentPath,
    parentIdentity: await physicalDirectoryIdentity(parentPath, false),
    directoryIdentity: await physicalDirectoryIdentity(path, true),
    outputRoot,
    owner: Object.freeze({ pid: process.pid, ...processIdentity }),
    childOwner: null,
    phase: "preparing" as const,
    createdAtMs: nowMs,
    recoverAfterMs: request.recoverAfterMs,
  });
  const root = leaseRoot(environment);
  try {
    ensurePrivateDirectory(root);
    const claimPath = join(root, `${claim.id}.json`);
    if (!createPrivateJsonIfAbsent(claimPath, claim, { environment }).created) {
      return fail("directory lease ID was already present");
    }
    return {
      claimPath,
      environment,
      claim,
      contentSha256: claimSha256(claim),
      released: false,
    };
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Beeper Message Like Me recovery:")
    ) throw error;
    return fail("directory lease could not be created safely");
  }
}

export function updateBeeperMessageLikeMeDirectoryLease(
  lease: BeeperMessageLikeMeDirectoryLease,
  phase: RawPhase,
  childPid?: number,
): void {
  if (lease.released || lease.claim.role !== "raw-working") {
    return fail("only an active raw directory lease can change phase");
  }
  const currentPhase = lease.claim.phase;
  const transitionIsValid =
    (phase === "launching"
      && (currentPhase === "preparing" || currentPhase === "settled"))
    || (phase === "running" && currentPhase === "launching")
    || (
      phase === "settled"
      && (currentPhase === "launching" || currentPhase === "running")
    );
  if (!transitionIsValid) {
    return fail("raw directory lease lifecycle transition is invalid");
  }
  let childOwner: ProcessOwnerIdentity | null = null;
  if (phase === "running") {
    if (
      childPid === undefined
      || !Number.isSafeInteger(childPid)
      || childPid < 1
      || childPid > 2_147_483_647
    ) return fail("running directory lease requires a child process identity");
    childOwner = captureProcessOwnerIdentity(childPid);
  } else if (childPid !== undefined) {
    return fail("only a running directory lease accepts a child process identity");
  }
  const next = Object.freeze({ ...lease.claim, phase, childOwner });
  try {
    if (!writePrivateJsonIfUnchanged(lease.claimPath, next, {
      expectedCurrentContentSha256: lease.contentSha256,
    })) return fail("directory lease changed before its lifecycle update");
    lease.claim = next;
    lease.contentSha256 = claimSha256(next);
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Beeper Message Like Me recovery:")
    ) throw error;
    return fail("directory lease lifecycle could not be updated safely");
  }
}

export function releaseBeeperMessageLikeMeDirectoryLease(
  lease: BeeperMessageLikeMeDirectoryLease,
): void {
  if (lease.released) return;
  try {
    if (!removePrivateStateFileIfUnchanged(lease.claimPath, {
      expectedCurrentContentSha256: lease.contentSha256,
    }, lease.environment)) return fail("directory lease changed before release");
    lease.released = true;
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Beeper Message Like Me recovery:")
    ) throw error;
    return fail("directory lease could not be released safely");
  }
}

async function identityIfPresent(path: string): Promise<LeaseDirectoryIdentity | null> {
  try {
    return await physicalDirectoryIdentity(path, true);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function rawLeaseRecoveryDisposition(
  claim: DirectoryLeaseClaim,
  nowMs: number,
  inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
): "active" | "indeterminate" | "recoverable" {
  if (claim.phase === "preparing" || claim.phase === "settled") {
    return "recoverable";
  }
  if (claim.phase === "running" && claim.childOwner !== null) {
    const childStatus = inspectOwner(claim.childOwner);
    return childStatus === "exact-live-owner"
      ? "active"
      : childStatus === "unknown"
        ? "indeterminate"
        : "recoverable";
  }
  return nowMs >= claim.recoverAfterMs ? "recoverable" : "indeterminate";
}

export async function recoverBeeperMessageLikeMeDirectoryLeases(options: Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
  inspectOwner?: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus;
}> = {}): Promise<BeeperMessageLikeMeRecoveryReport> {
  const environment = options.environment ?? process.env;
  const nowMs = milliseconds(options.nowMs ?? Date.now(), "directory recovery time");
  const inspectOwner = options.inspectOwner ?? processOwnerStatus;
  const root = leaseRoot(environment);
  try {
    ensurePrivateDirectory(root);
    const snapshot = snapshotPrivateStateDirectory(
      root,
      environment,
      undefined,
      { recoverOrphanedMutationClaims: true },
    );
    if (snapshot.identity === null || snapshot.entries.length > MAX_CLAIMS) {
      return fail("directory lease collection exceeded its reviewed bound");
    }
    const names = snapshot.entries.map((entry) => {
      if (
        entry.kind !== "file"
        || !UUID_PATTERN.test(entry.name.replace(/\.json$/u, ""))
        || !entry.name.endsWith(".json")
      ) return fail("directory lease collection contains an unsupported entry");
      return entry.name;
    }).sort();
    const files = readPrivateStateFilesBatch(root, names, {
      maximumBytesPerFile: MAX_CLAIM_BYTES,
      maximumTotalBytes: MAX_CLAIM_BYTES * Math.max(1, names.length),
      environment,
      expectedDirectoryIdentity: snapshot.identity,
    });
    let recovered = 0;
    let published = 0;
    let active = 0;
    let indeterminate = 0;
    for (const file of files) {
      if (file.status !== "present") {
        return fail("directory lease changed during recovery inspection");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(file.content) as unknown;
      } catch {
        return fail("directory lease is not valid JSON");
      }
      const claim = parseClaim(decoded);
      if (
        file.name !== `${claim.id}.json`
        || file.content !== claimBytes(claim)
      ) return fail("directory lease is not canonical");
      const claimPath = join(root, file.name);
      const ownerStatus = inspectOwner(claim.owner);
      if (ownerStatus === "exact-live-owner") {
        active += 1;
        continue;
      }
      if (ownerStatus === "unknown") {
        indeterminate += 1;
        continue;
      }
      if (claim.role === "raw-working") {
        const disposition = rawLeaseRecoveryDisposition(
          claim,
          nowMs,
          inspectOwner,
        );
        if (disposition === "active") {
          active += 1;
          continue;
        }
        if (disposition === "indeterminate") {
          indeterminate += 1;
          continue;
        }
      }
      const parentIdentity = await physicalDirectoryIdentity(claim.parentPath, false);
      if (!sameIdentity(parentIdentity, claim.parentIdentity)) {
        return fail("directory lease parent changed before recovery");
      }
      const current = await identityIfPresent(claim.path);
      if (current !== null && !sameIdentity(current, claim.directoryIdentity)) {
        return fail("directory lease target changed before recovery");
      }
      if (current !== null) {
        removePrivateDirectoryTree(claim.path, claim.directoryIdentity);
        recovered += 1;
      } else {
        // Completes an interrupted identity-bound helper quarantine when present.
        if (removePrivateDirectoryTree(claim.path, claim.directoryIdentity)) {
          recovered += 1;
        } else if (claim.outputRoot !== null) {
          const outputIdentity = await identityIfPresent(claim.outputRoot);
          if (
            outputIdentity !== null
            && !sameIdentity(outputIdentity, claim.directoryIdentity)
          ) return fail("directory lease output changed before recovery");
          if (outputIdentity !== null) published += 1;
        }
      }
      if (!removePrivateStateFileIfUnchanged(claimPath, {
        expectedCurrentContentSha256: sha256(file.content),
      }, environment)) return fail("directory lease changed before recovery release");
    }
    return Object.freeze({ recovered, published, active, indeterminate });
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Beeper Message Like Me recovery:")
    ) throw error;
    return fail("directory lease recovery failed safely");
  }
}
