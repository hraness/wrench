import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import { canonicalJson } from "../canonical-json";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  executeSubstackWebOperation,
  probeSubstackWebSubject,
  readSubstackWebAcceptedNoteTargetPresence,
  type SubstackWebRuntimeDependencies,
} from "./substack-web-runtime";

const USER_ID = 42;
const SUBJECT = `substack:${USER_ID}`;
const PUBLICATION_ID = 7;
const ARTICLE_ID = 101;
const NOTE_ID = 202;
const COMMENT_ID = 303;
const CREATED_NOTE_ID = 404;
const IMAGE_ID = 505;
const IMAGE_UUID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_UUID = "22222222-2222-4222-8222-222222222222";
const NOTE_BODY = "how your email finds me";

const boundAuth = {
  schemaVersion: 1,
  id: "substack-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Default",
  subject: SUBJECT,
} as const satisfies WrenchAuth;

const unboundAuth = {
  schemaVersion: 1,
  id: "substack-test-unbound",
  kind: "cookie-source",
  source: "arc",
  profile: "Default",
} as const satisfies WrenchAuth;

type CapturedRequest = {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
  readonly redirect: string | undefined;
};

function strictCookie(): StrictCookie {
  return {
    name: "substack.sid",
    value: "private-cookie-value",
    domain: ".substack.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: 0,
  };
}

function requestUrl(value: string | URL | Request): URL {
  return new URL(typeof value === "string" ? value : value instanceof URL ? value.href : value.url);
}

