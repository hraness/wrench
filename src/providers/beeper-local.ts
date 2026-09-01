/**
 * Fixed policy, input parsing, and argv planning for the official Beeper CLI.
 *
 * The provider never accepts a command, argv fragment, target, base URL, token,
 * path, or fuzzy chat selector from its caller. File arguments are plan-bound
 * references which the kernel materializes only after confirmation.
 */

import { isAbsolute } from "node:path";
import { types as nodeTypes } from "node:util";

import type { FileInputValue, OperationInput } from "../model";

export type BeeperCliArtifactPin = Readonly<{
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  archiveSha256: string;
  executableSha256: string;
  downloadUrl: string;
}>;

export const BEEPER_CLI_DARWIN_ARM64_ARTIFACT_PIN = Object.freeze({
  platform: "darwin",
  arch: "arm64",
  archiveSha256:
    "688ccde7e7d044d33980cd06474bf1ae7215ccf8ca79967262fa3bfb85a2589a",
  executableSha256:
    "48aa895449129c793a212ea19f69a534adc34a8adc4037ca1d7da9e648716425",
  downloadUrl:
    "https://github.com/beeper/cli/releases/download/v0.6.2/beeper-cli-0.6.2-macos-arm64.zip",
} as const);

export const BEEPER_CLI_PIN = Object.freeze({
  id: "beeper-cli",
  implementation: "github.com/beeper/cli",
  version: "0.6.2",
  commit: "a416af06023449a87312dc11e54643fd9dc94b8c",
  releaseManifestSha256:
    "5c52b533180151b97e26138ef687b6b819170687b34a478184e5648335356950",
  releaseManifestUrl:
    "https://github.com/beeper/cli/releases/download/v0.6.2/binaries.json",
  releaseUrl: "https://github.com/beeper/cli/releases/tag/v0.6.2",
  sourceUrl:
    "https://github.com/beeper/cli/tree/a416af06023449a87312dc11e54643fd9dc94b8c",
  // Frozen v0.14 specialized-export identity. New local-cli contracts bind
  // the complete artifact table below; the released schema-1 receipt keeps
  // these exact Darwin arm64 field names and values.
  darwinArm64ArchiveSha256:
    BEEPER_CLI_DARWIN_ARM64_ARTIFACT_PIN.archiveSha256,
  darwinArm64BinarySha256:
    BEEPER_CLI_DARWIN_ARM64_ARTIFACT_PIN.executableSha256,
  downloadUrl: BEEPER_CLI_DARWIN_ARM64_ARTIFACT_PIN.downloadUrl,
  artifacts: Object.freeze([
    BEEPER_CLI_DARWIN_ARM64_ARTIFACT_PIN,
    Object.freeze({
      platform: "darwin",
      arch: "x64",
      archiveSha256:
        "4113a1979cfbd7839f14743158e70c12efa941313afb77ab2b11a08309196186",
      executableSha256:
        "83bb89edb6eeb9c61ebdb6ec940e0db30c90ecbca61d60a7408fe336e255f22e",
      downloadUrl:
        "https://github.com/beeper/cli/releases/download/v0.6.2/beeper-cli-0.6.2-macos-x64.zip",
    }),
    Object.freeze({
      platform: "linux",
      arch: "arm64",
      archiveSha256:
        "2bd37043a4ed863621edc59e28aaa652e8193e55abca0e9477f5aeae1c65d629",
      executableSha256:
        "102b8725bd99b03905dcff9fff645f3742e1697ce8d43ab9d8656896aafd12a8",
      downloadUrl:
        "https://github.com/beeper/cli/releases/download/v0.6.2/beeper-cli-0.6.2-linux-arm64.tar.gz",
    }),
    Object.freeze({
      platform: "linux",
      arch: "x64",
      archiveSha256:
        "a881e1d2bc91e31218b251716644ec5f8d161d5ccb30e7eab66cf2ba6410511d",
      executableSha256:
        "723cc3a6c556fa21b6ba11db8377d6a29776aca1660da48f0072883d6452ae3d",
      downloadUrl:
        "https://github.com/beeper/cli/releases/download/v0.6.2/beeper-cli-0.6.2-linux-x64.tar.gz",
    }),
  ] satisfies readonly BeeperCliArtifactPin[]),
} as const);

/** SDK contract reviewed behind the pinned CLI's Desktop command surface. */
export const BEEPER_DESKTOP_API_PIN = Object.freeze({
  package: "@beeper/desktop-api",
  version: "5.0.0",
  commit: "b9c1714410139c2139b597338cd002d785653e85",
} as const);

