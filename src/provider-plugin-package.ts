import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  type BigIntStats,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import type {
  ArrayInputField,
  FileInputField,
  IdempotencyKind,
  InputField,
  InputSchema,
  OperationRisk,
  ScalarInputField,
} from "./model";
import {
  isPortableProviderPluginVersion,
} from "./provider-plugin-identifiers";

export {
  isPortableProviderPluginVersion,
} from "./provider-plugin-identifiers";

export const PORTABLE_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION = 1 as const;
export const PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME = "wrench-plugin.json";
export const LEGACY_PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME = "oh-plugin.json";
const portableProviderPluginManifestNames = new Set([
  PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
  LEGACY_PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
]);

export const portableProviderPluginTransports = [
  "provider-api",
  "web-session-api",
  "linked-device",
] as const;

export const portableProviderPluginAuthKinds = [
  "cookie-source",
  "cookies-file",
  "browser-profile",
  "oauth-token-file",
  "linked-device-store",
] as const;

/** Session materials implemented by the host API v1 credential kernel. */
export const portableProviderPluginSessionMaterialNames = [
  "cookie-jar",
  "oauth-access-token",
] as const;

export type PortableProviderPluginTransport =
  (typeof portableProviderPluginTransports)[number];
export type PortableProviderPluginAuthKind =
  (typeof portableProviderPluginAuthKinds)[number];
export type PortableProviderPluginSessionMaterialName =
  (typeof portableProviderPluginSessionMaterialNames)[number];

type PortableProviderPluginOperationBaseV1 = {
  readonly name: string;
  readonly contractVersion: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly state: "observed" | "capture-required";
  readonly risk: OperationRisk;
  readonly dispatch: "none" | "single";
  readonly sideEffect: string;
  readonly idempotency: IdempotencyKind;
  readonly dedupeWindowMs: number;
  readonly input: InputSchema;
  readonly implementation: string;
};

export type PortableProviderApiPluginOperationV1 =
  PortableProviderPluginOperationBaseV1 & {
    readonly requiredScopeSets: readonly (readonly string[])[];
    readonly coverage: readonly string[];
  };

export type PortableWebSessionPluginOperationV1 =
  PortableProviderPluginOperationBaseV1 & {
    readonly requiredScopeSets?: never;
    readonly coverage?: never;
  };

export type PortableProviderPluginOperationV1 =
  | PortableProviderApiPluginOperationV1
  | PortableWebSessionPluginOperationV1;

type PortableProviderPluginBindingBaseV1 = {
  /** Stable short-form CLI address owned by this exact plugin binding. */
  readonly adapterId: string;
  readonly surfaceId: string;
  readonly origin: `https://${string}`;
  readonly authKinds: readonly PortableProviderPluginAuthKind[];
  readonly subject: {
    readonly format: string;
    readonly kind: "opaque-token" | "decimal" | "did" | "uuid" | "e164";
    readonly probe: {
      readonly operation: string;
      readonly contractVersion: number;
    } | null;
  };
};

export type PortableProviderApiPluginBindingV1 =
  PortableProviderPluginBindingBaseV1 & {
    readonly transport: "provider-api";
    readonly operations: readonly PortableProviderApiPluginOperationV1[];
  };

export type PortableWebSessionApiPluginBindingV1 =
  PortableProviderPluginBindingBaseV1 & {
    readonly transport: "web-session-api";
    readonly operations: readonly PortableWebSessionPluginOperationV1[];
  };

export type PortableLinkedDevicePluginBindingV1 =
  PortableProviderPluginBindingBaseV1 & {
    readonly transport: "linked-device";
    readonly operations: readonly PortableWebSessionPluginOperationV1[];
  };

export type PortableProviderPluginBindingV1 =
  | PortableProviderApiPluginBindingV1
  | PortableWebSessionApiPluginBindingV1
  | PortableLinkedDevicePluginBindingV1;

export type PortableProviderPluginCapabilitiesV1 = {
  readonly networkOrigins: readonly `https://${string}`[];
  readonly planFiles: "none" | "read";
  readonly state: "none" | "namespaced";
  readonly sessionMaterial: readonly PortableProviderPluginSessionMaterialName[];
};

export type PortableProviderPluginFileV1 = {
  readonly path: string;
  readonly kind: "runtime" | "data";
  readonly bytes: number;
  readonly sha256: string;
};

export type PortableProviderPluginProvenanceV1 =
  | {
      readonly kind: "local";
    }
  | {
      readonly kind: "git";
      readonly repository: `https://${string}`;
      readonly revision: string;
    };

export type PortableProviderPluginManifestV1 = {
  readonly schemaVersion:
    typeof PORTABLE_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION;
  readonly hostApiVersion: typeof PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION;
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly runtime: {
    readonly kind: "bun-js";
    readonly entrypoint: string;
  };
  readonly provenance: PortableProviderPluginProvenanceV1;
  readonly capabilities: PortableProviderPluginCapabilitiesV1;
  readonly bindings: readonly PortableProviderPluginBindingV1[];
  readonly files: readonly PortableProviderPluginFileV1[];
};

export type PortableProviderPluginManifestResult =
  | {
      readonly ok: true;
      readonly value: PortableProviderPluginManifestV1;
    }
  | {
      readonly ok: false;
      readonly issues: readonly string[];
    };

export type VerifiedPortableProviderPluginFile = {
  readonly path: string;
  readonly kind: PortableProviderPluginFileV1["kind"];
  readonly bytes: Buffer;
  readonly sha256: string;
};

export type VerifiedPortableProviderPluginPackage = {
  readonly root: string;
  readonly manifest: PortableProviderPluginManifestV1;
  readonly manifestBytes: Buffer;
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  readonly payloadBytes: number;
  readonly files: readonly VerifiedPortableProviderPluginFile[];
};

const verifiedPortableProviderPluginPackages = new WeakSet<object>();

/** Kernel evidence that a package object came from the exact-byte verifier. */
export function isVerifiedPortableProviderPluginPackage(
  value: unknown,
): value is VerifiedPortableProviderPluginPackage {
  return typeof value === "object"
    && value !== null
    && verifiedPortableProviderPluginPackages.has(value);
}

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGIN_FILES = 256;
const MAX_PLUGIN_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PLUGIN_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_BINDINGS = 64;
const MAX_OPERATIONS_PER_BINDING = 256;
const MAX_NETWORK_ORIGINS = 64;
const MAX_SESSION_MATERIAL_NAMES = 64;
const MAX_PLUGIN_DIRECTORIES = MAX_PLUGIN_FILES * 15;
const MAX_PLUGIN_PACKAGE_ENTRIES =
  1 + MAX_PLUGIN_FILES + MAX_PLUGIN_DIRECTORIES;
const allowedPortableRuntimeImports = new Set([
  "node:readline",
]);
const portableRuntimeImportScanner = new Bun.Transpiler({ loader: "js" });
const pathHelperPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "path-helper.ts",
);
const pathHelperConfigPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "state-helper.bunfig.toml",
);
let pathHelperSpawnObserverForTest: (() => void) | undefined;

export function observePortableProviderPluginPathHelperSpawnsForTest(
  observer: () => void,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("path helper spawn observation is available only in tests");
  }
  if (pathHelperSpawnObserverForTest !== undefined) {
    throw new Error("path helper spawn observation is already active");
  }
  pathHelperSpawnObserverForTest = observer;
  return () => {
    if (pathHelperSpawnObserverForTest === observer) {
      pathHelperSpawnObserverForTest = undefined;
    }
  };
}

const pluginIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const operationNamePattern =
  /^[a-z][a-z0-9-]{0,39}(?:\.[a-z][a-z0-9-]{0,39}){1,3}$/u;
const materialNamePattern =
  /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const packagePathSegmentPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

const forbiddenPackageBasenames = new Set([
  ".env",
  ".npmrc",
  ".yarnrc",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "deno.json",
  "deno.jsonc",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const forbiddenPackageExtensions = new Set([
  ".cmd",
  ".dll",
  ".dylib",
  ".exe",
  ".node",
  ".ps1",
  ".sh",
  ".so",
]);
const forbiddenPortablePathStems =
  /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && "value" in descriptor;
  });
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(
      `${label} must contain exactly: ${wanted.join(", ")}`,
    );
  }
}

function allowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value)
    .filter((key) => !accepted.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported keys: ${unexpected.join(", ")}`);
  }
}

function compareCanonicalText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be bounded single-line text`);
  }
  return value;
}

function boundedSemanticText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error(`${label} must not contain control characters`);
    }
  }
  return value;
}

function boundedArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(
      `${label} must contain between 1 and ${maximum} items`,
    );
  }
  return value;
}

function safePluginId(value: unknown, label: string): string {
  const id = boundedString(value, label, 63);
  if (!pluginIdPattern.test(id)) {
    throw new Error(`${label} must be strict lowercase kebab-case`);
  }
  return id;
}

