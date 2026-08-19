import blueskyWebManifest from "./assets/adapters/bluesky/wrench-web-adapter.json";
import facebookGroupWebManifest from "./assets/adapters/facebook-group/wrench-web-adapter.json";
import facebookMarketplaceWebManifest from "./assets/adapters/facebook-marketplace/wrench-web-adapter.json";
import facebookPageWebManifest from "./assets/adapters/facebook-page/wrench-web-adapter.json";
import facebookWebManifest from "./assets/adapters/facebook/wrench-web-adapter.json";
import hackerNewsWebManifest from "./assets/adapters/hacker-news/wrench-web-adapter.json";
import instagramWebManifest from "./assets/adapters/instagram/wrench-web-adapter.json";
import linkedinWebManifest from "./assets/adapters/linkedin/wrench-web-adapter.json";
import redditWebManifest from "./assets/adapters/reddit/wrench-web-adapter.json";
import substackWebManifest from "./assets/adapters/substack/wrench-web-adapter.json";
import tiktokWebManifest from "./assets/adapters/tiktok/wrench-web-adapter.json";
import threadsWebManifest from "./assets/adapters/threads/wrench-web-adapter.json";
import xWebManifest from "./assets/adapters/x/wrench-web-adapter.json";
import youtubeWebManifest from "./assets/adapters/youtube/wrench-web-adapter.json";
import whatsappWebManifest from "./assets/adapters/whatsapp/wrench-web-adapter.json";
import {
  type IdempotencyKind,
  type InputField,
  type InputSchema,
  type OperationRisk,
  type WebSessionSiteId,
} from "./model";
import type { SemanticOperationName } from "./platform-catalog";
import type { ProviderPluginOperationName } from "./provider-plugin-identifiers";

export type WebSessionContractState = "observed" | "capture-required";

export type WebSessionContract = {
  readonly site: WebSessionSiteId;
  readonly operation: ProviderPluginOperationName;
  readonly contractVersion: number;
  readonly risk: OperationRisk;
  /** Exact code-owned schema; an installed manifest cannot widen or rename inputs. */
  readonly input: InputSchema;
  /** Exact confirmation copy and replay policy bound into invocation plans. */
  readonly sideEffect: string;
  readonly idempotency: IdempotencyKind;
  readonly dedupeWindowMs: number;
  readonly state: WebSessionContractState;
  readonly dispatch: "none" | "single" | "thread-items" | "bounded-items";
  readonly implementation: string;
};

