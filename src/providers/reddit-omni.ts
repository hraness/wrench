import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";
import { OmniMaterializerDriftError } from "../omni-model";
import type {
  OmniParticipantV1,
  ProviderMaterializedEntityV1,
  ProviderMaterializedPageV1,
} from "../omni-model";

type RedditInboxFolder = "inbox" | "sent" | "unread";

type ParsedRedditInboxEntity = Readonly<{
  kind: "message" | "notification";
  providerId: string;
  author: string | null;
  recipient: string | null;
  subject: string;
  body: string;
  orderedAt: string | null;
  unread: boolean;
  parentId: string | null;
  context: string | null;
}>;

type ParsedRedditInboxPage = Readonly<{
  folder: RedditInboxFolder;
  requestedId: string | null;
  entities: readonly ParsedRedditInboxEntity[];
  nextAfter: string | null;
  previousBefore: string | null;
  limit: number;
}>;

function drift(path: string, message: string): never {
  throw new OmniMaterializerDriftError("reddit", path, message);
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

function array(value: unknown, path: string, maximum = 100): readonly unknown[] {
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

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return drift(path, "must be boolean");
  return value;
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

function fullname(
  value: unknown,
  path: string,
  kinds: readonly ("t1" | "t3" | "t4")[],
): string {
  const result = string(value, path, 40);
  const match = /^(t[134])_([a-z0-9]{1,32})$/u.exec(result);
  if (match === null || !kinds.includes(match[1] as "t1" | "t3" | "t4")) {
    return drift(path, `must be an exact ${kinds.join(" or ")} Reddit fullname`);
  }
  return result;
}

function username(value: unknown, path: string): string | null {
  if (value === null) return null;
  const result = string(value, path, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(result)) {
    return drift(path, "must be an exact Reddit username");
  }
  return result;
}

function absoluteRedditUrl(value: unknown, path: string): string | null {
  if (value === null) return null;
  const raw = string(value, path, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return drift(path, "must be an absolute Reddit HTTPS URL");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "www.reddit.com"
    || url.username !== ""
    || url.password !== ""
  ) return drift(path, "must be an absolute Reddit HTTPS URL");
  return url.href;
}

function timestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > 253_402_300_799
  ) return drift(path, "must be a finite Unix timestamp");
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) return drift(path, "must be a valid Unix timestamp");
  return date.toISOString();
}

function folder(value: unknown, path: string): RedditInboxFolder {
  if (value !== "inbox" && value !== "sent" && value !== "unread") {
    return drift(path, "must be inbox, sent, or unread");
  }
  return value;
}

function parseListInput(input: OperationInput): {
  readonly folder: RedditInboxFolder;
  readonly limit: number;
  readonly after: string | null;
} {
  const source = record(input, "messaging.list input");
  exactKeys(source, ["folder"], ["after", "limit"], "messaging.list input");
  const after = source.after === undefined
    ? null
    : fullname(source.after, "messaging.list input.after", ["t1", "t4"]);
  return Object.freeze({
    folder: folder(source.folder, "messaging.list input.folder"),
    limit: source.limit === undefined
      ? 25
      : integer(source.limit, "messaging.list input.limit", 1, 100),
    after,
  });
}

function participant(value: string | null): OmniParticipantV1 | null {
  return value === null
    ? null
    : Object.freeze({
        providerId: null,
        displayName: value,
        handle: value,
      });
}

function materializedEntity(
  value: ParsedRedditInboxEntity,
  folderValue: RedditInboxFolder,
): ProviderMaterializedEntityV1 {
  if (value.kind === "notification") {
    return Object.freeze({
      kind: "notification",
      providerId: value.providerId,
      providerRevision: null,
      orderedAt: value.orderedAt,
      actor: participant(value.author),
      subject: value.subject,
      body: value.body,
      unread: value.unread,
      context: value.context,
    });
  }
  const recipient = participant(value.recipient);
  return Object.freeze({
    kind: "message",
    providerId: value.providerId,
    providerRevision: null,
    orderedAt: value.orderedAt,
    conversationProviderId: null,
    sender: participant(value.author),
    recipients: Object.freeze(recipient === null ? [] : [recipient]),
    direction: folderValue === "sent" ? "outgoing" : "incoming",
    subject: value.subject,
    body: value.body,
    unread: value.unread,
    replyToProviderId: value.parentId,
    state: "active",
    attachments: Object.freeze([]),
  });
}

function parseReadInput(input: OperationInput): {
  readonly folder: RedditInboxFolder;
  readonly requestedId: string;
} {
  const source = record(input, "messaging.read input");
  exactKeys(source, ["folder", "message_id"], [], "messaging.read input");
  return Object.freeze({
    folder: folder(source.folder, "messaging.read input.folder"),
    requestedId: fullname(
      source.message_id,
      "messaging.read input.message_id",
      ["t4"],
    ),
  });
}

