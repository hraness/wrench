import { types as nodeTypes } from "node:util";

import { canonicalJson, sha256 } from "./canonical-json";
import { openCursorToken, sealCursorToken } from "./cursor-token";
import {
  OMNI_MAX_CURSOR_CHARACTERS,
  OMNI_MAX_REQUEST_BYTES,
  OMNI_MAX_SOURCES,
} from "./omni-limits";
import type { OmniEntityKindV1, OmniJsonValue } from "./omni-model";

const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 20_000;
const MAX_INPUT_BYTES = OMNI_MAX_REQUEST_BYTES;
const MAX_STRING_BYTES = 256 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Readonly<Record<string, unknown>>;

export type OmniViewSourceRequestV1 = {
  readonly adapterId: string;
  readonly operationId: "messaging.list" | "messaging.read";
  readonly authId: string;
  readonly input: Readonly<Record<string, OmniJsonValue>>;
};

export type OmniViewFilterV1 = {
  readonly kinds?: readonly OmniEntityKindV1[];
  readonly conversationId?: string;
  readonly unread?: boolean;
};

export type OmniViewRequestV1 = {
  readonly schemaVersion: 1;
  readonly sources: readonly OmniViewSourceRequestV1[];
  readonly filter?: OmniViewFilterV1;
  readonly page?: {
    readonly limit: number;
    readonly cursor?: string;
  };
};

export type OmniCursorAnchorV1 = {
  readonly orderedAt: string | null;
  readonly id: string;
};

function fail(label: string, message: string): never {
  throw new Error(`${label} ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return fail(label, "must be a plain non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return fail(label, "must not contain symbol properties");
  }
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label}.${key}`, "must be an enumerable data property");
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  const unknown = actual.find((key) => !allowed.has(key));
  if (unknown !== undefined) return fail(`${label}.${unknown}`, "is not reviewed");
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) return fail(`${label}.${missing}`, "is required");
}

function text(value: unknown, label: string, pattern: RegExp): string {
  if (
    typeof value !== "string"
    || !pattern.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES
  ) return fail(label, "is malformed");
  return value;
}

function identifier(value: unknown, label: string): string {
  return text(value, label, /^[a-z][a-z0-9-]{0,63}$/u);
}

function digest(value: unknown, label: string): string {
  return text(value, label, /^[a-f0-9]{64}$/u);
}

function cloneJson(
  value: unknown,
  label: string,
  state: { nodes: number },
  depth = 0,
): OmniJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) return fail(label, "exceeds its node bound");
  if (depth > MAX_JSON_DEPTH) return fail(label, "exceeds its nesting bound");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail(label, "must contain only finite numbers");
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
      return fail(label, "contains an oversized string");
    }
    return value;
  }
  if (nodeTypes.isProxy(value)) return fail(label, "must not contain proxies");
  if (Array.isArray(value)) {
    const entries = denseArray(value, label, MAX_JSON_NODES);
    return Object.freeze(entries.map((entry, index) =>
      cloneJson(entry, `${label}[${index}]`, state, depth + 1)));
  }
  const source = record(value, label);
  const result = Object.create(null) as Record<string, OmniJsonValue>;
  for (const key of Object.keys(source).sort()) {
    if (Buffer.byteLength(key, "utf8") > 1_024) {
      return fail(`${label}.${key}`, "has an oversized property name");
    }
    result[key] = cloneJson(source[key], `${label}.${key}`, state, depth + 1);
  }
  return Object.freeze(result);
}

function input(value: unknown, label: string): Readonly<Record<string, OmniJsonValue>> {
  const cloned = cloneJson(value, label, { nodes: 0 });
  if (Array.isArray(cloned) || typeof cloned !== "object" || cloned === null) {
    return fail(label, "must be a JSON object");
  }
  if (Buffer.byteLength(canonicalJson(cloned), "utf8") > MAX_INPUT_BYTES) {
    return fail(label, "exceeds its byte bound");
  }
  return cloned as Readonly<Record<string, OmniJsonValue>>;
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) return fail(label, `must be a plain array of at most ${maximum} items`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    return fail(label, "must be dense and have no named properties");
  }
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) return fail(`${label}[${index}]`, "must be an enumerable data property");
    entries.push(descriptor.value);
  }
  return Object.freeze(entries);
}

