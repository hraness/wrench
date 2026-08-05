import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, parse, resolve, sep } from "node:path";

import { BoundedByteBuffer } from "@hraness/kb/clip/bounded-byte-buffer";
import type { WrenchAuth } from "./auth";
import {
  OperationDeadline,
  OperationDeadlineError,
} from "./operation-deadline";

export type OAuthTokenAuth = Extract<WrenchAuth, { readonly kind: "oauth-token-file" }>;

export type LoadedOAuthToken = {
  readonly accessToken: string;
  readonly expiresAt: string | null;
};

const MAX_TOKEN_FILE_BYTES = 64 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const DEFAULT_MINIMUM_TOKEN_VALIDITY_MS = 30_000;
const PROVIDER_OPERATION_LABEL = "official provider operation";
const PROVIDER_RESPONSE_CLEANUP_JOIN_MS = 500;

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(stats: BigIntStats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined || stats.uid === BigInt(uid);
}

function canonicalTokenPath(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const relative = absolute.slice(root.length);
  const segments = relative === "" ? [] : relative.split(sep).filter((segment) => segment !== "");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const candidate = resolve(current, segment);
    const stats = lstatSync(candidate, { bigint: true });
    if (stats.isSymbolicLink()) {
      // Permit only intermediate, root-owned compatibility aliases such as
      // macOS /var -> /private/var. The token itself and every user-controlled
      // link remain forbidden, and the resolved path is used from this point.
      if (index === segments.length - 1 || process.platform === "win32" || stats.uid !== 0n) {
        throw new Error("OAuth token path cannot contain user-controlled symbolic links");
      }
      current = realpathSync(candidate);
    } else current = candidate;
  }
  return current;
}

function readPrivateTokenFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("OAuth token file path must be absolute");
  const canonical = canonicalTokenPath(path);
  const descriptor = openSync(
    canonical,
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || !ownedByCurrentUser(before)
      || (process.platform !== "win32" && (before.mode & 0o777n) !== 0o600n)
      || before.size < 1n
      || before.size > BigInt(MAX_TOKEN_FILE_BYTES)
    ) {
      throw new Error("OAuth token file must be a current-user-owned regular file with mode 0600 and at most 65536 bytes");
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      offset !== buffer.byteLength
      || !sameIdentity(before, after)
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || before.mode !== after.mode
    ) throw new Error("OAuth token file changed while it was read");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function tokenExpiry(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("OAuth token file has an invalid expiresAt timestamp");
  }
  return new Date(value).toISOString();
}

function hasForbiddenAccessTokenCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) return true;
  }
  return false;
}

/**
 * Load a canonical private token document. The locator remains secret-free;
 * provider, subject, and scopes are repeated here to prevent a path mix-up
 * from silently granting a different realm.
 */
