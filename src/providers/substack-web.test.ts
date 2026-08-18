import { describe, expect, test } from "bun:test";

import substackWebManifest from "../assets/adapters/substack/wrench-web-adapter.json";
import {
  SUBSTACK_WEB_OPERATION_NAMES,
  SUBSTACK_WEB_OPERATIONS,
  authorizeSubstackWebReadRequest,
  normalizeSubstackArticleResponse,
  normalizeSubstackCommentsResponse,
  normalizeSubstackFeedResponse,
  normalizeSubstackMediaResponse,
  normalizeSubstackMessageInbox,
  normalizeSubstackNoteResponse,
  parseSubstackLoggedInResponse,
  parseSubstackPreloadsHtml,
} from "./substack-web";

const USER_ID = 42;
const PUBLICATION_ID = 7;
const ARTICLE_ID = 101;
const NOTE_ID = 202;
const COMMENT_ID = 303;

function preloadsHtml(overrides: Readonly<Record<string, unknown>> = {}): string {
  const payload = JSON.stringify({
    user: {
      id: USER_ID,
      handle: "wrench-reader",
      name: "Wrench Reader",
      dashboard_pubs: [
        {
          id: PUBLICATION_ID,
          name: "Owned Publication",
          subdomain: "wrench-owned",
          primary_user_id: USER_ID,
          can_post_notes_as_primary_user: true,
          is_publication_primary_user: true,
        },
      ],
      ...overrides,
    },
  });
  return `<html><script>window._preloads = JSON.parse(${JSON.stringify(payload)});</script></html>`;
}

function post(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: ARTICLE_ID,
    publication_id: PUBLICATION_ID,
    title: "An article",
    subtitle: "A subtitle",
    description: "Description",
    truncated_body_text: "Excerpt",
    body_html: "<p>Full entitled body</p>",
    slug: "an-article",
    type: "newsletter",
    audience: "everyone",
    post_date: "2026-07-23T12:00:00.000Z",
    canonical_url: "https://wrench-owned.substack.com/p/an-article",
    cover_image: "https://substackcdn.com/image/fetch/cover.jpg",
    podcast_url: null,
    reaction: true,
    reaction_count: 4,
    reactions: { "❤": 4 },
    comment_count: 2,
    child_comment_count: 1,
    restacks: 3,
    restacked: false,
    is_saved: true,
    is_published: true,
    audio_items: [],
    video_upload_id: null,
    ...overrides,
  };
}

function publication(): unknown {
  return {
    id: PUBLICATION_ID,
    name: "Owned Publication",
    subdomain: "wrench-owned",
    hostname: "wrench-owned.substack.com",
    base_url: "https://wrench-owned.substack.com",
    author_id: USER_ID,
  };
}

function comment(
  id = COMMENT_ID,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    id,
    user_id: 55,
    publication_id: PUBLICATION_ID,
    post_id: ARTICLE_ID,
    name: "Commenter",
    handle: "commenter",
    body: "Comment body",
    type: "comment",
    date: "2026-07-23T12:01:00.000Z",
    edited_at: null,
    ancestor_path: "",
    reaction: false,
    reaction_count: 2,
    reactions: { "❤": 2 },
    restacks: 0,
    restacked: false,
    is_saved: false,
    children_count: 0,
    attachments: [],
    ...overrides,
  };
}

describe("Substack internal-web operation registry", () => {
  test("ships one schema-v4 semantic manifest entry for every provider operation", () => {
    expect(substackWebManifest.schemaVersion).toBe(4);
    expect(substackWebManifest.id).toBe("substack-web");
    expect(substackWebManifest.version).toBe("1.2.0");
    expect(substackWebManifest.surfaceId).toBe("substack");
    expect(substackWebManifest.origins).toEqual(["https://substack.com"]);
    expect(Object.keys(substackWebManifest.operations).sort()).toEqual(
      [...SUBSTACK_WEB_OPERATION_NAMES].sort(),
    );
    for (const action of SUBSTACK_WEB_OPERATION_NAMES) {
      const operation = substackWebManifest.operations[action];
      expect(operation.description.startsWith(
        SUBSTACK_WEB_OPERATIONS[action].state === "observed"
          ? "Observed contract:"
          : "Capture-required contract reservation:",
      )).toBe(true);
      expect(operation.webSession).toMatchObject({
        site: "substack",
        action,
        contractVersion: action === "posts.publish" ? 3 : 1,
      });
      expect("browser" in operation).toBe(false);
      expect("provider" in operation).toBe(false);
    }
  });

  test("graduates only the direct reads and authorized Note publication proved against the current site", () => {
    expect(
      Object.entries(SUBSTACK_WEB_OPERATIONS)
        .filter(([, contract]) => contract.state === "observed")
        .map(([name]) => name)
        .sort(),
    ).toEqual([
      "articles.read",
      "comments.read",
      "feeds.read",
      "media.read",
      "messaging.list",
      "posts.publish",
      "posts.read",
    ]);
    expect(SUBSTACK_WEB_OPERATIONS["messaging.read"].state).toBe("capture-required");
    for (const operation of [
      "likes.set",
      "content.save",
      "relationships.follow.set",
    ] as const) {
      expect(SUBSTACK_WEB_OPERATIONS[operation].risk).toBe("R2");
      expect(SUBSTACK_WEB_OPERATIONS[operation].state).toBe("capture-required");
    }
    for (const operation of [
      "messaging.send",
      "articles.publish",
      "content.schedule",
    ] as const) {
      expect(SUBSTACK_WEB_OPERATIONS[operation].risk).toBe("R3");
      expect(SUBSTACK_WEB_OPERATIONS[operation].state).toBe("capture-required");
    }
  });
});

