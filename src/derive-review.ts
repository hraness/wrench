import { MAX_HAR_ENTRIES } from "./har";
import {
  analyzeInternalHarValue,
  INTERNAL_HAR_REVIEW_BOUNDS,
  isReviewedLinkedInArticleRoute,
  isReviewedInternalDynamicMapField,
  isReviewedTwitchGraphQlRoute,
  parseBoundedInternalHarUrl,
  reviewedInternalFieldNameForUrl,
  reviewedXGraphQlVariableFieldName,
  type BoundedInternalHarUrl,
  type InternalHarCandidate,
} from "./har-internal";

type JsonRecord = Record<string, unknown>;

const MAX_REVIEW_LIMIT = 100;
const MAX_FIXTURES = 50;
const MAX_FIXTURE_VALUE_BYTES = 16 * 1024;
const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_MATCHES_PER_FIXTURE = 100;
const MAX_FIELD_NAMES = 50;
const MAX_FIELD_NAME_CHARACTERS = 128;
const MAX_WALK_NODES = 10_000;
const MAX_WALK_DEPTH = INTERNAL_HAR_REVIEW_BOUNDS.maxTraversalDepth;
const MAX_ARRAY_ITEMS = INTERNAL_HAR_REVIEW_BOUNDS.maxArrayItems;
const MAX_OBJECT_ENTRIES = INTERNAL_HAR_REVIEW_BOUNDS.maxObjectEntries;
const MAX_OBJECT_KEY_INSPECTIONS = INTERNAL_HAR_REVIEW_BOUNDS.maxObjectEntries;
const MAX_FORM_PARAMETERS = INTERNAL_HAR_REVIEW_BOUNDS.maxFormParameters;
const MAX_FORM_NAME_BYTES = INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters;
const MAX_JSON_TEXT_BYTES = INTERNAL_HAR_REVIEW_BOUNDS.maxJsonTextBytes;
const MAX_PATH_SEGMENTS = INTERNAL_HAR_REVIEW_BOUNDS.maxPathSegments;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sensitiveCredentialTokens: ReadonlySet<string> = new Set([
  "auth",
  "authentication",
  "authorization",
  "assertion",
  "basic",
  "bearer",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "creds",
  "csrf",
  "header",
  "headers",
  "hmac",
  "jwt",
  "keytab",
  "login",
  "macaroon",
  "nonce",
  "oauth",
  "otp",
  "passphrase",
  "passcode",
  "passwd",
  "password",
  "pin",
  "private",
  "pwd",
  "saml",
  "secret",
  "secrets",
  "session",
  "sid",
  "signature",
  "signin",
  "signon",
  "sso",
  "token",
  "tokens",
  "xsrf",
]);

const compactCredentialAlias =
  /(?:authorization|authentication|oauth|bearer|jwt|csrf|xsrf|apikey|accesskey|accesstoken|refreshtoken|idtoken|clientsecret|privatekey|password|passwd|passphrase|credential|cookie|session|jsessionid|phpsessid|signature|hmac)/u;

function credentialKeyTokens(value: string): readonly string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter((part) => part.length > 0);
}

function isSensitiveCredentialKey(value: string): boolean {
  // An oversized key is not safe to classify: avoid allocating normalized
  // copies of attacker-controlled text and treat its whole subtree as opaque.
  if (value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters) return true;
  const tokens = credentialKeyTokens(value);
  if (tokens.some((token) => sensitiveCredentialTokens.has(token))) return true;
  for (let index = 1; index < tokens.length; index += 1) {
    if (
      tokens[index] === "key"
      && ["access", "api", "client", "private", "secret"].includes(tokens[index - 1] ?? "")
    ) return true;
  }
  const compact = tokens.join("");
  if (compact === "") return false;
  if (compactCredentialAlias.test(compact)) return true;
  if (
    compact === "auth"
    || compact.endsWith("auth")
    || (compact.startsWith("auth") && !compact.startsWith("author"))
    || compact.endsWith("token")
    || compact.endsWith("tokens")
    || compact.endsWith("secret")
    || compact.endsWith("secrets")
    || compact.endsWith("sid")
    || compact.endsWith("header")
    || compact.endsWith("headers")
  ) return true;
  return false;
}

