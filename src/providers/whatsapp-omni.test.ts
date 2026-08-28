import { describe, expect, test } from "bun:test";

import { parseMaterializedPageV1 } from "../omni-model";
import {
  materializeWhatsAppMessagingList,
  materializeWhatsAppMessagingRead,
} from "./whatsapp-omni";

const ACCOUNT_SUBJECT = "whatsapp:pn:15551234567";
const CHAT_JID = "15557654321@s.whatsapp.net";
const SENDER_JID = "15551234567@s.whatsapp.net";

const chat = Object.freeze({
  jid: CHAT_JID,
  kind: "dm",
  name: "Fixture",
  lastMessageAt: "2026-07-23T12:00:00Z",
  archived: false,
  pinned: true,
  mutedUntil: 0,
  unread: true,
  unreadCount: 2,
});

const message = Object.freeze({
  chatJid: CHAT_JID,
  chatName: "Fixture",
  messageId: "3EB0SYNTHETICMESSAGE",
  senderJid: SENDER_JID,
  senderName: "Sender",
  timestamp: "2026-07-23T12:00:00.123Z",
  fromMe: false,
  text: "hello",
  displayText: "hello",
  quotedMessageId: null,
  quotedSenderJid: null,
  buttons: [],
  forwarded: false,
  forwardingScore: 0,
  reactionToId: null,
  reactionEmoji: null,
  media: null,
  starred: false,
  revoked: true,
  deletedForMe: true,
  snippet: null,
});

function listOutput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    accountSubject: ACCOUNT_SUBJECT,
    projection: "local-store",
    completeness: "bounded-current-local-projection",
    chats: [chat],
    ...overrides,
  };
}

