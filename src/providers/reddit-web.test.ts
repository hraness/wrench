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
  parseRedditAuthoredPostPresence,
  parseRedditMediaLeaseResponse,
  parseRedditProfileContributionPage,
  parseRedditThingState,
  parseRedditVideoPostPresence,
  parseRedditVideoSubmitResponse,
  parseRedditVideoWebSocketMessage,
  parseRedditWebProfileResponse,
  parseRedditWebViewerResponse,
  projectRedditHostedVideoMetadata,
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

function leaseResponse(
  mediaType: "video/mp4" | "image/png" = "video/mp4",
): unknown {
  const video = mediaType === "video/mp4";
  const host = video
    ? "reddit-uploaded-video.s3-accelerate.amazonaws.com"
    : "reddit-uploaded-media.s3-accelerate.amazonaws.com";
  const extension = video ? "mp4" : "png";
  const values: Readonly<Record<string, string>> = {
    "x-amz-algorithm": "AWS4-HMAC-SHA256",
    key: `rte_images/asset.${extension}`,
    "x-amz-storage-class": "STANDARD",
    success_action_status: "201",
    bucket: video ? "reddit-uploaded-video" : "reddit-uploaded-media",
    acl: "private",
    "x-amz-signature": "signature",
    "x-amz-security-token": "security-token",
    "x-amz-date": "20260822T000000Z",
    "x-amz-meta-ext": extension,
    policy: "policy",
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
    action: `//${host}`,
    fields: names.map((name) => ({ name, value: values[name] })),
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

function profileThing(username = "viewer"): unknown {
  return {
    kind: "t2",
    data: {
      id: "abc123",
      name: username,
      total_karma: 4321,
      subreddit: {
        display_name_prefixed: `u/${username}`,
        title: "Viewer name",
        public_description: "Public profile bio",
        subscribers: 8,
      },
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
        contractVersion: action === "media.publish" ? 9 : action === "media.read" ? 2 : 1,
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
      "content.delete",
      "feeds.read",
      "media.publish",
      "media.read",
      "messaging.list",
      "messaging.read",
      "posts.read",
      "profiles.read",
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
    expect(REDDIT_WEB_OPERATIONS["media.read"].state).toBe("observed");
    expect(REDDIT_WEB_OPERATIONS["communities.membership.set"].state).toBe("capture-required");
    expect(REDDIT_WEB_OPERATIONS["content.save"].state).toBe("capture-required");
    expect(REDDIT_WEB_OPERATIONS["reactions.set"].state).toBe("capture-required");
  });
});

describe("Reddit exact request authorization", () => {
  test("accepts fixed reads and returns no form values", () => {
    expect(authorizeRedditWebRequest({
      operation: "profiles.about",
      url: "https://www.reddit.com/user/viewer/about.json?raw_json=1",
      method: "GET",
      profile: "viewer",
    })).toMatchObject({
      operation: "profiles.about",
      path: "/user/viewer/about.json",
      queryNames: ["raw_json"],
    });
    expect(authorizeRedditWebRequest({
      operation: "profiles.overview",
      url: "https://www.reddit.com/user/viewer/overview.json?after=t1_next&limit=100&raw_json=1",
      method: "GET",
      profile: "viewer",
    })).toMatchObject({
      operation: "profiles.overview",
      path: "/user/viewer/overview.json",
      queryNames: ["after", "limit", "raw_json"],
    });
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
    expect(authorizeRedditWebRequest({
      operation: "media.read",
      url: `https://www.reddit.com/api/info.json?id=${POST_ID}&raw_json=1`,
      method: "GET",
      targetId: POST_ID,
    })).toEqual({
      operation: "media.read",
      method: "GET",
      path: "/api/info.json",
      queryNames: ["id", "raw_json"],
      formNames: [],
    });
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

  test("binds exact Reddit video lease, submit, and authored-delete forms", () => {
    const lease = new URLSearchParams({
      filepath: "wrench-video.mp4",
      mimetype: "video/mp4",
      raw_json: "1",
    }).toString();
    expect(authorizeRedditWebRequest({
      operation: "media.lease",
      url: "https://old.reddit.com/api/video_upload_s3.json",
      method: "POST",
      body: lease,
      mediaType: "video/mp4",
      filename: "wrench-video.mp4",
    })).toMatchObject({
      path: "/api/video_upload_s3.json",
      queryNames: [],
      formNames: ["filepath", "mimetype", "raw_json"],
    });
    const videoUrl = "https://reddit-uploaded-video.s3-accelerate.amazonaws.com/rte_images/video.mp4";
    const posterUrl = "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images/poster.png";
    const submit = new URLSearchParams({
      api_type: "json",
      kind: "video",
      nsfw: "false",
      resubmit: "false",
      sendreplies: "true",
      spoiler: "false",
      sr: "testingground4bots",
      title: "Fixture",
      uh: MODHASH,
      url: videoUrl,
      validate_on_submit: "true",
      video_poster_url: posterUrl,
    }).toString();
    expect(authorizeRedditWebRequest({
      operation: "media.publish",
      url: "https://www.reddit.com/api/submit?raw_json=1",
      method: "POST",
      body: submit,
      community: "testingground4bots",
      title: "Fixture",
      nsfw: false,
      spoiler: false,
      sendReplies: true,
      mediaUrl: videoUrl,
      posterUrl,
    }).formNames).toEqual([
      "api_type",
      "kind",
      "nsfw",
      "resubmit",
      "sendreplies",
      "spoiler",
      "sr",
      "title",
      "uh",
      "url",
      "validate_on_submit",
      "video_poster_url",
    ]);
    const deletion = authorizeRedditWebRequest({
      operation: "content.delete",
      url: "https://www.reddit.com/api/del",
      method: "POST",
      body: new URLSearchParams({ id: POST_ID, uh: MODHASH }).toString(),
      targetId: POST_ID,
    });
    expect(deletion.formNames).toEqual(["id", "uh"]);
    expect(JSON.stringify({ lease, submit, deletion })).not.toContain("private-cookie");
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

describe("Reddit profile-stat projections", () => {
  test("projects exact follower and total-karma counts with public metadata", () => {
    expect(parseRedditWebProfileResponse(profileThing(), "viewer")).toEqual({
      username: "viewer",
      displayName: "Viewer name",
      bio: "Public profile bio",
      followers: 8,
      karma: 4321,
    });
  });

  test("counts only exact target-authored post and comment things", () => {
    expect(parseRedditProfileContributionPage(listing([
      postThing("t3_abc123", { author: "viewer" }),
      commentThing("t1_def456", "t3_abc123", "", { author: "viewer" }),
    ], "t1_next"), "viewer")).toEqual({
      ids: ["t3_abc123", "t1_def456"],
      after: "t1_next",
    });
  });

  test("rejects target, author, kind, duplicate, and unsafe count drift", () => {
    expect(() => parseRedditWebProfileResponse(profileThing("other"), "viewer"))
      .toThrow("did not bind");
    expect(() => parseRedditProfileContributionPage(listing([
      postThing("t3_abc123", { author: "other" }),
    ]), "viewer")).toThrow("another author");
    expect(() => parseRedditProfileContributionPage(listing([
      { kind: "t5", data: { name: "t5_group", author: "viewer" } },
    ]), "viewer")).toThrow("must be t1 or t3");
    expect(() => parseRedditProfileContributionPage(listing([
      postThing("t3_abc123", { author: "viewer" }),
      postThing("t3_abc123", { author: "viewer" }),
    ]), "viewer")).toThrow("repeated a contribution");

    const unsafe = profileThing() as Record<string, unknown>;
    const data = unsafe.data as Record<string, unknown>;
    data.total_karma = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseRedditWebProfileResponse(unsafe, "viewer"))
      .toThrow("must be an integer");
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

  test("strictly binds media leases, submit websocket targets, and hosted-video readback", () => {
    const lease = parseRedditMediaLeaseResponse(leaseResponse(), {
      mediaType: "video/mp4",
      filename: "wrench-video.mp4",
    });
    expect(lease).toMatchObject({
      uploadOrigin: "https://reddit-uploaded-video.s3-accelerate.amazonaws.com",
      key: "rte_images/asset.mp4",
    });
    expect(lease.fields).toHaveLength(13);
    for (const [mediaType, filename] of [
      ["video/mp4", "wrench-video.mp4"],
      ["image/png", "wrench-poster.png"],
    ] as const) {
      const response = leaseResponse(mediaType);
      const fields = (response as { fields: unknown[] }).fields;
      expect(() => parseRedditMediaLeaseResponse({
        ...(response as Record<string, unknown>),
        fields: [...fields].reverse(),
      }, { mediaType, filename })).not.toThrow();
    }
    const websocket = parseRedditVideoSubmitResponse({
      json: {
        errors: [],
        data: {
          websocket_url: `wss://ws-test.wss.redditmedia.com/rte_images/asset?m=${"b".repeat(24)}`,
          user_submitted_page: "https://www.reddit.com/user/viewer/submitted/",
        },
      },
    });
    expect(websocket).toStartWith("wss://ws-test.wss.redditmedia.com/");
    expect(parseRedditVideoWebSocketMessage({
      payload: {
        redirect: "https://reddit.com/r/testingground4bots/comments/abc123/fixture/",
      },
    }, "testingground4bots")).toEqual({
      postId: POST_ID,
      url: "https://www.reddit.com/r/testingground4bots/comments/abc123/fixture/",
    });
    const readback = parseRedditVideoPostPresence(listing([postThing(POST_ID, {
      author: "viewer",
      author_fullname: "t2_viewer1",
      subreddit: "testingground4bots",
      selftext: "",
      over_18: false,
      spoiler: true,
      is_video: true,
      post_hint: "hosted:video",
      domain: "v.redd.it",
      url: "https://v.redd.it/video123",
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
    })]), POST_ID);
    expect(readback).toMatchObject({
      authorFullname: "t2_viewer1",
      durationSeconds: 8,
      width: 640,
      height: 360,
      nsfw: false,
      spoiler: true,
    });
    const metadata = projectRedditHostedVideoMetadata(listing([postThing(POST_ID, {
      author: "viewer",
      author_fullname: "t2_viewer1",
      subreddit: "testingground4bots",
      selftext: "ignored body",
      over_18: false,
      spoiler: true,
      is_video: true,
      post_hint: "hosted:video",
      domain: "v.redd.it",
      url: "https://v.redd.it/video123",
      secure_media: {
        reddit_video: {
          dash_url: "https://v.redd.it/video123/DASHPlaylist.mpd?token=private-playback-token",
        },
      },
      media: {
        reddit_video: {
          duration: 8,
          fallback_url: "https://v.redd.it/video123/DASH_360.mp4?token=private-playback-token",
          height: 360,
          is_gif: false,
          transcoding_status: "completed",
          width: 640,
          unexpected_playback_secret: "must-not-escape",
        },
      },
      preview: {
        reddit_video_preview: {
          fallback_url: "https://v.redd.it/video123/preview.mp4?token=private-playback-token",
        },
      },
    })]), POST_ID);
    expect(metadata).toEqual({
      provider: "reddit",
      operation: "media.read",
      post: {
        id: POST_ID,
        title: "A post",
        author: "viewer",
        subreddit: "testingground4bots",
        createdUtc: 1_700_000_000,
        permalink: "https://www.reddit.com/r/wrench/comments/abc123/a_post/",
      },
      media: {
        kind: "hosted-video",
        mediaType: "video/mp4",
        durationSeconds: 8,
        width: 640,
        height: 360,
        nsfw: false,
        spoiler: true,
        transcodingStatus: "completed",
      },
    });
    expect(Object.keys(metadata).sort()).toEqual(["media", "operation", "post", "provider"]);
    expect(Object.keys(metadata.post).sort()).toEqual([
      "author",
      "createdUtc",
      "id",
      "permalink",
      "subreddit",
      "title",
    ]);
    expect(Object.keys(metadata.media).sort()).toEqual([
      "durationSeconds",
      "height",
      "kind",
      "mediaType",
      "nsfw",
      "spoiler",
      "transcodingStatus",
      "width",
    ]);
    expect(JSON.stringify(metadata)).not.toContain("v.redd.it");
    expect(JSON.stringify(metadata)).not.toContain("private-playback-token");
    expect(JSON.stringify(metadata)).not.toContain("must-not-escape");
    expect(parseRedditAuthoredPostPresence(listing([]), POST_ID)).toEqual({
      present: false,
      post: null,
      authorFullname: null,
    });
  });

  test("rejects lease, websocket, and video-readback drift", () => {
    const duplicateLease = leaseResponse() as { action: string; fields: unknown[] };
    const duplicateFields = [...duplicateLease.fields];
    duplicateFields[duplicateFields.length - 1] = duplicateFields[0];
    expect(() => parseRedditMediaLeaseResponse({
      ...duplicateLease,
      fields: duplicateFields,
    }, {
      mediaType: "video/mp4",
      filename: "wrench-video.mp4",
    })).toThrow("exact upload field set");
    expect(() => parseRedditMediaLeaseResponse({
      ...(leaseResponse() as Record<string, unknown>),
      extra: true,
    }, {
      mediaType: "video/mp4",
      filename: "wrench-video.mp4",
    })).toThrow("reviewed fields");
    expect(() => parseRedditVideoSubmitResponse({
      json: { errors: [], data: { websocket_url: "wss://attacker.example/x?m=secretsecretsecretsecret" } },
    })).toThrow("reviewed Reddit websocket family");
    expect(() => parseRedditVideoWebSocketMessage({
      payload: { redirect: "https://www.reddit.com/r/other/comments/abc123/fixture/" },
    }, "testingground4bots")).toThrow("confirmed community");
    expect(() => parseRedditVideoPostPresence(listing([postThing(POST_ID, {
      is_video: false,
    })]), POST_ID)).toThrow("hosted video");
    expect(() => projectRedditHostedVideoMetadata(listing([]), POST_ID))
      .toThrow("exact hosted-video post");
    expect(() => projectRedditHostedVideoMetadata(listing([postThing("t3_wrong", {
      is_video: true,
      post_hint: "hosted:video",
      domain: "v.redd.it",
    })]), POST_ID)).toThrow("changed its exact target");
  });

  test("rejects invalid fullname kinds and over-limit Listing pages", () => {
    expect(() => redditFullname("t2_actor", "target", ["t1", "t3"])).toThrow();
    expect(() => normalizeRedditFeedResponse(listing([postThing(), postThing("t3_other")]), 1)).toThrow(
      "reviewed bound",
    );
  });
});
