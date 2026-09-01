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
import { isCanonicalBeeperConversationId } from "./beeper-local";

type JsonRecord = Readonly<Record<string, unknown>>;

function drift(path: string, message: string): never {
  throw new OmniMaterializerDriftError("beeper", path, message);
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

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return drift(path, "must be boolean");
  return value;
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  return value === null ? null : boolean(value, path);
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return drift(path, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function nullableInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number | null {
  return value === null ? null : integer(value, path, minimum, maximum);
}

function timestamp(value: unknown, path: string): string {
  const source = string(value, path, 64);
  const milliseconds = Date.parse(source);
  if (!Number.isFinite(milliseconds)) return drift(path, "must be a timestamp");
  return new Date(milliseconds).toISOString();
}

function nullableTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : timestamp(value, path);
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function beeperRawIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximum
    || !hasWellFormedUnicode(value)
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) throw new Error(`${label} must be one bounded Beeper identifier`);
  return value;
}

function beeperConversationId(value: unknown, label: string): string {
  const id = beeperRawIdentifier(value, label, 2_048);
  if (!isCanonicalBeeperConversationId(id)) {
    return drift(label, "must be one exact full Beeper/Matrix chat ID");
  }
  return id;
}

function beeperProviderId(
  accountIdValue: unknown,
  kind: "chat" | "message",
  rawIdValue: unknown,
): string {
  const accountId = beeperRawIdentifier(accountIdValue, "Beeper account ID", 512);
  const rawId = beeperRawIdentifier(rawIdValue, `Beeper ${kind} ID`, 2_048);
  return `beeper:${encoded(accountId)}:${kind}:${encoded(rawId)}`;
}

function rawBeeperProviderId(
  accountIdValue: unknown,
  providerIdValue: unknown,
  kind: "chat" | "message",
): string {
  const accountId = beeperRawIdentifier(accountIdValue, "Beeper account ID", 512);
  const providerId = beeperRawIdentifier(
    providerIdValue,
    `normalized Beeper ${kind} ID`,
    4_096,
  );
  const prefix = `beeper:${encoded(accountId)}:${kind}:`;
  if (!providerId.startsWith(prefix)) {
    throw new Error(`normalized Beeper ${kind} ID does not belong to the exact account`);
  }
  const source = providerId.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(source)) {
    throw new Error(`normalized Beeper ${kind} ID has a malformed encoding`);
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(source, "base64url"),
    );
  } catch {
    throw new Error(`normalized Beeper ${kind} ID is not canonical UTF-8`);
  }
  if (encoded(raw) !== source) {
    throw new Error(`normalized Beeper ${kind} ID is not canonically encoded`);
  }
  return beeperRawIdentifier(raw, `Beeper ${kind} ID`, 2_048);
}

export function normalizeBeeperConversationProviderId(
  accountId: unknown,
  conversationId: unknown,
): string {
  return beeperProviderId(
    accountId,
    "chat",
    beeperConversationId(conversationId, "Beeper conversation ID"),
  );
}

export function rawBeeperConversationId(
  accountId: unknown,
  providerId: unknown,
): string {
  return beeperConversationId(
    rawBeeperProviderId(accountId, providerId, "chat"),
    "Beeper conversation ID",
  );
}

export function normalizeBeeperMessageProviderId(
  accountId: unknown,
  messageId: unknown,
): string {
  return beeperProviderId(accountId, "message", messageId);
}

export function rawBeeperMessageId(
  accountId: unknown,
  providerId: unknown,
): string {
  return rawBeeperProviderId(accountId, providerId, "message");
}

function userProviderId(accountId: string, userId: string): string {
  return `beeper:${encoded(accountId)}:user:${encoded(userId)}`;
}

function subject(value: unknown, path: string): string {
  const source = string(value, path, 512);
  if (!/^beeper:local:[a-f0-9]{64}$/u.test(source)) {
    return drift(path, "must be a hashed bound Beeper local subject");
  }
  return source;
}

function listInput(input: OperationInput): Readonly<{ accountId: string | null; limit: number }> {
  const source = record(input, "messaging.list input");
  exactKeys(source, [], ["account_id", "limit"], "messaging.list input");
  return Object.freeze({
    accountId: source.account_id === undefined
      ? null
      : string(source.account_id, "messaging.list input.account_id", 512),
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "messaging.list input.limit", 1, 200),
  });
}

