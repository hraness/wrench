import { describe, expect, test } from "bun:test";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { WebSessionRecipe } from "../model";
import { canonicalJson } from "../canonical-json";
import {
  buildLinkedInArticleContent,
  buildLinkedInArticleContentHtml,
} from "./linkedin-web";
import { parseArticleDraftDocument } from "../article-draft-document";
import {
  executeLinkedInWebOperation,
  probeLinkedInWebSubject,
  readLinkedInWebArticleDraftDesiredState,
  type LinkedInWebRuntimeDependencies,
} from "./linkedin-web-runtime";
import type { LinkedInArticleBrowserTransport } from "./linkedin-web-article-browser";

const MEMBER_ID = "123456789";
const MEMBER_URN = `urn:li:fsd_profile:${MEMBER_ID}`;
const MINI_PROFILE_URN = "urn:li:fs_miniProfile:ACoAAExactCurrentProfile";
const ARTICLE_PROFILE_URN = "urn:li:fsd_profile:ACoAAExactCurrentProfile";
const ARTICLE_ID = "7000000000000000001";

const linkedinAuth = {
  schemaVersion: 1,
  id: "linkedin-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Default",
  subject: MEMBER_URN,
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
    domain: ".linkedin.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: 0,
  };
}

const linkedinCookies = Object.freeze([
  strictCookie("JSESSIONID", '"ajax:246813579"'),
  strictCookie("li_at", "private-linkedin-cookie"),
]);

