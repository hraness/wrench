import type { MediaDirectHttpValidator } from "./manifest";
import {
  DIRECT_HTTP_MAX_BODY_BYTES,
  DIRECT_HTTP_MAX_REDIRECTS,
  DIRECT_HTTP_PROBE_BYTES,
  DirectHttpBoundaryError,
  conflictsWithDirectMedia,
  detectDirectHttpMedia,
  normalizeDeclaredMediaType,
  normalizeLastModified,
  parseContentLength,
  parseContentRange,
  parsePublicHttpUrl,
  publicOrigin,
  resolveDirectHttpRedirect,
  sha256Hex,
  strongEtag,
  validatorFromEtag,
  type DirectHttpMedia,
} from "./http";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DIRECT_HTTP_ACCEPT = "video/*, audio/*, application/ogg, application/octet-stream;q=0.5";
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export type DirectHttpOwnedRequest =
  | Readonly<{ method: "HEAD" }>
  | Readonly<{ method: "GET"; range?: string; ifRange?: string }>;

export interface DirectHttpFetchOptions {
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DirectHttpFetchDependencies {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
}

export interface DirectHttpFetchedResponse {
  readonly response: Response;
  readonly requestedUrl: URL;
  readonly effectiveUrl: URL;
  readonly redirectCount: number;
  /** Releases the parent-abort bridge after the response body is finished. */
  readonly dispose: () => void;
}

export type DirectHttpTransportErrorCode =
  | "invalid-request"
  | "redirect-policy"
  | "too-many-redirects"
  | "timeout"
  | "aborted"
  | "network";

export class DirectHttpTransportError extends Error {
  readonly code: DirectHttpTransportErrorCode;

  constructor(code: DirectHttpTransportErrorCode, message: string) {
    super(message);
    this.name = "DirectHttpTransportError";
    this.code = code;
  }
}

/** Keeps a request URL available to the adapter without making it serializable. */
export class DirectHttpProbeTransport {
  readonly #requestUrl: string;

  constructor(value: string) {
    this.#requestUrl = parsePublicHttpUrl(value).href;
    Object.freeze(this);
  }

  requestUrl(): string {
    return this.#requestUrl;
  }

  toJSON(): Readonly<{ kind: "opaque-direct-http-transport" }> {
    return { kind: "opaque-direct-http-transport" };
  }
}

export interface DirectHttpProbe {
  /** Raw request URL is held only inside this non-enumerable transport handle. */
  readonly transport: DirectHttpProbeTransport;
  readonly publicOrigin: string;
  readonly requestedUrlSha256: string;
  readonly effectiveUrlSha256: string;
  readonly redirectCount: number;
  readonly declaredMediaType: string | null;
  readonly lastModified: string | null;
  readonly validator: MediaDirectHttpValidator;
  readonly media: DirectHttpMedia;
  readonly expectedBytes: number | null;
}

export interface DirectHttpProbeOptions extends DirectHttpFetchOptions {
  readonly maximumBodyBytes?: number;
  readonly probeBytes?: number;
  readonly headTimeoutMs?: number;
}

export type DirectHttpProbeNotApplicableReason =
  | "http-status"
  | "empty-response"
  | "declared-text"
  | "unrecognized-media";

export type DirectHttpProbeErrorCode =
  | DirectHttpTransportErrorCode
  | "unsupported-content-encoding"
  | "invalid-response-length"
  | "invalid-content-type"
  | "body-too-large"
  | "response-read";

export type DirectHttpProbeResult =
  | Readonly<{ ok: true; probe: DirectHttpProbe }>
  | Readonly<{ ok: false; kind: "not-applicable"; reason: DirectHttpProbeNotApplicableReason }>
  | Readonly<{
      ok: false;
      kind: "error";
      error: Readonly<{ code: DirectHttpProbeErrorCode; message: string }>;
    }>;

const defaultFetchDependencies: DirectHttpFetchDependencies = {
  fetch: async (input, init) => await fetch(input, init),
};

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DirectHttpTransportError(
      "invalid-request",
      "direct HTTP numeric option is outside its supported range",
    );
  }
  return value;
}

function ownedHeaders(request: DirectHttpOwnedRequest): Headers {
  const headers = new Headers({
    Accept: DIRECT_HTTP_ACCEPT,
    "Accept-Encoding": "identity",
  });
  if (request.method === "GET") {
    if (request.range !== undefined) headers.set("Range", request.range);
    if (request.ifRange !== undefined) headers.set("If-Range", request.ifRange);
  }
  return headers;
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {
    // The connection is already unusable; no response bytes cross the boundary.
  });
}

