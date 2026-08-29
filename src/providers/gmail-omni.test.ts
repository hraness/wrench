import { describe, expect, test } from "bun:test";

import { parseMaterializedPageV1 } from "../omni-model";
import { buildGmailThreadUrl } from "./gmail-api";
import {
  materializeGmailMessagingList,
  materializeGmailMessagingRead,
} from "./gmail-omni";

const account = "person@example.com";
const omniBodyBytes = 256 * 1024;
const aggregateBodyBytes = 7 * 1024 * 1024;

const summary = Object.freeze({
  id: "thread_1",
  historyId: "91",
  snippet: "Last message preview",
  subject: "Project update",
  orderedAt: "2026-08-05T00:00:00.000Z",
  messageCount: 2,
  participants: [{ email: "friend@example.com", displayName: null }],
  unread: true,
  archived: false,
  threadUrl: buildGmailThreadUrl(account, "thread_1", "inbox"),
  readInput: { thread_id: "thread_1" },
});

function listOutput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    provider: "gmail",
    operation: "messaging.list",
    accountSubject: account,
    view: "inbox",
    query: null,
    includeSpamTrash: false,
    threads: [summary],
    nextCursor: "older-page",
    resultSizeEstimate: 8,
    ...overrides,
  };
}

const message = Object.freeze({
  id: "message_1",
  threadId: "thread_1",
  historyId: "90",
  internalDate: "2026-08-05T00:00:00.000Z",
  labelIds: ["SENT"],
  snippet: "A body",
  from: "Person <person@example.com>",
  to: "Friend <friend@example.com>",
  cc: null,
  bcc: null,
  subject: "Project update",
  date: "Wed, 5 Aug 2026 00:00:00 +0000",
  messageId: "<message-1@example.com>",
  inReplyTo: null,
  body: { text: "A body", source: "text/plain" },
  attachments: [{
    partId: "2",
    contentDisposition: "attachment",
    attachmentId: "opaque+/attachment=id",
    messageId: "message_1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    size: 42,
  }],
});

