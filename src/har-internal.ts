import { MAX_HAR_BYTES, MAX_HAR_ENTRIES } from "./har";
import { xWebQueryDescriptorEvidenceSnapshot } from "./providers/x-web";
import { readRegularFile, type PrivateDirectoryIdentity } from "./storage";

type JsonRecord = Record<string, unknown>;

export type InternalHarCandidate = {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly operationType: "query" | "mutation" | "unknown";
  readonly sampleCount: number;
  readonly statuses: readonly number[];
  readonly queryNames: readonly string[];
  readonly headerNames: readonly string[];
  readonly requestFieldPaths: readonly string[];
  readonly responseFieldPaths: readonly string[];
  /** Non-secret registered-operation revisions safe to bind into a contract. */
  readonly revisions: readonly string[];
  readonly reviewRequired: true;
};

export type InternalHarEvidence = {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly targetOrigin: string;
  readonly analyzedAt: string;
  readonly observedEntries: number;
  readonly candidates: readonly InternalHarCandidate[];
  readonly warnings: readonly string[];
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const INTERNAL_HAR_REVIEW_BOUNDS = Object.freeze({
  maxArrayItems: 100,
  maxFieldNameCharacters: 4_096,
  maxFieldPaths: 1_000,
  maxFormParameters: 1_000,
  maxHeaderItems: 1_000,
  maxHeaderNames: 200,
  maxCandidates: 2_000,
  maxJsonTextBytes: 2 * 1024 * 1024,
  maxObjectEntries: 300,
  maxPathCharacters: 4_096,
  maxPathSegments: 128,
  maxQueryCharacters: 2 * 1024 * 1024,
  maxQueryIdCharacters: 256,
  maxQueryParameters: 1_000,
  maxRawStringCharacters: 2 * 1024 * 1024,
  maxRevisions: 1_000,
  maxTotalFieldPaths: 20_000,
  maxTotalRevisions: 20_000,
  maxTraversalDepth: 8,
  maxLinkedInArticleTraversalDepth: 12,
  maxUrlCharacters: 4_096 + (2 * 1024 * 1024) + 8_192,
} as const);

const sensitiveName = /(?:authorization|cookie|token|secret|password|passwd|session|credential|private|signature)/iu;
const safeFieldName = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/u;
const safeGraphQlVariableFieldName = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/u;
const safeHeaderName = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;

const reviewedHeaderNames: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "csrf-token",
  "origin",
  "referer",
  "user-agent",
  "x-client-transaction-id",
  "x-csrf-token",
  "x-li-lang",
  "x-restli-id",
  "x-restli-method",
  "x-restli-protocol-version",
  "x-twitter-active-user",
  "x-twitter-auth-type",
  "x-twitter-client-language",
] as const);

/**
 * HAR object keys are untrusted content too. In particular, normalized API
 * responses commonly use account IDs, URNs, names, and slugs as map keys. A
 * lexical identifier check cannot distinguish those values from schema field
 * names, so only this small reviewed vocabulary may survive as a literal.
 * Unknown keys retain their structural position as `:dynamic`.
 */
const reviewedStructuralFieldNames: ReadonlySet<string> = new Set([
  "body",
  "byId",
  "category",
  "conversation_id",
  "conversationUrn",
  "conversations",
  "count",
  "cursor",
  "data",
  "edges",
  "elements",
  "encoded_event",
  "entityUrn",
  "entries",
  "errors",
  "extensions",
  "features",
  "fieldToggles",
  "hasNextPage",
  "hasPreviousPage",
  "id",
  "inbox_initial_state",
  "items",
  "limit",
  "media",
  "message",
  "messages",
  "messengerConversations",
  "messengerMessages",
  "metadata",
  "name",
  "nextCursor",
  "nodes",
  "operationName",
  "pageInfo",
  "paging",
  "payload",
  "previousCursor",
  "public_key",
  "queryId",
  "recipient_ids",
  "response",
  "responsive_web_graphql_enabled",
  "responsive_web_graphql_exclude_directive_enabled",
  "result",
  "results",
  "screen_name",
  "start",
  "subject",
  "text",
  "total",
  "variables",
  "users",
  "withAuxiliaryUserLabels",
] as const);

