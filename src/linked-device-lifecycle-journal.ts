import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json";
import {
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
  type ProcessOwnerStatus,
} from "./process-identity";
import {
  isPortableProviderPluginVersion,
  isProviderPluginId,
  isProviderPluginSurfaceId,
} from "./provider-plugin-identifiers";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  wrenchStateHome,
  readPrivateStateFileIfPresent,
  readPrivateStateFilesBatched,
  snapshotPrivateStateDirectory,
  writePrivateJsonIfUnchanged,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;
type OwnerInspector = (owner: ProcessOwnerIdentity) => ProcessOwnerStatus;

export const LINKED_DEVICE_LIFECYCLE_JOURNAL_SCHEMA_VERSION = 1 as const;
export const LINKED_DEVICE_LIFECYCLE_JOURNAL_STATE_DIRECTORY =
  "run-journals/linked-device-lifecycle" as const;

const MAX_JOURNAL_BYTES = 32 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const authIdPattern = /^[a-z][a-z0-9-]{0,47}$/u;

export type LinkedDeviceLifecycleOwner = ProcessOwnerIdentity & {
  readonly token: string;
  readonly leaseUntil: string;
};

export type LinkedDevicePairResult = {
  readonly kind: "pair";
  readonly resultingAuthContentHash: string;
};

export type LinkedDeviceSyncResult = {
  readonly kind: "sync";
  readonly itemsStored: number;
  readonly projection: "linked-device-local-store";
  readonly emitsProtocolAcknowledgements: true;
};

export type LinkedDeviceLifecycleResult =
  | LinkedDevicePairResult
  | LinkedDeviceSyncResult;

export type LinkedDeviceLifecycleReasonCode =
  | "prepared"
  | "external-outcome-pending"
  | "external-returned-commit-pending"
  | "preflight-failed"
  | "cancelled-before-begin"
  | "owner-exited-before-begin"
  | "runtime-error-after-begin"
  | "cancelled-after-begin"
  | "deadline-after-begin"
  | "external-returned-before-completion-persisted"
  | "owner-exited-after-begin"
  | "reconciled-not-applied";

export type LinkedDeviceLifecycleJournal = {
  readonly schemaVersion:
    typeof LINKED_DEVICE_LIFECYCLE_JOURNAL_SCHEMA_VERSION;
  readonly revision: number;
  readonly journalId: string;
  readonly kind: "pair" | "sync-once";
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly pluginImplementationHash: string;
  readonly lifecycleContractVersion: 1;
  readonly surfaceId: string;
  readonly authId: string;
  readonly authRealmHash: string;
  readonly authContentHash: string;
  readonly initialSubjectState: "bound" | "unbound";
  /** Pairing input is represented only by presence; raw phone data is forbidden. */
  readonly phoneProvided: boolean;
  readonly phase:
    | "prepared"
    | "external-begun"
    | "external-completed"
    | "terminal";
  readonly status:
    | "pending"
    | "succeeded"
    | "safe-retry"
    | "indeterminate";
  readonly reconciliation:
    | "not-required"
    | "required"
    | "resolved-applied"
    | "resolved-not-applied";
  readonly reconciliationHash: string | null;
  readonly owner: LinkedDeviceLifecycleOwner;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly externalStartedAt: string | null;
  readonly externalCompletedAt: string | null;
  readonly finishedAt: string | null;
  readonly reconciledAt: string | null;
  readonly result: LinkedDeviceLifecycleResult | null;
  readonly reasonCode: LinkedDeviceLifecycleReasonCode | null;
};

export type StartLinkedDeviceLifecycleJournal = {
  readonly journalId: string;
  readonly kind: LinkedDeviceLifecycleJournal["kind"];
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly pluginImplementationHash: string;
  readonly lifecycleContractVersion: 1;
  readonly surfaceId: string;
  readonly authId: string;
  readonly authRealmHash: string;
  readonly authContentHash: string;
  readonly initialSubjectState: "bound" | "unbound";
  readonly phoneProvided: boolean;
  readonly owner: LinkedDeviceLifecycleOwner;
  readonly startedAt: string;
};

export type LinkedDeviceLifecycleJournalEvent =
  | {
      readonly type: "external-begin";
      readonly at: string;
    }
  | {
      readonly type: "external-complete";
      readonly result: LinkedDeviceLifecycleResult;
      readonly at: string;
    }
  | {
      readonly type: "committed";
      readonly result: LinkedDeviceLifecycleResult;
      readonly at: string;
    }
  | {
      readonly type: "aborted-before-external";
      readonly reasonCode: "preflight-failed" | "cancelled-before-begin";
      readonly at: string;
    }
  | {
      readonly type: "outcome-not-durable";
      readonly reasonCode:
        | "runtime-error-after-begin"
        | "cancelled-after-begin"
        | "deadline-after-begin"
        | "external-returned-before-completion-persisted";
      readonly at: string;
    }
  | {
      readonly type: "reconciled";
      readonly outcome: "applied";
      readonly evidenceHash: string;
      readonly result: LinkedDeviceLifecycleResult;
      readonly at: string;
    }
  | {
      readonly type: "reconciled";
      readonly outcome: "not-applied";
      readonly evidenceHash: string;
      readonly at: string;
    }
  | {
      readonly type: "lease-renewed";
      readonly leaseUntil: string;
      readonly at: string;
    };

export type LinkedDeviceLifecycleJournalSnapshot = {
  readonly journal: LinkedDeviceLifecycleJournal;
  readonly contentSha256: string;
};

