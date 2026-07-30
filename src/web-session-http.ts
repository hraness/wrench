import {
  acquireCookieRecords,
  type CookieRecordReader,
  type CookieSelection,
} from "@hraness/kb/clip/acquire";
import { renderCookieHeader, type StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "./auth";
import type { OperationInput } from "./model";
import { pinnedHttpsFetch } from "./pinned-https";
import {
  type WebSessionAuthorizationSource,
  type WebSessionBrowserStorageSource,
  type WebSessionHeaderValue,
  type WebSessionJsonPathSegment,
  type WebSessionTemplate,
  type WebSessionValueTemplate,
} from "./web-session-template";

type JsonRecord = Record<string, unknown>;

function isInputArray(
  value: OperationInput[string],
): value is Extract<OperationInput[string], readonly unknown[]> {
  return Array.isArray(value);
}

export type WebSessionSecretSource =
  | WebSessionBrowserStorageSource
  | WebSessionAuthorizationSource;

export type WebSessionHttpDependencies = {
  readonly acquireCookies: CookieRecordReader;
  readonly fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  /**
   * Optional, trusted bootstrap for values that cannot be recovered from the
   * cookie jar. The implementation may inspect browser network/storage state,
   * but the returned value is used only in its reviewed header sink.
   */
  readonly resolveSecret?: (
    source: WebSessionSecretSource,
    context: { readonly origin: string; readonly header: string },
  ) => Promise<string>;
};

export type WebSessionHttpResult = {
  readonly status: number;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly responseBytes: number;
};

function requestInputUrl(input: string | URL | Request): URL {
  if (input instanceof Request) {
    if (input.body !== null || input.bodyUsed) {
      throw new Error("authenticated pinned transport does not accept a Request body wrapper");
    }
    return new URL(input.url);
  }
  return new URL(input);
}

function cookieSelection(auth: WrenchAuth, timeoutMs: number): CookieSelection {
  if (auth.kind === "cookie-source") {
    return {
      cookieSources: [auth.source],
      cookiesFile: undefined,
      cookieProfile: auth.profile,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  if (auth.kind === "cookies-file") {
    return {
      cookieSources: [],
      cookiesFile: auth.path,
      cookieProfile: undefined,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  if (auth.kind === "browser-profile" && auth.cookieSource !== undefined) {
    return {
      cookieSources: [auth.cookieSource],
      cookiesFile: undefined,
      cookieProfile: auth.cookieProfile,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  if (auth.kind === "browser-profile") {
    throw new Error("authenticated web API execution requires the browser auth locator to name a cookie source");
  }
  throw new Error("authenticated web API execution requires browser-session or cookie auth");
}

function scalar(value: unknown, name: string): string | number | boolean {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`${name} must resolve to a scalar input`);
  }
  return value;
}

function renderValue(template: WebSessionValueTemplate, input: OperationInput): unknown {
  if (template.kind === "literal") return template.value;
  if (template.kind === "input") {
    const value = input[template.name];
    if (value === undefined) throw new Error(`reviewed request references missing input.${template.name}`);
    if (template.valueType.endsWith("[]")) {
      if (!isInputArray(value) || value.some((item) => typeof item === "object")) {
        throw new Error(`input.${template.name} does not match its reviewed request type`);
      }
      return [...value];
    }
    return scalar(value, `input.${template.name}`);
  }
  if (template.kind === "array") return template.items.map((item) => renderValue(item, input));
  const output: JsonRecord = {};
  for (const entry of template.entries) output[entry.name] = renderValue(entry.value, input);
  return output;
}

function cookieValue(cookies: readonly StrictCookie[], name: string): string {
  const matches = cookies.filter((cookie) => cookie.name === name);
  if (matches.length !== 1) {
    throw new Error(`authenticated session must contain exactly one reviewed ${name} cookie`);
  }
  return matches[0]?.value ?? "";
}

function applyTransform(value: string, transform: "identity" | "strip-surrounding-quotes" | "url-decode"): string {
  if (transform === "identity") return value;
  if (transform === "strip-surrounding-quotes") {
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("reviewed browser token could not be URL-decoded");
  }
}

async function resolveHeader(
  header: string,
  value: WebSessionHeaderValue,
  cookies: readonly StrictCookie[],
  template: WebSessionTemplate,
  dependencies: WebSessionHttpDependencies,
): Promise<string> {
  if (value.kind === "literal") return value.value;
  if (value.kind === "browser-csrf" && value.source.kind === "cookie") {
    return applyTransform(cookieValue(cookies, value.source.name), value.transform);
  }
  if (dependencies.resolveSecret === undefined) {
    throw new Error(`reviewed ${header} header requires a browser bootstrap that is not configured`);
  }
  const source = value.source;
  if (source.kind === "cookie") throw new Error(`reviewed ${header} cookie source could not be resolved`);
  if (source.kind === "meta") throw new Error(`reviewed ${header} meta source requires a browser-context executor`);
  const resolved = await dependencies.resolveSecret(source, { origin: template.origin, header });
  if (resolved.length < 1 || resolved.length > 64 * 1024 || /[\r\n\0]/u.test(resolved)) {
    throw new Error(`browser bootstrap returned an invalid ${header} value`);
  }
  if (value.kind === "browser-authorization" && value.transform === "bearer") {
    return resolved.startsWith("Bearer ") ? resolved : `Bearer ${resolved}`;
  }
  if (value.kind === "browser-csrf") return applyTransform(resolved, value.transform);
  return resolved;
}

function requestUrl(template: WebSessionTemplate, input: OperationInput): URL {
  const url = new URL(template.origin);
  url.pathname = `/${template.request.path.map((segment) => {
    const value = segment.kind === "literal" ? segment.value : scalar(input[segment.name], `input.${segment.name}`);
    if (typeof value !== "string") throw new Error("reviewed path input must be a string");
    return encodeURIComponent(value);
  }).join("/")}`;
  for (const parameter of template.request.query) {
    const value = renderValue(parameter.value, input);
    if (parameter.encoding === "json") url.searchParams.append(parameter.name, JSON.stringify(value));
    else url.searchParams.append(parameter.name, String(scalar(value, `query.${parameter.name}`)));
  }
  if (url.origin !== template.origin) throw new Error("reviewed request escaped its exact origin");
  return url;
}

function requestBody(template: WebSessionTemplate, input: OperationInput): string | undefined {
  const body = template.request.body;
  if (body.kind === "none") return undefined;
  if (body.kind === "json") return JSON.stringify(renderValue(body.value, input));
  const form = new URLSearchParams();
  for (const field of body.fields) {
    form.append(field.name, String(scalar(renderValue(field.value, input), `form.${field.name}`)));
  }
  return form.toString();
}

async function boundedResponse(response: Response, maximum: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value: unknown = next.value;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel();
        throw new Error("authenticated web API response yielded a non-byte chunk");
      }
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error(`authenticated web API response exceeded ${maximum} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function contentTypeEssence(response: Response): string | null {
  const raw = response.headers.get("content-type");
  return raw === null ? null : (raw.split(";", 1)[0]?.trim().toLowerCase() || null);
}

function jsonPath(value: unknown, path: readonly WebSessionJsonPathSegment[]): { readonly found: boolean; readonly value: unknown } {
  let current = value;
  for (const segment of path) {
    if (segment.kind === "key") {
      if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, segment.key)) {
        return { found: false, value: undefined };
      }
      current = (current as JsonRecord)[segment.key];
    } else {
      if (!Array.isArray(current) || segment.index >= current.length) return { found: false, value: undefined };
      current = current[segment.index];
    }
  }
  return { found: true, value: current };
}

function projectionType(value: unknown): "string" | "number" | "boolean" | "null" | "object" | "array" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  throw new Error("reviewed response projection has an unsupported value type");
}

function parseProjectedResponse(
  bytes: Uint8Array,
  body: Extract<WebSessionTemplate["response"]["variants"][number]["body"], { readonly kind: "json" }>,
  input: OperationInput,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("authenticated web API returned malformed JSON");
  }
  for (const binding of body.bindings) {
    const actual = jsonPath(parsed, binding.path);
    const expected = renderValue(binding.expected, input);
    if (!actual.found || actual.value !== expected) throw new Error("authenticated web API response failed its reviewed target binding");
  }
  const output: JsonRecord = {};
  for (const projection of body.projections) {
    const selected = jsonPath(parsed, projection.path);
    if (!selected.found) {
      if (projection.required) throw new Error(`authenticated web API response omitted required projection ${projection.name}`);
      continue;
    }
    if (projectionType(selected.value) !== projection.valueType) {
      throw new Error(`authenticated web API projection ${projection.name} changed type`);
    }
    output[projection.name] = selected.value;
  }
  return output;
}

/** Execute one reviewed first-party exchange with session credentials kept in memory. */
export async function executeWebSessionTemplate(
  template: WebSessionTemplate,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly dependencies?: Partial<WebSessionHttpDependencies>;
    /** Called after request preparation and immediately before the only network dispatch. */
    readonly beforeRequest?: () => Promise<void>;
    /** Called only after the exact response variant, bindings, and projections verify. */
    readonly afterResponseVerified?: () => Promise<void>;
  },
): Promise<WebSessionHttpResult> {
  const dependencies: WebSessionHttpDependencies = {
    acquireCookies: options.dependencies?.acquireCookies ?? acquireCookieRecords,
    fetch: options.dependencies?.fetch ?? ((input, init = {}) =>
      pinnedHttpsFetch(requestInputUrl(input), init, options.timeoutMs)),
    ...(options.dependencies?.resolveSecret === undefined
      ? {}
      : { resolveSecret: options.dependencies.resolveSecret }),
  };
  const url = requestUrl(template, input);
  const cookieResult = await dependencies.acquireCookies(cookieSelection(auth, options.timeoutMs), url);
  const headers = new Headers();
  headers.set("cookie", renderCookieHeader(cookieResult.cookies));
  for (const header of template.request.headers) {
    headers.set(header.name, await resolveHeader(header.name, header.value, cookieResult.cookies, template, dependencies));
  }
  if (template.request.body.kind === "json") headers.set("content-type", "application/json");
  if (template.request.body.kind === "form") headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  if (template.request.method !== "GET" && template.request.method !== "HEAD") headers.set("origin", template.origin);
  const body = requestBody(template, input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response | undefined;
  try {
    try {
      await options.beforeRequest?.();
      response = await dependencies.fetch(url, {
        method: template.request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error("authenticated web API request failed before a reviewed response was received", { cause: error });
    }
    const received = response;
    const contentType = contentTypeEssence(received);
    const variant = template.response.variants.find((candidate) =>
      candidate.status === received.status && candidate.contentType === contentType);
    if (variant === undefined) {
      received.body?.cancel().catch(() => undefined);
      throw new Error(`authenticated web API returned unreviewed status/content type ${received.status}/${contentType ?? "missing"}`);
    }
    const bytes = await boundedResponse(received, template.response.maxBytes);
    let result: WebSessionHttpResult;
    if (variant.body.kind === "empty") {
      if (bytes.byteLength !== 0) throw new Error("authenticated web API returned an unexpected response body");
      result = { status: received.status, output: null, responseBytes: 0 };
    } else if (variant.body.kind === "discard") {
      result = { status: received.status, output: null, responseBytes: bytes.byteLength };
    } else {
      result = {
        status: received.status,
        output: parseProjectedResponse(bytes, variant.body, input),
        responseBytes: bytes.byteLength,
      };
    }
    await options.afterResponseVerified?.();
    return result;
  } finally {
    clearTimeout(timeout);
    if (controller.signal.aborted) await response?.body?.cancel().catch(() => undefined);
  }
}
