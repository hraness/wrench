/**
 * X consumer-web internal API policy primitives.
 *
 * This module deliberately does not perform requests. It turns current,
 * browser-observed X operations into narrowly reviewed bindings that a
 * browser-session executor can enforce without exporting session material.
 */

export type XWebOperationType = "query" | "mutation";

export type XWebQueryDescriptorKey = {
  readonly operationName: string;
  readonly operationType: XWebOperationType;
  readonly queryId: string;
};

export type XWebBundleQueryDescriptor = XWebQueryDescriptorKey & {
  readonly metadata: {
    readonly featureSwitches: readonly string[];
    readonly fieldToggles: readonly string[];
  };
};

export type XWebQueryDescriptorEvidence = XWebQueryDescriptorKey & {
  readonly sourceChunk: string;
  readonly observedOn?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  const extra = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`${label} omitted ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`${label} contained unsupported field(s): ${extra.join(", ")}`);
}

function requiredString(value: JsonRecord, key: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return candidate;
}

function exactStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a string array`);
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/u.test(item)) {
      throw new Error(`${label}[${index}] must be a feature or field-toggle name`);
    }
    result.push(item);
  }
  if (new Set(result).size !== result.length) throw new Error(`${label} contained duplicates`);
  return Object.freeze(result);
}

function exactQueryId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) {
    throw new Error(`${label} must be an exact X query ID`);
  }
  return value;
}

function exactOperationName(value: string, label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{1,127}$/u.test(value)) {
    throw new Error(`${label} must be an exact X operation name`);
  }
  return value;
}

function exactOperationType(value: unknown, label: string): XWebOperationType {
  if (value !== "query" && value !== "mutation") {
    throw new Error(`${label} must be query or mutation`);
  }
  return value;
}

function parseBundleQueryDescriptor(value: unknown, label: string): XWebBundleQueryDescriptor {
  const descriptor = record(value, label);
  exactKeys(descriptor, ["queryId", "operationName", "operationType", "metadata"], label);
  const metadata = record(descriptor.metadata, `${label}.metadata`);
  exactKeys(metadata, ["featureSwitches", "fieldToggles"], `${label}.metadata`);
  return Object.freeze({
    queryId: exactQueryId(requiredString(descriptor, "queryId", label), `${label}.queryId`),
    operationName: exactOperationName(
      requiredString(descriptor, "operationName", label),
      `${label}.operationName`,
    ),
    operationType: exactOperationType(descriptor.operationType, `${label}.operationType`),
    metadata: Object.freeze({
      featureSwitches: exactStringArray(metadata.featureSwitches, `${label}.metadata.featureSwitches`),
      fieldToggles: exactStringArray(metadata.fieldToggles, `${label}.metadata.fieldToggles`),
    }),
  });
}

function parseDescriptorKey(value: unknown, label: string): XWebQueryDescriptorKey {
  const key = record(value, label);
  const required = ["queryId", "operationName", "operationType"] as const;
  const allowed = new Set([...required, "metadata", "sourceChunk", "observedOn"]);
  const missing = required.filter((name) => !Object.hasOwn(key, name));
  const extra = Object.keys(key).filter((name) => !allowed.has(name));
  if (missing.length > 0) throw new Error(`${label} omitted ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`${label} contained unsupported field(s): ${extra.join(", ")}`);
  if (key.sourceChunk !== undefined && (typeof key.sourceChunk !== "string" || !key.sourceChunk.endsWith(".js"))) {
    throw new Error(`${label}.sourceChunk must be a JavaScript bundle name`);
  }
  if (key.observedOn !== undefined && (typeof key.observedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(key.observedOn))) {
    throw new Error(`${label}.observedOn must be an ISO date`);
  }
  if (key.metadata !== undefined) {
    const metadata = record(key.metadata, `${label}.metadata`);
    exactKeys(metadata, ["featureSwitches", "fieldToggles"], `${label}.metadata`);
    exactStringArray(metadata.featureSwitches, `${label}.metadata.featureSwitches`);
    exactStringArray(metadata.fieldToggles, `${label}.metadata.fieldToggles`);
  }
  return Object.freeze({
    queryId: exactQueryId(requiredString(key, "queryId", label), `${label}.queryId`),
    operationName: exactOperationName(requiredString(key, "operationName", label), `${label}.operationName`),
    operationType: exactOperationType(key.operationType, `${label}.operationType`),
  });
}

export function xWebQueryDescriptorKey(descriptor: XWebQueryDescriptorKey): string {
  return `${descriptor.operationName}:${descriptor.operationType}:${descriptor.queryId}`;
}

/**
 * Resolve one reviewed operation from descriptors parsed out of the current
 * first-party bundle. A changed query ID is drift, not a transparent update.
 */
export function resolveUniqueXWebBundleDescriptor(
  candidates: readonly unknown[],
  expectedValue: unknown,
): XWebBundleQueryDescriptor {
  if (!Array.isArray(candidates)) throw new Error("X bundle descriptors must be an array");
  const expected = parseDescriptorKey(expectedValue, "expected X descriptor");
  const parsed = candidates.map((candidate, index) => (
    parseBundleQueryDescriptor(candidate, `X bundle descriptor ${index + 1}`)
  ));
  const nameMatches = parsed.filter((candidate) => candidate.operationName === expected.operationName);
  if (nameMatches.length === 0) {
    throw new Error(`X bundle omitted operation ${expected.operationName}`);
  }
  const typeMatches = nameMatches.filter((candidate) => candidate.operationType === expected.operationType);
  if (typeMatches.length === 0) {
    const actual = [...new Set(nameMatches.map((candidate) => candidate.operationType))].join(", ");
    throw new Error(
      `X operation-type drift for ${expected.operationName}: expected ${expected.operationType}, observed ${actual}`,
    );
  }
  if (typeMatches.length > 1) {
    const ids = [...new Set(typeMatches.map((candidate) => candidate.queryId))];
    if (ids.length === 1) {
      throw new Error(`X bundle contained duplicate descriptor ${xWebQueryDescriptorKey(typeMatches[0]!)}`);
    }
    throw new Error(
      `X bundle contained ambiguous query-ID drift for ${expected.operationName}:${expected.operationType}`,
    );
  }
  const descriptor = typeMatches[0]!;
  if (descriptor.queryId !== expected.queryId) {
    throw new Error(
      `X query-ID drift for ${expected.operationName}:${expected.operationType}; reviewed evidence is stale`,
    );
  }
  return descriptor;
}

export type XWebOperationMetadataValues = {
  readonly features: Readonly<Record<string, boolean>>;
  readonly fieldToggles: Readonly<Record<string, boolean>>;
};

function exactBooleanMap(
  value: unknown,
  expectedNames: readonly string[],
  label: string,
): Readonly<Record<string, boolean>> {
  const source = record(value, label);
  const expected = new Set(expectedNames);
  const missing = expectedNames.filter((name) => !Object.hasOwn(source, name));
  const extra = Object.keys(source).filter((name) => !expected.has(name));
  if (missing.length > 0) throw new Error(`${label} omitted ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`${label} contained unreviewed key(s): ${extra.join(", ")}`);
  const result: Record<string, boolean> = {};
  for (const name of [...expectedNames].sort()) {
    const item = source[name];
    if (typeof item !== "boolean") throw new Error(`${label}.${name} must be boolean`);
    result[name] = item;
  }
  return Object.freeze(result);
}

/**
 * Bind current feature values to exactly the names declared by this operation's
 * resolved bundle descriptor. Missing, borrowed, or newly introduced keys are
 * drift and cannot be dispatched silently.
 */
export function bindXWebOperationMetadataValues(
  descriptorValue: XWebBundleQueryDescriptor,
  value: unknown,
): XWebOperationMetadataValues {
  const descriptor = parseBundleQueryDescriptor(descriptorValue, "resolved X descriptor");
  const metadataValues = record(value, "X operation metadata values");
  exactKeys(metadataValues, ["features", "fieldToggles"], "X operation metadata values");
  return Object.freeze({
    features: exactBooleanMap(
      metadataValues.features,
      descriptor.metadata.featureSwitches,
      "X operation feature values",
    ),
    fieldToggles: exactBooleanMap(
      metadataValues.fieldToggles,
      descriptor.metadata.fieldToggles,
      "X operation field-toggle values",
    ),
  });
}

/**
 * Revision evidence observed in X's public first-party web bundles on the
 * stated date. These IDs are never dispatch constants. Dispatch must resolve
 * the current bundle with `resolveUniqueXWebBundleDescriptor` first.
 */
