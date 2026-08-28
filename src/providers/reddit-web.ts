/**
 * Reddit consumer-web API policy and bounded response normalization.
 *
 * This module owns exact request shapes. It has no network access and never
 * exposes a raw endpoint, header, cookie, or modhash as a user-facing input.
 */

export const REDDIT_WEB_OPERATION_NAMES = Object.freeze([
  "comments.create",
  "comments.read",
  "communities.membership.set",
  "content.delete",
  "content.edit",
  "content.save",
  "feeds.read",
  "media.publish",
  "media.read",
  "messaging.list",
  "messaging.read",
  "messaging.send",
  "posts.publish",
  "profiles.read",
  "posts.read",
  "posts.repost",
  "reactions.set",
  "relationships.follow.set",
  "replies.create",
] as const);

export type RedditWebOperationName = (typeof REDDIT_WEB_OPERATION_NAMES)[number];
export type RedditWebContractState = "observed" | "capture-required";
export type RedditWebRisk = "R1" | "R2" | "R3";

export type RedditWebOperationContract = {
  readonly effect: "read" | "write";
  readonly risk: RedditWebRisk;
  readonly state: RedditWebContractState;
  readonly reason: string;
};

const observed = (
  effect: "read" | "write",
  risk: RedditWebRisk,
  reason: string,
): RedditWebOperationContract => Object.freeze({
  effect,
  risk,
  state: "observed",
  reason,
});

const captureRequired = (
  effect: "read" | "write",
  risk: RedditWebRisk,
  reason: string,
): RedditWebOperationContract => Object.freeze({
  effect,
  risk,
  state: "capture-required",
  reason,
});

export const REDDIT_WEB_OPERATIONS = Object.freeze({
  "profiles.read": observed(
    "read",
    "R1",
    "viewer-bound profile about JSON plus complete visible overview Listing pagination",
  ),
  "feeds.read": observed(
    "read",
    "R1",
    "signed-in home Listing JSON with explicit raw_json and bounded pagination",
  ),
  "posts.read": observed(
    "read",
    "R1",
    "target-bound comments Listing JSON root projection",
  ),
  "comments.read": observed(
    "read",
    "R1",
    "target-bound comments Listing JSON tree projection",
  ),
  "messaging.list": observed(
    "read",
    "R1",
    "legacy inbox, unread, and sent Listing JSON with mark=false",
  ),
  "messaging.read": observed(
    "read",
    "R1",
    "legacy message Listing JSON filtered by exact mid with mark=false",
  ),
  "reactions.set": captureRequired(
    "write",
    "R2",
    "the exact /api/vote desired-state implementation has deterministic readback tests, but still requires an authorized low-stakes live fixture",
  ),
  "content.save": captureRequired(
    "write",
    "R2",
    "the exact /api/save and /api/unsave desired-state implementation has deterministic readback tests, but still requires an authorized low-stakes live fixture",
  ),
  "communities.membership.set": captureRequired(
    "write",
    "R2",
    "subscribe and unsubscribe form variants and subreddit identity readback need a reviewed fixture",
  ),
  "relationships.follow.set": captureRequired(
    "write",
    "R2",
    "user and post-follow relationships are distinct contracts and need reviewed fixtures",
  ),
  "media.read": observed(
    "read",
    "R1",
    "current-account-bound exact /api/info hosted-video readback with a closed metadata-only projection that omits playback URLs",
  ),
  "media.publish": observed(
    "write",
    "R3",
    "captured old-Reddit cookie-authenticated leases, exact S3 transfers, explicit declarations, response websocket target binding, and independent hosted-video readback",
  ),
  "content.delete": observed(
    "write",
    "R3",
    "exact authored-post pre-read, /api/del dispatch, and independent exact-target absence readback",
  ),
  "comments.create": captureRequired(
    "write",
    "R3",
    "comment publication needs an authorized fixture and exact actor/root response binding",
  ),
  "replies.create": captureRequired(
    "write",
    "R3",
    "comment or legacy-message reply needs an authorized fixture and exact parent binding",
  ),
  "content.edit": captureRequired(
    "write",
    "R3",
    "edit response and independent authored-content readback need an authorized fixture",
  ),
  "messaging.send": captureRequired(
    "write",
    "R3",
    "legacy compose and Reddit Chat are separate transports; neither may be inferred from the other",
  ),
  "posts.publish": captureRequired(
    "write",
    "R3",
    "self/link submission variants and audience fields need an authorized fixture",
  ),
  "posts.repost": captureRequired(
    "write",
    "R3",
    "crosspost submission needs exact source, destination, response, and readback binding",
  ),
} as const satisfies Readonly<Record<RedditWebOperationName, RedditWebOperationContract>>);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactObjectKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))
  ) throw new Error(`${label} changed its reviewed fields`);
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
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

function optionalString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return boundedString(value, label, maximum);
}

function finiteNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean or null`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

export function redditFullname(
  value: unknown,
  label: string,
  allowedKinds: readonly ("t1" | "t2" | "t3" | "t4" | "t5" | "t6")[] = [
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
  ],
): string {
  const result = boundedString(value, label, 40);
  const match = /^(t[1-6])_([a-z0-9]{1,32})$/u.exec(result);
  if (match === null || !allowedKinds.includes(match[1] as (typeof allowedKinds)[number])) {
    throw new Error(`${label} must be a reviewed Reddit fullname`);
  }
  return result;
}

export function redditPostId(value: unknown, label = "Reddit post ID"): string {
  return redditFullname(value, label, ["t3"]);
}

export function redditBarePostId(value: unknown, label = "Reddit post ID"): string {
  return redditPostId(value, label).slice(3);
}

export function redditCommunity(value: unknown, label = "Reddit community"): string {
  const community = boundedString(value, label, 21);
  if (!/^[A-Za-z0-9_]{2,21}$/u.test(community)) {
    throw new Error(`${label} must be an exact subreddit name`);
  }
  return community;
}

function exactUrl(
  value: string | URL,
  label: string,
  expectedOrigin = "https://www.reddit.com",
): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    url.origin !== expectedOrigin
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error(`${label} must use the exact ${expectedOrigin} origin`);
  return url;
}

function exactRedditUploadUrl(
  value: unknown,
  hostname: "reddit-uploaded-video.s3-accelerate.amazonaws.com"
    | "reddit-uploaded-media.s3-accelerate.amazonaws.com",
  label: string,
): URL {
  const text = boundedString(value, label, 4_096);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== hostname
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !/^\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,2047}$/u.test(url.pathname)
    || url.pathname.includes("..")
  ) throw new Error(`${label} escaped its exact reviewed Reddit upload host`);
  return url;
}

function exactParameters(value: URLSearchParams, label: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [name, item] of value) {
    if (result.has(name)) throw new Error(`${label} repeated ${name}`);
    if (name.length < 1 || name.length > 64 || /[\0\r\n]/u.test(name + item)) {
      throw new Error(`${label} contained an invalid parameter`);
    }
    result.set(name, item);
  }
  return result;
}

function exactNames(
  values: ReadonlyMap<string, string>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((name) => !values.has(name));
  const extra = [...values.keys()].filter((name) => !allowed.has(name));
  if (missing.length > 0) throw new Error(`${label} omitted ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`${label} contained unsupported ${extra.join(", ")}`);
}

