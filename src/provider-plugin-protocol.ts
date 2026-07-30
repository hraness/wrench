import { isIP } from "node:net";

import {
  PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION,
  isPortableProviderPluginVersion,
  portableProviderPluginSessionMaterialNames,
  type PortableProviderPluginAuthKind,
  type PortableProviderPluginCapabilitiesV1,
  type PortableProviderPluginSessionMaterialName,
  type PortableProviderPluginTransport,
} from "./provider-plugin-package";

export const PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION = 1 as const;
export const MAX_PORTABLE_PROVIDER_PLUGIN_FRAME_BYTES = 1024 * 1024;

export type PortablePluginJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PortablePluginJsonValue[]
  | PortablePluginJsonObject;

export interface PortablePluginJsonObject {
  readonly [key: string]: PortablePluginJsonValue;
}

export type PortablePluginIdentity = {
  readonly id: string;
  readonly version: string;
  readonly bundleSha256: string;
};

export type PortablePluginRoute = {
  readonly transport: PortableProviderPluginTransport;
  readonly surfaceId: string;
  readonly operation: string;
  readonly contractVersion: number;
};

export type PortablePluginInvocationAuth = {
  readonly kind: PortableProviderPluginAuthKind;
  readonly handle: string;
  readonly subject?: string;
};

export type PortablePluginInvocationFile = {
  readonly input: string;
  readonly handle: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly sha256: string;
};

export type PortablePluginCredentialSink =
  | {
      readonly kind: "cookie-jar";
    }
  | {
      readonly kind: "header";
      readonly name: "authorization";
    };

export type PortablePluginCredentialBinding = {
  readonly handle: string;
  readonly sink: PortablePluginCredentialSink;
};

export type PortablePluginHttpBody =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "utf8";
      readonly mediaType: string;
      readonly text: string;
    }
  | {
      readonly kind: "base64";
      readonly mediaType: string;
      readonly data: string;
    };

export type PortablePluginCapabilityRequest =
  | {
      readonly kind: "dispatch.begin";
      readonly dispatchId: string;
    }
  | {
      readonly kind: "dispatch.verify";
      readonly dispatchHandle: string;
      readonly proof: PortablePluginJsonObject;
    }
  | {
      readonly kind: "http.request";
      readonly method: "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
      readonly url: string;
      readonly headers: readonly {
        readonly name: string;
        readonly value: string;
      }[];
      readonly credentials: readonly PortablePluginCredentialBinding[];
      readonly body: PortablePluginHttpBody;
      readonly redirect: "error";
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly dispatchHandle?: string;
    }
  | {
      readonly kind: "file.read";
      readonly handle: string;
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly kind: "state.read";
      readonly key: string;
      /** Opt in to the additive exact-byte version result. */
      readonly includeVersion?: true;
    }
  | {
      readonly kind: "state.write";
      readonly key: string;
      readonly value: PortablePluginJsonValue;
      /** Exact-byte version returned by state.read; null creates only if absent. */
      readonly expectedVersion?: string | null;
    }
  | {
      readonly kind: "state.delete";
      readonly key: string;
      /** Exact-byte version returned by state.read. */
      readonly expectedVersion?: string;
    }
  | {
      readonly kind: "session.acquire";
      readonly name: PortableProviderPluginSessionMaterialName;
    }
  | {
      readonly kind: "log.write";
      readonly level: "debug" | "info" | "warn";
      readonly message: string;
    };

export type PortablePluginCapabilityResult =
  | {
      readonly kind: "dispatch.begin";
      readonly dispatchHandle: string;
    }
  | {
      readonly kind: "dispatch.verify";
      readonly verified: true;
    }
  | {
      readonly kind: "http.request";
      readonly status: number;
      readonly headers: readonly {
        readonly name: string;
        readonly value: string;
      }[];
      readonly body:
        | {
            readonly kind: "utf8";
            readonly text: string;
          }
        | {
            readonly kind: "base64";
            readonly data: string;
          };
      readonly finalUrl: string;
    }
  | {
      readonly kind: "file.read";
      readonly data: string;
      readonly eof: boolean;
    }
  | {
      readonly kind: "state.read";
      readonly found: false;
    }
  | {
      readonly kind: "state.read";
      readonly found: true;
      readonly value: PortablePluginJsonValue;
    }
  | {
      readonly kind: "state.write";
      readonly stored: true;
    }
  | {
      readonly kind: "state.delete";
      readonly removed: boolean;
    }
  | {
      readonly kind: "session.acquire";
      readonly materialHandle: string;
    }
  | {
      readonly kind: "log.write";
      readonly accepted: true;
    }
  | PortablePluginVersionedStateResult;

/** Additive result shape emitted by the host for version-aware state peers. */
export type PortablePluginVersionedStateResult =
  | {
      readonly kind: "state.read";
      readonly found: false;
      readonly version: null;
    }
  | {
      readonly kind: "state.read";
      readonly found: true;
      readonly value: PortablePluginJsonValue;
      readonly version: string;
    }
  | {
      readonly kind: "state.write";
      readonly stored: true;
      readonly version: string;
    };

export type PortableProviderPluginHostMessage =
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "host.hello";
      readonly hostVersion: string;
      readonly hostApiVersion: typeof PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION;
      readonly plugin: PortablePluginIdentity;
      readonly granted: PortableProviderPluginCapabilitiesV1;
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "host.invoke";
      readonly invocationId: string;
      readonly route: PortablePluginRoute;
      readonly input: PortablePluginJsonObject;
      readonly auth: PortablePluginInvocationAuth;
      readonly files: readonly PortablePluginInvocationFile[];
      readonly timeoutMs: number;
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "host.capability.result";
      readonly invocationId: string;
      readonly requestId: string;
      readonly result: PortablePluginCapabilityResult;
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "host.capability.error";
      readonly invocationId: string;
      readonly requestId: string;
      readonly capability: PortablePluginCapabilityRequest["kind"];
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "host.cancel";
      readonly invocationId: string;
      readonly reason: "user" | "timeout" | "shutdown";
    };

