import { describe, expect, test } from "bun:test";

import redditWebManifest from "../assets/adapters/reddit/wrench-web-adapter.json";
import {
  REDDIT_WEB_OPERATION_NAMES,
  REDDIT_WEB_OPERATIONS,
  assertRedditMutationSuccess,
  authorizeRedditWebRequest,
  normalizeRedditCommentsResponse,
  normalizeRedditFeedResponse,
  normalizeRedditMessageListing,
  normalizeRedditPostResponse,
  parseRedditThingState,
  parseRedditWebViewerResponse,
  redditFullname,
} from "./reddit-web";

const POST_ID = "t3_abc123";
const COMMENT_ID = "t1_def456";
const REPLY_ID = "t1_ghi789";
const MESSAGE_ID = "t4_msg123";
const MODHASH = "synthetic-modhash-value";

function listing(children: readonly unknown[], after: string | null = null): unknown {
  return {
    kind: "Listing",
    data: {
      after,
      before: null,
      children,
    },
  };
}

function postThing(
  id = POST_ID,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    kind: "t3",
    data: {
      name: id,
      title: "A post",
      selftext: "Post body",
      author: "poster",
      subreddit: "wrench",
      created_utc: 1_700_000_000,
      score: 42,
      num_comments: 2,
      likes: null,
      saved: false,
      url: `https://www.reddit.com/r/wrench/comments/${id.slice(3)}/a_post/`,
      permalink: `/r/wrench/comments/${id.slice(3)}/a_post/`,
      ...overrides,
    },
  };
}

function commentThing(
  id: string,
  parentId: string,
  replies: unknown = "",
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    kind: "t1",
    data: {
      name: id,
      link_id: POST_ID,
      parent_id: parentId,
      author: "commenter",
      body: `Body ${id}`,
      created_utc: 1_700_000_001,
      score: 4,
      depth: parentId === POST_ID ? 0 : 1,
      likes: true,
      saved: false,
      permalink: `/r/wrench/comments/abc123/a_post/${id.slice(3)}/`,
      replies,
      ...overrides,
    },
  };
}

function messageThing(
  id = MESSAGE_ID,
  replies: unknown = "",
): unknown {
  return {
    kind: "t4",
    data: {
      name: id,
      author: "sender",
      dest: "viewer",
      subject: "Hello",
      body: "Legacy private message",
      created_utc: 1_700_000_002,
      new: true,
      parent_id: null,
      context: "/message/messages/msg123",
      replies,
    },
  };
}

describe("Reddit internal-web operation registry", () => {
  test("ships one schema-v4 semantic manifest entry for every provider operation", () => {
    expect(redditWebManifest.schemaVersion).toBe(4);
    expect(redditWebManifest.id).toBe("reddit-web");
    expect(redditWebManifest.surfaceId).toBe("reddit");
    expect(redditWebManifest.origins).toEqual(["https://www.reddit.com"]);
    expect(Object.keys(redditWebManifest.operations).sort()).toEqual(
      [...REDDIT_WEB_OPERATION_NAMES].sort(),
    );
    for (const action of REDDIT_WEB_OPERATION_NAMES) {
      const operation = redditWebManifest.operations[action];
      const state = REDDIT_WEB_OPERATIONS[action].state;
      expect(operation.description.startsWith(
        state === "observed"
          ? "Observed contract:"
          : "Capture-required contract reservation:",
      )).toBe(true);
      expect(operation.webSession).toMatchObject({
        site: "reddit",
        action,
        contractVersion: 1,
      });
      expect("browser" in operation).toBe(false);
      expect("provider" in operation).toBe(false);
    }
  });

  test("covers the full provider surface and graduates only observed contracts", () => {
    expect(Object.keys(REDDIT_WEB_OPERATIONS).sort()).toEqual([...REDDIT_WEB_OPERATION_NAMES].sort());
    expect(new Set(REDDIT_WEB_OPERATION_NAMES).size).toBe(REDDIT_WEB_OPERATION_NAMES.length);
    expect(
      Object.entries(REDDIT_WEB_OPERATIONS)
        .filter(([, contract]) => contract.state === "observed")
        .map(([name]) => name)
        .sort(),
    ).toEqual([
      "comments.read",
      "feeds.read",
      "messaging.list",
      "messaging.read",
      "posts.read",
    ]);
    for (const operation of [
      "comments.create",
      "content.edit",
      "messaging.send",
      "posts.publish",
      "posts.repost",
      "replies.create",
    ] as const) {
      expect(REDDIT_WEB_OPERATIONS[operation].state).toBe("capture-required");
      expect(REDDIT_WEB_OPERATIONS[operation].risk).toBe("R3");
    }
    expect(REDDIT_WEB_OPERATIONS["media.read"].state).toBe("capture-required");
    expect(REDDIT_WEB_OPERATIONS["communities.membership.set"].state).toBe("capture-required");
    expect(REDDIT_WEB_OPERATIONS["content.save"].state).toBe("capture-required");
    expect(REDDIT_WEB_OPERATIONS["reactions.set"].state).toBe("capture-required");
  });
});

