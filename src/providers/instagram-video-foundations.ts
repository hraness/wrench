import { Blob } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { types as nodeTypes } from "node:util";

import type { BrowserFileResolver } from "../browser";
import { canonicalJson } from "../canonical-json";
import type { FileInputValue, OperationInput } from "../model";
import type { WebSessionOperationDeadline } from "../web-session-execution";
import {
  isoBmffMp4VideoMetadata,
  isoBmffVideoDimensions,
} from "./iso-bmff";

const MAX_INSTAGRAM_VIDEO_BYTES = 128 * 1024 * 1024;
const MAX_INSTAGRAM_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const INSTAGRAM_MEDIA_ID_PATTERN = /^[1-9][0-9]{0,31}(?:_[1-9][0-9]{0,31})?$/u;
const INSTAGRAM_SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const INSTAGRAM_VIEWER_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const INSTAGRAM_VIDEO_PUBLISH_BINDING_KEYS = Object.freeze([
  "audience",
  "byteLength",
  "bytes",
  "caption",
  "durationMilliseconds",
  "height",
  "mediaSha256",
  "mediaType",
  "thumbnailByteLength",
  "thumbnailBytes",
  "thumbnailHeight",
  "thumbnailMediaType",
  "thumbnailSha256",
  "thumbnailWidth",
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
  thumbnail: FileInputValue;
}>;

export type InstagramBoundVideoPublish = Readonly<{
  audience: "default";
  bytes: Uint8Array<ArrayBuffer>;
  byteLength: number;
  caption: string;
  durationMilliseconds: number;
  height: number;
  mediaType: "video/mp4";
  mediaSha256: string;
  thumbnailByteLength: number;
  thumbnailBytes: Uint8Array<ArrayBuffer>;
  thumbnailHeight: number;
  thumbnailMediaType: "image/jpeg";
  thumbnailSha256: string;
  thumbnailWidth: number;
  width: number;
}>;

export type InstagramVideoPublishDispatchSnapshot = Readonly<{
  audience: "default";
  body: Blob;
  byteLength: number;
  caption: string;
  durationMilliseconds: number;
  height: number;
  mediaType: "video/mp4";
  mediaSha256: string;
  thumbnailBody: Blob;
  thumbnailByteLength: number;
  thumbnailHeight: number;
  thumbnailMediaType: "image/jpeg";
  thumbnailSha256: string;
  thumbnailWidth: number;
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

export type InstagramVideoConfigureExpectation = Readonly<{
  caption: string;
  uploadId: string;
  viewerId: string;
}>;

/** Exact remaining boundary after the authorized disposable lifecycle. */
export const INSTAGRAM_VIDEO_CAPTURE_BLOCKERS = Object.freeze({
  "media.publish":
    "the observed first configure response was 202 without an accepted target; neither a safe repeated configure POST nor an independent upload-ID reconciliation read is proven",
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

function boundedForeignRecord(
  value: unknown,
  label: string,
  maximumKeys: number,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length > maximumKeys) {
    throw new Error(`${label} must be one bounded object`);
  }
  return value;
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

function snapshotInstagramBytes(
  value: unknown,
  maximumBytes: number,
  label: "MP4" | "JPEG thumbnail",
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "object"
    || value === null
    || nodeTypes.isProxy(value)
    || !(value instanceof Uint8Array)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || TYPED_ARRAY_BUFFER_GETTER === undefined
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) throw new Error(`Instagram video binding must contain one bounded ${label}`);
  let buffer: unknown;
  let byteLength: unknown;
  try {
    buffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
  } catch {
    throw new Error(`Instagram video binding must contain one bounded ${label}`);
  }
  if (
    typeof byteLength !== "number"
    || !Number.isSafeInteger(byteLength)
    || byteLength < (label === "MP4" ? 24 : 16)
    || byteLength > maximumBytes
    || nodeTypes.isSharedArrayBuffer(buffer)
  ) throw new Error(`Instagram video binding must contain one bounded ${label}`);
  const bytes = new Uint8Array(byteLength);
  try {
    Uint8Array.prototype.set.call(bytes, value);
  } catch {
    throw new Error(`Instagram video binding must contain one bounded ${label}`);
  }
  return bytes;
}

function instagramJpegDimensions(bytes: Uint8Array): Readonly<{
  height: number;
  width: number;
}> {
  if (
    bytes.byteLength < 16
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff
    || bytes.at(-1) !== 0xd9
  ) throw new Error("Instagram video thumbnail must be one complete JPEG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let frame: Readonly<{ height: number; width: number }> | null = null;
  while (offset < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) {
      throw new Error("Instagram video thumbnail JPEG marker stream changed shape");
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00) {
      throw new Error("Instagram video thumbnail JPEG marker stream changed shape");
    }
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      if (frame === null) {
        throw new Error("Instagram video thumbnail JPEG omitted its frame dimensions");
      }
      return frame;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.byteLength) {
      throw new Error("Instagram video thumbnail JPEG segment exceeded its bytes");
    }
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength) {
      throw new Error("Instagram video thumbnail JPEG segment exceeded its bytes");
    }
    if (frameMarkers.has(marker)) {
      if (frame !== null || length < 8 || bytes[offset + 2] !== 8) {
        throw new Error("Instagram video thumbnail JPEG frame changed shape");
      }
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      if (height < 1 || height > 20_000 || width < 1 || width > 20_000) {
        throw new Error("Instagram video thumbnail JPEG dimensions are outside the reviewed bound");
      }
      frame = Object.freeze({ height, width });
    }
    offset += length;
  }
  if (frame === null) {
    throw new Error("Instagram video thumbnail JPEG omitted its frame dimensions");
  }
  return frame;
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
  durationMilliseconds: number;
  height: number;
  width: number;
}> {
  requireMp4FileType(bytes);
  const dimensions = isoBmffVideoDimensions(bytes, "Instagram video");
  const metadata = isoBmffMp4VideoMetadata(
    bytes,
    "Instagram video",
    Object.freeze({
      compatibleBrands: Object.freeze([...MP4_COMPATIBLE_BRANDS]),
      rejectedMajorBrands: Object.freeze(["qt  "]),
    }),
  );
  const durationMilliseconds = Math.floor(metadata.durationSeconds * 1_000);
  if (
    metadata.durationSeconds < 0.001
    || metadata.durationSeconds > 86_400
    || !Number.isSafeInteger(durationMilliseconds)
    || durationMilliseconds < 1
    || durationMilliseconds > 86_400_000
    || metadata.height !== dimensions.height
    || metadata.width !== dimensions.width
  ) throw new Error("Instagram video duration is outside the reviewed bound");
  return Object.freeze({ durationMilliseconds, ...dimensions });
}

async function stableInstagramPublishFile(
  path: string,
  maximumBytes: number,
  label: "video" | "video thumbnail",
  operationDeadline?: WebSessionOperationDeadline,
): Promise<Uint8Array<ArrayBuffer>> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = operationDeadline === undefined
    ? await open(path, constants.O_RDONLY | noFollow)
    : await operationDeadline.run(
        () => open(path, constants.O_RDONLY | noFollow),
        "authenticated web operation deadline",
      );
  try {
    const before = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (!before.isFile() || before.size < 16 || before.size > maximumBytes) {
      throw new Error(
        `Instagram ${label} must be a regular file within its reviewed in-memory bound`,
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
    ) throw new Error(`Instagram ${label} changed while it was materialized`);
    return new Uint8Array(fileBytes);
  } finally {
    await handle.close();
  }
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
    ["audience", "caption", "media", "thumbnail"],
    "Instagram video publishing",
  );
  if (input.audience !== "default") {
    throw new Error("input.audience must be the exact default Instagram audience");
  }
  return Object.freeze({
    audience: "default" as const,
    caption: boundedCaption(input.caption, "input.caption"),
    media: planBoundFile(input.media),
    thumbnail: planBoundFile(input.thumbnail),
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
  const resolve = () => fileResolver([plan.media, plan.thumbnail]);
  const paths = operationDeadline === undefined
    ? await resolve()
    : await operationDeadline.run(resolve, "authenticated web operation deadline");
  operationDeadline?.throwIfUnavailable("authenticated web operation deadline");
  if (
    paths.length !== 2
    || typeof paths[0] !== "string"
    || typeof paths[1] !== "string"
  ) {
    throw new Error(
      "Instagram file resolver did not return the exact video and JPEG thumbnail paths",
    );
  }
  const bytes = await stableInstagramPublishFile(
    paths[0],
    MAX_INSTAGRAM_VIDEO_BYTES,
    "video",
    operationDeadline,
  );
  const dimensions = instagramVideoMetadata(bytes);
  const thumbnailBytes = await stableInstagramPublishFile(
    paths[1],
    MAX_INSTAGRAM_THUMBNAIL_BYTES,
    "video thumbnail",
    operationDeadline,
  );
  const thumbnailDimensions = instagramJpegDimensions(thumbnailBytes);
  return Object.freeze({
    audience: plan.audience,
    bytes,
    byteLength: bytes.byteLength,
    caption: plan.caption,
    durationMilliseconds: dimensions.durationMilliseconds,
    height: dimensions.height,
    mediaType: "video/mp4" as const,
    mediaSha256: instagramVideoSha256(bytes),
    thumbnailByteLength: thumbnailBytes.byteLength,
    thumbnailBytes,
    thumbnailHeight: thumbnailDimensions.height,
    thumbnailMediaType: "image/jpeg" as const,
    thumbnailSha256: instagramVideoSha256(thumbnailBytes),
    thumbnailWidth: thumbnailDimensions.width,
    width: dimensions.width,
  });
}

/**
 * Revalidate and snapshot the exact materialized MP4 immediately before a
 * future dispatch. The capture-required operation does not call this helper.
 */
export function revalidateInstagramVideoPublishBindingForDispatch(
  value: unknown,
): InstagramVideoPublishDispatchSnapshot {
  const binding = exactInstagramVideoPublishBinding(value);
  const bytes = snapshotInstagramBytes(
    binding.bytes,
    MAX_INSTAGRAM_VIDEO_BYTES,
    "MP4",
  );
  const thumbnailBytes = snapshotInstagramBytes(
    binding.thumbnailBytes,
    MAX_INSTAGRAM_THUMBNAIL_BYTES,
    "JPEG thumbnail",
  );
  const dimensions = instagramVideoMetadata(bytes);
  const thumbnailDimensions = instagramJpegDimensions(thumbnailBytes);
  const mediaSha256 = instagramVideoSha256(bytes);
  const thumbnailSha256 = instagramVideoSha256(thumbnailBytes);
  if (
    !Number.isSafeInteger(binding.byteLength)
    || binding.byteLength !== bytes.byteLength
    || typeof binding.mediaSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(binding.mediaSha256)
    || binding.mediaSha256 !== mediaSha256
    || binding.durationMilliseconds !== dimensions.durationMilliseconds
    || binding.height !== dimensions.height
    || binding.width !== dimensions.width
    || !Number.isSafeInteger(binding.thumbnailByteLength)
    || binding.thumbnailByteLength !== thumbnailBytes.byteLength
    || typeof binding.thumbnailSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(binding.thumbnailSha256)
    || binding.thumbnailSha256 !== thumbnailSha256
    || binding.thumbnailHeight !== thumbnailDimensions.height
    || binding.thumbnailWidth !== thumbnailDimensions.width
  ) throw new Error("Instagram video binding changed from its exact bytes");
  if (
    binding.audience !== "default"
    || binding.mediaType !== "video/mp4"
    || binding.thumbnailMediaType !== "image/jpeg"
  ) {
    throw new Error("Instagram video binding declarations are invalid");
  }
  const body = new Blob([bytes], { type: "video/mp4" });
  const thumbnailBody = new Blob([thumbnailBytes], { type: "image/jpeg" });
  if (
    body.size !== bytes.byteLength
    || body.type !== "video/mp4"
    || thumbnailBody.size !== thumbnailBytes.byteLength
    || thumbnailBody.type !== "image/jpeg"
  ) {
    throw new Error("Instagram video dispatch snapshot changed shape");
  }
  return Object.freeze({
    audience: "default" as const,
    body,
    byteLength: bytes.byteLength,
    caption: boundedCaption(binding.caption, "Instagram video binding caption"),
    durationMilliseconds: dimensions.durationMilliseconds,
    height: dimensions.height,
    mediaSha256,
    mediaType: "video/mp4" as const,
    thumbnailBody,
    thumbnailByteLength: thumbnailBytes.byteLength,
    thumbnailHeight: thumbnailDimensions.height,
    thumbnailMediaType: "image/jpeg" as const,
    thumbnailSha256,
    thumbnailWidth: thumbnailDimensions.width,
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
    || !/^[1-9][0-9]{0,31}_[1-9][0-9]{0,31}$/u.test(input.media_id)
  ) throw new Error("input.media_id must be one exact full Instagram media ID");
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

/** Decode one provider-returned shortcode into its exact decimal media PK. */
export function instagramShortcodeMediaPk(value: unknown): string {
  const code = instagramShortcode(value, "Instagram video shortcode");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let decoded = 0n;
  for (const character of code) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Instagram video shortcode is invalid");
    decoded = (decoded * 64n) + BigInt(digit);
  }
  const pk = decoded.toString(10);
  if (decoded < 1n || !/^[1-9][0-9]{0,31}$/u.test(pk)) {
    throw new Error("Instagram video shortcode decoded outside the media-PK bound");
  }
  return pk;
}

/** Strict one-field acknowledgement observed for both Instagram ruploads. */
export function assertInstagramVideoUploadAcknowledgement(value: unknown): void {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "status"
    || value.status !== "ok"
  ) throw new Error("Instagram video upload acknowledgement changed shape");
}

/**
 * Validate the observed asynchronous configure response without authorizing a
 * second configure POST. The captured 202 body was exactly status+message.
 */
export function assertInstagramVideoConfigureIndeterminate(value: unknown): void {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "message,status"
    || value.status !== "fail"
    || typeof value.message !== "string"
    || value.message.length < 1
    || value.message.length > 2_048
    || /[\0\r]/u.test(value.message)
  ) throw new Error("Instagram video configure 202 envelope changed shape");
}

/**
 * Project the fixed public-bundle configure contract and bind every identifier
 * established by the live accepted response. Unknown raw media metadata stays
 * private and is not projected; the independent media-info GET remains the
 * authoritative actor/type/caption readback.
 */
export function parseInstagramVideoConfigureAccepted(
  value: unknown,
  expectation: InstagramVideoConfigureExpectation,
): InstagramVideoAcceptedTarget {
  const root = boundedForeignRecord(
    value,
    "Instagram video configure response",
    32,
  );
  const uploadId = instagramMediaId(
    expectation.uploadId,
    "Instagram video configure expected upload ID",
  );
  const viewerId = instagramMediaId(
    expectation.viewerId,
    "Instagram video configure expected viewer ID",
  );
  const caption = boundedCaption(
    expectation.caption,
    "Instagram video configure expected caption",
  );
  if (root.status !== "ok" || root.upload_id !== uploadId) {
    throw new Error("Instagram video configure response did not accept the exact upload");
  }
  const media = boundedForeignRecord(
    root.media,
    "Instagram video configure response.media",
    256,
  );
  const mediaId = instagramMediaId(
    media.id,
    "Instagram video configure response media ID",
  );
  const pk = instagramMediaId(
    media.pk,
    "Instagram video configure response media PK",
  );
  if (pk.includes("_") || mediaId !== `${pk}_${viewerId}`) {
    throw new Error("Instagram video configure response did not bind the current actor");
  }
  const code = instagramShortcode(
    media.code,
    "Instagram video configure response shortcode",
  );
  if (instagramShortcodeMediaPk(code) !== pk) {
    throw new Error("Instagram video configure response shortcode changed the media PK");
  }
  const captionContainer = boundedForeignRecord(
    media.caption,
    "Instagram video configure response.media.caption",
    64,
  );
  if (captionContainer.text !== caption || media.media_type !== 2) {
    throw new Error("Instagram video configure response did not bind the exact video");
  }
  return Object.freeze({
    code,
    mediaId,
    url: instagramVideoPermalink(code),
  });
}

/** Fixed public-bundle projection for the observed deletion response. */
export function assertInstagramVideoDeleteAcknowledgement(value: unknown): void {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "did_delete,status"
    || value.status !== "ok"
    || value.did_delete !== true
  ) throw new Error("Instagram video deletion acknowledgement changed shape");
}
