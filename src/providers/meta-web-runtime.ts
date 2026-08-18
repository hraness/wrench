import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { acquireCookieRecords } from "@hraness/kb/clip/acquire";

import type { WrenchAuth } from "../auth";
import type { BrowserFileResolver } from "../browser";
import { canonicalJson, sha256 } from "../canonical-json";
import type { FileInputValue, OperationInput, WebSessionRecipe } from "../model";
import { openCursorToken, sealCursorToken } from "../cursor-token";
import {
  createWebSessionClient,
  fetchPublicWebAsset,
  webSessionAuthSubject,
  webSessionCookie,
  type WebSessionClient,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import { acquireWebSessionCookieRecords } from "../web-session-cookies";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  META_WEB_OPERATIONS,
  META_WEB_OPERATION_NAMES,
  META_WEB_SITES,
  isCanonicalMetaNumericId,
  normalizeFacebookFeedHtml,
  normalizeFacebookMarketplaceFeedJsonDocuments,
  normalizeFacebookMarketplaceFeedHtml,
  normalizeFacebookMarketplaceListingHtml,
  normalizeInstagramComments,
  normalizeInstagramContacts,
  normalizeInstagramFeed,
  normalizeInstagramInbox,
  normalizeInstagramPost,
  normalizeThreadsFeedHtml,
  normalizeThreadsPostHtml,
  parseFacebookViewerId,
  parseMetaJsonDocuments,
  parseMetaJsonScripts,
  parseInstagramViewerId,
  parseThreadsViewerId,
  type FacebookMarketplaceFeed,
  type MetaWebOperationContract,
  type MetaWebSite,
} from "./meta-web";
import {
  bootstrapMetaComet,
  consumeMetaCometRequestProof,
  materializeMetaCometRequestProof,
  type MetaCometRequestFieldName,
} from "./meta-bootstrap";
import { normalizeFacebookGroupFeedHtml } from "./meta-facebook-group";
import {
  FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR,
  bindFacebookMarketplacePaginationCursor,
  buildFacebookMarketplacePaginationRequest,
  facebookMarketplacePaginationCursorExhausted,
  facebookMarketplacePaginationInputHash,
  reconstructFacebookMarketplacePaginationCursor,
  type FacebookMarketplacePaginationCursor,
} from "./meta-marketplace-relay";
import {
  extractMetaRelayBundleUrls,
  resolveMetaRelayOperationRevision,
} from "./meta-relay-bundle";
import {
  assertMetaRelayResponseBinding,
  resolveMetaOperationDescriptor,
} from "./meta-web-descriptors";

const ORIGINS = Object.freeze({
  instagram: "https://www.instagram.com",
  threads: "https://www.threads.com",
  facebook: "https://www.facebook.com",
  "facebook-page": "https://www.facebook.com",
  "facebook-group": "https://www.facebook.com",
  "facebook-marketplace": "https://www.facebook.com",
} as const satisfies Readonly<Record<MetaWebSite, string>>);

const MAX_BOOTSTRAP_BYTES = 12 * 1024 * 1024;
const MAX_API_BYTES = 8 * 1024 * 1024;
const MAX_META_RELAY_ASSETS = 16;
const MAX_META_RELAY_ASSET_BYTES = 3 * 1024 * 1024;
const MAX_THREADS_IMAGE_BYTES = 20 * 1024 * 1024;
const MARKETPLACE_CURSOR_SCOPE = "facebook-marketplace-feed";
const THREADS_WEB_APP_ID = "238260118697367";
const THREADS_ASBD_ID = "359341";

export type MetaWebRuntimeDependencies = Partial<WebSessionNetworkDependencies> & {
  readonly now?: () => number;
};

function metaWebSessionDependencies(
  site: MetaWebSite,
  auth: WrenchAuth,
  dependencies: MetaWebRuntimeDependencies | undefined,
): Partial<WebSessionNetworkDependencies> | undefined {
  if (site !== "threads") return dependencies;
  const fallback = dependencies?.acquireCookies ?? acquireCookieRecords;
  return {
    ...(dependencies?.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    acquireCookies: (selection, target) => acquireWebSessionCookieRecords(
      auth,
      target,
      selection.timeoutMs,
      fallback,
    ),
  };
}

function isMetaSite(value: string): value is MetaWebSite {
  return (META_WEB_SITES as readonly string[]).includes(value);
}

function operationContract(site: MetaWebSite, action: string): MetaWebOperationContract | null {
  if (!(META_WEB_OPERATION_NAMES[site] as readonly string[]).includes(action)) return null;
  const siteContracts: Readonly<Record<string, MetaWebOperationContract>> = META_WEB_OPERATIONS[site];
  return siteContracts[action] ?? null;
}

function integerInput(
  input: OperationInput,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[name] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`input.${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function exactStringInput(
  input: OperationInput,
  name: string,
  pattern: RegExp,
  label: string,
): string {
  const value = input[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`input.${name} must be ${label}`);
  return value;
}

function exactEnumInput(
  input: OperationInput,
  name: string,
  allowed: readonly string[],
): string {
  const value = input[name];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`input.${name} must be ${allowed.join(" or ")}`);
  }
  return value;
}

function optionalOpaqueCursor(input: OperationInput, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 8_192
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) throw new Error(`input.${name} must be an exact bounded opaque cursor`);
  return value;
}

function requireExactInputKeys(
  input: OperationInput,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(input).filter((name) => !allowedKeys.has(name));
  if (unexpected.length > 0) {
    throw new Error(`input contains unsupported keys: ${unexpected.join(", ")}`);
  }
}

function htmlHeaders(origin: string): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "text/html,application/xhtml+xml",
    referer: `${origin}/`,
  });
}

function instagramHeaders(referer: string): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json, text/plain, */*",
    referer,
    "x-ig-app-id": "936619743392459",
    "x-requested-with": "XMLHttpRequest",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bootstrapConfig(
  html: string,
  moduleName: string,
): Readonly<Record<string, unknown>> {
  const stack: unknown[] = [...parseMetaJsonScripts(html)];
  const matches: Record<string, unknown>[] = [];
  let visited = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    visited += 1;
    if (visited > 250_000) throw new Error("Threads bootstrap configuration exceeded its reviewed bound");
    if (Array.isArray(value)) {
      if (value[0] === moduleName && isRecord(value[2])) matches.push(value[2]);
      for (const item of value) stack.push(item);
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) stack.push(item);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Threads bootstrap must contain one exact ${moduleName} configuration`);
  }
  return matches[0]!;
}

