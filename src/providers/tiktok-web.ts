import { createHash, createHmac } from "node:crypto";
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
    evidence: "live-har",
    requests: noRequests(),
    reason: "an authorized disposable lifecycle proves exact account-bound list/detail preflight, recyclable permission, and one accepted recycle response, but the post-list miss and canonical soft-200 shell are not a strict tombstone, and the mutation requires in-origin ACrawler/ZTI proof that the direct cookie transport cannot reproduce",
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
    reason: "an authorized private disposable publish proves two Apply/Commit cycles, one project-post acceptance, exact caption/audience settings, and account-bound readback, but observed TOS traffic differs from the unexecuted multipart projections and project dispatch still requires reviewed in-origin ACrawler/ZTI proof generation",
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
 * request envelopes, authenticated response envelopes, and readback shapes
 * remain capture-required.
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
    "provider-selected upload node, TOS origin, and authenticated response binding",
    "mutating Studio common-query request envelopes",
    "exact authenticated upload, transfer, commit, publish, status, and recycle response envelopes",
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

/**
 * Secret-free structural facts retained from one authorized private video
 * publish/readback/recycle-bin lifecycle. The disposable post ID, actor,
 * caption, project ID, cookies, proof material, request values, and signed
 * media URLs are deliberately absent. This closes response/readback semantics
 * but not executable transport authority: Studio generated ACrawler/ZTI proof
 * in-origin, and the observed TOS exchanges did not match the unexecuted
 * phase=init|transfer|finish projections below.
 */
export const tiktokWebDisposableVideoLifecycleEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "live-authorized-disposable-cycle" as const,
  observedOn: "2026-08-24",
  origin: "https://www.tiktok.com",
  media: Object.freeze({
    mediaType: "video/mp4" as const,
    binding: "exact-plan-bound-private-fixture" as const,
    audience: "private" as const,
  }),
  publish: Object.freeze({
    uploadAuth: "GET /api/v1/video/upload/auth/ HTTP 200",
    applyCommitCycles: 2,
    projectCreate: "POST /tiktok/web/project/post/v1/ HTTP 200",
    projectResponseBinding: Object.freeze([
      "status_code=0",
      "project_id",
      "single_post_resp_list[0].item_id",
      "single_post_resp_list[0].status_code=0",
    ] as const),
    readback: Object.freeze([
      "bound current account",
      "exact item ID",
      "exact caption",
      "private visibility",
    ] as const),
  }),
  recycle: Object.freeze({
    preflight: Object.freeze([
      "account-bound exact-caption content-list presence",
      "GET /api/v1/post/detail/ HTTP 200 with exact item binding",
      "exact caption binding",
      "is_recyclable=true permission",
    ] as const),
    mutation: Object.freeze({
      request: "POST /tiktok/post/edit/v1/ HTTP 200",
      scene: 1,
      deleteType: 1,
      acceptedResponseBinding: Object.freeze([
        "status_code=0",
        "exact item ID",
      ] as const),
    }),
    readback: Object.freeze({
      absenceProven: false,
      contentListMissProvesAbsence: false,
      independentCanonicalObservation:
        "exact canonical post URL became a soft-200 shell without the target video, caption, or media",
      providerRecycleFolder: "app-only" as const,
    }),
  }),
  executableAudit: Object.freeze({
    containedBrowser: Object.freeze({
      availablePrimitive:
        "code-owned same-origin evaluation with bounded post-request network observation",
      state: "insufficient" as const,
      blockers: Object.freeze([
        "no reviewed Studio interceptor revision is bound before dispatch",
        "network observation can attest emitted request metadata only after the write may have started",
        "a generic evaluated fetch does not prove ACrawler/ZTI attached the captured request shape",
      ] as const),
    }),
    mediaPublish: Object.freeze({
      state: "capture-required" as const,
      blockers: Object.freeze([
        "live TOS requests do not match the unexecuted phase-based multipart projections",
        "project publish requires in-origin ACrawler interception and AB-gated ZTI proof",
        "no reviewed proof-only transport can produce and bind those ephemeral values",
      ] as const),
    }),
    contentDelete: Object.freeze({
      state: "capture-required" as const,
      blockers: Object.freeze([
        "recycle dispatch requires in-origin ACrawler interception and AB-gated ZTI proof",
        "the cookie-only web-session client cannot generate or attest that proof",
        "post-list nonappearance and an unmarked canonical soft-200 shell are not strict tombstone evidence",
      ] as const),
    }),
  }),
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

export type TikTokStudioRuntimeSecurityProjection = Readonly<{
  acrawler: "required" | "not-listed-for-route";
  antiCsrf: "required" | "not-listed-for-route";
  credentials: "include";
  csrfHeader: "in-origin-ephemeral" | "not-explicit-for-route";
  execution: "authenticated-in-origin-studio-session";
  verifyFp: "not-requested-by-base-query";
  zti: "ab-gated" | "not-listed-for-route";
}>;

export type TikTokStudioRequestProjection = TikTokBundleRequestProjection & Readonly<{
  runtimeSecurity: TikTokStudioRuntimeSecurityProjection;
}>;

/**
 * Secret-free request-security facts from the current public Studio bundles.
 * The named SDKs run inside the authenticated Studio origin. This snapshot
 * neither contains nor authorizes synthesizing a CSRF token, fingerprint, or
 * proof header outside that origin.
 */
export const tiktokWebStudioSecurityEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "bundle-evidence-only" as const,
  observedOn: "2026-08-24",
  aid: 1988,
  baseQuery: Object.freeze({
    aid: "1988",
    ttp2TargetIdc: "useast8",
    verifyFp: "first-profile-read-only-request-only" as const,
  }),
  acrawler: Object.freeze({
    intercept: true,
    mode: 513,
    paths: Object.freeze([
      "/api/v1/web/project/post",
      "/api/v1/item/create/bulk/",
      "/api/v1/item/create/",
      "/api/upload/search/user/",
      "/api/upload/challenge/sug/",
      "/api/post/item_list/",
      "/api/v1/user/profile/upload/",
      "/api/v1/video/upload/auth/",
      "/api/v1/draft/create_update/",
      "/tiktok/web/project/post/v1/",
      "/tiktok/web/project/cancel/v1/",
      "/tiktok/post/edit/v1/",
      "/api/user/list/",
    ]),
  }),
  antiCsrf: Object.freeze({
    host: "www.tiktok.com",
    method: "POST" as const,
    paths: Object.freeze([
      "/api/v1/post_schedule/ack/",
      "/api/v1/video/transcode/enable/",
    ]),
  }),
  zti: Object.freeze({
    abGate: "creation_use_zti",
    certType: "header",
    scene: "tt_fetch",
    signVersion: 2,
    paths: Object.freeze([
      "/api/v1/web/project/post/",
      "/api/v1/item/create/bulk/",
      "/tiktok/web/project/post/v1/",
      "/tiktok/post/edit/v1/",
    ]),
  }),
});

/**
 * Secret-free facts retained from the authenticated, read-only Studio upload
 * page. No credential value, cookie, account content, or raw response is
 * retained by this snapshot.
 */
export const tiktokWebVideoUploadAuthLiveEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "live-read-only-evidence" as const,
  observedOn: "2026-08-24",
  origin: "https://www.tiktok.com",
  request: "GET /api/v1/video/upload/auth/?aid=1988",
  status: 200,
  contentType: "application/json; charset=utf-8",
  storeRegion: "US",
  videoSpaceName: "tiktok",
  clockFormat: "YYYY-MM-DDTHH:mm:ssZ",
});

export const TIKTOK_VIDEO_UPLOADER_REGIONS = Object.freeze({
  ttp: Object.freeze({
    publicRegion: "ttp" as const,
    signingRegion: "US-TTP" as const,
    targetIdc: null,
    useServerCurrentTime: true as const,
    videoUrl: "https://www.tiktok.com/top/v1" as const,
  }),
  ttp2: Object.freeze({
    publicRegion: "ttp2" as const,
    signingRegion: "US-TTP" as const,
    targetIdc: "useast8" as const,
    useServerCurrentTime: true as const,
    videoUrl: "https://www.tiktok.com/top/v1" as const,
  }),
});

export type TikTokVideoUploaderPublicRegion = keyof typeof TIKTOK_VIDEO_UPLOADER_REGIONS;

export function resolveTikTokVideoUploaderRegion(
  value: unknown,
): (typeof TIKTOK_VIDEO_UPLOADER_REGIONS)[TikTokVideoUploaderPublicRegion] {
  if (value !== "ttp" && value !== "ttp2") {
    throw new Error("TikTok uploader public region is not bundle-proven");
  }
  return TIKTOK_VIDEO_UPLOADER_REGIONS[value];
}

/** Build the exact upload-auth read observed from the current Studio page. */
export function buildTikTokVideoUploadAuthRequest(): TikTokBundleRequestProjection {
  return Object.freeze({
    method: "GET",
    path: "/api/v1/video/upload/auth/",
    query: Object.freeze({ aid: "1988" }),
  });
}

export type TikTokVideoUploadTokenProjection = Readonly<{
  accessKeyId: string;
  clockState: "reviewed-utc-second";
  expiresAtIso: string;
  secretAccessKey: string;
  serverCurrentTimeIso: string;
  sessionToken: string;
}>;

function tikTokAuthUtcSecond(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
  ) throw new Error(`${label} must use the reviewed UTC-second wire format`);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== `${value.slice(0, -1)}.000Z`
  ) throw new Error(`${label} is not a canonical UTC instant`);
  return new Date(milliseconds).toISOString();
}

type ParsedTikTokUploadAuthToken = Readonly<{
  accessKeyId: string;
  currentTimeIso: string;
  expiresAtIso: string;
  secretAccessKey: string;
  sessionToken: string;
}>;

function parseTikTokUploadAuthToken(
  value: unknown,
  label: string,
  expectedSpaceName: "tt_audio_mode" | "tiktok-ai-frame" | "tiktok",
): ParsedTikTokUploadAuthToken {
  const token = record(value, label);
  exactObjectKeys(token, [
    "access_key_id",
    "current_time",
    "expired_time",
    "secret_acess_key",
    "session_token",
    "space_name",
  ], [], label);
  if (token.space_name !== expectedSpaceName) {
    throw new Error(`${label}.space_name changed its reviewed value`);
  }
  const currentTimeIso = tikTokAuthUtcSecond(token.current_time, `${label}.current_time`);
  const expiresAtIso = tikTokAuthUtcSecond(token.expired_time, `${label}.expired_time`);
  if (Date.parse(expiresAtIso) <= Date.parse(currentTimeIso)) {
    throw new Error(`${label} must expire after its server current time`);
  }
  return Object.freeze({
    accessKeyId: bundleId(token.access_key_id, `${label}.access_key_id`, 256),
    currentTimeIso,
    expiresAtIso,
    secretAccessKey: opaqueBundleString(
      token.secret_acess_key,
      `${label}.secret_acess_key`,
      4_096,
    ),
    sessionToken: opaqueBundleString(
      token.session_token,
      `${label}.session_token`,
      16_384,
    ),
  });
}

