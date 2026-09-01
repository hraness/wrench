/**
 * Fixed policy, input parsing, and argv planning for the official Beeper CLI.
 *
 * The provider never accepts a command, argv fragment, target, base URL, token,
 * path, or fuzzy chat selector from its caller. File arguments are plan-bound
 * references which the kernel materializes only after confirmation.
 */

import { isAbsolute } from "node:path";
import { types as nodeTypes } from "node:util";

import beeperAdapterManifest from "../assets/adapters/beeper/wrench-web-adapter.json";
import type { FileInputValue, OperationInput } from "../model";
import {
  defineLocalCliSurfaceContractV1,
  type LocalCliSurfaceArgumentV1,
  type LocalCliSurfaceAdditionalEntryV1,
  type LocalCliSurfaceCommandDefinitionV1,
  type LocalCliSurfaceDecisionV1,
  type LocalCliSurfaceDefaultV1,
  type LocalCliSurfaceFlagV1,
  type LocalCliSurfaceReconciliationV1,
} from "../local-cli-surface-contract";

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

export const BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS = Object.freeze({
  "accounts.list": 2,
  "accounts.read": 1,
  "bridges.list": 2,
  "bridges.read": 1,
  "contacts.list": 2,
  "contacts.search": 1,
  "contacts.read": 1,
  "messaging.list": 1,
  "messaging.search": 2,
  "conversations.read": 2,
  "messaging.read": 3,
  "messaging.content.search": 2,
  "messaging.message.read": 1,
  "messaging.context.read": 1,
  "messaging.send": 1,
  "reactions.set": 1,
  "messaging.edit": 1,
  "conversations.start": 1,
  "conversations.archive.set": 1,
  "conversations.pin.set": 1,
  "conversations.mute.set": 1,
  "conversations.read-state.set": 1,
  "conversations.priority.set": 1,
  "conversations.notify": 1,
  "conversations.title.set": 1,
  "conversations.description.set": 1,
  "conversations.avatar.set": 1,
  "conversations.draft.set": 1,
  "conversations.disappearing.set": 1,
  "conversations.reminder.set": 1,
  "conversations.focus": 1,
  "presence.set": 1,
} as const satisfies Readonly<Record<BeeperLocalOperationName, number>>);

export type BeeperLocalOperationContractVersion = 1 | 2 | 3;

const BEEPER_LOCAL_CONTRACT_V2_OPERATIONS = Object.freeze([
  "accounts.list",
  "bridges.list",
  "contacts.list",
  "messaging.search",
  "conversations.read",
  "messaging.read",
  "messaging.content.search",
] as const satisfies readonly BeeperLocalOperationName[]);

export function isBeeperLocalOperationContractVersion(
  action: BeeperLocalOperationName,
  contractVersion: number,
): contractVersion is BeeperLocalOperationContractVersion {
  return contractVersion === 1
    || contractVersion === 2
      && BEEPER_LOCAL_CONTRACT_V2_OPERATIONS.includes(
        action as typeof BEEPER_LOCAL_CONTRACT_V2_OPERATIONS[number],
      )
    || contractVersion === 3 && action === "messaging.read";
}

type BeeperLocalSurfaceInputType = "string" | "number" | "boolean" | "array" | "file";

function beeperLocalSurfaceInputType(value: unknown): BeeperLocalSurfaceInputType {
  if (
    value !== "string"
    && value !== "number"
    && value !== "boolean"
    && value !== "array"
    && value !== "file"
  ) throw new Error("Beeper adapter contains an unsupported operation input type");
  return value;
}

const adapterOperations = beeperAdapterManifest.operations as Readonly<Record<
  string,
  Readonly<{ input: Readonly<{ properties: Readonly<Record<string, Readonly<{ type: string }>>> }> }>
>>;

export const BEEPER_LOCAL_OPERATION_INPUT_TYPES = Object.freeze(Object.fromEntries(
  Object.keys(adapterOperations).sort().map((operation) => [
    operation,
    Object.freeze(Object.fromEntries(
      Object.keys(adapterOperations[operation]!.input.properties).sort().map((field) => [
        field,
        beeperLocalSurfaceInputType(
          adapterOperations[operation]!.input.properties[field]!.type,
        ),
      ]),
    )),
  ]),
)) as Readonly<Record<
  BeeperLocalOperationName,
  Readonly<Record<string, BeeperLocalSurfaceInputType>>
>>;

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

export type BeeperContactsListInputV1 = Readonly<{
  accountId: string | null;
  limit: number;
}>;
export type BeeperContactsListInput = BeeperContactsListInputV1 & Readonly<{
  query: string | null;
}>;
export type BeeperContactsSearchInput = BeeperContactsListInput & Readonly<{ query: string }>;
export type BeeperMessagingListInput = Readonly<{
  accountId: string | null;
  limit: number;
  archived: boolean | null;
  pinned: boolean | null;
  muted: boolean | null;
  unread: boolean | null;
  lowPriority: boolean | null;
}>;
export type BeeperMessagingSearchInput = BeeperContactsSearchInput;
export type BeeperMessagingReadInputV2 = Readonly<{
  accountId: string;
  conversationId: string;
  beforeCursor: string | null;
  afterCursor: string | null;
  limit: number;
}>;
export type BeeperMessagingReadInput = BeeperMessagingReadInputV2 & Readonly<{
  sender: "me" | "others" | string | null;
}>;

type EmptyInput = Readonly<Record<never, never>>;
type AccountInput = Readonly<{ accountId: string }>;
type BridgeListInput = Readonly<{
  provider: "local" | "cloud" | "self-hosted" | "platform-sdk" | null;
  available: boolean | null;
  limit: number;
}>;
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
  | BeeperContactsListInputV1 | BeeperContactsListInput | BeeperContactsSearchInput
  | BeeperMessagingListInput | BeeperMessagingSearchInput | ConversationReadInput
  | BeeperMessagingReadInputV2 | BeeperMessagingReadInput
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

function boundedControlFreeOpaque(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const opaque = boundedOpaque(value, label, maximum);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(opaque)) {
    throw new Error(`${label} must be bounded well-formed control-free opaque text`);
  }
  return opaque;
}

function optionalControlFreeOpaque(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  return value === undefined
    ? null
    : boundedControlFreeOpaque(value, label, maximum);
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
export function isCanonicalBeeperConversationId(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 2_048
    && hasWellFormedUnicode(value)
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && /^![^:\s]{1,255}:[^:\s]{1,255}(?::[0-9]{1,5})?$/u.test(value);
}
function conversationId(source: Readonly<Record<string, unknown>>, label: string): string {
  const id = boundedControlFreeOpaque(
    source.conversation_id,
    `${label}.conversation_id`,
    2_048,
  );
  if (!isCanonicalBeeperConversationId(id)) {
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
  if (sender.startsWith("-")) {
    throw new Error(`${label} must be one bounded opaque non-flag user ID`);
  }
  return sender;
}

function canonicalMessageSenderV3(value: unknown, label: string): string {
  const sender = boundedControlFreeOpaque(value, label, 2_048);
  if (sender === "me" || sender === "others") return sender;
  if (sender.startsWith("-")) {
    throw new Error(`${label} must be one bounded opaque non-flag user ID`);
  }
  return sender;
}
function conversationInput(source: Readonly<Record<string, unknown>>, label: string): ConversationInput {
  return Object.freeze({ accountId: accountId(source, label), conversationId: conversationId(source, label) });
}

function parseBeeperContactsListInputV1(
  input: OperationInput,
): BeeperContactsListInputV1 {
  const source = record(input, "contacts.list input");
  exactKeys(source, [], ["account_id", "limit"], "contacts.list input");
  return Object.freeze({
    accountId: optionalOpaque(source.account_id, "contacts.list input.account_id", 512),
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "contacts.list input.limit", 1, 200),
  });
}

export function parseBeeperContactsListInput(input: OperationInput): BeeperContactsListInput {
  const source = record(input, "contacts.list input");
  exactKeys(source, [], ["account_id", "query", "limit"], "contacts.list input");
  return Object.freeze({
    accountId: optionalOpaque(source.account_id, "contacts.list input.account_id", 512),
    query: source.query === undefined
      ? null
      : normalizedSearchQuery(source.query, "contacts.list input.query"),
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "contacts.list input.limit", 1, 200),
  });
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

export function parseBeeperMessagingReadInputV2(
  input: OperationInput,
): BeeperMessagingReadInputV2 {
  const source = record(input, "messaging.read input");
  exactKeys(source, ["account_id", "conversation_id"], ["before_cursor", "after_cursor", "limit"], "messaging.read input");
  const beforeCursor = optionalOpaque(source.before_cursor, "messaging.read input.before_cursor", 2_048);
  const afterCursor = optionalOpaque(source.after_cursor, "messaging.read input.after_cursor", 2_048);
  if (beforeCursor !== null && afterCursor !== null) throw new Error("messaging.read input accepts only one cursor direction");
  return Object.freeze({
    accountId: accountId(source, "messaging.read input"),
    conversationId: conversationId(source, "messaging.read input"),
    beforeCursor,
    afterCursor,
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "messaging.read input.limit", 1, 200),
  });
}

export function parseBeeperMessagingReadInput(input: OperationInput): BeeperMessagingReadInput {
  const source = record(input, "messaging.read input");
  exactKeys(source, ["account_id", "conversation_id"], ["before_cursor", "after_cursor", "sender", "limit"], "messaging.read input");
  const beforeCursor = optionalControlFreeOpaque(
    source.before_cursor,
    "messaging.read input.before_cursor",
    2_048,
  );
  const afterCursor = optionalControlFreeOpaque(
    source.after_cursor,
    "messaging.read input.after_cursor",
    2_048,
  );
  if (beforeCursor !== null && afterCursor !== null) throw new Error("messaging.read input accepts only one cursor direction");
  return Object.freeze({
    accountId: accountId(source, "messaging.read input"),
    conversationId: conversationId(source, "messaging.read input"),
    beforeCursor,
    afterCursor,
    sender: source.sender === undefined
      ? null
      : canonicalMessageSenderV3(source.sender, "messaging.read input.sender"),
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "messaging.read input.limit", 1, 200),
  });
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

