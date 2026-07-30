import type { InputField, InputSchema, ParseResult } from "./model";

export const WEB_SESSION_TEMPLATE_SCHEMA_VERSION = 1 as const;

export const webSessionMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type WebSessionMethod = (typeof webSessionMethods)[number];

export const webSessionInputValueTypes = [
  "string",
  "number",
  "boolean",
  "string[]",
  "number[]",
  "boolean[]",
] as const;
export type WebSessionInputValueType = (typeof webSessionInputValueTypes)[number];

export type WebSessionInputSource = {
  readonly kind: "input";
  readonly name: string;
  /** Repeated in the reviewed AST and checked against the operation input schema. */
  readonly valueType: WebSessionInputValueType;
};

export type WebSessionLiteral = null | string | number | boolean;

export type WebSessionValueTemplate =
  | { readonly kind: "literal"; readonly value: WebSessionLiteral }
  | WebSessionInputSource
  | {
      readonly kind: "object";
      readonly entries: readonly {
        readonly name: string;
        readonly value: WebSessionValueTemplate;
      }[];
    }
  | { readonly kind: "array"; readonly items: readonly WebSessionValueTemplate[] };

export type WebSessionPathSegment =
  | { readonly kind: "literal"; readonly value: string }
  | (WebSessionInputSource & { readonly valueType: "string" });

export type WebSessionQueryParameter = {
  readonly name: string;
  /** `json` serializes the structural value; `scalar` accepts one primitive scalar only. */
  readonly encoding: "scalar" | "json";
  readonly value: WebSessionValueTemplate;
};

export type WebSessionBrowserStorageSource = {
  readonly kind: "storage";
  readonly area: "local" | "session";
  readonly key: string;
};

export type WebSessionCsrfSource =
  | { readonly kind: "cookie"; readonly name: string }
  | { readonly kind: "meta"; readonly name: string }
  | WebSessionBrowserStorageSource;

export type WebSessionAuthorizationSource =
  | { readonly kind: "captured-header"; readonly name: "authorization" }
  | WebSessionBrowserStorageSource;

export type WebSessionHeaderValue =
  | { readonly kind: "literal"; readonly value: string }
  | {
      readonly kind: "browser-csrf";
      readonly source: WebSessionCsrfSource;
      readonly transform: "identity" | "strip-surrounding-quotes" | "url-decode";
    }
  | {
      readonly kind: "browser-authorization";
      readonly source: WebSessionAuthorizationSource;
      readonly transform: "identity" | "bearer";
    };

export type WebSessionHeader = {
  /** Canonical lower-case and fixed by the reviewed template. */
  readonly name: string;
  readonly value: WebSessionHeaderValue;
};

export type WebSessionRequestBody =
  | { readonly kind: "none" }
  | { readonly kind: "json"; readonly value: WebSessionValueTemplate }
  | {
      readonly kind: "form";
      readonly fields: readonly {
        readonly name: string;
        readonly value: WebSessionValueTemplate;
      }[];
    };

export type WebSessionRequestTemplate = {
  readonly method: WebSessionMethod;
  /** Segments are encoded independently and joined beneath the template's exact origin. */
  readonly path: readonly WebSessionPathSegment[];
  readonly query: readonly WebSessionQueryParameter[];
  readonly headers: readonly WebSessionHeader[];
  readonly body: WebSessionRequestBody;
};

export type WebSessionJsonPathSegment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "index"; readonly index: number };

export const webSessionProjectionValueTypes = ["string", "number", "boolean", "null", "object", "array"] as const;
export type WebSessionProjectionValueType = (typeof webSessionProjectionValueTypes)[number];

export type WebSessionProjection = {
  readonly name: string;
  readonly path: readonly WebSessionJsonPathSegment[];
  readonly valueType: WebSessionProjectionValueType;
  readonly required: boolean;
};

export type WebSessionResponseBinding = {
  readonly path: readonly WebSessionJsonPathSegment[];
  /** Missing paths and non-strictly-equal values fail the response contract. */
  readonly expected: Extract<WebSessionValueTemplate, { readonly kind: "literal" | "input" }>;
};

export type WebSessionResponseBody =
  | { readonly kind: "empty" }
  | { readonly kind: "discard" }
  | {
      readonly kind: "json";
      readonly projections: readonly WebSessionProjection[];
      readonly bindings: readonly WebSessionResponseBinding[];
    };

export type WebSessionResponseVariant = {
  readonly status: number;
  /** A lower-case media-type essence, or null to require a missing Content-Type header. */
  readonly contentType: string | null;
  readonly body: WebSessionResponseBody;
};

