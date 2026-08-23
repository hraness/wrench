import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { types as nodeTypes } from "node:util";

import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import { OperationDeadline } from "../operation-deadline";
import { wrenchStateHome } from "../storage";
import type {
  WebSessionCleanupBarrierRegistrar,
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import { startWebSessionCleanupTrackedOperation } from "../web-session-execution";
import {
  BEEPER_CLI_PIN,
  BEEPER_DESKTOP_TARGET,
  BEEPER_LOCAL_OPERATIONS,
  BEEPER_ORIGIN,
  isBeeperLocalOperation,
  parseBeeperOperationInput,
  planBeeperAccountsListCommand,
  planBeeperReadCommand,
  type BeeperLocalOperationName,
  type BeeperMessagingReadInput,
  type BeeperOperationInput,
  type BeeperReadCommand,
} from "./beeper-local";
import { projectContactDirectionStats } from "./contact-projection";

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ACCOUNTS = 128;
const MAX_USERS = 200;
const MAX_CHATS = 200;
const MAX_MESSAGES = 200;
const MAX_TEXT_BYTES = 1_048_576;
const OPERATION_LABEL = "Beeper local read operation";
const SUBJECT_PROBE_TIMEOUT_MS = 120_000;

type BeeperAuth = Extract<WrenchAuth, { readonly kind: "linked-device-store" }>;
type JsonRecord = Readonly<Record<string, unknown>>;

export type BeeperCliInvocation = Readonly<{
  binary: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}>;

export type BeeperCliInvocationResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type BeeperLocalRuntimeDependencies = Readonly<{
  /** Test-only absolute binary seam. Production always resolves the exact pin. */
  binaryPath?: string;
  run?: (invocation: BeeperCliInvocation) => Promise<BeeperCliInvocationResult>;
  createCacheDirectory?: () => Promise<string>;
  removeCacheDirectory?: (path: string) => Promise<void>;
}>;

export type BeeperUserProjection = Readonly<{
  id: string;
  fullName: string | null;
  username: string | null;
  phoneNumber: string | null;
  email: string | null;
  isSelf: boolean | null;
  cannotMessage: boolean | null;
}>;

export type BeeperAccountProjection = Readonly<{
  accountId: string;
  /** Pinned CLI resolver fields, intentionally non-enumerable in runtime output. */
  selectorAliases: Readonly<{
    displayName: string | null;
    name: string | null;
  }>;
  bridge: Readonly<{
    id: string;
    type: string;
    provider: "cloud" | "self-hosted" | "local" | "platform-sdk";
  }>;
  network: string | null;
  loginId: string | null;
  status: string;
  statusText: string | null;
  user: BeeperUserProjection;
}>;

export type BeeperParticipantProjection = BeeperUserProjection & Readonly<{
  isAdmin: boolean | null;
  isNetworkBot: boolean | null;
  isPending: boolean | null;
}>;

export type BeeperConversationProjection = Readonly<{
  id: string;
  localChatId: string | null;
  accountId: string;
  network: string;
  title: string;
  type: "single" | "group";
  description: string | null;
  lastActivity: string | null;
  unreadCount: number;
  unreadMentionsCount: number | null;
  isMarkedUnread: boolean | null;
  isArchived: boolean | null;
  isLowPriority: boolean | null;
  isMuted: boolean | null;
  isPinned: boolean | null;
  isReadOnly: boolean | null;
  messageExpirySeconds: number | null;
  participants: Readonly<{
    items: readonly BeeperParticipantProjection[];
    total: number;
    hasMore: boolean;
  }>;
}>;

export type BeeperAttachmentProjection = Readonly<{
  type: "unknown" | "img" | "video" | "audio";
  durationSeconds: number | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  isGif: boolean | null;
  isSticker: boolean | null;
  isVoiceNote: boolean | null;
  transcription: Readonly<{
    engine: string;
    text: string;
    language: string | null;
  }> | null;
}>;

export type BeeperReactionProjection = Readonly<{
  id: string;
  participantId: string;
  reactionKey: string;
  emoji: boolean | null;
  providerIdNonUnique: boolean;
}>;

export type BeeperMessageProjection = Readonly<{
  id: string;
  accountId: string;
  conversationId: string;
  senderId: string;
  senderName: string | null;
  isSender: boolean;
  sortKey: string;
  timestamp: string;
  editedTimestamp: string | null;
  text: string | null;
  type: string | null;
  linkedMessageId: string | null;
  mentions: readonly string[] | null;
  isDeleted: boolean;
  isHidden: boolean;
  isUnread: boolean | null;
  seen: boolean | string | Readonly<Record<string, boolean | string>> | null;
  attachments: readonly BeeperAttachmentProjection[];
  reactions: readonly BeeperReactionProjection[];
}>;

export type BeeperTombstoneProjection = Readonly<{
  accountId: string;
  conversationId: string;
  messageId: string;
  state: "deleted" | "hidden" | "deleted-and-hidden";
  observedAt: string;
}>;

function strictRecord(value: unknown, label: string): JsonRecord {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error(`${label} must not contain symbols`);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) throw new Error(`${label}.${key} must be an enumerable data property`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unreviewed property ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
}

function strictArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) throw new Error(`${label} must be an array of at most ${maximum} items`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${label} must not be sparse`);
  }
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\0]/u.test(value)
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

function nullableString(value: unknown, label: string, maximum: number): string | null {
  return value === undefined || value === null
    ? null
    : boundedString(value, label, maximum, true);
}

function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  return value === undefined || value === null
    ? null
    : integer(value, label, minimum, maximum);
}

function finiteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) throw new Error(`${label} must be a bounded number`);
  return value;
}

function optionalFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  return value === undefined || value === null
    ? null
    : finiteNumber(value, label, minimum, maximum);
}

function timestamp(value: unknown, label: string): string {
  const source = boundedString(value, label, 64);
  const milliseconds = Date.parse(source);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a timestamp`);
  return new Date(milliseconds).toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : timestamp(value, label);
}