function isSensitiveCredentialKeyForExchange(
  twitchGraphQlPostExchange: boolean,
  value: string,
): boolean {
  if (
    twitchGraphQlPostExchange
    && (value === "channelLogin" || value === "login")
  ) return false;
  return isSensitiveCredentialKey(value);
}

function isExactMimeType(value: string, expected: string): boolean {
  return value.split(";", 1)[0]?.trim() === expected;
}

export type DerivationReviewFixtures = Readonly<Record<string, string>>;
export type DerivationReviewFieldNames = readonly string[];

export type DerivationReviewSelection =
  | { readonly kind: "list"; readonly offset: number; readonly limit: number }
  | {
      readonly kind: "entry";
      readonly entryIndex: number;
      readonly fixtures: DerivationReviewFixtures;
      readonly fieldNames?: never;
    }
  | {
      readonly kind: "entry";
      readonly entryIndex: number;
      readonly fixtures?: never;
      readonly fieldNames: DerivationReviewFieldNames;
    };

export type DerivationReviewListEntry = {
  readonly entryIndex: number;
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly operationType: InternalHarCandidate["operationType"];
  readonly statuses: readonly number[];
  readonly queryNames: readonly string[];
  readonly revisions: readonly string[];
  readonly requestFieldCount: number;
  readonly responseFieldCount: number;
};

export type DerivationReviewMatch = {
  readonly label: string;
  readonly locations: readonly string[];
  readonly truncated: boolean;
};

export type DerivationReviewFieldNameMatch = {
  readonly candidateIndex: number;
  readonly locations: readonly string[];
  readonly truncated: boolean;
  readonly valueTypes: readonly DerivationReviewFieldValueType[];
};

export type DerivationReviewFieldValueType =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "array"
  | "object";

export type DerivationReviewResult =
  | {
      readonly schemaVersion: 1;
      readonly kind: "list";
      readonly targetOrigin: string;
      readonly totalHarEntries: number;
      readonly reviewableEntries: number;
      readonly offset: number;
      readonly limit: number;
      readonly nextOffset: number | null;
      readonly entries: readonly DerivationReviewListEntry[];
      readonly warnings: readonly string[];
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "entry";
      readonly targetOrigin: string;
      readonly totalHarEntries: number;
      readonly entryIndex: number;
      readonly structure: InternalHarCandidate;
      readonly fixtureMatches: readonly DerivationReviewMatch[];
      readonly fieldNameMatches: readonly DerivationReviewFieldNameMatch[];
      readonly warnings: readonly string[];
    };

function parseReviewFixtures(
  value: unknown,
  minimumEntries: 0 | 1,
): DerivationReviewFixtures {
  if (!isRecord(value)) throw new Error("review fixtures must be a JSON object");
  const entries: [string, unknown][] = [];
  for (const label in value) {
    if (!Object.prototype.hasOwnProperty.call(value, label)) continue;
    if (entries.length >= MAX_FIXTURES) {
      throw new Error(`review fixtures must contain ${minimumEntries}-${MAX_FIXTURES} labeled string values`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, label);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("review fixture properties must be plain values");
    }
    entries.push([label, descriptor.value]);
  }
  if (entries.length < minimumEntries) {
    throw new Error(`review fixtures must contain ${minimumEntries}-${MAX_FIXTURES} labeled string values`);
  }
  let totalBytes = 0;
  const fixtures: Record<string, string> = {};
  for (const [label, fixture] of entries) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(label)) {
      throw new Error("review fixture labels must be lowercase identifiers containing only letters, digits, underscore, or hyphen");
    }
    if (typeof fixture !== "string") throw new Error(`review fixture ${label} must be a string`);
    const bytes = Buffer.byteLength(fixture, "utf8");
    if (bytes < 1 || bytes > MAX_FIXTURE_VALUE_BYTES) {
      throw new Error(`review fixture ${label} must contain 1-${MAX_FIXTURE_VALUE_BYTES} UTF-8 bytes`);
    }
    totalBytes += bytes + Buffer.byteLength(label, "utf8");
    if (totalBytes > MAX_FIXTURE_BYTES) throw new Error(`review fixtures exceed ${MAX_FIXTURE_BYTES} UTF-8 bytes`);
    fixtures[label] = fixture;
  }
  return Object.freeze(fixtures);
}

export function parseDerivationReviewFixtures(value: unknown): DerivationReviewFixtures {
  return parseReviewFixtures(value, 1);
}

