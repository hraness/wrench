import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute } from "node:path";

import { isXAccountSubject } from "../provider-subject";
import { bearerHeaders, type ProviderResponse } from "../provider-http";
import type { ProviderActionContext, ProviderFile } from "../provider-context";

const X_API_ORIGIN = "https://api.x.com";
const X_ALLOWED_HOSTS = ["api.x.com"] as const;

const POST_FIELDS = [
  "article",
  "attachments",
  "author_id",
  "card_uri",
  "community_id",
  "context_annotations",
  "conversation_id",
  "created_at",
  "display_text_range",
  "edit_controls",
  "edit_history_tweet_ids",
  "entities",
  "geo",
  "id",
  "in_reply_to_user_id",
  "lang",
  "matched_media_notes",
  "media_metadata",
  "note_tweet",
  "paid_partnership",
  "possibly_sensitive",
  "public_metrics",
  "referenced_tweets",
  "reply_settings",
  "scopes",
  "source",
  "suggested_source_links",
  "suggested_source_links_with_counts",
  "text",
  "note_request_suggestions",
  "withheld",
].join(",");

const POST_EXPANSIONS = [
  "article.cover_media",
  "article.media_entities",
  "attachments.media_keys",
  "attachments.media_source_tweet",
  "attachments.poll_ids",
  "author_id",
  "edit_history_tweet_ids",
  "entities.mentions.username",
  "entities.note.mentions.username",
  "geo.place_id",
  "in_reply_to_user_id",
  "referenced_tweets.id",
  "referenced_tweets.id.attachments.media_keys",
  "referenced_tweets.id.author_id",
].join(",");

const MEDIA_FIELDS = [
  "alt_text",
  "duration_ms",
  "height",
  "media_key",
  "preview_image_url",
  "public_metrics",
  "type",
  "url",
  "variants",
  "width",
].join(",");

const POLL_FIELDS = "duration_minutes,end_datetime,id,options,voting_status";
const PLACE_FIELDS = "contained_within,country,country_code,full_name,geo,id,name,place_type";
const USER_FIELDS = [
  "affiliation",
  "created_at",
  "description",
  "entities",
  "id",
  "is_identity_verified",
  "location",
  "most_recent_tweet_id",
  "name",
  "parody",
  "pinned_tweet_id",
  "profile_banner_url",
  "profile_image_url",
  "protected",
  "public_metrics",
  "receives_your_dm",
  "subscription_type",
  "subscription",
  "url",
  "username",
  "verified",
  "verified_followers_count",
  "verified_type",
  "withheld",
].join(",");

const DM_EVENT_FIELDS = [
  "attachments",
  "created_at",
  "dm_conversation_id",
  "entities",
  "event_type",
  "id",
  "participant_ids",
  "referenced_tweets",
  "sender_id",
  "text",
].join(",");

const DM_EXPANSIONS = [
  "attachments.media_keys",
  "participant_ids",
  "referenced_tweets.id",
  "sender_id",
].join(",");

const CHAT_CONVERSATION_FIELDS = [
  "admin_ids",
  "created_at",
  "group_avatar_url",
  "group_name",
  "id",
  "is_muted",
  "member_ids",
  "message_ttl_msec",
  "participant_ids",
  "screen_capture_blocking_enabled",
  "screen_capture_detection_enabled",
  "type",
  "updated_at",
].join(",");

const CHAT_CONVERSATION_EXPANSIONS = "admin_ids,member_ids,participant_ids";
const CHAT_MESSAGE_EVENT_FIELDS = [
  "conversation_id",
  "conversation_token",
  "created_at_msec",
  "encoded_event",
  "id",
  "is_trusted",
  "message_event_signature",
  "previous_id",
  "sender_id",
].join(",");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GIF_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
const FILE_VERIFY_CHUNK_BYTES = 1024 * 1024;
const MAX_MEDIA_STATUS_POLLS = 100;
const MAX_MEDIA_STATUS_WAIT_MS = 8 * 60_000;
const MAX_CHAT_KEY_EVENTS = 1_000;
const MAX_CHAT_ENVELOPE_CHARACTERS = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

type UploadedMedia = {
  readonly id: string;
  readonly category: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly altText?: string;
};

type PreparedProviderFile = {
  readonly file: ProviderFile;
  /** The exact file identity observed by the complete pre-dispatch digest pass. */
  readonly preflightIdentity: BigIntStats;
};

type OpenedProviderFile = {
  readonly descriptor: number;
  readonly stats: BigIntStats;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`official X ${label} is not an object`);
  return value;
}

function recordBody(response: ProviderResponse, label: string): JsonRecord {
  if (!isRecord(response.body)) throw new Error(`official X ${label} response is not an object`);
  return response.body;
}

function dataRecord(response: ProviderResponse, label: string): JsonRecord {
  const body = recordBody(response, label);
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors)) throw new Error(`official X ${label} response returned invalid errors`);
    if (body.errors.length > 0) throw new Error(`official X ${label} response returned provider errors`);
  }
  if (!isRecord(body.data)) throw new Error(`official X ${label} response omitted data`);
  return body.data;
}

function requiredString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`official X ${label} response omitted ${key}`);
  }
  return value;
}

function optionalString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function responseItems(response: ProviderResponse, label: string): readonly unknown[] {
  const body = recordBody(response, label);
  if (body.data === undefined) return [];
  if (!Array.isArray(body.data)) throw new Error(`official X ${label} response data is not a collection`);
  return body.data;
}

function inputString(context: ProviderActionContext, name: string): string {
  const value = context.input[name];
  if (typeof value !== "string") throw new Error(`input.${name} must be a string`);
  return value;
}

function optionalInputString(context: ProviderActionContext, name: string): string | undefined {
  const value = context.input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`input.${name} must be a string`);
  return value;
}

function optionalInputNumber(context: ProviderActionContext, name: string): number | undefined {
  const value = context.input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`input.${name} must be a safe integer`);
  return value;
}

function optionalInputBoolean(context: ProviderActionContext, name: string): boolean | undefined {
  const value = context.input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`input.${name} must be a boolean`);
  return value;
}

function inputStrings(context: ProviderActionContext, name: string): readonly string[] {
  const value = context.input[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`input.${name} must be a string array`);
  }
  return value;
}

function optionalInputStrings(context: ProviderActionContext, name: string): readonly string[] | undefined {
  if (context.input[name] === undefined) return undefined;
  return inputStrings(context, name);
}

function inputNumbers(context: ProviderActionContext, name: string): readonly number[] {
  const value = context.input[name];
  if (!Array.isArray(value)) throw new Error(`input.${name} must be a safe-integer array`);
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isSafeInteger(item)) {
      throw new Error(`input.${name} must be a safe-integer array`);
    }
    numbers.push(item);
  }
  return numbers;
}

function hasAnyAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function exactXId(value: string, label: string): string {
  if (!isXAccountSubject(value)) throw new Error(`${label} must be a 1-19 digit X object ID`);
  return value;
}

function inputXId(context: ProviderActionContext, name: string): string {
  return exactXId(inputString(context, name), `input.${name}`);
}

function optionalInputXId(context: ProviderActionContext, name: string): string | undefined {
  const value = optionalInputString(context, name);
  return value === undefined ? undefined : exactXId(value, `input.${name}`);
}

function exactDmConversationId(value: string, label: string): string {
  if (!/^(?:[0-9]{15,19}|[0-9]{1,19}-[0-9]{1,19})$/u.test(value)) {
    throw new Error(`${label} must be an exact legacy X DM conversation ID`);
  }
  if (value.includes("-")) {
    const [left, right] = value.split("-");
    if (left === right) throw new Error(`${label} must identify two different legacy X DM participants`);
  }
  return value;
}

function exactChatConversationId(value: string, label: string): string {
  if (!/^(?:[0-9]{1,19}|[0-9]{1,19}-[0-9]{1,19}|g[0-9]{1,19})$/u.test(value)) {
    throw new Error(`${label} must be an exact X Chat recipient or conversation ID`);
  }
  if (value.includes("-")) {
    const [left, right] = value.split("-");
    if (left === right) throw new Error(`${label} must identify two different X Chat participants`);
  }
  return value;
}

function exactChatEventConversationId(value: string, label: string): string {
  if (!/^(?:[0-9]{1,19}:[0-9]{1,19}|g[0-9]{1,19})$/u.test(value)) {
    throw new Error(`${label} must be an exact X Chat event conversation ID`);
  }
  return value;
}