export type WebSessionResponseTemplate = {
  readonly maxBytes: number;
  /** Each status/content-type pair is exact; redirects and implicit fallbacks are impossible. */
  readonly variants: readonly WebSessionResponseVariant[];
};

export type WebSessionTemplate = {
  readonly schemaVersion: typeof WEB_SESSION_TEMPLATE_SCHEMA_VERSION;
  /** Exact, canonical HTTPS origin; every request path is origin-relative. */
  readonly origin: string;
  readonly request: WebSessionRequestTemplate;
  readonly response: WebSessionResponseTemplate;
};

export type ParseWebSessionTemplateOptions = {
  readonly input: InputSchema;
  /** Code-owned reviewed origins. Wildcards and origin normalization are intentionally absent. */
  readonly allowedOrigins: readonly string[];
};

const MAX_ISSUES = 100;
const MAX_VALUE_DEPTH = 12;
const MAX_VALUE_NODES = 512;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const dangerousObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const managedHeaderNames = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

type ParseContext = {
  readonly input: InputSchema;
  readonly requiredInputs: ReadonlySet<string>;
  readonly issues: string[];
  valueNodes: number;
};

function addIssue(issues: string[], issue: string): void {
  if (issues.length < MAX_ISSUES) issues.push(issue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowedKeys: readonly string[], path: string, issues: string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addIssue(issues, `${path}.${key} is not supported`);
  }
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

function controlFreeString(
  value: unknown,
  path: string,
  issues: string[],
  minimum: number,
  maximum: number,
): string | null {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    addIssue(issues, `${path} must be a ${minimum}-${maximum} character string without control characters`);
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      addIssue(issues, `${path} must be a ${minimum}-${maximum} character string without control characters`);
      return null;
    }
  }
  if (hasUnpairedSurrogate(value)) {
    addIssue(issues, `${path} must contain well-formed Unicode`);
    return null;
  }
  return value;
}

function jsonString(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || value.length > 65_536 || value.includes("\u0000") || hasUnpairedSurrogate(value)) {
    addIssue(issues, `${path} must be a well-formed JSON string of at most 65536 characters without NUL`);
    return null;
  }
  return value;
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number, issues: string[]): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    addIssue(issues, `${path} must be an integer between ${minimum} and ${maximum}`);
    return null;
  }
  return value;
}

function boundedArray(value: unknown, path: string, maximum: number, issues: string[]): readonly unknown[] | null {
  if (!isUnknownArray(value) || value.length > maximum) {
    addIssue(issues, `${path} must be an array with at most ${maximum} entries`);
    return null;
  }
  return value;
}

function normalizedCredentialName(value: string): string {
  return value
    .replaceAll("_", "-")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
}

function isCredentialName(value: string): boolean {
  const normalized = normalizedCredentialName(value);
  return /(?:^|-)(?:authorization|cookie|csrf|xsrf|password|secret|credential|access-token|refresh-token|id-token|auth-token|api-key|authenticity-token)(?:-|$)/u.test(normalized);
}

function isCsrfHeaderName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("csrf") || normalized.includes("xsrf");
}

function isManagedHeaderName(value: string): boolean {
  return managedHeaderNames.has(value)
    || value.startsWith("sec-")
    || value.startsWith("proxy-")
    || value.startsWith("x-forwarded-")
    || value.startsWith("access-control-request-");
}

function canonicalHttpsOrigin(value: unknown, path: string, issues: string[]): string | null {
  const origin = controlFreeString(value, path, issues, 1, 2_048);
  if (origin === null) return null;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.hostname.includes("*")
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.origin !== origin
    ) {
      addIssue(issues, `${path} must be one exact canonical HTTPS origin without credentials, path, query, or fragment`);
      return null;
    }
    return origin;
  } catch {
    addIssue(issues, `${path} must be one exact canonical HTTPS origin without credentials, path, query, or fragment`);
    return null;
  }
}

function inputValueType(field: InputField): WebSessionInputValueType | null {
  if (field.type === "string" || field.type === "number" || field.type === "boolean") return field.type;
  if (field.type !== "array" || field.items.type === "file") return null;
  if (field.items.type === "string") return "string[]";
  if (field.items.type === "number") return "number[]";
  return "boolean[]";
}

function isWebSessionMethod(value: unknown): value is WebSessionMethod {
  return webSessionMethods.some((candidate) => candidate === value);
}

function isProjectionValueType(value: unknown): value is WebSessionProjectionValueType {
  return webSessionProjectionValueTypes.some((candidate) => candidate === value);
}