export type LinkedDeviceLifecycleRestartDisposition =
  | {
      readonly kind: "complete";
      readonly reason: string;
    }
  | {
      readonly kind: "live-owner";
      readonly reason: string;
    }
  | {
      readonly kind: "owner-unknown";
      readonly reason: string;
    }
  | {
      readonly kind: "safe-retry";
      readonly reason: string;
    }
  | {
      readonly kind: "reconciliation-required";
      readonly reason: string;
    };

export type LinkedDeviceLifecycleJournalListEntry =
  | LinkedDeviceLifecycleJournalSnapshot
  | {
      readonly journalId: string;
      readonly invalid: true;
    };

export type LinkedDeviceLifecycleWriteAuthority = {
  readonly owner: LinkedDeviceLifecycleOwner;
  readonly environment?: Environment;
};

function dataRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype`);
  }
  const result: JsonRecord = {};
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
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be one canonical UTC timestamp`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : canonicalTimestamp(value, label);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function strictPluginVersion(value: unknown): string {
  if (!isPortableProviderPluginVersion(value)) {
    throw new Error("linked-device lifecycle plugin version is malformed");
  }
  return value;
}

function journalId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error("linked-device lifecycle journal ID is malformed");
  }
  return value;
}

function parseOwner(value: unknown): LinkedDeviceLifecycleOwner {
  const record = dataRecord(value, "linked-device lifecycle journal owner");
  exactKeys(
    record,
    ["pid", "token", "bootId", "processStartId", "leaseUntil"],
    "linked-device lifecycle journal owner",
  );
  if (
    typeof record.pid !== "number"
    || !Number.isSafeInteger(record.pid)
    || record.pid < 1
    || record.pid > 2_147_483_647
    || typeof record.token !== "string"
    || !uuidPattern.test(record.token)
  ) {
    throw new Error("linked-device lifecycle journal owner is malformed");
  }
  return Object.freeze({
    pid: record.pid,
    token: record.token,
    bootId: digest(
      record.bootId,
      "linked-device lifecycle journal owner boot identity",
    ),
    processStartId: digest(
      record.processStartId,
      "linked-device lifecycle journal owner process identity",
    ),
    leaseUntil: canonicalTimestamp(
      record.leaseUntil,
      "linked-device lifecycle journal owner lease",
    ),
  });
}

export function parseLinkedDeviceLifecycleOwner(
  value: unknown,
): LinkedDeviceLifecycleOwner {
  return parseOwner(value);
}

function parseResult(value: unknown): LinkedDeviceLifecycleResult {
  const record = dataRecord(value, "linked-device lifecycle result");
  if (record.kind === "pair") {
    exactKeys(
      record,
      ["kind", "resultingAuthContentHash"],
      "linked-device pair result",
    );
    return Object.freeze({
      kind: "pair",
      resultingAuthContentHash: digest(
        record.resultingAuthContentHash,
        "linked-device pair resulting auth content hash",
      ),
    });
  }
  if (record.kind === "sync") {
    exactKeys(
      record,
      ["kind", "itemsStored", "projection", "emitsProtocolAcknowledgements"],
      "linked-device sync result",
    );
    if (
      typeof record.itemsStored !== "number"
      || !Number.isSafeInteger(record.itemsStored)
      || record.itemsStored < 0
      || record.itemsStored > 1_000_000_000
      || record.projection !== "linked-device-local-store"
      || record.emitsProtocolAcknowledgements !== true
    ) {
      throw new Error("linked-device sync result is malformed");
    }
    return Object.freeze({
      kind: "sync",
      itemsStored: record.itemsStored,
      projection: record.projection,
      emitsProtocolAcknowledgements: record.emitsProtocolAcknowledgements,
    });
  }
  throw new Error("linked-device lifecycle result kind is unsupported");
}

function nullableResult(value: unknown): LinkedDeviceLifecycleResult | null {
  return value === null ? null : parseResult(value);
}

