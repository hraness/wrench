/**
 * Substack consumer-web internal API policy and bounded projections.
 *
 * Browser state may provide the signed-in cookie jar, but this module owns
 * every executable request shape and response projection. It intentionally
 * exposes no raw endpoint, header, cookie, publication origin, or request
 * payload as a semantic input.
 */

export const SUBSTACK_WEB_OPERATION_NAMES = Object.freeze([
  "articles.publish",
  "articles.read",
  "comments.create",
  "comments.read",
  "content.edit",
  "content.save",
  "content.schedule",
  "content.share",
  "feeds.read",
  "likes.set",
  "media.read",
  "messaging.list",
  "messaging.read",
  "messaging.send",
  "posts.publish",
  "posts.quote",
  "posts.read",
  "posts.repost",
  "profiles.read",
  "organizations.read",
  "relationships.follow.set",
  "replies.create",
] as const);

export type SubstackWebOperationName = (typeof SUBSTACK_WEB_OPERATION_NAMES)[number];
export type SubstackWebRisk = "R1" | "R2" | "R3";
export type SubstackWebContractState = "observed" | "capture-required";
export type SubstackWebEvidence = "live-direct" | "first-party-bundle" | "none";

export type SubstackWebOperationContract = {
  readonly effect: "read" | "write";
  readonly risk: SubstackWebRisk;
  readonly state: SubstackWebContractState;
  readonly evidence: SubstackWebEvidence;
  readonly reason: string;
};

const observedRead = (reason: string): SubstackWebOperationContract => Object.freeze({
  effect: "read",
  risk: "R1",
  state: "observed",
  evidence: "live-direct",
  reason,
});

const observedWrite = (reason: string): SubstackWebOperationContract => Object.freeze({
  effect: "write",
  risk: "R3",
  state: "observed",
  evidence: "live-direct",
  reason,
});

const captureRequired = (
  risk: SubstackWebRisk,
  evidence: SubstackWebEvidence,
  reason: string,
): SubstackWebOperationContract => Object.freeze({
  effect: "write",
  risk,
  state: "capture-required",
  evidence,
  reason,
});

const captureRequiredRead = (
  evidence: SubstackWebEvidence,
  reason: string,
): SubstackWebOperationContract => Object.freeze({
  effect: "read",
  risk: "R1",
  state: "capture-required",
  evidence,
  reason,
});

export const SUBSTACK_WEB_OPERATIONS = Object.freeze({
  "feeds.read": observedRead(
    "current central reader, inbox, and reader-post list endpoints with bounded first-page projection",
  ),
  "posts.read": observedRead(
    "exact Note/comment entity read through /api/v1/reader/comment/{id}",
  ),
  "articles.read": observedRead(
    "exact entitled article read through /api/v1/posts/by-id/{id}",
  ),
  "comments.read": observedRead(
    "exact article reply branch read with post and publication binding",
  ),
  "media.read": observedRead(
    "bounded cover, podcast, video-upload, API audio-item, and exact same-publication inline audio metadata projected from an exact entitled article response",
  ),
  "messaging.list": observedRead(
    "acknowledgement-free inbox listing for all, people, and unread tabs",
  ),
  "messaging.read": captureRequiredRead(
    "first-party-bundle",
    "the exact DM GET is current-bundle observed, but this account has no low-stakes direct-message fixture proving acknowledgement behavior",
  ),
  "profiles.read": observedRead(
    "exact target-bound /api/v1/user/{handle}/public_profile response with current-viewer ID binding and an exact follower count",
  ),
  "organizations.read": observedRead(
    "exact owned-publication /api/v1/publish-dashboard/summary response with bootstrap-bound publication origin and exact total-email and paid-subscriber counts",
  ),
  "likes.set": captureRequired(
    "R2",
    "first-party-bundle",
    "post and Note/comment reaction endpoints are distinct and need authorized desired-state fixtures plus independent readback",
  ),
  "content.save": captureRequired(
    "R2",
    "first-party-bundle",
    "post and Note save endpoints are distinct and need authorized desired-state fixtures plus independent readback",
  ),
  "relationships.follow.set": captureRequired(
    "R2",
    "first-party-bundle",
    "user-follow and publication-subscription changes have different effects; paid, pledge, and email changes remain blocked",
  ),
  "comments.create": captureRequired(
    "R3",
    "first-party-bundle",
    "article comment publication needs an authorized fixture and exact actor/post response binding",
  ),
  "replies.create": captureRequired(
    "R3",
    "first-party-bundle",
    "Note, article-comment, and chat replies are separate transports and need exact authorized fixtures",
  ),
  "messaging.send": captureRequired(
    "R3",
    "first-party-bundle",
    "DM start/send and optional media URL upload need exact recipient, thread, response, and attachment bindings",
  ),
  "posts.publish": observedWrite(
    "authorized Note composer capture proving one optional PNG upload, exact public create payload, durable accepted-Note targeting, actor and attachment response binding, and four bounded exact readbacks over a six-second visibility window",
  ),
  "posts.quote": captureRequired(
    "R3",
    "first-party-bundle",
    "quote-Note creation is not interchangeable with a plain Note or restack",
  ),
  "posts.repost": captureRequired(
    "R3",
    "first-party-bundle",
    "restack creation needs an authorized fixture and exact source/created-Note response binding",
  ),
  "content.share": captureRequired(
    "R3",
    "first-party-bundle",
    "external sharing and Substack-native restacking are different externally visible effects",
  ),
  "content.edit": captureRequired(
    "R3",
    "first-party-bundle",
    "owned Note, comment, draft, and article edits have distinct origins and response/readback contracts",
  ),
  "articles.publish": captureRequired(
    "R3",
    "first-party-bundle",
    "article authoring may execute only on an exact viewer-owned publication origin and must never default to sending email",
  ),
  "content.schedule": captureRequired(
    "R3",
    "first-party-bundle",
    "scheduled publication needs an exact viewer-owned publication, time zone, audience, notification, and returned-draft binding",
  ),
} as const satisfies Readonly<Record<SubstackWebOperationName, SubstackWebOperationContract>>);

