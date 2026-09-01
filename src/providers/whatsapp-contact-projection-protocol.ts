export const WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION = 1 as const;

export const WHATSAPP_CONTACT_PROJECTION_MAX_LIMIT = 100;
export const WHATSAPP_CONTACT_PROJECTION_MAX_STDIN_BYTES = 8 * 1024;
export const WHATSAPP_CONTACT_PROJECTION_MAX_STDOUT_BYTES = 1024 * 1024;

export function isExactWhatsAppContactProjectionMode(
  mode: number | bigint,
  expected: 0o600 | 0o700,
): boolean {
  return typeof mode === "bigint"
    ? (mode & 0o7777n) === BigInt(expected)
    : Number.isSafeInteger(mode) && (mode & 0o7777) === expected;
}

const MAX_JID_LENGTH = 96;
const MAX_NAME_LENGTH = 512;
const MAX_REDACTED_PHONE_LENGTH = 64;
const IDENTITY_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
// Read-only compatibility keeps historic local auth subjects parseable. New
// pairings use whatsapp-account-identity's narrower export-compatible grammar.
const PN_SUBJECT_PATTERN = /^whatsapp:pn:([0-9]{5,20})$/u;
const LID_SUBJECT_PATTERN = /^whatsapp:lid:([0-9]{5,32})$/u;
const CONTACT_PN_JID_PATTERN = /^([0-9]{5,20})@s\.whatsapp\.net$/u;
const CONTACT_LID_JID_PATTERN = /^([0-9]{5,32})@lid$/u;

export type WhatsAppContactProjectionFileIdentity = Readonly<{
  dev: string;
  ino: string;
}>;

export type WhatsAppContactProjectionRequest = Readonly<{
  schemaVersion: typeof WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION;
  operation: "contacts.list";
  accountSubject: string;
  cursor: string | null;
  limit: number;
  storeIdentity: WhatsAppContactProjectionFileIdentity;
  sessionIdentity: WhatsAppContactProjectionFileIdentity;
}>;

export type WhatsAppContactDisplayNameBasis =
  | "full-name"
  | "push-name"
  | "business-name"
  | "first-name"
  | "redacted-phone"
  | "phone"
  | "unavailable";

export type WhatsAppContactProjectionContact = Readonly<{
  providerId: string;
  jidKind: "user" | "lid";
  phone: string | null;
  redactedPhone: string | null;
  firstName: string | null;
  fullName: string | null;
  pushName: string | null;
  businessName: string | null;
  displayName: string | null;
  displayNameBasis: WhatsAppContactDisplayNameBasis;
}>;

export const WHATSAPP_CONTACT_PROJECTION_ERROR_CODES = Object.freeze([
  "request-invalid",
  "store-binding-invalid",
  "session-file-invalid",
  "session-file-too-large",
  "session-sidecar-present",
  "session-sidecar-state-unverified",
  "session-read-failed",
  "database-invalid",
  "database-integrity-failed",
  "schema-mismatch",
  "owner-mismatch",
  "projection-invalid",
  "output-too-large",
] as const);

export type WhatsAppContactProjectionErrorCode =
  (typeof WHATSAPP_CONTACT_PROJECTION_ERROR_CODES)[number];

export type WhatsAppContactProjectionSuccess = Readonly<{
  schemaVersion: typeof WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION;
  status: "succeeded";
  contacts: readonly WhatsAppContactProjectionContact[];
  nextCursor: string | null;
  localContactTablePageComplete: boolean;
}>;

export type WhatsAppContactProjectionFailure = Readonly<{
  schemaVersion: typeof WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION;
  status: "failed";
  errorCode: WhatsAppContactProjectionErrorCode;
}>;

export type WhatsAppContactProjectionResponse =
  | WhatsAppContactProjectionSuccess
  | WhatsAppContactProjectionFailure;

type JsonRecord = Readonly<Record<string, unknown>>;

function fail(label: string): never {
  throw new Error(`${label} did not match the WhatsApp contact projection protocol`);
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
  ) return fail(label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail(label);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(label);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) fail(label);
}

