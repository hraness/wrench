import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { WrenchAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  BEEPER_MESSAGE_LIKE_ME_MAX_RECORDS,
  BEEPER_MESSAGE_LIKE_ME_MAX_TOTAL_BYTES,
} from "./beeper-message-like-me-export";
import type {
  BeeperMessageLikeMeAccount,
  BeeperMessageLikeMeAttachment,
  BeeperMessageLikeMeConversation,
  BeeperMessageLikeMeExportSource,
  BeeperMessageLikeMeMessage,
  BeeperMessageLikeMeParticipant,
  BeeperMessageLikeMeReaction,
  BeeperMessageLikeMeRecord,
  BeeperMessageLikeMeTombstone,
} from "./beeper-message-like-me-export";
import {
  BEEPER_CLI_PIN,
  planBeeperMessageLikeMeExportCommand,
} from "./providers/beeper-local";
import {
  beeperSubjectFromAccounts,
  parseBeeperExportAccounts,
  parseBeeperExportConversation,
  parseBeeperExportMessages,
  resolvePinnedBeeperCliBinary,
  validateBeeperCliStore,
  type BeeperAccountProjection,
  type BeeperAttachmentProjection,
  type BeeperCliInvocationResult,
  type BeeperConversationProjection,
  type BeeperMessageProjection,
  type BeeperReactionProjection,
  type BeeperUserProjection,
} from "./providers/beeper-local-runtime";

const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ACCOUNTS_JSON_BYTES = 32 * 1024 * 1024;
const MAX_CHATS_JSON_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGES_JSON_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_CHATS = 100_000;
const MAX_EXPORT_MESSAGES_PER_CHAT = 1_000_000;
const DEFAULT_MAX_PARTICIPANTS = 500;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

type JsonRecord = Readonly<Record<string, unknown>>;

export type BeeperMessageLikeMeSourceLimits = Readonly<{
  limitChats?: number;
  limitMessages?: number;
  maxParticipants?: number;
  timeoutMs?: number;
}>;

export type BeeperExportCliInvocation = Readonly<{
  binary: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}>;

export type BeeperMessageLikeMeSourceDependencies = Readonly<{
  /** Test-only seam. Production resolves the exact pinned binary hash. */
  binaryPath?: string;
  /** Test-only seam for exercising the fixed production bundle record cap. */
  maxBundleRecords?: number;
  /** Test-only seam for exercising the fixed production bundle byte cap. */
  maxBundleBytes?: number;
  /** Test-only seam for exercising the per-chat JSON allocation cap. */
  maxMessagesJsonBytes?: number;
  runExport?: (
    invocation: BeeperExportCliInvocation,
  ) => Promise<BeeperCliInvocationResult>;
  createWorkingDirectory?: () => Promise<string>;
  removeWorkingDirectory?: (path: string) => Promise<void>;
}>;

export type BeeperMessageLikeMeSourceRequest = Readonly<{
  auth: WrenchAuth;
  limits?: BeeperMessageLikeMeSourceLimits;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
  dependencies?: BeeperMessageLikeMeSourceDependencies;
}>;

type ParsedLimits = Readonly<{
  limitChats: number | null;
  limitMessages: number | null;
  maxParticipants: number;
  timeoutMs: number;
}>;

type ParticipantFact = {
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  displayName: string | null;
  handle: string | null;
  isSelf: boolean | null;
};

type ConversationScan = Readonly<{
  chat: BeeperConversationProjection;
  directory: string;
  messagesPath: string;
  participantIds: readonly string[];
  participantsComplete: boolean;
  startedAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  reactionCount: number;
  tombstoneCount: number;
  nonParticipantRecordBytes: number;
}>;

type ExportManifest = Readonly<{
  accounts: unknown;
  attachmentCount: number;
  chatCount: number;
  completedAt: string;
  createdAt: string;
  messageCount: number;
  version: 1;
}>;

function fail(message: string): never {
  throw new Error(`Beeper Message Like Me source: ${message}`);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return fail(`${label} must be a plain object`);
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const remaining = new Set(Object.keys(value));
  for (const key of required) {
    if (!remaining.delete(key)) fail(`${label} omitted a required field`);
  }
  for (const key of optional) remaining.delete(key);
  if (remaining.size > 0) fail(`${label} contains an unreviewed field`);
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return fail(`${label} must be an array inside its reviewed bound`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label} must not be sparse`);
  }
  return value;
}

function integer(value: unknown, label: string, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) return fail(`${label} must be a bounded non-negative integer`);
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const parsed = integer(value, label, maximum);
  if (parsed < 1) return fail(`${label} must be positive`);
  return parsed;
}

function string(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\0\r\n]/u.test(value)
  ) return fail(`${label} must be bounded text`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const source = string(value, label, 64);
  const milliseconds = Date.parse(source);
  if (!Number.isFinite(milliseconds)) return fail(`${label} must be a timestamp`);
  return new Date(milliseconds).toISOString();
}

function parseLimits(value: BeeperMessageLikeMeSourceLimits | undefined): ParsedLimits {
  return Object.freeze({
    limitChats: value?.limitChats === undefined
      ? null
      : positiveInteger(value.limitChats, "limitChats", MAX_EXPORT_CHATS),
    limitMessages: value?.limitMessages === undefined
      ? null
      : positiveInteger(
          value.limitMessages,
          "limitMessages",
          MAX_EXPORT_MESSAGES_PER_CHAT,
        ),
    maxParticipants: value?.maxParticipants === undefined
      ? DEFAULT_MAX_PARTICIPANTS
      : positiveInteger(value.maxParticipants, "maxParticipants", 2_000),
    timeoutMs: value?.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : positiveInteger(value.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS),
  });
}

function requireAuth(auth: WrenchAuth): Extract<WrenchAuth, {
  readonly kind: "linked-device-store";
}> {
  if (
    auth.kind !== "linked-device-store"
    || auth.provider !== "beeper"
    || auth.subject === undefined
    || !/^beeper:local:[a-f0-9]{64}$/u.test(auth.subject)
  ) return fail("export requires an account-bound Beeper linked-device-store auth locator");
  return auth;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("export was cancelled");
}

function digest(parts: readonly string[]): string {
  return sha256(canonicalJson(parts));
}

function bundleRecordBytes(record: BeeperMessageLikeMeRecord): number {
  return Buffer.byteLength(canonicalJson(record), "utf8") + 1;
}

function localId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${digest(parts)}`;
}

