import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  createLinkedDeviceLifecycleOwner,
  parseLinkedDeviceLifecycleOwner,
  type LinkedDeviceLifecycleOwner,
} from "./linked-device-lifecycle-journal";
import { canonicalJson } from "./canonical-json";
import { processOwnerStatus } from "./process-identity";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  wrenchStateHome,
  listPrivateStateDirectory,
  readPrivateStateFileIfPresent,
  removePrivateStateFileIfUnchanged,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;

const ADMISSION_SCHEMA_VERSION = 1 as const;
const MAX_ADMISSION_BYTES = 4 * 1024;
const MAX_ACQUISITION_ATTEMPTS = 8;
const OWNER_LEASE_MILLISECONDS = 30 * 60_000;
const authIdPattern = /^[a-z][a-z0-9-]{0,47}$/u;
const realmKeyPattern = /^[a-f0-9]{64}$/u;
const claimNamePattern = /^([a-f0-9]{64})\.json$/u;

export const LINKED_DEVICE_LIFECYCLE_ADMISSION_STATE_DIRECTORY =
  "run-journals/linked-device-lifecycle-admissions" as const;

type LinkedDeviceLifecycleAdmissionClaim = {
  readonly schemaVersion: typeof ADMISSION_SCHEMA_VERSION;
  readonly realmKey: string;
  readonly authId: string;
  readonly acquiredAt: string;
  readonly owner: LinkedDeviceLifecycleOwner;
};

type LinkedDeviceLifecycleAdmissionClaimSnapshot = {
  readonly claim: LinkedDeviceLifecycleAdmissionClaim;
  readonly contentSha256: string;
};

export type LinkedDeviceLifecycleAdmission = {
  readonly realmKey: string;
  readonly authId: string;
  readonly acquiredAt: string;
  readonly owner: LinkedDeviceLifecycleOwner;
  readonly release: () => void;
};

export type LinkedDeviceLifecycleAdmissionRecoveryIssue = {
  readonly authId: string | null;
  readonly coordinate: string;
  readonly kind:
    | "invalid-admission"
    | "owner-unknown"
    | "recovery-conflict";
};

export type LinkedDeviceLifecycleAdmissionRecoveryReport = {
  readonly scanned: number;
  readonly live: number;
  readonly repaired: number;
  readonly invalid: number;
  readonly issues: readonly LinkedDeviceLifecycleAdmissionRecoveryIssue[];
};

export type LinkedDeviceLifecycleAdmissionStore = {
  readonly recover: (
    environment: Environment,
  ) => LinkedDeviceLifecycleAdmissionRecoveryReport;
  readonly acquire: (
    realmKey: string,
    authId: string,
    acquiredAt: string,
    environment: Environment,
  ) => LinkedDeviceLifecycleAdmission;
};

function strictRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype`);
  }
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error(`${label} has unsupported symbol fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new Error(`${label} has unsupported accessor fields`);
    }
    Object.defineProperty(record, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return record;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
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
    throw new Error("linked-device lifecycle admission auth ID is malformed");
  }
  return value;
}

function realmKey(value: unknown): string {
  if (typeof value !== "string" || !realmKeyPattern.test(value)) {
    throw new Error("linked-device lifecycle admission realm key is malformed");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(
      "linked-device lifecycle admission time is not canonical UTC",
    );
  }
  return value;
}

function parseClaim(value: unknown): LinkedDeviceLifecycleAdmissionClaim {
  const record = strictRecord(
    value,
    "linked-device lifecycle admission",
  );
  exactKeys(
    record,
    ["schemaVersion", "realmKey", "authId", "acquiredAt", "owner"],
    "linked-device lifecycle admission",
  );
  if (record.schemaVersion !== ADMISSION_SCHEMA_VERSION) {
    throw new Error("linked-device lifecycle admission version is invalid");
  }
  const acquiredAt = timestamp(record.acquiredAt);
  const owner = parseLinkedDeviceLifecycleOwner(record.owner);
  if (Date.parse(owner.leaseUntil) < Date.parse(acquiredAt)) {
    throw new Error("linked-device lifecycle admission lease is invalid");
  }
  return Object.freeze({
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    realmKey: realmKey(record.realmKey),
    authId: authId(record.authId),
    acquiredAt,
    owner,
  });
}