function parseUser(value: unknown, label: string): BeeperUserProjection {
  const source = strictRecord(value, label);
  exactKeys(source, ["id"], [
    "cannotMessage",
    "displayName",
    "displayText",
    "email",
    "fullName",
    "imgURL",
    "isSelf",
    "name",
    "phoneNumber",
    "username",
  ], label);
  // imgURL is intentionally validated only as a nullable bounded string and then
  // omitted so no local path, media URL, or expiring credential leaves the runtime.
  nullableString(source.imgURL, `${label}.imgURL`, 16_384);
  nullableString(source.displayText, `${label}.displayText`, 2_048);
  return Object.freeze({
    id: boundedString(source.id, `${label}.id`, 2_048),
    fullName: nullableString(source.fullName, `${label}.fullName`, 2_048),
    username: nullableString(source.username, `${label}.username`, 2_048),
    phoneNumber: nullableString(source.phoneNumber, `${label}.phoneNumber`, 128),
    email: nullableString(source.email, `${label}.email`, 2_048),
    isSelf: optionalBoolean(source.isSelf, `${label}.isSelf`),
    cannotMessage: optionalBoolean(source.cannotMessage, `${label}.cannotMessage`),
  });
}

function parseAccount(value: unknown, label: string): BeeperAccountProjection {
  const source = strictRecord(value, label);
  exactKeys(source, ["accountID", "bridge", "status", "user"], [
    "capabilities",
    "default",
    "loginID",
    "network",
    "statusText",
  ], label);
  if (source.capabilities !== undefined) strictRecord(source.capabilities, `${label}.capabilities`);
  optionalBoolean(source.default, `${label}.default`);
  const bridge = strictRecord(source.bridge, `${label}.bridge`);
  exactKeys(bridge, ["id", "provider", "type"], [], `${label}.bridge`);
  const provider = boundedString(bridge.provider, `${label}.bridge.provider`, 64);
  if (
    provider !== "cloud"
    && provider !== "self-hosted"
    && provider !== "local"
    && provider !== "platform-sdk"
  ) throw new Error(`${label}.bridge.provider is unsupported`);
  const userSource = strictRecord(source.user, `${label}.user`);
  const projection: BeeperAccountProjection = {
    accountId: boundedString(source.accountID, `${label}.accountID`, 512),
    selectorAliases: Object.freeze({
      displayName: nullableString(
        userSource.displayName,
        `${label}.user.displayName`,
        2_048,
      ),
      name: nullableString(userSource.name, `${label}.user.name`, 2_048),
    }),
    bridge: Object.freeze({
      id: boundedString(bridge.id, `${label}.bridge.id`, 512),
      type: boundedString(bridge.type, `${label}.bridge.type`, 512),
      provider,
    }),
    network: nullableString(source.network, `${label}.network`, 512),
    loginId: nullableString(source.loginID, `${label}.loginID`, 512),
    status: boundedString(source.status, `${label}.status`, 128),
    statusText: nullableString(source.statusText, `${label}.statusText`, 2_048),
    user: parseUser(source.user, `${label}.user`),
  };
  Object.defineProperty(projection, "selectorAliases", { enumerable: false });
  return Object.freeze(projection);
}

function parseAccounts(value: unknown): readonly BeeperAccountProjection[] {
  const accounts = strictArray(value, "Beeper accounts", MAX_ACCOUNTS)
    .map((item, index) => parseAccount(item, `Beeper accounts[${index}]`));
  const ids = accounts.map((account) => account.accountId);
  if (new Set(ids).size !== ids.length) throw new Error("Beeper accounts repeat an account ID");
  return Object.freeze(accounts);
}

export function parseBeeperExportAccounts(
  value: unknown,
): readonly BeeperAccountProjection[] {
  return parseAccounts(value);
}

export function beeperSubjectFromAccounts(
  accounts: readonly BeeperAccountProjection[],
): string {
  const candidates = accounts.filter((account) =>
    account.user.isSelf === true
    && (
      account.bridge.type.toLowerCase() === "matrix"
      || account.network?.toLowerCase() === "beeper"
    ));
  if (candidates.length !== 1) {
    throw new Error("Beeper local projection did not expose one stable self Matrix identity");
  }
  const account = candidates[0]!;
  const digest = createHash("sha256")
    .update(account.accountId, "utf8")
    .update("\0", "utf8")
    .update(account.user.id, "utf8")
    .digest("hex");
  return `beeper:local:${digest}`;
}

function parseParticipant(value: unknown, label: string): BeeperParticipantProjection {
  const source = strictRecord(value, label);
  exactKeys(source, ["id"], [
    "cannotMessage",
    "displayText",
    "email",
    "fullName",
    "imgURL",
    "isSelf",
    "phoneNumber",
    "username",
    "isAdmin",
    "isNetworkBot",
    "isPending",
  ], label);
  const user = parseUser(
    Object.freeze(Object.fromEntries(Object.entries(source).filter(([key]) =>
      key !== "isAdmin" && key !== "isNetworkBot" && key !== "isPending"))),
    label,
  );
  return Object.freeze({
    ...user,
    isAdmin: optionalBoolean(source.isAdmin, `${label}.isAdmin`),
    isNetworkBot: optionalBoolean(source.isNetworkBot, `${label}.isNetworkBot`),
    isPending: optionalBoolean(source.isPending, `${label}.isPending`),
  });
}

