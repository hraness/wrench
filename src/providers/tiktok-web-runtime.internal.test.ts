import { describe, expect, test } from "bun:test";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { WebSessionRecipe } from "../model";
import {
  executeTikTokWebOperation,
  probeTikTokWebSubject,
  type TikTokWebRuntimeDependencies,
} from "./tiktok-web-runtime";

const VIEWER_ID = "1234567890123456789";
const VIEWER_SEC_UID = `MS4wLjABAAAA${"a".repeat(48)}`;
const POST_ID = "7491234567890123456";

const boundAuth = {
  schemaVersion: 1,
  id: "tiktok-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: `tiktok:uid:${VIEWER_ID}/sec:${VIEWER_SEC_UID}`,
} as const satisfies WrenchAuth;

type CapturedRequest = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
};

function strictCookie(name: string, value: string): StrictCookie {
  return {
    name,
    value,
    domain: "www.tiktok.com",
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: 0,
  };
}

const cookies = Object.freeze([
  strictCookie("sessionid", "private-session-cookie"),
  strictCookie("tt_csrf_token", "private-csrf-cookie"),
]);

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function viewerResponse(viewerId = VIEWER_ID): unknown {
  return {
    statusCode: 0,
    status_code: 0,
    status_msg: "",
    userInfo: {
      user: {
        id: viewerId,
        secUid: VIEWER_SEC_UID,
        uniqueId: "wrench_test",
        nickname: "Wrench Test",
      },
    },
  };
}

function feedResponse(): unknown {
  return {
    statusCode: 0,
    status_code: 0,
    hasMore: false,
    itemList: [{
      id: POST_ID,
      desc: "A feed post",
      createTime: 1_753_200_000,
      digged: false,
      collected: false,
      author: {
        id: "1000000000000000001",
        secUid: `MS4wLjABAAAA${"b".repeat(48)}`,
        uniqueId: "creator",
        nickname: "Creator",
      },
      stats: {
        diggCount: 4,
        commentCount: 3,
        shareCount: 2,
        playCount: 10,
      },
      video: {
        id: "video-1",
        duration: 14,
        width: 1080,
        height: 1920,
        ratio: "720p",
      },
    }],
  };
}

function commentsResponse(postId = POST_ID): unknown {
  return {
    status_code: 0,
    cursor: 20,
    has_more: 0,
    total: 1,
    comments: [{
      cid: "7491234567890123001",
      aweme_id: postId,
      text: "A useful comment",
      create_time: 1_753_200_001,
      digg_count: 2,
      reply_comment_total: 0,
      reply_id: "0",
      reply_to_reply_id: "0",
      user_digged: 0,
      user: {
        uid: "1000000000000000002",
        sec_uid: `MS4wLjABAAAA${"c".repeat(48)}`,
        unique_id: "commenter",
        nickname: "Commenter",
      },
    }],
  };
}

function inputUrl(value: string | URL | Request): URL {
  return new URL(typeof value === "string" ? value : value instanceof URL ? value.href : value.url);
}

