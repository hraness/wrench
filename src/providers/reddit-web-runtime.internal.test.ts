import { describe, expect, test } from "bun:test";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  executeRedditWebOperation,
  prepareRedditWebDesiredState,
  probeRedditWebSubject,
  readRedditWebDesiredState,
  type RedditWebRuntimeDependencies,
} from "./reddit-web-runtime";

const VIEWER_ID = "viewer1";
const SUBJECT = `reddit:t2_${VIEWER_ID}`;
const POST_ID = "t3_abc123";
const COMMENT_ID = "t1_def456";
const MESSAGE_ID = "t4_msg123";
const FIRST_MODHASH = "first-synthetic-modhash";

const redditAuth = {
  schemaVersion: 1,
  id: "reddit-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: SUBJECT,
} as const satisfies WrenchAuth;

const unboundRedditAuth = {
  schemaVersion: 1,
  id: "reddit-test-unbound",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
} as const satisfies WrenchAuth;

type CapturedRequest = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
  readonly redirect: string | undefined;
};

function strictCookie(): StrictCookie {
  return {
    name: "reddit_session",
    value: "private-cookie-value",
    domain: ".reddit.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None",
    expires: 0,
  };
}

function requestUrl(value: string | URL | Request): URL {
  return new URL(typeof value === "string" ? value : value instanceof URL ? value.href : value.url);
}

function dependencies(
  calls: CapturedRequest[],
  handler: (request: CapturedRequest) => Response | Promise<Response>,
  onAcquire?: () => void,
): RedditWebRuntimeDependencies {
  const acquireCookies: CookieRecordReader = () => {
    onAcquire?.();
    return Promise.resolve({ cookies: [strictCookie()], warnings: [] });
  };
  const fetch = (async (value: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: requestUrl(value),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      redirect: typeof init?.redirect === "string" ? init.redirect : undefined,
    };
    calls.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return { acquireCookies, fetch };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function viewerResponse(modhash = FIRST_MODHASH, id = VIEWER_ID): unknown {
  return {
    kind: "t2",
    data: {
      id,
      name: "wrench_viewer",
      modhash,
    },
  };
}

function listing(children: readonly unknown[], after: string | null = null): unknown {
  return {
    kind: "Listing",
    data: { after, before: null, children },
  };
}

function postThing(
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    kind: "t3",
    data: {
      name: POST_ID,
      title: "Runtime post",
      selftext: "Runtime body",
      author: "poster",
      subreddit: "wrench",
      created_utc: 1_700_000_000,
      score: 5,
      num_comments: 1,
      likes: null,
      saved: false,
      url: "https://www.reddit.com/r/wrench/comments/abc123/runtime_post/",
      permalink: "/r/wrench/comments/abc123/runtime_post/",
      ...overrides,
    },
  };
}

function commentThing(): unknown {
  return {
    kind: "t1",
    data: {
      name: COMMENT_ID,
      link_id: POST_ID,
      parent_id: POST_ID,
      author: "commenter",
      body: "Runtime comment",
      created_utc: 1_700_000_001,
      score: 2,
      depth: 0,
      likes: null,
      saved: false,
      permalink: "/r/wrench/comments/abc123/runtime_post/def456/",
      replies: "",
    },
  };
}

function messageThing(): unknown {
  return {
    kind: "t4",
    data: {
      name: MESSAGE_ID,
      author: "sender",
      dest: "wrench_viewer",
      subject: "Subject",
      body: "Message body",
      created_utc: 1_700_000_002,
      new: true,
      parent_id: null,
      context: "/message/messages/msg123",
      replies: "",
    },
  };
}

function stateThing(
  thingId: string,
  liked: boolean | null,
  saved: boolean,
): unknown {
  return {
    kind: thingId.startsWith("t1_") ? "t1" : "t3",
    data: { name: thingId, liked, likes: liked, saved },
  };
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "reddit",
    action,
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 4 * 1024 * 1024,
  };
}

