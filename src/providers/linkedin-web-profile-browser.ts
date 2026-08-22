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

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const LINKEDIN_FEED_URL = `${LINKEDIN_ORIGIN}/feed/`;
const LINKEDIN_BROWSER_REALM_URL = `${LINKEDIN_ORIGIN}/robots.txt`;
const LINKEDIN_INITIAL_ROOT_BATCH = JSON.stringify([
  ["open", LINKEDIN_ORIGIN],
]);
const LINKEDIN_INITIAL_REALM_BATCH = JSON.stringify([
  ["open", LINKEDIN_BROWSER_REALM_URL],
]);
const LINKEDIN_CONNECTIONS_URL =
  `${LINKEDIN_ORIGIN}/mynetwork/invite-connect/connections/`;
const MAX_IDENTITY_BYTES = 2 * 1024 * 1024;
const MAX_STATS_PAGE_BYTES = 8 * 1024 * 1024;
const BROWSER_ENVELOPE_BYTES = 64 * 1024;

const profileBrowserManifest: WrenchManifest = Object.freeze({
  schemaVersion: 4,
  id: "linkedin-profile-runtime",
  version: "1.0.0",
  displayName: "LinkedIn profile stats runtime",
  surfaceId: "linkedin",
  origins: Object.freeze([LINKEDIN_ORIGIN]),
  browserDomains: Object.freeze(["www.linkedin.com", "static.licdn.com"]),
  operations: Object.freeze({}),
});

export type LinkedInProfileBrowserTransport = {
  readonly currentIdentityResponse: () => Promise<unknown>;
  readonly readProfileHtml: (profileUrl: string) => Promise<string>;
  readonly readConnectionsHtml: (profileUrl: string) => Promise<string>;
  readonly readOrganizationHtml: (organizationUrl: string) => Promise<string>;
  readonly close: () => Promise<void>;
};

export type LinkedInProfileBrowserDependencies = {
  readonly createBrowserSession: typeof createBrowserSession;
  readonly runCommand: typeof runCommand;
  readonly settleContext: () => Promise<void>;
};

type BrowserReadBinding = {
  readonly kind: "html" | "json";
  readonly maxBytes: number;
  readonly path: string;
  readonly referrer: string;
};

type BrowserReadState = "ready" | "identity" | "profile" | "complete";

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

function exactLinkedInUrl(
  value: string,
  kind: "organization" | "profile",
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`LinkedIn ${kind} browser target is invalid`);
  }
  const pathAllowed = kind === "profile"
    ? /^\/in\/[A-Za-z0-9_-]{1,256}\/$/u.test(url.pathname)
    : /^\/company\/[a-z0-9][a-z0-9-]{0,255}\/$/u.test(url.pathname);
  if (
    url.origin !== LINKEDIN_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !pathAllowed
  ) throw new Error(`LinkedIn ${kind} browser target escaped its reviewed route`);
  return url;
}

function browserReadEvaluationSource(binding: BrowserReadBinding): string {
  const bound = JSON.stringify(binding);
  return `(async()=>{const input=${bound};if(location.origin!=="${LINKEDIN_ORIGIN}")throw new Error("unexpected LinkedIn origin");if((input.kind!=="json"&&input.kind!=="html")||!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1||input.maxBytes>${MAX_STATS_PAGE_BYTES})throw new Error("invalid LinkedIn stats browser request binding");const expected=new URL(input.path,"${LINKEDIN_ORIGIN}");if(expected.origin!=="${LINKEDIN_ORIGIN}"||expected.username!==""||expected.password!==""||expected.hash!==""||expected.href!=="${LINKEDIN_ORIGIN}"+input.path)throw new Error("invalid LinkedIn stats browser path binding");const headers=input.kind==="json"?{accept:"application/vnd.linkedin.normalized+json+2.1","x-li-lang":"en_US","x-requested-with":"XMLHttpRequest","x-restli-protocol-version":"2.0.0"}:{accept:"text/html"};if(input.kind==="json"){const raw=document.cookie.split("; ").find((part)=>part.startsWith("JSESSIONID="));if(typeof raw!=="string")throw new Error("missing LinkedIn browser CSRF cookie");const csrf=decodeURIComponent(raw.slice("JSESSIONID=".length)).replace(/^\"|\"$/g,"");if(!/^ajax:[A-Za-z0-9_-]{1,512}$/.test(csrf))throw new Error("invalid LinkedIn browser CSRF cookie");headers["csrf-token"]=csrf}const response=await fetch(input.path,{credentials:"include",headers,method:"GET",redirect:"error",referrer:input.referrer});const responseUrl=new URL(response.url);if(responseUrl.origin!=="${LINKEDIN_ORIGIN}"||responseUrl.username!==""||responseUrl.password!==""||responseUrl.hash!==""||responseUrl.href!==expected.href)throw new Error("LinkedIn stats browser response escaped its exact route");const contentType=(response.headers.get("content-type")||"").split(";",1)[0].trim().toLowerCase();const contentTypeAllowed=input.kind==="json"?(contentType==="application/vnd.linkedin.normalized+json+2.1"||contentType==="application/json"):contentType==="text/html";if(response.status!==200||!contentTypeAllowed){response.body?.cancel();return{authWall:false,bodyBase64:null,bodyBytes:0,bodySha256:null,contentType,status:response.status}}if(response.body===null)throw new Error("LinkedIn stats browser response omitted its body");const reader=response.body.getReader();const chunks=[];let bytes=0;while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>input.maxBytes){await reader.cancel();throw new Error("LinkedIn stats browser response exceeded its reviewed byte bound")}chunks.push(part.value)}const body=new Uint8Array(bytes);let cursor=0;for(const chunk of chunks){body.set(chunk,cursor);cursor+=chunk.byteLength}const text=new TextDecoder("utf-8",{fatal:true}).decode(body);const authWall=input.kind==="html"&&/(?:id|data-test-id)=[\"']authwall[\"']|name=[\"']loginCsrfParam[\"']|<form[^>]+(?:login|sign-in)/iu.test(text);if(authWall)return{authWall:true,bodyBase64:null,bodyBytes:0,bodySha256:null,contentType,status:response.status};const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",body)),(value)=>value.toString(16).padStart(2,"0")).join("");let binary="";for(let offset=0;offset<body.length;offset+=32768)binary+=String.fromCharCode(...body.subarray(offset,Math.min(offset+32768,body.length)));return{authWall:false,bodyBase64:btoa(binary),bodyBytes:body.byteLength,bodySha256:digest,contentType,status:response.status}})()`;
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
  ) throw new Error("LinkedIn stats browser body envelope changed shape");
  const bytes = Buffer.from(result.bodyBase64, "base64");
  if (
    bytes.byteLength !== result.bodyBytes
    || bytes.toString("base64") !== result.bodyBase64
    || createHash("sha256").update(bytes).digest("hex") !== result.bodySha256
  ) throw new Error("LinkedIn stats browser body envelope failed integrity verification");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("LinkedIn stats browser body was not valid UTF-8");
  }
}

