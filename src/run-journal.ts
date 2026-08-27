import { createHash } from "node:crypto";
import { join } from "node:path";

import type { WrenchAuth } from "./auth";
import { canonicalJson } from "./canonical-json";
import type { OperationRisk } from "./model";
import {
  isProviderPluginOperationName,
  type ProviderPluginOperationName,
} from "./provider-plugin-identifiers";
import {
  parsePortableOperationIdentityV1,
  type PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import {
  parseLocalCliContractIdentityV1,
  type LocalCliContractIdentityV1,
} from "./local-cli-contracts";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  wrenchStateHome,
  readPrivateStateFilesBatched,
  readPrivateStateFileIfPresent,
  snapshotPrivateStateDirectory,
  writePrivateJsonIfUnchanged,
} from "./storage";
import {
  processOwnerStatus,
  type ProcessOwnerStatus,
} from "./process-identity";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

const RUN_JOURNAL_DIRECTORY = "run-journals";
const MAX_RUN_JOURNAL_BYTES = 64 * 1024;
const MAX_JOURNAL_ERROR_BYTES = 16 * 1024;
const MAX_JOURNAL_ORIGIN_BYTES = 8 * 1024;

export type RunJournalContract =
  | {
      readonly transport: "provider-api";
      readonly hash: string;
    }
  | {
      readonly transport: "web-session-api";
      readonly hash: string;
    }
  | {
      readonly transport: "reviewed-template-api";
      readonly hash: string;
    }
  | {
      readonly transport: "portable-provider-plugin";
      readonly identity: PortableOperationIdentityV1;
    }
  | {
      readonly transport: "local-cli";
      readonly identity: LocalCliContractIdentityV1;
    };

export type RunJournalDispatch = {
  readonly planned: number;
  readonly started: number;
  readonly verified: number;
};

export type DuplicateIntentV1 = {
  readonly schemaVersion: 1;
  readonly intentHash: string;
  readonly sourceRunId: string;
};

export type DuplicateSuccessorV1 = DuplicateIntentV1 & {
  readonly runId: string;
  readonly claimedAt: string;
};

export type RunJournal = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly runId: string;
  readonly planDigest: string;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly operation: ProviderPluginOperationName;
  readonly risk: Extract<OperationRisk, "R2" | "R3">;
  readonly inputHash: string;
  readonly auth: {
    readonly id: string;
    readonly hash: string;
    readonly kind: WrenchAuth["kind"];
  };
  readonly contract: RunJournalContract;
  readonly duplicateIntent?: DuplicateIntentV1;
  readonly duplicateSuccessor?: DuplicateSuccessorV1;
  readonly planHasAssets: boolean;
  /** Whether the encrypted confirmation plan is still independently usable. */
  readonly planState: "available" | "consumed";
  readonly phase: "prepared" | "claimed" | "ready" | "dispatching" | "terminal";
  readonly status: "pending" | "succeeded" | "submitted" | "failed" | "partial" | "indeterminate";
  readonly dispatch: RunJournalDispatch;
  readonly ledgerRelativePath: string | null;
  readonly ledgerState: "unclaimed" | "pending" | "succeeded" | "partial" | "indeterminate" | "released";
  readonly recoveryState: "absent" | "present" | "retained" | "released";
  readonly assetState: "none" | "bound" | "retained" | "released";
  readonly owner: {
    readonly pid: number;
    readonly token: string;
    readonly bootId: string;
    readonly processStartId: string;
    readonly leaseUntil: string;
  };
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly dedupeExpiresAt: string;
  readonly finalOrigin: string | null;
  readonly error: string | null;
};

export type RunJournalSnapshot = {
  readonly journal: RunJournal;
  readonly contentSha256: string;
};

export type StartRunJournal = {
  readonly runId: string;
  readonly planDigest: string;
  readonly adapter: RunJournal["adapter"];
  readonly operation: ProviderPluginOperationName;
  readonly risk: Extract<OperationRisk, "R2" | "R3">;
  readonly inputHash: string;
  readonly auth: RunJournal["auth"];
  readonly contract: RunJournalContract;
  readonly duplicateIntent?: DuplicateIntentV1;
  readonly plannedDispatches: number;
  readonly hasPlanAssets: boolean;
  readonly owner: RunJournal["owner"];
  readonly startedAt: string;
  readonly dedupeExpiresAt: string;
};