function parseSource(value: unknown, index: number): OmniViewSourceRequestV1 {
  const label = `omni request.sources[${index}]`;
  const source = record(value, label);
  exactKeys(source, ["adapterId", "operationId", "authId"], ["input"], label);
  if (source.operationId !== "messaging.list" && source.operationId !== "messaging.read") {
    return fail(`${label}.operationId`, "must be messaging.list or messaging.read");
  }
  return Object.freeze({
    adapterId: identifier(source.adapterId, `${label}.adapterId`),
    operationId: source.operationId,
    authId: identifier(source.authId, `${label}.authId`),
    input: input(source.input ?? {}, `${label}.input`),
  });
}

function parseFilter(value: unknown): OmniViewFilterV1 {
  const source = record(value, "omni request.filter");
  exactKeys(source, [], ["kinds", "conversationId", "unread"], "omni request.filter");
  const result: {
    kinds?: readonly OmniEntityKindV1[];
    conversationId?: string;
    unread?: boolean;
  } = {};
  if (source.kinds !== undefined) {
    const kinds = denseArray(source.kinds, "omni request.filter.kinds", 3)
      .map((value, index) => {
        if (value !== "conversation" && value !== "message" && value !== "notification") {
          return fail(`omni request.filter.kinds[${index}]`, "is unknown");
        }
        return value;
      });
    if (kinds.length === 0 || new Set(kinds).size !== kinds.length) {
      return fail("omni request.filter.kinds", "must be non-empty and unique");
    }
    result.kinds = Object.freeze([...kinds].sort());
  }
  if (source.conversationId !== undefined) {
    result.conversationId = digest(source.conversationId, "omni request.filter.conversationId");
  }
  if (source.unread !== undefined) {
    if (typeof source.unread !== "boolean") return fail("omni request.filter.unread", "must be boolean");
    result.unread = source.unread;
  }
  return Object.freeze(result);
}

function parsePage(value: unknown): NonNullable<OmniViewRequestV1["page"]> {
  const source = record(value, "omni request.page");
  exactKeys(source, [], ["limit", "cursor"], "omni request.page");
  const limit = source.limit ?? 100;
  if (
    typeof limit !== "number"
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 500
  ) return fail("omni request.page.limit", "must be an integer from 1 through 500");
  if (source.cursor !== undefined) {
    if (
      typeof source.cursor !== "string"
      || source.cursor.length < 1
      || source.cursor.length > OMNI_MAX_CURSOR_CHARACTERS
    ) return fail("omni request.page.cursor", "is malformed");
    return Object.freeze({ limit, cursor: source.cursor });
  }
  return Object.freeze({ limit });
}

export function parseOmniViewRequestV1(value: unknown): OmniViewRequestV1 {
  const source = record(value, "omni request");
  exactKeys(source, ["schemaVersion", "sources"], ["filter", "page"], "omni request");
  if (source.schemaVersion !== 1) return fail("omni request.schemaVersion", "must be 1");
  const sourceValues = denseArray(
    source.sources,
    "omni request.sources",
    OMNI_MAX_SOURCES,
  );
  if (sourceValues.length === 0) return fail("omni request.sources", "must not be empty");
  const sources = sourceValues.map(parseSource).sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)));
  const sourceKeys = sources.map((entry) => canonicalJson(entry));
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    return fail("omni request.sources", "must not repeat an exact source request");
  }
  const result = Object.freeze({
    schemaVersion: 1 as const,
    sources: Object.freeze(sources),
    ...(source.filter === undefined ? {} : { filter: parseFilter(source.filter) }),
    ...(source.page === undefined ? {} : { page: parsePage(source.page) }),
  });
  if (Buffer.byteLength(canonicalJson(result), "utf8") > OMNI_MAX_REQUEST_BYTES) {
    return fail("omni request", "exceeds its byte bound");
  }
  return result;
}