function sameResult(
  left: LinkedDeviceLifecycleResult,
  right: LinkedDeviceLifecycleResult,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function resultMatchesJournalKind(
  result: LinkedDeviceLifecycleResult,
  kind: LinkedDeviceLifecycleJournal["kind"],
): boolean {
  return (result.kind === "pair" && kind === "pair")
    || (result.kind === "sync" && kind === "sync-once");
}

function reasonCode(
  value: unknown,
): LinkedDeviceLifecycleReasonCode | null {
  if (value === null) return null;
  if (
    value === "prepared"
    || value === "external-outcome-pending"
    || value === "external-returned-commit-pending"
    || value === "preflight-failed"
    || value === "cancelled-before-begin"
    || value === "owner-exited-before-begin"
    || value === "runtime-error-after-begin"
    || value === "cancelled-after-begin"
    || value === "deadline-after-begin"
    || value === "external-returned-before-completion-persisted"
    || value === "owner-exited-after-begin"
    || value === "reconciled-not-applied"
  ) {
    return value;
  }
  throw new Error("linked-device lifecycle reason code is unsupported");
}

function preBeginReasonCode(
  value: unknown,
): "preflight-failed" | "cancelled-before-begin" {
  if (value !== "preflight-failed" && value !== "cancelled-before-begin") {
    throw new Error(
      "linked-device lifecycle pre-begin reason code is unsupported",
    );
  }
  return value;
}

function postBeginReasonCode(
  value: unknown,
):
  | "runtime-error-after-begin"
  | "cancelled-after-begin"
  | "deadline-after-begin"
  | "external-returned-before-completion-persisted" {
  if (
    value !== "runtime-error-after-begin"
    && value !== "cancelled-after-begin"
    && value !== "deadline-after-begin"
    && value !== "external-returned-before-completion-persisted"
  ) {
    throw new Error(
      "linked-device lifecycle post-begin reason code is unsupported",
    );
  }
  return value;
}

function assertTimestampOrder(
  earlier: string,
  later: string,
  label: string,
): void {
  if (Date.parse(later) < Date.parse(earlier)) {
    throw new Error(`${label} moved backward`);
  }
}

function assertJournalInvariants(journal: LinkedDeviceLifecycleJournal): void {
  assertTimestampOrder(
    journal.startedAt,
    journal.updatedAt,
    "linked-device lifecycle journal update",
  );
  assertTimestampOrder(
    journal.startedAt,
    journal.owner.leaseUntil,
    "linked-device lifecycle journal owner lease",
  );
  if (
    journal.kind === "sync-once"
    && (
      journal.phoneProvided
      || journal.initialSubjectState !== "bound"
    )
  ) {
    throw new Error(
      "linked-device sync lifecycle requires bound auth and forbids phone input",
    );
  }
  if (
    journal.result !== null
    && !resultMatchesJournalKind(journal.result, journal.kind)
  ) {
    throw new Error("linked-device lifecycle result kind contradicts its journal");
  }
  if (journal.externalStartedAt !== null) {
    assertTimestampOrder(
      journal.startedAt,
      journal.externalStartedAt,
      "linked-device lifecycle external start",
    );
    assertTimestampOrder(
      journal.externalStartedAt,
      journal.updatedAt,
      "linked-device lifecycle post-external update",
    );
  }
  if (journal.externalCompletedAt !== null) {
    if (journal.externalStartedAt === null) {
      throw new Error("linked-device lifecycle completion has no external start");
    }
    assertTimestampOrder(
      journal.externalStartedAt,
      journal.externalCompletedAt,
      "linked-device lifecycle external completion",
    );
    assertTimestampOrder(
      journal.externalCompletedAt,
      journal.updatedAt,
      "linked-device lifecycle post-completion update",
    );
  }
  if (journal.finishedAt !== null) {
    assertTimestampOrder(
      journal.startedAt,
      journal.finishedAt,
      "linked-device lifecycle finish",
    );
    assertTimestampOrder(
      journal.finishedAt,
      journal.updatedAt,
      "linked-device lifecycle post-finish update",
    );
    if (journal.externalStartedAt !== null) {
      assertTimestampOrder(
        journal.externalStartedAt,
        journal.finishedAt,
        "linked-device lifecycle external-to-finish order",
      );
    }
    if (journal.externalCompletedAt !== null) {
      assertTimestampOrder(
        journal.externalCompletedAt,
        journal.finishedAt,
        "linked-device lifecycle completion-to-finish order",
      );
    }
  }
  if (journal.reconciledAt !== null) {
    if (journal.finishedAt === null) {
      throw new Error("linked-device lifecycle reconciliation has no finish");
    }
    assertTimestampOrder(
      journal.finishedAt,
      journal.reconciledAt,
      "linked-device lifecycle reconciliation",
    );
    assertTimestampOrder(
      journal.reconciledAt,
      journal.updatedAt,
      "linked-device lifecycle post-reconciliation update",
    );
  }

  if (journal.phase === "prepared") {
    if (
      journal.status !== "pending"
      || journal.reconciliation !== "not-required"
      || journal.reconciliationHash !== null
      || journal.externalStartedAt !== null
      || journal.externalCompletedAt !== null
      || journal.finishedAt !== null
      || journal.reconciledAt !== null
      || journal.result !== null
      || journal.reasonCode !== "prepared"
    ) throw new Error("prepared linked-device lifecycle journal is contradictory");
    return;
  }
  if (journal.phase === "external-begun") {
    if (
      journal.revision < 1
      || journal.status !== "pending"
      || journal.reconciliation !== "not-required"
      || journal.reconciliationHash !== null
      || journal.externalStartedAt === null
      || journal.externalCompletedAt !== null
      || journal.finishedAt !== null
      || journal.reconciledAt !== null
      || journal.result !== null
      || journal.reasonCode !== "external-outcome-pending"
    ) throw new Error("begun linked-device lifecycle journal is contradictory");
    return;
  }
  if (journal.phase === "external-completed") {
    if (
      journal.revision < 2
      || journal.status !== "pending"
      || journal.reconciliation !== "not-required"
      || journal.reconciliationHash !== null
      || journal.externalStartedAt === null
      || journal.externalCompletedAt === null
      || journal.finishedAt !== null
      || journal.reconciledAt !== null
      || journal.result === null
      || journal.reasonCode !== "external-returned-commit-pending"
    ) throw new Error("completed linked-device lifecycle journal is contradictory");
    return;
  }
  if (journal.status === "pending" || journal.finishedAt === null) {
    throw new Error("terminal linked-device lifecycle journal is contradictory");
  }
  if (journal.status === "indeterminate") {
    const returnedWithoutDurableBegin =
      journal.revision === 1
      && journal.reasonCode
        === "external-returned-before-completion-persisted"
      && journal.externalCompletedAt === null
      && journal.result === null;
    if (
      (journal.revision < 2 && !returnedWithoutDurableBegin)
      || journal.externalStartedAt === null
      || journal.reconciliation !== "required"
      || journal.reconciliationHash !== null
      || journal.reconciledAt !== null
      || (
        journal.reasonCode !== "runtime-error-after-begin"
        && journal.reasonCode !== "cancelled-after-begin"
        && journal.reasonCode !== "deadline-after-begin"
        && journal.reasonCode
          !== "external-returned-before-completion-persisted"
        && journal.reasonCode !== "owner-exited-after-begin"
      )
      || (
        (journal.externalCompletedAt === null) !== (journal.result === null)
      )
    ) {
      throw new Error(
        "indeterminate linked-device lifecycle journal is contradictory",
      );
    }
    return;
  }
  if (journal.status === "succeeded") {
    if (
      journal.revision < 3
      || journal.externalStartedAt === null
      || journal.result === null
      || journal.reasonCode !== null
      || (
        journal.reconciliation === "not-required"
          ? journal.reconciliationHash !== null
            || journal.reconciledAt !== null
            || journal.externalCompletedAt === null
          : journal.reconciliation !== "resolved-applied"
            || journal.reconciliationHash === null
            || journal.reconciledAt === null
      )
    ) {
      throw new Error(
        "successful linked-device lifecycle journal is contradictory",
      );
    }
    return;
  }
  if (
    journal.status !== "safe-retry"
    || journal.result !== null
    || (
      journal.reconciliation === "not-required"
        ? journal.revision < 1
          || journal.reconciliationHash !== null
          || journal.reconciledAt !== null
          || journal.externalStartedAt !== null
          || journal.externalCompletedAt !== null
          || (
            journal.reasonCode !== "preflight-failed"
            && journal.reasonCode !== "cancelled-before-begin"
            && journal.reasonCode !== "owner-exited-before-begin"
          )
        : journal.reconciliation !== "resolved-not-applied"
          || journal.revision < 3
          || journal.reconciliationHash === null
          || journal.reconciledAt === null
          || journal.externalStartedAt === null
          || journal.externalCompletedAt !== null
          || journal.reasonCode !== "reconciled-not-applied"
    )
  ) {
    throw new Error("retryable linked-device lifecycle journal is contradictory");
  }
}

export function parseLinkedDeviceLifecycleJournal(
  value: unknown,
): LinkedDeviceLifecycleJournal {
  const record = dataRecord(value, "linked-device lifecycle journal");
  exactKeys(record, [
    "schemaVersion",
    "revision",
    "journalId",
    "kind",
    "pluginId",
    "pluginVersion",
    "pluginImplementationHash",
    "lifecycleContractVersion",
    "surfaceId",
    "authId",
    "authRealmHash",
    "authContentHash",
    "initialSubjectState",
    "phoneProvided",
    "phase",
    "status",
    "reconciliation",
    "reconciliationHash",
    "owner",
    "startedAt",
    "updatedAt",
    "externalStartedAt",
    "externalCompletedAt",
    "finishedAt",
    "reconciledAt",
    "result",
    "reasonCode",
  ], "linked-device lifecycle journal");
  if (
    record.schemaVersion !== LINKED_DEVICE_LIFECYCLE_JOURNAL_SCHEMA_VERSION
    || typeof record.revision !== "number"
    || !Number.isSafeInteger(record.revision)
    || record.revision < 0
    || record.revision >= Number.MAX_SAFE_INTEGER
    || (record.kind !== "pair" && record.kind !== "sync-once")
    || !isProviderPluginId(record.pluginId)
    || record.lifecycleContractVersion !== 1
    || !isProviderPluginSurfaceId(record.surfaceId)
    || typeof record.authId !== "string"
    || !authIdPattern.test(record.authId)
    || (
      record.initialSubjectState !== "bound"
      && record.initialSubjectState !== "unbound"
    )
    || typeof record.phoneProvided !== "boolean"
    || (
      record.phase !== "prepared"
      && record.phase !== "external-begun"
      && record.phase !== "external-completed"
      && record.phase !== "terminal"
    )
    || (
      record.status !== "pending"
      && record.status !== "succeeded"
      && record.status !== "safe-retry"
      && record.status !== "indeterminate"
    )
    || (
      record.reconciliation !== "not-required"
      && record.reconciliation !== "required"
      && record.reconciliation !== "resolved-applied"
      && record.reconciliation !== "resolved-not-applied"
    )
  ) {
    throw new Error("linked-device lifecycle journal is malformed");
  }
  const journal: LinkedDeviceLifecycleJournal = {
    schemaVersion: LINKED_DEVICE_LIFECYCLE_JOURNAL_SCHEMA_VERSION,
    revision: record.revision,
    journalId: journalId(record.journalId),
    kind: record.kind,
    pluginId: record.pluginId,
    pluginVersion: strictPluginVersion(record.pluginVersion),
    pluginImplementationHash: digest(
      record.pluginImplementationHash,
      "linked-device lifecycle plugin implementation hash",
    ),
    lifecycleContractVersion: 1,
    surfaceId: record.surfaceId,
    authId: record.authId,
    authRealmHash: digest(
      record.authRealmHash,
      "linked-device lifecycle auth realm hash",
    ),
    authContentHash: digest(
      record.authContentHash,
      "linked-device lifecycle auth content hash",
    ),
    initialSubjectState: record.initialSubjectState,
    phoneProvided: record.phoneProvided,
    phase: record.phase,
    status: record.status,
    reconciliation: record.reconciliation,
    reconciliationHash: nullableDigest(
      record.reconciliationHash,
      "linked-device lifecycle reconciliation hash",
    ),
    owner: parseOwner(record.owner),
    startedAt: canonicalTimestamp(
      record.startedAt,
      "linked-device lifecycle start",
    ),
    updatedAt: canonicalTimestamp(
      record.updatedAt,
      "linked-device lifecycle update",
    ),
    externalStartedAt: nullableTimestamp(
      record.externalStartedAt,
      "linked-device lifecycle external start",
    ),
    externalCompletedAt: nullableTimestamp(
      record.externalCompletedAt,
      "linked-device lifecycle external completion",
    ),
    finishedAt: nullableTimestamp(
      record.finishedAt,
      "linked-device lifecycle finish",
    ),
    reconciledAt: nullableTimestamp(
      record.reconciledAt,
      "linked-device lifecycle reconciliation",
    ),
    result: nullableResult(record.result),
    reasonCode: reasonCode(record.reasonCode),
  };
  assertJournalInvariants(journal);
  if (Buffer.byteLength(canonicalJson(journal), "utf8") > MAX_JOURNAL_BYTES) {
    throw new Error("linked-device lifecycle journal exceeds its byte bound");
  }
  return Object.freeze({
    ...journal,
    owner: Object.freeze({ ...journal.owner }),
    ...(journal.result === null
      ? { result: null }
      : { result: Object.freeze({ ...journal.result }) }),
  });
}

export function createLinkedDeviceLifecycleOwner(
  leaseUntilValue: string,
): LinkedDeviceLifecycleOwner {
  const identity = currentProcessStartIdentity();
  return parseOwner({
    pid: process.pid,
    token: randomUUID(),
    bootId: identity.bootId,
    processStartId: identity.processStartId,
    leaseUntil: leaseUntilValue,
  });
}

export function initialLinkedDeviceLifecycleJournal(
  value: StartLinkedDeviceLifecycleJournal,
): LinkedDeviceLifecycleJournal {
  const input = dataRecord(
    value,
    "linked-device lifecycle journal start",
  );
  exactKeys(input, [
    "journalId",
    "kind",
    "pluginId",
    "pluginVersion",
    "pluginImplementationHash",
    "lifecycleContractVersion",
    "surfaceId",
    "authId",
    "authRealmHash",
    "authContentHash",
    "initialSubjectState",
    "phoneProvided",
    "owner",
    "startedAt",
  ], "linked-device lifecycle journal start");
  return parseLinkedDeviceLifecycleJournal({
    schemaVersion: LINKED_DEVICE_LIFECYCLE_JOURNAL_SCHEMA_VERSION,
    revision: 0,
    journalId: input.journalId,
    kind: input.kind,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    pluginImplementationHash: input.pluginImplementationHash,
    lifecycleContractVersion: input.lifecycleContractVersion,
    surfaceId: input.surfaceId,
    authId: input.authId,
    authRealmHash: input.authRealmHash,
    authContentHash: input.authContentHash,
    initialSubjectState: input.initialSubjectState,
    phoneProvided: input.phoneProvided,
    phase: "prepared",
    status: "pending",
    reconciliation: "not-required",
    reconciliationHash: null,
    owner: input.owner,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    externalStartedAt: null,
    externalCompletedAt: null,
    finishedAt: null,
    reconciledAt: null,
    result: null,
    reasonCode: "prepared",
  });
}

function parseEvent(value: unknown): LinkedDeviceLifecycleJournalEvent {
  const record = dataRecord(value, "linked-device lifecycle journal event");
  if (record.type === "external-begin") {
    exactKeys(record, ["type", "at"], "linked-device lifecycle journal event");
    return {
      type: "external-begin",
      at: canonicalTimestamp(record.at, "linked-device lifecycle event time"),
    };
  }
  if (record.type === "committed") {
    exactKeys(
      record,
      ["type", "result", "at"],
      "linked-device lifecycle journal event",
    );
    return {
      type: "committed",
      result: parseResult(record.result),
      at: canonicalTimestamp(record.at, "linked-device lifecycle event time"),
    };
  }
  if (record.type === "external-complete") {
    exactKeys(
      record,
      ["type", "result", "at"],
      "linked-device lifecycle journal event",
    );
    return {
      type: "external-complete",
      result: parseResult(record.result),
      at: canonicalTimestamp(record.at, "linked-device lifecycle event time"),
    };
  }
  if (record.type === "aborted-before-external") {
    exactKeys(
      record,
      ["type", "reasonCode", "at"],
      "linked-device lifecycle journal event",
    );
    return {
      type: "aborted-before-external",
      reasonCode: preBeginReasonCode(record.reasonCode),
      at: canonicalTimestamp(record.at, "linked-device lifecycle event time"),
    };
  }
  if (record.type === "outcome-not-durable") {
    exactKeys(
      record,
      ["type", "reasonCode", "at"],
      "linked-device lifecycle journal event",
    );
    return {
      type: "outcome-not-durable",
      reasonCode: postBeginReasonCode(record.reasonCode),
      at: canonicalTimestamp(record.at, "linked-device lifecycle event time"),
    };
  }
  if (record.type === "reconciled" && record.outcome === "applied") {
    exactKeys(
      record,
      ["type", "outcome", "evidenceHash", "result", "at"],
      "linked-device lifecycle journal event",
    );
    return {
      type: "reconciled",
      outcome: "applied",
      evidenceHash: digest(
        record.evidenceHash,
        "linked-device reconciliation evidence hash",
      ),
      result: parseResult(record.result),
      at: canonicalTimestamp(record.at, "linked-device lifecycle event time"),
    };
  }
  if (record.type === "reconciled" && record.outcome === "not-applied") {
    exactKeys(
      record,
      ["type", "outcome", "evidenceHash", "at"],
      "linked-device lifecycle journal event",
    );
    return {
      type: "reconciled",
      outcome: "not-applied",
      evidenceHash: digest(
        record.evidenceHash,
        "linked-device reconciliation evidence hash",
      ),
      at: canonicalTimestamp(record.at, "linked-device lifecycle event time"),
    };
  }
  if (record.type === "lease-renewed") {
    exactKeys(
      record,
      ["type", "leaseUntil", "at"],
      "linked-device lifecycle journal event",
    );
    return {
      type: "lease-renewed",
      leaseUntil: canonicalTimestamp(
        record.leaseUntil,
        "linked-device lifecycle renewed lease",
      ),
      at: canonicalTimestamp(record.at, "linked-device lifecycle event time"),
    };
  }
  throw new Error("linked-device lifecycle journal event is malformed");
}

function nextRevision(current: LinkedDeviceLifecycleJournal): number {
  if (current.revision >= Number.MAX_SAFE_INTEGER - 1) {
    throw new Error("linked-device lifecycle journal revision is exhausted");
  }
  return current.revision + 1;
}

export function transitionLinkedDeviceLifecycleJournal(
  currentValue: LinkedDeviceLifecycleJournal,
  eventValue: LinkedDeviceLifecycleJournalEvent,
): LinkedDeviceLifecycleJournal {
  const current = parseLinkedDeviceLifecycleJournal(currentValue);
  const event = parseEvent(eventValue);
  assertTimestampOrder(
    current.updatedAt,
    event.at,
    "linked-device lifecycle transition time",
  );
  const revision = nextRevision(current);
  if (event.type === "external-begin") {
    if (current.phase !== "prepared" || current.status !== "pending") {
      throw new Error("external begin is legal only from prepared lifecycle state");
    }
    return parseLinkedDeviceLifecycleJournal({
      ...current,
      revision,
      phase: "external-begun",
      externalStartedAt: event.at,
      updatedAt: event.at,
      reasonCode: "external-outcome-pending",
    });
  }
  if (event.type === "external-complete") {
    if (current.phase !== "external-begun" || current.status !== "pending") {
      throw new Error("external completion is legal only after external begin");
    }
    if (!resultMatchesJournalKind(event.result, current.kind)) {
      throw new Error("external result kind does not match the lifecycle journal");
    }
    return parseLinkedDeviceLifecycleJournal({
      ...current,
      revision,
      phase: "external-completed",
      externalCompletedAt: event.at,
      result: event.result,
      updatedAt: event.at,
      reasonCode: "external-returned-commit-pending",
    });
  }
  if (event.type === "committed") {
    if (
      current.phase !== "external-completed"
      || current.status !== "pending"
      || current.result === null
    ) {
      throw new Error("lifecycle commit is legal only after external completion");
    }
    if (!sameResult(current.result, event.result)) {
      throw new Error(
        "lifecycle commit result does not match the externally completed result",
      );
    }
    return parseLinkedDeviceLifecycleJournal({
      ...current,
      revision,
      phase: "terminal",
      status: "succeeded",
      finishedAt: event.at,
      updatedAt: event.at,
      reasonCode: null,
    });
  }
  if (event.type === "aborted-before-external") {
    if (current.phase !== "prepared" || current.status !== "pending") {
      throw new Error("safe abort is legal only before external begin");
    }
    return parseLinkedDeviceLifecycleJournal({
      ...current,
      revision,
      phase: "terminal",
      status: "safe-retry",
      finishedAt: event.at,
      updatedAt: event.at,
      reasonCode: event.reasonCode,
    });
  }
  if (event.type === "outcome-not-durable") {
    const returnedBeforeDurableBegin =
      current.phase === "prepared"
      && event.reasonCode
        === "external-returned-before-completion-persisted";
    if (
      (
        !returnedBeforeDurableBegin
        && current.phase !== "external-begun"
        && current.phase !== "external-completed"
      )
      || current.status !== "pending"
    ) {
      throw new Error(
        "indeterminate outcome is legal only after external begin or a returned external call",
      );
    }
    return parseLinkedDeviceLifecycleJournal({
      ...current,
      revision,
      phase: "terminal",
      status: "indeterminate",
      reconciliation: "required",
      externalStartedAt: returnedBeforeDurableBegin
        ? event.at
        : current.externalStartedAt,
      finishedAt: event.at,
      updatedAt: event.at,
      reasonCode: event.reasonCode,
    });
  }
  if (event.type === "reconciled") {
    if (
      current.phase !== "terminal"
      || current.status !== "indeterminate"
      || current.reconciliation !== "required"
    ) {
      throw new Error(
        "reconciliation is legal only for an indeterminate lifecycle",
      );
    }
    if (event.outcome === "applied") {
      if (!resultMatchesJournalKind(event.result, current.kind)) {
        throw new Error(
          "reconciled result kind does not match the lifecycle journal",
        );
      }
      if (
        current.result !== null
        && !sameResult(current.result, event.result)
      ) {
        throw new Error(
          "reconciled result contradicts the previously completed result",
        );
      }
      return parseLinkedDeviceLifecycleJournal({
        ...current,
        revision,
        status: "succeeded",
        reconciliation: "resolved-applied",
        reconciliationHash: event.evidenceHash,
        reconciledAt: event.at,
        result: event.result,
        updatedAt: event.at,
        reasonCode: null,
      });
    }
    if (
      current.externalCompletedAt !== null
      || current.result !== null
      || current.reasonCode
        === "external-returned-before-completion-persisted"
    ) {
      throw new Error(
        "not-applied reconciliation contradicts durable external completion",
      );
    }
    return parseLinkedDeviceLifecycleJournal({
      ...current,
      revision,
      status: "safe-retry",
      reconciliation: "resolved-not-applied",
      reconciliationHash: event.evidenceHash,
      reconciledAt: event.at,
      result: null,
      updatedAt: event.at,
      reasonCode: "reconciled-not-applied",
    });
  }
  if (
    current.phase === "terminal"
    && current.status !== "indeterminate"
  ) {
    throw new Error("resolved linked-device lifecycle journals cannot renew");
  }
  assertTimestampOrder(
    event.at,
    event.leaseUntil,
    "linked-device lifecycle renewed lease",
  );
  assertTimestampOrder(
    current.owner.leaseUntil,
    event.leaseUntil,
    "linked-device lifecycle renewed lease",
  );
  return parseLinkedDeviceLifecycleJournal({
    ...current,
    revision,
    owner: {
      ...current.owner,
      leaseUntil: event.leaseUntil,
    },
    updatedAt: event.at,
  });
}

function journalDirectory(environment: Environment): string {
  return join(
    wrenchStateHome(environment),
    ...LINKED_DEVICE_LIFECYCLE_JOURNAL_STATE_DIRECTORY.split("/"),
  );
}

function journalPath(journalIdValue: string, environment: Environment): string {
  return join(journalDirectory(environment), `${journalId(journalIdValue)}.json`);
}

function snapshot(
  journalValue: LinkedDeviceLifecycleJournal,
): LinkedDeviceLifecycleJournalSnapshot {
  const journal = parseLinkedDeviceLifecycleJournal(journalValue);
  const content = `${canonicalJson(journal)}\n`;
  return Object.freeze({
    journal,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  });
}

function assertSnapshot(
  value: LinkedDeviceLifecycleJournalSnapshot,
): LinkedDeviceLifecycleJournalSnapshot {
  const record = dataRecord(
    value,
    "linked-device lifecycle journal snapshot",
  );
  exactKeys(
    record,
    ["journal", "contentSha256"],
    "linked-device lifecycle journal snapshot",
  );
  if (
    typeof record.contentSha256 !== "string"
    || !sha256Pattern.test(record.contentSha256)
  ) {
    throw new Error("linked-device lifecycle journal snapshot is malformed");
  }
  const canonical = snapshot(
    parseLinkedDeviceLifecycleJournal(record.journal),
  );
  if (canonical.contentSha256 !== record.contentSha256) {
    throw new Error(
      "linked-device lifecycle journal snapshot is not content-bound",
    );
  }
  return canonical;
}

function parseSnapshotText(text: string): LinkedDeviceLifecycleJournalSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("linked-device lifecycle journal is malformed");
  }
  const parsed = parseLinkedDeviceLifecycleJournal(value);
  const canonical = `${canonicalJson(parsed)}\n`;
  if (text !== canonical) {
    throw new Error("linked-device lifecycle journal is not canonical JSON");
  }
  return Object.freeze({
    journal: parsed,
    contentSha256: createHash("sha256").update(text).digest("hex"),
  });
}

