import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256 } from "../canonical-json";
import type { WrenchAuth } from "../auth";
import type { ProviderMessageV1 } from "../omni-model";
import { OperationDeadline } from "../operation-deadline";
import { beeperLinkedDevicePlugin } from "../plugins/beeper-linked-device/plugin";
import { beeperMessagingDefinition, parseBeeperMessagingTarget } from "./beeper-messaging";
import {
  normalizeBeeperConversationProviderId,
  normalizeBeeperMessageProviderId,
  rawBeeperConversationId,
  rawBeeperMessageId,
} from "./beeper-omni";
import { imsgDirectMessagingDefinition } from "./imessage-direct-messaging";
import {
  imsgConversationProviderId,
  imsgMessageProviderId,
} from "./imessage-direct-omni";
import {
  whatsappMessagingDefinition,
} from "./whatsapp-messaging";
import { qualifiedWhatsAppPrivateMessagingAction } from "./whatsapp-private-transport";

const accountId = "account-signal";
const rawConversationId = "!chat:beeper.local";
const normalizedConversationId = normalizeBeeperConversationProviderId(
  accountId,
  rawConversationId,
);

function rawConversation(lastActivity: string | null = "2026-08-27T12:00:00.000Z") {
  return {
    id: rawConversationId,
    localChatId: null,
    accountId,
    network: "Signal",
    title: "Exact Friend",
    type: "single",
    description: null,
    descriptionObserved: true,
    hasAvatar: false,
    avatarObserved: true,
    lastReadMessageSortKey: null,
    lastActivity,
    unreadCount: 0,
    unreadMentionsCount: 0,
    isMarkedUnread: false,
    isArchived: false,
    isLowPriority: false,
    isMuted: false,
    isPinned: false,
    isReadOnly: false,
    messageExpirySeconds: null,
    messageExpiryObserved: true,
    draft: null,
    draftObserved: true,
    reminder: null,
    reminderObserved: true,
    participants: {
      items: [{
        id: "@friend:beeper.local",
        fullName: "Exact Friend",
        username: "friend",
        phoneNumber: null,
        email: null,
        isSelf: false,
        cannotMessage: false,
        isAdmin: false,
        isNetworkBot: false,
        isPending: false,
      }],
      total: 1,
      hasMore: false,
    },
  };
}

function exactConversationOutput(lastActivity?: string | null): unknown {
  return {
    provider: "beeper",
    operation: "conversations.read",
    accountSubject: `beeper:local:${"a".repeat(64)}`,
    conversation: rawConversation(lastActivity),
  };
}

function message(
  rawId: string,
  body: string,
  orderedAt: string,
  overrides: Partial<ProviderMessageV1> = {},
): ProviderMessageV1 {
  return Object.freeze({
    kind: "message",
    providerId: normalizeBeeperMessageProviderId(accountId, rawId),
    providerRevision: null,
    orderedAt,
    conversationProviderId: normalizedConversationId,
    sender: null,
    recipients: Object.freeze([]),
    direction: "outgoing",
    subject: null,
    body,
    unread: false,
    replyToProviderId: null,
    state: "active",
    attachments: Object.freeze([]),
    ...overrides,
  });
}

function baseMessage(value: ProviderMessageV1) {
  return Object.freeze({
    providerMessageId: value.providerId,
    providerRevision: value.providerRevision,
    orderedAt: value.orderedAt,
    messageSha256: sha256(canonicalJson(value)),
  });
}

function imessageMessage(
  guid: string,
  rowId: number,
  body: string,
  orderedAt: string,
): ProviderMessageV1 {
  return Object.freeze({
    kind: "message",
    providerId: imsgMessageProviderId(guid),
    providerRevision: `${rowId}:${guid}`,
    orderedAt,
    conversationProviderId: imsgConversationProviderId("iMessage;+;fixture-chat"),
    sender: null,
    recipients: Object.freeze([]),
    direction: "outgoing",
    subject: null,
    body,
    bodyTruncated: false,
    unread: null,
    replyToProviderId: null,
    state: "active",
    attachments: Object.freeze([]),
  });
}

