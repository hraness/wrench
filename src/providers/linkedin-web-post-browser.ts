import { randomUUID } from "node:crypto";

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
  LINKEDIN_GRAPHQL_PATH,
  LINKEDIN_POST_CREATE_MUTATION_ID,
  LINKEDIN_POST_READBACK_QUERY_ID,
  linkedInPostEntityUrn,
  linkedInPostMediaUrn,
} from "./linkedin-web";

const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const LINKEDIN_FEED_URL = `${LINKEDIN_ORIGIN}/feed/`;
const LINKEDIN_IMAGE_REGISTRATION_PATH =
  "/voyager/api/voyagerVideoDashMediaUploadMetadata?action=upload";
const LINKEDIN_IMAGE_FINALIZATION_PATH =
  "/voyager/api/voyagerVideoDashMediaUploadMetadata?action=completeMultipartUpload";
const MAX_BROWSER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_STAGING_CHUNK_CHARACTERS = 48 * 1024;
const IMAGE_STAGING_COMMANDS_PER_BATCH = 32;
const MAX_IMAGE_STAGING_COMMAND_CHARACTERS = 64 * 1024;
const MAX_IMAGE_BASE64_CHARACTERS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGE_STAGING_CHUNKS = Math.ceil(
  MAX_IMAGE_BASE64_CHARACTERS / IMAGE_STAGING_CHUNK_CHARACTERS,
);

const postBrowserManifest: WrenchManifest = Object.freeze({
  schemaVersion: 4,
  id: "linkedin-post-runtime",
  version: "1.0.0",
  displayName: "LinkedIn native post runtime",
  surfaceId: "linkedin",
  origins: Object.freeze([LINKEDIN_ORIGIN]),
  browserDomains: Object.freeze(["www.linkedin.com", "static.licdn.com"]),
  operations: Object.freeze({}),
});

export type LinkedInPostBrowserTransport = {
  readonly currentIdentityResponse: () => Promise<unknown>;
  readonly uploadImage: (
    expectedSubject: string,
    image: Uint8Array,
  ) => Promise<string>;
  readonly createPost: (
    expectedSubject: string,
    expectedProfileUrn: string,
    variables: Readonly<Record<string, unknown>>,
    mediaUrn: string | null,
  ) => Promise<string>;
  readonly readPost: (
    expectedSubject: string,
    expectedProfileUrn: string,
    variables: Readonly<Record<string, unknown>>,
    mediaUrn: string | null,
    entityUrn: string,
  ) => Promise<unknown>;
  readonly close: () => Promise<void>;
};

export type LinkedInPostBrowserDependencies = {
  readonly createBrowserSession: typeof createBrowserSession;
};

export type LinkedInPostImageFailureStage =
  | "page image staging"
  | "image registration or upload response";

/**
 * Secret-free stage evidence for the preparatory image path. The underlying
 * contained-browser failure remains attached as a cause and is never copied
 * into a public run receipt.
 */
export class LinkedInPostImagePreparationError extends Error {
  readonly stage: LinkedInPostImageFailureStage;

  constructor(stage: LinkedInPostImageFailureStage, cause: unknown) {
    super(`LinkedIn post image preparation failed during ${stage}`, { cause });
    this.name = "LinkedInPostImagePreparationError";
    this.stage = stage;
  }
}

type LinkedInPostPageBindings = {
  readonly pageInstance: string;
  readonly track: string;
};

const LINKEDIN_PAGE_INSTANCE_PATTERN =
  /^urn:li:page:d_flagship3_[A-Za-z0-9_:-]{1,128};[A-Za-z0-9+/=_-]{1,512}$/u;

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

