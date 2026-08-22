import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WrenchAuth } from "../auth";
import type {
  createBrowserSession,
  BrowserSession,
} from "../browser";
import { canonicalJson, type OperationInput, type WebSessionRecipe } from "../model";
import { OperationDeadline } from "../operation-deadline";
import { BLUESKY_APPVIEW_PROXY } from "./bluesky-web";
import {
  executeBlueskyWebOperation,
  probeBlueskyWebSubject,
  readBlueskyWebContentDeleteDesiredState,
  readBlueskyWebDesiredState,
  readBlueskyWebPublishedMutationTarget,
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

function jsonErrorResponse(value: unknown, status = 400): Response {
  return new Response(JSON.stringify(value), {
    status,
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
    sleep: () => Promise.resolve(),
  };
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "bluesky",
    action,
    contractVersion: action === "posts.publish" ? 3 : 1,
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
      if (method === "app.bsky.actor.getProfile") {
        expect(request.url.origin).toBe("https://public.api.bsky.app");
        expect(request.url.searchParams.get("actor")).toBe("hraness.bsky.social");
        return jsonResponse({
          did: AUTHOR_DID,
          handle: "hraness.bsky.social",
          displayName: "Hraness",
          description: "Public bio",
          followersCount: 1234,
          followsCount: 56,
          postsCount: 789,
        });
      }
      throw new Error(`unexpected XRPC method ${method}`);
    });
    const inputs = [
      ["profiles.read", { handle: "hraness.bsky.social" }],
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
      if (action === "profiles.read") {
        expect(result.output).toMatchObject({
          provider: "bluesky",
          target: {
            id: AUTHOR_DID,
            url: "https://bsky.app/profile/hraness.bsky.social",
          },
          metrics: {
            followers: { value: 1234, precision: "exact" },
            following: { value: 56, precision: "exact" },
            posts: { value: 789, precision: "exact" },
          },
        });
      }
    }
    expect(calls.map(nsid)).toEqual([
      "app.bsky.actor.getProfile",
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

  test("deletes only the exact current-account post revision and proves authoritative absence", async () => {
    const postUri = `at://${VIEWER_DID}/app.bsky.feed.post/3ldelete`;
    const expectedCid = `b${"e".repeat(40)}`;
    const calls: CapturedRequest[] = [];
    const events: string[] = [];
    let recordReads = 0;
    const deps = dependencies(calls, (request) => {
      events.push(`${request.method} ${nsid(request)}`);
      if (nsid(request) === "com.atproto.server.getSession") {
        return jsonResponse(sessionResponse());
      }
      if (nsid(request) === "com.atproto.repo.getRecord") {
        recordReads += 1;
        expect(Object.fromEntries(request.url.searchParams)).toEqual({
          repo: VIEWER_DID,
          collection: "app.bsky.feed.post",
          rkey: "3ldelete",
        });
        return recordReads === 1
          ? jsonResponse({
              uri: postUri,
              cid: expectedCid,
              value: {
                $type: "app.bsky.feed.post",
                text: "delete me",
                createdAt: "2026-08-19T12:00:00.000Z",
              },
            })
          : jsonErrorResponse({
              error: "RecordNotFound",
              message: "Could not locate record",
            });
      }
      if (nsid(request) === "com.atproto.repo.deleteRecord") {
        expect(request.method).toBe("POST");
        expect(JSON.parse(String(request.body))).toEqual({
          repo: VIEWER_DID,
          collection: "app.bsky.feed.post",
          rkey: "3ldelete",
          swapRecord: expectedCid,
        });
        return jsonResponse({
          commit: {
            cid: `b${"f".repeat(40)}`,
            rev: "3m4abcde234fg",
          },
        });
      }
      throw new Error(`unexpected deletion XRPC method ${nsid(request)}`);
    });
    const result = await executeBlueskyWebOperation(
      recipe("content.delete"),
      { post_uri: postUri, expected_cid: expectedCid },
      blueskyAuth,
      {
        beforeDispatch: (event) => {
          events.push(`before ${event.progress.started}`);
          return Promise.resolve();
        },
        afterDispatchVerified: (event) => {
          events.push(`after ${event.progress.verified}`);
          return Promise.resolve();
        },
        dependencies: deps,
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
      output: {
        postUri,
        expectedCid,
        deleted: true,
        effect: "deleted",
      },
    });
    expect(events).toEqual([
      "GET com.atproto.server.getSession",
      "GET com.atproto.repo.getRecord",
      "GET com.atproto.server.getSession",
      "before 0",
      "POST com.atproto.repo.deleteRecord",
      "GET com.atproto.repo.getRecord",
      "after 1",
    ]);
  });

  test("reconciles deletion through read-only authoritative absence and fails closed on revision drift", async () => {
    const postUri = `at://${VIEWER_DID}/app.bsky.feed.post/3ldelete`;
    const expectedCid = `b${"e".repeat(40)}`;
    const absentCalls: CapturedRequest[] = [];
    expect(await readBlueskyWebContentDeleteDesiredState(
      recipe("content.delete"),
      { post_uri: postUri, expected_cid: expectedCid },
      blueskyAuth,
      {
        dependencies: dependencies(absentCalls, (request) =>
          nsid(request) === "com.atproto.server.getSession"
            ? jsonResponse(sessionResponse())
            : jsonErrorResponse({
                error: "RecordNotFound",
                message: "Could not locate record",
              })
        ),
      },
    )).toEqual({ present: false, postUri });
    expect(absentCalls.every((request) => request.method === "GET")).toBeTrue();

    const driftCalls: CapturedRequest[] = [];
    const result = await executeBlueskyWebOperation(
      recipe("content.delete"),
      { post_uri: postUri, expected_cid: expectedCid },
      blueskyAuth,
      {
        dependencies: dependencies(driftCalls, (request) =>
          nsid(request) === "com.atproto.server.getSession"
            ? jsonResponse(sessionResponse())
            : jsonResponse({
                uri: postUri,
                cid: `b${"f".repeat(40)}`,
                value: { $type: "app.bsky.feed.post" },
              })
        ),
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
    });
    expect(driftCalls.every((request) => request.method === "GET")).toBeTrue();
  });

  test("treats authoritative prior absence as a no-op and malformed post-dispatch responses as indeterminate", async () => {
    const postUri = `at://${VIEWER_DID}/app.bsky.feed.post/3ldelete`;
    const expectedCid = `b${"e".repeat(40)}`;
    const absentCalls: CapturedRequest[] = [];
    const absent = await executeBlueskyWebOperation(
      recipe("content.delete"),
      { post_uri: postUri, expected_cid: expectedCid },
      blueskyAuth,
      {
        dependencies: dependencies(absentCalls, (request) =>
          nsid(request) === "com.atproto.server.getSession"
            ? jsonResponse(sessionResponse())
            : jsonErrorResponse({
                error: "RecordNotFound",
                message: "Could not locate record",
              })
        ),
      },
    );
    expect(absent).toMatchObject({
      status: "succeeded",
      noOp: true,
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
      output: { deleted: true, effect: "already-absent" },
    });
    expect(absentCalls.map(nsid)).toEqual([
      "com.atproto.server.getSession",
      "com.atproto.repo.getRecord",
    ]);

    const malformedCalls: CapturedRequest[] = [];
    const malformed = await executeBlueskyWebOperation(
      recipe("content.delete"),
      { post_uri: postUri, expected_cid: expectedCid },
      blueskyAuth,
      {
        dependencies: dependencies(malformedCalls, (request) => {
          if (nsid(request) === "com.atproto.server.getSession") {
            return jsonResponse(sessionResponse());
          }
          if (nsid(request) === "com.atproto.repo.getRecord") {
            return jsonResponse({
              uri: postUri,
              cid: expectedCid,
              value: { $type: "app.bsky.feed.post" },
            });
          }
          return jsonResponse({ deleted: true });
        }),
      },
    );
    expect(malformed).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
    });
    expect(malformed.error).toContain("failure stage: delete response");
  });

  test("uploads one plan-bound PNG, creates one post, and independently binds its exact readback", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-bluesky-publish-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    writeFileSync(imagePath, imageBytes, { mode: 0o600 });
    const text = "Exact published text";
    const alt = "Exact factual alt text";
    const createdAt = new Date(2_000_000_000_000).toISOString();
    const createdUri = `at://${VIEWER_DID}/app.bsky.feed.post/3lpublishedfixture`;
    const createdCid = `b${"c".repeat(40)}`;
    const blobCid = `b${"d".repeat(40)}`;
    const expectedRecord = {
      $type: "app.bsky.feed.post",
      text,
      createdAt,
      embed: {
        $type: "app.bsky.embed.images",
        images: [{
          image: {
            $type: "blob",
            ref: { $link: blobCid },
            mimeType: "image/png",
            size: imageBytes.byteLength,
          },
          alt,
        }],
      },
    };
    const calls: CapturedRequest[] = [];
    const events: string[] = [];
    const accepted: unknown[] = [];
    try {
      const result = await executeBlueskyWebOperation(
        recipe("posts.publish"),
        {
          body: text,
          media: { kind: "file", reference: "fixture" },
          media_type: "image/png",
          alt,
        },
        blueskyAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          beforeDispatch: (event) => {
            events.push(`before ${event.progress.started}`);
            return Promise.resolve();
          },
          afterProviderAcceptedMutationTarget: (event) => {
            accepted.push(event);
            return Promise.resolve();
          },
          afterDispatchVerified: (event) => {
            events.push(`after ${event.progress.verified}`);
            return Promise.resolve();
          },
          dependencies: dependencies(calls, async (request) => {
            events.push(`${request.method} ${nsid(request)}`);
            switch (nsid(request)) {
              case "com.atproto.server.getSession":
                return jsonResponse(sessionResponse());
              case "com.atproto.repo.uploadBlob": {
                expect(request.method).toBe("POST");
                expect(request.headers.get("content-type")).toBe("image/png");
                expect(request.body).toBeInstanceOf(Uint8Array);
                expect(request.body).toEqual(imageBytes);
                return jsonResponse({
                  blob: {
                    $type: "blob",
                    ref: { $link: blobCid },
                    mimeType: "image/png",
                    size: imageBytes.byteLength,
                  },
                });
              }
              case "com.atproto.repo.createRecord":
                expect(request.method).toBe("POST");
                expect(JSON.parse(String(request.body))).toEqual({
                  repo: VIEWER_DID,
                  collection: "app.bsky.feed.post",
                  record: expectedRecord,
                });
                return jsonResponse({ uri: createdUri, cid: createdCid });
              case "com.atproto.repo.getRecord":
                expect(request.method).toBe("GET");
                expect(Object.fromEntries(request.url.searchParams)).toEqual({
                  repo: VIEWER_DID,
                  collection: "app.bsky.feed.post",
                  rkey: "3lpublishedfixture",
                });
                return jsonResponse({
                  uri: createdUri,
                  cid: createdCid,
                  value: expectedRecord,
                });
              case "app.bsky.feed.getPosts":
                expect(request.method).toBe("GET");
                expect(request.url.searchParams.getAll("uris")).toEqual([createdUri]);
                expect(request.headers.get("atproto-proxy")).toBe(BLUESKY_APPVIEW_PROXY);
                return jsonResponse({
                  posts: [{
                    uri: createdUri,
                    cid: createdCid,
                    author: {
                      did: VIEWER_DID,
                      handle: "viewer.test",
                      displayName: "Synthetic viewer",
                    },
                    record: {
                      $type: "app.bsky.feed.post",
                      text,
                      createdAt,
                      embed: {
                        $type: "app.bsky.embed.images",
                        images: [{
                          image: {
                            $type: "blob",
                            ref: { $link: blobCid },
                            mimeType: "image/png",
                            size: imageBytes.byteLength,
                          },
                          alt,
                        }],
                      },
                    },
                    embed: {
                      $type: "app.bsky.embed.images#view",
                      images: [{ alt }],
                    },
                    indexedAt: createdAt,
                    replyCount: 0,
                    repostCount: 0,
                    likeCount: 0,
                    quoteCount: 0,
                    viewer: {},
                  }],
                });
              default:
                throw new Error(`unexpected Bluesky publish request ${nsid(request)}`);
            }
          }),
        },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        output: {
          posts: [{ uri: createdUri, cid: createdCid }],
        },
        finalUrl: `https://bsky.app/profile/${VIEWER_DID}/post/3lpublishedfixture`,
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
      expect(events).toEqual([
        "GET com.atproto.server.getSession",
        "POST com.atproto.repo.uploadBlob",
        "GET com.atproto.server.getSession",
        "before 0",
        "POST com.atproto.repo.createRecord",
        "GET com.atproto.repo.getRecord",
        "GET app.bsky.feed.getPosts",
        "after 1",
      ]);
      expect(accepted).toEqual([{
        id: "posts.publish",
        index: 1,
        target: {
          schemaVersion: 1,
          identifier: canonicalJson({
            uri: createdUri,
            cid: createdCid,
            createdAt,
            media: {
              cid: blobCid,
              mediaType: "image/png",
              size: imageBytes.byteLength,
            },
          }),
        },
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("polls the exact response-bound URI when the public Bluesky projection settles late", async () => {
    const text = "Late Bluesky projection";
    const createdAt = new Date(2_000_000_000_000).toISOString();
    const createdUri = `at://${VIEWER_DID}/app.bsky.feed.post/3llatefixture`;
    const createdCid = `b${"e".repeat(40)}`;
    const expectedRecord = {
      $type: "app.bsky.feed.post",
      text,
      createdAt,
    };
    const calls: CapturedRequest[] = [];
    const pauses: number[] = [];
    let appViewReads = 0;
    const baseDependencies = dependencies(calls, (request) => {
      switch (nsid(request)) {
        case "com.atproto.server.getSession":
          return jsonResponse(sessionResponse());
        case "com.atproto.repo.createRecord":
          return jsonResponse({ uri: createdUri, cid: createdCid });
        case "com.atproto.repo.getRecord":
          return jsonResponse({
            uri: createdUri,
            cid: createdCid,
            value: expectedRecord,
          });
        case "app.bsky.feed.getPosts":
          appViewReads += 1;
          return appViewReads === 1
            ? jsonResponse({ posts: [] })
            : jsonResponse({
                posts: [{
                  uri: createdUri,
                  cid: createdCid,
                  author: {
                    did: VIEWER_DID,
                    handle: "viewer.test",
                    displayName: "Synthetic viewer",
                  },
                  record: expectedRecord,
                  indexedAt: createdAt,
                  replyCount: 0,
                  repostCount: 0,
                  likeCount: 0,
                  quoteCount: 0,
                  viewer: {},
                }],
              });
        default:
          throw new Error(`unexpected delayed Bluesky readback request ${nsid(request)}`);
      }
    });
    const runtimeDependencies: CompleteDependencies = {
      ...baseDependencies,
      sleep: (milliseconds) => {
        pauses.push(milliseconds);
        return Promise.resolve();
      },
    };

    const result = await executeBlueskyWebOperation(
      recipe("posts.publish"),
      { body: text },
      blueskyAuth,
      { dependencies: runtimeDependencies },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      output: { posts: [{ uri: createdUri, cid: createdCid }] },
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(appViewReads).toBe(2);
    expect(pauses).toEqual([250]);
  });

  test("reconciles one exact accepted Bluesky record without a provider write", async () => {
    const text = "Reconciled Bluesky post";
    const createdAt = "2026-08-18T12:00:00.000Z";
    const uri = `at://${VIEWER_DID}/app.bsky.feed.post/3lreconcilefixture`;
    const cid = `b${"f".repeat(40)}`;
    const record = { $type: "app.bsky.feed.post", text, createdAt };
    const identifier = canonicalJson({ uri, cid, createdAt, media: null });
    const calls: CapturedRequest[] = [];
    const result = await readBlueskyWebPublishedMutationTarget(
      recipe("posts.publish"),
      { body: text },
      blueskyAuth,
      identifier,
      {
        dependencies: dependencies(calls, (request) => {
          switch (nsid(request)) {
            case "com.atproto.server.getSession":
              return jsonResponse(sessionResponse());
            case "com.atproto.repo.getRecord":
              return jsonResponse({ uri, cid, value: record });
            case "app.bsky.feed.getPosts":
              return jsonResponse({
                posts: [{
                  uri,
                  cid,
                  author: { did: VIEWER_DID, handle: "viewer.test" },
                  record,
                  indexedAt: createdAt,
                  replyCount: 0,
                  repostCount: 0,
                  likeCount: 0,
                  quoteCount: 0,
                  viewer: {},
                }],
              });
            default:
              throw new Error(`unexpected Bluesky reconciliation request ${nsid(request)}`);
          }
        }),
      },
    );
    expect(result).toEqual({ present: true, uri, cid });
    expect(calls.every((request) => request.method === "GET")).toBeTrue();
    await expect(readBlueskyWebPublishedMutationTarget(
      recipe("posts.publish"),
      { body: text },
      blueskyAuth,
      `${identifier} `,
    )).rejects.toThrow("not canonical");
  });

  test("keeps an image upload failure before durable createRecord admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-bluesky-upload-failure-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, new Uint8Array([137, 80, 78, 71]), { mode: 0o600 });
    const calls: CapturedRequest[] = [];
    let beforeDispatch = 0;
    try {
      const result = await executeBlueskyWebOperation(
        recipe("posts.publish"),
        {
          body: "No retry after upload admission",
          media: { kind: "file", reference: "fixture" },
          media_type: "image/png",
          alt: "Exact alt",
        },
        blueskyAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          beforeDispatch: () => {
            beforeDispatch += 1;
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            if (nsid(request) === "com.atproto.server.getSession") {
              return jsonResponse(sessionResponse());
            }
            if (nsid(request) === "com.atproto.repo.uploadBlob") {
              return new Response("upload failed", { status: 503 });
            }
            throw new Error(`unexpected request after failed upload: ${nsid(request)}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
        error: "Bluesky post preparation failed before public record submission; failure stage: media-upload; retry with a fresh confirmed plan",
      });
      expect(beforeDispatch).toBe(0);
      expect(calls.map(nsid)).toEqual([
        "com.atproto.server.getSession",
        "com.atproto.repo.uploadBlob",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a createRecord failure indeterminate after exact dispatch admission", async () => {
    const calls: CapturedRequest[] = [];
    let beforeDispatch = 0;
    const result = await executeBlueskyWebOperation(
      recipe("posts.publish"),
      { body: "Create response must remain uncertain" },
      blueskyAuth,
      {
        beforeDispatch: () => {
          beforeDispatch += 1;
          return Promise.resolve();
        },
        dependencies: dependencies(calls, (request) => {
          if (nsid(request) === "com.atproto.server.getSession") {
            return jsonResponse(sessionResponse());
          }
          if (nsid(request) === "com.atproto.repo.createRecord") {
            return new Response("create failed", { status: 503 });
          }
          throw new Error(`unexpected request after failed createRecord: ${nsid(request)}`);
        }),
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
      error: "Bluesky may have accepted the current post dispatch; failure stage: create-record; reconcile before retrying",
    });
    expect(beforeDispatch).toBe(1);
    expect(calls.map(nsid)).toEqual([
      "com.atproto.server.getSession",
      "com.atproto.server.getSession",
      "com.atproto.repo.createRecord",
    ]);
  });

  test("retains the exact accepted target when authoritative readback fails", async () => {
    const text = "Accepted Bluesky readback failure";
    const createdAt = new Date(2_000_000_000_000).toISOString();
    const uri = `at://${VIEWER_DID}/app.bsky.feed.post/3lreadbackfailure`;
    const cid = `b${"f".repeat(40)}`;
    const calls: CapturedRequest[] = [];
    const accepted: unknown[] = [];
    const result = await executeBlueskyWebOperation(
      recipe("posts.publish"),
      { body: text },
      blueskyAuth,
      {
        afterProviderAcceptedMutationTarget: (event) => {
          accepted.push(event);
          return Promise.resolve();
        },
        dependencies: dependencies(calls, (request) => {
          switch (nsid(request)) {
            case "com.atproto.server.getSession":
              return jsonResponse(sessionResponse());
            case "com.atproto.repo.createRecord":
              return jsonResponse({ uri, cid });
            case "com.atproto.repo.getRecord":
              return new Response("readback failed", { status: 503 });
            default:
              throw new Error(`unexpected request after failed record readback: ${nsid(request)}`);
          }
        }),
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
      error: "Bluesky may have accepted the current post dispatch; failure stage: authoritative-record-readback; reconcile before retrying",
    });
    expect(accepted).toEqual([{
      id: "posts.publish",
      index: 1,
      target: {
        schemaVersion: 1,
        identifier: canonicalJson({ uri, cid, createdAt, media: null }),
      },
    }]);
    expect(calls.map(nsid)).toEqual([
      "com.atproto.server.getSession",
      "com.atproto.server.getSession",
      "com.atproto.repo.createRecord",
      "com.atproto.repo.getRecord",
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