describe("provider messaging coordinate codecs", () => {
  test("binds a Beeper network/chat coordinate to one exact account read", () => {
    const listInput = { account_id: accountId, limit: 100 } as const;
    const coordinate = {
      kind: "beeperConversation",
      network: "Signal",
      conversationId: rawConversationId,
    } as const;
    expect(beeperMessagingDefinition.coordinateKind).toBe("beeperConversation");
    expect(beeperMessagingDefinition.resolveRoute.operation).toBe("conversations.read");
    expect(beeperMessagingDefinition.resolveRoute.input(listInput, coordinate)).toEqual({
      account_id: accountId,
      conversation_id: rawConversationId,
      max_participants: 500,
    });
    expect(() => beeperMessagingDefinition.resolveRoute.input(listInput, {
      kind: "whatsappJid",
      jid: "15551234567@s.whatsapp.net",
    })).toThrow("requires a Beeper coordinate");
    expect(parseBeeperMessagingTarget({
      accountId,
      conversationId: rawConversationId,
    })).toEqual({
      accountId,
      conversationId: rawConversationId,
    });
    expect(beeperMessagingDefinition.action).toMatchObject({
      state: "supported",
      operation: "messaging.send",
      reply: "supported",
    });
  });

  test("round-trips raw IDs only inside the exact Beeper account scope", () => {
    const rawIds = [
      "!chat:beeper.local",
      "$event:beeper.local",
      "colon:slash/plus+unicode-🐝",
    ];
    for (const rawId of rawIds) {
      const conversation = normalizeBeeperConversationProviderId(accountId, rawId);
      const event = normalizeBeeperMessageProviderId(accountId, rawId);
      expect(rawBeeperConversationId(accountId, conversation)).toBe(rawId);
      expect(rawBeeperMessageId(accountId, event)).toBe(rawId);
      expect(() => rawBeeperConversationId("foreign-account", conversation))
        .toThrow("exact account");
      expect(() => rawBeeperMessageId("foreign-account", event))
        .toThrow("exact account");
    }
    expect(() => rawBeeperMessageId(accountId, `beeper:YWNjb3VudC1zaWduYWw:message:%%%`))
      .toThrow("malformed encoding");
    expect(() => normalizeBeeperMessageProviderId(accountId, "bad\ud800id"))
      .toThrow("bounded Beeper identifier");
    expect(() => normalizeBeeperConversationProviderId(accountId, "bad\nid"))
      .toThrow("bounded Beeper identifier");
  });

  test("keeps raw route targets private and route revisions stable across activity", () => {
    const page = {
      schemaVersion: 1 as const,
      partition: "fixture",
      completeness: { kind: "bounded-local" as const, reason: null },
      cursor: { direction: "none" as const, request: null, nextInput: null },
      entities: [{
        kind: "conversation" as const,
        providerId: normalizedConversationId,
        providerRevision: null,
        orderedAt: "2026-08-27T12:00:00.000Z",
        detail: "summary" as const,
        title: "Exact Friend",
        summary: null,
        participants: [],
        unread: false,
        unreadCount: 0,
        archived: false,
        pending: null,
      }],
      tombstones: [],
    };
    expect(beeperMessagingDefinition.enumerateRoutes(
      { account_id: accountId, limit: 100 },
      page,
    )[0]).toMatchObject({
      target: { accountId, conversationId: rawConversationId },
      conversationProviderId: normalizedConversationId,
      providerRevision: null,
    });
    if (beeperMessagingDefinition.action.state !== "supported") {
      throw new Error("Beeper messaging action must be supported");
    }
    const first = beeperMessagingDefinition.action.livePreflight.snapshot(
      exactConversationOutput("2026-08-27T12:00:00.000Z"),
    );
    const later = beeperMessagingDefinition.action.livePreflight.snapshot(
      exactConversationOutput("2026-08-27T12:05:00.000Z"),
    );
    expect(first).toEqual(later);
    expect(first).toMatchObject({
      conversationProviderId: normalizedConversationId,
      providerRevision: null,
    });
  });

  test("compiles exact replies, normalizes acceptance, and reconciles by exact raw ID", () => {
    if (beeperMessagingDefinition.action.state !== "supported") {
      throw new Error("Beeper messaging action must be supported");
    }
    const action = beeperMessagingDefinition.action;
    const target = { accountId, conversationId: rawConversationId };
    const reply = normalizeBeeperMessageProviderId(accountId, "$reply:beeper.local");
    expect(action.compileTurnPart(target, {
      partId: "part-1",
      text: "exact private reply",
      replyToProviderId: reply,
    })).toEqual({
      account_id: accountId,
      conversation_id: rawConversationId,
      kind: "text",
      text: "exact private reply",
      reply_to: "$reply:beeper.local",
    });
    expect(() => action.compileTurnPart(target, {
      partId: "part-1",
      text: "wrong realm",
      replyToProviderId: normalizeBeeperMessageProviderId("foreign", "$reply"),
    })).toThrow("exact account");
    const accepted = action.mapAcceptedResult({
      provider: "beeper",
      operation: "messaging.send",
      accountSubject: `beeper:local:${"a".repeat(64)}`,
      accountId,
      conversationId: rawConversationId,
      pendingMessageId: "$pending:beeper.local",
      providerRevision: null,
    });
    expect(accepted).toEqual({
      state: "submitted",
      providerMessageId: normalizeBeeperMessageProviderId(
        accountId,
        "$pending:beeper.local",
      ),
      providerRevision: null,
    });
    expect(action.reconciliation(target, accepted)).toEqual({
      operation: "messaging.message.read",
      input: {
        account_id: accountId,
        conversation_id: rawConversationId,
        message_id: "$pending:beeper.local",
      },
    });
  });

  test("proves only the exact multi-part own suffix across bounded-window eviction", () => {
    if (beeperMessagingDefinition.action.state !== "supported") {
      throw new Error("Beeper messaging action must be supported");
    }
    const action = beeperMessagingDefinition.action;
    const old1 = message("old-1", "older", "2026-08-27T12:00:00.000Z", {
      direction: "incoming",
    });
    const old2 = message("old-2", "newer", "2026-08-27T12:01:00.000Z", {
      direction: "incoming",
    });
    const own1 = message("pending-1", "part one", "2026-08-27T12:02:00.000Z");
    const own2 = message("pending-2", "part two", "2026-08-27T12:03:00.000Z", {
      replyToProviderId: own1.providerId,
    });
    const proof = {
      base: {
        exactDataRevision: "a".repeat(64),
        latestMessageRevision: "b".repeat(64),
        contextLimit: 2,
        messages: [baseMessage(old1), baseMessage(old2)],
      },
      current: {
        exactDataRevision: "c".repeat(64),
        latestMessageRevision: "d".repeat(64),
        messages: [own1, own2],
      },
      accepted: [{
        providerMessageId: own1.providerId,
        providerRevision: null,
        direction: "outgoing" as const,
        bodySha256: sha256("part one"),
        replyToProviderId: null,
      }, {
        providerMessageId: own2.providerId,
        providerRevision: null,
        direction: "outgoing" as const,
        bodySha256: sha256("part two"),
        replyToProviderId: own1.providerId,
      }],
    } as const;
    expect(action.proveExpectedOwnPrefix(proof)).toBe("proven");
    expect(action.proveExpectedOwnPrefix({
      ...proof,
      current: { ...proof.current, messages: [old1, old2, own1, own2] },
    })).toBe("drift");
    expect(action.proveExpectedOwnPrefix({
      ...proof,
      base: { ...proof.base, contextLimit: 4 },
      current: { ...proof.current, messages: [old1, old2, own1, own2] },
    })).toBe("proven");
    const exactBase = {
      exactDataRevision: proof.base.exactDataRevision,
      latestMessageRevision: proof.base.latestMessageRevision,
      messages: [old1, old2],
    } as const;
    expect(action.proveExpectedOwnPrefix({
      ...proof,
      current: exactBase,
      accepted: [],
    })).toBe("proven");
    expect(action.proveExpectedOwnPrefix({
      ...proof,
      current: exactBase,
    })).toBe("proven");
    for (const messages of [
      [old2, own1, own2],
      [own1, { ...own2, providerRevision: "edited" }],
      [own1, { ...own2, state: "revoked" as const }],
      [own1, { ...own2, direction: "incoming" as const }],
      [own1, own2, message("foreign", "other outgoing", "2026-08-27T12:04:00.000Z")],
    ]) {
      expect(action.proveExpectedOwnPrefix({
        ...proof,
        current: { ...proof.current, messages },
      })).toBe("drift");
    }
  });

  test("exposes only the exact direct Beeper messaging runtime operation", async () => {
    const binding = beeperLinkedDevicePlugin.bindings[0]!;
    const runtime = await binding.loadRuntime();
    expect(typeof runtime.executeMessagingPart).toBe("function");
    const auth: WrenchAuth = Object.freeze({
      schemaVersion: 1,
      id: "beeper-main",
      kind: "linked-device-store",
      provider: "beeper",
      path: "/not-read-for-malformed-input",
      subject: `beeper:local:${"a".repeat(64)}`,
    });
    const operationDeadline = new OperationDeadline(1_000);
    const attempt = Object.freeze({
      beforeExternalBegin: () => Promise.resolve(),
      operationDeadline,
      signal: operationDeadline.signal,
      environment: Object.freeze({}),
    });
    try {
      expect(() => runtime.executeMessagingPart!("messaging.edit", {}, auth, attempt))
        .toThrow("only messaging.send");
      await expect(runtime.executeMessagingPart!("messaging.send", {}, auth, attempt))
        .rejects.toThrow("account_id");
    } finally {
      operationDeadline.dispose();
    }
  });

  test("proves the exact iMessage prefix and bounded eviction without replies", () => {
    if (imsgDirectMessagingDefinition.action.state !== "supported") {
      throw new Error("direct iMessage action changed state");
    }
    const first = imessageMessage(
      "base-guid",
      10,
      "earlier",
      "2026-08-27T12:00:00.000Z",
    );
    const acceptedMessage = imessageMessage(
      "accepted-guid",
      11,
      "one bubble",
      "2026-08-27T12:01:00.000Z",
    );
    const accepted = Object.freeze([Object.freeze({
      providerMessageId: acceptedMessage.providerId,
      providerRevision: acceptedMessage.providerRevision,
      direction: "outgoing" as const,
      bodySha256: sha256("one bubble"),
      replyToProviderId: null,
    })]);
    const base = Object.freeze({
      exactDataRevision: "base-data",
      latestMessageRevision: "base-latest",
      contextLimit: 1,
      messages: Object.freeze([baseMessage(first)]),
    });
    expect(imsgDirectMessagingDefinition.action.proveExpectedOwnPrefix({
      base,
      current: {
        exactDataRevision: "base-data",
        latestMessageRevision: "base-latest",
        messages: Object.freeze([first]),
      },
      accepted,
    })).toBe("proven");
    expect(imsgDirectMessagingDefinition.action.proveExpectedOwnPrefix({
      base,
      current: {
        exactDataRevision: "after-data",
        latestMessageRevision: "after-latest",
        messages: Object.freeze([acceptedMessage]),
      },
      accepted,
    })).toBe("proven");
    expect(imsgDirectMessagingDefinition.action.proveExpectedOwnPrefix({
      base,
      current: {
        exactDataRevision: "after-data",
        latestMessageRevision: "after-latest",
        messages: Object.freeze([
          imessageMessage(
            "foreign-guid",
            12,
            "foreign",
            "2026-08-27T12:02:00.000Z",
          ),
        ]),
      },
      accepted,
    })).toBe("drift");
  });

  test("binds an exact WhatsApp JID and remains historical-only", () => {
    const coordinate = {
      kind: "whatsappJid",
      jid: "15551234567@s.whatsapp.net",
    } as const;
    expect(whatsappMessagingDefinition.coordinateKind).toBe("whatsappJid");
    expect(whatsappMessagingDefinition.contextLiveness).toBe("freshness-unproven");
    expect(whatsappMessagingDefinition.resolveRoute.input(
      { folder: "all", limit: 100 },
      coordinate,
    )).toEqual({
      conversation_jid: "15551234567@s.whatsapp.net",
      limit: 1,
    });
    expect(() => whatsappMessagingDefinition.resolveRoute.input(
      { folder: "all", limit: 100 },
      {
        kind: "beeperConversation",
        network: "whatsapp",
        conversationId: "chat",
      },
    )).toThrow("requires a WhatsApp JID");
    expect(whatsappMessagingDefinition.parseTarget({
      conversationJid: "15551234567@s.whatsapp.net",
    })).toEqual({ conversationJid: "15551234567@s.whatsapp.net" });
    expect(whatsappMessagingDefinition.action).toEqual({
      state: "unavailable",
      reply: "unsupported",
      reason:
        "capture-required: the checked private no-retry transport still needs a controlled live fixture, fresh context proof, and exact accepted-message reconciliation",
    });
    expect(qualifiedWhatsAppPrivateMessagingAction.state).toBe(
      "supported",
    );
    expect(qualifiedWhatsAppPrivateMessagingAction.compileTurnPart(
      { conversationJid: "15551234567@s.whatsapp.net" },
      { partId: "part-1", text: "hello", replyToProviderId: null },
    )).toEqual({
      conversation_jid: "15551234567@s.whatsapp.net",
      body: "hello",
    });
    expect(() => qualifiedWhatsAppPrivateMessagingAction.compileTurnPart(
      { conversationJid: "15551234567@s.whatsapp.net" },
      { partId: "part-1", text: "hello", replyToProviderId: "MSG-1" },
    )).toThrow("has not qualified replies");
  });
});