export function loadOAuthToken(
  auth: OAuthTokenAuth,
  now = new Date(),
  minimumValidityMs = DEFAULT_MINIMUM_TOKEN_VALIDITY_MS,
): LoadedOAuthToken {
  if (
    !Number.isSafeInteger(minimumValidityMs)
    || minimumValidityMs < 0
  ) {
    throw new Error("OAuth token minimum validity budget must be a non-negative safe integer");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("OAuth token validity reference time is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateTokenFile(auth.path)) as unknown;
  } catch (error) {
    throw new Error(`could not load private ${auth.provider} OAuth token document`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("OAuth token document must be an object");
  const expected = ["schemaVersion", "provider", "subject", "scopes", "accessToken", "expiresAt"];
  if (!exactKeys(parsed, expected)) throw new Error("OAuth token document has unsupported fields");
  if (parsed.schemaVersion !== 1 || parsed.provider !== auth.provider) {
    throw new Error("OAuth token document provider or schema version does not match its locator");
  }
  if ((parsed.subject ?? null) !== (auth.subject ?? null)) {
    throw new Error("OAuth token document subject does not match its locator");
  }
  if (
    !Array.isArray(parsed.scopes)
    || !parsed.scopes.every((scope) => typeof scope === "string")
    || parsed.scopes.length !== auth.scopes.length
    || parsed.scopes.some((scope, index) => scope !== auth.scopes[index])
  ) throw new Error("OAuth token document scopes do not match its locator");
  if (
    typeof parsed.accessToken !== "string"
    || Buffer.byteLength(parsed.accessToken, "utf8") < 8
    || Buffer.byteLength(parsed.accessToken, "utf8") > MAX_ACCESS_TOKEN_BYTES
    || hasForbiddenAccessTokenCharacter(parsed.accessToken)
  ) throw new Error("OAuth token document contains an invalid accessToken");
  const expiresAt = tokenExpiry(parsed.expiresAt);
  if (
    expiresAt !== null
    && Date.parse(expiresAt) - nowMs <= minimumValidityMs
  ) {
    const budget = minimumValidityMs === DEFAULT_MINIMUM_TOKEN_VALIDITY_MS
      ? "expires within 30 seconds"
      : `does not remain valid for the required ${minimumValidityMs}ms budget`;
    throw new Error(`the ${auth.provider} OAuth access token is expired or ${budget}; rotate the private token file`);
  }
  return { accessToken: parsed.accessToken, expiresAt };
}

export function requireOAuthScopes(
  auth: OAuthTokenAuth,
  alternatives: readonly (readonly string[])[],
  additional: readonly string[] = [],
): void {
  const available = new Set(auth.scopes);
  const base = alternatives.find((candidate) => candidate.every((scope) => available.has(scope)));
  if (base === undefined) {
    throw new Error(`OAuth locator ${auth.id} lacks one complete required ${auth.provider} scope set`);
  }
  const missing = additional.filter((scope) => !available.has(scope));
  if (missing.length > 0) throw new Error(`OAuth locator ${auth.id} lacks required scope(s): ${missing.join(", ")}`);
}

export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ProviderResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
};

export type ProviderResponseMediaType = "application/json";

type ProviderResponseReader = {
  readonly read: () => Promise<unknown>;
  readonly cancel: (reason?: unknown) => Promise<void>;
  readonly releaseLock: () => void;
};

async function settlesWithin<T>(
  operation: Promise<T>,
  maximumMs: number,
): Promise<PromiseSettledResult<T> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        (value): PromiseFulfilledResult<T> => ({
          status: "fulfilled",
          value,
        }),
        (reason: unknown): PromiseRejectedResult => ({
          status: "rejected",
          reason,
        }),
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), maximumMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function combineCleanupFailures(
  current: Error | null,
  next: Error,
): Error {
  return current === null
    ? next
    : new AggregateError(
        [current, next],
        "multiple official provider response cleanup checks failed",
      );
}

function responseCleanupVerificationError(
  primaryFailure: unknown,
  cleanupFailure: Error,
): AggregateError {
  const primary = primaryFailure instanceof Error
    ? primaryFailure
    : new Error("official provider response processing failed", {
        cause: primaryFailure,
      });
  return new AggregateError(
    [primary, cleanupFailure],
    `${primary.message}; official provider response cleanup could not be verified`,
  );
}

async function cancellationCleanupFailure(
  cancellation: Promise<unknown>,
  concurrentOperations: readonly Promise<unknown>[],
  diagnostic: string,
): Promise<{
  readonly failure: Error | null;
  readonly settled: boolean;
}> {
  const quiescence = Promise.allSettled([
    ...concurrentOperations,
    cancellation,
  ]).then((results) => {
    const cancellationResult = results.at(-1);
    if (cancellationResult?.status === "rejected") {
      throw cancellationResult.reason;
    }
  });
  const settled = await settlesWithin(
    quiescence,
    PROVIDER_RESPONSE_CLEANUP_JOIN_MS,
  );
  if (settled !== null && settled.status === "fulfilled") {
    return { failure: null, settled: true };
  }
  return {
    failure: new Error(
      diagnostic,
      settled?.status === "rejected"
        ? { cause: settled.reason }
        : undefined,
    ),
    settled: settled !== null,
  };
}

async function cancelResponseBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Error | null> {
  if (body === null) return null;
  const cancellation = Promise.resolve().then(() =>
    body.cancel("official provider response was rejected")
  );
  return (await cancellationCleanupFailure(
    cancellation,
    [],
    "official provider response body cleanup did not settle after cancellation",
  )).failure;
}

function releaseReaderAfterPendingRead(
  reader: ProviderResponseReader,
  pendingRead: Promise<unknown>,
): void {
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // The caller already failed closed because synchronous cleanup could not
      // be verified. This late path only makes eventual lock release possible.
    }
  };
  void pendingRead.then(release, release);
}