export type RunJournalEvent =
  | {
      readonly type: "confirmation-consumed";
      readonly at: string;
    }
  | {
      readonly type: "ledger-claimed";
      readonly ledgerRelativePath: string;
      readonly at: string;
    }
  | {
      readonly type: "recovery-stored";
      readonly at: string;
    }
  | {
      readonly type: "dispatch-started";
      readonly index: number;
      readonly at: string;
    }
  | {
      readonly type: "dispatch-verified";
      readonly index: number;
      readonly at: string;
    }
  | {
      readonly type: "finished";
      readonly status: "succeeded" | "submitted" | "failed" | "partial" | "indeterminate";
      readonly finalOrigin: string | null;
      readonly error: string | null;
      readonly noOp?: true;
      readonly at: string;
    }
  | {
      /** A successful read-only reconciliation authorized local cleanup. */
      readonly type: "recovery-released";
      /**
       * Explicit not-applied evidence also releases the idempotency ledger,
       * authorizing a fresh confirmed attempt. Omitted means the provider
       * effect was observed/applied and the at-most-once fence remains.
       */
      readonly outcome?: "applied" | "not-applied";
      readonly at: string;
    }
  | {
      readonly type: "lease-renewed";
      readonly leaseUntil: string;
      readonly at: string;
    }
  | {
      /** Permanently elect the sole duplicate-tolerant successor intent. */
      readonly type: "duplicate-successor-claimed";
      readonly intentHash: string;
      readonly runId: string;
      readonly at: string;
    };

function dataRecord(value: unknown, label: string): JsonRecord {
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
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length > 64
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function runId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) throw new Error(`${label} is malformed`);
  return value;
}

function parseDuplicateIntent(
  value: unknown,
  label: string,
): DuplicateIntentV1 {
  const record = dataRecord(value, label);
  exactKeys(record, ["schemaVersion", "intentHash", "sourceRunId"], label);
  if (record.schemaVersion !== 1) throw new Error(`${label} is malformed`);
  return Object.freeze({
    schemaVersion: 1,
    intentHash: digest(record.intentHash, `${label} intent hash`),
    sourceRunId: runId(record.sourceRunId, `${label} source run ID`),
  });
}

function parseDuplicateSuccessor(
  value: unknown,
): DuplicateSuccessorV1 {
  const label = "run journal duplicate successor";
  const record = dataRecord(value, label);
  exactKeys(
    record,
    ["schemaVersion", "intentHash", "sourceRunId", "runId", "claimedAt"],
    label,
  );
  if (record.schemaVersion !== 1) throw new Error(`${label} is malformed`);
  return Object.freeze({
    schemaVersion: 1,
    intentHash: digest(record.intentHash, `${label} intent hash`),
    sourceRunId: runId(record.sourceRunId, `${label} source run ID`),
    runId: runId(record.runId, `${label} run ID`),
    claimedAt: timestamp(record.claimedAt, `${label} claim time`),
  });
}

function boundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  const hasUnsafeControl = typeof value === "string"
    && [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined
        && (
          codePoint <= 0x08
          || codePoint === 0x0b
          || codePoint === 0x0c
          || (codePoint >= 0x0e && codePoint <= 0x1f)
          || codePoint === 0x7f
        );
    });
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || hasUnsafeControl
  ) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function nullableBoundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
): string | null {
  return value === null ? null : boundedString(value, label, maximumBytes);
}

function parseAdapter(value: unknown): RunJournal["adapter"] {
  const record = dataRecord(value, "run journal adapter");
  exactKeys(record, ["id", "version", "hash"], "run journal adapter");
  const id = boundedString(record.id, "run journal adapter ID", 128);
  const version = boundedString(record.version, "run journal adapter version", 128);
  if (!/^[a-z][a-z0-9-]{0,127}$/u.test(id)) {
    throw new Error("run journal adapter ID is malformed");
  }
  return { id, version, hash: digest(record.hash, "run journal adapter hash") };
}

const authKinds = new Set<WrenchAuth["kind"]>([
  "browser-profile",
  "cookie-source",
  "cookies-file",
  "linked-device-store",
  "oauth-token-file",
]);

function parseAuth(value: unknown): RunJournal["auth"] {
  const record = dataRecord(value, "run journal auth");
  exactKeys(record, ["id", "hash", "kind"], "run journal auth");
  const id = boundedString(record.id, "run journal auth ID", 48);
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(id) || !authKinds.has(record.kind as WrenchAuth["kind"])) {
    throw new Error("run journal auth is malformed");
  }
  return {
    id,
    hash: digest(record.hash, "run journal auth hash"),
    kind: record.kind as WrenchAuth["kind"],
  };
}