function exactEncryptedChatEnvelope(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CHAT_ENVELOPE_CHARACTERS
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
    || Buffer.from(value, "base64").toString("base64") !== value
  ) {
    throw new Error(`official X ${label} contained an invalid encrypted envelope`);
  }
  return value;
}

function exactUniqueXIds(values: readonly string[], label: string): readonly string[] {
  const ids = values.map((value, index) => exactXId(value, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must contain unique X object IDs`);
  return ids;
}

function bearer(context: ProviderActionContext, json = false): Headers {
  return bearerHeaders(context.token.accessToken, {
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  });
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value);
}

function richPostParams(url: URL): void {
  url.searchParams.set("tweet.fields", POST_FIELDS);
  url.searchParams.set("expansions", POST_EXPANSIONS);
  url.searchParams.set("media.fields", MEDIA_FIELDS);
  url.searchParams.set("poll.fields", POLL_FIELDS);
  url.searchParams.set("place.fields", PLACE_FIELDS);
  url.searchParams.set("user.fields", USER_FIELDS);
}

function richDmParams(url: URL): void {
  url.searchParams.set("dm_event.fields", DM_EVENT_FIELDS);
  url.searchParams.set("expansions", DM_EXPANSIONS);
  url.searchParams.set("media.fields", MEDIA_FIELDS);
  url.searchParams.set("tweet.fields", POST_FIELDS);
  url.searchParams.set("user.fields", USER_FIELDS);
}

function richChatConversationParams(url: URL): void {
  url.searchParams.set("chat_conversation.fields", CHAT_CONVERSATION_FIELDS);
  url.searchParams.set("expansions", CHAT_CONVERSATION_EXPANSIONS);
  url.searchParams.set("user.fields", USER_FIELDS);
}

async function request(
  context: ProviderActionContext,
  url: URL | string,
  init: RequestInit,
  statuses: readonly number[],
): Promise<ProviderResponse> {
  const response = await context.http.request(url, init, statuses, X_ALLOWED_HOSTS);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const body = response.body;
    if (isRecord(body) && body.errors !== undefined) {
      if (!Array.isArray(body.errors)) throw new Error("official X mutation response returned invalid errors");
      if (body.errors.length > 0) throw new Error("official X mutation response returned provider errors");
    }
  }
  return response;
}

async function authenticatedUserId(context: ProviderActionContext): Promise<string> {
  const url = new URL(`${X_API_ORIGIN}/2/users/me`);
  url.searchParams.set("user.fields", "id,name,username");
  const response = await request(context, url, { method: "GET", headers: bearer(context) }, [200]);
  const id = exactXId(
    requiredString(dataRecord(response, "authenticated-user"), "id", "authenticated-user"),
    "official X authenticated-user id",
  );
  if (context.auth.subject !== undefined && context.auth.subject !== id) {
    throw new Error("authenticated X user does not match the OAuth locator subject");
  }
  return id;
}

async function authenticatedWriteUserId(context: ProviderActionContext): Promise<string> {
  if (context.auth.subject === undefined) {
    throw new Error("official X write capabilities require an OAuth locator with the exact authenticated user ID as its subject");
  }
  exactXId(context.auth.subject, "OAuth locator subject");
  return authenticatedUserId(context);
}

async function authenticatedPrivateReadUserId(context: ProviderActionContext): Promise<string> {
  if (context.auth.subject === undefined) {
    throw new Error("official X private-message reads require an OAuth locator with the exact authenticated user ID as its subject");
  }
  exactXId(context.auth.subject, "OAuth locator subject");
  return authenticatedUserId(context);
}

function providerPage(
  response: ProviderResponse,
  requestedLimit: number,
  returned: number,
  providerReturned: number,
): JsonRecord {
  const body = recordBody(response, "page");
  if (body.meta !== undefined && !isRecord(body.meta)) throw new Error("official X page returned invalid metadata");
  const meta = isRecord(body.meta) ? body.meta : null;
  for (const name of ["next_token", "previous_token"] as const) {
    const value = meta?.[name];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new Error(`official X page returned an invalid ${name}`);
    }
  }
  const resultCount = meta?.result_count;
  if (resultCount !== undefined && (!Number.isSafeInteger(resultCount) || resultCount !== providerReturned)) {
    throw new Error("official X page result_count did not match the returned collection");
  }
  const next = optionalString(meta, "next_token");
  const previous = optionalString(meta, "previous_token");
  return {
    requestedLimit,
    returned,
    providerReturned,
    cursor: {
      next,
      previous,
    },
    newestId: optionalString(meta, "newest_id"),
    oldestId: optionalString(meta, "oldest_id"),
    pageExhausted: meta === null ? null : next === null,
  };
}

function exactDirectDmConversationSet(value: string, label: string): ReadonlySet<string> {
  const id = exactDmConversationId(value, label);
  if (!id.includes("-")) throw new Error(`${label} did not identify a direct legacy X DM conversation`);
  return new Set(id.split("-"));
}

function sameIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function chatProviderPage(
  response: ProviderResponse,
  requestedLimit: number,
  returned: number,
): JsonRecord {
  const body = recordBody(response, "Chat page");
  if (body.meta !== undefined && !isRecord(body.meta)) throw new Error("official X Chat page returned invalid metadata");
  const metaPresent = isRecord(body.meta);
  const meta = metaPresent ? body.meta as JsonRecord : {};
  const nextValue = meta.next_token;
  if (nextValue !== undefined && (typeof nextValue !== "string" || nextValue.length === 0)) {
    throw new Error("official X Chat page returned an invalid next token");
  }
  const next = typeof nextValue === "string" ? nextValue : null;
  const hasMoreValue = meta.has_more;
  if (hasMoreValue !== undefined && typeof hasMoreValue !== "boolean") {
    throw new Error("official X Chat page returned an invalid has_more value");
  }
  if (hasMoreValue === true && next === null) {
    throw new Error("official X Chat page claimed more results without a next token");
  }
  if (hasMoreValue === false && next !== null) {
    throw new Error("official X Chat page returned a next token after declaring the page complete");
  }
  const resultCount = meta.result_count;
  if (resultCount !== undefined && (!Number.isSafeInteger(resultCount) || resultCount !== returned)) {
    throw new Error("official X Chat page result_count did not match the returned collection");
  }
  return {
    requestedLimit,
    returned,
    providerReturned: returned,
    cursor: { next, previous: null },
    pageExhausted: !metaPresent ? null : hasMoreValue === undefined ? next === null : !hasMoreValue,
  };
}

function providerIncludes(response: ProviderResponse): JsonRecord {
  const body = recordBody(response, "includes");
  return isRecord(body.includes) ? body.includes : {};
}

function providerErrors(response: ProviderResponse): readonly unknown[] {
  const body = recordBody(response, "errors");
  return Array.isArray(body.errors) ? body.errors : [];
}

function exactItemIds(items: readonly unknown[], label: string): readonly string[] {
  const ids = items.map((value, index) => {
    const item = record(value, `${label} item ${index + 1}`);
    return exactXId(requiredString(item, "id", `${label} item`), `official X ${label} item id`);
  });
  if (new Set(ids).size !== ids.length) throw new Error(`official X ${label} response contained duplicate item IDs`);
  return ids;
}

function postUrl(id: string): string {
  return `https://x.com/i/web/status/${encodedSegment(id)}`;
}

async function executeFeedsRead(context: ProviderActionContext): Promise<void> {
  const feed = inputString(context, "feed");
  const requestedLimit = optionalInputNumber(context, "limit") ?? 10;
  let minimumResults = 1;
  let url: URL;
  let limitation: string;

  if (feed === "home-reverse-chronological") {
    const me = await authenticatedUserId(context);
    url = new URL(`${X_API_ORIGIN}/2/users/${encodedSegment(me)}/timelines/reverse_chronological`);
    limitation = "Reverse chronological followed-account timeline; this is not the algorithmic For You feed.";
  } else if (feed === "user") {
    minimumResults = 5;
    url = new URL(`${X_API_ORIGIN}/2/users/${encodedSegment(inputXId(context, "user_id"))}/tweets`);
    limitation = "The official endpoint is bounded to the account's recent post history and may omit older posts.";
  } else if (feed === "mentions") {
    minimumResults = 5;
    url = new URL(`${X_API_ORIGIN}/2/users/${encodedSegment(inputXId(context, "user_id"))}/mentions`);
    limitation = "The official mentions endpoint is bounded to recent results and may omit older mentions.";
  } else if (feed === "list") {
    context.addRequiredScopes(["list.read"]);
    url = new URL(`${X_API_ORIGIN}/2/lists/${encodedSegment(inputXId(context, "list_id"))}/tweets`);
    limitation = "This is the official List-post collection, not a home or For You feed.";
  } else if (feed === "recent-search") {
    minimumResults = 10;
    url = new URL(`${X_API_ORIGIN}/2/tweets/search/recent`);
    url.searchParams.set("query", inputString(context, "query"));
    limitation = "Recent search covers at most the last seven days; older matching posts are not represented.";
  } else if (feed === "bookmarks") {
    context.addRequiredScopes(["bookmark.read"]);
    const me = await authenticatedUserId(context);
    url = new URL(`${X_API_ORIGIN}/2/users/${encodedSegment(me)}/bookmarks`);
    limitation = "This is the authenticated account's official bookmark collection, not a public feed.";
  } else {
    throw new Error("input.feed names an unsupported official X feed");
  }

  if (requestedLimit < minimumResults) {
    throw new Error(`input.limit must be at least ${minimumResults} for the official X ${feed} endpoint`);
  }

  url.searchParams.set("max_results", String(requestedLimit));
  const cursor = optionalInputString(context, "cursor");
  if (cursor !== undefined) {
    url.searchParams.set(feed === "recent-search" ? "next_token" : "pagination_token", cursor);
  }

  if (["home-reverse-chronological", "user", "mentions", "recent-search"].includes(feed)) {
    for (const [inputName, queryName] of [
      ["since_id", "since_id"],
      ["until_id", "until_id"],
      ["start_time", "start_time"],
      ["end_time", "end_time"],
    ] as const) {
      const value = inputName === "since_id" || inputName === "until_id"
        ? optionalInputXId(context, inputName)
        : optionalInputString(context, inputName);
      if (value !== undefined) url.searchParams.set(queryName, value);
    }
  }

  if (feed === "home-reverse-chronological" || feed === "user") {
    const exclusions: string[] = [];
    if (optionalInputBoolean(context, "exclude_replies") === true) exclusions.push("replies");
    if (optionalInputBoolean(context, "exclude_reposts") === true) exclusions.push("retweets");
    if (exclusions.length > 0) url.searchParams.set("exclude", exclusions.join(","));
  }
  if (feed === "recent-search") {
    const sort = optionalInputString(context, "sort");
    if (sort !== undefined) url.searchParams.set("sort_order", sort);
  }
  richPostParams(url);

  const response = await request(context, url, { method: "GET", headers: bearer(context) }, [200]);
  const allItems = responseItems(response, "feed");
  if (allItems.length > requestedLimit) {
    throw new Error("official X feed response exceeded the requested result bound");
  }
  const items = allItems;
  exactItemIds(items, "feed");
  context.setOutput({
    provider: "x",
    operation: "feeds.read",
    feed,
    items,
    includes: providerIncludes(response),
    providerErrors: providerErrors(response),
    page: providerPage(response, requestedLimit, items.length, allItems.length),
    coverage: {
      complete: false,
      limitation,
      forYou: false,
    },
  });
}

async function executePostsRead(context: ProviderActionContext): Promise<void> {
  const ids = exactUniqueXIds(inputStrings(context, "post_ids"), "input.post_ids");
  const url = new URL(`${X_API_ORIGIN}/2/tweets`);
  url.searchParams.set("ids", ids.join(","));
  richPostParams(url);
  const response = await request(context, url, { method: "GET", headers: bearer(context) }, [200]);
  const items = responseItems(response, "post lookup");
  const returnedIds = exactItemIds(items, "post lookup");
  const requested = new Set(ids);
  if (returnedIds.some((id) => !requested.has(id))) {
    throw new Error("official X post lookup returned an unrequested post ID");
  }
  const errors = providerErrors(response);
  context.setOutput({
    provider: "x",
    operation: "posts.read",
    items,
    includes: providerIncludes(response),
    providerErrors: errors,
    coverage: {
      complete: returnedIds.length === ids.length && errors.length === 0,
      requestedIds: ids,
      returned: items.length,
    },
  });
  if (ids.length === 1) context.setFinalUrl(postUrl(ids[0] ?? ""));
}

async function executeCommentsRead(context: ProviderActionContext): Promise<void> {
  const postId = inputXId(context, "post_id");
  const requestedLimit = optionalInputNumber(context, "limit") ?? 10;
  if (requestedLimit < 10) throw new Error("input.limit must be at least 10 for official X recent reply search");
  const window = optionalInputString(context, "window") ?? "recent-7-days";
  const url = new URL(window === "recent-7-days"
    ? `${X_API_ORIGIN}/2/tweets/search/recent`
    : window === "full-archive"
      ? `${X_API_ORIGIN}/2/tweets/search/all`
      : (() => { throw new Error("input.window names an unsupported official X reply-search window"); })());
  url.searchParams.set("query", `conversation_id:${postId} is:reply`);
  url.searchParams.set("max_results", String(Math.max(10, requestedLimit)));
  const cursor = optionalInputString(context, "cursor");
  if (cursor !== undefined) url.searchParams.set("next_token", cursor);
  richPostParams(url);
  const response = await request(context, url, { method: "GET", headers: bearer(context) }, [200]);
  const allItems = responseItems(response, "reply search");
  if (allItems.length > requestedLimit) throw new Error("official X reply search exceeded the requested result bound");
  const items = allItems;
  exactItemIds(items, "reply search");
  for (const [index, value] of items.entries()) {
    const item = record(value, `reply search item ${index + 1}`);
    if (exactXId(requiredString(item, "conversation_id", "reply search item"), "official X reply conversation id") !== postId) {
      throw new Error("official X reply search returned an item outside the requested conversation");
    }
  }
  context.setOutput({
    provider: "x",
    operation: "comments.read",
    rootPostId: postId,
    items,
    includes: providerIncludes(response),
    providerErrors: providerErrors(response),
    page: providerPage(response, requestedLimit, items.length, allItems.length),
    coverage: {
      complete: false,
      limitation: window === "recent-7-days"
        ? "Replies are reconstructed with recent search, which covers at most seven days; this is never a complete conversation archive."
        : "Replies are reconstructed with entitled full-archive search and opaque pagination; search results are never labeled a provably complete conversation archive.",
      window,
    },
  });
  context.setFinalUrl(postUrl(postId));
}

async function executeMessagingList(context: ProviderActionContext): Promise<void> {
  const view = inputString(context, "view");
  const requestedLimit = optionalInputNumber(context, "limit") ?? 100;
  let url: URL;
  let chatView = false;
  if (view === "all") {
    url = new URL(`${X_API_ORIGIN}/2/dm_events`);
  } else if (view === "participant") {
    const participantId = inputXId(context, "target_id");
    if (participantId === context.auth.subject) throw new Error("input.target_id must identify another X DM participant");
    url = new URL(`${X_API_ORIGIN}/2/dm_conversations/with/${encodedSegment(participantId)}/dm_events`);
  } else if (view === "conversation") {
    const conversationId = exactDmConversationId(inputString(context, "target_id"), "input.target_id");
    url = new URL(`${X_API_ORIGIN}/2/dm_conversations/${encodedSegment(conversationId)}/dm_events`);
  } else if (view === "chat-conversations") {
    chatView = true;
    url = new URL(`${X_API_ORIGIN}/2/chat/conversations`);
  } else if (view === "chat-events") {
    chatView = true;
    const conversationId = exactChatConversationId(inputString(context, "target_id"), "input.target_id");
    if (conversationId === context.auth.subject) {
      throw new Error("input.target_id must identify another X Chat participant");
    }
    url = new URL(`${X_API_ORIGIN}/2/chat/conversations/${encodedSegment(conversationId)}/events`);
  } else {
    throw new Error("input.view names an unsupported official X messaging collection");
  }
  url.searchParams.set("max_results", String(requestedLimit));
  const cursor = optionalInputString(context, "cursor");
  if (cursor !== undefined) url.searchParams.set("pagination_token", cursor);
  if (view === "chat-conversations") richChatConversationParams(url);
  else if (view === "chat-events") url.searchParams.set("chat_message_event.fields", CHAT_MESSAGE_EVENT_FIELDS);
  else richDmParams(url);
  await authenticatedPrivateReadUserId(context);
  const response = await request(context, url, { method: "GET", headers: bearer(context) }, [200]);
  const label = view === "chat-conversations" ? "Chat conversation list" : view === "chat-events" ? "Chat event list" : "DM-event list";
  const items = responseItems(response, label);
  if (items.length > requestedLimit) throw new Error(`official X ${label} response exceeded the requested result bound`);
  if (view === "chat-conversations") {
    const ids = items.map((value, index) => {
      const item = record(value, `Chat conversation item ${index + 1}`);
      return exactChatConversationId(requiredString(item, "id", "Chat conversation item"), "official X Chat conversation id");
    });
    if (new Set(ids).size !== ids.length) throw new Error("official X Chat conversation response contained duplicate IDs");
  } else if (view === "chat-events") {
    const ids = items.map((value, index) => {
      const item = record(value, `Chat event item ${index + 1}`);
      const id = requiredString(item, "id", "Chat event item");
      if (id.length > 256 || hasAnyAsciiControl(id)) {
        throw new Error("official X Chat event response contained an invalid event ID");
      }
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new Error("official X Chat event response contained duplicate IDs");
  } else {
    exactItemIds(items, label);
    const subject = exactXId(context.auth.subject ?? "", "OAuth locator subject");
    const requestedParticipant = view === "participant" ? inputXId(context, "target_id") : null;
    const requestedConversation = view === "conversation"
      ? exactDmConversationId(inputString(context, "target_id"), "input.target_id")
      : null;
    for (const [index, value] of items.entries()) {
      const item = record(value, `DM-event item ${index + 1}`);
      const conversationId = exactDmConversationId(
        requiredString(item, "dm_conversation_id", "DM-event item"),
        "official X DM-event conversation id",
      );
      if (requestedConversation !== null && conversationId !== requestedConversation) {
        throw new Error("official X DM-event response contained an event outside the requested conversation");
      }
      if (requestedParticipant !== null) {
        const returnedParticipants = exactDirectDmConversationSet(
          conversationId,
          "official X DM-event conversation id",
        );
        const requestedParticipants = new Set([subject, requestedParticipant]);
        if (!sameIdSet(returnedParticipants, requestedParticipants)) {
          throw new Error("official X DM-event response contained an event outside the requested participant conversation");
        }
      }
    }
  }
  if (view === "chat-events") {
    const target = exactChatConversationId(inputString(context, "target_id"), "input.target_id");
    const subject = exactXId(context.auth.subject ?? "", "OAuth locator subject");
    const dataEnvelopes = new Set<string>();
    for (const [index, value] of items.entries()) {
      const item = record(value, `Chat event item ${index + 1}`);
      const encodedEvent = exactEncryptedChatEnvelope(item.encoded_event, "Chat event response");
      if (dataEnvelopes.has(encodedEvent)) {
        throw new Error("official X Chat event response contained duplicate encrypted envelopes");
      }
      dataEnvelopes.add(encodedEvent);
      if (item.sender_id !== undefined) exactXId(requiredString(item, "sender_id", "Chat event item"), "official X Chat sender id");
      if (item.is_trusted !== undefined && typeof item.is_trusted !== "boolean") {
        throw new Error("official X Chat event response contained an invalid trust marker");
      }
      if (item.created_at_msec !== undefined
        && (typeof item.created_at_msec !== "string" || !/^[0-9]{1,20}$/u.test(item.created_at_msec))) {
        throw new Error("official X Chat event response contained an invalid creation timestamp");
      }
      const returned = exactChatEventConversationId(
        requiredString(item, "conversation_id", "Chat event item"),
        "official X Chat event conversation id",
      );
      const matches = target.startsWith("g")
        ? returned === target
        : (() => {
            if (returned.startsWith("g")) return false;
            const returnedUsers = new Set(returned.split(":"));
            const targetUsers = new Set(target.includes("-") ? target.split("-") : [subject, target]);
            if (targetUsers.size !== 2) throw new Error("input.target_id must identify another X Chat participant");
            return returnedUsers.size === 2
              && [...targetUsers].every((id) => returnedUsers.has(id))
              && [...returnedUsers].every((id) => targetUsers.has(id));
          })();
      if (!matches) throw new Error("official X Chat event response contained an event outside the requested conversation");
    }
    const responseBody = recordBody(response, "Chat event list");
    if (responseBody.meta !== undefined && !isRecord(responseBody.meta)) {
      throw new Error("official X Chat page returned invalid metadata");
    }
    const keyEventsValue = isRecord(responseBody.meta) ? responseBody.meta.conversation_key_events : undefined;
    if (keyEventsValue !== undefined) {
      if (!Array.isArray(keyEventsValue) || keyEventsValue.length > MAX_CHAT_KEY_EVENTS) {
        throw new Error("official X Chat event metadata returned an invalid conversation_key_events collection");
      }
      const keyEvents = new Set<string>();
      let aggregateCharacters = 0;
      for (const [index, value] of keyEventsValue.entries()) {
        const envelope = exactEncryptedChatEnvelope(value, `Chat conversation key event ${index + 1}`);
        aggregateCharacters += envelope.length;
        if (aggregateCharacters > MAX_CHAT_ENVELOPE_CHARACTERS) {
          throw new Error("official X Chat conversation key events exceeded the aggregate response bound");
        }
        if (keyEvents.has(envelope) || dataEnvelopes.has(envelope)) {
          throw new Error("official X Chat conversation key events contained duplicate encrypted envelopes");
        }
        keyEvents.add(envelope);
      }
    }
  }
  const body = recordBody(response, label);
  const meta = isRecord(body.meta) ? body.meta : {};
  if (view === "chat-conversations" && meta.has_message_requests !== undefined
    && typeof meta.has_message_requests !== "boolean") {
    throw new Error("official X Chat conversation page returned an invalid message-request indicator");
  }
  context.setOutput({
    provider: "x",
    operation: "messaging.list",
    view,
    items,
    includes: providerIncludes(response),
    providerErrors: providerErrors(response),
    page: chatView
      ? chatProviderPage(response, requestedLimit, items.length)
      : providerPage(response, requestedLimit, items.length, items.length),
    ...(chatView ? { meta } : {}),
    coverage: chatView
      ? {
          complete: false,
          encryptedChat: true,
          plaintextAvailable: false,
          ...(view === "chat-conversations" && typeof meta.has_message_requests === "boolean"
            ? { messageRequestsPending: meta.has_message_requests }
            : {}),
          limitation: view === "chat-conversations"
            ? "The official Chat index exposes conversation metadata and whether requests are pending, but not separate Requests/Priority/Hidden folder collections or plaintext messages."
            : "Official Chat events contain signed encrypted envelopes; wrench returns the provider envelope without claiming to decrypt or verify its plaintext.",
        }
      : {
          complete: false,
          window: "dm-events-30-days",
          limitation: "The legacy DM-event API exposes at most 30 days and does not enumerate the Requests, Priority, and Hidden inbox views.",
          encryptedChat: false,
        },
  });
}

async function executeMessagingRead(context: ProviderActionContext): Promise<void> {
  const eventId = inputXId(context, "event_id");
  const url = new URL(`${X_API_ORIGIN}/2/dm_events/${encodedSegment(eventId)}`);
  richDmParams(url);
  await authenticatedPrivateReadUserId(context);
  const response = await request(context, url, { method: "GET", headers: bearer(context) }, [200]);
  const item = dataRecord(response, "DM-event lookup");
  const returnedId = exactXId(requiredString(item, "id", "DM-event lookup"), "official X DM-event id");
  if (returnedId !== eventId) throw new Error("official X DM-event lookup returned an unexpected event ID");
  context.setOutput({
    provider: "x",
    operation: "messaging.read",
    item,
    includes: providerIncludes(response),
    providerErrors: providerErrors(response),
    coverage: {
      complete: true,
      window: "dm-events-30-days",
      limitation: "This reads one official DM event, not an encrypted Chat message or an inbox-folder classification.",
      encryptedChat: false,
    },
  });
}

function mediaLimit(mediaType: string): number {
  if (mediaType === "image/jpeg" || mediaType === "image/png") return MAX_IMAGE_BYTES;
  if (mediaType === "image/gif") return MAX_GIF_BYTES;
  if (mediaType === "video/mp4") return MAX_VIDEO_BYTES;
  throw new Error(`official X media upload does not support ${mediaType}`);
}

function validateMediaFile(file: ProviderFile): void {
  const maximum = mediaLimit(file.mediaType);
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > maximum) {
    throw new Error(`official X ${file.mediaType} attachment exceeds its ${maximum}-byte limit`);
  }
  if (!/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error("official X attachment has an invalid confirmed digest");
}

function validatePostMedia(files: readonly ProviderFile[]): void {
  for (const file of files) validateMediaFile(file);
  if (files.length > 4) {
    throw new Error("official X posts support at most four static images");
  }
  const nonImages = files.filter((file) => file.mediaType === "image/gif" || file.mediaType === "video/mp4");
  if (nonImages.length > 0 && files.length !== 1) {
    throw new Error("official X posts support either up to four static images or one GIF/video");
  }
}

function sameProviderFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode;
}

function openProviderFile(file: ProviderFile, expectedIdentity?: BigIntStats): OpenedProviderFile {
  validateMediaFile(file);
  if (!isAbsolute(file.path)) throw new Error("official X attachment resolver returned a non-absolute path");
  let descriptor: number;
  try {
    descriptor = openSync(
      file.path,
      constants.O_RDONLY
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
        | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
    );
  } catch {
    // Never surface the local attachment path from a system error.
    throw new Error("official X attachment could not be opened safely");
  }
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !stats.isFile()
      || stats.size !== BigInt(file.bytes)
      || (uid !== undefined && stats.uid !== BigInt(uid))
      || (process.platform !== "win32" && (stats.mode & 0o777n) !== 0o600n)
    ) throw new Error("official X attachments must be current-user-owned mode-0600 regular files with their confirmed size");
    if (expectedIdentity !== undefined && !sameProviderFile(expectedIdentity, stats)) {
      throw new Error("official X attachment identity changed after its provider preflight");
    }
    return { descriptor, stats };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function closeProviderFile(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    throw new Error("official X attachment descriptor could not be closed safely");
  }
}

function verifiedProviderRead(
  file: ProviderFile,
  expectedIdentity: BigIntStats | undefined,
  materialize: boolean,
): { readonly identity: BigIntStats; readonly bytes: Buffer | null } {
  const opened = openProviderFile(file, expectedIdentity);
  const output = materialize ? Buffer.alloc(file.bytes) : null;
  const scratch = materialize ? null : Buffer.alloc(Math.min(FILE_VERIFY_CHUNK_BYTES, file.bytes));
  const hash = createHash("sha256");
  let offset = 0;
  try {
    while (offset < file.bytes) {
      const destination = output ?? scratch;
      if (destination === null) throw new Error("official X attachment verification buffer is unavailable");
      const destinationOffset = output === null ? 0 : offset;
      const length = Math.min(
        output === null ? destination.byteLength : FILE_VERIFY_CHUNK_BYTES,
        file.bytes - offset,
      );
      const count = readSync(opened.descriptor, destination, destinationOffset, length, offset);
      if (count < 1) throw new Error("official X attachment ended before its confirmed byte length");
      hash.update(destination.subarray(destinationOffset, destinationOffset + count));
      offset += count;
    }
    const after = fstatSync(opened.descriptor, { bigint: true });
    if (!sameProviderFile(opened.stats, after)) {
      throw new Error("official X attachment identity changed while it was verified");
    }
    if (hash.digest("hex") !== file.sha256) {
      throw new Error("official X attachment no longer matches its confirmed digest");
    }
    return { identity: opened.stats, bytes: output };
  } finally {
    closeProviderFile(opened.descriptor);
  }
}

function preflightProviderFile(file: ProviderFile): PreparedProviderFile {
  const verified = verifiedProviderRead(file, undefined, false);
  return { file, preflightIdentity: verified.identity };
}

function preflightProviderFiles(files: readonly ProviderFile[]): readonly PreparedProviderFile[] {
  return files.map(preflightProviderFile);
}

function mediaCategory(mediaType: string, destination: "tweet" | "dm"): string {
  if (mediaType === "image/jpeg" || mediaType === "image/png") return `${destination}_image`;
  if (mediaType === "image/gif") return `${destination}_gif`;
  if (mediaType === "video/mp4") return `${destination}_video`;
  throw new Error(`official X media upload does not support ${mediaType}`);
}

function genericUploadName(mediaType: string): string {
  if (mediaType === "image/jpeg") return "upload.jpg";
  if (mediaType === "image/png") return "upload.png";
  if (mediaType === "image/gif") return "upload.gif";
  if (mediaType === "video/mp4") return "upload.mp4";
  return "upload.bin";
}

type MultipartField = {
  readonly name: string;
  readonly value: string;
};

type MultipartPayload = {
  readonly body: Uint8Array;
  readonly contentType: string;
};

function exactMultipartToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(value)) {
    throw new Error(`official X ${label} is not a safe multipart token`);
  }
  return value;
}