export const xWebQueryDescriptorEvidenceSnapshot = Object.freeze({
  schemaVersion: 1,
  role: "revision-evidence-only" as const,
  observedOn: "2026-07-22",
  currentBundleResolutionRequired: true,
  mainBundleUrl: "https://abs.twimg.com/responsive-web/client-web/main.9929b02a.js",
  descriptors: Object.freeze([
    { operationName: "HomeTimeline", operationType: "query", queryId: "lqfNCpeO0wydVAAXAbAU5w", sourceChunk: "shared~bundle.LoggedInMain~bundle.HomeTimeline.e992705a.js" },
    { operationName: "HomeLatestTimeline", operationType: "query", queryId: "lyhT5o5ECF6_kYqTqpUUew", sourceChunk: "shared~bundle.LoggedInMain~bundle.HomeTimeline.e992705a.js" },
    { operationName: "ListLatestTweetsTimeline", operationType: "query", queryId: "LV64djPRhnsVhGCK76s13w", sourceChunk: "shared~loader.Dock~bundle.BookmarkFolders~bundle.Bookmarks~bundle.Explore~bundle.HomeTimeline~bundle.Notifica.3b894e0a.js" },
    { operationName: "ListRankedTweetsTimeline", operationType: "query", queryId: "dPN7GrkxeMF4SUYCo9D9YA", sourceChunk: "shared~loader.Dock~bundle.BookmarkFolders~bundle.Bookmarks~bundle.Explore~bundle.HomeTimeline~bundle.Notifica.3b894e0a.js" },
    { operationName: "Bookmarks", operationType: "query", queryId: "LoLaMO4GuHLEPJOhH9kjAw", sourceChunk: "shared~bundle.BookmarkFolders~bundle.Bookmarks.12fa7b2a.js" },
    { operationName: "BookmarkSearchTimeline", operationType: "query", queryId: "SpDsqmz6FfYESd1e7TPcAw", sourceChunk: "main.9929b02a.js" },
    { operationName: "SearchTimeline", operationType: "query", queryId: "hz_94eVAtrtQo_vO3my7Rw", sourceChunk: "main.9929b02a.js" },
    { operationName: "NotificationsTimeline", operationType: "query", queryId: "dDSNxYH-uWwVo2r3Y5VVqg", sourceChunk: "bundle.Notifications.eea6257a.js" },
    { operationName: "TweetDetail", operationType: "query", queryId: "rZA6K31W4E90vZKBmxXV3g", sourceChunk: "main.9929b02a.js" },
    { operationName: "TweetResultByRestId", operationType: "query", queryId: "4hhGRbehkcUVTKf8n0f0xw", sourceChunk: "main.9929b02a.js" },
    { operationName: "TweetResultsByRestIds", operationType: "query", queryId: "aSkhsainBPfEWA4mG8wnFA", sourceChunk: "main.9929b02a.js" },
    { operationName: "UserTweets", operationType: "query", queryId: "6r5OLCC_wFH4CpRyXKuAmQ", sourceChunk: "main.9929b02a.js" },
    { operationName: "UserTweetsAndReplies", operationType: "query", queryId: "klja8a2iJX_3to5RdfVlgw", sourceChunk: "main.9929b02a.js" },
    { operationName: "UserMedia", operationType: "query", queryId: "IS3w9vvPg1SJysLErvnFGg", sourceChunk: "main.9929b02a.js" },
    { operationName: "FavoriteTweet", operationType: "mutation", queryId: "lI07N6Otwv1PhnEgXILM7A", sourceChunk: "main.9929b02a.js" },
    { operationName: "UnfavoriteTweet", operationType: "mutation", queryId: "ZYKSe-w7KEslx3JhSIk5LA", sourceChunk: "main.9929b02a.js" },
    { operationName: "CreateBookmark", operationType: "mutation", queryId: "aoDbu3RHznuiSkQ9aNM67Q", sourceChunk: "main.9929b02a.js" },
    { operationName: "DeleteBookmark", operationType: "mutation", queryId: "Wlmlj2-xzyS1GN3a6cj-mQ", sourceChunk: "main.9929b02a.js" },
    { operationName: "CreateRetweet", operationType: "mutation", queryId: "mbRO74GrOvSfRcJnlMapnQ", sourceChunk: "main.9929b02a.js" },
    { operationName: "DeleteRetweet", operationType: "mutation", queryId: "ZyZigVsNiFO6v1dEks1eWg", sourceChunk: "main.9929b02a.js" },
    { operationName: "CreateTweet", operationType: "mutation", queryId: "hIL9XdleMYEtVXOZVbr8Bg", sourceChunk: "main.9929b02a.js" },
    { operationName: "CreateNoteTweet", operationType: "mutation", queryId: "uGXMU9aKbNB9qxxAg4jxkA", sourceChunk: "main.9929b02a.js" },
    { operationName: "DeleteTweet", operationType: "mutation", queryId: "nxpZCY2K-I6QoFHAHeojFQ", sourceChunk: "main.9929b02a.js" },
    { operationName: "DmAllSearchSlice", operationType: "query", queryId: "zd0F6a_svKAXdlMGbCZDFg", sourceChunk: "bundle.DirectMessages.265735ba.js" },
    { operationName: "DmGroupSearchSlice", operationType: "query", queryId: "LxrvmqF3Lokl_BYZ1c83LA", sourceChunk: "bundle.DirectMessages.265735ba.js" },
    { operationName: "DmPeopleSearchSlice", operationType: "query", queryId: "c1MnRRmI-_Bggpntlq9-hQ", sourceChunk: "bundle.DirectMessages.265735ba.js" },
    { operationName: "Viewer", operationType: "query", queryId: "5XShkXk2oO2J7SYmTu6pvw", sourceChunk: "main.e4aca26a.js", observedOn: "2026-08-14" },
    { operationName: "ArticleEntityDraftCreate", operationType: "mutation", queryId: "btD9FyMDa3_vydVp7fr87Q", sourceChunk: "bundle.TwitterArticles.305538ca.js", observedOn: "2026-08-14" },
    { operationName: "ArticleEntityUpdateContent", operationType: "mutation", queryId: "P5Nc3DYs9D4XqVthNrig8w", sourceChunk: "bundle.TwitterArticles.305538ca.js", observedOn: "2026-08-14" },
    { operationName: "ArticleEntityUpdateTitle", operationType: "mutation", queryId: "z_xdvTUbZjSVjt232b4D4A", sourceChunk: "bundle.TwitterArticles.305538ca.js", observedOn: "2026-08-14" },
    { operationName: "ArticleEntityUpdateCoverMedia", operationType: "mutation", queryId: "BXQicEDA0v2F5SmsjObjDQ", sourceChunk: "bundle.TwitterArticles.305538ca.js", observedOn: "2026-08-14" },
    { operationName: "ArticleEntityPublish", operationType: "mutation", queryId: "UyL9qgpV23A8471opeYQbw", sourceChunk: "bundle.TwitterArticles.305538ca.js", observedOn: "2026-08-14" },
    { operationName: "ArticleEntityResultByRestId", operationType: "query", queryId: "rPdndX2XxQoXIMUafLSSJQ", sourceChunk: "bundle.TwitterArticles.305538ca.js", observedOn: "2026-08-14" },
  ] satisfies readonly XWebQueryDescriptorEvidence[]),
});

type XWebGraphQlReadDefinition = {
  readonly semanticOperation: "feeds.read" | "posts.read";
  readonly risk: "R1";
  readonly transport: "graphql-query";
  readonly operationName: string;
  readonly operationType: "query";
  readonly responseRoot: readonly string[];
};

type XWebLegacyDmReadDefinition = {
  readonly semanticOperation: "messaging.list" | "messaging.read";
  readonly risk: "R1";
  readonly transport: "legacy-dm-read";
  readonly inbox: XWebLegacyDmReadSurface;
};

type XWebDesiredStateDefinition = {
  readonly semanticOperation: "likes.set" | "content.save" | "posts.repost";
  readonly risk: "R2" | "R3";
  readonly transport: "graphql-desired-state";
  readonly enabled: { readonly operationName: string; readonly operationType: "mutation" };
  readonly disabled: { readonly operationName: string; readonly operationType: "mutation" };
};

export type XWebSemanticOperationDefinition =
  | XWebGraphQlReadDefinition
  | XWebLegacyDmReadDefinition
  | XWebDesiredStateDefinition;

