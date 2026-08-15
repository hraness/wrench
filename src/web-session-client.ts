import {
  acquireCookieRecords,
  type CookieRecordReader,
  type CookieSelection,
} from "@hraness/kb/clip/acquire";
import { BoundedByteBuffer } from "@hraness/kb/clip/bounded-byte-buffer";
import {
  filterCookies,
  renderCookieHeader,
  type StrictCookie,
} from "@hraness/kb/clip/cookies";

import type { WrenchAuth } from "./auth";
import { OperationDeadline } from "./operation-deadline";
import { pinnedHttpsFetch } from "./pinned-https";
import type { WebSessionOperationDeadline } from "./web-session-execution";

const WEB_SESSION_OPERATION_LABEL = "authenticated web operation deadline";
const MIN_PINNED_HTTPS_TIMEOUT_MS = 1_000;

export type WebSessionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type WebSessionNetworkDependencies = {
  readonly acquireCookies: CookieRecordReader;
  readonly fetch: WebSessionFetch;
};

export type WebSessionCookieRotationEntry = {
  /** Time at which wrench accepted this exact provider response value. */
  readonly acceptedAtSeconds: number;
  readonly cookie: StrictCookie;
};

export type WebSessionCookieRotationTombstone = {
  /** Time at which wrench accepted the provider's exact deletion response. */
  readonly acceptedAtSeconds: number;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly name: string;
  readonly path: string;
};

export type WebSessionCookieRotationState = {
  readonly cookies: readonly WebSessionCookieRotationEntry[];
  readonly tombstones: readonly WebSessionCookieRotationTombstone[];
};

export type WebSessionCookieRotation = {
  /**
   * Exact response-cookie names that one reviewed provider contract may
   * absorb. Every other Set-Cookie field is ignored.
   */
  readonly allowedNames: readonly string[];
  /**
   * Authenticated, provider-parsed response state from a prior invocation.
   * Cache membership is provenance: a live cached value or tombstone is
   * authoritative over the independently acquired browser snapshot.
   */
  readonly cachedState: WebSessionCookieRotationState;
  /** Bound session-cookie persistence when the provider omitted an expiry. */
  readonly maxCachedCookieAgeSeconds: number;
  /** Bound deletion suppression so a tombstone cannot outlive review policy. */
  readonly tombstoneTtlSeconds: number;
  /** Persist only reviewed response state, never the source cookie jar. */
  readonly save: (state: WebSessionCookieRotationState) => void | Promise<void>;
};

