import { createHash } from "node:crypto";

import type { WrenchAuth } from "../auth";
import {
  PreservedBrowserArtifactsError,
  browserResultData,
  createBrowserSession,
  runCommand,
  type BrowserSession,
  type CreateBrowserSessionOptions,
} from "../browser";
import type { WrenchManifest } from "../model";
import type {
  WebSessionCleanupResourcePublisher,
  WebSessionOperationDeadline,
} from "../web-session-execution";

const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const INSTAGRAM_ROOT_URL = `${INSTAGRAM_ORIGIN}/`;
const INSTAGRAM_PRE_COOKIE_REALM_URL = `${INSTAGRAM_ORIGIN}/robots.txt`;
const INSTAGRAM_INITIAL_ROOT_BATCH = JSON.stringify([
  ["open", INSTAGRAM_ORIGIN],
]);
const INSTAGRAM_INITIAL_BLANK_BATCH = JSON.stringify([
  ["open", "about:blank"],
]);
const INSTAGRAM_INITIAL_REALM_BATCH = JSON.stringify([
  ["open", INSTAGRAM_PRE_COOKIE_REALM_URL],
]);
const INSTAGRAM_PROFILE_ROUTE = "/api/v1/users/web_profile_info/";
const INSTAGRAM_WEB_APP_ID = "936619743392459";
const MAX_VIEWER_HTML_BYTES = 12 * 1024 * 1024;
const MAX_PROFILE_JSON_BYTES = 8 * 1024 * 1024;
const BROWSER_ENVELOPE_BYTES = 64 * 1024;

const profileBrowserManifest: WrenchManifest = Object.freeze({
  schemaVersion: 4,
  id: "instagram-profile-runtime",
  version: "1.0.0",
  displayName: "Instagram profile stats runtime",
  surfaceId: "instagram",
  origins: Object.freeze([INSTAGRAM_ORIGIN]),
  browserDomains: Object.freeze(["www.instagram.com"]),
  operations: Object.freeze({}),
});

export type InstagramProfileBrowserTransport = {
  readonly readCurrentViewerHtml: () => Promise<string>;
  readonly readProfileJson: (profile: string) => Promise<unknown>;
  readonly close: () => Promise<void>;
};

export type InstagramProfileBrowserDependencies = {
  readonly createBrowserSession: typeof createBrowserSession;
  readonly runCommand: typeof runCommand;
};

type BrowserReadBinding = {
  readonly kind: "html" | "json";
  readonly maxBytes: number;
  readonly path: string;
  readonly referrer: string;
};

type BrowserReadState =
  | "ready"
  | "viewer-pending"
  | "viewer"
  | "profile-pending"
  | "complete";

const INSTAGRAM_RESPONSE_MEDIA_TYPE =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

export type InstagramProfileBrowserFailureCategory =
  | "authwall"
  | "body-envelope"
  | "bootstrap"
  | "browser-envelope"
  | "browser-command"
  | "execution-context"
  | "output-bound"
  | "profile-json"
  | "provider-fetch"
  | "response-envelope"
  | "response-rejected"
  | "startup";

export class InstagramProfileBrowserFailure extends Error {
  readonly category: InstagramProfileBrowserFailureCategory;

  constructor(category: InstagramProfileBrowserFailureCategory, message: string) {
    super(message);
    this.name = "InstagramProfileBrowserFailure";
    this.category = category;
  }
}

