import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { WrenchAuth } from "../auth";
import type { BrowserFileResolver } from "../browser";
import { canonicalJson } from "../canonical-json";
import type { FileInputValue, OperationInput, WebSessionRecipe } from "../model";
import {
  createWebSessionClient,
  uploadPublicWebAsset,
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
  parseRedditVideoPostPresence,
  parseRedditVideoSubmitResponse,
  parseRedditVideoWebSocketMessage,
  parseRedditThingState,
  parseRedditWebProfileResponse,
  parseRedditWebViewerResponse,
  redditCommunity,
  redditFullname,
  redditMediaAssetUrl,
  redditPostId,
  type RedditMediaLease,
  type RedditMediaType,
  type RedditWebOperationName,
  type RedditWebViewer,
} from "./reddit-web";

const REDDIT_ORIGIN = "https://www.reddit.com";
const REDDIT_LEASE_ORIGIN = "https://old.reddit.com";
const REDDIT_USER_AGENT = "wrench/1.0 (local authenticated web client)";
const MAX_VIEWER_BYTES = 512 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIMIT = 25;
const MAX_PROFILE_OVERVIEW_PAGES = 10;

const REDDIT_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
const REDDIT_POSTER_MAX_BYTES = 20 * 1024 * 1024;
const REDDIT_UPLOAD_RESPONSE_BYTES = 2 * 1024 * 1024;
const REDDIT_VIDEO_FILENAME = "wrench-video.mp4";

export type RedditWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly waitForWebSocketMessage?: (
    url: string,
    options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
  ) => Promise<unknown>;
};

export type RedditWebDesiredStatePreparation =
  | {
      readonly operation: "content.save";
      readonly thingId: string;
      readonly desiredState: boolean;
      readonly actualState: boolean;
      readonly alreadyDesired: boolean;
    }
  | {
      readonly operation: "reactions.set";
      readonly thingId: string;
      readonly desiredState: boolean | null;
      readonly actualState: boolean | null;
      readonly alreadyDesired: boolean;
    };

export type RedditWebDesiredStateReadback = {
  readonly kind: "saved";
  readonly enabled: boolean;
  readonly thingId: string;
};

function isRedditOperation(value: string): value is RedditWebOperationName {
  return (REDDIT_WEB_OPERATION_NAMES as readonly string[]).includes(value);
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

function stringInput(
  input: OperationInput,
  name: string,
  maximum: number,
): string {
  const value = input[name];
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`input.${name} must be a bounded string`);
  return value;
}

function booleanInput(input: OperationInput, name: string): boolean {
  const value = input[name];
  if (typeof value !== "boolean") throw new Error(`input.${name} must be boolean`);
  return value;
}

function optionalStringInput(
  input: OperationInput,
  name: string,
  maximum: number,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  return stringInput(input, name, maximum);
}

function optionalBodyInput(
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
    || /[\0\r]/u.test(value)
  ) throw new Error(`input.${name} must be bounded text`);
  return value;
}

function fileInput(value: unknown, label: string): FileInputValue {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "kind,reference"
    || (value as { readonly kind?: unknown }).kind !== "file"
    || typeof (value as { readonly reference?: unknown }).reference !== "string"
    || (value as { readonly reference: string }).reference.length < 1
    || (value as { readonly reference: string }).reference.length > 1_024
  ) throw new Error(`${label} must be one plan-bound file`);
  return value as FileInputValue;
}

async function stableFileBytes(
  path: string,
  maximumBytes: number,
  label: string,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<Uint8Array> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      throw new Error(`${label} must be a regular file within its reviewed byte bound`);
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
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || bytes.byteLength !== before.size
    ) throw new Error(`${label} changed while it was materialized`);
    return bytes;
  } finally {
    await handle.close();
  }
}

type RedditBoundMedia = Readonly<{
  video: Uint8Array;
  poster: Uint8Array;
  posterType: "image/jpeg" | "image/png";
  posterFilename: "wrench-poster.jpg" | "wrench-poster.png";
}>;

function assertMp4(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 16
    || bytes[4] !== 0x66
    || bytes[5] !== 0x74
    || bytes[6] !== 0x79
    || bytes[7] !== 0x70
  ) throw new Error("Reddit video must be one bounded ISO BMFF MP4");
  const firstBoxSize = (
    ((bytes[0] ?? 0) << 24)
    | ((bytes[1] ?? 0) << 16)
    | ((bytes[2] ?? 0) << 8)
    | (bytes[3] ?? 0)
  ) >>> 0;
  if (firstBoxSize < 16 || firstBoxSize > bytes.byteLength) {
    throw new Error("Reddit video MP4 file-type box changed shape");
  }
}

function posterType(bytes: Uint8Array): RedditBoundMedia["posterType"] {
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.byteLength >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) return "image/jpeg";
  throw new Error("Reddit video poster must be one bounded PNG or JPEG");
}

