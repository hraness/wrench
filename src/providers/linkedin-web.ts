import type {
  ArticleDraftDocument,
  ArticleDraftDocumentV2,
  ArticleDraftImageBlock,
  ArticleDraftLinkRange,
  ArticleDraftTextBlock,
} from "../article-draft-document";

const MAX_CSRF_TOKEN_CHARACTERS = 1_024;
const MAX_QUERY_CANDIDATES = 4_096;
const MAX_QUERY_CANDIDATE_CHARACTERS = 512;
const MAX_MESSAGING_ITEMS = 100;

export const LINKEDIN_MESSENGER_CONVERSATIONS_QUERY_PREFIX = "messengerConversations";
export const LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID =
  "messengerConversations.0d5e6781bbee71c3e51c8843c6519f48";
export const LINKEDIN_MESSENGER_GRAPHQL_PATH = "/voyager/api/voyagerMessagingGraphQL/graphql";
export const LINKEDIN_POST_CREATE_MUTATION_ID =
  "voyagerContentcreationDashShares.80089eb2e82a2dfa23cb621fb09eb7bf";
export const LINKEDIN_POST_READBACK_QUERY_ID =
  "voyagerFeedDashUpdates.00f9ed72d35c2a949114759b829f9886";
export const LINKEDIN_GRAPHQL_PATH = "/voyager/api/graphql";

export const LINKEDIN_WEB_OPERATION_NAMES = Object.freeze([
  "feeds.read",
  "contacts.list",
  "profiles.read",
  "organizations.read",
  "relationships.recommendations.read",
  "messaging.list",
  "messaging.read",
  "messaging.send",
  "posts.read",
  "posts.publish",
  "posts.repost",
  "posts.quote",
  "comments.read",
  "comments.create",
  "replies.create",
  "reactions.set",
  "relationships.connect",
  "articles.read",
  "articles.draft.save",
  "articles.publish",
] as const);

export type LinkedInWebOperationName = (typeof LINKEDIN_WEB_OPERATION_NAMES)[number];
export type LinkedInWebRisk = "R1" | "R2" | "R3";
export type LinkedInWebContractState = "observed" | "capture-required";
export type LinkedInWebEvidence = "live-har" | "first-party-bundle" | "none";

type LinkedInWebReadRequestRule = {
  readonly kind: "registered-query" | "restli-read";
  readonly method: "GET";
  readonly path: string;
  readonly queryPrefix: string | null;
  readonly allowedQueryParameters: readonly string[];
  readonly requiredQueryParameters: readonly string[];
  readonly fixedQueryParameters: readonly (readonly [string, string])[];
};

type LinkedInWebWriteRequestRule = {
  readonly kind: "registered-mutation" | "restli-write" | "server-bound-upload";
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly queryId: string | null;
  readonly fixedQueryParameters: readonly (readonly [string, string])[];
  readonly bodyContract: string;
  readonly targetHostnameFamilies: readonly string[];
};

type LinkedInWebRequestRule = LinkedInWebReadRequestRule | LinkedInWebWriteRequestRule;

export type LinkedInWebOperationContract = {
  readonly effect: "read" | "write";
  readonly risk: LinkedInWebRisk;
  readonly state: LinkedInWebContractState;
  readonly evidence: LinkedInWebEvidence;
  readonly requests: readonly LinkedInWebRequestRule[];
};

/**
 * Code-owned internal-web operation surface. A capture-required entry is a
 * semantic reservation, not permission to guess or execute an endpoint.
 */
export const LINKEDIN_WEB_OPERATIONS = {
  "contacts.list": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "feeds.read": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "live-har",
    requests: [],
  },
  "profiles.read": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "organizations.read": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "relationships.recommendations.read": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "messaging.list": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "live-har",
    requests: [],
  },
  "messaging.read": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "live-har",
    requests: [],
  },
  "messaging.send": {
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "posts.read": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "posts.publish": {
    effect: "write",
    risk: "R3",
    state: "observed",
    evidence: "first-party-bundle",
    requests: [
      {
        kind: "restli-write",
        method: "POST",
        path: "/voyager/api/voyagerVideoDashMediaUploadMetadata",
        queryId: null,
        fixedQueryParameters: [["action", "upload"]],
        bodyContract: "IMAGE_SHARING registration for the exact plan-bound PNG size and fixed filename",
        targetHostnameFamilies: ["linkedin.com"],
      },
      {
        kind: "server-bound-upload",
        method: "PUT",
        path: "server-returned exact upload URL",
        queryId: null,
        fixedQueryParameters: [],
        bodyContract: "exact registered PNG bytes once, or exact contiguous registered parts once",
        targetHostnameFamilies: ["linkedin.com", "licdn.com"],
      },
      {
        kind: "restli-write",
        method: "POST",
        path: "/voyager/api/voyagerVideoDashMediaUploadMetadata",
        queryId: null,
        fixedQueryParameters: [["action", "completeMultipartUpload"]],
        bodyContract: "registered artifact, multipart metadata, and exact per-part response evidence only",
        targetHostnameFamilies: ["linkedin.com"],
      },
      {
        kind: "registered-mutation",
        method: "POST",
        path: LINKEDIN_GRAPHQL_PATH,
        queryId: LINKEDIN_POST_CREATE_MUTATION_ID,
        fixedQueryParameters: [["action", "execute"]],
        bodyContract: "one PUBLISHED FEED post with exact commentary, fixed commenter scope, confirmed visibility, and optional response-bound IMAGE media URN",
        targetHostnameFamilies: ["linkedin.com"],
      },
      {
        kind: "registered-query",
        method: "GET",
        path: LINKEDIN_GRAPHQL_PATH,
        queryPrefix: "voyagerFeedDashUpdates",
        allowedQueryParameters: ["includeWebMetadata", "queryId", "variables"],
        requiredQueryParameters: ["includeWebMetadata", "queryId", "variables"],
        fixedQueryParameters: [
          ["includeWebMetadata", "true"],
          ["queryId", LINKEDIN_POST_READBACK_QUERY_ID],
        ],
      },
    ],
  },
  "posts.repost": {
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "posts.quote": {
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "comments.read": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "first-party-bundle",
    requests: [],
  },
  "comments.create": {
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "first-party-bundle",
    requests: [],
  },
  "replies.create": {
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "first-party-bundle",
    requests: [],
  },
  "reactions.set": {
    effect: "write",
    risk: "R2",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "relationships.connect": {
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
  "articles.read": {
    effect: "read",
    risk: "R1",
    state: "capture-required",
    evidence: "live-har",
    requests: [],
  },
  "articles.draft.save": {
    effect: "write",
    risk: "R2",
    state: "observed",
    evidence: "live-har",
    requests: [],
  },
  "articles.publish": {
    effect: "write",
    risk: "R3",
    state: "capture-required",
    evidence: "none",
    requests: [],
  },
} as const satisfies Readonly<Record<LinkedInWebOperationName, LinkedInWebOperationContract>>;

for (const contract of Object.values(LINKEDIN_WEB_OPERATIONS)) {
  for (const request of contract.requests) Object.freeze(request);
  Object.freeze(contract.requests);
  Object.freeze(contract);
}
Object.freeze(LINKEDIN_WEB_OPERATIONS);

export const LINKEDIN_WEB_FOLDER_CATEGORIES = Object.freeze({
  focused: "PRIMARY_INBOX",
  other: "SECONDARY_INBOX",
  requests: "MESSAGE_REQUEST_PENDING",
  archive: "ARCHIVE",
  spam: "SPAM",
  all: "INBOX",
} as const);

export type LinkedInWebFolder = keyof typeof LINKEDIN_WEB_FOLDER_CATEGORIES;
export type LinkedInWebFolderCategory = (typeof LINKEDIN_WEB_FOLDER_CATEGORIES)[LinkedInWebFolder];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function linkedInWebFolderCategory(value: unknown): LinkedInWebFolderCategory {
  if (
    typeof value !== "string"
    || !hasOwn(LINKEDIN_WEB_FOLDER_CATEGORIES, value)
  ) {
    throw new Error("LinkedIn folder must be focused, other, requests, archive, spam, or all");
  }
  return LINKEDIN_WEB_FOLDER_CATEGORIES[value as LinkedInWebFolder];
}

/** Derives LinkedIn's csrf-token header without logging or returning cookie metadata. */
export function linkedInCsrfTokenFromJSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CSRF_TOKEN_CHARACTERS) {
    throw new Error("LinkedIn JSESSIONID must be a bounded cookie value");
  }

  const startsQuoted = value.startsWith('"');
  const endsQuoted = value.endsWith('"');
  if (startsQuoted !== endsQuoted) {
    throw new Error("LinkedIn JSESSIONID has mismatched wrapper quotes");
  }

  const token = startsQuoted ? value.slice(1, -1) : value;
  if (!token.startsWith("ajax:") || token.length === "ajax:".length) {
    throw new Error("LinkedIn JSESSIONID is not an ajax session token");
  }
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (
      code < 0x21
      || code > 0x7e
      || code === 0x22
      || code === 0x2c
      || code === 0x3b
      || code === 0x5c
    ) {
      throw new Error("LinkedIn JSESSIONID contains an invalid cookie character");
    }
  }
  return token;
}

function queryPrefix(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(value)) {
    throw new Error("LinkedIn registered-query prefix is invalid");
  }
  return value;
}

function escapedRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Resolves one unique current registered-query ID and fails closed on drift ambiguity. */
export function resolveLinkedInRegisteredQueryId(
  prefixValue: unknown,
  candidatesValue: unknown,
): string {
  const prefix = queryPrefix(prefixValue);
  if (!Array.isArray(candidatesValue) || candidatesValue.length > MAX_QUERY_CANDIDATES) {
    throw new Error("LinkedIn registered-query candidates must be a bounded array");
  }

  const matcher = new RegExp(`^${escapedRegularExpression(prefix)}\\.[0-9a-fA-F]{32}$`, "u");
  const matches = new Set<string>();
  for (const candidate of candidatesValue) {
    if (typeof candidate !== "string" || candidate.length > MAX_QUERY_CANDIDATE_CHARACTERS) {
      throw new Error("LinkedIn registered-query candidate is invalid");
    }
    if (matcher.test(candidate)) matches.add(candidate);
  }

  if (matches.size === 0) {
    throw new Error(`LinkedIn registered query ${prefix} was not found`);
  }
  if (matches.size !== 1) {
    throw new Error(`LinkedIn registered query ${prefix} is ambiguous`);
  }
  const match = matches.values().next().value;
  if (match === undefined) throw new Error("LinkedIn registered-query resolution failed");
  return match;
}

export const RESTLI_V2_VALUE_LIMITS = Object.freeze({
  maximumDepth: 12,
  maximumNodes: 4_096,
  maximumStringCharacters: 8_192,
  maximumListItems: 512,
  maximumObjectFields: 256,
  maximumEncodedCharacters: 64 * 1_024,
} as const);

type RestliEncodingState = {
  nodes: number;
  readonly active: WeakSet<object>;
};

function encodedRestliString(value: string): string {
  if (value.length > RESTLI_V2_VALUE_LIMITS.maximumStringCharacters) {
    throw new Error("Rest.li string exceeds the value limit");
  }
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    throw new Error("Rest.li string contains invalid Unicode");
  }
  return encoded.replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function boundedEncodedValue(value: string): string {
  if (value.length > RESTLI_V2_VALUE_LIMITS.maximumEncodedCharacters) {
    throw new Error("Rest.li encoded value exceeds the output limit");
  }
  return value;
}