function boundedHeader(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} changed its reviewed bound`);
  return value;
}

function linkedInPostPageBindings(value: unknown): LinkedInPostPageBindings {
  if (!isRecord(value) || !Array.isArray(value.requests) || value.requests.length > 10_000) {
    throw new Error("LinkedIn post network observation changed shape");
  }
  let selected: LinkedInPostPageBindings | null = null;
  for (const item of value.requests) {
    if (!isRecord(item) || !isRecord(item.headers)) continue;
    if (
      item.method !== "GET"
      || item.status !== 200
      || typeof item.url !== "string"
      || item.url.length > 64 * 1024
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
    const pageInstance = item.headers["x-li-page-instance"];
    if (
      typeof pageInstance !== "string"
      || !LINKEDIN_PAGE_INSTANCE_PATTERN.test(pageInstance)
    ) continue;
    const track = boundedHeader(
      item.headers["x-li-track"],
      "LinkedIn post x-li-track binding",
      4_096,
    );
    let parsedTrack: unknown;
    try {
      parsedTrack = JSON.parse(track) as unknown;
    } catch {
      throw new Error("LinkedIn post x-li-track binding changed shape");
    }
    if (!isRecord(parsedTrack) || parsedTrack.mpName !== "voyager-web") {
      throw new Error("LinkedIn post x-li-track binding changed shape");
    }
    // The feed can rotate both tracking fields and its page-instance while it
    // settles. Network observations are ordered, so retain only the newest
    // fully validated same-origin request from this freshly opened page.
    selected = Object.freeze({ pageInstance, track });
  }
  if (selected === null) {
    throw new Error("LinkedIn post page omitted its bounded page-instance binding");
  }
  return selected;
}

function browserEvaluationResult(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const data = browserResultData(record as Record<string, unknown>);
  if (!isRecord(data) || typeof data.origin !== "string" || !isRecord(data.result)) {
    throw new Error("LinkedIn post browser returned a malformed evaluation envelope");
  }
  let origin: URL;
  try {
    origin = new URL(data.origin);
  } catch {
    throw new Error("LinkedIn post browser returned a malformed evaluation envelope");
  }
  if (origin.origin !== LINKEDIN_ORIGIN || origin.username !== "" || origin.password !== "") {
    throw new Error("LinkedIn post browser returned a malformed evaluation envelope");
  }
  return data.result;
}

function commonEvaluationPrelude(input: Readonly<Record<string, unknown>>): string {
  return `const input=${canonicalJson(input)};if(location.origin!=="${LINKEDIN_ORIGIN}")throw new Error("unexpected LinkedIn origin");const raw=document.cookie.split("; ").find((part)=>part.startsWith("JSESSIONID="));if(typeof raw!=="string")throw new Error("missing LinkedIn browser CSRF cookie");const csrf=decodeURIComponent(raw.slice("JSESSIONID=".length)).replace(/^\"|\"$/g,"");if(!/^ajax:[A-Za-z0-9_-]{1,512}$/.test(csrf))throw new Error("invalid LinkedIn browser CSRF cookie");const baseHeaders={accept:"application/vnd.linkedin.normalized+json+2.1","csrf-token":csrf,"x-li-lang":"en_US","x-requested-with":"XMLHttpRequest","x-restli-protocol-version":"2.0.0"};const jsonTypes=new Set(["application/graphql","application/json","application/vnd.linkedin.normalized+json+2.1"]);const jsonResponse=async(response,label)=>{const contentType=(response.headers.get("content-type")||"").split(";",1)[0].trim().toLowerCase();if(!jsonTypes.has(contentType))throw new Error(label+" content type changed");if(response.status<200||response.status>=300)throw new Error(label+" status changed");return response.json()};const requestJson=async(path,init,label)=>jsonResponse(await fetch(path,{credentials:"include",redirect:"error",referrer:"${LINKEDIN_FEED_URL}",...init}),label);const identity=async()=>requestJson("/voyager/api/me",{headers:baseHeaders,method:"GET"},"LinkedIn current member");const assertIdentity=(body)=>{if(!body||typeof body!=="object"||Array.isArray(body)||!body.data||typeof body.data!=="object"||Array.isArray(body.data))throw new Error("LinkedIn current member changed shape");const plain=typeof body.data.plainId==="string"?body.data.plainId:Number.isSafeInteger(body.data.plainId)?String(body.data.plainId):"";if("urn:li:fsd_profile:"+plain!==input.expectedSubject)throw new Error("LinkedIn current member changed before dispatch");if(input.expectedProfileUrn!==undefined){const mini=body.data["*miniProfile"]??body.data.miniProfile;const suffix=typeof mini==="string"?/^urn:li:fs_miniProfile:([A-Za-z0-9_-]{1,256})$/.exec(mini)?.[1]:undefined;if("urn:li:fsd_profile:"+suffix!==input.expectedProfileUrn)throw new Error("LinkedIn current profile changed before dispatch")}};`;
}