export const xWebSemanticOperationRegistry = Object.freeze({
  "feeds.for-you": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "HomeTimeline", operationType: "query", responseRoot: ["home", "home_timeline_urt"] },
  "feeds.following": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "HomeLatestTimeline", operationType: "query", responseRoot: ["home", "home_timeline_urt"] },
  "feeds.list-latest": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "ListLatestTweetsTimeline", operationType: "query", responseRoot: ["list", "tweets_timeline", "timeline"] },
  "feeds.list-ranked": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "ListRankedTweetsTimeline", operationType: "query", responseRoot: ["list", "tweets_timeline", "timeline"] },
  "feeds.bookmarks": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "Bookmarks", operationType: "query", responseRoot: ["bookmark_timeline_v2", "timeline"] },
  "feeds.bookmark-search": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "BookmarkSearchTimeline", operationType: "query", responseRoot: ["bookmark_search_timeline", "timeline"] },
  "feeds.search": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "SearchTimeline", operationType: "query", responseRoot: ["search_by_raw_query", "search_timeline", "timeline"] },
  "feeds.notifications": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "NotificationsTimeline", operationType: "query", responseRoot: ["viewer_v2", "user_results", "result", "notification_timeline", "timeline"] },
  "posts.detail": { semanticOperation: "posts.read", risk: "R1", transport: "graphql-query", operationName: "TweetDetail", operationType: "query", responseRoot: ["threaded_conversation_with_injections_v2"] },
  "posts.by-id": { semanticOperation: "posts.read", risk: "R1", transport: "graphql-query", operationName: "TweetResultByRestId", operationType: "query", responseRoot: ["tweetResult", "result"] },
  "posts.by-ids": { semanticOperation: "posts.read", risk: "R1", transport: "graphql-query", operationName: "TweetResultsByRestIds", operationType: "query", responseRoot: ["tweetResult"] },
  "feeds.user": { semanticOperation: "feeds.read", risk: "R1", transport: "graphql-query", operationName: "UserTweets", operationType: "query", responseRoot: ["user", "result", "timeline", "timeline"] },
  "messaging.primary": { semanticOperation: "messaging.list", risk: "R1", transport: "legacy-dm-read", inbox: "primary" },
  "messaging.requests": { semanticOperation: "messaging.list", risk: "R1", transport: "legacy-dm-read", inbox: "requests" },
  "messaging.additional": { semanticOperation: "messaging.list", risk: "R1", transport: "legacy-dm-read", inbox: "additional" },
  "messaging.conversation": { semanticOperation: "messaging.read", risk: "R1", transport: "legacy-dm-read", inbox: "conversation" },
  "likes.set": { semanticOperation: "likes.set", risk: "R2", transport: "graphql-desired-state", enabled: { operationName: "FavoriteTweet", operationType: "mutation" }, disabled: { operationName: "UnfavoriteTweet", operationType: "mutation" } },
  "bookmarks.set": { semanticOperation: "content.save", risk: "R2", transport: "graphql-desired-state", enabled: { operationName: "CreateBookmark", operationType: "mutation" }, disabled: { operationName: "DeleteBookmark", operationType: "mutation" } },
  "reposts.set": { semanticOperation: "posts.repost", risk: "R3", transport: "graphql-desired-state", enabled: { operationName: "CreateRetweet", operationType: "mutation" }, disabled: { operationName: "DeleteRetweet", operationType: "mutation" } },
} as const satisfies Readonly<Record<string, XWebSemanticOperationDefinition>>);

export type XWebSemanticOperationId = keyof typeof xWebSemanticOperationRegistry;

export const xWebHeaderSinkPolicy = Object.freeze({
  browserManaged: Object.freeze([
    "cookie",
    "host",
    "origin",
    "referer",
    "user-agent",
    "content-length",
  ]),
  browserManagedPrefixes: Object.freeze(["sec-", "proxy-"]),
  inOriginEphemeral: Object.freeze([
    "authorization",
    "x-csrf-token",
    "x-client-transaction-id",
  ]),
  fixedCodeHeaders: Object.freeze([
    "accept",
    "content-type",
    "x-twitter-auth-type",
    "x-twitter-active-user",
    "x-twitter-client-language",
  ]),
  permittedRawSink: "network-request" as const,
  persistentSinks: Object.freeze(["plan", "receipt", "log", "fixture"] as const),
  forbiddenSources: Object.freeze(["manifest", "adapter", "user-input"] as const),
});

export type XWebHeaderSource = "code" | "in-origin-session" | "manifest" | "adapter" | "user-input";
export type XWebHeaderSink = "network-request" | "plan" | "receipt" | "log" | "fixture";

const forbiddenXWebHeaderSourceSet = new Set<XWebHeaderSource>(xWebHeaderSinkPolicy.forbiddenSources);

export type XWebHeaderPolicyInput = {
  readonly source: XWebHeaderSource;
  readonly sink: XWebHeaderSink;
  readonly headers: Readonly<Record<string, string>>;
};

export type XWebAuthorizedHeaders = {
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, string>>;
};

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertFixedHeaderValue(name: string, value: string): void {
  if (name === "accept" && value !== "application/json") {
    throw new Error("X fixed request header accept had an unsupported value");
  }
  if (name === "content-type" && value !== "application/json") {
    throw new Error("X fixed request header content-type had an unsupported value");
  }
  if (name === "x-twitter-auth-type" && value !== "OAuth2Session") {
    throw new Error("X fixed request header x-twitter-auth-type had an unsupported value");
  }
  if (name === "x-twitter-active-user" && value !== "yes") {
    throw new Error("X fixed request header x-twitter-active-user had an unsupported value");
  }
  if (name === "x-twitter-client-language" && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value)) {
    throw new Error("X fixed request header x-twitter-client-language had an unsupported value");
  }
}

function assertEphemeralHeaderValue(name: string, value: string): void {
  if (value.length === 0 || value.length > 8_192 || hasAsciiControl(value)) {
    throw new Error(`X ephemeral request header ${name} had an invalid value`);
  }
  if (name === "authorization" && !/^Bearer [^\s]+$/u.test(value)) {
    throw new Error("X ephemeral request header authorization must be a bearer value");
  }
  if (name === "x-csrf-token" && !/^[A-Za-z0-9_-]{16,512}$/u.test(value)) {
    throw new Error("X ephemeral request header x-csrf-token had an invalid value");
  }
  if (name === "x-client-transaction-id" && !/^[A-Za-z0-9_+/=-]{8,2048}$/u.test(value)) {
    throw new Error("X ephemeral request header x-client-transaction-id had an invalid value");
  }
}

/** Enforce that raw session headers only ever flow into the in-origin request. */
export function enforceXWebHeaderSinkPolicy(input: XWebHeaderPolicyInput): XWebAuthorizedHeaders {
  if (!isRecord(input.headers)) throw new Error("X headers must be an object");
  const entries = Object.entries(input.headers);
  if (input.sink !== "network-request") {
    if (entries.length > 0) throw new Error(`raw X headers may not flow to ${input.sink}`);
    return Object.freeze({ names: Object.freeze([]), values: Object.freeze({}) });
  }
  if (forbiddenXWebHeaderSourceSet.has(input.source)) {
    if (entries.length > 0) throw new Error(`${input.source} may not supply X request headers`);
    return Object.freeze({ names: Object.freeze([]), values: Object.freeze({}) });
  }
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(name)) throw new Error("X request contained an invalid header name");
    if (Object.hasOwn(normalized, name)) throw new Error(`X request contained duplicate header ${name}`);
    if (typeof value !== "string" || hasAsciiControl(value)) {
      throw new Error(`X request header ${name} had an invalid value`);
    }
    if (
      xWebHeaderSinkPolicy.browserManaged.includes(name)
      || xWebHeaderSinkPolicy.browserManagedPrefixes.some((prefix) => name.startsWith(prefix))
    ) {
      throw new Error(`X request header ${name} must be browser-managed`);
    }
    if (xWebHeaderSinkPolicy.inOriginEphemeral.includes(name)) {
      if (input.source !== "in-origin-session") {
        throw new Error(`X request header ${name} must come from the in-origin session`);
      }
      assertEphemeralHeaderValue(name, value);
    } else if (xWebHeaderSinkPolicy.fixedCodeHeaders.includes(name)) {
      if (input.source !== "code" && input.source !== "in-origin-session") {
        throw new Error(`X request header ${name} must be code-owned`);
      }
      assertFixedHeaderValue(name, value);
    } else {
      throw new Error(`X request header ${name} is not allowlisted`);
    }
    normalized[name] = value;
  }
  return Object.freeze({
    names: Object.freeze(Object.keys(normalized).sort()),
    values: Object.freeze(normalized),
  });
}

export type XWebRedactedHeaderEvidence = {
  readonly name: string;
  readonly ownership: "browser-managed" | "in-origin-ephemeral" | "fixed-code" | "forbidden";
};

/** Return header names/classes only; values are intentionally not accepted. */
export function classifyXWebHeaderNamesForEvidence(names: readonly string[]): readonly XWebRedactedHeaderEvidence[] {
  const unique = new Set<string>();
  const result: XWebRedactedHeaderEvidence[] = [];
  for (const rawName of names) {
    const name = rawName.toLowerCase();
    if (unique.has(name)) throw new Error(`X evidence contained duplicate header name ${name}`);
    unique.add(name);
    let ownership: XWebRedactedHeaderEvidence["ownership"] = "forbidden";
    if (
      xWebHeaderSinkPolicy.browserManaged.includes(name)
      || xWebHeaderSinkPolicy.browserManagedPrefixes.some((prefix) => name.startsWith(prefix))
    ) ownership = "browser-managed";
    else if (xWebHeaderSinkPolicy.inOriginEphemeral.includes(name)) ownership = "in-origin-ephemeral";
    else if (xWebHeaderSinkPolicy.fixedCodeHeaders.includes(name)) ownership = "fixed-code";
    result.push(Object.freeze({ name, ownership }));
  }
  return Object.freeze(result.sort((left, right) => left.name.localeCompare(right.name)));
}

function exactUrl(value: string | URL, label: string): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.origin !== "https://x.com" || url.username !== "" || url.password !== "") {
    throw new Error(`${label} must use the exact https://x.com origin`);
  }
  if (url.hash !== "") throw new Error(`${label} may not contain a fragment`);
  return url;
}

