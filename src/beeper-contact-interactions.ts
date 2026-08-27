import { types as nodeTypes } from "node:util";

import {
  LOCAL_MESSAGE_BUNDLE_V1_LIMITS,
  LOCAL_MESSAGE_BUNDLE_V1_PROVIDER_ID,
  LOCAL_MESSAGE_BUNDLE_V1_SOURCE_ID,
  LOCAL_MESSAGE_BUNDLE_V1_SOURCE_TRANSFORM_VERSION,
} from "@hraness/message-like-me/message-bundle-v1";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  parseBeeperMessageLikeMeCompletion,
  parseBeeperMessageLikeMeDescriptor,
  parseBeeperMessageLikeMeRecord,
  type BeeperMessageLikeMeConversation,
  type BeeperMessageLikeMeExportSource,
  type BeeperMessageLikeMeMessage,
  type BeeperMessageLikeMeRecord,
} from "./beeper-message-bundle-v1";
import type {
  BeeperMessageLikeMeSourceCoordinate,
} from "./beeper-message-like-me-source";
import { BEEPER_CLI_PIN } from "./providers/beeper-local";
import { WRENCH_VERSION } from "./version";

export const BEEPER_CONTACT_INTERACTION_SCHEMA_VERSION = 1 as const;
export const BEEPER_CONTACT_INTERACTION_FORMAT =
  "wrench.contact-interaction-summary" as const;
export const BEEPER_CONTACT_INTERACTION_RECEIPT_FORMAT =
  "wrench.beeper-contact-interaction-export-receipt" as const;
export const BEEPER_CONTACT_INTERACTION_TRANSFORM = Object.freeze({
  id: "beeper-direct-contact-interactions",
  version: 1 as const,
  sourceVersion: LOCAL_MESSAGE_BUNDLE_V1_SOURCE_TRANSFORM_VERSION,
});
export const BEEPER_CONTACT_INTERACTION_IMPLEMENTATION = Object.freeze({
  producer: Object.freeze({
    package: "@hraness/wrench" as const,
    version: WRENCH_VERSION,
  }),
  officialCli: Object.freeze({
    implementation: BEEPER_CLI_PIN.implementation,
    version: BEEPER_CLI_PIN.version,
    commit: BEEPER_CLI_PIN.commit,
    platform: "darwin-arm64" as const,
    binarySha256: BEEPER_CLI_PIN.darwinArm64BinarySha256,
  }),
});

const MAX_RECORDS = LOCAL_MESSAGE_BUNDLE_V1_LIMITS.records;
const MAX_COORDINATE_BYTES = 4 * 1024;
const MAX_NETWORK_BYTES = 64;
const CONTACT_INTERACTION_WARNING_CODES = Object.freeze([
  "group-messages-excluded",
  "incomplete-direct-rosters-excluded",
  "message-content-excluded",
  "replacement-message-versions-excluded",
] as const);
const MAX_WARNINGS = LOCAL_MESSAGE_BUNDLE_V1_LIMITS.warnings
  + CONTACT_INTERACTION_WARNING_CODES.length;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
export const BEEPER_CONTACT_INTERACTION_WIRE_MAX_BYTES =
  (MAX_OUTPUT_BYTES * 3) + (1024 * 1024);
const PROGRESS_INTERVAL_MS = 30_000;

export type BeeperContactInteractionAccount = Readonly<{
  /** Exact stable account coordinate returned by the official Beeper export. */
  accountId: string;
  accountProviderId: string;
  network: string;
  /** Exact stable self-user coordinate in this account realm. */
  selfParticipantId: string;
  selfParticipantProviderId: string;
  observedAt: string;
}>;

export type BeeperContactInteraction = Readonly<{
  /** Exact stable connected-account coordinate. */
  accountId: string;
  accountProviderId: string;
  /** Exact stable account-scoped peer coordinate. */
  contactId: string;
  contactProviderId: string;
  network: string;
  sentCount: number;
  receivedCount: number;
  interactionCount: number;
  conversationCount: number;
  firstInteractionAt: string;
  lastInteractionAt: string;
  reciprocal: boolean;
  completeness: "lower-bound";
  provenance: Readonly<{
    sourceId: typeof LOCAL_MESSAGE_BUNDLE_V1_SOURCE_ID;
    sourceVersion: typeof LOCAL_MESSAGE_BUNDLE_V1_SOURCE_TRANSFORM_VERSION;
    providerId: typeof LOCAL_MESSAGE_BUNDLE_V1_PROVIDER_ID;
    providerVersion: string;
    observedAt: string;
  }>;
}>;

export type BeeperContactInteractionSummary = Readonly<{
  schemaVersion: 1;
  format: typeof BEEPER_CONTACT_INTERACTION_FORMAT;
  transform: typeof BEEPER_CONTACT_INTERACTION_TRANSFORM;
  source: Readonly<{
    id: typeof LOCAL_MESSAGE_BUNDLE_V1_SOURCE_ID;
    version: typeof LOCAL_MESSAGE_BUNDLE_V1_SOURCE_TRANSFORM_VERSION;
  }>;
  provider: Readonly<{
    id: typeof LOCAL_MESSAGE_BUNDLE_V1_PROVIDER_ID;
    version: string;
  }>;
  observedAt: string | null;
  scope: Readonly<{
    conversations: "complete-direct-only";
    messages: "current-direction-known-only";
  }>;
  completeness: Readonly<{
    kind: "lower-bound";
    sourceKind: "bounded-local" | "truncated" | "unknown";
    reason: string | null;
    observedFrom: string | null;
    observedThrough: string | null;
  }>;
  warnings: readonly string[];
  privacy: Readonly<{
    messageBodies: "excluded";
    attachments: "excluded";
    reactions: "excluded";
    media: "excluded";
    groupMessages: "excluded";
    localPaths: "excluded";
    credentials: "excluded";
  }>;
  counts: Readonly<{
    accounts: number;
    directRelationships: number;
    directConversations: number;
    interactions: number;
    sent: number;
    received: number;
  }>;
  accounts: readonly BeeperContactInteractionAccount[];
  interactions: readonly BeeperContactInteraction[];
  integrity: Readonly<{
    algorithm: "sha256";
    summarySha256: string;
  }>;
}>;

export type BeeperContactInteractionExportBounds = Readonly<{
  limitChats: number | null;
  limitMessages: number | null;
  maxParticipants: number | null;
}>;