function withoutCursor(request: OmniViewRequestV1): unknown {
  return Object.freeze({
    schemaVersion: 1 as const,
    sources: request.sources,
    ...(request.filter === undefined ? {} : { filter: request.filter }),
    ...(request.page === undefined
      ? {}
      : { page: Object.freeze({ limit: request.page.limit }) }),
  });
}

export function omniRequestDigest(requestValue: OmniViewRequestV1): string {
  const request = parseOmniViewRequestV1(requestValue);
  return sha256(canonicalJson(withoutCursor(request)));
}

function cursorPayload(
  value: unknown,
  expectedRequestDigest: string,
  expectedSourceSetDigest: string,
  expectedViewDigest: string,
): OmniCursorAnchorV1 {
  const source = record(value, "omni cursor payload");
  exactKeys(
    source,
    ["schemaVersion", "requestDigest", "sourceSetDigest", "viewDigest", "anchor"],
    [],
    "omni cursor payload",
  );
  if (source.schemaVersion !== 1) return fail("omni cursor payload.schemaVersion", "must be 1");
  if (digest(source.requestDigest, "omni cursor payload.requestDigest") !== expectedRequestDigest) {
    return fail("omni cursor", "does not belong to this request");
  }
  if (digest(source.sourceSetDigest, "omni cursor payload.sourceSetDigest") !== expectedSourceSetDigest) {
    return fail("omni cursor", "does not belong to this source set");
  }
  if (digest(source.viewDigest, "omni cursor payload.viewDigest") !== expectedViewDigest) {
    return fail("omni cursor", "was invalidated by a changed view");
  }
  const anchor = record(source.anchor, "omni cursor payload.anchor");
  exactKeys(anchor, ["orderedAt", "id"], [], "omni cursor payload.anchor");
  if (
    anchor.orderedAt !== null
    && (
      typeof anchor.orderedAt !== "string"
      || !Number.isFinite(Date.parse(anchor.orderedAt))
      || new Date(Date.parse(anchor.orderedAt)).toISOString() !== anchor.orderedAt
    )
  ) return fail("omni cursor payload.anchor.orderedAt", "must be a canonical timestamp or null");
  return Object.freeze({
    orderedAt: anchor.orderedAt,
    id: digest(anchor.id, "omni cursor payload.anchor.id"),
  });
}

export function sealOmniViewCursorV1(
  requestValue: OmniViewRequestV1,
  sourceSetDigestValue: string,
  viewDigestValue: string,
  anchorValue: OmniCursorAnchorV1,
  environment: Environment = process.env,
): string {
  const request = parseOmniViewRequestV1(requestValue);
  const sourceSetDigest = digest(sourceSetDigestValue, "omni cursor source-set digest");
  const viewDigest = digest(viewDigestValue, "omni cursor view digest");
  const anchor = cursorPayload({
    schemaVersion: 1,
    requestDigest: omniRequestDigest(request),
    sourceSetDigest,
    viewDigest,
    anchor: anchorValue,
  }, omniRequestDigest(request), sourceSetDigest, viewDigest);
  return sealCursorToken("omni-view", "omni-view", sourceSetDigest, {
    schemaVersion: 1,
    requestDigest: omniRequestDigest(request),
    sourceSetDigest,
    viewDigest,
    anchor,
  }, environment);
}

export function openOmniViewCursorV1(
  requestValue: OmniViewRequestV1,
  sourceSetDigestValue: string,
  viewDigestValue: string,
  token: string,
  environment: Environment = process.env,
): OmniCursorAnchorV1 {
  const request = parseOmniViewRequestV1(requestValue);
  const sourceSetDigest = digest(sourceSetDigestValue, "omni cursor source-set digest");
  const viewDigest = digest(viewDigestValue, "omni cursor view digest");
  return cursorPayload(
    openCursorToken("omni-view", "omni-view", sourceSetDigest, token, environment),
    omniRequestDigest(request),
    sourceSetDigest,
    viewDigest,
  );
}
