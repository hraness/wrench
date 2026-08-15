import { isIP } from "node:net";

import { isPrivateAddress, isPrivateHostname } from "@hraness/kb/clip/network";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  platformSurfaceIds,
  semanticOperationNames,
  socialPlatformCatalog,
  textWeightPolicies,
  weightedTextLength,
  type AttachmentKind,
  type CompositionName,
  type PlatformSurfaceCatalogEntry,
  type PlatformSurfaceId,
  type SemanticOperationName,
} from "./platform-catalog";
import {
  isProviderPluginOperationName,
  isProviderPluginSurfaceId,
  type ProviderPluginOperationName,
  type ProviderPluginSurfaceId,
} from "./provider-plugin-identifiers";
import type {
  ProviderPluginBindingV1,
  ProviderPluginOperationV1,
} from "./provider-plugin";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { parseWebSessionTemplate, type WebSessionTemplate } from "./web-session-template";
import type { WebSessionSiteId } from "./web-session-sites";
import { DOM_ACTION_TRANSPORT_DISABLED_MESSAGE } from "./transport-policy";

export { canonicalJson, sha256 } from "./canonical-json";
export { DOM_ACTION_TRANSPORT_DISABLED_MESSAGE } from "./transport-policy";
export type { WebSessionSiteId } from "./web-session-sites";

export const WRENCH_MANIFEST_SCHEMA_VERSION = 2 as const;
export const WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION = 3 as const;
export const WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION = 4 as const;
export const WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION = 5 as const;
export const WRENCH_LEGACY_MANIFEST_SCHEMA_VERSION = 1 as const;
/** Canonical manifest hash of the sole schema-v1 LinkedIn migration fixture. */
export const WRENCH_LEGACY_LINKEDIN_MANIFEST_HASH = "bbdd1f8c1a532d621a367776770c968fd06cb7cf3b343d64ccda4b53690bb42f";
export const operationRisks = ["R1", "R2", "R3", "R4"] as const;
export type OperationRisk = (typeof operationRisks)[number];
export const idempotencyKinds = ["none", "local-at-most-once"] as const;
export type IdempotencyKind = (typeof idempotencyKinds)[number];

export type ScalarInputField = {
  readonly type: "string" | "boolean" | "number";
  readonly description: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly (string | number | boolean)[];
  readonly format?: "url" | "path-segment";
  readonly urlPathPrefixes?: readonly string[];
};

export type FileInputField = {
  readonly type: "file";
  readonly description: string;
  readonly maxBytes: number;
  readonly mediaTypes?: readonly string[];
};

export type ArrayInputField = {
  readonly type: "array";
  readonly description: string;
  readonly items: ScalarInputField | FileInputField;
  readonly minItems: number;
  readonly maxItems: number;
};

export type InputField = ScalarInputField | FileInputField | ArrayInputField;

export type FileInputValue = {
  /** An opaque plan-bound reference. Only the runtime's injected resolver may materialize it. */
  readonly kind: "file";
  readonly reference: string;
};

export type ScalarInputValue = string | number | boolean;
export type ArrayInputValue = readonly (ScalarInputValue | FileInputValue)[];
export type InputValue = ScalarInputValue | FileInputValue | ArrayInputValue;
export type OperationInput = Readonly<Record<string, InputValue>>;

export type InputSchema = {
  readonly properties: Readonly<Record<string, InputField>>;
  readonly required: readonly string[];
};

export type SemanticLocator =
  | { readonly by: "role"; readonly value: string; readonly name?: string; readonly exact?: boolean }
  | { readonly by: "text" | "label" | "placeholder" | "alt" | "title" | "testid"; readonly value: string; readonly exact?: boolean };

export type ExactSemanticReferenceLocator = {
  readonly by: "role";
  readonly value: string;
  readonly name: string;
  readonly exact: true;
};

export type BrowserValueSource =
  | { readonly input: string }
  | { readonly item: true };

export type BrowserStepEffect =
  | { readonly kind: "prepare"; readonly description: string }
  | { readonly kind: "dispatch"; readonly id: string; readonly description: string };

export type BrowserAssertion =
  | { readonly kind: "assert-text"; readonly text: string }
  | { readonly kind: "assert-url"; readonly pattern: string }
  | { readonly kind: "assert-input-empty"; readonly locator: ExactSemanticReferenceLocator }
  | { readonly kind: "assert-value"; readonly locator: ExactSemanticReferenceLocator; readonly equals: BrowserValueSource }
  | { readonly kind: "assert-checked"; readonly locator: ExactSemanticReferenceLocator; readonly checked: boolean };

export type BrowserRecipeStep =
  | { readonly kind: "navigate"; readonly path: string; readonly query?: Readonly<Record<string, string>> }
  | { readonly kind: "navigate-input"; readonly input: string }
  | {
      readonly kind: "find";
      readonly locator: SemanticLocator;
      readonly action: "click" | "fill" | "type" | "hover" | "upload" | "select" | "check" | "uncheck";
      readonly with?: string | BrowserValueSource;
      readonly effect?: BrowserStepEffect;
      /** v1 compatibility only; v2 manifests use effect. */
      readonly dispatch?: boolean;
    }
  | { readonly kind: "press"; readonly key: string; readonly effect?: BrowserStepEffect; readonly dispatch?: boolean }
  | { readonly kind: "wait"; readonly milliseconds: number }
  | { readonly kind: "wait-text"; readonly text: string }
  | { readonly kind: "snapshot"; readonly interactive?: boolean }
  | { readonly kind: "read" }
  | { readonly kind: "assert-text"; readonly text: string }
  | { readonly kind: "assert-url"; readonly pattern: string }
  | {
      readonly kind: "assert-input-empty";
      readonly locator: ExactSemanticReferenceLocator & { readonly value: "textbox" };
    }
  | { readonly kind: "assert-value"; readonly locator: ExactSemanticReferenceLocator; readonly equals: BrowserValueSource }
  | { readonly kind: "assert-checked"; readonly locator: ExactSemanticReferenceLocator; readonly checked: boolean }
  | { readonly kind: "verify-dispatch"; readonly dispatch: string; readonly assertions: readonly BrowserAssertion[] }
  | {
      readonly kind: "for-each";
      readonly input: string;
      readonly steps: readonly BrowserRecipeStep[];
      readonly between?: readonly BrowserRecipeStep[];
    };

export type BrowserDispatchPlan = {
  readonly id: string;
  readonly description: string;
};

export type ExpandedBrowserRecipeStep = {
  readonly step: Exclude<BrowserRecipeStep, { readonly kind: "for-each" }>;
  readonly item?: ScalarInputValue | FileInputValue;
};

export type ExpandedBrowserRecipe = Omit<BrowserRecipe, "steps"> & {
  readonly steps: readonly ExpandedBrowserRecipeStep[];
  readonly dispatches: readonly BrowserDispatchPlan[];
};