function readInputV2(input: OperationInput): Readonly<{
  accountId: string;
  conversationId: string;
  beforeCursor: string | null;
  afterCursor: string | null;
  limit: number;
}> {
  const source = record(input, "messaging.read input");
  exactKeys(
    source,
    ["account_id", "conversation_id"],
    ["before_cursor", "after_cursor", "limit"],
    "messaging.read input",
  );
  const beforeCursor = source.before_cursor === undefined
    ? null
    : string(source.before_cursor, "messaging.read input.before_cursor", 2_048);
  const afterCursor = source.after_cursor === undefined
    ? null
    : string(source.after_cursor, "messaging.read input.after_cursor", 2_048);
  if (beforeCursor !== null && afterCursor !== null) {
    drift("messaging.read input", "accepts only one cursor direction");
  }
  return Object.freeze({
    accountId: string(source.account_id, "messaging.read input.account_id", 512),
    conversationId: beeperConversationId(
      source.conversation_id,
      "messaging.read input.conversation_id",
    ),
    beforeCursor,
    afterCursor,
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "messaging.read input.limit", 1, 200),
  });
}

function readInput(input: OperationInput): Readonly<{
  accountId: string;
  conversationId: string;
  beforeCursor: string | null;
  afterCursor: string | null;
  sender: string | null;
  limit: number;
}> {
  const source = record(input, "messaging.read input");
  exactKeys(
    source,
    ["account_id", "conversation_id"],
    ["before_cursor", "after_cursor", "sender", "limit"],
    "messaging.read input",
  );
  const beforeCursor = source.before_cursor === undefined
    ? null
    : beeperRawIdentifier(
        source.before_cursor,
        "messaging.read input.before_cursor",
        2_048,
      );
  const afterCursor = source.after_cursor === undefined
    ? null
    : beeperRawIdentifier(
        source.after_cursor,
        "messaging.read input.after_cursor",
        2_048,
      );
  if (beforeCursor !== null && afterCursor !== null) {
    drift("messaging.read input", "accepts only one cursor direction");
  }
  const sender = source.sender === undefined
    ? null
    : beeperRawIdentifier(source.sender, "messaging.read input.sender", 2_048);
  if (
    sender !== null
    && sender !== "me"
    && sender !== "others"
    && sender.startsWith("-")
  ) drift("messaging.read input.sender", "must be me, others, or one bounded opaque non-flag user ID");
  return Object.freeze({
    accountId: string(source.account_id, "messaging.read input.account_id", 512),
    conversationId: beeperConversationId(
      source.conversation_id,
      "messaging.read input.conversation_id",
    ),
    beforeCursor,
    afterCursor,
    sender,
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "messaging.read input.limit", 1, 200),
  });
}

function exactConversationInput(input: OperationInput): Readonly<{
  accountId: string;
  conversationId: string;
}> {
  const source = record(input, "conversations.read input");
  exactKeys(
    source,
    ["account_id", "conversation_id"],
    ["max_participants"],
    "conversations.read input",
  );
  if (source.max_participants !== undefined) {
    integer(
      source.max_participants,
      "conversations.read input.max_participants",
      1,
      500,
    );
  }
  return Object.freeze({
    accountId: string(
      source.account_id,
      "conversations.read input.account_id",
      512,
    ),
    conversationId: beeperConversationId(
      source.conversation_id,
      "conversations.read input.conversation_id",
    ),
  });
}

function participant(value: unknown, path: string, accountId: string): OmniParticipantV1 {
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "fullName",
    "username",
    "phoneNumber",
    "email",
    "isSelf",
    "cannotMessage",
    "isAdmin",
    "isNetworkBot",
    "isPending",
  ], [], path);
  const id = string(source.id, `${path}.id`, 2_048);
  const displayName = nullableString(source.fullName, `${path}.fullName`, 2_048);
  const username = nullableString(source.username, `${path}.username`, 2_048);
  nullableString(source.phoneNumber, `${path}.phoneNumber`, 128);
  nullableString(source.email, `${path}.email`, 2_048);
  nullableBoolean(source.isSelf, `${path}.isSelf`);
  nullableBoolean(source.cannotMessage, `${path}.cannotMessage`);
  nullableBoolean(source.isAdmin, `${path}.isAdmin`);
  nullableBoolean(source.isNetworkBot, `${path}.isNetworkBot`);
  nullableBoolean(source.isPending, `${path}.isPending`);
  return Object.freeze({
    providerId: userProviderId(accountId, id),
    displayName,
    handle: username,
  });
}

