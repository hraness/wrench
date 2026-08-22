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
  "content.edit",
  "content.save",
  "feeds.read",
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
  "media.read": captureRequired(
    "read",
    "R1",
    "media metadata and expiring playback variants need a separate bounded projection",
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

function exactUrl(value: string | URL, label: string): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    url.origin !== "https://www.reddit.com"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error(`${label} must use the exact https://www.reddit.com origin`);
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
  | "state.readback"
  | "reactions.set"
  | "content.save";

export type RedditWebRequestInput = {
  readonly operation: RedditWebRequestOperation;
  readonly url: string | URL;
  readonly method: string;
  readonly body?: string;
  readonly targetId?: string;
  readonly direction?: -1 | 0 | 1;
  readonly saved?: boolean;
  readonly folder?: "inbox" | "unread" | "sent";
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
  const url = exactUrl(input.url, "Reddit request URL");
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

  if (input.operation === "state.readback") {
    if (method !== "GET" || url.pathname !== "/api/info.json" || form.size !== 0) {
      throw new Error("Reddit state readback changed its reviewed exchange");
    }
    exactNames(query, ["id", "raw_json"], [], "Reddit state query");
    const target = redditFullname(input.targetId, "Reddit state target", ["t1", "t3"]);
    if (query.get("id") !== target) throw new Error("Reddit state query did not bind its target");
    requireFixed(query, "raw_json", "1", "Reddit state query");
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
  } else {
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
  }
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
