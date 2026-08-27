import type { OperationInput } from "../model";
import type { MessagingRouteCoordinateV1 } from "../messaging-types";
import type {
  ProviderPluginMessagingDefinitionV1,
  ProviderPluginMessagingTargetV1,
} from "../provider-plugin";
import {
  IMSG_ACCOUNT_SELECTION,
  IMSG_SERVICE,
  IMSG_SMS_FALLBACK,
  IMSG_TRANSPORT,
  boundedImsgString,
  parseImsgDirectOperationInput,
} from "./imessage-direct";
import {
  imsgConversationProviderId,
  materializeImsgExactConversation,
} from "./imessage-direct-omni";

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error(`${label} must not contain symbol fields`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must contain only enumerable data fields`);
    }
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new Error(`${label} has unsupported fields`);
}

function positiveRowId(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive decimal row ID`);
  }
  return parsed;
}

function targetField(
  target: ProviderPluginMessagingTargetV1,
  key: "chatGuid" | "service" | "observedChatRowId",
): string {
  const value = target[key];
  if (value === undefined) throw new Error("iMessage target changed after parsing");
  return value;
}

export function parseImsgMessagingTarget(
  value: unknown,
): ProviderPluginMessagingTargetV1 {
  const source = record(value, "iMessage messaging target");
  exactKeys(
    source,
    ["chatGuid", "service", "observedChatRowId"],
    "iMessage messaging target",
  );
  if (source.service !== IMSG_SERVICE) {
    throw new Error("iMessage messaging target service must be exactly iMessage");
  }
  const observedChatRowId = positiveRowId(
    source.observedChatRowId,
    "iMessage messaging target row ID",
  );
  return Object.freeze({
    chatGuid: boundedImsgString(
      source.chatGuid,
      "iMessage messaging target chat GUID",
      2_048,
    ),
    service: IMSG_SERVICE,
    observedChatRowId: String(observedChatRowId),
  });
}

function decodeConversationGuid(providerId: string): string {
  const prefix = "imessage:chat:";
  if (!providerId.startsWith(prefix)) {
    throw new Error("iMessage conversation provider ID is malformed");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(providerId.slice(prefix.length), "base64url").toString("utf8");
  } catch {
    throw new Error("iMessage conversation provider ID is malformed");
  }
  if (imsgConversationProviderId(decoded) !== providerId) {
    throw new Error("iMessage conversation provider ID is noncanonical");
  }
  return boundedImsgString(decoded, "iMessage conversation GUID", 2_048);
}

function rowIdFromRevision(revision: string | null): number {
  if (revision === null) throw new Error("iMessage conversation lacks a live row revision");
  const separator = revision.indexOf(":");
  if (separator < 1) throw new Error("iMessage conversation row revision is malformed");
  return positiveRowId(revision.slice(0, separator), "iMessage conversation row revision");
}