function parseInputSource(value: unknown, path: string, context: ParseContext): WebSessionInputSource | null {
  if (!isRecord(value)) {
    addIssue(context.issues, `${path} must be a typed input source object`);
    return null;
  }
  exactKeys(value, ["kind", "name", "valueType"], path, context.issues);
  if (value.kind !== "input") {
    addIssue(context.issues, `${path}.kind must be input`);
    return null;
  }
  const name = controlFreeString(value.name, `${path}.name`, context.issues, 1, 64);
  const declaredType = value.valueType;
  if (!webSessionInputValueTypes.some((candidate) => candidate === declaredType)) {
    addIssue(context.issues, `${path}.valueType must be ${webSessionInputValueTypes.join(", ")}`);
    return null;
  }
  if (name === null) return null;
  if (isCredentialName(name)) {
    addIssue(context.issues, `${path}.name cannot designate authentication material`);
    return null;
  }
  const field = Object.hasOwn(context.input.properties, name) ? context.input.properties[name] : undefined;
  if (field === undefined) {
    addIssue(context.issues, `${path}.name must name a declared input field`);
    return null;
  }
  const actualType = inputValueType(field);
  if (actualType === null) {
    addIssue(context.issues, `${path}.name cannot expose file input bytes to a web-session request`);
    return null;
  }
  if (!context.requiredInputs.has(name)) {
    addIssue(context.issues, `${path}.name must name a required input field`);
    return null;
  }
  if (declaredType !== actualType) {
    addIssue(context.issues, `${path}.valueType must match input.${name} (${actualType})`);
    return null;
  }
  return { kind: "input", name, valueType: actualType };
}

function parseLiteral(value: Record<string, unknown>, path: string, context: ParseContext): WebSessionValueTemplate | null {
  exactKeys(value, ["kind", "value"], path, context.issues);
  const literal = value.value;
  if (literal === null || typeof literal === "boolean") return { kind: "literal", value: literal };
  if (typeof literal === "number") {
    if (!Number.isFinite(literal)) {
      addIssue(context.issues, `${path}.value must be a finite JSON primitive`);
      return null;
    }
    return { kind: "literal", value: literal };
  }
  const text = jsonString(literal, `${path}.value`, context.issues);
  return text === null ? null : { kind: "literal", value: text };
}

function parseValueTemplate(value: unknown, path: string, context: ParseContext, depth = 0): WebSessionValueTemplate | null {
  context.valueNodes += 1;
  if (context.valueNodes > MAX_VALUE_NODES) {
    addIssue(context.issues, `${path} exceeds the ${MAX_VALUE_NODES}-node value-template budget`);
    return null;
  }
  if (depth > MAX_VALUE_DEPTH) {
    addIssue(context.issues, `${path} exceeds the ${MAX_VALUE_DEPTH}-level value-template depth`);
    return null;
  }
  if (!isRecord(value)) {
    addIssue(context.issues, `${path} must be a declarative value-template object`);
    return null;
  }
  if (value.kind === "literal") return parseLiteral(value, path, context);
  if (value.kind === "input") return parseInputSource(value, path, context);
  if (value.kind === "array") {
    exactKeys(value, ["kind", "items"], path, context.issues);
    const items = boundedArray(value.items, `${path}.items`, 100, context.issues);
    if (items === null) return null;
    const parsed: WebSessionValueTemplate[] = [];
    for (const [index, item] of items.entries()) {
      const next = parseValueTemplate(item, `${path}.items[${index}]`, context, depth + 1);
      if (next !== null) parsed.push(next);
    }
    return { kind: "array", items: parsed };
  }
  if (value.kind === "object") {
    exactKeys(value, ["kind", "entries"], path, context.issues);
    const entries = boundedArray(value.entries, `${path}.entries`, 100, context.issues);
    if (entries === null) return null;
    const parsed: { name: string; value: WebSessionValueTemplate }[] = [];
    const names = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const entryPath = `${path}.entries[${index}]`;
      if (!isRecord(entry)) {
        addIssue(context.issues, `${entryPath} must be an object`);
        continue;
      }
      exactKeys(entry, ["name", "value"], entryPath, context.issues);
      const name = controlFreeString(entry.name, `${entryPath}.name`, context.issues, 1, 128);
      const parsedValue = parseValueTemplate(entry.value, `${entryPath}.value`, context, depth + 1);
      if (name === null || parsedValue === null) continue;
      if (dangerousObjectKeys.has(name)) {
        addIssue(context.issues, `${entryPath}.name cannot be a prototype-mutating key`);
        continue;
      }
      if (isCredentialName(name)) {
        addIssue(context.issues, `${entryPath}.name cannot be a credential sink`);
        continue;
      }
      if (names.has(name)) {
        addIssue(context.issues, `${entryPath}.name duplicates ${name}`);
        continue;
      }
      names.add(name);
      parsed.push({ name, value: parsedValue });
    }
    return { kind: "object", entries: parsed };
  }
  addIssue(context.issues, `${path}.kind must be literal, input, object, or array`);
  return null;
}