function parseConversation(
  value: unknown,
  label: string,
  accountIds: ReadonlySet<string>,
  expectedAccountId: string | null,
): BeeperConversationProjection {
  const source = strictRecord(value, label);
  exactKeys(source, [
    "id",
    "accountID",
    "network",
    "participants",
    "title",
    "type",
    "unreadCount",
  ], [
    "capabilities",
    "description",
    "draft",
    "imgURL",
    "isArchived",
    "isLowPriority",
    "isMarkedUnread",
    "isMuted",
    "isPinned",
    "isReadOnly",
    "lastActivity",
    "lastReadMessageSortKey",
    "localChatID",
    "messageExpirySeconds",
    "preview",
    "reminder",
    "snooze",
    "unreadMentionsCount",
  ], label);
  const accountId = boundedString(source.accountID, `${label}.accountID`, 512);
  if (!accountIds.has(accountId) || (expectedAccountId !== null && accountId !== expectedAccountId)) {
    throw new Error(`${label}.accountID did not bind the requested account realm`);
  }
  if (source.capabilities !== undefined) strictRecord(source.capabilities, `${label}.capabilities`);
  if (source.draft !== undefined && source.draft !== null) strictRecord(source.draft, `${label}.draft`);
  nullableString(source.imgURL, `${label}.imgURL`, 16_384);
  nullableString(source.lastReadMessageSortKey, `${label}.lastReadMessageSortKey`, 2_048);
  if (source.preview !== undefined) strictRecord(source.preview, `${label}.preview`);
  if (source.reminder !== undefined && source.reminder !== null) strictRecord(source.reminder, `${label}.reminder`);
  if (source.snooze !== undefined && source.snooze !== null) strictRecord(source.snooze, `${label}.snooze`);
  const type = boundedString(source.type, `${label}.type`, 32);
  if (type !== "single" && type !== "group") throw new Error(`${label}.type is unsupported`);
  const participants = strictRecord(source.participants, `${label}.participants`);
  exactKeys(participants, ["hasMore", "items", "total"], [], `${label}.participants`);
  const participantItems = strictArray(
    participants.items,
    `${label}.participants.items`,
    2_000,
  ).map((item, index) =>
    parseParticipant(item, `${label}.participants.items[${index}]`));
  return Object.freeze({
    id: boundedString(source.id, `${label}.id`, 2_048),
    localChatId: nullableString(source.localChatID, `${label}.localChatID`, 2_048),
    accountId,
    network: boundedString(source.network, `${label}.network`, 512),
    title: boundedString(source.title, `${label}.title`, 4_096, true),
    type,
    description: nullableString(source.description, `${label}.description`, 65_536),
    lastActivity: optionalTimestamp(source.lastActivity, `${label}.lastActivity`),
    unreadCount: integer(source.unreadCount, `${label}.unreadCount`, 0, 100_000_000),
    unreadMentionsCount: optionalInteger(
      source.unreadMentionsCount,
      `${label}.unreadMentionsCount`,
      0,
      100_000_000,
    ),
    isMarkedUnread: optionalBoolean(source.isMarkedUnread, `${label}.isMarkedUnread`),
    isArchived: optionalBoolean(source.isArchived, `${label}.isArchived`),
    isLowPriority: optionalBoolean(source.isLowPriority, `${label}.isLowPriority`),
    isMuted: optionalBoolean(source.isMuted, `${label}.isMuted`),
    isPinned: optionalBoolean(source.isPinned, `${label}.isPinned`),
    isReadOnly: optionalBoolean(source.isReadOnly, `${label}.isReadOnly`),
    messageExpirySeconds: optionalInteger(
      source.messageExpirySeconds,
      `${label}.messageExpirySeconds`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    participants: Object.freeze({
      items: Object.freeze(participantItems),
      total: integer(participants.total, `${label}.participants.total`, 0, 100_000_000),
      hasMore: requiredBoolean(participants.hasMore, `${label}.participants.hasMore`),
    }),
  });
}

export function parseBeeperExportConversation(
  value: unknown,
  accounts: readonly BeeperAccountProjection[],
): BeeperConversationProjection {
  return parseConversation(
    value,
    "Beeper export chat",
    new Set(accounts.map((account) => account.accountId)),
    null,
  );
}

function parseAttachment(value: unknown, label: string): BeeperAttachmentProjection {
  const source = strictRecord(value, label);
  exactKeys(source, ["type"], [
    "duration",
    "fileName",
    "fileSize",
    "id",
    "isGif",
    "isSticker",
    "isVoiceNote",
    "mimeType",
    "posterImg",
    "size",
    "srcURL",
    "transcription",
  ], label);
  const type = boundedString(source.type, `${label}.type`, 32);
  if (type !== "unknown" && type !== "img" && type !== "video" && type !== "audio") {
    throw new Error(`${label}.type is unsupported`);
  }
  // Validate but never project provider IDs, local paths, or media URLs.
  nullableString(source.id, `${label}.id`, 16_384);
  nullableString(source.posterImg, `${label}.posterImg`, 16_384);
  nullableString(source.srcURL, `${label}.srcURL`, 16_384);
  let width: number | null = null;
  let height: number | null = null;
  if (source.size !== undefined && source.size !== null) {
    const size = strictRecord(source.size, `${label}.size`);
    exactKeys(size, [], ["height", "width"], `${label}.size`);
    width = optionalInteger(size.width, `${label}.size.width`, 0, 1_000_000);
    height = optionalInteger(size.height, `${label}.size.height`, 0, 1_000_000);
  }
  let transcription: BeeperAttachmentProjection["transcription"] = null;
  if (source.transcription !== undefined && source.transcription !== null) {
    const value = strictRecord(source.transcription, `${label}.transcription`);
    exactKeys(value, ["engine", "transcription"], ["language"], `${label}.transcription`);
    transcription = Object.freeze({
      engine: boundedString(value.engine, `${label}.transcription.engine`, 512),
      text: boundedString(
        value.transcription,
        `${label}.transcription.transcription`,
        MAX_TEXT_BYTES,
        true,
      ),
      language: nullableString(value.language, `${label}.transcription.language`, 128),
    });
  }
  return Object.freeze({
    type,
    durationSeconds: optionalFiniteNumber(source.duration, `${label}.duration`, 0, 31_536_000),
    fileName: nullableString(source.fileName, `${label}.fileName`, 4_096),
    fileSizeBytes: optionalInteger(source.fileSize, `${label}.fileSize`, 0, Number.MAX_SAFE_INTEGER),
    mimeType: nullableString(source.mimeType, `${label}.mimeType`, 256),
    width,
    height,
    isGif: optionalBoolean(source.isGif, `${label}.isGif`),
    isSticker: optionalBoolean(source.isSticker, `${label}.isSticker`),
    isVoiceNote: optionalBoolean(source.isVoiceNote, `${label}.isVoiceNote`),
    transcription,
  });
}

function parseReaction(value: unknown, label: string): BeeperReactionProjection {
  const source = strictRecord(value, label);
  exactKeys(source, ["id", "participantID", "reactionKey"], ["emoji", "imgURL"], label);
  nullableString(source.imgURL, `${label}.imgURL`, 16_384);
  return Object.freeze({
    id: boundedString(source.id, `${label}.id`, 2_048),
    participantId: boundedString(source.participantID, `${label}.participantID`, 2_048),
    reactionKey: boundedString(source.reactionKey, `${label}.reactionKey`, 2_048, true),
    emoji: optionalBoolean(source.emoji, `${label}.emoji`),
    providerIdNonUnique: false,
  });
}

function parseReactions(value: unknown, label: string): readonly BeeperReactionProjection[] {
  const parsed = strictArray(value, label, 10_000)
    .map((item, index) => parseReaction(item, `${label}[${index}]`));
  const byId = new Map<string, {
    readonly indexes: number[];
    readonly tuplesByParticipant: Map<string, Map<string, number>>;
  }>();
  const result: BeeperReactionProjection[] = [];
  for (const reaction of parsed) {
    let group = byId.get(reaction.id);
    if (group === undefined) {
      group = {
        indexes: [],
        tuplesByParticipant: new Map(),
      };
      byId.set(reaction.id, group);
    }
    let byReactionKey = group.tuplesByParticipant.get(reaction.participantId);
    if (byReactionKey === undefined) {
      byReactionKey = new Map();
      group.tuplesByParticipant.set(reaction.participantId, byReactionKey);
    }
    if (byReactionKey.has(reaction.reactionKey)) continue;
    const index = result.length;
    byReactionKey.set(reaction.reactionKey, index);
    group.indexes.push(index);
    result.push(reaction);
  }
  for (const group of byId.values()) {
    if (group.indexes.length < 2) continue;
    for (const index of group.indexes) {
      const reaction = result[index];
      if (reaction === undefined) throw new Error("Beeper reaction projection disappeared");
      result[index] = Object.freeze({
        ...reaction,
        providerIdNonUnique: true,
      });
    }
  }
  return Object.freeze(result);
}

function parseSeen(
  value: unknown,
  label: string,
): BeeperMessageProjection["seen"] {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return boundedString(value, label, 2_048, true);
  const source = strictRecord(value, label);
  if (Object.keys(source).length > 2_000) throw new Error(`${label} contains too many entries`);
  const result: Record<string, boolean | string> = Object.create(null) as Record<string, boolean | string>;
  for (const [key, item] of Object.entries(source)) {
    const safeKey = boundedString(key, `${label} key`, 2_048);
    result[safeKey] = typeof item === "boolean"
      ? item
      : boundedString(item, `${label}.${safeKey}`, 2_048, true);
  }
  return Object.freeze(result);
}

function parseMessage(
  value: unknown,
  label: string,
  expected: BeeperMessagingReadInput,
): BeeperMessageProjection {
  const source = strictRecord(value, label);
  exactKeys(source, [
    "id",
    "accountID",
    "chatID",
    "senderID",
    "isSender",
    "sortKey",
    "timestamp",
  ], [
    "attachments",
    "editedTimestamp",
    "isDeleted",
    "isHidden",
    "isUnread",
    "linkedMessageID",
    "links",
    "mentions",
    "reactions",
    "seen",
    "senderName",
    "sendStatus",
    "text",
    "type",
  ], label);
  const accountId = boundedString(source.accountID, `${label}.accountID`, 512);
  const conversationId = boundedString(source.chatID, `${label}.chatID`, 2_048);
  if (accountId !== expected.accountId || conversationId !== expected.conversationId) {
    throw new Error(`${label} did not bind the requested account and conversation`);
  }
  if (source.links !== undefined) {
    for (const [index, item] of strictArray(source.links, `${label}.links`, 1_000).entries()) {
      const link = strictRecord(item, `${label}.links[${index}]`);
      exactKeys(link, ["title", "url"], [
        "favicon",
        "img",
        "imgSize",
        "originalURL",
        "summary",
      ], `${label}.links[${index}]`);
      boundedString(link.title, `${label}.links[${index}].title`, 8_192, true);
      boundedString(link.url, `${label}.links[${index}].url`, 16_384);
      nullableString(link.favicon, `${label}.links[${index}].favicon`, 16_384);
      nullableString(link.img, `${label}.links[${index}].img`, 16_384);
      nullableString(link.originalURL, `${label}.links[${index}].originalURL`, 16_384);
      nullableString(link.summary, `${label}.links[${index}].summary`, 65_536);
      if (link.imgSize !== undefined && link.imgSize !== null) {
        const size = strictRecord(link.imgSize, `${label}.links[${index}].imgSize`);
        exactKeys(size, [], ["height", "width"], `${label}.links[${index}].imgSize`);
        optionalInteger(size.height, `${label}.links[${index}].imgSize.height`, 0, 1_000_000);
        optionalInteger(size.width, `${label}.links[${index}].imgSize.width`, 0, 1_000_000);
      }
    }
  }
  if (source.sendStatus !== undefined) {
    const status = strictRecord(source.sendStatus, `${label}.sendStatus`);
    exactKeys(status, ["status", "timestamp"], [
      "deliveredToUsers",
      "internalError",
      "message",
      "reason",
    ], `${label}.sendStatus`);
    boundedString(status.status, `${label}.sendStatus.status`, 64);
    timestamp(status.timestamp, `${label}.sendStatus.timestamp`);
    nullableString(status.internalError, `${label}.sendStatus.internalError`, 65_536);
    nullableString(status.message, `${label}.sendStatus.message`, 65_536);
    nullableString(status.reason, `${label}.sendStatus.reason`, 2_048);
    if (status.deliveredToUsers !== undefined) {
      strictArray(status.deliveredToUsers, `${label}.sendStatus.deliveredToUsers`, 2_000)
        .forEach((item, index) =>
          boundedString(item, `${label}.sendStatus.deliveredToUsers[${index}]`, 2_048));
    }
  }
  const isDeleted = optionalBoolean(source.isDeleted, `${label}.isDeleted`) ?? false;
  const isHidden = optionalBoolean(source.isHidden, `${label}.isHidden`) ?? false;
  const text = nullableString(source.text, `${label}.text`, MAX_TEXT_BYTES);
  const mentions = source.mentions === undefined || source.mentions === null
    ? null
    : Object.freeze(strictArray(source.mentions, `${label}.mentions`, 2_000)
      .map((item, index) =>
        boundedString(item, `${label}.mentions[${index}]`, 2_048)));
  const attachments = source.attachments === undefined
    ? []
    : strictArray(source.attachments, `${label}.attachments`, 256)
      .map((item, index) => parseAttachment(item, `${label}.attachments[${index}]`));
  const reactions = source.reactions === undefined
    ? []
    : parseReactions(source.reactions, `${label}.reactions`);
  return Object.freeze({
    id: boundedString(source.id, `${label}.id`, 2_048),
    accountId,
    conversationId,
    senderId: boundedString(source.senderID, `${label}.senderID`, 2_048),
    senderName: nullableString(source.senderName, `${label}.senderName`, 2_048),
    isSender: requiredBoolean(source.isSender, `${label}.isSender`),
    sortKey: boundedString(source.sortKey, `${label}.sortKey`, 1_024),
    timestamp: timestamp(source.timestamp, `${label}.timestamp`),
    editedTimestamp: optionalTimestamp(source.editedTimestamp, `${label}.editedTimestamp`),
    text: isDeleted || isHidden ? null : text,
    type: nullableString(source.type, `${label}.type`, 128),
    linkedMessageId: nullableString(source.linkedMessageID, `${label}.linkedMessageID`, 2_048),
    mentions,
    isDeleted,
    isHidden,
    isUnread: optionalBoolean(source.isUnread, `${label}.isUnread`),
    seen: parseSeen(source.seen, `${label}.seen`),
    attachments: Object.freeze(attachments),
    reactions: Object.freeze(reactions),
  });
}

export function parseBeeperExportMessages(
  value: unknown,
  accountId: string,
  conversationId: string,
  maximum: number,
): readonly BeeperMessageProjection[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) {
    throw new Error("Beeper export message bound is invalid");
  }
  const expected: BeeperMessagingReadInput = Object.freeze({
    accountId,
    conversationId,
    beforeCursor: null,
    afterCursor: null,
    limit: Math.min(maximum, 200),
  });
  const messages = strictArray(value, "Beeper export messages", maximum)
    .map((item, index) => parseMessage(
      item,
      `Beeper export messages[${index}]`,
      expected,
    ));
  const ids = messages.map((message) => message.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Beeper export messages repeat a stable ID");
  }
  return Object.freeze(messages);
}