function normalizedMethod(value: string): "GET" | "POST" {
  const method = value.toUpperCase();
  if (method !== "GET" && method !== "POST") throw new Error("X GraphQL method must be GET or POST");
  return method;
}

function bodyRecord(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value) as unknown, "X GraphQL body");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("X GraphQL body")) throw error;
      throw new Error("X GraphQL body must be valid JSON");
    }
  }
  return record(value, "X GraphQL body");
}

export function buildXWebGraphQlPath(descriptorValue: XWebQueryDescriptorKey): string {
  const descriptor = parseDescriptorKey(descriptorValue, "X GraphQL descriptor");
  return `/i/api/graphql/${descriptor.queryId}/${descriptor.operationName}`;
}

export type XWebGraphQlBindingInput = {
  readonly url: string | URL;
  readonly method: string;
  readonly descriptor: XWebBundleQueryDescriptor;
  readonly body?: unknown;
};

export type XWebGraphQlBinding = {
  readonly method: "GET" | "POST";
  readonly operationName: string;
  readonly operationType: XWebOperationType;
  readonly queryId: string;
  readonly path: string;
};

/** Prove URL path, optional query/body identity, method, and descriptor agree. */
export function assertExactXWebGraphQlBinding(input: XWebGraphQlBindingInput): XWebGraphQlBinding {
  const descriptor = parseBundleQueryDescriptor(input.descriptor, "resolved X descriptor");
  const method = normalizedMethod(input.method);
  if (descriptor.operationType === "mutation" && method !== "POST") {
    throw new Error("X GraphQL mutations require POST");
  }
  if (method === "GET" && input.body !== undefined) throw new Error("X GraphQL GET may not contain a body");
  const url = exactUrl(input.url, "X GraphQL URL");
  const expectedPath = buildXWebGraphQlPath(descriptor);
  if (url.pathname !== expectedPath) {
    throw new Error("X GraphQL path did not bind the resolved operation name and query ID");
  }
  const allowedParameters = new Set(["variables", "features", "fieldToggles", "queryId", "operationName"]);
  const seenParameters = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (!allowedParameters.has(name)) throw new Error(`X GraphQL URL contained unsupported parameter ${name}`);
    if (seenParameters.has(name)) throw new Error(`X GraphQL URL repeated parameter ${name}`);
    seenParameters.add(name);
    if (name === "queryId" && value !== descriptor.queryId) throw new Error("X GraphQL URL queryId drifted from its path");
    if (name === "operationName" && value !== descriptor.operationName) throw new Error("X GraphQL URL operationName drifted from its path");
  }
  if (input.body !== undefined) {
    const body = bodyRecord(input.body);
    if (body.queryId !== undefined && body.queryId !== descriptor.queryId) {
      throw new Error("X GraphQL body queryId drifted from its path");
    }
    if (body.operationName !== undefined && body.operationName !== descriptor.operationName) {
      throw new Error("X GraphQL body operationName drifted from its path");
    }
    if (body.operationType !== undefined && body.operationType !== descriptor.operationType) {
      throw new Error("X GraphQL body operationType drifted from its descriptor");
    }
  }
  return Object.freeze({
    method,
    operationName: descriptor.operationName,
    operationType: descriptor.operationType,
    queryId: descriptor.queryId,
    path: expectedPath,
  });
}

export function authorizeXWebR1GraphQlRequest(
  operationId: XWebSemanticOperationId,
  input: XWebGraphQlBindingInput,
): XWebGraphQlBinding {
  const definition = xWebSemanticOperationRegistry[operationId];
  if (definition.transport !== "graphql-query" || definition.risk !== "R1") {
    throw new Error(`${operationId} is not an allowlisted X R1 GraphQL read`);
  }
  const binding = assertExactXWebGraphQlBinding(input);
  if (
    binding.operationType !== "query"
    || binding.operationName !== definition.operationName
  ) {
    throw new Error(`${operationId} did not bind its reviewed X query operation`);
  }
  return binding;
}

export const xWebMutationOperationIds = Object.freeze([
  "posts.publish",
  "threads.publish",
  "threads.reply",
  "replies.create",
  "posts.quote",
  "likes.enable",
  "likes.disable",
  "bookmarks.enable",
  "bookmarks.disable",
  "reposts.enable",
  "reposts.disable",
  "articles.draft",
  "articles.create",
  "articles.title",
  "articles.content",
  "articles.cover",
] as const);

export type XWebMutationOperationId = (typeof xWebMutationOperationIds)[number];

const mutationOperationNames = Object.freeze({
  "posts.publish": "CreateTweet",
  "threads.publish": "CreateTweet",
  "threads.reply": "CreateTweet",
  "replies.create": "CreateTweet",
  "posts.quote": "CreateTweet",
  "likes.enable": "FavoriteTweet",
  "likes.disable": "UnfavoriteTweet",
  "bookmarks.enable": "CreateBookmark",
  "bookmarks.disable": "DeleteBookmark",
  "reposts.enable": "CreateRetweet",
  "reposts.disable": "DeleteRetweet",
  "articles.draft": "ArticleEntityDraftCreate",
  "articles.create": "ArticleEntityDraftCreate",
  "articles.title": "ArticleEntityUpdateTitle",
  "articles.content": "ArticleEntityUpdateContent",
  "articles.cover": "ArticleEntityUpdateCoverMedia",
} as const satisfies Readonly<Record<XWebMutationOperationId, string>>);

function exactMutationKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  exactKeys(value, keys, label);
}

function exactMutationPostId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9]{1,19}$/u.test(value)) {
    throw new Error(`${label} must be an exact X post ID`);
  }
  return value;
}

function exactMutationText(value: unknown): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 25_000 || /[\0\r]/u.test(value)) {
    throw new Error("X CreateTweet text must be bounded and contain no NUL or carriage return");
  }
}

function validateCreateTweetVariables(operationId: XWebMutationOperationId, variables: JsonRecord): void {
  const relationKey = operationId === "replies.create" || operationId === "threads.reply"
    ? "reply"
    : operationId === "posts.quote" ? "attachment_url" : null;
  exactMutationKeys(
    variables,
    ["tweet_text", "dark_request", "media", "semantic_annotation_ids", ...(relationKey === null ? [] : [relationKey])],
    `X ${operationId} variables`,
  );
  exactMutationText(variables.tweet_text);
  if (variables.dark_request !== false) throw new Error(`X ${operationId} dark_request must be false`);
  const media = record(variables.media, `X ${operationId} media`);
  exactMutationKeys(media, ["media_entities", "possibly_sensitive"], `X ${operationId} media`);
  if (!Array.isArray(media.media_entities) || media.media_entities.length !== 0 || media.possibly_sensitive !== false) {
    throw new Error(`X ${operationId} supports only the reviewed text-only media shape`);
  }
  if (!Array.isArray(variables.semantic_annotation_ids) || variables.semantic_annotation_ids.length !== 0) {
    throw new Error(`X ${operationId} semantic annotations are outside the reviewed contract`);
  }
  if (operationId === "replies.create" || operationId === "threads.reply") {
    const reply = record(variables.reply, "X replies.create reply");
    exactMutationKeys(reply, ["in_reply_to_tweet_id", "exclude_reply_user_ids"], "X replies.create reply");
    exactMutationPostId(reply.in_reply_to_tweet_id, "X replies.create parent");
    if (!Array.isArray(reply.exclude_reply_user_ids) || reply.exclude_reply_user_ids.length !== 0) {
      throw new Error("X replies.create exclude_reply_user_ids must be empty");
    }
  }
  if (operationId === "posts.quote") {
    if (typeof variables.attachment_url !== "string") throw new Error("X posts.quote attachment_url must be a string");
    const match = /^https:\/\/x\.com\/i\/status\/([0-9]{1,19})$/u.exec(variables.attachment_url);
    if (match?.[1] === undefined) throw new Error("X posts.quote attachment_url must bind one exact X post");
  }
}

function validateDesiredStateVariables(operationId: XWebMutationOperationId, variables: JsonRecord): void {
  if (operationId.startsWith("reposts.")) {
    const key = operationId === "reposts.enable" ? "tweet_id" : "source_tweet_id";
    exactMutationKeys(variables, [key, "dark_request"], `X ${operationId} variables`);
    exactMutationPostId(variables[key], `X ${operationId} target`);
    if (variables.dark_request !== false) throw new Error(`X ${operationId} dark_request must be false`);
    return;
  }
  exactMutationKeys(variables, ["tweet_id"], `X ${operationId} variables`);
  exactMutationPostId(variables.tweet_id, `X ${operationId} target`);
}