/** Exact schema vocabulary reviewed only for LinkedIn's native Article route. */
const reviewedLinkedInArticleFieldNames: ReadonlySet<string> = new Set([
  "$set",
  "$type",
  "activityUrn",
  "article",
  "articleType",
  "articleUrn",
  "attributesV2",
  "author",
  "authors",
  "content",
  "contentHtml",
  "caption",
  "coverImage",
  "coverMedia",
  "coverMediaV2Union",
  "createdAt",
  "detailDataUnion",
  "entity",
  "fileSize",
  "filename",
  "firstPartyArticle",
  "firstPartyArticleUrn",
  "hyperlink",
  "included",
  "length",
  "linkedInArticleUrn",
  "mediaUploadType",
  "originalImage",
  "originalImageUrn",
  "patch",
  "permalink",
  "profileUrn",
  "publishedAt",
  "q",
  "state",
  "textBlock",
  "title",
  "type",
  "ugcPostUrn",
  "updatedAt",
  "version",
] as const);

const reviewedPathSegments: ReadonlySet<string> = new Set([
  "2",
  "api",
  "append",
  "articles",
  "chat",
  "comments",
  "conversation",
  "conversations",
  "events",
  "feed",
  "feeds",
  "finalize",
  "graphql",
  "i",
  "inbox",
  "initialize",
  "low_quality",
  "media",
  "message",
  "messages",
  "messaging",
  "notifications",
  "public_keys",
  "publishing",
  "reactions",
  "replies",
  "rest",
  "timeline",
  "trusted",
  "untrusted",
  "upload",
  "users",
  "voyager",
  "voyagerPublishingDashFirstPartyArticles",
] as const);

/** Fields whose object value is a provider-normalized map keyed by IDs/URNs. */
const reviewedDynamicMapFieldNames: ReadonlySet<string> = new Set([
  "byId",
  "conversations",
  "entries",
  "messages",
  "objects",
  "tweets",
  "users",
] as const);

/**
 * Structural capture hints only. They let the sanitizer retain known
 * registered-operation names and revisions from a private HAR; they are not
 * request rules and cannot authorize dispatch. Every LinkedIn web operation
 * remains capture-required in the executable contract registry.
 */
const reviewedLinkedInRegisteredQueries: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["/voyager/api/graphql", new Set(["voyagerFeedDashMainFeed"])],
  ["/voyager/api/voyagerMessagingGraphQL/graphql", new Set([
    "messengerConversations",
    "messengerMailboxCounts",
    "messengerMessages",
  ])],
]);

const reviewedXGraphQlDescriptors: ReadonlyMap<
  string,
  { readonly operationType: "query" | "mutation"; readonly revision: string }
> = new Map(
  xWebQueryDescriptorEvidenceSnapshot.descriptors.map((descriptor) => [
    descriptor.operationName,
    { operationType: descriptor.operationType, revision: descriptor.queryId },
  ]),
);

const reviewedMetaRequestFieldNames: ReadonlySet<string> = new Set([
  "variables",
  "doc_id",
  "fb_api_req_friendly_name",
  "fb_api_caller_class",
  "av",
  "__user",
  "__a",
  "__req",
  "__hs",
  "dpr",
  "__ccg",
  "__rev",
  "__s",
  "__hsi",
  "__dyn",
  "__csr",
  "__comet_req",
  "fb_dtsg",
  "jazoest",
  "lsd",
  "server_timestamps",
] as const);

function isExactFacebookOrigin(url: URL): boolean {
  return url.origin === "https://www.facebook.com";
}

export function isReviewedLinkedInArticleRoute(url: URL): boolean {
  if (url.origin !== "https://www.linkedin.com") return false;
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments[0] !== "voyager"
    || segments[1] !== "api"
    || segments[2] !== "voyagerPublishingDashFirstPartyArticles"
    || (segments.length !== 3 && segments.length !== 4)
  ) return false;
  if (segments.length === 3) return true;
  try {
    return /^urn:li:fsd_firstPartyArticle:[0-9]{1,32}$/u.test(decodeURIComponent(segments[3] ?? ""));
  } catch {
    return false;
  }
}

export function reviewedInternalFieldNameForUrl(url: URL, value: string): string {
  if (
    isReviewedLinkedInArticleRoute(url)
    && value.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
    && safeFieldName.test(value)
    && !sensitiveName.test(value)
    && reviewedLinkedInArticleFieldNames.has(value)
  ) return value;
  return reviewedInternalFieldName(value);
}

function reviewedMetaRequestFieldName(url: URL, value: string): string {
  return isExactFacebookOrigin(url)
    && value.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
    && safeFieldName.test(value)
    && reviewedMetaRequestFieldNames.has(value)
    ? value
    : reviewedInternalFieldNameForUrl(url, value);
}

function isReviewedMetaStructuralContainer(value: string): boolean {
  return !reviewedMetaRequestFieldNames.has(value) || value === "variables";
}