function directory(environment: Environment): string {
  return join(
    wrenchStateHome(environment),
    ...LINKED_DEVICE_LIFECYCLE_ADMISSION_STATE_DIRECTORY.split("/"),
  );
}

function pathFor(realmKeyValue: string, environment: Environment): string {
  return join(directory(environment), `${realmKey(realmKeyValue)}.json`);
}

function claimSnapshot(
  claim: LinkedDeviceLifecycleAdmissionClaim,
): LinkedDeviceLifecycleAdmissionClaimSnapshot {
  const content = `${canonicalJson(claim)}\n`;
  return Object.freeze({
    claim,
    contentSha256: createHash("sha256")
      .update(content, "utf8")
      .digest("hex"),
  });
}

function readLinkedDeviceLifecycleAdmissionClaim(
  realmKeyValue: string,
  environment: Environment,
): LinkedDeviceLifecycleAdmissionClaimSnapshot | null {
  const content = readPrivateStateFileIfPresent(
    pathFor(realmKeyValue, environment),
    MAX_ADMISSION_BYTES,
    "linked-device lifecycle admission",
    environment,
  );
  if (content === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error("linked-device lifecycle admission is malformed JSON");
  }
  const claim = parseClaim(value);
  if (claim.realmKey !== realmKeyValue) {
    throw new Error(
      "linked-device lifecycle admission does not match its filename",
    );
  }
  if (content !== `${canonicalJson(claim)}\n`) {
    throw new Error("linked-device lifecycle admission is not canonical JSON");
  }
  return Object.freeze({
    claim,
    contentSha256: createHash("sha256")
      .update(content, "utf8")
      .digest("hex"),
  });
}

export function assertLinkedDeviceLifecycleAdmissionHeld(
  admission: LinkedDeviceLifecycleAdmission,
  environment: Environment = process.env,
): void {
  const existing = readLinkedDeviceLifecycleAdmissionClaim(
    admission.realmKey,
    environment,
  );
  if (
    existing === null
    || existing.claim.authId !== admission.authId
    || existing.claim.acquiredAt !== admission.acquiredAt
    || existing.claim.owner.pid !== admission.owner.pid
    || existing.claim.owner.token !== admission.owner.token
    || existing.claim.owner.bootId !== admission.owner.bootId
    || existing.claim.owner.processStartId
      !== admission.owner.processStartId
    || existing.claim.owner.leaseUntil !== admission.owner.leaseUntil
    || processOwnerStatus(existing.claim.owner) !== "exact-live-owner"
  ) {
    throw new Error(
      "linked-device lifecycle admission authority is not exact and live",
    );
  }
}

function safeCoordinate(value: string): string {
  return `admission-${
    createHash("sha256")
      .update("linked-device-lifecycle-admission-coordinate\0", "utf8")
      .update(value, "utf8")
      .digest("hex")
  }`;
}

function issue(
  authIdValue: string | null,
  coordinate: string,
  kind: LinkedDeviceLifecycleAdmissionRecoveryIssue["kind"],
): LinkedDeviceLifecycleAdmissionRecoveryIssue {
  return Object.freeze({
    authId: authIdValue,
    coordinate,
    kind,
  });
}

