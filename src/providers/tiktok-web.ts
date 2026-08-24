import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

/**
 * TikTok consumer-web internal API policy and normalization.
 *
 * This module owns exact request shapes and bounded response projections. It
 * deliberately has no network access and never accepts arbitrary endpoints,
 * query parameters, headers, or proof material from callers.
 */

export const TIKTOK_WEB_OPERATION_NAMES = Object.freeze([
  "comments.create",
  "comments.read",
  "content.delete",
  "content.save",
  "content.schedule",
  "content.share",
  "feeds.read",
  "likes.set",
  "media.publish",
  "media.read",
  "messaging.list",
  "messaging.read",
  "messaging.send",
  "posts.publish",
  "profiles.read",
  "posts.read",
  "posts.repost",
  "relationships.follow.set",
  "replies.create",
] as const);

export type TikTokWebOperationName = (typeof TIKTOK_WEB_OPERATION_NAMES)[number];
export type TikTokWebRisk = "R1" | "R2" | "R3";
export type TikTokWebContractState = "observed" | "capture-required";
export type TikTokWebEvidence = "live-direct" | "live-har" | "first-party-bundle" | "none";

type TikTokWebReadRequestRule = {
  readonly method: "GET";
  readonly path: string;
  readonly requiredQueryParameters: readonly string[];
  readonly fixedQueryParameters: readonly (readonly [string, string])[];
};

const MAX_TIKTOK_VIDEO_PUBLISH_BYTES = 128 * 1024 * 1024;

export type TikTokWebOperationContract = {
  readonly contractVersion?: 1 | 2;
  readonly effect: "read" | "write";
  readonly risk: TikTokWebRisk;
  readonly state: TikTokWebContractState;
  readonly evidence: TikTokWebEvidence;
  readonly requests: readonly TikTokWebReadRequestRule[];
  readonly reason: string;
};

const VIEWER_REQUEST = Object.freeze({
  method: "GET" as const,
  path: "/api/user/detail/self/",
  requiredQueryParameters: Object.freeze([]),
  fixedQueryParameters: Object.freeze([]),
});

const FOR_YOU_REQUEST = Object.freeze({
  method: "GET" as const,
  path: "/api/recommend/item_list/",
  requiredQueryParameters: Object.freeze(["aid", "count"]),
  fixedQueryParameters: Object.freeze([Object.freeze(["aid", "1988"] as const)]),
});

const COMMENTS_REQUEST = Object.freeze({
  method: "GET" as const,
  path: "/api/comment/list/",
  requiredQueryParameters: Object.freeze(["aid", "aweme_id", "count", "cursor"]),
  fixedQueryParameters: Object.freeze([Object.freeze(["aid", "1988"] as const)]),
});

const noRequests = (): readonly TikTokWebReadRequestRule[] => Object.freeze([]);

/**
 * Only the two signer-free reads proven against the current consumer site are
 * executable. Endpoint-family knowledge is not dispatch authority.
 */
export const TIKTOK_WEB_OPERATIONS = Object.freeze({
  "profiles.read": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    evidence: "live-har",
    requests: Object.freeze([VIEWER_REQUEST]),
    reason: "exact current-profile counts from the viewer-bound first-party user detail response",
  }),
  "feeds.read": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    evidence: "live-direct",
    requests: Object.freeze([FOR_YOU_REQUEST]),
    reason: "exact signer-free For You GET with current-account bootstrap",
  }),
  "posts.read": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "live-direct",
    requests: noRequests(),
    reason: "item/detail and creator item-list reads returned no usable direct response without current proof material",
  }),
  "media.read": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "none",
    requests: noRequests(),
    reason: "media detail and expiring playback URL handling require a separately reviewed response contract",
  }),
  "comments.read": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    evidence: "live-direct",
    requests: Object.freeze([COMMENTS_REQUEST]),
    reason: "exact signer-free comment-list GET with post binding and acknowledgement-free semantics",
  }),
  "messaging.list": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "none",
    requests: noRequests(),
    reason: "inbox transport and acknowledgement behavior require a reviewed capture",
  }),
  "messaging.read": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "none",
    requests: noRequests(),
    reason: "conversation transport, pagination, and acknowledgement behavior require a reviewed capture",
  }),
  "likes.set": Object.freeze({
    effect: "write",
    risk: "R2",
    state: "capture-required",
    evidence: "live-har",
    requests: noRequests(),
    reason: "item digg needs current csrf/proof material, exact mutation response, and independent readback",
  }),
  "content.save": Object.freeze({
    effect: "write",
    risk: "R2",
    state: "capture-required",
    evidence: "live-har",
    requests: noRequests(),
    reason: "item collect needs current csrf/proof material, exact mutation response, and independent saved-list readback",
  }),
  "content.delete": Object.freeze({
    contractVersion: 1,
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "first-party-bundle",
    requests: noRequests(),
    reason: "Studio bundles prove authored-post detail and delete route families, but exact actor/caption binding, accepted response, signing, and independent absence readback require an authorized fixture",
  }),
  "relationships.follow.set": Object.freeze({
    effect: "write",
    risk: "R2",
    state: "capture-required",
    evidence: "live-har",
    requests: noRequests(),
    reason: "follow AB variants need exact target, csrf/proof material, mutation response, and independent relationship readback",
  }),
  "comments.create": Object.freeze({
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "live-har",
    requests: noRequests(),
    reason: "comment publish needs an authorized fixture and exact actor/root response binding",
  }),
  "replies.create": Object.freeze({
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "live-har",
    requests: noRequests(),
    reason: "reply publish needs an authorized fixture and exact actor/root/parent response binding",
  }),
  "messaging.send": Object.freeze({
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: noRequests(),
    reason: "DM send and optional attachment transport require separate reviewed fixtures",
  }),
  "posts.publish": Object.freeze({
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: noRequests(),
    reason: "text-post publication needs an authorized fixture and audience/response binding",
  }),
  "media.publish": Object.freeze({
    contractVersion: 2,
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "first-party-bundle",
    requests: noRequests(),
    reason: "Studio bundles prove upload/auth, multipart transfer, commit, project publish/status, declarations, and audience field families, but signing, exact authenticated responses, processing, actor binding, and independent post readback require an authorized fixture",
  }),
  "content.schedule": Object.freeze({
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: noRequests(),
    reason: "creator scheduling and upload publication require exact authorized Studio captures",
  }),
  "content.share": Object.freeze({
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: noRequests(),
    reason: "share destinations have distinct externally visible effects and require reviewed fixtures",
  }),
  "posts.repost": Object.freeze({
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "live-har",
    requests: noRequests(),
    reason: "upvote publish/delete requires exact current proof material, response binding, and independent readback",
  }),
} as const satisfies Readonly<Record<TikTokWebOperationName, TikTokWebOperationContract>>);

export const TIKTOK_WEB_VIEWER_REQUEST = VIEWER_REQUEST;

export type TikTokWebR1OperationId =
  | "viewer.current"
  | "profiles.current"
  | "feeds.for-you"
  | "comments.list";

/**
 * Secret-free live evidence for the fixed direct-read boundary. No response
 * values, cookies, proof tokens, or user content are retained here.
 */