const SUBSTACK_ORIGIN = "https://substack.com";
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 100;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_AUDIO_EMBEDS = 20;
const MAX_INLINE_AUDIO_TAG_CODE_UNITS = 16_384;
const INLINE_AUDIO_UPLOAD_PATH = /^\/api\/v1\/audio\/upload\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/src$/u;

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

function integerId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function optionalIntegerId(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return integerId(value, label);
}

function optionalFiniteNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function boundedArray(value: unknown, label: string, maximum = MAX_ITEMS): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value;
}

function exactHttpsUrl(value: unknown, label: string, maximum = 8_192): string | null {
  if (value === undefined || value === null || value === "") return null;
  const candidate = boundedString(value, label, maximum);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) throw new Error(`${label} must be a credential-free HTTPS URL`);
  return parsed.href;
}

type SubstackProfileMetric = Readonly<
  | {
      readonly status: "available";
      readonly value: number;
      readonly precision: "exact";
      readonly unit: "count";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "not-exposed" | "not-authorized" | "provider-drift";
    }
>;

function unavailableSubstackProfileMetric(
  reason: "not-exposed" | "not-authorized" | "provider-drift",
): SubstackProfileMetric {
  return Object.freeze({ status: "unavailable", reason });
}

function exactSubstackProfileMetric(value: unknown): SubstackProfileMetric {
  if (value === undefined || value === null) {
    return unavailableSubstackProfileMetric("not-exposed");
  }
  const candidate = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    return unavailableSubstackProfileMetric("provider-drift");
  }
  return Object.freeze({
    status: "available",
    value: candidate as number,
    precision: "exact",
    unit: "count",
  });
}

function canonicalSubstackProfileHandle(value: unknown, label: string): string {
  const handle = boundedString(value, label, 128).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u.test(handle)) {
    throw new Error(`${label} must be one canonical lowercase Substack handle`);
  }
  return handle;
}

function exactSubstackProfileId(value: unknown, label: string): string {
  if (Number.isSafeInteger(value) && (value as number) > 0) return String(value);
  if (
    typeof value === "string"
    && /^[1-9][0-9]{0,15}$/u.test(value)
    && Number.isSafeInteger(Number(value))
  ) return value;
  throw new Error(`${label} must be one positive safe integer identifier`);
}

function exactSubstackProfileObservedAt(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) throw new Error("Substack profile observation time must be one exact UTC instant");
  return value;
}

/** Project one exact target-bound signed-in Substack public-profile response. */
export function normalizeSubstackProfileStatsResponse(
  value: unknown,
  expectedViewerId: number,
  expectedProfile: string,
  observedAt: string,
): Readonly<Record<string, unknown>> {
  const source = record(value, "Substack public-profile response");
  const handle = canonicalSubstackProfileHandle(
    source.handle,
    "Substack public-profile response.handle",
  );
  const profile = canonicalSubstackProfileHandle(
    expectedProfile,
    "Substack requested profile",
  );
  if (handle !== profile) {
    throw new Error("Substack public-profile response did not bind the requested handle");
  }
  const id = exactSubstackProfileId(
    source.id,
    "Substack public-profile response.id",
  );
  if (id !== exactSubstackProfileId(expectedViewerId, "Substack expected viewer ID")) {
    throw new Error("Substack public-profile response did not bind the current viewer ID");
  }
  const camelCount = exactSubstackProfileMetric(source.followerCount);
  const snakeCount = exactSubstackProfileMetric(source.follower_count);
  let followers = source.followerCount === undefined
    ? snakeCount
    : camelCount;
  if (
    source.followerCount !== undefined
    && source.follower_count !== undefined
    && JSON.stringify(camelCount) !== JSON.stringify(snakeCount)
  ) followers = unavailableSubstackProfileMetric("provider-drift");
  const displayName = optionalString(
    source.name,
    "Substack public-profile response.name",
    512,
  );
  const bio = optionalString(
    source.bio,
    "Substack public-profile response.bio",
    16_384,
  );
  const websiteUrl = exactHttpsUrl(
    source.websiteUrl ?? source.website_url,
    "Substack public-profile response.websiteUrl",
    2_048,
  );
  return Object.freeze({
    schemaVersion: 1,
    provider: "substack",
    target: Object.freeze({
      kind: "profile",
      id,
      url: `https://substack.com/@${handle}`,
    }),
    observedAt: exactSubstackProfileObservedAt(observedAt),
    completeness: followers.status === "available" ? "complete" : "partial",
    metrics: Object.freeze({ followers }),
    metadata: Object.freeze({
      handle,
      ...(displayName === null ? {} : { displayName }),
      ...(bio === null ? {} : { bio }),
      ...(websiteUrl === null ? {} : { websiteUrl }),
    }),
  });
}

function unavailableDerivedSubstackMetric(
  values: readonly SubstackProfileMetric[],
): SubstackProfileMetric {
  if (values.some((metric) =>
    metric.status === "unavailable" && metric.reason === "provider-drift")) {
    return unavailableSubstackProfileMetric("provider-drift");
  }
  if (values.some((metric) =>
    metric.status === "unavailable" && metric.reason === "not-authorized")) {
    return unavailableSubstackProfileMetric("not-authorized");
  }
  return unavailableSubstackProfileMetric("not-exposed");
}

