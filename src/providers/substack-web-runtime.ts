import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { WrenchAuth } from "../auth";
import type { BrowserFileResolver } from "../browser";
import { canonicalJson } from "../canonical-json";
import type { FileInputValue, OperationInput, WebSessionRecipe } from "../model";
import {
  createWebSessionClient,
  webSessionAuthSubject,
  type WebSessionClient,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
  WebSessionProviderAcceptedMutationTargetEvent,
} from "../web-session-execution";
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
  type SubstackFeedName,
  type SubstackWebOperationName,
  type SubstackWebViewer,
} from "./substack-web";

const SUBSTACK_ORIGIN = "https://substack.com";
const MAX_BOOTSTRAP_BYTES = 8 * 1024 * 1024;
const MAX_LOGIN_BYTES = 256 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_SUBSTACK_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_LIMIT = 20;
const SUBSTACK_NOTE_READBACK_DELAYS_MS = Object.freeze([500, 1_500, 4_000]);

type SubstackWebSleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export type SubstackWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly sleep?: SubstackWebSleep;
};

function sleepForSubstackReadback(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Substack Note readback wait was cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Substack Note readback wait was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isSubstackOperation(value: string): value is SubstackWebOperationName {
  return (SUBSTACK_WEB_OPERATION_NAMES as readonly string[]).includes(value);
}

function integerInput(
  input: OperationInput,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[name] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`input.${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function positiveIdInput(input: OperationInput, name: string): number {
  return integerInput(input, name, Number.NaN, 1, Number.MAX_SAFE_INTEGER);
}

function optionalStringInput(
  input: OperationInput,
  name: string,
  maximum: number,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`input.${name} must be bounded text`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} keys did not match the reviewed contract`);
  }
}

function requireAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) {
    throw new Error(`${label} contained fields outside the reviewed contract`);
  }
}

function requireExactInputKeys(input: OperationInput, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(input).filter((key) => !permitted.has(key));
  if (unexpected.length > 0) {
    throw new Error(`input contains unsupported keys: ${unexpected.join(", ")}`);
  }
}

function fileInput(value: OperationInput[string]): FileInputValue {
  if (
    !isRecord(value)
    || value.kind !== "file"
    || typeof value.reference !== "string"
    || Object.keys(value).sort().join(",") !== "kind,reference"
  ) throw new Error("input.media must be one plan-bound file");
  return Object.freeze({ kind: "file", reference: value.reference });
}

type SubstackImage = {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly mediaType: "image/png";
  readonly width: number;
};

async function materializeSubstackImage(
  media: FileInputValue,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
): Promise<SubstackImage> {
  if (fileResolver === undefined) {
    throw new Error("Substack image upload requires the plan-bound file resolver");
  }
  const paths = operationDeadline === undefined
    ? await fileResolver([media])
    : await operationDeadline.run(
        () => fileResolver([media]),
        "authenticated web operation deadline",
      );
  operationDeadline?.throwIfUnavailable("authenticated web operation deadline");
  if (paths.length !== 1 || typeof paths[0] !== "string") {
    throw new Error("Substack file resolver did not return one exact path");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = operationDeadline === undefined
    ? await open(paths[0], constants.O_RDONLY | noFollow)
    : await operationDeadline.run(
        () => open(paths[0]!, constants.O_RDONLY | noFollow),
        "authenticated web operation deadline",
      );
  try {
    const before = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (!before.isFile() || before.size < 24 || before.size > MAX_SUBSTACK_IMAGE_BYTES) {
      throw new Error("Substack image must be a regular PNG no larger than 20 MiB");
    }
    const bytes = operationDeadline === undefined
      ? await handle.readFile()
      : await operationDeadline.run(
          () => handle.readFile(),
          "authenticated web operation deadline",
        );
    const after = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size
    ) throw new Error("Substack image changed while it was materialized");
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      signature.some((value, index) => bytes[index] !== value)
      || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    ) throw new Error("Substack image must be a PNG fixture");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 20_000 || height > 20_000) {
      throw new Error("Substack PNG dimensions are outside the reviewed bound");
    }
    return Object.freeze({
      bytes: new Uint8Array(bytes),
      height,
      mediaType: "image/png",
      width,
    });
  } finally {
    await handle.close();
  }
}

function jsonHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    referer: `${SUBSTACK_ORIGIN}/`,
  });
}

function jsonPostHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    "content-type": "application/json",
    referer: `${SUBSTACK_ORIGIN}/`,
  });
}

function htmlHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "text/html",
    referer: `${SUBSTACK_ORIGIN}/`,
  });
}

async function currentViewer(
  client: WebSessionClient,
  maximumBytes = MAX_BOOTSTRAP_BYTES,
): Promise<SubstackWebViewer> {
  const loggedInUrl = new URL("/api/v1/am_i_logged_in", SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: "viewer.logged-in",
    url: loggedInUrl,
    method: "GET",
  });
  parseSubstackLoggedInResponse(await client.requestJson({
    url: loggedInUrl,
    method: "GET",
    headers: jsonHeaders(),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: Math.min(maximumBytes, MAX_LOGIN_BYTES),
  }));

  const rootUrl = new URL("/", SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: "viewer.root",
    url: rootUrl,
    method: "GET",
  });
  const html = await client.requestText({
    url: rootUrl,
    headers: htmlHeaders(),
    expectedContentTypes: ["text/html"],
    maxBytes: Math.min(maximumBytes, MAX_BOOTSTRAP_BYTES),
  });
  return parseSubstackPreloadsHtml(html);
}

function viewerSubject(viewer: SubstackWebViewer): string {
  return `substack:${viewer.id}`;
}

export async function probeSubstackWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: SubstackWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createWebSessionClient(SUBSTACK_ORIGIN, auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return viewerSubject(await currentViewer(client));
}

async function requireBoundViewer(
  client: WebSessionClient,
  auth: WrenchAuth,
  maximumBytes: number,
): Promise<SubstackWebViewer> {
  const expected = webSessionAuthSubject(auth);
  if (expected === null || !/^substack:[0-9]{1,32}$/u.test(expected)) {
    throw new Error(
      "Substack authenticated operations require an auth locator bound to an exact substack:<user-id> subject",
    );
  }
  const viewer = await currentViewer(client, maximumBytes);
  if (viewerSubject(viewer) !== expected) {
    throw new Error("Substack browser session viewer no longer matches the confirmed auth subject");
  }
  return viewer;
}

function boundedMaximum(recipe: WebSessionRecipe): number {
  return Math.min(recipe.maxOutputBytes, MAX_READ_BYTES);
}

function feedName(input: OperationInput): SubstackFeedName {
  const value = input.feed;
  if (value !== "notes" && value !== "inbox" && value !== "reader-posts") {
    throw new Error("input.feed must name notes, inbox, or reader-posts");
  }
  return value;
}

