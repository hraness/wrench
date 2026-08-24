import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import { canonicalJson } from "../canonical-json";
import type { OperationInput, WebSessionRecipe } from "../model";
import type { WebSessionOperationDeadline } from "../web-session-execution";
import {
  assertSubstackNoteDeletionPreRead,
  classifySubstackVideoUploadState,
  createSubstackVideoMultipartDispatchCheckpoint,
  executeSubstackWebOperation,
  materializeSubstackVideo,
  parseSubstackNoteDeletionRecoveryTargetIdentifier,
  parseSubstackVideoBinding,
  parseSubstackVideoMultipartEtags,
  parseSubstackVideoUploadRecoveryTargetIdentifier,
  parseSubstackVideoUploadState,
  planSubstackVideoMultipartParts,
  prepareSubstackPersonalNoteDeleteInput,
  prepareSubstackVideoNotePublishInput,
  probeSubstackWebSubject,
  readSubstackWebAcceptedNoteTargetPresence,
  readSubstackWebContentDeleteDesiredState,
  revalidateAndSnapshotSubstackVideoMultipartDispatch,
  SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES,
  substackNoteDeletionRecoveryReadRequest,
  substackNoteDeletionRecoveryTargetIdentifier,
  substackPersonalNoteDeleteRequest,
  substackVideoStatusRequest,
  substackVideoTranscodeRequest,
  substackVideoTranscodeRequestForBinding,
  substackVideoUploadRecoveryStatusRequest,
  substackVideoUploadRecoveryTargetIdentifier,
  substackVideoUploadInitializationRequest,
  substackVideoUploadInitializationRequestForBinding,
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
const AUDIO_UPLOAD_ID = "5af42c51-bb3d-44a9-bf33-65479016b0e6";

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

function preloadHtml(
  userId = USER_ID,
  publicationOverrides: Readonly<Record<string, unknown>> = {},
): string {
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
          ...publicationOverrides,
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

function mp4Fixture(mdatPayloadByteLength = 4): Buffer {
  const box = (type: string, ...payloads: readonly Uint8Array[]): Buffer => {
    const payloadBytes = payloads.reduce((total, payload) => total + payload.byteLength, 0);
    const result = Buffer.alloc(8 + payloadBytes);
    result.writeUInt32BE(result.byteLength, 0);
    result.write(type, 4, 4, "ascii");
    let offset = 8;
    for (const payload of payloads) {
      Buffer.from(payload).copy(result, offset);
      offset += payload.byteLength;
    }
    return result;
  };
  const fileType = Buffer.alloc(16);
  fileType.write("isom", 0, 4, "ascii");
  fileType.writeUInt32BE(0x200, 4);
  fileType.write("isomiso2", 8, 8, "ascii");
  const trackHeader = Buffer.alloc(84);
  for (const [index, value] of [
    0x0001_0000, 0, 0,
    0, 0x0001_0000, 0,
    0, 0, 0x4000_0000,
  ].entries()) trackHeader.writeUInt32BE(value, 40 + index * 4);
  trackHeader.writeUInt32BE(640 * 65_536, 76);
  trackHeader.writeUInt32BE(360 * 65_536, 80);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  const mediaHeader = Buffer.alloc(24);
  mediaHeader.writeUInt32BE(1_000, 12);
  mediaHeader.writeUInt32BE(12_345, 16);
  const prefix = Buffer.concat([
    box("ftyp", fileType),
    box(
      "moov",
      box(
        "trak",
        box("tkhd", trackHeader),
        box("mdia", box("hdlr", handler), box("mdhd", mediaHeader)),
      ),
    ),
  ]);
  const result = Buffer.alloc(prefix.byteLength + 8 + mdatPayloadByteLength);
  prefix.copy(result);
  result.writeUInt32BE(8 + mdatPayloadByteLength, prefix.byteLength);
  result.write("mdat", prefix.byteLength + 4, 4, "ascii");
  const payloadOffset = prefix.byteLength + 8;
  if (mdatPayloadByteLength === 4) {
    Buffer.from([1, 2, 3, 4]).copy(result, payloadOffset);
  } else {
    result.fill(0xa5, payloadOffset);
  }
  return result;
}

function substackVideoBinding(bytesValue: Uint8Array): {
  bytes: Uint8Array<ArrayBuffer>;
  byteLength: number;
  durationSeconds: number;
  height: number;
  mediaType: "video/mp4";
  sha256: string;
  width: number;
} {
  const bytes = new Uint8Array(bytesValue);
  return {
    bytes,
    byteLength: bytes.byteLength,
    durationSeconds: 12.345,
    height: 360,
    mediaType: "video/mp4",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 640,
  };
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

function createdTextNote(): Record<string, unknown> {
  const imageUrl =
    `https://substack-post-media.s3.amazonaws.com/public/images/${IMAGE_UUID}_959x1022.png`;
  return {
    ...createdNote(imageUrl) as Record<string, unknown>,
    attachments: [],
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
    body_html: `<p>Body</p><audio src="/api/v1/audio/upload/${AUDIO_UPLOAD_ID}/src"></audio>`,
    reactions: {},
    audio_items: [{
      id: "tts-audio",
      audio_url: "https://substackcdn.com/tts-audio.mp3",
      duration: 60,
    }],
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

function bootstrapResponse(
  request: CapturedRequest,
  userId = USER_ID,
  publicationOverrides: Readonly<Record<string, unknown>> = {},
): Response | null {
  if (request.url.pathname === "/api/v1/am_i_logged_in") {
    return jsonResponse({ loggedIn: true, expires: "later", ageVerification: null });
  }
  if (request.url.pathname === "/") {
    return textResponse(preloadHtml(userId, publicationOverrides));
  }
  return null;
}

async function executeTextOnlyPostWithCreateResponse(
  createResponse: (
    request: CapturedRequest,
  ) => Response | Promise<Response>,
) {
  const calls: CapturedRequest[] = [];
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
          if (
            request.method === "POST"
            && request.url.pathname === "/api/v1/comment/feed"
          ) return createResponse(request);
          if (
            request.method === "GET"
            && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
          ) return jsonResponse(noteReadbackWithoutImage());
          throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
        }),
        sleep: () => Promise.resolve(),
      },
    },
  );
  return { calls, result };
}

