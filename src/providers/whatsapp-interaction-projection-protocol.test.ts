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

function terminal(interactions: unknown) {
  const values = Array.isArray(interactions) ? interactions : [];
  const last = values.at(-1) as { readonly rowid?: unknown } | undefined;
  return {
    schemaVersion: 1,
    status: "succeeded",
    projectionGeneration: generation(),
    interactions,
    nextCursor: null,
    localInsertPageComplete: true,
    checkpoint: values.length === 0
      ? { cursor: request().cursor, anchor: request().cursorAnchor }
      : { cursor: last?.rowid, anchor: "d".repeat(64) },
  };
}

describe("WhatsApp interaction projection protocol", () => {
  test("parses only exact path-free bounded rowid requests", () => {
    expect(parseWhatsAppInteractionProjectionRequest(request())).toEqual(request());
    expect(parseWhatsAppInteractionProjectionRequest({
      ...request(),
      accountSubject: "whatsapp:pn:01234567890123456789",
    })).toMatchObject({ accountSubject: "whatsapp:pn:01234567890123456789" });
    expect(parseWhatsAppInteractionProjectionRequest({
      ...request(),
      accountSubject: `whatsapp:lid:${"1".repeat(32)}`,
    })).toMatchObject({ accountSubject: `whatsapp:lid:${"1".repeat(32)}` });
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
    expect(parseWhatsAppInteractionProjectionResponse({
      schemaVersion: 1,
      status: "succeeded",
      projectionGeneration: generation(),
      interactions: [{
        ...interaction("42"),
        chatJid: "0@s.whatsapp.net",
        senderJid: null,
        chatKind: "unknown",
      }],
      nextCursor: null,
      localInsertPageComplete: true,
      checkpoint: { cursor: "42", anchor: "d".repeat(64) },
    }, request())).toMatchObject({
      interactions: [{ chatJid: "0@s.whatsapp.net", chatKind: "unknown" }],
    });
    expect(parseWhatsAppInteractionProjectionResponse(
      createWhatsAppInteractionProjectionFailure("schema-mismatch"),
    )).toEqual({ schemaVersion: 1, status: "failed", errorCode: "schema-mismatch" });
    expect(() => parseWhatsAppInteractionProjectionResponse({
      ...createWhatsAppInteractionProjectionFailure("schema-mismatch"),
      detail: "/private/wacli.db",
    })).toThrow();
  });

  test("enforces direction against the exact PN or LID account realm", () => {
    const self = "15551234567@s.whatsapp.net";
    const peer = "15557654321@s.whatsapp.net";
    const group = "120363123456789012@g.us";
    const cases = [
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: null, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: "15557654321:2@s.whatsapp.net", valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: false, senderJid: self, valid: false },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: null, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: self, valid: true },
      { chatKind: "dm", chatJid: peer, fromMe: true, senderJid: peer, valid: false },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: null, valid: true },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: self, valid: true },
      { chatKind: "group", chatJid: group, fromMe: true, senderJid: "15551234567@lid", valid: false },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: null, valid: true },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: "222222222222222:4@lid", valid: true },
      { chatKind: "group", chatJid: group, fromMe: false, senderJid: self, valid: false },
    ] as const;
    for (const candidate of cases) {
      const value = terminal([{
        ...interaction("42"),
        chatKind: candidate.chatKind,
        chatJid: candidate.chatJid,
        fromMe: candidate.fromMe,
        senderJid: candidate.senderJid,
      }]);
      const parse = () => parseWhatsAppInteractionProjectionResponse(value, request());
      if (candidate.valid) expect(parse()).toMatchObject({ status: "succeeded" });
      else expect(parse).toThrow("sender direction");
    }
  });

  test("rejects sparse, accessor, named, symbolic, derived, and proxy interaction arrays", () => {
    const valid = interaction("42");
    const sparse = new Array(1);
    const accessor: unknown[] = [valid];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => valid });
    const named: unknown[] & { note?: string } = [valid];
    named.note = "unreviewed";
    const symbolled: unknown[] = [valid];
    Object.defineProperty(symbolled, Symbol("unreviewed"), { value: true });
    class DerivedArray extends Array<unknown> {}
    for (const interactions of [
      sparse,
      accessor,
      named,
      symbolled,
      new DerivedArray(valid),
      new Proxy([valid], {}),
    ]) {
      expect(() => parseWhatsAppInteractionProjectionResponse(
        terminal(interactions),
        request(),
      )).toThrow("response.interactions did not match");
    }
  });
});
