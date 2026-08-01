import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute } from "node:path";

import { isLinkedInProviderActorSubject } from "../provider-subject";
import { bearerHeaders } from "../provider-http";
import type { ProviderActionContext, ProviderFile } from "../provider-context";

const LINKEDIN_API_ORIGIN = "https://api.linkedin.com";
const LINKEDIN_API_HOSTS = ["api.linkedin.com"] as const;
const LINKEDIN_VERSION = "202606";
const LINKEDIN_PROTOCOL_VERSION = "2.0.0";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
// LinkedIn documents its feed-video floor as 75 KB. Treat KB as the decimal
// unit used by the API specification instead of silently raising it to 75 KiB.
const MIN_VIDEO_BYTES = 75_000;
const FILE_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_MEDIA_STATUS_POLLS = 100;
const MAX_MEDIA_STATUS_WAIT_MS = 8 * 60_000;
const DEFAULT_MEDIA_STATUS_DELAY_MS = 1_000;

const imageMediaTypes = new Set(["image/jpeg", "image/png", "image/gif"]);
const videoMediaTypes = new Set(["video/mp4"]);
const documentMediaTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const reactionTypes = new Set([
  "LIKE",
  "PRAISE",
  "EMPATHY",
  "INTEREST",
  "APPRECIATION",
  "ENTERTAINMENT",
]);

type PreparedMedia =
  | { readonly kind: "none" }
  | {
      readonly kind: "images";
      readonly items: readonly {
        readonly file: ProviderFile;
        readonly bytes: Uint8Array;
      }[];
    }
  | {
      readonly kind: "document";
      readonly file: ProviderFile;
      readonly bytes: Uint8Array;
      readonly title: string;
    }
  | {
      readonly kind: "video";
      readonly prepared: PreparedProviderFile;
      readonly title: string | null;
    };

type PreparedProviderFile = {
  readonly file: ProviderFile;
  /** The exact file identity observed by the complete pre-dispatch digest pass. */
  readonly preflightIdentity: BigIntStats;
};

type VerifiedProviderRead = {
  readonly identity: BigIntStats;
  readonly bytes: Uint8Array | null;
};

type UploadInstruction = {
  readonly firstByte: number;
  readonly lastByte: number;
  readonly uploadUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`LinkedIn returned an invalid ${label}`);
  return value;
}

function hasUnsafeTextControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasAnyAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requiredString(
  value: unknown,
  label: string,
  maximum = 8_192,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
    || hasUnsafeTextControl(value)
  ) throw new Error(`${label} must be a bounded string without control characters`);
  return value;
}

function optionalString(value: unknown, label: string, maximum = 8_192): string | null {
  return value === undefined ? null : requiredString(value, label, maximum);
}

function inputInteger(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate as number;
}

function responseString(value: unknown, label: string, maximum = 8_192, allowEmpty = false): string {
  return requiredString(value, `LinkedIn ${label}`, maximum, allowEmpty);
}

function responseInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`LinkedIn returned an invalid ${label}`);
  }
  return value as number;
}