function readOutput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    provider: "gmail",
    operation: "messaging.read",
    accountSubject: account,
    thread: {
      id: "thread_1",
      snippet: "A body",
      historyId: "91",
      messages: [message],
    },
    threadUrl: buildGmailThreadUrl(account, "thread_1"),
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("Gmail omni materializers", () => {
  test("materializes list summaries as replayable conversations with exact read input", () => {
    const page = materializeGmailMessagingList(
      { view: "inbox", limit: 20 },
      listOutput(),
    );
    expect(parseMaterializedPageV1(page)).toEqual(page);
    expect(page).toEqual({
      schemaVersion: 1,
      partition: "person@example.com:gmail:threads:inbox",
      completeness: {
        kind: "page",
        reason: "Gmail returned an opaque cursor for an older thread-list page.",
      },
      cursor: {
        direction: "backward",
        request: null,
        nextInput: { view: "inbox", cursor: "older-page", limit: 20 },
      },
      entities: [{
        kind: "conversation",
        conversationKind: "unknown",
        providerId: "thread_1",
        providerRevision: "91",
        orderedAt: "2026-08-05T00:00:00.000Z",
        detail: "summary",
        title: "Project update",
        summary: "Last message preview",
        participants: [{
          providerId: "friend@example.com",
          displayName: null,
          handle: "friend@example.com",
        }],
        unread: true,
        unreadCount: null,
        archived: false,
        pending: null,
      }],
      tombstones: [],
    });
  });

  test("claims complete list coverage only for a terminal root page", () => {
    expect(materializeGmailMessagingList(
      { view: "inbox" },
      listOutput({ nextCursor: null }),
    ).completeness.kind).toBe("complete");
    expect(materializeGmailMessagingList(
      { view: "inbox", cursor: "current-page" },
      listOutput({ nextCursor: null }),
    ).completeness.kind).toBe("page");

    const query = "é".repeat(512);
    const search = materializeGmailMessagingList(
      { view: "search", query, include_spam_trash: true },
      listOutput({
        view: "search",
        query,
        includeSpamTrash: true,
        threads: [{
          ...summary,
          threadUrl: buildGmailThreadUrl(account, "thread_1", "all"),
        }],
      }),
    );
    expect(search.partition).toMatch(
      /^person@example\.com:gmail:threads:search:all:[a-f0-9]{64}$/u,
    );
  });

  test("rejects list coordinate drift, duplicate IDs, and incorrect readInput", () => {
    for (const key of [
      "provider",
      "operation",
      "accountSubject",
      "view",
      "query",
      "includeSpamTrash",
      "threads",
      "nextCursor",
      "resultSizeEstimate",
    ] as const) {
      const output = clone(listOutput()) as Record<string, unknown>;
      delete output[key];
      expect(() => materializeGmailMessagingList(
        { view: "inbox" },
        output,
      )).toThrow(`gmail omni messaging.list output.${key} is required`);
    }
    expect(() => materializeGmailMessagingList(
      { view: "inbox", limit: 2 },
      listOutput({ threads: [summary, summary] }),
    )).toThrow("duplicate stable thread IDs");
    expect(() => materializeGmailMessagingList(
      { view: "inbox" },
      listOutput({ threads: [{
        ...summary,
        readInput: { thread_id: "other_thread" },
      }] }),
    )).toThrow("readInput.thread_id must bind the summary thread ID");
    expect(() => materializeGmailMessagingList(
      { view: "inbox", cursor: "older-page" },
      listOutput(),
    )).toThrow("must advance beyond the input cursor");
  });

  test("materializes every full-thread message and attachment metadata", () => {
    const page = materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      readOutput(),
    );
    expect(parseMaterializedPageV1(page)).toEqual(page);
    expect(page).toEqual({
      schemaVersion: 1,
      partition: "person@example.com:gmail:thread:thread_1",
      completeness: {
        kind: "complete",
        reason: "Gmail returned the complete full-MIME representation of the exact requested thread.",
      },
      cursor: { direction: "none", request: null, nextInput: null },
      entities: [{
        kind: "message",
        providerId: "message_1",
        providerRevision: "90",
        orderedAt: "2026-08-05T00:00:00.000Z",
        conversationProviderId: "thread_1",
        sender: {
          providerId: "person@example.com",
          displayName: null,
          handle: "person@example.com",
        },
        recipients: [{
          providerId: "friend@example.com",
          displayName: null,
          handle: "friend@example.com",
        }],
        direction: "outgoing",
        subject: "Project update",
        body: "A body",
        bodyTruncated: false,
        unread: false,
        replyToProviderId: null,
        state: "active",
        attachments: [{
          kind: "document",
          mimeType: "application/pdf",
          name: "report.pdf",
          sizeBytes: 42,
        }],
      }],
      tombstones: [],
    });
  });

  test("uses exact UTF-8-safe body prefixes without changing page completeness", () => {
    const exact = "a".repeat(omniBodyBytes);
    const over = `${exact}z`;
    const splitMultibyte = `${"b".repeat(omniBodyBytes - 1)}💡tail`;
    const exactMultibyte = `${"c".repeat(omniBodyBytes - 2)}éafter`;
    const messages = [
      { ...message, id: "message_exact", body: { text: exact, source: "text/plain" }, attachments: [] },
      { ...message, id: "message_over", body: { text: over, source: "text/plain" }, attachments: [] },
      { ...message, id: "message_split", body: { text: splitMultibyte, source: "text/plain" }, attachments: [] },
      { ...message, id: "message_multibyte", body: { text: exactMultibyte, source: "text/plain" }, attachments: [] },
      { ...message, id: "message_null", body: { text: null, source: "none" }, attachments: [] },
    ];
    const page = materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      readOutput({
        thread: {
          id: "thread_1",
          snippet: "bounded bodies",
          historyId: "91",
          messages,
        },
      }),
    );

    expect(page.completeness.kind).toBe("complete");
    expect(page.entities.map((entity) => entity.kind === "message"
      ? {
          body: entity.body,
          bodyBytes: entity.body === null ? 0 : Buffer.byteLength(entity.body, "utf8"),
          bodyTruncated: entity.bodyTruncated,
        }
      : null)).toEqual([
      { body: exact, bodyBytes: omniBodyBytes, bodyTruncated: false },
      { body: exact, bodyBytes: omniBodyBytes, bodyTruncated: true },
      {
        body: "b".repeat(omniBodyBytes - 1),
        bodyBytes: omniBodyBytes - 1,
        bodyTruncated: true,
      },
      {
        body: `${"c".repeat(omniBodyBytes - 2)}é`,
        bodyBytes: omniBodyBytes,
        bodyTruncated: true,
      },
      { body: null, bodyBytes: 0, bodyTruncated: false },
    ]);
    expect(page.entities[1]?.kind === "message" && page.entities[1].body?.endsWith("…"))
      .toBeFalse();
    expect(parseMaterializedPageV1(page)).toEqual(page);
  });

  test("rechecks the aggregate pre-truncation body ceiling", () => {
    const first = "a".repeat(aggregateBodyBytes / 2);
    const second = "b".repeat(aggregateBodyBytes / 2);
    const output = (secondBody: string) => readOutput({
      thread: {
        id: "thread_1",
        snippet: "aggregate",
        historyId: "91",
        messages: [
          { ...message, id: "message_first", body: { text: first, source: "text/plain" }, attachments: [] },
          { ...message, id: "message_second", body: { text: secondBody, source: "text/plain" }, attachments: [] },
        ],
      },
    });

    expect(materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      output(second),
    ).entities).toHaveLength(2);
    expect(() => materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      output(`${second}x`),
    )).toThrow("exceed the 7340032-byte Gmail aggregate body ceiling");
  });

  test("rejects read binding, body basis, attachment, and shape drift", () => {
    expect(() => materializeGmailMessagingRead(
      { thread_id: "other_thread" },
      readOutput(),
    )).toThrow("must bind messaging.read input.thread_id");
    expect(() => materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      readOutput({ threadUrl: buildGmailThreadUrl("other@example.com", "thread_1") }),
    )).toThrow("must bind the output account, view, and thread ID");
    expect(() => materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      readOutput({
        thread: {
          id: "thread_1",
          snippet: "A body",
          historyId: "91",
          messages: [{ ...message, body: { text: null, source: "text/plain" } }],
        },
      }),
    )).toThrow("must bind body text to its MIME projection source");
    expect(() => materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      readOutput({
        thread: {
          id: "thread_1",
          snippet: "Invalid scalar body",
          historyId: "91",
          messages: [{ ...message, body: { text: "\ud800", source: "text/plain" } }],
        },
      }),
    )).toThrow("must be bounded text without unsafe controls");
    expect(() => materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      readOutput({
        thread: {
          id: "thread_1",
          snippet: "A body",
          historyId: "91",
          messages: [{
            ...message,
            attachments: [{ ...message.attachments[0], messageId: "other_message" }],
          }],
        },
      }),
    )).toThrow("must bind its containing Gmail message");
    const widened = clone(readOutput()) as Record<string, unknown>;
    const thread = widened.thread as Record<string, unknown>;
    const messages = thread.messages as Record<string, unknown>[];
    messages[0] = { ...messages[0], raw: "secret" };
    expect(() => materializeGmailMessagingRead(
      { thread_id: "thread_1" },
      widened,
    )).toThrow("contains an unreviewed property");
  });
});
