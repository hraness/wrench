import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";
import { OmniMaterializerDriftError } from "../omni-model";
import type {
  OmniParticipantV1,
  ProviderConversationV1,
  ProviderMaterializedPageV1,
  ProviderMessageV1,
} from "../omni-model";
import {
  IMSG_ACCOUNT_SELECTION,
  IMSG_SERVICE,
  IMSG_SMS_FALLBACK,
  IMSG_TRANSPORT,
  parseImsgDirectOperationInput,
  type ImsgChatCoordinate,
  type ImsgMessagingListInput,
  type ImsgMessagingReadInput,
} from "./imessage-direct";

type JsonRecord = Readonly<Record<string, unknown>>;

function drift(path: string, message: string): never {
  throw new OmniMaterializerDriftError("imessage", path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return drift(path, "must be a plain object");
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) drift(path, `contains unreviewed property ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) drift(`${path}.${key}`, "is required");
  }
}

function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) return drift(path, `must be an array of at most ${maximum} items`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) drift(`${path}[${index}]`, "must not be sparse");
  }
  return value;
}

function string(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum
    || value.includes("\0")
  ) return drift(path, "must be bounded text");
  return value;
}

function nullableString(value: unknown, path: string, maximum: number): string | null {
  return value === null ? null : string(value, path, maximum, true);
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  ) return drift(path, "must be a bounded integer");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return drift(path, "must be boolean");
  return value;
}

function timestamp(value: unknown, path: string): string {
  const source = string(value, path, 64);
  const milliseconds = Date.parse(source);
  if (!Number.isFinite(milliseconds)) return drift(path, "must be a timestamp");
  return new Date(milliseconds).toISOString();
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function imsgConversationProviderId(guid: string): string {
  return `imessage:chat:${encoded(guid)}`;
}

export function imsgMessageProviderId(guid: string): string {
  return `imessage:message:${encoded(guid)}`;
}

function subject(value: unknown, path: string): string {
  const source = string(value, path, 128);
  if (!/^imessage:device-default:[a-f0-9]{64}$/u.test(source)) {
    return drift(path, "must bind the device-default iMessage realm");
  }
  return source;
}

function validateEnvelope(
  output: unknown,
  operation: "messaging.list" | "messaging.read",
): Readonly<{ source: JsonRecord; accountSubject: string }> {
  const source = record(output, `${operation} output`);
  if (
    source.provider !== "imessage"
    || source.operation !== operation
    || source.accountSelection !== IMSG_ACCOUNT_SELECTION
    || source.service !== IMSG_SERVICE
    || source.transport !== IMSG_TRANSPORT
    || source.smsFallback !== IMSG_SMS_FALLBACK
    || source.projection !== "bounded-local-chat-db"
  ) return drift(`${operation} output`, "changed its reviewed transport envelope");
  return Object.freeze({
    source,
    accountSubject: subject(source.accountSubject, `${operation} output.accountSubject`),
  });
}
function participant(handle: string): OmniParticipantV1 {
  return Object.freeze({
    providerId: `imessage:handle:${encoded(handle)}`,
    displayName: null,
    handle,
  });
}

function conversation(value: unknown, path: string): ProviderConversationV1 {
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "guid",
    "service",
    "identifier",
    "title",
    "kind",
    "participants",
    "lastMessageAt",
    "unreadCount",
    "observedAccountId",
    "observedAccountLogin",
    "observedLastAddressedHandle",
  ], [], path);
  integer(source.id, `${path}.id`, 1);
  const guid = string(source.guid, `${path}.guid`, 2_048);
  if (source.service !== IMSG_SERVICE) drift(`${path}.service`, "must be iMessage");
  string(source.identifier, `${path}.identifier`, 2_048, true);
  const title = nullableString(source.title, `${path}.title`, 4_096);
  if (source.kind !== "single" && source.kind !== "group") {
    drift(`${path}.kind`, "must be single or group");
  }
  const participants = array(source.participants, `${path}.participants`, 500)
    .map((item, index) => participant(
      string(item, `${path}.participants[${index}]`, 2_048),
    ));
  const orderedAt = timestamp(source.lastMessageAt, `${path}.lastMessageAt`);
  const unreadCount = source.unreadCount === null
    ? null
    : integer(source.unreadCount, `${path}.unreadCount`);
  nullableString(source.observedAccountId, `${path}.observedAccountId`, 2_048);
  nullableString(source.observedAccountLogin, `${path}.observedAccountLogin`, 2_048);
  nullableString(
    source.observedLastAddressedHandle,
    `${path}.observedLastAddressedHandle`,
    2_048,
  );
  return Object.freeze({
    kind: "conversation",
    conversationKind: source.kind,
    providerId: imsgConversationProviderId(guid),
    providerRevision: `${source.id}:${orderedAt}`,
    orderedAt,
    detail: "full",
    title,
    summary: null,
    participants: Object.freeze(participants),
    unread: unreadCount === null ? null : unreadCount > 0,
    unreadCount,
    archived: null,
    pending: null,
  });
}

function message(value: unknown, path: string, target: ImsgChatCoordinate): ProviderMessageV1 {
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "guid",
    "chatId",
    "chatGuid",
    "sender",
    "senderName",
    "isFromMe",
    "text",
    "createdAt",
    "replyToGuid",
  ], [], path);
  integer(source.id, `${path}.id`, 1);
  const guid = string(source.guid, `${path}.guid`, 2_048);
  if (
    source.chatId !== target.observedChatRowId
    || source.chatGuid !== target.chatGuid
  ) return drift(path, "did not bind the exact requested chat");
  const senderHandle = nullableString(source.sender, `${path}.sender`, 2_048);
  const senderName = nullableString(source.senderName, `${path}.senderName`, 2_048);
  const isFromMe = boolean(source.isFromMe, `${path}.isFromMe`);
  const body = string(source.text, `${path}.text`, 4 * 1024 * 1024, true);
  const orderedAt = timestamp(source.createdAt, `${path}.createdAt`);
  const replyToGuid = nullableString(source.replyToGuid, `${path}.replyToGuid`, 2_048);
  return Object.freeze({
    kind: "message",
    providerId: imsgMessageProviderId(guid),
    providerRevision: `${source.id}:${guid}`,
    orderedAt,
    conversationProviderId: imsgConversationProviderId(target.chatGuid),
    sender: senderHandle === null && senderName === null
      ? null
      : Object.freeze({
          providerId: senderHandle === null
            ? null
            : `imessage:handle:${encoded(senderHandle)}`,
          displayName: senderName,
          handle: senderHandle,
        }),
    recipients: Object.freeze([]),
    direction: isFromMe ? "outgoing" : "incoming",
    subject: null,
    body,
    bodyTruncated: false,
    unread: null,
    replyToProviderId: replyToGuid === null
      ? null
      : imsgMessageProviderId(replyToGuid),
    state: "active",
    attachments: Object.freeze([]),
  });
}

export function materializeImsgMessagingList(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsed = parseImsgDirectOperationInput(
    "messaging.list",
    input,
  ) as ImsgMessagingListInput;
  const { source, accountSubject } = validateEnvelope(output, "messaging.list");
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "accountSelection",
    "service",
    "transport",
    "smsFallback",
    "projection",
    "conversations",
  ], [], "messaging.list output");
  const entities = array(
    source.conversations,
    "messaging.list output.conversations",
    parsed.limit,
  ).map((item, index) => conversation(
    item,
    `messaging.list output.conversations[${index}]`,
  ));
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) {
    drift("messaging.list output.conversations", "contains duplicate chat GUIDs");
  }
  return Object.freeze({
    schemaVersion: 1,
    partition: `${accountSubject}:imessage-conversations`,
    completeness: Object.freeze({
      kind: "bounded-local",
      reason: "imsg exposes a bounded recency-ordered local chat.db scan without continuation metadata.",
    }),
    cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
    entities: Object.freeze(entities),
    tombstones: Object.freeze([]),
  });
}

export function materializeImsgExactConversation(
  input: OperationInput,
  output: unknown,
): ProviderConversationV1 {
  const target = parseImsgDirectOperationInput(
    "conversations.read",
    input,
  ) as ImsgChatCoordinate;
  const source = record(output, "conversations.read output");
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "accountSelection",
    "service",
    "transport",
    "smsFallback",
    "conversation",
  ], [], "conversations.read output");
  if (
    source.provider !== "imessage"
    || source.operation !== "conversations.read"
    || source.accountSelection !== IMSG_ACCOUNT_SELECTION
    || source.service !== IMSG_SERVICE
    || source.transport !== IMSG_TRANSPORT
    || source.smsFallback !== IMSG_SMS_FALLBACK
  ) drift("conversations.read output", "changed its reviewed transport envelope");
  subject(source.accountSubject, "conversations.read output.accountSubject");
  const raw = record(source.conversation, "conversations.read output.conversation");
  if (
    raw.id !== target.observedChatRowId
    || raw.guid !== target.chatGuid
    || raw.service !== target.service
  ) drift("conversations.read output.conversation", "did not bind the exact route");
  return conversation(raw, "conversations.read output.conversation");
}

export function materializeImsgMessagingRead(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsed = parseImsgDirectOperationInput(
    "messaging.read",
    input,
  ) as ImsgMessagingReadInput;
  const { source, accountSubject } = validateEnvelope(output, "messaging.read");
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "accountSelection",
    "service",
    "transport",
    "smsFallback",
    "projection",
    "conversation",
    "messages",
  ], [], "messaging.read output");
  const rawConversation = record(
    source.conversation,
    "messaging.read output.conversation",
  );
  if (
    rawConversation.id !== parsed.observedChatRowId
    || rawConversation.guid !== parsed.chatGuid
    || rawConversation.service !== parsed.service
  ) drift("messaging.read output.conversation", "did not bind the exact route");
  conversation(rawConversation, "messaging.read output.conversation");
  const entities = array(
    source.messages,
    "messaging.read output.messages",
    parsed.limit,
  ).map((item, index) => message(
    item,
    `messaging.read output.messages[${index}]`,
    parsed,
  ));
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) {
    drift("messaging.read output.messages", "contains duplicate message GUIDs");
  }
  return Object.freeze({
    schemaVersion: 1,
    partition: `${accountSubject}:imessage-messages:${encoded(parsed.chatGuid)}`,
    completeness: Object.freeze({
      kind: "bounded-local",
      reason: "imsg returned one bounded current chat.db history window without continuation metadata.",
    }),
    cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
    entities: Object.freeze(entities),
    tombstones: Object.freeze([]),
  });
}