function isScalarTemplate(value: WebSessionValueTemplate): value is Extract<WebSessionValueTemplate, { readonly kind: "literal" | "input" }> {
  if (value.kind === "literal") return value.value !== null;
  return value.kind === "input" && !value.valueType.endsWith("[]");
}

function parsePath(value: unknown, path: string, context: ParseContext): readonly WebSessionPathSegment[] | null {
  const segments = boundedArray(value, path, 64, context.issues);
  if (segments === null) return null;
  const parsed: WebSessionPathSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const segmentPath = `${path}[${index}]`;
    if (!isRecord(segment)) {
      addIssue(context.issues, `${segmentPath} must be a literal or typed input segment`);
      continue;
    }
    if (segment.kind === "literal") {
      exactKeys(segment, ["kind", "value"], segmentPath, context.issues);
      const text = controlFreeString(segment.value, `${segmentPath}.value`, context.issues, 1, 256);
      if (text === null) continue;
      if (text === "." || text === ".." || /[/\\%?#]/u.test(text)) {
        addIssue(context.issues, `${segmentPath}.value must be one unescaped path segment`);
        continue;
      }
      parsed.push({ kind: "literal", value: text });
      continue;
    }
    const source = parseInputSource(segment, segmentPath, context);
    if (source === null) continue;
    const field = context.input.properties[source.name];
    if (source.valueType !== "string" || field?.type !== "string" || field.format !== "path-segment") {
      addIssue(context.issues, `${segmentPath} must reference a string input with format path-segment`);
      continue;
    }
    parsed.push({ kind: "input", name: source.name, valueType: "string" });
  }
  return parsed;
}

function parseQuery(value: unknown, path: string, context: ParseContext): readonly WebSessionQueryParameter[] | null {
  const entries = boundedArray(value, path, 50, context.issues);
  if (entries === null) return null;
  const parsed: WebSessionQueryParameter[] = [];
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      addIssue(context.issues, `${entryPath} must be an object`);
      continue;
    }
    exactKeys(entry, ["name", "encoding", "value"], entryPath, context.issues);
    const name = controlFreeString(entry.name, `${entryPath}.name`, context.issues, 1, 128);
    const encoding = entry.encoding;
    if (encoding !== "scalar" && encoding !== "json") {
      addIssue(context.issues, `${entryPath}.encoding must be scalar or json`);
    }
    const parsedValue = parseValueTemplate(entry.value, `${entryPath}.value`, context);
    if (name === null || parsedValue === null || (encoding !== "scalar" && encoding !== "json")) continue;
    if (/[&=#]/u.test(name) || isCredentialName(name)) {
      addIssue(context.issues, `${entryPath}.name must be a fixed non-credential query name`);
      continue;
    }
    if (names.has(name)) {
      addIssue(context.issues, `${entryPath}.name duplicates ${name}`);
      continue;
    }
    if (encoding === "scalar" && !isScalarTemplate(parsedValue)) {
      addIssue(context.issues, `${entryPath}.value must be one non-null scalar for scalar encoding`);
      continue;
    }
    names.add(name);
    parsed.push({ name, encoding, value: parsedValue });
  }
  return parsed;
}

function parseBrowserStorageSource(value: Record<string, unknown>, path: string, issues: string[]): WebSessionBrowserStorageSource | null {
  exactKeys(value, ["kind", "area", "key"], path, issues);
  if (value.kind !== "storage") {
    addIssue(issues, `${path}.kind must be storage`);
    return null;
  }
  if (value.area !== "local" && value.area !== "session") {
    addIssue(issues, `${path}.area must be local or session`);
    return null;
  }
  const key = controlFreeString(value.key, `${path}.key`, issues, 1, 256);
  return key === null ? null : { kind: "storage", area: value.area, key };
}

function parseCsrfSource(value: unknown, path: string, issues: string[]): WebSessionCsrfSource | null {
  if (!isRecord(value)) {
    addIssue(issues, `${path} must be a browser-only CSRF source`);
    return null;
  }
  if (value.kind === "storage") return parseBrowserStorageSource(value, path, issues);
  if (value.kind === "cookie" || value.kind === "meta") {
    exactKeys(value, ["kind", "name"], path, issues);
    const name = controlFreeString(value.name, `${path}.name`, issues, 1, 256);
    return name === null ? null : { kind: value.kind, name };
  }
  addIssue(issues, `${path}.kind must be cookie, meta, or storage`);
  return null;
}

