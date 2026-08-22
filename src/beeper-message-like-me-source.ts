import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { WrenchAuth } from "./auth";
import { removePrivateDirectoryTree } from "./storage";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeDirectoryLease,
  updateBeeperMessageLikeMeDirectoryLease,
  type BeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";
import {
  BEEPER_MESSAGE_LIKE_ME_MAX_RECORDS,
  BEEPER_MESSAGE_LIKE_ME_MAX_TOTAL_BYTES,
} from "./beeper-message-like-me-export";
import type {
  BeeperMessageLikeMeAccount,
  BeeperMessageLikeMeAttachment,
  BeeperMessageLikeMeBundleProgress,
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
  planBeeperAccountsListCommand,
  planBeeperMessageLikeMeExportCommand,
} from "./providers/beeper-local";
import {
  beeperSubjectFromAccounts,
  parseBeeperCliEnvelope,
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
const PRIVATE_FILE_MODE = 0o600;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const ACCOUNT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_ACCOUNTS_LIST_BYTES = 8 * 1024 * 1024;
const MAX_BEEPER_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_ACCOUNTS_JSON_BYTES = 32 * 1024 * 1024;
const MAX_CHATS_JSON_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGES_JSON_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_CHATS = 100_000;
const MAX_EXPORT_MESSAGES_PER_CHAT = 1_000_000;
const MAX_RAW_WORKING_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_FREE_FILESYSTEM_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RAW_WORKING_ENTRIES = 1_000_000;
const MAX_RAW_CACHE_SYMLINK_TARGET_BYTES = 512;
const RAW_WORKING_MONITOR_INTERVAL_MS = 500;
const RAW_WORKING_RECOVERY_GRACE_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PARTICIPANTS = 500;
const MAX_PARTICIPANT_OCCURRENCES = 250_000;
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
  workingRoot?: string;
  maxWorkingBytes?: number;
  onHeartbeat?: (elapsedSeconds: number) => void;
  signal?: AbortSignal;
  directoryLease?: BeeperMessageLikeMeDirectoryLease;
}>;

export type BeeperMessageLikeMeProgress =
  | BeeperMessageLikeMeBundleProgress
  | Readonly<{
    phase: "recovery-started";
  }>
  | Readonly<{
    phase: "recovery-completed";
    recovered: number;
    published: number;
  }>
  | Readonly<{
    phase: "preparing";
  }>
  | Readonly<{
    phase: "accounts-discovered";
    accounts: number;
  }>
  | Readonly<{
    phase: "accounts-progress";
    stage: "discovering" | "verifying";
    elapsedSeconds: number;
  }>
  | Readonly<{
    phase: "account-started";
    account: number;
    accounts: number;
  }>
  | Readonly<{
    phase: "account-validating";
    account: number;
    accounts: number;
    elapsedSeconds: number;
  }>
  | Readonly<{
    phase: "account-progress";
    account: number;
    accounts: number;
    elapsedSeconds: number;
  }>
  | Readonly<{
    phase: "account-skipped";
    account: number;
    accounts: number;
    reason: "chat-limit-reached";
  }>
  | Readonly<{
    phase: "account-completed";
    account: number;
    accounts: number;
    chats: number;
    messages: number;
  }>
  | Readonly<{
    phase: "accounts-verifying";
    accounts: number;
  }>
  | Readonly<{
    phase: "conversion-progress";
    elapsedSeconds: number;
  }>
  | Readonly<{
    phase: "conversion-started";
    accounts: number;
    chats: number;
    messages: number;
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
  /** Test-only seam for exercising the participant-occurrence work cap. */
  maxParticipantOccurrences?: number;
  /** Test-only seam for mutating a fixture between bounded alias passes. */
  onSelfAliasRefinementPass?: (pass: number) => Promise<void>;
  runCli?: (
    invocation: BeeperExportCliInvocation,
  ) => Promise<BeeperCliInvocationResult>;
  createWorkingDirectory?: () => Promise<string>;
  removeWorkingDirectory?: (path: string) => Promise<void>;
}>;

export type BeeperMessageLikeMeSourceRequest = Readonly<{
  auth: WrenchAuth;
  limits?: BeeperMessageLikeMeSourceLimits;
  signal?: AbortSignal;
  onProgress?: (progress: BeeperMessageLikeMeProgress) => void;
  environment?: Readonly<Record<string, string | undefined>>;
  dependencies?: BeeperMessageLikeMeSourceDependencies;
}>;

type ParsedLimits = Readonly<{
  limitChats: number | null;
  limitMessages: number | null;
  maxParticipants: number;
  timeoutMs: number;
}>;

type ParticipantFact = Readonly<{
  readonly id: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly displayName: string | null;
  readonly handle: string | null;
  readonly isSelf: boolean | null;
}>;

type PrivateDirectoryIdentity = Readonly<{
  device: number;
  inode: number;
}>;

type ConversationScan = Readonly<{
  chat: Pick<
    BeeperConversationProjection,
    "id" | "accountId" | "lastActivity" | "title" | "type"
  >;
  root: string;
  messagesPath: string;
  messagesSha256: string;
  observedAt: string;
  participantIds: readonly string[];
  participantFactChanges: readonly ParticipantFact[];
  participantsComplete: boolean;
  startedAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  reactionCount: number;
  reactionProviderIdNonUniqueGroups: number;
  tombstoneCount: number;
  nonParticipantRecordBytes: number;
}>;

type ValidatedShardChat = Readonly<{
  chat: Pick<BeeperConversationProjection, "id" | "accountId">;
  root: string;
  chatPath: string;
  chatSha256: string;
  messagesPath: string;
  expectedMessageCount: number;
  observedAt: string;
}>;

type ValidatedAccountShard = Readonly<{
  accountId: string;
  completedAt: string;
  chats: readonly ValidatedShardChat[];
  messageCount: number;
}>;

type SelfAliasPrepass = Readonly<{
  aliasesByAccount: ReadonlyMap<string, ReadonlySet<string>>;
  coveredChats: readonly ValidatedShardChat[];
  bundleByteLimitReached: boolean;
  bundleRecordLimitReached: boolean;
  evidenceLimitReached: boolean;
  messagesSha256ByPath: ReadonlyMap<string, string>;
  participantOccurrenceLimitReached: boolean;
  provisionalRecordBytes: number;
  provisionalRecordCount: number;
}>;

type BeeperCliStoreSnapshot = Readonly<{
  config: JsonRecord;
  desktopTarget: JsonRecord;
}>;