export class InstagramProfileBrowserResponseRejectedError
  extends InstagramProfileBrowserFailure {
  readonly status: number;
  readonly contentType: string;

  constructor(status: number, contentType: string) {
    super(
      "response-rejected",
      "Instagram profile browser request returned a reviewed rejection",
    );
    this.name = "InstagramProfileBrowserResponseRejectedError";
    if (
      !Number.isSafeInteger(status)
      || status < 100
      || status > 599
      || contentType.length > 128
      || (contentType !== "" && !INSTAGRAM_RESPONSE_MEDIA_TYPE.test(contentType))
    ) throw new Error(
      "Instagram profile browser returned a malformed response category",
    );
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

function exactInstagramProfile(value: string): string {
  if (!/^[a-z0-9._]{1,30}$/u.test(value)) {
    throw new Error(
      "Instagram profile browser target must be one canonical lowercase handle",
    );
  }
  return value;
}

function profilePath(profile: string): string {
  const url = new URL(INSTAGRAM_PROFILE_ROUTE, INSTAGRAM_ORIGIN);
  url.searchParams.set("username", profile);
  return `${url.pathname}${url.search}`;
}

function browserReadEvaluationSource(binding: BrowserReadBinding): string {
  const bound = JSON.stringify(binding);
  return `(async()=>{const input=${bound};if(location.origin!=="${INSTAGRAM_ORIGIN}")throw new Error("unexpected Instagram origin");if((input.kind!=="json"&&input.kind!=="html")||!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1||input.maxBytes>${MAX_VIEWER_HTML_BYTES})throw new Error("invalid Instagram profile browser request binding");const expected=new URL(input.path,"${INSTAGRAM_ORIGIN}");if(expected.origin!=="${INSTAGRAM_ORIGIN}"||expected.username!==""||expected.password!==""||expected.hash!==""||expected.href!=="${INSTAGRAM_ORIGIN}"+input.path)throw new Error("invalid Instagram profile browser path binding");if(input.kind==="html"){if(expected.pathname!=="/"||expected.search!==""||input.referrer!=="${INSTAGRAM_ROOT_URL}")throw new Error("Instagram viewer browser request escaped its exact route")}else{const names=[...expected.searchParams.keys()];const profile=expected.searchParams.get("username");if(expected.pathname!=="${INSTAGRAM_PROFILE_ROUTE}"||names.length!==1||names[0]!=="username"||typeof profile!=="string"||!/^[a-z0-9._]{1,30}$/.test(profile)||expected.search!=="?username="+encodeURIComponent(profile)||input.referrer!=="${INSTAGRAM_ORIGIN}/"+profile+"/")throw new Error("Instagram profile browser request escaped its exact route")}const headers=input.kind==="json"?{accept:"application/json, text/plain, */*","x-ig-app-id":"${INSTAGRAM_WEB_APP_ID}","x-requested-with":"XMLHttpRequest"}:{accept:"text/html,application/xhtml+xml"};const response=await fetch(input.path,{cache:"no-store",credentials:"include",headers,method:"GET",redirect:"error",referrer:input.referrer,referrerPolicy:"same-origin"});const responseUrl=new URL(response.url);if(responseUrl.origin!=="${INSTAGRAM_ORIGIN}"||responseUrl.username!==""||responseUrl.password!==""||responseUrl.hash!==""||responseUrl.href!==expected.href)throw new Error("Instagram profile browser response escaped its exact route");const contentType=(response.headers.get("content-type")||"").split(";",1)[0].trim().toLowerCase();const contentTypeAllowed=input.kind==="json"?contentType==="application/json":contentType==="text/html";if(response.status!==200||!contentTypeAllowed){response.body?.cancel();return{authWall:false,bodyBase64:null,bodyBytes:0,bodySha256:null,contentType,status:response.status}}if(response.body===null)throw new Error("Instagram profile browser response omitted its body");const reader=response.body.getReader();const chunks=[];let bytes=0;while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>input.maxBytes){await reader.cancel();throw new Error("Instagram profile browser response exceeded its reviewed byte bound")}chunks.push(part.value)}const body=new Uint8Array(bytes);let cursor=0;for(const chunk of chunks){body.set(chunk,cursor);cursor+=chunk.byteLength}const text=new TextDecoder("utf-8",{fatal:true}).decode(body);const authWall=input.kind==="html"&&/<form[^>]+(?:login|sign-in)|href=["']\\/accounts\\/login\\/?["']/iu.test(text);if(authWall)return{authWall:true,bodyBase64:null,bodyBytes:0,bodySha256:null,contentType,status:response.status};const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",body)),(value)=>value.toString(16).padStart(2,"0")).join("");let binary="";for(let offset=0;offset<body.length;offset+=32768)binary+=String.fromCharCode(...body.subarray(offset,Math.min(offset+32768,body.length)));return{authWall:false,bodyBase64:btoa(binary),bodyBytes:body.byteLength,bodySha256:digest,contentType,status:response.status}})()`;
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
  ) throw new InstagramProfileBrowserFailure(
    "body-envelope",
    "Instagram profile browser body envelope changed shape",
  );
  const bytes = Buffer.from(result.bodyBase64, "base64");
  if (
    bytes.byteLength !== result.bodyBytes
    || bytes.toString("base64") !== result.bodyBase64
    || createHash("sha256").update(bytes).digest("hex") !== result.bodySha256
  ) throw new InstagramProfileBrowserFailure(
    "body-envelope",
    "Instagram profile browser body envelope failed integrity verification",
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InstagramProfileBrowserFailure(
      "body-envelope",
      "Instagram profile browser body was not valid UTF-8",
    );
  }
}

function browserEvaluationResult(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const data = browserResultData(value as Record<string, unknown>);
  if (!isRecord(data) || typeof data.origin !== "string" || !isRecord(data.result)) {
    throw new InstagramProfileBrowserFailure(
      "response-envelope",
      "Instagram profile browser returned a malformed evaluation envelope",
    );
  }
  let origin: URL;
  try {
    origin = new URL(data.origin);
  } catch {
    throw new InstagramProfileBrowserFailure(
      "response-envelope",
      "Instagram profile browser returned a malformed evaluation envelope",
    );
  }
  if (
    origin.origin !== INSTAGRAM_ORIGIN
    || origin.username !== ""
    || origin.password !== ""
  ) throw new InstagramProfileBrowserFailure(
    "response-envelope",
    "Instagram profile browser returned a malformed evaluation envelope",
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

function hasUnexpectedInstagramOrigin(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (
      current instanceof Error
      && /(?:^|: )unexpected Instagram origin(?:$|[\r\n])/u.test(current.message)
    ) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function classifiedBrowserCommandFailure(
  error: unknown,
): InstagramProfileBrowserFailure {
  const message = error instanceof Error && error.message.length <= 1_500
    ? error.message
    : "";
  if (message.includes("Failed to fetch")) {
    return new InstagramProfileBrowserFailure(
      "provider-fetch",
      "Instagram profile browser could not complete its first-party fetch",
    );
  }
  if (
    message.endsWith("Instagram profile browser response escaped its exact route")
    || message.endsWith("Instagram profile browser request escaped its exact route")
    || message.endsWith("Instagram viewer browser request escaped its exact route")
  ) {
    return new InstagramProfileBrowserFailure(
      "response-envelope",
      "Instagram profile browser request escaped its exact route",
    );
  }
  if (
    message.includes("process output exceeded")
    || message.includes("response exceeded its reviewed byte bound")
  ) {
    return new InstagramProfileBrowserFailure(
      "output-bound",
      "Instagram profile browser exceeded a reviewed output bound",
    );
  }
  if (
    message.includes("malformed batch")
    || message.includes("malformed batch entry")
    || message.includes("did not return JSON")
    || message.includes("command omitted its result")
  ) {
    return new InstagramProfileBrowserFailure(
      "browser-envelope",
      "Instagram profile browser command returned a malformed envelope",
    );
  }
  return new InstagramProfileBrowserFailure(
    "browser-command",
    "Instagram profile browser command failed before a reviewed response",
  );
}

function instagramProfileBrowserCommandRunner(
  execute: typeof runCommand,
  authKind: WrenchAuth["kind"],
): typeof runCommand {
  let initialBatchPending = true;
  return (command, options) => {
    const rewroteInitialRoot = initialBatchPending
      && options.stdin === INSTAGRAM_INITIAL_ROOT_BATCH;
    const rewroteInitialBlank = initialBatchPending
      && authKind === "browser-profile"
      && options.stdin === INSTAGRAM_INITIAL_BLANK_BATCH;
    initialBatchPending = false;
    return execute(command, rewroteInitialRoot || rewroteInitialBlank
      ? { ...options, stdin: INSTAGRAM_INITIAL_REALM_BATCH }
      : options);
  };
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
    "Instagram profile browser finalization failed; private artifacts were preserved",
    session.recoveryHandle ?? "session=instagram-profile-runtime;artifacts=unknown",
    new AggregateError(failures, "Instagram profile browser finalization failed"),
    cleanupEvidence,
  );
}

function assertSupportedAuth(auth: WrenchAuth): void {
  if (
    auth.kind !== "cookie-source"
    && auth.kind !== "cookies-file"
    && auth.kind !== "browser-profile"
  ) throw new Error(
    "Instagram profile browser requires browser-session or cookie auth",
  );
}

export async function createInstagramProfileBrowserTransport(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly publishCleanupResource?: WebSessionCleanupResourcePublisher;
    readonly dependencies?: Partial<InstagramProfileBrowserDependencies>;
  },
): Promise<InstagramProfileBrowserTransport> {
  assertSupportedAuth(auth);
  if (
    !Number.isSafeInteger(options.maxOutputBytes)
    || options.maxOutputBytes < 1
    || options.maxOutputBytes > MAX_VIEWER_HTML_BYTES
  ) throw new Error("Instagram profile browser output bound is invalid");
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
      runCommand: instagramProfileBrowserCommandRunner(
        options.dependencies?.runCommand ?? runCommand,
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
    session = await createSession(profileBrowserManifest, auth, sessionOptions);
  } catch (error) {
    if (error instanceof PreservedBrowserArtifactsError) throw error;
    options.operationDeadline?.throwIfUnavailable(
      "Instagram profile browser startup",
    );
    throw new InstagramProfileBrowserFailure(
      "startup",
      "Instagram profile browser could not start its contained session",
    );
  }
  let closed = false;
  let state: BrowserReadState = "ready";

  const remainingTimeMs = (): number =>
    options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs;
  const run = async (
    binding: BrowserReadBinding,
  ): Promise<Readonly<Record<string, unknown>>> => {
    if (closed) throw new Error("Instagram profile browser transport is closed");
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
      if (error instanceof InstagramProfileBrowserFailure) throw error;
      options.operationDeadline?.throwIfUnavailable(
        "Instagram profile browser operation",
      );
      if (hasNoDefaultExecutionContext(error)) {
        throw new InstagramProfileBrowserFailure(
          "execution-context",
          "Instagram profile browser lost its reviewed execution context",
        );
      }
      if (hasUnexpectedInstagramOrigin(error)) {
        throw new InstagramProfileBrowserFailure(
          "bootstrap",
          "Instagram profile browser was not on its reviewed signed-in origin",
        );
      }
      throw classifiedBrowserCommandFailure(error);
    }
    const first = records[0];
    if (first === undefined) {
      throw new InstagramProfileBrowserFailure(
        "response-envelope",
        "Instagram profile browser omitted its response",
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
        "Instagram profile browser request",
      );
    } catch {
      throw new InstagramProfileBrowserFailure(
        "response-envelope",
        "Instagram profile browser request returned an unexpected result shape",
      );
    }
    const expectedContentType = binding.kind === "json"
      ? "application/json"
      : "text/html";
    if (
      typeof result.status !== "number"
      || !Number.isSafeInteger(result.status)
      || result.status < 100
      || result.status > 599
      || typeof result.contentType !== "string"
      || result.contentType.length > 128
      || (result.contentType !== ""
        && !INSTAGRAM_RESPONSE_MEDIA_TYPE.test(result.contentType))
    ) throw new InstagramProfileBrowserFailure(
      "response-envelope",
      "Instagram profile browser returned a malformed response category",
    );
    if (result.authWall === true) {
      if (
        binding.kind !== "html"
        || result.status !== 200
        || result.contentType !== "text/html"
        || result.bodyBase64 !== null
        || result.bodyBytes !== 0
        || result.bodySha256 !== null
      ) throw new InstagramProfileBrowserFailure(
        "response-envelope",
        "Instagram profile browser returned a malformed authwall envelope",
      );
      throw new InstagramProfileBrowserFailure(
        "authwall",
        "Instagram profile browser reached the signed-out authwall",
      );
    }
    if (result.authWall !== false) {
      throw new InstagramProfileBrowserFailure(
        "response-envelope",
        "Instagram profile browser returned a malformed authwall envelope",
      );
    }
    if (
      result.status !== 200
      || result.contentType !== expectedContentType
    ) {
      if (
        result.bodyBase64 !== null
        || result.bodyBytes !== 0
        || result.bodySha256 !== null
      ) throw new InstagramProfileBrowserFailure(
        "response-envelope",
        "Instagram profile browser returned a malformed rejection envelope",
      );
      throw new InstagramProfileBrowserResponseRejectedError(
        result.status,
        result.contentType,
      );
    }
    return result;
  };

  return Object.freeze({
    readCurrentViewerHtml: async () => {
      if (state !== "ready") {
        throw new Error("Instagram profile browser viewer read is out of order");
      }
      state = "viewer-pending";
      const maximumBytes = Math.min(
        MAX_VIEWER_HTML_BYTES,
        options.maxOutputBytes,
      );
      const result = await run({
        kind: "html",
        maxBytes: maximumBytes,
        path: "/",
        referrer: INSTAGRAM_ROOT_URL,
      });
      const html = decodedBody(result, maximumBytes);
      state = "viewer";
      return html;
    },
    readProfileJson: async (profileValue: string) => {
      if (state !== "viewer") {
        throw new Error("Instagram profile browser target read is out of order");
      }
      const profile = exactInstagramProfile(profileValue);
      state = "profile-pending";
      const maximumBytes = Math.min(
        MAX_PROFILE_JSON_BYTES,
        options.maxOutputBytes,
      );
      const result = await run({
        kind: "json",
        maxBytes: maximumBytes,
        path: profilePath(profile),
        referrer: `${INSTAGRAM_ORIGIN}/${profile}/`,
      });
      const text = decodedBody(result, maximumBytes);
      let output: unknown;
      try {
        output = JSON.parse(text) as unknown;
      } catch {
        throw new InstagramProfileBrowserFailure(
          "profile-json",
          "Instagram profile browser response was not valid JSON",
        );
      }
      state = "complete";
      return output;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await finalizeBrowserSession(session);
    },
  });
}
