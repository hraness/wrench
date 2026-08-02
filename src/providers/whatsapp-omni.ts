import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";
import { OmniMaterializerDriftError } from "../omni-model";
import type {
  OmniAttachmentV1,
  OmniParticipantV1,
  ProviderConversationV1,
  ProviderMaterializedPageV1,
  ProviderMessageV1,
} from "../omni-model";

type WhatsAppFolder = "active" | "all" | "archived" | "unread";

type ParsedWhatsAppConversation = Readonly<{
  providerId: string;
  kind: string;
  name: string | null;
  orderedAt: string;
  archived: boolean;
  pinned: boolean;
  mutedUntil: number;
  unread: boolean;
  unreadCount: number;
}>;

type ParsedWhatsAppMessage = Readonly<{
  providerId: string;
  conversationId: string;
  conversationName: string | null;
  senderId: string | null;
  senderName: string | null;
  orderedAt: string;
  fromMe: boolean;
  text: string;
  displayText: string;
  quotedMessageId: string | null;
  quotedSenderId: string | null;
  forwarded: boolean;
  forwardingScore: number;
  reactionToId: string | null;
  reactionEmoji: string | null;
  attachments: readonly OmniAttachmentV1[];
  starred: boolean;
  revoked: boolean;
  deletedForMe: boolean;
  snippet: string | null;
}>;

function drift(path: string, message: string): never {
  throw new OmniMaterializerDriftError("whatsapp", path, message);
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return drift(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return drift(path, "must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== "string") return drift(path, "must not have symbol properties");
    const descriptor = descriptors[name];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) {
      return drift(`${path}.*`, "must be an enumerable data property");
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) drift(path, "contains an unreviewed property");
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
  ) {
    return drift(path, `must be an array of at most ${maximum} items`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) drift(`${path}[${index}]`, "must not be sparse");
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) drift(`${path}[${index}]`, "must be an enumerable data property");
  }
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size || ownKeys.some((key) => !expected.has(key))) {
    drift(path, "must be a dense array without named properties");
  }
  return value;
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return true;
    }
  }
  return false;
}

function string(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximum
    || (!allowEmpty && value.length === 0)
    || hasDisallowedControl(value)
  ) return drift(path, `must be a bounded${allowEmpty ? "" : " non-empty"} string`);
  return value;
}

function nullableString(
  value: unknown,
  path: string,
  maximum: number,
): string | null {
  return value === null ? null : string(value, path, maximum);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return drift(path, "must be boolean");
  return value;
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return drift(path, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function jid(value: unknown, path: string): string {
  const result = string(value, path, 96);
  if (!(
    /^[0-9]{5,20}(?::[0-9]{1,5})?@s\.whatsapp\.net$/u.test(result)
    || /^[0-9]{5,32}(?::[0-9]{1,5})?@lid$/u.test(result)
    || /^[0-9]{5,32}(?:-[0-9]{5,20})?@g\.us$/u.test(result)
    || /^[0-9]{5,32}@newsletter$/u.test(result)
    || /^(?:status|[0-9]{5,32})@broadcast$/u.test(result)
  )) return drift(path, "must be an exact WhatsApp JID");
  return result;
}

function addressableJid(value: unknown, path: string): string {
  const result = jid(value, path);
  if (/@(?:newsletter|broadcast)$/u.test(result) || result.includes(":")) {
    return drift(path, "must identify an addressable conversation JID");
  }
  return result;
}

function nullableJid(value: unknown, path: string): string | null {
  return value === null ? null : jid(value, path);
}

function messageId(value: unknown, path: string): string {
  const result = string(value, path, 256);
  if (!/^[A-Za-z0-9._~:-]{1,256}$/u.test(result)) {
    return drift(path, "must be an exact WhatsApp message ID");
  }
  return result;
}

function nullableMessageId(value: unknown, path: string): string | null {
  return value === null ? null : messageId(value, path);
}

function accountSubject(value: unknown, path: string): string {
  const result = string(value, path, 128);
  if (!/^whatsapp:(?:pn:[0-9]{5,20}|lid:[0-9]{5,32})$/u.test(result)) {
    return drift(path, "must be an exact linked-device account subject");
  }
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result)) {
    return drift(path, "must be a UTC RFC3339 timestamp");
  }
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds)) return drift(path, "must be a valid UTC RFC3339 timestamp");
  return new Date(milliseconds).toISOString();
}

