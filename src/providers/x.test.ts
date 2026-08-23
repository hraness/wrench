import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OperationInput, ProviderRecipe, WrenchManifest } from "../model";
import type { ProviderActionContext, ProviderFile } from "../provider";
import type { ProviderContract } from "../provider-contract-definitions";
import { xProviderContractDefinitions } from "../provider-contract-definitions-x";
import { ProviderHttpClient, type OAuthTokenAuth, type ProviderFetch } from "../provider-http";
import { executeXProvider } from "./x";
import { embedPngChunk, encodePixelsOnlyPng, minimalPngBytes, scrubXUploadImage } from "./x-image-provenance";
import { X_UNLABELED_COPY_POLICY_ERROR } from "./x-made-with-ai";

type XAction = (typeof xProviderContractDefinitions)[number]["operation"];

function currentXContract(action: XAction): ProviderContract {
  const matches = xProviderContractDefinitions.filter((contract) =>
    contract.operation === action);
  const current = matches.toSorted((left, right) =>
    left.contractVersion - right.contractVersion).at(-1);
  if (current === undefined) throw new Error(`official X test contract ${action} is missing`);
  return current;
}

type RequestCapture = {
  readonly url: URL;
  readonly init: RequestInit;
  readonly insideDispatch: boolean;
};

type Harness = {
  readonly context: ProviderActionContext;
  readonly output: () => unknown;
  readonly finalUrl: () => string | null;
  readonly dispatches: () => number;
  readonly requiredScopes: () => readonly string[];
};

const allScopes = [
  "bookmark.read",
  "bookmark.write",
  "dm.read",
  "dm.write",
  "list.read",
  "media.write",
  "tweet.read",
  "tweet.write",
  "users.read",
] as const;

function inputUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return new URL(input);
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness(
  action: XAction,
  input: OperationInput,
  fetch: ProviderFetch,
  options: {
    readonly files?: Readonly<Record<string, readonly ProviderFile[]>>;
    readonly subject?: string;
    readonly scopes?: readonly string[];
    readonly timeoutMs?: number;
  } = {},
): Harness {
  const contract = currentXContract(action);
  const recipe: ProviderRecipe = {
    provider: "x",
    action,
    contractVersion: contract.contractVersion,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: 1024 * 1024,
  };
  const manifest: WrenchManifest = {
    schemaVersion: 3,
    id: "x-official-test",
    version: "1.0.0",
    displayName: "X official test",
    surfaceId: "x",
    origins: ["https://x.com"],
    browserDomains: [],
    operations: {},
  };
  const auth: OAuthTokenAuth = {
    schemaVersion: 1,
    id: "x-api",
    kind: "oauth-token-file",
    provider: "x",
    path: "/private/test-token",
    scopes: options.scopes ?? allScopes,
    ...(options.subject === undefined ? {} : { subject: options.subject }),
  };
  let output: unknown = null;
  let finalUrl: string | null = null;
  let dispatches = 0;
  const requiredScopes: string[] = [];
  const beginDispatch = (): Promise<{
    readonly verify: () => Promise<void>;
  }> => {
    dispatches += 1;
    let verified = false;
    return Promise.resolve({
      verify: () => {
        if (verified) throw new Error("test dispatch was verified twice");
        verified = true;
        return Promise.resolve();
      },
    });
  };
  const context: ProviderActionContext = {
    manifest,
    recipe,
    contract,
    input,
    auth,
    token: { accessToken: "unit-test-access-token", expiresAt: null },
    http: new ProviderHttpClient(fetch, recipe.timeoutMs, recipe.maxOutputBytes),
    environment: {},
    signal: new AbortController().signal,
    remainingTimeMs: () => recipe.timeoutMs,
    resolveFiles: (name) => Promise.resolve(options.files?.[name] ?? []),
    beginDispatch,
    dispatch: async <T>(action_: () => Promise<T>): Promise<T> => {
      const boundary = await beginDispatch();
      const result = await action_();
      await boundary.verify();
      return result;
    },
    addRequiredScopes: (scopes) => {
      for (const scope of scopes) {
        requiredScopes.push(scope);
        if (!auth.scopes.includes(scope)) throw new Error(`test OAuth locator lacks required scope(s): ${scope}`);
      }
    },
    setOutput: (value) => { output = value; },
    setFinalUrl: (value) => { finalUrl = value; },
  };
  return {
    context,
    output: () => output,
    finalUrl: () => finalUrl,
    dispatches: () => dispatches,
    requiredScopes: () => requiredScopes,
  };
}

function captureFetch(
  responses: readonly Response[],
  dispatchState: () => boolean = () => false,
): { readonly fetch: ProviderFetch; readonly requests: RequestCapture[] } {
  const queue = [...responses];
  const requests: RequestCapture[] = [];
  const fetch: ProviderFetch = (input, init = {}) => {
    requests.push({ url: inputUrl(input), init, insideDispatch: dispatchState() });
    const response = queue.shift();
    if (response === undefined) throw new Error("test received an unexpected provider request");
    return Promise.resolve(response);
  };
  return { fetch, requests };
}

async function expectRejectedWith(promise: Promise<unknown>, message: string): Promise<Error> {
  let failure: unknown = null;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const result = failure instanceof Error ? failure : new Error("expected a failure");
  expect(result.message).toContain(message);
  return result;
}

function requestJson(request: RequestCapture): unknown {
  if (typeof request.init.body !== "string") throw new Error("expected a JSON request body");
  return JSON.parse(request.init.body) as unknown;
}

function requestMultipartText(request: RequestCapture): string {
  const contentType = new Headers(request.init.headers).get("content-type");
  expect(contentType).toMatch(/^multipart\/form-data; boundary=wrench-[a-f0-9]{48}$/u);
  const body = request.init.body;
  expect(body).toBeInstanceOf(Uint8Array);
  if (!(body instanceof Uint8Array)) throw new Error("expected an owned multipart byte body");
  const boundary = contentType?.slice("multipart/form-data; boundary=".length);
  if (boundary === undefined || boundary === "") throw new Error("expected a multipart boundary");
  const text = Buffer.from(body).toString("latin1");
  expect(text.startsWith(`--${boundary}\r\n`)).toBeTrue();
  expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBeTrue();
  return text;
}

