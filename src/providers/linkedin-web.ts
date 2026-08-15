const MAX_CSRF_TOKEN_CHARACTERS = 1_024;
const MAX_QUERY_CANDIDATES = 4_096;
const MAX_QUERY_CANDIDATE_CHARACTERS = 512;
const MAX_MESSAGING_ITEMS = 100;

export const LINKEDIN_MESSENGER_CONVERSATIONS_QUERY_PREFIX = "messengerConversations";
export const LINKEDIN_MESSENGER_CONVERSATIONS_OBSERVED_QUERY_ID =
  "messengerConversations.0d5e6781bbee71c3e51c8843c6519f48";
export const LINKEDIN_MESSENGER_GRAPHQL_PATH = "/voyager/api/voyagerMessagingGraphQL/graphql";

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

export type LinkedInWebOperationContract = {
  readonly effect: "read" | "write";
  readonly risk: LinkedInWebRisk;
  readonly state: LinkedInWebContractState;
  readonly evidence: LinkedInWebEvidence;
  readonly requests: readonly LinkedInWebReadRequestRule[];
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
    state: "capture-required",
    evidence: "none",
    requests: [],
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
    state: "capture-required",
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