type ThreadsRequestConfig = {
  readonly bloksVersionId: string;
  readonly sprinkleParameter: "jazoest";
  readonly sprinkleVersion: number;
};

function threadsRequestConfig(html: string): ThreadsRequestConfig {
  const bloks = bootstrapConfig(html, "WebBloksVersioningID");
  const sprinkle = bootstrapConfig(html, "SprinkleConfig");
  if (
    typeof bloks.versioningID !== "string"
    || !/^[a-f0-9]{64}$/u.test(bloks.versioningID)
  ) throw new Error("Threads bootstrap Web Bloks version is invalid");
  if (
    sprinkle.param_name !== "jazoest"
    || !Number.isSafeInteger(sprinkle.version)
    || (sprinkle.version as number) < 1
    || (sprinkle.version as number) > 9
    || sprinkle.should_randomize !== false
  ) throw new Error("Threads bootstrap request-sprinkle configuration is invalid");
  return Object.freeze({
    bloksVersionId: bloks.versioningID,
    sprinkleParameter: "jazoest",
    sprinkleVersion: sprinkle.version as number,
  });
}

function threadsSprinkleValue(csrfToken: string, version: number): string {
  if (csrfToken.length < 1 || csrfToken.length > 512 || /[\0\r\n]/u.test(csrfToken)) {
    throw new Error("Threads CSRF cookie is invalid");
  }
  let total = 0;
  for (const character of csrfToken) total += character.charCodeAt(0);
  return `${version}${total}`;
}

function threadsWebSessionId(seed: string): string {
  const numeric = Number(seed);
  if (!Number.isSafeInteger(numeric)) throw new Error("Threads upload ID is invalid");
  const pageId = (numeric % (36 ** 6)).toString(36).padStart(6, "0");
  return `::${pageId}`;
}

function threadsApiHeaders(
  client: WebSessionClient,
  config: ThreadsRequestConfig,
  webSessionId: string,
  contentType: "application/json" | "application/x-www-form-urlencoded;charset=UTF-8",
): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "*/*",
    "content-type": contentType,
    origin: ORIGINS.threads,
    referer: `${ORIGINS.threads}/`,
    "x-asbd-id": THREADS_ASBD_ID,
    "x-bloks-version-id": config.bloksVersionId,
    "x-csrftoken": webSessionCookie(client.cookies, "csrftoken"),
    "x-ig-app-id": THREADS_WEB_APP_ID,
    "x-instagram-ajax": "0",
    "x-web-session-id": webSessionId,
  });
}

function fileInput(value: OperationInput[string]): FileInputValue {
  if (
    !isRecord(value)
    || value.kind !== "file"
    || typeof value.reference !== "string"
    || Object.keys(value).sort().join(",") !== "kind,reference"
  ) throw new Error("input.attachment must be one plan-bound file");
  return Object.freeze({ kind: "file", reference: value.reference });
}

type ThreadsImage = {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly mediaType: "image/png";
  readonly width: number;
};

async function materializeThreadsImage(
  attachment: FileInputValue,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
): Promise<ThreadsImage> {
  if (fileResolver === undefined) {
    throw new Error("Threads image upload requires the plan-bound file resolver");
  }
  const paths = operationDeadline === undefined
    ? await fileResolver([attachment])
    : await operationDeadline.run(
        () => fileResolver([attachment]),
        "authenticated web operation deadline",
      );
  operationDeadline?.throwIfUnavailable("authenticated web operation deadline");
  if (paths.length !== 1 || typeof paths[0] !== "string") {
    throw new Error("Threads file resolver did not return one exact path");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = operationDeadline === undefined
    ? await open(paths[0], constants.O_RDONLY | noFollow)
    : await operationDeadline.run(
        () => open(paths[0]!, constants.O_RDONLY | noFollow),
        "authenticated web operation deadline",
      );
  try {
    const before = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (!before.isFile() || before.size < 24 || before.size > MAX_THREADS_IMAGE_BYTES) {
      throw new Error("Threads image must be a regular PNG no larger than 20 MiB");
    }
    const bytes = operationDeadline === undefined
      ? await handle.readFile()
      : await operationDeadline.run(
          () => handle.readFile(),
          "authenticated web operation deadline",
        );
    const after = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(
          () => handle.stat(),
          "authenticated web operation deadline",
        );
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== before.size
    ) throw new Error("Threads image changed while it was materialized");
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      signature.some((value, index) => bytes[index] !== value)
      || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    ) throw new Error("Threads image must be a PNG fixture");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 20_000 || height > 20_000) {
      throw new Error("Threads PNG dimensions are outside the reviewed bound");
    }
    return Object.freeze({
      bytes: new Uint8Array(bytes),
      height,
      mediaType: "image/png",
      width,
    });
  } finally {
    await handle.close();
  }
}