function identityEvaluationSource(): string {
  const input = Object.freeze({});
  return `(async()=>{${commonEvaluationPrelude(input)}const body=await identity();return{body,contentType:"application/vnd.linkedin.normalized+json+2.1",status:200}})()`;
}

type LinkedInPostImageStaging = {
  readonly key: string;
  readonly byteLength: number;
  readonly base64Length: number;
  readonly chunkCount: number;
};

function imageStagingInitializationSource(staging: LinkedInPostImageStaging): string {
  const input = Object.freeze({
    stagingKey: staging.key,
    expectedChunkCount: staging.chunkCount,
  });
  return `(async()=>{const input=${canonicalJson(input)};if(location.origin!=="${LINKEDIN_ORIGIN}")throw new Error("unexpected LinkedIn origin");if(!/^__wrenchLinkedInPostImage_[a-f0-9]{32}$/.test(input.stagingKey)||!Number.isSafeInteger(input.expectedChunkCount)||input.expectedChunkCount<1||input.expectedChunkCount>${MAX_IMAGE_STAGING_CHUNKS})throw new Error("LinkedIn image staging input changed shape");if(Object.hasOwn(globalThis,input.stagingKey))throw new Error("LinkedIn image staging key collision");Object.defineProperty(globalThis,input.stagingKey,{configurable:true,enumerable:false,value:[],writable:false});return{ready:true}})()`;
}

function imageStagingChunkSource(
  staging: LinkedInPostImageStaging,
  index: number,
  chunk: string,
): string {
  const input = Object.freeze({
    chunk,
    expectedChunkCount: staging.chunkCount,
    index,
    stagingKey: staging.key,
  });
  const source = `(async()=>{const input=${canonicalJson(input)};if(location.origin!=="${LINKEDIN_ORIGIN}")throw new Error("unexpected LinkedIn origin");const chunks=globalThis[input.stagingKey];if(!Array.isArray(chunks)||!Number.isSafeInteger(input.index)||input.index<0||input.index>=input.expectedChunkCount||input.expectedChunkCount<1||input.expectedChunkCount>${MAX_IMAGE_STAGING_CHUNKS}||chunks.length!==input.index)throw new Error("LinkedIn image staging order changed");if(typeof input.chunk!=="string"||input.chunk.length<1||input.chunk.length>${IMAGE_STAGING_CHUNK_CHARACTERS}||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.chunk))throw new Error("LinkedIn image staging chunk changed shape");chunks.push(input.chunk);return{staged:chunks.length}})()`;
  if (source.length > MAX_IMAGE_STAGING_COMMAND_CHARACTERS) {
    throw new Error("LinkedIn image staging command exceeded its reviewed bound");
  }
  return source;
}

function imageStagingCleanupSource(stagingKey: string): string {
  const input = Object.freeze({ stagingKey });
  return `(async()=>{const input=${canonicalJson(input)};if(location.origin!=="${LINKEDIN_ORIGIN}")throw new Error("unexpected LinkedIn origin");const removed=Object.hasOwn(globalThis,input.stagingKey);delete globalThis[input.stagingKey];return{removed}})()`;
}