export function reviewedInternalFieldName(value: string): string {
  return value.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
    && safeFieldName.test(value)
    && !sensitiveName.test(value)
    && reviewedStructuralFieldNames.has(value)
    ? value
    : ":dynamic";
}

/**
 * GraphQL top-level variable names are operation schema identifiers rather
 * than caller values. Private review may retain one only for an exact
 * first-party X GraphQL request; values and all nested unknown map keys remain
 * redacted by the ordinary structural reviewer.
 */
export function reviewedXGraphQlVariableFieldName(value: string): string {
  return value.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
    && safeGraphQlVariableFieldName.test(value)
    && !sensitiveName.test(value)
    ? value
    : ":dynamic";
}

export function isReviewedInternalDynamicMapField(value: string): boolean {
  return reviewedDynamicMapFieldNames.has(value);
}

function parseRoot(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !isRecord(value.log) || !Array.isArray(value.log.entries)) {
    throw new Error("HAR must contain log.entries[]");
  }
  if (value.log.entries.length > MAX_HAR_ENTRIES) throw new Error(`HAR contains more than ${MAX_HAR_ENTRIES} entries`);
  return value.log.entries;
}

export type BoundedInternalHarUrl = {
  readonly url: URL;
  readonly pathTruncated: boolean;
  readonly queryTruncated: boolean;
};

function boundedRawQuery(value: string): { readonly value: string; readonly truncated: boolean } {
  if (value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxQueryCharacters) {
    return { value: "", truncated: true };
  }
  let separators = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "&") continue;
    separators += 1;
    if (separators === INTERNAL_HAR_REVIEW_BOUNDS.maxQueryParameters) {
      return { value: value.slice(0, index), truncated: true };
    }
  }
  return { value, truncated: false };
}

function hasTooManyPathSegments(value: string): boolean {
  let segments = 0;
  let insideSegment = false;
  for (const character of value) {
    if (character === "/") {
      insideSegment = false;
      continue;
    }
    if (insideSegment) continue;
    insideSegment = true;
    segments += 1;
    if (segments > INTERNAL_HAR_REVIEW_BOUNDS.maxPathSegments) return true;
  }
  return false;
}

/**
 * Bound the raw URL before asking the platform URL parser to normalize or
 * decode it. Oversized path and query components are replaced with inert
 * placeholders, while a query with too many parameters retains only its
 * bounded prefix.
 */
export function parseBoundedInternalHarUrl(value: string): BoundedInternalHarUrl | null {
  if (value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxUrlCharacters) return null;
  const fragmentIndex = value.indexOf("#");
  const withoutFragment = fragmentIndex === -1 ? value : value.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf("?");
  const withoutQuery = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? "" : withoutFragment.slice(queryIndex + 1);
  const schemeIndex = withoutQuery.indexOf("://");
  const pathStart = schemeIndex === -1 ? -1 : withoutQuery.indexOf("/", schemeIndex + 3);
  const rawPath = pathStart === -1 ? "" : withoutQuery.slice(pathStart);
  const pathTruncated = rawPath.length > INTERNAL_HAR_REVIEW_BOUNDS.maxPathCharacters
    || hasTooManyPathSegments(rawPath);
  const boundedQuery = boundedRawQuery(rawQuery);
  const boundedBase = pathTruncated && pathStart !== -1
    ? `${withoutQuery.slice(0, pathStart)}/:oversized-path`
    : withoutQuery;
  const boundedValue = boundedQuery.value === "" ? boundedBase : `${boundedBase}?${boundedQuery.value}`;
  try {
    return {
      url: new URL(boundedValue),
      pathTruncated,
      queryTruncated: boundedQuery.truncated,
    };
  } catch {
    return null;
  }
}

