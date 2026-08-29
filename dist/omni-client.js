// @bun
import {
  canonicalJson,
  sha256
} from "./index-dqv16dt0.js";

// src/omni-client.ts
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { types as nodeTypes } from "util";

// src/omni-limits.ts
var OMNI_MAX_REQUEST_BYTES = 1024 * 1024;
var OMNI_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
var OMNI_MAX_REASON_BYTES = 8 * 1024;
var OMNI_MAX_SOURCES = 32;
var OMNI_MAX_VIEW_ENTITIES = 500;
var OMNI_MAX_CURSOR_CHARACTERS = 8192;
function boundedOmniText(value, maximumBytes, suffix = "\u2026") {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes)
    return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes > maximumBytes) {
    throw new Error("omni text suffix exceeds its byte bound");
  }
  const limit = maximumBytes - suffixBytes;
  let used = 0;
  let prefix = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > limit)
      break;
    prefix += character;
    used += size;
  }
  return `${prefix}${suffix}`;
}

// src/omni-client.ts
var MAX_JSON_DEPTH = 64;
var MAX_JSON_NODES = 1e5;
var MAX_PARTICIPANTS = 256;
var MAX_ATTACHMENTS = 64;
var SYNCHRONOUS_COMMAND_TIMEOUT_MS = 20000;
var ASYNC_CONTROL_COMMAND_TIMEOUT_MS = 20000;
var CHILD_GRACEFUL_TERMINATION_MS = 40000;
var CHILD_FORCEFUL_TERMINATION_MS = 5000;
var abortSignalAbortedGetter = (() => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
  const getter = descriptor === undefined ? undefined : Reflect.get(descriptor, "get");
  return typeof getter !== "function" ? undefined : (value) => Reflect.apply(getter, value, []);
})();
function fail(label, message) {
  throw new Error(`${label} ${message}`);
}
function record(value, label) {
  if (nodeTypes.isProxy(value) || typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail(label, "must be a plain non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return fail(label, "must not contain symbol properties");
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(`${label}.${key}`, "must be an enumerable data property");
  }
  return value;
}
function exactKeys(value, required, optional, label) {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  const unknown = actual.find((key) => !allowed.has(key));
  if (unknown !== undefined)
    return fail(`${label}.${unknown}`, "is not reviewed");
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined)
    return fail(`${label}.${missing}`, "is required");
}
function denseArray(value, label, maximum) {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum)
    return fail(label, `must be a plain array of at most ${maximum} items`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index))
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    return fail(label, "must be a dense array without named properties");
  }
  for (let index = 0;index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(`${label}[${index}]`, "must be an enumerable data property");
  }
  return value;
}
function text(value, label, maximumBytes, allowEmpty = false) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes || !allowEmpty && value.length === 0 || [...value].some((character) => {
    const code = character.codePointAt(0) ?? -1;
    return code === 0 || code === 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127;
  }))
    return fail(label, "must be bounded text");
  return value;
}
function nullableText(value, label, maximumBytes, allowEmpty = false) {
  return value === null ? null : text(value, label, maximumBytes, allowEmpty);
}
function identifier(value, label) {
  const result = text(value, label, 64);
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(result)) {
    return fail(label, "must be lowercase kebab-case");
  }
  return result;
}
function digest(value, label) {
  const result = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(result))
    return fail(label, "must be a SHA-256 digest");
  return result;
}
function localCursor(value, label) {
  const result = text(value, label, OMNI_MAX_CURSOR_CHARACTERS);
  if (!result.startsWith("smn1.")) {
    return fail(label, "must be an authenticated local omni cursor");
  }
  const encoded = result.slice("smn1.".length);
  if (encoded === "" || /[^A-Za-z0-9_-]/u.test(encoded)) {
    return fail(label, "must be an authenticated local omni cursor");
  }
  const envelope = Buffer.from(encoded, "base64url");
  if (envelope.toString("base64url") !== encoded || envelope.byteLength <= 12 + 16) {
    return fail(label, "must be an authenticated local omni cursor");
  }
  return result;
}
function timestamp(value, label) {
  const result = text(value, label, 64);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    return fail(label, "must be a canonical ISO timestamp");
  }
  return result;
}
function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}
function integer(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    return fail(label, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}
function nullableInteger(value, label, minimum, maximum) {
  return value === null ? null : integer(value, label, minimum, maximum);
}
function nullableBoolean(value, label) {
  if (value === null || typeof value === "boolean")
    return value;
  return fail(label, "must be boolean or null");
}
function boolean(value, label) {
  if (typeof value === "boolean")
    return value;
  return fail(label, "must be boolean");
}
function oneOf(value, values, label) {
  if (typeof value !== "string" || !values.includes(value)) {
    return fail(label, `must be one of ${values.join(", ")}`);
  }
  return value;
}
function snapshotJson(value, label) {
  let nodes = 0;
  const ancestors = new WeakSet;
  const completed = new WeakMap;
  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      return fail(label, "exceeds its structural bound");
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string")
      return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        return fail(label, "must contain only JSON data");
      return candidate;
    }
    if (typeof candidate !== "object")
      return fail(label, "must contain only JSON data");
    if (nodeTypes.isProxy(candidate))
      return fail(label, "must not contain proxies");
    const prior = completed.get(candidate);
    if (prior !== undefined)
      return prior;
    if (ancestors.has(candidate))
      return fail(label, "must not be circular");
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const values = denseArray(candidate, label, MAX_JSON_NODES);
        const cloned2 = Object.freeze(values.map((entry) => visit(entry, depth + 1)));
        completed.set(candidate, cloned2);
        return cloned2;
      }
      const source = record(candidate, label);
      const cloned = {};
      for (const key of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
        Object.defineProperty(cloned, key, {
          value: visit(source[key], depth + 1),
          enumerable: true,
          configurable: false,
          writable: false
        });
      }
      const result = Object.freeze(cloned);
      completed.set(candidate, result);
      return result;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value, 0);
}
function parseRequestSource(value, index) {
  const label = `Wrench omni request.sources[${index}]`;
  const source = record(value, label);
  exactKeys(source, ["adapterId", "operationId", "authId"], ["input"], label);
  const operationId = oneOf(source.operationId, ["messaging.list", "messaging.read"], `${label}.operationId`);
  const inputValue = Object.hasOwn(source, "input") ? source.input : {};
  const input = record(inputValue, `${label}.input`);
  return Object.freeze({
    adapterId: identifier(source.adapterId, `${label}.adapterId`),
    operationId,
    authId: identifier(source.authId, `${label}.authId`),
    input
  });
}
function prepareRequest(requestValue) {
  const snapshot = snapshotJson(requestValue, "Wrench omni request");
  const request = record(snapshot, "Wrench omni request");
  exactKeys(request, ["schemaVersion", "sources"], ["filter", "page"], "Wrench omni request");
  if (request.schemaVersion !== 1)
    return fail("Wrench omni request.schemaVersion", "must be 1");
  const sources = denseArray(request.sources, "Wrench omni request.sources", OMNI_MAX_SOURCES).map(parseRequestSource).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (sources.length === 0)
    return fail("Wrench omni request.sources", "must not be empty");
  const sourceKeys = sources.map((source) => canonicalJson(source));
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    return fail("Wrench omni request.sources", "must not repeat an exact source request");
  }
  let filter;
  if (request.filter !== undefined) {
    const value = record(request.filter, "Wrench omni request.filter");
    exactKeys(value, [], ["kinds", "conversationId", "unread"], "Wrench omni request.filter");
    let kinds;
    if (value.kinds !== undefined) {
      const parsed = denseArray(value.kinds, "Wrench omni request.filter.kinds", 3).map((kind, index) => oneOf(kind, ["conversation", "message", "notification"], `Wrench omni request.filter.kinds[${index}]`));
      if (parsed.length === 0 || new Set(parsed).size !== parsed.length) {
        return fail("Wrench omni request.filter.kinds", "must be non-empty and unique");
      }
      kinds = Object.freeze([...parsed].sort());
    }
    const conversationId = value.conversationId === undefined ? undefined : digest(value.conversationId, "Wrench omni request.filter.conversationId");
    if (value.unread !== undefined && typeof value.unread !== "boolean") {
      return fail("Wrench omni request.filter.unread", "must be boolean");
    }
    filter = Object.freeze({
      ...kinds === undefined ? {} : { kinds },
      ...conversationId === undefined ? {} : { conversationId },
      ...value.unread === undefined ? {} : { unread: value.unread }
    });
  }
  let page;
  if (request.page !== undefined) {
    const value = record(request.page, "Wrench omni request.page");
    exactKeys(value, [], ["limit", "cursor"], "Wrench omni request.page");
    const limit = value.limit === undefined ? 100 : integer(value.limit, "Wrench omni request.page.limit", 1, 500);
    const cursor = value.cursor === undefined ? undefined : localCursor(value.cursor, "Wrench omni request.page.cursor");
    page = Object.freeze({
      limit,
      ...cursor === undefined ? {} : { cursor }
    });
  }
  const normalized = Object.freeze({
    schemaVersion: 1,
    sources: Object.freeze(sources),
    ...filter === undefined ? {} : { filter },
    ...page === undefined ? {} : { page }
  });
  const json = canonicalJson(normalized);
  if (Buffer.byteLength(json, "utf8") > OMNI_MAX_REQUEST_BYTES) {
    return fail("Wrench omni request", "exceeds its byte bound");
  }
  const cursorIndependentRequest = Object.freeze({
    schemaVersion: 1,
    sources: normalized.sources,
    ...filter === undefined ? {} : { filter },
    ...page === undefined ? {} : { page: Object.freeze({ limit: page.limit ?? 100 }) }
  });
  return Object.freeze({
    json,
    invocationDigest: sha256(json),
    requestDigest: sha256(canonicalJson(cursorIndependentRequest)),
    sources: Object.freeze(sources.map((source) => Object.freeze({
      adapterId: source.adapterId,
      operationId: source.operationId,
      authId: source.authId,
      requestInputHash: sha256(canonicalJson(source.input ?? {}))
    }))),
    filter: Object.freeze({
      kinds: filter?.kinds ?? null,
      conversationId: filter?.conversationId ?? null,
      unread: filter?.unread ?? null
    }),
    pageLimit: page?.limit ?? 100
  });
}
function environmentName(value) {
  if (value.length === 0 || value.includes("=") || value.includes("\x00")) {
    return fail("Wrench omni client environment name", "is malformed");
  }
  return value;
}
function defineEnvironmentValue(environment, key, value) {
  Object.defineProperty(environment, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}
function snapshotEnvironment(value) {
  const result = Object.create(null);
  for (const [key, environmentValue] of Object.entries(process.env)) {
    if (typeof environmentValue === "string") {
      defineEnvironmentValue(result, key, environmentValue);
    }
  }
  if (value === undefined)
    return Object.freeze(result);
  const overrides = record(value, "Wrench omni client environment");
  for (const [key, environmentValue] of Object.entries(overrides)) {
    const name = environmentName(key);
    if (environmentValue === undefined) {
      delete result[name];
    } else if (typeof environmentValue !== "string" || environmentValue.includes("\x00")) {
      return fail("Wrench omni client environment value", "is malformed");
    } else {
      defineEnvironmentValue(result, name, environmentValue);
    }
  }
  return Object.freeze(result);
}
function isBrandedAbortSignal(value) {
  if (nodeTypes.isProxy(value) || typeof value !== "object" || value === null || abortSignalAbortedGetter === undefined || Object.getPrototypeOf(value) !== AbortSignal.prototype)
    return false;
  try {
    return typeof abortSignalAbortedGetter(value) === "boolean";
  } catch {
    return false;
  }
}
function snapshotOptions(optionsValue, revalidation) {
  const options = record(optionsValue, "Wrench omni client options");
  exactKeys(options, [], revalidation ? ["environment", "headed", "signal"] : ["environment"], "Wrench omni client options");
  const headedValue = options.headed;
  const signalValue = options.signal;
  if (headedValue !== undefined && typeof headedValue !== "boolean") {
    return fail("Wrench omni client headed option", "is malformed");
  }
  if (signalValue !== undefined && !isBrandedAbortSignal(signalValue)) {
    return fail("Wrench omni client abort signal", "is malformed");
  }
  return Object.freeze({
    cwd: process.cwd(),
    environment: snapshotEnvironment(options.environment),
    headed: headedValue === true,
    ...signalValue === undefined ? {} : { signal: signalValue }
  });
}
function signalAborted(signal) {
  if (abortSignalAbortedGetter === undefined)
    return true;
  return abortSignalAbortedGetter(signal) === true;
}
function throwIfAborted(signal) {
  if (signal === undefined || !signalAborted(signal))
    return;
  throw abortError(signal);
}
function abortError(signal) {
  const reason = signal.reason;
  if (reason instanceof Error)
    return reason;
  const error = new Error("Wrench omni revalidation was aborted");
  error.name = "AbortError";
  return error;
}
function cliSourcePath() {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource))
    return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource))
    return packagedSource;
  throw new Error("the installed Wrench CLI source is unavailable");
}
function requireBunRuntime() {
  if (typeof process.versions.bun !== "string") {
    throw new Error("@hraness/wrench/omni requires Bun to run the installed Wrench CLI");
  }
}
function preparedCommand(request, mode, options) {
  return Object.freeze({
    arguments: Object.freeze([
      cliSourcePath(),
      "omni",
      "read",
      "--input",
      "-",
      ...mode === "cache" ? ["--cache-only"] : [],
      ...mode === "identity" ? ["--identity-only"] : [],
      ...mode === "live" && options.headed ? ["--headed"] : [],
      "--json"
    ]),
    input: request.json,
    request
  });
}
function boundedMessage(value) {
  return boundedOmniText(value, OMNI_MAX_REASON_BYTES).trim();
}
function childText(value, label) {
  if (nodeTypes.isProxy(value))
    return fail(label, "must not be a proxy");
  if (typeof value === "string")
    return value;
  if (Buffer.isBuffer(value))
    return Buffer.from(value).toString("utf8");
  return fail(label, "must be UTF-8 text");
}
function parseJsonOutput(textValue, label) {
  if (Buffer.byteLength(textValue, "utf8") > OMNI_MAX_RESPONSE_BYTES) {
    return fail(label, "exceeds its byte bound");
  }
  try {
    return JSON.parse(textValue);
  } catch {
    return fail(label, "is malformed JSON");
  }
}
function participant(value, label) {
  const source = record(value, label);
  exactKeys(source, ["providerId", "displayName", "handle"], [], label);
  return Object.freeze({
    providerId: nullableText(source.providerId, `${label}.providerId`, 1024),
    displayName: nullableText(source.displayName, `${label}.displayName`, 2048, true),
    handle: nullableText(source.handle, `${label}.handle`, 512)
  });
}
function attachment(value, label) {
  const source = record(value, label);
  exactKeys(source, ["kind", "mimeType", "name", "sizeBytes"], [], label);
  return Object.freeze({
    kind: oneOf(source.kind, ["audio", "document", "image", "link", "sticker", "video", "unknown"], `${label}.kind`),
    mimeType: nullableText(source.mimeType, `${label}.mimeType`, 256),
    name: nullableText(source.name, `${label}.name`, 2048, true),
    sizeBytes: nullableInteger(source.sizeBytes, `${label}.sizeBytes`, 0, Number.MAX_SAFE_INTEGER)
  });
}
function entityCommon(source, label) {
  const entitySource = record(source.source, `${label}.source`);
  exactKeys(entitySource, ["surfaceId", "authId", "providerId"], [], `${label}.source`);
  const providerId = text(source.providerId, `${label}.providerId`, 1024);
  const providerSourceId = text(entitySource.providerId, `${label}.source.providerId`, 1024);
  if (providerSourceId !== providerId) {
    return fail(`${label}.source.providerId`, "does not match providerId");
  }
  return Object.freeze({
    id: digest(source.id, `${label}.id`),
    providerId,
    providerRevision: nullableText(source.providerRevision, `${label}.providerRevision`, 1024),
    orderedAt: nullableTimestamp(source.orderedAt, `${label}.orderedAt`),
    source: Object.freeze({
      surfaceId: text(entitySource.surfaceId, `${label}.source.surfaceId`, 64),
      authId: text(entitySource.authId, `${label}.source.authId`, 64),
      providerId: providerSourceId
    }),
    conversationId: source.conversationId === null ? null : digest(source.conversationId, `${label}.conversationId`)
  });
}
function verifyEntityRevision(semantic, revisionValue, label) {
  const revision = digest(revisionValue, `${label}.revision`);
  if (sha256(canonicalJson(semantic)) !== revision) {
    return fail(`${label}.revision`, "does not authenticate its semantic fields");
  }
  return Object.freeze({ ...semantic, revision });
}
function conversationEntity(source, label) {
  const hasConversationKind = Object.hasOwn(source, "conversationKind");
  exactKeys(source, [
    "kind",
    "providerId",
    "providerRevision",
    "orderedAt",
    ...hasConversationKind ? ["conversationKind"] : [],
    "detail",
    "title",
    "summary",
    "participants",
    "unread",
    "unreadCount",
    "archived",
    "pending",
    "id",
    "revision",
    "source",
    "conversationId"
  ], [], label);
  const common = entityCommon(source, label);
  if (common.conversationId !== null) {
    return fail(`${label}.conversationId`, "must be null for conversations");
  }
  const semantic = Object.freeze({
    kind: "conversation",
    ...hasConversationKind ? {
      conversationKind: oneOf(source.conversationKind, ["single", "group", "unknown"], `${label}.conversationKind`)
    } : {},
    providerId: common.providerId,
    providerRevision: common.providerRevision,
    orderedAt: common.orderedAt,
    detail: oneOf(source.detail, ["summary", "full"], `${label}.detail`),
    title: nullableText(source.title, `${label}.title`, 4096, true),
    summary: nullableText(source.summary, `${label}.summary`, 64 * 1024, true),
    participants: Object.freeze(denseArray(source.participants, `${label}.participants`, MAX_PARTICIPANTS).map((entry, index) => participant(entry, `${label}.participants[${index}]`))),
    unread: nullableBoolean(source.unread, `${label}.unread`),
    unreadCount: nullableInteger(source.unreadCount, `${label}.unreadCount`, 0, Number.MAX_SAFE_INTEGER),
    archived: nullableBoolean(source.archived, `${label}.archived`),
    pending: nullableBoolean(source.pending, `${label}.pending`),
    id: common.id,
    source: common.source,
    conversationId: common.conversationId
  });
  return verifyEntityRevision(semantic, source.revision, label);
}
function messageEntity(source, label) {
  const hasBodyTruncated = Object.hasOwn(source, "bodyTruncated");
  exactKeys(source, [
    "kind",
    "providerId",
    "providerRevision",
    "orderedAt",
    "conversationProviderId",
    "sender",
    "recipients",
    "direction",
    "subject",
    "body",
    "unread",
    "replyToProviderId",
    "state",
    "attachments",
    "id",
    "revision",
    "source",
    "conversationId"
  ], hasBodyTruncated ? ["bodyTruncated"] : [], label);
  const common = entityCommon(source, label);
  const conversationProviderId = nullableText(source.conversationProviderId, `${label}.conversationProviderId`, 1024);
  if (conversationProviderId === null !== (common.conversationId === null)) {
    return fail(`${label}.conversationId`, "is inconsistent with conversationProviderId");
  }
  const body = nullableText(source.body, `${label}.body`, 256 * 1024, true);
  const bodyTruncated = hasBodyTruncated ? boolean(source.bodyTruncated, `${label}.bodyTruncated`) : undefined;
  if (body === null && bodyTruncated === true) {
    return fail(`${label}.bodyTruncated`, "cannot be true when body is null");
  }
  const semantic = Object.freeze({
    kind: "message",
    providerId: common.providerId,
    providerRevision: common.providerRevision,
    orderedAt: common.orderedAt,
    conversationProviderId,
    sender: source.sender === null ? null : participant(source.sender, `${label}.sender`),
    recipients: Object.freeze(denseArray(source.recipients, `${label}.recipients`, MAX_PARTICIPANTS).map((entry, index) => participant(entry, `${label}.recipients[${index}]`))),
    direction: oneOf(source.direction, ["incoming", "outgoing", "unknown"], `${label}.direction`),
    subject: nullableText(source.subject, `${label}.subject`, 8192, true),
    body,
    ...bodyTruncated === undefined ? {} : { bodyTruncated },
    unread: nullableBoolean(source.unread, `${label}.unread`),
    replyToProviderId: nullableText(source.replyToProviderId, `${label}.replyToProviderId`, 1024),
    state: oneOf(source.state, ["active", "revoked", "deleted-for-me", "revoked-and-deleted-for-me"], `${label}.state`),
    attachments: Object.freeze(denseArray(source.attachments, `${label}.attachments`, MAX_ATTACHMENTS).map((entry, index) => attachment(entry, `${label}.attachments[${index}]`))),
    id: common.id,
    source: common.source,
    conversationId: common.conversationId
  });
  return verifyEntityRevision(semantic, source.revision, label);
}
function notificationEntity(source, label) {
  exactKeys(source, [
    "kind",
    "providerId",
    "providerRevision",
    "orderedAt",
    "actor",
    "subject",
    "body",
    "unread",
    "context",
    "id",
    "revision",
    "source",
    "conversationId"
  ], [], label);
  const common = entityCommon(source, label);
  if (common.conversationId !== null) {
    return fail(`${label}.conversationId`, "must be null for notifications");
  }
  const semantic = Object.freeze({
    kind: "notification",
    providerId: common.providerId,
    providerRevision: common.providerRevision,
    orderedAt: common.orderedAt,
    actor: source.actor === null ? null : participant(source.actor, `${label}.actor`),
    subject: nullableText(source.subject, `${label}.subject`, 8192, true),
    body: nullableText(source.body, `${label}.body`, 256 * 1024, true),
    unread: nullableBoolean(source.unread, `${label}.unread`),
    context: nullableText(source.context, `${label}.context`, 8192),
    id: common.id,
    source: common.source,
    conversationId: common.conversationId
  });
  return verifyEntityRevision(semantic, source.revision, label);
}
function entity(value, index) {
  const label = `Wrench omni view.entities[${index}]`;
  const source = record(value, label);
  const kind = oneOf(source.kind, ["conversation", "message", "notification"], `${label}.kind`);
  if (kind === "conversation")
    return conversationEntity(source, label);
  if (kind === "message")
    return messageEntity(source, label);
  return notificationEntity(source, label);
}
function freshness(value, label) {
  const source = record(value, label);
  exactKeys(source, ["state", "freshForMs"], [], label);
  const state = oneOf(source.state, ["fresh", "stale", "unclassified"], `${label}.state`);
  const freshForMs = source.freshForMs === null ? null : integer(source.freshForMs, `${label}.freshForMs`, 0, 365 * 24 * 60 * 60 * 1000);
  if (state === "unclassified" !== (freshForMs === null)) {
    return fail(label, "has inconsistent classification and window");
  }
  return Object.freeze({ state, freshForMs });
}
function coverage(value, label) {
  const source = record(value, label);
  const state = oneOf(source.state, ["unavailable", "observed"], `${label}.state`);
  if (state === "unavailable") {
    exactKeys(source, ["state", "reason"], [], label);
    return Object.freeze({
      state,
      reason: text(source.reason, `${label}.reason`, 8192)
    });
  }
  exactKeys(source, ["state", "kind", "continuation", "reason"], [], label);
  const kind = oneOf(source.kind, [
    "complete",
    "page",
    "unknown",
    "first-page-only",
    "bounded-local",
    "search-window",
    "truncated"
  ], `${label}.kind`);
  const continuation = oneOf(source.continuation, ["none", "pending", "unavailable"], `${label}.continuation`);
  if (kind === "complete" && continuation !== "none") {
    return fail(label, "must not continue an authoritative complete set");
  }
  if (kind === "first-page-only" && continuation !== "unavailable") {
    return fail(label, "must mark first-page-only continuation unavailable");
  }
  return Object.freeze({
    state,
    kind,
    continuation,
    reason: nullableText(source.reason, `${label}.reason`, 8192, true)
  });
}
function sourceStatus(value, index) {
  const label = `Wrench omni view.sources[${index}]`;
  const source = record(value, label);
  exactKeys(source, [
    "adapterId",
    "operationId",
    "authId",
    "requestInputHash",
    "projectionInputHash",
    "normalizationDataRevision",
    "surfaceId",
    "exact",
    "normalization",
    "coverage"
  ], [], label);
  const exact = record(source.exact, `${label}.exact`);
  exactKeys(exact, ["state", "key"], ["dataRevision", "validatedAt", "ageMs", "freshness", "reason"], `${label}.exact`);
  const exactState = oneOf(exact.state, ["hit", "miss", "error"], `${label}.exact.state`);
  const dataRevision = exact.dataRevision === undefined ? undefined : digest(exact.dataRevision, `${label}.exact.dataRevision`);
  const validatedAt = exact.validatedAt === undefined ? undefined : timestamp(exact.validatedAt, `${label}.exact.validatedAt`);
  const ageMs = exact.ageMs === undefined ? undefined : integer(exact.ageMs, `${label}.exact.ageMs`, 0, Number.MAX_SAFE_INTEGER);
  const parsedFreshness = exact.freshness === undefined ? undefined : freshness(exact.freshness, `${label}.exact.freshness`);
  const exactReason = exact.reason === undefined ? undefined : text(exact.reason, `${label}.exact.reason`, 8192);
  if (exactState === "hit" && (dataRevision === undefined || validatedAt === undefined || ageMs === undefined || parsedFreshness === undefined || exactReason !== undefined))
    return fail(`${label}.exact`, "must fully describe a hit");
  if (exactState === "miss" && (dataRevision !== undefined || validatedAt !== undefined || ageMs !== undefined || parsedFreshness !== undefined || exactReason !== undefined))
    return fail(`${label}.exact`, "must not attach metadata to a miss");
  if (exactState === "error" && (dataRevision !== undefined || validatedAt !== undefined || ageMs !== undefined || parsedFreshness !== undefined || exactReason === undefined))
    return fail(`${label}.exact`, "must describe only the exact read error");
  if (exactState === "hit" && parsedFreshness.state !== "unclassified" && parsedFreshness.state === "fresh" !== ageMs <= parsedFreshness.freshForMs) {
    return fail(`${label}.exact.freshness`, "does not match the returned cache age");
  }
  const exactKey = digest(exact.key, `${label}.exact.key`);
  const exactStatus = exactState === "hit" ? Object.freeze({
    state: exactState,
    key: exactKey,
    dataRevision,
    validatedAt,
    ageMs,
    freshness: parsedFreshness
  }) : exactState === "error" ? Object.freeze({ state: exactState, key: exactKey, reason: exactReason }) : Object.freeze({ state: exactState, key: exactKey });
  const normalization = record(source.normalization, `${label}.normalization`);
  exactKeys(normalization, ["state"], [
    "reason",
    "exactQueryKey",
    "exactDataRevision",
    "normalizedExactDataRevision",
    "failedExactDataRevision",
    "newerExactDataRevision",
    "lastGoodExactDataRevision",
    "lastGoodAt"
  ], `${label}.normalization`);
  const normalizationState = oneOf(normalization.state, [
    "current",
    "missing",
    "unsupported",
    "retained-after-drift",
    "stale",
    "error"
  ], `${label}.normalization.state`);
  const reason = normalization.reason === undefined ? undefined : text(normalization.reason, `${label}.normalization.reason`, 8192);
  const exactQueryKey = normalization.exactQueryKey === undefined ? undefined : digest(normalization.exactQueryKey, `${label}.normalization.exactQueryKey`);
  const exactDataRevision = normalization.exactDataRevision === undefined ? undefined : normalization.exactDataRevision === null ? null : digest(normalization.exactDataRevision, `${label}.normalization.exactDataRevision`);
  const normalizedExactDataRevision = normalization.normalizedExactDataRevision === undefined ? undefined : normalization.normalizedExactDataRevision === null ? null : digest(normalization.normalizedExactDataRevision, `${label}.normalization.normalizedExactDataRevision`);
  const failedExactDataRevision = normalization.failedExactDataRevision === undefined ? undefined : digest(normalization.failedExactDataRevision, `${label}.normalization.failedExactDataRevision`);
  const newerExactDataRevision = normalization.newerExactDataRevision === undefined ? undefined : normalization.newerExactDataRevision === null ? null : digest(normalization.newerExactDataRevision, `${label}.normalization.newerExactDataRevision`);
  const lastGoodExactDataRevision = normalization.lastGoodExactDataRevision === undefined ? undefined : normalization.lastGoodExactDataRevision === null ? null : digest(normalization.lastGoodExactDataRevision, `${label}.normalization.lastGoodExactDataRevision`);
  const lastGoodAt = normalization.lastGoodAt === undefined ? undefined : nullableTimestamp(normalization.lastGoodAt, `${label}.normalization.lastGoodAt`);
  let normalizationStatus;
  if (normalizationState === "missing") {
    if (reason !== undefined || exactQueryKey !== undefined || exactDataRevision !== undefined || normalizedExactDataRevision !== undefined || failedExactDataRevision !== undefined || newerExactDataRevision !== undefined || lastGoodExactDataRevision !== undefined || lastGoodAt !== undefined)
      return fail(`${label}.normalization`, "must not attach metadata to a miss");
    normalizationStatus = Object.freeze({ state: normalizationState });
  } else if (normalizationState === "unsupported") {
    if (reason === undefined || exactQueryKey !== undefined || exactDataRevision !== undefined || normalizedExactDataRevision !== undefined || failedExactDataRevision !== undefined || newerExactDataRevision !== undefined || lastGoodExactDataRevision !== undefined || lastGoodAt !== undefined)
      return fail(`${label}.normalization`, "must describe only why it is unsupported");
    normalizationStatus = Object.freeze({ state: normalizationState, reason });
  } else if (normalizationState === "current") {
    if (reason !== undefined || exactQueryKey === undefined || exactDataRevision === undefined || exactDataRevision === null || normalizedExactDataRevision !== undefined || failedExactDataRevision !== undefined || newerExactDataRevision !== undefined || lastGoodExactDataRevision !== undefined || lastGoodAt === undefined || lastGoodAt === null)
      return fail(`${label}.normalization`, "must fully describe current normalized state");
    normalizationStatus = Object.freeze({
      state: normalizationState,
      exactQueryKey,
      exactDataRevision,
      lastGoodAt
    });
  } else if (normalizationState === "retained-after-drift") {
    if (reason === undefined || exactQueryKey === undefined || exactDataRevision !== undefined || normalizedExactDataRevision !== undefined || failedExactDataRevision === undefined || newerExactDataRevision === undefined || lastGoodExactDataRevision === undefined || lastGoodAt === undefined)
      return fail(`${label}.normalization`, "must fully describe retained drift state");
    if (lastGoodExactDataRevision === null !== (lastGoodAt === null)) {
      return fail(`${label}.normalization`, "must pair last-good revision and observation time");
    }
    if (newerExactDataRevision !== null && newerExactDataRevision === failedExactDataRevision) {
      return fail(`${label}.normalization.newerExactDataRevision`, "must differ from the failed exact revision");
    }
    normalizationStatus = Object.freeze({
      state: normalizationState,
      exactQueryKey,
      reason,
      failedExactDataRevision,
      newerExactDataRevision,
      lastGoodExactDataRevision,
      lastGoodAt
    });
  } else if (normalizationState === "stale") {
    if (reason === undefined || exactQueryKey === undefined || exactDataRevision === undefined || normalizedExactDataRevision === undefined || failedExactDataRevision !== undefined || newerExactDataRevision !== undefined || lastGoodExactDataRevision !== undefined || lastGoodAt === undefined)
      return fail(`${label}.normalization`, "must fully describe stale normalized state");
    if (normalizedExactDataRevision === null !== (lastGoodAt === null)) {
      return fail(`${label}.normalization`, "must pair normalized revision and observation time");
    }
    normalizationStatus = Object.freeze({
      state: normalizationState,
      exactQueryKey,
      exactDataRevision,
      normalizedExactDataRevision,
      lastGoodAt,
      reason
    });
  } else {
    if (reason === undefined || exactQueryKey !== undefined || exactDataRevision !== undefined || normalizedExactDataRevision !== undefined || failedExactDataRevision !== undefined || newerExactDataRevision !== undefined || lastGoodExactDataRevision !== undefined || lastGoodAt === undefined)
      return fail(`${label}.normalization`, "must describe only the normalization error");
    normalizationStatus = Object.freeze({
      state: normalizationState,
      reason,
      lastGoodAt
    });
  }
  if ("exactQueryKey" in normalizationStatus && normalizationStatus.exactQueryKey === exactStatus.key) {
    let normalizationRevision;
    let normalizationRevisionField;
    if (normalizationStatus.state === "current") {
      normalizationRevision = normalizationStatus.exactDataRevision;
      normalizationRevisionField = "exactDataRevision";
    } else if (normalizationStatus.state === "retained-after-drift") {
      normalizationRevision = normalizationStatus.newerExactDataRevision ?? normalizationStatus.failedExactDataRevision;
      normalizationRevisionField = normalizationStatus.newerExactDataRevision === null ? "failedExactDataRevision" : "newerExactDataRevision";
    } else if (normalizationStatus.exactDataRevision !== null) {
      normalizationRevision = normalizationStatus.exactDataRevision;
      normalizationRevisionField = "exactDataRevision";
    } else {
      normalizationRevision = normalizationStatus.normalizedExactDataRevision;
      normalizationRevisionField = "normalizedExactDataRevision";
    }
    if (exactStatus.state === "hit" && exactStatus.dataRevision !== normalizationRevision) {
      return fail(`${label}.normalization.${normalizationRevisionField}`, "does not match the exact hit");
    }
    if (exactStatus.state !== "hit" && normalizationStatus.state === "current") {
      return fail(`${label}.normalization`, "cannot be current without its exact hit");
    }
    if (exactStatus.state !== "hit" && normalizationStatus.state === "retained-after-drift" && normalizationStatus.newerExactDataRevision !== null) {
      return fail(`${label}.normalization.newerExactDataRevision`, "cannot name a newer current revision without an exact hit");
    }
    if (exactStatus.state !== "hit" && normalizationStatus.state === "stale" && normalizationStatus.exactDataRevision !== null) {
      return fail(`${label}.normalization.exactDataRevision`, "cannot name a current revision without an exact hit");
    }
  }
  if (normalizationStatus.state === "current" && normalizationStatus.exactQueryKey !== exactStatus.key) {
    return fail(`${label}.normalization.exactQueryKey`, "must name the root exact query while normalization is current");
  }
  const normalizationDataRevision = source.normalizationDataRevision === null ? null : digest(source.normalizationDataRevision, `${label}.normalizationDataRevision`);
  if ((normalizationStatus.state === "current" || normalizationStatus.state === "stale" || normalizationStatus.state === "retained-after-drift") && normalizationDataRevision === null) {
    return fail(`${label}.normalizationDataRevision`, `is required while normalization is ${normalizationStatus.state}`);
  }
  if (normalizationStatus.state === "unsupported" && normalizationDataRevision !== null) {
    return fail(`${label}.normalizationDataRevision`, "must be null while normalization is unsupported");
  }
  const parsedCoverage = coverage(source.coverage, `${label}.coverage`);
  if (normalizationStatus.state === "current" && parsedCoverage.state === "unavailable") {
    return fail(`${label}.coverage`, "cannot be unavailable for current normalized state");
  }
  if (normalizationStatus.state === "current" && parsedCoverage.state === "observed" && parsedCoverage.continuation === "pending") {
    return fail(`${label}.coverage.continuation`, "cannot be pending for current normalized state");
  }
  if ((normalizationStatus.state === "missing" || normalizationStatus.state === "unsupported" || normalizationStatus.state === "error") && parsedCoverage.state === "observed") {
    return fail(`${label}.coverage`, `cannot be observed while normalization is ${normalizationStatus.state}`);
  }
  return Object.freeze({
    adapterId: text(source.adapterId, `${label}.adapterId`, 64),
    operationId: oneOf(source.operationId, ["messaging.list", "messaging.read"], `${label}.operationId`),
    authId: text(source.authId, `${label}.authId`, 64),
    requestInputHash: digest(source.requestInputHash, `${label}.requestInputHash`),
    projectionInputHash: digest(source.projectionInputHash, `${label}.projectionInputHash`),
    normalizationDataRevision,
    surfaceId: text(source.surfaceId, `${label}.surfaceId`, 64),
    exact: exactStatus,
    normalization: normalizationStatus,
    coverage: parsedCoverage
  });
}
function sourceCoordinateKey(value) {
  return canonicalJson({
    adapterId: value.adapterId,
    operationId: value.operationId,
    authId: value.authId,
    requestInputHash: value.requestInputHash
  });
}
function compareEntities(left, right) {
  const leftTime = left.orderedAt ?? "";
  const rightTime = right.orderedAt ?? "";
  return rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id);
}
function view(value, request) {
  const source = record(value, "Wrench omni view");
  exactKeys(source, ["schemaVersion", "viewRevision", "entities", "nextCursor", "sources"], [], "Wrench omni view");
  if (source.schemaVersion !== 1)
    return fail("Wrench omni view.schemaVersion", "must be 1");
  const entities = Object.freeze(denseArray(source.entities, "Wrench omni view.entities", OMNI_MAX_VIEW_ENTITIES).map(entity));
  if (new Set(entities.map((entry) => entry.id)).size !== entities.length) {
    return fail("Wrench omni view.entities", "must not repeat entity identities");
  }
  for (let index = 1;index < entities.length; index += 1) {
    const prior = entities[index - 1];
    const current = entities[index];
    if (prior !== undefined && current !== undefined && compareEntities(prior, current) > 0) {
      return fail("Wrench omni view.entities", "must use deterministic newest-first order");
    }
  }
  if (entities.length > request.pageLimit) {
    return fail("Wrench omni view.entities", "exceeds the requested page limit");
  }
  for (const entry of entities) {
    if (request.filter.kinds !== null && !request.filter.kinds.includes(entry.kind)) {
      return fail("Wrench omni view.entities", "contains a kind excluded by the request");
    }
    if (request.filter.conversationId !== null && entry.conversationId !== request.filter.conversationId) {
      return fail("Wrench omni view.entities", "contains an entity outside the requested conversation");
    }
    if (request.filter.unread !== null) {
      const unread = entry.kind === "conversation" ? entry.unread ?? (entry.unreadCount === null ? null : entry.unreadCount > 0) : entry.unread;
      if (unread !== request.filter.unread) {
        return fail("Wrench omni view.entities", "contains an entity outside the requested unread state");
      }
    }
  }
  const nextCursor = source.nextCursor === null ? null : localCursor(source.nextCursor, "Wrench omni view.nextCursor");
  if (nextCursor !== null && entities.length !== request.pageLimit) {
    return fail("Wrench omni view.nextCursor", "requires a full requested page");
  }
  const sources = Object.freeze(denseArray(source.sources, "Wrench omni view.sources", OMNI_MAX_SOURCES).map(sourceStatus));
  if (sources.length === 0)
    return fail("Wrench omni view.sources", "must not be empty");
  const sourceKeys = sources.map((entry) => canonicalJson({
    adapterId: entry.adapterId,
    operationId: entry.operationId,
    authId: entry.authId,
    requestInputHash: entry.requestInputHash
  }));
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    return fail("Wrench omni view.sources", "must not repeat source identities");
  }
  const expectedSourceKeys = request.sources.map(sourceCoordinateKey);
  const actualSourceKeys = sources.map(sourceCoordinateKey);
  if (expectedSourceKeys.length !== actualSourceKeys.length || expectedSourceKeys.some((key, index) => key !== actualSourceKeys[index])) {
    return fail("Wrench omni view.sources", "must exactly match the requested source coordinates and order");
  }
  const returnedEntitySources = new Set(sources.map((entry) => canonicalJson({ authId: entry.authId, surfaceId: entry.surfaceId })));
  for (const entry of entities) {
    const sourceKey = canonicalJson({
      authId: entry.source.authId,
      surfaceId: entry.source.surfaceId
    });
    if (!returnedEntitySources.has(sourceKey)) {
      return fail("Wrench omni view.entities", "must belong to one returned requested source");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    viewRevision: digest(source.viewRevision, "Wrench omni view.viewRevision"),
    entities,
    nextCursor,
    sources
  });
}
function identity(value) {
  const source = record(value, "Wrench omni response identity");
  exactKeys(source, ["invocationDigest", "requestDigest", "sourceSetDigest"], [], "Wrench omni response identity");
  return Object.freeze({
    invocationDigest: digest(source.invocationDigest, "Wrench omni response invocation digest"),
    requestDigest: digest(source.requestDigest, "Wrench omni response request digest"),
    sourceSetDigest: digest(source.sourceSetDigest, "Wrench omni response source-set digest")
  });
}
function envelope(value, request) {
  const source = record(value, "Wrench omni response");
  exactKeys(source, ["ok", "schemaVersion", "source", "identity", "view"], [], "Wrench omni response");
  if (source.ok !== true)
    return fail("Wrench omni response.ok", "must be true");
  if (source.schemaVersion !== 1) {
    return fail("Wrench omni response.schemaVersion", "must be 1");
  }
  const parsedIdentity = identity(source.identity);
  if (parsedIdentity.invocationDigest !== request.invocationDigest) {
    return fail("Wrench omni response identity.invocationDigest", "does not match the exact canonical invocation");
  }
  if (parsedIdentity.requestDigest !== request.requestDigest) {
    return fail("Wrench omni response identity.requestDigest", "does not match the cursor-independent canonical request");
  }
  const parsedSource = oneOf(source.source, ["omni-cache", "omni-live", "omni-exact-cache", "omni-identity"], "Wrench omni response.source");
  if (parsedSource === "omni-identity") {
    if (source.view !== null)
      return fail("Wrench omni response.view", "must be null for identity-only output");
    return Object.freeze({
      source: parsedSource,
      identity: parsedIdentity,
      view: null
    });
  }
  if (source.view === null)
    return fail("Wrench omni response.view", "is required");
  return Object.freeze({
    source: parsedSource,
    identity: parsedIdentity,
    view: view(source.view, request)
  });
}
function parseEnvelopeOutput(value, label, request) {
  return envelope(parseJsonOutput(childText(value, label), label), request);
}
function runSynchronousCommand(command, options, label) {
  requireBunRuntime();
  const result = spawnSync(process.execPath, command.arguments, {
    cwd: options.cwd,
    env: options.environment,
    input: command.input,
    encoding: "utf8",
    maxBuffer: OMNI_MAX_RESPONSE_BYTES,
    timeout: SYNCHRONOUS_COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL"
  });
  if (result.error !== undefined)
    throw result.error;
  const code = result.status ?? 3;
  const stderr = childText(result.stderr ?? "", `${label} stderr`);
  if (code !== 0) {
    throw new Error(boundedMessage(stderr) || `${label} exited ${code}`);
  }
  const stdout = childText(result.stdout ?? "", `${label} stdout`);
  if (stdout.trim().length === 0) {
    throw new Error(boundedMessage(stderr) || `${label} returned no output`);
  }
  return parseEnvelopeOutput(stdout, `${label} response`, command.request);
}
function runAsynchronousCommand(command, options, label, timeoutMs) {
  requireBunRuntime();
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command.arguments, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let closed = false;
    let pendingError = null;
    let terminationTimer;
    let forcedTerminationTimer;
    let controlTimer;
    const asError = (errorValue) => errorValue instanceof Error ? errorValue : new Error(String(errorValue));
    const removeAbortListener = () => {
      if (options.signal !== undefined) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };
    const clearTimers = () => {
      if (terminationTimer !== undefined)
        clearTimeout(terminationTimer);
      if (forcedTerminationTimer !== undefined)
        clearTimeout(forcedTerminationTimer);
      if (controlTimer !== undefined)
        clearTimeout(controlTimer);
    };
    const settleFailure = (errorValue) => {
      if (settled)
        return;
      settled = true;
      clearTimers();
      removeAbortListener();
      reject(asError(errorValue));
    };
    const requestTermination = (errorValue) => {
      if (settled || closed)
        return;
      pendingError ??= asError(errorValue);
      if (terminationTimer !== undefined)
        return;
      try {
        child.kill("SIGTERM");
      } catch {}
      if (settled || closed)
        return;
      terminationTimer = setTimeout(() => {
        if (settled || closed)
          return;
        try {
          child.kill("SIGKILL");
        } catch {}
        if (settled || closed)
          return;
        forcedTerminationTimer = setTimeout(() => {
          if (settled || closed)
            return;
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          settleFailure(new Error(`${label} child did not close after SIGKILL`, { cause: pendingError }));
        }, CHILD_FORCEFUL_TERMINATION_MS);
        forcedTerminationTimer.unref();
      }, CHILD_GRACEFUL_TERMINATION_MS);
      terminationTimer.unref();
    };
    function onAbort() {
      if (options.signal !== undefined) {
        requestTermination(abortError(options.signal));
      }
    }
    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs !== undefined) {
      controlTimer = setTimeout(() => {
        requestTermination(new Error(`${label} exceeded its ${timeoutMs}ms deadline`));
      }, timeoutMs);
      controlTimer.unref();
    }
    child.stdin.on("error", (error) => {
      if (pendingError === null)
        requestTermination(error);
    });
    child.stdout.on("error", requestTermination);
    child.stderr.on("error", requestTermination);
    child.stdout.on("data", (chunkValue) => {
      if (pendingError !== null)
        return;
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > OMNI_MAX_RESPONSE_BYTES) {
        requestTermination(new Error(`${label} response exceeds its byte bound`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunkValue) => {
      if (pendingError !== null)
        return;
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      const remainingBytes = Math.max(0, OMNI_MAX_REASON_BYTES - stderrBytes);
      stderrBytes += chunk.byteLength;
      if (remainingBytes > 0)
        stderr.push(chunk.subarray(0, remainingBytes));
    });
    child.on("error", (error) => {
      if (child.pid === undefined) {
        settleFailure(error);
        return;
      }
      requestTermination(error);
    });
    child.on("close", (code, signal) => {
      if (settled)
        return;
      closed = true;
      clearTimers();
      removeAbortListener();
      if (pendingError !== null) {
        settleFailure(pendingError);
        return;
      }
      const error = boundedMessage(Buffer.concat(stderr).toString("utf8"));
      if (code !== 0) {
        settleFailure(new Error(error || `${label} exited ${code ?? signal ?? "unknown"}`));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      if (output.trim().length === 0) {
        settleFailure(new Error(error || `${label} returned no output`));
        return;
      }
      let parsed;
      try {
        parsed = parseEnvelopeOutput(output, `${label} response`, command.request);
      } catch (parseError) {
        settleFailure(parseError);
        return;
      }
      settled = true;
      resolve(parsed);
    });
    child.stdin.end(command.input);
  });
}
function runLiveCommand(command, options) {
  return runAsynchronousCommand(command, options, "Wrench omni live read");
}
function runAsynchronousControlCommand(command, options, label) {
  return runAsynchronousCommand(command, options, label, ASYNC_CONTROL_COMMAND_TIMEOUT_MS);
}
function requireEnvelopeSource(value, expected, label) {
  if (value.source !== expected)
    return fail(label, `must have source ${expected}`);
  return value;
}
function cacheResult(value) {
  const parsed = requireEnvelopeSource(value, "omni-cache", "Wrench omni cache response");
  return Object.freeze({
    schemaVersion: 1,
    source: parsed.source,
    identity: parsed.identity,
    view: parsed.view
  });
}
function liveResult(value) {
  const parsed = requireEnvelopeSource(value, "omni-live", "Wrench omni live response");
  return Object.freeze({
    schemaVersion: 1,
    source: parsed.source,
    identity: parsed.identity,
    view: parsed.view
  });
}
async function observeIdentity(request, options) {
  throwIfAborted(options.signal);
  return requireEnvelopeSource(await runAsynchronousControlCommand(preparedCommand(request, "identity", options), options, "Wrench omni identity preflight"), "omni-identity", "Wrench omni identity response").identity;
}
function readCachedPrepared(request, options) {
  return cacheResult(runSynchronousCommand(preparedCommand(request, "cache", options), options, "Wrench omni cache read"));
}
async function readCachedPreparedAsynchronously(request, options) {
  return cacheResult(await runAsynchronousControlCommand(preparedCommand(request, "cache", options), options, "Wrench omni cache read"));
}
function identitiesMatch(left, right) {
  return left.invocationDigest === right.invocationDigest && left.requestDigest === right.requestDigest && left.sourceSetDigest === right.sourceSetDigest;
}
function assertIdentity(expected, actual, phase) {
  if (!identitiesMatch(expected, actual)) {
    throw new Error(`Wrench omni identity changed ${phase}; the live result was discarded`);
  }
}
function viewsHaveSameEntities(left, right) {
  return left.entities.length === right.entities.length && left.entities.every((entity2, index) => {
    const other = right.entities[index];
    return other !== undefined && entity2.id === other.id && entity2.revision === other.revision;
  });
}
function positiveSourceHeads(source) {
  const rootExact = source.exact.state === "hit" ? canonicalJson(Object.freeze({
    key: source.exact.key,
    dataRevision: source.exact.dataRevision,
    validatedAt: source.exact.validatedAt
  })) : null;
  const continuationExact = source.normalization.state === "stale" && source.normalization.exactQueryKey !== source.exact.key && source.normalization.exactDataRevision !== null ? canonicalJson(Object.freeze({
    key: source.normalization.exactQueryKey,
    dataRevision: source.normalization.exactDataRevision
  })) : source.normalization.state === "retained-after-drift" && source.normalization.exactQueryKey !== source.exact.key && source.normalization.newerExactDataRevision !== null ? canonicalJson(Object.freeze({
    key: source.normalization.exactQueryKey,
    dataRevision: source.normalization.newerExactDataRevision
  })) : null;
  return Object.freeze({
    rootExact,
    normalization: source.normalizationDataRevision,
    continuationExact
  });
}
function hasPositiveAdvance(after, before, duringLive) {
  return Object.keys(after).some((key) => {
    const candidate = after[key];
    return candidate !== null && candidate !== duringLive[key] && (before === null || candidate !== before[key]);
  });
}
function laterSourceCoordinates(cachedBefore, cachedAfter, live) {
  const beforeEvidence = new Map((cachedBefore?.view.sources ?? []).map((source) => [
    sourceCoordinateKey(source),
    positiveSourceHeads(source)
  ]));
  const liveEvidence = new Map(live.view.sources.map((source) => [
    sourceCoordinateKey(source),
    positiveSourceHeads(source)
  ]));
  const result = new Set;
  for (const source of cachedAfter.view.sources) {
    const coordinate = sourceCoordinateKey(source);
    const after = positiveSourceHeads(source);
    const before = beforeEvidence.get(coordinate) ?? null;
    const duringLive = liveEvidence.get(coordinate);
    if (duringLive !== undefined && hasPositiveAdvance(after, before, duringLive))
      result.add(coordinate);
  }
  return result;
}
function viewHasLaterRevision(cachedBefore, cachedAfter, live) {
  return cachedAfter.view.viewRevision !== live.view.viewRevision && (cachedBefore === null || cachedAfter.view.viewRevision !== cachedBefore.view.viewRevision);
}
function sourceHasUnresolvedLiveIssue(source) {
  return source.exact.state === "error" || source.normalization.state !== "current";
}
function selectCurrent(cachedBefore, cachedAfter, live) {
  if (cachedAfter === null)
    return live;
  const laterSources = laterSourceCoordinates(cachedBefore, cachedAfter, live);
  let useCachedView = false;
  if (viewHasLaterRevision(cachedBefore, cachedAfter, live) || laterSources.size > 0) {
    useCachedView = true;
  } else if (viewsHaveSameEntities(cachedAfter.view, live.view)) {
    return live;
  } else if (cachedBefore !== null && viewsHaveSameEntities(cachedAfter.view, cachedBefore.view)) {
    return live;
  } else {
    useCachedView = true;
  }
  if (!useCachedView)
    return live;
  const liveSources = new Map(live.view.sources.map((source) => [
    sourceCoordinateKey(source),
    source
  ]));
  let merged = false;
  const sources = Object.freeze(cachedAfter.view.sources.map((cachedSource) => {
    const coordinate = sourceCoordinateKey(cachedSource);
    const liveSource = liveSources.get(coordinate);
    if (liveSource !== undefined && sourceHasUnresolvedLiveIssue(liveSource)) {
      merged = true;
      return liveSource;
    }
    if (laterSources.has(coordinate) || liveSource === undefined || canonicalJson(liveSource) === canonicalJson(cachedSource))
      return cachedSource;
    merged = true;
    return liveSource;
  }));
  if (!merged)
    return cachedAfter;
  const result = Object.freeze({
    schemaVersion: 1,
    source: "omni-merged",
    identity: cachedAfter.identity,
    view: Object.freeze({
      ...cachedAfter.view,
      sources
    })
  });
  return result;
}
function scheduleRevalidation(request, options, cachedBeforeSource) {
  return Promise.resolve().then(async () => {
    throwIfAborted(options.signal);
    const identityBefore = await observeIdentity(request, options);
    let cachedBefore = cachedBeforeSource.status === "provided" ? cachedBeforeSource.value : null;
    if (cachedBeforeSource.status === "lookup") {
      try {
        cachedBefore = await readCachedPreparedAsynchronously(request, options);
      } catch {
        cachedBefore = null;
      }
    }
    if (cachedBefore !== null) {
      assertIdentity(identityBefore, cachedBefore.identity, "before revalidation started");
    }
    throwIfAborted(options.signal);
    const live = liveResult(await runLiveCommand(preparedCommand(request, "live", options), options));
    throwIfAborted(options.signal);
    const identityAfter = await observeIdentity(request, options);
    assertIdentity(identityBefore, live.identity, "while revalidation was running");
    assertIdentity(identityBefore, identityAfter, "while revalidation was running");
    let cachedAfter = null;
    try {
      cachedAfter = await readCachedPreparedAsynchronously(request, options);
    } catch {
      cachedAfter = null;
    }
    if (cachedAfter !== null) {
      assertIdentity(identityBefore, cachedAfter.identity, "before the final cache observation");
    }
    throwIfAborted(options.signal);
    return Object.freeze({
      cachedBefore,
      cachedAfter,
      live,
      current: selectCurrent(cachedBefore, cachedAfter, live)
    });
  });
}
function readCachedOmniView(request, options = {}) {
  const preparedOptions = snapshotOptions(options, false);
  const preparedRequest = prepareRequest(request);
  return readCachedPrepared(preparedRequest, preparedOptions);
}
function revalidateOmniView(request, options = {}) {
  const preparedOptions = snapshotOptions(options, true);
  const preparedRequest = prepareRequest(request);
  return scheduleRevalidation(preparedRequest, preparedOptions, { status: "lookup" });
}
function staleWhileRevalidateOmniView(request, options = {}) {
  const preparedOptions = snapshotOptions(options, true);
  const preparedRequest = prepareRequest(request);
  let cached = null;
  try {
    cached = readCachedPrepared(preparedRequest, preparedOptions);
  } catch {
    cached = null;
  }
  return Object.freeze({
    cached,
    revalidation: scheduleRevalidation(preparedRequest, preparedOptions, { status: "provided", value: cached })
  });
}
export {
  staleWhileRevalidateOmniView,
  revalidateOmniView,
  readCachedOmniView
};