function uploadEvaluationSource(
  bindings: LinkedInPostPageBindings,
  expectedSubject: string,
  staging: LinkedInPostImageStaging,
): string {
  if (
    staging.byteLength < 24
    || staging.byteLength > MAX_IMAGE_BYTES
    || staging.base64Length < 32
    || staging.base64Length > MAX_IMAGE_BASE64_CHARACTERS
    || staging.chunkCount < 1
    || staging.chunkCount > MAX_IMAGE_STAGING_CHUNKS
  ) {
    throw new Error("LinkedIn post image is outside the reviewed byte bound");
  }
  const input = Object.freeze({
    expectedSubject,
    expectedBase64Length: staging.base64Length,
    expectedByteLength: staging.byteLength,
    expectedChunkCount: staging.chunkCount,
    pageInstance: bindings.pageInstance,
    stagingKey: staging.key,
    track: bindings.track,
  });
  return `(async()=>{${commonEvaluationPrelude(input)}const chunks=globalThis[input.stagingKey];if(!Array.isArray(chunks)||chunks.length!==input.expectedChunkCount||chunks.length<1||chunks.length>${MAX_IMAGE_STAGING_CHUNKS})throw new Error("missing bounded LinkedIn image bytes");delete globalThis[input.stagingKey];if(Object.hasOwn(globalThis,input.stagingKey))throw new Error("LinkedIn image staging cleanup failed");let encoded="";for(let index=0;index<chunks.length;index+=1){const chunk=chunks[index];if(typeof chunk!=="string"||chunk.length<1||chunk.length>${IMAGE_STAGING_CHUNK_CHARACTERS}||!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk))throw new Error("invalid LinkedIn image bytes");encoded+=chunk;chunks[index]=""}if(encoded.length!==input.expectedBase64Length||encoded.length>${MAX_IMAGE_BASE64_CHARACTERS})throw new Error("LinkedIn image changed encoded size");const binary=atob(encoded);encoded="";if(binary.length!==input.expectedByteLength||binary.length<24||binary.length>${MAX_IMAGE_BYTES})throw new Error("LinkedIn image changed size");const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);const firstIdentity=await identity();assertIdentity(firstIdentity);const image=new Blob([bytes],{type:"image/png"});const mutationHeaders={...baseHeaders,"content-type":"application/json; charset=UTF-8","x-li-page-instance":input.pageInstance,"x-li-pem-metadata":"Voyager - Feed Images=register-vector-upload","x-li-track":input.track};const registrationBody=await requestJson("${LINKEDIN_IMAGE_REGISTRATION_PATH}",{body:JSON.stringify({fileSize:image.size,filename:"image.png",mediaUploadType:"IMAGE_SHARING"}),headers:mutationHeaders,method:"POST"},"LinkedIn image registration");const registrationEnvelope=registrationBody&&typeof registrationBody==="object"&&!Array.isArray(registrationBody)?registrationBody:null;if(registrationEnvelope===null)throw new Error("LinkedIn image registration changed shape");const registration=registrationEnvelope.data&&typeof registrationEnvelope.data==="object"&&!Array.isArray(registrationEnvelope.data)&&registrationEnvelope.data.value!==undefined?registrationEnvelope.data.value:registrationEnvelope.value!==undefined?registrationEnvelope.value:null;if(!registration||typeof registration!=="object"||Array.isArray(registration))throw new Error("LinkedIn image registration omitted its value");const allowedKeys=new Set(["mediaArtifactUrn","multipartMetadata","partUploadRequests","recipes","singleUploadHeaders","singleUploadUrl","type","urn"]);for(const key of Object.keys(registration))if(!allowedKeys.has(key))throw new Error("LinkedIn image registration returned an unreviewed field");if(!/^urn:li:(?:digitalmediaAsset|fsd_image):[A-Za-z0-9_(),.:%=-]{1,448}$/.test(registration.urn||""))throw new Error("LinkedIn image registration omitted its media URN");if(typeof registration.mediaArtifactUrn!=="string"||registration.mediaArtifactUrn.length<1||registration.mediaArtifactUrn.length>1024)throw new Error("LinkedIn image registration omitted its artifact URN");const checkedUrl=(value)=>{if(typeof value!=="string"||value.length<1||value.length>16384)throw new Error("LinkedIn image upload target changed shape");const url=new URL(value);if(url.protocol!=="https:"||url.username!==""||url.password!==""||url.hash!==""||url.port!==""||!(url.hostname==="linkedin.com"||url.hostname.endsWith(".linkedin.com")||url.hostname==="licdn.com"||url.hostname.endsWith(".licdn.com")))throw new Error("LinkedIn image upload target escaped its reviewed host family");return url};const checkedHeaders=(value,formData)=>{if(value===undefined)return {"csrf-token":csrf};if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length>32)throw new Error("LinkedIn image upload headers changed shape");const output={};for(const [name,headerValue] of Object.entries(value)){const lower=name.toLowerCase();if(!/^[a-z0-9!#$%&'*+.^_|~-]{1,128}$/.test(lower)||typeof headerValue!=="string"||headerValue.length>8192||/[\\0\\r\\n]/.test(headerValue)||["cookie","host","content-length","origin","referer"].includes(lower)||lower.startsWith("sec-"))throw new Error("LinkedIn image upload headers changed shape");if(formData&&lower==="content-type")continue;output[lower]=headerValue}output["csrf-token"]=csrf;return output};const upload=async(urlValue,body,headers,formData)=>{const url=checkedUrl(urlValue);const response=await fetch(url.href,{body,credentials:url.origin===location.origin?"include":"omit",headers:checkedHeaders(headers,formData),method:"PUT",redirect:"error",referrer:"${LINKEDIN_FEED_URL}"});if(response.status<200||response.status>=300)throw new Error("LinkedIn image upload status changed");return{headers:Object.fromEntries(response.headers.entries()),httpStatusCode:response.status}};if(registration.type==="SINGLE"||registration.type==="MULTIPART_FORMDATA"){if(registration.partUploadRequests!==undefined||registration.multipartMetadata!==undefined)throw new Error("LinkedIn single image upload returned multipart fields");await upload(registration.singleUploadUrl,image,registration.singleUploadHeaders,registration.type==="MULTIPART_FORMDATA")}else if(registration.type==="MULTIPART"){if(registration.singleUploadUrl!==undefined||registration.singleUploadHeaders!==undefined||!Array.isArray(registration.partUploadRequests)||registration.partUploadRequests.length<1||registration.partUploadRequests.length>20||!registration.multipartMetadata||typeof registration.multipartMetadata!=="object"||Array.isArray(registration.multipartMetadata)||JSON.stringify(registration.multipartMetadata).length>65536)throw new Error("LinkedIn multipart image registration changed shape");let next=0;const parts=[];for(const part of registration.partUploadRequests){if(!part||typeof part!=="object"||Array.isArray(part)||Object.keys(part).sort().join(",")!=="firstByte,headers,lastByte,uploadUrl"||!Number.isSafeInteger(part.firstByte)||!Number.isSafeInteger(part.lastByte)||part.firstByte!==next||part.lastByte<part.firstByte||part.lastByte>=image.size)throw new Error("LinkedIn multipart image offsets changed shape");parts.push(await upload(part.uploadUrl,image.slice(part.firstByte,part.lastByte+1,"image/png"),part.headers,false));next=part.lastByte+1}if(next!==image.size)throw new Error("LinkedIn multipart image registration did not cover the file");await requestJson("${LINKEDIN_IMAGE_FINALIZATION_PATH}",{body:JSON.stringify({completeUploadRequest:{mediaArtifactUrn:registration.mediaArtifactUrn,multipartMetadata:registration.multipartMetadata,partUploadResponses:parts}}),headers:mutationHeaders,method:"POST"},"LinkedIn image finalization")}else throw new Error("LinkedIn image upload mechanism changed");return{mediaUrn:registration.urn}})()`;
}

