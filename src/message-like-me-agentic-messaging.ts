import { types as nodeTypes } from "node:util";

import { canonicalJson, sha256 } from "./canonical-json";

export const MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION = 1 as const;
export const MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID =
  "wrench.message-like-me.source-conversation-coordinate.v1" as const;

export const WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT =
  "wrench.messaging-context-binding" as const;
export const WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID =
  "wrench.messaging-context-binding.v1" as const;
export const WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR = Object.freeze({
  contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
  fields: Object.freeze([
    "schemaVersion:1",
    "format:wrench.messaging-context-binding",
    "contractId:wrench.messaging-context-binding.v1",
    "contractHash:sha256",
    "sourceConversationCoordinate:{contractId,schemaVersion,sha256}",
    "routeRef:opaque",
    "contextRef:opaque",
    "exactDataRevision:sha256",
    "latestMessageRevision:sha256",
    "validatedAt:rfc3339",
    "expiresAt:rfc3339",
  ]),
  format: "wrench.messaging-contract-descriptor" as const,
  schemaVersion: 1 as const,
});
export const WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH = sha256(
  canonicalJson(WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR),
);

export const WRENCH_MESSAGING_RECEIPT_BINDING_V1_FORMAT =
  "wrench.messaging-receipt-binding" as const;
export const WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID =
  "wrench.messaging-receipt-binding.v1" as const;
export const WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR = Object.freeze({
  contractId: WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
  fields: Object.freeze([
    "schemaVersion:1",
    "format:wrench.messaging-receipt-binding",
    "contractId:wrench.messaging-receipt-binding.v1",
    "contractHash:sha256",
    "clientIntentSha256:sha256",
    "sourceConversationCoordinateSha256:sha256",
    "routeRefSha256:sha256",
    "contextRefSha256:sha256",
    "turnDigest:sha256",
    "previewDigest:sha256",
    "runId:opaque",
    "state:submitted|failed|partial|indeterminate",
    "partCount:uint",
    "provenPartCount:uint",
    "receiptSha256:sha256",
    "recordedAt:rfc3339",
  ]),
  format: "wrench.messaging-contract-descriptor" as const,
  schemaVersion: 1 as const,
});
export const WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH = sha256(
  canonicalJson(WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR),
);

export type MessageLikeMeSourceConversationCoordinateV1 = Readonly<{
  sourceAccountId: string | null;
  sourceExternalId: string;
  coordinate:
    | Readonly<{
      kind: "beeperConversation";
      network: string;
      conversationId: string;
    }>
    | Readonly<{
      kind: "imessageChat";
      chatGuid: string;
      service: string | null;
      observedChatRowId: number | null;
    }>;
}>;

export type MessageLikeMeSourceConversationCoordinateBindingV1 = Readonly<{
  contractId: typeof MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID;
  schemaVersion: typeof MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION;
  sha256: string;
}>;

export type WrenchMessagingContextBindingV1 = Readonly<{
  schemaVersion: 1;
  format: typeof WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT;
  contractId: typeof WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID;
  contractHash: string;
  sourceConversationCoordinate: MessageLikeMeSourceConversationCoordinateBindingV1;
  routeRef: string;
  contextRef: string;
  exactDataRevision: string;
  latestMessageRevision: string;
  validatedAt: string;
  expiresAt: string;
}>;

export type WrenchMessagingReceiptStateV1 =
  | "failed"
  | "indeterminate"
  | "partial"
  | "submitted";

export type WrenchMessagingReceiptBindingV1 = Readonly<{
  schemaVersion: 1;
  format: typeof WRENCH_MESSAGING_RECEIPT_BINDING_V1_FORMAT;
  contractId: typeof WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID;
  contractHash: string;
  clientIntentSha256: string;
  sourceConversationCoordinateSha256: string;
  routeRefSha256: string;
  contextRefSha256: string;
  turnDigest: string;
  previewDigest: string;
  runId: string;
  state: WrenchMessagingReceiptStateV1;
  partCount: number;
  provenPartCount: number;
  receiptSha256: string;
  recordedAt: string;
}>;

type PlainObject = Record<string, unknown>;

function fail(message: string): never {
  throw new TypeError(message);
}

