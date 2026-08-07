import { describe, expect, test } from "bun:test";

import {
  WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
  createWhatsAppContactProjectionFailure,
  isExactWhatsAppContactProjectionMode,
  parseWhatsAppContactProjectionRequest,
  parseWhatsAppContactProjectionResponse,
  parseWhatsAppContactProjectionSubject,
} from "./whatsapp-contact-projection-protocol";

function request() {
  return {
    schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
    operation: "contacts.list",
    accountSubject: "whatsapp:pn:15551234567",
    cursor: null,
    limit: 2,
    storeIdentity: { dev: "1", ino: "2" },
    sessionIdentity: { dev: "1", ino: "3" },
  } as const;
}

function contact(providerId: string) {
  const phone = providerId.endsWith("@s.whatsapp.net")
    ? providerId.slice(0, providerId.indexOf("@"))
    : null;
  return {
    providerId,
    jidKind: phone === null ? "lid" : "user",
    phone,
    redactedPhone: null,
    firstName: null,
    fullName: "Ada Lovelace",
    pushName: "Ada",
    businessName: null,
    displayName: "Ada Lovelace",
    displayNameBasis: "full-name",
  } as const;
}

describe("WhatsApp contact projection protocol", () => {
  test("requires exact private store and session modes including special bits", () => {
    expect(isExactWhatsAppContactProjectionMode(0o600, 0o600)).toBeTrue();
    expect(isExactWhatsAppContactProjectionMode(0o700n, 0o700)).toBeTrue();
    expect(isExactWhatsAppContactProjectionMode(0o100600, 0o600)).toBeTrue();
    expect(isExactWhatsAppContactProjectionMode(0o40700n, 0o700)).toBeTrue();
    for (const mode of [0o1600, 0o2600, 0o4600, 0o640]) {
      expect(isExactWhatsAppContactProjectionMode(mode, 0o600)).toBeFalse();
    }
    for (const mode of [0o1700n, 0o2700n, 0o4700n, 0o750n]) {
      expect(isExactWhatsAppContactProjectionMode(mode, 0o700)).toBeFalse();
    }
  });

  test("parses the exact versioned path-free request for PN and LID subjects", () => {
    expect(parseWhatsAppContactProjectionRequest(request())).toEqual(request());
    expect(parseWhatsAppContactProjectionSubject("whatsapp:lid:222222222222222"))
      .toEqual({
        kind: "lid",
        id: "222222222222222",
        subject: "whatsapp:lid:222222222222222",
      });

    for (const value of [
      { ...request(), databasePath: "/private/contact.db" },
      { ...request(), sql: "SELECT * FROM contacts" },
      { ...request(), command: ["contacts", "list"] },
      { ...request(), limit: 101 },
      { ...request(), cursor: "120363123456789@g.us" },
      { ...request(), cursor: "123456789012345678901@s.whatsapp.net" },
      { ...request(), accountSubject: "whatsapp:pn:+15551234567" },
      { ...request(), sessionIdentity: { dev: "01", ino: "3" } },
    ]) expect(() => parseWhatsAppContactProjectionRequest(value)).toThrow();
  });

  test("parses only ordered bounded success pages with exact contact fields", () => {
    const first = contact("15550000001@s.whatsapp.net");
    const second = {
      ...contact("222222222222222@lid"),
      phone: null,
    };
    expect(parseWhatsAppContactProjectionResponse({
      schemaVersion: 1,
      status: "succeeded",
      contacts: [first, second],
      nextCursor: null,
      localContactTablePageComplete: true,
    }, request())).toEqual({
      schemaVersion: 1,
      status: "succeeded",
      contacts: [first, second],
      nextCursor: null,
      localContactTablePageComplete: true,
    });

    for (const value of [
      {
        schemaVersion: 1,
        status: "succeeded",
        contacts: [second, first],
        nextCursor: null,
        localContactTablePageComplete: true,
      },
      {
        schemaVersion: 1,
        status: "succeeded",
        contacts: [first],
        nextCursor: null,
        localContactTablePageComplete: false,
      },
      {
        schemaVersion: 1,
        status: "succeeded",
        contacts: [first],
        nextCursor: first.providerId,
        localContactTablePageComplete: false,
      },
      {
        schemaVersion: 1,
        status: "succeeded",
        contacts: [{ ...first, phone: "19999999999" }],
        nextCursor: null,
        localContactTablePageComplete: true,
      },
      {
        schemaVersion: 1,
        status: "succeeded",
        contacts: [contact("123456789012345678901@s.whatsapp.net")],
        nextCursor: null,
        localContactTablePageComplete: true,
      },
      {
        schemaVersion: 1,
        status: "succeeded",
        contacts: [{
          ...first,
          displayName: "Ada",
          displayNameBasis: "push-name",
        }],
        nextCursor: null,
        localContactTablePageComplete: true,
      },
      {
        schemaVersion: 1,
        status: "succeeded",
        contacts: [{
          ...first,
          displayName: null,
          displayNameBasis: "unavailable",
        }],
        nextCursor: null,
        localContactTablePageComplete: true,
      },
      {
        schemaVersion: 1,
        status: "succeeded",
        contacts: [{
          ...first,
          firstName: null,
          fullName: null,
          pushName: null,
          businessName: null,
          redactedPhone: null,
          displayName: null,
          displayNameBasis: "full-name",
        }],
        nextCursor: null,
        localContactTablePageComplete: true,
      },
    ]) expect(() => parseWhatsAppContactProjectionResponse(value, request())).toThrow();
  });

  test("accepts only categorical exact failures", () => {
    expect(parseWhatsAppContactProjectionResponse(
      createWhatsAppContactProjectionFailure("schema-mismatch"),
    )).toEqual({
      schemaVersion: 1,
      status: "failed",
      errorCode: "schema-mismatch",
    });
    expect(() => parseWhatsAppContactProjectionResponse({
      schemaVersion: 1,
      status: "failed",
      errorCode: "schema-mismatch",
      detail: "private database path and row",
    })).toThrow();
    expect(() => parseWhatsAppContactProjectionResponse({
      schemaVersion: 1,
      status: "failed",
      errorCode: "/private/store/session.db",
    })).toThrow();
  });
});