function decimalParameter(
  values: ReadonlyMap<string, string>,
  name: string,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const value = values.get(name);
  if (value === undefined || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) {
    throw new Error(`${label}.${name} must be a decimal integer`);
  }
  return safeInteger(Number(value), `${label}.${name}`, minimum, maximum);
}

function optionalAfter(values: ReadonlyMap<string, string>, label: string): void {
  const after = values.get("after");
  if (after !== undefined) redditFullname(after, `${label}.after`, ["t1", "t3", "t4"]);
}

function requireFixed(
  values: ReadonlyMap<string, string>,
  name: string,
  expected: string,
  label: string,
): void {
  if (values.get(name) !== expected) throw new Error(`${label}.${name} changed its reviewed value`);
}

export type RedditWebRequestOperation =
  | "viewer.current"
  | "profiles.about"
  | "profiles.overview"
  | "feeds.home"
  | "posts.read"
  | "comments.read"
  | "messages.list"
  | "messages.read"
  | "media.read"
  | "state.readback"
  | "media.lease"
  | "media.publish"
  | "reactions.set"
  | "content.save"
  | "content.delete";

export type RedditWebRequestInput = {
  readonly operation: RedditWebRequestOperation;
  readonly url: string | URL;
  readonly method: string;
  readonly body?: string;
  readonly targetId?: string;
  readonly direction?: -1 | 0 | 1;
  readonly saved?: boolean;
  readonly folder?: "inbox" | "unread" | "sent";
  readonly mediaType?: "video/mp4" | "image/jpeg" | "image/png";
  readonly filename?: string;
  readonly community?: string;
  readonly title?: string;
  readonly text?: string;
  readonly nsfw?: boolean;
  readonly spoiler?: boolean;
  readonly sendReplies?: boolean;
  readonly mediaUrl?: string;
  readonly posterUrl?: string;
  readonly profile?: string;
};

export type RedditWebRequestBinding = {
  readonly operation: RedditWebRequestOperation;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly queryNames: readonly string[];
  readonly formNames: readonly string[];
};

/**
 * Validate one complete Reddit request without returning form values. In
 * particular, the ephemeral `uh` modhash is accepted only in the request body
 * and is absent from the returned binding.
 */