async function joinLateResponseCleanup(
  fetchOperation: Promise<Response>,
  deadlineError: OperationDeadlineError,
): Promise<void> {
  const cleanup = fetchOperation.then(
    async (response) => {
      await response.body?.cancel("official provider request deadline expired");
    },
    () => undefined,
  );
  const settled = await settlesWithin(
    cleanup,
    PROVIDER_RESPONSE_CLEANUP_JOIN_MS,
  );
  if (settled !== null && settled.status === "fulfilled") return;
  const cleanupError = new Error(
    "official provider response cleanup did not settle after cancellation",
    settled?.status === "rejected"
      ? { cause: settled.reason }
      : undefined,
  );
  throw new AggregateError(
    [deadlineError, cleanupError],
    `${deadlineError.message}; official provider response cleanup could not be verified`,
  );
}

function hasOversizedContentLength(response: Response, maximumBytes: number): boolean {
  const declared = response.headers.get("content-length");
  if (declared === null || !/^[0-9]+$/u.test(declared)) return false;
  return BigInt(declared) > BigInt(maximumBytes);
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
  deadline: OperationDeadline | null,
): Promise<string> {
  const body = response.body;
  if (body === null) {
    deadline?.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
    return "";
  }
  let reader: ProviderResponseReader | null = null;
  let pendingRead: Promise<unknown> | null = null;
  let pendingReadSettled = true;
  let deferReaderRelease = false;
  let failed = false;
  let failure: unknown;
  let cleanupFailure: Error | null = null;
  let text: string | undefined;
  const output = new BoundedByteBuffer(maximumBytes);
  try {
    deadline?.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
    if (hasOversizedContentLength(response, maximumBytes)) {
      throw new Error(`provider response exceeds ${maximumBytes} bytes`);
    }
    const activeReader: ProviderResponseReader = body.getReader();
    reader = activeReader;
    for (;;) {
      pendingReadSettled = false;
      pendingRead = activeReader.read();
      void pendingRead.then(
        () => {
          pendingReadSettled = true;
        },
        () => {
          pendingReadSettled = true;
        },
      );
      const next = deadline === null
        ? await pendingRead
        : await deadline.run(
            () => pendingRead as Promise<unknown>,
            PROVIDER_OPERATION_LABEL,
          );
      pendingRead = null;
      if (!isRecord(next) || typeof next.done !== "boolean") {
        throw new Error("provider response returned an invalid body read result");
      }
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("provider response returned an invalid body chunk");
      if (!output.append(chunk)) throw new Error(`provider response exceeds ${maximumBytes} bytes`);
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(output.toUint8Array());
    deadline?.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
  } catch (error) {
    failed = true;
    failure = error;
    if (reader === null) {
      cleanupFailure = await cancelResponseBody(body);
    } else {
      const activeReader = reader;
      const cancellation = Promise.resolve().then(() =>
        activeReader.cancel("official provider response processing stopped")
      );
      const cleanup = await cancellationCleanupFailure(
        cancellation,
        pendingRead === null ? [] : [pendingRead],
        "official provider response reader cleanup did not settle after cancellation",
      );
      cleanupFailure = cleanup.failure;
      deferReaderRelease = !cleanup.settled
        && pendingRead !== null
        && !pendingReadSettled;
    }
  } finally {
    if (reader !== null) {
      if (deferReaderRelease && pendingRead !== null) {
        releaseReaderAfterPendingRead(reader, pendingRead);
      } else {
        try {
          reader.releaseLock();
        } catch (error) {
          cleanupFailure = combineCleanupFailures(
            cleanupFailure,
            new Error(
              "official provider response reader lock could not be released",
              { cause: error },
            ),
          );
        }
      }
    }
  }
  if (failed) {
    if (cleanupFailure !== null) {
      throw responseCleanupVerificationError(failure, cleanupFailure);
    }
    throw failure;
  }
  if (cleanupFailure !== null) {
    throw new Error(
      "official provider response cleanup could not be verified",
      { cause: cleanupFailure },
    );
  }
  if (text === undefined) {
    throw new Error("official provider response processing did not produce text");
  }
  return text;
}

function safePath(url: URL): string {
  return `${url.pathname}${url.search === "" ? "" : "?…"}`;
}

export class ProviderHttpClient {
  readonly #fetch: ProviderFetch;
  readonly #operationDeadline: OperationDeadline | null;
  readonly #legacyDeadlineMs: number | null;
  readonly #maximumBytes: number;

  constructor(
    fetch_: ProviderFetch,
    timeoutOrDeadline: number | OperationDeadline,
    maximumBytes: number,
  ) {
    this.#fetch = fetch_;
    this.#operationDeadline = timeoutOrDeadline instanceof OperationDeadline
      ? timeoutOrDeadline
      : null;
    this.#legacyDeadlineMs = typeof timeoutOrDeadline === "number"
      ? Date.now() + timeoutOrDeadline
      : null;
    this.#maximumBytes = maximumBytes;
  }

  /** Remaining operation-wide budget shared by requests and provider polling. */
  remainingTimeMs(): number {
    return this.#operationDeadline?.remainingTimeMs()
      ?? Math.max(0, (this.#legacyDeadlineMs ?? 0) - Date.now());
  }

  /** Fail synchronously when CPU-bound response projection has exhausted the shared deadline. */
  throwIfUnavailable(): void {
    this.#operationDeadline?.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
    if (this.remainingTimeMs() < 1) {
      throw new Error("official provider operation timed out during response projection");
    }
  }

  async request(
    urlValue: string | URL,
    init: RequestInit,
    expectedStatuses: readonly number[],
    allowedHosts: readonly string[],
    maximumBytes = this.#maximumBytes,
    responseMediaType?: ProviderResponseMediaType,
  ): Promise<ProviderResponse> {
    if (
      !Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1
      || maximumBytes > this.#maximumBytes
    ) {
      throw new Error("official provider request response limit must be a positive safe integer within the client ceiling");
    }
    if (responseMediaType !== undefined && responseMediaType !== "application/json") {
      throw new Error("official provider request has an unsupported response media-type policy");
    }
    const url = new URL(urlValue);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.port !== ""
      || !allowedHosts.includes(url.hostname)
    ) throw new Error("official provider request attempted an unapproved origin");
    this.#operationDeadline?.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
    const remaining = this.remainingTimeMs();
    if (remaining < 1) throw new Error("official provider operation timed out before its next request");
    let response: Response;
    let fetchOperation: Promise<Response> | undefined;
    try {
      response = this.#operationDeadline === null
        ? await this.#fetch(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.timeout(remaining),
          })
        : await this.#operationDeadline.run(
            (signal) => {
              fetchOperation = Promise.resolve().then(() =>
                this.#fetch(url, {
                  ...init,
                  redirect: "error",
                  signal,
                })
              );
              return fetchOperation;
            },
            PROVIDER_OPERATION_LABEL,
          );
    } catch (error) {
      if (error instanceof OperationDeadlineError) {
        if (fetchOperation !== undefined) {
          await joinLateResponseCleanup(fetchOperation, error);
        }
        throw error;
      }
      throw new Error(`official provider request did not return a response for ${init.method ?? "GET"} ${safePath(url)}`, { cause: error });
    }
    if (!expectedStatuses.includes(response.status)) {
      const failure = new Error(`official provider returned HTTP ${response.status} for ${init.method ?? "GET"} ${safePath(url)}`);
      const cleanupFailure = await cancelResponseBody(response.body);
      if (cleanupFailure !== null) {
        throw responseCleanupVerificationError(failure, cleanupFailure);
      }
      throw failure;
    }
    if (responseMediaType === "application/json") {
      const contentType = response.headers.get("content-type");
      if (
        contentType === null
        || contentType.length > 256
        || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu.test(contentType)
      ) {
        const failure = new Error(
          `official provider returned an unsupported response media type for ${init.method ?? "GET"} ${safePath(url)}`,
        );
        const cleanupFailure = await cancelResponseBody(response.body);
        if (cleanupFailure !== null) {
          throw responseCleanupVerificationError(failure, cleanupFailure);
        }
        throw failure;
      }
    }
    const text = await boundedResponseText(
      response,
      maximumBytes,
      this.#operationDeadline,
    );
    if (text === "") return { status: response.status, headers: response.headers, body: null };
    try {
      const body = JSON.parse(text) as unknown;
      this.#operationDeadline?.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      throw new Error(`official provider returned malformed JSON for ${init.method ?? "GET"} ${safePath(url)}`, { cause: error });
    }
  }
}

export function bearerHeaders(accessToken: string, extra: Readonly<Record<string, string>> = {}): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}
