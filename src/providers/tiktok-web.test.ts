import { describe, expect, test } from "bun:test";

import tiktokWebManifest from "../assets/adapters/tiktok/wrench-web-adapter.json";
import {
  TIKTOK_WEB_OPERATIONS,
  TIKTOK_WEB_OPERATION_NAMES,
  authorizeTikTokWebR1Request,
  enforceTikTokWebHeaderSinkPolicy,
  normalizeTikTokWebCommentsResponse,
  normalizeTikTokWebFeedResponse,
  parseTikTokWebProfileResponse,
  parseTikTokWebViewerResponse,
  tiktokWebDirectEvidenceSnapshot,
  tiktokWebHeaderSinkPolicy,
} from "./tiktok-web";

const VIEWER_ID = "1234567890123456789";
const VIEWER_SEC_UID = `MS4wLjABAAAA${"a".repeat(48)}`;
const POST_ID = "7491234567890123456";
const COMMENT_ID = "7491234567890123001";

function viewerResponse(id = VIEWER_ID, secUid = VIEWER_SEC_UID): unknown {
  return {
    statusCode: 0,
    status_code: 0,
    status_msg: "",
    userInfo: {
      user: {
        id,
        secUid,
        uniqueId: "wrench_test",
        nickname: "Wrench Test",
        signature: "A bounded public profile bio",
        bioLink: { link: "https://example.com/about" },
      },
      stats: {
        followerCount: 123,
        followingCount: 45,
        heartCount: 678,
      },
      statsV2: {
        followerCount: "123",
        followingCount: "45",
        heartCount: "678",
      },
    },
  };
}

function feedItem(id = POST_ID): unknown {
  return {
    id,
    desc: "",
    createTime: 1_753_200_000,
    digged: false,
    collected: true,
    author: {
      id: "1000000000000000001",
      secUid: `MS4wLjABAAAA${"b".repeat(48)}`,
      uniqueId: "creator",
      nickname: "Creator",
    },
    stats: {
      diggCount: 4,
      commentCount: 3,
      shareCount: 2,
      playCount: 10,
      collectCount: 1,
    },
    video: {
      id: "video-1",
      duration: 14,
      width: 1080,
      height: 1920,
      ratio: "720p",
      playAddr: "https://v.example.invalid/expiring-private-query",
    },
  };
}

function comment(id = COMMENT_ID, postId = POST_ID): unknown {
  return {
    cid: id,
    aweme_id: postId,
    text: "A useful comment",
    create_time: 1_753_200_001,
    digg_count: 2,
    reply_comment_total: 1,
    reply_id: "0",
    reply_to_reply_id: "0",
    user_digged: 1,
    user: {
      uid: "1000000000000000002",
      sec_uid: `MS4wLjABAAAA${"c".repeat(48)}`,
      unique_id: "commenter",
      nickname: "Commenter",
    },
  };
}