function apiHeaders(context: ProviderActionContext, json = false): Headers {
  return bearerHeaders(context.token.accessToken, {
    Accept: "application/json",
    "Linkedin-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": LINKEDIN_PROTOCOL_VERSION,
    ...(json ? { "Content-Type": "application/json" } : {}),
  });
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function apiUrl(path: string): URL {
  return new URL(path, LINKEDIN_API_ORIGIN);
}

function encodedUrn(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("!", "%21")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
}

function actorKind(value: string): "member" | "organization" {
  if (!isLinkedInProviderActorSubject(value)) {
    throw new Error("LinkedIn actor must be an exact person or organization URN");
  }
  return value.startsWith("urn:li:person:") ? "member" : "organization";
}

function postUrn(value: string): string {
  if (!/^urn:li:(?:share|ugcPost):[0-9]{1,32}$/u.test(value)) {
    throw new Error("LinkedIn post must be an exact share or UGC Post URN");
  }
  return value;
}

function rootObjectUrn(value: string): string {
  if (!/^urn:li:(?:activity|share|ugcPost):[0-9]{1,32}$/u.test(value)) {
    throw new Error("LinkedIn object must be an exact activity, share, or UGC Post URN");
  }
  return value;
}

function commentUrn(value: string): string {
  if (!/^urn:li:comment:\(urn:li:activity:[0-9]{1,32},[0-9]{1,32}\)$/u.test(value)) {
    throw new Error("LinkedIn comment must be an exact composite comment URN");
  }
  return value;
}

function socialTargetUrn(value: string): string {
  if (
    /^urn:li:(?:activity|share|ugcPost):[0-9]{1,32}$/u.test(value)
    || /^urn:li:comment:\(urn:li:activity:[0-9]{1,32},[0-9]{1,32}\)$/u.test(value)
  ) return value;
  throw new Error("LinkedIn social target must be an exact post, activity, or composite comment URN");
}

function commentReadTargetUrn(value: string): string {
  if (
    /^urn:li:(?:share|ugcPost):[0-9]{1,32}$/u.test(value)
    || /^urn:li:comment:\(urn:li:activity:[0-9]{1,32},[0-9]{1,32}\)$/u.test(value)
  ) return value;
  throw new Error("LinkedIn comment target must be an exact share, UGC Post, or composite comment URN");
}

function requireWriteActor(
  context: ProviderActionContext,
  actor: string,
  scopes: { readonly member: string; readonly organization: string },
): "member" | "organization" {
  const kind = actorKind(actor);
  if (context.auth.subject === undefined) {
    throw new Error("LinkedIn write capabilities require an OAuth locator with an exact subject URN");
  }
  if (context.auth.subject !== actor) {
    throw new Error("LinkedIn write actor does not match the OAuth locator subject");
  }
  context.addRequiredScopes([kind === "member" ? scopes.member : scopes.organization]);
  return kind;
}

function linkedInPostUrl(id: string): string {
  return `https://www.linkedin.com/feed/update/${postUrn(id)}/`;
}

function linkedInCommentUrl(target: string, createdCommentUrn: string | null): string {
  const url = new URL(linkedInPostUrl(target));
  if (createdCommentUrn !== null) url.searchParams.set("commentUrn", createdCommentUrn);
  return url.toString();
}

function scalarResponseString(record_: Record<string, unknown>, key: string): string | null {
  const value = record_[key];
  return typeof value === "string" && value.length <= 8_192 ? value : null;
}

function scalarResponseNumber(record_: Record<string, unknown>, key: string): number | null {
  const value = record_[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalResponseString(
  record_: Record<string, unknown>,
  key: string,
  label: string,
  maximum = 8_192,
): string | null {
  return record_[key] === undefined ? null : responseString(record_[key], label, maximum);
}

function exactResponsePost(value: unknown, expectedId: string): Record<string, unknown> {
  const post = record(value, "post resource");
  const id = postUrn(responseString(post.id, "post ID", 500));
  if (id !== expectedId) throw new Error("LinkedIn returned a post other than the requested post URN");
  return normalizePost(post);
}

function exactAuthorPost(value: unknown, expectedAuthor: string): Record<string, unknown> {
  const post = record(value, "author post resource");
  postUrn(responseString(post.id, "author post ID", 500));
  const author = responseString(post.author, "author post author", 500);
  actorKind(author);
  if (author !== expectedAuthor) {
    throw new Error("LinkedIn author finder returned a post for a different author");
  }
  return normalizePost(post);
}

function normalizePost(value: unknown): Record<string, unknown> {
  const post = record(value, "post resource");
  return {
    id: scalarResponseString(post, "id"),
    author: scalarResponseString(post, "author"),
    commentary: scalarResponseString(post, "commentary"),
    visibility: scalarResponseString(post, "visibility"),
    lifecycleState: scalarResponseString(post, "lifecycleState"),
    createdAt: scalarResponseNumber(post, "createdAt"),
    publishedAt: scalarResponseNumber(post, "publishedAt"),
    lastModifiedAt: scalarResponseNumber(post, "lastModifiedAt"),
    distribution: post.distribution ?? null,
    content: post.content ?? null,
  };
}

function normalizeComment(value: unknown): Record<string, unknown> {
  const comment = record(value, "comment resource");
  const message = comment.message === undefined ? null : record(comment.message, "comment message");
  const created = comment.created === undefined ? null : record(comment.created, "comment creation stamp");
  const lastModified = comment.lastModified === undefined
    ? null
    : record(comment.lastModified, "comment modification stamp");
  return {
    id: scalarResponseString(comment, "id"),
    commentUrn: scalarResponseString(comment, "commentUrn"),
    actor: scalarResponseString(comment, "actor"),
    object: scalarResponseString(comment, "object"),
    parentComment: scalarResponseString(comment, "parentComment"),
    text: message === null ? null : scalarResponseString(message, "text"),
    createdAt: created === null ? null : scalarResponseNumber(created, "time"),
    lastModifiedAt: lastModified === null ? null : scalarResponseNumber(lastModified, "time"),
    content: comment.content ?? null,
  };
}

function exactCommentIdentity(comment: Record<string, unknown>, label: string): {
  readonly id: string;
  readonly urn: string;
} {
  const id = responseString(comment.id, `${label} ID`, 32);
  if (!/^[0-9]{1,32}$/u.test(id)) throw new Error(`LinkedIn returned an invalid ${label} ID`);
  const urn = commentUrn(responseString(comment.commentUrn, `${label} URN`, 1_000));
  if (!urn.endsWith(`,${id})`)) {
    throw new Error(`LinkedIn returned inconsistent ${label} ID and URN fields`);
  }
  return { id, urn };
}

function exactListedComment(
  value: unknown,
  target: string,
  nested: boolean,
): Record<string, unknown> {
  const comment = record(value, nested ? "reply resource" : "comment resource");
  exactCommentIdentity(comment, nested ? "reply" : "comment");
  actorKind(responseString(comment.actor, `${nested ? "reply" : "comment"} actor`, 500));
  rootObjectUrn(responseString(comment.object, `${nested ? "reply" : "comment"} object`, 1_000));
  const parent = optionalResponseString(comment, "parentComment", "parent comment URN", 1_000);
  if (nested) {
    if (parent === null || commentUrn(parent) !== target) {
      throw new Error("LinkedIn reply listing returned a row for a different parent comment");
    }
  } else if (parent !== null) {
    commentUrn(parent);
    throw new Error("LinkedIn top-level comment listing returned a nested reply");
  }
  return {
    ...normalizeComment(comment),
    // LinkedIn documents that a comment's object/activity can differ from the
    // share or UGC Post used in the collection URL. Preserve that provider
    // field and separately retain the exact request-bound collection target.
    requestedTarget: target,
  };
}

function exactQueryEntries(url: URL): readonly string[] {
  return [...url.searchParams.entries()]
    .filter(([key]) => key !== "start" && key !== "count")
    .map(([key, value]) => `${key}\u0000${value}`)
    .sort();
}

function exactPagingParameter(url: URL, key: "start" | "count"): number {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !/^[0-9]{1,6}$/u.test(values[0] ?? "")) {
    throw new Error(`LinkedIn returned an invalid next-page ${key}`);
  }
  return responseInteger(Number(values[0]), `next-page ${key}`);
}

function validatedNextLink(linkValue: unknown, requestUrl: URL): URL {
  const link = record(linkValue, "next paging link");
  const href = responseString(link.href, "next paging link href", 8_192);
  const next = new URL(href, LINKEDIN_API_ORIGIN);
  if (
    next.protocol !== "https:"
    || next.hostname !== "api.linkedin.com"
    || next.port !== ""
    || next.username !== ""
    || next.password !== ""
    || next.pathname !== requestUrl.pathname
    || JSON.stringify(exactQueryEntries(next)) !== JSON.stringify(exactQueryEntries(requestUrl))
  ) throw new Error("LinkedIn returned a next paging link for a different collection");
  return next;
}

function nextOffset(
  pagingValue: unknown,
  requestedStart: number,
  requestedCount: number,
  returnedCount: number,
  requestUrl: URL,
): { readonly known: boolean; readonly value: number | null } {
  if (pagingValue === undefined) return { known: false, value: null };
  const paging = record(pagingValue, "paging object");
  const start = responseInteger(paging.start, "paging start");
  const count = responseInteger(paging.count, "paging count");
  if (start !== requestedStart) throw new Error("LinkedIn paging start did not match the requested page");
  if (count !== requestedCount || returnedCount > count) {
    throw new Error("LinkedIn paging count did not match the requested page");
  }
  const linksValue = paging.links;
  if (linksValue !== undefined && !Array.isArray(linksValue)) {
    throw new Error("LinkedIn returned invalid paging links");
  }
  let nextLink: URL | null = null;
  for (const linkValue of linksValue ?? []) {
    const link = record(linkValue, "paging link");
    const rel = responseString(link.rel, "paging link relation", 100);
    if (rel !== "next") continue;
    if (nextLink !== null) throw new Error("LinkedIn returned multiple next paging links");
    nextLink = validatedNextLink(link, requestUrl);
  }

  // Never manufacture a continuation from a full page. Some official Rest.li
  // shapes omit links altogether; without an authenticated next link the
  // safest truthful state is unknown rather than a guessed offset.
  if (linksValue === undefined) return { known: false, value: null };
  if (nextLink === null) return { known: true, value: null };

  // LinkedIn's documented offset contract defines a short page as the end of
  // the collection. A contradictory next link is not safe to follow.
  if (returnedCount < count) {
    throw new Error("LinkedIn returned a next paging link after a terminal short page");
  }

  const offset = start + count;
  if (!Number.isSafeInteger(offset) || offset <= requestedStart || offset > 100_000) {
    throw new Error("LinkedIn returned a paging cursor outside wrench's bounds");
  }
  const linkedStart = exactPagingParameter(nextLink, "start");
  const linkedCount = exactPagingParameter(nextLink, "count");
  if (linkedStart !== offset || linkedCount !== count) {
    throw new Error("LinkedIn next paging link would skip or repeat collection rows");
  }
  return { known: true, value: offset };
}

function pageOutput(
  operation: "posts.read" | "comments.read",
  coverage: "author-posts" | "comments",
  responseBody: unknown,
  start: number,
  count: number,
  requestUrl: URL,
  normalize: (value: unknown) => Record<string, unknown>,
  limitations: readonly string[],
): Record<string, unknown> {
  const body = record(responseBody, "collection response");
  if (!Array.isArray(body.elements) || body.elements.length > count) {
    throw new Error("LinkedIn returned an invalid or over-broad result page");
  }
  const cursor = nextOffset(body.paging, start, count, body.elements.length, requestUrl);
  const items = body.elements.map(normalize);
  const identities = items.map((item) => item.id).filter((id): id is string => typeof id === "string");
  if (new Set(identities).size !== identities.length) {
    throw new Error("LinkedIn returned duplicate resource IDs within one page");
  }
  return {
    schemaVersion: 1,
    provider: "linkedin",
    operation,
    coverage,
    completeness: !cursor.known ? "unknown" : cursor.value === null ? "complete" : "page",
    cursor: cursor.value === null ? null : { kind: "offset", start: cursor.value },
    limitations: [
      ...limitations,
      ...(!cursor.known ? ["LinkedIn omitted verifiable paging-link metadata, so page completeness is unknown."] : []),
    ],
    items,
  };
}

function singleOutput(
  operation: "posts.read",
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "linkedin",
    operation,
    coverage: "post",
    completeness: "complete",
    cursor: null,
    limitations: ["This exact Posts API resource is not the algorithmic LinkedIn Home feed."],
    item,
  };
}

function writeOutput(
  operation: "posts.publish" | "posts.repost" | "comments.create" | "replies.create" | "reactions.set",
  result: Record<string, unknown>,
  limitations: readonly string[] = [],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: "linkedin",
    operation,
    coverage: "write-result",
    completeness: "confirmed",
    cursor: null,
    limitations,
    result,
  };
}