async function rootHtml(client: WebSessionClient, origin: string): Promise<string> {
  return client.requestText({
    url: new URL("/", origin),
    headers: htmlHeaders(origin),
    expectedContentTypes: ["text/html"],
    maxBytes: MAX_BOOTSTRAP_BYTES,
  });
}

async function metaHtmlPath(
  client: WebSessionClient,
  origin: string,
  path: string,
  refererPath = "/",
): Promise<string> {
  return client.requestText({
    url: new URL(path, origin),
    headers: Object.freeze({
      accept: "text/html,application/xhtml+xml",
      referer: new URL(refererPath, origin).href,
    }),
    expectedContentTypes: ["text/html"],
    maxBytes: MAX_BOOTSTRAP_BYTES,
  });
}

async function resolveCurrentMetaRelayOperation(
  html: string,
  friendlyName: string,
  timeoutMs: number,
  dependencies?: MetaWebRuntimeDependencies,
  budget: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
  } = {},
): Promise<void> {
  const urls = extractMetaRelayBundleUrls(html);
  if (urls.length > MAX_META_RELAY_ASSETS) {
    throw new Error("Meta Relay bootstrap exposed too many executable bundle assets");
  }
  const texts = await Promise.all(urls.map((url) =>
    fetchPublicWebAsset(new URL(url), {
      allowedOrigin: "https://static.xx.fbcdn.net",
      contentTypes: [
        "application/javascript",
        "application/x-javascript",
        "text/javascript",
      ],
      maxBytes: MAX_META_RELAY_ASSET_BYTES,
      timeoutMs,
      ...(budget.signal === undefined ? {} : { signal: budget.signal }),
      ...(budget.operationDeadline === undefined
        ? {}
        : { operationDeadline: budget.operationDeadline }),
      ...(dependencies === undefined ? {} : { dependencies }),
    })));
  const revision = resolveMetaRelayOperationRevision(texts, friendlyName);
  resolveMetaOperationDescriptor([{
    friendlyName: revision.friendlyName,
    docId: revision.docId,
    operationType: "query",
    origin: "https://www.facebook.com",
    method: "POST",
    path: "/api/graphql/",
  }], FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR);
}

async function executeFacebookMarketplaceContinuation(
  client: WebSessionClient,
  html: string,
  viewerId: string,
  cursor: FacebookMarketplacePaginationCursor,
  limit: number,
  recipe: WebSessionRecipe,
  dependencies?: MetaWebRuntimeDependencies,
  budget: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
  } = {},
): Promise<FacebookMarketplaceFeed> {
  const bootstrap = bootstrapMetaComet(html, {
    parseMetaJsonScripts,
    expectedViewerId: viewerId,
    expectedActingId: viewerId,
  });
  const request = buildFacebookMarketplacePaginationRequest(html, viewerId, cursor);
  const friendlyName = request.parameters.find(
    ({ name }) => name === "fb_api_req_friendly_name",
  )?.value;
  if (friendlyName === undefined) {
    throw new Error("Marketplace Relay request omitted its reviewed friendly name");
  }
  await resolveCurrentMetaRelayOperation(
    html,
    friendlyName,
    recipe.timeoutMs,
    dependencies,
    budget,
  );

  const form = new URLSearchParams();
  form.set("__a", "1");
  form.set("fb_api_caller_class", "RelayModern");
  form.set("server_timestamps", "true");
  for (const parameter of request.parameters) form.set(parameter.name, parameter.value);
  const variablesText = form.get("variables");
  if (variablesText === null) throw new Error("Marketplace Relay request omitted variables");
  let variables: unknown;
  try {
    variables = JSON.parse(variablesText) as unknown;
  } catch {
    throw new Error("Marketplace Relay request variables were malformed");
  }
  if (
    typeof variables !== "object"
    || variables === null
    || Array.isArray(variables)
    || !Number.isSafeInteger((variables as Record<string, unknown>).scale)
  ) throw new Error("Marketplace Relay request omitted its reviewed display scale");
  form.set("dpr", String((variables as Record<string, unknown>).scale));

  const writtenProofs: string[] = [];
  consumeMetaCometRequestProof(
    materializeMetaCometRequestProof(bootstrap, request),
    request,
    {
    sink: "network-request",
    write: (name: MetaCometRequestFieldName, value: string) => {
      if (!request.proofFormFields.includes(name)) {
        throw new Error("Marketplace Relay proof escaped its descriptor-owned sink");
      }
      writtenProofs.push(name);
      form.set(name, value);
    },
    },
  );
  if (
    writtenProofs.length !== request.proofFormFields.length
    || request.proofFormFields.some((name) => !writtenProofs.includes(name))
  ) throw new Error("Marketplace Relay request omitted a descriptor-owned proof");

  const text = await client.requestText({
    url: new URL(request.path, request.origin),
    method: "POST",
    headers: Object.freeze({
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      referer: "https://www.facebook.com/marketplace/",
    }),
    body: form.toString(),
    expectedContentTypes: ["text/html"],
    maxBytes: Math.min(recipe.maxOutputBytes, MAX_API_BYTES),
  });
  const documents = parseMetaJsonDocuments(text);
  const firstDocument = documents[0];
  if (firstDocument === undefined) {
    throw new Error("Marketplace Relay response omitted its descriptor-bound root document");
  }
  const response = assertMetaRelayResponseBinding(
    FACEBOOK_MARKETPLACE_PAGINATION_DESCRIPTOR,
    firstDocument,
  );
  return normalizeFacebookMarketplaceFeedJsonDocuments(
    documents,
    cursor.cursor,
    limit,
    response.value,
  );
}

