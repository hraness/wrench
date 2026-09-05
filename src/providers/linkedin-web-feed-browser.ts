import { createHash } from "node:crypto";

import type { WrenchAuth } from "../auth";
import {
  PreservedBrowserArtifactsError,
  browserResultData,
  createBrowserSession,
  runCommand,
  type BrowserSession,
  type CommandResult,
  type CreateBrowserSessionOptions,
} from "../browser";
import type { WrenchManifest } from "../model";
import type {
  WebSessionCleanupResourcePublisher,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  LINKEDIN_GRAPHQL_PATH,
  LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX,
  assertLinkedInProfileActivityRequest,
  linkedInProfileActivityPageUrl,
  linkedInProfileActivityTargetFromVanity,
  resolveLinkedInProfileActivityBinding,
  type LinkedInProfileActivityBinding,
} from "./linkedin-web-feed";

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const LINKEDIN_FEED_URL = `${LINKEDIN_ORIGIN}/feed/`;
const LINKEDIN_PRE_COOKIE_REALM_URL = `${LINKEDIN_ORIGIN}/robots.txt`;
const LINKEDIN_INITIAL_ROOT_BATCH = JSON.stringify([["open", LINKEDIN_ORIGIN]]);
const LINKEDIN_INITIAL_BLANK_BATCH = JSON.stringify([["open", "about:blank"]]);
const LINKEDIN_INITIAL_REALM_BATCH = JSON.stringify([["open", LINKEDIN_PRE_COOKIE_REALM_URL]]);
const MAX_IDENTITY_BYTES = 2 * 1024 * 1024;
const MAX_FEED_PAGE_BYTES = 8 * 1024 * 1024;
const BROWSER_ENVELOPE_BYTES = 64 * 1024;
const MAX_NETWORK_REQUESTS = 10_000;
const MAX_REQUEST_URL_CHARACTERS = 64 * 1_024;

const feedBrowserManifest: WrenchManifest = Object.freeze({
  schemaVersion: 4,
  id: "linkedin-profile-activity-runtime",
  version: "1.0.0",
  displayName: "LinkedIn profile-activity runtime",
  surfaceId: "linkedin",
  origins: Object.freeze([LINKEDIN_ORIGIN]),
  browserDomains: Object.freeze(["www.linkedin.com", "static.licdn.com"]),
  operations: Object.freeze({}),
});

export type LinkedInFeedBrowserTransport = {
  readonly currentIdentityResponse: () => Promise<unknown>;
  readonly resolveProfileActivityBinding: (vanity: string) => Promise<LinkedInProfileActivityBinding>;
  readonly readProfileActivityPage: (input: {
    readonly count: number;
    readonly start: number;
  }) => Promise<unknown>;
  readonly close: () => Promise<void>;
};

export type LinkedInFeedBrowserDependencies = {
  readonly createBrowserSession: typeof createBrowserSession;
  readonly runCommand: typeof runCommand;
  readonly settleContext: () => Promise<void>;
};

type BrowserReadBinding = {
  readonly documentUrl: string | null;
  readonly kind: "json";
  readonly maxBytes: number;
  readonly path: string;
  readonly referrer: string;
};

type BrowserReadState = "ready" | "identity" | "bound";

type ObservedBrowserRequest = Readonly<Record<string, unknown>> & {
  readonly requestId: string;
};

type BoundProfileActivityPage = {
  readonly binding: LinkedInProfileActivityBinding;
  readonly targetUrl: string;
  readonly vanity: string;
};

const LINKEDIN_RESPONSE_MEDIA_TYPE =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

export type LinkedInFeedBrowserFailureCategory =
  | "authwall"
  | "body-envelope"
  | "bootstrap"
  | "browser-envelope"
  | "browser-command"
  | "execution-context"
  | "identity-json"
  | "output-bound"
  | "provider-fetch"
  | "response-envelope"
  | "response-rejected"
  | "session-cookie"
  | "startup";

export class LinkedInFeedBrowserFailure extends Error {
  readonly category: LinkedInFeedBrowserFailureCategory;

  constructor(category: LinkedInFeedBrowserFailureCategory, message: string) {
    super(message);
    this.name = "LinkedInFeedBrowserFailure";
    this.category = category;
  }
}

