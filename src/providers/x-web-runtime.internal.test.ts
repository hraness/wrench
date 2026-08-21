import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import {
  parseArticleDraftDocument,
  parseArticleDraftDocumentV2,
} from "../article-draft-document";
import type { WrenchAuth } from "../auth";
import type { BrowserSession } from "../browser";
import { canonicalJson } from "../canonical-json";
import type { WebSessionRecipe } from "../model";
import type { WebSessionDispatchEvent } from "../web-session";
import {
  buildXWebRichArticleContentState,
  executeXWebOperation,
  readXWebArticleDraftDesiredState,
  readXWebDesiredState,
  readXWebPublishedMutationTarget,
  resolveCurrentXWebChunkUrl,
  xWebArticleImageFailureCategory,
  type XWebRuntimeDependencies,
} from "./x-web-runtime";

const MAIN_URL = "https://abs.twimg.com/responsive-web/client-web/main.abcdef12.js";
const CREATE_TWEET_QUERY_ID = "WXTdKnLddrQOunD6MhWi3g";
const STALE_CREATE_TWEET_QUERY_ID = "hIL9XdleMYEtVXOZVbr8Bg";
const VIEWER_QUERY_ID = "5XShkXk2oO2J7SYmTu6pvw";
const ARTICLE_QUERY_ID = "btD9FyMDa3_vydVp7fr87Q";
const STALE_ARTICLE_QUERY_ID = "StaleArticleDraftCreateId";
const ARTICLE_BUNDLE_URL = "https://abs.twimg.com/responsive-web/client-web/bundle.TwitterArticles.305538ca.js";
const ARTICLE_RESULT_QUERY_ID = "rPdndX2XxQoXIMUafLSSJQ";
const ARTICLE_CREATE_FEATURE_SWITCHES = Object.freeze([
  "profile_label_improvements_pcf_label_in_post_enabled",
  "responsive_web_profile_redirect_enabled",
  "rweb_tipjar_consumption_enabled",
  "verified_phone_label_enabled",
  "responsive_web_graphql_timeline_navigation_enabled",
]);
const ARTICLE_CREATE_FIELD_TOGGLES = Object.freeze([
  "withPayments",
  "withAuxiliaryUserLabels",
]);
const ARTICLE_TITLE_QUERY_ID = "z_xdvTUbZjSVjt232b4D4A";
const ARTICLE_CONTENT_QUERY_ID = "P5Nc3DYs9D4XqVthNrig8w";
const ARTICLE_ENTITIES_BUNDLE_URL = "https://abs.twimg.com/responsive-web/client-web/shared~bundle.TwitterArticles~ondemand.Verified~bundle.SettingsExtendedProfile~bundle.WorkHistory.d1314bba.js";
const ARTICLE_CONVERTER_BUNDLE_URL = "https://abs.twimg.com/responsive-web/client-web/shared~bundle.Grok~bundle.GrokDrawer~bundle.ReaderMode~bundle.Birdwatch~bundle.TwitterArticles~bundle.Compose.02f6dc7a.js";
const ARTICLE_UPLOADER_BUNDLE_URL = "https://abs.twimg.com/responsive-web/client-web/shared~bundle.LoggedInMain~ondemand.HoverCard~loader.AudioDock~loader.Dock~bundle.BookmarkFolders~bundle.Book.a9bac6ba.js";
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
    domain: ".x.com",
    hostOnly: false,
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

function articleImageSupportTokens(): {
  readonly uploader: string;
  readonly entities: string;
  readonly converter: string;
} {
  return {
    uploader: [
      '"upload.x.com"',
      '"upload-a.x.com"',
      '"upload-b.x.com"',
      "/i/media/${l}",
      '"INIT"',
      '"APPEND"',
      '"FINALIZE"',
      "media_category=${p}",
      'TweetImage:"tweet_image"',
      'TwitterArticle:"twitter_article"',
    ].join(";"),
    entities: [
      "createEntity(p.LA.MEDIA,p.Ei.IMMUTABLE",
      "mediaCategory:E(e)",
      "mediaId:e.uploadId",
      'createEntity(w.Sg,"MUTABLE",{url:',
    ].join(";"),
    converter: [
      "media_items:r.data?.mediaItems?.map",
      "media_category:e.mediaCategory",
      "mutability:s[r.mutability]",
      "inline_style_ranges:",
    ].join(";"),
  };
}

function observedArticleDescriptor(
  operationName: string,
  queryId: string,
  operationType: "query" | "mutation",
): string {
  const featureSwitches = ARTICLE_CREATE_FEATURE_SWITCHES.map((name) => `"${name}"`).join(",");
  const fieldToggles = ARTICLE_CREATE_FIELD_TOGGLES.map((name) => `"${name}"`).join(",");
  return `queryId:"${queryId}",operationName:"${operationName}",operationType:"${operationType}",metadata:{featureSwitches:[${featureSwitches}],fieldToggles:[${fieldToggles}]}`;
}

function fixtureArticleImagePath(): string {
  return join(import.meta.dir, "..", "..", "website", "public", "og.png");
}

function twoImageArticleDocument(): string {
  return canonicalJson({
    schemaVersion: 2,
    blocks: [
      { type: "paragraph", text: "Before the images" },
      { type: "image", imageIndex: 0, caption: "First inline" },
      { type: "image", imageIndex: 1, caption: "Second inline" },
      { type: "paragraph", text: "After the images" },
    ],
  });
}

function richArticleHtml(): string {
  return `${homeHtml()}<script>p.u=e=>({31770:"bundle.TwitterArticles",31771:"shared~bundle.LoggedInMain~ondemand.HoverCard~loader.AudioDock~loader.Dock~bundle.BookmarkFolders~bundle.Book",31772:"shared~bundle.TwitterArticles~ondemand.Verified~bundle.SettingsExtendedProfile~bundle.WorkHistory",31773:"shared~bundle.Grok~bundle.GrokDrawer~bundle.ReaderMode~bundle.Birdwatch~bundle.TwitterArticles~bundle.Compose"})[e]||e)+"."+({31770:"305538c",31771:"a9bac6b",31772:"d1314bb",31773:"02f6dc7"})[e]+"a.js"</script>`;
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
  readonly mediaId?: string | null;
}): unknown {
  const result = publishedTweetResult(options);
  return {
    data: {
      create_tweet: {
        tweet_results: {
          result,
        },
      },
    },
  };
}

function publishedTweetResult(options: {
  readonly text: string;
  readonly authorId?: string;
  readonly replyTo?: string | null;
  readonly quote?: string | null;
  readonly mediaId?: string | null;
}): unknown {
  const media = options.mediaId === undefined || options.mediaId === null
    ? {}
    : {
        entities: { media: [{ id_str: options.mediaId, type: "photo" }] },
        extended_entities: { media: [{ id_str: options.mediaId, type: "photo" }] },
      };
  return {
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
      ...media,
    },
  };
}