async function resharePost(context: ProviderActionContext): Promise<void> {
  const author = requiredString(context.input.author, "input.author", 500);
  const kind = requireWriteActor(context, author, {
    member: "w_member_social",
    organization: "w_organization_social",
  });
  const target = postUrn(requiredString(context.input.target_urn, "input.target_urn", 500));
  const commentary = requiredString(context.input.body, "input.body", 3_000);
  const visibility = context.input.visibility === undefined
    ? "PUBLIC"
    : requiredString(context.input.visibility, "input.visibility", 20);
  if (visibility !== "PUBLIC" && visibility !== "CONNECTIONS") {
    throw new Error("input.visibility must be PUBLIC or CONNECTIONS");
  }
  if (kind === "organization" && visibility === "CONNECTIONS") {
    throw new Error("LinkedIn organization reshares cannot use CONNECTIONS visibility");
  }

  const id = await context.dispatch(async () => {
    const response = await context.http.request(apiUrl("/rest/posts"), {
      method: "POST",
      headers: apiHeaders(context, true),
      body: jsonBody({
        author,
        commentary,
        visibility,
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        reshareContext: { parent: target },
      }),
    }, [201], LINKEDIN_API_HOSTS);
    return postUrn(responseString(response.headers.get("x-restli-id"), "created reshare ID", 500));
  });

  const url = linkedInPostUrl(id);
  context.setOutput(writeOutput("posts.repost", { id, url, author, target, visibility }));
  context.setFinalUrl(url);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode;
}

