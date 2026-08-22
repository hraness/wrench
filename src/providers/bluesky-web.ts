import { canonicalJson } from "../canonical-json";

/**
 * Bluesky authenticated first-party API policy and bounded projections.
 *
 * The browser is used only to select the current account from the exact
 * `BSKY_STORAGE` entry. All semantic reads and writes use fixed AT
 * Protocol/XRPC or Bluesky chat procedures through the account's reviewed PDS
 * origin.
 */

export const BLUESKY_WEB_OPERATION_NAMES = Object.freeze([
  "comments.read",
  "content.delete",
  "content.save",
  "content.share",
  "feeds.read",
  "likes.set",
  "media.publish",
  "media.read",
  "messaging.list",
  "messaging.read",
  "messaging.send",
  "profiles.read",
  "posts.publish",
  "posts.quote",
  "posts.read",
  "posts.repost",
  "relationships.follow.set",
  "replies.create",
  "threads.publish",
] as const);

export type BlueskyWebOperationName =
  (typeof BLUESKY_WEB_OPERATION_NAMES)[number];
export type BlueskyWebContractState = "observed" | "capture-required";
export type BlueskyWebRisk = "R1" | "R2" | "R3";

export type BlueskyWebOperationContract = {
  readonly effect: "read" | "write";
  readonly risk: BlueskyWebRisk;
  readonly state: BlueskyWebContractState;
  readonly reason: string;
};

const captureRequired = (
  effect: "read" | "write",
  risk: BlueskyWebRisk,
  reason: string,
): BlueskyWebOperationContract => Object.freeze({
  effect,
  risk,
  state: "capture-required",
  reason,
});

const observed = (
  effect: "read" | "write",
  risk: BlueskyWebRisk,
  reason: string,
): BlueskyWebOperationContract => Object.freeze({
  effect,
  risk,
  state: "observed",
  reason,
});

export const BLUESKY_WEB_OPERATIONS = Object.freeze({
  "profiles.read": observed(
    "read",
    "R1",
    "fixed getProfile AppView read binds the exact requested handle and projects exact follower, following, and post counts",
  ),
  "feeds.read": observed(
    "read",
    "R1",
    "fixed getTimeline, listNotifications, and getBookmarks XRPC reads are account-bound and project bounded results",
  ),
  "posts.read": observed(
    "read",
    "R1",
    "fixed getPosts XRPC reads bind the exact requested AT URI and project one bounded post",
  ),
  "comments.read": observed(
    "read",
    "R1",
    "fixed getPostThread XRPC reads bind the exact requested AT URI and bound the reply projection",
  ),
  "media.read": observed(
    "read",
    "R1",
    "fixed getPosts XRPC reads project attachment metadata without returning media URLs",
  ),
  "media.publish": captureRequired(
    "write",
    "R3",
    "the video-service upload job, bounded processing poll, response-bound blob, repository record, and authoritative record plus AppView readback need an authorized fixture",
  ),
  "messaging.list": captureRequired(
    "read",
    "R1",
    "the fixed listConvos query needs a live nonempty conversation fixture proving bsky_chat proxy routing and viewer membership projection",
  ),
  "messaging.read": captureRequired(
    "read",
    "R1",
    "the fixed getConvo and getMessages queries need a live conversation fixture proving exact membership, conversation binding, and message projection",
  ),
  "likes.set": captureRequired(
    "write",
    "R2",
    "the code-owned desired-state like exchange needs an authorized live fixture proving create/delete and independent readback",
  ),
  "content.save": captureRequired(
    "write",
    "R2",
    "the code-owned private bookmark exchange needs an authorized live fixture proving create/delete and independent readback",
  ),
  "content.delete": observed(
    "write",
    "R3",
    "exact current-account app.bsky.feed.post deletion uses an authoritative PDS pre-read, CID compare-and-swap, strict commit response, and authoritative RecordNotFound readback",
  ),
  "relationships.follow.set": captureRequired(
    "write",
    "R2",
    "the code-owned desired-state follow exchange needs an authorized live fixture proving create/delete and independent readback",
  ),
  "posts.repost": captureRequired(
    "write",
    "R3",
    "the code-owned repost exchange needs an authorized live fixture proving create/delete and independent readback",
  ),
  "posts.publish": observed(
    "write",
    "R3",
    "current code-owned plain-text and single-image uploadBlob/createRecord path with durable accepted-target evidence, authoritative getRecord binding, and bounded independent getPosts projection readback",
  ),
  "replies.create": captureRequired(
    "write",
    "R3",
    "the code-owned reply path needs an authorized live fixture proving exact root, parent, response, and readback binding",
  ),
  "posts.quote": captureRequired(
    "write",
    "R3",
    "the code-owned quote path needs an authorized live fixture proving the embedded strong reference and independent readback",
  ),
  "threads.publish": captureRequired(
    "write",
    "R3",
    "the code-owned one-to-twenty-five dispatch path needs an authorized live fixture proving every ordered root/reply readback",
  ),
  "messaging.send": captureRequired(
    "write",
    "R3",
    "the code-owned sendMessage path needs an authorized live fixture proving conversation, sender, response, and getMessages readback binding",
  ),
  "content.share": captureRequired(
    "write",
    "R3",
    "Bluesky exposes repost and quote as distinct supported operations; no separate native share mutation is proven",
  ),
} as const satisfies Readonly<
  Record<BlueskyWebOperationName, BlueskyWebOperationContract>
>);

export const BLUESKY_APP_ORIGIN = "https://bsky.app";
export const BLUESKY_APPVIEW_PROXY =
  "did:web:api.bsky.app#bsky_appview";
export const BLUESKY_NOTIFICATION_PROXY =
  "did:web:api.bsky.app#bsky_notif";
export const BLUESKY_CHAT_PROXY =
  "did:web:api.bsky.chat#bsky_chat";

const MAX_RESPONSE_ITEMS = 1_000;
const MAX_TEXT = 32_768;
const didPattern =
  /^did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9._:%-]{1,240})$/u;
