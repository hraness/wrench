import { describe, expect, test } from "bun:test";

import { parseMaterializedPageV1 } from "../omni-model";
import {
  materializeRedditMessagingList,
  materializeRedditMessagingRead,
} from "./reddit-omni";

const message = Object.freeze({
  kind: "message",
  id: "t4_msg123",
  author: "sender",
  recipient: "viewer",
  subject: "Hello",
  body: "Legacy private message",
  createdUtc: 1_700_000_002,
  unread: true,
  parentId: null,
  context: "https://www.reddit.com/message/messages/msg123",
});

const notification = Object.freeze({
  kind: "notification",
  id: "t1_comment123",
  author: "commenter",
  recipient: "viewer",
  subject: "comment reply",
  body: "A reply",
  createdUtc: 1_700_000_003,
  unread: false,
  parentId: "t3_post123",
  context: "https://www.reddit.com/r/wrench/comments/post123/topic/comment123/",
});

function listOutput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    messages: [message, notification],
    after: "t1_older123",
    before: null,
    requested: null,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Reddit omni inbox materializers", () => {
  test("materializes messages and notifications without inventing conversations", () => {
    const page = materializeRedditMessagingList(
      { folder: "inbox", limit: 25 },
      listOutput(),
    );
    expect(parseMaterializedPageV1(page)).toEqual(page);
    expect(page).toEqual({
      schemaVersion: 1,
      partition: "reddit:inbox:inbox",
      completeness: {
        kind: "page",
        reason: "Reddit returned an older-page cursor for the legacy inbox Listing.",
      },
      cursor: {
        direction: "backward",
        request: null,
        nextInput: {
          folder: "inbox",
          after: "t1_older123",
          limit: 25,
        },
      },
      entities: [
        {
          kind: "message",
          providerId: "t4_msg123",
          providerRevision: null,
          orderedAt: "2023-11-14T22:13:22.000Z",
          conversationProviderId: null,
          sender: {
            providerId: null,
            displayName: "sender",
            handle: "sender",
          },
          recipients: [{
            providerId: null,
            displayName: "viewer",
            handle: "viewer",
          }],
          direction: "incoming",
          subject: "Hello",
          body: "Legacy private message",
          unread: true,
          replyToProviderId: null,
          state: "active",
          attachments: [],
        },
        {
          kind: "notification",
          providerId: "t1_comment123",
          providerRevision: null,
          orderedAt: "2023-11-14T22:13:23.000Z",
          actor: {
            providerId: null,
            displayName: "commenter",
            handle: "commenter",
          },
          subject: "comment reply",
          body: "A reply",
          unread: false,
          context: "https://www.reddit.com/r/wrench/comments/post123/topic/comment123/",
        },
      ],
      tombstones: [],
    });
  });

  test("binds messaging.read to one exact requested message while preserving provider order", () => {
    expect(materializeRedditMessagingRead(
      { folder: "inbox", message_id: "t4_msg123" },
      {
        messages: [message],
        after: null,
        before: null,
        requested: message,
      },
    )).toMatchObject({
      partition: "reddit:message:t4_msg123",
      completeness: { kind: "complete" },
      entities: [{ kind: "message", providerId: "t4_msg123" }],
    });
  });

  test("does not treat a terminal continuation page as a complete partition", () => {
    const terminal = materializeRedditMessagingList(
      { folder: "inbox", after: "t1_older123", limit: 25 },
      listOutput({ after: null }),
    );
    expect(terminal).toMatchObject({
      completeness: {
        kind: "page",
      },
      cursor: { request: "t1_older123", nextInput: null },
    });
    expect(terminal.completeness.reason).toContain("terminal continuation page");
  });

  test("rejects every missing top-level output coordinate", () => {
    for (const key of ["messages", "after", "before", "requested"] as const) {
      const output = clone(listOutput()) as Record<string, unknown>;
      delete output[key];
      expect(() => materializeRedditMessagingList(
        { folder: "inbox" },
        output,
      )).toThrow(`reddit omni output.${key} is required`);
    }
  });

  test("rejects every malformed required message field at its provider path", () => {
    const malformed = {
      kind: 7,
      id: 7,
      author: 7,
      recipient: 7,
      subject: 7,
      body: 7,
      createdUtc: "yesterday",
      unread: "yes",
      parentId: 7,
      context: 7,
    } as const;
    for (const [key, value] of Object.entries(malformed)) {
      const row = { ...message, [key]: value };
      expect(() => materializeRedditMessagingList(
        { folder: "inbox" },
        listOutput({ messages: [row] }),
      )).toThrow(`reddit omni output.messages[0].${key}`);
    }
  });

  test("rejects missing entity fields and unreviewed additions", () => {
    for (const key of Object.keys(message)) {
      const row = clone(message) as Record<string, unknown>;
      delete row[key];
      expect(() => materializeRedditMessagingList(
        { folder: "inbox" },
        listOutput({ messages: [row] }),
      )).toThrow(`reddit omni output.messages[0].${key} is required`);
    }
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      listOutput({ messages: [{ ...message, conversationId: "invented" }] }),
    )).toThrow("reddit omni output.messages[0] contains an unreviewed property");
  });

  test("rejects duplicate IDs, contradictory cursors, and requested-item drift", () => {
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      listOutput({ messages: [message, message] }),
    )).toThrow("duplicate stable IDs");
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      listOutput({ after: "t4_same123", before: "t4_same123" }),
    )).toThrow("must not repeat output.before");
    expect(() => materializeRedditMessagingRead(
      { folder: "inbox", message_id: "t4_msg123" },
      {
        messages: [{ ...message, body: "different" }],
        after: null,
        before: null,
        requested: message,
      },
    )).toThrow("must equal one ordered output.messages entity");
    expect(() => materializeRedditMessagingList(
      { folder: "inbox", after: "t1_older123" },
      listOutput(),
    )).toThrow("output.after must advance beyond messaging.list input.after");
    expect(() => materializeRedditMessagingRead(
      { folder: "inbox", message_id: "t4_msg123" },
      {
        messages: [message],
        after: "t4_older123",
        before: null,
        requested: message,
      },
    )).toThrow("must not paginate an exact messaging.read result");
  });

  test("rejects cursor and kind namespaces that cannot be replayed safely", () => {
    expect(() => materializeRedditMessagingList(
      { folder: "inbox", after: "t3_post123" },
      listOutput(),
    )).toThrow("messaging.list input.after must be an exact t1 or t4 Reddit fullname");
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      listOutput({ after: "t3_post123" }),
    )).toThrow("output.after must be an exact t1 or t4 Reddit fullname");
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      listOutput({ messages: [{ ...notification, id: "t4_wrong123" }] }),
    )).toThrow("output.messages[0].id must be an exact t1 Reddit fullname");
  });

  test("rejects foreign containers without executing accessors", () => {
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      new Proxy(listOutput() as object, {}),
    )).toThrow("reddit omni output must be a plain object");

    let topLevelReads = 0;
    const accessorOutput = clone(listOutput()) as Record<string, unknown>;
    Object.defineProperty(accessorOutput, "messages", {
      enumerable: true,
      get() {
        topLevelReads += 1;
        return [message];
      },
    });
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      accessorOutput,
    )).toThrow("reddit omni output.* must be an enumerable data property");
    expect(topLevelReads).toBe(0);

    const symbolOutput = clone(listOutput()) as Record<PropertyKey, unknown>;
    Object.defineProperty(symbolOutput, Symbol("unreviewed"), {
      enumerable: true,
      value: true,
    });
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      symbolOutput,
    )).toThrow("reddit omni output must not have symbol properties");

    const sparseMessages = new Array<unknown>(2);
    sparseMessages[0] = message;
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      listOutput({ messages: sparseMessages }),
    )).toThrow("reddit omni output.messages[1] must not be sparse");

    const namedMessages = Object.assign([message], { unreviewed: true });
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      listOutput({ messages: namedMessages }),
    )).toThrow("reddit omni output.messages must be a dense array without named properties");

    let itemReads = 0;
    const accessorMessages = [message] as unknown[];
    Object.defineProperty(accessorMessages, 0, {
      enumerable: true,
      get() {
        itemReads += 1;
        return message;
      },
    });
    expect(() => materializeRedditMessagingList(
      { folder: "inbox" },
      listOutput({ messages: accessorMessages }),
    )).toThrow("reddit omni output.messages[0] must be an enumerable data property");
    expect(itemReads).toBe(0);
  });
});