function safeVersion(value: unknown): string {
  const version = boundedString(value, "plugin version", 128);
  if (!isPortableProviderPluginVersion(version)) {
    throw new Error("plugin version must be strict semantic version text");
  }
  return version;
}

function safeOperationName(value: unknown): string {
  const name = boundedString(value, "plugin operation name", 163);
  if (!operationNamePattern.test(name)) {
    throw new Error(
      "plugin operation name must be a bounded dotted semantic outcome",
    );
  }
  return name;
}

function safeSha256(value: unknown, label: string): string {
  const sha256 = boundedString(value, label, 64);
  if (!sha256Pattern.test(sha256)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return sha256;
}

function exactPublicHttpsOrigin(value: unknown, label: string): `https://${string}` {
  const text = boundedString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an exact public HTTPS origin`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || url.origin !== text
    || hostname.endsWith(".")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || !hostname.includes(".")
    || isIP(hostname) !== 0
  ) {
    throw new Error(`${label} must be an exact public HTTPS origin`);
  }
  return text as `https://${string}`;
}

function exactHttpsRepository(value: unknown): `https://${string}` {
  const text = boundedString(value, "plugin provenance repository", 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      "plugin git provenance repository must identify an HTTPS repository",
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.pathname === "/"
    || url.pathname.endsWith("/")
    || hostname.endsWith(".")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || !hostname.includes(".")
    || isIP(hostname) !== 0
    || url.toString() !== text
  ) {
    throw new Error(
      "plugin git provenance repository must identify an exact credential-free HTTPS repository",
    );
  }
  return text as `https://${string}`;
}

function safePackagePath(value: unknown, label: string): string {
  const path = boundedString(value, label, 512);
  if (
    path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || path.includes("//")
  ) {
    throw new Error(`${label} must be a normalized relative package path`);
  }
  const segments = path.split("/");
  if (
    segments.length > 16
    || segments.some(
      (segment) =>
        segment === "."
        || segment === ".."
        || segment.endsWith(".")
        || !packagePathSegmentPattern.test(segment)
        || forbiddenPortablePathStems.test(segment.split(".")[0] ?? ""),
    )
  ) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  if (segments.some((segment) => segment.toLowerCase() === "node_modules")) {
    throw new Error(`${label} cannot contain node_modules`);
  }
  const basename = segments.at(-1)?.toLowerCase();
  if (basename === undefined || forbiddenPackageBasenames.has(basename)) {
    throw new Error(`${label} names a forbidden package-manager or environment file`);
  }
  const dot = basename.lastIndexOf(".");
  const extension = dot < 0 ? "" : basename.slice(dot);
  if (forbiddenPackageExtensions.has(extension)) {
    throw new Error(`${label} names a native or shell executable`);
  }
  if (portableProviderPluginManifestNames.has(path)) {
    throw new Error(`${label} cannot redeclare the package manifest`);
  }
  return path;
}

const operationRiskRank = Object.freeze({
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
} satisfies Readonly<Record<OperationRisk, number>>);

const readOperationSuffixes = new Set([
  "get",
  "inspect",
  "list",
  "lookup",
  "probe",
  "read",
  "search",
  "status",
]);
const reversibleMutationSuffixes = new Set([
  "edit",
  "follow",
  "like",
  "save",
  "unfollow",
  "unlike",
  "unsave",
  "update",
]);
const outwardMutationSuffixes = new Set([
  "comment",
  "create",
  "post",
  "publish",
  "reply",
  "send",
  "upload",
]);
const highAuthorityOperationSegments = new Set([
  "admin",
  "administrator",
  "ban",
  "billing",
  "charge",
  "charges",
  "delete",
  "destroy",
  "erase",
  "financial",
  "funds",
  "invoice",
  "invoices",
  "money",
  "payment",
  "payments",
  "permission",
  "permissions",
  "purchase",
  "purge",
  "refund",
  "remove",
  "role",
  "roles",
  "subscription",
  "subscriptions",
  "suspend",
  "transfer",
  "transfers",
  "withdraw",
  "withdrawal",
]);

/**
 * Derive the kernel's conservative minimum authority from one semantic
 * outcome. Unknown, destructive, administrative, and financial outcomes are
 * inert R4 reservations until the kernel learns an explicit policy.
 */
export function derivePortableProviderPluginMinimumRisk(
  operationName: string,
): OperationRisk {
  const name = safeOperationName(
    operationName,
  );
  const segments = name.split(/[.-]/u);
  if (segments.some((segment) => highAuthorityOperationSegments.has(segment))) {
    return "R4";
  }
  const suffix = name.split(".").at(-1);
  if (suffix !== undefined && readOperationSuffixes.has(suffix)) return "R1";
  if (suffix !== undefined && reversibleMutationSuffixes.has(suffix)) return "R2";
  if (suffix !== undefined && outwardMutationSuffixes.has(suffix)) return "R3";
  return "R4";
}

function parseDescription(value: unknown, label: string): string {
  return boundedSemanticText(value, label, 500);
}

function parseMediaTypes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error(`${label} must contain between 1 and 32 media types`);
  }
  const mediaTypes = value.map((candidate, index) => {
    const mediaType = boundedString(candidate, `${label}[${index}]`, 256);
    if (
      !/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/u.test(mediaType)
    ) {
      throw new Error(`${label}[${index}] is malformed`);
    }
    return mediaType;
  });
  if (new Set(mediaTypes).size !== mediaTypes.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return Object.freeze([...mediaTypes].sort());
}

