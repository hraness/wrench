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
  blueskyDid,
  blueskyPostUri,
  parseBlueskyAtUri,
  parseBlueskyBootstrapAccount,
  parseBlueskyCreateRecordResponse,
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

type JsonRecord = Record<string, unknown>;
type BlueskyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BlueskyWebRuntimeDependencies = {
  readonly fetch?: BlueskyFetch;
  readonly createBrowserSession?: typeof createBrowserSession;
  readonly now?: () => number;
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
    body = new Blob([options.blobBody.bytes], { type: options.blobBody.mediaType });
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

async function executePublish(
  client: BlueskyClient,
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly now: () => number;
  },
): Promise<WebSessionExecution> {
  let started = 0;
  let verified = 0;
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
      await rebindBeforeDispatch(client);
      await options.beforeDispatch?.(
        dispatchEvent(id, index, planned, started, verified),
      );
      started = index;
      const blob = media === null || offset > 0 ? null : await uploadImage(client, media);
      const createdAt = new Date(options.now()).toISOString();
      const created = await createRecord(client, "app.bsky.feed.post", {
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
      const readback = await getPost(client, created.uri);
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
    return {
      status: started > verified ? "indeterminate" : verified > 0 ? "partial" : "failed",
      output: posts.length === 0 ? null : Object.freeze({ posts }),
      finalUrl: posts.length === 0
        ? BLUESKY_APP_ORIGIN
        : `${BLUESKY_APP_ORIGIN}/profile/${client.session.did}/post/${blueskyPostUri(posts.at(-1)!.uri).rkey}`,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
      error: started > verified
        ? "Bluesky may have accepted the current post dispatch; reconcile before retrying"
        : "Bluesky post dispatch failed before a response-bound result was verified",
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
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: BlueskyWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "bluesky"
    || recipe.contractVersion !== 1
    || !isBlueskyOperation(recipe.action)
  ) throw new Error("Bluesky authenticated web recipe is not installed");
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
    now: options.dependencies?.now ?? Date.now,
  };
  if (
    recipe.action === "likes.set"
    || recipe.action === "content.save"
    || recipe.action === "posts.repost"
  ) return executePostDesiredState(client, recipe, input, mutationOptions);
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