/** Project exact free and paid counts from one owned publication summary. */
export function normalizeSubstackPublicationStatsResponse(
  value: unknown,
  expectedPublication: Readonly<{
    id: number;
    organization: string;
    origin: string;
  }>,
  observedAt: string,
): Readonly<Record<string, unknown>> {
  const source = record(value, "Substack publication summary response");
  const organization = canonicalSubstackProfileHandle(
    expectedPublication.organization,
    "Substack publication organization",
  );
  const expectedOrigin = `https://${organization}.substack.com`;
  if (exactOrigin(expectedPublication.origin, "Substack publication origin") !== expectedOrigin) {
    throw new Error("Substack publication origin did not bind the requested organization");
  }
  const total = exactSubstackProfileMetric(source.totalEmail);
  const paidSubscribers = exactSubstackProfileMetric(source.subscribers);
  const freeSubscribers = total.status === "available" && paidSubscribers.status === "available"
    ? paidSubscribers.value <= total.value
      ? exactSubstackProfileMetric(total.value - paidSubscribers.value)
      : unavailableSubstackProfileMetric("provider-drift")
    : unavailableDerivedSubstackMetric([total, paidSubscribers]);
  const complete = freeSubscribers.status === "available"
    && paidSubscribers.status === "available";
  return Object.freeze({
    schemaVersion: 1,
    provider: "substack",
    target: Object.freeze({
      kind: "publication",
      id: exactSubstackProfileId(
        expectedPublication.id,
        "Substack publication ID",
      ),
      url: `${expectedOrigin}/`,
    }),
    observedAt: exactSubstackProfileObservedAt(observedAt),
    completeness: complete ? "complete" : "partial",
    metrics: Object.freeze({ freeSubscribers, paidSubscribers }),
    metadata: Object.freeze({ handle: organization }),
  });
}

export type SubstackInlineAudioEmbed = Readonly<{
  uploadId: string;
  url: string;
}>;

function isHtmlWhitespace(value: string | undefined): boolean {
  return value === " "
    || value === "\t"
    || value === "\n"
    || value === "\f"
    || value === "\r";
}

function asciiCaseEqualAt(
  value: string,
  offset: number,
  expected: string,
): boolean {
  if (offset < 0 || offset + expected.length > value.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = value.charCodeAt(offset + index);
    const folded = actual >= 0x41 && actual <= 0x5a ? actual + 0x20 : actual;
    if (folded !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function isTagBoundary(value: string | undefined): boolean {
  return value === undefined || value === ">" || value === "/" || isHtmlWhitespace(value);
}

function inlineAudioTagEnd(bodyHtml: string, start: number): number {
  let quote: "\"" | "'" | null = null;
  const maximumEnd = Math.min(
    bodyHtml.length,
    start + MAX_INLINE_AUDIO_TAG_CODE_UNITS,
  );
  for (let cursor = start + 1; cursor < maximumEnd; cursor += 1) {
    const character = bodyHtml[cursor];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor;
    }
  }
  throw new Error("Substack inline audio tag was malformed or exceeded its bound");
}

function inlineAudioSrcAttribute(tag: string): string | null {
  let cursor = "<audio".length;
  let source: string | null = null;
  const end = tag.length - 1;
  while (cursor < end) {
    while (isHtmlWhitespace(tag[cursor])) cursor += 1;
    if (cursor >= end || tag[cursor] === "/") break;

    const nameStart = cursor;
    while (
      cursor < end
      && !isHtmlWhitespace(tag[cursor])
      && tag[cursor] !== "="
      && tag[cursor] !== "/"
      && tag[cursor] !== ">"
      && tag[cursor] !== "\""
      && tag[cursor] !== "'"
      && tag[cursor] !== "<"
    ) cursor += 1;
    if (cursor === nameStart) {
      throw new Error("Substack inline audio tag contained a malformed attribute");
    }
    const name = tag.slice(nameStart, cursor).toLowerCase();
    while (isHtmlWhitespace(tag[cursor])) cursor += 1;
    if (tag[cursor] !== "=") {
      if (name === "src") {
        throw new Error("Substack inline audio src attribute omitted its value");
      }
      continue;
    }

    cursor += 1;
    while (isHtmlWhitespace(tag[cursor])) cursor += 1;
    if (cursor >= end) {
      throw new Error("Substack inline audio attribute omitted its value");
    }
    let attributeValue: string;
    const quote = tag[cursor];
    if (quote === "\"" || quote === "'") {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < end && tag[cursor] !== quote) cursor += 1;
      if (cursor >= end) {
        throw new Error("Substack inline audio attribute was unterminated");
      }
      attributeValue = tag.slice(valueStart, cursor);
      cursor += 1;
    } else {
      const valueStart = cursor;
      while (cursor < end && !isHtmlWhitespace(tag[cursor]) && tag[cursor] !== ">") {
        if (tag[cursor] === "\"" || tag[cursor] === "'" || tag[cursor] === "<") {
          throw new Error("Substack inline audio attribute was malformed");
        }
        cursor += 1;
      }
      attributeValue = tag.slice(valueStart, cursor);
    }
    if (name !== "src") continue;
    if (source !== null) {
      throw new Error("Substack inline audio tag contained repeated src attributes");
    }
    source = boundedString(
      attributeValue,
      "Substack inline audio src",
      2_048,
    );
  }
  return source;
}

function normalizedInlineAudioEmbed(
  source: string,
  publicationBaseUrl: URL,
): SubstackInlineAudioEmbed {
  let path = source;
  if (!source.startsWith("/")) {
    let absolute: URL;
    try {
      absolute = new URL(source);
    } catch {
      throw new Error("Substack inline audio src must be an exact publication URL or path");
    }
    if (
      absolute.protocol !== "https:"
      || absolute.username !== ""
      || absolute.password !== ""
      || absolute.origin !== publicationBaseUrl.origin
      || absolute.search !== ""
      || absolute.hash !== ""
      || absolute.href !== source
    ) {
      throw new Error("Substack inline audio src must use the exact publication origin");
    }
    path = absolute.pathname;
  }
  const match = INLINE_AUDIO_UPLOAD_PATH.exec(path);
  if (match?.[1] === undefined) {
    throw new Error("Substack inline audio src must use the exact audio upload route");
  }
  return Object.freeze({
    uploadId: match[1],
    url: new URL(path, publicationBaseUrl.origin).href,
  });
}

/** Project only exact first-party inline audio upload elements in document order. */
export function parseSubstackInlineAudioEmbeds(
  bodyHtml: unknown,
  publicationBaseUrl: unknown,
): readonly SubstackInlineAudioEmbed[] {
  const html = boundedString(
    bodyHtml,
    "Substack inline audio body_html",
    MAX_BODY_BYTES,
    true,
  );
  let publication: URL | null = null;
  const embeds: SubstackInlineAudioEmbed[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const commentEnd = html.indexOf("-->", start + 4);
      if (commentEnd < 0) {
        throw new Error("Substack inline audio body_html contained an unterminated comment");
      }
      cursor = commentEnd + 3;
      continue;
    }
    if (
      !asciiCaseEqualAt(html, start + 1, "audio")
      || !isTagBoundary(html[start + 6])
    ) {
      cursor = start + 1;
      continue;
    }
    const tagEnd = inlineAudioTagEnd(html, start);
    const source = inlineAudioSrcAttribute(html.slice(start, tagEnd + 1));
    cursor = tagEnd + 1;
    if (source === null) continue;
    if (embeds.length >= MAX_INLINE_AUDIO_EMBEDS) {
      throw new Error(`Substack inline audio embeds exceeded ${String(MAX_INLINE_AUDIO_EMBEDS)} items`);
    }
    if (publication === null) {
      const base = exactHttpsUrl(
        publicationBaseUrl,
        "Substack inline audio publication base_url",
        2_048,
      );
      if (base === null) {
        throw new Error("Substack inline audio publication base_url is required");
      }
      publication = new URL(base);
    }
    embeds.push(normalizedInlineAudioEmbed(source, publication));
  }
  return Object.freeze(embeds);
}