function reviewedXGraphQlRoute(url: URL): {
  readonly revision: string;
  readonly operation: string;
  readonly reviewed: boolean;
  readonly operationType: "query" | "mutation" | "unknown";
} | null {
  if (url.origin !== "https://x.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 5 || parts[0] !== "i" || parts[1] !== "api" || parts[2] !== "graphql") return null;
  const revision = parts[3];
  const operation = parts[4];
  if (revision === undefined || operation === undefined
    || !/^[A-Za-z0-9_-]{20,64}$/u.test(revision)
    || !/^[A-Z][A-Za-z0-9_]{2,100}$/u.test(operation)
    || url.pathname !== `/i/api/graphql/${revision}/${operation}`) return null;
  const descriptor = reviewedXGraphQlDescriptors.get(operation);
  return {
    revision,
    operation,
    reviewed: descriptor?.revision === revision,
    operationType: descriptor?.revision === revision ? descriptor.operationType : "unknown",
  };
}

function safePath(url: URL): string {
  const { pathname } = url;
  if (
    pathname.length > INTERNAL_HAR_REVIEW_BOUNDS.maxPathCharacters
    || hasTooManyPathSegments(pathname)
  ) return "/:oversized-path";
  if (
    isExactFacebookOrigin(url)
    && (
      pathname === "/api/graphql/"
      || pathname === "/ajax/qm/"
      || pathname === "/data/manifest/"
    )
  ) return pathname;
  const xGraphQl = reviewedXGraphQlRoute(url);
  if (xGraphQl !== null) {
    return xGraphQl.reviewed
      ? `/i/api/graphql/:revision/${xGraphQl.operation}`
      : "/i/api/graphql/:revision/:operation";
  }
  if (url.origin === "https://www.linkedin.com" && reviewedLinkedInRegisteredQueries.has(pathname)) {
    return pathname;
  }
  const rawSegments = pathname.split("/");
  let parameter = 0;
  return rawSegments.map((raw) => {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      parameter += 1;
      return `:segment${parameter}`;
    }
    if (segment === "") return "";
    if (reviewedPathSegments.has(segment)) return segment;
    parameter += 1;
    return `:segment${parameter}`;
  }).join("/");
}

function headerNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const output = new Set<string>();
  const count = Math.min(value.length, INTERNAL_HAR_REVIEW_BOUNDS.maxHeaderItems);
  for (let index = 0; index < count; index += 1) {
    const candidate: unknown = value[index];
    if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
    if (candidate.name.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters) continue;
    const name = candidate.name.toLowerCase();
    if (!safeHeaderName.test(name)) continue;
    output.add(reviewedHeaderNames.has(name) ? name : ":dynamic");
    if (output.size >= INTERNAL_HAR_REVIEW_BOUNDS.maxHeaderNames) break;
  }
  return [...output].sort();
}

function addFieldPaths(
  value: unknown,
  output: Set<string>,
  prefix = "",
  depth = 0,
  redactObjectKeys = false,
  fieldNameReviewer: (value: string) => string = reviewedInternalFieldName,
  shouldTraverseField: (value: string) => boolean = () => true,
  maximumDepth: number = INTERNAL_HAR_REVIEW_BOUNDS.maxTraversalDepth,
): void {
  if (
    depth >= maximumDepth
    || output.size >= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldPaths
  ) return;
  if (Array.isArray(value)) {
    const count = Math.min(value.length, INTERNAL_HAR_REVIEW_BOUNDS.maxArrayItems);
    for (let index = 0; index < count; index += 1) {
      addFieldPaths(
        value[index],
        output,
        `${prefix}[]`,
        depth + 1,
        false,
        fieldNameReviewer,
        shouldTraverseField,
        maximumDepth,
      );
      if (output.size >= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldPaths) return;
    }
    return;
  }
  if (!isRecord(value)) return;
  let inspected = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (inspected >= INTERNAL_HAR_REVIEW_BOUNDS.maxObjectEntries) return;
    inspected += 1;
    const child = value[key];
    const renderedKey = redactObjectKeys ? ":dynamic" : fieldNameReviewer(key);
    const path = prefix === "" ? renderedKey : `${prefix}.${renderedKey}`;
    output.add(path);
    if (!redactObjectKeys && !shouldTraverseField(key)) continue;
    addFieldPaths(
      child,
      output,
      path,
      depth + 1,
      !redactObjectKeys && isRecord(child) && reviewedDynamicMapFieldNames.has(key),
      fieldNameReviewer,
      shouldTraverseField,
      maximumDepth,
    );
    if (output.size >= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldPaths) return;
  }
}

