import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { BoundedByteBuffer } from "@hraness/kb/clip/bounded-byte-buffer";

import type { WrenchAuth } from "../auth";
import {
  browserCleanupBarrier,
  browserResultData,
  createBrowserSession,
  PreservedBrowserArtifactsError,
  type BrowserFileResolver,
  type BrowserSession,
} from "../browser";
import type {
  FileInputValue,
  OperationInput,
  WrenchManifest,
  WebSessionRecipe,
} from "../model";
import { canonicalJson, sha256 } from "../canonical-json";
import { OperationDeadline } from "../operation-deadline";
import { pinnedHttpsFetch } from "../pinned-https";
import {
  readSessionSecretSnapshot,
  writeSessionSecretIfUnchanged,
  type SessionSecretSnapshot,
  type SessionSecretWriteResult,
} from "../session-secrets";
import { webSessionAuthSubject } from "../web-session-client";
import {
  startWebSessionCleanupTrackedOperation,
  type WebSessionCleanupBarrierRegistrar,
  type WebSessionCleanupResourcePublisher,
  type WebSessionDispatchEvent,
  type WebSessionExecution,
  type WebSessionOperationDeadline,
  type WebSessionProviderAcceptedMutationTargetEvent,
} from "../web-session-execution";
import {
  BLUESKY_APPVIEW_PROXY,
  BLUESKY_APP_ORIGIN,
  BLUESKY_CHAT_PROXY,
  BLUESKY_NOTIFICATION_PROXY,
  BLUESKY_WEB_OPERATIONS,
  BLUESKY_WEB_OPERATION_NAMES,
  BLUESKY_XRPC_METHODS,
  assertBlueskyText,
  authorizeBlueskyXrpcRequest,
  blueskyCid,
  blueskyDid,
  blueskyPostUri,
  parseBlueskyAtUri,
  parseBlueskyBootstrapAccount,
  parseBlueskyCreateRecordResponse,
  parseBlueskyCurrentPostRecordResponse,
  parseBlueskyDeleteRecordResponse,
  parseBlueskyGetRecordResponse,
  parseBlueskyRecordNotFoundResponse,
  parseBlueskyRefreshSessionResponse,
  parseBlueskySessionResponse,
  parseBlueskyUploadBlobResponse,
  projectBlueskyBookmarks,
  projectBlueskyConvo,
  projectBlueskyConvoList,
  projectBlueskyFeed,
  projectBlueskyMessages,
  projectBlueskyNotifications,
  projectBlueskyPostsResponse,
  projectBlueskyProfile,
  projectBlueskyThread,
  type BlueskyBlobRef,
  type BlueskyProjectedPost,
  type BlueskyRequestBinding,
  type BlueskySessionMaterial,
  type BlueskyStrongRef,
  type BlueskyWebOperationName,
  type BlueskyXrpcMethod,
} from "./bluesky-web";

const MAX_BOOTSTRAP_BYTES = 64 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2_000_000;
const DEFAULT_LIMIT = 25;
const WEB_SESSION_OPERATION_LABEL = "authenticated web operation deadline";
const PUBLISH_READBACK_DELAYS_MS = Object.freeze([0, 250, 750, 1_500]);
const BLUESKY_RECORD_NOT_FOUND = Symbol("bluesky-record-not-found");

type JsonRecord = Record<string, unknown>;
type BlueskyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BlueskyWebRuntimeDependencies = {
  readonly fetch?: BlueskyFetch;
  readonly createBrowserSession?: typeof createBrowserSession;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Test-only seam. The result is still parsed by the sealed account parser
   * before it can reach an authorization header.
   */
  readonly bootstrapAccount?: (
    auth: WrenchAuth,
  ) => Promise<unknown>;
  /** Test-only encrypted-session cache seam. */
  readonly loadCachedSession?: (
    auth: WrenchAuth,
    authHash: string,
  ) => SessionSecretSnapshot | Promise<SessionSecretSnapshot>;
  /** Test-only encrypted-session cache seam. */
  readonly saveCachedSession?: (
    auth: WrenchAuth,
    authHash: string,
    value: unknown,
    expectedContentSha256: string | null,
  ) => SessionSecretWriteResult | Promise<SessionSecretWriteResult>;
};

export type BlueskyWebDesiredStateKind =
  | "bookmark"
  | "follow"
  | "like"
  | "repost";

export type BlueskyWebDesiredStateReadback =
  | {
      readonly kind: Exclude<BlueskyWebDesiredStateKind, "follow">;
      readonly enabled: boolean;
      readonly postUri: string;
    }
  | {
      readonly kind: "follow";
      readonly enabled: boolean;
      readonly actorDid: string;
    };

type BlueskyClient = {
  readonly session: BlueskySessionMaterial;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly fetch: BlueskyFetch;
  readonly operationDeadline?: WebSessionOperationDeadline;
};

function remainingTimeoutMs(
  timeoutMs: number,
  deadline: WebSessionOperationDeadline | undefined,
): number {
  deadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const remaining = Math.min(
    timeoutMs,
    deadline?.remainingTimeMs() ?? timeoutMs,
  );
  if (remaining < 1) {
    throw new Error("Bluesky authenticated web operation timed out");
  }
  return remaining;
}

const blueskyBootstrapManifest = Object.freeze({
  schemaVersion: 2,
  id: "wrench-bluesky-session-bootstrap",
  version: "1.0.0",
  displayName: "Wrench Bluesky session bootstrap",
  origins: Object.freeze([BLUESKY_APP_ORIGIN]),
  browserDomains: Object.freeze(["bsky.app"]),
  operations: Object.freeze({}),
} satisfies WrenchManifest);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isBlueskyOperation(value: string): value is BlueskyWebOperationName {
  return (BLUESKY_WEB_OPERATION_NAMES as readonly string[]).includes(value);
}

function inputString(
  input: OperationInput,
  name: string,
  maximum: number,
): string {
  const value = input[name];
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`input.${name} must be bounded text`);
  return value;
}

function optionalInputString(
  input: OperationInput,
  name: string,
  maximum: number,
): string | undefined {
  if (input[name] === undefined) return undefined;
  return inputString(input, name, maximum);
}

function inputBoolean(input: OperationInput, name: string): boolean {
  const value = input[name];
  if (typeof value !== "boolean") throw new Error(`input.${name} must be boolean`);
  return value;
}

function inputInteger(
  input: OperationInput,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[name] ?? fallback;
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) throw new Error(`input.${name} must be an integer between ${minimum} and ${maximum}`);
  return value as number;
}

function optionalCursor(input: OperationInput): string | undefined {
  return optionalInputString(input, "cursor", 8_192);
}

function postUriInput(input: OperationInput): string {
  return blueskyPostUri(inputString(input, "post_uri", 1_024), "input.post_uri").uri;
}

function convoIdInput(input: OperationInput): string {
  const result = inputString(input, "convo_id", 512);
  if (!/^[A-Za-z0-9._~:-]{1,512}$/u.test(result)) {
    throw new Error("input.convo_id must be an exact Bluesky conversation ID");
  }
  return result;
}

function browserEvaluationSource(): string {
  return `(()=>{if(location.origin!=="${BLUESKY_APP_ORIGIN}")throw new Error("unexpected Bluesky origin");const raw=localStorage.getItem("BSKY_STORAGE");if(typeof raw!=="string"||raw.length<2||raw.length>1048576)throw new Error("Bluesky storage unavailable");const root=JSON.parse(raw);const session=root&&typeof root==="object"&&root.session;const current=session&&typeof session==="object"&&session.currentAccount;const accounts=session&&typeof session==="object"&&session.accounts;if(!current||typeof current.did!=="string"||!Array.isArray(accounts)||accounts.length>100)throw new Error("Bluesky current account unavailable");const matches=accounts.filter(account=>account&&typeof account==="object"&&account.did===current.did);if(matches.length!==1)throw new Error("Bluesky current account ambiguous");const account=matches[0];return{did:account.did,handle:account.handle,accessJwt:account.accessJwt,refreshJwt:account.refreshJwt,service:account.service,pdsUrl:typeof account.pdsUrl==="string"?account.pdsUrl:null}})()`;
}

function bootstrapEvaluationResult(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("Bluesky browser bootstrap returned a malformed envelope");
  let observedOrigin: string | null = null;
  if (typeof value.origin === "string") {
    try {
      observedOrigin = new URL(value.origin).origin;
    } catch {
      observedOrigin = null;
    }
  }
  if (observedOrigin !== BLUESKY_APP_ORIGIN) {
    throw new Error("Bluesky browser bootstrap escaped its reviewed origin");
  }
  return value.result;
}

type BrowserFinalizationResult = {
  readonly closeVerified: boolean;
  readonly cleanupVerified: boolean;
  readonly failures: readonly unknown[];
};