function providerId(kind: string, ...parts: readonly string[]): string {
  return `beeper-${kind}:${digest(parts)}`;
}

function normalizeNetwork(value: string | null, fallback: string): string {
  const normalized = (value ?? fallback)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "") || "unknown";
  if (Buffer.byteLength(normalized, "utf8") <= 64) return normalized;
  return `${normalized.slice(0, 47).replace(/[^a-z0-9]+$/u, "")}-${digest([normalized]).slice(0, 16)}`;
}

function preferredHandle(user: BeeperUserProjection): string | null {
  return user.phoneNumber ?? user.email ?? user.username;
}

function safeBaseName(value: string | null): string | null {
  if (value === null) return null;
  const name = basename(value.replaceAll("\\", "/"));
  if (name.length < 1 || name === "." || name === "..") return null;
  return name;
}

function attachment(
  value: BeeperAttachmentProjection,
): BeeperMessageLikeMeAttachment {
  const kind: BeeperMessageLikeMeAttachment["kind"] = value.isSticker === true
    ? "sticker"
    : value.type === "img"
      ? "image"
      : value.type === "video"
        ? "video"
        : value.type === "audio"
          ? "audio"
          : value.fileName !== null
            ? "document"
            : "unknown";
  return Object.freeze({
    kind,
    mimeType: value.mimeType,
    name: safeBaseName(value.fileName),
    sizeBytes: value.fileSizeBytes,
  });
}

function reactionBody(value: string): string {
  if (
    /[\\/]/u.test(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
    || Buffer.byteLength(value, "utf8") > 128
  ) return "custom-reaction";
  if (/^:[A-Za-z0-9_+-]{1,64}:$/u.test(value)) return value;
  if (/^[^\p{L}\p{N}]*\p{Extended_Pictographic}[^\p{L}\p{N}]*$/u.test(value)) {
    return value;
  }
  if (["+1", "-1", "like", "love", "laugh", "sad", "angry"].includes(value)) {
    return value;
  }
  return "custom-reaction";
}

function safeSegment(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9._-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.slice(0, 120) || "item";
}

async function assertOwnedDirectory(path: string, root?: string): Promise<string> {
  const canonical = await realpath(path);
  if (canonical !== path) return fail("export directory traversed a symbolic link");
  if (root !== undefined && canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
    return fail("export directory escaped private staging");
  }
  const metadata = await lstat(canonical);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o022) !== 0
  ) return fail("export directory is not an owned physical directory");
  return canonical;
}

async function assertPrivateOwnedDirectory(
  path: string,
  root?: string,
): Promise<string> {
  const canonical = await assertOwnedDirectory(path, root);
  const metadata = await lstat(canonical);
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    return fail("private export root permissions changed");
  }
  return canonical;
}

async function readOwnedJson(
  path: string,
  root: string,
  maximumBytes: number,
): Promise<unknown> {
  if (!path.startsWith(`${root}${sep}`)) return fail("export file escaped private staging");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return fail("official export omitted a required file");
    if (isErrno(error, "ELOOP")) return fail("official export file must not be a symbolic link");
    return fail("official export file could not be opened safely");
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.uid !== process.getuid?.()
      || before.nlink !== 1
      || (before.mode & 0o022) !== 0
      || before.size < 2
      || before.size > maximumBytes
    ) return fail("official export file is outside its ownership or size bound");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const overflow = await handle.read(extra, 0, 1, offset);
    const after = await handle.stat();
    if (
      offset !== bytes.byteLength
      || overflow.bytesRead !== 0
      || before.dev !== after.dev
      || before.ino !== after.ino
      || after.nlink !== 1
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) return fail("official export file changed while being read");
    const pathMetadata = await lstat(path);
    if (
      pathMetadata.isSymbolicLink()
      || pathMetadata.nlink !== 1
      || pathMetadata.dev !== after.dev
      || pathMetadata.ino !== after.ino
    ) return fail("official export file changed while being read");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      return fail("official export file is not valid UTF-8 JSON");
    }
  } finally {
    await handle.close();
  }
}

async function ownedFileSize(path: string, root: string): Promise<number> {
  if (!path.startsWith(`${root}${sep}`)) return fail("export file escaped private staging");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return fail("official export omitted a required file");
    if (isErrno(error, "ELOOP")) return fail("official export file must not be a symbolic link");
    return fail("official export file could not be opened safely");
  }
  try {
    const metadata = await handle.stat();
    const pathMetadata = await lstat(path);
    if (
      !metadata.isFile()
      || metadata.uid !== process.getuid?.()
      || metadata.nlink !== 1
      || (metadata.mode & 0o022) !== 0
      || metadata.size < 2
      || pathMetadata.isSymbolicLink()
      || pathMetadata.dev !== metadata.dev
      || pathMetadata.ino !== metadata.ino
      || pathMetadata.nlink !== 1
    ) return fail("official export file is outside its ownership or size bound");
    return metadata.size;
  } finally {
    await handle.close();
  }
}