function threadsUploadId(now: () => number): string {
  const value = Math.trunc(now());
  const uploadId = String(value);
  if (!/^[1-9][0-9]{12}$/u.test(uploadId)) {
    throw new Error("Threads upload clock did not produce one canonical 13-digit ID");
  }
  return uploadId;
}

async function uploadThreadsImage(
  client: WebSessionClient,
  image: ThreadsImage,
  uploadId: string,
): Promise<void> {
  const entityName = `fb_uploader_${uploadId}`;
  await client.requestStatus({
    url: new URL(`/rupload_igphoto/${entityName}`, ORIGINS.threads),
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": image.mediaType,
      offset: "0",
      origin: ORIGINS.threads,
      referer: `${ORIGINS.threads}/`,
      "x-entity-length": String(image.bytes.byteLength),
      "x-entity-name": entityName,
      "x-entity-type": image.mediaType,
      "x-ig-app-id": THREADS_WEB_APP_ID,
      "x-instagram-rupload-params": JSON.stringify({
        is_sidecar: "0",
        is_threads: "1",
        media_type: 1,
        upload_id: uploadId,
        upload_media_height: image.height,
        upload_media_width: image.width,
      }),
    },
    body: image.bytes,
    expectedStatuses: [200, 201, 202],
  });
}

type ThreadsCreatedPost = {
  readonly code: string;
  readonly id: string;
  readonly url: string;
};

function threadsCreatedPost(value: unknown, viewerId: string): ThreadsCreatedPost {
  if (!isRecord(value) || value.status !== "ok" || !isRecord(value.media)) {
    throw new Error("Threads create response did not match the reviewed success shape");
  }
  const { code, permalink, pk } = value.media;
  if (
    typeof code !== "string"
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(code)
    || typeof permalink !== "string"
    || typeof pk !== "string"
    || !/^[0-9]{1,32}(?:_[0-9]{1,32})?$/u.test(pk)
  ) throw new Error("Threads create response returned invalid post identifiers");
  const url = new URL(permalink, ORIGINS.threads);
  if (
    url.origin !== ORIGINS.threads
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !url.pathname.endsWith(`/post/${code}`)
  ) throw new Error("Threads create response returned an unreviewed permalink");
  if (pk.includes("_") && !pk.endsWith(`_${viewerId}`)) {
    throw new Error("Threads create response changed the confirmed actor");
  }
  return Object.freeze({ code, id: pk, url: url.href });
}

function threadsTextPostAppInfo(body: string): string {
  return JSON.stringify({
    excluded_inline_media_ids: "[]",
    is_genai_invocation_post: false,
    is_reply_approval_enabled: false,
    is_spoiler_media: false,
    text_with_entities: {
      entities: [],
      text: body,
    },
  });
}

async function createThreadsPost(
  client: WebSessionClient,
  viewer: BoundMetaViewer,
  prepared: Extract<PreparedMetaRead, { readonly kind: "threads-post" }>,
  uploadId: string,
  config: ThreadsRequestConfig,
): Promise<ThreadsCreatedPost> {
  const csrfToken = webSessionCookie(client.cookies, "csrftoken");
  const webSessionId = threadsWebSessionId(uploadId);
  const form = new URLSearchParams();
  form.set("audience", prepared.audience);
  form.set("caption", prepared.body);
  form.set("creator_geo_gating_info", JSON.stringify({ whitelist_country_codes: [] }));
  form.set("is_threads", "true");
  form.set("should_include_permalink", "true");
  form.set("text_post_app_info", threadsTextPostAppInfo(prepared.body));
  form.set("upload_id", uploadId);
  form.set("web_session_id", webSessionId);
  form.set(
    config.sprinkleParameter,
    threadsSprinkleValue(csrfToken, config.sprinkleVersion),
  );
  const response = await client.requestJson({
    url: new URL("/api/v1/media/configure_text_post_app_feed/", ORIGINS.threads),
    method: "POST",
    headers: threadsApiHeaders(
      client,
      config,
      webSessionId,
      "application/x-www-form-urlencoded;charset=UTF-8",
    ),
    body: form.toString(),
    expectedStatuses: [200],
    expectedContentTypes: ["application/json", "text/plain"],
    maxBytes: 256 * 1024,
  });
  return threadsCreatedPost(response, viewer.id);
}

function metaDispatchEvent(
  id: string,
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return { id, index: 1, progress: { planned: 1, started, verified } };
}

