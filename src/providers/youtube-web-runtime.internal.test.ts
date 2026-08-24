import { describe, expect, test } from "bun:test";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  executeYouTubeWebOperation,
  prepareYouTubeWebDesiredState,
  probeYouTubeWebSubject,
  readYouTubeWebDesiredState,
  type YouTubeWebRuntimeDependencies,
} from "./youtube-web-runtime";

const CHANNEL_ID = `UC${"a".repeat(22)}`;
const TARGET_CHANNEL_ID = `UC${"b".repeat(22)}`;
const GAIA_ID = "123456789012345678901";
const DELEGATE_ID = "delegated-page-id";
const VIDEO_ID = "dQw4w9WgXcQ";
const POST_ID = `Ug${"p".repeat(24)}`;
const API_KEY = "AIzaSyntheticPublicKey1234567890";
const SAPISID = "private-sapisid-cookie";

const youtubeAuth = {
  schemaVersion: 1,
  id: "youtube-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: `youtube:channel:${CHANNEL_ID}/gaia:${GAIA_ID}/delegate:${DELEGATE_ID}`,
} as const satisfies WrenchAuth;

type CapturedRequest = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Readonly<Record<string, unknown>> | null;
};

function strictCookie(name: string, value: string): StrictCookie {
  return {
    name,
    value,
    domain: ".youtube.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None",
    expires: 0,
  };
}