export type BeeperContactInteractionExportReceipt = Readonly<{
  schemaVersion: 1;
  format: typeof BEEPER_CONTACT_INTERACTION_RECEIPT_FORMAT;
  runId: string;
  operation: "beeper.export-contact-interactions";
  status: "succeeded";
  transport: "linked-device";
  implementation: typeof BEEPER_CONTACT_INTERACTION_IMPLEMENTATION;
  startedAt: string;
  finishedAt: string;
  auth: Readonly<{
    id: string;
    kind: "linked-device-store";
    provider: "beeper";
    identitySha256: string;
  }>;
  bounds: BeeperContactInteractionExportBounds;
  source: BeeperContactInteractionSummary["source"];
  provider: BeeperContactInteractionSummary["provider"];
  transform: typeof BEEPER_CONTACT_INTERACTION_TRANSFORM;
  completeness: BeeperContactInteractionSummary["completeness"];
  counts: BeeperContactInteractionSummary["counts"];
  output: Readonly<{
    schemaVersion: typeof BEEPER_CONTACT_INTERACTION_SCHEMA_VERSION;
    format: typeof BEEPER_CONTACT_INTERACTION_FORMAT;
    summarySha256: string;
  }>;
  privacy: Readonly<{
    messageBodies: "excluded";
    attachments: "excluded";
    reactions: "excluded";
    media: "excluded";
    localPaths: "excluded";
    credentials: "excluded";
  }>;
  integrity: Readonly<{
    algorithm: "sha256";
    receiptSha256: string;
  }>;
}>;

export type BeeperContactInteractionExportResult = Readonly<{
  receipt: BeeperContactInteractionExportReceipt;
  output: BeeperContactInteractionSummary;
}>;

export type BeeperContactInteractionProgress =
  | Readonly<{
      phase: "summary-building";
      elapsedSeconds: number;
      records: number;
    }>
  | Readonly<{
      phase: "summary-completed";
      records: number;
      relationships: number;
      interactions: number;
    }>;

export type SummarizeBeeperContactInteractionsRequest = Readonly<{
  source: BeeperMessageLikeMeExportSource;
  coordinateForRecord: (
    record: unknown,
  ) => BeeperMessageLikeMeSourceCoordinate | undefined;
  onProgress?: (progress: BeeperContactInteractionProgress) => void;
  signal?: AbortSignal;
}>;

type AccountFact = Readonly<{
  id: string;
  accountId: string;
  providerId: string;
  network: string;
  selfParticipantId: string;
  observedAt: string;
}>;

type ParticipantFact = Readonly<{
  id: string;
  accountLocalId: string;
  accountId: string;
  participantId: string;
  providerId: string;
  isSelf: boolean;
}>;

type ConversationFact = Readonly<{
  id: string;
  accountLocalId: string;
  accountId: string;
  conversationId: string;
  network: string;
  type: BeeperMessageLikeMeConversation["type"];
  participantIds: readonly string[];
  participantsComplete: boolean | null;
}>;

type MessageFact = Readonly<{
  id: string;
  accountLocalId: string;
  accountId: string;
  conversationLocalId: string;
  conversationId: string;
  messageId: string;
  providerId: string;
  senderParticipantId: string | null;
  direction: BeeperMessageLikeMeMessage["direction"];
  sentAt: string;
  observedAt: string;
  replacement: Readonly<{
    replacesMessageId: string | null;
    replacesProviderId: string;
  }> | null;
}>;

type MutableInteraction = {
  accountId: string;
  accountProviderId: string;
  contactId: string;
  contactProviderId: string;
  network: string;
  sentCount: number;
  receivedCount: number;
  conversations: Set<string>;
  firstInteractionAt: string;
  lastInteractionAt: string;
  observedAt: string;
};

function fail(message: string): never {
  throw new Error(`Beeper contact interaction summary: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return fail(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return fail(`${label} must not contain symbol fields`);
  }
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value as Record<string, unknown>;
}

function boundedArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || value.length > maximum
  ) return fail(`${label} must be a bounded plain array`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || keys.length !== value.length + 1
    || keys[keys.length - 1] !== "length"
  ) return fail(`${label} must not contain holes or custom fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}[${String(index)}] must be an enumerable data property`);
    }
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) fail(`${label} contains unsupported or missing fields`);
}

function coordinate(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > MAX_COORDINATE_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return fail(`${label} must be bounded provider text`);
  return value;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function token(value: unknown, label: string, maximum = 128): string {
  const parsed = coordinate(value, label);
  if (
    Buffer.byteLength(parsed, "utf8") > maximum
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/u.test(parsed)
  ) return fail(`${label} must be a token`);
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = token(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) return fail(`${label} must be a SHA-256 digest`);
  return parsed;
}

function integer(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) return fail(`${label} must be a non-negative integer`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const parsed = coordinate(value, label);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    return fail(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("operation was aborted");
}

function localId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${sha256(canonicalJson(parts))}`;
}

function providerId(kind: string, ...parts: readonly string[]): string {
  return `beeper-${kind}:${sha256(canonicalJson(parts))}`;
}

function parseSourceCoordinate(
  value: unknown,
  kind: BeeperMessageLikeMeSourceCoordinate["kind"],
  label: string,
): BeeperMessageLikeMeSourceCoordinate {
  const source = record(value, label);
  if (kind === "account") {
    exactKeys(source, ["kind", "accountId"], label);
    if (source.kind !== kind) return fail(`${label}.kind does not match its record`);
    return Object.freeze({ kind, accountId: coordinate(source.accountId, `${label}.accountId`) });
  }
  if (kind === "participant") {
    exactKeys(source, ["kind", "accountId", "participantId"], label);
    if (source.kind !== kind) return fail(`${label}.kind does not match its record`);
    return Object.freeze({
      kind,
      accountId: coordinate(source.accountId, `${label}.accountId`),
      participantId: coordinate(source.participantId, `${label}.participantId`),
    });
  }
  if (kind === "conversation") {
    exactKeys(source, ["kind", "accountId", "conversationId"], label);
    if (source.kind !== kind) return fail(`${label}.kind does not match its record`);
    return Object.freeze({
      kind,
      accountId: coordinate(source.accountId, `${label}.accountId`),
      conversationId: coordinate(source.conversationId, `${label}.conversationId`),
    });
  }
  exactKeys(source, ["kind", "accountId", "conversationId", "messageId"], label);
  if (source.kind !== kind) return fail(`${label}.kind does not match its record`);
  return Object.freeze({
    kind,
    accountId: coordinate(source.accountId, `${label}.accountId`),
    conversationId: coordinate(source.conversationId, `${label}.conversationId`),
    messageId: coordinate(source.messageId, `${label}.messageId`),
  });
}

function requireCoordinate(
  request: SummarizeBeeperContactInteractionsRequest,
  candidate: unknown,
  kind: BeeperMessageLikeMeSourceCoordinate["kind"],
  index: number,
): BeeperMessageLikeMeSourceCoordinate {
  const value = request.coordinateForRecord(candidate);
  if (value === undefined) {
    return fail(`record[${String(index)}] omitted its stable provider coordinate`);
  }
  return parseSourceCoordinate(value, kind, `record[${String(index)}] coordinate`);
}