describe("Substack exact request authorization", () => {
  test("accepts exact central read routes and returns value-free bindings", () => {
    expect(authorizeSubstackWebReadRequest({
      operation: "feeds.reader",
      url: "https://substack.com/api/v1/reader/feed",
      method: "GET",
    })).toEqual({
      operation: "feeds.reader",
      method: "GET",
      path: "/api/v1/reader/feed",
      queryNames: [],
    });
    expect(authorizeSubstackWebReadRequest({
      operation: "comments.read",
      url: `https://substack.com/api/v1/reader/post/${ARTICLE_ID}/replies?publication_id=${PUBLICATION_ID}&cursor=opaque`,
      method: "GET",
      targetId: ARTICLE_ID,
      publicationId: PUBLICATION_ID,
    }).queryNames).toEqual(["cursor", "publication_id"]);
    expect(authorizeSubstackWebReadRequest({
      operation: "messages.list",
      url: "https://substack.com/api/v1/messages/inbox?tab=people",
      method: "GET",
      folder: "people",
    }).path).toBe("/api/v1/messages/inbox");
  });

  test("rejects origin, target, query, method, and folder drift", () => {
    expect(() => authorizeSubstackWebReadRequest({
      operation: "articles.read",
      url: `https://evil.example/api/v1/posts/by-id/${ARTICLE_ID}`,
      method: "GET",
      targetId: ARTICLE_ID,
    })).toThrow("exact https://substack.com origin");
    expect(() => authorizeSubstackWebReadRequest({
      operation: "articles.read",
      url: `https://substack.com/api/v1/posts/by-id/${ARTICLE_ID + 1}`,
      method: "GET",
      targetId: ARTICLE_ID,
    })).toThrow("did not bind");
    expect(() => authorizeSubstackWebReadRequest({
      operation: "feeds.inbox",
      url: "https://substack.com/api/v1/inbox/top?mark=true",
      method: "GET",
    })).toThrow("changed");
    expect(() => authorizeSubstackWebReadRequest({
      operation: "viewer.logged-in",
      url: "https://substack.com/api/v1/am_i_logged_in",
      method: "POST",
    })).toThrow("body-free GET");
    expect(() => authorizeSubstackWebReadRequest({
      operation: "messages.list",
      url: "https://substack.com/api/v1/messages/inbox?tab=unread",
      method: "GET",
      folder: "people",
    })).toThrow("requested folder");
  });
});

