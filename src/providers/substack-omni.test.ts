import { describe, expect, test } from "bun:test";

import { parseMaterializedPageV1 } from "../omni-model";
import { materializeSubstackMessagingList } from "./substack-omni";

const thread = Object.freeze({
  id: "thread-101",
  type: "people",
  title: "A conversation",
  subtitle: "Last message preview",
  timestamp: "2026-07-23T12:00:00.000Z",
  lastViewedAt: "2026-07-23T11:59:00.000Z",
  user: {
    id: 42,
    name: "Reader",
    handle: "reader",
  },
  publication: {
    id: 7,
    name: "Wrench Publication",
    subdomain: "wrench",
    hostname: "wrench.substack.com",
    baseUrl: "https://wrench.substack.com/",
    authorId: 42,
  },
});

function output(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    folder: "all",
    threads: [thread],
    nextCursor: "next-opaque-cursor",
    more: true,
    pendingInviteCount: 1,
    directMessagesUnreadCount: 2,
    pubChatUnreadCount: 3,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Substack omni inbox materializer", () => {
  test("materializes conversation summaries without inventing messages", () => {
    const page = materializeSubstackMessagingList(
      { folder: "all", limit: 20 },
      output(),
    );
    expect(parseMaterializedPageV1(page)).toEqual(page);
    expect(page).toEqual({
      schemaVersion: 1,
      partition: "substack:inbox:all",
      completeness: {
        kind: "page",
        reason: "Substack reported another inbox page and returned its opaque cursor.",
      },
      cursor: {
        direction: "backward",
        request: null,
        nextInput: {
          folder: "all",
          cursor: "next-opaque-cursor",
          limit: 20,
        },
      },
      entities: [{
        kind: "conversation",
        providerId: "thread-101",
        providerRevision: null,
        orderedAt: "2026-07-23T12:00:00.000Z",
        detail: "summary",
        title: "A conversation",
        summary: "Last message preview",
        participants: [{
          providerId: "42",
          displayName: "Reader",
          handle: "reader",
        }],
        unread: null,
        unreadCount: null,
        archived: null,
        pending: null,
      }],
      tombstones: [],
    });
  });

  test("represents terminal and unknown completeness exactly", () => {
    expect(materializeSubstackMessagingList(
      { folder: "all" },
      output({ nextCursor: null, more: false }),
    )).toMatchObject({
      completeness: { kind: "complete" },
      cursor: { nextInput: null },
    });
    expect(materializeSubstackMessagingList(
      { folder: "all" },
      output({ nextCursor: null, more: null }),
    )).toMatchObject({
      completeness: { kind: "unknown" },
      cursor: { nextInput: null },
    });
    const terminalContinuation = materializeSubstackMessagingList(
      { folder: "all", cursor: "prior-page" },
      output({ nextCursor: null, more: false }),
    );
    expect(terminalContinuation).toMatchObject({
      completeness: {
        kind: "page",
      },
      cursor: { request: "prior-page", nextInput: null },
    });
    expect(terminalContinuation.completeness.reason)
      .toContain("terminal continuation page");
  });

  test("rejects every missing top-level coordinate", () => {
    for (const key of [
      "folder",
      "threads",
      "nextCursor",
      "more",
      "pendingInviteCount",
      "directMessagesUnreadCount",
      "pubChatUnreadCount",
    ] as const) {
      const value = clone(output()) as Record<string, unknown>;
      delete value[key];
      expect(() => materializeSubstackMessagingList(
        { folder: "all" },
        value,
      )).toThrow(`substack omni messaging.list output.${key} is required`);
    }
  });

  test("rejects every missing thread coordinate and unreviewed message content", () => {
    for (const key of Object.keys(thread)) {
      const row = clone(thread) as Record<string, unknown>;
      delete row[key];
      expect(() => materializeSubstackMessagingList(
        { folder: "all" },
        output({ threads: [row] }),
      )).toThrow(`substack omni messaging.list output.threads[0].${key} is required`);
    }
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      output({ threads: [{ ...thread, messages: [] }] }),
    )).toThrow("substack omni messaging.list output.threads[0] contains an unreviewed property");
  });

  test("rejects required-field and type drift at exact provider paths", () => {
    const malformed = {
      id: 7,
      type: 7,
      title: 7,
      subtitle: 7,
      timestamp: "yesterday",
      lastViewedAt: 7,
      user: [],
      publication: [],
    } as const;
    for (const [key, value] of Object.entries(malformed)) {
      expect(() => materializeSubstackMessagingList(
        { folder: "all" },
        output({ threads: [{ ...thread, [key]: value }] }),
      )).toThrow(`substack omni messaging.list output.threads[0].${key}`);
    }
  });

  test("rejects participant and publication drift", () => {
    for (const [key, value] of Object.entries({ id: "42", name: 7, handle: 7 })) {
      expect(() => materializeSubstackMessagingList(
        { folder: "all" },
        output({ threads: [{
          ...thread,
          user: { ...thread.user, [key]: value },
        }] }),
      )).toThrow(`substack omni messaging.list output.threads[0].user.${key}`);
    }
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      output({ threads: [{
        ...thread,
        publication: { ...thread.publication, baseUrl: "http://example.com/" },
      }] }),
    )).toThrow("publication.baseUrl must be an absolute HTTPS URL");
  });

  test("rejects duplicate IDs and contradictory or repeated cursors", () => {
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      output({ threads: [thread, thread] }),
    )).toThrow("duplicate stable thread IDs");
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      output({ nextCursor: null, more: true }),
    )).toThrow("nextCursor is required when more is true");
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      output({ nextCursor: "unexpected", more: false }),
    )).toThrow("nextCursor must be null when more is false");
    expect(() => materializeSubstackMessagingList(
      { folder: "all", cursor: "next-opaque-cursor" },
      output(),
    )).toThrow("nextCursor must advance beyond the input cursor");
  });

  test("rejects folder and aggregate-count drift", () => {
    expect(() => materializeSubstackMessagingList(
      { folder: "people" },
      output(),
    )).toThrow("output.folder must bind messaging.list input.folder");
    for (const key of [
      "pendingInviteCount",
      "directMessagesUnreadCount",
      "pubChatUnreadCount",
    ] as const) {
      expect(() => materializeSubstackMessagingList(
        { folder: "all" },
        output({ [key]: -1 }),
      )).toThrow(`substack omni messaging.list output.${key}`);
    }
  });

  test("rejects foreign containers without executing accessors", () => {
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      new Proxy(output() as object, {}),
    )).toThrow("substack omni messaging.list output must be a plain object");

    let topLevelReads = 0;
    const accessorOutput = clone(output()) as Record<string, unknown>;
    Object.defineProperty(accessorOutput, "threads", {
      enumerable: true,
      get() {
        topLevelReads += 1;
        return [thread];
      },
    });
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      accessorOutput,
    )).toThrow(
      "substack omni messaging.list output.* must be an enumerable data property",
    );
    expect(topLevelReads).toBe(0);

    const symbolOutput = clone(output()) as Record<PropertyKey, unknown>;
    Object.defineProperty(symbolOutput, Symbol("unreviewed"), {
      enumerable: true,
      value: true,
    });
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      symbolOutput,
    )).toThrow("substack omni messaging.list output must not have symbol properties");

    const sparseThreads = new Array<unknown>(2);
    sparseThreads[0] = thread;
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      output({ threads: sparseThreads }),
    )).toThrow("substack omni messaging.list output.threads[1] must not be sparse");

    const namedThreads = Object.assign([thread], { unreviewed: true });
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      output({ threads: namedThreads }),
    )).toThrow(
      "substack omni messaging.list output.threads must be a dense array without named properties",
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
    expect(() => materializeSubstackMessagingList(
      { folder: "all" },
      output({ threads: accessorThreads }),
    )).toThrow(
      "substack omni messaging.list output.threads[0] must be an enumerable data property",
    );
    expect(itemReads).toBe(0);
  });
});
