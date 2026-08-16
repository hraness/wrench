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
  LINKEDIN_ARTICLE_PAGE_MAX_CHARACTERS,
  LINKEDIN_FIRST_PARTY_ARTICLES_PATH,
  buildLinkedInArticleContentPatch,
  buildLinkedInArticleCreateBody,
  buildLinkedInArticleTitlePatch,
  linkedInArticleDraftEditUrl,
  linkedInArticleDraftEnvelopeFromCodePayloads,
  linkedInArticleDraftEntityUrl,
} from "./linkedin-web";

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const LINKEDIN_ARTICLE_NEW_URL = `${LINKEDIN_ORIGIN}/article/new/`;
const LINKEDIN_ARTICLE_AUTOSAVE_PEM_METADATA =
  "Voyager - Article Creator=autosave-article";
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
  readonly prepareCreateDraft: () => Promise<void>;
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
  readonly pageInstance: string | null;
  readonly track: string | null;
  readonly response: "json" | "status" | "created" | "page";
};

type LinkedInArticlePageBindings = {
  readonly pageInstance: string;
  readonly track: string;
};

const LINKEDIN_PAGE_INSTANCE_PATTERN =
  /^urn:li:page:[A-Za-z0-9_:-]{1,128};[A-Za-z0-9+/=_-]{1,512}$/u;

