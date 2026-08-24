import { Blob } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { types as nodeTypes } from "node:util";

import type { WrenchAuth } from "../auth";
import type { BrowserFileResolver } from "../browser";
import { canonicalJson } from "../canonical-json";
import type { FileInputValue, OperationInput, WebSessionRecipe } from "../model";
import {
  createWebSessionClient,
  webSessionAuthSubject,
  webSessionCookie,
  type WebSessionClient,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  assertYouTubeResponseSuccess,
  assertYouTubeVideoBinding,
  createYouTubeSapisidAuthorization,
  findYouTubeCommentsContinuation,
  parseYouTubeInitialDataHtml,
  parseYouTubeBootstrapHtml,
  projectYouTubeProfile,
  projectYouTubeComments,
  projectYouTubeItems,
  projectYouTubeMedia,
  projectYouTubePost,
  youtubePostBrowseRequest,
  youtubeProfileBrowseRequest,
  youtubeProfileTarget,
  youtubeCurrentSubject,
  youtubeLikeMutationRequest,
  youtubeLikeState,
  youtubeSubscriptionMutationRequest,
  youtubeSubscriptionState,
  youtubeWatchLaterState,
  type YouTubeBootstrapConfig,
} from "./youtube-web";
import { isoBmffMp4VideoMetadata } from "./iso-bmff";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_YOUTUBE_VIDEO_BYTES = 128 * 1024 * 1024;
const DEFAULT_LIMIT = 20;
const YOUTUBE_MP4_COMPATIBILITY_POLICY = Object.freeze({
  compatibleBrands: Object.freeze([
    "M4V ",
    "MSNV",
    "avc1",
    "iso2",
    "isom",
    "mp41",
    "mp42",
  ]),
  rejectedMajorBrands: Object.freeze(["qt  "]),
});
const YOUTUBE_VIDEO_PUBLISH_BINDING_KEYS = Object.freeze([
  "ageRestricted",
  "byteLength",
  "bytes",
  "caption",
  "categoryId",
  "containsSyntheticMedia",
  "durationSeconds",
  "height",
  "madeForKids",
  "mediaSha256",
  "mediaType",
  "notifySubscribers",
  "title",
  "visibility",
  "width",
] as const);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;

type InnertubeEndpoint =
  | "account/account_menu"
  | "account/accounts_list"
  | "browse"
  | "like/like"
  | "like/removelike"
  | "navigation/resolve_url"
  | "next"
  | "player"
  | "playlist/edit"
  | "subscription/subscribe"
  | "subscription/unsubscribe";

export type YouTubeWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly now?: () => number;
};

export type YouTubeWebDesiredStateKind =
  | "like"
  | "subscription"
  | "watch-later";

export type YouTubeWebDesiredStatePreparation = {
  readonly kind: YouTubeWebDesiredStateKind;
  readonly targetId: string;
  readonly desiredState: boolean;
  readonly actualState: boolean;
  readonly alreadyDesired: boolean;
};

export type YouTubeWebDesiredStateReadback = {
  readonly kind: YouTubeWebDesiredStateKind;
  readonly targetId: string;
  readonly enabled: boolean;
};

export type YouTubeBoundVideoPublish = Readonly<{
  ageRestricted: boolean;
  bytes: Uint8Array<ArrayBuffer>;
  byteLength: number;
  caption: string | null;
  categoryId: string;
  containsSyntheticMedia: boolean;
  durationSeconds: number;
  height: number;
  madeForKids: boolean;
  mediaType: "video/mp4";
  mediaSha256: string;
  notifySubscribers: boolean;
  title: string;
  visibility: "private" | "unlisted" | "public";
  width: number;
}>;

export type YouTubeVideoPublishDispatchSnapshot = Readonly<{
  ageRestricted: boolean;
  body: Blob;
  byteLength: number;
  caption: string | null;
  categoryId: string;
  containsSyntheticMedia: boolean;
  durationSeconds: number;
  height: number;
  madeForKids: boolean;
  mediaType: "video/mp4";
  mediaSha256: string;
  notifySubscribers: boolean;
  title: string;
  visibility: "private" | "unlisted" | "public";
  width: number;
}>;

export type YouTubeVideoDeleteInput = Readonly<{
  expectedTitle: string;
  videoId: string;
}>;

export type YouTubeVideoCanonicalTarget = Readonly<{
  schemaVersion: 1;
  url: string;
  videoId: string;
}>;

