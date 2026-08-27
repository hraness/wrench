import { join } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  MESSAGING_RECEIPT_BINDING_CONTRACT_HASH,
  MESSAGING_RECEIPT_BINDING_CONTRACT_ID,
  parseMessagingReceiptBindingV1,
  type MessagingPartJournalStateV1,
  type MessagingPrivateProviderOutcomeV1,
  type MessagingReceiptBindingV1,
  type MessagingRunReceiptV1,
  type MessagingRunV1,
} from "./messaging-types";
import type { ProviderPluginMessagingExpectedOwnPrefixV1 } from "./provider-plugin";
import type { MessagingCompositeInvocationPlanV1 } from "./runtime";
import {
  openAuthenticatedPrivatePayload,
  sealAuthenticatedPrivatePayload,
} from "./read-projections";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  readPrivateStateFileIfPresent,
  wrenchStateHome,
  writePrivateJsonIfUnchanged,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;

const MAX_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_ENCRYPTED_BYTES = 2 * 1024 * 1024;

export type MessagingRunSnapshotV1 = {
  readonly run: MessagingRunV1;
  readonly contentSha256: string;
};

export type MessagingRunEventV1 =
  | {
      readonly type: "claimed";
      readonly index: number;
      readonly observedAcceptedPrefixCount: number;
      readonly at: string;
    }
  | { readonly type: "dispatching"; readonly index: number; readonly at: string }
  | {
      readonly type: "accepted";
      readonly index: number;
      readonly providerMessageId: string;
      readonly providerRevision: string | null;
      readonly at: string;
    }
  | {
      readonly type: "categorical-stop";
      readonly index: number;
      readonly partState: "failed-before-dispatch" | "failed-permanent";
      readonly reason:
        | "context-drift"
        | "prefix-freshness-unproven"
        | "provider-failed-before-dispatch"
        | "journal-recovery-required";
      readonly at: string;
    }
  | {
      readonly type: "indeterminate";
      readonly index: number;
      readonly reason: "provider-result-indeterminate";
      readonly privateProviderOutcome: MessagingPrivateProviderOutcomeV1 | null;
      readonly at: string;
    }
  | {
      readonly type: "indeterminate";
      readonly index: number;
      readonly reason: "journal-recovery-required";
      readonly at: string;
    };

function root(environment: Environment): string {
  return join(wrenchStateHome(environment), "messaging", "runs");
}

function path(runId: string, environment: Environment): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) {
    throw new Error("messaging run ID is malformed");
  }
  return join(root(environment), `${runId}.json`);
}

function domain(runId: string): string {
  return `wrench-messaging-run-v1:${runId}`;
}

function timestamp(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error("messaging run timestamp is malformed");
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximum
    || value.includes("\0")
  ) throw new Error(`${label} is malformed`);
  return value;
}