export const imsgDirectMessagingDefinition = Object.freeze({
  schemaVersion: 1,
  contractId: "wrench.provider-messaging.imessage-direct.v1",
  network: "imessage",
  contextLiveness: "fresh-as-of-live-preflight",
  listOperation: "messaging.list",
  contextOperation: "messaging.read",
  coordinateKind: "imessageChat",
  enumerateRoutes: (_input: OperationInput, page) => Object.freeze(
    page.entities.map((entity) => {
      if (entity.kind !== "conversation") {
        throw new Error("iMessage route projection contained a non-conversation");
      }
      const chatGuid = decodeConversationGuid(entity.providerId);
      const observedChatRowId = rowIdFromRevision(entity.providerRevision);
      return Object.freeze({
        target: Object.freeze({
          chatGuid,
          service: IMSG_SERVICE,
          observedChatRowId: String(observedChatRowId),
        }),
        conversationProviderId: entity.providerId,
        conversationKind: entity.participants.length > 1
          ? "group" as const
          : "unknown" as const,
        title: entity.title,
        participants: entity.participants,
        providerRevision: entity.providerRevision,
      });
    }),
  ),
  resolveRoute: Object.freeze({
    operation: "conversations.read",
    input: (_listInput: OperationInput, coordinate: MessagingRouteCoordinateV1) => {
      if (
        coordinate.kind !== "imessageChat"
        || coordinate.service !== IMSG_SERVICE
        || coordinate.observedChatRowId === null
      ) throw new Error("direct iMessage resolution requires an exact iMessage chat coordinate");
      return Object.freeze({
        chat_guid: boundedImsgString(
          coordinate.chatGuid,
          "direct iMessage route chat GUID",
          2_048,
        ),
        service: IMSG_SERVICE,
        observed_chat_row_id: coordinate.observedChatRowId,
      });
    },
    candidates: (_listInput, coordinate, output) => {
      if (
        coordinate.kind !== "imessageChat"
        || coordinate.service !== IMSG_SERVICE
        || coordinate.observedChatRowId === null
      ) throw new Error("direct iMessage route coordinate changed during resolution");
      const input = Object.freeze({
        chat_guid: coordinate.chatGuid,
        service: IMSG_SERVICE,
        observed_chat_row_id: coordinate.observedChatRowId,
      });
      const entity = materializeImsgExactConversation(input, output);
      return Object.freeze([Object.freeze({
        target: Object.freeze({
          chatGuid: coordinate.chatGuid,
          service: IMSG_SERVICE,
          observedChatRowId: String(coordinate.observedChatRowId),
        }),
        conversationProviderId: entity.providerId,
        conversationKind: entity.participants.length > 1
          ? "group" as const
          : "unknown" as const,
        title: entity.title,
        participants: entity.participants,
        providerRevision: entity.providerRevision,
      })]);
    },
  }),
  parseTarget: parseImsgMessagingTarget,
  contextInput: (target, limit) => {
    const parsed = parseImsgMessagingTarget(target);
    return Object.freeze({
      chat_guid: targetField(parsed, "chatGuid"),
      service: targetField(parsed, "service"),
      observed_chat_row_id: positiveRowId(
        targetField(parsed, "observedChatRowId"),
        "iMessage context row ID",
      ),
      limit,
    });
  },
  action: Object.freeze({
    state: "supported",
    operation: "messaging.send",
    reply: "unsupported",
    compileTurnPart: (target, part) => {
      if (part.replyToProviderId !== null) {
        throw new Error("AppleScript iMessage transport does not support threaded replies");
      }
      const parsed = parseImsgMessagingTarget(target);
      const input = Object.freeze({
        chat_guid: targetField(parsed, "chatGuid"),
        service: targetField(parsed, "service"),
        observed_chat_row_id: positiveRowId(
          targetField(parsed, "observedChatRowId"),
          "iMessage send row ID",
        ),
        text: part.text,
      });
      parseImsgDirectOperationInput("messaging.send", input);
      return input;
    },
    mapAcceptedResult: (output) => {
      const source = record(output, "direct iMessage accepted result");
      exactKeys(source, [
        "provider",
        "operation",
        "accountSelection",
        "service",
        "transport",
        "smsFallback",
        "transportOutcome",
        "acceptanceEvidence",
        "chatGuid",
        "chatRowId",
        "messageGuid",
        "messageRowId",
      ], "direct iMessage accepted result");
      if (
        source.provider !== "imessage"
        || source.operation !== "messaging.send"
        || source.accountSelection !== IMSG_ACCOUNT_SELECTION
        || source.service !== IMSG_SERVICE
        || source.transport !== IMSG_TRANSPORT
        || source.smsFallback !== IMSG_SMS_FALLBACK
        || source.transportOutcome !== "accepted"
        || source.acceptanceEvidence !== "matching-outgoing-chat-db-row"
      ) throw new Error("direct iMessage send lacks exact accepted evidence");
      const messageGuid = boundedImsgString(
        source.messageGuid,
        "direct iMessage accepted message GUID",
        2_048,
      );
      if (
        typeof source.messageRowId !== "number"
        || !Number.isSafeInteger(source.messageRowId)
        || source.messageRowId < 1
      ) throw new Error("direct iMessage accepted message row is malformed");
      return Object.freeze({
        state: "submitted" as const,
        providerMessageId: messageGuid,
        providerRevision: `${source.messageRowId}:${messageGuid}`,
      });
    },
    reconciliation: (target, accepted) => {
      const parsed = parseImsgMessagingTarget(target);
      return Object.freeze({
        operation: "messaging.delivery.read",
        input: Object.freeze({
          chat_guid: targetField(parsed, "chatGuid"),
          service: targetField(parsed, "service"),
          observed_chat_row_id: positiveRowId(
            targetField(parsed, "observedChatRowId"),
            "iMessage reconciliation row ID",
          ),
          message_guid: accepted.providerMessageId,
        }),
      });
    },
  }),
} satisfies ProviderPluginMessagingDefinitionV1);