function createEvaluationSource(
  bindings: LinkedInPostPageBindings,
  expectedSubject: string,
  expectedProfileUrn: string,
  variables: Readonly<Record<string, unknown>>,
  mediaUrn: string | null,
): string {
  const input = Object.freeze({
    expectedProfileUrn,
    expectedSubject,
    mediaUrn,
    pageInstance: bindings.pageInstance,
    track: bindings.track,
    variables,
  });
  return `(async()=>{${commonEvaluationPrelude(input)}const firstIdentity=await identity();assertIdentity(firstIdentity);const mutationHeaders={...baseHeaders,"content-type":"application/json; charset=UTF-8","x-li-page-instance":input.pageInstance,"x-li-pem-metadata":"Voyager - Sharing - CreateShare=sharing-create-content","x-li-track":input.track};const createPath="${LINKEDIN_GRAPHQL_PATH}?action=execute&queryId=${encodeURIComponent(LINKEDIN_POST_CREATE_MUTATION_ID)}";const createBody=await requestJson(createPath,{body:JSON.stringify({includeWebMetadata:true,queryId:"${LINKEDIN_POST_CREATE_MUTATION_ID}",variables:input.variables}),headers:mutationHeaders,method:"POST"},"LinkedIn post create");const createPayload=createBody&&typeof createBody==="object"&&!Array.isArray(createBody)&&createBody.data&&typeof createBody.data==="object"&&!Array.isArray(createBody.data)&&createBody.data.value&&typeof createBody.data.value==="object"&&!Array.isArray(createBody.data.value)?createBody.data.value:createBody&&typeof createBody==="object"&&!Array.isArray(createBody)&&createBody.value&&typeof createBody.value==="object"&&!Array.isArray(createBody.value)?createBody.value:createBody;if(!createPayload||typeof createPayload!=="object"||Array.isArray(createPayload))throw new Error("LinkedIn GraphQL response changed shape");if(Array.isArray(createPayload.errors)&&createPayload.errors.length>0)throw new Error("LinkedIn post create returned provider errors");const entity=createPayload.data?.createContentcreationDashShares?.entity;if(!entity||typeof entity!=="object"||Array.isArray(entity))throw new Error("LinkedIn post create omitted its entity");const entityUrn=entity.entityUrn;if(!/^urn:li:(?:fsd_share|share|ugcPost):[A-Za-z0-9_(),.:%=-]{1,448}$/.test(entityUrn||""))throw new Error("LinkedIn post create returned an invalid entity URN");if(!entity.status||typeof entity.status!=="object"||Array.isArray(entity.status)||!entity.status.lifecycleState||typeof entity.status.lifecycleState!=="object"||Array.isArray(entity.status.lifecycleState)||!entity.status.lifecycleState.PublishedState||typeof entity.status.lifecycleState.PublishedState!=="object"||Array.isArray(entity.status.lifecycleState.PublishedState))throw new Error("LinkedIn post create did not report a published lifecycle");return{entityUrn}})()`;
}

