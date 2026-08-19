import { describe, expect, test } from "bun:test";

import blueskyManifest from "../assets/adapters/bluesky/wrench-web-adapter.json";
import {
  BLUESKY_APPVIEW_PROXY,
  BLUESKY_CHAT_PROXY,
  BLUESKY_NOTIFICATION_PROXY,
  BLUESKY_WEB_OPERATIONS,
  BLUESKY_WEB_OPERATION_NAMES,
  authorizeBlueskyXrpcRequest,
  parseBlueskyAtUri,
  parseBlueskyBootstrapAccount,
  parseBlueskyCurrentPostRecordResponse,
  parseBlueskyDeleteRecordResponse,
  parseBlueskyGetRecordResponse,
  parseBlueskyRecordNotFoundResponse,
  parseBlueskyRefreshSessionResponse,
  projectBlueskyConvoList,
  projectBlueskyFeed,
  projectBlueskyNotifications,
  projectBlueskyPostsResponse,
  projectBlueskyThread,
} from "./bluesky-web";

const VIEWER_DID = `did:plc:${"a".repeat(24)}`;
const AUTHOR_DID = `did:plc:${"b".repeat(24)}`;
const CID = `b${"a".repeat(40)}`;
const POST_URI = `at://${AUTHOR_DID}/app.bsky.feed.post/3lsynthetic`;
const REPLY_URI = `at://${VIEWER_DID}/app.bsky.feed.post/3lreply`;

function jwt(did = VIEWER_DID, exp = 4_000_000_000): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "ES256K", typ: "JWT" })}.${encode({
    aud: "did:web:bsky.social",
    exp,
    sub: did,
  })}.synthetic-signature`;
}

function postView(
  uri = POST_URI,
  did = AUTHOR_DID,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    uri,
    cid: CID,
    author: {
      did,
      handle: did === VIEWER_DID ? "viewer.test" : "author.test",
      displayName: "Synthetic author",
    },
    record: {
      $type: "app.bsky.feed.post",
      text: "Synthetic post",
      createdAt: "2026-07-23T12:00:00.000Z",
    },
    indexedAt: "2026-07-23T12:00:01.000Z",
    replyCount: 1,
    repostCount: 2,
    likeCount: 3,
    quoteCount: 4,
    viewer: {
      bookmarked: true,
      like: `at://${VIEWER_DID}/app.bsky.feed.like/3llike`,
      repost: `at://${VIEWER_DID}/app.bsky.feed.repost/3lrepost`,
    },
    ...overrides,
  };
}

