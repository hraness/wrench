import type { ArticleDraftDocument } from "../article-draft-document";
import type { WrenchAuth } from "../auth";
import {
  PreservedBrowserArtifactsError,
  browserResultData,
  createBrowserSession,
  type BrowserSession,
  type CreateBrowserSessionOptions,
} from "../browser";
import { canonicalJson } from "../canonical-json";
import type { WrenchManifest } from "../model";
import type {
  WebSessionCleanupResourcePublisher,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  LINKEDIN_FIRST_PARTY_ARTICLES_PATH,
  buildLinkedInArticleContentPatch,
  buildLinkedInArticleCreateBody,
  buildLinkedInArticleTitlePatch,
  linkedInArticleDraftEntityUrl,
  linkedInArticleDraftId,
  linkedInArticleDraftReadUrl,
} from "./linkedin-web";

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const LINKEDIN_ARTICLE_NEW_URL = `${LINKEDIN_ORIGIN}/article/new/`;
const MAX_BROWSER_OUTPUT_BYTES = 2 * 1024 * 1024;

const articleBrowserManifest: WrenchManifest = Object.freeze({
  schemaVersion: 4,
  id: "linkedin-article-runtime",
  version: "1.0.0",
  displayName: "LinkedIn native Article runtime",
  surfaceId: "linkedin",
  origins: Object.freeze([LINKEDIN_ORIGIN]),
  browserDomains: Object.freeze(["www.linkedin.com", "static.licdn.com"]),
  operations: Object.freeze({}),
});

export type LinkedInArticleBrowserTransport = {
  readonly currentIdentityResponse: () => Promise<unknown>;
  readonly createDraft: (profileUrn: string, title: string) => Promise<string | null>;
  readonly readDraftResponse: (draftId: string) => Promise<unknown>;
  readonly updateTitle: (draftId: string, title: string) => Promise<void>;
  readonly updateContent: (
    draftId: string,
    document: ArticleDraftDocument,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type LinkedInArticleBrowserDependencies = {
  readonly createBrowserSession: typeof createBrowserSession;
};

type RequestBinding = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly referrer: string;
  readonly body: string | null;
  readonly partialUpdate: boolean;
  readonly response: "json" | "status" | "created";
};

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

function articleEditUrl(draftId: string): string {
  const id = linkedInArticleDraftId(draftId);
  return `${LINKEDIN_ORIGIN}/article/edit/${id}/`;
}

function exactRequestPath(url: URL): string {
  if (
    url.origin !== LINKEDIN_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) throw new Error("LinkedIn Article browser request escaped its reviewed origin");
  return `${url.pathname}${url.search}`;
}

function requestEvaluationSource(binding: RequestBinding): string {
  const bound = JSON.stringify(binding);
  return `(async()=>{const input=${bound};if(location.origin!=="${LINKEDIN_ORIGIN}")throw new Error("unexpected LinkedIn origin");const raw=document.cookie.split("; ").find((part)=>part.startsWith("JSESSIONID="));if(typeof raw!=="string")throw new Error("missing LinkedIn browser CSRF cookie");const csrf=decodeURIComponent(raw.slice("JSESSIONID=".length)).replace(/^\"|\"$/g,"");if(!/^ajax:[A-Za-z0-9_-]{1,512}$/.test(csrf))throw new Error("invalid LinkedIn browser CSRF cookie");const headers={accept:"application/vnd.linkedin.normalized+json+2.1","csrf-token":csrf,"x-li-lang":"en_US","x-requested-with":"XMLHttpRequest","x-restli-protocol-version":"2.0.0"};if(input.body!==null)headers["content-type"]="application/json; charset=UTF-8";if(input.partialUpdate)headers["x-restli-method"]="PARTIAL_UPDATE";const response=await fetch(input.path,{body:input.body===null?undefined:input.body,credentials:"include",headers,method:input.method,redirect:"error",referrer:input.referrer});const contentType=(response.headers.get("content-type")||"").split(";",1)[0].trim().toLowerCase();if(input.response==="json"){let body=null;if(response.status===200&&(contentType==="application/vnd.linkedin.normalized+json+2.1"||contentType==="application/json"))body=await response.json();return{body,contentType,status:response.status}}if(input.response==="created")return{contentType,responseId:response.headers.get("x-restli-id"),status:response.status};return{contentType,status:response.status}})()`;
}

function evaluationResult(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const data = browserResultData(record);
  if (!isRecord(data) || typeof data.origin !== "string" || !isRecord(data.result)) {
    throw new Error("LinkedIn Article browser returned a malformed evaluation envelope");
  }
  let origin: URL;
  try {
    origin = new URL(data.origin);
  } catch {
    throw new Error("LinkedIn Article browser returned a malformed evaluation envelope");
  }
  if (
    origin.origin !== LINKEDIN_ORIGIN
    || origin.username !== ""
    || origin.password !== ""
  ) throw new Error("LinkedIn Article browser returned a malformed evaluation envelope");
  return data.result;
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
    "LinkedIn Article browser finalization failed; private artifacts were preserved",
    session.recoveryHandle ?? "session=linkedin-article-runtime;artifacts=unknown",
    new AggregateError(failures, "LinkedIn Article browser finalization failed"),
    cleanupEvidence,
  );
}