function exactOrigin(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error(`${label} must be an exact credential-free HTTPS origin`);
  return parsed.origin;
}

function exactSubstackUrl(value: string | URL, label: string): URL {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    parsed.origin !== SUBSTACK_ORIGIN
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) throw new Error(`${label} must use the exact ${SUBSTACK_ORIGIN} origin`);
  return parsed;
}

function exactSubstackPublicationUrl(
  value: string | URL,
  organizationValue: unknown,
  publicationOriginValue: unknown,
): URL {
  const organization = canonicalSubstackProfileHandle(
    organizationValue,
    "Substack publication organization",
  );
  const publicationOrigin = exactOrigin(
    publicationOriginValue,
    "Substack publication origin",
  );
  if (publicationOrigin !== `https://${organization}.substack.com`) {
    throw new Error("Substack publication origin did not bind the requested organization");
  }
  let parsed: URL;
  try {
    parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error("Substack publication read URL must be an absolute URL");
  }
  if (
    parsed.origin !== publicationOrigin
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) throw new Error("Substack publication read URL changed its exact owned origin");
  return parsed;
}

function exactQuery(value: URLSearchParams, label: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [name, item] of value) {
    if (
      result.has(name)
      || name.length < 1
      || name.length > 64
      || item.length > 4_096
      || /[\0\r\n]/u.test(name + item)
    ) throw new Error(`${label} contained an invalid or repeated parameter`);
    result.set(name, item);
  }
  return result;
}

