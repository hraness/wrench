// @bun
import {
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR,
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH,
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
  WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR,
  WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH,
  WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
  WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR,
  WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH,
  WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID,
  parseWrenchMessagingContextBindingV1,
  parseWrenchMessagingContextBindingV2
} from "./index-pa6wdsqj.js";
import {
  canonicalJson,
  sha256
} from "./index-dqv16dt0.js";

// src/messaging.ts
import { spawn } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

// src/messaging-types.ts
import { types as nodeTypes } from "util";
var MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID = WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID;
var MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR = WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR;
var MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH = WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH;
var MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID = WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID;
var MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR = WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR;
var MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH = WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH;
var MESSAGING_CONTEXT_BINDING_CONTRACT_ID = MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID;
var MESSAGING_CONTEXT_BINDING_CONTRACT_DESCRIPTOR = MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR;
var MESSAGING_CONTEXT_BINDING_CONTRACT_HASH = MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH;
var MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID = WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID;
var MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR = WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR;
var MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH = WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH;
var MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID = WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID;
var MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR = WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR;
var MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH = WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH;
var MESSAGING_RECEIPT_BINDING_CONTRACT_ID = MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID;
var MESSAGING_RECEIPT_BINDING_CONTRACT_DESCRIPTOR = MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR;
var MESSAGING_RECEIPT_BINDING_CONTRACT_HASH = MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH;
function fail(label, detail) {
  throw new Error(`${label} ${detail}`);
}
function record(value, label) {
  if (nodeTypes.isProxy(value) || typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail(label, "must be a plain non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    return fail(label, "must not contain symbol properties");
  }
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}.${key}`, "must be an enumerable data property");
    }
    result[key] = descriptor.value;
  }
  return result;
}
function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key)))
    return fail(label, "has unsupported or missing fields");
}
function denseArray(value, label, maximum) {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum)
    return fail(label, `must be a dense array of at most ${maximum} items`);
  for (let index = 0;index < value.length; index += 1) {
    if (!Object.hasOwn(value, index))
      return fail(label, "must not be sparse");
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(label, "must contain only enumerable data items");
    }
  }
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index))
  ]);
  if (Reflect.ownKeys(value).some((key) => !expected.has(key))) {
    return fail(label, "must not contain named or symbol properties");
  }
  return value;
}
function hasUnpairedSurrogate(value) {
  for (let index = 0;index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next < 56320 || next > 57343)
        return true;
      index += 1;
    } else if (code >= 56320 && code <= 57343)
      return true;
  }
  return false;
}
function text(value, label, maximumBytes, options = {}) {
  if (typeof value !== "string" || !options.allowEmpty && value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes || hasUnpairedSurrogate(value) || /[\0\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value) || !options.allowNewlines && /[\r\n]/u.test(value))
    return fail(label, "must be bounded well-formed inert text");
  return value;
}
function id(value, label, maximum = 256) {
  const result = text(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(result)) {
    return fail(label, "must be an exact opaque identifier");
  }
  return result;
}
function routeRef(value, label) {
  const result = id(value, label, 128);
  if (!/^wmroute_[A-Za-z0-9_-]{22}$/u.test(result)) {
    return fail(label, "must be a Wrench messaging route reference");
  }
  return result;
}
function contextRef(value, label) {
  const result = id(value, label, 128);
  if (!/^wmcontext_[A-Za-z0-9_-]{22}$/u.test(result)) {
    return fail(label, "must be a Wrench messaging context reference");
  }
  return result;
}
function replyRef(value, label) {
  const result = id(value, label, 128);
  if (!/^wmreply_[A-Za-z0-9_-]{22}$/u.test(result)) {
    return fail(label, "must be a Wrench messaging reply reference");
  }
  return result;
}
function integer(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    return fail(label, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}
function cloneJsonRecord(value, label) {
  let nodes = 0;
  const ancestors = new WeakSet;
  const visit = (candidate, path, depth) => {
    nodes += 1;
    if (nodes > 1e4 || depth > 32)
      return fail(label, "exceeds its structural bound");
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      if (typeof candidate === "string")
        text(candidate, path, 256 * 1024, { allowEmpty: true, allowNewlines: true });
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        return fail(path, "must contain finite JSON numbers");
      return candidate;
    }
    if (typeof candidate !== "object")
      return fail(path, "must contain only JSON data");
    if (ancestors.has(candidate))
      return fail(label, "must not contain cycles");
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return Object.freeze(denseArray(candidate, path, 1000).map((item, index) => visit(item, `${path}[${index}]`, depth + 1)));
      }
      const source = record(candidate, path);
      const entries = Object.entries(source).map(([key, item]) => {
        text(key, `${path} key`, 256);
        return [key, visit(item, `${path}.${key}`, depth + 1)];
      });
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      ancestors.delete(candidate);
    }
  };
  return record(visit(value, label, 0), label);
}
function parseRoutesSource(value, label) {
  const item = record(value, label);
  exactKeys(item, ["adapterId", "authId", "listInput"], [], label);
  const exactSource = Object.freeze({
    adapterId: id(item.adapterId, `${label}.adapterId`, 64),
    authId: id(item.authId, `${label}.authId`, 48),
    listInput: cloneJsonRecord(item.listInput, `${label}.listInput`)
  });
  return exactSource;
}
function parseMessagingRoutesRequestV1(value) {
  const source = record(value, "messaging routes request");
  exactKeys(source, ["schemaVersion", "format", "source"], [], "messaging routes request");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-routes-request") {
    return fail("messaging routes request", "has an unsupported contract");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-routes-request",
    source: parseRoutesSource(source.source, "messaging routes request.source")
  });
}
function parseMessagingRouteResolveRequestV1(value) {
  const source = record(value, "messaging route resolve request");
  exactKeys(source, ["schemaVersion", "format", "source", "candidate"], [], "messaging route resolve request");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-route-resolve-request")
    return fail("messaging route resolve request", "has an unsupported contract");
  const candidate = record(source.candidate, "messaging route resolve request.candidate");
  exactKeys(candidate, ["coordinate"], [], "messaging route resolve request.candidate");
  const coordinateSource = record(candidate.coordinate, "messaging route resolve request.candidate.coordinate");
  let coordinate;
  if (coordinateSource.kind === "beeperConversation") {
    exactKeys(coordinateSource, ["kind", "network", "conversationId"], [], "messaging route resolve request.candidate.coordinate");
    coordinate = Object.freeze({
      kind: "beeperConversation",
      network: id(coordinateSource.network, "messaging route resolve request.candidate.coordinate.network", 64),
      conversationId: text(coordinateSource.conversationId, "messaging route resolve request.candidate.coordinate.conversationId", 2048)
    });
  } else if (coordinateSource.kind === "imessageChat") {
    exactKeys(coordinateSource, ["kind", "chatGuid", "service", "observedChatRowId"], [], "messaging route resolve request.candidate.coordinate");
    coordinate = Object.freeze({
      kind: "imessageChat",
      chatGuid: text(coordinateSource.chatGuid, "messaging route resolve request.candidate.coordinate.chatGuid", 2048),
      service: coordinateSource.service === null ? null : id(coordinateSource.service, "messaging route resolve request.candidate.coordinate.service", 64),
      observedChatRowId: coordinateSource.observedChatRowId === null ? null : integer(coordinateSource.observedChatRowId, "messaging route resolve request.candidate.coordinate.observedChatRowId", 1, Number.MAX_SAFE_INTEGER)
    });
  } else if (coordinateSource.kind === "whatsappJid") {
    exactKeys(coordinateSource, ["kind", "jid"], [], "messaging route resolve request.candidate.coordinate");
    coordinate = Object.freeze({
      kind: "whatsappJid",
      jid: text(coordinateSource.jid, "messaging route resolve request.candidate.coordinate.jid", 512)
    });
  } else {
    return fail("messaging route resolve request.candidate.coordinate.kind", "is unsupported");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-route-resolve-request",
    source: parseRoutesSource(source.source, "messaging route resolve request.source"),
    candidate: Object.freeze({ coordinate })
  });
}
function parseMessagingContextRequestV1(value) {
  const source = record(value, "messaging context request");
  exactKeys(source, ["schemaVersion", "format", "routeRef", "limit"], [], "messaging context request");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-context-request") {
    return fail("messaging context request", "has an unsupported contract");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context-request",
    routeRef: routeRef(source.routeRef, "messaging context request.routeRef"),
    limit: integer(source.limit, "messaging context request.limit", 1, 200)
  });
}
function parseMessagingTurnV1(value) {
  const source = record(value, "messaging turn");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "clientIntentSha256",
    "routeRef",
    "contextRef",
    "parts"
  ], [], "messaging turn");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-turn") {
    return fail("messaging turn", "has an unsupported contract");
  }
  const seen = new Set;
  const parts = denseArray(source.parts, "messaging turn.parts", 8).map((candidate, index) => {
    const item = record(candidate, `messaging turn.parts[${index}]`);
    exactKeys(item, ["partId", "text", "replyRef"], [], `messaging turn.parts[${index}]`);
    const partId = id(item.partId, `messaging turn.parts[${index}].partId`, 64);
    if (seen.has(partId))
      return fail("messaging turn.parts", "must not repeat part IDs");
    seen.add(partId);
    return Object.freeze({
      partId,
      text: text(item.text, `messaging turn.parts[${index}].text`, 65536, { allowNewlines: true }),
      replyRef: item.replyRef === null ? null : replyRef(item.replyRef, `messaging turn.parts[${index}].replyRef`)
    });
  });
  if (parts.length === 0)
    return fail("messaging turn.parts", "must not be empty");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-turn",
    clientIntentSha256: sha256Digest(source.clientIntentSha256, "messaging turn.clientIntentSha256"),
    routeRef: routeRef(source.routeRef, "messaging turn.routeRef"),
    contextRef: contextRef(source.contextRef, "messaging turn.contextRef"),
    parts: Object.freeze(parts)
  });
}
function messagingTurnDigest(turn) {
  const parsed = parseMessagingTurnV1(turn);
  return sha256(canonicalJson({
    schemaVersion: 1,
    format: "wrench.messaging-turn",
    clientIntentSha256: parsed.clientIntentSha256,
    routeRef: parsed.routeRef,
    contextRef: parsed.contextRef,
    parts: parsed.parts.map((part) => ({
      partId: part.partId,
      text: part.text,
      replyRef: part.replyRef
    }))
  }));
}
function parseMessagingContextBindingV1(value) {
  const parsed = parseWrenchMessagingContextBindingV1(value);
  routeRef(parsed.routeRef, "messaging context binding.routeRef");
  contextRef(parsed.contextRef, "messaging context binding.contextRef");
  return parsed;
}
function parseMessagingContextBindingV2(value) {
  const parsed = parseWrenchMessagingContextBindingV2(value);
  routeRef(parsed.routeRef, "messaging context binding.routeRef");
  contextRef(parsed.contextRef, "messaging context binding.contextRef");
  return parsed;
}
function parseMessagingContextBinding(value) {
  const source = record(value, "messaging context binding");
  return source.contractId === MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID ? parseMessagingContextBindingV1(source) : parseMessagingContextBindingV2(source);
}
function sha256Digest(candidate, label) {
  const result = text(candidate, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(result))
    return fail(label, "must be a SHA-256 digest");
  return result;
}
function utcTimestamp(candidate, label) {
  const result = text(candidate, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result) || !Number.isFinite(Date.parse(result)))
    return fail(label, "must be an RFC3339 UTC timestamp");
  return result;
}
function nullableBoundedText(candidate, label, maximumBytes, allowNewlines = false) {
  return candidate === null ? null : text(candidate, label, maximumBytes, {
    allowEmpty: true,
    allowNewlines
  });
}
function bool(candidate, label) {
  if (typeof candidate !== "boolean")
    return fail(label, "must be boolean");
  return candidate;
}
function completeness(value, label) {
  const source = record(value, label);
  exactKeys(source, ["kind", "reason"], [], label);
  const kinds = new Set([
    "complete",
    "page",
    "unknown",
    "first-page-only",
    "bounded-local",
    "search-window",
    "truncated"
  ]);
  if (!kinds.has(source.kind)) {
    return fail(`${label}.kind`, "is unsupported");
  }
  return Object.freeze({
    kind: source.kind,
    reason: nullableBoundedText(source.reason, `${label}.reason`, 2048)
  });
}
function conversation(value, label) {
  const source = record(value, label);
  exactKeys(source, ["kind", "title", "participantCount"], [], label);
  if (source.kind !== "single" && source.kind !== "group" && source.kind !== "unknown")
    return fail(`${label}.kind`, "is unsupported");
  return Object.freeze({
    kind: source.kind,
    title: nullableBoundedText(source.title, `${label}.title`, 4096, true),
    participantCount: integer(source.participantCount, `${label}.participantCount`, 0, 1e4)
  });
}
function parseMessagingRouteV1(value) {
  const source = record(value, "messaging route");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "routeRef",
    "network",
    "conversation",
    "readiness",
    "completeness",
    "expiresAt"
  ], [], "messaging route");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-route") {
    return fail("messaging route", "has an unsupported contract");
  }
  const readiness = record(source.readiness, "messaging route.readiness");
  exactKeys(readiness, ["context", "turn", "reply", "reason"], [], "messaging route.readiness");
  if (readiness.context !== "ready" && readiness.context !== "historical-readable" && readiness.context !== "resolution-required" && readiness.context !== "unavailable")
    return fail("messaging route.readiness.context", "is unsupported");
  if (readiness.turn !== "ready" && readiness.turn !== "unavailable") {
    return fail("messaging route.readiness.turn", "is unsupported");
  }
  if (readiness.reply !== "supported" && readiness.reply !== "unsupported") {
    return fail("messaging route.readiness.reply", "is unsupported");
  }
  if (readiness.context !== "ready" && (readiness.turn !== "unavailable" || readiness.reply !== "unsupported"))
    return fail("messaging route.readiness", "must block actions when freshness is unproven");
  if (readiness.context !== "ready" && readiness.reason === null) {
    return fail("messaging route.readiness.reason", "is required when context is not actionable");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-route",
    routeRef: routeRef(source.routeRef, "messaging route.routeRef"),
    network: id(source.network, "messaging route.network", 64),
    conversation: conversation(source.conversation, "messaging route.conversation"),
    readiness: Object.freeze({
      context: readiness.context,
      turn: readiness.turn,
      reply: readiness.reply,
      reason: nullableBoundedText(readiness.reason, "messaging route.readiness.reason", 1000)
    }),
    completeness: completeness(source.completeness, "messaging route.completeness"),
    expiresAt: utcTimestamp(source.expiresAt, "messaging route.expiresAt")
  });
}
function parseMessagingRoutesV1(value) {
  const source = record(value, "messaging routes");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "generatedAt",
    "completeness",
    "continuation",
    "routes"
  ], [], "messaging routes");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-routes") {
    return fail("messaging routes", "has an unsupported contract");
  }
  const continuation = record(source.continuation, "messaging routes.continuation");
  exactKeys(continuation, ["direction", "request", "nextInput"], [], "messaging routes.continuation");
  if (continuation.direction !== "forward" && continuation.direction !== "backward" && continuation.direction !== "none")
    return fail("messaging routes.continuation.direction", "is unsupported");
  const request = nullableBoundedText(continuation.request, "messaging routes.continuation.request", 8192);
  const nextInput = continuation.nextInput === null ? null : cloneJsonRecord(continuation.nextInput, "messaging routes.continuation.nextInput");
  if (continuation.direction === "none" && (request !== null || nextInput !== null))
    return fail("messaging routes.continuation", "must be empty when direction is none");
  const routes = denseArray(source.routes, "messaging routes.routes", 1000).map(parseMessagingRouteV1);
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-routes",
    generatedAt: utcTimestamp(source.generatedAt, "messaging routes.generatedAt"),
    completeness: completeness(source.completeness, "messaging routes.completeness"),
    continuation: Object.freeze({
      direction: continuation.direction,
      request,
      nextInput
    }),
    routes: Object.freeze(routes)
  });
}
function parseMessagingContextV1(value) {
  const source = record(value, "messaging context");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "binding",
    "network",
    "liveness",
    "truncated",
    "completeness",
    "messages",
    "warnings"
  ], [], "messaging context");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-context") {
    return fail("messaging context", "has an unsupported contract");
  }
  if (source.liveness !== "fresh-as-of-live-preflight" && source.liveness !== "freshness-unproven")
    return fail("messaging context.liveness", "is unsupported");
  const messages = denseArray(source.messages, "messaging context.messages", 200).map((value_, index) => {
    const label = `messaging context.messages[${index}]`;
    const message = record(value_, label);
    exactKeys(message, [
      "messageRef",
      "direction",
      "time",
      "author",
      "body",
      "bodyTruncated",
      "edited",
      "retracted",
      "reply",
      "attachments",
      "untrustedData"
    ], [], label);
    if (message.direction !== "incoming" && message.direction !== "outgoing" && message.direction !== "unknown")
      return fail(`${label}.direction`, "is unsupported");
    if (message.edited !== "unknown" && message.edited !== "observed" && message.edited !== "not-observed")
      return fail(`${label}.edited`, "is unsupported");
    if (message.retracted !== "unknown" && message.retracted !== "observed" && message.retracted !== "not-observed")
      return fail(`${label}.retracted`, "is unsupported");
    if (message.untrustedData !== true) {
      return fail(`${label}.untrustedData`, "must be true");
    }
    const authorSource = message.author === null ? null : record(message.author, `${label}.author`);
    if (authorSource !== null) {
      exactKeys(authorSource, ["displayName", "handle"], [], `${label}.author`);
    }
    const reply = record(message.reply, `${label}.reply`);
    exactKeys(reply, ["toMessageRef"], [], `${label}.reply`);
    const attachments = denseArray(message.attachments, `${label}.attachments`, 64).map((value__, attachmentIndex) => {
      const attachmentLabel = `${label}.attachments[${attachmentIndex}]`;
      const attachment = record(value__, attachmentLabel);
      exactKeys(attachment, ["kind", "mimeType", "name", "sizeBytes"], [], attachmentLabel);
      const kinds = new Set([
        "audio",
        "document",
        "image",
        "link",
        "sticker",
        "video",
        "unknown"
      ]);
      if (!kinds.has(attachment.kind)) {
        return fail(`${attachmentLabel}.kind`, "is unsupported");
      }
      return Object.freeze({
        kind: attachment.kind,
        mimeType: nullableBoundedText(attachment.mimeType, `${attachmentLabel}.mimeType`, 256),
        name: nullableBoundedText(attachment.name, `${attachmentLabel}.name`, 1024, true),
        sizeBytes: attachment.sizeBytes === null ? null : integer(attachment.sizeBytes, `${attachmentLabel}.sizeBytes`, 0, Number.MAX_SAFE_INTEGER)
      });
    });
    return Object.freeze({
      messageRef: replyRef(message.messageRef, `${label}.messageRef`),
      direction: message.direction,
      time: message.time === null ? null : utcTimestamp(message.time, `${label}.time`),
      author: authorSource === null ? null : Object.freeze({
        displayName: nullableBoundedText(authorSource.displayName, `${label}.author.displayName`, 2048, true),
        handle: nullableBoundedText(authorSource.handle, `${label}.author.handle`, 512)
      }),
      body: nullableBoundedText(message.body, `${label}.body`, 256 * 1024, true),
      bodyTruncated: bool(message.bodyTruncated, `${label}.bodyTruncated`),
      edited: message.edited,
      retracted: message.retracted,
      reply: Object.freeze({
        toMessageRef: reply.toMessageRef === null ? null : replyRef(reply.toMessageRef, `${label}.reply.toMessageRef`)
      }),
      attachments: Object.freeze(attachments),
      untrustedData: true
    });
  });
  const warnings = denseArray(source.warnings, "messaging context.warnings", 32).map((value_, index) => text(value_, `messaging context.warnings[${index}]`, 512));
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context",
    binding: source.binding === null ? null : parseMessagingContextBinding(source.binding),
    network: id(source.network, "messaging context.network", 64),
    liveness: source.liveness,
    truncated: bool(source.truncated, "messaging context.truncated"),
    completeness: completeness(source.completeness, "messaging context.completeness"),
    messages: Object.freeze(messages),
    warnings: Object.freeze(warnings)
  });
}
function parseMessagingPreviewV1(value) {
  const source = record(value, "messaging preview");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "status",
    "planDigest",
    "expiresAt",
    "routeRef",
    "contextRef",
    "clientIntentSha256",
    "turnDigest",
    "recipient",
    "partCount",
    "bubbles",
    "risk",
    "sideEffect"
  ], [], "messaging preview");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-preview" || source.status !== "confirmation-required" || source.risk !== "R3")
    return fail("messaging preview", "has an unsupported contract");
  const recipient = record(source.recipient, "messaging preview.recipient");
  exactKeys(recipient, ["network", "conversation"], [], "messaging preview.recipient");
  const bubbles = denseArray(source.bubbles, "messaging preview.bubbles", 8).map((value_, index) => {
    const label = `messaging preview.bubbles[${index}]`;
    const bubble = record(value_, label);
    exactKeys(bubble, ["partId", "text", "replyRef"], [], label);
    return Object.freeze({
      partId: id(bubble.partId, `${label}.partId`, 64),
      text: text(bubble.text, `${label}.text`, 65536, { allowNewlines: true }),
      replyRef: bubble.replyRef === null ? null : replyRef(bubble.replyRef, `${label}.replyRef`)
    });
  });
  const partCount = integer(source.partCount, "messaging preview.partCount", 1, 8);
  if (bubbles.length !== partCount) {
    return fail("messaging preview.bubbles", "must match partCount");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-preview",
    status: "confirmation-required",
    planDigest: sha256Digest(source.planDigest, "messaging preview.planDigest"),
    expiresAt: utcTimestamp(source.expiresAt, "messaging preview.expiresAt"),
    routeRef: routeRef(source.routeRef, "messaging preview.routeRef"),
    contextRef: contextRef(source.contextRef, "messaging preview.contextRef"),
    clientIntentSha256: sha256Digest(source.clientIntentSha256, "messaging preview.clientIntentSha256"),
    turnDigest: sha256Digest(source.turnDigest, "messaging preview.turnDigest"),
    recipient: Object.freeze({
      network: id(recipient.network, "messaging preview.recipient.network", 64),
      conversation: conversation(recipient.conversation, "messaging preview.recipient.conversation")
    }),
    partCount,
    bubbles: Object.freeze(bubbles),
    risk: "R3",
    sideEffect: text(source.sideEffect, "messaging preview.sideEffect", 1024)
  });
}
function parseMessagingPrivateOutputReceiptV1(value) {
  const source = record(value, "messaging private output receipt");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "artifactFormat",
    "artifactSha256",
    "itemCount",
    "generatedAt",
    "expiresAt"
  ], [], "messaging private output receipt");
  const formats = new Set([
    "wrench.messaging-route",
    "wrench.messaging-routes",
    "wrench.messaging-context",
    "wrench.messaging-preview",
    "wrench.messaging-run",
    "wrench.messaging-receipt-binding"
  ]);
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-private-output-receipt" || !formats.has(source.artifactFormat))
    return fail("messaging private output receipt", "has an unsupported contract");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-private-output-receipt",
    artifactFormat: source.artifactFormat,
    artifactSha256: sha256Digest(source.artifactSha256, "messaging private output receipt.artifactSha256"),
    itemCount: integer(source.itemCount, "messaging private output receipt.itemCount", 0, 1000),
    generatedAt: utcTimestamp(source.generatedAt, "messaging private output receipt.generatedAt"),
    expiresAt: source.expiresAt === null ? null : utcTimestamp(source.expiresAt, "messaging private output receipt.expiresAt")
  });
}
function parseMessagingReceiptBindingV1(value) {
  const source = record(value, "messaging receipt binding V1");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "contractId",
    "contractHash",
    "clientIntentSha256",
    "routeRefSha256",
    "contextRefSha256",
    "turnDigest",
    "previewDigest",
    "runId",
    "state",
    "partCount",
    "provenPartCount",
    "receiptSha256",
    "recordedAt"
  ], [], "messaging receipt binding V1");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-receipt-binding" || source.contractId !== MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID || source.contractHash !== MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH || source.state !== "submitted" && source.state !== "failed" && source.state !== "partial" && source.state !== "indeterminate")
    return fail("messaging receipt binding V1", "has an unsupported contract");
  const partCount = integer(source.partCount, "messaging receipt binding V1.partCount", 1, 8);
  const provenPartCount = integer(source.provenPartCount, "messaging receipt binding V1.provenPartCount", 0, partCount);
  const validPrefix = source.state === "submitted" ? provenPartCount === partCount : source.state === "failed" ? provenPartCount === 0 : source.state === "partial" ? provenPartCount >= 1 && provenPartCount < partCount : provenPartCount < partCount;
  if (!validPrefix) {
    return fail("messaging receipt binding V1", "violates the proven-prefix state law");
  }
  const normalizedWithoutReceipt = Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-receipt-binding",
    contractId: MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
    contractHash: MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
    clientIntentSha256: sha256Digest(source.clientIntentSha256, "messaging receipt binding V1.clientIntentSha256"),
    routeRefSha256: sha256Digest(source.routeRefSha256, "messaging receipt binding V1.routeRefSha256"),
    contextRefSha256: sha256Digest(source.contextRefSha256, "messaging receipt binding V1.contextRefSha256"),
    turnDigest: sha256Digest(source.turnDigest, "messaging receipt binding V1.turnDigest"),
    previewDigest: sha256Digest(source.previewDigest, "messaging receipt binding V1.previewDigest"),
    runId: id(source.runId, "messaging receipt binding V1.runId", 256),
    state: source.state,
    partCount,
    provenPartCount,
    recordedAt: utcTimestamp(source.recordedAt, "messaging receipt binding V1.recordedAt")
  });
  const receiptSha256 = sha256Digest(source.receiptSha256, "messaging receipt binding V1.receiptSha256");
  if (sha256(canonicalJson(normalizedWithoutReceipt)) !== receiptSha256) {
    return fail("messaging receipt binding V1.receiptSha256", "does not bind the canonical receipt");
  }
  return Object.freeze({ ...normalizedWithoutReceipt, receiptSha256 });
}
function parseMessagingReceiptBindingV2(value) {
  const source = record(value, "messaging receipt binding");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "contractId",
    "contractHash",
    "clientIntentSha256",
    "contextBindingSha256",
    "sourceConversationCoordinateSha256",
    "routeRefSha256",
    "contextRefSha256",
    "turnDigest",
    "previewDigest",
    "runId",
    "state",
    "partCount",
    "provenPartCount",
    "receiptSha256",
    "recordedAt"
  ], [], "messaging receipt binding");
  if (source.schemaVersion !== 2 || source.format !== "wrench.messaging-receipt-binding" || source.contractId !== MESSAGING_RECEIPT_BINDING_CONTRACT_ID || source.contractHash !== MESSAGING_RECEIPT_BINDING_CONTRACT_HASH || source.state !== "submitted" && source.state !== "failed" && source.state !== "partial" && source.state !== "indeterminate")
    return fail("messaging receipt binding", "has an unsupported contract");
  const partCount = integer(source.partCount, "messaging receipt binding.partCount", 1, 8);
  const provenPartCount = integer(source.provenPartCount, "messaging receipt binding.provenPartCount", 0, partCount);
  const validPrefix = source.state === "submitted" ? provenPartCount === partCount : source.state === "failed" ? provenPartCount === 0 : source.state === "partial" ? provenPartCount >= 1 && provenPartCount < partCount : provenPartCount < partCount;
  if (!validPrefix) {
    return fail("messaging receipt binding", "violates the proven-prefix state law");
  }
  const runId = id(source.runId, "messaging receipt binding.runId", 256);
  const normalizedWithoutReceipt = Object.freeze({
    schemaVersion: 2,
    format: "wrench.messaging-receipt-binding",
    contractId: MESSAGING_RECEIPT_BINDING_CONTRACT_ID,
    contractHash: MESSAGING_RECEIPT_BINDING_CONTRACT_HASH,
    clientIntentSha256: sha256Digest(source.clientIntentSha256, "messaging receipt binding.clientIntentSha256"),
    contextBindingSha256: sha256Digest(source.contextBindingSha256, "messaging receipt binding.contextBindingSha256"),
    sourceConversationCoordinateSha256: sha256Digest(source.sourceConversationCoordinateSha256, "messaging receipt binding.sourceConversationCoordinateSha256"),
    routeRefSha256: sha256Digest(source.routeRefSha256, "messaging receipt binding.routeRefSha256"),
    contextRefSha256: sha256Digest(source.contextRefSha256, "messaging receipt binding.contextRefSha256"),
    turnDigest: sha256Digest(source.turnDigest, "messaging receipt binding.turnDigest"),
    previewDigest: sha256Digest(source.previewDigest, "messaging receipt binding.previewDigest"),
    runId,
    state: source.state,
    partCount,
    provenPartCount,
    recordedAt: utcTimestamp(source.recordedAt, "messaging receipt binding.recordedAt")
  });
  const receiptSha256 = sha256Digest(source.receiptSha256, "messaging receipt binding.receiptSha256");
  if (sha256(canonicalJson(normalizedWithoutReceipt)) !== receiptSha256) {
    return fail("messaging receipt binding.receiptSha256", "does not bind the canonical receipt");
  }
  return Object.freeze({
    ...normalizedWithoutReceipt,
    receiptSha256
  });
}
function parseMessagingReceiptBinding(value) {
  const source = record(value, "messaging receipt binding");
  return source.contractId === MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID ? parseMessagingReceiptBindingV1(source) : parseMessagingReceiptBindingV2(source);
}

// src/messaging.ts
var MAX_STDOUT_BYTES = 64 * 1024;
var MAX_STDERR_BYTES = 64 * 1024;
var MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
var COMMAND_TIMEOUT_MS = 120000;
var COMMAND_TERMINATION_GRACE_MS = 1000;
function cliSourcePath() {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource))
    return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource))
    return packagedSource;
  throw new Error("the installed Wrench CLI source is unavailable");
}
function environmentSnapshot(overrides) {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined)
      result[key] = value;
  }
  if (overrides !== undefined) {
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides) || Object.getPrototypeOf(overrides) !== Object.prototype)
      throw new Error("Wrench messaging environment must be a plain object");
    for (const [key, value] of Object.entries(overrides)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new Error("Wrench messaging environment contains an invalid name");
      }
      if (value === undefined)
        delete result[key];
      else if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 128 * 1024 || value.includes("\x00"))
        throw new Error("Wrench messaging environment contains an invalid value");
      else
        result[key] = value;
    }
  }
  return Object.freeze(result);
}
function options(value) {
  if (value === undefined)
    return Object.freeze({ environment: environmentSnapshot(undefined) });
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => key !== "environment" && key !== "signal"))
    throw new Error("Wrench messaging options are malformed");
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) {
    throw new Error("Wrench messaging signal is malformed");
  }
  return Object.freeze({
    environment: environmentSnapshot(value.environment),
    ...value.signal === undefined ? {} : { signal: value.signal }
  });
}
function boundedError(chunks) {
  return Buffer.concat(chunks).toString("utf8").slice(0, MAX_STDERR_BYTES).trim();
}
async function runCli(operation, request, clientOptions) {
  if (typeof process.versions.bun !== "string") {
    throw new Error("@hraness/wrench/messaging requires Bun to run the installed Wrench CLI");
  }
  const prepared = options(clientOptions);
  if (prepared.signal?.aborted === true) {
    throw prepared.signal.reason instanceof Error ? prepared.signal.reason : new DOMException("Wrench messaging operation was aborted", "AbortError");
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "wrench-messaging-"));
  const privateOutput = join(temporaryDirectory, "artifact.json");
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cliSourcePath(),
        "messaging",
        operation,
        "--input",
        "-",
        "--private-output",
        privateOutput,
        "--json"
      ], {
        env: prepared.environment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let pendingError = null;
      let terminationTimer = null;
      const settleFailure = (error) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        if (terminationTimer !== null)
          clearTimeout(terminationTimer);
        prepared.signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const signalOwnedTree = (signal) => {
        try {
          if (process.platform !== "win32" && child.pid !== undefined) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {}
      };
      const ownedTreeIsAlive = () => {
        if (process.platform === "win32" || child.pid === undefined)
          return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const rejectAfterOwnedTreeExit = () => {
        signalOwnedTree("SIGKILL");
        if (!ownedTreeIsAlive()) {
          settleFailure(pendingError ?? new Error("Wrench messaging operation failed"));
          return;
        }
        setTimeout(rejectAfterOwnedTreeExit, 10);
      };
      const requestTermination = (error) => {
        pendingError ??= error;
        if (child.pid === undefined) {
          settleFailure(pendingError);
          return;
        }
        if (terminationTimer !== null)
          return;
        signalOwnedTree("SIGTERM");
        terminationTimer = setTimeout(() => signalOwnedTree("SIGKILL"), COMMAND_TERMINATION_GRACE_MS);
        terminationTimer.unref?.();
      };
      const abort = () => {
        requestTermination(prepared.signal?.reason instanceof Error ? prepared.signal.reason : new DOMException("Wrench messaging operation was aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        requestTermination(new Error("Wrench messaging operation timed out"));
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      prepared.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => requestTermination(error));
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          requestTermination(new Error("Wrench messaging receipt exceeded its byte bound"));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) {
          requestTermination(new Error("Wrench messaging diagnostic exceeded its byte bound"));
          return;
        }
        stderr.push(Buffer.from(chunk));
      });
      child.on("close", (code) => {
        if (settled)
          return;
        clearTimeout(timer);
        if (terminationTimer !== null)
          clearTimeout(terminationTimer);
        prepared.signal?.removeEventListener("abort", abort);
        if (pendingError !== null) {
          rejectAfterOwnedTreeExit();
          return;
        }
        settled = true;
        resolve(Object.freeze({
          code: code ?? 3,
          stdout: Buffer.concat(stdout),
          stderr: Object.freeze(stderr)
        }));
      });
      child.stdin.on("error", (error) => requestTermination(error));
      child.stdin.end(`${canonicalJson(request)}
`, "utf8");
    });
    if (result.code !== 0) {
      throw new Error(boundedError(result.stderr) || `Wrench messaging exited ${result.code}`);
    }
    let receiptValue;
    try {
      receiptValue = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new Error("Wrench messaging returned a malformed receipt");
    }
    const receipt = parseMessagingPrivateOutputReceiptV1(receiptValue);
    const expectedFormat = operation === "routes" ? "wrench.messaging-routes" : operation === "resolve" ? "wrench.messaging-route" : operation === "context" ? "wrench.messaging-context" : "wrench.messaging-preview";
    if (receipt.artifactFormat !== expectedFormat) {
      throw new Error("Wrench messaging returned another private artifact contract");
    }
    const stats = lstatSync(privateOutput);
    const currentUid = process.getuid?.();
    if (!stats.isFile() || currentUid === undefined || stats.uid !== currentUid || (stats.mode & 511) !== 384 || stats.size > MAX_ARTIFACT_BYTES)
      throw new Error("Wrench messaging private artifact is not an owned mode-0600 file");
    const artifactText = readFileSync(privateOutput, "utf8");
    let artifact;
    try {
      artifact = JSON.parse(artifactText);
    } catch {
      throw new Error("Wrench messaging private artifact is malformed JSON");
    }
    if (sha256(canonicalJson(artifact)) !== receipt.artifactSha256) {
      throw new Error("Wrench messaging private artifact does not match its receipt");
    }
    return artifact;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
async function discoverMessagingRoutes(request, clientOptions) {
  const value = parseMessagingRoutesV1(await runCli("routes", parseMessagingRoutesRequestV1(request), clientOptions));
  return value;
}
async function resolveMessagingRoute(request, clientOptions) {
  return parseMessagingRouteV1(await runCli("resolve", parseMessagingRouteResolveRequestV1(request), clientOptions));
}
async function readMessagingContext(request, clientOptions) {
  return parseMessagingContextV1(await runCli("context", parseMessagingContextRequestV1(request), clientOptions));
}
async function previewMessagingTurn(request, clientOptions) {
  return parseMessagingPreviewV1(await runCli("preview", parseMessagingTurnV1(request), clientOptions));
}
export {
  resolveMessagingRoute,
  readMessagingContext,
  previewMessagingTurn,
  parseMessagingTurnV1,
  parseMessagingRoutesV1,
  parseMessagingRoutesRequestV1,
  parseMessagingRouteV1,
  parseMessagingRouteResolveRequestV1,
  parseMessagingReceiptBindingV2,
  parseMessagingReceiptBindingV1,
  parseMessagingReceiptBinding,
  parseMessagingPrivateOutputReceiptV1,
  parseMessagingPreviewV1,
  parseMessagingContextV1,
  parseMessagingContextRequestV1,
  parseMessagingContextBindingV2,
  parseMessagingContextBindingV1,
  parseMessagingContextBinding,
  messagingTurnDigest,
  discoverMessagingRoutes,
  MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID,
  MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH,
  MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR,
  MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
  MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
  MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR,
  MESSAGING_RECEIPT_BINDING_CONTRACT_ID,
  MESSAGING_RECEIPT_BINDING_CONTRACT_HASH,
  MESSAGING_RECEIPT_BINDING_CONTRACT_DESCRIPTOR,
  MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID,
  MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH,
  MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR,
  MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
  MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH,
  MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR,
  MESSAGING_CONTEXT_BINDING_CONTRACT_ID,
  MESSAGING_CONTEXT_BINDING_CONTRACT_HASH,
  MESSAGING_CONTEXT_BINDING_CONTRACT_DESCRIPTOR
};
