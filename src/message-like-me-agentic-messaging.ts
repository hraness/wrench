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

export const WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT =
  "wrench.messaging-client-intent-binding" as const;
export const WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID =
  "wrench.messaging-client-intent-binding.v1" as const;

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

export type WrenchMessagingClientIntentBindingV1 = Readonly<{
  schemaVersion: 1;
  format: typeof WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT;
  contractId: typeof WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID;
  clientIntentSha256: string;
  sourceConversationCoordinateSha256: string;
  routeRefSha256: string;
  contextRefSha256: string;
  turnDigest: string;
  partCount: number;
}>;

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

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function text(value: unknown, label: string, maximumBytes = 2_048): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || !isWellFormedUnicode(value)
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
    let observedChatRowId: number | null;
    if (coordinate.observedChatRowId === null) {
      observedChatRowId = null;
    } else if (
      typeof coordinate.observedChatRowId === "number"
      && Number.isFinite(coordinate.observedChatRowId)
      && Number.isSafeInteger(coordinate.observedChatRowId)
      && coordinate.observedChatRowId >= 1
    ) {
      observedChatRowId = coordinate.observedChatRowId;
    } else {
      return fail("Message Like Me iMessage observedChatRowId must be a positive safe integer or null");
    }
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

function parseSourceConversationCoordinateBindingV1(
  value: unknown,
): MessageLikeMeSourceConversationCoordinateBindingV1 {
  const binding = plainObject(value, "Wrench source-conversation coordinate binding");
  exactKeys(
    binding,
    ["contractId", "schemaVersion", "sha256"],
    "Wrench source-conversation coordinate binding",
  );
  if (
    binding.contractId !== MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID
    || binding.schemaVersion !== MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION
  ) return fail("Wrench source-conversation coordinate binding has an unsupported contract identity");
  return Object.freeze({
    contractId: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
    schemaVersion: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION,
    sha256: digest(binding.sha256, "Wrench source-conversation coordinate binding.sha256"),
  });
}

export function parseWrenchMessagingContextBindingV1(
  value: unknown,
): WrenchMessagingContextBindingV1 {
  const context = plainObject(value, "Wrench messaging context binding");
  exactKeys(context, [
    "schemaVersion",
    "format",
    "contractId",
    "contractHash",
    "sourceConversationCoordinate",
    "routeRef",
    "contextRef",
    "exactDataRevision",
    "latestMessageRevision",
    "validatedAt",
    "expiresAt",
  ], "Wrench messaging context binding");
  if (
    context.schemaVersion !== 1
    || context.format !== WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT
    || context.contractId !== WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID
    || context.contractHash !== WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH
  ) return fail("Wrench messaging context binding has an unsupported contract identity");
  const validatedAt = timestamp(context.validatedAt, "Wrench messaging context binding.validatedAt");
  const expiresAt = timestamp(context.expiresAt, "Wrench messaging context binding.expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(validatedAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1_000) {
    return fail("Wrench messaging context binding has an invalid lifetime");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    format: WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH,
    sourceConversationCoordinate: parseSourceConversationCoordinateBindingV1(
      context.sourceConversationCoordinate,
    ),
    routeRef: text(context.routeRef, "Wrench messaging context binding.routeRef"),
    contextRef: text(context.contextRef, "Wrench messaging context binding.contextRef"),
    exactDataRevision: digest(
      context.exactDataRevision,
      "Wrench messaging context binding.exactDataRevision",
    ),
    latestMessageRevision: digest(
      context.latestMessageRevision,
      "Wrench messaging context binding.latestMessageRevision",
    ),
    validatedAt,
    expiresAt,
  });
}

const BEEPER_EXACT_CONVERSATION_KEYS = Object.freeze([
  "id",
  "localChatId",
  "accountId",
  "network",
  "title",
  "type",
  "description",
  "descriptionObserved",
  "hasAvatar",
  "avatarObserved",
  "lastReadMessageSortKey",
  "lastActivity",
  "unreadCount",
  "unreadMentionsCount",
  "isMarkedUnread",
  "isArchived",
  "isLowPriority",
  "isMuted",
  "isPinned",
  "isReadOnly",
  "messageExpirySeconds",
  "messageExpiryObserved",
  "draft",
  "draftObserved",
  "reminder",
  "reminderObserved",
  "participants",
]);