const bundledManifests: Readonly<Partial<Record<WebSessionSiteId, unknown>>> = {
  bluesky: blueskyWebManifest,
  facebook: facebookWebManifest,
  "facebook-group": facebookGroupWebManifest,
  "facebook-marketplace": facebookMarketplaceWebManifest,
  "facebook-page": facebookPageWebManifest,
  "hacker-news": hackerNewsWebManifest,
  instagram: instagramWebManifest,
  linkedin: linkedinWebManifest,
  reddit: redditWebManifest,
  substack: substackWebManifest,
  tiktok: tiktokWebManifest,
  threads: threadsWebManifest,
  x: xWebManifest,
  youtube: youtubeWebManifest,
  whatsapp: whatsappWebManifest,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function requireExactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) throw new Error(`${path} contains unsupported keys: ${unexpected.join(", ")}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length < 1) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function optionalSafeNumber(
  value: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): number | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
    throw new Error(`${path}.${key} must be a safe integer`);
  }
  return candidate;
}

function optionalStringList(
  value: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): readonly string[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!isUnknownArray(candidate)) {
    throw new Error(`${path}.${key} must be a string array`);
  }
  const result: string[] = [];
  for (const item of candidate) {
    if (typeof item !== "string") throw new Error(`${path}.${key} must be a string array`);
    result.push(item);
  }
  return Object.freeze(result);
}

function parseOwnedInputField(value: unknown, path: string): InputField {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const type = value.type;
  const description = requiredString(value.description, `${path}.description`);
  if (type === "file") {
    requireExactKeys(value, ["type", "description", "maxBytes", "mediaTypes"], path);
    const maxBytes = optionalSafeNumber(value, "maxBytes", path);
    if (maxBytes === undefined || maxBytes < 1) throw new Error(`${path}.maxBytes must be a positive safe integer`);
    const mediaTypes = optionalStringList(value, "mediaTypes", path);
    return Object.freeze({
      type: "file",
      description,
      maxBytes,
      ...(mediaTypes === undefined ? {} : { mediaTypes }),
    });
  }
  if (type === "array") {
    requireExactKeys(value, ["type", "description", "items", "minItems", "maxItems"], path);
    const minItems = optionalSafeNumber(value, "minItems", path);
    const maxItems = optionalSafeNumber(value, "maxItems", path);
    if (minItems === undefined || maxItems === undefined || minItems < 0 || maxItems < minItems) {
      throw new Error(`${path} must declare a valid minItems/maxItems range`);
    }
    const items = parseOwnedInputField(value.items, `${path}.items`);
    if (items.type === "array") throw new Error(`${path}.items cannot be a nested array`);
    return Object.freeze({ type: "array", description, items, minItems, maxItems });
  }
  if (type !== "string" && type !== "boolean" && type !== "number") {
    throw new Error(`${path}.type must be string, boolean, number, file, or array`);
  }
  requireExactKeys(
    value,
    ["type", "description", "minLength", "maxLength", "minimum", "maximum", "enum", "format", "urlPathPrefixes"],
    path,
  );
  const minLength = optionalSafeNumber(value, "minLength", path);
  const maxLength = optionalSafeNumber(value, "maxLength", path);
  const minimum = optionalSafeNumber(value, "minimum", path);
  const maximum = optionalSafeNumber(value, "maximum", path);
  const rawEnum = value.enum;
  let enumValues: readonly (string | number | boolean)[] | undefined;
  if (rawEnum !== undefined) {
    if (!isUnknownArray(rawEnum) || rawEnum.length < 1) {
      throw new Error(`${path}.enum must be a non-empty scalar array`);
    }
    const values: (string | number | boolean)[] = [];
    for (const item of rawEnum) {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
        throw new Error(`${path}.enum must be a non-empty scalar array`);
      }
      values.push(item);
    }
    enumValues = Object.freeze(values);
  }
  const format = value.format;
  if (format !== undefined && format !== "url" && format !== "path-segment") {
    throw new Error(`${path}.format must be url or path-segment`);
  }
  const urlPathPrefixes = optionalStringList(value, "urlPathPrefixes", path);
  return Object.freeze({
    type,
    description,
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(enumValues === undefined ? {} : { enum: enumValues }),
    ...(format === undefined ? {} : { format }),
    ...(urlPathPrefixes === undefined ? {} : { urlPathPrefixes }),
  });
}

function parseOwnedInputSchema(value: unknown, path: string): InputSchema {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  requireExactKeys(value, ["properties", "required"], path);
  if (!isRecord(value.properties)) throw new Error(`${path}.properties must be an object`);
  const requiredValue = value.required;
  if (!isUnknownArray(requiredValue)) {
    throw new Error(`${path}.required must be a string array`);
  }
  const required: string[] = [];
  for (const item of requiredValue) {
    if (typeof item !== "string") throw new Error(`${path}.required must be a string array`);
    required.push(item);
  }
  const properties: Record<string, InputField> = {};
  for (const [name, field] of Object.entries(value.properties)) {
    properties[name] = parseOwnedInputField(field, `${path}.properties.${name}`);
  }
  for (const name of required) {
    if (!(name in properties)) throw new Error(`${path}.required references undeclared property ${name}`);
  }
  return Object.freeze({
    properties: Object.freeze(properties),
    required: Object.freeze(required),
  });
}

function manifestOperationSemantics(
  manifest: unknown,
  site: WebSessionSiteId,
  operation: SemanticOperationName,
  expectedRisk: OperationRisk,
): Pick<WebSessionContract, "input" | "sideEffect" | "idempotency" | "dedupeWindowMs"> {
  if (!isRecord(manifest) || !isRecord(manifest.operations)) {
    throw new Error(`bundled authenticated web manifest ${site} is malformed`);
  }
  const definition = manifest.operations[operation];
  if (!isRecord(definition)) throw new Error(`bundled authenticated web operation ${site}/${operation} is missing`);
  if (definition.risk !== expectedRisk) {
    throw new Error(`bundled authenticated web operation ${site}/${operation} has unexpected risk`);
  }
  const sideEffect = requiredString(definition.sideEffect, `${site}/${operation}.sideEffect`);
  const idempotency = definition.idempotency;
  if (idempotency !== "none" && idempotency !== "local-at-most-once") {
    throw new Error(`bundled authenticated web operation ${site}/${operation}.idempotency is invalid`);
  }
  const dedupeWindowMs = definition.dedupeWindowMs;
  if (typeof dedupeWindowMs !== "number" || !Number.isSafeInteger(dedupeWindowMs) || dedupeWindowMs < 0) {
    throw new Error(`bundled authenticated web operation ${site}/${operation}.dedupeWindowMs is invalid`);
  }
  return Object.freeze({
    input: parseOwnedInputSchema(definition.input, `${site}/${operation}.input`),
    sideEffect,
    idempotency,
    dedupeWindowMs,
  });
}

function bundledOperationSemantics(
  site: WebSessionSiteId,
  operation: SemanticOperationName,
  expectedRisk: OperationRisk,
): Pick<WebSessionContract, "input" | "sideEffect" | "idempotency" | "dedupeWindowMs"> {
  return manifestOperationSemantics(
    bundledManifests[site],
    site,
    operation,
    expectedRisk,
  );
}

/**
 * Rehydrate one exact immutable bundled adapter contract for durable recovery.
 * The returned route keeps its historical schema and confirmation text; it is
 * never an alias to a semantically different active contract.
 */
export function reviewedArchivedWebSessionContract(
  manifestValue: unknown,
  expected: {
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly site: WebSessionSiteId;
    readonly operation: SemanticOperationName;
    readonly contractVersion: number;
    readonly risk: OperationRisk;
    readonly state: WebSessionContractState;
    readonly implementation: string;
  },
): WebSessionContract {
  if (!isRecord(manifestValue)) {
    throw new Error(`archived authenticated web manifest ${expected.adapterId} is malformed`);
  }
  if (
    manifestValue.schemaVersion !== 4
    || manifestValue.id !== expected.adapterId
    || manifestValue.version !== expected.adapterVersion
    || !isRecord(manifestValue.operations)
  ) throw new Error(`archived authenticated web manifest ${expected.adapterId}@${expected.adapterVersion} changed identity`);
  const definition = manifestValue.operations[expected.operation];
  if (!isRecord(definition) || !isRecord(definition.webSession)) {
    throw new Error(`archived authenticated web operation ${expected.site}/${expected.operation} is missing`);
  }
  if (
    definition.webSession.site !== expected.site
    || definition.webSession.action !== expected.operation
    || definition.webSession.contractVersion !== expected.contractVersion
  ) throw new Error(`archived authenticated web operation ${expected.site}/${expected.operation} changed route identity`);
  return Object.freeze({
    site: expected.site,
    operation: expected.operation,
    contractVersion: expected.contractVersion,
    risk: expected.risk,
    ...manifestOperationSemantics(
      manifestValue,
      expected.site,
      expected.operation,
      expected.risk,
    ),
    state: expected.state,
    dispatch: expected.risk === "R1"
      ? "none"
      : expected.operation === "articles.draft.save"
        ? "bounded-items"
        : expected.operation === "threads.publish"
          ? "thread-items"
          : "single",
    implementation: expected.implementation,
  });
}

type WebOperationPolicy = {
  readonly risk: OperationRisk;
  readonly state: WebSessionContractState;
  readonly reason: string;
  readonly contractVersion: number;
};

function operationPolicies(
  site: WebSessionSiteId,
  observedOperations: readonly SemanticOperationName[],
  versionOverrides: Readonly<Partial<Record<SemanticOperationName, number>>> = {},
): Readonly<Record<SemanticOperationName, WebOperationPolicy>> {
  const manifest = bundledManifests[site];
  if (!isRecord(manifest) || !isRecord(manifest.operations)) {
    throw new Error(`bundled authenticated web manifest ${site} is malformed`);
  }
  const observed = new Set<SemanticOperationName>(observedOperations);
  const policies: Partial<Record<SemanticOperationName, WebOperationPolicy>> = {};
  for (const [operationValue, definition] of Object.entries(manifest.operations)) {
    if (!isRecord(definition)) {
      throw new Error(`bundled authenticated web operation ${site}/${operationValue} is malformed`);
    }
    const risk = definition.risk;
    if (risk !== "R1" && risk !== "R2" && risk !== "R3" && risk !== "R4") {
      throw new Error(`bundled authenticated web operation ${site}/${operationValue} has invalid risk`);
    }
    const operation = operationValue as SemanticOperationName;
    const state = observed.has(operation) ? "observed" : "capture-required";
    policies[operation] = Object.freeze({
      risk,
      state,
      reason: state === "observed"
        ? `reviewed ${site} ${operation} authenticated first-party contract`
        : `${site} ${operation} requires a fresh reviewed authenticated first-party contract before execution`,
      contractVersion: versionOverrides[operation] ?? 1,
    });
  }
  return Object.freeze(policies) as Readonly<
    Record<SemanticOperationName, WebOperationPolicy>
  >;
}

const BLUESKY_WEB_OPERATIONS = operationPolicies("bluesky", [
  "comments.read",
  "feeds.read",
  "media.read",
  "posts.publish",
  "posts.read",
], {
  "posts.publish": 2,
});
const LINKEDIN_WEB_OPERATIONS = operationPolicies("linkedin", [
  "articles.draft.save",
  "posts.publish",
], {
  "articles.draft.save": 6,
  "posts.publish": 3,
});
const HACKER_NEWS_WEB_OPERATIONS = operationPolicies("hacker-news", [
  "comments.read",
  "feeds.read",
  "posts.read",
]);
const REDDIT_WEB_OPERATIONS = operationPolicies("reddit", [
  "comments.read",
  "feeds.read",
  "messaging.list",
  "messaging.read",
  "posts.read",
]);
const SUBSTACK_WEB_OPERATIONS = operationPolicies("substack", [
  "articles.read",
  "comments.read",
  "feeds.read",
  "media.read",
  "messaging.list",
  "posts.publish",
  "posts.read",
], {
  "posts.publish": 2,
});
const TIKTOK_WEB_OPERATIONS = operationPolicies("tiktok", [
  "comments.read",
  "feeds.read",
]);
const WHATSAPP_WEB_OPERATIONS = operationPolicies("whatsapp", [
  "contacts.list",
  "media.read",
  "messaging.list",
  "messaging.read",
]);

type MetaWebSite =
  | "instagram"
  | "threads"
  | "facebook"
  | "facebook-page"
  | "facebook-group"
  | "facebook-marketplace";

const META_WEB_OPERATIONS = Object.freeze({
  instagram: operationPolicies("instagram", [
    "comments.read",
    "contacts.list",
    "feeds.read",
    "media.read",
    "messaging.list",
    "posts.read",
  ], {
    "comments.read": 2,
    "feeds.read": 2,
    "messaging.list": 2,
  }),
  threads: operationPolicies("threads", ["feeds.read", "posts.publish"], {
    "feeds.read": 2,
    "posts.publish": 2,
  }),
  facebook: operationPolicies("facebook", ["feeds.read"], {
    "feeds.read": 2,
    "messaging.list": 2,
  }),
  "facebook-page": operationPolicies("facebook-page", []),
  "facebook-group": operationPolicies("facebook-group", ["feeds.read"], {
    "feeds.read": 2,
  }),
  "facebook-marketplace": operationPolicies(
    "facebook-marketplace",
    ["feeds.read", "listings.read"],
    {
      "feeds.read": 2,
      "listings.read": 2,
    },
  ),
});

const contract = (
  site: WebSessionSiteId,
  operation: SemanticOperationName,
  risk: OperationRisk,
  state: WebSessionContractState,
  implementation: string,
  contractVersion = 1,
): WebSessionContract => Object.freeze({
  site,
  operation,
  contractVersion,
  risk,
  ...bundledOperationSemantics(site, operation, risk),
  state,
  dispatch: risk === "R1"
    ? "none"
    : operation === "articles.draft.save"
      ? "bounded-items"
      : operation === "threads.publish" ? "thread-items" : "single",
  implementation,
});

function metaRegistry(
  site: MetaWebSite,
): Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>> {
  const registry: Partial<Record<SemanticOperationName, WebSessionContract>> = {};
  for (const [operationValue, selected] of Object.entries(META_WEB_OPERATIONS[site])) {
    const operation = operationValue as SemanticOperationName;
    if (selected === undefined) {
      throw new Error(`Meta authenticated web contract ${site}/${operation} is missing`);
    }
    registry[operation] = contract(
      site,
      operation,
      selected.risk,
      selected.state,
      selected.reason,
      selected.contractVersion,
    );
  }
  return Object.freeze(registry);
}

const instagram = metaRegistry("instagram");
const threads = metaRegistry("threads");
const facebook = metaRegistry("facebook");
const facebookPage = metaRegistry("facebook-page");
const facebookGroup = metaRegistry("facebook-group");
const facebookMarketplace = metaRegistry("facebook-marketplace");

const bluesky = {
  "comments.read": contract("bluesky", "comments.read", BLUESKY_WEB_OPERATIONS["comments.read"].risk, BLUESKY_WEB_OPERATIONS["comments.read"].state, BLUESKY_WEB_OPERATIONS["comments.read"].reason),
  "content.save": contract("bluesky", "content.save", BLUESKY_WEB_OPERATIONS["content.save"].risk, BLUESKY_WEB_OPERATIONS["content.save"].state, BLUESKY_WEB_OPERATIONS["content.save"].reason),
  "content.share": contract("bluesky", "content.share", BLUESKY_WEB_OPERATIONS["content.share"].risk, BLUESKY_WEB_OPERATIONS["content.share"].state, BLUESKY_WEB_OPERATIONS["content.share"].reason),
  "feeds.read": contract("bluesky", "feeds.read", BLUESKY_WEB_OPERATIONS["feeds.read"].risk, BLUESKY_WEB_OPERATIONS["feeds.read"].state, BLUESKY_WEB_OPERATIONS["feeds.read"].reason),
  "likes.set": contract("bluesky", "likes.set", BLUESKY_WEB_OPERATIONS["likes.set"].risk, BLUESKY_WEB_OPERATIONS["likes.set"].state, BLUESKY_WEB_OPERATIONS["likes.set"].reason),
  "media.read": contract("bluesky", "media.read", BLUESKY_WEB_OPERATIONS["media.read"].risk, BLUESKY_WEB_OPERATIONS["media.read"].state, BLUESKY_WEB_OPERATIONS["media.read"].reason),
  "messaging.list": contract("bluesky", "messaging.list", BLUESKY_WEB_OPERATIONS["messaging.list"].risk, BLUESKY_WEB_OPERATIONS["messaging.list"].state, BLUESKY_WEB_OPERATIONS["messaging.list"].reason),
  "messaging.read": contract("bluesky", "messaging.read", BLUESKY_WEB_OPERATIONS["messaging.read"].risk, BLUESKY_WEB_OPERATIONS["messaging.read"].state, BLUESKY_WEB_OPERATIONS["messaging.read"].reason),
  "messaging.send": contract("bluesky", "messaging.send", BLUESKY_WEB_OPERATIONS["messaging.send"].risk, BLUESKY_WEB_OPERATIONS["messaging.send"].state, BLUESKY_WEB_OPERATIONS["messaging.send"].reason),
  "posts.publish": contract("bluesky", "posts.publish", BLUESKY_WEB_OPERATIONS["posts.publish"].risk, BLUESKY_WEB_OPERATIONS["posts.publish"].state, BLUESKY_WEB_OPERATIONS["posts.publish"].reason, BLUESKY_WEB_OPERATIONS["posts.publish"].contractVersion),
  "posts.quote": contract("bluesky", "posts.quote", BLUESKY_WEB_OPERATIONS["posts.quote"].risk, BLUESKY_WEB_OPERATIONS["posts.quote"].state, BLUESKY_WEB_OPERATIONS["posts.quote"].reason),
  "posts.read": contract("bluesky", "posts.read", BLUESKY_WEB_OPERATIONS["posts.read"].risk, BLUESKY_WEB_OPERATIONS["posts.read"].state, BLUESKY_WEB_OPERATIONS["posts.read"].reason),
  "posts.repost": contract("bluesky", "posts.repost", BLUESKY_WEB_OPERATIONS["posts.repost"].risk, BLUESKY_WEB_OPERATIONS["posts.repost"].state, BLUESKY_WEB_OPERATIONS["posts.repost"].reason),
  "relationships.follow.set": contract("bluesky", "relationships.follow.set", BLUESKY_WEB_OPERATIONS["relationships.follow.set"].risk, BLUESKY_WEB_OPERATIONS["relationships.follow.set"].state, BLUESKY_WEB_OPERATIONS["relationships.follow.set"].reason),
  "replies.create": contract("bluesky", "replies.create", BLUESKY_WEB_OPERATIONS["replies.create"].risk, BLUESKY_WEB_OPERATIONS["replies.create"].state, BLUESKY_WEB_OPERATIONS["replies.create"].reason),
  "threads.publish": contract("bluesky", "threads.publish", BLUESKY_WEB_OPERATIONS["threads.publish"].risk, BLUESKY_WEB_OPERATIONS["threads.publish"].state, BLUESKY_WEB_OPERATIONS["threads.publish"].reason),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

const linkedin = {
  "contacts.list": contract("linkedin", "contacts.list", "R1", "capture-required", "consumer-web contact statistics require a fresh viewer-bound messaging-participant collection with real conversation and message pagination, group attribution, completeness, and acknowledgement-free behavior"),
  "feeds.read": contract("linkedin", "feeds.read", "R1", "capture-required", "the registered feed query revision is known, but its exact current value-level variables need a fresh reviewed capture"),
  "profiles.read": contract("linkedin", "profiles.read", "R1", "capture-required", "exact public-identifier or profile-URN lookup and bounded member projection require a reviewed capture"),
  "organizations.read": contract("linkedin", "organizations.read", "R1", "capture-required", "exact organization identifier lookup and bounded page projection require a reviewed capture"),
  "relationships.recommendations.read": contract("linkedin", "relationships.recommendations.read", "R1", "capture-required", "recommended-connection collection variables, paging, and viewer binding require a reviewed capture"),
  "messaging.list": contract("linkedin", "messaging.list", "R1", "capture-required", "the prior mailbox projection drifted; exact current normalized identity-to-mailbox binding, registered query, paging, completeness, and acknowledgement-free behavior require a new reviewed capture"),
  "messaging.read": contract("linkedin", "messaging.read", "R1", "capture-required", "message query revision is known, but exact current variables and acknowledgement-free response handling need a fresh reviewed capture"),
  "articles.read": contract("linkedin", "articles.read", "R1", "capture-required", "exact response author, authenticated identity, and paging bindings require a fresh reviewed capture"),
  "articles.draft.save": contract(
    "linkedin",
    "articles.draft.save",
    LINKEDIN_WEB_OPERATIONS["articles.draft.save"].risk,
    LINKEDIN_WEB_OPERATIONS["articles.draft.save"].state,
    "reviewed current-member-bound native Article title/content autosave plus distinct bounded cover and inline-image single-upload registrations, signed transfers, asset-URN projections, and exact unpublished server-response readback",
    LINKEDIN_WEB_OPERATIONS["articles.draft.save"].contractVersion,
  ),
  "posts.read": contract("linkedin", "posts.read", "R1", "capture-required", "exact consumer-web post read requires a reviewed capture"),
  "comments.read": contract("linkedin", "comments.read", "R1", "capture-required", "exact comment collection requires a reviewed capture"),
  "messaging.send": contract("linkedin", "messaging.send", "R3", "capture-required", "createMessage mutation requires a reviewed capture and response binding"),
  "posts.publish": contract(
    "linkedin",
    "posts.publish",
    LINKEDIN_WEB_OPERATIONS["posts.publish"].risk,
    LINKEDIN_WEB_OPERATIONS["posts.publish"].state,
    "reviewed member-bound IMAGE_SHARING registration/upload, registered post-create mutation, and independent exact-share readback",
    LINKEDIN_WEB_OPERATIONS["posts.publish"].contractVersion,
  ),
  "posts.repost": contract("linkedin", "posts.repost", "R3", "capture-required", "repost requires an exact reviewed mutation"),
  "posts.quote": contract("linkedin", "posts.quote", "R3", "capture-required", "quote repost requires an exact reviewed mutation"),
  "comments.create": contract("linkedin", "comments.create", "R3", "capture-required", "createComment requires exact actor/root/parent response binding"),
  "replies.create": contract("linkedin", "replies.create", "R3", "capture-required", "reply creation requires exact actor/root/parent response binding"),
  "reactions.set": contract("linkedin", "reactions.set", "R2", "capture-required", "desired-state reaction requires reviewed create/delete contracts"),
  "relationships.connect": contract("linkedin", "relationships.connect", "R3", "capture-required", "connection invitation requires exact viewer, target, optional note, response, and duplicate-state bindings"),
  "articles.publish": contract("linkedin", "articles.publish", "R3", "capture-required", "native Article publication remains a distinct unobserved operation"),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

const hackerNews = {
  "comments.create": contract("hacker-news", "comments.create", HACKER_NEWS_WEB_OPERATIONS["comments.create"].risk, HACKER_NEWS_WEB_OPERATIONS["comments.create"].state, HACKER_NEWS_WEB_OPERATIONS["comments.create"].reason),
  "comments.read": contract("hacker-news", "comments.read", HACKER_NEWS_WEB_OPERATIONS["comments.read"].risk, HACKER_NEWS_WEB_OPERATIONS["comments.read"].state, HACKER_NEWS_WEB_OPERATIONS["comments.read"].reason),
  "content.edit": contract("hacker-news", "content.edit", HACKER_NEWS_WEB_OPERATIONS["content.edit"].risk, HACKER_NEWS_WEB_OPERATIONS["content.edit"].state, HACKER_NEWS_WEB_OPERATIONS["content.edit"].reason),
  "content.save": contract("hacker-news", "content.save", HACKER_NEWS_WEB_OPERATIONS["content.save"].risk, HACKER_NEWS_WEB_OPERATIONS["content.save"].state, HACKER_NEWS_WEB_OPERATIONS["content.save"].reason),
  "feeds.read": contract("hacker-news", "feeds.read", HACKER_NEWS_WEB_OPERATIONS["feeds.read"].risk, HACKER_NEWS_WEB_OPERATIONS["feeds.read"].state, HACKER_NEWS_WEB_OPERATIONS["feeds.read"].reason),
  "posts.publish": contract("hacker-news", "posts.publish", HACKER_NEWS_WEB_OPERATIONS["posts.publish"].risk, HACKER_NEWS_WEB_OPERATIONS["posts.publish"].state, HACKER_NEWS_WEB_OPERATIONS["posts.publish"].reason),
  "posts.read": contract("hacker-news", "posts.read", HACKER_NEWS_WEB_OPERATIONS["posts.read"].risk, HACKER_NEWS_WEB_OPERATIONS["posts.read"].state, HACKER_NEWS_WEB_OPERATIONS["posts.read"].reason),
  "reactions.set": contract("hacker-news", "reactions.set", HACKER_NEWS_WEB_OPERATIONS["reactions.set"].risk, HACKER_NEWS_WEB_OPERATIONS["reactions.set"].state, HACKER_NEWS_WEB_OPERATIONS["reactions.set"].reason),
  "replies.create": contract("hacker-news", "replies.create", HACKER_NEWS_WEB_OPERATIONS["replies.create"].risk, HACKER_NEWS_WEB_OPERATIONS["replies.create"].state, HACKER_NEWS_WEB_OPERATIONS["replies.create"].reason),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

const x = {
  "feeds.read": contract("x", "feeds.read", "R1", "observed", "current first-party GraphQL timeline/list/search/bookmark query"),
  "posts.read": contract("x", "posts.read", "R1", "observed", "current TweetDetail/UserTweets first-party GraphQL query"),
  "comments.read": contract("x", "comments.read", "R1", "observed", "current TweetDetail conversation entries"),
  "messaging.list": contract("x", "messaging.list", "R1", "capture-required", "current X Chat inbox events are encrypted and require the reviewed key-recovery runtime before plaintext listing"),
  "messaging.read": contract("x", "messaging.read", "R1", "capture-required", "current X Chat conversation events are encrypted and require verified key recovery before plaintext projection"),
  "articles.read": contract("x", "articles.read", "R1", "capture-required", "native article detail requires entitlement-specific reviewed capture"),
  "articles.draft.save": contract("x", "articles.draft.save", "R2", "observed", "current bounded media INIT/APPEND/FINALIZE plus Article entity create/title/content mutations save one response-bound private rich-text-and-image draft and never call ArticleEntityPublish", 2),
  "messaging.send": contract("x", "messaging.send", "R3", "capture-required", "DM send requires exact current mutation and target binding"),
  "posts.publish": contract("x", "posts.publish", "R3", "observed", "current optional single-PNG upload plus CreateTweet response and independent TweetResultByRestId readback binding", 2),
  "threads.publish": contract("x", "threads.publish", "R3", "capture-required", "ordered CreateTweet root/self-reply dispatch needs an authorized live fixture and reviewed transaction-header behavior"),
  "replies.create": contract("x", "replies.create", "R3", "capture-required", "CreateTweet reply needs an authorized live fixture and reviewed transaction-header behavior"),
  "posts.repost": contract("x", "posts.repost", "R3", "capture-required", "repost desired-state mutation needs an authorized live fixture and reviewed transaction-header behavior"),
  "posts.quote": contract("x", "posts.quote", "R3", "capture-required", "CreateTweet quote needs an authorized live fixture and reviewed transaction-header behavior"),
  "likes.set": contract("x", "likes.set", "R2", "observed", "current FavoriteTweet/UnfavoriteTweet desired-state mutations with ephemeral transaction header and independent TweetResultByRestId readback", 2),
  "content.save": contract("x", "content.save", "R2", "observed", "current CreateBookmark/DeleteBookmark desired-state mutations with ephemeral transaction header and independent TweetResultByRestId readback"),
  "articles.publish": contract("x", "articles.publish", "R3", "capture-required", "ArticleEntityPublish and public readback remain outside the private draft contract", 4),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

const reddit = {
  "comments.create": contract("reddit", "comments.create", REDDIT_WEB_OPERATIONS["comments.create"].risk, REDDIT_WEB_OPERATIONS["comments.create"].state, REDDIT_WEB_OPERATIONS["comments.create"].reason),
  "comments.read": contract("reddit", "comments.read", REDDIT_WEB_OPERATIONS["comments.read"].risk, REDDIT_WEB_OPERATIONS["comments.read"].state, REDDIT_WEB_OPERATIONS["comments.read"].reason),
  "communities.membership.set": contract("reddit", "communities.membership.set", REDDIT_WEB_OPERATIONS["communities.membership.set"].risk, REDDIT_WEB_OPERATIONS["communities.membership.set"].state, REDDIT_WEB_OPERATIONS["communities.membership.set"].reason),
  "content.edit": contract("reddit", "content.edit", REDDIT_WEB_OPERATIONS["content.edit"].risk, REDDIT_WEB_OPERATIONS["content.edit"].state, REDDIT_WEB_OPERATIONS["content.edit"].reason),
  "content.save": contract("reddit", "content.save", REDDIT_WEB_OPERATIONS["content.save"].risk, REDDIT_WEB_OPERATIONS["content.save"].state, REDDIT_WEB_OPERATIONS["content.save"].reason),
  "feeds.read": contract("reddit", "feeds.read", REDDIT_WEB_OPERATIONS["feeds.read"].risk, REDDIT_WEB_OPERATIONS["feeds.read"].state, REDDIT_WEB_OPERATIONS["feeds.read"].reason),
  "media.read": contract("reddit", "media.read", REDDIT_WEB_OPERATIONS["media.read"].risk, REDDIT_WEB_OPERATIONS["media.read"].state, REDDIT_WEB_OPERATIONS["media.read"].reason),
  "messaging.list": contract("reddit", "messaging.list", REDDIT_WEB_OPERATIONS["messaging.list"].risk, REDDIT_WEB_OPERATIONS["messaging.list"].state, REDDIT_WEB_OPERATIONS["messaging.list"].reason),
  "messaging.read": contract("reddit", "messaging.read", REDDIT_WEB_OPERATIONS["messaging.read"].risk, REDDIT_WEB_OPERATIONS["messaging.read"].state, REDDIT_WEB_OPERATIONS["messaging.read"].reason),
  "messaging.send": contract("reddit", "messaging.send", REDDIT_WEB_OPERATIONS["messaging.send"].risk, REDDIT_WEB_OPERATIONS["messaging.send"].state, REDDIT_WEB_OPERATIONS["messaging.send"].reason),
  "posts.publish": contract("reddit", "posts.publish", REDDIT_WEB_OPERATIONS["posts.publish"].risk, REDDIT_WEB_OPERATIONS["posts.publish"].state, REDDIT_WEB_OPERATIONS["posts.publish"].reason),
  "posts.read": contract("reddit", "posts.read", REDDIT_WEB_OPERATIONS["posts.read"].risk, REDDIT_WEB_OPERATIONS["posts.read"].state, REDDIT_WEB_OPERATIONS["posts.read"].reason),
  "posts.repost": contract("reddit", "posts.repost", REDDIT_WEB_OPERATIONS["posts.repost"].risk, REDDIT_WEB_OPERATIONS["posts.repost"].state, REDDIT_WEB_OPERATIONS["posts.repost"].reason),
  "reactions.set": contract("reddit", "reactions.set", REDDIT_WEB_OPERATIONS["reactions.set"].risk, REDDIT_WEB_OPERATIONS["reactions.set"].state, REDDIT_WEB_OPERATIONS["reactions.set"].reason),
  "relationships.follow.set": contract("reddit", "relationships.follow.set", REDDIT_WEB_OPERATIONS["relationships.follow.set"].risk, REDDIT_WEB_OPERATIONS["relationships.follow.set"].state, REDDIT_WEB_OPERATIONS["relationships.follow.set"].reason),
  "replies.create": contract("reddit", "replies.create", REDDIT_WEB_OPERATIONS["replies.create"].risk, REDDIT_WEB_OPERATIONS["replies.create"].state, REDDIT_WEB_OPERATIONS["replies.create"].reason),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

const whatsapp = {
  "contacts.list": contract("whatsapp", "contacts.list", WHATSAPP_WEB_OPERATIONS["contacts.list"].risk, WHATSAPP_WEB_OPERATIONS["contacts.list"].state, WHATSAPP_WEB_OPERATIONS["contacts.list"].reason),
  "content.edit": contract("whatsapp", "content.edit", WHATSAPP_WEB_OPERATIONS["content.edit"].risk, WHATSAPP_WEB_OPERATIONS["content.edit"].state, WHATSAPP_WEB_OPERATIONS["content.edit"].reason),
  "content.save": contract("whatsapp", "content.save", WHATSAPP_WEB_OPERATIONS["content.save"].risk, WHATSAPP_WEB_OPERATIONS["content.save"].state, WHATSAPP_WEB_OPERATIONS["content.save"].reason),
  "content.share": contract("whatsapp", "content.share", WHATSAPP_WEB_OPERATIONS["content.share"].risk, WHATSAPP_WEB_OPERATIONS["content.share"].state, WHATSAPP_WEB_OPERATIONS["content.share"].reason),
  "media.read": contract("whatsapp", "media.read", WHATSAPP_WEB_OPERATIONS["media.read"].risk, WHATSAPP_WEB_OPERATIONS["media.read"].state, WHATSAPP_WEB_OPERATIONS["media.read"].reason),
  "messaging.list": contract("whatsapp", "messaging.list", WHATSAPP_WEB_OPERATIONS["messaging.list"].risk, WHATSAPP_WEB_OPERATIONS["messaging.list"].state, WHATSAPP_WEB_OPERATIONS["messaging.list"].reason),
  "messaging.read": contract("whatsapp", "messaging.read", WHATSAPP_WEB_OPERATIONS["messaging.read"].risk, WHATSAPP_WEB_OPERATIONS["messaging.read"].state, WHATSAPP_WEB_OPERATIONS["messaging.read"].reason),
  "messaging.send": contract("whatsapp", "messaging.send", WHATSAPP_WEB_OPERATIONS["messaging.send"].risk, WHATSAPP_WEB_OPERATIONS["messaging.send"].state, WHATSAPP_WEB_OPERATIONS["messaging.send"].reason),
  "reactions.set": contract("whatsapp", "reactions.set", WHATSAPP_WEB_OPERATIONS["reactions.set"].risk, WHATSAPP_WEB_OPERATIONS["reactions.set"].state, WHATSAPP_WEB_OPERATIONS["reactions.set"].reason),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

const substack = {
  "articles.publish": contract("substack", "articles.publish", SUBSTACK_WEB_OPERATIONS["articles.publish"].risk, SUBSTACK_WEB_OPERATIONS["articles.publish"].state, SUBSTACK_WEB_OPERATIONS["articles.publish"].reason),
  "articles.read": contract("substack", "articles.read", SUBSTACK_WEB_OPERATIONS["articles.read"].risk, SUBSTACK_WEB_OPERATIONS["articles.read"].state, SUBSTACK_WEB_OPERATIONS["articles.read"].reason),
  "comments.create": contract("substack", "comments.create", SUBSTACK_WEB_OPERATIONS["comments.create"].risk, SUBSTACK_WEB_OPERATIONS["comments.create"].state, SUBSTACK_WEB_OPERATIONS["comments.create"].reason),
  "comments.read": contract("substack", "comments.read", SUBSTACK_WEB_OPERATIONS["comments.read"].risk, SUBSTACK_WEB_OPERATIONS["comments.read"].state, SUBSTACK_WEB_OPERATIONS["comments.read"].reason),
  "content.edit": contract("substack", "content.edit", SUBSTACK_WEB_OPERATIONS["content.edit"].risk, SUBSTACK_WEB_OPERATIONS["content.edit"].state, SUBSTACK_WEB_OPERATIONS["content.edit"].reason),
  "content.save": contract("substack", "content.save", SUBSTACK_WEB_OPERATIONS["content.save"].risk, SUBSTACK_WEB_OPERATIONS["content.save"].state, SUBSTACK_WEB_OPERATIONS["content.save"].reason),
  "content.schedule": contract("substack", "content.schedule", SUBSTACK_WEB_OPERATIONS["content.schedule"].risk, SUBSTACK_WEB_OPERATIONS["content.schedule"].state, SUBSTACK_WEB_OPERATIONS["content.schedule"].reason),
  "content.share": contract("substack", "content.share", SUBSTACK_WEB_OPERATIONS["content.share"].risk, SUBSTACK_WEB_OPERATIONS["content.share"].state, SUBSTACK_WEB_OPERATIONS["content.share"].reason),
  "feeds.read": contract("substack", "feeds.read", SUBSTACK_WEB_OPERATIONS["feeds.read"].risk, SUBSTACK_WEB_OPERATIONS["feeds.read"].state, SUBSTACK_WEB_OPERATIONS["feeds.read"].reason),
  "likes.set": contract("substack", "likes.set", SUBSTACK_WEB_OPERATIONS["likes.set"].risk, SUBSTACK_WEB_OPERATIONS["likes.set"].state, SUBSTACK_WEB_OPERATIONS["likes.set"].reason),
  "media.read": contract("substack", "media.read", SUBSTACK_WEB_OPERATIONS["media.read"].risk, SUBSTACK_WEB_OPERATIONS["media.read"].state, SUBSTACK_WEB_OPERATIONS["media.read"].reason),
  "messaging.list": contract("substack", "messaging.list", SUBSTACK_WEB_OPERATIONS["messaging.list"].risk, SUBSTACK_WEB_OPERATIONS["messaging.list"].state, SUBSTACK_WEB_OPERATIONS["messaging.list"].reason),
  "messaging.read": contract("substack", "messaging.read", SUBSTACK_WEB_OPERATIONS["messaging.read"].risk, SUBSTACK_WEB_OPERATIONS["messaging.read"].state, SUBSTACK_WEB_OPERATIONS["messaging.read"].reason),
  "messaging.send": contract("substack", "messaging.send", SUBSTACK_WEB_OPERATIONS["messaging.send"].risk, SUBSTACK_WEB_OPERATIONS["messaging.send"].state, SUBSTACK_WEB_OPERATIONS["messaging.send"].reason),
  "posts.publish": contract("substack", "posts.publish", SUBSTACK_WEB_OPERATIONS["posts.publish"].risk, SUBSTACK_WEB_OPERATIONS["posts.publish"].state, SUBSTACK_WEB_OPERATIONS["posts.publish"].reason, SUBSTACK_WEB_OPERATIONS["posts.publish"].contractVersion),
  "posts.quote": contract("substack", "posts.quote", SUBSTACK_WEB_OPERATIONS["posts.quote"].risk, SUBSTACK_WEB_OPERATIONS["posts.quote"].state, SUBSTACK_WEB_OPERATIONS["posts.quote"].reason),
  "posts.read": contract("substack", "posts.read", SUBSTACK_WEB_OPERATIONS["posts.read"].risk, SUBSTACK_WEB_OPERATIONS["posts.read"].state, SUBSTACK_WEB_OPERATIONS["posts.read"].reason),
  "posts.repost": contract("substack", "posts.repost", SUBSTACK_WEB_OPERATIONS["posts.repost"].risk, SUBSTACK_WEB_OPERATIONS["posts.repost"].state, SUBSTACK_WEB_OPERATIONS["posts.repost"].reason),
  "relationships.follow.set": contract("substack", "relationships.follow.set", SUBSTACK_WEB_OPERATIONS["relationships.follow.set"].risk, SUBSTACK_WEB_OPERATIONS["relationships.follow.set"].state, SUBSTACK_WEB_OPERATIONS["relationships.follow.set"].reason),
  "replies.create": contract("substack", "replies.create", SUBSTACK_WEB_OPERATIONS["replies.create"].risk, SUBSTACK_WEB_OPERATIONS["replies.create"].state, SUBSTACK_WEB_OPERATIONS["replies.create"].reason),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

const tiktok = {
  "comments.create": contract("tiktok", "comments.create", TIKTOK_WEB_OPERATIONS["comments.create"].risk, TIKTOK_WEB_OPERATIONS["comments.create"].state, TIKTOK_WEB_OPERATIONS["comments.create"].reason),
  "comments.read": contract("tiktok", "comments.read", TIKTOK_WEB_OPERATIONS["comments.read"].risk, TIKTOK_WEB_OPERATIONS["comments.read"].state, TIKTOK_WEB_OPERATIONS["comments.read"].reason),
  "content.save": contract("tiktok", "content.save", TIKTOK_WEB_OPERATIONS["content.save"].risk, TIKTOK_WEB_OPERATIONS["content.save"].state, TIKTOK_WEB_OPERATIONS["content.save"].reason),
  "content.schedule": contract("tiktok", "content.schedule", TIKTOK_WEB_OPERATIONS["content.schedule"].risk, TIKTOK_WEB_OPERATIONS["content.schedule"].state, TIKTOK_WEB_OPERATIONS["content.schedule"].reason),
  "content.share": contract("tiktok", "content.share", TIKTOK_WEB_OPERATIONS["content.share"].risk, TIKTOK_WEB_OPERATIONS["content.share"].state, TIKTOK_WEB_OPERATIONS["content.share"].reason),
  "feeds.read": contract("tiktok", "feeds.read", TIKTOK_WEB_OPERATIONS["feeds.read"].risk, TIKTOK_WEB_OPERATIONS["feeds.read"].state, TIKTOK_WEB_OPERATIONS["feeds.read"].reason),
  "likes.set": contract("tiktok", "likes.set", TIKTOK_WEB_OPERATIONS["likes.set"].risk, TIKTOK_WEB_OPERATIONS["likes.set"].state, TIKTOK_WEB_OPERATIONS["likes.set"].reason),
  "media.publish": contract("tiktok", "media.publish", TIKTOK_WEB_OPERATIONS["media.publish"].risk, TIKTOK_WEB_OPERATIONS["media.publish"].state, TIKTOK_WEB_OPERATIONS["media.publish"].reason),
  "media.read": contract("tiktok", "media.read", TIKTOK_WEB_OPERATIONS["media.read"].risk, TIKTOK_WEB_OPERATIONS["media.read"].state, TIKTOK_WEB_OPERATIONS["media.read"].reason),
  "messaging.list": contract("tiktok", "messaging.list", TIKTOK_WEB_OPERATIONS["messaging.list"].risk, TIKTOK_WEB_OPERATIONS["messaging.list"].state, TIKTOK_WEB_OPERATIONS["messaging.list"].reason),
  "messaging.read": contract("tiktok", "messaging.read", TIKTOK_WEB_OPERATIONS["messaging.read"].risk, TIKTOK_WEB_OPERATIONS["messaging.read"].state, TIKTOK_WEB_OPERATIONS["messaging.read"].reason),
  "messaging.send": contract("tiktok", "messaging.send", TIKTOK_WEB_OPERATIONS["messaging.send"].risk, TIKTOK_WEB_OPERATIONS["messaging.send"].state, TIKTOK_WEB_OPERATIONS["messaging.send"].reason),
  "posts.publish": contract("tiktok", "posts.publish", TIKTOK_WEB_OPERATIONS["posts.publish"].risk, TIKTOK_WEB_OPERATIONS["posts.publish"].state, TIKTOK_WEB_OPERATIONS["posts.publish"].reason),
  "posts.read": contract("tiktok", "posts.read", TIKTOK_WEB_OPERATIONS["posts.read"].risk, TIKTOK_WEB_OPERATIONS["posts.read"].state, TIKTOK_WEB_OPERATIONS["posts.read"].reason),
  "posts.repost": contract("tiktok", "posts.repost", TIKTOK_WEB_OPERATIONS["posts.repost"].risk, TIKTOK_WEB_OPERATIONS["posts.repost"].state, TIKTOK_WEB_OPERATIONS["posts.repost"].reason),
  "relationships.follow.set": contract("tiktok", "relationships.follow.set", TIKTOK_WEB_OPERATIONS["relationships.follow.set"].risk, TIKTOK_WEB_OPERATIONS["relationships.follow.set"].state, TIKTOK_WEB_OPERATIONS["relationships.follow.set"].reason),
  "replies.create": contract("tiktok", "replies.create", TIKTOK_WEB_OPERATIONS["replies.create"].risk, TIKTOK_WEB_OPERATIONS["replies.create"].state, TIKTOK_WEB_OPERATIONS["replies.create"].reason),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

const youtube = {
  "comments.create": contract("youtube", "comments.create", "R3", "capture-required", "current comment mutation, actor/target response binding, and an authorized live fixture remain required"),
  "comments.read": contract("youtube", "comments.read", "R1", "observed", "current acknowledgement-free Innertube next/continuation requests with exact video binding"),
  "content.edit": contract("youtube", "content.edit", "R3", "capture-required", "video, Community-post, and comment edit mutations require separate reviewed contracts"),
  "content.save": contract("youtube", "content.save", "R2", "capture-required", "the current Watch Later playlist edit implementation and target-bound readback are deterministic-test proven but still require an authorized low-stakes live fixture"),
  "content.schedule": contract("youtube", "content.schedule", "R3", "capture-required", "Studio scheduling requires current multi-origin visibility, timezone, audience, and processing contracts"),
  "feeds.read": contract("youtube", "feeds.read", "R1", "observed", "current signed-in fixed Innertube browse feeds"),
  "likes.set": contract("youtube", "likes.set", "R2", "capture-required", "the current target-bound like implementation and independent readback are deterministic-test proven but still require an authorized low-stakes live fixture"),
  "media.publish": contract("youtube", "media.publish", "R3", "capture-required", "Studio resumable upload, byte transfer, metadata, audience, processing, and publication require an authorized fixture"),
  "media.read": contract("youtube", "media.read", "R1", "observed", "current fixed Innertube player metadata request with playback credentials omitted"),
  "posts.publish": contract("youtube", "posts.publish", "R3", "capture-required", "Community text/media publication requires current actor binding and an authorized fixture"),
  "posts.read": contract("youtube", "posts.read", "R1", "observed", "current resolve_url plus exact Community-post browse request"),
  "relationships.follow.set": contract("youtube", "relationships.follow.set", "R2", "capture-required", "the current target-bound subscription implementation and independent browse readback are deterministic-test proven but still require an authorized low-stakes live fixture"),
  "replies.create": contract("youtube", "replies.create", "R3", "capture-required", "current reply mutation, parent binding, and an authorized live fixture remain required"),
} as const satisfies Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>;

export const webSessionContractDefinitions = {
  bluesky,
  facebook,
  "facebook-group": facebookGroup,
  "facebook-marketplace": facebookMarketplace,
  "facebook-page": facebookPage,
  "hacker-news": hackerNews,
  instagram,
  linkedin,
  reddit,
  substack,
  tiktok,
  threads,
  x,
  youtube,
  whatsapp,
} as const satisfies Readonly<Partial<Record<
  WebSessionSiteId,
  Readonly<Partial<Record<SemanticOperationName, WebSessionContract>>>
>>>;

export { planWebSessionContractDispatches } from "./web-session-contract-planning";