async function executeThreadsPost(
  client: WebSessionClient,
  viewer: BoundMetaViewer,
  prepared: Extract<PreparedMetaRead, { readonly kind: "threads-post" }>,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly now: () => number;
  },
): Promise<WebSessionExecution> {
  const image = await materializeThreadsImage(
    prepared.attachment,
    options.fileResolver,
    options.operationDeadline,
  );
  const reboundViewer = await currentViewer("threads", client);
  if (reboundViewer.subject !== viewer.subject) {
    throw new Error("Threads current viewer changed before the post dispatch");
  }
  const config = threadsRequestConfig(reboundViewer.rootHtml);
  const uploadId = threadsUploadId(options.now);
  let started = 0;
  let verified = 0;
  let created: ThreadsCreatedPost | null = null;
  try {
    await options.beforeDispatch?.(metaDispatchEvent("posts.publish", started, verified));
    started = 1;
    await uploadThreadsImage(client, image, uploadId);
    created = await createThreadsPost(client, reboundViewer, prepared, uploadId, config);
    const readbackHtml = await client.requestText({
      url: new URL(created.url),
      method: "GET",
      headers: htmlHeaders(ORIGINS.threads),
      expectedContentTypes: ["text/html"],
      maxBytes: MAX_BOOTSTRAP_BYTES,
    });
    const post = normalizeThreadsPostHtml(
      readbackHtml,
      reboundViewer.id,
      created.id,
      prepared.body,
    );
    verified = 1;
    await options.afterDispatchVerified?.(metaDispatchEvent("posts.publish", started, verified));
    return {
      status: "succeeded",
      output: Object.freeze({
        post,
        attachment: Object.freeze({
          height: image.height,
          mediaType: image.mediaType,
          width: image.width,
        }),
      }),
      finalUrl: created.url,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: created?.url ?? `${ORIGINS.threads}/`,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "Threads may have accepted the image upload or post but exact actor, ID, text, and permalink readback was not verified; reconcile before retrying"
        : "Threads post dispatch failed before submission",
    };
  }
}

function facebookMarketplaceAuthHash(auth: WrenchAuth): string {
  return sha256(canonicalJson(auth));
}

function expectedFacebookViewerId(auth: WrenchAuth): string {
  const subject = webSessionAuthSubject(auth);
  const prefix = "facebook:user:";
  const id = subject?.startsWith(prefix) === true
    ? subject.slice(prefix.length)
    : null;
  if (!isCanonicalMetaNumericId(id)) {
    throw new Error(
      "Facebook Marketplace pagination requires an exact bound Facebook viewer subject",
    );
  }
  return id;
}

function expectedMetaAuthSubject(site: MetaWebSite, auth: WrenchAuth): string {
  const subject = webSessionAuthSubject(auth);
  const prefix = site === "instagram"
    ? "instagram:"
    : site === "threads"
      ? "threads:"
      : "facebook:user:";
  if (
    subject === null
    || !subject.startsWith(prefix)
    || !isCanonicalMetaNumericId(subject.slice(prefix.length))
  ) {
    throw new Error(`${site} authenticated operations require an exact bound viewer subject`);
  }
  return subject;
}

function openFacebookMarketplaceCursor(
  token: string,
  auth: WrenchAuth,
  environment: Readonly<Record<string, string | undefined>>,
): FacebookMarketplacePaginationCursor {
  const cursor = reconstructFacebookMarketplacePaginationCursor(
    expectedFacebookViewerId(auth),
    openCursorToken(
      MARKETPLACE_CURSOR_SCOPE,
      auth.id,
      facebookMarketplaceAuthHash(auth),
      token,
      environment,
    ),
  );
  if (facebookMarketplacePaginationCursorExhausted(cursor)) {
    throw new Error("Marketplace pagination cursor reached its reviewed chain bound");
  }
  return cursor;
}

function sealFacebookMarketplaceFeed(
  feed: FacebookMarketplaceFeed,
  html: string,
  viewerId: string,
  auth: WrenchAuth,
  previous: FacebookMarketplacePaginationCursor | null,
  environment: Readonly<Record<string, string | undefined>>,
): FacebookMarketplaceFeed {
  if (feed.next_cursor === null) return feed;
  const cursor = bindFacebookMarketplacePaginationCursor(
    viewerId,
    feed.next_cursor,
    facebookMarketplacePaginationInputHash(html, viewerId),
    previous,
  );
  if (facebookMarketplacePaginationCursorExhausted(cursor)) {
    return Object.freeze({
      ...feed,
      next_cursor: null,
      continuation_supported: false,
      complete: false,
    });
  }
  return Object.freeze({
    ...feed,
    next_cursor: sealCursorToken(
      MARKETPLACE_CURSOR_SCOPE,
      auth.id,
      facebookMarketplaceAuthHash(auth),
      cursor,
      environment,
    ),
  });
}

type BoundMetaViewer = {
  readonly id: string;
  readonly subject: string;
  readonly rootHtml: string;
};