export function parseDerivationReviewFieldNames(
  value: unknown,
): DerivationReviewFieldNames {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FIELD_NAMES) {
    throw new Error(`review field names must be a JSON array containing 1-${MAX_FIELD_NAMES} unique strings`);
  }
  const ownKeys = Reflect.ownKeys(Object.getOwnPropertyDescriptors(value));
  if (
    ownKeys.some((key) =>
      typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)))
    || ownKeys.length !== value.length + 1
  ) {
    throw new Error("review field names must be a plain JSON array");
  }
  const names: string[] = [];
  const unique = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("review field name entries must be plain values");
    }
    const candidate = descriptor.value;
    if (
      typeof candidate !== "string"
      || candidate.length < 1
      || candidate.length > MAX_FIELD_NAME_CHARACTERS
      || !/^[_A-Za-z$][_0-9A-Za-z$.-]{0,127}$/u.test(candidate)
    ) {
      throw new Error("review field names must be bounded schema-key strings");
    }
    if (isSensitiveCredentialKey(candidate)) {
      throw new Error("review field names must not identify credential-like schema keys");
    }
    if (unique.has(candidate)) {
      throw new Error("review field names must be unique exact strings");
    }
    unique.add(candidate);
    names.push(candidate);
  }
  return Object.freeze(names);
}

function parseHarEntries(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !isRecord(value.log) || !Array.isArray(value.log.entries)) {
    throw new Error("private review HAR must contain log.entries[]");
  }
  if (value.log.entries.length > MAX_HAR_ENTRIES) {
    throw new Error(`private review HAR contains more than ${MAX_HAR_ENTRIES} entries`);
  }
  return value.log.entries;
}

function exactTarget(value: string): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error("private review target origin is invalid");
  }
  if (target.protocol !== "https:" || target.origin !== value || target.username !== "" || target.password !== "") {
    throw new Error("private review target must be an exact HTTPS origin");
  }
  return target;
}

function reviewableRequest(
  entry: unknown,
  targetOrigin: string,
): ({ readonly entry: JsonRecord } & BoundedInternalHarUrl) | null {
  if (!isRecord(entry) || !isRecord(entry.request)) return null;
  if (typeof entry.request.url !== "string" || typeof entry.request.method !== "string") return null;
  const boundedUrl = parseBoundedInternalHarUrl(entry.request.url);
  if (boundedUrl === null || entry.request.method.length > 16) return null;
  const { url } = boundedUrl;
  const method = entry.request.method.toUpperCase();
  if (
    url.origin !== targetOrigin
    || url.username !== ""
    || url.password !== ""
    || !/^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/u.test(method)
    || /\.(?:css|js|png|jpe?g|gif|svg|woff2?|ico|map)$/iu.test(url.pathname)
  ) return null;
  return { entry, ...boundedUrl };
}

function exactCandidate(entry: unknown, targetOrigin: string): InternalHarCandidate | null {
  const evidence = analyzeInternalHarValue(
    { log: { entries: [entry] } },
    "private-review",
    targetOrigin,
    new Date("2000-01-01T00:00:00.000Z"),
  );
  return evidence.candidates.length === 1 ? evidence.candidates[0] ?? null : null;
}

type MatchState = {
  readonly values: readonly { readonly label: string; readonly value: string }[];
  readonly locations: Map<string, Set<string>>;
  readonly truncated: Set<string>;
  readonly fieldNames: readonly string[];
  readonly fieldNameLocations: readonly Set<string>[];
  readonly fieldNameTruncated: Set<number>;
  readonly fieldNameValueTypes: readonly Set<DerivationReviewFieldValueType>[];
  readonly twitchGraphQlPostExchange: boolean;
  readonly xGraphQlRequest: boolean;
  readonly url: URL;
  readonly maximumDepth: number;
  visited: number;
};

type JsonObjectKeyReview = "structural" | "x-graphql-variable";

function addMatch(state: MatchState, label: string, location: string): void {
  const locations = state.locations.get(label);
  if (locations === undefined) return;
  if (locations.has(location)) return;
  if (locations.size >= MAX_MATCHES_PER_FIXTURE) {
    state.truncated.add(label);
    return;
  }
  locations.add(location);
}