function openProviderFile(
  file: ProviderFile,
  maximumBytes: number,
  expectedIdentity?: BigIntStats,
  minimumBytes = 1,
): { readonly descriptor: number; readonly stats: BigIntStats } {
  if (!isAbsolute(file.path)) throw new Error("LinkedIn media resolver returned a non-absolute path");
  if (!Number.isSafeInteger(file.bytes) || file.bytes < minimumBytes || file.bytes > maximumBytes) {
    throw new Error(`LinkedIn media must contain between ${minimumBytes} and ${maximumBytes} bytes`);
  }
  const descriptor = openSync(
    file.path,
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
  );
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !stats.isFile()
      || stats.size !== BigInt(file.bytes)
      || (uid !== undefined && stats.uid !== BigInt(uid))
      || (process.platform !== "win32" && (stats.mode & 0o777n) !== 0o600n)
    ) throw new Error("LinkedIn media must resolve to the reviewed, current-user-owned mode-0600 regular file");
    if (expectedIdentity !== undefined && !sameFile(expectedIdentity, stats)) {
      throw new Error("LinkedIn media identity changed after its confirmed preflight");
    }
    return { descriptor, stats };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readVerifiedFile(
  file: ProviderFile,
  maximumBytes: number,
  materialize: boolean,
  minimumBytes = 1,
): VerifiedProviderRead {
  const opened = openProviderFile(file, maximumBytes, undefined, minimumBytes);
  const output = materialize ? Buffer.alloc(file.bytes) : null;
  const scratch = materialize ? null : Buffer.alloc(Math.min(FILE_READ_CHUNK_BYTES, file.bytes));
  const hash = createHash("sha256");
  let offset = 0;
  try {
    while (offset < file.bytes) {
      const destination = output ?? scratch;
      if (destination === null) throw new Error("LinkedIn media read buffer is unavailable");
      const destinationOffset = output === null ? 0 : offset;
      const length = Math.min(
        output === null ? destination.byteLength : FILE_READ_CHUNK_BYTES,
        file.bytes - offset,
      );
      const count = readSync(opened.descriptor, destination, destinationOffset, length, offset);
      if (count < 1) throw new Error("LinkedIn media ended before its reviewed byte length");
      hash.update(destination.subarray(destinationOffset, destinationOffset + count));
      offset += count;
    }
    const after = fstatSync(opened.descriptor, { bigint: true });
    if (!sameFile(opened.stats, after)) throw new Error("LinkedIn media changed while it was validated");
    if (hash.digest("hex") !== file.sha256) throw new Error("LinkedIn media no longer matches the confirmed attachment digest");
    return { identity: opened.stats, bytes: output };
  } finally {
    closeSync(opened.descriptor);
  }
}

async function prepareMedia(context: ProviderActionContext): Promise<PreparedMedia> {
  const rawMedia = context.input.media;
  if (rawMedia === undefined) return { kind: "none" };
  if (!Array.isArray(rawMedia) || rawMedia.length < 1 || rawMedia.length > 20) {
    throw new Error("LinkedIn media must contain between one and twenty reviewed files");
  }
  const files = await context.resolveFiles("media");
  if (files.length !== rawMedia.length) throw new Error("LinkedIn media did not resolve every reviewed file");

  const allImages = files.every((file) => imageMediaTypes.has(file.mediaType));
  if (allImages) {
    const items = files.map((file) => {
      const bytes = readVerifiedFile(file, MAX_IMAGE_BYTES, true).bytes;
      if (bytes === null) throw new Error("LinkedIn image could not be materialized");
      return { file, bytes };
    });
    return { kind: "images", items };
  }

  if (files.length !== 1) {
    throw new Error("LinkedIn media must be all images, one supported document, or one video");
  }
  const file = files[0];
  if (file === undefined) throw new Error("LinkedIn media resolver omitted its file");
  if (documentMediaTypes.has(file.mediaType)) {
    const title = requiredString(context.input.media_title, "input.media_title", 200);
    const bytes = readVerifiedFile(file, MAX_DOCUMENT_BYTES, true).bytes;
    if (bytes === null) throw new Error("LinkedIn document could not be materialized");
    return { kind: "document", file, bytes, title };
  }
  if (videoMediaTypes.has(file.mediaType)) {
    const title = optionalString(context.input.media_title, "input.media_title", 200);
    const verified = readVerifiedFile(file, MAX_VIDEO_BYTES, false, MIN_VIDEO_BYTES);
    return {
      kind: "video",
      prepared: { file, preflightIdentity: verified.identity },
      title,
    };
  }
  throw new Error("LinkedIn media type is not supported by the official Posts API contract");
}

function validatePostAuxiliaryInputs(context: ProviderActionContext, media: PreparedMedia): {
  readonly article: Record<string, string> | null;
  readonly altText: string | null;
} {
  const articleUrl = optionalString(context.input.article_url, "input.article_url");
  const articleTitle = optionalString(context.input.article_title, "input.article_title", 399);
  const articleDescription = optionalString(context.input.article_description, "input.article_description", 4_000);
  const altText = optionalString(context.input.alt_text, "input.alt_text", 4_000);

  if (articleUrl !== null) {
    if (media.kind !== "none") throw new Error("LinkedIn article cards and uploaded media are mutually exclusive");
    if (articleTitle === null) throw new Error("input.article_title is required for a LinkedIn external article card");
    const url = new URL(articleUrl);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new Error("LinkedIn external article cards require a credential-free HTTPS source URL");
    }
  } else if (articleTitle !== null || articleDescription !== null) {
    throw new Error("LinkedIn article title and description require input.article_url");
  }
  if (altText !== null && media.kind !== "images") {
    throw new Error("input.alt_text is only supported for LinkedIn image posts");
  }
  if (context.input.media_title !== undefined && media.kind !== "document" && media.kind !== "video") {
    throw new Error("input.media_title is only supported for LinkedIn document and video posts");
  }

  return {
    article: articleUrl === null || articleTitle === null
      ? null
      : {
          source: articleUrl,
          title: articleTitle,
          ...(articleDescription === null ? {} : { description: articleDescription }),
        },
    altText,
  };
}

function uploadUrl(value: unknown): URL {
  const url = new URL(responseString(value, "media upload URL"));
  const allowedHost = url.hostname === "www.linkedin.com" || url.hostname === "www.linkedin-ei.com";
  const allowedPath = url.pathname.startsWith("/dms-uploads/") || url.pathname.startsWith("/dms-mpf-uploads/");
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || !allowedHost
    || !allowedPath
  ) throw new Error("LinkedIn returned an unapproved media upload destination");
  return url;
}

async function putUploadBytes(
  context: ProviderActionContext,
  destination: URL,
  bytes: Uint8Array,
  expectedStatuses: readonly number[],
  headers: Headers,
): Promise<Headers> {
  const response = await context.http.request(destination, {
    method: "PUT",
    headers,
    body: new Uint8Array(bytes),
  }, expectedStatuses, [destination.hostname]);
  return response.headers;
}