describe("TikTok internal-web operation registry", () => {
  test("ships one schema-v4 semantic manifest entry for every code-owned operation", () => {
    expect(tiktokWebManifest).toMatchObject({
      schemaVersion: 4,
      id: "tiktok-web",
      surfaceId: "tiktok",
      origins: ["https://www.tiktok.com"],
      browserDomains: ["www.tiktok.com"],
    });
    expect(Object.keys(tiktokWebManifest.operations).sort()).toEqual([...TIKTOK_WEB_OPERATION_NAMES].sort());
    for (const operation of TIKTOK_WEB_OPERATION_NAMES) {
      const manifestOperation = tiktokWebManifest.operations[operation];
      const codeContract = TIKTOK_WEB_OPERATIONS[operation];
      expect(manifestOperation.webSession).toEqual({
        site: "tiktok",
        action: operation,
        contractVersion: "contractVersion" in codeContract ? codeContract.contractVersion : 1,
        timeoutMs: manifestOperation.webSession.timeoutMs,
        maxOutputBytes: manifestOperation.webSession.maxOutputBytes,
      });
      expect(manifestOperation.risk).toBe(codeContract.risk);
    }
  });

  test("enumerates the complete surface and only graduates proven signer-free reads", () => {
    expect(Object.keys(TIKTOK_WEB_OPERATIONS).sort()).toEqual([...TIKTOK_WEB_OPERATION_NAMES].sort());
    expect(new Set(TIKTOK_WEB_OPERATION_NAMES).size).toBe(TIKTOK_WEB_OPERATION_NAMES.length);
    expect(Object.isFrozen(TIKTOK_WEB_OPERATION_NAMES)).toBeTrue();
    expect(Object.isFrozen(TIKTOK_WEB_OPERATIONS)).toBeTrue();
    expect(
      Object.entries(TIKTOK_WEB_OPERATIONS)
        .filter(([, contract]) => contract.state === "observed")
        .map(([operation]) => operation)
        .sort(),
    ).toEqual(["comments.read", "feeds.read", "profiles.read"]);
    for (const [name, contract] of Object.entries(TIKTOK_WEB_OPERATIONS)) {
      expect(Object.isFrozen(contract)).toBeTrue();
      expect(Object.isFrozen(contract.requests)).toBeTrue();
      if (name !== "profiles.read" && name !== "feeds.read" && name !== "comments.read") {
        expect(contract.requests).toHaveLength(0);
      }
    }
  });

  test("keeps all mutations capture-required without executable request rules", () => {
    for (const contract of Object.values(TIKTOK_WEB_OPERATIONS)) {
      if (contract.effect !== "write") continue;
      expect(contract.state).toBe("capture-required");
      expect(contract.requests).toHaveLength(0);
    }
    for (const operation of ["likes.set", "content.save", "relationships.follow.set"] as const) {
      expect(TIKTOK_WEB_OPERATIONS[operation].risk).toBe("R2");
    }
  });
});

describe("TikTok exact R1 request authorization", () => {
  test("retains only secret-free structural live evidence", () => {
    expect(tiktokWebDirectEvidenceSnapshot).toMatchObject({
      role: "revision-evidence-only",
      observedOn: "2026-07-23",
      origin: "https://www.tiktok.com",
      authentication: "browser-cookie-session",
      signerRequired: false,
    });
    expect(tiktokWebDirectEvidenceSnapshot.operations["viewer.current"].responseBinding).toContain(
      "userInfo.user.secUid",
    );
    const serialized = JSON.stringify(tiktokWebDirectEvidenceSnapshot);
    expect(serialized).not.toContain("sessionid");
    expect(serialized).not.toContain("tt_csrf_token");
    expect(serialized).not.toContain("X-Bogus");
  });

  test("accepts only the fixed signer-free request families", () => {
    expect(authorizeTikTokWebR1Request({
      operation: "viewer.current",
      url: "https://www.tiktok.com/api/user/detail/self/",
      method: "GET",
    })).toEqual({
      operation: "viewer.current",
      method: "GET",
      path: "/api/user/detail/self/",
      query: {},
    });
    expect(authorizeTikTokWebR1Request({
      operation: "profiles.current",
      url: "https://www.tiktok.com/api/user/detail/self/",
      method: "GET",
    })).toEqual({
      operation: "profiles.current",
      method: "GET",
      path: "/api/user/detail/self/",
      query: {},
    });
    expect(authorizeTikTokWebR1Request({
      operation: "feeds.for-you",
      url: "https://www.tiktok.com/api/recommend/item_list/?aid=1988&count=20",
      method: "get",
    }).query).toEqual({ aid: "1988", count: "20" });
    expect(authorizeTikTokWebR1Request({
      operation: "comments.list",
      url: `https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=${POST_ID}&count=50&cursor=0`,
      method: "GET",
    }).query).toEqual({
      aid: "1988",
      aweme_id: POST_ID,
      count: "50",
      cursor: "0",
    });
  });

  test("rejects origin, method, body, path, duplicate, signer, and query drift", () => {
    const cases: readonly Parameters<typeof authorizeTikTokWebR1Request>[0][] = [
      {
        operation: "viewer.current",
        url: "https://m.tiktok.com/api/user/detail/self/",
        method: "GET",
      },
      {
        operation: "viewer.current",
        url: "https://www.tiktok.com/api/user/detail/self/",
        method: "POST",
      },
      {
        operation: "viewer.current",
        url: "https://www.tiktok.com/api/user/detail/self/",
        method: "GET",
        body: "",
      },
      {
        operation: "feeds.for-you",
        url: "https://www.tiktok.com/api/following/item_list/?aid=1988&count=20",
        method: "GET",
      },
      {
        operation: "feeds.for-you",
        url: "https://www.tiktok.com/api/recommend/item_list/?aid=1988&aid=1988&count=20",
        method: "GET",
      },
      {
        operation: "feeds.for-you",
        url: "https://www.tiktok.com/api/recommend/item_list/?aid=1988&count=20&X-Bogus=unreviewed",
        method: "GET",
      },
      {
        operation: "feeds.for-you",
        url: "https://www.tiktok.com/api/recommend/item_list/?aid=1233&count=20",
        method: "GET",
      },
      {
        operation: "comments.list",
        url: `https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=bad&count=20&cursor=0`,
        method: "GET",
      },
    ];
    for (const candidate of cases) {
      expect(() => authorizeTikTokWebR1Request(candidate)).toThrow();
    }
  });
});

