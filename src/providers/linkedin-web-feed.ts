import {
  LINKEDIN_GRAPHQL_PATH,
  linkedInPersonalProfilePublicIdentifier,
  normalizeLinkedInGraphqlEnvelope,
  resolveLinkedInRegisteredQueryId,
  type LinkedInWebJsonRecord,
} from "./linkedin-web";

export { LINKEDIN_GRAPHQL_PATH };

export const LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX = "voyagerFeedDashProfileUpdates";
export const LINKEDIN_PROFILE_ACTIVITY_CURSOR_PREFIX = "linkedin-profile-activity-v1";
export const LINKEDIN_PROFILE_ACTIVITY_MAX_ITEMS = 100;
export const LINKEDIN_PROFILE_ACTIVITY_MAX_START = 100_000;

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const ACTIVITY_URN = /urn:li:activity:([0-9]{10,20})/u;
const PROFILE_URN = /^urn:li:fsd_profile:[A-Za-z0-9_-]{1,256}$/u;
const POST_URN = /^urn:li:(?:ugcPost|share|fsd_share):[A-Za-z0-9_(),.:%=-]{1,448}$/u;
const UPDATE_TYPE = "com.linkedin.voyager.dash.feed.Update";
const SOCIAL_COUNTS_TYPE = "com.linkedin.voyager.dash.feed.SocialActivityCounts";
const COLLECTION_TYPE = "com.linkedin.restli.common.CollectionResponse";
const MEDIA_FIELD_NAMES = Object.freeze([
  "articleComponent",
  "content",
  "contentV2",
  "documentComponent",
  "imageComponent",
  "linkedInVideoComponent",
  "videoComponent",
] as const);

export type LinkedInProfileActivityFeed = "home" | "profile-activity";

export type LinkedInProfileActivityTarget = {
  readonly slug: string;
  readonly profileUrl: string;
  readonly activityUrl: string;
};

export type LinkedInProfileActivityCursor = {
  readonly slug: string;
  readonly start: number;
};

export type LinkedInProfileActivityPostKind = "original" | "reshare";

export type LinkedInProfileActivityPost = {
  readonly activityUrn: string;
  readonly postUrn: string | null;
  readonly url: string;
  readonly authorVanity: string | null;
  readonly authorUrn: string | null;
  readonly text: string;
  readonly textComplete: boolean;
  readonly createdAt: string | null;
  readonly relativeTime: string | null;
  readonly reactionCount: number | null;
  readonly commentCount: number | null;
  readonly repostCount: number | null;
  readonly hasMedia: boolean;
  readonly kind: LinkedInProfileActivityPostKind;
};

export type LinkedInProfileActivityPage = {
  readonly schemaVersion: 1;
  readonly provider: "linkedin";
  readonly feed: "profile-activity";
  readonly profile: {
    readonly vanity: string;
    readonly profileUrn: string;
    readonly url: string;
  };
  readonly observedAt: string;
  readonly posts: readonly LinkedInProfileActivityPost[];
  readonly items: readonly {
    readonly activity_urn: string;
    readonly url: string;
  }[];
  readonly nextCursor: string | null;
  readonly complete: boolean;
};

export type LinkedInProfileActivityBinding = {
  readonly queryId: string;
  readonly profileUrn: string;
};