describe("Reddit exact request authorization", () => {
  test("accepts fixed reads and returns no form values", () => {
    expect(authorizeRedditWebRequest({
      operation: "feeds.home",
      url: "https://www.reddit.com/.json?limit=25&raw_json=1&after=t3_next",
      method: "get",
    })).toEqual({
      operation: "feeds.home",
      method: "GET",
      path: "/.json",
      queryNames: ["after", "limit", "raw_json"],
      formNames: [],
    });
    expect(authorizeRedditWebRequest({
      operation: "comments.read",
      url: "https://www.reddit.com/comments/abc123.json?depth=10&limit=50&raw_json=1&sort=confidence",
      method: "GET",
      targetId: POST_ID,
    }).path).toBe("/comments/abc123.json");
    expect(authorizeRedditWebRequest({
      operation: "messages.read",
      url: `https://www.reddit.com/message/inbox.json?limit=1&mark=false&max_replies=100&mid=${MESSAGE_ID}&raw_json=1`,
      method: "GET",
      folder: "inbox",
      targetId: MESSAGE_ID,
    }).queryNames).toEqual(["limit", "mark", "max_replies", "mid", "raw_json"]);
  });

  test("accepts only exact mutation forms and redacts the modhash from its binding", () => {
    const vote = authorizeRedditWebRequest({
      operation: "reactions.set",
      url: "https://www.reddit.com/api/vote",
      method: "POST",
      body: new URLSearchParams({
        dir: "1",
        id: POST_ID,
        uh: MODHASH,
      }).toString(),
      targetId: POST_ID,
      direction: 1,
    });
    expect(vote).toEqual({
      operation: "reactions.set",
      method: "POST",
      path: "/api/vote",
      queryNames: [],
      formNames: ["dir", "id", "uh"],
    });
    expect(JSON.stringify(vote)).not.toContain(MODHASH);

    const save = authorizeRedditWebRequest({
      operation: "content.save",
      url: "https://www.reddit.com/api/unsave",
      method: "POST",
      body: new URLSearchParams({ id: COMMENT_ID, uh: MODHASH }).toString(),
      targetId: COMMENT_ID,
      saved: false,
    });
    expect(save.path).toBe("/api/unsave");
    expect(JSON.stringify(save)).not.toContain(MODHASH);
  });

  test("rejects origin, path, query, target, body, and desired-state drift", () => {
    const candidates: readonly Parameters<typeof authorizeRedditWebRequest>[0][] = [
      {
        operation: "viewer.current",
        url: "https://old.reddit.com/api/me.json",
        method: "GET",
      },
      {
        operation: "feeds.home",
        url: "https://www.reddit.com/.json?limit=25&raw_json=1&raw_json=1",
        method: "GET",
      },
      {
        operation: "comments.read",
        url: "https://www.reddit.com/comments/wrong.json?depth=10&limit=50&raw_json=1&sort=confidence",
        method: "GET",
        targetId: POST_ID,
      },
      {
        operation: "messages.list",
        url: "https://www.reddit.com/message/inbox.json?limit=25&mark=true&max_replies=0&raw_json=1",
        method: "GET",
        folder: "inbox",
      },
      {
        operation: "reactions.set",
        url: "https://www.reddit.com/api/vote",
        method: "POST",
        body: new URLSearchParams({ dir: "-1", id: POST_ID, uh: MODHASH }).toString(),
        targetId: POST_ID,
        direction: 1,
      },
      {
        operation: "content.save",
        url: "https://www.reddit.com/api/save",
        method: "POST",
        body: new URLSearchParams({ id: POST_ID, uh: MODHASH, category: "extra" }).toString(),
        targetId: POST_ID,
        saved: true,
      },
    ];
    for (const candidate of candidates) {
      expect(() => authorizeRedditWebRequest(candidate)).toThrow();
    }
  });
});