function encodeRestliValue(value: unknown, depth: number, state: RestliEncodingState): string {
  if (depth > RESTLI_V2_VALUE_LIMITS.maximumDepth) {
    throw new Error("Rest.li value exceeds the nesting-depth limit");
  }
  state.nodes += 1;
  if (state.nodes > RESTLI_V2_VALUE_LIMITS.maximumNodes) {
    throw new Error("Rest.li value exceeds the node limit");
  }

  if (value === null) return "null";
  if (typeof value === "string") return boundedEncodedValue(encodedRestliString(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Rest.li numbers must be safe integers");
    return Object.is(value, -0) ? "0" : String(value);
  }

  if (Array.isArray(value)) {
    if (value.length > RESTLI_V2_VALUE_LIMITS.maximumListItems) {
      throw new Error("Rest.li list exceeds the item limit");
    }
    if (state.active.has(value)) throw new Error("Rest.li value contains a cycle");
    state.active.add(value);
    try {
      const items = value.map((item) => encodeRestliValue(item, depth + 1, state));
      return boundedEncodedValue(`List(${items.join(",")})`);
    } finally {
      state.active.delete(value);
    }
  }

  if (typeof value !== "object" || value === null) {
    throw new Error("Rest.li value contains an unsupported type");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Rest.li objects must be plain records");
  }
  if (state.active.has(value)) throw new Error("Rest.li value contains a cycle");

  const keys = Reflect.ownKeys(value);
  if (keys.length > RESTLI_V2_VALUE_LIMITS.maximumObjectFields) {
    throw new Error("Rest.li object exceeds the field limit");
  }
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error("Rest.li object cannot contain symbol fields");
  }
  const stringKeys = keys as string[];
  for (const key of stringKeys) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)) {
      throw new Error("Rest.li object contains an invalid field name");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("Rest.li object fields must be enumerable data properties");
    }
  }

  state.active.add(value);
  try {
    const fields = stringKeys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("Rest.li object field changed during encoding");
      }
      return `${key}:${encodeRestliValue(descriptor.value, depth + 1, state)}`;
    });
    return boundedEncodedValue(`(${fields.join(",")})`);
  } finally {
    state.active.delete(value);
  }
}

/** Encodes a bounded Rest.li protocol-2.0 value, not an entire query string. */
export function encodeRestliV2Value(value: unknown): string {
  return encodeRestliValue(value, 0, { nodes: 0, active: new WeakSet<object>() });
}

export type LinkedInWebJsonRecord = Readonly<Record<string, unknown>>;

export type NormalizedLinkedInGraphql = {
  readonly data: LinkedInWebJsonRecord;
  readonly included: readonly LinkedInWebJsonRecord[];
  readonly entitiesByUrn: ReadonlyMap<string, LinkedInWebJsonRecord>;
};

export type LinkedInMessagingParticipant = {
  readonly urn: string;
  readonly identityUrn: string | null;
  readonly displayName: string | null;
};

export type LinkedInMessagingConversation = {
  readonly id: string;
  readonly urn: string;
  readonly categories: readonly string[];
  readonly groupChat: boolean;
  readonly title: string | null;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly lastReadAt: number | null;
  readonly read: boolean;
  readonly unreadCount: number;
  readonly notificationStatus: string;
  readonly participants: readonly LinkedInMessagingParticipant[];
  readonly latestMessage: {
    readonly id: string;
    readonly urn: string;
    readonly deliveredAt: number;
    readonly body: string;
    readonly subject: string | null;
    readonly senderUrn: string | null;
  } | null;
  readonly url: string;
};

export type LinkedInMessagingList = {
  readonly folder: LinkedInWebFolder;
  readonly conversations: readonly LinkedInMessagingConversation[];
  /** Compatibility name for LinkedIn's opaque provider sync token; not an executable page cursor. */
  readonly nextCursor: string | null;
  readonly continuationSupported: false;
  readonly complete: boolean;
};

type JsonValidationState = {
  nodes: number;
  readonly active: WeakSet<object>;
};