function readbackEvaluationSource(
  bindings: LinkedInPostPageBindings,
  expectedSubject: string,
  expectedProfileUrn: string,
  variables: Readonly<Record<string, unknown>>,
  mediaUrn: string | null,
  entityUrn: string,
): string {
  const input = Object.freeze({
    entityUrn,
    expectedProfileUrn,
    expectedSubject,
    mediaUrn,
    pageInstance: bindings.pageInstance,
    track: bindings.track,
    variables,
  });
  return `(async()=>{${commonEvaluationPrelude(input)}const graphqlEnvelope=(body)=>{if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("LinkedIn GraphQL response changed shape");const value=body.data&&typeof body.data==="object"&&!Array.isArray(body.data)&&body.data.value&&typeof body.data.value==="object"&&!Array.isArray(body.data.value)?body.data.value:body.value&&typeof body.value==="object"&&!Array.isArray(body.value)?body.value:body;return value};const variablesText="(moduleKey:feed-item:desktop,urnOrNss:"+input.entityUrn+")";const readbackPath="${LINKEDIN_GRAPHQL_PATH}?includeWebMetadata=true&queryId=${encodeURIComponent(LINKEDIN_POST_READBACK_QUERY_ID)}&variables="+encodeURIComponent(variablesText);const readbackBody=await requestJson(readbackPath,{headers:baseHeaders,method:"GET"},"LinkedIn post readback");const readbackPayload=graphqlEnvelope(readbackBody);if(Array.isArray(readbackPayload.errors)&&readbackPayload.errors.length>0)throw new Error("LinkedIn post readback returned provider errors");const elements=readbackPayload.data?.feedDashUpdatesByBackendUrnOrNss?.elements;if(!Array.isArray(elements)||elements.length!==1||!elements[0]||typeof elements[0]!=="object"||Array.isArray(elements[0]))throw new Error("LinkedIn post readback omitted its exact update");const update=elements[0];let visited=0;const contains=(value,expected,depth=0)=>{if(++visited>50000||depth>32)throw new Error("LinkedIn post readback exceeded its reviewed shape");if(value===expected)return true;if(Array.isArray(value))return value.some((item)=>contains(item,expected,depth+1));if(value&&typeof value==="object")return Object.values(value).some((item)=>contains(item,expected,depth+1));return false};const withinNamed=(value,name,expected,depth=0)=>{if(depth>32||!value||typeof value!=="object")return false;if(Array.isArray(value))return value.some((item)=>withinNamed(item,name,expected,depth+1));for(const [key,item] of Object.entries(value)){if(key===name&&contains(item,expected,depth+1))return true;if(withinNamed(item,name,expected,depth+1))return true}return false};visited=0;const entityMatched=contains(update,input.entityUrn);visited=0;const actorMatched=withinNamed(update,"actor",input.expectedProfileUrn);visited=0;const textMatched=withinNamed(update,"commentary",input.variables.post.commentary.text);visited=0;const mediaMatched=input.mediaUrn===null?false:contains(update,input.mediaUrn);if(!entityMatched||!actorMatched||!textMatched||(input.mediaUrn!==null&&!mediaMatched))throw new Error("LinkedIn independent post readback did not bind the confirmed post");const id=input.entityUrn.slice(input.entityUrn.lastIndexOf(":")+1);if(!/^[A-Za-z0-9_(),.=%-]{1,448}$/.test(id))throw new Error("LinkedIn post entity ID changed shape");const url="${LINKEDIN_ORIGIN}/feed/update/urn:li:activity:"+id+"/";return{actorMatched,entityMatched,entityUrn:input.entityUrn,lifecycle:"PUBLISHED",mediaMatched,mediaUrn:input.mediaUrn,textMatched,url}})()`;
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
    "LinkedIn post browser finalization failed; private artifacts were preserved",
    session.recoveryHandle ?? "session=linkedin-post-runtime;artifacts=unknown",
    new AggregateError(failures, "LinkedIn post browser finalization failed"),
    cleanupEvidence,
  );
}

