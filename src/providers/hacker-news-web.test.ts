import { describe, expect, test } from "bun:test";

import hackerNewsWebManifest from "../assets/adapters/hacker-news/wrench-web-adapter.json";
import {
  HACKER_NEWS_WEB_OPERATION_NAMES,
  HACKER_NEWS_WEB_OPERATIONS,
  authorizeHackerNewsReadRequest,
  normalizeHackerNewsCommentsHtml,
  normalizeHackerNewsFeedHtml,
  normalizeHackerNewsPostHtml,
  parseHackerNewsCommentForm,
  parseHackerNewsFavoriteAction,
  parseHackerNewsSubmissionForm,
  parseHackerNewsViewerHtml,
} from "./hacker-news-web";

const POST_ID = "49020868";
const SECOND_POST_ID = "49020869";
const COMMENT_ID = "49021000";
const REPLY_ID = "49021001";
const AUTH = "synthetic-request-bound-auth";
const HMAC = "synthetic-request-bound-hmac";
const FNID = "synthetic-request-bound-fnid";
const FNOP = "submit-page";

function viewer(): string {
  return `<span class="pagetop"><a href="user?id=wrench_user" id="me">wrench_user</a></span>`;
}

function submission(
  id: string,
  title = "A useful story",
  extra = "",
): string {
  return [
    `<tr class="athing submission" id="${id}">`,
    "<td class=\"title\">",
    `<span class="titleline"><a href="https://example.com/${id}">${title}</a><span class="sitebit"> (example.com)</span></span>`,
    "</td>",
    "</tr>",
    "<tr><td class=\"subtext\">",
    `<span class="score" id="score_${id}">42 points</span> by `,
    `<a href="user?id=author_${id}" class="hnuser">author_${id}</a> `,
    `<span class="age" title="2026-07-23T12:00:00 1784808000"><a href="item?id=${id}">1 hour ago</a></span> | `,
    `<a href="item?id=${id}">3&nbsp;comments</a>`,
    "</td></tr>",
    extra,
  ].join("");
}

function comment(
  id: string,
  depth: number,
  body: string,
  parentId: string | null,
): string {
  return [
    `<tr class="athing comtr" id="${id}">`,
    "<td><table><tr>",
    `<td class="ind" indent="${depth}"><img src="s.gif" width="${depth * 40}"></td>`,
    "<td class=\"default\">",
    `<span class="comhead"><a href="user?id=user_${id}" class="hnuser">user_${id}</a> `,
    `<span class="age" title="2026-07-23T12:01:00 1784808060"><a href="item?id=${id}">59 minutes ago</a></span>`,
    parentId === null ? "" : `<span class="navs"> | <a href="#${parentId}">parent</a></span>`,
    "</span>",
    `<div class="comment"><div class="commtext c00">${body}</div></div>`,
    "</td></tr></table></td></tr>",
  ].join("");
}

function itemPage(): string {
  return [
    "<html><body>",
    viewer(),
    submission(POST_ID, "Ask HN: A &amp; B?", `<tr><td><div class="toptext">Line one<p>Line two</div></td></tr>`),
    comment(COMMENT_ID, 0, "First &lt;comment&gt;", null),
    comment(REPLY_ID, 1, "Nested<br>reply", COMMENT_ID),
    "</body></html>",
  ].join("");
}

describe("Hacker News internal-web operation registry", () => {
  test("ships one schema-v4 semantic manifest entry for every provider operation", () => {
    expect(hackerNewsWebManifest.schemaVersion).toBe(4);
    expect(hackerNewsWebManifest.id).toBe("hacker-news-web");
    expect(hackerNewsWebManifest.surfaceId).toBe("hacker-news");
    expect(hackerNewsWebManifest.origins).toEqual(["https://news.ycombinator.com"]);
    expect(Object.keys(hackerNewsWebManifest.operations).sort()).toEqual(
      [...HACKER_NEWS_WEB_OPERATION_NAMES].sort(),
    );
    for (const action of HACKER_NEWS_WEB_OPERATION_NAMES) {
      const operation = hackerNewsWebManifest.operations[action];
      const state = HACKER_NEWS_WEB_OPERATIONS[action].state;
      expect(operation.description.startsWith(
        state === "observed"
          ? "Observed contract:"
          : "Capture-required contract reservation:",
      )).toBe(true);
      expect(operation.webSession).toMatchObject({
        site: "hacker-news",
        action,
        contractVersion: 1,
      });
      expect("browser" in operation).toBe(false);
      expect("provider" in operation).toBe(false);
    }
  });

  test("covers the full surface and keeps every remote action capture-required", () => {
    expect(Object.keys(HACKER_NEWS_WEB_OPERATIONS).sort()).toEqual(
      [...HACKER_NEWS_WEB_OPERATION_NAMES].sort(),
    );
    expect(
      Object.entries(HACKER_NEWS_WEB_OPERATIONS)
        .filter(([, contract]) => contract.state === "observed")
        .map(([name]) => name)
        .sort(),
    ).toEqual(["comments.read", "feeds.read", "posts.read"]);
    for (const contract of Object.values(HACKER_NEWS_WEB_OPERATIONS)) {
      if (contract.effect === "write") expect(contract.state).toBe("capture-required");
    }
    expect(HACKER_NEWS_WEB_OPERATIONS["content.save"].reason).toContain("both real state fixtures");
    expect(HACKER_NEWS_WEB_OPERATIONS["reactions.set"].reason).toContain("human actions");
  });
});

