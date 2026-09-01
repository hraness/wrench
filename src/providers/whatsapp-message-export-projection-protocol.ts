import { types as nodeTypes } from "node:util";

export const WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION = 1 as const;
export const WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_LIMIT = 500;
export const WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDIN_BYTES = 16 * 1024;
export const WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT =
  "sha256:994b5024bc2479a269866060ea14a06230532b5aba8365d31b1f94113df3bc57" as const;

const MAX_ROWID = 9_223_372_036_854_775_807n;
const ROWID_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PN_SUBJECT_PATTERN = /^whatsapp:pn:[1-9][0-9]{4,14}$/u;
const LID_SUBJECT_PATTERN = /^whatsapp:lid:[1-9][0-9]{4,19}$/u;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._~:-]{1,256}$/u;
const JID_PATTERN = /^(?:[1-9][0-9]{4,14}(?::[0-9]{1,5})?@s\.whatsapp\.net|[1-9][0-9]{4,19}(?::[0-9]{1,5})?@lid|[1-9][0-9]{4,19}(?:-[1-9][0-9]{0,19})?@g\.us)$/u;

export type WhatsAppMessageExportFileIdentity = Readonly<{
  dev: string;
  ino: string;
}>;

export type WhatsAppMessageExportProjectionGeneration = Readonly<{
  messageStoreIdentity: WhatsAppMessageExportFileIdentity;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  schemaFingerprint: typeof WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT;
}>;

export type WhatsAppMessageExportProjectionRequest = Readonly<{
  schemaVersion: typeof WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION;
  operation: "message-like-me.export";
  accountSubject: string;
  cursor: string;
  cursorAnchor: string | null;
  limit: number;
  expectedGeneration: WhatsAppMessageExportProjectionGeneration | null;
  storeIdentity: WhatsAppMessageExportFileIdentity;
  sessionIdentity: WhatsAppMessageExportFileIdentity;
  messageStoreIdentity: WhatsAppMessageExportFileIdentity;
}>;

export type WhatsAppMessageExportProjectionItem = Readonly<{
  rowid: string;
  chatJid: string;
  chatKind: "dm" | "group";
  chatName: string | null;
  messageId: string;
  senderJid: string | null;
  senderName: string | null;
  timestamp: string;
  fromMe: boolean;
  text: string | null;
  displayText: string | null;
  quotedMessageId: string | null;
  quotedSenderJid: string | null;
  reactionToMessageId: string | null;
  reactionEmoji: string | null;
  mediaType: string | null;
  mediaCaption: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileLength: number | null;
  revoked: boolean;
  deletedForMe: boolean;
  deletedAt: string | null;
  payloadPurgedAt: string | null;
  edited: boolean;
  editedAt: string | null;
}>;

export const WHATSAPP_MESSAGE_EXPORT_PROJECTION_ERROR_CODES = Object.freeze([
  "request-invalid",
  "store-binding-invalid",
  "session-binding-invalid",
  "message-store-file-invalid",
  "message-store-file-too-large",
  "message-store-sidecar-present",
  "message-store-sidecar-state-unverified",
  "database-invalid",
  "database-integrity-failed",
  "schema-mismatch",
  "owner-mismatch",
  "generation-mismatch",
  "projection-invalid",
  "output-too-large",
] as const);

export type WhatsAppMessageExportProjectionErrorCode =
  (typeof WHATSAPP_MESSAGE_EXPORT_PROJECTION_ERROR_CODES)[number];

export type WhatsAppMessageExportProjectionSuccess = Readonly<{
  schemaVersion: typeof WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION;
  status: "succeeded";
  projectionGeneration: WhatsAppMessageExportProjectionGeneration;
  messages: readonly WhatsAppMessageExportProjectionItem[];
  nextCursor: string | null;
  localInsertPageComplete: boolean;
  checkpoint: Readonly<{ cursor: string; anchor: string | null }>;
}>;

export type WhatsAppMessageExportProjectionFailure = Readonly<{
  schemaVersion: typeof WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION;
  status: "failed";
  errorCode: WhatsAppMessageExportProjectionErrorCode;
}>;

export type WhatsAppMessageExportProjectionResponse =
  | WhatsAppMessageExportProjectionSuccess
  | WhatsAppMessageExportProjectionFailure;

type JsonRecord = Readonly<Record<string, unknown>>;