const handlePattern =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const cidPattern = /^b[a-z2-7]{10,200}$/u;
const rkeyPattern = /^[A-Za-z0-9._~:@!$&'()*+,;=-]{1,512}$/u;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} omitted ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size > 0) {
    throw new Error(`${label} contained unsupported fields`);
  }
}

function string(
  value: unknown,
  label: string,
  maximum = MAX_TEXT,
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

function optionalString(
  value: unknown,
  label: string,
  maximum = MAX_TEXT,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return string(value, label, maximum);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) throw new Error(`${label} must be a bounded integer`);
  return value as number;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return integer(value, label);
}

function boundedArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_RESPONSE_ITEMS) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value;
}

export function blueskyDid(value: unknown, label = "Bluesky DID"): string {
  const result = string(value, label, 255);
  if (!didPattern.test(result)) throw new Error(`${label} must be an exact DID`);
  return result;
}

export function blueskyCid(value: unknown, label = "Bluesky CID"): string {
  const result = string(value, label, 201);
  if (!cidPattern.test(result)) throw new Error(`${label} must be a CIDv1`);
  return result;
}

export type BlueskyAtUri = {
  readonly uri: string;
  readonly actor: string;
  readonly collection: string;
  readonly rkey: string;
};

export function parseBlueskyAtUri(
  value: unknown,
  label = "Bluesky AT URI",
  expectedCollection?: string,
): BlueskyAtUri {
  const uri = string(value, label, 1_024);
  const match = /^at:\/\/([^/]+)\/([a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,})\/([^/]+)$/u.exec(uri);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`${label} must be an exact record AT URI`);
  }
  const actor = blueskyDid(match[1], `${label} actor`);
  const collection = string(match[2], `${label} collection`, 255);
  if (
    expectedCollection !== undefined
    && collection !== expectedCollection
  ) throw new Error(`${label} must identify ${expectedCollection}`);
  if (!rkeyPattern.test(match[3])) throw new Error(`${label} has an invalid record key`);
  return Object.freeze({ uri, actor, collection, rkey: match[3] });
}

export function blueskyPostUri(
  value: unknown,
  label = "Bluesky post URI",
): BlueskyAtUri {
  return parseBlueskyAtUri(value, label, "app.bsky.feed.post");
}

function exactHttpsOrigin(value: unknown, label: string): string {
  const source = string(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error(`${label} must be an exact canonical HTTPS origin`);
  const hostname = url.hostname.toLowerCase();
  if (
    hostname !== "bsky.social"
    && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.host\.bsky\.network$/u.test(hostname)
  ) throw new Error(`${label} is outside the reviewed Bluesky PDS host allowlist`);
  return url.origin;
}

function decodeJwtPayload(token: string, label: "access" | "refresh"): JsonRecord {
  const parts = token.split(".");
  if (
    parts.length !== 3
    || parts.some((part) => !/^[A-Za-z0-9_-]{1,8192}$/u.test(part))
  ) throw new Error(`Bluesky ${label} token is not a bounded JWT`);
  let decoded: string;
  try {
    decoded = Buffer.from(parts[1]!, "base64url").toString("utf8");
  } catch {
    throw new Error(`Bluesky ${label} token payload is invalid`);
  }
  if (decoded.length < 2 || decoded.length > 16_384) {
    throw new Error(`Bluesky ${label} token payload exceeded its reviewed bound`);
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new Error(`Bluesky ${label} token payload is malformed`);
  }
  return record(value, `Bluesky ${label} token payload`);
}

export type BlueskySessionMaterial = {
  readonly did: string;
  readonly handle: string;
  readonly accessJwt: string;
  readonly refreshJwt: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly pdsOrigin: string;
};

/**
 * Parse the minimal bootstrap envelope produced by the sealed browser
 * evaluator. Refresh material crosses the boundary only so the code-owned PDS
 * refresh procedure can rotate an expired access token into wrench's encrypted
 * session cache; it is never emitted, logged, or stored in the auth locator.
 */
export function parseBlueskyBootstrapAccount(
  value: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000),
): BlueskySessionMaterial {
  const account = record(value, "Bluesky browser bootstrap account");
  exactKeys(
    account,
    ["did", "handle", "accessJwt", "refreshJwt", "service", "pdsUrl"],
    [],
    "Bluesky browser bootstrap account",
  );
  const did = blueskyDid(account.did);
  const handle = string(account.handle, "Bluesky handle", 253);
  if (!handlePattern.test(handle)) throw new Error("Bluesky handle is invalid");
  const accessJwt = string(account.accessJwt, "Bluesky access token", 24_576);
  if (/[\s]/u.test(accessJwt)) throw new Error("Bluesky access token is invalid");
  const refreshJwt = string(account.refreshJwt, "Bluesky refresh token", 24_576);
  if (/[\s]/u.test(refreshJwt)) throw new Error("Bluesky refresh token is invalid");
  const pdsOrigin = exactHttpsOrigin(
    account.pdsUrl ?? account.service,
    "Bluesky PDS origin",
  );
  const accessClaims = decodeJwtPayload(accessJwt, "access");
  const refreshClaims = decodeJwtPayload(refreshJwt, "refresh");
  if (accessClaims.sub !== did) throw new Error("Bluesky access token subject did not match the selected account");
  if (refreshClaims.sub !== did) throw new Error("Bluesky refresh token subject did not match the selected account");
  if (
    !Number.isSafeInteger(nowSeconds)
    || nowSeconds < 0
    || !Number.isSafeInteger(accessClaims.exp)
    || !Number.isSafeInteger(refreshClaims.exp)
  ) throw new Error("Bluesky session tokens lack a valid expiry");
  const accessExpiresAt = accessClaims.exp as number;
  const refreshExpiresAt = refreshClaims.exp as number;
  if (refreshExpiresAt <= nowSeconds) throw new Error("Bluesky refresh token is expired");
  return Object.freeze({
    did,
    handle,
    accessJwt,
    refreshJwt,
    accessExpiresAt,
    refreshExpiresAt,
    pdsOrigin,
  });
}