export function authorizeRedditWebRequest(
  input: RedditWebRequestInput,
): RedditWebRequestBinding {
  const url = exactUrl(
    input.url,
    "Reddit request URL",
    input.operation === "media.lease"
      ? "https://old.reddit.com"
      : "https://www.reddit.com",
  );
  const method = input.method.toUpperCase();
  const query = exactParameters(url.searchParams, "Reddit request query");
  let form = new Map<string, string>();
  if (input.body !== undefined) {
    if (method !== "POST") throw new Error("Reddit request body requires POST");
    form = new Map(exactParameters(new URLSearchParams(input.body), "Reddit request form"));
  }
  if (method !== "GET" && method !== "POST") throw new Error("Reddit request method is not reviewed");

  const finish = (): RedditWebRequestBinding => Object.freeze({
    operation: input.operation,
    method,
    path: url.pathname,
    queryNames: Object.freeze([...query.keys()].sort()),
    formNames: Object.freeze([...form.keys()].sort()),
  });

  if (input.operation === "viewer.current") {
    if (method !== "GET" || url.pathname !== "/api/me.json" || query.size !== 0 || form.size !== 0) {
      throw new Error("Reddit viewer request changed its reviewed exchange");
    }
    return finish();
  }

  if (input.operation === "profiles.about" || input.operation === "profiles.overview") {
    if (method !== "GET" || form.size !== 0 || input.profile === undefined) {
      throw new Error("Reddit profile request changed its reviewed exchange");
    }
    const profile = boundedString(input.profile, "Reddit profile handle", 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(profile)) {
      throw new Error("Reddit profile handle is invalid");
    }
    const expectedPath = input.operation === "profiles.about"
      ? `/user/${encodeURIComponent(profile)}/about.json`
      : `/user/${encodeURIComponent(profile)}/overview.json`;
    if (url.pathname !== expectedPath) {
      throw new Error("Reddit profile path did not bind the requested handle");
    }
    if (input.operation === "profiles.about") {
      exactNames(query, ["raw_json"], [], "Reddit profile about query");
    } else {
      exactNames(query, ["limit", "raw_json"], ["after"], "Reddit profile overview query");
      requireFixed(query, "limit", "100", "Reddit profile overview query");
      optionalAfter(query, "Reddit profile overview query");
    }
    requireFixed(query, "raw_json", "1", "Reddit profile query");
    return finish();
  }

  if (input.operation === "feeds.home") {
    if (method !== "GET" || url.pathname !== "/.json" || form.size !== 0) {
      throw new Error("Reddit home feed request changed its reviewed exchange");
    }
    exactNames(query, ["limit", "raw_json"], ["after"], "Reddit home feed query");
    decimalParameter(query, "limit", 1, 100, "Reddit home feed query");
    requireFixed(query, "raw_json", "1", "Reddit home feed query");
    optionalAfter(query, "Reddit home feed query");
    return finish();
  }

  if (input.operation === "posts.read" || input.operation === "comments.read") {
    if (method !== "GET" || form.size !== 0 || input.targetId === undefined) {
      throw new Error("Reddit comments-page request changed its reviewed exchange");
    }
    const bare = redditBarePostId(input.targetId, "Reddit request target");
    if (url.pathname !== `/comments/${bare}.json`) {
      throw new Error("Reddit comments-page path did not bind the requested post");
    }
    if (input.operation === "posts.read") {
      exactNames(query, ["limit", "raw_json"], [], "Reddit post query");
      requireFixed(query, "limit", "1", "Reddit post query");
    } else {
      exactNames(query, ["depth", "limit", "raw_json", "sort"], [], "Reddit comments query");
      decimalParameter(query, "limit", 1, 100, "Reddit comments query");
      requireFixed(query, "depth", "10", "Reddit comments query");
      requireFixed(query, "sort", "confidence", "Reddit comments query");
    }
    requireFixed(query, "raw_json", "1", "Reddit comments-page query");
    return finish();
  }

  if (input.operation === "messages.list" || input.operation === "messages.read") {
    if (method !== "GET" || form.size !== 0 || input.folder === undefined) {
      throw new Error("Reddit message request changed its reviewed exchange");
    }
    if (url.pathname !== `/message/${input.folder}.json`) {
      throw new Error("Reddit message path did not bind the requested folder");
    }
    if (input.operation === "messages.list") {
      exactNames(query, ["limit", "mark", "max_replies", "raw_json"], ["after"], "Reddit message-list query");
      decimalParameter(query, "limit", 1, 100, "Reddit message-list query");
      requireFixed(query, "max_replies", "0", "Reddit message-list query");
      optionalAfter(query, "Reddit message-list query");
    } else {
      exactNames(query, ["limit", "mark", "max_replies", "mid", "raw_json"], [], "Reddit message-read query");
      requireFixed(query, "limit", "1", "Reddit message-read query");
      requireFixed(query, "max_replies", "100", "Reddit message-read query");
      const target = redditFullname(input.targetId, "Reddit requested message", ["t4"]);
      if (query.get("mid") !== target) {
        throw new Error("Reddit message query did not bind the requested message");
      }
    }
    requireFixed(query, "mark", "false", "Reddit message query");
    requireFixed(query, "raw_json", "1", "Reddit message query");
    return finish();
  }

  if (input.operation === "state.readback" || input.operation === "media.read") {
    if (method !== "GET" || url.pathname !== "/api/info.json" || form.size !== 0) {
      throw new Error(`Reddit ${input.operation} changed its reviewed exchange`);
    }
    exactNames(query, ["id", "raw_json"], [], `Reddit ${input.operation} query`);
    const target = redditFullname(
      input.targetId,
      `Reddit ${input.operation} target`,
      input.operation === "media.read" ? ["t3"] : ["t1", "t3"],
    );
    if (query.get("id") !== target) {
      throw new Error(`Reddit ${input.operation} query did not bind its target`);
    }
    requireFixed(query, "raw_json", "1", `Reddit ${input.operation} query`);
    return finish();
  }

  if (input.operation === "media.lease") {
    if (
      method !== "POST"
      || input.mediaType === undefined
      || input.filename === undefined
    ) throw new Error("Reddit media lease request changed its reviewed exchange");
    const expectedPath = input.mediaType === "video/mp4"
      ? "/api/video_upload_s3.json"
      : "/api/image_upload_s3.json";
    if (url.pathname !== expectedPath || query.size !== 0) {
      throw new Error("Reddit media lease request changed its reviewed exchange");
    }
    exactNames(
      form,
      ["filepath", "mimetype", "raw_json"],
      [],
      "Reddit media lease form",
    );
    requireFixed(form, "filepath", input.filename, "Reddit media lease form");
    requireFixed(form, "mimetype", input.mediaType, "Reddit media lease form");
    requireFixed(form, "raw_json", "1", "Reddit media lease form");
    return finish();
  }

  if (input.operation === "media.publish") {
    if (
      method !== "POST"
      || url.pathname !== "/api/submit"
      || input.community === undefined
      || input.title === undefined
      || typeof input.nsfw !== "boolean"
      || typeof input.spoiler !== "boolean"
      || typeof input.sendReplies !== "boolean"
      || input.mediaUrl === undefined
      || input.posterUrl === undefined
    ) throw new Error("Reddit video submit request changed its reviewed exchange");
    exactNames(query, ["raw_json"], [], "Reddit video submit query");
    requireFixed(query, "raw_json", "1", "Reddit video submit query");
    exactNames(
      form,
      [
        "api_type",
        "kind",
        "nsfw",
        "resubmit",
        "sendreplies",
        "spoiler",
        "sr",
        "title",
        "uh",
        "url",
        "validate_on_submit",
        "video_poster_url",
      ],
      input.text === undefined ? [] : ["text"],
      "Reddit video submit form",
    );
    requireFixed(form, "api_type", "json", "Reddit video submit form");
    requireFixed(form, "kind", "video", "Reddit video submit form");
    requireFixed(form, "nsfw", String(input.nsfw), "Reddit video submit form");
    requireFixed(form, "resubmit", "false", "Reddit video submit form");
    requireFixed(form, "sendreplies", String(input.sendReplies), "Reddit video submit form");
    requireFixed(form, "spoiler", String(input.spoiler), "Reddit video submit form");
    requireFixed(form, "sr", redditCommunity(input.community), "Reddit video submit form");
    requireFixed(
      form,
      "title",
      boundedString(input.title, "Reddit video title", 280),
      "Reddit video submit form",
    );
    if (input.text !== undefined) {
      requireFixed(
        form,
        "text",
        boundedString(input.text, "Reddit video body", 10_000),
        "Reddit video submit form",
      );
    }
    const mediaUrl = exactRedditUploadUrl(
      input.mediaUrl,
      "reddit-uploaded-video.s3-accelerate.amazonaws.com",
      "Reddit uploaded video URL",
    );
    const posterUrl = exactRedditUploadUrl(
      input.posterUrl,
      "reddit-uploaded-media.s3-accelerate.amazonaws.com",
      "Reddit uploaded poster URL",
    );
    requireFixed(form, "url", mediaUrl.href, "Reddit video submit form");
    requireFixed(form, "video_poster_url", posterUrl.href, "Reddit video submit form");
    requireFixed(form, "validate_on_submit", "true", "Reddit video submit form");
    boundedString(form.get("uh"), "Reddit video submit modhash", 256);
    return finish();
  }

  if (input.operation === "content.delete") {
    if (method !== "POST" || url.pathname !== "/api/del" || query.size !== 0) {
      throw new Error("Reddit delete request changed its reviewed exchange");
    }
    exactNames(form, ["id", "uh"], [], "Reddit delete form");
    const target = redditPostId(input.targetId, "Reddit delete target");
    if (form.get("id") !== target) throw new Error("Reddit delete form did not bind its target");
    boundedString(form.get("uh"), "Reddit delete modhash", 256);
    return finish();
  }

  if (input.operation === "reactions.set") {
    if (method !== "POST" || url.pathname !== "/api/vote" || query.size !== 0) {
      throw new Error("Reddit vote request changed its reviewed exchange");
    }
    exactNames(form, ["dir", "id", "uh"], [], "Reddit vote form");
    const target = redditFullname(input.targetId, "Reddit vote target", ["t1", "t3"]);
    if (form.get("id") !== target) throw new Error("Reddit vote form did not bind its target");
    if (input.direction !== -1 && input.direction !== 0 && input.direction !== 1) {
      throw new Error("Reddit vote direction is not reviewed");
    }
    if (form.get("dir") !== String(input.direction)) {
      throw new Error("Reddit vote form did not bind the desired direction");
    }
  } else if (input.operation === "content.save") {
    if (
      method !== "POST"
      || (url.pathname !== "/api/save" && url.pathname !== "/api/unsave")
      || query.size !== 0
      || typeof input.saved !== "boolean"
    ) throw new Error("Reddit save request changed its reviewed exchange");
    exactNames(form, ["id", "uh"], [], "Reddit save form");
    const target = redditFullname(input.targetId, "Reddit save target", ["t1", "t3"]);
    if (form.get("id") !== target) throw new Error("Reddit save form did not bind its target");
    if (url.pathname !== (input.saved ? "/api/save" : "/api/unsave")) {
      throw new Error("Reddit save path did not bind the desired state");
    }
  } else throw new Error("Reddit request operation is not reviewed");
  boundedString(form.get("uh"), "Reddit request modhash", 256);
  return finish();
}

