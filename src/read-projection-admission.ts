import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { canonicalJson } from "./canonical-json";
import {
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
} from "./process-identity";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  readPrivateStateFileIfPresent,
  removePrivateStateFileIfUnchanged,
  wrenchStateHome,
  writePrivateJsonIfUnchanged,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

const CONTROL_DIRECTORY = "read-projection-control";
const ADMISSION_DIRECTORY = "admissions";
const INCARNATION_DIRECTORY = "incarnations";
const MAX_CONTROL_RECORD_BYTES = 4 * 1024;
const MAX_ACQUISITION_ATTEMPTS = 16;
export const READ_PROJECTION_SHORT_SETTLEMENT_WAIT_MS = 10_000;
export const READ_PROJECTION_TRANSITION_SETTLEMENT_WAIT_MS = 120_000;
const SETTLEMENT_WAIT_SLICE_MS = 10;
const settlementWaitState = new Int32Array(new SharedArrayBuffer(4));
const authIdPattern = /^[a-z][a-z0-9-]{0,47}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export type ReadProjectionAdmissionOwner = ProcessOwnerIdentity & {
  readonly token: string;
};

export type ReadProjectionAdmissionSettlementOptions = {
  /** Monotonic time budget for a different process's exact-live owner. */
  readonly maximumWaitMs?: number;
};

export type ReadProjectionAdmissionContentionReason =
  | "active-owner"
  | "same-process-owner"
  | "settlement-exhausted";

export class ReadProjectionAdmissionContentionError extends Error {
  readonly authId: string;
  readonly owner: ReadProjectionAdmissionOwner;
  readonly reason: ReadProjectionAdmissionContentionReason;

  constructor(
    authIdValue: string,
    ownerValue: ReadProjectionAdmissionOwner,
    reason: ReadProjectionAdmissionContentionReason,
    options: { readonly cause?: unknown } = {},
  ) {
    const detail = reason === "settlement-exhausted"
      ? "read projection transition did not settle within its bounded wait"
      : reason === "same-process-owner"
        ? "already has an active same-process read projection transition"
        : "already has an active read projection transition";
    super(`auth locator ${authIdValue} ${detail}`, options);
    this.name = "ReadProjectionAdmissionContentionError";
    this.authId = authIdValue;
    this.owner = ownerValue;
    this.reason = reason;
  }
}

type ReadProjectionAdmissionClaim = {
  readonly schemaVersion: 1;
  readonly authId: string;
  readonly owner: ReadProjectionAdmissionOwner;
};

type ReadProjectionIncarnation = {
  readonly schemaVersion: 1;
  readonly authId: string;
  readonly incarnation: string;
};

type Snapshot<T> = {
  readonly value: T;
  readonly contentSha256: string;
};

export type ReadProjectionAuthAdmission = {
  readonly authId: string;
  readonly owner: ReadProjectionAdmissionOwner;
  readonly release: () => void;
};

type HeldAdmission = {
  depth: number;
  readonly admission: ReadProjectionAuthAdmission;
};

const heldAdmissions = new Map<string, HeldAdmission>();