function assertCoordinateBinding(
  value: BeeperMessageLikeMeRecord,
  source: BeeperMessageLikeMeSourceCoordinate,
): void {
  const accountLocalId = localId("account", source.accountId);
  const accountProviderId = providerId("account", source.accountId);
  if (
    value.accountId !== accountLocalId
    || value.provenance.connectedAccountProviderId !== accountProviderId
  ) fail("a record coordinate does not bind its connected account");
  if (value.kind === "account" && source.kind === "account") {
    if (
      value.id !== accountLocalId
      || value.provenance.providerId !== accountProviderId
    ) fail("an account coordinate does not bind its record");
    return;
  }
  if (value.kind === "participant" && source.kind === "participant") {
    if (
      value.id !== localId("participant", source.accountId, source.participantId)
      || value.provenance.providerId
        !== providerId("participant", source.accountId, source.participantId)
    ) fail("a participant coordinate does not bind its record");
    return;
  }
  if (value.kind === "conversation" && source.kind === "conversation") {
    if (
      value.id !== localId("conversation", source.accountId, source.conversationId)
      || value.provenance.providerId
        !== providerId("conversation", source.accountId, source.conversationId)
    ) fail("a conversation coordinate does not bind its record");
    return;
  }
  if (value.kind === "message" && source.kind === "message") {
    if (
      value.id !== localId(
        "message",
        source.accountId,
        source.conversationId,
        source.messageId,
      )
      || value.provenance.providerId !== providerId(
        "message",
        source.accountId,
        source.conversationId,
        source.messageId,
      )
    ) fail("a message coordinate does not bind its record");
    return;
  }
  fail("a record coordinate kind does not match its record");
}