function inputUrl(value: string | URL | Request): URL {
  return new URL(typeof value === "string" ? value : value instanceof URL ? value.href : value.url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function dependencies(
  calls: CapturedRequest[],
  handler: (request: CapturedRequest) => Response | Promise<Response>,
): LinkedInWebRuntimeDependencies {
  const acquireCookies: CookieRecordReader = () => Promise.resolve({ cookies: linkedinCookies, warnings: [] });
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
  return {
    acquireCookies,
    fetch,
    loadCachedCookies: () => Promise.resolve({
      value: null,
      contentSha256: null,
    }),
    saveCachedCookies: () => ({
      written: true,
      contentSha256: "a".repeat(64),
    }),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/vnd.linkedin.normalized+json+2.1; charset=utf-8" },
  });
}

function currentIdentityResponse(): unknown {
  return {
    data: { plainId: MEMBER_ID, "*miniProfile": MINI_PROFILE_URN },
    included: [{
      entityUrn: MINI_PROFILE_URN,
      objectUrn: `urn:li:member:${MEMBER_ID}`,
    }],
  };
}

function articleResponse(
  title: string,
  content: readonly Readonly<Record<string, unknown>>[],
): unknown {
  const urn = `urn:li:fsd_firstPartyArticle:${ARTICLE_ID}`;
  return {
    data: {
      $type: "com.linkedin.restli.common.CollectionResponse",
      "*elements": [urn],
      entityUrn: "urn:li:collectionResponse:article-fixture",
      paging: { count: 10, links: [], start: 0 },
    },
    included: [{
      $type: "com.linkedin.voyager.dash.publishing.FirstPartyArticle",
      activityUrn: null,
      annotation: null,
      annotationActionType: null,
      articleActionUnions: [],
      articleAnnotation: null,
      articlePublishedTimeDescription: null,
      articleType: "FIRST_PARTY_ARTICLE",
      authors: [{ profileUrn: ARTICLE_PROFILE_URN }],
      availableLocales: [],
      content,
      contentDescription: null,
      contentHtml: "<p>bounded derived HTML</p>",
      contentSegments: null,
      coverMedia: null,
      coverMediaV2Union: null,
      createdAt: 1,
      entityUrn: urn,
      featured: null,
      followingStateUrn: "urn:li:fsd_followingState:article-fixture",
      gatedArticleMetadata: null,
      initialUpdateUrn: null,
      issueNumber: null,
      linkedInArticleUrn: `urn:li:linkedInArticle:${ARTICLE_ID}`,
      locale: null,
      memberContributionInsight: null,
      permalink: null,
      publishedAt: null,
      scheduledAt: null,
      seoDescription: null,
      seoTitle: null,
      series: null,
      servedLocale: null,
      socialDetailUrn: null,
      socialProofInsight: null,
      sponsoredAccountUrn: null,
      state: "DRAFT",
      surveyComponent: null,
      title,
      trackingId: null,
      ugcPostUrn: null,
      updatedAt: 2,
      version: 3,
      viewerAllowedToEdit: null,
    }],
  };
}

function articleHtmlResponse(
  title: string,
  content: readonly Readonly<Record<string, unknown>>[],
): Response {
  const encoded = JSON.stringify(articleResponse(title, content)).replace(
    /[&<>"=\\]/gu,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "=": "&#61;",
      "\\": "&#92;",
    })[character] ?? character,
  );
  return new Response(
    `<html><body><code id="bpr-guid-123456" style="display: none">${encoded}</code></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function articleRecipe(): WebSessionRecipe {
  return {
    site: "linkedin",
    action: "articles.draft.save",
    contractVersion: 2,
    timeoutMs: 1_000,
    maxOutputBytes: 2 * 1024 * 1024,
  };
}

function messagingListRecipe(): WebSessionRecipe {
  return {
    site: "linkedin",
    action: "messaging.list",
    contractVersion: 1,
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

function expectLinkedInHeaders(request: CapturedRequest, referer: string): void {
  expect(request.headers.get("accept")).toBe("application/vnd.linkedin.normalized+json+2.1");
  expect(request.headers.get("csrf-token")).toBe("ajax:246813579");
  expect(request.headers.get("referer")).toBe(referer);
  expect(request.headers.get("x-li-lang")).toBe("en_US");
  expect(request.headers.get("x-requested-with")).toBe("XMLHttpRequest");
  expect(request.headers.get("x-restli-protocol-version")).toBe("2.0.0");
  expect(request.headers.get("cookie")).toContain("li_at=private-linkedin-cookie");
}

describe("LinkedIn authenticated internal-API runtime", () => {
  test("probes one stable member subject through the exact /voyager/api/me contract", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      expect(request.url.href).toBe("https://www.linkedin.com/voyager/api/me");
      expect(request.method).toBe("GET");
      expect(request.body).toBeNull();
      expectLinkedInHeaders(request, "https://www.linkedin.com/feed/");
      return jsonResponse({
        data: { plainId: MEMBER_ID },
        included: [{ entityUrn: MEMBER_URN }],
      });
    });

    expect(await probeLinkedInWebSubject(linkedinAuth, {
      timeoutMs: 1_000,
      dependencies: runtimeDependencies,
    })).toBe(MEMBER_URN);
    expect(calls).toHaveLength(1);
  });

  test("persists LinkedIn's strictly reviewed Cloudflare rotation cookie from account preflight", async () => {
    const calls: CapturedRequest[] = [];
    const savedCaches: unknown[] = [];
    const runtimeDependencies: LinkedInWebRuntimeDependencies = {
      ...dependencies(calls, (request) => {
        expect(request.url.pathname).toBe("/voyager/api/me");
        return new Response(JSON.stringify({
          data: { plainId: MEMBER_ID, miniProfile: MINI_PROFILE_URN },
          included: [{
            entityUrn: MINI_PROFILE_URN,
            objectUrn: `urn:li:member:${MEMBER_ID}`,
          }],
        }), {
          status: 200,
          headers: {
            "content-type": "application/vnd.linkedin.normalized+json+2.1",
            "set-cookie": "__cf_bm=private-rotated-value; Max-Age=1800; Domain=.linkedin.com; Path=/; Secure; HttpOnly; SameSite=None; Priority=High",
          },
        });
      }),
      saveCachedCookies: (_auth, _authHash, value) => {
        savedCaches.push(value);
        return {
          written: true,
          contentSha256: "b".repeat(64),
        };
      },
    };

    expect(await probeLinkedInWebSubject(linkedinAuth, {
      timeoutMs: 1_000,
      dependencies: runtimeDependencies,
    })).toBe(MEMBER_URN);
    expect(calls).toHaveLength(1);
    expect(savedCaches).toHaveLength(1);
    const savedCache = record(savedCaches[0], "saved LinkedIn rotating-cookie cache");
    const savedCookieValues = savedCache.cookies;
    if (!Array.isArray(savedCookieValues)) throw new Error("expected saved LinkedIn rotating cookies");
    const savedCookie = record(savedCookieValues[0], "saved LinkedIn rotating cookie");
    expect(typeof savedCookie.acceptedAtSeconds).toBe("number");
    expect(savedCaches[0]).toMatchObject({
      schemaVersion: 2,
      origin: "https://www.linkedin.com",
      cookies: [{
        name: "__cf_bm",
        domain: "linkedin.com",
        hostOnly: false,
      }],
      tombstones: [],
    });
  });

  test("persists a reviewed deletion tombstone across clients and suppresses the stale browser snapshot", async () => {
    const staleRotation = {
      ...strictCookie("__cf_bm", "stale-browser-value"),
      expires: Math.floor(Date.now() / 1_000) + 86_400,
    };
    const sourceCookies = Object.freeze([...linkedinCookies, staleRotation]);
    let persistedCache: unknown = null;
    const firstCalls: CapturedRequest[] = [];
    const firstDependencies: LinkedInWebRuntimeDependencies = {
      acquireCookies: () => Promise.resolve({ cookies: sourceCookies, warnings: [] }),
      fetch: (value: string | URL | Request, init?: RequestInit) => {
        const request = {
          url: inputUrl(value),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          body: null,
        } satisfies CapturedRequest;
        firstCalls.push(request);
        expect(request.headers.get("cookie")).toContain("__cf_bm=stale-browser-value");
        return Promise.resolve(new Response(JSON.stringify({
          data: { plainId: MEMBER_ID },
          included: [{ entityUrn: MEMBER_URN }],
        }), {
          status: 200,
          headers: {
            "content-type": "application/vnd.linkedin.normalized+json+2.1",
            "set-cookie": "__cf_bm=deleted; Max-Age=0; Domain=.linkedin.com; Path=/; Secure; HttpOnly; SameSite=None",
          },
        }));
      },
      loadCachedCookies: () => Promise.resolve({
        value: null,
        contentSha256: null,
      }),
      saveCachedCookies: (_auth, _authHash, value) => {
        persistedCache = value;
        return {
          written: true,
          contentSha256: "c".repeat(64),
        };
      },
    };
    expect(await probeLinkedInWebSubject(linkedinAuth, {
      timeoutMs: 1_000,
      dependencies: firstDependencies,
    })).toBe(MEMBER_URN);
    expect(firstCalls).toHaveLength(1);

    const secondCalls: CapturedRequest[] = [];
    const secondDependencies: LinkedInWebRuntimeDependencies = {
      acquireCookies: () => Promise.resolve({ cookies: sourceCookies, warnings: [] }),
      fetch: (value: string | URL | Request, init?: RequestInit) => {
        const request = {
          url: inputUrl(value),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          body: null,
        } satisfies CapturedRequest;
        secondCalls.push(request);
        expect(request.headers.get("cookie")).not.toContain("__cf_bm=");
        return Promise.resolve(jsonResponse({
          data: { plainId: MEMBER_ID },
          included: [{ entityUrn: MEMBER_URN }],
        }));
      },
      loadCachedCookies: () => Promise.resolve({
        value: persistedCache,
        contentSha256: "c".repeat(64),
      }),
      saveCachedCookies: () => ({
        written: true,
        contentSha256: "d".repeat(64),
      }),
    };
    expect(await probeLinkedInWebSubject(linkedinAuth, {
      timeoutMs: 1_000,
      dependencies: secondDependencies,
    })).toBe(MEMBER_URN);
    expect(secondCalls).toHaveLength(1);
    const persisted = record(persistedCache, "persisted LinkedIn rotating-cookie cache");
    const tombstoneValues = persisted.tombstones;
    if (!Array.isArray(tombstoneValues)) throw new Error("expected persisted LinkedIn tombstones");
    const persistedTombstone = record(tombstoneValues[0], "persisted LinkedIn tombstone");
    expect(typeof persistedTombstone.acceptedAtSeconds).toBe("number");
    expect(persistedCache).toMatchObject({
      schemaVersion: 2,
      origin: "https://www.linkedin.com",
      cookies: [],
      tombstones: [{
        name: "__cf_bm",
        domain: "linkedin.com",
        hostOnly: false,
        path: "/",
      }],
    });
  });

  test("preserves a newer deletion tombstone when a stale process saves a cookie later", async () => {
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
    let releaseSetterSave: () => void = () => undefined;
    const setterSaveStarted = new Promise<void>((resolve) => {
      releaseSetterSave = resolve;
    });
    let releaseTombstoneSave: () => void = () => undefined;
    const tombstoneSaved = new Promise<void>((resolve) => {
      releaseTombstoneSave = resolve;
    });
    const loadCachedCookies: NonNullable<
      LinkedInWebRuntimeDependencies["loadCachedCookies"]
    > = async () => {
      initialLoads += 1;
      if (initialLoads === 2) releaseInitialLoads();
      await initialLoadsComplete;
      return persisted;
    };
    const saveCachedCookies: NonNullable<
      LinkedInWebRuntimeDependencies["saveCachedCookies"]
    > = async (_auth, _authHash, value, expectedContentSha256) => {
      const cache = record(value, "concurrent LinkedIn rotating-cookie cache");
      const cookies = cache.cookies;
      const tombstones = cache.tombstones;
      if (!Array.isArray(cookies) || !Array.isArray(tombstones)) {
        throw new Error("concurrent LinkedIn rotating-cookie cache is malformed");
      }
      if (cookies.length > 0 && expectedContentSha256 === null) {
        releaseSetterSave();
        await tombstoneSaved;
      }
      if (expectedContentSha256 !== persisted.contentSha256) {
        return { written: false };
      }
      revision += 1;
      const contentSha256 = revision.toString(16).padStart(64, "0");
      persisted = {
        value,
        contentSha256,
      };
      if (tombstones.length > 0) releaseTombstoneSave();
      return {
        written: true,
        contentSha256,
      };
    };
    const runtimeDependencies = (
      kind: "setter" | "deleter",
    ): LinkedInWebRuntimeDependencies => ({
      acquireCookies: () =>
        Promise.resolve({ cookies: linkedinCookies, warnings: [] }),
      loadCachedCookies,
      saveCachedCookies,
      fetch: async () => {
        if (kind === "deleter") await setterSaveStarted;
        return new Response(JSON.stringify({
          data: { plainId: MEMBER_ID },
          included: [{ entityUrn: MEMBER_URN }],
        }), {
          status: 200,
          headers: {
            "content-type": "application/vnd.linkedin.normalized+json+2.1",
            "set-cookie": kind === "setter"
              ? "__cf_bm=private-stale-setter-value; Max-Age=1800; Domain=.linkedin.com; Path=/; Secure; HttpOnly; SameSite=None"
              : "__cf_bm=private-deleted-value; Max-Age=0; Domain=.linkedin.com; Path=/; Secure; HttpOnly; SameSite=None",
          },
        });
      },
    });

    const [setter, deleter] = await Promise.allSettled([
      probeLinkedInWebSubject(linkedinAuth, {
        timeoutMs: 1_000,
        dependencies: runtimeDependencies("setter"),
      }),
      probeLinkedInWebSubject(linkedinAuth, {
        timeoutMs: 1_000,
        dependencies: runtimeDependencies("deleter"),
      }),
    ]);
    expect(deleter).toEqual({ status: "fulfilled", value: MEMBER_URN });
    expect(setter.status).toBe("rejected");
    if (setter.status !== "rejected") {
      throw new Error("stale LinkedIn cookie writer unexpectedly succeeded");
    }
    const message = setter.reason instanceof Error
      ? setter.reason.message
      : String(setter.reason);
    expect(message).toContain("concurrently");
    expect(message).not.toContain("private-stale-setter-value");
    expect(message).not.toContain("private-deleted-value");
    const stored = record(
      persisted.value,
      "persisted concurrent LinkedIn rotating-cookie cache",
    );
    expect(stored.cookies).toEqual([]);
    expect(stored.tombstones).toMatchObject([{
      name: "__cf_bm",
      domain: "linkedin.com",
      hostOnly: false,
      path: "/",
    }]);
  });

  test("loads the strict legacy schema-one rotating-cookie cache as reviewed response provenance", async () => {
    const expires = Math.floor(Date.now() / 1_000) + 1_800;
    const calls: CapturedRequest[] = [];
    const runtimeDependencies: LinkedInWebRuntimeDependencies = {
      ...dependencies(calls, (request) => {
        expect(request.headers.get("cookie")).toContain("__cf_bm=legacy-reviewed-value");
        return jsonResponse({
          data: { plainId: MEMBER_ID },
          included: [{ entityUrn: MEMBER_URN }],
        });
      }),
      loadCachedCookies: () => Promise.resolve({
        value: {
          schemaVersion: 1,
          origin: "https://www.linkedin.com",
          cookies: [{
            ...strictCookie("__cf_bm", "legacy-reviewed-value"),
            expires,
          }],
        },
        contentSha256: "e".repeat(64),
      }),
    };
    expect(await probeLinkedInWebSubject(linkedinAuth, {
      timeoutMs: 1_000,
      dependencies: runtimeDependencies,
    })).toBe(MEMBER_URN);
    expect(calls).toHaveLength(1);
  });

  test("does not revive an unbounded schema-one session cookie without an acceptance time", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies: LinkedInWebRuntimeDependencies = {
      ...dependencies(calls, (request) => {
        expect(request.headers.get("cookie")).not.toContain("__cf_bm=");
        return jsonResponse({
          data: { plainId: MEMBER_ID },
          included: [{ entityUrn: MEMBER_URN }],
        });
      }),
      loadCachedCookies: () => Promise.resolve({
        value: {
          schemaVersion: 1,
          origin: "https://www.linkedin.com",
          cookies: [strictCookie("__cf_bm", "unbounded-legacy-value")],
        },
        contentSha256: "f".repeat(64),
      }),
    };
    expect(await probeLinkedInWebSubject(linkedinAuth, {
      timeoutMs: 1_000,
      dependencies: runtimeDependencies,
    })).toBe(MEMBER_URN);
    expect(calls).toHaveLength(1);
  });

  test("requires a primary subject corroborated by the normalized profile entity", async () => {
    const cases = [
      {
        body: {
          data: {
            plainId: MEMBER_ID,
            "*miniProfile": MINI_PROFILE_URN,
            miniProfile: MINI_PROFILE_URN,
          },
          included: [{ entityUrn: MINI_PROFILE_URN, objectUrn: `urn:li:member:${MEMBER_ID}` }],
        },
        expected: "ambiguous normalized profile references",
      },
      {
        body: {
          data: { plainId: MEMBER_ID },
          included: [{ entityUrn: "urn:li:fsd_profile:999" }],
        },
        expected: "did not corroborate its primary member subject",
      },
      {
        body: {
          data: {},
          included: [{ entityUrn: MEMBER_URN }],
        },
        expected: "omitted its exact primary member subject",
      },
      {
        body: {
          data: { plainId: MEMBER_ID },
          included: [],
        },
        expected: "did not corroborate its primary member subject",
      },
      {
        body: { serviceErrorCode: 42, message: "private provider detail" },
        expected: "service error",
      },
    ] as const;
    for (const item of cases) {
      const calls: CapturedRequest[] = [];
      const message = await rejectionMessage(probeLinkedInWebSubject(linkedinAuth, {
        timeoutMs: 1_000,
        dependencies: dependencies(calls, () => jsonResponse(item.body)),
      }));
      expect(message).toContain(item.expected);
      expect(message).not.toContain("private provider detail");
      expect(calls).toHaveLength(1);
    }
  });

  test("binds the current normalized mini-profile reference to its exact member object", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, () => jsonResponse({
      data: { plainId: MEMBER_ID, miniProfile: MINI_PROFILE_URN },
      included: [
        {
          entityUrn: "urn:li:fs_miniProfile:ACoAAUnrelatedProfile",
          objectUrn: "urn:li:member:999",
        },
        {
          entityUrn: MINI_PROFILE_URN,
          objectUrn: `urn:li:member:${MEMBER_ID}`,
        },
      ],
    }));

    expect(await probeLinkedInWebSubject(linkedinAuth, {
      timeoutMs: 1_000,
      dependencies: runtimeDependencies,
    })).toBe(MEMBER_URN);
    expect(calls).toHaveLength(1);
  });

  test("rejects missing, ambiguous, malformed, and conflicting normalized identity bindings", async () => {
    const cases = [
      {
        body: {
          data: { plainId: MEMBER_ID, miniProfile: MINI_PROFILE_URN },
          included: [],
        },
        expected: "did not corroborate its normalized profile reference",
      },
      {
        body: {
          data: { plainId: MEMBER_ID, miniProfile: MINI_PROFILE_URN },
          included: [
            { entityUrn: MINI_PROFILE_URN, objectUrn: `urn:li:member:${MEMBER_ID}` },
            { entityUrn: MINI_PROFILE_URN, objectUrn: `urn:li:member:${MEMBER_ID}` },
          ],
        },
        expected: "ambiguous normalized profile reference",
      },
      {
        body: {
          data: { plainId: MEMBER_ID, miniProfile: "urn:li:fs_miniProfile:bad/value" },
          included: [],
        },
        expected: "invalid normalized profile reference",
      },
      {
        body: {
          data: { plainId: MEMBER_ID, miniProfile: MINI_PROFILE_URN },
          included: [{ entityUrn: MINI_PROFILE_URN, objectUrn: "urn:li:member:999" }],
        },
        expected: "conflicting member subject",
      },
      {
        body: {
          data: { plainId: MEMBER_ID, miniProfile: MINI_PROFILE_URN },
          included: [{ entityUrn: MINI_PROFILE_URN }],
        },
        expected: "did not bind its normalized profile to one member subject",
      },
    ] as const;

    for (const item of cases) {
      const message = await rejectionMessage(probeLinkedInWebSubject(linkedinAuth, {
        timeoutMs: 1_000,
        dependencies: dependencies([], () => jsonResponse(item.body)),
      }));
      expect(message).toContain(item.expected);
    }
  });

  test("creates one private linked Article draft, verifies exact unpublished readback, and never publishes", async () => {
    const title = "Private fixture";
    const documentValue = canonicalJson({
      schemaVersion: 1,
      blocks: [
        { type: "heading1", text: "Harnessing Puerto Rico" },
        {
          type: "paragraph",
          text: "Read the source",
          links: [{ offset: 9, length: 6, url: "https://example.com/source" }],
        },
      ],
    });
    const document = parseArticleDraftDocument(documentValue, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
    });
    const expectedContent = buildLinkedInArticleContent(document);
    const expectedContentHtml = buildLinkedInArticleContentHtml(document);
    const calls: CapturedRequest[] = [];
    let contentSaved = false;
    const dispatches: string[] = [];
    const result = await executeLinkedInWebOperation(
      articleRecipe(),
      { title, document: documentValue },
      linkedinAuth,
      {
        dependencies: dependencies(calls, (request) => {
          if (request.url.pathname === "/voyager/api/me") {
            return jsonResponse(currentIdentityResponse());
          }
          if (
            request.url.pathname === "/voyager/api/voyagerPublishingDashFirstPartyArticles/"
            && request.method === "POST"
          ) {
            expect(JSON.parse(request.body ?? "null")).toEqual({
              authors: [{ profileUrn: ARTICLE_PROFILE_URN }],
              contentHtml: "",
              state: "AUTOSAVED",
              title,
            });
            return new Response(null, {
              status: 201,
              headers: { "x-restli-id": `urn:li:fsd_firstPartyArticle:${ARTICLE_ID}` },
            });
          }
          if (
            request.url.pathname === `/article/edit/${ARTICLE_ID}/`
            && request.method === "GET"
          ) {
            expect([...request.url.searchParams.entries()]).toEqual([]);
            expect(request.headers.get("accept")).toBe("text/html");
            expect(request.headers.get("referer")).toBe(
              `https://www.linkedin.com/article/edit/${ARTICLE_ID}/`,
            );
            return articleHtmlResponse(title, contentSaved ? expectedContent : []);
          }
          if (
            request.url.pathname.endsWith(`urn:li:fsd_firstPartyArticle:${ARTICLE_ID}`)
            && request.method === "POST"
          ) {
            expect(request.headers.get("x-restli-method")).toBeNull();
            expect(JSON.parse(request.body ?? "null")).toEqual({
              patch: {
                $set: {
                  content: expectedContent,
                  contentHtml: expectedContentHtml,
                  state: "AUTOSAVED",
                },
              },
            });
            contentSaved = true;
            return new Response(null, { status: 200 });
          }
          throw new Error(`unexpected test request ${request.method} ${request.url.pathname}`);
        }),
        beforeDispatch: (event) => {
          dispatches.push(`start:${event.id}`);
          return Promise.resolve();
        },
        afterDispatchVerified: (event) => {
          dispatches.push(`verified:${event.id}`);
          return Promise.resolve();
        },
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      finalUrl: `https://www.linkedin.com/article/edit/${ARTICLE_ID}/`,
      dispatchStarted: true,
      dispatch: { planned: 2, started: 2, verified: 2 },
      output: {
        provider: "linkedin",
        operation: "articles.draft.save",
        published: false,
        draftId: ARTICLE_ID,
        title,
      },
    });
    expect(dispatches).toEqual([
      "start:articles.create",
      "verified:articles.create",
      "start:articles.content",
      "verified:articles.content",
    ]);
    expect(calls.some((call) => /(?:^|\/)(?:publish|share)(?:\/|$)/iu.test(call.url.pathname))).toBeFalse();
  });

  test("selects the contained Article browser transport in production and tracks its cleanup barrier", async () => {
    const title = "Contained browser fixture";
    const documentValue = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Private browser body" }],
    });
    const document = parseArticleDraftDocument(documentValue, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
    });
    const expectedContent = buildLinkedInArticleContent(document);
    let contentSaved = false;
    let closed = false;
    let browserCreates = 0;
    const cleanupBarriers: Promise<void>[] = [];
    const cleanupPublisher = () => undefined;
    const transport: LinkedInArticleBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
      prepareCreateDraft: () => Promise.resolve(),
      createDraft: () => Promise.resolve(`urn:li:fsd_firstPartyArticle:${ARTICLE_ID}`),
      readDraftResponse: () => Promise.resolve(articleResponse(
        title,
        contentSaved ? expectedContent : [],
      )),
      updateTitle: () => Promise.reject(new Error("create must not replace a title")),
      updateContent: (_draftId, receivedDocument) => {
        expect(receivedDocument).toEqual(document);
        contentSaved = true;
        return Promise.resolve();
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };

    const result = await executeLinkedInWebOperation(
      articleRecipe(),
      { title, document: documentValue },
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: (_auth, options) => {
            browserCreates += 1;
            expect(options.publishCleanupResource).toBe(cleanupPublisher);
            return Promise.resolve(transport);
          },
        },
        registerCleanupBarrier: (barrier) => {
          cleanupBarriers.push(barrier);
          return cleanupPublisher;
        },
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      dispatch: { planned: 2, started: 2, verified: 2 },
      output: { draftId: ARTICLE_ID, published: false, title },
    });
    expect(browserCreates).toBe(1);
    expect(closed).toBeTrue();
    expect(cleanupBarriers).toHaveLength(1);
    await Promise.all(cleanupBarriers);
  });

  test("replaces one exact private draft in place and reconciles only from unpublished readback", async () => {
    let title = "Old private title";
    let document = parseArticleDraftDocument(canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Old body" }],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000 });
    const nextTitle = "Updated private title";
    const nextDocumentValue = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Updated linked body", links: [{
        offset: 8,
        length: 6,
        url: "https://example.com/updated",
      }] }],
    });
    const nextDocument = parseArticleDraftDocument(nextDocumentValue, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
    });
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.pathname === "/voyager/api/me") return jsonResponse(currentIdentityResponse());
      if (request.method === "GET") {
        expect(request.url.pathname).toBe(`/article/edit/${ARTICLE_ID}/`);
        return articleHtmlResponse(title, buildLinkedInArticleContent(document));
      }
      const body = JSON.parse(request.body ?? "null") as {
        patch: { $set: { title?: string; content?: readonly Readonly<Record<string, unknown>>[] } };
      };
      if (body.patch.$set.title !== undefined) title = body.patch.$set.title;
      if (body.patch.$set.content !== undefined) document = nextDocument;
      return new Response(null, { status: 200 });
    });
    const input = {
      title: nextTitle,
      document: nextDocumentValue,
      draft_id: ARTICLE_ID,
    };
    const dispatches: string[] = [];
    const result = await executeLinkedInWebOperation(articleRecipe(), input, linkedinAuth, {
      dependencies: runtimeDependencies,
      beforeDispatch: (event) => {
        dispatches.push(`start:${event.id}`);
        return Promise.resolve();
      },
      afterDispatchVerified: (event) => {
        dispatches.push(`verified:${event.id}`);
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({
      status: "succeeded",
      dispatch: { planned: 1, started: 1, verified: 1 },
      output: { draftId: ARTICLE_ID, published: false, title: nextTitle },
    });
    expect(dispatches).toEqual([
      "start:articles.replace",
      "verified:articles.replace",
    ]);
    expect(await readLinkedInWebArticleDraftDesiredState(
      articleRecipe(),
      input,
      linkedinAuth,
      { dependencies: runtimeDependencies },
    )).toEqual({ draftId: ARTICLE_ID, matches: true });
  });

  test("skips an already exact title and replaces only the changed private document", async () => {
    const title = "Harnessing Puerto Rico";
    const nextDocumentValue = canonicalJson({
      schemaVersion: 1,
      blocks: [{
        type: "paragraph",
        text: "Listen to Jungle",
        links: [{ offset: 10, length: 6, url: "https://hraness.com/audio/jungle" }],
      }],
    });
    const nextDocument = parseArticleDraftDocument(nextDocumentValue, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
    });
    const calls: string[] = [];
    let document: ReturnType<typeof parseArticleDraftDocument> | null = null;
    const transport: LinkedInArticleBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
      prepareCreateDraft: () => Promise.reject(new Error("replacement must not create")),
      createDraft: () => Promise.reject(new Error("replacement must not create")),
      readDraftResponse: () => Promise.resolve(articleResponse(
        title,
        document === null ? [] : buildLinkedInArticleContent(document),
      )),
      updateTitle: () => {
        calls.push("title");
        return Promise.reject(new Error("an exact title must not be submitted"));
      },
      updateContent: (_draftId, receivedDocument) => {
        calls.push("content");
        expect(receivedDocument).toEqual(nextDocument);
        document = nextDocument;
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const dispatches: string[] = [];
    const result = await executeLinkedInWebOperation(
      articleRecipe(),
      { title, document: nextDocumentValue, draft_id: ARTICLE_ID },
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: () => Promise.resolve(transport),
        },
        beforeDispatch: (event) => {
          dispatches.push(`start:${event.id}`);
          return Promise.resolve();
        },
        afterDispatchVerified: (event) => {
          dispatches.push(`verified:${event.id}`);
          return Promise.resolve();
        },
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      dispatch: { planned: 1, started: 1, verified: 1 },
      output: { draftId: ARTICLE_ID, published: false, title },
    });
    expect(calls).toEqual(["content"]);
    expect(dispatches).toEqual([
      "start:articles.replace",
      "verified:articles.replace",
    ]);
  });

  test.each([
    {
      privateDiagnostic: "LinkedIn Article page omitted its bounded page-instance binding",
      publicCategory: "page-instance-binding-missing",
    },
    {
      privateDiagnostic: "LinkedIn Article bootstrap did not isolate one exact hidden payload",
      publicCategory: "bootstrap-response-drift",
    },
  ])("categorizes private Article read failures without exposing their diagnostics", async ({
    privateDiagnostic,
    publicCategory,
  }) => {
    const document = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Unchanged private body" }],
    });
    const transport: LinkedInArticleBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
      prepareCreateDraft: () => Promise.reject(new Error("replacement must not create")),
      createDraft: () => Promise.reject(new Error("replacement must not create")),
      readDraftResponse: () => Promise.reject(new Error(privateDiagnostic)),
      updateTitle: () => Promise.reject(new Error("failed reads must not dispatch")),
      updateContent: () => Promise.reject(new Error("failed reads must not dispatch")),
      close: () => Promise.resolve(),
    };
    const result = await executeLinkedInWebOperation(
      articleRecipe(),
      { title: "Private fixture", document, draft_id: ARTICLE_ID },
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: () => Promise.resolve(transport),
        },
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
      error: expect.stringContaining(publicCategory),
    });
    expect(JSON.stringify(result)).not.toContain(privateDiagnostic);
  });

  test("keeps an accepted create without a stable response ID indeterminate and never retries", async () => {
    const document = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Uncertain private body" }],
    });
    const calls: CapturedRequest[] = [];
    const result = await executeLinkedInWebOperation(
      articleRecipe(),
      { title: "Uncertain private title", document },
      linkedinAuth,
      {
        dependencies: dependencies(calls, (request) => {
          if (request.url.pathname === "/voyager/api/me") {
            return jsonResponse(currentIdentityResponse());
          }
          return new Response(null, { status: 201 });
        }),
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      finalUrl: null,
      dispatchStarted: true,
      dispatch: { planned: 2, started: 1, verified: 0 },
      error: expect.stringContaining("do not retry"),
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  test("keeps ungraduated direct execution boundaries inert before dependencies or callbacks", async () => {
    const calls: string[] = [];
    const runtimeDependencies: LinkedInWebRuntimeDependencies = {
      acquireCookies: () => {
        calls.push("acquireCookies");
        return Promise.resolve({ cookies: linkedinCookies, warnings: [] });
      },
      fetch: () => {
        calls.push("fetch");
        return Promise.resolve(jsonResponse({}));
      },
      loadCachedCookies: () => {
        calls.push("loadCachedCookies");
        return Promise.resolve({
          value: null,
          contentSha256: null,
        });
      },
      saveCachedCookies: () => {
        calls.push("saveCachedCookies");
        return {
          written: true,
          contentSha256: "1".repeat(64),
        };
      },
      resolveMessengerConversationsQueryId: () => {
        calls.push("resolveMessengerConversationsQueryId");
        return Promise.resolve("messengerConversations.fedcba9876543210fedcba9876543210");
      },
    };
    const options = {
      dependencies: runtimeDependencies,
      fileResolver: () => {
        calls.push("fileResolver");
        return Promise.resolve([]);
      },
      beforeDispatch: () => {
        calls.push("beforeDispatch");
        return Promise.resolve();
      },
      afterDispatchVerified: () => {
        calls.push("afterDispatchVerified");
        return Promise.resolve();
      },
    } as const;

    const message = await rejectionMessage(executeLinkedInWebOperation(
      messagingListRecipe(),
      { folder: "focused", limit: 10 },
      linkedinAuth,
      options,
    ));
    expect(message).toContain("LinkedIn authenticated web operations are capture-required");
    expect(calls).toEqual([]);
  });
});