function canonicalJson(value: unknown, depth: number, state: JsonValidationState): string {
  if (depth > 64) throw new Error("LinkedIn GraphQL response exceeds the nesting-depth limit");
  state.nodes += 1;
  if (state.nodes > 100_000) throw new Error("LinkedIn GraphQL response exceeds the node limit");

  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("LinkedIn GraphQL response contains a non-finite number");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("LinkedIn GraphQL response contains a non-JSON value");
  }
  if (state.active.has(value)) throw new Error("LinkedIn GraphQL response contains a cycle");
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, depth + 1, state)).join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("LinkedIn GraphQL response contains a non-plain object");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("LinkedIn GraphQL response contains symbol fields");
    }
    const stringKeys = keys as string[];
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("LinkedIn GraphQL response fields must be enumerable data properties");
      }
    }
    return `{${stringKeys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("LinkedIn GraphQL response changed during normalization");
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1, state)}`;
    }).join(",")}}`;
  } finally {
    state.active.delete(value);
  }
}

function graphqlRecord(value: unknown, label: string): LinkedInWebJsonRecord {
  if (!isRecord(value)) throw new Error(`LinkedIn GraphQL ${label} must be an object`);
  return value;
}

function entityIdentityKeys(entity: LinkedInWebJsonRecord): readonly string[] {
  const keys: string[] = [];
  for (const field of ["entityUrn", "backendUrn", "urn"] as const) {
    if (!hasOwn(entity, field)) continue;
    const value = entity[field];
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
      throw new Error(`LinkedIn GraphQL included entity has an invalid ${field}`);
    }
    keys.push(value);
  }
  if (keys.length === 0) throw new Error("LinkedIn GraphQL included entity has no canonical URN");
  return [...new Set(keys)];
}

/** Normalizes LinkedIn's data + included envelope and indexes every entity URN alias. */
export function normalizeLinkedInGraphqlEnvelope(value: unknown): NormalizedLinkedInGraphql {
  const envelope = graphqlRecord(value, "envelope");
  if (hasOwn(envelope, "serviceErrorCode")) {
    throw new Error("LinkedIn GraphQL response contains a service error");
  }
  if (hasOwn(envelope, "errors")) {
    if (!Array.isArray(envelope.errors)) throw new Error("LinkedIn GraphQL errors must be an array");
    if (envelope.errors.length > 0) throw new Error("LinkedIn GraphQL response contains provider errors");
  }

  const data = graphqlRecord(envelope.data, "data");
  canonicalJson(data, 0, { nodes: 0, active: new WeakSet<object>() });

  const rawIncluded = envelope.included === undefined ? [] : envelope.included;
  if (!Array.isArray(rawIncluded)) throw new Error("LinkedIn GraphQL included must be an array");

  const included: LinkedInWebJsonRecord[] = [];
  const entitiesByUrn = new Map<string, LinkedInWebJsonRecord>();
  const canonicalByUrn = new Map<string, string>();
  const primaryUrns = new Set<string>();

  for (const rawEntity of rawIncluded) {
    const entity = graphqlRecord(rawEntity, "included entity");
    const canonical = canonicalJson(entity, 0, { nodes: 0, active: new WeakSet<object>() });
    const urns = entityIdentityKeys(entity);
    let duplicate = false;
    for (const urn of urns) {
      const prior = canonicalByUrn.get(urn);
      if (prior !== undefined && prior !== canonical) {
        throw new Error("LinkedIn GraphQL included entities conflict for one URN");
      }
      if (prior === canonical) duplicate = true;
    }
    for (const urn of urns) {
      canonicalByUrn.set(urn, canonical);
      if (!entitiesByUrn.has(urn)) entitiesByUrn.set(urn, entity);
    }
    const primaryUrn = urns[0];
    if (primaryUrn === undefined) throw new Error("LinkedIn GraphQL included entity identity disappeared");
    if (!duplicate && !primaryUrns.has(primaryUrn)) {
      included.push(entity);
      primaryUrns.add(primaryUrn);
    }
  }

  return {
    data,
    included: Object.freeze(included),
    entitiesByUrn,
  };
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

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(value, label, maximum);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function optionalNonnegativeInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return nonnegativeInteger(value, label);
}

function linkedInUrn(value: unknown, label: string, maximum = 4_096): string {
  const urn = boundedText(value, label, maximum);
  if (!/^urn:li:[A-Za-z][A-Za-z0-9_]*:.+$/u.test(urn)) {
    throw new Error(`${label} must be an exact LinkedIn URN`);
  }
  return urn;
}

export function linkedInMailboxUrnFromMiniProfile(value: unknown): string {
  const miniProfile = boundedText(value, "LinkedIn normalized mini-profile URN", 512);
  const suffix = /^urn:li:fs_miniProfile:([A-Za-z0-9_-]{1,256})$/u.exec(miniProfile)?.[1];
  if (suffix === undefined) throw new Error("LinkedIn normalized mini-profile URN is invalid");
  return `urn:li:fsd_profile:${suffix}`;
}

export const LINKEDIN_FIRST_PARTY_ARTICLES_PATH =
  "/voyager/api/voyagerPublishingDashFirstPartyArticles";
export const LINKEDIN_ARTICLE_PAGE_MAX_CHARACTERS = 2 * 1024 * 1024;

const LINKEDIN_ARTICLE_CODE_PAYLOAD_MAX_CHARACTERS = 1024 * 1024;
const LINKEDIN_ARTICLE_CODE_TAG_MAX_COUNT = 5_000;
const LINKEDIN_ARTICLE_MATCHING_PAYLOAD_MAX_COUNT = 20;

const LINKEDIN_ARTICLE_TYPE = "com.linkedin.voyager.dash.publishing.FirstPartyArticle";
const LINKEDIN_ARTICLE_COLLECTION_TYPE = "com.linkedin.restli.common.CollectionResponse";
const LINKEDIN_TEXT_BLOCK_TYPE = "com.linkedin.voyager.dash.publishing.TextBlock";
const LINKEDIN_TEXT_VIEW_MODEL_TYPE = "com.linkedin.voyager.dash.common.text.TextViewModel";
const LINKEDIN_TEXT_ATTRIBUTE_TYPE = "com.linkedin.voyager.dash.common.text.TextAttribute";
const LINKEDIN_IMAGE_BLOCK_TYPE = "com.linkedin.voyager.dash.publishing.ImageBlock";
const LINKEDIN_IMAGE_VIEW_MODEL_TYPE = "com.linkedin.voyager.dash.common.image.ImageViewModel";
const LINKEDIN_IMAGE_ATTRIBUTE_TYPE = "com.linkedin.voyager.dash.common.image.ImageAttribute";
const LINKEDIN_VECTOR_IMAGE_TYPE = "com.linkedin.common.VectorImage";
const LINKEDIN_VECTOR_ARTIFACT_TYPE = "com.linkedin.common.VectorArtifact";
const LINKEDIN_COVER_IMAGE_TYPE = "com.linkedin.voyager.dash.publishing.CoverImage";

export type LinkedInArticleDraftReadback = {
  readonly draftId: string;
  readonly title: string;
  readonly document: ArticleDraftDocument;
  readonly profileUrn: string;
};

export type LinkedInArticleDraftSnapshot = Omit<LinkedInArticleDraftReadback, "document"> & {
  readonly document: ArticleDraftDocument | null;
};

export type LinkedInArticleDraftV2Readback = Omit<LinkedInArticleDraftReadback, "document"> & {
  readonly document: ArticleDraftDocumentV2;
  readonly coverAssetUrn: string | null;
  readonly imageAssetUrns: readonly string[];
};

export type LinkedInArticleDraftV2Snapshot = Omit<LinkedInArticleDraftV2Readback, "document"> & {
  readonly document: ArticleDraftDocumentV2 | null;
};

function exactObjectKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function linkedInArticleImageKnownFieldMask(
  value: unknown,
  knownFields: readonly string[],
): string {
  if (!isRecord(value)) return "n";
  let mask = 0;
  let unknown = 0;
  for (const key of Object.keys(value)) {
    const index = knownFields.indexOf(key);
    if (index === -1) unknown += 1;
    else mask |= 1 << index;
  }
  return `${mask.toString(16)}u${Math.min(unknown, 99)}`;
}

function linkedInArticleImagePollingUrlClass(
  registration: Readonly<Record<string, unknown>> | null,
): string {
  if (registration === null || !Object.hasOwn(registration, "pollingUrl")) return "a";
  const value = registration.pollingUrl;
  if (value === null) return "n";
  if (typeof value !== "string") return "o";
  if (value.length > 64 * 1_024) return "b";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "m";
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || url.href !== value
  ) return "m";
  if (
    url.origin === "https://www.linkedin.com"
    && url.pathname.startsWith("/voyager/api/")
  ) return "v";
  if (url.origin === "https://www.linkedin.com") return "l";
  if (url.protocol === "https:") return "h";
  return "x";
}

/**
 * Produce a value-free bounded structural discriminator for reviewed live
 * contract work. It exposes no response values, URLs, IDs, or unknown names.
 */
export function linkedInArticleImageRegistrationDriftCategory(
  value: unknown,
  error: unknown,
): string {
  const envelope = isRecord(value) ? value : null;
  const data = envelope !== null && isRecord(envelope.data)
    ? envelope.data
    : envelope;
  const registration = data !== null && isRecord(data.value)
    ? data.value
    : null;
  const headers = registration !== null && isRecord(registration.singleUploadHeaders)
    ? registration.singleUploadHeaders
    : null;
  const message = error instanceof Error ? error.message : "";
  const step = message.includes("response.data.value has unsupported fields")
    ? "registration-fields"
    : message.includes("response.data has unsupported fields")
      ? "data-fields"
      : message.includes("response has unsupported fields")
        ? "envelope-fields"
        : message.includes("included entities")
          ? "included"
          : message.includes("response type")
            ? "response-type"
            : message.includes("media type")
              ? "media-type"
              : message.includes("assetRealtimeTopic")
                ? "realtime-topic"
                : message.includes("mediaArtifactUrn")
                  ? "artifact-urn"
                  : message.includes(" registration urn")
                    ? "asset-urn"
                    : message.includes("recipes")
                      ? "recipes"
                      : message.includes("upload headers")
                        ? "upload-headers"
                        : message.includes("polling URL")
                          ? "polling-url"
                          : message.includes("upload URL")
                            ? "upload-url"
                            : "other";
  const mediaType = registration?.type === "VECTOR"
    ? "v"
    : registration?.type === "SINGLE"
      ? "s"
      : registration?.type === "MULTIPART_FORMDATA"
        ? "f"
        : registration?.type === "MULTIPART"
          ? "m"
          : "o";
  return [
    step,
    `e${linkedInArticleImageKnownFieldMask(envelope, ["data", "included", "value"])}`,
    `d${linkedInArticleImageKnownFieldMask(data, ["$type", "value"])}`,
    `r${linkedInArticleImageKnownFieldMask(registration, [
      "$type",
      "assetRealtimeTopic",
      "mediaArtifactUrn",
      "multipartMetadata",
      "partUploadRequests",
      "pollingUrl",
      "recipes",
      "singleUploadHeaders",
      "singleUploadUrl",
      "type",
      "urn",
    ])}`,
    `h${linkedInArticleImageKnownFieldMask(headers, ["media-type-family"])}`,
    `t${mediaType}`,
    `p${linkedInArticleImagePollingUrlClass(registration)}`,
  ].join("-");
}

export function linkedInArticleDraftId(value: unknown, label = "LinkedIn Article draft ID"): string {
  if (typeof value !== "string" || !/^[0-9]{1,32}$/u.test(value)) {
    throw new Error(`${label} must be one exact 1-32 digit private LinkedIn Article ID`);
  }
  return value;
}

export function linkedInArticleDraftUrn(value: unknown): string {
  return `urn:li:fsd_firstPartyArticle:${linkedInArticleDraftId(value)}`;
}

function linkedInArticleProfileUrn(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 512
    || !/^urn:li:fsd_profile:[A-Za-z0-9_-]{1,256}$/u.test(value)
  ) throw new Error("LinkedIn Article profile URN is invalid");
  return value;
}

export function linkedInArticleDraftReadUrl(value: unknown): URL {
  const urn = linkedInArticleDraftUrn(value);
  const url = new URL(LINKEDIN_FIRST_PARTY_ARTICLES_PATH, "https://www.linkedin.com");
  url.searchParams.set("articleUrn", urn);
  url.searchParams.set("q", "articleUrn");
  return url;
}

export function linkedInArticleDraftEntityUrl(value: unknown): URL {
  const urn = linkedInArticleDraftUrn(value);
  return new URL(
    `${LINKEDIN_FIRST_PARTY_ARTICLES_PATH}/${urn}`,
    "https://www.linkedin.com",
  );
}

export function linkedInArticleDraftEditUrl(value: unknown): URL {
  const draftId = linkedInArticleDraftId(value);
  return new URL(`/article/edit/${draftId}/`, "https://www.linkedin.com");
}

export const LINKEDIN_ARTICLE_INLINE_IMAGE_UPLOAD_PATH =
  "/voyager/api/voyagerVideoDashMediaUploadMetadata?action=upload";

export type LinkedInArticleImageUploadBinding = {
  readonly assetUrn: string;
  readonly pollingUrl: string | null;
  readonly recipes: readonly string[];
  readonly uploadHeaders: Readonly<Record<string, string>>;
  readonly uploadUrl: string;
};

function linkedInArticleBoundUrl(
  value: unknown,
  label: string,
  pathPrefix: string,
): string {
  const href = boundedText(value, label, 64 * 1_024);
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Error(`${label} escaped its reviewed LinkedIn origin`);
  }
  if (
    url.origin !== "https://www.linkedin.com"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || !url.pathname.startsWith(pathPrefix)
    || url.href !== href
  ) throw new Error(`${label} escaped its reviewed LinkedIn origin`);
  return href;
}

/** Strictly bind registration output before any signed image upload occurs. */
export function normalizeLinkedInArticleImageUploadRegistration(
  value: unknown,
): LinkedInArticleImageUploadBinding {
  const envelope = graphqlRecord(value, "LinkedIn Article image registration response");
  const envelopeFields = Object.keys(envelope).sort().join(",");
  let dataValue: unknown;
  if (envelopeFields === "data,included") {
    if (!Array.isArray(envelope.included) || envelope.included.length !== 0) {
      throw new Error("LinkedIn Article image registration returned unexpected included entities");
    }
    const data = graphqlRecord(envelope.data, "LinkedIn Article image registration response.data");
    const dataFields = Object.keys(data).sort().join(",");
    if (dataFields === "$type,value") {
      if (data.$type !== "com.linkedin.restli.common.ActionResponse") {
        throw new Error("LinkedIn Article image registration changed its response type");
      }
    } else if (dataFields !== "value") {
      throw new Error("LinkedIn Article image registration response.data has unsupported fields");
    }
    dataValue = data.value;
  } else if (envelopeFields === "value") {
    dataValue = envelope.value;
  } else {
    throw new Error("LinkedIn Article image registration response has unsupported fields");
  }
  const registration = graphqlRecord(
    dataValue,
    "LinkedIn Article image registration response.data.value",
  );
  const fullRegistrationFields = [
    "$type",
    "assetRealtimeTopic",
    "mediaArtifactUrn",
    "pollingUrl",
    "recipes",
    "singleUploadHeaders",
    "singleUploadUrl",
    "type",
    "urn",
  ] as const;
  const legacySingleRegistrationFields = [
    "mediaArtifactUrn",
    "recipes",
    "singleUploadHeaders",
    "singleUploadUrl",
    "type",
    "urn",
  ] as const;
  const currentSingleRegistrationFields = [
    "$type",
    "mediaArtifactUrn",
    "singleUploadHeaders",
    "singleUploadUrl",
    "type",
    "urn",
  ] as const;
  const registrationFields = Object.keys(registration).sort().join(",");
  const fullFields = [...fullRegistrationFields].sort().join(",");
  const legacySingleFields = [...legacySingleRegistrationFields].sort().join(",");
  const currentSingleFields = [...currentSingleRegistrationFields].sort().join(",");
  if (
    registrationFields !== fullFields
    && registrationFields !== legacySingleFields
    && registrationFields !== currentSingleFields
  ) {
    throw new Error("LinkedIn Article image registration response.data.value has unsupported fields");
  }
  const fullRegistration = registrationFields === fullFields;
  const currentSingleRegistration = registrationFields === currentSingleFields;
  if (
    registration.$type !== undefined
    && registration.$type !== "com.linkedin.mediauploader.MediaUploadMetadata"
  ) throw new Error("LinkedIn Article image registration changed its response type");
  if (registration.type !== "VECTOR" && registration.type !== "SINGLE") {
    throw new Error("LinkedIn Article image registration changed its media type");
  }
  if (registration.type === "VECTOR" && !fullRegistration) {
    throw new Error("LinkedIn Article image registration response.data.value has unsupported fields");
  }
  if (fullRegistration) {
    boundedText(
      registration.assetRealtimeTopic,
      "LinkedIn Article image registration assetRealtimeTopic",
      4_096,
    );
  }
  linkedInUrn(
    registration.mediaArtifactUrn,
    "LinkedIn Article image registration mediaArtifactUrn",
  );
  const assetUrn = linkedInArticleImageAssetUrn(
    registration.urn,
    "LinkedIn Article image registration urn",
  );
  const recipeValues = currentSingleRegistration ? [] : registration.recipes;
  if (
    !Array.isArray(recipeValues)
    || (!currentSingleRegistration && recipeValues.length < 1)
    || recipeValues.length > 20
  ) {
    throw new Error("LinkedIn Article image registration recipes changed shape");
  }
  const recipes = recipeValues.map((recipe, index) =>
    linkedInUrn(recipe, `LinkedIn Article image registration recipes[${index}]`));
  if (new Set(recipes).size !== recipes.length) {
    throw new Error("LinkedIn Article image registration repeated a recipe");
  }
  const headers = graphqlRecord(
    registration.singleUploadHeaders,
    "LinkedIn Article image registration singleUploadHeaders",
  );
  exactObjectKeys(headers, ["media-type-family"], "LinkedIn Article image registration singleUploadHeaders");
  if (headers["media-type-family"] !== "STILLIMAGE") {
    throw new Error("LinkedIn Article image registration changed its upload headers");
  }
  let pollingUrl: string | null = null;
  if (fullRegistration && registration.type === "VECTOR") {
    pollingUrl = linkedInArticleBoundUrl(
      registration.pollingUrl,
      "LinkedIn Article image polling URL",
      "/voyager/api/",
    );
  } else if (
    fullRegistration
    && registration.type === "SINGLE"
    && registration.pollingUrl !== null
  ) {
    linkedInArticleBoundUrl(
      registration.pollingUrl,
      "LinkedIn Article image polling URL",
      "/",
    );
  }
  return Object.freeze({
    assetUrn,
    pollingUrl,
    recipes: Object.freeze(recipes),
    uploadHeaders: Object.freeze({ "media-type-family": "STILLIMAGE" }),
    uploadUrl: linkedInArticleBoundUrl(
      registration.singleUploadUrl,
      "LinkedIn Article image upload URL",
      "/dms-uploads/",
    ),
  });
}

/** Require every registered recipe to finish before an asset may enter a draft. */
export function normalizeLinkedInArticleImageUploadStatus(
  value: unknown,
  binding: LinkedInArticleImageUploadBinding,
): void {
  if (binding.pollingUrl === null) {
    throw new Error("LinkedIn Article image registration did not expose a polling contract");
  }
  const status = graphqlRecord(value, "LinkedIn Article image status response");
  exactObjectKeys(status, ["asset", "assetStatus", "status"], "LinkedIn Article image status response");
  if (status.asset !== binding.assetUrn || status.assetStatus !== "ALLOWED") {
    throw new Error("LinkedIn Article image status did not bind one allowed asset");
  }
  const recipes = graphqlRecord(status.status, "LinkedIn Article image status response.status");
  exactObjectKeys(recipes, binding.recipes, "LinkedIn Article image status response.status");
  if (binding.recipes.some((recipe) => recipes[recipe] !== "AVAILABLE")) {
    throw new Error("LinkedIn Article image processing did not finish every recipe");
  }
}

type LinkedInArticleCodePayload = {
  readonly attributes: string;
  readonly body: string;
};

function linkedInArticleCodeAttributes(value: unknown): void {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("LinkedIn Article bootstrap code attributes exceeded their reviewed bound");
  }
  const attributes = new Map<string, string>();
  let remaining = value.trim();
  while (remaining.length > 0) {
    const match = /^([A-Za-z][A-Za-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(remaining);
    if (match === null) {
      throw new Error("LinkedIn Article bootstrap code attributes changed shape");
    }
    const name = match[1]?.toLowerCase();
    const attributeValue = match[2] ?? match[3];
    if (name === undefined || attributeValue === undefined || attributes.has(name)) {
      throw new Error("LinkedIn Article bootstrap code attributes were ambiguous");
    }
    attributes.set(name, attributeValue);
    remaining = remaining.slice(match[0].length).trimStart();
  }
  if ([...attributes.keys()].sort().join(",") !== "id,style") {
    throw new Error("LinkedIn Article bootstrap code attributes changed shape");
  }
  if (!/^bpr-guid-[0-9]{1,12}$/u.test(attributes.get("id") ?? "")) {
    throw new Error("LinkedIn Article bootstrap code identifier changed shape");
  }
  const style = (attributes.get("style") ?? "").replace(/\s/gu, "");
  if (style !== "display:none" && style !== "display:none;") {
    throw new Error("LinkedIn Article bootstrap code payload is no longer hidden");
  }
}

const LINKEDIN_ARTICLE_HTML_ENTITY =
  /&(?:quot|amp|lt|gt|apos|#(?:[xX][0-9A-Fa-f]{1,6}|[0-9]{1,7}));/gu;

function decodeLinkedInArticleEntity(entity: string): string {
  if (entity === "&quot;") return '"';
  if (entity === "&amp;") return "&";
  if (entity === "&lt;") return "<";
  if (entity === "&gt;") return ">";
  if (entity === "&apos;") return "'";
  const numeric = /^&#(?:[xX]([0-9A-Fa-f]{1,6})|([0-9]{1,7}));$/u.exec(entity);
  if (numeric === null) {
    throw new Error("LinkedIn Article bootstrap used an unsupported HTML entity");
  }
  const codePoint = Number.parseInt(numeric[1] ?? numeric[2] ?? "", numeric[1] === undefined ? 10 : 16);
  if (
    !Number.isSafeInteger(codePoint)
    || codePoint < 0
    || codePoint > 0x10_FFFF
    || (codePoint >= 0xD800 && codePoint <= 0xDFFF)
  ) throw new Error("LinkedIn Article bootstrap used an invalid numeric HTML entity");
  return String.fromCodePoint(codePoint);
}

function parseLinkedInArticleCodePayload(
  value: LinkedInArticleCodePayload,
  draftUrn: string,
): unknown {
  linkedInArticleCodeAttributes(value.attributes);
  if (
    value.body.length < 1
    || value.body.length > LINKEDIN_ARTICLE_CODE_PAYLOAD_MAX_CHARACTERS
    || !value.body.includes(draftUrn)
  ) throw new Error("LinkedIn Article bootstrap code payload did not bind the exact draft");
  const json = value.body.replace(
    LINKEDIN_ARTICLE_HTML_ENTITY,
    (entity) => decodeLinkedInArticleEntity(entity),
  ).trim();
  if (!json.startsWith("{") || !json.endsWith("}")) {
    throw new Error("LinkedIn Article bootstrap code payload changed its JSON boundary");
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error("LinkedIn Article bootstrap code payload contained malformed JSON");
  }
}

/**
 * Select the one exact hidden server-response payload for a private draft.
 * Payloads are produced by the contained browser's bounded HTML scan; callers
 * cannot provide HTML, selectors, or code through the semantic operation.
 */
export function linkedInArticleDraftEnvelopeFromCodePayloads(
  value: unknown,
  draftIdValue: unknown,
): unknown {
  const draftUrn = linkedInArticleDraftUrn(draftIdValue);
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("LinkedIn Article bootstrap did not isolate one exact hidden payload");
  }
  const payload = graphqlRecord(value[0], "Article bootstrap code payload");
  exactObjectKeys(
    payload,
    ["attributes", "body"],
    "LinkedIn Article bootstrap code payload",
  );
  const attributes = boundedText(
    payload.attributes,
    "LinkedIn Article bootstrap code attributes",
    4_096,
  );
  const body = boundedText(
    payload.body,
    "LinkedIn Article bootstrap code body",
    LINKEDIN_ARTICLE_CODE_PAYLOAD_MAX_CHARACTERS,
  );
  return parseLinkedInArticleCodePayload({ attributes, body }, draftUrn);
}

/** Extract the same bounded hidden payload from an authenticated HTML response. */
export function linkedInArticleDraftEnvelopeFromHtml(
  value: unknown,
  draftIdValue: unknown,
): unknown {
  const draftUrn = linkedInArticleDraftUrn(draftIdValue);
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > LINKEDIN_ARTICLE_PAGE_MAX_CHARACTERS
  ) throw new Error("LinkedIn Article page exceeded its reviewed HTML bound");
  const payloads: LinkedInArticleCodePayload[] = [];
  let codeTags = 0;
  for (const match of value.matchAll(/<code\b([^>]*)>([\s\S]*?)<\/code>/giu)) {
    codeTags += 1;
    if (codeTags > LINKEDIN_ARTICLE_CODE_TAG_MAX_COUNT) {
      throw new Error("LinkedIn Article page returned too many code payloads");
    }
    const attributes = match[1];
    const body = match[2];
    if (attributes === undefined || body === undefined || !body.includes(draftUrn)) continue;
    payloads.push(Object.freeze({ attributes, body }));
    if (payloads.length > LINKEDIN_ARTICLE_MATCHING_PAYLOAD_MAX_COUNT) {
      throw new Error("LinkedIn Article page returned too many matching payloads");
    }
  }
  return linkedInArticleDraftEnvelopeFromCodePayloads(payloads, draftIdValue);
}

function linkedInArticleBlockType(type: ArticleDraftTextBlock["type"]): string {
  if (type === "paragraph") return "PARAGRAPH";
  if (type === "heading1") return "HEADING_1";
  if (type === "heading2") return "HEADING_2";
  throw new Error(
    "LinkedIn Article drafts currently support only paragraph, heading1, and heading2 blocks",
  );
}

function linkedInArticleDocumentBlockType(value: unknown, label: string): ArticleDraftTextBlock["type"] {
  if (value === "PARAGRAPH") return "paragraph";
  if (value === "HEADING_1") return "heading1";
  if (value === "HEADING_2") return "heading2";
  throw new Error(`${label} has an unsupported LinkedIn Article text-block type`);
}

function linkedInArticleAttribute(link: ArticleDraftLinkRange): Readonly<Record<string, unknown>> {
  return Object.freeze({
    $type: LINKEDIN_TEXT_ATTRIBUTE_TYPE,
    detailDataUnion: Object.freeze({ hyperlink: link.url }),
    length: link.length,
    start: link.offset,
  });
}

/** Project the reviewed text/headings/native-link subset into LinkedIn's Article model. */
export function buildLinkedInArticleContent(
  document: ArticleDraftDocument,
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(document.blocks.map((block) => {
    if (block.styles.length !== 0) {
      throw new Error("LinkedIn Article text styles remain capture-required");
    }
    return Object.freeze({
      textBlock: Object.freeze({
        $type: LINKEDIN_TEXT_BLOCK_TYPE,
        content: Object.freeze({
          $type: LINKEDIN_TEXT_VIEW_MODEL_TYPE,
          attributesV2: Object.freeze(block.links.map(linkedInArticleAttribute)),
          text: block.text,
        }),
        type: linkedInArticleBlockType(block.type),
      }),
    });
  }));
}

function linkedInArticleImageAssetUrn(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length > 512
    || !/^urn:li:digitalmediaAsset:[A-Za-z0-9_-]{1,256}$/u.test(value)
  ) throw new Error(`${label} must be one exact LinkedIn digital-media asset URN`);
  return value;
}

function linkedInArticleImageWriteBlock(
  block: ArticleDraftImageBlock,
  assetUrnValue: unknown,
): Readonly<Record<string, unknown>> {
  const assetUrn = linkedInArticleImageAssetUrn(
    assetUrnValue,
    `LinkedIn Article image ${block.imageIndex}`,
  );
  if (block.altText === undefined) {
    throw new Error("LinkedIn Article inline images require descriptive altText");
  }
  return Object.freeze({
    imageBlock: Object.freeze({
      $type: LINKEDIN_IMAGE_BLOCK_TYPE,
      alignment: "FULL_WIDTH",
      caption: Object.freeze({
        $type: LINKEDIN_TEXT_VIEW_MODEL_TYPE,
        text: block.caption ?? "",
      }),
      content: Object.freeze({
        $type: LINKEDIN_IMAGE_VIEW_MODEL_TYPE,
        accessibilityText: block.altText,
        attributes: Object.freeze([Object.freeze({
          $type: LINKEDIN_IMAGE_ATTRIBUTE_TYPE,
          detailDataUnion: Object.freeze({
            vectorImage: Object.freeze({
              $type: LINKEDIN_VECTOR_IMAGE_TYPE,
              artifacts: Object.freeze([]),
              digitalmediaAsset: assetUrn,
            }),
          }),
        })]),
      }),
    }),
  });
}

/** Project mixed text/images into LinkedIn's captured Article write model. */
export function buildLinkedInArticleContentV2(
  document: ArticleDraftDocumentV2,
  imageAssetUrns: readonly string[],
): readonly Readonly<Record<string, unknown>>[] {
  const used = new Set<number>();
  const content = document.blocks.map((block) => {
    if (block.type === "image") {
      used.add(block.imageIndex);
      return linkedInArticleImageWriteBlock(block, imageAssetUrns[block.imageIndex]);
    }
    return buildLinkedInArticleContent(Object.freeze({
      schemaVersion: 1,
      blocks: Object.freeze([block]),
    }))[0]!;
  });
  if (
    imageAssetUrns.length !== used.size
    || imageAssetUrns.some((_, index) => !used.has(index))
  ) throw new Error("LinkedIn Article image assets did not bind every exact image block");
  return Object.freeze(content);
}

function escapeLinkedInArticleHtmlText(value: string): string {
  return value.replace(/[&<>]/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    return "&gt;";
  });
}

function escapeLinkedInArticleHtmlAttribute(value: string): string {
  return value.replace(/[&<>"]/gu, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return "&quot;";
  });
}

function linkedInArticleHtmlTag(type: ArticleDraftTextBlock["type"]): "p" | "h2" | "h3" {
  if (type === "paragraph") return "p";
  if (type === "heading1") return "h2";
  if (type === "heading2") return "h3";
  throw new Error(
    "LinkedIn Article drafts currently support only paragraph, heading1, and heading2 blocks",
  );
}

/** Project the reviewed Article subset into LinkedIn's required rendered HTML. */
export function buildLinkedInArticleContentHtml(document: ArticleDraftDocument): string {
  return document.blocks.map((block) => {
    if (block.styles.length !== 0) {
      throw new Error("LinkedIn Article text styles remain capture-required");
    }
    let cursor = 0;
    let content = "";
    for (const link of block.links) {
      content += escapeLinkedInArticleHtmlText(block.text.slice(cursor, link.offset));
      content += `<a href="${escapeLinkedInArticleHtmlAttribute(link.url)}" target="_blank">`;
      content += escapeLinkedInArticleHtmlText(
        block.text.slice(link.offset, link.offset + link.length),
      );
      content += "</a>";
      cursor = link.offset + link.length;
    }
    content += escapeLinkedInArticleHtmlText(block.text.slice(cursor));
    const tag = linkedInArticleHtmlTag(block.type);
    return `<${tag}>${content}</${tag}>`;
  }).join("");
}

/**
 * LinkedIn accepts the stable asset URN as the image identity and restores the
 * transient CDN source itself. Keeping that source out of the confirmed input
 * also prevents signed or expiring provider URLs from entering durable state.
 */
export function buildLinkedInArticleContentHtmlV2(
  document: ArticleDraftDocumentV2,
  imageAssetUrns: readonly string[],
): string {
  const used = new Set<number>();
  const html = document.blocks.map((block) => {
    if (block.type !== "image") {
      return buildLinkedInArticleContentHtml(Object.freeze({
        schemaVersion: 1,
        blocks: Object.freeze([block]),
      }));
    }
    const assetUrn = linkedInArticleImageAssetUrn(
      imageAssetUrns[block.imageIndex],
      `LinkedIn Article image ${block.imageIndex}`,
    );
    used.add(block.imageIndex);
    return `<figure><img data-media-urn="${escapeLinkedInArticleHtmlAttribute(assetUrn)}"><figcaption>${escapeLinkedInArticleHtmlText(block.caption ?? "")}</figcaption></figure>`;
  }).join("");
  if (
    imageAssetUrns.length !== used.size
    || imageAssetUrns.some((_, index) => !used.has(index))
  ) throw new Error("LinkedIn Article image assets did not bind every exact image block");
  return html;
}

export function buildLinkedInArticleCreateBody(
  profileUrnValue: unknown,
  titleValue: unknown,
): Readonly<Record<string, unknown>> {
  const profileUrn = linkedInArticleProfileUrn(profileUrnValue);
  if (
    typeof titleValue !== "string"
    || titleValue.length < 1
    || titleValue.length > 150
    || /[\0\r\n]/u.test(titleValue)
  ) throw new Error("input.title must be one bounded plain-text line");
  return Object.freeze({
    authors: Object.freeze([Object.freeze({ profileUrn })]),
    contentHtml: "",
    state: "AUTOSAVED",
    title: titleValue,
  });
}

export function buildLinkedInArticleTitlePatch(titleValue: unknown): Readonly<Record<string, unknown>> {
  const title = buildLinkedInArticleCreateBody("urn:li:fsd_profile:fixture", titleValue).title;
  return Object.freeze({
    patch: Object.freeze({ $set: Object.freeze({ state: "AUTOSAVED", title }) }),
  });
}

export function buildLinkedInArticleCoverPatch(
  assetUrnValue: unknown,
): Readonly<Record<string, unknown>> {
  const originalImageUrn = linkedInArticleImageAssetUrn(
    assetUrnValue,
    "LinkedIn Article cover image",
  );
  return Object.freeze({
    patch: Object.freeze({
      $set: Object.freeze({
        coverMediaV2Union: Object.freeze({
          coverImage: Object.freeze({
            $type: LINKEDIN_COVER_IMAGE_TYPE,
            caption: Object.freeze({ text: "" }),
            originalImageUrn,
          }),
        }),
        state: "AUTOSAVED",
      }),
    }),
  });
}

export function buildLinkedInArticleContentPatch(
  document: ArticleDraftDocument,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    patch: Object.freeze({
      $set: Object.freeze({
        content: buildLinkedInArticleContent(document),
        contentHtml: buildLinkedInArticleContentHtml(document),
        state: "AUTOSAVED",
      }),
    }),
  });
}

export function buildLinkedInArticleContentPatchV2(
  document: ArticleDraftDocumentV2,
  imageAssetUrns: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    patch: Object.freeze({
      $set: Object.freeze({
        content: buildLinkedInArticleContentV2(document, imageAssetUrns),
        contentHtml: buildLinkedInArticleContentHtmlV2(document, imageAssetUrns),
        state: "AUTOSAVED",
      }),
    }),
  });
}

function normalizeLinkedInArticleLink(
  value: unknown,
  text: string,
  label: string,
): ArticleDraftLinkRange {
  const attribute = graphqlRecord(value, label);
  exactObjectKeys(attribute, ["$type", "detailDataUnion", "length", "start"], label);
  if (attribute.$type !== LINKEDIN_TEXT_ATTRIBUTE_TYPE) {
    throw new Error(`${label} changed its reviewed LinkedIn text-attribute type`);
  }
  const detail = graphqlRecord(attribute.detailDataUnion, `${label}.detailDataUnion`);
  exactObjectKeys(detail, ["hyperlink"], `${label}.detailDataUnion`);
  const start = attribute.start;
  const length = attribute.length;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(length)
    || (start as number) < 0
    || (length as number) < 1
    || (start as number) + (length as number) > text.length
  ) throw new Error(`${label} escaped its LinkedIn Article text`);
  const hyperlink = boundedText(detail.hyperlink, `${label}.hyperlink`, 8_192);
  let parsed: URL;
  try {
    parsed = new URL(hyperlink);
  } catch {
    throw new Error(`${label}.hyperlink is not an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.href !== hyperlink
  ) throw new Error(`${label}.hyperlink is not one canonical absolute HTTPS URL`);
  return Object.freeze({ offset: start as number, length: length as number, url: hyperlink });
}