function exactMultipartMediaType(value: string): string {
  if (!/^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/u.test(value)) {
    throw new Error("official X upload media type is not a safe multipart value");
  }
  return value;
}

function exactMultipartValue(value: string, label: string): string {
  if (
    Buffer.byteLength(value, "utf8") > 1_024
    || value.includes("\r")
    || value.includes("\n")
    || value.includes("\0")
  ) {
    throw new Error(`official X ${label} is not a safe multipart value`);
  }
  return value;
}

/**
 * Serialize the small, fixed X multipart shape into owned bytes. The pinned
 * transport deliberately rejects opaque FormData streams because it cannot
 * prove their size, ownership, or lifetime before opening the authenticated
 * socket.
 */
function xMultipartPayload(
  fields: readonly MultipartField[],
  file: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly filename: string;
  },
): MultipartPayload {
  const filename = exactMultipartToken(file.filename, "upload filename");
  const mediaType = exactMultipartMediaType(file.mediaType);
  const safeFields = fields.map(({ name, value }) => ({
    name: exactMultipartToken(name, "multipart field name"),
    value: exactMultipartValue(value, `multipart field ${name}`),
  }));
  const fileBytes = Buffer.from(file.bytes);
  const collisionInputs = [
    fileBytes,
    ...safeFields.map((field) => Buffer.from(field.value, "utf8")),
  ];
  let boundary: string | null = null;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    // Do not derive this header-visible value from private media bytes: even a
    // header-only log must not become a stable media fingerprint.
    const candidate = `wrench-${randomBytes(24).toString("hex")}`;
    const candidateBytes = Buffer.from(candidate, "ascii");
    if (!collisionInputs.some((input) => input.includes(candidateBytes))) {
      boundary = candidate;
      break;
    }
  }
  if (boundary === null) {
    throw new Error("official X could not construct an unambiguous multipart boundary");
  }

  const chunks: Uint8Array[] = [];
  for (const field of safeFields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`
      + `${field.value}\r\n`,
      "utf8",
    ));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n`
      + `Content-Type: ${mediaType}\r\n\r\n`,
      "utf8",
    ),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  );
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function multipartBearer(context: ProviderActionContext, contentType: string): Headers {
  const headers = bearer(context);
  headers.set("Content-Type", contentType);
  return headers;
}

