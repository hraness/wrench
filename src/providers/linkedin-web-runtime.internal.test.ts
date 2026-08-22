import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { WebSessionRecipe } from "../model";
import { canonicalJson } from "../canonical-json";
import {
  buildLinkedInArticleContent,
  buildLinkedInArticleContentHtml,
  buildLinkedInArticleContentV2,
} from "./linkedin-web";
import {
  parseArticleDraftDocument,
  parseArticleDraftDocumentV2,
} from "../article-draft-document";
import {
  executeLinkedInWebOperation,
  probeLinkedInWebSubject,
  readLinkedInWebAcceptedPostTargetPresence,
  readLinkedInWebArticleDraftDesiredState,
  type LinkedInWebRuntimeDependencies,
} from "./linkedin-web-runtime";
import type { LinkedInArticleBrowserTransport } from "./linkedin-web-article-browser";
import {
  LinkedInPostCreateResponseError,
  type LinkedInPostBrowserTransport,
} from "./linkedin-web-post-browser";

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
      publicIdentifier: "0thernet",
    }],
  };
}

function articleResponse(
  title: string,
  content: readonly Readonly<Record<string, unknown>>[],
  overrides: Readonly<Record<string, unknown>> = {},
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
      ...overrides,
    }],
  };
}

function articleCoverFields(assetUrn: string | null): Readonly<Record<string, unknown>> {
  if (assetUrn === null) return { coverMedia: null, coverMediaV2Union: null };
  const vector = (includeAsset: boolean): Readonly<Record<string, unknown>> => ({
    $type: "com.linkedin.common.VectorImage",
    artifacts: [{
      $type: "com.linkedin.common.VectorArtifact",
      expiresAt: 1_900_000_000_000,
      fileIdentifyingUrlPathSegment: "image/fixture/cover-1200x630",
      height: 630,
      width: 1200,
    }],
    ...(includeAsset ? { digitalmediaAsset: assetUrn } : {}),
    rootUrl: "https://media.licdn.com/dms/image/fixture/",
  });
  const originalImage = (includeAsset: boolean): Readonly<Record<string, unknown>> => ({
    $type: "com.linkedin.voyager.dash.common.image.ImageViewModel",
    attributes: [{
      $type: "com.linkedin.voyager.dash.common.image.ImageAttribute",
      detailDataUnion: { vectorImage: vector(includeAsset) },
    }],
  });
  return {
    coverMedia: {
      $type: "com.linkedin.voyager.dash.publishing.CoverImage",
      caption: {
        $type: "com.linkedin.voyager.dash.common.text.TextViewModel",
        attributesV2: [],
        text: "",
        textDirection: "USER_LOCALE",
      },
      originalImage: originalImage(false),
      originalImageUrn: assetUrn,
    },
    coverMediaV2Union: {
      coverImage: {
        $type: "com.linkedin.voyager.dash.publishing.CoverImage",
        originalImage: originalImage(true),
        originalImageUrn: assetUrn,
      },
    },
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

function imageArticleRecipe(): WebSessionRecipe {
  return {
    site: "linkedin",
    action: "articles.draft.save",
    contractVersion: 7,
    timeoutMs: 60_000,
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

function personalProfileRecipe(): WebSessionRecipe {
  return {
    site: "linkedin",
    action: "profiles.read",
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 4 * 1024 * 1024,
  };
}

function organizationRecipe(): WebSessionRecipe {
  return {
    site: "linkedin",
    action: "organizations.read",
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 8 * 1024 * 1024,
  };
}

function htmlResponse(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function linkedInOrganizationStatsHtml(): string {
  const companyUrn = "urn:li:fsd_company:123";
  const followingStateUrn = "urn:li:fsd_followingState:organization-123";
  const encoded = JSON.stringify({
    data: {},
    included: [{
      $type: "com.linkedin.voyager.dash.organization.Company",
      entityUrn: companyUrn,
      universalName: "hraness",
      "*followingState": followingStateUrn,
      name: "Hraness",
      description: "Public company description",
      websiteUrl: "https://hraness.com",
    }, {
      $type: "com.linkedin.voyager.dash.feed.FollowingState",
      entityUrn: followingStateUrn,
      followerCount: 6,
    }],
  }).replace(/[&<>"=\\]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "=": "&#61;",
    "\\": "&#92;",
  })[character] ?? character);
  return `<html><body><code style="display: none" id="bpr-guid-123">${encoded}</code></body></html>`;
}

function postRecipe(): WebSessionRecipe {
  return {
    site: "linkedin",
    action: "posts.publish",
    contractVersion: 3,
    timeoutMs: 1_000,
    maxOutputBytes: 2 * 1024 * 1024,
  };
}

function pngFixture(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
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

  test("reads exact target-bound self followers and private connections sequentially", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = {
      ...dependencies(calls, (request) => {
        if (request.url.pathname === "/voyager/api/me") {
          return jsonResponse(currentIdentityResponse());
        }
        if (request.url.pathname === "/in/0thernet/") {
          expect(request.headers.get("accept")).toBe("text/html");
          return htmlResponse('<a href="/mynetwork/network-manager/people-follow/followers"><span>7,553</span> followers</a>');
        }
        if (request.url.pathname === "/mynetwork/invite-connect/connections/") {
          expect(request.headers.get("referer")).toBe("https://www.linkedin.com/in/0thernet/");
          return htmlResponse("<h1><span>4,877</span> connections</h1><button>Sort by:</button><label>Search with filters</label>");
        }
        throw new Error(`unexpected LinkedIn profile-stat request ${request.url.pathname}`);
      }),
      now: () => Date.parse("2026-08-21T15:00:00.000Z"),
    } satisfies LinkedInWebRuntimeDependencies;

    const result = await executeLinkedInWebOperation(personalProfileRecipe(), {
      profile_url: "https://www.linkedin.com/in/0thernet",
      include_connections: true,
    }, linkedinAuth, { dependencies: runtimeDependencies });

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({
      schemaVersion: 1,
      provider: "linkedin",
      target: {
        kind: "profile",
        id: MEMBER_URN,
        url: "https://www.linkedin.com/in/0thernet/",
      },
      observedAt: "2026-08-21T15:00:00.000Z",
      completeness: "complete",
      metrics: {
        followers: { status: "available", value: 7553, precision: "exact", unit: "count" },
        connections: { status: "available", value: 4877, precision: "exact", unit: "count" },
      },
      metadata: { profileSlug: "0thernet" },
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/voyager/api/me",
      "/in/0thernet/",
      "/mynetwork/invite-connect/connections/",
    ]);
  });

  test("reads one company follower total through the target company state reference", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = {
      ...dependencies(calls, (request) => {
        if (request.url.pathname === "/voyager/api/me") {
          return jsonResponse(currentIdentityResponse());
        }
        if (request.url.pathname === "/company/hraness/") {
          return htmlResponse(linkedInOrganizationStatsHtml());
        }
        throw new Error(`unexpected LinkedIn organization-stat request ${request.url.pathname}`);
      }),
      now: () => Date.parse("2026-08-21T15:00:00.000Z"),
    } satisfies LinkedInWebRuntimeDependencies;

    const result = await executeLinkedInWebOperation(organizationRecipe(), {
      organization_url: "https://www.linkedin.com/company/Hraness",
    }, linkedinAuth, { dependencies: runtimeDependencies });

    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({
      schemaVersion: 1,
      provider: "linkedin",
      target: {
        kind: "organization",
        id: "urn:li:fsd_company:123",
        url: "https://www.linkedin.com/company/hraness/",
      },
      observedAt: "2026-08-21T15:00:00.000Z",
      completeness: "complete",
      metrics: {
        followers: { status: "available", value: 6, precision: "exact", unit: "count" },
      },
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/voyager/api/me",
      "/company/hraness/",
    ]);
  });

  test("rejects a crossed personal-profile slug before reading either target page", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, (request) => {
      if (request.url.pathname === "/voyager/api/me") {
        return jsonResponse(currentIdentityResponse());
      }
      throw new Error("crossed personal-profile target must fail before page reads");
    });

    const result = await executeLinkedInWebOperation(personalProfileRecipe(), {
      profile_url: "https://www.linkedin.com/in/crossed-target",
      include_connections: true,
    }, linkedinAuth, { dependencies: runtimeDependencies });

    expect(result).toMatchObject({
      status: "failed",
      output: null,
      dispatchStarted: false,
    });
    expect(calls.map((call) => call.url.pathname)).toEqual(["/voyager/api/me"]);
  });

  test("requires one valid member-bound public identifier before personal page reads", async () => {
    const cases = [
      {
        body: {
          data: { plainId: MEMBER_ID, "*miniProfile": MINI_PROFILE_URN },
          included: [{
            entityUrn: MINI_PROFILE_URN,
            objectUrn: `urn:li:member:${MEMBER_ID}`,
          }],
        },
      },
      {
        body: {
          data: { plainId: MEMBER_ID, "*miniProfile": MINI_PROFILE_URN },
          included: [{
            entityUrn: MINI_PROFILE_URN,
            objectUrn: `urn:li:member:${MEMBER_ID}`,
            publicIdentifier: "bad/value",
          }],
        },
      },
    ] as const;

    for (const item of cases) {
      const calls: CapturedRequest[] = [];
      const result = await executeLinkedInWebOperation(personalProfileRecipe(), {
        profile_url: "https://www.linkedin.com/in/0thernet",
        include_connections: true,
      }, linkedinAuth, {
        dependencies: dependencies(calls, () => jsonResponse(item.body)),
      });
      expect(result).toMatchObject({
        status: "failed",
        output: null,
        dispatchStarted: false,
      });
      expect(calls.map((call) => call.url.pathname)).toEqual(["/voyager/api/me"]);
    }
  });

  test("fails closed before profile HTML reads when the bound LinkedIn member changes", async () => {
    const calls: CapturedRequest[] = [];
    const runtimeDependencies = dependencies(calls, () => jsonResponse({
      data: { plainId: "987654321" },
      included: [{ entityUrn: "urn:li:fsd_profile:987654321" }],
    }));
    const result = await executeLinkedInWebOperation(personalProfileRecipe(), {
      profile_url: "https://www.linkedin.com/in/0thernet",
      include_connections: true,
    }, linkedinAuth, { dependencies: runtimeDependencies });
    expect(result).toMatchObject({
      status: "failed",
      output: null,
      dispatchStarted: false,
    });
    expect(calls.map((call) => call.url.pathname)).toEqual(["/voyager/api/me"]);
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

  test("uploads one plan-bound image and verifies exact LinkedIn image order, alt text, caption, and asset identity", async () => {
    const title = "Image-capable private draft";
    const documentValue = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Before the image" },
        {
          type: "image",
          imageIndex: 0,
          altText: "Wrench logo on a dark background",
          caption: "Wrench",
        },
        { type: "paragraph", text: "After the image" },
      ],
    });
    const document = parseArticleDraftDocumentV2(documentValue, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
      maximumImages: 20,
    });
    const coverAssetUrn = "urn:li:digitalmediaAsset:C4D22AQCoverFixture";
    const assetUrn = "urn:li:digitalmediaAsset:C4D22AQFixtureAsset";
    const staleContent = structuredClone(
      buildLinkedInArticleContentV2(document, [assetUrn]),
    ) as Record<string, unknown>[];
    const staleImageBlock = staleContent[1]?.imageBlock as Record<string, unknown>;
    const staleImageContent = staleImageBlock.content as Record<string, unknown>;
    delete staleImageContent.accessibilityText;
    delete staleImageContent.accessibilityTextAttributes;
    let currentTitle = "Old title";
    let content: readonly Readonly<Record<string, unknown>>[] = staleContent;
    let currentCoverAssetUrn: string | null = null;
    const calls: string[] = [];
    const transport: LinkedInArticleBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
      prepareCreateDraft: () => Promise.reject(new Error("replacement must not create")),
      createDraft: () => Promise.reject(new Error("replacement must not create")),
      readDraftResponse: () => Promise.resolve(articleResponse(
        currentTitle,
        content,
        articleCoverFields(currentCoverAssetUrn),
      )),
      updateTitle: (_draftId, receivedTitle) => {
        calls.push("title");
        currentTitle = receivedTitle;
        return Promise.resolve();
      },
      updateContent: () => Promise.reject(new Error("image contract must not use v1 content")),
      uploadCoverImage: (_draftId, image) => {
        calls.push("cover-upload");
        expect(image).toMatchObject({
          filename: "cover-image-1.png",
          mediaType: "image/png",
        });
        return Promise.resolve(coverAssetUrn);
      },
      updateCover: (_draftId, receivedAssetUrn) => {
        calls.push("cover-bind");
        currentCoverAssetUrn = receivedAssetUrn;
        return Promise.resolve();
      },
      uploadInlineImage: (_draftId, image) => {
        calls.push("image");
        expect(image).toMatchObject({
          filename: "inline-image-1.png",
          mediaType: "image/png",
        });
        expect(image.bytes.byteLength).toBe(869_311);
        return Promise.resolve(assetUrn);
      },
      updateContentV2: (_draftId, receivedDocument, assets) => {
        calls.push("content");
        expect(receivedDocument).toEqual(document);
        expect(assets).toEqual([assetUrn]);
        const write = structuredClone(buildLinkedInArticleContentV2(document, assets));
        const wrapper = write[1] as Record<string, unknown>;
        const imageBlock = wrapper.imageBlock as Record<string, unknown>;
        const caption = imageBlock.caption as Record<string, unknown>;
        caption.attributesV2 = [];
        const imageContent = imageBlock.content as Record<string, unknown>;
        imageContent.accessibilityTextAttributes = [];
        const attribute = (imageContent.attributes as Record<string, unknown>[])[0]!;
        const detail = attribute.detailDataUnion as Record<string, unknown>;
        const vector = detail.vectorImage as Record<string, unknown>;
        vector.artifacts = [{
          $type: "com.linkedin.common.VectorArtifact",
          expiresAt: 1,
          fileIdentifyingUrlPathSegment: "fixture",
          height: 630,
          width: 1200,
        }];
        vector.rootUrl = "https://media.licdn.com/fixture/";
        content = write;
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const dispatches: string[] = [];
    const result = await executeLinkedInWebOperation(
      imageArticleRecipe(),
      {
        title,
        document: documentValue,
        draft_id: ARTICLE_ID,
        cover_image: { kind: "file", reference: "fixture-cover" },
        inline_images: [{ kind: "file", reference: "fixture-image" }],
      },
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: () => Promise.resolve(transport),
        },
        fileResolver: (files) => {
          expect(files).toHaveLength(1);
          const file = files[0];
          if (file === undefined) throw new Error("expected one plan-bound Article image");
          expect(["fixture-cover", "fixture-image"]).toContain(file.reference);
          return Promise.resolve([
            join(import.meta.dir, "..", "..", "website", "public", "og.png"),
          ]);
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
      dispatch: { planned: 3, started: 3, verified: 3 },
      output: {
        coverImageCount: 1,
        documentSchemaVersion: 2,
        draftId: ARTICLE_ID,
        inlineImageCount: 1,
        published: false,
        title,
      },
    });
    expect(calls).toEqual(["cover-upload", "cover-bind", "image", "title", "content"]);
    expect(dispatches).toEqual([
      "start:articles.cover",
      "verified:articles.cover",
      "start:articles.image[1]",
      "verified:articles.image[1]",
      "start:articles.replace",
      "verified:articles.replace",
    ]);
    await expect(readLinkedInWebArticleDraftDesiredState(
      imageArticleRecipe(),
      {
        title,
        document: documentValue,
        draft_id: ARTICLE_ID,
        cover_image: { kind: "file", reference: "fixture-cover" },
        inline_images: [{ kind: "file", reference: "fixture-image" }],
      },
      linkedinAuth,
    )).rejects.toThrow("supports only articles.draft.save@2");
  });

  test("preserves one exact existing banner while replacing a malformed private Article body", async () => {
    const title = "Recovered private draft";
    const documentValue = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Complete replacement body" },
        {
          type: "image",
          imageIndex: 0,
          altText: "A descriptive replacement image",
          caption: "Replacement",
        },
      ],
    });
    const document = parseArticleDraftDocumentV2(documentValue, {
      maximumBlocks: 5_000,
      maximumCharacters: 125_000,
      maximumImages: 20,
    });
    const coverAssetUrn = "urn:li:digitalmediaAsset:C4D22AQExistingCover";
    const imageAssetUrn = "urn:li:digitalmediaAsset:C4D22AQReplacementImage";
    let currentTitle = "Old title";
    let content: readonly Readonly<Record<string, unknown>>[] = [{
      $type: "com.linkedin.voyager.dash.publishing.ArticleImageBlock",
      imageBlock: {
        $type: "com.linkedin.voyager.dash.publishing.ImageBlock",
        content: { $type: "com.linkedin.voyager.dash.publishing.ImageContent", attributes: [] },
      },
    }];
    const calls: string[] = [];
    const transport: LinkedInArticleBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
      prepareCreateDraft: () => Promise.reject(new Error("replacement must not create")),
      createDraft: () => Promise.reject(new Error("replacement must not create")),
      readDraftResponse: () => Promise.resolve(articleResponse(
        currentTitle,
        content,
        articleCoverFields(coverAssetUrn),
      )),
      updateTitle: (_draftId, receivedTitle) => {
        calls.push("title");
        currentTitle = receivedTitle;
        return Promise.resolve();
      },
      updateContent: () => Promise.reject(new Error("image contract must not use v1 content")),
      uploadCoverImage: () => Promise.reject(new Error("existing cover must not be uploaded")),
      updateCover: () => Promise.reject(new Error("existing cover must not be rebound")),
      uploadInlineImage: () => {
        calls.push("image");
        return Promise.resolve(imageAssetUrn);
      },
      updateContentV2: (_draftId, receivedDocument, assets) => {
        calls.push("content");
        expect(receivedDocument).toEqual(document);
        expect(assets).toEqual([imageAssetUrn]);
        const write = structuredClone(buildLinkedInArticleContentV2(document, assets));
        const wrapper = write[1] as Record<string, unknown>;
        const imageBlock = wrapper.imageBlock as Record<string, unknown>;
        const caption = imageBlock.caption as Record<string, unknown>;
        caption.attributesV2 = [];
        const imageContent = imageBlock.content as Record<string, unknown>;
        imageContent.accessibilityTextAttributes = [];
        const attribute = (imageContent.attributes as Record<string, unknown>[])[0]!;
        const detail = attribute.detailDataUnion as Record<string, unknown>;
        const vector = detail.vectorImage as Record<string, unknown>;
        vector.artifacts = [{
          $type: "com.linkedin.common.VectorArtifact",
          expiresAt: 1,
          fileIdentifyingUrlPathSegment: "fixture",
          height: 630,
          width: 1200,
        }];
        vector.rootUrl = "https://media.licdn.com/fixture/";
        content = write;
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const dispatches: string[] = [];
    const result = await executeLinkedInWebOperation(
      imageArticleRecipe(),
      {
        title,
        document: documentValue,
        draft_id: ARTICLE_ID,
        inline_images: [{ kind: "file", reference: "fixture-image" }],
      },
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: () => Promise.resolve(transport),
        },
        fileResolver: () => Promise.resolve([
          join(import.meta.dir, "..", "..", "website", "public", "og.png"),
        ]),
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
      dispatch: { planned: 2, started: 2, verified: 2 },
      output: {
        coverImageCount: 1,
        draftId: ARTICLE_ID,
        inlineImageCount: 1,
        published: false,
        title,
      },
    });
    expect(calls).toEqual(["image", "title", "content"]);
    expect(dispatches).toEqual([
      "start:articles.image[1]",
      "verified:articles.image[1]",
      "start:articles.replace",
      "verified:articles.replace",
    ]);
  });

  test.each([
    {
      privateDiagnostic: "LinkedIn Article image registration response.data.value has unsupported fields",
      publicCategory: "image-registration-response-drift",
    },
    {
      privateDiagnostic: "LinkedIn image staging changed shape around a private browser key",
      publicCategory: "image-byte-staging-failed",
    },
    {
      privateDiagnostic: "LinkedIn Article image upload returned an unreviewed private response",
      publicCategory: "image-transfer-response-drift",
    },
  ])("categorizes Article image failures as $publicCategory without leaking diagnostics", async ({
    privateDiagnostic,
    publicCategory,
  }) => {
    const document = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Before" },
        { type: "image", imageIndex: 0, altText: "A descriptive fixture image" },
      ],
    });
    const coverAssetUrn = "urn:li:digitalmediaAsset:C4D22AQCoverFixture";
    let currentCoverAssetUrn: string | null = null;
    const transport: LinkedInArticleBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
      prepareCreateDraft: () => Promise.reject(new Error("replacement must not create")),
      createDraft: () => Promise.reject(new Error("replacement must not create")),
      readDraftResponse: () => Promise.resolve(articleResponse(
        "Old title",
        [],
        articleCoverFields(currentCoverAssetUrn),
      )),
      updateTitle: () => Promise.reject(new Error("failed upload must not replace title")),
      updateContent: () => Promise.reject(new Error("failed upload must not replace content")),
      uploadCoverImage: () => Promise.resolve(coverAssetUrn),
      updateCover: (_draftId, assetUrn) => {
        currentCoverAssetUrn = assetUrn;
        return Promise.resolve();
      },
      uploadInlineImage: () => Promise.reject(new Error(privateDiagnostic)),
      updateContentV2: () => Promise.reject(new Error("failed upload must not replace content")),
      close: () => Promise.resolve(),
    };
    const result = await executeLinkedInWebOperation(
      imageArticleRecipe(),
      {
        title: "Private fixture",
        document,
        draft_id: ARTICLE_ID,
        cover_image: { kind: "file", reference: "fixture-cover" },
        inline_images: [{ kind: "file", reference: "fixture-image" }],
      },
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: () => Promise.resolve(transport),
        },
        fileResolver: () => Promise.resolve([
          join(import.meta.dir, "..", "..", "website", "public", "og.png"),
        ]),
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatch: { planned: 3, started: 2, verified: 1 },
      error: expect.stringContaining(publicCategory),
    });
    expect(JSON.stringify(result)).not.toContain(privateDiagnostic);
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

  test.each([
    ["LinkedIn Article image registration request failed", "image-registration-request-failed"],
    ["LinkedIn Article image registration response drifted", "image-registration-response-drift"],
    ["LinkedIn Article image registration shape drifted", "image-registration-shape-drift"],
    [
      "LinkedIn Article image registration shape drifted:registration-fields-e3u1-d2u0-r7c4u2-h1u1-ts-pa",
      "image-registration-shape-registration-fields-e3u1-d2u0-r7c4u2-h1u1-ts-pa",
    ],
    ["LinkedIn Article image staging failed", "image-staging-failed"],
    ["LinkedIn Article image signed transfer failed", "image-transfer-failed"],
    ["LinkedIn Article image signed transfer status drifted", "image-transfer-status-drift"],
  ])("categorizes private Article image failures as %s", async (
    privateDiagnostic,
    publicCategory,
  ) => {
    const document = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Private fixture body" },
        {
          type: "image",
          imageIndex: 0,
          altText: "A bounded fixture image",
        },
      ],
    });
    const existingCoverAssetUrn = "urn:li:digitalmediaAsset:C4D22AQExistingCover";
    const transport: LinkedInArticleBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
      prepareCreateDraft: () => Promise.reject(new Error("replacement must not create")),
      createDraft: () => Promise.reject(new Error("replacement must not create")),
      readDraftResponse: () => Promise.resolve(articleResponse(
        "Private fixture",
        [],
        articleCoverFields(existingCoverAssetUrn),
      )),
      updateTitle: () => Promise.reject(new Error("failed images must not update title")),
      updateContent: () => Promise.reject(new Error("failed images must not update content")),
      uploadInlineImage: () => Promise.reject(new Error(privateDiagnostic)),
      updateContentV2: () => Promise.reject(new Error("failed images must not update content")),
      close: () => Promise.resolve(),
    };
    const result = await executeLinkedInWebOperation(
      imageArticleRecipe(),
      {
        title: "Private fixture",
        document,
        draft_id: ARTICLE_ID,
        inline_images: [{ kind: "file", reference: "fixture-image" }],
      },
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: () => Promise.resolve(transport),
        },
        fileResolver: () => Promise.resolve([
          join(import.meta.dir, "..", "..", "website", "public", "og.png"),
        ]),
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 2, started: 1, verified: 0 },
      error: expect.stringContaining(publicCategory),
    });
    expect(JSON.stringify(result)).not.toContain(privateDiagnostic);
  });

  test("distinguishes contained-browser startup from current-member read failures before dispatch", async () => {
    const input = {
      title: "Private fixture",
      document: canonicalJson({
        schemaVersion: 1,
        blocks: [{ type: "paragraph", text: "Private body" }],
      }),
      draft_id: ARTICLE_ID,
    };
    const startup = await executeLinkedInWebOperation(
      articleRecipe(),
      input,
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: () => Promise.reject(
            new Error("private contained-browser startup detail"),
          ),
        },
      },
    );
    expect(startup).toMatchObject({
      status: "failed",
      dispatch: { planned: 1, started: 0, verified: 0 },
      error: expect.stringContaining("starting the contained LinkedIn Article browser"),
    });
    expect(JSON.stringify(startup)).not.toContain("private contained-browser startup detail");

    const transport: LinkedInArticleBrowserTransport = {
      currentIdentityResponse: () => Promise.reject(
        new Error("private current-member response detail"),
      ),
      prepareCreateDraft: () => Promise.reject(new Error("must not create")),
      createDraft: () => Promise.reject(new Error("must not create")),
      readDraftResponse: () => Promise.reject(new Error("must not read draft")),
      updateTitle: () => Promise.reject(new Error("must not update title")),
      updateContent: () => Promise.reject(new Error("must not update content")),
      close: () => Promise.resolve(),
    };
    const identity = await executeLinkedInWebOperation(
      articleRecipe(),
      input,
      linkedinAuth,
      {
        dependencies: {
          createArticleBrowserTransport: () => Promise.resolve(transport),
        },
      },
    );
    expect(identity).toMatchObject({
      status: "failed",
      dispatch: { planned: 1, started: 0, verified: 0 },
      error: expect.stringContaining(
        "reading the current LinkedIn member in the contained browser",
      ),
    });
    expect(JSON.stringify(identity)).not.toContain("private current-member response detail");
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

  test("admits once, uploads one plan-bound PNG, creates one post, and verifies exact readback", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-linkedin-post-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    const imageBytes = pngFixture(959, 1022);
    writeFileSync(imagePath, imageBytes, { mode: 0o600 });
    const body = "how your email finds me";
    const altText = "Two people stand outside in warm sunlight.";
    const mediaUrn = "urn:li:digitalmediaAsset:C4D22AQExactImage";
    const entityUrn = "urn:li:fsd_share:7000000000000000000";
    const finalUrl = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/";
    const events: string[] = [];
    try {
      const transport: LinkedInPostBrowserTransport = {
        currentIdentityResponse: () => {
          events.push("identity");
          return Promise.resolve(currentIdentityResponse());
        },
        uploadImage: (subject, bytes) => {
          events.push("upload");
          expect(subject).toBe(MEMBER_URN);
          expect(bytes).toEqual(new Uint8Array(imageBytes));
          return Promise.resolve(mediaUrn);
        },
        createPost: (subject, profileUrn, variables, receivedMediaUrn) => {
          events.push("create");
          expect(subject).toBe(MEMBER_URN);
          expect(profileUrn).toBe(ARTICLE_PROFILE_URN);
          expect(receivedMediaUrn).toBe(mediaUrn);
          expect(variables).toMatchObject({
            post: {
              commentary: { text: body },
              intendedShareLifeCycleState: "PUBLISHED",
              media: { altText, category: "IMAGE", mediaUrn },
              visibilityDataUnion: { visibilityType: "ANYONE" },
            },
          });
          return Promise.resolve(entityUrn);
        },
        readPost: (subject, profileUrn, variables, receivedMediaUrn, receivedEntityUrn) => {
          events.push("readback");
          expect(subject).toBe(MEMBER_URN);
          expect(profileUrn).toBe(ARTICLE_PROFILE_URN);
          expect(receivedMediaUrn).toBe(mediaUrn);
          expect(receivedEntityUrn).toBe(entityUrn);
          expect(variables).toMatchObject({
            post: { commentary: { text: body } },
          });
          return Promise.resolve({
            actorMatched: true,
            entityMatched: true,
            entityUrn,
            lifecycle: "PUBLISHED",
            mediaMatched: true,
            mediaUrn,
            textMatched: true,
            url: finalUrl,
          });
        },
        close: () => {
          events.push("close");
          return Promise.resolve();
        },
      };
      const result = await executeLinkedInWebOperation(
        postRecipe(),
        {
          alt_text: altText,
          body,
          media: [{ kind: "file", reference: "fixture" }],
          visibility: "public",
        },
        linkedinAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          dependencies: {
            createPostBrowserTransport: () => Promise.resolve(transport),
          },
          beforeDispatch: (event) => {
            events.push(`before:${event.progress.started}`);
            return Promise.resolve();
          },
          afterProviderAcceptedMutationTarget: (event) => {
            expect(event).toEqual({
              id: "posts.publish",
              index: 1,
              target: {
                schemaVersion: 1,
                identifier: canonicalJson({ entityUrn, mediaUrn }),
              },
            });
            events.push(`accepted:${event.target.identifier}`);
            return Promise.resolve();
          },
          afterDispatchVerified: (event) => {
            events.push(`after:${event.progress.verified}`);
            return Promise.resolve();
          },
        },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        output: {
          provider: "linkedin",
          operation: "posts.publish",
          post: { entityUrn, url: finalUrl },
          visibility: "public",
          image: {
            altText,
            height: 1022,
            mediaType: "image/png",
            width: 959,
          },
        },
        finalUrl,
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
      expect(events).toEqual([
        "identity",
        "upload",
        "before:0",
        "create",
        `accepted:${canonicalJson({ entityUrn, mediaUrn })}`,
        "readback",
        "after:1",
        "close",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a preparatory upload failure before public-post admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-linkedin-upload-failure-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, pngFixture(959, 1022), { mode: 0o600 });
    let admissions = 0;
    let uploads = 0;
    let creates = 0;
    try {
      const transport: LinkedInPostBrowserTransport = {
        currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
        uploadImage: () => {
          uploads += 1;
          return Promise.reject(new Error("uncertain upload result"));
        },
        createPost: () => {
          creates += 1;
          return Promise.reject(new Error("must not create after upload failure"));
        },
        readPost: () => Promise.reject(new Error("must not read after upload failure")),
        close: () => Promise.resolve(),
      };
      const result = await executeLinkedInWebOperation(
        postRecipe(),
        {
          body: "do not retry",
          media: [{ kind: "file", reference: "fixture" }],
          visibility: "public",
        },
        linkedinAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          dependencies: {
            createPostBrowserTransport: () => Promise.resolve(transport),
          },
          beforeDispatch: () => {
            admissions += 1;
            return Promise.resolve();
          },
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
        error: expect.stringMatching(
          /failure stage: image preparation; retry with a fresh confirmed plan/u,
        ),
      });
      expect(admissions).toBe(0);
      expect(uploads).toBe(1);
      expect(creates).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a post-create response failure indeterminate after exact admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-linkedin-create-failure-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, pngFixture(959, 1022), { mode: 0o600 });
    let admissions = 0;
    let uploads = 0;
    let creates = 0;
    try {
      const transport: LinkedInPostBrowserTransport = {
        currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
        uploadImage: () => {
          uploads += 1;
          return Promise.resolve("urn:li:digitalmediaAsset:C4D22AQPreparedImage");
        },
        createPost: () => {
          creates += 1;
          return Promise.reject(new LinkedInPostCreateResponseError(
            new Error("LinkedIn post create omitted its entity: private create response detail"),
          ));
        },
        readPost: () => Promise.reject(new Error("must not read after create failure")),
        close: () => Promise.resolve(),
      };
      const result = await executeLinkedInWebOperation(
        postRecipe(),
        {
          body: "indeterminate create",
          media: [{ kind: "file", reference: "fixture" }],
          visibility: "public",
        },
        linkedinAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          dependencies: {
            createPostBrowserTransport: () => Promise.resolve(transport),
          },
          beforeDispatch: () => {
            admissions += 1;
            return Promise.resolve();
          },
        },
      );
      expect(JSON.stringify(result)).not.toContain("private create response detail");
      expect(result).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
        error: expect.stringMatching(
          /failure stage: post create entity absent; reconcile before retrying/u,
        ),
      });
      expect(admissions).toBe(1);
      expect(uploads).toBe(1);
      expect(creates).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads only the exact accepted LinkedIn post target for later presence reconciliation", async () => {
    const body = "how your email finds me";
    const mediaUrn = "urn:li:digitalmediaAsset:C4D22AQExactImage";
    const entityUrn = "urn:li:fsd_share:7000000000000000000";
    const finalUrl = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/";
    let uploads = 0;
    let creates = 0;
    let reads = 0;
    const transport: LinkedInPostBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve(currentIdentityResponse()),
      uploadImage: () => {
        uploads += 1;
        return Promise.reject(new Error("accepted-target read must not upload"));
      },
      createPost: () => {
        creates += 1;
        return Promise.reject(new Error("accepted-target read must not create"));
      },
      readPost: (subject, profileUrn, variables, receivedMediaUrn, receivedEntityUrn) => {
        reads += 1;
        expect(subject).toBe(MEMBER_URN);
        expect(profileUrn).toBe(ARTICLE_PROFILE_URN);
        expect(receivedMediaUrn).toBe(mediaUrn);
        expect(receivedEntityUrn).toBe(entityUrn);
        expect(variables).toMatchObject({
          post: {
            commentary: { text: body },
            media: { mediaUrn },
            visibilityDataUnion: { visibilityType: "ANYONE" },
          },
        });
        return Promise.resolve({
          actorMatched: true,
          entityMatched: true,
          entityUrn,
          lifecycle: "PUBLISHED",
          mediaMatched: true,
          mediaUrn,
          textMatched: true,
          url: finalUrl,
        });
      },
      close: () => Promise.resolve(),
    };

    expect(await readLinkedInWebAcceptedPostTargetPresence(
      postRecipe(),
      {
        body,
        media: [{ kind: "file", reference: "fixture" }],
        visibility: "public",
      },
      linkedinAuth,
      canonicalJson({ entityUrn, mediaUrn }),
      {
        dependencies: {
          createPostBrowserTransport: () => Promise.resolve(transport),
        },
      },
    )).toEqual({ present: true, entityUrn, mediaUrn });
    expect(uploads).toBe(0);
    expect(creates).toBe(0);
    expect(reads).toBe(1);
    await expect(readLinkedInWebAcceptedPostTargetPresence(
      postRecipe(),
      {
        body,
        media: [{ kind: "file", reference: "fixture" }],
        visibility: "public",
      },
      linkedinAuth,
      JSON.stringify({ mediaUrn, entityUrn }),
      {
        dependencies: {
          createPostBrowserTransport: () => Promise.resolve(transport),
        },
      },
    )).rejects.toThrow("canonical JSON");
    expect(reads).toBe(1);
  });

  test("rejects a changed LinkedIn member before durable post admission", async () => {
    let admissions = 0;
    let uploads = 0;
    const transport: LinkedInPostBrowserTransport = {
      currentIdentityResponse: () => Promise.resolve({
        data: { plainId: "987654321", "*miniProfile": MINI_PROFILE_URN },
        included: [{ entityUrn: MINI_PROFILE_URN, objectUrn: "urn:li:member:987654321" }],
      }),
      uploadImage: () => {
        uploads += 1;
        return Promise.reject(new Error("must not upload"));
      },
      createPost: () => Promise.reject(new Error("must not create")),
      readPost: () => Promise.reject(new Error("must not read")),
      close: () => Promise.resolve(),
    };
    const result = await executeLinkedInWebOperation(
      postRecipe(),
      { body: "account-bound", visibility: "public" },
      linkedinAuth,
      {
        dependencies: {
          createPostBrowserTransport: () => Promise.resolve(transport),
        },
        beforeDispatch: () => {
          admissions += 1;
          return Promise.resolve();
        },
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
    });
    expect(admissions).toBe(0);
    expect(uploads).toBe(0);
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