function truncateEveryFixture(state: MatchState): void {
  for (const fixture of state.values) state.truncated.add(fixture.label);
  for (let candidateIndex = 0; candidateIndex < state.fieldNames.length; candidateIndex += 1) {
    state.fieldNameTruncated.add(candidateIndex);
  }
}

function matchObjectKey(
  state: MatchState,
  key: string,
  location: string,
  redactObjectKeys: boolean,
  value: unknown,
): void {
  if (redactObjectKeys) return;
  const valueType: DerivationReviewFieldValueType | null = value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "boolean"
        ? "boolean"
        : typeof value === "number"
          ? "number"
          : typeof value === "string"
            ? "string"
            : isRecord(value)
              ? "object"
              : null;
  for (let candidateIndex = 0; candidateIndex < state.fieldNames.length; candidateIndex += 1) {
    if (key !== state.fieldNames[candidateIndex]) continue;
    if (valueType === null) {
      state.fieldNameTruncated.add(candidateIndex);
      continue;
    }
    state.fieldNameValueTypes[candidateIndex]?.add(valueType);
    const locations = state.fieldNameLocations[candidateIndex];
    if (locations === undefined || locations.has(location)) continue;
    if (locations.size >= MAX_MATCHES_PER_FIXTURE) {
      state.fieldNameTruncated.add(candidateIndex);
      continue;
    }
    locations.add(location);
  }
}

function hasSearchableContent(state: MatchState, value: unknown): boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (!isRecord(value)) return false;
  let inspected = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (inspected >= MAX_OBJECT_KEY_INSPECTIONS) return true;
    inspected += 1;
    if (key.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters) return true;
    if (!isSensitiveCredentialKeyForExchange(state.twitchGraphQlPostExchange, key)) return true;
  }
  return false;
}

function matchPrimitive(state: MatchState, value: unknown, location: string): void {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
  const rendered = String(value);
  for (const fixture of state.values) {
    if (rendered === fixture.value) addMatch(state, fixture.label, location);
  }
}

function walkJson(
  state: MatchState,
  value: unknown,
  location: string,
  depth = 0,
  redactObjectKeys = false,
  keyReview: JsonObjectKeyReview = "structural",
): void {
  if (depth >= state.maximumDepth) {
    if (hasSearchableContent(state, value)) truncateEveryFixture(state);
    return;
  }
  if (state.visited >= MAX_WALK_NODES) {
    if (hasSearchableContent(state, value)) truncateEveryFixture(state);
    return;
  }
  state.visited += 1;
  matchPrimitive(state, value, location);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS);
    if (value.length > items.length) truncateEveryFixture(state);
    for (let index = 0; index < items.length; index += 1) {
      walkJson(state, items[index], `${location}[]`, depth + 1, false, "structural");
      if (
        state.visited >= MAX_WALK_NODES
        && items.slice(index + 1).some((candidate) => hasSearchableContent(state, candidate))
      ) {
        truncateEveryFixture(state);
        return;
      }
    }
    return;
  }
  if (!isRecord(value)) return;
  const searchedEntries: [string, unknown][] = [];
  let rawKeyOverflow = false;
  let safeEntryOverflow = false;
  let inspectedKeys = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (inspectedKeys >= MAX_OBJECT_KEY_INSPECTIONS) {
      rawKeyOverflow = true;
      break;
    }
    inspectedKeys += 1;
    if (key.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters) {
      rawKeyOverflow = true;
      continue;
    }
    if (isSensitiveCredentialKeyForExchange(state.twitchGraphQlPostExchange, key)) continue;
    if (searchedEntries.length >= MAX_OBJECT_ENTRIES) {
      safeEntryOverflow = true;
      break;
    }
    searchedEntries.push([key, value[key]]);
  }
  if (rawKeyOverflow || safeEntryOverflow) truncateEveryFixture(state);
  for (let index = 0; index < searchedEntries.length; index += 1) {
    const entry = searchedEntries[index];
    if (entry === undefined) continue;
    const [key, child] = entry;
    // A redacted key is not a safe traversal boundary: descending would still
    // let a fixture probe reveal whether a credential subtree contains a value
    // and return its sanitized location. Treat every sensitive-key value as an
    // opaque leaf, including nested objects and arrays.
    const renderedKey = redactObjectKeys
      ? ":dynamic"
      : keyReview === "x-graphql-variable"
        ? reviewedXGraphQlVariableFieldName(key)
        : reviewedInternalFieldNameForUrl(state.url, key);
    matchObjectKey(
      state,
      key,
      `${location}.:candidate-field`,
      redactObjectKeys,
      child,
    );
    const childLocation = `${location}.${renderedKey}`;
    const childKeyReview = state.xGraphQlRequest
      && location === "request.body"
      && key === "variables"
      ? "x-graphql-variable"
      : "structural";
    walkJson(
      state,
      child,
      childLocation,
      depth + 1,
      !redactObjectKeys
        && isRecord(child)
        && (isReviewedInternalDynamicMapField(key) || renderedKey === ":dynamic"),
      childKeyReview,
    );
    if (
      state.visited >= MAX_WALK_NODES
      && searchedEntries
        .slice(index + 1)
        .some(([, candidate]) => hasSearchableContent(state, candidate))
    ) {
      truncateEveryFixture(state);
      return;
    }
  }
}