describe("Hacker News exact R1 request authorization", () => {
  test("authorizes the viewer probe and canonical feed read separately on the exact /news route", () => {
    expect(authorizeHackerNewsReadRequest({
      operation: "viewer.current",
      url: "https://news.ycombinator.com/news",
      method: "get",
    })).toEqual({
      operation: "viewer.current",
      method: "GET",
      path: "/news",
      queryNames: [],
    });
    expect(authorizeHackerNewsReadRequest({
      operation: "feeds.read",
      url: "https://news.ycombinator.com/news",
      method: "GET",
    })).toEqual({
      operation: "feeds.read",
      method: "GET",
      path: "/news",
      queryNames: [],
    });
  });

  test("authorizes one exact decimal /item target", () => {
    expect(authorizeHackerNewsReadRequest({
      operation: "comments.read",
      url: `https://news.ycombinator.com/item?id=${POST_ID}`,
      method: "GET",
      targetId: POST_ID,
    })).toEqual({
      operation: "comments.read",
      method: "GET",
      path: "/item",
      queryNames: ["id"],
    });
  });

  test("rejects origin, path, method, duplicate query, body, and target drift", () => {
    const candidates: readonly Parameters<typeof authorizeHackerNewsReadRequest>[0][] = [
      {
        operation: "feeds.read",
        url: "https://news.ycombinator.com/newest",
        method: "GET",
      },
      {
        operation: "viewer.current",
        url: "https://www.ycombinator.com/news",
        method: "GET",
      },
      {
        operation: "posts.read",
        url: `https://news.ycombinator.com/item?id=${POST_ID}`,
        method: "POST",
        targetId: POST_ID,
      },
      {
        operation: "posts.read",
        url: `https://news.ycombinator.com/item?id=${POST_ID}&id=${POST_ID}`,
        method: "GET",
        targetId: POST_ID,
      },
      {
        operation: "posts.read",
        url: `https://news.ycombinator.com/item?id=${SECOND_POST_ID}`,
        method: "GET",
        targetId: POST_ID,
      },
      {
        operation: "posts.read",
        url: `https://news.ycombinator.com/item?id=${POST_ID}`,
        method: "GET",
        body: "",
        targetId: POST_ID,
      },
    ];
    for (const candidate of candidates) {
      expect(() => authorizeHackerNewsReadRequest(candidate)).toThrow();
    }
  });
});

describe("Hacker News bounded HTML projection", () => {
  test("binds exactly one signed-in current-account anchor", () => {
    expect(parseHackerNewsViewerHtml(`<html>${viewer()}</html>`)).toBe("wrench_user");
    expect(() => parseHackerNewsViewerHtml("<html><a href=\"login\">login</a></html>")).toThrow(
      "current-account",
    );
    expect(() => parseHackerNewsViewerHtml(
      `<html>${viewer()}${viewer()}</html>`,
    )).toThrow("exactly one");
  });

  test("projects a bounded front page without action tokens", () => {
    const html = [
      "<html>",
      viewer(),
      submission(POST_ID, "One &amp; only"),
      submission(SECOND_POST_ID, "Second"),
      "<a class=\"morelink\" href=\"news?p=2\">More</a>",
      "</html>",
    ].join("");
    const result = normalizeHackerNewsFeedHtml(html, 1);
    expect(result).toEqual({
      posts: [{
        id: POST_ID,
        title: "One & only",
        url: `https://example.com/${POST_ID}`,
        author: `author_${POST_ID}`,
        body: "",
        createdAt: "2026-07-23T12:00:00Z",
        score: 42,
        commentCount: 3,
      }],
      hasMore: true,
    });
    expect(JSON.stringify(result)).not.toContain("auth=");
    expect(() => normalizeHackerNewsFeedHtml(html, 31)).toThrow("between 1 and 30");
  });

  test("binds one post and validates ordered comment ancestry", () => {
    expect(normalizeHackerNewsPostHtml(itemPage(), POST_ID)).toMatchObject({
      post: {
        id: POST_ID,
        title: "Ask HN: A & B?",
        body: "Line one\n\nLine two",
      },
    });
    const comments = normalizeHackerNewsCommentsHtml(itemPage(), POST_ID, 1);
    expect(comments).toMatchObject({
      post: { id: POST_ID },
      comments: [{
        id: COMMENT_ID,
        postId: POST_ID,
        parentId: POST_ID,
        body: "First <comment>",
        depth: 0,
      }],
      truncated: true,
    });
    expect(() => normalizeHackerNewsPostHtml(itemPage(), SECOND_POST_ID)).toThrow("requested post");
    const skippedDepth = [
      submission(POST_ID),
      comment(REPLY_ID, 1, "No depth-zero parent", null),
    ].join("");
    expect(() => normalizeHackerNewsCommentsHtml(skippedDepth, POST_ID, 10)).toThrow("parent depth");
  });
});