function dependencies(
  calls: CapturedRequest[],
  handler: (request: CapturedRequest) => Response | Promise<Response>,
  onAcquire?: () => void,
): SubstackWebRuntimeDependencies {
  const acquireCookies: CookieRecordReader = () => {
    onAcquire?.();
    return Promise.resolve({ cookies: [strictCookie()], warnings: [] });
  };
  const fetch = (async (value: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: requestUrl(value),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      redirect: typeof init?.redirect === "string" ? init.redirect : undefined,
    };
    calls.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return { acquireCookies, fetch };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function preloadHtml(userId = USER_ID): string {
  const payload = JSON.stringify({
    user: {
      id: userId,
      handle: "wrench-reader",
      name: "Wrench Reader",
      dashboard_pubs: [
        {
          id: PUBLICATION_ID,
          subdomain: "wrench-owned",
          primary_user_id: userId,
          can_post_notes_as_primary_user: true,
          is_publication_primary_user: true,
        },
      ],
    },
  });
  return `<script>window._preloads = JSON.parse(${JSON.stringify(payload)});</script>`;
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

function noteBodyJson(): unknown {
  return {
    type: "doc",
    attrs: { schemaVersion: "v1", title: null },
    content: [{
      type: "paragraph",
      content: [{ type: "text", text: NOTE_BODY }],
    }],
  };
}

function imageAttachment(imageUrl: string): unknown {
  return {
    explicit: false,
    id: ATTACHMENT_UUID,
    imageHeight: 1022,
    imageUrl,
    imageWidth: 959,
    type: "image",
  };
}

function createdNote(imageUrl: string): unknown {
  return {
    attachments: [imageAttachment(imageUrl)],
    body: NOTE_BODY,
    body_json: noteBodyJson(),
    deleted: false,
    id: CREATED_NOTE_ID,
    post_id: null,
    publication_id: null,
    reply_minimum_role: "everyone",
    status: "published",
    type: "feed",
    user_id: USER_ID,
  };
}

function noteReadback(imageUrl: string, body = NOTE_BODY): unknown {
  return {
    item: {
      entity_key: `c-${CREATED_NOTE_ID}`,
      type: "comment",
      comment: {
        id: CREATED_NOTE_ID,
        user_id: USER_ID,
        publication_id: null,
        post_id: null,
        body,
        type: "feed",
        reactions: {},
        attachments: [imageAttachment(imageUrl)],
      },
      post: null,
      publication: null,
    },
  };
}

function noteReadbackWithoutImage(body = NOTE_BODY): unknown {
  const value = noteReadback("unused", body) as {
    readonly item: Readonly<Record<string, unknown>> & {
      readonly comment: Readonly<Record<string, unknown>>;
    };
  };
  return {
    item: {
      ...value.item,
      comment: {
        ...value.item.comment,
        attachments: [],
      },
    },
  };
}

function post(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    id: ARTICLE_ID,
    publication_id: PUBLICATION_ID,
    title: "Article",
    body_html: "<p>Body</p>",
    reactions: {},
    audio_items: [],
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

function comment(id = COMMENT_ID, postId: number | null = ARTICLE_ID): unknown {
  return {
    id,
    user_id: 55,
    publication_id: postId === null ? null : PUBLICATION_ID,
    post_id: postId,
    body: "Comment",
    reactions: {},
    attachments: [],
  };
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "substack",
    action,
    contractVersion: action === "posts.publish" ? 3 : 1,
    timeoutMs: 1_000,
    maxOutputBytes: 8 * 1024 * 1024,
  };
}

function bootstrapResponse(request: CapturedRequest, userId = USER_ID): Response | null {
  if (request.url.pathname === "/api/v1/am_i_logged_in") {
    return jsonResponse({ loggedIn: true, expires: "later", ageVerification: null });
  }
  if (request.url.pathname === "/") return textResponse(preloadHtml(userId));
  return null;
}

describe("Substack authenticated internal API runtime", () => {
  test("probes the exact current account through direct first-party reads", async () => {
    const calls: CapturedRequest[] = [];
    const subject = await probeSubstackWebSubject(unboundAuth, {
      dependencies: dependencies(calls, (request) => {
        const response = bootstrapResponse(request);
        if (response === null) throw new Error(`unexpected ${request.url.pathname}`);
        return response;
      }),
    });
    expect(subject).toBe(SUBJECT);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/v1/am_i_logged_in",
      "/",
    ]);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.redirect).toBe("error");
      expect(call.headers.get("cookie")).toContain("substack.sid=");
      expect(call.body).toBeNull();
    }
  });

  test("executes every observed R1 contract with no dispatch callback", async () => {
    const scenarios: readonly {
      readonly action: WebSessionRecipe["action"];
      readonly input: OperationInput;
      readonly expectedSemanticPaths: readonly string[];
      readonly verify: (output: unknown) => void;
    }[] = [
      {
        action: "feeds.read",
        input: { feed: "notes", limit: 1 },
        expectedSemanticPaths: ["/api/v1/reader/feed"],
        verify: (output) => expect((output as { items: readonly unknown[] }).items).toHaveLength(1),
      },
      {
        action: "posts.read",
        input: { note_id: NOTE_ID },
        expectedSemanticPaths: [`/api/v1/reader/comment/${NOTE_ID}`],
        verify: (output) => expect((output as { comment: { id: number } }).comment.id).toBe(NOTE_ID),
      },
      {
        action: "articles.read",
        input: { article_id: ARTICLE_ID },
        expectedSemanticPaths: [`/api/v1/posts/by-id/${ARTICLE_ID}`],
        verify: (output) => expect((output as { post: { id: number } }).post.id).toBe(ARTICLE_ID),
      },
      {
        action: "media.read",
        input: { article_id: ARTICLE_ID },
        expectedSemanticPaths: [`/api/v1/posts/by-id/${ARTICLE_ID}`],
        verify: (output) => expect((output as { articleId: number }).articleId).toBe(ARTICLE_ID),
      },
      {
        action: "comments.read",
        input: { article_id: ARTICLE_ID, publication_id: PUBLICATION_ID, limit: 5 },
        expectedSemanticPaths: [
          `/api/v1/posts/by-id/${ARTICLE_ID}`,
          `/api/v1/reader/post/${ARTICLE_ID}/replies`,
        ],
        verify: (output) => expect((output as { comments: readonly unknown[] }).comments).toHaveLength(1),
      },
      {
        action: "messaging.list",
        input: { folder: "people", limit: 5 },
        expectedSemanticPaths: ["/api/v1/messages/inbox"],
        verify: (output) => expect((output as { threads: readonly unknown[] }).threads).toHaveLength(1),
      },
    ];

    for (const scenario of scenarios) {
      const calls: CapturedRequest[] = [];
      let beforeDispatch = 0;
      let afterDispatch = 0;
      const result = await executeSubstackWebOperation(
        recipe(scenario.action),
        scenario.input,
        boundAuth,
        {
          beforeDispatch: () => {
            beforeDispatch += 1;
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            afterDispatch += 1;
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            switch (request.url.pathname) {
              case "/api/v1/reader/feed":
                return jsonResponse({
                  items: [{
                    entity_key: `c-${NOTE_ID}`,
                    type: "comment",
                    comment: comment(NOTE_ID, null),
                    post: null,
                    publication: null,
                    canReply: true,
                  }],
                  nextCursor: null,
                });
              case `/api/v1/reader/comment/${NOTE_ID}`:
                return jsonResponse({
                  item: {
                    entity_key: `c-${NOTE_ID}`,
                    type: "comment",
                    comment: comment(NOTE_ID, null),
                    post: null,
                    publication: null,
                  },
                });
              case `/api/v1/posts/by-id/${ARTICLE_ID}`:
                return jsonResponse({ post: post(), publication: publication() });
              case `/api/v1/reader/post/${ARTICLE_ID}/replies`:
                expect(request.url.searchParams.get("publication_id")).toBe(String(PUBLICATION_ID));
                return jsonResponse({
                  commentBranches: [{ comment: comment(), descendantComments: [] }],
                  nextCursor: null,
                  moreBranches: 0,
                });
              case "/api/v1/messages/inbox":
                expect(request.url.searchParams.get("tab")).toBe("people");
                return jsonResponse({
                  threads: [{
                    id: "thread-1",
                    type: "direct-message",
                    title: "Conversation",
                    user: { id: 55, name: "Recipient", handle: "recipient" },
                    publication: null,
                  }],
                  more: false,
                });
              default:
                throw new Error(`unexpected ${request.url.pathname}`);
            }
          }),
        },
      );
      expect(result.status).toBe("succeeded");
      expect(result.dispatchStarted).toBe(false);
      expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      expect(beforeDispatch).toBe(0);
      expect(afterDispatch).toBe(0);
      expect(calls.slice(2).map((call) => call.url.pathname)).toEqual(
        [...scenario.expectedSemanticPaths],
      );
      scenario.verify(result.output);
    }
  });

  test("uploads one plan-bound PNG, publishes one Note, and verifies exact independent readback", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-substack-note-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    const imageBytes = pngFixture(959, 1022);
    writeFileSync(imagePath, imageBytes, { mode: 0o600 });
    const imageUrl = `https://substack-post-media.s3.amazonaws.com/public/images/${IMAGE_UUID}_959x1022.png`;
    const calls: CapturedRequest[] = [];
    const events: string[] = [];
    try {
      const result = await executeSubstackWebOperation(
        recipe("posts.publish"),
        {
          body: NOTE_BODY,
          media: { kind: "file", reference: "fixture" },
        },
        boundAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          beforeDispatch: (event) => {
            events.push(`before ${event.progress.started}`);
            return Promise.resolve();
          },
          afterProviderAcceptedMutationTarget: (event) => {
            expect(event).toEqual({
              id: "posts.publish",
              index: 1,
              target: {
                schemaVersion: 1,
                identifier: canonicalJson({
                  noteId: CREATED_NOTE_ID,
                  attachment: {
                    id: ATTACHMENT_UUID,
                    url: imageUrl,
                    height: 1022,
                    width: 959,
                    mediaType: "image/png",
                  },
                }),
              },
            });
            events.push(`accepted ${event.target.identifier}`);
            return Promise.resolve();
          },
          afterDispatchVerified: (event) => {
            events.push(`after ${event.progress.verified}`);
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            events.push(`${request.method} ${request.url.pathname}`);
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            if (request.method === "POST" && request.url.pathname === "/api/v1/image") {
              expect(request.headers.get("content-type")).toBe("application/json");
              expect(JSON.parse(request.body ?? "null")).toEqual({
                image: `data:image/png;base64,${imageBytes.toString("base64")}`,
              });
              return jsonResponse({
                bytes: imageBytes.byteLength,
                contentType: "image/png",
                id: IMAGE_ID,
                imageHeight: 1022,
                imageWidth: 959,
                url: imageUrl,
              });
            }
            if (
              request.method === "POST"
              && request.url.pathname === "/api/v1/comment/attachment"
            ) {
              expect(JSON.parse(request.body ?? "null")).toEqual({
                type: "image",
                url: imageUrl,
              });
              return jsonResponse(imageAttachment(imageUrl));
            }
            if (request.method === "POST" && request.url.pathname === "/api/v1/comment/feed") {
              expect(JSON.parse(request.body ?? "null")).toEqual({
                bodyJson: noteBodyJson(),
                attachmentIds: [ATTACHMENT_UUID],
                tabId: "for-you",
                surface: "feed",
                replyMinimumRole: "everyone",
              });
              return jsonResponse(createdNote(imageUrl));
            }
            if (
              request.method === "GET"
              && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
            ) return jsonResponse(noteReadback(imageUrl));
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        output: {
          note: {
            entityKey: `c-${CREATED_NOTE_ID}`,
            comment: {
              id: CREATED_NOTE_ID,
              userId: USER_ID,
              body: NOTE_BODY,
              attachments: [{
                id: ATTACHMENT_UUID,
                imageUrl,
                width: 959,
                height: 1022,
              }],
            },
          },
          attachment: { height: 1022, mediaType: "image/png", width: 959 },
        },
        finalUrl: `https://substack.com/@wrench-reader/note/c-${CREATED_NOTE_ID}`,
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
      expect(events).toEqual([
        "GET /api/v1/am_i_logged_in",
        "GET /",
        "GET /api/v1/am_i_logged_in",
        "GET /",
        "before 0",
        "POST /api/v1/image",
        "POST /api/v1/comment/attachment",
        "POST /api/v1/comment/feed",
        `accepted ${canonicalJson({
          noteId: CREATED_NOTE_ID,
          attachment: {
            id: ATTACHMENT_UUID,
            url: imageUrl,
            height: 1022,
            width: 959,
            mediaType: "image/png",
          },
        })}`,
        `GET /api/v1/reader/comment/${CREATED_NOTE_ID}`,
        "after 1",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marks a Substack image-upload failure indeterminate after durable dispatch and never creates a Note", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-substack-upload-failure-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, pngFixture(959, 1022), { mode: 0o600 });
    const calls: CapturedRequest[] = [];
    let beforeDispatch = 0;
    let creates = 0;
    try {
      const result = await executeSubstackWebOperation(
        recipe("posts.publish"),
        {
          body: NOTE_BODY,
          media: { kind: "file", reference: "fixture" },
        },
        boundAuth,
        {
          fileResolver: () => Promise.resolve([imagePath]),
          beforeDispatch: () => {
            beforeDispatch += 1;
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            if (request.method === "POST" && request.url.pathname === "/api/v1/image") {
              return new Response(JSON.stringify({ error: "upload failed" }), {
                status: 500,
                headers: { "content-type": "application/json" },
              });
            }
            if (request.url.pathname === "/api/v1/comment/feed") creates += 1;
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
        error: expect.stringContaining("stage: image-upload"),
      });
      expect(String(result.error)).not.toContain("upload failed");
      expect(beforeDispatch).toBe(1);
      expect(creates).toBe(0);
      expect(calls.filter((call) => call.url.pathname === "/api/v1/image")).toHaveLength(1);
      expect(calls.filter((call) => call.url.pathname === "/api/v1/comment/attachment")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("delays and retries only the exact readback until the created Note becomes visible", async () => {
    const calls: CapturedRequest[] = [];
    let dispatches = 0;
    let readbacks = 0;
    let verified = 0;
    const delays: number[] = [];
    const result = await executeSubstackWebOperation(
      recipe("posts.publish"),
      { body: NOTE_BODY },
      boundAuth,
      {
        beforeDispatch: () => Promise.resolve(),
        afterDispatchVerified: () => {
          verified += 1;
          return Promise.resolve();
        },
        dependencies: {
          ...dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            if (request.method === "POST" && request.url.pathname === "/api/v1/comment/feed") {
              dispatches += 1;
              return jsonResponse({
                ...createdNote("https://substack-post-media.s3.amazonaws.com/public/images/11111111-1111-4111-8111-111111111111_959x1022.png") as object,
                attachments: [],
              });
            }
            if (
              request.method === "GET"
              && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
            ) {
              readbacks += 1;
              expect(request.body).toBeNull();
              if (readbacks === 1) return jsonResponse({ error: "not visible" }, 404);
              if (readbacks === 2) return jsonResponse(noteReadbackWithoutImage("provider drift"));
              return jsonResponse(noteReadbackWithoutImage());
            }
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
          sleep: (milliseconds) => {
            delays.push(milliseconds);
            return Promise.resolve();
          },
        },
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(dispatches).toBe(1);
    expect(readbacks).toBe(3);
    expect(delays).toEqual([500, 1_500]);
    expect(verified).toBe(1);
    expect(calls.filter((call) => call.url.pathname === "/api/v1/comment/feed")).toHaveLength(1);
  });

  test("returns a safe readback-stage diagnostic after the bounded exact-read window", async () => {
    const calls: CapturedRequest[] = [];
    const delays: number[] = [];
    let dispatches = 0;
    let readbacks = 0;
    const result = await executeSubstackWebOperation(
      recipe("posts.publish"),
      { body: NOTE_BODY },
      boundAuth,
      {
        beforeDispatch: () => Promise.resolve(),
        dependencies: {
          ...dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            if (request.method === "POST" && request.url.pathname === "/api/v1/comment/feed") {
              dispatches += 1;
              return jsonResponse({
                ...createdNote("https://substack-post-media.s3.amazonaws.com/public/images/11111111-1111-4111-8111-111111111111_959x1022.png") as object,
                attachments: [],
              });
            }
            if (
              request.method === "GET"
              && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
            ) {
              readbacks += 1;
              return jsonResponse(noteReadbackWithoutImage("private provider diagnostic"));
            }
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
          sleep: (milliseconds) => {
            delays.push(milliseconds);
            return Promise.resolve();
          },
        },
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
      error: expect.stringContaining("stage: note-readback"),
    });
    expect(String(result.error)).not.toContain("private provider diagnostic");
    expect(dispatches).toBe(1);
    expect(readbacks).toBe(4);
    expect(delays).toEqual([500, 1_500, 4_000]);
    expect(calls.filter((call) => call.url.pathname === "/api/v1/comment/feed")).toHaveLength(1);
  });

  test("reads only the exact accepted Substack Note target for later presence reconciliation", async () => {
    const calls: CapturedRequest[] = [];
    const imageUrl = `https://substack-post-media.s3.amazonaws.com/public/images/${IMAGE_UUID}_959x1022.png`;
    const acceptedIdentifier = canonicalJson({
      noteId: CREATED_NOTE_ID,
      attachment: {
        id: ATTACHMENT_UUID,
        url: imageUrl,
        height: 1022,
        width: 959,
        mediaType: "image/png",
      },
    });
    expect(await readSubstackWebAcceptedNoteTargetPresence(
      recipe("posts.publish"),
      {
        body: NOTE_BODY,
        media: { kind: "file", reference: "fixture" },
      },
      boundAuth,
      acceptedIdentifier,
      {
        dependencies: dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request);
          if (bootstrap !== null) return bootstrap;
          if (
            request.method === "GET"
            && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
          ) return jsonResponse(noteReadback(imageUrl));
          throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
        }),
      },
    )).toEqual({ present: true, noteId: CREATED_NOTE_ID });
    expect(calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/am_i_logged_in"],
      ["GET", "/"],
      ["GET", `/api/v1/reader/comment/${CREATED_NOTE_ID}`],
    ]);
    await expect(readSubstackWebAcceptedNoteTargetPresence(
      recipe("posts.publish"),
      {
        body: NOTE_BODY,
        media: { kind: "file", reference: "fixture" },
      },
      boundAuth,
      JSON.stringify({ noteId: CREATED_NOTE_ID, attachment: null }),
      { dependencies: dependencies([], () => {
        throw new Error("noncanonical target must not touch the network");
      }) },
    )).rejects.toThrow("canonical JSON");
  });

  test("rejects capture-required operations before cookies or network are touched", () => {
    for (const action of [
      "messaging.read",
      "likes.set",
      "content.save",
      "messaging.send",
      "articles.publish",
    ] as const) {
      let acquisitions = 0;
      expect(executeSubstackWebOperation(
        recipe(action),
        {},
        boundAuth,
        {
          dependencies: dependencies([], () => {
            throw new Error("network must not run");
          }, () => {
            acquisitions += 1;
          }),
        },
      )).rejects.toThrow("capture-required");
      expect(acquisitions).toBe(0);
    }
  });

  test("fails closed when the signed-in viewer changes before the semantic read", () => {
    const calls: CapturedRequest[] = [];
    expect(executeSubstackWebOperation(
      recipe("feeds.read"),
      { feed: "notes" },
      boundAuth,
      {
        dependencies: dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request, USER_ID + 1);
          if (bootstrap !== null) return bootstrap;
          throw new Error("semantic request must not run");
        }),
      },
    )).rejects.toThrow("no longer matches");
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/v1/am_i_logged_in",
      "/",
    ]);
  });

  test("fails closed on cross-origin and publication mismatches", () => {
    const calls: CapturedRequest[] = [];
    expect(executeSubstackWebOperation(
      recipe("comments.read"),
      { article_id: ARTICLE_ID, publication_id: PUBLICATION_ID + 1 },
      boundAuth,
      {
        dependencies: dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request);
          if (bootstrap !== null) return bootstrap;
          if (request.url.pathname === `/api/v1/posts/by-id/${ARTICLE_ID}`) {
            return jsonResponse({ post: post(), publication: publication() });
          }
          throw new Error("replies request must not run");
        }),
      },
    )).rejects.toThrow("did not match");
    expect(calls.at(-1)?.url.pathname).toBe(`/api/v1/posts/by-id/${ARTICLE_ID}`);
  });
});