type ParsedJsonText =
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "oversized" };

function parsedJsonText(value: unknown): ParsedJsonText {
  if (typeof value !== "string") return { kind: "invalid" };
  if (
    value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxRawStringCharacters
    || Buffer.byteLength(value, "utf8") > MAX_JSON_TEXT_BYTES
  ) return { kind: "oversized" };
  try {
    return { kind: "parsed", value: JSON.parse(value) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function decodedFormComponent(value: string): string | null {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return null;
  }
}

function matchFormUrlEncodedText(state: MatchState, value: string): void {
  const occurrences = new Map<string, number>();
  let cursor = 0;
  let inspected = 0;
  let searched = 0;
  while (cursor <= value.length) {
    if (inspected >= MAX_FORM_PARAMETERS) {
      if (cursor < value.length) truncateEveryFixture(state);
      return;
    }
    const separator = value.indexOf("&", cursor);
    const end = separator === -1 ? value.length : separator;
    const pair = value.slice(cursor, end);
    cursor = separator === -1 ? value.length + 1 : end + 1;
    if (pair === "") continue;
    inspected += 1;
    const equals = pair.indexOf("=");
    const rawName = equals === -1 ? pair : pair.slice(0, equals);
    if (Buffer.byteLength(rawName, "utf8") > MAX_FORM_NAME_BYTES) {
      truncateEveryFixture(state);
      continue;
    }
    const name = decodedFormComponent(rawName);
    if (name === null) {
      truncateEveryFixture(state);
      continue;
    }
    if (isSensitiveCredentialKey(name)) continue;
    if (searched >= MAX_FORM_PARAMETERS) {
      truncateEveryFixture(state);
      return;
    }
    searched += 1;
    const rawValue = equals === -1 ? "" : pair.slice(equals + 1);
    const decodedValue = decodedFormComponent(rawValue);
    if (decodedValue === null) {
      truncateEveryFixture(state);
      continue;
    }
    const safeName = reviewedInternalFieldNameForUrl(state.url, name);
    const occurrence = occurrences.get(safeName) ?? 0;
    occurrences.set(safeName, occurrence + 1);
    matchPrimitive(state, decodedValue, `request.form.${safeName}[${occurrence}]`);
  }
}

const reviewedRequestFixtureHeaders = new Set(["x-restli-method"] as const);
const reviewedResponseFixtureHeaders = new Set(["x-restli-id"] as const);

/**
 * Match only reviewed non-secret contract facts. Header values never appear in
 * review output; a match returns the fixed header-name location alone.
 */
function matchReviewedHeaderFixtures(
  state: MatchState,
  value: unknown,
  location: "request.header" | "response.header",
  reviewedNames: ReadonlySet<string>,
): void {
  if (!Array.isArray(value)) return;
  if (value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxHeaderItems) truncateEveryFixture(state);
  const occurrences = new Map<string, number>();
  for (const candidate of value.slice(0, INTERNAL_HAR_REVIEW_BOUNDS.maxHeaderItems)) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || typeof candidate.value !== "string") continue;
    const name = candidate.name.toLowerCase();
    if (!reviewedNames.has(name)) continue;
    if (
      candidate.value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxRawStringCharacters
      || Buffer.byteLength(candidate.value, "utf8") > MAX_JSON_TEXT_BYTES
    ) {
      truncateEveryFixture(state);
      continue;
    }
    const occurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, occurrence + 1);
    matchPrimitive(state, candidate.value, `${location}.${name}[${occurrence}]`);
  }
}