async function finalizeBrowserSession(
  session: BrowserSession,
): Promise<BrowserFinalizationResult> {
  const failures: unknown[] = [];
  let closeVerified = false;
  try {
    await session.close();
    closeVerified = true;
  } catch (error) {
    failures.push(error);
  }
  let cleanupVerified = false;
  try {
    await session.cleanup();
    cleanupVerified = true;
  } catch (error) {
    failures.push(error);
  }
  return Object.freeze({
    closeVerified,
    cleanupVerified,
    failures: Object.freeze(failures),
  });
}

async function bootstrapFromBrowser(
  auth: WrenchAuth,
  timeoutMs: number,
  dependencies: BlueskyWebRuntimeDependencies | undefined,
  operationDeadline?: WebSessionOperationDeadline,
  publishCleanupResource?: WebSessionCleanupResourcePublisher,
): Promise<unknown> {
  if (auth.kind !== "browser-profile") {
    throw new Error("Bluesky storage bootstrap requires bound browser-profile auth");
  }
  const storageAuth = {
    schemaVersion: 1,
    id: auth.id,
    kind: "browser-profile",
    profile: auth.profile,
    trustUnfilteredEgress: true,
    ...(auth.browserExecutable === undefined
      ? {}
      : { browserExecutable: auth.browserExecutable }),
    ...(auth.subject === undefined ? {} : { subject: auth.subject }),
  } as const satisfies WrenchAuth;
  const createSession = dependencies?.createBrowserSession ?? createBrowserSession;
  const createTimeoutMs = remainingTimeoutMs(
    timeoutMs,
    operationDeadline,
  );
  const session = await createSession(blueskyBootstrapManifest, storageAuth, {
    headed: false,
    timeoutMs: createTimeoutMs,
    maxOutputBytes: MAX_BOOTSTRAP_BYTES,
    allowCodeOwnedEvaluation: true,
    ...(operationDeadline === undefined
      ? {}
      : { operationDeadline }),
    ...(publishCleanupResource === undefined
      ? {}
      : { publishCleanupResource }),
  });
  let result: unknown;
  let failure: unknown;
  try {
    // A same-origin inert text asset exposes localStorage without executing
    // the Bluesky app or allowing it to rotate the refresh token in the clone.
    await session.runBatch(
      [["open", `${BLUESKY_APP_ORIGIN}/robots.txt`]],
      remainingTimeoutMs(timeoutMs, operationDeadline),
      MAX_BOOTSTRAP_BYTES,
    );
    const [urlEntry] = await session.runBatch(
      [["get", "url"]],
      remainingTimeoutMs(timeoutMs, operationDeadline),
      MAX_BOOTSTRAP_BYTES,
    );
    const urlData = urlEntry === undefined ? null : browserResultData(urlEntry);
    const currentUrl = isRecord(urlData) && typeof urlData.url === "string"
      ? new URL(urlData.url)
      : null;
    if (currentUrl?.origin !== BLUESKY_APP_ORIGIN) {
      throw new Error("Bluesky browser bootstrap did not reach its reviewed origin");
    }
    const [evaluationEntry] = await session.runBatch(
      [["eval", browserEvaluationSource()]],
      remainingTimeoutMs(timeoutMs, operationDeadline),
      MAX_BOOTSTRAP_BYTES,
    );
    if (evaluationEntry === undefined) {
      throw new Error("Bluesky browser bootstrap omitted its evaluation result");
    }
    result = bootstrapEvaluationResult(browserResultData(evaluationEntry));
  } catch (error) {
    failure = error;
  }
  const finalization = await finalizeBrowserSession(session);
  if (!finalization.closeVerified || !finalization.cleanupVerified) {
    const cleanupEvidence = (
      finalization.closeVerified
      && !finalization.cleanupVerified
      && session.cleanupResourceIdentity !== undefined
    )
      ? Object.freeze({
          kind: "agent-browser-closed-artifacts-v1" as const,
          resource: session.cleanupResourceIdentity,
        })
      : undefined;
    throw new PreservedBrowserArtifactsError(
      "Bluesky browser bootstrap finalization failed; private artifacts were preserved",
      session.recoveryHandle ?? "session=bluesky-bootstrap;artifacts=unknown",
      new AggregateError(
        [
          ...(failure === undefined ? [] : [failure]),
          ...finalization.failures,
        ],
        "Bluesky browser bootstrap finalization failed",
      ),
      cleanupEvidence,
    );
  }
  if (failure !== undefined) {
    throw failure instanceof Error
      ? failure
      : new Error("Bluesky browser bootstrap failed");
  }
  return result;
}

type SelectedBlueskySession = {
  readonly session: BlueskySessionMaterial;
  readonly cache: {
    readonly enabled: boolean;
    readonly contentSha256: string | null;
  };
};

async function loadBlueskySessionSnapshot(
  auth: WrenchAuth,
  authHash: string,
  dependencies: BlueskyWebRuntimeDependencies | undefined,
): Promise<{
  readonly enabled: boolean;
  readonly snapshot: SessionSecretSnapshot;
}> {
  if (dependencies?.loadCachedSession !== undefined) {
    return {
      enabled: true,
      snapshot: await dependencies.loadCachedSession(auth, authHash),
    };
  }
  if (dependencies?.bootstrapAccount !== undefined) {
    return {
      enabled: false,
      snapshot: Object.freeze({ value: null, contentSha256: null }),
    };
  }
  return {
    enabled: true,
    snapshot: readSessionSecretSnapshot("bluesky", auth.id, authHash),
  };
}

async function selectedSession(
  auth: WrenchAuth,
  timeoutMs: number,
  dependencies: BlueskyWebRuntimeDependencies | undefined,
  operationDeadline?: WebSessionOperationDeadline,
  registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar,
): Promise<SelectedBlueskySession> {
  if (auth.kind !== "browser-profile") {
    throw new Error("Bluesky authenticated API requires browser-profile auth");
  }
  operationDeadline?.throwIfUnavailable(
    "authenticated web operation deadline",
  );
  if (
    (dependencies?.loadCachedSession === undefined)
    !== (dependencies?.saveCachedSession === undefined)
  ) {
    throw new Error(
      "Bluesky rotating-session cache dependencies must be provided together",
    );
  }
  const nowSeconds = Math.floor((dependencies?.now?.() ?? Date.now()) / 1_000);
  const loadBrowserSession = (): Promise<unknown> => {
    if (dependencies?.bootstrapAccount !== undefined) {
      return dependencies.bootstrapAccount(auth);
    }
    return startWebSessionCleanupTrackedOperation(
      registerCleanupBarrier,
      (publishCleanupResource) => bootstrapFromBrowser(
        auth,
        timeoutMs,
        dependencies,
        operationDeadline,
        publishCleanupResource,
      ),
      browserCleanupBarrier,
    );
  };
  const value = (
    operationDeadline === undefined
    || dependencies?.bootstrapAccount === undefined
  )
    ? await loadBrowserSession()
    : await operationDeadline.run(
        loadBrowserSession,
        "authenticated web operation deadline",
      );
  operationDeadline?.throwIfUnavailable(
    "authenticated web operation deadline",
  );
  const browserSession = parseBlueskyBootstrapAccount(
    value,
    nowSeconds,
  );
  const authHash = sha256(canonicalJson(auth));
  const cache = await loadBlueskySessionSnapshot(
    auth,
    authHash,
    dependencies,
  );
  operationDeadline?.throwIfUnavailable(
    "authenticated web operation deadline",
  );
  const result = (session: BlueskySessionMaterial): SelectedBlueskySession =>
    Object.freeze({
      session,
      cache: Object.freeze({
        enabled: cache.enabled,
        contentSha256: cache.snapshot.contentSha256,
      }),
    });
  if (cache.snapshot.value === null) return result(browserSession);
  const cachedSession = parseBlueskyBootstrapAccount(
    cache.snapshot.value,
    nowSeconds,
  );
  if (
    cachedSession.did !== browserSession.did
    || cachedSession.pdsOrigin !== browserSession.pdsOrigin
  ) return result(browserSession);
  return result(cachedSession.refreshExpiresAt > browserSession.refreshExpiresAt
      || (
        cachedSession.refreshExpiresAt === browserSession.refreshExpiresAt
        && cachedSession.accessExpiresAt > browserSession.accessExpiresAt
      )
    ? cachedSession
    : browserSession);
}

function cachedSessionValue(session: BlueskySessionMaterial): Readonly<Record<string, unknown>> {
  return Object.freeze({
    did: session.did,
    handle: session.handle,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
    service: session.pdsOrigin,
    pdsUrl: session.pdsOrigin,
  });
}