async function uploadAuthenticatedBytes(
  context: ProviderActionContext,
  destination: URL,
  bytes: Uint8Array,
  expectedStatuses: readonly number[],
): Promise<Headers> {
  return putUploadBytes(
    context,
    destination,
    bytes,
    expectedStatuses,
    bearerHeaders(context.token.accessToken, { "Content-Type": "application/octet-stream" }),
  );
}

async function uploadSignedVideoPart(
  context: ProviderActionContext,
  destination: URL,
  bytes: Uint8Array,
): Promise<Headers> {
  return putUploadBytes(
    context,
    destination,
    bytes,
    [200, 201],
    new Headers({ "Content-Type": "application/octet-stream" }),
  );
}

type MediaResourceKind = "images" | "documents" | "videos";

function mediaStatusDelay(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^[0-9]{1,9}$/u.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isSafeInteger(seconds) && Number.isSafeInteger(seconds * 1_000)) return seconds * 1_000;
  }
  if (retryAfter !== null) {
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return DEFAULT_MEDIA_STATUS_DELAY_MS;
}

async function waitForMediaAvailable(
  context: ProviderActionContext,
  kind: MediaResourceKind,
  id: string,
): Promise<void> {
  const mediaDeadline = Date.now() + MAX_MEDIA_STATUS_WAIT_MS;
  for (let attempt = 0; attempt < MAX_MEDIA_STATUS_POLLS; attempt += 1) {
    const response = await context.http.request(
      apiUrl(`/rest/${kind}/${encodedUrn(id)}`),
      { method: "GET", headers: apiHeaders(context) },
      [200],
      LINKEDIN_API_HOSTS,
    );
    const resource = record(response.body, `${kind.slice(0, -1)} status response`);
    const status = responseString(resource.status, `${kind.slice(0, -1)} status`, 100);
    if (status === "AVAILABLE") return;
    if (status === "PROCESSING_FAILED") {
      throw new Error(`LinkedIn ${kind.slice(0, -1)} processing failed`);
    }
    if (status !== "WAITING_UPLOAD" && status !== "PROCESSING") {
      throw new Error(`LinkedIn returned an unsupported ${kind.slice(0, -1)} processing status`);
    }

    const remaining = Math.min(mediaDeadline - Date.now(), context.http.remainingTimeMs());
    if (attempt + 1 >= MAX_MEDIA_STATUS_POLLS || remaining <= 0) break;
    const delay = mediaStatusDelay(response.headers);
    if (delay >= remaining) break;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`LinkedIn ${kind.slice(0, -1)} processing did not become AVAILABLE within the bounded polling window`);
}

async function initializeAndUploadImage(
  context: ProviderActionContext,
  owner: string,
  bytes: Uint8Array,
): Promise<string> {
  const response = await context.http.request(
    apiUrl("/rest/images?action=initializeUpload"),
    {
      method: "POST",
      headers: apiHeaders(context, true),
      body: jsonBody({ initializeUploadRequest: { owner } }),
    },
    [200],
    LINKEDIN_API_HOSTS,
  );
  const value = record(record(response.body, "image initialization response").value, "image initialization value");
  const id = responseString(value.image, "image URN", 500);
  if (!/^urn:li:image:[A-Za-z0-9_-]{1,256}$/u.test(id)) {
    throw new Error("LinkedIn returned an invalid image URN");
  }
  await uploadAuthenticatedBytes(context, uploadUrl(value.uploadUrl), bytes, [200, 201]);
  await waitForMediaAvailable(context, "images", id);
  return id;
}

async function initializeAndUploadDocument(
  context: ProviderActionContext,
  owner: string,
  bytes: Uint8Array,
): Promise<string> {
  const response = await context.http.request(
    apiUrl("/rest/documents?action=initializeUpload"),
    {
      method: "POST",
      headers: apiHeaders(context, true),
      body: jsonBody({ initializeUploadRequest: { owner } }),
    },
    [200],
    LINKEDIN_API_HOSTS,
  );
  const value = record(record(response.body, "document initialization response").value, "document initialization value");
  const id = responseString(value.document, "document URN", 500);
  if (!/^urn:li:document:[A-Za-z0-9_-]{1,256}$/u.test(id)) {
    throw new Error("LinkedIn returned an invalid document URN");
  }
  await uploadAuthenticatedBytes(context, uploadUrl(value.uploadUrl), bytes, [200, 201]);
  await waitForMediaAvailable(context, "documents", id);
  return id;
}

function uploadInstructions(value: unknown, fileBytes: number): readonly UploadInstruction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new Error("LinkedIn returned an invalid video upload instruction list");
  }
  const instructions: UploadInstruction[] = [];
  let expectedFirstByte = 0;
  for (const item of value) {
    const instruction = record(item, "video upload instruction");
    const firstByte = responseInteger(instruction.firstByte, "video first byte");
    const lastByte = responseInteger(instruction.lastByte, "video last byte");
    if (firstByte !== expectedFirstByte || lastByte < firstByte || lastByte >= fileBytes) {
      throw new Error("LinkedIn video upload byte ranges are not authoritative contiguous file coverage");
    }
    instructions.push({ firstByte, lastByte, uploadUrl: uploadUrl(instruction.uploadUrl).toString() });
    expectedFirstByte = lastByte + 1;
  }
  if (expectedFirstByte !== fileBytes) {
    throw new Error("LinkedIn video upload byte ranges do not cover the reviewed file exactly");
  }
  return instructions;
}

function safeEtag(value: string | null): string {
  if (
    value === null
    || value.length < 1
    || value.length > 8_192
    || value.trim() !== value
    || hasAnyAsciiControl(value)
    || /^W\//iu.test(value)
  ) {
    throw new Error("LinkedIn video upload did not return a usable ETag");
  }
  const startsQuoted = value.startsWith('"');
  const endsQuoted = value.endsWith('"');
  if (startsQuoted || endsQuoted) {
    if (!startsQuoted || !endsQuoted || value.length < 3) {
      throw new Error("LinkedIn video upload did not return a usable ETag");
    }
    const unquoted = value.slice(1, -1);
    if (unquoted.includes('"') || hasAnyAsciiControl(unquoted)) {
      throw new Error("LinkedIn video upload did not return a usable ETag");
    }
    return unquoted;
  }
  if (value.includes('"')) throw new Error("LinkedIn video upload did not return a usable ETag");
  return value;
}