function isRecord(value: unknown): value is LinkedInWebJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): LinkedInWebJsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be a bounded string`);
  return value;
}

function optionalBoundedText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(value, label, maximum);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalNonnegativeInteger(
  value: unknown,
  label: string,
): number | null {
  if (value === null || value === undefined) return null;
  return nonnegativeInteger(value, label);
}

export function linkedInProfileActivityFeed(value: unknown): LinkedInProfileActivityFeed {
  if (value !== "home" && value !== "profile-activity") {
    throw new Error("LinkedIn feed must be home or profile-activity");
  }
  return value;
}

export function linkedInProfileActivityTarget(input: {
  readonly profile_url?: unknown;
  readonly vanity?: unknown;
}): LinkedInProfileActivityTarget {
  const fromUrl = input.profile_url === undefined
    ? null
    : linkedInProfileActivityTargetFromUrl(input.profile_url);
  const fromVanity = input.vanity === undefined
    ? null
    : linkedInProfileActivityTargetFromVanity(input.vanity);
  if (fromUrl === null && fromVanity === null) {
    throw new Error("LinkedIn profile-activity feed requires profile_url or vanity");
  }
  if (fromUrl !== null && fromVanity !== null && fromUrl.slug !== fromVanity.slug) {
    throw new Error("LinkedIn profile_url and vanity named different profiles");
  }
  return fromUrl ?? fromVanity!;
}

export function linkedInProfileActivityTargetFromVanity(
  value: unknown,
): LinkedInProfileActivityTarget {
  const slug = linkedInPersonalProfilePublicIdentifier(value);
  return Object.freeze({
    slug,
    profileUrl: `${LINKEDIN_ORIGIN}/in/${slug}/`,
    activityUrl: `${LINKEDIN_ORIGIN}/in/${slug}/recent-activity/all/`,
  });
}

export function linkedInProfileActivityTargetFromUrl(
  value: unknown,
): LinkedInProfileActivityTarget {
  const raw = boundedText(value, "LinkedIn profile activity URL", 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("LinkedIn profile activity URL must be an absolute URL");
  }
  if (
    url.origin !== LINKEDIN_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("LinkedIn profile activity URL must use the exact public LinkedIn origin");
  const match = /^\/in\/([A-Za-z0-9][A-Za-z0-9_-]{1,99})(?:\/recent-activity(?:\/all)?)?\/?$/u
    .exec(url.pathname);
  if (match?.[1] === undefined) {
    throw new Error("LinkedIn profile activity URL has an unsupported path");
  }
  return linkedInProfileActivityTargetFromVanity(match[1]);
}

export function linkedInProfileActivityProfileUrn(value: unknown): string {
  const urn = boundedText(value, "LinkedIn profile activity profile URN", 512);
  if (!PROFILE_URN.test(urn)) {
    throw new Error("LinkedIn profile activity profile URN is invalid");
  }
  return urn;
}

export function linkedInProfileActivityQueryId(value: unknown): string {
  return resolveLinkedInRegisteredQueryId(
    LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX,
    [value],
  );
}

export function encodeLinkedInProfileActivityCursor(
  cursor: LinkedInProfileActivityCursor,
): string {
  const slug = linkedInPersonalProfilePublicIdentifier(cursor.slug);
  const start = nonnegativeInteger(cursor.start, "LinkedIn profile-activity cursor start");
  if (start > LINKEDIN_PROFILE_ACTIVITY_MAX_START) {
    throw new Error("LinkedIn profile-activity cursor start exceeded its reviewed bound");
  }
  return `${LINKEDIN_PROFILE_ACTIVITY_CURSOR_PREFIX}:${slug}:${start}`;
}

export function parseLinkedInProfileActivityCursor(
  value: unknown,
  expectedSlug: string,
): LinkedInProfileActivityCursor {
  if (value === undefined) {
    return Object.freeze({
      slug: linkedInPersonalProfilePublicIdentifier(expectedSlug),
      start: 0,
    });
  }
  const raw = boundedText(value, "LinkedIn profile-activity cursor", 4_096);
  const match = new RegExp(
    `^${LINKEDIN_PROFILE_ACTIVITY_CURSOR_PREFIX}:([A-Za-z0-9][A-Za-z0-9_-]{1,99}):(0|[1-9][0-9]{0,6})$`,
    "u",
  ).exec(raw);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("LinkedIn profile-activity cursor is invalid");
  }
  const slug = linkedInPersonalProfilePublicIdentifier(match[1]);
  const expected = linkedInPersonalProfilePublicIdentifier(expectedSlug);
  if (slug !== expected) {
    throw new Error("LinkedIn profile-activity cursor does not match the requested profile");
  }
  const start = nonnegativeInteger(Number(match[2]), "LinkedIn profile-activity cursor start");
  if (start > LINKEDIN_PROFILE_ACTIVITY_MAX_START) {
    throw new Error("LinkedIn profile-activity cursor start exceeded its reviewed bound");
  }
  return Object.freeze({ slug, start });
}

export function linkedInProfileActivityPageUrl(input: {
  readonly queryId: unknown;
  readonly profileUrn: unknown;
  readonly count: number;
  readonly start: number;
}): URL {
  const queryId = linkedInProfileActivityQueryId(input.queryId);
  const profileUrn = linkedInProfileActivityProfileUrn(input.profileUrn);
  const count = nonnegativeInteger(input.count, "LinkedIn profile-activity count");
  const start = nonnegativeInteger(input.start, "LinkedIn profile-activity start");
  if (count < 1 || count > LINKEDIN_PROFILE_ACTIVITY_MAX_ITEMS) {
    throw new Error("LinkedIn profile-activity count must be an integer between 1 and 100");
  }
  if (start > LINKEDIN_PROFILE_ACTIVITY_MAX_START) {
    throw new Error("LinkedIn profile-activity start exceeded its reviewed bound");
  }
  const url = new URL(LINKEDIN_GRAPHQL_PATH, LINKEDIN_ORIGIN);
  url.searchParams.set("includeWebMetadata", "true");
  url.searchParams.set("queryId", queryId);
  url.searchParams.set(
    "variables",
    `(count:${count},profileUrn:${profileUrn},start:${start})`,
  );
  return url;
}

export function assertLinkedInProfileActivityRequest(
  requestValue: {
    readonly url: string | URL;
    readonly method: string;
  },
  expected: {
    readonly queryId: unknown;
    readonly profileUrn: unknown;
    readonly count: number;
    readonly start: number;
  },
): URL {
  const url = requestValue.url instanceof URL
    ? new URL(requestValue.url.href)
    : new URL(requestValue.url);
  if (
    requestValue.method !== "GET"
    || url.origin !== LINKEDIN_ORIGIN
    || url.pathname !== LINKEDIN_GRAPHQL_PATH
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error("LinkedIn profile-activity request escaped its exact reviewed route");
  const queryNames = [...url.searchParams.keys()];
  if (
    queryNames.length !== 3
    || queryNames[0] !== "includeWebMetadata"
    || queryNames[1] !== "queryId"
    || queryNames[2] !== "variables"
    || url.searchParams.getAll("includeWebMetadata").length !== 1
    || url.searchParams.getAll("queryId").length !== 1
    || url.searchParams.getAll("variables").length !== 1
  ) throw new Error("LinkedIn profile-activity request query shape is invalid");
  const expectedUrl = linkedInProfileActivityPageUrl(expected);
  if (
    url.searchParams.get("includeWebMetadata") !== expectedUrl.searchParams.get("includeWebMetadata")
    || url.searchParams.get("queryId") !== expectedUrl.searchParams.get("queryId")
    || url.searchParams.get("variables") !== expectedUrl.searchParams.get("variables")
  ) throw new Error("LinkedIn profile-activity request binding changed");
  return url;
}

export function linkedInProfileActivityVariables(
  value: unknown,
): { readonly profileUrn: string; readonly count: number | null; readonly start: number | null } {
  const raw = boundedText(value, "LinkedIn profile-activity variables", 4_096);
  const match = /^\((.*)\)$/u.exec(raw);
  if (match?.[1] === undefined) {
    throw new Error("LinkedIn profile-activity variables must be a Rest.li tuple");
  }
  const fields = new Map<string, string>();
  for (const part of match[1].split(",")) {
    const separator = part.indexOf(":");
    if (separator < 1) throw new Error("LinkedIn profile-activity variables field is malformed");
    const key = part.slice(0, separator);
    const fieldValue = part.slice(separator + 1);
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key) || fieldValue.length < 1) {
      throw new Error("LinkedIn profile-activity variables field is malformed");
    }
    if (fields.has(key)) throw new Error("LinkedIn profile-activity variables repeated a field");
    fields.set(key, fieldValue);
  }
  const profileUrn = linkedInProfileActivityProfileUrn(fields.get("profileUrn"));
  const count = fields.has("count")
    ? nonnegativeInteger(Number(fields.get("count")), "LinkedIn profile-activity variables count")
    : null;
  const start = fields.has("start")
    ? nonnegativeInteger(Number(fields.get("start")), "LinkedIn profile-activity variables start")
    : null;
  return Object.freeze({ profileUrn, count, start });
}

export function resolveLinkedInProfileActivityBinding(
  candidates: readonly {
    readonly method?: unknown;
    readonly status?: unknown;
    readonly url?: unknown;
  }[],
): LinkedInProfileActivityBinding {
  if (candidates.length > 4_096) {
    throw new Error("LinkedIn profile-activity observation exceeded its reviewed bound");
  }
  const queryIds = new Set<string>();
  const profileUrns = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.method !== "GET" || candidate.status !== 200) continue;
    if (typeof candidate.url !== "string" || candidate.url.length > 64 * 1_024) continue;
    let url: URL;
    try {
      url = new URL(candidate.url);
    } catch {
      continue;
    }
    if (
      url.origin !== LINKEDIN_ORIGIN
      || url.pathname !== LINKEDIN_GRAPHQL_PATH
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) continue;
    const queryId = url.searchParams.get("queryId");
    const variables = url.searchParams.get("variables");
    if (queryId === null || variables === null) continue;
    try {
      queryIds.add(linkedInProfileActivityQueryId(queryId));
      profileUrns.add(linkedInProfileActivityVariables(variables).profileUrn);
    } catch {
      continue;
    }
  }
  if (queryIds.size === 0 || profileUrns.size === 0) {
    throw new Error("LinkedIn registered query voyagerFeedDashProfileUpdates was not found");
  }
  if (queryIds.size !== 1) {
    throw new Error("LinkedIn registered query voyagerFeedDashProfileUpdates is ambiguous");
  }
  if (profileUrns.size !== 1) {
    throw new Error("LinkedIn profile-activity observation bound more than one profile URN");
  }
  return Object.freeze({
    queryId: [...queryIds][0]!,
    profileUrn: [...profileUrns][0]!,
  });
}

function activityUrnFromValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  const match = ACTIVITY_URN.exec(value);
  return match?.[0] ?? null;
}

function uniqueOptionalText(
  values: readonly unknown[],
  label: string,
  maximum: number,
): string | null {
  const unique = [...new Set(
    values
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map((value) => boundedText(value, label, maximum)),
  )];
  if (unique.length === 0) return null;
  if (unique.length !== 1) throw new Error(`${label} was ambiguous`);
  return unique[0]!;
}

function textFromViewModel(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const model = record(value, label);
  if (isRecord(model.text)) {
    return optionalBoundedText(model.text.text, `${label}.text.text`, 12_000);
  }
  return optionalBoundedText(model.text, `${label}.text`, 12_000);
}

function vanityFromNavigation(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value, LINKEDIN_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== LINKEDIN_ORIGIN) return null;
  const match = /^\/in\/([A-Za-z0-9][A-Za-z0-9_-]{1,99})\/?$/u.exec(url.pathname);
  return match?.[1] === undefined
    ? null
    : linkedInPersonalProfilePublicIdentifier(match[1]);
}

function createdAtFromValue(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    const milliseconds = nonnegativeInteger(value, label);
    if (milliseconds < 1_000_000_000_000 || milliseconds > 4_102_444_800_000) {
      throw new Error(`${label} is outside the reviewed timestamp window`);
    }
    return new Date(milliseconds).toISOString();
  }
  const raw = boundedText(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(raw)) {
    throw new Error(`${label} must be an exact UTC timestamp`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an exact UTC timestamp`);
  return new Date(parsed).toISOString();
}