export type RedditWebViewer = {
  readonly id: string;
  readonly username: string;
  readonly modhash: string;
};

export function parseRedditWebViewerResponse(value: unknown): RedditWebViewer {
  const root = record(value, "Reddit viewer response");
  if (root.kind !== "t2") throw new Error("Reddit viewer response did not contain an account thing");
  const data = record(root.data, "Reddit viewer response.data");
  const rawId = boundedString(data.id, "Reddit viewer account ID", 32);
  if (!/^[a-z0-9]{1,32}$/u.test(rawId)) throw new Error("Reddit viewer account ID must be base36");
  const username = boundedString(data.name, "Reddit viewer username", 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(username)) throw new Error("Reddit viewer username is invalid");
  const modhash = boundedString(data.modhash, "Reddit viewer modhash", 256);
  return Object.freeze({ id: `t2_${rawId}`, username, modhash });
}

export type RedditMediaType = "video/mp4" | "image/jpeg" | "image/png";

export type RedditMediaLease = {
  readonly uploadOrigin: string;
  readonly fields: readonly Readonly<{ name: string; value: string }>[];
  readonly key: string;
};

const redditLeaseFieldNames = Object.freeze([
  "x-amz-algorithm",
  "x-amz-security-token",
  "x-amz-storage-class",
  "success_action_status",
  "bucket",
  "acl",
  "key",
  "x-amz-signature",
  "x-amz-date",
  "x-amz-meta-ext",
  "policy",
  "x-amz-credential",
  "Content-Type",
] as const);

function checkedRedditWebSocketUrl(value: unknown, label: string): URL {
  const text = boundedString(value, label, 8_192);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute WSS URL`);
  }
  const query = exactParameters(url.searchParams, `${label} query`);
  if (
    url.protocol !== "wss:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || !/^(?:[a-z0-9-]{1,64}\.)?wss\.redditmedia\.com$/u.test(url.hostname)
    || !/^\/[A-Za-z0-9/_-]{1,2048}$/u.test(url.pathname)
    || url.pathname.includes("..")
    || query.size !== 1
    || !query.has("m")
    || !/^[A-Za-z0-9_-]{20,2048}$/u.test(query.get("m") ?? "")
  ) throw new Error(`${label} escaped the reviewed Reddit websocket family`);
  return url;
}

export function parseRedditMediaLeaseResponse(
  value: unknown,
  expected: {
    readonly mediaType: RedditMediaType;
    readonly filename: string;
  },
): RedditMediaLease {
  const expectedHostname = expected.mediaType === "video/mp4"
    ? "reddit-uploaded-video.s3-accelerate.amazonaws.com"
    : "reddit-uploaded-media.s3-accelerate.amazonaws.com";
  const filename = boundedString(expected.filename, "Reddit lease filename", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(filename)) {
    throw new Error("Reddit lease filename is not a safe fixed name");
  }
  const root = record(value, "Reddit media lease response");
  exactObjectKeys(root, ["action", "fields"], [], "Reddit media lease response");
  if (root.action !== `//${expectedHostname}`) {
    throw new Error("Reddit media lease changed its exact upload host");
  }
  if (!Array.isArray(root.fields) || root.fields.length !== redditLeaseFieldNames.length) {
    throw new Error("Reddit media lease changed its upload field count");
  }
  const allowedNames: ReadonlySet<string> = new Set(redditLeaseFieldNames);
  const seenNames = new Set<string>();
  const fields: { name: string; value: string }[] = [];
  let totalValueBytes = 0;
  for (const [index, rawField] of root.fields.entries()) {
    const field = record(rawField, `Reddit media lease field ${index}`);
    exactObjectKeys(field, ["name", "value"], [], `Reddit media lease field ${index}`);
    const fieldName = boundedString(field.name, `Reddit media lease field ${index} name`, 64);
    if (!allowedNames.has(fieldName) || seenNames.has(fieldName)) {
      throw new Error("Reddit media lease changed its exact upload field set");
    }
    seenNames.add(fieldName);
    const fieldValue = boundedString(field.value, `Reddit media lease field ${fieldName}`, 65_536);
    if (/\n/u.test(fieldValue)) throw new Error("Reddit media lease field contained a line break");
    totalValueBytes += new TextEncoder().encode(fieldValue).byteLength;
    if (totalValueBytes > 160 * 1024) throw new Error("Reddit media lease fields exceeded their reviewed bound");
    fields.push(Object.freeze({ name: fieldName, value: fieldValue }));
  }
  const byName = new Map(fields.map((field) => [field.name, field.value]));
  const extension = expected.mediaType === "video/mp4"
    ? "mp4"
    : expected.mediaType === "image/png" ? "png" : "jpg";
  const bucket = expected.mediaType === "video/mp4"
    ? "reddit-uploaded-video"
    : "reddit-uploaded-media";
  if (
    byName.get("acl") !== "private"
    || byName.get("x-amz-algorithm") !== "AWS4-HMAC-SHA256"
    || byName.get("success_action_status") !== "201"
    || byName.get("bucket") !== bucket
    || byName.get("Content-Type") !== expected.mediaType
    || byName.get("x-amz-storage-class") !== "STANDARD"
    || byName.get("x-amz-meta-ext") !== extension
  ) throw new Error("Reddit media lease changed a fixed upload declaration");
  const key = boundedString(byName.get("key"), "Reddit media lease key", 2_048);
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,2047}$/u.test(key) || key.includes("..")) {
    throw new Error("Reddit media lease key escaped its reviewed path shape");
  }
  return Object.freeze({
    uploadOrigin: `https://${expectedHostname}`,
    fields: Object.freeze(fields),
    key,
  });
}