export function parseBeeperCliEnvelope(value: unknown, label: string): unknown {
  const source = strictRecord(value, label);
  exactKeys(source, ["success", "data", "error"], [], label);
  if (source.success !== true || source.error !== null) {
    throw new Error(`${label} did not report success`);
  }
  return source.data;
}

function parseJsonOutput(stdout: string, label: string): unknown {
  const raw = stdout.trim();
  if (raw.length === 0) throw new Error(`${label} omitted JSON output`);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
  return parseBeeperCliEnvelope(value, label);
}

function parseContacts(
  value: unknown,
  accountIds: ReadonlySet<string>,
  expectedAccountId: string | null,
): readonly Readonly<{ accountId: string; user: BeeperUserProjection }>[] {
  return Object.freeze(strictArray(value, "Beeper contacts", MAX_USERS).map((item, index) => {
    const source = strictRecord(item, `Beeper contacts[${index}]`);
    const accountId = boundedString(source.accountID, `Beeper contacts[${index}].accountID`, 512);
    if (!accountIds.has(accountId) || (expectedAccountId !== null && accountId !== expectedAccountId)) {
      throw new Error(`Beeper contacts[${index}].accountID did not bind the requested realm`);
    }
    const user = parseUser(
      Object.freeze(Object.fromEntries(Object.entries(source).filter(([key]) => key !== "accountID"))),
      `Beeper contacts[${index}]`,
    );
    return Object.freeze({ accountId, user });
  }));
}