export type BrowserRecipe = {
  readonly steps: readonly BrowserRecipeStep[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

export type OfficialProviderId = ProviderPluginSurfaceId;
export type BundledOfficialProviderId = OfficialProviderId;

export type ProviderRecipe = {
  /** Names code-owned endpoint logic; manifests cannot supply methods or URLs. */
  readonly provider: OfficialProviderId;
  readonly action: ProviderPluginOperationName;
  /** Must match the code-owned registry revision bound into confirmation plans. */
  readonly contractVersion: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

export type WebSessionRecipe = {
  /** Names a code-owned first-party web contract; no arbitrary request surface is exposed. */
  readonly site: WebSessionSiteId;
  readonly action: ProviderPluginOperationName;
  readonly contractVersion: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

export type ReviewedTemplateRecipe =
  | {
      readonly state: "capture-required";
      readonly contractVersion: 1;
      /** Non-executable reviewer guidance only; never populated from raw request values. */
      readonly instructions: string;
    }
  | {
      /** Reserved for migration tests; schema-v5 manifests reject executable v1 templates. */
      readonly state: "reviewed";
      readonly contractVersion: 1;
      readonly reviewedAt: string;
      /** Binds the review record to a secret-free evidence or review artifact. */
      readonly evidenceSha256: string;
      readonly timeoutMs: number;
      readonly template: WebSessionTemplate;
    };

type WrenchOperationCommon = {
  readonly description: string;
  readonly risk: OperationRisk;
  readonly sideEffect: string;
  readonly idempotency: IdempotencyKind;
  readonly dedupeWindowMs: number;
  readonly input: InputSchema;
};

export type BrowserWrenchOperation = WrenchOperationCommon & {
  readonly browser: BrowserRecipe;
  readonly provider?: never;
  readonly webSession?: never;
  readonly reviewedTemplate?: never;
};

export type ProviderWrenchOperation = WrenchOperationCommon & {
  readonly browser?: never;
  readonly provider: ProviderRecipe;
  readonly webSession?: never;
  readonly reviewedTemplate?: never;
};

export type WebSessionWrenchOperation = WrenchOperationCommon & {
  readonly browser?: never;
  readonly provider?: never;
  readonly webSession: WebSessionRecipe;
  readonly reviewedTemplate?: never;
};

export type ReviewedTemplateWrenchOperation = WrenchOperationCommon & {
  readonly browser?: never;
  readonly provider?: never;
  readonly webSession?: never;
  readonly reviewedTemplate: ReviewedTemplateRecipe;
};

export type WrenchOperation =
  | BrowserWrenchOperation
  | ProviderWrenchOperation
  | WebSessionWrenchOperation
  | ReviewedTemplateWrenchOperation;

export function isProviderOperation(operation: WrenchOperation): operation is ProviderWrenchOperation {
  return operation.provider !== undefined;
}

export function isWebSessionOperation(operation: WrenchOperation): operation is WebSessionWrenchOperation {
  return operation.webSession !== undefined;
}

export function isReviewedTemplateOperation(operation: WrenchOperation): operation is ReviewedTemplateWrenchOperation {
  return operation.reviewedTemplate !== undefined;
}

export function isBrowserOperation(operation: WrenchOperation): operation is BrowserWrenchOperation {
  return operation.browser !== undefined;
}

export type WrenchManifest = {
  readonly schemaVersion:
    | typeof WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION
    | typeof WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION
    | typeof WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION
    | typeof WRENCH_MANIFEST_SCHEMA_VERSION
    | typeof WRENCH_LEGACY_MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  /** Binds a schema-v2 adapter to wrench's reviewed policy for a known surface. */
  readonly surfaceId?: ProviderPluginSurfaceId;
  readonly origins: readonly string[];
  readonly browserDomains: readonly string[];
  readonly operations: Readonly<Record<string, WrenchOperation>>;
};

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

const operationCompositions: Readonly<Partial<Record<SemanticOperationName, CompositionName>>> = {
  "messaging.send": "message",
  "comments.create": "comment",
  "replies.create": "reply",
  "posts.publish": "post",
  "media.publish": "media",
  "articles.draft.save": "article",
  "articles.publish": "article",
  "listings.publish": "listing",
};

export const genericSemanticRisks = {
  "content.read": "R1",
  "content.clip": "R1",
  "profiles.read": "R1",
  "organizations.read": "R1",
  "contacts.list": "R1",
  "feeds.read": "R1",
  "messaging.list": "R1",
  "messaging.read": "R1",
  "messaging.send": "R3",
  "comments.read": "R1",
  "comments.create": "R3",
  "replies.create": "R3",
  "posts.read": "R1",
  "posts.publish": "R3",
  "threads.publish": "R3",
  "reactions.set": "R2",
  "likes.set": "R2",
  "media.read": "R1",
  "media.publish": "R3",
  "articles.read": "R1",
  "articles.draft.save": "R2",
  "articles.publish": "R3",
  "listings.read": "R1",
  "listings.publish": "R3",
  "relationships.follow.set": "R2",
  "relationships.recommendations.read": "R1",
  "relationships.connect": "R3",
  "posts.repost": "R3",
  "posts.quote": "R3",
  "content.share": "R3",
  "content.save": "R2",
  "content.edit": "R3",
  "content.delete": "R4",
  "content.schedule": "R3",
  "content.audience.set": "R4",
  "communities.membership.set": "R2",
  "communities.membership.manage": "R4",
  "administration.manage": "R4",
  "commerce.purchase": "R4",
  "account.delete": "R4",
  "moderation.bulk": "R4",
} as const satisfies Readonly<Record<SemanticOperationName, OperationRisk>>;

export function isReviewedTemplateProtectedHostname(
  hostnameOrPattern: string,
  registry: ProviderPluginRegistry,
): boolean {
  const normalized = hostnameOrPattern.toLowerCase().replace(/\.$/u, "");
  const wildcardSuffix = normalized.startsWith("*.") ? normalized.slice(2) : null;
  const registeredFamilies = registry.list().flatMap((plugin) =>
    plugin.bindings.flatMap((binding) => binding.protectedHostnameFamilies));
  return registeredFamilies.some((family) => {
    if (wildcardSuffix === null) {
      return normalized === family || normalized.endsWith(`.${family}`);
    }
    return wildcardSuffix === family
      || wildcardSuffix.endsWith(`.${family}`)
      || family.endsWith(`.${wildcardSuffix}`);
  });
}

function hasCodeOwnedPluginSurface(
  surfaceId: string,
  registry: ProviderPluginRegistry,
): boolean {
  return registry.resolveRoute("provider-api", surfaceId) !== undefined
    || registry.resolveSessionRoute(surfaceId) !== undefined;
}

function mediaTypeKinds(mediaType: string): readonly AttachmentKind[] {
  if (mediaType === "image/gif") return ["image", "gif"];
  if (mediaType === "image/*" || mediaType.startsWith("image/")) return ["image"];
  if (mediaType === "video/*" || mediaType.startsWith("video/")) return ["video"];
  if (mediaType === "audio/*" || mediaType.startsWith("audio/")) return ["audio"];
  return ["document"];
}

function validatePlatformCompositionSchema(
  surfaceId: PlatformSurfaceId,
  operationId: SemanticOperationName,
  operation: WrenchOperation,
  path: string,
  issues: string[],
): void {
  const compositionName = operationCompositions[operationId];
  if (compositionName === undefined) return;
  const surface = socialPlatformCatalog[surfaceId] as PlatformSurfaceCatalogEntry;
  const policy = surface.compositions[compositionName];
  if (policy === undefined) {
    issues.push(`${path} has no reviewed ${compositionName} composition policy on ${surfaceId}`);
    return;
  }
  const required = new Set(operation.input.required);
  for (const text of policy.text) {
    const field = operation.input.properties[text.name];
    if (field === undefined) {
      if (text.required) issues.push(`${path}.input.properties.${text.name} is required by the reviewed ${surfaceId} ${compositionName} policy`);
      continue;
    }
    if (field.type !== "string") {
      issues.push(`${path}.input.properties.${text.name} must be a string under the reviewed composition policy`);
      continue;
    }
    if (field.maxLength === undefined || field.maxLength > text.safeMaxUnits) {
      issues.push(`${path}.input.properties.${text.name}.maxLength must be at most ${text.safeMaxUnits}`);
    }
    if (
      text.format === "currency-code"
      && (field.minLength !== 3 || field.maxLength !== 3)
    ) {
      issues.push(`${path}.input.properties.${text.name} must allow exactly one three-letter currency code`);
    }
    if (text.required && (field.minLength === undefined || field.minLength < 1)) {
      issues.push(`${path}.input.properties.${text.name}.minLength must be at least 1`);
    }
    if (
      text.format === "provider-option"
      && (field.enum === undefined || field.enum.length < 1 || field.enum.some((value) => typeof value !== "string"))
    ) {
      issues.push(`${path}.input.properties.${text.name}.enum must declare the adapter's reviewed provider options`);
    }
    if (text.required && !required.has(text.name)) {
      issues.push(`${path}.input.required must include ${text.name}`);
    }
  }

  const attachmentPolicy = policy.attachments;
  if (attachmentPolicy.state === "none") {
    if (Object.values(operation.input.properties).some((field) =>
      field.type === "file" || (field.type === "array" && field.items.type === "file"))) {
      issues.push(`${path}.input cannot declare file attachments for ${surfaceId} ${compositionName}`);
    }
    return;
  }
  let maximumFiles = 0;
  let minimumRequiredFiles = 0;
  for (const [name, field] of Object.entries(operation.input.properties)) {
    let file: FileInputField;
    if (field.type === "file") file = field;
    else if (field.type === "array" && field.items.type === "file") file = field.items;
    else continue;
    maximumFiles += field.type === "file" ? 1 : field.maxItems;
    if (required.has(name)) minimumRequiredFiles += field.type === "file" ? 1 : field.minItems;
    if (file.mediaTypes === undefined) {
      issues.push(`${path}.input.properties.${name} must declare mediaTypes under a platform attachment policy`);
      continue;
    }
    for (const mediaType of file.mediaTypes) {
      if (!mediaTypeKinds(mediaType).some((kind) => attachmentPolicy.kinds.includes(kind))) {
        issues.push(`${path}.input.properties.${name}.mediaTypes includes ${mediaType}, outside the reviewed attachment kinds`);
      }
    }
  }
  if (maximumFiles > attachmentPolicy.maxItems) {
    issues.push(`${path}.input can accept at most ${attachmentPolicy.maxItems} binary attachment(s)`);
  }
  if (minimumRequiredFiles < attachmentPolicy.minItems) {
    issues.push(`${path}.input must require at least ${attachmentPolicy.minItems} binary attachment(s)`);
  }
}

function threadTextPolicy(surfaceId: PlatformSurfaceId): {
  readonly maxItems: number;
  readonly maxWeightedLength: number;
  readonly measurement: keyof typeof textWeightPolicies;
} | null {
  const surface = socialPlatformCatalog[surfaceId] as PlatformSurfaceCatalogEntry;
  if (surface.threads.publish.state !== "adapter-eligible") return null;
  const root = surface.compositions.post?.text.find((field) => field.name === "body");
  const continuation = surface.compositions.reply?.text.find((field) => field.name === "body");
  if (root === undefined || continuation === undefined || root.measurement !== continuation.measurement) return null;
  return {
    maxItems: surface.threads.publish.safeMaxItems,
    maxWeightedLength: Math.min(root.safeMaxUnits, continuation.safeMaxUnits),
    measurement: root.measurement,
  };
}

function validatePlatformThreadSchema(
  surfaceId: PlatformSurfaceId,
  operation: WrenchOperation,
  path: string,
  issues: string[],
): void {
  const policy = threadTextPolicy(surfaceId);
  if (policy === null) {
    issues.push(`${path} has no internally consistent reviewed thread composition policy`);
    return;
  }
  const items = operation.input.properties.items;
  if (items?.type !== "array" || items.items.type !== "string") {
    issues.push(`${path}.input.properties.items must be an array of thread text strings`);
    return;
  }
  if (!operation.input.required.includes("items") || items.minItems < 1 || items.maxItems > policy.maxItems) {
    issues.push(`${path}.input.items must be required with 1-${policy.maxItems} items`);
  }
  if (items.items.minLength === undefined || items.items.minLength < 1 || items.items.maxLength === undefined || items.items.maxLength > policy.maxWeightedLength) {
    issues.push(`${path}.input.properties.items.items must use length bounds 1-${policy.maxWeightedLength}`);
  }
}

function validateGenericThreadSchema(operation: WrenchOperation, path: string, issues: string[]): void {
  const items = operation.input.properties.items;
  if (items?.type !== "array" || items.items.type !== "string") {
    issues.push(`${path}.input.properties.items must be an array of thread text strings`);
    return;
  }
  if (!operation.input.required.includes("items") || items.minItems < 1 || items.maxItems > 25) {
    issues.push(`${path}.input.items must be required with 1-25 items`);
  }
  if (items.items.minLength === undefined || items.items.minLength < 1 || items.items.maxLength === undefined) {
    issues.push(`${path}.input.properties.items.items must declare non-empty bounded strings`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isPlatformSurfaceId(value: string): value is PlatformSurfaceId {
  return platformSurfaceIds.includes(value as PlatformSurfaceId);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, issues: string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not supported`);
  }
}

function boundedString(
  value: unknown,
  path: string,
  issues: string[],
  minimum = 1,
  maximum = 4_096,
): string | null {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    issues.push(`${path} must be a ${minimum}-${maximum} character string without control characters`);
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      issues.push(`${path} must be a ${minimum}-${maximum} character string without control characters`);
      return null;
    }
  }
  if (hasUnpairedSurrogate(value)) {
    issues.push(`${path} must contain well-formed Unicode`);
    return null;
  }
  return value;
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number, issues: string[]): number | null {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    issues.push(`${path} must be an integer between ${minimum} and ${maximum}`);
    return null;
  }
  return value;
}

function hasAmbiguousPathSyntax(value: string): boolean {
  return value.includes("\\")
    || /%(?:25|2e|2f|5c)/iu.test(value)
    || value.split("/").some((segment) => segment === "." || segment === "..");
}

function matchesUrlPathPrefix(pathname: string, prefix: string): boolean {
  return prefix.endsWith("/")
    ? pathname.startsWith(prefix)
    : pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function rawUrlPath(value: string): string {
  const authority = value.indexOf("://");
  const start = authority < 0 ? 0 : value.indexOf("/", authority + 3);
  if (start < 0) return "/";
  const end = value.search(/[?#]/u);
  return value.slice(start, end >= start ? end : undefined);
}

function parseField(
  value: unknown,
  path: string,
  issues: string[],
  maximumArrayItems: 25 | 100,
  nested = false,
): InputField | null {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return null;
  }
  if (value.type === "file") {
    exactKeys(value, ["type", "description", "maxBytes", "mediaTypes"], path, issues);
    const description = boundedString(value.description, `${path}.description`, issues, 1, 500);
    const maxBytes = safeInteger(value.maxBytes, `${path}.maxBytes`, 1, 1024 * 1024 * 1024, issues);
    let mediaTypes: readonly string[] | undefined;
    if (value.mediaTypes !== undefined) {
      if (
        !Array.isArray(value.mediaTypes)
        || value.mediaTypes.length < 1
        || value.mediaTypes.length > 32
        || value.mediaTypes.some((candidate) => typeof candidate !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/u.test(candidate))
      ) {
        issues.push(`${path}.mediaTypes must contain 1-32 valid media types`);
      } else mediaTypes = [...new Set(value.mediaTypes as string[])];
    }
    if (description === null || maxBytes === null) return null;
    return { type: "file", description, maxBytes, ...(mediaTypes === undefined ? {} : { mediaTypes }) };
  }
  if (value.type === "array") {
    exactKeys(value, ["type", "description", "items", "minItems", "maxItems"], path, issues);
    const description = boundedString(value.description, `${path}.description`, issues, 1, 500);
    const minItems = safeInteger(value.minItems, `${path}.minItems`, 0, maximumArrayItems, issues);
    const maxItems = safeInteger(value.maxItems, `${path}.maxItems`, 1, maximumArrayItems, issues);
    if (nested) issues.push(`${path} cannot contain a nested array`);
    const items = nested ? null : parseField(value.items, `${path}.items`, issues, maximumArrayItems, true);
    if (items?.type === "array") issues.push(`${path}.items cannot be an array`);
    if (minItems !== null && maxItems !== null && minItems > maxItems) {
      issues.push(`${path}.minItems cannot exceed maxItems`);
    }
    if (description === null || minItems === null || maxItems === null || items === null || items.type === "array") return null;
    return { type: "array", description, items, minItems, maxItems };
  }
  exactKeys(value, ["type", "description", "minLength", "maxLength", "minimum", "maximum", "enum", "format", "urlPathPrefixes"], path, issues);
  const type = value.type;
  if (type !== "string" && type !== "boolean" && type !== "number") {
    issues.push(`${path}.type must be string, boolean, number, file, or array`);
    return null;
  }
  const description = boundedString(value.description, `${path}.description`, issues, 1, 500);
  if (description === null) return null;
  const minLength = value.minLength === undefined ? undefined : safeInteger(value.minLength, `${path}.minLength`, 0, 1_000_000, issues) ?? undefined;
  const maxLength = value.maxLength === undefined ? undefined : safeInteger(value.maxLength, `${path}.maxLength`, 1, 1_000_000, issues) ?? undefined;
  const minimum = value.minimum;
  const maximum = value.maximum;
  if (minimum !== undefined && (typeof minimum !== "number" || !Number.isFinite(minimum))) {
    issues.push(`${path}.minimum must be a finite number`);
  }
  if (maximum !== undefined && (typeof maximum !== "number" || !Number.isFinite(maximum))) {
    issues.push(`${path}.maximum must be a finite number`);
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    issues.push(`${path}.minLength cannot exceed maxLength`);
  }
  if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
    issues.push(`${path}.minimum cannot exceed maximum`);
  }
  let enumValues: readonly (string | number | boolean)[] | undefined;
  if (value.enum !== undefined) {
    if (
      !Array.isArray(value.enum)
      || value.enum.length < 1
      || value.enum.length > 256
      || value.enum.some((candidate) => typeof candidate !== type)
    ) {
      issues.push(`${path}.enum must contain 1-256 values matching the field type`);
    } else {
      enumValues = value.enum as readonly (string | number | boolean)[];
    }
  }
  const format = value.format;
  if (format !== undefined && ((format !== "url" && format !== "path-segment") || type !== "string")) {
    issues.push(`${path}.format supports url or path-segment on string fields`);
  }
  let urlPathPrefixes: readonly string[] | undefined;
  if (value.urlPathPrefixes !== undefined) {
    if (format !== "url" || type !== "string" || !Array.isArray(value.urlPathPrefixes) || value.urlPathPrefixes.length < 1 || value.urlPathPrefixes.length > 20) {
      issues.push(`${path}.urlPathPrefixes requires a url string field and 1-20 origin-relative prefixes`);
    } else {
      const parsed: string[] = [];
      for (const [index, candidate] of value.urlPathPrefixes.entries()) {
        const prefix = boundedString(candidate, `${path}.urlPathPrefixes[${index}]`, issues, 1, 2_048);
        if (prefix === null || !prefix.startsWith("/") || prefix.startsWith("//") || hasAmbiguousPathSyntax(prefix) || prefix.includes("?") || prefix.includes("#")) {
          issues.push(`${path}.urlPathPrefixes[${index}] must be an origin-relative path prefix`);
        } else if (!parsed.includes(prefix)) parsed.push(prefix);
      }
      if (parsed.length > 0) urlPathPrefixes = parsed;
    }
  }
  return {
    type,
    description,
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(typeof minimum !== "number" ? {} : { minimum }),
    ...(typeof maximum !== "number" ? {} : { maximum }),
    ...(enumValues === undefined ? {} : { enum: enumValues }),
    ...(format !== "url" && format !== "path-segment" ? {} : { format }),
    ...(urlPathPrefixes === undefined ? {} : { urlPathPrefixes }),
  };
}

function parseInputSchema(
  value: unknown,
  path: string,
  issues: string[],
  maximumArrayItems: 25 | 100,
): InputSchema | null {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return null;
  }
  exactKeys(value, ["properties", "required"], path, issues);
  if (!isRecord(value.properties) || Object.keys(value.properties).length > 100) {
    issues.push(`${path}.properties must be an object with at most 100 fields`);
    return null;
  }
  const properties: Record<string, InputField> = {};
  for (const [name, field] of Object.entries(value.properties)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name)) {
      issues.push(`${path}.properties.${name} has an invalid field name`);
      continue;
    }
    const parsed = parseField(field, `${path}.properties.${name}`, issues, maximumArrayItems);
    if (parsed !== null) properties[name] = parsed;
  }
  if (!Array.isArray(value.required) || value.required.length > 100 || value.required.some((name) => typeof name !== "string")) {
    issues.push(`${path}.required must be an array of at most 100 field names`);
    return null;
  }
  const required = [...new Set(value.required as string[])];
  for (const name of required) {
    if (!(name in properties)) issues.push(`${path}.required references unknown field ${name}`);
  }
  return { properties, required };
}

function parseLocator(value: unknown, path: string, issues: string[]): SemanticLocator | null {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return null;
  }
  exactKeys(value, ["by", "value", "name", "exact"], path, issues);
  const by = value.by;
  const supported = ["role", "text", "label", "placeholder", "alt", "title", "testid"];
  if (typeof by !== "string" || !supported.includes(by)) {
    issues.push(`${path}.by must be a supported semantic locator`);
    return null;
  }
  const locatorValue = boundedString(value.value, `${path}.value`, issues, 1, 1_000);
  if (locatorValue === null) return null;
  if (value.exact !== undefined && typeof value.exact !== "boolean") issues.push(`${path}.exact must be boolean`);
  if (by === "role") {
    const name = value.name === undefined ? undefined : boundedString(value.name, `${path}.name`, issues, 1, 1_000) ?? undefined;
    return { by, value: locatorValue, ...(name === undefined ? {} : { name }), ...(value.exact === true ? { exact: true } : {}) };
  }
  if (value.name !== undefined) issues.push(`${path}.name is valid only for role locators`);
  if (by === "text" || by === "label" || by === "placeholder" || by === "alt" || by === "title" || by === "testid") {
    return { by, value: locatorValue, ...(value.exact === true ? { exact: true } : {}) };
  }
  return null;
}

function exactReferenceLocator(
  value: unknown,
  path: string,
  issues: string[],
  requiredRole?: string,
): ExactSemanticReferenceLocator | null {
  const locator = parseLocator(value, path, issues);
  if (
    locator === null
    || locator.by !== "role"
    || locator.name === undefined
    || locator.exact !== true
    || (requiredRole !== undefined && locator.value !== requiredRole)
  ) {
    issues.push(`${path} must be one exact named${requiredRole === undefined ? "" : ` ${requiredRole}`} role resolved from a semantic snapshot`);
    return null;
  }
  return { by: "role", value: locator.value, name: locator.name, exact: true };
}

function parseValueSource(
  value: unknown,
  path: string,
  fields: Readonly<Record<string, InputField>>,
  required: ReadonlySet<string>,
  allowItem: boolean,
  issues: string[],
): BrowserValueSource | null {
  if (!isRecord(value)) {
    issues.push(`${path} must be { input: field }${allowItem ? " or { item: true }" : ""}`);
    return null;
  }
  if (Object.hasOwn(value, "input")) {
    exactKeys(value, ["input"], path, issues);
    const input = boundedString(value.input, `${path}.input`, issues, 1, 64);
    if (input === null || !(input in fields)) {
      issues.push(`${path}.input must name a declared input field`);
      return null;
    }
    if (!required.has(input)) issues.push(`${path}.input must name a required input field`);
    return { input };
  }
  exactKeys(value, ["item"], path, issues);
  if (!allowItem || value.item !== true) {
    issues.push(`${path} may reference the current item only inside for-each`);
    return null;
  }
  return { item: true };
}

function parseEffect(value: unknown, path: string, issues: string[]): BrowserStepEffect | null {
  if (!isRecord(value)) {
    issues.push(`${path} must be an explicit prepare or dispatch effect`);
    return null;
  }
  if (value.kind === "prepare") {
    exactKeys(value, ["kind", "description"], path, issues);
    const description = boundedString(value.description, `${path}.description`, issues, 1, 500);
    return description === null ? null : { kind: "prepare", description };
  }
  if (value.kind === "dispatch") {
    exactKeys(value, ["kind", "id", "description"], path, issues);
    const id = boundedString(value.id, `${path}.id`, issues, 1, 64);
    if (id !== null && !/^[a-z][a-z0-9-]*$/u.test(id)) issues.push(`${path}.id must be lowercase kebab-case`);
    const description = boundedString(value.description, `${path}.description`, issues, 1, 500);
    return id === null || description === null ? null : { kind: "dispatch", id, description };
  }
  issues.push(`${path}.kind must be prepare or dispatch`);
  return null;
}

function validateTemplate(
  value: string,
  path: string,
  fields: Readonly<Record<string, InputField>>,
  required: ReadonlySet<string>,
  issues: string[],
  allowItem = false,
): void {
  const seen = new Set<string>();
  for (const match of value.matchAll(/\$\{input\.([a-z][a-z0-9_]*)\}/gu)) {
    const key = match[1];
    if (key !== undefined) seen.add(key);
  }
  const stripped = value
    .replace(/\$\{input\.[a-z][a-z0-9_]*\}/gu, "")
    .replace(/\$\{item\}/gu, "");
  if (stripped.includes("${")) issues.push(`${path} contains a malformed input placeholder`);
  const itemPlaceholder = "$" + "{item}";
  if (!allowItem && value.includes(itemPlaceholder)) issues.push(`${path} may use ${itemPlaceholder} only inside for-each`);
  for (const key of seen) {
    if (!(key in fields)) issues.push(`${path} references unknown input.${key}`);
    else if (!required.has(key)) issues.push(`${path} references optional input.${key}; recipe-bound inputs must be required`);
    else if (fields[key]?.type === "file" || fields[key]?.type === "array") {
      issues.push(`${path} may interpolate only a scalar input.${key}`);
    }
  }
}

function parseStep(
  value: unknown,
  path: string,
  fields: Readonly<Record<string, InputField>>,
  required: ReadonlySet<string>,
  issues: string[],
  schemaVersion: 1 | 2,
  allowItem = false,
  depth = 0,
  itemField?: ScalarInputField | FileInputField,
): BrowserRecipeStep | null {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return null;
  }
  const kind = value.kind;
  if (typeof kind !== "string") {
    issues.push(`${path}.kind must be a string`);
    return null;
  }
  if (kind === "navigate") {
    exactKeys(value, ["kind", "path", "query"], path, issues);
    const targetPath = boundedString(value.path, `${path}.path`, issues, 1, 4_096);
    if (targetPath === null || !targetPath.startsWith("/") || targetPath.startsWith("//") || hasAmbiguousPathSyntax(targetPath)) {
      issues.push(`${path}.path must be an origin-relative path`);
      return null;
    }
    validateTemplate(targetPath, `${path}.path`, fields, required, issues, allowItem && itemField?.type !== "file");
    for (const match of targetPath.matchAll(/\$\{input\.([a-z][a-z0-9_]*)\}/gu)) {
      const key = match[1];
      const field = key === undefined ? undefined : fields[key];
      if (key !== undefined && (field?.type !== "string" || field.format !== "path-segment")) {
        issues.push(`${path}.path input.${key} must declare format path-segment`);
      }
    }
    if (targetPath.includes("$" + "{item}") && (itemField?.type !== "string" || itemField.format !== "path-segment")) {
      issues.push(`${path}.path item must declare string format path-segment`);
    }
    let query: Record<string, string> | undefined;
    if (value.query !== undefined) {
      if (!isRecord(value.query) || Object.keys(value.query).length > 50) {
        issues.push(`${path}.query must be an object with at most 50 entries`);
      } else {
        query = {};
        for (const [key, input] of Object.entries(value.query)) {
          if (!/^[A-Za-z0-9_.~-]{1,128}$/u.test(key) || typeof input !== "string" || !(input in fields)) {
            issues.push(`${path}.query.${key} must name a declared input field`);
          } else if (!required.has(input)) {
            issues.push(`${path}.query.${key} must name a required input field`);
          } else if (fields[input]?.type === "file" || fields[input]?.type === "array") {
            issues.push(`${path}.query.${key} must name a scalar input field`);
          } else query[key] = input;
        }
      }
    }
    return { kind, path: targetPath, ...(query === undefined ? {} : { query }) };
  }
  if (kind === "navigate-input") {
    exactKeys(value, ["kind", "input"], path, issues);
    const input = boundedString(value.input, `${path}.input`, issues, 1, 64);
    const field = input === null ? undefined : fields[input];
    if (input === null || field?.type !== "string" || field.format !== "url" || !required.has(input)) {
      issues.push(`${path}.input must name a required declared url field`);
      return null;
    }
    return { kind, input };
  }
  if (kind === "find") {
    exactKeys(value, schemaVersion === 1
      ? ["kind", "locator", "action", "with", "dispatch"]
      : ["kind", "locator", "action", "with", "effect"], path, issues);
    const locator = parseLocator(value.locator, `${path}.locator`, issues);
    const action = value.action;
    const actions = schemaVersion === 1
      ? ["click", "fill", "type", "hover"]
      : ["click", "fill", "type", "hover", "upload", "select", "check", "uncheck"];
    if (typeof action !== "string" || !actions.includes(action)) {
      issues.push(`${path}.action must be ${actions.join(", ")}`);
      return null;
    }
    const needsValue = action === "fill" || action === "type" || action === "upload" || action === "select";
    let withValue: string | BrowserValueSource | undefined;
    if (needsValue) {
      if (schemaVersion === 1) {
        if (typeof value.with !== "string" || !(value.with in fields)) {
          issues.push(`${path}.with must name a declared input for ${action}`);
          return null;
        }
        if (!required.has(value.with)) issues.push(`${path}.with must name a required input`);
        withValue = value.with;
      } else {
        const parsed = parseValueSource(value.with, `${path}.with`, fields, required, allowItem, issues);
        if (parsed === null) return null;
        withValue = parsed;
        const field = "input" in parsed ? fields[parsed.input] : itemField;
        const isFileSource = field?.type === "file" || (field?.type === "array" && field.items.type === "file");
        const isArraySource = field?.type === "array";
        if (action === "upload" && !isFileSource) {
          issues.push(`${path}.with must reference a file or file array input for upload`);
        }
        if (action !== "upload" && isFileSource) {
          issues.push(`${path}.with cannot expose a file input to ${action}`);
        }
        if ((action === "fill" || action === "type") && isArraySource) {
          issues.push(`${path}.with must reference one scalar input for ${action}`);
        }
      }
    } else if (value.with !== undefined) issues.push(`${path}.with is valid only for fill, type, upload, or select`);
    let effect: BrowserStepEffect | undefined;
    if (schemaVersion === 2) {
      effect = parseEffect(value.effect, `${path}.effect`, issues) ?? undefined;
      if (value.dispatch !== undefined) issues.push(`${path}.dispatch is v1-only; use an explicit effect`);
      if (action === "upload" && effect?.kind !== "dispatch") {
        issues.push(`${path}.effect must mark upload as dispatch because selecting a file may transfer bytes immediately`);
      }
    } else {
      if (value.dispatch !== undefined && typeof value.dispatch !== "boolean") issues.push(`${path}.dispatch must be boolean`);
      if (value.dispatch === true && action !== "click") issues.push(`${path}.dispatch is valid only for click; use a marked press step for keyboard dispatch`);
    }
    if ((action === "upload" || action === "select" || action === "check" || action === "uncheck")) {
      const exact = exactReferenceLocator(value.locator, `${path}.locator`, issues);
      if (exact === null) return null;
    }
    if (locator === null) return null;
    validateTemplate(locator.value, `${path}.locator.value`, fields, required, issues, allowItem && itemField?.type !== "file");
    if (locator.by === "role" && locator.name !== undefined) {
      validateTemplate(locator.name, `${path}.locator.name`, fields, required, issues, allowItem && itemField?.type !== "file");
    }
    return {
      kind,
      locator,
      action: action as Extract<BrowserRecipeStep, { kind: "find" }>["action"],
      ...(withValue === undefined ? {} : { with: withValue }),
      ...(effect === undefined ? {} : { effect }),
      ...(schemaVersion === 1 && value.dispatch === true ? { dispatch: true } : {}),
    };
  }
  if (kind === "press") {
    exactKeys(value, schemaVersion === 1 ? ["kind", "key", "dispatch"] : ["kind", "key", "effect"], path, issues);
    const key = boundedString(value.key, `${path}.key`, issues, 1, 100);
    if (schemaVersion === 1) {
      if (value.dispatch !== undefined && typeof value.dispatch !== "boolean") issues.push(`${path}.dispatch must be boolean`);
      return key === null ? null : { kind, key, ...(value.dispatch === true ? { dispatch: true } : {}) };
    }
    const effect = parseEffect(value.effect, `${path}.effect`, issues);
    return key === null || effect === null ? null : { kind, key, effect };
  }
  if (kind === "wait") {
    exactKeys(value, ["kind", "milliseconds"], path, issues);
    const milliseconds = safeInteger(value.milliseconds, `${path}.milliseconds`, 1, 30_000, issues);
    return milliseconds === null ? null : { kind, milliseconds };
  }
  if (kind === "wait-text" || kind === "assert-text") {
    exactKeys(value, ["kind", "text"], path, issues);
    const text = boundedString(value.text, `${path}.text`, issues, 1, 2_000);
    if (text !== null) validateTemplate(text, `${path}.text`, fields, required, issues, allowItem && itemField?.type !== "file");
    return text === null ? null : { kind, text };
  }
  if (kind === "assert-url") {
    exactKeys(value, ["kind", "pattern"], path, issues);
    const pattern = boundedString(value.pattern, `${path}.pattern`, issues, 1, 2_000);
    if (pattern !== null) validateTemplate(pattern, `${path}.pattern`, fields, required, issues, allowItem && itemField?.type !== "file");
    return pattern === null ? null : { kind, pattern };
  }
  if (kind === "assert-input-empty") {
    exactKeys(value, ["kind", "locator"], path, issues);
    const locator = exactReferenceLocator(value.locator, `${path}.locator`, issues, "textbox");
    if (locator === null) return null;
    validateTemplate(locator.name, `${path}.locator.name`, fields, required, issues, allowItem && itemField?.type !== "file");
    return { kind, locator: { ...locator, value: "textbox" } };
  }
  if (kind === "assert-value") {
    if (schemaVersion === 1) {
      issues.push(`${path}.kind is supported only in schemaVersion 2`);
      return null;
    }
    exactKeys(value, ["kind", "locator", "equals"], path, issues);
    const locator = exactReferenceLocator(value.locator, `${path}.locator`, issues);
    const equals = parseValueSource(value.equals, `${path}.equals`, fields, required, allowItem, issues);
    if (locator === null || equals === null) return null;
    const expectedField = "input" in equals ? fields[equals.input] : itemField;
    if (expectedField?.type === "file" || expectedField?.type === "array") {
      issues.push(`${path}.equals must reference one scalar value`);
    }
    validateTemplate(locator.name, `${path}.locator.name`, fields, required, issues, allowItem && itemField?.type !== "file");
    return { kind, locator, equals };
  }
  if (kind === "assert-checked") {
    if (schemaVersion === 1) {
      issues.push(`${path}.kind is supported only in schemaVersion 2`);
      return null;
    }
    exactKeys(value, ["kind", "locator", "checked"], path, issues);
    const locator = exactReferenceLocator(value.locator, `${path}.locator`, issues);
    if (typeof value.checked !== "boolean") issues.push(`${path}.checked must be boolean`);
    if (locator === null || typeof value.checked !== "boolean") return null;
    validateTemplate(locator.name, `${path}.locator.name`, fields, required, issues, allowItem && itemField?.type !== "file");
    return { kind, locator, checked: value.checked };
  }
  if (kind === "verify-dispatch") {
    if (schemaVersion === 1) {
      issues.push(`${path}.kind is supported only in schemaVersion 2`);
      return null;
    }
    exactKeys(value, ["kind", "dispatch", "assertions"], path, issues);
    const dispatch = boundedString(value.dispatch, `${path}.dispatch`, issues, 1, 64);
    if (dispatch !== null && !/^[a-z][a-z0-9-]*$/u.test(dispatch)) issues.push(`${path}.dispatch must be lowercase kebab-case`);
    const assertions: BrowserAssertion[] = [];
    if (!Array.isArray(value.assertions) || value.assertions.length < 1 || value.assertions.length > 10) {
      issues.push(`${path}.assertions must contain 1-10 bounded observations`);
    } else {
      value.assertions.forEach((assertion, index) => {
        const parsed = parseStep(assertion, `${path}.assertions[${index}]`, fields, required, issues, 2, allowItem, depth + 1, itemField);
        if (
          parsed !== null
          && (parsed.kind === "assert-text"
            || parsed.kind === "assert-url"
            || parsed.kind === "assert-input-empty"
            || parsed.kind === "assert-value"
            || parsed.kind === "assert-checked")
        ) assertions.push(parsed);
        else if (parsed !== null) issues.push(`${path}.assertions[${index}] must be an assertion`);
      });
    }
    return dispatch === null || assertions.length === 0 ? null : { kind, dispatch, assertions };
  }
  if (kind === "for-each") {
    if (schemaVersion === 1) {
      issues.push(`${path}.kind is supported only in schemaVersion 2`);
      return null;
    }
    exactKeys(value, ["kind", "input", "steps", "between"], path, issues);
    const input = boundedString(value.input, `${path}.input`, issues, 1, 64);
    const field = input === null ? undefined : fields[input];
    if (input === null || field?.type !== "array" || !required.has(input)) {
      issues.push(`${path}.input must name a required bounded array input`);
    }
    if (depth > 0) issues.push(`${path} cannot nest for-each`);
    const steps: BrowserRecipeStep[] = [];
    if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 50) {
      issues.push(`${path}.steps must contain 1-50 steps`);
    } else {
      value.steps.forEach((step, index) => {
        const parsed = parseStep(step, `${path}.steps[${index}]`, fields, required, issues, 2, true, depth + 1, field?.type === "array" ? field.items : undefined);
        if (parsed !== null) steps.push(parsed);
      });
    }
    let between: BrowserRecipeStep[] | undefined;
    if (value.between !== undefined) {
      if (!Array.isArray(value.between) || value.between.length > 20) {
        issues.push(`${path}.between must contain at most 20 steps`);
      } else {
        between = [];
        value.between.forEach((step, index) => {
          const parsed = parseStep(step, `${path}.between[${index}]`, fields, required, issues, 2, true, depth + 1, field?.type === "array" ? field.items : undefined);
          if (parsed !== null) between?.push(parsed);
        });
      }
    }
    if (input === null || field?.type !== "array" || steps.length === 0) return null;
    return { kind, input, steps, ...(between === undefined ? {} : { between }) };
  }
  if (kind === "snapshot") {
    exactKeys(value, ["kind", "interactive"], path, issues);
    if (value.interactive !== undefined && typeof value.interactive !== "boolean") {
      issues.push(`${path}.interactive must be boolean`);
    }
    return { kind, ...(value.interactive === true ? { interactive: true } : {}) };
  }
  if (kind === "read") {
    exactKeys(value, ["kind"], path, issues);
    return { kind };
  }
  issues.push(`${path}.kind is not supported`);
  return null;
}

function dispatchEffect(step: BrowserRecipeStep): Extract<BrowserStepEffect, { kind: "dispatch" }> | null {
  return (step.kind === "find" || step.kind === "press") && step.effect?.kind === "dispatch"
    ? step.effect
    : null;
}

function validateV2Flow(
  steps: readonly BrowserRecipeStep[],
  path: string,
  fields: Readonly<Record<string, InputField>>,
  issues: string[],
  seenIds: Set<string>,
): number {
  let openDispatch: string | null = null;
  let maximumDispatches = 0;
  for (const [index, step] of steps.entries()) {
    const stepPath = `${path}[${index}]`;
    if (step.kind === "for-each") {
      if (openDispatch !== null) issues.push(`${stepPath} cannot begin before dispatch ${openDispatch} is verified`);
      const innerIds = new Set<string>();
      const innerCount = validateV2Flow(step.steps, `${stepPath}.steps`, fields, issues, innerIds);
      const field = fields[step.input];
      const repetitions = field?.type === "array" ? field.maxItems : 0;
      maximumDispatches += innerCount * repetitions;
      for (const id of innerIds) {
        if (seenIds.has(id)) issues.push(`${stepPath} reuses dispatch id ${id}`);
        seenIds.add(id);
      }
      if (step.between !== undefined) {
        const betweenIds = new Set<string>();
        const betweenCount = validateV2Flow(step.between, `${stepPath}.between`, fields, issues, betweenIds);
        if (betweenCount > 0) issues.push(`${stepPath}.between cannot dispatch; place dispatches in the repeated steps`);
      }
      continue;
    }
    const dispatch = dispatchEffect(step);
    if (dispatch !== null) {
      if (openDispatch !== null) issues.push(`${stepPath} cannot start dispatch ${dispatch.id} before ${openDispatch} is verified`);
      if (seenIds.has(dispatch.id)) issues.push(`${stepPath} reuses dispatch id ${dispatch.id}`);
      seenIds.add(dispatch.id);
      openDispatch = dispatch.id;
      maximumDispatches += 1;
      continue;
    }
    if (step.kind === "verify-dispatch") {
      if (openDispatch === null) issues.push(`${stepPath} verifies ${step.dispatch} without a started dispatch`);
      else if (step.dispatch !== openDispatch) issues.push(`${stepPath} must verify active dispatch ${openDispatch}`);
      else openDispatch = null;
      continue;
    }
    if (
      openDispatch !== null
      && (step.kind === "find" || step.kind === "press" || step.kind === "navigate" || step.kind === "navigate-input")
    ) issues.push(`${stepPath} cannot interact before dispatch ${openDispatch} is verified`);
    if (
      openDispatch !== null
      && (
      step.kind === "assert-text"
      || step.kind === "assert-url"
      || step.kind === "assert-input-empty"
      || step.kind === "assert-value"
      || step.kind === "assert-checked"
      )
    ) issues.push(`${stepPath} must be nested in verify-dispatch in schemaVersion 2`);
  }
  if (openDispatch !== null) issues.push(`${path} leaves dispatch ${openDispatch} without a verify-dispatch group`);
  return maximumDispatches;
}

function maximumExpandedStepCount(
  steps: readonly BrowserRecipeStep[],
  fields: Readonly<Record<string, InputField>>,
): number {
  let total = 0;
  for (const step of steps) {
    if (step.kind !== "for-each") {
      total += 1;
      continue;
    }
    const field = fields[step.input];
    const repetitions = field?.type === "array" ? field.maxItems : 0;
    total += repetitions * maximumExpandedStepCount(step.steps, fields);
    total += Math.max(0, repetitions - 1) * maximumExpandedStepCount(step.between ?? [], fields);
  }
  return total;
}

function minimumExpandedDispatchCount(
  steps: readonly BrowserRecipeStep[],
  fields: Readonly<Record<string, InputField>>,
): number {
  let total = 0;
  for (const step of steps) {
    if (step.kind === "for-each") {
      const field = fields[step.input];
      const repetitions = field?.type === "array" ? field.minItems : 0;
      total += repetitions * minimumExpandedDispatchCount(step.steps, fields);
      continue;
    }
    if (dispatchEffect(step) !== null) total += 1;
  }
  return total;
}

function containsInteraction(steps: readonly BrowserRecipeStep[]): boolean {
  return steps.some((step) =>
    step.kind === "press"
    || step.kind === "find"
    || (step.kind === "for-each" && (containsInteraction(step.steps) || containsInteraction(step.between ?? []))));
}

function parseOperation(
  value: unknown,
  path: string,
  issues: string[],
  schemaVersion: 1 | 2 | 3 | 4 | 5,
  allowedOrigins: readonly string[],
): WrenchOperation | null {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return null;
  }
  exactKeys(
    value,
    [
      "description",
      "risk",
      "sideEffect",
      "idempotency",
      "dedupeWindowMs",
      "input",
      "browser",
      ...(schemaVersion === 3 ? ["provider"] : []),
      ...(schemaVersion === 4 ? ["webSession"] : []),
      ...(schemaVersion === 5 ? ["reviewedTemplate"] : []),
    ],
    path,
    issues,
  );
  const description = boundedString(value.description, `${path}.description`, issues, 1, 500);
  const sideEffect = boundedString(value.sideEffect, `${path}.sideEffect`, issues, 1, 500);
  const risk = value.risk;
  if (typeof risk !== "string" || !operationRisks.includes(risk as OperationRisk)) issues.push(`${path}.risk must be R1, R2, R3, or R4`);
  const idempotency = value.idempotency;
  if (typeof idempotency !== "string" || !idempotencyKinds.includes(idempotency as IdempotencyKind)) {
    issues.push(`${path}.idempotency is not supported`);
  }
  const dedupeWindowMs = safeInteger(value.dedupeWindowMs, `${path}.dedupeWindowMs`, 0, 30 * 24 * 60 * 60_000, issues);
  const input = parseInputSchema(
    value.input,
    `${path}.input`,
    issues,
    schemaVersion === WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION && value.provider !== undefined ? 100 : 25,
  );
  if (schemaVersion === 1 && input !== null && Object.values(input.properties).some((field) => field.type === "file" || field.type === "array")) {
    issues.push(`${path}.input file and array fields require schemaVersion 2`);
  }
  if (
    risk === "R1"
    && input !== null
    && Object.values(input.properties).some((field) =>
      field.type === "file" || (field.type === "array" && field.items.type === "file"))
  ) {
    issues.push(`${path}.input file fields require a confirmed R2/R3 upload workflow`);
  }
  if ((risk === "R2" || risk === "R3") && idempotency === "none") {
    issues.push(`${path} mutates remote state and must declare local-at-most-once dispatch`);
  }
  if ((risk === "R2" || risk === "R3") && (dedupeWindowMs === null || dedupeWindowMs < 60_000)) {
    issues.push(`${path} mutates remote state and needs a dedupeWindowMs of at least 60000`);
  }
  if (risk === "R1" && dedupeWindowMs !== 0) issues.push(`${path} is R1 and must use dedupeWindowMs 0`);
  if (risk === "R1" && sideEffect !== "none") issues.push(`${path} is R1 and must declare sideEffect as none`);

  if (schemaVersion === 3 && value.browser !== undefined && value.provider !== undefined) {
    issues.push(`${path} must declare exactly one of browser or provider`);
  }
  if (schemaVersion === 3 && value.browser === undefined && value.provider === undefined) {
    issues.push(`${path} must declare exactly one of browser or provider`);
    return null;
  }
  if (schemaVersion === 4) {
    const transports = [value.browser, value.provider, value.webSession].filter((candidate) => candidate !== undefined);
    if (transports.length !== 1 || value.webSession === undefined) {
      issues.push(`${path} must declare exactly one webSession transport in schemaVersion 4`);
      return null;
    }
  }
  if (schemaVersion === 5) {
    const transports = [value.browser, value.provider, value.webSession, value.reviewedTemplate]
      .filter((candidate) => candidate !== undefined);
    if (transports.length !== 1 || value.reviewedTemplate === undefined) {
      issues.push(`${path} must declare exactly one reviewedTemplate transport in schemaVersion 5`);
      return null;
    }
  }

  if (schemaVersion === 3 && value.provider !== undefined) {
    if (!isRecord(value.provider)) {
      issues.push(`${path}.provider must be an object`);
      return null;
    }
    exactKeys(value.provider, ["provider", "action", "contractVersion", "timeoutMs", "maxOutputBytes"], `${path}.provider`, issues);
    const provider = value.provider.provider;
    if (!isProviderPluginSurfaceId(provider)) {
      issues.push(`${path}.provider.provider must be a bounded lowercase kebab-case provider surface ID`);
    }
    const action = value.provider.action;
    if (!isProviderPluginOperationName(action)) {
      issues.push(`${path}.provider.action must name a bounded dotted provider operation`);
    }
    const contractVersion = safeInteger(value.provider.contractVersion, `${path}.provider.contractVersion`, 1, 1_000_000, issues);
    const timeoutMs = safeInteger(value.provider.timeoutMs, `${path}.provider.timeoutMs`, 1_000, 10 * 60_000, issues);
    const maxOutputBytes = safeInteger(value.provider.maxOutputBytes, `${path}.provider.maxOutputBytes`, 1_024, 10 * 1024 * 1024, issues);
    if (
      description === null
      || sideEffect === null
      || typeof risk !== "string"
      || !operationRisks.includes(risk as OperationRisk)
      || typeof idempotency !== "string"
      || !idempotencyKinds.includes(idempotency as IdempotencyKind)
      || input === null
      || dedupeWindowMs === null
      || !isProviderPluginSurfaceId(provider)
      || !isProviderPluginOperationName(action)
      || contractVersion === null
      || timeoutMs === null
      || maxOutputBytes === null
    ) return null;
    return {
      description,
      risk: risk as OperationRisk,
      sideEffect,
      idempotency: idempotency as IdempotencyKind,
      dedupeWindowMs,
      input,
      provider: {
        provider,
        action,
        contractVersion,
        timeoutMs,
        maxOutputBytes,
      },
    };
  }

  if (schemaVersion === 4 && value.webSession !== undefined) {
    if (!isRecord(value.webSession)) {
      issues.push(`${path}.webSession must be an object`);
      return null;
    }
    exactKeys(value.webSession, ["site", "action", "contractVersion", "timeoutMs", "maxOutputBytes"], `${path}.webSession`, issues);
    const site = value.webSession.site;
    if (!isProviderPluginSurfaceId(site)) {
      issues.push(`${path}.webSession.site must be a bounded lowercase kebab-case provider surface ID`);
    }
    const action = value.webSession.action;
    if (!isProviderPluginOperationName(action)) {
      issues.push(`${path}.webSession.action must name a bounded dotted provider operation`);
    }
    const contractVersion = safeInteger(value.webSession.contractVersion, `${path}.webSession.contractVersion`, 1, 1_000_000, issues);
    const timeoutMs = safeInteger(value.webSession.timeoutMs, `${path}.webSession.timeoutMs`, 1_000, 10 * 60_000, issues);
    const maxOutputBytes = safeInteger(value.webSession.maxOutputBytes, `${path}.webSession.maxOutputBytes`, 1_024, 10 * 1024 * 1024, issues);
    if (
      description === null
      || sideEffect === null
      || typeof risk !== "string"
      || !operationRisks.includes(risk as OperationRisk)
      || typeof idempotency !== "string"
      || !idempotencyKinds.includes(idempotency as IdempotencyKind)
      || input === null
      || dedupeWindowMs === null
      || !isProviderPluginSurfaceId(site)
      || !isProviderPluginOperationName(action)
      || contractVersion === null
      || timeoutMs === null
      || maxOutputBytes === null
    ) return null;
    return {
      description,
      risk: risk as OperationRisk,
      sideEffect,
      idempotency: idempotency as IdempotencyKind,
      dedupeWindowMs,
      input,
      webSession: {
        site,
        action,
        contractVersion,
        timeoutMs,
        maxOutputBytes,
      },
    };
  }

  if (schemaVersion === 5 && value.reviewedTemplate !== undefined) {
    if (!isRecord(value.reviewedTemplate)) {
      issues.push(`${path}.reviewedTemplate must be an object`);
      return null;
    }
    const state = value.reviewedTemplate.state;
    const contractVersion = value.reviewedTemplate.contractVersion;
    if (contractVersion !== 1) issues.push(`${path}.reviewedTemplate.contractVersion must be 1`);
    if (state === "capture-required") {
      exactKeys(value.reviewedTemplate, ["state", "contractVersion", "instructions"], `${path}.reviewedTemplate`, issues);
      const instructions = boundedString(
        value.reviewedTemplate.instructions,
        `${path}.reviewedTemplate.instructions`,
        issues,
        1,
        2_000,
      );
      if (
        description === null
        || sideEffect === null
        || typeof risk !== "string"
        || !operationRisks.includes(risk as OperationRisk)
        || typeof idempotency !== "string"
        || !idempotencyKinds.includes(idempotency as IdempotencyKind)
        || input === null
        || dedupeWindowMs === null
        || contractVersion !== 1
        || instructions === null
      ) return null;
      return {
        description,
        risk: risk as OperationRisk,
        sideEffect,
        idempotency: idempotency as IdempotencyKind,
        dedupeWindowMs,
        input,
        reviewedTemplate: { state: "capture-required", contractVersion: 1, instructions },
      };
    }
    if (state !== "reviewed") {
      issues.push(`${path}.reviewedTemplate.state must be capture-required or reviewed`);
      return null;
    }
    issues.push(
      `${path}.reviewedTemplate.state reviewed requires reviewed-template contractVersion 2 with a current-account identity preflight; keep schemaVersion 5 operations capture-required`,
    );
    exactKeys(
      value.reviewedTemplate,
      ["state", "contractVersion", "reviewedAt", "evidenceSha256", "timeoutMs", "template"],
      `${path}.reviewedTemplate`,
      issues,
    );
    const reviewedAt = boundedString(value.reviewedTemplate.reviewedAt, `${path}.reviewedTemplate.reviewedAt`, issues, 20, 40);
    if (
      reviewedAt !== null
      && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(reviewedAt)
        || !Number.isFinite(Date.parse(reviewedAt)))
    ) issues.push(`${path}.reviewedTemplate.reviewedAt must be an exact UTC ISO-8601 instant`);
    const evidenceSha256 = value.reviewedTemplate.evidenceSha256;
    if (typeof evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(evidenceSha256)) {
      issues.push(`${path}.reviewedTemplate.evidenceSha256 must be one lowercase SHA-256 digest`);
    }
    const timeoutMs = safeInteger(
      value.reviewedTemplate.timeoutMs,
      `${path}.reviewedTemplate.timeoutMs`,
      1_000,
      10 * 60_000,
      issues,
    );
    const parsedTemplate = input === null
      ? null
      : parseWebSessionTemplate(value.reviewedTemplate.template, { input, allowedOrigins });
    if (parsedTemplate !== null && !parsedTemplate.ok) {
      for (const issue of parsedTemplate.issues) {
        issues.push(issue === "$"
          ? `${path}.reviewedTemplate.template is invalid`
          : `${path}.reviewedTemplate.template${issue.startsWith("$") ? issue.slice(1) : `: ${issue}`}`);
      }
    }
    const template = parsedTemplate?.ok === true ? parsedTemplate.value : null;
    if (
      (risk === "R2" || risk === "R3")
      && template !== null
      && template.response.variants.some((variant) =>
        variant.body.kind === "discard"
        || (variant.body.kind === "json" && variant.body.bindings.length < 1))
    ) {
      issues.push(`${path}.reviewedTemplate.template write responses must be empty or include at least one exact target binding`);
    }
    if (
      description === null
      || sideEffect === null
      || typeof risk !== "string"
      || !operationRisks.includes(risk as OperationRisk)
      || typeof idempotency !== "string"
      || !idempotencyKinds.includes(idempotency as IdempotencyKind)
      || input === null
      || dedupeWindowMs === null
      || contractVersion !== 1
      || reviewedAt === null
      || typeof evidenceSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(evidenceSha256)
      || timeoutMs === null
      || template === null
    ) return null;
    return {
      description,
      risk: risk as OperationRisk,
      sideEffect,
      idempotency: idempotency as IdempotencyKind,
      dedupeWindowMs,
      input,
      reviewedTemplate: {
        state: "reviewed",
        contractVersion: 1,
        reviewedAt,
        evidenceSha256,
        timeoutMs,
        template,
      },
    };
  }

  if (!isRecord(value.browser)) {
    issues.push(`${path}.browser must be an object`);
    return null;
  }
  const browserSchemaVersion: 1 | 2 = schemaVersion === 1 ? 1 : 2;
  exactKeys(value.browser, ["steps", "timeoutMs", "maxOutputBytes"], `${path}.browser`, issues);
  const timeoutMs = safeInteger(value.browser.timeoutMs, `${path}.browser.timeoutMs`, 1_000, 10 * 60_000, issues);
  const maxOutputBytes = safeInteger(value.browser.maxOutputBytes, `${path}.browser.maxOutputBytes`, 1_024, 10 * 1024 * 1024, issues);
  const steps: BrowserRecipeStep[] = [];
  if (!Array.isArray(value.browser.steps) || value.browser.steps.length < 1 || value.browser.steps.length > 100) {
    issues.push(`${path}.browser.steps must contain 1-100 steps`);
  } else if (input !== null) {
    const required = new Set(input.required);
    value.browser.steps.forEach((step, index) => {
      const parsed = parseStep(step, `${path}.browser.steps[${index}]`, input.properties, required, issues, browserSchemaVersion);
      if (parsed !== null) steps.push(parsed);
    });
  }
  if (steps[0]?.kind !== "navigate" && steps[0]?.kind !== "navigate-input") {
    issues.push(`${path}.browser.steps must begin with a declared-origin navigation`);
  }
  if (schemaVersion === 1) {
    const finalStep = steps.at(-1);
    if (
      (risk === "R2" || risk === "R3")
      && finalStep?.kind !== "assert-text"
      && finalStep?.kind !== "assert-url"
      && finalStep?.kind !== "assert-input-empty"
    ) issues.push(`${path} mutates remote state and must end with an observable postcondition`);
    const dispatchSteps = steps.filter((step) => (step.kind === "find" || step.kind === "press") && step.dispatch === true);
    if ((risk === "R2" || risk === "R3") && dispatchSteps.length !== 1) {
      issues.push(`${path} mutates remote state and must mark exactly one dispatch step`);
    }
    if (risk === "R1" && dispatchSteps.length > 0) issues.push(`${path} is R1 and cannot mark a dispatch step`);
    if (risk === "R2" || risk === "R3") {
      const dispatchIndex = steps.findIndex((step) => (step.kind === "find" || step.kind === "press") && step.dispatch === true);
      if (dispatchIndex >= steps.length - 1) issues.push(`${path} dispatch must precede its final postcondition`);
      if (
        dispatchIndex >= 0
        && steps.slice(dispatchIndex + 1).some((step) => step.kind === "find" || step.kind === "press" || step.kind === "navigate" || step.kind === "navigate-input")
      ) issues.push(`${path} cannot interact after dispatch; only observation and postcondition steps may follow it`);
    }
    if (
      (risk === "R2" || risk === "R3")
      && steps.some((step) => (step.kind === "press" || (step.kind === "find" && step.action === "click")) && step.dispatch !== true)
    ) issues.push(`${path} cannot click or press outside its single marked dispatch step`);
  } else if (input !== null) {
    const seenIds = new Set<string>();
    const maximumDispatches = validateV2Flow(steps, `${path}.browser.steps`, input.properties, issues, seenIds);
    const minimumDispatches = minimumExpandedDispatchCount(steps, input.properties);
    const maximumSteps = maximumExpandedStepCount(steps, input.properties);
    if ((risk === "R2" || risk === "R3") && minimumDispatches < 1) {
      issues.push(`${path} mutates remote state and every valid input must schedule at least one named dispatch`);
    }
    if (maximumDispatches > 25) issues.push(`${path} can expand to at most 25 dispatches`);
    if (maximumSteps > 500) issues.push(`${path} can expand to at most 500 browser steps`);
    if (risk === "R1" && maximumDispatches > 0) issues.push(`${path} is R1 and cannot dispatch`);
  }
  if (
    risk === "R1"
    && containsInteraction(steps)
  ) {
    issues.push(`${path} is R1 and cannot click, fill, type, hover, or press; upload, select, check, and uncheck are also forbidden; split interactive flows into an explicit write capability`);
  }
  if (
    description === null
    || sideEffect === null
    || typeof risk !== "string"
    || !operationRisks.includes(risk as OperationRisk)
    || typeof idempotency !== "string"
    || !idempotencyKinds.includes(idempotency as IdempotencyKind)
    || input === null
    || dedupeWindowMs === null
    || timeoutMs === null
    || maxOutputBytes === null
  ) return null;
  return {
    description,
    risk: risk as OperationRisk,
    sideEffect,
    idempotency: idempotency as IdempotencyKind,
    dedupeWindowMs,
    input,
    browser: { steps, timeoutMs, maxOutputBytes },
  };
}

type ManifestPluginContract = {
  readonly binding: ProviderPluginBindingV1;
  readonly operation: ProviderPluginOperationV1;
};

function resolveManifestPluginContract(
  registry: ProviderPluginRegistry,
  transport: "provider-api" | "session-api",
  surfaceId: string,
  operationName: string,
  contractVersion: number,
  requireCurrent: boolean,
): ManifestPluginContract | undefined {
  const binding = transport === "provider-api"
    ? registry.resolveRoute("provider-api", surfaceId)
    : registry.resolveSessionRoute(surfaceId);
  if (
    binding === undefined
    || (transport === "provider-api"
      ? binding.transport !== "provider-api"
      : binding.transport === "provider-api")
  ) {
    return undefined;
  }
  const exact = registry.resolveOperationDefinition(
    binding.transport,
    surfaceId,
    operationName,
    contractVersion,
  );
  if (exact !== undefined) {
    return { binding: exact.binding, operation: exact.operation };
  }
  if (requireCurrent) return undefined;
  const operation = binding.operations.find((candidate) =>
    candidate.name === operationName);
  return operation === undefined ? undefined : { binding, operation };
}

function validateManifestPluginOrigins(
  binding: ProviderPluginBindingV1,
  origins: readonly string[],
  browserDomains: readonly string[],
  issues: string[],
): void {
  const expectedOrigins = [...binding.manifestOrigins].sort();
  const actualOrigins = [...origins].sort();
  if (
    expectedOrigins.length !== actualOrigins.length
    || expectedOrigins.some((origin, index) => origin !== actualOrigins[index])
  ) {
    issues.push(
      `manifest.origins must exactly match provider plugin surface ${binding.surfaceId}: ${expectedOrigins.join(", ")}`,
    );
  }
  const expectedDomains = [
    ...new Set(expectedOrigins.map((origin) =>
      new URL(origin).hostname.toLowerCase())),
  ].sort();
  const actualDomains = [...browserDomains].sort();
  if (
    expectedDomains.length !== actualDomains.length
    || expectedDomains.some((domain, index) => domain !== actualDomains[index])
  ) {
    issues.push(
      `manifest.browserDomains must exactly match provider plugin surface ${binding.surfaceId}: ${expectedDomains.join(", ")}`,
    );
  }
}

function validateManifestPluginSemantics(
  operationId: string,
  manifestOperation: ProviderWrenchOperation | WebSessionWrenchOperation,
  descriptor: ProviderPluginOperationV1,
  contractLabel: string,
  riskLabel: string,
  issues: string[],
): void {
  if (descriptor.risk !== manifestOperation.risk) {
    issues.push(
      `manifest.operations.${operationId}.risk must match ${riskLabel} risk ${descriptor.risk}`,
    );
  }
  if (canonicalJson(descriptor.input) !== canonicalJson(manifestOperation.input)) {
    issues.push(
      `manifest.operations.${operationId}.input must exactly match ${contractLabel}`,
    );
  }
  if (descriptor.sideEffect !== manifestOperation.sideEffect) {
    issues.push(
      `manifest.operations.${operationId}.sideEffect must exactly match ${contractLabel}`,
    );
  }
  if (descriptor.idempotency !== manifestOperation.idempotency) {
    issues.push(
      `manifest.operations.${operationId}.idempotency must exactly match ${contractLabel}`,
    );
  }
  if (descriptor.dedupeWindowMs !== manifestOperation.dedupeWindowMs) {
    issues.push(
      `manifest.operations.${operationId}.dedupeWindowMs must exactly match ${contractLabel}`,
    );
  }
}

function parseManifestWithContractValidation(
  value: unknown,
  requireCurrentCodeOwnedContracts: boolean,
  registry: ProviderPluginRegistry,
): ParseResult<WrenchManifest> {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["manifest must be an object"] };
  exactKeys(value, ["schemaVersion", "id", "version", "displayName", "surfaceId", "origins", "browserDomains", "operations"], "manifest", issues);
  const schemaVersion = value.schemaVersion === WRENCH_LEGACY_MANIFEST_SCHEMA_VERSION
    ? WRENCH_LEGACY_MANIFEST_SCHEMA_VERSION
    : value.schemaVersion === WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION
      ? WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION
    : value.schemaVersion === WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION
      ? WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION
    : value.schemaVersion === WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION
      ? WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION
      : WRENCH_MANIFEST_SCHEMA_VERSION;
  if (
    value.schemaVersion !== WRENCH_LEGACY_MANIFEST_SCHEMA_VERSION
    && value.schemaVersion !== WRENCH_MANIFEST_SCHEMA_VERSION
    && value.schemaVersion !== WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION
    && value.schemaVersion !== WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION
    && value.schemaVersion !== WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION
  ) {
    issues.push("manifest.schemaVersion must be 1, 2, 3, 4, or 5");
  }
  const id = boundedString(value.id, "manifest.id", issues, 1, 48);
  if (id !== null && !/^[a-z][a-z0-9-]*$/u.test(id)) issues.push("manifest.id must be lowercase kebab-case");
  const version = boundedString(value.version, "manifest.version", issues, 1, 64);
  if (version !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    issues.push("manifest.version must be a semantic version");
  }
  const displayName = boundedString(value.displayName, "manifest.displayName", issues, 1, 100);
  let surfaceId: ProviderPluginSurfaceId | undefined;
  if (value.surfaceId !== undefined) {
    if (schemaVersion === WRENCH_LEGACY_MANIFEST_SCHEMA_VERSION) {
      issues.push("manifest.surfaceId requires schemaVersion 2 or 3");
    } else if (
      schemaVersion === WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION
      || schemaVersion === WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION
    ) {
      if (!isProviderPluginSurfaceId(value.surfaceId)) {
        issues.push("manifest.surfaceId must be a bounded lowercase kebab-case provider surface ID");
      } else {
        surfaceId = value.surfaceId;
      }
    } else if (typeof value.surfaceId !== "string" || !platformSurfaceIds.includes(value.surfaceId as PlatformSurfaceId)) {
      issues.push("manifest.surfaceId must name a reviewed platform surface");
    } else {
      surfaceId = value.surfaceId;
    }
  }
  const origins: string[] = [];
  if (!Array.isArray(value.origins) || value.origins.length < 1 || value.origins.length > 20) {
    issues.push("manifest.origins must contain 1-20 exact HTTPS origins");
  } else {
    for (const [index, raw] of value.origins.entries()) {
      if (typeof raw !== "string") {
        issues.push(`manifest.origins[${index}] must be a string`);
        continue;
      }
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || url.origin !== raw || url.username !== "" || url.password !== "") {
          issues.push(`manifest.origins[${index}] must be an exact HTTPS origin without credentials or a path`);
        } else if (isPrivateHostname(url.hostname) || (isIP(url.hostname) !== 0 && isPrivateAddress(url.hostname))) {
          issues.push(`manifest.origins[${index}] cannot target a private network host`);
        } else if (!origins.includes(url.origin)) origins.push(url.origin);
      } catch {
        issues.push(`manifest.origins[${index}] must be a valid origin`);
      }
    }
  }
  const browserDomains: string[] = [];
  if (!Array.isArray(value.browserDomains) || value.browserDomains.length < 1 || value.browserDomains.length > 100) {
    issues.push("manifest.browserDomains must contain 1-100 exact or wildcard hostnames");
  } else {
    for (const [index, raw] of value.browserDomains.entries()) {
      if (typeof raw !== "string" || !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(raw) || raw.includes("..")) {
        issues.push(`manifest.browserDomains[${index}] is invalid`);
      } else if (!browserDomains.includes(raw)) browserDomains.push(raw);
    }
  }
  for (const origin of origins) {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (!browserDomains.some((pattern) => pattern === hostname || (pattern.startsWith("*.") && (hostname === pattern.slice(2) || hostname.endsWith(`.${pattern.slice(2)}`))))) {
      issues.push(`manifest.browserDomains must cover origin host ${hostname}`);
    }
  }
  const operations: Record<string, WrenchOperation> = {};
  if (!isRecord(value.operations) || Object.keys(value.operations).length > 200) {
    issues.push("manifest.operations must be an object with at most 200 operations");
  } else {
    for (const [operationId, operation] of Object.entries(value.operations)) {
      if (!isProviderPluginOperationName(operationId)) {
        issues.push(`manifest.operations.${operationId} must be a dotted semantic capability ID`);
        continue;
      }
      const parsed = parseOperation(operation, `manifest.operations.${operationId}`, issues, schemaVersion, origins);
      if (parsed !== null) operations[operationId] = parsed;
    }
  }
  const matchingKnownSurfaces = platformSurfaceIds.filter((candidate) =>
    origins.some((origin) => socialPlatformCatalog[candidate].originPolicy.exactOrigins.includes(origin as `https://${string}`)));
  if (schemaVersion === WRENCH_LEGACY_MANIFEST_SCHEMA_VERSION && matchingKnownSurfaces.length > 0) {
    const legacyLinkedIn = id === "linkedin"
      && matchingKnownSurfaces.length === 1
      && matchingKnownSurfaces[0] === "linkedin"
      && origins.every((origin) => origin === "https://www.linkedin.com")
      && Object.entries(operations).every(([operationId, operation]) =>
        (operationId === "profile.read" && operation.risk === "R1")
        || (operationId === "messaging.send" && operation.risk === "R3"));
    if (!legacyLinkedIn) {
      issues.push("schemaVersion 1 platform adapters are restricted to the bundled LinkedIn compatibility contract; migrate to schemaVersion 2 with surfaceId");
    }
  }
  if (
    schemaVersion === WRENCH_MANIFEST_SCHEMA_VERSION
    || schemaVersion === WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION
    || schemaVersion === WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION
  ) {
    const policyOperations = Object.entries(operations).filter(([, operation]) =>
      schemaVersion !== WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION
      || isBrowserOperation(operation));
    if (surfaceId === undefined && matchingKnownSurfaces.length > 0) {
      issues.push(`manifest.surfaceId is required for reviewed platform origins (${matchingKnownSurfaces.join(", ")})`);
    }
    if (surfaceId === undefined) {
      for (const [operationId, operation] of policyOperations) {
        if (!semanticOperationNames.includes(operationId as SemanticOperationName)) {
          issues.push(`manifest.operations.${operationId} is not in wrench's reviewed generic semantic vocabulary`);
          continue;
        }
        const expectedRisk = genericSemanticRisks[operationId as SemanticOperationName];
        if (operation.risk !== expectedRisk) {
          issues.push(`manifest.operations.${operationId}.risk must be ${expectedRisk} under the generic semantic policy`);
        }
        if (operationId === "threads.publish") {
          validateGenericThreadSchema(operation, `manifest.operations.${operationId}`, issues);
        }
      }
    }
    if (
      surfaceId !== undefined
      && isPlatformSurfaceId(surfaceId)
      && (
        schemaVersion !== WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION
        || policyOperations.length > 0
      )
    ) {
      const surface = socialPlatformCatalog[surfaceId];
      const baseOrigins = new Set<string>(surface.originPolicy.exactOrigins);
      if (!origins.some((origin) => baseOrigins.has(origin))) {
        issues.push(`manifest.origins must include a reviewed ${surfaceId} origin`);
      }
      const additionalOrigins = origins.filter((origin) => !baseOrigins.has(origin));
      if (surface.originPolicy.additionalExactOrigins.state === "forbidden" && additionalOrigins.length > 0) {
        issues.push(`manifest.origins contains an origin outside the reviewed ${surfaceId} policy`);
      } else if (
        surface.originPolicy.additionalExactOrigins.state === "adapter-declared"
        && additionalOrigins.length > surface.originPolicy.additionalExactOrigins.maxOrigins
      ) {
        issues.push(`manifest.origins may add at most ${surface.originPolicy.additionalExactOrigins.maxOrigins} reviewed publication origin for ${surfaceId}`);
      }
      for (const [operationId, operation] of policyOperations) {
        if (!semanticOperationNames.includes(operationId as SemanticOperationName)) {
          issues.push(`manifest.operations.${operationId} is not a reviewed semantic operation for ${surfaceId}`);
          continue;
        }
        const policy = surface.operations[operationId as SemanticOperationName];
        if (policy.state === "unsupported" || policy.state === "not-applicable") {
          issues.push(`manifest.operations.${operationId} is ${policy.state} on ${surfaceId}`);
          continue;
        }
        const expectedRisk = policy.state === "R4" ? "R4" : policy.risk;
        if (operation.risk !== expectedRisk) {
          issues.push(`manifest.operations.${operationId}.risk must be ${expectedRisk} under the reviewed ${surfaceId} policy`);
        }
        if (policy.state === "adapter-eligible") {
          validatePlatformCompositionSchema(
            surfaceId,
            operationId as SemanticOperationName,
            operation,
            `manifest.operations.${operationId}`,
            issues,
          );
          if (operationId === "threads.publish") {
            validatePlatformThreadSchema(surfaceId, operation, `manifest.operations.${operationId}`, issues);
          }
        }
      }
    }
  }
  if (schemaVersion === WRENCH_PROVIDER_MANIFEST_SCHEMA_VERSION) {
    const hasProviderOperation = Object.values(operations).some(isProviderOperation);
    const hasBrowserOperation = Object.values(operations).some(isBrowserOperation);
    if (hasProviderOperation && surfaceId === undefined) {
      issues.push("manifest.surfaceId is required for schemaVersion 3 official-provider adapters");
    }
    if (
      requireCurrentCodeOwnedContracts
      && hasProviderOperation
      && surfaceId !== undefined
    ) {
      const binding = registry.resolveRoute("provider-api", surfaceId);
      if (binding !== undefined) {
        validateManifestPluginOrigins(binding, origins, browserDomains, issues);
      }
    }
    if (hasBrowserOperation) {
      for (const domain of browserDomains) {
        if (isReviewedTemplateProtectedHostname(domain, registry)) {
          issues.push(
            `schemaVersion 3 browser actions are prohibited on protected signed-in site domain ${domain}; use a code-owned provider or schemaVersion 4 contract`,
          );
        }
      }
      for (const origin of origins) {
        const hostname = new URL(origin).hostname;
        if (isReviewedTemplateProtectedHostname(hostname, registry)) {
          issues.push(
            `schemaVersion 3 browser actions are prohibited on protected signed-in site hostname ${hostname}; use a code-owned provider or schemaVersion 4 contract`,
          );
        }
      }
    }
    for (const [operationId, operation] of Object.entries(operations)) {
      if (!isProviderOperation(operation)) {
        if (
          surfaceId !== undefined
          && hasCodeOwnedPluginSurface(surfaceId, registry)
        ) {
          issues.push(`schemaVersion 3 browser actions are prohibited on registered provider plugin surface ${surfaceId}`);
        }
        continue;
      }
      if (surfaceId !== operation.provider.provider) {
        issues.push(`manifest.operations.${operationId}.provider.provider must match manifest.surfaceId`);
      }
      if (operation.provider.action !== operationId) {
        issues.push(`manifest.operations.${operationId}.provider.action must equal its canonical operation ID`);
      }
      const descriptor = resolveManifestPluginContract(
        registry,
        "provider-api",
        operation.provider.provider,
        operation.provider.action,
        operation.provider.contractVersion,
        requireCurrentCodeOwnedContracts,
      );
      if (descriptor === undefined) {
        issues.push(
          `official provider contract ${operation.provider.provider}/${operation.provider.action}@${operation.provider.contractVersion} is not installed`,
        );
        continue;
      }
      if (requireCurrentCodeOwnedContracts) {
        validateManifestPluginSemantics(
          operationId,
          operation,
          descriptor.operation,
          `provider contract ${operation.provider.provider}/${operationId}@${operation.provider.contractVersion}`,
          "provider contract",
          issues,
        );
      }
    }
  }
  if (schemaVersion === WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION) {
    const hasWebSessionOperation = Object.values(operations).some(isWebSessionOperation);
    if (hasWebSessionOperation && surfaceId === undefined) {
      issues.push("manifest.surfaceId is required for schemaVersion 4 authenticated web-session adapters");
    }
    if (
      requireCurrentCodeOwnedContracts
      && hasWebSessionOperation
      && surfaceId !== undefined
    ) {
      const binding = registry.resolveSessionRoute(surfaceId);
      if (binding !== undefined) {
        validateManifestPluginOrigins(binding, origins, browserDomains, issues);
      }
    }
    for (const [operationId, operation] of Object.entries(operations)) {
      if (!isWebSessionOperation(operation)) {
        issues.push(`manifest.operations.${operationId} must use a code-owned webSession contract in schemaVersion 4`);
        continue;
      }
      if (surfaceId !== operation.webSession.site) {
        issues.push(`manifest.operations.${operationId}.webSession.site must match manifest.surfaceId`);
      }
      if (operation.webSession.action !== operationId) {
        issues.push(`manifest.operations.${operationId}.webSession.action must equal its canonical operation ID`);
      }
      const descriptor = resolveManifestPluginContract(
        registry,
        "session-api",
        operation.webSession.site,
        operation.webSession.action,
        operation.webSession.contractVersion,
        requireCurrentCodeOwnedContracts,
      );
      if (descriptor === undefined) {
        issues.push(
          `authenticated web contract ${operation.webSession.site}/${operation.webSession.action}@${operation.webSession.contractVersion} is not installed`,
        );
        continue;
      }
      if (requireCurrentCodeOwnedContracts) {
        validateManifestPluginSemantics(
          operationId,
          operation,
          descriptor.operation,
          `authenticated web contract ${operation.webSession.site}/${operationId}@${operation.webSession.contractVersion}`,
          "authenticated web contract",
          issues,
        );
      }
    }
  }
  if (schemaVersion === WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION) {
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.port !== "") {
        issues.push(`schemaVersion 5 reviewed-template reservations require the default HTTPS port; ${origin} is not allowed`);
      }
      if (isReviewedTemplateProtectedHostname(url.hostname, registry)) {
        issues.push(
          `schemaVersion 5 reviewed-template reservations are prohibited on protected signed-in site hostname ${url.hostname}; use a code-owned schemaVersion 4 contract`,
        );
      }
    }
    if (
      surfaceId !== undefined
      && hasCodeOwnedPluginSurface(surfaceId, registry)
    ) {
      issues.push(`schemaVersion 5 reviewed templates are prohibited on registered provider plugin surface ${surfaceId}`);
    }
    for (const [operationId, operation] of Object.entries(operations)) {
      if (!isReviewedTemplateOperation(operation)) {
        issues.push(`manifest.operations.${operationId} must use a reviewedTemplate contract in schemaVersion 5`);
      }
    }
  }
  if (
    schemaVersion === WRENCH_MANIFEST_SCHEMA_VERSION
    && Object.keys(operations).length > 0
  ) {
    const hasBrowserOperation = Object.values(operations).some(isBrowserOperation);
    if (
      surfaceId !== undefined
      && hasCodeOwnedPluginSurface(surfaceId, registry)
    ) {
      issues.push(`schemaVersion 2 browser actions are prohibited on registered provider plugin surface ${surfaceId}`);
    }
    if (hasBrowserOperation) {
      for (const domain of browserDomains) {
        if (isReviewedTemplateProtectedHostname(domain, registry)) {
          issues.push(
            `schemaVersion 2 browser actions are prohibited on protected signed-in site domain ${domain}; use a code-owned provider or schemaVersion 4 contract`,
          );
        }
      }
      for (const origin of origins) {
        const hostname = new URL(origin).hostname;
        if (isReviewedTemplateProtectedHostname(hostname, registry)) {
          issues.push(
            `schemaVersion 2 browser actions are prohibited on protected signed-in site hostname ${hostname}; use a code-owned provider or schemaVersion 4 contract`,
          );
        }
      }
    }
  }
  if (issues.length > 0 || id === null || version === null || displayName === null) return { ok: false, issues };
  const manifest: WrenchManifest = {
    schemaVersion,
    id,
    version,
    displayName,
    ...(surfaceId === undefined ? {} : { surfaceId }),
    origins,
    browserDomains,
    operations,
  };
  if (
    schemaVersion === WRENCH_LEGACY_MANIFEST_SCHEMA_VERSION
    && id === "linkedin"
    && sha256(canonicalJson(value)) !== WRENCH_LEGACY_LINKEDIN_MANIFEST_HASH
  ) {
    return {
      ok: false,
      issues: ["schemaVersion 1 LinkedIn compatibility is restricted to the exact archived v0.4.0 manifest"],
    };
  }
  return { ok: true, value: manifest };
}

/** Parse a secret-free wrench adapter manifest and require every current code-owned contract. */
export function parseManifest(
  value: unknown,
  registry: ProviderPluginRegistry,
): ParseResult<WrenchManifest> {
  return parseManifestWithContractValidation(value, true, registry);
}

/**
 * Parse retired adapter bytes as inert migration evidence.
 *
 * This preserves structural, platform-policy, surface, and action validation,
 * but deliberately does not make a retired provider or web-session contract
 * current again.
 */
export function parseDiagnosticManifest(
  value: unknown,
  registry: ProviderPluginRegistry,
): ParseResult<WrenchManifest> {
  return parseManifestWithContractValidation(value, false, registry);
}

/**
 * Parse a manifest that may cross an install or invocation boundary.
 *
 * `parseManifest` intentionally retains the retired schema-v1/v2 browser
 * grammar so old files can be diagnosed precisely. Retired DOM recipes are
 * never installable or executable, including when a typed value is passed
 * directly instead of being read from disk.
 */
export function parseRuntimeManifest(
  value: unknown,
  registry: ProviderPluginRegistry,
): ParseResult<WrenchManifest> {
  const parsed = parseManifest(value, registry);
  if (!parsed.ok) return parsed;
  const browserOperations = Object.entries(parsed.value.operations)
    .filter(([, operation]) => isBrowserOperation(operation))
    .map(([operationId]) => operationId);
  if (browserOperations.length > 0) {
    return {
      ok: false,
      issues: browserOperations.map((operationId) =>
        `manifest.operations.${operationId}.browser: ${DOM_ACTION_TRANSPORT_DISABLED_MESSAGE}`),
    };
  }
  return parsed;
}

export function validateOperationInput(
  schema: InputSchema,
  value: unknown,
  origins: readonly string[],
): ParseResult<OperationInput> {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["input must be a JSON object"] };
  const output: Record<string, InputValue> = {};
  for (const key of Object.keys(value)) {
    if (!(key in schema.properties)) issues.push(`input.${key} is not supported`);
  }
  for (const key of schema.required) {
    if (!(key in value)) issues.push(`input.${key} is required`);
  }
  const validateValue = (
    field: ScalarInputField | FileInputField,
    candidate: unknown,
    path: string,
  ): ScalarInputValue | FileInputValue | null => {
    if (field.type === "file") {
      if (
        typeof candidate !== "string"
        || candidate.length < 1
        || candidate.length > 4_096
        || candidate.includes(String.fromCharCode(0))
        || hasUnpairedSurrogate(candidate)
      ) {
        issues.push(`${path} must be a non-empty opaque file reference`);
        return null;
      }
      return { kind: "file", reference: candidate };
    }
    if (typeof candidate !== field.type) {
      issues.push(`${path} must be ${field.type}`);
      return null;
    }
    if (typeof candidate === "string") {
      if (candidate.length < (field.minLength ?? 0) || candidate.length > (field.maxLength ?? 64 * 1024)) {
        issues.push(`${path} has an invalid length`);
        return null;
      }
      if (candidate.includes(String.fromCharCode(0))) {
        issues.push(`${path} must not contain NUL`);
        return null;
      }
      if (hasUnpairedSurrogate(candidate)) {
        issues.push(`${path} must contain well-formed Unicode`);
        return null;
      }
      if (field.format === "url") {
        try {
          if (field.urlPathPrefixes !== undefined && hasAmbiguousPathSyntax(rawUrlPath(candidate))) {
            issues.push(`${path} must use an unambiguous allowed URL path`);
            return null;
          }
          const url = new URL(candidate);
          if (!origins.includes(url.origin) || url.username !== "" || url.password !== "") {
            issues.push(`${path} must use an adapter origin and contain no credentials`);
            return null;
          }
          if (
            field.urlPathPrefixes !== undefined
            && !field.urlPathPrefixes.some((prefix) => matchesUrlPathPrefix(url.pathname, prefix))
          ) {
            issues.push(`${path} must use an allowed URL path prefix`);
            return null;
          }
        } catch {
          issues.push(`${path} must be a valid URL`);
          return null;
        }
      }
      if (
        field.format === "path-segment"
        && (candidate === "." || candidate === ".." || candidate.includes("/") || candidate.includes("\\") || candidate.includes("%"))
      ) {
        issues.push(`${path} must be one unambiguous URL path segment`);
        return null;
      }
    }
    if (typeof candidate === "number" && (!Number.isFinite(candidate) || candidate < (field.minimum ?? -Infinity) || candidate > (field.maximum ?? Infinity))) {
      issues.push(`${path} is outside its numeric bounds`);
      return null;
    }
    if (field.enum !== undefined && !field.enum.some((enumValue) => Object.is(enumValue, candidate))) {
      issues.push(`${path} is not an allowed value`);
      return null;
    }
    return candidate as ScalarInputValue;
  };
  for (const [key, field] of Object.entries(schema.properties)) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (field.type === "array") {
      if (!Array.isArray(candidate)) {
        issues.push(`input.${key} must be array`);
        continue;
      }
      if (candidate.length < field.minItems || candidate.length > field.maxItems) {
        issues.push(`input.${key} must contain ${field.minItems}-${field.maxItems} items`);
        continue;
      }
      const parsed: (ScalarInputValue | FileInputValue)[] = [];
      candidate.forEach((item, index) => {
        const result = validateValue(field.items, item, `input.${key}[${index}]`);
        if (result !== null) parsed.push(result);
      });
      if (parsed.length === candidate.length) output[key] = parsed;
      continue;
    }
    const parsed = validateValue(field, candidate, `input.${key}`);
    if (parsed !== null) output[key] = parsed;
  }
  return issues.length === 0 ? { ok: true, value: output } : { ok: false, issues };
}

/** Enforce value-level text limits from a manifest's bound platform policy. */
export function validatePlatformOperationInput(
  manifest: WrenchManifest,
  operationId: string,
  input: OperationInput,
): ParseResult<OperationInput> {
  if (
    manifest.surfaceId === undefined
    || !isPlatformSurfaceId(manifest.surfaceId)
    || !semanticOperationNames.includes(operationId as SemanticOperationName)
  ) {
    return { ok: true, value: input };
  }
  if (operationId === "threads.publish") {
    const policy = threadTextPolicy(manifest.surfaceId);
    const items = input.items;
    if (policy === null || !Array.isArray(items)) {
      return { ok: false, issues: [`threads.publish has no valid reviewed item policy on ${manifest.surfaceId}`] };
    }
    const issues: string[] = [];
    for (const [index, item] of items.entries()) {
      if (typeof item !== "string") {
        issues.push(`input.items[${index}] must be thread text`);
        continue;
      }
      const length = weightedTextLength(item, textWeightPolicies[policy.measurement]);
      if (length > policy.maxWeightedLength) {
        issues.push(`input.items[${index}] weighs ${length}, above the reviewed ${policy.maxWeightedLength}-unit ${manifest.surfaceId} limit`);
      }
    }
    return issues.length === 0 ? { ok: true, value: input } : { ok: false, issues };
  }
  const compositionName = operationCompositions[operationId as SemanticOperationName];
  if (compositionName === undefined) return { ok: true, value: input };
  const surface = socialPlatformCatalog[manifest.surfaceId] as PlatformSurfaceCatalogEntry;
  const composition = surface.compositions[compositionName];
  if (composition === undefined) return { ok: false, issues: [`${operationId} has no reviewed composition policy on ${manifest.surfaceId}`] };
  const operation = manifest.operations[operationId];
  const structuredArticleDraft = operationId === "articles.draft.save"
    && operation !== undefined
    && isWebSessionOperation(operation)
    && operation.input.properties.document !== undefined;
  const issues: string[] = [];
  for (const field of composition.text) {
    // The draft contract replaces the plain body with a strictly parsed
    // versioned document. Its provider runtime owns text/range bounds, while the
    // platform composition continues to enforce the title policy here.
    if (structuredArticleDraft && field.name === "body") continue;
    const value = input[field.name];
    if (value === undefined) {
      if (field.required) issues.push(`input.${field.name} is required by the reviewed ${manifest.surfaceId} policy`);
      continue;
    }
    if (typeof value !== "string") {
      issues.push(`input.${field.name} must be text under the reviewed ${manifest.surfaceId} policy`);
      continue;
    }
    const length = weightedTextLength(value, textWeightPolicies[field.measurement]);
    if (length > field.safeMaxUnits) {
      issues.push(`input.${field.name} weighs ${length}, above the reviewed ${field.safeMaxUnits}-unit ${manifest.surfaceId} limit`);
    }
    if (field.format === "decimal-amount" && !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/u.test(value)) {
      issues.push(`input.${field.name} must be a non-negative decimal amount with at most two fractional digits`);
    }
    if (field.format === "currency-code" && !/^[A-Z]{3}$/u.test(value)) {
      issues.push(`input.${field.name} must be a three-letter uppercase currency code`);
    }
  }
  return issues.length === 0 ? { ok: true, value: input } : { ok: false, issues };
}

function bindRepeatedDispatch(
  step: Exclude<BrowserRecipeStep, { readonly kind: "for-each" }>,
  suffix: string,
): Exclude<BrowserRecipeStep, { readonly kind: "for-each" }> {
  if ((step.kind === "find" || step.kind === "press") && step.effect?.kind === "dispatch") {
    return { ...step, effect: { ...step.effect, id: `${step.effect.id}${suffix}` } };
  }
  if (step.kind === "verify-dispatch") return { ...step, dispatch: `${step.dispatch}${suffix}` };
  return step;
}

/**
 * Expand bounded control structure before a browser session starts. The returned
 * dispatch list is the exact, ordered schedule the runtime can persist in a plan.
 */
export function expandBrowserRecipe(recipe: BrowserRecipe, input: OperationInput): ExpandedBrowserRecipe {
  const steps: ExpandedBrowserRecipeStep[] = [];
  const dispatches: BrowserDispatchPlan[] = [];
  let legacyDispatches = 0;
  const append = (
    step: Exclude<BrowserRecipeStep, { readonly kind: "for-each" }>,
    item?: ScalarInputValue | FileInputValue,
  ): void => {
    const effect = dispatchEffect(step);
    if (effect !== null) dispatches.push({ id: effect.id, description: effect.description });
    else if ((step.kind === "find" || step.kind === "press") && step.dispatch === true) {
      legacyDispatches += 1;
      dispatches.push({ id: legacyDispatches === 1 ? "dispatch" : `dispatch-${legacyDispatches}`, description: "Legacy manifest dispatch" });
    }
    steps.push({ step, ...(item === undefined ? {} : { item }) });
    if (steps.length > 500) throw new Error("browser recipe expands beyond 500 steps");
    if (dispatches.length > 25) throw new Error("browser recipe expands beyond 25 dispatches");
  };
  for (const step of recipe.steps) {
    if (step.kind !== "for-each") {
      append(step);
      continue;
    }
    const rawValues = input[step.input];
    if (!Array.isArray(rawValues)) throw new Error(`for-each input.${step.input} must be a validated array`);
    const values = rawValues as readonly (ScalarInputValue | FileInputValue)[];
    if (values.length > 25) throw new Error(`for-each input.${step.input} exceeds 25 items`);
    for (const [index, item] of values.entries()) {
      const suffix = `[${index + 1}]`;
      for (const nested of step.steps) {
        if (nested.kind === "for-each") throw new Error("nested for-each is not supported");
        append(bindRepeatedDispatch(nested, suffix), item);
      }
      if (index < values.length - 1) {
        for (const nested of step.between ?? []) {
          if (nested.kind === "for-each") throw new Error("nested for-each is not supported");
          append(bindRepeatedDispatch(nested, suffix), item);
        }
      }
    }
  }
  const ids = new Set<string>();
  for (const dispatch of dispatches) {
    if (ids.has(dispatch.id)) throw new Error(`browser recipe has duplicate expanded dispatch id ${dispatch.id}`);
    ids.add(dispatch.id);
  }
  return { timeoutMs: recipe.timeoutMs, maxOutputBytes: recipe.maxOutputBytes, steps, dispatches };
}

export function manifestHash(manifest: WrenchManifest): string {
  return sha256(canonicalJson(manifest));
}
