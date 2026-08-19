import { describe, expect, test } from "bun:test";

import whatsappManifest from "../assets/adapters/whatsapp/wrench-web-adapter.json";
import { webSessionOperations } from "../provider-catalog-views";
import { providerPluginRegistry } from "../provider-plugins";
import { getWebSessionContract as getWebSessionContractWithRegistry } from "../web-session-contracts";
import {
  WHATSAPP_PROTOCOL_PIN,
  WHATSAPP_COMMUNITY_MEMBERSHIP_POLICY,
  WHATSAPP_WEB_OPERATIONS,
  WHATSAPP_WEB_OPERATION_NAMES,
  isWhatsAppWriteAction,
  parseWhatsAppAuthStatusEnvelope,
  parseWhatsAppWriteEnvelope,
  parseWhatsAppJid,
  planWhatsAppWriteCommand,
  projectWhatsAppChatsEnvelope,
  projectWhatsAppMessageEnvelope,
  projectWhatsAppMessagesEnvelope,
  verifyWhatsAppWriteReadback,
  whatsappSubjectFromLinkedJid,
  whatsappTargetJid,
} from "./whatsapp-web";

const getWebSessionContract = (
  recipe: Parameters<typeof getWebSessionContractWithRegistry>[0],
) => getWebSessionContractWithRegistry(recipe, providerPluginRegistry);

const ACCOUNT_JID = "15551234567@s.whatsapp.net";
const CHAT_JID = "15557654321@s.whatsapp.net";
const GROUP_JID = "120363123456789012@g.us";
const MESSAGE_ID = "3EB0SYNTHETICMESSAGE";
const SENT_ID = "3EB0SYNTHETICSENT";
const ZERO_TIME = "0001-01-01T00:00:00Z";

function success(data: unknown): unknown {
  return { success: true, data, error: null };
}

function chat(overrides: Record<string, unknown> = {}): unknown {
  return {
    jid: CHAT_JID,
    kind: "dm",
    name: "Fixture",
    last_message_ts: "2026-07-23T12:00:00Z",
    archived: false,
    pinned: true,
    muted_until: 0,
    unread: true,
    unread_count: 2,
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}): unknown {
  return {
    ChatJID: CHAT_JID,
    ChatName: "Fixture",
    MsgID: MESSAGE_ID,
    SenderJID: ACCOUNT_JID,
    SenderName: "Sender",
    Timestamp: "2026-07-23T12:00:00.123Z",
    FromMe: false,
    Text: "hello",
    DisplayText: "hello",
    IsForwarded: false,
    ForwardingScore: 0,
    ReactionToID: "",
    ReactionEmoji: "",
    MediaType: "",
    MediaCaption: "",
    Filename: "",
    MimeType: "",
    DirectPath: "/v/t62.7118-24/private-token",
    LocalPath: "/private/store/media/secret.jpg",
    DownloadedAt: ZERO_TIME,
    Starred: false,
    StarredAt: ZERO_TIME,
    Revoked: false,
    DeletedForMe: false,
    Snippet: "",
    ...overrides,
  };
}