async function writeBlueskySessionSnapshot(
  auth: WrenchAuth,
  authHash: string,
  value: unknown,
  expectedContentSha256: string | null,
  dependencies: BlueskyWebRuntimeDependencies | undefined,
): Promise<SessionSecretWriteResult> {
  return dependencies?.saveCachedSession === undefined
    ? writeSessionSecretIfUnchanged(
      "bluesky",
      auth.id,
      authHash,
      value,
      expectedContentSha256,
    )
    : dependencies.saveCachedSession(
      auth,
      authHash,
      value,
      expectedContentSha256,
    );
}

function blueskySessionIsAtLeastAsFresh(
  candidate: BlueskySessionMaterial,
  attempted: BlueskySessionMaterial,
): boolean {
  return candidate.refreshExpiresAt > attempted.refreshExpiresAt
    || (
      candidate.refreshExpiresAt === attempted.refreshExpiresAt
      && candidate.accessExpiresAt >= attempted.accessExpiresAt
    );
}

async function saveSelectedSession(
  auth: WrenchAuth,
  session: BlueskySessionMaterial,
  cache: SelectedBlueskySession["cache"],
  nowSeconds: number,
  dependencies: BlueskyWebRuntimeDependencies | undefined,
): Promise<BlueskySessionMaterial> {
  if (!cache.enabled) return session;
  const authHash = sha256(canonicalJson(auth));
  const value = cachedSessionValue(session);
  const saved = await writeBlueskySessionSnapshot(
    auth,
    authHash,
    value,
    cache.contentSha256,
    dependencies,
  );
  if (saved.written) return session;

  const latest = await loadBlueskySessionSnapshot(
    auth,
    authHash,
    dependencies,
  );
  if (
    !latest.enabled
    || latest.snapshot.contentSha256 === null
    || latest.snapshot.contentSha256 === cache.contentSha256
    || latest.snapshot.value === null
  ) {
    throw new Error(
      "Bluesky rotating session state changed concurrently; retry with a fresh session",
    );
  }
  const candidate = parseBlueskyBootstrapAccount(
    latest.snapshot.value,
    nowSeconds,
  );
  if (
    candidate.did !== session.did
    || candidate.pdsOrigin !== session.pdsOrigin
    || !blueskySessionIsAtLeastAsFresh(candidate, session)
  ) {
    throw new Error(
      "Bluesky rotating session state changed concurrently without a safe newer session",
    );
  }
  return candidate;
}