export const tiktokWebDirectEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "revision-evidence-only" as const,
  observedOn: "2026-07-23",
  origin: "https://www.tiktok.com",
  authentication: "browser-cookie-session" as const,
  signerRequired: false,
  operations: Object.freeze({
    "viewer.current": Object.freeze({
      method: "GET" as const,
      path: VIEWER_REQUEST.path,
      queryNames: Object.freeze([]),
      responseBinding: Object.freeze(["userInfo.user.id", "userInfo.user.secUid"]),
    }),
    "profiles.current": Object.freeze({
      method: "GET" as const,
      path: VIEWER_REQUEST.path,
      queryNames: Object.freeze([]),
      responseBinding: Object.freeze([
        "userInfo.user.id",
        "userInfo.user.uniqueId",
        "userInfo.stats.followerCount",
        "userInfo.stats.followingCount",
        "userInfo.stats.heartCount",
      ]),
    }),
    "feeds.for-you": Object.freeze({
      method: "GET" as const,
      path: FOR_YOU_REQUEST.path,
      queryNames: Object.freeze(["aid", "count"]),
      responseBinding: Object.freeze(["statusCode", "status_code", "itemList"]),
    }),
    "comments.list": Object.freeze({
      method: "GET" as const,
      path: COMMENTS_REQUEST.path,
      queryNames: Object.freeze(["aid", "aweme_id", "count", "cursor"]),
      responseBinding: Object.freeze(["status_code", "comments[].aweme_id", "cursor"]),
    }),
  }),
});

const R1_REQUESTS = Object.freeze({
  "viewer.current": VIEWER_REQUEST,
  "profiles.current": VIEWER_REQUEST,
  "feeds.for-you": FOR_YOU_REQUEST,
  "comments.list": COMMENTS_REQUEST,
} as const satisfies Readonly<Record<TikTokWebR1OperationId, TikTokWebReadRequestRule>>);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be a bounded string`);
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\0\r]/u.test(value)) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function optionalString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, label, maximum);
}

function decimalId(value: unknown, label: string): string {
  const id = requiredString(value, label, 32);
  if (!/^[0-9]{1,32}$/u.test(id)) throw new Error(`${label} must be a decimal TikTok identifier`);
  return id;
}

function secUid(value: unknown, label: string): string {
  const id = requiredString(value, label, 256);
  if (!/^[A-Za-z0-9._-]{16,256}$/u.test(id)) throw new Error(`${label} must be an exact TikTok secUid`);
  return id;
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function integerLike(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value === "number") return integer(value, label, minimum, maximum);
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new Error(`${label} must be a safe decimal integer`);
  }
  return integer(Number(value), label, minimum, maximum);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function zeroStatus(
  root: JsonRecord,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    if (root[field] !== 0) throw new Error(`${label} did not return an exact success status`);
  }
}

function exactUrl(value: string | URL, label: string): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    url.origin !== "https://www.tiktok.com"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error(`${label} must use the exact https://www.tiktok.com origin`);
  return url;
}

function exactSingleQuery(url: URL): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (result.has(name)) throw new Error(`TikTok request repeated query parameter ${name}`);
    result.set(name, value);
  }
  return result;
}

function decimalQuery(
  values: ReadonlyMap<string, string>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = values.get(name);
  if (value === undefined || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new Error(`TikTok request query parameter ${name} must be a decimal integer`);
  }
  return integer(Number(value), `TikTok request query parameter ${name}`, minimum, maximum);
}

export type TikTokWebR1RequestInput = {
  readonly operation: TikTokWebR1OperationId;
  readonly url: string | URL;
  readonly method: string;
  readonly body?: unknown;
};

export type TikTokWebR1RequestBinding = {
  readonly operation: TikTokWebR1OperationId;
  readonly method: "GET";
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
};

/** Prove one request is exactly one signer-free reviewed R1 exchange. */
export function authorizeTikTokWebR1Request(
  input: TikTokWebR1RequestInput,
): TikTokWebR1RequestBinding {
  const definition = R1_REQUESTS[input.operation];
  if (definition === undefined) throw new Error("TikTok R1 operation is not allowlisted");
  if (input.method.toUpperCase() !== "GET") throw new Error("TikTok R1 requests require GET");
  if (input.body !== undefined) throw new Error("TikTok R1 requests may not contain a body");
  const url = exactUrl(input.url, "TikTok R1 URL");
  if (url.pathname !== definition.path) throw new Error("TikTok R1 request path is not reviewed");
  const query = exactSingleQuery(url);
  const allowed = new Set(definition.requiredQueryParameters);
  const missing = definition.requiredQueryParameters.filter((name) => !query.has(name));
  const extra = [...query.keys()].filter((name) => !allowed.has(name));
  if (missing.length > 0) throw new Error(`TikTok R1 request omitted ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`TikTok R1 request contained unsupported parameter ${extra.join(", ")}`);
  for (const [name, expected] of definition.fixedQueryParameters) {
    if (query.get(name) !== expected) throw new Error(`TikTok R1 request changed fixed parameter ${name}`);
  }
  if (input.operation === "feeds.for-you") {
    decimalQuery(query, "count", 1, 30);
  } else if (input.operation === "comments.list") {
    const postId = query.get("aweme_id");
    if (postId === undefined) throw new Error("TikTok comments request omitted aweme_id");
    decimalId(postId, "TikTok comments request aweme_id");
    decimalQuery(query, "count", 1, 50);
    decimalQuery(query, "cursor", 0, Number.MAX_SAFE_INTEGER);
  }
  return Object.freeze({
    operation: input.operation,
    method: "GET",
    path: definition.path,
    query: Object.freeze(Object.fromEntries([...query].sort(([left], [right]) => left.localeCompare(right)))),
  });
}

export const tiktokWebHeaderSinkPolicy = Object.freeze({
  browserManaged: Object.freeze([
    "cookie",
    "host",
    "user-agent",
    "content-length",
  ]),
  browserManagedPrefixes: Object.freeze(["sec-", "proxy-"]),
  fixedCodeHeaders: Object.freeze(["accept", "referer"]),
  inOriginEphemeral: Object.freeze(["tt-csrf-token"]),
  permittedRawSink: "network-request" as const,
  persistentSinks: Object.freeze(["plan", "receipt", "log", "fixture"] as const),
  forbiddenSources: Object.freeze(["manifest", "adapter", "user-input"] as const),
});

export type TikTokWebHeaderSource =
  | "code"
  | "in-origin-session"
  | "manifest"
  | "adapter"
  | "user-input";
export type TikTokWebHeaderSink =
  | "network-request"
  | "plan"
  | "receipt"
  | "log"
  | "fixture";

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Raw cookie and csrf values can only enter the immediate network request.
 * The current observed R1 runtime never requests or supplies a csrf value.
 */
export function enforceTikTokWebHeaderSinkPolicy(input: {
  readonly source: TikTokWebHeaderSource;
  readonly sink: TikTokWebHeaderSink;
  readonly headers: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
  if (!isRecord(input.headers)) throw new Error("TikTok headers must be an object");
  const entries = Object.entries(input.headers);
  if (input.sink !== "network-request") {
    if (entries.length > 0) throw new Error(`raw TikTok headers may not flow to ${input.sink}`);
    return Object.freeze({});
  }
  if (tiktokWebHeaderSinkPolicy.forbiddenSources.includes(input.source as "manifest")) {
    if (entries.length > 0) throw new Error(`${input.source} may not supply TikTok request headers`);
    return Object.freeze({});
  }
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(name) || Object.hasOwn(normalized, name)) {
      throw new Error("TikTok request contained an invalid or duplicate header");
    }
    if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || hasAsciiControl(value)) {
      throw new Error(`TikTok request header ${name} had an invalid value`);
    }
    if (
      tiktokWebHeaderSinkPolicy.browserManaged.includes(name)
      || tiktokWebHeaderSinkPolicy.browserManagedPrefixes.some((prefix) => name.startsWith(prefix))
    ) throw new Error(`TikTok request header ${name} must be browser-managed`);
    if (name === "tt-csrf-token") {
      if (input.source !== "in-origin-session" || !/^[A-Za-z0-9._~-]{8,4096}$/u.test(value)) {
        throw new Error("TikTok tt-csrf-token must come from the in-origin session");
      }
    } else if (name === "accept") {
      if (input.source !== "code" || value !== "application/json, text/plain, */*") {
        throw new Error("TikTok accept header must use the exact code-owned value");
      }
    } else if (name === "referer") {
      if (
        input.source !== "code"
        || (value !== "https://www.tiktok.com/" && value !== "https://www.tiktok.com/foryou")
      ) throw new Error("TikTok referer header must use a reviewed code-owned value");
    } else {
      throw new Error(`TikTok request header ${name} is not allowlisted`);
    }
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}

export type TikTokWebViewer = {
  readonly id: string;
  readonly secUid: string;
  readonly handle: string;
  readonly displayName: string;
};

export type TikTokWebProfile = TikTokWebViewer & {
  readonly bio: string | null;
  readonly websiteUrl: string | null;
  readonly followers: number;
  readonly following: number;
  readonly likes: number;
};

export function parseTikTokWebViewerResponse(value: unknown): TikTokWebViewer {
  const root = record(value, "TikTok current-account response");
  zeroStatus(root, ["statusCode", "status_code"], "TikTok current-account response");
  const userInfo = record(root.userInfo, "TikTok current-account response.userInfo");
  const user = record(userInfo.user, "TikTok current-account response.user");
  return Object.freeze({
    id: decimalId(user.id, "TikTok current-account user.id"),
    secUid: secUid(user.secUid, "TikTok current-account user.secUid"),
    handle: requiredString(user.uniqueId, "TikTok current-account user.uniqueId", 64),
    displayName: requiredString(user.nickname, "TikTok current-account user.nickname", 128),
  });
}

function safePublicHttpUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = requiredString(value, label, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute HTTP URL`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== ""
    || url.password !== ""
  ) throw new Error(`${label} must be a safe public HTTP URL`);
  return url.href;
}