function parseAuthorizationSource(value: unknown, path: string, issues: string[]): WebSessionAuthorizationSource | null {
  if (!isRecord(value)) {
    addIssue(issues, `${path} must be a browser-only authorization source`);
    return null;
  }
  if (value.kind === "storage") return parseBrowserStorageSource(value, path, issues);
  if (value.kind === "captured-header") {
    exactKeys(value, ["kind", "name"], path, issues);
    if (value.name !== "authorization") {
      addIssue(issues, `${path}.name must be authorization`);
      return null;
    }
    return { kind: "captured-header", name: "authorization" };
  }
  addIssue(issues, `${path}.kind must be captured-header or storage`);
  return null;
}

function parseHeaderValue(value: unknown, headerName: string, path: string, issues: string[]): WebSessionHeaderValue | null {
  if (!isRecord(value)) {
    addIssue(issues, `${path} must be a fixed literal or browser-only credential source`);
    return null;
  }
  if (value.kind === "literal") {
    exactKeys(value, ["kind", "value"], path, issues);
    const literal = controlFreeString(value.value, `${path}.value`, issues, 0, 4_096);
    if (literal === null) return null;
    if (headerName === "authorization" || isCsrfHeaderName(headerName) || isCredentialName(headerName)) {
      addIssue(issues, `${path} cannot put a literal into a credential-bearing header`);
      return null;
    }
    return { kind: "literal", value: literal };
  }
  if (value.kind === "browser-csrf") {
    exactKeys(value, ["kind", "source", "transform"], path, issues);
    if (!isCsrfHeaderName(headerName)) {
      addIssue(issues, `${path} may terminate only in a fixed CSRF/XSRF header`);
      return null;
    }
    const source = parseCsrfSource(value.source, `${path}.source`, issues);
    const transform = value.transform;
    if (transform !== "identity" && transform !== "strip-surrounding-quotes" && transform !== "url-decode") {
      addIssue(issues, `${path}.transform must be identity, strip-surrounding-quotes, or url-decode`);
      return null;
    }
    return source === null ? null : { kind: "browser-csrf", source, transform };
  }
  if (value.kind === "browser-authorization") {
    exactKeys(value, ["kind", "source", "transform"], path, issues);
    if (headerName !== "authorization") {
      addIssue(issues, `${path} may terminate only in the fixed authorization header`);
      return null;
    }
    const source = parseAuthorizationSource(value.source, `${path}.source`, issues);
    const transform = value.transform;
    if (transform !== "identity" && transform !== "bearer") {
      addIssue(issues, `${path}.transform must be identity or bearer`);
      return null;
    }
    if (source?.kind === "captured-header" && transform !== "identity") {
      addIssue(issues, `${path}.transform must be identity for a captured authorization header`);
      return null;
    }
    return source === null ? null : { kind: "browser-authorization", source, transform };
  }
  addIssue(issues, `${path}.kind must be literal, browser-csrf, or browser-authorization`);
  return null;
}

function parseHeaders(value: unknown, path: string, issues: string[]): readonly WebSessionHeader[] | null {
  const entries = boundedArray(value, path, 50, issues);
  if (entries === null) return null;
  const parsed: WebSessionHeader[] = [];
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      addIssue(issues, `${entryPath} must be an object`);
      continue;
    }
    exactKeys(entry, ["name", "value"], entryPath, issues);
    const name = controlFreeString(entry.name, `${entryPath}.name`, issues, 1, 128);
    if (name === null) continue;
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) || name !== name.toLowerCase()) {
      addIssue(issues, `${entryPath}.name must be one canonical lower-case HTTP field name`);
      continue;
    }
    if (isManagedHeaderName(name) && name !== "proxy-authorization") {
      addIssue(issues, `${entryPath}.name is browser-managed and cannot be supplied by a template`);
      continue;
    }
    if (name === "proxy-authorization") {
      addIssue(issues, `${entryPath}.name cannot designate proxy credentials`);
      continue;
    }
    if (names.has(name)) {
      addIssue(issues, `${entryPath}.name duplicates ${name}`);
      continue;
    }
    const headerValue = parseHeaderValue(entry.value, name, `${entryPath}.value`, issues);
    if (headerValue === null) continue;
    names.add(name);
    parsed.push({ name, value: headerValue });
  }
  return parsed;
}

