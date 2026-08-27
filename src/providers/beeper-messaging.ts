import type { OperationInput } from "../model";
import type { MessagingRouteCoordinateV1 } from "../messaging-types";
import type {
  ProviderPluginMessagingDefinitionV1,
  ProviderPluginMessagingTargetV1,
} from "../provider-plugin";
import { parseBeeperOperationInput } from "./beeper-local";
import { materializeBeeperExactConversation } from "./beeper-omni";

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
          conversationId: entity.providerId,
        }),
        conversationProviderId: entity.providerId,
        conversationKind: "unknown" as const,
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
    state: "unavailable",
    reply: "unsupported",
    reason:
      "private-payload unavailable: Beeper CLI and RPC expose message bodies in child argv; the bounded Wrench-owned Beeper Desktop API executor is not integrated with the mutation kernel",
  }),
} satisfies ProviderPluginMessagingDefinitionV1);
