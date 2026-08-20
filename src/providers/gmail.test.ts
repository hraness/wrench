import { describe, expect, test } from "bun:test";

import type { OperationInput } from "../model";
import type { ProviderActionContext } from "../provider-context";
import { ProviderHttpClient, type ProviderFetch } from "../provider-http";
import { executeGmailProvider } from "./gmail";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function urlOf(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

function profile(emailAddress = "person@example.com") {
  return {
    emailAddress,
    messagesTotal: 100,
    threadsTotal: 50,
    historyId: "900",
  };
}

function metadataPayload(headers: readonly { readonly name: string; readonly value: string }[]) {
  return {
    partId: "",
    mimeType: "multipart/alternative",
    filename: "",
    headers,
    body: { size: 0 },
  };
}

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toContain(message);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function harness(
  action: "contacts.list" | "messaging.list" | "messaging.read",
  input: OperationInput,
  fetch: ProviderFetch,
  contractVersion = action === "contacts.list" ? 5 : 1,
) {
  let output: unknown;
  let finalUrl: string | null = null;
  let dispatches = 0;
  const context = {
    recipe: {
      provider: "gmail",
      action,
      contractVersion,
      timeoutMs: 30_000,
      maxOutputBytes: 16 * 1024 * 1024,
    },
    input,
    auth: {
      kind: "oauth-token-file",
      id: "gmail-test",
      provider: "gmail",
      subject: "Person@Example.com",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/contacts.other.readonly",
      ],
      path: "/private/test-token.json",
    },
    token: { accessToken: "unit-test-access-token", expiresAt: null },
    http: new ProviderHttpClient(fetch, 30_000, 16 * 1024 * 1024),
    beginDispatch: () => {
      dispatches += 1;
      return Promise.resolve({ verify: () => Promise.resolve() });
    },
    dispatch: () => {
      dispatches += 1;
      return Promise.reject(new Error("read provider must not dispatch"));
    },
    setOutput: (value: unknown) => { output = value; },
    setFinalUrl: (value: string) => { finalUrl = value; },
  } as unknown as ProviderActionContext;
  return {
    context,
    output: () => output,
    finalUrl: () => finalUrl,
    dispatches: () => dispatches,
  };
}