function fixtureFile(path: string, mediaType: string): ProviderFile {
  chmodSync(path, 0o600);
  const bytes = readFileSync(path);
  return {
    value: { kind: "file", reference: "test-fixture" },
    path,
    bytes: bytes.byteLength,
    mediaType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("official X read coverage", () => {
  test("preserves every recent-search page item without skipping behind the next cursor", async () => {
    const captured = captureFetch([json({
      data: Array.from({ length: 10 }, (_value, index) => ({ id: String(index + 1), text: `post-${index + 1}` })),
      includes: { users: [{ id: "20", username: "author" }] },
      errors: [{ title: "one withheld result" }],
      meta: { result_count: 10, newest_id: "10", oldest_id: "1", next_token: "next-page" },
    })]);
    const harness = createHarness("feeds.read", {
      feed: "recent-search",
      query: "from:20 has:media",
      limit: 10,
      cursor: "current-page",
      sort: "relevancy",
      since_id: "100",
    }, captured.fetch);

    await executeXProvider(harness.context);

    expect(captured.requests).toHaveLength(1);
    const request = captured.requests[0];
    expect(request?.init.method).toBe("GET");
    expect(request?.url.pathname).toBe("/2/tweets/search/recent");
    expect(request?.url.searchParams.get("query")).toBe("from:20 has:media");
    expect(request?.url.searchParams.get("next_token")).toBe("current-page");
    expect(request?.url.searchParams.get("max_results")).toBe("10");
    expect(request?.url.searchParams.get("sort_order")).toBe("relevancy");
    expect(request?.url.searchParams.get("since_id")).toBe("100");
    const postFields = request?.url.searchParams.get("tweet.fields")?.split(",");
    expect(postFields).toContain("conversation_id");
    expect(postFields).toContain("paid_partnership");
    expect(postFields).toContain("scopes");
    expect(postFields).toContain("suggested_source_links");
    expect(postFields).toContain("suggested_source_links_with_counts");
    expect(postFields).toContain("note_request_suggestions");
    expect(request?.url.searchParams.get("expansions")).toContain("attachments.media_keys");
    expect(request?.url.searchParams.get("expansions")).toContain("attachments.media_source_tweet");
    expect(request?.url.searchParams.get("user.fields")).toContain("subscription");
    expect(harness.output()).toMatchObject({
      provider: "x",
      operation: "feeds.read",
      feed: "recent-search",
      page: {
        requestedLimit: 10,
        returned: 10,
        providerReturned: 10,
        cursor: { next: "next-page", previous: null },
        pageExhausted: false,
      },
      coverage: { complete: false, forYou: false },
    });
    expect((harness.output() as { readonly items: readonly unknown[] }).items).toHaveLength(10);
    expect(JSON.stringify(harness.output())).toContain("seven days");
    expect(harness.dispatches()).toBe(0);
  });

  test("rejects endpoint-specific page sizes that would skip undisclosed provider rows", async () => {
    for (const input of [
      { feed: "user", user_id: "51", limit: 4 },
      { feed: "mentions", user_id: "52", limit: 4 },
      { feed: "recent-search", query: "from:52", limit: 9 },
    ] as const) {
      const captured = captureFetch([]);
      const harness = createHarness("feeds.read", input, captured.fetch);
      await expectRejectedWith(executeXProvider(harness.context), "input.limit must be at least");
      expect(captured.requests).toHaveLength(0);
    }

    const fractional = captureFetch([]);
    const fractionalHarness = createHarness("feeds.read", {
      feed: "recent-search",
      query: "from:52",
      limit: 10.5,
    }, fractional.fetch);
    await expectRejectedWith(executeXProvider(fractionalHarness.context), "must be a safe integer");
    expect(fractional.requests).toHaveLength(0);
  });

  test("fails closed on malformed generic pagination metadata", async () => {
    for (const [meta, message] of [
      [["not-an-object"], "invalid metadata"],
      [{ result_count: 0, next_token: "" }, "invalid next_token"],
      [{ result_count: 2 }, "result_count did not match"],
    ] as const) {
      const captured = captureFetch([json({ data: [{ id: "1" }], meta })]);
      const harness = createHarness("feeds.read", {
        feed: "recent-search",
        query: "from:1",
        limit: 10,
      }, captured.fetch);
      await expectRejectedWith(executeXProvider(harness.context), message);
    }

    const missing = captureFetch([json({ data: [] })]);
    const missingHarness = createHarness("feeds.read", {
      feed: "recent-search",
      query: "from:1",
      limit: 10,
    }, missing.fetch);
    await executeXProvider(missingHarness.context);
    expect(missingHarness.output()).toMatchObject({ page: { pageExhausted: null } });
  });

  test("resolves and verifies the authenticated user for home timeline and bookmarks", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: [{ id: "90", text: "home" }], meta: { result_count: 1 } }),
    ]);
    const harness = createHarness("feeds.read", {
      feed: "home-reverse-chronological",
      limit: 5,
      exclude_replies: true,
      exclude_reposts: true,
    }, captured.fetch, { subject: "42" });

    await executeXProvider(harness.context);

    expect(captured.requests.map((request) => request.url.pathname)).toEqual([
      "/2/users/me",
      "/2/users/42/timelines/reverse_chronological",
    ]);
    expect(captured.requests[1]?.url.searchParams.get("exclude")).toBe("replies,retweets");
    expect(harness.output()).toMatchObject({
      feed: "home-reverse-chronological",
      coverage: { complete: false, forYou: false },
    });
    expect(JSON.stringify(harness.output())).toContain("not the algorithmic For You");

    const mismatch = captureFetch([json({ data: { id: "99", username: "other" } })]);
    const mismatchHarness = createHarness("feeds.read", {
      feed: "home-reverse-chronological",
    }, mismatch.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(mismatchHarness.context), "does not match the OAuth locator subject");
    expect(mismatch.requests).toHaveLength(1);
  });

  test("maps every remaining feed mode to its fixed official endpoint and cursor parameter", async () => {
    const cases = [
      {
        input: { feed: "user", user_id: "51", cursor: "user-page", limit: 5 },
        path: "/2/users/51/tweets",
        maximum: "5",
        responses: [json({ data: [{ id: "1" }], meta: {} })],
        subject: undefined,
      },
      {
        input: { feed: "mentions", user_id: "52", cursor: "mention-page", limit: 5 },
        path: "/2/users/52/mentions",
        maximum: "5",
        responses: [json({ data: [{ id: "2" }], meta: {} })],
        subject: undefined,
      },
      {
        input: { feed: "list", list_id: "53", cursor: "list-page", limit: 3 },
        path: "/2/lists/53/tweets",
        maximum: "3",
        responses: [json({ data: [{ id: "3" }], meta: {} })],
        subject: undefined,
      },
      {
        input: { feed: "bookmarks", cursor: "bookmark-page", limit: 4 },
        path: "/2/users/54/bookmarks",
        maximum: "4",
        responses: [
          json({ data: { id: "54", username: "me" } }),
          json({ data: [{ id: "4" }], meta: {} }),
        ],
        subject: "54",
      },
    ] as const;

    for (const feedCase of cases) {
      const captured = captureFetch(feedCase.responses);
      const harness = createHarness("feeds.read", feedCase.input, captured.fetch, {
        ...(feedCase.subject === undefined ? {} : { subject: feedCase.subject }),
      });
      await executeXProvider(harness.context);
      const request = captured.requests.at(-1);
      expect(request?.url.pathname).toBe(feedCase.path);
      expect(request?.url.searchParams.get("pagination_token")).toBe(feedCase.input.cursor);
      expect(request?.url.searchParams.get("max_results")).toBe(feedCase.maximum);
      expect(request?.url.searchParams.get("tweet.fields")).toContain("public_metrics");
      if (feedCase.input.feed === "bookmarks") expect(harness.requiredScopes()).toContain("bookmark.read");
      if (feedCase.input.feed === "list") expect(harness.requiredScopes()).toContain("list.read");
    }
  });

  test("looks up exact posts with rich fixed fields and reports partial provider results", async () => {
    const captured = captureFetch([json({
      data: [{ id: "101", text: "available" }],
      errors: [{ value: "102", title: "Not Found Error" }],
    })]);
    const harness = createHarness("posts.read", { post_ids: ["101", "102"] }, captured.fetch);

    await executeXProvider(harness.context);

    const request = captured.requests[0];
    expect(request?.url.pathname).toBe("/2/tweets");
    expect(request?.url.searchParams.get("ids")).toBe("101,102");
    expect(request?.url.searchParams.get("media.fields")).toContain("preview_image_url");
    expect(request?.url.searchParams.get("user.fields")).toContain("verified_type");
    expect(harness.output()).toMatchObject({
      operation: "posts.read",
      coverage: { complete: false, requestedIds: ["101", "102"], returned: 1 },
      providerErrors: [{ value: "102" }],
    });
  });

  test("rejects malformed lookup IDs and wrong provider response identities", async () => {
    const malformed = captureFetch([]);
    const malformedHarness = createHarness("posts.read", { post_ids: ["101,102"] }, malformed.fetch);
    await expectRejectedWith(executeXProvider(malformedHarness.context), "1-19 digit X object ID");
    expect(malformed.requests).toHaveLength(0);

    const wrong = captureFetch([json({ data: [{ id: "999", text: "wrong" }] })]);
    const wrongHarness = createHarness("posts.read", { post_ids: ["101"] }, wrong.fetch);
    await expectRejectedWith(executeXProvider(wrongHarness.context), "unrequested post ID");
  });

  test("reconstructs replies only through explicitly incomplete seven-day recent search", async () => {
    const captured = captureFetch([json({
      data: [{ id: "202", conversation_id: "200", text: "reply" }],
      meta: { result_count: 1, next_token: "more" },
    })]);
    const harness = createHarness("comments.read", { post_id: "200", cursor: "page", limit: 10 }, captured.fetch);

    await executeXProvider(harness.context);

    const request = captured.requests[0];
    expect(request?.url.pathname).toBe("/2/tweets/search/recent");
    expect(request?.url.searchParams.get("query")).toBe("conversation_id:200 is:reply");
    expect(request?.url.searchParams.get("next_token")).toBe("page");
    expect(harness.output()).toMatchObject({
      operation: "comments.read",
      rootPostId: "200",
      coverage: { complete: false, window: "recent-7-days" },
    });
    expect(JSON.stringify(harness.output())).toContain("never a complete");
    expect(harness.finalUrl()).toBe("https://x.com/i/web/status/200");
  });

  test("rejects a reply-search item outside the requested conversation", async () => {
    const captured = captureFetch([json({
      data: [{ id: "202", conversation_id: "999", text: "wrong conversation" }],
      meta: { result_count: 1 },
    })]);
    const harness = createHarness("comments.read", { post_id: "200", limit: 10 }, captured.fetch);
    await expectRejectedWith(executeXProvider(harness.context), "outside the requested conversation");
  });

  test("supports opt-in full-archive reply search without hiding pagination", async () => {
    const captured = captureFetch([json({
      data: Array.from({ length: 10 }, (_value, index) => ({
        id: String(200 + index),
        conversation_id: "199",
        text: `historical-${index}`,
      })),
      meta: { result_count: 10, next_token: "archive-next" },
    })]);
    const harness = createHarness("comments.read", {
      post_id: "199",
      window: "full-archive",
      limit: 10,
    }, captured.fetch);

    await executeXProvider(harness.context);

    expect(captured.requests[0]?.url.pathname).toBe("/2/tweets/search/all");
    expect(captured.requests[0]?.url.searchParams.get("max_results")).toBe("10");
    expect(harness.output()).toMatchObject({
      coverage: { complete: false, window: "full-archive" },
      page: { cursor: { next: "archive-next" }, pageExhausted: false },
    });
  });

  test("lists and reads official DM events while labeling the 30-day non-Chat boundary", async () => {
    const listed = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({
        data: [{
          id: "301",
          dm_conversation_id: "42-44",
          participant_ids: ["42", "44"],
          event_type: "MessageCreate",
          text: "hello",
        }],
        meta: { result_count: 1, next_token: "older" },
      }),
    ]);
    const listHarness = createHarness("messaging.list", {
      view: "participant",
      target_id: "44",
      limit: 25,
      cursor: "current",
    }, listed.fetch, { subject: "42" });
    await executeXProvider(listHarness.context);
    expect(listed.requests[0]?.url.pathname).toBe("/2/users/me");
    const listRequest = listed.requests[1];
    expect(listRequest?.url.pathname).toBe("/2/dm_conversations/with/44/dm_events");
    expect(listRequest?.url.searchParams.get("max_results")).toBe("25");
    expect(listRequest?.url.searchParams.get("pagination_token")).toBe("current");
    expect(listRequest?.url.searchParams.get("dm_event.fields")).toContain("dm_conversation_id");
    expect(listRequest?.url.searchParams.get("dm_event.fields")).toContain("entities");
    expect(listHarness.output()).toMatchObject({
      operation: "messaging.list",
      coverage: {
        complete: false,
        window: "dm-events-30-days",
        encryptedChat: false,
      },
    });
    expect(JSON.stringify(listHarness.output())).toContain("Requests, Priority, and Hidden");

    const read = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "301", event_type: "MessageCreate", text: "hello" } }),
    ]);
    const readHarness = createHarness("messaging.read", { event_id: "301" }, read.fetch, { subject: "42" });
    await executeXProvider(readHarness.context);
    expect(read.requests[1]?.url.pathname).toBe("/2/dm_events/301");
    expect(readHarness.output()).toMatchObject({
      operation: "messaging.read",
      item: { id: "301" },
      coverage: { encryptedChat: false },
    });
  });

  test("binds private DM reads to the exact OAuth subject and returned event", async () => {
    const missing = captureFetch([]);
    const missingHarness = createHarness("messaging.list", { view: "all" }, missing.fetch);
    await expectRejectedWith(executeXProvider(missingHarness.context), "private-message reads require");
    expect(missing.requests).toHaveLength(0);

    const mismatch = captureFetch([json({ data: { id: "99", username: "other" } })]);
    const mismatchHarness = createHarness("messaging.list", { view: "all" }, mismatch.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(mismatchHarness.context), "does not match the OAuth locator subject");
    expect(mismatch.requests.map((request) => request.url.pathname)).toEqual(["/2/users/me"]);

    const wrongEvent = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "302", event_type: "MessageCreate" } }),
    ]);
    const wrongHarness = createHarness("messaging.read", { event_id: "301" }, wrongEvent.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(wrongHarness.context), "unexpected event ID");

    const wrongParticipant = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({
        data: [{ id: "303", dm_conversation_id: "42-99", participant_ids: ["42", "99"] }],
        meta: { result_count: 1 },
      }),
    ]);
    const wrongParticipantHarness = createHarness("messaging.list", {
      view: "participant",
      target_id: "44",
    }, wrongParticipant.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(wrongParticipantHarness.context), "outside the requested participant conversation");
  });

  test("lists encrypted Chat conversations and events without claiming plaintext", async () => {
    const conversations = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({
        data: [{ id: "42-77", type: "direct", participant_ids: ["42", "77"], is_muted: false }],
        includes: { users: [{ id: "77", username: "peer" }] },
        meta: { result_count: 1, has_message_requests: true, next_token: "chat-next" },
      }),
    ]);
    const conversationHarness = createHarness("messaging.list", {
      view: "chat-conversations",
      limit: 10,
    }, conversations.fetch, { subject: "42" });

    await executeXProvider(conversationHarness.context);

    expect(conversations.requests.map((request) => request.url.pathname)).toEqual([
      "/2/users/me",
      "/2/chat/conversations",
    ]);
    const conversationRequest = conversations.requests[1]?.url;
    expect(conversationRequest?.searchParams.get("chat_conversation.fields")).toContain("message_ttl_msec");
    expect(conversationRequest?.searchParams.get("expansions")).toContain("participant_ids");
    expect(conversationHarness.output()).toMatchObject({
      view: "chat-conversations",
      page: { cursor: { next: "chat-next" } },
      meta: { has_message_requests: true },
      coverage: { encryptedChat: true, plaintextAvailable: false, messageRequestsPending: true },
    });

    const events = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({
        data: [{
          id: "event-1",
          conversation_id: "42:77",
          sender_id: "77",
          encoded_event: "dW5pdC10ZXN0LWNpcGhlcnRleHQ=",
        }],
        meta: { result_count: 1, has_more: false },
      }),
    ]);
    const eventHarness = createHarness("messaging.list", {
      view: "chat-events",
      target_id: "42-77",
      limit: 10,
    }, events.fetch, { subject: "42" });

    await executeXProvider(eventHarness.context);

    expect(events.requests[1]?.url.pathname).toBe("/2/chat/conversations/42-77/events");
    expect(events.requests[1]?.url.searchParams.get("chat_message_event.fields")).toContain("encoded_event");
    expect(eventHarness.output()).toMatchObject({
      view: "chat-events",
      items: [{ id: "event-1", conversation_id: "42:77" }],
      coverage: { encryptedChat: true, plaintextAvailable: false },
    });
    expect((eventHarness.output() as { readonly coverage: Record<string, unknown> }).coverage)
      .not.toHaveProperty("messageRequestsPending");
    expect(JSON.stringify(eventHarness.output())).toContain("without claiming to decrypt");

    const keyEventsOnly = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({
        data: [],
        meta: {
          result_count: 0,
          has_more: false,
          conversation_key_events: ["a2V5LWV2ZW50"],
        },
      }),
    ]);
    const keyEventsOnlyHarness = createHarness("messaging.list", {
      view: "chat-events",
      target_id: "42-77",
      limit: 10,
    }, keyEventsOnly.fetch, { subject: "42" });

    await executeXProvider(keyEventsOnlyHarness.context);

    expect(keyEventsOnlyHarness.output()).toMatchObject({
      items: [],
      meta: { conversation_key_events: ["a2V5LWV2ZW50"] },
      page: { pageExhausted: true },
    });
  });

  test("rejects contradictory Chat pagination, invalid envelopes, and ambiguous direct targets", async () => {
    const contradictory = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: [], meta: { result_count: 0, has_more: true } }),
    ]);
    const contradictoryHarness = createHarness("messaging.list", {
      view: "chat-conversations",
      limit: 10,
    }, contradictory.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(contradictoryHarness.context), "claimed more results without a next token");

    const absentMeta = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: [] }),
    ]);
    const absentMetaHarness = createHarness("messaging.list", {
      view: "chat-conversations",
      limit: 10,
    }, absentMeta.fetch, { subject: "42" });
    await executeXProvider(absentMetaHarness.context);
    expect(absentMetaHarness.output()).toMatchObject({ page: { pageExhausted: null } });

    const mismatchedCount = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: [], meta: { result_count: 1 } }),
    ]);
    const mismatchedCountHarness = createHarness("messaging.list", {
      view: "chat-conversations",
      limit: 10,
    }, mismatchedCount.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(mismatchedCountHarness.context), "result_count did not match");

    const falseWithToken = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: [], meta: { result_count: 0, has_more: false, next_token: "impossible" } }),
    ]);
    const falseWithTokenHarness = createHarness("messaging.list", {
      view: "chat-conversations",
      limit: 10,
    }, falseWithToken.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(falseWithTokenHarness.context), "next token after declaring the page complete");

    const invalidEnvelope = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: [{ id: "event-2", conversation_id: "42:77", encoded_event: "not base64" }] }),
    ]);
    const invalidEnvelopeHarness = createHarness("messaging.list", {
      view: "chat-events",
      target_id: "77",
      limit: 10,
    }, invalidEnvelope.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(invalidEnvelopeHarness.context), "invalid encrypted envelope");

    const malformedKeyEvents = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: [], meta: { result_count: 0, conversation_key_events: "not-an-array" } }),
    ]);
    const malformedKeyEventsHarness = createHarness("messaging.list", {
      view: "chat-events",
      target_id: "77",
      limit: 10,
    }, malformedKeyEvents.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(malformedKeyEventsHarness.context), "invalid conversation_key_events collection");

    const duplicateKeyEvents = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: [], meta: { result_count: 0, conversation_key_events: ["a2V5MQ==", "a2V5MQ=="] } }),
    ]);
    const duplicateKeyEventsHarness = createHarness("messaging.list", {
      view: "chat-events",
      target_id: "77",
      limit: 10,
    }, duplicateKeyEvents.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(duplicateKeyEventsHarness.context), "duplicate encrypted envelopes");

    for (const [targetId, message] of [["42", "another X Chat participant"], ["42-42", "two different X Chat participants"]] as const) {
      const captured = captureFetch([]);
      const harness = createHarness("messaging.list", {
        view: "chat-events",
        target_id: targetId,
        limit: 10,
      }, captured.fetch, { subject: "42" });
      await expectRejectedWith(executeXProvider(harness.context), message);
      expect(captured.requests).toHaveLength(0);
    }
  });
});

