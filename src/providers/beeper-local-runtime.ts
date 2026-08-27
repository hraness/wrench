import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { types as nodeTypes } from "node:util";

import type { WrenchAuth } from "../auth";
import { canonicalJson } from "../canonical-json";
import type { LocalCliRecipe, OperationInput } from "../model";
import type {
  LocalCliExecution,
  LocalCliExecutionOptions,
} from "../local-cli-execution";
import { OperationDeadline } from "../operation-deadline";
import { summarizePlanFile } from "../plan-assets";
import type {
  LocalCliPluginRuntimeStatusV1,
  ProviderPluginReconciliationContextV1,
  ProviderPluginReconciliationOptionsV1,
  ProviderPluginReconciliationReadbackV1,
} from "../provider-plugin";
import {
  attachLocalCliCleanupProcessGroup,
  captureLocalCliCleanupResource,
  localCliCleanupProcessGroupStatus,
  type LocalCliCleanupResourceIdentityV1,
} from "../provider-plugin-cleanup-resource";
import type { ProviderPluginCleanupProofController } from "../provider-plugin-cleanup-execution";
import { removePrivateDirectoryTree, wrenchStateHome } from "../storage";
import type {
  ProviderPluginCleanupResourcePublisher,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import { startProviderPluginCleanupTrackedOperation } from "../web-session-execution";
import {
  BEEPER_CLI_PIN,
  BEEPER_DESKTOP_BUNDLE_IDS,
  BEEPER_DESKTOP_TARGET,
  BEEPER_MAX_FILE_BYTES,
  BEEPER_LOCAL_OPERATIONS,
  BEEPER_ORIGIN,
  beeperCliArtifactForRuntime,
  isBeeperLocalOperation,
  parseBeeperOperationInput,
  planBeeperAccountsListCommand,
  planBeeperOperationCommand,
  planBeeperPresenceCommands,
  planBeeperReadCommand,
  planBeeperTargetStatusCommand,
  planBeeperVersionCommand,
  type BeeperCommand,
  type BeeperLocalOperationName,
  type BeeperContactsSearchInput,
  type BeeperContactsListInput,
  type BeeperMessagingListInput,
  type BeeperMessagingSearchInput,
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
const OPERATION_LABEL = "Beeper local CLI operation";
const SUBJECT_PROBE_TIMEOUT_MS = 120_000;

class BeeperLocalCleanupUnverifiedError extends Error {
  constructor() {
    super("Beeper local CLI cleanup could not be proven; retry remains unsafe");
    this.name = "BeeperLocalCleanupUnverifiedError";
  }
}

async function createBeeperOperationRoot(): Promise<string> {
  const parent = await realpath(tmpdir());
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(parent, `wrench-beeper-cli-${randomBytes(16).toString("hex")}`);
    try {
      await mkdir(path, { mode: 0o700 });
      return path;
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "EEXIST"
      ) throw error;
    }
  }
  throw new Error("Beeper local CLI operation root allocation failed");
}

type BeeperAuth = Extract<WrenchAuth, { readonly kind: "linked-device-store" }>;
type JsonRecord = Readonly<Record<string, unknown>>;

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

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export type BeeperCliInvocation = Readonly<{
  binary: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
  /** Awaited after durable dispatch fencing and immediately before Bun.spawn. */
  beforeSpawn?: () => Promise<void>;
  /** Production-only cleanup admission extension, called synchronously after spawn. */
  afterSpawn?: (pid: number) => void;
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

export type BeeperDirectMessagingDependencies = Readonly<{
  /** Test-only request seam. Production uses the process-native fetch. */
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}>;

export type BeeperDirectMessagingAttempt = Readonly<{
  /**
   * Durably crosses the mutation boundary immediately before the only POST.
   * The caller must make this transition persistent before it resolves.
   */
  beforeExternalBegin: () => Promise<void>;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
  dependencies?: BeeperDirectMessagingDependencies;
}>;

export type BeeperDirectMessagingAcceptance = Readonly<{
  provider: "beeper";
  operation: "messaging.send";
  accountSubject: string;
  accountId: string;
  conversationId: string;
  pendingMessageId: string;
  providerRevision: null;
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
  descriptionObserved: boolean;
  hasAvatar: boolean;
  avatarObserved: boolean;
  lastReadMessageSortKey: string | null;
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
  messageExpiryObserved: boolean;
  draft: Readonly<{
    text: string;
    attachments: readonly Readonly<{
      type: "file" | "gif" | "recorded_audio";
      fileName: string | null;
      fileSizeBytes: number | null;
      mimeType: string | null;
    }>[];
  }> | null;
  draftObserved: boolean;
  reminder: Readonly<{
    when: string | null;
    dismissOnMessage: boolean | null;
  }> | null;
  reminderObserved: boolean;
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
  isSender: boolean | null;
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
    if (!hasWellFormedUnicode(key) || hasControlCharacters(key)) {
      throw new Error(`${label} contains a malformed property name`);
    }
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
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)))
  ) throw new Error(`${label} must contain only dense array entries`);
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) throw new Error(`${label} must contain dense enumerable data-only entries`);
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
  allowControls = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum
  ) throw new Error(`${label} must be bounded text`);
  if (!hasWellFormedUnicode(value)) {
    throw new Error(`${label} must contain well-formed Unicode`);
  }
  if (/\0/u.test(value) || (!allowControls && hasControlCharacters(value))) {
    throw new Error(`${label} must not contain control characters`);
  }
  return value;
}