export type PortableProviderPluginProcessMessage =
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "plugin.ready";
      readonly plugin: PortablePluginIdentity;
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "plugin.capability.request";
      readonly invocationId: string;
      readonly requestId: string;
      readonly request: PortablePluginCapabilityRequest;
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "plugin.result";
      readonly invocationId: string;
      readonly output: PortablePluginJsonValue;
      readonly finalUrl: string | null;
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "plugin.error";
      readonly stage: "startup";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "plugin.error";
      readonly stage: "invocation";
      readonly invocationId: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly protocolVersion: typeof PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION;
      readonly kind: "plugin.cancelled";
      readonly invocationId: string;
    };

export type PortableProviderPluginMessage =
  | PortableProviderPluginHostMessage
  | PortableProviderPluginProcessMessage;

export type PortableProviderPluginMessageResult =
  | {
      readonly ok: true;
      readonly value: PortableProviderPluginMessage;
    }
  | {
      readonly ok: false;
      readonly issues: readonly string[];
    };

const MAX_JSON_DEPTH = 32;
const MAX_JSON_ARRAY_ITEMS = 10_000;
const MAX_JSON_OBJECT_KEYS = 1_000;
const MAX_JSON_STRING_BYTES = 512 * 1024;
const MAX_HEADERS = 128;
const MAX_CREDENTIAL_BINDINGS = 32;
const MAX_INVOCATION_FILES = 128;
const MAX_HTTP_BODY_BYTES = 768 * 1024;
const MAX_HTTP_OUTPUT_BYTES = 512 * 1024;
const MAX_HTTP_BASE64_OUTPUT_TEXT_BYTES =
  4 * Math.ceil(MAX_HTTP_OUTPUT_BYTES / 3);

const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const pluginIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const operationPattern =
  /^[a-z][a-z0-9-]{0,39}(?:\.[a-z][a-z0-9-]{0,39}){1,3}$/u;
const materialNamePattern =
  /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const stateKeyPattern =
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const mediaTypePattern =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[A-Za-z0-9!#$&^_.+*= -]+)?$/u;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const requestCapabilityKinds = [
  "dispatch.begin",
  "dispatch.verify",
  "http.request",
  "file.read",
  "state.read",
  "state.write",
  "state.delete",
  "session.acquire",
  "log.write",
] as const satisfies readonly PortablePluginCapabilityRequest["kind"][];

