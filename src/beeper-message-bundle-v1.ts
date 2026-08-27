import { types as nodeTypes } from "node:util";

import {
  LOCAL_MESSAGE_BUNDLE_V1_LIMITS,
  LOCAL_MESSAGE_BUNDLE_V1_PROVIDER_ID,
  LOCAL_MESSAGE_BUNDLE_V1_SOURCE_ID,
  parseLocalMessageBundleV1Record,
  type LocalMessageBundleV1AccountRecord,
  type LocalMessageBundleV1AttachmentRecord,
  type LocalMessageBundleV1ConversationRecord,
  type LocalMessageBundleV1MessageRecord,
  type LocalMessageBundleV1ParticipantRecord,
  type LocalMessageBundleV1Provenance,
  type LocalMessageBundleV1ReactionRecord,
  type LocalMessageBundleV1Record,
  type LocalMessageBundleV1RecordKind,
  type LocalMessageBundleV1TombstoneRecord,
} from "@hraness/message-like-me/message-bundle-v1";

export type BeeperMessageLikeMeProvenance = LocalMessageBundleV1Provenance;
export type BeeperMessageLikeMeAccount = LocalMessageBundleV1AccountRecord;
export type BeeperMessageLikeMeParticipant = LocalMessageBundleV1ParticipantRecord;
export type BeeperMessageLikeMeConversation = LocalMessageBundleV1ConversationRecord;
export type BeeperMessageLikeMeAttachment = LocalMessageBundleV1AttachmentRecord;
export type BeeperMessageLikeMeMessage = LocalMessageBundleV1MessageRecord;
export type BeeperMessageLikeMeReaction = LocalMessageBundleV1ReactionRecord;
export type BeeperMessageLikeMeTombstone = LocalMessageBundleV1TombstoneRecord;
export type BeeperMessageLikeMeRecord = LocalMessageBundleV1Record;

export type BeeperMessageLikeMeExportSource = Readonly<{
  descriptor: unknown;
  records: AsyncIterable<unknown>;
  completion: () => Promise<unknown>;
  dispose?: (published: boolean) => Promise<void>;
}>;

export type BeeperMessageLikeMeDescriptor = Readonly<{
  source: Readonly<{
    id: typeof LOCAL_MESSAGE_BUNDLE_V1_SOURCE_ID;
    version: string;
  }>;
  provider: Readonly<{
    id: typeof LOCAL_MESSAGE_BUNDLE_V1_PROVIDER_ID;
    version: string;
  }>;
}>;

export type BeeperMessageLikeMeCompletion = Readonly<{
  completeness: Readonly<{
    kind: "bounded-local" | "truncated" | "unknown";
    reason: string | null;
    observedFrom: string | null;
    observedThrough: string | null;
  }>;
  warnings: readonly string[];
}>;

type JsonRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`Beeper Message Like Me contract: ${message}`);
}

function object(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return fail(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return fail(`${label} must not contain symbol fields`);
  }
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum) {
    return fail(`${label} must be a bounded plain array`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || keys.length !== value.length + 1
    || keys[keys.length - 1] !== "length"
  ) return fail(`${label} must not contain holes or custom fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}[${String(index)}] must be an enumerable data property`);
    }
  }
  return value;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) return fail(`${label} contains unsupported or missing fields`);
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) return fail(`${label} must be bounded NUL-free text`);
  return value;
}

function version(value: unknown, label: string): string {
  const parsed = boundedText(value, label, 128);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/u.test(parsed)) {
    return fail(`${label} must be a version token`);
  }
  return parsed;
}