async function executeImagePostWithCreateResponse(
  imagePath: string,
  createResponse: (
    request: CapturedRequest,
    imageUrl: string,
  ) => Response | Promise<Response>,
) {
  const imageBytes = pngFixture(959, 1022);
  const imageUrl =
    `https://substack-post-media.s3.amazonaws.com/public/images/${IMAGE_UUID}_959x1022.png`;
  const calls: CapturedRequest[] = [];
  const result = await executeSubstackWebOperation(
    recipe("posts.publish"),
    {
      body: NOTE_BODY,
      media: { kind: "file", reference: "fixture" },
    },
    boundAuth,
    {
      fileResolver: () => Promise.resolve([imagePath]),
      beforeDispatch: () => Promise.resolve(),
      dependencies: {
        ...dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request);
          if (bootstrap !== null) return bootstrap;
          if (request.method === "POST" && request.url.pathname === "/api/v1/image") {
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
          ) return jsonResponse(imageAttachment(imageUrl));
          if (
            request.method === "POST"
            && request.url.pathname === "/api/v1/comment/feed"
          ) return createResponse(request, imageUrl);
          if (
            request.method === "GET"
            && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
          ) return jsonResponse(noteReadback(imageUrl));
          throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
        }),
        sleep: () => Promise.resolve(),
      },
    },
  );
  return { calls, result };
}