function exactQueryNames(
  query: ReadonlyMap<string, string>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((name) => !query.has(name));
  const extra = [...query.keys()].filter((name) => !allowed.has(name));
  if (missing.length > 0) throw new Error(`${label} omitted ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`${label} contained unsupported ${extra.join(", ")}`);
}

function decimalPathId(value: string, label: string): number {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) throw new Error(`${label} must be a decimal ID`);
  return integerId(Number(value), label);
}

function boundedCursor(value: string | undefined, label: string): void {
  if (value === undefined) return;
  boundedString(value, label, 4_096);
}

export type SubstackWebReadRequestOperation =
  | "viewer.logged-in"
  | "viewer.root"
  | "feeds.reader"
  | "feeds.inbox"
  | "feeds.posts"
  | "posts.note"
  | "articles.read"
  | "comments.read"
  | "media.read"
  | "messages.list"
  | "profiles.read"
  | "organizations.read";

export type SubstackWebReadRequestBinding = Readonly<{
  operation: SubstackWebReadRequestOperation;
  method: "GET";
  path: string;
  queryNames: readonly string[];
}>;

export function authorizeSubstackWebReadRequest(input: {
  readonly operation: SubstackWebReadRequestOperation;
  readonly url: string | URL;
  readonly method: string;
  readonly body?: unknown;
  readonly targetId?: number;
  readonly publicationId?: number;
  readonly folder?: "all" | "people" | "unread";
  readonly profile?: string;
  readonly organization?: string;
  readonly publicationOrigin?: string;
}): SubstackWebReadRequestBinding {
  if (input.method.toUpperCase() !== "GET" || input.body !== undefined) {
    throw new Error("Substack authenticated reads require body-free GET");
  }
  const url = input.operation === "organizations.read"
    ? exactSubstackPublicationUrl(
        input.url,
        input.organization,
        input.publicationOrigin,
      )
    : exactSubstackUrl(input.url, "Substack read URL");
  const query = exactQuery(url.searchParams, "Substack read query");

  switch (input.operation) {
    case "viewer.logged-in":
      if (url.pathname !== "/api/v1/am_i_logged_in" || query.size !== 0) {
        throw new Error("Substack login-state request changed its reviewed exchange");
      }
      break;
    case "viewer.root":
      if (url.pathname !== "/" || query.size !== 0) {
        throw new Error("Substack viewer bootstrap request changed its reviewed exchange");
      }
      break;
    case "feeds.reader":
      if (url.pathname !== "/api/v1/reader/feed" || query.size !== 0) {
        throw new Error("Substack reader feed request changed its reviewed exchange");
      }
      break;
    case "feeds.inbox":
      if (url.pathname !== "/api/v1/inbox/top" || query.size !== 0) {
        throw new Error("Substack inbox feed request changed its reviewed exchange");
      }
      break;
    case "feeds.posts":
      if (url.pathname !== "/api/v1/reader/posts" || query.size !== 0) {
        throw new Error("Substack reader posts request changed its reviewed exchange");
      }
      break;
    case "posts.note": {
      const match = /^\/api\/v1\/reader\/comment\/([1-9][0-9]{0,15})$/u.exec(url.pathname);
      const target = integerId(input.targetId, "Substack requested Note ID");
      if (
        match === null
        || decimalPathId(match[1]!, "Substack Note path ID") !== target
        || query.size !== 0
      ) throw new Error("Substack Note request did not bind the requested entity");
      break;
    }
    case "articles.read":
    case "media.read": {
      const match = /^\/api\/v1\/posts\/by-id\/([1-9][0-9]{0,15})$/u.exec(url.pathname);
      const target = integerId(input.targetId, "Substack requested article ID");
      if (
        match === null
        || decimalPathId(match[1]!, "Substack article path ID") !== target
        || query.size !== 0
      ) throw new Error("Substack article request did not bind the requested entity");
      break;
    }
    case "comments.read": {
      const match = /^\/api\/v1\/reader\/post\/([1-9][0-9]{0,15})\/replies$/u.exec(url.pathname);
      const target = integerId(input.targetId, "Substack requested article ID");
      const publication = integerId(input.publicationId, "Substack requested publication ID");
      if (
        match === null
        || decimalPathId(match[1]!, "Substack replies path ID") !== target
      ) throw new Error("Substack replies request did not bind the requested article");
      exactQueryNames(query, ["publication_id"], ["cursor"], "Substack replies query");
      if (query.get("publication_id") !== String(publication)) {
        throw new Error("Substack replies request did not bind the requested publication");
      }
      boundedCursor(query.get("cursor"), "Substack replies cursor");
      break;
    }
    case "messages.list": {
      if (url.pathname !== "/api/v1/messages/inbox") {
        throw new Error("Substack message listing path is not reviewed");
      }
      exactQueryNames(query, ["tab"], ["cursor"], "Substack message listing query");
      const folder = input.folder;
      if (
        folder === undefined
        || !["all", "people", "unread"].includes(folder)
        || query.get("tab") !== folder
      ) throw new Error("Substack message listing did not bind the requested folder");
      boundedCursor(query.get("cursor"), "Substack message cursor");
      break;
    }
    case "profiles.read": {
      const profile = canonicalSubstackProfileHandle(
        input.profile,
        "Substack requested profile",
      );
      if (
        url.pathname !== `/api/v1/user/${profile}/public_profile`
        || query.size !== 0
      ) throw new Error("Substack profile request did not bind the requested handle");
      break;
    }
    case "organizations.read":
      if (
        url.pathname !== "/api/v1/publish-dashboard/summary"
        || query.size !== 0
      ) throw new Error("Substack publication summary request changed its reviewed exchange");
      break;
  }

  return Object.freeze({
    operation: input.operation,
    method: "GET",
    path: url.pathname,
    queryNames: Object.freeze([...query.keys()].sort()),
  });
}

export type SubstackWebViewer = Readonly<{
  id: number;
  handle: string | null;
  name: string | null;
  publications: readonly Readonly<{
    id: number;
    origin: string;
    primaryUserId: number | null;
    canPostNotesAsPrimaryUser: boolean;
    isPublicationPrimaryUser: boolean;
  }>[];
}>;

export function parseSubstackLoggedInResponse(value: unknown): void {
  const source = record(value, "Substack login-state response");
  if (source.loggedIn !== true) throw new Error("Substack browser session is not signed in");
}

function parseJsonStringLiteral(html: string, start: number): {
  readonly decoded: string;
  readonly end: number;
} {
  const quote = html[start];
  if (quote !== "\"") throw new Error("Substack preload must use a JSON string literal");
  let escaped = false;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== quote) continue;
    try {
      const decoded = JSON.parse(html.slice(start, index + 1)) as unknown;
      if (typeof decoded !== "string") throw new Error("not a string");
      return { decoded, end: index + 1 };
    } catch {
      throw new Error("Substack preload contained malformed JSON string encoding");
    }
  }
  throw new Error("Substack preload string was unterminated");
}

function publicationBinding(value: unknown, label: string): SubstackWebViewer["publications"][number] {
  const source = record(value, label);
  const baseUrl = source.base_url ?? source.baseUrl;
  let origin: string;
  if (baseUrl !== undefined && baseUrl !== null) {
    origin = exactOrigin(baseUrl, `${label}.base_url`);
  } else {
    const subdomain = boundedString(source.subdomain, `${label}.subdomain`, 63);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)) {
      throw new Error(`${label}.subdomain is not a reviewed Substack subdomain`);
    }
    origin = `https://${subdomain}.substack.com`;
  }
  return Object.freeze({
    id: integerId(source.id, `${label}.id`),
    origin,
    primaryUserId: optionalIntegerId(source.primary_user_id, `${label}.primary_user_id`),
    canPostNotesAsPrimaryUser: source.can_post_notes_as_primary_user === true,
    isPublicationPrimaryUser: source.is_publication_primary_user === true,
  });
}

export function parseSubstackPreloadsHtml(html: unknown): SubstackWebViewer {
  const source = boundedString(html, "Substack viewer bootstrap", MAX_HTML_BYTES);
  const assignments = [...source.matchAll(/window\._preloads\s*=/gu)];
  if (assignments.length !== 1) {
    throw new Error("Substack viewer bootstrap must contain exactly one preload assignment");
  }
  const markerIndex = assignments[0]!.index;
  const marker = assignments[0]![0];
  const parseIndex = source.indexOf("JSON.parse(", markerIndex + marker.length);
  if (parseIndex < 0 || parseIndex - markerIndex > 128) {
    throw new Error("Substack viewer bootstrap omitted its strict preload JSON");
  }
  const literalStart = parseIndex + "JSON.parse(".length;
  const literal = parseJsonStringLiteral(source, literalStart);
  const close = source.slice(literal.end, literal.end + 8);
  if (!/^\s*\)/u.test(close)) throw new Error("Substack preload JSON call was malformed");
  let preloads: unknown;
  try {
    preloads = JSON.parse(literal.decoded) as unknown;
  } catch {
    throw new Error("Substack preload payload was not strict JSON");
  }
  const root = record(preloads, "Substack preloads");
  const user = record(root.user, "Substack preloads.user");
  const publications = boundedArray(
    user.dashboard_pubs ?? [],
    "Substack preloads.user.dashboard_pubs",
    200,
  ).map((publication, index) => publicationBinding(
    publication,
    `Substack preloads.user.dashboard_pubs[${index}]`,
  ));
  return Object.freeze({
    id: integerId(user.id, "Substack preloads.user.id"),
    handle: optionalString(user.handle, "Substack preloads.user.handle", 128),
    name: optionalString(user.name, "Substack preloads.user.name", 512),
    publications: Object.freeze(publications),
  });
}