function bootstrapHtml(): string {
  return [
    "<!doctype html>",
    `<script>ytcfg.set(${JSON.stringify({
      INNERTUBE_API_KEY: API_KEY,
      INNERTUBE_CONTEXT_CLIENT_NAME: 1,
      LOGGED_IN: true,
      SESSION_INDEX: 0,
      DELEGATED_SESSION_ID: DELEGATE_ID,
    })});</script>`,
    `<script>ytcfg.set(${JSON.stringify({
      INNERTUBE_CONTEXT: {
        client: {
          clientName: "WEB",
          clientVersion: "2.20260722.01.00",
          hl: "en",
          gl: "US",
          visitorData: "visitor-data",
        },
        request: { useSsl: true },
      },
    })});</script>`,
  ].join("");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(): Response {
  return new Response(bootstrapHtml(), {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

function profileHtmlResponse(value: unknown): Response {
  return new Response(
    `<!doctype html><script>var ytInitialData = ${JSON.stringify(value)};</script>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
}

function accountMenuResponse(channelId = CHANNEL_ID): unknown {
  return {
    actions: [{
      openPopupAction: {
        popup: {
          multiPageMenuRenderer: {
            header: {
              activeAccountHeaderRenderer: {
                serviceEndpoint: { browseEndpoint: { browseId: channelId } },
              },
            },
          },
        },
      },
    }],
  };
}

function accountsListResponse(channelId = CHANNEL_ID): unknown {
  return {
    actions: [{
      getMultiPageMenuAction: {
        menu: {
          multiPageMenuRenderer: {
            sections: [{
              accountItemSectionRenderer: {
                contents: [{
                  accountItemRenderer: {
                    isSelected: true,
                    serviceEndpoint: {
                      browseEndpoint: { browseId: channelId },
                      selectActiveIdentityEndpoint: {
                        supportedTokens: [{
                          accountStateToken: { obfuscatedGaiaId: GAIA_ID },
                        }],
                      },
                    },
                  },
                }],
              },
            }],
          },
        },
      },
    }],
  };
}

function likeStateResponse(enabled: boolean): unknown {
  return {
    currentVideoEndpoint: { watchEndpoint: { videoId: VIDEO_ID } },
    buttons: [{
      toggleButtonRenderer: {
        defaultIcon: { iconType: "LIKE" },
        isToggled: enabled,
      },
    }],
  };
}

function watchLaterStateResponse(enabled: boolean): unknown {
  return {
    currentVideoEndpoint: { watchEndpoint: { videoId: VIDEO_ID } },
    menu: [{
      playlistEditEndpoint: {
        playlistId: "WL",
        actions: [enabled
          ? { action: "ACTION_REMOVE_VIDEO", removedVideoId: VIDEO_ID }
          : { action: "ACTION_ADD_VIDEO", addedVideoId: VIDEO_ID }],
      },
    }],
  };
}

function subscriptionStateResponse(enabled: boolean): unknown {
  return {
    metadata: {
      channelMetadataRenderer: { externalId: TARGET_CHANNEL_ID },
    },
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [{
          payload: { subscriptionStateEntity: { subscribed: enabled } },
        }],
      },
    },
  };
}

function requestUrl(value: string | URL | Request): URL {
  return new URL(typeof value === "string" ? value : value instanceof URL ? value.href : value.url);
}

function dependencies(
  calls: CapturedRequest[],
  handler: (request: CapturedRequest) => Response | Promise<Response>,
  onAcquire?: () => void,
): YouTubeWebRuntimeDependencies {
  const acquireCookies: CookieRecordReader = () => {
    onAcquire?.();
    return Promise.resolve({
      cookies: [strictCookie("SAPISID", SAPISID)],
      warnings: [],
    });
  };
  const fetch = (async (value: string | URL | Request, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const request: CapturedRequest = {
      url: requestUrl(value),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: bodyText === null ? null : JSON.parse(bodyText) as Readonly<Record<string, unknown>>,
    };
    calls.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return {
    acquireCookies,
    fetch,
    now: () => 1_700_000_000_000,
  };
}

function endpoint(request: CapturedRequest): string {
  return request.url.pathname.replace("/youtubei/v1/", "");
}

function baseHandler(
  request: CapturedRequest,
  operation: (request: CapturedRequest) => Response | null,
  channelId = CHANNEL_ID,
): Response {
  if (request.url.pathname === "/") return htmlResponse();
  if (endpoint(request) === "account/account_menu") return jsonResponse(accountMenuResponse(channelId));
  if (endpoint(request) === "account/accounts_list") return jsonResponse(accountsListResponse(channelId));
  const response = operation(request);
  if (response !== null) return response;
  throw new Error(`unexpected YouTube request ${request.method} ${request.url.href}`);
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "youtube",
    action,
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 4 * 1024 * 1024,
  };
}

function body(request: CapturedRequest): Readonly<Record<string, unknown>> {
  if (request.body === null) throw new Error("expected JSON request body");
  return request.body;
}

function assertInnertubeEnvelope(request: CapturedRequest): void {
  expect(request.method).toBe("POST");
  expect(request.url.origin).toBe("https://www.youtube.com");
  expect(request.url.searchParams.get("prettyPrint")).toBe("false");
  expect(request.url.searchParams.get("key")).toBe(API_KEY);
  expect([...request.url.searchParams.keys()].sort()).toEqual(["key", "prettyPrint"]);
  expect(request.headers.get("authorization")).toMatch(
    /^SAPISIDHASH 1700000000_[a-f0-9]{40}$/u,
  );
  expect(request.headers.get("authorization")).not.toContain(SAPISID);
  expect(request.headers.get("x-origin")).toBe("https://www.youtube.com");
  expect(request.headers.get("x-goog-authuser")).toBe("0");
  expect(request.headers.get("x-goog-pageid")).toBe("delegated-page-id");
  expect(request.headers.get("x-youtube-client-name")).toBe("1");
  expect(request.headers.get("x-youtube-client-version")).toBe("2.20260722.01.00");
  expect(body(request).context).toEqual({
    client: {
      clientName: "WEB",
      clientVersion: "2.20260722.01.00",
      hl: "en",
      gl: "US",
      visitorData: "visitor-data",
    },
    request: { useSsl: true },
  });
}

describe("YouTube authenticated Innertube runtime", () => {
  test("probes the current channel through both exact account endpoints", async () => {
    const calls: CapturedRequest[] = [];
    const unboundAuth: WrenchAuth = {
      schemaVersion: 1,
      id: youtubeAuth.id,
      kind: youtubeAuth.kind,
      source: youtubeAuth.source,
      profile: youtubeAuth.profile,
    };
    const subject = await probeYouTubeWebSubject(
      unboundAuth,
      {
        dependencies: dependencies(calls, (request) =>
          baseHandler(request, () => null)),
      },
    );
    expect(subject).toBe(
      `youtube:channel:${CHANNEL_ID}/gaia:${GAIA_ID}/delegate:${DELEGATE_ID}`,
    );
    expect(calls.map((request) => request.url.pathname)).toEqual([
      "/",
      "/youtubei/v1/account/account_menu",
      "/youtubei/v1/account/accounts_list",
    ]);
    for (const request of calls.slice(1)) assertInnertubeEnvelope(request);
  });

  test("executes each observed R1 operation through fixed endpoints and bounded projections", async () => {
    const scenarios: readonly {
      readonly action: WebSessionRecipe["action"];
      readonly input: OperationInput;
      readonly handler: (request: CapturedRequest) => Response | null;
      readonly expectedPaths: readonly string[];
      readonly verify: (output: unknown) => void;
    }[] = [
      {
        action: "feeds.read",
        input: { feed: "subscriptions", limit: 5 },
        handler: (request) => endpoint(request) === "browse"
          ? jsonResponse({
            contents: [{
              videoRenderer: {
                videoId: VIDEO_ID,
                title: { simpleText: "Feed video" },
              },
            }],
          })
          : null,
        expectedPaths: ["browse"],
        verify: (output) => expect(output).toMatchObject({
          feed: "subscriptions",
          items: [{ kind: "video", id: VIDEO_ID, title: "Feed video" }],
        }),
      },
      {
        action: "media.read",
        input: { video_id: VIDEO_ID },
        handler: (request) => endpoint(request) === "player"
          ? jsonResponse({
            videoDetails: {
              videoId: VIDEO_ID,
              title: "Media video",
              channelId: TARGET_CHANNEL_ID,
            },
            playabilityStatus: { status: "OK" },
          })
          : null,
        expectedPaths: ["player"],
        verify: (output) => expect(output).toMatchObject({
          videoId: VIDEO_ID,
          title: "Media video",
          channelId: TARGET_CHANNEL_ID,
        }),
      },
      {
        action: "posts.read",
        input: { post_id: POST_ID },
        handler: (request) => endpoint(request) === "navigation/resolve_url"
          ? jsonResponse({
            endpoint: {
              commandMetadata: {
                webCommandMetadata: { url: `/post/${POST_ID}` },
              },
              browseEndpoint: {
                browseId: "FEpost_detail",
                params: "EhhzeW50aGV0aWMtcG9zdC1wYXJhbXM=",
              },
            },
          })
          : endpoint(request) === "browse"
            ? jsonResponse({
            contents: [{
              backstagePostRenderer: {
                postId: POST_ID,
                contentText: { simpleText: "Community update" },
              },
            }],
          })
            : null,
        expectedPaths: ["navigation/resolve_url", "browse"],
        verify: (output) => expect(output).toMatchObject({
          id: POST_ID,
          body: "Community update",
        }),
      },
      {
        action: "profiles.read",
        input: { profile: "@wrench_test" },
        handler: (request) => endpoint(request) === "navigation/resolve_url"
          ? jsonResponse({
            endpoint: {
              browseEndpoint: {
                browseId: TARGET_CHANNEL_ID,
                canonicalBaseUrl: "/@wrench_test",
                params: "about-tab-params",
              },
            },
          })
          : request.url.pathname === "/@wrench_test/about"
            ? profileHtmlResponse({
              metadata: {
                channelMetadataRenderer: {
                  externalId: TARGET_CHANNEL_ID,
                  title: "Wrench Test",
                  description: "Public channel bio",
                },
              },
              engagementPanels: [{
                aboutChannelViewModel: {
                  channelId: TARGET_CHANNEL_ID,
                  canonicalChannelUrl: "http://www.youtube.com/@wrench_test",
                  subscriberCountText: "4 subscribers",
                  videoCountText: "11 videos",
                  viewCountText: "2,061 views",
                },
              }],
            })
            : null,
        expectedPaths: ["navigation/resolve_url", "/@wrench_test/about"],
        verify: (output) => expect(output).toEqual({
          schemaVersion: 1,
          provider: "youtube",
          target: {
            kind: "profile",
            id: TARGET_CHANNEL_ID,
            url: "https://www.youtube.com/@wrench_test",
          },
          observedAt: "2023-11-14T22:13:20.000Z",
          completeness: "complete",
          metrics: {
            subscribers: { status: "available", value: 4, precision: "exact", unit: "count" },
            videos: { status: "available", value: 11, precision: "exact", unit: "count" },
            views: { status: "available", value: 2061, precision: "exact", unit: "count" },
          },
          metadata: {
            handle: "wrench_test",
            displayName: "Wrench Test",
            bio: "Public channel bio",
          },
        }),
      },
      {
        action: "comments.read",
        input: { video_id: VIDEO_ID, limit: 5 },
        handler: (request) => {
          if (endpoint(request) !== "next") return null;
          if (body(request).videoId === VIDEO_ID) {
            return jsonResponse({
              currentVideoEndpoint: { watchEndpoint: { videoId: VIDEO_ID } },
              contents: [{
                itemSectionRenderer: {
                  targetId: "comments-section",
                  contents: [{
                    continuationItemRenderer: {
                      continuationEndpoint: {
                        continuationCommand: { token: "comments-token" },
                      },
                    },
                  }],
                },
              }],
            });
          }
          if (body(request).continuation === "comments-token") {
            return jsonResponse({
              continuationContents: [{
                commentThreadRenderer: {
                  comment: {
                    commentRenderer: {
                      commentId: "comment_123456",
                      contentText: { simpleText: "Comment body" },
                    },
                  },
                },
              }],
            });
          }
          return null;
        },
        expectedPaths: ["next", "next"],
        verify: (output) => expect(output).toMatchObject({
          videoId: VIDEO_ID,
          comments: [{ id: "comment_123456", body: "Comment body" }],
        }),
      },
    ];
    for (const scenario of scenarios) {
      const calls: CapturedRequest[] = [];
      const result = await executeYouTubeWebOperation(
        recipe(scenario.action),
        scenario.input,
        youtubeAuth,
        {
          dependencies: dependencies(calls, (request) =>
            baseHandler(request, scenario.handler)),
        },
      );
      expect(result.status).toBe("succeeded");
      expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      scenario.verify(result.output);
      const operationCalls = calls.slice(3);
      expect(operationCalls.map(endpoint)).toEqual([...scenario.expectedPaths]);
      for (const request of calls.slice(1)) {
        if (request.url.pathname.startsWith("/youtubei/v1/")) {
          assertInnertubeEnvelope(request);
        }
      }
    }
  });

  test("keeps deterministic R2 implementations inert until live fixtures are authorized", () => {
    for (const [action, input] of [
      ["likes.set", { video_id: VIDEO_ID, liked: true }],
      ["content.save", { video_id: VIDEO_ID, saved: true }],
      ["relationships.follow.set", { channel_id: TARGET_CHANNEL_ID, followed: true }],
    ] as const) {
      let acquisitions = 0;
      const calls: CapturedRequest[] = [];
      expect(executeYouTubeWebOperation(
        recipe(action),
        input,
        youtubeAuth,
        {
          dependencies: dependencies(
            calls,
            () => {
              throw new Error("network must not run");
            },
            () => {
              acquisitions += 1;
            },
          ),
        },
      )).rejects.toThrow("capture-required");
      expect(acquisitions).toBe(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("keeps video publication and authored-video deletion network-inert", () => {
    for (const [action, contractVersion, input, reason] of [
      ["media.publish", 2, {
        age_restricted: false,
        category_id: "22",
        contains_synthetic_media: false,
        made_for_kids: false,
        media: { kind: "file", reference: "plan-video" },
        notify_subscribers: false,
        title: "Private fixture",
        visibility: "private",
      }, "selected MP4 remained at 0%"],
      ["content.delete", 1, {
        expected_title: "Private fixture",
        video_id: VIDEO_ID,
      }, "discarded the stalled incomplete Studio draft"],
    ] as const) {
      let acquisitions = 0;
      let fileResolutions = 0;
      const calls: CapturedRequest[] = [];
      expect(executeYouTubeWebOperation(
        { ...recipe(action), contractVersion },
        input,
        youtubeAuth,
        {
          fileResolver: () => {
            fileResolutions += 1;
            throw new Error("file resolution must not run");
          },
          dependencies: dependencies(
            calls,
            () => {
              throw new Error("network must not run");
            },
            () => {
              acquisitions += 1;
            },
          ),
        },
      )).rejects.toThrow(reason);
      expect(acquisitions).toBe(0);
      expect(fileResolutions).toBe(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("prepares all three already-satisfied states before any mutation dispatch", async () => {
    const scenarios = [
      {
        action: "likes.set",
        input: { video_id: VIDEO_ID, liked: true },
        expectedKind: "like",
        expectedTargetId: VIDEO_ID,
        expectedEndpoint: "next",
        response: likeStateResponse(true),
      },
      {
        action: "content.save",
        input: { video_id: VIDEO_ID, saved: true },
        expectedKind: "watch-later",
        expectedTargetId: VIDEO_ID,
        expectedEndpoint: "next",
        response: watchLaterStateResponse(true),
      },
      {
        action: "relationships.follow.set",
        input: { channel_id: TARGET_CHANNEL_ID, followed: true },
        expectedKind: "subscription",
        expectedTargetId: TARGET_CHANNEL_ID,
        expectedEndpoint: "browse",
        response: subscriptionStateResponse(true),
      },
    ] as const;
    for (const scenario of scenarios) {
      const prepareCalls: CapturedRequest[] = [];
      const preparation = await prepareYouTubeWebDesiredState(
        recipe(scenario.action),
        scenario.input,
        youtubeAuth,
        {
          dependencies: dependencies(prepareCalls, (request) =>
            baseHandler(request, (operationRequest) =>
              endpoint(operationRequest) === scenario.expectedEndpoint
                ? jsonResponse(scenario.response)
                : null)),
        },
      );
      expect(preparation).toEqual({
        kind: scenario.expectedKind,
        targetId: scenario.expectedTargetId,
        desiredState: true,
        actualState: true,
        alreadyDesired: true,
      });
      expect(prepareCalls.slice(3).map(endpoint)).toEqual([
        scenario.expectedEndpoint,
      ]);
      expect(prepareCalls.some((request) => [
        "like/like",
        "like/removelike",
        "playlist/edit",
        "subscription/subscribe",
        "subscription/unsubscribe",
      ].includes(endpoint(request)))).toBeFalse();

      const readbackCalls: CapturedRequest[] = [];
      expect(await readYouTubeWebDesiredState(
        recipe(scenario.action),
        scenario.input,
        youtubeAuth,
        {
          dependencies: dependencies(readbackCalls, (request) =>
            baseHandler(request, (operationRequest) =>
              endpoint(operationRequest) === scenario.expectedEndpoint
                ? jsonResponse(scenario.response)
                : null)),
        },
      )).toEqual({
        kind: scenario.expectedKind,
        targetId: scenario.expectedTargetId,
        enabled: true,
      });
      expect(readbackCalls.slice(3).map(endpoint)).toEqual([
        scenario.expectedEndpoint,
      ]);
    }
  });

  test("fails account mismatch before any operation endpoint is called", async () => {
    const calls: CapturedRequest[] = [];
    let message = "";
    try {
      await executeYouTubeWebOperation(
        recipe("media.read"),
        { video_id: VIDEO_ID },
        youtubeAuth,
        {
          dependencies: dependencies(calls, (request) =>
            baseHandler(request, () => null, TARGET_CHANNEL_ID)),
        },
      );
    } catch (error) {
      message = error instanceof Error
        ? `${error.message}: ${error.cause instanceof Error ? error.cause.message : ""}`
        : String(error);
    }
    expect(message).toContain("current account did not match");
    expect(calls.map((request) => request.url.pathname)).toEqual([
      "/",
      "/youtubei/v1/account/account_menu",
      "/youtubei/v1/account/accounts_list",
    ]);
  });

  test("capture-required actions have no executable code path", () => {
    const calls: CapturedRequest[] = [];
    expect(executeYouTubeWebOperation(
      recipe("comments.create"),
      { video_id: VIDEO_ID, body: "Not dispatched" },
      youtubeAuth,
      {
        dependencies: dependencies(calls, (request) =>
          baseHandler(request, () => null)),
      },
    )).rejects.toThrow("has no executable reviewed contract");
    expect(calls).toHaveLength(0);
  });
});