function conversation(value: unknown, path: string): ProviderConversationV1 {
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "localChatId",
    "accountId",
    "network",
    "title",
    "type",
    "description",
    "descriptionObserved",
    "hasAvatar",
    "avatarObserved",
    "lastReadMessageSortKey",
    "lastActivity",
    "unreadCount",
    "unreadMentionsCount",
    "isMarkedUnread",
    "isArchived",
    "isLowPriority",
    "isMuted",
    "isPinned",
    "isReadOnly",
    "messageExpirySeconds",
    "messageExpiryObserved",
    "draft",
    "draftObserved",
    "reminder",
    "reminderObserved",
    "participants",
  ], [], path);
  const accountId = string(source.accountId, `${path}.accountId`, 512);
  const id = string(source.id, `${path}.id`, 2_048);
  nullableString(source.localChatId, `${path}.localChatId`, 2_048);
  string(source.network, `${path}.network`, 512);
  const title = string(source.title, `${path}.title`, 4_096, true);
  const type = string(source.type, `${path}.type`, 32);
  if (type !== "single" && type !== "group") drift(`${path}.type`, "must be single or group");
  const description = nullableString(source.description, `${path}.description`, 65_536);
  boolean(source.descriptionObserved, `${path}.descriptionObserved`);
  boolean(source.hasAvatar, `${path}.hasAvatar`);
  boolean(source.avatarObserved, `${path}.avatarObserved`);
  nullableString(source.lastReadMessageSortKey, `${path}.lastReadMessageSortKey`, 2_048);
  const orderedAt = nullableTimestamp(source.lastActivity, `${path}.lastActivity`);
  const unreadCount = integer(source.unreadCount, `${path}.unreadCount`, 0, 100_000_000);
  nullableInteger(source.unreadMentionsCount, `${path}.unreadMentionsCount`, 0, 100_000_000);
  const markedUnread = nullableBoolean(source.isMarkedUnread, `${path}.isMarkedUnread`);
  const archived = nullableBoolean(source.isArchived, `${path}.isArchived`);
  nullableBoolean(source.isLowPriority, `${path}.isLowPriority`);
  nullableBoolean(source.isMuted, `${path}.isMuted`);
  nullableBoolean(source.isPinned, `${path}.isPinned`);
  nullableBoolean(source.isReadOnly, `${path}.isReadOnly`);
  nullableInteger(source.messageExpirySeconds, `${path}.messageExpirySeconds`, 0, Number.MAX_SAFE_INTEGER);
  boolean(source.messageExpiryObserved, `${path}.messageExpiryObserved`);
  if (source.draft !== null) {
    const draft = record(source.draft, `${path}.draft`);
    exactKeys(draft, ["text", "attachments"], [], `${path}.draft`);
    string(draft.text, `${path}.draft.text`, 65_536, true);
    array(draft.attachments, `${path}.draft.attachments`, 32).forEach((item, index) => {
      const attachment = record(item, `${path}.draft.attachments[${index}]`);
      exactKeys(attachment, ["type", "fileName", "fileSizeBytes", "mimeType"], [], `${path}.draft.attachments[${index}]`);
      const type = string(attachment.type, `${path}.draft.attachments[${index}].type`, 32);
      if (type !== "file" && type !== "gif" && type !== "recorded_audio") {
        drift(`${path}.draft.attachments[${index}].type`, "is unsupported");
      }
      nullableString(attachment.fileName, `${path}.draft.attachments[${index}].fileName`, 4_096);
      nullableInteger(attachment.fileSizeBytes, `${path}.draft.attachments[${index}].fileSizeBytes`, 0, Number.MAX_SAFE_INTEGER);
      nullableString(attachment.mimeType, `${path}.draft.attachments[${index}].mimeType`, 512);
    });
  }
  boolean(source.draftObserved, `${path}.draftObserved`);
  if (source.reminder !== null) {
    const reminder = record(source.reminder, `${path}.reminder`);
    exactKeys(reminder, ["when", "dismissOnMessage"], [], `${path}.reminder`);
    nullableString(reminder.when, `${path}.reminder.when`, 512);
    nullableBoolean(reminder.dismissOnMessage, `${path}.reminder.dismissOnMessage`);
  }
  boolean(source.reminderObserved, `${path}.reminderObserved`);
  const participants = record(source.participants, `${path}.participants`);
  exactKeys(participants, ["items", "total", "hasMore"], [], `${path}.participants`);
  const items = array(participants.items, `${path}.participants.items`, 500)
    .map((item, index) => participant(item, `${path}.participants.items[${index}]`, accountId));
  integer(participants.total, `${path}.participants.total`, 0, 100_000_000);
  boolean(participants.hasMore, `${path}.participants.hasMore`);
  return Object.freeze({
    kind: "conversation",
    conversationKind: type,
    providerId: normalizeBeeperConversationProviderId(accountId, id),
    providerRevision: null,
    orderedAt,
    detail: "summary",
    title,
    summary: description,
    participants: Object.freeze(items),
    unread: markedUnread ?? unreadCount > 0,
    unreadCount,
    archived,
    pending: null,
  });
}

