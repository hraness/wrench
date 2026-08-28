import { Blob } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { types as nodeTypes } from "node:util";

import type { WrenchAuth } from "../auth";
import type { BrowserFileResolver } from "../browser";
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
} from "../web-session-execution";
import { failedProviderRead } from "./read-failure";
import {
  TIKTOK_WEB_OPERATION_NAMES,
  TIKTOK_WEB_OPERATIONS,
  authorizeTikTokWebR1Request,
  enforceTikTokWebHeaderSinkPolicy,
  normalizeTikTokWebCommentsResponse,
  normalizeTikTokWebFeedResponse,
  parseTikTokWebProfileResponse,
  parseTikTokWebViewerResponse,
  tikTokVideoSha256,
  type TikTokWebOperationName,
  type TikTokWebProfile,
  type TikTokWebViewer,
} from "./tiktok-web";
import { tiktokMp4Metadata } from "./tiktok-video-mp4";

const TIKTOK_ORIGIN = "https://www.tiktok.com";
const MAX_VIEWER_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_TIKTOK_VIDEO_BYTES = 128 * 1024 * 1024;
const DEFAULT_FEED_LIMIT = 20;
const DEFAULT_COMMENT_LIMIT = 20;
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

export type TikTokWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly now?: () => number;
};

export type TikTokBoundVideoPublish = Readonly<{
  allowAiRemix: boolean;
  allowComments: boolean;
  allowContentReuse: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  audience: "public" | "friends" | "private";
  bytes: Uint8Array<ArrayBuffer>;
  byteLength: number;
  caption: string | null;
  commercialContent: "none";
  containsSyntheticMedia: boolean;
  durationSeconds: number;
  height: number;
  mediaType: "video/mp4";
  mediaSha256: string;
  width: number;
}>;

export type TikTokVideoPublishDispatchSnapshot = Readonly<{
  allowAiRemix: boolean;
  allowComments: boolean;
  allowContentReuse: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  audience: "public" | "friends" | "private";
  body: Blob;
  byteLength: number;
  caption: string | null;
  commercialContent: "none";
  containsSyntheticMedia: boolean;
  durationSeconds: number;
  height: number;
  mediaType: "video/mp4";
  mediaSha256: string;
  width: number;
}>;

export type TikTokPublishedPostDeleteInput = Readonly<{
  expectedCaption: string;
  postId: string;
}>;

function exactInputKeys(
  input: OperationInput,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !allowed.has(key))
  ) throw new Error(`${label} contained unsupported or missing input fields`);
}

function exactFileInput(value: unknown, label: string): FileInputValue {
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
  ) throw new Error(`${label} must be one exact plan-bound file`);
  return value as FileInputValue;
}

function boundedInputText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length < 1)
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

function exactBooleanInput(input: OperationInput, name: string): boolean {
  const value = input[name];
  if (typeof value !== "boolean") throw new Error(`input.${name} must be boolean`);
  return value;
}

function exactTikTokVideoBinding(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) throw new Error("TikTok video binding must be one exact object");
  if (nodeTypes.isProxy(value)) {
    throw new Error("TikTok video binding must not be a proxy");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("TikTok video binding must use a plain prototype");
  }
  const expected = [
    "allowAiRemix",
    "allowComments",
    "allowContentReuse",
    "allowDuet",
    "allowStitch",
    "audience",
    "byteLength",
    "bytes",
    "caption",
    "commercialContent",
    "containsSyntheticMedia",
    "durationSeconds",
    "height",
    "mediaSha256",
    "mediaType",
    "width",
  ] as const;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expected.length
    || ownKeys.some((key) => typeof key !== "string")
    || (ownKeys as string[]).sort().join(",") !== [...expected].sort().join(",")
  ) throw new Error("TikTok video binding contained unsupported fields");
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) throw new Error("TikTok video binding must contain only enumerable data properties");
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function exactTikTokCreatorBoolean(
  binding: Readonly<Record<string, unknown>>,
  name: string,
): boolean {
  const value = binding[name];
  if (typeof value !== "boolean") {
    throw new Error("TikTok video binding creator declarations are invalid");
  }
  return value;
}

function snapshotTikTokVideoBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "object"
    || value === null
    || nodeTypes.isProxy(value)
    || !(value instanceof Uint8Array)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || TYPED_ARRAY_BUFFER_GETTER === undefined
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) throw new Error("TikTok video binding must contain one bounded MP4");
  let buffer: unknown;
  let byteLength: unknown;
  try {
    buffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
  } catch {
    throw new Error("TikTok video binding must contain one bounded MP4");
  }
  if (
    typeof byteLength !== "number"
    || !Number.isSafeInteger(byteLength)
    || byteLength < 24
    || byteLength > MAX_TIKTOK_VIDEO_BYTES
    || nodeTypes.isSharedArrayBuffer(buffer)
  ) throw new Error("TikTok video binding must contain one bounded MP4");

  // Allocate the bounded destination first, then copy through the intrinsic
  // typed-array operation. Caller-defined buffer, byteLength, iterator, or
  // indexed property behavior cannot supply the validated dispatch bytes.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(bytes, value);
  } catch {
    throw new Error("TikTok video binding must contain one bounded MP4");
  }
  return bytes;
}

/**
 * Materialize one exact plan-bound MP4 and all supported creator choices.
 * This is local-only preflight; capture-required execution rejects before it.
 */
export async function materializeTikTokVideoPublishInput(
  input: OperationInput,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<TikTokBoundVideoPublish> {
  const required = [
    "allow_ai_remix",
    "allow_comments",
    "allow_content_reuse",
    "allow_duet",
    "allow_stitch",
    "audience",
    "commercial_content",
    "contains_synthetic_media",
    "media",
  ] as const;
  exactInputKeys(input, required, ["caption"], "TikTok video publishing");
  const media = exactFileInput(input.media, "input.media");
  const caption = input.caption === undefined
    ? null
    : boundedInputText(input.caption, "input.caption", 500);
  const audience = input.audience;
  if (audience !== "public" && audience !== "friends" && audience !== "private") {
    throw new Error("input.audience must be public, friends, or private");
  }
  if (input.commercial_content !== "none") {
    throw new Error("input.commercial_content must explicitly be none");
  }
  const allowAiRemix = exactBooleanInput(input, "allow_ai_remix");
  const allowComments = exactBooleanInput(input, "allow_comments");
  const allowContentReuse = exactBooleanInput(input, "allow_content_reuse");
  const allowDuet = exactBooleanInput(input, "allow_duet");
  const allowStitch = exactBooleanInput(input, "allow_stitch");
  const containsSyntheticMedia = exactBooleanInput(input, "contains_synthetic_media");
  if (fileResolver === undefined) {
    throw new Error("TikTok video upload requires the plan-bound file resolver");
  }
  const resolve = () => fileResolver([media]);
  const paths = operationDeadline === undefined
    ? await resolve()
    : await operationDeadline.run(resolve, "authenticated web operation deadline");
  operationDeadline?.throwIfUnavailable("authenticated web operation deadline");
  if (paths.length !== 1 || typeof paths[0] !== "string") {
    throw new Error("TikTok file resolver did not return one exact video path");
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
    if (!before.isFile() || before.size < 24 || before.size > MAX_TIKTOK_VIDEO_BYTES) {
      throw new Error(
        "TikTok video must be a regular MP4 no larger than the 128 MiB in-memory publish limit",
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
    ) throw new Error("TikTok video changed while it was materialized");
    const bytes = new Uint8Array(fileBytes);
    const metadata = tiktokMp4Metadata(bytes, "TikTok video");
    const mediaSha256 = tikTokVideoSha256(bytes);
    return Object.freeze({
      allowAiRemix,
      allowComments,
      allowContentReuse,
      allowDuet,
      allowStitch,
      audience,
      bytes,
      byteLength: bytes.byteLength,
      caption,
      commercialContent: "none",
      containsSyntheticMedia,
      durationSeconds: metadata.durationSeconds,
      height: metadata.height,
      mediaType: "video/mp4",
      mediaSha256,
      width: metadata.width,
    });
  } finally {
    await handle.close();
  }
}

/**
 * Rebind and snapshot a materialized MP4 immediately before a future
 * dispatch. The capture-required operation does not call this helper and this
 * checkpoint deliberately contains no route, signer, credential, or target.
 */
export function revalidateTikTokVideoPublishBindingForDispatch(
  value: unknown,
): TikTokVideoPublishDispatchSnapshot {
  const binding = exactTikTokVideoBinding(value);
  const bytes = snapshotTikTokVideoBytes(binding.bytes);
  const metadata = tiktokMp4Metadata(bytes, "TikTok video binding");
  const mediaSha256 = tikTokVideoSha256(bytes);
  if (
    !Number.isSafeInteger(binding.byteLength)
    || binding.byteLength !== bytes.byteLength
    || typeof binding.mediaSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(binding.mediaSha256)
    || binding.mediaSha256 !== mediaSha256
    || binding.durationSeconds !== metadata.durationSeconds
    || binding.height !== metadata.height
    || binding.width !== metadata.width
  ) throw new Error("TikTok video binding changed from its exact bytes");

  const audience = binding.audience;
  if (
    (audience !== "public" && audience !== "friends" && audience !== "private")
    || binding.commercialContent !== "none"
    || binding.mediaType !== "video/mp4"
  ) throw new Error("TikTok video binding creator declarations are invalid");
  const allowAiRemix = exactTikTokCreatorBoolean(binding, "allowAiRemix");
  const allowComments = exactTikTokCreatorBoolean(binding, "allowComments");
  const allowContentReuse = exactTikTokCreatorBoolean(binding, "allowContentReuse");
  const allowDuet = exactTikTokCreatorBoolean(binding, "allowDuet");
  const allowStitch = exactTikTokCreatorBoolean(binding, "allowStitch");
  const containsSyntheticMedia = exactTikTokCreatorBoolean(
    binding,
    "containsSyntheticMedia",
  );
  const caption = binding.caption === null
    ? null
    : boundedInputText(binding.caption, "TikTok video binding caption", 500);
  const body = new Blob([bytes], { type: "video/mp4" });
  if (body.size !== bytes.byteLength || body.type !== "video/mp4") {
    throw new Error("TikTok video dispatch snapshot changed shape");
  }
  return Object.freeze({
    allowAiRemix,
    allowComments,
    allowContentReuse,
    allowDuet,
    allowStitch,
    audience,
    body,
    byteLength: bytes.byteLength,
    caption,
    commercialContent: "none" as const,
    containsSyntheticMedia,
    durationSeconds: metadata.durationSeconds,
    height: metadata.height,
    mediaSha256,
    mediaType: "video/mp4" as const,
    width: metadata.width,
  });
}

export function prepareTikTokPublishedPostDeleteInput(
  input: OperationInput,
): TikTokPublishedPostDeleteInput {
  exactInputKeys(
    input,
    ["post_id", "expected_caption"],
    [],
    "TikTok authored-post deletion",
  );
  const postId = input.post_id;
  if (typeof postId !== "string" || !/^[0-9]{1,32}$/u.test(postId)) {
    throw new Error("input.post_id must be an exact decimal TikTok post ID");
  }
  return Object.freeze({
    expectedCaption: boundedInputText(
      input.expected_caption,
      "input.expected_caption",
      500,
    ),
    postId,
  });
}

function isTikTokOperation(value: string): value is TikTokWebOperationName {
  return (TIKTOK_WEB_OPERATION_NAMES as readonly string[]).includes(value);
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

function stringInput(input: OperationInput, name: string, pattern: RegExp, label: string): string {
  const value = input[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`input.${name} must be ${label}`);
  return value;
}

function exactReadHeaders(referer: "https://www.tiktok.com/" | "https://www.tiktok.com/foryou"): Readonly<Record<string, string>> {
  return enforceTikTokWebHeaderSinkPolicy({
    source: "code",
    sink: "network-request",
    headers: {
      accept: "application/json, text/plain, */*",
      referer,
    },
  });
}

async function currentViewer(
  client: WebSessionClient,
  maximumBytes = MAX_VIEWER_BYTES,
): Promise<TikTokWebViewer> {
  const url = new URL("/api/user/detail/self/", TIKTOK_ORIGIN);
  authorizeTikTokWebR1Request({
    operation: "viewer.current",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders("https://www.tiktok.com/"),
    maxBytes: Math.min(maximumBytes, MAX_VIEWER_BYTES),
  });
  return parseTikTokWebViewerResponse(response);
}

async function currentProfile(
  client: WebSessionClient,
  maximumBytes = MAX_VIEWER_BYTES,
): Promise<TikTokWebProfile> {
  const url = new URL("/api/user/detail/self/", TIKTOK_ORIGIN);
  authorizeTikTokWebR1Request({
    operation: "profiles.current",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders("https://www.tiktok.com/"),
    maxBytes: Math.min(maximumBytes, MAX_VIEWER_BYTES),
  });
  return parseTikTokWebProfileResponse(response);
}

function viewerSubject(viewer: TikTokWebViewer): string {
  return `tiktok:uid:${viewer.id}/sec:${viewer.secUid}`;
}

export async function probeTikTokWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: TikTokWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const client = await createWebSessionClient(TIKTOK_ORIGIN, auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await currentViewer(client);
  return viewerSubject(viewer);
}

async function requireBoundViewer(
  client: WebSessionClient,
  auth: WrenchAuth,
): Promise<TikTokWebViewer> {
  const viewer = await currentViewer(client);
  assertBoundViewer(auth, viewer);
  return viewer;
}

function assertBoundViewer(auth: WrenchAuth, viewer: TikTokWebViewer): void {
  const expected = webSessionAuthSubject(auth);
  if (expected === null || !/^tiktok:uid:[0-9]{1,32}\/sec:[A-Za-z0-9._-]{16,256}$/u.test(expected)) {
    throw new Error("TikTok personalized operations require an auth locator bound to the exact viewer subject");
  }
  if (viewerSubject(viewer) !== expected) {
    throw new Error("TikTok browser session viewer no longer matches the confirmed auth subject");
  }
}

function profileInput(input: OperationInput): string {
  const profile = input.profile;
  if (typeof profile !== "string" || !/^[A-Za-z0-9._]{2,24}$/u.test(profile)) {
    throw new Error("input.profile must be an exact TikTok handle without @");
  }
  return profile;
}

function observedAt(dependencies: TikTokWebRuntimeDependencies | undefined): string {
  const now = dependencies?.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    throw new Error("TikTok profile observation time is invalid");
  }
  return new Date(now).toISOString();
}

function exactCount(value: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: "available",
    value,
    precision: "exact",
    unit: "count",
  });
}