function folder(value: unknown, path: string): WhatsAppFolder {
  if (
    value !== "all"
    && value !== "active"
    && value !== "archived"
    && value !== "unread"
  ) return drift(path, "must be all, active, archived, or unread");
  return value;
}

function listInput(input: OperationInput): {
  readonly folder: WhatsAppFolder;
  readonly limit: number;
} {
  const source = record(input, "messaging.list input");
  exactKeys(source, [], ["folder", "limit"], "messaging.list input");
  return Object.freeze({
    folder: source.folder === undefined
      ? "all"
      : folder(source.folder, "messaging.list input.folder"),
    limit: source.limit === undefined
      ? 100
      : integer(source.limit, "messaging.list input.limit", 1, 100),
  });
}

function readInput(input: OperationInput): {
  readonly conversationId: string;
  readonly limit: number;
} {
  const source = record(input, "messaging.read input");
  exactKeys(source, ["conversation_jid"], ["limit"], "messaging.read input");
  return Object.freeze({
    conversationId: addressableJid(
      source.conversation_jid,
      "messaging.read input.conversation_jid",
    ),
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "messaging.read input.limit", 1, 200),
  });
}

function parseConversation(value: unknown, path: string): ParsedWhatsAppConversation {
  const source = record(value, path);
  exactKeys(source, [
    "jid",
    "kind",
    "name",
    "lastMessageAt",
    "archived",
    "pinned",
    "mutedUntil",
    "unread",
    "unreadCount",
  ], [], path);
  const unread = boolean(source.unread, `${path}.unread`);
  const unreadCount = integer(source.unreadCount, `${path}.unreadCount`, 0, 1_000_000);
  return Object.freeze({
    providerId: jid(source.jid, `${path}.jid`),
    kind: string(source.kind, `${path}.kind`, 64),
    name: nullableString(source.name, `${path}.name`, 512),
    orderedAt: timestamp(source.lastMessageAt, `${path}.lastMessageAt`),
    archived: boolean(source.archived, `${path}.archived`),
    pinned: boolean(source.pinned, `${path}.pinned`),
    mutedUntil: integer(
      source.mutedUntil,
      `${path}.mutedUntil`,
      -1,
      Number.MAX_SAFE_INTEGER,
    ),
    unread,
    unreadCount,
  });
}

function parseButtons(value: unknown, path: string): void {
  for (const [index, entry] of array(value, path, 100).entries()) {
    const itemPath = `${path}[${index}]`;
    const source = record(entry, itemPath);
    exactKeys(source, ["type", "displayText", "index"], [], itemPath);
    string(source.type, `${itemPath}.type`, 64);
    string(source.displayText, `${itemPath}.displayText`, 1_024, true);
    if (source.index !== null) integer(source.index, `${itemPath}.index`, 0, 1_000);
  }
}

function attachmentKind(value: string): OmniAttachmentV1["kind"] {
  const normalized = value.toLowerCase();
  if (normalized.includes("audio") || normalized.includes("voice")) return "audio";
  if (normalized.includes("document") || normalized.includes("file")) return "document";
  if (normalized.includes("image") || normalized.includes("photo")) return "image";
  if (normalized.includes("sticker")) return "sticker";
  if (normalized.includes("video")) return "video";
  return "unknown";
}

function parseMedia(value: unknown, path: string): readonly OmniAttachmentV1[] {
  if (value === null) return Object.freeze([]);
  const source = record(value, path);
  exactKeys(source, ["type", "caption", "filename", "mimeType", "downloaded"], [], path);
  const type = string(source.type, `${path}.type`, 64);
  nullableString(source.caption, `${path}.caption`, 100_000);
  const filename = nullableString(source.filename, `${path}.filename`, 512);
  const mimeType = nullableString(source.mimeType, `${path}.mimeType`, 255);
  boolean(source.downloaded, `${path}.downloaded`);
  return Object.freeze([Object.freeze({
    kind: attachmentKind(type),
    mimeType,
    name: filename,
    sizeBytes: null,
  })]);
}