function reactions(value: unknown, label: string): Readonly<Record<string, number>> {
  if (value === undefined || value === null) return Object.freeze({});
  const source = record(value, label);
  if (Object.keys(source).length > 64) throw new Error(`${label} exceeded its key bound`);
  const result: Record<string, number> = {};
  for (const [name, count] of Object.entries(source)) {
    const key = boundedString(name, `${label} key`, 32);
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`${label}.${key} must be a non-negative integer`);
    }
    result[key] = count as number;
  }
  return Object.freeze(result);
}

function projectedPublication(value: unknown, label: string): unknown {
  if (value === undefined || value === null) return null;
  const source = record(value, label);
  return Object.freeze({
    id: integerId(source.id, `${label}.id`),
    name: optionalString(source.name, `${label}.name`, 512),
    subdomain: optionalString(source.subdomain, `${label}.subdomain`, 256),
    hostname: optionalString(source.hostname, `${label}.hostname`, 512),
    baseUrl: exactHttpsUrl(source.base_url, `${label}.base_url`),
    authorId: optionalIntegerId(source.author_id, `${label}.author_id`),
  });
}

function projectedPost(value: unknown, label: string, includeBody: boolean): unknown {
  const source = record(value, label);
  const bodyHtml = includeBody
    ? optionalString(source.body_html, `${label}.body_html`, MAX_BODY_BYTES, )
    : null;
  return Object.freeze({
    id: integerId(source.id, `${label}.id`),
    publicationId: integerId(source.publication_id, `${label}.publication_id`),
    title: optionalString(source.title, `${label}.title`, 4_096),
    subtitle: optionalString(source.subtitle, `${label}.subtitle`, 16_384),
    description: optionalString(source.description, `${label}.description`, 65_536),
    truncatedBodyText: optionalString(
      source.truncated_body_text,
      `${label}.truncated_body_text`,
      262_144,
    ),
    bodyHtml,
    slug: optionalString(source.slug, `${label}.slug`, 1_024),
    type: optionalString(source.type, `${label}.type`, 128),
    audience: optionalString(source.audience, `${label}.audience`, 128),
    postDate: optionalString(source.post_date, `${label}.post_date`, 128),
    canonicalUrl: exactHttpsUrl(source.canonical_url, `${label}.canonical_url`),
    coverImage: exactHttpsUrl(source.cover_image, `${label}.cover_image`),
    podcastUrl: exactHttpsUrl(source.podcast_url, `${label}.podcast_url`),
    reaction: optionalBoolean(source.reaction, `${label}.reaction`),
    reactionCount: optionalFiniteNumber(source.reaction_count, `${label}.reaction_count`),
    reactions: reactions(source.reactions, `${label}.reactions`),
    commentCount: optionalFiniteNumber(source.comment_count, `${label}.comment_count`),
    childCommentCount: optionalFiniteNumber(
      source.child_comment_count,
      `${label}.child_comment_count`,
    ),
    restacks: optionalFiniteNumber(source.restacks, `${label}.restacks`),
    restacked: optionalBoolean(source.restacked, `${label}.restacked`),
    saved: optionalBoolean(source.is_saved, `${label}.is_saved`),
    published: optionalBoolean(source.is_published, `${label}.is_published`),
  });
}

function projectedAttachment(value: unknown, label: string): unknown {
  const source = record(value, label);
  return Object.freeze({
    id: optionalString(
      typeof source.id === "number" ? String(source.id) : source.id,
      `${label}.id`,
      256,
    ),
    type: optionalString(source.type, `${label}.type`, 128),
    url: exactHttpsUrl(source.url, `${label}.url`),
    imageUrl: exactHttpsUrl(source.imageUrl ?? source.image_url, `${label}.imageUrl`),
    videoUrl: exactHttpsUrl(source.videoUrl ?? source.video_url, `${label}.videoUrl`),
    audioUrl: exactHttpsUrl(source.audioUrl ?? source.audio_url, `${label}.audioUrl`),
    altText: optionalString(source.altText ?? source.alt_text, `${label}.altText`, 4_096),
    width: optionalFiniteNumber(source.width ?? source.imageWidth, `${label}.width`),
    height: optionalFiniteNumber(source.height ?? source.imageHeight, `${label}.height`),
  });
}

function projectedComment(value: unknown, label: string): unknown {
  const source = record(value, label);
  const attachments = boundedArray(
    source.attachments ?? [],
    `${label}.attachments`,
    20,
  ).map((attachment, index) => projectedAttachment(
    attachment,
    `${label}.attachments[${index}]`,
  ));
  return Object.freeze({
    id: integerId(source.id, `${label}.id`),
    userId: integerId(source.user_id, `${label}.user_id`),
    publicationId: optionalIntegerId(source.publication_id, `${label}.publication_id`),
    postId: optionalIntegerId(source.post_id, `${label}.post_id`),
    name: optionalString(source.name, `${label}.name`, 512),
    handle: optionalString(source.handle, `${label}.handle`, 128),
    body: boundedString(source.body, `${label}.body`, MAX_BODY_BYTES, true),
    type: optionalString(source.type, `${label}.type`, 128),
    date: optionalString(source.date ?? source.created_at, `${label}.date`, 128),
    editedAt: optionalString(source.edited_at, `${label}.edited_at`, 128),
    ancestorPath: optionalString(source.ancestor_path, `${label}.ancestor_path`, 4_096),
    reaction: optionalBoolean(source.reaction, `${label}.reaction`),
    reactionCount: optionalFiniteNumber(source.reaction_count, `${label}.reaction_count`),
    reactions: reactions(source.reactions, `${label}.reactions`),
    restacks: optionalFiniteNumber(source.restacks, `${label}.restacks`),
    restacked: optionalBoolean(source.restacked, `${label}.restacked`),
    saved: optionalBoolean(source.is_saved, `${label}.is_saved`),
    childrenCount: optionalFiniteNumber(source.children_count, `${label}.children_count`),
    attachments: Object.freeze(attachments),
  });
}

