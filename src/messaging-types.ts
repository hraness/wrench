/**
 * Side-effect-free provider-neutral messaging DTOs.
 *
 * Raw route, context, reply, and message references are local capabilities.
 * They belong only in caller-owned memory, stdin, or checked private files.
 */

import { types as nodeTypes } from "node:util";

import { canonicalJson, sha256 } from "./canonical-json";
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
  parseWrenchMessagingContextBindingV2,
  type MessageLikeMeSourceConversationCoordinateBindingV1,
  type WrenchMessagingContextBindingV1,
  type WrenchMessagingContextBindingV2,
  type WrenchMessagingReceiptBindingV1,
  type WrenchMessagingReceiptBindingV2,
} from "./message-like-me-agentic-messaging";

export const MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID =
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID;
export const MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR =
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR;
export const MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH =
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH;

export const MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID =
  WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID;
export const MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR =
  WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR;
export const MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH =
  WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH;

export const MESSAGING_CONTEXT_BINDING_CONTRACT_ID =
  MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID;

export const MESSAGING_CONTEXT_BINDING_CONTRACT_DESCRIPTOR =
  MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR;

/** SHA-256 of the canonical descriptor above. */
export const MESSAGING_CONTEXT_BINDING_CONTRACT_HASH =
  MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH;

export const MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID =
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID;
export const MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR =
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR;
export const MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH =
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH;

export const MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID =
  WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID;
export const MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR =
  WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR;
export const MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH =
  WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH;

export const MESSAGING_RECEIPT_BINDING_CONTRACT_ID =
  MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID;

export const MESSAGING_RECEIPT_BINDING_CONTRACT_DESCRIPTOR =
  MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR;

export const MESSAGING_RECEIPT_BINDING_CONTRACT_HASH =
  MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH;

export type MessagingSourceConversationCoordinateBindingV1 =
  MessageLikeMeSourceConversationCoordinateBindingV1;

export type MessagingRoutesRequestSourceV1 = {
  readonly adapterId: string;
  readonly authId: string;
  readonly listInput: Readonly<Record<string, unknown>>;
};

export type MessagingRoutesRequestV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-routes-request";
  /** One exact adapter, auth realm, and provider list coordinate. */
  readonly source: MessagingRoutesRequestSourceV1;
};

export type MessagingRouteResolveRequestV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-route-resolve-request";
  /** Opaque reference to one checked list candidate in Wrench private state. */
  readonly routeRef: string;
};

export type MessagingRouteV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-route";
  readonly routeRef: string;
  readonly network: string;
  readonly conversation: {
    readonly kind: "single" | "group" | "unknown";
    readonly title: string | null;
    readonly participantCount: number;
  };
  readonly readiness: {
    readonly context:
      | "ready"
      | "historical-readable"
      | "resolution-required"
      | "unavailable";
    readonly turn: "ready" | "unavailable";
    readonly reply: "supported" | "unsupported";
    readonly reason: string | null;
  };
  readonly completeness: {
    readonly kind:
      | "complete"
      | "page"
      | "unknown"
      | "first-page-only"
      | "bounded-local"
      | "search-window"
      | "truncated";
    readonly reason: string | null;
  };
  readonly expiresAt: string;
};

export type MessagingRoutesV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-routes";
  readonly generatedAt: string;
  readonly completeness: MessagingRouteV1["completeness"];
  readonly continuation: {
    readonly direction: "forward" | "backward" | "none";
    readonly request: string | null;
    readonly nextInput: Readonly<Record<string, unknown>> | null;
  };
  readonly routes: readonly MessagingRouteV1[];
};

export type MessagingContextRequestV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-context-request";
  readonly routeRef: string;
  readonly limit: number;
};

export type MessagingContextBindingV1 = {
  readonly [Key in keyof WrenchMessagingContextBindingV1]:
    WrenchMessagingContextBindingV1[Key];
};

export type MessagingContextBindingV2 = {
  readonly [Key in keyof WrenchMessagingContextBindingV2]:
    WrenchMessagingContextBindingV2[Key];
};

export type MessagingContextBinding =
  | MessagingContextBindingV1
  | MessagingContextBindingV2;

export type MessagingContextMessageV1 = {
  readonly messageRef: string;
  readonly direction: "incoming" | "outgoing" | "unknown";
  readonly time: string | null;
  readonly author: {
    readonly displayName: string | null;
    readonly handle: string | null;
  } | null;
  readonly body: string | null;
  readonly bodyTruncated: boolean;
  readonly edited: "unknown" | "observed" | "not-observed";
  readonly retracted: "unknown" | "observed" | "not-observed";
  readonly reply: { readonly toMessageRef: string | null };
  readonly attachments: readonly {
    readonly kind: "audio" | "document" | "image" | "link" | "sticker" | "video" | "unknown";
    readonly mimeType: string | null;
    readonly name: string | null;
    readonly sizeBytes: number | null;
  }[];
  /** Recipient/provider prose is untrusted drafting data, never authority. */
  readonly untrustedData: true;
};