async function readBoundRedditMedia(
  input: OperationInput,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<RedditBoundMedia> {
  const videoInput = fileInput(input.media, "input.media");
  const posterInput = fileInput(input.thumbnail, "input.thumbnail");
  if (fileResolver === undefined) {
    throw new Error("Reddit video upload requires the plan-bound file resolver");
  }
  const resolve = () => fileResolver([videoInput, posterInput]);
  const paths = operationDeadline === undefined
    ? await resolve()
    : await operationDeadline.run(resolve, "authenticated web operation deadline");
  if (
    paths.length !== 2
    || typeof paths[0] !== "string"
    || typeof paths[1] !== "string"
  ) throw new Error("Reddit media resolver did not return the exact video and poster files");
  const video = await stableFileBytes(
    paths[0],
    REDDIT_VIDEO_MAX_BYTES,
    "Reddit video",
    operationDeadline,
  );
  const poster = await stableFileBytes(
    paths[1],
    REDDIT_POSTER_MAX_BYTES,
    "Reddit video poster",
    operationDeadline,
  );
  assertMp4(video);
  const type = posterType(poster);
  return Object.freeze({
    video,
    poster,
    posterType: type,
    posterFilename: type === "image/png" ? "wrench-poster.png" : "wrench-poster.jpg",
  });
}

function exactReadHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    referer: `${REDDIT_ORIGIN}/`,
    "user-agent": REDDIT_USER_AGENT,
  });
}

function exactMutationHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    origin: REDDIT_ORIGIN,
    referer: `${REDDIT_ORIGIN}/`,
    "user-agent": REDDIT_USER_AGENT,
  });
}

function exactLeaseHeaders(
  community: string,
  modhash: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    origin: REDDIT_LEASE_ORIGIN,
    referer: `${REDDIT_LEASE_ORIGIN}/r/${redditCommunity(community)}/submit`,
    "user-agent": REDDIT_USER_AGENT,
    "x-modhash": modhash,
    "x-requested-with": "XMLHttpRequest",
  });
}