export type SubstackFeedName = "notes" | "inbox" | "reader-posts";

export function normalizeSubstackFeedResponse(
  value: unknown,
  feed: SubstackFeedName,
  limit: number,
): unknown {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS) {
    throw new Error("Substack feed limit is invalid");
  }
  const source = record(value, "Substack feed response");
  if (feed === "notes") {
    const items = boundedArray(source.items, "Substack reader feed items", 200)
      .slice(0, limit)
      .map((item, index) => {
        const entry = record(item, `Substack reader feed items[${index}]`);
        const comment = entry.comment === null || entry.comment === undefined
          ? null
          : projectedComment(entry.comment, `Substack reader feed items[${index}].comment`);
        const post = entry.post === null || entry.post === undefined
          ? null
          : projectedPost(entry.post, `Substack reader feed items[${index}].post`, false);
        if (comment === null && post === null) {
          throw new Error("Substack reader feed item omitted both Note and article entities");
        }
        return Object.freeze({
          entityKey: boundedString(entry.entity_key, `Substack reader feed items[${index}].entity_key`, 512),
          type: boundedString(entry.type, `Substack reader feed items[${index}].type`, 128),
          comment,
          post,
          publication: projectedPublication(
            entry.publication,
            `Substack reader feed items[${index}].publication`,
          ),
          canReply: optionalBoolean(entry.canReply, `Substack reader feed items[${index}].canReply`),
        });
      });
    return Object.freeze({
      feed,
      items: Object.freeze(items),
      nextCursor: optionalString(source.nextCursor, "Substack reader feed nextCursor", 4_096),
    });
  }

  const posts = boundedArray(source.posts, "Substack article feed posts", 200)
    .slice(0, limit)
    .map((post, index) => projectedPost(
      post,
      `Substack article feed posts[${index}]`,
      false,
    ));
  return Object.freeze({
    feed,
    items: Object.freeze(posts),
    nextCursor: optionalString(
      source.cursor ?? source.nextCursor,
      "Substack article feed cursor",
      4_096,
    ),
    more: optionalBoolean(source.more, "Substack article feed more"),
  });
}

export function normalizeSubstackArticleResponse(
  value: unknown,
  articleId: number,
): unknown {
  const source = record(value, "Substack article response");
  const postSource = record(source.post, "Substack article response.post");
  if (integerId(postSource.id, "Substack article response.post.id") !== articleId) {
    throw new Error("Substack article response did not bind the requested article");
  }
  const post = projectedPost(postSource, "Substack article response.post", true);
  const publication = projectedPublication(
    source.publication,
    "Substack article response.publication",
  );
  if (
    isRecord(publication)
    && publication.id !== (post as { readonly publicationId: number }).publicationId
  ) throw new Error("Substack article response publication did not bind the article");
  return Object.freeze({ post, publication });
}

export function normalizeSubstackNoteResponse(value: unknown, noteId: number): unknown {
  const source = record(value, "Substack Note response");
  const item = record(source.item, "Substack Note response.item");
  const commentSource = record(item.comment, "Substack Note response.item.comment");
  if (integerId(commentSource.id, "Substack Note response.item.comment.id") !== noteId) {
    throw new Error("Substack Note response did not bind the requested entity");
  }
  return Object.freeze({
    entityKey: optionalString(item.entity_key, "Substack Note response.item.entity_key", 512),
    type: optionalString(item.type, "Substack Note response.item.type", 128),
    comment: projectedComment(commentSource, "Substack Note response.item.comment"),
    post: item.post === null || item.post === undefined
      ? null
      : projectedPost(item.post, "Substack Note response.item.post", false),
    publication: projectedPublication(
      item.publication,
      "Substack Note response.item.publication",
    ),
  });
}

export function normalizeSubstackCommentsResponse(
  value: unknown,
  postId: number,
  limit: number,
): unknown {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS) {
    throw new Error("Substack comment limit is invalid");
  }
  const source = record(value, "Substack replies response");
  const branches = boundedArray(
    source.commentBranches,
    "Substack replies response.commentBranches",
    MAX_ITEMS,
  );
  const comments: unknown[] = [];
  for (let branchIndex = 0; branchIndex < branches.length; branchIndex += 1) {
    const branch = record(
      branches[branchIndex],
      `Substack replies response.commentBranches[${branchIndex}]`,
    );
    const root = record(
      branch.comment,
      `Substack replies response.commentBranches[${branchIndex}].comment`,
    );
    if (integerId(root.post_id, "Substack reply post_id") !== postId) {
      throw new Error("Substack replies response contained a comment for another article");
    }
    comments.push(projectedComment(
      root,
      `Substack replies response.commentBranches[${branchIndex}].comment`,
    ));
    for (const [descendantIndex, descendant] of boundedArray(
      branch.descendantComments ?? [],
      `Substack replies response.commentBranches[${branchIndex}].descendantComments`,
      MAX_ITEMS,
    ).entries()) {
      const wrapper = record(
        descendant,
        `Substack replies response.commentBranches[${branchIndex}].descendantComments[${descendantIndex}]`,
      );
      const comment = record(
        wrapper.comment,
        `Substack replies response.commentBranches[${branchIndex}].descendantComments[${descendantIndex}].comment`,
      );
      if (integerId(comment.post_id, "Substack descendant reply post_id") !== postId) {
        throw new Error("Substack replies response contained a descendant for another article");
      }
      comments.push(projectedComment(
        comment,
        `Substack replies response.commentBranches[${branchIndex}].descendantComments[${descendantIndex}].comment`,
      ));
      if (comments.length >= limit) break;
    }
    if (comments.length >= limit) break;
  }
  return Object.freeze({
    postId,
    comments: Object.freeze(comments.slice(0, limit)),
    nextCursor: optionalString(source.nextCursor, "Substack replies nextCursor", 4_096),
    moreBranches: optionalFiniteNumber(source.moreBranches, "Substack replies moreBranches"),
  });
}