export type WebSessionClient = {
  readonly origin: string;
  readonly cookies: readonly StrictCookie[];
  readonly requestText: (request: {
    readonly url: URL;
    readonly method?: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly expectedContentTypes: readonly string[];
    readonly maxBytes: number;
  }) => Promise<string>;
  readonly requestJson: (request: {
    readonly url: URL;
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly expectedStatuses?: readonly number[];
    readonly expectedContentTypes?: readonly string[];
    readonly maxBytes: number;
  }) => Promise<unknown>;
  readonly requestStatus: (request: {
    readonly url: URL;
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string | Uint8Array;
    readonly expectedStatuses: readonly number[];
  }) => Promise<{ readonly status: number; readonly location: string | null }>;
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

type BoundWebSessionNetworkDependencies = {
  readonly acquireCookies: CookieRecordReader;
  readonly fetch: (
    input: string | URL | Request,
    init: RequestInit,
    timeoutMs: number,
  ) => Promise<Response>;
};

function networkDependencies(
  overrides: Partial<WebSessionNetworkDependencies> | undefined,
): BoundWebSessionNetworkDependencies {
  return {
    acquireCookies: overrides?.acquireCookies ?? acquireCookieRecords,
    fetch: overrides?.fetch === undefined
      ? (input, init, timeoutMs) => {
          if (timeoutMs < MIN_PINNED_HTTPS_TIMEOUT_MS) {
            throw new Error(
              "authenticated web operation has insufficient time for its next request",
            );
          }
          return pinnedHttpsFetch(requestInputUrl(input), init, timeoutMs);
        }
      : (input, init) => overrides.fetch!(input, init),
  };
}

type WebSessionDeadlineOptions = {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly operationDeadline?: WebSessionOperationDeadline;
};

async function withWebSessionDeadline<T>(
  options: WebSessionDeadlineOptions,
  work: (deadline: WebSessionOperationDeadline) => Promise<T>,
): Promise<T> {
  const ownedDeadline = options.operationDeadline === undefined
    ? new OperationDeadline(options.timeoutMs, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    : null;
  const deadline = options.operationDeadline ?? ownedDeadline;
  if (deadline === null) {
    throw new Error("authenticated web operation deadline is unavailable");
  }
  try {
    return await deadline.run(
      () => work(deadline),
      WEB_SESSION_OPERATION_LABEL,
    );
  } finally {
    ownedDeadline?.dispose();
  }
}

function remainingRequestTimeMs(
  deadline: WebSessionOperationDeadline,
): number {
  deadline.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const remaining = deadline.remainingTimeMs();
  if (remaining < 1) {
    throw new Error(
      "authenticated web operation timed out before its next request",
    );
  }
  return remaining;
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

function contentTypeEssence(response: Response): string | null {
  const raw = response.headers.get("content-type");
  if (raw === null) return null;
  const essence = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return essence === "" ? null : essence;
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const slash = value.indexOf("/");
  if (slash < 0) return false;
  const subtype = value.slice(slash + 1);
  return subtype === "json" || subtype.endsWith("+json");
}

async function boundedBytes(
  response: Response,
  maximum: number,
  deadline: WebSessionOperationDeadline,
): Promise<Uint8Array> {
  deadline.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024) {
    throw new Error("authenticated web response byte limit is invalid");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum) {
      response.body?.cancel().catch(() => undefined);
      throw new Error("authenticated web response exceeded its reviewed byte limit");
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const buffer = new BoundedByteBuffer(maximum);
  try {
    for (;;) {
      const item = await deadline.run(
        () => reader.read(),
        WEB_SESSION_OPERATION_LABEL,
      );
      if (item.done) break;
      const value: unknown = item.value;
      if (!(value instanceof Uint8Array)) {
        void reader.cancel().catch(() => undefined);
        throw new Error("authenticated web response yielded a non-byte chunk");
      }
      if (!buffer.append(value)) {
        void reader.cancel().catch(() => undefined);
        throw new Error("authenticated web response exceeded its reviewed byte limit");
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  deadline.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  return buffer.toUint8Array();
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("authenticated web API returned invalid UTF-8 JSON");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("authenticated web API returned malformed JSON");
  }
}

function exactCookie(cookies: readonly StrictCookie[], name: string): string {
  const matches = cookies.filter((cookie) => cookie.name === name);
  if (matches.length !== 1) throw new Error(`authenticated session must contain exactly one ${name} cookie`);
  return matches[0]?.value ?? "";
}

function cookieIdentity(cookie: StrictCookie): string {
  return `${cookie.domain}\0${cookie.hostOnly ? "host" : "domain"}\0${cookie.path}\0${cookie.name}`;
}

function responseSetCookieHeaders(headers: Headers): readonly string[] {
  const extended = headers as Headers & { readonly getSetCookie?: () => string[] };
  const values = typeof extended.getSetCookie === "function"
    ? extended.getSetCookie()
    : (() => {
        const value = headers.get("set-cookie");
        return value === null ? [] : [value];
      })();
  if (
    values.length > 64
    || values.some((value) => typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024)
  ) throw new Error("authenticated web response Set-Cookie fields exceeded their reviewed bounds");
  return values;
}

type ParsedResponseCookie =
  | { readonly kind: "set"; readonly cookie: StrictCookie }
  | {
      readonly kind: "remove";
      readonly name: string;
      readonly domain: string;
      readonly hostOnly: boolean;
      readonly path: string;
    };

function parseResponseCookie(
  value: string,
  target: URL,
  allowedNames: ReadonlySet<string>,
  nowSeconds: number,
): ParsedResponseCookie | null {
  const fields = value.split(";");
  const pair = fields.shift()?.trim() ?? "";
  const separator = pair.indexOf("=");
  if (separator < 1) return null;
  const name = pair.slice(0, separator).trim();
  if (!allowedNames.has(name)) return null;
  const candidate: Record<string, unknown> = {
    name,
    value: pair.slice(separator + 1).trim(),
    domain: target.hostname,
    hostOnly: true,
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: null,
  };
  let expiresAttribute: number | undefined;
  let maxAgeAttribute: number | undefined;
  const seen = new Set<string>();
  for (const rawField of fields) {
    const field = rawField.trim();
    if (field === "") continue;
    const attributeSeparator = field.indexOf("=");
    const rawName = attributeSeparator < 0 ? field : field.slice(0, attributeSeparator);
    const attribute = rawName.trim().toLowerCase();
    const attributeValue = attributeSeparator < 0 ? null : field.slice(attributeSeparator + 1).trim();
    if (seen.has(attribute)) {
      throw new Error(`reviewed rotating cookie ${name} repeated an attribute`);
    }
    seen.add(attribute);
    if (attribute === "domain") {
      if (attributeValue === null || attributeValue === "") {
        throw new Error(`reviewed rotating cookie ${name} has an invalid Domain`);
      }
      candidate.domain = attributeValue;
      candidate.hostOnly = false;
    } else if (attribute === "path") {
      if (attributeValue === null || attributeValue === "") {
        throw new Error(`reviewed rotating cookie ${name} has an invalid Path`);
      }
      candidate.path = attributeValue;
    } else if (attribute === "secure") {
      if (attributeValue !== null) throw new Error(`reviewed rotating cookie ${name} has an invalid Secure flag`);
      candidate.secure = true;
    } else if (attribute === "httponly") {
      if (attributeValue !== null) throw new Error(`reviewed rotating cookie ${name} has an invalid HttpOnly flag`);
      candidate.httpOnly = true;
    } else if (attribute === "samesite") {
      if (attributeValue === null || !["strict", "lax", "none"].includes(attributeValue.toLowerCase())) {
        throw new Error(`reviewed rotating cookie ${name} has an invalid SameSite`);
      }
      candidate.sameSite = `${attributeValue[0]?.toUpperCase() ?? ""}${attributeValue.slice(1).toLowerCase()}`;
    } else if (attribute === "expires") {
      if (attributeValue === null) throw new Error(`reviewed rotating cookie ${name} has an invalid Expires`);
      const milliseconds = Date.parse(attributeValue);
      if (!Number.isFinite(milliseconds)) throw new Error(`reviewed rotating cookie ${name} has an invalid Expires`);
      expiresAttribute = Math.trunc(milliseconds / 1_000);
    } else if (attribute === "max-age") {
      if (attributeValue === null || !/^-?[0-9]{1,12}$/u.test(attributeValue)) {
        throw new Error(`reviewed rotating cookie ${name} has an invalid Max-Age`);
      }
      const seconds = Number(attributeValue);
      if (!Number.isSafeInteger(seconds)) throw new Error(`reviewed rotating cookie ${name} has an invalid Max-Age`);
      maxAgeAttribute = seconds;
    } else if (attribute === "priority") {
      if (attributeValue === null || !["low", "medium", "high"].includes(attributeValue.toLowerCase())) {
        throw new Error(`reviewed rotating cookie ${name} has an invalid Priority`);
      }
    } else {
      throw new Error(`reviewed rotating cookie ${name} added an unsupported attribute`);
    }
  }
  // RFC 6265 gives Max-Age precedence over Expires regardless of their wire
  // order. Resolve them only after parsing every attribute so an expired
  // Expires cannot turn a positive Max-Age into a deletion (or vice versa).
  const effectiveExpires = maxAgeAttribute === undefined
    ? expiresAttribute
    : maxAgeAttribute <= 0
      ? nowSeconds
      : nowSeconds + maxAgeAttribute;
  const remove = effectiveExpires !== undefined && effectiveExpires <= nowSeconds;
  if (!remove && effectiveExpires !== undefined) candidate.expires = effectiveExpires;
  const validated = filterCookies([candidate], target, nowSeconds);
  if (validated.rejected !== 0 || validated.cookies.length !== 1) {
    throw new Error(`reviewed rotating cookie ${name} escaped its exact origin scope`);
  }
  const cookie = validated.cookies[0];
  if (cookie === undefined) throw new Error(`reviewed rotating cookie ${name} disappeared during validation`);
  return remove
    ? {
        kind: "remove",
        name: cookie.name,
        domain: cookie.domain,
        hostOnly: cookie.hostOnly,
        path: cookie.path,
      }
    : { kind: "set", cookie };
}

export function webSessionCookie(cookies: readonly StrictCookie[], name: string): string {
  return exactCookie(cookies, name);
}

export function webSessionAuthSubject(auth: WrenchAuth): string | null {
  if (!("subject" in auth) || typeof auth.subject !== "string" || auth.subject.length === 0) return null;
  return auth.subject;
}

export async function createWebSessionClient(
  origin: string,
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: Partial<WebSessionNetworkDependencies>;
    readonly cookieRotation?: WebSessionCookieRotation;
  },
): Promise<WebSessionClient> {
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.protocol !== "https:"
    || parsedOrigin.origin !== origin
    || parsedOrigin.pathname !== "/"
    || parsedOrigin.search !== ""
    || parsedOrigin.hash !== ""
  ) throw new Error("authenticated web client origin must be exact canonical HTTPS");
  const dependencies = networkDependencies(options.dependencies);
  const cookieResult = await withWebSessionDeadline(
    options,
    (deadline) => dependencies.acquireCookies(
      cookieSelection(auth, deadline.remainingTimeMs()),
      parsedOrigin,
    ),
  );
  const validatedSource = filterCookies(cookieResult.cookies, parsedOrigin);
  if (
    validatedSource.rejected !== 0
    || validatedSource.cookies.length !== cookieResult.cookies.length
  ) throw new Error("authenticated web cookie source returned malformed or out-of-scope records");
  const rotation = options.cookieRotation;
  const allowedNames = new Set(rotation?.allowedNames ?? []);
  if (
    rotation !== undefined
    && (
      allowedNames.size !== rotation.allowedNames.length
      || allowedNames.size < 1
      || allowedNames.size > 16
      || [...allowedNames].some((name) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u.test(name))
      || !Number.isSafeInteger(rotation.maxCachedCookieAgeSeconds)
      || rotation.maxCachedCookieAgeSeconds < 1
      || rotation.maxCachedCookieAgeSeconds > 31 * 24 * 60 * 60
      || !Number.isSafeInteger(rotation.tombstoneTtlSeconds)
      || rotation.tombstoneTtlSeconds < 1
      || rotation.tombstoneTtlSeconds > 31 * 24 * 60 * 60
    )
  ) throw new Error("authenticated web rotating-cookie allowlist is invalid");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const cachedCookies = new Map<string, WebSessionCookieRotationEntry>();
  const cachedTombstones = new Map<string, WebSessionCookieRotationTombstone>();
  if (rotation !== undefined) {
    if (
      rotation.cachedState.cookies.length > 64
      || rotation.cachedState.tombstones.length > 64
    ) throw new Error("authenticated web rotating-cookie cache exceeded its reviewed bounds");
    for (const entry of rotation.cachedState.cookies) {
      if (
        !Number.isSafeInteger(entry.acceptedAtSeconds)
        || entry.acceptedAtSeconds < 0
        || entry.acceptedAtSeconds > nowSeconds + 300
        || !allowedNames.has(entry.cookie.name)
      ) throw new Error("authenticated web rotating-cookie cache is invalid");
      const validated = filterCookies([entry.cookie], parsedOrigin, nowSeconds);
      if (validated.rejected !== 0 || validated.cookies.length !== 1) {
        throw new Error("authenticated web rotating-cookie cache is invalid");
      }
      if (nowSeconds - entry.acceptedAtSeconds > rotation.maxCachedCookieAgeSeconds) continue;
      const cookie = validated.cookies[0];
      if (cookie === undefined) throw new Error("authenticated web rotating-cookie cache is invalid");
      const key = cookieIdentity(cookie);
      if (cachedCookies.has(key)) throw new Error("authenticated web rotating-cookie cache contains a duplicate");
      cachedCookies.set(key, Object.freeze({
        acceptedAtSeconds: entry.acceptedAtSeconds,
        cookie,
      }));
    }
    for (const tombstone of rotation.cachedState.tombstones) {
      if (
        !Number.isSafeInteger(tombstone.acceptedAtSeconds)
        || tombstone.acceptedAtSeconds < 0
        || tombstone.acceptedAtSeconds > nowSeconds + 300
        || !allowedNames.has(tombstone.name)
      ) throw new Error("authenticated web rotating-cookie cache is invalid");
      const validated = filterCookies([{
        name: tombstone.name,
        value: "",
        domain: tombstone.domain,
        hostOnly: tombstone.hostOnly,
        path: tombstone.path,
        secure: parsedOrigin.protocol === "https:",
        httpOnly: false,
        sameSite: null,
        expires: 0,
      }], parsedOrigin, nowSeconds);
      const identity = validated.cookies[0];
      if (validated.rejected !== 0 || validated.cookies.length !== 1 || identity === undefined) {
        throw new Error("authenticated web rotating-cookie cache is invalid");
      }
      const key = cookieIdentity(identity);
      if (
        identity.name !== tombstone.name
        || identity.domain !== tombstone.domain
        || identity.hostOnly !== tombstone.hostOnly
        || identity.path !== tombstone.path
        || cachedTombstones.has(key)
        || cachedCookies.has(key)
      ) throw new Error("authenticated web rotating-cookie cache is invalid");
      if (nowSeconds - tombstone.acceptedAtSeconds > rotation.tombstoneTtlSeconds) continue;
      cachedTombstones.set(key, Object.freeze({ ...tombstone }));
    }
  }
  let rotatingCookies = cachedCookies;
  let rotatingTombstones = cachedTombstones;
  const combinedCookies = (): readonly StrictCookie[] => {
    const combined = new Map<string, StrictCookie>();
    for (const cookie of validatedSource.cookies) {
      const key = cookieIdentity(cookie);
      if (!rotatingTombstones.has(key) && !rotatingCookies.has(key)) combined.set(key, cookie);
    }
    for (const { cookie } of rotatingCookies.values()) {
      combined.set(cookieIdentity(cookie), cookie);
    }
    return [...combined.values()];
  };
  const applyResponseCookies = async (response: Response, target: URL): Promise<void> => {
    if (rotation === undefined) return;
    const changes = responseSetCookieHeaders(response.headers)
      .map((value) => parseResponseCookie(value, target, allowedNames, Math.floor(Date.now() / 1_000)))
      .filter((value): value is ParsedResponseCookie => value !== null);
    if (changes.length === 0) return;
    const acceptedAtSeconds = Math.floor(Date.now() / 1_000);
    const nextCookies = new Map(rotatingCookies);
    const nextTombstones = new Map(rotatingTombstones);
    for (const change of changes) {
      const key = change.kind === "set"
        ? cookieIdentity(change.cookie)
        : `${change.domain}\0${change.hostOnly ? "host" : "domain"}\0${change.path}\0${change.name}`;
      if (change.kind === "set") {
        nextCookies.set(key, Object.freeze({
          acceptedAtSeconds,
          cookie: change.cookie,
        }));
        nextTombstones.delete(key);
      } else {
        nextCookies.delete(key);
        nextTombstones.set(key, Object.freeze({
          acceptedAtSeconds,
          domain: change.domain,
          hostOnly: change.hostOnly,
          name: change.name,
          path: change.path,
        }));
      }
    }
    rotatingCookies = nextCookies;
    rotatingTombstones = nextTombstones;
    await rotation.save(Object.freeze({
      cookies: Object.freeze([...rotatingCookies.values()]),
      tombstones: Object.freeze([...rotatingTombstones.values()]),
    }));
  };
  return {
    origin,
    get cookies() {
      return combinedCookies();
    },
    requestText: async (request) => {
      if (request.url.origin !== origin || request.url.username !== "" || request.url.password !== "" || request.url.hash !== "") {
        throw new Error("authenticated web request escaped its reviewed origin");
      }
      const method = request.method ?? "GET";
      if (request.body !== undefined && method !== "POST") {
        throw new Error("authenticated web text request body requires POST");
      }
      if (method === "POST" && request.body === undefined) {
        throw new Error("authenticated web text POST requires a body");
      }
      const headers = new Headers(request.headers);
      headers.set("cookie", renderCookieHeader(combinedCookies()));
      return withWebSessionDeadline(options, async (deadline) => {
        let response: Response | undefined;
        try {
          try {
            response = await deadline.run(
              () => dependencies.fetch(
                request.url,
                {
                  method,
                  headers,
                  ...(request.body === undefined ? {} : { body: request.body }),
                  redirect: "error",
                  signal: deadline.signal,
                },
                remainingRequestTimeMs(deadline),
              ),
              WEB_SESSION_OPERATION_LABEL,
            );
          } catch (error) {
            throw new Error("authenticated web request failed before a reviewed response was received", { cause: error });
          }
          const contentType = contentTypeEssence(response);
          if (response.status !== 200 || contentType === null || !request.expectedContentTypes.includes(contentType)) {
            response.body?.cancel().catch(() => undefined);
            throw new Error(`authenticated web request returned unreviewed status/content type ${response.status}/${contentType ?? "missing"}`);
          }
          await applyResponseCookies(response, request.url);
          const bytes = await boundedBytes(
            response,
            request.maxBytes,
            deadline,
          );
          try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new Error("authenticated web request returned invalid UTF-8");
          }
        } finally {
          if (deadline.signal.aborted) {
            void response?.body?.cancel().catch(() => undefined);
          }
        }
      });
    },
    requestJson: async (request) => {
      if (request.url.origin !== origin || request.url.username !== "" || request.url.password !== "" || request.url.hash !== "") {
        throw new Error("authenticated web API request escaped its reviewed origin");
      }
      if (request.body !== undefined && request.method !== "POST") {
        throw new Error("authenticated web API request body requires POST");
      }
      const headers = new Headers(request.headers);
      headers.set("cookie", renderCookieHeader(combinedCookies()));
      return withWebSessionDeadline(options, async (deadline) => {
        let response: Response | undefined;
        try {
          try {
            response = await deadline.run(
              () => dependencies.fetch(
                request.url,
                {
                  method: request.method,
                  headers,
                  ...(request.body === undefined ? {} : { body: request.body }),
                  redirect: "error",
                  signal: deadline.signal,
                },
                remainingRequestTimeMs(deadline),
              ),
              WEB_SESSION_OPERATION_LABEL,
            );
          } catch (error) {
            throw new Error("authenticated web API request failed before a reviewed response was received", { cause: error });
          }
          const expected = request.expectedStatuses ?? [200];
          const contentType = contentTypeEssence(response);
          const contentTypeAllowed = request.expectedContentTypes === undefined
            ? isJsonContentType(contentType)
            : contentType !== null && request.expectedContentTypes.includes(contentType);
          if (!expected.includes(response.status) || !contentTypeAllowed) {
            response.body?.cancel().catch(() => undefined);
            throw new Error(`authenticated web API returned unreviewed status/content type ${response.status}/${contentType ?? "missing"}`);
          }
          await applyResponseCookies(response, request.url);
          return parseJson(await boundedBytes(
            response,
            request.maxBytes,
            deadline,
          ));
        } finally {
          if (deadline.signal.aborted) {
            void response?.body?.cancel().catch(() => undefined);
          }
        }
      });
    },
    requestStatus: async (request) => {
      if (request.url.origin !== origin || request.url.username !== "" || request.url.password !== "" || request.url.hash !== "") {
        throw new Error("authenticated web API request escaped its reviewed origin");
      }
      if (request.body !== undefined && request.method !== "POST") {
        throw new Error("authenticated web API request body requires POST");
      }
      if (
        request.expectedStatuses.length < 1
        || request.expectedStatuses.length > 10
        || request.expectedStatuses.some((status) => !Number.isSafeInteger(status) || status < 100 || status > 599)
      ) throw new Error("authenticated web API expected status list is invalid");
      const headers = new Headers(request.headers);
      headers.set("cookie", renderCookieHeader(combinedCookies()));
      return withWebSessionDeadline(options, async (deadline) => {
        let response: Response | undefined;
        try {
          try {
            response = await deadline.run(
              () => dependencies.fetch(
                request.url,
                {
                  method: request.method,
                  headers,
                  ...(request.body === undefined ? {} : { body: request.body }),
                  redirect: "error",
                  signal: deadline.signal,
                },
                remainingRequestTimeMs(deadline),
              ),
              WEB_SESSION_OPERATION_LABEL,
            );
          } catch (error) {
            throw new Error("authenticated web API request failed before a reviewed response was received", { cause: error });
          }
          if (!request.expectedStatuses.includes(response.status)) {
            response.body?.cancel().catch(() => undefined);
            throw new Error(`authenticated web API request returned unreviewed status ${response.status}`);
          }
          await applyResponseCookies(response, request.url);
          const rawLocation = response.headers.get("location");
          let location: string | null = null;
          if (rawLocation !== null) {
            const parsed = new URL(rawLocation, origin);
            if (
              parsed.origin !== origin
              || parsed.username !== ""
              || parsed.password !== ""
              || parsed.hash !== ""
            ) {
              response.body?.cancel().catch(() => undefined);
              throw new Error("authenticated web API response attempted an unreviewed redirect");
            }
            location = `${parsed.pathname}${parsed.search}`;
          }
          void response.body?.cancel().catch(() => undefined);
          deadline.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
          return { status: response.status, location };
        } finally {
          if (deadline.signal.aborted) {
            void response?.body?.cancel().catch(() => undefined);
          }
        }
      });
    },
  };
}

export async function fetchPublicWebAsset(
  url: URL,
  options: {
    readonly allowedOrigin: string;
    readonly contentTypes: readonly string[];
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly dependencies?: Partial<WebSessionNetworkDependencies>;
  },
): Promise<string> {
  if (url.origin !== options.allowedOrigin || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("public web asset escaped its reviewed origin");
  }
  const dependencies = networkDependencies(options.dependencies);
  return withWebSessionDeadline(options, async (deadline) => {
    let response: Response | undefined;
    try {
      try {
        response = await deadline.run(
          () => dependencies.fetch(
            url,
            {
              method: "GET",
              redirect: "error",
              signal: deadline.signal,
            },
            remainingRequestTimeMs(deadline),
          ),
          WEB_SESSION_OPERATION_LABEL,
        );
      } catch (error) {
        throw new Error("public first-party web asset request failed", { cause: error });
      }
      const contentType = contentTypeEssence(response);
      if (response.status !== 200 || contentType === null || !options.contentTypes.includes(contentType)) {
        response.body?.cancel().catch(() => undefined);
        throw new Error(`public first-party web asset returned unreviewed status/content type ${response.status}/${contentType ?? "missing"}`);
      }
      const bytes = await boundedBytes(
        response,
        options.maxBytes,
        deadline,
      );
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("public first-party web asset returned invalid UTF-8");
      }
    } finally {
      if (deadline.signal.aborted) {
        void response?.body?.cancel().catch(() => undefined);
      }
    }
  });
}