function parseManifest(value: unknown): ExportManifest {
  const source = record(value, "official export manifest");
  exactKeys(source, [
    "accounts",
    "attachmentCount",
    "chatCount",
    "completedAt",
    "createdAt",
    "messageCount",
    "version",
  ], [], "official export manifest");
  if (source.version !== 1) return fail("official export manifest version is unsupported");
  return Object.freeze({
    accounts: source.accounts,
    attachmentCount: integer(
      source.attachmentCount,
      "official export manifest attachmentCount",
      Number.MAX_SAFE_INTEGER,
    ),
    chatCount: integer(
      source.chatCount,
      "official export manifest chatCount",
      MAX_EXPORT_CHATS,
    ),
    completedAt: timestamp(source.completedAt, "official export manifest completedAt"),
    createdAt: timestamp(source.createdAt, "official export manifest createdAt"),
    messageCount: integer(
      source.messageCount,
      "official export manifest messageCount",
      Number.MAX_SAFE_INTEGER,
    ),
    version: 1,
  });
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (item.value.byteLength > maximum - size) return fail(`${label} exceeded its byte bound`);
      chunks.push(item.value.slice());
      size += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

async function runExportCli(
  invocation: BeeperExportCliInvocation,
): Promise<BeeperCliInvocationResult> {
  throwIfAborted(invocation.signal);
  const child = Bun.spawn([
    "/bin/sh",
    "-c",
    "umask 077\nexec \"$@\"",
    "wrench-beeper-export",
    invocation.binary,
    ...invocation.arguments,
  ], {
    env: { ...invocation.environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  let cancelled = false;
  let forceKill: ReturnType<typeof setTimeout> | null = null;
  const signalGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The complete child process group already exited.
    }
  };
  const terminate = (): void => {
    signalGroup("SIGTERM");
    if (forceKill === null) {
      forceKill = setTimeout(() => signalGroup("SIGKILL"), 2_000);
    }
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
      readBoundedStream(child.stdout, invocation.maxOutputBytes, "Beeper export stdout"),
      readBoundedStream(child.stderr, invocation.maxStderrBytes, "Beeper export stderr"),
    ]);
    if (cancelled) return fail("official export was cancelled");
    if (timedOut) return fail("official export timed out");
    return Object.freeze({ exitCode, stdout, stderr });
  } catch (error) {
    signalGroup("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (forceKill !== null) clearTimeout(forceKill);
    invocation.signal?.removeEventListener("abort", onAbort);
  }
}

function environmentForExport(
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

function upsertParticipant(
  facts: Map<string, ParticipantFact>,
  account: BeeperAccountProjection,
  user: Pick<BeeperUserProjection, "id" | "fullName" | "phoneNumber" | "email" | "username">,
  self: boolean | null,
  createdIds?: Set<string>,
): ParticipantFact {
  const id = localId("participant", account.accountId, user.id);
  const current = facts.get(id);
  const handle = user.phoneNumber ?? user.email ?? user.username;
  if (current !== undefined) {
    if (self !== null && current.isSelf !== null && current.isSelf !== self) {
      return fail("one Beeper participant has conflicting self-direction evidence");
    }
    current.displayName ??= user.fullName;
    current.handle ??= handle;
    current.isSelf ??= self;
    return current;
  }
  const created: ParticipantFact = {
    id,
    accountId: localId("account", account.accountId),
    providerId: providerId("participant", account.accountId, user.id),
    displayName: user.fullName,
    handle,
    isSelf: self,
  };
  facts.set(id, created);
  createdIds?.add(id);
  return created;
}

function messageTimestampRange(
  messages: readonly BeeperMessageProjection[],
): { readonly first: string | null; readonly last: string | null } {
  let first: string | null = null;
  let last: string | null = null;
  for (const message of messages) {
    if (first === null || message.timestamp < first) first = message.timestamp;
    if (last === null || message.timestamp > last) last = message.timestamp;
  }
  return Object.freeze({ first, last });
}

function parseOfficialState(
  value: unknown,
  chatIds: readonly string[],
  createdAt: string,
): ReadonlyMap<string, number> {
  const source = record(value, "official export state");
  exactKeys(source, [
    "chats",
    "completedChatIDs",
    "createdAt",
    "exportVersion",
  ], [], "official export state");
  if (source.exportVersion !== 1 || timestamp(source.createdAt, "official export state createdAt") !== createdAt) {
    fail("official export state does not match the completed manifest");
  }
  const completed = array(
    source.completedChatIDs,
    "official export completedChatIDs",
    MAX_EXPORT_CHATS,
  ).map((item) => string(item, "official export completed chat ID", 2_048));
  const completedSet = new Set(completed);
  if (completedSet.size !== completed.length || completedSet.size !== chatIds.length) {
    fail("official export completed chat inventory is inconsistent");
  }
  const states = record(source.chats, "official export chat states");
  if (Object.keys(states).length !== chatIds.length) {
    fail("official export chat state inventory is inconsistent");
  }
  const messageCounts = new Map<string, number>();
  for (const chatId of chatIds) {
    if (!completedSet.has(chatId)) {
      fail("official export omitted a completed chat marker");
    }
    const state = record(states[chatId], "official export chat state");
    exactKeys(state, [
      "attachmentCount",
      "complete",
      "cursor",
      "messageCount",
      "startedAt",
      "updatedAt",
    ], [], "official export chat state");
    if (
      state.complete !== true
      || state.cursor !== null
      || integer(state.attachmentCount, "official export chat attachmentCount", Number.MAX_SAFE_INTEGER) !== 0
    ) fail("official export chat did not complete without attachments");
    const messageCount = integer(
      state.messageCount,
      "official export chat messageCount",
      MAX_EXPORT_MESSAGES_PER_CHAT,
    );
    timestamp(state.startedAt, "official export chat startedAt");
    timestamp(state.updatedAt, "official export chat updatedAt");
    messageCounts.set(chatId, messageCount);
  }
  return messageCounts;
}

function accountRecord(
  account: BeeperAccountProjection,
  network: string,
  observedAt: string,
  selfParticipantId: string,
): BeeperMessageLikeMeAccount {
  const id = localId("account", account.accountId);
  const connectedAccountProviderId = providerId("account", account.accountId);
  return Object.freeze({
    schemaVersion: 1,
    kind: "account",
    id,
    accountId: id,
    network,
    provenance: Object.freeze({
      providerId: connectedAccountProviderId,
      providerRevision: null,
      observedAt,
      connectedAccountProviderId,
    }),
    displayName: account.user.fullName ?? account.network,
    handle: preferredHandle(account.user),
    selfParticipantId,
  });
}

function participantRecord(
  fact: ParticipantFact,
  account: BeeperAccountProjection,
  network: string,
  observedAt: string,
): BeeperMessageLikeMeParticipant {
  return Object.freeze({
    schemaVersion: 1,
    kind: "participant",
    id: fact.id,
    accountId: fact.accountId,
    network,
    provenance: Object.freeze({
      providerId: fact.providerId,
      providerRevision: null,
      observedAt,
      connectedAccountProviderId: providerId("account", account.accountId),
    }),
    displayName: fact.displayName,
    handle: fact.handle,
    isSelf: fact.isSelf === true,
  });
}

function conversationRecord(
  scan: ConversationScan,
  account: BeeperAccountProjection,
  network: string,
  observedAt: string,
): BeeperMessageLikeMeConversation {
  const id = localId("conversation", account.accountId, scan.chat.id);
  return Object.freeze({
    schemaVersion: 1,
    kind: "conversation",
    id,
    accountId: localId("account", account.accountId),
    network,
    provenance: Object.freeze({
      providerId: providerId("conversation", account.accountId, scan.chat.id),
      providerRevision: scan.chat.lastActivity,
      observedAt,
      connectedAccountProviderId: providerId("account", account.accountId),
    }),
    type: scan.chat.type === "single" ? "direct" : "group",
    title: scan.chat.title,
    participantIds: scan.participantIds,
    participantsComplete: scan.participantsComplete,
    startedAt: scan.startedAt,
    lastMessageAt: scan.lastMessageAt,
  });
}

function messageRecord(
  message: BeeperMessageProjection,
  scan: ConversationScan,
  messageIds: ReadonlySet<string>,
  account: BeeperAccountProjection,
  network: string,
  observedAt: string,
): BeeperMessageLikeMeMessage {
  const id = localId("message", account.accountId, scan.chat.id, message.id);
  const providerMessageId = providerId(
    "message",
    account.accountId,
    scan.chat.id,
    message.id,
  );
  const deletionState: BeeperMessageLikeMeMessage["deletion"] =
    message.isDeleted || message.isHidden
      ? Object.freeze({
          state: message.isDeleted && message.isHidden
            ? "revoked-and-deleted-for-me"
            : message.isDeleted
              ? "revoked"
              : "deleted-for-me",
          observedAt,
          providerRevision: message.editedTimestamp ?? message.sortKey,
        })
      : null;
  const replyProviderId = message.linkedMessageId === null
    ? null
    : providerId(
        "message",
        account.accountId,
        scan.chat.id,
        message.linkedMessageId,
      );
  return Object.freeze({
    schemaVersion: 1,
    kind: "message",
    id,
    accountId: localId("account", account.accountId),
    network,
    provenance: Object.freeze({
      providerId: providerMessageId,
      providerRevision: message.editedTimestamp ?? message.sortKey,
      observedAt,
      connectedAccountProviderId: providerId("account", account.accountId),
    }),
    conversationId: localId("conversation", account.accountId, scan.chat.id),
    senderParticipantId: localId("participant", account.accountId, message.senderId),
    direction: message.isSender ? "outgoing" : "incoming",
    sentAt: message.timestamp,
    sortKey: message.sortKey,
    body: deletionState === null ? message.text : null,
    bodyTruncated: false,
    replyTo: message.linkedMessageId === null || replyProviderId === null
      ? null
      : Object.freeze({
          messageId: messageIds.has(message.linkedMessageId)
            ? localId(
                "message",
                account.accountId,
                scan.chat.id,
                message.linkedMessageId,
              )
            : null,
          providerId: replyProviderId,
        }),
    edit: message.editedTimestamp === null
      ? null
      : Object.freeze({
          kind: "in-place" as const,
          editedAt: message.editedTimestamp,
          providerRevision: message.editedTimestamp,
        }),
    deletion: deletionState,
    attachments: Object.freeze(message.attachments.map(attachment)),
  });
}

function reactionRecord(
  reaction: BeeperReactionProjection,
  message: BeeperMessageProjection,
  scan: ConversationScan,
  account: BeeperAccountProjection,
  network: string,
  observedAt: string,
): BeeperMessageLikeMeReaction {
  const id = localId(
    "reaction",
    account.accountId,
    scan.chat.id,
    message.id,
    reaction.id,
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "reaction",
    id,
    accountId: localId("account", account.accountId),
    network,
    provenance: Object.freeze({
      providerId: providerId(
        "reaction",
        account.accountId,
        scan.chat.id,
        message.id,
        reaction.id,
      ),
      providerRevision: reaction.id,
      observedAt,
      connectedAccountProviderId: providerId("account", account.accountId),
    }),
    messageId: localId("message", account.accountId, scan.chat.id, message.id),
    messageProviderId: providerId(
      "message",
      account.accountId,
      scan.chat.id,
      message.id,
    ),
    participantId: localId("participant", account.accountId, reaction.participantId),
    body: reactionBody(reaction.reactionKey),
    reactedAt: null,
    state: "active",
  });
}

function tombstoneRecord(
  message: BeeperMessageProjection,
  scan: ConversationScan,
  account: BeeperAccountProjection,
  network: string,
  observedAt: string,
): BeeperMessageLikeMeTombstone | null {
  if (!message.isDeleted && !message.isHidden) return null;
  const messageId = localId("message", account.accountId, scan.chat.id, message.id);
  const providerMessageId = providerId(
    "message",
    account.accountId,
    scan.chat.id,
    message.id,
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "tombstone",
    id: localId("tombstone", account.accountId, scan.chat.id, message.id),
    accountId: localId("account", account.accountId),
    network,
    provenance: Object.freeze({
      providerId: providerId("tombstone", account.accountId, scan.chat.id, message.id),
      providerRevision: message.editedTimestamp ?? message.sortKey,
      observedAt,
      connectedAccountProviderId: providerId("account", account.accountId),
    }),
    entityKind: "message",
    entityId: messageId,
    entityProviderId: providerMessageId,
    deletedAt: observedAt,
    scope: message.isDeleted && message.isHidden
      ? "unknown"
      : message.isDeleted
        ? "remote"
        : "local",
    providerRevision: message.editedTimestamp ?? message.sortKey,
  });
}