function identity(
  value: unknown,
  label: string,
): WhatsAppContactProjectionFileIdentity {
  const parsed = record(value, label);
  exactKeys(parsed, ["dev", "ino"], label);
  if (
    typeof parsed.dev !== "string"
    || !IDENTITY_PATTERN.test(parsed.dev)
    || typeof parsed.ino !== "string"
    || !IDENTITY_PATTERN.test(parsed.ino)
    || BigInt(parsed.ino) === 0n
  ) fail(label);
  return Object.freeze({ dev: parsed.dev, ino: parsed.ino });
}

export function parseWhatsAppContactProjectionSubject(value: unknown): Readonly<{
  kind: "pn" | "lid";
  id: string;
  subject: string;
}> {
  if (typeof value !== "string") return fail("accountSubject");
  const pn = PN_SUBJECT_PATTERN.exec(value);
  if (pn !== null && pn[1] !== undefined) {
    return Object.freeze({ kind: "pn", id: pn[1], subject: value });
  }
  const lid = LID_SUBJECT_PATTERN.exec(value);
  if (lid !== null && lid[1] !== undefined) {
    return Object.freeze({ kind: "lid", id: lid[1], subject: value });
  }
  return fail("accountSubject");
}

export function parseWhatsAppContactProjectionJid(value: unknown): Readonly<{
  jid: string;
  id: string;
  kind: "user" | "lid";
}> {
  if (typeof value !== "string" || value.length > MAX_JID_LENGTH) {
    return fail("contact JID");
  }
  const phone = CONTACT_PN_JID_PATTERN.exec(value);
  const lid = CONTACT_LID_JID_PATTERN.exec(value);
  const id = phone?.[1] ?? lid?.[1];
  if (id === undefined) {
    return fail("contact JID");
  }
  return Object.freeze({
    jid: value,
    id,
    kind: phone === null ? "lid" : "user",
  });
}

export function parseWhatsAppContactProjectionRequest(
  value: unknown,
): WhatsAppContactProjectionRequest {
  const parsed = record(value, "request");
  exactKeys(parsed, [
    "schemaVersion",
    "operation",
    "accountSubject",
    "cursor",
    "limit",
    "storeIdentity",
    "sessionIdentity",
  ], "request");
  if (
    parsed.schemaVersion !== WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION
    || parsed.operation !== "contacts.list"
  ) fail("request");
  const accountSubject = parseWhatsAppContactProjectionSubject(
    parsed.accountSubject,
  ).subject;
  const cursor = parsed.cursor === null
    ? null
    : parseWhatsAppContactProjectionJid(parsed.cursor).jid;
  if (
    typeof parsed.limit !== "number"
    || !Number.isSafeInteger(parsed.limit)
    || parsed.limit < 1
    || parsed.limit > WHATSAPP_CONTACT_PROJECTION_MAX_LIMIT
  ) fail("request.limit");
  return Object.freeze({
    schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
    operation: "contacts.list",
    accountSubject,
    cursor,
    limit: parsed.limit,
    storeIdentity: identity(parsed.storeIdentity, "request.storeIdentity"),
    sessionIdentity: identity(parsed.sessionIdentity, "request.sessionIdentity"),
  });
}

function optionalText(value: unknown, maximum: number, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) return fail(label);
  return value;
}