type OperationPrivateBeeperStore = Readonly<{
  path: string;
  identity: PrivateDirectoryIdentity;
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
}> & Readonly<{ provider: "beeper"; subject: string }> {
  if (
    auth.kind !== "linked-device-store"
    || auth.provider !== "beeper"
    || auth.subject === undefined
    || !/^beeper:local:[a-f0-9]{64}$/u.test(auth.subject)
  ) return fail("export requires an account-bound Beeper linked-device-store auth locator");
  return auth as Extract<WrenchAuth, {
    readonly kind: "linked-device-store";
  }> & Readonly<{ provider: "beeper"; subject: string }>;
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

async function readOwnedJsonDocument(
  path: string,
  root: string,
  maximumBytes: number,
  privateFile = false,
  signal?: AbortSignal,
): Promise<Readonly<{ value: unknown; sha256: string }>> {
  throwIfAborted(signal);
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
      || (privateFile && (before.mode & 0o077) !== 0)
      || before.size < 2
      || before.size > maximumBytes
    ) return fail("official export file is outside its ownership or size bound");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      throwIfAborted(signal);
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
    throwIfAborted(signal);
    if (
      pathMetadata.isSymbolicLink()
      || pathMetadata.nlink !== 1
      || pathMetadata.dev !== after.dev
      || pathMetadata.ino !== after.ino
    ) return fail("official export file changed while being read");
    let value: unknown;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(decoded) as unknown;
    } catch {
      return fail("official export file is not valid UTF-8 JSON");
    }
    throwIfAborted(signal);
    return Object.freeze({
      value,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function readOwnedJson(
  path: string,
  root: string,
  maximumBytes: number,
  privateFile = false,
  signal?: AbortSignal,
): Promise<unknown> {
  return (await readOwnedJsonDocument(
    path,
    root,
    maximumBytes,
    privateFile,
    signal,
  )).value;
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
  const createdAt = timestamp(source.createdAt, "official export manifest createdAt");
  const completedAt = timestamp(source.completedAt, "official export manifest completedAt");
  if (completedAt < createdAt) {
    return fail("official export manifest completed before it started");
  }
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
    completedAt,
    createdAt,
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

function pathInside(root: string, path: string): boolean {
  return path.startsWith(`${root}${sep}`);
}

function sameFilesystemObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs;
}

class BeeperRawStagingInvariantError extends Error {}

function rawStagingFail(message: string): never {
  throw new BeeperRawStagingInvariantError(
    `Beeper Message Like Me source: ${message}`,
  );
}

function unsafeCacheSymlink(): never {
  return rawStagingFail(
    "raw export staging contained an unsafe CLI payload-cache symbolic link",
  );
}

async function assertSafeCliPayloadCacheSymlink(
  path: string,
  directory: string,
  cacheRoot: string,
  linkMetadata: Stats,
  uid: number,
): Promise<void> {
  if (!pathInside(cacheRoot, path)) {
    return rawStagingFail(
      "raw export staging contained a symbolic link outside its CLI payload cache",
    );
  }
  if (
    linkMetadata.uid !== uid
    || linkMetadata.nlink !== 1
    || /[\u0000-\u001f\u007f\ufffd]/u.test(basename(path))
  ) return unsafeCacheSymlink();

  let target: string;
  try {
    target = await readlink(path);
  } catch {
    return unsafeCacheSymlink();
  }
  if (
    target.length === 0
    || isAbsolute(target)
    || Buffer.byteLength(target, "utf8") > MAX_RAW_CACHE_SYMLINK_TARGET_BYTES
    || /[\u0000-\u001f\u007f\ufffd]/u.test(target)
  ) return unsafeCacheSymlink();
  const lexicalTarget = resolve(directory, target);
  if (!pathInside(cacheRoot, lexicalTarget)) return unsafeCacheSymlink();

  const targetParent = dirname(lexicalTarget);
  const targetParentRelative = relative(cacheRoot, targetParent);
  const linkParentRelative = relative(cacheRoot, directory);
  if (
    dirname(path) !== directory
    || targetParentRelative === ".."
    || targetParentRelative.startsWith(`..${sep}`)
    || isAbsolute(targetParentRelative)
    || linkParentRelative === ".."
    || linkParentRelative.startsWith(`..${sep}`)
    || isAbsolute(linkParentRelative)
  ) return unsafeCacheSymlink();
  const parentSnapshots: { readonly path: string; readonly metadata: Stats }[] = [];
  try {
    const cacheMetadata = await lstat(cacheRoot);
    if (
      !cacheMetadata.isDirectory()
      || cacheMetadata.isSymbolicLink()
      || cacheMetadata.uid !== uid
      || (cacheMetadata.mode & 0o022) !== 0
    ) return unsafeCacheSymlink();
    parentSnapshots.push({ path: cacheRoot, metadata: cacheMetadata });
    for (const parentRelative of [targetParentRelative, linkParentRelative]) {
      if (parentRelative === "") continue;
      let currentParent = cacheRoot;
      for (const segment of parentRelative.split(sep)) {
        if (segment === "" || segment === "." || segment === "..") {
          return unsafeCacheSymlink();
        }
        currentParent = join(currentParent, segment);
        if (parentSnapshots.some((snapshot) => snapshot.path === currentParent)) {
          continue;
        }
        const metadata = await lstat(currentParent);
        if (
          !metadata.isDirectory()
          || metadata.isSymbolicLink()
          || metadata.uid !== uid
          || (metadata.mode & 0o022) !== 0
        ) return unsafeCacheSymlink();
        parentSnapshots.push({ path: currentParent, metadata });
      }
    }
  } catch {
    return unsafeCacheSymlink();
  }

  let targetHandle;
  try {
    targetHandle = await open(
      lexicalTarget,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    return unsafeCacheSymlink();
  }
  try {
    const targetBefore = await targetHandle.stat();
    if (
      !targetBefore.isFile()
      || targetBefore.uid !== uid
      || targetBefore.nlink !== 1
      || (targetBefore.mode & 0o022) !== 0
    ) return unsafeCacheSymlink();
    let targetPathMetadata: Stats;
    let targetCanonical: string;
    let linkCanonical: string;
    let linkAfter: Stats;
    let targetAfterText: string;
    try {
      targetPathMetadata = await lstat(lexicalTarget);
      if (
        !targetPathMetadata.isFile()
        || targetPathMetadata.isSymbolicLink()
        || targetPathMetadata.uid !== uid
        || targetPathMetadata.nlink !== 1
        || (targetPathMetadata.mode & 0o022) !== 0
        || !sameFilesystemObject(targetBefore, targetPathMetadata)
      ) return unsafeCacheSymlink();
      targetCanonical = await realpath(lexicalTarget);
      linkCanonical = await realpath(path);
      linkAfter = await lstat(path);
      targetAfterText = await readlink(path);
    } catch {
      return unsafeCacheSymlink();
    }
    const targetAfter = await targetHandle.stat();
    if (
      !sameFilesystemObject(targetBefore, targetAfter)
      || targetCanonical !== lexicalTarget
      || linkCanonical !== lexicalTarget
      || !sameFilesystemObject(linkMetadata, linkAfter)
      || targetAfterText !== target
    ) return unsafeCacheSymlink();
    for (const snapshot of parentSnapshots) {
      let current: Stats;
      try {
        current = await lstat(snapshot.path);
      } catch {
        return unsafeCacheSymlink();
      }
      if (
        !current.isDirectory()
        || current.isSymbolicLink()
        || !sameFilesystemObject(snapshot.metadata, current)
        || await realpath(snapshot.path).catch(() => null) !== snapshot.path
      ) return unsafeCacheSymlink();
    }
  } finally {
    await targetHandle.close();
  }
}

/** @internal Exported only for focused safety tests. */
export async function enforceBeeperRawWorkingBudget(
  root: string,
  maximumBytes: number,
  minimumFreeBytes = MIN_FREE_FILESYSTEM_BYTES,
  signal?: AbortSignal,
): Promise<Readonly<{ bytes: number; entries: number }>> {
  throwIfAborted(signal);
  if (
    !isAbsolute(root)
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > MAX_RAW_WORKING_BYTES
    || !Number.isSafeInteger(minimumFreeBytes)
    || minimumFreeBytes < 0
  ) return rawStagingFail("raw export staging budget was invalid");
  const canonicalRoot = await assertPrivateOwnedDirectory(await realpath(root));
  const cacheRoot = join(canonicalRoot, "cli-payload-cache");
  const uid = process.getuid?.();
  if (uid === undefined) {
    return rawStagingFail("raw export staging requires a POSIX user identity");
  }
  const stack = [canonicalRoot];
  let bytes = 0;
  let entries = 0;
  while (stack.length > 0) {
    throwIfAborted(signal);
    const directory = stack.pop();
    if (directory === undefined) break;
    let names: readonly string[];
    try {
      names = (await readdir(directory)).sort();
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      return rawStagingFail("raw export staging could not be inspected safely");
    }
    for (const name of names) {
      throwIfAborted(signal);
      const path = join(directory, name);
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        return rawStagingFail("raw export staging could not be inspected safely");
      }
      entries += 1;
      if (entries > MAX_RAW_WORKING_ENTRIES) {
        return rawStagingFail("raw export staging exceeded its entry budget");
      }
      const allocatedBytes = metadata.blocks * 512;
      const entryBytes = Math.max(metadata.size, allocatedBytes);
      if (
        !Number.isSafeInteger(entryBytes)
        || entryBytes < 0
        || entryBytes > maximumBytes - bytes
      ) return rawStagingFail("raw export staging exceeded its byte budget");
      bytes += entryBytes;
      if (metadata.isSymbolicLink()) {
        await assertSafeCliPayloadCacheSymlink(
          path,
          directory,
          cacheRoot,
          metadata,
          uid,
        );
      } else if (
        metadata.uid !== uid
        || (metadata.mode & 0o022) !== 0
      ) {
        return rawStagingFail(
          "raw export staging contained an unsafe filesystem entry",
        );
      } else if (metadata.isDirectory()) {
        const canonical = await realpath(path).catch(() => null);
        if (
          canonical !== path
          || !canonical.startsWith(`${canonicalRoot}${sep}`)
        ) {
          return rawStagingFail(
            "raw export staging directory changed during inspection",
          );
        }
        stack.push(path);
      } else if (!metadata.isFile() || metadata.nlink !== 1) {
        return rawStagingFail(
          "raw export staging contained an unsafe filesystem entry",
        );
      }
    }
  }
  let filesystem;
  try {
    filesystem = await statfs(canonicalRoot);
  } catch {
    return rawStagingFail(
      "raw export filesystem capacity could not be inspected",
    );
  }
  const availableBytes = filesystem.bavail * filesystem.bsize;
  if (
    !Number.isSafeInteger(availableBytes)
    || availableBytes < minimumFreeBytes
  ) return rawStagingFail("raw export filesystem reserve would be exhausted");
  return Object.freeze({ bytes, entries });
}

async function enforceBeeperRawFilesystemReserve(
  root: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  let filesystem;
  try {
    filesystem = await statfs(root);
  } catch {
    return fail("raw export filesystem capacity could not be inspected");
  }
  throwIfAborted(signal);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  if (
    !Number.isSafeInteger(availableBytes)
    || availableBytes < MIN_FREE_FILESYSTEM_BYTES
  ) return fail("raw export filesystem reserve would be exhausted");
}

/** @internal Exported only for focused process-lifecycle safety tests. */
export async function runExportCli(
  invocation: BeeperExportCliInvocation,
): Promise<BeeperCliInvocationResult> {
  throwIfAborted(invocation.signal);
  if (
    (invocation.workingRoot === undefined)
    !== (invocation.maxWorkingBytes === undefined)
  ) return fail("raw export staging monitor was incompletely configured");
  if (
    invocation.workingRoot !== undefined
    && invocation.maxWorkingBytes !== undefined
  ) {
    try {
      await enforceBeeperRawWorkingBudget(
        invocation.workingRoot,
        invocation.maxWorkingBytes,
        MIN_FREE_FILESYSTEM_BYTES,
        invocation.signal,
      );
    } catch (error) {
      throwIfAborted(invocation.signal);
      if (error instanceof BeeperRawStagingInvariantError) throw error;
      return fail("official export raw staging safety check failed");
    }
  }
  if (invocation.directoryLease !== undefined) {
    updateBeeperMessageLikeMeDirectoryLease(
      invocation.directoryLease,
      "launching",
    );
  }
  let leaseSettlementAttempted = false;
  const settleDirectoryLease = (): void => {
    if (
      invocation.directoryLease === undefined
      || leaseSettlementAttempted
    ) return;
    leaseSettlementAttempted = true;
    updateBeeperMessageLikeMeDirectoryLease(
      invocation.directoryLease,
      "settled",
    );
  };
  const child = (() => {
    try {
      return Bun.spawn([
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
    } catch (error) {
      try {
        settleDirectoryLease();
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          "Beeper export launch and recovery lifecycle settlement both failed",
        );
      }
      throw error;
    }
  })();
  let timedOut = false;
  let cancelled = false;
  let heartbeatFailed = false;
  let workingBudgetFailed = false;
  let workingBudgetInspection: Promise<void> | undefined;
  let filesystemInspection: Promise<void> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | null = null;
  const signalGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The complete child process group already exited.
    }
  };
  if (invocation.directoryLease !== undefined) {
    try {
      updateBeeperMessageLikeMeDirectoryLease(
        invocation.directoryLease,
        "running",
        child.pid,
      );
    } catch (error) {
      signalGroup("SIGKILL");
      let reapError: unknown;
      try {
        await child.exited;
      } catch (childError) {
        reapError = childError;
      }
      let settlementError: unknown;
      try {
        settleDirectoryLease();
      } catch (leaseError) {
        settlementError = leaseError;
      }
      const failures = [error, reapError, settlementError].filter(
        (failure) => failure !== undefined,
      );
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Beeper export recovery lifecycle failed after launch",
        );
      }
      throw error;
    }
  }
  const terminate = (): void => {
    signalGroup("SIGTERM");
    if (forceKill === null) {
      forceKill = setTimeout(() => signalGroup("SIGKILL"), 2_000);
    }
  };
  const inspectWorkingBudget = (): void => {
    if (
      invocation.workingRoot === undefined
      || invocation.maxWorkingBytes === undefined
      || workingBudgetInspection !== undefined
    ) return;
    workingBudgetInspection = (async () => {
      try {
        await enforceBeeperRawWorkingBudget(
          invocation.workingRoot!,
          invocation.maxWorkingBytes!,
          MIN_FREE_FILESYSTEM_BYTES,
          invocation.signal,
        );
      } catch {
        workingBudgetFailed = true;
        terminate();
      }
    })().finally(() => {
      workingBudgetInspection = undefined;
    });
  };
  const inspectFilesystemReserve = (): void => {
    if (invocation.workingRoot === undefined || filesystemInspection !== undefined) return;
    filesystemInspection = (async () => {
      try {
        await enforceBeeperRawFilesystemReserve(
          invocation.workingRoot!,
          invocation.signal,
        );
      } catch {
        workingBudgetFailed = true;
        terminate();
      }
    })().finally(() => {
      filesystemInspection = undefined;
    });
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
  const startedAt = Date.now();
  const heartbeat = invocation.onHeartbeat === undefined
    ? null
    : setInterval(() => {
        try {
          invocation.onHeartbeat?.(
            Math.max(1, Math.floor((Date.now() - startedAt) / 1_000)),
          );
        } catch {
          heartbeatFailed = true;
          terminate();
        }
      }, ACCOUNT_HEARTBEAT_INTERVAL_MS);
  const workingBudgetMonitor = invocation.workingRoot === undefined
    ? null
    : setInterval(() => {
        inspectWorkingBudget();
        inspectFilesystemReserve();
      }, RAW_WORKING_MONITOR_INTERVAL_MS);
  inspectWorkingBudget();
  inspectFilesystemReserve();
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedStream(child.stdout, invocation.maxOutputBytes, "Beeper export stdout"),
      readBoundedStream(
        child.stderr,
        invocation.maxStderrBytes,
        "Beeper export stderr",
      ),
    ]);
    settleDirectoryLease();
    if (workingBudgetInspection !== undefined) await workingBudgetInspection;
    if (filesystemInspection !== undefined) await filesystemInspection;
    if (
      !workingBudgetFailed
      && invocation.workingRoot !== undefined
      && invocation.maxWorkingBytes !== undefined
    ) {
      try {
        await enforceBeeperRawWorkingBudget(
          invocation.workingRoot,
          invocation.maxWorkingBytes,
          MIN_FREE_FILESYSTEM_BYTES,
          invocation.signal,
        );
      } catch {
        workingBudgetFailed = true;
      }
    }
    if (cancelled) return fail("official export was cancelled");
    if (timedOut) return fail("official export timed out");
    if (heartbeatFailed) return fail("export progress reporting failed");
    if (workingBudgetFailed) {
      return fail("official export exceeded its raw staging safety budget");
    }
    return Object.freeze({ exitCode, stdout, stderr });
  } catch (error) {
    signalGroup("SIGKILL");
    let reapError: unknown;
    try {
      await child.exited;
    } catch (childError) {
      reapError = childError;
    }
    let settlementError: unknown;
    try {
      settleDirectoryLease();
    } catch (leaseError) {
      settlementError = leaseError;
    }
    const failures = [error, reapError, settlementError].filter(
      (failure) => failure !== undefined,
    );
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Beeper export and recovery lifecycle settlement both failed",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (heartbeat !== null) clearInterval(heartbeat);
    if (workingBudgetMonitor !== null) clearInterval(workingBudgetMonitor);
    const pendingWorkingBudgetInspection = workingBudgetInspection;
    if (pendingWorkingBudgetInspection !== undefined) {
      await pendingWorkingBudgetInspection;
    }
    const pendingFilesystemInspection = filesystemInspection;
    if (pendingFilesystemInspection !== undefined) {
      await pendingFilesystemInspection;
    }
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

function remainingTimeoutMs(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return fail("official export exceeded its command-wide timeout");
  return Math.max(1, Math.floor(remaining));
}

async function withProgressHeartbeat<T>(
  operation: () => Promise<T>,
  onHeartbeat: ((elapsedSeconds: number) => void) | undefined,
): Promise<T> {
  if (onHeartbeat === undefined) return operation();
  const startedAt = Date.now();
  let heartbeatFailed = false;
  const heartbeat = setInterval(() => {
    try {
      onHeartbeat(Math.max(1, Math.floor((Date.now() - startedAt) / 1_000)));
    } catch {
      heartbeatFailed = true;
    }
  }, ACCOUNT_HEARTBEAT_INTERVAL_MS);
  try {
    const value = await operation();
    if (heartbeatFailed) return fail("export progress reporting failed");
    return value;
  } finally {
    clearInterval(heartbeat);
  }
}

function parseCliJson(stdout: string, label: string): unknown {
  const source = stdout.trim();
  if (source.length === 0) return fail(`${label} omitted JSON output`);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return fail(`${label} returned malformed JSON`);
  }
  try {
    return parseBeeperCliEnvelope(value, label);
  } catch {
    return fail(`${label} returned an invalid success envelope`);
  }
}

