import { describe, expect, test } from "bun:test";

import {
  WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT,
  createWhatsAppInteractionProjectionFailure,
  parseWhatsAppInteractionProjectionRequest,
  parseWhatsAppInteractionProjectionResponse,
} from "./whatsapp-interaction-projection-protocol";

function request() {
  return {
    schemaVersion: 1,
    operation: "contacts.interactions.list",
    accountSubject: "whatsapp:pn:15551234567",
    cursor: "41",
    cursorAnchor: "c".repeat(64),
    limit: 2,
    storeIdentity: { dev: "1", ino: "2" },
    sessionIdentity: { dev: "1", ino: "3" },
    messageStoreIdentity: { dev: "1", ino: "4" },
  } as const;
}

function interaction(rowid: string) {
  return {
    rowid,
    chatJid: "15557654321@s.whatsapp.net",
    messageId: `MSG-${rowid}`,
    senderJid: "15557654321:2@s.whatsapp.net",
    timestamp: "2026-08-18T12:00:00.000Z",
    fromMe: false,
    chatKind: "dm",
  } as const;
}

function generation(identity: { readonly dev: string; readonly ino: string } = request().messageStoreIdentity) {
  return {
    messageStoreIdentity: identity,
    schemaFingerprint: WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT,
  } as const;
}

describe("WhatsApp interaction projection protocol", () => {
  test("parses only exact path-free bounded rowid requests", () => {
    expect(parseWhatsAppInteractionProjectionRequest(request())).toEqual(request());
    for (const value of [
      { ...request(), cursor: "041" },
      { ...request(), cursor: "9223372036854775808" },
      { ...request(), limit: 1_001 },
      { ...request(), accountSubject: "whatsapp:pn:+15551234567" },
      { ...request(), databasePath: "/private/wacli.db" },
      { ...request(), sql: "SELECT text FROM messages" },
    ]) expect(() => parseWhatsAppInteractionProjectionRequest(value)).toThrow();
  });

  test("binds ordered pages to the exact message-store generation", () => {
    const value = {
      schemaVersion: 1,
      status: "succeeded",
      projectionGeneration: generation(),
      interactions: [interaction("42"), interaction("43")],
      nextCursor: "43",
      localInsertPageComplete: false,
      checkpoint: { cursor: "43", anchor: "d".repeat(64) },
    } as const;
    expect(parseWhatsAppInteractionProjectionResponse(value, request())).toEqual(value);

    for (const invalid of [
      { ...value, interactions: [interaction("43"), interaction("42")] },
      { ...value, nextCursor: "42" },
      { ...value, projectionGeneration: generation({ dev: "1", ino: "5" }) },
      { ...value, projectionGeneration: {
        ...generation(),
        schemaFingerprint: "sha256:private-unreviewed-schema",
      } },
      { ...value, interactions: [{ ...interaction("42"), body: "private" }] },
      { ...value, interactions: [{ ...interaction("42"), timestamp: "2026-08-18T12:00:00Z" }] },
      { ...value, checkpoint: { cursor: "42", anchor: "d".repeat(64) } },
    ]) expect(() => parseWhatsAppInteractionProjectionResponse(invalid, request())).toThrow();
  });

  test("accepts a complete terminal page and categorical failures only", () => {
    expect(parseWhatsAppInteractionProjectionResponse({
      schemaVersion: 1,
      status: "succeeded",
      projectionGeneration: generation(),
      interactions: [interaction("42")],
      nextCursor: null,
      localInsertPageComplete: true,
      checkpoint: { cursor: "42", anchor: "d".repeat(64) },
    }, request())).toMatchObject({ localInsertPageComplete: true });
    expect(parseWhatsAppInteractionProjectionResponse(
      createWhatsAppInteractionProjectionFailure("schema-mismatch"),
    )).toEqual({ schemaVersion: 1, status: "failed", errorCode: "schema-mismatch" });
    expect(() => parseWhatsAppInteractionProjectionResponse({
      ...createWhatsAppInteractionProjectionFailure("schema-mismatch"),
      detail: "/private/wacli.db",
    })).toThrow();
  });
});