export function parseBlueskyRefreshSessionResponse(
  value: unknown,
  selected: Pick<BlueskySessionMaterial, "did" | "pdsOrigin">,
  nowSeconds = Math.floor(Date.now() / 1_000),
): BlueskySessionMaterial {
  const session = record(value, "Bluesky refresh-session response");
  exactKeys(
    session,
    ["accessJwt", "refreshJwt", "handle", "did"],
    [
      "didDoc",
      "email",
      "emailConfirmed",
      "emailAuthFactor",
      "active",
      "status",
    ],
    "Bluesky refresh-session response",
  );
  const did = blueskyDid(session.did, "Bluesky refreshed DID");
  if (did !== selected.did) {
    throw new Error("Bluesky refresh-session DID did not match the selected account");
  }
  const handle = string(session.handle, "Bluesky refreshed handle", 253);
  if (!handlePattern.test(handle)) throw new Error("Bluesky refreshed handle is invalid");
  if (session.active === false || session.status !== undefined) {
    throw new Error("Bluesky refresh-session response reported an inactive account");
  }
  const accessJwt = string(session.accessJwt, "Bluesky refreshed access token", 24_576);
  const refreshJwt = string(session.refreshJwt, "Bluesky rotated refresh token", 24_576);
  if (/[\s]/u.test(accessJwt) || /[\s]/u.test(refreshJwt)) {
    throw new Error("Bluesky refresh-session response returned an invalid token");
  }
  const accessClaims = decodeJwtPayload(accessJwt, "access");
  const refreshClaims = decodeJwtPayload(refreshJwt, "refresh");
  if (accessClaims.sub !== did || refreshClaims.sub !== did) {
    throw new Error("Bluesky refreshed token subject did not match the selected account");
  }
  if (
    !Number.isSafeInteger(nowSeconds)
    || nowSeconds < 0
    || !Number.isSafeInteger(accessClaims.exp)
    || !Number.isSafeInteger(refreshClaims.exp)
  ) throw new Error("Bluesky refreshed session tokens lack a valid expiry");
  const accessExpiresAt = accessClaims.exp as number;
  const refreshExpiresAt = refreshClaims.exp as number;
  if (accessExpiresAt <= nowSeconds || refreshExpiresAt <= nowSeconds) {
    throw new Error("Bluesky refresh-session response returned an expired token");
  }
  return Object.freeze({
    did,
    handle,
    accessJwt,
    refreshJwt,
    accessExpiresAt,
    refreshExpiresAt,
    pdsOrigin: selected.pdsOrigin,
  });
}

export const BLUESKY_XRPC_METHODS = Object.freeze({
  "com.atproto.server.getSession": "GET",
  "com.atproto.server.refreshSession": "POST",
  "app.bsky.feed.getTimeline": "GET",
  "app.bsky.feed.getPosts": "GET",
  "app.bsky.feed.getPostThread": "GET",
  "app.bsky.notification.listNotifications": "GET",
  "app.bsky.bookmark.getBookmarks": "GET",
  "app.bsky.actor.getProfile": "GET",
  "chat.bsky.convo.listConvos": "GET",
  "chat.bsky.convo.getConvo": "GET",
  "chat.bsky.convo.getMessages": "GET",
  "com.atproto.repo.getRecord": "GET",
  "com.atproto.repo.createRecord": "POST",
  "com.atproto.repo.deleteRecord": "POST",
  "com.atproto.repo.uploadBlob": "POST",
  "app.bsky.bookmark.createBookmark": "POST",
  "app.bsky.bookmark.deleteBookmark": "POST",
  "chat.bsky.convo.sendMessage": "POST",
} as const);

export type BlueskyXrpcMethod = keyof typeof BLUESKY_XRPC_METHODS;

export type BlueskyRequestBinding = {
  readonly nsid: BlueskyXrpcMethod;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly queryNames: readonly string[];
  readonly proxy:
    | typeof BLUESKY_APPVIEW_PROXY
    | typeof BLUESKY_NOTIFICATION_PROXY
    | typeof BLUESKY_CHAT_PROXY
    | null;
};

const BLUESKY_XRPC_PROXIES = Object.freeze({
  "com.atproto.server.getSession": null,
  "com.atproto.server.refreshSession": null,
  "app.bsky.feed.getTimeline": BLUESKY_APPVIEW_PROXY,
  "app.bsky.feed.getPosts": BLUESKY_APPVIEW_PROXY,
  "app.bsky.feed.getPostThread": BLUESKY_APPVIEW_PROXY,
  "app.bsky.notification.listNotifications": BLUESKY_NOTIFICATION_PROXY,
  "app.bsky.bookmark.getBookmarks": BLUESKY_APPVIEW_PROXY,
  "app.bsky.actor.getProfile": BLUESKY_APPVIEW_PROXY,
  "chat.bsky.convo.listConvos": BLUESKY_CHAT_PROXY,
  "chat.bsky.convo.getConvo": BLUESKY_CHAT_PROXY,
  "chat.bsky.convo.getMessages": BLUESKY_CHAT_PROXY,
  "com.atproto.repo.getRecord": null,
  "com.atproto.repo.createRecord": null,
  "com.atproto.repo.deleteRecord": null,
  "com.atproto.repo.uploadBlob": null,
  "app.bsky.bookmark.createBookmark": BLUESKY_APPVIEW_PROXY,
  "app.bsky.bookmark.deleteBookmark": BLUESKY_APPVIEW_PROXY,
  "chat.bsky.convo.sendMessage": BLUESKY_CHAT_PROXY,
} as const satisfies Readonly<
  Record<BlueskyXrpcMethod, BlueskyRequestBinding["proxy"]>
>);