describe("official X writes", () => {
  test("retains Article publication v1-v2 behind publish-only v3 and a separate R2 draft contract", () => {
    const publishContracts = xProviderContractDefinitions.filter((contract) =>
      contract.operation === "articles.publish").toSorted((left, right) =>
      left.contractVersion - right.contractVersion);
    expect(publishContracts.map((contract) => contract.contractVersion)).toEqual([1, 2, 3]);
    expect((publishContracts[1]?.input.properties as Readonly<Record<string, unknown>>)
      .draft_only).toMatchObject({
      type: "boolean",
      enum: [true],
    });
    expect((publishContracts[2]?.input.properties as Readonly<Record<string, unknown>>)
      .draft_only).toBeUndefined();
    expect(currentXContract("articles.draft.save")).toMatchObject({
      operation: "articles.draft.save",
      contractVersion: 1,
      risk: "R2",
    });
  });

  test("publishes polls with the exact v2 payload and treats everyone as the default reply setting", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "401", text: "Question?" } }, 201),
    ]);
    const harness = createHarness("posts.publish", {
      body: "Question?",
      poll_options: ["Yes", "No"],
      poll_duration_minutes: 60,
      reply_settings: "everyone",
      community_id: "77",
    }, captured.fetch, { subject: "42" });

    await executeXProvider(harness.context);

    expect(captured.requests.map((request) => request.url.pathname)).toEqual(["/2/users/me", "/2/tweets"]);
    expect(captured.requests[1]?.init.method).toBe("POST");
    expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({
      text: "Question?",
      poll: { options: ["Yes", "No"], duration_minutes: 60 },
      community_id: "77",
    });
    expect(harness.output()).toMatchObject({ published: true, post: { id: "401" } });
    expect(harness.finalUrl()).toBe("https://x.com/i/web/status/401");
    expect(harness.dispatches()).toBe(1);
  });

  test("supports current subscriber and verified reply audiences", async () => {
    for (const setting of ["subscribers", "verified"] as const) {
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: setting === "subscribers" ? "402" : "403" } }, 201),
      ]);
      const harness = createHarness("posts.publish", { body: "Audience-bound", reply_settings: setting }, captured.fetch, { subject: "42" });
      await executeXProvider(harness.context);
      expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({ text: "Audience-bound", reply_settings: setting });
    }
  });

  test("rejects an AI-media label when no reviewed media is attached", async () => {
    const captured = captureFetch([]);
    const harness = createHarness("posts.publish", { body: "Text only", made_with_ai: true }, captured.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(harness.context), "has no reviewed media");
    expect(captured.requests).toHaveLength(0);
    expect(harness.dispatches()).toBe(0);
  });

  test("omits made_with_ai unless the caller explicitly sets true", async () => {
    for (const input of [
      { body: "Unlabeled by default" },
      { body: "Explicitly unlabeled", made_with_ai: false },
    ] as const) {
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "404", text: input.body } }, 201),
      ]);
      const harness = createHarness("posts.publish", input, captured.fetch, { subject: "42" });
      await executeXProvider(harness.context);
      expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({ text: input.body });
    }
  });

  test("requires both automated-reply attestations before dispatch", async () => {
    const captured = captureFetch([]);
    const harness = createHarness("replies.create", {
      target_post_id: "500",
      body: "Reply",
      recipient_opted_in: true,
      author_invited_reply: false,
    }, captured.fetch);

    await expectRejectedWith(executeXProvider(harness.context), "recipient opt-in and an author-invitation");
    expect(captured.requests).toHaveLength(0);
    expect(harness.dispatches()).toBe(0);
  });

  test("requires and verifies an exact OAuth subject before every X write dispatch", async () => {
    const writeCases: readonly { readonly action: XAction; readonly input: OperationInput }[] = [
      { action: "posts.publish", input: { body: "post" } },
      {
        action: "replies.create",
        input: { target_post_id: "450", body: "reply", recipient_opted_in: true, author_invited_reply: true },
      },
      { action: "threads.publish", input: { items: ["one"] } },
      {
        action: "messaging.send",
        input: { target_kind: "participant", target_id: "55", body: "message", recipient_opted_in: true },
      },
      { action: "posts.repost", input: { post_id: "700", enabled: true } },
      { action: "content.save", input: { post_id: "701", enabled: true } },
      { action: "articles.draft.save", input: { title: "Draft", body: "Body" } },
      { action: "articles.publish", input: { title: "Article", body: "Body" } },
    ];

    for (const writeCase of writeCases) {
      const captured = captureFetch([]);
      const harness = createHarness(writeCase.action, writeCase.input, captured.fetch);
      await expectRejectedWith(executeXProvider(harness.context), "exact authenticated user ID as its subject");
      expect(captured.requests).toHaveLength(0);
      expect(harness.dispatches()).toBe(0);
    }

    const mismatched = captureFetch([json({ data: { id: "99", username: "other" } })]);
    const mismatchHarness = createHarness("posts.publish", { body: "post" }, mismatched.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(mismatchHarness.context), "does not match the OAuth locator subject");
    expect(mismatched.requests.map((request) => request.url.pathname)).toEqual(["/2/users/me"]);
    expect(mismatchHarness.dispatches()).toBe(0);
  });

  test("publishes an attested reply through the v2 reply object", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "451", text: "Reply" } }, 201),
    ]);
    const harness = createHarness("replies.create", {
      target_post_id: "450",
      body: "Reply",
      recipient_opted_in: true,
      author_invited_reply: true,
    }, captured.fetch, { subject: "42" });

    await executeXProvider(harness.context);

    expect(captured.requests[1]?.url.pathname).toBe("/2/tweets");
    expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({
      text: "Reply",
      reply: { in_reply_to_tweet_id: "450" },
    });
    expect(harness.output()).toMatchObject({ published: true, post: { id: "451" } });
    expect(harness.finalUrl()).toBe("https://x.com/i/web/status/451");
  });

  test("sends only opted-in official DM-event messages", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { dm_conversation_id: "44-55", dm_event_id: "501" } }, 201),
    ]);
    const harness = createHarness("messaging.send", {
      target_kind: "conversation",
      target_id: "44-55",
      body: "A reasonable follow-up",
      recipient_opted_in: true,
    }, captured.fetch, { subject: "42" });

    await executeXProvider(harness.context);

    expect(captured.requests[1]?.url.pathname).toBe("/2/dm_conversations/44-55/messages");
    expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({ text: "A reasonable follow-up" });
    expect(harness.output()).toMatchObject({
      sent: true,
      eventId: "501",
      conversationId: "44-55",
      coverage: { encryptedChat: false },
    });
    expect(harness.dispatches()).toBe(1);

    const mismatch = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { dm_conversation_id: "42-99", dm_event_id: "502" } }, 201),
    ]);
    const mismatchHarness = createHarness("messaging.send", {
      target_kind: "participant",
      target_id: "55",
      body: "Bound recipient",
      recipient_opted_in: true,
    }, mismatch.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(mismatchHarness.context), "unexpected participant conversation");

    const self = captureFetch([]);
    const selfHarness = createHarness("messaging.send", {
      target_kind: "participant",
      target_id: "42",
      body: "Self",
      recipient_opted_in: true,
    }, self.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(selfHarness.context), "another X DM participant");
    expect(self.requests).toHaveLength(0);
  });

  test("rejects empty posts, replies, and DMs before identity lookup", async () => {
    const cases: readonly { readonly action: XAction; readonly input: OperationInput; readonly message: string }[] = [
      { action: "posts.publish", input: {}, message: "require text, reviewed media, or a poll" },
      {
        action: "replies.create",
        input: { target_post_id: "500", recipient_opted_in: true, author_invited_reply: true },
        message: "require text or reviewed media",
      },
      {
        action: "messaging.send",
        input: { target_kind: "participant", target_id: "55", recipient_opted_in: true },
        message: "require text or one reviewed attachment",
      },
    ];
    for (const value of cases) {
      const captured = captureFetch([]);
      const harness = createHarness(value.action, value.input, captured.fetch, { subject: "42" });
      await expectRejectedWith(executeXProvider(harness.context), value.message);
      expect(captured.requests).toHaveLength(0);
      expect(harness.dispatches()).toBe(0);
    }
  });

  test("chains ordered thread posts and preserves committed IDs across a later failure", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "601", text: "one" } }, 201),
      json({ data: { id: "602", text: "two" } }, 201),
      json({ title: "provider unavailable" }, 503),
    ]);
    const harness = createHarness("threads.publish", {
      items: ["one", "two", "three"],
    }, captured.fetch, { subject: "42" });

    await expectRejectedWith(executeXProvider(harness.context), "HTTP 503");

    expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({ text: "one" });
    expect(requestJson(captured.requests[2] as RequestCapture)).toEqual({
      text: "two",
      reply: { in_reply_to_tweet_id: "601" },
    });
    expect(requestJson(captured.requests[3] as RequestCapture)).toEqual({
      text: "three",
      reply: { in_reply_to_tweet_id: "602" },
    });
    expect(harness.output()).toEqual({
      provider: "x",
      operation: "threads.publish",
      complete: false,
      committed: [
        { index: 1, id: "601", url: "https://x.com/i/web/status/601" },
        { index: 2, id: "602", url: "https://x.com/i/web/status/602" },
      ],
    });
    expect(harness.dispatches()).toBe(3);
  });

  test("uses authenticated desired-state endpoints for reposts and bookmarks", async () => {
    const repostFetch = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { retweeted: true } }),
    ]);
    const repost = createHarness("posts.repost", { post_id: "700", enabled: true }, repostFetch.fetch, { subject: "42" });
    await executeXProvider(repost.context);
    expect(repostFetch.requests.map((request) => [request.init.method, request.url.pathname])).toEqual([
      ["GET", "/2/users/me"],
      ["POST", "/2/users/42/retweets"],
    ]);
    expect(requestJson(repostFetch.requests[1] as RequestCapture)).toEqual({ tweet_id: "700" });
    expect(repost.output()).toMatchObject({ operation: "posts.repost", enabled: true, result: { retweeted: true } });

    const bookmarkFetch = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { bookmarked: false } }),
    ]);
    const bookmark = createHarness("content.save", { post_id: "701", enabled: false }, bookmarkFetch.fetch, { subject: "42" });
    await executeXProvider(bookmark.context);
    expect(bookmarkFetch.requests.map((request) => [request.init.method, request.url.pathname])).toEqual([
      ["GET", "/2/users/me"],
      ["DELETE", "/2/users/42/bookmarks/701"],
    ]);
    expect(bookmark.output()).toMatchObject({ operation: "content.save", enabled: false, result: { bookmarked: false } });

    const mismatchFetch = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { retweeted: false } }),
    ]);
    const mismatch = createHarness("posts.repost", { post_id: "702", enabled: true }, mismatchFetch.fetch, { subject: "42" });
    await expectRejectedWith(executeXProvider(mismatch.context), "did not confirm the requested desired state");
  });

  test("creates deterministic plain-text DraftJS blocks before publishing an Article", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "801", title: "Deep dive" } }, 201),
      json({ data: { post_id: "802" } }),
    ]);
    const harness = createHarness("articles.publish", {
      title: "Deep dive",
      body: "First paragraph\n\nSecond paragraph",
    }, captured.fetch, { subject: "42" });

    await executeXProvider(harness.context);

    expect(captured.requests.map((request) => [request.init.method, request.url.pathname])).toEqual([
      ["GET", "/2/users/me"],
      ["POST", "/2/articles/draft"],
      ["POST", "/2/articles/801/publish"],
    ]);
    expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({
      title: "Deep dive",
      content_state: {
        blocks: [
          { type: "unstyled", text: "First paragraph", data: {}, entity_ranges: [], inline_style_ranges: [] },
          { type: "unstyled", text: "", data: {}, entity_ranges: [], inline_style_ranges: [] },
          { type: "unstyled", text: "Second paragraph", data: {}, entity_ranges: [], inline_style_ranges: [] },
        ],
        entities: [],
      },
    });
    expect(harness.output()).toMatchObject({
      published: true,
      draftId: "801",
      postId: "802",
      url: "https://x.com/i/web/status/802",
    });
    expect(harness.dispatches()).toBe(1);
  });

  test("saves an Article draft without issuing a publish request", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "805", title: "Private draft" } }, 201),
    ]);
    const harness = createHarness("articles.draft.save", {
      title: "Private draft",
      body: "First paragraph\n\nSecond paragraph",
    }, captured.fetch, { subject: "42" });

    await executeXProvider(harness.context);

    expect(captured.requests.map((request) => [request.init.method, request.url.pathname])).toEqual([
      ["GET", "/2/users/me"],
      ["POST", "/2/articles/draft"],
    ]);
    expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({
      title: "Private draft",
      content_state: {
        blocks: [
          { type: "unstyled", text: "First paragraph", data: {}, entity_ranges: [], inline_style_ranges: [] },
          { type: "unstyled", text: "", data: {}, entity_ranges: [], inline_style_ranges: [] },
          { type: "unstyled", text: "Second paragraph", data: {}, entity_ranges: [], inline_style_ranges: [] },
        ],
        entities: [],
      },
    });
    expect(harness.output()).toMatchObject({
      provider: "x",
      operation: "articles.draft.save",
      published: false,
      mode: "draft",
      draftId: "805",
    });
    expect(harness.finalUrl()).toBeNull();
    expect(harness.dispatches()).toBe(1);
  });

  test("rejects the retired draft_only branch before auth or dispatch", async () => {
    const captured = captureFetch([]);
    const harness = createHarness("articles.publish", {
      title: "Private draft",
      body: "Reviewed body",
      draft_only: true,
    }, captured.fetch, { subject: "42" });

    await expect(executeXProvider(harness.context)).rejects.toThrow(
      "input.draft_only is unsupported; use articles.draft.save",
    );
    expect(captured.requests).toHaveLength(0);
    expect(harness.dispatches()).toBe(0);
  });

  test("retains exact articles.publish@2 draft-only execution for durable recovery", async () => {
    const retainedContract = xProviderContractDefinitions.find((contract) =>
      contract.operation === "articles.publish" && contract.contractVersion === 2);
    if (retainedContract === undefined) throw new Error("retained X Article contract v2 is missing");
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "806", title: "Retained private draft" } }, 201),
    ]);
    const harness = createHarness("articles.publish", {
      title: "Retained private draft",
      body: "Reviewed body",
      draft_only: true,
    }, captured.fetch, { subject: "42" });
    const retainedContext: ProviderActionContext = {
      ...harness.context,
      contract: retainedContract,
      recipe: {
        ...harness.context.recipe,
        contractVersion: 2,
      },
    };

    await executeXProvider(retainedContext);

    expect(captured.requests.map((request) => [request.init.method, request.url.pathname])).toEqual([
      ["GET", "/2/users/me"],
      ["POST", "/2/articles/draft"],
    ]);
    expect(harness.output()).toMatchObject({
      provider: "x",
      operation: "articles.publish",
      published: false,
      mode: "draft",
      draftId: "806",
    });
    expect(harness.dispatches()).toBe(1);
  });

  test("fails a write response that contains provider errors even when data is present", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "804", text: "not accepted exactly" }, errors: [{ title: "Partial failure" }] }, 201),
    ]);
    const harness = createHarness("posts.publish", { body: "Reviewed post" }, captured.fetch, { subject: "42" });

    await expectRejectedWith(executeXProvider(harness.context), "mutation response returned provider errors");

    expect(captured.requests.map((request) => request.url.pathname)).toEqual(["/2/users/me", "/2/tweets"]);
    expect(harness.dispatches()).toBe(1);
  });

  test("does not publish an Article draft whose returned title is not the reviewed title", async () => {
    const captured = captureFetch([
      json({ data: { id: "42", username: "me" } }),
      json({ data: { id: "803", title: "Different title" } }, 201),
    ]);
    const harness = createHarness("articles.publish", {
      title: "Reviewed title",
      body: "Reviewed body",
    }, captured.fetch, { subject: "42" });

    await expectRejectedWith(executeXProvider(harness.context), "unexpected title");

    expect(captured.requests.map((request) => [request.init.method, request.url.pathname])).toEqual([
      ["GET", "/2/users/me"],
      ["POST", "/2/articles/draft"],
    ]);
    expect(harness.dispatches()).toBe(1);
  });
});

