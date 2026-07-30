/**
 * Hacker News first-party HTML policy and bounded projection.
 *
 * Authenticated reads use fixed first-party pages. Request-bound `auth`,
 * `hmac`, `fnid`, and `fnop` values may exist only in ephemeral values parsed
 * from the immediately preceding page; normalized output never contains them.
 */

import { renderCookieHeader } from "@hraness/kb/clip/cookies";

import { pinnedHttpsFetch } from "../pinned-https";
import type {
  WebSessionClient,
  WebSessionFetch,
} from "../web-session-client";

export const HACKER_NEWS_WEB_OPERATION_NAMES = Object.freeze([
  "comments.create",
  "comments.read",
  "content.edit",
  "content.save",
  "feeds.read",
  "posts.publish",
  "posts.read",
  "reactions.set",
  "replies.create",
] as const);

export type HackerNewsWebOperationName = (typeof HACKER_NEWS_WEB_OPERATION_NAMES)[number];
export type HackerNewsWebContractState = "observed" | "capture-required";
export type HackerNewsWebRisk = "R1" | "R2" | "R3";

export type HackerNewsWebOperationContract = {
  readonly effect: "read" | "write";
  readonly risk: HackerNewsWebRisk;
  readonly state: HackerNewsWebContractState;
  readonly reason: string;
};

const observed = (reason: string): HackerNewsWebOperationContract => Object.freeze({
  effect: "read",
  risk: "R1",
  state: "observed",
  reason,
});

const captureRequired = (
  risk: "R2" | "R3",
  reason: string,
): HackerNewsWebOperationContract => Object.freeze({
  effect: "write",
  risk,
  state: "capture-required",
  reason,
});

export const HACKER_NEWS_WEB_OPERATIONS = Object.freeze({
  "feeds.read": observed("signed-in /news HTML with exact athing/subtext projection"),
  "posts.read": observed("exact /item?id target with submission-row binding"),
  "comments.read": observed("exact /item?id target with bounded ordered comment projection"),
  "content.save": captureRequired(
    "R2",
    "favorite and un-favorite links are request-bound; both real state fixtures and independent favorites-list readback are still required",
  ),
  "reactions.set": captureRequired(
    "R2",
    "upvote and unvote are request-bound human actions; exact undo fixture and readback are still required",
  ),
  "comments.create": captureRequired(
    "R3",
    "comment hmac form and externally visible response need an authorized fixture",
  ),
  "replies.create": captureRequired(
    "R3",
    "reply hmac form and exact parent/actor response binding need an authorized fixture",
  ),
  "posts.publish": captureRequired(
    "R3",
    "submission fnid/fnop form and returned item binding need an authorized fixture",
  ),
  "content.edit": captureRequired(
    "R3",
    "edit form is absent without an owned editable item and remains unobserved",
  ),
} as const satisfies Readonly<Record<HackerNewsWebOperationName, HackerNewsWebOperationContract>>);

const HN_ORIGIN = "https://news.ycombinator.com";
const MAX_HTML_BYTES = 4 * 1024 * 1024;

function boundedHtml(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_HTML_BYTES
    || value.includes("\0")
  ) throw new Error(`${label} exceeded its reviewed HTML bound`);
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

function itemId(value: unknown, label: string): string {
  const result = boundedString(value, label, 20);
  if (!/^[1-9][0-9]{0,19}$/u.test(result)) throw new Error(`${label} must be a decimal Hacker News item ID`);
  return result;
}

