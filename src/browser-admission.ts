import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  runCapture as runKbCapture,
  type CaptureArguments,
  type CaptureOutcome,
} from "@hraness/kb/capture";
import {
  acquireBrowser as acquireKbBrowser,
  type AcquiredPage,
} from "@hraness/kb/clip/acquire";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
  type ProcessOwnerStatus,
  type ProcessStartIdentity,
} from "./process-identity";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  readPrivateStateFileIfPresent,
  removePrivateStateFileIfUnchanged,
  wrenchStateHome,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

const ADMISSION_SCHEMA_VERSION = 1 as const;
const MAX_CLAIM_BYTES = 4 * 1024;
const MIN_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 250;
const MAX_WAIT_MS = 30_000;
// storage.ts gives one state-helper invocation 30 seconds; allow recovery margin.
const RELEASE_SETTLEMENT_WAIT_MS = 35_000;
const RELEASE_SETTLEMENT_SLICE_MS = 10;
const releaseSettlementState = new Int32Array(new SharedArrayBuffer(4));
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

export const LOCAL_BROWSER_ADMISSION_LIMIT = 2 as const;
export const BROWSER_ADMISSION_STATE_DIRECTORY =
  "captures/browser-admissions" as const;

export type BrowserAdmissionSlot = 0 | 1;

export type BrowserAdmissionClaim = {
  readonly schemaVersion: typeof ADMISSION_SCHEMA_VERSION;
  readonly slot: BrowserAdmissionSlot;
  readonly acquiredAt: string;
  readonly owner: ProcessOwnerIdentity & {
    readonly token: string;
  };
};

type BrowserAdmissionClaimSnapshot = {
  readonly claim: BrowserAdmissionClaim;
  readonly contentSha256: string;
};

export type BrowserAdmission = {
  readonly slot: BrowserAdmissionSlot;
  readonly acquiredAt: string;
  readonly owner: BrowserAdmissionClaim["owner"];
  readonly release: () => void;
};

export type BrowserAdmissionDeadline = {
  readonly signal: AbortSignal;
  readonly remainingTimeMs: () => number;
  readonly throwIfUnavailable: (label?: string) => void;
};

export type BrowserAdmissionDependencies = {
  readonly monotonicNow?: () => number;
  readonly wallClockNow?: () => Date;
  readonly random?: () => number;
  readonly randomToken?: () => string;
  readonly currentProcessIdentity?: () => ProcessStartIdentity;
  readonly ownerStatus?: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus;
  readonly sleep?: (
    milliseconds: number,
    signals: readonly AbortSignal[],
  ) => Promise<void>;
  /** Test-only seam invoked after a durable create and before it is returned. */
  readonly afterCreateCommitForTest?: () => void;
  /** Test-only seam invoked before the first read of a slot in one attempt. */
  readonly beforeClaimReadForTest?: (slot: BrowserAdmissionSlot) => void;
  /** Test-only seam invoked before rereading a slot after create contention. */
  readonly beforeContendedClaimReadForTest?: (
    slot: BrowserAdmissionSlot,
  ) => void;
  /** Test-only seam invoked once when an exact release loses mutation arbitration. */
  readonly afterReleaseContentionForTest?: () => void;
  /** Test-only monotonic clock for bounded release settlement. */
  readonly releaseMonotonicNowForTest?: () => number;
  /** Test-only synchronous wait for bounded release settlement. */
  readonly releaseWaitForTest?: (milliseconds: number) => void;
};

export type AcquireBrowserAdmissionOptions = {
  readonly timeoutMs: number;
  readonly environment?: Environment;
  readonly signal?: AbortSignal;
  readonly deadline?: BrowserAdmissionDeadline;
  readonly dependencies?: BrowserAdmissionDependencies;
};

export class BrowserAdmissionError extends Error {
  readonly failure: "cancelled" | "timed-out";

  constructor(failure: "cancelled" | "timed-out") {
    super(
      failure === "cancelled"
        ? "local browser admission was cancelled"
        : `local browser admission polling timed out at the ${LOCAL_BROWSER_ADMISSION_LIMIT}-browser limit (polling budget cap: ${MAX_WAIT_MS / 1_000} seconds)`,
    );
    this.name = "BrowserAdmissionError";
    this.failure = failure;
  }
}

class BrowserAdmissionClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserAdmissionClaimError";
  }
}

function strictRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrowserAdmissionClaimError(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BrowserAdmissionClaimError(`${label} has an unsupported prototype`);
  }
  const result = Object.create(null) as JsonRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new BrowserAdmissionClaimError(`${label} has unsupported symbol fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new BrowserAdmissionClaimError(`${label} has unsupported accessor fields`);
    }
    result[key] = descriptor.value as unknown;
  }
  return result;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new BrowserAdmissionClaimError(`${label} has unsupported fields`);
  }
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new BrowserAdmissionClaimError(`${label} is malformed`);
  }
  return value;
}

function parseTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new BrowserAdmissionClaimError(
      "browser admission acquisition time is malformed",
    );
  }
  return value;
}

function parseOwner(value: unknown): BrowserAdmissionClaim["owner"] {
  const owner = strictRecord(value, "browser admission owner");
  exactKeys(
    owner,
    ["pid", "token", "bootId", "processStartId"],
    "browser admission owner",
  );
  if (
    typeof owner.pid !== "number"
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
  ) {
    throw new BrowserAdmissionClaimError("browser admission owner PID is malformed");
  }
  if (typeof owner.token !== "string" || !uuidPattern.test(owner.token)) {
    throw new BrowserAdmissionClaimError("browser admission owner token is malformed");
  }
  return Object.freeze({
    pid: owner.pid,
    token: owner.token,
    bootId: parseDigest(owner.bootId, "browser admission boot identity"),
    processStartId: parseDigest(
      owner.processStartId,
      "browser admission process-start identity",
    ),
  });
}

export function parseBrowserAdmissionClaim(
  value: unknown,
): BrowserAdmissionClaim {
  const claim = strictRecord(value, "browser admission claim");
  exactKeys(
    claim,
    ["schemaVersion", "slot", "acquiredAt", "owner"],
    "browser admission claim",
  );
  if (claim.schemaVersion !== ADMISSION_SCHEMA_VERSION) {
    throw new BrowserAdmissionClaimError("browser admission schema version is invalid");
  }
  if (claim.slot !== 0 && claim.slot !== 1) {
    throw new BrowserAdmissionClaimError("browser admission slot is malformed");
  }
  return Object.freeze({
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    slot: claim.slot,
    acquiredAt: parseTimestamp(claim.acquiredAt),
    owner: parseOwner(claim.owner),
  });
}

function claimDirectory(environment: Environment): string {
  return join(
    wrenchStateHome(environment),
    ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
  );
}

function claimPath(
  slot: BrowserAdmissionSlot,
  environment: Environment,
): string {
  return join(claimDirectory(environment), `slot-${slot}.json`);
}

function claimSnapshot(claim: BrowserAdmissionClaim): BrowserAdmissionClaimSnapshot {
  const content = `${canonicalJson(claim)}\n`;
  return Object.freeze({ claim, contentSha256: sha256(content) });
}

function readClaim(
  slot: BrowserAdmissionSlot,
  environment: Environment,
): BrowserAdmissionClaimSnapshot | null {
  const content = readPrivateStateFileIfPresent(
    claimPath(slot, environment),
    MAX_CLAIM_BYTES,
    "browser admission claim",
    environment,
  );
  if (content === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new BrowserAdmissionClaimError("browser admission claim is malformed JSON");
  }
  const claim = parseBrowserAdmissionClaim(value);
  if (claim.slot !== slot) {
    throw new BrowserAdmissionClaimError(
      "browser admission claim does not match its slot",
    );
  }
  if (content !== `${canonicalJson(claim)}\n`) {
    throw new BrowserAdmissionClaimError(
      "browser admission claim is not canonical JSON",
    );
  }
  return Object.freeze({ claim, contentSha256: sha256(content) });
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("browser admission timeout must be a non-negative safe integer");
  }
  return Math.min(timeoutMs, MAX_WAIT_MS);
}

function validateMonotonicTime(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("browser admission monotonic clock returned an invalid time");
  }
  return value;
}

function defaultSleep(
  milliseconds: number,
  signals: readonly AbortSignal[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", onAbort);
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onAbort = (): void => settle(() => reject(new BrowserAdmissionError("cancelled")));
    const timer = setTimeout(() => settle(resolve), milliseconds);
    for (const signal of signals) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function activeSignals(options: AcquireBrowserAdmissionOptions): readonly AbortSignal[] {
  return [options.signal, options.deadline?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
}

function throwIfUnavailable(
  options: AcquireBrowserAdmissionOptions,
  now: () => number,
  expiresAt: number,
): void {
  options.deadline?.throwIfUnavailable("local browser admission");
  if (options.signal?.aborted === true) {
    throw new BrowserAdmissionError("cancelled");
  }
  if (validateMonotonicTime(now()) >= expiresAt) {
    throw new BrowserAdmissionError("timed-out");
  }
}

function remainingWait(
  options: AcquireBrowserAdmissionOptions,
  now: () => number,
  expiresAt: number,
): number {
  const localRemaining = Math.max(
    0,
    Math.floor(expiresAt - validateMonotonicTime(now())),
  );
  if (options.deadline === undefined) return localRemaining;
  options.deadline.throwIfUnavailable("local browser admission");
  const deadlineRemaining = options.deadline.remainingTimeMs();
  if (!Number.isSafeInteger(deadlineRemaining) || deadlineRemaining < 0) {
    throw new Error("browser admission deadline returned invalid remaining time");
  }
  return Math.max(
    0,
    Math.min(localRemaining, deadlineRemaining),
  );
}

function retryDelay(attempt: number, random: () => number): number {
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new Error("browser admission random source returned an invalid value");
  }
  const exponential = Math.min(
    MAX_RETRY_DELAY_MS,
    MIN_RETRY_DELAY_MS * (2 ** Math.min(attempt, 3)),
  );
  return Math.max(
    1,
    Math.round(exponential * (0.75 + randomValue * 0.5)),
  );
}

function stateHelperErrorDetail(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return error.message.startsWith("state helper: ")
    ? error.message.slice("state helper: ".length)
    : error.message;
}

function isConcurrentStateDirectoryCreation(error: unknown): boolean {
  const detail = stateHelperErrorDetail(error);
  return detail === "state directory appeared where absence was required"
    || detail === "state directory appeared while being created"
    || detail === "state directory appeared where absence was expected";
}

function isActiveStateFileMutation(error: unknown): boolean {
  return stateHelperErrorDetail(error) === "state file mutation is already active";
}

function isStateFileReadDrift(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      current.message
        === "state helper: state file changed while it was read"
    ) return true;
    current = current.cause;
  }
  return false;
}

async function ensureAdmissionStateDirectory(
  environment: Environment,
  options: AcquireBrowserAdmissionOptions,
  now: () => number,
  expiresAt: number,
  random: () => number,
  sleep: NonNullable<BrowserAdmissionDependencies["sleep"]>,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    throwIfUnavailable(options, now, expiresAt);
    try {
      ensurePrivateStateDirectory(claimDirectory(environment), environment);
      return;
    } catch (error) {
      if (!isConcurrentStateDirectoryCreation(error)) throw error;
    }

    const remaining = remainingWait(options, now, expiresAt);
    if (remaining < 1) throw new BrowserAdmissionError("timed-out");
    const delay = Math.min(remaining, retryDelay(attempt, random));
    attempt += 1;
    try {
      await sleep(delay, activeSignals(options));
    } catch (error) {
      options.deadline?.throwIfUnavailable("local browser admission");
      if (activeSignals(options).some((signal) => signal.aborted)) {
        throw new BrowserAdmissionError("cancelled");
      }
      throw error;
    }
  }
}

function exactOwnerStatus(
  owner: ProcessOwnerIdentity,
  inspect: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
): ProcessOwnerStatus {
  try {
    return inspect(owner);
  } catch {
    return "unknown";
  }
}

function newClaim(
  slot: BrowserAdmissionSlot,
  acquiredAt: string,
  owner: BrowserAdmissionClaim["owner"],
): BrowserAdmissionClaimSnapshot {
  return claimSnapshot(parseBrowserAdmissionClaim({
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    slot,
    acquiredAt,
    owner,
  }));
}

function sameClaim(
  left: BrowserAdmissionClaim,
  right: BrowserAdmissionClaim,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.slot === right.slot
    && left.acquiredAt === right.acquiredAt
    && left.owner.pid === right.owner.pid
    && left.owner.token === right.owner.token
    && left.owner.bootId === right.owner.bootId
    && left.owner.processStartId === right.owner.processStartId;
}

function exactSnapshotStillHeld(
  current: BrowserAdmissionClaimSnapshot | null,
  expected: BrowserAdmissionClaimSnapshot,
  inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
): boolean {
  return current !== null
    && current.contentSha256 === expected.contentSha256
    && sameClaim(current.claim, expected.claim)
    && exactOwnerStatus(current.claim.owner, inspectOwner) === "exact-live-owner";
}

function admissionFromSnapshot(
  snapshot: BrowserAdmissionClaimSnapshot,
  environment: Environment,
  inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
  afterReleaseContentionForTest?: () => void,
  releaseNow: () => number = () => performance.now(),
  releaseWait: (milliseconds: number) => void = (milliseconds) => {
    Atomics.wait(releaseSettlementState, 0, 0, milliseconds);
  },
): BrowserAdmission {
  let released = false;
  return Object.freeze({
    slot: snapshot.claim.slot,
    acquiredAt: snapshot.claim.acquiredAt,
    owner: snapshot.claim.owner,
    release: () => {
      if (released) return;
      const deadline = validateMonotonicTime(releaseNow())
        + RELEASE_SETTLEMENT_WAIT_MS;
      let contentionReported = false;
      for (;;) {
        if (!exactSnapshotStillHeld(
          readClaim(snapshot.claim.slot, environment),
          snapshot,
          inspectOwner,
        )) {
          throw new Error("browser admission authority is not exact and live");
        }
        if (removePrivateStateFileIfUnchanged(
          claimPath(snapshot.claim.slot, environment),
          { expectedCurrentContentSha256: snapshot.contentSha256 },
          environment,
        )) {
          released = true;
          return;
        }

        if (!exactSnapshotStillHeld(
          readClaim(snapshot.claim.slot, environment),
          snapshot,
          inspectOwner,
        )) {
          throw new Error("browser admission changed before release");
        }
        if (!contentionReported) {
          afterReleaseContentionForTest?.();
          contentionReported = true;
        }
        const remaining = deadline - validateMonotonicTime(releaseNow());
        if (remaining <= 0) {
          throw new Error(
            "browser admission could not be released within its bounded wait",
          );
        }
        releaseWait(
          Math.min(RELEASE_SETTLEMENT_SLICE_MS, Math.ceil(remaining)),
        );
      }
    },
  });
}

function errorValue(error: unknown, label: string): Error {
  return error instanceof Error ? error : new Error(label, { cause: error });
}

function admissionWithinDeadline(
  snapshot: BrowserAdmissionClaimSnapshot,
  environment: Environment,
  options: AcquireBrowserAdmissionOptions,
  now: () => number,
  expiresAt: number,
  inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus,
  afterReleaseContentionForTest?: () => void,
  releaseNow?: () => number,
  releaseWait?: (milliseconds: number) => void,
): BrowserAdmission {
  const admission = admissionFromSnapshot(
    snapshot,
    environment,
    inspectOwner,
    afterReleaseContentionForTest,
    releaseNow,
    releaseWait,
  );
  try {
    throwIfUnavailable(options, now, expiresAt);
  } catch (error) {
    try {
      admission.release();
    } catch (releaseFailure) {
      throw new AggregateError(
        [error, releaseFailure],
        "browser admission expired after acquisition and could not be released",
      );
    }
    throw error;
  }
  return admission;
}

export function assertBrowserAdmissionHeld(
  admission: BrowserAdmission,
  environment: Environment = process.env,
): void {
  const snapshot = readClaim(admission.slot, environment);
  if (
    snapshot === null
    || snapshot.claim.acquiredAt !== admission.acquiredAt
    || snapshot.claim.owner.pid !== admission.owner.pid
    || snapshot.claim.owner.token !== admission.owner.token
    || snapshot.claim.owner.bootId !== admission.owner.bootId
    || snapshot.claim.owner.processStartId !== admission.owner.processStartId
    || processOwnerStatus(snapshot.claim.owner) !== "exact-live-owner"
  ) {
    throw new Error("browser admission authority is not exact and live");
  }
}

export async function acquireBrowserAdmission(
  options: AcquireBrowserAdmissionOptions,
): Promise<BrowserAdmission> {
  const environment = options.environment ?? process.env;
  const dependencies = options.dependencies ?? {};
  const now = dependencies.monotonicNow ?? (() => performance.now());
  const timeoutMs = validateTimeout(options.timeoutMs);
  const startedAt = validateMonotonicTime(now());
  const expiresAt = startedAt + timeoutMs;
  if (!Number.isFinite(expiresAt)) {
    throw new Error("browser admission deadline exceeded the supported time range");
  }
  options.deadline?.throwIfUnavailable("local browser admission");
  if (options.signal?.aborted === true) {
    throw new BrowserAdmissionError("cancelled");
  }
  if (timeoutMs === 0) throw new BrowserAdmissionError("timed-out");

  const currentIdentity = (
    dependencies.currentProcessIdentity ?? currentProcessStartIdentity
  )();
  const token = (dependencies.randomToken ?? randomUUID)();
  if (!uuidPattern.test(token)) {
    throw new Error("browser admission token source returned a malformed UUID");
  }
  const acquiredAt = parseTimestamp(
    (dependencies.wallClockNow ?? (() => new Date()))().toISOString(),
  );
  const owner = Object.freeze({
    pid: process.pid,
    token,
    bootId: currentIdentity.bootId,
    processStartId: currentIdentity.processStartId,
  });
  const inspectOwner = dependencies.ownerStatus ?? processOwnerStatus;
  const random = dependencies.random ?? Math.random;
  const sleep = dependencies.sleep ?? defaultSleep;
  await ensureAdmissionStateDirectory(
    environment,
    options,
    now,
    expiresAt,
    random,
    sleep,
  );

  let attempt = 0;
  for (;;) {
    throwIfUnavailable(options, now, expiresAt);
    let stateChanged = false;
    let storageContention = false;
    for (const slot of [0, 1] as const) {
      throwIfUnavailable(options, now, expiresAt);
      let existing: BrowserAdmissionClaimSnapshot | null;
      try {
        dependencies.beforeClaimReadForTest?.(slot);
        existing = readClaim(slot, environment);
      } catch (error) {
        if (error instanceof BrowserAdmissionClaimError) {
          // Malformed claims occupy their slot until a human repairs them.
          continue;
        }
        if (isStateFileReadDrift(error)) {
          // Eight overlapping owners can rewrite a slot between helper open
          // and helper close. Retry the same occupancy rules after backoff.
          storageContention = true;
          continue;
        }
        throw error;
      }
      if (existing === null) {
        const proposed = newClaim(slot, acquiredAt, owner);
        let created = false;
        try {
          created = createPrivateJsonIfAbsent(
            claimPath(slot, environment),
            proposed.claim,
            { environment, privateParent: true },
          ).created;
          if (created) dependencies.afterCreateCommitForTest?.();
        } catch (error) {
          let committed: BrowserAdmissionClaimSnapshot | null;
          try {
            committed = readClaim(slot, environment);
          } catch (reconciliationError) {
            if (isStateFileReadDrift(reconciliationError)) {
              storageContention = true;
              continue;
            }
            throw new AggregateError(
              [
                errorValue(error, "browser admission creation failed"),
                errorValue(
                  reconciliationError,
                  "browser admission creation reconciliation failed",
                ),
              ],
              "browser admission creation could not be reconciled",
            );
          }
          if (
            committed !== null
            && committed.contentSha256 === proposed.contentSha256
            && sameClaim(committed.claim, proposed.claim)
            && exactOwnerStatus(committed.claim.owner, inspectOwner)
              === "exact-live-owner"
          ) {
            return admissionWithinDeadline(
              proposed,
              environment,
              options,
              now,
              expiresAt,
              inspectOwner,
              dependencies.afterReleaseContentionForTest,
              dependencies.releaseMonotonicNowForTest,
              dependencies.releaseWaitForTest,
            );
          }
          if (!isActiveStateFileMutation(error)) throw error;
          storageContention = true;
          existing = committed;
        }
        if (created) {
          return admissionWithinDeadline(
            proposed,
            environment,
            options,
            now,
            expiresAt,
            inspectOwner,
            dependencies.afterReleaseContentionForTest,
            dependencies.releaseMonotonicNowForTest,
            dependencies.releaseWaitForTest,
          );
        }
        if (existing === null) {
          try {
            dependencies.beforeContendedClaimReadForTest?.(slot);
            existing = readClaim(slot, environment);
          } catch (error) {
            if (error instanceof BrowserAdmissionClaimError) {
              // A competing malformed claim occupies the slot.
              continue;
            }
            if (isStateFileReadDrift(error)) {
              // The just-contended slot remains occupied until one stable read
              // proves otherwise. Retry without weakening claim validation.
              storageContention = true;
              continue;
            }
            throw error;
          }
        }
      }
      if (existing === null) {
        stateChanged = true;
        continue;
      }
      const status = exactOwnerStatus(existing.claim.owner, inspectOwner);
      if (
        existing.claim.owner.bootId === currentIdentity.bootId
        || status !== "different-or-dead"
      ) {
        // Same-boot, exact-live, and unverifiable owners all retain their slot.
        // A same-boot browser daemon can outlive its Wrench owner process.
        continue;
      }
      let removed: boolean;
      try {
        removed = removePrivateStateFileIfUnchanged(
          claimPath(slot, environment),
          { expectedCurrentContentSha256: existing.contentSha256 },
          environment,
        );
      } catch (error) {
        if (!isActiveStateFileMutation(error)) throw error;
        storageContention = true;
        continue;
      }
      if (removed) {
        stateChanged = true;
        break;
      }
    }
    if (stateChanged && !storageContention) continue;

    const remaining = remainingWait(options, now, expiresAt);
    if (remaining < 1) throw new BrowserAdmissionError("timed-out");
    const delay = Math.min(remaining, retryDelay(attempt, random));
    attempt += 1;
    try {
      await sleep(delay, activeSignals(options));
    } catch (error) {
      options.deadline?.throwIfUnavailable("local browser admission");
      if (activeSignals(options).some((signal) => signal.aborted)) {
        throw new BrowserAdmissionError("cancelled");
      }
      throw error;
    }
  }
}

export type BrowserCaptureAdmissionDependencies = {
  readonly acquireAdmission?: typeof acquireBrowserAdmission;
  readonly acquireBrowser?: typeof acquireKbBrowser;
  readonly runCapture?: typeof runKbCapture;
  readonly monotonicNow?: () => number;
  readonly signal?: AbortSignal;
};

/**
 * The slot remains held through settlement of the upstream browser, process,
 * proxy, and isolation cleanup attempt.
 * Attached browsers do not consume a locally owned browser slot.
 */
export async function acquireCaptureBrowserWithAdmission(
  options: CaptureArguments,
  temporaryDirectory: string,
  useDiscoveredProfile: boolean,
  environment: Environment = process.env,
  dependencies: BrowserCaptureAdmissionDependencies = {},
): Promise<AcquiredPage> {
  const acquireBrowser = dependencies.acquireBrowser ?? acquireKbBrowser;
  if (options.browserLive || options.cdp !== undefined) {
    return acquireBrowser(options, temporaryDirectory, useDiscoveredProfile);
  }

  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const startedAt = validateMonotonicTime(monotonicNow());
  const admission = await (
    dependencies.acquireAdmission ?? acquireBrowserAdmission
  )({
    timeoutMs: options.timeoutMs,
    environment,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });
  let operation:
    | { readonly ok: true; readonly value: AcquiredPage }
    | { readonly ok: false; readonly error: unknown };
  try {
    if (dependencies.signal?.aborted === true) {
      throw new BrowserAdmissionError("cancelled");
    }
    const elapsed = Math.max(
      0,
      Math.ceil(validateMonotonicTime(monotonicNow()) - startedAt),
    );
    const remainingTimeoutMs = options.timeoutMs - elapsed;
    if (remainingTimeoutMs < 1) {
      throw new BrowserAdmissionError("timed-out");
    }
    operation = {
      ok: true,
      value: await acquireBrowser(
        { ...options, timeoutMs: remainingTimeoutMs },
        temporaryDirectory,
        useDiscoveredProfile,
      ),
    };
  } catch (error) {
    operation = { ok: false, error };
  }
  try {
    admission.release();
  } catch (releaseFailure) {
    if (operation.ok) throw releaseFailure;
    throw new AggregateError(
      [operation.error, releaseFailure],
      "browser acquisition failed and its admission could not be released",
    );
  }
  if (!operation.ok) throw operation.error;
  return operation.value;
}

export async function runCaptureWithBrowserAdmission(
  options: CaptureArguments,
  environment: Environment = process.env,
  dependencies: BrowserCaptureAdmissionDependencies = {},
): Promise<CaptureOutcome> {
  const runCapture = dependencies.runCapture ?? runKbCapture;
  return runCapture(options, {
    acquireBrowser: (
      browserOptions,
      temporaryDirectory,
      useDiscoveredProfile,
    ) => acquireCaptureBrowserWithAdmission(
      browserOptions,
      temporaryDirectory,
      useDiscoveredProfile === true,
      environment,
      dependencies,
    ),
  });
}