function errorValue(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function isThenable(value: unknown): boolean {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) return false;
  const visited = new Set<object>();
  let current: object | null = value;
  while (current !== null) {
    if (visited.has(current)) return true;
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (descriptor !== undefined) {
      return !("value" in descriptor) || typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function synchronousOperationResult<T>(operation: () => T): T {
  const value = operation();
  if (isThenable(value)) {
    throw new Error(
      "read projection admission operations must be synchronous and must not return thenables",
    );
  }
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function strictRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error(`${label} has unsupported symbol fields`);
  }
  const result: JsonRecord = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} has unsupported accessor fields`);
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

function exactKeys(
  value: Readonly<JsonRecord>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) throw new Error(`${label} has unsupported fields`);
}

function authId(value: unknown): string {
  if (typeof value !== "string" || !authIdPattern.test(value)) {
    throw new Error("read projection auth ID must be lowercase kebab-case");
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function owner(value: unknown): ReadProjectionAdmissionOwner {
  const record = strictRecord(value, "read projection admission owner");
  exactKeys(
    record,
    ["pid", "token", "bootId", "processStartId"],
    "read projection admission owner",
  );
  if (
    typeof record.pid !== "number"
    || !Number.isSafeInteger(record.pid)
    || record.pid < 1
    || record.pid > 2_147_483_647
    || typeof record.token !== "string"
    || !uuidPattern.test(record.token)
  ) throw new Error("read projection admission owner is malformed");
  return Object.freeze({
    pid: record.pid,
    token: record.token,
    bootId: digest(record.bootId, "read projection admission boot identity"),
    processStartId: digest(
      record.processStartId,
      "read projection admission process identity",
    ),
  });
}

function admissionClaim(value: unknown): ReadProjectionAdmissionClaim {
  const record = strictRecord(value, "read projection admission");
  exactKeys(
    record,
    ["schemaVersion", "authId", "owner"],
    "read projection admission",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("read projection admission version is unsupported");
  }
  return Object.freeze({
    schemaVersion: 1,
    authId: authId(record.authId),
    owner: owner(record.owner),
  });
}

function incarnationRecord(value: unknown): ReadProjectionIncarnation {
  const record = strictRecord(value, "read projection auth incarnation");
  exactKeys(
    record,
    ["schemaVersion", "authId", "incarnation"],
    "read projection auth incarnation",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("read projection auth incarnation version is unsupported");
  }
  return Object.freeze({
    schemaVersion: 1,
    authId: authId(record.authId),
    incarnation: digest(
      record.incarnation,
      "read projection auth incarnation",
    ),
  });
}

function controlDirectory(environment: Environment): string {
  return join(wrenchStateHome(environment), CONTROL_DIRECTORY);
}

function admissionsDirectory(environment: Environment): string {
  return join(controlDirectory(environment), ADMISSION_DIRECTORY);
}

function incarnationsDirectory(environment: Environment): string {
  return join(controlDirectory(environment), INCARNATION_DIRECTORY);
}

function authCoordinate(id: string): string {
  return hash(`wrench-read-projection-auth-coordinate-v1\0${id}`);
}

function admissionPath(id: string, environment: Environment): string {
  return join(admissionsDirectory(environment), `${authCoordinate(id)}.json`);
}

function incarnationPath(id: string, environment: Environment): string {
  return join(incarnationsDirectory(environment), `${authCoordinate(id)}.json`);
}

function canonicalSnapshot<T>(value: T): Snapshot<T> {
  const content = `${canonicalJson(value)}\n`;
  return Object.freeze({ value, contentSha256: hash(content) });
}

function parseCanonicalSnapshot<T>(
  content: string,
  label: string,
  parse: (value: unknown) => T,
): Snapshot<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error(`${label} is malformed JSON`);
  }
  const value = parse(parsed);
  if (content !== `${canonicalJson(value)}\n`) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return canonicalSnapshot(value);
}

function readAdmissionClaim(
  id: string,
  environment: Environment,
): Snapshot<ReadProjectionAdmissionClaim> | null {
  const content = readPrivateStateFileIfPresent(
    admissionPath(id, environment),
    MAX_CONTROL_RECORD_BYTES,
    "read projection admission",
    environment,
  );
  if (content === null) return null;
  const snapshot = parseCanonicalSnapshot(
    content,
    "read projection admission",
    admissionClaim,
  );
  if (snapshot.value.authId !== id) {
    throw new Error("read projection admission does not match its coordinate");
  }
  return snapshot;
}

function readIncarnation(
  id: string,
  environment: Environment,
): Snapshot<ReadProjectionIncarnation> | null {
  const content = readRawIncarnation(id, environment);
  if (content === null) return null;
  const snapshot = parseCanonicalSnapshot(
    content.content,
    "read projection auth incarnation",
    incarnationRecord,
  );
  if (snapshot.value.authId !== id) {
    throw new Error(
      "read projection auth incarnation does not match its coordinate",
    );
  }
  return snapshot;
}

function readRawIncarnation(
  id: string,
  environment: Environment,
): { readonly content: string; readonly contentSha256: string } | null {
  const content = readPrivateStateFileIfPresent(
    incarnationPath(id, environment),
    MAX_CONTROL_RECORD_BYTES,
    "read projection auth incarnation",
    environment,
  );
  if (content === null) return null;
  return Object.freeze({ content, contentSha256: hash(content) });
}

function newOwner(): ReadProjectionAdmissionOwner {
  const identity = currentProcessStartIdentity();
  return Object.freeze({
    pid: process.pid,
    token: randomUUID(),
    bootId: identity.bootId,
    processStartId: identity.processStartId,
  });
}

function sameOwner(
  left: ReadProjectionAdmissionOwner,
  right: ReadProjectionAdmissionOwner,
): boolean {
  return left.pid === right.pid
    && left.token === right.token
    && left.bootId === right.bootId
    && left.processStartId === right.processStartId;
}

function assertAdmissionHeld(
  admission: ReadProjectionAuthAdmission,
  environment: Environment,
): void {
  const current = readAdmissionClaim(admission.authId, environment);
  if (
    current === null
    || !sameOwner(current.value.owner, admission.owner)
    || processOwnerStatus(current.value.owner) !== "exact-live-owner"
  ) {
    throw new Error("read projection admission authority is not exact and live");
  }
}

function acquiredAdmission(
  id: string,
  claim: ReadProjectionAdmissionClaim,
  snapshot: Snapshot<ReadProjectionAdmissionClaim>,
  environment: Environment,
  options: {
    /** Test-only seam invoked once after an exact claim loses mutation arbitration. */
    readonly afterReleaseContentionForTest?: () => void;
  } = {},
): ReadProjectionAuthAdmission {
  let released = false;
  return Object.freeze({
    authId: id,
    owner: claim.owner,
    release: () => {
      if (released) return;
      const deadline = performance.now()
        + READ_PROJECTION_SHORT_SETTLEMENT_WAIT_MS;
      let contentionReported = false;
      for (;;) {
        assertAdmissionHeld(
          { authId: id, owner: claim.owner, release: () => {} },
          environment,
        );
        if (removePrivateStateFileIfUnchanged(
          admissionPath(id, environment),
          { expectedCurrentContentSha256: snapshot.contentSha256 },
          environment,
        )) {
          released = true;
          return;
        }

        const current = readAdmissionClaim(id, environment);
        if (
          current === null
          || current.contentSha256 !== snapshot.contentSha256
          || !sameOwner(current.value.owner, claim.owner)
        ) {
          throw new Error("read projection admission changed before release");
        }
        if (!contentionReported) {
          options.afterReleaseContentionForTest?.();
          contentionReported = true;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new Error(
            "read projection admission could not be released within its bounded wait",
          );
        }
        Atomics.wait(
          settlementWaitState,
          0,
          0,
          Math.min(SETTLEMENT_WAIT_SLICE_MS, Math.ceil(remaining)),
        );
      }
    },
  });
}

function isStateMutationCreateContention(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("state file mutation is already active");
}

export function acquireReadProjectionAuthAdmission(
  authIdValue: string,
  environment: Environment = process.env,
  options: {
    /** Test-only seam that throws after the claim is durably created. */
    readonly afterCreateCommitForTest?: () => void;
    /** Test-only seam invoked once after an exact claim loses mutation arbitration. */
    readonly afterReleaseContentionForTest?: () => void;
  } = {},
): ReadProjectionAuthAdmission {
  if (
    options.afterCreateCommitForTest !== undefined
    && typeof options.afterCreateCommitForTest !== "function"
  ) {
    throw new Error("read projection admission fault injection is malformed");
  }
  if (
    options.afterReleaseContentionForTest !== undefined
    && typeof options.afterReleaseContentionForTest !== "function"
  ) {
    throw new Error("read projection admission fault injection is malformed");
  }
  if (
    (
      options.afterCreateCommitForTest !== undefined
      || options.afterReleaseContentionForTest !== undefined
    )
    && process.env.NODE_ENV !== "test"
  ) {
    throw new Error(
      "read projection admission fault injection is available only in tests",
    );
  }
  const id = authId(authIdValue);
  ensurePrivateStateDirectory(admissionsDirectory(environment), environment);
  for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
    const observed = readAdmissionClaim(id, environment);
    if (observed !== null) {
      const status = processOwnerStatus(observed.value.owner);
      if (status === "exact-live-owner") {
        throw new ReadProjectionAdmissionContentionError(
          id,
          observed.value.owner,
          "active-owner",
        );
      }
      if (status === "unknown") {
        throw new Error(
          `auth locator ${id} read projection owner cannot be inspected safely`,
        );
      }
      removePrivateStateFileIfUnchanged(
        admissionPath(id, environment),
        { expectedCurrentContentSha256: observed.contentSha256 },
        environment,
      );
      continue;
    }

    const claim = admissionClaim({
      schemaVersion: 1,
      authId: id,
      owner: newOwner(),
    });
    const snapshot = canonicalSnapshot(claim);
    let created = false;
    let currentAfterCreate: Snapshot<ReadProjectionAdmissionClaim> | null
      | undefined;
    try {
      created = createPrivateJsonIfAbsent(
        admissionPath(id, environment),
        claim,
        { environment },
      ).created;
      if (created) options.afterCreateCommitForTest?.();
    } catch (error) {
      let committed: Snapshot<ReadProjectionAdmissionClaim> | null;
      try {
        committed = readAdmissionClaim(id, environment);
      } catch (reconciliationError) {
        throw new AggregateError(
          [
            errorValue(error, "read projection admission creation failed"),
            errorValue(
              reconciliationError,
              "read projection admission reconciliation failed",
            ),
          ],
          `auth locator ${id} read projection admission creation could not be reconciled`,
        );
      }
      if (
        committed !== null
        && committed.contentSha256 === snapshot.contentSha256
        && sameOwner(committed.value.owner, claim.owner)
      ) {
        return acquiredAdmission(id, claim, snapshot, environment, options);
      }
      if (!isStateMutationCreateContention(error)) throw error;
      currentAfterCreate = committed;
    }
    if (created) {
      return acquiredAdmission(id, claim, snapshot, environment, options);
    }

    const current = currentAfterCreate
      ?? readAdmissionClaim(id, environment);
    if (current === null) continue;
    const status = processOwnerStatus(current.value.owner);
    if (status === "exact-live-owner") {
      throw new ReadProjectionAdmissionContentionError(
        id,
        current.value.owner,
        "active-owner",
      );
    }
    if (status === "unknown") {
      throw new Error(
        `auth locator ${id} read projection owner cannot be inspected safely`,
      );
    }
    removePrivateStateFileIfUnchanged(
      admissionPath(id, environment),
      { expectedCurrentContentSha256: current.contentSha256 },
      environment,
    );
  }
  throw new Error(
    `auth locator ${id} read projection admission could not be acquired`,
  );
}

function withAcquiredReadProjectionAuthAdmission<T>(
  id: string,
  environment: Environment,
  operation: () => T,
  acquire: () => ReadProjectionAuthAdmission,
): T {
  const heldKey = `${wrenchStateHome(environment)}\0${id}`;
  const held = heldAdmissions.get(heldKey);
  if (held !== undefined) {
    assertAdmissionHeld(held.admission, environment);
    held.depth += 1;
    try {
      return synchronousOperationResult(operation);
    } finally {
      held.depth -= 1;
    }
  }

  const admission = acquire();
  const acquired: HeldAdmission = { depth: 1, admission };
  heldAdmissions.set(heldKey, acquired);
  let outcome: { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: Error };
  try {
    outcome = { ok: true, value: synchronousOperationResult(operation) };
  } catch (error) {
    outcome = {
      ok: false,
      error: errorValue(error, "read projection operation failed"),
    };
  }
  acquired.depth -= 1;
  heldAdmissions.delete(heldKey);
  let releaseError: Error | null = null;
  try {
    admission.release();
  } catch (error) {
    releaseError = errorValue(error, "read projection admission release failed");
  }
  if (!outcome.ok && releaseError !== null) {
    throw new AggregateError(
      [outcome.error, releaseError],
      `auth locator ${id} read projection operation and admission release both failed`,
    );
  }
  if (!outcome.ok) throw outcome.error;
  if (releaseError !== null) throw releaseError;
  return outcome.value;
}

export function withReadProjectionAuthAdmission<T>(
  authIdValue: string,
  environment: Environment,
  operation: () => T,
): T {
  const id = authId(authIdValue);
  return withAcquiredReadProjectionAuthAdmission(
    id,
    environment,
    operation,
    () => acquireReadProjectionAuthAdmission(id, environment),
  );
}

function settlementWaitMilliseconds(
  options: ReadProjectionAdmissionSettlementOptions,
): number {
  const value = options.maximumWaitMs
    ?? READ_PROJECTION_SHORT_SETTLEMENT_WAIT_MS;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > READ_PROJECTION_TRANSITION_SETTLEMENT_WAIT_MS
  ) {
    throw new Error(
      `read projection admission settlement wait must be an integer from 0 to ${READ_PROJECTION_TRANSITION_SETTLEMENT_WAIT_MS} milliseconds`,
    );
  }
  return value;
}

function acquireSettledReadProjectionAuthAdmission(
  id: string,
  environment: Environment,
  options: ReadProjectionAdmissionSettlementOptions,
): ReadProjectionAuthAdmission {
  const maximumWaitMs = settlementWaitMilliseconds(options);
  const deadline = performance.now() + maximumWaitMs;
  let active: ReadProjectionAdmissionContentionError;
  while (true) {
    try {
      return acquireReadProjectionAuthAdmission(id, environment);
    } catch (error) {
      if (!(error instanceof ReadProjectionAdmissionContentionError)) {
        throw error;
      }
      active = error;
    }

    if (active.owner.pid === process.pid) {
      throw new ReadProjectionAdmissionContentionError(
        id,
        active.owner,
        "same-process-owner",
        { cause: active },
      );
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new ReadProjectionAdmissionContentionError(
        id,
        active.owner,
        "settlement-exhausted",
        { cause: active },
      );
    }
    Atomics.wait(
      settlementWaitState,
      0,
      0,
      Math.min(SETTLEMENT_WAIT_SLICE_MS, Math.ceil(remaining)),
    );
  }
}

/**
 * Wait for a bounded budget when an exact-live owner is in another process,
 * then run one synchronous state transition. Direct acquisition and auth
 * mutations retain immediate contention semantics; this path is for read
 * settlement.
 */
export function withSettledReadProjectionAuthAdmission<T>(
  authIdValue: string,
  environment: Environment,
  operation: () => T,
  options: ReadProjectionAdmissionSettlementOptions = {},
): T {
  const id = authId(authIdValue);
  settlementWaitMilliseconds(options);
  return withAcquiredReadProjectionAuthAdmission(
    id,
    environment,
    operation,
    () => acquireSettledReadProjectionAuthAdmission(id, environment, options),
  );
}

function ensureIncarnationUnderAdmission(
  id: string,
  environment: Environment,
): Snapshot<ReadProjectionIncarnation> {
  ensurePrivateStateDirectory(incarnationsDirectory(environment), environment);
  const current = readIncarnation(id, environment);
  if (current !== null) return current;
  const value = incarnationRecord({
    schemaVersion: 1,
    authId: id,
    incarnation: randomBytes(32).toString("hex"),
  });
  createPrivateJsonIfAbsent(
    incarnationPath(id, environment),
    value,
    { environment },
  );
  const created = readIncarnation(id, environment);
  if (created === null) {
    throw new Error("read projection auth incarnation could not be ensured");
  }
  return created;
}

export function ensureReadProjectionAuthIncarnation(
  authIdValue: string,
  environment: Environment = process.env,
): string {
  const id = authId(authIdValue);
  return withReadProjectionAuthAdmission(id, environment, () =>
    ensureIncarnationUnderAdmission(id, environment).value.incarnation);
}

export function rotateReadProjectionAuthIncarnation(
  authIdValue: string,
  environment: Environment = process.env,
): string {
  const id = authId(authIdValue);
  return withReadProjectionAuthAdmission(id, environment, () => {
    ensurePrivateStateDirectory(incarnationsDirectory(environment), environment);
    const current = readRawIncarnation(id, environment);
    let previousIncarnation: string | null = null;
    if (current !== null) {
      try {
        const parsed = parseCanonicalSnapshot(
          current.content,
          "read projection auth incarnation",
          incarnationRecord,
        );
        if (parsed.value.authId === id) {
          previousIncarnation = parsed.value.incarnation;
        }
      } catch {
        // Mutation rotation is the one recovery authority for malformed but
        // bounded incarnation state. Query identity reads remain fail-closed.
      }
    }
    let incarnation: string;
    do {
      incarnation = randomBytes(32).toString("hex");
    } while (incarnation === previousIncarnation);
    const replacement = incarnationRecord({
      schemaVersion: 1,
      authId: id,
      incarnation,
    });
    const replaced = current === null
      ? createPrivateJsonIfAbsent(
          incarnationPath(id, environment),
          replacement,
          { environment },
        ).created
      : writePrivateJsonIfUnchanged(
          incarnationPath(id, environment),
          replacement,
          { expectedCurrentContentSha256: current.contentSha256 },
        );
    if (!replaced) {
      throw new Error(
        `auth locator ${id} read projection incarnation changed concurrently`,
      );
    }
    return replacement.incarnation;
  });
}

export function removeReadProjectionAuthIncarnation(
  authIdValue: string,
  environment: Environment = process.env,
): boolean {
  const id = authId(authIdValue);
  return withReadProjectionAuthAdmission(id, environment, () => {
    ensurePrivateStateDirectory(incarnationsDirectory(environment), environment);
    const current = readRawIncarnation(id, environment);
    if (current === null) return false;
    if (!removePrivateStateFileIfUnchanged(
      incarnationPath(id, environment),
      { expectedCurrentContentSha256: current.contentSha256 },
      environment,
    )) {
      throw new Error(
        `auth locator ${id} read projection incarnation changed concurrently before removal`,
      );
    }
    return true;
  });
}

export function projectionAuthIdentityHash(
  authIdValue: string,
  exactAuthContentHashValue: string,
  environment: Environment = process.env,
): string {
  const id = authId(authIdValue);
  const exactAuthContentHash = digest(
    exactAuthContentHashValue,
    "exact auth content hash",
  );
  return withReadProjectionAuthAdmission(id, environment, () => {
    const incarnation = ensureIncarnationUnderAdmission(id, environment)
      .value.incarnation;
    return hash(
      `wrench-read-projection-auth-identity-v1\0${id}\0${exactAuthContentHash}\0${incarnation}`,
    );
  });
}