function linkedInPageInstance(value: unknown): string {
  if (typeof value !== "string" || !LINKEDIN_PAGE_INSTANCE_PATTERN.test(value)) {
    throw new Error("LinkedIn Article page omitted its bounded page-instance binding");
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} changed its reviewed bound`);
  return value;
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

function linkedInArticleTrack(value: unknown): string {
  const track = boundedString(value, "LinkedIn Article x-li-track binding", 4_096);
  let parsed: unknown;
  try {
    parsed = JSON.parse(track) as unknown;
  } catch {
    throw new Error("LinkedIn Article x-li-track binding changed shape");
  }
  if (!isRecord(parsed)) {
    throw new Error("LinkedIn Article x-li-track binding changed shape");
  }
  exactKeys(parsed, [
    "clientVersion",
    "deviceFormFactor",
    "displayDensity",
    "displayHeight",
    "displayWidth",
    "mpName",
    "mpVersion",
    "osName",
    "timezone",
    "timezoneOffset",
  ], "LinkedIn Article x-li-track binding");
  const clientVersion = boundedString(
    parsed.clientVersion,
    "LinkedIn Article x-li-track clientVersion",
    64,
  );
  if (!/^[0-9]+(?:\.[0-9]+){1,7}$/u.test(clientVersion) || parsed.mpVersion !== clientVersion) {
    throw new Error("LinkedIn Article x-li-track version changed shape");
  }
  boundedString(parsed.osName, "LinkedIn Article x-li-track osName", 32);
  const timezone = boundedString(
    parsed.timezone,
    "LinkedIn Article x-li-track timezone",
    128,
  );
  if (!/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)+$/u.test(timezone)) {
    throw new Error("LinkedIn Article x-li-track timezone changed shape");
  }
  if (parsed.deviceFormFactor !== "DESKTOP" || parsed.mpName !== "voyager-web") {
    throw new Error("LinkedIn Article x-li-track client binding changed shape");
  }
  if (
    !Number.isInteger(parsed.timezoneOffset)
    || (parsed.timezoneOffset as number) < -24
    || (parsed.timezoneOffset as number) > 24
    || typeof parsed.displayDensity !== "number"
    || !Number.isFinite(parsed.displayDensity)
    || parsed.displayDensity < 0.5
    || parsed.displayDensity > 10
    || !Number.isInteger(parsed.displayWidth)
    || (parsed.displayWidth as number) < 1
    || (parsed.displayWidth as number) > 20_000
    || !Number.isInteger(parsed.displayHeight)
    || (parsed.displayHeight as number) < 1
    || (parsed.displayHeight as number) > 20_000
  ) throw new Error("LinkedIn Article x-li-track display binding changed shape");
  return track;
}

function linkedInArticlePageBindings(
  value: unknown,
  expectedPageName: "d_flagship3_publishing_post_new" | "d_flagship3_publishing_post_edit",
): LinkedInArticlePageBindings {
  if (!isRecord(value) || !Array.isArray(value.requests) || value.requests.length > 10_000) {
    throw new Error("LinkedIn Article network observation changed shape");
  }
  let selected: LinkedInArticlePageBindings | null = null;
  for (const item of value.requests) {
    if (!isRecord(item) || !isRecord(item.headers)) continue;
    if (
      item.method !== "GET"
      || item.status !== 200
      || typeof item.url !== "string"
      || item.url.length > 64 * 1_024
    ) continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (
      url.origin !== LINKEDIN_ORIGIN
      || url.username !== ""
      || url.password !== ""
      || !url.pathname.startsWith("/voyager/api/")
    ) continue;
    const pageInstanceValue = item.headers["x-li-page-instance"];
    if (typeof pageInstanceValue !== "string") continue;
    const name = /^urn:li:page:([A-Za-z0-9_:-]{1,128});/u.exec(pageInstanceValue)?.[1];
    if (name !== expectedPageName) continue;
    const candidate = Object.freeze({
      pageInstance: linkedInPageInstance(pageInstanceValue),
      track: linkedInArticleTrack(item.headers["x-li-track"]),
    });
    if (
      selected !== null
      && (selected.pageInstance !== candidate.pageInstance || selected.track !== candidate.track)
    ) throw new Error("LinkedIn Article page binding was ambiguous");
    selected = candidate;
  }
  if (selected === null) {
    throw new Error("LinkedIn Article page omitted its bounded page-instance binding");
  }
  return selected;
}

function articleReadbackResponseCategory(
  status: unknown,
  contentType: unknown,
  body: unknown,
): string {
  const bodyShape = isRecord(body)
    ? `:${Object.keys(body).sort().join("+") || "empty"}`
    : typeof contentType === "string" && contentType.includes("json")
      ? ":json-error"
      : typeof contentType === "string" && contentType.startsWith("text/")
        ? ":text-error"
        : ":opaque-error";
  if (status === 401 || status === 403) return "session-rejected";
  if (status === 400 || status === 422) return `request-rejected-${status}${bodyShape}`;
  if (status === 404) return "contract-route-not-found";
  if (status === 410) return "contract-route-retired";
  if (status === 409) return "provider-conflict";
  if (status === 429) return "provider-throttled";
  if (typeof status === "number" && status >= 500) return "provider-unavailable";
  if (status !== 200) return "status-drift";
  if (
    contentType !== "application/vnd.linkedin.normalized+json+2.1"
    && contentType !== "application/json"
  ) return "content-type-drift";
  return "response-drift";
}

function articleEditUrl(draftId: string): string {
  return linkedInArticleDraftEditUrl(draftId).href;
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
  return `(async()=>{const input=${bound};if(location.origin!=="${LINKEDIN_ORIGIN}")throw new Error("unexpected LinkedIn origin");const raw=document.cookie.split("; ").find((part)=>part.startsWith("JSESSIONID="));if(typeof raw!=="string")throw new Error("missing LinkedIn browser CSRF cookie");const csrf=decodeURIComponent(raw.slice("JSESSIONID=".length)).replace(/^\"|\"$/g,"");if(!/^ajax:[A-Za-z0-9_-]{1,512}$/.test(csrf))throw new Error("invalid LinkedIn browser CSRF cookie");const headers=input.response==="page"?{accept:"text/html"}:{accept:"application/vnd.linkedin.normalized+json+2.1","csrf-token":csrf,"x-li-lang":"en_US","x-restli-protocol-version":"2.0.0"};if(input.body!==null){if(!/^urn:li:page:[A-Za-z0-9_:-]{1,128};[A-Za-z0-9+/=_-]{1,512}$/.test(input.pageInstance||""))throw new Error("missing LinkedIn browser page instance");if(typeof input.track!=="string"||input.track.length<1||input.track.length>4096||/[\\0\\r\\n]/u.test(input.track))throw new Error("missing LinkedIn browser track binding");headers["x-li-page-instance"]=input.pageInstance;headers["x-li-pem-metadata"]="${LINKEDIN_ARTICLE_AUTOSAVE_PEM_METADATA}";headers["x-li-track"]=input.track;headers["content-type"]="application/json; charset=UTF-8"}const response=await fetch(input.path,{body:input.body===null?undefined:input.body,credentials:"include",headers,method:input.method,redirect:"error",referrer:input.referrer});const contentType=(response.headers.get("content-type")||"").split(";",1)[0].trim().toLowerCase();if(input.response==="page"){const payloads=[];if(response.status===200&&contentType==="text/html"){if(response.body===null)throw new Error("missing LinkedIn Article page body");const reader=response.body.getReader();const decoder=new TextDecoder();const chunks=[];let bytes=0;while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>${LINKEDIN_ARTICLE_PAGE_MAX_CHARACTERS}){await reader.cancel();throw new Error("LinkedIn Article page exceeded its reviewed bound")}chunks.push(decoder.decode(part.value,{stream:true}))}chunks.push(decoder.decode());const html=chunks.join("");const id=new RegExp("^/article/edit/([0-9]{1,32})/$","u").exec(input.path)?.[1];if(typeof id!=="string")throw new Error("invalid LinkedIn Article page path");const urn="urn:li:fsd_firstPartyArticle:"+id;for(const match of html.matchAll(/<code\\b([^>]*)>([\\s\\S]*?)<\\/code>/giu)){const attributes=match[1]||"";const body=match[2]||"";if(!body.includes(urn))continue;payloads.push({attributes,body});if(payloads.length>20)throw new Error("LinkedIn Article page returned too many matching payloads")}}return{contentType,payloads,status:response.status}}if(input.response==="json"){let body=null;if(contentType==="application/vnd.linkedin.normalized+json+2.1"||contentType==="application/json")body=await response.json();return{body,contentType,status:response.status}}if(input.response==="created")return{contentType,responseId:response.headers.get("x-restli-id"),status:response.status};return{contentType,status:response.status}})()`;
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
    allowCodeOwnedNetworkObservation: true,
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
  let articleBindings: LinkedInArticlePageBindings | null = null;
  let activeEditor: { readonly kind: "new" } | { readonly kind: "edit"; readonly draftId: string } | null = null;
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
  const open = async (url: URL): Promise<void> => {
    if (
      url.origin !== LINKEDIN_ORIGIN
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) throw new Error("LinkedIn Article browser navigation escaped its reviewed origin");
    await session.runBatch(
      [["open", url.href]],
      options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs,
      MAX_BROWSER_OUTPUT_BYTES,
    );
  };
  const openEditor = async (
    url: URL,
    expectedPageName: "d_flagship3_publishing_post_new" | "d_flagship3_publishing_post_edit",
    editor: { readonly kind: "new" } | { readonly kind: "edit"; readonly draftId: string },
  ): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await open(url);
        await session.runBatch(
          [["wait", "5000"]],
          Math.min(options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs, 20_000),
          MAX_BROWSER_OUTPUT_BYTES,
        );
        const records = await session.runBatch(
          [["network", "requests", "--filter", "/voyager/api/"]],
          Math.min(options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs, 30_000),
          MAX_BROWSER_OUTPUT_BYTES,
        );
        const first = records[0];
        if (first === undefined) {
          throw new Error("LinkedIn Article page-binding observation omitted its response");
        }
        articleBindings = linkedInArticlePageBindings(
          browserResultData(first),
          expectedPageName,
        );
        activeEditor = editor;
        return;
      } catch (error) {
        articleBindings = null;
        activeEditor = null;
        if (attempt === 1) throw error;
      }
    }
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
        pageInstance: null,
        track: null,
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
    prepareCreateDraft: () => openEditor(
      new URL(LINKEDIN_ARTICLE_NEW_URL),
      "d_flagship3_publishing_post_new",
      Object.freeze({ kind: "new" }),
    ),
    createDraft: async (profileUrn, title) => {
      if (activeEditor?.kind !== "new" || articleBindings === null) {
        throw new Error("LinkedIn Article create omitted its exact editor binding");
      }
      const result = await run({
        method: "POST",
        path: `${LINKEDIN_FIRST_PARTY_ARTICLES_PATH}/`,
        referrer: LINKEDIN_ARTICLE_NEW_URL,
        body: canonicalJson(buildLinkedInArticleCreateBody(profileUrn, title)),
        pageInstance: articleBindings.pageInstance,
        track: articleBindings.track,
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
      const editUrl = linkedInArticleDraftEditUrl(draftId);
      if (activeEditor?.kind !== "edit" || activeEditor.draftId !== draftId) {
        await openEditor(
          editUrl,
          "d_flagship3_publishing_post_edit",
          Object.freeze({ kind: "edit", draftId }),
        );
      }
      const result = await run({
        method: "GET",
        path: exactRequestPath(editUrl),
        referrer: editUrl.href,
        body: null,
        pageInstance: null,
        track: null,
        response: "page",
      });
      exactKeys(
        result,
        ["contentType", "payloads", "status"],
        "LinkedIn Article readback browser request",
      );
      if (result.status !== 200 || result.contentType !== "text/html") {
        throw new Error(
          `LinkedIn Article readback browser request returned an unreviewed response (${articleReadbackResponseCategory(result.status, result.contentType, null)})`,
        );
      }
      return linkedInArticleDraftEnvelopeFromCodePayloads(
        result.payloads,
        draftId,
      );
    },
    updateTitle: async (draftId, title) => {
      if (
        activeEditor?.kind !== "edit"
        || activeEditor.draftId !== draftId
        || articleBindings === null
      ) throw new Error("LinkedIn Article title update omitted its exact editor binding");
      const result = await run({
        method: "POST",
        path: exactRequestPath(linkedInArticleDraftEntityUrl(draftId)),
        referrer: articleEditUrl(draftId),
        body: canonicalJson(buildLinkedInArticleTitlePatch(title)),
        pageInstance: articleBindings.pageInstance,
        track: articleBindings.track,
        response: "status",
      });
      exactKeys(result, ["contentType", "status"], "LinkedIn Article title browser request");
      if (result.status !== 200) {
        throw new Error(
          `LinkedIn Article title browser request returned an unreviewed response (${articleReadbackResponseCategory(result.status, result.contentType, null)})`,
        );
      }
    },
    updateContent: async (draftId, document) => {
      if (
        activeEditor?.kind !== "edit"
        || activeEditor.draftId !== draftId
        || articleBindings === null
      ) throw new Error("LinkedIn Article content update omitted its exact editor binding");
      const result = await run({
        method: "POST",
        path: exactRequestPath(linkedInArticleDraftEntityUrl(draftId)),
        referrer: articleEditUrl(draftId),
        body: canonicalJson(buildLinkedInArticleContentPatch(document)),
        pageInstance: articleBindings.pageInstance,
        track: articleBindings.track,
        response: "status",
      });
      exactKeys(result, ["contentType", "status"], "LinkedIn Article content browser request");
      if (result.status !== 200) {
        throw new Error(
          `LinkedIn Article content browser request returned an unreviewed response (${articleReadbackResponseCategory(result.status, result.contentType, null)})`,
        );
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