describe("official Gmail provider reads", () => {
  test("scans mailbox metadata once and projects directional relationship filters", async () => {
    const before = "2026-08-14T12:00:00.000Z";
    const messages = [{
      id: "message_1",
      threadId: "thread_a",
      labelIds: ["SENT"],
      internalDate: "2026-08-10T12:00:00.000Z",
      headers: [
        { name: "From", value: "person@example.com" },
        { name: "To", value: "Friend <friend@example.com>, person@example.com, friend@example.com" },
        { name: "Cc", value: "friend@example.com, other@example.com" },
      ],
    }, {
      id: "message_2",
      threadId: "thread_a",
      labelIds: ["INBOX"],
      internalDate: "2025-01-01T00:00:00.000Z",
      headers: [{ name: "From", value: "Friend <friend@example.com>" }],
    }, {
      id: "message_3",
      threadId: "thread_b",
      labelIds: ["INBOX"],
      internalDate: "2026-04-01T00:00:00.000Z",
      headers: [{ name: "From", value: "friend@example.com" }],
    }, {
      id: "message_4",
      threadId: "thread_b",
      labelIds: ["SENT"],
      internalDate: "2026-06-01T00:00:00.000Z",
      headers: [{ name: "To", value: "friend@example.com" }],
    }, {
      id: "message_5",
      threadId: "thread_draft",
      labelIds: ["DRAFT"],
      internalDate: "2026-08-12T00:00:00.000Z",
      headers: [{ name: "To", value: "friend@example.com" }],
    }, {
      id: "message_6",
      threadId: "thread_c",
      labelIds: ["INBOX"],
      internalDate: null,
      headers: [{ name: "From", value: "friend@example.com" }],
    }, {
      id: "message_7",
      threadId: "thread_chat",
      labelIds: ["CHAT"],
      internalDate: "2026-08-13T00:00:00.000Z",
      headers: [{ name: "From", value: "friend@example.com" }],
    }] as const;
    const requests: URL[] = [];
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/settings/sendAs")) {
        return Promise.resolve(json({
          sendAs: [{ sendAsEmail: "person@example.com", verificationStatus: "accepted" }],
        }));
      }
      if (url.pathname.endsWith("/messages")) {
        return Promise.resolve(json({
          messages: messages.map((message) => ({
            id: message.id,
            threadId: message.threadId,
          })),
          nextPageToken: "older-messages",
          resultSizeEstimate: 2_345,
        }));
      }
      const message = messages.find((candidate) =>
        url.pathname.endsWith(`/messages/${candidate.id}`));
      if (message !== undefined) {
        return Promise.resolve(json({
          id: message.id,
          threadId: message.threadId,
          labelIds: message.labelIds,
          ...(message.internalDate === null
            ? {}
            : { internalDate: String(new Date(message.internalDate).getTime()) }),
          payload: { headers: message.headers },
        }));
      }
      throw new Error(`unexpected request ${url.href}`);
    };
    const run = harness("contacts.list", {
      collection: "interactions",
      before,
      cursor: "newer-page",
      limit: 7,
    }, fetch);

    await executeGmailProvider(run.context);

    const listRequest = requests.find((url) => url.pathname.endsWith("/messages"));
    expect(listRequest?.searchParams.get("q")).toBe(
      `before:${String(new Date(before).getTime() / 1_000)}`,
    );
    expect(listRequest?.searchParams.get("includeSpamTrash")).toBe("false");
    expect(listRequest?.searchParams.get("pageToken")).toBe("newer-page");
    const metadataRequests = requests.filter((url) =>
      url.searchParams.get("format") === "metadata");
    expect(metadataRequests).toHaveLength(7);
    for (const request of metadataRequests) {
      expect(request.searchParams.get("fields"))
        .toBe("id,threadId,labelIds,internalDate,payload(headers(name,value))");
      expect(request.searchParams.getAll("metadataHeaders"))
        .toEqual(["From", "To", "Cc", "Bcc"]);
    }
    expect(run.dispatches()).toBe(0);
    expect(run.output()).toMatchObject({
      provider: "gmail",
      operation: "contacts.list",
      contactCollection: "interactions",
      accountSubject: "person@example.com",
      accountAddresses: [],
      after: null,
      before,
      interactions: [{
        email: "friend@example.com",
        sentCount: 2,
        receivedCount: 2,
        sentCountComplete: true,
        receivedCountComplete: false,
        firstSentAt: "2026-06-01T00:00:00.000Z",
        lastSentAt: "2026-08-10T12:00:00.000Z",
        firstReceivedAt: "2025-01-01T00:00:00.000Z",
        lastReceivedAt: "2026-04-01T00:00:00.000Z",
        sent30d: 1,
        sent90d: 2,
        sent365d: 2,
        received30d: 0,
        received90d: 0,
        received365d: 1,
      }, {
        email: "other@example.com",
        sentCount: 1,
        receivedCount: 0,
      }],
      messagesScanned: 7,
      messagesIncluded: 4,
      messagesSkipped: {
        draftOrChat: 2,
        missingInternalDate: 1,
        noExternalAddress: 0,
        outsideWindow: 0,
      },
      nextCursor: "older-messages",
      resultSizeEstimate: 2_345,
      scanScope: "messages-in-half-open-window-excluding-spam-trash-drafts-chats",
    });
    const output = run.output() as {
      readonly messageKeys: readonly string[];
      readonly threadKeys: readonly string[];
    };
    expect(output.messageKeys).toHaveLength(7);
    expect(output.threadKeys).toHaveLength(5);
    expect(output.messageKeys.every((key) => /^[0-9a-f]{64}$/u.test(key))).toBeTrue();
    expect(JSON.stringify(output)).not.toContain("message_1");
    expect(JSON.stringify(output)).not.toContain("thread_a");
  });

  test("rejects a non-canonical interaction cutoff before account preflight", async () => {
    let requests = 0;
    const run = harness("contacts.list", {
      collection: "interactions",
      before: "2026-08-14T12:00:00Z",
    }, () => {
      requests += 1;
      return Promise.resolve(json(profile()));
    });
    await expectRejected(
      executeGmailProvider(run.context),
      "must be a canonical whole-second UTC timestamp",
    );
    expect(requests).toBe(0);
  });

  test("scans one exact incremental Gmail window with a guarded lower-bound overlap", async () => {
    const after = "2026-08-14T12:00:00.000Z";
    const before = "2026-08-14T13:00:00.000Z";
    const messages = [{
      id: "overlap",
      threadId: "thread_overlap",
      labelIds: ["INBOX"],
      internalDate: "2026-08-14T11:59:59.999Z",
      headers: [{ name: "From", value: "old@example.com" }],
    }, {
      id: "boundary",
      threadId: "thread_boundary",
      labelIds: ["INBOX"],
      internalDate: after,
      headers: [{ name: "From", value: "friend@example.com" }],
    }, {
      id: "new-message",
      threadId: "thread_new",
      labelIds: ["SENT"],
      internalDate: "2026-08-14T12:30:00.000Z",
      headers: [{ name: "To", value: "friend@example.com" }],
    }] as const;
    let listQuery: string | null = null;
    const fetch: ProviderFetch = input => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/settings/sendAs")) {
        return Promise.resolve(json({
          sendAs: [
            { sendAsEmail: "person@example.com", verificationStatus: "accepted" },
            { sendAsEmail: "alias@example.com", verificationStatus: "accepted" },
          ],
        }));
      }
      if (url.pathname.endsWith("/messages")) {
        listQuery = url.searchParams.get("q");
        return Promise.resolve(json({
          messages: messages.map(message => ({ id: message.id, threadId: message.threadId })),
          resultSizeEstimate: messages.length,
        }));
      }
      const message = messages.find(candidate => url.pathname.endsWith(`/messages/${candidate.id}`));
      if (message === undefined) throw new Error(`unexpected request ${url.href}`);
      return Promise.resolve(json({
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labelIds,
        internalDate: String(new Date(message.internalDate).getTime()),
        payload: { headers: message.headers },
      }));
    };
    const run = harness("contacts.list", {
      collection: "interactions",
      after,
      before,
      limit: 3,
    }, fetch);

    await executeGmailProvider(run.context);

    expect(String(listQuery)).toBe(
      `after:${String(new Date(after).getTime() / 1_000 - 1)} ` +
        `before:${String(new Date(before).getTime() / 1_000)}`,
    );
    expect(run.output()).toMatchObject({
      after,
      before,
      accountAddresses: ["alias@example.com", "person@example.com"],
      interactions: [{
        email: "friend@example.com",
        sentCount: 1,
        receivedCount: 1,
      }],
      messagesScanned: 3,
      messagesIncluded: 2,
      messagesSkipped: {
        draftOrChat: 0,
        missingInternalDate: 0,
        noExternalAddress: 0,
        outsideWindow: 1,
      },
    });
  });

  test("preflights the account, expands list stubs with metadata, and emits exact readInput", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetch: ProviderFetch = (input, init = {}) => {
      const url = urlOf(input);
      requests.push({ url, init });
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/threads")) {
        return Promise.resolve(json({
          threads: [{ id: "thread_1", snippet: "stub", historyId: "10" }],
          nextPageToken: "older-page",
          resultSizeEstimate: 8,
        }));
      }
      if (url.pathname.endsWith("/threads/thread_1")) {
        return Promise.resolve(json({
          id: "thread_1",
          snippet: "expanded preview",
          historyId: "11",
          messages: [{
            id: "message_1",
            threadId: "thread_1",
            labelIds: ["INBOX", "UNREAD"],
            snippet: "expanded preview",
            historyId: "11",
            internalDate: "1785888000000",
            payload: metadataPayload([
              { name: "From", value: "Friend <friend@example.com>" },
              { name: "To", value: "Person <person@example.com>" },
              { name: "Subject", value: "Hello" },
            ]),
          }],
        }));
      }
      throw new Error(`unexpected request ${url.href}`);
    };
    const run = harness("messaging.list", { view: "inbox", limit: 20 }, fetch);
    await executeGmailProvider(run.context);

    expect(requests[0]?.url.pathname).toEndWith("/profile");
    expect(requests.every((request) => request.init.method === "GET")).toBeTrue();
    expect(run.dispatches()).toBe(0);
    expect(run.output()).toMatchObject({
      provider: "gmail",
      operation: "messaging.list",
      accountSubject: "person@example.com",
      view: "inbox",
      threads: [{
        id: "thread_1",
        historyId: "11",
        subject: "Hello",
        messageCount: 1,
        unread: true,
        archived: false,
        threadUrl: "https://mail.google.com/mail/u/person%40example.com/#inbox/thread_1",
        readInput: { thread_id: "thread_1" },
      }],
      nextCursor: "older-page",
      resultSizeEstimate: 8,
    });
    expect(requests[1]?.url.searchParams.getAll("labelIds")).toEqual(["INBOX"]);
    expect(requests[2]?.url.searchParams.get("format")).toBe("metadata");
  });

  test("accepts the contract's code-unit query bound and rejects inbox-only shape drift before HTTP", async () => {
    const query = "é".repeat(512);
    const requests: URL[] = [];
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      return Promise.resolve(json({ resultSizeEstimate: 0 }));
    };
    const run = harness("messaging.list", {
      view: "search",
      query,
      include_spam_trash: true,
    }, fetch);
    await executeGmailProvider(run.context);
    expect(requests[1]?.searchParams.get("q")).toBe(query);
    expect(requests[1]?.searchParams.get("includeSpamTrash")).toBe("true");

    const invalid = harness("messaging.list", {
      view: "inbox",
      include_spam_trash: false,
    }, () => {
      throw new Error("invalid input must not make an HTTP request");
    });
    await expectRejected(
      executeGmailProvider(invalid.context),
      "is accepted only when view is search",
    );
    const overlong = harness("messaging.list", {
      view: "search",
      query: "a".repeat(513),
    }, () => {
      throw new Error("invalid input must not make an HTTP request");
    });
    await expectRejected(
      executeGmailProvider(overlong.context),
      "at most 512",
    );
    const unpaired = harness("messaging.list", {
      view: "search",
      query: `from:friend@example.com${String.fromCharCode(0xd800)}`,
    }, () => {
      throw new Error("ill-formed input must not make an HTTP request");
    });
    await expectRejected(
      executeGmailProvider(unpaired.context),
      "without unsafe controls",
    );
  });

  test("reads a full MIME thread without acknowledgement or attachment bytes in output", async () => {
    const rawAttachment = new Uint8Array([9, 8, 7]);
    const externalBody = "body";
    const requests: { url: URL; init: RequestInit }[] = [];
    const fetch: ProviderFetch = (input, init = {}) => {
      const url = urlOf(input);
      requests.push({ url, init });
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/attachments/external-body")) {
        return Promise.resolve(json({
          size: Buffer.byteLength(externalBody),
          data: Buffer.from(externalBody).toString("base64url"),
        }));
      }
      return Promise.resolve(json({
        id: "thread_1",
        snippet: "preview",
        historyId: "21",
        messages: [{
          id: "message_1",
          threadId: "thread_1",
          labelIds: ["SENT"],
          snippet: "body",
          historyId: "20",
          internalDate: "1785888000000",
          payload: {
            partId: "",
            mimeType: "multipart/mixed",
            filename: "",
            headers: [
              { name: "From", value: "person@example.com" },
              { name: "To", value: "friend@example.com" },
              { name: "Subject", value: "Full thread" },
            ],
            body: { size: 0 },
            parts: [{
              partId: "1",
              mimeType: "text/plain",
              filename: "",
              headers: [{ name: "Content-Disposition", value: "inline" }],
              body: {
                attachmentId: "external-body",
                size: Buffer.byteLength(externalBody),
              },
            }, {
              partId: "2",
              mimeType: "image/png",
              filename: "pixel.png",
              headers: [],
              body: {
                size: rawAttachment.byteLength,
                data: Buffer.from(rawAttachment).toString("base64url"),
              },
            }],
          },
        }],
      }));
    };
    const run = harness("messaging.read", { thread_id: "thread_1" }, fetch);
    await executeGmailProvider(run.context);
    expect(run.dispatches()).toBe(0);
    expect(requests.every((request) => request.init.method === "GET")).toBeTrue();
    expect(requests[1]?.url.searchParams.get("format")).toBe("full");
    expect(requests[2]?.url.pathname).toEndWith(
      "/messages/message_1/attachments/external-body",
    );
    expect(run.output()).toMatchObject({
      provider: "gmail",
      operation: "messaging.read",
      thread: {
        id: "thread_1",
        messages: [{
          body: { text: "body", source: "text/plain" },
          attachments: [{
            partId: "2",
            contentDisposition: null,
            attachmentId: null,
            messageId: "message_1",
            filename: "pixel.png",
            mimeType: "image/png",
            size: 3,
          }],
        }],
      },
    });
    expect(JSON.stringify(run.output())).not.toContain(
      Buffer.from(rawAttachment).toString("base64url"),
    );
    expect(run.finalUrl()).toBe(
      "https://mail.google.com/mail/u/person%40example.com/#all/thread_1",
    );
  });

  test("counts exact per-contact directional searches with explicit lower bounds and date basis", async () => {
    const requests: URL[] = [];
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/connections")) {
        return Promise.resolve(json({
          connections: [{ resourceName: "people/c1" }],
          totalItems: 1,
        }));
      }
      if (url.pathname.endsWith("/people:batchGet")) {
        return Promise.resolve(json({
          responses: [{
            requestedResourceName: "people/c1",
            status: {},
            person: {
              resourceName: "people/c1",
              etag: "contact-etag",
              emailAddresses: [{ value: "Friend+Tag|Ops*{x}@Example.com", type: "work" }, {
                value: "friend+tag|ops*{x}@example.com", type: "other",
              }],
              names: [{ displayName: "Friend", givenName: "Ada", middleName: "M" }],
              birthdays: [{ date: { month: 2, day: 3 } }],
              photos: [{
                url: "https://lh3.googleusercontent.com/photo?signed=secret",
                default: false,
              }],
            },
          }],
        }));
      }
      if (url.pathname.endsWith("/messages")) {
        const query = url.searchParams.get("q") ?? "";
        if (query.startsWith("in:sent")) {
          expect(query).toContain('to:"friend+tag|ops*{x}@example.com"');
          expect(query).toContain('cc:"friend+tag|ops*{x}@example.com"');
          return Promise.resolve(json({
            messages: [{ id: "sent_1", threadId: "sent_thread" }, {
              id: "sent_2", threadId: "sent_thread",
            }],
            nextPageToken: "sent-next",
            resultSizeEstimate: 9,
          }));
        }
        expect(query).toBe('-in:sent {from:"friend+tag|ops*{x}@example.com"}');
        return Promise.resolve(json({
          messages: [{ id: "received_1", threadId: "received_thread" }],
          resultSizeEstimate: 1,
        }));
      }
      if (url.pathname.endsWith("/messages/sent_1")) {
        return Promise.resolve(json({
          id: "sent_1",
          threadId: "sent_thread",
          labelIds: ["SENT"],
          internalDate: "1785888000000",
          payload: metadataPayload([]),
        }));
      }
      if (url.pathname.endsWith("/messages/sent_2")) {
        return Promise.resolve(json({
          id: "sent_2",
          threadId: "sent_thread",
          labelIds: ["SENT"],
          internalDate: "1785974400000",
          payload: metadataPayload([]),
        }));
      }
      if (url.pathname.endsWith("/messages/received_1")) {
        return Promise.resolve(json({
          id: "received_1",
          threadId: "received_thread",
          labelIds: ["INBOX"],
          payload: metadataPayload([]),
        }));
      }
      throw new Error(`unexpected request ${url.href}`);
    };
    const run = harness("contacts.list", {
      include_dates: true,
      limit: 1,
      stats_scan_limit: 2,
    }, fetch);
    await executeGmailProvider(run.context);
    expect(run.dispatches()).toBe(0);
    expect(run.output()).toMatchObject({
      contactCollection: "contacts",
      contacts: [{
        resourceName: "people/c1",
        emailAddresses: [{
          value: "Friend+Tag|Ops*{x}@Example.com",
          canonicalValue: "friend+tag|ops*{x}@example.com",
          type: "work",
        }],
        photoUrl: null,
        name: { displayName: "Friend", givenName: "Ada", middleName: "M" },
        birthdays: [{ date: { year: 0, month: 2, day: 3 } }],
        sentCount: 2,
        sentCountComplete: false,
        sentCountLowerBound: true,
        sentCountTruncated: true,
        sentStatsIncompleteReasons: ["scan-limit-reached"],
        receivedCount: 1,
        receivedCountComplete: true,
        receivedCountLowerBound: false,
        receivedCountTruncated: false,
        receivedStatsIncompleteReasons: ["message-internal-date-unavailable"],
        lastSentAt: "2026-08-06T00:00:00.000Z",
        lastSentAtComplete: false,
        lastSentAtBasis: "bounded-matched-message-internal-date",
        lastReceivedAt: null,
        lastReceivedAtComplete: false,
        lastReceivedAtBasis: "unavailable",
        statsAddressCoverage: "complete",
        statsSupportedAddressCount: 1,
        statsUnsupportedAddressCount: 0,
      }],
      statsScanLimit: 2,
      statsScope: "per-contact-gmail-search-excluding-spam-trash",
    });
    expect(requests.some((url) => url.pathname.endsWith("/messages/sent_2"))).toBeTrue();
  });

  test("selects Other contacts and retains collection identity in the output", async () => {
    const requests: URL[] = [];
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/v1/otherContacts")) {
        return Promise.resolve(json({
          otherContacts: [{
            resourceName: "otherContacts/c1",
            metadata: {
              sources: [{ type: "OTHER_CONTACT", id: "other-1" }],
            },
            names: [{ displayName: "Other Friend" }],
            emailAddresses: [{ value: "other.friend@example.com" }],
          }],
          totalSize: 1,
        }));
      }
      if (url.pathname.endsWith("/messages")) {
        return Promise.resolve(json({ resultSizeEstimate: 0 }));
      }
      throw new Error(`unexpected request ${url.href}`);
    };
    const run = harness("contacts.list", {
      collection: "other-contacts",
      limit: 1,
      stats_scan_limit: 1,
    }, fetch);
    await executeGmailProvider(run.context);
    expect(run.output()).toMatchObject({
      operation: "contacts.list",
      accountSubject: "person@example.com",
      contactCollection: "other-contacts",
      contacts: [{
        resourceName: "otherContacts/c1",
        displayName: "Other Friend",
        sentCount: 0,
        receivedCount: 0,
      }],
      nextCursor: null,
      totalItems: 1,
    });
    expect(requests.filter((url) => url.hostname === "people.googleapis.com"))
      .toHaveLength(1);
    expect(requests.some((url) => url.pathname.endsWith("/people:batchGet")))
      .toBeFalse();
  });

  test("lists a full contact page without Gmail statistic requests when disabled", async () => {
    const requests: URL[] = [];
    const contacts = Array.from({ length: 100 }, (_unused, index) => ({
      resourceName: `otherContacts/c${index}`,
      emailAddresses: [{ value: `friend${index}@example.com` }],
    }));
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/v1/otherContacts")) {
        return Promise.resolve(json({ otherContacts: contacts, totalSize: 100 }));
      }
      throw new Error(`unexpected request ${url.href}`);
    };
    const run = harness("contacts.list", {
      collection: "other-contacts",
      include_stats: false,
      limit: 100,
    }, fetch);
    await executeGmailProvider(run.context);
    expect(run.output()).toMatchObject({
      contactCollection: "other-contacts",
      statsIncluded: false,
      statsScanLimit: null,
      statsScope: "not-requested",
      totalItems: 100,
    });
    const output = run.output() as {
      readonly contacts: readonly Record<string, unknown>[];
    };
    expect(output.contacts).toHaveLength(100);
    expect(output.contacts[0]).not.toHaveProperty("sentCount");
    expect(requests).toHaveLength(2);
    expect(requests.some((url) => url.pathname.endsWith("/messages"))).toBeFalse();
  });

  test("preserves the exact v4 core output and rejects every date opt-in", async () => {
    const requests: URL[] = [];
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      requests.push(url);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/connections")) {
        return Promise.resolve(json({
          connections: [{ resourceName: "people/legacy" }],
          totalItems: 1,
        }));
      }
      if (url.pathname.endsWith("/people:batchGet")) {
        return Promise.resolve(json({
          responses: [{
            requestedResourceName: "people/legacy",
            status: {},
            person: {
              resourceName: "people/legacy",
              names: [{ displayName: "Legacy Contact" }],
              emailAddresses: [{ value: "legacy@example.com" }],
            },
          }],
        }));
      }
      throw new Error(`unexpected request ${url.href}`);
    };
    const run = harness("contacts.list", {
      collection: "contacts",
      include_stats: false,
      limit: 1,
    }, fetch, 4);
    await executeGmailProvider(run.context);
    expect(run.output()).toEqual({
      provider: "gmail",
      operation: "contacts.list",
      accountSubject: "person@example.com",
      contactCollection: "contacts",
      statsIncluded: false,
      contacts: [{
        resourceName: "people/legacy",
        etag: null,
        metadata: null,
        displayName: "Legacy Contact",
        emailAddresses: [{
          value: "legacy@example.com",
          canonicalValue: "legacy@example.com",
          type: null,
          metadata: null,
        }],
        phoneNumbers: [],
        organizations: [],
        photoUrl: null,
      }],
      nextCursor: null,
      totalItems: 1,
      statsScanLimit: null,
      statsScope: "not-requested",
    });
    expect(requests[2]?.searchParams.get("personFields")).not.toContain("birthdays");

    let rejectedRequests = 0;
    const rejected = harness("contacts.list", {
      collection: "contacts",
      include_dates: false,
      include_stats: false,
    }, () => {
      rejectedRequests += 1;
      return Promise.resolve(json(profile()));
    }, 4);
    await expectRejected(
      executeGmailProvider(rejected.context),
      "include_dates is available only in contract v5",
    );
    expect(rejectedRequests).toBe(0);
  });

  test("does not silently ignore a stats limit when statistics are disabled", async () => {
    const run = harness("contacts.list", {
      include_stats: false,
      stats_scan_limit: 1,
    }, () => {
      throw new Error("invalid input must not make an HTTP request");
    });
    await expectRejected(
      executeGmailProvider(run.context),
      "stats_scan_limit is accepted only when include_stats is true",
    );
  });

  test("rejects saved-contact dates for Other contacts before account preflight", async () => {
    let requests = 0;
    const run = harness("contacts.list", {
      collection: "other-contacts",
      include_dates: true,
    }, () => {
      requests += 1;
      return Promise.resolve(json(profile()));
    });
    await expectRejected(
      executeGmailProvider(run.context),
      "include_dates is supported only for saved contacts",
    );
    expect(requests).toBe(0);
  });

  test("rejects an unreviewed contact collection before account preflight", async () => {
    let requests = 0;
    const run = harness("contacts.list", {
      collection: "directory",
    }, () => {
      requests += 1;
      return Promise.resolve(json(profile()));
    });
    await expectRejected(
      executeGmailProvider(run.context),
      "input.collection must be contacts or other-contacts",
    );
    expect(requests).toBe(0);
  });

  test("reports mixed, unsupported, and absent contact addresses as explicit lower bounds", async () => {
    const contacts = [{
      resourceName: "people/mixed",
      emailAddresses: [
        { value: "friend@example.com" },
        { value: "not an address" },
      ],
    }, {
      resourceName: "people/unsupported",
      emailAddresses: [{ value: "not-an-email" }],
    }, {
      resourceName: "people/unavailable",
    }];
    const gmailQueries: string[] = [];
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/connections")) {
        return Promise.resolve(json({
          connections: contacts.map((contact) => ({ resourceName: contact.resourceName })),
          totalItems: contacts.length,
        }));
      }
      if (url.pathname.endsWith("/people:batchGet")) {
        return Promise.resolve(json({
          responses: contacts.map((contact) => ({
            requestedResourceName: contact.resourceName,
            status: {},
            person: contact,
          })),
        }));
      }
      if (url.pathname.endsWith("/messages")) {
        gmailQueries.push(url.searchParams.get("q") ?? "");
        return Promise.resolve(json({ resultSizeEstimate: 0 }));
      }
      throw new Error(`unexpected request ${url.href}`);
    };
    const run = harness("contacts.list", { limit: 3, stats_scan_limit: 10 }, fetch);

    await executeGmailProvider(run.context);

    const output = run.output() as { readonly contacts: readonly Record<string, unknown>[] };
    expect(output.contacts).toHaveLength(3);
    expect(output.contacts[0]).toMatchObject({
      resourceName: "people/mixed",
      statsAddressCoverage: "partial",
      statsSupportedAddressCount: 1,
      statsUnsupportedAddressCount: 1,
      sentCount: 0,
      sentCountComplete: false,
      sentCountLowerBound: true,
      sentCountTruncated: false,
      sentStatsIncompleteReasons: ["unsupported-contact-addresses"],
      receivedCount: 0,
      receivedCountComplete: false,
      receivedCountLowerBound: true,
      receivedCountTruncated: false,
      receivedStatsIncompleteReasons: ["unsupported-contact-addresses"],
      lastSentAtComplete: false,
      lastReceivedAtComplete: false,
    });
    expect(output.contacts[1]).toMatchObject({
      resourceName: "people/unsupported",
      statsAddressCoverage: "unsupported",
      statsSupportedAddressCount: 0,
      statsUnsupportedAddressCount: 1,
      sentCountComplete: false,
      sentCountLowerBound: true,
      sentCountTruncated: false,
      sentStatsIncompleteReasons: ["unsupported-contact-addresses"],
      receivedCountComplete: false,
      receivedCountLowerBound: true,
      receivedCountTruncated: false,
      receivedStatsIncompleteReasons: ["unsupported-contact-addresses"],
    });
    expect(output.contacts[2]).toMatchObject({
      resourceName: "people/unavailable",
      statsAddressCoverage: "unavailable",
      statsSupportedAddressCount: 0,
      statsUnsupportedAddressCount: 0,
      sentCountComplete: false,
      sentCountLowerBound: true,
      sentCountTruncated: false,
      sentStatsIncompleteReasons: ["no-contact-addresses"],
      receivedCountComplete: false,
      receivedCountLowerBound: true,
      receivedCountTruncated: false,
      receivedStatsIncompleteReasons: ["no-contact-addresses"],
    });
    expect(gmailQueries).toHaveLength(2);
    expect(gmailQueries.every((query) => query.includes("friend@example.com"))).toBeTrue();
    expect(gmailQueries.join("\n")).not.toContain("not an address");
    expect(gmailQueries.join("\n")).not.toContain("not-an-email");
  });

  test("never exceeds four concurrent contact-stat requests", async () => {
    let active = 0;
    let maximumActive = 0;
    const contacts = Array.from({ length: 6 }, (_unused, index) => ({
      resourceName: `people/c${index}`,
      emailAddresses: [{ value: `friend${index}@example.com`, type: "work" }],
    }));
    const fetch: ProviderFetch = async (input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/profile")) return json(profile());
      if (url.pathname.endsWith("/connections")) {
        return json({
          connections: contacts.map((contact) => ({ resourceName: contact.resourceName })),
          totalItems: contacts.length,
        });
      }
      if (url.pathname.endsWith("/people:batchGet")) {
        return json({
          responses: contacts.map((contact) => ({
            requestedResourceName: contact.resourceName,
            status: {},
            person: contact,
          })),
        });
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return json({ resultSizeEstimate: 0 });
    };
    const run = harness("contacts.list", {
      limit: contacts.length,
      stats_scan_limit: 1,
    }, fetch);
    await executeGmailProvider(run.context);
    expect(maximumActive).toBe(4);
    expect(run.dispatches()).toBe(0);
  });

  test("failure-joins contact scans before pagination, metadata, or queued contacts can start", async () => {
    const contacts = Array.from({ length: 3 }, (_unused, index) => ({
      resourceName: `people/c${index + 1}`,
      emailAddresses: [{ value: `friend${index + 1}@example.com` }],
    }));
    const startedQueries: string[] = [];
    const active: ReturnType<typeof deferred<Response>>[] = [];
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/connections")) {
        return Promise.resolve(json({
          connections: contacts.map((contact) => ({ resourceName: contact.resourceName })),
        }));
      }
      if (url.pathname.endsWith("/people:batchGet")) {
        return Promise.resolve(json({
          responses: contacts.map((contact) => ({
            requestedResourceName: contact.resourceName,
            status: {},
            person: contact,
          })),
        }));
      }
      if (url.pathname.endsWith("/messages")) {
        startedQueries.push(url.searchParams.get("q") ?? "");
        const gate = deferred<Response>();
        active.push(gate);
        return gate.promise;
      }
      throw new Error(`unexpected request ${url.href}`);
    };
    const run = harness("contacts.list", { limit: 3, stats_scan_limit: 10 }, fetch);
    const execution = executeGmailProvider(run.context);
    let settled = false;
    const settlement = execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await waitFor(() => startedQueries.length === 4, "four active contact scans");
    active[0]?.reject(new Error("first contact scan failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeFalse();
    for (const gate of active.slice(1)) gate.resolve(json({ resultSizeEstimate: 0 }));

    await expectRejected(execution, "official provider request did not return a response");
    await settlement;
    expect(startedQueries).toHaveLength(4);
    expect(startedQueries.join("\n")).not.toContain("friend3@example.com");
  });

  test("failure-joins active messaging metadata reads and stops queued admissions", async () => {
    const started: string[] = [];
    const active = new Map<string, ReturnType<typeof deferred<Response>>>();
    const threadIds = Array.from({ length: 5 }, (_unused, index) => `thread_${index + 1}`);
    const fetch: ProviderFetch = (input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/profile")) return Promise.resolve(json(profile()));
      if (url.pathname.endsWith("/threads")) {
        return Promise.resolve(json({
          threads: threadIds.map((id) => ({ id, snippet: id, historyId: "1" })),
          resultSizeEstimate: threadIds.length,
        }));
      }
      const threadId = threadIds.find((id) => url.pathname.endsWith(`/threads/${id}`));
      if (threadId === undefined) throw new Error(`unexpected request ${url.href}`);
      started.push(threadId);
      const gate = deferred<Response>();
      active.set(threadId, gate);
      return gate.promise;
    };
    const run = harness("messaging.list", { view: "inbox", limit: 5 }, fetch);
    const execution = executeGmailProvider(run.context);
    let settled = false;
    const settlement = execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await waitFor(() => started.length === 4, "four active Gmail metadata reads");
    active.get("thread_1")?.reject(new Error("first metadata failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeFalse();
    for (const threadId of threadIds.slice(1, 4)) {
      active.get(threadId)?.resolve(json({
        id: threadId,
        historyId: "1",
        messages: [{
          id: `message_${threadId}`,
          threadId,
          labelIds: ["INBOX"],
          historyId: "1",
          internalDate: "1785888000000",
          payload: metadataPayload([]),
        }],
      }));
    }

    await expectRejected(execution, "official provider request did not return a response");
    await settlement;
    expect(started).toEqual(threadIds.slice(0, 4));
    expect(started).not.toContain("thread_5");
  });

  test("rejects multiplicative contact-stat work beyond the per-direction budget", async () => {
    const run = harness("contacts.list", {
      limit: 100,
      stats_scan_limit: 2_000,
    }, () => {
      throw new Error("invalid work budget must not make an HTTP request");
    });
    await expectRejected(
      executeGmailProvider(run.context),
      "2000-entry per-direction work budget",
    );
  });

  test("stops after profile preflight when the authenticated subject changes", async () => {
    let requests = 0;
    const run = harness("messaging.list", { view: "inbox" }, () => {
      requests += 1;
      return Promise.resolve(json(profile("other@example.com")));
    });
    await expectRejected(
      executeGmailProvider(run.context),
      "does not match the OAuth locator subject",
    );
    expect(requests).toBe(1);
  });
});