function mediaId(response: ProviderResponse, label: string): string {
  return exactXId(requiredString(dataRecord(response, label), "id", label), `official X ${label} id`);
}

async function uploadOneShotImage(
  context: ProviderActionContext,
  prepared: PreparedProviderFile,
  category: string,
): Promise<UploadedMedia> {
  const { file } = prepared;
  const bytes = verifiedProviderRead(file, prepared.preflightIdentity, true).bytes;
  if (bytes === null) throw new Error("official X image could not be materialized safely");
  const multipart = xMultipartPayload([
    { name: "media_category", value: category },
    { name: "media_type", value: file.mediaType },
  ], {
    bytes,
    mediaType: file.mediaType,
    filename: genericUploadName(file.mediaType),
  });
  const response = await request(
    context,
    `${X_API_ORIGIN}/2/media/upload`,
    {
      method: "POST",
      headers: multipartBearer(context, multipart.contentType),
      body: multipart.body,
    },
    [200],
  );
  const id = mediaId(response, "media upload");
  await waitForMedia(context, id, response);
  return { id, category, mediaType: file.mediaType, bytes: file.bytes };
}

type ProcessingState = {
  readonly state: "pending" | "in_progress" | "succeeded" | "failed" | null;
  readonly checkAfterSeconds: number;
};