async function currentViewer(
  site: MetaWebSite,
  client: WebSessionClient,
): Promise<BoundMetaViewer> {
  const html = await rootHtml(client, ORIGINS[site]);
  if (site === "instagram") {
    const id = parseInstagramViewerId(html);
    if (webSessionCookie(client.cookies, "ds_user_id") !== id) {
      throw new Error("Instagram Polaris viewer did not match the selected browser session");
    }
    return Object.freeze({ id, subject: `instagram:${id}`, rootHtml: html });
  }
  if (site === "threads") {
    const id = parseThreadsViewerId(html);
    if (webSessionCookie(client.cookies, "ds_user_id") !== id) {
      throw new Error("Threads Barcelona viewer did not match the selected browser session");
    }
    return Object.freeze({ id, subject: `threads:${id}`, rootHtml: html });
  }
  const id = parseFacebookViewerId(html);
  if (webSessionCookie(client.cookies, "c_user") !== id) {
    throw new Error("Facebook CurrentUserInitialData did not match the selected browser session");
  }
  return Object.freeze({ id, subject: `facebook:user:${id}`, rootHtml: html });
}

export async function probeMetaWebSubject(
  site: MetaWebSite,
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: MetaWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const dependencies = metaWebSessionDependencies(site, auth, options.dependencies);
  const client = await createWebSessionClient(ORIGINS[site], auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(dependencies === undefined ? {} : { dependencies }),
  });
  return (await currentViewer(site, client)).subject;
}

async function requireBoundViewer(
  site: MetaWebSite,
  client: WebSessionClient,
  expectedSubject: string,
): Promise<BoundMetaViewer> {
  const subjectPrefix = site === "instagram"
    ? "instagram:"
    : site === "threads"
      ? "threads:"
      : "facebook:user:";
  const cookieName = site === "instagram" || site === "threads"
    ? "ds_user_id"
    : "c_user";
  const expectedCookieValue = expectedSubject.slice(subjectPrefix.length);
  if (webSessionCookie(client.cookies, cookieName) !== expectedCookieValue) {
    throw new Error(
      `${site} account cookie did not match the confirmed auth subject`,
    );
  }
  const viewer = await currentViewer(site, client);
  if (viewer.subject !== expectedSubject) {
    throw new Error(`${site} current viewer no longer matches the confirmed auth subject`);
  }
  return viewer;
}

function exactInstagramMediaId(input: OperationInput): string {
  return exactStringInput(
    input,
    "media_id",
    /^[0-9]{1,32}(?:_[0-9]{1,32})?$/u,
    "an exact Instagram media ID",
  );
}

type PreparedMetaRead =
  | {
    readonly kind: "instagram-feed";
    readonly limit: number;
  }
  | {
    readonly kind: "instagram-media";
    readonly mediaId: string;
  }
  | {
    readonly kind: "instagram-comments";
    readonly mediaId: string;
    readonly limit: number;
  }
  | {
      readonly kind: "instagram-inbox";
      readonly limit: number;
    }
  | {
      readonly kind: "instagram-contacts";
      readonly threadLimit: number;
      readonly contactLimit: number;
    }
  | {
    readonly kind: "threads-feed";
    readonly limit: number;
  }
  | {
    readonly kind: "threads-post";
    readonly attachment: FileInputValue;
    readonly audience: "default";
    readonly body: string;
  }
  | {
    readonly kind: "facebook-feed";
    readonly limit: number;
  }
  | {
    readonly kind: "facebook-group-feed";
    readonly groupId: string;
    readonly limit: number;
  }
  | {
    readonly kind: "facebook-marketplace-feed";
    readonly cursor?: FacebookMarketplacePaginationCursor;
    readonly limit: number;
  }
  | {
    readonly kind: "facebook-marketplace-listing";
    readonly listingId: string;
  };