function parsePrivateProviderOutcome(
  value: unknown,
): MessagingPrivateProviderOutcomeV1 {
  const source = record(value, "messaging private provider outcome");
  exactKeys(source, [
    "schemaVersion", "messagingContractId", "code",
  ], "messaging private provider outcome");
  const messagingContractId = boundedText(
    source.messagingContractId,
    "messaging private provider outcome contract ID",
    256,
  );
  const code = boundedText(
    source.code,
    "messaging private provider outcome code",
    64,
  );
  if (
    source.schemaVersion !== 1
    || !/^[a-z][a-z0-9.-]{0,255}$/u.test(messagingContractId)
    || !/^[a-z][a-z0-9_-]{0,63}$/u.test(code)
  ) throw new Error("messaging private provider outcome is malformed");
  return Object.freeze({ schemaVersion: 1, messagingContractId, code });
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1
    || value.length > maximum
  ) throw new Error(`${label} is malformed`);
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${label} must be a dense array without extra fields`);
  }
  return value;
}

function assertRun(run: MessagingRunV1): void {
  const acceptedProviderMessageIds = run.parts
    .slice(0, run.provenPartCount)
    .map((part) => part.providerMessageId);
  if (
    run.schemaVersion !== 1
    || run.format !== "wrench.messaging-run"
    || run.parts.length < 1
    || run.parts.length > 8
    || run.partCount !== run.parts.length
    || run.provenPartCount < 0
    || run.provenPartCount > run.partCount
    || !Number.isSafeInteger(run.observedAcceptedPrefixCount)
    || run.observedAcceptedPrefixCount < 0
    || run.observedAcceptedPrefixCount > run.provenPartCount
    || run.parts.slice(0, run.provenPartCount).some((part) => part.state !== "accepted")
    || acceptedProviderMessageIds.some((providerMessageId) => providerMessageId === null)
    || new Set(acceptedProviderMessageIds).size !== acceptedProviderMessageIds.length
    || run.parts.slice(run.provenPartCount).some((part, offset) =>
      offset > 0 && part.state !== "unattempted")
  ) throw new Error("messaging run violates its ordered-prefix invariant");
  const active = run.parts[run.provenPartCount];
  if (
    run.privateProviderOutcome !== null
    && (
      run.state !== "indeterminate"
      || run.terminalReason !== "provider-result-indeterminate"
      || run.possibleSubmittedPartIndex !== run.provenPartCount
      || active?.state !== "indeterminate"
    )
  ) throw new Error("messaging run private provider outcome is contradictory");
  if (run.state === "pending") {
    if (
      run.provenPartCount === run.partCount
      || run.possibleSubmittedPartIndex !== null
      || run.terminalReason !== null
      || active === undefined
      || !["unattempted", "claimed", "dispatching"].includes(active.state)
    ) throw new Error("pending messaging run has contradictory state");
    return;
  }
  if (run.state === "submitted") {
    if (
      run.provenPartCount !== run.partCount
      || run.possibleSubmittedPartIndex !== null
      || run.terminalReason !== null
    ) throw new Error("submitted messaging run has contradictory state");
    return;
  }
  if (run.state === "failed") {
    if (
      run.provenPartCount !== 0
      || run.possibleSubmittedPartIndex !== null
      || run.terminalReason !== "context-drift"
        && run.terminalReason !== "prefix-freshness-unproven"
        && run.terminalReason !== "provider-failed-before-dispatch"
        && run.terminalReason !== "journal-recovery-required"
      || active === undefined
      || active.state !== "failed-before-dispatch" && active.state !== "failed-permanent"
    ) throw new Error("failed messaging run has contradictory state");
    return;
  }
  if (run.state === "partial") {
    if (
      run.provenPartCount < 1
      || run.provenPartCount >= run.partCount
      || run.possibleSubmittedPartIndex !== null
      || run.terminalReason !== "context-drift"
        && run.terminalReason !== "prefix-freshness-unproven"
        && run.terminalReason !== "provider-failed-before-dispatch"
        && run.terminalReason !== "journal-recovery-required"
      || active === undefined
      || active.state !== "failed-before-dispatch" && active.state !== "failed-permanent"
    ) throw new Error("partial messaging run has contradictory state");
    return;
  }
  if (
    run.state !== "indeterminate"
    || run.provenPartCount >= run.partCount
    || run.possibleSubmittedPartIndex !== run.provenPartCount
    || run.terminalReason !== "provider-result-indeterminate"
      && run.terminalReason !== "journal-recovery-required"
    || active?.state !== "indeterminate"
  ) throw new Error("indeterminate messaging run has contradictory state");
}

function parseRun(value: unknown): MessagingRunV1 {
  const source = record(value, "messaging run");
  const hasPrivateProviderOutcome = Object.hasOwn(
    source,
    "privateProviderOutcome",
  );
  exactKeys(source, [
    "schemaVersion", "format", "runId", "planDigest", "routeRef", "contextRef",
    "clientIntentSha256", "turnDigest", "previewDigest", "state", "partCount",
    "provenPartCount", "observedAcceptedPrefixCount", "possibleSubmittedPartIndex",
    "terminalReason", "parts",
    ...(hasPrivateProviderOutcome ? ["privateProviderOutcome"] : []),
    "startedAt", "recordedAt",
  ], "messaging run");
  if (
    source.schemaVersion !== 1
    || source.format !== "wrench.messaging-run"
    || typeof source.runId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(source.runId)
    || typeof source.routeRef !== "string"
    || !/^wmroute_[A-Za-z0-9_-]{22}$/u.test(source.routeRef)
    || typeof source.contextRef !== "string"
    || !/^wmcontext_[A-Za-z0-9_-]{22}$/u.test(source.contextRef)
    || source.state !== "pending"
      && source.state !== "submitted"
      && source.state !== "failed"
      && source.state !== "partial"
      && source.state !== "indeterminate"
    || typeof source.partCount !== "number"
    || !Number.isSafeInteger(source.partCount)
    || source.partCount < 1
    || source.partCount > 8
    || typeof source.provenPartCount !== "number"
    || !Number.isSafeInteger(source.provenPartCount)
    || source.provenPartCount < 0
    || source.provenPartCount > source.partCount
    || typeof source.observedAcceptedPrefixCount !== "number"
    || !Number.isSafeInteger(source.observedAcceptedPrefixCount)
    || source.observedAcceptedPrefixCount < 0
    || source.observedAcceptedPrefixCount > source.provenPartCount
    || source.possibleSubmittedPartIndex !== null
      && (typeof source.possibleSubmittedPartIndex !== "number"
        || !Number.isSafeInteger(source.possibleSubmittedPartIndex)
        || source.possibleSubmittedPartIndex < 0
        || source.possibleSubmittedPartIndex >= source.partCount)
  ) throw new Error("messaging run is malformed");
  const sourceParts = denseArray(source.parts, "messaging run parts", 8);
  if (sourceParts.length !== source.partCount) throw new Error("messaging run is malformed");
  const terminalReasons = new Set<MessagingRunV1["terminalReason"]>([
    null,
    "context-drift",
    "prefix-freshness-unproven",
    "provider-failed-before-dispatch",
    "provider-result-indeterminate",
    "journal-recovery-required",
  ]);
  if (!terminalReasons.has(source.terminalReason as MessagingRunV1["terminalReason"])) {
    throw new Error("messaging run terminal reason is malformed");
  }
  const partStates = new Set<MessagingPartJournalStateV1>([
    "unattempted", "claimed", "dispatching", "accepted",
    "failed-before-dispatch", "failed-permanent", "indeterminate",
  ]);
  const seen = new Set<string>();
  const parts = sourceParts.map((value_, index) => {
    const part = record(value_, `messaging run part ${index + 1}`);
    exactKeys(part, [
      "partId", "text", "replyRef", "replyToProviderId", "direction", "bodySha256",
      "state", "providerMessageId", "providerRevision", "delivery", "read",
    ], `messaging run part ${index + 1}`);
    const partId = boundedText(part.partId, "messaging run part ID", 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(partId) || seen.has(partId)) {
      throw new Error("messaging run part ID is malformed or repeated");
    }
    seen.add(partId);
    if (
      !partStates.has(part.state as MessagingPartJournalStateV1)
      || part.replyRef !== null
        && (typeof part.replyRef !== "string" || !/^wmreply_[A-Za-z0-9_-]{22}$/u.test(part.replyRef))
      || part.replyToProviderId !== null
        && (typeof part.replyToProviderId !== "string" || part.replyToProviderId.length < 1 || part.replyToProviderId.length > 4_096)
      || part.direction !== "outgoing"
      || part.providerMessageId !== null
        && (typeof part.providerMessageId !== "string" || part.providerMessageId.length < 1 || part.providerMessageId.length > 4_096)
      || part.providerRevision !== null
        && (typeof part.providerRevision !== "string" || part.providerRevision.length < 1 || part.providerRevision.length > 4_096)
      || part.state === "accepted" && part.providerMessageId === null
      || part.state !== "accepted" && part.providerMessageId !== null
      || part.state !== "accepted" && part.providerRevision !== null
      || part.delivery !== "unknown" && part.delivery !== "delivered" && part.delivery !== "failed"
      || part.read !== "unknown" && part.read !== "read"
    ) throw new Error("messaging run part is malformed");
    const text = boundedText(part.text, "messaging run part text", 65_536);
    const bodySha256 = digest(part.bodySha256, "messaging run part body digest");
    if (sha256(text) !== bodySha256) {
      throw new Error("messaging run part body digest disagrees");
    }
    return Object.freeze({
      partId,
      text,
      replyRef: part.replyRef as string | null,
      replyToProviderId: part.replyToProviderId as string | null,
      direction: "outgoing" as const,
      bodySha256,
      state: part.state as MessagingPartJournalStateV1,
      providerMessageId: part.providerMessageId as string | null,
      providerRevision: part.providerRevision as string | null,
      delivery: part.delivery as "unknown" | "delivered" | "failed",
      read: part.read as "unknown" | "read",
    });
  });
  const startedAt = timestamp(boundedText(source.startedAt, "messaging run start", 64));
  const recordedAt = timestamp(boundedText(source.recordedAt, "messaging run record time", 64));
  if (Date.parse(recordedAt) < Date.parse(startedAt)) throw new Error("messaging run time moved backward");
  const parsed: MessagingRunV1 = Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-run",
    runId: source.runId,
    planDigest: digest(source.planDigest, "messaging run plan digest"),
    routeRef: source.routeRef,
    contextRef: source.contextRef,
    clientIntentSha256: digest(source.clientIntentSha256, "messaging run client intent"),
    turnDigest: digest(source.turnDigest, "messaging run turn digest"),
    previewDigest: digest(source.previewDigest, "messaging run preview digest"),
    state: source.state,
    partCount: source.partCount,
    provenPartCount: source.provenPartCount,
    observedAcceptedPrefixCount: source.observedAcceptedPrefixCount,
    possibleSubmittedPartIndex: source.possibleSubmittedPartIndex as number | null,
    privateProviderOutcome: hasPrivateProviderOutcome
      ? source.privateProviderOutcome === null
        ? null
        : parsePrivateProviderOutcome(source.privateProviderOutcome)
      : null,
    terminalReason: source.terminalReason as MessagingRunV1["terminalReason"],
    parts: Object.freeze(parts),
    startedAt,
    recordedAt,
  });
  assertRun(parsed);
  return parsed;
}

/** Strict foreign-value parser used by encrypted storage and contract tests. */
export function parseMessagingRunV1(value: unknown): MessagingRunV1 {
  return parseRun(value);
}

/** Exact proof material retained durably for a future checked provider reread. */
export function messagingExpectedOwnPrefix(
  run: MessagingRunV1,
): ProviderPluginMessagingExpectedOwnPrefixV1["accepted"] {
  assertRun(run);
  return Object.freeze(run.parts.slice(0, run.provenPartCount).map((part) => {
    if (part.state !== "accepted" || part.providerMessageId === null) {
      throw new Error("messaging run accepted prefix is incomplete");
    }
    return Object.freeze({
      providerMessageId: part.providerMessageId,
      providerRevision: part.providerRevision,
      direction: part.direction,
      bodySha256: part.bodySha256,
      replyToProviderId: part.replyToProviderId,
    });
  }));
}

function sealed(run: MessagingRunV1, environment: Environment): unknown {
  return sealAuthenticatedPrivatePayload(
    run,
    domain(run.runId),
    environment,
    MAX_PLAINTEXT_BYTES,
  );
}

export function initializeMessagingRun(
  runId: string,
  planDigest: string,
  plan: MessagingCompositeInvocationPlanV1,
  environment: Environment,
  at: string,
): MessagingRunSnapshotV1 {
  ensurePrivateStateDirectory(root(environment), environment);
  const startedAt = timestamp(at);
  const run = parseRun({
    schemaVersion: 1,
    format: "wrench.messaging-run",
    runId,
    planDigest,
    routeRef: plan.routeRef,
    contextRef: plan.contextRef,
    clientIntentSha256: plan.clientIntentSha256,
    turnDigest: plan.turnDigest,
    previewDigest: plan.previewDigest,
    state: "pending",
    partCount: plan.parts.length,
    provenPartCount: 0,
    observedAcceptedPrefixCount: 0,
    possibleSubmittedPartIndex: null,
    privateProviderOutcome: null,
    terminalReason: null,
    parts: plan.parts.map((part) => ({
      partId: part.partId,
      text: part.text,
      replyRef: part.replyRef,
      replyToProviderId: part.replyToProviderId,
      direction: "outgoing" as const,
      bodySha256: sha256(part.text),
      state: "unattempted" as const,
      providerMessageId: null,
      providerRevision: null,
      delivery: "unknown" as const,
      read: "unknown" as const,
    })),
    startedAt,
    recordedAt: startedAt,
  });
  const envelope = sealed(run, environment);
  const encoded = `${canonicalJson(envelope)}\n`;
  const created = createPrivateJsonIfAbsent(path(runId, environment), envelope, {
    environment,
    privateParent: true,
  });
  if (!created.created) {
    const existing = readMessagingRun(runId, environment);
    if (
      existing.run.planDigest !== planDigest
      || existing.run.turnDigest !== plan.turnDigest
    ) throw new Error("existing messaging run belongs to another confirmation");
    return existing;
  }
  return Object.freeze({ run, contentSha256: sha256(encoded) });
}

export function readMessagingRun(
  runId: string,
  environment: Environment = process.env,
): MessagingRunSnapshotV1 {
  const text = readPrivateStateFileIfPresent(
    path(runId, environment),
    MAX_ENCRYPTED_BYTES,
    "encrypted messaging run",
    environment,
  );
  if (text === null) throw new Error("messaging run was not found");
  let envelope: unknown;
  try {
    envelope = JSON.parse(text) as unknown;
  } catch {
    throw new Error("encrypted messaging run is malformed");
  }
  const run = parseRun(openAuthenticatedPrivatePayload(
    envelope,
    domain(runId),
    environment,
    MAX_PLAINTEXT_BYTES,
  ));
  if (run.runId !== runId) throw new Error("messaging run coordinate disagrees");
  return Object.freeze({ run, contentSha256: sha256(text) });
}

export function readMessagingRunIfPresent(
  runId: string,
  environment: Environment = process.env,
): MessagingRunSnapshotV1 | null {
  try {
    return readMessagingRun(runId, environment);
  } catch (error) {
    if (error instanceof Error && error.message === "messaging run was not found") return null;
    throw error;
  }
}

export function transitionMessagingRun(
  run: MessagingRunV1,
  event: MessagingRunEventV1,
): MessagingRunV1 {
  assertRun(run);
  if (run.state !== "pending" || event.index !== run.provenPartCount) {
    throw new Error("messaging run transition is outside the active prefix");
  }
  const current = run.parts[event.index];
  if (current === undefined) throw new Error("messaging run transition index is invalid");
  let nextState: MessagingPartJournalStateV1;
  let providerMessageId = current.providerMessageId;
  let providerRevision = current.providerRevision;
  let state: MessagingRunV1["state"] = run.state;
  let provenPartCount = run.provenPartCount;
  let observedAcceptedPrefixCount = run.observedAcceptedPrefixCount;
  let possibleSubmittedPartIndex = run.possibleSubmittedPartIndex;
  let privateProviderOutcome = run.privateProviderOutcome;
  let terminalReason = run.terminalReason;
  if (event.type === "claimed") {
    if (current.state !== "unattempted") throw new Error("messaging part was already claimed");
    if (
      !Number.isSafeInteger(event.observedAcceptedPrefixCount)
      || event.observedAcceptedPrefixCount < observedAcceptedPrefixCount
      || event.observedAcceptedPrefixCount > run.provenPartCount
    ) throw new Error("messaging accepted-prefix observation is not monotonic");
    observedAcceptedPrefixCount = event.observedAcceptedPrefixCount;
    nextState = "claimed";
  } else if (event.type === "dispatching") {
    if (current.state !== "claimed") throw new Error("messaging part was not claimed");
    nextState = "dispatching";
  } else if (event.type === "accepted") {
    if (current.state !== "dispatching") throw new Error("messaging part did not cross dispatch");
    nextState = "accepted";
    providerMessageId = event.providerMessageId;
    providerRevision = event.providerRevision;
    provenPartCount += 1;
    if (provenPartCount === run.partCount) state = "submitted";
  } else if (event.type === "categorical-stop") {
    if (current.state !== "unattempted" && current.state !== "claimed") {
      throw new Error("categorical stop crossed the dispatch boundary");
    }
    nextState = event.partState;
    state = provenPartCount === 0 ? "failed" : "partial";
    terminalReason = event.reason;
  } else {
    if (current.state !== "dispatching" && current.state !== "claimed") {
      throw new Error("indeterminate part was not active");
    }
    if (
      event.reason === "provider-result-indeterminate"
      && event.privateProviderOutcome !== null
      && current.state !== "dispatching"
    ) throw new Error("private provider outcome did not cross dispatch");
    nextState = "indeterminate";
    state = "indeterminate";
    possibleSubmittedPartIndex = event.index;
    terminalReason = event.reason;
    privateProviderOutcome = event.reason === "provider-result-indeterminate"
      ? event.privateProviderOutcome
      : null;
  }
  const parts = run.parts.map((part, index) => index === event.index
    ? Object.freeze({ ...part, state: nextState, providerMessageId, providerRevision })
    : part);
  if (Date.parse(event.at) < Date.parse(run.recordedAt)) {
    throw new Error("messaging run transition time moved backward");
  }
  return parseRun({
    ...run,
    state,
    provenPartCount,
    observedAcceptedPrefixCount,
    possibleSubmittedPartIndex,
    privateProviderOutcome,
    terminalReason,
    parts,
    recordedAt: timestamp(event.at),
  });
}

export function updateMessagingRun(
  snapshot: MessagingRunSnapshotV1,
  event: MessagingRunEventV1,
  environment: Environment = process.env,
): MessagingRunSnapshotV1 {
  const run = transitionMessagingRun(snapshot.run, event);
  const envelope = sealed(run, environment);
  const encoded = `${canonicalJson(envelope)}\n`;
  if (!writePrivateJsonIfUnchanged(path(run.runId, environment), envelope, {
    expectedCurrentContentSha256: snapshot.contentSha256,
    maximumExpectedCurrentBytes: MAX_ENCRYPTED_BYTES,
  })) throw new Error("messaging run changed concurrently");
  return Object.freeze({ run, contentSha256: sha256(encoded) });
}

export function messagingReceiptBinding(run: MessagingRunV1): MessagingReceiptBindingV1 {
  if (run.state === "pending") throw new Error("pending messaging run has no terminal receipt binding");
  const withoutReceipt = Object.freeze({
    schemaVersion: 1 as const,
    format: "wrench.messaging-receipt-binding" as const,
    contractId: MESSAGING_RECEIPT_BINDING_CONTRACT_ID,
    contractHash: MESSAGING_RECEIPT_BINDING_CONTRACT_HASH,
    clientIntentSha256: run.clientIntentSha256,
    routeRefSha256: sha256(run.routeRef),
    contextRefSha256: sha256(run.contextRef),
    turnDigest: run.turnDigest,
    previewDigest: run.previewDigest,
    runId: run.runId,
    state: run.state,
    partCount: run.partCount,
    provenPartCount: run.provenPartCount,
    recordedAt: run.recordedAt,
  });
  return parseMessagingReceiptBindingV1({
    ...withoutReceipt,
    receiptSha256: sha256(canonicalJson(withoutReceipt)),
  });
}

export function messagingRunReceipt(run: MessagingRunV1): MessagingRunReceiptV1 {
  const binding = messagingReceiptBinding(run);
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-run-receipt",
    planDigest: run.planDigest,
    runId: run.runId,
    state: binding.state,
    partCount: binding.partCount,
    provenPartCount: binding.provenPartCount,
    clientIntentSha256: binding.clientIntentSha256,
    routeRefSha256: binding.routeRefSha256,
    contextRefSha256: binding.contextRefSha256,
    turnDigest: binding.turnDigest,
    previewDigest: binding.previewDigest,
    receiptBindingSha256: binding.receiptSha256,
    recordedAt: binding.recordedAt,
  });
}