function matchingExactCount(
  primary: JsonRecord,
  secondary: JsonRecord | null,
  key: "followerCount" | "followingCount" | "heartCount",
  label: string,
): number {
  const first = integerLike(primary[key], `${label}.${key}`);
  if (secondary === null || secondary[key] === undefined) return first;
  const second = integerLike(secondary[key], `${label}V2.${key}`);
  if (first !== second) throw new Error(`TikTok profile response contained conflicting ${key} values`);
  return first;
}

/** Project exact current-profile counts without retaining account-private IDs. */
export function parseTikTokWebProfileResponse(value: unknown): TikTokWebProfile {
  const viewer = parseTikTokWebViewerResponse(value);
  const root = record(value, "TikTok current-profile response");
  const userInfo = record(root.userInfo, "TikTok current-profile response.userInfo");
  const user = record(userInfo.user, "TikTok current-profile response.user");
  const stats = record(userInfo.stats, "TikTok current-profile response.stats");
  const statsV2 = userInfo.statsV2 === undefined
    ? null
    : record(userInfo.statsV2, "TikTok current-profile response.statsV2");
  const bioLink = isRecord(user.bioLink) ? user.bioLink : null;
  return Object.freeze({
    ...viewer,
    bio: user.signature === undefined
      ? null
      : boundedText(user.signature, "TikTok current-profile response.user.signature", 4096),
    websiteUrl: bioLink === null
      ? null
      : safePublicHttpUrl(
        bioLink.link ?? bioLink.url,
        "TikTok current-profile response.user.bioLink",
      ),
    followers: matchingExactCount(stats, statsV2, "followerCount", "TikTok current-profile response.stats"),
    following: matchingExactCount(stats, statsV2, "followingCount", "TikTok current-profile response.stats"),
    likes: matchingExactCount(stats, statsV2, "heartCount", "TikTok current-profile response.stats"),
  });
}

type TikTokWebAuthor = {
  readonly id: string;
  readonly secUid: string;
  readonly handle: string;
  readonly displayName: string;
};

function normalizedAuthor(value: unknown, label: string, style: "item" | "comment"): TikTokWebAuthor {
  const author = record(value, label);
  return Object.freeze({
    id: decimalId(style === "item" ? author.id : author.uid, `${label}.${style === "item" ? "id" : "uid"}`),
    secUid: secUid(
      style === "item" ? author.secUid : author.sec_uid,
      `${label}.${style === "item" ? "secUid" : "sec_uid"}`,
    ),
    handle: requiredString(
      style === "item" ? author.uniqueId : author.unique_id,
      `${label}.${style === "item" ? "uniqueId" : "unique_id"}`,
      64,
    ),
    displayName: requiredString(author.nickname, `${label}.nickname`, 128),
  });
}

function normalizedItem(value: unknown, index: number): Readonly<Record<string, unknown>> {
  const label = `TikTok feed item ${index + 1}`;
  const item = record(value, label);
  const id = decimalId(item.id, `${label}.id`);
  const author = normalizedAuthor(item.author, `${label}.author`, "item");
  const stats = record(item.stats, `${label}.stats`);
  const video = record(item.video, `${label}.video`);
  const videoId = optionalString(video.id, `${label}.video.id`, 128);
  const ratio = optionalString(video.ratio, `${label}.video.ratio`, 32);
  return Object.freeze({
    id,
    description: boundedText(item.desc, `${label}.desc`, 8_192),
    createdAtUnix: integer(item.createTime, `${label}.createTime`, 0),
    author,
    viewerState: Object.freeze({
      liked: boolean(item.digged, `${label}.digged`),
      saved: boolean(item.collected, `${label}.collected`),
    }),
    metrics: Object.freeze({
      likes: integerLike(stats.diggCount, `${label}.stats.diggCount`),
      comments: integerLike(stats.commentCount, `${label}.stats.commentCount`),
      shares: integerLike(stats.shareCount, `${label}.stats.shareCount`),
      plays: integerLike(stats.playCount, `${label}.stats.playCount`),
      saves: stats.collectCount === undefined
        ? null
        : integerLike(stats.collectCount, `${label}.stats.collectCount`),
    }),
    media: Object.freeze({
      type: "video",
      id: videoId,
      durationSeconds: integer(video.duration, `${label}.video.duration`, 0, 24 * 60 * 60),
      width: integer(video.width, `${label}.video.width`, 1, 65_535),
      height: integer(video.height, `${label}.video.height`, 1, 65_535),
      ratio,
    }),
    url: `https://www.tiktok.com/@${encodeURIComponent(author.handle)}/video/${id}`,
  });
}

