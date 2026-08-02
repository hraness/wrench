import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";
import { OmniMaterializerDriftError } from "../omni-model";
import type {
  OmniParticipantV1,
  ProviderConversationV1,
  ProviderMaterializedPageV1,
} from "../omni-model";

type SubstackInboxFolder = "all" | "people" | "unread";

type ParsedSubstackParticipant = Readonly<{
  providerId: string;
  displayName: string | null;
  handle: string | null;
}>;

type ParsedSubstackConversationSummary = Readonly<{
  providerId: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  orderedAt: string | null;
  lastViewedAt: string | null;
  participants: readonly ParsedSubstackParticipant[];
}>;

function drift(path: string, message: string): never {
  throw new OmniMaterializerDriftError("substack", path, message);
}

function materializedParticipant(
  value: ParsedSubstackParticipant,
): OmniParticipantV1 {
  return Object.freeze({
    providerId: value.providerId,
    displayName: value.displayName,
    handle: value.handle,
  });
}

function materializedConversation(
  value: ParsedSubstackConversationSummary,
): ProviderConversationV1 {
  return Object.freeze({
    kind: "conversation",
    providerId: value.providerId,
    providerRevision: null,
    orderedAt: value.orderedAt,
    detail: "summary",
    title: value.title,
    summary: value.subtitle,
    participants: Object.freeze(
      value.participants.map(materializedParticipant),
    ),
    unread: null,
    unreadCount: null,
    archived: null,
    pending: null,
  });
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

function nullableCount(value: unknown, path: string): number | null {
  return value === null
    ? null
    : integer(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") return drift(path, "must be boolean or null");
  return value;
}

function timestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  const result = string(value, path, 128);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result)) {
    return drift(path, "must be a UTC RFC3339 timestamp or null");
  }
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds)) return drift(path, "must be a valid UTC RFC3339 timestamp");
  return new Date(milliseconds).toISOString();
}

function folder(value: unknown, path: string): SubstackInboxFolder {
  if (value !== "all" && value !== "people" && value !== "unread") {
    return drift(path, "must be all, people, or unread");
  }
  return value;
}

function httpsUrl(value: unknown, path: string): string | null {
  if (value === null) return null;
  const raw = string(value, path, 4_096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return drift(path, "must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
  ) return drift(path, "must be an absolute HTTPS URL without credentials");
  return url.href;
}

function parseInput(input: OperationInput): {
  readonly folder: SubstackInboxFolder;
  readonly limit: number;
  readonly cursor: string | null;
} {
  const source = record(input, "messaging.list input");
  exactKeys(source, ["folder"], ["cursor", "limit"], "messaging.list input");
  const cursor = source.cursor === undefined
    ? null
    : string(source.cursor, "messaging.list input.cursor", 4_096);
  return Object.freeze({
    folder: folder(source.folder, "messaging.list input.folder"),
    limit: source.limit === undefined
      ? 20
      : integer(source.limit, "messaging.list input.limit", 1, 100),
    cursor,
  });
}

function parsePublication(value: unknown, path: string): void {
  if (value === null) return;
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "name",
    "subdomain",
    "hostname",
    "baseUrl",
    "authorId",
  ], [], path);
  integer(source.id, `${path}.id`, 1, Number.MAX_SAFE_INTEGER);
  nullableString(source.name, `${path}.name`, 512);
  nullableString(source.subdomain, `${path}.subdomain`, 256);
  nullableString(source.hostname, `${path}.hostname`, 512);
  httpsUrl(source.baseUrl, `${path}.baseUrl`);
  if (source.authorId !== null) {
    integer(source.authorId, `${path}.authorId`, 1, Number.MAX_SAFE_INTEGER);
  }
}

function parseConversation(
  value: unknown,
  path: string,
): ParsedSubstackConversationSummary {
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "type",
    "title",
    "subtitle",
    "timestamp",
    "lastViewedAt",
    "user",
    "publication",
  ], [], path);
  const participants: ParsedSubstackParticipant[] = [];
  if (source.user !== null) {
    const user = record(source.user, `${path}.user`);
    exactKeys(user, ["id", "name", "handle"], [], `${path}.user`);
    participants.push(Object.freeze({
      providerId: String(integer(
        user.id,
        `${path}.user.id`,
        1,
        Number.MAX_SAFE_INTEGER,
      )),
      displayName: nullableString(user.name, `${path}.user.name`, 512),
      handle: nullableString(user.handle, `${path}.user.handle`, 128),
    }));
  }
  parsePublication(source.publication, `${path}.publication`);
  return Object.freeze({
    providerId: string(source.id, `${path}.id`, 512),
    type: string(source.type, `${path}.type`, 128),
    title: nullableString(source.title, `${path}.title`, 2_048),
    subtitle: nullableString(source.subtitle, `${path}.subtitle`, 16_384),
    orderedAt: timestamp(source.timestamp, `${path}.timestamp`),
    lastViewedAt: timestamp(source.lastViewedAt, `${path}.lastViewedAt`),
    participants: Object.freeze(participants),
  });
}

/** Strict Substack inbox projection. It emits conversation summaries, never messages. */
export function materializeSubstackMessagingList(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsedInput = parseInput(input);
  const source = record(output, "messaging.list output");
  exactKeys(source, [
    "folder",
    "threads",
    "nextCursor",
    "more",
    "pendingInviteCount",
    "directMessagesUnreadCount",
    "pubChatUnreadCount",
  ], [], "messaging.list output");
  const returnedFolder = folder(source.folder, "messaging.list output.folder");
  if (returnedFolder !== parsedInput.folder) {
    drift("messaging.list output.folder", "must bind messaging.list input.folder");
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
    source.nextCursor,
    "messaging.list output.nextCursor",
    4_096,
  );
  const more = nullableBoolean(source.more, "messaging.list output.more");
  if (more === true && nextCursor === null) {
    drift("messaging.list output.nextCursor", "is required when more is true");
  }
  if (more === false && nextCursor !== null) {
    drift("messaging.list output.nextCursor", "must be null when more is false");
  }
  if (nextCursor !== null && nextCursor === parsedInput.cursor) {
    drift("messaging.list output.nextCursor", "must advance beyond the input cursor");
  }
  nullableCount(
    source.pendingInviteCount,
    "messaging.list output.pendingInviteCount",
  );
  nullableCount(
    source.directMessagesUnreadCount,
    "messaging.list output.directMessagesUnreadCount",
  );
  nullableCount(
    source.pubChatUnreadCount,
    "messaging.list output.pubChatUnreadCount",
  );
  const materialized = Object.freeze(entities.map(materializedConversation));
  const partition = `substack:inbox:${parsedInput.folder}`;
  return Object.freeze({
    schemaVersion: 1,
    partition,
    completeness: Object.freeze({
      kind: more === false && parsedInput.cursor === null
        ? "complete"
        : more === true
          ? "page"
          : more === false
            ? "page"
          : "unknown",
      reason: more === false
        ? parsedInput.cursor === null
          ? "Substack returned the complete inbox in one root page."
          : "Substack returned a terminal continuation page; it is merged without claiming standalone partition completeness."
        : more === true
          ? "Substack reported another inbox page and returned its opaque cursor."
          : "Substack omitted a definitive inbox continuation marker.",
    }),
    cursor: Object.freeze({
      direction: "backward",
      request: parsedInput.cursor,
      nextInput: nextCursor === null
        ? null
        : Object.freeze({
            folder: parsedInput.folder,
            cursor: nextCursor,
            limit: parsedInput.limit,
          }),
    }),
    entities: materialized,
    tombstones: Object.freeze([]),
  });
}