function nullableString(
  value: unknown,
  label: string,
  maximum: number,
  allowControls = false,
): string | null {
  return value === undefined || value === null
    ? null
    : boundedString(value, label, maximum, true, allowControls);
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
  if (source.capabilities !== undefined) {
    boundedPlainJson(source.capabilities, `${label}.capabilities`, 0);
  }
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
  const status = boundedString(source.status, `${label}.status`, 128);
  if (![
    "connected",
    "connecting",
    "backfilling",
    "connection_required",
    "reconnect_required",
    "attention_required",
    "disconnected",
    "disabled",
  ].includes(status)) throw new Error(`${label}.status is unsupported`);
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
    status,
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

export function beeperSubjectFromAccountsAndTarget(
  accounts: readonly BeeperAccountProjection[],
  targetBaseUrl: string,
  targetBundleId: typeof BEEPER_DESKTOP_BUNDLE_IDS[number],
  targetVersion: string,
): string {
  const accountSubject = beeperSubjectFromAccounts(accounts);
  const reviewedBaseUrl = localDesktopBaseUrl(
    targetBaseUrl,
    "Beeper bound target base URL",
  );
  if (reviewedBaseUrl === undefined) {
    throw new Error("Beeper bound target base URL is required");
  }
  if (!BEEPER_DESKTOP_BUNDLE_IDS.includes(targetBundleId)) {
    throw new Error("Beeper bound target bundle ID is unsupported");
  }
  const reviewedVersion = boundedString(
    targetVersion,
    "Beeper bound target version",
    256,
  );
  const digest = createHash("sha256")
    .update(accountSubject, "utf8")
    .update("\0desktop\0desktop\0", "utf8")
    .update(reviewedBaseUrl, "utf8")
    .update("\0", "utf8")
    .update(targetBundleId, "utf8")
    .update("\0", "utf8")
    .update(reviewedVersion, "utf8")
    .digest("hex");
  return `beeper:local:${digest}`;
}

export type BeeperTargetRealmProof = Readonly<{
  baseUrl: string;
  bundleId: typeof BEEPER_DESKTOP_BUNDLE_IDS[number];
  version: string;
}>;

/** Strictly validates the private `targets status desktop --json` realm proof. */
export function parseBeeperTargetRealmProof(
  value: unknown,
  expectedBaseUrl: string,
): BeeperTargetRealmProof {
  const source = strictRecord(value, "Beeper Desktop target status");
  exactKeys(source, [
    "target",
    "reachable",
    "version",
    "bundleID",
    "actualType",
  ], [], "Beeper Desktop target status");
  const target = strictRecord(source.target, "Beeper Desktop target status.target");
  exactKeys(target, ["id", "type", "baseURL", "auth", "managed"], [], "Beeper Desktop target status.target");
  const reviewedBaseUrl = localDesktopBaseUrl(
    expectedBaseUrl,
    "Beeper expected Desktop target base URL",
  );
  if (
    reviewedBaseUrl === undefined
    || target.id !== BEEPER_DESKTOP_TARGET
    || target.type !== "desktop"
    || target.baseURL !== reviewedBaseUrl
    || target.managed !== false
    || source.reachable !== true
    || source.actualType !== "desktop"
  ) throw new Error("Beeper Desktop target status did not bind the fixed reachable Desktop realm");
  storedBeeperAuth(target.auth, "Beeper Desktop target status.target.auth");
  const bundleId = boundedString(
    source.bundleID,
    "Beeper Desktop target status.bundleID",
    256,
  );
  if (!BEEPER_DESKTOP_BUNDLE_IDS.includes(
    bundleId as typeof BEEPER_DESKTOP_BUNDLE_IDS[number],
  )) throw new Error("Beeper Desktop target status returned an unsupported bundle ID");
  return Object.freeze({
    baseUrl: reviewedBaseUrl,
    bundleId: bundleId as typeof BEEPER_DESKTOP_BUNDLE_IDS[number],
    version: boundedString(source.version, "Beeper Desktop target status.version", 256),
  });
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
  if (source.capabilities !== undefined) {
    validateChatCapabilities(source.capabilities, `${label}.capabilities`);
  }
  const draft = parseChatDraftProjection(source.draft, `${label}.draft`);
  const imageUrl = nullableString(source.imgURL, `${label}.imgURL`, 16_384);
  const lastReadMessageSortKey = nullableString(
    source.lastReadMessageSortKey,
    `${label}.lastReadMessageSortKey`,
    2_048,
  );
  if (source.preview !== undefined) {
    boundedPlainJson(source.preview, `${label}.preview`, 0);
  }
  const reminder = parseChatReminderProjection(source.reminder, `${label}.reminder`);
  if (source.snooze !== undefined && source.snooze !== null) {
    validateChatSnooze(source.snooze, `${label}.snooze`);
  }
  const type = boundedString(source.type, `${label}.type`, 32);
  if (type !== "single" && type !== "group") throw new Error(`${label}.type is unsupported`);
  const participants = strictRecord(source.participants, `${label}.participants`);
  exactKeys(participants, ["hasMore", "items", "total"], [], `${label}.participants`);
  const participantItems = strictArray(
    participants.items,
    `${label}.participants.items`,
    500,
  ).map((item, index) =>
    parseParticipant(item, `${label}.participants.items[${index}]`));
  return Object.freeze({
    id: boundedString(source.id, `${label}.id`, 2_048),
    localChatId: nullableString(source.localChatID, `${label}.localChatID`, 2_048),
    accountId,
    network: boundedString(source.network, `${label}.network`, 512),
    title: boundedString(source.title, `${label}.title`, 4_096, true),
    type,
    description: nullableString(source.description, `${label}.description`, 65_536, true),
    descriptionObserved: Object.hasOwn(source, "description"),
    hasAvatar: imageUrl !== null,
    avatarObserved: Object.hasOwn(source, "imgURL"),
    lastReadMessageSortKey,
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
    messageExpiryObserved: Object.hasOwn(source, "messageExpirySeconds"),
    draft,
    draftObserved: Object.hasOwn(source, "draft"),
    reminder,
    reminderObserved: Object.hasOwn(source, "reminder"),
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
    "sortKey",
    "timestamp",
  ], [
    "attachments",
    "editedTimestamp",
    "isDeleted",
    "isHidden",
    "isSender",
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
      boundedString(link.title, `${label}.links[${index}].title`, 8_192, true, true);
      boundedString(link.url, `${label}.links[${index}].url`, 16_384);
      nullableString(link.favicon, `${label}.links[${index}].favicon`, 16_384);
      nullableString(link.img, `${label}.links[${index}].img`, 16_384);
      nullableString(link.originalURL, `${label}.links[${index}].originalURL`, 16_384);
      nullableString(link.summary, `${label}.links[${index}].summary`, 65_536, true);
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
    const sendStatus = boundedString(status.status, `${label}.sendStatus.status`, 64);
    if (![
      "SUCCESS",
      "PENDING",
      "FAIL_RETRIABLE",
      "FAIL_PERMANENT",
    ].includes(sendStatus)) throw new Error(`${label}.sendStatus.status is unsupported`);
    timestamp(status.timestamp, `${label}.sendStatus.timestamp`);
    nullableString(status.internalError, `${label}.sendStatus.internalError`, 65_536, true);
    nullableString(status.message, `${label}.sendStatus.message`, 65_536, true);
    nullableString(status.reason, `${label}.sendStatus.reason`, 2_048, true);
    if (status.deliveredToUsers !== undefined) {
      strictArray(status.deliveredToUsers, `${label}.sendStatus.deliveredToUsers`, 2_000)
        .forEach((item, index) =>
          boundedString(item, `${label}.sendStatus.deliveredToUsers[${index}]`, 2_048));
    }
  }
  const isDeleted = optionalBoolean(source.isDeleted, `${label}.isDeleted`) ?? false;
  const isHidden = optionalBoolean(source.isHidden, `${label}.isHidden`) ?? false;
  const text = nullableString(source.text, `${label}.text`, MAX_TEXT_BYTES, true);
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
    isSender: optionalBoolean(source.isSender, `${label}.isSender`),
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

function validateCapabilityLevel(value: unknown, label: string): void {
  integer(value, label, -2, 2);
}

function validateCapabilityLevelMap(
  value: unknown,
  label: string,
  maximum: number,
): void {
  const source = strictRecord(value, label);
  const entries = Object.entries(source);
  if (entries.length > maximum) throw new Error(`${label} contains too many entries`);
  for (const [key, item] of entries) {
    boundedString(key, `${label} key`, 256);
    validateCapabilityLevel(item, `${label}.${key}`);
  }
}

function validateChatCapabilities(value: unknown, label: string): void {
  const source = strictRecord(value, label);
  exactKeys(source, [], [
    "allowedReactions",
    "archive",
    "attachments",
    "customEmojiReactions",
    "delete",
    "deleteChat",
    "deleteChatForEveryone",
    "deleteForMe",
    "deleteMaxAge",
    "disappearingTimer",
    "edit",
    "editMaxAge",
    "editMaxCount",
    "formatting",
    "locationMessage",
    "markAsUnread",
    "maxTextLength",
    "messageRequest",
    "participantActions",
    "poll",
    "reaction",
    "reactionCount",
    "readReceipts",
    "reply",
    "state",
    "thread",
    "typingNotifications",
  ], label);
  if (source.allowedReactions !== undefined) {
    strictArray(source.allowedReactions, `${label}.allowedReactions`, 10_000)
      .forEach((item, index) =>
        boundedString(item, `${label}.allowedReactions[${index}]`, 2_048, true));
  }
  for (const key of [
    "archive",
    "customEmojiReactions",
    "deleteChat",
    "deleteChatForEveryone",
    "deleteForMe",
    "markAsUnread",
    "readReceipts",
    "typingNotifications",
  ] as const) {
    if (source[key] !== undefined) requiredBoolean(source[key], `${label}.${key}`);
  }
  for (const key of [
    "delete",
    "edit",
    "locationMessage",
    "poll",
    "reaction",
    "reply",
    "thread",
  ] as const) {
    if (source[key] !== undefined) validateCapabilityLevel(source[key], `${label}.${key}`);
  }
  for (const key of [
    "deleteMaxAge",
    "editMaxAge",
    "editMaxCount",
    "maxTextLength",
    "reactionCount",
  ] as const) {
    if (source[key] !== undefined) {
      finiteNumber(source[key], `${label}.${key}`, 0, Number.MAX_SAFE_INTEGER);
    }
  }
  if (source.attachments !== undefined) {
    const attachments = strictRecord(source.attachments, `${label}.attachments`);
    const entries = Object.entries(attachments);
    if (entries.length > 256) throw new Error(`${label}.attachments contains too many entries`);
    for (const [messageType, item] of entries) {
      boundedString(messageType, `${label}.attachments key`, 256);
      const attachment = strictRecord(item, `${label}.attachments.${messageType}`);
      exactKeys(attachment, ["mimeTypes"], [
        "caption",
        "maxCaptionLength",
        "maxDuration",
        "maxHeight",
        "maxSize",
        "maxWidth",
        "viewOnce",
      ], `${label}.attachments.${messageType}`);
      validateCapabilityLevelMap(
        attachment.mimeTypes,
        `${label}.attachments.${messageType}.mimeTypes`,
        1_024,
      );
      if (attachment.caption !== undefined) {
        validateCapabilityLevel(
          attachment.caption,
          `${label}.attachments.${messageType}.caption`,
        );
      }
      for (const key of [
        "maxCaptionLength",
        "maxDuration",
        "maxHeight",
        "maxSize",
        "maxWidth",
      ] as const) {
        if (attachment[key] !== undefined) {
          finiteNumber(
            attachment[key],
            `${label}.attachments.${messageType}.${key}`,
            0,
            Number.MAX_SAFE_INTEGER,
          );
        }
      }
      if (attachment.viewOnce !== undefined) {
        requiredBoolean(
          attachment.viewOnce,
          `${label}.attachments.${messageType}.viewOnce`,
        );
      }
    }
  }
  if (source.disappearingTimer !== undefined) {
    const timer = strictRecord(source.disappearingTimer, `${label}.disappearingTimer`);
    exactKeys(timer, [], ["omitEmptyTimer", "timers", "types"], `${label}.disappearingTimer`);
    if (timer.omitEmptyTimer !== undefined) {
      requiredBoolean(timer.omitEmptyTimer, `${label}.disappearingTimer.omitEmptyTimer`);
    }
    if (timer.timers !== undefined) {
      strictArray(timer.timers, `${label}.disappearingTimer.timers`, 1_000)
        .forEach((item, index) =>
          finiteNumber(
            item,
            `${label}.disappearingTimer.timers[${index}]`,
            0,
            Number.MAX_SAFE_INTEGER,
          ));
    }
    if (timer.types !== undefined) {
      strictArray(timer.types, `${label}.disappearingTimer.types`, 16)
        .forEach((item, index) => {
          if (item !== "afterRead" && item !== "afterSend") {
            throw new Error(`${label}.disappearingTimer.types[${index}] is unsupported`);
          }
        });
    }
  }
  if (source.formatting !== undefined) {
    validateCapabilityLevelMap(source.formatting, `${label}.formatting`, 256);
  }
  for (const key of ["messageRequest", "participantActions"] as const) {
    if (source[key] === undefined) continue;
    const nested = strictRecord(source[key], `${label}.${key}`);
    const allowed = key === "messageRequest"
      ? ["acceptWithButton", "acceptWithMessage"] as const
      : ["ban", "invite", "kick", "leave", "revokeInvite"] as const;
    exactKeys(nested, [], allowed, `${label}.${key}`);
    for (const field of allowed) {
      if (nested[field] !== undefined) {
        validateCapabilityLevel(nested[field], `${label}.${key}.${field}`);
      }
    }
  }
  if (source.state !== undefined) {
    const state = strictRecord(source.state, `${label}.state`);
    exactKeys(state, [], ["avatar", "description", "disappearingTimer", "title"], `${label}.state`);
    for (const key of ["avatar", "description", "disappearingTimer", "title"] as const) {
      if (state[key] === undefined) continue;
      const item = strictRecord(state[key], `${label}.state.${key}`);
      exactKeys(item, ["level"], [], `${label}.state.${key}`);
      validateCapabilityLevel(item.level, `${label}.state.${key}.level`);
    }
  }
}

function validateChatDraft(value: unknown, label: string): void {
  const source = strictRecord(value, label);
  exactKeys(source, ["text"], ["attachments"], label);
  boundedString(source.text, `${label}.text`, MAX_TEXT_BYTES, true, true);
  if (source.attachments === undefined) return;
  const attachments = strictRecord(source.attachments, `${label}.attachments`);
  const entries = Object.entries(attachments);
  if (entries.length > 256) throw new Error(`${label}.attachments contains too many entries`);
  for (const [key, item] of entries) {
    boundedString(key, `${label}.attachments key`, 2_048);
    const attachment = strictRecord(item, `${label}.attachments.${key}`);
    exactKeys(attachment, ["id", "type"], [
      "audioDurationSeconds",
      "fileName",
      "filePath",
      "fileSize",
      "mimeType",
      "size",
      "stickerID",
    ], `${label}.attachments.${key}`);
    boundedString(attachment.id, `${label}.attachments.${key}.id`, 2_048);
    if (
      attachment.type !== "file"
      && attachment.type !== "gif"
      && attachment.type !== "recorded_audio"
    ) throw new Error(`${label}.attachments.${key}.type is unsupported`);
    if (attachment.audioDurationSeconds !== undefined) {
      finiteNumber(
        attachment.audioDurationSeconds,
        `${label}.attachments.${key}.audioDurationSeconds`,
        0,
        31_536_000,
      );
    }
    nullableString(attachment.fileName, `${label}.attachments.${key}.fileName`, 4_096);
    nullableString(attachment.filePath, `${label}.attachments.${key}.filePath`, 16_384);
    if (attachment.fileSize !== undefined) {
      integer(
        attachment.fileSize,
        `${label}.attachments.${key}.fileSize`,
        0,
        Number.MAX_SAFE_INTEGER,
      );
    }
    nullableString(attachment.mimeType, `${label}.attachments.${key}.mimeType`, 256);
    nullableString(attachment.stickerID, `${label}.attachments.${key}.stickerID`, 2_048);
    if (attachment.size !== undefined && attachment.size !== null) {
      const size = strictRecord(attachment.size, `${label}.attachments.${key}.size`);
      exactKeys(size, [], ["height", "width"], `${label}.attachments.${key}.size`);
      optionalInteger(size.height, `${label}.attachments.${key}.size.height`, 0, 1_000_000);
      optionalInteger(size.width, `${label}.attachments.${key}.size.width`, 0, 1_000_000);
    }
  }
}

function parseChatDraftProjection(
  value: unknown,
  label: string,
): BeeperConversationProjection["draft"] {
  if (value === undefined || value === null) return null;
  validateChatDraft(value, label);
  const source = strictRecord(value, label);
  const attachments = source.attachments === undefined
    ? []
    : Object.values(strictRecord(source.attachments, `${label}.attachments`)).map(
        (item, index) => {
          const attachment = strictRecord(item, `${label}.attachments[${index}]`);
          const type = boundedString(attachment.type, `${label}.attachments[${index}].type`, 32);
          if (type !== "file" && type !== "gif" && type !== "recorded_audio") {
            throw new Error(`${label}.attachments[${index}].type is unsupported`);
          }
          return Object.freeze({
            type,
            fileName: nullableString(
              attachment.fileName,
              `${label}.attachments[${index}].fileName`,
              4_096,
            ),
            fileSizeBytes: optionalInteger(
              attachment.fileSize,
              `${label}.attachments[${index}].fileSize`,
              0,
              Number.MAX_SAFE_INTEGER,
            ),
            mimeType: nullableString(
              attachment.mimeType,
              `${label}.attachments[${index}].mimeType`,
              256,
            ),
          });
        },
      );
  return Object.freeze({
    text: boundedString(source.text, `${label}.text`, MAX_TEXT_BYTES, true, true),
    attachments: Object.freeze(attachments),
  });
}

function validateChatReminder(value: unknown, label: string): void {
  const source = strictRecord(value, label);
  exactKeys(source, [], ["dismissOnIncomingMessage", "remindAt"], label);
  if (source.dismissOnIncomingMessage !== undefined) {
    requiredBoolean(source.dismissOnIncomingMessage, `${label}.dismissOnIncomingMessage`);
  }
  if (source.remindAt !== undefined) timestamp(source.remindAt, `${label}.remindAt`);
}

function parseChatReminderProjection(
  value: unknown,
  label: string,
): BeeperConversationProjection["reminder"] {
  if (value === undefined || value === null) return null;
  validateChatReminder(value, label);
  const source = strictRecord(value, label);
  return Object.freeze({
    when: source.remindAt === undefined ? null : timestamp(source.remindAt, `${label}.remindAt`),
    dismissOnMessage: optionalBoolean(
      source.dismissOnIncomingMessage,
      `${label}.dismissOnIncomingMessage`,
    ),
  });
}

function validateChatSnooze(value: unknown, label: string): void {
  const source = strictRecord(value, label);
  exactKeys(source, [], ["snoozeUntil", "userSnoozedAt"], label);
  if (source.snoozeUntil !== undefined) timestamp(source.snoozeUntil, `${label}.snoozeUntil`);
  if (source.userSnoozedAt !== undefined) timestamp(source.userSnoozedAt, `${label}.userSnoozedAt`);
}

function parseSearchedConversation(
  value: unknown,
  label: string,
  accountIds: ReadonlySet<string>,
  expectedAccountId: string | null,
): BeeperConversationProjection {
  const conversation = parseConversation(value, label, accountIds, expectedAccountId);
  const source = strictRecord(value, label);
  if (source.capabilities !== undefined) {
    validateChatCapabilities(source.capabilities, `${label}.capabilities`);
  }
  if (source.draft !== undefined && source.draft !== null) {
    validateChatDraft(source.draft, `${label}.draft`);
  }
  if (source.preview !== undefined) {
    const preview = strictRecord(source.preview, `${label}.preview`);
    parseMessage(
      Object.hasOwn(preview, "isSender")
        ? preview
        : Object.freeze({ ...preview, isSender: false }),
      `${label}.preview`,
      Object.freeze({
        accountId: conversation.accountId,
        conversationId: conversation.id,
        beforeCursor: null,
        afterCursor: null,
        limit: 1,
      }),
    );
  }
  if (source.reminder !== undefined && source.reminder !== null) {
    validateChatReminder(source.reminder, `${label}.reminder`);
  }
  if (source.snooze !== undefined && source.snooze !== null) {
    validateChatSnooze(source.snooze, `${label}.snooze`);
  }
  const participants = conversation.participants;
  const participantIds = participants.items.map(({ id }) => id);
  if (new Set(participantIds).size !== participantIds.length) {
    throw new Error(`${label}.participants repeated a stable user ID`);
  }
  if (
    participants.items.length > participants.total
    || participants.hasMore !== (participants.items.length < participants.total)
  ) {
    throw new Error(`${label}.participants completeness evidence is inconsistent`);
  }
  if (participants.items.filter(({ isSelf }) => isSelf === true).length > 1) {
    throw new Error(`${label}.participants contains ambiguous self ownership`);
  }
  return conversation;
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

async function pinnedBinaryCandidate(
  path: string,
  executableSha256: string,
): Promise<string | null> {
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
  ) return null;
  return await sha256File(canonical) === executableSha256
    ? canonical
    : null;
}

export async function resolvePinnedBeeperCliBinary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const artifact = beeperCliArtifactForRuntime();
  const platformCandidates = process.platform === "darwin"
    ? process.arch === "arm64"
      ? ["/opt/homebrew/bin/beeper", "/usr/local/bin/beeper"]
      : ["/usr/local/bin/beeper", "/opt/homebrew/bin/beeper"]
    : process.platform === "linux"
      ? ["/usr/local/bin/beeper", "/usr/bin/beeper", "/opt/beeper/bin/beeper"]
      : [];
  const candidates = [
    join(wrenchStateHome(environment), "tools", "beeper", BEEPER_CLI_PIN.version, "beeper"),
    ...platformCandidates,
  ];
  for (const candidate of candidates) {
    const found = await pinnedBinaryCandidate(candidate, artifact.executableSha256);
    if (found !== null) return found;
  }
  throw new Error(
    `pinned Beeper CLI ${BEEPER_CLI_PIN.version} is not installed or failed integrity verification`,
  );
}

export async function materializePinnedBeeperCliBinary(
  sourcePath: string,
  operationRoot: string,
  expectedSha256: string,
): Promise<string> {
  if (!isAbsolute(sourcePath) || !isAbsolute(operationRoot)) {
    throw new Error("Beeper CLI executable materialization requires absolute paths");
  }
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const destinationPath = join(operationRoot, "beeper");
  let destination;
  try {
    const before = await source.stat();
    if (
      !before.isFile()
      || before.size < 1
      || before.size > 256 * 1024 * 1024
      || (before.mode & 0o022) !== 0
      || (before.mode & 0o111) === 0
      || (before.uid !== process.getuid?.() && before.uid !== 0)
    ) throw new Error("Beeper CLI executable source is unsafe");
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (read.bytesRead < 1) throw new Error("Beeper CLI executable changed while copied");
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.byteLength) {
        const result = await destination.write(
          chunk,
          written,
          chunk.byteLength - written,
          offset + written,
        );
        if (result.bytesWritten < 1) throw new Error("Beeper CLI private executable copy failed");
        written += result.bytesWritten;
      }
      offset += read.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const extra = await source.read(overflow, 0, 1, offset);
    const after = await source.stat();
    if (
      extra.bytesRead !== 0
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || hash.digest("hex") !== expectedSha256
    ) throw new Error("Beeper CLI executable changed or failed its exact pin while copied");
  } finally {
    await destination?.close();
    await source.close();
  }
  await chmod(destinationPath, 0o500);
  if (await sha256File(destinationPath) !== expectedSha256) {
    throw new Error("Beeper CLI private executable copy failed its exact pin");
  }
  return destinationPath;
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

type ValidatedBeeperCliStore = Readonly<{
  canonical: string;
  effectiveAuth: JsonRecord;
  targetBaseUrl: string;
}>;

async function validateBeeperCliStoreInternal(path: string): Promise<ValidatedBeeperCliStore> {
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
    const targetBasePort = targetBaseUrl === undefined
      ? null
      : Number(new URL(targetBaseUrl).port);
    if (
      (target.managed !== undefined && target.managed !== false)
      || target.dataDir !== undefined
      || target.profile !== undefined
      || target.serverEnv !== undefined
    ) {
      throw new Error("Beeper Desktop target contains an active endpoint override");
    }
    if (target.port !== undefined) {
      const declaredPort = integer(target.port, "Beeper Desktop target.port", 23_373, 23_392);
      if (declaredPort !== targetBasePort) {
        throw new Error("Beeper Desktop target.port did not match its exact base URL");
      }
    }
    if (target.runtime !== undefined) {
      const runtime = strictRecord(target.runtime, "Beeper Desktop target.runtime");
      exactKeys(runtime, ["install", "port"], [], "Beeper Desktop target.runtime");
      if (runtime.install !== "desktop") {
        throw new Error("Beeper Desktop target.runtime.install is unsupported");
      }
      const runtimePort = integer(
        runtime.port,
        "Beeper Desktop target.runtime.port",
        23_373,
        23_392,
      );
      if (runtimePort !== targetBasePort) {
        throw new Error("Beeper Desktop target.runtime.port did not match its exact base URL");
      }
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
  if (targetBaseUrl === undefined) {
    throw new Error("Beeper Desktop target has no exact loopback base URL");
  }
  const [rootAfter, targetsAfter, rootRealpathAfter, targetsRealpathAfter] = await Promise.all([
    lstat(canonical),
    lstat(targetsPath),
    realpath(canonical),
    realpath(targetsPath),
  ]);
  if (
    rootRealpathAfter !== canonical
    || targetsRealpathAfter !== targetsPath
    || !rootAfter.isDirectory()
    || !targetsAfter.isDirectory()
    || rootAfter.isSymbolicLink()
    || targetsAfter.isSymbolicLink()
    || rootAfter.dev !== stats.dev
    || rootAfter.ino !== stats.ino
    || rootAfter.mtimeMs !== stats.mtimeMs
    || rootAfter.ctimeMs !== stats.ctimeMs
    || targetsAfter.dev !== targetDirectoryStats.dev
    || targetsAfter.ino !== targetDirectoryStats.ino
    || targetsAfter.mtimeMs !== targetDirectoryStats.mtimeMs
    || targetsAfter.ctimeMs !== targetDirectoryStats.ctimeMs
  ) throw new Error("Beeper CLI config store changed while its exact snapshot was read");
  return Object.freeze({ canonical, effectiveAuth, targetBaseUrl });
}

export async function validateBeeperCliStore(path: string): Promise<string> {
  try {
    return (await validateBeeperCliStoreInternal(path)).canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Beeper ")) {
      throw error;
    }
    throw new Error("Beeper CLI config directory could not be validated safely");
  }
}

async function materializePrivateBeeperCliStore(
  sourcePath: string,
  operationRoot: string,
): Promise<Readonly<{ path: string; targetBaseUrl: string }>> {
  const snapshot = await validateBeeperCliStoreInternal(sourcePath);
  const configDirectory = join(operationRoot, "beeper-config");
  const targetsDirectory = join(configDirectory, "targets");
  await mkdir(targetsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(configDirectory, "config.json"),
    `${JSON.stringify({ defaultTarget: BEEPER_DESKTOP_TARGET })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  await writeFile(
    join(targetsDirectory, "desktop.json"),
    `${JSON.stringify({
      id: BEEPER_DESKTOP_TARGET,
      type: "desktop",
      baseURL: snapshot.targetBaseUrl,
      auth: snapshot.effectiveAuth,
      managed: false,
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return Object.freeze({ path: configDirectory, targetBaseUrl: snapshot.targetBaseUrl });
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

const BEEPER_DIRECT_REQUEST_TIMEOUT_MS = 30_000;
const BEEPER_DIRECT_RESPONSE_BYTES = 8 * 1024 * 1024;

function parseBeeperDirectInfo(
  value: unknown,
  expectedBaseUrl: string,
): BeeperTargetRealmProof {
  const source = strictRecord(value, "Beeper Desktop direct info");
  exactKeys(
    source,
    ["app", "endpoints", "platform", "server"],
    [],
    "Beeper Desktop direct info",
  );
  const app = strictRecord(source.app, "Beeper Desktop direct info.app");
  exactKeys(app, ["bundle_id", "name", "version"], [], "Beeper Desktop direct info.app");
  const server = strictRecord(source.server, "Beeper Desktop direct info.server");
  exactKeys(
    server,
    ["base_url", "hostname", "mcp_enabled", "port", "remote_access", "status"],
    [],
    "Beeper Desktop direct info.server",
  );
  const bundleId = boundedString(
    app.bundle_id,
    "Beeper Desktop direct info.app.bundle_id",
    256,
  );
  if (!BEEPER_DESKTOP_BUNDLE_IDS.includes(
    bundleId as typeof BEEPER_DESKTOP_BUNDLE_IDS[number],
  )) throw new Error("Beeper Desktop direct info returned an unsupported bundle ID");
  const baseUrl = localDesktopBaseUrl(
    server.base_url,
    "Beeper Desktop direct info.server.base_url",
  );
  const expectedPort = Number(new URL(expectedBaseUrl).port);
  if (
    baseUrl !== expectedBaseUrl
    || server.hostname !== "127.0.0.1"
    || integer(server.port, "Beeper Desktop direct info.server.port", 23_373, 23_392)
      !== expectedPort
    || server.remote_access !== false
    || typeof server.mcp_enabled !== "boolean"
    || boundedString(server.status, "Beeper Desktop direct info.server.status", 128)
      !== "ready"
  ) throw new Error("Beeper Desktop direct info did not bind the selected local realm");
  // These documents are not used to choose an endpoint. Parsing them prevents
  // an unexpected response shape from silently becoming accepted evidence.
  strictRecord(source.endpoints, "Beeper Desktop direct info.endpoints");
  strictRecord(source.platform, "Beeper Desktop direct info.platform");
  return Object.freeze({
    baseUrl,
    bundleId: bundleId as typeof BEEPER_DESKTOP_BUNDLE_IDS[number],
    version: boundedString(app.version, "Beeper Desktop direct info.app.version", 256),
  });
}

async function beeperDirectJsonRequest(
  url: string,
  init: RequestInit,
  label: string,
  dependencies: BeeperDirectMessagingDependencies | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const request = dependencies?.fetch ?? fetch;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`${label} timed out`)),
    BEEPER_DIRECT_REQUEST_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await request(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
  if (
    response.redirected
    || response.url !== "" && response.url !== url
    || response.status !== 200
    || response.body === null
  ) throw new Error(`${label} did not return one exact successful response`);
  const text = await readBoundedStream(
    response.body,
    BEEPER_DIRECT_RESPONSE_BYTES,
    `${label} response`,
  );
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
  return value;
}

/**
 * Submit exactly one text part to the pinned Beeper Desktop loopback API.
 *
 * This path intentionally does not call the Beeper CLI or SDK: the CLI places
 * text in child argv and the SDK retries by default. All realm and target reads
 * finish before `beforeExternalBegin`; after that durable fence there is one
 * POST, no retry, and any missing exact acceptance must remain indeterminate.
 */
export async function executeBeeperDirectMessagingPart(
  inputValue: OperationInput,
  authValue: WrenchAuth,
  attempt: BeeperDirectMessagingAttempt,
): Promise<BeeperDirectMessagingAcceptance> {
  const input = parseBeeperOperationInput("messaging.send", inputValue);
  if (
    !("kind" in input)
    || input.kind !== "text"
    || input.text === null
    || input.mentions.length !== 0
    || input.noPreview
  ) throw new Error("Beeper direct messaging v1 accepts only exact text and reply parts");
  const auth = requireBeeperAuth(authValue);
  if (auth.subject === undefined) {
    throw new Error("Beeper direct messaging requires one bound local account realm");
  }
  const snapshot = await validateBeeperCliStoreInternal(auth.path);
  const accessToken = snapshot.effectiveAuth.accessToken;
  if (typeof accessToken !== "string") {
    throw new Error("Beeper Desktop selected target lost its effective bearer token");
  }
  const authorization = `Bearer ${accessToken}`;
  const baseUrl = snapshot.targetBaseUrl.endsWith("/")
    ? snapshot.targetBaseUrl.slice(0, -1)
    : snapshot.targetBaseUrl;
  const commonHeaders = Object.freeze({
    Accept: "application/json",
    Authorization: authorization,
  });
  const info = parseBeeperDirectInfo(
    await beeperDirectJsonRequest(
      `${baseUrl}/v1/info`,
      { method: "GET", headers: { Accept: "application/json" } },
      "Beeper Desktop direct info",
      attempt.dependencies,
      attempt.signal,
    ),
    snapshot.targetBaseUrl,
  );
  const accounts = parseAccounts(await beeperDirectJsonRequest(
    `${baseUrl}/v1/accounts`,
    { method: "GET", headers: commonHeaders },
    "Beeper Desktop direct accounts",
    attempt.dependencies,
    attempt.signal,
  ));
  requireBoundAccount(accounts, input.accountId, "Beeper direct messaging");
  const subject = beeperSubjectFromAccountsAndTarget(
    accounts,
    info.baseUrl,
    info.bundleId,
    info.version,
  );
  if (subject !== auth.subject) {
    throw new Error("Beeper Desktop direct account did not match the bound auth realm");
  }
  const chatPath = `/v1/chats/${encodeURIComponent(input.conversationId)}`;
  exactConversation(
    await beeperDirectJsonRequest(
      `${baseUrl}${chatPath}`,
      { method: "GET", headers: commonHeaders },
      "Beeper Desktop direct conversation",
      attempt.dependencies,
      attempt.signal,
    ),
    accounts,
    input.accountId,
    input.conversationId,
    "Beeper Desktop direct conversation",
  );
  const body = JSON.stringify({
    text: input.text,
    ...(input.replyTo === null ? {} : { replyToMessageID: input.replyTo }),
  });
  await attempt.beforeExternalBegin();
  const acceptance = strictRecord(
    await beeperDirectJsonRequest(
      `${baseUrl}${chatPath}/messages`,
      {
        method: "POST",
        headers: {
          ...commonHeaders,
          "Content-Type": "application/json",
        },
        body,
      },
      "Beeper Desktop direct send",
      attempt.dependencies,
      attempt.signal,
    ),
    "Beeper Desktop direct acceptance",
  );
  exactKeys(
    acceptance,
    ["chatID", "pendingMessageID"],
    [],
    "Beeper Desktop direct acceptance",
  );
  const conversationId = boundedString(
    acceptance.chatID,
    "Beeper Desktop direct acceptance.chatID",
    2_048,
  );
  if (conversationId !== input.conversationId) {
    throw new Error("Beeper Desktop direct acceptance changed the exact conversation");
  }
  return Object.freeze({
    provider: "beeper",
    operation: "messaging.send",
    accountSubject: subject,
    accountId: input.accountId,
    conversationId,
    pendingMessageId: boundedString(
      acceptance.pendingMessageID,
      "Beeper Desktop direct acceptance.pendingMessageID",
      2_048,
    ),
    providerRevision: null,
  });
}

async function runBeeperCli(
  invocation: BeeperCliInvocation,
): Promise<BeeperCliInvocationResult> {
  throwIfBeeperCliCancelled(invocation.signal);
  await invocation.beforeSpawn?.();
  throwIfBeeperCliCancelled(invocation.signal);
  const ownsProcessGroup = process.platform !== "win32";
  const child = Bun.spawn([invocation.binary, ...invocation.arguments], {
    env: { ...invocation.environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: ownsProcessGroup,
  });
  try {
    invocation.afterSpawn?.(child.pid);
  } catch (error) {
    try {
      if (ownsProcessGroup) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // The unadmitted process already exited.
    }
    await child.exited;
    throw error;
  }
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

function throwIfBeeperCliCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("Beeper CLI command was cancelled");
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
  operationRoot: string,
  mutation: boolean,
): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    CI: "1",
    HOME: join(operationRoot, "home"),
    TMPDIR: join(operationRoot, "tmp"),
    XDG_CONFIG_HOME: join(operationRoot, "xdg-config"),
    XDG_DATA_HOME: join(operationRoot, "xdg-data"),
    XDG_CACHE_HOME: join(operationRoot, "xdg-cache"),
    BEEPER_CLI_CONFIG_DIR: configDirectory,
    BEEPER_CLI_BINARY_CACHE_DIR: join(operationRoot, "binary-cache"),
    BEEPER_DATA_DIR: join(operationRoot, "oclif-data"),
    BEEPER_CONFIG_DIR: join(operationRoot, "oclif-config"),
    BEEPER_CACHE_DIR: join(operationRoot, "oclif-cache"),
    ...(mutation ? {} : { BEEPER_READONLY: "1" }),
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
  beforeSpawn?: () => Promise<void>,
  afterSpawn?: (pid: number) => void,
): Promise<unknown> {
  const run = dependencies?.run ?? runBeeperCli;
  const invoke = () => run({
    binary,
    arguments: command.argv,
    environment,
    timeoutMs: remainingTimeoutMs(timeoutMs, deadline),
    maxOutputBytes,
    maxStderrBytes: MAX_STDERR_BYTES,
    ...(beforeSpawn === undefined ? {} : { beforeSpawn }),
    ...(afterSpawn === undefined ? {} : { afterSpawn }),
    ...(deadline === undefined ? {} : { signal: deadline.signal }),
  });
  const result = deadline === undefined
    ? await invoke()
    : await deadline.run(invoke, OPERATION_LABEL);
  deadline?.throwIfUnavailable(OPERATION_LABEL);
  if (result.exitCode !== 0 || result.stderr.trim().length !== 0) {
    throw new Error("Beeper CLI operation failed before producing reviewed output");
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
  publishCleanupResource: ProviderPluginCleanupResourcePublisher | undefined,
  cleanup: ProviderPluginCleanupProofController,
  durableCleanupAdmissionRequired: boolean,
  operation: (context: Readonly<{
    binary: string;
    operationRoot: string;
    accounts: readonly BeeperAccountProjection[];
    subject: string;
    run: (
      command: BeeperCommand,
      maximum?: number,
      beforeSpawn?: () => Promise<void>,
    ) => Promise<unknown>;
  }>) => Promise<T>,
): Promise<T> {
  if (durableCleanupAdmissionRequired && publishCleanupResource === undefined) {
    const error = new BeeperLocalCleanupUnverifiedError();
    cleanup.unsafe(error);
    throw error;
  }
  const createCache = dependencies?.createCacheDirectory
    ?? createBeeperOperationRoot;
  let cacheDirectory: string | undefined;
  let cleanupResource: LocalCliCleanupResourceIdentityV1 | undefined;
  let productionSpawnAttempted = false;
  try {
    cacheDirectory = await createCache();
    if (!isAbsolute(cacheDirectory)) throw new Error("Beeper CLI cache directory must be absolute");
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    await chmod(cacheDirectory, 0o700);
    cleanupResource = captureLocalCliCleanupResource(cacheDirectory);
    publishCleanupResource?.(cleanupResource);
    const afterSpawn = dependencies?.run === undefined && publishCleanupResource !== undefined
      ? (pid: number): void => {
          productionSpawnAttempted = true;
          cleanupResource = attachLocalCliCleanupProcessGroup(cleanupResource!, pid);
          publishCleanupResource(cleanupResource);
        }
      : undefined;
    for (const name of [
      "binary-cache",
      "oclif-data",
      "oclif-config",
      "oclif-cache",
      "home",
      "tmp",
      "xdg-config",
      "xdg-data",
      "xdg-cache",
    ]) {
      await mkdir(join(cacheDirectory, name), { mode: 0o700 });
    }
    const binarySource = dependencies?.binaryPath
      ?? await resolvePinnedBeeperCliBinary(environment);
    if (dependencies?.binaryPath !== undefined && !isAbsolute(binarySource)) {
      throw new Error("test Beeper CLI binary path must be absolute");
    }
    const binary = dependencies?.binaryPath !== undefined
      ? binarySource
      : await materializePinnedBeeperCliBinary(
          binarySource,
          cacheDirectory,
          beeperCliArtifactForRuntime().executableSha256,
        );
    const privateStore = await materializePrivateBeeperCliStore(auth.path, cacheDirectory);
    const readEnvironment = environmentForBeeper(privateStore.path, cacheDirectory, false);
    const run = (
      command: BeeperCommand,
      maximum = maxOutputBytes,
      beforeSpawn?: () => Promise<void>,
    ): Promise<unknown> =>
      executeCommand(
        binary,
        command,
        environmentForBeeper(privateStore.path, cacheDirectory!, command.mutation),
        timeoutMs,
        maximum,
        dependencies,
        deadline,
        beforeSpawn,
        afterSpawn,
      );
    const version = await executeCommand(
      binary,
      planBeeperVersionCommand(),
      readEnvironment,
      timeoutMs,
      4_096,
      dependencies,
      deadline,
      undefined,
      afterSpawn,
    );
    const versionRecord = strictRecord(version, "Beeper CLI version");
    exactKeys(versionRecord, ["name", "version"], [], "Beeper CLI version");
    if (versionRecord.name !== "@beeper/cli" || versionRecord.version !== BEEPER_CLI_PIN.version) {
      throw new Error("Beeper CLI runtime version did not match its pin");
    }
    const targetProof = parseBeeperTargetRealmProof(
      await run(planBeeperTargetStatusCommand(timeoutMs), 64 * 1024),
      privateStore.targetBaseUrl,
    );
    const accounts = parseAccounts(await run(planBeeperAccountsListCommand(timeoutMs), 8 * 1024 * 1024));
    const subject = beeperSubjectFromAccountsAndTarget(
      accounts,
      privateStore.targetBaseUrl,
      targetProof.bundleId,
      targetProof.version,
    );
    if (auth.subject !== undefined && auth.subject !== subject) {
      throw new Error("Beeper CLI current account did not match the bound auth realm");
    }
    return await operation(Object.freeze({
      binary,
      operationRoot: cacheDirectory,
      accounts,
      subject,
      run,
    }));
  } finally {
    try {
      if (cacheDirectory === undefined) {
        cleanup.verified();
      } else if (dependencies?.removeCacheDirectory !== undefined) {
        await dependencies.removeCacheDirectory(cacheDirectory);
      } else if (cleanupResource !== undefined) {
        const processGroups = cleanupResource.processGroups ?? [];
        if (
          (productionSpawnAttempted && processGroups.length === 0)
          || (processGroups.length > 0
            && localCliCleanupProcessGroupStatus(cleanupResource) !== "quiescent")
        ) throw new BeeperLocalCleanupUnverifiedError();
        const removed = removePrivateDirectoryTree(cacheDirectory, {
          device: cleanupResource.root.device,
          inode: cleanupResource.root.inode,
          birthtimeNs: cleanupResource.root.birthtimeNs,
        });
        if (!removed) throw new BeeperLocalCleanupUnverifiedError();
      }
      cleanup.verified();
    } catch {
      const error = new BeeperLocalCleanupUnverifiedError();
      cleanup.unsafe(error);
      if (!durableCleanupAdmissionRequired) throw error;
    }
  }
}

export async function probeBeeperLocalSubject(
  authValue: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly dependencies?: BeeperLocalRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly registerCleanupBarrier?: LocalCliExecutionOptions["registerCleanupBarrier"];
  } = {},
): Promise<string> {
  const auth = requireBeeperAuth(authValue);
  const deadline = new OperationDeadline(SUBJECT_PROBE_TIMEOUT_MS, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    return await startProviderPluginCleanupTrackedOperation(
      options.registerCleanupBarrier,
      async (publishCleanupResource, cleanup) => withRuntime(
        auth,
        SUBJECT_PROBE_TIMEOUT_MS,
        8 * 1024 * 1024,
        options.dependencies,
        options.environment ?? process.env,
        deadline,
        publishCleanupResource,
        cleanup,
        options.registerCleanupBarrier !== undefined,
        async ({ subject }) => subject,
      ),
    );
  } catch (error) {
    if (error instanceof BeeperLocalCleanupUnverifiedError) throw error;
    throw new Error("Beeper subject probe failed at a protected local boundary");
  } finally {
    deadline.dispose();
  }
}

export async function inspectBeeperLocalRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<LocalCliPluginRuntimeStatusV1> {
  const artifact = beeperCliArtifactForRuntime();
  try {
    await resolvePinnedBeeperCliBinary(environment);
    return Object.freeze({
      ready: true,
      platform: artifact.platform,
      arch: artifact.arch,
      version: BEEPER_CLI_PIN.version,
      executableSha256: artifact.executableSha256,
      reason: null,
    });
  } catch {
    return Object.freeze({
      ready: false,
      platform: process.platform,
      arch: process.arch,
      version: null,
      executableSha256: null,
      reason: "the exact pinned Beeper CLI executable is unavailable or failed integrity verification",
    });
  }
}

function acceptedReconciliationTarget(
  context: ProviderPluginReconciliationContextV1 | undefined,
  action: "messaging.send" | "conversations.start",
): JsonRecord {
  if (context?.kind !== "provider-accepted-target-presence") {
    throw new Error("Beeper accepted-target reconciliation requires exact durable target evidence");
  }
  const identifier = boundedString(
    context.target.identifier,
    "Beeper accepted reconciliation target",
    8_192,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(identifier) as unknown;
  } catch {
    throw new Error("Beeper accepted reconciliation target is malformed");
  }
  if (canonicalJson(parsed) !== identifier) {
    throw new Error("Beeper accepted reconciliation target is not canonical");
  }
  const target = strictRecord(parsed, "Beeper accepted reconciliation target");
  exactKeys(
    target,
    action === "messaging.send"
      ? ["accountId", "conversationId", "pendingMessageId"]
      : ["accountId", "conversationId"],
    [],
    "Beeper accepted reconciliation target",
  );
  boundedString(target.accountId, "Beeper accepted reconciliation account", 512);
  boundedString(target.conversationId, "Beeper accepted reconciliation chat", 2_048);
  if (action === "messaging.send") {
    boundedString(
      target.pendingMessageId,
      "Beeper accepted reconciliation pending message",
      2_048,
    );
  }
  return target;
}

function requireObservedConversationState(
  action: BeeperLocalOperationName,
  conversation: BeeperConversationProjection,
): void {
  if (action === "conversations.description.set" && !conversation.descriptionObserved) {
    throw new Error("Beeper description reconciliation is inconclusive");
  }
  if (action === "conversations.disappearing.set" && !conversation.messageExpiryObserved) {
    throw new Error("Beeper disappearing-message reconciliation is inconclusive");
  }
  if (action === "conversations.reminder.set" && !conversation.reminderObserved) {
    throw new Error("Beeper reminder reconciliation is inconclusive");
  }
}

export async function reconcileBeeperLocalOperation(
  operation: string,
  inputValue: OperationInput,
  authValue: WrenchAuth,
  context?: ProviderPluginReconciliationContextV1,
  options: ProviderPluginReconciliationOptionsV1 & Readonly<{
    dependencies?: BeeperLocalRuntimeDependencies;
  }> = {},
): Promise<ProviderPluginReconciliationReadbackV1> {
  if (!isBeeperLocalOperation(operation)) {
    throw new Error("Beeper reconciliation operation is not installed");
  }
  const action = operation;
  const input = parseBeeperOperationInput(action, inputValue);
  const value = operationInputRecord(input);
  const auth = requireBeeperAuth(authValue);
  if (auth.subject === undefined) {
    throw new Error("Beeper reconciliation requires an exact bound account realm");
  }
  const deadline = new OperationDeadline(SUBJECT_PROBE_TIMEOUT_MS, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    return await startProviderPluginCleanupTrackedOperation(
      options.registerCleanupBarrier,
      async (publishCleanupResource, cleanup) => withRuntime(
        auth,
        SUBJECT_PROBE_TIMEOUT_MS,
        10 * 1024 * 1024,
        options.dependencies,
        options.environment ?? process.env,
        deadline,
        publishCleanupResource,
        cleanup,
        options.registerCleanupBarrier !== undefined,
        async ({ accounts, run }) => {
          if (action === "messaging.send" || action === "conversations.start") {
            const target = acceptedReconciliationTarget(context, action);
            const accountId = target.accountId as string;
            const conversationId = target.conversationId as string;
            requireBoundAccount(accounts, accountId, action);
            if (action === "conversations.start") {
              const readInput = parseBeeperOperationInput("conversations.read", {
                account_id: accountId,
                conversation_id: conversationId,
                max_participants: 500,
              });
              exactConversation(
                await run(planBeeperReadCommand("conversations.read", readInput, SUBJECT_PROBE_TIMEOUT_MS)),
                accounts,
                accountId,
                conversationId,
                "Beeper started conversation reconciliation",
              );
              return Object.freeze({
                actualState: true,
                reason: "the exact provider-accepted conversation is present",
              });
            }
            const pendingMessageId = target.pendingMessageId as string;
            const readInput = parseBeeperOperationInput("messaging.message.read", {
              account_id: accountId,
              conversation_id: conversationId,
              message_id: pendingMessageId,
            });
            const raw = await run(planBeeperReadCommand(
              "messaging.message.read",
              readInput,
              SUBJECT_PROBE_TIMEOUT_MS,
            ));
            const message = parseMessage(raw, "Beeper accepted send reconciliation", {
              accountId,
              conversationId,
              beforeCursor: null,
              afterCursor: null,
              limit: 1,
            });
            if (
              message.isSender !== true
              || message.isDeleted
              || message.isHidden
              || ((value.kind === "text" || value.kind === "file")
                && value.text !== null
                && message.text !== value.text)
              || (value.kind !== "text" && message.attachments.length < 1)
              || (value.kind === "sticker"
                && !message.attachments.some((attachment) => attachment.isSticker))
              || (value.kind === "voice"
                && !message.attachments.some((attachment) => attachment.isVoiceNote))
            ) {
              throw new Error("Beeper accepted send reconciliation is inconclusive");
            }
            return Object.freeze({
              actualState: true,
              reason: "the provider accepted pending target resolved to an exact outgoing message",
            });
          }
          if (context !== undefined) {
            throw new Error("Beeper desired-state reconciliation does not accept target context");
          }
          const accountId = value.accountId as string;
          requireBoundAccount(accounts, accountId, action);
          if (
            (action === "conversations.avatar.set" && value.file !== null)
            || (action === "conversations.draft.set" && value.file !== null)
            || (action === "conversations.read-state.set" && value.messageId !== null)
          ) {
            throw new Error("Beeper operation has no exact reconciliation readback for this input variant");
          }
          if (action === "reactions.set" || action === "messaging.edit") {
            const readInput = parseBeeperOperationInput("messaging.message.read", {
              account_id: accountId,
              conversation_id: value.conversationId as string,
              message_id: value.messageId as string,
            });
            const message = exactMessage(
              await run(planBeeperReadCommand("messaging.message.read", readInput, SUBJECT_PROBE_TIMEOUT_MS)),
              accountId,
              value.conversationId as string,
              value.messageId as string,
              "Beeper message reconciliation",
            );
            const actualState = action === "messaging.edit"
              ? message.isSender === true && message.text === value.text
              : message.reactions.some((reaction) =>
                  reaction.participantId === requireBoundAccount(accounts, accountId, action).user.id
                  && reaction.reactionKey === value.reaction);
            return Object.freeze({
              actualState,
              reason: "the exact message projection supplied a definitive desired-state readback",
            });
          }
          if (typeof value.conversationId !== "string") {
            throw new Error("Beeper reconciliation operation has no exact chat target");
          }
          const readInput = parseBeeperOperationInput("conversations.read", {
            account_id: accountId,
            conversation_id: value.conversationId,
            max_participants: 500,
          });
          const conversation = exactConversation(
            await run(planBeeperReadCommand("conversations.read", readInput, SUBJECT_PROBE_TIMEOUT_MS)),
            accounts,
            accountId,
            value.conversationId,
            "Beeper conversation reconciliation",
          );
          requireObservedConversationState(action, conversation);
          const actualState = desiredChatState(action, value, conversation);
          if (actualState === null) {
            throw new Error("Beeper operation has no exact reconciliation readback");
          }
          return Object.freeze({
            actualState,
            reason: "the exact conversation projection supplied a definitive desired-state readback",
          });
        },
      ),
    );
  } catch (error) {
    if (error instanceof BeeperLocalCleanupUnverifiedError) throw error;
    throw new Error("Beeper reconciliation could not obtain definitive protected evidence");
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
  if (contacts.length > input.limit) {
    throw new Error("Beeper contacts exceeded the requested result bound");
  }
  const requestedLimitReached = contacts.length >= input.limit;
  return Object.freeze({
    provider: "beeper",
    operation: "contacts.list",
    accountSubject: subject,
    projection: "bounded-local-desktop-api",
    accounts: publicAccountProjections(accounts),
    requestedAccountId: accountId,
    contacts: Object.freeze(contacts),
    completeness: Object.freeze({
      localPageComplete: false,
      resultWindowComplete: false,
      remoteContactSetComplete: false,
      continuationAvailable: false,
      requestedLimitReached,
      warnings: Object.freeze([
        "beeper-cli-v0.6.2-contact-result-window-has-no-continuation",
        "beeper-cli-v0.6.2-may-cap-results-below-the-requested-limit",
        "provider-history-coverage-varies-by-connected-account",
      ]),
    }),
  });
}

function conversationOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: BeeperMessagingListInput,
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
  for (const conversation of conversations) {
    if (
      (input.archived !== null && (conversation.isArchived === true) !== input.archived)
      || (input.pinned !== null && (conversation.isPinned === true) !== input.pinned)
      || (input.muted !== null && (conversation.isMuted === true) !== input.muted)
      || (input.lowPriority !== null
        && (conversation.isLowPriority === true) !== input.lowPriority)
      || (input.unread !== null
        && (conversation.unreadCount > 0 || conversation.isMarkedUnread === true) !== input.unread)
    ) throw new Error("Beeper conversation output did not satisfy the exact requested state filters");
  }
  if (conversations.length > input.limit) {
    throw new Error("Beeper conversations exceeded the requested result bound");
  }
  const ids = conversations.map((conversation) => `${conversation.accountId}\0${conversation.id}`);
  if (new Set(ids).size !== ids.length) throw new Error("Beeper conversations repeat an account-scoped ID");
  const requestedLimitReached = conversations.length >= input.limit;
  return Object.freeze({
    provider: "beeper",
    operation: "messaging.list",
    accountSubject: subject,
    projection: "bounded-local-desktop-api",
    accounts: publicAccountProjections(accounts),
    requestedAccountId: accountId,
    conversations: Object.freeze(conversations),
    completeness: Object.freeze({
      localPageComplete: false,
      resultWindowComplete: false,
      remoteConversationSetComplete: false,
      continuationAvailable: false,
      requestedLimitReached,
      warnings: Object.freeze([
        "beeper-cli-v0.6.2-chat-result-window-has-no-continuation",
        "newly-connected-accounts-may-have-incomplete-history",
      ]),
    }),
  });
}

function requestedAccount(
  accounts: readonly BeeperAccountProjection[],
  accountId: string | null,
  operation: string,
): ReadonlyMap<string, BeeperAccountProjection> {
  const byId = new Map(accounts.map((account) => [account.accountId, account]));
  if (accountId !== null && !byId.has(accountId)) {
    throw new Error(`${operation} requested an account outside the bound Beeper realm`);
  }
  return byId;
}

function contactSearchOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: BeeperContactsSearchInput,
  raw: unknown,
) {
  const byAccountId = requestedAccount(
    accounts,
    input.accountId,
    "contacts.search",
  );
  const accountIds = new Set(byAccountId.keys());
  const candidates = parseContacts(raw, accountIds, input.accountId).map((contact) => {
    const account = byAccountId.get(contact.accountId);
    if (account === undefined) {
      throw new Error("contacts.search result escaped the bound Beeper realm");
    }
    return Object.freeze({
      accountId: contact.accountId,
      network: account.network,
      id: contact.user.id,
      fullName: contact.user.fullName,
      username: contact.user.username,
      isSelf: contact.user.isSelf,
    });
  });
  const ids = candidates.map((contact) => `${contact.accountId}\0${contact.id}`);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Beeper contact search repeated an account-scoped identity");
  }
  const contacts = candidates.slice(0, input.limit);
  return Object.freeze({
    provider: "beeper",
    operation: "contacts.search",
    accountSubject: subject,
    projection: "bounded-local-desktop-search",
    requestedAccountId: input.accountId,
    query: input.query,
    searchSemantics: "provider-fuzzy-candidates",
    contacts: Object.freeze(contacts),
    completeness: Object.freeze({
      resultWindowComplete: false,
      remoteContactSetComplete: false,
      continuationAvailable: false,
      requestedLimitReached: candidates.length >= input.limit,
      warnings: Object.freeze([
        "beeper-cli-v0.6.2-search-results-are-fuzzy-candidates",
        "beeper-cli-v0.6.2-contact-search-result-window-has-no-continuation",
        "provider-history-coverage-varies-by-connected-account",
      ]),
    }),
  });
}

function messagingSearchOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: BeeperMessagingSearchInput,
  raw: unknown,
) {
  const byAccountId = requestedAccount(
    accounts,
    input.accountId,
    "messaging.search",
  );
  const accountIds = new Set(byAccountId.keys());
  const parsed = strictArray(raw, "Beeper searched conversations", MAX_CHATS)
    .map((item, index) => parseSearchedConversation(
      item,
      `Beeper searched conversations[${index}]`,
      accountIds,
      input.accountId,
    ));
  if (parsed.length > input.limit) {
    throw new Error("Beeper conversation search exceeded the requested result bound");
  }
  const ids = parsed.map((conversation) => `${conversation.accountId}\0${conversation.id}`);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Beeper conversation search repeated an account-scoped ID");
  }
  const conversations = parsed.map((conversation) => Object.freeze({
    id: conversation.id,
    accountId: conversation.accountId,
    network: conversation.network,
    title: conversation.title,
    type: conversation.type,
    direct: conversation.type === "single",
    participants: Object.freeze({
      items: Object.freeze(conversation.participants.items.map((participant) =>
        Object.freeze({
          id: participant.id,
          fullName: participant.fullName,
          username: participant.username,
          isSelf: participant.isSelf,
        }))),
      total: conversation.participants.total,
      hasMore: conversation.participants.hasMore,
    }),
  }));
  return Object.freeze({
    provider: "beeper",
    operation: "messaging.search",
    accountSubject: subject,
    projection: "bounded-local-desktop-search",
    requestedAccountId: input.accountId,
    query: input.query,
    searchSemantics: "provider-fuzzy-candidates",
    conversations: Object.freeze(conversations),
    completeness: Object.freeze({
      resultWindowComplete: false,
      remoteConversationSetComplete: false,
      continuationAvailable: false,
      requestedLimitReached: conversations.length >= input.limit,
      warnings: Object.freeze([
        "beeper-cli-v0.6.2-search-results-are-fuzzy-candidates",
        "beeper-cli-v0.6.2-chat-search-result-window-has-no-continuation",
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

function operationInputRecord(input: BeeperOperationInput): JsonRecord {
  return input as unknown as JsonRecord;
}

function requireBoundAccount(
  accounts: readonly BeeperAccountProjection[],
  id: string,
  operation: string,
): BeeperAccountProjection {
  const account = accounts.find((candidate) => candidate.accountId === id);
  if (account === undefined) throw new Error(`${operation} requested an account outside the bound Beeper realm`);
  return account;
}

function exactConversation(
  raw: unknown,
  accounts: readonly BeeperAccountProjection[],
  accountId: string,
  conversationId: string,
  label: string,
): BeeperConversationProjection {
  requireBoundAccount(accounts, accountId, label);
  const source = strictRecord(raw, label);
  if (Object.hasOwn(source, "preview")) {
    throw new Error(`${label} returned a list-only preview field in an exact chat response`);
  }
  const actualId = boundedString(source.id, `${label}.id`, 2_048);
  if (actualId !== conversationId) throw new Error(`${label}.id did not match the exact requested chat`);
  return parseConversation(raw, label, new Set(accounts.map((account) => account.accountId)), accountId);
}

function bridgeProjection(
  raw: unknown,
  accounts: readonly BeeperAccountProjection[],
  label: string,
  expectedId: string | null,
) {
  const source = strictRecord(raw, label);
  exactKeys(source, [
    "id", "accounts", "activeAccountCount", "displayName", "provider",
    "status", "supportsMultipleAccounts", "type",
  ], ["network", "statusText", "loginFlows", "capabilities"], label);
  const id = boundedString(source.id, `${label}.id`, 512);
  if (expectedId !== null && id !== expectedId) {
    throw new Error(`${label}.id did not match the exact requested bridge`);
  }
  const provider = boundedString(source.provider, `${label}.provider`, 32);
  if (!["cloud", "self-hosted", "local", "platform-sdk"].includes(provider)) {
    throw new Error(`${label}.provider is unsupported`);
  }
  const status = boundedString(source.status, `${label}.status`, 64);
  if (!["available", "connected", "limit_reached", "temporarily_unavailable", "disabled"].includes(status)) {
    throw new Error(`${label}.status is unsupported`);
  }
  const connected = strictArray(source.accounts, `${label}.accounts`, MAX_ACCOUNTS)
    .map((item, index) => parseAccount(item, `${label}.accounts[${index}]`));
  const realm = new Set(accounts.map((account) => account.accountId));
  if (connected.some((account) => !realm.has(account.accountId))) {
    throw new Error(`${label}.accounts escaped the bound account realm`);
  }
  let loginFlows: readonly Readonly<{ id: string; name: string | null; description: string | null }>[] = [];
  if (source.loginFlows !== undefined) {
    loginFlows = Object.freeze(strictArray(source.loginFlows, `${label}.loginFlows`, 64).map((item, index) => {
      const flow = strictRecord(item, `${label}.loginFlows[${index}]`);
      exactKeys(flow, ["id"], ["name", "description"], `${label}.loginFlows[${index}]`);
      return Object.freeze({
        id: boundedString(flow.id, `${label}.loginFlows[${index}].id`, 512),
        name: nullableString(flow.name, `${label}.loginFlows[${index}].name`, 2_048),
        description: nullableString(flow.description, `${label}.loginFlows[${index}].description`, 8_192, true),
      });
    }));
  }
  // Capabilities are provider-keyed and version-extensible. Keep them out of
  // output, but require one bounded plain JSON tree rather than trusting them.
  if (source.capabilities !== undefined) {
    boundedPlainJson(source.capabilities, `${label}.capabilities`, 0);
  }
  return Object.freeze({
    id,
    activeAccountCount: integer(source.activeAccountCount, `${label}.activeAccountCount`, 0, MAX_ACCOUNTS),
    displayName: boundedString(source.displayName, `${label}.displayName`, 2_048),
    provider,
    status,
    supportsMultipleAccounts: requiredBoolean(source.supportsMultipleAccounts, `${label}.supportsMultipleAccounts`),
    type: boundedString(source.type, `${label}.type`, 512),
    network: nullableString(source.network, `${label}.network`, 512),
    statusText: nullableString(source.statusText, `${label}.statusText`, 8_192, true),
    accounts: publicAccountProjections(connected),
    loginFlows,
  });
}

function boundedPlainJson(value: unknown, label: string, depth: number): void {
  if (depth > 8) throw new Error(`${label} exceeds its nesting bound`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    boundedString(value, label, 65_536, true, true);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value) || nodeTypes.isProxy(value)) {
    const items = strictArray(value, label, 2_000);
    items.forEach((item, index) => boundedPlainJson(item, `${label}[${index}]`, depth + 1));
    return;
  }
  const source = strictRecord(value, label);
  if (Object.keys(source).length > 2_000) throw new Error(`${label} contains too many fields`);
  for (const [key, item] of Object.entries(source)) {
    boundedString(key, `${label} key`, 512);
    boundedPlainJson(item, `${label}.${key}`, depth + 1);
  }
}

function exactMessage(
  raw: unknown,
  accountId: string,
  conversationId: string,
  messageIdValue: string,
  label: string,
): BeeperMessageProjection {
  const message = parseMessage(raw, label, {
    accountId,
    conversationId,
    beforeCursor: null,
    afterCursor: null,
    limit: 1,
  });
  if (message.id !== messageIdValue) throw new Error(`${label}.id did not match the exact requested message`);
  return message;
}

function contactReadOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: JsonRecord,
  raw: unknown,
) {
  const accountId = input.accountId as string;
  const contactId = input.contactId as string;
  requireBoundAccount(accounts, accountId, "contacts.read");
  const source = strictRecord(raw, "Beeper contact");
  exactKeys(source, ["accountID", "contact"], [], "Beeper contact");
  if (source.accountID !== accountId) throw new Error("Beeper contact account did not match the exact request");
  const contact = parseUser(source.contact, "Beeper contact.contact");
  if (contact.id !== contactId) throw new Error("Beeper contact ID did not match the exact request");
  return Object.freeze({
    provider: "beeper",
    operation: "contacts.read",
    accountSubject: subject,
    accountId,
    contact,
  });
}

function exactConversationReadOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: JsonRecord,
  raw: unknown,
) {
  const conversation = exactConversation(
    raw,
    accounts,
    input.accountId as string,
    input.conversationId as string,
    "Beeper conversation",
  );
  return Object.freeze({
    provider: "beeper",
    operation: "conversations.read",
    accountSubject: subject,
    conversation,
  });
}

function messageSearchOutput(
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  input: JsonRecord,
  raw: unknown,
) {
  const realm = new Set(accounts.map((account) => account.accountId));
  const messages = strictArray(raw, "Beeper searched messages", MAX_MESSAGES).map((item, index) => {
    const source = strictRecord(item, `Beeper searched messages[${index}]`);
    const accountId = boundedString(source.accountID, `Beeper searched messages[${index}].accountID`, 512);
    const conversationId = boundedString(source.chatID, `Beeper searched messages[${index}].chatID`, 2_048);
    if (!realm.has(accountId)) throw new Error("Beeper searched message escaped the bound account realm");
    if (input.accountId !== null && accountId !== input.accountId) throw new Error("Beeper searched message escaped the requested account");
    if (input.conversationId !== null && conversationId !== input.conversationId) throw new Error("Beeper searched message escaped the requested conversation");
    return parseMessage(item, `Beeper searched messages[${index}]`, {
      accountId,
      conversationId,
      beforeCursor: null,
      afterCursor: null,
      limit: input.limit as number,
    });
  });
  if (messages.length > (input.limit as number)) throw new Error("Beeper message search exceeded its requested bound");
  return Object.freeze({
    provider: "beeper",
    operation: "messaging.content.search",
    accountSubject: subject,
    messages: Object.freeze(messages),
    completeness: Object.freeze({
      resultWindowComplete: false,
      continuationAvailable: false,
      requestedLimitReached: messages.length >= (input.limit as number),
    }),
  });
}

async function executeRead(
  action: BeeperLocalOperationName,
  input: BeeperOperationInput,
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  raw: unknown,
): Promise<unknown> {
  const value = operationInputRecord(input);
  if (action === "accounts.list") {
    const parsed = parseAccounts(raw);
    if (beeperSubjectFromAccounts(parsed) !== beeperSubjectFromAccounts(accounts)) {
      throw new Error("Beeper account list changed the bound account realm");
    }
    return Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, accounts: publicAccountProjections(parsed) });
  }
  if (action === "accounts.read") {
    const account = parseAccount(raw, "Beeper account");
    if (account.accountId !== value.accountId) throw new Error("Beeper account ID did not match the exact request");
    requireBoundAccount(accounts, account.accountId, action);
    return Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, account: publicAccountProjection(account) });
  }
  if (action === "bridges.list") {
    const providerBridges = strictArray(raw, "Beeper bridges", 128).map((item, index) =>
      bridgeProjection(item, accounts, `Beeper bridges[${index}]`, null));
    if (providerBridges.some((bridge) =>
      (value.provider !== null && bridge.provider !== value.provider)
      || (value.available !== null
        && (bridge.status === "available") !== value.available))) {
      throw new Error("Beeper bridge output did not satisfy the exact requested filters");
    }
    const ids = providerBridges.map((bridge) => bridge.id);
    if (new Set(ids).size !== ids.length) throw new Error("Beeper bridges repeat an exact bridge ID");
    const limit = value.limit as number;
    const bridges = providerBridges.slice(0, limit);
    return Object.freeze({
      provider: "beeper",
      operation: action,
      accountSubject: subject,
      bridges: Object.freeze(bridges),
      completeness: Object.freeze({
        providerCatalogComplete: true,
        projectedCatalogComplete: providerBridges.length <= limit,
        requestedLimitReached: providerBridges.length >= limit,
        truncated: providerBridges.length > limit,
      }),
    });
  }
  if (action === "bridges.read") {
    return Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, bridge: bridgeProjection(raw, accounts, "Beeper bridge", value.bridgeId as string) });
  }
  if (action === "contacts.list") return contactOutput(accounts, subject, input as BeeperContactsListInput, raw);
  if (action === "contacts.search") return contactSearchOutput(accounts, subject, input as BeeperContactsSearchInput, raw);
  if (action === "contacts.read") return contactReadOutput(accounts, subject, value, raw);
  if (action === "messaging.list") return conversationOutput(accounts, subject, input as BeeperMessagingListInput, raw);
  if (action === "messaging.search") return messagingSearchOutput(accounts, subject, input as BeeperMessagingSearchInput, raw);
  if (action === "conversations.read") return exactConversationReadOutput(accounts, subject, value, raw);
  if (action === "messaging.read") return messageOutput(accounts, subject, input as BeeperMessagingReadInput, raw);
  if (action === "messaging.content.search") return messageSearchOutput(accounts, subject, value, raw);
  if (action === "messaging.message.read") {
    const message = exactMessage(raw, value.accountId as string, value.conversationId as string, value.messageId as string, "Beeper message");
    return Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, message });
  }
  const source = strictRecord(raw, "Beeper message context");
  exactKeys(source, ["chatID", "messageID", "before", "after"], [], "Beeper message context");
  if (source.chatID !== value.conversationId || source.messageID !== value.messageId) throw new Error("Beeper message context did not bind the exact target");
  const before = strictArray(source.before, "Beeper message context.before", 100).map((item, index) =>
    parseMessage(item, `Beeper message context.before[${index}]`, {
      accountId: value.accountId as string,
      conversationId: value.conversationId as string,
      beforeCursor: null,
      afterCursor: null,
      limit: value.before as number,
    }));
  const after = strictArray(source.after, "Beeper message context.after", 100).map((item, index) =>
    parseMessage(item, `Beeper message context.after[${index}]`, {
      accountId: value.accountId as string,
      conversationId: value.conversationId as string,
      beforeCursor: null,
      afterCursor: null,
      limit: value.after as number,
    }));
  if (before.length > (value.before as number) || after.length > (value.after as number)) throw new Error("Beeper message context exceeded its requested bounds");
  return Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, accountId: value.accountId, conversationId: value.conversationId, messageId: value.messageId, before: Object.freeze(before), after: Object.freeze(after) });
}