function validRange(value: string): boolean {
  const match = /^bytes=(0|[1-9]\d*)-(0|[1-9]\d*)?$/u.exec(value);
  if (match === null) return false;
  const start = Number(match[1]);
  const end = match[2] === undefined ? null : Number(match[2]);
  return Number.isSafeInteger(start)
    && start >= 0
    && (end === null || (Number.isSafeInteger(end) && end >= start));
}

function validateOwnedRequest(request: DirectHttpOwnedRequest): void {
  if (request.method === "HEAD") return;
  if (request.method !== "GET") {
    throw new DirectHttpTransportError("invalid-request", "direct HTTP method is invalid");
  }
  if (request.range !== undefined && !validRange(request.range)) {
    throw new DirectHttpTransportError("invalid-request", "direct HTTP range is invalid");
  }
  if (request.ifRange !== undefined && strongEtag(request.ifRange) !== request.ifRange) {
    throw new DirectHttpTransportError("invalid-request", "direct HTTP resume validator is invalid");
  }
}

function boundaryAsTransport(error: DirectHttpBoundaryError): DirectHttpTransportError {
  return new DirectHttpTransportError(
    error.code === "too-many-redirects" ? "too-many-redirects" : "redirect-policy",
    "direct HTTP rejected the request or redirect policy",
  );
}

function abortReason(signal: AbortSignal, timedOut: boolean): DirectHttpTransportError {
  return timedOut
    ? new DirectHttpTransportError("timeout", "direct HTTP request timed out")
    : new DirectHttpTransportError(
        signal.aborted ? "aborted" : "network",
        signal.aborted ? "direct HTTP request was aborted" : "direct HTTP request failed",
      );
}

/** Performs one closed, manually redirected request with Wrench media-owned headers only. */
export async function fetchWithDirectRedirects(
  value: string,
  request: DirectHttpOwnedRequest,
  options: DirectHttpFetchOptions = {},
  dependencies: DirectHttpFetchDependencies = defaultFetchDependencies,
): Promise<DirectHttpFetchedResponse> {
  validateOwnedRequest(request);
  let requestedUrl: URL;
  try {
    requestedUrl = parsePublicHttpUrl(value);
  } catch (error) {
    if (error instanceof DirectHttpBoundaryError) throw boundaryAsTransport(error);
    throw new DirectHttpTransportError("invalid-request", "direct HTTP request is invalid");
  }
  const maxRedirects = normalizeBoundedInteger(
    options.maxRedirects,
    DIRECT_HTTP_MAX_REDIRECTS,
    0,
    DIRECT_HTTP_MAX_REDIRECTS,
  );
  const timeoutMs = normalizeBoundedInteger(
    options.timeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    10 * 60_000,
  );
  if (request.method === "GET" && request.ifRange !== undefined && maxRedirects !== 0) {
    throw new DirectHttpTransportError(
      "invalid-request",
      "direct HTTP resume requests must disable redirects",
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromParent = (): void => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (options.signal?.aborted === true) controller.abort();

  let current = requestedUrl;
  let redirectCount = 0;
  let handedOff = false;
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  };
  try {
    while (true) {
      let response: Response;
      try {
        response = await dependencies.fetch(current.href, {
          method: request.method,
          headers: ownedHeaders(request),
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
      } catch {
        throw abortReason(controller.signal, timedOut);
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        clearTimeout(timeout);
        handedOff = true;
        return { response, requestedUrl, effectiveUrl: current, redirectCount, dispose };
      }
      const location = response.headers.get("location");
      cancelBody(response);
      if (location === null) {
        throw new DirectHttpTransportError(
          "redirect-policy",
          "direct HTTP redirect omitted its target",
        );
      }
      if (redirectCount >= maxRedirects) {
        throw new DirectHttpTransportError(
          "too-many-redirects",
          "direct HTTP exceeded the redirect limit",
        );
      }
      try {
        current = resolveDirectHttpRedirect(current, location);
      } catch (error) {
        if (error instanceof DirectHttpBoundaryError) throw boundaryAsTransport(error);
        throw new DirectHttpTransportError(
          "redirect-policy",
          "direct HTTP rejected a redirect",
        );
      }
      redirectCount += 1;
    }
  } finally {
    if (!handedOff) dispose();
  }
}

function probeError(
  code: DirectHttpProbeErrorCode,
  message: string,
): Extract<DirectHttpProbeResult, { readonly kind: "error" }> {
  return { ok: false, kind: "error", error: { code, message } };
}

function declaredLength(headers: Headers): Readonly<{
  expectedBytes: number | null;
  responseBytes: number | null;
}> | null {
  const rawLength = headers.get("content-length");
  const contentLength = parseContentLength(rawLength);
  if (rawLength !== null && contentLength === null) return null;
  return { expectedBytes: contentLength, responseBytes: contentLength };
}

function rangedLength(response: Response, probeBytes: number): Readonly<{
  expectedBytes: number | null;
  responseBytes: number;
}> | null {
  const contentRange = parseContentRange(response.headers.get("content-range"));
  if (contentRange === null || contentRange.start !== 0 || contentRange.end >= probeBytes) {
    return null;
  }
  const responseBytes = contentRange.end - contentRange.start + 1;
  const rawLength = response.headers.get("content-length");
  const contentLength = parseContentLength(rawLength);
  if (rawLength !== null && (contentLength === null || contentLength !== responseBytes)) return null;
  return { expectedBytes: contentRange.total, responseBytes };
}

async function boundedResponsePrefix(
  response: Response,
  maximumBytes: number,
  timeoutMs: number,
  inspectOverflowAtLimit: boolean,
): Promise<Readonly<{ bytes: Uint8Array; ended: boolean; overflowed: boolean }>> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { bytes: new Uint8Array(), ended: true, overflowed: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  let overflowed = false;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (total === maximumBytes && !inspectOverflowAtLimit) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("probe body timeout");
      const read = await readWithDeadline(reader, remainingMs);
      if (read.done) {
        ended = true;
        break;
      }
      if (total === maximumBytes) {
        overflowed = read.value.byteLength > 0;
        break;
      }
      const remaining = maximumBytes - total;
      const chunk = read.value.byteLength <= remaining
        ? read.value
        : read.value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < read.value.byteLength) {
        overflowed = true;
        break;
      }
    }
  } finally {
    void reader.cancel().catch(() => {
      // A failed cancellation cannot make bounded bytes trusted or persistent.
    });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, ended, overflowed };
}