describe("Substack account and response projection", () => {
  test("parses one strict preload assignment and publication bindings", () => {
    expect(parseSubstackPreloadsHtml(preloadsHtml())).toEqual({
      id: USER_ID,
      handle: "wrench-reader",
      name: "Wrench Reader",
      publications: [
        {
          id: PUBLICATION_ID,
          origin: "https://wrench-owned.substack.com",
          primaryUserId: USER_ID,
          canPostNotesAsPrimaryUser: true,
          isPublicationPrimaryUser: true,
        },
      ],
    });
    expect(() => parseSubstackPreloadsHtml(
      `${preloadsHtml()}<script>window._preloads = JSON.parse("{}");</script>`,
    )).toThrow("exactly one");
    expect(() => parseSubstackPreloadsHtml(
      "<script>window._preloads = eval('{}')</script>",
    )).toThrow("strict preload JSON");
    expect(() => parseSubstackLoggedInResponse({ loggedIn: false })).toThrow("not signed in");
    expect(parseSubstackLoggedInResponse({ loggedIn: true })).toBeUndefined();
  });

  test("accepts an absent primary user only for secondary dashboard publication metadata", () => {
    expect(parseSubstackPreloadsHtml(preloadsHtml({
      dashboard_pubs: [
        {
          id: PUBLICATION_ID,
          subdomain: "wrench-secondary",
          primary_user_id: null,
          can_post_notes_as_primary_user: false,
          is_publication_primary_user: false,
        },
      ],
    })).publications).toEqual([
      {
        id: PUBLICATION_ID,
        origin: "https://wrench-secondary.substack.com",
        primaryUserId: null,
        canPostNotesAsPrimaryUser: false,
        isPublicationPrimaryUser: false,
      },
    ]);
    expect(() => parseSubstackPreloadsHtml(preloadsHtml({
      dashboard_pubs: [{
        id: PUBLICATION_ID,
        subdomain: "wrench-secondary",
        primary_user_id: "42",
      }],
    }))).toThrow("positive safe integer");
  });

  test("projects reader feeds, exact Notes, articles, comments, media, and inbox threads", () => {
    const notes = normalizeSubstackFeedResponse({
      items: [
        {
          entity_key: `c-${NOTE_ID}`,
          type: "comment",
          comment: comment(NOTE_ID, { post_id: null, publication_id: null }),
          post: null,
          publication: null,
          canReply: true,
        },
      ],
      nextCursor: "next",
    }, "notes", 10) as { readonly items: readonly unknown[] };
    expect(notes.items).toHaveLength(1);

    const articleList = normalizeSubstackFeedResponse({
      posts: [post()],
      cursor: "next",
      more: true,
    }, "inbox", 10) as { readonly items: readonly unknown[] };
    expect(articleList.items).toHaveLength(1);

    const article = normalizeSubstackArticleResponse({
      post: post(),
      publication: publication(),
    }, ARTICLE_ID) as { readonly post: { readonly bodyHtml: string } };
    expect(article.post.bodyHtml).toContain("Full entitled body");

    const note = normalizeSubstackNoteResponse({
      item: {
        entity_key: `c-${NOTE_ID}`,
        type: "comment",
        comment: comment(NOTE_ID, { post_id: null, publication_id: null }),
        post: null,
        publication: null,
      },
    }, NOTE_ID) as { readonly comment: { readonly id: number } };
    expect(note.comment.id).toBe(NOTE_ID);

    const replies = normalizeSubstackCommentsResponse({
      commentBranches: [
        {
          comment: comment(),
          descendantComments: [
            { type: "reply", comment: comment(COMMENT_ID + 1) },
          ],
        },
      ],
      nextCursor: null,
      moreBranches: 0,
    }, ARTICLE_ID, 10) as { readonly comments: readonly unknown[] };
    expect(replies.comments).toHaveLength(2);

    const media = normalizeSubstackMediaResponse({
      post: post({
        video_upload_id: "video-1",
        audio_items: [{ id: "audio-1", audio_url: "https://substackcdn.com/audio.mp3", duration: 30 }],
      }),
      publication: publication(),
    }, ARTICLE_ID) as { readonly videoUploadId: string; readonly audioItems: readonly unknown[] };
    expect(media.videoUploadId).toBe("video-1");
    expect(media.audioItems).toHaveLength(1);

    const inbox = normalizeSubstackMessageInbox({
      threads: [
        {
          type: "chat",
          id: "publication-7",
          title: "Publication chat",
          subtitleBody: "Latest message",
          publication: publication(),
          user: null,
        },
      ],
      more: false,
      pendingInviteCount: 0,
      directMessagesUnreadCount: 0,
      pubChatUnreadCount: 1,
    }, "all", 10) as { readonly threads: readonly unknown[] };
    expect(inbox.threads).toHaveLength(1);
  });

  test("rejects cross-target article, Note, reply, and publication responses", () => {
    expect(() => normalizeSubstackArticleResponse({
      post: post({ id: ARTICLE_ID + 1 }),
      publication: publication(),
    }, ARTICLE_ID)).toThrow("requested article");
    expect(() => normalizeSubstackArticleResponse({
      post: post(),
      publication: { ...publication() as object, id: PUBLICATION_ID + 1 },
    }, ARTICLE_ID)).toThrow("publication did not bind");
    expect(() => normalizeSubstackNoteResponse({
      item: { comment: comment(NOTE_ID + 1), post: null, publication: null },
    }, NOTE_ID)).toThrow("requested entity");
    expect(() => normalizeSubstackCommentsResponse({
      commentBranches: [
        { comment: comment(COMMENT_ID, { post_id: ARTICLE_ID + 1 }), descendantComments: [] },
      ],
      nextCursor: null,
      moreBranches: 0,
    }, ARTICLE_ID, 10)).toThrow("another article");
  });
});