describe("Reddit bounded response normalization", () => {
  test("binds a signed-in viewer and keeps the modhash ephemeral to the viewer value", () => {
    expect(parseRedditWebViewerResponse({
      kind: "t2",
      data: {
        id: "viewer1",
        name: "wrench_viewer",
        modhash: MODHASH,
      },
    })).toEqual({
      id: "t2_viewer1",
      username: "wrench_viewer",
      modhash: MODHASH,
    });
    expect(() => parseRedditWebViewerResponse({
      kind: "t2",
      data: { id: "bad!", name: "viewer", modhash: MODHASH },
    })).toThrow("base36");
  });

  test("projects a bounded feed and exact post root", () => {
    const feed = normalizeRedditFeedResponse(listing([postThing()], "t3_next"), 1);
    expect(feed).toMatchObject({
      after: "t3_next",
      posts: [{
        id: POST_ID,
        title: "A post",
        saved: false,
        liked: null,
      }],
    });
    expect(normalizeRedditPostResponse(
      [listing([postThing()]), listing([])],
      POST_ID,
    )).toMatchObject({ post: { id: POST_ID, commentCount: 2 } });
    expect(() => normalizeRedditPostResponse(
      [listing([postThing("t3_wrong")]), listing([])],
      POST_ID,
    )).toThrow("requested post");
  });

  test("flattens bounded comments while validating every parent post binding", () => {
    const nested = listing([commentThing(REPLY_ID, COMMENT_ID)]);
    const response = [
      listing([postThing()]),
      listing([
        commentThing(COMMENT_ID, POST_ID, nested),
        { kind: "more", data: { children: ["later"] } },
      ]),
    ];
    const result = normalizeRedditCommentsResponse(response, POST_ID, 1);
    expect(result).toMatchObject({
      post: { id: POST_ID },
      comments: [{ id: COMMENT_ID, parentId: POST_ID }],
      truncated: true,
      hasMore: true,
    });
    expect(() => normalizeRedditCommentsResponse([
      listing([postThing()]),
      listing([commentThing(COMMENT_ID, POST_ID, "", { link_id: "t3_wrong" })]),
    ], POST_ID, 10)).toThrow("requested post");
  });

  test("projects message Listings and binds a requested nested legacy message", () => {
    const nestedId = "t4_reply1";
    const response = listing([
      messageThing(MESSAGE_ID, listing([messageThing(nestedId)])),
    ]);
    const result = normalizeRedditMessageListing(response, 1, nestedId);
    expect(result.requested).toMatchObject({
      id: nestedId,
      kind: "message",
      body: "Legacy private message",
    });
    expect(result.messages).toHaveLength(2);
    expect(() => normalizeRedditMessageListing(response, 1, "t4_missing")).toThrow("requested message");
  });

  test("binds independent state readback and rejects provider mutation errors", () => {
    expect(parseRedditThingState(listing([
      postThing(POST_ID, { likes: true, saved: true }),
    ]), POST_ID)).toEqual({
      id: POST_ID,
      liked: true,
      saved: true,
    });
    expect(() => parseRedditThingState(listing([
      postThing("t3_wrong"),
    ]), POST_ID)).toThrow("requested thing");
    expect(() => assertRedditMutationSuccess({})).not.toThrow();
    expect(() => assertRedditMutationSuccess({ json: { errors: [] } })).not.toThrow();
    expect(() => assertRedditMutationSuccess({
      json: { errors: [["RATELIMIT", "try later", "ratelimit"]] },
    })).toThrow("provider errors");
  });

  test("rejects invalid fullname kinds and over-limit Listing pages", () => {
    expect(() => redditFullname("t2_actor", "target", ["t1", "t3"])).toThrow();
    expect(() => normalizeRedditFeedResponse(listing([postThing(), postThing("t3_other")]), 1)).toThrow(
      "reviewed bound",
    );
  });
});
