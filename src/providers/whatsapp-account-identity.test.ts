import { describe, expect, test } from "bun:test";

import {
  canonicalWhatsAppAccountSubjectJid,
  canonicalWhatsAppParticipantJid,
} from "./whatsapp-account-identity";
import { parseWhatsAppMessageExportProjectionRequest } from "./whatsapp-message-export-projection-protocol";
import { whatsappSubjectFromLinkedJid } from "./whatsapp-web";

function exportRequest(accountSubject: string) {
  return {
    schemaVersion: 1,
    operation: "message-like-me.export",
    accountSubject,
    cursor: "0",
    cursorAnchor: null,
    limit: 1,
    expectedGeneration: null,
    storeIdentity: { dev: "1", ino: "2" },
    sessionIdentity: { dev: "1", ino: "3" },
    messageStoreIdentity: { dev: "1", ino: "4" },
  };
}

describe("canonical WhatsApp account identity", () => {
  test("makes every newly pairable boundary subject exportable", () => {
    for (const linkedJid of [
      "12345@s.whatsapp.net",
      "123456789012345@s.whatsapp.net",
      "12345@lid",
      "12345678901234567890@lid",
    ]) {
      const subject = whatsappSubjectFromLinkedJid(linkedJid);
      expect(parseWhatsAppMessageExportProjectionRequest(exportRequest(subject)))
        .toMatchObject({ accountSubject: subject });
    }
  });

  test("rejects leading-zero and overlong pairing identities before export", () => {
    for (const linkedJid of [
      "01234@s.whatsapp.net",
      "1234567890123456@s.whatsapp.net",
      "01234@lid",
      "123456789012345678901@lid",
    ]) {
      expect(() => whatsappSubjectFromLinkedJid(linkedJid)).toThrow(
        "account identifier is not canonical",
      );
    }
  });

  test("maps canonical PN and LID subjects to distinct exact self JIDs", () => {
    expect(canonicalWhatsAppAccountSubjectJid("whatsapp:pn:12345"))
      .toBe("12345@s.whatsapp.net");
    expect(canonicalWhatsAppAccountSubjectJid("whatsapp:lid:12345"))
      .toBe("12345@lid");
    expect(canonicalWhatsAppAccountSubjectJid("whatsapp:pn:12345"))
      .not.toBe(canonicalWhatsAppAccountSubjectJid("whatsapp:lid:12345"));
    for (const subject of [
      "whatsapp:pn:01234",
      "whatsapp:pn:1234567890123456",
      "whatsapp:lid:01234",
      "whatsapp:lid:123456789012345678901",
      "whatsapp:unknown:12345",
    ]) {
      expect(() => canonicalWhatsAppAccountSubjectJid(subject)).toThrow(
        "WhatsApp account subject is not canonical",
      );
    }
  });

  test("canonicalizes exact participant devices without weakening PN or LID bounds", () => {
    expect(canonicalWhatsAppParticipantJid("12345:2@s.whatsapp.net"))
      .toBe("12345@s.whatsapp.net");
    expect(canonicalWhatsAppParticipantJid("12345:2@lid")).toBe("12345@lid");
    for (const jid of [
      "01234@s.whatsapp.net",
      "1234567890123456@s.whatsapp.net",
      "01234@lid",
      "123456789012345678901@lid",
    ]) {
      expect(() => canonicalWhatsAppParticipantJid(jid)).toThrow(
        "WhatsApp participant JID is not canonical",
      );
    }
  });
});
