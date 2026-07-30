import { createHash } from "node:crypto";
import type { MediaDirectHttpProvenance, MediaDirectHttpValidator } from "./manifest";
import {
  DIRECT_HTTP_MAX_BODY_BYTES,
  DIRECT_HTTP_MAX_REDIRECTS,
  DIRECT_HTTP_PROBE_BYTES,
  conflictsWithDirectMedia,
  detectDirectHttpMedia,
  directHttpMediaForContainer,
  normalizeDeclaredMediaType,
  normalizeLastModified,
  parseContentLength,
  parseContentRange,
  sha256Hex,
  strongEtag,
  validatorFromEtag,
  type DirectHttpMedia,
} from "./http";
import {
  DirectHttpProbeTransport,
  fetchWithDirectRedirects,
  type DirectHttpFetchedResponse,
  type DirectHttpFetchOptions,
  type DirectHttpOwnedRequest,
  type DirectHttpProbe,
} from "./http-probe";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

export interface DirectHttpCaptureSink {
  readonly write: (chunk: Uint8Array, signal?: AbortSignal) => Promise<void>;
  readonly restart: (signal?: AbortSignal) => Promise<void>;
  readonly close: (signal?: AbortSignal) => Promise<void>;
  readonly abort: (signal?: AbortSignal) => Promise<void>;
}

export interface DirectHttpCaptureOptions extends DirectHttpFetchOptions {
  readonly maximumBodyBytes?: number;
  readonly maximumAttempts?: number;
  readonly inactivityTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export interface DirectHttpCaptureDependencies {
  readonly request: (
    url: string,
    request: DirectHttpOwnedRequest,
    options: DirectHttpFetchOptions,
  ) => Promise<DirectHttpFetchedResponse>;
}

export interface DirectHttpCapture {
  readonly bytes: number;
  readonly sha256: string;
  readonly media: DirectHttpMedia;
  readonly provenance: MediaDirectHttpProvenance;
  readonly attempts: number;
  readonly resumed: boolean;
}

export type DirectHttpCaptureErrorCode =
  | "invalid-request"
  | "aborted"
  | "transport"
  | "http-status"
  | "unsupported-content-encoding"
  | "invalid-response-length"
  | "body-too-large"
  | "invalid-content-type"
  | "declared-text"
  | "response-read"
  | "total-timeout"
  | "sink"
  | "media-unrecognized"
  | "media-changed";

export type DirectHttpCaptureResult =
  | Readonly<{ ok: true; capture: DirectHttpCapture }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: DirectHttpCaptureErrorCode; message: string }>;
    }>;

const defaultCaptureDependencies: DirectHttpCaptureDependencies = {
  request: async (url, request, options) =>
    await fetchWithDirectRedirects(url, request, options),
};

class CaptureFailure extends Error {
  readonly code: DirectHttpCaptureErrorCode;
  readonly retryable: boolean;
  readonly resumeRejected: boolean;

  constructor(
    code: DirectHttpCaptureErrorCode,
    message: string,
    options: Readonly<{ retryable?: boolean; resumeRejected?: boolean }> = {},
  ) {
    super(message);
    this.name = "CaptureFailure";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.resumeRejected = options.resumeRejected ?? false;
  }
}

interface CaptureState {
  bytes: number;
  hash: ReturnType<typeof createHash>;
  prefix: Uint8Array;
  prefixBytes: number;
  expectedBytes: number | null;
  strongEtag: string | null;
  validator: MediaDirectHttpValidator;
  effectiveUrl: string | null;
  effectiveUrlSha256: string | null;
  redirectCount: number;
  declaredMediaType: string | null;
  lastModified: string | null;
}

function freshState(): CaptureState {
  return {
    bytes: 0,
    hash: createHash("sha256"),
    prefix: new Uint8Array(DIRECT_HTTP_PROBE_BYTES),
    prefixBytes: 0,
    expectedBytes: null,
    strongEtag: null,
    validator: { strength: "absent" },
    effectiveUrl: null,
    effectiveUrlSha256: null,
    redirectCount: 0,
    declaredMediaType: null,
    lastModified: null,
  };
}

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CaptureFailure(
      "invalid-request",
      "direct HTTP numeric option is outside its supported range",
    );
  }
  return value;
}

function captureFailure(
  error: unknown,
  fallback: DirectHttpCaptureErrorCode,
  retryable: boolean,
): CaptureFailure {
  return error instanceof CaptureFailure
    ? error
    : new CaptureFailure(fallback, "direct HTTP capture failed", { retryable });
}