async function assertExactDirectoryEntries(
  path: string,
  expected: readonly string[],
  label: string,
): Promise<void> {
  const actual = (await readdir(path)).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((entry, index) => entry !== wanted[index])
  ) fail(`${label} contained an unexpected file layout`);
}

/**
 * Creates a single-use source for the private bundle sink. The official CLI
 * performs its own complete local pagination. Its duplicate transcript files
 * remain inside one private staging root and are removed before completion.
 */
export function createBeeperMessageLikeMeSource(
  request: BeeperMessageLikeMeSourceRequest,
): BeeperMessageLikeMeExportSource {
  const auth = requireAuth(request.auth);
  const limits = parseLimits(request.limits);
  let consumed = false;
  let completion: unknown;

  const records = (async function* (): AsyncGenerator<BeeperMessageLikeMeRecord> {
    if (consumed) return fail("record stream is single-use");
    consumed = true;
    throwIfAborted(request.signal);
    const configDirectory = await validateBeeperCliStore(auth.path);
    const environment = request.environment ?? process.env;
    const binary = request.dependencies?.binaryPath
      ?? await resolvePinnedBeeperCliBinary(environment);
    const maxBundleRecords = request.dependencies?.maxBundleRecords === undefined
      ? BEEPER_MESSAGE_LIKE_ME_MAX_RECORDS
      : positiveInteger(
          request.dependencies.maxBundleRecords,
          "test maxBundleRecords",
          BEEPER_MESSAGE_LIKE_ME_MAX_RECORDS,
        );
    const maxBundleBytes = request.dependencies?.maxBundleBytes === undefined
      ? BEEPER_MESSAGE_LIKE_ME_MAX_TOTAL_BYTES
      : positiveInteger(
          request.dependencies.maxBundleBytes,
          "test maxBundleBytes",
          BEEPER_MESSAGE_LIKE_ME_MAX_TOTAL_BYTES,
        );
    const maxMessagesJsonBytes = request.dependencies?.maxMessagesJsonBytes === undefined
      ? MAX_MESSAGES_JSON_BYTES
      : positiveInteger(
          request.dependencies.maxMessagesJsonBytes,
          "test maxMessagesJsonBytes",
          MAX_MESSAGES_JSON_BYTES,
        );
    if (!isAbsolute(binary)) return fail("Beeper CLI binary path must be absolute");
    const customCreateWorking = request.dependencies?.createWorkingDirectory;
    const customRemoveWorking = request.dependencies?.removeWorkingDirectory;
    if ((customCreateWorking === undefined) !== (customRemoveWorking === undefined)) {
      return fail("test working-directory create and remove seams must be supplied together");
    }
    const createWorking = customCreateWorking
      ?? (() => mkdtemp(join(tmpdir(), "wrench-beeper-message-like-me-")));
    const removeWorking = customRemoveWorking
      ?? ((path: string) => rm(path, { recursive: true, force: true }));
    const working = await createWorking();
    if (!isAbsolute(working)) return fail("working directory must be absolute");
    await chmod(working, PRIVATE_DIRECTORY_MODE);
    const canonicalWorking = await assertPrivateOwnedDirectory(await realpath(working));
    const rawRoot = resolve(canonicalWorking, "official-export");
    const cacheDirectory = resolve(canonicalWorking, "cli-payload-cache");
    await mkdir(rawRoot, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(rawRoot, PRIVATE_DIRECTORY_MODE);
    await mkdir(cacheDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(cacheDirectory, PRIVATE_DIRECTORY_MODE);
    await assertPrivateOwnedDirectory(rawRoot, canonicalWorking);
    await assertPrivateOwnedDirectory(cacheDirectory, canonicalWorking);
    try {
      const arguments_ = planBeeperMessageLikeMeExportCommand({
        outputDirectory: rawRoot,
        limitChats: limits.limitChats,
        limitMessages: limits.limitMessages,
        maxParticipants: limits.maxParticipants,
      }, limits.timeoutMs);
      const run = request.dependencies?.runExport ?? runExportCli;
      const result = await run({
        binary,
        arguments: arguments_,
        environment: environmentForExport(configDirectory, cacheDirectory),
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: MAX_STDOUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      throwIfAborted(request.signal);
      if (result.exitCode !== 0 || result.stderr.trim().length !== 0) {
        return fail("official read-only export failed");
      }
      // Official v0.6.2 creates nested 0755/0644 entries. The exact 0700 root
      // is the privacy boundary; nested entries must still be owned, physical,
      // non-writable by others, and regular files must have one link.
      await assertPrivateOwnedDirectory(rawRoot, canonicalWorking);
      await assertExactDirectoryEntries(rawRoot, [
        ".beeper-export-state.json",
        "accounts.json",
        "chats",
        "chats.json",
        "manifest.json",
      ], "official export root");

      const accountsValue = await readOwnedJson(
        join(rawRoot, "accounts.json"),
        rawRoot,
        MAX_ACCOUNTS_JSON_BYTES,
      );
      const accounts = parseBeeperExportAccounts(accountsValue);
      if (beeperSubjectFromAccounts(accounts) !== auth.subject) {
        return fail("official export account did not match the bound auth realm");
      }
      const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
      const manifest = parseManifest(await readOwnedJson(
        join(rawRoot, "manifest.json"),
        rawRoot,
        MAX_ACCOUNTS_JSON_BYTES,
      ));
      const manifestAccounts = parseBeeperExportAccounts(manifest.accounts);
      if (
        manifest.attachmentCount !== 0
        || canonicalJson(manifestAccounts) !== canonicalJson(accounts)
      ) return fail("official export manifest did not prove a no-attachment account snapshot");

      const listedValues = array(
        await readOwnedJson(
          join(rawRoot, "chats.json"),
          rawRoot,
          MAX_CHATS_JSON_BYTES,
        ),
        "official export chats",
        MAX_EXPORT_CHATS,
      );
      const listedChats = listedValues.map((value) =>
        parseBeeperExportConversation(value, accounts));
      if (manifest.chatCount !== listedChats.length) {
        return fail("official export manifest chat count did not match chats.json");
      }
      const chatSegments = listedChats.map((chat) => safeSegment(chat.id));
      if (new Set(chatSegments).size !== chatSegments.length) {
        return fail("official export chat directory names collided");
      }
      const chatsRoot = await assertOwnedDirectory(join(rawRoot, "chats"), rawRoot);
      await assertExactDirectoryEntries(chatsRoot, chatSegments, "official export chats");
      const stateMessageCounts = parseOfficialState(await readOwnedJson(
        join(rawRoot, ".beeper-export-state.json"),
        rawRoot,
        MAX_CHATS_JSON_BYTES,
      ), listedChats.map((chat) => chat.id), manifest.createdAt);
      let officialMessageCount = 0;
      for (const count of stateMessageCounts.values()) {
        officialMessageCount += count;
        if (!Number.isSafeInteger(officialMessageCount)) {
          return fail("official export message count overflowed");
        }
      }
      if (officialMessageCount !== manifest.messageCount) {
        return fail("official export manifest message count did not match chat state");
      }

      const participantFacts = new Map<string, ParticipantFact>();
      const selfParticipantByAccount = new Map<string, string>();
      for (const account of accounts) {
        const self = upsertParticipant(participantFacts, account, account.user, true);
        selfParticipantByAccount.set(account.accountId, self.id);
      }

      const scans: ConversationScan[] = [];
      let observedFrom: string | null = null;
      let observedThrough: string | null = null;
      let participantRosterIncomplete = false;
      let messageLimitReached = false;
      let oversizedChatSkipped = false;
      let scannedRecordCount = accounts.length + selfParticipantByAccount.size;
      let scanRecordBudgetExhausted = false;
      const listedChatEntries = listedChats.map((chat, index) => {
        const segment = chatSegments[index];
        if (segment === undefined) return fail("official export chat segment disappeared");
        return Object.freeze({ chat, segment });
      }).sort((left, right) =>
        localId("conversation", left.chat.accountId, left.chat.id).localeCompare(
          localId("conversation", right.chat.accountId, right.chat.id),
        ));
      for (const { chat: listedChat, segment } of listedChatEntries) {
        throwIfAborted(request.signal);
        const directory = await assertOwnedDirectory(join(chatsRoot, segment), rawRoot);
        await assertExactDirectoryEntries(directory, [
          "attachments",
          "chat.json",
          "messages.html",
          "messages.json",
          "messages.markdown",
        ], "official export chat directory");
        const attachmentsDirectory = await assertOwnedDirectory(
          join(directory, "attachments"),
          rawRoot,
        );
        await assertExactDirectoryEntries(
          attachmentsDirectory,
          [],
          "official export attachments directory",
        );
        const chat = parseBeeperExportConversation(await readOwnedJson(
          join(directory, "chat.json"),
          rawRoot,
          MAX_CHAT_JSON_BYTES,
        ), accounts);
        if (chat.id !== listedChat.id || chat.accountId !== listedChat.accountId) {
          return fail("official export chat detail did not match chats.json");
        }
        const account = accountsById.get(chat.accountId);
        if (account === undefined) return fail("official export chat references an unknown account");
        const expectedMessageCount = stateMessageCounts.get(chat.id);
        if (expectedMessageCount === undefined) {
          return fail("official export chat state disappeared");
        }
        if (
          limits.limitMessages !== null
          && expectedMessageCount >= limits.limitMessages
        ) messageLimitReached = true;
        const messagesPath = join(directory, "messages.json");
        if (await ownedFileSize(messagesPath, rawRoot) > maxMessagesJsonBytes) {
          oversizedChatSkipped = true;
          await unlink(join(directory, "messages.markdown"));
          await unlink(join(directory, "messages.html"));
          continue;
        }
        if (
          scanRecordBudgetExhausted
          || expectedMessageCount + 1 > maxBundleRecords - scannedRecordCount
        ) {
          scanRecordBudgetExhausted = true;
          await unlink(join(directory, "messages.markdown"));
          await unlink(join(directory, "messages.html"));
          continue;
        }
        const newlyCreatedParticipantIds = new Set<string>();
        const participantIds = new Set<string>();
        for (const participant of chat.participants.items) {
          participantIds.add(upsertParticipant(
            participantFacts,
            account,
            participant,
            participant.isSelf,
            newlyCreatedParticipantIds,
          ).id);
        }
        if (chat.type === "single") {
          const self = selfParticipantByAccount.get(account.accountId);
          if (self === undefined) return fail("Beeper account self participant disappeared");
          participantIds.add(self);
        }
        const messages = parseBeeperExportMessages(
          await readOwnedJson(messagesPath, rawRoot, maxMessagesJsonBytes),
          chat.accountId,
          chat.id,
          MAX_EXPORT_MESSAGES_PER_CHAT,
        );
        if (messages.length !== expectedMessageCount) {
          return fail("official export chat messages did not match completed state");
        }
        const messageIds = new Set(messages.map((message) => message.id));
        const reactionCount = messages.reduce(
          (count, message) => count + message.reactions.length,
          0,
        );
        const tombstoneCount = messages.reduce(
          (count, message) => count + (message.isDeleted || message.isHidden ? 1 : 0),
          0,
        );
        if (
          !Number.isSafeInteger(reactionCount)
          || !Number.isSafeInteger(tombstoneCount)
        ) return fail("official export derived record count overflowed");
        for (const message of messages) {
          participantIds.add(upsertParticipant(participantFacts, account, {
            id: message.senderId,
            fullName: message.senderName,
            phoneNumber: null,
            email: null,
            username: null,
          }, message.isSender, newlyCreatedParticipantIds).id);
          for (const reaction of message.reactions) {
            participantIds.add(upsertParticipant(participantFacts, account, {
              id: reaction.participantId,
              fullName: null,
              phoneNumber: null,
              email: null,
              username: null,
            }, null, newlyCreatedParticipantIds).id);
          }
        }
        const scanRecordCount = 1
          + messages.length
          + reactionCount
          + tombstoneCount
          + newlyCreatedParticipantIds.size;
        if (scanRecordCount > maxBundleRecords - scannedRecordCount) {
          for (const participantId of newlyCreatedParticipantIds) {
            participantFacts.delete(participantId);
          }
          scanRecordBudgetExhausted = true;
          await unlink(join(directory, "messages.markdown"));
          await unlink(join(directory, "messages.html"));
          continue;
        }
        scannedRecordCount += scanRecordCount;
        const range = messageTimestampRange(messages);
        if (range.first !== null && (observedFrom === null || range.first < observedFrom)) {
          observedFrom = range.first;
        }
        if (range.last !== null && (observedThrough === null || range.last > observedThrough)) {
          observedThrough = range.last;
        }
        const roster = [...participantIds].map((participantId) => {
          const participant = participantFacts.get(participantId);
          if (participant === undefined) {
            return fail("Beeper conversation participant disappeared");
          }
          return participant;
        });
        const directRosterComplete = chat.type !== "single"
          || (
            roster.length === 2
            && roster.filter((participant) => participant.isSelf === true).length === 1
            && roster.filter((participant) => participant.isSelf !== true).length === 1
          );
        const participantsComplete = !chat.participants.hasMore
          && chat.participants.items.length === chat.participants.total
          && directRosterComplete;
        if (!participantsComplete) participantRosterIncomplete = true;
        const scanDraft: ConversationScan = Object.freeze({
          chat,
          directory,
          messagesPath,
          participantIds: Object.freeze([...participantIds].sort()),
          participantsComplete,
          startedAt: range.first,
          lastMessageAt: range.last,
          messageCount: messages.length,
          reactionCount,
          tombstoneCount,
          nonParticipantRecordBytes: 0,
        });
        const network = normalizeNetwork(account.network, account.bridge.type);
        let nonParticipantRecordBytes = bundleRecordBytes(
          conversationRecord(scanDraft, account, network, manifest.completedAt),
        );
        for (const message of messages) {
          nonParticipantRecordBytes += bundleRecordBytes(
            messageRecord(
              message,
              scanDraft,
              messageIds,
              account,
              network,
              manifest.completedAt,
            ),
          );
          for (const reaction of message.reactions) {
            nonParticipantRecordBytes += bundleRecordBytes(reactionRecord(
              reaction,
              message,
              scanDraft,
              account,
              network,
              manifest.completedAt,
            ));
          }
          const tombstone = tombstoneRecord(
            message,
            scanDraft,
            account,
            network,
            manifest.completedAt,
          );
          if (tombstone !== null) {
            nonParticipantRecordBytes += bundleRecordBytes(tombstone);
          }
        }
        if (!Number.isSafeInteger(nonParticipantRecordBytes)) {
          return fail("official export derived record bytes overflowed");
        }
        scans.push(Object.freeze({
          ...scanDraft,
          nonParticipantRecordBytes,
        }));
        // These plaintext renderings are redundant after strict JSON conversion.
        await unlink(join(directory, "messages.markdown"));
        await unlink(join(directory, "messages.html"));
      }
      const orderedScans = [...scans].sort((left, right) =>
        localId("conversation", left.chat.accountId, left.chat.id).localeCompare(
          localId("conversation", right.chat.accountId, right.chat.id),
        ));
      const selectedParticipantIds = new Set(selfParticipantByAccount.values());
      const selectedScans: ConversationScan[] = [];
      let selectedRecordCount = accounts.length + selectedParticipantIds.size;
      let selectedRecordBytes = 0;
      for (const account of accounts) {
        const selfParticipantId = selfParticipantByAccount.get(account.accountId);
        if (selfParticipantId === undefined) {
          return fail("Beeper account self participant disappeared");
        }
        const network = normalizeNetwork(account.network, account.bridge.type);
        selectedRecordBytes += bundleRecordBytes(accountRecord(
          account,
          network,
          manifest.completedAt,
          selfParticipantId,
        ));
        const selfFact = participantFacts.get(selfParticipantId);
        if (selfFact === undefined) return fail("Beeper account self participant disappeared");
        selectedRecordBytes += bundleRecordBytes(participantRecord(
          selfFact,
          account,
          network,
          manifest.completedAt,
        ));
      }
      let bundleRecordLimitReached = scanRecordBudgetExhausted;
      let bundleByteLimitReached = false;
      for (const scan of orderedScans) {
        let addedParticipants = 0;
        let addedParticipantBytes = 0;
        for (const participantId of scan.participantIds) {
          if (selectedParticipantIds.has(participantId)) continue;
          addedParticipants += 1;
          const fact = participantFacts.get(participantId);
          const account = fact === undefined
            ? undefined
            : accountsById.get(scan.chat.accountId);
          if (fact === undefined || account === undefined) {
            return fail("selected participant source identity disappeared");
          }
          addedParticipantBytes += bundleRecordBytes(participantRecord(
            fact,
            account,
            normalizeNetwork(account.network, account.bridge.type),
            manifest.completedAt,
          ));
        }
        const scanRecords = 1
          + scan.messageCount
          + scan.reactionCount
          + scan.tombstoneCount
          + addedParticipants;
        const scanBytes = scan.nonParticipantRecordBytes + addedParticipantBytes;
        const exceedsRecords = scanRecords > maxBundleRecords - selectedRecordCount;
        const exceedsBytes = scanBytes > maxBundleBytes - selectedRecordBytes;
        if (exceedsRecords || exceedsBytes) {
          bundleRecordLimitReached ||= exceedsRecords;
          bundleByteLimitReached ||= exceedsBytes;
          break;
        }
        selectedScans.push(scan);
        selectedRecordCount += scanRecords;
        selectedRecordBytes += scanBytes;
        for (const participantId of scan.participantIds) {
          selectedParticipantIds.add(participantId);
        }
      }
      observedFrom = null;
      observedThrough = null;
      for (const scan of selectedScans) {
        if (
          scan.startedAt !== null
          && (observedFrom === null || scan.startedAt < observedFrom)
        ) observedFrom = scan.startedAt;
        if (
          scan.lastMessageAt !== null
          && (observedThrough === null || scan.lastMessageAt > observedThrough)
        ) observedThrough = scan.lastMessageAt;
      }
      participantRosterIncomplete = selectedScans.some(
        (scan) => !scan.participantsComplete,
      );

      for (const account of [...accounts].sort((left, right) =>
        left.accountId.localeCompare(right.accountId))) {
        const selfParticipantId = selfParticipantByAccount.get(account.accountId);
        if (selfParticipantId === undefined) return fail("Beeper account has no self participant");
        yield accountRecord(
          account,
          normalizeNetwork(account.network, account.bridge.type),
          manifest.completedAt,
          selfParticipantId,
        );
      }
      for (const fact of [...participantFacts.values()]
        .filter((candidate) => selectedParticipantIds.has(candidate.id))
        .sort((left, right) => left.id.localeCompare(right.id))) {
        const account = accounts.find((candidate) =>
          localId("account", candidate.accountId) === fact.accountId);
        if (account === undefined) return fail("participant account disappeared");
        yield participantRecord(
          fact,
          account,
          normalizeNetwork(account.network, account.bridge.type),
          manifest.completedAt,
        );
      }
      for (const scan of selectedScans) {
        const account = accountsById.get(scan.chat.accountId);
        if (account === undefined) return fail("conversation account disappeared");
        const network = normalizeNetwork(account.network, account.bridge.type);
        yield conversationRecord(scan, account, network, manifest.completedAt);
        const messages = parseBeeperExportMessages(
          await readOwnedJson(
            scan.messagesPath,
            rawRoot,
            maxMessagesJsonBytes,
          ),
          scan.chat.accountId,
          scan.chat.id,
          MAX_EXPORT_MESSAGES_PER_CHAT,
        );
        const messageIds = new Set(messages.map((message) => message.id));
        for (const message of messages) {
          yield messageRecord(
            message,
            scan,
            messageIds,
            account,
            network,
            manifest.completedAt,
          );
          for (const reaction of message.reactions) {
            yield reactionRecord(
              reaction,
              message,
              scan,
              account,
              network,
              manifest.completedAt,
            );
          }
          const tombstone = tombstoneRecord(
            message,
            scan,
            account,
            network,
            manifest.completedAt,
          );
          if (tombstone !== null) yield tombstone;
        }
      }

      const warnings = new Set([
        "attachments-metadata-only",
        "remote-history-not-claimed",
        "connected-account-backfill-coverage-unknown",
      ]);
      const chatLimitReached = limits.limitChats !== null
        && listedChats.length >= limits.limitChats;
      if (chatLimitReached) warnings.add("chat-limit-reached");
      if (messageLimitReached) warnings.add("message-limit-reached");
      if (participantRosterIncomplete) warnings.add("participant-roster-incomplete");
      if (oversizedChatSkipped) warnings.add("oversized-chat-skipped");
      if (bundleRecordLimitReached) warnings.add("bundle-record-limit-reached");
      if (bundleByteLimitReached) warnings.add("bundle-byte-limit-reached");
      const truncated = chatLimitReached
        || messageLimitReached
        || oversizedChatSkipped
        || bundleRecordLimitReached
        || bundleByteLimitReached;
      completion = Object.freeze({
        completeness: Object.freeze({
          kind: truncated ? "truncated" : "bounded-local",
          reason: bundleRecordLimitReached
            ? "bundle-record-limit"
            : bundleByteLimitReached
              ? "bundle-byte-limit"
              : oversizedChatSkipped
                ? "oversized-chat"
                : truncated
                  ? "explicit-source-limit"
                  : "desktop-local-export",
          observedFrom,
          observedThrough,
        }),
        warnings: Object.freeze([...warnings].sort()),
      });
    } finally {
      await removeWorking(canonicalWorking);
    }
  })();

  return Object.freeze({
    descriptor: Object.freeze({
      source: Object.freeze({ id: "beeper-local", version: "1.0.0" }),
      provider: Object.freeze({ id: "beeper", version: BEEPER_CLI_PIN.version }),
    }),
    records,
    completion: async () => {
      if (completion === undefined) return fail("record stream did not complete");
      return completion;
    },
  });
}