async function readFeed(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  const feed = feedName(input);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const request = {
    notes: {
      operation: "feeds.reader" as const,
      path: "/api/v1/reader/feed",
    },
    inbox: {
      operation: "feeds.inbox" as const,
      path: "/api/v1/inbox/top",
    },
    "reader-posts": {
      operation: "feeds.posts" as const,
      path: "/api/v1/reader/posts",
    },
  }[feed];
  const url = new URL(request.path, SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: request.operation,
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeSubstackFeedResponse(response, feed, limit);
}

async function readNote(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  const noteId = positiveIdInput(input, "note_id");
  const url = new URL(`/api/v1/reader/comment/${noteId}`, SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: "posts.note",
    url,
    method: "GET",
    targetId: noteId,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeSubstackNoteResponse(response, noteId);
}

async function articleResponse(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  articleId: number,
  operation: "articles.read" | "media.read",
): Promise<unknown> {
  const url = new URL(`/api/v1/posts/by-id/${articleId}`, SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation,
    url,
    method: "GET",
    targetId: articleId,
  });
  return client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
}

async function readArticle(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  media: boolean,
): Promise<unknown> {
  const articleId = positiveIdInput(input, "article_id");
  const response = await articleResponse(
    client,
    recipe,
    articleId,
    media ? "media.read" : "articles.read",
  );
  return media
    ? normalizeSubstackMediaResponse(response, articleId)
    : normalizeSubstackArticleResponse(response, articleId);
}

async function readComments(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  const articleId = positiveIdInput(input, "article_id");
  const publicationId = positiveIdInput(input, "publication_id");
  const limit = integerInput(input, "limit", 50, 1, 100);

  // Bind the caller-supplied publication before requesting its reply tree.
  const article = normalizeSubstackArticleResponse(
    await articleResponse(client, recipe, articleId, "articles.read"),
    articleId,
  ) as {
    readonly post: { readonly publicationId: number };
  };
  if (article.post.publicationId !== publicationId) {
    throw new Error("input.publication_id did not match the requested Substack article");
  }

  const url = new URL(`/api/v1/reader/post/${articleId}/replies`, SUBSTACK_ORIGIN);
  url.searchParams.set("publication_id", String(publicationId));
  const cursor = optionalStringInput(input, "cursor", 4_096);
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  authorizeSubstackWebReadRequest({
    operation: "comments.read",
    url,
    method: "GET",
    targetId: articleId,
    publicationId,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeSubstackCommentsResponse(response, articleId, limit);
}

type MessageFolder = "all" | "people" | "unread";

function messageFolder(input: OperationInput): MessageFolder {
  const value = input.folder;
  if (value !== "all" && value !== "people" && value !== "unread") {
    throw new Error("input.folder must name all, people, or unread");
  }
  return value;
}

async function listMessages(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  const folder = messageFolder(input);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const url = new URL("/api/v1/messages/inbox", SUBSTACK_ORIGIN);
  url.searchParams.set("tab", folder);
  const cursor = optionalStringInput(input, "cursor", 4_096);
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  authorizeSubstackWebReadRequest({
    operation: "messages.list",
    url,
    method: "GET",
    folder,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeSubstackMessageInbox(response, folder, limit);
}

type UploadedSubstackImage = {
  readonly id: number;
  readonly url: string;
};

type SubstackImageAttachment = {
  readonly id: string;
  readonly url: string;
};

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function exactSubstackImageUrl(
  value: unknown,
  width: number,
  height: number,
  label: string,
): string {
  if (typeof value !== "string" || value.length > 8_192) {
    throw new Error(`${label} must be a bounded URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const path = new RegExp(`^/public/images/${uuid}_${width}x${height}\\.png$`, "iu");
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "substack-post-media.s3.amazonaws.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !path.test(parsed.pathname)
  ) throw new Error(`${label} did not match the reviewed Substack image asset URL`);
  return parsed.href;
}

function parseUploadedSubstackImage(
  value: unknown,
  image: SubstackImage,
): UploadedSubstackImage {
  if (!isRecord(value)) throw new Error("Substack image upload response must be an object");
  requireExactKeys(value, [
    "bytes",
    "contentType",
    "id",
    "imageHeight",
    "imageWidth",
    "url",
  ], "Substack image upload response");
  if (
    value.bytes !== image.bytes.byteLength
    || value.contentType !== image.mediaType
    || value.imageHeight !== image.height
    || value.imageWidth !== image.width
  ) throw new Error("Substack image upload response did not bind the reviewed PNG");
  return Object.freeze({
    id: positiveInteger(value.id, "Substack image upload response.id"),
    url: exactSubstackImageUrl(
      value.url,
      image.width,
      image.height,
      "Substack image upload response.url",
    ),
  });
}

function attachmentUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) throw new Error(`${label} must be an exact UUID`);
  return value;
}

function parseSubstackImageAttachment(
  value: unknown,
  image: SubstackImage,
  expectedUrl: string,
): SubstackImageAttachment {
  if (!isRecord(value)) throw new Error("Substack image attachment response must be an object");
  requireExactKeys(value, [
    "explicit",
    "id",
    "imageHeight",
    "imageUrl",
    "imageWidth",
    "type",
  ], "Substack image attachment response");
  if (
    value.explicit !== false
    || value.type !== "image"
    || value.imageHeight !== image.height
    || value.imageWidth !== image.width
    || value.imageUrl !== expectedUrl
  ) throw new Error("Substack image attachment response did not bind the reviewed PNG");
  return Object.freeze({
    id: attachmentUuid(value.id, "Substack image attachment response.id"),
    url: expectedUrl,
  });
}

async function uploadSubstackImage(
  client: WebSessionClient,
  image: SubstackImage,
): Promise<SubstackImageAttachment> {
  const encoded = `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`;
  const uploaded = parseUploadedSubstackImage(await client.requestJson({
    url: new URL("/api/v1/image", SUBSTACK_ORIGIN),
    method: "POST",
    headers: jsonPostHeaders(),
    body: JSON.stringify({ image: encoded }),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: 256 * 1024,
  }), image);
  void uploaded.id;
  return parseSubstackImageAttachment(await client.requestJson({
    url: new URL("/api/v1/comment/attachment", SUBSTACK_ORIGIN),
    method: "POST",
    headers: jsonPostHeaders(),
    body: JSON.stringify({ type: "image", url: uploaded.url }),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: 256 * 1024,
  }), image, uploaded.url);
}

type SubstackBodyJson = Readonly<{
  type: "doc";
  attrs: Readonly<{ schemaVersion: "v1"; title: null }>;
  content: readonly Readonly<{
    type: "paragraph";
    content?: readonly Readonly<{ type: "text"; text: string }>[];
  }>[];
}>;

function substackBodyJson(body: string): SubstackBodyJson {
  const content = body.split("\n").map((line) => Object.freeze({
    type: "paragraph" as const,
    ...(line.length === 0
      ? {}
      : { content: Object.freeze([Object.freeze({ type: "text" as const, text: line })]) }),
  }));
  return Object.freeze({
    type: "doc",
    attrs: Object.freeze({ schemaVersion: "v1", title: null }),
    content: Object.freeze(content),
  });
}

function noteBodyInput(input: OperationInput): string {
  const body = input.body;
  if (
    typeof body !== "string"
    || body.length < 1
    || body.length > 500
    || /[\0\r]/u.test(body)
  ) throw new Error("input.body must be bounded Substack Note text");
  return body;
}

const CREATED_NOTE_KEYS = Object.freeze([
  "ancestor_path",
  "attachments",
  "autotranslate_to",
  "body",
  "body_json",
  "children",
  "children_count",
  "date",
  "deleted",
  "edited_at",
  "handle",
  "id",
  "is_ai_generated_text",
  "language",
  "media_clip_id",
  "name",
  "photo_url",
  "post_id",
  "publication_id",
  "reaction_count",
  "reactions",
  "reply_minimum_role",
  "restacked",
  "restacks",
  "status",
  "type",
  "userStatus",
  "user_bestseller_tier",
  "user_id",
  "user_primary_publication",
]);

function parseCreatedSubstackNote(
  value: unknown,
  viewer: SubstackWebViewer,
  body: string,
  bodyJson: SubstackBodyJson,
  attachment: SubstackImageAttachment | null,
): number {
  if (!isRecord(value)) throw new Error("Substack Note create response must be an object");
  requireAllowedKeys(value, CREATED_NOTE_KEYS, "Substack Note create response");
  if (
    value.user_id !== viewer.id
    || value.body !== body
    || value.type !== "feed"
    || (value.deleted !== undefined && value.deleted !== false)
    || value.post_id !== null
    || value.publication_id !== null
    || value.reply_minimum_role !== "everyone"
    || canonicalJson(value.body_json) !== canonicalJson(bodyJson)
    || (value.status !== undefined && value.status !== "published")
  ) throw new Error("Substack Note create response did not bind the confirmed Note");
  const attachments = value.attachments;
  if (!Array.isArray(attachments) || attachments.length !== (attachment === null ? 0 : 1)) {
    throw new Error("Substack Note create response did not bind the confirmed attachments");
  }
  if (attachment !== null) {
    const item = attachments[0];
    if (!isRecord(item)) throw new Error("Substack Note create attachment must be an object");
    requireExactKeys(item, [
      "explicit",
      "id",
      "imageHeight",
      "imageUrl",
      "imageWidth",
      "type",
    ], "Substack Note create attachment");
    if (item.id !== attachment.id || item.imageUrl !== attachment.url || item.type !== "image") {
      throw new Error("Substack Note create response attachment did not bind the uploaded image");
    }
  }
  return positiveInteger(value.id, "Substack Note create response.id");
}

type ProjectedSubstackNote = Readonly<{
  entityKey: string | null;
  comment: Readonly<{
    id: number;
    userId: number;
    publicationId: number | null;
    postId: number | null;
    body: string;
    type: string | null;
    attachments: readonly Readonly<{
      id: string | null;
      type: string | null;
      imageUrl: string | null;
      width: number | null;
      height: number | null;
    }>[];
  }>;
  post: unknown | null;
}>;

type SubstackNoteImageExpectation = Readonly<{
  readonly height: number;
  readonly width: number;
}>;

function assertSubstackNoteReadback(
  note: ProjectedSubstackNote,
  noteId: number,
  viewer: SubstackWebViewer,
  body: string,
  image: SubstackNoteImageExpectation | null,
  attachment: SubstackImageAttachment | null,
): void {
  if (
    note.entityKey !== `c-${noteId}`
    || note.comment.id !== noteId
    || note.comment.userId !== viewer.id
    || note.comment.publicationId !== null
    || note.comment.postId !== null
    || note.comment.body !== body
    || note.comment.type !== "feed"
    || note.post !== null
  ) throw new Error("Substack Note readback did not bind the confirmed Note");
  if (image === null || attachment === null) {
    if (note.comment.attachments.length !== 0) {
      throw new Error("Substack Note readback contained an unexpected attachment");
    }
    return;
  }
  if (
    note.comment.attachments.length !== 1
    || note.comment.attachments[0]?.id !== attachment.id
    || note.comment.attachments[0]?.type !== "image"
    || note.comment.attachments[0]?.imageUrl !== attachment.url
    || note.comment.attachments[0]?.width !== image.width
    || note.comment.attachments[0]?.height !== image.height
  ) throw new Error("Substack Note readback did not bind the confirmed image");
}

function substackDispatchEvent(
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return {
    id: "posts.publish",
    index: 1,
    progress: { planned: 1, started, verified },
  };
}

function substackNoteUrl(handle: string, noteId: number): string {
  return new URL(`/@${encodeURIComponent(handle)}/note/c-${noteId}`, SUBSTACK_ORIGIN).href;
}

type SubstackPostFailureStage =
  | "dispatch-admission"
  | "image-upload"
  | "note-create"
  | "accepted-target-recording"
  | "note-readback"
  | "verification-recording";

async function waitForSubstackNoteReadback(
  milliseconds: number,
  sleep: SubstackWebSleep,
  signal: AbortSignal | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
): Promise<void> {
  if (operationDeadline === undefined) {
    await sleep(milliseconds, signal);
    return;
  }
  await operationDeadline.run(
    (deadlineSignal) => sleep(milliseconds, deadlineSignal),
    "authenticated web operation deadline",
  );
}

async function readExactSubstackNoteAfterPublish(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  noteId: number,
  viewer: SubstackWebViewer,
  body: string,
  image: SubstackImage | null,
  attachment: SubstackImageAttachment | null,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly sleep: SubstackWebSleep;
  },
): Promise<ProjectedSubstackNote> {
  const readbackUrl = new URL(`/api/v1/reader/comment/${noteId}`, SUBSTACK_ORIGIN);
  authorizeSubstackWebReadRequest({
    operation: "posts.note",
    url: readbackUrl,
    method: "GET",
    targetId: noteId,
  });
  for (let attempt = 0; attempt <= SUBSTACK_NOTE_READBACK_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await waitForSubstackNoteReadback(
        SUBSTACK_NOTE_READBACK_DELAYS_MS[attempt - 1]!,
        options.sleep,
        options.signal,
        options.operationDeadline,
      );
    }
    try {
      const note = normalizeSubstackNoteResponse(await client.requestJson({
        url: readbackUrl,
        method: "GET",
        headers: jsonHeaders(),
        maxBytes: boundedMaximum(recipe),
      }), noteId) as ProjectedSubstackNote;
      assertSubstackNoteReadback(note, noteId, viewer, body, image, attachment);
      return note;
    } catch {
      options.operationDeadline?.throwIfUnavailable(
        "authenticated web operation deadline",
      );
      if (options.signal?.aborted === true) {
        throw new Error("Substack Note readback was cancelled");
      }
      if (attempt === SUBSTACK_NOTE_READBACK_DELAYS_MS.length) {
        throw new Error("Substack exact Note readback exhausted its reviewed window");
      }
    }
  }
  throw new Error("Substack exact Note readback exhausted its reviewed window");
}

type SubstackAcceptedNoteAttachment = Readonly<{
  id: string;
  url: string;
  height: number;
  width: number;
  mediaType: "image/png";
}>;

type SubstackAcceptedNoteTarget = Readonly<{
  noteId: number;
  attachment: SubstackAcceptedNoteAttachment | null;
}>;

function parseSubstackAcceptedNoteTarget(
  identifier: unknown,
): SubstackAcceptedNoteTarget {
  if (
    typeof identifier !== "string"
    || identifier.length < 1
    || identifier.length > 8_192
    || /[\0\r\n]/u.test(identifier)
  ) throw new Error("Substack accepted Note target must be bounded canonical JSON");
  let value: unknown;
  try {
    value = JSON.parse(identifier) as unknown;
  } catch {
    throw new Error("Substack accepted Note target must be bounded canonical JSON");
  }
  if (!isRecord(value)) throw new Error("Substack accepted Note target changed shape");
  requireExactKeys(value, ["attachment", "noteId"], "Substack accepted Note target");
  if (canonicalJson(value) !== identifier) {
    throw new Error("Substack accepted Note target must use canonical JSON");
  }
  const noteId = positiveInteger(value.noteId, "Substack accepted Note target.noteId");
  if (value.attachment === null) return Object.freeze({ noteId, attachment: null });
  if (!isRecord(value.attachment)) {
    throw new Error("Substack accepted Note attachment changed shape");
  }
  requireExactKeys(
    value.attachment,
    ["height", "id", "mediaType", "url", "width"],
    "Substack accepted Note attachment",
  );
  const width = positiveInteger(
    value.attachment.width,
    "Substack accepted Note attachment.width",
  );
  const height = positiveInteger(
    value.attachment.height,
    "Substack accepted Note attachment.height",
  );
  if (width > 20_000 || height > 20_000 || value.attachment.mediaType !== "image/png") {
    throw new Error("Substack accepted Note attachment changed shape");
  }
  return Object.freeze({
    noteId,
    attachment: Object.freeze({
      id: attachmentUuid(value.attachment.id, "Substack accepted Note attachment.id"),
      url: exactSubstackImageUrl(
        value.attachment.url,
        width,
        height,
        "Substack accepted Note attachment.url",
      ),
      height,
      width,
      mediaType: "image/png" as const,
    }),
  });
}

/** Read only the exact provider-accepted Substack Note target; never dispatch. */
export async function readSubstackWebAcceptedNoteTargetPresence(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  acceptedIdentifier: string,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: SubstackWebRuntimeDependencies;
  } = {},
): Promise<Readonly<{ present: true; noteId: number }>> {
  if (
    recipe.site !== "substack"
    || recipe.action !== "posts.publish"
    || recipe.contractVersion !== 3
  ) throw new Error("Substack accepted Note readback supports only posts.publish@3");
  requireExactInputKeys(input, ["body", "media"]);
  const body = noteBodyInput(input);
  const media = input.media === undefined ? null : fileInput(input.media);
  const target = parseSubstackAcceptedNoteTarget(acceptedIdentifier);
  if ((media !== null) !== (target.attachment !== null)) {
    throw new Error("Substack accepted Note target did not bind the confirmed media input");
  }
  const client = await createWebSessionClient(SUBSTACK_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await requireBoundViewer(client, auth, recipe.maxOutputBytes);
  const readbackUrl = new URL(
    `/api/v1/reader/comment/${target.noteId}`,
    SUBSTACK_ORIGIN,
  );
  authorizeSubstackWebReadRequest({
    operation: "posts.note",
    url: readbackUrl,
    method: "GET",
    targetId: target.noteId,
  });
  const note = normalizeSubstackNoteResponse(await client.requestJson({
    url: readbackUrl,
    method: "GET",
    headers: jsonHeaders(),
    maxBytes: boundedMaximum(recipe),
  }), target.noteId) as ProjectedSubstackNote;
  assertSubstackNoteReadback(
    note,
    target.noteId,
    viewer,
    body,
    target.attachment,
    target.attachment,
  );
  return Object.freeze({ present: true as const, noteId: target.noteId });
}

async function executeSubstackPost(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  viewer: SubstackWebViewer,
  input: OperationInput,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterProviderAcceptedMutationTarget?: (
      event: WebSessionProviderAcceptedMutationTargetEvent,
    ) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly sleep: SubstackWebSleep;
  },
): Promise<WebSessionExecution> {
  requireExactInputKeys(input, ["body", "media"]);
  const body = noteBodyInput(input);
  const bodyJson = substackBodyJson(body);
  if (viewer.handle === null) {
    throw new Error("Substack Note publication requires the bound viewer's public handle");
  }
  const image = input.media === undefined
    ? null
    : await materializeSubstackImage(
        fileInput(input.media),
        options.fileResolver,
        options.operationDeadline,
      );
  const reboundViewer = await currentViewer(client, boundedMaximum(recipe));
  if (viewerSubject(reboundViewer) !== viewerSubject(viewer)) {
    throw new Error("Substack current viewer changed before the Note dispatch");
  }
  if (reboundViewer.handle === null) {
    throw new Error("Substack Note publication requires the bound viewer's public handle");
  }
  let started = 0;
  let verified = 0;
  let noteId: number | null = null;
  let attachment: SubstackImageAttachment | null = null;
  let failureStage: SubstackPostFailureStage = "dispatch-admission";
  try {
    await options.beforeDispatch?.(substackDispatchEvent(started, verified));
    started = 1;
    failureStage = "image-upload";
    attachment = image === null ? null : await uploadSubstackImage(client, image);
    failureStage = "note-create";
    noteId = parseCreatedSubstackNote(await client.requestJson({
      url: new URL("/api/v1/comment/feed", SUBSTACK_ORIGIN),
      method: "POST",
      headers: jsonPostHeaders(),
      body: JSON.stringify({
        bodyJson,
        ...(attachment === null ? {} : { attachmentIds: [attachment.id] }),
        tabId: "for-you",
        surface: "feed",
        replyMinimumRole: "everyone",
      }),
      expectedStatuses: [200],
      expectedContentTypes: ["application/json"],
      maxBytes: boundedMaximum(recipe),
    }), reboundViewer, body, bodyJson, attachment);
    failureStage = "accepted-target-recording";
    await options.afterProviderAcceptedMutationTarget?.({
      id: "posts.publish",
      index: 1,
      target: {
        schemaVersion: 1,
        identifier: canonicalJson({
          noteId,
          attachment: attachment === null
            ? null
            : {
                id: attachment.id,
                url: attachment.url,
                height: image!.height,
                width: image!.width,
                mediaType: image!.mediaType,
              },
        }),
      },
    });
    failureStage = "note-readback";
    const note = await readExactSubstackNoteAfterPublish(
      client,
      recipe,
      noteId,
      reboundViewer,
      body,
      image,
      attachment,
      options,
    );
    verified = 1;
    failureStage = "verification-recording";
    await options.afterDispatchVerified?.(substackDispatchEvent(started, verified));
    return {
      status: "succeeded",
      output: Object.freeze({
        note,
        attachment: image === null
          ? null
          : Object.freeze({
              height: image.height,
              mediaType: image.mediaType,
              width: image.width,
            }),
      }),
      finalUrl: substackNoteUrl(reboundViewer.handle, noteId),
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: noteId === null ? SUBSTACK_ORIGIN : substackNoteUrl(reboundViewer.handle, noteId),
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? `Substack may have accepted the image upload or Note but exact actor, text, attachment, and permalink readback was not verified; reconcile before retrying (stage: ${failureStage})`
        : `Substack Note dispatch failed before submission (stage: ${failureStage})`,
    };
  }
}

export async function executeSubstackWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterProviderAcceptedMutationTarget?: (
      event: WebSessionProviderAcceptedMutationTargetEvent,
    ) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: SubstackWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "substack"
    || !isSubstackOperation(recipe.action)
  ) throw new Error("Substack authenticated web recipe is not installed");
  const expectedContractVersion = recipe.action === "posts.publish" ? 3 : 1;
  if (recipe.contractVersion !== expectedContractVersion) {
    throw new Error(
      `Substack authenticated web operation ${recipe.action} contract version ${recipe.contractVersion} is not installed`,
    );
  }
  const contract = SUBSTACK_WEB_OPERATIONS[recipe.action];
  if (contract.state !== "observed") {
    throw new Error(
      `Substack authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`,
    );
  }
  if (
    recipe.action !== "feeds.read"
    && recipe.action !== "posts.read"
    && recipe.action !== "articles.read"
    && recipe.action !== "comments.read"
    && recipe.action !== "media.read"
    && recipe.action !== "messaging.list"
    && recipe.action !== "posts.publish"
  ) throw new Error(`Substack authenticated web operation ${recipe.action} has no executable reviewed contract`);

  const client = await createWebSessionClient(SUBSTACK_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await requireBoundViewer(client, auth, recipe.maxOutputBytes);
  if (recipe.action === "posts.publish") {
    return executeSubstackPost(client, recipe, viewer, input, {
      ...options,
      sleep: options.dependencies?.sleep ?? sleepForSubstackReadback,
    });
  }
  // Executable Substack reads never enter the mutation dispatch ledger.
  void options.fileResolver;
  void options.beforeDispatch;
  void options.afterDispatchVerified;

  let output: unknown;
  switch (recipe.action) {
    case "feeds.read":
      output = await readFeed(client, recipe, input);
      break;
    case "posts.read":
      output = await readNote(client, recipe, input);
      break;
    case "articles.read":
      output = await readArticle(client, recipe, input, false);
      break;
    case "comments.read":
      output = await readComments(client, recipe, input);
      break;
    case "media.read":
      output = await readArticle(client, recipe, input, true);
      break;
    case "messaging.list":
      output = await listMessages(client, recipe, input);
      break;
  }
  return {
    status: "succeeded",
    output,
    finalUrl: SUBSTACK_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