async function enumerateAccounts(
  binary: string,
  environment: Readonly<Record<string, string>>,
  deadlineMs: number,
  run: (invocation: BeeperExportCliInvocation) => Promise<BeeperCliInvocationResult>,
  directoryLease: BeeperMessageLikeMeDirectoryLease | undefined,
  signal: AbortSignal | undefined,
  onHeartbeat?: (elapsedSeconds: number) => void,
): Promise<readonly BeeperAccountProjection[]> {
  const timeoutMs = remainingTimeoutMs(deadlineMs);
  const command = planBeeperAccountsListCommand(timeoutMs);
  const result = await run({
    binary,
    arguments: command.argv,
    environment,
    timeoutMs,
    maxOutputBytes: MAX_ACCOUNTS_LIST_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    ...(directoryLease === undefined ? {} : { directoryLease }),
    ...(onHeartbeat === undefined ? {} : { onHeartbeat }),
    ...(signal === undefined ? {} : { signal }),
  });
  throwIfAborted(signal);
  if (result.exitCode !== 0 || result.stderr.trim().length !== 0) {
    return fail("official account enumeration failed");
  }
  try {
    return parseBeeperExportAccounts(parseCliJson(result.stdout, "official account enumeration"));
  } catch {
    return fail("official account enumeration returned an unsupported projection");
  }
}

function accountOutputRealm(
  account: BeeperAccountProjection,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    accountId: account.accountId,
    bridge: account.bridge,
    network: account.network,
    user: Object.freeze({
      id: account.user.id,
      displayName: account.selectorAliases.displayName,
      name: account.selectorAliases.name,
      fullName: account.user.fullName,
      username: account.user.username,
      phoneNumber: account.user.phoneNumber,
      email: account.user.email,
      isSelf: account.user.isSelf,
    }),
  });
}

function outputRealmDigest(accounts: readonly BeeperAccountProjection[]): string {
  return sha256(canonicalJson([...accounts]
    .sort((left, right) => left.accountId.localeCompare(right.accountId))
    .map(accountOutputRealm)));
}

function assertOutputRealm(
  accounts: readonly BeeperAccountProjection[],
  expectedDigest: string,
): void {
  if (outputRealmDigest(accounts) !== expectedDigest) {
    fail("connected Beeper account inventory changed during export");
  }
}

function normalizeOfficialAccountSelector(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s._-]+/gu, "");
}

/** @internal Exported only for pinned-selector safety tests. */
export function assertUniqueOfficialAccountSelector(
  selected: BeeperAccountProjection,
  accounts: readonly BeeperAccountProjection[],
): void {
  const wanted = normalizeOfficialAccountSelector(selected.accountId);
  const matches = accounts.filter((account) => [
    account.accountId,
    account.network,
    account.bridge.type,
    account.bridge.id,
    account.user.id,
    account.user.username,
    account.selectorAliases.displayName,
    account.selectorAliases.name,
    account.user.email,
  ].some((candidate) => normalizeOfficialAccountSelector(candidate) === wanted));
  if (matches.length !== 1 || matches[0]?.accountId !== selected.accountId) {
    fail("one Beeper account ID is ambiguous under the pinned CLI selector rules");
  }
}

async function readCliStoreSnapshot(
  configDirectory: string,
): Promise<BeeperCliStoreSnapshot> {
  const assertLocalDesktopUrl = (value: unknown, label: string): string | undefined => {
    if (value === undefined) return;
    const source = string(value, label, 2_048);
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      return fail(`${label} is no longer a reviewed loopback Desktop URL`);
    }
    const port = Number(parsed.port);
    if (
      parsed.protocol !== "http:"
      || parsed.hostname !== "127.0.0.1"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || !Number.isSafeInteger(port)
      || port < 23_373
      || port > 23_392
    ) return fail(`${label} is no longer a reviewed loopback Desktop URL`);
    return source;
  };
  const storedAuth = (value: unknown, label: string): JsonRecord => {
    const auth = record(value, label);
    exactKeys(auth, ["accessToken", "tokenType"], [
      "clientID",
      "expiresAt",
      "scope",
      "source",
    ], label);
    const accessToken = string(auth.accessToken, `${label}.accessToken`, 64 * 1024);
    if (auth.tokenType !== "Bearer") return fail(`${label}.tokenType is unsupported`);
    const optionalText = (key: "clientID" | "scope", maximum: number): string | undefined =>
      auth[key] === undefined ? undefined : string(auth[key], `${label}.${key}`, maximum);
    const clientID = optionalText("clientID", 2_048);
    const scope = optionalText("scope", 2_048);
    const expiresAt = auth.expiresAt === undefined
      ? undefined
      : timestamp(auth.expiresAt, `${label}.expiresAt`);
    const source = auth.source === undefined
      ? undefined
      : string(auth.source, `${label}.source`, 64);
    if (
      source !== undefined
      && !["desktop-db", "desktop-cache", "desktop-oauth", "remote-oauth", "manual"].includes(source)
    ) return fail(`${label}.source is unsupported`);
    return Object.freeze({
      accessToken,
      tokenType: "Bearer",
      ...(clientID === undefined ? {} : { clientID }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(scope === undefined ? {} : { scope }),
      ...(source === undefined ? {} : { source }),
    });
  };
  const assertPrivateSourceFile = async (path: string, label: string): Promise<void> => {
    const metadata = await lstat(path);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.uid !== process.getuid?.()
      || metadata.nlink !== 1
      || (metadata.mode & 0o077) !== 0
      || await realpath(path) !== path
    ) return fail(`${label} is no longer one private physical file`);
  };
  const configPath = join(configDirectory, "config.json");
  await assertPrivateSourceFile(configPath, "Beeper CLI config");
  const config = record(
    await readOwnedJson(
      configPath,
      configDirectory,
      MAX_BEEPER_CONFIG_BYTES,
      true,
    ),
    "Beeper CLI config",
  );
  exactKeys(
    config,
    [],
    ["auth", "baseURL", "defaultAccount", "defaultTarget"],
    "Beeper CLI config",
  );
  if (config.defaultTarget !== "desktop") {
    return fail("Beeper CLI config no longer selects the fixed Desktop target");
  }
  const configBaseUrl = assertLocalDesktopUrl(
    config.baseURL,
    "Beeper CLI config.baseURL",
  );
  const configAuth = config.auth === undefined
    ? undefined
    : storedAuth(config.auth, "Beeper CLI config.auth");
  const targetsRoot = await assertOwnedDirectory(
    join(configDirectory, "targets"),
    configDirectory,
  );
  const targetPath = join(targetsRoot, "desktop.json");
  await assertPrivateSourceFile(targetPath, "Beeper Desktop target");
  const desktopTarget = record(
    await readOwnedJson(
      targetPath,
      configDirectory,
      MAX_BEEPER_CONFIG_BYTES,
      true,
    ),
    "Beeper Desktop target",
  );
  exactKeys(desktopTarget, ["id", "type", "baseURL"], [
    "auth",
    "dataDir",
    "managed",
    "name",
    "port",
    "profile",
    "runtime",
    "serverEnv",
  ], "Beeper Desktop target");
  if (desktopTarget.id !== "desktop" || desktopTarget.type !== "desktop") {
    return fail("Beeper CLI target no longer identifies the fixed Desktop realm");
  }
  const targetBaseUrl = assertLocalDesktopUrl(
    desktopTarget.baseURL,
    "Beeper Desktop target.baseURL",
  );
  if (targetBaseUrl === undefined) return fail("Beeper Desktop target omitted baseURL");
  if (
    (desktopTarget.managed !== undefined && desktopTarget.managed !== false)
    || desktopTarget.dataDir !== undefined
    || desktopTarget.profile !== undefined
    || desktopTarget.serverEnv !== undefined
  ) return fail("Beeper Desktop target contains an active endpoint override");
  if (desktopTarget.port !== undefined) {
    const port = positiveInteger(
      desktopTarget.port,
      "Beeper Desktop target.port",
      23_392,
    );
    if (port < 23_373) return fail("Beeper Desktop target.port is outside the reviewed range");
  }
  if (desktopTarget.runtime !== undefined) {
    const runtime = record(desktopTarget.runtime, "Beeper Desktop target.runtime");
    exactKeys(runtime, ["install", "port"], [], "Beeper Desktop target.runtime");
    if (runtime.install !== "desktop") {
      return fail("Beeper Desktop target.runtime.install is unsupported");
    }
    const port = positiveInteger(
      runtime.port,
      "Beeper Desktop target.runtime.port",
      23_392,
    );
    if (port < 23_373) {
      return fail("Beeper Desktop target.runtime.port is outside the reviewed range");
    }
  }
  if (desktopTarget.name !== undefined) {
    string(desktopTarget.name, "Beeper Desktop target.name", 2_048);
  }
  const targetAuth = desktopTarget.auth === undefined
    ? undefined
    : storedAuth(desktopTarget.auth, "Beeper Desktop target.auth");
  const effectiveAuth = targetAuth
    ?? (configAuth !== undefined
      && (configBaseUrl === undefined || configBaseUrl === targetBaseUrl)
      ? configAuth
      : undefined);
  if (effectiveAuth === undefined) {
    return fail("Beeper Desktop target has no effective stored access token");
  }
  return Object.freeze({
    config: Object.freeze({
      baseURL: targetBaseUrl,
      defaultTarget: "desktop",
    }),
    desktopTarget: Object.freeze({
      auth: effectiveAuth,
      baseURL: targetBaseUrl,
      id: "desktop",
      managed: false,
      type: "desktop",
    }),
  });
}

async function writePrivateJsonExclusive(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_BEEPER_CONFIG_BYTES) {
    return fail("operation-private Beeper config exceeded its size bound");
  }
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesWritten === 0) return fail("operation-private Beeper config stopped accepting bytes");
      offset += result.bytesWritten;
    }
    await handle.sync();
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.uid !== process.getuid?.()
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
      || metadata.size !== bytes.byteLength
    ) return fail("operation-private Beeper config was not written privately");
  } finally {
    await handle.close();
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || metadata.nlink !== 1) {
    return fail("operation-private Beeper config changed after creation");
  }
}