export function authorizeBlueskyXrpcRequest(input: {
  readonly pdsOrigin: string;
  readonly nsid: BlueskyXrpcMethod;
  readonly url: string | URL;
  readonly method: string;
  readonly expectedQuery: Readonly<Record<string, readonly string[]>>;
  readonly hasBody: boolean;
  readonly proxy: BlueskyRequestBinding["proxy"];
}): BlueskyRequestBinding {
  const pdsOrigin = exactHttpsOrigin(input.pdsOrigin, "Bluesky request PDS origin");
  const url = input.url instanceof URL ? new URL(input.url.href) : new URL(input.url);
  if (
    url.origin !== pdsOrigin
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.pathname !== `/xrpc/${input.nsid}`
  ) throw new Error("Bluesky request escaped its exact reviewed XRPC endpoint");
  const expectedMethod = BLUESKY_XRPC_METHODS[input.nsid];
  const method = input.method.toUpperCase();
  if (method !== expectedMethod) throw new Error("Bluesky request method changed from its reviewed contract");
  if (input.proxy !== BLUESKY_XRPC_PROXIES[input.nsid]) {
    throw new Error("Bluesky request proxy changed from its reviewed contract");
  }
  const expectsBody = method === "POST"
    && input.nsid !== "com.atproto.server.refreshSession";
  if (input.hasBody !== expectsBody) {
    throw new Error("Bluesky request body did not match its reviewed method");
  }
  const actual = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    const values = actual.get(name) ?? [];
    values.push(value);
    actual.set(name, values);
  }
  const expectedNames = Object.keys(input.expectedQuery).sort();
  if (
    [...actual.keys()].sort().join("\0") !== expectedNames.join("\0")
  ) throw new Error("Bluesky request query names changed from their reviewed contract");
  for (const name of expectedNames) {
    const expectedValues = input.expectedQuery[name] ?? [];
    const actualValues = actual.get(name) ?? [];
    if (
      expectedValues.length !== actualValues.length
      || expectedValues.some((value, index) => actualValues[index] !== value)
    ) throw new Error(`Bluesky request query value ${name} changed from its reviewed contract`);
  }
  return Object.freeze({
    nsid: input.nsid,
    method,
    path: url.pathname,
    queryNames: Object.freeze(expectedNames),
    proxy: input.proxy,
  });
}

export type BlueskyStrongRef = {
  readonly uri: string;
  readonly cid: string;
};

export function blueskyStrongRef(
  value: unknown,
  label: string,
  expectedUri?: string,
): BlueskyStrongRef {
  const candidate = record(value, label);
  const uri = blueskyPostUri(candidate.uri, `${label}.uri`).uri;
  if (expectedUri !== undefined && uri !== expectedUri) {
    throw new Error(`${label} did not match the expected post`);
  }
  return Object.freeze({
    uri,
    cid: blueskyCid(candidate.cid, `${label}.cid`),
  });
}

export type BlueskyProjectedAttachment = {
  readonly kind: "image" | "video" | "external" | "record";
  readonly alt: string | null;
  readonly cid: string | null;
  readonly recordUri: string | null;
  readonly aspectRatio: { readonly width: number; readonly height: number } | null;
};

function aspectRatio(value: unknown, label: string): BlueskyProjectedAttachment["aspectRatio"] {
  if (value === undefined || value === null) return null;
  const ratio = record(value, label);
  return Object.freeze({
    width: integer(ratio.width, `${label}.width`, 1, 100_000),
    height: integer(ratio.height, `${label}.height`, 1, 100_000),
  });
}

function blobCid(value: unknown, label: string): string | null {
  if (!isRecord(value)) return null;
  const ref = isRecord(value.ref) ? value.ref : null;
  if (ref === null || ref.$link === undefined) return null;
  return blueskyCid(ref.$link, `${label}.ref`);
}

export function projectBlueskyAttachments(
  value: unknown,
): readonly BlueskyProjectedAttachment[] {
  if (value === undefined || value === null) return Object.freeze([]);
  const embed = record(value, "Bluesky post embed");
  const type = optionalString(embed.$type, "Bluesky post embed type", 128);
  const results: BlueskyProjectedAttachment[] = [];
  const addMedia = (candidate: unknown): void => {
    const media = record(candidate, "Bluesky media embed");
    const mediaType = optionalString(media.$type, "Bluesky media embed type", 128);
    if (mediaType?.includes("images")) {
      for (const item of boundedArray(media.images, "Bluesky image list")) {
        const image = record(item, "Bluesky image");
        results.push(Object.freeze({
          kind: "image",
          alt: optionalString(image.alt, "Bluesky image alt", 10_000),
          cid: blobCid(image.image, "Bluesky image blob"),
          recordUri: null,
          aspectRatio: aspectRatio(image.aspectRatio, "Bluesky image aspect ratio"),
        }));
      }
    } else if (mediaType?.includes("video")) {
      results.push(Object.freeze({
        kind: "video",
        alt: optionalString(media.alt, "Bluesky video alt", 10_000),
        cid: optionalString(media.cid, "Bluesky video CID", 201) === null
          ? blobCid(media.video, "Bluesky video blob")
          : blueskyCid(media.cid, "Bluesky video CID"),
        recordUri: null,
        aspectRatio: aspectRatio(media.aspectRatio, "Bluesky video aspect ratio"),
      }));
    } else if (mediaType?.includes("external")) {
      results.push(Object.freeze({
        kind: "external",
        alt: optionalString(
          isRecord(media.external) ? media.external.description : media.description,
          "Bluesky external description",
          10_000,
        ),
        cid: null,
        recordUri: null,
        aspectRatio: null,
      }));
    }
  };
  if (type?.includes("recordWithMedia")) {
    addMedia(embed.media);
    results.push(Object.freeze({
      kind: "record",
      alt: null,
      cid: null,
      recordUri: isRecord(embed.record) && typeof embed.record.uri === "string"
        ? blueskyPostUri(embed.record.uri, "Bluesky embedded record URI").uri
        : null,
      aspectRatio: null,
    }));
  } else if (type?.includes("record")) {
    results.push(Object.freeze({
      kind: "record",
      alt: null,
      cid: null,
      recordUri: isRecord(embed.record) && typeof embed.record.uri === "string"
        ? blueskyPostUri(embed.record.uri, "Bluesky embedded record URI").uri
        : typeof embed.uri === "string"
          ? blueskyPostUri(embed.uri, "Bluesky embedded record URI").uri
          : null,
      aspectRatio: null,
    }));
  } else {
    addMedia(embed);
  }
  if (results.length > 4) throw new Error("Bluesky post embed exceeded the reviewed attachment limit");
  return Object.freeze(results);
}

