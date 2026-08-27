import { canonicalJson, sha256 } from "../canonical-json";
import type { OperationInput } from "../model";
import type { MessagingRouteCoordinateV1 } from "../messaging-types";
import type { ProviderMessageV1 } from "../omni-model";
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
  imsgMessageProviderId,
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

function positiveNumericRowId(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) throw new Error(`${label} must be a positive row ID`);
  return value;
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

function exactConversationFromOutput(output: unknown) {
  const envelope = record(output, "direct iMessage exact conversation output");
  const rawConversation = record(
    envelope.conversation,
    "direct iMessage exact conversation output conversation",
  );
  if (rawConversation.service !== IMSG_SERVICE) {
    throw new Error("direct iMessage exact conversation changed service");
  }
  return materializeImsgExactConversation(Object.freeze({
    chat_guid: boundedImsgString(
      rawConversation.guid,
      "direct iMessage exact conversation GUID",
      2_048,
    ),
    service: IMSG_SERVICE,
    observed_chat_row_id: positiveNumericRowId(
      rawConversation.id,
      "direct iMessage exact conversation row ID",
    ),
  }), output);
}

function rawImsgMessageGuid(providerId: string): string {
  const prefix = "imessage:message:";
  if (!providerId.startsWith(prefix)) {
    throw new Error("iMessage message provider ID is malformed");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(providerId.slice(prefix.length), "base64url").toString("utf8");
  } catch {
    throw new Error("iMessage message provider ID is malformed");
  }
  if (imsgMessageProviderId(decoded) !== providerId) {
    throw new Error("iMessage message provider ID is noncanonical");
  }
  return boundedImsgString(decoded, "iMessage message GUID", 2_048);
}

function canonicalMessages(messages: readonly ProviderMessageV1[]): readonly ProviderMessageV1[] {
  return Object.freeze([...messages].sort((left, right) => {
    const leftKey = `${left.orderedAt ?? ""}\0${left.providerId}`;
    const rightKey = `${right.orderedAt ?? ""}\0${right.providerId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }));
}

function exactAcceptedMessage(
  message: ProviderMessageV1,
  expected: {
    readonly providerMessageId: string;
    readonly providerRevision: string | null;
    readonly direction: "outgoing";
    readonly bodySha256: string;
    readonly replyToProviderId: string | null;
  },
): boolean {
  return message.providerId === expected.providerMessageId
    && message.providerRevision === expected.providerRevision
    && message.direction === "outgoing"
    && message.state === "active"
    && message.subject === null
    && message.body !== null
    && message.bodyTruncated !== true
    && sha256(message.body) === expected.bodySha256
    && expected.replyToProviderId === null
    && message.replyToProviderId === null
    && message.attachments.length === 0;
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
        // The chat row's last-message timestamp changes after every send. Route
        // identity is the exact GUID, row ID, service, and participant set.
        providerRevision: null,
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
        providerRevision: null,
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
    livePreflight: Object.freeze({
      operation: "conversations.read",
      input: (target: ProviderPluginMessagingTargetV1) => {
        const parsed = parseImsgMessagingTarget(target);
        return Object.freeze({
          chat_guid: targetField(parsed, "chatGuid"),
          service: targetField(parsed, "service"),
          observed_chat_row_id: positiveRowId(
            targetField(parsed, "observedChatRowId"),
            "iMessage live preflight row ID",
          ),
        });
      },
      snapshot: (output: unknown) => {
        const entity = exactConversationFromOutput(output);
        return Object.freeze({
          conversationProviderId: entity.providerId,
          participantFingerprint: sha256(canonicalJson(entity.participants)),
          providerRevision: null,
        });
      },
    }),
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
        providerMessageId: imsgMessageProviderId(messageGuid),
        providerRevision: `${source.messageRowId}:${messageGuid}`,
      });
    },
    proveExpectedOwnPrefix: ({ base, current, accepted }) => {
      if (
        base.contextLimit < 1
        || base.contextLimit > 200
        || base.messages.length > base.contextLimit
      ) return Object.freeze({ state: "drift" as const });
      const baseIds = base.messages.map((message) => message.providerMessageId);
      const acceptedIds = accepted.map((message) => message.providerMessageId);
      if (
        new Set(baseIds).size !== baseIds.length
        || new Set(acceptedIds).size !== acceptedIds.length
        || acceptedIds.some((id) => baseIds.includes(id))
      ) return Object.freeze({ state: "drift" as const });
      const currentMessages = canonicalMessages(current.messages);
      const currentIds = currentMessages.map((message) => message.providerId);
      if (new Set(currentIds).size !== currentIds.length) {
        return Object.freeze({ state: "drift" as const });
      }
      const baseById = new Map(base.messages.map((message) => [
        message.providerMessageId,
        message,
      ]));
      const acceptedById = new Map(accepted.map((message) => [
        message.providerMessageId,
        message,
      ]));
      const exactBaseWindow = currentIds.length === baseIds.length
        && currentIds.every((id, index) => id === baseIds[index])
        && currentMessages.every((message) => {
          const expected = baseById.get(message.providerId);
          return expected !== undefined
            && message.providerRevision === expected.providerRevision
            && message.orderedAt === expected.orderedAt
            && sha256(canonicalJson(message)) === expected.messageSha256;
        });
      if (
        exactBaseWindow
        && current.exactDataRevision === base.exactDataRevision
        && current.latestMessageRevision === base.latestMessageRevision
      ) return Object.freeze({
        state: "proven" as const,
        matchedAcceptedPrefixCount: 0,
      });
      let visibleAcceptedCount = 0;
      for (let count = 1; count <= accepted.length; count += 1) {
        const visibleIds = [...baseIds, ...acceptedIds.slice(0, count)];
        const expectedWindow = visibleIds.slice(
          Math.max(0, visibleIds.length - base.contextLimit),
        );
        if (
          currentIds.length === expectedWindow.length
          && currentIds.every((id, index) => id === expectedWindow[index])
        ) {
          visibleAcceptedCount = count;
          break;
        }
      }
      if (
        visibleAcceptedCount === 0
        || current.exactDataRevision === base.exactDataRevision
        || current.latestMessageRevision === base.latestMessageRevision
      ) return Object.freeze({ state: "drift" as const });
      for (const message of currentMessages) {
        const baseMessage = baseById.get(message.providerId);
        if (baseMessage !== undefined) {
          if (
            message.providerRevision !== baseMessage.providerRevision
            || message.orderedAt !== baseMessage.orderedAt
            || sha256(canonicalJson(message)) !== baseMessage.messageSha256
          ) return Object.freeze({ state: "drift" as const });
          continue;
        }
        const expected = acceptedById.get(message.providerId);
        if (expected === undefined || !exactAcceptedMessage(message, expected)) {
          return Object.freeze({ state: "drift" as const });
        }
      }
      return Object.freeze({
        state: "proven" as const,
        matchedAcceptedPrefixCount: visibleAcceptedCount,
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
          message_guid: rawImsgMessageGuid(accepted.providerMessageId),
        }),
      });
    },
  }),
} satisfies ProviderPluginMessagingDefinitionV1);