function parseContract(value: unknown): RunJournalContract {
  const record = dataRecord(value, "run journal contract");
  if (record.transport === "portable-provider-plugin") {
    exactKeys(
      record,
      ["transport", "identity"],
      "run journal contract",
    );
    return Object.freeze({
      transport: "portable-provider-plugin",
      identity: parsePortableOperationIdentityV1(record.identity),
    });
  }
  if (record.transport === "local-cli") {
    exactKeys(record, ["transport", "identity"], "run journal contract");
    return Object.freeze({
      transport: "local-cli",
      identity: parseLocalCliContractIdentityV1(record.identity),
    });
  }
  exactKeys(record, ["transport", "hash"], "run journal contract");
  if (
    record.transport !== "provider-api"
    && record.transport !== "web-session-api"
    && record.transport !== "reviewed-template-api"
  ) {
    throw new Error("run journal contract transport is malformed");
  }
  return Object.freeze({
    transport: record.transport,
    hash: digest(record.hash, "run journal contract hash"),
  });
}

function parseDispatch(value: unknown): RunJournalDispatch {
  const record = dataRecord(value, "run journal dispatch");
  exactKeys(record, ["planned", "started", "verified"], "run journal dispatch");
  if (
    !Number.isSafeInteger(record.planned)
    || typeof record.planned !== "number"
    || record.planned < 1
    || record.planned > 25
    || !Number.isSafeInteger(record.started)
    || typeof record.started !== "number"
    || record.started < 0
    || record.started > record.planned
    || !Number.isSafeInteger(record.verified)
    || typeof record.verified !== "number"
    || record.verified < 0
    || record.verified > record.started
  ) {
    throw new Error("run journal dispatch is malformed");
  }
  return {
    planned: record.planned,
    started: record.started,
    verified: record.verified,
  };
}

function parseOwner(value: unknown): RunJournal["owner"] {
  const record = dataRecord(value, "run journal owner");
  exactKeys(
    record,
    ["pid", "token", "bootId", "processStartId", "leaseUntil"],
    "run journal owner",
  );
  if (
    !Number.isSafeInteger(record.pid)
    || typeof record.pid !== "number"
    || record.pid < 1
    || record.pid > 2_147_483_647
    || typeof record.token !== "string"
    || !/^[0-9a-f-]{36}$/u.test(record.token)
    || typeof record.bootId !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.bootId)
    || typeof record.processStartId !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.processStartId)
  ) {
    throw new Error("run journal owner is malformed");
  }
  return {
    pid: record.pid,
    token: record.token,
    bootId: record.bootId,
    processStartId: record.processStartId,
    leaseUntil: timestamp(record.leaseUntil, "run journal owner lease"),
  };
}

function ledgerRelativePath(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !/^idempotency\/[a-f0-9]{2}\/[a-f0-9]{64}(?:\.[a-f0-9]{64})?\.json$/u.test(value)
  ) {
    throw new Error("run journal ledger path is malformed");
  }
  return value;
}