function parseBody(value: unknown, path: string, context: ParseContext): WebSessionRequestBody | null {
  if (!isRecord(value)) {
    addIssue(context.issues, `${path} must be a declarative request body`);
    return null;
  }
  if (value.kind === "none") {
    exactKeys(value, ["kind"], path, context.issues);
    return { kind: "none" };
  }
  if (value.kind === "json") {
    exactKeys(value, ["kind", "value"], path, context.issues);
    const parsedValue = parseValueTemplate(value.value, `${path}.value`, context);
    return parsedValue === null ? null : { kind: "json", value: parsedValue };
  }
  if (value.kind === "form") {
    exactKeys(value, ["kind", "fields"], path, context.issues);
    const fields = boundedArray(value.fields, `${path}.fields`, 100, context.issues);
    if (fields === null) return null;
    const parsed: { name: string; value: WebSessionValueTemplate }[] = [];
    const names = new Set<string>();
    for (const [index, field] of fields.entries()) {
      const fieldPath = `${path}.fields[${index}]`;
      if (!isRecord(field)) {
        addIssue(context.issues, `${fieldPath} must be an object`);
        continue;
      }
      exactKeys(field, ["name", "value"], fieldPath, context.issues);
      const name = controlFreeString(field.name, `${fieldPath}.name`, context.issues, 1, 128);
      const fieldValue = parseValueTemplate(field.value, `${fieldPath}.value`, context);
      if (name === null || fieldValue === null) continue;
      if (/[&=]/u.test(name) || isCredentialName(name)) {
        addIssue(context.issues, `${fieldPath}.name must be a fixed non-credential form name`);
        continue;
      }
      if (!isScalarTemplate(fieldValue)) {
        addIssue(context.issues, `${fieldPath}.value must be one non-null scalar`);
        continue;
      }
      if (names.has(name)) {
        addIssue(context.issues, `${fieldPath}.name duplicates ${name}`);
        continue;
      }
      names.add(name);
      parsed.push({ name, value: fieldValue });
    }
    return { kind: "form", fields: parsed };
  }
  addIssue(context.issues, `${path}.kind must be none, json, or form`);
  return null;
}

function parseRequest(value: unknown, path: string, context: ParseContext): WebSessionRequestTemplate | null {
  if (!isRecord(value)) {
    addIssue(context.issues, `${path} must be an object`);
    return null;
  }
  exactKeys(value, ["method", "path", "query", "headers", "body"], path, context.issues);
  const method = value.method;
  if (!isWebSessionMethod(method)) {
    addIssue(context.issues, `${path}.method must be one fixed reviewed method: ${webSessionMethods.join(", ")}`);
  }
  const parsedPath = parsePath(value.path, `${path}.path`, context);
  const query = parseQuery(value.query, `${path}.query`, context);
  const headers = parseHeaders(value.headers, `${path}.headers`, context.issues);
  const body = parseBody(value.body, `${path}.body`, context);
  if ((method === "GET" || method === "HEAD") && body?.kind !== "none") {
    addIssue(context.issues, `${path}.body must be none for ${method}`);
  }
  if (
    !isWebSessionMethod(method)
    || parsedPath === null
    || query === null
    || headers === null
    || body === null
  ) return null;
  return { method, path: parsedPath, query, headers, body };
}

function parseJsonPath(value: unknown, path: string, issues: string[]): readonly WebSessionJsonPathSegment[] | null {
  const segments = boundedArray(value, path, 16, issues);
  if (segments === null || segments.length === 0) {
    if (segments !== null) addIssue(issues, `${path} must contain at least one fixed segment`);
    return null;
  }
  const parsed: WebSessionJsonPathSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    const segmentPath = `${path}[${index}]`;
    if (!isRecord(segment)) {
      addIssue(issues, `${segmentPath} must be a fixed key or index segment`);
      continue;
    }
    if (segment.kind === "key") {
      exactKeys(segment, ["kind", "key"], segmentPath, issues);
      const key = controlFreeString(segment.key, `${segmentPath}.key`, issues, 1, 128);
      if (key === null) continue;
      if (dangerousObjectKeys.has(key) || isCredentialName(key)) {
        addIssue(issues, `${segmentPath}.key cannot select a prototype or credential-bearing field`);
        continue;
      }
      parsed.push({ kind: "key", key });
      continue;
    }
    if (segment.kind === "index") {
      exactKeys(segment, ["kind", "index"], segmentPath, issues);
      const parsedIndex = safeInteger(segment.index, `${segmentPath}.index`, 0, 10_000, issues);
      if (parsedIndex !== null) parsed.push({ kind: "index", index: parsedIndex });
      continue;
    }
    addIssue(issues, `${segmentPath}.kind must be key or index`);
  }
  return parsed.length === segments.length ? parsed : null;
}