/** Parse the full exact upload-auth envelope retained by the read-only capture. */
export function parseTikTokVideoUploadTokenProjection(
  value: unknown,
): TikTokVideoUploadTokenProjection {
  const root = record(value, "TikTok upload-auth projection");
  exactObjectKeys(root, [
    "ak",
    "audio_token_v5",
    "auth",
    "extra",
    "log_pb",
    "status_code",
    "status_msg",
    "store_region",
    "vframe_token_v5",
    "video_token_v5",
  ], [], "TikTok upload-auth projection");
  opaqueBundleString(root.ak, "TikTok upload-auth projection.ak", 256);
  opaqueBundleString(root.auth, "TikTok upload-auth projection.auth", 1_024);
  if (root.status_code !== 0 || root.status_msg !== "") {
    throw new Error("TikTok upload-auth projection did not report exact success");
  }
  if (root.store_region !== "US") {
    throw new Error("TikTok upload-auth projection store_region changed its reviewed value");
  }
  const extra = record(root.extra, "TikTok upload-auth projection.extra");
  exactObjectKeys(extra, [
    "fatal_item_ids",
    "logid",
    "now",
  ], [], "TikTok upload-auth projection.extra");
  if (!Array.isArray(extra.fatal_item_ids) || extra.fatal_item_ids.length !== 0) {
    throw new Error("TikTok upload-auth projection.extra.fatal_item_ids must stay empty");
  }
  opaqueBundleString(extra.logid, "TikTok upload-auth projection.extra.logid", 256);
  integer(
    extra.now,
    "TikTok upload-auth projection.extra.now",
    1_000_000_000_000,
    9_999_999_999_999,
  );
  const logPb = record(root.log_pb, "TikTok upload-auth projection.log_pb");
  exactObjectKeys(logPb, ["impr_id"], [], "TikTok upload-auth projection.log_pb");
  opaqueBundleString(logPb.impr_id, "TikTok upload-auth projection.log_pb.impr_id", 256);
  parseTikTokUploadAuthToken(
    root.audio_token_v5,
    "TikTok upload-auth audio_token_v5",
    "tt_audio_mode",
  );
  parseTikTokUploadAuthToken(
    root.vframe_token_v5,
    "TikTok upload-auth vframe_token_v5",
    "tiktok-ai-frame",
  );
  const token = parseTikTokUploadAuthToken(
    root.video_token_v5,
    "TikTok upload-auth video_token_v5",
    "tiktok",
  );
  return Object.freeze({
    accessKeyId: token.accessKeyId,
    clockState: "reviewed-utc-second",
    expiresAtIso: token.expiresAtIso,
    secretAccessKey: token.secretAccessKey,
    serverCurrentTimeIso: token.currentTimeIso,
    sessionToken: token.sessionToken,
  });
}

export type TikTokVideoReviewedServerClock = Readonly<{
  localAcquiredAtIso: string;
  serverCurrentTimeIso: string;
  systemTimeGapMs: number;
}>;

function exactTikTokIsoInstant(value: unknown, label: string): string {
  const text = opaqueBundleString(value, label, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new Error(`${label} must be an exact reviewed ISO instant`);
  }
  return text;
}

/**
 * Model the pinned SDK's `useServerCurrentTime` branch only after another
 * boundary has proven date-compatible ISO instants. A gap of at most 60s is
 * ignored; a larger first gap is retained and later applied to local time.
 */
export function bindTikTokVideoReviewedServerClock(input: {
  readonly localAcquiredAtIso: unknown;
  readonly serverCurrentTimeIso: unknown;
  readonly useServerCurrentTime: unknown;
}): TikTokVideoReviewedServerClock {
  if (input.useServerCurrentTime !== true) {
    throw new Error("TikTok reviewed server clock requires useServerCurrentTime true");
  }
  const localAcquiredAtIso = exactTikTokIsoInstant(
    input.localAcquiredAtIso,
    "TikTok local auth acquisition time",
  );
  const serverCurrentTimeIso = exactTikTokIsoInstant(
    input.serverCurrentTimeIso,
    "TikTok reviewed server current time",
  );
  const gap = new Date(serverCurrentTimeIso).getTime()
    - new Date(localAcquiredAtIso).getTime();
  return Object.freeze({
    localAcquiredAtIso,
    serverCurrentTimeIso,
    systemTimeGapMs: Math.abs(gap) > 60_000 ? gap : 0,
  });
}

export function tikTokVideoReviewedSigningTime(
  clock: TikTokVideoReviewedServerClock,
  localNowIsoValue: unknown,
): string {
  if (!isRecord(clock)) throw new Error("TikTok reviewed server clock must be exact");
  exactObjectKeys(clock as JsonRecord, [
    "localAcquiredAtIso",
    "serverCurrentTimeIso",
    "systemTimeGapMs",
  ], [], "TikTok reviewed server clock");
  exactTikTokIsoInstant(clock.localAcquiredAtIso, "TikTok local auth acquisition time");
  exactTikTokIsoInstant(clock.serverCurrentTimeIso, "TikTok reviewed server current time");
  const systemTimeGapMs = integer(
    clock.systemTimeGapMs,
    "TikTok reviewed system time gap",
    -86_400_000,
    86_400_000,
  );
  const localNowIso = exactTikTokIsoInstant(localNowIsoValue, "TikTok local signing time");
  return new Date(new Date(localNowIso).getTime() + systemTimeGapMs).toISOString();
}

