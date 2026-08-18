export const WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION = 1 as const;
export const WHATSAPP_INTERACTION_PROJECTION_MAX_LIMIT = 1_000;
export const WHATSAPP_INTERACTION_PROJECTION_MAX_STDIN_BYTES = 8 * 1024;
export const WHATSAPP_INTERACTION_PROJECTION_MAX_STDOUT_BYTES = 1024 * 1024;
export const WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT =
  "sha256:994c43a93c88aea9775e9cae94a31f190b158ae0a423a1b0ee0fda83107b4d6c" as const;

const MAX_ROWID = 9_223_372_036_854_775_807n;
const ROWID_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const PN_SUBJECT_PATTERN = /^whatsapp:pn:[0-9]{5,20}$/u;
const LID_SUBJECT_PATTERN = /^whatsapp:lid:[0-9]{5,32}$/u;
const JID_PATTERNS = [
  /^[0-9]{5,20}(?::[0-9]{1,5})?@s\.whatsapp\.net$/u,
  /^[0-9]{5,32}(?::[0-9]{1,5})?@lid$/u,
  /^[0-9]{5,32}(?:-[0-9]{5,20})?@g\.us$/u,
  /^[0-9]{5,32}@newsletter$/u,
  /^(?:status|[0-9]{5,32})@broadcast$/u,
] as const;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._~:-]{1,256}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CHAT_KINDS = new Set(["dm", "group", "broadcast", "newsletter", "unknown"]);

export type WhatsAppInteractionProjectionFileIdentity = Readonly<{
  dev: string;
  ino: string;
}>;

export type WhatsAppInteractionProjectionRequest = Readonly<{
  schemaVersion: typeof WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION;
  operation: "contacts.interactions.list";
  accountSubject: string;
  cursor: string;
  cursorAnchor: string | null;
  limit: number;
  storeIdentity: WhatsAppInteractionProjectionFileIdentity;
  sessionIdentity: WhatsAppInteractionProjectionFileIdentity;
  messageStoreIdentity: WhatsAppInteractionProjectionFileIdentity;
}>;

export type WhatsAppInteractionProjectionItem = Readonly<{
  rowid: string;
  chatJid: string;
  messageId: string;
  senderJid: string | null;
  timestamp: string;
  fromMe: boolean;
  chatKind: "dm" | "group" | "broadcast" | "newsletter" | "unknown";
}>;

export const WHATSAPP_INTERACTION_PROJECTION_ERROR_CODES = Object.freeze([
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
  "projection-invalid",
  "output-too-large",
] as const);

export type WhatsAppInteractionProjectionErrorCode =
  (typeof WHATSAPP_INTERACTION_PROJECTION_ERROR_CODES)[number];

export type WhatsAppInteractionProjectionSuccess = Readonly<{
  schemaVersion: typeof WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION;
  status: "succeeded";
  projectionGeneration: Readonly<{
    messageStoreIdentity: WhatsAppInteractionProjectionFileIdentity;
    schemaFingerprint: typeof WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT;
  }>;
  interactions: readonly WhatsAppInteractionProjectionItem[];
  nextCursor: string | null;
  localInsertPageComplete: boolean;
  checkpoint: Readonly<{
    cursor: string;
    anchor: string | null;
  }>;
}>;

export type WhatsAppInteractionProjectionFailure = Readonly<{
  schemaVersion: typeof WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION;
  status: "failed";
  errorCode: WhatsAppInteractionProjectionErrorCode;
}>;

export type WhatsAppInteractionProjectionResponse =
  | WhatsAppInteractionProjectionSuccess
  | WhatsAppInteractionProjectionFailure;

type JsonRecord = Readonly<Record<string, unknown>>;

function fail(label: string): never {
  throw new Error(`${label} did not match the WhatsApp interaction projection protocol`);
}

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) return fail(label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail(label);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(label);
    }
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(label);
  }
}

function fileIdentity(value: unknown, label: string): WhatsAppInteractionProjectionFileIdentity {
  const parsed = record(value, label);
  exactKeys(parsed, ["dev", "ino"], label);
  if (
    typeof parsed.dev !== "string"
    || !ROWID_PATTERN.test(parsed.dev)
    || typeof parsed.ino !== "string"
    || !ROWID_PATTERN.test(parsed.ino)
    || BigInt(parsed.ino) === 0n
  ) fail(label);
  return Object.freeze({ dev: parsed.dev, ino: parsed.ino });
}