function parseProjections(value: unknown, path: string, issues: string[]): readonly WebSessionProjection[] | null {
  const projections = boundedArray(value, path, 64, issues);
  if (projections === null) return null;
  const parsed: WebSessionProjection[] = [];
  const names = new Set<string>();
  for (const [index, projection] of projections.entries()) {
    const projectionPath = `${path}[${index}]`;
    if (!isRecord(projection)) {
      addIssue(issues, `${projectionPath} must be an object`);
      continue;
    }
    exactKeys(projection, ["name", "path", "valueType", "required"], projectionPath, issues);
    const name = controlFreeString(projection.name, `${projectionPath}.name`, issues, 1, 64);
    const jsonPath = parseJsonPath(projection.path, `${projectionPath}.path`, issues);
    const valueType = projection.valueType;
    if (!isProjectionValueType(valueType)) {
      addIssue(issues, `${projectionPath}.valueType must be ${webSessionProjectionValueTypes.join(", ")}`);
    }
    if (typeof projection.required !== "boolean") addIssue(issues, `${projectionPath}.required must be boolean`);
    if (name === null || jsonPath === null || typeof projection.required !== "boolean" || !isProjectionValueType(valueType)) continue;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) || isCredentialName(name)) {
      addIssue(issues, `${projectionPath}.name must be a safe non-credential output name`);
      continue;
    }
    if (names.has(name)) {
      addIssue(issues, `${projectionPath}.name duplicates ${name}`);
      continue;
    }
    names.add(name);
    parsed.push({ name, path: jsonPath, valueType, required: projection.required });
  }
  return parsed;
}

function parseBindings(value: unknown, path: string, context: ParseContext): readonly WebSessionResponseBinding[] | null {
  const bindings = boundedArray(value, path, 32, context.issues);
  if (bindings === null) return null;
  const parsed: WebSessionResponseBinding[] = [];
  const paths = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    const bindingPath = `${path}[${index}]`;
    if (!isRecord(binding)) {
      addIssue(context.issues, `${bindingPath} must be an object`);
      continue;
    }
    exactKeys(binding, ["path", "expected"], bindingPath, context.issues);
    const jsonPath = parseJsonPath(binding.path, `${bindingPath}.path`, context.issues);
    const expected = parseValueTemplate(binding.expected, `${bindingPath}.expected`, context);
    if (jsonPath === null || expected === null) continue;
    if (!isScalarTemplate(expected)) {
      addIssue(context.issues, `${bindingPath}.expected must be one non-null scalar literal or scalar input`);
      continue;
    }
    const signature = JSON.stringify(jsonPath);
    if (paths.has(signature)) {
      addIssue(context.issues, `${bindingPath}.path duplicates another binding path`);
      continue;
    }
    paths.add(signature);
    parsed.push({ path: jsonPath, expected });
  }
  return parsed;
}

function isJsonContentType(value: string): boolean {
  const subtype = value.slice(value.indexOf("/") + 1);
  return subtype === "json" || subtype.endsWith("+json");
}

function parseContentType(value: unknown, path: string, issues: string[]): string | null | undefined {
  if (value === null) return null;
  const contentType = controlFreeString(value, path, issues, 3, 128);
  if (
    contentType === null
    || contentType !== contentType.toLowerCase()
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/u.test(contentType)
  ) {
    if (contentType !== null) addIssue(issues, `${path} must be null or one lower-case media-type essence without parameters`);
    return undefined;
  }
  return contentType;
}

function parseResponseBody(
  value: unknown,
  contentType: string | null,
  path: string,
  context: ParseContext,
): WebSessionResponseBody | null {
  if (!isRecord(value)) {
    addIssue(context.issues, `${path} must be an object`);
    return null;
  }
  if (value.kind === "empty") {
    exactKeys(value, ["kind"], path, context.issues);
    if (contentType !== null) {
      addIssue(context.issues, `${path}.kind empty requires a null contentType`);
      return null;
    }
    return { kind: "empty" };
  }
  if (value.kind === "discard") {
    exactKeys(value, ["kind"], path, context.issues);
    if (contentType === null) {
      addIssue(context.issues, `${path}.kind discard requires an exact contentType`);
      return null;
    }
    return { kind: "discard" };
  }
  if (value.kind === "json") {
    exactKeys(value, ["kind", "projections", "bindings"], path, context.issues);
    if (contentType === null || !isJsonContentType(contentType)) {
      addIssue(context.issues, `${path}.kind json requires an exact JSON contentType`);
      return null;
    }
    const projections = parseProjections(value.projections, `${path}.projections`, context.issues);
    const bindings = parseBindings(value.bindings, `${path}.bindings`, context);
    return projections === null || bindings === null ? null : { kind: "json", projections, bindings };
  }
  addIssue(context.issues, `${path}.kind must be empty, discard, or json`);
  return null;
}