function updateObservedAt(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

function summaryProjection(
  value: Omit<BeeperContactInteractionSummary, "integrity">,
): Omit<BeeperContactInteractionSummary, "integrity"> {
  return value;
}

/**
 * Consume the exact same admitted, bounded history stream as the private
 * Message Like Me bundle while retaining only relationship metadata. Message
 * bodies and attachment metadata are parsed for source-contract integrity and
 * immediately discarded.
 */
export async function summarizeBeeperContactInteractions(
  request: SummarizeBeeperContactInteractionsRequest,
): Promise<BeeperContactInteractionSummary> {
  if (
    typeof request.source !== "object"
    || request.source === null
    || typeof request.source.completion !== "function"
    || typeof request.source.records !== "object"
    || request.source.records === null
    || typeof request.source.records[Symbol.asyncIterator] !== "function"
  ) return fail("source is malformed");
  const descriptor = parseBeeperMessageLikeMeDescriptor(request.source.descriptor);
  if (descriptor.source.version !== BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion) {
    return fail("source transform version is unsupported");
  }

  const accounts = new Map<string, AccountFact>();
  const participants = new Map<string, ParticipantFact>();
  const conversations = new Map<string, ConversationFact>();
  const messages = new Map<string, MessageFact>();
  const providerMessages = new Map<string, MessageFact>();
  const rawAccounts = new Set<string>();
  const rawParticipants = new Set<string>();
  const rawConversations = new Set<string>();
  const rawMessages = new Set<string>();
  let observedAt: string | null = null;
  let recordCount = 0;
  const startedAt = Date.now();
  let progressFailed = false;
  const report = (): void => {
    try {
      request.onProgress?.(Object.freeze({
        phase: "summary-building",
        elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)),
        records: recordCount,
      }));
    } catch {
      progressFailed = true;
    }
  };
  report();
  const heartbeat = request.onProgress === undefined
    ? undefined
    : setInterval(report, PROGRESS_INTERVAL_MS);
  try {
    for await (const candidate of request.source.records) {
      throwIfAborted(request.signal);
      if (progressFailed) return fail("progress reporting failed");
      if (recordCount >= MAX_RECORDS) return fail("source exceeded its record bound");
      const parsed = parseBeeperMessageLikeMeRecord(candidate, recordCount);
      observedAt = updateObservedAt(observedAt, parsed.provenance.observedAt);
      if (
        parsed.kind === "account"
        || parsed.kind === "participant"
        || parsed.kind === "conversation"
        || parsed.kind === "message"
      ) {
        const source = requireCoordinate(request, candidate, parsed.kind, recordCount);
        assertCoordinateBinding(parsed, source);
        if (parsed.kind === "account" && source.kind === "account") {
          if (accounts.has(parsed.id) || rawAccounts.has(source.accountId)) {
            return fail("account coordinates repeat");
          }
          accounts.set(parsed.id, Object.freeze({
            id: parsed.id,
            accountId: source.accountId,
            providerId: parsed.provenance.providerId,
            network: parsed.network,
            selfParticipantId: parsed.selfParticipantId,
            observedAt: parsed.provenance.observedAt,
          }));
          rawAccounts.add(source.accountId);
        } else if (parsed.kind === "participant" && source.kind === "participant") {
          const raw = `${source.accountId}\0${source.participantId}`;
          if (participants.has(parsed.id) || rawParticipants.has(raw)) {
            return fail("participant coordinates repeat");
          }
          participants.set(parsed.id, Object.freeze({
            id: parsed.id,
            accountLocalId: parsed.accountId,
            accountId: source.accountId,
            participantId: source.participantId,
            providerId: parsed.provenance.providerId,
            isSelf: parsed.isSelf,
          }));
          rawParticipants.add(raw);
        } else if (parsed.kind === "conversation" && source.kind === "conversation") {
          const raw = `${source.accountId}\0${source.conversationId}`;
          if (conversations.has(parsed.id) || rawConversations.has(raw)) {
            return fail("conversation coordinates repeat");
          }
          conversations.set(parsed.id, Object.freeze({
            id: parsed.id,
            accountLocalId: parsed.accountId,
            accountId: source.accountId,
            conversationId: source.conversationId,
            network: parsed.network,
            type: parsed.type,
            participantIds: parsed.participantIds,
            participantsComplete: parsed.participantsComplete,
          }));
          rawConversations.add(raw);
        } else if (parsed.kind === "message" && source.kind === "message") {
          const raw = `${source.accountId}\0${source.conversationId}\0${source.messageId}`;
          const provider = `${parsed.accountId}\0${parsed.provenance.providerId}`;
          if (
            messages.has(parsed.id)
            || rawMessages.has(raw)
            || providerMessages.has(provider)
          ) return fail("message coordinates repeat");
          const fact = Object.freeze({
            id: parsed.id,
            accountLocalId: parsed.accountId,
            accountId: source.accountId,
            conversationLocalId: parsed.conversationId,
            conversationId: source.conversationId,
            messageId: source.messageId,
            providerId: parsed.provenance.providerId,
            senderParticipantId: parsed.senderParticipantId,
            direction: parsed.direction,
            sentAt: parsed.sentAt,
            observedAt: parsed.provenance.observedAt,
            replacement: parsed.edit?.kind === "replacement"
              ? Object.freeze({
                  replacesMessageId: parsed.edit.replacesMessageId,
                  replacesProviderId: parsed.edit.replacesProviderId,
                })
              : null,
          });
          messages.set(parsed.id, fact);
          providerMessages.set(provider, fact);
          rawMessages.add(raw);
        } else {
          return fail("a coordinate kind changed during parsing");
        }
      }
      recordCount += 1;
      if (recordCount % 10_000 === 0) report();
    }
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
  if (progressFailed) return fail("progress reporting failed");
  throwIfAborted(request.signal);
  const completion = parseBeeperMessageLikeMeCompletion(
    await request.source.completion(),
  );

  for (const participant of participants.values()) {
    const account = accounts.get(participant.accountLocalId);
    if (account === undefined || account.accountId !== participant.accountId) {
      return fail("a participant references an unknown account");
    }
    if (participant.isSelf && account.selfParticipantId !== participant.id) {
      return fail("an account has an unreferenced self participant");
    }
  }
  for (const account of accounts.values()) {
    const self = participants.get(account.selfParticipantId);
    if (
      self === undefined
      || self.accountLocalId !== account.id
      || self.accountId !== account.accountId
      || !self.isSelf
    ) return fail("an account does not have its exact self participant");
  }
  for (const conversation of conversations.values()) {
    const account = accounts.get(conversation.accountLocalId);
    if (account === undefined || account.accountId !== conversation.accountId) {
      return fail("a conversation references an unknown account");
    }
    for (const participantId of conversation.participantIds) {
      const participant = participants.get(participantId);
      if (
        participant === undefined
        || participant.accountLocalId !== conversation.accountLocalId
        || participant.accountId !== conversation.accountId
      ) return fail("a conversation participant crosses accounts");
    }
    if (conversation.type === "direct" && conversation.participantsComplete === true) {
      const roster = conversation.participantIds.map((participantId) =>
        participants.get(participantId)!);
      if (
        roster.length !== 2
        || roster.filter((participant) => participant.isSelf).length !== 1
        || !conversation.participantIds.includes(account.selfParticipantId)
      ) return fail("a complete direct conversation does not have one exact peer");
    }
  }
  for (const message of messages.values()) {
    const conversation = conversations.get(message.conversationLocalId);
    if (
      conversation === undefined
      || conversation.accountLocalId !== message.accountLocalId
      || conversation.accountId !== message.accountId
      || conversation.conversationId !== message.conversationId
    ) return fail("a message references an unknown conversation");
    if (message.senderParticipantId !== null) {
      const sender = participants.get(message.senderParticipantId);
      if (
        sender === undefined
        || sender.accountLocalId !== message.accountLocalId
      ) return fail("a message sender crosses accounts");
      if (message.direction !== (sender.isSelf ? "outgoing" : "incoming")) {
        return fail("message direction conflicts with its sender participant");
      }
      if (
        conversation.participantsComplete === true
        && !conversation.participantIds.includes(sender.id)
      ) return fail("message sender is absent from the complete conversation roster");
    }
  }

  const replacementEdges = new Map<string, string>();
  const replacedProviderCoordinates = new Set<string>();
  const replacers = new Set<string>();
  for (const message of messages.values()) {
    const edit = message.replacement;
    if (edit === null) continue;
    const sourceCoordinate = `${message.accountLocalId}\0${message.providerId}`;
    const targetCoordinate = `${message.accountLocalId}\0${edit.replacesProviderId}`;
    if (sourceCoordinate === targetCoordinate) return fail("a replacement edit targets itself");
    if (replacers.has(targetCoordinate)) {
      return fail("one message version has multiple replacements");
    }
    const localTarget = edit.replacesMessageId === null
      ? undefined
      : messages.get(edit.replacesMessageId);
    const providerTarget = providerMessages.get(targetCoordinate);
    if (
      localTarget !== undefined
      && `${localTarget.accountLocalId}\0${localTarget.providerId}` !== targetCoordinate
    ) return fail("replacement local and provider coordinates disagree");
    if (
      localTarget !== undefined
      && providerTarget !== undefined
      && localTarget.id !== providerTarget.id
    ) return fail("replacement local and provider coordinates disagree");
    const target = localTarget ?? providerTarget;
    if (
      target !== undefined
      && target.conversationLocalId !== message.conversationLocalId
    ) return fail("a replacement edit crosses conversations");
    replacers.add(targetCoordinate);
    replacementEdges.set(sourceCoordinate, targetCoordinate);
    if (target !== undefined) replacedProviderCoordinates.add(targetCoordinate);
  }
  const completedReplacementNodes = new Set<string>();
  for (const start of replacementEdges.keys()) {
    if (completedReplacementNodes.has(start)) continue;
    const seen = new Set<string>();
    const chain: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && !completedReplacementNodes.has(current)) {
      if (seen.has(current)) return fail("replacement edits contain a cycle");
      seen.add(current);
      chain.push(current);
      current = replacementEdges.get(current);
    }
    for (const value of chain) completedReplacementNodes.add(value);
  }

  const summaries = new Map<string, MutableInteraction>();
  for (const message of messages.values()) {
    const direction = message.direction;
    if (direction === "unknown") continue;
    const providerCoordinate =
      `${message.accountLocalId}\0${message.providerId}`;
    if (replacedProviderCoordinates.has(providerCoordinate)) continue;
    const conversation = conversations.get(message.conversationLocalId);
    if (
      conversation === undefined
      || conversation.type !== "direct"
      || conversation.participantsComplete !== true
    ) continue;
    const account = accounts.get(message.accountLocalId);
    if (account === undefined) return fail("a message account disappeared");
    const peers = conversation.participantIds
      .map((participantId) => participants.get(participantId))
      .filter((participant): participant is ParticipantFact =>
        participant !== undefined && !participant.isSelf);
    const selves = conversation.participantIds
      .map((participantId) => participants.get(participantId))
      .filter((participant): participant is ParticipantFact =>
        participant !== undefined && participant.isSelf);
    if (
      peers.length !== 1
      || selves.length !== 1
      || selves[0]!.id !== account.selfParticipantId
    ) return fail("a complete direct conversation does not have one exact peer");
    const peer = peers[0]!;
    const key = `${account.accountId}\0${peer.participantId}`;
    const current = summaries.get(key) ?? {
      accountId: account.accountId,
      accountProviderId: account.providerId,
      contactId: peer.participantId,
      contactProviderId: peer.providerId,
      network: conversation.network,
      sentCount: 0,
      receivedCount: 0,
      conversations: new Set<string>(),
      firstInteractionAt: message.sentAt,
      lastInteractionAt: message.sentAt,
      observedAt: message.observedAt,
    };
    if (
      current.accountProviderId !== account.providerId
      || current.contactProviderId !== peer.providerId
      || current.network !== conversation.network
    ) return fail("one direct relationship changed provider provenance");
    if (direction === "outgoing") current.sentCount += 1;
    else current.receivedCount += 1;
    current.conversations.add(conversation.id);
    if (message.sentAt < current.firstInteractionAt) {
      current.firstInteractionAt = message.sentAt;
    }
    if (message.sentAt > current.lastInteractionAt) {
      current.lastInteractionAt = message.sentAt;
    }
    if (message.observedAt > current.observedAt) {
      current.observedAt = message.observedAt;
    }
    summaries.set(key, current);
  }

  const projectedAccounts = Object.freeze([...accounts.values()]
    .map((account): BeeperContactInteractionAccount => {
      const self = participants.get(account.selfParticipantId);
      if (self === undefined) return fail("an account self participant disappeared");
      return Object.freeze({
        accountId: account.accountId,
        accountProviderId: account.providerId,
        network: account.network,
        selfParticipantId: self.participantId,
        selfParticipantProviderId: self.providerId,
        observedAt: account.observedAt,
      });
    })
    .sort((left, right) => compareCanonicalText(left.accountId, right.accountId)));
  const interactions = Object.freeze([...summaries.values()]
    .map((summary): BeeperContactInteraction => Object.freeze({
      accountId: summary.accountId,
      accountProviderId: summary.accountProviderId,
      contactId: summary.contactId,
      contactProviderId: summary.contactProviderId,
      network: summary.network,
      sentCount: summary.sentCount,
      receivedCount: summary.receivedCount,
      interactionCount: summary.sentCount + summary.receivedCount,
      conversationCount: summary.conversations.size,
      firstInteractionAt: summary.firstInteractionAt,
      lastInteractionAt: summary.lastInteractionAt,
      reciprocal: summary.sentCount > 0 && summary.receivedCount > 0,
      completeness: "lower-bound",
      provenance: Object.freeze({
        sourceId: "beeper-local",
        sourceVersion: BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion,
        providerId: "beeper",
        providerVersion: descriptor.provider.version,
        observedAt: summary.observedAt,
      }),
    }))
    .sort((left, right) => compareCanonicalText(left.accountId, right.accountId)
      || compareCanonicalText(left.contactId, right.contactId)));
  const sent = interactions.reduce((sum, item) => sum + item.sentCount, 0);
  const received = interactions.reduce((sum, item) => sum + item.receivedCount, 0);
  const directConversations = new Set(
    [...summaries.values()].flatMap((summary) => [...summary.conversations]),
  ).size;
  const warnings = Object.freeze([...new Set([
    ...completion.warnings,
    ...CONTACT_INTERACTION_WARNING_CODES,
  ])].sort());
  const projection = Object.freeze({
    schemaVersion: BEEPER_CONTACT_INTERACTION_SCHEMA_VERSION,
    format: BEEPER_CONTACT_INTERACTION_FORMAT,
    transform: BEEPER_CONTACT_INTERACTION_TRANSFORM,
    source: Object.freeze({
      id: "beeper-local" as const,
      version: BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion,
    }),
    provider: Object.freeze({ id: "beeper" as const, version: descriptor.provider.version }),
    observedAt,
    scope: Object.freeze({
      conversations: "complete-direct-only" as const,
      messages: "current-direction-known-only" as const,
    }),
    completeness: Object.freeze({
      kind: "lower-bound" as const,
      sourceKind: completion.completeness.kind,
      reason: completion.completeness.reason,
      observedFrom: completion.completeness.observedFrom,
      observedThrough: completion.completeness.observedThrough,
    }),
    warnings,
    privacy: Object.freeze({
      messageBodies: "excluded" as const,
      attachments: "excluded" as const,
      reactions: "excluded" as const,
      media: "excluded" as const,
      groupMessages: "excluded" as const,
      localPaths: "excluded" as const,
      credentials: "excluded" as const,
    }),
    counts: Object.freeze({
      accounts: projectedAccounts.length,
      directRelationships: interactions.length,
      directConversations,
      interactions: sent + received,
      sent,
      received,
    }),
    accounts: projectedAccounts,
    interactions,
  }) satisfies Omit<BeeperContactInteractionSummary, "integrity">;
  const summary = Object.freeze({
    ...projection,
    integrity: Object.freeze({
      algorithm: "sha256" as const,
      summarySha256: sha256(canonicalJson(summaryProjection(projection))),
    }),
  });
  if (Buffer.byteLength(canonicalJson(summary), "utf8") > MAX_OUTPUT_BYTES) {
    return fail("summary exceeded its output byte bound");
  }
  request.onProgress?.(Object.freeze({
    phase: "summary-completed",
    records: recordCount,
    relationships: interactions.length,
    interactions: sent + received,
  }));
  return summary;
}

function parseStringArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly string[] {
  const parsed = boundedArray(value, label, maximum).map((item, index) =>
    token(item, `${label}[${String(index)}]`));
  if (new Set(parsed).size !== parsed.length) return fail(`${label} contains duplicates`);
  return Object.freeze(parsed);
}

/** Strict parser for the body-free public CLI/client artifact. */
export function parseBeeperContactInteractionSummary(
  value: unknown,
): BeeperContactInteractionSummary {
  const source = record(value, "summary");
  exactKeys(source, [
    "schemaVersion", "format", "transform", "source", "provider", "observedAt",
    "scope", "completeness", "warnings", "privacy", "counts", "accounts",
    "interactions", "integrity",
  ], "summary");
  if (
    source.schemaVersion !== BEEPER_CONTACT_INTERACTION_SCHEMA_VERSION
    || source.format !== BEEPER_CONTACT_INTERACTION_FORMAT
  ) return fail("schema is unsupported");
  const transform = record(source.transform, "summary.transform");
  exactKeys(transform, ["id", "version", "sourceVersion"], "summary.transform");
  if (
    transform.id !== BEEPER_CONTACT_INTERACTION_TRANSFORM.id
    || transform.version !== BEEPER_CONTACT_INTERACTION_TRANSFORM.version
    || transform.sourceVersion !== BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion
  ) return fail("transform is unsupported");
  const sourceValue = record(source.source, "summary.source");
  exactKeys(sourceValue, ["id", "version"], "summary.source");
  if (
    sourceValue.id !== "beeper-local"
    || sourceValue.version !== BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion
  ) return fail("source is unsupported");
  const provider = record(source.provider, "summary.provider");
  exactKeys(provider, ["id", "version"], "summary.provider");
  if (provider.id !== "beeper") return fail("provider is unsupported");
  const providerVersion = token(provider.version, "summary.provider.version");
  const observedAt = nullableTimestamp(source.observedAt, "summary.observedAt");
  const scope = record(source.scope, "summary.scope");
  exactKeys(scope, ["conversations", "messages"], "summary.scope");
  if (
    scope.conversations !== "complete-direct-only"
    || scope.messages !== "current-direction-known-only"
  ) return fail("scope is unsupported");
  const completeness = record(source.completeness, "summary.completeness");
  exactKeys(completeness, [
    "kind", "sourceKind", "reason", "observedFrom", "observedThrough",
  ], "summary.completeness");
  if (completeness.kind !== "lower-bound") return fail("completeness kind is unsupported");
  if (
    completeness.sourceKind !== "bounded-local"
    && completeness.sourceKind !== "truncated"
    && completeness.sourceKind !== "unknown"
  ) return fail("source completeness kind is unsupported");
  const reason = completeness.reason === null
    ? null
    : token(completeness.reason, "summary.completeness.reason");
  const observedFrom = nullableTimestamp(
    completeness.observedFrom,
    "summary.completeness.observedFrom",
  );
  const observedThrough = nullableTimestamp(
    completeness.observedThrough,
    "summary.completeness.observedThrough",
  );
  if (observedFrom !== null && observedThrough !== null && observedFrom > observedThrough) {
    return fail("completeness timestamps are reversed");
  }
  const warnings = parseStringArray(source.warnings, "summary.warnings", MAX_WARNINGS);
  const privacy = record(source.privacy, "summary.privacy");
  exactKeys(privacy, [
    "messageBodies", "attachments", "reactions", "media", "groupMessages",
    "localPaths", "credentials",
  ], "summary.privacy");
  if (
    privacy.messageBodies !== "excluded"
    || privacy.attachments !== "excluded"
    || privacy.reactions !== "excluded"
    || privacy.media !== "excluded"
    || privacy.groupMessages !== "excluded"
    || privacy.localPaths !== "excluded"
    || privacy.credentials !== "excluded"
  ) return fail("privacy boundary is unsupported");
  const counts = record(source.counts, "summary.counts");
  exactKeys(counts, [
    "accounts", "directRelationships", "directConversations", "interactions",
    "sent", "received",
  ], "summary.counts");
  const parsedCounts = Object.freeze({
    accounts: integer(counts.accounts, "summary.counts.accounts"),
    directRelationships: integer(
      counts.directRelationships,
      "summary.counts.directRelationships",
    ),
    directConversations: integer(
      counts.directConversations,
      "summary.counts.directConversations",
    ),
    interactions: integer(counts.interactions, "summary.counts.interactions"),
    sent: integer(counts.sent, "summary.counts.sent"),
    received: integer(counts.received, "summary.counts.received"),
  });
  const accountValues = boundedArray(source.accounts, "summary.accounts", MAX_RECORDS);
  const accounts = Object.freeze(accountValues.map((item, index) => {
    const account = record(item, `summary.accounts[${String(index)}]`);
    exactKeys(account, [
      "accountId", "accountProviderId", "network", "selfParticipantId",
      "selfParticipantProviderId", "observedAt",
    ], `summary.accounts[${String(index)}]`);
    const accountId = coordinate(account.accountId, `summary.accounts[${String(index)}].accountId`);
    const expectedProviderId = providerId("account", accountId);
    const accountProviderId = coordinate(
      account.accountProviderId,
      `summary.accounts[${String(index)}].accountProviderId`,
    );
    if (accountProviderId !== expectedProviderId) return fail("an account provider coordinate is invalid");
    const selfParticipantId = coordinate(
      account.selfParticipantId,
      `summary.accounts[${String(index)}].selfParticipantId`,
    );
    const selfParticipantProviderId = coordinate(
      account.selfParticipantProviderId,
      `summary.accounts[${String(index)}].selfParticipantProviderId`,
    );
    if (
      selfParticipantProviderId
      !== providerId("participant", accountId, selfParticipantId)
    ) return fail("an account self provider coordinate is invalid");
    return Object.freeze({
      accountId,
      accountProviderId,
      network: token(account.network, `summary.accounts[${String(index)}].network`, MAX_NETWORK_BYTES),
      selfParticipantId,
      selfParticipantProviderId,
      observedAt: timestamp(account.observedAt, `summary.accounts[${String(index)}].observedAt`),
    });
  }));
  const accountKeys = accounts.map((account) => account.accountId);
  if (
    new Set(accountKeys).size !== accountKeys.length
    || accountKeys.some((key, index) =>
      index > 0 && compareCanonicalText(key, accountKeys[index - 1]!) <= 0)
  ) return fail("accounts are not unique and canonically ordered");
  const interactionValues = boundedArray(
    source.interactions,
    "summary.interactions",
    MAX_RECORDS,
  );
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
  const interactions = Object.freeze(interactionValues.map((item, index) => {
    const interaction = record(item, `summary.interactions[${String(index)}]`);
    exactKeys(interaction, [
      "accountId", "accountProviderId", "contactId", "contactProviderId",
      "network", "sentCount", "receivedCount", "interactionCount",
      "conversationCount", "firstInteractionAt", "lastInteractionAt",
      "reciprocal", "completeness", "provenance",
    ], `summary.interactions[${String(index)}]`);
    const accountId = coordinate(
      interaction.accountId,
      `summary.interactions[${String(index)}].accountId`,
    );
    const account = accountsById.get(accountId);
    if (account === undefined) return fail("an interaction references an unknown account");
    const accountProviderId = coordinate(
      interaction.accountProviderId,
      `summary.interactions[${String(index)}].accountProviderId`,
    );
    if (accountProviderId !== account.accountProviderId) {
      return fail("an interaction account provider coordinate is invalid");
    }
    const contactId = coordinate(
      interaction.contactId,
      `summary.interactions[${String(index)}].contactId`,
    );
    if (contactId === account.selfParticipantId) {
      return fail("an interaction contact cannot be the account self participant");
    }
    const contactProviderId = coordinate(
      interaction.contactProviderId,
      `summary.interactions[${String(index)}].contactProviderId`,
    );
    if (contactProviderId !== providerId("participant", accountId, contactId)) {
      return fail("an interaction contact provider coordinate is invalid");
    }
    const network = token(
      interaction.network,
      `summary.interactions[${String(index)}].network`,
      MAX_NETWORK_BYTES,
    );
    if (network !== account.network) return fail("an interaction changed account networks");
    const sentCount = integer(
      interaction.sentCount,
      `summary.interactions[${String(index)}].sentCount`,
    );
    const receivedCount = integer(
      interaction.receivedCount,
      `summary.interactions[${String(index)}].receivedCount`,
    );
    const interactionCount = integer(
      interaction.interactionCount,
      `summary.interactions[${String(index)}].interactionCount`,
    );
    const conversationCount = integer(
      interaction.conversationCount,
      `summary.interactions[${String(index)}].conversationCount`,
    );
    if (
      interactionCount !== sentCount + receivedCount
      || interactionCount < 1
      || conversationCount < 1
      || conversationCount > interactionCount
      || interaction.reciprocal !== (sentCount > 0 && receivedCount > 0)
      || interaction.completeness !== "lower-bound"
    ) return fail("an interaction has inconsistent counts or completeness");
    const firstInteractionAt = timestamp(
      interaction.firstInteractionAt,
      `summary.interactions[${String(index)}].firstInteractionAt`,
    );
    const lastInteractionAt = timestamp(
      interaction.lastInteractionAt,
      `summary.interactions[${String(index)}].lastInteractionAt`,
    );
    if (firstInteractionAt > lastInteractionAt) return fail("interaction timestamps are reversed");
    const provenance = record(
      interaction.provenance,
      `summary.interactions[${String(index)}].provenance`,
    );
    exactKeys(provenance, [
      "sourceId", "sourceVersion", "providerId", "providerVersion", "observedAt",
    ], `summary.interactions[${String(index)}].provenance`);
    if (
      provenance.sourceId !== "beeper-local"
      || provenance.sourceVersion !== BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion
      || provenance.providerId !== "beeper"
      || provenance.providerVersion !== providerVersion
    ) return fail("interaction provenance is unsupported");
    return Object.freeze({
      accountId,
      accountProviderId,
      contactId,
      contactProviderId,
      network,
      sentCount,
      receivedCount,
      interactionCount,
      conversationCount,
      firstInteractionAt,
      lastInteractionAt,
      reciprocal: interaction.reciprocal as boolean,
      completeness: "lower-bound" as const,
      provenance: Object.freeze({
        sourceId: "beeper-local" as const,
        sourceVersion: BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion,
        providerId: "beeper" as const,
        providerVersion,
        observedAt: timestamp(
          provenance.observedAt,
          `summary.interactions[${String(index)}].provenance.observedAt`,
        ),
      }),
    });
  }));
  const interactionKeys = interactions.map((item) => `${item.accountId}\0${item.contactId}`);
  if (
    new Set(interactionKeys).size !== interactionKeys.length
    || interactionKeys.some((key, index) =>
      index > 0 && compareCanonicalText(key, interactionKeys[index - 1]!) <= 0)
  ) return fail("interactions are not unique and canonically ordered");
  if (
    (accounts.length > 0 || interactions.length > 0)
    && (
      observedAt === null
      || accounts.some((account) => account.observedAt > observedAt)
      || interactions.some((interaction) =>
        interaction.provenance.observedAt > observedAt)
    )
  ) return fail("summary observation does not cover retained relationship facts");
  const expectedSent = interactions.reduce((sum, item) => sum + item.sentCount, 0);
  const expectedReceived = interactions.reduce((sum, item) => sum + item.receivedCount, 0);
  if (
    parsedCounts.accounts !== accounts.length
    || parsedCounts.directRelationships !== interactions.length
    || parsedCounts.interactions !== expectedSent + expectedReceived
    || parsedCounts.sent !== expectedSent
    || parsedCounts.received !== expectedReceived
    || parsedCounts.directConversations
      !== interactions.reduce((sum, item) => sum + item.conversationCount, 0)
  ) return fail("summary counts are inconsistent");
  const integrity = record(source.integrity, "summary.integrity");
  exactKeys(integrity, ["algorithm", "summarySha256"], "summary.integrity");
  if (integrity.algorithm !== "sha256") return fail("integrity algorithm is unsupported");
  const summarySha256 = digest(integrity.summarySha256, "summary.integrity.summarySha256");
  const projection = Object.freeze({
    schemaVersion: BEEPER_CONTACT_INTERACTION_SCHEMA_VERSION,
    format: BEEPER_CONTACT_INTERACTION_FORMAT,
    transform: BEEPER_CONTACT_INTERACTION_TRANSFORM,
    source: Object.freeze({
      id: "beeper-local" as const,
      version: BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion,
    }),
    provider: Object.freeze({ id: "beeper" as const, version: providerVersion }),
    observedAt,
    scope: Object.freeze({
      conversations: "complete-direct-only" as const,
      messages: "current-direction-known-only" as const,
    }),
    completeness: Object.freeze({
      kind: "lower-bound" as const,
      sourceKind: completeness.sourceKind,
      reason,
      observedFrom,
      observedThrough,
    }),
    warnings,
    privacy: Object.freeze({
      messageBodies: "excluded" as const,
      attachments: "excluded" as const,
      reactions: "excluded" as const,
      media: "excluded" as const,
      groupMessages: "excluded" as const,
      localPaths: "excluded" as const,
      credentials: "excluded" as const,
    }),
    counts: parsedCounts,
    accounts,
    interactions,
  }) satisfies Omit<BeeperContactInteractionSummary, "integrity">;
  if (sha256(canonicalJson(summaryProjection(projection))) !== summarySha256) {
    return fail("integrity digest does not bind the summary projection");
  }
  return Object.freeze({
    ...projection,
    integrity: Object.freeze({ algorithm: "sha256", summarySha256 }),
  });
}

