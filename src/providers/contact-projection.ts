import { types as nodeTypes } from "node:util";

export type ContactDirectionStatsLastAtBasis =
  | "bounded-local-message-timestamp"
  | "bounded-matched-message-internal-date"
  | "unavailable";

export type ContactDirectionStats = Readonly<{
  count: number | null;
  complete: boolean;
  lowerBound: boolean;
  truncated: boolean;
  lastAt: string | null;
  lastAtComplete: boolean;
  lastAtBasis: ContactDirectionStatsLastAtBasis;
  incompleteReasons: readonly string[];
}>;

export type ContactDirectionStatsProjection = Readonly<{
  sentCount: number | null;
  sentCountComplete: boolean;
  sentCountLowerBound: boolean;
  sentCountTruncated: boolean;
  receivedCount: number | null;
  receivedCountComplete: boolean;
  receivedCountLowerBound: boolean;
  receivedCountTruncated: boolean;
  lastSentAt: string | null;
  lastSentAtComplete: boolean;
  lastSentAtBasis: ContactDirectionStatsLastAtBasis;
  sentStatsIncompleteReasons: readonly string[];
  lastReceivedAt: string | null;
  lastReceivedAtComplete: boolean;
  lastReceivedAtBasis: ContactDirectionStatsLastAtBasis;
  receivedStatsIncompleteReasons: readonly string[];
}>;

type JsonRecord = Readonly<Record<string, unknown>>;

const DIRECTION_STATS_KEYS = Object.freeze([
  "count",
  "complete",
  "lowerBound",
  "truncated",
  "lastAt",
  "lastAtComplete",
  "lastAtBasis",
  "incompleteReasons",
] as const);
const LAST_AT_BASES: ReadonlySet<unknown> = new Set<ContactDirectionStatsLastAtBasis>([
  "bounded-local-message-timestamp",
  "bounded-matched-message-internal-date",
  "unavailable",
]);
const MAX_INCOMPLETE_REASONS = 32;
const MAX_INCOMPLETE_REASON_LENGTH = 128;
const INCOMPLETE_REASON_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function fail(label: string, message: string): never {
  throw new Error(`${label} ${message}`);
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
    if (typeof key !== "string") return fail(label, "must not contain symbol properties");
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label}.${key}`, "must be an enumerable data property");
  }
  return value as JsonRecord;
}

function exactDirectionStatsKeys(value: JsonRecord, label: string): void {
  const allowed = new Set<string>(DIRECTION_STATS_KEYS);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return fail(label, `contains unreviewed property ${key}`);
  }
  for (const key of DIRECTION_STATS_KEYS) {
    if (!Object.hasOwn(value, key)) return fail(`${label}.${key}`, "is required");
  }
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return fail(label, "must be boolean");
  return value;
}

function countValue(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(label, "must be null or a non-negative safe integer");
  }
  return value;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function rfc3339UtcValue(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail(label, "must be null or an RFC 3339 UTC timestamp");
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (match === null) return fail(label, "must be null or an RFC 3339 UTC timestamp");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    !Number.isInteger(year)
    || !Number.isInteger(month)
    || !Number.isInteger(day)
    || !Number.isInteger(hour)
    || !Number.isInteger(minute)
    || !Number.isInteger(second)
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 60
  ) return fail(label, "must be null or an RFC 3339 UTC timestamp");
  return value;
}

function lastAtBasisValue(value: unknown, label: string): ContactDirectionStatsLastAtBasis {
  if (!LAST_AT_BASES.has(value)) {
    return fail(
      label,
      "must be bounded-local-message-timestamp, bounded-matched-message-internal-date, or unavailable",
    );
  }
  return value as ContactDirectionStatsLastAtBasis;
}

function strictReasons(value: unknown, label: string): readonly string[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) return fail(label, "must be a plain array");
  if (value.length > MAX_INCOMPLETE_REASONS) {
    return fail(label, `must contain at most ${MAX_INCOMPLETE_REASONS} reasons`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail(label, "must not contain symbol properties");
    if (key === "length") continue;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label}.${key}`, "must be an enumerable data property");
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
      return fail(label, `contains unreviewed property ${key}`);
    }
  }
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return fail(label, "must not be sparse");
    const reason: unknown = value[index];
    if (
      typeof reason !== "string"
      || reason.length === 0
      || reason.length > MAX_INCOMPLETE_REASON_LENGTH
      || !INCOMPLETE_REASON_PATTERN.test(reason)
    ) {
      return fail(
        `${label}[${index}]`,
        `must be a kebab-case reason of at most ${MAX_INCOMPLETE_REASON_LENGTH} code units`,
      );
    }
    if (seen.has(reason)) return fail(label, `contains duplicate reason ${reason}`);
    seen.add(reason);
    reasons.push(reason);
  }
  return Object.freeze(reasons);
}

