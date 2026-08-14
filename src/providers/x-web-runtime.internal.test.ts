import { describe, expect, test } from "bun:test";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { BrowserSession } from "../browser";
import type { WebSessionRecipe } from "../model";
import type { WebSessionDispatchEvent } from "../web-session";
import {
  buildXWebArticleContentState,
  executeXWebOperation,
  readXWebDesiredState,
  resolveCurrentXWebChunkUrl,
  type XWebRuntimeDependencies,
} from "./x-web-runtime";

const MAIN_URL = "https://abs.twimg.com/responsive-web/client-web/main.abcdef12.js";
const VIEWER_QUERY_ID = "5XShkXk2oO2J7SYmTu6pvw";
const ARTICLE_QUERY_ID = "btD9FyMDa3_vydVp7fr87Q";
const ARTICLE_BUNDLE_URL = "https://abs.twimg.com/responsive-web/client-web/bundle.TwitterArticles.305538ca.js";
const VIEWER_ID = "123456789012345678";
const FOCAL_POST_ID = "2078889282404569267";
const CREATED_POST_ID = "2078889282404569266";
const QUOTED_POST_ID = "2078889282404569265";
const CURRENT_BEARER = `AAAA${"b".repeat(88)}==`;
const CLIENT_TRANSACTION_ID = "synthetic_transaction_id_0123456789";

const xAuth = {
  schemaVersion: 1,
  id: "x-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: VIEWER_ID,
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
    domain: "x.com",
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: 0,
  };
}

const xCookies = Object.freeze([
  strictCookie("ct0", "csrf_token_0123456789abcdef"),
  strictCookie("auth_token", "private-auth-cookie"),
]);

function descriptor(
  operationName: string,
  queryId: string,
  operationType: "query" | "mutation",
): string {
  return `queryId:"${queryId}",operationName:"${operationName}",operationType:"${operationType}",metadata:{featureSwitches:[],fieldToggles:[]}`;
}

function mainBundle(...descriptors: readonly string[]): string {
  return [
    `const authorization="${CURRENT_BEARER}"`,
    ...descriptors.map((value) => value.replaceAll("u4ni7JqpqdAQxWQfkLsdUQ", VIEWER_QUERY_ID)),
    "previousModule()},991160(e,t,r){\"use strict\";let transactionRuntime;r.d(t,{Ay:()=>l,_E:()=>s,kc:()=>a})",
    "transactionRuntime=transactionRuntime||new Promise(done=>{r.e(59924).then(r.bind(r,208932)).then(module=>done(module.default()))})",
    "feature.isTrue(\"rweb_client_transaction_id_enabled\")&&(headers[\"x-client-transaction-id\"]=await a(request.host,request.path,request.method))}",
  ].join(";");
}

function articleHtml(): string {
  return `${homeHtml()}<script>p.u=e=>({31770:"bundle.TwitterArticles"})[e]||e)+"."+({31770:"305538c"})[e]+"a.js"</script>`;
}

function homeHtml(): string {
  const initialState = JSON.stringify({ featureSwitch: { user: { config: {} } } });
  return `<!doctype html><html><head><script src="${MAIN_URL}"></script><script>window.__INITIAL_STATE__=${initialState};window.__META_DATA__={};</script></head><body></body></html>`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function viewerResponse(viewerId = VIEWER_ID): unknown {
  return {
    data: {
      viewer: {
        user_results: {
          result: {
            rest_id: viewerId,
            legacy: { screen_name: "wrench_test" },
          },
        },
      },
    },
  };
}

function tweetByIdResponse(id: string, favorited: boolean): unknown {
  return {
    data: {
      tweetResult: {
        result: {
          __typename: "Tweet",
          rest_id: id,
          legacy: { favorited },
        },
      },
    },
  };
}

function tweetEntry(id: string, text: string, authorId = VIEWER_ID, replyTo: string | null = null): unknown {
  return {
    entryId: `tweet-${id}`,
    sortIndex: id,
    content: {
      entryType: "TimelineTimelineItem",
      itemContent: {
        itemType: "TimelineTweet",
        tweet_results: {
          result: {
            __typename: "Tweet",
            rest_id: id,
            legacy: {
              full_text: text,
              user_id_str: authorId,
              created_at: "Tue Jul 22 12:00:00 +0000 2026",
              reply_count: 1,
              retweet_count: 2,
              favorite_count: 3,
              bookmark_count: 4,
              ...(replyTo === null ? {} : { in_reply_to_status_id_str: replyTo }),
            },
          },
        },
      },
    },
  };
}

function tweetDetailResponse(...entries: readonly unknown[]): unknown {
  return {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [{ type: "TimelineAddEntries", entries }],
      },
    },
  };
}

function cursorEntry(value: string): unknown {
  return {
    entryId: "cursor-bottom",
    sortIndex: "1",
    content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value },
  };
}

function timeline(...entries: readonly unknown[]): unknown {
  return { instructions: [{ type: "TimelineAddEntries", entries }] };
}

function userFeedResponse(userId: string, ...entries: readonly unknown[]): unknown {
  return {
    data: {
      user: {
        result: {
          rest_id: userId,
          timeline: { timeline: timeline(...entries) },
        },
      },
    },
  };
}

function listFeedResponse(listId: string | null, ...entries: readonly unknown[]): unknown {
  return {
    data: {
      list: {
        ...(listId === null ? {} : { rest_id: listId }),
        tweets_timeline: { timeline: timeline(...entries) },
      },
    },
  };
}