export function redditMediaAssetUrl(lease: RedditMediaLease): string {
  const origin = lease.uploadOrigin === "https://reddit-uploaded-video.s3-accelerate.amazonaws.com"
    ? lease.uploadOrigin
    : lease.uploadOrigin === "https://reddit-uploaded-media.s3-accelerate.amazonaws.com"
      ? lease.uploadOrigin
      : (() => {
          throw new Error("Reddit media lease upload origin is not reviewed");
        })();
  return new URL(`/${lease.key}`, origin).href;
}

export function parseRedditVideoSubmitResponse(value: unknown): string {
  const root = record(value, "Reddit video submit response");
  exactObjectKeys(root, ["json"], [], "Reddit video submit response");
  const json = record(root.json, "Reddit video submit response.json");
  exactObjectKeys(json, ["data", "errors"], [], "Reddit video submit response.json");
  if (!Array.isArray(json.errors) || json.errors.length !== 0) {
    throw new Error("Reddit video submit response contained provider errors");
  }
  const data = record(json.data, "Reddit video submit response.json.data");
  exactObjectKeys(
    data,
    ["websocket_url"],
    ["user_submitted_page"],
    "Reddit video submit response.json.data",
  );
  if (data.user_submitted_page !== undefined) {
    const page = exactUrl(
      boundedString(data.user_submitted_page, "Reddit submitted-page URL", 2_048),
      "Reddit submitted-page URL",
    );
    if (!/^\/user\/[A-Za-z0-9_-]{1,64}\/submitted\/$/u.test(page.pathname) || page.search !== "") {
      throw new Error("Reddit submitted-page URL changed shape");
    }
  }
  return checkedRedditWebSocketUrl(
    data.websocket_url,
    "Reddit video submit websocket URL",
  ).href;
}

export function parseRedditVideoWebSocketMessage(
  value: unknown,
  expectedCommunity: string,
): Readonly<{ postId: string; url: string }> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > 64 * 1024) {
      throw new Error("Reddit video websocket message exceeded its reviewed bound");
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Reddit video websocket returned malformed JSON");
    }
  }
  const root = record(parsed, "Reddit video websocket message");
  exactObjectKeys(root, ["payload"], ["type"], "Reddit video websocket message");
  if (root.type !== undefined && root.type !== "success") {
    throw new Error("Reddit video processing did not succeed");
  }
  const payload = record(root.payload, "Reddit video websocket message.payload");
  exactObjectKeys(payload, ["redirect"], [], "Reddit video websocket message.payload");
  const redirectText = boundedString(payload.redirect, "Reddit video redirect", 2_048);
  let redirect: URL;
  try {
    redirect = new URL(redirectText);
  } catch {
    throw new Error("Reddit video redirect must be an absolute URL");
  }
  const community = redditCommunity(expectedCommunity);
  const match = /^\/r\/([^/]+)\/comments\/([a-z0-9]{1,32})\/[^/?#]+\/$/u.exec(redirect.pathname);
  if (
    redirect.protocol !== "https:"
    || (redirect.hostname !== "www.reddit.com" && redirect.hostname !== "reddit.com")
    || redirect.username !== ""
    || redirect.password !== ""
    || redirect.port !== ""
    || redirect.search !== ""
    || redirect.hash !== ""
    || match === null
    || match[1]?.toLowerCase() !== community.toLowerCase()
  ) throw new Error("Reddit video redirect escaped its confirmed community");
  const postId = redditPostId(`t3_${match[2]}`, "Reddit video redirect post ID");
  return Object.freeze({
    postId,
    url: `https://www.reddit.com${redirect.pathname}`,
  });
}

export type RedditWebProfile = {
  readonly username: string;
  readonly displayName: string | null;
  readonly bio: string | null;
  readonly followers: number;
  readonly karma: number;
};

/** Project exact public profile counts from Reddit's target-bound about thing. */
export function parseRedditWebProfileResponse(
  value: unknown,
  expectedUsername: string,
): RedditWebProfile {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(expectedUsername)) {
    throw new Error("Expected Reddit profile handle is invalid");
  }
  const root = record(value, "Reddit profile response");
  if (root.kind !== "t2") throw new Error("Reddit profile response did not contain an account thing");
  const data = record(root.data, "Reddit profile response.data");
  const username = boundedString(data.name, "Reddit profile response.data.name", 64);
  if (username.toLocaleLowerCase("en-US") !== expectedUsername.toLocaleLowerCase("en-US")) {
    throw new Error("Reddit profile response did not bind the requested handle");
  }
  const subreddit = record(data.subreddit, "Reddit profile response.data.subreddit");
  const prefixedName = optionalString(
    subreddit.display_name_prefixed,
    "Reddit profile response.data.subreddit.display_name_prefixed",
    66,
  );
  if (
    prefixedName !== null
    && prefixedName.toLocaleLowerCase("en-US") !== `u/${username}`.toLocaleLowerCase("en-US")
  ) throw new Error("Reddit profile subreddit did not bind the requested handle");
  return Object.freeze({
    username,
    displayName: optionalString(subreddit.title, "Reddit profile response.data.subreddit.title", 256),
    bio: optionalString(
      subreddit.public_description,
      "Reddit profile response.data.subreddit.public_description",
      4096,
    ),
    followers: safeInteger(
      subreddit.subscribers,
      "Reddit profile response.data.subreddit.subscribers",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    karma: safeInteger(
      data.total_karma,
      "Reddit profile response.data.total_karma",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  });
}

type RedditListing = {
  readonly children: readonly JsonRecord[];
  readonly after: string | null;
  readonly before: string | null;
};

function listing(value: unknown, label: string, maximumChildren: number): RedditListing {
  const root = record(value, label);
  if (root.kind !== "Listing") throw new Error(`${label}.kind must be Listing`);
  const data = record(root.data, `${label}.data`);
  if (!Array.isArray(data.children) || data.children.length > maximumChildren) {
    throw new Error(`${label}.data.children exceeded its reviewed bound`);
  }
  const children = data.children.map((child, index) =>
    record(child, `${label}.data.children[${index}]`));
  const after = optionalString(data.after, `${label}.data.after`, 64);
  const before = optionalString(data.before, `${label}.data.before`, 64);
  if (after !== null) redditFullname(after, `${label}.data.after`, ["t1", "t3", "t4"]);
  if (before !== null) redditFullname(before, `${label}.data.before`, ["t1", "t3", "t4"]);
  return Object.freeze({
    children: Object.freeze(children),
    after,
    before,
  });
}

export type RedditProfileContributionPage = {
  readonly ids: readonly string[];
  readonly after: string | null;
};

/**
 * Count only distinct post and comment things authored by the requested user.
 * Runtime pagination defines the metric window as the complete visible profile
 * overview Listing, rather than claiming an unavailable lifetime total.
 */
export function parseRedditProfileContributionPage(
  value: unknown,
  expectedUsername: string,
): RedditProfileContributionPage {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(expectedUsername)) {
    throw new Error("Expected Reddit profile handle is invalid");
  }
  const page = listing(value, "Reddit profile overview response", 100);
  const ids = page.children.map((child, index) => {
    const label = `Reddit profile overview response.data.children[${index}]`;
    if (child.kind !== "t1" && child.kind !== "t3") {
      throw new Error(`${label}.kind must be t1 or t3`);
    }
    const data = record(child.data, `${label}.data`);
    const id = redditFullname(data.name, `${label}.data.name`, [child.kind]);
    const author = boundedString(data.author, `${label}.data.author`, 64);
    if (author.toLocaleLowerCase("en-US") !== expectedUsername.toLocaleLowerCase("en-US")) {
      throw new Error("Reddit profile overview response contained another author");
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Reddit profile overview response repeated a contribution");
  }
  if (page.after !== null) redditFullname(page.after, "Reddit profile overview response.data.after", ["t1", "t3"]);
  return Object.freeze({ ids: Object.freeze(ids), after: page.after });
}

function thingData(
  value: JsonRecord,
  expectedKind: "t1" | "t3" | "t4",
  label: string,
): JsonRecord {
  if (value.kind !== expectedKind) throw new Error(`${label}.kind must be ${expectedKind}`);
  return record(value.data, `${label}.data`);
}

export type RedditProjectedPost = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly author: string | null;
  readonly subreddit: string;
  readonly createdUtc: number | null;
  readonly score: number | null;
  readonly commentCount: number;
  readonly liked: boolean | null;
  readonly saved: boolean;
  readonly externalUrl: string | null;
  readonly permalink: string;
};

function safeExternalUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = boundedString(value, label, 4096);
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
  ) throw new Error(`${label} must be an absolute HTTP URL without credentials`);
  return url.href;
}

