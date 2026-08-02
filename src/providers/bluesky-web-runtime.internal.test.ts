import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type {
  createBrowserSession,
  BrowserSession,
} from "../browser";
import { canonicalJson, type OperationInput, type WebSessionRecipe } from "../model";
import { OperationDeadline } from "../operation-deadline";
import {
  executeBlueskyWebOperation,
  probeBlueskyWebSubject,
  readBlueskyWebDesiredState,
  type BlueskyWebRuntimeDependencies,
} from "./bluesky-web-runtime";

const VIEWER_DID = `did:plc:${"a".repeat(24)}`;
const AUTHOR_DID = `did:plc:${"b".repeat(24)}`;
const POST_URI = `at://${AUTHOR_DID}/app.bsky.feed.post/3lsynthetic`;
const PDS_ORIGIN = "https://morel.us-east.host.bsky.network";
function token(exp: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "ES256K", typ: "JWT" })}.${encode({
    aud: "did:web:bsky.social",
    exp,
    sub: VIEWER_DID,
  })}.synthetic-private-signature`;
}
const ACCESS_TOKEN = token(4_000_000_000);
const REFRESH_TOKEN = token(5_000_000_000);

const blueskyAuth = {
  schemaVersion: 1,
  id: "bluesky-test",
  kind: "browser-profile",
  profile: "Arc Default",
  browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  trustUnfilteredEgress: true,
  subject: VIEWER_DID,
} as const satisfies WrenchAuth;

const unboundBlueskyAuth = {
  schemaVersion: 1,
  id: "bluesky-probe",
  kind: "browser-profile",
  profile: "Arc Default",
  browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  trustUnfilteredEgress: true,
  cookieSource: "chromium",
  cookieProfile: "/private/chromium/Default",
} as const satisfies WrenchAuth;

const unsupportedCookieAuth = {
  schemaVersion: 1,
  id: "bluesky-cookie-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: VIEWER_DID,
} as const satisfies WrenchAuth;

type CapturedRequest = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: RequestInit["body"];
  readonly redirect: RequestInit["redirect"];
};

type CompleteDependencies = BlueskyWebRuntimeDependencies & {
  readonly fetch: typeof globalThis.fetch;
  readonly bootstrapAccount: NonNullable<
    BlueskyWebRuntimeDependencies["bootstrapAccount"]
  >;
};

function bootstrapAccount(
  accessJwt = ACCESS_TOKEN,
  refreshJwt = REFRESH_TOKEN,
): unknown {
  return {
    did: VIEWER_DID,
    handle: "viewer.test",
    accessJwt,
    refreshJwt,
    service: "https://bsky.social",
    pdsUrl: PDS_ORIGIN,
  };
}

function sessionResponse(did = VIEWER_DID): unknown {
  return {
    did,
    handle: did === VIEWER_DID ? "viewer.test" : "other.test",
    active: true,
  };
}

function postView(
  viewer: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    uri: POST_URI,
    cid: `b${"a".repeat(40)}`,
    author: {
      did: AUTHOR_DID,
      handle: "author.test",
      displayName: "Synthetic author",
    },
    record: {
      $type: "app.bsky.feed.post",
      text: "Synthetic post",
      createdAt: "2026-07-23T12:00:00.000Z",
    },
    indexedAt: "2026-07-23T12:00:01.000Z",
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    quoteCount: 0,
    viewer,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requestUrl(value: string | URL | Request): URL {
  return new URL(
    typeof value === "string"
      ? value
      : value instanceof URL
        ? value.href
        : value.url,
  );
}

function dependencies(
  calls: CapturedRequest[],
  handler: (request: CapturedRequest) => Response | Promise<Response>,
): CompleteDependencies {
  const fetch = (async (
    value: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const request: CapturedRequest = {
      url: requestUrl(value),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body,
      redirect: init.redirect,
    };
    calls.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return {
    bootstrapAccount: () => Promise.resolve(bootstrapAccount()),
    fetch,
    now: () => 2_000_000_000_000,
  };
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "bluesky",
    action,
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 8 * 1024 * 1024,
  };
}

function nsid(request: CapturedRequest): string {
  return request.url.pathname.replace("/xrpc/", "");
}

function assertBaseRequest(request: CapturedRequest): void {
  expect(request.url.origin).toBe(PDS_ORIGIN);
  expect(request.method).toBe("GET");
  expect(request.redirect).toBe("error");
  expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request.url.href).not.toContain(ACCESS_TOKEN);
  expect(request.body).toBeUndefined();
}

describe("Bluesky authenticated XRPC runtime", () => {
  test("matches the browser-profile-only binding before any bootstrap seam runs", () => {
    let bootstraps = 0;
    let fetches = 0;
    expect(probeBlueskyWebSubject(unsupportedCookieAuth, {
      dependencies: {
        bootstrapAccount: () => {
          bootstraps += 1;
          return Promise.resolve(bootstrapAccount());
        },
        fetch: () => {
          fetches += 1;
          return Promise.resolve(jsonResponse(sessionResponse()));
        },
      },
    })).rejects.toThrow("requires browser-profile auth");
    expect(bootstraps).toBe(0);
    expect(fetches).toBe(0);
  });

  test("uses a sealed browser-only storage bootstrap and then probes getSession over direct XRPC", async () => {
    const batches: (readonly (readonly string[])[])[] = [];
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: (commands) => {
        batches.push(commands);
        const command = commands[0]?.[0];
        if (command === "open") {
          return Promise.resolve([{ success: true, result: { url: "https://bsky.app/robots.txt" } }]);
        }
        if (command === "get") {
          return Promise.resolve([{ success: true, result: { url: "https://bsky.app/robots.txt" } }]);
        }
        if (command === "eval") {
          return Promise.resolve([{
            success: true,
            result: {
              origin: "https://bsky.app/robots.txt",
              result: bootstrapAccount(),
            },
          }]);
        }
        throw new Error(`unexpected browser bootstrap command ${command ?? "missing"}`);
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      cleanup: () => {
        cleaned = true;
        return Promise.resolve();
      },
    };
    const createSession: typeof createBrowserSession = (_manifest, auth, options) => {
      expect(auth).toEqual({
        schemaVersion: 1,
        id: "bluesky-probe",
        kind: "browser-profile",
        profile: "Arc Default",
        browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        trustUnfilteredEgress: true,
      });
      expect(options.allowCodeOwnedEvaluation).toBe(true);
      expect(options.headed).toBe(false);
      return Promise.resolve(session);
    };
    const calls: CapturedRequest[] = [];
    const subject = await probeBlueskyWebSubject(unboundBlueskyAuth, {
      dependencies: {
        createBrowserSession: createSession,
        now: () => 2_000_000_000_000,
        fetch: dependencies(calls, (request) => {
          assertBaseRequest(request);
          expect(nsid(request)).toBe("com.atproto.server.getSession");
          return jsonResponse(sessionResponse());
        }).fetch,
      },
    });
    expect(subject).toBe(VIEWER_DID);
    expect(closed).toBe(true);
    expect(cleaned).toBe(true);
    expect(batches.map((batch) => batch[0]?.[0])).toEqual(["open", "get", "eval"]);
    const evaluation = batches[2]?.[0]?.[1] ?? "";
    expect(evaluation).toContain('localStorage.getItem("BSKY_STORAGE")');
    expect(evaluation).toContain("currentAccount");
    expect(evaluation).toContain("accessJwt");
    expect(evaluation).not.toContain(ACCESS_TOKEN);
    expect(batches.flat(2)).not.toContain("click");
    expect(batches.flat(2)).not.toContain("fill");
  });

  test("passes the shared operation deadline into browser setup and batches", async () => {
    const operationDeadline = new OperationDeadline(1_000);
    const calls: CapturedRequest[] = [];
    let seenDeadline: unknown;
    let closed = false;
    let cleaned = false;
    const cleanupBarriers: Promise<void>[] = [];
    const cleanupResourcePublisher = () => undefined;
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0]?.[0];
        if (command === "open" || command === "get") {
          return Promise.resolve([{
            success: true,
            result: { url: "https://bsky.app/robots.txt" },
          }]);
        }
        if (command === "eval") {
          return Promise.resolve([{
            success: true,
            result: {
              origin: "https://bsky.app/robots.txt",
              result: bootstrapAccount(),
            },
          }]);
        }
        throw new Error(`unexpected browser bootstrap command ${command ?? "missing"}`);
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      cleanup: () => {
        cleaned = true;
        return Promise.resolve();
      },
    };
    const fetch = dependencies(calls, (request) => {
      if (nsid(request) === "com.atproto.server.getSession") {
        return jsonResponse(sessionResponse());
      }
      if (nsid(request) === "app.bsky.feed.getTimeline") {
        return jsonResponse({ feed: [{ post: postView() }] });
      }
      throw new Error(`unexpected XRPC method ${nsid(request)}`);
    }).fetch;
    try {
      const result = await executeBlueskyWebOperation(
        recipe("feeds.read"),
        { feed: "home", limit: 1 },
        blueskyAuth,
        {
          operationDeadline,
          registerCleanupBarrier: (barrier) => {
            cleanupBarriers.push(barrier);
            return cleanupResourcePublisher;
          },
          dependencies: {
            createBrowserSession: (_manifest, _auth, options) => {
              seenDeadline = options.operationDeadline;
              expect(options.publishCleanupResource).toBe(
                cleanupResourcePublisher,
              );
              return Promise.resolve(session);
            },
            loadCachedSession: () => ({
              value: null,
              contentSha256: null,
            }),
            saveCachedSession: () => ({
              written: true,
              contentSha256: "a".repeat(64),
            }),
            now: () => 2_000_000_000_000,
            fetch,
          },
        },
      );

      expect(result.status).toBe("succeeded");
      expect(seenDeadline).toBe(operationDeadline);
      expect(closed).toBeTrue();
      expect(cleaned).toBeTrue();
      expect(cleanupBarriers).toHaveLength(1);
      await Promise.all(cleanupBarriers);
    } finally {
      operationDeadline.dispose();
    }
  });

  test("fails a live subject probe when getSession does not match the browser account", () => {
    const calls: CapturedRequest[] = [];
    const otherDid = `did:plc:${"c".repeat(24)}`;
    expect(probeBlueskyWebSubject(unboundBlueskyAuth, {
      dependencies: dependencies(
        calls,
        () => jsonResponse(sessionResponse(otherDid)),
      ),
    })).rejects.toThrow("session did not match");
    expect(calls.map(nsid)).toEqual(["com.atproto.server.getSession"]);
  });

  test("rejects a pre-aborted subject probe before browser bootstrap starts", () => {
    const controller = new AbortController();
    controller.abort();
    let bootstrapCalls = 0;

    expect(probeBlueskyWebSubject(unboundBlueskyAuth, {
      signal: controller.signal,
      dependencies: {
        bootstrapAccount: () => {
          bootstrapCalls += 1;
          return Promise.resolve(bootstrapAccount());
        },
      },
    })).rejects.toThrow("was cancelled");
    expect(bootstrapCalls).toBe(0);
  });

  test("rotates an expired browser token through refreshSession and encryptable cache material", async () => {
    const calls: CapturedRequest[] = [];
    let saved: unknown = null;
    const rotatedAccess = token(4_100_000_000);
    const rotatedRefresh = token(5_100_000_000);
    const subject = await probeBlueskyWebSubject(blueskyAuth, {
      dependencies: {
        bootstrapAccount: () =>
          Promise.resolve(bootstrapAccount(token(1_999_999_999), REFRESH_TOKEN)),
        loadCachedSession: () => ({
          value: null,
          contentSha256: null,
        }),
        saveCachedSession: (_auth, authHash, value, expectedContentSha256) => {
          expect(authHash).toMatch(/^[a-f0-9]{64}$/u);
          expect(expectedContentSha256).toBeNull();
          saved = value;
          return {
            written: true,
            contentSha256: "a".repeat(64),
          };
        },
        now: () => 2_000_000_000_000,
        fetch: dependencies(calls, (request) => {
          if (nsid(request) === "com.atproto.server.refreshSession") {
            expect(request.method).toBe("POST");
            expect(request.headers.get("authorization")).toBe(`Bearer ${REFRESH_TOKEN}`);
            expect(request.body).toBeUndefined();
            return jsonResponse({
              did: VIEWER_DID,
              handle: "viewer.test",
              accessJwt: rotatedAccess,
              refreshJwt: rotatedRefresh,
              active: true,
            });
          }
          expect(request.headers.get("authorization")).toBe(`Bearer ${rotatedAccess}`);
          return jsonResponse(sessionResponse());
        }).fetch,
      },
    });
    expect(subject).toBe(VIEWER_DID);
    expect(calls.map(nsid)).toEqual([
      "com.atproto.server.refreshSession",
      "com.atproto.server.getSession",
    ]);
    expect(saved).toEqual({
      did: VIEWER_DID,
      handle: "viewer.test",
      accessJwt: rotatedAccess,
      refreshJwt: rotatedRefresh,
      service: PDS_ORIGIN,
      pdsUrl: PDS_ORIGIN,
    });
  });

  test("adopts a concurrently persisted newer same-account session without overwriting it", async () => {
    const expiredAccess = token(1_999_999_999);
    const fasterAccess = token(4_200_000_000);
    const fasterRefresh = token(5_200_000_000);
    const slowerAccess = token(4_100_000_000);
    const slowerRefresh = token(5_100_000_000);
    let persisted = {
      value: null as unknown,
      contentSha256: null as string | null,
    };
    let revision = 0;
    let initialLoads = 0;
    let releaseInitialLoads: () => void = () => undefined;
    const initialLoadsComplete = new Promise<void>((resolve) => {
      releaseInitialLoads = resolve;
    });
    let releaseFasterSave: () => void = () => undefined;
    const fasterSaved = new Promise<void>((resolve) => {
      releaseFasterSave = resolve;
    });
    const loadCachedSession: NonNullable<
      BlueskyWebRuntimeDependencies["loadCachedSession"]
    > = async () => {
      initialLoads += 1;
      if (initialLoads === 2) releaseInitialLoads();
      await initialLoadsComplete;
      return persisted;
    };
    const saveCachedSession: NonNullable<
      BlueskyWebRuntimeDependencies["saveCachedSession"]
    > = (_auth, _authHash, value, expectedContentSha256) => {
      if (expectedContentSha256 !== persisted.contentSha256) {
        return { written: false };
      }
      revision += 1;
      const contentSha256 = revision.toString(16).padStart(64, "0");
      persisted = { value, contentSha256 };
      const saved = value !== null && typeof value === "object"
        && !Array.isArray(value)
        ? value
        : null;
      if (saved !== null && "accessJwt" in saved && saved.accessJwt === fasterAccess) {
        releaseFasterSave();
      }
      return { written: true, contentSha256 };
    };
    const observedAuthorization = {
      faster: [] as string[],
      slower: [] as string[],
    };
    const concurrentDependencies = (
      kind: "faster" | "slower",
    ): BlueskyWebRuntimeDependencies => ({
      bootstrapAccount: () =>
        Promise.resolve(bootstrapAccount(expiredAccess, REFRESH_TOKEN)),
      loadCachedSession,
      saveCachedSession,
      now: () => 2_000_000_000_000,
      fetch: async (value, init = {}) => {
        const request = {
          url: requestUrl(value),
          method: init.method ?? "GET",
          headers: new Headers(init.headers),
          body: init.body,
          redirect: init.redirect,
        } satisfies CapturedRequest;
        observedAuthorization[kind].push(
          request.headers.get("authorization") ?? "",
        );
        if (nsid(request) === "com.atproto.server.refreshSession") {
          if (kind === "slower") await fasterSaved;
          return jsonResponse({
            did: VIEWER_DID,
            handle: "viewer.test",
            accessJwt: kind === "faster" ? fasterAccess : slowerAccess,
            refreshJwt: kind === "faster" ? fasterRefresh : slowerRefresh,
            active: true,
          });
        }
        expect(nsid(request)).toBe("com.atproto.server.getSession");
        return jsonResponse(sessionResponse());
      },
    });

    const subjects = await Promise.all([
      probeBlueskyWebSubject(blueskyAuth, {
        dependencies: concurrentDependencies("faster"),
      }),
      probeBlueskyWebSubject(blueskyAuth, {
        dependencies: concurrentDependencies("slower"),
      }),
    ]);
    expect(subjects).toEqual([VIEWER_DID, VIEWER_DID]);
    expect(observedAuthorization.faster).toEqual([
      `Bearer ${REFRESH_TOKEN}`,
      `Bearer ${fasterAccess}`,
    ]);
    expect(observedAuthorization.slower).toEqual([
      `Bearer ${REFRESH_TOKEN}`,
      `Bearer ${fasterAccess}`,
    ]);
    expect(persisted.value).toEqual({
      did: VIEWER_DID,
      handle: "viewer.test",
      accessJwt: fasterAccess,
      refreshJwt: fasterRefresh,
      service: PDS_ORIGIN,
      pdsUrl: PDS_ORIGIN,
    });
    expect(canonicalJson(persisted.value)).not.toContain(slowerAccess);
    expect(canonicalJson(persisted.value)).not.toContain(slowerRefresh);
  });

  test("fails closed when a conflicting cached session is not provably newer", async () => {
    const attemptedAccess = token(4_200_000_000);
    const attemptedRefresh = token(5_200_000_000);
    const olderAccess = token(4_100_000_000);
    const olderRefresh = token(5_100_000_000);
    let loads = 0;
    let requests = 0;
    const action = probeBlueskyWebSubject(blueskyAuth, {
      dependencies: {
        bootstrapAccount: () =>
          Promise.resolve(bootstrapAccount(
            token(1_999_999_999),
            REFRESH_TOKEN,
          )),
        loadCachedSession: () => {
          loads += 1;
          return loads === 1
            ? { value: null, contentSha256: null }
            : {
              value: bootstrapAccount(olderAccess, olderRefresh),
              contentSha256: "b".repeat(64),
            };
        },
        saveCachedSession: () => ({ written: false }),
        now: () => 2_000_000_000_000,
        fetch: () => {
          requests += 1;
          if (requests !== 1) {
            throw new Error("unsafe conflicting Bluesky session reached validation");
          }
          return Promise.resolve(jsonResponse({
            did: VIEWER_DID,
            handle: "viewer.test",
            accessJwt: attemptedAccess,
            refreshJwt: attemptedRefresh,
            active: true,
          }));
        },
      },
    });
    let message = "";
    try {
      await action;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("without a safe newer session");
    expect(message).not.toContain(attemptedAccess);
    expect(message).not.toContain(attemptedRefresh);
    expect(message).not.toContain(olderAccess);
    expect(message).not.toContain(olderRefresh);
    expect(loads).toBe(2);
    expect(requests).toBe(1);
  });

  test("executes every live-proven read through fixed XRPC procedures without dispatch", async () => {
    const calls: CapturedRequest[] = [];
    const deps = dependencies(calls, (request) => {
      const method = nsid(request);
      if (method === "com.atproto.server.getSession") {
        return jsonResponse(sessionResponse());
      }
      if (method === "app.bsky.feed.getTimeline") {
        return jsonResponse({ feed: [{ post: postView() }] });
      }
      if (method === "app.bsky.feed.getPosts") {
        return jsonResponse({ posts: [postView()] });
      }
      if (method === "app.bsky.feed.getPostThread") {
        return jsonResponse({ thread: { post: postView(), replies: [] } });
      }
      throw new Error(`unexpected XRPC method ${method}`);
    });
    const inputs = [
      ["feeds.read", { feed: "home", limit: 1 }],
      ["posts.read", { post_uri: POST_URI }],
      ["comments.read", { post_uri: POST_URI, limit: 1 }],
      ["media.read", { post_uri: POST_URI }],
    ] as const;
    for (const [action, input] of inputs) {
      const result = await executeBlueskyWebOperation(
        recipe(action),
        input,
        blueskyAuth,
        { dependencies: deps },
      );
      expect(result.status).toBe("succeeded");
      expect(result.dispatchStarted).toBe(false);
      expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
    }
    expect(calls.map(nsid)).toEqual([
      "com.atproto.server.getSession",
      "app.bsky.feed.getTimeline",
      "com.atproto.server.getSession",
      "app.bsky.feed.getPosts",
      "com.atproto.server.getSession",
      "app.bsky.feed.getPostThread",
      "com.atproto.server.getSession",
      "app.bsky.feed.getPosts",
    ]);
  });

  test("reads all four exact desired states through account-bound XRPC without mutation", async () => {
    const calls: CapturedRequest[] = [];
    const likeUri = `at://${VIEWER_DID}/app.bsky.feed.like/3llike`;
    const followUri = `at://${VIEWER_DID}/app.bsky.graph.follow/3lfollow`;
    const deps = dependencies(calls, (request) => {
      const method = nsid(request);
      if (method === "com.atproto.server.getSession") {
        return jsonResponse(sessionResponse());
      }
      if (method === "app.bsky.feed.getPosts") {
        return jsonResponse({
          posts: [postView({
            like: likeUri,
            bookmarked: true,
          })],
        });
      }
      if (method === "app.bsky.actor.getProfile") {
        return jsonResponse({
          did: AUTHOR_DID,
          handle: "author.test",
          viewer: { following: followUri },
        });
      }
      throw new Error(`unexpected desired-state XRPC method ${method}`);
    });
    expect(await readBlueskyWebDesiredState(
      recipe("likes.set"),
      { post_uri: POST_URI, liked: true },
      blueskyAuth,
      { dependencies: deps },
    )).toEqual({ kind: "like", enabled: true, postUri: POST_URI });
    expect(await readBlueskyWebDesiredState(
      recipe("content.save"),
      { post_uri: POST_URI, saved: true },
      blueskyAuth,
      { dependencies: deps },
    )).toEqual({ kind: "bookmark", enabled: true, postUri: POST_URI });
    expect(await readBlueskyWebDesiredState(
      recipe("posts.repost"),
      { post_uri: POST_URI, reposted: false },
      blueskyAuth,
      { dependencies: deps },
    )).toEqual({ kind: "repost", enabled: false, postUri: POST_URI });
    expect(await readBlueskyWebDesiredState(
      recipe("relationships.follow.set"),
      { actor_did: AUTHOR_DID, followed: true },
      blueskyAuth,
      { dependencies: deps },
    )).toEqual({ kind: "follow", enabled: true, actorDid: AUTHOR_DID });
    expect(calls).toHaveLength(8);
    expect(calls.every((request) => request.method === "GET")).toBeTrue();
    expect(calls.map(nsid)).toEqual([
      "com.atproto.server.getSession",
      "app.bsky.feed.getPosts",
      "com.atproto.server.getSession",
      "app.bsky.feed.getPosts",
      "com.atproto.server.getSession",
      "app.bsky.feed.getPosts",
      "com.atproto.server.getSession",
      "app.bsky.actor.getProfile",
    ]);
  });

  test("all unproven operations acquire no session and dispatch nothing", () => {
    const inputs: Readonly<
      Partial<Record<WebSessionRecipe["action"], OperationInput>>
    > = {
      "messaging.list": {},
      "messaging.read": { convo_id: "convo-1" },
      "likes.set": { post_uri: POST_URI, liked: true },
      "content.save": { post_uri: POST_URI, saved: true },
      "relationships.follow.set": { actor_did: AUTHOR_DID, followed: true },
      "posts.repost": { post_uri: POST_URI, reposted: true },
      "posts.publish": { body: "No dispatch" },
      "replies.create": { post_uri: POST_URI, body: "No dispatch" },
      "posts.quote": { post_uri: POST_URI, body: "No dispatch" },
      "threads.publish": { items: ["No dispatch"] },
      "messaging.send": { convo_id: "convo-1", body: "No dispatch" },
      "content.share": { post_uri: POST_URI },
    };
    for (const [action, input] of Object.entries(inputs)) {
      if (input === undefined) {
        throw new Error(`missing capture-required input fixture for ${action}`);
      }
      let bootstraps = 0;
      let fetches = 0;
      const dependencies: BlueskyWebRuntimeDependencies = {
        bootstrapAccount: () => {
          bootstraps += 1;
          return Promise.resolve(bootstrapAccount());
        },
        fetch: () => {
          fetches += 1;
          return Promise.resolve(jsonResponse({}));
        },
      };
      expect(executeBlueskyWebOperation(
        recipe(action),
        input,
        blueskyAuth,
        { dependencies },
      )).rejects.toThrow("capture-required");
      expect(bootstraps).toBe(0);
      expect(fetches).toBe(0);
    }
  });
});