function publishedTweetReadback(options: Parameters<typeof createTweetResponse>[0]): unknown {
  return {
    data: {
      tweetResult: { result: publishedTweetResult(options) },
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
    readonly sleep?: NonNullable<XWebRuntimeDependencies["sleep"]>;
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
  return {
    acquireCookies,
    fetch,
    createBrowserSession: createTransactionBrowser,
    sleep: options.sleep ?? (() => Promise.resolve()),
  };
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

  test("projects one provider-neutral ArticleDraftDocument to native links and styles with stable DraftJS keys", () => {
    const document = parseArticleDraftDocument(canonicalJson({
      schemaVersion: 1,
      blocks: [
        {
          type: "heading1",
          text: "Visit Hraness",
          links: [{ offset: 6, length: 7, url: "https://hraness.com/writing" }],
          styles: [{ offset: 6, length: 7, style: "bold" }],
        },
        { type: "blockquote", text: "Welcome to my brain" },
      ],
    }), { maximumBlocks: 2_000, maximumCharacters: 20_000 });
    expect(buildXWebRichArticleContentState(document)).toEqual({
      blocks: [
        {
          data: {},
          key: "00000",
          text: "Visit Hraness",
          type: "header-one",
          entity_ranges: [{ key: 0, offset: 6, length: 7 }],
          inline_style_ranges: [{ length: 7, offset: 6, style: "Bold" }],
        },
        {
          data: {},
          key: "00001",
          text: "Welcome to my brain",
          type: "blockquote",
          entity_ranges: [],
          inline_style_ranges: [],
        },
      ],
      entity_map: [
        {
          key: "0",
          value: {
            data: { url: "https://hraness.com/writing" },
            type: "LINK",
            mutability: "Mutable",
          },
        },
      ],
    });
  });

  test("projects ArticleDraftDocument v2 images to exact atomic MEDIA entities", () => {
    const document = parseArticleDraftDocumentV2(canonicalJson({
      schemaVersion: 2,
      blocks: [
        {
          type: "paragraph",
          text: "Visit Hraness",
          links: [{ offset: 6, length: 7, url: "https://hraness.com/writing" }],
        },
        { type: "image", imageIndex: 0, caption: "Puerto Rico" },
      ],
    }), { maximumBlocks: 2_000, maximumCharacters: 20_000, maximumImages: 20 });
    expect(buildXWebRichArticleContentState(document, ["700000000000000002"])).toEqual({
      blocks: [
        {
          data: {},
          key: "00000",
          text: "Visit Hraness",
          type: "unstyled",
          entity_ranges: [{ key: 0, offset: 6, length: 7 }],
          inline_style_ranges: [],
        },
        {
          data: {},
          key: "00001",
          text: " ",
          type: "atomic",
          entity_ranges: [{ key: 1, offset: 0, length: 1 }],
          inline_style_ranges: [],
        },
      ],
      entity_map: [
        {
          key: "0",
          value: {
            data: { url: "https://hraness.com/writing" },
            type: "LINK",
            mutability: "Mutable",
          },
        },
        {
          key: "1",
          value: {
            data: {
              caption: "Puerto Rico",
              entity_key: "1",
              media_items: [{
                local_media_id: 1,
                media_category: "DraftTweetImage",
                media_id: "700000000000000002",
              }],
            },
            type: "MEDIA",
            mutability: "Immutable",
          },
        },
      ],
    });
    expect(() => buildXWebRichArticleContentState(document, [])).toThrow(
      "did not bind one uploaded inline image",
    );
    expect(() => buildXWebRichArticleContentState(document, ["1", "2"])).toThrow(
      "referenced exactly once",
    );
  });

  test("classifies Article image upload failures without exposing provider bodies", () => {
    expect(xWebArticleImageFailureCategory(
      new Error("authenticated web API returned unreviewed status/content type 415/application/json"),
    )).toBe("request-rejected-415");
    expect(xWebArticleImageFailureCategory(
      new Error("authenticated web API returned unreviewed status/content type 200/text/plain"),
    )).toBe("text-plain-response");
    expect(xWebArticleImageFailureCategory(
      new Error("authenticated web API returned unreviewed status/content type 202/application/json"),
    )).toBe("media-status-drift");
    expect(xWebArticleImageFailureCategory(
      new Error("X media FINALIZE response omitted its media identifier"),
    )).toBe("media-finalize-response-drift");
    expect(xWebArticleImageFailureCategory(
      new Error("X articleentity_create_draft response Article identifier must be a bounded string"),
    )).toBe("article-create-id-shape-drift");
    expect(xWebArticleImageFailureCategory(new Error("private response body")))
      .toBe("media-contract-step-failed");
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
    const document = canonicalJson({
      schemaVersion: 1,
      blocks: [
        {
          type: "heading1",
          text: "Welcome to my brain",
          styles: [{ offset: 0, length: 7, style: "bold" }],
        },
        {
          type: "paragraph",
          text: "Listen to Jungle",
          links: [{
            offset: 10,
            length: 6,
            url: "https://hraness.com/writing/example/audio/jungle",
          }],
        },
      ],
    });
    const contentState = buildXWebRichArticleContentState(
      parseArticleDraftDocument(document, {
        maximumBlocks: 2_000,
        maximumCharacters: 20_000,
      }),
    );
    const articleId = "700000000000000001";
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(richArticleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", VIEWER_QUERY_ID, "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response([
          descriptor("ArticleEntityDraftCreate", ARTICLE_QUERY_ID, "mutation"),
          descriptor("ArticleEntityResultByRestId", ARTICLE_RESULT_QUERY_ID, "query"),
        ].join(";"), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_ENTITIES_BUNDLE_URL) {
        return new Response('createEntity(w.Sg,"MUTABLE",{url:', {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_CONVERTER_BUNDLE_URL) {
        return new Response("mutability:s[r.mutability];inline_style_ranges:", {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/ArticleEntityDraftCreate")) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-client-transaction-id")).toBe(CLIENT_TRANSACTION_ID);
        expect(JSON.parse(request.body ?? "null")).toEqual({
          variables: { content_state: contentState, title },
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
      if (request.url.pathname.endsWith("/ArticleEntityResultByRestId")) {
        expect(request.method).toBe("GET");
        return jsonResponse({
          data: {
            article_result_by_rest_id: {
              rest_id: articleId,
              title,
              metadata: { author_results: { result: { rest_id: VIEWER_ID } } },
              lifecycle_state: { lifecycle: "Draft" },
              content_state: contentState,
            },
          },
        });
      }
      throw new Error(`unexpected Article draft request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.draft.save"),
      { title, document },
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
        operation: "articles.draft.save",
        published: false,
        mode: "draft",
        draftId: articleId,
        title,
        documentSchemaVersion: 1,
        url: `https://x.com/compose/articles/edit/${articleId}`,
      },
      finalUrl: `https://x.com/compose/articles/edit/${articleId}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(before).toEqual([{
      id: "articles.create",
      index: 1,
      progress: { planned: 1, started: 0, verified: 0 },
    }]);
    expect(after).toEqual([{
      id: "articles.create",
      index: 1,
      progress: { planned: 1, started: 1, verified: 1 },
    }]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.url.pathname.endsWith("/ArticleEntityResultByRestId"))).toHaveLength(1);
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityPublish"))).toBeFalse();
  });

  test("replaces one bound private text-rich Article draft and verifies exact readback", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const title = "Harnessing Puerto Rico";
    const articleId = "700000000000000001";
    const document = canonicalJson({
      schemaVersion: 1,
      blocks: [
        { type: "heading2", text: "Welcome to my brain" },
        {
          type: "paragraph",
          text: "Listen to Jungle and Beach",
          links: [
            {
              offset: 10,
              length: 6,
              url: "https://hraness.com/writing/example/audio/jungle",
            },
            {
              offset: 21,
              length: 5,
              url: "https://hraness.com/writing/example/audio/beach",
            },
          ],
        },
      ],
    });
    const expectedContentState = buildXWebRichArticleContentState(
      parseArticleDraftDocument(document, {
        maximumBlocks: 2_000,
        maximumCharacters: 20_000,
      }),
    );
    let readCount = 0;
    let savedContentState: unknown = null;
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(richArticleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", VIEWER_QUERY_ID, "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response([
          descriptor("ArticleEntityResultByRestId", ARTICLE_RESULT_QUERY_ID, "query"),
          descriptor("ArticleEntityUpdateTitle", ARTICLE_TITLE_QUERY_ID, "mutation"),
          descriptor("ArticleEntityUpdateContent", ARTICLE_CONTENT_QUERY_ID, "mutation"),
        ].join(";"), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_ENTITIES_BUNDLE_URL) {
        return new Response('createEntity(w.Sg,"MUTABLE",{url:', {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_CONVERTER_BUNDLE_URL) {
        return new Response("mutability:s[r.mutability];inline_style_ranges:", {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/ArticleEntityResultByRestId")) {
        readCount += 1;
        return jsonResponse({
          data: {
            article_result_by_rest_id: {
              rest_id: articleId,
              title: readCount === 1 ? "Old title" : title,
              metadata: { author_results: { result: { rest_id: VIEWER_ID } } },
              lifecycle_state: { lifecycle: "Draft" },
              ...(readCount === 1 ? {} : { content_state: savedContentState }),
            },
          },
        });
      }
      if (request.url.pathname.endsWith("/ArticleEntityUpdateTitle")) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-client-transaction-id")).toBe(CLIENT_TRANSACTION_ID);
        const payload = JSON.parse(request.body ?? "null") as { variables: unknown };
        expect(payload.variables).toEqual({ articleEntityId: articleId, title });
        return jsonResponse({
          data: { articleentity_update_title: { rest_id: articleId, title } },
        });
      }
      if (request.url.pathname.endsWith("/ArticleEntityUpdateContent")) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-client-transaction-id")).toBe(CLIENT_TRANSACTION_ID);
        const payload = JSON.parse(request.body ?? "null") as {
          variables: { content_state: unknown; article_entity: string };
        };
        expect(payload.variables).toEqual({
          content_state: expectedContentState,
          article_entity: articleId,
        });
        savedContentState = payload.variables.content_state;
        return jsonResponse({
          data: { articleentity_update_content_state: { rest_id: articleId } },
        });
      }
      throw new Error("unexpected text-rich Article request " + request.url.href);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.draft.save"),
      { title, document, draft_id: articleId },
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
        operation: "articles.draft.save",
        published: false,
        mode: "draft",
        draftId: articleId,
        title,
        documentSchemaVersion: 1,
        url: "https://x.com/compose/articles/edit/" + articleId,
      },
      finalUrl: "https://x.com/compose/articles/edit/" + articleId,
      dispatchStarted: true,
      dispatch: { planned: 2, started: 2, verified: 2 },
    });
    expect(before).toEqual([
      {
        id: "articles.title",
        index: 1,
        progress: { planned: 2, started: 0, verified: 0 },
      },
      {
        id: "articles.content",
        index: 2,
        progress: { planned: 2, started: 1, verified: 1 },
      },
    ]);
    expect(after).toEqual([
      {
        id: "articles.title",
        index: 1,
        progress: { planned: 2, started: 1, verified: 1 },
      },
      {
        id: "articles.content",
        index: 2,
        progress: { planned: 2, started: 2, verified: 2 },
      },
    ]);
    expect(readCount).toBe(2);
    expect(savedContentState).toEqual(expectedContentState);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityPublish"))).toBeFalse();
  });

  test("uploads one plan-bound image, writes native MEDIA, and verifies exact private readback", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const title = "Harnessing Puerto Rico";
    const articleId = "700000000000000001";
    const mediaId = "700000000000000002";
    const documentValue = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Before the image" },
        { type: "image", imageIndex: 0, caption: "Puerto Rico" },
        { type: "paragraph", text: "After the image" },
      ],
    });
    const document = parseArticleDraftDocumentV2(documentValue, {
      maximumBlocks: 2_000,
      maximumCharacters: 20_000,
      maximumImages: 20,
    });
    const expectedContentState = buildXWebRichArticleContentState(document, [mediaId]);
    let readCount = 0;
    let savedContentState: unknown = null;
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(richArticleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", VIEWER_QUERY_ID, "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response([
          descriptor("ArticleEntityResultByRestId", ARTICLE_RESULT_QUERY_ID, "query"),
          descriptor("ArticleEntityUpdateTitle", ARTICLE_TITLE_QUERY_ID, "mutation"),
          descriptor("ArticleEntityUpdateContent", ARTICLE_CONTENT_QUERY_ID, "mutation"),
        ].join(";"), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_UPLOADER_BUNDLE_URL) {
        return new Response(articleImageSupportTokens().uploader, {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_ENTITIES_BUNDLE_URL) {
        return new Response(articleImageSupportTokens().entities, {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_CONVERTER_BUNDLE_URL) {
        return new Response(articleImageSupportTokens().converter, {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.hostname === "upload.x.com") {
        const command = request.url.searchParams.get("command");
        if (command === "INIT") {
          expect(request.url.searchParams.get("media_category")).toBe("tweet_image");
          expect(request.url.searchParams.get("media_type")).toBe("image/png");
          expect(request.url.searchParams.get("total_bytes")).toBe("869311");
          return jsonResponse({ media_id_string: mediaId, expires_after_secs: 86_400 }, 202);
        }
        if (command === "APPEND") {
          expect(request.url.searchParams.get("media_id")).toBe(mediaId);
          expect(request.url.searchParams.get("segment_index")).toBe("0");
          expect(request.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
          return new Response(null, { status: 204 });
        }
        if (command === "FINALIZE") {
          expect(request.url.searchParams.get("media_id")).toBe(mediaId);
          return jsonResponse({ media_id_string: mediaId, expires_after_secs: 86_400 }, 201);
        }
      }
      if (request.url.pathname.endsWith("/ArticleEntityResultByRestId")) {
        readCount += 1;
        return jsonResponse({
          data: {
            article_result_by_rest_id: {
              rest_id: articleId,
              title: readCount === 1 ? "Old title" : title,
              metadata: { author_results: { result: { rest_id: VIEWER_ID } } },
              lifecycle_state: { lifecycle: "Draft" },
              ...(readCount === 1 ? {} : { content_state: savedContentState }),
            },
          },
        });
      }
      if (request.url.pathname.endsWith("/ArticleEntityUpdateTitle")) {
        return jsonResponse({
          data: { articleentity_update_title: { rest_id: articleId, title } },
        });
      }
      if (request.url.pathname.endsWith("/ArticleEntityUpdateContent")) {
        const payload = JSON.parse(request.body ?? "null") as {
          variables: { article_entity: string; content_state: unknown };
        };
        expect(payload.variables).toEqual({
          article_entity: articleId,
          content_state: expectedContentState,
        });
        savedContentState = payload.variables.content_state;
        return jsonResponse({
          data: { articleentity_update_content_state: { rest_id: articleId } },
        });
      }
      throw new Error(`unexpected image Article request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.draft.save", 2),
      {
        title,
        document: documentValue,
        draft_id: articleId,
        inline_images: [{ kind: "file", reference: "fixture-image" }],
      },
      xAuth,
      {
        dependencies: runtimeDependencies,
        fileResolver: (files) => {
          expect(files).toEqual([{ kind: "file", reference: "fixture-image" }]);
          return Promise.resolve([fixtureArticleImagePath()]);
        },
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
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        documentSchemaVersion: 2,
        draftId: articleId,
        inlineImageCount: 1,
        published: false,
        title,
      },
      dispatch: { planned: 3, started: 3, verified: 3 },
    });
    expect(before.map(({ id }) => id)).toEqual([
      "articles.media.inline[1]",
      "articles.title",
      "articles.content",
    ]);
    expect(after.map(({ id }) => id)).toEqual([
      "articles.media.inline[1]",
      "articles.title",
      "articles.content",
    ]);
    await expect(readXWebArticleDraftDesiredState(
      xRecipe("articles.draft.save", 2),
      {
        title,
        document: documentValue,
        draft_id: articleId,
        inline_images: [{ kind: "file", reference: "fixture-image" }],
      },
      xAuth,
    )).rejects.toThrow("supports only articles.draft.save@1");
  });

  test("creates one private Article after two verified inline-image uploads and never publishes", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const title = "Private native Article with images";
    const articleId = "700000000000000013";
    const mediaIds = ["700000000000000011", "700000000000000012"] as const;
    const documentValue = twoImageArticleDocument();
    const document = parseArticleDraftDocumentV2(documentValue, {
      maximumBlocks: 2_000,
      maximumCharacters: 20_000,
      maximumImages: 20,
    });
    const expectedContentState = buildXWebRichArticleContentState(document, mediaIds);
    let initCount = 0;
    const tokens = articleImageSupportTokens();
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(richArticleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", VIEWER_QUERY_ID, "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response([
          observedArticleDescriptor("ArticleEntityDraftCreate", ARTICLE_QUERY_ID, "mutation"),
          observedArticleDescriptor("ArticleEntityResultByRestId", ARTICLE_RESULT_QUERY_ID, "query"),
        ].join(";"), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_UPLOADER_BUNDLE_URL) {
        return new Response(tokens.uploader, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_ENTITIES_BUNDLE_URL) {
        return new Response(tokens.entities, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_CONVERTER_BUNDLE_URL) {
        return new Response(tokens.converter, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.hostname === "upload.x.com") {
        const command = request.url.searchParams.get("command");
        if (command === "INIT") {
          const mediaId = mediaIds[initCount];
          initCount += 1;
          expect(mediaId).toBeDefined();
          expect(request.url.searchParams.get("media_category")).toBe("tweet_image");
          expect(request.url.searchParams.get("media_type")).toBe("image/png");
          expect(request.url.searchParams.get("total_bytes")).toBe("869311");
          return jsonResponse({ media_id_string: mediaId, expires_after_secs: 86_400 }, 202);
        }
        if (command === "APPEND") {
          const mediaId = request.url.searchParams.get("media_id");
          expect(mediaId === mediaIds[0] || mediaId === mediaIds[1]).toBeTrue();
          expect(request.url.searchParams.get("segment_index")).toBe("0");
          return new Response(null, { status: 204 });
        }
        if (command === "FINALIZE") {
          const mediaId = request.url.searchParams.get("media_id");
          expect(mediaId === mediaIds[0] || mediaId === mediaIds[1]).toBeTrue();
          return jsonResponse({ media_id_string: mediaId, expires_after_secs: 86_400 }, 201);
        }
      }
      if (request.url.pathname.endsWith("/ArticleEntityDraftCreate")) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-client-transaction-id")).toBe(CLIENT_TRANSACTION_ID);
        expect(JSON.parse(request.body ?? "null")).toEqual({
          variables: { content_state: expectedContentState, title },
          features: Object.fromEntries(ARTICLE_CREATE_FEATURE_SWITCHES.map((name) => [name, false])),
          fieldToggles: Object.fromEntries(ARTICLE_CREATE_FIELD_TOGGLES.map((name) => [name, false])),
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
      if (request.url.pathname.endsWith("/ArticleEntityResultByRestId")) {
        expect(request.method).toBe("GET");
        return jsonResponse({
          data: {
            article_result_by_rest_id: {
              rest_id: articleId,
              title,
              metadata: { author_results: { result: { rest_id: VIEWER_ID } } },
              lifecycle_state: { lifecycle: "Draft" },
              content_state: expectedContentState,
            },
          },
        });
      }
      throw new Error(`unexpected create-after-images request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.draft.save", 2),
      {
        title,
        document: documentValue,
        inline_images: [
          { kind: "file", reference: "fixture-image-1" },
          { kind: "file", reference: "fixture-image-2" },
        ],
      },
      xAuth,
      {
        dependencies: runtimeDependencies,
        fileResolver: (files) => {
          expect(files).toEqual([
            { kind: "file", reference: "fixture-image-1" },
            { kind: "file", reference: "fixture-image-2" },
          ]);
          return Promise.resolve([fixtureArticleImagePath(), fixtureArticleImagePath()]);
        },
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
        operation: "articles.draft.save",
        published: false,
        mode: "draft",
        draftId: articleId,
        title,
        documentSchemaVersion: 2,
        inlineImageCount: 2,
        url: `https://x.com/compose/articles/edit/${articleId}`,
      },
      finalUrl: `https://x.com/compose/articles/edit/${articleId}`,
      dispatchStarted: true,
      dispatch: { planned: 3, started: 3, verified: 3 },
    });
    expect(before.map(({ id }) => id)).toEqual([
      "articles.media.inline[1]",
      "articles.media.inline[2]",
      "articles.create",
    ]);
    expect(after.map(({ id }) => id)).toEqual([
      "articles.media.inline[1]",
      "articles.media.inline[2]",
      "articles.create",
    ]);
    expect(initCount).toBe(2);
    expect(calls.filter((call) => call.url.pathname.endsWith("/ArticleEntityDraftCreate"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.pathname.endsWith("/ArticleEntityResultByRestId"))).toHaveLength(1);
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityPublish"))).toBeFalse();
  });

  test("keeps create undispatched after two verified images when ArticleEntityDraftCreate evidence drifted", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const title = "Private native Article with images";
    const mediaIds = ["700000000000000011", "700000000000000012"] as const;
    const documentValue = twoImageArticleDocument();
    let initCount = 0;
    const tokens = articleImageSupportTokens();
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(richArticleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", VIEWER_QUERY_ID, "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response([
          observedArticleDescriptor("ArticleEntityDraftCreate", STALE_ARTICLE_QUERY_ID, "mutation"),
          observedArticleDescriptor("ArticleEntityResultByRestId", ARTICLE_RESULT_QUERY_ID, "query"),
        ].join(";"), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_UPLOADER_BUNDLE_URL) {
        return new Response(tokens.uploader, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_ENTITIES_BUNDLE_URL) {
        return new Response(tokens.entities, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_CONVERTER_BUNDLE_URL) {
        return new Response(tokens.converter, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.hostname === "upload.x.com") {
        const command = request.url.searchParams.get("command");
        if (command === "INIT") {
          const mediaId = mediaIds[initCount];
          initCount += 1;
          expect(mediaId).toBeDefined();
          return jsonResponse({ media_id_string: mediaId, expires_after_secs: 86_400 }, 202);
        }
        if (command === "APPEND") {
          return new Response(null, { status: 204 });
        }
        if (command === "FINALIZE") {
          return jsonResponse({
            media_id_string: request.url.searchParams.get("media_id"),
            expires_after_secs: 86_400,
          }, 201);
        }
      }
      throw new Error(`unexpected drifted create-after-images request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.draft.save", 2),
      {
        title,
        document: documentValue,
        inline_images: [
          { kind: "file", reference: "fixture-image-1" },
          { kind: "file", reference: "fixture-image-2" },
        ],
      },
      xAuth,
      {
        dependencies: runtimeDependencies,
        fileResolver: (files) => {
          expect(files).toHaveLength(2);
          return Promise.resolve([fixtureArticleImagePath(), fixtureArticleImagePath()]);
        },
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

    expect(result).toMatchObject({
      status: "partial",
      output: null,
      finalUrl: null,
      dispatchStarted: true,
      dispatch: { planned: 3, started: 2, verified: 2 },
    });
    expect(result.error).toBe(
      "X verified only part of the confirmed private Article workflow; failure stage: resolving the Article create mutation; X query-ID drift for ArticleEntityDraftCreate:mutation; reviewed evidence is stale; inspect the draft before retrying",
    );
    expect(result.error).not.toContain(STALE_ARTICLE_QUERY_ID);
    expect(result.error).not.toContain(ARTICLE_QUERY_ID);
    expect(before.map(({ id }) => id)).toEqual([
      "articles.media.inline[1]",
      "articles.media.inline[2]",
    ]);
    expect(after.map(({ id }) => id)).toEqual([
      "articles.media.inline[1]",
      "articles.media.inline[2]",
    ]);
    expect(initCount).toBe(2);
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityDraftCreate"))).toBeFalse();
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityPublish"))).toBeFalse();
    expect(calls.filter((call) => call.method === "POST" && call.url.hostname === "x.com")).toHaveLength(0);
  });

  test("keeps create undispatched after two verified images when transaction navigation is rejected", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const title = "Private native Article with images";
    const mediaIds = ["700000000000000011", "700000000000000012"] as const;
    const documentValue = twoImageArticleDocument();
    let initCount = 0;
    let opened = 0;
    const tokens = articleImageSupportTokens();
    const createBrowser: NonNullable<XWebRuntimeDependencies["createBrowserSession"]> = () => {
      const session: BrowserSession = {
        runBatch: (batch) => {
          const command = batch[0];
          if (batch.length !== 1 || command === undefined) throw new Error("unexpected transaction browser batch");
          if (command[0] === "open") {
            opened += 1;
            throw new Error(
              "agent-browser batch failed with exit code 1: Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE",
            );
          }
          throw new Error(`unexpected browser command after navigation failure ${command[0]}`);
        },
        close: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      };
      return Promise.resolve(session);
    };
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(richArticleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", VIEWER_QUERY_ID, "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response([
          observedArticleDescriptor("ArticleEntityDraftCreate", ARTICLE_QUERY_ID, "mutation"),
          observedArticleDescriptor("ArticleEntityResultByRestId", ARTICLE_RESULT_QUERY_ID, "query"),
        ].join(";"), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_UPLOADER_BUNDLE_URL) {
        return new Response(tokens.uploader, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_ENTITIES_BUNDLE_URL) {
        return new Response(tokens.entities, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_CONVERTER_BUNDLE_URL) {
        return new Response(tokens.converter, { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.hostname === "upload.x.com") {
        const command = request.url.searchParams.get("command");
        if (command === "INIT") {
          const mediaId = mediaIds[initCount];
          initCount += 1;
          expect(mediaId).toBeDefined();
          return jsonResponse({ media_id_string: mediaId, expires_after_secs: 86_400 }, 202);
        }
        if (command === "APPEND") {
          return new Response(null, { status: 204 });
        }
        if (command === "FINALIZE") {
          return jsonResponse({
            media_id_string: request.url.searchParams.get("media_id"),
            expires_after_secs: 86_400,
          }, 201);
        }
      }
      throw new Error(`unexpected navigation-failure Article request ${request.url.href}`);
    }, { createBrowserSession: createBrowser });

    const result = await executeXWebOperation(
      xRecipe("articles.draft.save", 2),
      {
        title,
        document: documentValue,
        inline_images: [
          { kind: "file", reference: "fixture-image-1" },
          { kind: "file", reference: "fixture-image-2" },
        ],
      },
      xAuth,
      {
        dependencies: runtimeDependencies,
        fileResolver: (files) => {
          expect(files).toHaveLength(2);
          return Promise.resolve([fixtureArticleImagePath(), fixtureArticleImagePath()]);
        },
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

    expect(result).toMatchObject({
      status: "partial",
      output: null,
      finalUrl: null,
      dispatchStarted: true,
      dispatch: { planned: 3, started: 2, verified: 2 },
    });
    expect(result.error).toBe(
      "X verified only part of the confirmed private Article workflow; failure stage: preparing the Article create mutation; agent-browser batch failed with exit code 1: Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE; inspect the draft before retrying",
    );
    expect(opened).toBe(1);
    expect(before.map(({ id }) => id)).toEqual([
      "articles.media.inline[1]",
      "articles.media.inline[2]",
    ]);
    expect(after.map(({ id }) => id)).toEqual([
      "articles.media.inline[1]",
      "articles.media.inline[2]",
    ]);
    expect(initCount).toBe(2);
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityDraftCreate"))).toBeFalse();
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityPublish"))).toBeFalse();
    expect(calls.filter((call) => call.method === "POST" && call.url.hostname === "x.com")).toHaveLength(0);
  });

  test("reconciles one exact existing text-and-links Article without a mutation path", async () => {
    const calls: CapturedRequest[] = [];
    const title = "Harnessing Puerto Rico";
    const articleId = "700000000000000001";
    const document = canonicalJson({
      schemaVersion: 1,
      blocks: [{
        type: "paragraph",
        text: "Listen to Jungle and Beach",
        links: [
          {
            offset: 10,
            length: 6,
            url: "https://hraness.com/writing/example/audio/jungle",
          },
          {
            offset: 21,
            length: 5,
            url: "https://hraness.com/writing/example/audio/beach",
          },
        ],
      }],
    });
    const providerContentState = {
      blocks: [{
        key: "abcde",
        text: "Listen to Jungle and Beach",
        type: "unstyled",
        data: {
          urls: [
            { fromIndex: 10, text: "Jungle", toIndex: 16 },
            { fromIndex: 21, text: "Beach", toIndex: 26 },
          ],
        },
        entity_ranges: [
          { key: 7, offset: 10, length: 6 },
          { key: 11, offset: 21, length: 5 },
        ],
        inline_style_ranges: [],
      }],
      entity_map: [
        {
          key: 11,
          value: {
            data: {
              url: "https://hraness.com/writing/example/audio/beach",
            },
            type: "LINK",
            mutability: "Mutable",
          },
        },
        {
          key: 7,
          value: {
            data: {
              url: "https://hraness.com/writing/example/audio/jungle",
            },
            type: "LINK",
            mutability: "Mutable",
          },
        },
      ],
    };
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(articleHtml(), {
          headers: { "content-type": "text/html" },
        });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", VIEWER_QUERY_ID, "query"),
        ), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response(
          descriptor(
            "ArticleEntityResultByRestId",
            ARTICLE_RESULT_QUERY_ID,
            "query",
          ),
          { headers: { "content-type": "application/javascript" } },
        );
      }
      if (request.url.pathname.endsWith("/Viewer")) {
        return jsonResponse(viewerResponse());
      }
      if (request.url.pathname.endsWith("/ArticleEntityResultByRestId")) {
        return jsonResponse({
          data: {
            article_result_by_rest_id: {
              rest_id: articleId,
              title,
              metadata: {
                author_results: { result: { rest_id: VIEWER_ID } },
              },
              lifecycle_state: { lifecycle: "Draft" },
              content_state: providerContentState,
            },
          },
        });
      }
      throw new Error(`unexpected Article recovery request ${request.url.href}`);
    });

    expect(await readXWebArticleDraftDesiredState(
      xRecipe("articles.draft.save"),
      { title, document, draft_id: articleId },
      xAuth,
      { dependencies: runtimeDependencies },
    )).toEqual({ matches: true, draftId: articleId });
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
  });

  test("returns partial after verifying the title when the content mutation contract drifts before dispatch", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const title = "Confirmed title";
    const articleId = "700000000000000001";
    const document = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Confirmed body" }],
    });
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(richArticleHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(descriptor("Viewer", VIEWER_QUERY_ID, "query")), {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_BUNDLE_URL) {
        return new Response([
          descriptor("ArticleEntityResultByRestId", ARTICLE_RESULT_QUERY_ID, "query"),
          descriptor("ArticleEntityUpdateTitle", ARTICLE_TITLE_QUERY_ID, "mutation"),
        ].join(";"), { headers: { "content-type": "application/javascript" } });
      }
      if (request.url.href === ARTICLE_ENTITIES_BUNDLE_URL) {
        return new Response('createEntity(w.Sg,"MUTABLE",{url:', {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_CONVERTER_BUNDLE_URL) {
        return new Response("mutability:s[r.mutability];inline_style_ranges:", {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/ArticleEntityResultByRestId")) {
        return jsonResponse({
          data: {
            article_result_by_rest_id: {
              rest_id: articleId,
              title: "Old title",
              metadata: { author_results: { result: { rest_id: VIEWER_ID } } },
              lifecycle_state: { lifecycle: "Draft" },
            },
          },
        });
      }
      if (request.url.pathname.endsWith("/ArticleEntityUpdateTitle")) {
        return jsonResponse({
          data: { articleentity_update_title: { rest_id: articleId, title } },
        });
      }
      throw new Error("unexpected partial Article request " + request.url.href);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.draft.save"),
      { title, document, draft_id: articleId },
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

    expect(result).toMatchObject({
      status: "partial",
      finalUrl: "https://x.com/compose/articles/edit/" + articleId,
      dispatchStarted: true,
      dispatch: { planned: 2, started: 1, verified: 1 },
    });
    expect(before.map((event) => event.id)).toEqual(["articles.title"]);
    expect(after.map((event) => event.id)).toEqual(["articles.title"]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.some((call) => call.url.pathname.endsWith("/ArticleEntityUpdateContent"))).toBeFalse();
  });

  test("leaves an Article draft indeterminate when the create response does not bind the confirmed title", async () => {
    const calls: CapturedRequest[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const document = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Body" }],
    });
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(richArticleHtml(), { headers: { "content-type": "text/html" } });
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
      if (request.url.href === ARTICLE_ENTITIES_BUNDLE_URL) {
        return new Response('createEntity(w.Sg,"MUTABLE",{url:', {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.href === ARTICLE_CONVERTER_BUNDLE_URL) {
        return new Response("mutability:s[r.mutability];inline_style_ranges:", {
          headers: { "content-type": "application/javascript" },
        });
      }
      if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/ArticleEntityDraftCreate")) {
        return jsonResponse({
          data: {
            articleentity_create_draft: {
              article_entity_results: {
                result: { rest_id: "700000000000000002", title: "Different title" },
              },
            },
          },
        });
      }
      throw new Error(`unexpected mismatched Article response request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("articles.draft.save"),
      { title: "Confirmed title", document },
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
      error: "X may have accepted the private Article create, but the confirmed input has no exact draft ID for safe reconciliation; preserve the indeterminate run and do not retry",
    });
    expect(after).toEqual([]);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  test("records mutation dispatch only immediately before the direct CreateTweet request and verifies afterward", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const after: WebSessionDispatchEvent[] = [];
    const accepted: unknown[] = [];
    const body = "runtime dispatch fixture";
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.href === "https://x.com/home") {
        return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
      }
      if (request.url.href === MAIN_URL) {
        return new Response(mainBundle(
          descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
          descriptor("CreateTweet", CREATE_TWEET_QUERY_ID, "mutation"),
          descriptor("TweetResultByRestId", "4hhGRbehkcUVTKf8n0f0xw", "query"),
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
          queryId: CREATE_TWEET_QUERY_ID,
        });
        return jsonResponse(createTweetResponse({ text: body }));
      }
      if (request.url.pathname.endsWith("/TweetResultByRestId")) {
        expect(request.method).toBe("GET");
        expect(JSON.parse(request.url.searchParams.get("variables") ?? "null")).toMatchObject({
          tweetId: CREATED_POST_ID,
        });
        return jsonResponse(publishedTweetReadback({ text: body }));
      }
      throw new Error(`unexpected test request ${request.url.href}`);
    });

    const result = await executeXWebOperation(
      xRecipe("posts.publish", 3),
      { body },
      xAuth,
      {
        dependencies: runtimeDependencies,
        beforeDispatch: (event) => {
          before.push(event);
          return Promise.resolve();
        },
        afterProviderAcceptedMutationTarget: (event) => {
          accepted.push(event);
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
    expect(accepted).toEqual([{
      id: "posts.publish",
      index: 1,
      target: {
        schemaVersion: 1,
        identifier: canonicalJson({ postId: CREATED_POST_ID, mediaId: null }),
      },
    }]);
    expect(after).toEqual([{
      id: "posts.publish",
      index: 1,
      progress: { planned: 1, started: 1, verified: 1 },
    }]);
  });

  test("fixture confirm of historical posts.publish@2 starts and verifies CreateTweet", async () => {
    const calls: CapturedRequest[] = [];
    const body = "historical posts.publish@2 dispatch fixture";
    const result = await executeXWebOperation(
      xRecipe("posts.publish", 2),
      { body },
      xAuth,
      {
        dependencies: dependencies(calls, (request) => {
          if (request.url.href === "https://x.com/home") {
            return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
          }
          if (request.url.href === MAIN_URL) {
            return new Response(mainBundle(
              descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
              descriptor("CreateTweet", CREATE_TWEET_QUERY_ID, "mutation"),
              descriptor("TweetResultByRestId", "4hhGRbehkcUVTKf8n0f0xw", "query"),
            ), { headers: { "content-type": "application/javascript" } });
          }
          if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
          if (request.url.pathname.endsWith("/CreateTweet")) {
            const payload = JSON.parse(request.body ?? "null") as Record<string, unknown>;
            expect(payload).toMatchObject({
              variables: { tweet_text: body },
              queryId: CREATE_TWEET_QUERY_ID,
            });
            return jsonResponse(createTweetResponse({ text: body }));
          }
          if (request.url.pathname.endsWith("/TweetResultByRestId")) {
            return jsonResponse(publishedTweetReadback({ text: body }));
          }
          throw new Error(`unexpected test request ${request.url.href}`);
        }),
      },
    );

    expect(result).toEqual({
      status: "succeeded",
      output: { posts: [{ id: CREATED_POST_ID, url: `https://x.com/i/status/${CREATED_POST_ID}` }] },
      finalUrl: `https://x.com/i/status/${CREATED_POST_ID}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(calls.some((call) => call.url.pathname.endsWith("/CreateTweet"))).toBeTrue();
  });

  test("polls a bounded exact post locator when X public readback settles late", async () => {
    const calls: CapturedRequest[] = [];
    const pauses: number[] = [];
    const body = "late X readback fixture";
    let readbacks = 0;
    const result = await executeXWebOperation(
      xRecipe("posts.publish"),
      { body },
      xAuth,
      {
        dependencies: dependencies(calls, (request) => {
          if (request.url.href === "https://x.com/home") {
            return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
          }
          if (request.url.href === MAIN_URL) {
            return new Response(mainBundle(
              descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
              descriptor("CreateTweet", CREATE_TWEET_QUERY_ID, "mutation"),
              descriptor("TweetResultByRestId", "4hhGRbehkcUVTKf8n0f0xw", "query"),
            ), { headers: { "content-type": "application/javascript" } });
          }
          if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
          if (request.url.pathname.endsWith("/CreateTweet")) {
            return jsonResponse(createTweetResponse({ text: body }));
          }
          if (request.url.pathname.endsWith("/TweetResultByRestId")) {
            readbacks += 1;
            return readbacks === 1
              ? jsonResponse({ data: { tweetResult: { result: null } } })
              : jsonResponse(publishedTweetReadback({ text: body }));
          }
          throw new Error(`unexpected delayed X readback request ${request.url.href}`);
        }, {
          sleep: (milliseconds) => {
            pauses.push(milliseconds);
            return Promise.resolve();
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      output: { posts: [{ id: CREATED_POST_ID }] },
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(readbacks).toBe(2);
    expect(pauses).toEqual([250]);
  });

  test("reconciles one exact accepted X post without a provider write", async () => {
    const calls: CapturedRequest[] = [];
    const body = "Reconciled X post";
    const identifier = canonicalJson({ postId: CREATED_POST_ID, mediaId: null });
    const result = await readXWebPublishedMutationTarget(
      xRecipe("posts.publish", 3),
      { body },
      xAuth,
      identifier,
      {
        dependencies: dependencies(calls, (request) => {
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
            return jsonResponse(publishedTweetReadback({ text: body }));
          }
          throw new Error(`unexpected X reconciliation request ${request.url.href}`);
        }),
      },
    );
    expect(result).toEqual({ present: true, postId: CREATED_POST_ID });
    expect(calls.every((request) => request.method === "GET")).toBeTrue();
    await expect(readXWebPublishedMutationTarget(
      xRecipe("posts.publish", 3),
      { body },
      xAuth,
      `${identifier} `,
    )).rejects.toThrow("not canonical");
  });

  test("uploads one plan-bound PNG before CreateTweet and independently binds the returned photo", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-x-publish-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    writeFileSync(imagePath, imageBytes, { mode: 0o600 });
    const body = "Exact X image post";
    const mediaId = "12345";
    const calls: CapturedRequest[] = [];
    const events: string[] = [];
    try {
      const result = await executeXWebOperation(
        xRecipe("posts.publish"),
        {
          body,
          media: { kind: "file", reference: "fixture" },
          media_type: "image/png",
        },
        xAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          beforeDispatch: (event) => {
            events.push(`before ${event.progress.started}`);
            return Promise.resolve();
          },
          afterDispatchVerified: (event) => {
            events.push(`after ${event.progress.verified}`);
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            events.push(`${request.method} ${request.url.hostname}${request.url.pathname}`);
            if (request.url.href === "https://x.com/home") {
              return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
            }
            if (request.url.href === MAIN_URL) {
              return new Response(mainBundle(
                descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
                descriptor("CreateTweet", CREATE_TWEET_QUERY_ID, "mutation"),
                descriptor("TweetResultByRestId", "4hhGRbehkcUVTKf8n0f0xw", "query"),
              ), { headers: { "content-type": "application/javascript" } });
            }
            if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
            if (request.url.hostname === "upload.x.com") {
              expect(request.headers.get("x-csrf-token")).toBe("csrf_token_0123456789abcdef");
              const command = request.url.searchParams.get("command");
              if (command === "INIT") {
                expect(request.url.searchParams.get("total_bytes")).toBe(String(imageBytes.byteLength));
                expect(request.url.searchParams.get("media_type")).toBe("image/png");
                expect(request.url.searchParams.get("media_category")).toBe("tweet_image");
                return jsonResponse({
                  expires_after_secs: 86_400,
                  media_id: 12345,
                  media_id_string: mediaId,
                  media_key: `3_${mediaId}`,
                });
              }
              if (command === "APPEND") {
                expect(request.url.searchParams.get("media_id")).toBe(mediaId);
                expect(request.url.searchParams.get("segment_index")).toBe("0");
                expect(request.headers.get("content-type")).toMatch(
                  /^multipart\/form-data; boundary=wrench-x-media-[a-f0-9]{32}$/u,
                );
                return new Response(null, { status: 204 });
              }
              if (command === "FINALIZE") {
                return jsonResponse({
                  expires_after_secs: 86_400,
                  media_id: 12345,
                  media_id_string: mediaId,
                  media_key: `3_${mediaId}`,
                  size: imageBytes.byteLength,
                  image: { h: 1, image_type: "image/png", w: 1 },
                });
              }
            }
            if (request.url.pathname.endsWith("/CreateTweet")) {
              const payload = JSON.parse(request.body ?? "null") as {
                readonly variables: { readonly media: unknown };
              };
              expect(payload.variables.media).toEqual({
                media_entities: [{ media_id: mediaId, tagged_users: [] }],
                possibly_sensitive: false,
              });
              return jsonResponse(createTweetResponse({ text: body, mediaId }));
            }
            if (request.url.pathname.endsWith("/TweetResultByRestId")) {
              return jsonResponse(publishedTweetReadback({ text: body, mediaId }));
            }
            throw new Error(`unexpected X image publish request ${request.url.href}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        output: { posts: [{ id: CREATED_POST_ID }] },
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
      const lastUpload = events.lastIndexOf("POST upload.x.com/i/media/upload.json");
      const admitted = events.indexOf("before 0");
      const create = events.indexOf(`POST x.com/i/api/graphql/${CREATE_TWEET_QUERY_ID}/CreateTweet`);
      expect(lastUpload).toBeGreaterThan(-1);
      expect(admitted).toBeGreaterThan(lastUpload);
      expect(create).toBeGreaterThan(admitted);
      expect(events.at(-1)).toBe("after 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps an X image upload failure before public-post admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-x-upload-failure-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, new Uint8Array([137, 80, 78, 71]), { mode: 0o600 });
    const calls: CapturedRequest[] = [];
    let admissions = 0;
    try {
      const result = await executeXWebOperation(
        xRecipe("posts.publish"),
        {
          body: "Do not retry",
          media: { kind: "file", reference: "fixture" },
          media_type: "image/png",
        },
        xAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          beforeDispatch: () => {
            admissions += 1;
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            if (request.url.href === "https://x.com/home") {
              return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
            }
            if (request.url.href === MAIN_URL) {
              return new Response(mainBundle(
                descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
                descriptor("CreateTweet", CREATE_TWEET_QUERY_ID, "mutation"),
              ), { headers: { "content-type": "application/javascript" } });
            }
            if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
            if (request.url.hostname === "upload.x.com") {
              return new Response("upload failed", { status: 503 });
            }
            throw new Error(`unexpected request after X upload failure ${request.url.href}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
        error: expect.stringMatching(
          /^X post preparation failed before public post submission; failure stage: media-upload-init; .+; retry with a fresh confirmed plan$/u,
        ),
      });
      expect(admissions).toBe(0);
      expect(calls.some((call) => call.url.pathname.endsWith("/CreateTweet"))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      xRecipe("posts.publish", 3),
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
      error: "X post preparation failed before public post submission; failure stage: post-request-preparation; X bundle omitted operation CreateTweet; retry with a fresh confirmed plan",
    });
    expect(before).toEqual([]);
    expect(calls.some((call) => call.method === "POST")).toBeFalse();
  });

  test("fails before dispatch when the live CreateTweet query ID drifted from reviewed evidence", async () => {
    const calls: CapturedRequest[] = [];
    const before: WebSessionDispatchEvent[] = [];
    const result = await executeXWebOperation(
      xRecipe("posts.publish", 3),
      { body: "stale CreateTweet evidence must not dispatch" },
      xAuth,
      {
        dependencies: dependencies(calls, (request) => {
          if (request.url.href === "https://x.com/home") {
            return new Response(homeHtml(), { headers: { "content-type": "text/html" } });
          }
          if (request.url.href === MAIN_URL) {
            return new Response(mainBundle(
              descriptor("Viewer", "u4ni7JqpqdAQxWQfkLsdUQ", "query"),
              descriptor("CreateTweet", STALE_CREATE_TWEET_QUERY_ID, "mutation"),
            ), { headers: { "content-type": "application/javascript" } });
          }
          if (request.url.pathname.endsWith("/Viewer")) return jsonResponse(viewerResponse());
          throw new Error(`unexpected test request ${request.url.href}`);
        }),
        beforeDispatch: (event) => {
          before.push(event);
          return Promise.resolve();
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      dispatchStarted: false,
      finalUrl: null,
      dispatch: { planned: 1, started: 0, verified: 0 },
      error: "X post preparation failed before public post submission; failure stage: post-request-preparation; X query-ID drift for CreateTweet:mutation; reviewed evidence is stale; retry with a fresh confirmed plan",
    });
    expect(result.error).not.toContain(STALE_CREATE_TWEET_QUERY_ID);
    expect(result.error).not.toContain(CREATE_TWEET_QUERY_ID);
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
          descriptor("CreateTweet", CREATE_TWEET_QUERY_ID, "mutation"),
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
            descriptor("CreateTweet", CREATE_TWEET_QUERY_ID, "mutation"),
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
        error: "X may have accepted the current post dispatch; failure stage: create-response-binding; reconcile before retrying",
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
                expect(command[1]).toBe("https://x.com/robots.txt");
                order.push("transaction:open");
                return Promise.resolve([{ success: true, data: null }]);
              }
              if (command[0] === "get" && command[1] === "url") {
                order.push("transaction:get-url");
                return Promise.resolve([{ success: true, data: { url: "https://x.com/robots.txt" } }]);
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
