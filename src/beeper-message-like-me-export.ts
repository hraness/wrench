import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { dlopen, ptr } from "bun:ffi";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeDirectoryLease,
  type BeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";
import { removePrivateDirectoryTree } from "./storage";

export const BEEPER_MESSAGE_LIKE_ME_SCHEMA_VERSION = 1 as const;
export const BEEPER_MESSAGE_LIKE_ME_MAX_RECORDS = 500_000 as const;
export const BEEPER_MESSAGE_LIKE_ME_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_SHORT_TEXT_BYTES = 8 * 1_024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WARNING_CODES = 128;
const MAX_PARTICIPANTS = 10_000;
const MAX_ATTACHMENTS = 256;
const MAX_CONNECTED_ACCOUNTS = 128;
const BUNDLE_HEARTBEAT_INTERVAL_MS = 30_000;
const DARWIN_RENAME_EXCL = 0x0000_0004;
const LINUX_RENAME_NOREPLACE = 0x0000_0001;
const AT_FDCWD = -100;

type NativeExclusiveRename = (
  source: Uint8Array,
  destination: Uint8Array,
) => number;

let cachedNativeExclusiveRename: NativeExclusiveRename | undefined;

const HARD_LIMITS = Object.freeze({
  maxRecords: BEEPER_MESSAGE_LIKE_ME_MAX_RECORDS,
  maxRecordBytes: 2 * 1024 * 1024,
  maxTotalBytes: BEEPER_MESSAGE_LIKE_ME_MAX_TOTAL_BYTES,
});

export type BeeperMessageLikeMeExportLimits = {
  readonly maxRecords: number;
  readonly maxRecordBytes: number;
  readonly maxTotalBytes: number;
};

export type BeeperMessageLikeMeBundleProgress =
  | Readonly<{
    phase: "bundle-building";
    elapsedSeconds: number;
    records: number;
    bytes: number;
  }>
  | Readonly<{
    phase: "bundle-validating";
    elapsedSeconds: number;
    records: number;
    bytes: number;
  }>
  | Readonly<{
    phase: "bundle-publishing";
    elapsedSeconds: number;
    records: number;
    bytes: number;
  }>
  | Readonly<{
    phase: "private-cleanup";
    elapsedSeconds: number;
  }>;

export type BeeperMessageLikeMeExportSource = {
  /** Parsed as foreign data before any output directory is created. */
  readonly descriptor: unknown;
  /** Each yielded value is parsed strictly and written once. */
  readonly records: AsyncIterable<unknown>;
  /** Called only after the record stream ends successfully. */
  readonly completion: () => Promise<unknown>;
  /** Called exactly once after publication or failure cleanup. */
  readonly dispose?: (published: boolean) => Promise<void>;
};

export type BeeperMessageLikeMeExportRequest = {
  readonly outputRoot: string;
  readonly source: BeeperMessageLikeMeExportSource;
  readonly limits?: Partial<BeeperMessageLikeMeExportLimits>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BeeperMessageLikeMeBundleProgress) => void;
  /** Internal CLI composition seam for durable private-stage recovery. */
  readonly recoveryEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Test seam. Production callers should omit it. */
  readonly clock?: () => Date;
};

export type BeeperMessageLikeMeProvenance = {
  /** Stable entity identity in the provider's connected-account realm. */
  readonly providerId: string;
  readonly providerRevision: string | null;
  readonly observedAt: string;
  /** Stable provider account identity used to distinguish account incarnations. */
  readonly connectedAccountProviderId: string;
};

type BeeperMessageLikeMeRecordCommon<Kind extends string> = {
  readonly schemaVersion: 1;
  readonly kind: Kind;
  /** Bundle-local identity used for joins inside this export. */
  readonly id: string;
  readonly accountId: string;
  readonly network: string;
  readonly provenance: BeeperMessageLikeMeProvenance;
};

export type BeeperMessageLikeMeAccount = BeeperMessageLikeMeRecordCommon<"account"> & {
  /** Equal to id for the account record. */
  readonly accountId: string;
  readonly displayName: string | null;
  readonly handle: string | null;
  readonly selfParticipantId: string;
};

export type BeeperMessageLikeMeParticipant = BeeperMessageLikeMeRecordCommon<"participant"> & {
  readonly displayName: string | null;
  readonly handle: string | null;
  readonly isSelf: boolean;
};

export type BeeperMessageLikeMeConversation = BeeperMessageLikeMeRecordCommon<"conversation"> & {
  readonly type: "direct" | "group" | "channel" | "unknown";
  readonly title: string | null;
  /** Known roster. It includes self whenever self is present in the provider roster. */
  readonly participantIds: readonly string[];
  /** Only true is a positive assertion that the known roster is complete. */
  readonly participantsComplete: boolean | null;
  readonly startedAt: string | null;
  readonly lastMessageAt: string | null;
};

export type BeeperMessageLikeMeAttachment = {
  readonly kind: "audio" | "document" | "image" | "link" | "sticker" | "video" | "unknown";
  readonly mimeType: string | null;
  /** Base name only. Provider URLs and local paths are outside this format. */
  readonly name: string | null;
  readonly sizeBytes: number | null;
};

export type BeeperMessageLikeMeMessage = BeeperMessageLikeMeRecordCommon<"message"> & {
  readonly conversationId: string;
  readonly senderParticipantId: string | null;
  readonly direction: "incoming" | "outgoing" | "unknown";
  readonly sentAt: string;
  /** Provider-normalized key whose lexical order preserves provider message order. */
  readonly sortKey: string;
  readonly body: string | null;
  /** True bodies are unavailable as prose evidence. */
  readonly bodyTruncated: boolean | null;
  readonly replyTo: {
    readonly messageId: string | null;
    readonly providerId: string;
  } | null;
  readonly edit: {
    readonly kind: "in-place";
    readonly editedAt: string;
    readonly providerRevision: string;
  } | {
    readonly kind: "replacement";
    readonly replacesMessageId: string | null;
    readonly replacesProviderId: string;
    readonly editedAt: string;
    readonly providerRevision: string;
  } | null;
  readonly deletion: {
    readonly state: "revoked" | "deleted-for-me" | "revoked-and-deleted-for-me";
    readonly observedAt: string;
    readonly providerRevision: string | null;
  } | null;
  readonly attachments: readonly BeeperMessageLikeMeAttachment[];
};

export type BeeperMessageLikeMeReaction = BeeperMessageLikeMeRecordCommon<"reaction"> & {
  readonly messageId: string | null;
  readonly messageProviderId: string;
  readonly participantId: string | null;
  readonly body: string;
  /** Null when the provider does not supply a reaction time. Never synthesize it. */
  readonly reactedAt: string | null;
  readonly state: "active" | "removed";
};

export type BeeperMessageLikeMeTombstone = BeeperMessageLikeMeRecordCommon<"tombstone"> & {
  readonly entityKind: "conversation" | "message" | "reaction";
  readonly entityId: string | null;
  readonly entityProviderId: string;
  readonly deletedAt: string;
  readonly scope: "remote" | "local" | "unknown";
  readonly providerRevision: string | null;
};

export type BeeperMessageLikeMeRecord =
  | BeeperMessageLikeMeAccount
  | BeeperMessageLikeMeParticipant
  | BeeperMessageLikeMeConversation
  | BeeperMessageLikeMeMessage
  | BeeperMessageLikeMeReaction
  | BeeperMessageLikeMeTombstone;

export type BeeperMessageLikeMeArtifact = {
  readonly path: string;
  readonly mediaType: "application/x-ndjson";
  readonly recordKind:
    | "account"
    | "participant"
    | "conversation"
    | "message"
    | "reaction"
    | "tombstone";
  readonly records: number;
  readonly bytes: number;
  readonly sha256: string;
};

export type BeeperMessageLikeMeManifest = {
  readonly schemaVersion: 1;
  readonly format: "message-like-me.local-message-bundle";
  readonly source: {
    readonly id: "beeper-local";
    readonly version: string;
  };
  readonly provider: {
    readonly id: "beeper";
    readonly version: string;
  };
  readonly timestamps: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly createdAt: string;
  };
  readonly completeness: {
    readonly kind: "bounded-local" | "truncated" | "unknown";
    readonly reason: string | null;
    readonly observedFrom: string | null;
    readonly observedThrough: string | null;
  };
  readonly warnings: readonly string[];
  readonly privacy: {
    readonly classification: "private-local";
    readonly attachments: "metadata-only";
    readonly providerUrls: "excluded";
    readonly credentials: "excluded";
  };
  readonly counts: Readonly<Record<BeeperMessageLikeMeArtifact["recordKind"], number>>;
  readonly artifacts: readonly BeeperMessageLikeMeArtifact[];
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly bundleSha256: string;
  };
};

