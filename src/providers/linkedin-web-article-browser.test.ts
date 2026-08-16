import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type { BrowserSession } from "../browser";
import { canonicalJson } from "../canonical-json";
import { parseArticleDraftDocument } from "../article-draft-document";
import {
  buildLinkedInArticleContentPatch,
  buildLinkedInArticleCreateBody,
  buildLinkedInArticleTitlePatch,
} from "./linkedin-web";
import { createLinkedInArticleBrowserTransport } from "./linkedin-web-article-browser";

const MEMBER_URN = "urn:li:fsd_profile:123456789";
const ARTICLE_ID = "7000000000000000001";
const ARTICLE_PROFILE_URN = "urn:li:fsd_profile:ACoAAExactCurrentProfile";

const auth = {
  schemaVersion: 1,
  id: "linkedin-browser-test",
  kind: "browser-profile",
  profile: "Persistent LinkedIn",
  browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  trustUnfilteredEgress: true,
  subject: MEMBER_URN,
} as const satisfies WrenchAuth;

type BrowserRequestBinding = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly referrer: string;
  readonly body: string | null;
  readonly pageInstance: string | null;
  readonly track: string | null;
  readonly response: "json" | "status" | "created" | "page";
};

const NEW_PAGE_INSTANCE =
  "urn:li:page:d_flagship3_publishing_post_new;fixture==";
const EDIT_PAGE_INSTANCE =
  "urn:li:page:d_flagship3_publishing_post_edit;fixture==";
const TRACK = JSON.stringify({
  clientVersion: "1.2.3.4.5",
  mpVersion: "1.2.3.4.5",
  osName: "web",
  timezoneOffset: -4,
  timezone: "America/Puerto_Rico",
  deviceFormFactor: "DESKTOP",
  mpName: "voyager-web",
  displayDensity: 2,
  displayWidth: 1440,
  displayHeight: 900,
});

const evaluatorSyntax = new Bun.Transpiler({ loader: "js" });