function browserEvaluationResult(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const data = browserResultData(value as Record<string, unknown>);
  if (!isRecord(data) || typeof data.origin !== "string" || !isRecord(data.result)) {
    throw new Error("LinkedIn stats browser returned a malformed evaluation envelope");
  }
  let origin: URL;
  try {
    origin = new URL(data.origin);
  } catch {
    throw new Error("LinkedIn stats browser returned a malformed evaluation envelope");
  }
  if (
    origin.origin !== LINKEDIN_ORIGIN
    || origin.username !== ""
    || origin.password !== ""
  ) throw new Error("LinkedIn stats browser returned a malformed evaluation envelope");
  return data.result;
}

function hasNoDefaultExecutionContext(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (
      current instanceof Error
      && /no default execution context/iu.test(current.message)
    ) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function safeContextSettlementBatch(
  options: Parameters<typeof runCommand>[1],
): boolean {
  return [
    LINKEDIN_INITIAL_ROOT_BATCH,
    LINKEDIN_INITIAL_REALM_BATCH,
    JSON.stringify([["wait", "2000"]]),
    JSON.stringify([["wait", "500"]]),
  ].includes(options.stdin ?? "");
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

function linkedInProfileBrowserCommandRunner(
  execute: typeof runCommand,
  settleContext: () => Promise<void>,
): typeof runCommand {
  let initialBatchPending = true;
  return async (command, options) => {
    const executionOptions = initialBatchPending
      && options.stdin === LINKEDIN_INITIAL_ROOT_BATCH
      ? { ...options, stdin: LINKEDIN_INITIAL_REALM_BATCH }
      : options;
    initialBatchPending = false;
    const first = await execute(command, executionOptions);
    if (
      !safeContextSettlementBatch(executionOptions)
      || !contextSettlementRejected(first)
      || commandWasAborted(executionOptions)
    ) return first;
    // These are fixed navigation/settlement commands before the exact identity
    // request is evaluated. Agent-browser can briefly observe the tab between
    // navigation and default-context install. Retry only the rejected fixed
    // bootstrap command once in the same contained session; cookie commands,
    // evaluated requests, and provider response rejections are never eligible.
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
    "LinkedIn stats browser finalization failed; private artifacts were preserved",
    session.recoveryHandle ?? "session=linkedin-profile-runtime;artifacts=unknown",
    new AggregateError(failures, "LinkedIn stats browser finalization failed"),
    cleanupEvidence,
  );
}

export async function createLinkedInProfileBrowserTransport(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly publishCleanupResource?: WebSessionCleanupResourcePublisher;
    readonly dependencies?: Partial<LinkedInProfileBrowserDependencies>;
  },
): Promise<LinkedInProfileBrowserTransport> {
  if (
    !Number.isSafeInteger(options.maxOutputBytes)
    || options.maxOutputBytes < 1
    || options.maxOutputBytes > MAX_STATS_PAGE_BYTES
  ) throw new Error("LinkedIn stats browser output bound is invalid");
  const createSession = options.dependencies?.createBrowserSession
    ?? createBrowserSession;
  const browserOutputBytes = encodedBodyBound(options.maxOutputBytes)
    + BROWSER_ENVELOPE_BYTES;
  const sessionOptions: CreateBrowserSessionOptions = {
    allowCodeOwnedEvaluation: true,
    headed: true,
    maxOutputBytes: browserOutputBytes,
    timeoutMs: options.timeoutMs,
    dependencies: {
      runCommand: linkedInProfileBrowserCommandRunner(
        options.dependencies?.runCommand ?? runCommand,
        options.dependencies?.settleContext ?? settleLinkedInBrowserContext,
      ),
    },
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.publishCleanupResource === undefined
      ? {}
      : { publishCleanupResource: options.publishCleanupResource }),
  };
  const session = await createSession(profileBrowserManifest, auth, sessionOptions);
  let closed = false;
  let state: BrowserReadState = "ready";

  const remainingTimeMs = (): number =>
    options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs;
  const run = async (
    binding: BrowserReadBinding,
  ): Promise<Readonly<Record<string, unknown>>> => {
    if (closed) throw new Error("LinkedIn stats browser transport is closed");
    const source = browserReadEvaluationSource(binding);
    let records: readonly Readonly<Record<string, unknown>>[] | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        records = await session.runBatch(
          [["eval", source]],
          remainingTimeMs(),
          Math.min(
            encodedBodyBound(binding.maxBytes) + BROWSER_ENVELOPE_BYTES,
            browserOutputBytes,
          ),
        );
        break;
      } catch (error) {
        if (attempt !== 0 || !hasNoDefaultExecutionContext(error)) throw error;
        await session.runBatch(
          [["wait", "2000"]],
          Math.min(remainingTimeMs(), 5_000),
          BROWSER_ENVELOPE_BYTES,
        );
      }
    }
    const first = records?.[0];
    if (first === undefined) {
      throw new Error("LinkedIn stats browser omitted its response");
    }
    const result = browserEvaluationResult(first);
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
      "LinkedIn stats browser request",
    );
    if (result.status !== 200) {
      throw new Error("LinkedIn stats browser request returned an unreviewed status");
    }
    if (result.authWall !== false) {
      throw new Error("LinkedIn stats browser reached the signed-out authwall");
    }
    const expectedContentTypes = binding.kind === "json"
      ? ["application/vnd.linkedin.normalized+json+2.1", "application/json"]
      : ["text/html"];
    if (
      typeof result.contentType !== "string"
      || !expectedContentTypes.includes(result.contentType)
    ) throw new Error("LinkedIn stats browser request returned an unreviewed content type");
    return result;
  };

  try {
    await session.runBatch(
      [["open", LINKEDIN_BROWSER_REALM_URL]],
      remainingTimeMs(),
      BROWSER_ENVELOPE_BYTES,
    );
    await session.runBatch(
      [["wait", "2000"]],
      Math.min(remainingTimeMs(), 10_000),
      BROWSER_ENVELOPE_BYTES,
    );
  } catch (error) {
    try {
      await finalizeBrowserSession(session);
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }

  return Object.freeze({
    currentIdentityResponse: async () => {
      if (state !== "ready") {
        throw new Error("LinkedIn stats browser identity read is out of order");
      }
      const result = await run({
        kind: "json",
        maxBytes: Math.min(MAX_IDENTITY_BYTES, options.maxOutputBytes),
        path: "/voyager/api/me",
        referrer: LINKEDIN_FEED_URL,
      });
      state = "identity";
      const text = decodedBody(
        result,
        Math.min(MAX_IDENTITY_BYTES, options.maxOutputBytes),
      );
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("LinkedIn stats browser identity response was not valid JSON");
      }
    },
    readProfileHtml: async (profileUrl: string) => {
      if (state !== "identity") {
        throw new Error("LinkedIn stats browser profile read is out of order");
      }
      const target = exactLinkedInUrl(profileUrl, "profile");
      const result = await run({
        kind: "html",
        maxBytes: options.maxOutputBytes,
        path: target.pathname,
        referrer: LINKEDIN_FEED_URL,
      });
      state = "profile";
      return decodedBody(result, options.maxOutputBytes);
    },
    readConnectionsHtml: async (profileUrl: string) => {
      if (state !== "profile") {
        throw new Error("LinkedIn stats browser connections read is out of order");
      }
      const profile = exactLinkedInUrl(profileUrl, "profile");
      const result = await run({
        kind: "html",
        maxBytes: options.maxOutputBytes,
        path: new URL(LINKEDIN_CONNECTIONS_URL).pathname,
        referrer: profile.href,
      });
      state = "complete";
      return decodedBody(result, options.maxOutputBytes);
    },
    readOrganizationHtml: async (organizationUrl: string) => {
      if (state !== "identity") {
        throw new Error("LinkedIn stats browser organization read is out of order");
      }
      const target = exactLinkedInUrl(organizationUrl, "organization");
      const result = await run({
        kind: "html",
        maxBytes: options.maxOutputBytes,
        path: target.pathname,
        referrer: LINKEDIN_FEED_URL,
      });
      state = "complete";
      return decodedBody(result, options.maxOutputBytes);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await finalizeBrowserSession(session);
    },
  });
}