describe("official X media and failure bounds", () => {
  test("omits made_with_ai on reviewed media unless the caller explicitly sets true", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-image-unlabeled-"));
    try {
      const path = join(directory, "image.png");
      writeFileSync(path, minimalPngBytes());
      const file = fixtureFile(path, "image/png");
      for (const madeWithAi of [undefined, false] as const) {
        const captured = captureFetch([
          json({ data: { id: "42", username: "me" } }),
          json({ data: { id: "911", media_key: "3_911" } }),
          json({ data: { id: "912", text: "unlabeled image" } }, 201),
        ]);
        const harness = createHarness("posts.publish", {
          body: "unlabeled image",
          media: [{ kind: "file", reference: "test-fixture" }],
          ...(madeWithAi === undefined ? {} : { made_with_ai: madeWithAi }),
        }, captured.fetch, { files: { media: [file] }, subject: "42" });

        await executeXProvider(harness.context);

        expect(requestJson(captured.requests[2] as RequestCapture)).toEqual({
          text: "unlabeled image",
          media: { media_ids: ["911"] },
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("scrubs C2PA PNG provenance before official media upload and fails a labeled create", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-image-scrub-"));
    try {
      const path = join(directory, "image.png");
      const tainted = embedPngChunk(
        encodePixelsOnlyPng({
          width: 1,
          height: 1,
          rgba: Uint8Array.of(9, 8, 7, 255),
        }),
        "caBX",
        Buffer.from("c2pa trainedAlgorithmicMedia", "utf8"),
      );
      const scrubbed = scrubXUploadImage(tainted, "image/png");
      writeFileSync(path, tainted);
      const file = fixtureFile(path, "image/png");
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "961", media_key: "3_961" } }),
        json({ data: { id: "962", text: "scrubbed", made_with_ai: true } }, 201),
      ]);
      const harness = createHarness("posts.publish", {
        body: "scrubbed",
        media: [{ kind: "file", reference: "test-fixture" }],
      }, captured.fetch, { files: { media: [file] }, subject: "42" });

      await expectRejectedWith(executeXProvider(harness.context), X_UNLABELED_COPY_POLICY_ERROR);

      const multipart = requestMultipartText(captured.requests[1] as RequestCapture);
      expect(multipart).not.toContain("caBX");
      expect(multipart).not.toContain("c2pa");
      expect(Buffer.from(multipart, "latin1").includes(Buffer.from(scrubbed))).toBeTrue();
      expect(captured.requests.map((request) => request.url.pathname)).toEqual([
        "/2/users/me",
        "/2/media/upload",
        "/2/tweets",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uploads static images once, requests media.write, and never leaks local filenames", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-image-"));
    try {
      const path = join(directory, "private-user-photo.png");
      writeFileSync(path, minimalPngBytes());
      const file = fixtureFile(path, "image/png");
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "901", media_key: "3_901" } }),
        json({ data: { id: "901", associated_metadata: { alt_text: { text: "A compact test image" } } } }),
        json({ data: { id: "902", text: "with image" } }, 201),
      ]);
      const harness = createHarness("posts.publish", {
        media: [{ kind: "file", reference: "test-fixture" }],
        media_alt_texts: ["A compact test image"],
        made_with_ai: true,
      }, captured.fetch, { files: { media: [file] }, subject: "42" });

      await executeXProvider(harness.context);

      expect(captured.requests.map((request) => request.url.pathname)).toEqual([
        "/2/users/me",
        "/2/media/upload",
        "/2/media/metadata",
        "/2/tweets",
      ]);
      const uploadBody = captured.requests[1]?.init.body;
      expect(uploadBody).toBeInstanceOf(Uint8Array);
      const multipart = requestMultipartText(captured.requests[1] as RequestCapture);
      expect(multipart).toContain('name="media_category"\r\n\r\ntweet_image\r\n');
      expect(multipart).toContain('name="media_type"\r\n\r\nimage/png\r\n');
      expect(multipart).toContain('name="media"; filename="upload.png"\r\n');
      expect(multipart).toContain("Content-Type: image/png\r\n");
      expect(multipart).not.toContain("private-user-photo");
      expect(requestJson(captured.requests[2] as RequestCapture)).toEqual({
        id: "901",
        metadata: { alt_text: { text: "A compact test image" } },
      });
      expect(requestJson(captured.requests[3] as RequestCapture)).toEqual({
        media: { media_ids: ["901"] },
        made_with_ai: true,
      });
      expect(harness.requiredScopes()).toContain("media.write");
      expect(harness.output()).toMatchObject({ published: true, uploadedMedia: [{ id: "901", category: "tweet_image" }] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("polls one-shot image processing before publishing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-image-poll-"));
    try {
      const path = join(directory, "image.png");
      writeFileSync(path, minimalPngBytes());
      const file = fixtureFile(path, "image/png");
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "905", processing_info: { state: "pending", check_after_secs: 0 } } }),
        json({ data: { id: "905", processing_info: { state: "succeeded" } } }),
        json({ data: { id: "906" } }, 201),
      ]);
      const harness = createHarness("posts.publish", {
        body: "processed image",
        media: [{ kind: "file", reference: "image" }],
      }, captured.fetch, { files: { media: [file] }, subject: "42" });

      await executeXProvider(harness.context);

      expect(captured.requests.map((request) => [request.init.method, request.url.pathname])).toEqual([
        ["GET", "/2/users/me"],
        ["POST", "/2/media/upload"],
        ["GET", "/2/media/upload"],
        ["POST", "/2/tweets"],
      ]);
      expect(captured.requests[2]?.url.searchParams.get("command")).toBe("STATUS");
      expect(captured.requests[2]?.url.searchParams.get("media_id")).toBe("905");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on malformed or unknown media processing states", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-processing-state-"));
    try {
      const path = join(directory, "image.png");
      writeFileSync(path, minimalPngBytes());
      const file = fixtureFile(path, "image/png");
      const values: readonly { readonly processingInfo: unknown; readonly message: string }[] = [
        { processingInfo: [], message: "invalid processing_info" },
        { processingInfo: { state: "mystery" }, message: "unsupported state" },
        { processingInfo: { state: "pending", check_after_secs: -1 }, message: "invalid check_after_secs" },
      ];
      for (const value of values) {
        const captured = captureFetch([
          json({ data: { id: "42", username: "me" } }),
          json({ data: { id: "907", processing_info: value.processingInfo } }),
        ]);
        const harness = createHarness("posts.publish", {
          body: "invalid processing",
          media: [{ kind: "file", reference: "image" }],
        }, captured.fetch, { files: { media: [file] }, subject: "42" });
        await expectRejectedWith(executeXProvider(harness.context), value.message);
        expect(captured.requests.map((request) => request.url.pathname)).toEqual(["/2/users/me", "/2/media/upload"]);
        expect(harness.dispatches()).toBe(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never sleeps past the provider operation deadline while media is pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-processing-deadline-"));
    try {
      const path = join(directory, "image.png");
      writeFileSync(path, minimalPngBytes());
      const file = fixtureFile(path, "image/png");
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "908", processing_info: { state: "pending", check_after_secs: 60 } } }),
      ]);
      const harness = createHarness("posts.publish", {
        body: "bounded pending image",
        media: [{ kind: "file", reference: "image" }],
      }, captured.fetch, { files: { media: [file] }, subject: "42", timeoutMs: 500 });
      const startedAt = Date.now();

      await expectRejectedWith(executeXProvider(harness.context), "bounded polling window");

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(captured.requests.map((request) => request.url.pathname)).toEqual(["/2/users/me", "/2/media/upload"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("sends an attachment-only opted-in legacy DM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-dm-media-"));
    try {
      const path = join(directory, "message.png");
      writeFileSync(path, minimalPngBytes());
      const file = fixtureFile(path, "image/png");
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "909" } }),
        json({ data: { dm_conversation_id: "42-77", dm_event_id: "910" } }, 201),
      ]);
      const harness = createHarness("messaging.send", {
        target_kind: "participant",
        target_id: "77",
        media: { kind: "file", reference: "image" },
        recipient_opted_in: true,
      }, captured.fetch, { files: { media: [file] }, subject: "42" });

      await executeXProvider(harness.context);

      expect(captured.requests[2]?.url.pathname).toBe("/2/dm_conversations/with/77/messages");
      expect(requestJson(captured.requests[2] as RequestCapture)).toEqual({ attachments: [{ media_id: "909" }] });
      expect(harness.output()).toMatchObject({ sent: true, eventId: "910", conversationId: "42-77" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses bounded chunked GIF upload initialize/append/finalize/status inside one dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-gif-"));
    try {
      const path = join(directory, "animation.gif");
      writeFileSync(path, Buffer.from("GIF89a-test-payload", "utf8"));
      const file = fixtureFile(path, "image/gif");
      let insideDispatch = false;
      const requests: RequestCapture[] = [];
      const responses = [
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "910" } }),
        json({ data: { id: "910" } }),
        json({ data: { id: "910", processing_info: { state: "pending", check_after_secs: 0 } } }),
        json({ data: { id: "910", processing_info: { state: "succeeded" } } }),
        json({ data: { id: "911", text: "GIF" } }, 201),
      ];
      const fetch: ProviderFetch = (input, init = {}) => {
        requests.push({ url: inputUrl(input), init, insideDispatch });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected provider request");
        return Promise.resolve(response);
      };
      const base = createHarness("posts.publish", {
        body: "GIF",
        media: [{ kind: "file", reference: "test-fixture" }],
      }, fetch, { files: { media: [file] }, subject: "42" });
      const context: ProviderActionContext = {
        ...base.context,
        dispatch: async <T>(action: () => Promise<T>): Promise<T> => {
          insideDispatch = true;
          try {
            return await action();
          } finally {
            insideDispatch = false;
          }
        },
      };

      await executeXProvider(context);

      expect(requests.map((request) => [request.init.method, request.url.pathname])).toEqual([
        ["GET", "/2/users/me"],
        ["POST", "/2/media/upload/initialize"],
        ["POST", "/2/media/upload/910/append"],
        ["POST", "/2/media/upload/910/finalize"],
        ["GET", "/2/media/upload"],
        ["POST", "/2/tweets"],
      ]);
      expect(requests[0]?.insideDispatch).toBeFalse();
      expect(requests.slice(1).every((request) => request.insideDispatch)).toBeTrue();
      expect(requestJson(requests[1] as RequestCapture)).toEqual({
        media_type: "image/gif",
        total_bytes: file.bytes,
        media_category: "tweet_gif",
      });
      expect(requests[4]?.url.searchParams.get("command")).toBe("STATUS");
      expect(requests[4]?.url.searchParams.get("media_id")).toBe("910");
      const appendBody = requests[2]?.init.body;
      expect(appendBody).toBeInstanceOf(Uint8Array);
      const multipart = requestMultipartText(requests[2] as RequestCapture);
      expect(multipart).toContain('name="segment_index"\r\n\r\n0\r\n');
      expect(multipart).toContain('name="media"; filename="upload.gif"\r\n');
      expect(multipart).toContain("Content-Type: image/gif\r\n");
      expect(multipart).toContain("GIF89a-test-payload");
      expect(base.requiredScopes()).toContain("media.write");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("publishes reviewed media and accessibility text on a selected thread item", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-thread-media-"));
    try {
      const path = join(directory, "second.png");
      writeFileSync(path, minimalPngBytes());
      const file = fixtureFile(path, "image/png");
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "951", text: "one" } }, 201),
        json({ data: { id: "952" } }),
        json({ data: { id: "952", associated_metadata: { alt_text: { text: "Diagram attached to the second post" } } } }),
        json({ data: { id: "953", text: "two" } }, 201),
      ]);
      const harness = createHarness("threads.publish", {
        items: ["one", "two"],
        media: [{ kind: "file", reference: "second-image" }],
        media_item_indices: [2],
        media_alt_texts: ["Diagram attached to the second post"],
      }, captured.fetch, { files: { media: [file] }, subject: "42" });

      await executeXProvider(harness.context);

      expect(captured.requests.map((request) => request.url.pathname)).toEqual([
        "/2/users/me",
        "/2/tweets",
        "/2/media/upload",
        "/2/media/metadata",
        "/2/tweets",
      ]);
      expect(requestJson(captured.requests[1] as RequestCapture)).toEqual({ text: "one" });
      expect(requestJson(captured.requests[3] as RequestCapture)).toEqual({
        id: "952",
        metadata: { alt_text: { text: "Diagram attached to the second post" } },
      });
      expect(requestJson(captured.requests[4] as RequestCapture)).toEqual({
        text: "two",
        reply: { in_reply_to_tweet_id: "951" },
        media: { media_ids: ["952"] },
      });
      expect(harness.output()).toMatchObject({
        complete: true,
        committed: [
          { index: 1, id: "951" },
          { index: 2, id: "953", media: [{ id: "952", altText: "Diagram attached to the second post" }] },
        ],
      });
      expect(harness.requiredScopes()).toContain("media.write");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects five static images assigned to one thread item before preflight, auth, or dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-thread-image-count-"));
    try {
      const files = Array.from({ length: 5 }, (_value, index) => {
        const path = join(directory, `image-${index + 1}.png`);
        writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, index]));
        return fixtureFile(path, "image/png");
      });
      const captured = captureFetch([]);
      const harness = createHarness("threads.publish", {
        items: ["one"],
        media: files.map((_file, index) => ({ kind: "file", reference: `image-${index + 1}` })),
        media_item_indices: [1, 1, 1, 1, 1],
      }, captured.fetch, { files: { media: files }, subject: "42" });

      await expectRejectedWith(executeXProvider(harness.context), "at most four static images");

      expect(captured.requests).toHaveLength(0);
      expect(harness.dispatches()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("requires media metadata responses to bind the uploaded ID", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-alt-identity-"));
    try {
      const path = join(directory, "image.png");
      writeFileSync(path, minimalPngBytes());
      const file = fixtureFile(path, "image/png");
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "954" } }),
        json({ data: { id: "955" } }),
      ]);
      const harness = createHarness("posts.publish", {
        media: [{ kind: "file", reference: "image" }],
        media_alt_texts: ["Bound description"],
      }, captured.fetch, { files: { media: [file] }, subject: "42" });

      await expectRejectedWith(executeXProvider(harness.context), "unexpected media ID");

      expect(captured.requests.map((request) => request.url.pathname)).toEqual([
        "/2/users/me",
        "/2/media/upload",
        "/2/media/metadata",
      ]);

      const wrongText = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "956" } }),
        json({ data: { id: "956", associated_metadata: { alt_text: { text: "Different description" } } } }),
      ]);
      const wrongTextHarness = createHarness("posts.publish", {
        media: [{ kind: "file", reference: "image" }],
        media_alt_texts: ["Bound description"],
      }, wrongText.fetch, { files: { media: [file] }, subject: "42" });

      await expectRejectedWith(executeXProvider(wrongTextHarness.context), "unexpected alternative text");
      expect(wrongText.requests.map((request) => request.url.pathname)).toEqual([
        "/2/users/me",
        "/2/media/upload",
        "/2/media/metadata",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds an uploaded cover into an Article draft before publish", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-cover-"));
    try {
      const path = join(directory, "cover.jpg");
      writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const file = fixtureFile(path, "image/jpeg");
      const captured = captureFetch([
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "920", media_key: "3_920" } }),
        json({ data: { id: "921", title: "Covered" } }, 201),
        json({ data: { post_id: "922" } }),
      ]);
      const harness = createHarness("articles.publish", {
        title: "Covered",
        body: "Article body",
        cover: { kind: "file", reference: "test-cover" },
      }, captured.fetch, { files: { cover: [file] }, subject: "42" });

      await executeXProvider(harness.context);

      expect(captured.requests.map((request) => request.url.pathname)).toEqual([
        "/2/users/me",
        "/2/media/upload",
        "/2/articles/draft",
        "/2/articles/921/publish",
      ]);
      expect(requestJson(captured.requests[2] as RequestCapture)).toMatchObject({
        cover_media: { media_category: "tweet_image", media_id: "920" },
      });
      expect(harness.requiredScopes()).toContain("media.write");
      expect(harness.output()).toMatchObject({ published: true, draftId: "921", postId: "922" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects accessibility text for GIF or video attachments before auth or dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-alt-media-kind-"));
    try {
      const path = join(directory, "animation.gif");
      writeFileSync(path, Buffer.from("GIF89a", "ascii"));
      const file = fixtureFile(path, "image/gif");

      const postFetch = captureFetch([]);
      const post = createHarness("posts.publish", {
        media: [{ kind: "file", reference: "animation" }],
        media_alt_texts: ["Not supported for GIF"],
      }, postFetch.fetch, { files: { media: [file] }, subject: "42" });
      await expectRejectedWith(executeXProvider(post.context), "only a JPEG or PNG attachment");
      expect(postFetch.requests).toHaveLength(0);
      expect(post.dispatches()).toBe(0);

      const dmFetch = captureFetch([]);
      const dm = createHarness("messaging.send", {
        target_kind: "participant",
        target_id: "77",
        media: { kind: "file", reference: "animation" },
        media_alt_text: "Not supported for GIF",
        recipient_opted_in: true,
      }, dmFetch.fetch, { files: { media: [file] }, subject: "42" });
      await expectRejectedWith(executeXProvider(dm.context), "only a JPEG or PNG attachment");
      expect(dmFetch.requests).toHaveLength(0);
      expect(dm.dispatches()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects symlinked, loosely permissioned, and digest-mismatched attachments before dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-preflight-"));
    try {
      const targetPath = join(directory, "target.png");
      writeFileSync(targetPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const target = fixtureFile(targetPath, "image/png");

      const privateLinkPath = join(directory, "private-local-path.png");
      symlinkSync(targetPath, privateLinkPath);
      const symlinked: ProviderFile = { ...target, path: privateLinkPath };
      const symlinkFetch = captureFetch([]);
      const symlinkHarness = createHarness("posts.publish", {
        body: "symlink",
        media: [{ kind: "file", reference: "symlink" }],
      }, symlinkFetch.fetch, { files: { media: [symlinked] }, subject: "42" });
      const symlinkError = await expectRejectedWith(executeXProvider(symlinkHarness.context), "could not be opened safely");
      expect(symlinkError.message).not.toContain("private-local-path");
      expect(symlinkFetch.requests).toHaveLength(0);
      expect(symlinkHarness.dispatches()).toBe(0);

      chmodSync(targetPath, 0o644);
      const looseFetch = captureFetch([]);
      const looseHarness = createHarness("posts.publish", {
        body: "loose",
        media: [{ kind: "file", reference: "loose" }],
      }, looseFetch.fetch, { files: { media: [target] }, subject: "42" });
      await expectRejectedWith(executeXProvider(looseHarness.context), "current-user-owned mode-0600 regular files");
      expect(looseFetch.requests).toHaveLength(0);
      expect(looseHarness.dispatches()).toBe(0);

      chmodSync(targetPath, 0o600);
      const wrongDigest: ProviderFile = { ...target, sha256: "0".repeat(64) };
      const digestFetch = captureFetch([]);
      const digestHarness = createHarness("posts.publish", {
        body: "digest",
        media: [{ kind: "file", reference: "digest" }],
      }, digestFetch.fetch, { files: { media: [wrongDigest] }, subject: "42" });
      await expectRejectedWith(executeXProvider(digestHarness.context), "no longer matches its confirmed digest");
      expect(digestFetch.requests).toHaveLength(0);
      expect(digestHarness.dispatches()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rechecks the preflight identity before any chunked-upload request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-reopen-"));
    try {
      const path = join(directory, "animation.gif");
      writeFileSync(path, Buffer.from("GIF89a-original", "utf8"));
      const file = fixtureFile(path, "image/gif");
      const captured = captureFetch([json({ data: { id: "42", username: "me" } })]);
      const base = createHarness("posts.publish", {
        body: "changed after preflight",
        media: [{ kind: "file", reference: "gif" }],
      }, captured.fetch, { files: { media: [file] }, subject: "42" });
      const context: ProviderActionContext = {
        ...base.context,
        dispatch: async <T>(action: () => Promise<T>): Promise<T> => {
          writeFileSync(path, Buffer.from("GIF89a-modified", "utf8"));
          chmodSync(path, 0o600);
          return action();
        },
      };

      const error = await expectRejectedWith(executeXProvider(context), "official X attachment");
      expect(
        error.message.includes("identity changed after its provider preflight")
        || error.message.includes("no longer matches its confirmed digest"),
      ).toBeTrue();
      expect(captured.requests.map((request) => request.url.pathname)).toEqual(["/2/users/me"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("detects an in-place identity drift during chunk transfer and never finalizes it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-x-mid-upload-"));
    try {
      const path = join(directory, "large-animation.gif");
      const size = 4 * 1024 * 1024 + 32;
      writeFileSync(path, Buffer.alloc(size, 0x41));
      const file = fixtureFile(path, "image/gif");
      const requests: RequestCapture[] = [];
      const responses = [
        json({ data: { id: "42", username: "me" } }),
        json({ data: { id: "930" } }),
        json({ data: { id: "930" } }),
        json({ data: { id: "930" } }),
      ];
      let appendCount = 0;
      const fetch: ProviderFetch = (input, init = {}) => {
        const url = inputUrl(input);
        requests.push({ url, init, insideDispatch: url.pathname !== "/2/users/me" });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected provider request");
        if (url.pathname.endsWith("/append")) {
          appendCount += 1;
          if (appendCount === 1) {
            writeFileSync(path, Buffer.alloc(size, 0x42));
            chmodSync(path, 0o600);
          }
        }
        return Promise.resolve(response);
      };
      const harness = createHarness("posts.publish", {
        body: "drift",
        media: [{ kind: "file", reference: "gif" }],
      }, fetch, { files: { media: [file] }, subject: "42" });

      await expectRejectedWith(executeXProvider(harness.context), "identity changed during chunked upload");

      expect(requests.map((request) => request.url.pathname)).toEqual([
        "/2/users/me",
        "/2/media/upload/initialize",
        "/2/media/upload/930/append",
        "/2/media/upload/930/append",
      ]);
      expect(requests.some((request) => request.url.pathname.endsWith("/finalize"))).toBeFalse();
      expect(harness.dispatches()).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects mixed GIF/image post media before dispatch", async () => {
    const files: readonly ProviderFile[] = [
      {
        value: { kind: "file", reference: "image" },
        path: "/private/image.png",
        bytes: 10,
        mediaType: "image/png",
        sha256: "a".repeat(64),
      },
      {
        value: { kind: "file", reference: "gif" },
        path: "/private/animation.gif",
        bytes: 10,
        mediaType: "image/gif",
        sha256: "b".repeat(64),
      },
    ];
    const captured = captureFetch([]);
    const harness = createHarness("posts.publish", {
      body: "invalid media union",
      media: [
        { kind: "file", reference: "image" },
        { kind: "file", reference: "gif" },
      ],
    }, captured.fetch, { files: { media: files } });

    await expectRejectedWith(executeXProvider(harness.context), "either up to four static images or one GIF/video");
    expect(captured.requests).toHaveLength(0);
    expect(harness.dispatches()).toBe(0);
  });

  test("redacts injected transport secrets from surfaced failures", async () => {
    const secret = "unit-test-access-token";
    const fetch: ProviderFetch = () => Promise.reject(new Error(`socket failed with Bearer ${secret}`));
    const harness = createHarness("posts.read", { post_ids: ["999"] }, fetch);

    const error = await expectRejectedWith(executeXProvider(harness.context), "did not return a response");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(harness.output())).not.toContain(secret);
  });
});