describe("Hacker News request-bound proof parsing", () => {
  test("parses exact favorite and un-favorite actions without treating synthetic fixtures as promotion evidence", () => {
    for (const state of [
      { path: "fave", nextSavedState: true },
      { path: "unfave", nextSavedState: false },
    ] as const) {
      const html = submission(
        POST_ID,
        "Favorite fixture",
        `<a href="${state.path}?id=${POST_ID}&amp;auth=${AUTH}&amp;goto=item%3Fid%3D${POST_ID}">${state.path}</a>`,
      );
      expect(parseHackerNewsFavoriteAction(html, POST_ID)).toEqual({
        path: `/${state.path}`,
        targetId: POST_ID,
        auth: AUTH,
        goto: `item?id=${POST_ID}`,
        nextSavedState: state.nextSavedState,
      });
    }
    expect(HACKER_NEWS_WEB_OPERATIONS["content.save"].state).toBe("capture-required");
  });

  test("rejects ambiguous, mismatched, or malformed favorite proofs", () => {
    const action = `<a href="fave?id=${POST_ID}&amp;auth=${AUTH}&amp;goto=news">favorite</a>`;
    expect(() => parseHackerNewsFavoriteAction(
      submission(POST_ID, "Ambiguous", action + action),
      POST_ID,
    )).toThrow("exactly one");
    expect(() => parseHackerNewsFavoriteAction(
      submission(POST_ID, "Mismatch", `<a href="fave?id=${SECOND_POST_ID}&amp;auth=${AUTH}&amp;goto=news">favorite</a>`),
      POST_ID,
    )).toThrow("bind");
    expect(() => parseHackerNewsFavoriteAction(
      submission(POST_ID, "Extra", `<a href="fave?id=${POST_ID}&amp;auth=${AUTH}&amp;goto=news&amp;extra=1">favorite</a>`),
      POST_ID,
    )).toThrow("unsupported");
  });

  test("parses exact comment and submission form proof fields and rejects drift", () => {
    const commentForm = [
      "<form method=\"post\" action=\"comment\">",
      `<input type="hidden" name="parent" value="${POST_ID}">`,
      `<input type="hidden" name="goto" value="item?id=${POST_ID}">`,
      `<input type="hidden" name="hmac" value="${HMAC}">`,
      "<textarea name=\"text\"></textarea>",
      "</form>",
    ].join("");
    expect(parseHackerNewsCommentForm(commentForm, POST_ID)).toEqual({
      parentId: POST_ID,
      goto: `item?id=${POST_ID}`,
      hmac: HMAC,
    });
    expect(() => parseHackerNewsCommentForm(commentForm, SECOND_POST_ID)).toThrow("parent");

    const submitForm = [
      "<form method=\"post\" action=\"r\">",
      `<input type="hidden" name="fnid" value="${FNID}">`,
      `<input type="hidden" name="fnop" value="${FNOP}">`,
      "<input name=\"title\"><input name=\"url\"><textarea name=\"text\"></textarea>",
      "</form>",
    ].join("");
    expect(parseHackerNewsSubmissionForm(submitForm)).toEqual({
      fnid: FNID,
      fnop: FNOP,
    });
    expect(() => parseHackerNewsSubmissionForm(
      submitForm.replace("</form>", `<input type="hidden" name="fnid" value="duplicate"></form>`),
    )).toThrow("repeated");
  });
});