function contact(
  value: unknown,
  label: string,
): WhatsAppContactProjectionContact {
  const parsed = record(value, label);
  exactKeys(parsed, [
    "providerId",
    "jidKind",
    "phone",
    "redactedPhone",
    "firstName",
    "fullName",
    "pushName",
    "businessName",
    "displayName",
    "displayNameBasis",
  ], label);
  const jid = parseWhatsAppContactProjectionJid(parsed.providerId);
  if (parsed.jidKind !== jid.kind) fail(`${label}.jidKind`);
  const phone = optionalText(parsed.phone, 32, `${label}.phone`);
  if (
    (jid.kind === "user" && phone !== jid.id)
    || (jid.kind === "lid" && phone !== null)
  ) fail(`${label}.phone`);
  const redactedPhone = optionalText(
    parsed.redactedPhone,
    MAX_REDACTED_PHONE_LENGTH,
    `${label}.redactedPhone`,
  );
  const firstName = optionalText(parsed.firstName, MAX_NAME_LENGTH, `${label}.firstName`);
  const fullName = optionalText(parsed.fullName, MAX_NAME_LENGTH, `${label}.fullName`);
  const pushName = optionalText(parsed.pushName, MAX_NAME_LENGTH, `${label}.pushName`);
  const businessName = optionalText(
    parsed.businessName,
    MAX_NAME_LENGTH,
    `${label}.businessName`,
  );
  const displayName = optionalText(
    parsed.displayName,
    MAX_NAME_LENGTH,
    `${label}.displayName`,
  );
  const candidates = [
    [fullName, "full-name"],
    [pushName, "push-name"],
    [businessName, "business-name"],
    [firstName, "first-name"],
    [redactedPhone, "redacted-phone"],
    [phone, "phone"],
  ] as const satisfies readonly (
    readonly [string | null, WhatsAppContactDisplayNameBasis]
  )[];
  const selected = candidates.find(([value]) => value !== null);
  const expectedDisplayName = selected?.[0] ?? null;
  const displayNameBasis = selected?.[1] ?? "unavailable";
  if (parsed.displayNameBasis !== displayNameBasis) {
    fail(`${label}.displayNameBasis`);
  }
  if (displayName !== expectedDisplayName) fail(`${label}.displayName`);
  return Object.freeze({
    providerId: jid.jid,
    jidKind: jid.kind,
    phone,
    redactedPhone,
    firstName,
    fullName,
    pushName,
    businessName,
    displayName,
    displayNameBasis,
  });
}

function errorCode(value: unknown): WhatsAppContactProjectionErrorCode {
  if (
    typeof value !== "string"
    || !(WHATSAPP_CONTACT_PROJECTION_ERROR_CODES as readonly string[]).includes(value)
  ) return fail("response.errorCode");
  return value as WhatsAppContactProjectionErrorCode;
}

export function parseWhatsAppContactProjectionResponse(
  value: unknown,
  request?: Pick<WhatsAppContactProjectionRequest, "cursor" | "limit">,
): WhatsAppContactProjectionResponse {
  const parsed = record(value, "response");
  if (parsed.status === "failed") {
    exactKeys(parsed, ["schemaVersion", "status", "errorCode"], "response");
    if (parsed.schemaVersion !== WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION) {
      fail("response.schemaVersion");
    }
    return Object.freeze({
      schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
      status: "failed",
      errorCode: errorCode(parsed.errorCode),
    });
  }
  exactKeys(parsed, [
    "schemaVersion",
    "status",
    "contacts",
    "nextCursor",
    "localContactTablePageComplete",
  ], "response");
  if (
    parsed.schemaVersion !== WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION
    || parsed.status !== "succeeded"
    || !Array.isArray(parsed.contacts)
    || parsed.contacts.length > WHATSAPP_CONTACT_PROJECTION_MAX_LIMIT
    || typeof parsed.localContactTablePageComplete !== "boolean"
  ) fail("response");
  if (request !== undefined && (
    parsed.contacts.length > request.limit
    || (
      !parsed.localContactTablePageComplete
      && parsed.contacts.length !== request.limit
    )
  )) {
    fail("response.contacts");
  }
  const contacts = parsed.contacts.map((item, index) =>
    contact(item, `response.contacts[${index}]`)
  );
  for (let index = 0; index < contacts.length; index += 1) {
    const current = contacts[index]!;
    const previous = index === 0 ? request?.cursor : contacts[index - 1]?.providerId;
    if (previous !== undefined && previous !== null && current.providerId <= previous) {
      fail("response.contacts ordering");
    }
  }
  const nextCursor = parsed.nextCursor === null
    ? null
    : parseWhatsAppContactProjectionJid(parsed.nextCursor).jid;
  if (
    (parsed.localContactTablePageComplete && nextCursor !== null)
    || (!parsed.localContactTablePageComplete
      && (contacts.length === 0 || nextCursor !== contacts.at(-1)?.providerId))
  ) fail("response.nextCursor");
  return Object.freeze({
    schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
    status: "succeeded",
    contacts: Object.freeze(contacts),
    nextCursor,
    localContactTablePageComplete: parsed.localContactTablePageComplete,
  });
}

export function createWhatsAppContactProjectionFailure(
  errorCodeValue: WhatsAppContactProjectionErrorCode,
): WhatsAppContactProjectionFailure {
  return Object.freeze({
    schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
    status: "failed",
    errorCode: errorCode(errorCodeValue),
  });
}