function parseEntity(value: unknown, path: string): ParsedRedditInboxEntity {
  const source = record(value, path);
  exactKeys(source, [
    "kind",
    "id",
    "author",
    "recipient",
    "subject",
    "body",
    "createdUtc",
    "unread",
    "parentId",
    "context",
  ], [], path);
  if (source.kind !== "message" && source.kind !== "notification") {
    return drift(`${path}.kind`, "must be message or notification");
  }
  const kind = source.kind;
  const providerId = fullname(
    source.id,
    `${path}.id`,
    kind === "message" ? ["t4"] : ["t1"],
  );
  const parentId = source.parentId === null
    ? null
    : fullname(source.parentId, `${path}.parentId`, ["t1", "t3", "t4"]);
  return Object.freeze({
    kind,
    providerId,
    author: username(source.author, `${path}.author`),
    recipient: username(source.recipient, `${path}.recipient`),
    subject: string(source.subject, `${path}.subject`, 1_000, true),
    body: string(source.body, `${path}.body`, 100_000, true),
    orderedAt: timestamp(source.createdUtc, `${path}.createdUtc`),
    unread: boolean(source.unread, `${path}.unread`),
    parentId,
    context: absoluteRedditUrl(source.context, `${path}.context`),
  });
}

function parseOutput(
  output: unknown,
  options: {
    readonly folder: RedditInboxFolder;
    readonly requestedId: string | null;
    readonly limit: number;
  },
): ParsedRedditInboxPage {
  const source = record(output, "output");
  exactKeys(source, ["messages", "after", "before", "requested"], [], "output");
  const entities = array(source.messages, "output.messages", 101).map((value, index) =>
    parseEntity(value, `output.messages[${index}]`));
  if (options.requestedId === null && entities.length > options.limit) {
    drift("output.messages", "exceeds messaging.list input.limit");
  }
  const ids = entities.map((entity) => entity.providerId);
  if (new Set(ids).size !== ids.length) drift("output.messages", "contains duplicate stable IDs");
  const nextAfter = source.after === null
    ? null
    : fullname(source.after, "output.after", ["t1", "t4"]);
  const previousBefore = source.before === null
    ? null
    : fullname(source.before, "output.before", ["t1", "t4"]);
  if (nextAfter !== null && nextAfter === previousBefore) {
    drift("output.after", "must not repeat output.before");
  }
  if (options.requestedId === null) {
    if (source.requested !== null) drift("output.requested", "must be null for messaging.list");
  } else {
    if (source.requested === null) drift("output.requested", "is required for messaging.read");
    const requested = parseEntity(source.requested, "output.requested");
    if (requested.kind !== "message" || requested.providerId !== options.requestedId) {
      drift("output.requested.id", "must bind the requested legacy message");
    }
    const matches = entities.filter((entity) => entity.providerId === requested.providerId);
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(requested)) {
      drift("output.requested", "must equal one ordered output.messages entity");
    }
  }
  return Object.freeze({
    folder: options.folder,
    requestedId: options.requestedId,
    entities: Object.freeze(entities),
    nextAfter,
    previousBefore,
    limit: options.limit,
  });
}

/** Strict provider-owned parse; the shared omni envelope is assembled below this boundary. */
export function materializeRedditMessagingList(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsed = parseListInput(input);
  const page = parseOutput(output, {
    folder: parsed.folder,
    requestedId: null,
    limit: parsed.limit,
  });
  if (page.nextAfter !== null && page.nextAfter === parsed.after) {
    drift("output.after", "must advance beyond messaging.list input.after");
  }
  const entities = Object.freeze(page.entities.map((entity) =>
    materializedEntity(entity, parsed.folder)));
  return Object.freeze({
    schemaVersion: 1,
    partition: `reddit:inbox:${parsed.folder}`,
    completeness: Object.freeze({
      kind: page.nextAfter === null && parsed.after === null
        ? "complete"
        : "page",
      reason: page.nextAfter === null
        ? parsed.after === null
          ? "Reddit returned the complete legacy inbox Listing in one root page."
          : "Reddit returned a terminal continuation page; it is merged without claiming standalone partition completeness."
        : "Reddit returned an older-page cursor for the legacy inbox Listing.",
    }),
    cursor: Object.freeze({
      direction: "backward",
      request: parsed.after,
      nextInput: page.nextAfter === null
        ? null
        : Object.freeze({
            folder: parsed.folder,
            after: page.nextAfter,
            limit: parsed.limit,
          }),
    }),
    entities,
    tombstones: Object.freeze([]),
  });
}

/** Strict provider-owned parse; the shared omni envelope is assembled below this boundary. */
export function materializeRedditMessagingRead(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsed = parseReadInput(input);
  const page = parseOutput(output, {
    folder: parsed.folder,
    requestedId: parsed.requestedId,
    limit: 101,
  });
  if (page.nextAfter !== null || page.previousBefore !== null) {
    drift("output", "must not paginate an exact messaging.read result");
  }
  const entities = Object.freeze(page.entities.map((entity) =>
    materializedEntity(entity, parsed.folder)));
  return Object.freeze({
    schemaVersion: 1,
    partition: `reddit:message:${parsed.requestedId}`,
    completeness: Object.freeze({
      kind: "complete",
      reason: "Reddit returned and identity-bound the exact requested legacy message.",
    }),
    cursor: Object.freeze({
      direction: "none",
      request: null,
      nextInput: null,
    }),
    entities,
    tombstones: Object.freeze([]),
  });
}