function exactYouTubeVideoPublishBinding(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) throw new Error("YouTube video binding must be one exact object");
  if (nodeTypes.isProxy(value)) {
    throw new Error("YouTube video binding must not be a proxy");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("YouTube video binding must use a plain prototype");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== YOUTUBE_VIDEO_PUBLISH_BINDING_KEYS.length
    || ownKeys.some((key) => typeof key !== "string")
    || (ownKeys as string[]).sort().join(",")
      !== [...YOUTUBE_VIDEO_PUBLISH_BINDING_KEYS].sort().join(",")
  ) throw new Error("YouTube video binding contained unsupported fields");
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of YOUTUBE_VIDEO_PUBLISH_BINDING_KEYS) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new Error(
        "YouTube video binding must contain only enumerable data properties",
      );
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotYouTubeVideoBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "object"
    || value === null
    || nodeTypes.isProxy(value)
    || !(value instanceof Uint8Array)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || TYPED_ARRAY_BUFFER_GETTER === undefined
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) throw new Error("YouTube video binding must contain one bounded MP4");
  let buffer: unknown;
  let byteLength: unknown;
  try {
    buffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
  } catch {
    throw new Error("YouTube video binding must contain one bounded MP4");
  }
  if (
    typeof byteLength !== "number"
    || !Number.isSafeInteger(byteLength)
    || byteLength < 24
    || byteLength > MAX_YOUTUBE_VIDEO_BYTES
    || nodeTypes.isSharedArrayBuffer(buffer)
  ) throw new Error("YouTube video binding must contain one bounded MP4");

  // Copy through the intrinsic typed-array operation. Caller-defined
  // byteLength, buffer, iterator, or indexed accessors are not consulted, and
  // this unique ArrayBuffer is the only source used to validate and build the
  // eventual Blob.
  const bytes = new Uint8Array(byteLength);
  try {
    Uint8Array.prototype.set.call(bytes, value);
  } catch {
    throw new Error("YouTube video binding must contain one bounded MP4");
  }
  return bytes;
}

export const YOUTUBE_VIDEO_CAPTURE_REQUIRED_REASONS = Object.freeze({
  "content.delete": "cleanup only discarded the stalled incomplete Studio draft; no uploaded-video authored pre-read, accepted video/delete response, or exact-target absence readback was observed",
  "media.publish": "the signed-in Studio capture reached metadata JSON responses, but the selected MP4 remained at 0%; resumable initiation, byte-transfer acceptance, finalization, processing, and exact current-account readback remain unproved",
} as const);

type YouTubeBootstrap = {
  readonly auth: WrenchAuth;
  readonly client: WebSessionClient;
  readonly config: YouTubeBootstrapConfig;
  readonly sapisid: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly now: () => number;
  readonly subject: string;
};

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be a bounded string`);
  return value;
}

function stringInput(input: OperationInput, name: string, maximum: number): string {
  return boundedString(input[name], `input.${name}`, maximum);
}

function booleanInput(input: OperationInput, name: string): boolean {
  const value = input[name];
  if (typeof value !== "boolean") throw new Error(`input.${name} must be boolean`);
  return value;
}

function exactInputKeys(
  input: OperationInput,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(input);
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} contained an unsupported input field`);
  }
  if (required.some((key) => !Object.hasOwn(input, key))) {
    throw new Error(`${label} omitted a required input field`);
  }
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
    || (value as { readonly reference: string }).reference.length > 4_096
    || /[\0\r\n]/u.test((value as { readonly reference: string }).reference)
  ) throw new Error(`${label} must be one plan-bound file`);
  return value as FileInputValue;
}

function youtubeTitleInput(input: OperationInput, name: string): string {
  const value = stringInput(input, name, 90);
  if (/\n/u.test(value)) throw new Error(`input.${name} must be one exact YouTube title`);
  return value;
}

function youtubeVideoId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{11}$/u.test(value)) {
    throw new Error(`${label} must be an exact YouTube video ID`);
  }
  return value;
}

function youtubeVideoWatchUrl(videoId: string): string {
  return `${YOUTUBE_ORIGIN}/watch?v=${videoId}`;
}

function youtubeMp4Metadata(bytes: Uint8Array): Readonly<{
  durationSeconds: number;
  height: number;
  width: number;
}> {
  return isoBmffMp4VideoMetadata(
    bytes,
    "YouTube video",
    YOUTUBE_MP4_COMPATIBILITY_POLICY,
  );
}

function youtubeVideoSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Serialize only one exact video ID and its derived canonical watch URL. This
 * local target format does not imply provider acceptance or grant dispatch.
 */
export function youtubeVideoTargetIdentifier(videoIdValue: unknown): string {
  const videoId = youtubeVideoId(
    videoIdValue,
    "YouTube canonical video target ID",
  );
  return canonicalJson({
    schemaVersion: 1,
    url: youtubeVideoWatchUrl(videoId),
    videoId,
  });
}

