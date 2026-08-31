import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  TELEGRAM_TDLIB_OPERATIONS,
  TELEGRAM_TDLIB_PIN,
  pageTelegramContacts,
  parseTelegramContactsListInput,
  parseTelegramTdlibCaptureEnvelope,
  parseTelegramTdlibHelperIdentity,
  parseTelegramTdlibProjection,
  parseTelegramUserId,
  telegramSubject,
  telegramTdlibRequest,
} from "./telegram-tdlib";

const commit = TELEGRAM_TDLIB_PIN.sourceCommit;

function contact(
  userId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    userId,
    firstName: `User ${userId}`,
    lastName: "Fixture",
    displayName: `User ${userId} Fixture`,
    username: `user_${userId}`,
    phoneNumber: "15550000000",
    isMutualContact: true,
    isPremium: false,
    isVerified: false,
    ...overrides,
  });
}

function projection(contacts: readonly unknown[]): unknown {
  return {
    schemaVersion: 1,
    sourceCommit: commit,
    accountSubject: "telegram:user:7000000001",
    contacts,
  };
}

describe("Telegram TDLib protocol", () => {
  test("pins the official user-client transport and exposes only contacts.list R1", () => {
    expect(TELEGRAM_TDLIB_PIN).toMatchObject({
      implementation: "github.com/tdlib/td+wrench-telegram-tdlib",
      version: "1.8.67",
      sourceCommit: "d1085f9cebc5a62379991ae1652673954f229c1f",
      helperProtocolVersion: 1,
    });
    expect(TELEGRAM_TDLIB_OPERATIONS).toEqual({
      "contacts.list": {
        effect: "read",
        risk: "R1",
        state: "observed",
        reason: expect.stringContaining("without opening TDLib"),
      },
    });
    expect(JSON.stringify(TELEGRAM_TDLIB_PIN)).not.toContain("bot");
  });

  test("requires TDLib to return one complete bounded contact identity set", () => {
    const helperSource = readFileSync(fileURLToPath(new URL(
      "../vendor/telegram-tdlib/wrench_telegram_tdlib.cpp",
      import.meta.url,
    )), "utf8");
    expect(helperSource).toContain("contacts->total_count_ < 0 ||");
    expect(helperSource).toContain(
      "static_cast<std::size_t>(contacts->total_count_) !=\n                contacts->user_ids_.size()",
    );
    expect(helperSource).toContain("contacts->user_ids_.size() > kMaximumContacts");
  });

  test("forces a fresh contact load without retaining chat or message databases", () => {
    const helperSource = readFileSync(fileURLToPath(new URL(
      "../vendor/telegram-tdlib/wrench_telegram_tdlib.cpp",
      import.meta.url,
    )), "utf8");
    expect(helperSource).toContain("parameters->use_chat_info_database_ = false;");
    expect(helperSource).toContain("parameters->use_message_database_ = false;");
    expect(helperSource).not.toContain("parameters->use_chat_info_database_ = true;");
  });

  test("encodes the only three strict helper requests and keeps phone in stdin", () => {
    expect(telegramTdlibRequest("identity"))
      .toBe('{"schemaVersion":1,"operation":"identity"}\n');
    expect(telegramTdlibRequest("sync"))
      .toBe('{"schemaVersion":1,"operation":"sync"}\n');
    expect(telegramTdlibRequest("pair"))
      .toBe('{"schemaVersion":1,"operation":"pair","phone":null}\n');
    expect(telegramTdlibRequest("pair", { phone: "+15551234567" }))
      .toBe('{"schemaVersion":1,"operation":"pair","phone":"+15551234567"}\n');
    expect(() => telegramTdlibRequest("pair", { phone: "token:value" }))
      .toThrow("international number");
    expect(() => telegramTdlibRequest("sync", { phone: "+15551234567" }))
      .toThrow("only for pairing");
  });

  test("accepts only the exact embedded helper identity", () => {
    const identity = {
      schemaVersion: 1,
      operation: "identity",
      status: "ok",
      implementation: "wrench-telegram-tdlib",
      tdlibVersion: "1.8.67",
      sourceCommit: commit,
    } as const;
    expect(parseTelegramTdlibHelperIdentity(identity)).toEqual(identity);
    expect(() => parseTelegramTdlibHelperIdentity({ ...identity, botApi: true }))
      .toThrow("unreviewed property");
    expect(() => parseTelegramTdlibHelperIdentity({ ...identity, sourceCommit: "0".repeat(40) }))
      .toThrow("reviewed runtime");
  });

  test("parses a sorted bounded projection and canonical nameless fallbacks", () => {
    const value = parseTelegramTdlibProjection(projection([
      contact("2", {
        firstName: "",
        lastName: "",
        displayName: "fixture_user",
        username: "fixture_user",
        phoneNumber: null,
      }),
      contact("10", {
        firstName: "",
        lastName: "",
        displayName: "Telegram user 10",
        username: null,
      }),
    ]));
    expect(value.contacts.map(({ userId }) => userId)).toEqual(["2", "10"]);
    expect(value.contacts[0]?.displayName).toBe("fixture_user");
    expect(value.contacts[1]?.displayName).toBe("Telegram user 10");
  });

  test("rejects duplicate, lexicographically sorted, malformed, and accessor data", () => {
    expect(() => parseTelegramTdlibProjection(projection([contact("10"), contact("2")])))
      .toThrow("ascending numeric order");
    expect(() => parseTelegramTdlibProjection(projection([contact("2"), contact("2")])))
      .toThrow("unique user IDs");
    expect(() => parseTelegramTdlibProjection(projection([
      contact("2", { displayName: "wrong" }),
    ]))).toThrow("canonical name");
    expect(() => parseTelegramTdlibProjection(projection([
      contact("2", { firstName: "\ud800", displayName: "\ud800 Fixture" }),
    ]))).toThrow("well-formed text");
    const accessor = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => parseTelegramTdlibProjection(accessor))
      .toThrow("enumerable data properties");
    expect(() => parseTelegramTdlibProjection(new Proxy(projection([]) as object, {})))
      .toThrow("plain object");
  });

  test("validates numeric IDs, subjects, cursor, and the manifest-aligned limit", () => {
    expect(parseTelegramUserId("9007199254740991")).toBe("9007199254740991");
    expect(telegramSubject("telegram:user:42")).toBe("telegram:user:42");
    for (const value of ["0", "01", "9007199254740992", "-1", 1]) {
      expect(() => parseTelegramUserId(value)).toThrow("canonical positive");
    }
    expect(parseTelegramContactsListInput({ cursor: "10", limit: 200 }))
      .toEqual({ cursor: "10", limit: 200 });
    expect(parseTelegramContactsListInput({})).toEqual({ cursor: null, limit: 50 });
    expect(() => parseTelegramContactsListInput({ limit: 201 })).toThrow("between 1 and 200");
    expect(() => parseTelegramContactsListInput({ query: "unbounded" })).toThrow("unreviewed");
  });

  test("pages by exclusive numeric cursor in deterministic user-ID order", () => {
    const source = parseTelegramTdlibProjection(projection([
      contact("2"),
      contact("10"),
      contact("100"),
    ]));
    expect(pageTelegramContacts(source, { cursor: null, limit: 2 })).toMatchObject({
      contacts: [{ userId: "2" }, { userId: "10" }],
      nextCursor: "10",
      pageComplete: false,
    });
    expect(pageTelegramContacts(source, { cursor: "10", limit: 2 })).toMatchObject({
      contacts: [{ userId: "100" }],
      nextCursor: null,
      pageComplete: true,
    });
    expect(pageTelegramContacts(source, { cursor: "11", limit: 2 })).toMatchObject({
      contacts: [{ userId: "100" }],
      nextCursor: null,
      pageComplete: true,
    });
  });

  test("binds capture envelopes to operation, source, subject, and projection", () => {
    const response = {
      ...(projection([contact("2")]) as Record<string, unknown>),
      operation: "sync",
      status: "ok",
    };
    expect(parseTelegramTdlibCaptureEnvelope(response, "sync").contacts).toHaveLength(1);
    expect(() => parseTelegramTdlibCaptureEnvelope(response, "pair"))
      .toThrow("unexpected operation");
  });
});
