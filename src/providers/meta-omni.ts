import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";
import { OmniMaterializerDriftError } from "../omni-model";
import type {
  OmniParticipantV1,
  ProviderConversationV1,
  ProviderMaterializedPageV1,
} from "../omni-model";

type ParsedInstagramParticipant = Readonly<{
  providerId: string;
  displayName: string | null;
  handle: string | null;
}>;

type ParsedInstagramConversationSummary = Readonly<{
  providerId: string;
  title: string | null;
  participants: readonly ParsedInstagramParticipant[];
  orderedAt: string | null;
  readState: number | null;
  pending: boolean | null;
}>;

function materializedParticipant(
  value: ParsedInstagramParticipant,
): OmniParticipantV1 {
  return Object.freeze({
    providerId: value.providerId,
    displayName: value.displayName,
    handle: value.handle,
  });
}

function materializedConversation(
  value: ParsedInstagramConversationSummary,
): ProviderConversationV1 {
  return Object.freeze({
    kind: "conversation",
    providerId: value.providerId,
    providerRevision: null,
    orderedAt: value.orderedAt,
    detail: "summary",
    title: value.title,
    summary: null,
    participants: Object.freeze(
      value.participants.map(materializedParticipant),
    ),
    unread: null,
    unreadCount: null,
    archived: null,
    pending: value.pending,
  });
}

function drift(path: string, message: string): never {
  throw new OmniMaterializerDriftError("instagram", path, message);
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return drift(path, "must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return drift(path, "must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== "string") return drift(path, "must not have symbol properties");
    const descriptor = descriptors[name];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) {
      return drift(`${path}.*`, "must be an enumerable data property");
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) drift(path, "contains an unreviewed property");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) drift(`${path}.${key}`, "is required");
  }
}

function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) {
    return drift(path, `must be an array of at most ${maximum} items`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) drift(`${path}[${index}]`, "must not be sparse");
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) drift(`${path}[${index}]`, "must be an enumerable data property");
  }
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size || ownKeys.some((key) => !expected.has(key))) {
    drift(path, "must be a dense array without named properties");
  }
  return value;
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return true;
    }
  }
  return false;
}

function string(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximum
    || (!allowEmpty && value.length === 0)
    || hasDisallowedControl(value)
  ) return drift(path, `must be a bounded${allowEmpty ? "" : " non-empty"} string`);
  return value;
}

function nullableString(
  value: unknown,
  path: string,
  maximum: number,
): string | null {
  return value === null ? null : string(value, path, maximum);
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return drift(path, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function nullableInteger(
  value: unknown,
  path: string,
  minimum = 0,
): number | null {
  return value === null
    ? null
    : integer(value, path, minimum, Number.MAX_SAFE_INTEGER);
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") return drift(path, "must be boolean or null");
  return value;
}

function decimalId(value: unknown, path: string): string {
  const result = string(value, path, 32);
  if (!/^[1-9][0-9]{0,31}$/u.test(result)) {
    return drift(path, "must be a stable nonzero decimal ID");
  }
  return result;
}

function threadId(value: unknown, path: string): string {
  const result = string(value, path, 128);
  if (!/^[1-9][0-9]{0,127}$/u.test(result)) {
    return drift(path, "must be a stable nonzero decimal thread ID");
  }
  return result;
}

function timestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  const seconds = integer(value, path, 0, 253_402_300_799);
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) return drift(path, "must be a valid Unix timestamp");
  return date.toISOString();
}

function parseInput(input: OperationInput): { readonly limit: number } {
  const source = record(input, "messaging.list input");
  exactKeys(source, ["folder"], ["cursor", "limit"], "messaging.list input");
  if (source.folder !== "inbox") {
    drift("messaging.list input.folder", "must be inbox");
  }
  if (source.cursor !== undefined) {
    drift(
      "messaging.list input.cursor",
      "is capture-required and cannot be materialized",
    );
  }
  return Object.freeze({
    limit: source.limit === undefined
      ? 20
      : integer(source.limit, "messaging.list input.limit", 1, 50),
  });
}