type OwnedByteReadResult =
  | Readonly<{ done: true }>
  | Readonly<{ done: false; value: Uint8Array }>;

interface OwnedByteReader {
  readonly read: () => Promise<Readonly<{ done: boolean; value?: Uint8Array }>>;
}

async function readWithDeadline(
  reader: OwnedByteReader,
  timeoutMs: number,
): Promise<OwnedByteReadResult> {
  return await new Promise<OwnedByteReadResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe body timeout")), timeoutMs);
    void reader.read().then(
      (result) => {
        clearTimeout(timer);
        if (result.done) {
          resolve({ done: true });
        } else if (result.value !== undefined) {
          resolve({ done: false, value: result.value });
        } else {
          reject(new Error("probe body reader omitted a chunk"));
        }
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("probe body read failed"));
      },
    );
  });
}

/** Probes one public URL without allowing a page response to become a capture. */
export async function probeDirectHttp(
  value: string,
  options: DirectHttpProbeOptions = {},
  dependencies: DirectHttpFetchDependencies = defaultFetchDependencies,
): Promise<DirectHttpProbeResult> {
  let maximumBodyBytes: number;
  let probeBytes: number;
  let bodyTimeoutMs: number;
  let headTimeoutMs: number;
  try {
    maximumBodyBytes = normalizeBoundedInteger(
      options.maximumBodyBytes,
      DIRECT_HTTP_MAX_BODY_BYTES,
      1,
      DIRECT_HTTP_MAX_BODY_BYTES,
    );
    probeBytes = normalizeBoundedInteger(
      options.probeBytes,
      DIRECT_HTTP_PROBE_BYTES,
      1,
      DIRECT_HTTP_PROBE_BYTES,
    );
    bodyTimeoutMs = normalizeBoundedInteger(
      options.timeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      10 * 60_000,
    );
    headTimeoutMs = normalizeBoundedInteger(options.headTimeoutMs, 5_000, 1, 30_000);
    normalizeBoundedInteger(
      options.maxRedirects,
      DIRECT_HTTP_MAX_REDIRECTS,
      0,
      DIRECT_HTTP_MAX_REDIRECTS,
    );
  } catch (error) {
    return probeError(
      "invalid-request",
      error instanceof DirectHttpTransportError
        ? error.message
        : "direct HTTP probe options are invalid",
    );
  }
  const common: DirectHttpFetchOptions = {
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const probeLimit = Math.min(probeBytes, maximumBodyBytes);

  // HEAD may cheaply warm a connection or expose size, but it is never trusted
  // as the media decision and its ordinary failures do not block the range GET.
  try {
    const head = await fetchWithDirectRedirects(
      value,
      { method: "HEAD" },
      {
        ...common,
        timeoutMs: headTimeoutMs,
      },
      dependencies,
    );
    cancelBody(head.response);
    head.dispose();
  } catch {
    // The GET below repeats every redirect and security check independently.
  }

  let fetched: DirectHttpFetchedResponse;
  try {
    fetched = await fetchWithDirectRedirects(
      value,
      { method: "GET", range: `bytes=0-${String(probeLimit - 1)}` },
      common,
      dependencies,
    );
  } catch (error) {
    if (error instanceof DirectHttpTransportError) return probeError(error.code, error.message);
    return probeError("network", "direct HTTP probe failed");
  }
  const { response } = fetched;
  try {
    if (response.status !== 200 && response.status !== 206) {
      cancelBody(response);
      return { ok: false, kind: "not-applicable", reason: "http-status" };
    }
    const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity") {
      cancelBody(response);
      return probeError(
        "unsupported-content-encoding",
        "direct HTTP response did not use identity encoding",
      );
    }
    const length = response.status === 206
      ? rangedLength(response, probeLimit)
      : declaredLength(response.headers);
    if (length === null) {
      cancelBody(response);
      return probeError("invalid-response-length", "direct HTTP response length is inconsistent");
    }
    if (length.expectedBytes !== null && length.expectedBytes > maximumBodyBytes) {
      cancelBody(response);
      return probeError("body-too-large", "direct HTTP body exceeds the configured limit");
    }
    let prefix: Awaited<ReturnType<typeof boundedResponsePrefix>>;
    try {
      prefix = await boundedResponsePrefix(
        response,
        probeLimit,
        bodyTimeoutMs,
        length.responseBytes !== null || probeLimit === maximumBodyBytes,
      );
    } catch {
      return probeError("response-read", "direct HTTP probe body could not be read");
    }
    if (
      length.responseBytes !== null
      && (
        (length.responseBytes <= probeLimit
          && (prefix.bytes.byteLength !== length.responseBytes || prefix.overflowed))
        || (prefix.ended && prefix.bytes.byteLength !== length.responseBytes)
      )
    ) {
      return probeError("invalid-response-length", "direct HTTP response body length disagrees with headers");
    }
    if (probeLimit === maximumBodyBytes && prefix.overflowed) {
      return probeError("body-too-large", "direct HTTP body exceeds the configured limit");
    }
    if (prefix.bytes.byteLength === 0) {
      return { ok: false, kind: "not-applicable", reason: "empty-response" };
    }
    const rawMediaType = response.headers.get("content-type");
    const declaredMediaType = normalizeDeclaredMediaType(rawMediaType);
    if (rawMediaType !== null && declaredMediaType === null) {
      return probeError("invalid-content-type", "direct HTTP response media type is malformed");
    }
    if (conflictsWithDirectMedia(rawMediaType)) {
      return { ok: false, kind: "not-applicable", reason: "declared-text" };
    }
    const media = detectDirectHttpMedia(prefix.bytes);
    if (media === null) {
      return { ok: false, kind: "not-applicable", reason: "unrecognized-media" };
    }
    const requestedUrl = fetched.requestedUrl.href;
    const effectiveUrl = fetched.effectiveUrl.href;
    return {
      ok: true,
      probe: {
        transport: new DirectHttpProbeTransport(requestedUrl),
        publicOrigin: publicOrigin(fetched.requestedUrl),
        requestedUrlSha256: sha256Hex(requestedUrl),
        effectiveUrlSha256: sha256Hex(effectiveUrl),
        redirectCount: fetched.redirectCount,
        declaredMediaType,
        lastModified: normalizeLastModified(response.headers.get("last-modified")),
        validator: validatorFromEtag(response.headers.get("etag")),
        media,
        expectedBytes: length.expectedBytes,
      },
    };
  } finally {
    fetched.dispose();
  }
}