function normalizeLinkedInArticleBlock(value: unknown, index: number): ArticleDraftTextBlock {
  const label = `LinkedIn Article content[${index}]`;
  const wrapper = graphqlRecord(value, label);
  exactObjectKeys(wrapper, ["textBlock"], label);
  const textBlock = graphqlRecord(wrapper.textBlock, `${label}.textBlock`);
  exactObjectKeys(textBlock, ["$type", "content", "type"], `${label}.textBlock`);
  if (textBlock.$type !== LINKEDIN_TEXT_BLOCK_TYPE) {
    throw new Error(`${label}.textBlock changed its reviewed type`);
  }
  const content = graphqlRecord(textBlock.content, `${label}.textBlock.content`);
  exactObjectKeys(content, ["$type", "attributesV2", "text"], `${label}.textBlock.content`);
  if (content.$type !== LINKEDIN_TEXT_VIEW_MODEL_TYPE) {
    throw new Error(`${label}.textBlock.content changed its reviewed type`);
  }
  if (typeof content.text !== "string" || /[\0\r\n]/u.test(content.text)) {
    throw new Error(`${label}.textBlock.content.text must be one bounded line`);
  }
  if (!Array.isArray(content.attributesV2) || content.attributesV2.length > 500) {
    throw new Error(`${label}.textBlock.content.attributesV2 exceeded its reviewed bound`);
  }
  const links = content.attributesV2.map((attribute, linkIndex) =>
    normalizeLinkedInArticleLink(
      attribute,
      content.text as string,
      `${label}.textBlock.content.attributesV2[${linkIndex}]`,
    ));
  let linkEnd = 0;
  for (const link of links) {
    if (link.offset < linkEnd) throw new Error(`${label} links must be ordered and non-overlapping`);
    linkEnd = link.offset + link.length;
  }
  return Object.freeze({
    type: linkedInArticleDocumentBlockType(textBlock.type, `${label}.textBlock.type`),
    text: content.text,
    links: Object.freeze(links),
    styles: Object.freeze([]),
  });
}