function sameOwnerAuthority(
  left: LinkedDeviceLifecycleOwner,
  right: LinkedDeviceLifecycleOwner,
): boolean {
  return left.pid === right.pid
    && left.token === right.token
    && left.bootId === right.bootId
    && left.processStartId === right.processStartId;
}

function isCurrentProcessOwner(owner: ProcessOwnerIdentity): boolean {
  const identity = currentProcessStartIdentity();
  return owner.pid === process.pid
    && owner.bootId === identity.bootId
    && owner.processStartId === identity.processStartId;
}

function requireExactLiveOwner(
  ownerValue: LinkedDeviceLifecycleOwner,
): LinkedDeviceLifecycleOwner {
  const owner = parseOwner(ownerValue);
  if (!isCurrentProcessOwner(owner)) {
    throw new Error(
      "linked-device lifecycle write owner is not the current process",
    );
  }
  if (processOwnerStatus(owner) !== "exact-live-owner") {
    throw new Error("linked-device lifecycle write owner is not exact and live");
  }
  return owner;
}

function requireWriteAuthority(
  journal: LinkedDeviceLifecycleJournal,
  authority: LinkedDeviceLifecycleWriteAuthority,
): LinkedDeviceLifecycleOwner {
  const owner = requireExactLiveOwner(authority.owner);
  if (!sameOwnerAuthority(journal.owner, owner)) {
    throw new Error("linked-device lifecycle write authority does not own the journal");
  }
  return owner;
}