export async function createLinkedInPostBrowserTransport(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs: number;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly publishCleanupResource?: WebSessionCleanupResourcePublisher;
    readonly dependencies?: Partial<LinkedInPostBrowserDependencies>;
  },
): Promise<LinkedInPostBrowserTransport> {
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
  const session = await createSession(postBrowserManifest, auth, sessionOptions);
  let closed = false;
  const remaining = (): number => options.operationDeadline?.remainingTimeMs() ?? options.timeoutMs;
  const runEvaluations = async (
    sources: readonly string[],
  ): Promise<readonly Readonly<Record<string, unknown>>[]> => {
    if (closed) throw new Error("LinkedIn post browser transport is closed");
    const records = await session.runBatch(
      sources.map((source) => ["eval", source] as const),
      remaining(),
      MAX_BROWSER_OUTPUT_BYTES,
    );
    if (records.length !== sources.length) {
      throw new Error("LinkedIn post browser omitted an evaluation response");
    }
    return Object.freeze(records.map((record) => browserEvaluationResult(record)));
  };
  const run = async (source: string): Promise<Readonly<Record<string, unknown>>> => {
    const first = (await runEvaluations([source]))[0];
    if (first === undefined) throw new Error("LinkedIn post browser omitted its response");
    return first;
  };

  let bindings: LinkedInPostPageBindings;
  try {
    await session.runBatch(
      [["open", LINKEDIN_FEED_URL], ["wait", "5000"]],
      remaining(),
      MAX_BROWSER_OUTPUT_BYTES,
    );
    const records = await session.runBatch(
      [["network", "requests", "--filter", "/voyager/api/"]],
      Math.min(remaining(), 30_000),
      MAX_BROWSER_OUTPUT_BYTES,
    );
    const first = records[0];
    if (first === undefined) throw new Error("LinkedIn post page-binding observation omitted its response");
    bindings = linkedInPostPageBindings(browserResultData(first));
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
      const result = await run(identityEvaluationSource());
      exactKeys(result, ["body", "contentType", "status"], "LinkedIn current-member browser request");
      if (result.status !== 200) {
        throw new Error("LinkedIn current-member browser request returned an unreviewed response");
      }
      return result.body;
    },
    uploadImage: async (expectedSubject: string, image: Uint8Array) => {
      if (image.byteLength < 24 || image.byteLength > MAX_IMAGE_BYTES) {
        throw new Error("LinkedIn post image is outside the reviewed byte bound");
      }
      const encoded = Buffer.from(image).toString("base64");
      const chunkCount = Math.ceil(encoded.length / IMAGE_STAGING_CHUNK_CHARACTERS);
      const staging = Object.freeze({
        key: `__wrenchLinkedInPostImage_${randomUUID().replaceAll("-", "")}`,
        byteLength: image.byteLength,
        base64Length: encoded.length,
        chunkCount,
      });
      let failureStage: LinkedInPostImageFailureStage = "page image staging";
      try {
        const initialized = await run(imageStagingInitializationSource(staging));
        exactKeys(initialized, ["ready"], "LinkedIn image staging initialization");
        if (initialized.ready !== true) {
          throw new Error("LinkedIn image staging initialization changed shape");
        }
        const sources: string[] = [];
        for (let index = 0; index < chunkCount; index += 1) {
          const offset = index * IMAGE_STAGING_CHUNK_CHARACTERS;
          sources.push(imageStagingChunkSource(
            staging,
            index,
            encoded.slice(offset, offset + IMAGE_STAGING_CHUNK_CHARACTERS),
          ));
        }
        for (
          let offset = 0;
          offset < sources.length;
          offset += IMAGE_STAGING_COMMANDS_PER_BATCH
        ) {
          const batch = sources.slice(offset, offset + IMAGE_STAGING_COMMANDS_PER_BATCH);
          const staged = await runEvaluations(batch);
          for (let index = 0; index < staged.length; index += 1) {
            const result = staged[index]!;
            exactKeys(result, ["staged"], "LinkedIn image staging command");
            if (result.staged !== offset + index + 1) {
              throw new Error("LinkedIn image staging command changed order");
            }
          }
        }
        failureStage = "image registration or upload response";
        const result = await run(uploadEvaluationSource(bindings, expectedSubject, staging));
        exactKeys(result, ["mediaUrn"], "LinkedIn image upload browser request");
        return linkedInPostMediaUrn(result.mediaUrn);
      } catch (error) {
        throw new LinkedInPostImagePreparationError(failureStage, error);
      } finally {
        try {
          await run(imageStagingCleanupSource(staging.key));
        } catch {
          // Browser finalization remains the authoritative private-artifact cleanup.
        }
      }
    },
    createPost: async (
      expectedSubject: string,
      expectedProfileUrn: string,
      variables: Readonly<Record<string, unknown>>,
      mediaUrn: string | null,
    ) => {
      const result = await run(createEvaluationSource(
        bindings,
        expectedSubject,
        expectedProfileUrn,
        variables,
        mediaUrn,
      ));
      exactKeys(result, ["entityUrn"], "LinkedIn post create browser request");
      return linkedInPostEntityUrn(result.entityUrn);
    },
    readPost: async (
      expectedSubject: string,
      expectedProfileUrn: string,
      variables: Readonly<Record<string, unknown>>,
      mediaUrn: string | null,
      entityUrn: string,
    ) => {
      const result = await run(readbackEvaluationSource(
        bindings,
        expectedSubject,
        expectedProfileUrn,
        variables,
        mediaUrn,
        linkedInPostEntityUrn(entityUrn),
      ));
      return result;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await finalizeBrowserSession(session);
    },
  });
}