function prepareMetaRead(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  environment: Readonly<Record<string, string | undefined>>,
): PreparedMetaRead {
  if (recipe.site === "instagram") {
    if (recipe.action === "contacts.list") {
      requireExactInputKeys(input, ["contact_limit", "thread_limit"]);
      return Object.freeze({
        kind: "instagram-contacts",
        threadLimit: integerInput(input, "thread_limit", 20, 1, 50),
        contactLimit: integerInput(input, "contact_limit", 50, 1, 100),
      });
    }
    if (recipe.action === "feeds.read") {
      requireExactInputKeys(input, ["feed", "limit"]);
      exactEnumInput(input, "feed", ["home"]);
      return Object.freeze({
        kind: "instagram-feed",
        limit: integerInput(input, "limit", 20, 1, 30),
      });
    }
    if (recipe.action === "posts.read" || recipe.action === "media.read") {
      requireExactInputKeys(input, ["media_id"]);
      return Object.freeze({
        kind: "instagram-media",
        mediaId: exactInstagramMediaId(input),
      });
    }
    if (recipe.action === "comments.read") {
      requireExactInputKeys(input, ["limit", "media_id"]);
      const mediaId = exactInstagramMediaId(input);
      return Object.freeze({
        kind: "instagram-comments",
        mediaId,
        limit: integerInput(input, "limit", 20, 1, 50),
      });
    }
    if (recipe.action === "messaging.list") {
      requireExactInputKeys(input, ["folder", "limit"]);
      exactEnumInput(input, "folder", ["inbox"]);
      return Object.freeze({
        kind: "instagram-inbox",
        limit: integerInput(input, "limit", 20, 1, 50),
      });
    }
  }
  if (recipe.site === "threads" && recipe.action === "feeds.read") {
    requireExactInputKeys(input, ["feed", "limit"]);
    exactEnumInput(input, "feed", ["for-you"]);
    return Object.freeze({
      kind: "threads-feed",
      limit: integerInput(input, "limit", 20, 1, 30),
    });
  }
  if (recipe.site === "threads" && recipe.action === "posts.publish") {
    requireExactInputKeys(input, ["attachment", "audience", "body"]);
    const body = input.body;
    if (
      typeof body !== "string"
      || body.length < 1
      || body.length > 450
      || /[\0\r]/u.test(body)
    ) throw new Error("input.body must be 1 to 450 bounded UTF-16 code units");
    if (input.attachment === undefined) {
      throw new Error("reviewed Threads posts.publish currently requires one PNG attachment");
    }
    const audience = input.audience === undefined
      ? "default"
      : exactEnumInput(input, "audience", ["default"]);
    return Object.freeze({
      kind: "threads-post",
      attachment: fileInput(input.attachment),
      audience: audience as "default",
      body,
    });
  }
  if (recipe.site === "facebook" && recipe.action === "feeds.read") {
    requireExactInputKeys(input, ["feed", "limit"]);
    exactEnumInput(input, "feed", ["home"]);
    return Object.freeze({
      kind: "facebook-feed",
      limit: integerInput(input, "limit", 20, 1, 30),
    });
  }
  if (recipe.site === "facebook-group" && recipe.action === "feeds.read") {
    requireExactInputKeys(input, ["feed", "group_id", "limit"]);
    exactEnumInput(input, "feed", ["group"]);
    return Object.freeze({
      kind: "facebook-group-feed",
      groupId: exactStringInput(
        input,
        "group_id",
        /^[1-9][0-9]{0,31}$/u,
        "an exact nonzero numeric Facebook Group ID",
      ),
      limit: integerInput(input, "limit", 20, 1, 30),
    });
  }
  if (recipe.site === "facebook-marketplace" && recipe.action === "feeds.read") {
    requireExactInputKeys(input, ["cursor", "feed", "limit"]);
    exactEnumInput(input, "feed", ["marketplace"]);
    const token = optionalOpaqueCursor(input, "cursor");
    const cursor = token === undefined
      ? undefined
      : openFacebookMarketplaceCursor(token, auth, environment);
    return Object.freeze({
      kind: "facebook-marketplace-feed",
      ...(cursor === undefined ? {} : { cursor }),
      limit: integerInput(input, "limit", cursor === undefined ? 30 : 50, 1, 50),
    });
  }
  if (
    recipe.site === "facebook-marketplace"
    && recipe.action === "listings.read"
  ) {
    requireExactInputKeys(input, ["listing_id"]);
    return Object.freeze({
      kind: "facebook-marketplace-listing",
      listingId: exactStringInput(
        input,
        "listing_id",
        /^[1-9][0-9]{0,31}$/u,
        "an exact nonzero Marketplace listing ID",
      ),
    });
  }
  throw new Error(
    `${recipe.site} authenticated web operation ${recipe.action} has no executable reviewed contract`,
  );
}

async function executeInstagramRead(
  prepared: Extract<
    PreparedMetaRead,
    {
      readonly kind:
        | "instagram-feed"
        | "instagram-media"
        | "instagram-comments"
        | "instagram-inbox"
        | "instagram-contacts";
    }
  >,
  client: WebSessionClient,
  viewerId: string,
  maximumBytes: number,
): Promise<unknown> {
  const maxBytes = Math.min(maximumBytes, MAX_API_BYTES);
  if (prepared.kind === "instagram-feed") {
    const url = new URL("/api/v1/feed/timeline/", ORIGINS.instagram);
    url.searchParams.set("count", String(prepared.limit));
    const response = await client.requestJson({
      url,
      method: "GET",
      headers: instagramHeaders(`${ORIGINS.instagram}/`),
      maxBytes,
    });
    return normalizeInstagramFeed(response, prepared.limit);
  }
  if (prepared.kind === "instagram-media") {
    const response = await client.requestJson({
      url: new URL(`/api/v1/media/${prepared.mediaId}/info/`, ORIGINS.instagram),
      method: "GET",
      headers: instagramHeaders(`${ORIGINS.instagram}/`),
      maxBytes,
    });
    return normalizeInstagramPost(response, prepared.mediaId);
  }
  if (prepared.kind === "instagram-comments") {
    const url = new URL(
      `/api/v1/media/${prepared.mediaId}/comments/`,
      ORIGINS.instagram,
    );
    url.searchParams.set("can_support_threading", "true");
    url.searchParams.set("permalink_enabled", "false");
    const response = await client.requestJson({
      url,
      method: "GET",
      headers: instagramHeaders(`${ORIGINS.instagram}/`),
      maxBytes,
    });
    return normalizeInstagramComments(response, prepared.mediaId, prepared.limit);
  }
  if (
    prepared.kind === "instagram-inbox"
    || prepared.kind === "instagram-contacts"
  ) {
    const url = new URL("/api/v1/direct_v2/inbox/", ORIGINS.instagram);
    const threadLimit = prepared.kind === "instagram-inbox"
      ? prepared.limit
      : prepared.threadLimit;
    url.searchParams.set("limit", String(threadLimit));
    url.searchParams.set("thread_message_limit", "1");
    url.searchParams.set("persistentBadging", "true");
    url.searchParams.set("visual_message_return_type", "unseen");
    const response = await client.requestJson({
      url,
      method: "GET",
      headers: instagramHeaders(`${ORIGINS.instagram}/direct/inbox/`),
      maxBytes,
    });
    return prepared.kind === "instagram-inbox"
      ? normalizeInstagramInbox(response, viewerId, prepared.limit)
      : normalizeInstagramContacts(
        response,
        viewerId,
        prepared.threadLimit,
        prepared.contactLimit,
      );
  }
  const exhaustive: never = prepared;
  throw new Error(`Instagram authenticated web operation ${(exhaustive as { kind: string }).kind} is not reviewed`);
}