function validateArticleDraftVariables(variables: JsonRecord): void {
  exactMutationKeys(variables, ["content_state", "title"], "X articles.draft variables");
  if (
    typeof variables.title !== "string"
    || variables.title.length < 1
    || variables.title.length > 100
    || /[\0\r\n]/u.test(variables.title)
  ) {
    throw new Error("X articles.draft title must be a bounded string");
  }
  const contentState = record(variables.content_state, "X articles.draft content_state");
  exactMutationKeys(contentState, ["blocks", "entity_map"], "X articles.draft content_state");
  if (!Array.isArray(contentState.blocks) || contentState.blocks.length < 1 || contentState.blocks.length > 2_000) {
    throw new Error("X articles.draft content_state.blocks must contain 1-2000 plain-text blocks");
  }
  if (!Array.isArray(contentState.entity_map) || contentState.entity_map.length !== 0) {
    throw new Error("X articles.draft supports only an empty plain-text entity_map");
  }
  const lines: string[] = [];
  for (const [index, value] of contentState.blocks.entries()) {
    const block = record(value, `X articles.draft block ${index + 1}`);
    exactMutationKeys(
      block,
      ["data", "text", "type", "entity_ranges", "inline_style_ranges"],
      `X articles.draft block ${index + 1}`,
    );
    const data = record(block.data, `X articles.draft block ${index + 1}.data`);
    exactMutationKeys(data, [], `X articles.draft block ${index + 1}.data`);
    if (
      typeof block.text !== "string"
      || /[\0\r\n]/u.test(block.text)
      || block.type !== "unstyled"
      || !Array.isArray(block.entity_ranges)
      || block.entity_ranges.length !== 0
      || !Array.isArray(block.inline_style_ranges)
      || block.inline_style_ranges.length !== 0
    ) {
      throw new Error(`X articles.draft block ${index + 1} left the reviewed plain-text shape`);
    }
    lines.push(block.text);
  }
  const body = lines.join("\n");
  if (body.length < 1 || body.length > 20_000) {
    throw new Error("X articles.draft body must be 1-20000 characters");
  }
}

const richArticleBlockTypes = new Set([
  "unstyled",
  "header-one",
  "header-two",
  "blockquote",
  "unordered-list-item",
  "ordered-list-item",
  "atomic",
]);
const richArticleInlineStyles = new Set(["Bold", "Italic", "Strikethrough"]);

function exactArticleRange(
  value: unknown,
  label: string,
  maximum: number,
): { readonly key?: number; readonly offset: number; readonly length: number; readonly style?: string } {
  const range = record(value, label);
  const hasKey = Object.hasOwn(range, "key");
  const hasStyle = Object.hasOwn(range, "style");
  if (hasKey === hasStyle) throw new Error(`${label} must be exactly one entity or style range`);
  exactMutationKeys(range, hasKey ? ["key", "offset", "length"] : ["length", "offset", "style"], label);
  if (
    !Number.isSafeInteger(range.offset)
    || !Number.isSafeInteger(range.length)
    || (range.offset as number) < 0
    || (range.length as number) < 1
    || (range.offset as number) + (range.length as number) > maximum
  ) throw new Error(`${label} must stay inside its block text`);
  if (hasKey && (!Number.isSafeInteger(range.key) || (range.key as number) < 0)) {
    throw new Error(`${label}.key must be a non-negative integer`);
  }
  if (hasStyle && (typeof range.style !== "string" || !richArticleInlineStyles.has(range.style))) {
    throw new Error(`${label}.style is outside the reviewed Article styles`);
  }
  return Object.freeze({
    ...(hasKey ? { key: range.key as number } : { style: range.style as string }),
    offset: range.offset as number,
    length: range.length as number,
  });
}

function exactArticleUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must be a bounded HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a bounded HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${label} must be a bounded HTTPS URL`);
  }
  return parsed.href;
}

/** Validate the exact API-side rich content state emitted by X's current converter. */
export function validateXWebRichArticleContentState(value: unknown): void {
  const contentState = record(value, "X rich Article content_state");
  exactMutationKeys(contentState, ["blocks", "entity_map"], "X rich Article content_state");
  if (!Array.isArray(contentState.blocks) || contentState.blocks.length < 1 || contentState.blocks.length > 2_000) {
    throw new Error("X rich Article content_state.blocks must contain 1-2000 blocks");
  }
  if (!Array.isArray(contentState.entity_map) || contentState.entity_map.length > 2_000) {
    throw new Error("X rich Article content_state.entity_map exceeded its reviewed bound");
  }
  const entityKinds: ("LINK" | "MEDIA")[] = [];
  let mediaCount = 0;
  for (const [index, value] of contentState.entity_map.entries()) {
    const entity = record(value, `X rich Article entity ${index}`);
    exactMutationKeys(entity, ["key", "value"], `X rich Article entity ${index}`);
    if (entity.key !== `${index}`) throw new Error("X rich Article entity keys must be contiguous strings");
    const entry = record(entity.value, `X rich Article entity ${index}.value`);
    exactMutationKeys(entry, ["data", "type", "mutability"], `X rich Article entity ${index}.value`);
    const data = record(entry.data, `X rich Article entity ${index}.data`);
    if (entry.type === "LINK") {
      if (entry.mutability !== "Mutable") throw new Error("X rich Article links must be mutable");
      exactMutationKeys(data, ["url"], `X rich Article entity ${index}.data`);
      exactArticleUrl(data.url, `X rich Article entity ${index}.data.url`);
      entityKinds.push("LINK");
      continue;
    }
    if (entry.type !== "MEDIA" || entry.mutability !== "Immutable") {
      throw new Error("X rich Article entities support only reviewed LINK and MEDIA values");
    }
    const mediaKeys = Object.keys(data).sort().join(",");
    if (mediaKeys !== "entity_key,media_items" && mediaKeys !== "caption,entity_key,media_items") {
      throw new Error(`X rich Article entity ${index}.data contained unsupported media fields`);
    }
    if (data.entity_key !== `${index}`) throw new Error("X rich Article media entity_key must bind its entity");
    if (data.caption !== undefined && (
      typeof data.caption !== "string"
      || data.caption.length > 1_000
      || /[\0\r]/u.test(data.caption)
    )) throw new Error("X rich Article media caption must be bounded text");
    if (!Array.isArray(data.media_items) || data.media_items.length !== 1) {
      throw new Error("X rich Article media entities must contain one image");
    }
    const media = record(data.media_items[0], `X rich Article entity ${index}.media_items[0]`);
    exactMutationKeys(media, ["local_media_id", "media_category", "media_id"], `X rich Article entity ${index}.media_items[0]`);
    if (!Number.isSafeInteger(media.local_media_id) || (media.local_media_id as number) < 1) {
      throw new Error("X rich Article local media IDs must be positive integers");
    }
    if (media.media_category !== "DraftTweetImage") {
      throw new Error("X rich Article inline media must use DraftTweetImage");
    }
    exactMutationPostId(media.media_id, "X rich Article media ID");
    mediaCount += 1;
    if (mediaCount > 20) throw new Error("X rich Article supports at most 20 inline images");
    entityKinds.push("MEDIA");
  }

  const references = Array.from({ length: entityKinds.length }, () => 0);
  const blockKeys = new Set<string>();
  let characters = 0;
  for (const [index, value] of contentState.blocks.entries()) {
    const block = record(value, `X rich Article block ${index + 1}`);
    exactMutationKeys(
      block,
      ["data", "text", "key", "type", "entity_ranges", "inline_style_ranges"],
      `X rich Article block ${index + 1}`,
    );
    const data = record(block.data, `X rich Article block ${index + 1}.data`);
    exactMutationKeys(data, [], `X rich Article block ${index + 1}.data`);
    if (
      typeof block.text !== "string"
      || /[\0\r\n]/u.test(block.text)
      || typeof block.key !== "string"
      || !/^[a-z0-9]{5}$/u.test(block.key)
      || blockKeys.has(block.key)
      || typeof block.type !== "string"
      || !richArticleBlockTypes.has(block.type)
      || !Array.isArray(block.entity_ranges)
      || !Array.isArray(block.inline_style_ranges)
    ) throw new Error(`X rich Article block ${index + 1} left the reviewed shape`);
    const blockText = block.text;
    blockKeys.add(block.key);
    characters += blockText.length;
    if (characters > 20_000) throw new Error("X rich Article text exceeds 20000 characters");
    const entityRanges = block.entity_ranges.map((range, rangeIndex) =>
      exactArticleRange(range, `X rich Article block ${index + 1}.entity_ranges[${rangeIndex}]`, blockText.length));
    block.inline_style_ranges.forEach((range, rangeIndex) => {
      exactArticleRange(range, `X rich Article block ${index + 1}.inline_style_ranges[${rangeIndex}]`, blockText.length);
    });
    let previousEnd = 0;
    for (const range of entityRanges) {
      if (range.offset < previousEnd) throw new Error("X rich Article entity ranges may not overlap");
      previousEnd = range.offset + range.length;
      const key = range.key!;
      const kind = entityKinds[key];
      if (kind === undefined) throw new Error("X rich Article entity range referenced an unknown entity");
      references[key] = (references[key] ?? 0) + 1;
      if (block.type === "atomic" ? kind !== "MEDIA" : kind !== "LINK") {
        throw new Error("X rich Article entity range used the wrong block kind");
      }
    }
    if (block.type === "atomic") {
      if (
        blockText !== " "
        || entityRanges.length !== 1
        || entityRanges[0]?.offset !== 0
        || entityRanges[0]?.length !== 1
        || block.inline_style_ranges.length !== 0
      ) throw new Error("X rich Article atomic image blocks must bind one media entity");
    }
  }
  if (references.some((count) => count !== 1)) {
    throw new Error("X rich Article entities must each be referenced exactly once");
  }
}

function validateRichArticleCreateVariables(variables: JsonRecord): void {
  exactMutationKeys(variables, ["content_state", "title"], "X articles.create variables");
  if (
    typeof variables.title !== "string"
    || variables.title.length < 1
    || variables.title.length > 100
    || /[\0\r\n]/u.test(variables.title)
  ) throw new Error("X articles.create title must be one bounded line");
  validateXWebRichArticleContentState(variables.content_state);
}

function validateRichArticleUpdateVariables(operationId: XWebMutationOperationId, variables: JsonRecord): void {
  if (operationId === "articles.title") {
    exactMutationKeys(variables, ["articleEntityId", "title"], "X articles.title variables");
    exactMutationPostId(variables.articleEntityId, "X articles.title draft");
    if (
      typeof variables.title !== "string"
      || variables.title.length < 1
      || variables.title.length > 100
      || /[\0\r\n]/u.test(variables.title)
    ) throw new Error("X articles.title title must be one bounded line");
    return;
  }
  if (operationId === "articles.content") {
    exactMutationKeys(variables, ["content_state", "article_entity"], "X articles.content variables");
    exactMutationPostId(variables.article_entity, "X articles.content draft");
    validateXWebRichArticleContentState(variables.content_state);
    return;
  }
  exactMutationKeys(variables, ["articleEntityId", "coverMedia"], "X articles.cover variables");
  exactMutationPostId(variables.articleEntityId, "X articles.cover draft");
  const cover = record(variables.coverMedia, "X articles.cover coverMedia");
  exactMutationKeys(cover, ["media_id", "media_category"], "X articles.cover coverMedia");
  exactMutationPostId(cover.media_id, "X articles.cover media ID");
  if (cover.media_category !== "DraftTweetImage") {
    throw new Error("X articles.cover media category must be DraftTweetImage");
  }
}

/**
 * Bind a state-changing request to one semantic operation and its complete
 * variable/metadata shape before the durable dispatch boundary is crossed.
 */
export function authorizeXWebMutationRequest(
  operationId: XWebMutationOperationId,
  input: XWebGraphQlBindingInput,
): XWebGraphQlBinding {
  const expectedName = mutationOperationNames[operationId];
  if (expectedName === undefined) throw new Error("X mutation operation is not allowlisted");
  const binding = assertExactXWebGraphQlBinding(input);
  if (binding.operationType !== "mutation" || binding.operationName !== expectedName || binding.method !== "POST") {
    throw new Error(`${operationId} did not bind its reviewed X mutation operation`);
  }
  const body = bodyRecord(input.body);
  const descriptor = parseBundleQueryDescriptor(input.descriptor, `X ${operationId} descriptor`);
  exactMutationKeys(
    body,
    ["variables", "features", "queryId", ...(descriptor.metadata.fieldToggles.length === 0 ? [] : ["fieldToggles"])],
    `X ${operationId} body`,
  );
  if (body.queryId !== binding.queryId) throw new Error(`X ${operationId} body queryId drifted`);
  const variables = record(body.variables, `X ${operationId} variables`);
  if (expectedName === "CreateTweet") validateCreateTweetVariables(operationId, variables);
  else if (operationId === "articles.draft") validateArticleDraftVariables(variables);
  else if (operationId === "articles.create") validateRichArticleCreateVariables(variables);
  else if (operationId === "articles.title" || operationId === "articles.content" || operationId === "articles.cover") {
    validateRichArticleUpdateVariables(operationId, variables);
  }
  else validateDesiredStateVariables(operationId, variables);
  exactBooleanMap(body.features, descriptor.metadata.featureSwitches, `X ${operationId} features`);
  if (descriptor.metadata.fieldToggles.length > 0) {
    exactBooleanMap(body.fieldToggles, descriptor.metadata.fieldToggles, `X ${operationId} fieldToggles`);
  }
  return binding;
}

function responseData(value: unknown, label: string): JsonRecord {
  const body = record(value, label);
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors)) throw new Error(`${label}.errors must be an array`);
    if (body.errors.length > 0) throw new Error(`${label} contained provider errors`);
  }
  return record(body.data, `${label}.data`);
}

/**
 * Bind a GraphQL read response to the reviewed operation-specific root before
 * a caller normalizes it. This catches 200 responses for a different schema.
 */
export function extractXWebGraphQlReadResponseRoot(
  operationId: XWebSemanticOperationId,
  response: unknown,
): unknown {
  const definition = xWebSemanticOperationRegistry[operationId];
  if (definition.transport !== "graphql-query" || definition.risk !== "R1") {
    throw new Error(`${operationId} is not an X GraphQL read response contract`);
  }
  let current: unknown = responseData(response, `X ${operationId} response`);
  for (const [index, segment] of definition.responseRoot.entries()) {
    const parent = record(current, `X ${operationId} response root ${definition.responseRoot.slice(0, index).join(".") || "data"}`);
    if (!Object.hasOwn(parent, segment) || parent[segment] === null || parent[segment] === undefined) {
      throw new Error(`X ${operationId} response omitted reviewed root ${definition.responseRoot.join(".")}`);
    }
    current = parent[segment];
  }
  return current;
}

export function normalizeXWebGraphQlTimelineResponse(
  operationId: XWebSemanticOperationId,
  response: unknown,
): XWebNormalizedTimeline {
  const definition = xWebSemanticOperationRegistry[operationId];
  if (
    definition.transport !== "graphql-query"
    || (definition.semanticOperation !== "feeds.read" && operationId !== "posts.detail")
  ) {
    throw new Error(`${operationId} is not an X URT timeline response contract`);
  }
  return normalizeXWebUrtTimeline(extractXWebGraphQlReadResponseRoot(operationId, response));
}

export const xWebLegacyDmInboxMapping = Object.freeze({
  primary: Object.freeze({
    providerClass: "PRIMARY" as const,
    route: "/messages",
    stateKey: "dmInbox",
    cursorSelector: "selectInboxCursor",
    fetchAction: "fetchTrustedInboxHistory",
    uiMayUpdateLastSeen: true,
  }),
  requests: Object.freeze({
    providerClass: "SECONDARY" as const,
    route: "/messages/requests",
    stateKey: "dmUntrustedInbox",
    cursorSelector: "selectUntrustedCursor",
    fetchAction: "fetchUntrustedInboxHistory",
    uiMayUpdateLastSeen: true,
  }),
  additional: Object.freeze({
    providerClass: "TERTIARY" as const,
    route: "/messages/requests/additional",
    stateKey: "dmLowQualityUntrustedInbox",
    cursorSelector: "selectUntrustedLowQualityCursor",
    fetchAction: "fetchUntrustedLowQualityInboxHistory",
    uiMayUpdateLastSeen: false,
  }),
});

export type XWebLegacyDmInbox = keyof typeof xWebLegacyDmInboxMapping;
export type XWebLegacyDmReadSurface = XWebLegacyDmInbox | "conversation";

export function resolveXWebLegacyDmInbox(value: unknown): (typeof xWebLegacyDmInboxMapping)[XWebLegacyDmInbox] {
  if (value !== "primary" && value !== "requests" && value !== "additional") {
    throw new Error("X inbox must be primary, requests, or additional");
  }
  return xWebLegacyDmInboxMapping[value];
}

const legacyDmStaticPaths = Object.freeze({
  "/i/api/1.1/dm/inbox_initial_state.json": Object.freeze(["primary"] as const),
  "/i/api/1.1/dm/inbox_timeline/trusted.json": Object.freeze(["primary"] as const),
  "/i/api/1.1/dm/inbox_timeline/untrusted.json": Object.freeze(["requests"] as const),
  "/i/api/1.1/dm/inbox_timeline/untrusted_low_quality.json": Object.freeze(["additional"] as const),
});

export const xWebLegacyDmReadQueryParameterNames = Object.freeze([
  "cards_platform",
  "context",
  "count",
  "cursor",
  "dm_users",
  "ext",
  "filter_low_quality",
  "include_blocked_by",
  "include_blocking",
  "include_can_dm",
  "include_can_media_tag",
  "include_cards",
  "include_conversation_info",
  "include_entities",
  "include_ext_alt_text",
  "include_ext_has_nft_avatar",
  "include_ext_is_blue_verified",
  "include_ext_limited_action_results",
  "include_ext_media_availability",
  "include_ext_media_color",
  "include_ext_profile_image_shape",
  "include_ext_sensitive_media_warning",
  "include_ext_trusted_friends_metadata",
  "include_ext_verified_type",
  "include_ext_views",
  "include_followed_by",
  "include_groups",
  "include_inbox_timelines",
  "include_mute_edge",
  "include_profile_interstitial_type",
  "include_quality",
  "include_quote_count",
  "include_reply_count",
  "include_want_retweets",
  "max_id",
  "min_entry_id",
  "requestContext",
  "send_error_codes",
  "simple_quoted_tweet",
  "skip_status",
  "tweet_mode",
] as const);

const legacyDmQueryParameterSet = new Set<string>(xWebLegacyDmReadQueryParameterNames);
const forbiddenLegacyDmParameters = new Set([
  "accept",
  "accepted",
  "last_seen_event_id",
  "lastseeneventid",
  "mark_read",
  "markread",
  "poll",
  "update_last_seen",
  "watch",
]);

export type XWebLegacyDmReadRequest = {
  readonly surface: XWebLegacyDmReadSurface;
  readonly method: string;
  readonly url: string | URL;
  readonly polling?: boolean;
};

export type XWebAuthorizedLegacyDmRead = {
  readonly surface: XWebLegacyDmReadSurface;
  readonly method: "GET";
  readonly path: string;
  readonly conversationId: string | null;
  readonly queryParameterNames: readonly string[];
};

function exactConversationId(value: string): string {
  if (!/^(?:[0-9]{1,19}|[0-9]{1,19}-[0-9]{1,19})$/u.test(value)) {
    throw new Error("X DM conversation path contained an invalid conversation ID");
  }
  if (value.includes("-")) {
    const [left, right] = value.split("-");
    if (left === right) throw new Error("X DM conversation must contain different participants");
  }
  return value;
}

/** Authorize a one-shot, side-effect-free legacy DM read. */
export function authorizeXWebLegacyDmR1Read(input: XWebLegacyDmReadRequest): XWebAuthorizedLegacyDmRead {
  if (input.polling !== undefined && input.polling !== false) {
    throw new Error("X R1 DM reads may not enable polling");
  }
  if (input.method.toUpperCase() !== "GET") throw new Error("X R1 DM reads require GET");
  const url = exactUrl(input.url, "X legacy DM URL");
  const lowerPath = url.pathname.toLowerCase();
  if (
    lowerPath.includes("mark_read")
    || lowerPath.includes("last_seen")
    || lowerPath.includes("/accept")
    || lowerPath.includes("/new2")
    || lowerPath.includes("/delete")
    || lowerPath.includes("user_updates")
  ) {
    throw new Error("X R1 DM reads forbid write, last-seen, accept, and polling endpoints");
  }
  let conversationId: string | null = null;
  const conversation = /^\/i\/api\/1\.1\/dm\/conversation\/([^/]+)\.json$/u.exec(url.pathname);
  if (input.surface === "conversation") {
    if (conversation === null) throw new Error("X DM conversation read requires the exact conversation endpoint");
    conversationId = exactConversationId(conversation[1]!);
  } else {
    if (conversation !== null) throw new Error("X DM inbox reads may not use the conversation endpoint");
    const allowedSurfaces = legacyDmStaticPaths[url.pathname as keyof typeof legacyDmStaticPaths];
    if (allowedSurfaces === undefined || !(allowedSurfaces as readonly string[]).includes(input.surface)) {
      throw new Error(`X DM ${input.surface} read used a non-allowlisted inbox endpoint`);
    }
  }
  const queryNames: string[] = [];
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    const normalized = name.toLowerCase();
    if (seen.has(name)) throw new Error(`X legacy DM URL repeated parameter ${name}`);
    seen.add(name);
    if (forbiddenLegacyDmParameters.has(normalized)) {
      throw new Error(`X R1 DM reads forbid parameter ${name}`);
    }
    if (!legacyDmQueryParameterSet.has(name)) {
      throw new Error(`X legacy DM URL contained unsupported parameter ${name}`);
    }
    if (value.length > 32_768 || hasAsciiControl(value)) {
      throw new Error(`X legacy DM URL parameter ${name} had an invalid value`);
    }
    queryNames.push(name);
  }
  return Object.freeze({
    surface: input.surface,
    method: "GET",
    path: url.pathname,
    conversationId,
    queryParameterNames: Object.freeze(queryNames.sort()),
  });
}

export type XWebNormalizedTweet = {
  readonly kind: "tweet";
  readonly entryId: string;
  readonly moduleEntryId: string | null;
  readonly sortIndex: string | null;
  readonly tweetId: string;
  readonly typename: "Tweet" | "TweetWithVisibilityResults" | "TweetPreviewDisplay";
  readonly legacy: Readonly<JsonRecord> | null;
};

export type XWebNormalizedUnavailable = {
  readonly kind: "unavailable";
  readonly entryId: string;
  readonly moduleEntryId: string | null;
  readonly sortIndex: string | null;
  readonly typename: string;
  readonly reason: string | null;
};

export type XWebNormalizedOther = {
  readonly kind: "other";
  readonly entryId: string;
  readonly moduleEntryId: string | null;
  readonly sortIndex: string | null;
  readonly itemType: string;
};

export type XWebNormalizedTimelineItem =
  | XWebNormalizedTweet
  | XWebNormalizedUnavailable
  | XWebNormalizedOther;

export type XWebUrtCursor = {
  readonly entryId: string;
  readonly cursorType: string;
  readonly value: string;
};

export type XWebNormalizedTimeline = {
  readonly items: readonly XWebNormalizedTimelineItem[];
  readonly cursors: {
    readonly top: XWebUrtCursor | null;
    readonly bottom: XWebUrtCursor | null;
    readonly other: readonly XWebUrtCursor[];
  };
  readonly duplicateTweetIds: readonly string[];
  readonly terminatedDirections: readonly string[];
  readonly finalEntryCount: number;
};

function optionalString(value: JsonRecord, key: string): string | null {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate !== "string") throw new Error(`X URT ${key} must be a string`);
  return candidate;
}

function timelineEntry(value: unknown, label: string): JsonRecord {
  const entry = record(value, label);
  const entryId = requiredString(entry, "entryId", label);
  if (entryId.length > 512 || hasAsciiControl(entryId)) throw new Error(`${label}.entryId is invalid`);
  record(entry.content, `${label}.content`);
  return entry;
}

function unwrapTweetResult(value: JsonRecord, label: string): {
  readonly result: JsonRecord | null;
  readonly typename: string;
  readonly reason: string | null;
} {
  const typename = requiredString(value, "__typename", label);
  if (typename === "Tweet") return { result: value, typename, reason: null };
  if (typename === "TweetWithVisibilityResults" || typename === "TweetPreviewDisplay") {
    const nested = value.tweet;
    if (isRecord(nested)) return { result: nested, typename, reason: null };
    const nestedResults = isRecord(value.tweet_results) ? value.tweet_results.result : undefined;
    if (isRecord(nestedResults)) return { result: nestedResults, typename, reason: null };
    throw new Error(`X URT ${typename} omitted its nested tweet`);
  }
  const reason = typeof value.reason === "string"
    ? value.reason
    : isRecord(value.tombstone) && typeof value.tombstone.text === "string"
      ? value.tombstone.text
      : null;
  return { result: null, typename, reason };
}

function normalizeItemContent(
  itemValue: unknown,
  entryId: string,
  moduleEntryId: string | null,
  sortIndex: string | null,
): XWebNormalizedTimelineItem {
  const item = record(itemValue, `X URT item ${entryId}`);
  const itemType = requiredString(item, "itemType", `X URT item ${entryId}`);
  if (itemType !== "TimelineTweet") {
    return Object.freeze({ kind: "other", entryId, moduleEntryId, sortIndex, itemType });
  }
  const tweetResults = record(item.tweet_results, `X URT tweet ${entryId}.tweet_results`);
  const resultValue = tweetResults.result;
  if (resultValue === null || resultValue === undefined) {
    return Object.freeze({
      kind: "unavailable",
      entryId,
      moduleEntryId,
      sortIndex,
      typename: "MissingTweetResult",
      reason: null,
    });
  }
  const result = record(resultValue, `X URT tweet ${entryId}.tweet_results.result`);
  const unwrapped = unwrapTweetResult(result, `X URT tweet ${entryId}`);
  if (unwrapped.result === null) {
    return Object.freeze({
      kind: "unavailable",
      entryId,
      moduleEntryId,
      sortIndex,
      typename: unwrapped.typename,
      reason: unwrapped.reason,
    });
  }
  const tweetId = requiredString(unwrapped.result, "rest_id", `X URT tweet ${entryId}`);
  if (!/^[0-9]{1,19}$/u.test(tweetId)) throw new Error(`X URT tweet ${entryId} had an invalid rest_id`);
  const legacy = unwrapped.result.legacy === undefined || unwrapped.result.legacy === null
    ? null
    : Object.freeze(record(unwrapped.result.legacy, `X URT tweet ${entryId}.legacy`));
  return Object.freeze({
    kind: "tweet",
    entryId,
    moduleEntryId,
    sortIndex,
    tweetId,
    typename: unwrapped.typename as XWebNormalizedTweet["typename"],
    legacy,
  });
}

function uniqueDirectionalCursor(cursors: readonly XWebUrtCursor[], type: "Top" | "Bottom"): XWebUrtCursor | null {
  const matching = cursors.filter((cursor) => cursor.cursorType === type);
  if (matching.length === 0) return null;
  const values = new Set(matching.map((cursor) => cursor.value));
  if (matching.length > 1 || values.size > 1) {
    throw new Error(`X URT timeline contained ambiguous ${type.toLowerCase()} cursors`);
  }
  return matching[0]!;
}

/** Normalize current URT add/replace/remove/terminate instructions fail-closed. */
export function normalizeXWebUrtTimeline(value: unknown): XWebNormalizedTimeline {
  const timeline = record(value, "X URT timeline");
  if (!Array.isArray(timeline.instructions)) throw new Error("X URT timeline.instructions must be an array");
  const entries = new Map<string, JsonRecord>();
  const terminatedDirections: string[] = [];
  for (const [instructionIndex, instructionValue] of timeline.instructions.entries()) {
    const label = `X URT instruction ${instructionIndex + 1}`;
    const instruction = record(instructionValue, label);
    const type = requiredString(instruction, "type", label);
    if (type === "TimelineAddEntries") {
      if (!Array.isArray(instruction.entries)) throw new Error(`${label}.entries must be an array`);
      for (const [entryIndex, entryValue] of instruction.entries.entries()) {
        const entry = timelineEntry(entryValue, `${label}.entries[${entryIndex}]`);
        entries.set(requiredString(entry, "entryId", label), entry);
      }
    } else if (type === "TimelineReplaceEntry" || type === "TimelinePinEntry") {
      const entry = timelineEntry(instruction.entry, `${label}.entry`);
      const replacementId = optionalString(instruction, "entryIdToReplace");
      if (replacementId !== null && replacementId !== entry.entryId) entries.delete(replacementId);
      entries.set(requiredString(entry, "entryId", label), entry);
    } else if (type === "TimelineRemoveEntries") {
      if (!Array.isArray(instruction.entryIds) || !instruction.entryIds.every((id) => typeof id === "string")) {
        throw new Error(`${label}.entryIds must be a string array`);
      }
      for (const entryId of instruction.entryIds) entries.delete(entryId);
    } else if (type === "TimelineClearCache") {
      entries.clear();
    } else if (type === "TimelineTerminateTimeline") {
      const direction = requiredString(instruction, "direction", label);
      if (!terminatedDirections.includes(direction)) terminatedDirections.push(direction);
    } else {
      throw new Error(`X URT instruction type ${type} is not reviewed`);
    }
  }

  const items: XWebNormalizedTimelineItem[] = [];
  const cursors: XWebUrtCursor[] = [];
  for (const entry of entries.values()) {
    const entryId = requiredString(entry, "entryId", "X URT entry");
    const sortIndex = optionalString(entry, "sortIndex");
    const content = record(entry.content, `X URT entry ${entryId}.content`);
    const entryType = requiredString(content, "entryType", `X URT entry ${entryId}.content`);
    if (entryType === "TimelineTimelineCursor") {
      const cursorType = requiredString(content, "cursorType", `X URT cursor ${entryId}`);
      const cursorValue = requiredString(content, "value", `X URT cursor ${entryId}`);
      if (cursorValue.length > 16_384 || hasAsciiControl(cursorValue)) {
        throw new Error(`X URT cursor ${entryId} had an invalid value`);
      }
      cursors.push(Object.freeze({ entryId, cursorType, value: cursorValue }));
    } else if (entryType === "TimelineTimelineItem") {
      items.push(normalizeItemContent(content.itemContent, entryId, null, sortIndex));
    } else if (entryType === "TimelineTimelineModule") {
      if (!Array.isArray(content.items)) throw new Error(`X URT module ${entryId}.items must be an array`);
      for (const [moduleIndex, moduleItemValue] of content.items.entries()) {
        const moduleItem = record(moduleItemValue, `X URT module ${entryId}.items[${moduleIndex}]`);
        const moduleItemId = requiredString(moduleItem, "entryId", `X URT module ${entryId}.items[${moduleIndex}]`);
        const itemContainer = record(moduleItem.item, `X URT module item ${moduleItemId}.item`);
        items.push(normalizeItemContent(itemContainer.itemContent, moduleItemId, entryId, sortIndex));
      }
    } else {
      throw new Error(`X URT entry type ${entryType} is not reviewed`);
    }
  }

  const deduplicated: XWebNormalizedTimelineItem[] = [];
  const seenTweetIds = new Set<string>();
  const duplicateTweetIds: string[] = [];
  for (const item of items) {
    if (item.kind !== "tweet") {
      deduplicated.push(item);
      continue;
    }
    if (seenTweetIds.has(item.tweetId)) {
      if (!duplicateTweetIds.includes(item.tweetId)) duplicateTweetIds.push(item.tweetId);
      continue;
    }
    seenTweetIds.add(item.tweetId);
    deduplicated.push(item);
  }
  const top = uniqueDirectionalCursor(cursors, "Top");
  const bottom = uniqueDirectionalCursor(cursors, "Bottom");
  return Object.freeze({
    items: Object.freeze(deduplicated),
    cursors: Object.freeze({
      top,
      bottom,
      other: Object.freeze(cursors.filter((cursor) => cursor.cursorType !== "Top" && cursor.cursorType !== "Bottom")),
    }),
    duplicateTweetIds: Object.freeze(duplicateTweetIds),
    terminatedDirections: Object.freeze(terminatedDirections),
    finalEntryCount: entries.size,
  });
}

export function extractXWebUrtBottomCursor(value: unknown): string | null {
  return normalizeXWebUrtTimeline(value).cursors.bottom?.value ?? null;
}

export type XWebDesiredStateKind = "like" | "bookmark" | "repost";

export type XWebDesiredStateValidation = {
  readonly kind: XWebDesiredStateKind;
  readonly enabled: boolean;
  readonly targetPostId: string;
  readonly providerResultId: string | null;
  readonly requiresReadback: boolean;
};

function exactPostId(value: string): string {
  if (!/^[0-9]{1,19}$/u.test(value)) throw new Error("X desired-state target must be an exact post ID");
  return value;
}

function graphQlData(response: unknown): JsonRecord {
  return responseData(response, "X mutation response");
}

function optionalPostIdentity(result: JsonRecord): string | null {
  if (typeof result.rest_id === "string") return exactPostId(result.rest_id);
  if (isRecord(result.legacy) && typeof result.legacy.id_str === "string") return exactPostId(result.legacy.id_str);
  return null;
}

function nestedRetweetTarget(result: JsonRecord): string | null {
  const candidates = [
    result.retweeted_status_result,
    isRecord(result.legacy) ? result.legacy.retweeted_status_result : undefined,
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.result)) continue;
    const identity = optionalPostIdentity(candidate.result);
    if (identity !== null) return identity;
  }
  return null;
}

/** Validate exact X consumer-web desired-state success markers and identities. */
export function validateXWebDesiredStateMutation(input: {
  readonly kind: XWebDesiredStateKind;
  readonly enabled: boolean;
  readonly targetPostId: string;
  readonly response: unknown;
}): XWebDesiredStateValidation {
  const targetPostId = exactPostId(input.targetPostId);
  const data = graphQlData(input.response);
  if (input.kind === "like") {
    const key = input.enabled ? "favorite_tweet" : "unfavorite_tweet";
    if (data[key] !== "Done") throw new Error(`X ${input.enabled ? "like" : "unlike"} response omitted the exact Done marker`);
    return Object.freeze({ kind: input.kind, enabled: input.enabled, targetPostId, providerResultId: null, requiresReadback: true });
  }
  if (input.kind === "bookmark") {
    const key = input.enabled ? "tweet_bookmark_put" : "tweet_bookmark_delete";
    if (data[key] !== "Done") throw new Error(`X ${input.enabled ? "bookmark" : "unbookmark"} response omitted the exact Done marker`);
    return Object.freeze({ kind: input.kind, enabled: input.enabled, targetPostId, providerResultId: null, requiresReadback: true });
  }
  if (input.kind !== "repost") throw new Error("X desired-state kind is not reviewed");
  if (input.enabled) {
    const create = record(data.create_retweet, "X repost response.create_retweet");
    const results = record(create.retweet_results, "X repost response.retweet_results");
    const result = record(results.result, "X repost response.result");
    const resultId = optionalPostIdentity(result);
    if (resultId === null) throw new Error("X repost response omitted the created repost ID");
    const returnedTarget = nestedRetweetTarget(result);
    if (returnedTarget !== null && returnedTarget !== targetPostId) {
      throw new Error("X repost response targeted a different post");
    }
    return Object.freeze({
      kind: input.kind,
      enabled: true,
      targetPostId,
      providerResultId: resultId,
      requiresReadback: returnedTarget === null,
    });
  }
  const unretweet = record(data.unretweet, "X unrepost response.unretweet");
  const sourceResults = record(unretweet.source_tweet_results, "X unrepost response.source_tweet_results");
  const result = record(sourceResults.result, "X unrepost response.result");
  const returnedTarget = optionalPostIdentity(result);
  if (returnedTarget === null) throw new Error("X unrepost response omitted the source post ID");
  if (returnedTarget !== targetPostId) throw new Error("X unrepost response targeted a different post");
  return Object.freeze({
    kind: input.kind,
    enabled: false,
    targetPostId,
    providerResultId: null,
    requiresReadback: false,
  });
}
