import { describe, expect, test } from "bun:test";

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
});