function parsedJson(value: unknown): unknown {
  if (
    typeof value !== "string"
    || value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxRawStringCharacters
    || Buffer.byteLength(value, "utf8") > INTERNAL_HAR_REVIEW_BOUNDS.maxJsonTextBytes
  ) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

type BoundedFormParameters = {
  readonly parameters: readonly JsonRecord[];
  readonly truncated: boolean;
};

function boundedFormParameters(postData: JsonRecord): BoundedFormParameters | null {
  if (Array.isArray(postData.params)) {
    return {
      parameters: postData.params
        .slice(0, INTERNAL_HAR_REVIEW_BOUNDS.maxFormParameters)
        .filter(isRecord),
      truncated: postData.params.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFormParameters,
    };
  }
  const rawMime = postData.mimeType;
  const mime = typeof rawMime === "string"
    && rawMime.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
    ? rawMime.toLowerCase()
    : "";
  const text = postData.text;
  if (
    !mime.includes("application/x-www-form-urlencoded")
    || typeof text !== "string"
    || text.length > INTERNAL_HAR_REVIEW_BOUNDS.maxRawStringCharacters
    || Buffer.byteLength(text, "utf8") > INTERNAL_HAR_REVIEW_BOUNDS.maxJsonTextBytes
  ) return null;
  const output: JsonRecord[] = [];
  for (const [name, value] of new URLSearchParams(text)) {
    if (output.length >= INTERNAL_HAR_REVIEW_BOUNDS.maxFormParameters) {
      return { parameters: output, truncated: true };
    }
    output.push({ name, value });
  }
  return { parameters: output, truncated: false };
}

function requestFields(request: JsonRecord, url: URL): readonly string[] {
  if (!isRecord(request.postData)) return [];
  let value: unknown = null;
  const rawMime = request.postData.mimeType;
  const mime = typeof rawMime === "string"
    && rawMime.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
    ? rawMime.toLowerCase()
    : "";
  if (mime.includes("json")) value = parsedJson(request.postData.text);
  else {
    const form = boundedFormParameters(request.postData);
    if (form === null) return [];
    const fields = new Set<string>();
    const count = Math.min(
      form.parameters.length,
      INTERNAL_HAR_REVIEW_BOUNDS.maxFormParameters,
    );
    for (let index = 0; index < count; index += 1) {
      const candidate: unknown = form.parameters[index];
      if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
      const renderedName = reviewedMetaRequestFieldName(url, candidate.name);
      fields.add(renderedName);
      if (
        isExactFacebookOrigin(url)
        && candidate.name === "variables"
        && typeof candidate.value === "string"
      ) {
        const parsedVariables = parsedJson(candidate.value);
        if (parsedVariables === null) continue;
        const variableFields = new Set<string>();
        addFieldPaths(
          parsedVariables,
          variableFields,
          "",
          0,
          false,
          (fieldName) => reviewedMetaRequestFieldName(url, fieldName),
          isReviewedMetaStructuralContainer,
        );
        for (const field of variableFields) fields.add(`variables.${field}`);
      }
    }
    return [...fields].sort();
  }
  const fields = new Set<string>();
  addFieldPaths(
    value,
    fields,
    "",
    0,
    false,
    (fieldName) => reviewedMetaRequestFieldName(url, fieldName),
    isExactFacebookOrigin(url) ? isReviewedMetaStructuralContainer : undefined,
    isReviewedLinkedInArticleRoute(url)
      ? INTERNAL_HAR_REVIEW_BOUNDS.maxLinkedInArticleTraversalDepth
      : INTERNAL_HAR_REVIEW_BOUNDS.maxTraversalDepth,
  );
  const xGraphQl = reviewedXGraphQlRoute(url);
  if (
    request.method === "POST"
    && xGraphQl?.reviewed === true
    && isRecord(value)
    && isRecord(value.variables)
  ) {
    let inspected = 0;
    for (const key in value.variables) {
      if (!Object.prototype.hasOwnProperty.call(value.variables, key)) continue;
      if (inspected >= INTERNAL_HAR_REVIEW_BOUNDS.maxObjectEntries) break;
      inspected += 1;
      fields.add(`variables.${reviewedXGraphQlVariableFieldName(key)}`);
      if (fields.size >= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldPaths) break;
    }
  }
  return [...fields].sort();
}

function queryStructuralFields(url: URL): readonly string[] {
  const output = new Set<string>();
  const fieldNameReviewer = (fieldName: string): string =>
    reviewedMetaRequestFieldName(url, fieldName);
  for (const name of ["variables", "features", "fieldToggles"] as const) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.length > INTERNAL_HAR_REVIEW_BOUNDS.maxRawStringCharacters) continue;
    const parsed = parsedJson(raw);
    if (parsed !== null) {
      const fields = new Set<string>();
      addFieldPaths(
        parsed,
        fields,
        "",
        0,
        false,
        fieldNameReviewer,
        isExactFacebookOrigin(url) ? isReviewedMetaStructuralContainer : undefined,
      );
      for (const field of fields) output.add(`query.${name}.${field}`);
      continue;
    }
    if (name !== "variables") continue;
    for (const match of raw.matchAll(/(?:^|[,(])([A-Za-z_$][A-Za-z0-9_$]{0,127}):/gu)) {
      const field = match[1];
      if (field !== undefined) output.add(`query.variables.${fieldNameReviewer(field)}`);
    }
  }
  return [...output].sort();
}