export function normalizeTikTokWebFeedResponse(
  value: unknown,
  requestedLimit: number,
): Readonly<Record<string, unknown>> {
  integer(requestedLimit, "TikTok requested feed limit", 1, 30);
  const root = record(value, "TikTok For You response");
  zeroStatus(root, ["statusCode", "status_code"], "TikTok For You response");
  if (!Array.isArray(root.itemList)) throw new Error("TikTok For You response.itemList must be an array");
  if (root.itemList.length > requestedLimit) {
    throw new Error("TikTok For You response exceeded the requested complete-page limit");
  }
  return Object.freeze({
    posts: Object.freeze(root.itemList.map(normalizedItem)),
    hasMore: boolean(root.hasMore, "TikTok For You response.hasMore"),
  });
}

function normalizedComment(
  value: unknown,
  index: number,
  requestedPostId: string,
): Readonly<Record<string, unknown>> {
  const label = `TikTok comment ${index + 1}`;
  const comment = record(value, label);
  const returnedPostId = decimalId(comment.aweme_id, `${label}.aweme_id`);
  if (returnedPostId !== requestedPostId) {
    throw new Error("TikTok comments response did not bind the requested post");
  }
  const userDigged = integer(comment.user_digged, `${label}.user_digged`, 0, 1);
  return Object.freeze({
    id: decimalId(comment.cid, `${label}.cid`),
    postId: returnedPostId,
    text: boundedText(comment.text, `${label}.text`, 8_192),
    createdAtUnix: integer(comment.create_time, `${label}.create_time`, 0),
    author: normalizedAuthor(comment.user, `${label}.user`, "comment"),
    parentCommentId: optionalString(comment.reply_id, `${label}.reply_id`, 32),
    repliedToCommentId: optionalString(comment.reply_to_reply_id, `${label}.reply_to_reply_id`, 32),
    replyCount: integer(comment.reply_comment_total, `${label}.reply_comment_total`, 0),
    likeCount: integer(comment.digg_count, `${label}.digg_count`, 0),
    viewerLiked: userDigged === 1,
  });
}

export function normalizeTikTokWebCommentsResponse(
  value: unknown,
  requestedPostIdValue: unknown,
  requestedLimit: number,
): Readonly<Record<string, unknown>> {
  const requestedPostId = decimalId(requestedPostIdValue, "requested TikTok post ID");
  integer(requestedLimit, "TikTok requested comment limit", 1, 50);
  const root = record(value, "TikTok comments response");
  zeroStatus(root, ["status_code"], "TikTok comments response");
  if (!Array.isArray(root.comments)) throw new Error("TikTok comments response.comments must be an array");
  if (root.comments.length > requestedLimit) {
    throw new Error("TikTok comments response exceeded the requested complete-page limit");
  }
  return Object.freeze({
    comments: Object.freeze(
      root.comments.map((comment, index) => normalizedComment(comment, index, requestedPostId)),
    ),
    cursor: integer(root.cursor, "TikTok comments response.cursor", 0),
    hasMore: integer(root.has_more, "TikTok comments response.has_more", 0, 1) === 1,
    total: integer(root.total, "TikTok comments response.total", 0),
  });
}

/**
 * Secret-free structural evidence retained from TikTok Studio's public,
 * first-party bundles. This snapshot is not dispatch authority: browser-common
 * query parameters, signing, authenticated response envelopes, and readback
 * shapes remain capture-required.
 */
export const tiktokWebStudioBundleEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "bundle-evidence-only" as const,
  observedOn: "2026-08-22",
  origin: "https://www.tiktok.com",
  authentication: "browser-cookie-session" as const,
  upload: Object.freeze({
    auth: "GET /api/v1/video/upload/auth/",
    apply: "GET /top/v1 Action=ApplyUploadInner Version=2020-11-19",
    transfer: Object.freeze([
      "POST /upload/v1/{oid} phase=init",
      "POST /upload/v1/{oid} phase=transfer",
      "POST /upload/v1/{oid} phase=finish",
    ]),
    commit: "POST /top/v1 Action=CommitUploadInner Version=2020-11-19",
    partBytes: 3_145_728,
  }),
  publish: Object.freeze({
    create: "POST /tiktok/web/project/post/v1/",
    status: "GET /tiktok/web/project/status/v1/",
    postType: 3,
  }),
  deletion: Object.freeze({
    detail: "GET /api/v1/post/detail/ item_id={post-id}",
    mutate: "POST /tiktok/post/edit/v1/ scene=1",
    deleteTypes: Object.freeze({ normal: 0, trashBin: 1 }),
  }),
  unresolvedForDispatch: Object.freeze([
    "active upload-host and TOS request variant",
    "browser-common query parameters and request signing",
    "authenticated upload, commit, publish, status, detail, and delete response envelopes",
    "fresh viewer and authored-target binding",
    "processing completion and independent exact-post presence or absence readback",
  ]),
});

/**
 * The supplied successful live capture retained only structural facts. It is
 * useful for narrowing future egress, but not for choosing a request, parsing
 * a publish response, or promoting media.publish. In particular, every route,
 * query value, body field, account value, and accepted target was redacted.
 */
export const tiktokWebSanitizedPublishCaptureEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "structural-live-evidence-only" as const,
  observedOn: "2026-08-23",
  targetOrigin: "https://www.tiktok.com",
  observedEntries: 1_344,
  writeCandidateCount: 5,
  writeCandidateSamples: 8,
  remoteOrigins: Object.freeze([
    "https://lf16-tiktok-web.tiktokcdn-us.com",
    "https://lf16-cdn-tos.tiktokcdn-us.com",
    "https://tos16-up-useast8.tiktokcdn-us.com",
    "https://tos19-up-useast8.tiktokcdn-us.com",
  ]),
  observedUploadOrigins: Object.freeze([
    "https://tos16-up-useast8.tiktokcdn-us.com",
    "https://tos19-up-useast8.tiktokcdn-us.com",
  ]),
  unresolvedForDispatch: Object.freeze([
    "semantic operation ownership for every retained write candidate",
    "exact route, query names and values, request fields, and credential sinks",
    "response-selected upload credential, header, and accepted-status binding",
    "current account, project, post, and audience response binding",
    "processing completion and independent exact-post readback",
  ]),
});

const TIKTOK_SANITIZED_CAPTURE_UPLOAD_ORIGINS = new Set(
  tiktokWebSanitizedPublishCaptureEvidenceSnapshot.observedUploadOrigins,
);

function exactObjectKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) throw new Error(`${label} changed its bundle-proven fields`);
}

function opaqueBundleString(value: unknown, label: string, maximum: number): string {
  const text = requiredString(value, label, maximum);
  if (/\n/u.test(text)) throw new Error(`${label} must not contain line breaks`);
  return text;
}