type BeeperPlanBoundFileExpectation = Readonly<{
  bytes: number;
  sha256: string;
}>;

async function copyVerifiedPlanBoundFile(
  sourcePath: string,
  operationRoot: string,
  expected: BeeperPlanBoundFileExpectation,
  afterSourceOpened?: () => Promise<void>,
  checkDeadline?: () => void,
): Promise<string> {
  if (!isAbsolute(sourcePath) || !isAbsolute(operationRoot)) {
    throw new Error("Beeper plan-bound file paths must be absolute");
  }
  const extension = extname(sourcePath).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : ".bin";
  const destinationDirectory = join(operationRoot, "plan-files");
  const destinationPath = join(destinationDirectory, `attachment${safeExtension}`);
  await mkdir(destinationDirectory, { mode: 0o700 });
  await chmod(destinationDirectory, 0o700);
  let source;
  let destination;
  let completed = false;
  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await source.stat();
    const pathBefore = await lstat(sourcePath);
    if (
      !before.isFile()
      || pathBefore.isSymbolicLink()
      || pathBefore.dev !== before.dev
      || pathBefore.ino !== before.ino
      || before.size !== expected.bytes
      || before.size < 1
      || before.size > BEEPER_MAX_FILE_BYTES
    ) throw new Error("Beeper plan-bound file did not match its confirmed identity and size");
    await afterSourceOpened?.();
    destination = await open(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total < before.size) {
      checkDeadline?.();
      const read = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - total),
        total,
      );
      if (read.bytesRead === 0) throw new Error("Beeper plan-bound file changed while copied");
      hash.update(buffer.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          read.bytesRead - written,
          total + written,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Beeper private plan-bound snapshot stopped accepting bytes");
        }
        written += result.bytesWritten;
      }
      total += read.bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const extra = await source.read(overflow, 0, 1, total);
    const after = await source.stat();
    const pathAfter = await lstat(sourcePath);
    if (
      extra.bytesRead !== 0
      || total !== expected.bytes
      || hash.digest("hex") !== expected.sha256
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
    ) throw new Error("Beeper plan-bound file changed while its private snapshot was created");
    await destination.sync();
    await destination.chmod(0o400);
    const copied = await destination.stat();
    if (!copied.isFile() || copied.size !== expected.bytes || (copied.mode & 0o777) !== 0o400) {
      throw new Error("Beeper private plan-bound snapshot failed its final bounds");
    }
    completed = true;
    return destinationPath;
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
    if (!completed) await unlink(destinationPath).catch(() => undefined);
  }
}