function parsedMetaGraphQlDocuments(value: string): readonly unknown[] {
  if (
    value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxRawStringCharacters
    || Buffer.byteLength(value, "utf8") > INTERNAL_HAR_REVIEW_BOUNDS.maxJsonTextBytes
  ) return [];
  let payload = value.trimStart();
  if (payload.startsWith("for (;;);")) payload = payload.slice("for (;;);".length).trimStart();
  const whole = parsedJson(payload);
  if (whole !== null) return [whole];
  const lines = payload.split(/\r?\n/u);
  if (lines.length > INTERNAL_HAR_REVIEW_BOUNDS.maxArrayItems) return [];
  const documents: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = parsedJson(trimmed);
    if (parsed === null) return [];
    documents.push(parsed);
  }
  return documents;
}

function responseFields(response: unknown, url: URL): readonly string[] {
  if (!isRecord(response) || !isRecord(response.content)) return [];
  const rawMime = response.content.mimeType;
  const mime = typeof rawMime === "string"
    && rawMime.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
    ? rawMime.toLowerCase()
    : "";
  const facebookGraphQl = isExactFacebookOrigin(url) && url.pathname === "/api/graphql/";
  if (
    !mime.includes("json")
    && !(
      facebookGraphQl
      && (
        mime.includes("text/javascript")
        || mime.includes("text/plain")
        || mime.includes("text/html")
      )
    )
  ) return [];
  const fields = new Set<string>();
  const documents = facebookGraphQl && typeof response.content.text === "string"
    ? parsedMetaGraphQlDocuments(response.content.text)
    : [parsedJson(response.content.text)];
  for (const document of documents) {
    addFieldPaths(
      document,
      fields,
      "",
      0,
      false,
      (fieldName) => reviewedMetaRequestFieldName(url, fieldName),
      isExactFacebookOrigin(url) ? isReviewedMetaStructuralContainer : undefined,
      isReviewedLinkedInArticleRoute(url)
        ? INTERNAL_HAR_REVIEW_BOUNDS.maxLinkedInArticleTraversalDepth
        : INTERNAL_HAR_REVIEW_BOUNDS.maxTraversalDepth,
    );
    if (fields.size >= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldPaths) break;
  }
  return [...fields].sort();
}

function metaRegisteredOperationRevision(
  url: URL,
  method: string,
  request: JsonRecord,
): string | null {
  if (
    !isExactFacebookOrigin(url)
    || method !== "POST"
    || url.pathname !== "/api/graphql/"
    || !isRecord(request.postData)
  ) return null;
  const form = boundedFormParameters(request.postData);
  if (form === null || form.truncated) return null;
  const friendlyNames: unknown[] = [];
  const documentIds: unknown[] = [];
  for (const candidate of form.parameters) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
    if (candidate.name === "fb_api_req_friendly_name") friendlyNames.push(candidate.value);
    if (candidate.name === "doc_id") documentIds.push(candidate.value);
  }
  if (friendlyNames.length !== 1 || documentIds.length !== 1) return null;
  const friendlyName = friendlyNames[0];
  const documentId = documentIds[0];
  if (
    typeof friendlyName !== "string"
    || typeof documentId !== "string"
    || friendlyName.length > 161
    || documentId.length > 32
    || !/^[A-Za-z][A-Za-z0-9_]{2,160}$/u.test(friendlyName)
    || !/^[0-9]{5,32}$/u.test(documentId)
  ) return null;
  return `meta=${friendlyName}.${documentId}`;
}

function revisionValues(url: URL, method: string, request: JsonRecord): readonly string[] {
  const values: string[] = [];
  if (url.origin === "https://www.linkedin.com" && method === "GET") {
    const prefixes = reviewedLinkedInRegisteredQueries.get(url.pathname);
    if (prefixes !== undefined) {
      for (const value of url.searchParams.getAll("queryId")) {
        if (value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxQueryIdCharacters) continue;
        const separator = value.lastIndexOf(".");
        const prefix = value.slice(0, separator);
        const revision = value.slice(separator + 1);
        if (prefixes.has(prefix) && /^[a-f0-9]{32}$/u.test(revision)) values.push(`queryId=${value}`);
      }
    }
  }
  const xGraphQl = reviewedXGraphQlRoute(url);
  if (xGraphQl?.reviewed === true) values.push(`graphql=${xGraphQl.operation}.${xGraphQl.revision}`);
  const metaRevision = metaRegisteredOperationRevision(url, method, request);
  if (metaRevision !== null) values.push(metaRevision);
  return values;
}