export function createLinkedDeviceLifecycleJournal(
  journalValue: LinkedDeviceLifecycleJournal,
  environment: Environment = process.env,
): LinkedDeviceLifecycleJournalSnapshot {
  const journal = parseLinkedDeviceLifecycleJournal(journalValue);
  if (journal.revision !== 0 || journal.phase !== "prepared") {
    throw new Error(
      "new linked-device lifecycle journals must start prepared at revision zero",
    );
  }
  requireExactLiveOwner(journal.owner);
  ensurePrivateStateDirectory(journalDirectory(environment), environment);
  const created = createPrivateJsonIfAbsent(
    journalPath(journal.journalId, environment),
    journal,
    { environment, privateParent: true },
  );
  if (!created.created) {
    throw new Error("linked-device lifecycle journal ID already exists");
  }
  return snapshot(journal);
}

export function readLinkedDeviceLifecycleJournal(
  journalIdValue: string,
  environment: Environment = process.env,
): LinkedDeviceLifecycleJournalSnapshot | null {
  ensurePrivateStateDirectory(journalDirectory(environment), environment);
  const text = readPrivateStateFileIfPresent(
    journalPath(journalIdValue, environment),
    MAX_JOURNAL_BYTES,
    "linked-device lifecycle journal",
    environment,
  );
  return text === null ? null : parseSnapshotText(text);
}

