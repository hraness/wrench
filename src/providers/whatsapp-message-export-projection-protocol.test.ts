import { describe, expect, test } from "bun:test";

import {
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
  parseWhatsAppMessageExportProjectionResponse,
  type WhatsAppMessageExportProjectionItem,
  type WhatsAppMessageExportProjectionRequest,
} from "./whatsapp-message-export-projection-protocol";

function request(
  accountSubject = "whatsapp:pn:15551234567",
): WhatsAppMessageExportProjectionRequest {
  return {
    schemaVersion: 1,
    operation: "message-like-me.export",
    accountSubject,
    cursor: "0",
    cursorAnchor: null,
    limit: 10,
    expectedGeneration: null,
    storeIdentity: { dev: "1", ino: "2" },
    sessionIdentity: { dev: "1", ino: "3" },
    messageStoreIdentity: { dev: "1", ino: "4" },
  };
}

function item(
  overrides: Partial<WhatsAppMessageExportProjectionItem> = {},
): WhatsAppMessageExportProjectionItem {
  return {
    rowid: "1",
    chatJid: "15557654321@s.whatsapp.net",
    chatKind: "dm",
    chatName: null,
    messageId: "MSG-1",
    senderJid: "15557654321:2@s.whatsapp.net",
    senderName: null,
    timestamp: "2026-08-28T12:00:00.000Z",
    fromMe: false,
    text: "hello",
    displayText: null,
    quotedMessageId: null,
    quotedSenderJid: null,
    reactionToMessageId: null,
    reactionEmoji: null,
    mediaType: null,
    mediaCaption: null,
    fileName: null,
    mimeType: null,
    fileLength: null,
    revoked: false,
    deletedForMe: false,
    deletedAt: null,
    payloadPurgedAt: null,
    edited: false,
    editedAt: null,
    ...overrides,
  };
}

function response(
  messages: unknown,
  checkpointCursor = "1",
  accountJidAliases: Readonly<{ pnJid: string | null; lidJid: string | null }> = {
    pnJid: "15551234567@s.whatsapp.net",
    lidJid: null,
  },
) {
  const values = Array.isArray(messages) ? messages : [];
  return {
    schemaVersion: 1,
    status: "succeeded",
    projectionGeneration: {
      messageStoreIdentity: { dev: "1", ino: "4" },
      size: "100",
      mtimeNs: "200",
      ctimeNs: "300",
      schemaFingerprint: WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
    },
    accountJidAliases,
    nonConversationChatsExcluded: false,
    messages,
    nextCursor: null,
    localInsertPageComplete: true,
    checkpoint: values.length === 0
      ? { cursor: "0", anchor: null }
      : { cursor: checkpointCursor, anchor: "a".repeat(64) },
  };
}

function parses(
  value: WhatsAppMessageExportProjectionItem,
  accountSubject = "whatsapp:pn:15551234567",
): boolean {
  try {
    const lid = /^whatsapp:lid:([0-9]+)$/u.exec(accountSubject)?.[1];
    const aliases = lid === undefined
      ? { pnJid: "15551234567@s.whatsapp.net", lidJid: null }
      : { pnJid: "15551234567@s.whatsapp.net", lidJid: `${lid}@lid` };
    parseWhatsAppMessageExportProjectionResponse(
      response([value], value.rowid, aliases),
      request(accountSubject),
    );
    return true;
  } catch {
    return false;
  }
}