function fail(label: string): never {
  throw new Error(`${label} did not match the WhatsApp message export projection protocol`);
}

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) return fail(label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail(label);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(label);
    }
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(label);
}

function unsigned(value: unknown, label: string, allowZero = true): string {
  if (typeof value !== "string" || !ROWID_PATTERN.test(value) || BigInt(value) > MAX_ROWID) {
    return fail(label);
  }
  if (!allowZero && value === "0") return fail(label);
  return value;
}

function fileIdentity(value: unknown, label: string): WhatsAppMessageExportFileIdentity {
  const parsed = record(value, label);
  exactKeys(parsed, ["dev", "ino"], label);
  return Object.freeze({
    dev: unsigned(parsed.dev, `${label}.dev`),
    ino: unsigned(parsed.ino, `${label}.ino`, false),
  });
}

function generation(value: unknown, label: string): WhatsAppMessageExportProjectionGeneration {
  const parsed = record(value, label);
  exactKeys(parsed, ["messageStoreIdentity", "size", "mtimeNs", "ctimeNs", "schemaFingerprint"], label);
  if (parsed.schemaFingerprint !== WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT) fail(label);
  return Object.freeze({
    messageStoreIdentity: fileIdentity(parsed.messageStoreIdentity, `${label}.messageStoreIdentity`),
    size: unsigned(parsed.size, `${label}.size`, false),
    mtimeNs: unsigned(parsed.mtimeNs, `${label}.mtimeNs`),
    ctimeNs: unsigned(parsed.ctimeNs, `${label}.ctimeNs`),
    schemaFingerprint: WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
  });
}

function sameGeneration(
  left: WhatsAppMessageExportProjectionGeneration,
  right: WhatsAppMessageExportProjectionGeneration,
): boolean {
  return left.messageStoreIdentity.dev === right.messageStoreIdentity.dev
    && left.messageStoreIdentity.ino === right.messageStoreIdentity.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.schemaFingerprint === right.schemaFingerprint;
}

function text(value: unknown, label: string, maximum: number, nullable = true): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) return fail(label);
  return value;
}

function jid(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === null || value === "")) return null;
  if (typeof value !== "string" || value.length > 96 || !JID_PATTERN.test(value)) return fail(label);
  return value;
}

function messageId(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === null || value === "")) return null;
  if (typeof value !== "string" || !MESSAGE_ID_PATTERN.test(value)) return fail(label);
  return value;
}

function timestamp(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") return fail(label);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return fail(label);
  return value;
}