export function updateLinkedDeviceLifecycleJournal(
  currentValue: LinkedDeviceLifecycleJournalSnapshot,
  event: LinkedDeviceLifecycleJournalEvent,
  authority: LinkedDeviceLifecycleWriteAuthority,
): LinkedDeviceLifecycleJournalSnapshot {
  const current = assertSnapshot(currentValue);
  requireWriteAuthority(current.journal, authority);
  const next = transitionLinkedDeviceLifecycleJournal(current.journal, event);
  const written = writePrivateJsonIfUnchanged(
    journalPath(
      current.journal.journalId,
      authority.environment ?? process.env,
    ),
    next,
    { expectedCurrentContentSha256: current.contentSha256 },
  );
  if (!written) {
    throw new Error(
      "linked-device lifecycle journal changed concurrently; reload before continuing",
    );
  }
  return snapshot(next);
}

export function listLinkedDeviceLifecycleJournalSnapshots(
  environment: Environment = process.env,
): readonly LinkedDeviceLifecycleJournalListEntry[] {
  const directory = journalDirectory(environment);
  const identity = ensurePrivateStateDirectory(directory, environment);
  const directorySnapshot = snapshotPrivateStateDirectory(
    directory,
    environment,
    identity,
  );
  if (directorySnapshot.identity === null) return Object.freeze([]);
  const expectedNamePattern =
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
  const fileNames = directorySnapshot.entries
    .filter((entry) =>
      entry.kind === "file"
      && expectedNamePattern.test(entry.name))
    .map((entry) => entry.name);
  const fileByName = new Map(
    readPrivateStateFilesBatched(directory, fileNames, {
      maximumBytesPerFile: MAX_JOURNAL_BYTES,
      environment,
      expectedDirectoryIdentity: directorySnapshot.identity,
    }).map((file) => [file.name, file] as const),
  );
  return Object.freeze(directorySnapshot.entries.map((entry) => {
    const match = expectedNamePattern.exec(entry.name);
    if (match === null || match[1] === undefined) {
      return {
        journalId: `invalid-${
          createHash("sha256")
            .update("linked-device-lifecycle-invalid-entry\0", "utf8")
            .update(entry.name, "utf8")
            .digest("hex")
        }`,
        invalid: true as const,
      };
    }
    const id = match[1];
    if (entry.kind !== "file") {
      return { journalId: id, invalid: true as const };
    }
    const file = fileByName.get(entry.name);
    if (file === undefined || file.status !== "present") {
      return { journalId: id, invalid: true as const };
    }
    try {
      const parsed = parseSnapshotText(file.content);
      return parsed.journal.journalId === id
        ? parsed
        : { journalId: id, invalid: true as const };
    } catch {
      return { journalId: id, invalid: true as const };
    }
  }));
}