function linkedInCanonicalHttpsUrl(value: unknown, label: string): string {
  const url = boundedText(value, label, 8_192);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not one canonical absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.href !== url
  ) throw new Error(`${label} is not one canonical absolute HTTPS URL`);
  return url;
}

function normalizeLinkedInArticleImageBlock(
  value: unknown,
  index: number,
  imageIndex: number,
): { readonly block: ArticleDraftImageBlock; readonly assetUrn: string } {
  const label = `LinkedIn Article content[${index}]`;
  const wrapper = graphqlRecord(value, label);
  exactObjectKeys(wrapper, ["imageBlock"], label);
  const imageBlock = graphqlRecord(wrapper.imageBlock, `${label}.imageBlock`);
  exactObjectKeys(
    imageBlock,
    ["$type", "alignment", "caption", "content"],
    `${label}.imageBlock`,
  );
  if (
    imageBlock.$type !== LINKEDIN_IMAGE_BLOCK_TYPE
    || imageBlock.alignment !== "FULL_WIDTH"
  ) throw new Error(`${label}.imageBlock changed its reviewed type or alignment`);

  const captionModel = graphqlRecord(imageBlock.caption, `${label}.imageBlock.caption`);
  exactObjectKeys(
    captionModel,
    ["$type", "attributesV2", "text"],
    `${label}.imageBlock.caption`,
  );
  if (
    captionModel.$type !== LINKEDIN_TEXT_VIEW_MODEL_TYPE
    || !Array.isArray(captionModel.attributesV2)
    || captionModel.attributesV2.length !== 0
    || typeof captionModel.text !== "string"
    || captionModel.text.length > 1_000
    || /[\0\r]/u.test(captionModel.text)
  ) throw new Error(`${label}.imageBlock.caption changed its reviewed shape`);

  const content = graphqlRecord(imageBlock.content, `${label}.imageBlock.content`);
  exactObjectKeys(
    content,
    ["$type", "accessibilityText", "accessibilityTextAttributes", "attributes"],
    `${label}.imageBlock.content`,
  );
  if (
    content.$type !== LINKEDIN_IMAGE_VIEW_MODEL_TYPE
    || typeof content.accessibilityText !== "string"
    || content.accessibilityText.length < 1
    || content.accessibilityText.length > 1_000
    || /[\0\r]/u.test(content.accessibilityText)
    || !Array.isArray(content.accessibilityTextAttributes)
    || content.accessibilityTextAttributes.length !== 0
    || !Array.isArray(content.attributes)
    || content.attributes.length !== 1
  ) throw new Error(`${label}.imageBlock.content changed its reviewed shape`);

  const attribute = graphqlRecord(content.attributes[0], `${label}.imageBlock.content.attributes[0]`);
  exactObjectKeys(attribute, ["$type", "detailDataUnion"], `${label}.imageBlock.content.attributes[0]`);
  if (attribute.$type !== LINKEDIN_IMAGE_ATTRIBUTE_TYPE) {
    throw new Error(`${label}.imageBlock.content changed its reviewed image attribute`);
  }
  const detail = graphqlRecord(
    attribute.detailDataUnion,
    `${label}.imageBlock.content.attributes[0].detailDataUnion`,
  );
  exactObjectKeys(detail, ["vectorImage"], `${label}.imageBlock.content.attributes[0].detailDataUnion`);
  const vector = graphqlRecord(
    detail.vectorImage,
    `${label}.imageBlock.content.attributes[0].detailDataUnion.vectorImage`,
  );
  exactObjectKeys(
    vector,
    ["$type", "artifacts", "digitalmediaAsset", "rootUrl"],
    `${label}.imageBlock.content.attributes[0].detailDataUnion.vectorImage`,
  );
  if (
    vector.$type !== LINKEDIN_VECTOR_IMAGE_TYPE
    || !Array.isArray(vector.artifacts)
    || vector.artifacts.length < 1
    || vector.artifacts.length > 20
  ) throw new Error(`${label}.imageBlock vector image changed its reviewed shape`);
  const assetUrn = linkedInArticleImageAssetUrn(
    vector.digitalmediaAsset,
    `${label}.imageBlock vector image`,
  );
  linkedInCanonicalHttpsUrl(vector.rootUrl, `${label}.imageBlock vector image rootUrl`);
  for (const [artifactIndex, rawArtifact] of vector.artifacts.entries()) {
    const artifactLabel = `${label}.imageBlock vector image artifacts[${artifactIndex}]`;
    const artifact = graphqlRecord(rawArtifact, artifactLabel);
    exactObjectKeys(
      artifact,
      ["$type", "expiresAt", "fileIdentifyingUrlPathSegment", "height", "width"],
      artifactLabel,
    );
    if (
      artifact.$type !== LINKEDIN_VECTOR_ARTIFACT_TYPE
      || !Number.isSafeInteger(artifact.expiresAt)
      || (artifact.expiresAt as number) < 0
      || !Number.isSafeInteger(artifact.height)
      || (artifact.height as number) < 1
      || !Number.isSafeInteger(artifact.width)
      || (artifact.width as number) < 1
      || typeof artifact.fileIdentifyingUrlPathSegment !== "string"
      || artifact.fileIdentifyingUrlPathSegment.length < 1
      || artifact.fileIdentifyingUrlPathSegment.length > 4_096
      || /[\0\r\n]/u.test(artifact.fileIdentifyingUrlPathSegment)
    ) throw new Error(`${artifactLabel} changed its reviewed shape`);
  }
  return Object.freeze({
    assetUrn,
    block: Object.freeze({
      type: "image",
      imageIndex,
      altText: content.accessibilityText,
      ...(captionModel.text === "" ? {} : { caption: captionModel.text }),
    }),
  });
}

