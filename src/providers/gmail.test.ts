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
) {
  let output: unknown;
  let finalUrl: string | null = null;
  let dispatches = 0;
  const context = {
    recipe: { action, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 },
    input,
    auth: {
      kind: "oauth-token-file",
      id: "gmail-test",
      provider: "gmail",
      subject: "Person@Example.com",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/contacts.readonly",
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
      limit: 1,
      stats_scan_limit: 2,
    }, fetch);
    await executeGmailProvider(run.context);
    expect(run.dispatches()).toBe(0);
    expect(run.output()).toMatchObject({
      contacts: [{
        resourceName: "people/c1",
        emailAddresses: [{
          value: "Friend+Tag|Ops*{x}@Example.com",
          canonicalValue: "friend+tag|ops*{x}@example.com",
          type: "work",
        }],
        photoUrl: null,
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