export function parseWhatsAppInteractionRowid(value: unknown, label = "rowid"): string {
  if (typeof value !== "string" || !ROWID_PATTERN.test(value) || BigInt(value) > MAX_ROWID) {
    return fail(label);
  }
  return value;
}

function accountSubject(value: unknown): string {
  if (typeof value !== "string" || (!PN_SUBJECT_PATTERN.test(value) && !LID_SUBJECT_PATTERN.test(value))) {
    return fail("accountSubject");
  }
  return value;
}

function jid(
  value: unknown,
  label: string,
  nullable = false,
  allowDevice = false,
): string | null {
  if (nullable && (value === null || value === "")) return null;
  if (
    typeof value !== "string"
    || value.length > 96
    || (!allowDevice && value.includes(":"))
  ) return fail(label);
  if (!JID_PATTERNS.some((pattern) => pattern.test(value))) return fail(label);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) return fail(label);
  return value;
}

export function parseWhatsAppInteractionProjectionRequest(
  value: unknown,
): WhatsAppInteractionProjectionRequest {
  const parsed = record(value, "request");
  exactKeys(parsed, [
    "schemaVersion", "operation", "accountSubject", "cursor", "limit",
    "cursorAnchor", "storeIdentity", "sessionIdentity", "messageStoreIdentity",
  ], "request");
  if (
    parsed.schemaVersion !== WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION
    || parsed.operation !== "contacts.interactions.list"
    || typeof parsed.limit !== "number"
    || !Number.isSafeInteger(parsed.limit)
    || parsed.limit < 1
    || parsed.limit > WHATSAPP_INTERACTION_PROJECTION_MAX_LIMIT
  ) fail("request");
  const cursor = parseWhatsAppInteractionRowid(parsed.cursor, "request.cursor");
  const cursorAnchor = parsed.cursorAnchor === null
    ? null
    : typeof parsed.cursorAnchor === "string" && SHA256_PATTERN.test(parsed.cursorAnchor)
      ? parsed.cursorAnchor
      : fail("request.cursorAnchor");
  if ((cursor === "0") !== (cursorAnchor === null)) fail("request.cursorAnchor");
  return Object.freeze({
    schemaVersion: WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION,
    operation: "contacts.interactions.list",
    accountSubject: accountSubject(parsed.accountSubject),
    cursor,
    cursorAnchor,
    limit: parsed.limit,
    storeIdentity: fileIdentity(parsed.storeIdentity, "request.storeIdentity"),
    sessionIdentity: fileIdentity(parsed.sessionIdentity, "request.sessionIdentity"),
    messageStoreIdentity: fileIdentity(
      parsed.messageStoreIdentity,
      "request.messageStoreIdentity",
    ),
  });
}

function interaction(value: unknown, label: string): WhatsAppInteractionProjectionItem {
  const parsed = record(value, label);
  exactKeys(parsed, [
    "rowid", "chatJid", "messageId", "senderJid", "timestamp", "fromMe", "chatKind",
  ], label);
  const rowid = parseWhatsAppInteractionRowid(parsed.rowid, `${label}.rowid`);
  if (BigInt(rowid) < 1n) fail(`${label}.rowid`);
  const messageId = parsed.messageId;
  if (
    typeof messageId !== "string"
    || !MESSAGE_ID_PATTERN.test(messageId)
    || typeof parsed.fromMe !== "boolean"
    || typeof parsed.chatKind !== "string"
    || !CHAT_KINDS.has(parsed.chatKind)
  ) fail(label);
  return Object.freeze({
    rowid,
    chatJid: jid(parsed.chatJid, `${label}.chatJid`)! as string,
    messageId,
    senderJid: jid(parsed.senderJid, `${label}.senderJid`, true, true),
    timestamp: timestamp(parsed.timestamp, `${label}.timestamp`),
    fromMe: parsed.fromMe,
    chatKind: parsed.chatKind as WhatsAppInteractionProjectionItem["chatKind"],
  });
}