/** @internal Exported only for immutable plan-file snapshot regression tests. */
export async function materializeBeeperPlanBoundFileForTest(
  sourcePath: string,
  operationRoot: string,
  expected: BeeperPlanBoundFileExpectation,
  afterSourceOpened?: () => Promise<void>,
): Promise<string> {
  return copyVerifiedPlanBoundFile(
    sourcePath,
    operationRoot,
    expected,
    afterSourceOpened,
  );
}

async function resolvePlanBoundFile(
  input: BeeperOperationInput,
  options: LocalCliExecutionOptions,
  operationRoot: string,
): Promise<string | undefined> {
  const value = operationInputRecord(input);
  const descriptor = value.file ?? value.attachment;
  if (descriptor === undefined || descriptor === null) return undefined;
  if (options.fileResolver === undefined) throw new Error("Beeper file operation requires the plan-bound file resolver");
  const resolve = () => options.fileResolver!([descriptor as import("../model").FileInputValue]);
  const paths = options.operationDeadline === undefined
    ? await resolve()
    : await options.operationDeadline.run(resolve, OPERATION_LABEL);
  if (paths.length !== 1 || typeof paths[0] !== "string" || !isAbsolute(paths[0])) {
    throw new Error("Beeper file resolver did not return exactly one absolute file");
  }
  const summary = summarizePlanFile(
    descriptor as import("../model").FileInputValue,
  );
  return copyVerifiedPlanBoundFile(
    paths[0],
    operationRoot,
    Object.freeze({ bytes: summary.bytes, sha256: summary.sha256 }),
    undefined,
    () => options.operationDeadline?.throwIfUnavailable(OPERATION_LABEL),
  );
}