describe("Reddit authenticated internal API runtime", () => {
  test("probes the exact current account through /api/me.json", async () => {
    const calls: CapturedRequest[] = [];
    const subject = await probeRedditWebSubject(
      unboundRedditAuth,
      {
        dependencies: dependencies(calls, (request) => {
          expect(request.url.pathname).toBe("/api/me.json");
          expect(request.method).toBe("GET");
          expect(request.redirect).toBe("error");
          expect(request.headers.get("cookie")).toContain("reddit_session=");
          expect(request.headers.get("user-agent")).toBe(
            "wrench/1.0 (local authenticated web client)",
          );
          return jsonResponse(viewerResponse());
        }),
      },
    );
    expect(subject).toBe(SUBJECT);
    expect(calls).toHaveLength(1);
  });

  test("executes all observed R1 operations through exact target-bound requests", async () => {
    const scenarios: readonly {
      readonly action: WebSessionRecipe["action"];
      readonly input: OperationInput;
      readonly expectedPath: string;
      readonly response: unknown;
      readonly verify: (output: unknown) => void;
    }[] = [
      {
        action: "feeds.read",
        input: { feed: "home", limit: 1 },
        expectedPath: "/.json",
        response: listing([postThing()]),
        verify: (output) => expect(output).toMatchObject({
          posts: [{ id: POST_ID, title: "Runtime post" }],
        }),
      },
      {
        action: "posts.read",
        input: { post_id: POST_ID },
        expectedPath: "/comments/abc123.json",
        response: [listing([postThing()]), listing([])],
        verify: (output) => expect(output).toMatchObject({ post: { id: POST_ID } }),
      },
      {
        action: "comments.read",
        input: { post_id: POST_ID, limit: 10 },
        expectedPath: "/comments/abc123.json",
        response: [listing([postThing()]), listing([commentThing()])],
        verify: (output) => expect(output).toMatchObject({
          post: { id: POST_ID },
          comments: [{ id: COMMENT_ID, postId: POST_ID }],
        }),
      },
      {
        action: "messaging.list",
        input: { folder: "inbox", limit: 10 },
        expectedPath: "/message/inbox.json",
        response: listing([messageThing()]),
        verify: (output) => expect(output).toMatchObject({
          messages: [{ id: MESSAGE_ID, kind: "message" }],
        }),
      },
      {
        action: "messaging.read",
        input: { folder: "inbox", message_id: MESSAGE_ID },
        expectedPath: "/message/inbox.json",
        response: listing([messageThing()]),
        verify: (output) => expect(output).toMatchObject({
          requested: { id: MESSAGE_ID, body: "Message body" },
        }),
      },
    ];

    for (const scenario of scenarios) {
      const calls: CapturedRequest[] = [];
      let beforeDispatches = 0;
      let afterDispatches = 0;
      const result = await executeRedditWebOperation(
        recipe(scenario.action),
        scenario.input,
        redditAuth,
        {
          dependencies: dependencies(calls, (request) => {
            if (request.url.pathname === "/api/me.json") return jsonResponse(viewerResponse());
            expect(request.url.pathname).toBe(scenario.expectedPath);
            expect(request.method).toBe("GET");
            expect(request.redirect).toBe("error");
            if (scenario.action === "messaging.list" || scenario.action === "messaging.read") {
              expect(request.url.searchParams.get("mark")).toBe("false");
            }
            return jsonResponse(scenario.response);
          }),
          beforeDispatch: () => {
            beforeDispatches += 1;
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            afterDispatches += 1;
            return Promise.resolve();
          },
        },
      );
      expect(result.status).toBe("succeeded");
      expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      expect(beforeDispatches).toBe(0);
      expect(afterDispatches).toBe(0);
      scenario.verify(result.output);
      expect(calls[0]?.url.pathname).toBe("/api/me.json");
      expect(calls).toHaveLength(2);
    }
  });

  test("keeps deterministic mutation implementations inert until a live fixture is authorized", () => {
    for (const [action, input] of [
      ["content.save", { thing_id: POST_ID, saved: true }],
      ["reactions.set", { thing_id: COMMENT_ID, direction: -1 }],
    ] as const) {
      let acquisitions = 0;
      const calls: CapturedRequest[] = [];
      expect(executeRedditWebOperation(
        recipe(action),
        input,
        redditAuth,
        {
          dependencies: dependencies(calls, () => {
            throw new Error("network must not run");
          }, () => {
            acquisitions += 1;
          }),
        },
      )).rejects.toThrow("capture-required");
      expect(acquisitions).toBe(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("prepares save and every reaction no-op through reads before any dispatch", async () => {
    const scenarios = [
      {
        action: "content.save",
        input: { thing_id: POST_ID, saved: true },
        thingId: POST_ID,
        liked: null,
        saved: true,
        desiredState: true,
      },
      {
        action: "reactions.set",
        input: { thing_id: COMMENT_ID, direction: -1 },
        thingId: COMMENT_ID,
        liked: false,
        saved: false,
        desiredState: false,
      },
      {
        action: "reactions.set",
        input: { thing_id: COMMENT_ID, direction: 0 },
        thingId: COMMENT_ID,
        liked: null,
        saved: false,
        desiredState: null,
      },
    ] as const;
    for (const scenario of scenarios) {
      const calls: CapturedRequest[] = [];
      const preparation = await prepareRedditWebDesiredState(
        recipe(scenario.action),
        scenario.input,
        redditAuth,
        {
          dependencies: dependencies(calls, (request) => {
            if (request.url.pathname === "/api/me.json") {
              return jsonResponse(viewerResponse());
            }
            expect(request.url.pathname).toBe("/api/info.json");
            expect(request.url.searchParams.get("id")).toBe(scenario.thingId);
            return jsonResponse(listing([
              stateThing(scenario.thingId, scenario.liked, scenario.saved),
            ]));
          }),
        },
      );
      expect(preparation).toMatchObject({
        operation: scenario.action,
        thingId: scenario.thingId,
        desiredState: scenario.desiredState,
        actualState: scenario.desiredState,
        alreadyDesired: true,
      });
      expect(calls.map((request) => request.method)).toEqual(["GET", "GET"]);
      expect(calls.some((request) => request.url.pathname.startsWith("/api/save")))
        .toBeFalse();
      expect(calls.some((request) => request.url.pathname === "/api/unsave"))
        .toBeFalse();
      expect(calls.some((request) => request.url.pathname === "/api/vote"))
        .toBeFalse();
    }
  });

  test("exports the exact account-bound saved-state reconciliation readback", async () => {
    const calls: CapturedRequest[] = [];
    const readback = await readRedditWebDesiredState(
      recipe("content.save"),
      { thing_id: POST_ID, saved: false },
      redditAuth,
      {
        dependencies: dependencies(calls, (request) => {
          if (request.url.pathname === "/api/me.json") {
            return jsonResponse(viewerResponse());
          }
          return jsonResponse(listing([stateThing(POST_ID, null, true)]));
        }),
      },
    );
    expect(readback).toEqual({ kind: "saved", enabled: true, thingId: POST_ID });
    expect(calls.map((request) => request.url.pathname)).toEqual([
      "/api/me.json",
      "/api/info.json",
    ]);
    expect(calls.every((request) => request.method === "GET")).toBeTrue();
  });

  test("fails account mismatch before the target request and rejects reservations before cookie acquisition", () => {
    const mismatchCalls: CapturedRequest[] = [];
    expect(executeRedditWebOperation(
      recipe("feeds.read"),
      { feed: "home" },
      redditAuth,
      {
        dependencies: dependencies(mismatchCalls, (request) => {
          expect(request.url.pathname).toBe("/api/me.json");
          return jsonResponse(viewerResponse(FIRST_MODHASH, "another"));
        }),
      },
    )).rejects.toThrow("no longer matches");
    expect(mismatchCalls).toHaveLength(1);

    let acquisitions = 0;
    expect(executeRedditWebOperation(
      recipe("messaging.send"),
      { recipient: "nobody", body: "not sent" },
      redditAuth,
      {
        dependencies: dependencies([], () => {
          throw new Error("network must not run");
        }, () => {
          acquisitions += 1;
        }),
      },
    )).rejects.toThrow("capture-required");
    expect(acquisitions).toBe(0);
  });
});