export function parseWhatsAppInteractionProjectionResponse(
  value: unknown,
  request?: Pick<
    WhatsAppInteractionProjectionRequest,
    "cursor" | "cursorAnchor" | "limit" | "messageStoreIdentity"
  >,
): WhatsAppInteractionProjectionResponse {
  const parsed = record(value, "response");
  if (parsed.status === "failed") {
    exactKeys(parsed, ["schemaVersion", "status", "errorCode"], "response");
    if (
      parsed.schemaVersion !== WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION
      || typeof parsed.errorCode !== "string"
      || !(WHATSAPP_INTERACTION_PROJECTION_ERROR_CODES as readonly string[]).includes(parsed.errorCode)
    ) fail("response");
    return Object.freeze({
      schemaVersion: WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION,
      status: "failed",
      errorCode: parsed.errorCode as WhatsAppInteractionProjectionErrorCode,
    });
  }
  exactKeys(parsed, [
    "schemaVersion", "status", "projectionGeneration", "interactions", "nextCursor",
    "localInsertPageComplete", "checkpoint",
  ], "response");
  if (
    parsed.schemaVersion !== WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION
    || parsed.status !== "succeeded"
    || !Array.isArray(parsed.interactions)
    || parsed.interactions.length > WHATSAPP_INTERACTION_PROJECTION_MAX_LIMIT
    || typeof parsed.localInsertPageComplete !== "boolean"
  ) fail("response");
  const projectionGeneration = record(
    parsed.projectionGeneration,
    "response.projectionGeneration",
  );
  exactKeys(projectionGeneration, [
    "messageStoreIdentity", "schemaFingerprint",
  ], "response.projectionGeneration");
  const messageStoreIdentity = fileIdentity(
    projectionGeneration.messageStoreIdentity,
    "response.projectionGeneration.messageStoreIdentity",
  );
  if (
    projectionGeneration.schemaFingerprint
      !== WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT
    || (request !== undefined
      && (messageStoreIdentity.dev !== request.messageStoreIdentity.dev
        || messageStoreIdentity.ino !== request.messageStoreIdentity.ino))
  ) fail("response.projectionGeneration");
  if (request !== undefined && (
    parsed.interactions.length > request.limit
    || (!parsed.localInsertPageComplete && parsed.interactions.length !== request.limit)
  )) fail("response.interactions");
  const interactions = parsed.interactions.map((item, index) =>
    interaction(item, `response.interactions[${index}]`));
  for (let index = 0; index < interactions.length; index += 1) {
    const previous = index === 0 ? request?.cursor : interactions[index - 1]?.rowid;
    if (previous !== undefined && BigInt(interactions[index]!.rowid) <= BigInt(previous)) {
      fail("response.interactions ordering");
    }
  }
  const nextCursor = parsed.nextCursor === null
    ? null
    : parseWhatsAppInteractionRowid(parsed.nextCursor, "response.nextCursor");
  if (
    (parsed.localInsertPageComplete && nextCursor !== null)
    || (!parsed.localInsertPageComplete
      && (interactions.length === 0 || nextCursor !== interactions.at(-1)?.rowid))
  ) fail("response.nextCursor");
  const checkpoint = record(parsed.checkpoint, "response.checkpoint");
  exactKeys(checkpoint, ["cursor", "anchor"], "response.checkpoint");
  const checkpointCursor = parseWhatsAppInteractionRowid(
    checkpoint.cursor,
    "response.checkpoint.cursor",
  );
  const checkpointAnchor = checkpoint.anchor === null
    ? null
    : typeof checkpoint.anchor === "string" && SHA256_PATTERN.test(checkpoint.anchor)
      ? checkpoint.anchor
      : fail("response.checkpoint.anchor");
  if (
    (checkpointCursor === "0") !== (checkpointAnchor === null)
    || (interactions.length > 0
      && checkpointCursor !== interactions.at(-1)?.rowid)
    || (interactions.length === 0 && request !== undefined
      && (checkpointCursor !== request.cursor || checkpointAnchor !== request.cursorAnchor))
    || (!parsed.localInsertPageComplete && nextCursor !== checkpointCursor)
  ) fail("response.checkpoint");
  return Object.freeze({
    schemaVersion: WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION,
    status: "succeeded",
    projectionGeneration: Object.freeze({
      messageStoreIdentity,
      schemaFingerprint: WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT,
    }),
    interactions: Object.freeze(interactions),
    nextCursor,
    localInsertPageComplete: parsed.localInsertPageComplete,
    checkpoint: Object.freeze({ cursor: checkpointCursor, anchor: checkpointAnchor }),
  });
}

export function createWhatsAppInteractionProjectionFailure(
  errorCode: WhatsAppInteractionProjectionErrorCode,
): WhatsAppInteractionProjectionFailure {
  if (!(WHATSAPP_INTERACTION_PROJECTION_ERROR_CODES as readonly string[]).includes(errorCode)) {
    return fail("errorCode");
  }
  return Object.freeze({
    schemaVersion: WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION,
    status: "failed",
    errorCode,
  });
}