describe("Substack authenticated internal API runtime", () => {
  test("strictly prepares capture-neutral video publication and personal-Note deletion", () => {
    expect(prepareSubstackVideoNotePublishInput({
      body: NOTE_BODY,
      media: { kind: "file", reference: "fixture" },
    })).toEqual({
      body: NOTE_BODY,
      media: { kind: "file", reference: "fixture" },
    });
    expect(prepareSubstackPersonalNoteDeleteInput({
      expected_body: NOTE_BODY,
      note_id: CREATED_NOTE_ID,
    })).toEqual({ expectedBody: NOTE_BODY, noteId: CREATED_NOTE_ID });
    expect(() => prepareSubstackVideoNotePublishInput({
      body: NOTE_BODY,
      media: { kind: "file", reference: "fixture" },
      audience: "public",
    })).toThrow("unsupported keys");
    expect(() => prepareSubstackPersonalNoteDeleteInput({
      expected_body: NOTE_BODY,
      note_id: 0,
    })).toThrow("input.note_id");
  });

  test("materializes one stable plan-bound MP4 with exact duration and dimensions", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-substack-video-"));
    chmodSync(root, 0o700);
    const videoPath = join(root, "fixture.mp4");
    const bytes = mp4Fixture();
    writeFileSync(videoPath, bytes, { mode: 0o600 });
    try {
      const video = await materializeSubstackVideo(
        { kind: "file", reference: "fixture" },
        () => Promise.resolve([videoPath]),
        undefined,
      );
      expect(video).toMatchObject({
        byteLength: bytes.byteLength,
        durationSeconds: 12.345,
        height: 360,
        mediaType: "video/mp4",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width: 640,
      });
      expect(video.bytes).toEqual(new Uint8Array(bytes));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("admits the 128 MiB sparse boundary and rejects the next byte before reading", async () => {
    const maximumBytes = 128 * 1024 * 1024;
    for (const [size, expectedRuns, expectedMessage] of [
      [maximumBytes, 4, "test blocked sparse-file read after admission"],
      [maximumBytes + 1, 3, "128 MiB in-memory publish limit"],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "wrench-substack-video-cap-test-"));
      const path = join(root, "sparse.mp4");
      writeFileSync(path, "", { mode: 0o600 });
      truncateSync(path, size);
      const controller = new AbortController();
      let runs = 0;
      const deadline: WebSessionOperationDeadline = {
        signal: controller.signal,
        remainingTimeMs: () => 60_000,
        run: async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
          runs += 1;
          if (runs === 4) {
            throw new Error("test blocked sparse-file read after admission");
          }
          return work(controller.signal);
        },
        throwIfUnavailable: () => {},
      };
      try {
        await expect(materializeSubstackVideo(
          { kind: "file", reference: "fixture" },
          () => Promise.resolve([path]),
          deadline,
        )).rejects.toThrow(expectedMessage);
        expect(runs).toBe(expectedRuns);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("pins bundle-derived initialization, multipart, transcode, and status request shapes", () => {
    const byteLength = SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES + 17;
    expect(planSubstackVideoMultipartParts(byteLength, 2)).toEqual([
      {
        byteLength: SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES,
        endExclusive: SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES,
        partNumber: 1,
        start: 0,
      },
      {
        byteLength: 17,
        endExclusive: byteLength,
        partNumber: 2,
        start: SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES,
      },
    ]);
    expect(substackVideoUploadInitializationRequest(byteLength)).toEqual({
      method: "POST",
      url: `https://substack.com/api/v1/video/upload?filetype=video%2Fmp4&fileSize=${byteLength}&fileName=wrench-video.mp4`,
    });
    const etags = parseSubstackVideoMultipartEtags([
      '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
    ], 2);
    expect(substackVideoTranscodeRequest(
      91,
      "multipart_91",
      12.345,
      byteLength,
      2,
      etags,
    )).toEqual({
      body: {
        duration: 12.345,
        multipart_upload_id: "multipart_91",
        multipart_upload_etags: etags,
      },
      method: "POST",
      url: "https://substack.com/api/v1/video/upload/91/transcode",
    });
    expect(substackVideoStatusRequest("upload_91")).toEqual({
      method: "GET",
      url: "https://substack.com/api/v1/video/upload/upload_91",
    });
    for (const state of ["created", "uploaded", "transcoded", "error", "cancelled"] as const) {
      expect(parseSubstackVideoUploadState(state)).toBe(state);
    }
    expect(classifySubstackVideoUploadState("created")).toEqual({
      state: "created",
      status: "pending",
    });
    expect(classifySubstackVideoUploadState("uploaded")).toEqual({
      state: "uploaded",
      status: "pending",
    });
    expect(classifySubstackVideoUploadState("transcoded")).toEqual({
      state: "transcoded",
      status: "complete",
    });
    expect(classifySubstackVideoUploadState("error")).toEqual({
      state: "error",
      status: "terminal-failure",
    });
    expect(planSubstackVideoMultipartParts(128 * 1024 * 1024, 3).at(-1))
      .toMatchObject({ endExclusive: 128 * 1024 * 1024, partNumber: 3 });
    expect(() => planSubstackVideoMultipartParts(128 * 1024 * 1024 + 1, 3))
      .toThrow("outside the reviewed bound");
  });

  test("checkpoints and snapshots exact immutable multipart bodies without target authority", async () => {
    const bytes = mp4Fixture();
    const video = substackVideoBinding(bytes);
    const parsed = parseSubstackVideoBinding(video);
    expect(parsed).toMatchObject({
      byteLength: bytes.byteLength,
      durationSeconds: 12.345,
      height: 360,
      mediaType: "video/mp4",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: 640,
    });
    expect(parsed.bytes).toEqual(video.bytes);
    expect(parsed.bytes).not.toBe(video.bytes);
    expect(substackVideoUploadInitializationRequestForBinding(video)).toEqual({
      method: "POST",
      url: `https://substack.com/api/v1/video/upload?filetype=video%2Fmp4&fileSize=${bytes.byteLength}&fileName=wrench-video.mp4`,
    });
    expect(substackVideoTranscodeRequestForBinding(
      "upload_91",
      "multipart_91",
      video,
      1,
      ['"etag-1"'],
    )).toEqual({
      body: {
        duration: 12.345,
        multipart_upload_id: "multipart_91",
        multipart_upload_etags: ['"etag-1"'],
      },
      method: "POST",
      url: "https://substack.com/api/v1/video/upload/upload_91/transcode",
    });
    const checkpoint = createSubstackVideoMultipartDispatchCheckpoint(video, 1);
    expect(checkpoint).toEqual({
      byteLength: bytes.byteLength,
      durationSeconds: 12.345,
      height: 360,
      mediaType: "video/mp4",
      partCount: 1,
      schemaVersion: 1,
      sha256: video.sha256,
      width: 640,
    });
    const snapshot = revalidateAndSnapshotSubstackVideoMultipartDispatch(
      video,
      checkpoint,
    );
    expect(snapshot.parts).toHaveLength(1);
    const transfer = snapshot.parts[0]!;
    expect(transfer).toMatchObject({
      byteLength: bytes.byteLength,
      credentials: "omit",
      endExclusive: bytes.byteLength,
      formData: false,
      method: "PUT",
      partNumber: 1,
      start: 0,
    });
    expect(transfer).not.toHaveProperty("url");
    expect(transfer).not.toHaveProperty("acceptedStatus");
    expect(transfer.body).toBeInstanceOf(Blob);
    expect(transfer.body.type).toBe("video/mp4");
    expect(new Uint8Array(await transfer.body.arrayBuffer())).toEqual(new Uint8Array(bytes));
    video.bytes[video.bytes.byteLength - 1] = 99;
    const snapshottedBytes = new Uint8Array(await transfer.body.arrayBuffer());
    expect(snapshottedBytes[snapshottedBytes.byteLength - 1]).toBe(4);
    expect(() => parseSubstackVideoBinding(video))
      .toThrow("byte integrity changed from its exact bytes");

    const changedVideo = substackVideoBinding(video.bytes);
    expect(changedVideo.durationSeconds).toBe(video.durationSeconds);
    expect(changedVideo.height).toBe(video.height);
    expect(changedVideo.width).toBe(video.width);
    expect(changedVideo.sha256).not.toBe(checkpoint.sha256);
    expect(() => revalidateAndSnapshotSubstackVideoMultipartDispatch(
      changedVideo,
      checkpoint,
    )).toThrow("changed after its multipart dispatch checkpoint");

    const rebound = substackVideoBinding(bytes);
    expect(() => revalidateAndSnapshotSubstackVideoMultipartDispatch(rebound, {
      ...checkpoint,
      uploadUrl: "https://example.test/",
    })).toThrow("reviewed contract");
    expect(() => revalidateAndSnapshotSubstackVideoMultipartDispatch(rebound, {
      ...checkpoint,
      partCount: 2,
    })).toThrow("does not exactly cover");
    expect(() => parseSubstackVideoBinding({ ...rebound, width: 641 }))
      .toThrow("metadata changed");
  });

  test("takes every multipart body from one byte version across source mutation", async () => {
    const bytes = mp4Fixture(SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES + 17);
    const video = substackVideoBinding(bytes);
    const checkpoint = createSubstackVideoMultipartDispatchCheckpoint(video, 2);
    const snapshot = revalidateAndSnapshotSubstackVideoMultipartDispatch(
      video,
      checkpoint,
    );
    expect(snapshot.parts.map(({ body: _body, ...part }) => part)).toEqual(
      planSubstackVideoMultipartParts(bytes.byteLength, 2).map((part) => ({
        ...part,
        credentials: "omit",
        formData: false,
        method: "PUT",
      })),
    );

    const digest = createHash("sha256");
    digest.update(new Uint8Array(await snapshot.parts[0]!.body.arrayBuffer()));
    const mutationOffset = SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES + 3;
    video.bytes[mutationOffset] = (video.bytes[mutationOffset]! ^ 0xff) & 0xff;
    digest.update(new Uint8Array(await snapshot.parts[1]!.body.arrayBuffer()));
    expect(digest.digest("hex")).toBe(checkpoint.sha256);

    const secondVersion = substackVideoBinding(video.bytes);
    expect(secondVersion.sha256).not.toBe(checkpoint.sha256);
    expect(() => revalidateAndSnapshotSubstackVideoMultipartDispatch(
      secondVersion,
      checkpoint,
    )).toThrow("changed after its multipart dispatch checkpoint");
  });

  test("rejects volatile or ambiguous Substack video bindings without invoking them", async () => {
    const video = substackVideoBinding(mp4Fixture());
    for (const [value, message] of [
      [{ ...video, extra: true }, "unsupported fields"],
      [{ ...video, [Symbol("extra")]: true }, "unsupported fields"],
      [Object.assign(Object.create({ inherited: true }), video), "plain prototype"],
    ] as const) {
      expect(() => parseSubstackVideoBinding(value)).toThrow(message);
    }

    let accessorReads = 0;
    const accessorBinding = Object.defineProperty({ ...video }, "sha256", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return video.sha256;
      },
    });
    expect(() => parseSubstackVideoBinding(accessorBinding))
      .toThrow("only enumerable data properties");
    expect(accessorReads).toBe(0);

    let trapCalls = 0;
    const trappedBinding = new Proxy(video, {
      get() {
        trapCalls += 1;
        throw new Error("proxy trap ran");
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error("proxy trap ran");
      },
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error("proxy trap ran");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("proxy trap ran");
      },
    });
    expect(() => parseSubstackVideoBinding(trappedBinding))
      .toThrow("must not be a proxy");
    expect(trapCalls).toBe(0);

    const proxiedBytes = new Proxy(video.bytes, {
      get(target, key, receiver) {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf(target) {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    expect(() => parseSubstackVideoBinding({ ...video, bytes: proxiedBytes }))
      .toThrow("one bounded MP4");
    expect(trapCalls).toBe(0);

    let nestedAccessorReads = 0;
    const decoratedBytes = new Uint8Array(video.bytes);
    Object.defineProperties(decoratedBytes, {
      buffer: {
        configurable: true,
        get() {
          nestedAccessorReads += 1;
          throw new Error("caller-defined buffer getter ran");
        },
      },
      byteLength: {
        configurable: true,
        get() {
          nestedAccessorReads += 1;
          return 24;
        },
      },
    });
    Object.defineProperty(decoratedBytes, Symbol.iterator, {
      configurable: true,
      get() {
        nestedAccessorReads += 1;
        throw new Error("caller-defined iterator getter ran");
      },
    });
    const parsed = parseSubstackVideoBinding({ ...video, bytes: decoratedBytes });
    expect(nestedAccessorReads).toBe(0);
    expect(parsed.bytes).toEqual(video.bytes);
  });

  test("rejects shared Substack bytes despite prototype and realm spoofing", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const video = substackVideoBinding(mp4Fixture());

    const disguisedBacking = new SharedArrayBuffer(video.byteLength);
    const disguisedBytes = new Uint8Array(disguisedBacking);
    disguisedBytes.set(video.bytes);
    Object.setPrototypeOf(disguisedBacking, ArrayBuffer.prototype);
    expect(disguisedBacking).not.toBeInstanceOf(SharedArrayBuffer);
    expect(() => parseSubstackVideoBinding({ ...video, bytes: disguisedBytes }))
      .toThrow("one bounded MP4");

    const crossRealmBytes = runInNewContext(
      `new Uint8Array(new SharedArrayBuffer(${video.byteLength}))`,
    ) as Uint8Array;
    Uint8Array.prototype.set.call(crossRealmBytes, video.bytes);
    Object.setPrototypeOf(crossRealmBytes, Uint8Array.prototype);
    expect(crossRealmBytes).toBeInstanceOf(Uint8Array);
    expect(crossRealmBytes.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    expect(() => parseSubstackVideoBinding({ ...video, bytes: crossRealmBytes }))
      .toThrow("one bounded MP4");
  });

  test("round-trips only canonical read-only video upload recovery targets", () => {
    const identifier = substackVideoUploadRecoveryTargetIdentifier("upload_91");
    expect(identifier).toBe('{"mediaUploadId":"upload_91","schemaVersion":1}');
    expect(parseSubstackVideoUploadRecoveryTargetIdentifier(identifier)).toEqual({
      mediaUploadId: "upload_91",
      schemaVersion: 1,
    });
    expect(substackVideoUploadRecoveryStatusRequest(identifier)).toEqual({
      method: "GET",
      url: "https://substack.com/api/v1/video/upload/upload_91",
    });
    expect(() => parseSubstackVideoUploadRecoveryTargetIdentifier(
      JSON.stringify({ schemaVersion: 1, mediaUploadId: "upload_91" }),
    )).toThrow("canonical JSON");
    expect(() => parseSubstackVideoUploadRecoveryTargetIdentifier(canonicalJson({
      mediaUploadId: "upload_91",
      schemaVersion: 1,
      uploadUrl: "https://example.test/",
    }))).toThrow("reviewed contract");
  });

  test("rejects incomplete multipart evidence and unreviewed lifecycle values", () => {
    expect(() => planSubstackVideoMultipartParts(
      SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES + 1,
      1,
    )).toThrow("does not exactly cover");
    expect(() => parseSubstackVideoMultipartEtags(['W/"weak"'], 1))
      .toThrow("strong entity-tag");
    expect(() => parseSubstackVideoMultipartEtags(['"one"'], 2))
      .toThrow("did not bind every ordered part");
    expect(() => parseSubstackVideoMultipartEtags(new Array(1), 1))
      .toThrow("exact data-only array");

    let accessorReads = 0;
    const accessorEtags = Object.defineProperty(new Array(1), "0", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return '"one"';
      },
    });
    expect(() => parseSubstackVideoMultipartEtags(accessorEtags, 1))
      .toThrow("exact data-only array");
    expect(accessorReads).toBe(0);

    let trapCalls = 0;
    const trappedEtags = new Proxy(['"one"'], {
      get() {
        trapCalls += 1;
        throw new Error("proxy trap ran");
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error("proxy trap ran");
      },
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error("proxy trap ran");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("proxy trap ran");
      },
    });
    expect(() => parseSubstackVideoMultipartEtags(trappedEtags, 1))
      .toThrow("exact data-only array");
    expect(trapCalls).toBe(0);

    const symbolicEtags = ['"one"'] as (string[] & { [key: symbol]: boolean });
    symbolicEtags[Symbol("extra")] = true;
    expect(() => parseSubstackVideoMultipartEtags(symbolicEtags, 1))
      .toThrow("exact data-only array");
    expect(() => substackVideoTranscodeRequest(
      91,
      "multipart_91",
      12.345,
      SUBSTACK_VIDEO_MULTIPART_CHUNK_BYTES + 1,
      1,
      ['"one"'],
    )).toThrow("does not exactly cover");
    expect(() => parseSubstackVideoUploadState("processing"))
      .toThrow("unreviewed state");
    expect(() => substackVideoStatusRequest("../other"))
      .toThrow("response-bound identifier");
  });

  test("binds a future deletion pre-read to one exact authored personal Note", () => {
    const target = assertSubstackNoteDeletionPreRead(
      noteReadbackWithoutImage(),
      CREATED_NOTE_ID,
      USER_ID,
      NOTE_BODY,
    );
    expect(target).toEqual({
      noteId: CREATED_NOTE_ID,
      publicationId: null,
      schemaVersion: 1,
    });
    const identifier = substackNoteDeletionRecoveryTargetIdentifier(target);
    expect(parseSubstackNoteDeletionRecoveryTargetIdentifier(identifier)).toEqual(target);
    expect(substackNoteDeletionRecoveryReadRequest(identifier)).toEqual({
      method: "GET",
      url: `https://substack.com/api/v1/reader/comment/${CREATED_NOTE_ID}`,
    });
    expect(substackPersonalNoteDeleteRequest(CREATED_NOTE_ID)).toEqual({
      method: "DELETE",
      url: `https://substack.com/api/v1/comment/${CREATED_NOTE_ID}`,
    });
    expect(() => substackPersonalNoteDeleteRequest(0)).toThrow("positive safe integer");
    expect(() => assertSubstackNoteDeletionPreRead(
      noteReadbackWithoutImage(),
      CREATED_NOTE_ID,
      USER_ID + 1,
      NOTE_BODY,
    )).toThrow("did not bind the exact authored Note");
    expect(() => assertSubstackNoteDeletionPreRead(
      noteReadbackWithoutImage("changed"),
      CREATED_NOTE_ID,
      USER_ID,
      NOTE_BODY,
    )).toThrow("did not bind the exact authored Note");
    expect(() => parseSubstackNoteDeletionRecoveryTargetIdentifier(JSON.stringify({
      schemaVersion: 1,
      publicationId: null,
      noteId: CREATED_NOTE_ID,
    }))).toThrow("canonical JSON");
    expect(() => substackNoteDeletionRecoveryTargetIdentifier({
      ...target,
      publicationId: PUBLICATION_ID,
    })).toThrow("changed shape");
  });

  test("deletes one exact authored personal Note and verifies independent 404 absence", async () => {
    const calls: CapturedRequest[] = [];
    const events: string[] = [];
    let deleted = false;
    let acceptedIdentifier = "";
    const result = await executeSubstackWebOperation(
      recipe("content.delete"),
      { expected_body: NOTE_BODY, note_id: CREATED_NOTE_ID },
      boundAuth,
      {
        beforeDispatch: (event) => {
          events.push(`${event.id}:${event.progress.started}:${event.progress.verified}`);
          return Promise.resolve();
        },
        afterProviderAcceptedMutationTarget: (event) => {
          acceptedIdentifier = event.target.identifier;
          events.push(`${event.id}:accepted`);
          return Promise.resolve();
        },
        afterDispatchVerified: (event) => {
          events.push(`${event.id}:${event.progress.started}:${event.progress.verified}`);
          return Promise.resolve();
        },
        dependencies: {
          ...dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            if (
              request.method === "GET"
              && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
            ) {
              return deleted
                ? jsonResponse({ error: "not found" }, 404)
                : jsonResponse(noteReadbackWithoutImage());
            }
            if (
              request.method === "DELETE"
              && request.url.pathname === `/api/v1/comment/${CREATED_NOTE_ID}`
            ) {
              expect(request.body).toBeNull();
              expect(request.headers.get("content-type")).toBe("application/json");
              expect(request.headers.get("cookie")).toBe("substack.sid=private-cookie-value");
              expect(request.redirect).toBe("error");
              deleted = true;
              return jsonResponse({});
            }
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
          sleep: () => Promise.resolve(),
        },
      },
    );

    expect(result).toEqual({
      status: "succeeded",
      output: { deleted: true, noOp: false, noteId: CREATED_NOTE_ID },
      finalUrl: `https://substack.com/@wrench-reader/note/c-${CREATED_NOTE_ID}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(events).toEqual([
      "content.delete:0:0",
      "content.delete:accepted",
      "content.delete:1:1",
    ]);
    expect(parseSubstackNoteDeletionRecoveryTargetIdentifier(acceptedIdentifier)).toEqual({
      noteId: CREATED_NOTE_ID,
      publicationId: null,
      schemaVersion: 1,
    });
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({
      method: "GET",
      url: expect.objectContaining({
        pathname: `/api/v1/reader/comment/${CREATED_NOTE_ID}`,
      }),
    });
  });

  test("treats an already absent personal Note as a network-inert no-op", async () => {
    const calls: CapturedRequest[] = [];
    let hooks = 0;
    const result = await executeSubstackWebOperation(
      recipe("content.delete"),
      { expected_body: NOTE_BODY, note_id: CREATED_NOTE_ID },
      boundAuth,
      {
        beforeDispatch: () => {
          hooks += 1;
          return Promise.resolve();
        },
        dependencies: dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request);
          if (bootstrap !== null) return bootstrap;
          if (
            request.method === "GET"
            && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
          ) return jsonResponse({ error: "not found" }, 404);
          throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
        }),
      },
    );
    expect(result).toMatchObject({
      status: "succeeded",
      output: { deleted: true, noOp: true, noteId: CREATED_NOTE_ID },
      noOp: true,
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
    });
    expect(hooks).toBe(0);
    expect(calls.some((call) => call.method === "DELETE")).toBeFalse();
  });

  test("rejects deletion target drift before dispatch", async () => {
    const calls: CapturedRequest[] = [];
    let hooks = 0;
    await expect(executeSubstackWebOperation(
      recipe("content.delete"),
      { expected_body: NOTE_BODY, note_id: CREATED_NOTE_ID },
      boundAuth,
      {
        beforeDispatch: () => {
          hooks += 1;
          return Promise.resolve();
        },
        dependencies: dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request);
          if (bootstrap !== null) return bootstrap;
          if (
            request.method === "GET"
            && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
          ) return jsonResponse(noteReadbackWithoutImage("changed"));
          throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
        }),
      },
    )).rejects.toThrow("did not bind the exact authored Note");
    expect(hooks).toBe(0);
    expect(calls.some((call) => call.method === "DELETE")).toBeFalse();
  });

  test("never retries an accepted deletion whose exact Note remains present", async () => {
    const calls: CapturedRequest[] = [];
    let sleeps = 0;
    const result = await executeSubstackWebOperation(
      recipe("content.delete"),
      { expected_body: NOTE_BODY, note_id: CREATED_NOTE_ID },
      boundAuth,
      {
        beforeDispatch: () => Promise.resolve(),
        afterProviderAcceptedMutationTarget: () => Promise.resolve(),
        dependencies: {
          ...dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            if (
              request.method === "GET"
              && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
            ) return jsonResponse(noteReadbackWithoutImage());
            if (
              request.method === "DELETE"
              && request.url.pathname === `/api/v1/comment/${CREATED_NOTE_ID}`
            ) return jsonResponse({});
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
          sleep: () => {
            sleeps += 1;
            return Promise.resolve();
          },
        },
      },
    );
    expect(result).toMatchObject({
      status: "indeterminate",
      dispatchStarted: true,
      dispatch: { planned: 1, started: 1, verified: 0 },
      error: expect.stringContaining("reconcile before retrying"),
    });
    expect(sleeps).toBe(3);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  test("rejects unreviewed deletion responses without accepting or retrying", async () => {
    for (const variant of ["status", "redirect"] as const) {
      const calls: CapturedRequest[] = [];
      let accepted = 0;
      const result = await executeSubstackWebOperation(
        recipe("content.delete"),
        { expected_body: NOTE_BODY, note_id: CREATED_NOTE_ID },
        boundAuth,
        {
          beforeDispatch: () => Promise.resolve(),
          afterProviderAcceptedMutationTarget: () => {
            accepted += 1;
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            if (
              request.method === "GET"
              && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
            ) return jsonResponse(noteReadbackWithoutImage());
            if (
              request.method === "DELETE"
              && request.url.pathname === `/api/v1/comment/${CREATED_NOTE_ID}`
            ) {
              const response = jsonResponse(
                variant === "status" ? { error: "forbidden" } : {},
                variant === "status" ? 403 : 200,
              );
              if (variant === "redirect") response.headers.set("location", "/unexpected");
              return response;
            }
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
        error: expect.stringContaining("stage: delete-transport"),
      });
      expect(accepted).toBe(0);
      expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    }
  });

  test("reconciles exact present and absent personal-Note deletion state without dispatch", async () => {
    for (const [status, expected] of [[200, true], [404, false]] as const) {
      const calls: CapturedRequest[] = [];
      const readback = await readSubstackWebContentDeleteDesiredState(
        recipe("content.delete"),
        { expected_body: NOTE_BODY, note_id: CREATED_NOTE_ID },
        boundAuth,
        {
          dependencies: dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            if (
              request.method === "GET"
              && request.url.pathname === `/api/v1/reader/comment/${CREATED_NOTE_ID}`
            ) {
              return status === 404
                ? jsonResponse({ error: "not found" }, 404)
                : jsonResponse(noteReadbackWithoutImage());
            }
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
        },
      );
      expect(readback).toEqual({ present: expected, noteId: CREATED_NOTE_ID });
      expect(calls.some((call) => call.method !== "GET")).toBeFalse();
    }
  });

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
        verify: (output) => expect(output).toMatchObject({
          articleId: ARTICLE_ID,
          audioItems: [{
            id: "tts-audio",
            url: "https://substackcdn.com/tts-audio.mp3",
            duration: 60,
          }],
          inlineAudioEmbeds: [{
            uploadId: AUDIO_UPLOAD_ID,
            url: `https://wrench-owned.substack.com/api/v1/audio/upload/${AUDIO_UPLOAD_ID}/src`,
          }],
        }),
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
      {
        action: "profiles.read",
        input: { profile: "wrench-reader" },
        expectedSemanticPaths: ["/api/v1/user/wrench-reader/public_profile"],
        verify: (output) => expect(output).toMatchObject({
          schemaVersion: 1,
          provider: "substack",
          target: {
            kind: "profile",
            id: String(USER_ID),
            url: "https://substack.com/@wrench-reader",
          },
          completeness: "complete",
          metrics: {
            followers: { status: "available", value: 178, precision: "exact", unit: "count" },
          },
        }),
      },
      {
        action: "organizations.read",
        input: { organization: "wrench-owned" },
        expectedSemanticPaths: ["/api/v1/publish-dashboard/summary"],
        verify: (output) => expect(output).toMatchObject({
          schemaVersion: 1,
          provider: "substack",
          target: {
            kind: "publication",
            id: String(PUBLICATION_ID),
            url: "https://wrench-owned.substack.com/",
          },
          completeness: "complete",
          metrics: {
            freeSubscribers: { status: "available", value: 121, precision: "exact", unit: "count" },
            paidSubscribers: { status: "available", value: 5, precision: "exact", unit: "count" },
          },
        }),
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
              case "/api/v1/user/wrench-reader/public_profile":
                return jsonResponse({
                  id: USER_ID,
                  handle: "wrench-reader",
                  name: "Wrench Reader",
                  subscriberCount: 125,
                  followerCount: 178,
                });
              case "/api/v1/publish-dashboard/summary":
                expect(request.url.origin).toBe("https://wrench-owned.substack.com");
                expect(request.headers.get("referer")).toBe(
                  "https://wrench-owned.substack.com/publish/home",
                );
                return jsonResponse({
                  totalEmail: 126,
                  subscribers: 5,
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

  test("binds the exact publication listed in the signed-in viewer dashboard", async () => {
    const calls: CapturedRequest[] = [];
    const result = await executeSubstackWebOperation(
      recipe("organizations.read"),
      { organization: "wrench-owned" },
      boundAuth,
      {
        dependencies: dependencies(calls, (request) => {
          const bootstrap = bootstrapResponse(request, USER_ID, {
            primary_user_id: null,
            can_post_notes_as_primary_user: false,
            is_publication_primary_user: false,
          });
          if (bootstrap !== null) return bootstrap;
          if (request.url.pathname === "/api/v1/publish-dashboard/summary") {
            return jsonResponse({ totalEmail: 126, subscribers: 5 });
          }
          throw new Error(`unexpected ${request.url.pathname}`);
        }),
      },
    );
    expect(result.output).toMatchObject({
      completeness: "complete",
      metrics: {
        freeSubscribers: { status: "available", value: 121 },
        paidSubscribers: { status: "available", value: 5 },
      },
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/v1/am_i_logged_in",
      "/",
      "/api/v1/publish-dashboard/summary",
    ]);
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
              return jsonResponse({
                ...createdNote(imageUrl) as object,
                attachments: [],
              });
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
        "POST /api/v1/image",
        "POST /api/v1/comment/attachment",
        "before 0",
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

  test("classifies Note-create transport responses without exposing provider diagnostics", async () => {
    const scenarios: readonly {
      readonly stage: string;
      readonly respond: () => Response | Promise<Response>;
    }[] = [
      {
        stage: "note-create-transport",
        respond: () => Promise.reject(new Error("private transport diagnostic")),
      },
      {
        stage: "note-create-http-status",
        respond: () => new Response("private status diagnostic", {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      },
      {
        stage: "note-create-content-type",
        respond: () => new Response("private content-type diagnostic", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      },
      {
        stage: "note-create-json",
        respond: () => new Response('{"private":', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      },
      {
        stage: "note-create-response-bounds",
        respond: () => new Response("", {
          status: 200,
          headers: {
            "content-length": String(9 * 1024 * 1024),
            "content-type": "application/json",
          },
        }),
      },
    ];

    for (const scenario of scenarios) {
      const { calls, result } = await executeTextOnlyPostWithCreateResponse(
        () => scenario.respond(),
      );
      expect(result).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
        error: expect.stringContaining(`stage: ${scenario.stage}`),
      });
      expect(String(result.error)).not.toContain("private");
      expect(calls.filter(
        (call) => call.url.pathname === "/api/v1/comment/feed",
      )).toHaveLength(1);
      expect(calls.filter(
        (call) => call.url.pathname.startsWith("/api/v1/reader/comment/"),
      )).toHaveLength(0);
    }
  });

  test("classifies every exact Note-create response binding guard", async () => {
    const imageUrl =
      `https://substack-post-media.s3.amazonaws.com/public/images/${IMAGE_UUID}_959x1022.png`;
    const scenarios: readonly {
      readonly stage: string;
      readonly response: () => unknown;
    }[] = [
      {
        stage: "note-create-response-object",
        response: () => null,
      },
      {
        stage: "note-create-response-fields",
        response: () => ({ ...createdTextNote(), private_provider_field: "private" }),
      },
      {
        stage: "note-create-actor",
        response: () => ({ ...createdTextNote(), user_id: USER_ID + 1 }),
      },
      {
        stage: "note-create-body",
        response: () => ({ ...createdTextNote(), body: "private mismatched body" }),
      },
      {
        stage: "note-create-kind",
        response: () => ({ ...createdTextNote(), type: "reply" }),
      },
      {
        stage: "note-create-deleted-state",
        response: () => ({ ...createdTextNote(), deleted: true }),
      },
      {
        stage: "note-create-parent-post",
        response: () => ({ ...createdTextNote(), post_id: ARTICLE_ID }),
      },
      {
        stage: "note-create-publication",
        response: () => ({ ...createdTextNote(), publication_id: PUBLICATION_ID }),
      },
      {
        stage: "note-create-reply-role",
        response: () => ({ ...createdTextNote(), reply_minimum_role: "paid" }),
      },
      {
        stage: "note-create-body-json",
        response: () => ({ ...createdTextNote(), body_json: null }),
      },
      {
        stage: "note-create-publication-status",
        response: () => ({ ...createdTextNote(), status: "scheduled" }),
      },
      {
        stage: "note-create-attachments-shape",
        response: () => ({ ...createdTextNote(), attachments: {} }),
      },
      {
        stage: "note-create-attachments-count",
        response: () => ({
          ...createdTextNote(),
          attachments: [imageAttachment(imageUrl)],
        }),
      },
      {
        stage: "note-create-id",
        response: () => ({ ...createdTextNote(), id: 0 }),
      },
    ];

    for (const scenario of scenarios) {
      const { calls, result } = await executeTextOnlyPostWithCreateResponse(
        () => jsonResponse(scenario.response()),
      );
      expect(result).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
        error: expect.stringContaining(`stage: ${scenario.stage}`),
      });
      expect(String(result.error)).not.toContain("private");
      expect(calls.filter(
        (call) => call.url.pathname.startsWith("/api/v1/reader/comment/"),
      )).toHaveLength(0);
    }
  });

  test("classifies every exact Note-create attachment binding guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-substack-create-binding-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    writeFileSync(imagePath, pngFixture(959, 1022), { mode: 0o600 });
    try {
      const scenarios: readonly {
        readonly stage: string;
        readonly attachment: (imageUrl: string) => unknown;
      }[] = [
        {
          stage: "note-create-attachment-object",
          attachment: () => null,
        },
        {
          stage: "note-create-attachment-fields",
          attachment: (imageUrl) => ({
            ...imageAttachment(imageUrl) as Record<string, unknown>,
            private_provider_field: "private",
          }),
        },
        {
          stage: "note-create-attachment-id",
          attachment: (imageUrl) => ({
            ...imageAttachment(imageUrl) as Record<string, unknown>,
            id: "33333333-3333-4333-8333-333333333333",
          }),
        },
        {
          stage: "note-create-attachment-url",
          attachment: (imageUrl) => ({
            ...imageAttachment(imageUrl) as Record<string, unknown>,
            imageUrl: imageUrl.replace(IMAGE_UUID, "44444444-4444-4444-8444-444444444444"),
          }),
        },
        {
          stage: "note-create-attachment-kind",
          attachment: (imageUrl) => ({
            ...imageAttachment(imageUrl) as Record<string, unknown>,
            type: "video",
          }),
        },
      ];

      for (const scenario of scenarios) {
        const { calls, result } = await executeImagePostWithCreateResponse(
          imagePath,
          (_request, imageUrl) => jsonResponse({
            ...createdNote(imageUrl) as Record<string, unknown>,
            attachments: [scenario.attachment(imageUrl)],
          }),
        );
        expect(result).toMatchObject({
          status: "indeterminate",
          dispatchStarted: true,
          dispatch: { planned: 1, started: 1, verified: 0 },
          error: expect.stringContaining(`stage: ${scenario.stage}`),
        });
        expect(String(result.error)).not.toContain("private");
        expect(calls.filter(
          (call) => call.url.pathname.startsWith("/api/v1/reader/comment/"),
        )).toHaveLength(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("settles a Substack image-upload preparation failure before dispatch and never creates a Note", async () => {
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
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
        error: expect.stringContaining("stage: image-upload"),
      });
      expect(String(result.error)).not.toContain("upload failed");
      expect(beforeDispatch).toBe(0);
      expect(creates).toBe(0);
      expect(calls.filter((call) => call.url.pathname === "/api/v1/image")).toHaveLength(1);
      expect(calls.filter((call) => call.url.pathname === "/api/v1/comment/attachment")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("settles a Substack attachment preparation failure before dispatch and never creates a Note", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-substack-attachment-failure-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    const imageBytes = pngFixture(959, 1022);
    writeFileSync(imagePath, imageBytes, { mode: 0o600 });
    const imageUrl =
      `https://substack-post-media.s3.amazonaws.com/public/images/${IMAGE_UUID}_959x1022.png`;
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
              return new Response(JSON.stringify({ error: "private attachment failure" }), {
                status: 502,
                headers: { "content-type": "application/json" },
              });
            }
            if (request.url.pathname === "/api/v1/comment/feed") creates += 1;
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
        error: expect.stringContaining("stage: image-upload"),
      });
      expect(String(result.error)).not.toContain("private");
      expect(beforeDispatch).toBe(0);
      expect(creates).toBe(0);
      expect(calls.filter((call) => call.url.pathname === "/api/v1/image"))
        .toHaveLength(1);
      expect(calls.filter(
        (call) => call.url.pathname === "/api/v1/comment/attachment",
      )).toHaveLength(1);
      expect(calls.filter(
        (call) => call.url.pathname === "/api/v1/comment/feed",
      )).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("places the durable dispatch fence immediately after image preparation and before Note create", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-substack-dispatch-fence-"));
    chmodSync(root, 0o700);
    const imagePath = join(root, "fixture.png");
    const imageBytes = pngFixture(959, 1022);
    writeFileSync(imagePath, imageBytes, { mode: 0o600 });
    const imageUrl =
      `https://substack-post-media.s3.amazonaws.com/public/images/${IMAGE_UUID}_959x1022.png`;
    const calls: CapturedRequest[] = [];
    const events: string[] = [];
    let creates = 0;
    let acceptedTargets = 0;
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
            expect(event).toEqual({
              id: "posts.publish",
              index: 1,
              progress: { planned: 1, started: 0, verified: 0 },
            });
            events.push("before-dispatch");
            return Promise.reject(new Error("private dispatch-admission failure"));
          },
          afterProviderAcceptedMutationTarget: () => {
            acceptedTargets += 1;
            return Promise.resolve();
          },
          dependencies: dependencies(calls, (request) => {
            const bootstrap = bootstrapResponse(request);
            if (bootstrap !== null) return bootstrap;
            events.push(`${request.method} ${request.url.pathname}`);
            if (request.method === "POST" && request.url.pathname === "/api/v1/image") {
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
            ) return jsonResponse(imageAttachment(imageUrl));
            if (request.url.pathname === "/api/v1/comment/feed") creates += 1;
            throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
          }),
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
        error: expect.stringContaining("stage: dispatch-admission"),
      });
      expect(String(result.error)).not.toContain("private");
      expect(events).toEqual([
        "POST /api/v1/image",
        "POST /api/v1/comment/attachment",
        "before-dispatch",
      ]);
      expect(creates).toBe(0);
      expect(acceptedTargets).toBe(0);
      expect(calls.filter(
        (call) => call.url.pathname === "/api/v1/comment/feed",
      )).toHaveLength(0);
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
      "media.publish",
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