function redditMultipartUpload(
  lease: RedditMediaLease,
  bytes: Uint8Array,
  filename: string,
  mediaType: RedditMediaType,
): Readonly<{ body: Uint8Array; contentType: string }> {
  const digest = createHash("sha256")
    .update(bytes)
    .update(filename)
    .digest("hex")
    .slice(0, 32);
  const fieldText = lease.fields.map(({ name, value }) => `${name}\0${value}`).join("\0");
  for (let suffix = 0; suffix < 16; suffix += 1) {
    const boundary = `wrench-reddit-upload-${digest}-${suffix}`;
    if (
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .includes(Buffer.from(boundary, "ascii"))
      || fieldText.includes(boundary)
    ) continue;
    const chunks: Buffer[] = [];
    for (const field of lease.fields) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
        "utf8",
      ));
    }
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`,
      "utf8",
    ));
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "ascii"));
    return Object.freeze({
      body: new Uint8Array(Buffer.concat(chunks)),
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
  }
  throw new Error("Reddit media could not bind an unambiguous multipart boundary");
}

async function uploadRedditMedia(
  recipe: WebSessionRecipe,
  lease: RedditMediaLease,
  bytes: Uint8Array,
  filename: string,
  mediaType: RedditMediaType,
  dependencies: RedditWebRuntimeDependencies | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
): Promise<string> {
  const multipart = redditMultipartUpload(lease, bytes, filename, mediaType);
  await uploadPublicWebAsset(new URL("/", lease.uploadOrigin), {
    allowedOrigin: lease.uploadOrigin,
    body: multipart.body,
    contentType: multipart.contentType,
    expectedStatus: 201,
    maxBytes: mediaType === "video/mp4"
      ? REDDIT_VIDEO_MAX_BYTES + 1024 * 1024
      : REDDIT_POSTER_MAX_BYTES + 1024 * 1024,
    timeoutMs: recipe.timeoutMs,
    userAgent: REDDIT_USER_AGENT,
    ...(operationDeadline === undefined ? {} : { operationDeadline }),
    ...(dependencies === undefined ? {} : { dependencies }),
  });
  return redditMediaAssetUrl(lease);
}

function safeRedditPreparationFailure(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  if (
    /^public web asset upload returned unreviewed status [1-5][0-9]{2}$/u.test(message)
    || message === "public web asset upload failed before a reviewed response was received"
  ) return message;
  return null;
}

async function defaultWaitForWebSocketMessage(
  url: string,
  options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1_000
    || options.timeoutMs > 180_000
  ) throw new Error("Reddit video websocket timeout is outside its reviewed bound");
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let socket: WebSocket;
    const finish = (result: { readonly ok: true; readonly value: unknown } | { readonly ok: false }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000);
      }
      if (result.ok) resolve(result.value);
      else reject(new Error("Reddit video processing websocket ended without a reviewed result"));
    };
    const abort = (): void => finish({ ok: false });
    const timer = setTimeout(() => finish({ ok: false }), options.timeoutMs);
    try {
      socket = new WebSocket(url);
    } catch {
      clearTimeout(timer);
      reject(new Error("Reddit video processing websocket could not be opened"));
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.onmessage = (event): void => {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data, "utf8") > 64 * 1024) {
        finish({ ok: false });
        return;
      }
      finish({ ok: true, value: event.data });
    };
    socket.onerror = (): void => finish({ ok: false });
    socket.onclose = (): void => finish({ ok: false });
  });
}

async function currentViewer(
  client: WebSessionClient,
  maximumBytes = MAX_VIEWER_BYTES,
): Promise<RedditWebViewer> {
  const url = new URL("/api/me.json", REDDIT_ORIGIN);
  authorizeRedditWebRequest({
    operation: "viewer.current",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: Math.min(maximumBytes, MAX_VIEWER_BYTES),
  });
  return parseRedditWebViewerResponse(response);
}

function expectedSubject(auth: WrenchAuth): string {
  const subject = webSessionAuthSubject(auth);
  if (subject === null || !/^reddit:t2_[a-z0-9]{1,32}$/u.test(subject)) {
    throw new Error("Reddit authenticated operations require an auth locator bound to an exact reddit:t2_<id> subject");
  }
  return subject;
}

function assertBoundViewer(auth: WrenchAuth, viewer: RedditWebViewer): string {
  const expected = expectedSubject(auth);
  if (`reddit:${viewer.id}` !== expected) {
    throw new Error("Reddit browser session viewer no longer matches the confirmed auth subject");
  }
  return expected;
}

async function requireBoundViewer(
  client: WebSessionClient,
  auth: WrenchAuth,
): Promise<RedditWebViewer> {
  const viewer = await currentViewer(client);
  assertBoundViewer(auth, viewer);
  return viewer;
}

export async function probeRedditWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: RedditWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createWebSessionClient(REDDIT_ORIGIN, auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await currentViewer(client);
  return `reddit:${viewer.id}`;
}

function boundedMaximum(recipe: WebSessionRecipe): number {
  return Math.min(recipe.maxOutputBytes, MAX_READ_BYTES);
}

function profileInput(input: OperationInput): string {
  const value = stringInput(input, "profile", 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error("input.profile must be an exact Reddit profile handle");
  }
  return value;
}

function observedAt(dependencies: RedditWebRuntimeDependencies | undefined): string {
  const now = dependencies?.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    throw new Error("Reddit profile observation time is invalid");
  }
  return new Date(now).toISOString();
}

function exactCount(value: number, window?: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: "available",
    value,
    precision: "exact",
    unit: "count",
    ...(window === undefined ? {} : { window }),
  });
}

const contributionUnavailable = Object.freeze({
  status: "unavailable",
  reason: "not-exposed",
});

async function readProfileAbout(
  client: WebSessionClient,
  profile: string,
  maximumBytes: number,
): Promise<ReturnType<typeof parseRedditWebProfileResponse>> {
  const url = new URL(`/user/${encodeURIComponent(profile)}/about.json`, REDDIT_ORIGIN);
  url.searchParams.set("raw_json", "1");
  authorizeRedditWebRequest({
    operation: "profiles.about",
    url,
    method: "GET",
    profile,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
  return parseRedditWebProfileResponse(response, profile);
}

async function readVisibleContributionCount(
  client: WebSessionClient,
  profile: string,
  maximumBytes: number,
): Promise<number | null> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PROFILE_OVERVIEW_PAGES; pageNumber += 1) {
    const url = new URL(`/user/${encodeURIComponent(profile)}/overview.json`, REDDIT_ORIGIN);
    url.searchParams.set("limit", "100");
    url.searchParams.set("raw_json", "1");
    if (after !== null) url.searchParams.set("after", after);
    authorizeRedditWebRequest({
      operation: "profiles.overview",
      url,
      method: "GET",
      profile,
    });
    const response = await client.requestJson({
      url,
      method: "GET",
      headers: exactReadHeaders(),
      expectedStatuses: [200],
      expectedContentTypes: ["application/json"],
      maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
    });
    const page = parseRedditProfileContributionPage(response, profile);
    for (const id of page.ids) {
      if (ids.has(id)) throw new Error("Reddit profile overview pagination repeated a contribution");
      ids.add(id);
    }
    if (page.after === null) return ids.size;
    if (cursors.has(page.after)) throw new Error("Reddit profile overview pagination repeated a cursor");
    cursors.add(page.after);
    after = page.after;
  }
  return null;
}

async function readProfile(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  viewer: RedditWebViewer,
  dependencies: RedditWebRuntimeDependencies | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  const requestedProfile = profileInput(input);
  if (requestedProfile.toLocaleLowerCase("en-US") !== viewer.username.toLocaleLowerCase("en-US")) {
    throw new Error("Reddit requested profile did not match the bound current account");
  }
  const profile = await readProfileAbout(client, requestedProfile, recipe.maxOutputBytes);
  const contributions = await readVisibleContributionCount(
    client,
    requestedProfile,
    recipe.maxOutputBytes,
  );
  return Object.freeze({
    schemaVersion: 1,
    provider: "reddit",
    target: Object.freeze({
      kind: "profile",
      id: profile.username,
      url: `${REDDIT_ORIGIN}/user/${encodeURIComponent(profile.username)}/`,
    }),
    observedAt: observedAt(dependencies),
    completeness: contributions === null ? "partial" : "complete",
    metrics: Object.freeze({
      followers: exactCount(profile.followers),
      karma: exactCount(profile.karma),
      contributions: contributions === null
        ? contributionUnavailable
        : exactCount(contributions, "visible-overview"),
    }),
    metadata: Object.freeze({
      handle: profile.username,
      ...(profile.displayName === null ? {} : { displayName: profile.displayName }),
      ...(profile.bio === null ? {} : { bio: profile.bio }),
      contributionDefinition:
        "Distinct post and comment IDs in the complete authenticated profile overview listing.",
    }),
  });
}

function afterQuery(input: OperationInput): string | undefined {
  const after = optionalStringInput(input, "after", 40);
  if (after === undefined) return undefined;
  return redditFullname(after, "input.after", ["t1", "t3", "t4"]);
}

async function readFeed(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<unknown> {
  if (input.feed !== "home") throw new Error("input.feed must be the observed Reddit home feed");
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const url = new URL("/.json", REDDIT_ORIGIN);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("raw_json", "1");
  const after = afterQuery(input);
  if (after !== undefined) url.searchParams.set("after", after);
  authorizeRedditWebRequest({
    operation: "feeds.home",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeRedditFeedResponse(response, limit);
}

function postInput(input: OperationInput): string {
  return redditPostId(stringInput(input, "post_id", 40), "input.post_id");
}

async function readPostOrComments(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  comments: boolean,
): Promise<unknown> {
  const postId = postInput(input);
  const bare = postId.slice(3);
  const url = new URL(`/comments/${encodeURIComponent(bare)}.json`, REDDIT_ORIGIN);
  let limit = 1;
  if (comments) {
    limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
    url.searchParams.set("depth", "10");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("raw_json", "1");
    url.searchParams.set("sort", "confidence");
  } else {
    url.searchParams.set("limit", "1");
    url.searchParams.set("raw_json", "1");
  }
  authorizeRedditWebRequest({
    operation: comments ? "comments.read" : "posts.read",
    url,
    method: "GET",
    targetId: postId,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return comments
    ? normalizeRedditCommentsResponse(response, postId, limit)
    : normalizeRedditPostResponse(response, postId);
}

type RedditMessageFolder = "inbox" | "unread" | "sent";

function messageFolder(input: OperationInput): RedditMessageFolder {
  const value = stringInput(input, "folder", 16);
  if (value !== "inbox" && value !== "unread" && value !== "sent") {
    throw new Error("input.folder must name inbox, unread, or sent");
  }
  return value;
}

async function readMessages(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  single: boolean,
): Promise<unknown> {
  const folder = messageFolder(input);
  const url = new URL(`/message/${folder}.json`, REDDIT_ORIGIN);
  let limit = 1;
  let messageId: string | null = null;
  if (single) {
    messageId = redditFullname(
      stringInput(input, "message_id", 40),
      "input.message_id",
      ["t4"],
    );
    url.searchParams.set("limit", "1");
    url.searchParams.set("mark", "false");
    url.searchParams.set("max_replies", "100");
    url.searchParams.set("mid", messageId);
    url.searchParams.set("raw_json", "1");
  } else {
    limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("mark", "false");
    url.searchParams.set("max_replies", "0");
    url.searchParams.set("raw_json", "1");
    const after = afterQuery(input);
    if (after !== undefined) url.searchParams.set("after", after);
  }
  authorizeRedditWebRequest({
    operation: single ? "messages.read" : "messages.list",
    url,
    method: "GET",
    folder,
    ...(messageId === null ? {} : { targetId: messageId }),
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    maxBytes: boundedMaximum(recipe),
  });
  return normalizeRedditMessageListing(response, limit, messageId);
}

async function readThingState(
  client: WebSessionClient,
  targetId: string,
  maximumBytes: number,
) {
  const url = new URL("/api/info.json", REDDIT_ORIGIN);
  url.searchParams.set("id", targetId);
  url.searchParams.set("raw_json", "1");
  authorizeRedditWebRequest({
    operation: "state.readback",
    url,
    method: "GET",
    targetId,
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
  return parseRedditThingState(response, targetId);
}

async function readPostPresenceValue(
  client: WebSessionClient,
  targetId: string,
  maximumBytes: number,
): Promise<unknown> {
  const url = new URL("/api/info.json", REDDIT_ORIGIN);
  url.searchParams.set("id", redditPostId(targetId));
  url.searchParams.set("raw_json", "1");
  authorizeRedditWebRequest({
    operation: "state.readback",
    url,
    method: "GET",
    targetId,
  });
  return client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders(),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
}

async function requestRedditMediaLease(
  client: WebSessionClient,
  community: string,
  modhash: string,
  mediaType: RedditMediaType,
  filename: string,
): Promise<unknown> {
  const url = new URL(
    mediaType === "video/mp4"
      ? "/api/video_upload_s3.json"
      : "/api/image_upload_s3.json",
    REDDIT_LEASE_ORIGIN,
  );
  const form = new URLSearchParams();
  form.set("filepath", filename);
  form.set("mimetype", mediaType);
  form.set("raw_json", "1");
  const body = form.toString();
  authorizeRedditWebRequest({
    operation: "media.lease",
    url,
    method: "POST",
    body,
    mediaType,
    filename,
  });
  return client.requestJson({
    url,
    method: "POST",
    headers: exactLeaseHeaders(community, modhash),
    body,
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: REDDIT_UPLOAD_RESPONSE_BYTES,
  });
}

async function waitForRedditVideoReadback(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  postId: string,
  sleep: (milliseconds: number) => Promise<void>,
) {
  const delays = [0, 1_000, 2_000, 3_000, 5_000] as const;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const readback = parseRedditVideoPostPresence(
      await readPostPresenceValue(client, postId, recipe.maxOutputBytes),
      postId,
    );
    if (readback !== null) return readback;
  }
  throw new Error("Reddit video post did not appear within the bounded readback window");
}

function assertRedditVideoBinding(
  readback: NonNullable<ReturnType<typeof parseRedditVideoPostPresence>>,
  expected: Readonly<{
    viewer: RedditWebViewer;
    community: string;
    title: string;
    body: string;
    nsfw: boolean;
    spoiler: boolean;
    notBeforeSeconds: number;
    nowSeconds: number;
  }>,
): void {
  if (
    readback.post.author !== expected.viewer.username
    || (readback.authorFullname !== null && readback.authorFullname !== expected.viewer.id)
  ) throw new Error("Reddit video post readback did not bind the confirmed actor");
  if (
    readback.post.subreddit.toLowerCase() !== expected.community.toLowerCase()
    || readback.post.title !== expected.title
    || readback.post.body !== expected.body
    || readback.nsfw !== expected.nsfw
    || readback.spoiler !== expected.spoiler
  ) throw new Error("Reddit video post readback did not bind the confirmed content and declarations");
  if (
    readback.post.createdUtc === null
    || readback.post.createdUtc < expected.notBeforeSeconds - 300
    || readback.post.createdUtc > expected.nowSeconds + 300
  ) throw new Error("Reddit video post readback escaped the confirmed dispatch window");
}

function acceptedRedditPostId(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Reddit provider-accepted post target is not canonical JSON");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || Object.keys(parsed).join(",") !== "postId"
  ) throw new Error("Reddit provider-accepted post target changed shape");
  const postId = redditPostId(
    (parsed as { readonly postId?: unknown }).postId,
    "Reddit provider-accepted post target ID",
  );
  if (canonicalJson({ postId }) !== value) {
    throw new Error("Reddit provider-accepted post target is not canonical");
  }
  return postId;
}

async function executeMediaPublish(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterProviderAcceptedMutationTarget?: (
      event: WebSessionProviderAcceptedMutationTargetEvent,
    ) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: RedditWebRuntimeDependencies;
  },
): Promise<WebSessionExecution> {
  const community = redditCommunity(stringInput(input, "community", 21), "input.community");
  const title = stringInput(input, "title", 280);
  const body = optionalBodyInput(input, "body", 10_000) ?? "";
  const nsfw = booleanInput(input, "nsfw");
  const spoiler = booleanInput(input, "spoiler");
  const sendReplies = booleanInput(input, "send_replies");
  const viewer = await requireBoundViewer(client, auth);
  const media = await readBoundRedditMedia(
    input,
    options.fileResolver,
    options.operationDeadline,
  );
  const leaseClient = await createWebSessionClient(REDDIT_LEASE_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  let started = 0;
  let verified = 0;
  let stage = "video-lease-request";
  let finalUrl: string | null = null;
  try {
    const videoLeaseResponse = await requestRedditMediaLease(
      leaseClient,
      community,
      viewer.modhash,
      "video/mp4",
      REDDIT_VIDEO_FILENAME,
    );
    stage = "video-lease-parse";
    const videoLease = parseRedditMediaLeaseResponse(videoLeaseResponse, {
      mediaType: "video/mp4",
      filename: REDDIT_VIDEO_FILENAME,
    });
    stage = "poster-lease-request";
    const posterLeaseResponse = await requestRedditMediaLease(
      leaseClient,
      community,
      viewer.modhash,
      media.posterType,
      media.posterFilename,
    );
    stage = "poster-lease-parse";
    const posterLease = parseRedditMediaLeaseResponse(posterLeaseResponse, {
      mediaType: media.posterType,
      filename: media.posterFilename,
    });
    stage = "video-upload";
    const videoUrl = await uploadRedditMedia(
      recipe,
      videoLease,
      media.video,
      REDDIT_VIDEO_FILENAME,
      "video/mp4",
      options.dependencies,
      options.operationDeadline,
    );
    stage = "poster-upload";
    const posterUrl = await uploadRedditMedia(
      recipe,
      posterLease,
      media.poster,
      media.posterFilename,
      media.posterType,
      options.dependencies,
      options.operationDeadline,
    );
    stage = "viewer-rebinding";
    const rebound = await currentViewer(client);
    assertBoundViewer(auth, rebound);
    if (rebound.id !== viewer.id) throw new Error("Reddit viewer changed during video upload");
    const url = new URL("/api/submit", REDDIT_ORIGIN);
    url.searchParams.set("raw_json", "1");
    const form = new URLSearchParams();
    form.set("api_type", "json");
    form.set("kind", "video");
    form.set("nsfw", String(nsfw));
    form.set("resubmit", "false");
    form.set("sendreplies", String(sendReplies));
    form.set("spoiler", String(spoiler));
    form.set("sr", community);
    form.set("title", title);
    form.set("uh", rebound.modhash);
    form.set("url", videoUrl);
    form.set("validate_on_submit", "true");
    form.set("video_poster_url", posterUrl);
    if (body !== "") form.set("text", body);
    const submitBody = form.toString();
    authorizeRedditWebRequest({
      operation: "media.publish",
      url,
      method: "POST",
      body: submitBody,
      community,
      title,
      ...(body === "" ? {} : { text: body }),
      nsfw,
      spoiler,
      sendReplies,
      mediaUrl: videoUrl,
      posterUrl,
    });
    stage = "dispatch-admission";
    await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
    started = 1;
    const notBeforeSeconds = Math.floor((options.dependencies?.now ?? Date.now)() / 1_000);
    stage = "submit-response";
    const websocketUrl = parseRedditVideoSubmitResponse(
      await client.requestJson({
        url,
        method: "POST",
        headers: exactMutationHeaders(),
        body: submitBody,
        expectedStatuses: [200],
        expectedContentTypes: ["application/json"],
        maxBytes: REDDIT_UPLOAD_RESPONSE_BYTES,
      }),
    );
    stage = "processing-websocket";
    const waitForWebSocket = options.dependencies?.waitForWebSocketMessage
      ?? defaultWaitForWebSocketMessage;
    const remaining = options.operationDeadline?.remainingTimeMs() ?? 180_000;
    const message = await waitForWebSocket(websocketUrl, {
      timeoutMs: Math.max(1_000, Math.min(180_000, remaining)),
      ...(options.operationDeadline === undefined
        ? {}
        : { signal: options.operationDeadline.signal }),
    });
    const accepted = parseRedditVideoWebSocketMessage(message, community);
    finalUrl = accepted.url;
    stage = "accepted-target-recording";
    await options.afterProviderAcceptedMutationTarget?.({
      id: recipe.action,
      index: 1,
      target: {
        schemaVersion: 1,
        identifier: canonicalJson({ postId: accepted.postId }),
      },
    });
    stage = "independent-readback";
    const sleep = options.dependencies?.sleep
      ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const readback = await waitForRedditVideoReadback(
      client,
      recipe,
      accepted.postId,
      sleep,
    );
    const nowSeconds = Math.floor((options.dependencies?.now ?? Date.now)() / 1_000);
    assertRedditVideoBinding(readback, {
      viewer,
      community,
      title,
      body,
      nsfw,
      spoiler,
      notBeforeSeconds,
      nowSeconds,
    });
    verified = 1;
    stage = "verification-recording";
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1));
    return {
      status: "succeeded",
      output: Object.freeze({
        postId: accepted.postId,
        url: accepted.url,
        community,
        title,
        video: Object.freeze({
          durationSeconds: readback.durationSeconds,
          width: readback.width,
          height: readback.height,
        }),
      }),
      finalUrl: accepted.url,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch (error) {
    const preparationFailure = safeRedditPreparationFailure(error);
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? `Reddit may have published the confirmed video, but ${stage} was not verified; reconcile before retrying`
        : `Reddit video preparation failed at ${stage} before public submission${
          preparationFailure === null ? "" : `; reason: ${preparationFailure}`
        }`,
    };
  }
}

async function readDeletionPresence(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  postId: string,
) {
  return parseRedditAuthoredPostPresence(
    await readPostPresenceValue(client, postId, recipe.maxOutputBytes),
    postId,
  );
}

function assertDeletionTarget(
  presence: Awaited<ReturnType<typeof readDeletionPresence>>,
  viewer: RedditWebViewer,
  expectedTitle: string,
): void {
  if (!presence.present || presence.post === null) return;
  if (
    presence.post.author !== viewer.username
    || (presence.authorFullname !== null && presence.authorFullname !== viewer.id)
  ) throw new Error("Reddit delete target was not authored by the bound viewer");
  if (presence.post.title !== expectedTitle) {
    throw new Error("Reddit delete target title changed after confirmation");
  }
}

async function executeContentDelete(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: RedditWebRuntimeDependencies;
  },
): Promise<WebSessionExecution> {
  const postId = redditPostId(stringInput(input, "post_id", 40), "input.post_id");
  const expectedTitle = stringInput(input, "expected_title", 280);
  const viewer = await requireBoundViewer(client, auth);
  const before = await readDeletionPresence(client, recipe, postId);
  if (!before.present) {
    return {
      status: "succeeded",
      output: Object.freeze({ postId, deleted: true, noOp: true }),
      finalUrl: `${REDDIT_ORIGIN}/comments/${postId.slice(3)}/`,
      noOp: true,
      dispatchStarted: false,
      dispatch: { planned: 1, started: 0, verified: 0 },
    };
  }
  assertDeletionTarget(before, viewer, expectedTitle);
  let started = 0;
  let verified = 0;
  try {
    const rebound = await currentViewer(client);
    assertBoundViewer(auth, rebound);
    if (rebound.id !== viewer.id) throw new Error("Reddit viewer changed during delete preparation");
    const freshTarget = await readDeletionPresence(client, recipe, postId);
    if (!freshTarget.present) {
      return {
        status: "succeeded",
        output: Object.freeze({ postId, deleted: true, noOp: true }),
        finalUrl: `${REDDIT_ORIGIN}/comments/${postId.slice(3)}/`,
        noOp: true,
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
      };
    }
    assertDeletionTarget(freshTarget, rebound, expectedTitle);
    const url = new URL("/api/del", REDDIT_ORIGIN);
    const form = new URLSearchParams();
    form.set("id", postId);
    form.set("uh", rebound.modhash);
    const body = form.toString();
    authorizeRedditWebRequest({
      operation: "content.delete",
      url,
      method: "POST",
      body,
      targetId: postId,
    });
    await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
    started = 1;
    assertRedditMutationSuccess(await client.requestJson({
      url,
      method: "POST",
      headers: exactMutationHeaders(),
      body,
      expectedStatuses: [200],
      expectedContentTypes: ["application/json"],
      maxBytes: 512 * 1024,
    }));
    const sleep = options.dependencies?.sleep
      ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let after = await readDeletionPresence(client, recipe, postId);
    for (const delay of [500, 1_000, 2_000] as const) {
      if (!after.present) break;
      await sleep(delay);
      after = await readDeletionPresence(client, recipe, postId);
    }
    if (after.present) throw new Error("Reddit exact delete readback still returned the authored post");
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1));
    return {
      status: "succeeded",
      output: Object.freeze({ postId, deleted: true, noOp: false }),
      finalUrl: `${REDDIT_ORIGIN}/comments/${postId.slice(3)}/`,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: `${REDDIT_ORIGIN}/comments/${postId.slice(3)}/`,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "Reddit may have deleted the exact post, but absence was not verified; reconcile before retrying"
        : "Reddit delete dispatch failed before submission",
    };
  }
}

function dispatchEvent(
  id: string,
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return {
    id,
    index: 1,
    progress: { planned: 1, started, verified },
  };
}

function desiredReaction(input: OperationInput): -1 | 0 | 1 {
  const value = input.direction;
  if (!Number.isSafeInteger(value)) {
    throw new Error("input.direction must be -1, 0, or 1");
  }
  if (value !== -1 && value !== 0 && value !== 1) {
    throw new Error("input.direction must be -1, 0, or 1");
  }
  return value;
}

function desiredLikedState(direction: -1 | 0 | 1): boolean | null {
  return direction === 1 ? true : direction === -1 ? false : null;
}

async function prepareDesiredStateWithClient(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
): Promise<{
  readonly viewer: RedditWebViewer;
  readonly preparation: RedditWebDesiredStatePreparation;
}> {
  if (
    recipe.site !== "reddit"
    || recipe.contractVersion !== 1
    || (recipe.action !== "content.save" && recipe.action !== "reactions.set")
  ) {
    throw new Error(
      "Reddit desired-state preparation supports only content.save and reactions.set",
    );
  }
  const viewer = await requireBoundViewer(client, auth);
  const thingId = redditFullname(
    stringInput(input, "thing_id", 40),
    "input.thing_id",
    ["t1", "t3"],
  );
  const before = await readThingState(client, thingId, recipe.maxOutputBytes);
  if (recipe.action === "content.save") {
    const desiredState = booleanInput(input, "saved");
    return Object.freeze({
      viewer,
      preparation: Object.freeze({
        operation: "content.save",
        thingId,
        desiredState,
        actualState: before.saved,
        alreadyDesired: before.saved === desiredState,
      }),
    });
  }
  const direction = desiredReaction(input);
  const desiredState = desiredLikedState(direction);
  return Object.freeze({
    viewer,
    preparation: Object.freeze({
      operation: "reactions.set",
      thingId,
      desiredState,
      actualState: before.liked,
      alreadyDesired: before.liked === desiredState,
    }),
  });
}

/**
 * Perform only the account and exact-target reads that precede a Reddit
 * desired-state write. The helper never constructs a mutation request or
 * enters the dispatch boundary, so capture-required execution stays inert.
 */
export async function prepareRedditWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: RedditWebRuntimeDependencies;
  } = {},
): Promise<RedditWebDesiredStatePreparation> {
  if (
    recipe.site !== "reddit"
    || recipe.contractVersion !== 1
    || (recipe.action !== "content.save" && recipe.action !== "reactions.set")
  ) {
    throw new Error(
      "Reddit desired-state preparation supports only content.save and reactions.set",
    );
  }
  const client = await createWebSessionClient(REDDIT_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return (await prepareDesiredStateWithClient(
    client,
    recipe,
    input,
    auth,
  )).preparation;
}

/** Independently read one exact Reddit saved state for reconciliation. */
export async function readRedditWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: RedditWebRuntimeDependencies;
  } = {},
): Promise<RedditWebDesiredStateReadback> {
  if (
    recipe.site !== "reddit"
    || recipe.contractVersion !== 1
    || recipe.action !== "content.save"
  ) {
    throw new Error("Reddit recovery readback supports only content.save");
  }
  const preparation = await prepareRedditWebDesiredState(
    recipe,
    input,
    auth,
    options,
  );
  if (preparation.operation !== "content.save") {
    throw new Error("Reddit saved-state readback changed operation kind");
  }
  return Object.freeze({
    kind: "saved",
    enabled: preparation.actualState,
    thingId: preparation.thingId,
  });
}

export async function readRedditWebContentDeleteDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly dependencies?: RedditWebRuntimeDependencies;
  } = {},
): Promise<Readonly<{ present: boolean; postId: string }>> {
  if (
    recipe.site !== "reddit"
    || recipe.action !== "content.delete"
    || recipe.contractVersion !== 1
  ) throw new Error("Reddit deletion recovery supports only content.delete@1");
  const postId = redditPostId(stringInput(input, "post_id", 40), "input.post_id");
  const expectedTitle = stringInput(input, "expected_title", 280);
  const client = await createWebSessionClient(REDDIT_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await requireBoundViewer(client, auth);
  const presence = await readDeletionPresence(client, recipe, postId);
  assertDeletionTarget(presence, viewer, expectedTitle);
  return Object.freeze({ present: presence.present, postId });
}

export async function readRedditWebPublishedMutationTarget(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  identifier: string,
  options: {
    readonly signal?: AbortSignal;
    readonly dependencies?: RedditWebRuntimeDependencies;
  } = {},
): Promise<Readonly<{ present: boolean; postId: string }>> {
  if (
    recipe.site !== "reddit"
    || recipe.action !== "media.publish"
    || recipe.contractVersion !== 9
  ) throw new Error("Reddit video-publish recovery supports only media.publish@9");
  const postId = acceptedRedditPostId(identifier);
  const community = redditCommunity(stringInput(input, "community", 21), "input.community");
  const title = stringInput(input, "title", 280);
  const body = optionalBodyInput(input, "body", 10_000) ?? "";
  const nsfw = booleanInput(input, "nsfw");
  const spoiler = booleanInput(input, "spoiler");
  const client = await createWebSessionClient(REDDIT_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await requireBoundViewer(client, auth);
  const readback = parseRedditVideoPostPresence(
    await readPostPresenceValue(client, postId, recipe.maxOutputBytes),
    postId,
  );
  if (readback === null) return Object.freeze({ present: false, postId });
  const nowSeconds = Math.floor((options.dependencies?.now ?? Date.now)() / 1_000);
  assertRedditVideoBinding(readback, {
    viewer,
    community,
    title,
    body,
    nsfw,
    spoiler,
    notBeforeSeconds: 0,
    nowSeconds,
  });
  return Object.freeze({ present: true, postId });
}

function desiredStateNoOp(
  preparation: RedditWebDesiredStatePreparation,
): WebSessionExecution {
  const desired = preparation.operation === "content.save"
    ? { saved: preparation.desiredState }
    : {
      direction: preparation.desiredState === true
        ? 1
        : preparation.desiredState === false ? -1 : 0,
    };
  return {
    status: "succeeded",
    output: Object.freeze({
      thingId: preparation.thingId,
      desired: Object.freeze(desired),
      noOp: true,
      effect: "already-satisfied",
    }),
    finalUrl: REDDIT_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 1, started: 0, verified: 0 },
  };
}

async function executeDesiredState(
  client: WebSessionClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  const prepared = await prepareDesiredStateWithClient(client, recipe, input, auth);
  const initialViewer = prepared.viewer;
  const targetId = prepared.preparation.thingId;
  const save = recipe.action === "content.save";
  const direction = save ? null : desiredReaction(input);
  const saved = save ? booleanInput(input, "saved") : null;
  if (prepared.preparation.alreadyDesired) {
    return desiredStateNoOp(prepared.preparation);
  }

  let started = 0;
  let verified = 0;
  try {
    // Fetch a second, immediately pre-dispatch account record. This both
    // re-binds the actor and prevents reuse of a stale listing modhash.
    const freshViewer = await currentViewer(client);
    assertBoundViewer(auth, freshViewer);
    if (freshViewer.id !== initialViewer.id) {
      throw new Error("Reddit viewer changed during desired-state preparation");
    }
    const url = new URL(
      save ? (saved ? "/api/save" : "/api/unsave") : "/api/vote",
      REDDIT_ORIGIN,
    );
    const form = new URLSearchParams();
    if (!save) form.set("dir", String(direction));
    form.set("id", targetId);
    form.set("uh", freshViewer.modhash);
    const body = form.toString();
    authorizeRedditWebRequest({
      operation: save ? "content.save" : "reactions.set",
      url,
      method: "POST",
      body,
      targetId,
      ...(save ? { saved: saved! } : { direction: direction! }),
    });
    await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
    started = 1;
    const mutation = await client.requestJson({
      url,
      method: "POST",
      headers: exactMutationHeaders(),
      body,
      expectedStatuses: [200],
      expectedContentTypes: ["application/json"],
      maxBytes: Math.min(recipe.maxOutputBytes, 512 * 1024),
    });
    assertRedditMutationSuccess(mutation);
    const after = await readThingState(client, targetId, recipe.maxOutputBytes);
    if (save ? after.saved !== saved : after.liked !== desiredLikedState(direction!)) {
      throw new Error("Reddit desired-state readback did not match the confirmed state");
    }
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1));
    return {
      status: "succeeded",
      output: Object.freeze({
        thingId: targetId,
        desired: save ? { saved } : { direction },
        noOp: false,
        previouslyDesired: false,
      }),
      finalUrl: REDDIT_ORIGIN,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: REDDIT_ORIGIN,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "Reddit may have changed the requested state but exact readback was not verified; reconcile before retrying"
        : "Reddit desired-state dispatch failed before submission",
    };
  }
}

export async function executeRedditWebOperation(
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
    readonly dependencies?: RedditWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "reddit"
    || !isRedditOperation(recipe.action)
    || recipe.contractVersion !== (recipe.action === "media.publish" ? 9 : 1)
  ) {
    throw new Error("Reddit authenticated web recipe is not installed");
  }
  const contract = REDDIT_WEB_OPERATIONS[recipe.action];
  if (contract.state !== "observed") {
    throw new Error(`Reddit authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`);
  }
  const client = await createWebSessionClient(REDDIT_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  if (recipe.action === "media.publish") {
    return executeMediaPublish(client, recipe, input, auth, options);
  }
  if (recipe.action === "content.delete") {
    return executeContentDelete(client, recipe, input, auth, options);
  }
  if (recipe.action === "reactions.set" || recipe.action === "content.save") {
    return executeDesiredState(client, recipe, input, auth, options);
  }

  const viewer = await requireBoundViewer(client, auth);
  // R1 operations never enter the mutation dispatch ledger.
  void options.beforeDispatch;
  void options.afterDispatchVerified;
  const output = recipe.action === "profiles.read"
    ? await readProfile(client, recipe, input, viewer, options.dependencies)
    : recipe.action === "feeds.read"
      ? await readFeed(client, recipe, input)
    : recipe.action === "posts.read"
      ? await readPostOrComments(client, recipe, input, false)
      : recipe.action === "comments.read"
        ? await readPostOrComments(client, recipe, input, true)
        : recipe.action === "messaging.list"
          ? await readMessages(client, recipe, input, false)
          : recipe.action === "messaging.read"
            ? await readMessages(client, recipe, input, true)
            : (() => {
                throw new Error(`Reddit authenticated web operation ${recipe.action} has no executable reviewed contract`);
              })();
  return {
    status: "succeeded",
    output,
    finalUrl: recipe.action === "profiles.read"
      ? `${REDDIT_ORIGIN}/user/${encodeURIComponent(profileInput(input))}/`
      : recipe.action === "feeds.read"
      ? REDDIT_ORIGIN
      : recipe.action === "posts.read" || recipe.action === "comments.read"
        ? `${REDDIT_ORIGIN}/comments/${postInput(input).slice(3)}/`
        : `${REDDIT_ORIGIN}/message/${messageFolder(input)}/`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