function processingState(response: ProviderResponse): ProcessingState {
  const data = dataRecord(response, "media processing");
  if (data.processing_info === undefined) return { state: null, checkAfterSeconds: 0 };
  if (!isRecord(data.processing_info)) {
    throw new Error("official X media processing response contained invalid processing_info");
  }
  const processing = data.processing_info;
  const stateValue = processing.state;
  if (stateValue !== "pending" && stateValue !== "in_progress" && stateValue !== "succeeded" && stateValue !== "failed") {
    throw new Error("official X media processing response contained an unsupported state");
  }
  const state = stateValue;
  const check = processing.check_after_secs;
  if (check !== undefined && (typeof check !== "number" || !Number.isFinite(check) || check < 0)) {
    throw new Error("official X media processing response contained an invalid check_after_secs");
  }
  const checkAfterSeconds = check === undefined ? 1 : check;
  return { state, checkAfterSeconds };
}

async function waitForMedia(
  context: ProviderActionContext,
  id: string,
  initial: ProviderResponse,
): Promise<void> {
  let current = processingState(initial);
  if (current.state === null || current.state === "succeeded") return;
  if (current.state === "failed") throw new Error("official X media processing failed");
  const mediaDeadline = Date.now() + MAX_MEDIA_STATUS_WAIT_MS;
  for (let attempt = 0; attempt < MAX_MEDIA_STATUS_POLLS; attempt += 1) {
    const remaining = Math.min(mediaDeadline - Date.now(), context.http.remainingTimeMs());
    if (remaining < 1) break;
    const delay = current.checkAfterSeconds * 1_000;
    if (delay >= remaining) break;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const url = new URL(`${X_API_ORIGIN}/2/media/upload`);
    url.searchParams.set("command", "STATUS");
    url.searchParams.set("media_id", id);
    const response = await request(context, url, { method: "GET", headers: bearer(context) }, [200]);
    current = processingState(response);
    if (current.state === null || current.state === "succeeded") return;
    if (current.state === "failed") throw new Error("official X media processing failed");
  }
  throw new Error("official X media processing did not complete within the bounded polling window");
}

