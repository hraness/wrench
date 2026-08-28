import { canonicalJson, sha256 } from "../canonical-json";
import {
  createBeeperMessageLikeMeSourceConversationCoordinateBindingV1,
} from "../message-like-me-agentic-messaging";
import type { OperationInput } from "../model";
import type { ProviderMessageV1 } from "../omni-model";
import type { MessagingRouteCoordinateV1 } from "../messaging-types";
import type {
  ProviderPluginMessagingDefinitionV1,
  ProviderPluginMessagingTargetV1,
} from "../provider-plugin";
import { parseBeeperOperationInput } from "./beeper-local";
import {
  materializeBeeperExactConversation,
  normalizeBeeperMessageProviderId,
  rawBeeperConversationId,
  rawBeeperMessageId,
} from "./beeper-omni";

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

function bounded(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

export function parseBeeperMessagingTarget(
  value: unknown,
): ProviderPluginMessagingTargetV1 {
  const source = record(value, "Beeper messaging target");
  exactKeys(source, ["accountId", "conversationId"], "Beeper messaging target");
  return Object.freeze({
    accountId: bounded(source.accountId, "Beeper messaging target account", 512),
    conversationId: bounded(
      source.conversationId,
      "Beeper messaging target conversation",
      2_048,
    ),
  });
}

function targetField(
  target: ProviderPluginMessagingTargetV1,
  key: "accountId" | "conversationId",
): string {
  const value = target[key];
  if (value === undefined) {
    throw new Error("Beeper messaging target changed after parsing");
  }
  return value;
}

function exactConversationFromOutput(output: unknown) {
  const envelope = record(output, "Beeper exact conversation output");
  exactKeys(
    envelope,
    ["provider", "operation", "accountSubject", "conversation"],
    "Beeper exact conversation output",
  );
  const rawConversation = record(
    envelope.conversation,
    "Beeper exact conversation output conversation",
  );
  const accountId = bounded(
    rawConversation.accountId,
    "Beeper exact conversation output account",
    512,
  );
  const conversationId = bounded(
    rawConversation.id,
    "Beeper exact conversation output conversation ID",
    2_048,
  );
  return materializeBeeperExactConversation(Object.freeze({
    account_id: accountId,
    conversation_id: conversationId,
    max_participants: 500,
  }), output);
}

function messageLikeMeCoordinateIfEligible(
  output: unknown,
  expectedAccountSubject: string,
) {
  const envelope = record(output, "Beeper exact conversation output");
  const rawConversation = record(
    envelope.conversation,
    "Beeper exact conversation output conversation",
  );
  if (
    rawConversation.type !== "single"
    || rawConversation.isReadOnly !== false
  ) return null;
  return createBeeperMessageLikeMeSourceConversationCoordinateBindingV1({
    conversationRead: output,
    expectedAccountSubject,
  });
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
    && message.replyToProviderId === expected.replyToProviderId
    && message.attachments.length === 0;
}

export const beeperMessagingDefinition = Object.freeze({
  schemaVersion: 1,
  contractId: "wrench.provider-messaging.beeper.v1",
  network: "beeper",
  contextLiveness: "fresh-as-of-live-preflight",
  listOperation: "messaging.list",
  contextOperation: "messaging.read",
  coordinateKind: "beeperConversation",
  enumerateRoutes: (input: OperationInput, page) => {
    const parsed = parseBeeperOperationInput("messaging.list", input);
    if (!("accountId" in parsed) || parsed.accountId === null) {
      throw new Error(
        "Beeper messaging route discovery requires one exact account_id",
      );
    }
    return Object.freeze(page.entities.map((entity) => {
      if (entity.kind !== "conversation") {
        throw new Error("Beeper messaging route projection contained a non-conversation");
      }
      return Object.freeze({
        target: Object.freeze({
          accountId: parsed.accountId as string,
          conversationId: rawBeeperConversationId(
            parsed.accountId,
            entity.providerId,
          ),
        }),
        conversationProviderId: entity.providerId,
        conversationKind: entity.conversationKind ?? "unknown",
        title: entity.title,
        participants: entity.participants,
        providerRevision: entity.providerRevision,
      });
    }));
  },
  resolveRoute: Object.freeze({
    operation: "conversations.read",
    input: (listInput: OperationInput, coordinate: MessagingRouteCoordinateV1) => {
      const parsed = parseBeeperOperationInput("messaging.list", listInput);
      if (!("accountId" in parsed) || parsed.accountId === null) {
        throw new Error("Beeper exact route resolution requires one account_id");
      }
      if (coordinate.kind !== "beeperConversation") {
        throw new Error("Beeper exact route resolution requires a Beeper coordinate");
      }
      return Object.freeze({
        account_id: parsed.accountId,
        conversation_id: bounded(
          coordinate.conversationId,
          "Beeper exact conversation candidate",
          2_048,
        ),
        max_participants: 500,
      });
    },
    candidates: (listInput, coordinate, output) => {
      const parsed = parseBeeperOperationInput("messaging.list", listInput);
      if (!("accountId" in parsed) || parsed.accountId === null) {
        throw new Error("Beeper exact route resolution lost its account_id");
      }
      if (coordinate.kind !== "beeperConversation") {
        throw new Error("Beeper exact route resolution changed coordinate kind");
      }
      const exactConversationId = bounded(
        coordinate.conversationId,
        "Beeper exact conversation candidate",
        2_048,
      );
      const envelope = record(output, "Beeper exact route output");
      const rawConversation = record(
        envelope.conversation,
        "Beeper exact route output conversation",
      );
      if (rawConversation.network !== coordinate.network) {
        throw new Error("Beeper exact route read returned another network");
      }
      const input = Object.freeze({
        account_id: parsed.accountId,
        conversation_id: exactConversationId,
        max_participants: 500,
      });
      const entity = materializeBeeperExactConversation(input, output);
      return Object.freeze([Object.freeze({
        target: Object.freeze({
          accountId: parsed.accountId,
          conversationId: exactConversationId,
        }),
        conversationProviderId: entity.providerId,
        conversationKind: rawConversation.type === "single"
          ? "single" as const
          : rawConversation.type === "group"
            ? "group" as const
            : "unknown" as const,
        title: entity.title,
        participants: entity.participants,
        providerRevision: entity.providerRevision,
      })]);
    },
    sourceConversationCoordinate: (
      _listInput,
      coordinate,
      output,
      expectedAccountSubject,
    ) => {
      if (coordinate.kind !== "beeperConversation") {
        throw new Error("Beeper exact source coordinate changed coordinate kind");
      }
      return messageLikeMeCoordinateIfEligible(output, expectedAccountSubject);
    },
  }),
  parseTarget: parseBeeperMessagingTarget,
  contextInput: (target, limit) => {
    const parsed = parseBeeperMessagingTarget(target);
    return Object.freeze({
      account_id: targetField(parsed, "accountId"),
      conversation_id: targetField(parsed, "conversationId"),
      limit,
    });
  },
  action: Object.freeze({
    state: "supported",
    operation: "messaging.send",
    reply: "supported",
    livePreflight: Object.freeze({
      operation: "conversations.read",
      input: (target: ProviderPluginMessagingTargetV1) => {
        const parsed = parseBeeperMessagingTarget(target);
        return Object.freeze({
          account_id: targetField(parsed, "accountId"),
          conversation_id: targetField(parsed, "conversationId"),
          max_participants: 500,
        });
      },
      snapshot: (output: unknown, expectedAccountSubject: string) => {
        const envelope = record(output, "Beeper exact conversation output");
        const rawConversation = record(
          envelope.conversation,
          "Beeper exact conversation output conversation",
        );
        const entity = exactConversationFromOutput(output);
        bounded(
          rawConversation.network,
          "Beeper exact conversation output network",
          64,
        );
        const sourceConversationCoordinate = messageLikeMeCoordinateIfEligible(
          output,
          expectedAccountSubject,
        );
        if (sourceConversationCoordinate === null) {
          throw new Error(
            "Beeper checked turn actions require one writable direct conversation",
          );
        }
        return Object.freeze({
          conversationProviderId: entity.providerId,
          network: "beeper",
          conversation: Object.freeze({
            kind: rawConversation.type === "single"
              ? "single" as const
              : rawConversation.type === "group"
                ? "group" as const
                : "unknown" as const,
            title: entity.title,
            participantCount: entity.participants.length,
          }),
          sourceConversationCoordinate,
          participantFingerprint: sha256(canonicalJson(entity.participants)),
          providerRevision: null,
        });
      },
    }),
    compileTurnPart: (target, part) => {
      const parsed = parseBeeperMessagingTarget(target);
      const accountId = targetField(parsed, "accountId");
      const input = Object.freeze({
        account_id: accountId,
        conversation_id: targetField(parsed, "conversationId"),
        kind: "text" as const,
        text: part.text,
        ...(part.replyToProviderId === null
          ? {}
          : { reply_to: rawBeeperMessageId(accountId, part.replyToProviderId) }),
      });
      parseBeeperOperationInput("messaging.send", input);
      return input;
    },
    mapAcceptedResult: (output: unknown) => {
      const source = record(output, "Beeper direct messaging acceptance");
      exactKeys(source, [
        "provider",
        "operation",
        "accountSubject",
        "accountId",
        "conversationId",
        "pendingMessageId",
        "providerRevision",
      ], "Beeper direct messaging acceptance");
      if (
        source.provider !== "beeper"
        || source.operation !== "messaging.send"
        || source.providerRevision !== null
        || typeof source.accountSubject !== "string"
        || !/^beeper:local:[a-f0-9]{64}$/u.test(source.accountSubject)
      ) throw new Error("Beeper direct messaging acceptance changed contract");
      const accountId = bounded(
        source.accountId,
        "Beeper direct messaging acceptance account",
        512,
      );
      bounded(
        source.conversationId,
        "Beeper direct messaging acceptance conversation",
        2_048,
      );
      return Object.freeze({
        state: "submitted" as const,
        providerMessageId: normalizeBeeperMessageProviderId(
          accountId,
          bounded(
            source.pendingMessageId,
            "Beeper direct messaging acceptance pending message",
            2_048,
          ),
        ),
        providerRevision: null,
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
      const parsed = parseBeeperMessagingTarget(target);
      const accountId = targetField(parsed, "accountId");
      const input = Object.freeze({
        account_id: accountId,
        conversation_id: targetField(parsed, "conversationId"),
        message_id: rawBeeperMessageId(accountId, accepted.providerMessageId),
      });
      parseBeeperOperationInput("messaging.message.read", input);
      return Object.freeze({
        operation: "messaging.message.read",
        input,
      });
    },
  }),
} satisfies ProviderPluginMessagingDefinitionV1);
