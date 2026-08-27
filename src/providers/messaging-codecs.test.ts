import { describe, expect, test } from "bun:test";

import { beeperMessagingDefinition, parseBeeperMessagingTarget } from "./beeper-messaging";
import { whatsappMessagingDefinition } from "./whatsapp-messaging";

describe("provider messaging coordinate codecs", () => {
  test("binds a Beeper network/chat coordinate to one exact account read", () => {
    const listInput = { account_id: "account-signal", limit: 100 } as const;
    const coordinate = {
      kind: "beeperConversation",
      network: "Signal",
      conversationId: "!chat:beeper.local",
    } as const;
    expect(beeperMessagingDefinition.coordinateKind).toBe("beeperConversation");
    expect(beeperMessagingDefinition.resolveRoute.operation).toBe("conversations.read");
    expect(beeperMessagingDefinition.resolveRoute.input(listInput, coordinate)).toEqual({
      account_id: "account-signal",
      conversation_id: "!chat:beeper.local",
      max_participants: 500,
    });
    expect(() => beeperMessagingDefinition.resolveRoute.input(listInput, {
      kind: "whatsappJid",
      jid: "15551234567@s.whatsapp.net",
    })).toThrow("requires a Beeper coordinate");
    expect(parseBeeperMessagingTarget({
      accountId: "account-signal",
      conversationId: "!chat:beeper.local",
    })).toEqual({
      accountId: "account-signal",
      conversationId: "!chat:beeper.local",
    });
    expect(beeperMessagingDefinition.action).toMatchObject({
      state: "unavailable",
      reply: "unsupported",
    });
    if (beeperMessagingDefinition.action.state !== "unavailable") {
      throw new Error("Beeper action unexpectedly became available");
    }
    expect(beeperMessagingDefinition.action.reason).toContain("Desktop API executor");
    expect(beeperMessagingDefinition.action.reason).not.toContain("rpc stdio");
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
        "capture-required: the pinned wacli write transport does not yet satisfy private-payload and no-ambiguous-retry qualification",
    });
  });
});