export async function createLinkedInArticleBrowserTransport(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly publishCleanupResource?: WebSessionCleanupResourcePublisher;
    readonly dependencies?: Partial<LinkedInArticleBrowserDependencies>;
  },
): Promise<LinkedInArticleBrowserTransport> {
  const createSession = options.dependencies?.createBrowserSession ?? createBrowserSession;
  const sessionOptions: CreateBrowserSessionOptions = {
    allowCodeOwnedEvaluation: true,
    headed: true,
    maxOutputBytes: MAX_BROWSER_OUTPUT_BYTES,
    timeoutMs: options.timeoutMs,
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.publishCleanupResource === undefined
      ? {}
      : { publishCleanupResource: options.publishCleanupResource }),
  };
  const session = await createSession(articleBrowserManifest, auth, sessionOptions);
  let closed = false;
  const run = async (binding: RequestBinding): Promise<Readonly<Record<string, unknown>>> => {
    if (closed) throw new Error("LinkedIn Article browser transport is closed");
    const records = await session.runBatch(
      [["eval", requestEvaluationSource(binding)]],
      options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs,
      MAX_BROWSER_OUTPUT_BYTES,
    );
    const first = records[0];
    if (first === undefined) throw new Error("LinkedIn Article browser omitted its response");
    return evaluationResult(first);
  };

  try {
    await session.runBatch(
      [["open", `${LINKEDIN_ORIGIN}/feed/`]],
      options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs,
      MAX_BROWSER_OUTPUT_BYTES,
    );
  } catch (error) {
    try {
      await finalizeBrowserSession(session);
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }

  const transport: LinkedInArticleBrowserTransport = {
    currentIdentityResponse: async () => {
      const result = await run({
        method: "GET",
        path: "/voyager/api/me",
        referrer: `${LINKEDIN_ORIGIN}/feed/`,
        body: null,
        partialUpdate: false,
        response: "json",
      });
      exactKeys(result, ["body", "contentType", "status"], "LinkedIn current-member browser request");
      if (
        result.status !== 200
        || (result.contentType !== "application/vnd.linkedin.normalized+json+2.1"
          && result.contentType !== "application/json")
      ) throw new Error("LinkedIn current-member browser request returned an unreviewed response");
      return result.body;
    },
    createDraft: async (profileUrn, title) => {
      const result = await run({
        method: "POST",
        path: `${LINKEDIN_FIRST_PARTY_ARTICLES_PATH}/`,
        referrer: LINKEDIN_ARTICLE_NEW_URL,
        body: canonicalJson(buildLinkedInArticleCreateBody(profileUrn, title)),
        partialUpdate: false,
        response: "created",
      });
      exactKeys(result, ["contentType", "responseId", "status"], "LinkedIn Article create browser request");
      if (result.status !== 201) {
        throw new Error("LinkedIn Article create browser request returned an unreviewed response");
      }
      if (result.responseId !== null && typeof result.responseId !== "string") {
        throw new Error("LinkedIn Article create browser response returned an invalid identifier");
      }
      return result.responseId as string | null;
    },
    readDraftResponse: async (draftId) => {
      const result = await run({
        method: "GET",
        path: exactRequestPath(linkedInArticleDraftReadUrl(draftId)),
        referrer: articleEditUrl(draftId),
        body: null,
        partialUpdate: false,
        response: "json",
      });
      exactKeys(result, ["body", "contentType", "status"], "LinkedIn Article readback browser request");
      if (
        result.status !== 200
        || (result.contentType !== "application/vnd.linkedin.normalized+json+2.1"
          && result.contentType !== "application/json")
      ) throw new Error("LinkedIn Article readback browser request returned an unreviewed response");
      return result.body;
    },
    updateTitle: async (draftId, title) => {
      const result = await run({
        method: "POST",
        path: exactRequestPath(linkedInArticleDraftEntityUrl(draftId)),
        referrer: articleEditUrl(draftId),
        body: canonicalJson(buildLinkedInArticleTitlePatch(title)),
        partialUpdate: true,
        response: "status",
      });
      exactKeys(result, ["contentType", "status"], "LinkedIn Article title browser request");
      if (result.status !== 200) {
        throw new Error("LinkedIn Article title browser request returned an unreviewed response");
      }
    },
    updateContent: async (draftId, document) => {
      const result = await run({
        method: "POST",
        path: exactRequestPath(linkedInArticleDraftEntityUrl(draftId)),
        referrer: articleEditUrl(draftId),
        body: canonicalJson(buildLinkedInArticleContentPatch(document)),
        partialUpdate: true,
        response: "status",
      });
      exactKeys(result, ["contentType", "status"], "LinkedIn Article content browser request");
      if (result.status !== 200) {
        throw new Error("LinkedIn Article content browser request returned an unreviewed response");
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await finalizeBrowserSession(session);
    },
  };
  return Object.freeze(transport);
}