function normalizeLinkedInCoverImageViewModel(
  value: unknown,
  label: string,
  requireAssetUrn: boolean,
): string | null {
  const image = graphqlRecord(value, label);
  exactObjectKeys(image, ["$type", "attributes"], label);
  if (
    image.$type !== LINKEDIN_IMAGE_VIEW_MODEL_TYPE
    || !Array.isArray(image.attributes)
    || image.attributes.length !== 1
  ) throw new Error(`${label} changed its reviewed image shape`);
  const attribute = graphqlRecord(image.attributes[0], `${label}.attributes[0]`);
  exactObjectKeys(attribute, ["$type", "detailDataUnion"], `${label}.attributes[0]`);
  if (attribute.$type !== LINKEDIN_IMAGE_ATTRIBUTE_TYPE) {
    throw new Error(`${label} changed its reviewed image attribute`);
  }
  const detail = graphqlRecord(
    attribute.detailDataUnion,
    `${label}.attributes[0].detailDataUnion`,
  );
  exactObjectKeys(detail, ["vectorImage"], `${label}.attributes[0].detailDataUnion`);
  const vector = graphqlRecord(
    detail.vectorImage,
    `${label}.attributes[0].detailDataUnion.vectorImage`,
  );
  exactObjectKeys(
    vector,
    requireAssetUrn
      ? ["$type", "artifacts", "digitalmediaAsset", "rootUrl"]
      : ["$type", "artifacts", "rootUrl"],
    `${label}.attributes[0].detailDataUnion.vectorImage`,
  );
  if (
    vector.$type !== LINKEDIN_VECTOR_IMAGE_TYPE
    || !Array.isArray(vector.artifacts)
    || vector.artifacts.length < 1
    || vector.artifacts.length > 20
  ) throw new Error(`${label} changed its reviewed vector image shape`);
  linkedInCanonicalHttpsUrl(vector.rootUrl, `${label}.vectorImage.rootUrl`);
  for (const [artifactIndex, rawArtifact] of vector.artifacts.entries()) {
    const artifactLabel = `${label}.vectorImage.artifacts[${artifactIndex}]`;
    const artifact = graphqlRecord(rawArtifact, artifactLabel);
    exactObjectKeys(
      artifact,
      ["$type", "expiresAt", "fileIdentifyingUrlPathSegment", "height", "width"],
      artifactLabel,
    );
    if (
      artifact.$type !== LINKEDIN_VECTOR_ARTIFACT_TYPE
      || !Number.isSafeInteger(artifact.expiresAt)
      || (artifact.expiresAt as number) < 0
      || !Number.isSafeInteger(artifact.height)
      || (artifact.height as number) < 1
      || !Number.isSafeInteger(artifact.width)
      || (artifact.width as number) < 1
      || typeof artifact.fileIdentifyingUrlPathSegment !== "string"
      || artifact.fileIdentifyingUrlPathSegment.length < 1
      || artifact.fileIdentifyingUrlPathSegment.length > 4_096
      || /[\0\r\n]/u.test(artifact.fileIdentifyingUrlPathSegment)
    ) throw new Error(`${artifactLabel} changed its reviewed shape`);
  }
  return requireAssetUrn
    ? linkedInArticleImageAssetUrn(vector.digitalmediaAsset, `${label}.vectorImage`)
    : null;
}

function normalizeLinkedInArticleCover(
  coverMediaValue: unknown,
  coverMediaV2UnionValue: unknown,
): string | null {
  if (coverMediaValue === null && coverMediaV2UnionValue === null) return null;
  if (coverMediaValue === null || coverMediaV2UnionValue === null) {
    throw new Error("LinkedIn Article cover readback omitted one reviewed cover projection");
  }
  const legacy = graphqlRecord(coverMediaValue, "LinkedIn Article coverMedia");
  exactObjectKeys(
    legacy,
    ["$type", "caption", "originalImage", "originalImageUrn"],
    "LinkedIn Article coverMedia",
  );
  if (legacy.$type !== LINKEDIN_COVER_IMAGE_TYPE) {
    throw new Error("LinkedIn Article coverMedia changed its reviewed type");
  }
  const legacyAssetUrn = linkedInArticleImageAssetUrn(
    legacy.originalImageUrn,
    "LinkedIn Article coverMedia.originalImageUrn",
  );
  normalizeLinkedInCoverImageViewModel(
    legacy.originalImage,
    "LinkedIn Article coverMedia.originalImage",
    false,
  );
  const caption = graphqlRecord(legacy.caption, "LinkedIn Article coverMedia.caption");
  exactObjectKeys(
    caption,
    ["$type", "attributesV2", "text", "textDirection"],
    "LinkedIn Article coverMedia.caption",
  );
  if (
    caption.$type !== LINKEDIN_TEXT_VIEW_MODEL_TYPE
    || !Array.isArray(caption.attributesV2)
    || caption.attributesV2.length !== 0
    || caption.text !== ""
    || caption.textDirection !== "USER_LOCALE"
  ) throw new Error("LinkedIn Article cover caption changed its reviewed empty shape");

  const union = graphqlRecord(
    coverMediaV2UnionValue,
    "LinkedIn Article coverMediaV2Union",
  );
  exactObjectKeys(union, ["coverImage"], "LinkedIn Article coverMediaV2Union");
  const cover = graphqlRecord(
    union.coverImage,
    "LinkedIn Article coverMediaV2Union.coverImage",
  );
  exactObjectKeys(
    cover,
    ["$type", "originalImage", "originalImageUrn"],
    "LinkedIn Article coverMediaV2Union.coverImage",
  );
  if (cover.$type !== LINKEDIN_COVER_IMAGE_TYPE) {
    throw new Error("LinkedIn Article coverMediaV2Union changed its reviewed type");
  }
  const unionAssetUrn = linkedInArticleImageAssetUrn(
    cover.originalImageUrn,
    "LinkedIn Article coverMediaV2Union.coverImage.originalImageUrn",
  );
  const vectorAssetUrn = normalizeLinkedInCoverImageViewModel(
    cover.originalImage,
    "LinkedIn Article coverMediaV2Union.coverImage.originalImage",
    true,
  );
  if (legacyAssetUrn !== unionAssetUrn || unionAssetUrn !== vectorAssetUrn) {
    throw new Error("LinkedIn Article cover projections no longer bind one exact asset");
  }
  return unionAssetUrn;
}

type LinkedInArticleNormalizedDocument =
  | ArticleDraftDocument
  | ArticleDraftDocumentV2;

type LinkedInArticleNormalizedSnapshot = {
  readonly draftId: string;
  readonly title: string;
  readonly document: LinkedInArticleNormalizedDocument | null;
  readonly profileUrn: string;
  readonly coverAssetUrn: string | null;
  readonly imageAssetUrns: readonly string[];
};

function normalizeLinkedInArticleDraftValue(
  value: unknown,
  draftIdValue: unknown,
  profileUrnValue: unknown,
  allowEmptyContent: boolean,
  schemaVersion: 1 | 2 = 1,
  metadataOnly = false,
  normalizeDocument = true,
): LinkedInArticleNormalizedSnapshot {
  const draftId = linkedInArticleDraftId(draftIdValue);
  const profileUrn = linkedInArticleProfileUrn(profileUrnValue);
  const urn = linkedInArticleDraftUrn(draftId);
  const normalized = normalizeLinkedInGraphqlEnvelope(value);
  exactObjectKeys(
    normalized.data,
    ["$type", "*elements", "entityUrn", "paging"],
    "LinkedIn Article response.data",
  );
  if (normalized.data.$type !== LINKEDIN_ARTICLE_COLLECTION_TYPE) {
    throw new Error("LinkedIn Article readback changed its collection response type");
  }
  linkedInUrn(
    normalized.data.entityUrn,
    "LinkedIn Article readback collection entityUrn",
  );
  const paging = graphqlRecord(
    normalized.data.paging,
    "LinkedIn Article response.data.paging",
  );
  exactObjectKeys(
    paging,
    ["count", "links", "start"],
    "LinkedIn Article response.data.paging",
  );
  if (
    nonnegativeInteger(paging.count, "LinkedIn Article response.data.paging.count") !== 10
    || nonnegativeInteger(paging.start, "LinkedIn Article response.data.paging.start") !== 0
    || !Array.isArray(paging.links)
    || paging.links.length !== 0
  ) throw new Error("LinkedIn Article readback changed its exact draft paging boundary");
  if (
    !Array.isArray(normalized.data["*elements"])
    || normalized.data["*elements"].length !== 1
    || normalized.data["*elements"][0] !== urn
  ) throw new Error("LinkedIn Article readback did not select the exact draft");
  const article = normalized.entitiesByUrn.get(urn);
  if (article === undefined) throw new Error("LinkedIn Article readback omitted the exact draft entity");
  exactObjectKeys(article, [
    "$type",
    "activityUrn",
    "annotation",
    "annotationActionType",
    "articleActionUnions",
    "articleAnnotation",
    "articlePublishedTimeDescription",
    "articleType",
    "authors",
    "availableLocales",
    "content",
    "contentDescription",
    "contentHtml",
    "contentSegments",
    "coverMedia",
    "coverMediaV2Union",
    "createdAt",
    "entityUrn",
    "featured",
    "followingStateUrn",
    "gatedArticleMetadata",
    "initialUpdateUrn",
    "issueNumber",
    "linkedInArticleUrn",
    "locale",
    "memberContributionInsight",
    "permalink",
    "publishedAt",
    "scheduledAt",
    "seoDescription",
    "seoTitle",
    "series",
    "servedLocale",
    "socialDetailUrn",
    "socialProofInsight",
    "sponsoredAccountUrn",
    "state",
    "surveyComponent",
    "title",
    "trackingId",
    "ugcPostUrn",
    "updatedAt",
    "version",
    "viewerAllowedToEdit",
  ], "LinkedIn Article readback entity");
  const nullFields = [
    "activityUrn",
    "annotation",
    "annotationActionType",
    "articleAnnotation",
    "articlePublishedTimeDescription",
    "contentDescription",
    "contentSegments",
    "featured",
    "gatedArticleMetadata",
    "initialUpdateUrn",
    "issueNumber",
    "locale",
    "memberContributionInsight",
    "permalink",
    "publishedAt",
    "scheduledAt",
    "seoDescription",
    "seoTitle",
    "series",
    "servedLocale",
    "socialDetailUrn",
    "socialProofInsight",
    "sponsoredAccountUrn",
    "surveyComponent",
    "trackingId",
    "ugcPostUrn",
    "viewerAllowedToEdit",
  ] as const;
  if (nullFields.some((field) => article[field] !== null)) {
    throw new Error("LinkedIn Article readback was not the exact private unpublished draft");
  }
  const coverAssetUrn = normalizeLinkedInArticleCover(
    article.coverMedia,
    article.coverMediaV2Union,
  );
  if (
    article.$type !== LINKEDIN_ARTICLE_TYPE
    || article.entityUrn !== urn
    || article.linkedInArticleUrn !== `urn:li:linkedInArticle:${draftId}`
    || article.state !== "DRAFT"
    || article.articleType !== "FIRST_PARTY_ARTICLE"
  ) throw new Error("LinkedIn Article readback was not the exact private unpublished draft");
  if (
    !Array.isArray(article.articleActionUnions)
    || article.articleActionUnions.length !== 0
    || !Array.isArray(article.availableLocales)
    || article.availableLocales.length !== 0
  ) throw new Error("LinkedIn Article readback added unsupported actions or locales");
  linkedInUrn(
    article.followingStateUrn,
    "LinkedIn Article readback followingStateUrn",
  );
  if (!Array.isArray(article.authors) || article.authors.length !== 1) {
    throw new Error("LinkedIn Article readback did not bind one exact author");
  }
  const author = graphqlRecord(article.authors[0], "LinkedIn Article readback author");
  exactObjectKeys(author, ["profileUrn"], "LinkedIn Article readback author");
  if (author.profileUrn !== profileUrn) {
    throw new Error("LinkedIn Article readback author no longer matches the current member");
  }
  const title = boundedText(article.title, "LinkedIn Article readback title", 150);
  if (
    (article.contentHtml !== null && (typeof article.contentHtml !== "string" || article.contentHtml.length > 524_288))
    || !Array.isArray(article.content)
    || (!allowEmptyContent && article.content.length < 1)
    || article.content.length > 5_000
  ) throw new Error("LinkedIn Article readback content exceeded its reviewed bounds");
  nonnegativeInteger(article.createdAt, "LinkedIn Article readback createdAt");
  nonnegativeInteger(article.updatedAt, "LinkedIn Article readback updatedAt");
  nonnegativeInteger(article.version, "LinkedIn Article readback version");
  const imageAssetUrns: string[] = [];
  const blocks = metadataOnly || !normalizeDocument
    ? []
    : article.content.map((block, index) => {
        if (schemaVersion === 1) return normalizeLinkedInArticleBlock(block, index);
        const wrapper = graphqlRecord(block, `LinkedIn Article content[${index}]`);
        if (Object.hasOwn(wrapper, "imageBlock")) {
          const normalized = normalizeLinkedInArticleImageBlock(
            block,
            index,
            imageAssetUrns.length,
          );
          imageAssetUrns.push(normalized.assetUrn);
          return normalized.block;
        }
        return normalizeLinkedInArticleBlock(block, index);
      });
  if (
    schemaVersion === 2
    && blocks.length >= 2
    && blocks.at(-2)?.type === "image"
    && blocks.at(-1)?.type === "paragraph"
    && (blocks.at(-1) as ArticleDraftTextBlock).text === ""
    && (blocks.at(-1) as ArticleDraftTextBlock).links.length === 0
    && (blocks.at(-1) as ArticleDraftTextBlock).styles.length === 0
  ) blocks.pop();
  return Object.freeze({
    draftId,
    title,
    profileUrn,
    coverAssetUrn,
    document: metadataOnly || blocks.length === 0
      ? null
      : Object.freeze({ schemaVersion, blocks: Object.freeze(blocks) }) as LinkedInArticleNormalizedDocument,
    imageAssetUrns: Object.freeze(imageAssetUrns),
  });
}