function parseScalarInputField(
  field: Readonly<Record<string, unknown>>,
  label: string,
): ScalarInputField {
  allowedKeys(
    field,
    [
      "type",
      "description",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "enum",
      "format",
      "urlPathPrefixes",
    ],
    label,
  );
  if (
    field.type !== "string"
    && field.type !== "number"
    && field.type !== "boolean"
  ) {
    throw new Error(`${label}.type is unsupported`);
  }
  const type = field.type;
  const description = parseDescription(field.description, `${label}.description`);

  let minLength: number | undefined;
  let maxLength: number | undefined;
  if (field.minLength !== undefined || field.maxLength !== undefined) {
    if (type !== "string") {
      throw new Error(`${label} length bounds require a string field`);
    }
    if (
      field.minLength !== undefined
      && (
        !Number.isSafeInteger(field.minLength)
        || (field.minLength as number) < 0
        || (field.minLength as number) > 1_000_000
      )
    ) {
      throw new Error(`${label}.minLength is invalid`);
    }
    if (
      field.maxLength !== undefined
      && (
        !Number.isSafeInteger(field.maxLength)
        || (field.maxLength as number) < 1
        || (field.maxLength as number) > 1_000_000
      )
    ) {
      throw new Error(`${label}.maxLength is invalid`);
    }
    minLength = field.minLength as number | undefined;
    maxLength = field.maxLength as number | undefined;
    if (
      minLength !== undefined
      && maxLength !== undefined
      && minLength > maxLength
    ) {
      throw new Error(`${label}.minLength cannot exceed maxLength`);
    }
  }

  let minimum: number | undefined;
  let maximum: number | undefined;
  if (field.minimum !== undefined || field.maximum !== undefined) {
    if (type !== "number") {
      throw new Error(`${label} numeric bounds require a number field`);
    }
    if (
      field.minimum !== undefined
      && (typeof field.minimum !== "number" || !Number.isFinite(field.minimum))
    ) {
      throw new Error(`${label}.minimum is invalid`);
    }
    if (
      field.maximum !== undefined
      && (typeof field.maximum !== "number" || !Number.isFinite(field.maximum))
    ) {
      throw new Error(`${label}.maximum is invalid`);
    }
    minimum = field.minimum;
    maximum = field.maximum;
    if (
      minimum !== undefined
      && maximum !== undefined
      && minimum > maximum
    ) {
      throw new Error(`${label}.minimum cannot exceed maximum`);
    }
  }

  let enumValues: readonly (string | number | boolean)[] | undefined;
  if (field.enum !== undefined) {
    if (
      !Array.isArray(field.enum)
      || field.enum.length < 1
      || field.enum.length > 100
      || field.enum.some((candidate) =>
        typeof candidate !== type
        || (typeof candidate === "number" && !Number.isFinite(candidate)))
    ) {
      throw new Error(`${label}.enum must contain bounded values matching its type`);
    }
    const values = field.enum as readonly (string | number | boolean)[];
    if (
      new Set(values.map((candidate) => JSON.stringify(candidate))).size
      !== values.length
    ) {
      throw new Error(`${label}.enum must not contain duplicates`);
    }
    enumValues = Object.freeze([...values]);
  }

  let format: "url" | "path-segment" | undefined;
  if (field.format !== undefined) {
    if (
      type !== "string"
      || (field.format !== "url" && field.format !== "path-segment")
    ) {
      throw new Error(`${label}.format is invalid`);
    }
    format = field.format;
  }

  let urlPathPrefixes: readonly string[] | undefined;
  if (field.urlPathPrefixes !== undefined) {
    if (
      type !== "string"
      || format !== "url"
      || !Array.isArray(field.urlPathPrefixes)
      || field.urlPathPrefixes.length < 1
      || field.urlPathPrefixes.length > 20
    ) {
      throw new Error(
        `${label}.urlPathPrefixes requires a URL string field and 1-20 prefixes`,
      );
    }
    const prefixes = field.urlPathPrefixes.map((candidate, index) => {
      const prefix = boundedString(
        candidate,
        `${label}.urlPathPrefixes[${index}]`,
        2_048,
      );
      if (
        !prefix.startsWith("/")
        || prefix.startsWith("//")
        || prefix.includes("\\")
        || prefix.includes("?")
        || prefix.includes("#")
        || /%(?:25|2e|2f|5c)/iu.test(prefix)
        || prefix.split("/").some((segment) =>
          segment === "." || segment === "..")
      ) {
        throw new Error(`${label}.urlPathPrefixes[${index}] is ambiguous`);
      }
      return prefix;
    });
    if (new Set(prefixes).size !== prefixes.length) {
      throw new Error(`${label}.urlPathPrefixes must not contain duplicates`);
    }
    urlPathPrefixes = Object.freeze([...prefixes].sort());
  }

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

function parseInputField(
  value: unknown,
  label: string,
  maximumArrayItems: 25 | 100,
  nested = false,
): InputField {
  const field = record(value, label);
  if (field.type === "file") {
    allowedKeys(
      field,
      ["type", "description", "maxBytes", "mediaTypes"],
      label,
    );
    const description = parseDescription(field.description, `${label}.description`);
    if (
      !Number.isSafeInteger(field.maxBytes)
      || (field.maxBytes as number) < 1
      || (field.maxBytes as number) > 1024 * 1024 * 1024
    ) {
      throw new Error(`${label}.maxBytes must be a bounded positive integer`);
    }
    const result: FileInputField = {
      type: "file",
      description,
      maxBytes: field.maxBytes as number,
      ...(field.mediaTypes === undefined
        ? {}
        : { mediaTypes: parseMediaTypes(field.mediaTypes, `${label}.mediaTypes`) }),
    };
    return Object.freeze(result);
  }
  if (field.type === "array") {
    allowedKeys(
      field,
      ["type", "description", "items", "minItems", "maxItems"],
      label,
    );
    if (nested) throw new Error(`${label} cannot contain a nested array`);
    if (
      !Number.isSafeInteger(field.minItems)
      || !Number.isSafeInteger(field.maxItems)
      || (field.minItems as number) < 0
      || (field.maxItems as number) < 1
      || (field.maxItems as number) < (field.minItems as number)
      || (field.maxItems as number) > maximumArrayItems
    ) {
      throw new Error(`${label} must declare valid bounded item counts`);
    }
    const result: ArrayInputField = {
      type: "array",
      description: parseDescription(field.description, `${label}.description`),
      items: parseInputField(
        field.items,
        `${label}.items`,
        maximumArrayItems,
        true,
      ) as ScalarInputField | FileInputField,
      minItems: field.minItems as number,
      maxItems: field.maxItems as number,
    };
    return Object.freeze(result);
  }
  return parseScalarInputField(field, label);
}

function parseInputSchema(
  value: unknown,
  label: string,
  maximumArrayItems: 25 | 100,
): InputSchema {
  const schema = record(value, label);
  exactKeys(schema, ["properties", "required"], label);
  const rawProperties = record(schema.properties, `${label}.properties`);
  const propertyEntries = Object.entries(rawProperties)
    .sort(([left], [right]) => compareCanonicalText(left, right));
  if (propertyEntries.length > 100) {
    throw new Error(`${label}.properties may contain at most 100 fields`);
  }
  const properties: Record<string, InputField> = Object.create(null) as
    Record<string, InputField>;
  for (const [name, field] of propertyEntries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name)) {
      throw new Error(`${label}.properties contains invalid field ${name}`);
    }
    properties[name] = parseInputField(
      field,
      `${label}.properties.${name}`,
      maximumArrayItems,
    );
  }
  if (
    !Array.isArray(schema.required)
    || schema.required.length > 100
    || schema.required.some((name) => typeof name !== "string")
  ) {
    throw new Error(`${label}.required must contain at most 100 field names`);
  }
  const required = schema.required as readonly string[];
  if (new Set(required).size !== required.length) {
    throw new Error(`${label}.required must not contain duplicates`);
  }
  for (const name of required) {
    if (properties[name] === undefined) {
      throw new Error(`${label}.required references unknown field ${name}`);
    }
  }
  return Object.freeze({
    properties: Object.freeze(properties),
    required: Object.freeze([...required].sort()),
  });
}

function containsFileInput(field: InputField): boolean {
  return field.type === "file"
    || (field.type === "array" && field.items.type === "file");
}

function parseScope(value: unknown, label: string): string {
  const scope = boundedString(value, label, 256);
  if (!/^[\x21-\x7e]+$/u.test(scope)) {
    throw new Error(`${label} must be printable non-whitespace ASCII`);
  }
  return scope;
}