async function uploadChunkedMedia(
  context: ProviderActionContext,
  prepared: PreparedProviderFile,
  category: string,
): Promise<UploadedMedia> {
  const { file } = prepared;
  const opened = openProviderFile(file, prepared.preflightIdentity);
  let id: string;
  try {
    const initialize = await request(
      context,
      `${X_API_ORIGIN}/2/media/upload/initialize`,
      {
        method: "POST",
        headers: bearer(context, true),
        body: JSON.stringify({ media_type: file.mediaType, total_bytes: file.bytes, media_category: category }),
      },
      [200],
    );
    id = mediaId(initialize, "media initialization");
    const hash = createHash("sha256");
    let offset = 0;
    let segmentIndex = 0;
    while (offset < file.bytes) {
      const length = Math.min(MEDIA_CHUNK_BYTES, file.bytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      let readOffset = 0;
      while (readOffset < length) {
        const count = readSync(opened.descriptor, buffer, readOffset, length - readOffset, offset + readOffset);
        if (count < 1) throw new Error("official X attachment ended during chunked upload");
        readOffset += count;
      }
      hash.update(buffer);
      const multipart = xMultipartPayload(
        [{ name: "segment_index", value: String(segmentIndex) }],
        {
          bytes: buffer,
          mediaType: file.mediaType,
          filename: genericUploadName(file.mediaType),
        },
      );
      await request(
        context,
        `${X_API_ORIGIN}/2/media/upload/${encodedSegment(id)}/append`,
        {
          method: "POST",
          headers: multipartBearer(context, multipart.contentType),
          body: multipart.body,
        },
        [200],
      );
      offset += length;
      segmentIndex += 1;
    }
    const after = fstatSync(opened.descriptor, { bigint: true });
    if (!sameProviderFile(opened.stats, after)) {
      throw new Error("official X attachment identity changed during chunked upload");
    }
    if (hash.digest("hex") !== file.sha256) {
      throw new Error("official X attachment no longer matches its confirmed digest during chunked upload");
    }
  } finally {
    closeProviderFile(opened.descriptor);
  }

  // Plan assets are private and mode 0600, and both passes bind identity and
  // digest. A same-UID process that already holds the inode writable can still
  // alter bytes after the preflight; the upload pass detects that before
  // FINALIZE, although unfinalized chunks may already have reached X.
  const finalized = await request(
    context,
    `${X_API_ORIGIN}/2/media/upload/${encodedSegment(id)}/finalize`,
    { method: "POST", headers: bearer(context) },
    [200],
  );
  await waitForMedia(context, id, finalized);
  return { id, category, mediaType: file.mediaType, bytes: file.bytes };
}

async function uploadMedia(
  context: ProviderActionContext,
  prepared: PreparedProviderFile,
  destination: "tweet" | "dm",
): Promise<UploadedMedia> {
  const { file } = prepared;
  validateMediaFile(file);
  const category = mediaCategory(file.mediaType, destination);
  return file.mediaType === "image/jpeg" || file.mediaType === "image/png"
    ? uploadOneShotImage(context, prepared, category)
    : uploadChunkedMedia(context, prepared, category);
}

async function applyMediaAltText(
  context: ProviderActionContext,
  media: UploadedMedia,
  altText: string | undefined,
): Promise<UploadedMedia> {
  if (altText === undefined) return media;
  const response = await request(
    context,
    `${X_API_ORIGIN}/2/media/metadata`,
    {
      method: "POST",
      headers: bearer(context, true),
      body: JSON.stringify({ id: media.id, metadata: { alt_text: { text: altText } } }),
    },
    [200],
  );
  const result = dataRecord(response, "media metadata");
  const returnedId = exactXId(requiredString(result, "id", "media metadata"), "official X media metadata id");
  if (returnedId !== media.id) throw new Error("official X media metadata response returned an unexpected media ID");
  const associatedMetadata = record(result.associated_metadata, "media metadata associated_metadata");
  const returnedAltText = requiredString(
    record(associatedMetadata.alt_text, "media metadata alt_text"),
    "text",
    "media metadata alt_text",
  );
  if (returnedAltText !== altText) {
    throw new Error("official X media metadata response returned unexpected alternative text");
  }
  return { ...media, altText };
}

function alignedAltTexts(
  context: ProviderActionContext,
  inputName: string,
  mediaCount: number,
): readonly (string | undefined)[] {
  const values = optionalInputStrings(context, inputName);
  if (values === undefined) return Array.from({ length: mediaCount }, () => undefined);
  if (values.length !== mediaCount) throw new Error(`input.${inputName} must align one-to-one with the reviewed media`);
  return values;
}

function validateImageAltTexts(
  files: readonly ProviderFile[],
  altTexts: readonly (string | undefined)[],
  inputName: string,
): void {
  for (const [index, altText] of altTexts.entries()) {
    if (altText === undefined) continue;
    const mediaType = files[index]?.mediaType;
    if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
      throw new Error(`input.${inputName}[${index}] can describe only a JPEG or PNG attachment`);
    }
  }
}

function createdPostId(response: ProviderResponse): string {
  return exactXId(requiredString(dataRecord(response, "post creation"), "id", "post creation"), "official X created post id");
}

async function executePostsPublish(context: ProviderActionContext): Promise<void> {
  const body = optionalInputString(context, "body");
  const files = await context.resolveFiles("media");
  validatePostMedia(files);
  const altTexts = alignedAltTexts(context, "media_alt_texts", files.length);
  validateImageAltTexts(files, altTexts, "media_alt_texts");
  const pollOptions = context.input.poll_options;
  const pollDuration = optionalInputNumber(context, "poll_duration_minutes");
  if ((Array.isArray(pollOptions)) !== (pollDuration !== undefined)) {
    throw new Error("input.poll_options and input.poll_duration_minutes must be supplied together");
  }
  if (Array.isArray(pollOptions) && files.length > 0) throw new Error("input.media and poll inputs are mutually exclusive");
  if (body === undefined && files.length === 0 && !Array.isArray(pollOptions)) {
    throw new Error("official X posts require text, reviewed media, or a poll");
  }
  const replySettings = optionalInputString(context, "reply_settings");
  if (replySettings !== undefined && !["everyone", "mentionedUsers", "following", "subscribers", "verified"].includes(replySettings)) {
    throw new Error("input.reply_settings is not supported by the bundled X contract");
  }
  const communityIdValue = optionalInputString(context, "community_id");
  const communityId = communityIdValue === undefined ? undefined : exactXId(communityIdValue, "input.community_id");
  const madeWithAi = optionalInputBoolean(context, "made_with_ai");
  if (madeWithAi === true && files.length === 0) {
    throw new Error("input.made_with_ai is true but the post has no reviewed media");
  }
  const preparedFiles = preflightProviderFiles(files);
  if (files.length > 0) context.addRequiredScopes(["media.write"]);
  await authenticatedWriteUserId(context);
  await context.dispatch(async () => {
    const uploaded: UploadedMedia[] = [];
    for (const [index, prepared] of preparedFiles.entries()) {
      const media = await uploadMedia(context, prepared, "tweet");
      uploaded.push(await applyMediaAltText(context, media, altTexts[index]));
      context.setOutput({ provider: "x", operation: "posts.publish", published: false, uploadedMedia: uploaded });
    }
    const payload: JsonRecord = {};
    if (body !== undefined) payload.text = body;
    if (uploaded.length > 0) payload.media = { media_ids: uploaded.map((media) => media.id) };
    if (Array.isArray(pollOptions) && pollDuration !== undefined) {
      payload.poll = { options: pollOptions, duration_minutes: pollDuration };
    }
    if (replySettings !== undefined && replySettings !== "everyone") payload.reply_settings = replySettings;
    if (communityId !== undefined) payload.community_id = communityId;
    if (madeWithAi === true) {
      payload.made_with_ai = true;
    }
    const response = await request(
      context,
      `${X_API_ORIGIN}/2/tweets`,
      { method: "POST", headers: bearer(context, true), body: JSON.stringify(payload) },
      [201],
    );
    const id = createdPostId(response);
    const url = postUrl(id);
    context.setOutput({
      provider: "x",
      operation: "posts.publish",
      published: true,
      post: dataRecord(response, "post creation"),
      uploadedMedia: uploaded,
      url,
    });
    context.setFinalUrl(url);
  });
}