describe("WhatsApp message export projection protocol", () => {
  test("enforces the exact sender-direction law while keeping PN and LID identities distinct", () => {
    const self = "15551234567@s.whatsapp.net";
    const peer = "15557654321@s.whatsapp.net";
    const group = "120363123456789012@g.us";
    const cases = [
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: null, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: `${peer.split("@")[0]}:2@s.whatsapp.net`, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: self, valid: false },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: null, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: "15551234567:3@s.whatsapp.net", valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: peer, valid: false },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: null, valid: true },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: self, valid: true },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: "15551234567@lid", valid: false },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: null, valid: true },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: "222222222222222:4@lid", valid: true },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: self, valid: false },
    ] as const;
    for (const [index, candidate] of cases.entries()) {
      expect(parses(item({
        rowid: String(index + 1),
        chatKind: candidate.chatKind,
        chatJid: candidate.chatJid,
        fromMe: candidate.fromMe,
        senderJid: candidate.senderJid,
      }))).toBe(candidate.valid);
    }
  });

  test("enforces the same direction matrix for a LID-bound account using its proved PN alias", () => {
    const accountSubject = "whatsapp:lid:222222222222222";
    const self = "222222222222222@lid";
    const pnAlias = "15551234567@s.whatsapp.net";
    const peer = "15557654321@s.whatsapp.net";
    const group = "120363123456789012@g.us";
    const cases = [
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: null, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: peer, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: self, valid: false },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: null, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: "222222222222222:3@lid", valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: pnAlias, valid: true },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: null, valid: true },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: self, valid: true },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: pnAlias, valid: true },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: null, valid: true },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: pnAlias, valid: false },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: self, valid: false },
    ] as const;
    for (const candidate of cases) {
      expect(parses(item({
        chatKind: candidate.chatKind,
        chatJid: candidate.chatJid,
        fromMe: candidate.fromMe,
        senderJid: candidate.senderJid,
      }), accountSubject)).toBe(candidate.valid);
    }
  });

  test("binds the exact proved PN and LID aliases to the requested account", () => {
    const lidRequest = request("whatsapp:lid:222222222222222");
    expect(() => parseWhatsAppMessageExportProjectionResponse(response([], "1", {
      pnJid: "15551234567@s.whatsapp.net",
      lidJid: "222222222222222@lid",
    }), lidRequest)).not.toThrow();
    for (const aliases of [
      { pnJid: "15551234567@s.whatsapp.net", lidJid: null },
      { pnJid: null, lidJid: "333333333333333@lid" },
      { pnJid: null, lidJid: null },
      { pnJid: "15551234567:2@s.whatsapp.net", lidJid: "222222222222222@lid" },
      { pnJid: "015551234567@s.whatsapp.net", lidJid: "222222222222222@lid" },
      { pnJid: "15551234567@s.whatsapp.net", lidJid: `${"2".repeat(21)}@lid` },
    ]) {
      expect(() => parseWhatsAppMessageExportProjectionResponse(
        response([], "1", aliases),
        lidRequest,
      )).toThrow("accountJidAliases");
    }
  });

  test("requires a reaction target and admits target-only removals for omission", () => {
    expect(parses(item({ reactionEmoji: "👍", reactionToMessageId: null }))).toBe(false);
    expect(parses(item({ reactionEmoji: "👍", reactionToMessageId: "TARGET-1" }))).toBe(true);
    expect(parses(item({ reactionEmoji: null, reactionToMessageId: "TARGET-1" }))).toBe(true);
    expect(parses(item({ reactionEmoji: "", reactionToMessageId: "TARGET-1" }))).toBe(true);
  });

  test("binds deletion and local payload-purge evidence to the message timestamp", () => {
    expect(parses(item({ deletedAt: "2026-08-28T12:00:01.000Z" }))).toBe(false);
    expect(parses(item({ revoked: true }))).toBe(true);
    expect(parses(item({
      deletedForMe: true,
      deletedAt: "2026-08-28T12:00:01.000Z",
    }))).toBe(true);
    expect(parses(item({
      revoked: true,
      deletedAt: "2026-08-28T11:59:59.000Z",
    }))).toBe(false);
    expect(parses(item({
      payloadPurgedAt: "2026-08-28T11:59:59.000Z",
    }))).toBe(false);
    expect(parses(item({
      payloadPurgedAt: "2026-08-28T12:00:01.000Z",
    }))).toBe(true);
  });

  test("rejects every non-ordinary or non-dense public messages array shape", () => {
    const valid = item();
    const sparse = new Array(1);
    let accessorGetterCalled = false;
    const accessor: unknown[] = [valid];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => {
        accessorGetterCalled = true;
        return valid;
      },
    });
    const named: unknown[] & { note?: string } = [valid];
    named.note = "unreviewed";
    const symbolled: unknown[] = [valid];
    Object.defineProperty(symbolled, Symbol("unreviewed"), { value: true });
    class DerivedArray extends Array<unknown> {}
    const derived = new DerivedArray(valid);
    for (const messages of [
      sparse,
      accessor,
      named,
      symbolled,
      derived,
      new Proxy([valid], {}),
    ]) {
      expect(() => parseWhatsAppMessageExportProjectionResponse(
        response(messages),
        request(),
      )).toThrow("response.messages did not match");
    }
    expect(accessorGetterCalled).toBe(false);
    expect(parseWhatsAppMessageExportProjectionResponse(
      response(Object.freeze([Object.freeze(valid)])),
      request(),
    )).toMatchObject({ status: "succeeded", messages: [{ messageId: "MSG-1" }] });
  });
});