export type BlueskyProjectedPost = {
  readonly uri: string;
  readonly cid: string;
  readonly author: {
    readonly did: string;
    readonly handle: string;
    readonly displayName: string | null;
  };
  readonly text: string;
  readonly createdAt: string;
  readonly indexedAt: string;
  readonly reply: {
    readonly root: BlueskyStrongRef;
    readonly parent: BlueskyStrongRef;
  } | null;
  readonly quote: BlueskyStrongRef | null;
  readonly counts: {
    readonly replies: number | null;
    readonly reposts: number | null;
    readonly likes: number | null;
    readonly quotes: number | null;
  };
  readonly viewer: {
    readonly like: string | null;
    readonly repost: string | null;
    readonly bookmarked: boolean;
  };
  readonly attachments: readonly BlueskyProjectedAttachment[];
};

export function projectBlueskyPost(
  value: unknown,
  expectedUri?: string,
): BlueskyProjectedPost {
  const post = record(value, "Bluesky post");
  const uri = blueskyPostUri(post.uri).uri;
  if (expectedUri !== undefined && uri !== expectedUri) {
    throw new Error("Bluesky post response did not bind the requested post");
  }
  const author = record(post.author, "Bluesky post author");
  const authorDid = blueskyDid(author.did, "Bluesky post author DID");
  if (blueskyPostUri(uri).actor !== authorDid) {
    throw new Error("Bluesky post author did not match its AT URI");
  }
  const handle = string(author.handle, "Bluesky post author handle", 253);
  if (!handlePattern.test(handle)) throw new Error("Bluesky post author handle is invalid");
  const postRecord = record(post.record, "Bluesky post record");
  if (postRecord.$type !== "app.bsky.feed.post") {
    throw new Error("Bluesky post record had an unexpected type");
  }
  const replyRecord = postRecord.reply;
  const reply = replyRecord === undefined
    ? null
    : (() => {
        const refs = record(replyRecord, "Bluesky reply reference");
        return Object.freeze({
          root: blueskyStrongRef(refs.root, "Bluesky reply root"),
          parent: blueskyStrongRef(refs.parent, "Bluesky reply parent"),
        });
      })();
  const recordEmbed = isRecord(postRecord.embed) ? postRecord.embed : null;
  const quoteCandidate = recordEmbed?.$type === "app.bsky.embed.record"
    ? recordEmbed.record
    : recordEmbed?.$type === "app.bsky.embed.recordWithMedia"
      && isRecord(recordEmbed.record)
      ? recordEmbed.record.record
      : undefined;
  const quote = quoteCandidate === undefined
    ? null
    : blueskyStrongRef(quoteCandidate, "Bluesky quoted record");
  const viewer = isRecord(post.viewer) ? post.viewer : {};
  const like = optionalString(viewer.like, "Bluesky viewer like URI", 1_024);
  const repost = optionalString(viewer.repost, "Bluesky viewer repost URI", 1_024);
  if (like !== null) parseBlueskyAtUri(like, "Bluesky viewer like URI", "app.bsky.feed.like");
  if (repost !== null) parseBlueskyAtUri(repost, "Bluesky viewer repost URI", "app.bsky.feed.repost");
  return Object.freeze({
    uri,
    cid: blueskyCid(post.cid),
    author: Object.freeze({
      did: authorDid,
      handle,
      displayName: optionalString(author.displayName, "Bluesky author display name", 1_000),
    }),
    text: string(postRecord.text, "Bluesky post text", 3_000, true),
    createdAt: string(postRecord.createdAt, "Bluesky post creation time", 128),
    indexedAt: string(post.indexedAt, "Bluesky post index time", 128),
    reply,
    quote,
    counts: Object.freeze({
      replies: nullableInteger(post.replyCount, "Bluesky reply count"),
      reposts: nullableInteger(post.repostCount, "Bluesky repost count"),
      likes: nullableInteger(post.likeCount, "Bluesky like count"),
      quotes: nullableInteger(post.quoteCount, "Bluesky quote count"),
    }),
    viewer: Object.freeze({
      like,
      repost,
      bookmarked: viewer.bookmarked === true,
    }),
    attachments: projectBlueskyAttachments(post.embed),
  });
}

export function projectBlueskyPostsResponse(
  value: unknown,
  expectedUri: string,
): BlueskyProjectedPost {
  const response = record(value, "Bluesky getPosts response");
  const posts = boundedArray(response.posts, "Bluesky getPosts posts");
  if (posts.length !== 1) throw new Error("Bluesky getPosts response did not contain one exact post");
  return projectBlueskyPost(posts[0], expectedUri);
}

export function projectBlueskyFeed(
  value: unknown,
  limit: number,
): {
  readonly posts: readonly BlueskyProjectedPost[];
  readonly cursor: string | null;
  readonly truncated: boolean;
} {
  const response = record(value, "Bluesky timeline response");
  const feed = boundedArray(response.feed, "Bluesky timeline feed");
  const posts = feed.slice(0, limit).map((item) =>
    projectBlueskyPost(record(item, "Bluesky timeline item").post)
  );
  return Object.freeze({
    posts: Object.freeze(posts),
    cursor: optionalString(response.cursor, "Bluesky timeline cursor", 8_192),
    truncated: feed.length > limit || response.cursor !== undefined,
  });
}

