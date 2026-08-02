import type { WrenchAuth } from "../auth";
import { canonicalJson, sha256 } from "../canonical-json";
import type { OperationInput, WebSessionRecipe } from "../model";
import { openCursorToken, sealCursorToken } from "../cursor-token";
import {
  createWebSessionClient,
  fetchPublicWebAsset,
  webSessionAuthSubject,
  webSessionCookie,
  type WebSessionClient,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  META_WEB_OPERATIONS,
  META_WEB_OPERATION_NAMES,
  META_WEB_SITES,
  normalizeFacebookFeedHtml,
  normalizeFacebookMarketplaceFeedJsonDocuments,
  normalizeFacebookMarketplaceFeedHtml,
  normalizeFacebookMarketplaceListingHtml,
  normalizeInstagramComments,
  normalizeInstagramFeed,
  normalizeInstagramInbox,
  normalizeInstagramPost,
  normalizeThreadsFeedHtml,
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
const MARKETPLACE_CURSOR_SCOPE = "facebook-marketplace-feed";

export type MetaWebRuntimeDependencies = Partial<WebSessionNetworkDependencies>;

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

function facebookMarketplaceAuthHash(auth: WrenchAuth): string {
  return sha256(canonicalJson(auth));
}

function expectedFacebookViewerId(auth: WrenchAuth): string {
  const subject = webSessionAuthSubject(auth);
  const match = subject?.match(/^facebook:user:([1-9][0-9]{0,31})$/u);
  if (match?.[1] === undefined) {
    throw new Error(
      "Facebook Marketplace pagination requires an exact bound Facebook viewer subject",
    );
  }
  return match[1];
}

function expectedMetaAuthSubject(site: MetaWebSite, auth: WrenchAuth): string {
  const subject = webSessionAuthSubject(auth);
  const pattern = site === "instagram"
    ? /^instagram:[1-9][0-9]{0,31}$/u
    : site === "threads"
      ? /^threads:[1-9][0-9]{0,31}$/u
      : /^facebook:user:[1-9][0-9]{0,31}$/u;
  if (subject === null || !pattern.test(subject)) {
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
  const client = await createWebSessionClient(ORIGINS[site], auth, {
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
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
    readonly kind: "threads-feed";
    readonly limit: number;
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
        | "instagram-inbox";
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
  if (prepared.kind === "instagram-inbox") {
    const url = new URL("/api/v1/direct_v2/inbox/", ORIGINS.instagram);
    url.searchParams.set("limit", String(prepared.limit));
    url.searchParams.set("thread_message_limit", "1");
    url.searchParams.set("persistentBadging", "true");
    url.searchParams.set("visual_message_return_type", "unseen");
    const response = await client.requestJson({
      url,
      method: "GET",
      headers: instagramHeaders(`${ORIGINS.instagram}/direct/inbox/`),
      maxBytes,
    });
    return normalizeInstagramInbox(response, viewerId, prepared.limit);
  }
  const exhaustive: never = prepared;
  throw new Error(`Instagram authenticated web operation ${(exhaustive as { kind: string }).kind} is not reviewed`);
}

export async function executeMetaWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
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
  if (contract.risk !== "R1" || contract.effect !== "read") {
    throw new Error(`${recipe.site} reviewed Meta runtime refuses non-read execution`);
  }
  // No observed operation in this module is a dispatch. Mutation callbacks are
  // intentionally unreachable until a separately reviewed mutation exists.
  void options.beforeDispatch;
  void options.afterDispatchVerified;

  const environment = options.environment ?? process.env;
  const expectedSubject = expectedMetaAuthSubject(recipe.site, auth);
  const prepared = prepareMetaRead(recipe, input, auth, environment);

  const origin = ORIGINS[recipe.site];
  const client = await createWebSessionClient(origin, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.operationDeadline === undefined
      ? {}
      : { operationDeadline: options.operationDeadline }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  const viewer = await requireBoundViewer(recipe.site, client, expectedSubject);
  let output: unknown;
  let finalUrl = `${origin}/`;
  if (
    prepared.kind === "instagram-feed"
    || prepared.kind === "instagram-media"
    || prepared.kind === "instagram-comments"
    || prepared.kind === "instagram-inbox"
  ) {
    output = await executeInstagramRead(
      prepared,
      client,
      viewer.id,
      recipe.maxOutputBytes,
    );
    if (prepared.kind === "instagram-inbox") {
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