/** Parse only the canonical local target shape used by future reconciliation. */
export function parseYouTubeVideoTargetIdentifier(
  identifier: unknown,
): YouTubeVideoCanonicalTarget {
  if (
    typeof identifier !== "string"
    || identifier.length < 1
    || identifier.length > 4_096
  ) throw new Error("YouTube canonical video target is not canonical JSON");
  let value: unknown;
  try {
    value = JSON.parse(identifier);
  } catch {
    throw new Error("YouTube canonical video target is not canonical JSON");
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "schemaVersion,url,videoId"
  ) throw new Error("YouTube canonical video target contained unsupported fields");
  const target = value as Readonly<Record<string, unknown>>;
  if (target.schemaVersion !== 1) {
    throw new Error("YouTube canonical video target schema version is unsupported");
  }
  const videoId = youtubeVideoId(
    target.videoId,
    "YouTube canonical video target ID",
  );
  const parsed = Object.freeze({
    schemaVersion: 1 as const,
    url: youtubeVideoWatchUrl(videoId),
    videoId,
  });
  if (target.url !== parsed.url || canonicalJson(parsed) !== identifier) {
    throw new Error("YouTube canonical video target is not canonical");
  }
  return parsed;
}

/**
 * Revalidate and snapshot a materialized video immediately before a future
 * dispatch. The current capture-required operation does not call this helper.
 */
export function revalidateYouTubeVideoPublishBindingForDispatch(
  value: unknown,
): YouTubeVideoPublishDispatchSnapshot {
  const binding = exactYouTubeVideoPublishBinding(value);
  const bytes = snapshotYouTubeVideoBytes(binding.bytes);
  const metadata = youtubeMp4Metadata(bytes);
  const mediaSha256 = youtubeVideoSha256(bytes);
  const declaredByteLength = binding.byteLength;
  const declaredDurationSeconds = binding.durationSeconds;
  const declaredHeight = binding.height;
  const declaredMediaSha256 = binding.mediaSha256;
  const declaredWidth = binding.width;
  if (
    !Number.isSafeInteger(declaredByteLength)
    || declaredByteLength !== bytes.byteLength
    || typeof declaredMediaSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(declaredMediaSha256)
    || declaredMediaSha256 !== mediaSha256
    || declaredDurationSeconds !== metadata.durationSeconds
    || declaredHeight !== metadata.height
    || declaredWidth !== metadata.width
  ) throw new Error("YouTube video binding changed from its exact bytes");
  const ageRestricted = binding.ageRestricted;
  const containsSyntheticMedia = binding.containsSyntheticMedia;
  const madeForKids = binding.madeForKids;
  const mediaType = binding.mediaType;
  const notifySubscribers = binding.notifySubscribers;
  const visibility = binding.visibility;
  if (
    typeof ageRestricted !== "boolean"
    || typeof containsSyntheticMedia !== "boolean"
    || typeof madeForKids !== "boolean"
    || typeof notifySubscribers !== "boolean"
    || mediaType !== "video/mp4"
    || (
      visibility !== "private"
      && visibility !== "unlisted"
      && visibility !== "public"
    )
  ) throw new Error("YouTube video binding declarations are invalid");
  if (ageRestricted && madeForKids) {
    throw new Error("YouTube video cannot be both made for kids and creator age-restricted");
  }
  const categoryId = boundedString(
    binding.categoryId,
    "YouTube video binding category ID",
    3,
  );
  if (!/^[1-9][0-9]{0,2}$/u.test(categoryId)) {
    throw new Error("YouTube video binding category ID must be exact");
  }
  const title = boundedString(binding.title, "YouTube video binding title", 90);
  if (/\n/u.test(title)) {
    throw new Error("YouTube video binding title must be one exact title");
  }
  const caption = binding.caption === null
    ? null
    : boundedString(binding.caption, "YouTube video binding caption", 1_000);
  const body = new Blob([bytes], { type: "video/mp4" });
  if (body.size !== bytes.byteLength || body.type !== "video/mp4") {
    throw new Error("YouTube video dispatch snapshot changed shape");
  }
  return Object.freeze({
    ageRestricted,
    body,
    byteLength: bytes.byteLength,
    caption,
    categoryId,
    containsSyntheticMedia,
    durationSeconds: metadata.durationSeconds,
    height: metadata.height,
    madeForKids,
    mediaSha256,
    mediaType: "video/mp4" as const,
    notifySubscribers,
    title,
    visibility,
    width: metadata.width,
  });
}

/**
 * Materialize exactly one plan-bound MP4 and the complete conservative creator
 * declarations. This remains a local preflight: no upload route calls it until
 * an authorized Studio capture proves dispatch and independent readback.
 */