export function projectBlueskyNotifications(
  value: unknown,
  limit: number,
): {
  readonly notifications: readonly Readonly<Record<string, unknown>>[];
  readonly cursor: string | null;
  readonly seenAt: string | null;
  readonly truncated: boolean;
} {
  const response = record(value, "Bluesky notifications response");
  const source = boundedArray(response.notifications, "Bluesky notifications");
  const notifications = source.slice(0, limit).map((item) => {
    const notification = record(item, "Bluesky notification");
    const author = record(notification.author, "Bluesky notification author");
    const uri = string(notification.uri, "Bluesky notification URI", 1_024);
    parseBlueskyAtUri(uri, "Bluesky notification URI");
    const reasonSubject = optionalString(
      notification.reasonSubject,
      "Bluesky notification subject",
      1_024,
    );
    if (reasonSubject !== null) parseBlueskyAtUri(reasonSubject, "Bluesky notification subject");
    return Object.freeze({
      uri,
      cid: blueskyCid(notification.cid, "Bluesky notification CID"),
      author: Object.freeze({
        did: blueskyDid(author.did, "Bluesky notification author DID"),
        handle: string(author.handle, "Bluesky notification author handle", 253),
        displayName: optionalString(author.displayName, "Bluesky notification author display name", 1_000),
      }),
      reason: string(notification.reason, "Bluesky notification reason", 64),
      reasonSubject,
      isRead: boolean(notification.isRead, "Bluesky notification read state"),
      indexedAt: string(notification.indexedAt, "Bluesky notification index time", 128),
    });
  });
  return Object.freeze({
    notifications: Object.freeze(notifications),
    cursor: optionalString(response.cursor, "Bluesky notifications cursor", 8_192),
    seenAt: optionalString(response.seenAt, "Bluesky notifications seen time", 128),
    truncated: source.length > limit || response.cursor !== undefined,
  });
}

export function projectBlueskyBookmarks(
  value: unknown,
  limit: number,
): {
  readonly posts: readonly BlueskyProjectedPost[];
  readonly cursor: string | null;
  readonly truncated: boolean;
} {
  const response = record(value, "Bluesky bookmarks response");
  const source = boundedArray(response.bookmarks, "Bluesky bookmarks");
  const posts = source.slice(0, limit).map((item) => {
    const bookmark = record(item, "Bluesky bookmark");
    const subject = blueskyStrongRef(bookmark.subject, "Bluesky bookmark subject");
    return projectBlueskyPost(bookmark.item, subject.uri);
  });
  return Object.freeze({
    posts: Object.freeze(posts),
    cursor: optionalString(response.cursor, "Bluesky bookmarks cursor", 8_192),
    truncated: source.length > limit || response.cursor !== undefined,
  });
}

export function projectBlueskyThread(
  value: unknown,
  expectedUri: string,
  limit: number,
): {
  readonly post: BlueskyProjectedPost;
  readonly replies: readonly BlueskyProjectedPost[];
  readonly truncated: boolean;
} {
  const response = record(value, "Bluesky thread response");
  const root = record(response.thread, "Bluesky thread");
  const post = projectBlueskyPost(root.post, expectedUri);
  const replies: BlueskyProjectedPost[] = [];
  const stack: { readonly value: unknown; readonly depth: number }[] = [];
  if (root.replies !== undefined) {
    for (const item of [...boundedArray(root.replies, "Bluesky thread replies")].reverse()) {
      stack.push({ value: item, depth: 1 });
    }
  }
  let visited = 0;
  while (stack.length > 0) {
    const next = stack.pop()!;
    visited += 1;
    if (visited > MAX_RESPONSE_ITEMS || next.depth > 100) {
      throw new Error("Bluesky thread exceeded its reviewed traversal bounds");
    }
    const item = record(next.value, "Bluesky thread reply");
    if (item.post === undefined) continue;
    replies.push(projectBlueskyPost(item.post));
    if (item.replies !== undefined) {
      for (const child of [...boundedArray(item.replies, "Bluesky nested replies")].reverse()) {
        stack.push({ value: child, depth: next.depth + 1 });
      }
    }
  }
  return Object.freeze({
    post,
    replies: Object.freeze(replies.slice(0, limit)),
    truncated: replies.length > limit,
  });
}

export type BlueskyProjectedProfile = {
  readonly did: string;
  readonly handle: string;
  readonly displayName: string | null;
  readonly following: string | null;
  readonly followedBy: string | null;
};

export type BlueskyProfileStats = {
  readonly schemaVersion: 1;
  readonly provider: "bluesky";
  readonly target: {
    readonly kind: "profile";
    readonly id: string;
    readonly url: string;
  };
  readonly observedAt: string;
  readonly completeness: "complete";
  readonly metrics: {
    readonly followers: {
      readonly status: "available";
      readonly value: number;
      readonly precision: "exact";
      readonly unit: "count";
    };
    readonly following: {
      readonly status: "available";
      readonly value: number;
      readonly precision: "exact";
      readonly unit: "count";
    };
    readonly posts: {
      readonly status: "available";
      readonly value: number;
      readonly precision: "exact";
      readonly unit: "count";
    };
  };
  readonly metadata: {
    readonly handle: string;
    readonly displayName: string | null;
    readonly bio: string | null;
  };
};

function exactObservationTime(value: string, label: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) throw new Error(`${label} must be an exact UTC observation time`);
  return value;
}

function exactCountMetric(value: unknown, label: string) {
  return Object.freeze({
    status: "available" as const,
    value: integer(value, label),
    precision: "exact" as const,
    unit: "count" as const,
  });
}

/** Project one exact AppView profile response into the shared profile-stat envelope. */
export function projectBlueskyProfileStats(
  value: unknown,
  expectedHandle: string,
  observedAt: string,
): BlueskyProfileStats {
  if (!handlePattern.test(expectedHandle) || expectedHandle !== expectedHandle.toLowerCase()) {
    throw new Error("Bluesky profile target must be one canonical lowercase handle");
  }
  const profile = record(value, "Bluesky profile stats");
  const handle = string(profile.handle, "Bluesky profile stats handle", 253).toLowerCase();
  if (!handlePattern.test(handle) || handle !== expectedHandle) {
    throw new Error("Bluesky profile stats response did not bind the requested handle");
  }
  const did = blueskyDid(profile.did, "Bluesky profile stats DID");
  const url = `https://bsky.app/profile/${handle}`;
  return Object.freeze({
    schemaVersion: 1,
    provider: "bluesky",
    target: Object.freeze({ kind: "profile", id: did, url }),
    observedAt: exactObservationTime(observedAt, "Bluesky profile stats observedAt"),
    completeness: "complete",
    metrics: Object.freeze({
      followers: exactCountMetric(profile.followersCount, "Bluesky followersCount"),
      following: exactCountMetric(profile.followsCount, "Bluesky followsCount"),
      posts: exactCountMetric(profile.postsCount, "Bluesky postsCount"),
    }),
    metadata: Object.freeze({
      handle,
      displayName: optionalString(
        profile.displayName,
        "Bluesky profile stats display name",
        1_000,
      ),
      bio: optionalString(profile.description, "Bluesky profile stats description", 10_000),
    }),
  });
}