export function beeperCliArtifactForRuntime(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BeeperCliArtifactPin {
  const artifact = BEEPER_CLI_PIN.artifacts.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (artifact === undefined) {
    throw new Error(`Beeper CLI ${BEEPER_CLI_PIN.version} has no pinned artifact for this runtime`);
  }
  return artifact;
}

export const BEEPER_ORIGIN = "https://www.beeper.com" as const;
export const BEEPER_DESKTOP_TARGET = "desktop" as const;
export const BEEPER_MAX_FILE_BYTES = 500 * 1024 * 1024;
export const BEEPER_DESKTOP_BUNDLE_IDS = Object.freeze([
  "com.automattic.beeper.desktop",
  "com.automattic.beeper.desktop.nightly",
] as const);

export const BEEPER_LOCAL_OPERATION_NAMES = Object.freeze([
  "accounts.list",
  "accounts.read",
  "bridges.list",
  "bridges.read",
  "contacts.list",
  "contacts.search",
  "contacts.read",
  "messaging.list",
  "messaging.search",
  "conversations.read",
  "messaging.read",
  "messaging.content.search",
  "messaging.message.read",
  "messaging.context.read",
  "messaging.send",
  "reactions.set",
  "messaging.edit",
  "conversations.start",
  "conversations.archive.set",
  "conversations.pin.set",
  "conversations.mute.set",
  "conversations.read-state.set",
  "conversations.priority.set",
  "conversations.notify",
  "conversations.title.set",
  "conversations.description.set",
  "conversations.avatar.set",
  "conversations.draft.set",
  "conversations.disappearing.set",
  "conversations.reminder.set",
  "conversations.focus",
  "presence.set",
] as const);

export type BeeperLocalOperationName =
  (typeof BEEPER_LOCAL_OPERATION_NAMES)[number];

type BeeperOperationPolicy = Readonly<{
  effect: "read" | "write";
  risk: "R1" | "R2" | "R3";
  state: "observed" | "desired";
  reason: string;
}>;

const readPolicy = (reason: string): BeeperOperationPolicy => Object.freeze({
  effect: "read", risk: "R1", state: "observed", reason,
});
const reversiblePolicy = (reason: string): BeeperOperationPolicy => Object.freeze({
  effect: "write", risk: "R2", state: "desired", reason,
});
const visiblePolicy = (reason: string): BeeperOperationPolicy => Object.freeze({
  effect: "write", risk: "R3", state: "desired", reason,
});

export const BEEPER_LOCAL_OPERATIONS = Object.freeze({
  "accounts.list": readPolicy("list the exact account realm bound to local Beeper Desktop"),
  "accounts.read": readPolicy("read one exact connected-account projection"),
  "bridges.list": readPolicy("list a bounded bridge capability catalog"),
  "bridges.read": readPolicy("read one exact bridge and its non-secret capabilities"),
  "contacts.list": readPolicy("list one bounded account-aware contact projection"),
  "contacts.search": readPolicy("search one bounded account-aware contact candidate window"),
  "contacts.read": readPolicy("read one exact account-bound contact identity"),
  "messaging.list": readPolicy("list one bounded account-aware conversation projection"),
  "messaging.search": readPolicy("search one bounded conversation candidate window"),
  "conversations.read": readPolicy("read one exact account-bound conversation"),
  "messaging.read": readPolicy("read one bounded page from an exact conversation"),
  "messaging.content.search": readPolicy("search one bounded message-content candidate window"),
  "messaging.message.read": readPolicy("read one exact message from an exact conversation"),
  "messaging.context.read": readPolicy("read bounded context around one exact message"),
  "messaging.send": visiblePolicy("submit one confirmed text, file, sticker, or voice request to Beeper Desktop; network delivery is not asserted"),
  "reactions.set": reversiblePolicy("set or clear one exact reaction desired state"),
  "messaging.edit": visiblePolicy("edit one exact message authored by the current account"),
  "conversations.start": visiblePolicy("start one conversation with an exact account-bound user"),
  "conversations.archive.set": reversiblePolicy("set one conversation archive desired state"),
  "conversations.pin.set": reversiblePolicy("set one conversation pin desired state"),
  "conversations.mute.set": reversiblePolicy("set one conversation mute desired state"),
  "conversations.read-state.set": visiblePolicy("set one conversation read marker, which may emit a network read receipt"),
  "conversations.priority.set": reversiblePolicy("set one conversation inbox priority desired state"),
  "conversations.notify": visiblePolicy("send one explicit iMessage Notify Anyway alert"),
  "conversations.title.set": visiblePolicy("set one group-conversation title"),
  "conversations.description.set": visiblePolicy("set or clear one group-conversation description"),
  "conversations.avatar.set": visiblePolicy("set or clear one group-conversation avatar"),
  "conversations.draft.set": reversiblePolicy("set or clear one private conversation draft"),
  "conversations.disappearing.set": visiblePolicy("set a retention timer whose effects cannot be undone after messages expire"),
  "conversations.reminder.set": reversiblePolicy("set or clear one private conversation reminder"),
  "conversations.focus": reversiblePolicy("focus local Beeper Desktop on one exact conversation"),
  "presence.set": visiblePolicy("send one bounded typing or paused indicator"),
} satisfies Readonly<Record<BeeperLocalOperationName, BeeperOperationPolicy>>);

export type BeeperContactsListInput = Readonly<{ accountId: string | null; limit: number }>;
export type BeeperContactsSearchInput = BeeperContactsListInput & Readonly<{ query: string }>;
export type BeeperMessagingListInput = BeeperContactsListInput & Readonly<{
  archived: boolean | null;
  pinned: boolean | null;
  muted: boolean | null;
  unread: boolean | null;
  lowPriority: boolean | null;
}>;
export type BeeperMessagingSearchInput = BeeperContactsSearchInput;
export type BeeperMessagingReadInput = Readonly<{
  accountId: string;
  conversationId: string;
  beforeCursor: string | null;
  afterCursor: string | null;
  limit: number;
}>;

type EmptyInput = Readonly<Record<never, never>>;
type AccountInput = Readonly<{ accountId: string }>;
type BridgeListInput = Readonly<{ provider: "local" | "cloud" | "self-hosted" | null; available: boolean | null; limit: number }>;
type BridgeInput = Readonly<{ bridgeId: string }>;
type ContactInput = AccountInput & Readonly<{ contactId: string }>;
type ConversationInput = AccountInput & Readonly<{ conversationId: string }>;
type ConversationReadInput = ConversationInput & Readonly<{ maxParticipants: number }>;
type MessageInput = ConversationInput & Readonly<{ messageId: string }>;
type MessageContextInput = MessageInput & Readonly<{ before: number; after: number }>;
export type BeeperMessageContentSearchInput = Readonly<{
  query: string | null;
  accountId: string | null;
  conversationId: string | null;
  chatType: "group" | "single" | null;
  after: string | null;
  before: string | null;
  beforeCursor: string | null;
  afterCursor: string | null;
  excludeLowPriority: boolean;
  includeMuted: boolean;
  media: readonly ("any" | "video" | "image" | "link" | "file")[];
  sender: string | null;
  limit: number;
}>;
type SendInput = ConversationInput & Readonly<{
  kind: "text" | "file" | "sticker" | "voice";
  text: string | null;
  file: FileInputValue | null;
  filename: string | null;
  mimeType: string | null;
  durationSeconds: number | null;
  replyTo: string | null;
  mentions: readonly string[];
  noPreview: boolean;
}>;
type ReactionInput = MessageInput & Readonly<{ reaction: string; enabled: boolean }>;
type EditInput = MessageInput & Readonly<{ text: string }>;
type StartInput = AccountInput & Readonly<{ userId: string }>;
type BooleanStateInput = ConversationInput & Readonly<{ enabled: boolean }>;
type ReadStateInput = ConversationInput & Readonly<{ unread: boolean; messageId: string | null }>;
type PriorityInput = ConversationInput & Readonly<{ level: "inbox" | "low" }>;
type TextStateInput = ConversationInput & Readonly<{ value: string | null }>;
type FileStateInput = ConversationInput & Readonly<{ file: FileInputValue | null }>;
type DraftInput = ConversationInput & Readonly<{
  text: string | null;
  file: FileInputValue | null;
  filename: string | null;
  mimeType: string | null;
  clear: boolean;
}>;
type DisappearingInput = ConversationInput & Readonly<{ seconds: number }>;
type ReminderInput = ConversationInput & Readonly<{ when: string | null; dismissOnMessage: boolean }>;
type FocusInput = ConversationInput & Readonly<{ messageId: string | null; draft: string | null; attachment: FileInputValue | null }>;
type PresenceInput = ConversationInput & Readonly<{ state: "typing" | "paused"; durationSeconds: number | null }>;

export type BeeperOperationInput =
  | EmptyInput | AccountInput | BridgeListInput | BridgeInput | ContactInput
  | BeeperContactsListInput | BeeperContactsSearchInput | BeeperMessagingListInput
  | BeeperMessagingSearchInput | ConversationReadInput | BeeperMessagingReadInput
  | BeeperMessageContentSearchInput | MessageInput | MessageContextInput | SendInput
  | ReactionInput | EditInput | StartInput | BooleanStateInput | ReadStateInput
  | PriorityInput | TextStateInput | FileStateInput | DraftInput
  | DisappearingInput | ReminderInput | FocusInput | PresenceInput;

export type BeeperCommand = Readonly<{
  action: "version" | "target-status" | BeeperLocalOperationName;
  argv: readonly string[];
  mutation: boolean;
}>;
export type BeeperReadCommand = BeeperCommand;

export type BeeperMessageLikeMeExportCommandOptions = Readonly<{
  outputDirectory: string;
  limitChats: number;
  limitMessages: number;
  maxParticipants: number;
}>;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) throw new Error(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error(`${label} must not contain symbol fields`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must contain only enumerable data fields`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function exactKeys(value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[], label: string): void {
  const keys = new Set(Object.keys(value));
  for (const key of required) if (!keys.delete(key)) throw new Error(`${label} omitted ${key}`);
  for (const key of optional) keys.delete(key);
  if (keys.size > 0) throw new Error(`${label} contained unsupported fields`);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function optionalBool(value: unknown, label: string): boolean | null {
  return value === undefined ? null : bool(value, label);
}

function boundedOpaque(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum || /[\0\r\n]/u.test(value) || !hasWellFormedUnicode(value)) throw new Error(`${label} must be bounded well-formed opaque text`);
  return value;
}
function optionalOpaque(value: unknown, label: string, maximum: number): string | null {
  return value === undefined ? null : boundedOpaque(value, label, maximum);
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0") || !hasWellFormedUnicode(value)) throw new Error(`${label} must be bounded well-formed Unicode text`);
  return value;
}
function optionalText(value: unknown, label: string, maximum: number): string | null {
  return value === undefined ? null : boundedText(value, label, maximum, true);
}

function normalizedSearchQuery(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < 1
    || normalized.startsWith("-")
    || !hasWellFormedUnicode(normalized)
    || Buffer.byteLength(normalized, "utf8") > 256
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) throw new Error(`${label} must be nonempty normalized non-flag text of at most 256 UTF-8 bytes`);
  return normalized;
}

function exactEnum<T extends string>(value: unknown, label: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label} must be one of ${values.join(", ")}`);
  return value as T;
}
function optionalEnum<T extends string>(value: unknown, label: string, values: readonly T[]): T | null {
  return value === undefined ? null : exactEnum(value, label, values);
}