function relativeTimeFromActor(actor: LinkedInWebJsonRecord | null): string | null {
  if (actor === null) return null;
  const fromViewModel = isRecord(actor.subDescription)
    ? textFromViewModel(actor.subDescription, "LinkedIn update actor.subDescription")
    : null;
  const fromText = typeof actor.subDescription === "string"
    ? optionalBoundedText(actor.subDescription, "LinkedIn update actor.subDescription", 64)
    : null;
  const unique = [...new Set(
    [fromViewModel, fromText].filter((value): value is string => value !== null),
  )];
  if (unique.length !== 1) return null;
  const value = unique[0]!;
  return /^(?:[1-9][0-9]?[smhdw]|[1-9][0-9]?mo|now|just now)$/iu.test(value)
    ? value
    : null;
}

function authorUrnFromActor(actor: LinkedInWebJsonRecord | null): string | null {
  if (actor === null) return null;
  for (const field of ["urn", "backendUrn", "entityUrn", "*profile"] as const) {
    const value = actor[field];
    if (typeof value === "string" && PROFILE_URN.test(value)) return value;
  }
  return null;
}

function postUrnFromUpdate(update: LinkedInWebJsonRecord): string | null {
  const metadata = isRecord(update.metadata) ? update.metadata : null;
  const socialDetail = isRecord(update.socialDetail) ? update.socialDetail : null;
  const candidates = [
    metadata?.shareUrn,
    metadata?.backendUrn,
    metadata?.ugcPostUrn,
    socialDetail?.urn,
    update.shareUrn,
    update.ugcPostUrn,
  ];
  const urns = candidates.filter((value): value is string =>
    typeof value === "string" && POST_URN.test(value));
  return uniqueOptionalText(urns, "LinkedIn update post URN", 512);
}