function desiredChatState(
  action: BeeperLocalOperationName,
  input: JsonRecord,
  chat: BeeperConversationProjection,
): boolean | null {
  if (action === "conversations.archive.set") return (chat.isArchived ?? false) === input.enabled;
  if (action === "conversations.pin.set") return (chat.isPinned ?? false) === input.enabled;
  if (action === "conversations.mute.set") return (chat.isMuted ?? false) === input.enabled;
  if (action === "conversations.priority.set") {
    return input.level === "low"
      ? (chat.isLowPriority ?? false) === true
      : (chat.isLowPriority ?? false) === false && (chat.isArchived ?? false) === false;
  }
  if (action === "conversations.title.set") return chat.title === input.value;
  if (action === "conversations.description.set") {
    return chat.descriptionObserved && chat.description === input.value;
  }
  if (action === "conversations.disappearing.set") {
    return chat.messageExpiryObserved
      && (chat.messageExpirySeconds ?? 0) === input.seconds;
  }
  if (action === "conversations.read-state.set") {
    if (input.messageId !== null) return false;
    return input.unread === true
      ? chat.isMarkedUnread === true
      : chat.unreadCount === 0 && chat.isMarkedUnread !== true;
  }
  if (action === "conversations.avatar.set") {
    if (input.file !== null) return false;
    return chat.avatarObserved && chat.hasAvatar === (input.file !== null);
  }
  if (action === "conversations.draft.set") {
    if (!chat.draftObserved) return false;
    if (input.clear === true) return chat.draft === null;
    if (input.file !== null) return false;
    if (chat.draft === null || chat.draft.text !== input.text) return false;
    if (input.file === null) return chat.draft.attachments.length === 0;
    if (chat.draft.attachments.length !== 1) return false;
    const attachment = chat.draft.attachments[0]!;
    return (input.filename === null || attachment.fileName === input.filename)
      && (input.mimeType === null || attachment.mimeType === input.mimeType);
  }
  if (action === "conversations.reminder.set") {
    if (!chat.reminderObserved) return false;
    const reminder = chat.reminder;
    return input.when === null
      ? reminder === null
      : reminder !== null
        && reminder.when === input.when
        && (reminder.dismissOnMessage ?? false) === input.dismissOnMessage;
  }
  return null;
}