async function boundedBytes(
  response: Response,
  maximum: number,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<Uint8Array> {
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const count = Number(declared);
    if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Bluesky XRPC response exceeded its reviewed byte limit");
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const buffer = new BoundedByteBuffer(maximum);
  try {
    for (;;) {
      const item = operationDeadline === undefined
        ? await reader.read()
        : await operationDeadline.run(
            () => reader.read(),
            WEB_SESSION_OPERATION_LABEL,
          );
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || !buffer.append(item.value)) {
        void reader.cancel().catch(() => undefined);
        throw new Error("Bluesky XRPC response exceeded its reviewed byte limit");
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  return buffer.toUint8Array();
}

function jsonContentType(response: Response): boolean {
  const raw = response.headers.get("content-type");
  if (raw === null) return false;
  const type = raw.split(";", 1)[0]?.trim().toLowerCase();
  return type === "application/json" || type?.endsWith("+json") === true;
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return Object.freeze({});
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Bluesky XRPC returned invalid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Bluesky XRPC returned malformed JSON");
  }
}

type XrpcOptions = {
  readonly query?: Readonly<Record<string, readonly string[]>>;
  readonly proxy?: BlueskyRequestBinding["proxy"];
  readonly jsonBody?: Readonly<Record<string, unknown>>;
  readonly blobBody?: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  };
  readonly maximumBytes?: number;
  readonly authorization?: {
    readonly kind: "refresh";
    readonly token: string;
  };
  /** Restricted to authoritative getRecord absence reconciliation. */
  readonly recordNotFound?: true;
};

async function xrpc(
  client: BlueskyClient,
  nsid: BlueskyXrpcMethod,
  options: XrpcOptions = {},
): Promise<unknown> {
  const query = options.query ?? {};
  const proxy = options.proxy ?? null;
  const method = BLUESKY_XRPC_METHODS[nsid];
  const refreshRequest = options.authorization?.kind === "refresh";
  if (refreshRequest !== (nsid === "com.atproto.server.refreshSession")) {
    throw new Error("Bluesky refresh authorization is restricted to refreshSession");
  }
  if (
    options.recordNotFound === true
    && nsid !== "com.atproto.repo.getRecord"
  ) {
    throw new Error("Bluesky RecordNotFound handling is restricted to getRecord");
  }
  const authorizationToken = refreshRequest
    ? options.authorization?.token
    : client.session.accessJwt;
  if (authorizationToken === undefined) {
    throw new Error("Bluesky refresh authorization token is unavailable");
  }
  if (options.jsonBody !== undefined && options.blobBody !== undefined) {
    throw new Error("Bluesky XRPC request cannot contain two body types");
  }
  const hasBody = options.jsonBody !== undefined || options.blobBody !== undefined;
  const url = new URL(`/xrpc/${nsid}`, client.session.pdsOrigin);
  for (const [name, values] of Object.entries(query)) {
    for (const value of values) url.searchParams.append(name, value);
  }
  authorizeBlueskyXrpcRequest({
    pdsOrigin: client.session.pdsOrigin,
    nsid,
    url,
    method,
    expectedQuery: query,
    hasBody,
    proxy,
  });
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${authorizationToken}`,
    ...(proxy === null ? {} : { "atproto-proxy": proxy }),
  });
  let body: RequestInit["body"];
  if (options.jsonBody !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.jsonBody);
  } else if (options.blobBody !== undefined) {
    headers.set("content-type", options.blobBody.mediaType);
    // Keep the upload body in the owned-byte form accepted by Wrench's
    // DNS-pinned HTTPS transport. A Web Blob reaches custom fetch fixtures,
    // but the production transport deliberately rejects that body shape
    // before opening a socket.
    body = new Uint8Array(options.blobBody.bytes);
  }
  const operationDeadline = client.operationDeadline;
  const controller = operationDeadline === undefined
    ? new AbortController()
    : undefined;
  const timeoutMs = remainingTimeoutMs(client.timeoutMs, operationDeadline);
  const timeout = controller === undefined
    ? undefined
    : setTimeout(() => controller.abort(), timeoutMs);
  const signal = operationDeadline?.signal ?? controller?.signal;
  if (signal === undefined) {
    throw new Error("Bluesky XRPC request signal was not initialized");
  }
  let response: Response | undefined;
  try {
    try {
      const request = () => client.fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal,
        });
      response = operationDeadline === undefined
        ? await request()
        : await operationDeadline.run(request, WEB_SESSION_OPERATION_LABEL);
    } catch (error) {
      throw new Error("Bluesky XRPC failed before a reviewed response was received", {
        cause: error,
      });
    }
    if (
      response.status === 400
      && options.recordNotFound === true
    ) {
      const bytes = await boundedBytes(
        response,
        64 * 1024,
        operationDeadline,
      );
      if (!jsonContentType(response)) {
        throw new Error("Bluesky RecordNotFound response used an unreviewed content type");
      }
      parseBlueskyRecordNotFoundResponse(parseJson(bytes));
      return BLUESKY_RECORD_NOT_FOUND;
    }
    if (response.status !== 200) {
      response.body?.cancel().catch(() => undefined);
      throw new Error(`Bluesky XRPC returned unreviewed status ${response.status}`);
    }
    const bytes = await boundedBytes(
      response,
      Math.min(options.maximumBytes ?? client.maxOutputBytes, MAX_READ_BYTES),
      operationDeadline,
    );
    if (bytes.byteLength > 0 && !jsonContentType(response)) {
      throw new Error("Bluesky XRPC returned an unreviewed content type");
    }
    return parseJson(bytes);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal.aborted) {
      void response?.body?.cancel().catch(() => undefined);
    }
  }
}

function clientFor(
  session: BlueskySessionMaterial,
  timeoutMs: number,
  maxOutputBytes: number,
  dependencies: BlueskyWebRuntimeDependencies | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): BlueskyClient {
  return Object.freeze({
    session,
    timeoutMs,
    maxOutputBytes,
    fetch: dependencies?.fetch ?? ((input, init = {}) =>
      pinnedHttpsFetch(
        input instanceof Request ? new URL(input.url) : new URL(input),
        init,
        remainingTimeoutMs(timeoutMs, operationDeadline),
      )),
    ...(operationDeadline === undefined ? {} : { operationDeadline }),
  });
}

async function currentSession(
  client: BlueskyClient,
): Promise<{ readonly did: string; readonly handle: string; readonly active: boolean }> {
  const current = parseBlueskySessionResponse(
    await xrpc(client, "com.atproto.server.getSession", {
      maximumBytes: 512 * 1024,
    }),
  );
  if (!current.active || current.did !== client.session.did) {
    throw new Error("Bluesky PDS session did not match the selected browser account");
  }
  return current;
}

function requireBoundSubject(auth: WrenchAuth, session: BlueskySessionMaterial): string {
  const expected = webSessionAuthSubject(auth);
  if (expected === null) {
    throw new Error("Bluesky authenticated operations require an auth locator bound to an exact DID");
  }
  const did = blueskyDid(expected, "Bluesky auth subject");
  if (did !== session.did) {
    throw new Error("Bluesky browser account did not match the bound auth subject");
  }
  return did;
}

async function bootstrapClient(
  auth: WrenchAuth,
  timeoutMs: number,
  maxOutputBytes: number,
  dependencies: BlueskyWebRuntimeDependencies | undefined,
  operationDeadline?: WebSessionOperationDeadline,
  registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar,
): Promise<BlueskyClient> {
  const selected = await selectedSession(
    auth,
    timeoutMs,
    dependencies,
    operationDeadline,
    registerCleanupBarrier,
  );
  const nowSeconds = Math.floor((dependencies?.now?.() ?? Date.now()) / 1_000);
  let session = selected.session;
  if (selected.session.accessExpiresAt <= nowSeconds) {
    const refreshClient = clientFor(
      selected.session,
      timeoutMs,
      Math.min(maxOutputBytes, 512 * 1024),
      dependencies,
      operationDeadline,
    );
    session = parseBlueskyRefreshSessionResponse(
      await xrpc(refreshClient, "com.atproto.server.refreshSession", {
        authorization: { kind: "refresh", token: selected.session.refreshJwt },
        maximumBytes: 512 * 1024,
      }),
      selected.session,
      nowSeconds,
    );
    session = await saveSelectedSession(
      auth,
      session,
      selected.cache,
      nowSeconds,
      dependencies,
    );
  }
  const client = clientFor(
    session,
    timeoutMs,
    maxOutputBytes,
    dependencies,
    operationDeadline,
  );
  await currentSession(client);
  return client;
}

export async function probeBlueskyWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: BlueskyWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = new OperationDeadline(timeoutMs, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    const client = await bootstrapClient(
      auth,
      timeoutMs,
      512 * 1024,
      options.dependencies,
      deadline,
    );
    deadline.throwIfUnavailable("authenticated web subject probe");
    return client.session.did;
  } finally {
    deadline.dispose();
  }
}

async function getPost(
  client: BlueskyClient,
  uri: string,
): Promise<BlueskyProjectedPost> {
  return projectBlueskyPostsResponse(
    await xrpc(client, "app.bsky.feed.getPosts", {
      query: { uris: [uri] },
      proxy: BLUESKY_APPVIEW_PROXY,
    }),
    uri,
  );
}

async function getAuthoritativeRecord(
  client: BlueskyClient,
  expected: BlueskyStrongRef,
  expectedValue: Readonly<Record<string, unknown>>,
): Promise<BlueskyStrongRef> {
  const parsed = parseBlueskyAtUri(
    expected.uri,
    "Bluesky created post URI",
    "app.bsky.feed.post",
  );
  if (parsed.actor !== client.session.did) {
    throw new Error("Bluesky created post actor did not match the bound viewer");
  }
  return parseBlueskyGetRecordResponse(
    await xrpc(client, "com.atproto.repo.getRecord", {
      query: {
        repo: [client.session.did],
        collection: ["app.bsky.feed.post"],
        rkey: [parsed.rkey],
      },
    }),
    expected,
    expectedValue,
  );
}

type BlueskyAuthoritativePostPresence =
  | { readonly present: false }
  | { readonly present: true; readonly ref: BlueskyStrongRef };

async function authoritativePostPresence(
  client: BlueskyClient,
  uri: string,
  expectedCid: string,
): Promise<BlueskyAuthoritativePostPresence> {
  const parsed = parseBlueskyAtUri(
    uri,
    "Bluesky deletion target URI",
    "app.bsky.feed.post",
  );
  if (parsed.actor !== client.session.did) {
    throw new Error("Bluesky deletion target actor did not match the bound viewer");
  }
  const response = await xrpc(client, "com.atproto.repo.getRecord", {
    query: {
      repo: [client.session.did],
      collection: ["app.bsky.feed.post"],
      rkey: [parsed.rkey],
    },
    recordNotFound: true,
  });
  if (response === BLUESKY_RECORD_NOT_FOUND) {
    return Object.freeze({ present: false });
  }
  return Object.freeze({
    present: true,
    ref: parseBlueskyCurrentPostRecordResponse(
      response,
      parsed.uri,
      expectedCid,
    ),
  });
}

/**
 * Reconcile deletion from the authoritative account repository only. A
 * different current CID is revision drift, not absence.
 */
export async function readBlueskyWebContentDeleteDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly dependencies?: BlueskyWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<{ readonly present: boolean; readonly postUri: string }> {
  if (
    recipe.site !== "bluesky"
    || recipe.action !== "content.delete"
    || recipe.contractVersion !== 1
  ) {
    throw new Error("Bluesky deletion recovery supports only content.delete@1");
  }
  const deadline = new OperationDeadline(recipe.timeoutMs, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    const client = await bootstrapClient(
      auth,
      recipe.timeoutMs,
      recipe.maxOutputBytes,
      options.dependencies,
      deadline,
    );
    requireBoundSubject(auth, client.session);
    const postUri = postUriInput(input);
    const expectedCid = blueskyCid(
      inputString(input, "expected_cid", 201),
      "input.expected_cid",
    );
    const presence = await authoritativePostPresence(
      client,
      postUri,
      expectedCid,
    );
    return Object.freeze({ present: presence.present, postUri });
  } finally {
    deadline.dispose();
  }
}

type BlueskyPublishedMutationTarget = {
  readonly uri: string;
  readonly cid: string;
  readonly createdAt: string;
  readonly media: null | {
    readonly cid: string;
    readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
    readonly size: number;
  };
};

function parseBlueskyPublishedMutationTarget(
  identifier: string,
): BlueskyPublishedMutationTarget {
  let value: unknown;
  try {
    value = JSON.parse(identifier);
  } catch {
    throw new Error("Bluesky provider-accepted post target is not canonical JSON");
  }
  const target = record(value, "Bluesky provider-accepted post target");
  if (Object.keys(target).sort().join(",") !== "cid,createdAt,media,uri") {
    throw new Error("Bluesky provider-accepted post target contained unsupported fields");
  }
  const parsedUri = parseBlueskyAtUri(
    target.uri,
    "Bluesky provider-accepted post target URI",
    "app.bsky.feed.post",
  );
  const strongRef = parseBlueskyCreateRecordResponse(
    { uri: parsedUri.uri, cid: target.cid },
    parsedUri.actor,
    "app.bsky.feed.post",
  );
  if (
    typeof target.createdAt !== "string"
    || target.createdAt.length > 64
    || Number.isNaN(Date.parse(target.createdAt))
    || new Date(target.createdAt).toISOString() !== target.createdAt
  ) {
    throw new Error("Bluesky provider-accepted post target createdAt is malformed");
  }
  let media: BlueskyPublishedMutationTarget["media"] = null;
  if (target.media !== null) {
    const rawMedia = record(
      target.media,
      "Bluesky provider-accepted post target media",
    );
    if (Object.keys(rawMedia).sort().join(",") !== "cid,mediaType,size") {
      throw new Error("Bluesky provider-accepted post target media contained unsupported fields");
    }
    if (
      typeof rawMedia.cid !== "string"
      || !/^b[a-z2-7]{10,200}$/u.test(rawMedia.cid)
      || (
        rawMedia.mediaType !== "image/jpeg"
        && rawMedia.mediaType !== "image/png"
        && rawMedia.mediaType !== "image/webp"
      )
      || !Number.isSafeInteger(rawMedia.size)
      || (rawMedia.size as number) < 1
      || (rawMedia.size as number) > MAX_IMAGE_BYTES
    ) {
      throw new Error("Bluesky provider-accepted post target media is malformed");
    }
    media = Object.freeze({
      cid: rawMedia.cid,
      mediaType: rawMedia.mediaType,
      size: rawMedia.size as number,
    });
  }
  const parsed = Object.freeze({
    uri: strongRef.uri,
    cid: strongRef.cid,
    createdAt: target.createdAt,
    media,
  });
  if (canonicalJson(parsed) !== identifier) {
    throw new Error("Bluesky provider-accepted post target is not canonical");
  }
  return parsed;
}

/**
 * Reconcile one exact response-bound Bluesky publish target using only the
 * authoritative PDS record and its public AppView projection.
 */
export async function readBlueskyWebPublishedMutationTarget(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  identifier: string,
  options: {
    readonly dependencies?: BlueskyWebRuntimeDependencies;
  } = {},
): Promise<{ readonly present: true; readonly uri: string; readonly cid: string }> {
  if (
    recipe.site !== "bluesky"
    || recipe.action !== "posts.publish"
    || recipe.contractVersion !== 3
  ) {
    throw new Error("Bluesky publish recovery supports only posts.publish@3");
  }
  const target = parseBlueskyPublishedMutationTarget(identifier);
  const body = assertBlueskyText(input.body, "input.body", 280, 3_000);
  const rawAlt = input.alt;
  const alt = rawAlt === undefined
    ? ""
    : typeof rawAlt === "string" && rawAlt.length <= 10_000 && !/[\0\r]/u.test(rawAlt)
      ? rawAlt
      : (() => {
          throw new Error("input.alt must be bounded text");
        })();
  if (
    (input.media === undefined) !== (target.media === null)
    || (target.media === null
      ? input.media_type !== undefined || input.alt !== undefined
      : input.media_type !== target.media.mediaType)
  ) {
    throw new Error("Bluesky provider-accepted post target did not bind the confirmed attachment shape");
  }
  const recordValue = Object.freeze({
    $type: "app.bsky.feed.post",
    text: body,
    createdAt: target.createdAt,
    ...(target.media === null
      ? {}
      : {
          embed: {
            $type: "app.bsky.embed.images",
            images: [{
              image: {
                $type: "blob",
                ref: { $link: target.media.cid },
                mimeType: target.media.mediaType,
                size: target.media.size,
              },
              alt,
            }],
          },
        }),
  });
  const client = await bootstrapClient(
    auth,
    recipe.timeoutMs,
    recipe.maxOutputBytes,
    options.dependencies,
  );
  requireBoundSubject(auth, client.session);
  const strongRef = Object.freeze({ uri: target.uri, cid: target.cid });
  await getAuthoritativeRecord(client, strongRef, recordValue);
  const projected = await getPost(client, target.uri);
  if (projected.cid !== target.cid || projected.createdAt !== target.createdAt) {
    throw new Error("Bluesky publish recovery readback changed the accepted record revision");
  }
  assertPublishedPost(projected, {
    actorDid: client.session.did,
    text: body,
    reply: null,
    quote: null,
    mediaAlt: target.media === null ? null : alt,
  });
  return Object.freeze({ present: true, uri: target.uri, cid: target.cid });
}

async function waitForPublishReadback(
  client: BlueskyClient,
  uri: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<BlueskyProjectedPost> {
  let lastError: unknown;
  for (const delay of PUBLISH_READBACK_DELAYS_MS) {
    if (delay > 0) {
      const pause = () => sleep(delay);
      if (client.operationDeadline === undefined) await pause();
      else await client.operationDeadline.run(pause, WEB_SESSION_OPERATION_LABEL);
    }
    try {
      return await getPost(client, uri);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Bluesky public post readback did not settle within the reviewed bound", {
    cause: lastError,
  });
}

async function getProfile(
  client: BlueskyClient,
  did: string,
) {
  return projectBlueskyProfile(
    await xrpc(client, "app.bsky.actor.getProfile", {
      query: { actor: [did] },
      proxy: BLUESKY_APPVIEW_PROXY,
    }),
    did,
  );
}

/**
 * Independently observe one exact Bluesky desired-state target through the
 * already account-bound XRPC client. This path cannot create or delete a
 * record and remains available only as a reconciliation readback.
 */
export async function readBlueskyWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly dependencies?: BlueskyWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<BlueskyWebDesiredStateReadback> {
  if (
    recipe.site !== "bluesky"
    || recipe.contractVersion !== 1
    || (
      recipe.action !== "likes.set"
      && recipe.action !== "content.save"
      && recipe.action !== "relationships.follow.set"
      && recipe.action !== "posts.repost"
    )
  ) {
    throw new Error(
      "Bluesky recovery readback supports only likes.set, content.save, relationships.follow.set, and posts.repost",
    );
  }
  const deadline = new OperationDeadline(recipe.timeoutMs, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    const client = await bootstrapClient(
      auth,
      recipe.timeoutMs,
      recipe.maxOutputBytes,
      options.dependencies,
      deadline,
    );
    requireBoundSubject(auth, client.session);
    if (recipe.action === "relationships.follow.set") {
      const actorDid = blueskyDid(
        inputString(input, "actor_did", 255),
        "input.actor_did",
      );
      if (actorDid === client.session.did) {
        throw new Error("Bluesky cannot follow the bound viewer");
      }
      const profile = await getProfile(client, actorDid);
      return Object.freeze({
        kind: "follow",
        enabled: profile.following !== null,
        actorDid,
      });
    }
    const postUri = postUriInput(input);
    const kind = recipe.action === "likes.set"
      ? "like"
      : recipe.action === "content.save"
        ? "bookmark"
        : "repost";
    const post = await getPost(client, postUri);
    return Object.freeze({
      kind,
      enabled: postState(post, kind),
      postUri,
    });
  } finally {
    deadline.dispose();
  }
}

async function executeFeedRead(
  client: BlueskyClient,
  input: OperationInput,
): Promise<WebSessionExecution> {
  const feed = inputString(input, "feed", 32);
  const limit = inputInteger(input, "limit", DEFAULT_LIMIT, 1, 100);
  const cursor = optionalCursor(input);
  let output: unknown;
  if (feed === "home") {
    output = projectBlueskyFeed(
      await xrpc(client, "app.bsky.feed.getTimeline", {
        query: {
          limit: [String(limit)],
          ...(cursor === undefined ? {} : { cursor: [cursor] }),
        },
        proxy: BLUESKY_APPVIEW_PROXY,
      }),
      limit,
    );
  } else if (feed === "notifications") {
    output = projectBlueskyNotifications(
      await xrpc(client, "app.bsky.notification.listNotifications", {
        query: {
          limit: [String(limit)],
          ...(cursor === undefined ? {} : { cursor: [cursor] }),
        },
        proxy: BLUESKY_NOTIFICATION_PROXY,
      }),
      limit,
    );
  } else if (feed === "bookmarks") {
    output = projectBlueskyBookmarks(
      await xrpc(client, "app.bsky.bookmark.getBookmarks", {
        query: {
          limit: [String(limit)],
          ...(cursor === undefined ? {} : { cursor: [cursor] }),
        },
        proxy: BLUESKY_APPVIEW_PROXY,
      }),
      limit,
    );
  } else {
    throw new Error("input.feed must name home, notifications, or bookmarks");
  }
  return {
    status: "succeeded",
    output: Object.freeze({ feed, result: output }),
    finalUrl: feed === "home"
      ? `${BLUESKY_APP_ORIGIN}/`
      : feed === "notifications"
        ? `${BLUESKY_APP_ORIGIN}/notifications`
        : `${BLUESKY_APP_ORIGIN}/saved`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executePostRead(
  client: BlueskyClient,
  input: OperationInput,
  mediaOnly: boolean,
): Promise<WebSessionExecution> {
  const uri = postUriInput(input);
  const post = await getPost(client, uri);
  return {
    status: "succeeded",
    output: mediaOnly
      ? Object.freeze({ postUri: uri, media: post.attachments })
      : post,
    finalUrl: `${BLUESKY_APP_ORIGIN}/profile/${post.author.did}/post/${blueskyPostUri(uri).rkey}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executeCommentsRead(
  client: BlueskyClient,
  input: OperationInput,
): Promise<WebSessionExecution> {
  const uri = postUriInput(input);
  const limit = inputInteger(input, "limit", DEFAULT_LIMIT, 1, 100);
  const output = projectBlueskyThread(
    await xrpc(client, "app.bsky.feed.getPostThread", {
      query: {
        uri: [uri],
        depth: ["10"],
        parentHeight: ["0"],
      },
      proxy: BLUESKY_APPVIEW_PROXY,
    }),
    uri,
    limit,
  );
  return {
    status: "succeeded",
    output,
    finalUrl: `${BLUESKY_APP_ORIGIN}/profile/${output.post.author.did}/post/${blueskyPostUri(uri).rkey}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function getConvo(
  client: BlueskyClient,
  convoId: string,
) {
  const response = record(
    await xrpc(client, "chat.bsky.convo.getConvo", {
      query: { convoId: [convoId] },
      proxy: BLUESKY_CHAT_PROXY,
    }),
    "Bluesky getConvo response",
  );
  return projectBlueskyConvo(response.convo, client.session.did, convoId);
}

async function getMessages(
  client: BlueskyClient,
  convoId: string,
  limit: number,
  cursor?: string,
) {
  return projectBlueskyMessages(
    await xrpc(client, "chat.bsky.convo.getMessages", {
      query: {
        convoId: [convoId],
        limit: [String(limit)],
        ...(cursor === undefined ? {} : { cursor: [cursor] }),
      },
      proxy: BLUESKY_CHAT_PROXY,
    }),
    limit,
  );
}

async function executeMessagingList(
  client: BlueskyClient,
  input: OperationInput,
): Promise<WebSessionExecution> {
  const limit = inputInteger(input, "limit", DEFAULT_LIMIT, 1, 100);
  const cursor = optionalCursor(input);
  const output = projectBlueskyConvoList(
    await xrpc(client, "chat.bsky.convo.listConvos", {
      query: {
        limit: [String(limit)],
        ...(cursor === undefined ? {} : { cursor: [cursor] }),
      },
      proxy: BLUESKY_CHAT_PROXY,
    }),
    client.session.did,
    limit,
  );
  return {
    status: "succeeded",
    output,
    finalUrl: `${BLUESKY_APP_ORIGIN}/messages`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function executeMessagingRead(
  client: BlueskyClient,
  input: OperationInput,
): Promise<WebSessionExecution> {
  const convoId = convoIdInput(input);
  const limit = inputInteger(input, "limit", DEFAULT_LIMIT, 1, 100);
  const cursor = optionalCursor(input);
  const convo = await getConvo(client, convoId);
  const messages = await getMessages(client, convoId, limit, cursor);
  return {
    status: "succeeded",
    output: Object.freeze({ convo, ...messages }),
    finalUrl: `${BLUESKY_APP_ORIGIN}/messages/${encodeURIComponent(convoId)}`,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

function dispatchEvent(
  id: string,
  index: number,
  planned: number,
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return Object.freeze({
    id,
    index,
    progress: Object.freeze({ planned, started, verified }),
  });
}

async function rebindBeforeDispatch(client: BlueskyClient): Promise<void> {
  const rebound = await currentSession(client);
  if (rebound.did !== client.session.did) {
    throw new Error("Bluesky account changed during dispatch preparation");
  }
}

function desiredStateResult(
  action: BlueskyWebOperationName,
  output: unknown,
): WebSessionExecution {
  return {
    status: "succeeded",
    output: Object.freeze({
      action,
      noOp: true,
      effect: "already-satisfied",
      result: output,
    }),
    finalUrl: BLUESKY_APP_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 1, started: 0, verified: 0 },
  };
}

async function createRecord(
  client: BlueskyClient,
  collection: string,
  value: Readonly<Record<string, unknown>>,
): Promise<BlueskyStrongRef> {
  return parseBlueskyCreateRecordResponse(
    await xrpc(client, "com.atproto.repo.createRecord", {
      jsonBody: {
        repo: client.session.did,
        collection,
        record: value,
      },
    }),
    client.session.did,
    collection,
  );
}

async function deleteRecord(
  client: BlueskyClient,
  uri: string,
  collection: string,
): Promise<void> {
  const parsed = parseBlueskyAtUri(uri, "Bluesky record to delete", collection);
  if (parsed.actor !== client.session.did) {
    throw new Error("Bluesky record deletion actor did not match the bound viewer");
  }
  await xrpc(client, "com.atproto.repo.deleteRecord", {
    jsonBody: {
      repo: client.session.did,
      collection,
      rkey: parsed.rkey,
    },
  });
}

async function executeContentDelete(
  client: BlueskyClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  const postUri = postUriInput(input);
  const expectedCid = blueskyCid(
    inputString(input, "expected_cid", 201),
    "input.expected_cid",
  );
  const parsed = parseBlueskyAtUri(
    postUri,
    "Bluesky deletion target URI",
    "app.bsky.feed.post",
  );
  if (parsed.actor !== client.session.did) {
    throw new Error("Bluesky deletion target actor did not match the bound viewer");
  }
  const finalUrl = `${BLUESKY_APP_ORIGIN}/profile/${client.session.did}/post/${parsed.rkey}`;
  let started = 0;
  let verified = 0;
  let failureStage = "authoritative pre-read";
  try {
    const before = await authoritativePostPresence(
      client,
      postUri,
      expectedCid,
    );
    if (!before.present) {
      return {
        status: "succeeded",
        output: Object.freeze({
          postUri,
          expectedCid,
          deleted: true,
          effect: "already-absent",
        }),
        finalUrl,
        noOp: true,
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
      };
    }
    failureStage = "dispatch rebinding";
    await rebindBeforeDispatch(client);
    failureStage = "dispatch admission";
    await options.beforeDispatch?.(
      dispatchEvent(recipe.action, 1, 1, 0, 0),
    );
    started = 1;
    failureStage = "delete response";
    parseBlueskyDeleteRecordResponse(
      await xrpc(client, "com.atproto.repo.deleteRecord", {
        jsonBody: {
          repo: client.session.did,
          collection: "app.bsky.feed.post",
          rkey: parsed.rkey,
          swapRecord: before.ref.cid,
        },
      }),
    );
    failureStage = "authoritative absence readback";
    const after = await authoritativePostPresence(
      client,
      postUri,
      expectedCid,
    );
    if (after.present) {
      throw new Error("Bluesky deletion readback still found the confirmed record");
    }
    verified = 1;
    failureStage = "verification recording";
    await options.afterDispatchVerified?.(
      dispatchEvent(recipe.action, 1, 1, 1, 1),
    );
    return {
      status: "succeeded",
      output: Object.freeze({
        postUri,
        expectedCid,
        deleted: true,
        effect: "deleted",
      }),
      finalUrl,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? `Bluesky may have deleted the exact confirmed post; failure stage: ${failureStage}; reconcile authoritative record absence and never retry automatically`
        : `Bluesky deletion failed before submission; failure stage: ${failureStage}`,
    };
  }
}

type PostStateKind = "like" | "repost" | "bookmark";

function postState(
  post: BlueskyProjectedPost,
  kind: PostStateKind,
): boolean {
  return kind === "like"
    ? post.viewer.like !== null
    : kind === "repost"
      ? post.viewer.repost !== null
      : post.viewer.bookmarked;
}

function postStateUri(
  post: BlueskyProjectedPost,
  kind: Exclude<PostStateKind, "bookmark">,
): string | null {
  return kind === "like" ? post.viewer.like : post.viewer.repost;
}

async function executePostDesiredState(
  client: BlueskyClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly now: () => number;
  },
): Promise<WebSessionExecution> {
  const uri = postUriInput(input);
  const kind: PostStateKind = recipe.action === "likes.set"
    ? "like"
    : recipe.action === "content.save"
      ? "bookmark"
      : "repost";
  const desired = inputBoolean(
    input,
    kind === "like" ? "liked" : kind === "bookmark" ? "saved" : "reposted",
  );
  let started = 0;
  let verified = 0;
  try {
    const before = await getPost(client, uri);
    if (postState(before, kind) === desired) {
      return desiredStateResult(recipe.action as BlueskyWebOperationName, {
        postUri: uri,
        desired,
      });
    }
    await rebindBeforeDispatch(client);
    await options.beforeDispatch?.(dispatchEvent(recipe.action, 1, 1, 0, 0));
    started = 1;
    let createdUri: string | null = null;
    if (kind === "bookmark") {
      await xrpc(
        client,
        desired
          ? "app.bsky.bookmark.createBookmark"
          : "app.bsky.bookmark.deleteBookmark",
        {
          proxy: BLUESKY_APPVIEW_PROXY,
          jsonBody: desired
            ? { uri: before.uri, cid: before.cid }
            : { uri: before.uri },
        },
      );
    } else {
      const collection = kind === "like"
        ? "app.bsky.feed.like"
        : "app.bsky.feed.repost";
      if (desired) {
        const created = await createRecord(client, collection, {
          $type: collection,
          subject: { uri: before.uri, cid: before.cid },
          createdAt: new Date(options.now()).toISOString(),
        });
        createdUri = created.uri;
      } else {
        const existing = postStateUri(before, kind);
        if (existing === null) throw new Error("Bluesky desired-state deletion omitted its exact record URI");
        await deleteRecord(client, existing, collection);
      }
    }
    const after = await getPost(client, uri);
    if (postState(after, kind) !== desired) {
      throw new Error("Bluesky desired-state readback did not match the confirmed state");
    }
    if (
      createdUri !== null
      && postStateUri(after, kind as Exclude<PostStateKind, "bookmark">) !== createdUri
    ) throw new Error("Bluesky desired-state readback did not bind the created record");
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1, 1, 1));
    return {
      status: "succeeded",
      output: Object.freeze({ postUri: uri, desired, noOp: false }),
      finalUrl: `${BLUESKY_APP_ORIGIN}/profile/${before.author.did}/post/${blueskyPostUri(uri).rkey}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: BLUESKY_APP_ORIGIN,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "Bluesky may have changed the requested post state but exact readback was not verified; reconcile before retrying"
        : "Bluesky desired post state failed before submission",
    };
  }
}

async function executeFollowDesiredState(
  client: BlueskyClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly now: () => number;
  },
): Promise<WebSessionExecution> {
  const targetDid = blueskyDid(inputString(input, "actor_did", 255), "input.actor_did");
  const desired = inputBoolean(input, "followed");
  let started = 0;
  let verified = 0;
  try {
    if (targetDid === client.session.did) throw new Error("Bluesky cannot follow the bound viewer");
    const before = await getProfile(client, targetDid);
    if ((before.following !== null) === desired) {
      return desiredStateResult("relationships.follow.set", { actorDid: targetDid, desired });
    }
    await rebindBeforeDispatch(client);
    await options.beforeDispatch?.(dispatchEvent(recipe.action, 1, 1, 0, 0));
    started = 1;
    let createdUri: string | null = null;
    if (desired) {
      createdUri = (await createRecord(client, "app.bsky.graph.follow", {
        $type: "app.bsky.graph.follow",
        subject: targetDid,
        createdAt: new Date(options.now()).toISOString(),
      })).uri;
    } else {
      if (before.following === null) throw new Error("Bluesky unfollow omitted its exact follow URI");
      await deleteRecord(client, before.following, "app.bsky.graph.follow");
    }
    const after = await getProfile(client, targetDid);
    if ((after.following !== null) !== desired) {
      throw new Error("Bluesky follow readback did not match the confirmed state");
    }
    if (createdUri !== null && after.following !== createdUri) {
      throw new Error("Bluesky follow readback did not bind the created record");
    }
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1, 1, 1));
    return {
      status: "succeeded",
      output: Object.freeze({ actorDid: targetDid, desired, noOp: false }),
      finalUrl: `${BLUESKY_APP_ORIGIN}/profile/${targetDid}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: `${BLUESKY_APP_ORIGIN}/profile/${targetDid}`,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "Bluesky may have changed the follow state but exact readback was not verified; reconcile before retrying"
        : "Bluesky follow state failed before submission",
    };
  }
}

function fileInput(value: OperationInput[string]): FileInputValue {
  if (
    !isRecord(value)
    || value.kind !== "file"
    || typeof value.reference !== "string"
    || Object.keys(value).sort().join(",") !== "kind,reference"
  ) throw new Error("input.media must be one plan-bound file");
  return Object.freeze({ kind: "file", reference: value.reference });
}

async function readBoundMedia(
  input: OperationInput,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<{
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
  readonly alt: string;
} | null> {
  if (input.media === undefined) {
    if (input.media_type !== undefined || input.alt !== undefined) {
      throw new Error("input.media_type and input.alt require input.media");
    }
    return null;
  }
  if (fileResolver === undefined) throw new Error("Bluesky media upload requires the plan-bound file resolver");
  const media = fileInput(input.media);
  const mediaType = inputString(input, "media_type", 32);
  if (
    mediaType !== "image/jpeg"
    && mediaType !== "image/png"
    && mediaType !== "image/webp"
  ) throw new Error("input.media_type must be a reviewed Bluesky image type");
  const rawAlt = input.alt;
  const alt = rawAlt === undefined
    ? ""
    : typeof rawAlt === "string" && rawAlt.length <= 10_000 && !/[\0\r]/u.test(rawAlt)
      ? rawAlt
      : (() => {
          throw new Error("input.alt must be bounded text");
        })();
  const paths = operationDeadline === undefined
    ? await fileResolver([media])
    : await operationDeadline.run(
        () => fileResolver([media]),
        WEB_SESSION_OPERATION_LABEL,
      );
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  if (paths.length !== 1 || typeof paths[0] !== "string") {
    throw new Error("Bluesky file resolver did not return one exact path");
  }
  const path = paths[0];
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = operationDeadline === undefined
    ? await open(path, constants.O_RDONLY | noFollow)
    : await operationDeadline.run(
        () => open(path, constants.O_RDONLY | noFollow),
        WEB_SESSION_OPERATION_LABEL,
      );
  try {
    const before = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          WEB_SESSION_OPERATION_LABEL,
        );
    if (!before.isFile() || before.size < 1 || before.size > MAX_IMAGE_BYTES) {
      throw new Error("Bluesky image must be a regular file no larger than 2,000,000 bytes");
    }
    const bytes = operationDeadline === undefined
      ? await handle.readFile()
      : await operationDeadline.run(
          () => handle.readFile(),
          WEB_SESSION_OPERATION_LABEL,
        );
    const after = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          WEB_SESSION_OPERATION_LABEL,
        );
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || bytes.byteLength !== before.size
    ) throw new Error("Bluesky image changed while it was materialized");
    return Object.freeze({
      bytes: new Uint8Array(bytes),
      mediaType,
      alt,
    });
  } finally {
    await handle.close();
  }
}

async function uploadImage(
  client: BlueskyClient,
  media: NonNullable<Awaited<ReturnType<typeof readBoundMedia>>>,
): Promise<BlueskyBlobRef> {
  return parseBlueskyUploadBlobResponse(
    await xrpc(client, "com.atproto.repo.uploadBlob", {
      blobBody: { bytes: media.bytes, mediaType: media.mediaType },
      maximumBytes: 512 * 1024,
    }),
    media.mediaType,
    media.bytes.byteLength,
  );
}

function publishTexts(
  action: WebSessionRecipe["action"],
  input: OperationInput,
): readonly string[] {
  if (action !== "threads.publish") {
    return [assertBlueskyText(input.body, "input.body", 280, 3_000)];
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 25) {
    throw new Error("input.items must contain between one and twenty-five thread items");
  }
  return Object.freeze(input.items.map((item, index) =>
    assertBlueskyText(item, `input.items[${index}]`, 280, 3_000)
  ));
}

function assertPublishedPost(
  post: BlueskyProjectedPost,
  expected: {
    readonly actorDid: string;
    readonly text: string;
    readonly reply: { readonly root: BlueskyStrongRef; readonly parent: BlueskyStrongRef } | null;
    readonly quote: BlueskyStrongRef | null;
    readonly mediaAlt: string | null;
  },
): void {
  if (post.author.did !== expected.actorDid || post.text !== expected.text) {
    throw new Error("Bluesky post readback did not bind the confirmed actor and text");
  }
  if (JSON.stringify(post.reply) !== JSON.stringify(expected.reply)) {
    throw new Error("Bluesky post readback did not bind the confirmed reply root and parent");
  }
  if (JSON.stringify(post.quote) !== JSON.stringify(expected.quote)) {
    throw new Error("Bluesky post readback did not bind the confirmed quoted record");
  }
  if (expected.mediaAlt !== null) {
    if (
      post.attachments.length !== 1
      || post.attachments[0]?.kind !== "image"
      || post.attachments[0].alt !== expected.mediaAlt
    ) throw new Error("Bluesky post readback did not bind the confirmed image attachment");
  }
}

type BlueskyPublishFailureStage =
  | "media-upload"
  | "record-preparation"
  | "dispatch-rebinding"
  | "dispatch-admission"
  | "create-record"
  | "accepted-target-recording"
  | "authoritative-record-readback"
  | "public-post-readback"
  | "verification-recording";

async function executePublish(
  client: BlueskyClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterProviderAcceptedMutationTarget?: (
      event: WebSessionProviderAcceptedMutationTargetEvent,
    ) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  let started = 0;
  let verified = 0;
  let failureStage: BlueskyPublishFailureStage = "record-preparation";
  const posts: BlueskyStrongRef[] = [];
  let planned = recipe.action === "threads.publish" && Array.isArray(input.items)
    ? input.items.length
    : 1;
  try {
    const texts = publishTexts(recipe.action, input);
    planned = texts.length;
    if (
      recipe.action !== "posts.publish"
      && recipe.action !== "replies.create"
      && input.media !== undefined
    ) throw new Error("Bluesky media is supported only for a post or reply");
    const media = recipe.action === "posts.publish" || recipe.action === "replies.create"
      ? await readBoundMedia(
          input,
          options.fileResolver,
          client.operationDeadline,
        )
      : null;
    let reply: { readonly root: BlueskyStrongRef; readonly parent: BlueskyStrongRef } | null = null;
    let quote: BlueskyStrongRef | null = null;
    if (recipe.action === "replies.create") {
      const parent = await getPost(client, postUriInput(input));
      reply = Object.freeze({
        root: parent.reply?.root ?? Object.freeze({ uri: parent.uri, cid: parent.cid }),
        parent: Object.freeze({ uri: parent.uri, cid: parent.cid }),
      });
    } else if (recipe.action === "posts.quote") {
      const target = await getPost(client, postUriInput(input));
      quote = Object.freeze({ uri: target.uri, cid: target.cid });
    }
    for (const [offset, text] of texts.entries()) {
      const index = offset + 1;
      const id = recipe.action === "threads.publish"
        ? `${recipe.action}[${index}]`
        : recipe.action;
      if (recipe.action === "threads.publish" && offset > 0) {
        const parent = posts[offset - 1]!;
        reply = Object.freeze({
          root: posts[0]!,
          parent,
        });
      }
      failureStage = "media-upload";
      const blob = media === null || offset > 0 ? null : await uploadImage(client, media);
      failureStage = "record-preparation";
      const createdAt = new Date(options.now()).toISOString();
      const record = Object.freeze({
        $type: "app.bsky.feed.post",
        text,
        createdAt,
        ...(reply === null ? {} : { reply }),
        ...(quote === null
          ? {}
          : {
              embed: {
                $type: "app.bsky.embed.record",
                record: quote,
              },
            }),
        ...(blob === null
          ? {}
          : {
              embed: {
                $type: "app.bsky.embed.images",
                images: [{ image: blob, alt: media!.alt }],
              },
            }),
      });
      failureStage = "dispatch-rebinding";
      await rebindBeforeDispatch(client);
      failureStage = "dispatch-admission";
      await options.beforeDispatch?.(
        dispatchEvent(id, index, planned, started, verified),
      );
      started = index;
      // createRecord is the externally visible public-post mutation. Keep the
      // optional uploadBlob preparation entirely before this durable dispatch
      // boundary: an uploaded blob is not a feed record and cannot publish by
      // itself.
      failureStage = "create-record";
      const created = await createRecord(client, "app.bsky.feed.post", record);
      failureStage = "accepted-target-recording";
      await options.afterProviderAcceptedMutationTarget?.({
        id,
        index,
        target: {
          schemaVersion: 1,
          identifier: canonicalJson({
            uri: created.uri,
            cid: created.cid,
            createdAt,
            media: blob === null
              ? null
              : {
                  cid: blob.ref.$link,
                  mediaType: blob.mimeType,
                  size: blob.size,
                },
          }),
        },
      });
      failureStage = "authoritative-record-readback";
      await getAuthoritativeRecord(client, created, record);
      failureStage = "public-post-readback";
      const readback = await waitForPublishReadback(
        client,
        created.uri,
        options.sleep,
      );
      if (readback.cid !== created.cid || readback.createdAt !== createdAt) {
        throw new Error("Bluesky post readback did not bind the created record revision");
      }
      assertPublishedPost(readback, {
        actorDid: client.session.did,
        text,
        reply,
        quote,
        mediaAlt: blob === null ? null : media!.alt,
      });
      posts.push(created);
      verified = index;
      failureStage = "verification-recording";
      await options.afterDispatchVerified?.(
        dispatchEvent(id, index, planned, started, verified),
      );
    }
    return {
      status: "succeeded",
      output: Object.freeze({
        posts: Object.freeze(posts.map((post) => Object.freeze({
          uri: post.uri,
          cid: post.cid,
          url: `${BLUESKY_APP_ORIGIN}/profile/${client.session.did}/post/${blueskyPostUri(post.uri).rkey}`,
        }))),
      }),
      finalUrl: posts.length === 0
        ? BLUESKY_APP_ORIGIN
        : `${BLUESKY_APP_ORIGIN}/profile/${client.session.did}/post/${blueskyPostUri(posts.at(-1)!.uri).rkey}`,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
    };
  } catch {
    const status = started > verified ? "indeterminate" : verified > 0 ? "partial" : "failed";
    return {
      status,
      output: posts.length === 0 ? null : Object.freeze({ posts }),
      finalUrl: posts.length === 0
        ? BLUESKY_APP_ORIGIN
        : `${BLUESKY_APP_ORIGIN}/profile/${client.session.did}/post/${blueskyPostUri(posts.at(-1)!.uri).rkey}`,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
      error: status === "indeterminate"
        ? `Bluesky may have accepted the current post dispatch; failure stage: ${failureStage}; reconcile before retrying`
        : status === "partial"
          ? `Bluesky verified only part of the confirmed post workflow; failure stage: ${failureStage}; inspect the verified results before retrying`
          : `Bluesky post preparation failed before public record submission; failure stage: ${failureStage}; retry with a fresh confirmed plan`,
    };
  }
}

async function executeMessageSend(
  client: BlueskyClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  const convoId = convoIdInput(input);
  const text = assertBlueskyText(input.body, "input.body", 1_000, 10_000);
  let started = 0;
  let verified = 0;
  try {
    await getConvo(client, convoId);
    await rebindBeforeDispatch(client);
    await options.beforeDispatch?.(dispatchEvent(recipe.action, 1, 1, 0, 0));
    started = 1;
    const sent = record(
      await xrpc(client, "chat.bsky.convo.sendMessage", {
        proxy: BLUESKY_CHAT_PROXY,
        jsonBody: { convoId, message: { text } },
      }),
      "Bluesky sendMessage response",
    );
    const sentIdInput: OperationInput = {
      sent: typeof sent.id === "string" ? sent.id : "",
    };
    const sentId = inputString(sentIdInput, "sent", 512);
    const sentProjection = projectBlueskyMessages(
      { messages: [sent] },
      1,
    ).messages[0]!;
    if (sentProjection.senderDid !== client.session.did || sentProjection.text !== text) {
      throw new Error("Bluesky sendMessage response did not bind the confirmed sender and text");
    }
    const readback = await getMessages(client, convoId, 100);
    const found = readback.messages.find((message) => message.id === sentId);
    if (
      found === undefined
      || found.senderDid !== client.session.did
      || found.text !== text
    ) throw new Error("Bluesky message readback did not bind the sent message");
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1, 1, 1));
    return {
      status: "succeeded",
      output: found,
      finalUrl: `${BLUESKY_APP_ORIGIN}/messages/${encodeURIComponent(convoId)}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: `${BLUESKY_APP_ORIGIN}/messages/${encodeURIComponent(convoId)}`,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "Bluesky may have accepted the message but exact readback was not verified; reconcile before retrying"
        : "Bluesky message dispatch failed before submission",
    };
  }
}

