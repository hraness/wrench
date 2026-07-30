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

export type TikTokWebOperationContract = {
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
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: noRequests(),
    reason: "upload initialization, byte transfer, declarations, audience, and publish require separate reviewed contracts",
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

export type TikTokWebR1OperationId = "viewer.current" | "feeds.for-you" | "comments.list";

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