/** @internal Exported only for pinned desired-state regression tests. */
export function beeperDesiredChatStateForTest(
  action: BeeperLocalOperationName,
  input: Readonly<Record<string, unknown>>,
  chat: BeeperConversationProjection,
): boolean | null {
  return desiredChatState(action, input, chat);
}

function dispatchEvent(
  id: string,
  index: number,
  planned: number,
  started: number,
  verified: number,
) {
  return Object.freeze({ id, index, progress: Object.freeze({ planned, started, verified }) });
}

function parseSendAcceptance(raw: unknown, input: JsonRecord) {
  const source = strictRecord(raw, "Beeper message acceptance");
  exactKeys(source, ["accepted", "state", "chatID", "pendingMessageID", "hint"], [], "Beeper message acceptance");
  if (
    source.accepted !== true
    || source.state !== "accepted"
    || source.chatID !== input.conversationId
    || source.hint !== "Desktop accepted the send request. Pass --wait to wait for the final message or failure."
  ) {
    throw new Error("Beeper message send did not return an exact acceptance");
  }
  return Object.freeze({
    accepted: true as const,
    state: "accepted" as const,
    accountId: input.accountId as string,
    conversationId: input.conversationId as string,
    pendingMessageId: boundedString(source.pendingMessageID, "Beeper message acceptance.pendingMessageID", 2_048),
  });
}