function articleResponse(title: string): unknown {
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
      content: [],
      contentDescription: null,
      contentHtml: "",
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

function articlePayloads(title: string): unknown {
  const body = JSON.stringify(articleResponse(title)).replace(
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
  return [{ attributes: 'style="display: none" id="bpr-guid-123456"', body }];
}

function requestBinding(source: string): BrowserRequestBinding {
  expect(() => evaluatorSyntax.transformSync(source)).not.toThrow();
  const match = /const input=(\{.*?\});if\(location\.origin/u.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("test browser evaluation omitted its fixed request binding");
  }
  return JSON.parse(match[1]) as BrowserRequestBinding;
}

function browserRecord(
  result: Readonly<Record<string, unknown>>,
  origin = "https://www.linkedin.com/feed/",
): Readonly<Record<string, unknown>> {
  return {
    success: true,
    result: { origin, result },
  };
}

describe("LinkedIn native Article contained-browser transport", () => {
  test("executes only the fixed current-member and private Article API family inside the bound browser", async () => {
    const title = "Private fixture";
    const document = parseArticleDraftDocument(canonicalJson({
      schemaVersion: 1,
      blocks: [{
        type: "paragraph",
        text: "Read the source",
        links: [{ offset: 9, length: 6, url: "https://example.com/source" }],
      }],
    }), { maximumBlocks: 5_000, maximumCharacters: 125_000 });
    const requests: BrowserRequestBinding[] = [];
    const opened: string[] = [];
    let waits = 0;
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open") {
          if (command[1] === undefined) throw new Error("missing LinkedIn Article browser URL");
          opened.push(command[1]);
          return Promise.resolve([{ success: true, result: { url: command[1] } }]);
        }
        if (command?.[0] === "wait") {
          waits += 1;
          return Promise.resolve([{ success: true, result: { waited: true } }]);
        }
        if (command?.[0] === "network") {
          const pageInstance = opened.at(-1) === "https://www.linkedin.com/article/new/"
            ? NEW_PAGE_INSTANCE
            : EDIT_PAGE_INSTANCE;
          return Promise.resolve([{
            success: true,
            result: {
              requests: [{
                method: "GET",
                status: 200,
                url: "https://www.linkedin.com/voyager/api/graphql?fixture=1",
                headers: {
                  "x-li-page-instance": pageInstance,
                  "x-li-track": TRACK,
                },
              }],
            },
          }]);
        }
        if (command?.[0] !== "eval" || command[1] === undefined) {
          throw new Error(`unexpected LinkedIn Article browser command ${command?.[0] ?? "missing"}`);
        }
        expect(command[1]).toContain('headers["x-li-page-instance"]');
        expect(command[1]).toContain(
          'headers["x-li-pem-metadata"]="Voyager - Article Creator=autosave-article"',
        );
        expect(command[1]).toContain('headers["x-li-track"]');
        const request = requestBinding(command[1]);
        requests.push(request);
        if (request.path === "/voyager/api/me") {
          return Promise.resolve([browserRecord({
            body: { data: { plainId: "123456789" } },
            contentType: "application/vnd.linkedin.normalized+json+2.1",
            status: 200,
          })]);
        }
        if (request.path === "/voyager/api/voyagerPublishingDashFirstPartyArticles/") {
          return Promise.resolve([browserRecord({
            contentType: "",
            responseId: `urn:li:fsd_firstPartyArticle:${ARTICLE_ID}`,
            status: 201,
          })]);
        }
        if (request.response === "page") {
          return Promise.resolve([browserRecord({
            contentType: "text/html",
            payloads: articlePayloads(title),
            status: 200,
          })]);
        }
        return Promise.resolve([browserRecord({ contentType: "", status: 200 })]);
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

    const transport = await createLinkedInArticleBrowserTransport(auth, {
      timeoutMs: 1_000,
      dependencies: {
        createBrowserSession: (manifest, receivedAuth, options) => {
          expect(manifest).toMatchObject({
            id: "linkedin-article-runtime",
            origins: ["https://www.linkedin.com"],
          });
          expect(receivedAuth).toBe(auth);
          expect(options).toMatchObject({
            allowCodeOwnedEvaluation: true,
            allowCodeOwnedNetworkObservation: true,
            headed: true,
            maxOutputBytes: 2 * 1024 * 1024,
          });
          return Promise.resolve(session);
        },
      },
    });

    expect(await transport.currentIdentityResponse()).toEqual({
      data: { plainId: "123456789" },
    });
    await transport.prepareCreateDraft();
    expect(await transport.createDraft(ARTICLE_PROFILE_URN, title)).toBe(
      `urn:li:fsd_firstPartyArticle:${ARTICLE_ID}`,
    );
    expect(await transport.readDraftResponse(ARTICLE_ID)).toEqual(articleResponse(title));
    await transport.updateTitle(ARTICLE_ID, title);
    await transport.updateContent(ARTICLE_ID, document);
    await transport.close();

    expect(closed).toBeTrue();
    expect(cleaned).toBeTrue();
    expect(opened).toEqual([
      "https://www.linkedin.com/feed/",
      "https://www.linkedin.com/article/new/",
      `https://www.linkedin.com/article/edit/${ARTICLE_ID}/`,
    ]);
    expect(waits).toBe(2);
    expect(requests).toHaveLength(5);
    expect(requests[0]).toEqual({
      method: "GET",
      path: "/voyager/api/me",
      referrer: "https://www.linkedin.com/feed/",
      body: null,
      pageInstance: null,
      track: null,
      response: "json",
    });
    expect(JSON.parse(requests[1]?.body ?? "null")).toEqual(
      buildLinkedInArticleCreateBody(ARTICLE_PROFILE_URN, title),
    );
    expect(JSON.parse(requests[3]?.body ?? "null")).toEqual(
      buildLinkedInArticleTitlePatch(title),
    );
    expect(JSON.parse(requests[4]?.body ?? "null")).toEqual(
      buildLinkedInArticleContentPatch(document),
    );
    expect(requests[2]).toEqual({
      method: "GET",
      path: `/article/edit/${ARTICLE_ID}/`,
      referrer: `https://www.linkedin.com/article/edit/${ARTICLE_ID}/`,
      body: null,
      pageInstance: null,
      track: null,
      response: "page",
    });
    expect(requests[1]).toMatchObject({
      pageInstance: NEW_PAGE_INSTANCE,
      track: TRACK,
    });
    expect(requests[3]).toMatchObject({
      pageInstance: EDIT_PAGE_INSTANCE,
      track: TRACK,
    });
    expect(requests[4]).toMatchObject({
      pageInstance: EDIT_PAGE_INSTANCE,
      track: TRACK,
    });
    expect(requests.slice(3).every((request) =>
      request.path === `/voyager/api/voyagerPublishingDashFirstPartyArticles/urn:li:fsd_firstPartyArticle:${ARTICLE_ID}`))
      .toBeTrue();
    expect(requests.every((request) => !/(?:^|\/)(?:publish|share)(?:\/|$)/iu.test(request.path)))
      .toBeTrue();
  });

  test("rejects a cross-origin evaluation envelope and still permits verified finalization", async () => {
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: (commands) => {
        if (commands[0]?.[0] === "open") {
          return Promise.resolve([{ success: true, result: { url: "https://www.linkedin.com/feed/" } }]);
        }
        return Promise.resolve([browserRecord({
            body: {},
            contentType: "application/json",
            status: 200,
          }, "https://attacker.example/linkedin")]);
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
    const transport = await createLinkedInArticleBrowserTransport(auth, {
      timeoutMs: 1_000,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    await expect(transport.currentIdentityResponse()).rejects.toThrow(
      "malformed evaluation envelope",
    );
    await transport.close();
    expect(closed).toBeTrue();
    expect(cleaned).toBeTrue();
  });

  test("retries only the read-only editor binding once before any Article dispatch", async () => {
    let networkAttempts = 0;
    let editOpens = 0;
    let evaluations = 0;
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open") {
          if (command[1]?.includes("/article/edit/") === true) editOpens += 1;
          return Promise.resolve([{ success: true, result: { url: command[1] } }]);
        }
        if (command?.[0] === "wait") {
          return Promise.resolve([{ success: true, result: { waited: true } }]);
        }
        if (command?.[0] === "network") {
          networkAttempts += 1;
          if (networkAttempts === 1) {
            return Promise.reject(new Error("transient read-only observation failure"));
          }
          return Promise.resolve([{
            success: true,
            result: {
              requests: [{
                method: "GET",
                status: 200,
                url: "https://www.linkedin.com/voyager/api/graphql?fixture=1",
                headers: {
                  "x-li-page-instance": EDIT_PAGE_INSTANCE,
                  "x-li-track": TRACK,
                },
              }],
            },
          }]);
        }
        if (command?.[0] !== "eval") throw new Error("unexpected browser command");
        evaluations += 1;
        return Promise.resolve([browserRecord({
          contentType: "text/html",
          payloads: articlePayloads("Private fixture"),
          status: 200,
        })]);
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createLinkedInArticleBrowserTransport(auth, {
      timeoutMs: 60_000,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    expect(await transport.readDraftResponse(ARTICLE_ID)).toEqual(
      articleResponse("Private fixture"),
    );
    await transport.close();
    expect(networkAttempts).toBe(2);
    expect(editOpens).toBe(2);
    expect(evaluations).toBe(1);
  });

  test("closes and cleans a session when the fixed feed bootstrap fails", async () => {
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: () => Promise.reject(new Error("feed bootstrap failed")),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      cleanup: () => {
        cleaned = true;
        return Promise.resolve();
      },
    };
    await expect(createLinkedInArticleBrowserTransport(auth, {
      timeoutMs: 1_000,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    })).rejects.toThrow("feed bootstrap failed");
    expect(closed).toBeTrue();
    expect(cleaned).toBeTrue();
  });
});