function assertJournalInvariants(value: RunJournal): void {
  const { dispatch } = value;
  if (
    value.duplicateIntent !== undefined
    && (
      value.duplicateIntent.sourceRunId === value.runId
      || value.operation !== "posts.publish"
      || value.risk !== "R3"
      || value.contract.transport !== "web-session-api"
      || dispatch.planned !== 1
    )
  ) {
    throw new Error("duplicate intent has contradictory successor state");
  }
  if (
    value.duplicateSuccessor !== undefined
    && (
      value.duplicateSuccessor.sourceRunId !== value.runId
      || value.duplicateSuccessor.runId === value.runId
      || Date.parse(value.duplicateSuccessor.claimedAt) < Date.parse(value.updatedAt)
      || value.operation !== "posts.publish"
      || value.risk !== "R3"
      || value.contract.transport !== "web-session-api"
      || value.phase !== "terminal"
      || value.status !== "indeterminate"
      || dispatch.planned !== 1
      || dispatch.started !== 1
      || value.ledgerState !== "indeterminate"
      || value.recoveryState !== "retained"
    )
  ) {
    throw new Error("duplicate successor claim has contradictory source state");
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.startedAt)) {
    throw new Error("run journal update precedes its start");
  }
  if (Date.parse(value.dedupeExpiresAt) < Date.parse(value.startedAt)) {
    throw new Error("run journal dedupe expiry precedes its start");
  }
  if (Date.parse(value.owner.leaseUntil) < Date.parse(value.startedAt)) {
    throw new Error("run journal owner lease precedes its start");
  }
  if (!value.planHasAssets && value.assetState !== "none") {
    throw new Error("asset-free run journal has contradictory asset state");
  }
  if (
    value.planHasAssets
    && value.planState === "available"
    && value.assetState !== "none"
  ) {
    throw new Error("available confirmation cannot own plan assets");
  }
  if (
    value.planHasAssets
    && value.planState === "consumed"
    && value.phase !== "terminal"
    && value.assetState !== "bound"
  ) {
    throw new Error("consumed confirmation lost its bound plan assets");
  }

  if (value.phase === "prepared") {
    if (
      value.status !== "pending"
      || value.ledgerRelativePath !== null
      || value.ledgerState !== "unclaimed"
      || value.recoveryState !== "absent"
      || (
        value.planState === "available"
        && value.assetState !== "none"
      )
      || (
        value.planState === "consumed"
        && value.assetState !== "none"
        && value.assetState !== "bound"
      )
      || dispatch.started !== 0
      || dispatch.verified !== 0
    ) throw new Error("prepared run journal has contradictory state");
    return;
  }
  if (value.phase === "claimed") {
    if (
      value.status !== "pending"
      || value.planState !== "consumed"
      || value.ledgerRelativePath === null
      || value.ledgerState !== "pending"
      || value.recoveryState !== "absent"
      || dispatch.started !== 0
      || dispatch.verified !== 0
    ) throw new Error("claimed run journal has contradictory state");
    return;
  }
  if (value.phase === "ready") {
    if (
      value.status !== "pending"
      || value.planState !== "consumed"
      || value.ledgerRelativePath === null
      || value.ledgerState !== "pending"
      || value.recoveryState !== "present"
      || dispatch.started !== 0
      || dispatch.verified !== 0
    ) throw new Error("ready run journal has contradictory state");
    return;
  }
  if (value.phase === "dispatching") {
    if (
      value.status !== "pending"
      || value.planState !== "consumed"
      || value.ledgerRelativePath === null
      || value.ledgerState !== "pending"
      || value.recoveryState !== "present"
      || dispatch.started < 1
    ) throw new Error("dispatching run journal has contradictory state");
    return;
  }

  if (value.status === "pending") {
    throw new Error("terminal run journal cannot remain pending");
  }
  if (value.status === "failed") {
    if (
      dispatch.started !== 0
      || dispatch.verified !== 0
      || value.ledgerState !== "released"
      || value.recoveryState !== "released"
      || (
        value.planState === "available"
          ? value.assetState !== "none"
          : value.planHasAssets
            ? value.assetState !== "released"
            : value.assetState !== "none"
      )
    ) throw new Error("failed run journal has contradictory state");
    return;
  }
  if (value.status === "succeeded" || value.status === "submitted") {
    const verifiedAll = dispatch.started === dispatch.planned
      && dispatch.verified === dispatch.planned;
    const verifiedNoOp = value.status === "succeeded"
      && dispatch.started === 0
      && dispatch.verified === 0;
    if (
      (!verifiedAll && !verifiedNoOp)
      || value.planState !== "consumed"
      || value.ledgerState !== "succeeded"
      || value.recoveryState !== "released"
      || (
        value.planHasAssets
          ? value.assetState !== "released"
          : value.assetState !== "none"
      )
    ) throw new Error("successful run journal has contradictory state");
    return;
  }
  if (value.status === "partial") {
    if (
      dispatch.verified < 1
      || value.planState !== "consumed"
      || dispatch.started !== dispatch.verified
      || dispatch.verified >= dispatch.planned
      || (
        value.ledgerState !== "partial"
        && !(
          value.ledgerState === "released"
          && value.recoveryState === "released"
        )
      )
      || (
        value.recoveryState !== "retained"
        && value.recoveryState !== "released"
      )
      || (
        value.recoveryState === "retained"
          ? value.planHasAssets
            ? value.assetState !== "retained"
            : value.assetState !== "none"
          : value.planHasAssets
            ? value.assetState !== "released"
            : value.assetState !== "none"
      )
    ) throw new Error("partial run journal has contradictory state");
    return;
  }
  if (
    dispatch.started < 1
    || value.planState !== "consumed"
    || (
      value.ledgerState !== "indeterminate"
      && !(
        value.ledgerState === "released"
        && value.recoveryState === "released"
      )
    )
    || (
      value.recoveryState !== "retained"
      && value.recoveryState !== "released"
    )
    || (
      value.recoveryState === "retained"
        ? value.planHasAssets
          ? value.assetState !== "retained"
          : value.assetState !== "none"
        : value.planHasAssets
          ? value.assetState !== "released"
          : value.assetState !== "none"
    )
  ) throw new Error("indeterminate run journal has contradictory state");
}