function matchEntryProbes(
  entry: JsonRecord,
  boundedUrl: BoundedInternalHarUrl,
  fixtures: DerivationReviewFixtures,
  fieldNames: DerivationReviewFieldNames,
): {
  readonly fixtureMatches: readonly DerivationReviewMatch[];
  readonly fieldNameMatches: readonly DerivationReviewFieldNameMatch[];
} {
  const { url } = boundedUrl;
  const values = Object.entries(fixtures).map(([label, value]) => ({ label, value }));
  const state: MatchState = {
    values,
    locations: new Map(values.map(({ label }) => [label, new Set<string>()])),
    truncated: new Set(),
    fieldNames,
    fieldNameLocations: fieldNames.map(() => new Set<string>()),
    fieldNameTruncated: new Set(),
    fieldNameValueTypes: fieldNames.map(
      () => new Set<DerivationReviewFieldValueType>(),
    ),
    twitchGraphQlPostExchange: isRecord(entry.request)
      && entry.request.method === "POST"
      && isReviewedTwitchGraphQlRoute(url),
    xGraphQlRequest: isRecord(entry.request)
      && entry.request.method === "POST"
      && url.origin === "https://x.com"
      && /^\/i\/api\/graphql\/[A-Za-z0-9_-]{20,64}\/[A-Z][A-Za-z0-9_]{2,100}$/u.test(url.pathname),
    url,
    maximumDepth: isReviewedLinkedInArticleRoute(url)
      ? INTERNAL_HAR_REVIEW_BOUNDS.maxLinkedInArticleTraversalDepth
      : MAX_WALK_DEPTH,
    visited: 0,
  };

  if (boundedUrl.pathTruncated || boundedUrl.queryTruncated) truncateEveryFixture(state);

  if (boundedUrl.pathTruncated) {
    truncateEveryFixture(state);
  } else {
    const rawPathSegments = url.pathname.split("/").filter((segment) => segment !== "");
    if (rawPathSegments.length > MAX_PATH_SEGMENTS) {
      truncateEveryFixture(state);
    } else {
      const pathSegments: string[] = [];
      let invalidPath = false;
      for (const raw of rawPathSegments) {
        try {
          pathSegments.push(decodeURIComponent(raw));
        } catch {
          invalidPath = true;
          break;
        }
      }
      if (invalidPath) {
        truncateEveryFixture(state);
      } else if (!pathSegments.some(isSensitiveCredentialKey)) {
        pathSegments.forEach((segment, index) => {
          matchPrimitive(state, segment, `request.path.segment[${index}]`);
        });
      }
    }
  }

  const queryOccurrences = new Map<string, number>();
  for (const [name, raw] of url.searchParams) {
    if (name.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters) {
      truncateEveryFixture(state);
      continue;
    }
    if (isSensitiveCredentialKey(name)) continue;
    const safeName = reviewedInternalFieldNameForUrl(state.url, name);
    const occurrence = queryOccurrences.get(safeName) ?? 0;
    queryOccurrences.set(safeName, occurrence + 1);
    const location = `request.query.${safeName}[${occurrence}]`;
    const parsed = parsedJsonText(raw);
    if (parsed.kind === "oversized") {
      truncateEveryFixture(state);
      continue;
    }
    matchPrimitive(state, raw, location);
    if (parsed.kind === "parsed") walkJson(state, parsed.value, location);
  }

  const request = entry.request;
  if (isRecord(request)) {
    matchReviewedHeaderFixtures(state, request.headers, "request.header", reviewedRequestFixtureHeaders);
  }
  if (isRecord(request) && isRecord(request.postData)) {
    const rawMimeType = request.postData.mimeType;
    const oversizedMimeType = typeof rawMimeType === "string"
      && rawMimeType.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters;
    const mimeType = typeof rawMimeType === "string"
      && rawMimeType.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
      ? rawMimeType.toLowerCase()
      : "";
    if (
      oversizedMimeType
      && (
        (typeof request.postData.text === "string" && request.postData.text.length > 0)
        || (Array.isArray(request.postData.params) && request.postData.params.length > 0)
      )
    ) truncateEveryFixture(state);
    if (mimeType.includes("json")) {
      const parsed = parsedJsonText(request.postData.text);
      if (parsed.kind === "parsed") walkJson(state, parsed.value, "request.body");
      else if (parsed.kind === "oversized") truncateEveryFixture(state);
    } else if (Array.isArray(request.postData.params)) {
      const occurrences = new Map<string, number>();
      const searchedParameters: JsonRecord[] = [];
      let safeParameterOverflow = false;
      const inspectedCount = Math.min(request.postData.params.length, MAX_FORM_PARAMETERS);
      for (let index = 0; index < inspectedCount; index += 1) {
        const parameter: unknown = request.postData.params[index];
        if (!isRecord(parameter) || typeof parameter.name !== "string") {
          safeParameterOverflow = true;
          continue;
        }
        if (parameter.name.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters) {
          safeParameterOverflow = true;
          continue;
        }
        if (isSensitiveCredentialKey(parameter.name)) continue;
        if (searchedParameters.length >= MAX_FORM_PARAMETERS) {
          safeParameterOverflow = true;
          break;
        }
        searchedParameters.push(parameter);
      }
      if (
        safeParameterOverflow
        || request.postData.params.length > MAX_FORM_PARAMETERS
      ) truncateEveryFixture(state);
      for (const parameter of searchedParameters) {
        if (!isRecord(parameter) || typeof parameter.name !== "string") continue;
        const safeName = reviewedInternalFieldNameForUrl(state.url, parameter.name);
        const occurrence = occurrences.get(safeName) ?? 0;
        occurrences.set(safeName, occurrence + 1);
        if (typeof parameter.value === "string") {
          if (
            parameter.value.length > INTERNAL_HAR_REVIEW_BOUNDS.maxRawStringCharacters
            || Buffer.byteLength(parameter.value, "utf8") > MAX_JSON_TEXT_BYTES
          ) {
            truncateEveryFixture(state);
          } else {
            matchPrimitive(state, parameter.value, `request.form.${safeName}[${occurrence}]`);
          }
        }
      }
    } else if (typeof request.postData.text === "string") {
      if (
        request.postData.text.length > INTERNAL_HAR_REVIEW_BOUNDS.maxRawStringCharacters
        || Buffer.byteLength(request.postData.text, "utf8") > MAX_JSON_TEXT_BYTES
      ) {
        truncateEveryFixture(state);
      } else if (
        state.twitchGraphQlPostExchange
        && isExactMimeType(mimeType, "text/plain")
      ) {
        const parsed = parsedJsonText(request.postData.text);
        if (parsed.kind === "parsed") walkJson(state, parsed.value, "request.body");
        else if (parsed.kind === "oversized") truncateEveryFixture(state);
      } else if (mimeType.includes("application/x-www-form-urlencoded")) {
        matchFormUrlEncodedText(state, request.postData.text);
      } else if (mimeType.includes("multipart/form-data")) {
        if (request.postData.text.length > 0) truncateEveryFixture(state);
      } else {
        matchPrimitive(state, request.postData.text, "request.body:text");
      }
    }
  }

  if (isRecord(entry.response)) {
    matchReviewedHeaderFixtures(state, entry.response.headers, "response.header", reviewedResponseFixtureHeaders);
  }
  if (isRecord(entry.response) && isRecord(entry.response.content)) {
    const rawMimeType = entry.response.content.mimeType;
    const oversizedMimeType = typeof rawMimeType === "string"
      && rawMimeType.length > INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters;
    const mimeType = typeof rawMimeType === "string"
      && rawMimeType.length <= INTERNAL_HAR_REVIEW_BOUNDS.maxFieldNameCharacters
      ? rawMimeType.toLowerCase()
      : "";
    const encoding = entry.response.content.encoding;
    const hasResponseText = typeof entry.response.content.text === "string"
      && entry.response.content.text.length > 0;
    if (oversizedMimeType && hasResponseText) truncateEveryFixture(state);
    if (mimeType.includes("json")) {
      if (encoding === "base64") {
        if (hasResponseText) truncateEveryFixture(state);
      } else {
        const parsed = parsedJsonText(entry.response.content.text);
        if (parsed.kind === "parsed") walkJson(state, parsed.value, "response.body");
        else if (parsed.kind === "oversized") truncateEveryFixture(state);
      }
    }
  }

  return {
    fixtureMatches: values.map(({ label }) => ({
      label,
      locations: [...(state.locations.get(label) ?? [])].sort(),
      truncated: state.truncated.has(label),
    })),
    fieldNameMatches: fieldNames.map((_name, candidateIndex) => ({
      candidateIndex,
      locations: [...(state.fieldNameLocations[candidateIndex] ?? [])].sort(),
      truncated: state.fieldNameTruncated.has(candidateIndex),
      valueTypes: [...(state.fieldNameValueTypes[candidateIndex] ?? [])].sort(),
    })),
  };
}

