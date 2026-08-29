// @bun
import {
  canonicalJson,
  sha256
} from "./index-dqv16dt0.js";

// src/message-like-me-agentic-messaging.ts
import { types as nodeTypes } from "util";
var MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION = 1;
var MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID = "wrench.message-like-me.source-conversation-coordinate.v1";
var WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT = "wrench.messaging-context-binding";
var WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID = "wrench.messaging-context-binding.v1";
var WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR = Object.freeze({
  contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
  fields: Object.freeze([
    "schemaVersion:1",
    "format:wrench.messaging-context-binding",
    "contractId:wrench.messaging-context-binding.v1",
    "contractHash:sha256",
    "routeRef:opaque",
    "contextRef:opaque",
    "exactDataRevision:sha256",
    "latestMessageRevision:sha256",
    "validatedAt:rfc3339",
    "expiresAt:rfc3339"
  ]),
  format: "wrench.messaging-contract-descriptor",
  schemaVersion: 1
});
var WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH = "5e64da6a3d826e7f6fa3db7dca0a4ba92c10cfb784981e71a25aed9513a5c687";
var WRENCH_MESSAGING_RECEIPT_BINDING_V1_FORMAT = "wrench.messaging-receipt-binding";
var WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID = "wrench.messaging-receipt-binding.v1";
var WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR = Object.freeze({
  contractId: WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
  fields: Object.freeze([
    "schemaVersion:1",
    "format:wrench.messaging-receipt-binding",
    "contractId:wrench.messaging-receipt-binding.v1",
    "contractHash:sha256",
    "clientIntentSha256:sha256",
    "routeRefSha256:sha256",
    "contextRefSha256:sha256",
    "turnDigest:sha256",
    "previewDigest:sha256",
    "runId:opaque",
    "state:submitted|failed|partial|indeterminate",
    "partCount:uint",
    "provenPartCount:uint",
    "receiptSha256:sha256",
    "recordedAt:rfc3339"
  ]),
  format: "wrench.messaging-contract-descriptor",
  schemaVersion: 1
});
var WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH = "7f6cf724f0200b2399e4f4641c637b20b48914fc5c9b13755127a8ec69fe66f4";
var WRENCH_MESSAGING_CONTEXT_BINDING_V2_FORMAT = "wrench.messaging-context-binding";
var WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID = "wrench.messaging-context-binding.v2";
var WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR = Object.freeze({
  contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID,
  fields: Object.freeze([
    "schemaVersion:2",
    "format:wrench.messaging-context-binding",
    "contractId:wrench.messaging-context-binding.v2",
    "contractHash:sha256",
    "sourceConversationCoordinate:{contractId,schemaVersion,sha256}",
    "routeRef:opaque",
    "contextRef:opaque",
    "exactDataRevision:sha256",
    "latestMessageRevision:sha256",
    "validatedAt:rfc3339",
    "expiresAt:rfc3339"
  ]),
  format: "wrench.messaging-contract-descriptor",
  schemaVersion: 2
});
var WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH = sha256(canonicalJson(WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR));
var WRENCH_MESSAGING_RECEIPT_BINDING_V2_FORMAT = "wrench.messaging-receipt-binding";
var WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID = "wrench.messaging-receipt-binding.v2";
var WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR = Object.freeze({
  contractId: WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID,
  fields: Object.freeze([
    "schemaVersion:2",
    "format:wrench.messaging-receipt-binding",
    "contractId:wrench.messaging-receipt-binding.v2",
    "contractHash:sha256",
    "clientIntentSha256:sha256",
    "contextBindingSha256:sha256",
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
    "recordedAt:rfc3339"
  ]),
  format: "wrench.messaging-contract-descriptor",
  schemaVersion: 2
});
var WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH = sha256(canonicalJson(WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR));
var WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT = "wrench.messaging-client-intent-binding";
var WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID = "wrench.messaging-client-intent-binding.v1";
var WRENCH_MESSAGING_CONTEXT_INSTANCE_V1_CONTRACT_ID = "wrench.messaging-context-instance.v1";
var WRENCH_MESSAGING_CONTEXT_INSTANCE_V2_CONTRACT_ID = "wrench.messaging-context-instance.v2";
function fail(message) {
  throw new TypeError(message);
}
function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return fail(`${label} must contain only enumerable string-keyed data properties`);
  }
  return value;
}
function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index]))
    return fail(`${label} must contain exactly ${sortedExpected.join(", ")}`);
}
function isWellFormedUnicode(value) {
  for (let index = 0;index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 56320 && next <= 57343))
        return false;
      index += 1;
    } else if (unit >= 56320 && unit <= 57343) {
      return false;
    }
  }
  return true;
}
function text(value, label, maximumBytes = 1024) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes || /\p{Cc}|\p{Zl}|\p{Zp}/u.test(value) || value !== value.trim() || !isWellFormedUnicode(value))
    return fail(`${label} must be bounded well-formed text without controls or surrounding space`);
  return value;
}
function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    return fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}
function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value)
    return fail(`${label} must be a canonical RFC 3339 timestamp`);
  return value;
}
function legacyTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) || !Number.isFinite(Date.parse(value)))
    return fail(`${label} must be an RFC 3339 UTC timestamp`);
  return value;
}
function parseMessageLikeMeSourceConversationCoordinateV1(value) {
  const source = plainObject(value, "Message Like Me source-conversation coordinate");
  exactKeys(source, ["sourceAccountId", "sourceExternalId", "coordinate"], "Message Like Me source-conversation coordinate");
  const sourceExternalId = text(source.sourceExternalId, "Message Like Me source-conversation coordinate.sourceExternalId");
  const coordinate = plainObject(source.coordinate, "Message Like Me source-conversation coordinate.coordinate");
  if (coordinate.kind === "beeperConversation") {
    exactKeys(coordinate, ["kind", "network", "conversationId"], "Message Like Me Beeper coordinate");
    const sourceAccountId = text(source.sourceAccountId, "Message Like Me source-conversation coordinate.sourceAccountId");
    if (sourceExternalId !== sourceAccountId) {
      return fail("Message Like Me Beeper source account and external identity must match");
    }
    return Object.freeze({
      sourceAccountId,
      sourceExternalId,
      coordinate: Object.freeze({
        kind: "beeperConversation",
        network: text(coordinate.network, "Message Like Me Beeper coordinate.network", 512),
        conversationId: text(coordinate.conversationId, "Message Like Me Beeper coordinate.conversationId")
      })
    });
  }
  if (coordinate.kind === "imessageChat") {
    exactKeys(coordinate, ["kind", "chatGuid", "service", "observedChatRowId"], "Message Like Me iMessage coordinate");
    if (source.sourceAccountId !== null) {
      return fail("Message Like Me iMessage sourceAccountId must be null");
    }
    let observedChatRowId;
    if (coordinate.observedChatRowId === null) {
      observedChatRowId = null;
    } else if (typeof coordinate.observedChatRowId === "number" && Number.isFinite(coordinate.observedChatRowId) && Number.isSafeInteger(coordinate.observedChatRowId) && coordinate.observedChatRowId >= 1) {
      observedChatRowId = coordinate.observedChatRowId;
    } else {
      return fail("Message Like Me iMessage observedChatRowId must be a positive safe integer or null");
    }
    return Object.freeze({
      sourceAccountId: null,
      sourceExternalId,
      coordinate: Object.freeze({
        kind: "imessageChat",
        chatGuid: text(coordinate.chatGuid, "Message Like Me iMessage coordinate.chatGuid"),
        service: coordinate.service === null ? null : text(coordinate.service, "Message Like Me iMessage coordinate.service", 512),
        observedChatRowId
      })
    });
  }
  return fail("Message Like Me source-conversation coordinate has an unsupported tag");
}
function messageLikeMeSourceConversationCoordinateBindingV1(value) {
  const coordinate = parseMessageLikeMeSourceConversationCoordinateV1(value);
  const canonicalPreimage = Object.freeze({
    contractId: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
    schemaVersion: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION,
    value: coordinate
  });
  return Object.freeze({
    contractId: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
    schemaVersion: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION,
    sha256: sha256(canonicalJson(canonicalPreimage))
  });
}
function parseMessageLikeMeSourceConversationCoordinateBindingV1(value) {
  const binding = plainObject(value, "Wrench source-conversation coordinate binding");
  exactKeys(binding, ["contractId", "schemaVersion", "sha256"], "Wrench source-conversation coordinate binding");
  if (binding.contractId !== MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID || binding.schemaVersion !== MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION)
    return fail("Wrench source-conversation coordinate binding has an unsupported contract identity");
  return Object.freeze({
    contractId: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
    schemaVersion: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION,
    sha256: digest(binding.sha256, "Wrench source-conversation coordinate binding.sha256")
  });
}
function parseWrenchMessagingContextBindingV1(value) {
  const context = plainObject(value, "Wrench messaging context binding V1");
  exactKeys(context, [
    "schemaVersion",
    "format",
    "contractId",
    "contractHash",
    "routeRef",
    "contextRef",
    "exactDataRevision",
    "latestMessageRevision",
    "validatedAt",
    "expiresAt"
  ], "Wrench messaging context binding V1");
  if (context.schemaVersion !== 1 || context.format !== WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT || context.contractId !== WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID || context.contractHash !== WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH)
    return fail("Wrench messaging context binding V1 has an unsupported contract identity");
  const validatedAt = legacyTimestamp(context.validatedAt, "Wrench messaging context binding V1.validatedAt");
  const expiresAt = legacyTimestamp(context.expiresAt, "Wrench messaging context binding V1.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(validatedAt)) {
    return fail("Wrench messaging context binding V1.expiresAt must follow validatedAt");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH,
    routeRef: text(context.routeRef, "Wrench messaging context binding V1.routeRef", 2048),
    contextRef: text(context.contextRef, "Wrench messaging context binding V1.contextRef", 2048),
    exactDataRevision: digest(context.exactDataRevision, "Wrench messaging context binding V1.exactDataRevision"),
    latestMessageRevision: digest(context.latestMessageRevision, "Wrench messaging context binding V1.latestMessageRevision"),
    validatedAt,
    expiresAt
  });
}
function parseWrenchMessagingContextBindingV2(value) {
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
    "expiresAt"
  ], "Wrench messaging context binding");
  if (context.schemaVersion !== 2 || context.format !== WRENCH_MESSAGING_CONTEXT_BINDING_V2_FORMAT || context.contractId !== WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID || context.contractHash !== WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH)
    return fail("Wrench messaging context binding has an unsupported contract identity");
  const validatedAt = timestamp(context.validatedAt, "Wrench messaging context binding.validatedAt");
  const expiresAt = timestamp(context.expiresAt, "Wrench messaging context binding.expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(validatedAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1000) {
    return fail("Wrench messaging context binding has an invalid lifetime");
  }
  return Object.freeze({
    schemaVersion: 2,
    format: WRENCH_MESSAGING_CONTEXT_BINDING_V2_FORMAT,
    contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH,
    sourceConversationCoordinate: parseMessageLikeMeSourceConversationCoordinateBindingV1(context.sourceConversationCoordinate),
    routeRef: text(context.routeRef, "Wrench messaging context binding.routeRef", 2048),
    contextRef: text(context.contextRef, "Wrench messaging context binding.contextRef", 2048),
    exactDataRevision: digest(context.exactDataRevision, "Wrench messaging context binding.exactDataRevision"),
    latestMessageRevision: digest(context.latestMessageRevision, "Wrench messaging context binding.latestMessageRevision"),
    validatedAt,
    expiresAt
  });
}
function wrenchMessagingContextBindingSha256V1(value) {
  const context = parseWrenchMessagingContextBindingV1(value);
  return sha256(canonicalJson({
    contractId: WRENCH_MESSAGING_CONTEXT_INSTANCE_V1_CONTRACT_ID,
    schemaVersion: 1,
    value: context
  }));
}
function parsedContextBindingSha256V2(context) {
  return sha256(canonicalJson({
    contractId: WRENCH_MESSAGING_CONTEXT_INSTANCE_V2_CONTRACT_ID,
    schemaVersion: 2,
    value: context
  }));
}
function wrenchMessagingContextBindingSha256V2(value) {
  return parsedContextBindingSha256V2(parseWrenchMessagingContextBindingV2(value));
}
var BEEPER_EXACT_CONVERSATION_KEYS = Object.freeze([
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
  "participants"
]);
function createBeeperMessageLikeMeSourceConversationCoordinateBindingV1(input) {
  const read = plainObject(input.conversationRead, "Wrench Beeper exact conversation read");
  exactKeys(read, ["provider", "operation", "accountSubject", "conversation"], "Wrench Beeper exact conversation read");
  if (read.provider !== "beeper" || read.operation !== "conversations.read") {
    return fail("Wrench context requires an exact Beeper conversations.read projection");
  }
  const expectedAccountSubject = text(input.expectedAccountSubject, "Wrench Beeper expected account subject");
  if (text(read.accountSubject, "Wrench Beeper exact conversation read.accountSubject") !== expectedAccountSubject)
    return fail("Wrench Beeper exact conversation read did not bind the expected account subject");
  const conversation = plainObject(read.conversation, "Wrench Beeper exact conversation read.conversation");
  exactKeys(conversation, BEEPER_EXACT_CONVERSATION_KEYS, "Wrench Beeper exact conversation read.conversation");
  if (conversation.type !== "single") {
    return fail("Wrench Message Like Me context requires a direct Beeper conversation");
  }
  if (conversation.isReadOnly !== false) {
    return fail("Wrench Message Like Me context requires a writable Beeper conversation");
  }
  const accountId = text(conversation.accountId, "Wrench Beeper exact conversation read.conversation.accountId");
  return messageLikeMeSourceConversationCoordinateBindingV1({
    sourceAccountId: accountId,
    sourceExternalId: accountId,
    coordinate: {
      kind: "beeperConversation",
      network: text(conversation.network, "Wrench Beeper exact conversation read.conversation.network", 512),
      conversationId: text(conversation.id, "Wrench Beeper exact conversation read.conversation.id")
    }
  });
}
function createBeeperMessageLikeMeContextBindingV1(input) {
  createBeeperMessageLikeMeSourceConversationCoordinateBindingV1({
    conversationRead: input.conversationRead,
    expectedAccountSubject: input.expectedAccountSubject
  });
  return parseWrenchMessagingContextBindingV1(Object.freeze({
    schemaVersion: 1,
    format: WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH,
    routeRef: text(input.routeRef, "Wrench messaging context binding V1.routeRef", 2048),
    contextRef: text(input.contextRef, "Wrench messaging context binding V1.contextRef", 2048),
    exactDataRevision: digest(input.exactDataRevision, "Wrench messaging context binding V1.exactDataRevision"),
    latestMessageRevision: digest(input.latestMessageRevision, "Wrench messaging context binding V1.latestMessageRevision"),
    validatedAt: input.validatedAt,
    expiresAt: input.expiresAt
  }));
}
function createBeeperMessageLikeMeContextBindingV2(input) {
  const sourceConversationCoordinate = createBeeperMessageLikeMeSourceConversationCoordinateBindingV1({
    conversationRead: input.conversationRead,
    expectedAccountSubject: input.expectedAccountSubject
  });
  return parseWrenchMessagingContextBindingV2(Object.freeze({
    schemaVersion: 2,
    format: WRENCH_MESSAGING_CONTEXT_BINDING_V2_FORMAT,
    contractId: WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH,
    sourceConversationCoordinate,
    routeRef: text(input.routeRef, "Wrench messaging context binding.routeRef", 2048),
    contextRef: text(input.contextRef, "Wrench messaging context binding.contextRef", 2048),
    exactDataRevision: digest(input.exactDataRevision, "Wrench messaging context binding.exactDataRevision"),
    latestMessageRevision: digest(input.latestMessageRevision, "Wrench messaging context binding.latestMessageRevision"),
    validatedAt: input.validatedAt,
    expiresAt: input.expiresAt
  }));
}
function parseWrenchMessagingClientIntentBindingV1(value, contextValue) {
  const context = parseWrenchMessagingContextBindingV2(contextValue);
  const intent = plainObject(value, "Wrench messaging client-intent binding");
  exactKeys(intent, [
    "schemaVersion",
    "format",
    "contractId",
    "clientIntentSha256",
    "contextBindingSha256",
    "sourceConversationCoordinateSha256",
    "routeRefSha256",
    "contextRefSha256",
    "turnDigest",
    "partCount"
  ], "Wrench messaging client-intent binding");
  if (intent.schemaVersion !== 1 || intent.format !== WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT || intent.contractId !== WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID)
    return fail("Wrench messaging client-intent binding has an unsupported contract identity");
  if (!Number.isSafeInteger(intent.partCount) || intent.partCount < 1 || intent.partCount > 8) {
    return fail("Wrench messaging client-intent binding.partCount must be from 1 through 8");
  }
  const parsed = Object.freeze({
    schemaVersion: 1,
    format: WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID,
    clientIntentSha256: digest(intent.clientIntentSha256, "Wrench messaging client-intent binding.clientIntentSha256"),
    contextBindingSha256: digest(intent.contextBindingSha256, "Wrench messaging client-intent binding.contextBindingSha256"),
    sourceConversationCoordinateSha256: digest(intent.sourceConversationCoordinateSha256, "Wrench messaging client-intent binding.sourceConversationCoordinateSha256"),
    routeRefSha256: digest(intent.routeRefSha256, "Wrench messaging client-intent binding.routeRefSha256"),
    contextRefSha256: digest(intent.contextRefSha256, "Wrench messaging client-intent binding.contextRefSha256"),
    turnDigest: digest(intent.turnDigest, "Wrench messaging client-intent binding.turnDigest"),
    partCount: intent.partCount
  });
  if (parsed.contextBindingSha256 !== parsedContextBindingSha256V2(context) || parsed.sourceConversationCoordinateSha256 !== context.sourceConversationCoordinate.sha256 || parsed.routeRefSha256 !== sha256(context.routeRef) || parsed.contextRefSha256 !== sha256(context.contextRef))
    return fail("Wrench messaging client intent does not bind the exact context instance");
  return parsed;
}
function createWrenchMessagingReceiptBindingV2(input) {
  const intent = parseWrenchMessagingClientIntentBindingV1(input.clientIntent, input.context);
  if (input.state !== "submitted" && input.state !== "failed" && input.state !== "partial" && input.state !== "indeterminate")
    return fail("Wrench messaging receipt binding has an invalid state");
  if (!Number.isSafeInteger(input.provenPartCount) || input.provenPartCount < 0 || input.provenPartCount > intent.partCount)
    return fail("Wrench messaging receipt binding.provenPartCount is out of range");
  const provenPartCount = input.provenPartCount;
  if (input.state === "submitted" && provenPartCount !== intent.partCount || input.state === "failed" && provenPartCount !== 0 || input.state === "partial" && (provenPartCount < 1 || provenPartCount >= intent.partCount) || input.state === "indeterminate" && provenPartCount >= intent.partCount)
    return fail("Wrench messaging receipt binding state does not match its proven prefix");
  const core = Object.freeze({
    schemaVersion: 2,
    format: WRENCH_MESSAGING_RECEIPT_BINDING_V2_FORMAT,
    contractId: WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH,
    clientIntentSha256: intent.clientIntentSha256,
    contextBindingSha256: intent.contextBindingSha256,
    sourceConversationCoordinateSha256: intent.sourceConversationCoordinateSha256,
    routeRefSha256: intent.routeRefSha256,
    contextRefSha256: intent.contextRefSha256,
    turnDigest: intent.turnDigest,
    previewDigest: digest(input.previewDigest, "Wrench receipt.previewDigest"),
    runId: text(input.runId, "Wrench receipt.runId", 256),
    state: input.state,
    partCount: intent.partCount,
    provenPartCount,
    recordedAt: timestamp(input.recordedAt, "Wrench receipt.recordedAt")
  });
  return Object.freeze({
    ...core,
    receiptSha256: sha256(canonicalJson(core))
  });
}
function createWrenchMessagingReceiptBindingV1(input) {
  const enriched = createWrenchMessagingReceiptBindingV2(input);
  const core = Object.freeze({
    schemaVersion: 1,
    format: WRENCH_MESSAGING_RECEIPT_BINDING_V1_FORMAT,
    contractId: WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID,
    contractHash: WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
    clientIntentSha256: enriched.clientIntentSha256,
    routeRefSha256: enriched.routeRefSha256,
    contextRefSha256: enriched.contextRefSha256,
    turnDigest: enriched.turnDigest,
    previewDigest: enriched.previewDigest,
    runId: enriched.runId,
    state: enriched.state,
    partCount: enriched.partCount,
    provenPartCount: enriched.provenPartCount,
    recordedAt: enriched.recordedAt
  });
  return Object.freeze({
    ...core,
    receiptSha256: sha256(canonicalJson(core))
  });
}

export { MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_SCHEMA_VERSION, MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID, WRENCH_MESSAGING_CONTEXT_BINDING_V1_FORMAT, WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_ID, WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR, WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH, WRENCH_MESSAGING_RECEIPT_BINDING_V1_FORMAT, WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_ID, WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR, WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH, WRENCH_MESSAGING_CONTEXT_BINDING_V2_FORMAT, WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_ID, WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_DESCRIPTOR, WRENCH_MESSAGING_CONTEXT_BINDING_V2_CONTRACT_HASH, WRENCH_MESSAGING_RECEIPT_BINDING_V2_FORMAT, WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_ID, WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_DESCRIPTOR, WRENCH_MESSAGING_RECEIPT_BINDING_V2_CONTRACT_HASH, WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT, WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID, WRENCH_MESSAGING_CONTEXT_INSTANCE_V1_CONTRACT_ID, WRENCH_MESSAGING_CONTEXT_INSTANCE_V2_CONTRACT_ID, parseMessageLikeMeSourceConversationCoordinateV1, messageLikeMeSourceConversationCoordinateBindingV1, parseWrenchMessagingContextBindingV1, parseWrenchMessagingContextBindingV2, wrenchMessagingContextBindingSha256V1, wrenchMessagingContextBindingSha256V2, createBeeperMessageLikeMeContextBindingV1, createBeeperMessageLikeMeContextBindingV2, parseWrenchMessagingClientIntentBindingV1, createWrenchMessagingReceiptBindingV2, createWrenchMessagingReceiptBindingV1 };