export function buildTikTokApplyUploadInnerRequest(input: {
  readonly fileSize: number;
  readonly nonce: string;
  readonly publicRegion: unknown;
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
  const region = resolveTikTokVideoUploaderRegion(input.publicRegion);
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
      "X-Amz-Expires": "604800",
      ...(region.targetIdc === null ? {} : { "tt-target-idc": region.targetIdc }),
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
  let parsedHeader: unknown = node.UploadHeader;
  if (typeof parsedHeader === "string") {
    const uploadHeader = opaqueBundleString(parsedHeader, `${label}.UploadHeader`, 16_384);
    try {
      parsedHeader = JSON.parse(uploadHeader) as unknown;
    } catch {
      throw new Error(`${label}.UploadHeader must be exact JSON`);
    }
  }
  if (!isRecord(parsedHeader) || Object.keys(parsedHeader).length !== 0) {
    throw new Error(`${label}.UploadHeader must be the reviewed empty header object`);
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

/**
 * One immediate TOS transport projection. Authorization is response-selected
 * ephemeral material and must never be persisted in a plan, receipt, log, or
 * fixture. The origin, object path, and authorization all come from the same
 * strictly parsed ApplyUploadInner node.
 */
export type TikTokTosRequestProjection = TikTokBundleRequestProjection & Readonly<{
  headers: Readonly<Record<string, string>>;
  origin: string;
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

function revalidateTikTokApplyUploadNodeProjection(
  value: unknown,
): TikTokApplyUploadNodeProjection {
  const node = record(value, "TikTok selected ApplyUploadInner node");
  exactObjectKeys(node, [
    "authorization",
    "sessionKey",
    "storeUri",
    "uploadHost",
    "uploadId",
  ], [], "TikTok selected ApplyUploadInner node");
  return Object.freeze({
    authorization: opaqueBundleString(
      node.authorization,
      "TikTok selected TOS authorization",
      16_384,
    ),
    sessionKey: bundleId(node.sessionKey, "TikTok selected TOS session key", 4_096),
    storeUri: bundleId(node.storeUri, "TikTok selected TOS store URI", 2_048),
    uploadHost: exactHttpsUploadHost(node.uploadHost, "TikTok selected TOS upload host"),
    uploadId: tosUploadId(node.uploadId),
  });
}

function tikTokTosHeaders(
  node: TikTokApplyUploadNodeProjection,
  subjectIdValue: unknown,
  crc32?: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    Authorization: node.authorization,
    "X-Storage-U": encodeURIComponent(decimalId(
      subjectIdValue,
      "TikTok current upload subject ID",
    )),
    ...(crc32 === undefined ? {} : { "Content-CRC32": crc32 }),
  });
}

export function buildTikTokTosInitRequest(input: {
  readonly node: unknown;
  readonly subjectId: unknown;
}): TikTokTosRequestProjection {
  if (!isRecord(input)) throw new Error("TikTok TOS init input must be an object");
  exactObjectKeys(input as JsonRecord, ["node", "subjectId"], [], "TikTok TOS init input");
  const node = revalidateTikTokApplyUploadNodeProjection(input.node);
  return Object.freeze({
    headers: tikTokTosHeaders(node, input.subjectId),
    method: "POST",
    origin: node.uploadHost,
    path: tosObjectPath(node.storeUri),
    query: Object.freeze({ uploadmode: "part", phase: "init" }),
  });
}

export function buildTikTokTosTransferRequest(input: {
  readonly crc32: string;
  readonly node: unknown;
  readonly part: TikTokTosPart;
  readonly subjectId: unknown;
  readonly uploadId: unknown;
}): TikTokTosRequestProjection {
  if (!isRecord(input)) throw new Error("TikTok TOS transfer input must be an object");
  exactObjectKeys(
    input as JsonRecord,
    ["crc32", "node", "part", "subjectId", "uploadId"],
    [],
    "TikTok TOS transfer input",
  );
  if (!isRecord(input.part)) throw new Error("TikTok TOS transfer part must be an object");
  exactObjectKeys(
    input.part as unknown as JsonRecord,
    ["byteLength", "byteOffset", "partNumber"],
    [],
    "TikTok TOS transfer part",
  );
  const node = revalidateTikTokApplyUploadNodeProjection(input.node);
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
    headers: tikTokTosHeaders(node, input.subjectId, crc32),
    method: "POST",
    origin: node.uploadHost,
    path: tosObjectPath(node.storeUri),
    query: Object.freeze({
      uploadid: tosUploadId(input.uploadId),
      part_number: String(partNumber),
      phase: "transfer",
      part_offset: String(byteOffset),
    }),
  });
}

