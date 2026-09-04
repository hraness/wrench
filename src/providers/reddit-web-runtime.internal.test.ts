import { describe, expect, test } from "bun:test";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import { REDDIT_FLAIR_OPERATION_NAMES } from "../plugins/reddit-web/flair";
import {
  executeRedditWebOperation,
  prepareRedditWebDesiredState,
  probeRedditWebSubject,
  readRedditWebContentDeleteDesiredState,
  readRedditWebDesiredState,
  readRedditWebPublishedMutationTarget,
  type RedditWebRuntimeDependencies,
} from "./reddit-web-runtime";

const VIEWER_ID = "viewer1";
const SUBJECT = `reddit:t2_${VIEWER_ID}`;
const POST_ID = "t3_abc123";
const COMMENT_ID = "t1_def456";
const MESSAGE_ID = "t4_msg123";
const FIRST_MODHASH = "first-synthetic-modhash";

test("unobserved flair operations fail before cookies, network, or dispatch", async () => {
  for (const action of REDDIT_FLAIR_OPERATION_NAMES) {
    let acquired = false;
    let dispatched = false;
    const calls: CapturedRequest[] = [];
    await expect(executeRedditWebOperation({
      site: "reddit", action, contractVersion: 1,
      timeoutMs: 60_000, maxOutputBytes: 524_288,
    }, { community: "example" }, redditAuth, {
      beforeDispatch: async () => { dispatched = true; },
      dependencies: dependencies(calls, () => jsonResponse({}), () => { acquired = true; }),
    })).rejects.toThrow("capture-required");
    expect(acquired).toBe(false);
    expect(dispatched).toBe(false);
    expect(calls).toEqual([]);
  }
});

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
  readonly body: string | Uint8Array | null;
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
  const acquireCookies: CookieRecordReader = (_selection, target) => {
    onAcquire?.();
    return Promise.resolve({
      cookies: target.hostname.endsWith("reddit.com") ? [strictCookie()] : [],
      warnings: [],
    });
  };
  const fetch = (async (value: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: requestUrl(value),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array ? init.body : null,
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

function profileResponse(): unknown {
  return {
    kind: "t2",
    data: {
      id: VIEWER_ID,
      name: "wrench_viewer",
      total_karma: 4321,
      subreddit: {
        display_name_prefixed: "u/wrench_viewer",
        title: "Wrench Viewer",
        public_description: "Public profile bio",
        subscribers: 8,
      },
    },
  };
}

function contributionThing(kind: "t1" | "t3", id: string): unknown {
  return {
    kind,
    data: {
      name: id,
      author: "wrench_viewer",
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

function mediaLease(
  mediaType: "video/mp4" | "image/png",
): unknown {
  const video = mediaType === "video/mp4";
  const hostname = video
    ? "reddit-uploaded-video.s3-accelerate.amazonaws.com"
    : "reddit-uploaded-media.s3-accelerate.amazonaws.com";
  const extension = video ? "mp4" : "png";
  const assetId = video ? "videoasset1" : "posterasset1";
  const values: Readonly<Record<string, string>> = {
    "x-amz-algorithm": "AWS4-HMAC-SHA256",
    key: `rte_images/${assetId}.${extension}`,
    "x-amz-storage-class": "STANDARD",
    success_action_status: "201",
    bucket: video ? "reddit-uploaded-video" : "reddit-uploaded-media",
    acl: "private",
    "x-amz-signature": "signature",
    "x-amz-security-token": "security-token",
    "x-amz-date": "20260822T000000Z",
    "x-amz-meta-ext": extension,
    policy: "bounded-policy",
    "x-amz-credential": "credential",
    "Content-Type": mediaType,
  };
  const names = video
    ? [
        "x-amz-algorithm", "key", "x-amz-storage-class", "success_action_status",
        "bucket", "acl", "x-amz-signature", "x-amz-security-token", "x-amz-date",
        "x-amz-meta-ext", "policy", "x-amz-credential", "Content-Type",
      ]
    : [
        "x-amz-algorithm", "x-amz-security-token", "x-amz-storage-class",
        "success_action_status", "bucket", "acl", "key", "x-amz-signature",
        "x-amz-date", "x-amz-meta-ext", "policy", "x-amz-credential", "Content-Type",
      ];
  return {
    action: `//${hostname}`,
    fields: names.map((name) => ({ name, value: values[name] })),
  };
}

function videoPostThing(createdUtc = 1_800_000_000): unknown {
  return postThing({
    title: "Wrench native video verification",
    selftext: "Verification body",
    author: "wrench_viewer",
    author_fullname: SUBJECT.slice("reddit:".length),
    subreddit: "testingground4bots",
    created_utc: createdUtc,
    over_18: false,
    spoiler: false,
    is_video: true,
    post_hint: "hosted:video",
    domain: "v.redd.it",
    url: "https://v.redd.it/video123",
    permalink: "/r/testingground4bots/comments/abc123/wrench_native_video_verification/",
    media: {
      reddit_video: {
        duration: 8,
        fallback_url: "https://v.redd.it/video123/DASH_360.mp4?source=fallback",
        height: 360,
        is_gif: false,
        transcoding_status: "completed",
        width: 640,
      },
    },
  });
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "reddit",
    action,
    contractVersion: action === "media.publish" ? 9 : action === "media.read" ? 2 : 1,
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

  test("reads exact profile counts and a complete visible contribution window", async () => {
    const calls: CapturedRequest[] = [];
    let callbacks = 0;
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.pathname === "/api/me.json") return jsonResponse(viewerResponse());
      if (request.url.pathname === "/user/wrench_viewer/about.json") {
        expect(Object.fromEntries(request.url.searchParams)).toEqual({ raw_json: "1" });
        return jsonResponse(profileResponse());
      }
      expect(request.url.pathname).toBe("/user/wrench_viewer/overview.json");
      expect(request.url.searchParams.get("limit")).toBe("100");
      expect(request.url.searchParams.get("raw_json")).toBe("1");
      if (request.url.searchParams.get("after") === null) {
        return jsonResponse(listing([
          contributionThing("t3", "t3_first"),
          contributionThing("t1", "t1_second"),
        ], "t1_next"));
      }
      expect(request.url.searchParams.get("after")).toBe("t1_next");
      return jsonResponse(listing([
        contributionThing("t3", "t3_third"),
      ]));
    });
    const result = await executeRedditWebOperation(
      recipe("profiles.read"),
      { profile: "wrench_viewer" },
      redditAuth,
      {
        beforeDispatch: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        dependencies: {
          ...runtimeDependencies,
          now: () => Date.parse("2026-08-22T03:00:00.000Z"),
        },
      },
    );
    expect(result).toEqual({
      status: "succeeded",
      output: {
        schemaVersion: 1,
        provider: "reddit",
        target: {
          kind: "profile",
          id: "wrench_viewer",
          url: "https://www.reddit.com/user/wrench_viewer/",
        },
        observedAt: "2026-08-22T03:00:00.000Z",
        completeness: "complete",
        metrics: {
          followers: { status: "available", value: 8, precision: "exact", unit: "count" },
          karma: { status: "available", value: 4321, precision: "exact", unit: "count" },
          contributions: {
            status: "available",
            value: 3,
            precision: "exact",
            unit: "count",
            window: "visible-overview",
          },
        },
        metadata: {
          handle: "wrench_viewer",
          displayName: "Wrench Viewer",
          bio: "Public profile bio",
          contributionDefinition:
            "Distinct post and comment IDs in the complete authenticated profile overview listing.",
        },
      },
      finalUrl: "https://www.reddit.com/user/wrench_viewer/",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect(calls.map((request) => request.url.pathname)).toEqual([
      "/api/me.json",
      "/user/wrench_viewer/about.json",
      "/user/wrench_viewer/overview.json",
      "/user/wrench_viewer/overview.json",
    ]);
    expect(callbacks).toBe(0);
    expect(JSON.stringify(result)).not.toContain(VIEWER_ID);
    expect(JSON.stringify(result)).not.toContain(FIRST_MODHASH);
  });

  test("rejects a profile handle that does not match the bound viewer", async () => {
    const calls: CapturedRequest[] = [];
    expect(await executeRedditWebOperation(
      recipe("profiles.read"),
      { profile: "another_viewer" },
      redditAuth,
      {
        dependencies: dependencies(calls, () => jsonResponse(viewerResponse())),
      },
    )).toMatchObject({
      status: "failed",
      readFailure: {
        category: "account-mismatch",
        retryDisposition: "do-not-retry",
      },
    });
    expect(calls).toHaveLength(1);
  });

  test("bounds overview pagination and marks an unproven total unavailable", async () => {
    const calls: CapturedRequest[] = [];
    let page = 0;
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.pathname === "/api/me.json") return jsonResponse(viewerResponse());
      if (request.url.pathname.endsWith("/about.json")) return jsonResponse(profileResponse());
      const current = page;
      page += 1;
      return jsonResponse(listing([
        contributionThing("t1", `t1_item${current}`),
      ], `t1_cursor${current}`));
    });
    const result = await executeRedditWebOperation(
      recipe("profiles.read"),
      { profile: "wrench_viewer" },
      redditAuth,
      {
        dependencies: {
          ...runtimeDependencies,
          now: () => Date.parse("2026-08-22T03:00:00.000Z"),
        },
      },
    );
    expect(result.output).toMatchObject({
      completeness: "partial",
      metrics: {
        contributions: { status: "unavailable", reason: "not-exposed" },
      },
    });
    expect(page).toBe(10);
    expect(calls).toHaveLength(12);
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
      {
        action: "media.read",
        input: { post_id: POST_ID },
        expectedPath: "/api/info.json",
        response: listing([videoPostThing()]),
        verify: (output) => {
          expect(output).toEqual({
            provider: "reddit",
            operation: "media.read",
            post: {
              id: POST_ID,
              title: "Wrench native video verification",
              author: "wrench_viewer",
              subreddit: "testingground4bots",
              createdUtc: 1_800_000_000,
              permalink: "https://www.reddit.com/r/testingground4bots/comments/abc123/wrench_native_video_verification/",
            },
            media: {
              kind: "hosted-video",
              mediaType: "video/mp4",
              durationSeconds: 8,
              width: 640,
              height: 360,
              nsfw: false,
              spoiler: false,
              transcodingStatus: "completed",
            },
          });
          expect(JSON.stringify(output)).not.toContain("v.redd.it");
          expect(JSON.stringify(output)).not.toContain("source=fallback");
        },
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
            if (scenario.action === "media.read") {
              expect(request.url.searchParams.get("id")).toBe(POST_ID);
              expect(request.url.searchParams.get("raw_json")).toBe("1");
              expect([...request.url.searchParams.keys()].sort()).toEqual(["id", "raw_json"]);
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

  test("publishes one plan-bound native video and records the websocket-bound target before readback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrench-reddit-video-test-"));
    try {
      const videoPath = join(directory, "fixture.mp4");
      const posterPath = join(directory, "poster.png");
      const video = new Uint8Array(32);
      video.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
      const poster = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      await writeFile(videoPath, video);
      await writeFile(posterPath, poster);
      const calls: CapturedRequest[] = [];
      let leaseCount = 0;
      let s3Uploads = 0;
      let beforeDispatches = 0;
      let verifiedDispatches = 0;
      const acceptedTargets: unknown[] = [];
      const now = 1_800_000_000_000;
      const result = await executeRedditWebOperation(
        recipe("media.publish"),
        {
          community: "testingground4bots",
          title: "Wrench native video verification",
          body: "Verification body",
          media: { kind: "file", reference: "video" },
          thumbnail: { kind: "file", reference: "poster" },
          nsfw: false,
          spoiler: false,
          send_replies: true,
        },
        redditAuth,
        {
          fileResolver: (files) => {
            expect(files).toHaveLength(2);
            return Promise.resolve([videoPath, posterPath]);
          },
          dependencies: {
            ...dependencies(calls, (request) => {
              if (request.url.pathname === "/api/me.json") {
                return jsonResponse(viewerResponse());
              }
              if (
                request.url.pathname === "/api/video_upload_s3.json"
                || request.url.pathname === "/api/image_upload_s3.json"
              ) {
                expect(request.method).toBe("POST");
                expect(request.body).toBeString();
                const form = new URLSearchParams(request.body as string);
                expect(Object.fromEntries(form)).toEqual(leaseCount === 0
                  ? {
                      filepath: "wrench-video.mp4",
                      mimetype: "video/mp4",
                      raw_json: "1",
                    }
                  : {
                      filepath: "wrench-poster.png",
                      mimetype: "image/png",
                      raw_json: "1",
                    });
                expect(request.url.origin).toBe("https://old.reddit.com");
                expect(request.headers.get("referer")).toBe(
                  "https://old.reddit.com/r/testingground4bots/submit",
                );
                expect(request.headers.get("origin")).toBe("https://old.reddit.com");
                expect(request.headers.get("x-modhash")).toBe(FIRST_MODHASH);
                expect(request.headers.get("x-requested-with")).toBe("XMLHttpRequest");
                const response = leaseCount === 0
                  ? mediaLease("video/mp4")
                  : mediaLease("image/png");
                leaseCount += 1;
                return jsonResponse(response);
              }
              if (request.url.hostname.endsWith("amazonaws.com")) {
                expect(request.body).toBeInstanceOf(Uint8Array);
                expect(request.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
                expect(request.headers.has("cookie")).toBeFalse();
                s3Uploads += 1;
                const key = s3Uploads === 1
                  ? "rte_images/videoasset1.mp4"
                  : "rte_images/posterasset1.png";
                return new Response(null, {
                  status: 201,
                  headers: {
                    location: `https://${s3Uploads === 1 ? "reddit-uploaded-video" : "reddit-uploaded-media"}.s3.amazonaws.com/${key}`,
                  },
                });
              }
              if (request.url.pathname === "/api/submit") {
                expect(s3Uploads).toBe(2);
                expect(request.body).toBeString();
                const form = new URLSearchParams(request.body as string);
                expect(Object.fromEntries(form)).toMatchObject({
                  api_type: "json",
                  kind: "video",
                  nsfw: "false",
                  sendreplies: "true",
                  spoiler: "false",
                  sr: "testingground4bots",
                  title: "Wrench native video verification",
                  text: "Verification body",
                  validate_on_submit: "true",
                });
                expect(form.get("url")).toBe(
                  "https://reddit-uploaded-video.s3-accelerate.amazonaws.com/rte_images/videoasset1.mp4",
                );
                return jsonResponse({
                  json: {
                    errors: [],
                    data: {
                      websocket_url: `wss://ws-test.wss.redditmedia.com/rte_images/videoasset1?m=${"b".repeat(24)}`,
                    },
                  },
                });
              }
              if (request.url.pathname === "/api/info.json") {
                return jsonResponse(listing([videoPostThing(now / 1_000)]));
              }
              throw new Error(`unexpected test request ${request.url.origin}${request.url.pathname}`);
            }),
            now: () => now,
            sleep: () => Promise.resolve(),
            waitForWebSocketMessage: (url) => {
              expect(url).not.toContain("reddit_session");
              return Promise.resolve({
                payload: {
                  redirect: "https://www.reddit.com/r/testingground4bots/comments/abc123/wrench_native_video_verification/",
                },
              });
            },
          },
          beforeDispatch: (event) => {
            expect(event).toMatchObject({ id: "media.publish", index: 1 });
            expect(s3Uploads).toBe(2);
            beforeDispatches += 1;
            return Promise.resolve();
          },
          afterProviderAcceptedMutationTarget: (event) => {
            acceptedTargets.push(event);
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            verifiedDispatches += 1;
            return Promise.resolve();
          },
        },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        output: {
          postId: POST_ID,
          community: "testingground4bots",
          video: { durationSeconds: 8, width: 640, height: 360 },
        },
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
      expect(beforeDispatches).toBe(1);
      expect(verifiedDispatches).toBe(1);
      expect(acceptedTargets).toEqual([{
        id: "media.publish",
        index: 1,
        target: { schemaVersion: 1, identifier: `{"postId":"${POST_ID}"}` },
      }]);
      expect(calls.filter((call) => call.url.pathname === "/api/submit")).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("deletes only the exact confirmed authored post and verifies absence", async () => {
    const calls: CapturedRequest[] = [];
    let presenceReads = 0;
    let beforeDispatches = 0;
    let verifiedDispatches = 0;
    const result = await executeRedditWebOperation(
      recipe("content.delete"),
      { post_id: POST_ID, expected_title: "Runtime post" },
      redditAuth,
      {
        dependencies: {
          ...dependencies(calls, (request) => {
            if (request.url.pathname === "/api/me.json") {
              return jsonResponse(viewerResponse());
            }
            if (request.url.pathname === "/api/info.json") {
              presenceReads += 1;
              return jsonResponse(presenceReads < 3
                ? listing([postThing({
                    author: "wrench_viewer",
                    author_fullname: SUBJECT.slice("reddit:".length),
                  })])
                : listing([]));
            }
            if (request.url.pathname === "/api/del") {
              expect(request.method).toBe("POST");
              expect(request.body).toBeString();
              expect(Object.fromEntries(new URLSearchParams(request.body as string))).toEqual({
                id: POST_ID,
                uh: FIRST_MODHASH,
              });
              return jsonResponse({});
            }
            throw new Error(`unexpected test request ${request.url.pathname}`);
          }),
          sleep: () => Promise.resolve(),
        },
        beforeDispatch: () => {
          beforeDispatches += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          verifiedDispatches += 1;
          return Promise.resolve();
        },
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: { postId: POST_ID, deleted: true, noOp: false },
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(beforeDispatches).toBe(1);
    expect(verifiedDispatches).toBe(1);
    expect(calls.filter((call) => call.url.pathname === "/api/del")).toHaveLength(1);
  });

  test("reconciles exact Reddit publish presence and delete absence without mutation", async () => {
    const publishedCalls: CapturedRequest[] = [];
    const published = await readRedditWebPublishedMutationTarget(
      recipe("media.publish"),
      {
        community: "testingground4bots",
        title: "Wrench native video verification",
        body: "Verification body",
        nsfw: false,
        spoiler: false,
        send_replies: true,
      },
      redditAuth,
      `{"postId":"${POST_ID}"}`,
      {
        dependencies: {
          ...dependencies(publishedCalls, (request) => request.url.pathname === "/api/me.json"
            ? jsonResponse(viewerResponse())
            : jsonResponse(listing([videoPostThing()]))),
          now: () => 1_800_000_000_000,
        },
      },
    );
    expect(published).toEqual({ present: true, postId: POST_ID });
    expect(publishedCalls.every((call) => call.method === "GET")).toBeTrue();

    const deleteCalls: CapturedRequest[] = [];
    const deleted = await readRedditWebContentDeleteDesiredState(
      recipe("content.delete"),
      { post_id: POST_ID, expected_title: "Runtime post" },
      redditAuth,
      {
        dependencies: dependencies(deleteCalls, (request) => request.url.pathname === "/api/me.json"
          ? jsonResponse(viewerResponse())
          : jsonResponse(listing([]))),
      },
    );
    expect(deleted).toEqual({ present: false, postId: POST_ID });
    expect(deleteCalls.every((call) => call.method === "GET")).toBeTrue();
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