function requireBeeperAuth(auth: WrenchAuth): BeeperAuth {
  if (auth.kind !== "linked-device-store" || auth.provider !== "beeper") {
    throw new Error("Beeper local reads require a beeper linked-device-store auth locator");
  }
  return auth;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function pinnedBinaryCandidate(path: string): Promise<string | null> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    return null;
  }
  const stats = await lstat(canonical);
  if (
    !stats.isFile()
    || (stats.mode & 0o022) !== 0
    || (stats.mode & 0o111) === 0
    || (stats.uid !== process.getuid?.() && stats.uid !== 0)
    || process.platform !== "darwin"
    || process.arch !== "arm64"
  ) return null;
  return await sha256File(canonical) === BEEPER_CLI_PIN.darwinArm64BinarySha256
    ? canonical
    : null;
}

export async function resolvePinnedBeeperCliBinary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const candidates = [
    join(wrenchStateHome(environment), "tools", "beeper", BEEPER_CLI_PIN.version, "beeper"),
    "/opt/homebrew/bin/beeper",
    "/usr/local/bin/beeper",
  ];
  for (const candidate of candidates) {
    const found = await pinnedBinaryCandidate(candidate);
    if (found !== null) return found;
  }
  throw new Error(
    `pinned Beeper CLI ${BEEPER_CLI_PIN.version} is not installed or failed integrity verification`,
  );
}

function localDesktopBaseUrl(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const source = boundedString(value, label, 256);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`${label} must be a loopback Beeper Desktop URL`);
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || !Number.isSafeInteger(port)
    || port < 23_373
    || port > 23_392
  ) throw new Error(`${label} must be a reviewed loopback Beeper Desktop URL`);
  return source;
}

function storedBeeperAuth(value: unknown, label: string): JsonRecord {
  const auth = strictRecord(value, label);
  exactKeys(auth, ["accessToken", "tokenType"], [
    "clientID",
    "expiresAt",
    "scope",
    "source",
  ], label);
  boundedString(auth.accessToken, `${label}.accessToken`, 64 * 1024);
  if (auth.tokenType !== "Bearer") {
    throw new Error(`${label}.tokenType is unsupported`);
  }
  if (auth.clientID !== undefined) {
    boundedString(auth.clientID, `${label}.clientID`, 2_048);
  }
  if (auth.scope !== undefined) {
    boundedString(auth.scope, `${label}.scope`, 2_048);
  }
  if (auth.expiresAt !== undefined) {
    const expiresAt = boundedString(auth.expiresAt, `${label}.expiresAt`, 64);
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new Error(`${label}.expiresAt must be a timestamp`);
    }
  }
  if (auth.source !== undefined) {
    const source = boundedString(auth.source, `${label}.source`, 64);
    if (![
      "desktop-db",
      "desktop-cache",
      "desktop-oauth",
      "remote-oauth",
      "manual",
    ].includes(source)) throw new Error(`${label}.source is unsupported`);
  }
  return auth;
}

async function readPrivateJsonFile(path: string, label: string): Promise<JsonRecord | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.uid !== process.getuid?.()
      || (before.mode & 0o077) !== 0
      || before.size < 2
      || before.size > 4 * 1024 * 1024
    ) throw new Error(`${label} must be one private regular file`);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const extra = await handle.read(overflow, 0, 1, offset);
    const after = await handle.stat();
    if (
      offset !== bytes.byteLength
      || extra.bytesRead !== 0
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) throw new Error(`${label} changed while it was being read`);
    const pathStats = await lstat(path);
    if (
      pathStats.isSymbolicLink()
      || pathStats.dev !== after.dev
      || pathStats.ino !== after.ino
    ) throw new Error(`${label} changed while it was being read`);
    let value: unknown;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(decoded) as unknown;
    } catch {
      throw new Error(`${label} must contain valid UTF-8 JSON`);
    }
    return strictRecord(value, label);
  } finally {
    await handle.close();
  }
}