const forbiddenRawCredentialHeaders = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

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

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
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
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
  options: {
    readonly allowEmpty?: boolean;
    readonly allowNewlines?: boolean;
  } = {},
): string {
  if (
    typeof value !== "string"
    || (!options.allowEmpty && value.length < 1)
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || value.includes("\0")
    || (!options.allowNewlines && /[\r\n]/u.test(value))
  ) {
    throw new Error(`${label} must be bounded UTF-8 text`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function boundedToken(value: unknown, label: string): string {
  const token = boundedString(value, label, 128);
  if (!tokenPattern.test(token)) throw new Error(`${label} is malformed`);
  return token;
}

function sha256(value: unknown, label: string): string {
  const digest = boundedString(value, label, 64);
  if (!sha256Pattern.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function isCanonicalBase64(value: string): boolean {
  if (!base64Pattern.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function normalizeJsonValue(
  value: unknown,
  path = "JSON value",
  depth = 0,
): PortablePluginJsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`${path} exceeds maximum JSON depth ${MAX_JSON_DEPTH}`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite JSON number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    return boundedString(value, path, MAX_JSON_STRING_BYTES, {
      allowEmpty: true,
      allowNewlines: true,
    });
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      throw new Error(`${path} exceeds ${MAX_JSON_ARRAY_ITEMS} array items`);
    }
    return Object.freeze(
      value.map((item, index) =>
        normalizeJsonValue(item, `${path}[${index}]`, depth + 1),
      ),
    );
  }
  if (!isRecord(value)) throw new Error(`${path} must be JSON-compatible`);
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_JSON_OBJECT_KEYS) {
    throw new Error(`${path} exceeds ${MAX_JSON_OBJECT_KEYS} object keys`);
  }
  const normalized = Object.create(null) as Record<string, PortablePluginJsonValue>;
  for (const key of keys) {
    if (key.includes("\0") || Buffer.byteLength(key, "utf8") > 512) {
      throw new Error(`${path} contains an invalid object key`);
    }
    normalized[key] = normalizeJsonValue(value[key], `${path}.${key}`, depth + 1);
  }
  return Object.freeze(normalized);
}

function normalizeJsonObject(
  value: unknown,
  label: string,
): PortablePluginJsonObject {
  const normalized = normalizeJsonValue(value, label);
  if (!isRecord(normalized)) throw new Error(`${label} must be a JSON object`);
  return normalized;
}

/**
 * Parse a foreign value into the protocol's bounded, detached JSON model.
 * Lifecycle fixtures and host messages deliberately share this one boundary.
 */
export function normalizePortablePluginJsonValue(
  value: unknown,
  label = "portable plugin JSON value",
): PortablePluginJsonValue {
  return normalizeJsonValue(value, label);
}

export function normalizePortablePluginJsonObject(
  value: unknown,
  label = "portable plugin JSON object",
): PortablePluginJsonObject {
  return normalizeJsonObject(value, label);
}

function exactHttpsUrl(value: unknown, label: string): string {
  const text = boundedString(value, label, 8_192);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || hostname.endsWith(".")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || !hostname.includes(".")
    || isIP(hostname) !== 0
  ) {
    throw new Error(`${label} must be a public credential-free HTTPS URL`);
  }
  return url.toString();
}

function exactHttpsOrigin(value: unknown, label: string): `https://${string}` {
  const text = boundedString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an HTTPS origin`);
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

function parsePluginIdentity(value: unknown): PortablePluginIdentity {
  const identity = record(value, "plugin identity");
  exactKeys(identity, ["id", "version", "bundleSha256"], "plugin identity");
  const id = boundedString(identity.id, "plugin identity id", 63);
  if (!pluginIdPattern.test(id)) throw new Error("plugin identity id is malformed");
  const version = boundedString(identity.version, "plugin identity version", 128);
  if (!isPortableProviderPluginVersion(version)) {
    throw new Error("plugin identity version must be semantic version text");
  }
  return Object.freeze({
    id,
    version,
    bundleSha256: sha256(identity.bundleSha256, "plugin identity bundleSha256"),
  });
}

function parseCapabilities(value: unknown): PortableProviderPluginCapabilitiesV1 {
  const capabilities = record(value, "granted capabilities");
  exactKeys(
    capabilities,
    ["networkOrigins", "planFiles", "state", "sessionMaterial"],
    "granted capabilities",
  );
  if (
    capabilities.planFiles !== "none"
    && capabilities.planFiles !== "read"
  ) {
    throw new Error("granted planFiles capability is invalid");
  }
  if (
    capabilities.state !== "none"
    && capabilities.state !== "namespaced"
  ) {
    throw new Error("granted state capability is invalid");
  }
  if (
    !Array.isArray(capabilities.networkOrigins)
    || capabilities.networkOrigins.length > 64
  ) {
    throw new Error("granted network origins must be a bounded array");
  }
  const origins = capabilities.networkOrigins.map((origin, index) => {
    return exactHttpsOrigin(origin, `granted network origin ${index}`);
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error("granted network capabilities repeat an origin");
  }
  const sortedOrigins = [...origins].sort();
  if (sortedOrigins.some((origin, index) => origin !== origins[index])) {
    throw new Error("granted network origins must be sorted");
  }
  if (
    !Array.isArray(capabilities.sessionMaterial)
    || capabilities.sessionMaterial.length > 64
  ) {
    throw new Error("granted session material must be a bounded array");
  }
  const material = capabilities.sessionMaterial.map((name) => {
    const parsed = boundedString(name, "granted session material name", 128);
    if (!materialNamePattern.test(parsed)) {
      throw new Error("granted session material name is malformed");
    }
    if (
      !portableProviderPluginSessionMaterialNames.includes(
        parsed as PortableProviderPluginSessionMaterialName,
      )
    ) {
      throw new Error(
        `granted session material ${parsed} is unsupported by host API v1`,
      );
    }
    return parsed as PortableProviderPluginSessionMaterialName;
  });
  if (new Set(material).size !== material.length) {
    throw new Error("granted session material repeats a name");
  }
  const sortedMaterial = [...material].sort();
  if (sortedMaterial.some((name, index) => name !== material[index])) {
    throw new Error("granted session material names must be sorted");
  }
  return Object.freeze({
    networkOrigins: Object.freeze(sortedOrigins),
    planFiles: capabilities.planFiles,
    state: capabilities.state,
    sessionMaterial: Object.freeze(sortedMaterial),
  });
}

function parseRoute(value: unknown): PortablePluginRoute {
  const route = record(value, "plugin route");
  exactKeys(
    route,
    ["transport", "surfaceId", "operation", "contractVersion"],
    "plugin route",
  );
  if (
    route.transport !== "provider-api"
    && route.transport !== "web-session-api"
    && route.transport !== "linked-device"
  ) {
    throw new Error("plugin route transport is unsupported");
  }
  const surfaceId = boundedString(route.surfaceId, "plugin route surfaceId", 63);
  if (!pluginIdPattern.test(surfaceId)) throw new Error("plugin route surfaceId is malformed");
  const operation = boundedString(route.operation, "plugin route operation", 163);
  if (!operationPattern.test(operation)) throw new Error("plugin route operation is malformed");
  return Object.freeze({
    transport: route.transport,
    surfaceId,
    operation,
    contractVersion: boundedInteger(
      route.contractVersion,
      "plugin route contractVersion",
      1,
      1_000_000,
    ),
  });
}

function parseAuth(value: unknown): PortablePluginInvocationAuth {
  const auth = record(value, "plugin invocation auth");
  const keys = auth.subject === undefined
    ? ["kind", "handle"]
    : ["kind", "handle", "subject"];
  exactKeys(auth, keys, "plugin invocation auth");
  if (
    auth.kind !== "cookie-source"
    && auth.kind !== "cookies-file"
    && auth.kind !== "browser-profile"
    && auth.kind !== "oauth-token-file"
    && auth.kind !== "linked-device-store"
  ) {
    throw new Error("plugin invocation auth kind is unsupported");
  }
  const handle = boundedToken(auth.handle, "plugin invocation auth handle");
  if (auth.subject === undefined) return Object.freeze({ kind: auth.kind, handle });
  return Object.freeze({
    kind: auth.kind,
    handle,
    subject: boundedString(auth.subject, "plugin invocation auth subject", 1_024),
  });
}

function parseInvocationFile(value: unknown): PortablePluginInvocationFile {
  const file = record(value, "plugin invocation file");
  exactKeys(
    file,
    ["input", "handle", "bytes", "mediaType", "sha256"],
    "plugin invocation file",
  );
  const input = boundedString(file.input, "plugin invocation file input", 128);
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(input)) {
    throw new Error("plugin invocation file input is malformed");
  }
  const mediaType = boundedString(
    file.mediaType,
    "plugin invocation file mediaType",
    256,
  );
  if (!mediaTypePattern.test(mediaType)) {
    throw new Error("plugin invocation file mediaType is malformed");
  }
  return Object.freeze({
    input,
    handle: boundedToken(file.handle, "plugin invocation file handle"),
    bytes: boundedInteger(
      file.bytes,
      "plugin invocation file bytes",
      1,
      2_147_483_647,
    ),
    mediaType,
    sha256: sha256(file.sha256, "plugin invocation file sha256"),
  });
}

function parseHeader(
  value: unknown,
  label: string,
  allowCredentialHeaders: boolean,
): { readonly name: string; readonly value: string } {
  const header = record(value, label);
  exactKeys(header, ["name", "value"], label);
  const name = boundedString(header.name, `${label} name`, 128);
  if (!headerNamePattern.test(name)) throw new Error(`${label} name is malformed`);
  if (!allowCredentialHeaders && forbiddenRawCredentialHeaders.has(name.toLowerCase())) {
    throw new Error(`${label} cannot carry raw credential material`);
  }
  return Object.freeze({
    name: name.toLowerCase(),
    value: boundedString(header.value, `${label} value`, 8_192),
  });
}

function parseCredentialSink(value: unknown): PortablePluginCredentialSink {
  const sink = record(value, "plugin credential sink");
  if (sink.kind === "cookie-jar") {
    exactKeys(sink, ["kind"], "plugin cookie credential sink");
    return Object.freeze({ kind: "cookie-jar" });
  }
  if (sink.kind !== "header") {
    throw new Error(
      "plugin credential sink is unsupported by host API v1",
    );
  }
  exactKeys(sink, ["kind", "name"], "plugin named credential sink");
  const name = boundedString(sink.name, "plugin credential sink name", 128);
  if (!headerNamePattern.test(name)) {
    throw new Error("plugin credential sink name is malformed");
  }
  if (name.toLowerCase() !== "authorization") {
    throw new Error(
      "host API v1 permits only the Authorization credential header sink",
    );
  }
  return Object.freeze({
    kind: "header",
    name: "authorization",
  });
}

function parseCredentialBinding(
  value: unknown,
): PortablePluginCredentialBinding {
  const binding = record(value, "plugin credential binding");
  exactKeys(binding, ["handle", "sink"], "plugin credential binding");
  return Object.freeze({
    handle: boundedToken(binding.handle, "plugin credential handle"),
    sink: parseCredentialSink(binding.sink),
  });
}

function parseHttpBody(value: unknown): PortablePluginHttpBody {
  const body = record(value, "plugin HTTP body");
  if (body.kind === "none") {
    exactKeys(body, ["kind"], "plugin empty HTTP body");
    return Object.freeze({ kind: "none" });
  }
  if (body.kind !== "utf8" && body.kind !== "base64") {
    throw new Error("plugin HTTP body kind is unsupported");
  }
  const payloadKey = body.kind === "utf8" ? "text" : "data";
  exactKeys(body, ["kind", "mediaType", payloadKey], "plugin HTTP body");
  const mediaType = boundedString(body.mediaType, "plugin HTTP body mediaType", 256);
  if (!mediaTypePattern.test(mediaType)) {
    throw new Error("plugin HTTP body mediaType is malformed");
  }
  const payload = boundedString(
    body[payloadKey],
    `plugin HTTP body ${payloadKey}`,
    MAX_HTTP_BODY_BYTES,
    { allowEmpty: true, allowNewlines: true },
  );
  if (body.kind === "base64") {
    if (!isCanonicalBase64(payload) || Buffer.byteLength(payload, "base64") > MAX_HTTP_BODY_BYTES) {
      throw new Error("plugin HTTP body data must be bounded canonical base64");
    }
    return Object.freeze({ kind: "base64", mediaType, data: payload });
  }
  return Object.freeze({ kind: "utf8", mediaType, text: payload });
}

function parseHttpMethod(
  value: unknown,
): Extract<
  PortablePluginCapabilityRequest,
  { readonly kind: "http.request" }
>["method"] {
  switch (value) {
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "PATCH":
    case "POST":
    case "PUT":
      return value;
    default:
      throw new Error("plugin HTTP method is unsupported");
  }
}

function parseCapabilityRequest(
  value: unknown,
): PortablePluginCapabilityRequest {
  const request = record(value, "plugin capability request");
  if (request.kind === "dispatch.begin") {
    exactKeys(request, ["kind", "dispatchId"], "dispatch begin request");
    return Object.freeze({
      kind: "dispatch.begin",
      dispatchId: boundedToken(request.dispatchId, "dispatch ID"),
    });
  }
  if (request.kind === "dispatch.verify") {
    exactKeys(
      request,
      ["kind", "dispatchHandle", "proof"],
      "dispatch verify request",
    );
    return Object.freeze({
      kind: "dispatch.verify",
      dispatchHandle: boundedToken(request.dispatchHandle, "dispatch handle"),
      proof: normalizeJsonObject(request.proof, "dispatch proof"),
    });
  }
  if (request.kind === "http.request") {
    const keys = request.dispatchHandle === undefined
      ? [
          "kind",
          "method",
          "url",
          "headers",
          "credentials",
          "body",
          "redirect",
          "timeoutMs",
          "maxOutputBytes",
        ]
      : [
          "kind",
          "method",
          "url",
          "headers",
          "credentials",
          "body",
          "redirect",
          "timeoutMs",
          "maxOutputBytes",
          "dispatchHandle",
        ];
    exactKeys(request, keys, "HTTP capability request");
    const method = parseHttpMethod(request.method);
    if (!Array.isArray(request.headers) || request.headers.length > MAX_HEADERS) {
      throw new Error("plugin HTTP headers must be a bounded array");
    }
    const headers = request.headers.map((header, index) =>
      parseHeader(header, `plugin HTTP header ${index}`, false),
    );
    const headerNames = headers.map((header) => header.name);
    if (new Set(headerNames).size !== headerNames.length) {
      throw new Error("plugin HTTP request repeats a header");
    }
    if (
      !Array.isArray(request.credentials)
      || request.credentials.length > MAX_CREDENTIAL_BINDINGS
    ) {
      throw new Error("plugin HTTP credentials must be a bounded array");
    }
    const credentials = request.credentials.map(parseCredentialBinding);
    const credentialSinks = credentials.map(
      (binding) =>
        binding.sink.kind === "cookie-jar"
          ? "cookie-jar"
          : `${binding.sink.kind}:${binding.sink.name}`,
    );
    if (new Set(credentialSinks).size !== credentialSinks.length) {
      throw new Error("plugin HTTP request repeats a credential sink");
    }
    if (request.redirect !== "error") {
      throw new Error("plugin HTTP redirects must fail closed");
    }
    const common = {
      kind: "http.request" as const,
      method,
      url: exactHttpsUrl(request.url, "plugin HTTP URL"),
      headers: Object.freeze(headers),
      credentials: Object.freeze(credentials),
      body: parseHttpBody(request.body),
      redirect: "error" as const,
      timeoutMs: boundedInteger(
        request.timeoutMs,
        "plugin HTTP timeoutMs",
        1,
        120_000,
      ),
      maxOutputBytes: boundedInteger(
        request.maxOutputBytes,
        "plugin HTTP maxOutputBytes",
        1,
        MAX_HTTP_OUTPUT_BYTES,
      ),
    };
    if (request.dispatchHandle === undefined) return Object.freeze(common);
    return Object.freeze({
      ...common,
      dispatchHandle: boundedToken(request.dispatchHandle, "dispatch handle"),
    });
  }
  if (request.kind === "file.read") {
    exactKeys(request, ["kind", "handle", "offset", "length"], "file read request");
    return Object.freeze({
      kind: "file.read",
      handle: boundedToken(request.handle, "file handle"),
      offset: boundedInteger(request.offset, "file read offset", 0, 2_147_483_647),
      length: boundedInteger(request.length, "file read length", 1, 256 * 1024),
    });
  }
  if (
    request.kind === "state.read"
    || request.kind === "state.write"
    || request.kind === "state.delete"
  ) {
    const hasExpectedVersion = Object.hasOwn(request, "expectedVersion");
    const hasIncludeVersion = Object.hasOwn(request, "includeVersion");
    exactKeys(
      request,
      request.kind === "state.write"
        ? hasExpectedVersion
          ? ["kind", "key", "value", "expectedVersion"]
          : ["kind", "key", "value"]
        : request.kind === "state.delete"
          ? hasExpectedVersion
            ? ["kind", "key", "expectedVersion"]
            : ["kind", "key"]
          : hasIncludeVersion
            ? ["kind", "key", "includeVersion"]
            : ["kind", "key"],
      `${request.kind} request`,
    );
    const key = boundedString(request.key, "plugin state key", 256);
    if (
      !stateKeyPattern.test(key)
      || key.startsWith("/")
      || key.endsWith("/")
      || key.includes("//")
      || key.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error("plugin state key is malformed");
    }
    if (request.kind === "state.read") {
      if (!hasIncludeVersion) return Object.freeze({ kind: "state.read", key });
      if (request.includeVersion !== true) {
        throw new Error("plugin state read includeVersion must be true");
      }
      return Object.freeze({ kind: "state.read", key, includeVersion: true });
    }
    if (request.kind === "state.delete") {
      if (!hasExpectedVersion) return Object.freeze({ kind: "state.delete", key });
      return Object.freeze({
        kind: "state.delete",
        key,
        expectedVersion: sha256(
          request.expectedVersion,
          "plugin state expectedVersion",
        ),
      });
    }
    const write = {
      kind: "state.write",
      key,
      value: normalizeJsonValue(request.value, "plugin state value"),
    } as const;
    if (!hasExpectedVersion) return Object.freeze(write);
    if (request.expectedVersion === null) {
      return Object.freeze({ ...write, expectedVersion: null });
    }
    return Object.freeze({
      ...write,
      expectedVersion: sha256(
        request.expectedVersion,
        "plugin state expectedVersion",
      ),
    });
  }
  if (request.kind === "session.acquire") {
    exactKeys(request, ["kind", "name"], "session acquire request");
    const name = boundedString(request.name, "session material name", 128);
    if (!materialNamePattern.test(name)) {
      throw new Error("session material name is malformed");
    }
    if (
      !portableProviderPluginSessionMaterialNames.includes(
        name as PortableProviderPluginSessionMaterialName,
      )
    ) {
      throw new Error(
        `session material ${name} is unsupported by host API v1`,
      );
    }
    return Object.freeze({
      kind: "session.acquire",
      name: name as PortableProviderPluginSessionMaterialName,
    });
  }
  if (request.kind === "log.write") {
    exactKeys(request, ["kind", "level", "message"], "log write request");
    if (
      request.level !== "debug"
      && request.level !== "info"
      && request.level !== "warn"
    ) {
      throw new Error("plugin log level is unsupported");
    }
    return Object.freeze({
      kind: "log.write",
      level: request.level,
      message: boundedString(request.message, "plugin log message", 16_384, {
        allowNewlines: true,
      }),
    });
  }
  throw new Error("plugin capability request kind is unsupported");
}

function parseHttpResponseBody(
  value: unknown,
): Extract<PortablePluginCapabilityResult, { readonly kind: "http.request" }>["body"] {
  const body = record(value, "plugin HTTP response body");
  if (body.kind === "utf8") {
    exactKeys(body, ["kind", "text"], "plugin UTF-8 HTTP response body");
    return Object.freeze({
      kind: "utf8",
      text: boundedString(body.text, "plugin HTTP response text", MAX_HTTP_OUTPUT_BYTES, {
        allowEmpty: true,
        allowNewlines: true,
      }),
    });
  }
  if (body.kind !== "base64") {
    throw new Error("plugin HTTP response body kind is unsupported");
  }
  exactKeys(body, ["kind", "data"], "plugin base64 HTTP response body");
  const data = boundedString(
    body.data,
    "plugin HTTP response data",
    MAX_HTTP_BASE64_OUTPUT_TEXT_BYTES,
    { allowEmpty: true },
  );
  if (
    !isCanonicalBase64(data)
    || Buffer.byteLength(data, "base64") > MAX_HTTP_OUTPUT_BYTES
  ) {
    throw new Error(
      "plugin HTTP response data must be bounded canonical base64",
    );
  }
  return Object.freeze({ kind: "base64", data });
}

function parseCapabilityResult(
  value: unknown,
): PortablePluginCapabilityResult {
  const result = record(value, "plugin capability result");
  if (result.kind === "dispatch.begin") {
    exactKeys(result, ["kind", "dispatchHandle"], "dispatch begin result");
    return Object.freeze({
      kind: "dispatch.begin",
      dispatchHandle: boundedToken(result.dispatchHandle, "dispatch handle"),
    });
  }
  if (result.kind === "dispatch.verify") {
    exactKeys(result, ["kind", "verified"], "dispatch verify result");
    if (result.verified !== true) throw new Error("dispatch verify result must be true");
    return Object.freeze({ kind: "dispatch.verify", verified: true });
  }
  if (result.kind === "http.request") {
    exactKeys(
      result,
      ["kind", "status", "headers", "body", "finalUrl"],
      "HTTP capability result",
    );
    if (!Array.isArray(result.headers) || result.headers.length > MAX_HEADERS) {
      throw new Error("plugin HTTP result headers must be a bounded array");
    }
    const headers = result.headers.map((header, index) =>
      parseHeader(header, `plugin HTTP result header ${index}`, false),
    );
    const headerNames = headers.map((header) => header.name);
    if (new Set(headerNames).size !== headerNames.length) {
      throw new Error("plugin HTTP result repeats a header");
    }
    return Object.freeze({
      kind: "http.request",
      status: boundedInteger(result.status, "plugin HTTP status", 100, 599),
      headers: Object.freeze(headers),
      body: parseHttpResponseBody(result.body),
      finalUrl: exactHttpsUrl(result.finalUrl, "plugin HTTP finalUrl"),
    });
  }
  if (result.kind === "file.read") {
    exactKeys(result, ["kind", "data", "eof"], "file read result");
    const data = boundedString(result.data, "file read result data", 350 * 1024, {
      allowEmpty: true,
    });
    if (!isCanonicalBase64(data)) {
      throw new Error("file read result data must be canonical base64");
    }
    if (typeof result.eof !== "boolean") throw new Error("file read result eof must be boolean");
    return Object.freeze({ kind: "file.read", data, eof: result.eof });
  }
  if (result.kind === "state.read") {
    if (result.found === false) {
      const hasVersion = Object.hasOwn(result, "version");
      exactKeys(
        result,
        hasVersion ? ["kind", "found", "version"] : ["kind", "found"],
        "missing state read result",
      );
      if (!hasVersion) return Object.freeze({ kind: "state.read", found: false });
      if (result.version !== null) {
        throw new Error("missing state read result version must be null");
      }
      return Object.freeze({ kind: "state.read", found: false, version: null });
    }
    const hasVersion = Object.hasOwn(result, "version");
    exactKeys(
      result,
      hasVersion
        ? ["kind", "found", "value", "version"]
        : ["kind", "found", "value"],
      "state read result",
    );
    if (result.found !== true) throw new Error("state read result found must be boolean");
    const read = {
      kind: "state.read",
      found: true,
      value: normalizeJsonValue(result.value, "plugin state result value"),
    } as const;
    if (!hasVersion) return Object.freeze(read);
    return Object.freeze({
      ...read,
      version: sha256(result.version, "plugin state result version"),
    });
  }
  if (result.kind === "state.write") {
    const hasVersion = Object.hasOwn(result, "version");
    exactKeys(
      result,
      hasVersion ? ["kind", "stored", "version"] : ["kind", "stored"],
      "state write result",
    );
    if (result.stored !== true) {
      throw new Error("state write result stored must be true");
    }
    if (!hasVersion) return Object.freeze({ kind: "state.write", stored: true });
    return Object.freeze({
      kind: "state.write",
      stored: true,
      version: sha256(result.version, "plugin state result version"),
    });
  }
  if (result.kind === "state.delete") {
    exactKeys(result, ["kind", "removed"], "state delete result");
    if (typeof result.removed !== "boolean") {
      throw new Error("state delete result removed must be boolean");
    }
    return Object.freeze({ kind: "state.delete", removed: result.removed });
  }
  if (result.kind === "session.acquire") {
    exactKeys(result, ["kind", "materialHandle"], "session acquire result");
    return Object.freeze({
      kind: "session.acquire",
      materialHandle: boundedToken(result.materialHandle, "session material handle"),
    });
  }
  if (result.kind === "log.write") {
    exactKeys(result, ["kind", "accepted"], "log write result");
    if (result.accepted !== true) throw new Error("log write result accepted must be true");
    return Object.freeze({ kind: "log.write", accepted: true });
  }
  throw new Error("plugin capability result kind is unsupported");
}

function parseError(value: unknown): { readonly code: string; readonly message: string } {
  const error = record(value, "plugin protocol error");
  exactKeys(error, ["code", "message"], "plugin protocol error");
  const code = boundedString(error.code, "plugin protocol error code", 64);
  if (!errorCodePattern.test(code)) throw new Error("plugin protocol error code is malformed");
  return Object.freeze({
    code,
    message: boundedString(error.message, "plugin protocol error message", 16_384, {
      allowNewlines: true,
    }),
  });
}

function parseMessageOrThrow(value: unknown): PortableProviderPluginMessage {
  const message = record(value, "portable provider plugin message");
  if (message.protocolVersion !== PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION) {
    throw new Error(
      `portable provider plugin protocolVersion must be ${PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION}`,
    );
  }
  if (message.kind === "host.hello") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "hostVersion", "hostApiVersion", "plugin", "granted"],
      "host hello message",
    );
    if (message.hostApiVersion !== PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION) {
      throw new Error(
        `portable provider plugin hostApiVersion must be ${PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION}`,
      );
    }
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "host.hello",
      hostVersion: boundedString(message.hostVersion, "host version", 128),
      hostApiVersion: PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION,
      plugin: parsePluginIdentity(message.plugin),
      granted: parseCapabilities(message.granted),
    });
  }
  if (message.kind === "host.invoke") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "invocationId", "route", "input", "auth", "files", "timeoutMs"],
      "host invoke message",
    );
    if (!Array.isArray(message.files) || message.files.length > MAX_INVOCATION_FILES) {
      throw new Error("host invocation files must be a bounded array");
    }
    const files = message.files.map(parseInvocationFile);
    const handles = files.map((file) => file.handle);
    if (new Set(handles).size !== handles.length) {
      throw new Error("host invocation repeats a file handle");
    }
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "host.invoke",
      invocationId: boundedToken(message.invocationId, "invocation ID"),
      route: parseRoute(message.route),
      input: normalizeJsonObject(message.input, "plugin invocation input"),
      auth: parseAuth(message.auth),
      files: Object.freeze(files),
      timeoutMs: boundedInteger(
        message.timeoutMs,
        "plugin invocation timeoutMs",
        1,
        10 * 60_000,
      ),
    });
  }
  if (message.kind === "host.capability.result") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "invocationId", "requestId", "result"],
      "host capability result message",
    );
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "host.capability.result",
      invocationId: boundedToken(message.invocationId, "invocation ID"),
      requestId: boundedToken(message.requestId, "capability request ID"),
      result: parseCapabilityResult(message.result),
    });
  }
  if (message.kind === "host.capability.error") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "invocationId", "requestId", "capability", "error"],
      "host capability error message",
    );
    if (
      typeof message.capability !== "string"
      || !requestCapabilityKinds.includes(
        message.capability as PortablePluginCapabilityRequest["kind"],
      )
    ) {
      throw new Error("host capability error names an unsupported capability");
    }
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "host.capability.error",
      invocationId: boundedToken(message.invocationId, "invocation ID"),
      requestId: boundedToken(message.requestId, "capability request ID"),
      capability: message.capability as PortablePluginCapabilityRequest["kind"],
      error: parseError(message.error),
    });
  }
  if (message.kind === "host.cancel") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "invocationId", "reason"],
      "host cancel message",
    );
    if (
      message.reason !== "user"
      && message.reason !== "timeout"
      && message.reason !== "shutdown"
    ) {
      throw new Error("host cancellation reason is unsupported");
    }
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "host.cancel",
      invocationId: boundedToken(message.invocationId, "invocation ID"),
      reason: message.reason,
    });
  }
  if (message.kind === "plugin.ready") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "plugin"],
      "plugin ready message",
    );
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "plugin.ready",
      plugin: parsePluginIdentity(message.plugin),
    });
  }
  if (message.kind === "plugin.capability.request") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "invocationId", "requestId", "request"],
      "plugin capability request message",
    );
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "plugin.capability.request",
      invocationId: boundedToken(message.invocationId, "invocation ID"),
      requestId: boundedToken(message.requestId, "capability request ID"),
      request: parseCapabilityRequest(message.request),
    });
  }
  if (message.kind === "plugin.result") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "invocationId", "output", "finalUrl"],
      "plugin result message",
    );
    if (message.finalUrl !== null && typeof message.finalUrl !== "string") {
      throw new Error("plugin result finalUrl must be null or an HTTPS URL");
    }
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "plugin.result",
      invocationId: boundedToken(message.invocationId, "invocation ID"),
      output: normalizeJsonValue(message.output, "plugin output"),
      finalUrl: message.finalUrl === null
        ? null
        : exactHttpsUrl(message.finalUrl, "plugin result finalUrl"),
    });
  }
  if (message.kind === "plugin.error") {
    if (message.stage === "startup") {
      exactKeys(
        message,
        ["protocolVersion", "kind", "stage", "code", "message"],
        "plugin startup error message",
      );
      const parsed = parseError({ code: message.code, message: message.message });
      return Object.freeze({
        protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
        kind: "plugin.error",
        stage: "startup",
        code: parsed.code,
        message: parsed.message,
      });
    }
    if (message.stage !== "invocation") {
      throw new Error("plugin error stage must be startup or invocation");
    }
    exactKeys(
      message,
      ["protocolVersion", "kind", "stage", "invocationId", "code", "message"],
      "plugin invocation error message",
    );
    const parsed = parseError({ code: message.code, message: message.message });
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "plugin.error",
      stage: "invocation",
      invocationId: boundedToken(message.invocationId, "invocation ID"),
      code: parsed.code,
      message: parsed.message,
    });
  }
  if (message.kind === "plugin.cancelled") {
    exactKeys(
      message,
      ["protocolVersion", "kind", "invocationId"],
      "plugin cancelled message",
    );
    return Object.freeze({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "plugin.cancelled",
      invocationId: boundedToken(message.invocationId, "invocation ID"),
    });
  }
  throw new Error("portable provider plugin message kind is unsupported");
}

export function parsePortableProviderPluginMessage(
  value: unknown,
): PortableProviderPluginMessageResult {
  try {
    return { ok: true, value: parseMessageOrThrow(value) };
  } catch (error) {
    return {
      ok: false,
      issues: Object.freeze([
        error instanceof Error ? error.message : "invalid portable provider plugin message",
      ]),
    };
  }
}

export function encodePortableProviderPluginMessage(
  value: PortableProviderPluginMessage,
): string {
  const parsed = parsePortableProviderPluginMessage(value);
  if (!parsed.ok) {
    throw new Error(
      `invalid portable provider plugin message: ${parsed.issues.join("; ")}`,
    );
  }
  const frame = JSON.stringify(parsed.value);
  if (Buffer.byteLength(frame, "utf8") > MAX_PORTABLE_PROVIDER_PLUGIN_FRAME_BYTES) {
    throw new Error("portable provider plugin message exceeds the frame bound");
  }
  return `${frame}\n`;
}

export function parsePortableProviderPluginFrame(
  frame: Uint8Array | string,
): PortableProviderPluginMessage {
  const bytes = typeof frame === "string"
    ? Buffer.from(frame, "utf8")
    : Buffer.from(frame);
  if (
    bytes.byteLength < 2
    || bytes.byteLength > MAX_PORTABLE_PROVIDER_PLUGIN_FRAME_BYTES + 1
    || bytes.at(-1) !== 0x0a
  ) {
    throw new Error("portable provider plugin frame must be one bounded LF-terminated record");
  }
  const lineBytes = bytes.subarray(0, -1);
  if (lineBytes.includes(0x0a) || lineBytes.includes(0x0d)) {
    throw new Error("portable provider plugin frames use LF only and contain one record");
  }
  let line: string;
  try {
    line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
  } catch {
    throw new Error("portable provider plugin frame must contain valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new Error("portable provider plugin frame must contain valid JSON");
  }
  const parsed = parsePortableProviderPluginMessage(value);
  if (!parsed.ok) {
    throw new Error(
      `invalid portable provider plugin frame: ${parsed.issues.join("; ")}`,
    );
  }
  if (JSON.stringify(parsed.value) !== line) {
    throw new Error(
      "portable provider plugin frame must use canonical JSON encoding",
    );
  }
  return parsed.value;
}

export class PortableProviderPluginFrameDecoder {
  #buffer = Buffer.alloc(0);
  #length = 0;
  #finished = false;
  #failed = false;

  #ensureCapacity(required: number): void {
    if (required <= this.#buffer.byteLength) return;
    let capacity = Math.max(256, this.#buffer.byteLength);
    while (capacity < required) {
      capacity = Math.min(
        MAX_PORTABLE_PROVIDER_PLUGIN_FRAME_BYTES + 1,
        capacity * 2,
      );
    }
    const next = Buffer.allocUnsafe(capacity);
    this.#buffer.copy(next, 0, 0, this.#length);
    this.#buffer = next;
  }

  #append(fragment: Uint8Array): void {
    const required = this.#length + fragment.byteLength;
    if (required > MAX_PORTABLE_PROVIDER_PLUGIN_FRAME_BYTES) {
      throw new Error("portable provider plugin frame exceeds the byte bound");
    }
    this.#ensureCapacity(required);
    this.#buffer.set(fragment, this.#length);
    this.#length = required;
  }

  #parseFrame(fragment: Uint8Array): PortableProviderPluginMessage {
    this.#append(fragment);
    this.#ensureCapacity(this.#length + 1);
    this.#buffer[this.#length] = 0x0a;
    const frame = this.#buffer.subarray(0, this.#length + 1);
    const message = parsePortableProviderPluginFrame(frame);
    this.#length = 0;
    return message;
  }

  push(chunk: Uint8Array): readonly PortableProviderPluginMessage[] {
    if (this.#finished) {
      throw new Error("portable provider plugin frame decoder is finished");
    }
    if (this.#failed) {
      throw new Error("portable provider plugin frame decoder has failed");
    }
    if (chunk.byteLength === 0) return [];
    const messages: PortableProviderPluginMessage[] = [];
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) {
          this.#append(chunk.subarray(offset));
          break;
        }
        messages.push(this.#parseFrame(chunk.subarray(offset, newline)));
        offset = newline + 1;
      }
    } catch (error) {
      this.#failed = true;
      this.#length = 0;
      throw error;
    }
    return Object.freeze(messages);
  }

  finish(): void {
    if (this.#finished) {
      throw new Error("portable provider plugin frame decoder is already finished");
    }
    if (this.#failed) {
      throw new Error("portable provider plugin frame decoder has failed");
    }
    this.#finished = true;
    if (this.#length !== 0) {
      throw new Error("portable provider plugin stream ended with a partial frame");
    }
  }
}