export type LinkedInArticleDraftV2Metadata = Readonly<{
  draftId: string;
  title: string;
  profileUrn: string;
  coverAssetUrn: string | null;
}>;

/** Verify owner, private lifecycle, title, and cover without trusting stale body blocks. */
export function normalizeLinkedInArticleDraftV2Metadata(
  value: unknown,
  draftIdValue: unknown,
  profileUrnValue: unknown,
): LinkedInArticleDraftV2Metadata {
  const normalized = normalizeLinkedInArticleDraftValue(
    value,
    draftIdValue,
    profileUrnValue,
    true,
    2,
    true,
    false,
  );
  return Object.freeze({
    draftId: normalized.draftId,
    title: normalized.title,
    profileUrn: normalized.profileUrn,
    coverAssetUrn: normalized.coverAssetUrn,
  });
}

/** Normalize an owner-bound private draft before its first content autosave. */
export function normalizeLinkedInArticleDraftSnapshot(
  value: unknown,
  draftIdValue: unknown,
  profileUrnValue: unknown,
): LinkedInArticleDraftSnapshot {
  const normalized = normalizeLinkedInArticleDraftValue(
    value,
    draftIdValue,
    profileUrnValue,
    true,
  );
  if (normalized.document !== null && normalized.document.schemaVersion !== 1) {
    throw new Error("LinkedIn Article readback changed its text-only schema version");
  }
  return Object.freeze({
    draftId: normalized.draftId,
    title: normalized.title,
    profileUrn: normalized.profileUrn,
    document: normalized.document,
  });
}

/** Normalize only the exact owner/private/title binding before create verification or replacement. */
export function normalizeLinkedInArticleDraftMetadata(
  value: unknown,
  draftIdValue: unknown,
  profileUrnValue: unknown,
): Readonly<Omit<LinkedInArticleDraftReadback, "document">> {
  const normalized = normalizeLinkedInArticleDraftValue(
    value,
    draftIdValue,
    profileUrnValue,
    true,
    1,
    true,
  );
  return Object.freeze({
    draftId: normalized.draftId,
    profileUrn: normalized.profileUrn,
    title: normalized.title,
  });
}

/** Normalize one exact owner-bound, unpublished native Article readback. */
export function normalizeLinkedInArticleDraft(
  value: unknown,
  draftIdValue: unknown,
  profileUrnValue: unknown,
): LinkedInArticleDraftReadback {
  const normalized = normalizeLinkedInArticleDraftValue(
    value,
    draftIdValue,
    profileUrnValue,
    false,
  );
  if (
    normalized.document === null
    || normalized.document.schemaVersion !== 1
  ) {
    throw new Error("LinkedIn Article readback omitted its confirmed document");
  }
  return Object.freeze({
    draftId: normalized.draftId,
    profileUrn: normalized.profileUrn,
    title: normalized.title,
    document: normalized.document,
  });
}

/** Normalize one exact owner-bound image-capable private Article snapshot. */
export function normalizeLinkedInArticleDraftV2Snapshot(
  value: unknown,
  draftIdValue: unknown,
  profileUrnValue: unknown,
): LinkedInArticleDraftV2Snapshot {
  const normalized = normalizeLinkedInArticleDraftValue(
    value,
    draftIdValue,
    profileUrnValue,
    true,
    2,
  );
  if (normalized.document !== null && normalized.document.schemaVersion !== 2) {
    throw new Error("LinkedIn Article readback changed its image-capable schema version");
  }
  return Object.freeze({
    draftId: normalized.draftId,
    title: normalized.title,
    profileUrn: normalized.profileUrn,
    document: normalized.document,
    coverAssetUrn: normalized.coverAssetUrn,
    imageAssetUrns: normalized.imageAssetUrns,
  });
}

/** Normalize exact text/image order, alt text, captions, and provider assets. */
export function normalizeLinkedInArticleDraftV2(
  value: unknown,
  draftIdValue: unknown,
  profileUrnValue: unknown,
): LinkedInArticleDraftV2Readback {
  const normalized = normalizeLinkedInArticleDraftV2Snapshot(
    value,
    draftIdValue,
    profileUrnValue,
  );
  if (normalized.document === null) {
    throw new Error("LinkedIn Article readback omitted its confirmed document");
  }
  return Object.freeze({
    draftId: normalized.draftId,
    title: normalized.title,
    profileUrn: normalized.profileUrn,
    document: normalized.document,
    coverAssetUrn: normalized.coverAssetUrn,
    imageAssetUrns: normalized.imageAssetUrns,
  });
}

export function linkedInMessengerConversationsUrl(
  mailboxUrnValue: unknown,
  queryIdValue: unknown = LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID,
): URL {
  const mailboxUrn = boundedText(mailboxUrnValue, "LinkedIn mailbox URN", 512);
  if (!/^urn:li:fsd_profile:[A-Za-z0-9_-]{1,256}$/u.test(mailboxUrn)) {
    throw new Error("LinkedIn mailbox URN is invalid");
  }
  const queryId = resolveLinkedInRegisteredQueryId(
    LINKEDIN_MESSENGER_CONVERSATIONS_QUERY_PREFIX,
    [queryIdValue],
  );
  const url = new URL(LINKEDIN_MESSENGER_GRAPHQL_PATH, "https://www.linkedin.com");
  url.searchParams.set("queryId", queryId);
  url.searchParams.set("variables", `(mailboxUrn:${mailboxUrn})`);
  return url;
}

export type LinkedInPostVisibility = "public" | "connections";

export type LinkedInPostCreateInput = {
  readonly body: string;
  readonly visibility: LinkedInPostVisibility;
  readonly mediaUrn: string | null;
  readonly altText: string | null;
};

export type LinkedInPostProjection = {
  readonly entityUrn: string;
  readonly mediaUrn: string | null;
  readonly url: string;
};

export function linkedInPostText(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 3_000
    || /\0/u.test(value)
  ) throw new Error("LinkedIn post body must be 1-3000 characters without NUL");
  return value;
}

export function linkedInPostVisibility(value: unknown): LinkedInPostVisibility {
  if (value !== "public" && value !== "connections") {
    throw new Error("LinkedIn post visibility must be public or connections");
  }
  return value;
}

export function linkedInPostAltText(value: unknown, mediaPresent: boolean): string | null {
  if (value === undefined) return null;
  if (!mediaPresent) throw new Error("LinkedIn alt_text requires one reviewed image");
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_000
    || /\0/u.test(value)
  ) throw new Error("LinkedIn image alt_text must be 1-4000 characters without NUL");
  return value;
}

export function linkedInPostMediaUrn(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 512
    || !/^urn:li:(?:digitalmediaAsset|fsd_image):[A-Za-z0-9_(),.:%=-]{1,448}$/u.test(value)
  ) throw new Error("LinkedIn image upload returned an invalid media URN");
  return value;
}

export function linkedInPostEntityUrn(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 512
    || !/^urn:li:(?:fsd_share|share|ugcPost):[A-Za-z0-9_(),.:%=-]{1,448}$/u.test(value)
  ) throw new Error("LinkedIn post response returned an invalid entity URN");
  return value;
}

/** Exact first-party post-create variable projection observed in the current ShareCreateRequest bundle. */
export function buildLinkedInPostCreateVariables(
  input: LinkedInPostCreateInput,
): Readonly<Record<string, unknown>> {
  const body = linkedInPostText(input.body);
  const visibility = linkedInPostVisibility(input.visibility);
  const mediaUrn = input.mediaUrn === null ? null : linkedInPostMediaUrn(input.mediaUrn);
  const altText = linkedInPostAltText(input.altText ?? undefined, mediaUrn !== null);
  const post: Record<string, unknown> = {
    allowedCommentersScope: "ALL",
    commentary: {
      $type: "com.linkedin.voyager.dash.deco.common.text.TextViewModelV2",
      attributesV2: [],
      text: body,
    },
    intendedShareLifeCycleState: "PUBLISHED",
    origin: "FEED",
    paidEndorsement: false,
    visibilityDataUnion: {
      visibilityType: visibility === "public" ? "ANYONE" : "CONNECTIONS_ONLY",
    },
  };
  if (mediaUrn !== null) {
    post.media = {
      category: "IMAGE",
      mediaUrn,
      tapTargets: [],
      ...(altText === null ? {} : { altText }),
    };
  }
  return Object.freeze({ post: Object.freeze(post) });
}

/** Exact current registered GraphQL readback for one response-bound backend share URN. */
export function linkedInPostReadbackUrl(entityUrnValue: unknown): URL {
  const entityUrn = linkedInPostEntityUrn(entityUrnValue);
  const url = new URL(LINKEDIN_GRAPHQL_PATH, "https://www.linkedin.com");
  url.searchParams.set("includeWebMetadata", "true");
  url.searchParams.set("queryId", LINKEDIN_POST_READBACK_QUERY_ID);
  url.searchParams.set(
    "variables",
    `(moduleKey:feed-item:desktop,urnOrNss:${entityUrn})`,
  );
  return url;
}

/** Parse the minimal code-owned browser projection after create plus independent readback. */
export function normalizeLinkedInPostProjection(
  value: unknown,
  expected: {
    readonly body: string;
    readonly profileUrn: string;
    readonly mediaUrn: string | null;
  },
): LinkedInPostProjection {
  const projection = isRecord(value) ? value : null;
  if (projection === null) throw new Error("LinkedIn post browser returned an invalid projection");
  exactObjectKeys(
    projection,
    [
      "actorMatched",
      "entityMatched",
      "entityUrn",
      "lifecycle",
      "mediaMatched",
      "mediaUrn",
      "textMatched",
      "url",
    ],
    "LinkedIn post browser projection",
  );
  linkedInPostText(expected.body);
  if (!/^urn:li:fsd_profile:[A-Za-z0-9_-]{1,256}$/u.test(expected.profileUrn)) {
    throw new Error("LinkedIn post expected profile binding is invalid");
  }
  const entityUrn = linkedInPostEntityUrn(projection.entityUrn);
  const mediaUrn = projection.mediaUrn === null
    ? null
    : linkedInPostMediaUrn(projection.mediaUrn);
  if (
    projection.lifecycle !== "PUBLISHED"
    || projection.actorMatched !== true
    || projection.entityMatched !== true
    || projection.textMatched !== true
    || projection.mediaMatched !== (expected.mediaUrn !== null)
    || mediaUrn !== expected.mediaUrn
  ) throw new Error("LinkedIn independent post readback did not bind the confirmed post");
  if (typeof projection.url !== "string" || projection.url.length > 2_048) {
    throw new Error("LinkedIn post browser returned an invalid permalink");
  }
  const url = new URL(projection.url);
  if (
    url.origin !== "https://www.linkedin.com"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || !url.pathname.startsWith("/feed/update/")
  ) throw new Error("LinkedIn post browser returned an unreviewed permalink");
  return Object.freeze({ entityUrn, mediaUrn, url: url.href });
}