function safeCancel(response: Response): void {
  void response.body?.cancel().catch(() => {
    // Cancellation failure cannot authorize or persist response bytes.
  });
}

function validIdentityEncoding(response: Response): boolean {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  return encoding === undefined || encoding === "" || encoding === "identity";
}

function exactContentLength(response: Response): number | null | "invalid" {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  return parseContentLength(raw) ?? "invalid";
}

function validateInitialResponse(
  fetched: DirectHttpFetchedResponse,
  state: CaptureState,
  maximumBodyBytes: number,
): void {
  const { response } = fetched;
  if (response.status !== 200 && response.status !== 206) {
    throw new CaptureFailure("http-status", "direct HTTP capture returned an unsupported status");
  }
  if (!validIdentityEncoding(response)) {
    throw new CaptureFailure(
      "unsupported-content-encoding",
      "direct HTTP capture did not use identity encoding",
    );
  }
  const rawMediaType = response.headers.get("content-type");
  const declaredMediaType = normalizeDeclaredMediaType(rawMediaType);
  if (rawMediaType !== null && declaredMediaType === null) {
    throw new CaptureFailure(
      "invalid-content-type",
      "direct HTTP capture media type is malformed",
    );
  }
  if (conflictsWithDirectMedia(rawMediaType)) {
    throw new CaptureFailure("declared-text", "direct HTTP capture declared a text response");
  }
  const contentLength = exactContentLength(response);
  if (contentLength === "invalid") {
    throw new CaptureFailure("invalid-response-length", "direct HTTP capture length is invalid");
  }
  if (response.status === 206) {
    const range = parseContentRange(response.headers.get("content-range"));
    if (
      range === null
      || range.start !== 0
      || range.total === null
      || range.end !== range.total - 1
      || (contentLength !== null && contentLength !== range.total)
    ) {
      throw new CaptureFailure(
        "invalid-response-length",
        "direct HTTP initial range is not a complete body",
      );
    }
    state.expectedBytes = range.total;
  } else {
    state.expectedBytes = contentLength;
  }
  if (state.expectedBytes !== null && state.expectedBytes > maximumBodyBytes) {
    throw new CaptureFailure("body-too-large", "direct HTTP body exceeds the configured limit");
  }
  state.strongEtag = strongEtag(response.headers.get("etag"));
  state.validator = validatorFromEtag(response.headers.get("etag"));
  state.effectiveUrl = fetched.effectiveUrl.href;
  state.effectiveUrlSha256 = sha256Hex(fetched.effectiveUrl.href);
  state.redirectCount = fetched.redirectCount;
  state.declaredMediaType = declaredMediaType;
  state.lastModified = normalizeLastModified(response.headers.get("last-modified"));
}

function validateResumeResponse(
  fetched: DirectHttpFetchedResponse,
  state: CaptureState,
  maximumBodyBytes: number,
): void {
  const reject = (): never => {
    throw new CaptureFailure(
      "invalid-response-length",
      "direct HTTP resume was not an exact continuation",
      { retryable: true, resumeRejected: true },
    );
  };
  const { response } = fetched;
  if (
    response.status !== 206
    || !validIdentityEncoding(response)
    || state.strongEtag === null
    || strongEtag(response.headers.get("etag")) !== state.strongEtag
    || fetched.requestedUrl.href !== state.effectiveUrl
    || fetched.effectiveUrl.href !== state.effectiveUrl
    || fetched.redirectCount !== 0
  ) reject();
  const range = parseContentRange(response.headers.get("content-range"));
  if (range === null || range.total === null) {
    throw new CaptureFailure(
      "invalid-response-length",
      "direct HTTP resume was not an exact continuation",
      { retryable: true, resumeRejected: true },
    );
  }
  const total = range.total;
  if (
    range.start !== state.bytes
    || range.end !== total - 1
    || (state.expectedBytes !== null && total !== state.expectedBytes)
  ) reject();
  const contentLength = exactContentLength(response);
  const remaining = total - state.bytes;
  if (contentLength === "invalid" || (contentLength !== null && contentLength !== remaining)) reject();
  if (total > maximumBodyBytes) {
    throw new CaptureFailure("body-too-large", "direct HTTP body exceeds the configured limit");
  }
  const rawMediaType = response.headers.get("content-type");
  if (
    (rawMediaType !== null && normalizeDeclaredMediaType(rawMediaType) === null)
    || conflictsWithDirectMedia(rawMediaType)
  ) reject();
  state.expectedBytes = total;
}

