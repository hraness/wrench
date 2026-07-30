import { describe, expect, test } from "bun:test";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  executeSubstackWebOperation,
  probeSubstackWebSubject,
  type SubstackWebRuntimeDependencies,
} from "./substack-web-runtime";

const USER_ID = 42;
const SUBJECT = `substack:${USER_ID}`;
const PUBLICATION_ID = 7;
const ARTICLE_ID = 101;
const NOTE_ID = 202;
const COMMENT_ID = 303;

const boundAuth = {
  schemaVersion: 1,
  id: "substack-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Default",
  subject: SUBJECT,
} as const satisfies WrenchAuth;

const unboundAuth = {
  schemaVersion: 1,
  id: "substack-test-unbound",
  kind: "cookie-source",
  source: "arc",
  profile: "Default",
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
    name: "substack.sid",
    value: "private-cookie-value",
    domain: ".substack.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
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
): SubstackWebRuntimeDependencies {
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

function textResponse(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function preloadHtml(userId = USER_ID): string {
  const payload = JSON.stringify({
    user: {
      id: userId,
      handle: "wrench-reader",
      name: "Wrench Reader",
      dashboard_pubs: [
        {
          id: PUBLICATION_ID,
          subdomain: "wrench-owned",
          primary_user_id: userId,
          can_post_notes_as_primary_user: true,
          is_publication_primary_user: true,
        },
      ],
    },
  });
  return `<script>window._preloads = JSON.parse(${JSON.stringify(payload)});</script>`;
}

function post(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: ARTICLE_ID,
    publication_id: PUBLICATION_ID,
    title: "Article",
    body_html: "<p>Body</p>",
    reactions: {},
    audio_items: [],
    ...overrides,
  };
}

function publication(): unknown {
  return {
    id: PUBLICATION_ID,
    name: "Owned Publication",
    subdomain: "wrench-owned",
    hostname: "wrench-owned.substack.com",
    base_url: "https://wrench-owned.substack.com",
    author_id: USER_ID,
  };
}

function comment(id = COMMENT_ID, postId: number | null = ARTICLE_ID): unknown {
  return {
    id,
    user_id: 55,
    publication_id: postId === null ? null : PUBLICATION_ID,
    post_id: postId,
    body: "Comment",
    reactions: {},
    attachments: [],
  };
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "substack",
    action,
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 8 * 1024 * 1024,
  };
}

function bootstrapResponse(request: CapturedRequest, userId = USER_ID): Response | null {
  if (request.url.pathname === "/api/v1/am_i_logged_in") {
    return jsonResponse({ loggedIn: true, expires: "later", ageVerification: null });
  }
  if (request.url.pathname === "/") return textResponse(preloadHtml(userId));
  return null;
}