export function assertLinkedInMessengerConversationsRequest(
  requestValue: {
    readonly url: string | URL;
    readonly method: string;
  },
  expectedMailboxUrnValue: unknown,
): URL {
  const url = requestValue.url instanceof URL ? new URL(requestValue.url.href) : new URL(requestValue.url);
  if (
    requestValue.method !== "GET"
    || url.origin !== "https://www.linkedin.com"
    || url.pathname !== LINKEDIN_MESSENGER_GRAPHQL_PATH
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error("LinkedIn messenger-conversations request escaped its exact reviewed route");
  const queryNames = [...url.searchParams.keys()];
  if (
    queryNames.length !== 2
    || queryNames[0] !== "queryId"
    || queryNames[1] !== "variables"
    || url.searchParams.getAll("queryId").length !== 1
    || url.searchParams.getAll("variables").length !== 1
  ) throw new Error("LinkedIn messenger-conversations request query shape is invalid");
  const expected = linkedInMessengerConversationsUrl(
    expectedMailboxUrnValue,
    url.searchParams.get("queryId"),
  );
  if (url.searchParams.get("variables") !== expected.searchParams.get("variables")) {
    throw new Error("LinkedIn messenger-conversations request mailbox binding changed");
  }
  return url;
}

function exactStringList(value: unknown, label: string, maximumItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} must be a bounded string array`);
  }
  const result = value.map((item, index) => boundedText(item, `${label}[${index}]`, 4_096));
  return Object.freeze(result);
}

function displayNameFromPreview(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidates = new Set<string>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 5 || nodes >= 256 || !isRecord(item)) return;
    nodes += 1;
    const first = typeof item.firstName === "string" ? item.firstName.trim() : "";
    const last = typeof item.lastName === "string" ? item.lastName.trim() : "";
    const combined = `${first} ${last}`.trim();
    if (combined.length > 0 && combined.length <= 256 && !/[\0\r]/u.test(combined)) candidates.add(combined);
    for (const key of ["name", "displayName"] as const) {
      const candidate = item[key];
      if (
        typeof candidate === "string"
        && candidate.trim().length > 0
        && candidate.length <= 256
        && !/[\0\r]/u.test(candidate)
      ) candidates.add(candidate.trim());
    }
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  return candidates.size === 1 ? candidates.values().next().value ?? null : null;
}

function normalizedParticipant(
  entity: LinkedInWebJsonRecord,
): LinkedInMessagingParticipant {
  if (entity.$type !== "com.linkedin.messenger.MessagingParticipant") {
    throw new Error("LinkedIn messaging participant reference resolved to the wrong entity type");
  }
  return Object.freeze({
    urn: linkedInUrn(entity.entityUrn ?? entity.backendUrn, "LinkedIn messaging participant URN"),
    identityUrn: entity.hostIdentityUrn === null || entity.hostIdentityUrn === undefined
      ? null
      : linkedInUrn(entity.hostIdentityUrn, "LinkedIn messaging participant identity URN"),
    displayName: displayNameFromPreview(entity.preview),
  });
}

function messageBody(entity: LinkedInWebJsonRecord): string {
  if (typeof entity.body === "string") return boundedText(entity.body, "LinkedIn message body", 32_768);
  if (isRecord(entity.body) && typeof entity.body.text === "string") {
    return boundedText(entity.body.text, "LinkedIn message body.text", 32_768);
  }
  if (typeof entity.renderContentFallbackText === "string") {
    return boundedText(entity.renderContentFallbackText, "LinkedIn message fallback text", 32_768);
  }
  return "";
}

function normalizedMessage(
  entity: LinkedInWebJsonRecord,
): LinkedInMessagingConversation["latestMessage"] {
  if (entity.$type !== "com.linkedin.messenger.Message") {
    throw new Error("LinkedIn message reference resolved to the wrong entity type");
  }
  const urn = linkedInUrn(entity.entityUrn ?? entity.backendUrn, "LinkedIn message URN");
  return Object.freeze({
    id: linkedInUrn(entity.backendUrn ?? entity.entityUrn, "LinkedIn message backend URN"),
    urn,
    deliveredAt: nonnegativeInteger(entity.deliveredAt, "LinkedIn message deliveredAt"),
    body: messageBody(entity),
    subject: optionalText(entity.subject, "LinkedIn message subject", 8_192),
    senderUrn: entity["*sender"] === null || entity["*sender"] === undefined
      ? null
      : linkedInUrn(entity["*sender"], "LinkedIn message sender reference"),
  });
}

function exactConversationUrl(value: unknown): string {
  const raw = boundedText(value, "LinkedIn conversation URL", 4_096);
  const parsed = new URL(raw, "https://www.linkedin.com");
  if (
    parsed.origin !== "https://www.linkedin.com"
    || !parsed.pathname.startsWith("/messaging/")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
  ) throw new Error("LinkedIn conversation URL escaped the reviewed messaging surface");
  return parsed.href;
}

function normalizedConversation(
  entity: LinkedInWebJsonRecord,
  entitiesByUrn: ReadonlyMap<string, LinkedInWebJsonRecord>,
): LinkedInMessagingConversation {
  if (entity.$type !== "com.linkedin.messenger.Conversation") {
    throw new Error("LinkedIn conversation reference resolved to the wrong entity type");
  }
  const participantReferences = exactStringList(
    entity["*conversationParticipants"],
    "LinkedIn conversation participant references",
    100,
  );
  const participants: LinkedInMessagingParticipant[] = [];
  for (const reference of participantReferences) {
    const participant = entitiesByUrn.get(reference);
    if (participant !== undefined) participants.push(normalizedParticipant(participant));
  }
  const messages = graphqlRecord(entity.messages, "conversation messages");
  const messageReferences = exactStringList(messages["*elements"], "LinkedIn conversation message references", 100);
  const latestReference = messageReferences[0];
  const latestEntity = latestReference === undefined ? undefined : entitiesByUrn.get(latestReference);
  const latestMessage = latestEntity === undefined ? null : normalizedMessage(latestEntity);
  const categories = exactStringList(entity.categories, "LinkedIn conversation categories", 32);
  for (const category of categories) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(category)) {
      throw new Error("LinkedIn conversation category is invalid");
    }
  }
  if (typeof entity.groupChat !== "boolean" || typeof entity.read !== "boolean") {
    throw new Error("LinkedIn conversation state flags are invalid");
  }
  return Object.freeze({
    id: linkedInUrn(entity.backendUrn ?? entity.entityUrn, "LinkedIn conversation backend URN"),
    urn: linkedInUrn(entity.entityUrn ?? entity.backendUrn, "LinkedIn conversation URN"),
    categories,
    groupChat: entity.groupChat,
    title: optionalText(entity.title, "LinkedIn conversation title", 8_192),
    createdAt: nonnegativeInteger(entity.createdAt, "LinkedIn conversation createdAt"),
    lastActivityAt: nonnegativeInteger(entity.lastActivityAt, "LinkedIn conversation lastActivityAt"),
    lastReadAt: optionalNonnegativeInteger(entity.lastReadAt, "LinkedIn conversation lastReadAt"),
    read: entity.read,
    unreadCount: nonnegativeInteger(entity.unreadCount, "LinkedIn conversation unreadCount"),
    notificationStatus: boundedText(
      entity.notificationStatus,
      "LinkedIn conversation notificationStatus",
      64,
    ),
    participants: Object.freeze(participants),
    latestMessage,
    url: exactConversationUrl(entity.conversationUrl),
  });
}

function folderIncludesConversation(folder: LinkedInWebFolder, categories: readonly string[]): boolean {
  if (folder === "all") return true;
  return categories.includes(LINKEDIN_WEB_FOLDER_CATEGORIES[folder]);
}

export function normalizeLinkedInMessagingList(
  value: unknown,
  folderValue: unknown,
  limitValue: unknown,
): LinkedInMessagingList {
  if (
    typeof folderValue !== "string"
    || !hasOwn(LINKEDIN_WEB_FOLDER_CATEGORIES, folderValue)
  ) throw new Error("LinkedIn folder must be focused, other, requests, archive, spam, or all");
  const folder = folderValue as LinkedInWebFolder;
  if (!Number.isSafeInteger(limitValue) || (limitValue as number) < 1 || (limitValue as number) > MAX_MESSAGING_ITEMS) {
    throw new Error("LinkedIn messaging limit must be an integer between 1 and 100");
  }
  const limit = limitValue as number;
  const normalized = normalizeLinkedInGraphqlEnvelope(value);
  const outerData = graphqlRecord(normalized.data.data, "messenger-conversations data");
  const collection = graphqlRecord(
    outerData.messengerConversationsBySyncToken,
    "messenger-conversations collection",
  );
  if (collection.$type !== "com.linkedin.restli.common.CollectionResponse") {
    throw new Error("LinkedIn messenger-conversations collection type changed");
  }
  const references = exactStringList(
    collection["*elements"],
    "LinkedIn messenger-conversations references",
    MAX_MESSAGING_ITEMS,
  );
  const conversations: LinkedInMessagingConversation[] = [];
  let matchingConversations = 0;
  for (const reference of references) {
    const entity = normalized.entitiesByUrn.get(reference);
    if (entity === undefined) {
      throw new Error("LinkedIn messenger-conversations response omitted a referenced conversation");
    }
    const conversation = normalizedConversation(entity, normalized.entitiesByUrn);
    if (folderIncludesConversation(folder, conversation.categories)) {
      matchingConversations += 1;
      if (conversations.length < limit) conversations.push(conversation);
    }
  }
  const metadata = graphqlRecord(collection.metadata, "messenger-conversations metadata");
  const nextCursor = optionalText(metadata.newSyncToken, "LinkedIn messenger-conversations sync token", 4_096);
  return Object.freeze({
    folder,
    conversations: Object.freeze(conversations),
    nextCursor,
    continuationSupported: false,
    complete: nextCursor === null && matchingConversations <= limit,
  });
}

function operationContract(value: unknown): LinkedInWebOperationContract {
  if (typeof value !== "string" || !hasOwn(LINKEDIN_WEB_OPERATIONS, value)) {
    throw new Error("LinkedIn web operation is unknown");
  }
  return LINKEDIN_WEB_OPERATIONS[value as LinkedInWebOperationName];
}

export function assertLinkedInWebR1RequestAllowed(
  operationValue: unknown,
  requestValue: unknown,
): void {
  const contract = operationContract(operationValue);
  if (contract.risk !== "R1" || contract.effect !== "read") {
    throw new Error("LinkedIn web operation is not an R1 read");
  }
  if (contract.state !== "observed" || contract.requests.length === 0) {
    throw new Error("LinkedIn R1 operation has no captured request contract");
  }
  if (operationValue === "messaging.list") {
    if (!isRecord(requestValue)) throw new Error("LinkedIn messaging-list request must be an object");
    assertLinkedInMessengerConversationsRequest({
      url: requestValue.url instanceof URL || typeof requestValue.url === "string"
        ? requestValue.url
        : (() => { throw new Error("LinkedIn messaging-list request URL is invalid"); })(),
      method: boundedText(requestValue.method, "LinkedIn messaging-list request method", 16),
    }, requestValue.mailboxUrn);
    return;
  }
  throw new Error("LinkedIn R1 operation has no captured request contract");
}