function parseRequiredScopeSets(
  value: unknown,
  label: string,
): readonly (readonly string[])[] {
  const rawSets = boundedArray(value, label, 32);
  const scopeSets = rawSets.map((rawSet, setIndex) => {
    const rawScopes = boundedArray(
      rawSet,
      `${label}[${setIndex}]`,
      32,
    );
    const scopes = rawScopes.map((scope, scopeIndex) =>
      parseScope(scope, `${label}[${setIndex}][${scopeIndex}]`));
    if (new Set(scopes).size !== scopes.length) {
      throw new Error(`${label}[${setIndex}] must not repeat a scope`);
    }
    return Object.freeze([...scopes].sort());
  });
  const identities = scopeSets.map((scopes) => scopes.join("\0"));
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${label} must not repeat an equivalent scope set`);
  }
  return Object.freeze(
    [...scopeSets].sort((left, right) =>
      compareCanonicalText(left.join("\0"), right.join("\0"))),
  );
}

function parseCoverage(value: unknown, label: string): readonly string[] {
  const rawCoverage = boundedArray(value, label, 64);
  const coverage = rawCoverage.map((candidate, index) => {
    const item = boundedString(candidate, `${label}[${index}]`, 128);
    if (!/^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/u.test(item)) {
      throw new Error(`${label}[${index}] is malformed`);
    }
    return item;
  });
  if (new Set(coverage).size !== coverage.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return Object.freeze([...coverage].sort());
}

function parseOperation(
  value: unknown,
  transport: PortableProviderPluginTransport,
): PortableProviderPluginOperationV1 {
  const operation = record(value, "plugin operation");
  const providerApi = transport === "provider-api";
  exactKeys(
    operation,
    [
      "name",
      "contractVersion",
      "timeoutMs",
      "maxOutputBytes",
      "state",
      "risk",
      "dispatch",
      "sideEffect",
      "idempotency",
      "dedupeWindowMs",
      "input",
      "implementation",
      ...(providerApi ? ["requiredScopeSets", "coverage"] : []),
    ],
    "plugin operation",
  );
  const name = safeOperationName(operation.name);
  if (
    !Number.isSafeInteger(operation.contractVersion)
    || (operation.contractVersion as number) < 1
    || (operation.contractVersion as number) > 1_000_000
  ) {
    throw new Error(`plugin operation ${name} contractVersion is invalid`);
  }
  if (
    !Number.isSafeInteger(operation.timeoutMs)
    || (operation.timeoutMs as number) < 1_000
    || (operation.timeoutMs as number) > 120_000
  ) {
    throw new Error(`plugin operation ${name} timeoutMs is invalid`);
  }
  if (
    !Number.isSafeInteger(operation.maxOutputBytes)
    || (operation.maxOutputBytes as number) < 1_024
    || (operation.maxOutputBytes as number) > 512 * 1024
  ) {
    throw new Error(`plugin operation ${name} maxOutputBytes is invalid`);
  }
  if (operation.state !== "observed" && operation.state !== "capture-required") {
    throw new Error(`plugin operation ${name} state is invalid`);
  }
  if (
    operation.risk !== "R1"
    && operation.risk !== "R2"
    && operation.risk !== "R3"
    && operation.risk !== "R4"
  ) {
    throw new Error(`plugin operation ${name} risk is invalid`);
  }
  const risk = operation.risk;
  const minimumRisk = derivePortableProviderPluginMinimumRisk(name);
  if (operationRiskRank[risk] < operationRiskRank[minimumRisk]) {
    throw new Error(
      `plugin operation ${name} requires at least ${minimumRisk} authority, not ${risk}`,
    );
  }
  if (operation.dispatch !== "none" && operation.dispatch !== "single") {
    throw new Error(`plugin operation ${name} dispatch is invalid`);
  }
  if (
    operation.idempotency !== "none"
    && operation.idempotency !== "local-at-most-once"
  ) {
    throw new Error(`plugin operation ${name} idempotency is invalid`);
  }
  if (
    !Number.isSafeInteger(operation.dedupeWindowMs)
    || (operation.dedupeWindowMs as number) < 0
    || (operation.dedupeWindowMs as number) > 30 * 24 * 60 * 60_000
  ) {
    throw new Error(`plugin operation ${name} dedupeWindowMs is invalid`);
  }
  const sideEffect = boundedSemanticText(
    operation.sideEffect,
    `plugin operation ${name} sideEffect`,
    500,
  );
  const implementation = boundedSemanticText(
    operation.implementation,
    `plugin operation ${name} implementation`,
    500,
  );
  const input = parseInputSchema(
    operation.input,
    `plugin operation ${name} input`,
    providerApi ? 100 : 25,
  );
  if (
    risk === "R1"
    && (
      sideEffect !== "none"
      || operation.dispatch !== "none"
      || operation.idempotency !== "none"
      || operation.dedupeWindowMs !== 0
      || Object.values(input.properties).some(containsFileInput)
    )
  ) {
    throw new Error(
      `plugin operation ${name} must keep R1 semantics side-effect-free, file-free, and dispatch-free`,
    );
  }
  if (
    (risk === "R2" || risk === "R3")
    && (
      sideEffect === "none"
      || operation.dispatch !== "single"
      || operation.idempotency !== "local-at-most-once"
      || (operation.dedupeWindowMs as number) < 60_000
    )
  ) {
    throw new Error(
      `plugin operation ${name} must bind R2/R3 authority to one at-most-once dispatch and a 60-second minimum dedupe window`,
    );
  }
  if (risk === "R4" && operation.state !== "capture-required") {
    throw new Error(
      `plugin operation ${name} must keep R4 authority capture-required`,
    );
  }
  const common = {
    name,
    contractVersion: operation.contractVersion as number,
    timeoutMs: operation.timeoutMs as number,
    maxOutputBytes: operation.maxOutputBytes as number,
    state: operation.state,
    risk,
    dispatch: operation.dispatch,
    sideEffect,
    idempotency: operation.idempotency,
    dedupeWindowMs: operation.dedupeWindowMs as number,
    input,
    implementation,
  };
  if (!providerApi) {
    return Object.freeze(common) as PortableWebSessionPluginOperationV1;
  }
  return Object.freeze({
    ...common,
    requiredScopeSets: parseRequiredScopeSets(
      operation.requiredScopeSets,
      `plugin operation ${name} requiredScopeSets`,
    ),
    coverage: parseCoverage(
      operation.coverage,
      `plugin operation ${name} coverage`,
    ),
  }) as PortableProviderApiPluginOperationV1;
}

function parseSubject(
  value: unknown,
  operations: readonly PortableProviderPluginOperationV1[],
  transport: PortableProviderPluginTransport,
  surfaceId: string,
): PortableProviderPluginBindingV1["subject"] {
  const subject = record(value, `plugin binding ${surfaceId} subject`);
  exactKeys(
    subject,
    ["format", "kind", "probe"],
    `plugin binding ${surfaceId} subject`,
  );
  const format = boundedSemanticText(
    subject.format,
    `plugin binding ${surfaceId} subject format`,
    200,
  );
  if (
    subject.kind !== "opaque-token"
    && subject.kind !== "decimal"
    && subject.kind !== "did"
    && subject.kind !== "uuid"
    && subject.kind !== "e164"
  ) {
    throw new Error(`plugin binding ${surfaceId} subject kind is unsupported`);
  }
  if (subject.probe === null) {
    if (
      transport !== "provider-api"
      && operations.some((operation) => operation.state === "observed")
    ) {
      throw new Error(
        `plugin binding ${surfaceId} must declare an observed R1 subject probe before session operations become executable`,
      );
    }
    return Object.freeze({ format, kind: subject.kind, probe: null });
  }
  const probe = record(
    subject.probe,
    `plugin binding ${surfaceId} subject probe`,
  );
  exactKeys(
    probe,
    ["operation", "contractVersion"],
    `plugin binding ${surfaceId} subject probe`,
  );
  const operationName = safeOperationName(probe.operation);
  if (
    !Number.isSafeInteger(probe.contractVersion)
    || (probe.contractVersion as number) < 1
    || (probe.contractVersion as number) > 1_000_000
  ) {
    throw new Error(
      `plugin binding ${surfaceId} subject probe contractVersion is invalid`,
    );
  }
  const operation = operations.find((candidate) =>
    candidate.name === operationName
    && candidate.contractVersion === probe.contractVersion);
  if (
    operation === undefined
    || operation.state !== "observed"
    || operation.risk !== "R1"
    || operation.dispatch !== "none"
    || Object.keys(operation.input.properties).length !== 0
    || operation.input.required.length !== 0
  ) {
    throw new Error(
      `plugin binding ${surfaceId} subject probe must reference one input-free observed dispatch-free R1 operation`,
    );
  }
  return Object.freeze({
    format,
    kind: subject.kind,
    probe: Object.freeze({
      operation: operationName,
      contractVersion: probe.contractVersion as number,
    }),
  });
}

function parseBinding(value: unknown): PortableProviderPluginBindingV1 {
  const binding = record(value, "plugin binding");
  exactKeys(
    binding,
    [
      "transport",
      "adapterId",
      "surfaceId",
      "origin",
      "authKinds",
      "subject",
      "operations",
    ],
    "plugin binding",
  );
  if (
    typeof binding.transport !== "string"
    || !portableProviderPluginTransports.includes(
      binding.transport as PortableProviderPluginTransport,
    )
  ) {
    throw new Error("plugin binding transport is unsupported");
  }
  const transport = binding.transport as PortableProviderPluginTransport;
  const adapterId = safePluginId(binding.adapterId, "plugin binding adapterId");
  const surfaceId = safePluginId(binding.surfaceId, "plugin binding surfaceId");
  const origin = exactPublicHttpsOrigin(
    binding.origin,
    `plugin binding ${surfaceId} origin`,
  );
  const authKinds = boundedArray(
    binding.authKinds,
    `plugin binding ${surfaceId} authKinds`,
    portableProviderPluginAuthKinds.length,
  ).map((kind) => {
    if (
      typeof kind !== "string"
      || !portableProviderPluginAuthKinds.includes(
        kind as PortableProviderPluginAuthKind,
      )
    ) {
      throw new Error(
        `plugin binding ${surfaceId} accepts an unsupported auth kind`,
      );
    }
    return kind as PortableProviderPluginAuthKind;
  });
  if (new Set(authKinds).size !== authKinds.length) {
    throw new Error(`plugin binding ${surfaceId} repeats an auth kind`);
  }
  const sortedAuthKinds = [...authKinds].sort();
  if (sortedAuthKinds.some((kind, index) => kind !== authKinds[index])) {
    throw new Error(`plugin binding ${surfaceId} auth kinds must be sorted`);
  }
  if (
    transport === "provider-api"
    && (
      sortedAuthKinds.length !== 1
      || sortedAuthKinds[0] !== "oauth-token-file"
    )
  ) {
    throw new Error(
      `plugin binding ${surfaceId} provider-api requires only oauth-token-file auth`,
    );
  }
  if (
    transport === "linked-device"
    && (
      sortedAuthKinds.length !== 1
      || sortedAuthKinds[0] !== "linked-device-store"
    )
  ) {
    throw new Error(
      `plugin binding ${surfaceId} linked-device requires only linked-device-store auth`,
    );
  }
  if (
    transport === "web-session-api"
    && sortedAuthKinds.some(
      (kind) =>
        kind === "oauth-token-file"
        || kind === "linked-device-store",
    )
  ) {
    throw new Error(
      `plugin binding ${surfaceId} web-session-api requires browser-session auth`,
    );
  }
  const operations = boundedArray(
    binding.operations,
    `plugin binding ${surfaceId} operations`,
    MAX_OPERATIONS_PER_BINDING,
  ).map((operation) => parseOperation(operation, transport));
  if (
    transport === "linked-device"
    && operations.some((operation) => operation.state !== "capture-required")
  ) {
    throw new Error(
      `plugin binding ${surfaceId} linked-device operations must remain capture-required until a portable lifecycle protocol is available`,
    );
  }
  const operationKeys = operations.map(
    (operation) => `${operation.name}@${operation.contractVersion}`,
  );
  if (new Set(operationKeys).size !== operationKeys.length) {
    throw new Error(
      `plugin binding ${surfaceId} repeats an operation contract`,
    );
  }
  if (
    new Set(operations.map((operation) => operation.name)).size
    !== operations.length
  ) {
    throw new Error(
      `plugin binding ${surfaceId} v1 permits only one current contract version per operation name`,
    );
  }
  const sortedOperations = [...operations].sort(
    (left, right) => {
      const nameOrder = compareCanonicalText(left.name, right.name);
      return nameOrder === 0
        ? left.contractVersion - right.contractVersion
        : nameOrder;
    },
  );
  if (
    sortedOperations.some(
      (operation, index) => operation !== operations[index],
    )
  ) {
    throw new Error(
      `plugin binding ${surfaceId} operations must be sorted by name and contract version`,
    );
  }
  const common = {
    adapterId,
    surfaceId,
    origin,
    authKinds: Object.freeze(sortedAuthKinds),
    subject: parseSubject(
      binding.subject,
      sortedOperations,
      transport,
      surfaceId,
    ),
  };
  if (transport === "provider-api") {
    return Object.freeze({
      ...common,
      transport,
      operations: Object.freeze(
        sortedOperations as readonly PortableProviderApiPluginOperationV1[],
      ),
    });
  }
  if (transport === "web-session-api") {
    return Object.freeze({
      ...common,
      transport,
      operations: Object.freeze(
        sortedOperations as readonly PortableWebSessionPluginOperationV1[],
      ),
    });
  }
  return Object.freeze({
    ...common,
    transport,
    operations: Object.freeze(
      sortedOperations as readonly PortableWebSessionPluginOperationV1[],
    ),
  });
}

function parseCapabilities(
  value: unknown,
  bindingOrigins: ReadonlySet<string>,
  bindings: readonly PortableProviderPluginBindingV1[],
): PortableProviderPluginCapabilitiesV1 {
  const capabilities = record(value, "plugin capabilities");
  exactKeys(
    capabilities,
    ["networkOrigins", "planFiles", "state", "sessionMaterial"],
    "plugin capabilities",
  );
  if (
    capabilities.planFiles !== "none"
    && capabilities.planFiles !== "read"
  ) {
    throw new Error("plugin capabilities planFiles must be none or read");
  }
  if (
    capabilities.state !== "none"
    && capabilities.state !== "namespaced"
  ) {
    throw new Error("plugin capabilities state must be none or namespaced");
  }
  if (
    !Array.isArray(capabilities.networkOrigins)
    || capabilities.networkOrigins.length > MAX_NETWORK_ORIGINS
  ) {
    throw new Error(
      `plugin capabilities networkOrigins must contain at most ${MAX_NETWORK_ORIGINS} entries`,
    );
  }
  const networkOrigins = capabilities.networkOrigins.map((origin, index) =>
    exactPublicHttpsOrigin(
      origin,
      `plugin capabilities networkOrigins[${index}]`,
    ),
  );
  if (new Set(networkOrigins).size !== networkOrigins.length) {
    throw new Error("plugin capabilities repeat a network origin");
  }
  const sortedOrigins = [...networkOrigins].sort();
  if (sortedOrigins.some((origin, index) => origin !== networkOrigins[index])) {
    throw new Error("plugin capability network origins must be sorted");
  }
  for (const origin of bindingOrigins) {
    if (!networkOrigins.includes(origin as `https://${string}`)) {
      throw new Error(
        `plugin capability network origins omit binding origin ${origin}`,
      );
    }
  }
  if (
    !Array.isArray(capabilities.sessionMaterial)
    || capabilities.sessionMaterial.length > MAX_SESSION_MATERIAL_NAMES
  ) {
    throw new Error(
      `plugin capabilities sessionMaterial must contain at most ${MAX_SESSION_MATERIAL_NAMES} entries`,
    );
  }
  const sessionMaterial = capabilities.sessionMaterial.map((name, index) => {
    const normalized = boundedString(
      name,
      `plugin capabilities sessionMaterial[${index}]`,
      128,
    );
    if (!materialNamePattern.test(normalized)) {
      throw new Error(
        "plugin session material names must use lowercase dotted or dashed identifiers",
      );
    }
    if (
      !portableProviderPluginSessionMaterialNames.includes(
        normalized as PortableProviderPluginSessionMaterialName,
      )
    ) {
      throw new Error(
        `plugin session material ${normalized} is unsupported by host API v1`,
      );
    }
    return normalized as PortableProviderPluginSessionMaterialName;
  });
  if (new Set(sessionMaterial).size !== sessionMaterial.length) {
    throw new Error("plugin capabilities repeat a session material name");
  }
  const sortedMaterial = [...sessionMaterial].sort();
  if (
    sortedMaterial.some((name, index) => name !== sessionMaterial[index])
  ) {
    throw new Error("plugin session material names must be sorted");
  }
  const executableSessionMaterial = new Set<
    PortableProviderPluginSessionMaterialName
  >();
  for (const binding of bindings) {
    if (
      binding.transport === "provider-api"
      && binding.authKinds.includes("oauth-token-file")
    ) {
      executableSessionMaterial.add("oauth-access-token");
    }
    if (
      binding.transport === "web-session-api"
      && binding.authKinds.some((kind) =>
        kind === "cookie-source"
        || kind === "cookies-file"
        || kind === "browser-profile"
      )
    ) {
      executableSessionMaterial.add("cookie-jar");
    }
  }
  for (const name of sortedMaterial) {
    if (!executableSessionMaterial.has(name)) {
      throw new Error(
        `plugin session material ${name} is not executable by any declared binding`,
      );
    }
  }
  return Object.freeze({
    networkOrigins: Object.freeze(sortedOrigins),
    planFiles: capabilities.planFiles,
    state: capabilities.state,
    sessionMaterial: Object.freeze(sortedMaterial),
  });
}