export function parseRunJournal(value: unknown): RunJournal {
  const record = dataRecord(value, "run journal");
  const keys = [
    "schemaVersion",
    "revision",
    "runId",
    "planDigest",
    "adapter",
    "operation",
    "risk",
    "inputHash",
    "auth",
    "contract",
    "planHasAssets",
    "planState",
    "phase",
    "status",
    "dispatch",
    "ledgerRelativePath",
    "ledgerState",
    "recoveryState",
    "assetState",
    "owner",
    "startedAt",
    "updatedAt",
    "dedupeExpiresAt",
    "finalOrigin",
    "error",
  ];
  if (Object.hasOwn(record, "duplicateIntent")) keys.push("duplicateIntent");
  if (Object.hasOwn(record, "duplicateSuccessor")) keys.push("duplicateSuccessor");
  exactKeys(record, keys, "run journal");
  if (
    record.schemaVersion !== 1
    || !Number.isSafeInteger(record.revision)
    || typeof record.revision !== "number"
    || record.revision < 0
    || typeof record.runId !== "string"
    || !/^[0-9a-f-]{36}$/u.test(record.runId)
    || !isProviderPluginOperationName(record.operation)
    || (record.risk !== "R2" && record.risk !== "R3")
    || (
      record.phase !== "prepared"
      && record.phase !== "claimed"
      && record.phase !== "ready"
      && record.phase !== "dispatching"
      && record.phase !== "terminal"
    )
    || (
      record.status !== "pending"
      && record.status !== "succeeded"
      && record.status !== "submitted"
      && record.status !== "failed"
      && record.status !== "partial"
      && record.status !== "indeterminate"
    )
    || (record.planState !== "available" && record.planState !== "consumed")
    || typeof record.planHasAssets !== "boolean"
    || (
      record.ledgerState !== "unclaimed"
      && record.ledgerState !== "pending"
      && record.ledgerState !== "succeeded"
      && record.ledgerState !== "partial"
      && record.ledgerState !== "indeterminate"
      && record.ledgerState !== "released"
    )
    || (
      record.recoveryState !== "absent"
      && record.recoveryState !== "present"
      && record.recoveryState !== "retained"
      && record.recoveryState !== "released"
    )
    || (
      record.assetState !== "none"
      && record.assetState !== "bound"
      && record.assetState !== "retained"
      && record.assetState !== "released"
    )
  ) {
    throw new Error("run journal is malformed");
  }
  const journal: RunJournal = {
    schemaVersion: 1,
    revision: record.revision,
    runId: record.runId,
    planDigest: digest(record.planDigest, "run journal plan digest"),
    adapter: parseAdapter(record.adapter),
    operation: record.operation,
    risk: record.risk,
    inputHash: digest(record.inputHash, "run journal input hash"),
    auth: parseAuth(record.auth),
    contract: parseContract(record.contract),
    ...(Object.hasOwn(record, "duplicateIntent")
      ? {
          duplicateIntent: parseDuplicateIntent(
            record.duplicateIntent,
            "run journal duplicate intent",
          ),
        }
      : {}),
    ...(Object.hasOwn(record, "duplicateSuccessor")
      ? { duplicateSuccessor: parseDuplicateSuccessor(record.duplicateSuccessor) }
      : {}),
    planHasAssets: record.planHasAssets,
    planState: record.planState,
    phase: record.phase,
    status: record.status,
    dispatch: parseDispatch(record.dispatch),
    ledgerRelativePath: ledgerRelativePath(record.ledgerRelativePath),
    ledgerState: record.ledgerState,
    recoveryState: record.recoveryState,
    assetState: record.assetState,
    owner: parseOwner(record.owner),
    startedAt: timestamp(record.startedAt, "run journal start"),
    updatedAt: timestamp(record.updatedAt, "run journal update"),
    dedupeExpiresAt: timestamp(record.dedupeExpiresAt, "run journal dedupe expiry"),
    finalOrigin: nullableBoundedString(
      record.finalOrigin,
      "run journal final origin",
      MAX_JOURNAL_ORIGIN_BYTES,
    ),
    error: nullableBoundedString(
      record.error,
      "run journal error",
      MAX_JOURNAL_ERROR_BYTES,
    ),
  };
  if (
    journal.finalOrigin !== null
    && new URL(journal.finalOrigin).origin !== journal.finalOrigin
  ) {
    throw new Error("run journal final origin is malformed");
  }
  assertJournalInvariants(journal);
  if (Buffer.byteLength(canonicalJson(journal), "utf8") > MAX_RUN_JOURNAL_BYTES) {
    throw new Error("run journal exceeds its byte bound");
  }
  const frozenContract: RunJournalContract = journal.contract.transport
      === "portable-provider-plugin"
    ? Object.freeze({
        transport: "portable-provider-plugin",
        identity: journal.contract.identity,
      })
    : journal.contract.transport === "local-cli"
      ? Object.freeze({
          transport: "local-cli",
          identity: journal.contract.identity,
        })
      : Object.freeze({ ...journal.contract });
  return Object.freeze({
    ...journal,
    adapter: Object.freeze({ ...journal.adapter }),
    auth: Object.freeze({ ...journal.auth }),
    contract: frozenContract,
    ...(journal.duplicateIntent === undefined
      ? {}
      : { duplicateIntent: Object.freeze({ ...journal.duplicateIntent }) }),
    ...(journal.duplicateSuccessor === undefined
      ? {}
      : { duplicateSuccessor: Object.freeze({ ...journal.duplicateSuccessor }) }),
    dispatch: Object.freeze({ ...journal.dispatch }),
    owner: Object.freeze({ ...journal.owner }),
  });
}