async function validateBeeperCliStoreInternal(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Beeper CLI config directory must be absolute");
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error("Beeper CLI config directory must be canonical");
  const stats = await lstat(canonical);
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== process.getuid?.()
    || (stats.mode & 0o022) !== 0
  ) throw new Error("Beeper CLI config directory must be an owned non-writable-by-others directory");
  const config = await readPrivateJsonFile(join(canonical, "config.json"), "Beeper CLI config");
  let configAuth: JsonRecord | undefined;
  let configBaseUrl: string | undefined;
  if (config !== null) {
    exactKeys(config, [], ["auth", "baseURL", "defaultAccount", "defaultTarget"], "Beeper CLI config");
    configBaseUrl = localDesktopBaseUrl(config.baseURL, "Beeper CLI config.baseURL");
    configAuth = config.auth === undefined
      ? undefined
      : storedBeeperAuth(config.auth, "Beeper CLI config.auth");
    if (config.defaultAccount !== undefined) {
      boundedString(config.defaultAccount, "Beeper CLI config.defaultAccount", 512);
    }
    if (config.defaultTarget !== BEEPER_DESKTOP_TARGET) {
      throw new Error("Beeper CLI config must select the fixed desktop target");
    }
  }
  const targetsPath = join(canonical, "targets");
  const canonicalTargets = await realpath(targetsPath);
  const targetDirectoryStats = await lstat(targetsPath);
  if (
    canonicalTargets !== targetsPath
    || !targetDirectoryStats.isDirectory()
    || targetDirectoryStats.isSymbolicLink()
    || targetDirectoryStats.uid !== process.getuid?.()
    || (targetDirectoryStats.mode & 0o022) !== 0
  ) {
    throw new Error(
      "Beeper CLI targets directory must be an owned physical non-writable-by-others directory",
    );
  }
  const target = await readPrivateJsonFile(
    join(canonicalTargets, "desktop.json"),
    "Beeper Desktop target",
  );
  let targetAuth: JsonRecord | undefined;
  let targetBaseUrl: string | undefined;
  if (target !== null) {
    exactKeys(target, ["id", "type", "baseURL"], [
      "auth",
      "dataDir",
      "managed",
      "name",
      "port",
      "profile",
      "runtime",
      "serverEnv",
    ], "Beeper Desktop target");
    if (target.id !== "desktop" || target.type !== "desktop") {
      throw new Error("Beeper Desktop target must identify the fixed desktop realm");
    }
    targetBaseUrl = localDesktopBaseUrl(target.baseURL, "Beeper Desktop target.baseURL");
    if (
      (target.managed !== undefined && target.managed !== false)
      || target.dataDir !== undefined
      || target.profile !== undefined
      || target.serverEnv !== undefined
    ) {
      throw new Error("Beeper Desktop target contains an active endpoint override");
    }
    if (target.port !== undefined) {
      integer(target.port, "Beeper Desktop target.port", 23_373, 23_392);
    }
    if (target.runtime !== undefined) {
      const runtime = strictRecord(target.runtime, "Beeper Desktop target.runtime");
      exactKeys(runtime, ["install", "port"], [], "Beeper Desktop target.runtime");
      if (runtime.install !== "desktop") {
        throw new Error("Beeper Desktop target.runtime.install is unsupported");
      }
      integer(
        runtime.port,
        "Beeper Desktop target.runtime.port",
        23_373,
        23_392,
      );
    }
    if (target.name !== undefined) {
      boundedString(target.name, "Beeper Desktop target.name", 2_048);
    }
    targetAuth = target.auth === undefined
      ? undefined
      : storedBeeperAuth(target.auth, "Beeper Desktop target.auth");
  }
  if (config === null || target === null) {
    throw new Error("Beeper CLI config directory has no authorized selected Desktop target");
  }
  const effectiveAuth = targetAuth
    ?? (configAuth !== undefined
      && (configBaseUrl === undefined || configBaseUrl === targetBaseUrl)
      ? configAuth
      : undefined);
  if (effectiveAuth === undefined) {
    throw new Error("Beeper CLI config directory has no effective stored access token");
  }
  return canonical;
}

export async function validateBeeperCliStore(path: string): Promise<string> {
  try {
    return await validateBeeperCliStoreInternal(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Beeper ")) {
      throw error;
    }
    throw new Error("Beeper CLI config directory could not be validated safely");
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (item.value.byteLength > maximum - byteLength) {
        throw new Error(`${label} exceeded its byte bound`);
      }
      chunks.push(item.value.slice());
      byteLength += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

async function runBeeperCli(
  invocation: BeeperCliInvocation,
): Promise<BeeperCliInvocationResult> {
  if (invocation.signal?.aborted === true) throw new Error("Beeper CLI command was cancelled");
  const ownsProcessGroup = process.platform !== "win32";
  const child = Bun.spawn([invocation.binary, ...invocation.arguments], {
    env: { ...invocation.environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: ownsProcessGroup,
  });
  let timedOut = false;
  let cancelled = false;
  let forceKill: ReturnType<typeof setTimeout> | null = null;
  const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      if (ownsProcessGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The complete CLI process group already exited.
    }
  };
  const terminate = (): void => {
    signalChild("SIGTERM");
    if (forceKill === null) forceKill = setTimeout(() => signalChild("SIGKILL"), 1_000);
  };
  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  invocation.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, invocation.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedStream(child.stdout, invocation.maxOutputBytes, "Beeper CLI stdout"),
      readBoundedStream(child.stderr, invocation.maxStderrBytes, "Beeper CLI stderr"),
    ]);
    if (cancelled) throw new Error("Beeper CLI command was cancelled");
    if (timedOut) throw new Error("Beeper CLI command timed out");
    return Object.freeze({ exitCode, stdout, stderr });
  } catch (error) {
    signalChild("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (forceKill !== null) clearTimeout(forceKill);
    invocation.signal?.removeEventListener("abort", onAbort);
  }
}

function remainingTimeoutMs(
  timeoutMs: number,
  deadline: WebSessionOperationDeadline | undefined,
): number {
  deadline?.throwIfUnavailable(OPERATION_LABEL);
  const remaining = Math.min(timeoutMs, deadline?.remainingTimeMs() ?? timeoutMs);
  if (remaining < 1) throw new Error("Beeper local read operation timed out");
  return remaining;
}

function environmentForBeeper(
  configDirectory: string,
  cacheDirectory: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    CI: "1",
    BEEPER_CLI_CONFIG_DIR: configDirectory,
    BEEPER_CLI_BINARY_CACHE_DIR: cacheDirectory,
    BEEPER_READONLY: "1",
    BEEPER_QUIET: "1",
    BEEPER_SKIP_UPDATE_CHECK: "1",
    NO_UPDATE_NOTIFIER: "1",
  });
}

