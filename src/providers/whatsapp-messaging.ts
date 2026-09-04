import type { OperationInput } from "../model";
import type {
  ProviderPluginMessagingDefinitionV1,
  ProviderPluginMessagingTargetV1,
} from "../provider-plugin";
import { parseWhatsAppJid, whatsappTargetJid } from "./whatsapp-web";
import { materializeWhatsAppMessagingRead } from "./whatsapp-omni";

type JsonRecord = Readonly<Record<string, unknown>>;

function parseTarget(value: unknown): ProviderPluginMessagingTargetV1 {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error("WhatsApp messaging target must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== 1
    || descriptors.conversationJid === undefined
    || !descriptors.conversationJid.enumerable
    || !("value" in descriptors.conversationJid)
  ) throw new Error("WhatsApp messaging target has unsupported fields");
  const source = value as JsonRecord;
  return Object.freeze({
    conversationJid: whatsappTargetJid(
      source.conversationJid,
      "WhatsApp messaging target conversation",
    ),
  });
}

function conversationJid(target: ProviderPluginMessagingTargetV1): string {
  const value = target.conversationJid;
  if (value === undefined) {
    throw new Error("WhatsApp messaging target changed after parsing");
  }
  return value;
}

export const whatsappMessagingDefinition = Object.freeze({
  schemaVersion: 1,
  contractId: "wrench.provider-messaging.whatsapp.v1",
  network: "whatsapp",
  contextLiveness: "freshness-unproven",
  listOperation: "messaging.list",
  contextOperation: "messaging.read",
  enumerateRoutes: (_input: OperationInput, page) => Object.freeze(
    page.entities.map((entity) => {
      if (entity.kind !== "conversation") {
        throw new Error("WhatsApp messaging route projection contained a non-conversation");
      }
      const jid = whatsappTargetJid(
        entity.providerId,
        "WhatsApp messaging route conversation",
      );
      const kind = parseWhatsAppJid(jid).kind;
      return Object.freeze({
        target: Object.freeze({ conversationJid: jid }),
        conversationProviderId: jid,
        conversationKind: kind === "group" ? "group" as const : "single" as const,
        title: entity.title,
        participants: entity.participants,
        providerRevision: entity.providerRevision,
      });
    }),
  ),
  resolveRoute: Object.freeze({
    operation: "messaging.read",
    input: (target: ProviderPluginMessagingTargetV1) => {
      const parsed = parseTarget(target);
      return Object.freeze({
        conversation_jid: whatsappTargetJid(
          conversationJid(parsed),
          "WhatsApp exact conversation candidate",
        ),
        limit: 1,
      });
    },
    candidates: (target, output) => {
      const parsed = parseTarget(target);
      const exactJid = whatsappTargetJid(
        conversationJid(parsed),
        "WhatsApp exact conversation candidate",
      );
      const exactInput = Object.freeze({
        conversation_jid: exactJid,
        limit: 1,
      });
      const page = materializeWhatsAppMessagingRead(exactInput, output);
      for (const entity of page.entities) {
        if (
          entity.kind !== "message"
          || entity.conversationProviderId !== exactJid
        ) throw new Error("WhatsApp exact route read returned another conversation");
      }
      return Object.freeze([Object.freeze({
        target: Object.freeze({ conversationJid: exactJid }),
        conversationProviderId: exactJid,
        conversationKind: parseWhatsAppJid(exactJid).kind === "group"
          ? "group" as const
          : "single" as const,
        title: null,
        participants: Object.freeze([]),
        providerRevision: null,
      })]);
    },
    sourceConversationCoordinate: (
      target,
      _output,
      _expectedAccountSubject,
    ) => {
      parseTarget(target);
      return null;
    },
  }),
  parseTarget,
  contextInput: (target, limit) => {
    const parsed = parseTarget(target);
    return Object.freeze({
      conversation_jid: conversationJid(parsed),
      limit,
    });
  },
  action: Object.freeze({
    state: "unavailable",
    reply: "unsupported",
    reason:
      "capture-required: the official read runtime has no Wrench-qualified mutation transport",
  }),
} satisfies ProviderPluginMessagingDefinitionV1);