function hasReviewedMedia(update: LinkedInWebJsonRecord): boolean {
  return MEDIA_FIELD_NAMES.some((field) => {
    const value = update[field];
    return value !== undefined && value !== null && value !== false;
  });
}

function commentaryTruncated(commentary: LinkedInWebJsonRecord | null): boolean {
  if (commentary === null) return false;
  if (commentary.truncated === true || commentary.textTruncated === true) return true;
  const attributes = commentary.attributesV2;
  return Array.isArray(attributes) && attributes.some((attribute) => {
    if (!isRecord(attribute)) return false;
    const type = attribute.$type;
    return typeof type === "string" && /seeMore|SeeMore|truncated/iu.test(type);
  });
}

function socialCountsByActivityUrn(
  included: readonly LinkedInWebJsonRecord[],
): ReadonlyMap<string, {
  readonly reactionCount: number | null;
  readonly commentCount: number | null;
  readonly repostCount: number | null;
}> {
  const counts = new Map<string, {
    readonly reactionCount: number | null;
    readonly commentCount: number | null;
    readonly repostCount: number | null;
  }>();
  for (const entity of included) {
    if (entity.$type !== SOCIAL_COUNTS_TYPE) continue;
    const activityUrn = activityUrnFromValue(entity.urn);
    if (activityUrn === null) continue;
    const next = Object.freeze({
      reactionCount: optionalNonnegativeInteger(entity.numLikes, "LinkedIn social numLikes"),
      commentCount: optionalNonnegativeInteger(entity.numComments, "LinkedIn social numComments"),
      repostCount: optionalNonnegativeInteger(entity.numShares, "LinkedIn social numShares"),
    });
    const prior = counts.get(activityUrn);
    if (prior !== undefined) {
      if (
        prior.reactionCount !== next.reactionCount
        || prior.commentCount !== next.commentCount
        || prior.repostCount !== next.repostCount
      ) throw new Error("LinkedIn social activity counts conflict for one activity URN");
      continue;
    }
    counts.set(activityUrn, next);
  }
  return counts;
}

