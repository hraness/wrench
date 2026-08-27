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

function conversationProviderId(accountId: string, conversationId: string): string {
  return `beeper:${encoded(accountId)}:chat:${encoded(conversationId)}`;
}

function messageProviderId(accountId: string, messageId: string): string {
  return `beeper:${encoded(accountId)}:message:${encoded(messageId)}`;
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

function readInput(input: OperationInput): Readonly<{
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
    conversationId: string(
      source.conversation_id,
      "messaging.read input.conversation_id",
      2_048,
    ),
    beforeCursor,
    afterCursor,
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
    conversationId: string(
      source.conversation_id,
      "conversations.read input.conversation_id",
      2_048,
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
    providerId: conversationProviderId(accountId, id),
    providerRevision: orderedAt,
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
  const sortKey = string(source.sortKey, `${path}.sortKey`, 2_048);
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
    providerId: messageProviderId(accountId, id),
    providerRevision: editedTimestamp ?? sortKey,
    orderedAt,
    conversationProviderId: conversationProviderId(accountId, conversationId),
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
    replyToProviderId: replyId === null ? null : messageProviderId(accountId, replyId),
    state,
    attachments: Object.freeze(attachments),
  });
}

function validateEnvelope(
  output: unknown,
  operation: "messaging.list" | "messaging.read",
): { readonly source: JsonRecord; readonly subject: string } {
  const source = record(output, `${operation} output`);
  if (source.provider !== "beeper" || source.operation !== operation) {
    drift(`${operation} output`, "must identify the exact Beeper operation");
  }
  if (source.projection !== "bounded-local-desktop-api") {
    drift(`${operation} output.projection`, "must be bounded-local-desktop-api");
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

export function materializeBeeperMessagingRead(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsed = readInput(input);
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
  const entities = array(source.messages, "messaging.read output.messages", parsed.limit)
    .map((item, index) => message(
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
  record(source.completeness, "messaging.read output.completeness");
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