function readFileRange(descriptor: number, firstByte: number, lastByte: number): Buffer {
  const length = lastByte - firstByte + 1;
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, buffer, offset, length - offset, firstByte + offset);
    if (count < 1) throw new Error("LinkedIn video ended before an authoritative upload range");
    offset += count;
  }
  return buffer;
}

async function initializeUploadAndFinalizeVideo(
  context: ProviderActionContext,
  owner: string,
  prepared: PreparedProviderFile,
): Promise<string> {
  const { file } = prepared;
  // Keep the exact preflight identity open across initialization, every signed
  // part upload, digest verification, and finalization. A replaced file is
  // rejected before the first provider request or remote byte.
  const opened = openProviderFile(file, MAX_VIDEO_BYTES, prepared.preflightIdentity, MIN_VIDEO_BYTES);
  const hash = createHash("sha256");
  const etags: string[] = [];
  try {
    const initialized = await context.http.request(
      apiUrl("/rest/videos?action=initializeUpload"),
      {
        method: "POST",
        headers: apiHeaders(context, true),
        body: jsonBody({
          initializeUploadRequest: {
            owner,
            fileSizeBytes: file.bytes,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      },
      [200],
      LINKEDIN_API_HOSTS,
    );
    const value = record(record(initialized.body, "video initialization response").value, "video initialization value");
    const id = responseString(value.video, "video URN", 500);
    if (!/^urn:li:video:[A-Za-z0-9_-]{1,256}$/u.test(id)) throw new Error("LinkedIn returned an invalid video URN");
    const token = responseString(value.uploadToken, "video upload token", 4_096, true);
    const instructions = uploadInstructions(value.uploadInstructions, file.bytes);

    for (const instruction of instructions) {
      const bytes = readFileRange(opened.descriptor, instruction.firstByte, instruction.lastByte);
      hash.update(bytes);
      const headers = await uploadSignedVideoPart(context, new URL(instruction.uploadUrl), bytes);
      etags.push(safeEtag(headers.get("etag")));
    }
    const after = fstatSync(opened.descriptor, { bigint: true });
    if (!sameFile(opened.stats, after)) throw new Error("LinkedIn video changed during upload");
    if (hash.digest("hex") !== file.sha256) {
      throw new Error("LinkedIn video no longer matches the confirmed attachment digest");
    }

    await context.http.request(
      apiUrl("/rest/videos?action=finalizeUpload"),
      {
        method: "POST",
        headers: apiHeaders(context, true),
        body: jsonBody({
          finalizeUploadRequest: {
            video: id,
            uploadToken: token,
            uploadedPartIds: etags,
          },
        }),
      },
      [200],
      LINKEDIN_API_HOSTS,
    );
    await waitForMediaAvailable(context, "videos", id);
    return id;
  } finally {
    closeSync(opened.descriptor);
  }
}

async function readPosts(context: ProviderActionContext): Promise<void> {
  const mode = requiredString(context.input.mode, "input.mode", 20);
  const view = context.input.view === undefined
    ? "READER"
    : requiredString(context.input.view, "input.view", 20);
  if (view !== "READER" && view !== "AUTHOR") throw new Error("input.view must be READER or AUTHOR");

  if (mode === "one") {
    const id = postUrn(requiredString(context.input.post_urn, "input.post_urn", 500));
    const url = apiUrl(`/rest/posts/${encodedUrn(id)}`);
    url.searchParams.set("viewContext", view);
    const response = await context.http.request(url, {
      method: "GET",
      headers: apiHeaders(context),
    }, [200], LINKEDIN_API_HOSTS);
    context.setOutput(singleOutput("posts.read", exactResponsePost(response.body, id)));
    context.setFinalUrl(linkedInPostUrl(id));
    return;
  }
  if (mode !== "author") throw new Error("input.mode must be one or author");

  const author = requiredString(context.input.author, "input.author", 500);
  const kind = actorKind(author);
  context.addRequiredScopes([kind === "member" ? "r_member_social" : "r_organization_social"]);
  const start = inputInteger(context.input.start, "input.start", 0, 0, 100_000);
  const count = inputInteger(context.input.count, "input.count", 10, 1, 100);
  const sort = context.input.sort === undefined
    ? "LAST_MODIFIED"
    : requiredString(context.input.sort, "input.sort", 20);
  if (sort !== "LAST_MODIFIED" && sort !== "CREATED") {
    throw new Error("input.sort must be LAST_MODIFIED or CREATED");
  }
  const url = apiUrl("/rest/posts");
  url.searchParams.set("author", author);
  url.searchParams.set("q", "author");
  url.searchParams.set("start", String(start));
  url.searchParams.set("count", String(count));
  url.searchParams.set("sortBy", sort);
  url.searchParams.set("viewContext", view);
  const headers = apiHeaders(context);
  headers.set("X-RestLi-Method", "FINDER");
  const response = await context.http.request(url, { method: "GET", headers }, [200], LINKEDIN_API_HOSTS);
  context.setOutput(pageOutput(
    "posts.read",
    "author-posts",
    response.body,
    start,
    count,
    url,
    (value) => exactAuthorPost(value, author),
    [
      "The author finder does not reconstruct LinkedIn's algorithmic Home feed.",
      "Member post reads require LinkedIn's restricted r_member_social approval.",
    ],
  ));
}

async function readComments(context: ProviderActionContext): Promise<void> {
  const target = commentReadTargetUrn(requiredString(context.input.target_urn, "input.target_urn", 1_000));
  const start = inputInteger(context.input.start, "input.start", 0, 0, 100_000);
  const count = inputInteger(context.input.count, "input.count", 10, 1, 100);
  const url = apiUrl(`/rest/socialActions/${encodedUrn(target)}/comments`);
  url.searchParams.set("start", String(start));
  url.searchParams.set("count", String(count));
  const response = await context.http.request(url, {
    method: "GET",
    headers: apiHeaders(context),
  }, [200], LINKEDIN_API_HOSTS);
  context.setOutput(pageOutput(
    "comments.read",
    "comments",
    response.body,
    start,
    count,
    url,
    (value) => exactListedComment(value, target, target.startsWith("urn:li:comment:")),
    [
      "One comment level is returned per request; pass a parent comment URN to read its replies.",
      "LinkedIn comment read scopes are restricted and require approved API access.",
      ...(!target.startsWith("urn:li:comment:")
        ? ["For top-level collections, requestedTarget records the exact share or UGC Post request path; LinkedIn's canonical response object/activity may legitimately differ and is preserved separately."]
        : []),
    ],
  ));
}

function createdCommentIdentity(
  bodyValue: unknown,
  headers: Headers,
  expected: {
    readonly actor: string;
    readonly object: string;
    readonly parent: string | null;
    readonly text: string;
  },
): {
  readonly id: string;
  readonly urn: string | null;
  readonly comment: Record<string, unknown>;
} {
  const body = record(bodyValue, "created comment response");
  const headerId = responseString(headers.get("x-restli-id"), "created comment header ID", 32);
  const bodyId = responseString(body.id, "created comment body ID", 32);
  if (!/^[0-9]{1,32}$/u.test(headerId) || !/^[0-9]{1,32}$/u.test(bodyId)) {
    throw new Error("LinkedIn created a comment without returning usable header and body IDs");
  }
  if (headerId !== bodyId) {
    throw new Error("LinkedIn created comment header and body IDs disagreed");
  }
  const urn = commentUrn(responseString(body.commentUrn, "created comment URN", 1_000));
  if (!urn.endsWith(`,${bodyId})`)) {
    throw new Error("LinkedIn created comment ID and URN disagreed");
  }

  const actor = responseString(body.actor, "created comment actor", 500);
  actorKind(actor);
  if (actor !== expected.actor) throw new Error("LinkedIn created comment actor disagreed with the requested actor");
  const object = rootObjectUrn(responseString(body.object, "created comment object", 1_000));
  if (object !== expected.object) throw new Error("LinkedIn created comment object disagreed with the requested object");
  const parent = optionalResponseString(body, "parentComment", "created comment parent", 1_000);
  if (expected.parent === null) {
    if (parent !== null) throw new Error("LinkedIn created a nested reply instead of the requested top-level comment");
  } else if (parent === null || commentUrn(parent) !== expected.parent) {
    throw new Error("LinkedIn created comment parent disagreed with the requested parent");
  }
  const message = record(body.message, "created comment message");
  if (responseString(message.text, "created comment text", 500) !== expected.text) {
    throw new Error("LinkedIn created comment text disagreed with the requested text");
  }
  return { id: bodyId, urn, comment: normalizeComment(body) };
}

async function createComment(context: ProviderActionContext, reply: boolean): Promise<void> {
  const actor = requiredString(context.input.actor, "input.actor", 500);
  requireWriteActor(context, actor, {
    member: "w_member_social_feed",
    organization: "w_organization_social_feed",
  });
  const object = rootObjectUrn(requiredString(context.input.object_urn, "input.object_urn", 1_000));
  const body = requiredString(context.input.body, "input.body", 500);
  const target = reply
    ? commentUrn(requiredString(context.input.parent_comment_urn, "input.parent_comment_urn", 1_000))
    : postUrn(requiredString(context.input.target_urn, "input.target_urn", 1_000));
  const requestBody = {
    actor,
    object,
    message: { text: body },
    ...(reply ? { parentComment: target } : {}),
  };

  const created = await context.dispatch(async () => {
    const response = await context.http.request(
      apiUrl(`/rest/socialActions/${encodedUrn(target)}/comments`),
      {
        method: "POST",
        headers: apiHeaders(context, true),
        body: jsonBody(requestBody),
      },
      [201],
      LINKEDIN_API_HOSTS,
    );
    return createdCommentIdentity(response.body, response.headers, {
      actor,
      object,
      parent: reply ? target : null,
      text: body,
    });
  });
  const rootPost = reply ? (object.startsWith("urn:li:share:") || object.startsWith("urn:li:ugcPost:") ? object : null) : target;
  const finalUrl = rootPost === null ? null : linkedInCommentUrl(rootPost, created.urn);
  context.setOutput(writeOutput(reply ? "replies.create" : "comments.create", {
    id: created.id,
    commentUrn: created.urn,
    actor,
    object,
    parentComment: reply ? target : null,
    url: finalUrl,
    comment: created.comment,
  }));
  if (finalUrl !== null) context.setFinalUrl(finalUrl);
}

async function setReaction(context: ProviderActionContext): Promise<void> {
  const actor = requiredString(context.input.actor, "input.actor", 500);
  requireWriteActor(context, actor, {
    member: "w_member_social_feed",
    organization: "w_organization_social_feed",
  });
  const target = socialTargetUrn(requiredString(context.input.target_urn, "input.target_urn", 1_000));
  if (typeof context.input.enabled !== "boolean") throw new Error("input.enabled must be a boolean");
  const enabled = context.input.enabled;
  let reaction: string | null = null;
  if (enabled) {
    reaction = requiredString(context.input.reaction, "input.reaction", 40);
    if (!reactionTypes.has(reaction)) throw new Error("input.reaction is not a supported LinkedIn reaction type");
  } else if (context.input.reaction !== undefined) {
    throw new Error("input.reaction is not accepted when input.enabled is false because LinkedIn clears any current reaction");
  }

  const result = await context.dispatch(async (): Promise<Record<string, unknown>> => {
    if (enabled) {
      if (reaction === null) throw new Error("input.reaction is required when input.enabled is true");
      const url = apiUrl("/rest/reactions");
      url.searchParams.set("actor", actor);
      const response = await context.http.request(url, {
        method: "POST",
        headers: apiHeaders(context, true),
        body: jsonBody({ root: target, reactionType: reaction }),
      }, [201], LINKEDIN_API_HOSTS);
      const body = record(response.body, "created reaction response");
      const root = socialTargetUrn(responseString(body.root, "created reaction root", 1_000));
      if (root !== target) throw new Error("LinkedIn created reaction root disagreed with the requested target");
      const returnedType = responseString(body.reactionType, "created reaction type", 40);
      if (returnedType !== reaction) {
        throw new Error("LinkedIn created reaction type disagreed with the requested reaction");
      }
      const id = responseString(body.id, "created reaction ID", 2_000);
      const expectedId = `urn:li:reaction:(${actor},${root})`;
      if (id !== expectedId) {
        throw new Error("LinkedIn created reaction ID did not canonically bind the requested actor and target");
      }
      const headerId = response.headers.get("x-restli-id");
      if (headerId !== null && responseString(headerId, "created reaction header ID", 2_000) !== id) {
        throw new Error("LinkedIn created reaction header and body IDs disagreed");
      }
      const topLevelActor = optionalResponseString(body, "actor", "created reaction actor", 500);
      if (topLevelActor !== null && topLevelActor !== actor) {
        throw new Error("LinkedIn created reaction actor disagreed with the requested actor");
      }
      const created = record(body.created, "created reaction creation stamp");
      if (responseString(created.actor, "created reaction creation actor", 500) !== actor) {
        throw new Error("LinkedIn created reaction audit actor disagreed with the requested actor");
      }
      if (body.lastModified !== undefined) {
        const lastModified = record(body.lastModified, "created reaction modification stamp");
        if (responseString(lastModified.actor, "created reaction modification actor", 500) !== actor) {
          throw new Error("LinkedIn created reaction audit actor disagreed with the requested actor");
        }
      }
      return {
        id,
        actor,
        target,
        reaction,
        enabled: true,
      };
    }
    const key = `(actor:${encodedUrn(actor)},entity:${encodedUrn(target)})`;
    await context.http.request(apiUrl(`/rest/reactions/${key}`), {
      method: "DELETE",
      headers: apiHeaders(context),
    }, [204], LINKEDIN_API_HOSTS);
    return {
      id: null,
      actor,
      target,
      reaction: null,
      enabled: false,
      effect: "clear-any-current-reaction",
    };
  });
  context.setOutput(writeOutput("reactions.set", result));
}

async function publishPost(context: ProviderActionContext): Promise<void> {
  const author = requiredString(context.input.author, "input.author", 500);
  const kind = requireWriteActor(context, author, {
    member: "w_member_social",
    organization: "w_organization_social",
  });
  const commentary = requiredString(context.input.body, "input.body", 3_000);
  const visibility = context.input.visibility === undefined
    ? "PUBLIC"
    : requiredString(context.input.visibility, "input.visibility", 20);
  if (visibility !== "PUBLIC" && visibility !== "CONNECTIONS") {
    throw new Error("input.visibility must be PUBLIC or CONNECTIONS");
  }
  if (kind === "organization" && visibility === "CONNECTIONS") {
    throw new Error("LinkedIn organization posts cannot use CONNECTIONS visibility");
  }

  if (context.input.media !== undefined) {
    context.addRequiredScopes([kind === "member" ? "r_member_social" : "r_organization_social"]);
  }

  // Every file and media union is resolved and digest-verified before the
  // mutation dispatch begins. Only official API and signed-upload work occurs
  // inside the single confirmed semantic dispatch.
  const media = await prepareMedia(context);
  const auxiliary = validatePostAuxiliaryInputs(context, media);

  const created = await context.dispatch(async (): Promise<{
    readonly id: string;
    readonly mediaKind: PreparedMedia["kind"] | "article";
    readonly mediaIds: readonly string[];
  }> => {
    let content: Record<string, unknown> | null = null;
    let mediaKind: PreparedMedia["kind"] | "article" = media.kind;
    let mediaIds: readonly string[] = [];
    if (auxiliary.article !== null) {
      mediaKind = "article";
      content = { article: auxiliary.article };
    } else if (media.kind === "images") {
      const ids: string[] = [];
      for (const item of media.items) ids.push(await initializeAndUploadImage(context, author, item.bytes));
      mediaIds = ids;
      if (ids.length === 1) {
        const id = ids[0];
        if (id === undefined) throw new Error("LinkedIn image upload omitted its media URN");
        content = {
          media: {
            id,
            ...(auxiliary.altText === null ? {} : { altText: auxiliary.altText }),
          },
        };
      } else {
        content = {
          multiImage: {
            images: ids.map((id) => ({
              id,
              ...(auxiliary.altText === null ? {} : { altText: auxiliary.altText }),
            })),
          },
        };
      }
    } else if (media.kind === "document") {
      const id = await initializeAndUploadDocument(context, author, media.bytes);
      mediaIds = [id];
      content = { media: { title: media.title, id } };
    } else if (media.kind === "video") {
      const id = await initializeUploadAndFinalizeVideo(context, author, media.prepared);
      mediaIds = [id];
      content = { media: { id, ...(media.title === null ? {} : { title: media.title }) } };
    }

    const requestBody = {
      author,
      commentary,
      visibility,
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      ...(content === null ? {} : { content }),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    const response = await context.http.request(apiUrl("/rest/posts"), {
      method: "POST",
      headers: apiHeaders(context, true),
      body: jsonBody(requestBody),
    }, [201], LINKEDIN_API_HOSTS);
    const id = responseString(response.headers.get("x-restli-id"), "created post ID", 500);
    return { id: postUrn(id), mediaKind, mediaIds };
  });

  const url = linkedInPostUrl(created.id);
  context.setOutput(writeOutput("posts.publish", {
    id: created.id,
    url,
    author,
    visibility,
    contentKind: created.mediaKind,
    mediaIds: created.mediaIds,
  }, created.mediaKind === "video"
    ? ["wrench validates the reviewed MP4 bytes, type, and size locally; LinkedIn validates its 3-second to 30-minute duration and supported codecs while processing it to AVAILABLE."]
    : []));
  context.setFinalUrl(url);
}

/** Execute a fixed LinkedIn REST contract. No endpoint, method, or host is supplied by a manifest. */
export async function executeLinkedInProvider(context: ProviderActionContext): Promise<void> {
  if (context.recipe.action === "posts.read") await readPosts(context);
  else if (context.recipe.action === "posts.publish") await publishPost(context);
  else if (context.recipe.action === "posts.repost") await resharePost(context);
  else if (context.recipe.action === "comments.read") await readComments(context);
  else if (context.recipe.action === "comments.create") await createComment(context, false);
  else if (context.recipe.action === "replies.create") await createComment(context, true);
  else if (context.recipe.action === "reactions.set") await setReaction(context);
  else throw new Error(`official LinkedIn provider does not implement ${context.recipe.action}`);
}