function parseReactionAck(raw: unknown, input: JsonRecord): void {
  const source = strictRecord(raw, "Beeper reaction acknowledgement");
  exactKeys(
    source,
    input.enabled === true
      ? ["chatID", "messageID", "reactionKey", "success", "transactionID"]
      : ["chatID", "messageID", "reactionKey", "success"],
    [],
    "Beeper reaction acknowledgement",
  );
  if (source.chatID !== input.conversationId || source.messageID !== input.messageId || source.reactionKey !== input.reaction || source.success !== true) {
    throw new Error("Beeper reaction acknowledgement did not bind the exact request");
  }
  if (input.enabled === true) {
    boundedString(
      source.transactionID,
      "Beeper reaction acknowledgement.transactionID",
      2_048,
    );
  }
}

async function delayPresence(seconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw new Error("Beeper presence sequence was cancelled");
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, seconds * 1_000);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Beeper presence sequence was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function executeMutation(
  action: BeeperLocalOperationName,
  input: BeeperOperationInput,
  accounts: readonly BeeperAccountProjection[],
  subject: string,
  recipe: LocalCliRecipe,
  options: LocalCliExecutionOptions,
  operationRoot: string,
  run: (
    command: BeeperCommand,
    maximum?: number,
    beforeSpawn?: () => Promise<void>,
  ) => Promise<unknown>,
): Promise<LocalCliExecution> {
  const value = operationInputRecord(input);
  const accountId = value.accountId as string;
  requireBoundAccount(accounts, accountId, action);
  let preflightChat: BeeperConversationProjection | null = null;
  let preflightTargetMessage: BeeperMessageProjection | null = null;
  if (typeof value.conversationId === "string") {
    const preflightInput = parseBeeperOperationInput("conversations.read", {
      account_id: accountId,
      conversation_id: value.conversationId,
      max_participants: 500,
    });
    const raw = await run(planBeeperReadCommand("conversations.read", preflightInput, recipe.timeoutMs));
    preflightChat = exactConversation(raw, accounts, accountId, value.conversationId, "Beeper mutation preflight chat");
    if (
      preflightChat.isReadOnly === true
      && [
        "messaging.send",
        "messaging.edit",
        "reactions.set",
        "presence.set",
        "conversations.notify",
      ].includes(action)
    ) {
      throw new Error("Beeper cannot dispatch this messaging action to an exact read-only chat");
    }
    if (
      action === "conversations.notify"
      && requireBoundAccount(accounts, accountId, action).bridge.type !== "imessage"
    ) {
      throw new Error("Beeper Notify Anyway is restricted to an exact iMessage conversation");
    }
    if (
      [
        "conversations.title.set",
        "conversations.description.set",
        "conversations.avatar.set",
      ].includes(action)
      && preflightChat.type !== "group"
    ) throw new Error("Beeper conversation profile mutations require an exact group chat");
    if (Array.isArray(value.mentions)) {
      const participants = new Set(preflightChat.participants.items.map((participant) => participant.id));
      if (value.mentions.some((mention) => !participants.has(mention))) throw new Error("Beeper message mention was not an exact chat participant");
    }
  }
  const secondaryMessageIds = [value.messageId, value.replyTo].filter((item): item is string => typeof item === "string");
  for (const targetMessageId of secondaryMessageIds) {
    const readInput = parseBeeperOperationInput("messaging.message.read", {
      account_id: accountId,
      conversation_id: value.conversationId as string,
      message_id: targetMessageId,
    });
    const raw = await run(planBeeperReadCommand("messaging.message.read", readInput, recipe.timeoutMs));
    const message = exactMessage(
      raw,
      accountId,
      value.conversationId as string,
      targetMessageId,
      "Beeper mutation preflight message",
    );
    if (action === "messaging.edit" && targetMessageId === value.messageId && !message.isSender) {
      throw new Error("Beeper only permits editing a message authored by the bound account");
    }
    if (targetMessageId === value.messageId) preflightTargetMessage = message;
  }
  if (action === "conversations.start") {
    const contactInput = parseBeeperOperationInput("contacts.read", {
      account_id: accountId,
      contact_id: value.userId as string,
    });
    const raw = await run(planBeeperReadCommand("contacts.read", contactInput, recipe.timeoutMs));
    const contactProjection = contactReadOutput(
      accounts,
      subject,
      operationInputRecord(contactInput),
      raw,
    );
    if (contactProjection.contact.cannotMessage === true) {
      throw new Error("Beeper cannot start a conversation with an exact non-messageable contact");
    }
  }
  if (
    action === "conversations.draft.set"
    && value.clear === false
    && preflightChat?.draft !== null
    && preflightChat?.draft !== undefined
    && (preflightChat.draft.text !== "" || preflightChat.draft.attachments.length > 0)
    && desiredChatState(action, value, preflightChat) !== true
  ) {
    throw new Error("Beeper requires an existing nonempty draft to be cleared in a separate confirmed operation");
  }
  if (
    preflightChat !== null
    && desiredChatState(action, value, preflightChat) === true
  ) {
    return Object.freeze({
      status: "succeeded",
      output: Object.freeze({ provider: "beeper", operation: action, effect: "already-satisfied" }),
      finalUrl: BEEPER_ORIGIN,
      noOp: true,
      dispatchStarted: false,
      dispatch: Object.freeze({ planned: 1, started: 0, verified: 0 }),
    });
  }
  if (action === "reactions.set" && preflightTargetMessage !== null) {
    const selfId = requireBoundAccount(accounts, accountId, action).user.id;
    const present = preflightTargetMessage.reactions.some(
      (reaction) => reaction.participantId === selfId && reaction.reactionKey === value.reaction,
    );
    if (present === value.enabled) {
      return Object.freeze({
        status: "succeeded",
        output: Object.freeze({ provider: "beeper", operation: action, effect: "already-satisfied" }),
        finalUrl: BEEPER_ORIGIN,
        noOp: true,
        dispatchStarted: false,
        dispatch: Object.freeze({ planned: 1, started: 0, verified: 0 }),
      });
    }
  }
  const resolvedFile = await resolvePlanBoundFile(input, options, operationRoot);
  const commands = action === "presence.set"
    ? planBeeperPresenceCommands(input, recipe.timeoutMs)
    : Object.freeze([planBeeperOperationCommand(action, input, recipe.timeoutMs, resolvedFile)]);
  const planned = commands.length;
  let started = 0;
  let verified = 0;
  let output: unknown = null;
  try {
    for (const [offset, plannedCommand] of commands.entries()) {
      const index = offset + 1;
      const id = planned === 1 ? action : `${action}[${index}]`;
      if (action === "presence.set" && index === 2) {
        await delayPresence(value.durationSeconds as number, options.operationDeadline?.signal);
      }
      const raw = await run(plannedCommand, recipe.maxOutputBytes, async () => {
        await options.beforeDispatch?.(dispatchEvent(id, index, planned, started, verified));
        started = index;
      });
      if (started !== index) throw new Error("Beeper CLI runner omitted dispatch spawn accounting");
      if (action === "messaging.send") {
        const accepted = parseSendAcceptance(raw, value);
        output = Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, ...accepted });
        await options.afterProviderAcceptedMutationTarget?.({
          id,
          index,
          target: Object.freeze({
            schemaVersion: 1,
            identifier: canonicalJson({
              accountId: accepted.accountId,
              conversationId: accepted.conversationId,
              pendingMessageId: accepted.pendingMessageId,
            }),
          }),
        });
      } else if (action === "reactions.set") {
        parseReactionAck(raw, value);
        const readInput = parseBeeperOperationInput("messaging.message.read", {
          account_id: accountId,
          conversation_id: value.conversationId as string,
          message_id: value.messageId as string,
        });
        const readback = await run(planBeeperReadCommand("messaging.message.read", readInput, recipe.timeoutMs));
        const message = exactMessage(readback, accountId, value.conversationId as string, value.messageId as string, "Beeper reaction readback");
        const selfId = requireBoundAccount(accounts, accountId, action).user.id;
        const present = message.reactions.some((reaction) => reaction.participantId === selfId && reaction.reactionKey === value.reaction);
        if (present !== value.enabled) throw new Error("Beeper reaction desired state was not independently verified");
        output = Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, accountId, conversationId: value.conversationId, messageId: value.messageId, reaction: value.reaction, enabled: value.enabled });
      } else if (action === "messaging.edit") {
        const edit = strictRecord(raw, "Beeper edited message");
        exactKeys(edit, ["id", "accountID", "chatID", "senderID", "sortKey", "timestamp", "messageID", "success"], ["attachments", "editedTimestamp", "isDeleted", "isHidden", "isSender", "isUnread", "linkedMessageID", "links", "mentions", "reactions", "seen", "senderName", "sendStatus", "text", "type"], "Beeper edited message");
        if (
          edit.id !== value.messageId
          || edit.messageID !== value.messageId
          || edit.accountID !== accountId
          || edit.chatID !== value.conversationId
          || edit.success !== true
        ) throw new Error("Beeper edit acknowledgement did not bind the exact account, chat, and message");
        const readInput = parseBeeperOperationInput("messaging.message.read", { account_id: accountId, conversation_id: value.conversationId as string, message_id: value.messageId as string });
        const readback = await run(planBeeperReadCommand("messaging.message.read", readInput, recipe.timeoutMs));
        const message = exactMessage(readback, accountId, value.conversationId as string, value.messageId as string, "Beeper edit readback");
        if (!message.isSender || message.text !== value.text) throw new Error("Beeper edit was not independently verified");
        output = Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, message });
      } else if (action === "conversations.start") {
        const response = strictRecord(raw, "Beeper started conversation");
        exactKeys(response, ["id", "accountID", "network", "participants", "title", "type", "unreadCount", "chatID"], ["status", "capabilities", "description", "draft", "imgURL", "isArchived", "isLowPriority", "isMarkedUnread", "isMuted", "isPinned", "isReadOnly", "lastActivity", "lastReadMessageSortKey", "localChatID", "messageExpirySeconds", "reminder", "snooze", "unreadMentionsCount"], "Beeper started conversation");
        if (response.chatID !== response.id || ![undefined, "existing", "created"].includes(response.status as string | undefined)) throw new Error("Beeper started conversation returned inconsistent identity");
        const base = Object.freeze(Object.fromEntries(Object.entries(response).filter(([key]) => key !== "chatID" && key !== "status")));
        const conversation = parseConversation(base, "Beeper started conversation", new Set(accounts.map((account) => account.accountId)), accountId);
        if (!conversation.participants.items.some((participant) => participant.id === value.userId)) throw new Error("Beeper started conversation did not include the exact requested user");
        await options.afterProviderAcceptedMutationTarget?.({
          id,
          index,
          target: Object.freeze({
            schemaVersion: 1,
            identifier: canonicalJson({
              accountId,
              conversationId: conversation.id,
            }),
          }),
        });
        output = Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, conversation });
      } else if (action === "conversations.reminder.set") {
        const ack = strictRecord(raw, "Beeper reminder acknowledgement");
        exactKeys(ack, ["message", "chatID"], value.when === null ? [] : ["detail", "remindAt"], "Beeper reminder acknowledgement");
        if (
          ack.chatID !== value.conversationId
          || ack.message !== (value.when === null ? "Reminder cleared" : "Reminder set")
          || (
            value.when !== null
            && (ack.detail !== value.when || ack.remindAt !== value.when)
          )
        ) throw new Error("Beeper reminder acknowledgement did not bind the exact request");
      } else if (action === "conversations.focus") {
        const ack = strictRecord(raw, "Beeper focus acknowledgement");
        exactKeys(ack, ["success"], [], "Beeper focus acknowledgement");
        if (ack.success !== true) throw new Error("Beeper Desktop did not acknowledge focus");
        output = Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, accountId, conversationId: value.conversationId, focused: true });
      } else if (action === "presence.set") {
        const ack = strictRecord(raw, "Beeper presence acknowledgement");
        exactKeys(ack, ["message", "chatID", "state"], [], "Beeper presence acknowledgement");
        const expectedState = index === 2 ? "paused" : value.state;
        if (
          ack.chatID !== value.conversationId
          || ack.state !== expectedState
          || ack.message !== `Sent ${String(expectedState)} indicator`
        ) throw new Error("Beeper presence acknowledgement did not bind the exact request");
        output = Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, accountId, conversationId: value.conversationId, state: ack.state });
      } else {
        const acknowledgement = exactConversation(raw, accounts, accountId, value.conversationId as string, "Beeper mutation acknowledgement chat");
        if (
          action === "conversations.avatar.set"
          && value.file !== null
          && (!acknowledgement.avatarObserved || !acknowledgement.hasAvatar)
        ) throw new Error("Beeper avatar response did not acknowledge an applied avatar");
        if (action === "conversations.draft.set" && value.file !== null) {
          const draft = acknowledgement.draft;
          if (
            !acknowledgement.draftObserved
            || draft === null
            || draft.text !== value.text
            || draft.attachments.length < 1
          ) throw new Error("Beeper draft response did not acknowledge the requested attachment draft");
        }
        output = Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, conversation: acknowledgement });
      }
      if (
        typeof value.conversationId === "string"
        && !["messaging.send", "messaging.edit", "reactions.set", "conversations.focus", "presence.set", "conversations.notify"].includes(action)
        && !(action === "conversations.avatar.set" && value.file !== null)
        && !(action === "conversations.draft.set" && value.file !== null)
        && !(action === "conversations.read-state.set" && value.messageId !== null)
      ) {
        const readInput = parseBeeperOperationInput("conversations.read", { account_id: accountId, conversation_id: value.conversationId, max_participants: 500 });
        const readbackRaw = await run(planBeeperReadCommand("conversations.read", readInput, recipe.timeoutMs));
        const readback = exactConversation(readbackRaw, accounts, accountId, value.conversationId, "Beeper mutation readback chat");
        const satisfied = desiredChatState(action, value, readback);
        if (satisfied !== true) {
          throw new Error("Beeper conversation desired state was not independently verified");
        }
        output = Object.freeze({ provider: "beeper", operation: action, accountSubject: subject, conversation: readback });
      }
      const nextVerified = index;
      await options.afterDispatchVerified?.(
        dispatchEvent(id, index, planned, started, nextVerified),
      );
      verified = nextVerified;
    }
    return Object.freeze({
      status: "succeeded",
      output,
      finalUrl: BEEPER_ORIGIN,
      dispatchStarted: started > 0,
      dispatch: Object.freeze({ planned, started, verified }),
    });
  } catch {
    const exactPartial = verified > 0 && started === verified && verified < planned;
    return Object.freeze({
      status: exactPartial ? "partial" : started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: BEEPER_ORIGIN,
      dispatchStarted: started > 0,
      dispatch: Object.freeze({ planned, started, verified }),
      error: exactPartial
        ? "Beeper completed and durably verified only the reported prefix of the confirmed dispatch schedule"
        : started > 0
        ? "Beeper may have changed the requested state but exact evidence was not durably verified; reconcile before retrying"
        : "Beeper local CLI operation failed before dispatch",
    });
  }
}