export function initialRunJournal(value: StartRunJournal): RunJournal {
  return parseRunJournal({
    schemaVersion: 1,
    revision: 0,
    runId: value.runId,
    planDigest: value.planDigest,
    adapter: value.adapter,
    operation: value.operation,
    risk: value.risk,
    inputHash: value.inputHash,
    auth: value.auth,
    contract: value.contract,
    ...(value.duplicateIntent === undefined
      ? {}
      : { duplicateIntent: value.duplicateIntent }),
    planHasAssets: value.hasPlanAssets,
    planState: "available",
    phase: "prepared",
    status: "pending",
    dispatch: {
      planned: value.plannedDispatches,
      started: 0,
      verified: 0,
    },
    ledgerRelativePath: null,
    ledgerState: "unclaimed",
    recoveryState: "absent",
    assetState: "none",
    owner: value.owner,
    startedAt: value.startedAt,
    updatedAt: value.startedAt,
    dedupeExpiresAt: value.dedupeExpiresAt,
    finalOrigin: null,
    error: "execution was prepared but no durable final outcome was recorded",
  });
}

function terminalTransition(
  current: RunJournal,
  event: Extract<RunJournalEvent, { readonly type: "finished" }>,
): RunJournal {
  if (current.phase === "terminal") {
    throw new Error("run journal already has a terminal outcome");
  }
  const noOp = event.noOp === true;
  const { dispatch } = current;
  if (
    event.status === "failed"
    && dispatch.started !== 0
  ) {
    throw new Error("a run with started dispatches cannot finish as failed");
  }
  if (
    (event.status === "succeeded" || event.status === "submitted")
    && !(
      (event.status === "succeeded" && noOp && dispatch.started === 0 && dispatch.verified === 0)
      || (
        !noOp
        && dispatch.started === dispatch.planned
        && dispatch.verified === dispatch.planned
      )
    )
  ) {
    throw new Error("a successful run must verify its complete dispatch schedule or be an explicit no-op");
  }
  if (
    event.status === "partial"
    && !(
      dispatch.verified > 0
      && dispatch.started === dispatch.verified
      && dispatch.verified < dispatch.planned
    )
  ) {
    throw new Error("a partial run must stop after one or more verified dispatches");
  }
  if (event.status === "indeterminate" && dispatch.started < 1) {
    throw new Error("an indeterminate run must have crossed a dispatch boundary");
  }
  const retainsRecovery = event.status === "partial" || event.status === "indeterminate";
  const ledgerState: RunJournal["ledgerState"] = event.status === "succeeded"
      || event.status === "submitted"
    ? "succeeded"
    : event.status === "partial"
      ? "partial"
      : event.status === "indeterminate" ? "indeterminate" : "released";
  return parseRunJournal({
    ...current,
    revision: current.revision + 1,
    phase: "terminal",
    status: event.status,
    ledgerState,
    recoveryState: retainsRecovery ? "retained" : "released",
    assetState: current.assetState === "none"
      ? "none"
      : retainsRecovery ? "retained" : "released",
    updatedAt: event.at,
    finalOrigin: event.finalOrigin,
    error: event.error,
  });
}