function permalink(value: unknown, label: string): string {
  const path = boundedString(value, label, 2048);
  if (!path.startsWith("/") || path.startsWith("//") || /[?#]/u.test(path)) {
    throw new Error(`${label} must be a Reddit path`);
  }
  return `https://www.reddit.com${path}`;
}

function projectedPost(value: JsonRecord, label: string): RedditProjectedPost {
  const data = thingData(value, "t3", label);
  const id = redditFullname(data.name, `${label}.data.name`, ["t3"]);
  const commentCount = safeInteger(data.num_comments, `${label}.data.num_comments`, 0, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    id,
    title: boundedString(data.title, `${label}.data.title`, 1_000, true),
    body: boundedString(data.selftext ?? "", `${label}.data.selftext`, 100_000, true),
    author: optionalString(data.author, `${label}.data.author`, 64),
    subreddit: boundedString(data.subreddit, `${label}.data.subreddit`, 64),
    createdUtc: finiteNumber(data.created_utc, `${label}.data.created_utc`),
    score: finiteNumber(data.score, `${label}.data.score`),
    commentCount,
    liked: nullableBoolean(data.likes, `${label}.data.likes`),
    saved: boolean(data.saved, `${label}.data.saved`),
    externalUrl: safeExternalUrl(data.url, `${label}.data.url`),
    permalink: permalink(data.permalink, `${label}.data.permalink`),
  });
}

export type RedditAuthoredPostPresence = Readonly<{
  present: boolean;
  post: RedditProjectedPost | null;
  authorFullname: string | null;
}>;

export function parseRedditAuthoredPostPresence(
  value: unknown,
  expectedPostId: string,
): RedditAuthoredPostPresence {
  const target = redditPostId(expectedPostId);
  const page = listing(value, "Reddit authored-post presence Listing", 1);
  if (page.children.length === 0) {
    return Object.freeze({ present: false, post: null, authorFullname: null });
  }
  if (page.children.length !== 1) {
    throw new Error("Reddit authored-post presence returned multiple targets");
  }
  const thing = page.children[0]!;
  const data = thingData(thing, "t3", "Reddit authored-post presence");
  const id = redditPostId(data.name, "Reddit authored-post presence ID");
  if (id !== target) throw new Error("Reddit authored-post presence changed its exact target");
  const rawAuthor = data.author;
  if (rawAuthor === undefined || rawAuthor === null || rawAuthor === "[deleted]") {
    return Object.freeze({ present: false, post: null, authorFullname: null });
  }
  const post = projectedPost(thing, "Reddit authored-post presence");
  const authorFullname = data.author_fullname === undefined || data.author_fullname === null
    ? null
    : redditFullname(
        data.author_fullname,
        "Reddit authored-post presence author fullname",
        ["t2"],
      );
  return Object.freeze({ present: true, post, authorFullname });
}

export type RedditVideoPostReadback = Readonly<{
  post: RedditProjectedPost;
  authorFullname: string | null;
  videoUrl: string;
  fallbackUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  nsfw: boolean;
  spoiler: boolean;
}>;

function exactRedditVideoUrl(value: unknown, label: string): URL {
  const text = boundedString(value, label, 4_096);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "v.redd.it"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.hash !== ""
    || !/^\/[A-Za-z0-9_-]{1,128}(?:\/[A-Za-z0-9_.-]{1,128})?$/u.test(url.pathname)
  ) throw new Error(`${label} escaped the exact Reddit video host`);
  return url;
}

