import { Blob } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { types as nodeTypes } from "node:util";

import type { BrowserFileResolver } from "../browser";
import { canonicalJson } from "../canonical-json";
import type { FileInputValue, OperationInput } from "../model";
import type { WebSessionOperationDeadline } from "../web-session-execution";
import { isoBmffVideoDimensions } from "./iso-bmff";

const MAX_INSTAGRAM_VIDEO_BYTES = 128 * 1024 * 1024;
const INSTAGRAM_MEDIA_ID_PATTERN = /^[1-9][0-9]{0,31}(?:_[1-9][0-9]{0,31})?$/u;
const INSTAGRAM_SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const INSTAGRAM_VIEWER_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const INSTAGRAM_VIDEO_PUBLISH_BINDING_KEYS = Object.freeze([
  "audience",
  "byteLength",
  "bytes",
  "caption",
  "height",
  "mediaSha256",
  "mediaType",
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
const MP4_COMPATIBLE_BRANDS = Object.freeze(new Set([
  "M4V ",
  "MSNV",
  "avc1",
  "iso2",
  "isom",
  "mp41",
  "mp42",
]));

export type InstagramVideoPublishPlan = Readonly<{
  audience: "default";
  caption: string;
  media: FileInputValue;
}>;

export type InstagramBoundVideoPublish = Readonly<{
  audience: "default";
  bytes: Uint8Array<ArrayBuffer>;
  byteLength: number;
  caption: string;
  height: number;
  mediaType: "video/mp4";
  mediaSha256: string;
  width: number;
}>;

export type InstagramVideoPublishDispatchSnapshot = Readonly<{
  audience: "default";
  body: Blob;
  byteLength: number;
  caption: string;
  height: number;
  mediaType: "video/mp4";
  mediaSha256: string;
  width: number;
}>;

export type InstagramAuthoredPostDeleteInput = Readonly<{
  expectedCaption: string;
  expectedMediaKind: "video";
  mediaId: string;
}>;

export type InstagramVideoAcceptedTarget = Readonly<{
  code: string;
  mediaId: string;
  url: string;
}>;

export type InstagramVideoReadbackExpectation = Readonly<{
  expectedCaption: string;
  expectedCode?: string;
  mediaId: string;
  viewerId: string;
}>;

/**
 * The successful low-stakes fixture proves the semantic lifecycle and exact
 * target readbacks. These are the only transport facts intentionally left
 * unresolved; neither mutation may execute while any fact remains masked.
 */
export const INSTAGRAM_VIDEO_CAPTURE_BLOCKERS = Object.freeze({
  "content.delete": "exact delete route segment and fourth response field name",
  "media.publish": "exact Comet form-field and header closure",
} as const);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactInputKeys(
  input: OperationInput,
  required: readonly string[],
  label: string,
): void {
  const permitted = new Set(required);
  if (Object.keys(input).some((key) => !permitted.has(key))) {
    throw new Error(`${label} contained an unsupported input field`);
  }
  if (required.some((key) => !Object.hasOwn(input, key))) {
    throw new Error(`${label} omitted a required input field`);
  }
}

function boundedCaption(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_000
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be 1 to 1000 bounded UTF-16 code units`);
  return value;
}

function instagramMediaId(value: unknown, label: string): string {
  if (typeof value !== "string" || !INSTAGRAM_MEDIA_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be one exact canonical Instagram media ID`);
  }
  return value;
}

function instagramShortcode(value: unknown, label: string): string {
  if (typeof value !== "string" || !INSTAGRAM_SHORTCODE_PATTERN.test(value)) {
    throw new Error(`${label} must be one exact Instagram shortcode`);
  }
  return value;
}

function instagramVideoPermalink(code: string): string {
  return `${INSTAGRAM_ORIGIN}/p/${code}/`;
}

function exactNormalizedKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} changed its bounded normalized shape`);
  }
}

function exactInstagramVideoPublishBinding(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
  ) throw new Error("Instagram video binding must be one exact object");
  if (nodeTypes.isProxy(value)) {
    throw new Error("Instagram video binding must not be a proxy");
  }
  if (Array.isArray(value)) {
    throw new Error("Instagram video binding must be one exact object");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Instagram video binding must use a plain prototype");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== INSTAGRAM_VIDEO_PUBLISH_BINDING_KEYS.length
    || ownKeys.some((key) => typeof key !== "string")
    || (ownKeys as string[]).sort().join(",")
      !== [...INSTAGRAM_VIDEO_PUBLISH_BINDING_KEYS].sort().join(",")
  ) throw new Error("Instagram video binding contained unsupported fields");
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of INSTAGRAM_VIDEO_PUBLISH_BINDING_KEYS) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new Error(
        "Instagram video binding must contain only enumerable data properties",
      );
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotInstagramVideoBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "object"
    || value === null
    || nodeTypes.isProxy(value)
    || !(value instanceof Uint8Array)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || TYPED_ARRAY_BUFFER_GETTER === undefined
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) throw new Error("Instagram video binding must contain one bounded MP4");
  let buffer: unknown;
  let byteLength: unknown;
  try {
    buffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
  } catch {
    throw new Error("Instagram video binding must contain one bounded MP4");
  }
  if (
    typeof byteLength !== "number"
    || !Number.isSafeInteger(byteLength)
    || byteLength < 24
    || byteLength > MAX_INSTAGRAM_VIDEO_BYTES
    || nodeTypes.isSharedArrayBuffer(buffer)
  ) throw new Error("Instagram video binding must contain one bounded MP4");
  const bytes = new Uint8Array(byteLength);
  try {
    Uint8Array.prototype.set.call(bytes, value);
  } catch {
    throw new Error("Instagram video binding must contain one bounded MP4");
  }
  return bytes;
}

function planBoundFile(value: unknown): FileInputValue {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "kind,reference"
    || value.kind !== "file"
    || typeof value.reference !== "string"
    || value.reference.length < 1
    || value.reference.length > 4_096
    || /[\0\r\n]/u.test(value.reference)
  ) throw new Error("input.media must be one exact plan-bound file");
  return Object.freeze({ kind: "file", reference: value.reference });
}

function requireMp4FileType(bytes: Uint8Array): void {
  if (bytes.byteLength < 24) {
    throw new Error("Instagram video must be one complete MP4 file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileTypeBytes = view.getUint32(0);
  if (
    fileTypeBytes < 16
    || fileTypeBytes > bytes.byteLength
    || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp"
    || (fileTypeBytes - 16) % 4 !== 0
  ) throw new Error("Instagram video must begin with one bounded MP4 file-type box");
  const majorBrand = String.fromCharCode(...bytes.subarray(8, 12));
  if (majorBrand === "qt  ") {
    throw new Error("Instagram video file-type box is not MP4-compatible");
  }
  const brands: string[] = [];
  for (let offset = 8; offset < fileTypeBytes; offset += offset === 8 ? 8 : 4) {
    brands.push(String.fromCharCode(...bytes.subarray(offset, offset + 4)));
  }
  if (!brands.some((brand) => MP4_COMPATIBLE_BRANDS.has(brand))) {
    throw new Error("Instagram video file-type box is not MP4-compatible");
  }
}

function instagramVideoSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function instagramVideoMetadata(bytes: Uint8Array): Readonly<{
  height: number;
  width: number;
}> {
  requireMp4FileType(bytes);
  return isoBmffVideoDimensions(bytes, "Instagram video");
}

/**
 * Validate the complete capture-neutral publication plan before any attachment
 * path is resolved. Consumer-web request fields remain intentionally absent.
 */
export function prepareInstagramVideoPublishInput(
  input: OperationInput,
): InstagramVideoPublishPlan {
  exactInputKeys(
    input,
    ["audience", "caption", "media"],
    "Instagram video publishing",
  );
  if (input.audience !== "default") {
    throw new Error("input.audience must be the exact default Instagram audience");
  }
  return Object.freeze({
    audience: "default" as const,
    caption: boundedCaption(input.caption, "input.caption"),
    media: planBoundFile(input.media),
  });
}

/**
 * Resolve and bind one exact stable MP4. This local preflight performs no
 * authenticated request and supplies no consumer-web upload implementation.
 */
export async function materializeInstagramVideoPublishInput(
  input: OperationInput,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<InstagramBoundVideoPublish> {
  const plan = prepareInstagramVideoPublishInput(input);
  if (fileResolver === undefined) {
    throw new Error("Instagram video upload requires the plan-bound file resolver");
  }
  const resolve = () => fileResolver([plan.media]);
  const paths = operationDeadline === undefined
    ? await resolve()
    : await operationDeadline.run(resolve, "authenticated web operation deadline");
  operationDeadline?.throwIfUnavailable("authenticated web operation deadline");
  if (paths.length !== 1 || typeof paths[0] !== "string") {
    throw new Error("Instagram file resolver did not return one exact video path");
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
      || before.size > MAX_INSTAGRAM_VIDEO_BYTES
    ) {
      throw new Error(
        "Instagram video must be a regular MP4 no larger than the 128 MiB in-memory publish limit",
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
    ) throw new Error("Instagram video changed while it was materialized");
    const bytes = new Uint8Array(fileBytes);
    const dimensions = instagramVideoMetadata(bytes);
    return Object.freeze({
      audience: plan.audience,
      bytes,
      byteLength: bytes.byteLength,
      caption: plan.caption,
      height: dimensions.height,
      mediaType: "video/mp4" as const,
      mediaSha256: instagramVideoSha256(bytes),
      width: dimensions.width,
    });
  } finally {
    await handle.close();
  }
}

/**
 * Revalidate and snapshot the exact materialized MP4 immediately before a
 * future dispatch. The capture-required operation does not call this helper.
 */
export function revalidateInstagramVideoPublishBindingForDispatch(
  value: unknown,
): InstagramVideoPublishDispatchSnapshot {
  const binding = exactInstagramVideoPublishBinding(value);
  const bytes = snapshotInstagramVideoBytes(binding.bytes);
  const dimensions = instagramVideoMetadata(bytes);
  const mediaSha256 = instagramVideoSha256(bytes);
  if (
    !Number.isSafeInteger(binding.byteLength)
    || binding.byteLength !== bytes.byteLength
    || typeof binding.mediaSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(binding.mediaSha256)
    || binding.mediaSha256 !== mediaSha256
    || binding.height !== dimensions.height
    || binding.width !== dimensions.width
  ) throw new Error("Instagram video binding changed from its exact bytes");
  if (binding.audience !== "default" || binding.mediaType !== "video/mp4") {
    throw new Error("Instagram video binding declarations are invalid");
  }
  const body = new Blob([bytes], { type: "video/mp4" });
  if (body.size !== bytes.byteLength || body.type !== "video/mp4") {
    throw new Error("Instagram video dispatch snapshot changed shape");
  }
  return Object.freeze({
    audience: "default" as const,
    body,
    byteLength: bytes.byteLength,
    caption: boundedCaption(binding.caption, "Instagram video binding caption"),
    height: dimensions.height,
    mediaSha256,
    mediaType: "video/mp4" as const,
    width: dimensions.width,
  });
}

/** Validate the exact authored-video confirmation required before deletion. */
export function prepareInstagramAuthoredPostDeleteInput(
  input: OperationInput,
): InstagramAuthoredPostDeleteInput {
  exactInputKeys(
    input,
    ["expected_caption", "expected_media_kind", "media_id"],
    "Instagram authored-post deletion",
  );
  if (
    typeof input.media_id !== "string"
    || !INSTAGRAM_MEDIA_ID_PATTERN.test(input.media_id)
  ) throw new Error("input.media_id must be one exact canonical Instagram media ID");
  if (input.expected_media_kind !== "video") {
    throw new Error("input.expected_media_kind must be video");
  }
  return Object.freeze({
    expectedCaption: boundedCaption(input.expected_caption, "input.expected_caption"),
    expectedMediaKind: "video" as const,
    mediaId: input.media_id,
  });
}

/**
 * Bind the already-bounded `posts.read` projection to one exact authored video.
 * The shortcode is provider-derived here and is never accepted as delete input.
 */
export function bindInstagramVideoMediaReadback(
  value: unknown,
  expectation: InstagramVideoReadbackExpectation,
): InstagramVideoAcceptedTarget {
  const expectedMediaId = instagramMediaId(
    expectation.mediaId,
    "Instagram video readback expected media ID",
  );
  const expectedCaption = boundedCaption(
    expectation.expectedCaption,
    "Instagram video readback expected caption",
  );
  if (
    typeof expectation.viewerId !== "string"
    || !INSTAGRAM_VIEWER_ID_PATTERN.test(expectation.viewerId)
  ) throw new Error("Instagram video readback expected viewer ID is invalid");
  const expectedCode = expectation.expectedCode === undefined
    ? undefined
    : instagramShortcode(
        expectation.expectedCode,
        "Instagram video readback expected shortcode",
      );
  if (!isRecord(value)) {
    throw new Error("Instagram video readback must be one bounded media projection");
  }
  exactNormalizedKeys(value, [
    "caption",
    "code",
    "comment_count",
    "has_liked",
    "has_viewer_saved",
    "id",
    "like_count",
    "media_type",
    "pk",
    "taken_at",
    "user",
  ], "Instagram video readback");
  const mediaId = instagramMediaId(value.id, "Instagram video readback media ID");
  const code = instagramShortcode(value.code, "Instagram video readback shortcode");
  if (
    mediaId !== expectedMediaId
    || value.caption !== expectedCaption
    || value.media_type !== 2
    || (expectedCode !== undefined && code !== expectedCode)
  ) throw new Error("Instagram video readback did not bind the confirmed video");
  if (!isRecord(value.user)) {
    throw new Error("Instagram video readback did not bind the confirmed actor");
  }
  exactNormalizedKeys(
    value.user,
    ["full_name", "id", "username"],
    "Instagram video readback actor",
  );
  if (value.user.id !== expectation.viewerId) {
    throw new Error("Instagram video readback did not bind the confirmed actor");
  }
  return Object.freeze({
    code,
    mediaId,
    url: instagramVideoPermalink(code),
  });
}

function parseInstagramVideoPermalink(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new Error("Instagram provider-accepted video target returned an invalid permalink");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Instagram provider-accepted video target returned an invalid permalink");
  }
  if (
    url.origin !== INSTAGRAM_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== `/p/${code}/`
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("Instagram provider-accepted video target returned an invalid permalink");
  return url.href;
}

/** Serialize only provider-derived, secret-free target identity. */
export function instagramVideoAcceptedTargetIdentifier(
  target: InstagramVideoAcceptedTarget,
): string {
  const mediaId = instagramMediaId(
    target.mediaId,
    "Instagram provider-accepted video target media ID",
  );
  const code = instagramShortcode(
    target.code,
    "Instagram provider-accepted video target shortcode",
  );
  const url = parseInstagramVideoPermalink(target.url, code);
  return canonicalJson({ code, mediaId, url });
}

/** Parse the exact encrypted target later supplied to read-only reconciliation. */
export function parseInstagramVideoAcceptedTargetIdentifier(
  identifier: string,
): InstagramVideoAcceptedTarget {
  if (typeof identifier !== "string" || identifier.length < 1 || identifier.length > 4_096) {
    throw new Error("Instagram provider-accepted video target is not canonical JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(identifier);
  } catch {
    throw new Error("Instagram provider-accepted video target is not canonical JSON");
  }
  if (!isRecord(value)) {
    throw new Error("Instagram provider-accepted video target contained unsupported fields");
  }
  exactNormalizedKeys(
    value,
    ["code", "mediaId", "url"],
    "Instagram provider-accepted video target",
  );
  const target = Object.freeze({
    code: instagramShortcode(
      value.code,
      "Instagram provider-accepted video target shortcode",
    ),
    mediaId: instagramMediaId(
      value.mediaId,
      "Instagram provider-accepted video target media ID",
    ),
    url: "",
  });
  const parsed = Object.freeze({
    code: target.code,
    mediaId: target.mediaId,
    url: parseInstagramVideoPermalink(value.url, target.code),
  });
  if (canonicalJson(parsed) !== identifier) {
    throw new Error("Instagram provider-accepted video target is not canonical");
  }
  return parsed;
}