export function buildTikTokTosFinishRequest(input: {
  readonly byteLength: unknown;
  readonly node: unknown;
  readonly subjectId: unknown;
  readonly uploadId: unknown;
}): TikTokTosRequestProjection {
  if (!isRecord(input)) throw new Error("TikTok TOS finish input must be an object");
  exactObjectKeys(
    input as JsonRecord,
    ["byteLength", "node", "subjectId", "uploadId"],
    [],
    "TikTok TOS finish input",
  );
  const node = revalidateTikTokApplyUploadNodeProjection(input.node);
  return Object.freeze({
    headers: tikTokTosHeaders(node, input.subjectId),
    method: "POST",
    origin: node.uploadHost,
    path: tosObjectPath(node.storeUri),
    query: Object.freeze({
      uploadmode: "part",
      phase: "finish",
      size: String(integer(
        input.byteLength,
        "TikTok TOS finish byte length",
        24,
        MAX_TIKTOK_VIDEO_PUBLISH_BYTES,
      )),
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
  publicRegionValue: unknown,
): TikTokBundleRequestProjection {
  const sessionKey = bundleId(sessionKeyValue, "TikTok CommitUploadInner SessionKey", 4_096);
  const region = resolveTikTokVideoUploaderRegion(publicRegionValue);
  return Object.freeze({
    method: "POST",
    path: "/top/v1",
    query: Object.freeze({
      Action: "CommitUploadInner",
      Version: "2020-11-19",
      SpaceName: "tiktok",
      "X-Amz-Expires": "604800",
      ...(region.targetIdc === null ? {} : { "tt-target-idc": region.targetIdc }),
    }),
    body: Object.freeze({
      SessionKey: sessionKey,
      Functions: Object.freeze([Object.freeze({ name: "GetMeta" })]),
    }),
  });
}

export type TikTokVideoTopRequestInput =
  | Readonly<{
      fileSize: unknown;
      kind: "apply";
      nonce: unknown;
    }>
  | Readonly<{
      kind: "commit";
      sessionKey: unknown;
    }>;

export type TikTokSignedVideoTopRequest = Readonly<{
  bodyText: string | null;
  headers: Readonly<Record<string, string>>;
  request: TikTokBundleRequestProjection;
  signingTimeUnixMs: number;
  url: string;
}>;

function tikTokAwsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function tikTokCanonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.keys(query).sort().map((name) =>
    `${tikTokAwsEncode(name)}=${tikTokAwsEncode(query[name]!)}`
  ).join("&");
}

function tikTokHmacSha256(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function tikTokAmzDate(unixMs: number): string {
  const date = new Date(unixMs);
  if (!Number.isFinite(date.getTime())) throw new Error("TikTok upload signing time is invalid");
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

/**
 * Deterministically sign only one code-owned ApplyUploadInner or
 * CommitUploadInner projection. Host selection comes from the pinned public
 * region map, while credential scope uses `US-TTP`; no caller-selected URL,
 * region, request, headers, or query is accepted.
 */
export function signTikTokVideoTopRequest(input: {
  readonly publicRegion: unknown;
  readonly request: TikTokVideoTopRequestInput;
  readonly reviewedSigningTimeIso: unknown;
  readonly token: TikTokVideoUploadTokenProjection;
}): TikTokSignedVideoTopRequest {
  if (!isRecord(input.request)) throw new Error("TikTok signed top request input must be exact");
  const request = input.request.kind === "apply"
    ? (() => {
        exactObjectKeys(
          input.request as JsonRecord,
          ["fileSize", "kind", "nonce"],
          [],
          "TikTok signed ApplyUploadInner input",
        );
        return buildTikTokApplyUploadInnerRequest({
          fileSize: input.request.fileSize as number,
          nonce: input.request.nonce as string,
          publicRegion: input.publicRegion,
        });
      })()
    : input.request.kind === "commit"
      ? (() => {
          exactObjectKeys(
            input.request as JsonRecord,
            ["kind", "sessionKey"],
            [],
            "TikTok signed CommitUploadInner input",
          );
          return buildTikTokCommitUploadInnerRequest(
            input.request.sessionKey,
            input.publicRegion,
          );
        })()
      : (() => {
          throw new Error("TikTok signed top request kind is not bundle-proven");
        })();
  const region = resolveTikTokVideoUploaderRegion(input.publicRegion);
  if (!isRecord(input.token)) throw new Error("TikTok upload signing token must be exact");
  exactObjectKeys(input.token as JsonRecord, [
    "accessKeyId",
    "clockState",
    "expiresAtIso",
    "secretAccessKey",
    "serverCurrentTimeIso",
    "sessionToken",
  ], [], "TikTok upload signing token");
  if (input.token.clockState !== "reviewed-utc-second") {
    throw new Error("TikTok upload signing token clock state changed shape");
  }
  bundleId(input.token.accessKeyId, "TikTok upload signing access key", 256);
  exactTikTokIsoInstant(input.token.expiresAtIso, "TikTok upload signing expiry");
  opaqueBundleString(input.token.secretAccessKey, "TikTok upload signing secret key", 4_096);
  exactTikTokIsoInstant(
    input.token.serverCurrentTimeIso,
    "TikTok upload signing server current time",
  );
  opaqueBundleString(input.token.sessionToken, "TikTok upload signing session token", 16_384);
  const reviewedSigningTimeIso = exactTikTokIsoInstant(
    input.reviewedSigningTimeIso,
    "TikTok reviewed upload signing time",
  );
  const signingTimeUnixMs = new Date(reviewedSigningTimeIso).getTime();
  const amzDate = tikTokAmzDate(signingTimeUnixMs);
  const shortDate = amzDate.slice(0, 8);
  const bodyText = request.body === undefined ? null : JSON.stringify(request.body);
  const bodyHash = createHash("sha256").update(bodyText ?? "", "utf8").digest("hex");
  const unsignedHeaders: Record<string, string> = {
    "x-amz-date": amzDate,
    "x-amz-security-token": input.token.sessionToken,
    ...(bodyText === null ? {} : { "x-amz-content-sha256": bodyHash }),
  };
  const signedHeaderNames = Object.keys(unsignedHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map((name) =>
    `${name}:${unsignedHeaders[name]!.replace(/\s+/gu, " ").trim()}`
  ).join("\n");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    request.method,
    request.path,
    tikTokCanonicalQuery(request.query),
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodyHash,
  ].join("\n");
  const credentialScope = `${shortDate}/${region.signingRegion}/vod/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const dateKey = tikTokHmacSha256(`AWS4${input.token.secretAccessKey}`, shortDate);
  const regionKey = tikTokHmacSha256(dateKey, region.signingRegion);
  const serviceKey = tikTokHmacSha256(regionKey, "vod");
  const signingKey = tikTokHmacSha256(serviceKey, "aws4_request");
  const signature = tikTokHmacSha256(signingKey, stringToSign).toString("hex");
  const url = new URL(region.videoUrl);
  for (const [name, value] of Object.entries(request.query)) {
    url.searchParams.set(name, value);
  }
  return Object.freeze({
    bodyText,
    headers: Object.freeze({
      ...unsignedHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.token.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }),
    request,
    signingTimeUnixMs,
    url: url.href,
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

export const TIKTOK_VIDEO_TRANSCODE_POLL_INTERVAL_MS = 1_000;
export const TIKTOK_VIDEO_TRANSCODE_POLL_TIMEOUT_MS = 3_600_000;

export type TikTokVideoTranscodeState =
  | "unknown"
  | "init"
  | "in-progress"
  | "success"
  | "failed";

const TIKTOK_VIDEO_TRANSCODE_STATES = Object.freeze([
  "unknown",
  "init",
  "in-progress",
  "success",
  "failed",
] as const satisfies readonly TikTokVideoTranscodeState[]);

const TIKTOK_TRANSCODE_ENABLE_RUNTIME_SECURITY = Object.freeze({
  acrawler: "not-listed-for-route" as const,
  antiCsrf: "required" as const,
  credentials: "include" as const,
  csrfHeader: "in-origin-ephemeral" as const,
  execution: "authenticated-in-origin-studio-session" as const,
  verifyFp: "not-requested-by-base-query" as const,
  zti: "not-listed-for-route" as const,
});

const TIKTOK_UNLISTED_STUDIO_RUNTIME_SECURITY = Object.freeze({
  acrawler: "not-listed-for-route" as const,
  antiCsrf: "not-listed-for-route" as const,
  credentials: "include" as const,
  csrfHeader: "not-explicit-for-route" as const,
  execution: "authenticated-in-origin-studio-session" as const,
  verifyFp: "not-requested-by-base-query" as const,
  zti: "not-listed-for-route" as const,
});

function tikTokStudioBaseQuery(
  publicRegionValue: unknown,
): Readonly<Record<string, string>> {
  const region = resolveTikTokVideoUploaderRegion(publicRegionValue);
  return Object.freeze({
    aid: "1988",
    ...(region.targetIdc === null ? {} : { "tt-target-idc": region.targetIdc }),
  });
}

/** Build the bundle-proven transcode-enablement projection without a CSRF value. */
export function buildTikTokVideoTranscodeEnableRequestProjection(input: {
  readonly publicRegion: unknown;
  readonly videoId: unknown;
}): TikTokStudioRequestProjection {
  if (!isRecord(input)) throw new Error("TikTok transcode enable input must be an object");
  exactObjectKeys(
    input as JsonRecord,
    ["publicRegion", "videoId"],
    [],
    "TikTok transcode enable input",
  );
  return Object.freeze({
    method: "POST",
    path: "/api/v1/video/transcode/enable/",
    query: Object.freeze({
      video_id: bundleId(input.videoId, "TikTok transcode video_id", 2_048),
      ...tikTokStudioBaseQuery(input.publicRegion),
    }),
    runtimeSecurity: TIKTOK_TRANSCODE_ENABLE_RUNTIME_SECURITY,
  });
}

/**
 * Build one bundle-proven transcode-result poll. The raw authenticated response
 * envelope remains capture-required; this projection never guesses it.
 */
export function buildTikTokVideoTranscodeResultRequestProjection(input: {
  readonly durationSeconds: unknown;
  readonly fileKey: unknown;
  readonly height: unknown;
  readonly publicRegion: unknown;
  readonly videoId: unknown;
  readonly width: unknown;
}): TikTokStudioRequestProjection {
  if (!isRecord(input)) throw new Error("TikTok transcode result input must be an object");
  exactObjectKeys(input as JsonRecord, [
    "durationSeconds",
    "fileKey",
    "height",
    "publicRegion",
    "videoId",
    "width",
  ], [], "TikTok transcode result input");
  if (
    typeof input.durationSeconds !== "number"
    || !Number.isFinite(input.durationSeconds)
    || input.durationSeconds < 0
    || input.durationSeconds > 86_400
  ) throw new Error("TikTok transcode durationSeconds must be finite and between 0 and 86400");
  const videoInfo = Object.freeze({
    file_key: bundleId(input.fileKey, "TikTok transcode file_key", 2_048),
    video_id: bundleId(input.videoId, "TikTok transcode video_id", 2_048),
    original_width: integer(input.width, "TikTok transcode original_width", 1, 65_535),
    original_height: integer(input.height, "TikTok transcode original_height", 1, 65_535),
    original_duration_ms: Math.ceil(input.durationSeconds * 1_000),
  });
  return Object.freeze({
    body: Object.freeze({
      scene: 0,
      video_info: Object.freeze([videoInfo]),
    }),
    method: "POST",
    path: "/api/v1/video/transcode/result/",
    query: tikTokStudioBaseQuery(input.publicRegion),
    runtimeSecurity: TIKTOK_UNLISTED_STUDIO_RUNTIME_SECURITY,
  });
}

/** Classify only the public bundle's exact transcode status enum. */
export function resolveTikTokVideoTranscodeState(value: unknown): TikTokVideoTranscodeState {
  return TIKTOK_VIDEO_TRANSCODE_STATES[
    integer(value, "TikTok transcode status", 0, 4)
  ]!;
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

export const TIKTOK_VIDEO_VISIBILITY_TYPES = Object.freeze({
  public: 0 as const,
  private: 1 as const,
  friends: 2 as const,
});

/**
 * Build only the bundle-proven plain-video payload projection. The caller may
 * not dispatch this payload alone: its in-origin interception requirements,
 * authenticated response envelope, and independent readback remain separate
 * trust boundaries.
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
  const visibilityType = TIKTOK_VIDEO_VISIBILITY_TYPES[plan.audience];
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
        visibility_type: visibilityType,
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
  publicRegionValue: unknown,
): TikTokStudioRequestProjection {
  return Object.freeze({
    method: "GET",
    path: "/tiktok/web/project/status/v1/",
    query: Object.freeze({
      project_id: bundleId(projectIdValue, "TikTok project status project_id", 512),
      ...tikTokStudioBaseQuery(publicRegionValue),
    }),
    runtimeSecurity: TIKTOK_UNLISTED_STUDIO_RUNTIME_SECURITY,
  });
}

export const TIKTOK_PROJECT_STATUS_POLL_POLICY = Object.freeze({
  defaultDelayMs: 10_000,
  maxPostingObservations: 50,
  plainVideoInitialDelaysMs: Object.freeze([0, 1_000, 1_000, 1_000, 1_000]),
  videoEditedInitialDelaysMs: Object.freeze([10_000, 5_000, 5_000, 5_000, 5_000]),
});

export function buildTikTokProjectPublishRequestProjection(
  plan: TikTokVideoProjectPlan,
  binding: TikTokVideoProjectBinding,
  runtime: Readonly<{
    publicRegion: unknown;
    resolvedTimeZone: unknown;
  }>,
): TikTokStudioRequestProjection {
  if (!isRecord(runtime)) throw new Error("TikTok project publish runtime must be an object");
  exactObjectKeys(
    runtime as JsonRecord,
    ["publicRegion", "resolvedTimeZone"],
    [],
    "TikTok project publish runtime",
  );
  return Object.freeze({
    body: buildTikTokVideoProjectPayloadProjection(plan, binding),
    method: "POST",
    path: "/tiktok/web/project/post/v1/",
    query: Object.freeze({
      app_name: "tiktok_web",
      channel: "tiktok_web",
      device_platform: "web",
      tz_name: tikTokRuntimeIanaTimeZone(runtime.resolvedTimeZone),
      ...tikTokStudioBaseQuery(runtime.publicRegion),
    }),
    runtimeSecurity: Object.freeze({
      acrawler: "required",
      antiCsrf: "not-listed-for-route",
      credentials: "include",
      csrfHeader: "not-explicit-for-route",
      execution: "authenticated-in-origin-studio-session",
      verifyFp: "not-requested-by-base-query",
      zti: "ab-gated",
    }),
  });
}

export type TikTokProjectPublishProjection = Readonly<{
  batchIndex: 0;
  postId: string;
  projectId: string;
}>;

/** Parse only the exact secret-free project-publish result projection. */
export function parseTikTokProjectPublishProjection(
  value: unknown,
): TikTokProjectPublishProjection {
  const root = record(value, "TikTok project publish projection");
  exactObjectKeys(
    root,
    ["project_id", "single_post_resp_list", "status_code"],
    [],
    "TikTok project publish projection",
  );
  if (root.status_code !== 0) {
    throw new Error("TikTok project publish projection did not report status_code 0");
  }
  if (!Array.isArray(root.single_post_resp_list) || root.single_post_resp_list.length !== 1) {
    throw new Error("TikTok project publish projection must contain one exact post result");
  }
  const item = record(
    root.single_post_resp_list[0],
    "TikTok project publish projection.single_post_resp_list[0]",
  );
  exactObjectKeys(
    item,
    ["batch_index", "item_id", "status_code"],
    [],
    "TikTok project publish projection.single_post_resp_list[0]",
  );
  if (item.batch_index !== 0 || item.status_code !== 0) {
    throw new Error("TikTok project publish post result did not bind batch 0 success");
  }
  return Object.freeze({
    batchIndex: 0,
    postId: decimalId(item.item_id, "TikTok project publish item_id"),
    projectId: bundleId(root.project_id, "TikTok project publish project_id", 512),
  });
}

export type TikTokProjectState =
  | "unknown"
  | "posting"
  | "success"
  | "failed"
  | "vediting";

export type TikTokProjectTaskState = "unknown" | "posting" | "success" | "failed";

export type TikTokProjectStatusProjection = Readonly<{
  state: TikTokProjectState;
  tasks: readonly Readonly<{
    postId: string | null;
    state: TikTokProjectTaskState;
  }>[];
}>;

const TIKTOK_PROJECT_STATES = Object.freeze([
  "unknown",
  "posting",
  "success",
  "failed",
  "vediting",
] as const satisfies readonly TikTokProjectState[]);

const TIKTOK_PROJECT_TASK_STATES = Object.freeze([
  "unknown",
  "posting",
  "success",
  "failed",
] as const satisfies readonly TikTokProjectTaskState[]);

/**
 * Parse the bundle-retained status projection without converting a missing
 * task item ID into post absence or completion evidence.
 */
export function parseTikTokProjectStatusProjection(
  value: unknown,
  expectedPostIdValue?: unknown,
): TikTokProjectStatusProjection {
  const root = record(value, "TikTok project status projection");
  exactObjectKeys(
    root,
    ["project_status", "task_list"],
    [],
    "TikTok project status projection",
  );
  const projectStatus = integer(
    root.project_status,
    "TikTok project status projection.project_status",
    0,
    4,
  );
  if (!Array.isArray(root.task_list) || root.task_list.length < 1 || root.task_list.length > 16) {
    throw new Error("TikTok project status projection must contain bounded tasks");
  }
  const expectedPostId = expectedPostIdValue === undefined
    ? null
    : decimalId(expectedPostIdValue, "expected TikTok project-status post ID");
  const tasks = root.task_list.map((rawTask, index) => {
    const task = record(rawTask, `TikTok project status task ${index + 1}`);
    exactObjectKeys(
      task,
      ["task_status"],
      ["item_id"],
      `TikTok project status task ${index + 1}`,
    );
    const taskStatus = integer(
      task.task_status,
      `TikTok project status task ${index + 1}.task_status`,
      0,
      3,
    );
    const postId = task.item_id === undefined || task.item_id === null
      ? null
      : decimalId(task.item_id, `TikTok project status task ${index + 1}.item_id`);
    if (expectedPostId !== null && postId !== null && postId !== expectedPostId) {
      throw new Error("TikTok project status switched the accepted post ID");
    }
    return Object.freeze({
      postId,
      state: TIKTOK_PROJECT_TASK_STATES[taskStatus]!,
    });
  });
  return Object.freeze({
    state: TIKTOK_PROJECT_STATES[projectStatus]!,
    tasks: Object.freeze(tasks),
  });
}

/**
 * Build the exact read-only Studio detail request. The time zone is runtime
 * context derived by the executor, never a semantic-operation input.
 */
export function buildTikTokPostDetailRequestProjection(
  postIdValue: unknown,
  resolvedTimeZoneValue: unknown,
): TikTokBundleRequestProjection {
  const resolvedTimeZone = tikTokRuntimeIanaTimeZone(resolvedTimeZoneValue);
  return Object.freeze({
    method: "GET",
    path: "/api/v1/post/detail/",
    query: Object.freeze({
      tz_name: resolvedTimeZone,
      item_id: decimalId(postIdValue, "TikTok detail post ID"),
      aid: "1988",
    }),
  });
}

function tikTokRuntimeIanaTimeZone(resolvedTimeZoneValue: unknown): string {
  const resolvedTimeZone = requiredString(
    resolvedTimeZoneValue,
    "TikTok runtime IANA time zone",
    128,
  );
  if (!/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/u.test(resolvedTimeZone)) {
    throw new Error("TikTok runtime time zone must be a bounded IANA name");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: resolvedTimeZone }).format(0);
  } catch {
    throw new Error("TikTok runtime time zone must be a recognized IANA name");
  }
  return resolvedTimeZone;
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

/** Parse the exact permission array selected from edit_post_info. */
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
  let recyclableOwners = 0;
  for (const [index, rawPermission] of projection.biz_permissions.entries()) {
    const permission = record(rawPermission, `TikTok delete permission ${index + 1}`);
    const label = `TikTok delete permission ${index + 1}`;
    exactObjectKeys(
      permission,
      ["biz_reason", "biz_status", "biz_type"],
      ["is_recyclable"],
      label,
    );
    integer(permission.biz_reason, `${label}.biz_reason`);
    integer(permission.biz_status, `${label}.biz_status`);
    integer(permission.biz_type, `${label}.biz_type`);
    if (!Object.hasOwn(permission, "is_recyclable")) continue;
    const isRecyclable = boolean(
      permission.is_recyclable,
      `${label}.is_recyclable`,
    );
    if (isRecyclable) {
      recyclableOwners += 1;
      if (recyclableOwners > 1) {
        throw new Error(
          "TikTok delete permission projection must contain at most one exact true is_recyclable permission",
        );
      }
    }
  }
  return Object.freeze({ recyclable: recyclableOwners === 1 });
}

/**
 * Parse only the permission branch retained from authored-post detail. This
 * projection does not prove the target actor, caption, presence, tombstone, or
 * absence; those bindings remain capture-required.
 */
export function parseTikTokPostDetailDeletePermissionProjection(
  value: unknown,
): Readonly<{ recyclable: boolean }> {
  const snapshot = snapshotTikTokDeletePermissionJson(
    value,
    "TikTok post-detail permission projection",
  );
  const root = record(snapshot, "TikTok post-detail permission projection");
  exactObjectKeys(
    root,
    ["edit_post_info"],
    [],
    "TikTok post-detail permission projection",
  );
  const editPostInfo = record(
    root.edit_post_info,
    "TikTok post-detail permission projection.edit_post_info",
  );
  exactObjectKeys(
    editPostInfo,
    ["edit_post_permission"],
    [],
    "TikTok post-detail permission projection.edit_post_info",
  );
  const permission = record(
    editPostInfo.edit_post_permission,
    "TikTok post-detail permission projection.edit_post_permission",
  );
  exactObjectKeys(
    permission,
    ["biz_permissions", "visibility_permission"],
    [],
    "TikTok post-detail permission projection.edit_post_permission",
  );
  const visibilityPermission = record(
    permission.visibility_permission,
    "TikTok post-detail permission projection.edit_post_permission.visibility_permission",
  );
  const visibilityFields = [
    "available_for_ads",
    "everyone",
    "followers",
    "friends",
    "only_you",
    "sub_only",
  ] as const;
  exactObjectKeys(
    visibilityPermission,
    visibilityFields,
    [],
    "TikTok post-detail permission projection.edit_post_permission.visibility_permission",
  );
  for (const field of visibilityFields) {
    integer(
      visibilityPermission[field],
      `TikTok post-detail permission projection.edit_post_permission.visibility_permission.${field}`,
    );
  }
  return parseTikTokDeletePermissionProjection({
    biz_permissions: permission.biz_permissions,
  });
}

export function buildTikTokPublishedPostDeleteBody(input: {
  readonly postId: unknown;
  readonly projectId: unknown;
  readonly recyclable: unknown;
}): Readonly<Record<string, unknown>> {
  if (input.recyclable !== true) {
    throw new Error("TikTok recycle-bin deletion requires exact is_recyclable true permission");
  }
  const projectId = input.projectId === undefined
    ? undefined
    : bundleId(input.projectId, "TikTok delete project ID", 512);
  return Object.freeze({
    aweme_id: decimalId(input.postId, "TikTok delete post ID"),
    ...(projectId === undefined ? {} : { project_id: projectId }),
    scene: 1,
    delete: Object.freeze({ delete_type: 1 }),
  });
}

export function buildTikTokPublishedPostRecycleRequest(input: {
  readonly postId: unknown;
  readonly projectId: unknown;
  readonly recyclable: unknown;
}): TikTokBundleRequestProjection {
  return Object.freeze({
    body: buildTikTokPublishedPostDeleteBody(input),
    method: "POST",
    path: "/tiktok/post/edit/v1/",
    query: Object.freeze({}),
  });
}

/**
 * This is the required execution ordering for any future durable transport.
 * ApplyUploadInner may allocate provider state despite using GET, so durable
 * dispatch admission must precede it and every later mutation; conditional
 * processing and project-status polls stay ordered after their trigger.
 */
export const TIKTOK_VIDEO_DURABLE_DISPATCH_ORDER = Object.freeze([
  "beforeDispatch",
  "ApplyUploadInner",
  "TOS.init",
  "TOS.transfer",
  "TOS.finish",
  "CommitUploadInner",
  "transcode.enable-if-required",
  "transcode.result-until-terminal-if-required",
  "project.publish",
  "project.status-until-terminal",
] as const);
