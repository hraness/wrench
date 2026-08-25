const YOUTUBE_DATA_API_UPLOAD_ORIGIN = "https://www.googleapis.com";
const YOUTUBE_DATA_API_UPLOAD_PATH = "/upload/youtube/v3/videos";
const YOUTUBE_UPLOAD_PARTS = "snippet,status";
const MAXIMUM_WRENCH_YOUTUBE_VIDEO_BYTES = 128 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type YouTubeDataApiUploadInitiation = Readonly<{
  body: Readonly<{
    snippet: Readonly<{
      categoryId: string;
      description?: string;
      title: string;
    }>;
    status: Readonly<{
      containsSyntheticMedia: boolean;
      privacyStatus: "private" | "unlisted" | "public";
      selfDeclaredMadeForKids: boolean;
    }>;
  }>;
  headers: Readonly<{
    contentType: "application/json; charset=UTF-8";
    uploadContentLength: string;
    uploadContentType: "video/mp4";
  }>;
  method: "POST";
  origin: "https://www.googleapis.com";
  path: "/upload/youtube/v3/videos";
  query: Readonly<{
    notifySubscribers: "false" | "true";
    part: "snippet,status";
    uploadType: "resumable";
  }>;
}>;

export type YouTubeDataApiUploadSession = Readonly<{
  url: string;
  uploadId: string;
}>;

export type YouTubeDataApiWholeFileTransfer = Readonly<{
  headers: Readonly<{
    contentLength: string;
    contentType: "video/mp4";
  }>;
  method: "PUT";
  url: string;
}>;