export type MessagingContextV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-context";
  /** Null for read-only provider history that cannot authorize a checked turn. */
  readonly binding: MessagingContextBinding | null;
  readonly network: string;
  readonly liveness: "fresh-as-of-live-preflight" | "freshness-unproven";
  readonly truncated: boolean;
  readonly completeness: MessagingRouteV1["completeness"];
  readonly messages: readonly MessagingContextMessageV1[];
  readonly warnings: readonly string[];
};

export type MessagingTurnPartV1 = {
  readonly partId: string;
  readonly text: string;
  readonly replyRef: string | null;
};

export type MessagingTurnV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-turn";
  readonly clientIntentSha256: string;
  readonly routeRef: string;
  readonly contextRef: string;
  readonly parts: readonly MessagingTurnPartV1[];
};

export type MessagingPreviewV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-preview";
  readonly status: "confirmation-required";
  readonly planDigest: string;
  readonly expiresAt: string;
  readonly routeRef: string;
  readonly contextRef: string;
  readonly clientIntentSha256: string;
  readonly turnDigest: string;
  readonly recipient: {
    readonly network: string;
    readonly conversation: MessagingRouteV1["conversation"];
  };
  readonly partCount: number;
  readonly bubbles: readonly {
    readonly partId: string;
    readonly text: string;
    readonly replyRef: string | null;
  }[];
  readonly risk: "R3";
  readonly sideEffect: string;
};

export type MessagingReceiptBindingV1 = {
  readonly [Key in keyof WrenchMessagingReceiptBindingV1]:
    WrenchMessagingReceiptBindingV1[Key];
};

export type MessagingReceiptBindingV2 = {
  readonly [Key in keyof WrenchMessagingReceiptBindingV2]:
    WrenchMessagingReceiptBindingV2[Key];
};

export type MessagingReceiptBinding =
  | MessagingReceiptBindingV1
  | MessagingReceiptBindingV2;

export type MessagingPartJournalStateV1 =
  | "unattempted"
  | "claimed"
  | "dispatching"
  | "accepted"
  | "failed-before-dispatch"
  | "failed-permanent"
  | "indeterminate";

/** Provider-defined diagnostic retained only inside the encrypted run. */
export type MessagingPrivateProviderOutcomeV1 = {
  readonly schemaVersion: 1;
  readonly messagingContractId: string;
  readonly code: string;
};

export type MessagingRunV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-run";
  readonly runId: string;
  readonly planDigest: string;
  readonly routeRef: string;
  readonly contextRef: string;
  readonly clientIntentSha256: string;
  readonly contextBindingSha256: string | null;
  readonly sourceConversationCoordinateSha256: string | null;
  readonly turnDigest: string;
  readonly previewDigest: string;
  readonly state: "pending" | "submitted" | "failed" | "partial" | "indeterminate";
  readonly partCount: number;
  readonly provenPartCount: number;
  /** Durable high-water mark for accepted own messages proven in live context. */
  readonly observedAcceptedPrefixCount: number;
  readonly possibleSubmittedPartIndex: number | null;
  readonly privateProviderOutcome: MessagingPrivateProviderOutcomeV1 | null;
  readonly terminalReason:
    | null
    | "context-drift"
    | "prefix-freshness-unproven"
    | "provider-failed-before-dispatch"
    | "provider-result-indeterminate"
    | "journal-recovery-required";
  readonly parts: readonly {
    readonly partId: string;
    readonly text: string;
    readonly replyRef: string | null;
    readonly replyToProviderId: string | null;
    readonly direction: "outgoing";
    readonly bodySha256: string;
    readonly state: MessagingPartJournalStateV1;
    readonly providerMessageId: string | null;
    readonly providerRevision: string | null;
    readonly delivery: "unknown" | "delivered" | "failed";
    readonly read: "unknown" | "read";
  }[];
  readonly startedAt: string;
  readonly recordedAt: string;
};

export type MessagingRunReceiptV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-run-receipt";
  readonly planDigest: string;
  readonly runId: string;
  readonly state: "submitted" | "failed" | "partial" | "indeterminate";
  readonly partCount: number;
  readonly provenPartCount: number;
  readonly clientIntentSha256: string;
  readonly routeRefSha256: string;
  readonly contextRefSha256: string;
  readonly turnDigest: string;
  readonly previewDigest: string;
  readonly receiptBindingSha256: string;
  readonly recordedAt: string;
};

