import { describe, expect, test } from "bun:test";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "../operation-deadline";
import { createWebSessionClient } from "../web-session-client";
import {
  dispatchHackerNewsFavoriteAction,
  parseHackerNewsFavoriteAction,
} from "./hacker-news-web";
import {
  executeHackerNewsWebOperation,
  probeHackerNewsWebSubject,
  type HackerNewsWebRuntimeDependencies,
} from "./hacker-news-web-runtime";

const USERNAME = "wrench_user";
const SUBJECT = `hacker-news:${USERNAME}`;
const POST_ID = "49020868";
const COMMENT_ID = "49021000";
const AUTH = "synthetic-request-bound-auth";

const hackerNewsAuth = {
  schemaVersion: 1,
  id: "hacker-news-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: SUBJECT,
} as const satisfies WrenchAuth;

const unboundHackerNewsAuth = {
  schemaVersion: 1,
  id: "hacker-news-test-unbound",
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
  readonly signal: AbortSignal | null;
};

class FakeMonotonicClock implements OperationDeadlineClock {
  #nowMs = 0;
  #nextId = 1;
  readonly #scheduled = new Map<number, {
    readonly at: number;
    readonly callback: () => void;
  }>();

  readonly now = (): number => this.#nowMs;

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#scheduled.set(id, { at: this.#nowMs + delayMs, callback });
    return () => {
      this.#scheduled.delete(id);
    };
  };

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds;
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, value]) => value.at <= this.#nowMs)
        .sort((left, right) =>
          left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }

  pendingTimers(): number {
    return this.#scheduled.size;
  }
}