function exactUrl(value: string | URL, label: string): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    url.origin !== HN_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error(`${label} must use the exact ${HN_ORIGIN} origin`);
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
  label: string,
): void {
  const requiredSet = new Set(required);
  const missing = required.filter((name) => !values.has(name));
  const extra = [...values.keys()].filter((name) => !requiredSet.has(name));
  if (missing.length > 0) throw new Error(`${label} omitted ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`${label} contained unsupported ${extra.join(", ")}`);
}

export type HackerNewsReadOperation = "viewer.current" | "feeds.news" | "posts.read" | "comments.read";

export function authorizeHackerNewsReadRequest(input: {
  readonly operation: HackerNewsReadOperation;
  readonly url: string | URL;
  readonly method: string;
  readonly body?: unknown;
  readonly targetId?: string;
}): Readonly<{
  operation: HackerNewsReadOperation;
  method: "GET";
  path: string;
  queryNames: readonly string[];
}> {
  if (input.method.toUpperCase() !== "GET" || input.body !== undefined) {
    throw new Error("Hacker News authenticated reads require body-free GET");
  }
  const url = exactUrl(input.url, "Hacker News read URL");
  const query = exactParameters(url.searchParams, "Hacker News read query");
  if (input.operation === "viewer.current" || input.operation === "feeds.news") {
    if (url.pathname !== "/news" || query.size !== 0) {
      throw new Error("Hacker News news request changed its reviewed exchange");
    }
  } else {
    if (url.pathname !== "/item") throw new Error("Hacker News item request path is not reviewed");
    exactNames(query, ["id"], "Hacker News item query");
    const expected = itemId(input.targetId, "Hacker News requested item");
    if (query.get("id") !== expected) {
      throw new Error("Hacker News item query did not bind the requested item");
    }
  }
  return Object.freeze({
    operation: input.operation,
    method: "GET",
    path: url.pathname,
    queryNames: Object.freeze([...query.keys()].sort()),
  });
}

function attribute(attributes: string, name: string): string | null {
  const expression = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "iu",
  );
  const match = expression.exec(attributes);
  return match?.[1] ?? match?.[2] ?? null;
}

function decodeHtml(value: string): string {
  return value.replace(
    /&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/giu,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal!, decimal === undefined ? 16 : 10);
        if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "\uFFFD";
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return "\uFFFD";
        }
      }
      switch (named?.toLowerCase()) {
        case undefined: return entity;
        case "amp": return "&";
        case "apos": return "'";
        case "gt": return ">";
        case "lt": return "<";
        case "nbsp": return " ";
        case "quot": return "\"";
        default: return entity;
      }
    },
  );
}

function plainText(value: string, label: string, maximum: number): string {
  const withBreaks = value
    .replace(/<(?:br)\b[^>]*>/giu, "\n")
    .replace(/<(?:p)\b[^>]*>/giu, "\n\n")
    .replace(/<[^>]*>/gu, "");
  const text = decodeHtml(withBreaks)
    .replace(/\r/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return boundedString(text, label, maximum, true);
}

type AthingSegment = {
  readonly id: string;
  readonly classes: readonly string[];
  readonly html: string;
};

function athingSegments(value: string): readonly AthingSegment[] {
  const html = boundedHtml(value, "Hacker News page");
  const starts: {
    readonly index: number;
    readonly id: string;
    readonly classes: readonly string[];
  }[] = [];
  for (const match of html.matchAll(/<tr\b([^>]*)>/giu)) {
    const attributes = match[1] ?? "";
    const classValue = attribute(attributes, "class");
    if (classValue === null) continue;
    const classes = classValue.trim().split(/\s+/u).filter(Boolean);
    if (!classes.includes("athing")) continue;
    const id = itemId(attribute(attributes, "id"), "Hacker News athing ID");
    starts.push({
      index: match.index,
      id,
      classes: Object.freeze(classes),
    });
  }
  if (starts.length > 2_000) throw new Error("Hacker News page exceeded its reviewed athing bound");
  return Object.freeze(starts.map((start, index) => Object.freeze({
    id: start.id,
    classes: start.classes,
    html: html.slice(start.index, starts[index + 1]?.index ?? html.length),
  })));
}

function anchors(html: string): readonly {
  readonly attributes: string;
  readonly href: string;
  readonly text: string;
}[] {
  const result: {
    readonly attributes: string;
    readonly href: string;
    readonly text: string;
  }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const attributes = match[1] ?? "";
    const rawHref = attribute(attributes, "href");
    if (rawHref === null) continue;
    result.push(Object.freeze({
      attributes,
      href: decodeHtml(rawHref),
      text: plainText(match[2] ?? "", "Hacker News anchor text", 10_000),
    }));
  }
  return Object.freeze(result);
}

function classFragment(html: string, className: string): string | null {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(
    `<(?:span|div)\\b[^>]*class\\s*=\\s*(?:"[^"]*\\b${escaped}\\b[^"]*"|'[^']*\\b${escaped}\\b[^']*')[^>]*>([\\s\\S]*?)</(?:span|div)>`,
    "iu",
  );
  return expression.exec(html)?.[1] ?? null;
}

function classAnchor(html: string, className: string): {
  readonly href: string;
  readonly text: string;
} | null {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(
    `<a\\b([^>]*class\\s*=\\s*(?:"[^"]*\\b${escaped}\\b[^"]*"|'[^']*\\b${escaped}\\b[^']*')[^>]*)>([\\s\\S]*?)</a>`,
    "iu",
  );
  const match = expression.exec(html);
  if (match === null) return null;
  const href = attribute(match[1] ?? "", "href");
  if (href === null) return null;
  return Object.freeze({
    href: decodeHtml(href),
    text: plainText(match[2] ?? "", `Hacker News ${className} text`, 10_000),
  });
}

function titleAnchor(segment: AthingSegment): {
  readonly href: string;
  readonly text: string;
} {
  const fragment = classFragment(segment.html, "titleline");
  if (fragment === null) throw new Error("Hacker News submission omitted its titleline");
  const first = anchors(fragment)[0];
  if (first === undefined) throw new Error("Hacker News submission omitted its title link");
  return first;
}

function projectedHref(value: string, label: string): string {
  const href = boundedString(value, label, 4096);
  let url: URL;
  try {
    url = new URL(href, HN_ORIGIN);
  } catch {
    throw new Error(`${label} was not a valid URL`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== ""
    || url.password !== ""
  ) throw new Error(`${label} must be an HTTP URL without credentials`);
  return url.href;
}

function numericText(
  html: string,
  className: string,
  suffix: string,
): number | null {
  const fragment = classFragment(html, className);
  if (fragment === null) return null;
  const text = plainText(fragment, `Hacker News ${className}`, 128);
  const match = new RegExp(`^([0-9]+)(?:\\s+${suffix})?$`, "iu").exec(text);
  if (match === null) throw new Error(`Hacker News ${className} did not contain a reviewed number`);
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) throw new Error(`Hacker News ${className} exceeded its numeric bound`);
  return number;
}

function createdAt(html: string): string | null {
  const expression = /<(?:span)\b([^>]*class\s*=\s*(?:"[^"]*\bage\b[^"]*"|'[^']*\bage\b[^']*')[^>]*)>/iu;
  const match = expression.exec(html);
  if (match === null) return null;
  const title = attribute(match[1] ?? "", "title");
  if (title === null) return null;
  const iso = title.split(/\s+/u, 1)[0] ?? "";
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/u.test(iso)) {
    throw new Error("Hacker News age title did not contain a reviewed timestamp");
  }
  return `${iso}Z`;
}

function commentCount(segment: AthingSegment): number {
  for (const anchor of anchors(segment.html)) {
    let url: URL;
    try {
      url = new URL(anchor.href, HN_ORIGIN);
    } catch {
      continue;
    }
    if (url.origin !== HN_ORIGIN || url.pathname !== "/item" || url.searchParams.get("id") !== segment.id) continue;
    if (anchor.text === "discuss") return 0;
    const match = /^([0-9]+)\s+comments?$/u.exec(anchor.text.replace(/\u00a0/gu, " "));
    if (match !== null) return Number(match[1]);
  }
  return 0;
}

function submissionBody(segment: AthingSegment): string {
  const fragment = classFragment(segment.html, "toptext");
  return fragment === null ? "" : plainText(fragment, "Hacker News submission body", 100_000);
}

export type HackerNewsProjectedPost = {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string | null;
  readonly score: number | null;
  readonly commentCount: number;
};

function projectedPost(segment: AthingSegment): HackerNewsProjectedPost {
  if (segment.classes.includes("comtr")) throw new Error("Hacker News post projection received a comment row");
  const title = titleAnchor(segment);
  const author = classAnchor(segment.html, "hnuser");
  return Object.freeze({
    id: segment.id,
    title: boundedString(title.text, "Hacker News post title", 1_000, true),
    url: projectedHref(title.href, "Hacker News post URL"),
    author: author === null ? null : boundedString(author.text, "Hacker News post author", 64),
    body: submissionBody(segment),
    createdAt: createdAt(segment.html),
    score: numericText(segment.html, "score", "points?"),
    commentCount: commentCount(segment),
  });
}

export function parseHackerNewsViewerHtml(value: string): string {
  const html = boundedHtml(value, "Hacker News account page");
  const matches: { readonly href: string; readonly text: string }[] = [];
  for (const anchor of anchors(html)) {
    if (attribute(anchor.attributes, "id") !== "me") continue;
    matches.push(anchor);
  }
  if (matches.length !== 1) throw new Error("Hacker News page must contain exactly one current-account link");
  const current = matches[0]!;
  const url = exactUrl(new URL(current.href, HN_ORIGIN), "Hacker News current-account URL");
  if (url.pathname !== "/user") throw new Error("Hacker News current-account link changed its path");
  const query = exactParameters(url.searchParams, "Hacker News current-account query");
  exactNames(query, ["id"], "Hacker News current-account query");
  const username = boundedString(current.text, "Hacker News current username", 64);
  if (query.get("id") !== username) throw new Error("Hacker News current-account link did not bind its username");
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(username)) throw new Error("Hacker News current username is invalid");
  return username;
}

export function normalizeHackerNewsFeedHtml(
  value: string,
  limit: number,
): Readonly<{
  posts: readonly HackerNewsProjectedPost[];
  hasMore: boolean;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    throw new Error("Hacker News feed limit must be between 1 and 30");
  }
  const html = boundedHtml(value, "Hacker News feed");
  const submissions = athingSegments(html).filter((segment) => !segment.classes.includes("comtr"));
  if (submissions.length < 1 || submissions.length > 30) {
    throw new Error("Hacker News feed contained an unreviewed submission count");
  }
  return Object.freeze({
    posts: Object.freeze(submissions.slice(0, limit).map(projectedPost)),
    hasMore: /<a\b[^>]*class\s*=\s*(?:"[^"]*\bmorelink\b[^"]*"|'[^']*\bmorelink\b[^']*')/iu.test(html),
  });
}

function exactSubmission(value: string, expectedId: string): AthingSegment {
  const target = itemId(expectedId, "Hacker News requested post");
  const submissions = athingSegments(value).filter((segment) => !segment.classes.includes("comtr"));
  if (submissions.length !== 1 || submissions[0]?.id !== target) {
    throw new Error("Hacker News item page did not bind the requested post");
  }
  return submissions[0];
}

export function normalizeHackerNewsPostHtml(
  value: string,
  expectedId: string,
): Readonly<{ post: HackerNewsProjectedPost }> {
  return Object.freeze({ post: projectedPost(exactSubmission(value, expectedId)) });
}

export type HackerNewsProjectedComment = {
  readonly id: string;
  readonly postId: string;
  readonly parentId: string;
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string | null;
  readonly depth: number;
};

function commentDepth(segment: AthingSegment): number {
  const match = /<td\b([^>]*class\s*=\s*(?:"[^"]*\bind\b[^"]*"|'[^']*\bind\b[^']*')[^>]*)>/iu.exec(segment.html);
  if (match === null) throw new Error("Hacker News comment omitted its indentation");
  const raw = attribute(match[1] ?? "", "indent");
  if (raw === null || !/^(?:0|[1-9][0-9]?)$/u.test(raw)) {
    throw new Error("Hacker News comment indentation is invalid");
  }
  const depth = Number(raw);
  if (depth > 40) throw new Error("Hacker News comment indentation exceeded its reviewed bound");
  return depth;
}

function commentBody(segment: AthingSegment): string {
  const fragment = classFragment(segment.html, "commtext");
  if (fragment === null) return "";
  return plainText(fragment, "Hacker News comment body", 100_000);
}

export function normalizeHackerNewsCommentsHtml(
  value: string,
  expectedPostId: string,
  limit: number,
): Readonly<{
  post: HackerNewsProjectedPost;
  comments: readonly HackerNewsProjectedComment[];
  truncated: boolean;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Hacker News comment limit must be between 1 and 100");
  }
  const html = boundedHtml(value, "Hacker News item page");
  const post = projectedPost(exactSubmission(html, expectedPostId));
  const segments = athingSegments(html).filter((segment) => segment.classes.includes("comtr"));
  if (segments.length > 1_000) throw new Error("Hacker News comment page exceeded its reviewed row bound");
  const ancestry: string[] = [];
  const comments: HackerNewsProjectedComment[] = [];
  for (const segment of segments) {
    const depth = commentDepth(segment);
    const parentId = depth === 0 ? post.id : ancestry[depth - 1];
    if (parentId === undefined) {
      throw new Error("Hacker News comment indentation skipped its parent depth");
    }
    const explicitParent = /<a\b[^>]*href\s*=\s*(?:"#([0-9]+)"|'#([0-9]+)')[^>]*>\s*parent\s*<\/a>/iu.exec(segment.html);
    const explicitParentId = explicitParent?.[1] ?? explicitParent?.[2] ?? null;
    if (explicitParentId !== null && explicitParentId !== parentId) {
      throw new Error("Hacker News comment parent link disagreed with indentation order");
    }
    ancestry[depth] = segment.id;
    ancestry.length = depth + 1;
    if (comments.length >= limit) continue;
    const author = classAnchor(segment.html, "hnuser");
    comments.push(Object.freeze({
      id: segment.id,
      postId: post.id,
      parentId,
      author: author === null ? null : boundedString(author.text, "Hacker News comment author", 64),
      body: commentBody(segment),
      createdAt: createdAt(segment.html),
      depth,
    }));
  }
  return Object.freeze({
    post,
    comments: Object.freeze(comments),
    truncated: segments.length > limit,
  });
}

function targetSegment(value: string, targetId: string): AthingSegment {
  const target = itemId(targetId, "Hacker News action target");
  const matches = athingSegments(value).filter((segment) => segment.id === target);
  if (matches.length !== 1) throw new Error("Hacker News page did not contain one exact action target");
  return matches[0]!;
}

function safeGoto(value: unknown, label: string): string {
  const goto = boundedString(value, label, 2048);
  let url: URL;
  try {
    url = new URL(goto, HN_ORIGIN);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    url.origin !== HN_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error(`${label} escaped the Hacker News origin`);
  return `${url.pathname.slice(1)}${url.search}`;
}

export type HackerNewsFavoriteAction = {
  readonly path: "/fave" | "/unfave";
  readonly targetId: string;
  readonly auth: string;
  readonly goto: string;
  readonly nextSavedState: boolean;
};

const unconsumedFavoriteActions = new WeakSet<HackerNewsFavoriteAction>();

/**
 * Parse the one request-bound favorite action visible for an exact item.
 * Synthetic parser tests do not promote content.save; promotion still needs
 * inert evidence for both real provider states plus independent readback.
 */
export function parseHackerNewsFavoriteAction(
  value: string,
  expectedTargetId: string,
): HackerNewsFavoriteAction {
  const target = itemId(expectedTargetId, "Hacker News favorite target");
  const candidates: HackerNewsFavoriteAction[] = [];
  for (const anchor of anchors(targetSegment(value, target).html)) {
    let url: URL;
    try {
      url = new URL(anchor.href, HN_ORIGIN);
    } catch {
      continue;
    }
    if (url.origin !== HN_ORIGIN || (url.pathname !== "/fave" && url.pathname !== "/unfave")) continue;
    const query = exactParameters(url.searchParams, "Hacker News favorite query");
    exactNames(query, ["auth", "goto", "id"], "Hacker News favorite query");
    if (query.get("id") !== target) throw new Error("Hacker News favorite action did not bind its target");
    candidates.push(Object.freeze({
      path: url.pathname,
      targetId: target,
      auth: boundedString(query.get("auth"), "Hacker News request-bound favorite auth", 256),
      goto: safeGoto(query.get("goto"), "Hacker News favorite goto"),
      nextSavedState: url.pathname === "/fave",
    }));
  }
  if (candidates.length !== 1) {
    throw new Error("Hacker News page must contain exactly one request-bound favorite action");
  }
  const action = candidates[0]!;
  unconsumedFavoriteActions.add(action);
  return action;
}

function safeRedirectLocation(value: string | null): string {
  if (value === null) throw new Error("Hacker News action response omitted its redirect location");
  let url: URL;
  try {
    url = exactUrl(new URL(value, HN_ORIGIN), "Hacker News action redirect");
  } catch {
    throw new Error("Hacker News action response attempted an unreviewed redirect");
  }
  for (const name of ["auth", "hmac", "fnid", "fnop"]) {
    if (url.searchParams.has(name)) {
      throw new Error("Hacker News action redirect attempted to expose request-bound proof");
    }
  }
  if (url.pathname !== "/news" && url.pathname !== "/item" && url.pathname !== "/favorites") {
    throw new Error("Hacker News action redirect path is not reviewed");
  }
  if (url.pathname === "/item") {
    const query = exactParameters(url.searchParams, "Hacker News item redirect query");
    if (![...query.keys()].every((name) => name === "id")) {
      throw new Error("Hacker News item redirect query is not reviewed");
    }
    if (query.has("id")) itemId(query.get("id"), "Hacker News redirect item ID");
  } else if (url.search !== "") {
    throw new Error("Hacker News action redirect contained an unreviewed query");
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Execute only an action parsed from the immediately preceding provider page.
 * The request-bound `auth` value is sent once and is absent from the result.
 */
export async function dispatchHackerNewsFavoriteAction(
  client: WebSessionClient,
  action: HackerNewsFavoriteAction,
  desiredSavedState: boolean,
  beforeRequest: () => Promise<void>,
  options: {
    readonly timeoutMs?: number;
    readonly fetch?: WebSessionFetch;
  } = {},
): Promise<Readonly<{ status: 302; location: string }>> {
  if (!unconsumedFavoriteActions.has(action)) {
    throw new Error("Hacker News favorite action must come from an immediate parsed provider page");
  }
  if (action.nextSavedState !== desiredSavedState) {
    throw new Error("Hacker News request-bound favorite action does not match the desired state");
  }
  const target = itemId(action.targetId, "Hacker News favorite target");
  const auth = boundedString(action.auth, "Hacker News request-bound favorite auth", 256);
  const goto = safeGoto(action.goto, "Hacker News favorite goto");
  const url = new URL(action.path, HN_ORIGIN);
  url.searchParams.set("id", target);
  url.searchParams.set("auth", auth);
  url.searchParams.set("goto", goto);
  unconsumedFavoriteActions.delete(action);
  await beforeRequest();
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new Error("Hacker News manual redirect timeout is invalid");
  }
  const fetch = options.fetch ?? ((input: string | URL | Request, init: RequestInit = {}) => {
    const inputUrl = input instanceof Request ? new URL(input.url) : new URL(input);
    // pinnedHttpsFetch is a raw Node HTTPS transport: `redirect: "error"`
    // means no automatic follow, while still returning the 302 for the
    // provider-specific same-origin Location validation below.
    return pinnedHttpsFetch(inputUrl, { ...init, redirect: "error" }, timeoutMs);
  });
  const headers = new Headers({
    accept: "text/html",
    cookie: renderCookieHeader(client.cookies),
    referer: new URL(goto, `${HN_ORIGIN}/`).href,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error("Hacker News action failed before a reviewed redirect was received", { cause: error });
    }
    if (response.status !== 302) {
      response.body?.cancel().catch(() => undefined);
      throw new Error(`Hacker News action returned unreviewed status ${response.status}`);
    }
    const location = safeRedirectLocation(response.headers.get("location"));
    await response.body?.cancel().catch(() => undefined);
    return Object.freeze({ status: 302, location });
  } finally {
    clearTimeout(timeout);
    if (controller.signal.aborted) await response?.body?.cancel().catch(() => undefined);
  }
}

function hiddenInputs(formHtml: string, label: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const match of formHtml.matchAll(/<input\b([^>]*)>/giu)) {
    const attributes = match[1] ?? "";
    if ((attribute(attributes, "type") ?? "").toLowerCase() !== "hidden") continue;
    const name = attribute(attributes, "name");
    const value = attribute(attributes, "value");
    if (name === null || value === null) throw new Error(`${label} hidden input omitted name or value`);
    if (values.has(name)) throw new Error(`${label} repeated hidden input ${name}`);
    values.set(name, decodeHtml(value));
  }
  return values;
}

function exactForm(value: string, actionPath: "/comment" | "/r", label: string): string {
  const html = boundedHtml(value, label);
  const candidates: string[] = [];
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/giu)) {
    const attributes = match[1] ?? "";
    const action = attribute(attributes, "action");
    const method = (attribute(attributes, "method") ?? "get").toLowerCase();
    if (action === null) continue;
    const url = new URL(decodeHtml(action), HN_ORIGIN);
    if (url.origin === HN_ORIGIN && url.pathname === actionPath && method === "post") {
      candidates.push(match[0]);
    }
  }
  if (candidates.length !== 1) throw new Error(`${label} must contain exactly one ${actionPath} form`);
  return candidates[0]!;
}

export type HackerNewsCommentFormProof = {
  readonly parentId: string;
  readonly goto: string;
  readonly hmac: string;
};

export function parseHackerNewsCommentForm(
  value: string,
  expectedParentId: string,
): HackerNewsCommentFormProof {
  const parent = itemId(expectedParentId, "Hacker News comment parent");
  const hidden = hiddenInputs(exactForm(value, "/comment", "Hacker News comment page"), "Hacker News comment form");
  exactNames(hidden, ["goto", "hmac", "parent"], "Hacker News comment form");
  if (hidden.get("parent") !== parent) throw new Error("Hacker News comment form did not bind its parent");
  return Object.freeze({
    parentId: parent,
    goto: safeGoto(hidden.get("goto"), "Hacker News comment goto"),
    hmac: boundedString(hidden.get("hmac"), "Hacker News request-bound comment hmac", 512),
  });
}

export type HackerNewsSubmissionFormProof = {
  readonly fnid: string;
  readonly fnop: string;
};

export function parseHackerNewsSubmissionForm(value: string): HackerNewsSubmissionFormProof {
  const hidden = hiddenInputs(exactForm(value, "/r", "Hacker News submit page"), "Hacker News submit form");
  exactNames(hidden, ["fnid", "fnop"], "Hacker News submit form");
  return Object.freeze({
    fnid: boundedString(hidden.get("fnid"), "Hacker News request-bound fnid", 512),
    fnop: boundedString(hidden.get("fnop"), "Hacker News request-bound fnop", 128),
  });
}