async function executeReplyCreate(context: ProviderActionContext): Promise<void> {
  if (context.input.recipient_opted_in !== true || context.input.author_invited_reply !== true) {
    throw new Error("official X automated replies require recipient opt-in and an author-invitation acknowledgement");
  }
  const body = optionalInputString(context, "body");
  const targetPostId = inputXId(context, "target_post_id");
  const files = await context.resolveFiles("media");
  validatePostMedia(files);
  const altTexts = alignedAltTexts(context, "media_alt_texts", files.length);
  validateImageAltTexts(files, altTexts, "media_alt_texts");
  if (body === undefined && files.length === 0) {
    throw new Error("official X replies require text or reviewed media");
  }
  const preparedFiles = preflightProviderFiles(files);
  if (files.length > 0) context.addRequiredScopes(["media.write"]);
  await authenticatedWriteUserId(context);
  await context.dispatch(async () => {
    const uploaded: UploadedMedia[] = [];
    for (const [index, prepared] of preparedFiles.entries()) {
      const media = await uploadMedia(context, prepared, "tweet");
      uploaded.push(await applyMediaAltText(context, media, altTexts[index]));
      context.setOutput({ provider: "x", operation: "replies.create", published: false, uploadedMedia: uploaded });
    }
    const payload: JsonRecord = { reply: { in_reply_to_tweet_id: targetPostId } };
    if (body !== undefined) payload.text = body;
    if (uploaded.length > 0) payload.media = { media_ids: uploaded.map((media) => media.id) };
    const response = await request(
      context,
      `${X_API_ORIGIN}/2/tweets`,
      { method: "POST", headers: bearer(context, true), body: JSON.stringify(payload) },
      [201],
    );
    const id = createdPostId(response);
    const url = postUrl(id);
    context.setOutput({
      provider: "x",
      operation: "replies.create",
      published: true,
      post: dataRecord(response, "post creation"),
      uploadedMedia: uploaded,
      url,
    });
    context.setFinalUrl(url);
  });
}

async function executeThreadPublish(context: ProviderActionContext): Promise<void> {
  const items = inputStrings(context, "items");
  const files = await context.resolveFiles("media");
  const mediaIndices = files.length === 0 && context.input.media_item_indices === undefined
    ? []
    : inputNumbers(context, "media_item_indices");
  if (files.length !== mediaIndices.length) {
    throw new Error("input.media_item_indices must align one-to-one with the reviewed thread media");
  }
  const altTexts = alignedAltTexts(context, "media_alt_texts", files.length);
  validateImageAltTexts(files, altTexts, "media_alt_texts");
  const groupedFiles = new Map<number, ProviderFile[]>();
  for (const [index, file] of files.entries()) {
    const itemIndex = mediaIndices[index];
    if (itemIndex === undefined || itemIndex < 1 || itemIndex > items.length) {
      throw new Error(`input.media_item_indices[${index}] must name an existing one-based thread item`);
    }
    const group = groupedFiles.get(itemIndex) ?? [];
    group.push(file);
    groupedFiles.set(itemIndex, group);
  }
  for (const group of groupedFiles.values()) validatePostMedia(group);
  const grouped = new Map<number, Array<{ readonly prepared: PreparedProviderFile; readonly altText: string | undefined }>>();
  const preparedFiles = preflightProviderFiles(files);
  for (const [index, prepared] of preparedFiles.entries()) {
    const itemIndex = mediaIndices[index];
    if (itemIndex === undefined) throw new Error("reviewed thread media lost its validated item binding");
    const group = grouped.get(itemIndex) ?? [];
    group.push({ prepared, altText: altTexts[index] });
    grouped.set(itemIndex, group);
  }
  if (files.length > 0) context.addRequiredScopes(["media.write"]);
  await authenticatedWriteUserId(context);
  const committed: Array<{
    readonly index: number;
    readonly id: string;
    readonly url: string;
    readonly media?: readonly UploadedMedia[];
  }> = [];
  context.setOutput({ provider: "x", operation: "threads.publish", complete: false, committed });
  let previousId: string | null = null;
  for (const [index, text] of items.entries()) {
    await context.dispatch(async () => {
      const payload: JsonRecord = { text };
      if (previousId !== null) payload.reply = { in_reply_to_tweet_id: previousId };
      const uploaded: UploadedMedia[] = [];
      for (const value of grouped.get(index + 1) ?? []) {
        const media = await uploadMedia(context, value.prepared, "tweet");
        uploaded.push(await applyMediaAltText(context, media, value.altText));
        context.setOutput({
          provider: "x",
          operation: "threads.publish",
          complete: false,
          committed: [...committed],
          pending: { index: index + 1, uploadedMedia: [...uploaded] },
        });
      }
      if (uploaded.length > 0) payload.media = { media_ids: uploaded.map((media) => media.id) };
      const response = await request(
        context,
        `${X_API_ORIGIN}/2/tweets`,
        { method: "POST", headers: bearer(context, true), body: JSON.stringify(payload) },
        [201],
      );
      const id = createdPostId(response);
      previousId = id;
      committed.push({
        index: index + 1,
        id,
        url: postUrl(id),
        ...(uploaded.length === 0 ? {} : { media: [...uploaded] }),
      });
      context.setOutput({
        provider: "x",
        operation: "threads.publish",
        complete: committed.length === items.length,
        committed: [...committed],
      });
    });
  }
  const first = committed[0];
  if (first !== undefined) context.setFinalUrl(first.url);
}