function createTweetResponse(options: {
  readonly text: string;
  readonly authorId?: string;
  readonly replyTo?: string | null;
  readonly quote?: string | null;
}): unknown {
  return {
    data: {
      create_tweet: {
        tweet_results: {
          result: {
            rest_id: CREATED_POST_ID,
            legacy: {
              full_text: options.text,
              user_id_str: options.authorId ?? VIEWER_ID,
              ...(options.replyTo === undefined || options.replyTo === null
                ? {}
                : { in_reply_to_status_id_str: options.replyTo }),
              ...(options.quote === undefined || options.quote === null
                ? {}
                : { quoted_status_id_str: options.quote }),
            },
          },
        },
      },
    },
  };
}

function inputUrl(value: string | URL | Request): URL {
  return new URL(typeof value === "string" ? value : value instanceof URL ? value.href : value.url);
}

function dependencies(
  calls: CapturedRequest[],
  handler: (request: CapturedRequest) => Response | Promise<Response>,
  options: {
    readonly createBrowserSession?: NonNullable<XWebRuntimeDependencies["createBrowserSession"]>;
  } = {},
): XWebRuntimeDependencies {
  const acquireCookies: CookieRecordReader = () => Promise.resolve({ cookies: xCookies, warnings: [] });
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
  const createTransactionBrowser: NonNullable<XWebRuntimeDependencies["createBrowserSession"]> =
    options.createBrowserSession ?? (() => {
      const session: BrowserSession = {
        runBatch: (batch) => {
          const command = batch[0];
          if (batch.length !== 1 || command === undefined) throw new Error("unexpected transaction browser batch");
          if (command[0] === "get" && command[1] === "url") {
            return Promise.resolve([{ success: true, data: { url: "https://x.com/home" } }]);
          }
          if (command[0] === "eval") {
            return Promise.resolve([{
              success: true,
              data: { origin: "https://x.com/", result: CLIENT_TRANSACTION_ID },
            }]);
          }
          return Promise.resolve([{ success: true, data: null }]);
        },
        close: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      };
      return Promise.resolve(session);
    });
  return { acquireCookies, fetch, createBrowserSession: createTransactionBrowser };
}