export function parseRedditVideoPostPresence(
  value: unknown,
  expectedPostId: string,
): RedditVideoPostReadback | null {
  const target = redditPostId(expectedPostId);
  const page = listing(value, "Reddit video-post presence Listing", 1);
  if (page.children.length === 0) return null;
  if (page.children.length !== 1) {
    throw new Error("Reddit video-post presence returned multiple targets");
  }
  const thing = page.children[0]!;
  const data = thingData(thing, "t3", "Reddit video-post presence");
  if (redditPostId(data.name, "Reddit video-post presence ID") !== target) {
    throw new Error("Reddit video-post presence changed its exact target");
  }
  if (data.is_video !== true || data.post_hint !== "hosted:video" || data.domain !== "v.redd.it") {
    throw new Error("Reddit video-post readback did not contain one hosted video");
  }
  const post = projectedPost(thing, "Reddit video-post presence");
  const videoUrl = exactRedditVideoUrl(data.url, "Reddit video-post URL");
  if (videoUrl.search !== "") throw new Error("Reddit video-post URL changed shape");
  const media = record(data.media, "Reddit video-post media");
  const video = record(media.reddit_video, "Reddit video-post media.reddit_video");
  if (video.is_gif !== false || video.transcoding_status !== "completed") {
    throw new Error("Reddit video-post processing did not complete as a normal video");
  }
  const durationSeconds = safeInteger(
    video.duration,
    "Reddit video-post duration",
    1,
    3_600,
  );
  const width = safeInteger(video.width, "Reddit video-post width", 1, 16_384);
  const height = safeInteger(video.height, "Reddit video-post height", 1, 16_384);
  const nsfw = boolean(data.over_18, "Reddit video-post NSFW declaration");
  const spoiler = boolean(data.spoiler, "Reddit video-post spoiler declaration");
  const fallbackUrl = exactRedditVideoUrl(
    video.fallback_url,
    "Reddit video-post fallback URL",
  );
  const rootSegment = videoUrl.pathname.split("/")[1];
  if (fallbackUrl.pathname.split("/")[1] !== rootSegment) {
    throw new Error("Reddit video-post fallback URL changed the video identity");
  }
  const authorFullname = data.author_fullname === undefined || data.author_fullname === null
    ? null
    : redditFullname(
        data.author_fullname,
        "Reddit video-post author fullname",
        ["t2"],
      );
  return Object.freeze({
    post,
    authorFullname,
    videoUrl: videoUrl.href,
    fallbackUrl: fallbackUrl.href,
    durationSeconds,
    width,
    height,
    nsfw,
    spoiler,
  });
}

export type RedditHostedVideoMetadata = Readonly<{
  provider: "reddit";
  operation: "media.read";
  post: Readonly<{
    id: string;
    title: string;
    author: string | null;
    subreddit: string;
    createdUtc: number | null;
    permalink: string;
  }>;
  media: Readonly<{
    kind: "hosted-video";
    mediaType: "video/mp4";
    durationSeconds: number;
    width: number;
    height: number;
    nsfw: boolean;
    spoiler: boolean;
    transcodingStatus: "completed";
  }>;
}>;

/**
 * Project only durable hosted-video metadata. The parser must observe and bind
 * Reddit's playback locations, but this closed return shape intentionally
 * omits both the canonical video URL and the expiring fallback URL.
 */
export function projectRedditHostedVideoMetadata(
  value: unknown,
  expectedPostId: string,
): RedditHostedVideoMetadata {
  const readback = parseRedditVideoPostPresence(value, expectedPostId);
  if (readback === null) {
    throw new Error("Reddit media.read did not return the exact hosted-video post");
  }
  return Object.freeze({
    provider: "reddit",
    operation: "media.read",
    post: Object.freeze({
      id: readback.post.id,
      title: readback.post.title,
      author: readback.post.author,
      subreddit: readback.post.subreddit,
      createdUtc: readback.post.createdUtc,
      permalink: readback.post.permalink,
    }),
    media: Object.freeze({
      kind: "hosted-video",
      mediaType: "video/mp4",
      durationSeconds: readback.durationSeconds,
      width: readback.width,
      height: readback.height,
      nsfw: readback.nsfw,
      spoiler: readback.spoiler,
      transcodingStatus: "completed",
    }),
  });
}

export function normalizeRedditFeedResponse(
  value: unknown,
  limit: number,
): Readonly<{
  posts: readonly RedditProjectedPost[];
  after: string | null;
  before: string | null;
}> {
  safeInteger(limit, "Reddit feed limit", 1, 100);
  const page = listing(value, "Reddit feed", limit);
  const posts = page.children.map((child, index) =>
    projectedPost(child, `Reddit feed child ${index}`));
  return Object.freeze({
    posts: Object.freeze(posts),
    after: page.after,
    before: page.before,
  });
}

function commentsPage(
  value: unknown,
  expectedPostId: string,
): {
  readonly post: RedditProjectedPost;
  readonly comments: RedditListing;
} {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("Reddit comments response must contain exact post and comment Listings");
  }
  const posts = listing(value[0], "Reddit comments post Listing", 1);
  if (posts.children.length !== 1) throw new Error("Reddit comments response omitted its root post");
  const post = projectedPost(posts.children[0]!, "Reddit comments root");
  if (post.id !== expectedPostId) {
    throw new Error("Reddit comments response did not bind the requested post");
  }
  return {
    post,
    comments: listing(value[1], "Reddit comments Listing", 500),
  };
}

export function normalizeRedditPostResponse(
  value: unknown,
  expectedPostId: string,
): Readonly<{ post: RedditProjectedPost }> {
  const target = redditPostId(expectedPostId);
  return Object.freeze({ post: commentsPage(value, target).post });
}

export type RedditProjectedComment = {
  readonly id: string;
  readonly postId: string;
  readonly parentId: string;
  readonly author: string | null;
  readonly body: string;
  readonly createdUtc: number | null;
  readonly score: number | null;
  readonly depth: number | null;
  readonly liked: boolean | null;
  readonly saved: boolean;
  readonly permalink: string;
};

function projectedComment(
  value: JsonRecord,
  expectedPostId: string,
  label: string,
): RedditProjectedComment {
  const data = thingData(value, "t1", label);
  const postId = redditFullname(data.link_id, `${label}.data.link_id`, ["t3"]);
  if (postId !== expectedPostId) throw new Error("Reddit comment did not bind the requested post");
  return Object.freeze({
    id: redditFullname(data.name, `${label}.data.name`, ["t1"]),
    postId,
    parentId: redditFullname(data.parent_id, `${label}.data.parent_id`, ["t1", "t3"]),
    author: optionalString(data.author, `${label}.data.author`, 64),
    body: boundedString(data.body ?? "", `${label}.data.body`, 100_000, true),
    createdUtc: finiteNumber(data.created_utc, `${label}.data.created_utc`),
    score: finiteNumber(data.score, `${label}.data.score`),
    depth: data.depth === undefined || data.depth === null
      ? null
      : safeInteger(data.depth, `${label}.data.depth`, 0, 100),
    liked: nullableBoolean(data.likes, `${label}.data.likes`),
    saved: boolean(data.saved ?? false, `${label}.data.saved`),
    permalink: permalink(data.permalink, `${label}.data.permalink`),
  });
}