/** Parse and freeze one provider's completeness-aware sent or received statistics. */
export function parseContactDirectionStats(
  value: unknown,
  label = "contact direction stats",
): ContactDirectionStats {
  const source = strictRecord(value, label);
  exactDirectionStatsKeys(source, label);
  const count = countValue(source.count, `${label}.count`);
  const complete = booleanValue(source.complete, `${label}.complete`);
  const lowerBound = booleanValue(source.lowerBound, `${label}.lowerBound`);
  const truncated = booleanValue(source.truncated, `${label}.truncated`);
  const lastAt = rfc3339UtcValue(source.lastAt, `${label}.lastAt`);
  const lastAtComplete = booleanValue(source.lastAtComplete, `${label}.lastAtComplete`);
  const lastAtBasis = lastAtBasisValue(source.lastAtBasis, `${label}.lastAtBasis`);
  const incompleteReasons = strictReasons(
    source.incompleteReasons,
    `${label}.incompleteReasons`,
  );

  if (count === null && (complete || lowerBound || truncated)) {
    return fail(label, "cannot mark an unavailable count complete, lower-bound, or truncated");
  }
  if (count !== null && complete === lowerBound) {
    return fail(label, "a numeric count must be exactly complete or lower-bound");
  }
  if (lowerBound && complete) return fail(label, "a lower-bound count cannot be complete");
  if (truncated && !lowerBound) return fail(label, "a truncated count must be a lower bound");
  if (lastAt === null && lastAtBasis !== "unavailable") {
    return fail(label, "must use an unavailable basis when lastAt is null");
  }
  if (lastAt !== null && lastAtBasis === "unavailable") {
    return fail(label, "must identify a bounded basis when lastAt is available");
  }
  if (
    lastAt === null
    && lastAtComplete
    && !(count === 0 && complete)
  ) {
    return fail(
      label,
      "can mark a missing lastAt complete only for an exactly complete zero count",
    );
  }
  if (count === 0 && lastAt !== null) {
    return fail(label, "cannot have lastAt when the observed count is zero");
  }
  if (count !== null && count > 0 && lastAtComplete && lastAt === null) {
    return fail(label, "a complete lastAt for a positive count must be available");
  }
  const whollyComplete = complete && lastAtComplete;
  if ((incompleteReasons.length === 0) !== whollyComplete) {
    return fail(
      label,
      "must have no incomplete reasons exactly when both count and lastAt are complete",
    );
  }

  return Object.freeze({
    count,
    complete,
    lowerBound,
    truncated,
    lastAt,
    lastAtComplete,
    lastAtBasis,
    incompleteReasons,
  });
}

/** Project sent and received statistics into the stable flat contact output fields. */
export function projectContactDirectionStats(
  sentValue: unknown,
  receivedValue: unknown,
): ContactDirectionStatsProjection {
  const sent = parseContactDirectionStats(sentValue, "sent contact direction stats");
  const received = parseContactDirectionStats(receivedValue, "received contact direction stats");
  return Object.freeze({
    sentCount: sent.count,
    sentCountComplete: sent.complete,
    sentCountLowerBound: sent.lowerBound,
    sentCountTruncated: sent.truncated,
    receivedCount: received.count,
    receivedCountComplete: received.complete,
    receivedCountLowerBound: received.lowerBound,
    receivedCountTruncated: received.truncated,
    lastSentAt: sent.lastAt,
    lastSentAtComplete: sent.lastAtComplete,
    lastSentAtBasis: sent.lastAtBasis,
    sentStatsIncompleteReasons: sent.incompleteReasons,
    lastReceivedAt: received.lastAt,
    lastReceivedAtComplete: received.lastAtComplete,
    lastReceivedAtBasis: received.lastAtBasis,
    receivedStatsIncompleteReasons: received.incompleteReasons,
  });
}