const warnings = [
  "Private review is structural only: it cannot authorize or execute a request.",
  "Fixture values are matched only in first-party path/query/body, reviewed non-secret contract headers, and JSON response content; values, cookies, credentials, and unreviewed headers are never returned.",
] as const;

export function reviewDerivationHarValue(
  value: unknown,
  targetOriginValue: string,
  selection: DerivationReviewSelection,
): DerivationReviewResult {
  const target = exactTarget(targetOriginValue);
  const entries = parseHarEntries(value);
  if (selection.kind === "entry") {
    if (!Number.isSafeInteger(selection.entryIndex) || selection.entryIndex < 0 || selection.entryIndex >= entries.length) {
      throw new Error("private review entry index is outside the captured HAR");
    }
    const entry = entries[selection.entryIndex];
    const reviewable = reviewableRequest(entry, target.origin);
    const candidate = reviewable === null ? null : exactCandidate(entry, target.origin);
    if (reviewable === null || candidate === null) {
      throw new Error("selected HAR entry is not a reviewable first-party API exchange");
    }
    if (selection.fixtures !== undefined && selection.fieldNames !== undefined) {
      throw new Error("private review entry probes are mutually exclusive");
    }
    const fixtures = selection.fixtures === undefined
      ? Object.freeze({})
      : parseReviewFixtures(selection.fixtures, 0);
    const fieldNames = selection.fieldNames === undefined
      ? Object.freeze([])
      : parseDerivationReviewFieldNames(selection.fieldNames);
    const matches = matchEntryProbes(
      reviewable.entry,
      reviewable,
      fixtures,
      fieldNames,
    );
    return {
      schemaVersion: 1,
      kind: "entry",
      targetOrigin: target.origin,
      totalHarEntries: entries.length,
      entryIndex: selection.entryIndex,
      structure: candidate,
      fixtureMatches: matches.fixtureMatches,
      fieldNameMatches: matches.fieldNameMatches,
      warnings,
    };
  }

  if (
    !Number.isSafeInteger(selection.offset)
    || selection.offset < 0
    || !Number.isSafeInteger(selection.limit)
    || selection.limit < 1
    || selection.limit > MAX_REVIEW_LIMIT
  ) throw new Error("private review list bounds are invalid");
  const selected: DerivationReviewListEntry[] = [];
  let reviewableEntries = 0;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (reviewableRequest(entry, target.origin) === null) continue;
    const reviewableIndex = reviewableEntries;
    reviewableEntries += 1;
    if (reviewableIndex < selection.offset || selected.length >= selection.limit) continue;
    const candidate = exactCandidate(entry, target.origin);
    if (candidate === null) continue;
    selected.push({
      entryIndex,
      method: candidate.method,
      origin: candidate.origin,
      path: candidate.path,
      operationType: candidate.operationType,
      statuses: candidate.statuses,
      queryNames: candidate.queryNames,
      revisions: candidate.revisions,
      requestFieldCount: candidate.requestFieldPaths.length,
      responseFieldCount: candidate.responseFieldPaths.length,
    });
  }
  const nextOffset = selection.offset + selected.length < reviewableEntries
    ? selection.offset + selected.length
    : null;
  return {
    schemaVersion: 1,
    kind: "list",
    targetOrigin: target.origin,
    totalHarEntries: entries.length,
    reviewableEntries,
    offset: selection.offset,
    limit: selection.limit,
    nextOffset,
    entries: selected,
    warnings,
  };
}

export function reviewDerivationHarText(
  text: string,
  targetOrigin: string,
  selection: DerivationReviewSelection,
): DerivationReviewResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("private review HAR is not valid JSON");
  }
  return reviewDerivationHarValue(value, targetOrigin, selection);
}