async function readProfile(
  client: WebSessionClient,
  input: OperationInput,
  auth: WrenchAuth,
  dependencies: TikTokWebRuntimeDependencies | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  const requestedProfile = profileInput(input);
  const profile = await currentProfile(client);
  assertBoundViewer(auth, profile);
  if (profile.handle.toLocaleLowerCase("en-US") !== requestedProfile.toLocaleLowerCase("en-US")) {
    throw new Error("TikTok requested profile did not match the bound current account");
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: "tiktok",
    target: Object.freeze({
      kind: "profile",
      id: profile.handle,
      url: `${TIKTOK_ORIGIN}/@${encodeURIComponent(profile.handle)}`,
    }),
    observedAt: observedAt(dependencies),
    completeness: "complete",
    metrics: Object.freeze({
      followers: exactCount(profile.followers),
      following: exactCount(profile.following),
      likes: exactCount(profile.likes),
    }),
    metadata: Object.freeze({
      handle: profile.handle,
      displayName: profile.displayName,
      ...(profile.bio === null ? {} : { bio: profile.bio }),
      ...(profile.websiteUrl === null ? {} : { websiteUrl: profile.websiteUrl }),
    }),
  });
}

async function readForYou(
  client: WebSessionClient,
  input: OperationInput,
  maximumBytes: number,
): Promise<unknown> {
  if (input.feed !== "for-you") {
    throw new Error("input.feed must be the observed signer-free for-you feed");
  }
  const limit = integerInput(input, "limit", DEFAULT_FEED_LIMIT, 1, 30);
  const url = new URL("/api/recommend/item_list/", TIKTOK_ORIGIN);
  url.searchParams.set("aid", "1988");
  url.searchParams.set("count", String(limit));
  authorizeTikTokWebR1Request({
    operation: "feeds.for-you",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders("https://www.tiktok.com/foryou"),
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
  return normalizeTikTokWebFeedResponse(response, limit);
}

async function readComments(
  client: WebSessionClient,
  input: OperationInput,
  maximumBytes: number,
): Promise<unknown> {
  const postId = stringInput(input, "post_id", /^[0-9]{1,32}$/u, "a decimal TikTok post ID");
  const cursor = integerInput(input, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integerInput(input, "limit", DEFAULT_COMMENT_LIMIT, 1, 50);
  const url = new URL("/api/comment/list/", TIKTOK_ORIGIN);
  url.searchParams.set("aid", "1988");
  url.searchParams.set("aweme_id", postId);
  url.searchParams.set("count", String(limit));
  url.searchParams.set("cursor", String(cursor));
  authorizeTikTokWebR1Request({
    operation: "comments.list",
    url,
    method: "GET",
  });
  const response = await client.requestJson({
    url,
    method: "GET",
    headers: exactReadHeaders("https://www.tiktok.com/foryou"),
    maxBytes: Math.min(maximumBytes, MAX_READ_BYTES),
  });
  return normalizeTikTokWebCommentsResponse(response, postId, limit);
}

export async function executeTikTokWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: TikTokWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (recipe.site !== "tiktok" || !isTikTokOperation(recipe.action)) {
    throw new Error("TikTok authenticated web recipe is not installed");
  }
  const contract = TIKTOK_WEB_OPERATIONS[recipe.action];
  const contractVersion = "contractVersion" in contract ? contract.contractVersion : 1;
  if (recipe.contractVersion !== contractVersion) {
    throw new Error("TikTok authenticated web recipe is not installed");
  }
  if (contract.state !== "observed") {
    throw new Error(`TikTok authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`);
  }
  if (
    recipe.action !== "profiles.read"
    && recipe.action !== "feeds.read"
    && recipe.action !== "comments.read"
  ) {
    throw new Error(`TikTok authenticated web operation ${recipe.action} has no executable reviewed contract`);
  }
  // R1 operations never enter a dispatch ledger or invoke mutation callbacks.
  void options.beforeDispatch;
  void options.afterDispatchVerified;
  let client: WebSessionClient;
  try {
    client = await createWebSessionClient(TIKTOK_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    });
  } catch (error) {
    if (recipe.action !== "profiles.read") throw error;
    return failedProviderRead(
      "TikTok profile",
      error,
      `${TIKTOK_ORIGIN}/@${encodeURIComponent(profileInput(input))}`,
      { stage: "bootstrap", authenticated: true },
    );
  }
  if (recipe.action === "profiles.read") {
    const finalUrl = `${TIKTOK_ORIGIN}/@${encodeURIComponent(profileInput(input))}`;
    try {
      const output = await readProfile(client, input, auth, options.dependencies);
      return {
        status: "succeeded",
        output,
        finalUrl,
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
      };
    } catch (error) {
      return failedProviderRead("TikTok profile", error, finalUrl, {
        stage: "identity",
        authenticated: true,
        accountMismatch: (candidate) => candidate.message.includes("no longer matches")
          || candidate.message.includes("did not match the bound current account"),
        authRepairRequired: (candidate) => candidate.message.includes("auth locator bound"),
      });
    }
  }
  const output = await (async () => {
    await requireBoundViewer(client, auth);
    return recipe.action === "feeds.read"
      ? readForYou(client, input, recipe.maxOutputBytes)
      : readComments(client, input, recipe.maxOutputBytes);
  })();
  return {
    status: "succeeded",
    output,
    finalUrl: recipe.action === "feeds.read"
      ? `${TIKTOK_ORIGIN}/foryou`
      : TIKTOK_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