function parseMessage(
  value: unknown,
  path: string,
  expectedConversationId: string,
): ParsedWhatsAppMessage {
  const source = record(value, path);
  exactKeys(source, [
    "chatJid",
    "chatName",
    "messageId",
    "senderJid",
    "senderName",
    "timestamp",
    "fromMe",
    "text",
    "displayText",
    "quotedMessageId",
    "quotedSenderJid",
    "buttons",
    "forwarded",
    "forwardingScore",
    "reactionToId",
    "reactionEmoji",
    "media",
    "starred",
    "revoked",
    "deletedForMe",
    "snippet",
  ], [], path);
  const conversationId = jid(source.chatJid, `${path}.chatJid`);
  if (conversationId !== expectedConversationId) {
    drift(`${path}.chatJid`, "must bind the requested conversation");
  }
  parseButtons(source.buttons, `${path}.buttons`);
  const reactionToId = nullableMessageId(source.reactionToId, `${path}.reactionToId`);
  const reactionEmoji = nullableString(source.reactionEmoji, `${path}.reactionEmoji`, 64);
  if ((reactionToId === null) !== (reactionEmoji === null)) {
    drift(`${path}.reactionEmoji`, "must be present exactly when reactionToId is present");
  }
  return Object.freeze({
    providerId: messageId(source.messageId, `${path}.messageId`),
    conversationId,
    conversationName: nullableString(source.chatName, `${path}.chatName`, 512),
    senderId: nullableJid(source.senderJid, `${path}.senderJid`),
    senderName: nullableString(source.senderName, `${path}.senderName`, 512),
    orderedAt: timestamp(source.timestamp, `${path}.timestamp`),
    fromMe: boolean(source.fromMe, `${path}.fromMe`),
    text: string(source.text, `${path}.text`, 100_000, true),
    displayText: string(source.displayText, `${path}.displayText`, 100_000, true),
    quotedMessageId: nullableMessageId(
      source.quotedMessageId,
      `${path}.quotedMessageId`,
    ),
    quotedSenderId: nullableJid(source.quotedSenderJid, `${path}.quotedSenderJid`),
    forwarded: boolean(source.forwarded, `${path}.forwarded`),
    forwardingScore: integer(
      source.forwardingScore,
      `${path}.forwardingScore`,
      0,
      1_000_000,
    ),
    reactionToId,
    reactionEmoji,
    attachments: parseMedia(source.media, `${path}.media`),
    starred: boolean(source.starred, `${path}.starred`),
    revoked: boolean(source.revoked, `${path}.revoked`),
    deletedForMe: boolean(source.deletedForMe, `${path}.deletedForMe`),
    snippet: nullableString(source.snippet, `${path}.snippet`, 4_096),
  });
}

function participant(
  providerId: string | null,
  displayName: string | null,
): OmniParticipantV1 | null {
  return providerId === null && displayName === null
    ? null
    : Object.freeze({ providerId, displayName, handle: null });
}

function materializedConversation(
  value: ParsedWhatsAppConversation,
): ProviderConversationV1 {
  const directParticipant = value.kind === "dm" || value.kind === "user"
    ? participant(value.providerId, value.name)
    : null;
  return Object.freeze({
    kind: "conversation",
    providerId: value.providerId,
    providerRevision: null,
    orderedAt: value.orderedAt,
    detail: "summary",
    title: value.name,
    summary: null,
    participants: Object.freeze(
      directParticipant === null ? [] : [directParticipant],
    ),
    unread: value.unread,
    unreadCount: value.unreadCount,
    archived: value.archived,
    pending: null,
  });
}