export type YouTubeDataApiResumeState = Readonly<{
  nextOffset: number;
  retryAfterSeconds: number | null;
  status: 308;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): JsonRecord {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} must contain only its reviewed fields`);
  }
  return value;
}

function boundedString(
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
  ) throw new Error(`${label} must be a bounded string`);
  return value;
}

function exactByteLength(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 24
    || value > MAXIMUM_WRENCH_YOUTUBE_VIDEO_BYTES
  ) throw new Error(`${label} must be an integer between 24 bytes and 128 MiB`);
  return value;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function dataApiSessionUrl(
  value: unknown,
  expectedNotifySubscribers?: boolean,
): YouTubeDataApiUploadSession {
  const text = boundedString(value, "YouTube Data API upload session URL", 4_096);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("YouTube Data API upload session URL is invalid");
  }
  if (
    url.origin !== YOUTUBE_DATA_API_UPLOAD_ORIGIN
    || url.pathname !== YOUTUBE_DATA_API_UPLOAD_PATH
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    throw new Error("YouTube Data API upload session escaped its exact official origin or path");
  }
  const allowed = new Set(["notifySubscribers", "part", "uploadType", "upload_id"]);
  const names = [...url.searchParams.keys()];
  if (
    names.some((name) => !allowed.has(name))
    || new Set(names).size !== names.length
    || url.searchParams.get("uploadType") !== "resumable"
    || url.searchParams.get("part") !== YOUTUBE_UPLOAD_PARTS
  ) throw new Error("YouTube Data API upload session query drifted");
  const uploadId = url.searchParams.get("upload_id");
  if (
    uploadId === null
    || uploadId.length < 1
    || uploadId.length > 1_024
    || !/^[A-Za-z0-9_-]+$/u.test(uploadId)
  ) throw new Error("YouTube Data API upload session ID is invalid");
  const notifySubscribers = url.searchParams.get("notifySubscribers");
  if (
    notifySubscribers !== null
    && (
      expectedNotifySubscribers === undefined
      || notifySubscribers !== String(expectedNotifySubscribers)
    )
  ) throw new Error("YouTube Data API upload session notification binding drifted");
  return Object.freeze({ url: url.href, uploadId });
}

/**
 * Build only the public, OAuth YouTube Data API resumable initiation envelope.
 * This is not the authenticated Studio web-session contract and supplies no
 * authorization header or execution path.
 */
export function createYouTubeDataApiUploadInitiation(
  value: unknown,
): YouTubeDataApiUploadInitiation {
  const input = exactRecord(value, [
    "ageRestricted",
    "byteLength",
    "caption",
    "categoryId",
    "containsSyntheticMedia",
    "madeForKids",
    "notifySubscribers",
    "title",
    "visibility",
  ], "YouTube Data API upload input");
  const ageRestricted = exactBoolean(input.ageRestricted, "YouTube age restriction");
  if (ageRestricted) {
    throw new Error("YouTube videos.insert cannot set creator age restriction in its documented insert body");
  }
  const byteLength = exactByteLength(input.byteLength, "YouTube upload byte length");
  const title = boundedString(input.title, "YouTube title", 90);
  if (/\n/u.test(title)) throw new Error("YouTube title must be one line");
  const caption = input.caption === null
    ? null
    : boundedString(input.caption, "YouTube description", 1_000, true);
  const categoryId = boundedString(input.categoryId, "YouTube category ID", 3);
  if (!/^[1-9][0-9]{0,2}$/u.test(categoryId)) {
    throw new Error("YouTube category ID must be a positive integer string");
  }
  const visibility = input.visibility;
  if (visibility !== "private" && visibility !== "unlisted" && visibility !== "public") {
    throw new Error("YouTube visibility must be private, unlisted, or public");
  }
  const notifySubscribers = exactBoolean(
    input.notifySubscribers,
    "YouTube subscriber notification choice",
  );
  const selfDeclaredMadeForKids = exactBoolean(
    input.madeForKids,
    "YouTube made-for-kids declaration",
  );
  const containsSyntheticMedia = exactBoolean(
    input.containsSyntheticMedia,
    "YouTube synthetic-media declaration",
  );
  return Object.freeze({
    body: Object.freeze({
      snippet: Object.freeze({
        categoryId,
        ...(caption === null ? {} : { description: caption }),
        title,
      }),
      status: Object.freeze({
        containsSyntheticMedia,
        privacyStatus: visibility,
        selfDeclaredMadeForKids,
      }),
    }),
    headers: Object.freeze({
      contentType: "application/json; charset=UTF-8" as const,
      uploadContentLength: String(byteLength),
      uploadContentType: "video/mp4" as const,
    }),
    method: "POST" as const,
    origin: YOUTUBE_DATA_API_UPLOAD_ORIGIN,
    path: YOUTUBE_DATA_API_UPLOAD_PATH,
    query: Object.freeze({
      notifySubscribers: String(notifySubscribers) as "false" | "true",
      part: YOUTUBE_UPLOAD_PARTS,
      uploadType: "resumable" as const,
    }),
  });
}

/** Parse the documented 200 plus Location boundary without following it. */
export function parseYouTubeDataApiUploadSession(
  value: unknown,
  expectedNotifySubscribers: boolean,
): YouTubeDataApiUploadSession {
  const response = exactRecord(value, ["location", "status"], "YouTube upload initiation response");
  if (response.status !== 200) throw new Error("YouTube upload initiation did not return HTTP 200");
  return dataApiSessionUrl(response.location, expectedNotifySubscribers);
}

/** Build the documented whole-file PUT without widening the provider-issued URL. */
export function createYouTubeDataApiWholeFileTransfer(
  sessionUrl: unknown,
  byteLengthValue: unknown,
  expectedNotifySubscribers: boolean,
): YouTubeDataApiWholeFileTransfer {
  const session = dataApiSessionUrl(sessionUrl, expectedNotifySubscribers);
  const byteLength = exactByteLength(byteLengthValue, "YouTube upload byte length");
  return Object.freeze({
    headers: Object.freeze({
      contentLength: String(byteLength),
      contentType: "video/mp4" as const,
    }),
    method: "PUT" as const,
    url: session.url,
  });
}

/** Parse only the documented 308 resume state and its optional inclusive Range. */
export function parseYouTubeDataApiResumeState(
  value: unknown,
  totalBytesValue: unknown,
): YouTubeDataApiResumeState {
  const response = exactRecord(
    value,
    ["range", "retryAfter", "status"],
    "YouTube resumable upload response",
  );
  if (response.status !== 308) throw new Error("YouTube resumable upload did not return HTTP 308");
  const totalBytes = exactByteLength(totalBytesValue, "YouTube upload byte length");
  let nextOffset = 0;
  if (response.range !== null) {
    const range = boundedString(response.range, "YouTube resumable upload Range", 64);
    const match = /^bytes=0-([0-9]+)$/u.exec(range);
    if (match === null) throw new Error("YouTube resumable upload Range drifted");
    const lastByte = Number(match[1]);
    if (!Number.isSafeInteger(lastByte) || lastByte < 0 || lastByte >= totalBytes) {
      throw new Error("YouTube resumable upload Range exceeded the confirmed file");
    }
    nextOffset = lastByte + 1;
  }
  let retryAfterSeconds: number | null = null;
  if (response.retryAfter !== null) {
    const retryAfter = boundedString(
      response.retryAfter,
      "YouTube resumable upload Retry-After",
      10,
    );
    if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(retryAfter)) {
      throw new Error("YouTube resumable upload Retry-After drifted");
    }
    retryAfterSeconds = Number(retryAfter);
  }
  return Object.freeze({ nextOffset, retryAfterSeconds, status: 308 as const });
}