function attachment(value: unknown, path: string): OmniAttachmentV1 {
  const source = record(value, path);
  exactKeys(source, [
    "type",
    "durationSeconds",
    "fileName",
    "fileSizeBytes",
    "mimeType",
    "width",
    "height",
    "isGif",
    "isSticker",
    "isVoiceNote",
    "transcription",
  ], [], path);
  const type = string(source.type, `${path}.type`, 32);
  nullableInteger(source.width, `${path}.width`, 0, 1_000_000);
  nullableInteger(source.height, `${path}.height`, 0, 1_000_000);
  nullableBoolean(source.isGif, `${path}.isGif`);
  const isSticker = nullableBoolean(source.isSticker, `${path}.isSticker`) === true;
  nullableBoolean(source.isVoiceNote, `${path}.isVoiceNote`);
  if (source.durationSeconds !== null) {
    if (typeof source.durationSeconds !== "number" || !Number.isFinite(source.durationSeconds)) {
      drift(`${path}.durationSeconds`, "must be null or a bounded number");
    }
  }
  if (source.transcription !== null) record(source.transcription, `${path}.transcription`);
  const kind: OmniAttachmentV1["kind"] = isSticker
    ? "sticker"
    : type === "img"
      ? "image"
      : type === "video"
        ? "video"
        : type === "audio"
          ? "audio"
          : "unknown";
  return Object.freeze({
    kind,
    mimeType: nullableString(source.mimeType, `${path}.mimeType`, 512),
    name: nullableString(source.fileName, `${path}.fileName`, 4_096),
    sizeBytes: nullableInteger(
      source.fileSizeBytes,
      `${path}.fileSizeBytes`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  });
}

function message(
  value: unknown,
  path: string,
  expectedAccountId: string,
  expectedConversationId: string,
): ProviderMessageV1 {
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "accountId",
    "conversationId",
    "senderId",
    "senderName",
    "isSender",
    "sortKey",
    "timestamp",
    "editedTimestamp",
    "text",
    "type",
    "linkedMessageId",
    "mentions",
    "isDeleted",
    "isHidden",
    "isUnread",
    "seen",
    "attachments",
    "reactions",
  ], [], path);
  const accountId = string(source.accountId, `${path}.accountId`, 512);
  const conversationId = string(source.conversationId, `${path}.conversationId`, 2_048);
  if (accountId !== expectedAccountId || conversationId !== expectedConversationId) {
    drift(path, "must bind the requested account and conversation");
  }
  const id = string(source.id, `${path}.id`, 2_048);
  const senderId = string(source.senderId, `${path}.senderId`, 2_048);
  const senderName = nullableString(source.senderName, `${path}.senderName`, 2_048);
  const isSender = nullableBoolean(source.isSender, `${path}.isSender`);
  string(source.sortKey, `${path}.sortKey`, 2_048);
  const orderedAt = timestamp(source.timestamp, `${path}.timestamp`);
  const editedTimestamp = nullableTimestamp(source.editedTimestamp, `${path}.editedTimestamp`);
  const body = nullableString(source.text, `${path}.text`, 1_048_576);
  nullableString(source.type, `${path}.type`, 128);
  const replyId = nullableString(source.linkedMessageId, `${path}.linkedMessageId`, 2_048);
  if (source.mentions !== null) array(source.mentions, `${path}.mentions`, 2_000);
  const isDeleted = boolean(source.isDeleted, `${path}.isDeleted`);
  const isHidden = boolean(source.isHidden, `${path}.isHidden`);
  const unread = nullableBoolean(source.isUnread, `${path}.isUnread`);
  if (source.seen !== null && typeof source.seen === "object") record(source.seen, `${path}.seen`);
  const attachments = array(source.attachments, `${path}.attachments`, 1_000)
    .map((item, index) => attachment(item, `${path}.attachments[${index}]`));
  array(source.reactions, `${path}.reactions`, 10_000).forEach((item, index) =>
    record(item, `${path}.reactions[${index}]`));
  const state: ProviderMessageV1["state"] = isDeleted && isHidden
    ? "revoked-and-deleted-for-me"
    : isDeleted
      ? "revoked"
      : isHidden
        ? "deleted-for-me"
        : "active";
  return Object.freeze({
    kind: "message",
    providerId: normalizeBeeperMessageProviderId(accountId, id),
    providerRevision: editedTimestamp,
    orderedAt,
    conversationProviderId: normalizeBeeperConversationProviderId(accountId, conversationId),
    sender: Object.freeze({
      providerId: userProviderId(accountId, senderId),
      displayName: senderName,
      handle: null,
    }),
    recipients: Object.freeze([]),
    direction: isSender === null ? "unknown" : isSender ? "outgoing" : "incoming",
    subject: null,
    body,
    unread,
    replyToProviderId: replyId === null
      ? null
      : normalizeBeeperMessageProviderId(accountId, replyId),
    state,
    attachments: Object.freeze(attachments),
  });
}