export async function executeMetaWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: MetaWebRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<WebSessionExecution> {
  if (!isMetaSite(recipe.site)) {
    throw new Error("Meta authenticated web recipe is not installed");
  }
  const contract = operationContract(recipe.site, recipe.action);
  if (contract === null) throw new Error(`Meta authenticated web operation ${recipe.action} is not registered`);
  if (recipe.contractVersion !== contract.contractVersion) {
    throw new Error(
      `${recipe.site} authenticated web operation ${recipe.action} contract version ${recipe.contractVersion} is not installed`,
    );
  }
  if (contract.state !== "observed") {
    throw new Error(`${recipe.site} authenticated web operation ${recipe.action} is capture-required: ${contract.reason}`);
  }
  const isThreadsPost = recipe.site === "threads" && recipe.action === "posts.publish";
  if (
    !isThreadsPost
    && (contract.risk !== "R1" || contract.effect !== "read")
  ) {
    throw new Error(`${recipe.site} reviewed Meta runtime refuses non-read execution`);
  }
  if (!isThreadsPost) {
    void options.beforeDispatch;
    void options.afterDispatchVerified;
  }

  const environment = options.environment ?? process.env;
  const expectedSubject = expectedMetaAuthSubject(recipe.site, auth);
  const prepared = prepareMetaRead(recipe, input, auth, environment);

  const origin = ORIGINS[recipe.site];
  const dependencies = metaWebSessionDependencies(
    recipe.site,
    auth,
    options.dependencies,
  );
  const client = await createWebSessionClient(origin, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(dependencies === undefined ? {} : { dependencies }),
  });
  const viewer = await requireBoundViewer(recipe.site, client, expectedSubject);
  if (prepared.kind === "threads-post") {
    return executeThreadsPost(client, viewer, prepared, {
      ...(options.fileResolver === undefined ? {} : { fileResolver: options.fileResolver }),
      ...(options.operationDeadline === undefined
        ? {}
        : { operationDeadline: options.operationDeadline }),
      ...(options.beforeDispatch === undefined
        ? {}
        : { beforeDispatch: options.beforeDispatch }),
      ...(options.afterDispatchVerified === undefined
        ? {}
        : { afterDispatchVerified: options.afterDispatchVerified }),
      now: options.dependencies?.now ?? Date.now,
    });
  }
  let output: unknown;
  let finalUrl = `${origin}/`;
  if (
    prepared.kind === "instagram-feed"
    || prepared.kind === "instagram-media"
    || prepared.kind === "instagram-comments"
    || prepared.kind === "instagram-inbox"
    || prepared.kind === "instagram-contacts"
  ) {
    output = await executeInstagramRead(
      prepared,
      client,
      viewer.id,
      recipe.maxOutputBytes,
    );
    if (
      prepared.kind === "instagram-inbox"
      || prepared.kind === "instagram-contacts"
    ) {
      finalUrl = `${origin}/direct/inbox/`;
    }
  } else if (prepared.kind === "threads-feed") {
    output = normalizeThreadsFeedHtml(viewer.rootHtml, viewer.id, prepared.limit);
  } else if (prepared.kind === "facebook-feed") {
    output = normalizeFacebookFeedHtml(viewer.rootHtml, viewer.id, prepared.limit);
  } else if (prepared.kind === "facebook-group-feed") {
    const path = `/groups/${encodeURIComponent(prepared.groupId)}/`;
    const html = await metaHtmlPath(client, origin, path, "/groups/");
    output = normalizeFacebookGroupFeedHtml(
      html,
      viewer.id,
      prepared.groupId,
      prepared.limit,
    );
    finalUrl = new URL(path, origin).href;
  } else if (prepared.kind === "facebook-marketplace-feed") {
    const html = await metaHtmlPath(client, origin, "/marketplace/");
    const feed = prepared.cursor === undefined
      ? normalizeFacebookMarketplaceFeedHtml(html, viewer.id, prepared.limit)
      : await executeFacebookMarketplaceContinuation(
        client,
        html,
        viewer.id,
        prepared.cursor,
        prepared.limit,
        recipe,
        options.dependencies,
        options,
      );
    output = sealFacebookMarketplaceFeed(
      feed,
      html,
      viewer.id,
      auth,
      prepared.cursor ?? null,
      environment,
    );
    finalUrl = `${origin}/marketplace/`;
  } else if (prepared.kind === "facebook-marketplace-listing") {
    const path = `/marketplace/item/${encodeURIComponent(prepared.listingId)}/`;
    const html = await metaHtmlPath(client, origin, path, "/marketplace/");
    output = normalizeFacebookMarketplaceListingHtml(
      html,
      viewer.id,
      prepared.listingId,
    );
    finalUrl = new URL(path, origin).href;
  } else {
    const exhaustive: never = prepared;
    throw new Error(
      `Meta authenticated web operation ${(exhaustive as { kind: string }).kind} is not reviewed`,
    );
  }
  return {
    status: "succeeded",
    output,
    finalUrl,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