export function createBeeperMessageLikeMeContextBindingV1(input: Readonly<{
  conversationRead: unknown;
  expectedAccountSubject: unknown;
  routeRef: unknown;
  contextRef: unknown;
  exactDataRevision: unknown;
  latestMessageRevision: unknown;
  validatedAt: unknown;
  expiresAt: unknown;
}>): WrenchMessagingContextBindingV1 {
  const read = plainObject(input.conversationRead, "Wrench Beeper exact conversation read");
  exactKeys(
    read,
    ["provider", "operation", "accountSubject", "conversation"],
    "Wrench Beeper exact conversation read",
  );
  if (read.provider !== "beeper" || read.operation !== "conversations.read") {
    return fail("Wrench context requires an exact Beeper conversations.read projection");
  }
  const expectedAccountSubject = text(
    input.expectedAccountSubject,
    "Wrench Beeper expected account subject",
  );
  if (
    text(read.accountSubject, "Wrench Beeper exact conversation read.accountSubject")
    !== expectedAccountSubject
  ) return fail("Wrench Beeper exact conversation read did not bind the expected account subject");
  const conversation = plainObject(
    read.conversation,
    "Wrench Beeper exact conversation read.conversation",
  );
  exactKeys(
    conversation,
    BEEPER_EXACT_CONVERSATION_KEYS,
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
  return parseWrenchMessagingContextBindingV1(Object.freeze({
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
    validatedAt: input.validatedAt,
    expiresAt: input.expiresAt,
  }));
}

export function parseWrenchMessagingClientIntentBindingV1(
  value: unknown,
  contextValue: unknown,
): WrenchMessagingClientIntentBindingV1 {
  const context = parseWrenchMessagingContextBindingV1(contextValue);
  const intent = plainObject(value, "Wrench messaging client-intent binding");
  exactKeys(intent, [
    "schemaVersion",
    "format",
    "contractId",
    "clientIntentSha256",
    "sourceConversationCoordinateSha256",
    "routeRefSha256",
    "contextRefSha256",
    "turnDigest",
    "partCount",
  ], "Wrench messaging client-intent binding");
  if (
    intent.schemaVersion !== 1
    || intent.format !== WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT
    || intent.contractId !== WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID
  ) return fail("Wrench messaging client-intent binding has an unsupported contract identity");
  if (!Number.isSafeInteger(intent.partCount) || (intent.partCount as number) < 1 || (intent.partCount as number) > 8) {
    return fail("Wrench messaging client-intent binding.partCount must be from 1 through 8");
  }
  const parsed = Object.freeze({
    schemaVersion: 1 as const,
    format: WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID,
    clientIntentSha256: digest(
      intent.clientIntentSha256,
      "Wrench messaging client-intent binding.clientIntentSha256",
    ),
    sourceConversationCoordinateSha256: digest(
      intent.sourceConversationCoordinateSha256,
      "Wrench messaging client-intent binding.sourceConversationCoordinateSha256",
    ),
    routeRefSha256: digest(
      intent.routeRefSha256,
      "Wrench messaging client-intent binding.routeRefSha256",
    ),
    contextRefSha256: digest(
      intent.contextRefSha256,
      "Wrench messaging client-intent binding.contextRefSha256",
    ),
    turnDigest: digest(intent.turnDigest, "Wrench messaging client-intent binding.turnDigest"),
    partCount: intent.partCount as number,
  });
  if (
    parsed.sourceConversationCoordinateSha256
      !== context.sourceConversationCoordinate.sha256
    || parsed.routeRefSha256 !== sha256(context.routeRef)
    || parsed.contextRefSha256 !== sha256(context.contextRef)
  ) return fail("Wrench messaging client intent does not bind the exact context instance");
  return parsed;
}

export function createWrenchMessagingReceiptBindingV1(input: Readonly<{
  context: unknown;
  clientIntent: unknown;
  previewDigest: unknown;
  runId: unknown;
  state: unknown;
  provenPartCount: unknown;
  recordedAt: unknown;
}>): WrenchMessagingReceiptBindingV1 {
  const intent = parseWrenchMessagingClientIntentBindingV1(input.clientIntent, input.context);
  if (
    input.state !== "submitted"
    && input.state !== "failed"
    && input.state !== "partial"
    && input.state !== "indeterminate"
  ) return fail("Wrench messaging receipt binding has an invalid state");
  if (
    !Number.isSafeInteger(input.provenPartCount)
    || (input.provenPartCount as number) < 0
    || (input.provenPartCount as number) > intent.partCount
  ) return fail("Wrench messaging receipt binding.provenPartCount is out of range");
  const provenPartCount = input.provenPartCount as number;
  if (
    (input.state === "submitted" && provenPartCount !== intent.partCount)
    || (input.state === "failed" && provenPartCount !== 0)
    || (input.state === "partial"
      && (provenPartCount < 1 || provenPartCount >= intent.partCount))
    || (input.state === "indeterminate" && provenPartCount >= intent.partCount)
  ) return fail("Wrench messaging receipt binding state does not match its proven prefix");
  const core = Object.freeze({
    schemaVersion: 1 as const,
    format: WRENCH_MESSAGING_RECEIPT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
    clientIntentSha256: intent.clientIntentSha256,
    sourceConversationCoordinateSha256: intent.sourceConversationCoordinateSha256,
    routeRefSha256: intent.routeRefSha256,
    contextRefSha256: intent.contextRefSha256,
    turnDigest: intent.turnDigest,
    previewDigest: digest(input.previewDigest, "Wrench receipt.previewDigest"),
    runId: text(input.runId, "Wrench receipt.runId", 256),
    state: input.state,
    partCount: intent.partCount,
    provenPartCount,
    recordedAt: timestamp(input.recordedAt, "Wrench receipt.recordedAt"),
  });
  return Object.freeze({
    ...core,
    receiptSha256: sha256(canonicalJson(core)),
  });
}