export type BeeperMessageLikeMeExportResult = {
  readonly outputRoot: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: BeeperMessageLikeMeManifest;
};

type JsonRecord = Record<string, unknown>;
type RecordKind = BeeperMessageLikeMeArtifact["recordKind"];

type ParsedDescriptor = {
  readonly source: { readonly id: "beeper-local"; readonly version: string };
  readonly provider: { readonly id: "beeper"; readonly version: string };
};

type ParsedCompletion = Pick<BeeperMessageLikeMeManifest, "completeness" | "warnings">;

type ParsedProvenance = {
  readonly providerId: string;
  readonly providerRevision: string | null;
  readonly observedAt: string;
  readonly connectedAccountProviderId: string;
};

type ParsedRecord = {
  readonly kind: RecordKind;
  readonly id: string;
  readonly accountId?: string;
  readonly network?: string;
  readonly connectedAccountProviderId?: string;
  readonly value: BeeperMessageLikeMeRecord;
};

type BundleGraphFact =
  | Readonly<{
      kind: "account";
      id: string;
      accountId: string;
      providerId: string;
      network: string;
      selfParticipantId: string;
    }>
  | Readonly<{
      kind: "participant";
      id: string;
      accountId: string;
      providerId: string;
      isSelf: boolean;
    }>
  | Readonly<{
      kind: "conversation";
      id: string;
      accountId: string;
      providerId: string;
      type: BeeperMessageLikeMeConversation["type"];
      participantIds: readonly string[];
      participantsComplete: boolean | null;
    }>
  | Readonly<{
      kind: "message";
      id: string;
      accountId: string;
      providerId: string;
      conversationId: string;
      senderParticipantId: string | null;
      direction: BeeperMessageLikeMeMessage["direction"];
      replyTo: BeeperMessageLikeMeMessage["replyTo"];
      edit: BeeperMessageLikeMeMessage["edit"];
    }>
  | Readonly<{
      kind: "reaction";
      id: string;
      accountId: string;
      providerId: string;
      messageId: string | null;
      messageProviderId: string;
      participantId: string | null;
    }>
  | Readonly<{
      kind: "tombstone";
      id: string;
      accountId: string;
      providerId: string;
      entityKind: BeeperMessageLikeMeTombstone["entityKind"];
      entityId: string | null;
      entityProviderId: string;
    }>;

type BundleGraphInventory = ReadonlyMap<
  RecordKind,
  ReadonlyMap<string, BundleGraphFact>
>;

type ArtifactWriter = {
  readonly kind: RecordKind;
  readonly fileName: string;
  readonly partPath: string;
  readonly handle: FileHandle;
  readonly hash: ReturnType<typeof createHash>;
  records: number;
  bytes: number;
  closed: boolean;
};

type PrivateDirectoryIdentity = {
  readonly device: number;
  readonly inode: number;
};

type StagedManifest = {
  readonly bytes: number;
  readonly sha256: string;
};

type PublishedDirectory = {
  readonly path: string;
  readonly parent: string;
  readonly identity: PrivateDirectoryIdentity;
  readonly parentIdentity: PrivateDirectoryIdentity;
};

type PublishedBundle = {
  readonly result: BeeperMessageLikeMeExportResult;
  readonly directory: PublishedDirectory;
  readonly directoryLease?: BeeperMessageLikeMeDirectoryLease;
};

const ARTIFACTS = Object.freeze([
  Object.freeze({ kind: "account" as const, fileName: "accounts.ndjson" }),
  Object.freeze({ kind: "participant" as const, fileName: "participants.ndjson" }),
  Object.freeze({ kind: "conversation" as const, fileName: "conversations.ndjson" }),
  Object.freeze({ kind: "message" as const, fileName: "messages.ndjson" }),
  Object.freeze({ kind: "reaction" as const, fileName: "reactions.ndjson" }),
  Object.freeze({ kind: "tombstone" as const, fileName: "tombstones.ndjson" }),
]);