function readOutput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    accountSubject: ACCOUNT_SUBJECT,
    projection: "local-store",
    completeness: "bounded-current-local-projection",
    conversationJid: CHAT_JID,
    messages: [message],
    fullTextSearch: true,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("WhatsApp omni materializers", () => {
  test("materializes bounded-local conversations in provider order", () => {
    const page = materializeWhatsAppMessagingList(
      { folder: "active", limit: 100 },
      listOutput(),
    );
    expect(parseMaterializedPageV1(page)).toEqual(page);
    expect(page).toEqual({
      schemaVersion: 1,
      partition: `${ACCOUNT_SUBJECT}:conversations:active`,
      completeness: {
        kind: "bounded-local",
        reason: "WhatsApp exposed a bounded current projection from the local linked-device store, not a complete remote inbox.",
      },
      cursor: { direction: "none", request: null, nextInput: null },
      entities: [{
        kind: "conversation",
        conversationKind: "single",
        providerId: CHAT_JID,
        providerRevision: null,
        orderedAt: "2026-07-23T12:00:00.000Z",
        detail: "summary",
        title: "Fixture",
        summary: null,
        participants: [{
          providerId: CHAT_JID,
          displayName: "Fixture",
          handle: null,
        }],
        unread: true,
        unreadCount: 2,
        archived: false,
        pending: null,
      }],
      tombstones: [],
    });
  });

  test("preserves revoked and deleted-for-me as independent explicit message states", () => {
    const page = materializeWhatsAppMessagingRead(
      { conversation_jid: CHAT_JID, limit: 200 },
      readOutput(),
    );
    expect(parseMaterializedPageV1(page)).toEqual(page);
    expect(page).toEqual({
      schemaVersion: 1,
      partition: `${ACCOUNT_SUBJECT}:messages:${CHAT_JID}`,
      completeness: {
        kind: "bounded-local",
        reason: "WhatsApp exposed bounded current messages from the local linked-device store, not a complete remote conversation archive.",
      },
      cursor: { direction: "none", request: null, nextInput: null },
      entities: [{
        kind: "message",
        providerId: "3EB0SYNTHETICMESSAGE",
        providerRevision: null,
        orderedAt: "2026-07-23T12:00:00.123Z",
        conversationProviderId: CHAT_JID,
        sender: {
          providerId: SENDER_JID,
          displayName: "Sender",
          handle: null,
        },
        recipients: [],
        direction: "incoming",
        subject: null,
        body: "hello",
        unread: null,
        replyToProviderId: null,
        state: "revoked-and-deleted-for-me",
        attachments: [],
      }],
      tombstones: [],
    });
  });

  test("maps every explicit message-state combination without tombstones", () => {
    for (const [revoked, deletedForMe, state] of [
      [false, false, "active"],
      [true, false, "revoked"],
      [false, true, "deleted-for-me"],
      [true, true, "revoked-and-deleted-for-me"],
    ] as const) {
      expect(materializeWhatsAppMessagingRead(
        { conversation_jid: CHAT_JID },
        readOutput({ messages: [{ ...message, revoked, deletedForMe }] }),
      )).toMatchObject({
        entities: [{ state }],
        tombstones: [],
      });
    }
  });

  test("maps typed media and outgoing direction into shared message fields", () => {
    expect(materializeWhatsAppMessagingRead(
      { conversation_jid: CHAT_JID },
      readOutput({ messages: [{
        ...message,
        fromMe: true,
        media: {
          type: "image",
          caption: "caption",
          filename: "photo.jpg",
          mimeType: "image/jpeg",
          downloaded: true,
        },
      }] }),
    )).toMatchObject({
      entities: [{
        direction: "outgoing",
        attachments: [{
          kind: "image",
          mimeType: "image/jpeg",
          name: "photo.jpg",
          sizeBytes: null,
        }],
      }],
    });
  });

  test("accepts mark-unread state independently from unread message count", () => {
    expect(materializeWhatsAppMessagingList(
      {},
      listOutput({ chats: [{ ...chat, unread: true, unreadCount: 0 }] }),
    )).toMatchObject({
      entities: [{ kind: "conversation", unread: true, unreadCount: 0 }],
    });
  });

  test("rejects every missing list and read envelope coordinate", () => {
    for (const key of [
      "accountSubject",
      "projection",
      "completeness",
      "chats",
    ] as const) {
      const output = clone(listOutput()) as Record<string, unknown>;
      delete output[key];
      expect(() => materializeWhatsAppMessagingList({}, output)).toThrow(
        `whatsapp omni messaging.list output.${key}`,
      );
    }
    for (const key of [
      "accountSubject",
      "projection",
      "completeness",
      "conversationJid",
      "messages",
      "fullTextSearch",
    ] as const) {
      const output = clone(readOutput()) as Record<string, unknown>;
      delete output[key];
      expect(() => materializeWhatsAppMessagingRead(
        { conversation_jid: CHAT_JID },
        output,
      )).toThrow(`whatsapp omni messaging.read output.${key}`);
    }
  });

  test("rejects every malformed required conversation field", () => {
    const malformed = {
      jid: 7,
      kind: 7,
      name: 7,
      lastMessageAt: "yesterday",
      archived: "no",
      pinned: "yes",
      mutedUntil: 1.5,
      unread: "yes",
      unreadCount: -1,
    } as const;
    for (const [key, value] of Object.entries(malformed)) {
      expect(() => materializeWhatsAppMessagingList(
        {},
        listOutput({ chats: [{ ...chat, [key]: value }] }),
      )).toThrow(`whatsapp omni messaging.list output.chats[0].${key}`);
    }
  });

  test("rejects every missing message field", () => {
    for (const key of Object.keys(message)) {
      const row = clone(message) as Record<string, unknown>;
      delete row[key];
      expect(() => materializeWhatsAppMessagingRead(
        { conversation_jid: CHAT_JID },
        readOutput({ messages: [row] }),
      )).toThrow(`whatsapp omni messaging.read output.messages[0].${key} is required`);
    }
  });

  test("rejects representative type drift for every message value category", () => {
    const malformed = {
      chatJid: "99999@newsletter",
      chatName: 7,
      messageId: "bad id",
      senderJid: 7,
      senderName: 7,
      timestamp: "yesterday",
      fromMe: "no",
      text: 7,
      displayText: 7,
      quotedMessageId: 7,
      quotedSenderJid: 7,
      buttons: {},
      forwarded: "no",
      forwardingScore: -1,
      reactionToId: 7,
      reactionEmoji: 7,
      media: [],
      starred: "no",
      revoked: "no",
      deletedForMe: "no",
      snippet: 7,
    } as const;
    for (const [key, value] of Object.entries(malformed)) {
      expect(() => materializeWhatsAppMessagingRead(
        { conversation_jid: CHAT_JID },
        readOutput({ messages: [{ ...message, [key]: value }] }),
      )).toThrow(`whatsapp omni messaging.read output.messages[0].${key}`);
    }
  });

  test("rejects identity, duplication, completeness, and reaction drift", () => {
    expect(() => materializeWhatsAppMessagingList(
      {},
      listOutput({ chats: [chat, chat] }),
    )).toThrow("duplicate stable JIDs");
    expect(() => materializeWhatsAppMessagingRead(
      { conversation_jid: CHAT_JID },
      readOutput({ messages: [message, message] }),
    )).toThrow("duplicate stable message IDs");
    expect(() => materializeWhatsAppMessagingRead(
      { conversation_jid: CHAT_JID },
      readOutput({ conversationJid: "120363123456789012@g.us" }),
    )).toThrow("must bind messaging.read input.conversation_jid");
    expect(() => materializeWhatsAppMessagingList(
      {},
      listOutput({ completeness: "complete" }),
    )).toThrow("must be bounded-current-local-projection");
    expect(() => materializeWhatsAppMessagingRead(
      { conversation_jid: CHAT_JID },
      readOutput({ messages: [{
        ...message,
        reactionToId: "3EB0TARGET",
        reactionEmoji: null,
      }] }),
    )).toThrow("must be present exactly when reactionToId is present");
  });

  test("rejects foreign containers without executing accessors", () => {
    expect(() => materializeWhatsAppMessagingList(
      {},
      new Proxy(listOutput() as object, {}),
    )).toThrow("whatsapp omni messaging.list output must be a plain object");

    let topLevelReads = 0;
    const accessorOutput = clone(listOutput()) as Record<string, unknown>;
    Object.defineProperty(accessorOutput, "chats", {
      enumerable: true,
      get() {
        topLevelReads += 1;
        return [chat];
      },
    });
    expect(() => materializeWhatsAppMessagingList({}, accessorOutput)).toThrow(
      "whatsapp omni messaging.list output.* must be an enumerable data property",
    );
    expect(topLevelReads).toBe(0);

    const symbolOutput = clone(listOutput()) as Record<PropertyKey, unknown>;
    Object.defineProperty(symbolOutput, Symbol("unreviewed"), {
      enumerable: true,
      value: true,
    });
    expect(() => materializeWhatsAppMessagingList({}, symbolOutput)).toThrow(
      "whatsapp omni messaging.list output must not have symbol properties",
    );

    const sparseChats = new Array<unknown>(2);
    sparseChats[0] = chat;
    expect(() => materializeWhatsAppMessagingList(
      {},
      listOutput({ chats: sparseChats }),
    )).toThrow("whatsapp omni messaging.list output.chats[1] must not be sparse");

    const namedChats = Object.assign([chat], { unreviewed: true });
    expect(() => materializeWhatsAppMessagingList(
      {},
      listOutput({ chats: namedChats }),
    )).toThrow(
      "whatsapp omni messaging.list output.chats must be a dense array without named properties",
    );

    let itemReads = 0;
    const accessorChats = [chat] as unknown[];
    Object.defineProperty(accessorChats, 0, {
      enumerable: true,
      get() {
        itemReads += 1;
        return chat;
      },
    });
    expect(() => materializeWhatsAppMessagingList(
      {},
      listOutput({ chats: accessorChats }),
    )).toThrow(
      "whatsapp omni messaging.list output.chats[0] must be an enumerable data property",
    );
    expect(itemReads).toBe(0);
  });
});