type OwnedByteReadResult =
  | Readonly<{ done: true }>
  | Readonly<{ done: false; value: Uint8Array }>;

interface OwnedByteReader {
  readonly read: () => Promise<Readonly<{ done: boolean; value?: Uint8Array }>>;
  readonly cancel: () => Promise<void>;
}

async function readWithTimeout(
  reader: OwnedByteReader,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<OwnedByteReadResult> {
  const result = await awaitInterruptibly(
    reader.read(),
    timeoutMs,
    signal,
    () => new Error("capture body timeout"),
  );
  if (result.done) return { done: true };
  if (result.value !== undefined) return { done: false, value: result.value };
  throw new Error("capture body reader omitted a chunk");
}

async function streamResponse(
  response: Response,
  sink: DirectHttpCaptureSink,
  state: CaptureState,
  maximumBodyBytes: number,
  inactivityTimeoutMs: number,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new CaptureFailure("response-read", "direct HTTP capture returned no body", { retryable: true });
  }
  try {
    while (true) {
      const totalRemainingMs = deadline - Date.now();
      if (totalRemainingMs <= 0) {
        throw new CaptureFailure("total-timeout", "direct HTTP capture exceeded its total timeout");
      }
      let read: OwnedByteReadResult;
      try {
        read = await readWithTimeout(
          reader,
          Math.min(inactivityTimeoutMs, totalRemainingMs),
          signal,
        );
      } catch (error) {
        if (error instanceof CaptureFailure) throw error;
        throw new CaptureFailure("response-read", "direct HTTP capture body stalled or failed", { retryable: true });
      }
      if (read.done) break;
      const chunk = read.value;
      if (state.bytes + chunk.byteLength > maximumBodyBytes) {
        throw new CaptureFailure("body-too-large", "direct HTTP body exceeds the configured limit");
      }
      if (state.expectedBytes !== null && state.bytes + chunk.byteLength > state.expectedBytes) {
        throw new CaptureFailure(
          "invalid-response-length",
          "direct HTTP response exceeded its declared length",
        );
      }
      try {
        await sinkOperation(
          sink.write(chunk, signal),
          deadline,
          signal,
          "direct HTTP capture could not write its destination",
        );
      } catch (error) {
        if (error instanceof CaptureFailure) throw error;
        throw new CaptureFailure("sink", "direct HTTP capture could not write its destination");
      }
      state.hash.update(chunk);
      if (state.prefixBytes < state.prefix.byteLength) {
        const copied = Math.min(chunk.byteLength, state.prefix.byteLength - state.prefixBytes);
        state.prefix.set(chunk.subarray(0, copied), state.prefixBytes);
        state.prefixBytes += copied;
      }
      state.bytes += chunk.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {
      // The response is already finished or failed; no bytes are trusted here.
    });
  }
  if (state.expectedBytes !== null && state.bytes !== state.expectedBytes) {
    throw new CaptureFailure(
      "invalid-response-length",
      "direct HTTP response ended before its declared length",
      { retryable: true },
    );
  }
}

async function sinkOperation(
  operation: Promise<void>,
  deadline: number,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new CaptureFailure("total-timeout", "direct HTTP capture exceeded its total timeout");
  }
  await awaitInterruptibly(
    operation,
    remainingMs,
    signal,
    () => new CaptureFailure("total-timeout", timeoutMessage),
  );
}