describe("Bluesky authenticated API policy", () => {
  test("ships a schema-v4 semantic manifest with live-proven reads and publishing", () => {
    expect(blueskyManifest.schemaVersion).toBe(4);
    expect(blueskyManifest.surfaceId).toBe("bluesky");
    expect(blueskyManifest.origins).toEqual(["https://bsky.app"]);
    expect(blueskyManifest.browserDomains).toEqual(["bsky.app"]);
    expect(Object.keys(blueskyManifest.operations).sort()).toEqual(
      [...BLUESKY_WEB_OPERATION_NAMES].sort(),
    );
    const observedReads = new Set([
      "comments.read",
      "content.delete",
      "feeds.read",
      "media.read",
      "posts.publish",
      "posts.read",
    ]);
    for (const action of BLUESKY_WEB_OPERATION_NAMES) {
      const observed = observedReads.has(action);
      expect(BLUESKY_WEB_OPERATIONS[action].state).toBe(
        observed ? "observed" : "capture-required",
      );
      expect(
        blueskyManifest.operations[action].description.startsWith(
          "Capture-required contract reservation:",
        ),
      ).toBe(!observed);
      const operation = blueskyManifest.operations[action];
      expect(operation.webSession).toMatchObject({ site: "bluesky", action });
      expect("browser" in operation).toBe(false);
      expect("provider" in operation).toBe(false);
    }
  });

  test("strictly binds deletion pre-read, commit, and absence projections", () => {
    const uri = `at://${VIEWER_DID}/app.bsky.feed.post/3ldelete`;
    expect(parseBlueskyCurrentPostRecordResponse({
      uri,
      cid: CID,
      value: {
        $type: "app.bsky.feed.post",
        text: "delete me",
        createdAt: "2026-08-19T12:00:00.000Z",
      },
    }, uri, CID)).toEqual({ uri, cid: CID });
    expect(() => parseBlueskyCurrentPostRecordResponse({
      uri,
      cid: `b${"c".repeat(40)}`,
      value: { $type: "app.bsky.feed.post" },
    }, uri, CID)).toThrow("revision changed");
    expect(() => parseBlueskyCurrentPostRecordResponse({
      uri,
      cid: CID,
      value: { $type: "app.bsky.feed.like" },
    }, uri, CID)).toThrow("not an app.bsky.feed.post");

    expect(parseBlueskyDeleteRecordResponse({})).toEqual({ commit: null });
    expect(parseBlueskyDeleteRecordResponse({
      commit: {
        cid: `b${"d".repeat(40)}`,
        rev: "3m4abcde234fg",
      },
    })).toEqual({
      commit: {
        cid: `b${"d".repeat(40)}`,
        rev: "3m4abcde234fg",
      },
    });
    expect(() => parseBlueskyDeleteRecordResponse({ commit: { cid: CID, rev: "bad" } }))
      .toThrow("must be a TID");
    expect(() => parseBlueskyDeleteRecordResponse({ commit: { cid: CID, rev: "3m4abcde234fg" }, extra: true }))
      .toThrow("unsupported fields");

    expect(parseBlueskyRecordNotFoundResponse({
      error: "RecordNotFound",
      message: "Could not locate record",
    })).toBeUndefined();
    expect(() => parseBlueskyRecordNotFoundResponse({
      error: "InvalidRequest",
      message: "no",
    })).toThrow("unexpected error code");
  });

  test("accepts only the exact selected account fields and reviewed first-party PDS hosts", () => {
    const selected = parseBlueskyBootstrapAccount(
      {
        did: VIEWER_DID,
        handle: "viewer.test",
        accessJwt: jwt(),
        refreshJwt: jwt(VIEWER_DID, 5_000_000_000),
        service: "https://bsky.social",
        pdsUrl: "https://morel.us-east.host.bsky.network",
      },
      2_000_000_000,
    );
    expect(selected).toEqual({
      did: VIEWER_DID,
      handle: "viewer.test",
      accessJwt: jwt(),
      refreshJwt: jwt(VIEWER_DID, 5_000_000_000),
      accessExpiresAt: 4_000_000_000,
      refreshExpiresAt: 5_000_000_000,
      pdsOrigin: "https://morel.us-east.host.bsky.network",
    });
    expect(() =>
      parseBlueskyBootstrapAccount({
        did: VIEWER_DID,
        handle: "viewer.test",
        accessJwt: jwt(),
        refreshJwt: jwt(VIEWER_DID, 5_000_000_000),
        service: "https://evil.example",
        pdsUrl: null,
      }, 2_000_000_000)
    ).toThrow("outside the reviewed Bluesky PDS host allowlist");
    expect(() =>
      parseBlueskyBootstrapAccount({
        did: VIEWER_DID,
        handle: "viewer.test",
        accessJwt: jwt(AUTHOR_DID),
        refreshJwt: jwt(VIEWER_DID, 5_000_000_000),
        service: "https://bsky.social",
        pdsUrl: null,
      }, 2_000_000_000)
    ).toThrow("token subject did not match");
    expect(() =>
      parseBlueskyBootstrapAccount({
        did: VIEWER_DID,
        handle: "viewer.test",
        accessJwt: jwt(),
        refreshJwt: jwt(VIEWER_DID, 5_000_000_000),
        service: "https://bsky.social",
        pdsUrl: null,
        privateSetting: "must-never-leave-the-browser",
      }, 2_000_000_000)
    ).toThrow("unsupported fields");
    const expiredAccess = parseBlueskyBootstrapAccount({
      did: VIEWER_DID,
      handle: "viewer.test",
      accessJwt: jwt(VIEWER_DID, 1_999_999_999),
      refreshJwt: jwt(VIEWER_DID, 5_000_000_000),
      service: "https://bsky.social",
      pdsUrl: null,
    }, 2_000_000_000);
    expect(expiredAccess.accessExpiresAt).toBe(1_999_999_999);
    expect(parseBlueskyRefreshSessionResponse({
      did: VIEWER_DID,
      handle: "renamed.test",
      accessJwt: jwt(VIEWER_DID, 4_100_000_000),
      refreshJwt: jwt(VIEWER_DID, 5_100_000_000),
      active: true,
    }, expiredAccess, 2_000_000_000)).toMatchObject({
      did: VIEWER_DID,
      handle: "renamed.test",
      accessExpiresAt: 4_100_000_000,
      refreshExpiresAt: 5_100_000_000,
      pdsOrigin: "https://bsky.social",
    });
  });

  test("authorizes only exact XRPC methods, paths, queries, and proxy labels", () => {
    const url = new URL(
      "/xrpc/app.bsky.feed.getPosts",
      "https://morel.us-east.host.bsky.network",
    );
    url.searchParams.append("uris", POST_URI);
    expect(authorizeBlueskyXrpcRequest({
      pdsOrigin: "https://morel.us-east.host.bsky.network",
      nsid: "app.bsky.feed.getPosts",
      url,
      method: "GET",
      expectedQuery: { uris: [POST_URI] },
      hasBody: false,
      proxy: BLUESKY_APPVIEW_PROXY,
    })).toEqual({
      nsid: "app.bsky.feed.getPosts",
      method: "GET",
      path: "/xrpc/app.bsky.feed.getPosts",
      queryNames: ["uris"],
      proxy: BLUESKY_APPVIEW_PROXY,
    });
    expect(authorizeBlueskyXrpcRequest({
      pdsOrigin: "https://morel.us-east.host.bsky.network",
      nsid: "com.atproto.server.refreshSession",
      url: "https://morel.us-east.host.bsky.network/xrpc/com.atproto.server.refreshSession",
      method: "POST",
      expectedQuery: {},
      hasBody: false,
      proxy: null,
    })).toMatchObject({
      nsid: "com.atproto.server.refreshSession",
      method: "POST",
      queryNames: [],
      proxy: null,
    });
    url.searchParams.append("unexpected", "value");
    expect(() =>
      authorizeBlueskyXrpcRequest({
        pdsOrigin: "https://morel.us-east.host.bsky.network",
        nsid: "app.bsky.feed.getPosts",
        url,
        method: "GET",
        expectedQuery: { uris: [POST_URI] },
        hasBody: false,
        proxy: BLUESKY_APPVIEW_PROXY,
      })
    ).toThrow("query names changed");
    expect(() =>
      authorizeBlueskyXrpcRequest({
        pdsOrigin: "https://morel.us-east.host.bsky.network",
        nsid: "app.bsky.feed.getPosts",
        url: new URL(
          `/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(POST_URI)}`,
          "https://morel.us-east.host.bsky.network",
        ),
        method: "GET",
        expectedQuery: { uris: [POST_URI] },
        hasBody: false,
        proxy: BLUESKY_CHAT_PROXY,
      })
    ).toThrow("proxy changed");
    expect(() =>
      authorizeBlueskyXrpcRequest({
        pdsOrigin: "https://bsky.social",
        nsid: "chat.bsky.convo.sendMessage",
        url: "https://bsky.social/xrpc/chat.bsky.convo/sendMessage",
        method: "POST",
        expectedQuery: {},
        hasBody: true,
        proxy: BLUESKY_CHAT_PROXY,
      })
    ).toThrow("exact reviewed XRPC endpoint");
  });

  test("parses exact AT URIs and rejects actor, collection, or record-key drift", () => {
    expect(parseBlueskyAtUri(POST_URI, "post", "app.bsky.feed.post")).toEqual({
      uri: POST_URI,
      actor: AUTHOR_DID,
      collection: "app.bsky.feed.post",
      rkey: "3lsynthetic",
    });
    expect(() =>
      parseBlueskyAtUri(
        `at://${AUTHOR_DID}/app.bsky.feed.like/3llike`,
        "post",
        "app.bsky.feed.post",
      )
    ).toThrow("must identify app.bsky.feed.post");
    expect(() =>
      parseBlueskyAtUri(
        `at://${AUTHOR_DID}/app.bsky.feed.post/a/b`,
        "post",
      )
    ).toThrow("exact record AT URI");
  });

  test("binds authoritative records to the exact created revision and submitted value", () => {
    const value = {
      $type: "app.bsky.feed.post",
      text: "Exact record",
      createdAt: "2026-08-18T12:00:00.000Z",
    };
    expect(parseBlueskyGetRecordResponse(
      { uri: POST_URI, cid: CID, value },
      { uri: POST_URI, cid: CID },
      value,
    )).toEqual({ uri: POST_URI, cid: CID });
    expect(() => parseBlueskyGetRecordResponse(
      { uri: POST_URI, cid: `b${"c".repeat(40)}`, value },
      { uri: POST_URI, cid: CID },
      value,
    )).toThrow("changed the created record CID");
    expect(() => parseBlueskyGetRecordResponse(
      { uri: POST_URI, cid: CID, value: { ...value, text: "Different" } },
      { uri: POST_URI, cid: CID },
      value,
    )).toThrow("confirmed record value");
    expect(() => parseBlueskyGetRecordResponse(
      { uri: POST_URI, cid: CID, value, extra: true },
      { uri: POST_URI, cid: CID },
      value,
    )).toThrow("unsupported fields");
  });

  test("projects posts, feeds, notifications, and threads without raw response fields or media URLs", () => {
    const withImage = postView(POST_URI, AUTHOR_DID, {
      embed: {
        $type: "app.bsky.embed.images#view",
        images: [{
          alt: "Synthetic alt",
          thumb: "https://cdn.example/private-thumb",
          fullsize: "https://cdn.example/private-full",
          aspectRatio: { width: 4, height: 3 },
        }],
      },
      debug: { private: "must-not-project" },
    });
    const projected = projectBlueskyPostsResponse({ posts: [withImage] }, POST_URI);
    expect(projected).toMatchObject({
      uri: POST_URI,
      author: { did: AUTHOR_DID, handle: "author.test" },
      text: "Synthetic post",
      viewer: { bookmarked: true },
      attachments: [{
        kind: "image",
        alt: "Synthetic alt",
        cid: null,
        recordUri: null,
        aspectRatio: { width: 4, height: 3 },
      }],
    });
    expect(JSON.stringify(projected)).not.toContain("private-thumb");
    expect(JSON.stringify(projected)).not.toContain("must-not-project");
    expect(projectBlueskyFeed({ feed: [{ post: withImage }], cursor: "next" }, 1))
      .toMatchObject({ posts: [{ uri: POST_URI }], cursor: "next", truncated: true });
    expect(projectBlueskyNotifications({
      notifications: [{
        uri: `at://${AUTHOR_DID}/app.bsky.feed.like/3lnotification`,
        cid: CID,
        author: { did: AUTHOR_DID, handle: "author.test" },
        reason: "like",
        reasonSubject: POST_URI,
        record: { private: "not-projected" },
        isRead: false,
        indexedAt: "2026-07-23T12:01:00.000Z",
      }],
    }, 10)).toMatchObject({
      notifications: [{ reason: "like", reasonSubject: POST_URI }],
    });
    expect(projectBlueskyThread({
      thread: {
        post: withImage,
        replies: [{
          post: postView(REPLY_URI, VIEWER_DID, {
            record: {
              $type: "app.bsky.feed.post",
              text: "Reply",
              createdAt: "2026-07-23T12:02:00.000Z",
              reply: {
                root: { uri: POST_URI, cid: CID },
                parent: { uri: POST_URI, cid: CID },
              },
            },
          }),
        }],
      },
    }, POST_URI, 10)).toMatchObject({
      post: { uri: POST_URI },
      replies: [{ uri: REPLY_URI, reply: { parent: { uri: POST_URI } } }],
      truncated: false,
    });
  });

  test("binds every projected conversation to the current DID", () => {
    const convo = {
      id: "convo-1",
      rev: "rev-1",
      members: [
        { did: VIEWER_DID, handle: "viewer.test" },
        { did: AUTHOR_DID, handle: "author.test" },
      ],
      muted: false,
      unreadCount: 1,
      lastMessage: {
        id: "message-1",
        rev: "message-rev-1",
        text: "Hello",
        sender: { did: AUTHOR_DID },
        sentAt: "2026-07-23T12:03:00.000Z",
      },
    };
    expect(projectBlueskyConvoList({ convos: [convo] }, VIEWER_DID, 10))
      .toMatchObject({
        conversations: [{
          id: "convo-1",
          members: [{ did: VIEWER_DID }, { did: AUTHOR_DID }],
          lastMessage: { id: "message-1", text: "Hello" },
        }],
      });
    expect(() =>
      projectBlueskyConvoList({
        convos: [{ ...convo, members: [{ did: AUTHOR_DID, handle: "author.test" }] }],
      }, VIEWER_DID, 10)
    ).toThrow("did not include the bound viewer");
  });

  test("keeps notification and chat proxy labels exact and distinct", () => {
    expect(BLUESKY_NOTIFICATION_PROXY).toBe(
      "did:web:api.bsky.app#bsky_notif",
    );
    expect(BLUESKY_CHAT_PROXY).toBe(
      "did:web:api.bsky.chat#bsky_chat",
    );
    expect(BLUESKY_NOTIFICATION_PROXY).not.toBe(BLUESKY_APPVIEW_PROXY);
  });
});