export async function materializeYouTubeVideoPublishInput(
  input: OperationInput,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<YouTubeBoundVideoPublish> {
  const required = [
    "age_restricted",
    "category_id",
    "contains_synthetic_media",
    "made_for_kids",
    "media",
    "notify_subscribers",
    "title",
    "visibility",
  ] as const;
  exactInputKeys(input, required, ["caption"], "YouTube video publishing");
  const media = fileInput(input.media, "input.media");
  const title = youtubeTitleInput(input, "title");
  const caption = input.caption === undefined
    ? null
    : stringInput(input, "caption", 1_000);
  const visibility = input.visibility;
  if (visibility !== "private" && visibility !== "unlisted" && visibility !== "public") {
    throw new Error("input.visibility must be private, unlisted, or public");
  }
  const madeForKids = booleanInput(input, "made_for_kids");
  const notifySubscribers = booleanInput(input, "notify_subscribers");
  const containsSyntheticMedia = booleanInput(input, "contains_synthetic_media");
  const ageRestricted = booleanInput(input, "age_restricted");
  if (madeForKids && ageRestricted) {
    throw new Error("YouTube video cannot be both made for kids and creator age-restricted");
  }
  const categoryId = stringInput(input, "category_id", 3);
  if (!/^[1-9][0-9]{0,2}$/u.test(categoryId)) {
    throw new Error("input.category_id must be an exact positive YouTube category ID");
  }
  if (fileResolver === undefined) {
    throw new Error("YouTube video upload requires the plan-bound file resolver");
  }
  const resolve = () => fileResolver([media]);
  const paths = operationDeadline === undefined
    ? await resolve()
    : await operationDeadline.run(resolve, "authenticated web operation deadline");
  operationDeadline?.throwIfUnavailable("authenticated web operation deadline");
  if (paths.length !== 1 || typeof paths[0] !== "string") {
    throw new Error("YouTube file resolver did not return one exact video path");
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
    if (
      !before.isFile()
      || before.size < 24
      || before.size > MAX_YOUTUBE_VIDEO_BYTES
    ) {
      throw new Error(
        "YouTube video must be a regular MP4 no larger than the 128 MiB in-memory publish limit",
      );
    }
    const fileBytes = operationDeadline === undefined
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
      || fileBytes.byteLength !== before.size
    ) throw new Error("YouTube video changed while it was materialized");
    const bytes = new Uint8Array(fileBytes);
    const metadata = youtubeMp4Metadata(bytes);
    const mediaSha256 = youtubeVideoSha256(bytes);
    return Object.freeze({
      ageRestricted,
      bytes,
      byteLength: bytes.byteLength,
      caption,
      categoryId,
      containsSyntheticMedia,
      durationSeconds: metadata.durationSeconds,
      height: metadata.height,
      madeForKids,
      mediaType: "video/mp4" as const,
      mediaSha256,
      notifySubscribers,
      title,
      visibility,
      width: metadata.width,
    });
  } finally {
    await handle.close();
  }
}