describe("WhatsApp linked-device protocol registry", () => {
  test("pins one audited protocol implementation and ships manifest parity", () => {
    expect(WHATSAPP_PROTOCOL_PIN).toMatchObject({
      implementation: "github.com/openclaw/wacli",
      version: "0.13.0",
      commit: "1e15f646d23598ef5db2bdb4659ac39cc5188ad2",
    });
    expect(whatsappManifest.schemaVersion).toBe(4);
    expect(whatsappManifest.id).toBe("whatsapp-web");
    expect(whatsappManifest.version).toBe("1.3.0");
    expect(whatsappManifest.displayName).toContain("Linked-Device Protocol");
    expect(whatsappManifest.operations["contacts.list"].description).toContain(
      "account-bound contact table",
    );
    expect(whatsappManifest.operations["contacts.list"].description).toContain(
      "content-free relationship evidence",
    );
    expect(Object.keys(whatsappManifest.operations).sort()).toEqual(
      [...WHATSAPP_WEB_OPERATION_NAMES].sort(),
    );
    for (const action of WHATSAPP_WEB_OPERATION_NAMES) {
      const operation = whatsappManifest.operations[action];
      expect(operation.webSession).toMatchObject({
        site: "whatsapp",
        action,
        contractVersion: action === "contacts.list" ? 2 : 1,
      });
      expect(operation.risk).toBe(WHATSAPP_WEB_OPERATIONS[action].risk);
      expect(operation.description.startsWith(
        "Capture-required contract reservation:",
      )).toBe(WHATSAPP_WEB_OPERATIONS[action].state === "capture-required");
      expect("browser" in operation).toBe(false);
      expect("provider" in operation).toBe(false);
    }
  });

  test("graduates only paired non-mutating projections and keeps every mutation fail-closed", () => {
    const observed = new Set([
      "contacts.list",
      "media.read",
      "messaging.list",
      "messaging.read",
    ]);
    for (const [action, contract] of Object.entries(WHATSAPP_WEB_OPERATIONS)) {
      expect(contract.state).toBe(
        observed.has(action) ? "observed" : "capture-required",
      );
    }
    expect(WHATSAPP_WEB_OPERATIONS["messaging.list"].reason).toContain(
      "without opening a WhatsApp connection",
    );
    expect(WHATSAPP_WEB_OPERATIONS["messaging.send"].reason).toContain(
      "process-private",
    );
    expect(WHATSAPP_COMMUNITY_MEMBERSHIP_POLICY).toMatchObject({
      risk: "R4",
      state: "prohibited",
    });
    expect(webSessionOperations.whatsapp).not.toContain(
      "communities.membership.set",
    );
    expect(() => getWebSessionContract({
      site: "whatsapp",
      action: "communities.membership.set",
      contractVersion: 1,
      timeoutMs: 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
    })).toThrow(
      "authenticated web contract whatsapp/communities.membership.set@1 is not installed",
    );
  });
});

describe("WhatsApp account and target binding", () => {
  test("derives a namespaced subject only from one linked user or LID JID", () => {
    expect(whatsappSubjectFromLinkedJid(ACCOUNT_JID)).toBe(
      "whatsapp:pn:15551234567",
    );
    expect(whatsappSubjectFromLinkedJid("123456789012345@lid")).toBe(
      "whatsapp:lid:123456789012345",
    );
    expect(parseWhatsAppAuthStatusEnvelope(success({
      authenticated: true,
      linked_jid: ACCOUNT_JID,
      phone: "15551234567",
    }))).toEqual({
      authenticated: true,
      linkedJid: ACCOUNT_JID,
      subject: "whatsapp:pn:15551234567",
    });
    expect(parseWhatsAppAuthStatusEnvelope(success({
      authenticated: false,
    }))).toEqual({
      authenticated: false,
      linkedJid: null,
      subject: null,
    });
  });

  test("accepts canonical user/LID/group targets and excludes broadcasts", () => {
    expect(parseWhatsAppJid(CHAT_JID)).toEqual({
      jid: CHAT_JID,
      kind: "user",
    });
    expect(whatsappTargetJid(GROUP_JID)).toBe(GROUP_JID);
    expect(() => whatsappTargetJid("status@broadcast")).toThrow(
      "not an addressable",
    );
    expect(() => whatsappTargetJid("15557654321:4@s.whatsapp.net")).toThrow(
      "not an addressable",
    );
    expect(() => whatsappTargetJid("friend")).toThrow("exact WhatsApp JID");
  });

  test("rejects malformed or confused auth status envelopes", () => {
    expect(() => parseWhatsAppAuthStatusEnvelope({
      success: true,
      data: { authenticated: false, linked_jid: ACCOUNT_JID },
      error: null,
    })).toThrow("exposed account fields");
    expect(() => parseWhatsAppAuthStatusEnvelope(success({
      authenticated: true,
      linked_jid: ACCOUNT_JID,
      phone: "15550000000",
    }))).toThrow("did not match");
    expect(() => parseWhatsAppAuthStatusEnvelope({
      success: true,
      data: { authenticated: true, linked_jid: ACCOUNT_JID },
      error: null,
      secret: "drift",
    })).toThrow("unsupported fields");
  });
});