describe("TikTok current-profile projection", () => {
  test("projects exact safe counts and bounded public metadata", () => {
    expect(parseTikTokWebProfileResponse(viewerResponse())).toEqual({
      id: VIEWER_ID,
      secUid: VIEWER_SEC_UID,
      handle: "wrench_test",
      displayName: "Wrench Test",
      bio: "A bounded public profile bio",
      websiteUrl: "https://example.com/about",
      followers: 123,
      following: 45,
      likes: 678,
    });
  });

  test("rejects rounded, unsafe, conflicting, and unsafe-link values", () => {
    const rounded = viewerResponse() as Record<string, unknown>;
    const roundedInfo = (rounded.userInfo as Record<string, unknown>);
    const roundedStats = roundedInfo.stats as Record<string, unknown>;
    roundedStats.followerCount = "1.2K";
    expect(() => parseTikTokWebProfileResponse(rounded)).toThrow("safe decimal integer");

    const conflicting = viewerResponse() as Record<string, unknown>;
    const conflictingInfo = conflicting.userInfo as Record<string, unknown>;
    const conflictingStatsV2 = conflictingInfo.statsV2 as Record<string, unknown>;
    conflictingStatsV2.heartCount = "679";
    expect(() => parseTikTokWebProfileResponse(conflicting)).toThrow("conflicting heartCount");

    const unsafe = viewerResponse() as Record<string, unknown>;
    const unsafeInfo = unsafe.userInfo as Record<string, unknown>;
    const unsafeUser = unsafeInfo.user as Record<string, unknown>;
    unsafeUser.bioLink = { link: "javascript:alert(1)" };
    expect(() => parseTikTokWebProfileResponse(unsafe)).toThrow("safe public HTTP URL");
  });
});

describe("TikTok raw header sink policy", () => {
  test("allows only exact code-owned read headers at the network sink", () => {
    expect(enforceTikTokWebHeaderSinkPolicy({
      source: "code",
      sink: "network-request",
      headers: {
        accept: "application/json, text/plain, */*",
        referer: "https://www.tiktok.com/foryou",
      },
    })).toEqual({
      accept: "application/json, text/plain, */*",
      referer: "https://www.tiktok.com/foryou",
    });
    expect(tiktokWebHeaderSinkPolicy.inOriginEphemeral).toEqual(["tt-csrf-token"]);
  });

  test("keeps cookies browser-managed and tokens out of persistent or untrusted sinks", () => {
    expect(() => enforceTikTokWebHeaderSinkPolicy({
      source: "code",
      sink: "network-request",
      headers: { cookie: "session=private" },
    })).toThrow("browser-managed");
    expect(() => enforceTikTokWebHeaderSinkPolicy({
      source: "code",
      sink: "network-request",
      headers: { "tt-csrf-token": "not-from-session" },
    })).toThrow("in-origin session");
    expect(() => enforceTikTokWebHeaderSinkPolicy({
      source: "in-origin-session",
      sink: "receipt",
      headers: { "tt-csrf-token": "session_token_value" },
    })).toThrow("may not flow to receipt");
    expect(() => enforceTikTokWebHeaderSinkPolicy({
      source: "manifest",
      sink: "network-request",
      headers: { referer: "https://www.tiktok.com/" },
    })).toThrow("manifest may not supply");
  });
});