function strictCookie(): StrictCookie {
  return {
    name: "user",
    value: "private-hacker-news-cookie",
    domain: "news.ycombinator.com",
    hostOnly: true,
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
  onAcquire?: (selection: Parameters<CookieRecordReader>[0]) => void,
): HackerNewsWebRuntimeDependencies & {
  readonly acquireCookies: CookieRecordReader;
  readonly fetch: typeof globalThis.fetch;
} {
  const acquireCookies: CookieRecordReader = (selection) => {
    onAcquire?.(selection);
    return Promise.resolve({ cookies: [strictCookie()], warnings: [] });
  };
  const fetch = (async (value: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: requestUrl(value),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      redirect: typeof init?.redirect === "string" ? init.redirect : undefined,
      signal: init?.signal instanceof AbortSignal ? init.signal : null,
    };
    calls.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return { acquireCookies, fetch };
}

function htmlResponse(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function viewer(username = USERNAME): string {
  return `<a href="user?id=${username}" id="me">${username}</a>`;
}

function submission(id = POST_ID, extra = ""): string {
  return [
    `<tr class="athing submission" id="${id}">`,
    `<td><span class="titleline"><a href="https://example.com/${id}">Runtime story</a></span></td>`,
    "</tr>",
    "<tr><td class=\"subtext\">",
    `<span class="score">7 points</span> by <a href="user?id=author" class="hnuser">author</a> `,
    `<span class="age" title="2026-07-23T12:00:00 1784808000"><a href="item?id=${id}">one hour ago</a></span> | `,
    `<a href="item?id=${id}">1 comment</a>`,
    "</td></tr>",
    extra,
  ].join("");
}

function comment(): string {
  return [
    `<tr class="athing comtr" id="${COMMENT_ID}">`,
    "<td><table><tr><td class=\"ind\" indent=\"0\"></td><td>",
    `<a href="user?id=commenter" class="hnuser">commenter</a> `,
    `<span class="age" title="2026-07-23T12:01:00 1784808060"><a href="item?id=${COMMENT_ID}">59 minutes ago</a></span>`,
    "<div class=\"commtext c00\">Runtime comment</div>",
    "</td></tr></table></td></tr>",
  ].join("");
}

function newsHtml(username = USERNAME): string {
  return `<html><body>${viewer(username)}${submission()}</body></html>`;
}

function itemHtml(username = USERNAME): string {
  return `<html><body>${viewer(username)}${submission()}${comment()}</body></html>`;
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "hacker-news",
    action,
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 4 * 1024 * 1024,
  };
}

describe("Hacker News authenticated first-party runtime", () => {
  test("probes the current username through the exact signed-in /news page", async () => {
    const calls: CapturedRequest[] = [];
    const subject = await probeHackerNewsWebSubject(
      unboundHackerNewsAuth,
      {
        dependencies: dependencies(calls, (request) => {
          expect(request.url.href).toBe("https://news.ycombinator.com/news");
          expect(request.method).toBe("GET");
          expect(request.redirect).toBe("error");
          expect(request.headers.get("cookie")).toContain("user=");
          return htmlResponse(newsHtml());
        }),
      },
    );
    expect(subject).toBe(SUBJECT);
    expect(calls).toHaveLength(1);
  });

  test("executes every observed R1 operation without mutation callbacks", async () => {
    const scenarios: readonly {
      readonly action: WebSessionRecipe["action"];
      readonly input: OperationInput;
      readonly verify: (output: unknown) => void;
    }[] = [
      {
        action: "feeds.read",
        input: { feed: "news", limit: 1 },
        verify: (output) => expect(output).toMatchObject({
          posts: [{ id: POST_ID, title: "Runtime story" }],
        }),
      },
      {
        action: "posts.read",
        input: { item_id: POST_ID },
        verify: (output) => expect(output).toMatchObject({
          post: { id: POST_ID, score: 7 },
        }),
      },
      {
        action: "comments.read",
        input: { post_id: POST_ID, limit: 10 },
        verify: (output) => expect(output).toMatchObject({
          post: { id: POST_ID },
          comments: [{ id: COMMENT_ID, parentId: POST_ID }],
        }),
      },
    ];
    for (const scenario of scenarios) {
      const calls: CapturedRequest[] = [];
      let callbacks = 0;
      const result = await executeHackerNewsWebOperation(
        recipe(scenario.action),
        scenario.input,
        hackerNewsAuth,
        {
          dependencies: dependencies(calls, (request) => {
            if (request.url.pathname === "/news") return htmlResponse(newsHtml());
            if (request.url.pathname === "/item") {
              expect(request.url.searchParams.get("id")).toBe(POST_ID);
              expect([...request.url.searchParams.keys()]).toEqual(["id"]);
              return htmlResponse(itemHtml());
            }
            throw new Error(`unexpected request ${request.url.href}`);
          }),
          beforeDispatch: () => {
            callbacks += 1;
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            callbacks += 1;
            return Promise.resolve();
          },
        },
      );
      expect(result.status).toBe("succeeded");
      expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      expect(callbacks).toBe(0);
      scenario.verify(result.output);
      expect(calls.map((request) => request.url.pathname)).toEqual(
        scenario.action === "feeds.read" ? ["/news"] : ["/news", "/item"],
      );
    }
  });

  test("shares one inherited deadline across a built-in multi-request read", async () => {
    const clock = new FakeMonotonicClock();
    const operationDeadline = new OperationDeadline(100, { clock });
    const calls: CapturedRequest[] = [];
    const remainingBudgets: number[] = [];
    try {
      const result = await executeHackerNewsWebOperation(
        recipe("posts.read"),
        { item_id: POST_ID },
        hackerNewsAuth,
        {
          signal: operationDeadline.signal,
          operationDeadline,
          dependencies: dependencies(
            calls,
            (request) => {
              remainingBudgets.push(operationDeadline.remainingTimeMs());
              clock.advance(request.url.pathname === "/news" ? 25 : 20);
              return htmlResponse(
                request.url.pathname === "/news" ? newsHtml() : itemHtml(),
              );
            },
            (selection) => {
              expect(selection.timeoutMs).toBe(100);
              clock.advance(10);
            },
          ),
        },
      );

      expect(result.status).toBe("succeeded");
      expect(calls.map((request) => request.url.pathname)).toEqual([
        "/news",
        "/item",
      ]);
      expect(calls.map((request) => request.signal)).toEqual([
        operationDeadline.signal,
        operationDeadline.signal,
      ]);
      expect(remainingBudgets).toEqual([90, 65]);
      expect(operationDeadline.remainingTimeMs()).toBe(45);
      expect(clock.pendingTimers()).toBe(1);
    } finally {
      operationDeadline.dispose();
    }
    expect(clock.pendingTimers()).toBe(0);
  });

  test("rejects an account mismatch before fetching the requested item", () => {
    const calls: CapturedRequest[] = [];
    expect(executeHackerNewsWebOperation(
      recipe("posts.read"),
      { item_id: POST_ID },
      hackerNewsAuth,
      {
        dependencies: dependencies(calls, () => htmlResponse(newsHtml("another_user"))),
      },
    )).rejects.toThrow("no longer matches");
    expect(calls.map((request) => request.url.pathname)).toEqual(["/news"]);
  });

  test("keeps every write reservation network-inert", () => {
    for (const action of [
      "content.save",
      "reactions.set",
      "comments.create",
      "replies.create",
      "posts.publish",
      "content.edit",
    ] as const) {
      let acquisitions = 0;
      expect(executeHackerNewsWebOperation(
        recipe(action),
        {},
        hackerNewsAuth,
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
});

describe("Hacker News request-bound manual redirect transport", () => {
  function favoriteHtml(path: "fave" | "unfave"): string {
    return submission(
      POST_ID,
      `<a href="${path}?id=${POST_ID}&amp;auth=${AUTH}&amp;goto=item%3Fid%3D${POST_ID}">${path}</a>`,
    );
  }

  test("sends one ephemeral favorite token with redirect manual and returns only a safe location", async () => {
    const calls: CapturedRequest[] = [];
    const network = dependencies(calls, (request) => {
      expect(request.redirect).toBe("manual");
      expect(request.method).toBe("GET");
      expect(request.url.pathname).toBe("/fave");
      expect([...request.url.searchParams.keys()]).toEqual(["id", "auth", "goto"]);
      expect(request.url.searchParams.get("id")).toBe(POST_ID);
      expect(request.url.searchParams.get("auth")).toBe(AUTH);
      expect(request.url.searchParams.get("goto")).toBe(`item?id=${POST_ID}`);
      expect(request.headers.get("cookie")).toContain("user=");
      return new Response(null, {
        status: 302,
        headers: { location: `/item?id=${POST_ID}` },
      });
    });
    const client = await createWebSessionClient(
      "https://news.ycombinator.com",
      hackerNewsAuth,
      {
        timeoutMs: 1_000,
        dependencies: network,
      },
    );
    let dispatches = 0;
    const result = await dispatchHackerNewsFavoriteAction(
      client,
      parseHackerNewsFavoriteAction(favoriteHtml("fave"), POST_ID),
      true,
      () => {
        dispatches += 1;
        return Promise.resolve();
      },
      { timeoutMs: 1_000, fetch: network.fetch },
    );
    expect(result).toEqual({ status: 302, location: `/item?id=${POST_ID}` });
    expect(dispatches).toBe(1);
    expect(JSON.stringify(result)).not.toContain(AUTH);
    expect(calls).toHaveLength(1);
  });

  test("rejects desired-state mismatch before dispatch and cross-origin redirects after one dispatch", async () => {
    const noOpCalls: CapturedRequest[] = [];
    const noOpClient = await createWebSessionClient(
      "https://news.ycombinator.com",
      hackerNewsAuth,
      {
        timeoutMs: 1_000,
        dependencies: dependencies(noOpCalls, () => {
          throw new Error("network must not run");
        }),
      },
    );
    let mismatchDispatches = 0;
    expect(dispatchHackerNewsFavoriteAction(
      noOpClient,
      parseHackerNewsFavoriteAction(favoriteHtml("fave"), POST_ID),
      false,
      () => {
        mismatchDispatches += 1;
        return Promise.resolve();
      },
    )).rejects.toThrow("does not match");
    expect(mismatchDispatches).toBe(0);
    expect(noOpCalls).toHaveLength(0);

    const redirectCalls: CapturedRequest[] = [];
    const redirectNetwork = dependencies(redirectCalls, () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/leak" },
      }));
    const redirectClient = await createWebSessionClient(
      "https://news.ycombinator.com",
      hackerNewsAuth,
      {
        timeoutMs: 1_000,
        dependencies: redirectNetwork,
      },
    );
    let redirectDispatches = 0;
    expect(dispatchHackerNewsFavoriteAction(
      redirectClient,
      parseHackerNewsFavoriteAction(favoriteHtml("fave"), POST_ID),
      true,
      () => {
        redirectDispatches += 1;
        return Promise.resolve();
      },
      { timeoutMs: 1_000, fetch: redirectNetwork.fetch },
    )).rejects.toThrow("unreviewed redirect");
    expect(redirectDispatches).toBe(1);
    expect(redirectCalls).toHaveLength(1);
  });

  test("rejects forged and already-consumed request-bound favorite actions", async () => {
    const calls: CapturedRequest[] = [];
    const network = dependencies(calls, () =>
      new Response(null, {
        status: 302,
        headers: { location: `/item?id=${POST_ID}` },
      }));
    const client = await createWebSessionClient(
      "https://news.ycombinator.com",
      hackerNewsAuth,
      {
        timeoutMs: 1_000,
        dependencies: network,
      },
    );
    expect(dispatchHackerNewsFavoriteAction(
      client,
      {
        path: "/fave",
        targetId: POST_ID,
        auth: AUTH,
        goto: `item?id=${POST_ID}`,
        nextSavedState: true,
      },
      true,
      () => Promise.resolve(),
      { timeoutMs: 1_000, fetch: network.fetch },
    )).rejects.toThrow("immediate parsed provider page");
    const parsed = parseHackerNewsFavoriteAction(favoriteHtml("fave"), POST_ID);
    await dispatchHackerNewsFavoriteAction(
      client,
      parsed,
      true,
      () => Promise.resolve(),
      { timeoutMs: 1_000, fetch: network.fetch },
    );
    expect(dispatchHackerNewsFavoriteAction(
      client,
      parsed,
      true,
      () => Promise.resolve(),
      { timeoutMs: 1_000, fetch: network.fetch },
    )).rejects.toThrow("immediate parsed provider page");
    expect(calls).toHaveLength(1);
  });

  test("rejects request-bound proof in redirect URLs", async () => {
    const proofNetwork = dependencies([], () =>
      new Response(null, {
        status: 302,
        headers: { location: `/item?id=${POST_ID}&auth=${AUTH}` },
      }));
    const client = await createWebSessionClient(
      "https://news.ycombinator.com",
      hackerNewsAuth,
      {
        timeoutMs: 1_000,
        dependencies: proofNetwork,
      },
    );
    expect(dispatchHackerNewsFavoriteAction(
      client,
      parseHackerNewsFavoriteAction(favoriteHtml("fave"), POST_ID),
      true,
      () => Promise.resolve(),
      { timeoutMs: 1_000, fetch: proofNetwork.fetch },
    )).rejects.toThrow("request-bound proof");
  });
});