function validateEnvelope(
  output: unknown,
  operation: "messaging.list" | "messaging.read",
  projection: "bounded-local-desktop-api" | "bounded-local-desktop-direct-iterator" =
    "bounded-local-desktop-api",
): { readonly source: JsonRecord; readonly subject: string } {
  const source = record(output, `${operation} output`);
  if (source.provider !== "beeper" || source.operation !== operation) {
    drift(`${operation} output`, "must identify the exact Beeper operation");
  }
  if (source.projection !== projection) {
    drift(`${operation} output.projection`, `must be ${projection}`);
  }
  return Object.freeze({
    source,
    subject: subject(source.accountSubject, `${operation} output.accountSubject`),
  });
}

export function materializeBeeperMessagingList(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsed = listInput(input);
  const { source, subject: accountSubject } = validateEnvelope(output, "messaging.list");
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "projection",
    "accounts",
    "requestedAccountId",
    "conversations",
    "completeness",
  ], [], "messaging.list output");
  array(source.accounts, "messaging.list output.accounts", 128);
  if (source.requestedAccountId !== parsed.accountId) {
    drift("messaging.list output.requestedAccountId", "must bind input.account_id");
  }
  const entities = array(
    source.conversations,
    "messaging.list output.conversations",
    parsed.limit,
  ).map((item, index) => conversation(item, `messaging.list output.conversations[${index}]`));
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) {
    drift("messaging.list output.conversations", "contains duplicate account-scoped IDs");
  }
  record(source.completeness, "messaging.list output.completeness");
  return Object.freeze({
    schemaVersion: 1,
    partition: `${accountSubject}:conversations:${parsed.accountId ?? "all"}`,
    completeness: Object.freeze({
      kind: "bounded-local",
      reason: "Beeper exposed a bounded local Desktop projection; CLI v0.6.2 does not expose chat-list continuation metadata.",
    }),
    cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
    entities: Object.freeze(entities),
    tombstones: Object.freeze([]),
  });
}

/** Strict projection for the provider-native exact-chat lookup used by route issuance. */
export function materializeBeeperExactConversation(
  input: OperationInput,
  output: unknown,
): ProviderConversationV1 {
  const parsed = exactConversationInput(input);
  const source = record(output, "conversations.read output");
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "conversation",
  ], [], "conversations.read output");
  if (source.provider !== "beeper" || source.operation !== "conversations.read") {
    drift(
      "conversations.read output",
      "must identify the exact Beeper conversation operation",
    );
  }
  subject(source.accountSubject, "conversations.read output.accountSubject");
  const rawConversation = record(
    source.conversation,
    "conversations.read output.conversation",
  );
  if (
    rawConversation.accountId !== parsed.accountId
    || rawConversation.id !== parsed.conversationId
  ) {
    drift(
      "conversations.read output.conversation",
      "must bind the exact requested account and conversation",
    );
  }
  return conversation(
    source.conversation,
    "conversations.read output.conversation",
  );
}