export function projectBlueskyProfile(
  value: unknown,
  expectedDid: string,
): BlueskyProjectedProfile {
  const profile = record(value, "Bluesky profile");
  const did = blueskyDid(profile.did, "Bluesky profile DID");
  if (did !== expectedDid) throw new Error("Bluesky profile response did not bind the requested actor");
  const viewer = isRecord(profile.viewer) ? profile.viewer : {};
  const following = optionalString(viewer.following, "Bluesky following URI", 1_024);
  const followedBy = optionalString(viewer.followedBy, "Bluesky followed-by URI", 1_024);
  if (following !== null) parseBlueskyAtUri(following, "Bluesky following URI", "app.bsky.graph.follow");
  if (followedBy !== null) parseBlueskyAtUri(followedBy, "Bluesky followed-by URI", "app.bsky.graph.follow");
  const handle = string(profile.handle, "Bluesky profile handle", 253);
  if (!handlePattern.test(handle)) throw new Error("Bluesky profile handle is invalid");
  return Object.freeze({
    did,
    handle,
    displayName: optionalString(profile.displayName, "Bluesky profile display name", 1_000),
    following,
    followedBy,
  });
}

export type BlueskyProjectedMessage = {
  readonly id: string;
  readonly rev: string;
  readonly senderDid: string | null;
  readonly text: string | null;
  readonly sentAt: string;
  readonly deleted: boolean;
  readonly system: boolean;
};

export function projectBlueskyMessage(value: unknown): BlueskyProjectedMessage {
  const message = record(value, "Bluesky chat message");
  const sender = isRecord(message.sender) ? message.sender : null;
  const text = optionalString(message.text, "Bluesky chat message text", 10_000);
  return Object.freeze({
    id: string(message.id, "Bluesky chat message ID", 512),
    rev: string(message.rev, "Bluesky chat message revision", 512),
    senderDid: sender === null ? null : blueskyDid(sender.did, "Bluesky chat sender DID"),
    text,
    sentAt: string(message.sentAt, "Bluesky chat sent time", 128),
    deleted: text === null && sender !== null,
    system: text === null && sender === null,
  });
}

export type BlueskyProjectedConvo = {
  readonly id: string;
  readonly rev: string;
  readonly members: readonly {
    readonly did: string;
    readonly handle: string;
    readonly displayName: string | null;
  }[];
  readonly muted: boolean;
  readonly unreadCount: number;
  readonly status: string | null;
  readonly lastMessage: BlueskyProjectedMessage | null;
};

export function projectBlueskyConvo(
  value: unknown,
  viewerDid: string,
  expectedId?: string,
): BlueskyProjectedConvo {
  const convo = record(value, "Bluesky conversation");
  const id = string(convo.id, "Bluesky conversation ID", 512);
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error("Bluesky conversation response did not bind the requested conversation");
  }
  const members = boundedArray(convo.members, "Bluesky conversation members").map((item) => {
    const member = record(item, "Bluesky conversation member");
    const handle = string(member.handle, "Bluesky conversation member handle", 253);
    if (!handlePattern.test(handle)) throw new Error("Bluesky conversation member handle is invalid");
    return Object.freeze({
      did: blueskyDid(member.did, "Bluesky conversation member DID"),
      handle,
      displayName: optionalString(member.displayName, "Bluesky conversation member display name", 1_000),
    });
  });
  if (!members.some((member) => member.did === viewerDid)) {
    throw new Error("Bluesky conversation did not include the bound viewer");
  }
  return Object.freeze({
    id,
    rev: string(convo.rev, "Bluesky conversation revision", 512),
    members: Object.freeze(members),
    muted: boolean(convo.muted, "Bluesky conversation muted state"),
    unreadCount: integer(convo.unreadCount, "Bluesky conversation unread count"),
    status: optionalString(convo.status, "Bluesky conversation status", 64),
    lastMessage: convo.lastMessage === undefined
      ? null
      : projectBlueskyMessage(convo.lastMessage),
  });
}

export function projectBlueskyConvoList(
  value: unknown,
  viewerDid: string,
  limit: number,
): {
  readonly conversations: readonly BlueskyProjectedConvo[];
  readonly cursor: string | null;
  readonly truncated: boolean;
} {
  const response = record(value, "Bluesky conversation list");
  const source = boundedArray(response.convos, "Bluesky conversations");
  return Object.freeze({
    conversations: Object.freeze(
      source.slice(0, limit).map((item) => projectBlueskyConvo(item, viewerDid)),
    ),
    cursor: optionalString(response.cursor, "Bluesky conversation cursor", 8_192),
    truncated: source.length > limit || response.cursor !== undefined,
  });
}

export function projectBlueskyMessages(
  value: unknown,
  limit: number,
): {
  readonly messages: readonly BlueskyProjectedMessage[];
  readonly cursor: string | null;
  readonly truncated: boolean;
} {
  const response = record(value, "Bluesky message list");
  const source = boundedArray(response.messages, "Bluesky messages");
  return Object.freeze({
    messages: Object.freeze(source.slice(0, limit).map(projectBlueskyMessage)),
    cursor: optionalString(response.cursor, "Bluesky message cursor", 8_192),
    truncated: source.length > limit || response.cursor !== undefined,
  });
}