export function recoverLinkedDeviceLifecycleAdmissions(
  environment: Environment = process.env,
): LinkedDeviceLifecycleAdmissionRecoveryReport {
  const claimDirectory = directory(environment);
  ensurePrivateStateDirectory(claimDirectory, environment);
  const entries = listPrivateStateDirectory(claimDirectory, environment);
  const issues: LinkedDeviceLifecycleAdmissionRecoveryIssue[] = [];
  let live = 0;
  let repaired = 0;
  let invalid = 0;

  for (const entry of entries) {
    const match = claimNamePattern.exec(entry.name);
    const coordinate = safeCoordinate(entry.name);
    if (
      match === null
      || match[1] === undefined
      || entry.kind !== "file"
    ) {
      invalid += 1;
      issues.push(issue(null, coordinate, "invalid-admission"));
      continue;
    }
    const key = match[1];
    let snapshot: LinkedDeviceLifecycleAdmissionClaimSnapshot | null;
    try {
      snapshot = readLinkedDeviceLifecycleAdmissionClaim(key, environment);
    } catch {
      invalid += 1;
      issues.push(issue(null, coordinate, "invalid-admission"));
      continue;
    }
    if (snapshot === null) continue;
    const ownerStatus = processOwnerStatus(snapshot.claim.owner);
    if (ownerStatus === "exact-live-owner") {
      live += 1;
      continue;
    }
    if (ownerStatus === "unknown") {
      issues.push(issue(snapshot.claim.authId, coordinate, "owner-unknown"));
      continue;
    }
    try {
      const removed = removePrivateStateFileIfUnchanged(
        pathFor(key, environment),
        { expectedCurrentContentSha256: snapshot.contentSha256 },
        environment,
      );
      if (removed) {
        repaired += 1;
        continue;
      }
      issues.push(issue(
        snapshot.claim.authId,
        coordinate,
        "recovery-conflict",
      ));
    } catch {
      issues.push(issue(
        snapshot.claim.authId,
        coordinate,
        "recovery-conflict",
      ));
    }
  }

  return Object.freeze({
    scanned: entries.length,
    live,
    repaired,
    invalid,
    issues: Object.freeze(issues),
  });
}

export function acquireLinkedDeviceLifecycleAdmission(
  realmKeyValue: string,
  authIdValue: string,
  acquiredAtValue: string,
  environment: Environment = process.env,
): LinkedDeviceLifecycleAdmission {
  const key = realmKey(realmKeyValue);
  const id = authId(authIdValue);
  const acquiredAt = timestamp(acquiredAtValue);
  ensurePrivateStateDirectory(directory(environment), environment);
  for (
    let attempt = 0;
    attempt < MAX_ACQUISITION_ATTEMPTS;
    attempt += 1
  ) {
    const owner = createLinkedDeviceLifecycleOwner(
      new Date(
        Date.parse(acquiredAt) + OWNER_LEASE_MILLISECONDS,
      ).toISOString(),
    );
    const snapshot = claimSnapshot(parseClaim({
      schemaVersion: ADMISSION_SCHEMA_VERSION,
      realmKey: key,
      authId: id,
      acquiredAt,
      owner,
    }));
    const created = createPrivateJsonIfAbsent(
      pathFor(key, environment),
      snapshot.claim,
      { environment, privateParent: true },
    );
    if (created.created) {
      let released = false;
      return Object.freeze({
        realmKey: key,
        authId: id,
        acquiredAt,
        owner,
        release: () => {
          if (released) return;
          const removed = removePrivateStateFileIfUnchanged(
            pathFor(key, environment),
            { expectedCurrentContentSha256: snapshot.contentSha256 },
            environment,
          );
          if (!removed) {
            throw new Error(
              "linked-device lifecycle admission changed before release",
            );
          }
          released = true;
        },
      });
    }
    const existing = readLinkedDeviceLifecycleAdmissionClaim(
      key,
      environment,
    );
    if (existing === null) continue;
    const ownerStatus = processOwnerStatus(existing.claim.owner);
    if (ownerStatus === "exact-live-owner") {
      throw new Error(
        `linked-device realm already has an active linked-device lifecycle through auth locator ${existing.claim.authId}`,
      );
    }
    if (ownerStatus === "unknown") {
      throw new Error(
        `linked-device realm lifecycle owner for auth locator ${existing.claim.authId} cannot be inspected safely`,
      );
    }
    removePrivateStateFileIfUnchanged(
      pathFor(key, environment),
      { expectedCurrentContentSha256: existing.contentSha256 },
      environment,
    );
  }
  throw new Error(
    `auth locator ${id} linked-device realm admission could not be acquired`,
  );
}

export const linkedDeviceLifecycleAdmissionStore:
LinkedDeviceLifecycleAdmissionStore = Object.freeze({
  recover: recoverLinkedDeviceLifecycleAdmissions,
  acquire: acquireLinkedDeviceLifecycleAdmission,
});