function xRecipe(action: WebSessionRecipe["action"], contractVersion = 1): WebSessionRecipe {
  return {
    site: "x",
    action,
    contractVersion,
    timeoutMs: 1_000,
    maxOutputBytes: 2 * 1024 * 1024,
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

describe("X authenticated internal-API runtime", () => {
  test("resolves one reviewed logical webpack chunk through the current page map", () => {
    const html = [
      "prefix;p.u=e=>({101:\"unrelated\",202:\"shared~bundle.LoggedInMain~bundle.HomeTimeline\"}",
      ")[e]||e)+\".\"+({101:\"1111111\",202:\"deadbee\"}",
      ")[e]+\"a.js\";suffix",
    ].join("");

    expect(resolveCurrentXWebChunkUrl(
      html,
      "shared~bundle.LoggedInMain~bundle.HomeTimeline.e992705a.js",
    ).href).toBe(
      "https://abs.twimg.com/responsive-web/client-web/shared~bundle.LoggedInMain~bundle.HomeTimeline.deadbeea.js",
    );
    expect(() => resolveCurrentXWebChunkUrl(html, "missing.12345678.js")).toThrow("one unique reviewed logical chunk");
  });

  test("resolves a reviewed shared-chunk family after X appends one bundle member", () => {
    const html = [
      "prefix;p.u=e=>({202:\"shared~bundle.LoggedInMain~bundle.HomeTimeline~bundle.Compose\"}",
      ")[e]||e)+\".\"+({202:\"deadbee\"}",
      ")[e]+\"a.js\";suffix",
    ].join("");

    expect(resolveCurrentXWebChunkUrl(
      html,
      "shared~bundle.LoggedInMain~bundle.HomeTimeline.e992705a.js",
    ).href).toBe(
      "https://abs.twimg.com/responsive-web/client-web/shared~bundle.LoggedInMain~bundle.HomeTimeline~bundle.Compose.deadbeea.js",
    );
  });

  test("prefers the exact reviewed chunk over related shared-chunk extensions", () => {
    const html = [
      "prefix;p.u=e=>({202:\"shared~bundle.BookmarkFolders~bundle.Bookmarks\",",
      "203:\"shared~bundle.BookmarkFolders~bundle.Bookmarks~bundle.Explore\"}",
      ")[e]||e)+\".\"+({202:\"deadbee\",203:\"feedbee\"}",
      ")[e]+\"a.js\";suffix",
    ].join("");

    expect(resolveCurrentXWebChunkUrl(
      html,
      "shared~bundle.BookmarkFolders~bundle.Bookmarks.12fa7b2a.js",
    ).href).toBe(
      "https://abs.twimg.com/responsive-web/client-web/shared~bundle.BookmarkFolders~bundle.Bookmarks.deadbeea.js",
    );
  });

  test("fails closed for substring-only and ambiguous shared-chunk family matches", () => {
    const substringOnly = [
      "prefix;p.u=e=>({202:\"prefix~shared~bundle.LoggedInMain~bundle.HomeTimeline\"}",
      ")[e]||e)+\".\"+({202:\"deadbee\"}",
      ")[e]+\"a.js\";suffix",
    ].join("");
    expect(() => resolveCurrentXWebChunkUrl(
      substringOnly,
      "shared~bundle.LoggedInMain~bundle.HomeTimeline.e992705a.js",
    )).toThrow("one unique reviewed logical chunk");

    const ambiguous = [
      "prefix;p.u=e=>({202:\"shared~bundle.LoggedInMain~bundle.HomeTimeline~bundle.Compose\",",
      "203:\"shared~bundle.LoggedInMain~bundle.HomeTimeline~bundle.DirectMessages\"}",
      ")[e]||e)+\".\"+({202:\"deadbee\",203:\"feedbee\"}",
      ")[e]+\"a.js\";suffix",
    ].join("");
    expect(() => resolveCurrentXWebChunkUrl(
      ambiguous,
      "shared~bundle.LoggedInMain~bundle.HomeTimeline.e992705a.js",
    )).toThrow("one unique reviewed logical chunk");
  });

  test("rejects duplicate webpack name and hash bindings", () => {
    const duplicateName = [
      "prefix;p.u=e=>({202:\"shared~bundle.LoggedInMain~bundle.HomeTimeline\",",
      "202:\"shared~bundle.LoggedInMain~bundle.HomeTimeline\"}",
      ")[e]||e)+\".\"+({202:\"deadbee\"}",
      ")[e]+\"a.js\";suffix",
    ].join("");
    expect(() => resolveCurrentXWebChunkUrl(
      duplicateName,
      "shared~bundle.LoggedInMain~bundle.HomeTimeline.e992705a.js",
    )).toThrow("duplicate webpack chunk name");

    const duplicateHash = [
      "prefix;p.u=e=>({202:\"shared~bundle.LoggedInMain~bundle.HomeTimeline\"}",
      ")[e]||e)+\".\"+({202:\"deadbee\",202:\"feedbee\"}",
      ")[e]+\"a.js\";suffix",
    ].join("");
    expect(() => resolveCurrentXWebChunkUrl(
      duplicateHash,
      "shared~bundle.LoggedInMain~bundle.HomeTimeline.e992705a.js",
    )).toThrow("duplicate webpack chunk hash");
  });

  test("converts exact plain text to the reviewed native Article content state", () => {
    expect(buildXWebArticleContentState("First paragraph\n\nAudio: https://example.com/track")).toEqual({
      blocks: [
        { type: "unstyled", text: "First paragraph", data: {}, entity_ranges: [], inline_style_ranges: [] },
        { type: "unstyled", text: "", data: {}, entity_ranges: [], inline_style_ranges: [] },
        { type: "unstyled", text: "Audio: https://example.com/track", data: {}, entity_ranges: [], inline_style_ranges: [] },
      ],
      entity_map: [],
    });
    expect(() => buildXWebArticleContentState("")).toThrow("1-20000");
    expect(() => buildXWebArticleContentState("x\r\ny")).toThrow("1-20000");
    expect(() => buildXWebArticleContentState(Array.from({ length: 2_001 }, () => "x").join("\n")))
      .toThrow("at most 2000");
  });

  test("binds user-feed responses to the requested user before exposing a page", async () => {
    for (const [returnedUserId, expected] of [
      [VIEWER_ID, "succeeded"],
      ["999", "did not bind the requested user"],
    ] as const) {
      const calls: CapturedRequest[] = [];
      const runtimeDependencies = dependencies(calls, (request) => {
        if (request.url.href === "https://x.com/home") {
          return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
        }
        if (request.url.href === MAIN_URL) {
          return new Response(mainBundle(
            descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
            descriptor("UserTweets", "6r5OLCC_wFH4CpRyXKuAmQ", "query"),
          ), { headers: { "content-type": "application/javascript" } });
        }
        if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
        if (request.url.pathname.endsWith("/UserTweets")) {
          expect(JSON.parse(request.url.searchParams.get("variables") ?? "null")).toMatchObject({
            userId: VIEWER_ID,
            count: 10,
          });
          return jsonResponse(userFeedResponse(
            returnedUserId,
            tweetEntry(FOCAL_POST_ID, "user feed post"),
            cursorEntry("next-user-page"),
          ));
        }
        throw new Error(`unexpected test request ${request.url.href}`);
      });
      const execution = executeXWebOperation(
        xRecipe("feeds.read"),
        { feed: "user", user_id: VIEWER_ID, limit: 10 },
        xAuth,
        { dependencies: runtimeDependencies },
      );
      if (expected === "succeeded") {
        expect(await execution).toMatchObject({
          status: "succeeded",
          output: { posts: [{ id: FOCAL_POST_ID }], cursor: "next-user-page" },
        });
      } else {
        expect(await rejectionMessage(execution)).toContain(expected);
      }
    }
  });

  test("binds List-feed responses to one returned List identity", async () => {
    const logicalChunk = "shared~loader.Dock~bundle.BookmarkFolders~bundle.Bookmarks~bundle.Explore~bundle.HomeTimeline~bundle.Notifica";
    const html = `${homeHtml()}<script>p.u=e=>({101:"unrelated",202:"${logicalChunk}"})[e]||e)+"."+({101:"1111111",202:"deadbee"})[e]+"a.js"</script>`;
    for (const [returnedListId, expected] of [
      ["42", "succeeded"],
      [null, "did not bind the requested List"],
      ["99", "did not bind the requested List"],
    ] as const) {
      const calls: CapturedRequest[] = [];
      const runtimeDependencies = dependencies(calls, (request) => {
        if (request.url.href === "https://x.com/home") {
          return new Response(html, { headers: { "content-type": "text/html" } });
        }
        if (request.url.href === MAIN_URL) {
          return new Response(mainBundle(descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query")), {
            headers: { "content-type": "application/javascript" },
          });
        }
        if (request.url.hostname === "abs.twimg.com" && request.url.href !== MAIN_URL) {
          return new Response(descriptor("ListLatestTweetsTimeline", "LV64djPRhnsVhGCK76s13w", "query"), {
            headers: { "content-type": "application/javascript" },
          });
        }
        if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
        if (request.url.pathname.endsWith("/ListLatestTweetsTimeline")) {
          return jsonResponse(listFeedResponse(
            returnedListId,
            tweetEntry(FOCAL_POST_ID, "List feed post"),
          ));
        }
        throw new Error(`unexpected test request ${request.url.href}`);
      });
      const execution = executeXWebOperation(
        xRecipe("feeds.read"),
        { feed: "list", list_id: "42", limit: 10 },
        xAuth,
        { dependencies: runtimeDependencies },
      );
      if (expected === "succeeded") expect((await execution).status).toBe("succeeded");
      else expect(await rejectionMessage(execution)).toContain(expected);
    }
  });

  test("never returns a provider end cursor after truncating unseen feed entries", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("UserTweets", "6r5OLCC_wFH4CpRyXKuAmQ", "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      return jsonResponse(userFeedResponse(
        VIEWER_ID,
        tweetEntry(FOCAL_POST_ID, "first"),
        tweetEntry(CREATED_POST_ID, "second"),
        cursorEntry("would-skip-second"),
      ));
    });
    const message = await rejectionMessage(executeXWebOperation(
      xRecipe("feeds.read"),
      { feed: "user", user_id: VIEWER_ID, limit: 1 },
      xAuth,
      { dependencies: runtimeDependencies },
    ));
    expect(message).toContain("more entries than the requested limit");
    expect(message).toContain("no continuation cursor was exposed");
  });

  test("bootstraps the current bearer including terminal equals and performs one exact direct TweetDetail read", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (request.url.href === MAIN_URL) {
        expect(request.headers.get("cookie")).toBeNull();
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("TweetDetail", "rZA6K31W4E90vZKBmxXV3g", "query"),
        ), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname === "/i/api/graphql/rZA6K31W4E90vZKBmxXV3g/TweetDetail") {
        expect(request.method).toBe("GET");
        expect([...request.url.searchParams.keys()]).toEqual(["variables"]);
        expect(JSON.parse(request.url.searchParams.get("variables") ?? "null")).toEqual({
          focalTweetId: FOCAL_POST_ID,
          referrer: "tweet",
          with_rux_injections: false,
          includePromotedContent: false,
          rankingMode: "Recency",
          withCommunity: false,
          withQuickPromoteEligibilityTweetFields: true,
          withBirdwatchNotes: false,
          withVoice: false,
        });
        expect(request.headers.get("authorization")).toBe(`Bearer ${CURRENT_BEARER}`);
        expect(request.headers.get("x-csrf-token")).toBe("csrf_token_0123456789abcdef");
        expect(request.headers.get("x-client-transaction-id")).toBeNull();
        expect(request.headers.get("cookie")).toContain("auth_token=private-auth-cookie");
        return jsonResponse(tweetDetailResponse(tweetEntry(FOCAL_POST_ID, "captured post")));
      }
      throw new Error(`unexpected test request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("posts.read"),
      { post_id: FOCAL_POST_ID },
      xAuth,
      { dependencies: runtimeDependencies },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      finalUrl: `https://x.com/i/status/${FOCAL_POST_ID}`,
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
      output: { post: { id: FOCAL_POST_ID, text: "captured post", authorId: VIEWER_ID } },
    });
    expect(calls.map((call) => `${call.method} ${call.url.origin}${call.url.pathname}`)).toEqual([
      "GET https://x.com/home",
      "GET https://abs.twimg.com/responsive-web/client-web/main.abcdef12.js",
      `GET https://x.com/i/api/graphql/${VIEWER_QUERY_ID}/Viewer`,
      "GET https://x.com/i/api/graphql/rZA6K31W4E90vZKBmxXV3g/TweetDetail",
    ]);
  });

  test("rejects a TweetDetail response that omits the requested focal post", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("TweetDetail", "rZA6K31W4E90vZKBmxXV3g", "query"),
        ), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      return jsonResponse(tweetDetailResponse(tweetEntry(CREATED_POST_ID, "wrong focal post")));
    });

    expect(await rejectionMessage(executeXWebOperation(
      xRecipe("posts.read"),
      { post_id: FOCAL_POST_ID },
      xAuth,
      { dependencies: runtimeDependencies },
    ))).toContain("requested focal post");
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
  });

  test("binds comments to the focal reply ancestry and excludes injected conversation rows", async () => {
    const directReplyId = "2078889282404569201";
    const nestedReplyId = "2078889282404569202";
    const unrelatedId = "2078889282404569203";
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("TweetDetail", "rZA6K31W4E90vZKBmxXV3g", "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/TweetDetail")) {
        return jsonResponse(tweetDetailResponse(
          tweetEntry(FOCAL_POST_ID, "root"),
          tweetEntry(nestedReplyId, "nested", VIEWER_ID, directReplyId),
          tweetEntry(unrelatedId, "injected"),
          tweetEntry(directReplyId, "direct", VIEWER_ID, FOCAL_POST_ID),
        ));
      }
      throw new Error(`unexpected test request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("comments.read"),
      { post_id: FOCAL_POST_ID, limit: 10 },
      xAuth,
      { dependencies: runtimeDependencies },
    );
    expect(result.output).toMatchObject({
      comments: [
        { id: directReplyId, replyToPostId: FOCAL_POST_ID },
        { id: nestedReplyId, replyToPostId: directReplyId },
      ],
    });
    expect(JSON.stringify(result.output)).not.toContain(unrelatedId);
  });

  test("never returns a conversation end cursor after truncating unseen replies", async () => {
    const firstReplyId = "2078889282404569201";
    const secondReplyId = "2078889282404569202";
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("TweetDetail", "rZA6K31W4E90vZKBmxXV3g", "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      return jsonResponse(tweetDetailResponse(
        tweetEntry(FOCAL_POST_ID, "root"),
        tweetEntry(firstReplyId, "first", VIEWER_ID, FOCAL_POST_ID),
        tweetEntry(secondReplyId, "second", VIEWER_ID, FOCAL_POST_ID),
        cursorEntry("would-skip-second-reply"),
      ));
    });
    const message = await rejectionMessage(executeXWebOperation(
      xRecipe("comments.read"),
      { post_id: FOCAL_POST_ID, limit: 1 },
      xAuth,
      { dependencies: runtimeDependencies },
    ));
    expect(message).toContain("more entries than the requested limit");
    expect(message).toContain("no continuation cursor was exposed");
  });

  test("requires a bound X viewer and rejects an account switch before a post read", async () => {
    const unboundCalls: CapturedRequest[] = [];
    const { subject: _subject, ...unboundAuth } = xAuth;
    void _subject;
    const unboundMessage = await rejectionMessage(executeXWebOperation(
      xRecipe("posts.read"),
      { post_id: FOCAL_POST_ID },
      unboundAuth,
      {
        dependencies: dependencies(unboundCalls, (request) => {
          if (request.url.href === "https://x.com/home") return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
          if (request.url.href === MAIN_URL) return new Response(mainBundle(), { headers: { "content-type": "application/javascript" } });
          throw new Error("must not dispatch an internal API read");
        }),
      },
    ));
    expect(unboundMessage).toContain("bound to the exact viewer subject");
    expect(unboundCalls).toHaveLength(2);

    const switchedCalls: CapturedRequest[] = [];
    const switchedMessage = await rejectionMessage(executeXWebOperation(
      xRecipe("posts.read"),
      { post_id: FOCAL_POST_ID },
      xAuth,
      {
        dependencies: dependencies(switchedCalls, (request) => {
          if (request.url.href === "https://x.com/home") return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
          if (request.url.href === MAIN_URL) {
            return new Response(mainBundle(descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query")), {
              headers: { "content-type": "application/javascript" },
            });
          }
          if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse("999"));
          throw new Error("must not dispatch the focal post read");
        }),
      },
    ));
    expect(switchedMessage).toContain("no longer matches");
    expect(switchedCalls.some((call) => call.url.pathname.endsWith("/TweetDetail"))).toBeFalse();
  });

  test("creates one response-bound private Article draft and never calls the publish mutation", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const title = "Private native Article";
    const body = "First paragraph\n\nAudio: https://hraness.com/example-track";
    const articleId = "2088317732278190081";
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(articleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", VIEWER_QUERY_ID, "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response(descriptor("ArticleEntityDraftCreate", ARTICLE_QUERY_ID, "mutation"), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/ArticleEntityDraftCreate")) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-client-transaction-id")).toBe(CLIENT_TRANSACTION_ID);
        expect(JSON.parse(request.body ?? "null")).toEqual({
          variables: {
            content_state: {
              blocks: [
                { type: "unstyled", text: "First paragraph", data: {}, entity_ranges: [], inline_style_ranges: [] },
                { type: "unstyled", text: "", data: {}, entity_ranges: [], inline_style_ranges: [] },
                { type: "unstyled", text: "Audio: https://hraness.com/example-track", data: {}, entity_ranges: [], inline_style_ranges: [] },
              ],
              entity_map: [],
            },
            title,
          },
          features: {},
          queryId: ARTICLE_QUERY_ID,
        });
        return jsonResponse({
          data: {
            articleentity_create_draft: {
              article_entity_results: { result: { rest_id: articleId, title } },
            },
          },
        });
      }
      throw new Error(`unexpected Article draft request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.publish", 2),
      { title, body, draft_only: true },
      xAuth,
      {
        dependencies: runtimeDependencies,
        beforeDispatch: (event) => {
          before.push(event);
          return Promise.resolve();
        },
        afterDispatchVerified: (event) => {
          after.push(event);
          return Promise.resolve();
        },
      },
    );

    expect(result).toEqual({
      status: "succeeded",
      output: {
        provider: "x",
        operation: "articles.publish",
        published: false,
        mode: "draft",
        draftId: articleId,
        title,
        url: `https://x.com/compose/articles/edit/${articleId}`,
      },
      finalUrl: `https://x.com/compose/articles/edit/${articleId}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(before).toEqual([{
      id: "articles.publish",
      index: 1,
      progress: { planned: 1, started: 0, verified: 0 },
    }]);
    expect(after).toEqual([{
      id: "articles.publish",
      index: 1,
      progress: { planned: 1, started: 1, verified: 1 },
    }]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityPublish"))).toBeFalse();
  });

  test("refuses publish-capable Article inputs before mutation dispatch", async () => {
    const calls: CapturedRequest[] = [];
    let transactionSessions = 0;
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(articleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", VIEWER_QUERY_ID, "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      throw new Error(`unexpected request after Article draft preflight ${request.url.href}`);
    }, {
      createBrowserSession: () => {
        transactionSessions += 1;
        throw new Error("Article draft preflight must not create a transaction browser");
      },
    });

    expect(await rejectionMessage(executeXWebOperation(
      xRecipe("articles.publish", 2),
      { title: "No publish", body: "Body", draft_only: false },
      xAuth,
      { dependencies: runtimeDependencies },
    ))).toContain("draft_only=true");
    expect(transactionSessions).toBe(0);
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
  });

  test("leaves an Article draft indeterminate when the create response does not bind the confirmed title", async () => {
    const calls: CapturedRequest[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(articleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", VIEWER_QUERY_ID, "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response(descriptor("ArticleEntityDraftCreate", ARTICLE_QUERY_ID, "mutation"), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/ArticleEntityDraftCreate")) {
        return jsonResponse({
          data: {
            articleentity_create_draft: {
              article_entity_results: {
                result: { rest_id: "2088317732278190082", title: "Different title" },
              },
            },
          },
        });
      }
      throw new Error(`unexpected mismatched Article response request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.publish", 2),
      { title: "Confirmed title", body: "Body", draft_only: true },
      xAuth,
      {
        dependencies: runtimeDependencies,
        afterDispatchVerified: (event) => {
          after.push(event);
          return Promise.resolve();
        },
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
    });
    expect(after).toEqual([]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  test("records mutation dispatch only immediately before the direct CreateTweet request and verifies afterward", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const body = "runtime dispatch fixture";
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("CreateTweet", "hIL9XdleMYEtVXOZVbr8Bg", "mutation"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/CreateTweet")) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-client-transaction-id")).toBe(CLIENT_TRANSACTION_ID);
        const payload = JSON.parse(request.body ?? "null") as Record<string, unknown>;
        expect(payload).toEqual({
          variables: {
            tweet_text: body,
            dark_request: false,
            media: { media_entities: [], possibly_sensitive: false },
            semantic_annotation_ids: [],
          },
          features: {},
          queryId: "hIL9XdleMYEtVXOZVbr8Bg",
        });
        return jsonResponse(createTweetResponse({ text: body }));
      }
      throw new Error(`unexpected test request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("posts.publish"),
      { body },
      xAuth,
      {
        dependencies: runtimeDependencies,
        beforeDispatch: (event) => {
          before.push(event);
          return Promise.resolve();
        },
        afterDispatchVerified: (event) => {
          after.push(event);
          return Promise.resolve();
        },
      },
    );

    expect(result).toEqual({
      status: "succeeded",
      output: { posts: [{ id: CREATED_POST_ID, url: `https://x.com/i/status/${CREATED_POST_ID}` }] },
      finalUrl: `https://x.com/i/status/${CREATED_POST_ID}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(before).toEqual([{
      id: "posts.publish",
      index: 1,
      progress: { planned: 1, started: 0, verified: 0 },
    }]);
    expect(after).toEqual([{
      id: "posts.publish",
      index: 1,
      progress: { planned: 1, started: 1, verified: 1 },
    }]);
  });

  test("returns failed with zero dispatches when the reviewed mutation descriptor cannot be resolved", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      throw new Error(`unexpected test request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("posts.publish"),
      { body: "must not dispatch" },
      xAuth,
      {
        dependencies: runtimeDependencies,
        beforeDispatch: (event) => {
          before.push(event);
          return Promise.resolve();
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
    });
    expect(before).toEqual([]);
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
  });

  test("does not dispatch or retry when the transaction bootstrap fails", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const lifecycle = { evaluations: 0, closed: 0, cleaned: 0 };
    const createBrowser: NonNullable<XWebRuntimeDependencies["createBrowserSession"]> = () => {
      const session: BrowserSession = {
        runBatch: (batch) => {
          const command = batch[0];
          if (batch.length !== 1 || command === undefined) throw new Error("unexpected transaction browser batch");
          if (command[0] === "get" && command[1] === "url") {
            return Promise.resolve([{ success: true, data: { url: "https://x.com/home" } }]);
          }
          if (command[0] === "eval") {
            lifecycle.evaluations += 1;
            throw new Error("synthetic current-runtime drift");
          }
          return Promise.resolve([{ success: true, data: null }]);
        },
        close: () => {
          lifecycle.closed += 1;
          return Promise.resolve();
        },
        cleanup: () => {
          lifecycle.cleaned += 1;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    };
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("CreateTweet", "hIL9XdleMYEtVXOZVbr8Bg", "mutation"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      throw new Error(`unexpected request after transaction failure ${request.url.href}`);
    }, { createBrowserSession: createBrowser });

    const result = await executeXWebOperation(
      xRecipe("posts.publish"),
      { body: "must remain local" },
      xAuth,
      {
        dependencies: runtimeDependencies,
        beforeDispatch: (event) => {
          before.push(event);
          return Promise.resolve();
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
    });
    expect(before).toEqual([]);
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
    expect(lifecycle).toEqual({ evaluations: 1, closed: 1, cleaned: 1 });
  });

  test("binds both confirmed quote target and authenticated author after dispatch", async () => {
    const mismatchCases = [
      { label: "author", authorId: "999", quote: QUOTED_POST_ID },
      { label: "quote", authorId: VIEWER_ID, quote: FOCAL_POST_ID },
    ] as const;
    for (const mismatch of mismatchCases) {
      const calls: CapturedRequest[] = [];
      const after: WebSessionDispatchEvent[] = [];
      const body = `mismatched ${mismatch.label}`;
      const runtimeDependencies = dependencies(calls, (request) => {
        if (request.url.href === "https://x.com/home") {
          return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
        }
        if (request.url.href === MAIN_URL) {
          return new Response(mainBundle(
            descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
            descriptor("CreateTweet", "hIL9XdleMYEtVXOZVbr8Bg", "mutation"),
          ), { headers: { "content-type": "application/javascript" } });
        }
        if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
        if (request.url.pathname.endsWith("/CreateTweet")) {
          const payload = JSON.parse(request.body ?? "null") as {
            readonly variables: { readonly attachment_url?: string };
          };
          expect(payload.variables.attachment_url).toBe(`https://x.com/i/status/${QUOTED_POST_ID}`);
          return jsonResponse(createTweetResponse({
            text: body,
            authorId: mismatch.authorId,
            quote: mismatch.quote,
          }));
        }
        throw new Error(`unexpected test request ${request.url.href}`);
      });

      const result = await executeXWebOperation(
        xRecipe("posts.quote"),
        { body, post_id: QUOTED_POST_ID },
        xAuth,
        {
          dependencies: runtimeDependencies,
          afterDispatchVerified: (event) => {
            after.push(event);
            return Promise.resolve();
          },
        },
      );

      expect(result).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
      });
      expect(after).toEqual([]);
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    }
  });

  test("executes exact observed-v2 like and unlike mutations only after transaction bootstrap and verifies independent readback", async () => {
    const cases = [
      {
        liked: true,
        operationName: "FavoriteTweet",
        queryId: "lI07N6Otwv1PhnEgXILM7A",
        response: { data: { favorite_tweet: "Done" } },
      },
      {
        liked: false,
        operationName: "UnfavoriteTweet",
        queryId: "ZYKSe-w7KEslx3JhSIk5LA",
        response: { data: { unfavorite_tweet: "Done" } },
      },
    ] as const;

    for (const fixture of cases) {
      const calls: CapturedRequest[] = [];
      const before: WebSessionDispatchEvent[] = [];
      const after: WebSessionDispatchEvent[] = [];
      const order: string[] = [];
      const cleanupBarriers: Promise<void>[] = [];
      const cleanupResourcePublisher = () => undefined;
      let readbacks = 0;
      const mutationPath = `/i/api/graphql/${fixture.queryId}/${fixture.operationName}`;
      const createBrowser: NonNullable<XWebRuntimeDependencies["createBrowserSession"]> =
        (_manifest, transactionAuth, browserOptions) => {
          expect(transactionAuth).toEqual(xAuth);
          expect(browserOptions.allowCodeOwnedEvaluation).toBeTrue();
          expect(browserOptions.publishCleanupResource).toBe(
            cleanupResourcePublisher,
          );
          const session: BrowserSession = {
            runBatch: (batch) => {
              const command = batch[0];
              if (batch.length !== 1 || command === undefined) {
                throw new Error("unexpected transaction browser batch");
              }
              if (command[0] === "open") {
                expect(command[1]).toBe("https://x.com/home");
                order.push("transaction:open");
                return Promise.resolve([{ success: true, data: null }]);
              }
              if (command[0] === "get" && command[1] === "url") {
                order.push("transaction:get-url");
                return Promise.resolve([{ success: true, data: { url: "https://x.com/home" } }]);
              }
              if (command[0] === "eval") {
                expect(command[1]).toContain(`"method":"POST","path":"${mutationPath}"`);
                expect(command[1]).toContain("\"mainBundlePath\":\"/responsive-web/client-web/main.abcdef12.js\"");
                order.push("transaction:eval");
                return Promise.resolve([{
                  success: true,
                  data: { origin: "https://x.com/", result: CLIENT_TRANSACTION_ID },
                }]);
              }
              throw new Error(`unexpected transaction browser command ${command[0]}`);
            },
            close: () => {
              order.push("transaction:close");
              return Promise.resolve();
            },
            cleanup: () => {
              order.push("transaction:cleanup");
              return Promise.resolve();
            },
          };
          return Promise.resolve(session);
        };
      const runtimeDependencies = dependencies(calls, (request) => {
        if (request.url.href === "https://x.com/home") {
          return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
        }
        if (request.url.href === MAIN_URL) {
          return new Response(mainBundle(
            descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
            descriptor(fixture.operationName, fixture.queryId, "mutation"),
            descriptor("TweetResultByRestId", "4hhGRbehkcUVTKf8n0f0xw", "query"),
          ), { headers: { "content-type": "application/javascript" } });
        }
        if (request.url.pathname.endsWith("/Viewer")) {
          order.push("viewer");
          expect(request.method).toBe("GET");
          return jsonResponse(viewerResponse());
        }
        if (request.url.pathname === mutationPath) {
          expect(order.at(-1)).toBe("before-dispatch");
          order.push("mutation");
          expect(request.method).toBe("POST");
          expect(request.headers.get("x-client-transaction-id")).toBe(CLIENT_TRANSACTION_ID);
          expect(JSON.parse(request.body ?? "null")).toEqual({
            variables: { tweet_id: FOCAL_POST_ID },
            features: {},
            queryId: fixture.queryId,
          });
          return jsonResponse(fixture.response);
        }
        if (request.url.pathname === "/i/api/graphql/4hhGRbehkcUVTKf8n0f0xw/TweetResultByRestId") {
          readbacks += 1;
          order.push(readbacks === 1 ? "preflight-readback" : "final-readback");
          expect(request.method).toBe("GET");
          expect([...request.url.searchParams.keys()]).toEqual(["variables"]);
          expect(JSON.parse(request.url.searchParams.get("variables") ?? "null")).toEqual({
            tweetId: FOCAL_POST_ID,
            withCommunity: false,
            includePromotedContent: false,
            withVoice: false,
          });
          expect(request.headers.get("x-client-transaction-id")).toBeNull();
          return jsonResponse(tweetByIdResponse(
            FOCAL_POST_ID,
            readbacks === 1 ? !fixture.liked : fixture.liked,
          ));
        }
        throw new Error(`unexpected like fixture request ${request.url.href}`);
      }, { createBrowserSession: createBrowser });

      const result = await executeXWebOperation(
        xRecipe("likes.set", 2),
        { post_id: FOCAL_POST_ID, liked: fixture.liked },
        xAuth,
        {
          dependencies: runtimeDependencies,
          registerCleanupBarrier: (barrier) => {
            cleanupBarriers.push(barrier);
            return cleanupResourcePublisher;
          },
          beforeDispatch: (event) => {
            before.push(event);
            order.push("before-dispatch");
            return Promise.resolve();
          },
          afterDispatchVerified: (event) => {
            after.push(event);
            order.push("after-verified");
            return Promise.resolve();
          },
        },
      );

      expect(result).toEqual({
        status: "succeeded",
        output: { kind: "like", enabled: fixture.liked, postId: FOCAL_POST_ID },
        finalUrl: `https://x.com/i/status/${FOCAL_POST_ID}`,
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
      expect(cleanupBarriers).toHaveLength(1);
      await Promise.all(cleanupBarriers);
      expect(before).toEqual([{
        id: "likes.set",
        index: 1,
        progress: { planned: 1, started: 0, verified: 0 },
      }]);
      expect(after).toEqual([{
        id: "likes.set",
        index: 1,
        progress: { planned: 1, started: 1, verified: 1 },
      }]);
      expect(order).toEqual([
        "viewer",
        "preflight-readback",
        "transaction:open",
        "transaction:get-url",
        "transaction:eval",
        "transaction:close",
        "transaction:cleanup",
        "before-dispatch",
        "mutation",
        "final-readback",
        "after-verified",
      ]);
      expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
        "GET /home",
        "GET /responsive-web/client-web/main.abcdef12.js",
        `GET /i/api/graphql/${VIEWER_QUERY_ID}/Viewer`,
        "GET /i/api/graphql/4hhGRbehkcUVTKf8n0f0xw/TweetResultByRestId",
        `POST ${mutationPath}`,
        "GET /i/api/graphql/4hhGRbehkcUVTKf8n0f0xw/TweetResultByRestId",
      ]);
    }
  });

  test("leaves an observed-v2 like indeterminate when independent readback disagrees", async () => {
    const calls: CapturedRequest[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("FavoriteTweet", "lI07N6Otwv1PhnEgXILM7A", "mutation"),
          descriptor("TweetResultByRestId", "4hhGRbehkcUVTKf8n0f0xw", "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/FavoriteTweet")) {
        return jsonResponse({ data: { favorite_tweet: "Done" } });
      }
      if (request.url.pathname.endsWith("/TweetResultByRestId")) {
        return jsonResponse(tweetByIdResponse(FOCAL_POST_ID, false));
      }
      throw new Error(`unexpected mismatched readback request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("likes.set", 2),
      { post_id: FOCAL_POST_ID, liked: true },
      xAuth,
      {
        dependencies: runtimeDependencies,
        afterDispatchVerified: (event) => {
          after.push(event);
          return Promise.resolve();
        },
      },
    );

    expect(result).toMatchObject({
      status: "indeterminate",
      output: null,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
    });
    expect(after).toEqual([]);
    expect(calls.filter((call) => call.url.pathname.endsWith("/FavoriteTweet"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.pathname.endsWith("/TweetResultByRestId"))).toHaveLength(2);
  });

  test("returns a desired-state no-op before transaction bootstrap or mutation dispatch", async () => {
    const calls: CapturedRequest[] = [];
    let transactionSessions = 0;
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("TweetResultByRestId", "4hhGRbehkcUVTKf8n0f0xw", "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/TweetResultByRestId")) {
        return jsonResponse(tweetByIdResponse(FOCAL_POST_ID, true));
      }
      throw new Error(`unexpected desired-state no-op request ${request.url.href}`);
    }, {
      createBrowserSession: () => {
        transactionSessions += 1;
        throw new Error("desired-state no-op must not bootstrap a transaction browser");
      },
    });

    const result = await executeXWebOperation(
      xRecipe("likes.set", 2),
      { post_id: FOCAL_POST_ID, liked: true },
      xAuth,
      { dependencies: runtimeDependencies },
    );

    expect(result).toEqual({
      status: "succeeded",
      output: {
        effect: "already-satisfied",
        kind: "like",
        enabled: true,
        postId: FOCAL_POST_ID,
      },
      finalUrl: `https://x.com/i/status/${FOCAL_POST_ID}`,
      noOp: true,
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
    });
    expect(transactionSessions).toBe(0);
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
  });

  test("recovery desired-state readback performs only viewer and target-bound GET requests", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("TweetResultByRestId", "4hhGRbehkcUVTKf8n0f0xw", "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/TweetResultByRestId")) {
        return jsonResponse(tweetByIdResponse(FOCAL_POST_ID, false));
      }
      throw new Error(`unexpected recovery readback request ${request.url.href}`);
    }, {
      createBrowserSession: () => {
        throw new Error("R1 recovery readback must never create a transaction browser");
      },
    });

    expect(await readXWebDesiredState(
      xRecipe("likes.set", 2),
      { post_id: FOCAL_POST_ID, liked: true },
      xAuth,
      { dependencies: runtimeDependencies },
    )).toEqual({ kind: "like", enabled: false, postId: FOCAL_POST_ID });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
  });

  test("binds the viewer before an observed-v2 like and never bootstraps or dispatches after an account switch", async () => {
    const calls: CapturedRequest[] = [];
    let transactionSessions = 0;
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("FavoriteTweet", "lI07N6Otwv1PhnEgXILM7A", "mutation"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse("999"));
      throw new Error(`unexpected request after viewer mismatch ${request.url.href}`);
    }, {
      createBrowserSession: () => {
        transactionSessions += 1;
        throw new Error("transaction bootstrap must not start after an account switch");
      },
    });

    expect(await rejectionMessage(executeXWebOperation(
      xRecipe("likes.set", 2),
      { post_id: FOCAL_POST_ID, liked: true },
      xAuth,
      { dependencies: runtimeDependencies },
    ))).toContain("viewer no longer matches");
    expect(transactionSessions).toBe(0);
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
  });
});