export function parseBlueskySessionResponse(
  value: unknown,
): { readonly did: string; readonly handle: string; readonly active: boolean } {
  const session = record(value, "Bluesky getSession response");
  const handle = string(session.handle, "Bluesky session handle", 253);
  if (!handlePattern.test(handle)) throw new Error("Bluesky session handle is invalid");
  return Object.freeze({
    did: blueskyDid(session.did, "Bluesky session DID"),
    handle,
    active: session.active !== false,
  });
}

export function parseBlueskyCreateRecordResponse(
  value: unknown,
  actorDid: string,
  collection: string,
): BlueskyStrongRef {
  const response = record(value, "Bluesky createRecord response");
  const parsed = parseBlueskyAtUri(
    response.uri,
    "Bluesky created record URI",
    collection,
  );
  if (parsed.actor !== actorDid) throw new Error("Bluesky created record actor did not match the bound viewer");
  return Object.freeze({
    uri: parsed.uri,
    cid: blueskyCid(response.cid, "Bluesky created record CID"),
  });
}

/**
 * Bind one authoritative PDS record read to the exact response-bound record
 * reference and the exact value submitted by the confirmed publish plan.
 */
export function parseBlueskyGetRecordResponse(
  value: unknown,
  expected: BlueskyStrongRef,
  expectedValue: Readonly<Record<string, unknown>>,
): BlueskyStrongRef {
  const response = record(value, "Bluesky getRecord response");
  exactKeys(
    response,
    ["uri", "cid", "value"],
    [],
    "Bluesky getRecord response",
  );
  const actual = blueskyStrongRef(
    response,
    "Bluesky getRecord response",
    expected.uri,
  );
  if (actual.cid !== expected.cid) {
    throw new Error("Bluesky getRecord response changed the created record CID");
  }
  const recordValue = record(
    response.value,
    "Bluesky getRecord response.value",
  );
  if (canonicalJson(recordValue) !== canonicalJson(expectedValue)) {
    throw new Error("Bluesky getRecord response did not bind the confirmed record value");
  }
  return actual;
}

/** Bind the current authoritative PDS revision before deleting one post. */
export function parseBlueskyCurrentPostRecordResponse(
  value: unknown,
  expectedUri: string,
  expectedCid: string,
): BlueskyStrongRef {
  const parsedUri = blueskyPostUri(
    expectedUri,
    "Bluesky deletion target URI",
  );
  const response = record(value, "Bluesky deletion pre-read response");
  exactKeys(
    response,
    ["uri", "cid", "value"],
    [],
    "Bluesky deletion pre-read response",
  );
  const actual = blueskyStrongRef(
    response,
    "Bluesky deletion pre-read response",
    parsedUri.uri,
  );
  if (actual.cid !== blueskyCid(expectedCid, "Bluesky deletion target CID")) {
    throw new Error("Bluesky deletion target revision changed from the confirmed CID");
  }
  const recordValue = record(
    response.value,
    "Bluesky deletion pre-read response.value",
  );
  if (recordValue.$type !== "app.bsky.feed.post") {
    throw new Error("Bluesky deletion target was not an app.bsky.feed.post record");
  }
  return actual;
}

/** Parse only the documented XRPC absence marker for an authoritative record read. */
export function parseBlueskyRecordNotFoundResponse(value: unknown): void {
  const response = record(value, "Bluesky RecordNotFound response");
  exactKeys(
    response,
    ["error", "message"],
    [],
    "Bluesky RecordNotFound response",
  );
  if (response.error !== "RecordNotFound") {
    throw new Error("Bluesky record absence response used an unexpected error code");
  }
  string(
    response.message,
    "Bluesky RecordNotFound response.message",
    1_024,
  );
}

/** Bind the documented optional commit projection returned by deleteRecord. */
export function parseBlueskyDeleteRecordResponse(
  value: unknown,
): { readonly commit: null | { readonly cid: string; readonly rev: string } } {
  const response = record(value, "Bluesky deleteRecord response");
  exactKeys(response, [], ["commit"], "Bluesky deleteRecord response");
  if (response.commit === undefined) return Object.freeze({ commit: null });
  const commit = record(response.commit, "Bluesky deleteRecord response.commit");
  exactKeys(
    commit,
    ["cid", "rev"],
    [],
    "Bluesky deleteRecord response.commit",
  );
  const rev = string(
    commit.rev,
    "Bluesky deleteRecord response.commit.rev",
    64,
  );
  if (!/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/u.test(rev)) {
    throw new Error("Bluesky deleteRecord response.commit.rev must be a TID");
  }
  return Object.freeze({
    commit: Object.freeze({
      cid: blueskyCid(
        commit.cid,
        "Bluesky deleteRecord response.commit.cid",
      ),
      rev,
    }),
  });
}

export type BlueskyBlobRef = {
  readonly $type: "blob";
  readonly ref: { readonly $link: string };
  readonly mimeType: string;
  readonly size: number;
};

export function parseBlueskyUploadBlobResponse(
  value: unknown,
  expectedMimeType: string,
  expectedSize: number,
): BlueskyBlobRef {
  const response = record(value, "Bluesky uploadBlob response");
  const blob = record(response.blob, "Bluesky uploaded blob");
  const ref = record(blob.ref, "Bluesky uploaded blob reference");
  const mimeType = string(blob.mimeType, "Bluesky uploaded blob media type", 128);
  const size = integer(blob.size, "Bluesky uploaded blob size", 1, 100 * 1024 * 1024);
  if (mimeType !== expectedMimeType || size !== expectedSize) {
    throw new Error("Bluesky uploaded blob did not match the confirmed file");
  }
  return Object.freeze({
    $type: "blob",
    ref: Object.freeze({ $link: blueskyCid(ref.$link, "Bluesky uploaded blob CID") }),
    mimeType,
    size,
  });
}

export function assertBlueskyText(
  value: unknown,
  label: string,
  maximumCodePoints: number,
  maximumCodeUnits: number,
): string {
  const text = string(value, label, maximumCodeUnits);
  if (Array.from(text).length > maximumCodePoints) {
    throw new Error(`${label} exceeded ${maximumCodePoints} Unicode code points`);
  }
  return text;
}