function projectUpdate(
  update: LinkedInWebJsonRecord,
  counts: ReadonlyMap<string, {
    readonly reactionCount: number | null;
    readonly commentCount: number | null;
    readonly repostCount: number | null;
  }>,
): LinkedInProfileActivityPost {
  if (update.$type !== UPDATE_TYPE) {
    throw new Error("LinkedIn profile-activity element is not a feed Update");
  }
  const activityUrn = activityUrnFromValue(update.entityUrn)
    ?? activityUrnFromValue(update.urn)
    ?? activityUrnFromValue(isRecord(update.metadata) ? update.metadata.urn : null);
  if (activityUrn === null) {
    throw new Error("LinkedIn profile-activity update omitted its activity URN");
  }
  const commentary = isRecord(update.commentary) ? update.commentary : null;
  const text = textFromViewModel(commentary, "LinkedIn update commentary") ?? "";
  const actor = isRecord(update.actor) ? update.actor : null;
  const navigation = actor === null
    ? null
    : vanityFromNavigation(
        isRecord(actor.navigationContext)
          ? actor.navigationContext.actionTarget
          : actor.navigationUrl,
      );
  const kind: LinkedInProfileActivityPostKind = update.resharedUpdate === undefined
    || update.resharedUpdate === null
    ? "original"
    : "reshare";
  const engagement = counts.get(activityUrn);
  const createdAt = createdAtFromValue(
    update.publishedAt ?? update.createdAt ?? (isRecord(update.metadata) ? update.metadata.createdAt : null),
    "LinkedIn update createdAt",
  );
  return Object.freeze({
    activityUrn,
    postUrn: postUrnFromUpdate(update),
    url: `${LINKEDIN_ORIGIN}/feed/update/${activityUrn}/`,
    authorVanity: navigation,
    authorUrn: authorUrnFromActor(actor),
    text,
    textComplete: !commentaryTruncated(commentary),
    createdAt,
    relativeTime: relativeTimeFromActor(actor),
    reactionCount: engagement?.reactionCount ?? null,
    commentCount: engagement?.commentCount ?? null,
    repostCount: engagement?.repostCount ?? null,
    hasMedia: hasReviewedMedia(update),
    kind,
  });
}

function collectionResponses(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): readonly LinkedInWebJsonRecord[] {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error("LinkedIn profile-activity data exceeded its reviewed bound");
    return value.flatMap((item) => collectionResponses(item, depth + 1, seen));
  }
  const candidate = record(value, "LinkedIn profile-activity data node");
  const collections: LinkedInWebJsonRecord[] = [];
  if (
    candidate.$type === COLLECTION_TYPE
    && Array.isArray(candidate["*elements"])
  ) collections.push(candidate);
  for (const nested of Object.values(candidate)) {
    collections.push(...collectionResponses(nested, depth + 1, seen));
  }
  return collections;
}