describe("Substack authenticated internal API runtime", () => {
  test("probes the exact current account through direct first-party reads", async () => {
    const calls: CapturedRequest[] = [];
    const subject = await probeSubstackWebSubject(unboundAuth, {
      dependencies: dependencies(calls, (request) => {
        const response = bootstrapResponse(request);
        if (response === null) throw new Error(`unexpected ${request.url.pathname}`);
        return response;
      }),
    });
    expect(subject).toBe(SUBJECT);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/v1/am_i_logged_in",
      "/",
    ]);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.redirect).toBe("error");
      expect(call.headers.get("cookie")).toContain("substack.sid=");
      expect(call.body).toBeNull();
    }
  });

  test("executes every observed R1 contract with no dispatch callback", async () => {
    const scenarios: readonly {
      readonly action: WebSessionRecipe["action"];
      readonly input: OperationInput;
      readonly expectedSemanticPaths: readonly string[];
      readonly verify: (output: unknown) => void;
    }[] = [
      {
        action: "feeds.read",
        input: { feed: "notes", limit: 1 },
        expectedSemanticPaths: ["/api/v1/reader/feed"],
        verify: (output) => expect((output as { items: readonly unknown[] }).items).toHaveLength(1),
      },
      {
        action: "posts.read",
        input: { note_id: NOTE_ID },
        expectedSemanticPaths: [`/api/v1/reader/comment/${NOTE_ID}`],
        verify: (output) => expect((output as { comment: { id: number } }).comment.id).toBe(NOTE_ID),
      },
      {
        action: "articles.read",
        input: { article_id: ARTICLE_ID },
        expectedSemanticPaths: [`/api/v1/posts/by-id/${ARTICLE_ID}`],
        verify: (output) => expect((output as { post: { id: number } }).post.id).toBe(ARTICLE_ID),
      },
      {
        action: "media.read",
        input: { article_id: ARTICLE_ID },
        expectedSemanticPaths: [`/api/v1/posts/by-id/${ARTICLE_ID}`],
        verify: (output) => expect((output as { articleId: number }).articleId).toBe(ARTICLE_ID),
      },
      {
        action: "comments.read",
        input: { article_id: ARTICLE_ID, publication_id: PUBLICATION_ID, limit: 5 },
        expectedSemanticPaths: [
          `/api/v1/posts/by-id/${ARTICLE_ID}`,
          `/api/v1/reader/post/${ARTICLE_ID}/replies`,
        ],
        verify: (output) => expect((output as { comments: readonly unknown[] }).comments).toHaveLength(1),
      },
      {
        action: "messaging.list",
        input: { folder: "people", limit: 5 },
        expectedSemanticPaths: ["/api/v1/messages/inbox"],
        verify: (output) => expect((output as { threads: readonly unknown[] }).threads).toHaveLength(1),
      },
    ];

    for (const scenario of scenarios) {
      const calls: CapturedRequest[] = [];
      let beforeDispatch = 0;
      let afterDispatch = 0;
      const result = await executeSubstackWebOperation(
        recipe(scenario.action),
        scenario.input,
        boundAuth,
        {
          beforeDispatch: () => {
            beforeDispatch += 1;
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            afterDispatch += 1;
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            switch (request.url.pathname) {
              case "/api/v1/reader/feed":
                return jsonResponse({
                  items: [{
                    entity_key: `c-${NOTE_ID}`,
                    type: "comment",
                    comment: comment(NOTE_ID, null),
                    post: null,
                    publication: null,
                    canReply: true,
                  }],
                  nextCursor: null,
                });
              case `/api/v1/reader/comment/${NOTE_ID}`:
                return jsonResponse({
                  item: {
                    entity_key: `c-${NOTE_ID}`,
                    type: "comment",
                    comment: comment(NOTE_ID, null),
                    post: null,
                    publication: null,
                  },
                });
              case `/api/v1/posts/by-id/${ARTICLE_ID}`:
                return jsonResponse({ post: post(), publication: publication() });
              case `/api/v1/reader/post/${ARTICLE_ID}/replies`:
                expect(request.url.searchParams.get("publication_id")).toBe(String(PUBLICATION_ID));
                return jsonResponse({
                  commentBranches: [{ comment: comment(), descendantComments: [] }],
                  nextCursor: null,
                  moreBranches: 0,
                });
              case "/api/v1/messages/inbox":
                expect(request.url.searchParams.get("tab")).toBe("people");
                return jsonResponse({
                  threads: [{
                    id: "thread-1",
                    type: "direct-message",
                    title: "Conversation",
                    user: { id: 55, name: "Recipient", handle: "recipient" },
                    publication: null,
                  }],
                  more: false,
                });
              default:
                throw new Error(`unexpected ${request.url.pathname}`);
            }
          }),
        },
      );
      expect(result.status).toBe("succeeded");
      expect(result.dispatchStarted).toBe(false);
      expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      expect(beforeDispatch).toBe(0);
      expect(afterDispatch).toBe(0);
      expect(calls.slice(2).map((call) => call.url.pathname)).toEqual(
        [...scenario.expectedSemanticPaths],
      );
      scenario.verify(result.output);
    }
  });

  test("rejects capture-required operations before cookies or network are touched", () => {
    for (const action of [
      "messaging.read",
      "likes.set",
      "content.save",
      "messaging.send",
      "posts.publish",
      "articles.publish",
    ] as const) {
      let acquisitions = 0;
      expect(executeSubstackWebOperation(
        recipe(action),
        {},
        boundAuth,
        {
          dependencies: dependencies([], () => {
            throw new Error("network must not run");
          }, () => {
            acquisitions += 1;
          }),
        },
      )).rejects.toThrow("capture-required");
      expect(acquisitions).toBe(0);
    }
  });

  test("fails closed when the signed-in viewer changes before the semantic read", () => {
    const calls: CapturedRequest[] = [];
    expect(executeSubstackWebOperation(
      recipe("feeds.read"),
      { feed: "notes" },
      boundAuth,
      {
        dependencies: dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request, USER_ID + 1);
          if (bootstrap !== null) return bootstrap;
          throw new Error("semantic request must not run");
        }),
      },
    )).rejects.toThrow("no longer matches");
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/v1/am_i_logged_in",
      "/",
    ]);
  });

  test("fails closed on cross-origin and publication mismatches", () => {
    const calls: CapturedRequest[] = [];
    expect(executeSubstackWebOperation(
      recipe("comments.read"),
      { article_id: ARTICLE_ID, publication_id: PUBLICATION_ID + 1 },
      boundAuth,
      {
        dependencies: dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request);
          if (bootstrap !== null) return bootstrap;
          if (request.url.pathname === `/api/v1/posts/by-id/${ARTICLE_ID}`) {
            return jsonResponse({ post: post(), publication: publication() });
          }
          throw new Error("replies request must not run");
        }),
      },
    )).rejects.toThrow("did not match");
    expect(calls.at(-1)?.url.pathname).toBe(`/api/v1/posts/by-id/${ARTICLE_ID}`);
  });
});