export async function executeBlueskyWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterProviderAcceptedMutationTarget?: (
      event: WebSessionProviderAcceptedMutationTargetEvent,
    ) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: BlueskyWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "bluesky"
    || !isBlueskyOperation(recipe.action)
  ) throw new Error("Bluesky authenticated web recipe is not installed");
  const expectedContractVersion = recipe.action === "posts.publish" ? 3 : 1;
  if (recipe.contractVersion !== expectedContractVersion) {
    throw new Error(
      `Bluesky authenticated web operation ${recipe.action} contract version ${recipe.contractVersion} is not installed`,
    );
  }
  const contract = BLUESKY_WEB_OPERATIONS[recipe.action];
  if (contract.state !== "observed") {
    throw new Error(
      `Bluesky authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`,
    );
  }
  const client = await bootstrapClient(
    auth,
    recipe.timeoutMs,
    recipe.maxOutputBytes,
    options.dependencies,
    options.operationDeadline,
    options.registerCleanupBarrier,
  );
  requireBoundSubject(auth, client.session);
  if (recipe.action === "feeds.read") return executeFeedRead(client, input);
  if (recipe.action === "posts.read") return executePostRead(client, input, false);
  if (recipe.action === "media.read") return executePostRead(client, input, true);
  if (recipe.action === "comments.read") return executeCommentsRead(client, input);
  if (recipe.action === "messaging.list") return executeMessagingList(client, input);
  if (recipe.action === "messaging.read") return executeMessagingRead(client, input);
  const mutationOptions = {
    ...(options.beforeDispatch === undefined ? {} : { beforeDispatch: options.beforeDispatch }),
    ...(options.afterDispatchVerified === undefined
      ? {}
      : { afterDispatchVerified: options.afterDispatchVerified }),
    ...(options.afterProviderAcceptedMutationTarget === undefined
      ? {}
      : {
          afterProviderAcceptedMutationTarget:
            options.afterProviderAcceptedMutationTarget,
        }),
    now: options.dependencies?.now ?? Date.now,
    sleep: options.dependencies?.sleep
      ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
  };
  if (
    recipe.action === "likes.set"
    || recipe.action === "content.save"
    || recipe.action === "posts.repost"
  ) return executePostDesiredState(client, recipe, input, mutationOptions);
  if (recipe.action === "content.delete") {
    return executeContentDelete(client, recipe, input, mutationOptions);
  }
  if (recipe.action === "relationships.follow.set") {
    return executeFollowDesiredState(client, recipe, input, mutationOptions);
  }
  if (
    recipe.action === "posts.publish"
    || recipe.action === "replies.create"
    || recipe.action === "posts.quote"
    || recipe.action === "threads.publish"
  ) {
    return executePublish(client, recipe, input, {
      ...mutationOptions,
      ...(options.fileResolver === undefined ? {} : { fileResolver: options.fileResolver }),
    });
  }
  if (recipe.action === "messaging.send") {
    return executeMessageSend(client, recipe, input, mutationOptions);
  }
  throw new Error(
    `Bluesky authenticated web operation ${recipe.action} has no executable reviewed contract`,
  );
}