async function awaitInterruptibly<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutError: () => Error,
): Promise<T> {
  if (signal.aborted) {
    throw new CaptureFailure("aborted", "direct HTTP capture was aborted");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
        abort = () => reject(new CaptureFailure("aborted", "direct HTTP capture was aborted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

async function abortSink(sink: DirectHttpCaptureSink, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sink.abort(signal),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
  } catch {
    // Preserve the primary safe error; archive staging is reset on the next run.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function resultError(error: CaptureFailure): DirectHttpCaptureResult {
  return { ok: false, error: { code: error.code, message: error.message } };
}

/** Streams and content-qualifies one direct response without persisting transport secrets. */
export async function captureDirectHttp(
  probe: DirectHttpProbe,
  sink: DirectHttpCaptureSink,
  options: DirectHttpCaptureOptions = {},
  dependencies: DirectHttpCaptureDependencies = defaultCaptureDependencies,
): Promise<DirectHttpCaptureResult> {
  const controller = new AbortController();
  let maximumBodyBytes: number;
  let maximumAttempts: number;
  let inactivityTimeoutMs: number;
  let totalTimeoutMs: number;
  let probeRequestUrl: string;
  let requestedUrlSha256: string;
  try {
    maximumBodyBytes = normalizeBoundedInteger(
      options.maximumBodyBytes,
      DIRECT_HTTP_MAX_BODY_BYTES,
      1,
      DIRECT_HTTP_MAX_BODY_BYTES,
    );
    maximumAttempts = normalizeBoundedInteger(options.maximumAttempts, DEFAULT_ATTEMPTS, 1, 10);
    inactivityTimeoutMs = normalizeBoundedInteger(
      options.inactivityTimeoutMs,
      DEFAULT_INACTIVITY_TIMEOUT_MS,
      1,
      10 * 60_000,
    );
    totalTimeoutMs = normalizeBoundedInteger(
      options.totalTimeoutMs,
      DEFAULT_TOTAL_TIMEOUT_MS,
      1,
      24 * 60 * 60 * 1_000,
    );
    normalizeBoundedInteger(
      options.maxRedirects,
      DIRECT_HTTP_MAX_REDIRECTS,
      0,
      DIRECT_HTTP_MAX_REDIRECTS,
    );
    normalizeBoundedInteger(options.timeoutMs, 30_000, 1, 10 * 60_000);
    if (!(probe.transport instanceof DirectHttpProbeTransport)) {
      throw new CaptureFailure("invalid-request", "direct HTTP probe transport is invalid");
    }
    probeRequestUrl = probe.transport.requestUrl();
    requestedUrlSha256 = sha256Hex(probeRequestUrl);
    if (probe.requestedUrlSha256 !== requestedUrlSha256) {
      throw new CaptureFailure("invalid-request", "direct HTTP probe request digest is invalid");
    }
    const ownedMedia = directHttpMediaForContainer(probe.media.container);
    if (
      probe.media.extension !== ownedMedia.extension
      || probe.media.mediaType !== ownedMedia.mediaType
    ) {
      throw new CaptureFailure("invalid-request", "direct HTTP probe media contract is invalid");
    }
  } catch (error) {
    controller.abort();
    await abortSink(sink, controller.signal);
    return resultError(error instanceof CaptureFailure
      ? error
      : new CaptureFailure("invalid-request", "direct HTTP capture request is invalid"));
  }
  const deadline = Date.now() + totalTimeoutMs;
  let totalTimedOut = false;
  const totalTimer = setTimeout(() => {
    totalTimedOut = true;
    controller.abort();
  }, totalTimeoutMs);
  const abortFromParent = (): void => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  if (options.signal?.aborted === true) controller.abort();
  const requestOptions: DirectHttpFetchOptions = {
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    signal: controller.signal,
  };

  let state = freshState();
  let attempts = 0;
  let next: "initial" | "resume" = "initial";
  let resumed = false;
  try {
    while (attempts < maximumAttempts) {
      attempts += 1;
      const request: DirectHttpOwnedRequest = next === "resume" && state.strongEtag !== null
        ? { method: "GET", range: `bytes=${String(state.bytes)}-`, ifRange: state.strongEtag }
        : { method: "GET" };
      const requestUrl = next === "resume" && state.effectiveUrl !== null
        ? state.effectiveUrl
        : probeRequestUrl;
      const attemptOptions: DirectHttpFetchOptions = next === "resume"
        ? { ...requestOptions, maxRedirects: 0 }
        : requestOptions;
      let fetched: DirectHttpFetchedResponse;
      try {
        fetched = await awaitInterruptibly(
          dependencies.request(requestUrl, request, attemptOptions),
          Math.max(1, deadline - Date.now()),
          controller.signal,
          () => new CaptureFailure("total-timeout", "direct HTTP capture exceeded its total timeout"),
        );
      } catch (error) {
        const failure = totalTimedOut
          ? new CaptureFailure("total-timeout", "direct HTTP capture exceeded its total timeout")
          : error instanceof CaptureFailure
            ? error
            : new CaptureFailure(
                "transport",
                "direct HTTP capture request failed",
                { retryable: true },
              );
        if (!failure.retryable || attempts >= maximumAttempts) {
          await abortSink(sink, controller.signal);
          return resultError(failure);
        }
        if (next === "initial" && state.bytes === 0) continue;
        try {
          await sinkOperation(
            sink.restart(controller.signal),
            deadline,
            controller.signal,
            "direct HTTP capture could not restart before its total timeout",
          );
        } catch (error) {
          await abortSink(sink, controller.signal);
          if (error instanceof CaptureFailure) {
            return resultError(totalTimedOut
              ? new CaptureFailure("total-timeout", "direct HTTP capture exceeded its total timeout")
              : error);
          }
          return resultError(new CaptureFailure("sink", "direct HTTP capture could not restart its destination"));
        }
        state = freshState();
        next = "initial";
        continue;
      }

      try {
        if (next === "initial" && fetched.requestedUrl.href !== probeRequestUrl) {
          throw new CaptureFailure("transport", "direct HTTP capture request identity changed");
        }
        if (next === "resume") validateResumeResponse(fetched, state, maximumBodyBytes);
        else validateInitialResponse(fetched, state, maximumBodyBytes);
        await streamResponse(
          fetched.response,
          sink,
          state,
          maximumBodyBytes,
          inactivityTimeoutMs,
          deadline,
          controller.signal,
        );
        if (next === "resume") resumed = true;
      } catch (error) {
        safeCancel(fetched.response);
        const failure = captureFailure(error, "response-read", true);
        if (!failure.retryable || attempts >= maximumAttempts || totalTimedOut) {
          await abortSink(sink, controller.signal);
          return resultError(totalTimedOut
            ? new CaptureFailure("total-timeout", "direct HTTP capture exceeded its total timeout")
            : failure);
        }
        if (failure.resumeRejected || state.strongEtag === null || state.bytes === 0) {
          try {
            await sinkOperation(
              sink.restart(controller.signal),
              deadline,
              controller.signal,
              "direct HTTP capture could not restart before its total timeout",
            );
          } catch (restartError) {
            await abortSink(sink, controller.signal);
            if (restartError instanceof CaptureFailure) {
              return resultError(totalTimedOut
                ? new CaptureFailure("total-timeout", "direct HTTP capture exceeded its total timeout")
                : restartError);
            }
            return resultError(new CaptureFailure("sink", "direct HTTP capture could not restart its destination"));
          }
          state = freshState();
          next = "initial";
        } else {
          next = "resume";
        }
        continue;
      } finally {
        fetched.dispose();
      }

      const media = detectDirectHttpMedia(state.prefix.subarray(0, state.prefixBytes));
      if (media === null) {
        await abortSink(sink, controller.signal);
        return resultError(new CaptureFailure("media-unrecognized", "direct HTTP capture did not contain recognized media"));
      }
      const ownedMedia = directHttpMediaForContainer(media.container);
      if (
        media.container !== probe.media.container
        || media.extension !== ownedMedia.extension
        || media.mediaType !== ownedMedia.mediaType
      ) {
        await abortSink(sink, controller.signal);
        return resultError(new CaptureFailure("media-changed", "direct HTTP media changed after its probe"));
      }
      if (state.effectiveUrlSha256 === null) {
        await abortSink(sink, controller.signal);
        return resultError(new CaptureFailure("transport", "direct HTTP capture omitted effective provenance"));
      }
      let sha256: string;
      try {
        sha256 = state.hash.digest("hex");
        await sinkOperation(
          sink.close(controller.signal),
          deadline,
          controller.signal,
          "direct HTTP capture could not close before its total timeout",
        );
      } catch (error) {
        await abortSink(sink, controller.signal);
        if (error instanceof CaptureFailure) {
          return resultError(totalTimedOut
            ? new CaptureFailure("total-timeout", "direct HTTP capture exceeded its total timeout")
            : error);
        }
        return resultError(new CaptureFailure("sink", "direct HTTP capture could not finalize its destination"));
      }
      const provenance: MediaDirectHttpProvenance = {
        requestedUrlSha256,
        effectiveUrlSha256: state.effectiveUrlSha256,
        validator: state.validator,
        lastModified: state.lastModified,
        declaredMediaType: state.declaredMediaType,
        container: media.container,
        body: { bytes: state.bytes, sha256 },
        redirectCount: state.redirectCount,
      };
      return {
        ok: true,
        capture: {
          bytes: state.bytes,
          sha256,
          media,
          provenance,
          attempts,
          resumed,
        },
      };
    }
    await abortSink(sink, controller.signal);
    return resultError(new CaptureFailure("transport", "direct HTTP capture exhausted its attempts"));
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