function registeredOperationType(
  url: URL,
  revision: string | null,
): InternalHarCandidate["operationType"] {
  if (revision === null) return "unknown";
  const xGraphQl = reviewedXGraphQlRoute(url);
  if (xGraphQl?.reviewed === true) return xGraphQl.operationType;
  if (revision.startsWith("queryId=")) return "query";
  // Meta friendly names are labels, not authoritative GraphQL syntax. Keep
  // their type unknown until a code-owned reviewed descriptor supplies it.
  return "unknown";
}

type Accumulator = {
  method: string;
  origin: string;
  path: string;
  operationType: InternalHarCandidate["operationType"];
  semanticRevision: string | null;
  sampleCount: number;
  statuses: Set<number>;
  queryNames: Set<string>;
  headerNames: Set<string>;
  requestFieldPaths: Set<string>;
  responseFieldPaths: Set<string>;
  revisions: Set<string>;
};

type CandidateCount = {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly operationType: InternalHarCandidate["operationType"];
  readonly semanticRevision: string | null;
  sampleCount: number;
};

type ReviewedEntry = {
  readonly entry: JsonRecord;
  readonly request: JsonRecord;
  readonly method: string;
  readonly url: URL;
  readonly key: string;
  readonly path: string;
  readonly operationType: InternalHarCandidate["operationType"];
  readonly semanticRevision: string | null;
};

function reviewedEntry(
  entry: unknown,
  targetOrigin: string,
): ReviewedEntry | null {
  if (
    !isRecord(entry)
    || !isRecord(entry.request)
    || typeof entry.request.url !== "string"
    || typeof entry.request.method !== "string"
    || entry.request.method.length > 16
  ) return null;
  const boundedUrl = parseBoundedInternalHarUrl(entry.request.url);
  if (boundedUrl === null) return null;
  const { url } = boundedUrl;
  if (url.origin !== targetOrigin || url.username !== "" || url.password !== "") return null;
  const method = entry.request.method.toUpperCase();
  if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/u.test(method)) return null;
  if (/\.(?:css|js|png|jpe?g|gif|svg|woff2?|ico|map)$/iu.test(url.pathname)) return null;
  const path = boundedUrl.pathTruncated ? "/:oversized-path" : safePath(url);
  const revisions = [...new Set(revisionValues(url, method, entry.request))];
  const semanticRevision = revisions.length === 1 ? revisions[0] ?? null : null;
  const operationType = registeredOperationType(url, semanticRevision);
  return {
    entry,
    request: entry.request,
    method,
    url,
    key: `${method}\0${path}\0${semanticRevision ?? ""}`,
    path,
    operationType,
    semanticRevision,
  };
}

function compareCandidateCounts(left: CandidateCount, right: CandidateCount): number {
  return right.sampleCount - left.sampleCount
    || left.path.localeCompare(right.path)
    || left.method.localeCompare(right.method)
    || (left.semanticRevision ?? "").localeCompare(right.semanticRevision ?? "");
}

/**
 * Retain the exact non-secret names needed to review a first-party API
 * contract. No URL values, headers, cookies, body values, or response values
 * survive this analyzer.
 */