function isoTimestamp(value: unknown, label: string): string {
  const text = boundedOpaque(value, label, 64);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  return text;
}
function optionalTimestamp(value: unknown, label: string): string | null {
  return value === undefined ? null : isoTimestamp(value, label);
}

function fileInput(value: unknown, label: string): FileInputValue {
  const source = record(value, label);
  exactKeys(source, ["kind", "reference"], [], label);
  if (source.kind !== "file") throw new Error(`${label}.kind must be file`);
  return Object.freeze({ kind: "file" as const, reference: boundedOpaque(source.reference, `${label}.reference`, 1_024) });
}
function optionalFile(value: unknown, label: string): FileInputValue | null {
  return value === undefined ? null : fileInput(value, label);
}

function stringArray(value: unknown, label: string, maximumItems: number, itemMaximum: number): readonly string[] {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximumItems
    || Reflect.ownKeys(value).length !== value.length + 1
  ) throw new Error(`${label} must be a dense plain array of at most ${maximumItems} items`);
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must contain only dense data items`);
    }
    items.push(boundedOpaque(descriptor.value, `${label}[${index}]`, itemMaximum));
  }
  if (new Set(items).size !== items.length) throw new Error(`${label} must not repeat items`);
  return Object.freeze(items);
}

function accountId(source: Readonly<Record<string, unknown>>, label: string): string {
  return boundedOpaque(source.account_id, `${label}.account_id`, 512);
}
function conversationId(source: Readonly<Record<string, unknown>>, label: string): string {
  const id = boundedOpaque(source.conversation_id, `${label}.conversation_id`, 2_048);
  if (!/^![^:\s]{1,255}:[^:\s]{1,255}(?::[0-9]{1,5})?$/u.test(id)) {
    throw new Error(`${label}.conversation_id must be one exact full Beeper/Matrix chat ID`);
  }
  return id;
}
function messageId(source: Readonly<Record<string, unknown>>, label: string): string {
  return boundedOpaque(source.message_id, `${label}.message_id`, 2_048);
}
function canonicalMatrixUserId(value: unknown, label: string): string {
  const id = boundedOpaque(value, label, 2_048);
  if (!/^@[^:\s]{1,255}:[^:\s]{1,255}(?::[0-9]{1,5})?$/u.test(id)) {
    throw new Error(`${label} must be one exact Matrix/Beeper user ID`);
  }
  return id;
}
function canonicalMessageSender(value: unknown, label: string): string {
  const sender = boundedOpaque(value, label, 2_048);
  if (sender === "me" || sender === "others") return sender;
  return canonicalMatrixUserId(sender, label);
}
function conversationInput(source: Readonly<Record<string, unknown>>, label: string): ConversationInput {
  return Object.freeze({ accountId: accountId(source, label), conversationId: conversationId(source, label) });
}

export function parseBeeperContactsListInput(input: OperationInput): BeeperContactsListInput {
  const source = record(input, "contacts.list input");
  exactKeys(source, [], ["account_id", "limit"], "contacts.list input");
  return Object.freeze({ accountId: optionalOpaque(source.account_id, "contacts.list input.account_id", 512), limit: source.limit === undefined ? 200 : integer(source.limit, "contacts.list input.limit", 1, 200) });
}

export function parseBeeperContactsSearchInput(input: OperationInput): BeeperContactsSearchInput {
  const source = record(input, "contacts.search input");
  exactKeys(source, ["query"], ["account_id", "limit"], "contacts.search input");
  return Object.freeze({ accountId: optionalOpaque(source.account_id, "contacts.search input.account_id", 512), query: normalizedSearchQuery(source.query, "contacts.search input.query"), limit: source.limit === undefined ? 20 : integer(source.limit, "contacts.search input.limit", 1, 20) });
}

export function parseBeeperMessagingListInput(input: OperationInput): BeeperMessagingListInput {
  const source = record(input, "messaging.list input");
  exactKeys(source, [], ["account_id", "limit", "archived", "pinned", "muted", "unread", "low_priority"], "messaging.list input");
  return Object.freeze({
    accountId: optionalOpaque(source.account_id, "messaging.list input.account_id", 512),
    limit: source.limit === undefined ? 200 : integer(source.limit, "messaging.list input.limit", 1, 200),
    archived: optionalBool(source.archived, "messaging.list input.archived"),
    pinned: optionalBool(source.pinned, "messaging.list input.pinned"),
    muted: optionalBool(source.muted, "messaging.list input.muted"),
    unread: optionalBool(source.unread, "messaging.list input.unread"),
    lowPriority: optionalBool(source.low_priority, "messaging.list input.low_priority"),
  });
}

export function parseBeeperMessagingSearchInput(input: OperationInput): BeeperMessagingSearchInput {
  const source = record(input, "messaging.search input");
  exactKeys(source, ["query"], ["account_id", "limit"], "messaging.search input");
  return Object.freeze({ accountId: optionalOpaque(source.account_id, "messaging.search input.account_id", 512), query: normalizedSearchQuery(source.query, "messaging.search input.query"), limit: source.limit === undefined ? 20 : integer(source.limit, "messaging.search input.limit", 1, 20) });
}

export function parseBeeperMessagingReadInput(input: OperationInput): BeeperMessagingReadInput {
  const source = record(input, "messaging.read input");
  exactKeys(source, ["account_id", "conversation_id"], ["before_cursor", "after_cursor", "limit"], "messaging.read input");
  const beforeCursor = optionalOpaque(source.before_cursor, "messaging.read input.before_cursor", 2_048);
  const afterCursor = optionalOpaque(source.after_cursor, "messaging.read input.after_cursor", 2_048);
  if (beforeCursor !== null && afterCursor !== null) throw new Error("messaging.read input accepts only one cursor direction");
  return Object.freeze({ accountId: accountId(source, "messaging.read input"), conversationId: conversationId(source, "messaging.read input"), beforeCursor, afterCursor, limit: source.limit === undefined ? 200 : integer(source.limit, "messaging.read input.limit", 1, 200) });
}

function parseMessageSearchInput(input: OperationInput): BeeperMessageContentSearchInput {
  const label = "messaging.content.search input";
  const source = record(input, label);
  exactKeys(source, [], ["query", "account_id", "conversation_id", "chat_type", "after", "before", "before_cursor", "after_cursor", "exclude_low_priority", "include_muted", "media", "sender", "limit"], label);
  const query = source.query === undefined ? null : normalizedSearchQuery(source.query, `${label}.query`);
  const account = optionalOpaque(source.account_id, `${label}.account_id`, 512);
  const conversation = source.conversation_id === undefined
    ? null
    : conversationId(source, label);
  const chatType = optionalEnum(source.chat_type, `${label}.chat_type`, ["group", "single"] as const);
  const after = optionalTimestamp(source.after, `${label}.after`);
  const before = optionalTimestamp(source.before, `${label}.before`);
  if (after !== null && before !== null && Date.parse(after) > Date.parse(before)) throw new Error(`${label}.after must not follow before`);
  const beforeCursor = optionalOpaque(source.before_cursor, `${label}.before_cursor`, 2_048);
  const afterCursor = optionalOpaque(source.after_cursor, `${label}.after_cursor`, 2_048);
  if (beforeCursor !== null && afterCursor !== null) throw new Error(`${label} accepts only one cursor direction`);
  const media: readonly ("any" | "video" | "image" | "link" | "file")[] =
    source.media === undefined
      ? Object.freeze([])
      : stringArray(source.media, `${label}.media`, 5, 16).map((item) =>
          exactEnum(item, `${label}.media item`, ["any", "video", "image", "link", "file"] as const));
  if (media.includes("any") && media.length > 1) throw new Error(`${label}.media any must be the only filter`);
  const sender = source.sender === undefined
    ? null
    : canonicalMessageSender(source.sender, `${label}.sender`);
  if (query === null && account === null && conversation === null && chatType === null && after === null && before === null && media.length === 0 && sender === null) throw new Error(`${label} requires a query or an exact filter`);
  return Object.freeze({
    query, accountId: account, conversationId: conversation, chatType, after, before,
    beforeCursor, afterCursor,
    excludeLowPriority: source.exclude_low_priority === undefined ? true : bool(source.exclude_low_priority, `${label}.exclude_low_priority`),
    includeMuted: source.include_muted === undefined ? true : bool(source.include_muted, `${label}.include_muted`),
    media: Object.freeze(media), sender,
    limit: source.limit === undefined ? 50 : integer(source.limit, `${label}.limit`, 1, 200),
  });
}

function parseSendInput(input: OperationInput): SendInput {
  const label = "messaging.send input";
  const source = record(input, label);
  exactKeys(source, ["account_id", "conversation_id", "kind"], ["text", "file", "filename", "mime_type", "duration_seconds", "reply_to", "mentions", "no_preview"], label);
  const kind = exactEnum(source.kind, `${label}.kind`, ["text", "file", "sticker", "voice"] as const);
  const text = optionalText(source.text, `${label}.text`, 65_536);
  const file = optionalFile(source.file, `${label}.file`);
  const filename = optionalOpaque(source.filename, `${label}.filename`, 512);
  const mimeType = optionalOpaque(source.mime_type, `${label}.mime_type`, 128);
  const durationSeconds = source.duration_seconds === undefined ? null : integer(source.duration_seconds, `${label}.duration_seconds`, 1, 86_400);
  const replyTo = optionalOpaque(source.reply_to, `${label}.reply_to`, 2_048);
  const mentions = source.mentions === undefined
    ? Object.freeze([])
    : Object.freeze(stringArray(source.mentions, `${label}.mentions`, 25, 2_048)
        .map((item, index) => canonicalMatrixUserId(item, `${label}.mentions[${index}]`)));
  const noPreview = source.no_preview === undefined ? false : bool(source.no_preview, `${label}.no_preview`);
  if (kind === "text") {
    if (text === null || text.length === 0) throw new Error(`${label}.text is required for text sends`);
    if (file !== null || filename !== null || mimeType !== null || durationSeconds !== null) throw new Error(`${label} file fields are unsupported for text sends`);
  } else {
    if (file === null) throw new Error(`${label}.file is required for ${kind} sends`);
    if (mentions.length > 0 || noPreview) throw new Error(`${label} mentions and no_preview are text-only`);
    if (kind !== "file" && text !== null) throw new Error(`${label}.text is supported only for text and file sends`);
    if (kind !== "voice" && durationSeconds !== null) throw new Error(`${label}.duration_seconds is voice-only`);
    if (kind === "sticker" && mimeType !== null && mimeType !== "image/webp") throw new Error(`${label}.mime_type must be image/webp for stickers`);
    if (kind === "voice" && mimeType !== null && !["audio/ogg", "audio/opus"].includes(mimeType)) throw new Error(`${label}.mime_type must be audio/ogg or audio/opus for voice notes`);
  }
  return Object.freeze({ ...conversationInput(source, label), kind, text, file, filename, mimeType, durationSeconds, replyTo, mentions, noPreview });
}

export function parseBeeperOperationInput(
  action: BeeperLocalOperationName,
  input: OperationInput,
): BeeperOperationInput {
  if (action === "contacts.list") return parseBeeperContactsListInput(input);
  if (action === "contacts.search") return parseBeeperContactsSearchInput(input);
  if (action === "messaging.list") return parseBeeperMessagingListInput(input);
  if (action === "messaging.search") return parseBeeperMessagingSearchInput(input);
  if (action === "messaging.read") return parseBeeperMessagingReadInput(input);
  if (action === "messaging.content.search") return parseMessageSearchInput(input);
  const label = `${action} input`;
  const source = record(input, label);
  if (action === "accounts.list") {
    exactKeys(source, [], [], label);
    return Object.freeze({});
  }
  if (action === "accounts.read") {
    exactKeys(source, ["account_id"], [], label);
    return Object.freeze({ accountId: accountId(source, label) });
  }
  if (action === "bridges.list") {
    exactKeys(source, [], ["provider", "available", "limit"], label);
    return Object.freeze({
      provider: optionalEnum(source.provider, `${label}.provider`, ["local", "cloud", "self-hosted"] as const),
      available: optionalBool(source.available, `${label}.available`),
      limit: source.limit === undefined ? 128 : integer(source.limit, `${label}.limit`, 1, 128),
    });
  }
  if (action === "bridges.read") {
    exactKeys(source, ["bridge_id"], [], label);
    const bridgeId = boundedOpaque(source.bridge_id, `${label}.bridge_id`, 512);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(bridgeId)) {
      throw new Error(`${label}.bridge_id must be one canonical bridge ID`);
    }
    return Object.freeze({ bridgeId });
  }
  if (action === "contacts.read") {
    exactKeys(source, ["account_id", "contact_id"], [], label);
    return Object.freeze({
      accountId: accountId(source, label),
      contactId: boundedOpaque(source.contact_id, `${label}.contact_id`, 2_048),
    });
  }
  if (action === "conversations.read") {
    exactKeys(source, ["account_id", "conversation_id"], ["max_participants"], label);
    return Object.freeze({
      ...conversationInput(source, label),
      maxParticipants: source.max_participants === undefined
        ? 200
        : integer(source.max_participants, `${label}.max_participants`, 1, 500),
    });
  }
  if (action === "messaging.message.read") {
    exactKeys(source, ["account_id", "conversation_id", "message_id"], [], label);
    return Object.freeze({ ...conversationInput(source, label), messageId: messageId(source, label) });
  }
  if (action === "messaging.context.read") {
    exactKeys(source, ["account_id", "conversation_id", "message_id"], ["before", "after"], label);
    return Object.freeze({
      ...conversationInput(source, label),
      messageId: messageId(source, label),
      before: source.before === undefined ? 10 : integer(source.before, `${label}.before`, 0, 100),
      after: source.after === undefined ? 10 : integer(source.after, `${label}.after`, 0, 100),
    });
  }
  if (action === "messaging.send") return parseSendInput(input);
  if (action === "reactions.set") {
    exactKeys(source, ["account_id", "conversation_id", "message_id", "reaction", "enabled"], [], label);
    return Object.freeze({
      ...conversationInput(source, label),
      messageId: messageId(source, label),
      reaction: boundedText(source.reaction, `${label}.reaction`, 256),
      enabled: bool(source.enabled, `${label}.enabled`),
    });
  }
  if (action === "messaging.edit") {
    exactKeys(source, ["account_id", "conversation_id", "message_id", "text"], [], label);
    return Object.freeze({
      ...conversationInput(source, label),
      messageId: messageId(source, label),
      text: boundedText(source.text, `${label}.text`, 65_536),
    });
  }
  if (action === "conversations.start") {
    exactKeys(source, ["account_id", "user_id"], [], label);
    return Object.freeze({
      accountId: accountId(source, label),
      userId: canonicalMatrixUserId(source.user_id, `${label}.user_id`),
    });
  }
  if (["conversations.archive.set", "conversations.pin.set", "conversations.mute.set"].includes(action)) {
    exactKeys(source, ["account_id", "conversation_id", "enabled"], [], label);
    return Object.freeze({
      ...conversationInput(source, label),
      enabled: bool(source.enabled, `${label}.enabled`),
    });
  }
  if (action === "conversations.read-state.set") {
    exactKeys(source, ["account_id", "conversation_id", "unread"], ["message_id"], label);
    return Object.freeze({
      ...conversationInput(source, label),
      unread: bool(source.unread, `${label}.unread`),
      messageId: optionalOpaque(source.message_id, `${label}.message_id`, 2_048),
    });
  }
  if (action === "conversations.priority.set") {
    exactKeys(source, ["account_id", "conversation_id", "level"], [], label);
    return Object.freeze({
      ...conversationInput(source, label),
      level: exactEnum(source.level, `${label}.level`, ["inbox", "low"] as const),
    });
  }
  if (action === "conversations.notify") {
    exactKeys(source, ["account_id", "conversation_id"], [], label);
    return conversationInput(source, label);
  }
  if (action === "conversations.title.set") {
    exactKeys(source, ["account_id", "conversation_id", "title"], [], label);
    return Object.freeze({
      ...conversationInput(source, label),
      value: boundedText(source.title, `${label}.title`, 1_024),
    });
  }
  if (action === "conversations.description.set") {
    exactKeys(source, ["account_id", "conversation_id", "clear"], ["description"], label);
    const clear = bool(source.clear, `${label}.clear`);
    const value = optionalText(source.description, `${label}.description`, 65_536);
    if (clear === (value !== null)) throw new Error(`${label} requires exactly one of clear or description`);
    if (value !== null && value.length === 0) {
      throw new Error(`${label}.description must be nonempty bounded text`);
    }
    return Object.freeze({ ...conversationInput(source, label), value });
  }
  if (action === "conversations.avatar.set") {
    exactKeys(source, ["account_id", "conversation_id", "clear"], ["avatar"], label);
    const clear = bool(source.clear, `${label}.clear`);
    const file = optionalFile(source.avatar, `${label}.avatar`);
    if (clear === (file !== null)) throw new Error(`${label} requires exactly one of clear or avatar`);
    return Object.freeze({ ...conversationInput(source, label), file });
  }
  if (action === "conversations.draft.set") {
    exactKeys(source, ["account_id", "conversation_id", "clear"], ["text", "attachment", "filename", "mime_type"], label);
    const clear = bool(source.clear, `${label}.clear`);
    const text = optionalText(source.text, `${label}.text`, 65_536);
    const file = optionalFile(source.attachment, `${label}.attachment`);
    const filename = optionalOpaque(source.filename, `${label}.filename`, 512);
    const mimeType = optionalOpaque(source.mime_type, `${label}.mime_type`, 128);
    if (clear && (text !== null || file !== null || filename !== null || mimeType !== null)) throw new Error(`${label}.clear cannot include draft content`);
    if (!clear && text === null) throw new Error(`${label} requires text when setting a draft`);
    if (file === null && (filename !== null || mimeType !== null)) throw new Error(`${label} attachment metadata requires attachment`);
    return Object.freeze({ ...conversationInput(source, label), text, file, filename, mimeType, clear });
  }
  if (action === "conversations.disappearing.set") {
    exactKeys(source, ["account_id", "conversation_id", "seconds"], [], label);
    return Object.freeze({
      ...conversationInput(source, label),
      seconds: integer(source.seconds, `${label}.seconds`, 0, 31_536_000),
    });
  }
  if (action === "conversations.reminder.set") {
    exactKeys(source, ["account_id", "conversation_id", "clear"], ["when", "dismiss_on_message"], label);
    const clear = bool(source.clear, `${label}.clear`);
    const when = optionalTimestamp(source.when, `${label}.when`);
    if (clear === (when !== null)) throw new Error(`${label} requires exactly one of clear or when`);
    const dismissOnMessage = source.dismiss_on_message === undefined
      ? false
      : bool(source.dismiss_on_message, `${label}.dismiss_on_message`);
    if (clear && dismissOnMessage) throw new Error(`${label}.dismiss_on_message requires when`);
    return Object.freeze({ ...conversationInput(source, label), when, dismissOnMessage });
  }
  if (action === "conversations.focus") {
    exactKeys(source, ["account_id", "conversation_id"], ["message_id", "draft", "attachment"], label);
    return Object.freeze({
      ...conversationInput(source, label),
      messageId: optionalOpaque(source.message_id, `${label}.message_id`, 2_048),
      draft: optionalText(source.draft, `${label}.draft`, 65_536),
      attachment: optionalFile(source.attachment, `${label}.attachment`),
    });
  }
  exactKeys(source, ["account_id", "conversation_id", "state"], ["duration_seconds"], label);
  const state = exactEnum(source.state, `${label}.state`, ["typing", "paused"] as const);
  const durationSeconds = source.duration_seconds === undefined
    ? null
    : integer(source.duration_seconds, `${label}.duration_seconds`, 1, 30);
  if (state === "paused" && durationSeconds !== null) throw new Error(`${label}.duration_seconds applies only to typing`);
  return Object.freeze({ ...conversationInput(source, label), state, durationSeconds });
}

function timeoutArgument(timeoutMs: number): string {
  return `${Math.max(1, Math.min(3_600, Math.ceil(timeoutMs / 1_000)))}s`;
}
function readArguments(timeoutMs: number): readonly string[] {
  return Object.freeze(["--read-only", "--json", "--full", "--quiet", "--target", BEEPER_DESKTOP_TARGET, "--timeout", timeoutArgument(timeoutMs)]);
}
function writeArguments(timeoutMs: number): readonly string[] {
  return Object.freeze(["--json", "--full", "--quiet", "--yes", "--target", BEEPER_DESKTOP_TARGET, "--timeout", timeoutArgument(timeoutMs)]);
}
function booleanFlag(name: string, value: boolean | null): readonly string[] {
  return value === null ? [] : [value ? `--${name}` : `--no-${name}`];
}
function command(action: BeeperCommand["action"], argv: readonly string[], mutation: boolean): BeeperCommand {
  return Object.freeze({ action, argv: Object.freeze(argv), mutation });
}

export function planBeeperAccountsListCommand(timeoutMs: number): BeeperReadCommand {
  return command("accounts.list", ["accounts", "list", ...readArguments(timeoutMs)], false);
}

/** Exact pinned-tool preflight; it is never exposed as a caller operation. */
export function planBeeperVersionCommand(): BeeperReadCommand {
  return command(
    "version",
    ["version", "--read-only", "--json", "--quiet"],
    false,
  );
}

/** Private realm preflight; it is never exposed as a caller operation. */
export function planBeeperTargetStatusCommand(timeoutMs: number): BeeperReadCommand {
  return command(
    "target-status",
    ["targets", "status", BEEPER_DESKTOP_TARGET, ...readArguments(timeoutMs)],
    false,
  );
}

export function planBeeperOperationCommand(
  action: BeeperLocalOperationName,
  input: BeeperOperationInput,
  timeoutMs: number,
  resolvedFilePath?: string,
): BeeperCommand {
  const read = readArguments(timeoutMs);
  const write = writeArguments(timeoutMs);
  if (action === "accounts.list") return command(action, ["accounts", "list", ...read], false);
  if (action === "accounts.read") return command(action, ["accounts", "show", (input as AccountInput).accountId, ...read], false);
  if (action === "bridges.list") {
    const value = input as BridgeListInput;
    return command(action, [
      "bridges", "list",
      ...(value.provider === null ? [] : ["--provider", value.provider]),
      ...booleanFlag("available", value.available),
      ...read,
    ], false);
  }
  if (action === "bridges.read") return command(action, ["bridges", "show", (input as BridgeInput).bridgeId, ...read], false);
  if (action === "contacts.list") {
    const value = input as BeeperContactsListInput;
    return command(action, [
      "contacts", "list",
      "--limit", String(value.limit),
      ...(value.accountId === null ? [] : ["--account", value.accountId]),
      ...read,
    ], false);
  }
  if (action === "contacts.search") {
    const value = input as BeeperContactsSearchInput;
    return command(action, [
      "contacts", "search", value.query,
      ...(value.accountId === null ? [] : ["--account", value.accountId]),
      ...read,
    ], false);
  }
  if (action === "contacts.read") {
    const value = input as ContactInput;
    return command(action, ["contacts", "show", value.contactId, "--account", value.accountId, ...read], false);
  }
  if (action === "messaging.list") {
    const value = input as BeeperMessagingListInput;
    return command(action, [
      "chats", "list", "--limit", String(value.limit),
      ...(value.accountId === null ? [] : ["--account", value.accountId]),
      ...booleanFlag("archived", value.archived),
      ...booleanFlag("pinned", value.pinned),
      ...booleanFlag("muted", value.muted),
      ...booleanFlag("unread", value.unread),
      ...booleanFlag("low-priority", value.lowPriority),
      ...read,
    ], false);
  }
  if (action === "messaging.search") {
    const value = input as BeeperMessagingSearchInput;
    return command(action, [
      "chats", "search", value.query, "--limit", String(value.limit),
      ...(value.accountId === null ? [] : ["--account", value.accountId]),
      ...read,
    ], false);
  }
  if (action === "conversations.read") {
    const value = input as ConversationReadInput;
    return command(action, [
      "chats", "show", "--chat", value.conversationId,
      "--max-participants", String(value.maxParticipants), ...read,
    ], false);
  }
  if (action === "messaging.read") {
    const value = input as BeeperMessagingReadInput;
    return command(action, [
      "messages", "list", "--chat", value.conversationId,
      "--limit", String(value.limit),
      ...(value.beforeCursor === null ? [] : ["--before-cursor", value.beforeCursor]),
      ...(value.afterCursor === null ? [] : ["--after-cursor", value.afterCursor]),
      ...read,
    ], false);
  }
  if (action === "messaging.content.search") {
    const value = input as BeeperMessageContentSearchInput;
    return command(action, [
      "messages", "search",
      ...(value.query === null ? [] : [value.query]),
      ...(value.accountId === null ? [] : ["--account", value.accountId]),
      ...(value.conversationId === null ? [] : ["--chat", value.conversationId]),
      ...(value.chatType === null ? [] : ["--chat-type", value.chatType]),
      ...(value.after === null ? [] : ["--after", value.after]),
      ...(value.before === null ? [] : ["--before", value.before]),
      ...booleanFlag("exclude-low-priority", value.excludeLowPriority),
      ...booleanFlag("include-muted", value.includeMuted),
      ...value.media.flatMap((item) => ["--media", item]),
      ...(value.sender === null ? [] : ["--sender", value.sender]),
      "--limit", String(value.limit), ...read,
    ], false);
  }
  if (action === "messaging.message.read") {
    const value = input as MessageInput;
    return command(action, [
      "messages", "show", "--chat", value.conversationId,
      "--id", value.messageId, ...read,
    ], false);
  }
  if (action === "messaging.context.read") {
    const value = input as MessageContextInput;
    return command(action, [
      "messages", "context", "--chat", value.conversationId,
      "--id", value.messageId, "--before", String(value.before),
      "--after", String(value.after), ...read,
    ], false);
  }
  if (action === "messaging.send") {
    const value = input as SendInput;
    const base = ["send", value.kind, "--to", value.conversationId];
    if (value.kind === "text") base.push("--message", value.text!);
    else {
      if (resolvedFilePath === undefined || !isAbsolute(resolvedFilePath)) {
        throw new Error(`${action} requires one resolved absolute plan-bound file`);
      }
      base.push("--file", resolvedFilePath);
      if (value.kind === "file" && value.text !== null) base.push("--caption", value.text);
      if (value.filename !== null) base.push("--filename", value.filename);
      if (value.mimeType !== null) base.push("--mime", value.mimeType);
      if (value.durationSeconds !== null) base.push("--duration", String(value.durationSeconds));
    }
    if (value.replyTo !== null) base.push("--reply-to", value.replyTo);
    for (const mention of value.mentions) base.push("--mention", mention);
    if (value.noPreview) base.push("--no-preview");
    base.push(...write);
    return command(action, base, true);
  }
  if (action === "reactions.set") {
    const value = input as ReactionInput;
    return command(action, [
      "send", value.enabled ? "react" : "unreact",
      "--to", value.conversationId, "--id", value.messageId,
      "--reaction", value.reaction, ...write,
    ], true);
  }
  if (action === "messaging.edit") {
    const value = input as EditInput;
    return command(action, [
      "messages", "edit", "--chat", value.conversationId,
      "--id", value.messageId, "--message", value.text, ...write,
    ], true);
  }
  if (action === "conversations.start") {
    const value = input as StartInput;
    return command(action, [
      "chats", "start", value.userId, "--account", value.accountId,
      ...write,
    ], true);
  }
  const conversation = input as ConversationInput;
  if (action === "conversations.archive.set" || action === "conversations.pin.set" || action === "conversations.mute.set") {
    const verb = action === "conversations.archive.set"
      ? "archive"
      : action === "conversations.pin.set" ? "pin" : "mute";
    const enabled = (input as BooleanStateInput).enabled;
    return command(action, [
      "chats", enabled ? verb : `un${verb}`,
      "--chat", conversation.conversationId, ...write,
    ], true);
  }
  if (action === "conversations.read-state.set") {
    const value = input as ReadStateInput;
    return command(action, [
      "chats", value.unread ? "mark-unread" : "mark-read",
      "--chat", value.conversationId,
      ...(value.messageId === null ? [] : ["--message", value.messageId]), ...write,
    ], true);
  }
  if (action === "conversations.priority.set") {
    const value = input as PriorityInput;
    return command(action, [
      "chats", "priority", "--chat", value.conversationId,
      "--level", value.level, ...write,
    ], true);
  }
  if (action === "conversations.notify") {
    return command(action, [
      "chats", "notify-anyway", "--chat", conversation.conversationId, ...write,
    ], true);
  }
  if (action === "conversations.title.set") {
    return command(action, [
      "chats", "rename", "--chat", conversation.conversationId,
      "--title", (input as TextStateInput).value!, ...write,
    ], true);
  }
  if (action === "conversations.description.set") {
    const value = input as TextStateInput;
    return command(action, [
      "chats", "description", "--chat", value.conversationId,
      ...(value.value === null ? ["--clear"] : ["--description", value.value]),
      ...write,
    ], true);
  }
  if (action === "conversations.avatar.set") {
    const value = input as FileStateInput;
    if (value.file !== null && (resolvedFilePath === undefined || !isAbsolute(resolvedFilePath))) {
      throw new Error(`${action} requires one resolved absolute plan-bound file`);
    }
    return command(action, [
      "chats", "avatar", "--chat", value.conversationId,
      ...(value.file === null ? ["--clear"] : ["--file", resolvedFilePath!]),
      ...write,
    ], true);
  }
  if (action === "conversations.draft.set") {
    const value = input as DraftInput;
    if (value.file !== null && (resolvedFilePath === undefined || !isAbsolute(resolvedFilePath))) {
      throw new Error(`${action} requires one resolved absolute plan-bound file`);
    }
    return command(action, [
      "chats", "draft", "--chat", value.conversationId,
      ...(value.clear ? ["--clear"] : []),
      ...(value.text === null ? [] : ["--text", value.text]),
      ...(value.file === null ? [] : ["--file", resolvedFilePath!]),
      ...(value.filename === null ? [] : ["--filename", value.filename]),
      ...(value.mimeType === null ? [] : ["--mime", value.mimeType]), ...write,
    ], true);
  }
  if (action === "conversations.disappearing.set") {
    const value = input as DisappearingInput;
    return command(action, [
      "chats", "disappear", "--chat", value.conversationId,
      "--seconds", value.seconds === 0 ? "off" : String(value.seconds), ...write,
    ], true);
  }
  if (action === "conversations.reminder.set") {
    const value = input as ReminderInput;
    return command(action, [
      "chats", value.when === null ? "unremind" : "remind",
      "--chat", value.conversationId,
      ...(value.when === null ? [] : ["--when", value.when]),
      ...(value.dismissOnMessage ? ["--dismiss-on-message"] : []), ...write,
    ], true);
  }
  if (action === "conversations.focus") {
    const value = input as FocusInput;
    if (value.attachment !== null && (resolvedFilePath === undefined || !isAbsolute(resolvedFilePath))) {
      throw new Error(`${action} requires one resolved absolute plan-bound file`);
    }
    return command(action, [
      "chats", "focus", "--chat", value.conversationId,
      ...(value.messageId === null ? [] : ["--message", value.messageId]),
      ...(value.draft === null ? [] : ["--draft", value.draft]),
      ...(value.attachment === null ? [] : ["--attachment", resolvedFilePath!]),
      ...write,
    ], true);
  }
  const value = input as PresenceInput;
  return command(action, [
    "presence", "--chat", value.conversationId, "--state", value.state,
    ...write,
  ], true);
}

/**
 * A duration is two explicit provider dispatches. Never pass upstream
 * `--duration`, which would hide the paused post inside one child process.
 */
export function planBeeperPresenceCommands(
  input: BeeperOperationInput,
  timeoutMs: number,
): readonly BeeperCommand[] {
  const value = input as PresenceInput;
  const first = planBeeperOperationCommand("presence.set", value, timeoutMs);
  if (value.durationSeconds === null) return Object.freeze([first]);
  const paused = Object.freeze({ ...value, state: "paused" as const, durationSeconds: null });
  return Object.freeze([
    first,
    planBeeperOperationCommand("presence.set", paused, timeoutMs),
  ]);
}

export function planBeeperReadCommand(
  action: BeeperLocalOperationName,
  input: BeeperOperationInput,
  timeoutMs: number,
): BeeperReadCommand {
  const planned = planBeeperOperationCommand(action, input, timeoutMs);
  if (planned.mutation) throw new Error(`${action} is not a Beeper read operation`);
  return planned;
}

export function planBeeperMessageLikeMeExportCommand(
  options: BeeperMessageLikeMeExportCommandOptions,
  timeoutMs: number,
): readonly string[] {
  if (!isAbsolute(options.outputDirectory)) throw new Error("Beeper export output directory must be absolute");
  const maxParticipants = integer(options.maxParticipants, "Beeper export maxParticipants", 1, 2_000);
  const limitChats = integer(options.limitChats, "Beeper export limitChats", 1, 100_000);
  const limitMessages = integer(options.limitMessages, "Beeper export limitMessages", 1, 1_000_000);
  const timeoutSeconds = Math.max(1, Math.min(6 * 60 * 60, Math.ceil(timeoutMs / 1_000)));
  return Object.freeze([
    "export", "--out", options.outputDirectory, "--no-attachments",
    "--max-participants", String(maxParticipants), "--limit-chats", String(limitChats),
    "--limit-messages", String(limitMessages), "--read-only", "--quiet",
    "--target", BEEPER_DESKTOP_TARGET, "--timeout", `${timeoutSeconds}s`,
  ]);
}

export function isBeeperLocalOperation(value: string): value is BeeperLocalOperationName {
  return BEEPER_LOCAL_OPERATION_NAMES.includes(value as BeeperLocalOperationName);
}

export type BeeperCliCoverage =
  | Readonly<{ state: "supported"; operation: BeeperLocalOperationName }>
  | Readonly<{
      state: "internal-preflight";
      purpose: "desktop-target-realm-proof" | "pinned-tool-version-proof";
    }>
  | Readonly<{
      state: "unavailable";
      reason:
        | "installation-lifecycle"
        | "target-lifecycle"
        | "authentication-and-verification"
        | "account-lifecycle-r4"
        | "destructive-message-deletion-r4"
        | "caller-path-media-or-export"
        | "unbounded-event-stream"
        | "raw-api-or-rpc"
        | "cli-extension-or-configuration"
        | "cli-maintenance-or-documentation";
    }>;

const supported = (operation: BeeperLocalOperationName): BeeperCliCoverage =>
  Object.freeze({ state: "supported", operation });
const internalPreflight = (
  purpose: Extract<BeeperCliCoverage, { state: "internal-preflight" }>[
    "purpose"
  ],
): BeeperCliCoverage => Object.freeze({
  state: "internal-preflight",
  purpose,
});
const unavailable = (
  reason: Extract<BeeperCliCoverage, { state: "unavailable" }>["reason"],
): BeeperCliCoverage => Object.freeze({ state: "unavailable", reason });

/** Exact command inventory emitted by official Beeper CLI v0.6.2 `man --json`. */
export const BEEPER_CLI_COMMAND_COVERAGE = Object.freeze({
  "setup": unavailable("installation-lifecycle"),
  "install desktop": unavailable("installation-lifecycle"),
  "install server": unavailable("installation-lifecycle"),
  "targets list": unavailable("target-lifecycle"),
  "bridges list": supported("bridges.list"),
  "bridges show": supported("bridges.read"),
  "targets add desktop": unavailable("target-lifecycle"),
  "targets add server": unavailable("target-lifecycle"),
  "targets add remote": unavailable("target-lifecycle"),
  "targets use": unavailable("target-lifecycle"),
  "targets show": unavailable("target-lifecycle"),
  "targets status": internalPreflight("desktop-target-realm-proof"),
  "targets start": unavailable("target-lifecycle"),
  "targets stop": unavailable("target-lifecycle"),
  "targets restart": unavailable("target-lifecycle"),
  "targets logs": unavailable("target-lifecycle"),
  "targets enable": unavailable("target-lifecycle"),
  "targets disable": unavailable("target-lifecycle"),
  "targets remove": unavailable("target-lifecycle"),
  "targets tunnel": unavailable("target-lifecycle"),
  "auth status": unavailable("authentication-and-verification"),
  "auth logout": unavailable("authentication-and-verification"),
  "auth email start": unavailable("authentication-and-verification"),
  "auth email response": unavailable("authentication-and-verification"),
  "verify": unavailable("authentication-and-verification"),
  "verify status": unavailable("authentication-and-verification"),
  "verify approve": unavailable("authentication-and-verification"),
  "verify recovery-key": unavailable("authentication-and-verification"),
  "verify reset-recovery-key": unavailable("authentication-and-verification"),
  "verify cancel": unavailable("authentication-and-verification"),
  "verify list": unavailable("authentication-and-verification"),
  "verify start": unavailable("authentication-and-verification"),
  "verify show": unavailable("authentication-and-verification"),
  "verify sas": unavailable("authentication-and-verification"),
  "verify sas-confirm": unavailable("authentication-and-verification"),
  "verify qr-scan": unavailable("authentication-and-verification"),
  "verify qr-confirm": unavailable("authentication-and-verification"),
  "accounts list": supported("accounts.list"),
  "accounts add": unavailable("account-lifecycle-r4"),
  "accounts show": supported("accounts.read"),
  "accounts remove": unavailable("account-lifecycle-r4"),
  "accounts use": unavailable("account-lifecycle-r4"),
  "chats list": supported("messaging.list"),
  "chats search": supported("messaging.search"),
  "chats show": supported("conversations.read"),
  "chats start": supported("conversations.start"),
  "chats archive": supported("conversations.archive.set"),
  "chats unarchive": supported("conversations.archive.set"),
  "chats pin": supported("conversations.pin.set"),
  "chats unpin": supported("conversations.pin.set"),
  "chats mute": supported("conversations.mute.set"),
  "chats unmute": supported("conversations.mute.set"),
  "chats mark-read": supported("conversations.read-state.set"),
  "chats mark-unread": supported("conversations.read-state.set"),
  "chats priority": supported("conversations.priority.set"),
  "chats notify-anyway": supported("conversations.notify"),
  "chats rename": supported("conversations.title.set"),
  "chats description": supported("conversations.description.set"),
  "chats avatar": supported("conversations.avatar.set"),
  "chats draft": supported("conversations.draft.set"),
  "chats disappear": supported("conversations.disappearing.set"),
  "chats remind": supported("conversations.reminder.set"),
  "chats unremind": supported("conversations.reminder.set"),
  "chats focus": supported("conversations.focus"),
  "messages list": supported("messaging.read"),
  "messages search": supported("messaging.content.search"),
  "messages show": supported("messaging.message.read"),
  "messages context": supported("messaging.context.read"),
  "messages edit": supported("messaging.edit"),
  "messages delete": unavailable("destructive-message-deletion-r4"),
  "messages export": unavailable("caller-path-media-or-export"),
  "send text": supported("messaging.send"),
  "send file": supported("messaging.send"),
  "send react": supported("reactions.set"),
  "send sticker": supported("messaging.send"),
  "send unreact": supported("reactions.set"),
  "send voice": supported("messaging.send"),
  "presence": supported("presence.set"),
  "contacts list": supported("contacts.list"),
  "contacts search": supported("contacts.search"),
  "contacts show": supported("contacts.read"),
  "media download": unavailable("caller-path-media-or-export"),
  "export": unavailable("caller-path-media-or-export"),
  "watch": unavailable("unbounded-event-stream"),
  "rpc": unavailable("raw-api-or-rpc"),
  "man": unavailable("cli-maintenance-or-documentation"),
  "doctor": unavailable("target-lifecycle"),
  "status": unavailable("target-lifecycle"),
  "docs": unavailable("cli-maintenance-or-documentation"),
  "version": internalPreflight("pinned-tool-version-proof"),
  "completion": unavailable("cli-maintenance-or-documentation"),
  "plugins": unavailable("cli-extension-or-configuration"),
  "plugins available": unavailable("cli-extension-or-configuration"),
  "update": unavailable("cli-extension-or-configuration"),
  "config get": unavailable("cli-extension-or-configuration"),
  "config set": unavailable("cli-extension-or-configuration"),
  "config path": unavailable("cli-extension-or-configuration"),
  "config reset": unavailable("cli-extension-or-configuration"),
  "api get": unavailable("raw-api-or-rpc"),
  "api post": unavailable("raw-api-or-rpc"),
  "api request": unavailable("raw-api-or-rpc"),
} satisfies Readonly<Record<string, BeeperCliCoverage>>);

/** SHA-256 of JSON.stringify(the exact ordered v0.6.2 `man --json` command list). */
export const BEEPER_CLI_COMMAND_LIST_SHA256 =
  "5f86df11801a7d288e617000b591f6803fb5b9ba6aa0ba122913105b59041187" as const;