function parseResponse(value: unknown, path: string, context: ParseContext): WebSessionResponseTemplate | null {
  if (!isRecord(value)) {
    addIssue(context.issues, `${path} must be an object`);
    return null;
  }
  exactKeys(value, ["maxBytes", "variants"], path, context.issues);
  const maxBytes = safeInteger(value.maxBytes, `${path}.maxBytes`, 1, MAX_RESPONSE_BYTES, context.issues);
  const variants = boundedArray(value.variants, `${path}.variants`, 16, context.issues);
  if (variants !== null && variants.length === 0) addIssue(context.issues, `${path}.variants must contain at least one exact response variant`);
  if (maxBytes === null || variants === null || variants.length === 0) return null;
  const parsed: WebSessionResponseVariant[] = [];
  const signatures = new Set<string>();
  for (const [index, variant] of variants.entries()) {
    const variantPath = `${path}.variants[${index}]`;
    if (!isRecord(variant)) {
      addIssue(context.issues, `${variantPath} must be an object`);
      continue;
    }
    exactKeys(variant, ["status", "contentType", "body"], variantPath, context.issues);
    const status = safeInteger(variant.status, `${variantPath}.status`, 200, 299, context.issues);
    const contentType = parseContentType(variant.contentType, `${variantPath}.contentType`, context.issues);
    if (status === null || contentType === undefined) continue;
    const body = parseResponseBody(variant.body, contentType, `${variantPath}.body`, context);
    if (body === null) continue;
    const signature = `${status}\u0000${contentType ?? "<missing>"}`;
    if (signatures.has(signature)) {
      addIssue(context.issues, `${variantPath} duplicates an exact status/contentType pair`);
      continue;
    }
    signatures.add(signature);
    parsed.push({ status, contentType, body });
  }
  return { maxBytes, variants: parsed };
}

/**
 * Parse an untrusted reviewed exchange template into a closed request/response AST.
 *
 * Browser cookies are sent by the later same-origin executor, never represented in
 * this AST. CSRF and authorization material can be read only from the dedicated
 * browser sources above and can terminate only in their corresponding headers.
 */
export function parseWebSessionTemplate(
  value: unknown,
  options: ParseWebSessionTemplateOptions,
): ParseResult<WebSessionTemplate> {
  const issues: string[] = [];
  if (options.allowedOrigins.length < 1 || options.allowedOrigins.length > 32) {
    addIssue(issues, "$policy.allowedOrigins must contain 1-32 exact reviewed origins");
  }
  const allowedOrigins = new Set<string>();
  for (const [index, candidate] of options.allowedOrigins.entries()) {
    const origin = canonicalHttpsOrigin(candidate, `$policy.allowedOrigins[${index}]`, issues);
    if (origin !== null) allowedOrigins.add(origin);
  }
  if (!isRecord(value)) return { ok: false, issues: ["$ must be an object"] };
  exactKeys(value, ["schemaVersion", "origin", "request", "response"], "$", issues);
  if (value.schemaVersion !== WEB_SESSION_TEMPLATE_SCHEMA_VERSION) {
    addIssue(issues, `$.schemaVersion must be ${WEB_SESSION_TEMPLATE_SCHEMA_VERSION}`);
  }
  const origin = canonicalHttpsOrigin(value.origin, "$.origin", issues);
  if (origin !== null && !allowedOrigins.has(origin)) addIssue(issues, "$.origin is not one of the exact reviewed origins");
  const context: ParseContext = {
    input: options.input,
    requiredInputs: new Set(options.input.required),
    issues,
    valueNodes: 0,
  };
  const request = parseRequest(value.request, "$.request", context);
  const response = parseResponse(value.response, "$.response", context);
  if (request?.method === "HEAD" && response !== null && response.variants.some((variant) => variant.body.kind === "json")) {
    addIssue(issues, "$.response cannot project a JSON body for a HEAD request");
  }
  if (
    issues.length > 0
    || value.schemaVersion !== WEB_SESSION_TEMPLATE_SCHEMA_VERSION
    || origin === null
    || request === null
    || response === null
  ) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schemaVersion: WEB_SESSION_TEMPLATE_SCHEMA_VERSION,
      origin,
      request,
      response,
    },
  };
}