/** Validate the exact authored-video confirmation required by deletion. */
export function prepareYouTubeVideoDeleteInput(
  input: OperationInput,
): YouTubeVideoDeleteInput {
  exactInputKeys(
    input,
    ["expected_title", "video_id"],
    [],
    "YouTube video deletion",
  );
  return Object.freeze({
    expectedTitle: youtubeTitleInput(input, "expected_title"),
    videoId: youtubeVideoId(input.video_id, "input.video_id"),
  });
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

function videoIdInput(input: OperationInput): string {
  const value = stringInput(input, "video_id", 11);
  if (!/^[A-Za-z0-9_-]{11}$/u.test(value)) throw new Error("input.video_id must be an exact YouTube video ID");
  return value;
}

function postIdInput(input: OperationInput): string {
  const value = stringInput(input, "post_id", 256);
  if (!/^[A-Za-z0-9_-]{10,256}$/u.test(value)) {
    throw new Error("input.post_id must be an exact YouTube Community post ID");
  }
  return value;
}

function channelIdInput(input: OperationInput): string {
  const value = stringInput(input, "channel_id", 24);
  if (!/^UC[A-Za-z0-9_-]{22}$/u.test(value)) {
    throw new Error("input.channel_id must be an exact YouTube channel ID");
  }
  return value;
}

function sapisidCookie(client: WebSessionClient): string {
  for (const name of ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"] as const) {
    if (client.cookies.some((cookie) => cookie.name === name)) return webSessionCookie(client.cookies, name);
  }
  throw new Error("YouTube signed-in session omitted its SAPISID cookie");
}

function requestHeaders(bootstrap: Omit<YouTubeBootstrap, "subject">): Readonly<Record<string, string>> {
  const authorization = createYouTubeSapisidAuthorization(
    bootstrap.sapisid,
    bootstrap.now(),
  );
  return {
    accept: "application/json",
    authorization,
    "content-type": "application/json",
    origin: YOUTUBE_ORIGIN,
    referer: `${YOUTUBE_ORIGIN}/`,
    "x-goog-authuser": bootstrap.config.sessionIndex,
    ...(bootstrap.config.delegatedSessionId === null
      ? {}
      : { "x-goog-pageid": bootstrap.config.delegatedSessionId }),
    ...(bootstrap.config.visitorData === null
      ? {}
      : { "x-goog-visitor-id": bootstrap.config.visitorData }),
    "x-origin": YOUTUBE_ORIGIN,
    "x-youtube-bootstrap-logged-in": String(bootstrap.config.bootstrapLoggedIn),
    "x-youtube-client-name": bootstrap.config.clientNameHeader,
    "x-youtube-client-version": bootstrap.config.clientVersion,
  };
}

function endpointUrl(endpoint: InnertubeEndpoint, apiKey: string): URL {
  const url = new URL(`/youtubei/v1/${endpoint}`, YOUTUBE_ORIGIN);
  url.searchParams.set("prettyPrint", "false");
  url.searchParams.set("key", apiKey);
  return url;
}

async function innertube(
  bootstrap: Omit<YouTubeBootstrap, "subject">,
  endpoint: InnertubeEndpoint,
  body: Readonly<Record<string, unknown>>,
  label: string,
): Promise<unknown> {
  const response = await bootstrap.client.requestJson({
    url: endpointUrl(endpoint, bootstrap.config.apiKey),
    method: "POST",
    headers: requestHeaders(bootstrap),
    body: JSON.stringify({ context: bootstrap.config.context, ...body }),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json"],
    maxBytes: bootstrap.maxOutputBytes,
  });
  assertYouTubeResponseSuccess(response, label);
  return response;
}

async function currentSubject(bootstrap: Omit<YouTubeBootstrap, "subject">): Promise<string> {
  const accountMenu = await innertube(bootstrap, "account/account_menu", {}, "YouTube account menu");
  const accountsList = await innertube(bootstrap, "account/accounts_list", {}, "YouTube accounts list");
  return youtubeCurrentSubject(
    accountMenu,
    accountsList,
    bootstrap.config.delegatedSessionId,
  );
}

async function bootstrapYouTube(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
  },
): Promise<YouTubeBootstrap> {
  const client = await createWebSessionClient(YOUTUBE_ORIGIN, auth, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const html = await client.requestText({
    url: new URL("/", YOUTUBE_ORIGIN),
    headers: { accept: "text/html" },
    expectedContentTypes: ["text/html"],
    maxBytes: MAX_BOOTSTRAP_BYTES,
  });
  const config = parseYouTubeBootstrapHtml(html);
  const partial = {
    auth,
    client,
    config,
    sapisid: sapisidCookie(client),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    now: options.dependencies?.now ?? Date.now,
  };
  const subject = await currentSubject(partial);
  return Object.freeze({ ...partial, subject });
}

function requireBoundSubject(bootstrap: YouTubeBootstrap): string {
  const expected = webSessionAuthSubject(bootstrap.auth);
  if (expected === null) {
    throw new Error("YouTube authenticated operations require a bound auth subject");
  }
  if (expected !== bootstrap.subject) {
    throw new Error("YouTube current account did not match the bound auth subject");
  }
  return expected;
}

export async function probeYouTubeWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const bootstrap = await bootstrapYouTube(auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return bootstrap.subject;
}

const feedBrowseIds = Object.freeze({
  home: "FEwhat_to_watch",
  subscriptions: "FEsubscriptions",
  library: "FElibrary",
  history: "FEhistory",
  playlists: "FEplaylist_aggregation",
  "watch-later": "VLWL",
  liked: "VLLL",
} as const);

type FeedName = keyof typeof feedBrowseIds;

function feedName(input: OperationInput): FeedName {
  const value = stringInput(input, "feed", 32);
  if (!Object.hasOwn(feedBrowseIds, value)) throw new Error("input.feed must name a reviewed YouTube feed");
  return value as FeedName;
}

async function executeFeed(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const feed = feedName(input);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const response = await innertube(
    bootstrap,
    "browse",
    { browseId: feedBrowseIds[feed] },
    "YouTube feed",
  );
  return {
    status: "succeeded",
    output: { feed, ...projectYouTubeItems(response, limit) },
    finalUrl: feed === "home"
      ? `${YOUTUBE_ORIGIN}/`
      : feed === "subscriptions"
        ? `${YOUTUBE_ORIGIN}/feed/subscriptions`
        : feed === "history"
          ? `${YOUTUBE_ORIGIN}/feed/history`
          : feed === "watch-later"
            ? `${YOUTUBE_ORIGIN}/playlist?list=WL`
            : feed === "liked"
              ? `${YOUTUBE_ORIGIN}/playlist?list=LL`
              : `${YOUTUBE_ORIGIN}/feed/you`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executeMediaRead(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const videoId = videoIdInput(input);
  const response = await innertube(
    bootstrap,
    "player",
    { videoId, contentCheckOk: true, racyCheckOk: true },
    "YouTube player",
  );
  return {
    status: "succeeded",
    output: projectYouTubeMedia(response, videoId),
    finalUrl: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executePostRead(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const postId = postIdInput(input);
  const resolved = await innertube(
    bootstrap,
    "navigation/resolve_url",
    { url: `${YOUTUBE_ORIGIN}/post/${postId}` },
    "YouTube Community URL resolution",
  );
  const browse = youtubePostBrowseRequest(resolved, postId);
  const response = await innertube(
    bootstrap,
    "browse",
    browse,
    "YouTube Community post",
  );
  return {
    status: "succeeded",
    output: projectYouTubePost(response, postId),
    finalUrl: `${YOUTUBE_ORIGIN}/post/${postId}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executeCommentsRead(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const videoId = videoIdInput(input);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const initial = await innertube(
    bootstrap,
    "next",
    { videoId },
    "YouTube video comments bootstrap",
  );
  assertYouTubeVideoBinding(initial, videoId, "YouTube video comments bootstrap");
  const continuation = findYouTubeCommentsContinuation(initial);
  const response = continuation === null
    ? initial
    : await innertube(
      bootstrap,
      "next",
      { continuation },
      "YouTube comments",
    );
  return {
    status: "succeeded",
    output: { videoId, ...projectYouTubeComments(response, limit) },
    finalUrl: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

function exactProfileCount(value: number | null): Readonly<Record<string, unknown>> {
  return value === null
    ? Object.freeze({ status: "unavailable", reason: "not-exposed" })
    : Object.freeze({
      status: "available",
      value,
      precision: "exact",
      unit: "count",
    });
}

async function executeProfileRead(
  bootstrap: YouTubeBootstrap,
  input: OperationInput,
): Promise<WebSessionExecution> {
  requireBoundSubject(bootstrap);
  const target = youtubeProfileTarget(input.profile);
  const resolved = await innertube(
    bootstrap,
    "navigation/resolve_url",
    { url: target.url },
    "YouTube profile URL resolution",
  );
  const browse = youtubeProfileBrowseRequest(resolved, target);
  const html = await bootstrap.client.requestText({
    url: new URL(`${target.url}/about`),
    headers: { accept: "text/html" },
    expectedContentTypes: ["text/html"],
    maxBytes: Math.min(bootstrap.maxOutputBytes, MAX_PROFILE_PAGE_BYTES),
  });
  const response = parseYouTubeInitialDataHtml(html);
  const profile = projectYouTubeProfile(response, browse.browseId, target.handle);
  if (
    target.handle !== null
    && profile.handle?.toLocaleLowerCase("en-US") !== target.handle.toLocaleLowerCase("en-US")
  ) throw new Error("YouTube profile response did not bind the requested handle");
  const observationTime = bootstrap.now();
  if (
    !Number.isSafeInteger(observationTime)
    || observationTime < 0
    || observationTime > 8_640_000_000_000_000
  ) throw new Error("YouTube profile observation time is invalid");
  const complete = profile.subscribers !== null
    && profile.videos !== null
    && profile.views !== null;
  return {
    status: "succeeded",
    output: Object.freeze({
      schemaVersion: 1,
      provider: "youtube",
      target: Object.freeze({
        kind: "profile",
        id: profile.channelId,
        url: profile.canonicalUrl,
      }),
      observedAt: new Date(observationTime).toISOString(),
      completeness: complete ? "complete" : "partial",
      metrics: Object.freeze({
        subscribers: exactProfileCount(profile.subscribers),
        videos: exactProfileCount(profile.videos),
        views: exactProfileCount(profile.views),
      }),
      metadata: Object.freeze({
        ...(profile.handle === null ? {} : { handle: profile.handle }),
        displayName: profile.displayName,
        ...(profile.bio === null ? {} : { bio: profile.bio }),
      }),
    }),
    finalUrl: profile.canonicalUrl,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

function dispatchEvent(
  action: string,
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return { id: action, index: 1, progress: { planned: 1, started, verified } };
}

async function likeReadback(bootstrap: YouTubeBootstrap, videoId: string): Promise<boolean> {
  const response = await innertube(
    bootstrap,
    "next",
    { videoId },
    "YouTube like readback",
  );
  return youtubeLikeState(response, videoId);
}

async function saveReadback(bootstrap: YouTubeBootstrap, videoId: string): Promise<boolean> {
  const response = await innertube(
    bootstrap,
    "next",
    { videoId },
    "YouTube save readback",
  );
  return youtubeWatchLaterState(response, videoId);
}

async function followReadback(bootstrap: YouTubeBootstrap, channelId: string): Promise<boolean> {
  const response = await innertube(
    bootstrap,
    "browse",
    { browseId: channelId },
    "YouTube subscription readback",
  );
  return youtubeSubscriptionState(response, channelId);
}

function isYouTubeDesiredStateRecipe(recipe: WebSessionRecipe): boolean {
  return recipe.site === "youtube"
    && recipe.contractVersion === 1
    && (
      recipe.action === "likes.set"
      || recipe.action === "content.save"
      || recipe.action === "relationships.follow.set"
    );
}

async function prepareDesiredStateWithBootstrap(
  bootstrap: YouTubeBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
): Promise<{
  readonly preparation: YouTubeWebDesiredStatePreparation;
  readonly commandSource: unknown;
}> {
  if (!isYouTubeDesiredStateRecipe(recipe)) {
    throw new Error(
      "YouTube desired-state preparation supports only likes.set, content.save, and relationships.follow.set",
    );
  }
  requireBoundSubject(bootstrap);
  const kind: YouTubeWebDesiredStateKind = recipe.action === "likes.set"
    ? "like"
    : recipe.action === "content.save"
      ? "watch-later"
      : "subscription";
  const targetId = kind === "subscription" ? channelIdInput(input) : videoIdInput(input);
  const desiredState = kind === "like"
    ? booleanInput(input, "liked")
    : kind === "watch-later"
      ? booleanInput(input, "saved")
      : booleanInput(input, "followed");
  const commandSource = kind === "subscription"
    ? await innertube(
      bootstrap,
      "browse",
      { browseId: targetId },
      "YouTube subscription command discovery",
    )
    : await innertube(
      bootstrap,
      "next",
      { videoId: targetId },
      kind === "like"
        ? "YouTube like command discovery"
        : "YouTube save readback",
    );
  const actualState = kind === "like"
    ? youtubeLikeState(commandSource, targetId)
    : kind === "watch-later"
      ? youtubeWatchLaterState(commandSource, targetId)
      : youtubeSubscriptionState(commandSource, targetId);
  return Object.freeze({
    preparation: Object.freeze({
      kind,
      targetId,
      desiredState,
      actualState,
      alreadyDesired: actualState === desiredState,
    }),
    commandSource: kind === "watch-later" ? null : commandSource,
  });
}

/**
 * Perform only the account and exact-target reads that precede a YouTube
 * desired-state write. Capture-required execution remains network-inert; this
 * read-only seam exists for reconciliation and deterministic preparation tests.
 */
export async function prepareYouTubeWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
  } = {},
): Promise<YouTubeWebDesiredStatePreparation> {
  if (!isYouTubeDesiredStateRecipe(recipe)) {
    throw new Error(
      "YouTube desired-state preparation supports only likes.set, content.save, and relationships.follow.set",
    );
  }
  const bootstrap = await bootstrapYouTube(auth, {
    timeoutMs: recipe.timeoutMs,
    maxOutputBytes: recipe.maxOutputBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  return (await prepareDesiredStateWithBootstrap(
    bootstrap,
    recipe,
    input,
  )).preparation;
}

/** Independently observe one exact YouTube desired state for reconciliation. */
export async function readYouTubeWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
  } = {},
): Promise<YouTubeWebDesiredStateReadback> {
  const preparation = await prepareYouTubeWebDesiredState(
    recipe,
    input,
    auth,
    options,
  );
  return Object.freeze({
    kind: preparation.kind,
    targetId: preparation.targetId,
    enabled: preparation.actualState,
  });
}

function desiredStateNoOp(
  preparation: YouTubeWebDesiredStatePreparation,
): WebSessionExecution {
  return {
    status: "succeeded",
    output: Object.freeze({
      kind: preparation.kind,
      targetId: preparation.targetId,
      enabled: preparation.desiredState,
      noOp: true,
      effect: "already-satisfied",
    }),
    finalUrl: preparation.kind === "subscription"
      ? `${YOUTUBE_ORIGIN}/channel/${preparation.targetId}`
      : `${YOUTUBE_ORIGIN}/watch?v=${preparation.targetId}`,
    dispatchStarted: false,
    dispatch: { planned: 1, started: 0, verified: 0 },
  };
}

async function executeDesiredState(
  bootstrap: YouTubeBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  const prepared = await prepareDesiredStateWithBootstrap(bootstrap, recipe, input);
  const { kind, targetId, desiredState: desired } = prepared.preparation;
  if (prepared.preparation.alreadyDesired) {
    return desiredStateNoOp(prepared.preparation);
  }
  let started = 0;
  let verified = 0;
  try {
    if (kind === "like") {
      const mutation = youtubeLikeMutationRequest(
        prepared.commandSource,
        targetId,
        desired,
      );
      await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
      started = 1;
      await innertube(
        bootstrap,
        mutation.endpoint,
        mutation.body,
        "YouTube like mutation",
      );
    } else if (kind === "watch-later") {
      await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
      started = 1;
      await innertube(
        bootstrap,
        "playlist/edit",
        {
          playlistId: "WL",
          actions: [{
            action: desired ? "ACTION_ADD_VIDEO" : "ACTION_REMOVE_VIDEO",
            ...(desired ? { addedVideoId: targetId } : { removedVideoId: targetId }),
          }],
        },
        "YouTube Watch Later mutation",
      );
    } else {
      const mutation = youtubeSubscriptionMutationRequest(
        prepared.commandSource,
        targetId,
        desired,
      );
      await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
      started = 1;
      await innertube(
        bootstrap,
        mutation.endpoint,
        mutation.body,
        "YouTube subscription mutation",
      );
    }
    const actual = kind === "like"
      ? await likeReadback(bootstrap, targetId)
      : kind === "watch-later"
        ? await saveReadback(bootstrap, targetId)
        : await followReadback(bootstrap, targetId);
    if (actual !== desired) throw new Error("YouTube desired-state readback did not match the confirmed state");
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, started, verified));
    return {
      status: "succeeded",
      output: { kind, targetId, enabled: desired },
      finalUrl: kind === "subscription"
        ? `${YOUTUBE_ORIGIN}/channel/${targetId}`
        : `${YOUTUBE_ORIGIN}/watch?v=${targetId}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: kind === "subscription"
        ? `${YOUTUBE_ORIGIN}/channel/${targetId}`
        : `${YOUTUBE_ORIGIN}/watch?v=${targetId}`,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "YouTube may have changed the requested state but exact readback was not verified; reconcile before retrying"
        : "YouTube desired-state dispatch failed before submission",
    };
  }
}

export async function executeYouTubeWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly fileResolver?: BrowserFileResolver;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: YouTubeWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site === "youtube"
    && (
      (recipe.action === "media.publish" && recipe.contractVersion === 2)
      || (recipe.action === "content.delete" && recipe.contractVersion === 1)
    )
  ) {
    const reason = YOUTUBE_VIDEO_CAPTURE_REQUIRED_REASONS[recipe.action as keyof typeof YOUTUBE_VIDEO_CAPTURE_REQUIRED_REASONS];
    throw new Error(
      `YouTube authenticated web operation ${recipe.action} is capture-required: ${reason}`,
    );
  }
  if (
    recipe.site === "youtube"
    && recipe.contractVersion === 1
    && [
      "content.save",
      "likes.set",
      "relationships.follow.set",
    ].includes(recipe.action)
  ) {
    throw new Error(
      `YouTube authenticated web operation ${recipe.action} is capture-required until an authorized low-stakes live fixture passes`,
    );
  }
  if (
    recipe.site !== "youtube"
    || recipe.contractVersion !== 1
    || ![
      "comments.read",
      "content.save",
      "feeds.read",
      "likes.set",
      "media.read",
      "posts.read",
      "profiles.read",
      "relationships.follow.set",
    ].includes(recipe.action)
  ) {
    throw new Error(`YouTube authenticated web operation ${recipe.action} has no executable reviewed contract`);
  }
  const bootstrap = await bootstrapYouTube(auth, {
    timeoutMs: recipe.timeoutMs,
    maxOutputBytes: recipe.maxOutputBytes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  if (recipe.action === "feeds.read") return executeFeed(bootstrap, input);
  if (recipe.action === "media.read") return executeMediaRead(bootstrap, input);
  if (recipe.action === "posts.read") return executePostRead(bootstrap, input);
  if (recipe.action === "profiles.read") return executeProfileRead(bootstrap, input);
  if (recipe.action === "comments.read") return executeCommentsRead(bootstrap, input);
  if (
    recipe.action === "likes.set"
    || recipe.action === "content.save"
    || recipe.action === "relationships.follow.set"
  ) return executeDesiredState(bootstrap, recipe, input, options);
  throw new Error(`YouTube authenticated web operation ${recipe.action} has no executable reviewed contract`);
}