export function classifyLinkedDeviceLifecycleRestart(
  journalValue: LinkedDeviceLifecycleJournal,
  inspectOwner: OwnerInspector = processOwnerStatus,
): LinkedDeviceLifecycleRestartDisposition {
  const journal = parseLinkedDeviceLifecycleJournal(journalValue);
  if (journal.phase === "terminal" && journal.status !== "indeterminate") {
    return Object.freeze({
      kind: "complete",
      reason: "the linked-device lifecycle already has a resolved terminal outcome",
    });
  }
  const ownerStatus = inspectOwner(journal.owner);
  if (ownerStatus === "exact-live-owner") {
    return Object.freeze({
      kind: "live-owner",
      reason: "the exact process owner is still live; restart repair is forbidden",
    });
  }
  if (ownerStatus === "unknown") {
    return Object.freeze({
      kind: "owner-unknown",
      reason: "process ownership is unknown; restart repair must fail closed",
    });
  }
  if (journal.phase === "prepared") {
    return Object.freeze({
      kind: "safe-retry",
      reason: "the previous owner ended before the durable external begin boundary",
    });
  }
  return Object.freeze({
    kind: "reconciliation-required",
    reason: "the durable external begin boundary was crossed without a resolved outcome",
  });
}

export function repairInterruptedLinkedDeviceLifecycleJournal(
  currentValue: LinkedDeviceLifecycleJournalSnapshot,
  options: {
    readonly owner: LinkedDeviceLifecycleOwner;
    readonly at: string;
    readonly environment?: Environment;
  },
): LinkedDeviceLifecycleJournalSnapshot {
  const current = assertSnapshot(currentValue);
  const at = canonicalTimestamp(
    options.at,
    "linked-device lifecycle repair time",
  );
  assertTimestampOrder(
    current.journal.updatedAt,
    at,
    "linked-device lifecycle repair time",
  );
  const repairOwner = requireExactLiveOwner(options.owner);
  assertTimestampOrder(
    at,
    repairOwner.leaseUntil,
    "linked-device lifecycle repair owner lease",
  );
  const disposition = classifyLinkedDeviceLifecycleRestart(
    current.journal,
    processOwnerStatus,
  );
  if (
    disposition.kind !== "safe-retry"
    && disposition.kind !== "reconciliation-required"
  ) {
    throw new Error(`linked-device lifecycle cannot be repaired: ${disposition.reason}`);
  }
  const revision = nextRevision(current.journal);
  const next = disposition.kind === "safe-retry"
    ? parseLinkedDeviceLifecycleJournal({
        ...current.journal,
        revision,
        phase: "terminal",
        status: "safe-retry",
        owner: repairOwner,
        finishedAt: at,
        updatedAt: at,
        reasonCode: "owner-exited-before-begin",
      })
    : parseLinkedDeviceLifecycleJournal({
        ...current.journal,
        revision,
        phase: "terminal",
        status: "indeterminate",
        reconciliation: "required",
        owner: repairOwner,
        finishedAt: current.journal.finishedAt ?? at,
        updatedAt: at,
        reasonCode: current.journal.status === "indeterminate"
          ? current.journal.reasonCode
          : "owner-exited-after-begin",
      });
  const written = writePrivateJsonIfUnchanged(
    journalPath(
      current.journal.journalId,
      options.environment ?? process.env,
    ),
    next,
    { expectedCurrentContentSha256: current.contentSha256 },
  );
  if (!written) {
    throw new Error(
      "linked-device lifecycle journal changed concurrently; reload before repair",
    );
  }
  return snapshot(next);
}