export async function executeBeeperLocalOperation(
  recipe: LocalCliRecipe,
  inputValue: OperationInput,
  authValue: WrenchAuth,
  options: LocalCliExecutionOptions & Readonly<{
    dependencies?: BeeperLocalRuntimeDependencies;
  }> = {},
): Promise<LocalCliExecution> {
  if (
    recipe.surface !== "beeper"
    || recipe.contractVersion !== 1
    || !isBeeperLocalOperation(recipe.action)
  ) throw new Error("Beeper local CLI recipe is not installed");
  const action: BeeperLocalOperationName = recipe.action;
  const contract = BEEPER_LOCAL_OPERATIONS[action];
  const input = parseBeeperOperationInput(action, inputValue);
  const auth = requireBeeperAuth(authValue);
  options.operationDeadline?.throwIfUnavailable(OPERATION_LABEL);
  try {
    return await startProviderPluginCleanupTrackedOperation(
      options.registerCleanupBarrier,
      async (publishCleanupResource, cleanup) => withRuntime(
      auth,
      recipe.timeoutMs,
      recipe.maxOutputBytes,
      options.dependencies,
      options.environment ?? process.env,
      options.operationDeadline,
      publishCleanupResource,
      cleanup,
      options.registerCleanupBarrier !== undefined,
      async ({ accounts, operationRoot, subject, run }) => {
        if (auth.subject === undefined) throw new Error("Beeper auth must be account-bound before private operations");
        const parsedInput = operationInputRecord(input);
        if (typeof parsedInput.accountId === "string") {
          requireBoundAccount(accounts, parsedInput.accountId, action);
        }
        if (contract.effect === "read") {
          if (action === "bridges.read") {
            const listInput = parseBeeperOperationInput("bridges.list", { limit: 128 });
            const candidates = strictArray(
              await run(planBeeperReadCommand("bridges.list", listInput, recipe.timeoutMs)),
              "Beeper bridge candidates",
              128,
            ).map((candidate, index) => bridgeProjection(
              candidate,
              accounts,
              `Beeper bridge candidates[${index}]`,
              null,
            ));
            if (!candidates.some((candidate) => candidate.id === parsedInput.bridgeId)) {
              throw new Error("Beeper bridge ID was not present in the exact bridge candidate set");
            }
          }
          const raw = await run(planBeeperReadCommand(action, input, recipe.timeoutMs));
          const output = await executeRead(action, input, accounts, subject, raw);
          if (Buffer.byteLength(JSON.stringify(output), "utf8") > recipe.maxOutputBytes) {
            throw new Error("Beeper local projection exceeded the reviewed output bound");
          }
          return Object.freeze({
            status: "succeeded" as const,
            output,
            finalUrl: BEEPER_ORIGIN,
            dispatchStarted: false,
            dispatch: Object.freeze({ planned: 0, started: 0, verified: 0 }),
          });
        }
        return executeMutation(
          action,
          input,
          accounts,
          subject,
          recipe,
          options,
          operationRoot,
          run,
        );
      },
      ),
    );
  } catch (error) {
    if (error instanceof BeeperLocalCleanupUnverifiedError) throw error;
    throw new Error("Beeper local CLI execution failed at a protected local boundary");
  }
}
