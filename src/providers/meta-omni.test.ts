import { describe, expect, test } from "bun:test";

import { parseMaterializedPageV1 } from "../omni-model";
import { materializeInstagramMessagingList } from "./meta-omni";

const participant = Object.freeze({
  id: "12345",
  username: "reader",
  full_name: "Reader",
});

const thread = Object.freeze({
  thread_id: "340282366841710300949128160279579384001",
  thread_title: "Fixture",
  users: [participant],
  last_activity_at: 1_700_000_004,
  read_state: 1,
  pending: false,
});

function output(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    folder: "inbox",
    threads: [thread],
    next_cursor: "opaque-instagram-cursor",
    has_older: true,
    pending_requests_total: 2,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Instagram omni inbox materializer", () => {
  test("materializes conversation summaries without claiming executable continuation", () => {
    const page = materializeInstagramMessagingList(
      { folder: "inbox", limit: 20 },
      output(),
    );
    expect(parseMaterializedPageV1(page)).toEqual(page);
    expect(page).toEqual({
      schemaVersion: 1,
      partition: "instagram:inbox",
      completeness: {
        kind: "first-page-only",
        reason: "Instagram exposed older-page evidence, but authenticated inbox cursor replay remains capture-required.",
      },
      cursor: { direction: "none", request: null, nextInput: null },
      entities: [{
        kind: "conversation",
        providerId: "340282366841710300949128160279579384001",
        providerRevision: null,
        orderedAt: "2023-11-14T22:13:24.000Z",
        detail: "summary",
        title: "Fixture",
        summary: null,
        participants: [{
          providerId: "12345",
          displayName: "Reader",
          handle: "reader",
        }],
        unread: null,
        unreadCount: null,
        archived: null,
        pending: false,
      }],
      tombstones: [],
    });
  });

  test("uses complete only when the provider explicitly reports no older page", () => {
    expect(materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ next_cursor: null, has_older: false }),
    )).toMatchObject({
      completeness: { kind: "complete" },
      cursor: { nextInput: null },
    });
    expect(materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ next_cursor: null, has_older: null }),
    )).toMatchObject({
      completeness: { kind: "first-page-only" },
      cursor: { nextInput: null },
    });
  });

  test("rejects cursor input because observed Instagram pagination is capture-required", () => {
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox", cursor: "opaque-instagram-cursor" },
      output(),
    )).toThrow("messaging.list input.cursor is capture-required");
  });

  test("rejects every missing top-level coordinate", () => {
    for (const key of [
      "folder",
      "threads",
      "next_cursor",
      "has_older",
      "pending_requests_total",
    ] as const) {
      const value = clone(output()) as Record<string, unknown>;
      delete value[key];
      expect(() => materializeInstagramMessagingList(
        { folder: "inbox" },
        value,
      )).toThrow(`instagram omni messaging.list output.${key} is required`);
    }
  });

  test("rejects every missing thread coordinate and unreviewed message content", () => {
    for (const key of Object.keys(thread)) {
      const row = clone(thread) as Record<string, unknown>;
      delete row[key];
      expect(() => materializeInstagramMessagingList(
        { folder: "inbox" },
        output({ threads: [row] }),
      )).toThrow(`instagram omni messaging.list output.threads[0].${key} is required`);
    }
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ threads: [{ ...thread, messages: [] }] }),
    )).toThrow("instagram omni messaging.list output.threads[0] contains an unreviewed property");
  });

  test("rejects required-field and type drift at exact provider paths", () => {
    const malformed = {
      thread_id: 7,
      thread_title: 7,
      users: {},
      last_activity_at: "yesterday",
      read_state: "read",
      pending: "no",
    } as const;
    for (const [key, value] of Object.entries(malformed)) {
      expect(() => materializeInstagramMessagingList(
        { folder: "inbox" },
        output({ threads: [{ ...thread, [key]: value }] }),
      )).toThrow(`instagram omni messaging.list output.threads[0].${key}`);
    }
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ threads: [{ ...thread, thread_id: "not-decimal" }] }),
    )).toThrow("thread_id must be a stable nonzero decimal thread ID");
  });

  test("requires durable participant identities and rejects participant drift", () => {
    for (const [key, value] of Object.entries({
      id: null,
      username: 7,
      full_name: 7,
    })) {
      expect(() => materializeInstagramMessagingList(
        { folder: "inbox" },
        output({ threads: [{
          ...thread,
          users: [{ ...participant, [key]: value }],
        }] }),
      )).toThrow(`instagram omni messaging.list output.threads[0].users[0].${key}`);
    }
  });

  test("rejects duplicate entities and participants", () => {
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ threads: [thread, thread] }),
    )).toThrow("duplicate stable thread IDs");
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ threads: [{ ...thread, users: [participant, participant] }] }),
    )).toThrow("duplicate participant IDs");
  });

  test("rejects contradictory cursor and completeness evidence", () => {
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ next_cursor: null, has_older: true }),
    )).toThrow("next_cursor is required when has_older is true");
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ next_cursor: "unexpected", has_older: false }),
    )).toThrow("next_cursor must be null when has_older is false");
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ pending_requests_total: -1 }),
    )).toThrow("pending_requests_total must be an integer");
  });

  test("rejects foreign containers without executing accessors", () => {
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      new Proxy(output() as object, {}),
    )).toThrow("instagram omni messaging.list output must be a plain object");

    let topLevelReads = 0;
    const accessorOutput = clone(output()) as Record<string, unknown>;
    Object.defineProperty(accessorOutput, "threads", {
      enumerable: true,
      get() {
        topLevelReads += 1;
        return [thread];
      },
    });
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      accessorOutput,
    )).toThrow(
      "instagram omni messaging.list output.* must be an enumerable data property",
    );
    expect(topLevelReads).toBe(0);

    const symbolOutput = clone(output()) as Record<PropertyKey, unknown>;
    Object.defineProperty(symbolOutput, Symbol("unreviewed"), {
      enumerable: true,
      value: true,
    });
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      symbolOutput,
    )).toThrow("instagram omni messaging.list output must not have symbol properties");

    const sparseThreads = new Array<unknown>(2);
    sparseThreads[0] = thread;
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ threads: sparseThreads }),
    )).toThrow("instagram omni messaging.list output.threads[1] must not be sparse");

    const namedThreads = Object.assign([thread], { unreviewed: true });
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ threads: namedThreads }),
    )).toThrow(
      "instagram omni messaging.list output.threads must be a dense array without named properties",
    );

    let itemReads = 0;
    const accessorThreads = [thread] as unknown[];
    Object.defineProperty(accessorThreads, 0, {
      enumerable: true,
      get() {
        itemReads += 1;
        return thread;
      },
    });
    expect(() => materializeInstagramMessagingList(
      { folder: "inbox" },
      output({ threads: accessorThreads }),
    )).toThrow(
      "instagram omni messaging.list output.threads[0] must be an enumerable data property",
    );
    expect(itemReads).toBe(0);
  });
});
