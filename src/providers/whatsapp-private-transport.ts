import { createHash } from "node:crypto";

import type { OperationInput } from "../model";
import type {
  ProviderPluginMessagingActionDefinitionV1,
  ProviderPluginMessagingTargetV1,
  ProviderPluginMessagingTurnPartV1,
} from "../provider-plugin";
import { WHATSAPP_PROTOCOL_PIN, whatsappTargetJid } from "./whatsapp-web";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const NONCE_PATTERN = /^[a-f0-9]{48}$/u;
const RFC3339_NANO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const MAX_PRIVATE_MESSAGE_BYTES = 16 * 1024;
const MIN_PRIVATE_TIMEOUT_MS = 100;
const MAX_PRIVATE_TIMEOUT_MS = 45_000;

type JsonRecord = Readonly<Record<string, unknown>>;

export type WhatsAppPrivateTransportBinding = {
  readonly protocolHash: string;
  readonly toolHash: string;
  readonly storeSubject: string;
  readonly authSubject: string;
  readonly daemonPid: number;
  readonly daemonStartedAt: string;
  readonly connectionEpoch: number;
};

export type WhatsAppPrivateSendPlan = {
  readonly destinationJid: string;
  readonly bodySha256: string;
  readonly routeSha256: string;
  readonly timeoutMs: number;
  readonly stdin: string;
};

export type WhatsAppPrivateTransportResponse = {
  readonly ok: boolean;
  readonly state:
    | "submitted"
    | "idle"
    | "still_in_flight"
    | "indeterminate"
    | "failed";
  readonly reason: string | null;
  readonly binding: WhatsAppPrivateTransportBinding;
  readonly routeSha256: string | null;
  readonly requestSha256: string | null;
  readonly messageIdSha256: string | null;
  readonly committedRevision: string | null;
  readonly barrierSequence: number | null;
  readonly recordedAt: string;
};

export type WhatsAppPrivateSubmittedOutput = {
  readonly schemaVersion: 1;
  readonly format: "wrench.whatsapp-private-send-receipt";
  readonly state: "submitted";
  readonly providerMessageIdSha256: string;
  readonly routeSha256: string;
  readonly requestSha256: string;
  readonly committedRevision: string;
  readonly barrierSequence: number;
  readonly transportBinding: WhatsAppPrivateTransportBinding;
  readonly recordedAt: string;
};

export const WHATSAPP_PRIVATE_TRANSPORT_PROTOCOL = Object.freeze({
  schemaVersion: 1,
  format: "wacli.wrench-private-send",
  descriptorSha256:
    "6032c414835e4370de96718d9cc5add08e7f9f59354217e3e46d73a97d3e2ba1",
  maximumMessageBytes: MAX_PRIVATE_MESSAGE_BYTES,
  minimumTimeoutMs: MIN_PRIVATE_TIMEOUT_MS,
  maximumTimeoutMs: MAX_PRIVATE_TIMEOUT_MS,
} as const);