export function transitionRunJournal(
  currentValue: RunJournal,
  event: RunJournalEvent,
): RunJournal {
  const current = parseRunJournal(currentValue);
  const at = timestamp(event.at, "run journal transition time");
  if (Date.parse(at) < Date.parse(current.updatedAt)) {
    throw new Error("run journal transition time moved backward");
  }
  if (event.type === "finished") return terminalTransition(current, event);
  if (event.type === "duplicate-successor-claimed") {
    const intentHash = digest(
      event.intentHash,
      "run journal duplicate successor intent hash",
    );
    const successorRunId = runId(
      event.runId,
      "run journal duplicate successor run ID",
    );
    const existing = current.duplicateSuccessor;
    if (existing !== undefined) {
      if (
        existing.intentHash === intentHash
        && existing.runId === successorRunId
      ) return current;
      throw new Error("run journal already elected a different duplicate successor");
    }
    if (
      current.operation !== "posts.publish"
      || current.risk !== "R3"
      || current.contract.transport !== "web-session-api"
      || current.phase !== "terminal"
      || current.status !== "indeterminate"
      || current.dispatch.planned !== 1
      || current.dispatch.started !== 1
      || current.ledgerState !== "indeterminate"
      || current.recoveryState !== "retained"
    ) {
      throw new Error(
        "only one retained terminal indeterminate posts.publish dispatch can elect a duplicate successor",
      );
    }
    return parseRunJournal({
      ...current,
      revision: current.revision + 1,
      duplicateSuccessor: {
        schemaVersion: 1,
        intentHash,
        sourceRunId: current.runId,
        runId: successorRunId,
        claimedAt: at,
      },
      // Claiming lineage must not rewrite the immutable receipt's finish time.
      updatedAt: current.updatedAt,
    });
  }
  if (event.type === "recovery-released") {
    if (current.duplicateSuccessor !== undefined) {
      throw new Error(
        "run recovery is retained because a duplicate successor intent was claimed",
      );
    }
    if (
      current.phase !== "terminal"
      || (current.status !== "partial" && current.status !== "indeterminate")
    ) {
      throw new Error(
        "only a reconciled partial or indeterminate run can release recovery resources",
      );
    }
    const releaseLedger = event.outcome === "not-applied";
    if (releaseLedger && current.dispatch.verified !== 0) {
      throw new Error(
        "a run with a verified dispatch cannot release its at-most-once ledger",
      );
    }
    if (current.recoveryState === "released") {
      if (
        releaseLedger === (current.ledgerState === "released")
      ) return current;
      throw new Error(
        "run recovery was already released with a different reconciliation outcome",
      );
    }
    return parseRunJournal({
      ...current,
      revision: current.revision + 1,
      ledgerState: releaseLedger ? "released" : current.ledgerState,
      recoveryState: "released",
      assetState: current.assetState === "retained" ? "released" : "none",
      // `updatedAt` is the terminal outcome time and is projected into the
      // immutable receipt's `finishedAt`. Recovery release is later
      // maintenance, not a new execution outcome. Advancing the revision
      // fences concurrent writers without rewriting the terminal receipt.
      updatedAt: current.updatedAt,
    });
  }
  if (current.phase === "terminal") {
    throw new Error("terminal run journals cannot transition");
  }
  if (event.type === "confirmation-consumed") {
    if (current.phase !== "prepared" || current.planState !== "available") {
      throw new Error("run journal confirmation can only be consumed once after preparation");
    }
    return parseRunJournal({
      ...current,
      revision: current.revision + 1,
      planState: "consumed",
      assetState: current.planHasAssets ? "bound" : "none",
      updatedAt: at,
    });
  }
  if (event.type === "ledger-claimed") {
    if (current.phase !== "prepared" || current.planState !== "consumed") {
      throw new Error("run journal ledger can only be claimed after preparation");
    }
    return parseRunJournal({
      ...current,
      revision: current.revision + 1,
      phase: "claimed",
      ledgerRelativePath: ledgerRelativePath(event.ledgerRelativePath),
      ledgerState: "pending",
      updatedAt: at,
    });
  }
  if (event.type === "recovery-stored") {
    if (current.phase !== "claimed") {
      throw new Error("run journal recovery can only be stored after ledger claim");
    }
    return parseRunJournal({
      ...current,
      revision: current.revision + 1,
      phase: "ready",
      recoveryState: "present",
      updatedAt: at,
    });
  }
  if (event.type === "dispatch-started") {
    if (
      (current.phase !== "ready" && current.phase !== "dispatching")
      || event.index !== current.dispatch.started + 1
      || current.dispatch.started !== current.dispatch.verified
      || event.index > current.dispatch.planned
    ) {
      throw new Error("run journal dispatch start is out of order");
    }
    return parseRunJournal({
      ...current,
      revision: current.revision + 1,
      phase: "dispatching",
      dispatch: {
        ...current.dispatch,
        started: event.index,
      },
      updatedAt: at,
      error: "a dispatch crossed its durable start boundary; a missing final outcome requires reconciliation",
    });
  }
  if (event.type === "dispatch-verified") {
    if (
      current.phase !== "dispatching"
      || event.index !== current.dispatch.verified + 1
      || event.index !== current.dispatch.started
    ) {
      throw new Error("run journal dispatch verification is out of order");
    }
    return parseRunJournal({
      ...current,
      revision: current.revision + 1,
      dispatch: {
        ...current.dispatch,
        verified: event.index,
      },
      updatedAt: at,
      error: "verified dispatch progress was stored; execution has not reached a durable final outcome",
    });
  }
  const leaseUntil = timestamp(event.leaseUntil, "run journal renewed lease");
  if (Date.parse(leaseUntil) < Date.parse(at)) {
    throw new Error("run journal renewed lease precedes its transition");
  }
  return parseRunJournal({
    ...current,
    revision: current.revision + 1,
    owner: {
      ...current.owner,
      leaseUntil,
    },
    updatedAt: at,
  });
}