export type MessagingRunReceiptV2 = {
  readonly schemaVersion: 2;
  readonly format: "wrench.messaging-run-receipt";
  readonly planDigest: string;
  readonly runId: string;
  readonly state: "submitted" | "failed" | "partial" | "indeterminate";
  readonly partCount: number;
  readonly provenPartCount: number;
  readonly clientIntentSha256: string;
  readonly contextBindingSha256: string;
  readonly sourceConversationCoordinateSha256: string;
  readonly routeRefSha256: string;
  readonly contextRefSha256: string;
  readonly turnDigest: string;
  readonly previewDigest: string;
  readonly receiptBindingSha256: string;
  readonly recordedAt: string;
};

export type MessagingRunReceipt = MessagingRunReceiptV1 | MessagingRunReceiptV2;

export type MessagingClientEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type MessagingClientOptions = {
  readonly environment?: MessagingClientEnvironment;
  readonly signal?: AbortSignal;
};

export type MessagingPrivateOutputReceiptV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-private-output-receipt";
  readonly artifactFormat:
    | "wrench.messaging-route"
    | "wrench.messaging-routes"
    | "wrench.messaging-context"
    | "wrench.messaging-preview"
    | "wrench.messaging-run"
    | "wrench.messaging-receipt-binding";
  readonly artifactSha256: string;
  readonly itemCount: number;
  readonly generatedAt: string;
  readonly expiresAt: string | null;
};

type JsonRecord = Record<string, unknown>;