function pagingHasNext(paging: LinkedInWebJsonRecord | null, start: number, count: number): boolean {
  if (paging === null) return true;
  const links = paging.links;
  if (Array.isArray(links)) {
    if (links.length > 16) throw new Error("LinkedIn profile-activity paging links exceeded their bound");
    if (links.some((link) => isRecord(link) && link.rel === "next")) return true;
  }
  const total = optionalNonnegativeInteger(paging.total, "LinkedIn profile-activity paging.total");
  if (total !== null) return start + count < total;
  return false;
}

export function projectLinkedInProfileActivityPage(input: {
  readonly response: unknown;
  readonly target: LinkedInProfileActivityTarget;
  readonly profileUrn: unknown;
  readonly limit: number;
  readonly start: number;
  readonly observedAt: string;
}): LinkedInProfileActivityPage {
  const profileUrn = linkedInProfileActivityProfileUrn(input.profileUrn);
  const limit = nonnegativeInteger(input.limit, "LinkedIn profile-activity limit");
  const start = nonnegativeInteger(input.start, "LinkedIn profile-activity start");
  if (limit < 1 || limit > LINKEDIN_PROFILE_ACTIVITY_MAX_ITEMS) {
    throw new Error("LinkedIn profile-activity limit must be an integer between 1 and 100");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.observedAt)
    || !Number.isFinite(Date.parse(input.observedAt))
  ) throw new Error("LinkedIn profile-activity observedAt must be an exact UTC timestamp");
  const normalized = normalizeLinkedInGraphqlEnvelope(input.response);
  const collections = collectionResponses(normalized.data, 0, new WeakSet<object>());
  if (collections.length !== 1) {
    throw new Error("LinkedIn profile-activity response did not bind one collection");
  }
  const collection = collections[0]!;
  const references = collection["*elements"];
  if (!Array.isArray(references) || references.length > LINKEDIN_PROFILE_ACTIVITY_MAX_ITEMS) {
    throw new Error("LinkedIn profile-activity collection exceeded its reviewed bound");
  }
  if (references.length > limit) {
    throw new Error("LinkedIn profile-activity page exceeded the requested limit");
  }
  const counts = socialCountsByActivityUrn(normalized.included);
  const posts = references.map((reference, index) => {
    const urn = boundedText(reference, `LinkedIn profile-activity elements[${index}]`, 4_096);
    const entity = normalized.entitiesByUrn.get(urn);
    if (entity === undefined) {
      throw new Error("LinkedIn profile-activity response omitted a referenced update");
    }
    return projectUpdate(entity, counts);
  });
  const paging = isRecord(collection.paging) ? collection.paging : null;
  const hasNext = pagingHasNext(paging, start, posts.length) || posts.length === limit;
  const nextCursor = hasNext
    ? encodeLinkedInProfileActivityCursor({
        slug: input.target.slug,
        start: start + posts.length,
      })
    : null;
  return Object.freeze({
    schemaVersion: 1,
    provider: "linkedin",
    feed: "profile-activity",
    profile: Object.freeze({
      vanity: input.target.slug,
      profileUrn,
      url: input.target.profileUrl,
    }),
    observedAt: input.observedAt,
    posts: Object.freeze(posts),
    items: Object.freeze(posts.map((post) => Object.freeze({
      activity_urn: post.activityUrn,
      url: post.url,
    }))),
    nextCursor,
    complete: nextCursor === null,
  });
}

export function linkedInProfileActivityInputIssues(
  input: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues: string[] = [];
  if (input.feed === "home") {
    if (input.profile_url !== undefined) {
      issues.push("input.profile_url is not accepted for the capture-required home feed");
    }
    if (input.vanity !== undefined) {
      issues.push("input.vanity is not accepted for the capture-required home feed");
    }
    return Object.freeze(issues);
  }
  if (input.feed !== "profile-activity") return Object.freeze(issues);
  try {
    linkedInProfileActivityTarget({
      profile_url: input.profile_url,
      vanity: input.vanity,
    });
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "LinkedIn profile-activity target is invalid");
  }
  if (input.cursor !== undefined) {
    try {
      const target = linkedInProfileActivityTarget({
        profile_url: input.profile_url,
        vanity: input.vanity,
      });
      parseLinkedInProfileActivityCursor(input.cursor, target.slug);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "LinkedIn profile-activity cursor is invalid");
    }
  }
  return Object.freeze(issues);
}