function materializeBeeperMessagingReadLegacy(
  input: OperationInput,
  output: unknown,
  cursorKind: "cli-message-id" | "provider-opaque",
): ProviderMaterializedPageV1 {
  const parsed = readInputV2(input);
  const { source, subject: accountSubject } = validateEnvelope(output, "messaging.read");
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "projection",
    "accountId",
    "conversationId",
    "requestCursor",
    "requestDirection",
    "messages",
    "tombstones",
    "continuation",
    "completeness",
  ], [], "messaging.read output");
  if (source.accountId !== parsed.accountId || source.conversationId !== parsed.conversationId) {
    drift("messaging.read output", "must bind input account and conversation");
  }
  const requestCursor = parsed.beforeCursor ?? parsed.afterCursor;
  if (source.requestCursor !== requestCursor) {
    drift("messaging.read output.requestCursor", "must bind the requested cursor");
  }
  const requestDirection = parsed.afterCursor === null ? "before" : "after";
  if (source.requestDirection !== requestDirection) {
    drift("messaging.read output.requestDirection", "must bind the requested direction");
  }
  const rawMessages = array(
    source.messages,
    "messaging.read output.messages",
    parsed.limit,
  );
  const entities = rawMessages.map((item, index) => message(
      item,
      `messaging.read output.messages[${index}]`,
      parsed.accountId,
      parsed.conversationId,
    ));
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) {
    drift("messaging.read output.messages", "contains duplicate stable message IDs");
  }
  array(source.tombstones, "messaging.read output.tombstones", parsed.limit);
  const completeness = record(source.completeness, "messaging.read output.completeness");
  if (cursorKind === "cli-message-id") {
    exactKeys(completeness, [
      "localPageComplete",
      "remoteConversationHistoryComplete",
      "limitReached",
      "warnings",
    ], [], "messaging.read output.completeness");
    const limitReached = boolean(
      completeness.limitReached,
      "messaging.read output.completeness.limitReached",
    );
    if (limitReached !== (entities.length === parsed.limit)) {
      drift(
        "messaging.read output.completeness.limitReached",
        "must match the returned page bound",
      );
    }
    if (
      boolean(
        completeness.localPageComplete,
        "messaging.read output.completeness.localPageComplete",
      ) !== !limitReached
    ) drift(
      "messaging.read output.completeness.localPageComplete",
      "must be coherent with limitReached",
    );
    if (boolean(
      completeness.remoteConversationHistoryComplete,
      "messaging.read output.completeness.remoteConversationHistoryComplete",
    )) drift(
      "messaging.read output.completeness.remoteConversationHistoryComplete",
      "must not claim remote-history completeness",
    );
    const warnings = array(
      completeness.warnings,
      "messaging.read output.completeness.warnings",
      32,
    ).map((item, index) => string(
      item,
      `messaging.read output.completeness.warnings[${index}]`,
      256,
    ));
    const continuationExpected = limitReached && requestDirection === "before";
    if ((source.continuation !== null) !== continuationExpected) {
      drift(
        "messaging.read output.continuation",
        "must exist only for a full newest-first before page",
      );
    }
    if (
      limitReached
      && requestDirection === "after"
      && !warnings.includes("beeper-cli-v0.6.2-after-window-has-no-replayable-continuation")
    ) drift(
      "messaging.read output.completeness.warnings",
      "must disclose that after pages have no replayable continuation",
    );
    const normalizedRequestCursor = requestCursor === null
      ? null
      : normalizeBeeperMessageProviderId(parsed.accountId, requestCursor);
    if (normalizedRequestCursor !== null && ids.includes(normalizedRequestCursor)) {
      drift("messaging.read output.messages", "must exclude the prior request cursor");
    }
    if (continuationExpected) {
      for (let index = 1; index < entities.length; index += 1) {
        const previous = record(
          rawMessages[index - 1],
          `messaging.read output.messages[${index - 1}]`,
        );
        const current = record(
          rawMessages[index],
          `messaging.read output.messages[${index}]`,
        );
        if (
          string(
            previous.sortKey,
            `messaging.read output.messages[${index - 1}].sortKey`,
            1_024,
          ) < string(
            current.sortKey,
            `messaging.read output.messages[${index}].sortKey`,
            1_024,
          )
        ) drift(
          "messaging.read output.messages",
          "must preserve pinned newest-first order",
        );
      }
    }
  }
  let nextInput: Readonly<Record<string, string | number>> | null = null;
  if (source.continuation !== null) {
    const continuation = record(source.continuation, "messaging.read output.continuation");
    exactKeys(
      continuation,
      ["direction", "cursor"],
      [],
      "messaging.read output.continuation",
    );
    if (continuation.direction !== requestDirection) {
      drift("messaging.read output.continuation.direction", "must preserve direction");
    }
    const cursor = string(
      continuation.cursor,
      "messaging.read output.continuation.cursor",
      2_048,
    );
    if (cursor === requestCursor) {
      drift("messaging.read output.continuation.cursor", "must advance");
    }
    if (
      cursorKind === "cli-message-id"
      && normalizeBeeperMessageProviderId(parsed.accountId, cursor)
        !== ids[ids.length - 1]
    ) drift(
      "messaging.read output.continuation.cursor",
      "must equal the terminal returned message ID",
    );
    nextInput = Object.freeze({
      account_id: parsed.accountId,
      conversation_id: parsed.conversationId,
      limit: parsed.limit,
      ...(requestDirection === "before"
        ? { before_cursor: cursor }
        : { after_cursor: cursor }),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    partition: `${accountSubject}:messages:${encoded(parsed.accountId)}:${encoded(parsed.conversationId)}`,
    completeness: Object.freeze({
      kind: "bounded-local",
      reason: "Beeper exposed one bounded local message page; connected-account backfill and older edit, reaction, and deletion coverage may be incomplete.",
    }),
    cursor: Object.freeze({
      direction: requestDirection === "before" ? "backward" : "forward",
      request: requestCursor,
      nextInput,
    }),
    entities: Object.freeze(entities),
    tombstones: Object.freeze([]),
  });
}

