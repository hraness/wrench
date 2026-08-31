/**
 * Telegram contact policy and the strict local TDLib projection protocol.
 *
 * Telegram support is deliberately a TDLib user client. The Bot API cannot
 * enumerate an account's contacts and must never be substituted for this
 * linked-device transport.
 */

import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";

export const TELEGRAM_TDLIB_PROTOCOL_VERSION = 1 as const;
export const TELEGRAM_TDLIB_MAX_CONTACTS = 100_000;
export const TELEGRAM_TDLIB_MAX_PROJECTION_BYTES = 16 * 1024 * 1024;
export const TELEGRAM_TDLIB_MAX_TEXT_BYTES = 4_096;

export const TELEGRAM_TDLIB_PIN = Object.freeze({
  implementation: "github.com/tdlib/td+wrench-telegram-tdlib",
  version: "1.8.67",
  sourceCommit: "d1085f9cebc5a62379991ae1652673954f229c1f",
  helperImplementation: "wrench-telegram-tdlib",
  helperProtocolVersion: TELEGRAM_TDLIB_PROTOCOL_VERSION,
  sourceManifest: "src/vendor/telegram-tdlib/manifest.json",
  supportedArtifacts: Object.freeze([
    Object.freeze({ platform: "darwin", arch: "arm64" }),
    Object.freeze({ platform: "darwin", arch: "x64" }),
    Object.freeze({ platform: "linux", arch: "arm64" }),
    Object.freeze({ platform: "linux", arch: "x64" }),
  ]),
} as const);

export const TELEGRAM_TDLIB_OPERATION_NAMES = Object.freeze([
  "contacts.list",
] as const);

export type TelegramTdlibOperationName =
  (typeof TELEGRAM_TDLIB_OPERATION_NAMES)[number];

export const TELEGRAM_TDLIB_OPERATIONS = Object.freeze({
  "contacts.list": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason:
      "read one bounded page from the explicit account-bound getContacts projection without opening TDLib or sending a Telegram request",
  }),
} as const);

type JsonRecord = Readonly<Record<string, unknown>>;

function fail(label: string, detail: string): never {
  throw new Error(`${label} ${detail}`);
}

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
  ) return fail(label, "must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (
      typeof key !== "string"
      || descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(label, "must contain only enumerable data properties");
  }
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
    if (!remaining.delete(key)) fail(`${label}.${key}`, "is required");
  }
  for (const key of optional) remaining.delete(key);
  const unexpected = [...remaining].sort()[0];
  if (unexpected !== undefined) {
    fail(label, `contains unreviewed property ${unexpected}`);
  }
}

function denseArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) return fail(label, `must be a plain dense array of at most ${maximum} items`);
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => !expected.has(key))) {
    return fail(label, "must not contain named or symbol properties");
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label}[${index}]`, "must be an enumerable data property");
    result.push(descriptor.value);
  }
  return Object.freeze(result);
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

function boundedText(
  value: unknown,
  label: string,
  maximum = TELEGRAM_TDLIB_MAX_TEXT_BYTES,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum
    || !hasWellFormedUnicode(value)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) return fail(label, "must be bounded well-formed text");
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return fail(label, "must be boolean");
  return value;
}

/** TDLib user identifiers are positive int53 values, encoded as decimal text. */
export function parseTelegramUserId(value: unknown, label = "Telegram user ID"): string {
  if (
    typeof value !== "string"
    || !/^[1-9][0-9]{0,15}$/u.test(value)
  ) return fail(label, "must be a canonical positive decimal int53 string");
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || String(numeric) !== value) {
    return fail(label, "must be a canonical positive decimal int53 string");
  }
  return value;
}

export function telegramSubject(value: unknown): string {
  const text = boundedText(value, "Telegram account subject", 64);
  const match = /^telegram:user:([1-9][0-9]{0,15})$/u.exec(text);
  if (match === null) {
    return fail("Telegram account subject", "must name one exact TDLib user");
  }
  const id = match[1];
  if (id === undefined) return fail("Telegram account subject", "is malformed");
  parseTelegramUserId(id, "Telegram account subject user ID");
  return text;
}

export type TelegramTdlibContact = Readonly<{
  userId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  username: string | null;
  phoneNumber: string | null;
  isMutualContact: boolean;
  isPremium: boolean;
  isVerified: boolean;
}>;

function optionalTelegramText(
  value: unknown,
  label: string,
  maximum = TELEGRAM_TDLIB_MAX_TEXT_BYTES,
): string | null {
  if (value === null) return null;
  return boundedText(value, label, maximum);
}

function parseContact(value: unknown, index: number): TelegramTdlibContact {
  const label = `Telegram TDLib contact[${index}]`;
  const source = strictRecord(value, label);
  exactKeys(source, [
    "displayName",
    "firstName",
    "isMutualContact",
    "isPremium",
    "isVerified",
    "lastName",
    "phoneNumber",
    "userId",
    "username",
  ], [], label);
  const userId = parseTelegramUserId(source.userId, `${label}.userId`);
  const firstName = boundedText(source.firstName, `${label}.firstName`, 1_024, true);
  const lastName = boundedText(source.lastName, `${label}.lastName`, 1_024, true);
  const username = optionalTelegramText(source.username, `${label}.username`, 64);
  if (username !== null && !/^[A-Za-z][A-Za-z0-9_]{3,31}$/u.test(username)) {
    return fail(`${label}.username`, "must be a canonical active Telegram username");
  }
  const displayName = boundedText(source.displayName, `${label}.displayName`, 2_048);
  const joinedName = [firstName, lastName].filter(Boolean).join(" ");
  const expectedDisplayName = joinedName !== ""
    ? joinedName
    : username ?? `Telegram user ${userId}`;
  if (displayName !== expectedDisplayName) {
    return fail(
      `${label}.displayName`,
      "must be the canonical name, primary username, or user-ID fallback",
    );
  }
  const phoneNumber = optionalTelegramText(
    source.phoneNumber,
    `${label}.phoneNumber`,
    32,
  );
  if (phoneNumber !== null && !/^[0-9]{5,20}$/u.test(phoneNumber)) {
    return fail(`${label}.phoneNumber`, "must be a canonical Telegram phone number");
  }
  return Object.freeze({
    userId,
    firstName,
    lastName,
    displayName,
    username,
    phoneNumber,
    isMutualContact: booleanValue(source.isMutualContact, `${label}.isMutualContact`),
    isPremium: booleanValue(source.isPremium, `${label}.isPremium`),
    isVerified: booleanValue(source.isVerified, `${label}.isVerified`),
  });
}

function compareUserIds(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export type TelegramTdlibProjection = Readonly<{
  schemaVersion: typeof TELEGRAM_TDLIB_PROTOCOL_VERSION;
  sourceCommit: typeof TELEGRAM_TDLIB_PIN.sourceCommit;
  accountSubject: string;
  contacts: readonly TelegramTdlibContact[];
}>;

export function parseTelegramTdlibProjection(
  value: unknown,
): TelegramTdlibProjection {
  const source = strictRecord(value, "Telegram TDLib projection");
  exactKeys(source, [
    "accountSubject",
    "contacts",
    "schemaVersion",
    "sourceCommit",
  ], [], "Telegram TDLib projection");
  if (source.schemaVersion !== TELEGRAM_TDLIB_PROTOCOL_VERSION) {
    return fail("Telegram TDLib projection.schemaVersion", "is unsupported");
  }
  if (source.sourceCommit !== TELEGRAM_TDLIB_PIN.sourceCommit) {
    return fail("Telegram TDLib projection.sourceCommit", "does not match the reviewed source pin");
  }
  const contacts = denseArray(
    source.contacts,
    "Telegram TDLib projection.contacts",
    TELEGRAM_TDLIB_MAX_CONTACTS,
  ).map(parseContact);
  for (let index = 1; index < contacts.length; index += 1) {
    const previous = contacts[index - 1];
    const current = contacts[index];
    if (
      previous === undefined
      || current === undefined
      || compareUserIds(previous.userId, current.userId) >= 0
    ) {
      return fail(
        "Telegram TDLib projection.contacts",
        "must contain unique user IDs in ascending numeric order",
      );
    }
  }
  return Object.freeze({
    schemaVersion: TELEGRAM_TDLIB_PROTOCOL_VERSION,
    sourceCommit: TELEGRAM_TDLIB_PIN.sourceCommit,
    accountSubject: telegramSubject(source.accountSubject),
    contacts: Object.freeze(contacts),
  });
}

export type TelegramTdlibHelperIdentity = Readonly<{
  schemaVersion: typeof TELEGRAM_TDLIB_PROTOCOL_VERSION;
  operation: "identity";
  status: "ok";
  implementation: typeof TELEGRAM_TDLIB_PIN.helperImplementation;
  tdlibVersion: typeof TELEGRAM_TDLIB_PIN.version;
  sourceCommit: typeof TELEGRAM_TDLIB_PIN.sourceCommit;
}>;

export function parseTelegramTdlibHelperIdentity(
  value: unknown,
): TelegramTdlibHelperIdentity {
  const source = strictRecord(value, "Telegram TDLib helper identity");
  exactKeys(source, [
    "implementation",
    "operation",
    "schemaVersion",
    "sourceCommit",
    "status",
    "tdlibVersion",
  ], [], "Telegram TDLib helper identity");
  if (
    source.schemaVersion !== TELEGRAM_TDLIB_PROTOCOL_VERSION
    || source.operation !== "identity"
    || source.status !== "ok"
    || source.implementation !== TELEGRAM_TDLIB_PIN.helperImplementation
    || source.tdlibVersion !== TELEGRAM_TDLIB_PIN.version
    || source.sourceCommit !== TELEGRAM_TDLIB_PIN.sourceCommit
  ) return fail("Telegram TDLib helper identity", "does not match the reviewed runtime");
  return Object.freeze({
    schemaVersion: TELEGRAM_TDLIB_PROTOCOL_VERSION,
    operation: "identity",
    status: "ok",
    implementation: TELEGRAM_TDLIB_PIN.helperImplementation,
    tdlibVersion: TELEGRAM_TDLIB_PIN.version,
    sourceCommit: TELEGRAM_TDLIB_PIN.sourceCommit,
  });
}

export type TelegramTdlibCaptureOperation = "pair" | "sync";

export function telegramTdlibRequest(
  operation: "identity" | TelegramTdlibCaptureOperation,
  options: Readonly<{ phone?: string }> = {},
): string {
  if (operation !== "pair" && options.phone !== undefined) {
    return fail("Telegram TDLib request", "may include a phone only for pairing");
  }
  if (
    options.phone !== undefined
    && !/^\+?[0-9]{5,20}$/u.test(options.phone)
  ) return fail("Telegram pairing phone", "must be one international number");
  return `${JSON.stringify({
    schemaVersion: TELEGRAM_TDLIB_PROTOCOL_VERSION,
    operation,
    ...(operation === "pair"
      ? { phone: options.phone ?? null }
      : {}),
  })}\n`;
}

export function parseTelegramTdlibCaptureEnvelope(
  value: unknown,
  expectedOperation: TelegramTdlibCaptureOperation,
): TelegramTdlibProjection {
  const source = strictRecord(value, "Telegram TDLib capture response");
  exactKeys(source, [
    "accountSubject",
    "contacts",
    "operation",
    "schemaVersion",
    "sourceCommit",
    "status",
  ], [], "Telegram TDLib capture response");
  if (
    source.operation !== expectedOperation
    || source.status !== "ok"
  ) return fail("Telegram TDLib capture response", "has an unexpected operation or status");
  return parseTelegramTdlibProjection({
    schemaVersion: source.schemaVersion,
    sourceCommit: source.sourceCommit,
    accountSubject: source.accountSubject,
    contacts: source.contacts,
  });
}

export type TelegramContactsListInput = Readonly<{
  cursor: string | null;
  limit: number;
}>;

export function parseTelegramContactsListInput(
  input: OperationInput,
): TelegramContactsListInput {
  const source = strictRecord(input, "Telegram contacts.list input");
  exactKeys(source, [], ["cursor", "limit"], "Telegram contacts.list input");
  const cursor = source.cursor === undefined || source.cursor === ""
    ? null
    : parseTelegramUserId(source.cursor, "Telegram contacts.list input.cursor");
  const limitValue = source.limit ?? 50;
  if (
    typeof limitValue !== "number"
    || !Number.isSafeInteger(limitValue)
    || limitValue < 1
    || limitValue > 200
  ) return fail("Telegram contacts.list input.limit", "must be an integer between 1 and 200");
  return Object.freeze({ cursor, limit: limitValue });
}

export type TelegramContactsPage = Readonly<{
  contacts: readonly TelegramTdlibContact[];
  nextCursor: string | null;
  pageComplete: boolean;
}>;

export function pageTelegramContacts(
  projection: TelegramTdlibProjection,
  input: TelegramContactsListInput,
): TelegramContactsPage {
  let start = 0;
  if (input.cursor !== null) {
    while (
      start < projection.contacts.length
      && compareUserIds(
        projection.contacts[start]?.userId ?? input.cursor,
        input.cursor,
      ) <= 0
    ) start += 1;
  }
  const window = projection.contacts.slice(start, start + input.limit);
  const hasMore = start + window.length < projection.contacts.length;
  return Object.freeze({
    contacts: Object.freeze(window),
    nextCursor: hasMore ? window.at(-1)?.userId ?? null : null,
    pageComplete: !hasMore,
  });
}