export function normalizeRedditCommentsResponse(
  value: unknown,
  expectedPostId: string,
  limit: number,
): Readonly<{
  post: RedditProjectedPost;
  comments: readonly RedditProjectedComment[];
  truncated: boolean;
  hasMore: boolean;
}> {
  const target = redditPostId(expectedPostId);
  safeInteger(limit, "Reddit comment limit", 1, 100);
  const page = commentsPage(value, target);
  const projected: RedditProjectedComment[] = [];
  let visited = 0;
  let hasMore = false;
  const visit = (children: readonly JsonRecord[]): void => {
    for (const child of children) {
      visited += 1;
      if (visited > 500) throw new Error("Reddit comment tree exceeded its reviewed node bound");
      if (child.kind === "more") {
        hasMore = true;
        continue;
      }
      const comment = projectedComment(child, target, `Reddit comment ${visited}`);
      if (projected.length < limit) projected.push(comment);
      const data = record(child.data, `Reddit comment ${visited}.data`);
      if (data.replies === "" || data.replies === undefined || data.replies === null) continue;
      visit(listing(data.replies, `Reddit comment ${visited}.replies`, 500).children);
    }
  };
  visit(page.comments.children);
  return Object.freeze({
    post: page.post,
    comments: Object.freeze(projected),
    truncated: visited > limit,
    hasMore,
  });
}

export type RedditProjectedMessage = {
  readonly kind: "message" | "notification";
  readonly id: string;
  readonly author: string | null;
  readonly recipient: string | null;
  readonly subject: string;
  readonly body: string;
  readonly createdUtc: number | null;
  readonly unread: boolean;
  readonly parentId: string | null;
  readonly context: string | null;
};

function projectedMessage(value: JsonRecord, label: string): RedditProjectedMessage {
  if (value.kind !== "t4" && value.kind !== "t1") {
    throw new Error(`${label}.kind must be a legacy message or inbox notification`);
  }
  const data = record(value.data, `${label}.data`);
  const kind = value.kind === "t4" ? "message" : "notification";
  const id = redditFullname(data.name, `${label}.data.name`, [value.kind]);
  const contextValue = optionalString(data.context, `${label}.data.context`, 2048);
  if (contextValue !== null && (!contextValue.startsWith("/") || contextValue.startsWith("//"))) {
    throw new Error(`${label}.data.context must be a Reddit path`);
  }
  return Object.freeze({
    kind,
    id,
    author: optionalString(data.author, `${label}.data.author`, 64),
    recipient: optionalString(data.dest, `${label}.data.dest`, 64),
    subject: boundedString(data.subject ?? "", `${label}.data.subject`, 1_000, true),
    body: boundedString(data.body ?? "", `${label}.data.body`, 100_000, true),
    createdUtc: finiteNumber(data.created_utc, `${label}.data.created_utc`),
    unread: boolean(data.new ?? false, `${label}.data.new`),
    parentId: data.parent_id === undefined || data.parent_id === null || data.parent_id === ""
      ? null
      : redditFullname(data.parent_id, `${label}.data.parent_id`, ["t1", "t3", "t4"]),
    context: contextValue === null ? null : `https://www.reddit.com${contextValue}`,
  });
}

function nestedMessageThings(value: JsonRecord, maximum: number): readonly JsonRecord[] {
  const result: JsonRecord[] = [value];
  const data = record(value.data, "Reddit message thing.data");
  if (data.replies === undefined || data.replies === null || data.replies === "") {
    return Object.freeze(result);
  }
  const replies = listing(data.replies, "Reddit message replies", maximum);
  for (const reply of replies.children) {
    if (result.length >= maximum) throw new Error("Reddit message thread exceeded its reviewed bound");
    result.push(...nestedMessageThings(reply, maximum - result.length));
  }
  return Object.freeze(result);
}

export function normalizeRedditMessageListing(
  value: unknown,
  limit: number,
  requestedMessageId: string | null = null,
): Readonly<{
  messages: readonly RedditProjectedMessage[];
  after: string | null;
  before: string | null;
  requested: RedditProjectedMessage | null;
}> {
  safeInteger(limit, "Reddit message limit", 1, 100);
  const target = requestedMessageId === null
    ? null
    : redditFullname(requestedMessageId, "Reddit requested message", ["t4"]);
  const page = listing(value, "Reddit message Listing", target === null ? limit : 1);
  const things = target === null
    ? page.children
    : Object.freeze(page.children.flatMap((child) => nestedMessageThings(child, 101)));
  if (things.length > (target === null ? limit : 101)) {
    throw new Error("Reddit message projection exceeded its reviewed bound");
  }
  const messages = things.map((thing, index) =>
    projectedMessage(thing, `Reddit message ${index}`));
  const requested = target === null
    ? null
    : messages.find((message) => message.id === target) ?? null;
  if (target !== null && requested === null) {
    throw new Error("Reddit message response did not bind the requested message");
  }
  return Object.freeze({
    messages: Object.freeze(messages),
    after: page.after,
    before: page.before,
    requested,
  });
}

export type RedditThingState = {
  readonly id: string;
  readonly liked: boolean | null;
  readonly saved: boolean;
};

export function parseRedditThingState(
  value: unknown,
  expectedThingId: string,
): RedditThingState {
  const target = redditFullname(expectedThingId, "Reddit state target", ["t1", "t3"]);
  const page = listing(value, "Reddit state Listing", 1);
  if (page.children.length !== 1) throw new Error("Reddit state readback must contain exactly one thing");
  const child = page.children[0]!;
  if (child.kind !== "t1" && child.kind !== "t3") {
    throw new Error("Reddit state readback returned an unsupported thing kind");
  }
  const data = record(child.data, "Reddit state thing.data");
  const id = redditFullname(data.name, "Reddit state thing.name", ["t1", "t3"]);
  if (id !== target) throw new Error("Reddit state readback did not bind the requested thing");
  return Object.freeze({
    id,
    liked: nullableBoolean(data.likes, "Reddit state thing.likes"),
    saved: boolean(data.saved, "Reddit state thing.saved"),
  });
}

export function assertRedditMutationSuccess(value: unknown): void {
  const root = record(value, "Reddit mutation response");
  if (root.json === undefined) {
    if (Object.keys(root).length !== 0) {
      throw new Error("Reddit mutation response contained an unreviewed variant");
    }
    return;
  }
  const json = record(root.json, "Reddit mutation response.json");
  if (!Array.isArray(json.errors) || json.errors.length !== 0) {
    throw new Error("Reddit mutation response contained provider errors");
  }
}