async function createOperationPrivateBeeperStore(
  root: string,
  snapshot: BeeperCliStoreSnapshot,
  accountId?: string,
): Promise<OperationPrivateBeeperStore> {
  await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(root, PRIVATE_DIRECTORY_MODE);
  const targets = join(root, "targets");
  await mkdir(targets, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(targets, PRIVATE_DIRECTORY_MODE);
  await assertPrivateOwnedDirectory(root);
  await assertPrivateOwnedDirectory(targets, root);
  const config = Object.freeze({
    ...snapshot.config,
    ...(accountId === undefined ? {} : { defaultAccount: accountId }),
  });
  await writePrivateJsonExclusive(join(root, "config.json"), config);
  await writePrivateJsonExclusive(join(targets, "desktop.json"), snapshot.desktopTarget);
  try {
    const path = await validateBeeperCliStore(root);
    const metadata = await lstat(path);
    return Object.freeze({
      path,
      identity: Object.freeze({ device: metadata.dev, inode: metadata.ino }),
    });
  } catch {
    return fail("operation-private Beeper selector store did not validate");
  }
}

async function validateAccountShard(
  rawRoot: string,
  canonicalWorking: string,
  selected: BeeperAccountProjection,
  baselineRealmDigest: string,
  expectedSubject: string,
  signal: AbortSignal | undefined,
): Promise<ValidatedAccountShard> {
  throwIfAborted(signal);
  await chmod(rawRoot, PRIVATE_DIRECTORY_MODE);
  await assertPrivateOwnedDirectory(rawRoot, canonicalWorking);
  const accounts = parseBeeperExportAccounts(await readOwnedJson(
    join(rawRoot, "accounts.json"),
    rawRoot,
    MAX_ACCOUNTS_JSON_BYTES,
    false,
    signal,
  ));
  throwIfAborted(signal);
  if (beeperSubjectFromAccounts(accounts) !== expectedSubject) {
    return fail("official export account did not match the bound auth realm");
  }
  assertOutputRealm(accounts, baselineRealmDigest);
  const manifest = parseManifest(await readOwnedJson(
    join(rawRoot, "manifest.json"),
    rawRoot,
    MAX_ACCOUNTS_JSON_BYTES,
    false,
    signal,
  ));
  const manifestAccounts = parseBeeperExportAccounts(manifest.accounts);
  if (
    manifest.attachmentCount !== 0
    || canonicalJson(manifestAccounts) !== canonicalJson(accounts)
    || outputRealmDigest(manifestAccounts) !== outputRealmDigest(accounts)
  ) return fail("official export manifest did not prove a no-attachment account snapshot");
  const listedValues = array(
    await readOwnedJson(
      join(rawRoot, "chats.json"),
      rawRoot,
      MAX_CHATS_JSON_BYTES,
      false,
      signal,
    ),
    "official export chats",
    MAX_EXPORT_CHATS,
  );
  const listedChats: Array<Pick<BeeperConversationProjection, "id" | "accountId">> = [];
  for (const value of listedValues) {
    throwIfAborted(signal);
    const chat = parseBeeperExportConversation(value, accounts);
    listedChats.push(Object.freeze({ id: chat.id, accountId: chat.accountId }));
  }
  if (manifest.chatCount !== listedChats.length) {
    return fail("official export manifest chat count did not match chats.json");
  }
  if (listedChats.some((chat) => chat.accountId !== selected.accountId)) {
    return fail("official per-account export crossed its selected account boundary");
  }
  await assertExactDirectoryEntries(rawRoot, [
    ...(listedChats.length === 0 ? [] : [".beeper-export-state.json"]),
    "accounts.json",
    "chats",
    "chats.json",
    "manifest.json",
  ], "official export root");
  throwIfAborted(signal);
  const chatSegments = listedChats.map((chat) => safeSegment(chat.id));
  if (new Set(chatSegments).size !== chatSegments.length) {
    return fail("official export chat directory names collided");
  }
  const chatsRoot = await assertOwnedDirectory(join(rawRoot, "chats"), rawRoot);
  await assertExactDirectoryEntries(chatsRoot, chatSegments, "official export chats");
  const stateMessageCounts = listedChats.length === 0
    ? new Map<string, number>()
    : parseOfficialState(await readOwnedJson(
        join(rawRoot, ".beeper-export-state.json"),
        rawRoot,
        MAX_CHATS_JSON_BYTES,
        false,
        signal,
      ), listedChats.map((chat) => chat.id), manifest.createdAt);
  let officialMessageCount = 0;
  const chats: ValidatedShardChat[] = [];
  for (const [index, listedChat] of listedChats.entries()) {
    throwIfAborted(signal);
    const segment = chatSegments[index];
    if (segment === undefined) return fail("official export chat segment disappeared");
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
    const chatPath = join(directory, "chat.json");
    const chatDocument = await readOwnedJsonDocument(
      chatPath,
      rawRoot,
      MAX_CHAT_JSON_BYTES,
      false,
      signal,
    );
    const chat = parseBeeperExportConversation(chatDocument.value, accounts);
    if (
      chat.id !== listedChat.id
      || chat.accountId !== listedChat.accountId
      || chat.accountId !== selected.accountId
    ) return fail("official export chat detail crossed its selected account boundary");
    const expectedMessageCount = stateMessageCounts.get(chat.id);
    if (expectedMessageCount === undefined) {
      return fail("official export chat state disappeared");
    }
    officialMessageCount += expectedMessageCount;
    if (!Number.isSafeInteger(officialMessageCount)) {
      return fail("official export message count overflowed");
    }
    try {
      await unlink(join(directory, "messages.markdown"));
      await unlink(join(directory, "messages.html"));
    } catch {
      return fail("redundant official export renderings could not be removed safely");
    }
    await assertExactDirectoryEntries(directory, [
      "attachments",
      "chat.json",
      "messages.json",
    ], "sanitized official export chat directory");
    chats.push(Object.freeze({
      chat: Object.freeze({ id: chat.id, accountId: chat.accountId }),
      root: rawRoot,
      chatPath,
      chatSha256: chatDocument.sha256,
      messagesPath: join(directory, "messages.json"),
      expectedMessageCount,
      observedAt: manifest.completedAt,
    }));
  }
  if (officialMessageCount !== manifest.messageCount) {
    return fail("official export manifest message count did not match chat state");
  }
  throwIfAborted(signal);
  return Object.freeze({
    accountId: selected.accountId,
    completedAt: manifest.completedAt,
    chats: Object.freeze(chats),
    messageCount: officialMessageCount,
  });
}

async function prepassSelfAliases(
  chats: readonly ValidatedShardChat[],
  accounts: readonly BeeperAccountProjection[],
  accountsById: ReadonlyMap<string, BeeperAccountProjection>,
  maxMessagesJsonBytes: number,
  maxBundleRecords: number,
  maxBundleBytes: number,
  maxParticipantOccurrences: number,
  observedAtByAccount: ReadonlyMap<string, string>,
  signal: AbortSignal | undefined,
  heartbeat: () => void,
  onRefinementPass: ((pass: number) => Promise<void>) | undefined,
): Promise<SelfAliasPrepass> {
  const evidenceSet = (
    collection: Map<string, Set<string>>,
    accountId: string,
  ): Set<string> => {
    let values = collection.get(accountId);
    if (values === undefined) {
      values = new Set();
      collection.set(accountId, values);
    }
    return values;
  };
  type EvidencePass = Readonly<{
    aliasesByAccount: ReadonlyMap<string, ReadonlySet<string>>;
    coveredChats: readonly ValidatedShardChat[];
    evidenceLimitReached: boolean;
    identityConflict: boolean;
    messagesSha256ByPath: ReadonlyMap<string, string>;
    oversizedMessagesPaths: ReadonlySet<string>;
    participantOccurrenceLimitReached: boolean;
  }>;
  type BudgetPass = Readonly<{
    admittedChats: readonly ValidatedShardChat[];
    bundleByteLimitReached: boolean;
    bundleRecordLimitReached: boolean;
    provisionalRecordBytes: number;
    provisionalRecordCount: number;
  }>;
  const boundMessagesSha256ByPath = new Map<string, string>();
  const boundOversizedMessagesPaths = new Set<string>();

  const collectEvidence = async (
    candidateChats: readonly ValidatedShardChat[],
  ): Promise<EvidencePass> => {
    const aliasesByAccount = new Map<string, Set<string>>();
    const peerEvidenceByAccount = new Map<string, Set<string>>();
    const evidenceIdsByAccount = new Map<string, Set<string>>();
    const coveredChats: ValidatedShardChat[] = [];
    const messagesSha256ByPath = new Map<string, string>();
    const oversizedMessagesPaths = new Set<string>();
    let evidenceCount = 0;
    let participantOccurrenceCount = 0;
    for (const account of accounts) {
      if (account.user.isSelf === false) {
        return fail("Beeper account user contradicts its self identity anchor");
      }
      const coordinate = digest([
        "beeper-self-alias-v1",
        account.accountId,
        account.user.id,
      ]);
      evidenceSet(aliasesByAccount, account.accountId).add(coordinate);
      evidenceSet(evidenceIdsByAccount, account.accountId).add(coordinate);
      evidenceCount += 1;
      participantOccurrenceCount += 1;
    }
    if (participantOccurrenceCount > maxParticipantOccurrences) {
      return fail("connected Beeper accounts exceed the participant work bound");
    }
    let evidenceLimitReached = evidenceCount > maxBundleRecords;
    let participantOccurrenceLimitReached = false;
    for (const validated of candidateChats) {
      if (evidenceLimitReached || participantOccurrenceLimitReached) break;
      heartbeat();
      throwIfAborted(signal);
      const chatDocument = await readOwnedJsonDocument(
        validated.chatPath,
        validated.root,
        MAX_CHAT_JSON_BYTES,
        false,
        signal,
      );
      if (chatDocument.sha256 !== validated.chatSha256) {
        return fail("official export chat changed before self-alias prepass");
      }
      const chat = parseBeeperExportConversation(chatDocument.value, accounts);
      if (
        chat.id !== validated.chat.id
        || chat.accountId !== validated.chat.accountId
      ) return fail("official export chat identity changed before self-alias prepass");
      const account = accountsById.get(chat.accountId);
      if (account === undefined) {
        return fail("official export chat references an unknown account");
      }
      const rosterOccurrences = chat.participants.items.length;
      if (rosterOccurrences > maxParticipantOccurrences - participantOccurrenceCount) {
        participantOccurrenceLimitReached = true;
        break;
      }
      const messagesSize = await ownedFileSize(validated.messagesPath, validated.root);
      const priorSha256 = boundMessagesSha256ByPath.get(validated.messagesPath);
      if (messagesSize > maxMessagesJsonBytes) {
        if (priorSha256 !== undefined) {
          return fail("official export messages changed between self-alias passes");
        }
        boundOversizedMessagesPaths.add(validated.messagesPath);
        oversizedMessagesPaths.add(validated.messagesPath);
        participantOccurrenceCount += rosterOccurrences;
        coveredChats.push(validated);
        continue;
      }
      if (boundOversizedMessagesPaths.has(validated.messagesPath)) {
        return fail("official export messages changed between self-alias passes");
      }
      const messagesDocument = await readOwnedJsonDocument(
        validated.messagesPath,
        validated.root,
        maxMessagesJsonBytes,
        false,
        signal,
      );
      if (priorSha256 !== undefined && priorSha256 !== messagesDocument.sha256) {
        return fail("official export messages changed between self-alias passes");
      }
      boundMessagesSha256ByPath.set(validated.messagesPath, messagesDocument.sha256);
      const messages = parseBeeperExportMessages(
        messagesDocument.value,
        chat.accountId,
        chat.id,
        MAX_EXPORT_MESSAGES_PER_CHAT,
      );
      if (messages.length !== validated.expectedMessageCount) {
        return fail("official export chat messages did not match completed state");
      }
      const reactionCount = messages.reduce(
        (count, message) => count + message.reactions.length,
        0,
      );
      const participantOccurrences = rosterOccurrences
        + messages.length
        + reactionCount
        + (chat.type === "single" ? 1 : 0);
      if (
        !Number.isSafeInteger(reactionCount)
        || !Number.isSafeInteger(participantOccurrences)
      ) return fail("official export derived record count overflowed");
      if (participantOccurrences > maxParticipantOccurrences - participantOccurrenceCount) {
        participantOccurrenceLimitReached = true;
        break;
      }
      const positiveEvidence = new Set<string>();
      const peerEvidence = new Set<string>();
      for (const participant of chat.participants.items) {
        const coordinate = digest([
          "beeper-self-alias-v1",
          account.accountId,
          participant.id,
        ]);
        if (participant.isSelf === true) positiveEvidence.add(coordinate);
        if (participant.isSelf === false) peerEvidence.add(coordinate);
      }
      for (const message of messages) {
        (message.isSender ? positiveEvidence : peerEvidence).add(digest([
          "beeper-self-alias-v1",
          account.accountId,
          message.senderId,
        ]));
      }
      const accountEvidenceIds = evidenceSet(evidenceIdsByAccount, account.accountId);
      const candidateEvidence = new Set([...positiveEvidence, ...peerEvidence]);
      let newEvidence = 0;
      for (const sourceId of candidateEvidence) {
        if (!accountEvidenceIds.has(sourceId)) newEvidence += 1;
      }
      if (newEvidence > maxBundleRecords - evidenceCount) {
        evidenceLimitReached = true;
        break;
      }
      const aliases = evidenceSet(aliasesByAccount, account.accountId);
      const peers = evidenceSet(peerEvidenceByAccount, account.accountId);
      for (const sourceId of positiveEvidence) aliases.add(sourceId);
      for (const sourceId of peerEvidence) peers.add(sourceId);
      for (const sourceId of candidateEvidence) accountEvidenceIds.add(sourceId);
      evidenceCount += newEvidence;
      participantOccurrenceCount += participantOccurrences;
      messagesSha256ByPath.set(validated.messagesPath, messagesDocument.sha256);
      coveredChats.push(validated);
    }
    let identityConflict = false;
    for (const [accountId, peerEvidence] of peerEvidenceByAccount) {
      const aliases = aliasesByAccount.get(accountId);
      if (aliases === undefined) {
        return fail("Beeper account self-alias set disappeared");
      }
      if ([...peerEvidence].some((sourceId) => aliases.has(sourceId))) {
        identityConflict = true;
      }
    }
    return Object.freeze({
      aliasesByAccount,
      coveredChats: Object.freeze(coveredChats),
      evidenceLimitReached,
      identityConflict,
      messagesSha256ByPath,
      oversizedMessagesPaths,
      participantOccurrenceLimitReached,
    });
  };

  const planBudget = async (evidence: EvidencePass): Promise<BudgetPass> => {
    const participantFacts = new Map<string, ParticipantFact>();
    const selfParticipantByAccount = new Map<string, string>();
    let recordCount = accounts.length;
    let recordBytes = 0;
    for (const account of accounts) {
      const observedAt = observedAtByAccount.get(account.accountId);
      if (observedAt === undefined) {
        return fail("Beeper account observation time disappeared");
      }
      const self = planningParticipantFact(
        account,
        account.user,
        true,
        evidence.aliasesByAccount,
      );
      participantFacts.set(self.id, self);
      selfParticipantByAccount.set(account.accountId, self.id);
      recordCount += 1;
      const network = normalizeNetwork(account.network, account.bridge.type);
      recordBytes += bundleRecordBytes(accountRecord(
        account,
        network,
        observedAt,
        self.id,
      ));
      recordBytes += bundleRecordBytes(participantRecord(
        self,
        account,
        network,
        observedAt,
      ));
    }
    if (recordCount > maxBundleRecords || recordBytes > maxBundleBytes) {
      return fail("connected Beeper accounts exceed the bounded bundle foundation");
    }
    const admittedChats: ValidatedShardChat[] = [];
    for (const validated of evidence.coveredChats) {
      heartbeat();
      throwIfAborted(signal);
      const messagesSha256 = evidence.messagesSha256ByPath.get(validated.messagesPath);
      if (messagesSha256 === undefined) {
        if (!evidence.oversizedMessagesPaths.has(validated.messagesPath)) {
          return fail("official export message proof disappeared during bundle admission");
        }
        if (
          await ownedFileSize(validated.messagesPath, validated.root)
            <= maxMessagesJsonBytes
        ) return fail("official export messages changed during bundle admission");
        admittedChats.push(validated);
        continue;
      }
      const chatDocument = await readOwnedJsonDocument(
        validated.chatPath,
        validated.root,
        MAX_CHAT_JSON_BYTES,
        false,
        signal,
      );
      if (chatDocument.sha256 !== validated.chatSha256) {
        return fail("official export chat changed during bundle admission");
      }
      const chat = parseBeeperExportConversation(chatDocument.value, accounts);
      if (
        chat.id !== validated.chat.id
        || chat.accountId !== validated.chat.accountId
      ) return fail("official export chat identity changed during bundle admission");
      const account = accountsById.get(chat.accountId);
      if (account === undefined) {
        return fail("official export chat references an unknown account");
      }
      const messagesDocument = await readOwnedJsonDocument(
        validated.messagesPath,
        validated.root,
        maxMessagesJsonBytes,
        false,
        signal,
      );
      if (messagesDocument.sha256 !== messagesSha256) {
        return fail("official export messages changed during bundle admission");
      }
      const messages = parseBeeperExportMessages(
        messagesDocument.value,
        chat.accountId,
        chat.id,
        MAX_EXPORT_MESSAGES_PER_CHAT,
      );
      if (messages.length !== validated.expectedMessageCount) {
        return fail("official export chat messages did not match completed state");
      }
      const selfParticipantId = selfParticipantByAccount.get(account.accountId);
      const selfParticipant = selfParticipantId === undefined
        ? undefined
        : participantFacts.get(selfParticipantId);
      if (selfParticipantId === undefined || selfParticipant === undefined) {
        return fail("Beeper account self participant disappeared");
      }
      const scanParticipantFacts = new Map<string, ParticipantFact>([
        [selfParticipantId, selfParticipant],
      ]);
      const participantIds = new Set<string>();
      const addPlanningFact = (fact: ParticipantFact): void => {
        scanParticipantFacts.set(
          fact.id,
          mergePlanningParticipantFact(scanParticipantFacts.get(fact.id), fact),
        );
        participantIds.add(fact.id);
      };
      for (const participant of chat.participants.items) {
        addPlanningFact(planningParticipantFact(
          account,
          participant,
          participant.isSelf,
          evidence.aliasesByAccount,
        ));
      }
      if (chat.type === "single") participantIds.add(selfParticipantId);
      const messageIds = new Set(messages.map((message) => message.id));
      for (const message of messages) {
        addPlanningFact(planningParticipantFact(account, {
          id: message.senderId,
          fullName: message.senderName,
          phoneNumber: null,
          email: null,
          username: null,
        }, message.isSender, evidence.aliasesByAccount));
        for (const reaction of message.reactions) {
          addPlanningFact(planningParticipantFact(account, {
            id: reaction.participantId,
            fullName: null,
            phoneNumber: null,
            email: null,
            username: null,
          }, null, evidence.aliasesByAccount));
        }
      }
      const reactionCount = messages.reduce(
        (count, message) => count + message.reactions.length,
        0,
      );
      const tombstoneCount = messages.reduce(
        (count, message) => count + (message.isDeleted || message.isHidden ? 1 : 0),
        0,
      );
      const reactionProviderIdNonUniqueGroups = messages.reduce(
        (count, message) => count + new Set(
          message.reactions
            .filter((reaction) => reaction.providerIdNonUnique)
            .map((reaction) => reaction.id),
        ).size,
        0,
      );
      const range = messageTimestampRange(messages);
      const roster = [...participantIds].map((participantId) => {
        const participant = scanParticipantFacts.get(participantId);
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
      const scan: ConversationScan = Object.freeze({
        chat: Object.freeze({
          id: chat.id,
          accountId: chat.accountId,
          lastActivity: chat.lastActivity,
          title: chat.title,
          type: chat.type,
        }),
        root: validated.root,
        messagesPath: validated.messagesPath,
        messagesSha256: messagesDocument.sha256,
        observedAt: validated.observedAt,
        participantIds: Object.freeze([...participantIds].sort()),
        participantFactChanges: Object.freeze([]),
        participantsComplete: !chat.participants.hasMore
          && chat.participants.items.length === chat.participants.total
          && directRosterComplete,
        startedAt: range.first,
        lastMessageAt: range.last,
        messageCount: messages.length,
        reactionCount,
        reactionProviderIdNonUniqueGroups,
        tombstoneCount,
        nonParticipantRecordBytes: 0,
      });
      const network = normalizeNetwork(account.network, account.bridge.type);
      let nonParticipantBytes = bundleRecordBytes(conversationRecord(
        scan,
        account,
        network,
        validated.observedAt,
      ));
      for (const message of messages) {
        nonParticipantBytes += bundleRecordBytes(messageRecord(
          message,
          scan,
          messageIds,
          account,
          evidence.aliasesByAccount,
          network,
          validated.observedAt,
        ));
        for (const reaction of message.reactions) {
          nonParticipantBytes += bundleRecordBytes(reactionRecord(
            reaction,
            message,
            scan,
            account,
            evidence.aliasesByAccount,
            network,
            validated.observedAt,
          ));
        }
        const tombstone = tombstoneRecord(
          message,
          scan,
          account,
          network,
          validated.observedAt,
        );
        if (tombstone !== null) nonParticipantBytes += bundleRecordBytes(tombstone);
      }
      const stagedParticipantFacts = new Map<string, ParticipantFact>();
      let addedParticipants = 0;
      let participantByteDelta = 0;
      for (const participantId of participantIds) {
        const incoming = scanParticipantFacts.get(participantId);
        if (incoming === undefined) {
          return fail("Beeper conversation participant disappeared");
        }
        const current = participantFacts.get(participantId);
        const merged = mergePlanningParticipantFact(current, incoming);
        stagedParticipantFacts.set(participantId, merged);
        if (current === undefined) addedParticipants += 1;
        const mergedBytes = bundleRecordBytes(participantRecord(
          merged,
          account,
          network,
          validated.observedAt,
        ));
        const currentBytes = current === undefined
          ? 0
          : bundleRecordBytes(participantRecord(
            current,
            account,
            network,
            validated.observedAt,
          ));
        participantByteDelta += mergedBytes - currentBytes;
      }
      const candidateRecords = 1
        + messages.length
        + reactionCount
        + tombstoneCount
        + addedParticipants;
      const candidateBytes = nonParticipantBytes + participantByteDelta;
      if (
        !Number.isSafeInteger(candidateRecords)
        || !Number.isSafeInteger(candidateBytes)
        || candidateBytes < 0
      ) return fail("official export derived bundle budget overflowed");
      if (candidateRecords > maxBundleRecords - recordCount) {
        return Object.freeze({
          admittedChats: Object.freeze(admittedChats),
          bundleByteLimitReached: false,
          bundleRecordLimitReached: true,
          provisionalRecordBytes: recordBytes,
          provisionalRecordCount: recordCount,
        });
      }
      if (candidateBytes > maxBundleBytes - recordBytes) {
        return Object.freeze({
          admittedChats: Object.freeze(admittedChats),
          bundleByteLimitReached: true,
          bundleRecordLimitReached: false,
          provisionalRecordBytes: recordBytes,
          provisionalRecordCount: recordCount,
        });
      }
      admittedChats.push(validated);
      recordCount += candidateRecords;
      recordBytes += candidateBytes;
      for (const [participantId, fact] of stagedParticipantFacts) {
        participantFacts.set(participantId, fact);
      }
    }
    return Object.freeze({
      admittedChats: Object.freeze(admittedChats),
      bundleByteLimitReached: false,
      bundleRecordLimitReached: false,
      provisionalRecordBytes: recordBytes,
      provisionalRecordCount: recordCount,
    });
  };

  let candidateChats = chats;
  let bundleByteLimitReached = false;
  let bundleRecordLimitReached = false;
  for (let pass = 0; pass < 16; pass += 1) {
    const evidence = await collectEvidence(candidateChats);
    const budget = await planBudget(evidence);
    bundleByteLimitReached ||= budget.bundleByteLimitReached;
    bundleRecordLimitReached ||= budget.bundleRecordLimitReached;
    if (budget.admittedChats.length === evidence.coveredChats.length) {
      if (evidence.identityConflict) {
        return fail("official export has peer evidence for an account self alias");
      }
      return Object.freeze({
        aliasesByAccount: evidence.aliasesByAccount,
        coveredChats: evidence.coveredChats,
        bundleByteLimitReached,
        bundleRecordLimitReached,
        evidenceLimitReached: evidence.evidenceLimitReached,
        messagesSha256ByPath: evidence.messagesSha256ByPath,
        participantOccurrenceLimitReached:
          evidence.participantOccurrenceLimitReached,
        provisionalRecordBytes: budget.provisionalRecordBytes,
        provisionalRecordCount: budget.provisionalRecordCount,
      });
    }
    await onRefinementPass?.(pass + 1);
    candidateChats = budget.admittedChats;
  }
  return fail("bounded chat prefix did not stabilize");
}

function canonicalParticipantSourceId(
  account: BeeperAccountProjection,
  sourceId: string,
  aliasesByAccount: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const aliases = aliasesByAccount.get(account.accountId);
  if (aliases === undefined) return fail("Beeper account self-alias set disappeared");
  const coordinate = digest(["beeper-self-alias-v1", account.accountId, sourceId]);
  return aliases.has(coordinate) ? account.user.id : sourceId;
}

function upsertParticipant(
  facts: Map<string, ParticipantFact>,
  account: BeeperAccountProjection,
  user: Pick<BeeperUserProjection, "id" | "fullName" | "phoneNumber" | "email" | "username">,
  self: boolean | null,
  aliasesByAccount: ReadonlyMap<string, ReadonlySet<string>>,
): ParticipantFact {
  const sourceId = canonicalParticipantSourceId(account, user.id, aliasesByAccount);
  const id = localId("participant", account.accountId, sourceId);
  const current = facts.get(id);
  const handle = user.phoneNumber ?? user.email ?? user.username;
  if (current !== undefined) {
    if (self !== null && current.isSelf !== null && current.isSelf !== self) {
      return fail("one Beeper participant has conflicting self-direction evidence");
    }
    const updated = Object.freeze({
      ...current,
      displayName: current.displayName ?? user.fullName,
      handle: current.handle ?? handle,
      isSelf: current.isSelf ?? self,
    });
    if (
      updated.displayName === current.displayName
      && updated.handle === current.handle
      && updated.isSelf === current.isSelf
    ) return current;
    facts.set(id, updated);
    return updated;
  }
  const created: ParticipantFact = Object.freeze({
    id,
    accountId: localId("account", account.accountId),
    providerId: providerId("participant", account.accountId, sourceId),
    displayName: user.fullName,
    handle,
    isSelf: self,
  });
  facts.set(id, created);
  return created;
}

function mergeParticipantFact(
  current: ParticipantFact | undefined,
  incoming: ParticipantFact,
): ParticipantFact {
  if (current === undefined) return incoming;
  if (
    current.id !== incoming.id
    || current.accountId !== incoming.accountId
    || current.providerId !== incoming.providerId
  ) return fail("one Beeper participant has conflicting source coordinates");
  if (
    current.isSelf !== null
    && incoming.isSelf !== null
    && current.isSelf !== incoming.isSelf
  ) return fail("one Beeper participant has conflicting self-direction evidence");
  const merged = Object.freeze({
    ...current,
    displayName: current.displayName ?? incoming.displayName,
    handle: current.handle ?? incoming.handle,
    isSelf: current.isSelf ?? incoming.isSelf,
  });
  return merged.displayName === current.displayName
      && merged.handle === current.handle
      && merged.isSelf === current.isSelf
    ? current
    : merged;
}

function planningParticipantFact(
  account: BeeperAccountProjection,
  user: Pick<BeeperUserProjection, "id" | "fullName" | "phoneNumber" | "email" | "username">,
  self: boolean | null,
  aliasesByAccount: ReadonlyMap<string, ReadonlySet<string>>,
): ParticipantFact {
  const sourceId = canonicalParticipantSourceId(account, user.id, aliasesByAccount);
  return Object.freeze({
    id: localId("participant", account.accountId, sourceId),
    accountId: localId("account", account.accountId),
    providerId: providerId("participant", account.accountId, sourceId),
    displayName: user.fullName,
    handle: user.phoneNumber ?? user.email ?? user.username,
    isSelf: self,
  });
}

function mergePlanningParticipantFact(
  current: ParticipantFact | undefined,
  incoming: ParticipantFact,
): ParticipantFact {
  if (current === undefined) return incoming;
  if (
    current.id !== incoming.id
    || current.accountId !== incoming.accountId
    || current.providerId !== incoming.providerId
  ) return fail("one Beeper participant has conflicting source coordinates");
  return Object.freeze({
    ...current,
    displayName: current.displayName ?? incoming.displayName,
    handle: current.handle ?? incoming.handle,
    isSelf: current.isSelf !== null
        && incoming.isSelf !== null
        && current.isSelf !== incoming.isSelf
      ? false
      : current.isSelf ?? incoming.isSelf,
  });
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
  aliasesByAccount: ReadonlyMap<string, ReadonlySet<string>>,
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
    senderParticipantId: localId(
      "participant",
      account.accountId,
      canonicalParticipantSourceId(account, message.senderId, aliasesByAccount),
    ),
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
  aliasesByAccount: ReadonlyMap<string, ReadonlySet<string>>,
  network: string,
  observedAt: string,
): BeeperMessageLikeMeReaction {
  const participantSourceId = canonicalParticipantSourceId(
    account,
    reaction.participantId,
    aliasesByAccount,
  );
  const id = localId(
    "reaction",
    account.accountId,
    scan.chat.id,
    message.id,
    reaction.id,
    reaction.participantId,
    reaction.reactionKey,
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
        reaction.participantId,
        reaction.reactionKey,
      ),
      providerRevision: null,
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
    participantId: localId("participant", account.accountId, participantSourceId),
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

async function removePrivateOwnedDirectory(
  path: string,
  root: string,
  expected: PrivateDirectoryIdentity,
): Promise<void> {
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    return fail("private export cleanup escaped its owned root");
  }
  try {
    removePrivateDirectoryTree(path, Object.freeze({
      device: String(expected.device),
      inode: String(expected.inode),
    }));
  } catch {
    return fail("private export directory could not be removed from quarantine safely");
  }
}

/**
 * Creates a single-use source for the private bundle sink. The pinned official
 * CLI paginates one operation-private account shard at a time. Wrench validates
 * every completed shard, reports only ordinal progress, and projects all shards
 * in one deterministic global conversation order.
 */
export function createBeeperMessageLikeMeSource(
  request: BeeperMessageLikeMeSourceRequest,
): BeeperMessageLikeMeExportSource {
  const auth = requireAuth(request.auth);
  const limits = parseLimits(request.limits);
  let consumed = false;
  let completion: unknown;
  let disposeWorking: (() => Promise<void>) | undefined;
  let disposed = false;
  let disposalInFlight: Promise<void> | undefined;
  let progressHeartbeat: ReturnType<typeof setInterval> | undefined;
  let progressHeartbeatFailed = false;
  const stopProgressHeartbeat = (): void => {
    if (progressHeartbeat !== undefined) clearInterval(progressHeartbeat);
    progressHeartbeat = undefined;
  };
  const assertProgressHeartbeat = (): void => {
    if (progressHeartbeatFailed) return fail("export progress reporting failed");
  };

  const records = (async function* (): AsyncGenerator<BeeperMessageLikeMeRecord> {
    if (consumed) return fail("record stream is single-use");
    consumed = true;
    throwIfAborted(request.signal);
    request.onProgress?.(Object.freeze({ phase: "preparing" }));
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
    const maxParticipantOccurrences =
      request.dependencies?.maxParticipantOccurrences === undefined
        ? MAX_PARTICIPANT_OCCURRENCES
        : positiveInteger(
            request.dependencies.maxParticipantOccurrences,
            "test maxParticipantOccurrences",
            MAX_PARTICIPANT_OCCURRENCES,
          );
    if (!isAbsolute(binary)) return fail("Beeper CLI binary path must be absolute");
    const customCreateWorking = request.dependencies?.createWorkingDirectory;
    const customRemoveWorking = request.dependencies?.removeWorkingDirectory;
    if ((customCreateWorking === undefined) !== (customRemoveWorking === undefined)) {
      return fail("test working-directory create and remove seams must be supplied together");
    }
    const createWorking = customCreateWorking
      ?? (() => mkdtemp(join(tmpdir(), "wrench-beeper-message-like-me-")));
    const working = await createWorking();
    let canonicalWorking: string;
    try {
      if (!isAbsolute(working)) return fail("working directory must be absolute");
      await chmod(working, PRIVATE_DIRECTORY_MODE);
      canonicalWorking = await assertPrivateOwnedDirectory(await realpath(working));
    } catch (error) {
      if (customCreateWorking === undefined && isAbsolute(working)) {
        try {
          await rmdir(working);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Beeper export working-directory setup and cleanup both failed",
          );
        }
      }
      throw error;
    }
    const workingMetadata = await lstat(canonicalWorking);
    const workingIdentity = Object.freeze({
      device: workingMetadata.dev,
      inode: workingMetadata.ino,
    });
    let workingLease: BeeperMessageLikeMeDirectoryLease | undefined;
    if (customCreateWorking === undefined) {
      try {
        workingLease = await createBeeperMessageLikeMeDirectoryLease({
          role: "raw-working",
          path: canonicalWorking,
          recoverAfterMs:
            Date.now() + limits.timeoutMs + RAW_WORKING_RECOVERY_GRACE_MS,
          environment,
        });
      } catch (error) {
        try {
          await removePrivateOwnedDirectory(
            canonicalWorking,
            canonicalWorking,
            workingIdentity,
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Beeper export recovery setup and empty-directory cleanup both failed",
          );
        }
        throw error;
      }
    }
    disposeWorking = async () => {
      if (customRemoveWorking === undefined) {
        await removePrivateOwnedDirectory(
          canonicalWorking,
          canonicalWorking,
          workingIdentity,
        );
        if (workingLease !== undefined) {
          releaseBeeperMessageLikeMeDirectoryLease(workingLease);
        }
        return;
      }
      const current = await lstat(canonicalWorking);
      if (
        !current.isDirectory()
        || current.isSymbolicLink()
        || current.uid !== process.getuid?.()
        || (current.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
        || current.dev !== workingIdentity.device
        || current.ino !== workingIdentity.inode
        || await realpath(canonicalWorking) !== canonicalWorking
      ) return fail("private export working directory changed before cleanup");
      await customRemoveWorking(canonicalWorking);
      try {
        await lstat(canonicalWorking);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
      }
      return fail("private export working directory survived cleanup");
    };
    const cacheDirectory = resolve(canonicalWorking, "cli-payload-cache");
    const shardsDirectory = resolve(canonicalWorking, "account-shards");
    const selectorsDirectory = resolve(canonicalWorking, "account-selectors");
    await mkdir(cacheDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(cacheDirectory, PRIVATE_DIRECTORY_MODE);
    await mkdir(shardsDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(shardsDirectory, PRIVATE_DIRECTORY_MODE);
    await mkdir(selectorsDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(selectorsDirectory, PRIVATE_DIRECTORY_MODE);
    await assertPrivateOwnedDirectory(cacheDirectory, canonicalWorking);
    await assertPrivateOwnedDirectory(shardsDirectory, canonicalWorking);
    await assertPrivateOwnedDirectory(selectorsDirectory, canonicalWorking);
    {
      const run = request.dependencies?.runCli ?? runExportCli;
      const deadlineMs = Date.now() + limits.timeoutMs;
      const storeSnapshot = await readCliStoreSnapshot(configDirectory);
      const inventoryStore = await createOperationPrivateBeeperStore(
        resolve(selectorsDirectory, "inventory"),
        storeSnapshot,
      );
      const baseEnvironment = environmentForExport(inventoryStore.path, cacheDirectory);
      const accounts = await enumerateAccounts(
        binary,
        baseEnvironment,
        deadlineMs,
        run,
        workingLease,
        request.signal,
        (elapsedSeconds) => request.onProgress?.(Object.freeze({
          phase: "accounts-progress",
          stage: "discovering",
          elapsedSeconds,
        })),
      );
      if (beeperSubjectFromAccounts(accounts) !== auth.subject) {
        return fail("official export account did not match the bound auth realm");
      }
      const baselineRealmDigest = outputRealmDigest(accounts);
      const orderedAccounts = [...accounts].sort((left, right) => {
        const leftKey = digest([left.accountId]);
        const rightKey = digest([right.accountId]);
        return leftKey.localeCompare(rightKey) || left.accountId.localeCompare(right.accountId);
      });
      for (const account of orderedAccounts) {
        assertUniqueOfficialAccountSelector(account, accounts);
      }
      request.onProgress?.(Object.freeze({
        phase: "accounts-discovered",
        accounts: orderedAccounts.length,
      }));

      const shards: ValidatedAccountShard[] = [];
      const accountObservedAt = new Map<string, string>();
      const effectiveChatLimit = limits.limitChats ?? MAX_EXPORT_CHATS;
      const effectiveMessageLimit = limits.limitMessages
        ?? MAX_EXPORT_MESSAGES_PER_CHAT;
      let remainingChats = effectiveChatLimit;
      let cumulativeChats = 0;
      let cumulativeMessages = 0;
      for (const [index, account] of orderedAccounts.entries()) {
        throwIfAborted(request.signal);
        const ordinal = index + 1;
        if (remainingChats === 0) {
          request.onProgress?.(Object.freeze({
            phase: "account-skipped",
            account: ordinal,
            accounts: orderedAccounts.length,
            reason: "chat-limit-reached",
          }));
          continue;
        }
        const ordinalSegment = `account-${String(ordinal).padStart(3, "0")}`;
        const selectorRoot = resolve(selectorsDirectory, ordinalSegment);
        const shardRoot = resolve(shardsDirectory, ordinalSegment);
        const selectorStore = await createOperationPrivateBeeperStore(
          selectorRoot,
          storeSnapshot,
          account.accountId,
        );
        await mkdir(shardRoot, { mode: PRIVATE_DIRECTORY_MODE });
        await chmod(shardRoot, PRIVATE_DIRECTORY_MODE);
        await assertPrivateOwnedDirectory(shardRoot, canonicalWorking);
        request.onProgress?.(Object.freeze({
          phase: "account-started",
          account: ordinal,
          accounts: orderedAccounts.length,
        }));
        const timeoutMs = remainingTimeoutMs(deadlineMs);
        const arguments_ = planBeeperMessageLikeMeExportCommand({
          outputDirectory: shardRoot,
          limitChats: remainingChats,
          limitMessages: effectiveMessageLimit,
          maxParticipants: limits.maxParticipants,
        }, timeoutMs);
        const result = await run({
          binary,
          arguments: arguments_,
          environment: environmentForExport(selectorStore.path, cacheDirectory),
          timeoutMs,
          maxOutputBytes: MAX_STDOUT_BYTES,
          maxStderrBytes: MAX_STDERR_BYTES,
          workingRoot: canonicalWorking,
          maxWorkingBytes: MAX_RAW_WORKING_BYTES,
          ...(workingLease === undefined ? {} : { directoryLease: workingLease }),
          onHeartbeat: (elapsedSeconds) => request.onProgress?.(Object.freeze({
            phase: "account-progress",
            account: ordinal,
            accounts: orderedAccounts.length,
            elapsedSeconds,
          })),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        throwIfAborted(request.signal);
        if (result.exitCode !== 0 || result.stderr.trim().length !== 0) {
          return fail("official read-only export failed");
        }
        request.onProgress?.(Object.freeze({
          phase: "account-validating",
          account: ordinal,
          accounts: orderedAccounts.length,
          elapsedSeconds: 0,
        }));
        const shard = await withProgressHeartbeat(
          () => validateAccountShard(
            shardRoot,
            canonicalWorking,
            account,
            baselineRealmDigest,
            auth.subject,
            request.signal,
          ),
          request.onProgress === undefined
            ? undefined
            : (elapsedSeconds) => request.onProgress?.(Object.freeze({
                phase: "account-validating",
                account: ordinal,
                accounts: orderedAccounts.length,
                elapsedSeconds,
              })),
        );
        await removePrivateOwnedDirectory(
          selectorRoot,
          canonicalWorking,
          selectorStore.identity,
        );
        shards.push(shard);
        accountObservedAt.set(account.accountId, shard.completedAt);
        if (shard.chats.length > remainingChats) {
          return fail("official per-account export exceeded its allocated global chat budget");
        }
        cumulativeChats += shard.chats.length;
        cumulativeMessages += shard.messageCount;
        if (
          !Number.isSafeInteger(cumulativeChats)
          || !Number.isSafeInteger(cumulativeMessages)
        ) return fail("official export aggregate counts overflowed");
        remainingChats -= shard.chats.length;
        request.onProgress?.(Object.freeze({
          phase: "account-completed",
          account: ordinal,
          accounts: orderedAccounts.length,
          chats: cumulativeChats,
          messages: cumulativeMessages,
        }));
      }
      request.onProgress?.(Object.freeze({
        phase: "accounts-verifying",
        accounts: orderedAccounts.length,
      }));
      const finalAccounts = await enumerateAccounts(
        binary,
        baseEnvironment,
        deadlineMs,
        run,
        workingLease,
        request.signal,
        (elapsedSeconds) => request.onProgress?.(Object.freeze({
          phase: "accounts-progress",
          stage: "verifying",
          elapsedSeconds,
        })),
      );
      if (beeperSubjectFromAccounts(finalAccounts) !== auth.subject) {
        return fail("official export account did not match the bound auth realm");
      }
      assertOutputRealm(finalAccounts, baselineRealmDigest);
      await removePrivateOwnedDirectory(
        resolve(selectorsDirectory, "inventory"),
        canonicalWorking,
        inventoryStore.identity,
      );
      const finalObservedAt = new Date().toISOString();
      for (const account of accounts) {
        accountObservedAt.set(
          account.accountId,
          accountObservedAt.get(account.accountId) ?? finalObservedAt,
        );
      }
      const observedAtForAccount = (accountId: string): string => {
        const value = accountObservedAt.get(accountId);
        if (value === undefined) return fail("Beeper account observation time disappeared");
        return value;
      };
      const validatedChats = shards.flatMap((shard) => shard.chats);
      request.onProgress?.(Object.freeze({
        phase: "conversion-started",
        accounts: orderedAccounts.length,
        chats: cumulativeChats,
        messages: cumulativeMessages,
      }));
      if (request.onProgress !== undefined) {
        const conversionStartedAt = Date.now();
        progressHeartbeat = setInterval(() => {
          try {
            request.onProgress?.(Object.freeze({
              phase: "conversion-progress",
              elapsedSeconds: Math.max(
                1,
                Math.floor((Date.now() - conversionStartedAt) / 1_000),
              ),
            }));
          } catch {
            progressHeartbeatFailed = true;
          }
        }, ACCOUNT_HEARTBEAT_INTERVAL_MS);
      }
      const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
      const allListedChatEntries = [...validatedChats].sort((left, right) =>
        localId("conversation", left.chat.accountId, left.chat.id).localeCompare(
          localId("conversation", right.chat.accountId, right.chat.id),
        ));
      const selfAliasPrepass = await prepassSelfAliases(
        allListedChatEntries,
        accounts,
        accountsById,
        maxMessagesJsonBytes,
        maxBundleRecords,
        maxBundleBytes,
        maxParticipantOccurrences,
        accountObservedAt,
        request.signal,
        assertProgressHeartbeat,
        request.dependencies?.onSelfAliasRefinementPass,
      );
      const aliasesByAccount = selfAliasPrepass.aliasesByAccount;

      const participantFacts = new Map<string, ParticipantFact>();
      const selfParticipantByAccount = new Map<string, string>();
      for (const account of accounts) {
        const self = upsertParticipant(
          participantFacts,
          account,
          account.user,
          true,
          aliasesByAccount,
        );
        selfParticipantByAccount.set(account.accountId, self.id);
      }

      const scans: ConversationScan[] = [];
      let observedFrom: string | null = null;
      let observedThrough: string | null = null;
      let participantRosterIncomplete = false;
      let messageLimitReached = false;
      let oversizedChatSkipped = false;
      let scannedRecordCount = accounts.length + selfParticipantByAccount.size;
      const scannedParticipantIds = new Set(selfParticipantByAccount.values());
      let scanRecordBudgetExhausted = false;
      const listedChatEntries = selfAliasPrepass.coveredChats;
      for (const {
        chat: validatedChat,
        root: shardRoot,
        chatPath,
        chatSha256,
        messagesPath,
        expectedMessageCount,
        observedAt,
      } of listedChatEntries) {
        assertProgressHeartbeat();
        throwIfAborted(request.signal);
        const chatDocument = await readOwnedJsonDocument(
          chatPath,
          shardRoot,
          MAX_CHAT_JSON_BYTES,
          false,
          request.signal,
        );
        if (chatDocument.sha256 !== chatSha256) {
          return fail("official export chat changed between validated passes");
        }
        const chat = parseBeeperExportConversation(chatDocument.value, accounts);
        if (
          chat.id !== validatedChat.id
          || chat.accountId !== validatedChat.accountId
        ) return fail("official export chat identity changed between validated passes");
        const account = accountsById.get(chat.accountId);
        if (account === undefined) return fail("official export chat references an unknown account");
        if (
          expectedMessageCount >= effectiveMessageLimit
        ) messageLimitReached = true;
        const prepassMessagesSha256 = selfAliasPrepass.messagesSha256ByPath.get(messagesPath);
        if (await ownedFileSize(messagesPath, shardRoot) > maxMessagesJsonBytes) {
          if (prepassMessagesSha256 !== undefined) {
            return fail("official export messages changed after self-alias prepass");
          }
          oversizedChatSkipped = true;
          continue;
        }
        if (prepassMessagesSha256 === undefined) {
          return fail("official export self-alias message proof disappeared");
        }
        const messagesDocument = await readOwnedJsonDocument(
          messagesPath,
          shardRoot,
          maxMessagesJsonBytes,
          false,
          request.signal,
        );
        if (messagesDocument.sha256 !== prepassMessagesSha256) {
          return fail("official export messages changed after self-alias prepass");
        }
        const messages = parseBeeperExportMessages(
          messagesDocument.value,
          chat.accountId,
          chat.id,
          MAX_EXPORT_MESSAGES_PER_CHAT,
        );
        if (messages.length !== expectedMessageCount) {
          return fail("official export chat messages did not match completed state");
        }
        if (
          scanRecordBudgetExhausted
          || expectedMessageCount + 1 > maxBundleRecords - scannedRecordCount
        ) {
          scanRecordBudgetExhausted = true;
          continue;
        }
        const selfParticipantId = selfParticipantByAccount.get(account.accountId);
        if (selfParticipantId === undefined) {
          return fail("Beeper account self participant disappeared");
        }
        const selfParticipant = participantFacts.get(selfParticipantId);
        if (selfParticipant === undefined) {
          return fail("Beeper account self participant disappeared");
        }
        const scanParticipantFacts = new Map<string, ParticipantFact>([
          [selfParticipantId, selfParticipant],
        ]);
        const participantIds = new Set<string>();
        for (const participant of chat.participants.items) {
          participantIds.add(upsertParticipant(
            scanParticipantFacts,
            account,
            participant,
            participant.isSelf,
            aliasesByAccount,
          ).id);
        }
        if (chat.type === "single") {
          participantIds.add(selfParticipantId);
        }
        const messageIds = new Set(messages.map((message) => message.id));
        const reactionCount = messages.reduce(
          (count, message) => count + message.reactions.length,
          0,
        );
        const reactionProviderIdNonUniqueGroups = messages.reduce(
          (count, message) => count + new Set(
            message.reactions
              .filter((reaction) => reaction.providerIdNonUnique)
              .map((reaction) => reaction.id),
          ).size,
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
          participantIds.add(upsertParticipant(scanParticipantFacts, account, {
            id: message.senderId,
            fullName: message.senderName,
            phoneNumber: null,
            email: null,
            username: null,
          }, message.isSender, aliasesByAccount).id);
          for (const reaction of message.reactions) {
            participantIds.add(upsertParticipant(scanParticipantFacts, account, {
              id: reaction.participantId,
              fullName: null,
              phoneNumber: null,
              email: null,
              username: null,
            }, null, aliasesByAccount).id);
          }
        }
        const newlySeenParticipantIds = [...participantIds].filter(
          (participantId) => !scannedParticipantIds.has(participantId),
        );
        const scanRecordCount = 1
          + messages.length
          + reactionCount
          + tombstoneCount
          + newlySeenParticipantIds.length;
        if (scanRecordCount > maxBundleRecords - scannedRecordCount) {
          scanRecordBudgetExhausted = true;
          continue;
        }
        scannedRecordCount += scanRecordCount;
        for (const participantId of newlySeenParticipantIds) {
          scannedParticipantIds.add(participantId);
        }
        const range = messageTimestampRange(messages);
        if (range.first !== null && (observedFrom === null || range.first < observedFrom)) {
          observedFrom = range.first;
        }
        if (range.last !== null && (observedThrough === null || range.last > observedThrough)) {
          observedThrough = range.last;
        }
        const roster = [...participantIds].map((participantId) => {
          const participant = scanParticipantFacts.get(participantId);
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
          chat: Object.freeze({
            id: chat.id,
            accountId: chat.accountId,
            lastActivity: chat.lastActivity,
            title: chat.title,
            type: chat.type,
          }),
          root: shardRoot,
          messagesPath,
          messagesSha256: messagesDocument.sha256,
          observedAt,
          participantIds: Object.freeze([...participantIds].sort()),
          participantFactChanges: Object.freeze([...participantIds]
            .sort()
            .map((participantId) => {
              const fact = scanParticipantFacts.get(participantId);
              if (fact === undefined) {
                return fail("Beeper conversation participant disappeared");
              }
              return fact;
            })),
          participantsComplete,
          startedAt: range.first,
          lastMessageAt: range.last,
          messageCount: messages.length,
          reactionCount,
          reactionProviderIdNonUniqueGroups,
          tombstoneCount,
          nonParticipantRecordBytes: 0,
        });
        const network = normalizeNetwork(account.network, account.bridge.type);
        let nonParticipantRecordBytes = bundleRecordBytes(
          conversationRecord(scanDraft, account, network, observedAt),
        );
        for (const message of messages) {
          nonParticipantRecordBytes += bundleRecordBytes(
            messageRecord(
              message,
              scanDraft,
              messageIds,
              account,
              aliasesByAccount,
              network,
              observedAt,
            ),
          );
          for (const reaction of message.reactions) {
            nonParticipantRecordBytes += bundleRecordBytes(reactionRecord(
              reaction,
              message,
              scanDraft,
              account,
              aliasesByAccount,
              network,
              observedAt,
            ));
          }
          const tombstone = tombstoneRecord(
            message,
            scanDraft,
            account,
            network,
            observedAt,
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
      }
      const orderedScans = [...scans].sort((left, right) =>
        localId("conversation", left.chat.accountId, left.chat.id).localeCompare(
          localId("conversation", right.chat.accountId, right.chat.id),
        ));
      const selectedParticipantFacts = new Map(participantFacts);
      const selectedParticipantIds = new Set(selectedParticipantFacts.keys());
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
          observedAtForAccount(account.accountId),
          selfParticipantId,
        ));
        const selfFact = participantFacts.get(selfParticipantId);
        if (selfFact === undefined) return fail("Beeper account self participant disappeared");
        selectedRecordBytes += bundleRecordBytes(participantRecord(
          selfFact,
          account,
          network,
          observedAtForAccount(account.accountId),
        ));
      }
      let bundleRecordLimitReached = selfAliasPrepass.bundleRecordLimitReached;
      let bundleByteLimitReached = selfAliasPrepass.bundleByteLimitReached;
      for (const scan of orderedScans) {
        const account = accountsById.get(scan.chat.accountId);
        if (account === undefined) {
          return fail("selected participant source identity disappeared");
        }
        const expectedParticipantAccountId = localId("account", account.accountId);
        const stagedParticipantFacts = new Map<string, ParticipantFact>();
        for (const incoming of scan.participantFactChanges) {
          if (incoming.accountId !== expectedParticipantAccountId) {
            return fail("selected participant source identity changed accounts");
          }
          const current = stagedParticipantFacts.get(incoming.id)
            ?? selectedParticipantFacts.get(incoming.id);
          stagedParticipantFacts.set(
            incoming.id,
            mergeParticipantFact(current, incoming),
          );
        }
        let addedParticipants = 0;
        let participantByteDelta = 0;
        for (const [participantId, fact] of stagedParticipantFacts) {
          const current = selectedParticipantFacts.get(participantId);
          if (current === undefined) addedParticipants += 1;
          const factBytes = bundleRecordBytes(participantRecord(
            fact,
            account,
            normalizeNetwork(account.network, account.bridge.type),
            observedAtForAccount(account.accountId),
          ));
          const currentBytes = current === undefined
            ? 0
            : bundleRecordBytes(participantRecord(
              current,
              account,
              normalizeNetwork(account.network, account.bridge.type),
              observedAtForAccount(account.accountId),
            ));
          participantByteDelta += factBytes - currentBytes;
        }
        const scanRecords = 1
          + scan.messageCount
          + scan.reactionCount
          + scan.tombstoneCount
          + addedParticipants;
        const scanBytes = scan.nonParticipantRecordBytes + participantByteDelta;
        if (!Number.isSafeInteger(scanBytes) || scanBytes < 0) {
          return fail("official export derived record bytes overflowed");
        }
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
        for (const [participantId, fact] of stagedParticipantFacts) {
          selectedParticipantFacts.set(participantId, fact);
        }
        for (const participantId of scan.participantIds) {
          selectedParticipantIds.add(participantId);
        }
      }
      if (
        scanRecordBudgetExhausted
        || selectedScans.length !== orderedScans.length
      ) return fail("bounded chat prefix exceeded its conservative admission proof");
      if (
        selectedRecordCount > selfAliasPrepass.provisionalRecordCount
        || selectedRecordBytes > selfAliasPrepass.provisionalRecordBytes
      ) return fail("exact bundle exceeded its provisional admission proof");
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
      const validatedReactionProviderIdNonUnique = selectedScans.some(
        (scan) => scan.reactionProviderIdNonUniqueGroups > 0,
      );

      for (const account of [...accounts].sort((left, right) =>
        left.accountId.localeCompare(right.accountId))) {
        const selfParticipantId = selfParticipantByAccount.get(account.accountId);
        if (selfParticipantId === undefined) return fail("Beeper account has no self participant");
        yield accountRecord(
          account,
          normalizeNetwork(account.network, account.bridge.type),
          observedAtForAccount(account.accountId),
          selfParticipantId,
        );
      }
      for (const fact of [...selectedParticipantFacts.values()]
        .filter((candidate) => selectedParticipantIds.has(candidate.id))
        .sort((left, right) => left.id.localeCompare(right.id))) {
        const account = accounts.find((candidate) =>
          localId("account", candidate.accountId) === fact.accountId);
        if (account === undefined) return fail("participant account disappeared");
        yield participantRecord(
          fact,
          account,
          normalizeNetwork(account.network, account.bridge.type),
          observedAtForAccount(account.accountId),
        );
      }
      let emittedReactionProviderIdNonUnique = false;
      for (const scan of selectedScans) {
        assertProgressHeartbeat();
        const account = accountsById.get(scan.chat.accountId);
        if (account === undefined) return fail("conversation account disappeared");
        const network = normalizeNetwork(account.network, account.bridge.type);
        yield conversationRecord(scan, account, network, scan.observedAt);
        const messagesDocument = await readOwnedJsonDocument(
          scan.messagesPath,
          scan.root,
          maxMessagesJsonBytes,
          false,
          request.signal,
        );
        if (messagesDocument.sha256 !== scan.messagesSha256) {
          return fail("official export messages changed between validated passes");
        }
        const messages = parseBeeperExportMessages(
          messagesDocument.value,
          scan.chat.accountId,
          scan.chat.id,
          MAX_EXPORT_MESSAGES_PER_CHAT,
        );
        if (messages.length !== scan.messageCount) {
          return fail("official export message count changed between validated passes");
        }
        const reactionCount = messages.reduce(
          (count, message) => count + message.reactions.length,
          0,
        );
        const reactionProviderIdNonUniqueGroups = messages.reduce(
          (count, message) => count + new Set(
            message.reactions
              .filter((reaction) => reaction.providerIdNonUnique)
              .map((reaction) => reaction.id),
          ).size,
          0,
        );
        if (
          reactionCount !== scan.reactionCount
          || reactionProviderIdNonUniqueGroups
            !== scan.reactionProviderIdNonUniqueGroups
        ) {
          return fail("official export reaction identity changed between validated passes");
        }
        emittedReactionProviderIdNonUnique ||= reactionProviderIdNonUniqueGroups > 0;
        const messageIds = new Set(messages.map((message) => message.id));
        for (const message of messages) {
          yield messageRecord(
            message,
            scan,
            messageIds,
            account,
            aliasesByAccount,
            network,
            scan.observedAt,
          );
          for (const reaction of message.reactions) {
            yield reactionRecord(
              reaction,
              message,
              scan,
              account,
              aliasesByAccount,
              network,
              scan.observedAt,
            );
          }
          const tombstone = tombstoneRecord(
            message,
            scan,
            account,
            network,
            scan.observedAt,
          );
          if (tombstone !== null) yield tombstone;
        }
      }
      if (
        emittedReactionProviderIdNonUnique
        !== validatedReactionProviderIdNonUnique
      ) return fail("official export reaction identity changed between validated passes");

      const warnings = new Set([
        "attachments-metadata-only",
        "remote-history-not-claimed",
        "connected-account-backfill-coverage-unknown",
        "sequential-account-snapshot",
      ]);
      const chatLimitReached = cumulativeChats >= effectiveChatLimit;
      const hardChatLimitReached = chatLimitReached && limits.limitChats === null;
      const hardMessageLimitReached = messageLimitReached
        && limits.limitMessages === null;
      const hardSourceLimitReached = hardChatLimitReached
        || hardMessageLimitReached;
      if (chatLimitReached) warnings.add("chat-limit-reached");
      if (messageLimitReached) warnings.add("message-limit-reached");
      if (participantRosterIncomplete) warnings.add("participant-roster-incomplete");
      if (oversizedChatSkipped) warnings.add("oversized-chat-skipped");
      if (bundleRecordLimitReached) warnings.add("bundle-record-limit-reached");
      if (bundleByteLimitReached) warnings.add("bundle-byte-limit-reached");
      if (selfAliasPrepass.evidenceLimitReached) {
        warnings.add("self-alias-evidence-limit-reached");
      }
      if (selfAliasPrepass.participantOccurrenceLimitReached) {
        warnings.add("participant-occurrence-limit-reached");
      }
      if (emittedReactionProviderIdNonUnique) {
        warnings.add("reaction-provider-id-non-unique");
      }
      const truncated = chatLimitReached
        || messageLimitReached
        || oversizedChatSkipped
        || bundleRecordLimitReached
        || bundleByteLimitReached
        || selfAliasPrepass.evidenceLimitReached
        || selfAliasPrepass.participantOccurrenceLimitReached;
      stopProgressHeartbeat();
      assertProgressHeartbeat();
      completion = Object.freeze({
        completeness: Object.freeze({
          kind: truncated ? "truncated" : "bounded-local",
          reason: bundleRecordLimitReached
            ? "bundle-record-limit"
            : bundleByteLimitReached
              ? "bundle-byte-limit"
              : selfAliasPrepass.evidenceLimitReached
                ? "self-alias-evidence-limit"
                : selfAliasPrepass.participantOccurrenceLimitReached
                  ? "participant-occurrence-limit"
                : oversizedChatSkipped
                  ? "oversized-chat"
                  : hardSourceLimitReached
                    ? "source-hard-limit"
                    : truncated
                      ? "explicit-source-limit"
                    : "desktop-local-sequential-export",
          observedFrom,
          observedThrough,
        }),
        warnings: Object.freeze([...warnings].sort()),
      });
    }
  })();

  return Object.freeze({
    descriptor: Object.freeze({
      source: Object.freeze({ id: "beeper-local", version: "1.1.0" }),
      provider: Object.freeze({ id: "beeper", version: BEEPER_CLI_PIN.version }),
    }),
    records,
    completion: async () => {
      if (completion === undefined) return fail("record stream did not complete");
      return completion;
    },
    dispose: async (_published: boolean) => {
      stopProgressHeartbeat();
      if (disposed) return;
      if (disposalInFlight !== undefined) return disposalInFlight;
      const dispose = disposeWorking;
      if (dispose === undefined) {
        disposed = true;
        return;
      }
      const attempt = (async () => {
        await dispose();
        disposeWorking = undefined;
        disposed = true;
      })();
      disposalInFlight = attempt;
      try {
        await attempt;
      } finally {
        if (!disposed) disposalInFlight = undefined;
      }
    },
  });
}