function parseFile(value: unknown): PortableProviderPluginFileV1 {
  const file = record(value, "plugin file");
  exactKeys(file, ["path", "kind", "bytes", "sha256"], "plugin file");
  const path = safePackagePath(file.path, "plugin file path");
  if (file.kind !== "runtime" && file.kind !== "data") {
    throw new Error(`plugin file ${path} kind must be runtime or data`);
  }
  if (
    !Number.isSafeInteger(file.bytes)
    || (file.bytes as number) < 1
    || (file.bytes as number) > MAX_PLUGIN_FILE_BYTES
  ) {
    throw new Error(
      `plugin file ${path} bytes must be between 1 and ${MAX_PLUGIN_FILE_BYTES}`,
    );
  }
  const sha256 = safeSha256(file.sha256, `plugin file ${path} sha256`);
  return Object.freeze({
    path,
    kind: file.kind,
    bytes: file.bytes as number,
    sha256,
  });
}

function runtimeRequireReference(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === "require";
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "require";
  }
  return (
    ts.isElementAccessExpression(node)
    && node.argumentExpression !== undefined
    && ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === "require"
  );
}

function assertSelfContainedPortableRuntime(
  path: string,
  bytes: Uint8Array,
): void {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`portable plugin runtime ${path} must be valid UTF-8`);
  }

  let imports: readonly {
    readonly kind: string;
    readonly path: string;
  }[];
  try {
    imports = portableRuntimeImportScanner.scanImports(source);
  } catch {
    throw new Error(
      `portable plugin runtime ${path} must contain valid JavaScript`,
    );
  }
  for (const imported of imports) {
    if (imported.kind === "dynamic-import") {
      throw new Error(
        `portable plugin runtime ${path} must not use dynamic import`,
      );
    }
    if (imported.kind === "require-call") {
      throw new Error(
        `portable plugin runtime ${path} must not use require`,
      );
    }
    if (
      imported.kind !== "import-statement"
      || !allowedPortableRuntimeImports.has(imported.path)
    ) {
      throw new Error(
        `portable plugin runtime ${path} imports unsupported module ${imported.path}`,
      );
    }
  }

  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  let nonLiteralImport = false;
  let requireReference = false;
  const visit = (node: ts.Node): void => {
    if (nonLiteralImport || requireReference) return;
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      nonLiteralImport = true;
      return;
    }
    if (runtimeRequireReference(node)) {
      requireReference = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (nonLiteralImport) {
    throw new Error(
      `portable plugin runtime ${path} must not use dynamic import`,
    );
  }
  if (requireReference) {
    throw new Error(
      `portable plugin runtime ${path} must not use require`,
    );
  }
}