function dependencies(
  calls: CapturedRequest[],
  handler: (request: CapturedRequest) => Response | Promise<Response>,
  cookieAcquisitions?: { count: number },
): TikTokWebRuntimeDependencies {
  const acquireCookies: CookieRecordReader = () => {
    if (cookieAcquisitions !== undefined) cookieAcquisitions.count += 1;
    return Promise.resolve({ cookies, warnings: [] });
  };
  const fetch = (async (value: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    const request: CapturedRequest = {
      url: inputUrl(value),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof body === "string" ? body : null,
    };
    calls.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return { acquireCookies, fetch };
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "tiktok",
    action,
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 4 * 1024 * 1024,
  };
}

async function rejectionMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

describe("TikTok authenticated internal-API runtime", () => {
  test("probes the exact current-account endpoint and namespaces the bound uid", async () => {
    const calls: CapturedRequest[] = [];
    const subject = await probeTikTokWebSubject(boundAuth, {
      dependencies: dependencies(calls, (request) => {
        expect(request.url.href).toBe("https://www.tiktok.com/api/user/detail/self/");
        expect(request.method).toBe("GET");
        expect(request.body).toBeNull();
        expect(request.headers.get("accept")).toBe("application/json, text/plain, */*");
        expect(request.headers.get("referer")).toBe("https://www.tiktok.com/");
        expect(request.headers.get("cookie")).toContain("sessionid=");
        expect(request.headers.has("tt-csrf-token")).toBeFalse();
        return jsonResponse(viewerResponse());
      }),
    });
    expect(subject).toBe(`tiktok:uid:${VIEWER_ID}/sec:${VIEWER_SEC_UID}`);
    expect(calls).toHaveLength(1);
  });

  test("executes an exact signer-free For You read after viewer binding", async () => {
    const calls: CapturedRequest[] = [];
    let beforeDispatch = 0;
    let afterVerified = 0;
    const result = await executeTikTokWebOperation(
      recipe("feeds.read"),
      { feed: "for-you", limit: 5 },
      boundAuth,
      {
        beforeDispatch: () => {
          beforeDispatch += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          afterVerified += 1;
          return Promise.resolve();
        },
        dependencies: dependencies(calls, (request) => {
          if (request.url.pathname === "/api/user/detail/self/") return jsonResponse(viewerResponse());
          expect(request.url.pathname).toBe("/api/recommend/item_list/");
          expect(Object.fromEntries(request.url.searchParams)).toEqual({ aid: "1988", count: "5" });
          expect(request.url.searchParams.has("X-Bogus")).toBeFalse();
          expect(request.method).toBe("GET");
          expect(request.body).toBeNull();
          expect(request.headers.has("tt-csrf-token")).toBeFalse();
          return jsonResponse(feedResponse());
        }),
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: { posts: [{ id: POST_ID }], hasMore: false },
      finalUrl: "https://www.tiktok.com/foryou",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect(calls).toHaveLength(2);
    expect(beforeDispatch).toBe(0);
    expect(afterVerified).toBe(0);
  });

  test("executes acknowledgement-free comment reads with exact post and cursor binding", async () => {
    const calls: CapturedRequest[] = [];
    const result = await executeTikTokWebOperation(
      recipe("comments.read"),
      { post_id: POST_ID, cursor: 10, limit: 20 },
      boundAuth,
      {
        dependencies: dependencies(calls, (request) => {
          if (request.url.pathname === "/api/user/detail/self/") return jsonResponse(viewerResponse());
          expect(request.url.pathname).toBe("/api/comment/list/");
          expect(Object.fromEntries(request.url.searchParams)).toEqual({
            aid: "1988",
            aweme_id: POST_ID,
            count: "20",
            cursor: "10",
          });
          return jsonResponse(commentsResponse());
        }),
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        comments: [{ postId: POST_ID }],
        cursor: 20,
        hasMore: false,
      },
      dispatchStarted: false,
    });
    expect(calls).toHaveLength(2);
  });

  test("rejects changed account identity before making the operation request", async () => {
    const calls: CapturedRequest[] = [];
    const message = await rejectionMessage(executeTikTokWebOperation(
      recipe("feeds.read"),
      { feed: "for-you" },
      boundAuth,
      {
        dependencies: dependencies(calls, () => jsonResponse(viewerResponse("999999999999999999"))),
      },
    ));
    expect(message).toContain("viewer no longer matches");
    expect(calls).toHaveLength(1);
  });

  test("fails closed when a comment response contains another post", async () => {
    const calls: CapturedRequest[] = [];
    const message = await rejectionMessage(executeTikTokWebOperation(
      recipe("comments.read"),
      { post_id: POST_ID },
      boundAuth,
      {
        dependencies: dependencies(calls, (request) =>
          jsonResponse(request.url.pathname === "/api/user/detail/self/"
            ? viewerResponse()
            : commentsResponse("7491234567890123999"))),
      },
    ));
    expect(message).toContain("did not bind the requested post");
    expect(calls).toHaveLength(2);
  });

  test("rejects every capture-required write before cookie acquisition or dispatch callbacks", async () => {
    for (const action of [
      "likes.set",
      "content.save",
      "relationships.follow.set",
      "comments.create",
      "replies.create",
      "messaging.send",
      "posts.publish",
      "media.publish",
      "content.schedule",
      "content.share",
      "posts.repost",
    ] as const) {
      const calls: CapturedRequest[] = [];
      const acquisitions = { count: 0 };
      let callbacks = 0;
      const message = await rejectionMessage(executeTikTokWebOperation(
        recipe(action),
        {},
        boundAuth,
        {
          beforeDispatch: () => {
            callbacks += 1;
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            callbacks += 1;
            return Promise.resolve();
          },
          dependencies: dependencies(calls, () => {
            throw new Error("capture-required operation reached the network");
          }, acquisitions),
        },
      ));
      expect(message).toContain("capture-required");
      expect(acquisitions.count).toBe(0);
      expect(calls).toHaveLength(0);
      expect(callbacks).toBe(0);
    }
  });
});