async function executeMessagingSend(context: ProviderActionContext): Promise<void> {
  if (context.input.recipient_opted_in !== true) {
    throw new Error("official X automated Direct Messages require explicit recipient opt-in acknowledgement");
  }
  const body = optionalInputString(context, "body");
  const targetKind = inputString(context, "target_kind");
  const targetId = targetKind === "participant"
    ? inputXId(context, "target_id")
    : targetKind === "conversation"
      ? exactDmConversationId(inputString(context, "target_id"), "input.target_id")
      : null;
  if (targetId === null) throw new Error("input.target_kind names an unsupported official X DM target");
  if (targetKind === "participant" && targetId === context.auth.subject) {
    throw new Error("input.target_id must identify another X DM participant");
  }
  const path = targetKind === "participant"
    ? `/2/dm_conversations/with/${encodedSegment(targetId)}/messages`
    : `/2/dm_conversations/${encodedSegment(targetId)}/messages`;
  const files = await context.resolveFiles("media");
  if (files.length > 1) throw new Error("official X Direct Messages support at most one attachment");
  const file = files[0];
  const mediaAltText = optionalInputString(context, "media_alt_text");
  if (mediaAltText !== undefined && file === undefined) throw new Error("input.media_alt_text requires input.media");
  if (mediaAltText !== undefined && file !== undefined
    && file.mediaType !== "image/jpeg" && file.mediaType !== "image/png") {
    throw new Error("input.media_alt_text can describe only a JPEG or PNG attachment");
  }
  if (body === undefined && file === undefined) {
    throw new Error("official X Direct Messages require text or one reviewed attachment");
  }
  let preparedFile: PreparedProviderFile | undefined;
  if (file !== undefined) {
    validateMediaFile(file);
    preparedFile = preflightProviderFile(file);
    context.addRequiredScopes(["media.write"]);
  }
  await authenticatedWriteUserId(context);
  await context.dispatch(async () => {
    const uploadedRaw = preparedFile === undefined ? null : await uploadMedia(context, preparedFile, "dm");
    const uploaded = uploadedRaw === null ? null : await applyMediaAltText(context, uploadedRaw, mediaAltText);
    if (uploaded !== null) {
      context.setOutput({ provider: "x", operation: "messaging.send", sent: false, uploadedMedia: [uploaded] });
    }
    const payload: JsonRecord = {};
    if (body !== undefined) payload.text = body;
    if (uploaded !== null) payload.attachments = [{ media_id: uploaded.id }];
    const response = await request(
      context,
      `${X_API_ORIGIN}${path}`,
      { method: "POST", headers: bearer(context, true), body: JSON.stringify(payload) },
      [201],
    );
    const result = dataRecord(response, "DM send");
    const conversationId = exactDmConversationId(
      requiredString(result, "dm_conversation_id", "DM send"),
      "official X sent DM conversation id",
    );
    if (targetKind === "conversation" && conversationId !== targetId) {
      throw new Error("official X DM send response returned an unexpected conversation ID");
    }
    if (targetKind === "participant") {
      const expected = new Set([exactXId(context.auth.subject ?? "", "OAuth locator subject"), targetId]);
      const returned = exactDirectDmConversationSet(conversationId, "official X sent DM conversation id");
      if (!sameIdSet(expected, returned)) {
        throw new Error("official X DM send response returned an unexpected participant conversation");
      }
    }
    context.setOutput({
      provider: "x",
      operation: "messaging.send",
      sent: true,
      eventId: exactXId(requiredString(result, "dm_event_id", "DM send"), "official X sent DM event id"),
      conversationId,
      uploadedMedia: uploaded === null ? [] : [uploaded],
      coverage: {
        encryptedChat: false,
        limitation: "This sends through the official DM-event API, not encrypted Chat.",
      },
    });
  });
}

async function executeRepost(context: ProviderActionContext): Promise<void> {
  const postId = inputXId(context, "post_id");
  const me = await authenticatedWriteUserId(context);
  const enabled = context.input.enabled === true;
  await context.dispatch(async () => {
    const response = enabled
      ? await request(
          context,
          `${X_API_ORIGIN}/2/users/${encodedSegment(me)}/retweets`,
          { method: "POST", headers: bearer(context, true), body: JSON.stringify({ tweet_id: postId }) },
          [200],
        )
      : await request(
          context,
          `${X_API_ORIGIN}/2/users/${encodedSegment(me)}/retweets/${encodedSegment(postId)}`,
          { method: "DELETE", headers: bearer(context) },
          [200],
        );
    const result = dataRecord(response, "repost desired state");
    if (result.retweeted !== enabled) {
      throw new Error("official X repost response did not confirm the requested desired state");
    }
    context.setOutput({
      provider: "x",
      operation: "posts.repost",
      postId,
      enabled,
      result,
    });
    context.setFinalUrl(postUrl(postId));
  });
}

async function executeBookmark(context: ProviderActionContext): Promise<void> {
  const postId = inputXId(context, "post_id");
  const me = await authenticatedWriteUserId(context);
  const enabled = context.input.enabled === true;
  await context.dispatch(async () => {
    const response = enabled
      ? await request(
          context,
          `${X_API_ORIGIN}/2/users/${encodedSegment(me)}/bookmarks`,
          { method: "POST", headers: bearer(context, true), body: JSON.stringify({ tweet_id: postId }) },
          [200],
        )
      : await request(
          context,
          `${X_API_ORIGIN}/2/users/${encodedSegment(me)}/bookmarks/${encodedSegment(postId)}`,
          { method: "DELETE", headers: bearer(context) },
          [200],
        );
    const result = dataRecord(response, "bookmark desired state");
    if (result.bookmarked !== enabled) {
      throw new Error("official X bookmark response did not confirm the requested desired state");
    }
    context.setOutput({
      provider: "x",
      operation: "content.save",
      postId,
      enabled,
      result,
    });
    context.setFinalUrl(postUrl(postId));
  });
}

function draftBlocks(body: string): readonly JsonRecord[] {
  return body.split("\n").map((text) => ({
    type: "unstyled",
    text,
    data: {},
    entity_ranges: [],
    inline_style_ranges: [],
  }));
}

async function executeArticlePublish(context: ProviderActionContext): Promise<void> {
  const title = inputString(context, "title");
  const body = inputString(context, "body");
  const covers = await context.resolveFiles("cover");
  if (covers.length > 1) throw new Error("official X Articles support one cover image");
  const cover = covers[0];
  const coverAltText = optionalInputString(context, "cover_alt_text");
  if (coverAltText !== undefined && cover === undefined) throw new Error("input.cover_alt_text requires input.cover");
  let preparedCover: PreparedProviderFile | undefined;
  if (cover !== undefined) {
    validateMediaFile(cover);
    if (cover.mediaType !== "image/jpeg" && cover.mediaType !== "image/png") {
      throw new Error("official X Article covers must be JPEG or PNG images");
    }
    preparedCover = preflightProviderFile(cover);
    context.addRequiredScopes(["media.write"]);
  }
  await authenticatedWriteUserId(context);
  await context.dispatch(async () => {
    const uploadedRaw = preparedCover === undefined ? null : await uploadMedia(context, preparedCover, "tweet");
    const uploaded = uploadedRaw === null ? null : await applyMediaAltText(context, uploadedRaw, coverAltText);
    if (uploaded !== null) {
      context.setOutput({ provider: "x", operation: "articles.publish", published: false, uploadedCover: uploaded });
    }
    const draftPayload: JsonRecord = {
      title,
      content_state: {
        blocks: draftBlocks(body),
        entities: [],
      },
    };
    if (uploaded !== null) {
      draftPayload.cover_media = { media_category: uploaded.category, media_id: uploaded.id };
    }
    const draftResponse = await request(
      context,
      `${X_API_ORIGIN}/2/articles/draft`,
      { method: "POST", headers: bearer(context, true), body: JSON.stringify(draftPayload) },
      [201],
    );
    const draft = dataRecord(draftResponse, "Article draft creation");
    const articleId = exactXId(requiredString(draft, "id", "Article draft creation"), "official X Article id");
    const returnedTitle = requiredString(draft, "title", "Article draft creation");
    if (returnedTitle !== title) {
      throw new Error("official X Article draft response returned an unexpected title");
    }
    context.setOutput({
      provider: "x",
      operation: "articles.publish",
      published: false,
      draftId: articleId,
      draft,
      uploadedCover: uploaded,
    });
    const publishResponse = await request(
      context,
      `${X_API_ORIGIN}/2/articles/${encodedSegment(articleId)}/publish`,
      { method: "POST", headers: bearer(context) },
      [200],
    );
    const published = dataRecord(publishResponse, "Article publish");
    const postId = exactXId(requiredString(published, "post_id", "Article publish"), "official X Article post id");
    const url = postUrl(postId);
    context.setOutput({
      provider: "x",
      operation: "articles.publish",
      published: true,
      draftId: articleId,
      postId,
      draft,
      result: published,
      uploadedCover: uploaded,
      url,
    });
    context.setFinalUrl(url);
  });
}

/** Execute one reviewed, code-owned official X API action. */
export async function executeXProvider(context: ProviderActionContext): Promise<void> {
  // All numeric fields in the bundled X contracts are API integers. Validate
  // them before any action-specific identity lookup or remote request.
  optionalInputNumber(context, "limit");
  optionalInputNumber(context, "poll_duration_minutes");
  const action = context.recipe.action;
  if (action === "feeds.read") await executeFeedsRead(context);
  else if (action === "posts.read") await executePostsRead(context);
  else if (action === "comments.read") await executeCommentsRead(context);
  else if (action === "messaging.list") await executeMessagingList(context);
  else if (action === "messaging.read") await executeMessagingRead(context);
  else if (action === "messaging.send") await executeMessagingSend(context);
  else if (action === "posts.publish") await executePostsPublish(context);
  else if (action === "replies.create") await executeReplyCreate(context);
  else if (action === "threads.publish") await executeThreadPublish(context);
  else if (action === "posts.repost") await executeRepost(context);
  else if (action === "content.save") await executeBookmark(context);
  else if (action === "articles.publish") await executeArticlePublish(context);
  else throw new Error(`official X provider action ${action} is not implemented`);
}