type CreateBeeperContactInteractionExportResultRequest = Readonly<{
  runId: string;
  startedAt: string;
  finishedAt: string;
  authId: string;
  authIdentitySha256: string;
  bounds: BeeperContactInteractionExportBounds;
  output: BeeperContactInteractionSummary;
}>;

function receiptProjection(
  receipt: Omit<BeeperContactInteractionExportReceipt, "integrity">,
): Omit<BeeperContactInteractionExportReceipt, "integrity"> {
  return receipt;
}

function boundedTerminalWire(value: BeeperContactInteractionExportResult): string {
  const json = JSON.stringify(value);
  const wire = `${json.replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}\n`;
  if (Buffer.byteLength(wire, "utf8") > BEEPER_CONTACT_INTERACTION_WIRE_MAX_BYTES) {
    return fail("export result exceeded its terminal wire byte bound");
  }
  return wire;
}

/** Build and reparse the public success envelope after all private cleanup. */
export function createBeeperContactInteractionExportResult(
  request: CreateBeeperContactInteractionExportResultRequest,
): BeeperContactInteractionExportResult {
  const projection = Object.freeze({
    schemaVersion: 1 as const,
    format: BEEPER_CONTACT_INTERACTION_RECEIPT_FORMAT,
    runId: request.runId,
    operation: "beeper.export-contact-interactions" as const,
    status: "succeeded" as const,
    transport: "linked-device" as const,
    implementation: BEEPER_CONTACT_INTERACTION_IMPLEMENTATION,
    startedAt: request.startedAt,
    finishedAt: request.finishedAt,
    auth: Object.freeze({
      id: request.authId,
      kind: "linked-device-store" as const,
      provider: "beeper" as const,
      identitySha256: request.authIdentitySha256,
    }),
    bounds: Object.freeze(request.bounds),
    source: request.output.source,
    provider: request.output.provider,
    transform: request.output.transform,
    completeness: request.output.completeness,
    counts: request.output.counts,
    output: Object.freeze({
      schemaVersion: request.output.schemaVersion,
      format: request.output.format,
      summarySha256: request.output.integrity.summarySha256,
    }),
    privacy: Object.freeze({
      messageBodies: "excluded" as const,
      attachments: "excluded" as const,
      reactions: "excluded" as const,
      media: "excluded" as const,
      localPaths: "excluded" as const,
      credentials: "excluded" as const,
    }),
  }) satisfies Omit<BeeperContactInteractionExportReceipt, "integrity">;
  const receipt = Object.freeze({
    ...projection,
    integrity: Object.freeze({
      algorithm: "sha256" as const,
      receiptSha256: sha256(canonicalJson(receiptProjection(projection))),
    }),
  });
  const result = parseBeeperContactInteractionExportResult(Object.freeze({
    receipt,
    output: request.output,
  }));
  boundedTerminalWire(result);
  return result;
}