export function normalizeSubstackMediaResponse(value: unknown, articleId: number): unknown {
  const article = normalizeSubstackArticleResponse(value, articleId) as {
    readonly post: Readonly<{
      readonly bodyHtml: string | null;
      readonly coverImage: string | null;
      readonly podcastUrl: string | null;
    }>;
    readonly publication: Readonly<{ readonly baseUrl: string | null }> | null;
  };
  const source = record(record(value, "Substack media response").post, "Substack media response.post");
  const audioItems = boundedArray(source.audio_items ?? [], "Substack article audio_items", 20)
    .map((item, index) => {
      const audio = record(item, `Substack article audio_items[${index}]`);
      return Object.freeze({
        id: optionalString(
          typeof audio.id === "number" ? String(audio.id) : audio.id,
          `Substack article audio_items[${index}].id`,
          256,
        ),
        url: exactHttpsUrl(
          audio.audio_url ?? audio.url,
          `Substack article audio_items[${index}].url`,
        ),
        duration: optionalFiniteNumber(
          audio.duration ?? audio.audio_duration,
          `Substack article audio_items[${index}].duration`,
        ),
      });
    });
  const inlineAudioEmbeds = article.post.bodyHtml === null
    ? Object.freeze([])
    : parseSubstackInlineAudioEmbeds(
        article.post.bodyHtml,
        article.publication?.baseUrl,
      );
  return Object.freeze({
    articleId,
    publication: article.publication,
    coverImage: article.post.coverImage ?? null,
    podcastUrl: article.post.podcastUrl ?? null,
    videoUploadId: optionalString(
      typeof source.video_upload_id === "number"
        ? String(source.video_upload_id)
        : source.video_upload_id,
      "Substack article video_upload_id",
      256,
    ),
    audioItems: Object.freeze(audioItems),
    inlineAudioEmbeds,
  });
}

function projectedMessageThread(value: unknown, label: string): unknown {
  const source = record(value, label);
  const rawId = typeof source.id === "number" ? String(source.id) : source.id;
  return Object.freeze({
    id: boundedString(rawId, `${label}.id`, 512),
    type: boundedString(source.type, `${label}.type`, 128),
    title: optionalString(source.title, `${label}.title`, 2_048),
    subtitle: optionalString(source.subtitleBody, `${label}.subtitleBody`, 16_384),
    timestamp: optionalString(source.timestamp, `${label}.timestamp`, 128),
    lastViewedAt: optionalString(source.lastViewedAt, `${label}.lastViewedAt`, 128),
    user: source.user === null || source.user === undefined
      ? null
      : (() => {
          const user = record(source.user, `${label}.user`);
          return Object.freeze({
            id: integerId(user.id, `${label}.user.id`),
            name: optionalString(user.name, `${label}.user.name`, 512),
            handle: optionalString(user.handle, `${label}.user.handle`, 128),
          });
        })(),
    publication: projectedPublication(source.publication, `${label}.publication`),
  });
}

export function normalizeSubstackMessageInbox(
  value: unknown,
  folder: "all" | "people" | "unread",
  limit: number,
): unknown {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS) {
    throw new Error("Substack message limit is invalid");
  }
  const source = record(value, "Substack message inbox response");
  const threads = boundedArray(source.threads, "Substack message inbox threads", 200)
    .slice(0, limit)
    .map((thread, index) => projectedMessageThread(
      thread,
      `Substack message inbox threads[${index}]`,
    ));
  return Object.freeze({
    folder,
    threads: Object.freeze(threads),
    nextCursor: optionalString(source.nextCursor, "Substack message nextCursor", 4_096),
    more: optionalBoolean(source.more, "Substack message more"),
    pendingInviteCount: optionalFiniteNumber(
      source.pendingInviteCount,
      "Substack pendingInviteCount",
    ),
    directMessagesUnreadCount: optionalFiniteNumber(
      source.directMessagesUnreadCount,
      "Substack directMessagesUnreadCount",
    ),
    pubChatUnreadCount: optionalFiniteNumber(
      source.pubChatUnreadCount,
      "Substack pubChatUnreadCount",
    ),
  });
}

/**
 * Secret-free evidence about current exact first-party exchanges. Values,
 * cookies, user content, tokens, and publication hostnames are never retained.
 */
export const substackWebEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  observedOn: "2026-07-23",
  centralOrigin: SUBSTACK_ORIGIN,
  authentication: "browser-cookie-session" as const,
  liveDirectReads: Object.freeze([
    "GET /api/v1/am_i_logged_in",
    "GET /",
    "GET /api/v1/reader/feed",
    "GET /api/v1/inbox/top",
    "GET /api/v1/reader/posts",
    "GET /api/v1/reader/comment/{note-id}",
    "GET /api/v1/posts/by-id/{post-id}",
    "GET /api/v1/reader/post/{post-id}/replies?publication_id={publication-id}",
    "GET /api/v1/messages/inbox?tab={all|people|unread}",
  ]),
  currentBundleOnly: Object.freeze({
    dmRead: "GET /api/v1/messages/dm/{thread-id}",
    dmStart: "POST /api/v1/messages/dm/start",
    dmSend: "POST /api/v1/messages/dm/{thread-id}",
    postReaction: "POST|DELETE /api/v1/post/{post-id}/reaction",
    commentReaction: "POST|DELETE /api/v1/comment/{comment-id}/reaction",
    postSave: "POST|DELETE /api/v1/posts/saved",
    noteSave: "POST|DELETE /api/v1/note/{entity-key}/save",
    restack: "POST /api/v1/restack/feed",
  }),
});