function parseProvenance(
  value: unknown,
): PortableProviderPluginProvenanceV1 {
  const provenance = record(value, "plugin provenance");
  if (provenance.kind === "local") {
    exactKeys(provenance, ["kind"], "local plugin provenance");
    return Object.freeze({ kind: "local" });
  }
  if (provenance.kind !== "git") {
    throw new Error("plugin provenance kind must be local or git");
  }
  exactKeys(
    provenance,
    ["kind", "repository", "revision"],
    "git plugin provenance",
  );
  const repository = exactHttpsRepository(provenance.repository);
  const repositoryHostname = new URL(repository).hostname.toLowerCase();
  if (
    !repository.endsWith(".git")
    && repositoryHostname !== "github.com"
    && repositoryHostname !== "gitlab.com"
  ) {
    throw new Error(
      "plugin git provenance repository must identify an HTTPS repository",
    );
  }
  const revision = boundedString(
    provenance.revision,
    "plugin provenance revision",
    64,
  );
  if (!gitRevisionPattern.test(revision)) {
    throw new Error(
      "plugin git provenance revision must be a full lowercase commit digest",
    );
  }
  return Object.freeze({
    kind: "git",
    repository,
    revision,
  });
}

function parseManifestOrThrow(
  value: unknown,
): PortableProviderPluginManifestV1 {
  const manifest = record(value, "portable provider plugin manifest");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "hostApiVersion",
      "id",
      "version",
      "displayName",
      "runtime",
      "provenance",
      "capabilities",
      "bindings",
      "files",
    ],
    "portable provider plugin manifest",
  );
  if (
    manifest.schemaVersion
    !== PORTABLE_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error(
      `portable provider plugin schemaVersion must be ${PORTABLE_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (manifest.hostApiVersion !== PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION) {
    throw new Error(
      `portable provider plugin hostApiVersion must be ${PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION}`,
    );
  }
  const id = safePluginId(manifest.id, "plugin ID");
  const version = safeVersion(manifest.version);
  const displayName = boundedString(manifest.displayName, "plugin displayName", 160);
  const runtime = record(manifest.runtime, "plugin runtime");
  exactKeys(runtime, ["kind", "entrypoint"], "plugin runtime");
  if (runtime.kind !== "bun-js") {
    throw new Error("plugin runtime kind must be bun-js");
  }
  const entrypoint = safePackagePath(
    runtime.entrypoint,
    "plugin runtime entrypoint",
  );
  if (!entrypoint.endsWith(".mjs")) {
    throw new Error("plugin runtime entrypoint must be a bundled .mjs file");
  }
  const provenance = parseProvenance(manifest.provenance);
  const bindings = boundedArray(
    manifest.bindings,
    "plugin bindings",
    MAX_BINDINGS,
  ).map(parseBinding);
  const routeKeys = bindings.map(
    (binding) => `${binding.transport}/${binding.surfaceId}`,
  );
  if (new Set(routeKeys).size !== routeKeys.length) {
    throw new Error("portable provider plugin repeats a transport route");
  }
  const adapterIds = bindings.map((binding) => binding.adapterId);
  if (new Set(adapterIds).size !== adapterIds.length) {
    throw new Error("portable provider plugin repeats an adapter ID");
  }
  const sortedBindings = [...bindings].sort((left, right) =>
    compareCanonicalText(
      `${left.transport}/${left.surfaceId}`,
      `${right.transport}/${right.surfaceId}`,
    ),
  );
  if (
    sortedBindings.some((binding, index) => binding !== bindings[index])
  ) {
    throw new Error("plugin bindings must be sorted by transport and surface");
  }
  const bindingOrigins = new Set(bindings.map((binding) => binding.origin));
  const capabilities = parseCapabilities(
    manifest.capabilities,
    bindingOrigins,
    bindings,
  );
  const files = boundedArray(
    manifest.files,
    "plugin files",
    MAX_PLUGIN_FILES,
  ).map(parseFile);
  const pathKeys = files.map((file) => file.path);
  const caseFoldedPathKeys = pathKeys.map((path) => path.toLowerCase());
  if (
    new Set(pathKeys).size !== pathKeys.length
    || new Set(caseFoldedPathKeys).size !== caseFoldedPathKeys.length
  ) {
    throw new Error("portable provider plugin repeats a file path");
  }
  const sortedFiles = [...files].sort((left, right) =>
    compareCanonicalText(left.path, right.path),
  );
  if (sortedFiles.some((file, index) => file !== files[index])) {
    throw new Error("plugin files must be sorted by path");
  }
  const payloadBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (payloadBytes > MAX_PLUGIN_PAYLOAD_BYTES) {
    throw new Error(
      `plugin payload exceeds ${MAX_PLUGIN_PAYLOAD_BYTES} bytes`,
    );
  }
  const runtimeFiles = files.filter((file) => file.kind === "runtime");
  if (
    runtimeFiles.length !== 1
    || runtimeFiles[0]?.path !== entrypoint
  ) {
    throw new Error(
      "plugin package must declare exactly one runtime file, its entrypoint",
    );
  }
  return Object.freeze({
    schemaVersion: PORTABLE_PROVIDER_PLUGIN_MANIFEST_SCHEMA_VERSION,
    hostApiVersion: PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION,
    id,
    version,
    displayName,
    runtime: Object.freeze({ kind: "bun-js", entrypoint }),
    provenance,
    capabilities,
    bindings: Object.freeze(sortedBindings),
    files: Object.freeze(sortedFiles),
  });
}

export function parsePortableProviderPluginManifest(
  value: unknown,
): PortableProviderPluginManifestResult {
  try {
    return { ok: true, value: parseManifestOrThrow(value) };
  } catch (error) {
    return {
      ok: false,
      issues: Object.freeze([
        error instanceof Error ? error.message : "invalid portable provider plugin manifest",
      ]),
    };
  }
}

export function renderPortableProviderPluginManifest(
  manifest: PortableProviderPluginManifestV1,
): string {
  const parsed = parsePortableProviderPluginManifest(manifest);
  if (!parsed.ok) {
    throw new Error(`invalid portable provider plugin manifest: ${parsed.issues.join("; ")}`);
  }
  return `${JSON.stringify(parsed.value, null, 2)}\n`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameRootStats(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

type BoundPathIdentity = {
  readonly device: string;
  readonly inode: string;
};

type BoundPathDirectoryEntry = {
  readonly name: string;
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly identity: BoundPathIdentity;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
};

type BoundPathTreeEntry = Omit<BoundPathDirectoryEntry, "name"> & {
  readonly path: string;
};

type BoundPathFileExpectation = Pick<
  BoundPathDirectoryEntry,
  "identity" | "size" | "mtimeNs" | "ctimeNs"
>;

type BoundPathHelperOperation =
  | {
      readonly kind: "list-directory";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly BoundPathIdentity[];
      readonly maximumEntries: number;
    }
  | {
      readonly kind: "read-file";
      readonly segments: readonly string[];
      readonly directoryExpectations: readonly BoundPathIdentity[];
      readonly maximumBytes: number;
      readonly fileExpectation: BoundPathFileExpectation;
    }
  | {
      readonly kind: "snapshot-tree";
      readonly maximumEntries: number;
      readonly maximumDirectories: number;
      readonly maximumDepth: number;
      readonly maximumPathBytes: number;
    }
  | {
      readonly kind: "batch-read-files";
      readonly files: readonly {
        readonly segments: readonly string[];
        readonly directoryExpectations: readonly BoundPathIdentity[];
        readonly maximumBytes: number;
        readonly fileExpectation: BoundPathFileExpectation;
      }[];
      readonly maximumTotalBytes: number;
    };

function rootIdentity(
  stats: Pick<BigIntStats, "dev" | "ino">,
): BoundPathIdentity {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
  };
}

function sameBoundPathIdentity(
  left: BoundPathIdentity,
  right: BoundPathIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function parseBoundPathIdentity(
  value: unknown,
  label: string,
): BoundPathIdentity {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["device", "inode"], label);
  if (
    typeof value.device !== "string"
    || !/^[0-9]{1,40}$/u.test(value.device)
    || typeof value.inode !== "string"
    || !/^[0-9]{1,40}$/u.test(value.inode)
  ) throw new Error(`${label} is invalid`);
  return {
    device: value.device,
    inode: value.inode,
  };
}

function parseBoundPathTreeEntry(value: unknown): BoundPathTreeEntry {
  if (!isRecord(value)) throw new Error("path helper tree entry must be an object");
  exactKeys(
    value,
    ["path", "kind", "identity", "size", "mtimeNs", "ctimeNs"],
    "path helper tree entry",
  );
  if (
    typeof value.path !== "string"
    || value.path === ""
    || value.path.startsWith("/")
    || value.path.endsWith("/")
    || value.path.includes("\\")
    || value.path.includes("\u0000")
    || Buffer.byteLength(value.path, "utf8") > 512
    || value.path.split("/").some((segment) =>
      segment === "" || segment === "." || segment === "..")
    || (
      value.kind !== "file"
      && value.kind !== "directory"
      && value.kind !== "symbolic-link"
      && value.kind !== "other"
    )
    || typeof value.size !== "string"
    || !/^[0-9]{1,40}$/u.test(value.size)
    || typeof value.mtimeNs !== "string"
    || !/^-?[0-9]{1,40}$/u.test(value.mtimeNs)
    || typeof value.ctimeNs !== "string"
    || !/^-?[0-9]{1,40}$/u.test(value.ctimeNs)
  ) throw new Error("path helper returned an invalid tree entry");
  return {
    path: value.path,
    kind: value.kind,
    identity: parseBoundPathIdentity(value.identity, "path helper tree entry identity"),
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function runBoundPathHelper(
  root: string,
  expectedRoot: BoundPathIdentity,
  operation: BoundPathHelperOperation,
): unknown {
  pathHelperSpawnObserverForTest?.();
  const child = spawnSync(process.execPath, [
    "--no-env-file",
    "--no-install",
    "--no-macros",
    "--no-addons",
    `--config=${pathHelperConfigPath}`,
    pathHelperPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { NODE_ENV: "production" },
    input: JSON.stringify({
      schemaVersion: 1,
      requestId: randomUUID(),
      expected: expectedRoot,
      operation,
    }),
    maxBuffer: operation.kind === "read-file"
      ? Math.max(1024 * 1024, Math.ceil(operation.maximumBytes / 3) * 4 + 64 * 1024)
      : operation.kind === "batch-read-files"
        ? Math.ceil(operation.maximumTotalBytes / 3) * 4 + 1024 * 1024
        : 8 * 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  let current: BigIntStats;
  try {
    current = lstatSync(root, { bigint: true });
  } catch {
    throw new Error("portable provider plugin package root disappeared during verification");
  }
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || !sameBoundPathIdentity(rootIdentity(current), expectedRoot)
  ) {
    throw new Error("portable provider plugin package root changed identity during verification");
  }
  if (child.error !== undefined) {
    throw new Error("bound package path helper failed to start", { cause: child.error });
  }
  if (child.status !== 0) {
    const detail = child.stderr.trim().slice(0, 512);
    throw new Error(
      detail === ""
        ? "bound package path helper rejected the operation"
        : detail,
    );
  }
  try {
    return JSON.parse(child.stdout) as unknown;
  } catch (error) {
    throw new Error("bound package path helper returned invalid JSON", { cause: error });
  }
}

function snapshotBoundPackageTree(
  root: string,
  expectedRoot: BoundPathIdentity,
): readonly BoundPathTreeEntry[] {
  const response = runBoundPathHelper(root, expectedRoot, {
    kind: "snapshot-tree",
    maximumEntries: MAX_PLUGIN_PACKAGE_ENTRIES,
    maximumDirectories: MAX_PLUGIN_DIRECTORIES,
    maximumDepth: 15,
    maximumPathBytes: 512,
  });
  if (!isRecord(response)) throw new Error("path helper tree response must be an object");
  exactKeys(
    response,
    ["ok", "identity", "treeEntries"],
    "path helper tree response",
  );
  if (response.ok !== true || !Array.isArray(response.treeEntries)) {
    throw new Error("path helper returned a malformed tree response");
  }
  const identity = parseBoundPathIdentity(response.identity, "path helper root identity");
  if (!sameBoundPathIdentity(identity, expectedRoot)) {
    throw new Error("path helper tree response came from the wrong package root");
  }
  if (response.treeEntries.length > MAX_PLUGIN_PACKAGE_ENTRIES) {
    throw new Error("path helper tree response exceeds its entry bound");
  }
  const entries = response.treeEntries.map(parseBoundPathTreeEntry);
  if (
    entries.some((entry, index) =>
      index > 0
      && compareCanonicalText(entries[index - 1]!.path, entry.path) >= 0)
  ) {
    throw new Error("path helper tree response is not strictly sorted");
  }
  return Object.freeze(entries);
}

function readBoundPackageFile(
  root: string,
  expectedRoot: BoundPathIdentity,
  relativePath: string,
  directoryExpectations: readonly BoundPathIdentity[],
  fileExpectation: BoundPathFileExpectation,
  maximumBytes: number,
  label: string,
): Buffer {
  let response: unknown;
  try {
    response = runBoundPathHelper(root, expectedRoot, {
      kind: "read-file",
      segments: relativePath.split("/"),
      directoryExpectations,
      fileExpectation: {
        identity: fileExpectation.identity,
        size: fileExpectation.size,
        mtimeNs: fileExpectation.mtimeNs,
        ctimeNs: fileExpectation.ctimeNs,
      },
      maximumBytes,
    });
  } catch (error) {
    throw new Error(`${label} could not be safely read`, { cause: error });
  }
  if (!isRecord(response)) throw new Error("path helper read response must be an object");
  exactKeys(
    response,
    ["ok", "identity", "contentBase64"],
    "path helper read response",
  );
  if (response.ok !== true || typeof response.contentBase64 !== "string") {
    throw new Error("path helper returned a malformed read response");
  }
  const identity = parseBoundPathIdentity(response.identity, "path helper root identity");
  if (!sameBoundPathIdentity(identity, expectedRoot)) {
    throw new Error("path helper read response came from the wrong package root");
  }
  const maximumEncodedBytes = Math.ceil(maximumBytes / 3) * 4;
  if (
    response.contentBase64.length > maximumEncodedBytes
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      response.contentBase64,
    )
  ) throw new Error("path helper returned malformed bounded file content");
  const bytes = Buffer.from(response.contentBase64, "base64");
  if (
    bytes.byteLength < 1
    || bytes.byteLength > maximumBytes
    || bytes.toString("base64") !== response.contentBase64
  ) {
    throw new Error(
      `${label} must be a regular file between 1 and ${maximumBytes} bytes`,
    );
  }
  return bytes;
}

function readBoundPackageFiles(
  root: string,
  expectedRoot: BoundPathIdentity,
  files: readonly {
    readonly path: string;
    readonly directoryExpectations: readonly BoundPathIdentity[];
    readonly fileExpectation: BoundPathFileExpectation;
    readonly maximumBytes: number;
  }[],
  maximumTotalBytes: number,
): readonly Buffer[] {
  const response = runBoundPathHelper(root, expectedRoot, {
    kind: "batch-read-files",
    files: files.map((file) => ({
      segments: file.path.split("/"),
      directoryExpectations: file.directoryExpectations,
      maximumBytes: file.maximumBytes,
      fileExpectation: {
        identity: file.fileExpectation.identity,
        size: file.fileExpectation.size,
        mtimeNs: file.fileExpectation.mtimeNs,
        ctimeNs: file.fileExpectation.ctimeNs,
      },
    })),
    maximumTotalBytes,
  });
  if (!isRecord(response)) throw new Error("path helper batch read response must be an object");
  exactKeys(
    response,
    ["ok", "identity", "fileContentsBase64"],
    "path helper batch read response",
  );
  if (
    response.ok !== true
    || !Array.isArray(response.fileContentsBase64)
    || response.fileContentsBase64.length !== files.length
  ) throw new Error("path helper returned a malformed batch read response");
  const identity = parseBoundPathIdentity(response.identity, "path helper root identity");
  if (!sameBoundPathIdentity(identity, expectedRoot)) {
    throw new Error("path helper batch read response came from the wrong package root");
  }
  let totalBytes = 0;
  return Object.freeze(response.fileContentsBase64.map((encoded, index) => {
    const file = files[index];
    if (file === undefined || typeof encoded !== "string") {
      throw new Error("path helper returned malformed batch file content");
    }
    const maximumEncodedBytes = Math.ceil(file.maximumBytes / 3) * 4;
    if (
      encoded.length > maximumEncodedBytes
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        encoded,
      )
    ) throw new Error("path helper returned malformed bounded batch file content");
    const bytes = Buffer.from(encoded, "base64");
    totalBytes += bytes.byteLength;
    if (
      bytes.byteLength < 1
      || bytes.byteLength > file.maximumBytes
      || totalBytes > maximumTotalBytes
      || bytes.toString("base64") !== encoded
    ) throw new Error("path helper batch file content violates its byte bound");
    return bytes;
  }));
}

type WalkedPackageEntry = BoundPathTreeEntry & {
  readonly directoryExpectations: readonly BoundPathIdentity[];
};

type WalkedPackage = {
  readonly files: readonly string[];
  readonly directories: readonly string[];
  readonly entries: readonly WalkedPackageEntry[];
  readonly entryByPath: ReadonlyMap<string, WalkedPackageEntry>;
};

function walkPackage(
  root: string,
  expectedRoot: BoundPathIdentity,
): WalkedPackage {
  const files: string[] = [];
  const directories: string[] = [];
  const entries: WalkedPackageEntry[] = [];
  const entryByPath = new Map<string, WalkedPackageEntry>();
  const treeEntries = snapshotBoundPackageTree(root, expectedRoot);
  for (const entry of treeEntries) {
    if (entryByPath.has(entry.path)) {
      throw new Error(
        `portable provider plugin package contains duplicate entry ${entry.path}`,
      );
    }
    const segments = entry.path.split("/");
    const directoryExpectations: BoundPathIdentity[] = [];
    for (let index = 1; index < segments.length; index += 1) {
      const parentPath = segments.slice(0, index).join("/");
      const parent = entryByPath.get(parentPath);
      if (parent === undefined || parent.kind !== "directory") {
        throw new Error(
          `portable provider plugin tree omits directory ${parentPath}`,
        );
      }
      directoryExpectations.push(parent.identity);
    }
    if (entry.kind === "symbolic-link") {
      throw new Error(
        `portable provider plugin package contains symlink ${entry.path}`,
      );
    }
    const walkedEntry = Object.freeze({
      ...entry,
      directoryExpectations: Object.freeze(directoryExpectations),
    });
    entries.push(walkedEntry);
    entryByPath.set(entry.path, walkedEntry);
    if (entry.kind === "directory") {
      safePackagePath(`${entry.path}/placeholder`, "plugin directory path");
      directories.push(entry.path);
      if (directories.length > MAX_PLUGIN_DIRECTORIES) {
        throw new Error(
          `portable provider plugin package exceeds ${MAX_PLUGIN_DIRECTORIES} directories`,
        );
      }
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(
        `portable provider plugin package contains unsupported entry ${entry.path}`,
      );
    }
    if (!portableProviderPluginManifestNames.has(entry.path)) {
      safePackagePath(entry.path, "plugin package file path");
    }
    files.push(entry.path);
    if (files.length > MAX_PLUGIN_FILES + 1) {
      throw new Error(
        `portable provider plugin package exceeds ${MAX_PLUGIN_FILES} declared files`,
      );
    }
  }
  return {
    files: Object.freeze(files.sort(compareCanonicalText)),
    directories: Object.freeze(directories.sort(compareCanonicalText)),
    entries: Object.freeze(entries),
    entryByPath,
  };
}

function sameWalkedPackage(
  left: WalkedPackage,
  right: WalkedPackage,
): boolean {
  return (
    left.entries.length === right.entries.length
    && left.entries.every((entry, index) => {
      const candidate = right.entries[index];
      return candidate !== undefined
        && entry.path === candidate.path
        && entry.kind === candidate.kind
        && sameBoundPathIdentity(entry.identity, candidate.identity)
        && entry.size === candidate.size
        && entry.mtimeNs === candidate.mtimeNs
        && entry.ctimeNs === candidate.ctimeNs;
    })
  );
}

function expectedDirectories(paths: readonly string[]): readonly string[] {
  const expected = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expected.add(segments.slice(0, index).join("/"));
    }
  }
  return [...expected].sort();
}

export function verifyPortableProviderPluginPackageDirectory(
  path: string,
): VerifiedPortableProviderPluginPackage {
  const root = resolve(path);
  let rootStats: BigIntStats;
  try {
    rootStats = lstatSync(root, { bigint: true });
  } catch {
    throw new Error("portable provider plugin package directory does not exist");
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(
      "portable provider plugin package root must be a regular non-symlink directory",
    );
  }
  const expectedRoot = rootIdentity(rootStats);
  const walked = walkPackage(root, expectedRoot);
  const manifestNames = walked.files.filter((file) =>
    portableProviderPluginManifestNames.has(file)
  );
  if (manifestNames.length === 0) {
    throw new Error(
      `portable provider plugin package is missing ${PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME}`,
    );
  }
  if (manifestNames.length > 1) {
    throw new Error(
      `portable provider plugin package must contain exactly one of ${[...portableProviderPluginManifestNames].join(" or ")}`,
    );
  }
  const manifestName = manifestNames[0];
  if (manifestName === undefined) {
    throw new Error("portable provider plugin package manifest selection failed");
  }
  const manifestEntry = walked.entryByPath.get(
    manifestName,
  );
  if (manifestEntry === undefined || manifestEntry.kind !== "file") {
    throw new Error(
      `portable provider plugin package is missing ${manifestName}`,
    );
  }
  const manifestBytes = readBoundPackageFile(
    root,
    expectedRoot,
    manifestName,
    manifestEntry.directoryExpectations,
    manifestEntry,
    MAX_MANIFEST_BYTES,
    "portable provider plugin manifest",
  );
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("portable provider plugin manifest must contain valid UTF-8 JSON");
  }
  const parsed = parsePortableProviderPluginManifest(manifestValue);
  if (!parsed.ok) {
    throw new Error(
      `invalid portable provider plugin manifest: ${parsed.issues.join("; ")}`,
    );
  }
  const canonicalManifest = renderPortableProviderPluginManifest(parsed.value);
  if (!manifestBytes.equals(Buffer.from(canonicalManifest, "utf8"))) {
    throw new Error(
      "portable provider plugin manifest must use canonical rendered JSON",
    );
  }
  const expectedFiles = [
    manifestName,
    ...parsed.value.files.map((file) => file.path),
  ].sort();
  const actualFiles = [...walked.files].sort();
  if (
    expectedFiles.length !== actualFiles.length
    || expectedFiles.some((file, index) => file !== actualFiles[index])
  ) {
    throw new Error(
      "portable provider plugin package files differ from its exact manifest",
    );
  }
  const declaredDirectories = expectedDirectories(
    parsed.value.files.map((file) => file.path),
  );
  const actualDirectories = [...walked.directories].sort();
  if (
    declaredDirectories.length !== actualDirectories.length
    || declaredDirectories.some(
      (directory, index) => directory !== actualDirectories[index],
    )
  ) {
    throw new Error(
      "portable provider plugin package contains an undeclared or empty directory",
    );
  }
  const walkedFiles = parsed.value.files.map((file) => {
    const walkedEntry = walked.entryByPath.get(file.path);
    if (walkedEntry === undefined || walkedEntry.kind !== "file") {
      throw new Error(
        `portable provider plugin package no longer contains file ${file.path}`,
      );
    }
    return walkedEntry;
  });
  const payloadFileBytes = readBoundPackageFiles(
    root,
    expectedRoot,
    walkedFiles.map((walkedEntry) => ({
      path: walkedEntry.path,
      directoryExpectations: walkedEntry.directoryExpectations,
      fileExpectation: walkedEntry,
      maximumBytes: MAX_PLUGIN_FILE_BYTES,
    })),
    MAX_PLUGIN_PAYLOAD_BYTES,
  );
  let payloadBytes = 0;
  const files = parsed.value.files.map((file, index) => {
    const bytes = payloadFileBytes[index];
    if (bytes === undefined) {
      throw new Error(`portable provider plugin file ${file.path} was not read`);
    }
    payloadBytes += bytes.byteLength;
    if (bytes.byteLength !== file.bytes) {
      throw new Error(
        `portable provider plugin file ${file.path} byte length does not match its manifest`,
      );
    }
    const digest = sha256(bytes);
    if (digest !== file.sha256) {
      throw new Error(
        `portable provider plugin file ${file.path} digest does not match its manifest`,
      );
    }
    return Object.freeze({
      path: file.path,
      kind: file.kind,
      bytes,
      sha256: digest,
    });
  });
  const runtimeFile = files.find((file) => file.kind === "runtime");
  if (runtimeFile === undefined) {
    throw new Error("portable provider plugin runtime file was not read");
  }
  assertSelfContainedPortableRuntime(runtimeFile.path, runtimeFile.bytes);
  if (payloadBytes > MAX_PLUGIN_PAYLOAD_BYTES) {
    throw new Error(
      `portable provider plugin payload exceeds ${MAX_PLUGIN_PAYLOAD_BYTES} bytes`,
    );
  }
  const rootAfter = lstatSync(root, { bigint: true });
  const walkedAfter = walkPackage(root, expectedRoot);
  if (
    !sameRootStats(rootStats, rootAfter)
    || !sameWalkedPackage(walked, walkedAfter)
  ) {
    throw new Error(
      "portable provider plugin package changed while it was being verified",
    );
  }
  const bundleHash = createHash("sha256")
    .update("io-portable-provider-plugin-v1\0")
    .update(canonicalManifest);
  for (const file of files) {
    bundleHash
      .update("\0")
      .update(file.path)
      .update("\0")
      .update(file.kind)
      .update("\0")
      .update(file.sha256);
  }
  const verified = Object.freeze({
    root,
    manifest: parsed.value,
    manifestBytes: Buffer.from(manifestBytes),
    manifestSha256: sha256(manifestBytes),
    bundleSha256: bundleHash.digest("hex"),
    payloadBytes,
    files: Object.freeze(files),
  });
  verifiedPortableProviderPluginPackages.add(verified);
  return verified;
}