export function parseBeeperOperationInputForContract(
  action: BeeperLocalOperationName,
  contractVersion: number,
  input: OperationInput,
): BeeperOperationInput {
  if (!isBeeperLocalOperationContractVersion(action, contractVersion)) {
    throw new Error(`${action}@${String(contractVersion)} is not an installed Beeper contract`);
  }
  if (action === "contacts.list") {
    return contractVersion === 1
      ? parseBeeperContactsListInputV1(input)
      : parseBeeperContactsListInput(input);
  }
  if (action === "contacts.search") return parseBeeperContactsSearchInput(input);
  if (action === "messaging.list") return parseBeeperMessagingListInput(input);
  if (action === "messaging.search") return parseBeeperMessagingSearchInput(input);
  if (action === "messaging.read") {
    return contractVersion === 3
      ? parseBeeperMessagingReadInput(input)
      : parseBeeperMessagingReadInputV2(input);
  }
  if (action === "messaging.content.search") {
    const parsed = parseMessageSearchInput(input);
    if (
      contractVersion === 1
      && (parsed.beforeCursor !== null || parsed.afterCursor !== null)
    ) throw new Error("Beeper message search cursor input requires direct-read contract v2");
    return parsed;
  }
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
      provider: contractVersion === 1
        ? optionalEnum(source.provider, `${label}.provider`, [
            "local", "cloud", "self-hosted",
          ] as const)
        : optionalEnum(source.provider, `${label}.provider`, [
            "local", "cloud", "self-hosted", "platform-sdk",
          ] as const),
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

export function parseBeeperOperationInput(
  action: BeeperLocalOperationName,
  input: OperationInput,
): BeeperOperationInput {
  return parseBeeperOperationInputForContract(
    action,
    BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS[action],
    input,
  );
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
      ...(value.provider === null || value.provider === "platform-sdk"
        ? []
        : ["--provider", value.provider]),
      ...booleanFlag("available", value.available),
      ...read,
    ], false);
  }
  if (action === "bridges.read") return command(action, ["bridges", "show", (input as BridgeInput).bridgeId, ...read], false);
  if (action === "contacts.list") {
    const value = input as BeeperContactsListInput | BeeperContactsListInputV1;
    return command(action, [
      "contacts", "list",
      "--limit", String(value.limit),
      ...(value.accountId === null ? [] : ["--account", value.accountId]),
      ...(!("query" in value) || value.query === null ? [] : ["--query", value.query]),
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
    const value = input as BeeperMessagingReadInput | BeeperMessagingReadInputV2;
    if ("sender" in value) {
      throw new Error(
        "messaging.read contract v3 is direct-only and cannot be planned through the Beeper CLI",
      );
    }
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

type BeeperCliV062ArgumentProfile = readonly [
  name: string,
  required: boolean,
  enumValues?: readonly string[],
];

type BeeperCliV062FlagProfile = readonly [
  name: string,
  aliases: readonly string[],
  valueType: "string" | "number" | "boolean",
  required: boolean,
  multiple: boolean,
  enumValues: readonly string[],
  defaultValue: string | number | boolean | null,
];

type BeeperCliV062CommandProfile = readonly [
  command: string,
  mutates: boolean,
  output: "data" | "list" | "manual" | "send-result" | "stream" | "success",
  arguments: readonly BeeperCliV062ArgumentProfile[],
  flags: readonly BeeperCliV062FlagProfile[],
];

/**
 * Exact normalized arguments, command flags, defaults, mutation bit, and
 * output category in the 101 entries of the official v0.6.2 generated manual.
 * Global flags are represented once in BEEPER_CLI_V062_GLOBAL_FLAGS below.
 */
const BEEPER_CLI_V062_COMMAND_PROFILES = Object.freeze([
  ["setup",true,"success",[],[["--channel",[],"string",false,false,["stable","nightly"],"stable"],["--desktop",[],"boolean",false,false,[],null],["--email",[],"string",false,false,[],null],["--install",[],"boolean",false,false,[],null],["--local",[],"boolean",false,false,[],null],["--oauth",[],"boolean",false,false,[],null],["--remote",[],"string",false,false,[],null],["--server",[],"boolean",false,false,[],null],["--server-env",[],"string",false,false,["production","staging"],"production"],["--username",[],"string",false,false,[],null]]],
  ["install desktop",true,"success",[],[["--channel",[],"string",false,false,["stable","nightly"],"stable"]]],
  ["install server",true,"success",[],[["--channel",[],"string",false,false,["stable","nightly"],"stable"],["--server-env",[],"string",false,false,["production","staging"],"production"]]],
  ["targets list",false,"list",[],[]],
  ["bridges list",false,"list",[],[["--available",[],"boolean",false,false,[],null],["--provider",[],"string",false,false,["local","cloud","self-hosted"],null]]],
  ["bridges show",false,"data",[["bridge",true]],[]],
  ["targets add desktop",true,"success",[["name",false]],[["--default",[],"boolean",false,false,[],null],["--port",[],"number",false,false,[],null],["--server-env",[],"string",false,false,["production","staging"],"production"]]],
  ["targets add server",true,"success",[["name",false]],[["--default",[],"boolean",false,false,[],null],["--port",[],"number",false,false,[],null],["--server-env",[],"string",false,false,["production","staging"],"production"]]],
  ["targets add remote",true,"success",[["name",true],["url",true]],[["--default",[],"boolean",false,false,[],null]]],
  ["targets use",true,"success",[["name",true]],[]],
  ["targets show",false,"data",[["name",false]],[]],
  ["targets status",false,"data",[["name",false]],[]],
  ["targets start",true,"success",[["name",false]],[]],
  ["targets stop",true,"success",[["name",false]],[]],
  ["targets restart",true,"success",[["name",false]],[]],
  ["targets logs",false,"data",[["name",false]],[["--all",[],"boolean",false,false,[],null],["--files",[],"number",false,false,[],5],["--lines",[],"number",false,false,[],200]]],
  ["targets enable",true,"success",[["name",false]],[]],
  ["targets disable",true,"success",[["name",false]],[]],
  ["targets remove",true,"success",[["name",true]],[]],
  ["targets tunnel",false,"data",[["name",false]],[["--install",[],"boolean",false,false,[],false],["--cloudflared-path",[],"string",false,false,[],null],["--retries",[],"number",false,false,[],5],["--url-only",[],"boolean",false,false,[],false]]],
  ["auth status",false,"data",[],[]],
  ["auth logout",true,"success",[],[]],
  ["auth email start",true,"success",[],[["--email",[],"string",true,false,[],null]]],
  ["auth email response",false,"data",[],[["--code",[],"string",true,false,[],null],["--setup-request-id",[],"string",true,false,[],null],["--username",[],"string",false,false,[],null],["--yes",[],"boolean",false,false,[],false]]],
  ["verify",false,"data",[],[["--user",[],"string",false,false,[],null]]],
  ["verify status",false,"data",[],[]],
  ["verify approve",true,"success",[],[["--id",[],"string",false,false,[],null]]],
  ["verify recovery-key",true,"success",[],[["--key",[],"string",true,false,[],null]]],
  ["verify reset-recovery-key",true,"success",[],[]],
  ["verify cancel",true,"success",[],[["--id",[],"string",false,false,[],null]]],
  ["verify list",false,"list",[],[]],
  ["verify start",true,"success",[],[["--user",[],"string",false,false,[],null]]],
  ["verify show",false,"data",[],[]],
  ["verify sas",true,"success",[],[["--id",[],"string",false,false,[],null]]],
  ["verify sas-confirm",true,"success",[],[["--id",[],"string",false,false,[],null]]],
  ["verify qr-scan",true,"success",[],[["--id",[],"string",false,false,[],null],["--payload",[],"string",true,false,[],null]]],
  ["verify qr-confirm",true,"success",[],[["--id",[],"string",false,false,[],null]]],
  ["accounts list",false,"list",[],[["--account",[],"string",false,true,[],null],["--ids",[],"boolean",false,false,[],null]]],
  ["accounts add",true,"success",[["bridge",false]],[["--cookie",[],"string",false,true,[],null],["--field",[],"string",false,true,[],null],["--flow",[],"string",false,false,[],null],["--guided",[],"boolean",false,false,[],true],["--login-id",[],"string",false,false,[],null],["--non-interactive",[],"boolean",false,false,[],null],["--webview",[],"boolean",false,false,[],null],["--webview-backend",[],"string",false,false,["auto","chrome","webkit"],"chrome"],["--webview-timeout",[],"number",false,false,[],120]]],
  ["accounts show",false,"data",[["account",true]],[]],
  ["accounts remove",true,"success",[["account",true]],[]],
  ["accounts use",true,"success",[["account",true]],[]],
  ["chats list",false,"list",[],[["--account",[],"string",false,true,[],null],["--archived",[],"boolean",false,false,[],null],["--ids",[],"boolean",false,false,[],null],["--limit",[],"number",false,false,[],20],["--low-priority",[],"boolean",false,false,[],null],["--muted",[],"boolean",false,false,[],null],["--pinned",[],"boolean",false,false,[],null],["--unread",[],"boolean",false,false,[],null]]],
  ["chats search",false,"list",[["query",true]],[["--account",[],"string",false,true,[],null],["--ids",[],"boolean",false,false,[],null],["--limit",[],"number",false,false,[],20]]],
  ["chats show",false,"data",[],[["--chat",[],"string",true,false,[],null],["--max-participants",[],"number",false,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats start",true,"success",[["user",true]],[["--account",[],"string",false,false,[],null],["--title",[],"string",false,false,[],null]]],
  ["chats archive",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats unarchive",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats pin",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats unpin",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats mute",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats unmute",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats mark-read",true,"success",[],[["--chat",[],"string",true,false,[],null],["--message",[],"string",false,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats mark-unread",true,"success",[],[["--chat",[],"string",true,false,[],null],["--message",[],"string",false,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats priority",true,"success",[],[["--chat",[],"string",true,false,[],null],["--level",[],"string",true,false,["inbox","low"],null],["--pick",[],"number",false,false,[],null]]],
  ["chats notify-anyway",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats rename",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null],["--title",[],"string",true,false,[],null]]],
  ["chats description",true,"success",[],[["--chat",[],"string",true,false,[],null],["--clear",[],"boolean",false,false,[],null],["--description",[],"string",false,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats avatar",true,"success",[],[["--chat",[],"string",true,false,[],null],["--clear",[],"boolean",false,false,[],null],["--file",[],"string",false,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats draft",true,"success",[],[["--chat",[],"string",true,false,[],null],["--clear",[],"boolean",false,false,[],null],["--file",[],"string",false,false,[],null],["--filename",[],"string",false,false,[],null],["--mime",[],"string",false,false,[],null],["--pick",[],"number",false,false,[],null],["--text",[],"string",false,false,[],null]]],
  ["chats disappear",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null],["--seconds",[],"string",true,false,[],null]]],
  ["chats remind",true,"success",[],[["--chat",[],"string",true,false,[],null],["--dismiss-on-message",[],"boolean",false,false,[],null],["--pick",[],"number",false,false,[],null],["--when",[],"string",true,false,[],null]]],
  ["chats unremind",true,"success",[],[["--chat",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["chats focus",true,"success",[],[["--attachment",[],"string",false,false,[],null],["--chat",[],"string",true,false,[],null],["--draft",[],"string",false,false,[],null],["--message",[],"string",false,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["messages list",false,"list",[],[["--after-cursor",[],"string",false,false,[],null],["--asc",[],"boolean",false,false,[],null],["--before-cursor",[],"string",false,false,[],null],["--chat",[],"string",true,false,[],null],["--ids",[],"boolean",false,false,[],null],["--limit",[],"number",false,false,[],50],["--pick",[],"number",false,false,[],null],["--sender",[],"string",false,false,[],null]]],
  ["messages search",false,"list",[["query",false]],[["--account",[],"string",false,true,[],null],["--after",[],"string",false,false,[],null],["--before",[],"string",false,false,[],null],["--chat",[],"string",false,true,[],null],["--chat-type",[],"string",false,false,["group","single"],null],["--exclude-low-priority",[],"boolean",false,false,[],true],["--ids",[],"boolean",false,false,[],null],["--include-muted",[],"boolean",false,false,[],true],["--limit",[],"number",false,false,[],50],["--media",[],"string",false,true,["any","video","image","link","file"],null],["--sender",[],"string",false,false,[],null]]],
  ["messages show",false,"data",[],[["--chat",[],"string",true,false,[],null],["--id",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["messages context",false,"data",[],[["--after",[],"number",false,false,[],10],["--before",[],"number",false,false,[],10],["--chat",[],"string",true,false,[],null],["--id",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["messages edit",true,"success",[],[["--chat",[],"string",true,false,[],null],["--id",[],"string",true,false,[],null],["--message",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["messages delete",true,"success",[],[["--chat",[],"string",true,false,[],null],["--for-everyone",[],"boolean",false,false,[],null],["--id",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null]]],
  ["messages export",false,"data",[],[["--after",[],"string",false,false,[],null],["--after-cursor",[],"string",false,false,[],null],["--asc",[],"boolean",false,false,[],null],["--before",[],"string",false,false,[],null],["--before-cursor",[],"string",false,false,[],null],["--chat",[],"string",true,false,[],null],["--limit",[],"number",false,false,[],null],["--output",["-o"],"string",false,false,[],"-"],["--pick",[],"number",false,false,[],null]]],
  ["send text",true,"send-result",[],[["--mention",[],"string",false,true,[],null],["--message",[],"string",true,false,[],null],["--no-preview",[],"boolean",false,false,[],null],["--pick",[],"number",false,false,[],null],["--reply-to",[],"string",false,false,[],null],["--to",[],"string",true,false,[],null],["--wait",[],"boolean",false,false,[],null],["--wait-timeout",[],"number",false,false,[],30000]]],
  ["send file",true,"send-result",[],[["--caption",[],"string",false,false,[],null],["--file",[],"string",true,false,[],null],["--filename",[],"string",false,false,[],null],["--mime",[],"string",false,false,[],null],["--pick",[],"number",false,false,[],null],["--reply-to",[],"string",false,false,[],null],["--to",[],"string",true,false,[],null],["--wait",[],"boolean",false,false,[],null],["--wait-timeout",[],"number",false,false,[],30000]]],
  ["send react",true,"send-result",[],[["--id",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null],["--reaction",[],"string",true,false,[],null],["--to",[],"string",true,false,[],null],["--transaction",[],"string",false,false,[],null]]],
  ["send sticker",true,"send-result",[],[["--file",[],"string",true,false,[],null],["--filename",[],"string",false,false,[],null],["--mime",[],"string",false,false,[],"image/webp"],["--pick",[],"number",false,false,[],null],["--reply-to",[],"string",false,false,[],null],["--to",[],"string",true,false,[],null],["--wait",[],"boolean",false,false,[],null],["--wait-timeout",[],"number",false,false,[],30000]]],
  ["send unreact",true,"send-result",[],[["--id",[],"string",true,false,[],null],["--pick",[],"number",false,false,[],null],["--reaction",[],"string",true,false,[],null],["--to",[],"string",true,false,[],null],["--transaction",[],"string",false,false,[],null]]],
  ["send voice",true,"send-result",[],[["--duration",[],"number",false,false,[],null],["--file",[],"string",true,false,[],null],["--filename",[],"string",false,false,[],null],["--mime",[],"string",false,false,[],"audio/ogg"],["--pick",[],"number",false,false,[],null],["--reply-to",[],"string",false,false,[],null],["--to",[],"string",true,false,[],null],["--wait",[],"boolean",false,false,[],null],["--wait-timeout",[],"number",false,false,[],30000]]],
  ["presence",false,"data",[],[["--chat",[],"string",true,false,[],null],["--duration",[],"number",false,false,[],null],["--pick",[],"number",false,false,[],null],["--state",[],"string",false,false,["typing","paused"],"typing"]]],
  ["contacts list",false,"list",[],[["--account",[],"string",false,true,[],null],["--ids",[],"boolean",false,false,[],null],["--limit",[],"number",false,false,[],50],["--query",[],"string",false,false,[],null]]],
  ["contacts search",false,"list",[["query",true]],[["--account",[],"string",false,true,[],null]]],
  ["contacts show",false,"data",[["id",true]],[["--account",[],"string",false,true,[],null]]],
  ["media download",false,"data",[["url",true]],[["--out",["-o"],"string",false,false,[],"."]]],
  ["export",false,"data",[],[["--account",[],"string",false,true,[],null],["--chat",[],"string",false,true,[],null],["--force",[],"boolean",false,false,[],null],["--limit-chats",[],"number",false,false,[],null],["--limit-messages",[],"number",false,false,[],null],["--max-participants",[],"number",false,false,[],500],["--no-attachments",[],"boolean",false,false,[],null],["--out",["-o"],"string",false,false,[],"beeper-export"],["--pick",[],"number",false,false,[],null],["--quiet",[],"boolean",false,false,[],false]]],
  ["watch",false,"stream",[],[["--chat",["-c"],"string",false,true,[],null],["--exclude-type",[],"string",false,true,["chat.upserted","chat.deleted","message.upserted","message.deleted"],null],["--include-type",[],"string",false,true,["chat.upserted","chat.deleted","message.upserted","message.deleted"],null],["--json",[],"boolean",false,false,[],false],["--webhook",[],"string",false,false,[],null],["--webhook-queue",[],"number",false,false,[],64],["--webhook-secret",[],"string",false,false,[],null]]],
  ["rpc",false,"stream",[],[]],
  ["man",false,"manual",[],[]],
  ["doctor",false,"data",[],[]],
  ["status",false,"data",[],[]],
  ["docs",false,"data",[],[]],
  ["version",false,"data",[],[]],
  ["completion",false,"data",[["shell",false]],[["--refresh-cache",["-r"],"boolean",false,false,[],null],["--semantic",[],"boolean",false,false,[],null]]],
  ["plugins",false,"data",[],[]],
  ["plugins available",false,"data",[],[]],
  ["update",true,"success",[],[["--check",[],"boolean",false,false,[],null],["--cli",[],"boolean",false,false,[],null],["--desktop",[],"boolean",false,false,[],null],["--server",[],"boolean",false,false,[],null]]],
  ["config get",false,"data",[["key",false,["baseURL","auth","defaultTarget","defaultAccount"]]],[]],
  ["config set",true,"success",[["key",true,["defaultTarget","defaultAccount"]],["value",true]],[]],
  ["config path",false,"data",[],[]],
  ["config reset",true,"success",[],[]],
  ["api get",false,"data",[["path",true]],[["--json",[],"boolean",false,false,[],true],["--no-auth",[],"boolean",false,false,[],false]]],
  ["api post",false,"data",[["path",true]],[["--body",[],"string",false,false,[],"{}"],["--json",[],"boolean",false,false,[],true],["--no-auth",[],"boolean",false,false,[],false]]],
  ["api request",false,"data",[["method",true,["GET","POST","PUT","PATCH","DELETE"]],["path",true]],[["--body",[],"string",false,false,[],null],["--json",[],"boolean",false,false,[],true],["--no-auth",[],"boolean",false,false,[],false]]],
] as const satisfies readonly BeeperCliV062CommandProfile[]);

const BEEPER_CLI_V062_PRIVATE_COMMAND_PROFILE = Object.freeze([
  "_complete",
  false,
  "list",
  [["kind", true, ["chat", "account", "contact", "target"]]],
  [
    ["--query", [], "string", false, false, [], null],
    ["--target", [], "string", false, false, [], null],
    ["--limit", [], "number", false, false, [], 25],
    ["--timeout-ms", [], "number", false, false, [], 1_500],
  ],
] as const satisfies BeeperCliV062CommandProfile);

const commandFlagCoordinate = (command: string, flag: string): string =>
  `${command}\u0000${flag}`;

const BEEPER_CLI_V062_ALLOW_NO_FLAGS = new Set<string>([
  commandFlagCoordinate("accounts add", "--guided"),
  commandFlagCoordinate("api get", "--json"),
  commandFlagCoordinate("api post", "--json"),
  commandFlagCoordinate("api request", "--json"),
  commandFlagCoordinate("bridges list", "--available"),
  ...["--archived", "--low-priority", "--muted", "--pinned", "--unread"]
    .map((flag) => commandFlagCoordinate("chats list", flag)),
  commandFlagCoordinate("messages search", "--exclude-low-priority"),
  commandFlagCoordinate("messages search", "--include-muted"),
]);

const BEEPER_CLI_V062_EXPLICIT_FALSE_BOOLEAN_FLAGS = new Set<string>([
  ...["--desktop", "--install", "--local", "--oauth", "--server"]
    .map((flag) => commandFlagCoordinate("setup", flag)),
  ...["targets add desktop", "targets add remote", "targets add server"]
    .map((command) => commandFlagCoordinate(command, "--default")),
  commandFlagCoordinate("targets logs", "--all"),
  commandFlagCoordinate("accounts list", "--ids"),
  commandFlagCoordinate("accounts add", "--non-interactive"),
  commandFlagCoordinate("accounts add", "--webview"),
  commandFlagCoordinate("chats list", "--ids"),
  commandFlagCoordinate("chats search", "--ids"),
  commandFlagCoordinate("chats description", "--clear"),
  commandFlagCoordinate("chats avatar", "--clear"),
  commandFlagCoordinate("chats draft", "--clear"),
  commandFlagCoordinate("chats remind", "--dismiss-on-message"),
  commandFlagCoordinate("messages list", "--asc"),
  commandFlagCoordinate("messages list", "--ids"),
  commandFlagCoordinate("messages search", "--ids"),
  commandFlagCoordinate("messages delete", "--for-everyone"),
  commandFlagCoordinate("messages export", "--asc"),
  commandFlagCoordinate("send text", "--no-preview"),
  ...["send text", "send file", "send sticker", "send voice"]
    .map((command) => commandFlagCoordinate(command, "--wait")),
  commandFlagCoordinate("contacts list", "--ids"),
  commandFlagCoordinate("export", "--force"),
  commandFlagCoordinate("export", "--no-attachments"),
  ...["--refresh-cache", "--semantic"]
    .map((flag) => commandFlagCoordinate("completion", flag)),
  ...["--check", "--cli", "--desktop", "--server"]
    .map((flag) => commandFlagCoordinate("update", flag)),
]);

function surfaceDecision(
  disposition: LocalCliSurfaceDecisionV1["disposition"],
  rationale: string,
  operation: string | null = null,
  replacement: string | null = null,
  fixedValue: string | number | boolean | null = null,
): LocalCliSurfaceDecisionV1 {
  return Object.freeze({ disposition, rationale, operation, replacement, fixedValue });
}

const BEEPER_CLI_V062_GLOBAL_FLAGS = Object.freeze([
  Object.freeze({
    name: "--base-url", aliases: Object.freeze([]), source: "global" as const,
    valueType: "string" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "none" as const }),
    decision: surfaceDecision(
      "fixed",
      "Wrench resolves and verifies the fixed Desktop loopback endpoint; callers cannot supply an endpoint.",
      null,
      null,
      "verified-desktop-loopback-endpoint",
    ),
  }),
  Object.freeze({
    name: "--target", aliases: Object.freeze(["-t"]), source: "global" as const,
    valueType: "string" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "derived" as const, description: "configured CLI target" }),
    decision: surfaceDecision("fixed", "The provider is permanently bound to the Desktop target.", null, null, "desktop"),
  }),
  Object.freeze({
    name: "--debug", aliases: Object.freeze([]), source: "global" as const,
    valueType: "boolean" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "literal" as const, value: false, authority: "tagged-source" as const }),
    decision: surfaceDecision("unsupported", "Raw SDK debug output can contain provider internals and is never returned."),
  }),
  Object.freeze({
    name: "--events", aliases: Object.freeze([]), source: "global" as const,
    valueType: "boolean" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "literal" as const, value: false, authority: "tagged-source" as const }),
    decision: surfaceDecision("replaced", "Wrench emits its own bounded operation lifecycle instead of raw CLI NDJSON.", null, "Wrench operation events"),
  }),
  Object.freeze({
    name: "--full", aliases: Object.freeze([]), source: "global" as const,
    valueType: "boolean" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "literal" as const, value: false, authority: "tagged-source" as const }),
    decision: surfaceDecision(
      "fixed",
      "Wrench fixes --full true and independently enforces its output bound; the upstream core currently ignores the parsed value.",
      null,
      null,
      true,
    ),
  }),
  Object.freeze({
    name: "--json", aliases: Object.freeze([]), source: "global" as const,
    valueType: "boolean" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "literal" as const, value: false, authority: "tagged-source" as const }),
    decision: surfaceDecision("fixed", "The provider always requests machine-readable output.", null, null, true),
  }),
  Object.freeze({
    name: "--quiet", aliases: Object.freeze(["-q"]), source: "global" as const,
    valueType: "boolean" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "literal" as const, value: false, authority: "tagged-source" as const }),
    decision: surfaceDecision("fixed", "The provider always suppresses interactive presentation.", null, null, true),
  }),
  Object.freeze({
    name: "--read-only", aliases: Object.freeze([]), source: "global" as const,
    valueType: "boolean" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "literal" as const, value: false, authority: "tagged-source" as const }),
    decision: surfaceDecision("absorbed", "Wrench fixes this flag for reads and uses kernel preview and confirmation for writes."),
  }),
  Object.freeze({
    name: "--timeout", aliases: Object.freeze([]), source: "global" as const,
    valueType: "string" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "none" as const }),
    decision: surfaceDecision(
      "fixed",
      "The upstream core currently ignores --timeout; Wrench's outer process deadline is authoritative and callers cannot inject duration syntax.",
      null,
      null,
      "outer-process-deadline",
    ),
  }),
  Object.freeze({
    name: "--yes", aliases: Object.freeze(["-y"]), source: "global" as const,
    valueType: "boolean" as const, allowNo: false, required: false, multiple: false,
    enum: Object.freeze([]), default: Object.freeze({ kind: "literal" as const, value: false, authority: "tagged-source" as const }),
    decision: surfaceDecision("absorbed", "The kernel owns explicit preview and confirmation before fixed noninteractive dispatch."),
  }),
] satisfies readonly LocalCliSurfaceFlagV1[]);

const INPUT_DEPENDENT_EFFECT_COMMANDS = new Set<string>([
  "api request",
  "completion",
  "messages export",
  "media download",
  "plugins",
  "rpc",
  "update",
  "watch",
]);

const REPORTED_READS_WITH_REVIEWED_WRITES = new Set<string>([
  "auth email response",
  "api post",
  "export",
  "presence",
  "targets tunnel",
  "verify",
]);

function reviewedEffect(
  command: string,
  upstreamReportedMutates: boolean,
): LocalCliSurfaceCommandDefinitionV1["reviewedEffect"] {
  if (INPUT_DEPENDENT_EFFECT_COMMANDS.has(command)) return "input-dependent";
  return upstreamReportedMutates || REPORTED_READS_WITH_REVIEWED_WRITES.has(command)
    ? "write"
    : "read";
}

function surfaceCommandDecision(command: string): LocalCliSurfaceDecisionV1 {
  if (command === "_complete") {
    return surfaceDecision(
      "unsupported",
      "Private source completion internals can resolve fuzzy live identities and are outside provider authority.",
      null,
      "Wrench capability metadata and exact semantic IDs",
    );
  }
  if (command === "accounts add" || command === "accounts remove") {
    return surfaceDecision("R4", "Account lifecycle is operator-only administration and has no routine provider operation.");
  }
  if (command === "messages delete") {
    return surfaceDecision(
      "R4",
      "Deletion stays inert: upstream can silently fall back from delete-for-everyone to local deletion and only returns success/void with no provable effect.",
      null,
      "No dispatch without exact external confirmation and effect proof",
    );
  }
  if (command === "accounts use") {
    return surfaceDecision(
      "absorbed",
      "Mutable default-account selection is replaced by an exact account_id on every account-aware operation.",
      null,
      "Explicit account_id",
    );
  }
  if (command === "export") {
    return surfaceDecision(
      "internal",
      "Only the existing bounded private archive path may invoke top-level export with Wrench-owned output, limits, and no attachments.",
      null,
      "Internal bounded private export",
    );
  }
  const legacy = BEEPER_CLI_COMMAND_COVERAGE[
    command as keyof typeof BEEPER_CLI_COMMAND_COVERAGE
  ];
  if (legacy === undefined) throw new Error(`Beeper surface command ${command} lacks a disposition`);
  if (legacy.state === "supported") {
    return surfaceDecision(
      "supported",
      `A bounded semantic ${legacy.operation} operation covers this command without raw argv authority.`,
      legacy.operation,
    );
  }
  if (legacy.state === "internal-preflight") {
    return surfaceDecision(
      "internal",
      `This command is restricted to the ${legacy.purpose} runtime preflight.`,
    );
  }
  const special = command === "messages export"
    ? "A bounded private messages artifact is not yet exposed; caller paths and buffered stdout remain forbidden."
    : command === "media download"
      ? "No media operation exists until an opaque prior-message handle can be consumed by a genuinely bounded worker."
      : command === "watch"
        ? "No event operation exists until finite supervision proves count, duration, byte, and termination bounds; webhooks remain forbidden."
        : command === "targets tunnel"
          ? "The floating Cloudflare JIT plugin and public tunnel are permanently outside provider authority."
          : `This ${legacy.reason} command group remains outside the semantic provider authority.`;
  return surfaceDecision("unsupported", special);
}

function surfaceItemDecision(
  command: string,
  item: string,
  commandDecision: LocalCliSurfaceDecisionV1,
): LocalCliSurfaceDecisionV1 {
  if (command === "export" && commandDecision.disposition === "internal") {
    if (item === "--no-attachments") {
      return surfaceDecision(
        "fixed",
        "The internal private export always disables attachments.",
        null,
        "Wrench-owned bounded private export",
        true,
      );
    }
    if (item === "--force") {
      return surfaceDecision(
        "fixed",
        "The internal private export never overwrites an existing caller path.",
        null,
        "Fresh Wrench-owned export root",
        false,
      );
    }
    if (item === "--out") {
      return surfaceDecision(
        "fixed",
        "The output root is allocated and owned by Wrench; callers cannot inject a path.",
        null,
        "Wrench-owned private export root",
        "wrench-owned-private-export-root",
      );
    }
    if (item === "--quiet") {
      return surfaceDecision(
        "fixed",
        "The internal export suppresses interactive presentation.",
        null,
        "Bounded canonical manifest",
        true,
      );
    }
    if (["--limit-chats", "--limit-messages", "--max-participants"].includes(item)) {
      return surfaceDecision(
        "absorbed",
        `${item} is supplied only by the bounded private export planner.`,
        null,
        "Validated Wrench capture bound",
      );
    }
    return surfaceDecision(
      "internal",
      `${item} is unavailable to provider callers and omitted by the fixed private export plan.`,
      null,
      "Internal bounded private export",
    );
  }
  if (commandDecision.disposition !== "supported") {
    return surfaceDecision(
      commandDecision.disposition,
      `${item} inherits the command disposition: ${commandDecision.rationale}`,
      commandDecision.operation,
      commandDecision.replacement,
    );
  }
  const operation = commandDecision.operation;
  if (item === "--pick") {
    return surfaceDecision("replaced", "Fuzzy selection and result picking are forbidden.", operation, "Exact provider ID input");
  }
  if (item === "--ids") {
    return surfaceDecision("absorbed", "Normalized results always include stable provider IDs.", operation);
  }
  if (item === "--asc") {
    return surfaceDecision("absorbed", "The operation uses one canonical page order and never passes --asc before deriving continuation.", operation, "Canonical operation order");
  }
  if (item === "--wait" || item === "--wait-timeout") {
    return surfaceDecision("replaced", "Mutation dispatch never waits inside the send command.", operation, "Future read-only messaging.delivery.await over an accepted pending send");
  }
  if (item === "--transaction") {
    return surfaceDecision("absorbed", "Wrench owns the reaction transaction identity through the confirmed plan and dispatch fence.", operation);
  }
  if (command === "chats start" && item === "--title") {
    return surfaceDecision("replaced", "Conversation creation first returns an exact ID; title mutation is separate.", operation, "conversations.title.set");
  }
  if (command === "presence" && item === "--duration") {
    return surfaceDecision("absorbed", "Duration becomes two explicit bounded Wrench dispatches instead of a hidden child-process write.", operation);
  }
  if (item === "--file" || item === "--attachment") {
    return surfaceDecision("replaced", "Caller filesystem paths are forbidden.", operation, "Wrench plan-bound file capability");
  }
  if (item === "--account" && command === "accounts list") {
    return surfaceDecision("replaced", "The list returns the fixed account realm; exact lookup is separate.", operation, "accounts.read with account_id");
  }
  if (item === "--account") {
    return surfaceDecision("replaced", "Fuzzy and multi-account selectors are forbidden.", operation, "One exact account_id");
  }
  if (item === "--chat" || item === "--to") {
    return surfaceDecision("replaced", "Numeric, title, fuzzy, and multi-chat selectors are forbidden.", operation, "One exact full conversation_id");
  }
  if (["bridge", "account", "user", "id"].includes(item)) {
    return surfaceDecision("replaced", "Selector shorthand is replaced by an exact provider identity.", operation, "Exact semantic ID input");
  }
  if (command === "messages search" && item === "--exclude-low-priority") {
    return surfaceDecision(
      "supported",
      "The semantic default is true, matching the generated Desktop API/OpenAPI server default used when the CLI omits the flag.",
      operation,
    );
  }
  if (command === "bridges list" && item === "--provider") {
    return surfaceDecision(
      "supported",
      "The three upstream values pass exactly; platform-sdk is a Wrench-local filter over an unfiltered bridge catalog and is never passed upstream.",
      operation,
    );
  }
  return surfaceDecision("supported", `${item} is exposed through bounded typed input for ${operation}.`, operation);
}

function surfaceDefault(
  command: string,
  name: string,
  value: BeeperCliV062FlagProfile[6],
): LocalCliSurfaceDefaultV1 {
  const sourceAuthority = command === "targets tunnel"
    ? "jit-plugin-source"
    : "tagged-source";
  if (BEEPER_CLI_V062_EXPLICIT_FALSE_BOOLEAN_FLAGS.has(
    commandFlagCoordinate(command, name),
  )) return Object.freeze({
    kind: "literal",
    value: false,
    authority: sourceAuthority,
  });
  return value === null
    ? Object.freeze({ kind: "none" })
    : Object.freeze({
      kind: "literal",
      value,
      authority: command === "messages search" && name === "--exclude-low-priority"
        ? "sdk-openapi"
        : sourceAuthority,
    });
}

function commandReconciliation(
  command: string,
  decision: LocalCliSurfaceDecisionV1,
): LocalCliSurfaceReconciliationV1 {
  if (decision.disposition !== "supported" || decision.operation === null) {
    return Object.freeze({
      availability: "none",
      namespace: null,
      predicate: null,
      rationale: "No provider mutation dispatch is authorized by this disposition.",
    });
  }
  const policy = BEEPER_LOCAL_OPERATIONS[decision.operation as BeeperLocalOperationName];
  if (policy.effect === "read") {
    return Object.freeze({
      availability: "none",
      namespace: null,
      predicate: null,
      rationale: "Read operations do not require mutation reconciliation.",
    });
  }
  if (["presence.set", "conversations.notify", "conversations.focus"].includes(decision.operation)) {
    return Object.freeze({
      availability: "none",
      namespace: null,
      predicate: null,
      rationale: "This visible effect has no exact provider readback and is never blindly retried after dispatch uncertainty.",
    });
  }
  if (command === "chats avatar") {
    return Object.freeze({
      availability: "input-dependent",
      namespace: "semantic-operation",
      predicate: Object.freeze({
        op: "not",
        predicate: Object.freeze({ op: "present", field: "avatar" }),
      }),
      rationale: "Only clear/no-file avatar state has an exact readback; uploaded file identity is irreconcilable.",
    });
  }
  if (command === "chats draft") {
    return Object.freeze({
      availability: "input-dependent",
      namespace: "semantic-operation",
      predicate: Object.freeze({
        op: "not",
        predicate: Object.freeze({ op: "present", field: "attachment" }),
      }),
      rationale: "Only drafts without an attachment have an exact readback; attachment identity is irreconcilable.",
    });
  }
  if (command === "chats mark-read" || command === "chats mark-unread") {
    return Object.freeze({
      availability: "input-dependent",
      namespace: "semantic-operation",
      predicate: Object.freeze({
        op: "not",
        predicate: Object.freeze({ op: "present", field: "message_id" }),
      }),
      rationale: "Only the conversation-level marker has an exact readback; a caller-selected message boundary is irreconcilable.",
    });
  }
  return Object.freeze({
    availability: "always",
    namespace: null,
    predicate: null,
    rationale: "The operation contract defines an exact accepted target or desired-state readback and forbids blind retry.",
  });
}

function commandOutput(
  command: string,
  output: BeeperCliV062CommandProfile[2],
  decision: LocalCliSurfaceDecisionV1,
): LocalCliSurfaceCommandDefinitionV1["output"] {
  if (command === "export") {
    return Object.freeze({
      shape: "Private canonical archive shards under a Wrench-owned root.",
      completeness: "internal",
      maxBytes: 4 * 1024 * 1024 * 1024,
      privateArtifact: true,
      truncation: "The internal caller fixes chat, message, participant, timeout, and no-attachment bounds.",
    });
  }
  if (decision.disposition !== "supported") {
    return Object.freeze({
      shape: `Upstream ${output} output is not returned through a provider operation.`,
      completeness: "unavailable",
      maxBytes: null,
      privateArtifact: false,
      truncation: null,
    });
  }
  const policy = BEEPER_LOCAL_OPERATIONS[decision.operation as BeeperLocalOperationName];
  const search = decision.operation?.endsWith("search") === true;
  const blendedContactQuery = command === "contacts list";
  return Object.freeze({
    shape: policy.effect === "read"
      ? "Bounded normalized provider projection with explicit completeness metadata."
      : "Bounded normalized mutation receipt and exact reconciliation evidence when available.",
    completeness: policy.effect === "write"
      ? "input-dependent"
      : search ? "candidate-window" : blendedContactQuery ? "input-dependent" : "bounded",
    maxBytes: 10 * 1024 * 1024,
    privateArtifact: false,
    truncation: policy.effect === "read"
      ? blendedContactQuery
        ? "Without query this is a bounded list; with query it is a provider-blended candidate window with no continuation metadata."
        : "Provider limits and continuation availability are explicit in the normalized output."
      : "No upstream body, path, token, or unbounded diagnostic output is exposed.",
  });
}

function commandInputRules(command: string) {
  if (command === "messages list" || command === "messages export") {
    const namespace = command === "messages list"
      ? "semantic-operation" as const
      : "upstream-command" as const;
    return Object.freeze([
    Object.freeze({
      namespace,
      when: Object.freeze({ op: "present" as const, field: "before_cursor" }),
      require: Object.freeze([]),
      requireAny: Object.freeze([]),
      exactlyOne: Object.freeze([]),
      forbid: Object.freeze(["after_cursor"]),
      rationale: "A page has only one continuation direction.",
    }),
    Object.freeze({
      namespace,
      when: Object.freeze({ op: "present" as const, field: "after_cursor" }),
      require: Object.freeze([]),
      requireAny: Object.freeze([]),
      exactlyOne: Object.freeze([]),
      forbid: Object.freeze(["before_cursor"]),
      rationale: "A page has only one continuation direction.",
    }),
    ]);
  }
  if (command === "chats description") return Object.freeze([
    Object.freeze({
      namespace: "semantic-operation" as const,
      when: Object.freeze({ op: "eq" as const, field: "clear", value: true }),
      require: Object.freeze([]), requireAny: Object.freeze([]), exactlyOne: Object.freeze([]),
      forbid: Object.freeze(["description"]),
      rationale: "Clear description cannot also provide replacement text.",
    }),
    Object.freeze({
      namespace: "semantic-operation" as const,
      when: Object.freeze({ op: "eq" as const, field: "clear", value: false }),
      require: Object.freeze(["description"]), requireAny: Object.freeze([]), exactlyOne: Object.freeze([]), forbid: Object.freeze([]),
      rationale: "A non-clear description mutation requires replacement text.",
    }),
  ]);
  if (command === "chats avatar") return Object.freeze([
    Object.freeze({
      namespace: "semantic-operation" as const,
      when: Object.freeze({ op: "eq" as const, field: "clear", value: true }),
      require: Object.freeze([]), requireAny: Object.freeze([]), exactlyOne: Object.freeze([]),
      forbid: Object.freeze(["avatar"]),
      rationale: "Clear avatar cannot also provide an upload capability.",
    }),
    Object.freeze({
      namespace: "semantic-operation" as const,
      when: Object.freeze({ op: "eq" as const, field: "clear", value: false }),
      require: Object.freeze(["avatar"]), requireAny: Object.freeze([]), exactlyOne: Object.freeze([]), forbid: Object.freeze([]),
      rationale: "A non-clear avatar mutation requires one plan-bound upload capability.",
    }),
  ]);
  if (command === "chats draft") return Object.freeze([
    Object.freeze({
      namespace: "semantic-operation" as const,
      when: Object.freeze({ op: "eq" as const, field: "clear", value: true }),
      require: Object.freeze([]),
      requireAny: Object.freeze([]),
      exactlyOne: Object.freeze([]),
      forbid: Object.freeze(["text", "attachment", "filename", "mime_type"]),
      rationale: "Clear draft cannot carry replacement content or attachment metadata.",
    }),
    Object.freeze({
      namespace: "semantic-operation" as const,
      when: Object.freeze({ op: "eq" as const, field: "clear", value: false }),
      require: Object.freeze(["text"]),
      requireAny: Object.freeze([]),
      exactlyOne: Object.freeze([]),
      forbid: Object.freeze([]),
      rationale: "A non-clear draft requires text; one plan-bound attachment is optional.",
    }),
    ...["filename", "mime_type"].map((field) => Object.freeze({
      namespace: "semantic-operation" as const,
      when: Object.freeze({ op: "present" as const, field }),
      require: Object.freeze(["attachment"]),
      requireAny: Object.freeze([]),
      exactlyOne: Object.freeze([]),
      forbid: Object.freeze([]),
      rationale: `${field} is meaningful only with one attachment.`,
    })),
  ]);
  if (command === "messages search") return Object.freeze([
    Object.freeze({
      namespace: "semantic-operation" as const,
      when: Object.freeze({ op: "true" as const }),
      require: Object.freeze([]),
      requireAny: Object.freeze(["query", "account_id", "conversation_id", "chat_type", "after", "before", "media", "sender"]),
      exactlyOne: Object.freeze([]),
      forbid: Object.freeze([]),
      rationale: "Search requires text or a substantive bounded filter; presentation booleans alone are insufficient.",
    }),
  ]);
  return Object.freeze([]);
}

function commandPathSemanticInputs(
  command: string,
): LocalCliSurfaceCommandDefinitionV1["pathSemanticInputs"] {
  const fixed = {
    "chats archive": Object.freeze({ enabled: true }),
    "chats unarchive": Object.freeze({ enabled: false }),
    "chats pin": Object.freeze({ enabled: true }),
    "chats unpin": Object.freeze({ enabled: false }),
    "chats mute": Object.freeze({ enabled: true }),
    "chats unmute": Object.freeze({ enabled: false }),
    "chats mark-read": Object.freeze({ unread: false }),
    "chats mark-unread": Object.freeze({ unread: true }),
    "chats remind": Object.freeze({ clear: false }),
    "chats unremind": Object.freeze({ clear: true }),
    "send text": Object.freeze({ kind: "text" }),
    "send file": Object.freeze({ kind: "file" }),
    "send react": Object.freeze({ enabled: true }),
    "send sticker": Object.freeze({ kind: "sticker" }),
    "send unreact": Object.freeze({ enabled: false }),
    "send voice": Object.freeze({ kind: "voice" }),
  } as const satisfies Readonly<Record<
    string,
    LocalCliSurfaceCommandDefinitionV1["pathSemanticInputs"]
  >>;
  return fixed[command as keyof typeof fixed] ?? Object.freeze({});
}

function commandDefinition(
  profile: BeeperCliV062CommandProfile,
  exposure: "public-manual" | "source-only-private" = "public-manual",
): LocalCliSurfaceCommandDefinitionV1 {
  const [command, upstreamReportedMutates, output, argumentProfiles, flagProfiles] = profile;
  const decision = surfaceCommandDecision(command);
  const provenance = exposure === "source-only-private"
    ? "source-only-private" as const
    : command === "targets tunnel" ? "jit-plugin" as const : "built-in-canonical" as const;
  const arguments_: readonly LocalCliSurfaceArgumentV1[] = Object.freeze(
    argumentProfiles.map(([name, required, enumValues = []], position) => Object.freeze({
      name,
      position,
      required,
      multiple: false,
      valueType: "string" as const,
      enum: Object.freeze([...enumValues]),
      default: Object.freeze({ kind: "none" as const }),
      decision: surfaceItemDecision(command, name, decision),
    })),
  );
  const flags: readonly LocalCliSurfaceFlagV1[] = Object.freeze(flagProfiles.map(([
    name, aliases, valueType, required, multiple, enumValues, defaultValue,
  ]) => Object.freeze({
    name,
    aliases: Object.freeze([...aliases]),
    source: "command" as const,
    valueType,
    allowNo: BEEPER_CLI_V062_ALLOW_NO_FLAGS.has(commandFlagCoordinate(command, name)),
    required,
    multiple,
    enum: Object.freeze([...enumValues]),
    default: surfaceDefault(command, name, defaultValue),
    decision: surfaceItemDecision(command, name, decision),
  })));
  return Object.freeze({
    path: Object.freeze(command.split(" ")),
    provenance,
    profileAuthority: command === "targets tunnel" ? "jit-plugin-source" : "tagged-source",
    package: command === "targets tunnel" ? "@beeper/cli-plugin-cloudflare" : "@beeper/cli",
    version: command === "targets tunnel" ? "^0.6.0" : "0.6.1",
    versionKind: command === "targets tunnel" ? "range" : "exact",
    registered: exposure === "public-manual" && command !== "targets tunnel",
    publicManual: exposure === "public-manual",
    generatedCanonical: exposure === "public-manual" && command !== "targets tunnel",
    upstreamReportedMutates,
    reviewedEffect: reviewedEffect(command, upstreamReportedMutates),
    arguments: arguments_,
    flags,
    decision,
    pathSemanticInputs: commandPathSemanticInputs(command),
    output: commandOutput(command, output, decision),
    conditionalInputs: commandInputRules(command),
    reconciliation: commandReconciliation(command, decision),
  });
}

const additionalDecision = (disposition: LocalCliSurfaceDecisionV1["disposition"], rationale: string, replacement: string | null = null) =>
  surfaceDecision(disposition, rationale, null, replacement);

function oclifPluginEntry(
  path: string,
  canonicalTarget: string | null = null,
): LocalCliSurfaceAdditionalEntryV1 {
  return Object.freeze({
    path: Object.freeze(path.split(" ")),
    provenance: "dynamic-plugin",
    profileAuthority: "framework-runtime",
    canonicalTarget: canonicalTarget === null
      ? null
      : Object.freeze(canonicalTarget.split(" ")),
    package: "@oclif/plugin-plugins",
    version: null,
    versionKind: null,
    registered: true,
    publicManual: false,
    rationale: canonicalTarget === null
      ? "Callable oclif plugin-management command omitted from the generated command map."
      : "Callable oclif plugin-management alias omitted from the generated command map.",
    decision: additionalDecision(
      "unsupported",
      "Plugin inspection and lifecycle authority are permanently outside the provider.",
    ),
  });
}

const BEEPER_CLI_V062_ADDITIONAL_ENTRIES: readonly LocalCliSurfaceAdditionalEntryV1[] = Object.freeze([
  ...[
  ["accounts", "accounts list", "accounts.list"],
  ["accounts chats", "chats list", "messaging.list"],
  ["bridges", "bridges list", "bridges.list"],
  ["chats", "chats list", "messaging.list"],
  ["contacts", "contacts list", "contacts.list"],
  ["targets", "targets list", null],
].map(([path, target, operation]) => Object.freeze({
  path: Object.freeze(path!.split(" ")),
  provenance: "built-in-alias" as const,
  profileAuthority: "tagged-source" as const,
  canonicalTarget: Object.freeze(target!.split(" ")),
  package: "@beeper/cli",
  version: "0.6.1",
  versionKind: "exact" as const,
  registered: true,
  publicManual: false,
  rationale: "Generated registration alias; never accepted as raw caller syntax.",
  decision: operation === null
    ? additionalDecision("unsupported", "Target lifecycle aliases remain outside provider authority.")
    : surfaceDecision("absorbed", "The canonical semantic operation absorbs this generated alias.", operation),
})),
  Object.freeze({
    path: Object.freeze(["autocomplete"]), provenance: "built-in-hidden" as const,
    profileAuthority: "tagged-source" as const,
    canonicalTarget: null, package: "@beeper/cli", version: "0.6.1", versionKind: "exact" as const, registered: true,
    publicManual: false, rationale: "Hidden generated canonical command omitted from the public manual.",
    decision: additionalDecision("internal", "Wrench capability metadata replaces CLI autocomplete."),
  }),
  Object.freeze({
    path: Object.freeze(["help"]), provenance: "built-in-hidden" as const,
    profileAuthority: "framework-runtime" as const,
    canonicalTarget: null, package: "@oclif/core", version: null, versionKind: null, registered: true,
    publicManual: false, rationale: "Callable framework help behavior is outside the generated source command map.",
    decision: additionalDecision("internal", "Wrench capability metadata replaces CLI help."),
  }),
  oclifPluginEntry("plugins inspect"),
  oclifPluginEntry("plugins install"),
  oclifPluginEntry("plugins add", "plugins install"),
  oclifPluginEntry("plugins link"),
  oclifPluginEntry("plugins reset"),
  oclifPluginEntry("plugins uninstall"),
  oclifPluginEntry("plugins unlink", "plugins uninstall"),
  oclifPluginEntry("plugins remove", "plugins uninstall"),
  oclifPluginEntry("plugins update"),
  Object.freeze({
    path: Object.freeze(["<dynamic-plugin-command>"]), provenance: "dynamic-plugin" as const,
    profileAuthority: "framework-runtime" as const,
    canonicalTarget: null, package: null, version: null, versionKind: null, registered: false,
    publicManual: false, rationale: "Installed oclif plugins may add unpinned commands dynamically.",
    decision: additionalDecision("unsupported", "Dynamic plugin commands are permanently outside provider authority."),
  }),
  Object.freeze({
    path: Object.freeze(["messages", "react"]), provenance: "documented-only" as const,
    profileAuthority: "documentation" as const,
    canonicalTarget: null, package: null, version: null, versionKind: null, registered: false,
    publicManual: false, rationale: "A stale documentation alias is absent from the tagged source registration.",
    decision: additionalDecision("replaced", "Use reactions.set through the canonical send react mapping.", "reactions.set"),
  }),
  Object.freeze({
    path: Object.freeze(["messages", "unreact"]), provenance: "documented-only" as const,
    profileAuthority: "documentation" as const,
    canonicalTarget: null, package: null, version: null, versionKind: null, registered: false,
    publicManual: false, rationale: "A stale documentation alias is absent from the tagged source registration.",
    decision: additionalDecision("replaced", "Use reactions.set through the canonical send unreact mapping.", "reactions.set"),
  }),
]);

const BEEPER_CLI_V062_COMMANDS = Object.freeze(
  [
    ...BEEPER_CLI_V062_COMMAND_PROFILES.map((profile) => commandDefinition(profile)),
    commandDefinition(BEEPER_CLI_V062_PRIVATE_COMMAND_PROFILE, "source-only-private"),
  ],
);

if (
  BEEPER_CLI_V062_COMMANDS.length !== 102
  || BEEPER_CLI_V062_COMMANDS.filter((command) => command.publicManual).length !== 101
  || BEEPER_CLI_V062_COMMANDS.filter((command) => command.generatedCanonical).length !== 100
  || BEEPER_CLI_V062_COMMANDS.filter((command) => command.registered).length + 7 !== 107
) throw new Error("Beeper v0.6.2 surface cardinality drifted from reviewed provenance");

export const BEEPER_CLI_V062_SURFACE_CONTRACT = defineLocalCliSurfaceContractV1({
  schemaVersion: 1,
  format: "wrench.local-cli-surface",
  surface: "beeper",
  executable: {
    id: BEEPER_CLI_PIN.id,
    implementation: BEEPER_CLI_PIN.implementation,
    releaseVersion: BEEPER_CLI_PIN.version,
    releaseDate: "2026-05-18",
    releaseTag: "v0.6.2",
    releaseCommit: BEEPER_CLI_PIN.commit,
    releaseManifestSha256: BEEPER_CLI_PIN.releaseManifestSha256,
    runtimeReportedName: "@beeper/cli",
    runtimeReportedVersion: "0.6.2",
    artifacts: Object.freeze(BEEPER_CLI_PIN.artifacts.map((artifact) => Object.freeze({
      platform: artifact.platform,
      arch: artifact.arch,
      archiveSha256: artifact.archiveSha256,
      executableSha256: artifact.executableSha256,
    }))),
  },
  source: {
    package: "@beeper/cli",
    packagePath: "packages/cli/package.json",
    packageDeclaredVersion: "0.6.1",
    versionDiscrepancy: "Official v0.6.2 binaries.json and the exact executable report 0.6.2, while package.json at tag a416af06023449a87312dc11e54643fd9dc94b8c declares 0.6.1; executable runtime identity remains authoritative.",
    generatedManualSha256: "18a11300ae7fe321ace0c9c5bbdfd062f114c91add7d64e256b78c2e89e328a9",
    generatedManualIncludesFlagsAndDefaults: false,
    generatedManualEntries: 101,
    generatedCanonicalEntries: 101,
    registeredKeys: 107,
  },
  sdk: BEEPER_DESKTOP_API_PIN,
  runtime: {
    providerPluginId: "beeper-linked-device",
    providerPluginVersion: "2.3.0",
    adapterId: "beeper-local",
    adapterVersion: "2.3.0",
    operationContractVersions: BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS,
    operationInputTypes: BEEPER_LOCAL_OPERATION_INPUT_TYPES,
    target: BEEPER_DESKTOP_TARGET,
    realm: "Fixed local Beeper Desktop realm with a verified loopback endpoint, exact account subject, isolated config/cache/plugins, and no caller endpoint, target, path, or environment.",
    compatibility: "The exact CLI executable identity is enforced and its reviewed API schema is @beeper/desktop-api 5.0.0 at b9c1714410139c2139b597338cd002d785653e85; callers cannot select a Desktop channel or protocol.",
  },
  globalFlags: BEEPER_CLI_V062_GLOBAL_FLAGS,
  commands: BEEPER_CLI_V062_COMMANDS,
  additionalEntries: BEEPER_CLI_V062_ADDITIONAL_ENTRIES,
});

export const BEEPER_CLI_V062_UPSTREAM_SURFACE_SHA256 =
  "74297df1af30fe89cf1596a0670983e79cf85c0768c2f68e9bc3d386be640836" as const;
export const BEEPER_CLI_V062_CLASSIFICATION_SHA256 =
  "9318cfcff0bf578005c5f1e6590169ef843ca90bee0f25a9f2f53ea406f6acd0" as const;
export const BEEPER_CLI_V062_SEMANTIC_PROFILES_SHA256 =
  "cfad9183e1dc2199284b203ec224589f70e97142cc5d3850b64f6f6c261e2a92" as const;
export const BEEPER_CLI_V062_WHOLE_SURFACE_SHA256 =
  "c37e577e305235b3a577c8ea5ad4ed4e5a7bba80d7eae1644b649b756bfd1e42" as const;

export const BEEPER_CLI_V062_PUBLIC_MANUAL_SEMANTIC_PROFILE_SHA256 = Object.freeze({
  "setup": "cd432e2649e5724d70398e739a2d1c0c21557a23820aaa14562575a5fe689406",
  "install desktop": "478f4cc022b1d51d4016a319efea17e4523c55e3168560c99fdf7779347ae78a",
  "install server": "999b4aa7576c772ef4f2fa21076064885d67ab53354ab2446399562e1ad8af89",
  "targets list": "b1db92e025f67dda8d6bcfc642fa591ae7a2e4d3555c5aee7af5a0b94cfe94f2",
  "bridges list": "52c8c245a2088a781f0021232c0baaf6bf14fa9246dbfb192c6c57ef3f5d11af",
  "bridges show": "e23a6027d7536389501d008da503320d58b421c1f132c9a7d402b1d7b031658e",
  "targets add desktop": "fbfa2c790848792b519b11d45285c5ebf42abe3f46fc6b0a7bca231b9d7408e0",
  "targets add server": "488d26c83f2261dbe04195fb429d04019977c5cb21d092db8a4765afe68812bf",
  "targets add remote": "db56749d593d43b78922aab5ff1456f617d6dbdbf7f06d44761c2a5133c80da3",
  "targets use": "4617f7e87a68149c5a96624567ce9dc1501d4e31c86920eb64e3f9c536553eeb",
  "targets show": "a48dacbc13afc37f1a58c5b2178d22c5ae049bff1f2701e1e3e72a9e4088259b",
  "targets status": "a70e6eef1793a561914c49a8bcfa118be22b23244a24e622360ad205c9232cc2",
  "targets start": "4bb79ca30f3564cab02a1c5ec173ee016a04bafe263e38ddbf7aa778747d5f48",
  "targets stop": "65ebf81b3855a7fe5585f94b0cd6dc042ae6e5d92eb3e299c5076e9f84ee24f6",
  "targets restart": "dd1281aad6369e7d68185d6a949449d0b0ce8ff395f9d01570a8bf5ed78387e7",
  "targets logs": "808f0e13386372ef9580575b7a2c9110d540209407cb14dc778faba538a51b41",
  "targets enable": "20baea46e6d8b5f5f8ebc5dc0a8bfe9ff7836ba7b1991c8be2af8ee373cbbe1b",
  "targets disable": "0d5695503942f090b118cb445b64556713536d6deeb32ba582e8a1f6f48135fb",
  "targets remove": "0ba9940afc0ead36641b1539dea4f97dd920d8064067839ddb59b5bda874a2e0",
  "targets tunnel": "a96cdc41c42ea64777782ca96b81cbe630928df35067cdcdd903c506e7bdb5a8",
  "auth status": "e08a0176cdc9d9dd06c75a6082b64c8e9b5f68075b58e9c2e61fe2f99bbb6044",
  "auth logout": "25a8d13779a8fc86c13cf8dbd9c1cfc8d68694fed1a7ab9f872cb648dee366ad",
  "auth email start": "d6d355b494860b57a8ae00d3562c9bd1054c6c70b8f0bf478abff88497ef2334",
  "auth email response": "0842a657dbfbeeeb7744332a60ec04064e991dab501fd47f92bc5596cfd7fbfb",
  "verify": "b16da79fe75c014faf681d36eff05c4e81e274c8ca29d576592d45f35078503a",
  "verify status": "abd89afdf112ac6aeaa97b9843bc2f81e1a52f6e92e4c42ad8e7a035ae73198b",
  "verify approve": "f724a957287b638b9f27a6b02897260c4ece685113448ebd69e6ff793038b2a0",
  "verify recovery-key": "db9d69676807ba959731125bc95ffb6bef735bddb8cd5b5401cb96d8678e4dfb",
  "verify reset-recovery-key": "e59d2b06f2feaa8008f0e285ac4ec7d7a75a18fd66ca39ddce6d9914c28b6c98",
  "verify cancel": "40197355731efde46280b13a2b227f13fb9ebc33cb80712087380d8d805944f0",
  "verify list": "85de0df592d523d3c127f8c33adb2855fc49f43d470d2675d7854401c975ec9e",
  "verify start": "3c0ef55faaf49552315322b4b521290185c36774a8d87a0e2f2614392407e2b7",
  "verify show": "08a4a85bdfc3a900c8d9f49564fdaa3d4d37046eace6ed665c8b767867b83afc",
  "verify sas": "d6fd6130fd9eee6d51c193989184d2115b171993a304cf4707c0aaecafd2c3e0",
  "verify sas-confirm": "0bc55ff8df6068cb6e3fae1ed136dba94442bae00fc4a95c56a9f206fa3a9d38",
  "verify qr-scan": "d618900cb8548d4abf09d29cd577c7aedbaa660dc6978e28fababe7ea520bf25",
  "verify qr-confirm": "4dc005579ee36737d6c03f0f9fdba18274fbf257bc0921bf2592421ec11b3464",
  "accounts list": "325bb478a9fc344a1982c130c6fddecd0c34371052409df6ba05ba59248e3d38",
  "accounts add": "fa8b9c9e695bf6bb3bf6b122773cc633e8fa6c817760314ecd44a848a384eb17",
  "accounts show": "234fef2ec2a24ca7254e3d2b77f0e7179f71bcc67b4e9fc387ae82122a5d6c7a",
  "accounts remove": "6188c67a6ded6d6b7d2662295ead8fab65c6509614c3d39ebc301f7e7cf5eaf0",
  "accounts use": "bd8dc05db1633966700bf488c56ca6710be4766ea7576c11dd0fe7431d576275",
  "chats list": "cc71df6c537ae4878cffc5c3de743481b2daabf47459ab1a52fabcae14d65a92",
  "chats search": "055097bbd9b156f02a5c5177d566a1ed611477032b0f279dbfaabc5830afc56b",
  "chats show": "b090de1ce0486fc8217264baf46d6b312af7d0b063a457037eb14201ef4d77e7",
  "chats start": "7691cf0d6ac68081ce574edbc9ab2c9e5bd2ad6f82902d04d82590bc54cfc91a",
  "chats archive": "fcfe1fb838c27a65a27b116394911bee2bc2f641e7ae2f7c5904388efcafede1",
  "chats unarchive": "d371d735e983d85ae235a955e06cb0542ccb6bcd7e00155919938b948985f30f",
  "chats pin": "5f037961e20915f06ede7fd02b809591ff81ca139d1c5213170f8a14fb032d12",
  "chats unpin": "02bda6e96362e9037931fb53733ce6901a61f6025aaf01de81fc10d103995e58",
  "chats mute": "e56e2b2e43a037765db6bb7ad031a6e927bee1d6e4dd23ec4068488dbb7a4ba5",
  "chats unmute": "f39c1f039777c9771bc97897b0542f95e626c0f34c3c9c854b4da4c740e455d4",
  "chats mark-read": "a3b738d7aba9737d892a62b37d922a7f2023c5bf0929f9283f2de4c3fb4cdfe4",
  "chats mark-unread": "28520f6500ae501537822360ad25b58ff1d48df6adaddd65d9e5b56d557f9e0f",
  "chats priority": "759b966b88e8d1b5236a77405568ff3b659cccbbacf1dbf9dfcdd64e46817c56",
  "chats notify-anyway": "b527d36467f10fbad9913742846605acbb6e1024e8a07c45ba19658a49bd6ab2",
  "chats rename": "5e45d6f1bb18fcc0e8f13097e6b2e286ae6bc2cf925f4dba90c2e60002968e48",
  "chats description": "158fd28b2573c3da43160e04b8749ace7ad552d80aef5a61c912ed33931a69c7",
  "chats avatar": "8e16f4edfd5b780ce0ee3968416864d43f19603f17999bb4e2dd99a6b873440f",
  "chats draft": "bb245a9e50012cca9dbcd65dc2197b1babc6461ce1f0ab61ed53b6322fea02c6",
  "chats disappear": "9d2b7b70d11cb1c749007d2f1c6a2b2298a525ba88fe1790e9dacc97490996b6",
  "chats remind": "b5133c8f6a103234344c2203637ceea98c65c3b97f805e97e169f475bd0e35fd",
  "chats unremind": "0dd3dbfe98dba426c286ca08a73753a4c0a5dfff1ed1ac397e964b336d46b4db",
  "chats focus": "a53f3dc9bbd93e05adfee9f9f6540e417f8fd5030b1c9d1789fc495e5f625931",
  "messages list": "e691ea9f57b65cdfb9e2576ded7a502e24e61d9522122d9440fea386c9c22e6b",
  "messages search": "a19a5290708c3c43aa1e1f84fb5d3ba2664575aa32afc2784042bab2314e72a9",
  "messages show": "b8436a8e46bf761062850f6cc8bf5777a3ae00166631cb77e1cd21ea122be67f",
  "messages context": "68f0a77a8b98435c8aee0dccd603f9ee8d21c83c97b5face47ec582cd525c711",
  "messages edit": "95380f389feaac7cb93f27be89eed617d997ce98f9a3bc1972306d2ccf353339",
  "messages delete": "305e8826df70ebde061dd7099af33b5eec203453560a50a5a1c008ba175a0ecc",
  "messages export": "7a0c90728af3b602726d59fd2f8ac9352db4fae8ccb440515daab5b37955d2ce",
  "send text": "05ef4e97a2611f3e350f54fe34ec31c7f34873de1da060450c7bc7ae9308f32f",
  "send file": "770a6ff88d6e28d1431d2435bac54c2a76a344611e7be5a442f5d1657a005ebf",
  "send react": "b46e199df693cb824bf109dbd1aa5e847445549096c75e6e04c81ea75f1895b6",
  "send sticker": "3da1e6a17df385f098a4a9b6d7e86ab7dd1c7c6d2c0ca5bee9f5de1f38b0b741",
  "send unreact": "f2fe46e5854571eecbde82fc59663f99b44b4484bffda7c92b12614de709b2d3",
  "send voice": "966b39e192073fc581b8efece9fa744f169b51361e9a8223a84d3c9251e08c24",
  "presence": "2d6e067b5d572f7d2524c3e4fdf41300ee82b9af03116f17b098a6afcb9fc9b7",
  "contacts list": "7be94dccadd5b27226fe4252ca77922b08691ea1c6293a0c9b381bf66396a7a0",
  "contacts search": "8b33f02bb3011f2dd304be5f9f5ccec2303833ae739dc4e96dc3691d6354032b",
  "contacts show": "724c25f80b5f58bbfb4b858187d5f785e946853e6a2f355bd14f8b8bc2052c92",
  "media download": "47f7e05839640b88c42e719b44f3d8f9632ddb7f5abbb1ae2f4eee32341d4f88",
  "export": "3a8e13c94c79c7352fc204e7f73c103a55e871befe6dcf943023c832b7119d52",
  "watch": "7839bc4e2a9e905f883a372895fbe40aecfb055f3ed642c4e800dcf4fffb9c03",
  "rpc": "2399aaaab78a0129bcac2fd0e39c26be1e2fb97ce3ed0c40b631474ca1bd4d9d",
  "man": "5f9eb21048ecf86926e64751865c28aa76f3673fc29b41ef5f8273801377cb2a",
  "doctor": "18b285f3054ac9f1ee445827540cc26d1a5e367b230d2015d502233d1c5946aa",
  "status": "73db0a7f0fd5a33620589d8b6f6e2f9a86310371cbc265a28af6e0901373d8a7",
  "docs": "1d44df3d2ad09e8986ec7937c312c3ca06e90ca02693846b64a001b65edaa3bf",
  "version": "706d4759642840fa4cc99a80cb4e73f3020cdcf71aee8d0537341bd3f6746c79",
  "completion": "707719d9c820895ad1cdb0590501bc4656e966c54edb22d9bcba02358395c2d0",
  "plugins": "788ea2111f878f710c8e7c9ed5ac163a58d30831e5a9a67f2c1c1aa88f767f46",
  "plugins available": "b579adca88123da1be0da8c3df02269b629c7f287086ae072e858d79c1e49198",
  "update": "c7f6cf4ef3a19e4161a428b993a1527836c864adb4e812f8392c7cfbada76228",
  "config get": "4568bc28c22e82ed02429a59b38a47d68635a3e599570ad9a4b16d5d1bc4f9bc",
  "config set": "3708ca19869aa056d30c43b2c7368d13168255f73474d7ecea6a38d5d6f748ae",
  "config path": "7c45a2996a9d8b8da6ccc7691ec98c378d7cc3494f2929a0930b98e5e037ebbe",
  "config reset": "4f8f09e26043c8d7770dda894ab17289abdb41ab4881b90d3a287ca548a15374",
  "api get": "677eaba3c3008fd86da6920d6086a166de702c6a650b7499c54b5264300a65e5",
  "api post": "79a8826a3386036d10d2be46ef7eb87a0be769214e032ca909b3758916aecc5a",
  "api request": "9158437c08a2504cd1e7df43aa21c253052ea5f2afbefa7b7e0a01c0ce55746e",
} as const satisfies Readonly<Record<keyof typeof BEEPER_CLI_COMMAND_COVERAGE, string>>);

export const BEEPER_CLI_V062_SOURCE_ONLY_COMPLETE_SEMANTIC_PROFILE_SHA256 =
  "917b94060ef7f99a07843c15d1eee58bdeb4f53797a14157ebf5e54fb72350b2" as const;

if (
  BEEPER_CLI_V062_SURFACE_CONTRACT.digests.upstreamSurfaceSha256
    !== BEEPER_CLI_V062_UPSTREAM_SURFACE_SHA256
  || BEEPER_CLI_V062_SURFACE_CONTRACT.digests.classificationSha256
    !== BEEPER_CLI_V062_CLASSIFICATION_SHA256
  || BEEPER_CLI_V062_SURFACE_CONTRACT.digests.semanticProfilesSha256
    !== BEEPER_CLI_V062_SEMANTIC_PROFILES_SHA256
  || BEEPER_CLI_V062_SURFACE_CONTRACT.digests.wholeSurfaceSha256
    !== BEEPER_CLI_V062_WHOLE_SURFACE_SHA256
) throw new Error(`Beeper v0.6.2 reviewed surface digest drifted: ${JSON.stringify(
  BEEPER_CLI_V062_SURFACE_CONTRACT.digests,
)}`);

for (const command of BEEPER_CLI_V062_SURFACE_CONTRACT.commands) {
  const path = command.path.join(" ");
  const reviewed = command.publicManual
    ? BEEPER_CLI_V062_PUBLIC_MANUAL_SEMANTIC_PROFILE_SHA256[
        path as keyof typeof BEEPER_CLI_V062_PUBLIC_MANUAL_SEMANTIC_PROFILE_SHA256
      ]
    : path === "_complete"
      ? BEEPER_CLI_V062_SOURCE_ONLY_COMPLETE_SEMANTIC_PROFILE_SHA256
      : undefined;
  if (reviewed !== command.semanticProfileSha256) {
    throw new Error(
      `Beeper v0.6.2 semantic profile digest drifted for ${path}: ${command.semanticProfileSha256}`,
    );
  }
}