async function executeCommand(
  binary: string,
  command: BeeperReadCommand,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
  maxOutputBytes: number,
  dependencies: BeeperLocalRuntimeDependencies | undefined,
  deadline: WebSessionOperationDeadline | undefined,
): Promise<unknown> {
  const run = dependencies?.run ?? runBeeperCli;
  const invoke = () => run({
    binary,
    arguments: command.argv,
    environment,
    timeoutMs: remainingTimeoutMs(timeoutMs, deadline),
    maxOutputBytes,
    maxStderrBytes: MAX_STDERR_BYTES,
    ...(deadline === undefined ? {} : { signal: deadline.signal }),
  });
  const result = deadline === undefined
    ? await invoke()
    : await deadline.run(invoke, OPERATION_LABEL);
  deadline?.throwIfUnavailable(OPERATION_LABEL);
  if (result.exitCode !== 0 || result.stderr.trim().length !== 0) {
    throw new Error("Beeper CLI read failed before producing reviewed output");
  }
  return parseJsonOutput(result.stdout, `Beeper CLI ${command.action}`);
}

async function withRuntime<T>(
  auth: BeeperAuth,
  timeoutMs: number,
  maxOutputBytes: number,
  dependencies: BeeperLocalRuntimeDependencies | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  deadline: WebSessionOperationDeadline | undefined,
  operation: (context: Readonly<{
    binary: string;
    environment: Readonly<Record<string, string>>;
    accounts: readonly BeeperAccountProjection[];
    subject: string;
    run: (command: BeeperReadCommand, maximum?: number) => Promise<unknown>;
  }>) => Promise<T>,
): Promise<T> {
  const configDirectory = await validateBeeperCliStore(auth.path);
  const binary = dependencies?.binaryPath ?? await resolvePinnedBeeperCliBinary(environment);
  if (dependencies?.binaryPath !== undefined && !isAbsolute(binary)) {
    throw new Error("test Beeper CLI binary path must be absolute");
  }
  const createCache = dependencies?.createCacheDirectory
    ?? (() => mkdtemp(join(tmpdir(), "wrench-beeper-cli-")));
  const removeCache = dependencies?.removeCacheDirectory
    ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const cacheDirectory = await createCache();
  if (!isAbsolute(cacheDirectory)) throw new Error("Beeper CLI cache directory must be absolute");
  const childEnvironment = environmentForBeeper(configDirectory, cacheDirectory);
  const run = (command: BeeperReadCommand, maximum = maxOutputBytes): Promise<unknown> =>
    executeCommand(
      binary,
      command,
      childEnvironment,
      timeoutMs,
      maximum,
      dependencies,
      deadline,
    );
  try {
    const version = await executeCommand(
      binary,
      Object.freeze({
        action: "accounts.list",
        argv: Object.freeze(["version", "--read-only", "--json", "--quiet"]),
      }),
      childEnvironment,
      timeoutMs,
      4_096,
      dependencies,
      deadline,
    );
    const versionRecord = strictRecord(version, "Beeper CLI version");
    exactKeys(versionRecord, ["name", "version"], [], "Beeper CLI version");
    if (versionRecord.name !== "@beeper/cli" || versionRecord.version !== BEEPER_CLI_PIN.version) {
      throw new Error("Beeper CLI runtime version did not match its pin");
    }
    const accounts = parseAccounts(await run(planBeeperAccountsListCommand(timeoutMs), 8 * 1024 * 1024));
    const subject = beeperSubjectFromAccounts(accounts);
    if (auth.subject !== undefined && auth.subject !== subject) {
      throw new Error("Beeper CLI current account did not match the bound auth realm");
    }
    return await operation(Object.freeze({ binary, environment: childEnvironment, accounts, subject, run }));
  } finally {
    await removeCache(cacheDirectory);
  }
}

export async function probeBeeperLocalSubject(
  authValue: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly dependencies?: BeeperLocalRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<string> {
  const auth = requireBeeperAuth(authValue);
  const deadline = new OperationDeadline(SUBJECT_PROBE_TIMEOUT_MS, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    return await withRuntime(
      auth,
      SUBJECT_PROBE_TIMEOUT_MS,
      8 * 1024 * 1024,
      options.dependencies,
      options.environment ?? process.env,
      deadline,
      async ({ subject }) => subject,
    );
  } finally {
    deadline.dispose();
  }
}

function unavailableContactStats() {
  return projectContactDirectionStats(
    Object.freeze({
      count: null,
      complete: false,
      lowerBound: false,
      truncated: false,
      lastAt: null,
      lastAtComplete: false,
      lastAtBasis: "unavailable" as const,
      incompleteReasons: Object.freeze(["beeper-message-history-not-scanned"]),
    }),
    Object.freeze({
      count: null,
      complete: false,
      lowerBound: false,
      truncated: false,
      lastAt: null,
      lastAtComplete: false,
      lastAtBasis: "unavailable" as const,
      incompleteReasons: Object.freeze(["beeper-message-history-not-scanned"]),
    }),
  );
}

type BeeperPublicAccountProjection = Omit<
  BeeperAccountProjection,
  "selectorAliases"
>;

function publicAccountProjection(
  account: BeeperAccountProjection,
): BeeperPublicAccountProjection {
  return Object.freeze({
    accountId: account.accountId,
    bridge: Object.freeze({
      id: account.bridge.id,
      type: account.bridge.type,
      provider: account.bridge.provider,
    }),
    network: account.network,
    loginId: account.loginId,
    status: account.status,
    statusText: account.statusText,
    user: Object.freeze({
      id: account.user.id,
      fullName: account.user.fullName,
      username: account.user.username,
      phoneNumber: account.user.phoneNumber,
      email: account.user.email,
      isSelf: account.user.isSelf,
      cannotMessage: account.user.cannotMessage,
    }),
  });
}

function publicAccountProjections(
  accounts: readonly BeeperAccountProjection[],
): readonly BeeperPublicAccountProjection[] {
  return Object.freeze(accounts.map(publicAccountProjection));
}

function contactOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: Extract<BeeperOperationInput, { readonly limit: number }>,
  raw: unknown,
) {
  const accountId = "accountId" in input ? input.accountId : null;
  const accountIds = new Set(accounts.map((account) => account.accountId));
  if (accountId !== null && !accountIds.has(accountId)) {
    throw new Error("contacts.list requested an account outside the bound Beeper realm");
  }
  const contacts = parseContacts(raw, accountIds, accountId).map((contact) => Object.freeze({
    accountId: contact.accountId,
    ...contact.user,
    ...unavailableContactStats(),
  }));
  const limitReached = contacts.length === input.limit;
  return Object.freeze({
    provider: "beeper",
    operation: "contacts.list",
    accountSubject: subject,
    projection: "bounded-local-desktop-api",
    accounts: publicAccountProjections(accounts),
    requestedAccountId: accountId,
    contacts: Object.freeze(contacts),
    completeness: Object.freeze({
      localPageComplete: !limitReached,
      remoteContactSetComplete: false,
      limitReached,
      warnings: Object.freeze([
        "beeper-contact-pagination-cursor-not-exposed-by-cli-v0.6.2",
        "provider-history-coverage-varies-by-connected-account",
      ]),
    }),
  });
}

function conversationOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: Extract<BeeperOperationInput, { readonly limit: number }>,
  raw: unknown,
) {
  const accountId = "accountId" in input ? input.accountId : null;
  const accountIds = new Set(accounts.map((account) => account.accountId));
  if (accountId !== null && !accountIds.has(accountId)) {
    throw new Error("messaging.list requested an account outside the bound Beeper realm");
  }
  const conversations = strictArray(raw, "Beeper conversations", MAX_CHATS)
    .map((item, index) => parseConversation(
      item,
      `Beeper conversations[${index}]`,
      accountIds,
      accountId,
    ));
  const ids = conversations.map((conversation) => `${conversation.accountId}\0${conversation.id}`);
  if (new Set(ids).size !== ids.length) throw new Error("Beeper conversations repeat an account-scoped ID");
  const limitReached = conversations.length === input.limit;
  return Object.freeze({
    provider: "beeper",
    operation: "messaging.list",
    accountSubject: subject,
    projection: "bounded-local-desktop-api",
    accounts: publicAccountProjections(accounts),
    requestedAccountId: accountId,
    conversations: Object.freeze(conversations),
    completeness: Object.freeze({
      localPageComplete: !limitReached,
      remoteConversationSetComplete: false,
      limitReached,
      warnings: Object.freeze([
        "beeper-chat-pagination-cursor-not-exposed-by-cli-v0.6.2",
        "newly-connected-accounts-may-have-incomplete-history",
      ]),
    }),
  });
}

function messageOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: BeeperMessagingReadInput,
  raw: unknown,
) {
  if (!accounts.some((account) => account.accountId === input.accountId)) {
    throw new Error("messaging.read requested an account outside the bound Beeper realm");
  }
  const messages = strictArray(raw, "Beeper messages", MAX_MESSAGES)
    .map((item, index) => parseMessage(item, `Beeper messages[${index}]`, input));
  const ids = messages.map((message) => message.id);
  if (new Set(ids).size !== ids.length) throw new Error("Beeper messages repeat a stable ID");
  const tombstones = messages.flatMap((message): readonly BeeperTombstoneProjection[] => {
    if (!message.isDeleted && !message.isHidden) return [];
    return [Object.freeze({
      accountId: message.accountId,
      conversationId: message.conversationId,
      messageId: message.id,
      state: message.isDeleted && message.isHidden
        ? "deleted-and-hidden"
        : message.isDeleted
          ? "deleted"
          : "hidden",
      observedAt: message.editedTimestamp ?? message.timestamp,
    })];
  });
  const limitReached = messages.length === input.limit;
  const continuation = limitReached && messages.length > 0
    ? Object.freeze({
        direction: input.afterCursor === null ? "before" : "after",
        cursor: messages[messages.length - 1]!.id,
      })
    : null;
  return Object.freeze({
    provider: "beeper",
    operation: "messaging.read",
    accountSubject: subject,
    projection: "bounded-local-desktop-api",
    accountId: input.accountId,
    conversationId: input.conversationId,
    requestCursor: input.beforeCursor ?? input.afterCursor,
    requestDirection: input.afterCursor === null ? "before" : "after",
    messages: Object.freeze(messages),
    tombstones: Object.freeze(tombstones),
    continuation,
    completeness: Object.freeze({
      localPageComplete: !limitReached,
      remoteConversationHistoryComplete: false,
      limitReached,
      warnings: Object.freeze([
        "continuation-is-derived-from-terminal-returned-message-id",
        "edits-reactions-and-deletions-may-require-overlap-reconciliation",
        "newly-connected-accounts-may-have-incomplete-history",
      ]),
    }),
  });
}

export async function executeBeeperLocalOperation(
  recipe: WebSessionRecipe,
  inputValue: OperationInput,
  authValue: WrenchAuth,
  options: {
    readonly dependencies?: BeeperLocalRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "beeper"
    || recipe.contractVersion !== 1
    || !isBeeperLocalOperation(recipe.action)
  ) throw new Error("Beeper local read recipe is not installed");
  const action: BeeperLocalOperationName = recipe.action;
  const contract = BEEPER_LOCAL_OPERATIONS[action];
  if (contract.state !== "observed" || contract.effect !== "read") {
    throw new Error(`Beeper local operation ${action} is not executable`);
  }
  const input = parseBeeperOperationInput(action, inputValue);
  const auth = requireBeeperAuth(authValue);
  options.operationDeadline?.throwIfUnavailable(OPERATION_LABEL);
  return startWebSessionCleanupTrackedOperation(
    options.registerCleanupBarrier,
    async () => withRuntime(
      auth,
      recipe.timeoutMs,
      recipe.maxOutputBytes,
      options.dependencies,
      options.environment ?? process.env,
      options.operationDeadline,
      async ({ accounts, subject, run }) => {
        if (auth.subject === undefined) {
          throw new Error("Beeper auth must be account-bound before private reads");
        }
        const raw = await run(planBeeperReadCommand(action, input, recipe.timeoutMs));
        const output = action === "contacts.list"
          ? contactOutput(accounts, subject, input, raw)
          : action === "messaging.list"
            ? conversationOutput(accounts, subject, input, raw)
            : messageOutput(accounts, subject, input as BeeperMessagingReadInput, raw);
        const encoded = Buffer.from(JSON.stringify(output), "utf8");
        if (encoded.byteLength > recipe.maxOutputBytes) {
          throw new Error("Beeper local projection exceeded the reviewed output bound");
        }
        return Object.freeze({
          status: "succeeded" as const,
          output,
          finalUrl: BEEPER_ORIGIN,
          dispatchStarted: false,
          dispatch: Object.freeze({ planned: 0, started: 0, verified: 0 }),
        });
      },
    ),
    async (operation) => {
      await operation.then(() => undefined, () => undefined);
    },
  );
}