function plainRecord(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not have symbol properties`);
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) throw new Error(`${label}.${key} must be an enumerable data property`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} omitted ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size > 0) throw new Error(`${label} contained unsupported fields`);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.includes("\0")
  ) throw new Error(`${label} must be bounded nonempty text`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !RFC3339_NANO_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
  ) throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function privateMessageBody(value: unknown, label: string): string {
  const body = boundedString(value, label, MAX_PRIVATE_MESSAGE_BYTES);
  if (new TextEncoder().encode(body).byteLength > MAX_PRIVATE_MESSAGE_BYTES) {
    throw new Error(`${label} exceeds the private transport UTF-8 byte bound`);
  }
  if (body.trim() !== body) {
    throw new Error(
      `${label} has leading or trailing whitespace not qualified by the private transport`,
    );
  }
  return body;
}

export function planWhatsAppPrivateTextSend(
  input: OperationInput,
  timeoutMs: number,
): WhatsAppPrivateSendPlan {
  const source = plainRecord(input, "WhatsApp private send input");
  exactKeys(
    source,
    ["conversation_jid", "body"],
    [],
    "WhatsApp private send input",
  );
  const destinationJid = whatsappTargetJid(
    source.conversation_jid,
    "input.conversation_jid",
  );
  const body = privateMessageBody(source.body, "input.body");
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_PRIVATE_TIMEOUT_MS
    || timeoutMs > MAX_PRIVATE_TIMEOUT_MS
  ) {
    throw new Error(
      `WhatsApp private send timeout must be between ${MIN_PRIVATE_TIMEOUT_MS} and ${MAX_PRIVATE_TIMEOUT_MS} milliseconds`,
    );
  }
  return Object.freeze({
    destinationJid,
    bodySha256: sha256(body),
    routeSha256: sha256(destinationJid),
    timeoutMs,
    stdin: `${JSON.stringify({
      to: destinationJid,
      message: body,
      no_preview: true,
      no_retry: true,
      timeout_ms: timeoutMs,
    })}\n`,
  });
}

function parseBinding(value: unknown): WhatsAppPrivateTransportBinding {
  const source = plainRecord(value, "WhatsApp private response binding");
  exactKeys(source, [
    "protocol_hash",
    "tool_hash",
    "store_subject",
    "auth_subject",
    "daemon_pid",
    "daemon_started_at",
    "connection_epoch",
  ], [], "WhatsApp private response binding");
  const protocolHash = hash(
    source.protocol_hash,
    "WhatsApp private response binding.protocol_hash",
  );
  const toolHash = hash(
    source.tool_hash,
    "WhatsApp private response binding.tool_hash",
  );
  if (
    protocolHash !== WHATSAPP_PRIVATE_TRANSPORT_PROTOCOL.descriptorSha256
    || toolHash !== WHATSAPP_PROTOCOL_PIN.darwinArm64BinarySha256
  ) throw new Error("WhatsApp private response changed its pinned tool or protocol");
  return Object.freeze({
    protocolHash,
    toolHash,
    storeSubject: hash(
      source.store_subject,
      "WhatsApp private response binding.store_subject",
    ),
    authSubject: hash(
      source.auth_subject,
      "WhatsApp private response binding.auth_subject",
    ),
    daemonPid: positiveSafeInteger(
      source.daemon_pid,
      "WhatsApp private response binding.daemon_pid",
    ),
    daemonStartedAt: timestamp(
      source.daemon_started_at,
      "WhatsApp private response binding.daemon_started_at",
    ),
    connectionEpoch: positiveSafeInteger(
      source.connection_epoch,
      "WhatsApp private response binding.connection_epoch",
    ),
  });
}

function nullableHash(value: unknown, label: string): string | null {
  return value === undefined || value === "" ? null : hash(value, label);
}

export function parseWhatsAppPrivateTransportEnvelope(
  stdout: string,
  expectedStoreSubject: string,
): WhatsAppPrivateTransportResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new Error("WhatsApp private transport returned malformed JSON");
  }
  const envelope = plainRecord(parsed, "WhatsApp private transport envelope");
  exactKeys(
    envelope,
    ["success", "data", "error"],
    [],
    "WhatsApp private transport envelope",
  );
  if (envelope.success !== true || envelope.error !== null) {
    throw new Error("WhatsApp private transport omitted its authenticated response");
  }
  const source = plainRecord(
    envelope.data,
    "WhatsApp private transport response",
  );
  exactKeys(source, [
    "schema_version",
    "ok",
    "state",
    "binding",
    "nonce",
    "recorded_at",
    "mac",
  ], [
    "reason",
    "route_sha256",
    "request_sha256",
    "message_id_sha256",
    "committed_revision",
    "barrier_sequence",
  ], "WhatsApp private transport response");
  if (source.schema_version !== 1 || typeof source.ok !== "boolean") {
    throw new Error("WhatsApp private transport response changed schema");
  }
  if (
    typeof source.state !== "string"
    || ![
      "submitted",
      "idle",
      "still_in_flight",
      "indeterminate",
      "failed",
    ].includes(source.state)
  ) throw new Error("WhatsApp private transport response has an unsupported state");
  if (
    typeof source.nonce !== "string"
    || !NONCE_PATTERN.test(source.nonce)
    || typeof source.mac !== "string"
    || !HASH_PATTERN.test(source.mac)
  ) throw new Error("WhatsApp private transport response authentication fields are malformed");
  const binding = parseBinding(source.binding);
  const storeSubject = hash(
    expectedStoreSubject,
    "expected WhatsApp private store subject",
  );
  if (binding.storeSubject !== storeSubject) {
    throw new Error("WhatsApp private response bound another store");
  }
  const ok = source.ok;
  const state = source.state as WhatsAppPrivateTransportResponse["state"];
  if (ok !== (state === "submitted" || state === "idle")) {
    throw new Error("WhatsApp private transport response state disagrees with ok");
  }
  const reason = source.reason === undefined || source.reason === ""
    ? null
    : boundedString(
        source.reason,
        "WhatsApp private transport response.reason",
        128,
      );
  if (ok && reason !== null || !ok && reason === null) {
    throw new Error("WhatsApp private transport response reason disagrees with state");
  }
  const barrierSequence = source.barrier_sequence === undefined
    || source.barrier_sequence === 0
    ? null
    : positiveSafeInteger(
        source.barrier_sequence,
        "WhatsApp private transport response.barrier_sequence",
      );
  return Object.freeze({
    ok,
    state,
    reason,
    binding,
    routeSha256: nullableHash(
      source.route_sha256,
      "WhatsApp private transport response.route_sha256",
    ),
    requestSha256: nullableHash(
      source.request_sha256,
      "WhatsApp private transport response.request_sha256",
    ),
    messageIdSha256: nullableHash(
      source.message_id_sha256,
      "WhatsApp private transport response.message_id_sha256",
    ),
    committedRevision: nullableHash(
      source.committed_revision,
      "WhatsApp private transport response.committed_revision",
    ),
    barrierSequence,
    recordedAt: timestamp(
      source.recorded_at,
      "WhatsApp private transport response.recorded_at",
    ),
  });
}

export function submittedWhatsAppPrivateOutput(
  response: WhatsAppPrivateTransportResponse,
  plan: WhatsAppPrivateSendPlan,
): WhatsAppPrivateSubmittedOutput {
  if (
    !response.ok
    || response.state !== "submitted"
    || response.routeSha256 !== plan.routeSha256
    || response.requestSha256 === null
    || response.messageIdSha256 === null
    || response.committedRevision === null
    || response.barrierSequence === null
  ) throw new Error("WhatsApp private send omitted its complete submitted proof");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.whatsapp-private-send-receipt",
    state: "submitted",
    providerMessageIdSha256: response.messageIdSha256,
    routeSha256: response.routeSha256,
    requestSha256: response.requestSha256,
    committedRevision: response.committedRevision,
    barrierSequence: response.barrierSequence,
    transportBinding: response.binding,
    recordedAt: response.recordedAt,
  });
}

function messagingTargetJid(target: ProviderPluginMessagingTargetV1): string {
  const jid = target.conversationJid;
  if (jid === undefined) {
    throw new Error("WhatsApp messaging target omitted conversationJid");
  }
  return whatsappTargetJid(jid, "WhatsApp messaging target conversation");
}

function compileTurnPart(
  target: ProviderPluginMessagingTargetV1,
  part: ProviderPluginMessagingTurnPartV1,
): OperationInput {
  if (part.replyToProviderId !== null) {
    throw new Error("WhatsApp private text transport has not qualified replies");
  }
  return Object.freeze({
    conversation_jid: messagingTargetJid(target),
    body: privateMessageBody(part.text, "WhatsApp messaging part text"),
  });
}

function parseSubmittedOutput(value: unknown): WhatsAppPrivateSubmittedOutput {
  const source = plainRecord(value, "WhatsApp private submitted output");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "state",
    "providerMessageIdSha256",
    "routeSha256",
    "requestSha256",
    "committedRevision",
    "barrierSequence",
    "transportBinding",
    "recordedAt",
  ], [], "WhatsApp private submitted output");
  if (
    source.schemaVersion !== 1
    || source.format !== "wrench.whatsapp-private-send-receipt"
    || source.state !== "submitted"
  ) throw new Error("WhatsApp private submitted output changed schema");
  const rawBinding = plainRecord(
    source.transportBinding,
    "WhatsApp private submitted output.transportBinding",
  );
  exactKeys(rawBinding, [
    "protocolHash",
    "toolHash",
    "storeSubject",
    "authSubject",
    "daemonPid",
    "daemonStartedAt",
    "connectionEpoch",
  ], [], "WhatsApp private submitted output.transportBinding");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.whatsapp-private-send-receipt",
    state: "submitted",
    providerMessageIdSha256: hash(
      source.providerMessageIdSha256,
      "WhatsApp private submitted output.providerMessageIdSha256",
    ),
    routeSha256: hash(
      source.routeSha256,
      "WhatsApp private submitted output.routeSha256",
    ),
    requestSha256: hash(
      source.requestSha256,
      "WhatsApp private submitted output.requestSha256",
    ),
    committedRevision: hash(
      source.committedRevision,
      "WhatsApp private submitted output.committedRevision",
    ),
    barrierSequence: positiveSafeInteger(
      source.barrierSequence,
      "WhatsApp private submitted output.barrierSequence",
    ),
    transportBinding: parseBinding(Object.freeze({
      protocol_hash: rawBinding.protocolHash,
      tool_hash: rawBinding.toolHash,
      store_subject: rawBinding.storeSubject,
      auth_subject: rawBinding.authSubject,
      daemon_pid: rawBinding.daemonPid,
      daemon_started_at: rawBinding.daemonStartedAt,
      connection_epoch: rawBinding.connectionEpoch,
    })),
    recordedAt: timestamp(
      source.recordedAt,
      "WhatsApp private submitted output.recordedAt",
    ),
  });
}

/**
 * Provider-owned generic messaging action codec for the qualified transport.
 * The registered WhatsApp descriptor keeps this candidate inactive until a
 * controlled live fixture and an exact reconciliation read close the recorded
 * qualification gaps.
 */
export const qualifiedWhatsAppPrivateMessagingAction = Object.freeze({
  state: "supported",
  operation: "messaging.send",
  reply: "unsupported",
  compileTurnPart,
  mapAcceptedResult: (output: unknown) => {
    const parsed = parseSubmittedOutput(output);
    return Object.freeze({
      state: "submitted" as const,
      providerMessageId: parsed.providerMessageIdSha256,
    });
  },
  reconciliation: (
    target: ProviderPluginMessagingTargetV1,
    accepted: { readonly state: "submitted"; readonly providerMessageId: string },
  ) => Object.freeze({
    operation: "messaging.read",
    input: Object.freeze({
      conversation_jid: messagingTargetJid(target),
      accepted_message_id_sha256: hash(
        accepted.providerMessageId,
        "WhatsApp accepted message ID",
      ),
      limit: 200,
    }),
  }),
} satisfies Extract<ProviderPluginMessagingActionDefinitionV1, { state: "supported" }>);