function exactHttpsUploadHost(value: unknown, label: string): string {
  const text = opaqueBundleString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS origin`);
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error(`${label} must be an exact HTTPS origin`);
  if (!TIKTOK_SANITIZED_CAPTURE_UPLOAD_ORIGINS.has(url.origin)) {
    throw new Error(`${label} was not one exact origin retained by the sanitized live capture`);
  }
  return url.origin;
}

function bundleId(value: unknown, label: string, maximum = 2_048): string {
  const id = opaqueBundleString(value, label, maximum);
  if (!/^[A-Za-z0-9._~:@+/=-]+$/u.test(id)) {
    throw new Error(`${label} must be a bounded provider identifier`);
  }
  return id;
}

export type TikTokBundleRequestProjection = Readonly<{
  body?: Readonly<Record<string, unknown>>;
  method: "GET" | "POST";
  path: string;
  query: Readonly<Record<string, string>>;
}>;

export function buildTikTokVideoUploadAuthRequest(): TikTokBundleRequestProjection {
  return Object.freeze({
    method: "GET",
    path: "/api/v1/video/upload/auth/",
    query: Object.freeze({}),
  });
}

export type TikTokVideoUploadTokenProjection = Readonly<{
  accessKeyId: string;
  currentTime: number;
  expiredTime: number;
  secretAccessKey: string;
  sessionToken: string;
}>;

/** Parse only the exact video_token_v5 branch projected by the public bundle. */
export function parseTikTokVideoUploadTokenProjection(
  value: unknown,
): TikTokVideoUploadTokenProjection {
  const root = record(value, "TikTok upload-auth projection");
  exactObjectKeys(root, ["video_token_v5"], [], "TikTok upload-auth projection");
  const token = record(root.video_token_v5, "TikTok upload-auth video_token_v5");
  exactObjectKeys(token, [
    "access_key_id",
    "secret_acess_key",
    "session_token",
    "expired_time",
    "current_time",
  ], [], "TikTok upload-auth video_token_v5");
  const currentTime = integerLike(
    token.current_time,
    "TikTok upload-auth current_time",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const expiredTime = integerLike(
    token.expired_time,
    "TikTok upload-auth expired_time",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (expiredTime <= currentTime) {
    throw new Error("TikTok upload-auth token must expire after its server current time");
  }
  return Object.freeze({
    accessKeyId: bundleId(token.access_key_id, "TikTok upload-auth access_key_id", 256),
    currentTime,
    expiredTime,
    secretAccessKey: opaqueBundleString(
      token.secret_acess_key,
      "TikTok upload-auth secret_acess_key",
      4_096,
    ),
    sessionToken: opaqueBundleString(
      token.session_token,
      "TikTok upload-auth session_token",
      16_384,
    ),
  });
}

export function buildTikTokApplyUploadInnerRequest(input: {
  readonly fileSize: number;
  readonly nonce: string;
}): TikTokBundleRequestProjection {
  const fileSize = integer(
    input.fileSize,
    "TikTok ApplyUploadInner fileSize",
    24,
    MAX_TIKTOK_VIDEO_PUBLISH_BYTES,
  );
  const nonce = opaqueBundleString(input.nonce, "TikTok ApplyUploadInner nonce", 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(nonce)) {
    throw new Error("TikTok ApplyUploadInner nonce must be bounded URL-safe text");
  }
  return Object.freeze({
    method: "GET",
    path: "/top/v1",
    query: Object.freeze({
      Action: "ApplyUploadInner",
      Version: "2020-11-19",
      SpaceName: "tiktok",
      FileType: "video",
      IsInner: "1",
      FileSize: String(fileSize),
      s: nonce,
      device_platform: "web",
      business_tag: "tiktok_video_submission_web",
    }),
  });
}

export type TikTokApplyUploadNodeProjection = Readonly<{
  authorization: string;
  sessionKey: string;
  storeUri: string;
  uploadHost: string;
  uploadId: string;
}>;

export type TikTokApplyUploadResultProjection = Readonly<{
  fallback: TikTokApplyUploadNodeProjection | null;
  primary: TikTokApplyUploadNodeProjection;
}>;

function parseTikTokUploadNode(
  value: unknown,
  label: string,
): TikTokApplyUploadNodeProjection {
  const node = record(value, label);
  exactObjectKeys(
    node,
    ["StoreInfos", "UploadHost", "SessionKey", "UploadHeader"],
    [],
    label,
  );
  if (!Array.isArray(node.StoreInfos) || node.StoreInfos.length !== 1) {
    throw new Error(`${label}.StoreInfos must contain one exact store binding`);
  }
  const store = record(node.StoreInfos[0], `${label}.StoreInfos[0]`);
  exactObjectKeys(store, ["Auth", "StoreUri", "UploadID"], [], `${label}.StoreInfos[0]`);
  const uploadHeader = opaqueBundleString(node.UploadHeader, `${label}.UploadHeader`, 16_384);
  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(uploadHeader);
  } catch {
    throw new Error(`${label}.UploadHeader must be exact JSON`);
  }
  if (!isRecord(parsedHeader) || Object.keys(parsedHeader).length !== 0) {
    throw new Error(`${label}.UploadHeader requires a reviewed non-empty header capture`);
  }
  return Object.freeze({
    authorization: opaqueBundleString(store.Auth, `${label}.StoreInfos[0].Auth`, 16_384),
    sessionKey: bundleId(node.SessionKey, `${label}.SessionKey`, 4_096),
    storeUri: bundleId(store.StoreUri, `${label}.StoreInfos[0].StoreUri`, 2_048),
    uploadHost: exactHttpsUploadHost(node.UploadHost, `${label}.UploadHost`),
    uploadId: bundleId(store.UploadID, `${label}.StoreInfos[0].UploadID`, 4_096),
  });
}

/**
 * Parse the exact Result projection described by the public VOD client. A
 * second node is kept explicitly as fallback evidence and is never selected
 * automatically.
 */
export function parseTikTokApplyUploadResultProjection(
  value: unknown,
): TikTokApplyUploadResultProjection {
  const result = record(value, "TikTok ApplyUploadInner Result projection");
  exactObjectKeys(result, ["InnerUploadAddress"], [], "TikTok ApplyUploadInner Result projection");
  const address = record(
    result.InnerUploadAddress,
    "TikTok ApplyUploadInner Result.InnerUploadAddress",
  );
  exactObjectKeys(address, ["UploadNodes"], [], "TikTok ApplyUploadInner Result.InnerUploadAddress");
  if (
    !Array.isArray(address.UploadNodes)
    || address.UploadNodes.length < 1
    || address.UploadNodes.length > 2
  ) throw new Error("TikTok ApplyUploadInner must contain one primary and at most one explicit fallback node");
  const primary = parseTikTokUploadNode(
    address.UploadNodes[0],
    "TikTok ApplyUploadInner primary node",
  );
  const fallback = address.UploadNodes.length === 2
    ? parseTikTokUploadNode(address.UploadNodes[1], "TikTok ApplyUploadInner fallback node")
    : null;
  if (
    fallback !== null
    && fallback.uploadHost === primary.uploadHost
    && fallback.uploadId === primary.uploadId
  ) throw new Error("TikTok ApplyUploadInner fallback node duplicated the primary transport");
  return Object.freeze({ primary, fallback });
}

export const TIKTOK_TOS_PART_BYTES = 3_145_728;

export type TikTokTosPart = Readonly<{
  byteLength: number;
  byteOffset: number;
  partNumber: number;
}>;

export type TikTokTosPartIntegrity = TikTokTosPart & Readonly<{
  crc32: string;
}>;

export type TikTokTosCompletedTransferCheckpoint = Readonly<{
  byteLength: number;
  mediaSha256: string;
  parts: readonly TikTokTosPartIntegrity[];
}>;

const TIKTOK_TOS_CRC32_TABLE = Object.freeze(Array.from(
  { length: 256 },
  (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb8_8320 : 0);
    }
    return value >>> 0;
  },
));

export function planTikTokTosParts(byteLengthValue: unknown): readonly TikTokTosPart[] {
  const byteLength = integer(
    byteLengthValue,
    "TikTok TOS byte length",
    24,
    MAX_TIKTOK_VIDEO_PUBLISH_BYTES,
  );
  const parts: TikTokTosPart[] = [];
  for (let byteOffset = 0, partNumber = 1; byteOffset < byteLength; partNumber += 1) {
    const partByteLength = Math.min(TIKTOK_TOS_PART_BYTES, byteLength - byteOffset);
    parts.push(Object.freeze({ byteLength: partByteLength, byteOffset, partNumber }));
    byteOffset += partByteLength;
  }
  return Object.freeze(parts);
}

/** Standard IEEE CRC-32 rendered as the lowercase eight-hex TOS value. */
export function tikTokTosCrc32(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new Error("TikTok TOS CRC32 input must be bytes");
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ TIKTOK_TOS_CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return ((crc ^ 0xffff_ffff) >>> 0).toString(16).padStart(8, "0");
}

export function tikTokVideoSha256(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("TikTok video SHA-256 input must be exact bytes");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Bind the exact local bytes to the bundle-proven contiguous multipart plan.
 * This contains no upload identifier or credential and grants no dispatch or
 * resume authority.
 */
export function planTikTokTosPartIntegrity(
  bytes: Uint8Array,
): readonly TikTokTosPartIntegrity[] {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("TikTok TOS integrity planning requires exact bytes");
  }
  return Object.freeze(planTikTokTosParts(bytes.byteLength).map((part) =>
    Object.freeze({
      ...part,
      crc32: tikTokTosCrc32(bytes.subarray(
        part.byteOffset,
        part.byteOffset + part.byteLength,
      )),
    })));
}

/**
 * Accept a durable transfer-complete checkpoint only when every planned part
 * has one strict CRC acknowledgement. A partial prefix is intentionally not a
 * resumable state because the current evidence proves no retry/idempotency
 * contract for TOS transfer, finish, commit, or project publication. Even a
 * complete result is local integrity evidence only: it is not bound to an
 * upload ID and therefore never authorizes finish, commit, or publication.
 */
export function verifyTikTokTosCompletedTransfer(
  bytes: Uint8Array,
  transferResponses: unknown,
): TikTokTosCompletedTransferCheckpoint {
  const parts = planTikTokTosPartIntegrity(bytes);
  if (!Array.isArray(transferResponses) || transferResponses.length !== parts.length) {
    throw new Error(
      "TikTok TOS transfer checkpoint must acknowledge every planned part; partial transfer remains indeterminate",
    );
  }
  for (const [index, part] of parts.entries()) {
    parseTikTokTosTransferResponse(transferResponses[index], part.crc32);
  }
  return Object.freeze({
    byteLength: bytes.byteLength,
    mediaSha256: tikTokVideoSha256(bytes),
    parts,
  });
}

function tosObjectPath(value: unknown): string {
  const oid = opaqueBundleString(value, "TikTok TOS object ID", 2_048);
  const segments = oid.split("/");
  if (
    segments.length > 32
    || segments.some((segment) =>
      segment === "."
      || segment === ".."
      || !/^[A-Za-z0-9._~:@+=-]{1,256}$/u.test(segment))
  ) throw new Error("TikTok TOS object ID must contain only bounded provider path segments");
  return `/upload/v1/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function tosUploadId(value: unknown): string {
  return bundleId(value, "TikTok TOS upload ID", 4_096);
}

export function buildTikTokTosInitRequest(oid: unknown): TikTokBundleRequestProjection {
  return Object.freeze({
    method: "POST",
    path: tosObjectPath(oid),
    query: Object.freeze({ uploadmode: "part", phase: "init" }),
  });
}

export function buildTikTokTosTransferRequest(input: {
  readonly crc32: string;
  readonly oid: unknown;
  readonly part: TikTokTosPart;
  readonly uploadId: unknown;
}): TikTokBundleRequestProjection & Readonly<{ contentCrc32: string }> {
  const partNumber = integer(input.part.partNumber, "TikTok TOS part number", 1, 1_024);
  const byteOffset = integer(
    input.part.byteOffset,
    "TikTok TOS part offset",
    0,
    MAX_TIKTOK_VIDEO_PUBLISH_BYTES - 1,
  );
  integer(input.part.byteLength, "TikTok TOS part byte length", 1, TIKTOK_TOS_PART_BYTES);
  const crc32 = opaqueBundleString(input.crc32, "TikTok TOS Content-CRC32", 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/u.test(crc32)) throw new Error("TikTok TOS Content-CRC32 must be eight hexadecimal digits");
  return Object.freeze({
    contentCrc32: crc32,
    method: "POST",
    path: tosObjectPath(input.oid),
    query: Object.freeze({
      uploadid: tosUploadId(input.uploadId),
      part_number: String(partNumber),
      phase: "transfer",
      part_offset: String(byteOffset),
    }),
  });
}

export function buildTikTokTosFinishRequest(input: {
  readonly oid: unknown;
  readonly uploadId: unknown;
}): TikTokBundleRequestProjection {
  return Object.freeze({
    method: "POST",
    path: tosObjectPath(input.oid),
    query: Object.freeze({
      uploadmode: "part",
      phase: "finish",
      uploadid: tosUploadId(input.uploadId),
    }),
  });
}

function tosSuccessData(value: unknown, field: string, label: string): JsonRecord {
  const root = record(value, label);
  exactObjectKeys(root, ["code", "data"], ["message"], label);
  if (root.code !== 2000) throw new Error(`${label} did not return TOS code 2000`);
  if (root.message !== undefined) boundedText(root.message, `${label}.message`, 2_048);
  const data = record(root.data, `${label}.data`);
  exactObjectKeys(data, [field], [], `${label}.data`);
  return data;
}

export function parseTikTokTosInitResponse(value: unknown): Readonly<{ uploadId: string }> {
  const data = tosSuccessData(value, "uploadid", "TikTok TOS init response");
  return Object.freeze({ uploadId: tosUploadId(data.uploadid) });
}

export function parseTikTokTosTransferResponse(
  value: unknown,
  expectedCrc32Value: unknown,
): Readonly<{ crc32: string }> {
  const expectedCrc32 = opaqueBundleString(
    expectedCrc32Value,
    "expected TikTok TOS CRC32",
    8,
  ).toLowerCase();
  if (!/^[0-9a-f]{8}$/u.test(expectedCrc32)) {
    throw new Error("expected TikTok TOS CRC32 must be eight hexadecimal digits");
  }
  const data = tosSuccessData(value, "crc32", "TikTok TOS transfer response");
  const crc32 = opaqueBundleString(data.crc32, "TikTok TOS transfer response.data.crc32", 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/u.test(crc32) || crc32 !== expectedCrc32) {
    throw new Error("TikTok TOS transfer response did not bind the uploaded part CRC32");
  }
  return Object.freeze({ crc32 });
}

export function parseTikTokTosFinishResponse(value: unknown): Readonly<{ key: string }> {
  const data = tosSuccessData(value, "key", "TikTok TOS finish response");
  return Object.freeze({ key: bundleId(data.key, "TikTok TOS finish response.data.key", 4_096) });
}

export function buildTikTokCommitUploadInnerRequest(
  sessionKeyValue: unknown,
): TikTokBundleRequestProjection {
  const sessionKey = bundleId(sessionKeyValue, "TikTok CommitUploadInner SessionKey", 4_096);
  return Object.freeze({
    method: "POST",
    path: "/top/v1",
    query: Object.freeze({
      Action: "CommitUploadInner",
      Version: "2020-11-19",
      SpaceName: "tiktok",
    }),
    body: Object.freeze({ SessionKey: sessionKey, Functions: Object.freeze([]) }),
  });
}

export type TikTokCommitUploadResultProjection = Readonly<{
  bitrate: number | null;
  codec: string | null;
  duration: number | null;
  format: string | null;
  height: number | null;
  uri: string;
  videoId: string;
  width: number | null;
}>;

/** Parse the single committed-result projection used by Studio after commit. */
export function parseTikTokCommitUploadResultProjection(
  value: unknown,
): TikTokCommitUploadResultProjection {
  const result = record(value, "TikTok CommitUploadInner Result projection");
  exactObjectKeys(result, ["Results"], [], "TikTok CommitUploadInner Result projection");
  if (!Array.isArray(result.Results) || result.Results.length !== 1) {
    throw new Error("TikTok CommitUploadInner Result must bind one committed video");
  }
  const item = record(result.Results[0], "TikTok CommitUploadInner Result.Results[0]");
  exactObjectKeys(item, ["Vid", "Uri"], ["VideoMeta"], "TikTok CommitUploadInner Result.Results[0]");
  const meta = item.VideoMeta === undefined
    ? null
    : record(item.VideoMeta, "TikTok CommitUploadInner VideoMeta");
  if (meta !== null) {
    exactObjectKeys(
      meta,
      ["Width", "Height", "Duration", "Format", "Codec", "Bitrate"],
      [],
      "TikTok CommitUploadInner VideoMeta",
    );
  }
  return Object.freeze({
    bitrate: meta === null ? null : integer(meta.Bitrate, "TikTok committed video bitrate", 0),
    codec: meta === null ? null : opaqueBundleString(meta.Codec, "TikTok committed video codec", 128),
    duration: meta === null ? null : integer(meta.Duration, "TikTok committed video duration", 0, 86_400_000),
    format: meta === null ? null : opaqueBundleString(meta.Format, "TikTok committed video format", 128),
    height: meta === null ? null : integer(meta.Height, "TikTok committed video height", 1, 65_535),
    uri: bundleId(item.Uri, "TikTok committed video Uri", 2_048),
    videoId: bundleId(item.Vid, "TikTok committed video Vid", 2_048),
    width: meta === null ? null : integer(meta.Width, "TikTok committed video width", 1, 65_535),
  });
}

export type TikTokVideoProjectPlan = Readonly<{
  allowAiRemix: boolean;
  allowComments: boolean;
  allowContentReuse: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  audience: "public" | "friends" | "private";
  caption: string | null;
  commercialContent: "none";
  containsSyntheticMedia: boolean;
}>;

export type TikTokVideoProjectBinding = Readonly<{
  creationId: string;
  durationSeconds: number;
  enterPostPageFrom: string;
  posterDelay: number;
  soundExemption: 0 | 1;
  videoId: string;
}>;

/**
 * Build only the bundle-proven plain-video payload projection. The caller may
 * not dispatch it: the active common-query/signing envelope and authenticated
 * response/readback contracts remain deliberately absent.
 */
export function buildTikTokVideoProjectPayloadProjection(
  plan: TikTokVideoProjectPlan,
  binding: TikTokVideoProjectBinding,
): Readonly<Record<string, unknown>> {
  if (!isRecord(plan)) throw new Error("TikTok video project plan must be an object");
  exactObjectKeys(plan as JsonRecord, [
    "allowAiRemix",
    "allowComments",
    "allowContentReuse",
    "allowDuet",
    "allowStitch",
    "audience",
    "caption",
    "commercialContent",
    "containsSyntheticMedia",
  ], [], "TikTok video project plan");
  for (const [field, value] of [
    ["allowAiRemix", plan.allowAiRemix],
    ["allowComments", plan.allowComments],
    ["allowContentReuse", plan.allowContentReuse],
    ["allowDuet", plan.allowDuet],
    ["allowStitch", plan.allowStitch],
    ["containsSyntheticMedia", plan.containsSyntheticMedia],
  ] as const) boolean(value, `TikTok video project plan.${field}`);
  if (plan.audience !== "public" && plan.audience !== "friends" && plan.audience !== "private") {
    throw new Error("TikTok video project audience must be public, friends, or private");
  }
  if (plan.commercialContent !== "none") {
    throw new Error("TikTok video project currently supports only an explicit no-commercial-content declaration");
  }
  const caption = plan.caption === null
    ? ""
    : boundedText(plan.caption, "TikTok video project caption", 500);
  if (!isRecord(binding)) throw new Error("TikTok video project binding must be an object");
  exactObjectKeys(binding as JsonRecord, [
    "creationId",
    "durationSeconds",
    "enterPostPageFrom",
    "posterDelay",
    "soundExemption",
    "videoId",
  ], [], "TikTok video project binding");
  const durationSeconds = integer(
    binding.durationSeconds,
    "TikTok video project durationSeconds",
    0,
    86_400,
  );
  const visibility = plan.audience === "public" ? 0 : plan.audience === "private" ? 1 : 2;
  const numeric = (value: boolean): 0 | 1 => value ? 1 : 0;
  return Object.freeze({
    post_common_info: Object.freeze({
      creation_id: bundleId(binding.creationId, "TikTok video project creationId", 512),
      enter_post_page_from: bundleId(
        binding.enterPostPageFrom,
        "TikTok video project enterPostPageFrom",
        128,
      ),
      post_type: 3,
    }),
    feature_common_info_list: Object.freeze([Object.freeze({
      geofencing_regions: Object.freeze([]),
      tcm_params: '{"commerce_toggle_info":{}}',
      sound_exemption: integer(binding.soundExemption, "TikTok video project soundExemption", 0, 1),
      aigc_info: Object.freeze({
        aigc_label_type: plan.containsSyntheticMedia ? 1 : 0,
      }),
      privacy_setting_info: Object.freeze({
        visibility,
        allow_comment: numeric(plan.allowComments),
        allow_duet: numeric(plan.allowDuet),
        allow_stitch: numeric(plan.allowStitch),
        allow_content_reuse: numeric(plan.allowContentReuse),
        allow_ai_remix: plan.allowAiRemix ? 1 : 2,
      }),
    })]),
    single_post_req_list: Object.freeze([Object.freeze({
      batch_index: 0,
      video_id: bundleId(binding.videoId, "TikTok video project videoId", 2_048),
      is_long_video: numeric(durationSeconds > 60),
      single_post_feature_info: Object.freeze({
        text: caption,
        text_extra: Object.freeze([]),
        markup_text: caption,
        poster_delay: integer(binding.posterDelay, "TikTok video project posterDelay", 0, 86_400_000),
      }),
    })]),
  });
}

export function buildTikTokProjectStatusRequestProjection(
  projectIdValue: unknown,
): TikTokBundleRequestProjection {
  return Object.freeze({
    method: "GET",
    path: "/tiktok/web/project/status/v1/",
    query: Object.freeze({
      project_id: bundleId(projectIdValue, "TikTok project status project_id", 512),
    }),
  });
}

export function buildTikTokPostDetailRequestProjection(
  postIdValue: unknown,
): TikTokBundleRequestProjection {
  return Object.freeze({
    method: "GET",
    path: "/api/v1/post/detail/",
    query: Object.freeze({ item_id: decimalId(postIdValue, "TikTok detail post ID") }),
  });
}

const TIKTOK_DELETE_PERMISSION_MAX_JSON_DEPTH = 32;
const TIKTOK_DELETE_PERMISSION_MAX_JSON_NODES = 16_384;
const TIKTOK_DELETE_PERMISSION_MAX_ARRAY_ITEMS = 64;
const TIKTOK_DELETE_PERMISSION_MAX_JSON_BYTES = 1024 * 1024;
const TIKTOK_DELETE_PERMISSION_MAX_KEY_BYTES = 1_024;
const TIKTOK_DELETE_PERMISSION_MAX_STRING_BYTES = 256 * 1024;

type TikTokDeletePermissionJson =
  | null
  | boolean
  | number
  | string
  | readonly TikTokDeletePermissionJson[]
  | { readonly [key: string]: TikTokDeletePermissionJson };

type TikTokDeletePermissionJsonState = {
  readonly active: WeakSet<object>;
  bytes: number;
  nodes: number;
};

function addTikTokDeletePermissionJsonBytes(
  state: TikTokDeletePermissionJsonState,
  bytes: number,
): void {
  state.bytes += bytes;
  if (state.bytes > TIKTOK_DELETE_PERMISSION_MAX_JSON_BYTES) {
    throw new Error("TikTok delete permission projection exceeds its total JSON byte bound");
  }
}

function snapshotTikTokDeletePermissionJson(
  value: unknown,
  label: string,
): TikTokDeletePermissionJson {
  const state: TikTokDeletePermissionJsonState = {
    active: new WeakSet<object>(),
    bytes: 0,
    nodes: 0,
  };
  const visit = (candidate: unknown, depth: number): TikTokDeletePermissionJson => {
    state.nodes += 1;
    if (
      depth > TIKTOK_DELETE_PERMISSION_MAX_JSON_DEPTH
      || state.nodes > TIKTOK_DELETE_PERMISSION_MAX_JSON_NODES
    ) throw new Error(`${label} exceeds its JSON structural bound`);
    if (candidate === null) {
      addTikTokDeletePermissionJsonBytes(state, 4);
      return null;
    }
    if (typeof candidate === "boolean") {
      addTikTokDeletePermissionJsonBytes(state, candidate ? 4 : 5);
      return candidate;
    }
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > TIKTOK_DELETE_PERMISSION_MAX_STRING_BYTES) {
        throw new Error(`${label} contains an oversized string`);
      }
      addTikTokDeletePermissionJsonBytes(
        state,
        Buffer.byteLength(JSON.stringify(candidate), "utf8"),
      );
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error(`${label} contains a non-finite number`);
      addTikTokDeletePermissionJsonBytes(
        state,
        Buffer.byteLength(JSON.stringify(candidate), "utf8"),
      );
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new Error(`${label} must contain only JSON data`);
    }
    if (nodeTypes.isProxy(candidate)) throw new Error(`${label} must not contain proxies`);
    if (state.active.has(candidate)) throw new Error(`${label} must not contain a cycle`);
    state.active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new Error(`${label} arrays must use the standard prototype`);
        }
        const length = candidate.length;
        if (length > TIKTOK_DELETE_PERMISSION_MAX_ARRAY_ITEMS) {
          throw new Error(
            `${label} arrays must contain at most ${TIKTOK_DELETE_PERMISSION_MAX_ARRAY_ITEMS} items`,
          );
        }
        if (state.nodes + length > TIKTOK_DELETE_PERMISSION_MAX_JSON_NODES) {
          throw new Error(`${label} exceeds its JSON structural bound`);
        }
        const ownKeys = Reflect.ownKeys(candidate);
        const expectedKeys = new Set<PropertyKey>([
          "length",
          ...Array.from({ length }, (_unused, index) => String(index)),
        ]);
        if (
          ownKeys.length !== expectedKeys.size
          || ownKeys.some((key) => !expectedKeys.has(key))
        ) throw new Error(`${label} arrays must be dense data arrays without named fields`);
        addTikTokDeletePermissionJsonBytes(state, 2 + Math.max(0, length - 1));
        const cloned: TikTokDeletePermissionJson[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (
            descriptor === undefined
            || !descriptor.enumerable
            || !("value" in descriptor)
          ) throw new Error(`${label} arrays must contain only enumerable data elements`);
          cloned.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(cloned);
      }
      const prototype: unknown = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} objects must use a plain prototype`);
      }
      const ownKeys = Reflect.ownKeys(candidate);
      if (ownKeys.some((key) => typeof key !== "string")) {
        throw new Error(`${label} objects must not contain symbol fields`);
      }
      if (state.nodes + ownKeys.length > TIKTOK_DELETE_PERMISSION_MAX_JSON_NODES) {
        throw new Error(`${label} exceeds its JSON structural bound`);
      }
      const keys = (ownKeys as string[]).sort((left, right) => left.localeCompare(right));
      let objectBytes = 2 + Math.max(0, keys.length - 1) + keys.length;
      for (const key of keys) {
        if (Buffer.byteLength(key, "utf8") > TIKTOK_DELETE_PERMISSION_MAX_KEY_BYTES) {
          throw new Error(`${label} contains an oversized property name`);
        }
        objectBytes += Buffer.byteLength(JSON.stringify(key), "utf8");
      }
      addTikTokDeletePermissionJsonBytes(state, objectBytes);
      const cloned = Object.create(null) as Record<string, TikTokDeletePermissionJson>;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !("value" in descriptor)
        ) throw new Error(`${label} objects must contain only enumerable data properties`);
        cloned[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(cloned);
    } finally {
      state.active.delete(candidate);
    }
  };
  return visit(value, 0);
}

/** Parse the sanitized heterogeneous permission array selected from edit_post_info. */
export function parseTikTokDeletePermissionProjection(
  value: unknown,
): Readonly<{ recyclable: boolean }> {
  const snapshot = snapshotTikTokDeletePermissionJson(
    value,
    "TikTok delete permission projection",
  );
  const projection = record(snapshot, "TikTok delete permission projection");
  exactObjectKeys(projection, ["biz_permissions"], [], "TikTok delete permission projection");
  if (
    !Array.isArray(projection.biz_permissions)
    || projection.biz_permissions.length < 1
    || projection.biz_permissions.length > 64
  ) throw new Error("TikTok delete permission projection must contain bounded permissions");
  let recyclable: boolean | null = null;
  for (const [index, rawPermission] of projection.biz_permissions.entries()) {
    const permission = record(rawPermission, `TikTok delete permission ${index + 1}`);
    if (!Object.hasOwn(permission, "is_recyclable")) continue;
    if (recyclable !== null) {
      throw new Error("TikTok delete permission projection must contain exactly one is_recyclable owner");
    }
    recyclable = boolean(
      permission.is_recyclable,
      `TikTok delete permission ${index + 1}.is_recyclable`,
    );
  }
  if (recyclable === null) {
    throw new Error("TikTok delete permission projection must contain exactly one is_recyclable owner");
  }
  return Object.freeze({ recyclable });
}

export function buildTikTokPublishedPostDeleteBody(input: {
  readonly postId: unknown;
  readonly recyclable: unknown;
}): Readonly<Record<string, unknown>> {
  if (input.recyclable !== true) {
    throw new Error("TikTok recycle-bin deletion requires exact is_recyclable true permission");
  }
  return Object.freeze({
    aweme_id: decimalId(input.postId, "TikTok delete post ID"),
    scene: 1,
    delete: Object.freeze({ delete_type: 1 }),
  });
}