export class LinkedInFeedBrowserResponseRejectedError extends LinkedInFeedBrowserFailure {
  readonly status: number;
  readonly contentType: string;

  constructor(status: number, contentType: string) {
    super(
      "response-rejected",
      "LinkedIn profile-activity browser request returned a reviewed rejection",
    );
    this.name = "LinkedInFeedBrowserResponseRejectedError";
    if (
      !Number.isSafeInteger(status)
      || status < 100
      || status > 599
      || contentType.length > 128
      || (contentType !== "" && !LINKEDIN_RESPONSE_MEDIA_TYPE.test(contentType))
    ) throw new Error("LinkedIn profile-activity browser returned a malformed response category");
    this.status = status;
    this.contentType = contentType === "" ? "missing" : contentType;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label} returned an unexpected result shape`);
  }
}

function browserReadEvaluationSource(binding: BrowserReadBinding): string {
  const bound = JSON.stringify(binding);
  return `(async()=>{const input=${bound};if(location.origin!=="${LINKEDIN_ORIGIN}")throw new Error("unexpected LinkedIn origin");if(input.kind!=="json"||!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1||input.maxBytes>${MAX_FEED_PAGE_BYTES}||(input.documentUrl!==null&&typeof input.documentUrl!=="string"))throw new Error("invalid LinkedIn profile-activity browser request binding");if(input.documentUrl!==null&&location.href!==input.documentUrl){if(location.origin==="${LINKEDIN_ORIGIN}"&&/^\/(?:authwall|checkpoint|login|uas\/login(?:-submit)?)(?:\/|$)/u.test(location.pathname))throw new Error("LinkedIn profile-activity browser reached its signed-out authwall");throw new Error("LinkedIn profile-activity browser left its bound document")}const expected=new URL(input.path,"${LINKEDIN_ORIGIN}");if(expected.origin!=="${LINKEDIN_ORIGIN}"||expected.username!==""||expected.password!==""||expected.hash!==""||expected.href!=="${LINKEDIN_ORIGIN}"+input.path)throw new Error("invalid LinkedIn profile-activity browser path binding");if(expected.pathname!=="/voyager/api/me"&&expected.pathname!=="${LINKEDIN_GRAPHQL_PATH}")throw new Error("invalid LinkedIn profile-activity browser path binding");const headers={accept:"application/vnd.linkedin.normalized+json+2.1","x-li-lang":"en_US","x-requested-with":"XMLHttpRequest","x-restli-protocol-version":"2.0.0"};const raw=document.cookie.split("; ").find((part)=>part.startsWith("JSESSIONID="));if(typeof raw!=="string")throw new Error("missing LinkedIn browser CSRF cookie");const csrf=decodeURIComponent(raw.slice("JSESSIONID=".length)).replace(/^\"|\"$/g,"");if(!/^ajax:[A-Za-z0-9_-]{1,512}$/.test(csrf))throw new Error("invalid LinkedIn browser CSRF cookie");headers["csrf-token"]=csrf;const response=await fetch(input.path,{credentials:"include",headers,method:"GET",redirect:"manual",referrer:input.referrer});if(response.type==="opaqueredirect"){response.body?.cancel();return{authWall:true,bodyBase64:null,bodyBytes:0,bodySha256:null,contentType:"",status:0}}const responseUrl=new URL(response.url);if(responseUrl.origin!=="${LINKEDIN_ORIGIN}"||responseUrl.username!==""||responseUrl.password!==""||responseUrl.hash!==""||responseUrl.href!==expected.href)throw new Error("LinkedIn profile-activity browser response escaped its exact route");if(response.status>=300&&response.status<=399){response.body?.cancel();return{authWall:true,bodyBase64:null,bodyBytes:0,bodySha256:null,contentType:"",status:response.status}}const contentType=(response.headers.get("content-type")||"").split(";",1)[0].trim().toLowerCase();if(response.status!==200||(contentType!=="application/vnd.linkedin.normalized+json+2.1"&&contentType!=="application/json")){response.body?.cancel();return{authWall:false,bodyBase64:null,bodyBytes:0,bodySha256:null,contentType,status:response.status}}if(response.body===null)throw new Error("LinkedIn profile-activity browser response omitted its body");const reader=response.body.getReader();const chunks=[];let bytes=0;while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>input.maxBytes){await reader.cancel();throw new Error("LinkedIn profile-activity browser response exceeded its reviewed byte bound")}chunks.push(part.value)}const body=new Uint8Array(bytes);let cursor=0;for(const chunk of chunks){body.set(chunk,cursor);cursor+=chunk.byteLength}const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",body)),(value)=>value.toString(16).padStart(2,"0")).join("");let binary="";for(let offset=0;offset<body.length;offset+=32768)binary+=String.fromCharCode(...body.subarray(offset,Math.min(offset+32768,body.length)));return{authWall:false,bodyBase64:btoa(binary),bodyBytes:body.byteLength,bodySha256:digest,contentType,status:response.status}})()`;
}

function encodedBodyBound(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function decodedBody(
  result: Readonly<Record<string, unknown>>,
  maximumBytes: number,
): string {
  if (
    typeof result.bodyBase64 !== "string"
    || result.bodyBase64.length > encodedBodyBound(maximumBytes)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      result.bodyBase64,
    )
    || !Number.isSafeInteger(result.bodyBytes)
    || (result.bodyBytes as number) < 0
    || (result.bodyBytes as number) > maximumBytes
    || typeof result.bodySha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(result.bodySha256)
  ) throw new LinkedInFeedBrowserFailure(
    "body-envelope",
    "LinkedIn profile-activity browser body envelope changed shape",
  );
  const bytes = Buffer.from(result.bodyBase64, "base64");
  if (
    bytes.byteLength !== result.bodyBytes
    || bytes.toString("base64") !== result.bodyBase64
    || createHash("sha256").update(bytes).digest("hex") !== result.bodySha256
  ) throw new LinkedInFeedBrowserFailure(
    "body-envelope",
    "LinkedIn profile-activity browser body envelope failed integrity verification",
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LinkedInFeedBrowserFailure(
      "body-envelope",
      "LinkedIn profile-activity browser body was not valid UTF-8",
    );
  }
}

function browserEvaluationResult(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const data = browserResultData(value as Record<string, unknown>);
  if (!isRecord(data) || typeof data.origin !== "string" || !isRecord(data.result)) {
    throw new LinkedInFeedBrowserFailure(
      "response-envelope",
      "LinkedIn profile-activity browser returned a malformed evaluation envelope",
    );
  }
  let origin: URL;
  try {
    origin = new URL(data.origin);
  } catch {
    throw new LinkedInFeedBrowserFailure(
      "response-envelope",
      "LinkedIn profile-activity browser returned a malformed evaluation envelope",
    );
  }
  if (
    origin.origin !== LINKEDIN_ORIGIN
    || origin.username !== ""
    || origin.password !== ""
  ) throw new LinkedInFeedBrowserFailure(
    "response-envelope",
    "LinkedIn profile-activity browser returned a malformed evaluation envelope",
  );
  return data.result;
}

function hasNoDefaultExecutionContext(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (
      current instanceof Error
      && /(?:cannot find|no) default execution context/iu.test(current.message)
    ) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function hasUnexpectedLinkedInOrigin(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (
      current instanceof Error
      && /(?:^|: )unexpected LinkedIn origin(?:$|[\r\n])/u.test(current.message)
    ) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function classifiedBrowserCommandFailure(error: unknown): LinkedInFeedBrowserFailure {
  const message = error instanceof Error && error.message.length <= 1_500
    ? error.message
    : "";
  if (/(?:^|: )(?:missing|invalid) LinkedIn browser CSRF cookie$/u.test(message)) {
    return new LinkedInFeedBrowserFailure(
      "session-cookie",
      "LinkedIn profile-activity browser could not establish its reviewed CSRF cookie",
    );
  }
  if (message.includes("Failed to fetch")) {
    return new LinkedInFeedBrowserFailure(
      "provider-fetch",
      "LinkedIn profile-activity browser could not complete its first-party fetch",
    );
  }
  if (message.endsWith("LinkedIn profile-activity browser response escaped its exact route")) {
    return new LinkedInFeedBrowserFailure(
      "response-envelope",
      "LinkedIn profile-activity browser response escaped its exact route",
    );
  }
  if (message.endsWith("LinkedIn profile-activity browser left its bound document")) {
    return new LinkedInFeedBrowserFailure(
      "response-envelope",
      "LinkedIn profile-activity browser left its exact target page",
    );
  }
  if (message.endsWith("LinkedIn profile-activity browser reached its signed-out authwall")) {
    return new LinkedInFeedBrowserFailure(
      "authwall",
      "LinkedIn profile-activity browser reached the signed-out authwall",
    );
  }
  if (
    message.includes("process output exceeded")
    || message.includes("response exceeded its reviewed byte bound")
  ) {
    return new LinkedInFeedBrowserFailure(
      "output-bound",
      "LinkedIn profile-activity browser exceeded a reviewed output bound",
    );
  }
  if (
    message.includes("malformed batch")
    || message.includes("malformed batch entry")
    || message.includes("did not return JSON")
    || message.includes("command omitted its result")
  ) {
    return new LinkedInFeedBrowserFailure(
      "browser-envelope",
      "LinkedIn profile-activity browser command returned a malformed envelope",
    );
  }
  return new LinkedInFeedBrowserFailure(
    "browser-command",
    "LinkedIn profile-activity browser command failed before a reviewed response",
  );
}

function contextSettlementRejected(result: CommandResult): boolean {
  return result.exitCode !== 0
    && /Failed to install browser network controls:[^\r\n]{0,256}Cannot find default execution context/u.test(
      `${result.stderr}\n${result.stdout}`,
    );
}

function commandWasAborted(options: Parameters<typeof runCommand>[1]): boolean {
  return options.signal?.aborted === true;
}

function linkedInFeedBrowserCommandRunner(
  execute: typeof runCommand,
  settleContext: () => Promise<void>,
  authKind: WrenchAuth["kind"],
): typeof runCommand {
  let initialBatchPending = true;
  return async (command, options) => {
    const rewroteInitialRoot = initialBatchPending
      && options.stdin === LINKEDIN_INITIAL_ROOT_BATCH;
    const rewroteInitialBlank = initialBatchPending
      && authKind === "browser-profile"
      && options.stdin === LINKEDIN_INITIAL_BLANK_BATCH;
    const executionOptions = rewroteInitialRoot || rewroteInitialBlank
      ? { ...options, stdin: LINKEDIN_INITIAL_REALM_BATCH }
      : options;
    initialBatchPending = false;
    const first = await execute(command, executionOptions);
    if (
      !rewroteInitialRoot
      || authKind === "browser-profile"
      || !contextSettlementRejected(first)
      || commandWasAborted(executionOptions)
    ) return first;
    await settleContext();
    if (commandWasAborted(executionOptions)) return first;
    return execute(command, executionOptions);
  };
}

function settleLinkedInBrowserContext(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
}

async function finalizeBrowserSession(session: BrowserSession): Promise<void> {
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
  if (closeVerified && cleanupVerified) return;
  const cleanupEvidence = (
    closeVerified
    && !cleanupVerified
    && session.cleanupResourceIdentity !== undefined
  )
    ? Object.freeze({
        kind: "agent-browser-closed-artifacts-v1" as const,
        resource: session.cleanupResourceIdentity,
      })
    : undefined;
  throw new PreservedBrowserArtifactsError(
    "LinkedIn profile-activity browser finalization failed; private artifacts were preserved",
    session.recoveryHandle ?? "session=linkedin-profile-activity-runtime;artifacts=unknown",
    new AggregateError(failures, "LinkedIn profile-activity browser finalization failed"),
    cleanupEvidence,
  );
}

function observedRequests(value: unknown): readonly ObservedBrowserRequest[] {
  if (!isRecord(value) || !Array.isArray(value.requests) || value.requests.length > MAX_NETWORK_REQUESTS) {
    throw new LinkedInFeedBrowserFailure(
      "browser-envelope",
      "LinkedIn profile-activity network observation returned a malformed bounded request list",
    );
  }
  const requests: ObservedBrowserRequest[] = [];
  for (const item of value.requests) {
    if (
      !isRecord(item)
      || typeof item.requestId !== "string"
      || item.requestId.length < 1
      || item.requestId.length > 512
      || /[\0\r\n]/u.test(item.requestId)
    ) {
      throw new LinkedInFeedBrowserFailure(
        "browser-envelope",
        "LinkedIn profile-activity network observation returned a malformed request",
      );
    }
    requests.push(Object.freeze({
      requestId: item.requestId,
      method: item.method,
      status: item.status,
      url: item.url,
    }));
  }
  return requests;
}

function observedRequestIds(
  requests: readonly ObservedBrowserRequest[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const request of requests) {
    if (ids.has(request.requestId)) {
      throw new LinkedInFeedBrowserFailure(
        "browser-envelope",
        "LinkedIn profile-activity network observation returned duplicate request identities",
      );
    }
    ids.add(request.requestId);
  }
  return ids;
}

function currentProfileActivityUrl(
  value: unknown,
  expected: string,
): void {
  if (!isRecord(value) || typeof value.url !== "string" || value.url.length > 2_048) {
    throw new LinkedInFeedBrowserFailure(
      "browser-envelope",
      "LinkedIn profile-activity browser omitted its current URL",
    );
  }
  let current: URL;
  try {
    current = new URL(value.url);
  } catch {
    throw new LinkedInFeedBrowserFailure(
      "browser-envelope",
      "LinkedIn profile-activity browser returned a malformed current URL",
    );
  }
  if (
    current.origin === LINKEDIN_ORIGIN
    && /^\/(?:authwall|checkpoint|login|uas\/login(?:-submit)?)(?:\/|$)/u.test(current.pathname)
  ) {
    throw new LinkedInFeedBrowserFailure(
      "authwall",
      "LinkedIn profile-activity browser reached the signed-out authwall",
    );
  }
  if (
    current.username !== ""
    || current.password !== ""
    || current.hash !== ""
    || current.href !== expected
  ) throw new LinkedInFeedBrowserFailure(
    "response-envelope",
    "LinkedIn profile-activity browser left its exact target page",
  );
}

export async function createLinkedInFeedBrowserTransport(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly publishCleanupResource?: WebSessionCleanupResourcePublisher;
    readonly dependencies?: Partial<LinkedInFeedBrowserDependencies>;
  },
): Promise<LinkedInFeedBrowserTransport> {
  if (
    !Number.isSafeInteger(options.maxOutputBytes)
    || options.maxOutputBytes < 1
    || options.maxOutputBytes > MAX_FEED_PAGE_BYTES
  ) throw new Error("LinkedIn profile-activity browser output bound is invalid");
  const createSession = options.dependencies?.createBrowserSession
    ?? createBrowserSession;
  const browserOutputBytes = encodedBodyBound(options.maxOutputBytes)
    + BROWSER_ENVELOPE_BYTES;
  const sessionOptions: CreateBrowserSessionOptions = {
    allowCodeOwnedEvaluation: true,
    allowCodeOwnedNetworkObservation: true,
    headed: true,
    maxOutputBytes: browserOutputBytes,
    timeoutMs: options.timeoutMs,
    dependencies: {
      runCommand: linkedInFeedBrowserCommandRunner(
        options.dependencies?.runCommand ?? runCommand,
        options.dependencies?.settleContext ?? settleLinkedInBrowserContext,
        auth.kind,
      ),
    },
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.publishCleanupResource === undefined
      ? {}
      : { publishCleanupResource: options.publishCleanupResource }),
  };
  let session: BrowserSession;
  try {
    session = await createSession(feedBrowserManifest, auth, sessionOptions);
  } catch (error) {
    if (error instanceof PreservedBrowserArtifactsError) throw error;
    options.operationDeadline?.throwIfUnavailable(
      "LinkedIn profile-activity browser startup",
    );
    throw new LinkedInFeedBrowserFailure(
      "startup",
      "LinkedIn profile-activity browser could not start its contained session",
    );
  }
  let closed = false;
  let state: BrowserReadState = "ready";
  let boundPage: BoundProfileActivityPage | null = null;

  const remainingTimeMs = (): number =>
    options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs;

  const observeProfileActivityRequests = async (): Promise<readonly ObservedBrowserRequest[]> => {
    const entries = await session.runBatch(
      [["network", "requests", "--filter", LINKEDIN_PROFILE_ACTIVITY_QUERY_PREFIX]],
      Math.min(remainingTimeMs(), 30_000),
      8 * 1024 * 1024,
    );
    const first = entries[0];
    if (first === undefined) {
      throw new LinkedInFeedBrowserFailure(
        "browser-envelope",
        "LinkedIn profile-activity browser omitted its network observation",
      );
    }
    return observedRequests(browserResultData(first));
  };

  const run = async (
    binding: BrowserReadBinding,
  ): Promise<Readonly<Record<string, unknown>>> => {
    if (closed) throw new Error("LinkedIn profile-activity browser transport is closed");
    const source = browserReadEvaluationSource(binding);
    let records: readonly Readonly<Record<string, unknown>>[];
    try {
      records = await session.runBatch(
        [["eval", source]],
        remainingTimeMs(),
        Math.min(
          encodedBodyBound(binding.maxBytes) + BROWSER_ENVELOPE_BYTES,
          browserOutputBytes,
        ),
      );
    } catch (error) {
      if (error instanceof PreservedBrowserArtifactsError) throw error;
      if (error instanceof LinkedInFeedBrowserFailure) throw error;
      options.operationDeadline?.throwIfUnavailable(
        "LinkedIn profile-activity browser operation",
      );
      if (hasNoDefaultExecutionContext(error)) {
        throw new LinkedInFeedBrowserFailure(
          "execution-context",
          "LinkedIn profile-activity browser lost its reviewed execution context",
        );
      }
      if (hasUnexpectedLinkedInOrigin(error)) {
        throw new LinkedInFeedBrowserFailure(
          "bootstrap",
          "LinkedIn profile-activity browser was not on its reviewed signed-in origin",
        );
      }
      throw classifiedBrowserCommandFailure(error);
    }
    const first = records[0];
    if (first === undefined) {
      throw new LinkedInFeedBrowserFailure(
        "response-envelope",
        "LinkedIn profile-activity browser omitted its response",
      );
    }
    const result = browserEvaluationResult(first);
    try {
      exactKeys(
        result,
        [
          "authWall",
          "bodyBase64",
          "bodyBytes",
          "bodySha256",
          "contentType",
          "status",
        ],
        "LinkedIn profile-activity browser request",
      );
    } catch {
      throw new LinkedInFeedBrowserFailure(
        "response-envelope",
        "LinkedIn profile-activity browser request returned an unexpected result shape",
      );
    }
    if (
      typeof result.authWall !== "boolean"
      || typeof result.status !== "number"
      || !Number.isSafeInteger(result.status)
      || typeof result.contentType !== "string"
      || result.contentType.length > 128
      || (result.contentType !== "" && !LINKEDIN_RESPONSE_MEDIA_TYPE.test(result.contentType))
    ) throw new LinkedInFeedBrowserFailure(
      "response-envelope",
      "LinkedIn profile-activity browser returned a malformed response category",
    );
    if (result.authWall) {
      if (
        !(
          result.status === 0
          || (result.status >= 300 && result.status <= 399)
        )
        || result.contentType !== ""
        || result.bodyBase64 !== null
        || result.bodyBytes !== 0
        || result.bodySha256 !== null
      ) throw new LinkedInFeedBrowserFailure(
        "response-envelope",
        "LinkedIn profile-activity browser returned a malformed authwall envelope",
      );
      throw new LinkedInFeedBrowserFailure(
        "authwall",
        "LinkedIn profile-activity browser reached the signed-out authwall",
      );
    }
    if (result.status < 100 || result.status > 599) {
      throw new LinkedInFeedBrowserFailure(
        "response-envelope",
        "LinkedIn profile-activity browser returned a malformed response category",
      );
    }
    if (result.status >= 300 && result.status <= 399) {
      throw new LinkedInFeedBrowserFailure(
        "response-envelope",
        "LinkedIn profile-activity browser returned a malformed redirect envelope",
      );
    }
    if (result.status === 401 || result.status === 403) {
      if (
        result.bodyBase64 !== null
        || result.bodyBytes !== 0
        || result.bodySha256 !== null
      ) throw new LinkedInFeedBrowserFailure(
        "response-envelope",
        "LinkedIn profile-activity browser returned a malformed rejection envelope",
      );
      throw new LinkedInFeedBrowserFailure(
        "authwall",
        "LinkedIn profile-activity browser reached the signed-out authwall",
      );
    }
    if (
      result.status !== 200
      || (
        result.contentType !== "application/vnd.linkedin.normalized+json+2.1"
        && result.contentType !== "application/json"
      )
    ) {
      if (
        result.bodyBase64 !== null
        || result.bodyBytes !== 0
        || result.bodySha256 !== null
      ) throw new LinkedInFeedBrowserFailure(
        "response-envelope",
        "LinkedIn profile-activity browser returned a malformed rejection envelope",
      );
      throw new LinkedInFeedBrowserResponseRejectedError(
        result.status,
        result.contentType,
      );
    }
    return result;
  };

  const parseJsonBody = (
    result: Readonly<Record<string, unknown>>,
    maximumBytes: number,
    label: string,
  ): unknown => {
    const text = decodedBody(result, maximumBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LinkedInFeedBrowserFailure(
        "identity-json",
        `${label} was not valid JSON`,
      );
    }
  };

  return Object.freeze({
    currentIdentityResponse: async () => {
      if (state !== "ready") {
        throw new Error("LinkedIn profile-activity browser identity read is out of order");
      }
      const result = await run({
        documentUrl: null,
        kind: "json",
        maxBytes: Math.min(MAX_IDENTITY_BYTES, options.maxOutputBytes),
        path: "/voyager/api/me",
        referrer: LINKEDIN_FEED_URL,
      });
      state = "identity";
      return parseJsonBody(
        result,
        Math.min(MAX_IDENTITY_BYTES, options.maxOutputBytes),
        "LinkedIn profile-activity browser identity response",
      );
    },
    resolveProfileActivityBinding: async (vanity: string) => {
      if (state !== "identity") {
        throw new Error("LinkedIn profile-activity browser query observation is out of order");
      }
      const target = linkedInProfileActivityTargetFromVanity(vanity);
      try {
        const baselineRequestIds = observedRequestIds(
          await observeProfileActivityRequests(),
        );
        await session.runBatch(
          [["open", target.activityUrl]],
          remainingTimeMs(),
          2 * 1024 * 1024,
        );
        await session.runBatch(
          [["wait", "8000"]],
          Math.min(remainingTimeMs(), 20_000),
          1024 * 1024,
        );
        const requests = await observeProfileActivityRequests();
        observedRequestIds(requests);
        const currentUrlEntries = await session.runBatch(
          [["get", "url"]],
          Math.min(remainingTimeMs(), 10_000),
          1024 * 1024,
        );
        const currentUrl = currentUrlEntries[0];
        if (currentUrl === undefined) {
          throw new LinkedInFeedBrowserFailure(
            "browser-envelope",
            "LinkedIn profile-activity browser omitted its current URL",
          );
        }
        currentProfileActivityUrl(browserResultData(currentUrl), target.activityUrl);
        const bounded = requests.flatMap((request) => {
          if (baselineRequestIds.has(request.requestId)) return [];
          if (typeof request.url !== "string" || request.url.length > MAX_REQUEST_URL_CHARACTERS) {
            return [];
          }
          return [{
            method: request.method,
            status: request.status,
            url: request.url,
          }];
        });
        const binding = resolveLinkedInProfileActivityBinding(bounded);
        boundPage = Object.freeze({
          binding,
          targetUrl: target.activityUrl,
          vanity: target.slug,
        });
        state = "bound";
        return binding;
      } catch (error) {
        if (error instanceof PreservedBrowserArtifactsError) throw error;
        if (error instanceof LinkedInFeedBrowserFailure) throw error;
        options.operationDeadline?.throwIfUnavailable(
          "LinkedIn profile-activity query observation",
        );
        throw new LinkedInFeedBrowserFailure(
          "browser-command",
          "LinkedIn current registered query was not observed",
        );
      }
    },
    readProfileActivityPage: async (input: {
      readonly count: number;
      readonly start: number;
    }) => {
      if (state !== "bound" || boundPage === null) {
        throw new Error("LinkedIn profile-activity browser page read is out of order");
      }
      const request = {
        queryId: boundPage.binding.queryId,
        profileUrn: boundPage.binding.profileUrn,
        count: input.count,
        start: input.start,
      } as const;
      const url = linkedInProfileActivityPageUrl(request);
      assertLinkedInProfileActivityRequest({ method: "GET", url }, request);
      const path = `${url.pathname}${url.search}`;
      const result = await run({
        documentUrl: boundPage.targetUrl,
        kind: "json",
        maxBytes: options.maxOutputBytes,
        path,
        referrer: boundPage.targetUrl,
      });
      state = "bound";
      return parseJsonBody(
        result,
        options.maxOutputBytes,
        "LinkedIn profile-activity browser page response",
      );
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await finalizeBrowserSession(session);
    },
  });
}