function parseParticipant(
  value: unknown,
  path: string,
): ParsedInstagramParticipant {
  const source = record(value, path);
  exactKeys(source, ["id", "username", "full_name"], [], path);
  if (source.id === null) {
    drift(`${path}.id`, "is required for durable participant identity");
  }
  return Object.freeze({
    providerId: decimalId(source.id, `${path}.id`),
    displayName: nullableString(source.full_name, `${path}.full_name`, 256),
    handle: nullableString(source.username, `${path}.username`, 64),
  });
}

function parseConversation(
  value: unknown,
  path: string,
): ParsedInstagramConversationSummary {
  const source = record(value, path);
  exactKeys(source, [
    "thread_id",
    "thread_title",
    "users",
    "last_activity_at",
    "read_state",
    "pending",
  ], [], path);
  const participants = array(source.users, `${path}.users`, 100).map(
    (participant, index) =>
      parseParticipant(participant, `${path}.users[${index}]`),
  );
  const participantIds = participants.map((participant) => participant.providerId);
  if (new Set(participantIds).size !== participantIds.length) {
    drift(`${path}.users`, "contains duplicate participant IDs");
  }
  return Object.freeze({
    providerId: threadId(source.thread_id, `${path}.thread_id`),
    title: nullableString(source.thread_title, `${path}.thread_title`, 512),
    participants: Object.freeze(participants),
    orderedAt: timestamp(source.last_activity_at, `${path}.last_activity_at`),
    // The provider emits a numeric read marker but the reviewed contract does
    // not prove a portable boolean interpretation. Retain it only through this
    // typed provider parse; the shared entity leaves unread unknown.
    readState: nullableInteger(source.read_state, `${path}.read_state`),
    pending: nullableBoolean(source.pending, `${path}.pending`),
  });
}

/** Strict Instagram inbox projection. It emits conversation summaries, never messages. */
export function materializeInstagramMessagingList(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsedInput = parseInput(input);
  const source = record(output, "messaging.list output");
  exactKeys(source, [
    "folder",
    "threads",
    "next_cursor",
    "has_older",
    "pending_requests_total",
  ], [], "messaging.list output");
  if (source.folder !== "inbox") {
    drift("messaging.list output.folder", "must bind the inbox input");
  }
  const entities = array(
    source.threads,
    "messaging.list output.threads",
    parsedInput.limit,
  ).map((value, index) =>
    parseConversation(value, `messaging.list output.threads[${index}]`));
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) {
    drift("messaging.list output.threads", "contains duplicate stable thread IDs");
  }
  const nextCursor = nullableString(
    source.next_cursor,
    "messaging.list output.next_cursor",
    4_096,
  );
  const hasOlder = nullableBoolean(
    source.has_older,
    "messaging.list output.has_older",
  );
  if (hasOlder === true && nextCursor === null) {
    drift("messaging.list output.next_cursor", "is required when has_older is true");
  }
  if (hasOlder === false && nextCursor !== null) {
    drift("messaging.list output.next_cursor", "must be null when has_older is false");
  }
  nullableInteger(
    source.pending_requests_total,
    "messaging.list output.pending_requests_total",
  );
  const materialized = Object.freeze(entities.map(materializedConversation));
  const partition = "instagram:inbox";
  return Object.freeze({
    schemaVersion: 1,
    partition,
    completeness: Object.freeze({
      kind: hasOlder === false ? "complete" : "first-page-only",
      reason: hasOlder === false
        ? "Instagram explicitly reported that the inbox has no older page."
        : "Instagram exposed older-page evidence, but authenticated inbox cursor replay remains capture-required.",
    }),
    // The exact output cursor is validated as drift evidence but is not an
    // executable provider input under the observed contract.
    cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
    entities: materialized,
    tombstones: Object.freeze([]),
  });
}