function fail(label: string, detail: string): never {
  throw new Error(`${label} ${detail}`);
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
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    return fail(label, "must not contain symbol properties");
  }
  const result: JsonRecord = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}.${key}`, "must be an enumerable data property");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) return fail(label, "has unsupported or missing fields");
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) return fail(label, `must be a dense array of at most ${maximum} items`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return fail(label, "must not be sparse");
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(label, "must contain only enumerable data items");
    }
  }
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  if (Reflect.ownKeys(value).some((key) => !expected.has(key))) {
    return fail(label, "must not contain named or symbol properties");
  }
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function text(
  value: unknown,
  label: string,
  maximumBytes: number,
  options: { readonly allowEmpty?: boolean; readonly allowNewlines?: boolean } = {},
): string {
  if (
    typeof value !== "string"
    || (!options.allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || hasUnpairedSurrogate(value)
    || /[\0\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value)
    || (!options.allowNewlines && /[\r\n]/u.test(value))
  ) return fail(label, "must be bounded well-formed inert text");
  return value;
}

function id(value: unknown, label: string, maximum = 256): string {
  const result = text(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(result)) {
    return fail(label, "must be an exact opaque identifier");
  }
  return result;
}

function routeRef(value: unknown, label: string): string {
  const result = id(value, label, 128);
  if (!/^wmroute_[A-Za-z0-9_-]{22}$/u.test(result)) {
    return fail(label, "must be a Wrench messaging route reference");
  }
  return result;
}

function contextRef(value: unknown, label: string): string {
  const result = id(value, label, 128);
  if (!/^wmcontext_[A-Za-z0-9_-]{22}$/u.test(result)) {
    return fail(label, "must be a Wrench messaging context reference");
  }
  return result;
}

function replyRef(value: unknown, label: string): string {
  const result = id(value, label, 128);
  if (!/^wmreply_[A-Za-z0-9_-]{22}$/u.test(result)) {
    return fail(label, "must be a Wrench messaging reply reference");
  }
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return fail(label, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function cloneJsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (candidate: unknown, path: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) return fail(label, "exceeds its structural bound");
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") {
      if (typeof candidate === "string") text(candidate, path, 256 * 1024, { allowEmpty: true, allowNewlines: true });
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return fail(path, "must contain finite JSON numbers");
      return candidate;
    }
    if (typeof candidate !== "object") return fail(path, "must contain only JSON data");
    if (ancestors.has(candidate)) return fail(label, "must not contain cycles");
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return Object.freeze(denseArray(candidate, path, 1_000)
          .map((item, index) => visit(item, `${path}[${index}]`, depth + 1)));
      }
      const source = record(candidate, path);
      const entries = Object.entries(source).map(([key, item]) => {
        text(key, `${path} key`, 256);
        return [key, visit(item, `${path}.${key}`, depth + 1)] as const;
      });
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      ancestors.delete(candidate);
    }
  };
  return record(visit(value, label, 0), label);
}

function parseRoutesSource(
  value: unknown,
  label: string,
): MessagingRoutesRequestSourceV1 {
  const item = record(value, label);
  exactKeys(item, ["adapterId", "authId", "listInput"], [], label);
  const exactSource = Object.freeze({
    adapterId: id(item.adapterId, `${label}.adapterId`, 64),
    authId: id(item.authId, `${label}.authId`, 48),
    listInput: cloneJsonRecord(item.listInput, `${label}.listInput`),
  });
  return exactSource;
}

export function parseMessagingRoutesRequestV1(value: unknown): MessagingRoutesRequestV1 {
  const source = record(value, "messaging routes request");
  exactKeys(source, ["schemaVersion", "format", "source"], [], "messaging routes request");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-routes-request") {
    return fail("messaging routes request", "has an unsupported contract");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-routes-request",
    source: parseRoutesSource(source.source, "messaging routes request.source"),
  });
}

export function parseMessagingRouteResolveRequestV1(
  value: unknown,
): MessagingRouteResolveRequestV1 {
  const source = record(value, "messaging route resolve request");
  exactKeys(
    source,
    ["schemaVersion", "format", "routeRef"],
    [],
    "messaging route resolve request",
  );
  if (
    source.schemaVersion !== 1
    || source.format !== "wrench.messaging-route-resolve-request"
  ) return fail("messaging route resolve request", "has an unsupported contract");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-route-resolve-request",
    routeRef: routeRef(
      source.routeRef,
      "messaging route resolve request.routeRef",
    ),
  });
}

export function parseMessagingContextRequestV1(value: unknown): MessagingContextRequestV1 {
  const source = record(value, "messaging context request");
  exactKeys(source, ["schemaVersion", "format", "routeRef", "limit"], [], "messaging context request");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-context-request") {
    return fail("messaging context request", "has an unsupported contract");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context-request",
    routeRef: routeRef(source.routeRef, "messaging context request.routeRef"),
    limit: integer(source.limit, "messaging context request.limit", 1, 200),
  });
}

export function parseMessagingTurnV1(value: unknown): MessagingTurnV1 {
  const source = record(value, "messaging turn");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "clientIntentSha256",
    "routeRef",
    "contextRef",
    "parts",
  ], [], "messaging turn");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-turn") {
    return fail("messaging turn", "has an unsupported contract");
  }
  const seen = new Set<string>();
  const parts = denseArray(source.parts, "messaging turn.parts", 8)
    .map((candidate, index) => {
      const item = record(candidate, `messaging turn.parts[${index}]`);
      exactKeys(item, ["partId", "text", "replyRef"], [], `messaging turn.parts[${index}]`);
      const partId = id(item.partId, `messaging turn.parts[${index}].partId`, 64);
      if (seen.has(partId)) return fail("messaging turn.parts", "must not repeat part IDs");
      seen.add(partId);
      return Object.freeze({
        partId,
        text: text(item.text, `messaging turn.parts[${index}].text`, 65_536, { allowNewlines: true }),
        replyRef: item.replyRef === null
          ? null
          : replyRef(item.replyRef, `messaging turn.parts[${index}].replyRef`),
      });
    });
  if (parts.length === 0) return fail("messaging turn.parts", "must not be empty");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-turn",
    clientIntentSha256: sha256Digest(
      source.clientIntentSha256,
      "messaging turn.clientIntentSha256",
    ),
    routeRef: routeRef(source.routeRef, "messaging turn.routeRef"),
    contextRef: contextRef(source.contextRef, "messaging turn.contextRef"),
    parts: Object.freeze(parts),
  });
}

export function messagingTurnDigest(turn: MessagingTurnV1): string {
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
      replyRef: part.replyRef,
    })),
  }));
}

export function parseMessagingContextBindingV1(value: unknown): MessagingContextBindingV1 {
  const parsed = parseWrenchMessagingContextBindingV1(value);
  routeRef(parsed.routeRef, "messaging context binding.routeRef");
  contextRef(parsed.contextRef, "messaging context binding.contextRef");
  return parsed;
}

export function parseMessagingContextBindingV2(value: unknown): MessagingContextBindingV2 {
  const parsed = parseWrenchMessagingContextBindingV2(value);
  routeRef(parsed.routeRef, "messaging context binding.routeRef");
  contextRef(parsed.contextRef, "messaging context binding.contextRef");
  return parsed;
}

export function parseMessagingContextBinding(value: unknown): MessagingContextBinding {
  const source = record(value, "messaging context binding");
  return source.contractId === MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID
    ? parseMessagingContextBindingV1(source)
    : parseMessagingContextBindingV2(source);
}

function sha256Digest(candidate: unknown, label: string): string {
  const result = text(candidate, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) return fail(label, "must be a SHA-256 digest");
  return result;
}

function utcTimestamp(candidate: unknown, label: string): string {
  const result = text(candidate, label, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result)
    || !Number.isFinite(Date.parse(result))
  ) return fail(label, "must be an RFC3339 UTC timestamp");
  return result;
}

function nullableBoundedText(
  candidate: unknown,
  label: string,
  maximumBytes: number,
  allowNewlines = false,
): string | null {
  return candidate === null
    ? null
    : text(candidate, label, maximumBytes, {
        allowEmpty: true,
        allowNewlines,
      });
}

function bool(candidate: unknown, label: string): boolean {
  if (typeof candidate !== "boolean") return fail(label, "must be boolean");
  return candidate;
}

function completeness(
  value: unknown,
  label: string,
): MessagingRouteV1["completeness"] {
  const source = record(value, label);
  exactKeys(source, ["kind", "reason"], [], label);
  const kinds = new Set<MessagingRouteV1["completeness"]["kind"]>([
    "complete",
    "page",
    "unknown",
    "first-page-only",
    "bounded-local",
    "search-window",
    "truncated",
  ]);
  if (!kinds.has(source.kind as MessagingRouteV1["completeness"]["kind"])) {
    return fail(`${label}.kind`, "is unsupported");
  }
  return Object.freeze({
    kind: source.kind as MessagingRouteV1["completeness"]["kind"],
    reason: nullableBoundedText(source.reason, `${label}.reason`, 2_048),
  });
}

function conversation(
  value: unknown,
  label: string,
): MessagingRouteV1["conversation"] {
  const source = record(value, label);
  exactKeys(source, ["kind", "title", "participantCount"], [], label);
  if (
    source.kind !== "single"
    && source.kind !== "group"
    && source.kind !== "unknown"
  ) return fail(`${label}.kind`, "is unsupported");
  return Object.freeze({
    kind: source.kind,
    title: nullableBoundedText(source.title, `${label}.title`, 4_096, true),
    participantCount: integer(
      source.participantCount,
      `${label}.participantCount`,
      0,
      10_000,
    ),
  });
}

export function parseMessagingRouteV1(value: unknown): MessagingRouteV1 {
  const source = record(value, "messaging route");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "routeRef",
    "network",
    "conversation",
    "readiness",
    "completeness",
    "expiresAt",
  ], [], "messaging route");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-route") {
    return fail("messaging route", "has an unsupported contract");
  }
  const readiness = record(source.readiness, "messaging route.readiness");
  exactKeys(
    readiness,
    ["context", "turn", "reply", "reason"],
    [],
    "messaging route.readiness",
  );
  if (
    readiness.context !== "ready"
    && readiness.context !== "historical-readable"
    && readiness.context !== "resolution-required"
    && readiness.context !== "unavailable"
  ) return fail("messaging route.readiness.context", "is unsupported");
  if (readiness.turn !== "ready" && readiness.turn !== "unavailable") {
    return fail("messaging route.readiness.turn", "is unsupported");
  }
  if (readiness.reply !== "supported" && readiness.reply !== "unsupported") {
    return fail("messaging route.readiness.reply", "is unsupported");
  }
  if (
    readiness.context !== "ready"
    && (readiness.turn !== "unavailable" || readiness.reply !== "unsupported")
  ) return fail("messaging route.readiness", "must block actions when freshness is unproven");
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
      reason: nullableBoundedText(
        readiness.reason,
        "messaging route.readiness.reason",
        1_000,
      ),
    }),
    completeness: completeness(source.completeness, "messaging route.completeness"),
    expiresAt: utcTimestamp(source.expiresAt, "messaging route.expiresAt"),
  });
}

export function parseMessagingRoutesV1(value: unknown): MessagingRoutesV1 {
  const source = record(value, "messaging routes");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "generatedAt",
    "completeness",
    "continuation",
    "routes",
  ], [], "messaging routes");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-routes") {
    return fail("messaging routes", "has an unsupported contract");
  }
  const continuation = record(source.continuation, "messaging routes.continuation");
  exactKeys(
    continuation,
    ["direction", "request", "nextInput"],
    [],
    "messaging routes.continuation",
  );
  if (
    continuation.direction !== "forward"
    && continuation.direction !== "backward"
    && continuation.direction !== "none"
  ) return fail("messaging routes.continuation.direction", "is unsupported");
  const request = nullableBoundedText(
    continuation.request,
    "messaging routes.continuation.request",
    8_192,
  );
  const nextInput = continuation.nextInput === null
    ? null
    : cloneJsonRecord(
        continuation.nextInput,
        "messaging routes.continuation.nextInput",
      );
  if (
    continuation.direction === "none"
    && (request !== null || nextInput !== null)
  ) return fail("messaging routes.continuation", "must be empty when direction is none");
  const routes = denseArray(source.routes, "messaging routes.routes", 1_000)
    .map(parseMessagingRouteV1);
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-routes",
    generatedAt: utcTimestamp(source.generatedAt, "messaging routes.generatedAt"),
    completeness: completeness(source.completeness, "messaging routes.completeness"),
    continuation: Object.freeze({
      direction: continuation.direction,
      request,
      nextInput,
    }),
    routes: Object.freeze(routes),
  });
}

export function parseMessagingContextV1(value: unknown): MessagingContextV1 {
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
    "warnings",
  ], [], "messaging context");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-context") {
    return fail("messaging context", "has an unsupported contract");
  }
  if (
    source.liveness !== "fresh-as-of-live-preflight"
    && source.liveness !== "freshness-unproven"
  ) return fail("messaging context.liveness", "is unsupported");
  const messages = denseArray(source.messages, "messaging context.messages", 200)
    .map((value_, index): MessagingContextMessageV1 => {
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
        "untrustedData",
      ], [], label);
      if (
        message.direction !== "incoming"
        && message.direction !== "outgoing"
        && message.direction !== "unknown"
      ) return fail(`${label}.direction`, "is unsupported");
      if (
        message.edited !== "unknown"
        && message.edited !== "observed"
        && message.edited !== "not-observed"
      ) return fail(`${label}.edited`, "is unsupported");
      if (
        message.retracted !== "unknown"
        && message.retracted !== "observed"
        && message.retracted !== "not-observed"
      ) return fail(`${label}.retracted`, "is unsupported");
      if (message.untrustedData !== true) {
        return fail(`${label}.untrustedData`, "must be true");
      }
      const authorSource = message.author === null
        ? null
        : record(message.author, `${label}.author`);
      if (authorSource !== null) {
        exactKeys(authorSource, ["displayName", "handle"], [], `${label}.author`);
      }
      const reply = record(message.reply, `${label}.reply`);
      exactKeys(reply, ["toMessageRef"], [], `${label}.reply`);
      const attachments = denseArray(
        message.attachments,
        `${label}.attachments`,
        64,
      ).map((value__, attachmentIndex) => {
        const attachmentLabel = `${label}.attachments[${attachmentIndex}]`;
        const attachment = record(value__, attachmentLabel);
        exactKeys(
          attachment,
          ["kind", "mimeType", "name", "sizeBytes"],
          [],
          attachmentLabel,
        );
        const kinds = new Set<MessagingContextMessageV1["attachments"][number]["kind"]>([
          "audio", "document", "image", "link", "sticker", "video", "unknown",
        ]);
        if (!kinds.has(attachment.kind as MessagingContextMessageV1["attachments"][number]["kind"])) {
          return fail(`${attachmentLabel}.kind`, "is unsupported");
        }
        return Object.freeze({
          kind: attachment.kind as MessagingContextMessageV1["attachments"][number]["kind"],
          mimeType: nullableBoundedText(
            attachment.mimeType,
            `${attachmentLabel}.mimeType`,
            256,
          ),
          name: nullableBoundedText(
            attachment.name,
            `${attachmentLabel}.name`,
            1_024,
            true,
          ),
          sizeBytes: attachment.sizeBytes === null
            ? null
            : integer(
                attachment.sizeBytes,
                `${attachmentLabel}.sizeBytes`,
                0,
                Number.MAX_SAFE_INTEGER,
              ),
        });
      });
      return Object.freeze({
        messageRef: replyRef(message.messageRef, `${label}.messageRef`),
        direction: message.direction,
        time: message.time === null
          ? null
          : utcTimestamp(message.time, `${label}.time`),
        author: authorSource === null
          ? null
          : Object.freeze({
              displayName: nullableBoundedText(
                authorSource.displayName,
                `${label}.author.displayName`,
                2_048,
                true,
              ),
              handle: nullableBoundedText(
                authorSource.handle,
                `${label}.author.handle`,
                512,
              ),
            }),
        body: nullableBoundedText(message.body, `${label}.body`, 256 * 1024, true),
        bodyTruncated: bool(message.bodyTruncated, `${label}.bodyTruncated`),
        edited: message.edited,
        retracted: message.retracted,
        reply: Object.freeze({
          toMessageRef: reply.toMessageRef === null
            ? null
            : replyRef(reply.toMessageRef, `${label}.reply.toMessageRef`),
        }),
        attachments: Object.freeze(attachments),
        untrustedData: true,
      });
    });
  const warnings = denseArray(source.warnings, "messaging context.warnings", 32)
    .map((value_, index) => text(
      value_,
      `messaging context.warnings[${index}]`,
      512,
    ));
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context",
    binding: source.binding === null
      ? null
      : parseMessagingContextBinding(source.binding),
    network: id(source.network, "messaging context.network", 64),
    liveness: source.liveness,
    truncated: bool(source.truncated, "messaging context.truncated"),
    completeness: completeness(source.completeness, "messaging context.completeness"),
    messages: Object.freeze(messages),
    warnings: Object.freeze(warnings),
  });
}

export function parseMessagingPreviewV1(value: unknown): MessagingPreviewV1 {
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
    "sideEffect",
  ], [], "messaging preview");
  if (
    source.schemaVersion !== 1
    || source.format !== "wrench.messaging-preview"
    || source.status !== "confirmation-required"
    || source.risk !== "R3"
  ) return fail("messaging preview", "has an unsupported contract");
  const recipient = record(source.recipient, "messaging preview.recipient");
  exactKeys(recipient, ["network", "conversation"], [], "messaging preview.recipient");
  const bubbles = denseArray(source.bubbles, "messaging preview.bubbles", 8)
    .map((value_, index) => {
      const label = `messaging preview.bubbles[${index}]`;
      const bubble = record(value_, label);
      exactKeys(bubble, ["partId", "text", "replyRef"], [], label);
      return Object.freeze({
        partId: id(bubble.partId, `${label}.partId`, 64),
        text: text(bubble.text, `${label}.text`, 65_536, { allowNewlines: true }),
        replyRef: bubble.replyRef === null
          ? null
          : replyRef(bubble.replyRef, `${label}.replyRef`),
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
    clientIntentSha256: sha256Digest(
      source.clientIntentSha256,
      "messaging preview.clientIntentSha256",
    ),
    turnDigest: sha256Digest(source.turnDigest, "messaging preview.turnDigest"),
    recipient: Object.freeze({
      network: id(recipient.network, "messaging preview.recipient.network", 64),
      conversation: conversation(
        recipient.conversation,
        "messaging preview.recipient.conversation",
      ),
    }),
    partCount,
    bubbles: Object.freeze(bubbles),
    risk: "R3",
    sideEffect: text(source.sideEffect, "messaging preview.sideEffect", 1_024),
  });
}

export function parseMessagingPrivateOutputReceiptV1(
  value: unknown,
): MessagingPrivateOutputReceiptV1 {
  const source = record(value, "messaging private output receipt");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "artifactFormat",
    "artifactSha256",
    "itemCount",
    "generatedAt",
    "expiresAt",
  ], [], "messaging private output receipt");
  const formats = new Set<MessagingPrivateOutputReceiptV1["artifactFormat"]>([
    "wrench.messaging-route",
    "wrench.messaging-routes",
    "wrench.messaging-context",
    "wrench.messaging-preview",
    "wrench.messaging-run",
    "wrench.messaging-receipt-binding",
  ]);
  if (
    source.schemaVersion !== 1
    || source.format !== "wrench.messaging-private-output-receipt"
    || !formats.has(source.artifactFormat as MessagingPrivateOutputReceiptV1["artifactFormat"])
  ) return fail("messaging private output receipt", "has an unsupported contract");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-private-output-receipt",
    artifactFormat: source.artifactFormat as MessagingPrivateOutputReceiptV1["artifactFormat"],
    artifactSha256: sha256Digest(
      source.artifactSha256,
      "messaging private output receipt.artifactSha256",
    ),
    itemCount: integer(
      source.itemCount,
      "messaging private output receipt.itemCount",
      0,
      1_000,
    ),
    generatedAt: utcTimestamp(
      source.generatedAt,
      "messaging private output receipt.generatedAt",
    ),
    expiresAt: source.expiresAt === null
      ? null
      : utcTimestamp(
          source.expiresAt,
          "messaging private output receipt.expiresAt",
        ),
  });
}

export function parseMessagingReceiptBindingV1(
  value: unknown,
): MessagingReceiptBindingV1 {
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
    "recordedAt",
  ], [], "messaging receipt binding V1");
  if (
    source.schemaVersion !== 1
    || source.format !== "wrench.messaging-receipt-binding"
    || source.contractId !== MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID
    || source.contractHash !== MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH
    || source.state !== "submitted"
      && source.state !== "failed"
      && source.state !== "partial"
      && source.state !== "indeterminate"
  ) return fail("messaging receipt binding V1", "has an unsupported contract");
  const partCount = integer(source.partCount, "messaging receipt binding V1.partCount", 1, 8);
  const provenPartCount = integer(
    source.provenPartCount,
    "messaging receipt binding V1.provenPartCount",
    0,
    partCount,
  );
  const validPrefix = source.state === "submitted"
    ? provenPartCount === partCount
    : source.state === "failed"
      ? provenPartCount === 0
      : source.state === "partial"
        ? provenPartCount >= 1 && provenPartCount < partCount
        : provenPartCount < partCount;
  if (!validPrefix) {
    return fail("messaging receipt binding V1", "violates the proven-prefix state law");
  }
  const normalizedWithoutReceipt = Object.freeze({
    schemaVersion: 1 as const,
    format: "wrench.messaging-receipt-binding" as const,
    contractId: MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
    contractHash: MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
    clientIntentSha256: sha256Digest(
      source.clientIntentSha256,
      "messaging receipt binding V1.clientIntentSha256",
    ),
    routeRefSha256: sha256Digest(
      source.routeRefSha256,
      "messaging receipt binding V1.routeRefSha256",
    ),
    contextRefSha256: sha256Digest(
      source.contextRefSha256,
      "messaging receipt binding V1.contextRefSha256",
    ),
    turnDigest: sha256Digest(source.turnDigest, "messaging receipt binding V1.turnDigest"),
    previewDigest: sha256Digest(
      source.previewDigest,
      "messaging receipt binding V1.previewDigest",
    ),
    runId: id(source.runId, "messaging receipt binding V1.runId", 256),
    state: source.state,
    partCount,
    provenPartCount,
    recordedAt: utcTimestamp(
      source.recordedAt,
      "messaging receipt binding V1.recordedAt",
    ),
  });
  const receiptSha256 = sha256Digest(
    source.receiptSha256,
    "messaging receipt binding V1.receiptSha256",
  );
  if (sha256(canonicalJson(normalizedWithoutReceipt)) !== receiptSha256) {
    return fail(
      "messaging receipt binding V1.receiptSha256",
      "does not bind the canonical receipt",
    );
  }
  return Object.freeze({ ...normalizedWithoutReceipt, receiptSha256 });
}

export function parseMessagingReceiptBindingV2(
  value: unknown,
): MessagingReceiptBindingV2 {
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
    "recordedAt",
  ], [], "messaging receipt binding");
  if (
    source.schemaVersion !== 2
    || source.format !== "wrench.messaging-receipt-binding"
    || source.contractId !== MESSAGING_RECEIPT_BINDING_CONTRACT_ID
    || source.contractHash !== MESSAGING_RECEIPT_BINDING_CONTRACT_HASH
    || source.state !== "submitted"
      && source.state !== "failed"
      && source.state !== "partial"
      && source.state !== "indeterminate"
  ) return fail("messaging receipt binding", "has an unsupported contract");
  const partCount = integer(source.partCount, "messaging receipt binding.partCount", 1, 8);
  const provenPartCount = integer(
    source.provenPartCount,
    "messaging receipt binding.provenPartCount",
    0,
    partCount,
  );
  const validPrefix = source.state === "submitted"
    ? provenPartCount === partCount
    : source.state === "failed"
      ? provenPartCount === 0
      : source.state === "partial"
        ? provenPartCount >= 1 && provenPartCount < partCount
        : provenPartCount < partCount;
  if (!validPrefix) {
    return fail("messaging receipt binding", "violates the proven-prefix state law");
  }
  const runId = id(source.runId, "messaging receipt binding.runId", 256);
  const normalizedWithoutReceipt = Object.freeze({
    schemaVersion: 2,
    format: "wrench.messaging-receipt-binding",
    contractId: MESSAGING_RECEIPT_BINDING_CONTRACT_ID,
    contractHash: MESSAGING_RECEIPT_BINDING_CONTRACT_HASH,
    clientIntentSha256: sha256Digest(
      source.clientIntentSha256,
      "messaging receipt binding.clientIntentSha256",
    ),
    contextBindingSha256: sha256Digest(
      source.contextBindingSha256,
      "messaging receipt binding.contextBindingSha256",
    ),
    sourceConversationCoordinateSha256: sha256Digest(
      source.sourceConversationCoordinateSha256,
      "messaging receipt binding.sourceConversationCoordinateSha256",
    ),
    routeRefSha256: sha256Digest(source.routeRefSha256, "messaging receipt binding.routeRefSha256"),
    contextRefSha256: sha256Digest(source.contextRefSha256, "messaging receipt binding.contextRefSha256"),
    turnDigest: sha256Digest(source.turnDigest, "messaging receipt binding.turnDigest"),
    previewDigest: sha256Digest(source.previewDigest, "messaging receipt binding.previewDigest"),
    runId,
    state: source.state,
    partCount,
    provenPartCount,
    recordedAt: utcTimestamp(source.recordedAt, "messaging receipt binding.recordedAt"),
  });
  const receiptSha256 = sha256Digest(
    source.receiptSha256,
    "messaging receipt binding.receiptSha256",
  );
  if (sha256(canonicalJson(normalizedWithoutReceipt)) !== receiptSha256) {
    return fail("messaging receipt binding.receiptSha256", "does not bind the canonical receipt");
  }
  return Object.freeze({
    ...normalizedWithoutReceipt,
    receiptSha256,
  });
}

export function parseMessagingReceiptBinding(
  value: unknown,
): MessagingReceiptBinding {
  const source = record(value, "messaging receipt binding");
  return source.contractId === MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID
    ? parseMessagingReceiptBindingV1(source)
    : parseMessagingReceiptBindingV2(source);
}

export declare function discoverMessagingRoutes(
  request: MessagingRoutesRequestV1,
  options?: MessagingClientOptions,
): Promise<MessagingRoutesV1>;

export declare function resolveMessagingRoute(
  request: MessagingRouteResolveRequestV1,
  options?: MessagingClientOptions,
): Promise<MessagingRouteV1>;

export declare function readMessagingContext(
  request: MessagingContextRequestV1,
  options?: MessagingClientOptions,
): Promise<MessagingContextV1>;

export declare function previewMessagingTurn(
  request: MessagingTurnV1,
  options?: MessagingClientOptions,
): Promise<MessagingPreviewV1>;