describe("WhatsApp bounded local projection", () => {
  test("projects chats and messages while omitting credential-bearing paths", () => {
    expect(projectWhatsAppChatsEnvelope(success([chat()]), 1)).toEqual([{
      jid: CHAT_JID,
      kind: "dm",
      name: "Fixture",
      lastMessageAt: "2026-07-23T12:00:00Z",
      archived: false,
      pinned: true,
      mutedUntil: 0,
      unread: true,
      unreadCount: 2,
    }]);
    const projected = projectWhatsAppMessagesEnvelope(success({
      messages: [message({
        MediaType: "image",
        MediaCaption: "caption",
        Filename: "photo.jpg",
        MimeType: "image/jpeg",
        LocalPath: "/private/store/media/secret.jpg",
        DownloadedAt: "2026-07-23T12:01:00Z",
        Buttons: [{
          type: "url",
          display_text: "Open",
          url: "https://example.com/private-token",
          id: "private-button-id",
        }],
      })],
      fts: true,
    }), CHAT_JID, 1);
    expect(projected.messages[0]).toMatchObject({
      chatJid: CHAT_JID,
      messageId: MESSAGE_ID,
      media: {
        type: "image",
        caption: "caption",
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        downloaded: true,
      },
      buttons: [{ type: "url", displayText: "Open", index: null }],
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("secret.jpg");
    expect(serialized).not.toContain("private-button-id");
    expect(serialized).not.toContain("DirectPath");
    expect(serialized).not.toContain("LocalPath");
  });

  test("binds every returned message to the exact requested chat and ID", () => {
    expect(() => projectWhatsAppMessagesEnvelope(success({
      messages: [message({ ChatJID: GROUP_JID })],
      fts: false,
    }), CHAT_JID)).toThrow("requested conversation");
    expect(() => projectWhatsAppMessageEnvelope(
      success(message()),
      CHAT_JID,
      "OTHER",
    )).toThrow("requested message");
    expect(() => projectWhatsAppMessageEnvelope(
      success({ ...message() as Record<string, unknown>, Unexpected: true }),
      CHAT_JID,
      MESSAGE_ID,
    )).toThrow("unsupported fields");
  });

  test("enforces item and field bounds before projection", () => {
    expect(() => projectWhatsAppChatsEnvelope(
      success([chat(), chat()]),
      1,
    )).toThrow("bounded array");
    expect(() => projectWhatsAppMessagesEnvelope(success({
      messages: [message({ Text: "x".repeat(65_537) })],
      fts: false,
    }), CHAT_JID)).toThrow("bounded text");
    expect(() => projectWhatsAppMessagesEnvelope(success({
      messages: [message({ MsgID: "../unsafe" })],
      fts: false,
    }), CHAT_JID)).toThrow("message ID");
  });
});

describe("WhatsApp fixed mutation plans and readback", () => {
  test("constructs fixed exact-JID commands without an arbitrary CLI surface", () => {
    expect(WHATSAPP_WEB_OPERATION_NAMES.filter(isWhatsAppWriteAction)).toEqual([
      "content.edit",
      "content.share",
      "messaging.send",
      "reactions.set",
    ]);
    expect(planWhatsAppWriteCommand("messaging.send", {
      conversation_jid: CHAT_JID,
      body: "low stakes",
    })).toMatchObject({
      action: "messaging.send",
      destinationJid: CHAT_JID,
      expectedBody: "low stakes",
      argv: [
        "send",
        "text",
        "--to",
        CHAT_JID,
        "--message",
        "low stakes",
        "--no-preview",
        "--post-send-wait",
        "0",
      ],
    });
    expect(planWhatsAppWriteCommand("content.share", {
      source_conversation_jid: CHAT_JID,
      message_id: MESSAGE_ID,
      destination_jid: GROUP_JID,
    }).argv).toEqual([
      "messages",
      "forward",
      "--chat",
      CHAT_JID,
      "--id",
      MESSAGE_ID,
      "--to",
      GROUP_JID,
      "--post-send-wait",
      "0",
    ]);
    expect(planWhatsAppWriteCommand("messaging.send", {
      conversation_jid: CHAT_JID,
      body: "caption",
    }, "/private/tmp/fixture.jpg")).toMatchObject({
      expectedBody: "caption",
      expectedMedia: true,
      argv: [
        "send",
        "file",
        "--to",
        CHAT_JID,
        "--file",
        "/private/tmp/fixture.jpg",
        "--post-send-wait",
        "0",
        "--caption",
        "caption",
      ],
    });
    expect(() => planWhatsAppWriteCommand("messaging.send", {
      conversation_jid: CHAT_JID,
    }, "/private/tmp/fixture.jpg")).toThrow("input.body");
    expect(() => planWhatsAppWriteCommand("content.save" as never, {
      conversation_jid: CHAT_JID,
      message_id: MESSAGE_ID,
    })).toThrow("has no reviewed write plan");
    expect(() => planWhatsAppWriteCommand("messaging.send", {
      conversation_jid: "--help",
      body: "unsafe",
    })).toThrow("exact WhatsApp JID");
    expect(() => planWhatsAppWriteCommand("reactions.set", {
      conversation_jid: GROUP_JID,
      message_id: MESSAGE_ID,
      reaction: "👍",
    })).toThrow("sender_jid is required");
  });

  test("binds send response and independent local readback", () => {
    const plan = planWhatsAppWriteCommand("messaging.send", {
      conversation_jid: CHAT_JID,
      body: "low stakes",
    });
    const receipt = parseWhatsAppWriteEnvelope(plan, success({
      sent: true,
      to: CHAT_JID,
      id: SENT_ID,
    }));
    expect(receipt).toEqual({
      messageId: SENT_ID,
      readbackChatJid: CHAT_JID,
    });
    expect(verifyWhatsAppWriteReadback(
      plan,
      receipt,
      success(message({
        MsgID: SENT_ID,
        SenderJID: "",
        SenderName: "me",
        FromMe: true,
        Text: "low stakes",
        DisplayText: "low stakes",
      })),
    )).toMatchObject({
      messageId: SENT_ID,
      fromMe: true,
      text: "low stakes",
    });
    expect(() => parseWhatsAppWriteEnvelope(plan, success({
      sent: true,
      to: GROUP_JID,
      id: SENT_ID,
    }))).toThrow("destination");

    const mediaPlan = planWhatsAppWriteCommand("messaging.send", {
      conversation_jid: CHAT_JID,
      body: "caption",
    }, "/private/tmp/fixture.jpg");
    const mediaReceipt = parseWhatsAppWriteEnvelope(mediaPlan, success({
      sent: true,
      to: CHAT_JID,
      id: SENT_ID,
      file: { type: "image" },
    }));
    expect(verifyWhatsAppWriteReadback(
      mediaPlan,
      mediaReceipt,
      success(message({
        MsgID: SENT_ID,
        SenderJID: "",
        SenderName: "me",
        FromMe: true,
        Text: "caption",
        DisplayText: "caption",
        MediaType: "image",
        MediaCaption: "caption",
      })),
    )).toMatchObject({
      messageId: SENT_ID,
      fromMe: true,
      media: { type: "image", caption: "caption" },
    });
    expect(() => verifyWhatsAppWriteReadback(
      mediaPlan,
      mediaReceipt,
      success(message({
        MsgID: SENT_ID,
        SenderJID: "",
        SenderName: "me",
        FromMe: true,
        MediaType: "image",
        MediaCaption: "wrong caption",
      })),
    )).toThrow("confirmed content");
  });
});