function journalDirectory(environment: Environment): string {
  return join(wrenchStateHome(environment), RUN_JOURNAL_DIRECTORY);
}

function journalPath(runId: string, environment: Environment): string {
  if (!/^[0-9a-f-]{36}$/u.test(runId)) throw new Error("run journal ID is invalid");
  return join(journalDirectory(environment), `${runId}.json`);
}

function snapshot(journal: RunJournal): RunJournalSnapshot {
  const content = `${canonicalJson(journal)}\n`;
  return Object.freeze({
    journal,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  });
}

export function createRunJournal(
  journalValue: RunJournal,
  environment: Environment = process.env,
): RunJournalSnapshot {
  const journal = parseRunJournal(journalValue);
  ensurePrivateStateDirectory(journalDirectory(environment), environment);
  const created = createPrivateJsonIfAbsent(
    journalPath(journal.runId, environment),
    journal,
    { environment, privateParent: true },
  );
  if (!created.created) throw new Error("run journal ID already exists");
  return snapshot(journal);
}

export function readRunJournal(
  runId: string,
  environment: Environment = process.env,
): RunJournalSnapshot | null {
  ensurePrivateStateDirectory(journalDirectory(environment), environment);
  const text = readPrivateStateFileIfPresent(
    journalPath(runId, environment),
    MAX_RUN_JOURNAL_BYTES,
    "run journal",
    environment,
  );
  if (text === null) return null;
  return parseRunJournalSnapshotText(text);
}

function parseRunJournalSnapshotText(text: string): RunJournalSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("run journal is malformed");
  }
  return Object.freeze({
    journal: parseRunJournal(value),
    contentSha256: createHash("sha256").update(text).digest("hex"),
  });
}

export function updateRunJournal(
  current: RunJournalSnapshot,
  event: RunJournalEvent,
  environment: Environment = process.env,
): RunJournalSnapshot {
  const next = transitionRunJournal(current.journal, event);
  const written = writePrivateJsonIfUnchanged(
    journalPath(current.journal.runId, environment),
    next,
    { expectedCurrentContentSha256: current.contentSha256 },
  );
  if (!written) {
    throw new Error("run journal changed concurrently; reload it before continuing");
  }
  return snapshot(next);
}

export function listRunJournalSnapshots(
  environment: Environment = process.env,
): readonly (RunJournalSnapshot | { readonly runId: string; readonly invalid: true })[] {
  const directory = journalDirectory(environment);
  const identity = ensurePrivateStateDirectory(directory, environment);
  const directorySnapshot = snapshotPrivateStateDirectory(
    directory,
    environment,
    identity,
  );
  if (directorySnapshot.identity === null) return Object.freeze([]);
  const names = directorySnapshot.entries
    .filter((entry) => (
      entry.kind === "file"
      && /^[0-9a-f-]{36}\.json$/u.test(entry.name)
    ))
    .map((entry) => entry.name);
  return Object.freeze(
    readPrivateStateFilesBatched(directory, names, {
      maximumBytesPerFile: MAX_RUN_JOURNAL_BYTES,
      environment,
      expectedDirectoryIdentity: directorySnapshot.identity,
    }).map((file) => {
      const runId = file.name.slice(0, -5);
      if (file.status !== "present") {
        return { runId, invalid: true as const };
      }
      try {
        const value = parseRunJournalSnapshotText(file.content);
        return value.journal.runId === runId
          ? value
          : { runId, invalid: true as const };
      } catch {
        return { runId, invalid: true as const };
      }
    }),
  );
}

export function runJournalNeedsRepair(
  journalValue: RunJournal,
  now = new Date(),
  inspectOwner: (owner: RunJournal["owner"]) => ProcessOwnerStatus
    = processOwnerStatus,
): boolean {
  const journal = parseRunJournal(journalValue);
  if (journal.phase === "terminal") return false;
  void now;
  // A wall-clock lease is diagnostic only. A suspended but exact-live owner
  // may resume with in-memory state, so another process must never mutate its
  // journal or release its claims solely because time elapsed.
  return inspectOwner(journal.owner) === "different-or-dead";
}