export function materializeBeeperMessagingReadV1(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  return materializeBeeperMessagingReadLegacy(input, output, "cli-message-id");
}

export function materializeBeeperMessagingReadV2(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  return materializeBeeperMessagingReadLegacy(input, output, "provider-opaque");
}

export function materializeBeeperMessagingRead(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsed = readInput(input);
  const { source, subject: accountSubject } = validateEnvelope(
    output,
    "messaging.read",
    "bounded-local-desktop-direct-iterator",
  );
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "projection",
    "accountId",
    "conversationId",
    "selfUserId",
    "requestCursor",
    "requestDirection",
    "requestedSender",
    "messages",
    "tombstones",
    "continuation",
    "completeness",
  ], [], "messaging.read output");
  if (source.accountId !== parsed.accountId || source.conversationId !== parsed.conversationId) {
    drift("messaging.read output", "must bind input account and conversation");
  }
  const selfUserId = beeperRawIdentifier(
    source.selfUserId,
    "messaging.read output.selfUserId",
    2_048,
  );
  const requestCursor = parsed.beforeCursor ?? parsed.afterCursor;
  if (source.requestCursor !== requestCursor) {
    drift("messaging.read output.requestCursor", "must bind the requested cursor");
  }
  const requestDirection = parsed.afterCursor === null ? "before" : "after";
  if (source.requestDirection !== requestDirection) {
    drift("messaging.read output.requestDirection", "must bind the requested direction");
  }
  if (source.requestedSender !== parsed.sender) {
    drift("messaging.read output.requestedSender", "must bind the requested sender");
  }
  if (source.projection !== "bounded-local-desktop-direct-iterator") {
    drift("messaging.read output.projection", "must bind direct iterator contract v3");
  }
  const rawMessages = array(source.messages, "messaging.read output.messages", parsed.limit);
  const entities = rawMessages.map((item, index) => message(
      item,
      `messaging.read output.messages[${index}]`,
      parsed.accountId,
      parsed.conversationId,
    ));
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) {
    drift("messaging.read output.messages", "contains duplicate stable message IDs");
  }
  rawMessages.forEach((item, index) => {
    const rawMessage = record(item, `messaging.read output.messages[${index}]`);
    const senderId = beeperRawIdentifier(
      rawMessage.senderId,
      `messaging.read output.messages[${index}].senderId`,
      2_048,
    );
    const isSender = nullableBoolean(
      rawMessage.isSender,
      `messaging.read output.messages[${index}].isSender`,
    );
    if (
      isSender !== null
      && isSender !== (senderId === selfUserId)
    ) drift(
      "messaging.read output.messages",
      "must bind direction to the exact self user ID",
    );
    if (parsed.sender !== null) {
      if (
        parsed.sender === "me"
          ? isSender !== true
          : parsed.sender === "others"
            ? isSender !== false
            : senderId !== parsed.sender
      ) drift("messaging.read output.messages", "must satisfy the exact requested sender");
    }
  });
  array(source.tombstones, "messaging.read output.tombstones", parsed.limit);
  const completeness = record(source.completeness, "messaging.read output.completeness");
  exactKeys(completeness, [
    "localPageComplete",
    "remoteConversationHistoryComplete",
    "limitReached",
    "warnings",
  ], [], "messaging.read output.completeness");
  const limitReached = boolean(
    completeness.limitReached,
    "messaging.read output.completeness.limitReached",
  );
  if (limitReached !== (entities.length === parsed.limit)) {
    drift("messaging.read output.completeness.limitReached", "must match the returned page bound");
  }
  const localPageComplete = boolean(
    completeness.localPageComplete,
    "messaging.read output.completeness.localPageComplete",
  );
  if (boolean(
    completeness.remoteConversationHistoryComplete,
    "messaging.read output.completeness.remoteConversationHistoryComplete",
  )) drift(
    "messaging.read output.completeness.remoteConversationHistoryComplete",
    "must not claim remote-history completeness",
  );
  const warnings = array(
    completeness.warnings,
    "messaging.read output.completeness.warnings",
    32,
  ).map((item, index) => string(
    item,
    `messaging.read output.completeness.warnings[${index}]`,
    256,
  ));
  if (new Set(warnings).size !== warnings.length) {
    drift("messaging.read output.completeness.warnings", "must not repeat evidence");
  }
  for (const required of [
    "continuation-is-an-opaque-provider-page-boundary-cursor",
    "sender-filtering-is-local-to-the-bounded-direct-iterator",
  ]) {
    if (!warnings.includes(required)) {
      drift("messaging.read output.completeness.warnings", `must retain ${required}`);
    }
  }
  if ((source.continuation !== null) === localPageComplete) {
    drift(
      "messaging.read output.continuation",
      "must exist exactly when the bounded direct iterator has more local history",
    );
  }
  for (let index = 1; index < rawMessages.length; index += 1) {
    const previous = record(rawMessages[index - 1], `messaging.read output.messages[${index - 1}]`);
    const current = record(rawMessages[index], `messaging.read output.messages[${index}]`);
    const previousSortKey = string(
      previous.sortKey,
      `messaging.read output.messages[${index - 1}].sortKey`,
      1_024,
    );
    const currentSortKey = string(
      current.sortKey,
      `messaging.read output.messages[${index}].sortKey`,
      1_024,
    );
    if (
      requestDirection === "before"
        ? previousSortKey < currentSortKey
        : previousSortKey > currentSortKey
    ) drift("messaging.read output.messages", "must preserve the requested deterministic order");
  }
  let nextInput: Readonly<Record<string, string | number>> | null = null;
  if (source.continuation !== null) {
    const continuation = record(source.continuation, "messaging.read output.continuation");
    exactKeys(
      continuation,
      ["direction", "cursor"],
      [],
      "messaging.read output.continuation",
    );
    if (continuation.direction !== requestDirection) {
      drift("messaging.read output.continuation.direction", "must preserve direction");
    }
    const cursor = beeperRawIdentifier(
      continuation.cursor,
      "messaging.read output.continuation.cursor",
      2_048,
    );
    if (cursor === requestCursor) {
      drift("messaging.read output.continuation.cursor", "must advance");
    }
    nextInput = Object.freeze({
      account_id: parsed.accountId,
      conversation_id: parsed.conversationId,
      limit: parsed.limit,
      ...(parsed.sender === null ? {} : { sender: parsed.sender }),
      ...(requestDirection === "before"
        ? { before_cursor: cursor }
        : { after_cursor: cursor }),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    partition: `${accountSubject}:messages:${encoded(parsed.accountId)}:${encoded(parsed.conversationId)}`,
    completeness: Object.freeze({
      kind: "bounded-local",
      reason: "Beeper exposed one bounded local message page; connected-account backfill and older edit, reaction, and deletion coverage may be incomplete.",
    }),
    cursor: Object.freeze({
      direction: requestDirection === "before" ? "backward" : "forward",
      request: requestCursor,
      nextInput,
    }),
    entities: Object.freeze(entities),
    tombstones: Object.freeze([]),
  });
}
