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
  readonly partialUpdate: boolean;
  readonly response: "json" | "status" | "created";
};

function requestBinding(source: string): BrowserRequestBinding {
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
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open") {
          expect(command).toEqual(["open", "https://www.linkedin.com/feed/"]);
          return Promise.resolve([{ success: true, result: { url: command[1] } }]);
        }
        if (command?.[0] !== "eval" || command[1] === undefined) {
          throw new Error(`unexpected LinkedIn Article browser command ${command?.[0] ?? "missing"}`);
        }
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
        if (request.method === "GET") {
          return Promise.resolve([browserRecord({
            body: { data: { "*elements": [] }, included: [] },
            contentType: "application/json",
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
    expect(await transport.createDraft(ARTICLE_PROFILE_URN, title)).toBe(
      `urn:li:fsd_firstPartyArticle:${ARTICLE_ID}`,
    );
    expect(await transport.readDraftResponse(ARTICLE_ID)).toEqual({
      data: { "*elements": [] },
      included: [],
    });
    await transport.updateTitle(ARTICLE_ID, title);
    await transport.updateContent(ARTICLE_ID, document);
    await transport.close();

    expect(closed).toBeTrue();
    expect(cleaned).toBeTrue();
    expect(requests).toHaveLength(5);
    expect(requests[0]).toEqual({
      method: "GET",
      path: "/voyager/api/me",
      referrer: "https://www.linkedin.com/feed/",
      body: null,
      partialUpdate: false,
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
    expect(requests.slice(2).every((request) =>
      request.path === `/voyager/api/voyagerPublishingDashFirstPartyArticles/${encodeURIComponent(`urn:li:fsd_firstPartyArticle:${ARTICLE_ID}`)}`
      || request.path.startsWith("/voyager/api/voyagerPublishingDashFirstPartyArticles?")))
      .toBeTrue();
    expect(requests.every((request) => !/(?:^|\/)(?:publish|share)(?:\/|$)/iu.test(request.path)))
      .toBeTrue();
  });

  test("rejects a cross-origin evaluation envelope and still permits verified finalization", async () => {
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: (commands) => commands[0]?.[0] === "open"
        ? Promise.resolve([{ success: true, result: { url: "https://www.linkedin.com/feed/" } }])
        : Promise.resolve([browserRecord({
            body: {},
            contentType: "application/json",
            status: 200,
          }, "https://attacker.example/linkedin")]),
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