function fail(message: string): never {
  throw new Error(`Beeper Message Like Me export: ${message}`);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function foreignRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    return fail(`${label} must not contain symbol keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    observed.length !== wanted.length
    || observed.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || utf8Length(value) > maximumBytes || value.includes("\0")) {
    return fail(`${label} must be a NUL-free string of at most ${String(maximumBytes)} UTF-8 bytes`);
  }
  return value;
}

function nullableText(value: unknown, label: string, maximumBytes: number): string | null {
  return value === null ? null : text(value, label, maximumBytes);
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label, MAX_IDENTIFIER_BYTES);
  if (parsed.length === 0 || /[\u0000-\u001f\u007f]/u.test(parsed)) {
    return fail(`${label} must be a non-empty identifier without ASCII control characters`);
  }
  return parsed;
}

function token(value: unknown, label: string, maximumBytes = 128): string {
  const parsed = text(value, label, maximumBytes);
  if (!/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/u.test(parsed)) {
    return fail(`${label} must be a lowercase categorical token`);
  }
  return parsed;
}

function version(value: unknown, label: string): string {
  const parsed = text(value, label, 128);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/u.test(parsed)) {
    return fail(`${label} must be a bounded version token`);
  }
  return parsed;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    return fail(`${label} must be one of: ${values.join(", ")}`);
  }
  return value as Values[number];
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return fail(`${label} must be a boolean`);
  return value;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  return value === null ? null : boolean(value, label);
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return fail(`${label} must be a non-negative safe integer at most ${String(maximum)}`);
  }
  return value as number;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  const instant = new Date(parsed);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== parsed) {
    return fail(`${label} must be a canonical UTC timestamp with millisecond precision`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return fail(`${label} must be an array of at most ${String(maximum)} items`);
  }
  return value;
}

function uniqueIdentifiers(value: unknown, label: string, maximum: number): readonly string[] {
  const parsed = array(value, label, maximum).map((item, index) =>
    identifier(item, `${label}[${String(index)}]`));
  if (new Set(parsed).size !== parsed.length) fail(`${label} must not contain duplicates`);
  return Object.freeze(parsed);
}

function parseProvenance(value: unknown, label: string): ParsedProvenance {
  const source = foreignRecord(value, label);
  exactKeys(source, [
    "providerId",
    "providerRevision",
    "observedAt",
    "connectedAccountProviderId",
  ], label);
  return Object.freeze({
    providerId: identifier(source.providerId, `${label}.providerId`),
    providerRevision: nullableText(source.providerRevision, `${label}.providerRevision`, MAX_IDENTIFIER_BYTES),
    observedAt: timestamp(source.observedAt, `${label}.observedAt`),
    connectedAccountProviderId: identifier(
      source.connectedAccountProviderId,
      `${label}.connectedAccountProviderId`,
    ),
  });
}

function parseCommon(
  source: JsonRecord,
  kind: RecordKind,
  expected: readonly string[],
  label: string,
): {
  readonly id: string;
  readonly accountId: string;
  readonly network: string;
  readonly provenance: ParsedProvenance;
} {
  exactKeys(source, ["schemaVersion", "kind", "id", "accountId", "network", "provenance", ...expected], label);
  if (source.schemaVersion !== 1) fail(`${label}.schemaVersion must equal 1`);
  if (source.kind !== kind) fail(`${label}.kind must equal ${kind}`);
  return {
    id: identifier(source.id, `${label}.id`),
    accountId: identifier(source.accountId, `${label}.accountId`),
    network: token(source.network, `${label}.network`, 64),
    provenance: parseProvenance(source.provenance, `${label}.provenance`),
  };
}

function parseAccount(source: JsonRecord, label: string): ParsedRecord {
  const common = parseCommon(source, "account", ["displayName", "handle", "selfParticipantId"], label);
  const value = Object.freeze({
    schemaVersion: 1,
    kind: "account",
    ...common,
    displayName: nullableText(source.displayName, `${label}.displayName`, MAX_SHORT_TEXT_BYTES),
    handle: nullableText(source.handle, `${label}.handle`, MAX_SHORT_TEXT_BYTES),
    selfParticipantId: identifier(source.selfParticipantId, `${label}.selfParticipantId`),
  });
  if (common.id !== common.accountId) fail(`${label}.id and ${label}.accountId must match`);
  if (common.provenance.providerId !== common.provenance.connectedAccountProviderId) {
    fail(`${label}.provenance.providerId must identify the connected account`);
  }
  return {
    kind: "account",
    id: common.id,
    accountId: common.accountId,
    network: common.network,
    connectedAccountProviderId: common.provenance.connectedAccountProviderId,
    value,
  };
}

function parseParticipant(source: JsonRecord, label: string): ParsedRecord {
  const common = parseCommon(source, "participant", ["displayName", "handle", "isSelf"], label);
  return {
    kind: "participant",
    id: common.id,
    accountId: common.accountId,
    network: common.network,
    connectedAccountProviderId: common.provenance.connectedAccountProviderId,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "participant",
      ...common,
      displayName: nullableText(source.displayName, `${label}.displayName`, MAX_SHORT_TEXT_BYTES),
      handle: nullableText(source.handle, `${label}.handle`, MAX_SHORT_TEXT_BYTES),
      isSelf: boolean(source.isSelf, `${label}.isSelf`),
    }),
  };
}

function parseConversation(source: JsonRecord, label: string): ParsedRecord {
  const common = parseCommon(source, "conversation", [
    "type", "title", "participantIds", "participantsComplete", "startedAt", "lastMessageAt",
  ], label);
  const startedAt = nullableTimestamp(source.startedAt, `${label}.startedAt`);
  const lastMessageAt = nullableTimestamp(source.lastMessageAt, `${label}.lastMessageAt`);
  if (startedAt !== null && lastMessageAt !== null && startedAt > lastMessageAt) {
    fail(`${label}.startedAt must not be after lastMessageAt`);
  }
  return {
    kind: "conversation",
    id: common.id,
    accountId: common.accountId,
    network: common.network,
    connectedAccountProviderId: common.provenance.connectedAccountProviderId,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "conversation",
      ...common,
      type: oneOf(source.type, ["direct", "group", "channel", "unknown"] as const, `${label}.type`),
      title: nullableText(source.title, `${label}.title`, MAX_SHORT_TEXT_BYTES),
      participantIds: uniqueIdentifiers(source.participantIds, `${label}.participantIds`, MAX_PARTICIPANTS),
      participantsComplete: nullableBoolean(
        source.participantsComplete,
        `${label}.participantsComplete`,
      ),
      startedAt,
      lastMessageAt,
    }),
  };
}

function parseReply(value: unknown, label: string): BeeperMessageLikeMeMessage["replyTo"] {
  if (value === null) return null;
  const source = foreignRecord(value, label);
  exactKeys(source, ["messageId", "providerId"], label);
  return Object.freeze({
    messageId: source.messageId === null ? null : identifier(source.messageId, `${label}.messageId`),
    providerId: identifier(source.providerId, `${label}.providerId`),
  });
}

function parseEdit(value: unknown, label: string): BeeperMessageLikeMeMessage["edit"] {
  if (value === null) return null;
  const source = foreignRecord(value, label);
  if (source.kind === "in-place") {
    exactKeys(source, ["kind", "editedAt", "providerRevision"], label);
    return Object.freeze({
      kind: "in-place",
      editedAt: timestamp(source.editedAt, `${label}.editedAt`),
      providerRevision: identifier(source.providerRevision, `${label}.providerRevision`),
    });
  }
  if (source.kind !== "replacement") fail(`${label}.kind is unsupported`);
  exactKeys(source, [
    "kind",
    "replacesMessageId",
    "replacesProviderId",
    "editedAt",
    "providerRevision",
  ], label);
  return Object.freeze({
    kind: "replacement",
    replacesMessageId: source.replacesMessageId === null
      ? null
      : identifier(source.replacesMessageId, `${label}.replacesMessageId`),
    replacesProviderId: identifier(
      source.replacesProviderId,
      `${label}.replacesProviderId`,
    ),
    editedAt: timestamp(source.editedAt, `${label}.editedAt`),
    providerRevision: identifier(source.providerRevision, `${label}.providerRevision`),
  });
}

function parseDeletion(value: unknown, label: string): BeeperMessageLikeMeMessage["deletion"] {
  if (value === null) return null;
  const source = foreignRecord(value, label);
  exactKeys(source, ["state", "observedAt", "providerRevision"], label);
  return Object.freeze({
    state: oneOf(source.state, [
      "revoked", "deleted-for-me", "revoked-and-deleted-for-me",
    ] as const, `${label}.state`),
    observedAt: timestamp(source.observedAt, `${label}.observedAt`),
    providerRevision: nullableText(source.providerRevision, `${label}.providerRevision`, MAX_IDENTIFIER_BYTES),
  });
}

function parseAttachments(value: unknown, label: string): readonly BeeperMessageLikeMeAttachment[] {
  return Object.freeze(array(value, label, MAX_ATTACHMENTS).map((item, index) => {
    const itemLabel = `${label}[${String(index)}]`;
    const source = foreignRecord(item, itemLabel);
    exactKeys(source, ["kind", "mimeType", "name", "sizeBytes"], itemLabel);
    const name = nullableText(source.name, `${itemLabel}.name`, MAX_SHORT_TEXT_BYTES);
    if (name !== null && (name === "." || name === ".." || name.includes("/") || name.includes("\\"))) {
      fail(`${itemLabel}.name must be a base name, not a local path`);
    }
    return Object.freeze({
      kind: oneOf(source.kind, [
        "audio", "document", "image", "link", "sticker", "video", "unknown",
      ] as const, `${itemLabel}.kind`),
      mimeType: nullableText(source.mimeType, `${itemLabel}.mimeType`, 256),
      name,
      sizeBytes: nullableInteger(source.sizeBytes, `${itemLabel}.sizeBytes`),
    });
  }));
}

function parseMessage(source: JsonRecord, label: string): ParsedRecord {
  const common = parseCommon(source, "message", [
    "conversationId",
    "senderParticipantId",
    "direction",
    "sentAt",
    "sortKey",
    "body",
    "bodyTruncated",
    "replyTo",
    "edit",
    "deletion",
    "attachments",
  ], label);
  const sentAt = timestamp(source.sentAt, `${label}.sentAt`);
  const edit = parseEdit(source.edit, `${label}.edit`);
  if (edit !== null && edit.editedAt < sentAt) {
    fail(`${label}.edit.editedAt must not be before sentAt`);
  }
  const deletion = parseDeletion(source.deletion, `${label}.deletion`);
  const body = nullableText(source.body, `${label}.body`, MAX_BODY_BYTES);
  if (deletion !== null && body !== null) {
    fail(`${label}.body must be null when deletion is present`);
  }
  return {
    kind: "message",
    id: common.id,
    accountId: common.accountId,
    network: common.network,
    connectedAccountProviderId: common.provenance.connectedAccountProviderId,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "message",
      ...common,
      conversationId: identifier(source.conversationId, `${label}.conversationId`),
      senderParticipantId: source.senderParticipantId === null
        ? null
        : identifier(source.senderParticipantId, `${label}.senderParticipantId`),
      direction: oneOf(source.direction, ["incoming", "outgoing", "unknown"] as const, `${label}.direction`),
      sentAt,
      sortKey: identifier(source.sortKey, `${label}.sortKey`),
      body,
      bodyTruncated: nullableBoolean(source.bodyTruncated, `${label}.bodyTruncated`),
      replyTo: parseReply(source.replyTo, `${label}.replyTo`),
      edit,
      deletion,
      attachments: parseAttachments(source.attachments, `${label}.attachments`),
    }),
  };
}

function parseReaction(source: JsonRecord, label: string): ParsedRecord {
  const common = parseCommon(source, "reaction", [
    "messageId", "messageProviderId", "participantId", "body", "reactedAt", "state",
  ], label);
  return {
    kind: "reaction",
    id: common.id,
    accountId: common.accountId,
    network: common.network,
    connectedAccountProviderId: common.provenance.connectedAccountProviderId,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "reaction",
      ...common,
      messageId: source.messageId === null
        ? null
        : identifier(source.messageId, `${label}.messageId`),
      messageProviderId: identifier(
        source.messageProviderId,
        `${label}.messageProviderId`,
      ),
      participantId: source.participantId === null
        ? null
        : identifier(source.participantId, `${label}.participantId`),
      body: text(source.body, `${label}.body`, MAX_SHORT_TEXT_BYTES),
      reactedAt: nullableTimestamp(source.reactedAt, `${label}.reactedAt`),
      state: oneOf(source.state, ["active", "removed"] as const, `${label}.state`),
    }),
  };
}

function parseTombstone(source: JsonRecord, label: string): ParsedRecord {
  const common = parseCommon(source, "tombstone", [
    "entityKind", "entityId", "entityProviderId", "deletedAt", "scope", "providerRevision",
  ], label);
  return {
    kind: "tombstone",
    id: common.id,
    accountId: common.accountId,
    network: common.network,
    connectedAccountProviderId: common.provenance.connectedAccountProviderId,
    value: Object.freeze({
      schemaVersion: 1,
      kind: "tombstone",
      ...common,
      entityKind: oneOf(source.entityKind, [
        "conversation", "message", "reaction",
      ] as const, `${label}.entityKind`),
      entityId: source.entityId === null ? null : identifier(source.entityId, `${label}.entityId`),
      entityProviderId: identifier(source.entityProviderId, `${label}.entityProviderId`),
      deletedAt: timestamp(source.deletedAt, `${label}.deletedAt`),
      scope: oneOf(source.scope, ["remote", "local", "unknown"] as const, `${label}.scope`),
      providerRevision: nullableText(source.providerRevision, `${label}.providerRevision`, MAX_IDENTIFIER_BYTES),
    }),
  };
}

function parseRecord(value: unknown, index: number): ParsedRecord {
  const label = `record[${String(index)}]`;
  const source = foreignRecord(value, label);
  switch (source.kind) {
    case "account": return parseAccount(source, label);
    case "participant": return parseParticipant(source, label);
    case "conversation": return parseConversation(source, label);
    case "message": return parseMessage(source, label);
    case "reaction": return parseReaction(source, label);
    case "tombstone": return parseTombstone(source, label);
    default: return fail(`${label}.kind is unsupported`);
  }
}

function bundleGraphFact(record: BeeperMessageLikeMeRecord): BundleGraphFact {
  const common = {
    id: record.id,
    accountId: record.accountId,
    providerId: record.provenance.providerId,
  } as const;
  switch (record.kind) {
    case "account":
      return Object.freeze({
        kind: record.kind,
        ...common,
        network: record.network,
        selfParticipantId: record.selfParticipantId,
      });
    case "participant":
      return Object.freeze({
        kind: record.kind,
        ...common,
        isSelf: record.isSelf,
      });
    case "conversation":
      return Object.freeze({
        kind: record.kind,
        ...common,
        type: record.type,
        participantIds: record.participantIds,
        participantsComplete: record.participantsComplete,
      });
    case "message":
      return Object.freeze({
        kind: record.kind,
        ...common,
        conversationId: record.conversationId,
        senderParticipantId: record.senderParticipantId,
        direction: record.direction,
        replyTo: record.replyTo,
        edit: record.edit,
      });
    case "reaction":
      return Object.freeze({
        kind: record.kind,
        ...common,
        messageId: record.messageId,
        messageProviderId: record.messageProviderId,
        participantId: record.participantId,
      });
    case "tombstone":
      return Object.freeze({
        kind: record.kind,
        ...common,
        entityKind: record.entityKind,
        entityId: record.entityId,
        entityProviderId: record.entityProviderId,
      });
  }
}

function graphRecords<Kind extends RecordKind>(
  inventory: BundleGraphInventory,
  kind: Kind,
): ReadonlyMap<string, Extract<BundleGraphFact, { readonly kind: Kind }>> {
  return (inventory.get(kind) ?? new Map()) as ReadonlyMap<
    string,
    Extract<BundleGraphFact, { readonly kind: Kind }>
  >;
}

function assertSameAccount(
  fact: BundleGraphFact | undefined,
  accountId: string,
  label: string,
): asserts fact is BundleGraphFact {
  if (fact === undefined || fact.accountId !== accountId) {
    fail(`${label} does not resolve inside its account realm`);
  }
}

function graphProviderCoordinate(accountId: string, providerId: string): string {
  return sha256(canonicalJson([accountId, providerId]));
}

function providerGraphRecords<Kind extends RecordKind>(
  records: ReadonlyMap<
    string,
    Extract<BundleGraphFact, { readonly kind: Kind }>
  >,
): ReadonlyMap<
  string,
  Extract<BundleGraphFact, { readonly kind: Kind }>
> {
  const providers = new Map<
    string,
    Extract<BundleGraphFact, { readonly kind: Kind }>
  >();
  for (const fact of records.values()) {
    providers.set(
      graphProviderCoordinate(fact.accountId, fact.providerId),
      fact,
    );
  }
  return providers;
}

function validateBundleGraph(inventory: BundleGraphInventory): void {
  const accounts = graphRecords(inventory, "account");
  const participants = graphRecords(inventory, "participant");
  const conversations = graphRecords(inventory, "conversation");
  const messages = graphRecords(inventory, "message");
  const reactions = graphRecords(inventory, "reaction");
  const messagesByProvider = providerGraphRecords(messages);
  const conversationRosters = new Map(
    [...conversations.values()].map((conversation) => [
      conversation.id,
      new Set(conversation.participantIds),
    ]),
  );
  const providerInventories = new Map<RecordKind, ReadonlyMap<string, BundleGraphFact>>(
    ARTIFACTS.map(({ kind }) => {
      const records = graphRecords(inventory, kind);
      return [kind, providerGraphRecords(records)];
    }),
  );
  const resolveMessageTarget = (
    accountId: string,
    localId: string | null,
    providerId: string,
    label: string,
  ): Extract<BundleGraphFact, { readonly kind: "message" }> | undefined => {
    const localTarget = localId === null ? undefined : messages.get(localId);
    if (localId !== null) {
      assertSameAccount(localTarget, accountId, label);
      if (localTarget.kind !== "message" || localTarget.providerId !== providerId) {
        fail(`${label} provider coordinate does not match`);
      }
    }
    const providerTarget = messagesByProvider.get(
      graphProviderCoordinate(accountId, providerId),
    );
    if (
      localTarget !== undefined
      && providerTarget !== undefined
      && localTarget.id !== providerTarget.id
    ) fail(`${label} local and provider coordinates disagree`);
    return localTarget ?? providerTarget;
  };

  const stableAccountRealms = new Set<string>();
  for (const account of accounts.values()) {
    const self = participants.get(account.selfParticipantId);
    assertSameAccount(self, account.accountId, "account self participant");
    if (self.kind !== "participant" || !self.isSelf) {
      fail("account self participant is not marked as self");
    }
    const stableRealm = sha256(canonicalJson([
      "beeper",
      account.providerId,
      self.providerId,
    ]));
    if (stableAccountRealms.has(stableRealm)) {
      fail("account records repeat one stable provider realm");
    }
    stableAccountRealms.add(stableRealm);
  }
  for (const participant of participants.values()) {
    const account = accounts.get(participant.accountId);
    assertSameAccount(account, participant.accountId, "participant account");
    if (participant.isSelf && account.kind === "account"
      && account.selfParticipantId !== participant.id) {
      fail("account realm contains an unreferenced self participant");
    }
  }
  for (const conversation of conversations.values()) {
    const account = accounts.get(conversation.accountId);
    assertSameAccount(account, conversation.accountId, "conversation account");
    for (const participantId of conversation.participantIds) {
      assertSameAccount(
        participants.get(participantId),
        conversation.accountId,
        "conversation participant",
      );
    }
    if (conversation.type === "direct" && conversation.participantsComplete === true) {
      const roster = conversation.participantIds.map((participantId) => {
        const participant = participants.get(participantId);
        if (participant?.kind !== "participant") {
          return fail("complete direct conversation participant has the wrong record kind");
        }
        return participant;
      });
      const selfCount = roster.filter((participant) => participant.isSelf).length;
      if (
        account.kind !== "account"
        || conversation.participantIds.length !== 2
        || selfCount !== 1
        || !conversationRosters.get(conversation.id)?.has(account.selfParticipantId)
      ) {
        fail("complete direct conversation must contain exactly one self participant and one peer");
      }
    }
  }
  const replacementEdges = new Map<string, string>();
  const replacedProviderCoordinates = new Set<string>();
  for (const message of messages.values()) {
    const conversation = conversations.get(message.conversationId);
    assertSameAccount(conversation, message.accountId, "message conversation");
    if (conversation.kind !== "conversation") {
      fail("message conversation has the wrong record kind");
    }
    if (message.senderParticipantId !== null) {
      const sender = participants.get(message.senderParticipantId);
      assertSameAccount(sender, message.accountId, "message sender");
      if (sender.kind !== "participant") fail("message sender has the wrong record kind");
      const expectedDirection = sender.isSelf ? "outgoing" : "incoming";
      if (message.direction !== expectedDirection) {
        fail("message direction conflicts with its sender participant");
      }
      if (
        conversation.participantsComplete === true
        && !conversationRosters.get(conversation.id)?.has(sender.id)
      ) fail("message sender is absent from the complete conversation roster");
    }
    if (message.replyTo !== null) {
      const target = resolveMessageTarget(
        message.accountId,
        message.replyTo.messageId,
        message.replyTo.providerId,
        "message reply target",
      );
      if (target !== undefined) {
        if (target.id === message.id) fail("message must not reply to itself");
        if (target.conversationId !== message.conversationId) {
          fail("message reply target belongs to a different conversation");
        }
      }
    }
    if (message.edit?.kind === "replacement") {
      if (message.edit.replacesProviderId === message.providerId) {
        fail("replacement edit must not replace its own provider coordinate");
      }
      const targetCoordinate = graphProviderCoordinate(
        message.accountId,
        message.edit.replacesProviderId,
      );
      if (replacedProviderCoordinates.has(targetCoordinate)) {
        fail("one provider message has more than one replacement");
      }
      replacedProviderCoordinates.add(targetCoordinate);
      const target = resolveMessageTarget(
        message.accountId,
        message.edit.replacesMessageId,
        message.edit.replacesProviderId,
        "replacement edit target",
      );
      if (target !== undefined) {
        if (target.conversationId !== message.conversationId) {
          fail("replacement edit target belongs to a different conversation");
        }
        replacementEdges.set(message.id, target.id);
      }
    }
  }
  const completedReplacementNodes = new Set<string>();
  for (const start of replacementEdges.keys()) {
    if (completedReplacementNodes.has(start)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !completedReplacementNodes.has(current)) {
      if (positions.has(current)) fail("replacement edit graph contains a cycle");
      positions.set(current, path.length);
      path.push(current);
      current = replacementEdges.get(current);
    }
    for (const id of path) completedReplacementNodes.add(id);
  }
  for (const reaction of reactions.values()) {
    let participant: Extract<BundleGraphFact, { readonly kind: "participant" }>
      | undefined;
    if (reaction.participantId !== null) {
      participant = participants.get(reaction.participantId);
      assertSameAccount(
        participant,
        reaction.accountId,
        "reaction participant",
      );
    }
    const target = resolveMessageTarget(
      reaction.accountId,
      reaction.messageId,
      reaction.messageProviderId,
      "reaction message target",
    );
    if (participant !== undefined && target !== undefined) {
      const conversation = conversations.get(target.conversationId);
      assertSameAccount(
        conversation,
        reaction.accountId,
        "reaction target conversation",
      );
      if (
        conversation.kind === "conversation"
        && conversation.participantsComplete === true
        && !conversationRosters.get(conversation.id)?.has(participant.id)
      ) fail("reaction participant is absent from the complete conversation roster");
    }
  }
  for (const tombstone of graphRecords(inventory, "tombstone").values()) {
    const providerTargets = providerInventories.get(tombstone.entityKind);
    if (providerTargets === undefined) fail("internal provider inventory is incomplete");
    const providerTarget = providerTargets.get(graphProviderCoordinate(
      tombstone.accountId,
      tombstone.entityProviderId,
    ));
    if (tombstone.entityId !== null) {
      const target = graphRecords(inventory, tombstone.entityKind).get(
        tombstone.entityId,
      );
      assertSameAccount(target, tombstone.accountId, "tombstone entity target");
      if (target.providerId !== tombstone.entityProviderId) {
        fail("tombstone entity provider coordinate does not match");
      }
      if (providerTarget !== undefined && target.id !== providerTarget.id) {
        fail("tombstone local and provider coordinates disagree");
      }
    }
  }
}

function parseDescriptor(value: unknown): ParsedDescriptor {
  const descriptor = foreignRecord(value, "source descriptor");
  exactKeys(descriptor, ["source", "provider"], "source descriptor");
  const source = foreignRecord(descriptor.source, "source descriptor.source");
  exactKeys(source, ["id", "version"], "source descriptor.source");
  if (source.id !== "beeper-local") fail("source descriptor.source.id must equal beeper-local");
  const provider = foreignRecord(descriptor.provider, "source descriptor.provider");
  exactKeys(provider, ["id", "version"], "source descriptor.provider");
  if (provider.id !== "beeper") fail("source descriptor.provider.id must equal beeper");
  return Object.freeze({
    source: Object.freeze({ id: "beeper-local", version: version(source.version, "source descriptor.source.version") }),
    provider: Object.freeze({ id: "beeper", version: version(provider.version, "source descriptor.provider.version") }),
  });
}

function parseCompletion(value: unknown): ParsedCompletion {
  const source = foreignRecord(value, "source completion");
  exactKeys(source, ["completeness", "warnings"], "source completion");
  const completeness = foreignRecord(source.completeness, "source completion.completeness");
  exactKeys(
    completeness,
    ["kind", "reason", "observedFrom", "observedThrough"],
    "source completion.completeness",
  );
  const observedFrom = nullableTimestamp(
    completeness.observedFrom,
    "source completion.completeness.observedFrom",
  );
  const observedThrough = nullableTimestamp(
    completeness.observedThrough,
    "source completion.completeness.observedThrough",
  );
  if (observedFrom !== null && observedThrough !== null && observedFrom > observedThrough) {
    fail("source completion observedFrom must not be after observedThrough");
  }
  const warnings = array(source.warnings, "source completion.warnings", MAX_WARNING_CODES)
    .map((warning, index) => token(warning, `source completion.warnings[${String(index)}]`));
  if (new Set(warnings).size !== warnings.length) fail("source completion.warnings must not contain duplicates");
  return Object.freeze({
    completeness: Object.freeze({
      kind: oneOf(completeness.kind, ["bounded-local", "truncated", "unknown"] as const, "source completion.completeness.kind"),
      reason: completeness.reason === null
        ? null
        : token(completeness.reason, "source completion.completeness.reason"),
      observedFrom,
      observedThrough,
    }),
    warnings: Object.freeze(warnings),
  });
}

function parseLimits(value: unknown): BeeperMessageLikeMeExportLimits {
  if (value === undefined) return HARD_LIMITS;
  const source = foreignRecord(value, "export limits");
  const permitted = ["maxRecords", "maxRecordBytes", "maxTotalBytes"];
  if (Object.keys(source).some((key) => !permitted.includes(key))) {
    fail(`export limits may contain only: ${permitted.join(", ")}`);
  }
  const parse = (key: keyof BeeperMessageLikeMeExportLimits): number => {
    const candidate = source[key] ?? HARD_LIMITS[key];
    const parsed = integer(candidate, `export limits.${key}`, HARD_LIMITS[key]);
    if (parsed === 0) fail(`export limits.${key} must be greater than zero`);
    return parsed;
  };
  return Object.freeze({
    maxRecords: parse("maxRecords"),
    maxRecordBytes: parse("maxRecordBytes"),
    maxTotalBytes: parse("maxTotalBytes"),
  });
}

function now(clock: (() => Date) | undefined, label: string): string {
  const value = (clock ?? (() => new Date()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail(`${label} clock value must be a valid Date`);
  }
  return value.toISOString();
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  fail(`${label} already exists`);
}

function nativeExclusiveRename(): NativeExclusiveRename {
  if (cachedNativeExclusiveRename !== undefined) {
    return cachedNativeExclusiveRename;
  }
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: {
        args: ["cstring", "cstring", "u32"],
        returns: "int",
      },
    } as const);
    cachedNativeExclusiveRename = (source, destination) =>
      library.symbols.renamex_np(
        ptr(source),
        ptr(destination),
        DARWIN_RENAME_EXCL,
      );
    return cachedNativeExclusiveRename;
  }
  if (process.platform === "linux") {
    const library = dlopen("libc.so.6", {
      renameat2: {
        args: ["int", "cstring", "int", "cstring", "u32"],
        returns: "int",
      },
    } as const);
    cachedNativeExclusiveRename = (source, destination) =>
      library.symbols.renameat2(
        AT_FDCWD,
        ptr(source),
        AT_FDCWD,
        ptr(destination),
        LINUX_RENAME_NOREPLACE,
      );
    return cachedNativeExclusiveRename;
  }
  return fail("atomic no-clobber publication is unsupported on this platform");
}

async function renameDirectoryExclusive(
  source: string,
  destination: string,
): Promise<void> {
  const encodePath = (path: string): Buffer => {
    if (path.includes("\0")) return fail("atomic publication path was invalid");
    return Buffer.from(`${path}\0`, "utf8");
  };
  const result = nativeExclusiveRename()(
    encodePath(source),
    encodePath(destination),
  );
  if (result === 0) return;
  let destinationExists = false;
  try {
    await lstat(destination);
    destinationExists = true;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  if (destinationExists) {
    return fail("outputRoot appeared before atomic publication");
  }
  return fail("atomic no-clobber publication failed");
}

async function validateOutputRoot(outputRoot: unknown): Promise<{
  readonly outputRoot: string;
  readonly parent: string;
  readonly parentDevice: number;
  readonly parentInode: number;
}> {
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot) {
    return fail("outputRoot must be a normalized absolute path");
  }
  if (outputRoot === sep || utf8Length(outputRoot) > 4_096 || basename(outputRoot).includes("\0")) {
    return fail("outputRoot is unsafe");
  }
  const parent = dirname(outputRoot);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    return fail("outputRoot parent must be a real directory");
  }
  if (await realpath(parent) !== parent) {
    return fail("outputRoot parent path must not traverse a symbolic link");
  }
  const uid = process.getuid?.();
  if (uid === undefined) fail("private exports require a POSIX user identity");
  if (parentMetadata.uid !== uid) fail("outputRoot parent must be owned by the current user");
  if ((parentMetadata.mode & 0o022) !== 0) {
    fail("outputRoot parent must not be writable by the group or other users");
  }
  await assertAbsent(outputRoot, "outputRoot");
  return {
    outputRoot,
    parent,
    parentDevice: parentMetadata.dev,
    parentInode: parentMetadata.ino,
  };
}

async function assertParentUnchanged(snapshot: Awaited<ReturnType<typeof validateOutputRoot>>): Promise<void> {
  const current = await lstat(snapshot.parent);
  const uid = process.getuid?.();
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || uid === undefined
    || current.uid !== uid
    || (current.mode & 0o022) !== 0
    || current.dev !== snapshot.parentDevice
    || current.ino !== snapshot.parentInode
    || await realpath(snapshot.parent) !== snapshot.parent
  ) {
    fail("outputRoot parent changed during export setup");
  }
}

async function assertPrivateDirectory(
  path: string,
  expected?: PrivateDirectoryIdentity,
): Promise<PrivateDirectoryIdentity> {
  const uid = process.getuid?.();
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || uid === undefined
    || metadata.uid !== uid
    || (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    || (expected !== undefined
      && (metadata.dev !== expected.device || metadata.ino !== expected.inode))
    || await realpath(path) !== path
  ) {
    fail("private staging directory changed");
  }
  return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}

async function assertPrivateFile(path: string, expectedBytes: number): Promise<void> {
  const uid = process.getuid?.();
  const metadata = await lstat(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || uid === undefined
    || metadata.uid !== uid
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    || metadata.size !== expectedBytes
  ) {
    fail("private staged artifact changed");
  }
}

async function createPrivateStagingDirectory(
  output: Awaited<ReturnType<typeof validateOutputRoot>>,
): Promise<{ readonly path: string; readonly identity: PrivateDirectoryIdentity }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await assertParentUnchanged(output);
    const candidate = await mkdtemp(resolve(output.parent, ".message-like-me-staging-"));
    let identity: PrivateDirectoryIdentity | undefined;
    try {
      await chmod(candidate, PRIVATE_DIRECTORY_MODE);
      identity = await assertPrivateDirectory(candidate);
      const metadata = await lstat(candidate);
      if (dirname(candidate) !== output.parent || metadata.dev !== output.parentDevice) {
        fail("private staging directory must share the output parent and filesystem");
      }
      if (candidate === output.outputRoot) {
        await removeOwnedPrivateDirectory(candidate, identity);
        continue;
      }
      return Object.freeze({ path: candidate, identity });
    } catch (error) {
      if (identity === undefined) {
        try {
          await rmdir(candidate);
        } catch {
          // Never recursively remove a directory whose identity was not captured.
        }
      } else {
        await removeOwnedPrivateDirectory(candidate, identity);
      }
      throw error;
    }
  }
  return fail("could not allocate a private staging directory distinct from outputRoot");
}

async function removeOwnedPrivateDirectory(
  path: string,
  identity: PrivateDirectoryIdentity,
): Promise<void> {
  try {
    removePrivateDirectoryTree(path, Object.freeze({
      device: String(identity.device),
      inode: String(identity.inode),
    }));
  } catch {
    return fail("private directory could not be removed from quarantine safely");
  }
}

async function syncDirectory(
  path: string,
  expected: PrivateDirectoryIdentity,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory()
      || metadata.dev !== expected.device
      || metadata.ino !== expected.inode
    ) {
      fail("directory changed before synchronization");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function privateFileSha256(path: string, expectedBytes: number): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const uid = process.getuid?.();
    const before = await handle.stat();
    const entryBefore = await lstat(path);
    if (
      !before.isFile()
      || uid === undefined
      || before.uid !== uid
      || before.nlink !== 1
      || (before.mode & 0o777) !== PRIVATE_FILE_MODE
      || before.size !== expectedBytes
      || !entryBefore.isFile()
      || entryBefore.isSymbolicLink()
      || entryBefore.dev !== before.dev
      || entryBefore.ino !== before.ino
      || entryBefore.nlink !== 1
    ) {
      fail("private staged artifact changed before bundle validation");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < expectedBytes) {
      const length = Math.min(buffer.byteLength, expectedBytes - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) fail("private staged artifact ended during bundle validation");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const entryAfter = await lstat(path);
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || !after.isFile()
      || after.uid !== before.uid
      || after.nlink !== 1
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || (after.mode & 0o777) !== PRIVATE_FILE_MODE
      || !entryAfter.isFile()
      || entryAfter.isSymbolicLink()
      || entryAfter.dev !== after.dev
      || entryAfter.ino !== after.ino
      || entryAfter.nlink !== 1
    ) {
      fail("private staged artifact changed during bundle validation");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function createWriter(staging: string, kind: RecordKind, fileName: string): Promise<ArtifactWriter> {
  const partPath = resolve(staging, `${fileName}.part`);
  if (!partPath.startsWith(`${staging}${sep}`)) fail("internal artifact path escaped staging");
  const handle = await open(
    partPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    const uid = process.getuid?.();
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || uid === undefined
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      fail(`could not create private staging file ${fileName}`);
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    kind,
    fileName,
    partPath,
    handle,
    hash: createHash("sha256"),
    records: 0,
    bytes: 0,
    closed: false,
  };
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten === 0) fail("staging file stopped accepting bytes");
    offset += result.bytesWritten;
  }
}

async function writeRecord(
  writer: ArtifactWriter,
  value: Readonly<Record<string, unknown>>,
  limits: BeeperMessageLikeMeExportLimits,
  totalBytes: number,
): Promise<number> {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.byteLength > limits.maxRecordBytes) {
    fail(`one ${writer.kind} record exceeds the configured byte bound`);
  }
  if (totalBytes + bytes.byteLength > limits.maxTotalBytes) {
    fail("bundle records exceed the configured total byte bound");
  }
  await writeAll(writer.handle, bytes);
  writer.hash.update(bytes);
  writer.records += 1;
  writer.bytes += bytes.byteLength;
  return totalBytes + bytes.byteLength;
}

async function closeWriter(writer: ArtifactWriter): Promise<void> {
  if (writer.closed) return;
  writer.closed = true;
  await writer.handle.close();
}

async function finalizeWriter(writer: ArtifactWriter, staging: string): Promise<BeeperMessageLikeMeArtifact> {
  await writer.handle.sync();
  const uid = process.getuid?.();
  const opened = await writer.handle.stat();
  if (
    !opened.isFile()
    || uid === undefined
    || opened.uid !== uid
    || opened.nlink !== 1
    || opened.size !== writer.bytes
    || (opened.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    fail(`${writer.fileName} changed before finalization`);
  }
  await closeWriter(writer);
  await assertPrivateFile(writer.partPath, writer.bytes);
  const finalPath = resolve(staging, writer.fileName);
  await assertAbsent(finalPath, writer.fileName);
  await rename(writer.partPath, finalPath);
  await assertPrivateFile(finalPath, writer.bytes);
  return Object.freeze({
    path: writer.fileName,
    mediaType: "application/x-ndjson",
    recordKind: writer.kind,
    records: writer.records,
    bytes: writer.bytes,
    sha256: writer.hash.digest("hex"),
  });
}

async function writeManifest(
  staging: string,
  manifest: BeeperMessageLikeMeManifest,
): Promise<StagedManifest> {
  const partPath = resolve(staging, "manifest.json.part");
  const finalPath = resolve(staging, "manifest.json");
  const bytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  const handle = await open(
    partPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await writeAll(handle, bytes);
    await handle.sync();
    const uid = process.getuid?.();
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || uid === undefined
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || metadata.size !== bytes.byteLength
      || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      fail("manifest changed before finalization");
    }
  } finally {
    await handle.close();
  }
  await assertPrivateFile(partPath, bytes.byteLength);
  await assertAbsent(finalPath, "manifest.json");
  await rename(partPath, finalPath);
  await assertPrivateFile(finalPath, bytes.byteLength);
  return Object.freeze({
    bytes: bytes.byteLength,
    sha256: sha256(bytes.toString("utf8")),
  });
}

async function validateCompleteBundle(
  root: string,
  identity: PrivateDirectoryIdentity,
  artifacts: readonly BeeperMessageLikeMeArtifact[],
  manifest: StagedManifest,
): Promise<void> {
  await assertPrivateDirectory(root, identity);
  const expectedNames = [
    ...artifacts.map((artifact) => artifact.path),
    "manifest.json",
  ].sort();
  const observedNames = (await readdir(root)).sort();
  if (
    observedNames.length !== expectedNames.length
    || observedNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail("private staging directory does not contain the exact complete bundle");
  }
  for (const artifact of artifacts) {
    const path = resolve(root, artifact.path);
    await assertPrivateFile(path, artifact.bytes);
    if (await privateFileSha256(path, artifact.bytes) !== artifact.sha256) {
      fail(`${artifact.path} changed before publication`);
    }
  }
  const manifestPath = resolve(root, "manifest.json");
  await assertPrivateFile(manifestPath, manifest.bytes);
  if (await privateFileSha256(manifestPath, manifest.bytes) !== manifest.sha256) {
    fail("manifest.json changed before publication");
  }
}

function assertSource(source: BeeperMessageLikeMeExportSource): void {
  if (
    typeof source !== "object"
    || source === null
    || typeof source.completion !== "function"
    || typeof source.records !== "object"
    || source.records === null
    || typeof source.records[Symbol.asyncIterator] !== "function"
    || (source.dispose !== undefined && typeof source.dispose !== "function")
  ) {
    fail("source must expose an async record stream, completion function, and optional dispose function");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("export was aborted");
}

type BundlePhaseHeartbeat = Readonly<{
  stop: () => void;
  assertHealthy: () => void;
}>;

function startBundlePhaseHeartbeat(
  request: BeeperMessageLikeMeExportRequest,
  phase: "bundle-validating" | "bundle-publishing",
  records: number,
  bytes: number,
): BundlePhaseHeartbeat {
  const startedAt = Date.now();
  let failed = false;
  const report = (elapsedSeconds: number): void => {
    request.onProgress?.(Object.freeze({
      phase,
      elapsedSeconds,
      records,
      bytes,
    }));
  };
  report(0);
  const heartbeat = request.onProgress === undefined
    ? null
    : setInterval(() => {
        try {
          report(Math.max(1, Math.floor((Date.now() - startedAt) / 1_000)));
        } catch {
          failed = true;
        }
      }, BUNDLE_HEARTBEAT_INTERVAL_MS);
  return Object.freeze({
    stop: () => {
      if (heartbeat !== null) clearInterval(heartbeat);
    },
    assertHealthy: () => {
      if (failed) fail("export progress reporting failed");
    },
  });
}

function startPrivateCleanupHeartbeat(
  request: BeeperMessageLikeMeExportRequest,
): BundlePhaseHeartbeat {
  const startedAt = Date.now();
  let failed = false;
  const report = (elapsedSeconds: number): void => {
    request.onProgress?.(Object.freeze({
      phase: "private-cleanup",
      elapsedSeconds,
    }));
  };
  try {
    report(0);
  } catch {
    failed = true;
  }
  const heartbeat = request.onProgress === undefined
    ? null
    : setInterval(() => {
        try {
          report(Math.max(1, Math.floor((Date.now() - startedAt) / 1_000)));
        } catch {
          failed = true;
        }
      }, BUNDLE_HEARTBEAT_INTERVAL_MS);
  return Object.freeze({
    stop: () => {
      if (heartbeat !== null) clearInterval(heartbeat);
    },
    assertHealthy: () => {
      if (failed) fail("export progress reporting failed");
    },
  });
}

/**
 * Writes a private, local Message Like Me interchange bundle. The source owns
 * provider access; this function accepts only bounded foreign records and
 * never invokes Beeper, follows media references, or receives credentials.
 *
 * The complete bundle is built and validated in a mode-0700 sibling directory
 * on the destination filesystem. `outputRoot` remains absent until one final
 * atomic rename publishes all seven files together. Failure and cancellation
 * remove the owned staging directory without publishing a partial bundle.
 */
async function publishBeeperMessageLikeMeBundle(
  request: BeeperMessageLikeMeExportRequest,
): Promise<PublishedBundle> {
  let published = false;
  const descriptor = parseDescriptor(request.source.descriptor);
  const limits = parseLimits(request.limits);
  throwIfAborted(request.signal);
  const startedAt = now(request.clock, "startedAt");
  const output = await validateOutputRoot(request.outputRoot);
  const stagedDirectory = await createPrivateStagingDirectory(output);
  const staging = stagedDirectory.path;
  let directoryLease: BeeperMessageLikeMeDirectoryLease | undefined;

  if (request.recoveryEnvironment !== undefined) {
    try {
      const leaseCreatedAtMs = Date.now();
      directoryLease = await createBeeperMessageLikeMeDirectoryLease({
        role: "bundle-stage",
        path: staging,
        outputRoot: output.outputRoot,
        recoverAfterMs: leaseCreatedAtMs,
        nowMs: leaseCreatedAtMs,
        environment: request.recoveryEnvironment,
      });
    } catch (leaseError) {
      const cleanupErrors: unknown[] = [];
      try {
        await removeOwnedPrivateDirectory(staging, stagedDirectory.identity);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await syncDirectory(output.parent, Object.freeze({
          device: output.parentDevice,
          inode: output.parentInode,
        }));
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [leaseError, ...cleanupErrors],
          "Beeper Message Like Me export: recovery setup and cleanup both failed",
        );
      }
      throw leaseError;
    }
  }

  const writers = new Map<RecordKind, ArtifactWriter>();
  let bundlePhaseHeartbeat: BundlePhaseHeartbeat | undefined;
  let renamed = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    for (const artifact of ARTIFACTS) {
      writers.set(artifact.kind, await createWriter(staging, artifact.kind, artifact.fileName));
    }

    const graphInventory = new Map<RecordKind, Map<string, BundleGraphFact>>(
      ARTIFACTS.map((artifact) => [artifact.kind, new Map<string, BundleGraphFact>()]),
    );
    const providerCoordinates = new Map<RecordKind, Set<string>>(
      ARTIFACTS.map((artifact) => [artifact.kind, new Set<string>()]),
    );
    const accountRealms = new Map<string, { readonly network: string; readonly connectedAccountProviderId: string }>();
    const referencedAccountRealms = new Map<string, { readonly network: string; readonly connectedAccountProviderId: string }>();
    let totalRecords = 0;
    let totalBytes = 0;
    const bundleStartedAt = Date.now();
    let lastBundleProgressAt = bundleStartedAt;

    for await (const candidate of request.source.records) {
      throwIfAborted(request.signal);
      totalRecords += 1;
      if (totalRecords > limits.maxRecords) fail("record stream exceeds the configured record bound");
      const parsed = parseRecord(candidate, totalRecords - 1);
      const records = graphInventory.get(parsed.kind);
      const coordinates = providerCoordinates.get(parsed.kind);
      if (records === undefined || coordinates === undefined) {
        fail("internal record-kind inventory is incomplete");
      }
      if (records.has(parsed.id)) {
        fail(`${parsed.kind} record repeats a bundle-local identity`);
      }
      const providerCoordinate = graphProviderCoordinate(
        parsed.value.accountId,
        parsed.value.provenance.providerId,
      );
      if (coordinates.has(providerCoordinate)) {
        fail(`${parsed.kind} record repeats an account-scoped provider identity`);
      }
      records.set(parsed.id, bundleGraphFact(parsed.value));
      coordinates.add(providerCoordinate);
      if (parsed.kind === "account" && records.size > MAX_CONNECTED_ACCOUNTS) {
        fail("record stream exceeds the connected-account bound");
      }

      if (
        parsed.accountId !== undefined
        && parsed.network !== undefined
        && parsed.connectedAccountProviderId !== undefined
      ) {
        const realm = Object.freeze({
          network: parsed.network,
          connectedAccountProviderId: parsed.connectedAccountProviderId,
        });
        if (parsed.kind === "account") {
          const current = accountRealms.get(parsed.accountId);
          if (
            current !== undefined
            && (
              current.network !== realm.network
              || current.connectedAccountProviderId !== realm.connectedAccountProviderId
            )
          ) {
            fail("account record has conflicting source identity");
          }
          accountRealms.set(parsed.accountId, realm);
        } else {
          const current = referencedAccountRealms.get(parsed.accountId);
          if (
            current !== undefined
            && (
              current.network !== realm.network
              || current.connectedAccountProviderId !== realm.connectedAccountProviderId
            )
          ) {
            fail("account is referenced with conflicting source identity");
          }
          referencedAccountRealms.set(parsed.accountId, realm);
        }
      }

      const writer = writers.get(parsed.kind);
      if (writer === undefined) fail("internal artifact writer is missing");
      totalBytes = await writeRecord(writer, parsed.value, limits, totalBytes);
      const progressAt = Date.now();
      if (
        totalRecords === 1
        || progressAt - lastBundleProgressAt >= 30_000
      ) {
        request.onProgress?.(Object.freeze({
          phase: "bundle-building",
          elapsedSeconds: Math.max(
            0,
            Math.floor((progressAt - bundleStartedAt) / 1_000),
          ),
          records: totalRecords,
          bytes: totalBytes,
        }));
        lastBundleProgressAt = progressAt;
      }
    }

    for (const [accountId, realm] of referencedAccountRealms) {
      const accountRealm = accountRealms.get(accountId);
      if (accountRealm === undefined) {
        fail("record stream references a missing account");
      }
      if (
        accountRealm.network !== realm.network
        || accountRealm.connectedAccountProviderId !== realm.connectedAccountProviderId
      ) {
        fail("account does not match its referenced source identity");
      }
    }

    bundlePhaseHeartbeat = startBundlePhaseHeartbeat(
      request,
      "bundle-validating",
      totalRecords,
      totalBytes,
    );
    validateBundleGraph(graphInventory);

    throwIfAborted(request.signal);
    const completion = parseCompletion(await request.source.completion());
    const finishedAt = now(request.clock, "finishedAt");
    if (finishedAt < startedAt) fail("finishedAt must not be before startedAt");

    const artifacts: BeeperMessageLikeMeArtifact[] = [];
    for (const artifact of ARTIFACTS) {
      const writer = writers.get(artifact.kind);
      if (writer === undefined) fail("internal artifact writer is missing during finalization");
      artifacts.push(await finalizeWriter(writer, staging));
    }

    const counts = Object.freeze(Object.fromEntries(
      artifacts.map((artifact) => [artifact.recordKind, artifact.records]),
    )) as Readonly<Record<RecordKind, number>>;
    const manifestProjection = Object.freeze({
      schemaVersion: BEEPER_MESSAGE_LIKE_ME_SCHEMA_VERSION,
      format: "message-like-me.local-message-bundle",
      source: descriptor.source,
      provider: descriptor.provider,
      timestamps: Object.freeze({
        startedAt,
        finishedAt,
        createdAt: finishedAt,
      }),
      completeness: completion.completeness,
      warnings: completion.warnings,
      privacy: Object.freeze({
        classification: "private-local",
        attachments: "metadata-only",
        providerUrls: "excluded",
        credentials: "excluded",
      }),
      counts,
      artifacts: Object.freeze(artifacts),
    });
    const manifest: BeeperMessageLikeMeManifest = Object.freeze({
      ...manifestProjection,
      integrity: Object.freeze({
        algorithm: "sha256",
        bundleSha256: sha256(canonicalJson(manifestProjection)),
      }),
    });
    const stagedManifest = await writeManifest(staging, manifest);
    await validateCompleteBundle(
      staging,
      stagedDirectory.identity,
      artifacts,
      stagedManifest,
    );
    await syncDirectory(staging, stagedDirectory.identity);
    throwIfAborted(request.signal);
    await assertParentUnchanged(output);
    bundlePhaseHeartbeat.stop();
    bundlePhaseHeartbeat.assertHealthy();
    bundlePhaseHeartbeat = startBundlePhaseHeartbeat(
      request,
      "bundle-publishing",
      totalRecords,
      totalBytes,
    );

    const result = Object.freeze({
      outputRoot: output.outputRoot,
      manifestPath: resolve(output.outputRoot, "manifest.json"),
      manifestSha256: stagedManifest.sha256,
      manifest,
    });

    await renameDirectoryExclusive(staging, output.outputRoot);
    renamed = true;
    await validateCompleteBundle(
      output.outputRoot,
      stagedDirectory.identity,
      artifacts,
      stagedManifest,
    );
    throwIfAborted(request.signal);
    await assertParentUnchanged(output);
    await syncDirectory(output.parent, Object.freeze({
      device: output.parentDevice,
      inode: output.parentInode,
    }));
    bundlePhaseHeartbeat.stop();
    bundlePhaseHeartbeat.assertHealthy();
    bundlePhaseHeartbeat = undefined;
    const publishedDirectory = Object.freeze({
      path: output.outputRoot,
      parent: output.parent,
      identity: stagedDirectory.identity,
      parentIdentity: Object.freeze({
        device: output.parentDevice,
        inode: output.parentInode,
      }),
    });
    published = true;
    return Object.freeze({
      result,
      directory: publishedDirectory,
      ...(directoryLease === undefined ? {} : { directoryLease }),
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    bundlePhaseHeartbeat?.stop();
    const closeResults = await Promise.allSettled(
      [...writers.values()].map((writer) => closeWriter(writer)),
    );
    for (const result of closeResults) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    if (!published) {
      let removalDurable = true;
      try {
        await removeOwnedPrivateDirectory(
          renamed ? output.outputRoot : staging,
          stagedDirectory.identity,
        );
      } catch (error) {
        removalDurable = false;
        cleanupErrors.push(error);
      }
      try {
        await syncDirectory(output.parent, Object.freeze({
          device: output.parentDevice,
          inode: output.parentInode,
        }));
      } catch (error) {
        removalDurable = false;
        cleanupErrors.push(error);
      }
      if (directoryLease !== undefined && removalDurable) {
        try {
          releaseBeeperMessageLikeMeDirectoryLease(directoryLease);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          "Beeper Message Like Me export: publication and cleanup both failed",
        );
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      throw new AggregateError(
        cleanupErrors,
        "Beeper Message Like Me export: cleanup failed",
      );
    }
  }
}

export async function exportBeeperMessageLikeMeBundle(
  request: BeeperMessageLikeMeExportRequest,
): Promise<BeeperMessageLikeMeExportResult> {
  assertSource(request.source);
  let publication: PublishedBundle | undefined;
  let publicationFailed = false;
  let publicationError: unknown;
  try {
    publication = await publishBeeperMessageLikeMeBundle(request);
    return publication.result;
  } catch (error) {
    publicationFailed = true;
    publicationError = error;
    throw error;
  } finally {
    const finalizationErrors: unknown[] = [];
    const cleanupHeartbeat = request.source.dispose === undefined
      ? undefined
      : startPrivateCleanupHeartbeat(request);
    try {
      await request.source.dispose?.(publication !== undefined);
    } catch (error) {
      finalizationErrors.push(error);
    }
    let releaseAttempted = false;
    if (
      publication !== undefined
      && finalizationErrors.length === 0
      && publication.directoryLease !== undefined
    ) {
      releaseAttempted = true;
      try {
        releaseBeeperMessageLikeMeDirectoryLease(publication.directoryLease);
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    cleanupHeartbeat?.stop();
    try {
      cleanupHeartbeat?.assertHealthy();
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (finalizationErrors.length > 0) {
      const errors = publicationFailed
        ? [publicationError, ...finalizationErrors]
        : [...finalizationErrors];
      if (publication !== undefined) {
        let rollbackDurable = true;
        try {
          await removeOwnedPrivateDirectory(
            publication.directory.path,
            publication.directory.identity,
          );
        } catch (error) {
          rollbackDurable = false;
          errors.push(error);
        }
        try {
          await syncDirectory(
            publication.directory.parent,
            publication.directory.parentIdentity,
          );
        } catch (error) {
          rollbackDurable = false;
          errors.push(error);
        }
        if (
          rollbackDurable
          && !releaseAttempted
          && publication.directoryLease !== undefined
        ) {
          try {
            releaseBeeperMessageLikeMeDirectoryLease(
              publication.directoryLease,
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > finalizationErrors.length) {
          throw new AggregateError(
            errors,
            "Beeper Message Like Me export: finalization and published output rollback failed",
          );
        }
      }
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(
        errors,
        publicationFailed
          ? "Beeper Message Like Me export: publication and source disposal both failed"
          : "Beeper Message Like Me export: finalization failed",
      );
    }
  }
}