function token(value: unknown, label: string): string {
  const parsed = boundedText(value, label, 128);
  if (!/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/u.test(parsed)) {
    return fail(`${label} must be a lowercase token`);
  }
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = boundedText(value, label, 64);
  const instant = new Date(parsed);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== parsed) {
    return fail(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

export function parseBeeperMessageLikeMeRecord(
  value: unknown,
  index: number,
): BeeperMessageLikeMeRecord {
  if (
    !Number.isSafeInteger(index)
    || index < 0
    || index >= LOCAL_MESSAGE_BUNDLE_V1_LIMITS.records
  ) return fail("record index is outside the bundle bound");
  const label = `record[${String(index)}]`;
  const candidate = object(value, label);
  const kind = candidate.kind;
  if (
    kind !== "account"
    && kind !== "participant"
    && kind !== "conversation"
    && kind !== "message"
    && kind !== "reaction"
    && kind !== "tombstone"
  ) return fail(`${label}.kind is unsupported`);
  return parseLocalMessageBundleV1Record(
    value,
    kind as LocalMessageBundleV1RecordKind,
    label,
  );
}

export function parseBeeperMessageLikeMeDescriptor(
  value: unknown,
): BeeperMessageLikeMeDescriptor {
  const descriptor = object(value, "source descriptor");
  exactKeys(descriptor, ["source", "provider"], "source descriptor");
  const source = object(descriptor.source, "source descriptor.source");
  exactKeys(source, ["id", "version"], "source descriptor.source");
  const provider = object(descriptor.provider, "source descriptor.provider");
  exactKeys(provider, ["id", "version"], "source descriptor.provider");
  if (source.id !== LOCAL_MESSAGE_BUNDLE_V1_SOURCE_ID) {
    return fail(`source descriptor.source.id must equal ${LOCAL_MESSAGE_BUNDLE_V1_SOURCE_ID}`);
  }
  if (provider.id !== LOCAL_MESSAGE_BUNDLE_V1_PROVIDER_ID) {
    return fail(`source descriptor.provider.id must equal ${LOCAL_MESSAGE_BUNDLE_V1_PROVIDER_ID}`);
  }
  return Object.freeze({
    source: Object.freeze({
      id: LOCAL_MESSAGE_BUNDLE_V1_SOURCE_ID,
      version: version(source.version, "source descriptor.source.version"),
    }),
    provider: Object.freeze({
      id: LOCAL_MESSAGE_BUNDLE_V1_PROVIDER_ID,
      version: version(provider.version, "source descriptor.provider.version"),
    }),
  });
}

export function parseBeeperMessageLikeMeCompletion(
  value: unknown,
): BeeperMessageLikeMeCompletion {
  const source = object(value, "source completion");
  exactKeys(source, ["completeness", "warnings"], "source completion");
  const completeness = object(source.completeness, "source completion.completeness");
  exactKeys(completeness, [
    "kind", "reason", "observedFrom", "observedThrough",
  ], "source completion.completeness");
  if (
    completeness.kind !== "bounded-local"
    && completeness.kind !== "truncated"
    && completeness.kind !== "unknown"
  ) return fail("source completion completeness kind is unsupported");
  const observedFrom = nullableTimestamp(
    completeness.observedFrom,
    "source completion.completeness.observedFrom",
  );
  const observedThrough = nullableTimestamp(
    completeness.observedThrough,
    "source completion.completeness.observedThrough",
  );
  if (observedFrom !== null && observedThrough !== null && observedFrom > observedThrough) {
    return fail("source completion timestamps are reversed");
  }
  const warnings = Object.freeze(array(
    source.warnings,
    "source completion.warnings",
    LOCAL_MESSAGE_BUNDLE_V1_LIMITS.warnings,
  ).map((item, index) => token(
    item,
    `source completion.warnings[${String(index)}]`,
  )));
  if (new Set(warnings).size !== warnings.length) {
    return fail("source completion warnings repeat");
  }
  return Object.freeze({
    completeness: Object.freeze({
      kind: completeness.kind,
      reason: completeness.reason === null
        ? null
        : token(completeness.reason, "source completion.completeness.reason"),
      observedFrom,
      observedThrough,
    }),
    warnings,
  });
}