describe("TikTok bounded response normalization", () => {
  test("binds the current viewer to both uid forms", () => {
    expect(parseTikTokWebViewerResponse(viewerResponse())).toEqual({
      id: VIEWER_ID,
      secUid: VIEWER_SEC_UID,
      handle: "wrench_test",
      displayName: "Wrench Test",
    });
    expect(() => parseTikTokWebViewerResponse(viewerResponse("bad"))).toThrow("decimal TikTok identifier");
    expect(() => parseTikTokWebViewerResponse(viewerResponse(VIEWER_ID, "short"))).toThrow("exact TikTok secUid");
    expect(() => parseTikTokWebViewerResponse({
      ...(viewerResponse() as Record<string, unknown>),
      status_code: 1,
    })).toThrow("success status");
  });

  test("projects a bounded feed without leaking expiring provider media URLs", () => {
    const normalized = normalizeTikTokWebFeedResponse({
      statusCode: 0,
      status_code: 0,
      hasMore: true,
      itemList: [feedItem()],
    }, 2);
    expect(normalized).toMatchObject({
      posts: [{
        id: POST_ID,
        description: "",
        viewerState: { liked: false, saved: true },
        media: { type: "video", durationSeconds: 14, width: 1080, height: 1920 },
        url: `https://www.tiktok.com/@creator/video/${POST_ID}`,
      }],
      hasMore: true,
    });
    expect(JSON.stringify(normalized)).not.toContain("expiring-private-query");
    expect(Object.isFrozen(normalized)).toBeTrue();
    expect(Object.isFrozen((normalized.posts as readonly unknown[])[0])).toBeTrue();
  });

  test("fails malformed, failed, or over-limit feed pages", () => {
    expect(() => normalizeTikTokWebFeedResponse({
      statusCode: 1,
      status_code: 1,
      hasMore: false,
      itemList: [],
    }, 1)).toThrow("success status");
    expect(() => normalizeTikTokWebFeedResponse({
      statusCode: 0,
      status_code: 0,
      hasMore: false,
      itemList: [feedItem(), feedItem("7491234567890123457")],
    }, 1)).toThrow("complete-page limit");
    expect(() => normalizeTikTokWebFeedResponse({
      statusCode: 0,
      status_code: 0,
      hasMore: 1,
      itemList: [],
    }, 1)).toThrow("hasMore must be boolean");
  });

  test("binds every comment to the requested post and projects pagination", () => {
    expect(normalizeTikTokWebCommentsResponse({
      status_code: 0,
      comments: [comment()],
      cursor: 20,
      has_more: 1,
      total: 41,
    }, POST_ID, 20)).toEqual({
      comments: [{
        id: COMMENT_ID,
        postId: POST_ID,
        text: "A useful comment",
        createdAtUnix: 1_753_200_001,
        author: {
          id: "1000000000000000002",
          secUid: `MS4wLjABAAAA${"c".repeat(48)}`,
          handle: "commenter",
          displayName: "Commenter",
        },
        parentCommentId: "0",
        repliedToCommentId: "0",
        replyCount: 1,
        likeCount: 2,
        viewerLiked: true,
      }],
      cursor: 20,
      hasMore: true,
      total: 41,
    });
    expect(() => normalizeTikTokWebCommentsResponse({
      status_code: 0,
      comments: [comment(COMMENT_ID, "7491234567890123999")],
      cursor: 0,
      has_more: 0,
      total: 1,
    }, POST_ID, 20)).toThrow("did not bind the requested post");
  });
});