export function analyzeInternalHarValue(
  value: unknown,
  adapterId: string,
  targetOrigin: string,
  now = new Date(),
): InternalHarEvidence {
  const target = new URL(targetOrigin);
  if (target.protocol !== "https:" || target.origin !== targetOrigin) throw new Error("target origin must be exact HTTPS");
  const entries = parseRoot(value);
  const counts = new Map<string, CandidateCount>();
  const reviewedKeys: (string | null)[] = [];
  for (const entry of entries) {
    const reviewed = reviewedEntry(entry, target.origin);
    reviewedKeys.push(reviewed?.key ?? null);
    if (reviewed === null) continue;
    const current = counts.get(reviewed.key) ?? {
      method: reviewed.method,
      origin: reviewed.url.origin,
      path: reviewed.path,
      operationType: reviewed.operationType,
      semanticRevision: reviewed.semanticRevision,
      sampleCount: 0,
    };
    current.sampleCount += 1;
    counts.set(reviewed.key, current);
  }

  const selectedCounts = [...counts.entries()]
    .sort((left, right) => compareCandidateCounts(left[1], right[1]))
    .slice(0, INTERNAL_HAR_REVIEW_BOUNDS.maxCandidates);
  const candidates = new Map<string, Accumulator>(selectedCounts.map(([key, candidate]) => [
    key,
    {
      ...candidate,
      statuses: new Set<number>(),
      queryNames: new Set<string>(),
      headerNames: new Set<string>(),
      requestFieldPaths: new Set<string>(),
      responseFieldPaths: new Set<string>(),
      revisions: new Set<string>(),
    },
  ]));
  const selectedEntries = new Map<string, unknown[]>(
    selectedCounts.map(([key]) => [key, []]),
  );
  for (let index = 0; index < entries.length; index += 1) {
    const key = reviewedKeys[index];
    if (key === undefined || key === null) continue;
    selectedEntries.get(key)?.push(entries[index]);
  }
  let retainedFieldPaths = 0;
  let retainedRevisions = 0;
  const addFieldPath = (output: Set<string>, value: string): void => {
    if (
      output.has(value)
      || output.size >= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldPaths
      || retainedFieldPaths >= INTERNAL_HAR_REVIEW_BOUNDS.maxTotalFieldPaths
    ) return;
    output.add(value);
    retainedFieldPaths += 1;
  };
  const addRevision = (output: Set<string>, value: string): void => {
    if (
      output.has(value)
      || output.size >= INTERNAL_HAR_REVIEW_BOUNDS.maxRevisions
      || retainedRevisions >= INTERNAL_HAR_REVIEW_BOUNDS.maxTotalRevisions
    ) return;
    output.add(value);
    retainedRevisions += 1;
  };

  // Enrich in the same deterministic rank order exposed to the reviewer so a
  // low-ranked prefix of the raw HAR cannot consume the global evidence
  // budget before a frequently observed candidate is processed.
  for (const [key] of selectedCounts) {
    const current = candidates.get(key);
    if (current === undefined) continue;
    for (const entry of selectedEntries.get(key) ?? []) {
      const reviewed = reviewedEntry(entry, target.origin);
      if (reviewed === null || reviewed.key !== key) continue;
      if (
        isRecord(reviewed.entry.response)
        && typeof reviewed.entry.response.status === "number"
        && Number.isSafeInteger(reviewed.entry.response.status)
        && (
          reviewed.entry.response.status === 0
          || (reviewed.entry.response.status >= 100 && reviewed.entry.response.status <= 599)
        )
      ) {
        current.statuses.add(reviewed.entry.response.status);
      }
      for (const name of reviewed.url.searchParams.keys()) {
        if (name.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters) continue;
        const renderedName = reviewedMetaRequestFieldName(reviewed.url, name);
        if (sensitiveName.test(name) && renderedName === ":dynamic") continue;
        current.queryNames.add(renderedName);
      }
      for (const name of headerNames(reviewed.request.headers)) current.headerNames.add(name);
      for (const pathName of requestFields(reviewed.request, reviewed.url)) {
        addFieldPath(current.requestFieldPaths, pathName);
      }
      for (const pathName of queryStructuralFields(reviewed.url)) addFieldPath(current.requestFieldPaths, pathName);
      for (const pathName of responseFields(reviewed.entry.response, reviewed.url)) {
        addFieldPath(current.responseFieldPaths, pathName);
      }
      for (const revision of revisionValues(reviewed.url, reviewed.method, reviewed.request)) {
        addRevision(current.revisions, revision);
      }
    }
  }
  return {
    schemaVersion: 1,
    adapterId,
    targetOrigin,
    analyzedAt: now.toISOString(),
    observedEntries: entries.length,
    candidates: [...candidates.values()]
      .sort(compareCandidateCounts)
      .map((candidate) => ({
        method: candidate.method,
        origin: candidate.origin,
        path: candidate.path,
        operationType: candidate.operationType,
        sampleCount: candidate.sampleCount,
        statuses: [...candidate.statuses].sort((left, right) => left - right),
        queryNames: [...candidate.queryNames].sort(),
        headerNames: [...candidate.headerNames].sort(),
        requestFieldPaths: [...candidate.requestFieldPaths].sort(),
        responseFieldPaths: [...candidate.responseFieldPaths].sort(),
        revisions: [...candidate.revisions].sort(),
        reviewRequired: true,
      })),
    warnings: [
      "This evidence is inert: every operation still requires a reviewed semantic contract before execution.",
      "operationType is authoritative only for reviewed route facts; Meta friendly-name evidence remains unknown until bound to a code-owned descriptor.",
      "Only first-party paths, names, structural field paths, and registered-operation revisions are retained; all credential and content values are discarded.",
      "Candidate, structural-field, and registered-revision evidence is bounded; lower-ranked candidates and excess fields or revisions may be omitted.",
    ],
  };
}

export function analyzeInternalHarFile(
  path: string,
  adapterId: string,
  targetOrigin: string,
  expectedParent?: Readonly<PrivateDirectoryIdentity>,
): InternalHarEvidence {
  return analyzeInternalHarValue(
    JSON.parse(readRegularFile(path, MAX_HAR_BYTES, "HAR input", expectedParent)) as unknown,
    adapterId,
    targetOrigin,
  );
}