function messageState(value: ParsedWhatsAppMessage): ProviderMessageV1["state"] {
  if (value.revoked && value.deletedForMe) return "revoked-and-deleted-for-me";
  if (value.revoked) return "revoked";
  if (value.deletedForMe) return "deleted-for-me";
  return "active";
}

function materializedMessage(value: ParsedWhatsAppMessage): ProviderMessageV1 {
  return Object.freeze({
    kind: "message",
    providerId: value.providerId,
    providerRevision: null,
    orderedAt: value.orderedAt,
    conversationProviderId: value.conversationId,
    sender: participant(value.senderId, value.senderName),
    recipients: Object.freeze([]),
    direction: value.fromMe ? "outgoing" : "incoming",
    subject: null,
    body: value.displayText === "" ? value.text : value.displayText,
    unread: null,
    replyToProviderId: value.quotedMessageId,
    state: messageState(value),
    attachments: value.attachments,
  });
}

function parseEnvelope(output: unknown, operation: "messaging.list" | "messaging.read") {
  const source = record(output, `${operation} output`);
  if (source.projection !== "local-store") {
    drift(`${operation} output.projection`, "must be local-store");
  }
  if (source.completeness !== "bounded-current-local-projection") {
    drift(
      `${operation} output.completeness`,
      "must be bounded-current-local-projection",
    );
  }
  return {
    source,
    accountSubject: accountSubject(
      source.accountSubject,
      `${operation} output.accountSubject`,
    ),
  } as const;
}

/** Strict linked-device conversation projection with bounded-local completeness. */
export function materializeWhatsAppMessagingList(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsedInput = listInput(input);
  const { source, accountSubject: subject } = parseEnvelope(output, "messaging.list");
  exactKeys(source, [
    "accountSubject",
    "projection",
    "completeness",
    "chats",
  ], [], "messaging.list output");
  const entities = array(source.chats, "messaging.list output.chats", parsedInput.limit)
    .map((value, index) =>
      parseConversation(value, `messaging.list output.chats[${index}]`));
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) {
    drift("messaging.list output.chats", "contains duplicate stable JIDs");
  }
  const materialized = Object.freeze(entities.map(materializedConversation));
  const partition = `${subject}:conversations:${parsedInput.folder}`;
  return Object.freeze({
    schemaVersion: 1,
    partition,
    completeness: Object.freeze({
      kind: "bounded-local",
      reason: "WhatsApp exposed a bounded current projection from the local linked-device store, not a complete remote inbox.",
    }),
    cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
    entities: materialized,
    tombstones: Object.freeze([]),
  });
}

/** Strict linked-device message projection with explicit revocation/local deletion state. */
export function materializeWhatsAppMessagingRead(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsedInput = readInput(input);
  const { source, accountSubject: subject } = parseEnvelope(output, "messaging.read");
  exactKeys(source, [
    "accountSubject",
    "projection",
    "completeness",
    "conversationJid",
    "messages",
    "fullTextSearch",
  ], [], "messaging.read output");
  const conversationId = addressableJid(
    source.conversationJid,
    "messaging.read output.conversationJid",
  );
  if (conversationId !== parsedInput.conversationId) {
    drift(
      "messaging.read output.conversationJid",
      "must bind messaging.read input.conversation_jid",
    );
  }
  const entities = array(
    source.messages,
    "messaging.read output.messages",
    parsedInput.limit,
  ).map((value, index) =>
    parseMessage(
      value,
      `messaging.read output.messages[${index}]`,
      conversationId,
    ));
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) {
    drift("messaging.read output.messages", "contains duplicate stable message IDs");
  }
  boolean(source.fullTextSearch, "messaging.read output.fullTextSearch");
  const materialized = Object.freeze(entities.map(materializedMessage));
  const partition = `${subject}:messages:${conversationId}`;
  return Object.freeze({
    schemaVersion: 1,
    partition,
    completeness: Object.freeze({
      kind: "bounded-local",
      reason: "WhatsApp exposed bounded current messages from the local linked-device store, not a complete remote conversation archive.",
    }),
    cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
    entities: materialized,
    tombstones: Object.freeze([]),
  });
}