function item(value: unknown, label: string): WhatsAppMessageExportProjectionItem {
  const parsed = record(value, label);
  exactKeys(parsed, [
    "rowid", "chatJid", "chatKind", "chatName", "messageId", "senderJid", "senderName",
    "timestamp", "fromMe", "text", "displayText", "quotedMessageId", "quotedSenderJid",
    "reactionToMessageId", "reactionEmoji", "mediaType", "mediaCaption", "fileName",
    "mimeType", "fileLength", "revoked", "deletedForMe", "deletedAt", "payloadPurgedAt",
    "edited", "editedAt",
  ], label);
  if (
    (parsed.chatKind !== "dm" && parsed.chatKind !== "group")
    || typeof parsed.fromMe !== "boolean"
    || typeof parsed.revoked !== "boolean"
    || typeof parsed.deletedForMe !== "boolean"
    || typeof parsed.edited !== "boolean"
    || (parsed.fileLength !== null && (
      typeof parsed.fileLength !== "number"
      || !Number.isSafeInteger(parsed.fileLength)
      || parsed.fileLength < 0
    ))
  ) return fail(label);
  const fileName = text(parsed.fileName, `${label}.fileName`, 8 * 1024);
  if (fileName !== null && (fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\"))) {
    return fail(`${label}.fileName`);
  }
  const sentAt = timestamp(parsed.timestamp, `${label}.timestamp`)! as string;
  const editedAt = timestamp(parsed.editedAt, `${label}.editedAt`, true);
  if ((parsed.edited && editedAt === null) || (!parsed.edited && editedAt !== null) || (editedAt !== null && editedAt < sentAt)) {
    return fail(`${label}.editedAt`);
  }
  return Object.freeze({
    rowid: unsigned(parsed.rowid, `${label}.rowid`, false),
    chatJid: jid(parsed.chatJid, `${label}.chatJid`)! as string,
    chatKind: parsed.chatKind,
    chatName: text(parsed.chatName, `${label}.chatName`, 8 * 1024),
    messageId: messageId(parsed.messageId, `${label}.messageId`)! as string,
    senderJid: jid(parsed.senderJid, `${label}.senderJid`, true),
    senderName: text(parsed.senderName, `${label}.senderName`, 8 * 1024),
    timestamp: sentAt,
    fromMe: parsed.fromMe,
    text: text(parsed.text, `${label}.text`, 1024 * 1024),
    displayText: text(parsed.displayText, `${label}.displayText`, 1024 * 1024),
    quotedMessageId: messageId(parsed.quotedMessageId, `${label}.quotedMessageId`, true),
    quotedSenderJid: jid(parsed.quotedSenderJid, `${label}.quotedSenderJid`, true),
    reactionToMessageId: messageId(parsed.reactionToMessageId, `${label}.reactionToMessageId`, true),
    reactionEmoji: text(parsed.reactionEmoji, `${label}.reactionEmoji`, 8 * 1024),
    mediaType: text(parsed.mediaType, `${label}.mediaType`, 256),
    mediaCaption: text(parsed.mediaCaption, `${label}.mediaCaption`, 1024 * 1024),
    fileName,
    mimeType: text(parsed.mimeType, `${label}.mimeType`, 256),
    fileLength: parsed.fileLength as number | null,
    revoked: parsed.revoked,
    deletedForMe: parsed.deletedForMe,
    deletedAt: timestamp(parsed.deletedAt, `${label}.deletedAt`, true),
    payloadPurgedAt: timestamp(parsed.payloadPurgedAt, `${label}.payloadPurgedAt`, true),
    edited: parsed.edited,
    editedAt,
  });
}

export function parseWhatsAppMessageExportProjectionRequest(
  value: unknown,
): WhatsAppMessageExportProjectionRequest {
  const parsed = record(value, "request");
  exactKeys(parsed, [
    "schemaVersion", "operation", "accountSubject", "cursor", "cursorAnchor", "limit",
    "expectedGeneration", "storeIdentity", "sessionIdentity", "messageStoreIdentity",
  ], "request");
  if (
    parsed.schemaVersion !== WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION
    || parsed.operation !== "message-like-me.export"
    || typeof parsed.accountSubject !== "string"
    || (!PN_SUBJECT_PATTERN.test(parsed.accountSubject) && !LID_SUBJECT_PATTERN.test(parsed.accountSubject))
    || typeof parsed.limit !== "number"
    || !Number.isSafeInteger(parsed.limit)
    || parsed.limit < 1
    || parsed.limit > WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_LIMIT
  ) return fail("request");
  const cursor = unsigned(parsed.cursor, "request.cursor");
  const cursorAnchor = parsed.cursorAnchor === null
    ? null
    : typeof parsed.cursorAnchor === "string" && SHA256_PATTERN.test(parsed.cursorAnchor)
      ? parsed.cursorAnchor
      : fail("request.cursorAnchor");
  const expectedGeneration = parsed.expectedGeneration === null
    ? null
    : generation(parsed.expectedGeneration, "request.expectedGeneration");
  if (
    (cursor === "0") !== (cursorAnchor === null)
    || (cursor === "0") !== (expectedGeneration === null)
  ) return fail("request checkpoint");
  const messageStoreIdentity = fileIdentity(parsed.messageStoreIdentity, "request.messageStoreIdentity");
  if (expectedGeneration !== null && (
    expectedGeneration.messageStoreIdentity.dev !== messageStoreIdentity.dev
    || expectedGeneration.messageStoreIdentity.ino !== messageStoreIdentity.ino
  )) return fail("request.expectedGeneration");
  return Object.freeze({
    schemaVersion: WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
    operation: "message-like-me.export",
    accountSubject: parsed.accountSubject,
    cursor,
    cursorAnchor,
    limit: parsed.limit,
    expectedGeneration,
    storeIdentity: fileIdentity(parsed.storeIdentity, "request.storeIdentity"),
    sessionIdentity: fileIdentity(parsed.sessionIdentity, "request.sessionIdentity"),
    messageStoreIdentity,
  });
}

export function parseWhatsAppMessageExportProjectionResponse(
  value: unknown,
  request?: WhatsAppMessageExportProjectionRequest,
): WhatsAppMessageExportProjectionResponse {
  const parsed = record(value, "response");
  if (parsed.status === "failed") {
    exactKeys(parsed, ["schemaVersion", "status", "errorCode"], "response");
    if (
      parsed.schemaVersion !== WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION
      || typeof parsed.errorCode !== "string"
      || !(WHATSAPP_MESSAGE_EXPORT_PROJECTION_ERROR_CODES as readonly string[]).includes(parsed.errorCode)
    ) return fail("response");
    return Object.freeze({
      schemaVersion: WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
      status: "failed",
      errorCode: parsed.errorCode as WhatsAppMessageExportProjectionErrorCode,
    });
  }
  exactKeys(parsed, [
    "schemaVersion", "status", "projectionGeneration", "messages", "nextCursor",
    "localInsertPageComplete", "checkpoint",
  ], "response");
  if (
    parsed.schemaVersion !== WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION
    || parsed.status !== "succeeded"
    || !Array.isArray(parsed.messages)
    || parsed.messages.length > WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_LIMIT
    || typeof parsed.localInsertPageComplete !== "boolean"
  ) return fail("response");
  const projectionGeneration = generation(parsed.projectionGeneration, "response.projectionGeneration");
  if (request !== undefined && (
    projectionGeneration.messageStoreIdentity.dev !== request.messageStoreIdentity.dev
    || projectionGeneration.messageStoreIdentity.ino !== request.messageStoreIdentity.ino
    || (request.expectedGeneration !== null && !sameGeneration(projectionGeneration, request.expectedGeneration))
    || parsed.messages.length > request.limit
    || (!parsed.localInsertPageComplete && parsed.messages.length !== request.limit)
  )) return fail("response projection binding");
  const messages = parsed.messages.map((value, index) => item(value, `response.messages[${index}]`));
  for (let index = 0; index < messages.length; index += 1) {
    const previous = index === 0 ? request?.cursor : messages[index - 1]?.rowid;
    if (previous !== undefined && BigInt(messages[index]!.rowid) <= BigInt(previous)) {
      return fail("response.messages ordering");
    }
  }
  const nextCursor = parsed.nextCursor === null
    ? null
    : unsigned(parsed.nextCursor, "response.nextCursor", false);
  if (
    (parsed.localInsertPageComplete && nextCursor !== null)
    || (!parsed.localInsertPageComplete && (messages.length === 0 || nextCursor !== messages.at(-1)?.rowid))
  ) return fail("response.nextCursor");
  const checkpoint = record(parsed.checkpoint, "response.checkpoint");
  exactKeys(checkpoint, ["cursor", "anchor"], "response.checkpoint");
  const checkpointCursor = unsigned(checkpoint.cursor, "response.checkpoint.cursor");
  const checkpointAnchor = checkpoint.anchor === null
    ? null
    : typeof checkpoint.anchor === "string" && SHA256_PATTERN.test(checkpoint.anchor)
      ? checkpoint.anchor
      : fail("response.checkpoint.anchor");
  if (
    (checkpointCursor === "0") !== (checkpointAnchor === null)
    || (messages.length > 0 && checkpointCursor !== messages.at(-1)?.rowid)
    || (messages.length === 0 && request !== undefined
      && (checkpointCursor !== request.cursor || checkpointAnchor !== request.cursorAnchor))
    || (!parsed.localInsertPageComplete && checkpointCursor !== nextCursor)
  ) return fail("response.checkpoint");
  return Object.freeze({
    schemaVersion: WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
    status: "succeeded",
    projectionGeneration,
    messages: Object.freeze(messages),
    nextCursor,
    localInsertPageComplete: parsed.localInsertPageComplete,
    checkpoint: Object.freeze({ cursor: checkpointCursor, anchor: checkpointAnchor }),
  });
}

export function createWhatsAppMessageExportProjectionFailure(
  errorCode: WhatsAppMessageExportProjectionErrorCode,
): WhatsAppMessageExportProjectionFailure {
  if (!(WHATSAPP_MESSAGE_EXPORT_PROJECTION_ERROR_CODES as readonly string[]).includes(errorCode)) {
    return fail("errorCode");
  }
  return Object.freeze({
    schemaVersion: WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
    status: "failed",
    errorCode,
  });
}