function plainObject(value: unknown, label: string): PlainObject {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) return fail(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string"
      || descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label} must contain only enumerable string-keyed data properties`);
  }
  return value as PlainObject;
}

function exactKeys(value: PlainObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) return fail(`${label} must contain exactly ${sortedExpected.join(", ")}`);
}

function text(value: unknown, label: string, maximumBytes = 2_048): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value !== value.toWellFormed()
  ) return fail(`${label} must be bounded well-formed text without controls`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    return fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value
  ) return fail(`${label} must be a canonical RFC 3339 timestamp`);
  return value;
}

export function parseMessageLikeMeSourceConversationCoordinateV1(
  value: unknown,
): MessageLikeMeSourceConversationCoordinateV1 {
  const source = plainObject(value, "Message Like Me source-conversation coordinate");
  exactKeys(
    source,
    ["sourceAccountId", "sourceExternalId", "coordinate"],
    "Message Like Me source-conversation coordinate",
  );
  const sourceExternalId = text(
    source.sourceExternalId,
    "Message Like Me source-conversation coordinate.sourceExternalId",
  );
  const coordinate = plainObject(
    source.coordinate,
    "Message Like Me source-conversation coordinate.coordinate",
  );
  if (coordinate.kind === "beeperConversation") {
    exactKeys(
      coordinate,
      ["kind", "network", "conversationId"],
      "Message Like Me Beeper coordinate",
    );
    const sourceAccountId = text(
      source.sourceAccountId,
      "Message Like Me source-conversation coordinate.sourceAccountId",
    );
    if (sourceExternalId !== sourceAccountId) {
      return fail("Message Like Me Beeper source account and external identity must match");
    }
    return Object.freeze({
      sourceAccountId,
      sourceExternalId,
      coordinate: Object.freeze({
        kind: "beeperConversation" as const,
        network: text(coordinate.network, "Message Like Me Beeper coordinate.network", 512),
        conversationId: text(
          coordinate.conversationId,
          "Message Like Me Beeper coordinate.conversationId",
        ),
      }),
    });
  }
  if (coordinate.kind === "imessageChat") {
    exactKeys(
      coordinate,
      ["kind", "chatGuid", "service", "observedChatRowId"],
      "Message Like Me iMessage coordinate",
    );
    if (source.sourceAccountId !== null) {
      return fail("Message Like Me iMessage sourceAccountId must be null");
    }
    const observedChatRowId = coordinate.observedChatRowId;
    if (
      observedChatRowId !== null
      && (!Number.isSafeInteger(observedChatRowId) || observedChatRowId < 1)
    ) return fail("Message Like Me iMessage observedChatRowId must be a positive safe integer or null");
    return Object.freeze({
      sourceAccountId: null,
      sourceExternalId,
      coordinate: Object.freeze({
        kind: "imessageChat" as const,
        chatGuid: text(coordinate.chatGuid, "Message Like Me iMessage coordinate.chatGuid"),
        service: coordinate.service === null
          ? null
          : text(coordinate.service, "Message Like Me iMessage coordinate.service", 512),
        observedChatRowId,
      }),
    });
  }
  return fail("Message Like Me source-conversation coordinate has an unsupported tag");
}

export function messageLikeMeSourceConversationCoordinateBindingV1(
  value: unknown,
): MessageLikeMeSourceConversationCoordinateBindingV1 {
  const coordinate = parseMessageLikeMeSourceConversationCoordinateV1(value);
  const canonicalPreimage = Object.freeze({
    contractId: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
    schemaVersion: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION,
    value: coordinate,
  });
  return Object.freeze({
    contractId: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
    schemaVersion: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION,
    sha256: sha256(canonicalJson(canonicalPreimage)),
  });
}

export function createBeeperMessageLikeMeContextBindingV1(input: Readonly<{
  conversationRead: unknown;
  routeRef: unknown;
  contextRef: unknown;
  exactDataRevision: unknown;
  latestMessageRevision: unknown;
  validatedAt: unknown;
  expiresAt: unknown;
}>): WrenchMessagingContextBindingV1 {
  const read = plainObject(input.conversationRead, "Wrench Beeper exact conversation read");
  if (read.provider !== "beeper" || read.operation !== "conversations.read") {
    return fail("Wrench context requires an exact Beeper conversations.read projection");
  }
  const conversation = plainObject(
    read.conversation,
    "Wrench Beeper exact conversation read.conversation",
  );
  const accountId = text(
    conversation.accountId,
    "Wrench Beeper exact conversation read.conversation.accountId",
  );
  const sourceConversationCoordinate = messageLikeMeSourceConversationCoordinateBindingV1({
    sourceAccountId: accountId,
    sourceExternalId: accountId,
    coordinate: {
      kind: "beeperConversation",
      network: text(
        conversation.network,
        "Wrench Beeper exact conversation read.conversation.network",
        512,
      ),
      conversationId: text(
        conversation.id,
        "Wrench Beeper exact conversation read.conversation.id",
      ),
    },
  });
  const validatedAt = timestamp(input.validatedAt, "Wrench messaging context binding.validatedAt");
  const expiresAt = timestamp(input.expiresAt, "Wrench messaging context binding.expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(validatedAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1_000) {
    return fail("Wrench messaging context binding has an invalid lifetime");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    format: WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH,
    sourceConversationCoordinate,
    routeRef: text(input.routeRef, "Wrench messaging context binding.routeRef"),
    contextRef: text(input.contextRef, "Wrench messaging context binding.contextRef"),
    exactDataRevision: digest(
      input.exactDataRevision,
      "Wrench messaging context binding.exactDataRevision",
    ),
    latestMessageRevision: digest(
      input.latestMessageRevision,
      "Wrench messaging context binding.latestMessageRevision",
    ),
    validatedAt,
    expiresAt,
  });
}

export function createWrenchMessagingReceiptBindingV1(
  input: Omit<
    WrenchMessagingReceiptBindingV1,
    "schemaVersion" | "format" | "contractId" | "contractHash" | "receiptSha256"
  >,
): WrenchMessagingReceiptBindingV1 {
  if (
    input.state !== "submitted"
    && input.state !== "failed"
    && input.state !== "partial"
    && input.state !== "indeterminate"
  ) return fail("Wrench messaging receipt binding has an invalid state");
  if (!Number.isSafeInteger(input.partCount) || input.partCount < 1 || input.partCount > 8) {
    return fail("Wrench messaging receipt binding.partCount must be from 1 through 8");
  }
  if (
    !Number.isSafeInteger(input.provenPartCount)
    || input.provenPartCount < 0
    || input.provenPartCount > input.partCount
  ) return fail("Wrench messaging receipt binding.provenPartCount is out of range");
  if (
    (input.state === "submitted" && input.provenPartCount !== input.partCount)
    || (input.state === "failed" && input.provenPartCount !== 0)
    || (input.state === "partial"
      && (input.provenPartCount < 1 || input.provenPartCount >= input.partCount))
    || (input.state === "indeterminate" && input.provenPartCount >= input.partCount)
  ) return fail("Wrench messaging receipt binding state does not match its proven prefix");
  const core = Object.freeze({
    schemaVersion: 1 as const,
    format: WRENCH_MESSAGING_RECEIPT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
    clientIntentSha256: digest(input.clientIntentSha256, "Wrench receipt.clientIntentSha256"),
    sourceConversationCoordinateSha256: digest(
      input.sourceConversationCoordinateSha256,
      "Wrench receipt.sourceConversationCoordinateSha256",
    ),
    routeRefSha256: digest(input.routeRefSha256, "Wrench receipt.routeRefSha256"),
    contextRefSha256: digest(input.contextRefSha256, "Wrench receipt.contextRefSha256"),
    turnDigest: digest(input.turnDigest, "Wrench receipt.turnDigest"),
    previewDigest: digest(input.previewDigest, "Wrench receipt.previewDigest"),
    runId: text(input.runId, "Wrench receipt.runId", 256),
    state: input.state,
    partCount: input.partCount,
    provenPartCount: input.provenPartCount,
    recordedAt: timestamp(input.recordedAt, "Wrench receipt.recordedAt"),
  });
  return Object.freeze({
    ...core,
    receiptSha256: sha256(canonicalJson(core)),
  });
}