function nullableBound(
  value: unknown,
  label: string,
  maximum: number,
): number | null {
  if (value === null) return null;
  const parsed = integer(value, label);
  if (parsed < 1 || parsed > maximum) {
    return fail(`${label} is outside its supported bound`);
  }
  return parsed;
}

/** Strict parser for the public receipt plus body-free output envelope. */
export function parseBeeperContactInteractionExportResult(
  value: unknown,
): BeeperContactInteractionExportResult {
  const envelope = record(value, "export result");
  exactKeys(envelope, ["receipt", "output"], "export result");
  const output = parseBeeperContactInteractionSummary(envelope.output);
  const source = record(envelope.receipt, "export receipt");
  exactKeys(source, [
    "schemaVersion", "format", "runId", "operation", "status", "transport",
    "implementation", "startedAt", "finishedAt", "auth", "bounds", "source",
    "provider", "transform", "completeness", "counts", "output", "privacy",
    "integrity",
  ], "export receipt");
  if (
    source.schemaVersion !== 1
    || source.format !== BEEPER_CONTACT_INTERACTION_RECEIPT_FORMAT
    || source.operation !== "beeper.export-contact-interactions"
    || source.status !== "succeeded"
    || source.transport !== "linked-device"
  ) return fail("export receipt identity is unsupported");
  const implementation = record(
    source.implementation,
    "export receipt.implementation",
  );
  exactKeys(
    implementation,
    ["producer", "officialCli"],
    "export receipt.implementation",
  );
  const producer = record(
    implementation.producer,
    "export receipt.implementation.producer",
  );
  exactKeys(
    producer,
    ["package", "version"],
    "export receipt.implementation.producer",
  );
  const officialCli = record(
    implementation.officialCli,
    "export receipt.implementation.officialCli",
  );
  exactKeys(
    officialCli,
    ["implementation", "version", "commit", "platform", "binarySha256"],
    "export receipt.implementation.officialCli",
  );
  if (
    producer.package !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.producer.package
    || producer.version !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.producer.version
    || officialCli.implementation
      !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.implementation
    || officialCli.version
      !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.version
    || officialCli.commit
      !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.commit
    || officialCli.platform
      !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.platform
    || officialCli.binarySha256
      !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.binarySha256
  ) return fail("export receipt implementation identity is unsupported");
  const runId = coordinate(source.runId, "export receipt.runId");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(runId)) {
    return fail("export receipt.runId must be a lowercase UUID v4");
  }
  const startedAt = timestamp(source.startedAt, "export receipt.startedAt");
  const finishedAt = timestamp(source.finishedAt, "export receipt.finishedAt");
  if (startedAt > finishedAt) return fail("export receipt timestamps are reversed");

  const auth = record(source.auth, "export receipt.auth");
  exactKeys(auth, ["id", "kind", "provider", "identitySha256"], "export receipt.auth");
  const authId = coordinate(auth.id, "export receipt.auth.id");
  if (
    !/^[a-z][a-z0-9-]{0,127}$/u.test(authId)
    || auth.kind !== "linked-device-store"
    || auth.provider !== "beeper"
  ) return fail("export receipt auth identity is unsupported");
  const identitySha256 = digest(
    auth.identitySha256,
    "export receipt.auth.identitySha256",
  );

  const bounds = record(source.bounds, "export receipt.bounds");
  exactKeys(
    bounds,
    ["limitChats", "limitMessages", "maxParticipants"],
    "export receipt.bounds",
  );
  const parsedBounds = Object.freeze({
    limitChats: nullableBound(bounds.limitChats, "export receipt.bounds.limitChats", 100_000),
    limitMessages: nullableBound(
      bounds.limitMessages,
      "export receipt.bounds.limitMessages",
      1_000_000,
    ),
    maxParticipants: nullableBound(
      bounds.maxParticipants,
      "export receipt.bounds.maxParticipants",
      2_000,
    ),
  });

  for (const [field, expected] of [
    ["source", output.source],
    ["provider", output.provider],
    ["transform", output.transform],
    ["completeness", output.completeness],
    ["counts", output.counts],
  ] as const) {
    const parsed = record(source[field], `export receipt.${field}`);
    if (canonicalJson(parsed) !== canonicalJson(expected)) {
      return fail(`export receipt.${field} does not bind the output`);
    }
  }
  const outputBinding = record(source.output, "export receipt.output");
  exactKeys(
    outputBinding,
    ["schemaVersion", "format", "summarySha256"],
    "export receipt.output",
  );
  const summarySha256 = digest(
    outputBinding.summarySha256,
    "export receipt.output.summarySha256",
  );
  if (
    outputBinding.schemaVersion !== output.schemaVersion
    || outputBinding.format !== output.format
    || summarySha256 !== output.integrity.summarySha256
  ) return fail("export receipt output identity does not bind the summary");

  const privacy = record(source.privacy, "export receipt.privacy");
  exactKeys(privacy, [
    "messageBodies", "attachments", "reactions", "media", "localPaths",
    "credentials",
  ], "export receipt.privacy");
  if (Object.values(privacy).some((item) => item !== "excluded")) {
    return fail("export receipt privacy boundary is unsupported");
  }
  const projection = Object.freeze({
    schemaVersion: 1 as const,
    format: BEEPER_CONTACT_INTERACTION_RECEIPT_FORMAT,
    runId,
    operation: "beeper.export-contact-interactions" as const,
    status: "succeeded" as const,
    transport: "linked-device" as const,
    implementation: BEEPER_CONTACT_INTERACTION_IMPLEMENTATION,
    startedAt,
    finishedAt,
    auth: Object.freeze({
      id: authId,
      kind: "linked-device-store" as const,
      provider: "beeper" as const,
      identitySha256,
    }),
    bounds: parsedBounds,
    source: output.source,
    provider: output.provider,
    transform: output.transform,
    completeness: output.completeness,
    counts: output.counts,
    output: Object.freeze({
      schemaVersion: output.schemaVersion,
      format: output.format,
      summarySha256,
    }),
    privacy: Object.freeze({
      messageBodies: "excluded" as const,
      attachments: "excluded" as const,
      reactions: "excluded" as const,
      media: "excluded" as const,
      localPaths: "excluded" as const,
      credentials: "excluded" as const,
    }),
  }) satisfies Omit<BeeperContactInteractionExportReceipt, "integrity">;
  const integrity = record(source.integrity, "export receipt.integrity");
  exactKeys(integrity, ["algorithm", "receiptSha256"], "export receipt.integrity");
  if (integrity.algorithm !== "sha256") {
    return fail("export receipt integrity algorithm is unsupported");
  }
  const receiptSha256 = digest(
    integrity.receiptSha256,
    "export receipt.integrity.receiptSha256",
  );
  if (sha256(canonicalJson(receiptProjection(projection))) !== receiptSha256) {
    return fail("export receipt integrity does not bind its projection");
  }
  return Object.freeze({
    receipt: Object.freeze({
      ...projection,
      integrity: Object.freeze({ algorithm: "sha256", receiptSha256 }),
    }),
    output,
  });
}

/** Encode one strictly parsed result as bounded compact terminal-safe JSON. */
export function encodeBeeperContactInteractionExportResult(
  value: unknown,
): string {
  return boundedTerminalWire(parseBeeperContactInteractionExportResult(value));
}
