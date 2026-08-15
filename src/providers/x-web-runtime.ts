import {
  parseArticleDraftDocument,
  type ArticleDraftDocument,
} from "../article-draft-document";
import type { WrenchAuth } from "../auth";
import {
  browserCleanupBarrier,
} from "../browser";
import type {
  OperationInput,
  WebSessionRecipe,
} from "../model";
import { canonicalJson } from "../canonical-json";
import {
  createWebSessionClient,
  fetchPublicWebAsset,
  webSessionAuthSubject,
  webSessionCookie,
  type WebSessionClient,
  type WebSessionNetworkDependencies,
} from "../web-session-client";
import {
  startWebSessionCleanupTrackedOperation,
  type WebSessionCleanupBarrierRegistrar,
  type WebSessionDispatchEvent,
  type WebSessionExecution,
  type WebSessionOperationDeadline,
} from "../web-session-execution";
import {
  generateXClientTransactionId,
  type XTransactionBrowserDependencies,
} from "./x-transaction-id";
import {
  assertExactXWebGraphQlBinding,
  authorizeXWebMutationRequest,
  authorizeXWebR1GraphQlRequest,
  bindXWebOperationMetadataValues,
  enforceXWebHeaderSinkPolicy,
  extractXWebGraphQlReadResponseRoot,
  normalizeXWebGraphQlTimelineResponse,
  resolveUniqueXWebBundleDescriptor,
  validateXWebDesiredStateMutation,
  validateXWebRichArticleContentState,
  xWebQueryDescriptorEvidenceSnapshot,
  type XWebBundleQueryDescriptor,
  type XWebOperationType,
  type XWebQueryDescriptorEvidence,
  type XWebSemanticOperationId,
  type XWebMutationOperationId,
} from "./x-web";

const X_ORIGIN = "https://x.com";
const X_ASSET_ORIGIN = "https://abs.twimg.com";
const MAX_HOME_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const DEFAULT_LIMIT = 20;
const MAX_ARTICLE_TITLE_CHARACTERS = 100;
const MAX_ARTICLE_BODY_CHARACTERS = 20_000;
const MAX_ARTICLE_BLOCKS = 2_000;

type JsonRecord = Record<string, unknown>;

export type XWebRuntimeDependencies = Partial<WebSessionNetworkDependencies>
  & Pick<XTransactionBrowserDependencies, "createBrowserSession">;

type XBootstrap = {
  readonly auth: WrenchAuth;
  readonly client: WebSessionClient;
  readonly html: string;
  readonly mainUrl: URL;
  readonly mainText: string;
  readonly bearer: string;
  readonly csrf: string;
  readonly features: ReadonlyMap<string, unknown>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly operationDeadline?: WebSessionOperationDeadline;
  readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
  readonly dependencies?: XWebRuntimeDependencies;
  readonly chunks: Map<string, string>;
  readonly descriptors: Map<string, XWebBundleQueryDescriptor>;
};

type Viewer = { readonly id: string; readonly screenName: string | null };
export type XWebDesiredStateKind = "like" | "bookmark";
export type XWebDesiredStateReadback = {
  readonly kind: XWebDesiredStateKind;
  readonly enabled: boolean;
  readonly postId: string;
};

type FeedRequest = {
  readonly operationId: XWebSemanticOperationId;
  readonly operationName: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly method: "GET" | "POST";
};

const viewerEvidence = Object.freeze({
  operationName: "Viewer",
  operationType: "query" as const,
  queryId: "5XShkXk2oO2J7SYmTu6pvw",
  sourceChunk: "main.e4aca26a.js",
  observedOn: "2026-08-14",
});

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value: unknown, label: string, maximum = 32_768): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r]/u.test(value)) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function optionalStringInput(input: OperationInput, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  return requiredString(value, `input.${name}`);
}

function stringInput(input: OperationInput, name: string): string {
  return requiredString(input[name], `input.${name}`);
}

function threadTexts(input: OperationInput): readonly string[] {
  const value = input.items;
  if (!Array.isArray(value)) throw new Error("input.items must be a string array");
  const texts: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string"
      || item.length === 0
      || item.length > 25_000
      || /[\0\r]/u.test(item)
    ) throw new Error("input.items must be a string array");
    texts.push(item);
  }
  return texts;
}

function booleanInput(input: OperationInput, name: string): boolean {
  const value = input[name];
  if (typeof value !== "boolean") throw new Error(`input.${name} must be boolean`);
  return value;
}

export type XWebRichArticleContentState = {
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
  readonly entity_map: readonly Readonly<Record<string, unknown>>[];
};

/** Build X's current API content-state shape from the provider-neutral document. */
export function buildXWebRichArticleContentState(
  document: ArticleDraftDocument,
): XWebRichArticleContentState {
  const entities: Readonly<Record<string, unknown>>[] = [];
  const blocks: Readonly<Record<string, unknown>>[] = [];
  const blockType = Object.freeze({
    paragraph: "unstyled",
    heading1: "header-one",
    heading2: "header-two",
    blockquote: "blockquote",
    "unordered-list-item": "unordered-list-item",
    "ordered-list-item": "ordered-list-item",
  } as const);
  const styleName = Object.freeze({ bold: "Bold", italic: "Italic", strikethrough: "Strikethrough" } as const);
  for (const [blockIndex, block] of document.blocks.entries()) {
    const key = blockIndex.toString(36).padStart(5, "0");
    const entityRanges = block.links.map((link) => {
      const key = entities.length;
      entities.push(Object.freeze({
        key: `${key}`,
        value: Object.freeze({
          data: Object.freeze({ url: link.url }),
          type: "LINK",
          mutability: "Mutable",
        }),
      }));
      return Object.freeze({ key, offset: link.offset, length: link.length });
    });
    blocks.push(Object.freeze({
      data: Object.freeze({}),
      key,
      text: block.text,
      type: blockType[block.type],
      entity_ranges: Object.freeze(entityRanges),
      inline_style_ranges: Object.freeze(block.styles.map((style) => Object.freeze({
        length: style.length,
        offset: style.offset,
        style: styleName[style.style],
      }))),
    }));
  }
  const contentState = Object.freeze({ blocks: Object.freeze(blocks), entity_map: Object.freeze(entities) });
  validateXWebRichArticleContentState(contentState);
  return contentState;
}

function integerInput(input: OperationInput, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = input[name] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`input.${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function postId(value: unknown, label: string): string {
  const id = requiredString(value, label, 19);
  if (!/^[0-9]{1,19}$/u.test(id)) throw new Error(`${label} must be a 1-19 digit X post ID`);
  return id;
}

function quotedStrings(value: string, label: string): readonly string[] {
  if (value.trim() === "") return [];
  const values = [...value.matchAll(/"([A-Za-z][A-Za-z0-9_]{0,199})"/gu)].map((match) => match[1]!);
  const remainder = value.replace(/"[A-Za-z][A-Za-z0-9_]{0,199}"/gu, "").replaceAll(",", "").trim();
  if (remainder !== "" || new Set(values).size !== values.length) {
    throw new Error(`${label} contained an invalid or duplicate name`);
  }
  return values;
}

export function parseXWebBundleDescriptors(value: string): readonly XWebBundleQueryDescriptor[] {
  if (value.length > MAX_BUNDLE_BYTES) throw new Error("X first-party bundle exceeded its byte limit");
  const descriptors: XWebBundleQueryDescriptor[] = [];
  const pattern = /queryId:"([A-Za-z0-9_-]{8,128})",operationName:"([A-Za-z][A-Za-z0-9_]{1,127})",operationType:"(query|mutation)",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]\}/gu;
  for (const match of value.matchAll(pattern)) {
    descriptors.push(Object.freeze({
      queryId: match[1]!,
      operationName: match[2]!,
      operationType: match[3] as XWebOperationType,
      metadata: Object.freeze({
        featureSwitches: Object.freeze(quotedStrings(match[4]!, "X featureSwitches")),
        fieldToggles: Object.freeze(quotedStrings(match[5]!, "X fieldToggles")),
      }),
    }));
  }
  if (descriptors.length < 1) throw new Error("X first-party bundle contained no reviewed query descriptors");
  return Object.freeze(descriptors);
}

function currentMainUrl(html: string): URL {
  const urls = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[A-Za-z0-9_-]+\.js)"/gu)) {
    if (match[1] !== undefined) urls.add(match[1]);
  }
  if (urls.size !== 1) throw new Error("X bootstrap did not expose one unique current main bundle");
  return new URL(urls.values().next().value!);
}

function sourceChunkLogicalName(sourceChunk: string): string {
  const match = /^([A-Za-z0-9_~.-]{1,240})\.[a-f0-9]{8}\.js$/u.exec(sourceChunk);
  if (match?.[1] === undefined) throw new Error("X revision evidence source chunk is not a reviewed hashed JavaScript asset");
  return match[1];
}

function matchesReviewedChunkFamily(currentName: string, reviewedName: string): boolean {
  return currentName === reviewedName
    || currentName.startsWith(`${reviewedName}~`)
    || reviewedName.startsWith(`${currentName}~`);
}

function setUniqueChunkMapValue(
  target: Map<string, string>,
  id: string,
  value: string,
  label: "name" | "hash",
): void {
  if (target.has(id)) throw new Error(`X bootstrap contained a duplicate webpack chunk ${label}`);
  target.set(id, value);
}

/** Resolve a reviewed logical chunk through the current page's webpack map. */
export function resolveCurrentXWebChunkUrl(html: string, sourceChunk: string): URL {
  if (html.length > MAX_HOME_BYTES) throw new Error("X bootstrap exceeded its byte limit");
  const logicalName = sourceChunkLogicalName(sourceChunk);
  const start = html.indexOf("p.u=e=>");
  const separator = "})[e]||e)+\".\"+({";
  const middle = start < 0 ? -1 : html.indexOf(separator, start);
  const suffix = middle < 0 ? -1 : html.indexOf("})[e]+\"a.js\"", middle + separator.length);
  if (start < 0 || middle < 0 || suffix < 0 || suffix - start > 256 * 1024) {
    throw new Error("X bootstrap omitted its bounded current webpack chunk map");
  }
  const names = new Map<string, string>();
  for (const match of html.slice(start, middle).matchAll(/(?:\{|,)([0-9A-Za-z]+):"([A-Za-z0-9_~.-]{1,240})"/gu)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      setUniqueChunkMapValue(names, match[1], match[2], "name");
    }
  }
  // X may append or remove a `~bundle.*` member when it rebalances a shared
  // chunk while retaining the reviewed chunk family and operation descriptor.
  // Accept only a segment-boundary prefix relationship; a substring or a
  // merely similar bundle name is not sufficient.
  const exactChunks = [...names].filter(([, name]) => name === logicalName);
  const matchingChunks = exactChunks.length === 1
    ? exactChunks
    : [...names].filter(([, name]) => matchesReviewedChunkFamily(name, logicalName));
  if (matchingChunks.length !== 1) throw new Error("X current build did not bind one unique reviewed logical chunk");
  const hashes = new Map<string, string>();
  const hashStart = middle + separator.length;
  for (const match of html.slice(hashStart, suffix).matchAll(/(?:^|,)([0-9A-Za-z]+):"([a-f0-9]{7})"/gu)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      setUniqueChunkMapValue(hashes, match[1], match[2], "hash");
    }
  }
  const [id, currentName] = matchingChunks[0]!;
  const hash = hashes.get(id);
  if (hash === undefined) throw new Error("X current build omitted the reviewed logical chunk hash");
  return new URL(`/responsive-web/client-web/${currentName}.${hash}a.js`, X_ASSET_ORIGIN);
}

function currentBearer(mainText: string): string {
  const values = new Set<string>();
  for (const match of mainText.matchAll(/AAAA[A-Za-z0-9._~+/%=-]{80,250}/gu)) {
    try {
      const decoded = decodeURIComponent(match[0]);
      if (/^AAAA[A-Za-z0-9._~+/=-]{80,250}$/u.test(decoded)) values.add(decoded);
    } catch {
      // Ignore malformed public bundle literals.
    }
  }
  if (values.size !== 1) throw new Error("X bootstrap did not expose one unique current web authorization value");
  return values.values().next().value!;
}

function currentFeatureConfig(html: string): ReadonlyMap<string, unknown> {
  const prefix = "window.__INITIAL_STATE__=";
  const start = html.indexOf(prefix);
  if (start < 0 || html.indexOf(prefix, start + prefix.length) >= 0) {
    throw new Error("X bootstrap did not expose one unique initial-state payload");
  }
  const jsonStart = start + prefix.length;
  const jsonEnd = html.indexOf(";window.__META_DATA__=", jsonStart);
  if (jsonEnd < jsonStart || jsonEnd - jsonStart > MAX_HOME_BYTES) {
    throw new Error("X bootstrap initial-state payload exceeded its reviewed boundary");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(html.slice(jsonStart, jsonEnd)) as unknown;
  } catch {
    throw new Error("X bootstrap returned malformed initial-state JSON");
  }
  const root = record(parsed, "X initial state");
  const featureSwitch = record(root.featureSwitch, "X initial state.featureSwitch");
  const user = record(featureSwitch.user, "X initial state.featureSwitch.user");
  const config = record(user.config, "X initial state.featureSwitch.user.config");
  if (Object.keys(config).length > 10_000) throw new Error("X user feature configuration exceeded its reviewed limit");
  return new Map(Object.entries(config));
}

async function bootstrapX(
  auth: WrenchAuth,
  recipe: WebSessionRecipe,
  dependencies?: XWebRuntimeDependencies,
  budget: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
  } = {},
): Promise<XBootstrap> {
  const client = await createWebSessionClient(X_ORIGIN, auth, {
    timeoutMs: recipe.timeoutMs,
    ...(budget.signal === undefined ? {} : { signal: budget.signal }),
    ...(budget.operationDeadline === undefined
      ? {}
      : { operationDeadline: budget.operationDeadline }),
    ...(dependencies === undefined ? {} : { dependencies }),
  });
  const csrf = webSessionCookie(client.cookies, "ct0");
  if (!/^[A-Za-z0-9_-]{16,512}$/u.test(csrf)) throw new Error("X ct0 session cookie is invalid or expired");
  const html = await client.requestText({
    url: new URL("/home", X_ORIGIN),
    headers: { accept: "text/html" },
    expectedContentTypes: ["text/html"],
    maxBytes: MAX_HOME_BYTES,
  });
  const mainUrl = currentMainUrl(html);
  const mainText = await fetchPublicWebAsset(mainUrl, {
    allowedOrigin: X_ASSET_ORIGIN,
    contentTypes: ["application/javascript", "text/javascript"],
    maxBytes: MAX_BUNDLE_BYTES,
    timeoutMs: recipe.timeoutMs,
    ...(budget.signal === undefined ? {} : { signal: budget.signal }),
    ...(budget.operationDeadline === undefined
      ? {}
      : { operationDeadline: budget.operationDeadline }),
    ...(dependencies === undefined ? {} : { dependencies }),
  });
  return {
    auth,
    client,
    html,
    mainUrl,
    mainText,
    bearer: currentBearer(mainText),
    csrf,
    features: currentFeatureConfig(html),
    timeoutMs: recipe.timeoutMs,
    maxOutputBytes: recipe.maxOutputBytes,
    ...(budget.signal === undefined ? {} : { signal: budget.signal }),
    ...(budget.operationDeadline === undefined
      ? {}
      : { operationDeadline: budget.operationDeadline }),
    ...(budget.registerCleanupBarrier === undefined
      ? {}
      : { registerCleanupBarrier: budget.registerCleanupBarrier }),
    ...(dependencies === undefined ? {} : { dependencies }),
    chunks: new Map([[mainUrl.pathname.split("/").at(-1)!, mainText]]),
    descriptors: new Map(),
  };
}

function descriptorEvidence(operationName: string, operationType: XWebOperationType): XWebQueryDescriptorEvidence {
  const matches = xWebQueryDescriptorEvidenceSnapshot.descriptors.filter((candidate) =>
    candidate.operationName === operationName && candidate.operationType === operationType);
  if (matches.length !== 1) throw new Error(`X ${operationName} has no unique reviewed revision evidence`);
  return matches[0]!;
}

async function sourceText(bootstrap: XBootstrap, evidence: XWebQueryDescriptorEvidence): Promise<string> {
  return currentChunkText(bootstrap, evidence.sourceChunk);
}

async function currentChunkText(bootstrap: XBootstrap, sourceChunk: string): Promise<string> {
  if (sourceChunk.startsWith("main.")) return bootstrap.mainText;
  const cached = bootstrap.chunks.get(sourceChunk);
  if (cached !== undefined) return cached;
  const currentUrl = resolveCurrentXWebChunkUrl(bootstrap.html, sourceChunk);
  const text = await fetchPublicWebAsset(
    currentUrl,
    {
      allowedOrigin: X_ASSET_ORIGIN,
      contentTypes: ["application/javascript", "text/javascript"],
      maxBytes: MAX_BUNDLE_BYTES,
      timeoutMs: bootstrap.timeoutMs,
      ...(bootstrap.signal === undefined ? {} : { signal: bootstrap.signal }),
      ...(bootstrap.operationDeadline === undefined
        ? {}
        : { operationDeadline: bootstrap.operationDeadline }),
      ...(bootstrap.dependencies === undefined ? {} : { dependencies: bootstrap.dependencies }),
    },
  );
  bootstrap.chunks.set(sourceChunk, text);
  return text;
}

const articleRichContractEvidence = Object.freeze({
  entities: "shared~bundle.TwitterArticles~ondemand.Verified~bundle.SettingsExtendedProfile~bundle.WorkHistory.d1314bba.js",
  converter: "shared~bundle.Grok~bundle.GrokDrawer~bundle.ReaderMode~bundle.Birdwatch~bundle.TwitterArticles~bundle.Compose.02f6dc7a.js",
  observedOn: "2026-08-14",
});

function requireCurrentBundleTokens(text: string, tokens: readonly string[], label: string): void {
  if (tokens.some((token) => !text.includes(token))) {
    throw new Error(`X current ${label} bundle drifted outside the reviewed rich Article contract`);
  }
}

async function assertCurrentArticleRichContract(bootstrap: XBootstrap): Promise<void> {
  const [entities, converter] = await Promise.all([
    currentChunkText(bootstrap, articleRichContractEvidence.entities),
    currentChunkText(bootstrap, articleRichContractEvidence.converter),
  ]);
  requireCurrentBundleTokens(entities, [
    'createEntity(w.Sg,"MUTABLE",{url:',
  ], "Article entity");
  requireCurrentBundleTokens(converter, [
    'mutability:s[r.mutability]',
    'inline_style_ranges:',
  ], "Article content converter");
}

async function resolveDescriptor(
  bootstrap: XBootstrap,
  operationName: string,
  operationType: XWebOperationType,
  explicitEvidence?: XWebQueryDescriptorEvidence,
): Promise<XWebBundleQueryDescriptor> {
  const key = `${operationName}:${operationType}`;
  const cached = bootstrap.descriptors.get(key);
  if (cached !== undefined) return cached;
  const evidence = explicitEvidence ?? descriptorEvidence(operationName, operationType);
  const descriptor = resolveUniqueXWebBundleDescriptor(
    parseXWebBundleDescriptors(await sourceText(bootstrap, evidence)),
    evidence,
  );
  bootstrap.descriptors.set(key, descriptor);
  return descriptor;
}

function featureValue(bootstrap: XBootstrap, name: string): boolean {
  const entry = bootstrap.features.get(name);
  if (entry === undefined) return false;
  if (!isRecord(entry) || typeof entry.value !== "boolean") {
    throw new Error(`X user feature configuration changed type for feature ${name}`);
  }
  return entry.value;
}

function fieldToggleValue(bootstrap: XBootstrap, name: string): boolean {
  if (name === "withArticlePlainText" || name === "withPayments" || name === "withAuxiliaryUserLabels" || name === "isDelegate") {
    return false;
  }
  if (name === "withArticleRichContentState") {
    return featureValue(bootstrap, "responsive_web_twitter_article_seed_tweet_detail_enabled");
  }
  if (name === "withArticleSummaryText" || name === "withArticleVoiceOver") {
    return featureValue(bootstrap, "responsive_web_grok_article_summary_enabled");
  }
  if (name === "withGrokAnalyze") return featureValue(bootstrap, "subscriptions_inapp_grok_analyze");
  if (name === "withDisallowedReplyControls") {
    return featureValue(bootstrap, "disallowed_reply_controls_callout_enabled");
  }
  throw new Error(`X field toggle ${name} requires fresh reviewed evidence`);
}

function operationMetadata(bootstrap: XBootstrap, descriptor: XWebBundleQueryDescriptor): {
  readonly features: Readonly<Record<string, boolean>>;
  readonly fieldToggles: Readonly<Record<string, boolean>>;
} {
  const features = Object.fromEntries(descriptor.metadata.featureSwitches.map((name) => [name, featureValue(bootstrap, name)]));
  const fieldToggles: Record<string, boolean> = {};
  for (const name of descriptor.metadata.fieldToggles) {
    fieldToggles[name] = fieldToggleValue(bootstrap, name);
  }
  return bindXWebOperationMetadataValues(descriptor, { features, fieldToggles });
}

function xHeaders(
  bootstrap: XBootstrap,
  json: boolean,
  transactionId?: string,
): Readonly<Record<string, string>> {
  const fixed = enforceXWebHeaderSinkPolicy({
    source: "code",
    sink: "network-request",
    headers: {
      accept: "application/json",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      ...(json ? { "content-type": "application/json" } : {}),
    },
  }).values;
  const session = enforceXWebHeaderSinkPolicy({
    source: "in-origin-session",
    sink: "network-request",
    headers: {
      authorization: `Bearer ${bootstrap.bearer}`,
      "x-csrf-token": bootstrap.csrf,
      ...(transactionId === undefined ? {} : { "x-client-transaction-id": transactionId }),
    },
  }).values;
  return { ...fixed, ...session, referer: `${X_ORIGIN}/` };
}

async function graphQl(
  bootstrap: XBootstrap,
  descriptor: XWebBundleQueryDescriptor,
  variables: Readonly<Record<string, unknown>>,
  method: "GET" | "POST",
  readOperation?: XWebSemanticOperationId,
  mutationOperation?: XWebMutationOperationId,
  beforeRequest?: () => Promise<void>,
): Promise<unknown> {
  const metadata = operationMetadata(bootstrap, descriptor);
  const url = new URL(`/i/api/graphql/${descriptor.queryId}/${descriptor.operationName}`, X_ORIGIN);
  let body: string | undefined;
  if (method === "GET") {
    url.searchParams.set("variables", JSON.stringify(variables));
    if (Object.keys(metadata.features).length > 0) url.searchParams.set("features", JSON.stringify(metadata.features));
    if (Object.keys(metadata.fieldToggles).length > 0) url.searchParams.set("fieldToggles", JSON.stringify(metadata.fieldToggles));
  } else {
    body = JSON.stringify({
      variables,
      features: metadata.features,
      ...(Object.keys(metadata.fieldToggles).length === 0 ? {} : { fieldToggles: metadata.fieldToggles }),
      queryId: descriptor.queryId,
    });
  }
  let mutationBinding: ReturnType<typeof authorizeXWebMutationRequest> | null = null;
  if (mutationOperation !== undefined) {
    mutationBinding = authorizeXWebMutationRequest(
      mutationOperation,
      { url, method, descriptor, ...(body === undefined ? {} : { body }) },
    );
  } else if (readOperation === undefined) {
    assertExactXWebGraphQlBinding({ url, method, descriptor, ...(body === undefined ? {} : { body }) });
  } else {
    authorizeXWebR1GraphQlRequest(readOperation, { url, method, descriptor, ...(body === undefined ? {} : { body }) });
  }
  let transactionId: string | undefined;
  if (mutationBinding !== null) {
    const transaction = startWebSessionCleanupTrackedOperation(
      bootstrap.registerCleanupBarrier,
      (publishCleanupResource) => generateXClientTransactionId({
        auth: bootstrap.auth,
        mainBundleText: bootstrap.mainText,
        mainBundleUrl: bootstrap.mainUrl,
        method: "POST",
        path: mutationBinding.path,
        timeoutMs: bootstrap.timeoutMs,
        maxOutputBytes: bootstrap.maxOutputBytes,
        ...(bootstrap.operationDeadline === undefined
          ? {}
          : { operationDeadline: bootstrap.operationDeadline }),
        ...(publishCleanupResource === undefined
          ? {}
          : { publishCleanupResource }),
        dependencies: {
          ...(bootstrap.dependencies?.createBrowserSession === undefined
            ? {}
            : { createBrowserSession: bootstrap.dependencies.createBrowserSession }),
          ...(bootstrap.dependencies?.acquireCookies === undefined
            ? {}
            : { acquireCookieRecords: bootstrap.dependencies.acquireCookies }),
        },
      }),
      browserCleanupBarrier,
    );
    transactionId = await transaction;
  }
  await beforeRequest?.();
  return bootstrap.client.requestJson({
    url,
    method,
    headers: xHeaders(bootstrap, body !== undefined, transactionId),
    ...(body === undefined ? {} : { body }),
    maxBytes: bootstrap.maxOutputBytes,
  });
}

async function viewer(bootstrap: XBootstrap): Promise<Viewer> {
  const descriptor = await resolveDescriptor(bootstrap, "Viewer", "query", viewerEvidence);
  const response = record(await graphQl(bootstrap, descriptor, {}, "GET"), "X Viewer response");
  if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) {
    throw new Error("X Viewer response contained provider errors");
  }
  const data = record(response.data, "X Viewer response.data");
  const viewerRoot = record(data.viewer, "X Viewer response.data.viewer");
  const userResults = record(viewerRoot.user_results, "X Viewer user_results");
  const result = record(userResults.result, "X Viewer result");
  const id = postId(result.rest_id, "X Viewer rest_id");
  const core = isRecord(result.core) ? result.core : null;
  const legacy = isRecord(result.legacy) ? result.legacy : null;
  const screenName = typeof core?.screen_name === "string"
    ? core.screen_name
    : typeof legacy?.screen_name === "string" ? legacy.screen_name : null;
  return { id, screenName };
}

export async function probeXWebSubject(
  auth: WrenchAuth,
  options: {
    readonly timeoutMs?: number;
    readonly dependencies?: XWebRuntimeDependencies;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const bootstrap = await bootstrapX(auth, {
    site: "x",
    action: "feeds.read",
    contractVersion: 1,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
  }, options.dependencies, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return (await viewer(bootstrap)).id;
}

async function requireBoundViewer(bootstrap: XBootstrap, auth: WrenchAuth): Promise<Viewer> {
  const expected = webSessionAuthSubject(auth);
  if (expected === null) {
    throw new Error("X personalized operations require an auth locator bound to the exact viewer subject");
  }
  const current = await viewer(bootstrap);
  if (current.id !== expected) throw new Error("X browser session viewer no longer matches the confirmed auth subject");
  return current;
}

function feedRequest(bootstrap: XBootstrap, input: OperationInput): FeedRequest {
  const feed = stringInput(input, "feed");
  const count = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const cursor = optionalStringInput(input, "cursor");
  const withCursor = (value: Record<string, unknown>): Readonly<Record<string, unknown>> =>
    cursor === undefined ? value : { ...value, cursor };
  if (feed === "for-you") {
    return {
      operationId: "feeds.for-you",
      operationName: "HomeTimeline",
      method: "GET",
      variables: withCursor({ count, includePromotedContent: false, latestControlAvailable: true, requestContext: "launch", withCommunity: true }),
    };
  }
  if (feed === "following") {
    return {
      operationId: "feeds.following",
      operationName: "HomeLatestTimeline",
      method: "POST",
      variables: withCursor({ count, includePromotedContent: false, latestControlAvailable: true, requestContext: "launch", seenTweetIds: [] }),
    };
  }
  if (feed === "bookmarks") {
    return {
      operationId: "feeds.bookmarks",
      operationName: "Bookmarks",
      method: "GET",
      variables: withCursor({ count, includePromotedContent: false }),
    };
  }
  if (feed === "list") {
    const listId = postId(input.list_id, "input.list_id");
    return {
      operationId: "feeds.list-latest",
      operationName: "ListLatestTweetsTimeline",
      method: "GET",
      variables: withCursor({ listId, count }),
    };
  }
  if (feed === "user") {
    const userId = postId(input.user_id, "input.user_id");
    return {
      operationId: "feeds.user",
      operationName: "UserTweets",
      method: "GET",
      variables: withCursor({
        userId,
        count,
        includePromotedContent: true,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: featureValue(bootstrap, "voice_consumption_enabled"),
      }),
    };
  }
  if (feed === "search") {
    const rawQuery = stringInput(input, "query");
    return {
      operationId: "feeds.search",
      operationName: "SearchTimeline",
      method: "GET",
      variables: withCursor({ rawQuery, count, querySource: "typed_query", product: "Latest" }),
    };
  }
  throw new Error("input.feed is not an implemented X internal feed");
}

function assertFeedTargetBound(
  request: FeedRequest,
  input: OperationInput,
  response: unknown,
): void {
  if (request.operationId !== "feeds.user" && request.operationId !== "feeds.list-latest") return;
  const data = graphQlData(response, `X ${request.operationId} response`);
  if (request.operationId === "feeds.user") {
    const expected = postId(input.user_id, "input.user_id");
    const user = record(data.user, "X user feed response.data.user");
    const result = record(user.result, "X user feed response.data.user.result");
    if (postId(result.rest_id, "X user feed response rest_id") !== expected) {
      throw new Error("X user feed response did not bind the requested user");
    }
    return;
  }

  const expected = postId(input.list_id, "input.list_id");
  const list = record(data.list, "X List feed response.data.list");
  const returnedIds = new Set<string>();
  for (const field of ["rest_id", "id_str", "id"] as const) {
    if (list[field] === undefined) continue;
    returnedIds.add(postId(list[field], `X List feed response ${field}`));
  }
  if (returnedIds.size !== 1 || !returnedIds.has(expected)) {
    throw new Error("X List feed response did not bind the requested List");
  }
}

function requireCompleteProviderPage<T>(items: readonly T[], limit: number, label: string): readonly T[] {
  if (items.length > limit) {
    throw new Error(`${label} returned more entries than the requested limit; no continuation cursor was exposed`);
  }
  return items;
}

function normalizedPost(item: ReturnType<typeof normalizeXWebGraphQlTimelineResponse>["items"][number]): Readonly<Record<string, unknown>> {
  if (item.kind !== "tweet") return item;
  const legacy = item.legacy;
  return Object.freeze({
    kind: "post",
    id: item.tweetId,
    text: typeof legacy?.full_text === "string" ? legacy.full_text : "",
    createdAt: typeof legacy?.created_at === "string" ? legacy.created_at : null,
    authorId: typeof legacy?.user_id_str === "string" ? legacy.user_id_str : null,
    replyToPostId: typeof legacy?.in_reply_to_status_id_str === "string" ? legacy.in_reply_to_status_id_str : null,
    liked: typeof legacy?.favorited === "boolean" ? legacy.favorited : null,
    reposted: typeof legacy?.retweeted === "boolean" ? legacy.retweeted : null,
    saved: typeof legacy?.bookmarked === "boolean" ? legacy.bookmarked : null,
    metrics: {
      replies: typeof legacy?.reply_count === "number" ? legacy.reply_count : null,
      reposts: typeof legacy?.retweet_count === "number" ? legacy.retweet_count : null,
      likes: typeof legacy?.favorite_count === "number" ? legacy.favorite_count : null,
      bookmarks: typeof legacy?.bookmark_count === "number" ? legacy.bookmark_count : null,
    },
    url: `${X_ORIGIN}/i/status/${item.tweetId}`,
  });
}

async function readFeed(bootstrap: XBootstrap, input: OperationInput): Promise<unknown> {
  const request = feedRequest(bootstrap, input);
  const descriptor = await resolveDescriptor(bootstrap, request.operationName, "query");
  const response = await graphQl(bootstrap, descriptor, request.variables, request.method, request.operationId);
  assertFeedTargetBound(request, input, response);
  const normalized = normalizeXWebGraphQlTimelineResponse(request.operationId, response);
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const posts = normalized.items.map(normalizedPost).filter((row) => row.kind === "post");
  return {
    posts: requireCompleteProviderPage(posts, limit, "X feed page"),
    cursor: normalized.cursors.bottom?.value ?? null,
    terminatedDirections: normalized.terminatedDirections,
  };
}

function tweetDetailVariables(bootstrap: XBootstrap, id: string, input: OperationInput): Readonly<Record<string, unknown>> {
  const cursor = optionalStringInput(input, "cursor");
  return {
    focalTweetId: id,
    referrer: "tweet",
    with_rux_injections: false,
    includePromotedContent: false,
    rankingMode: "Recency",
    withCommunity: featureValue(bootstrap, "c9s_enabled"),
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: featureValue(bootstrap, "responsive_web_birdwatch_consumption_enabled"),
    withVoice: featureValue(bootstrap, "voice_consumption_enabled"),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function readConversation(bootstrap: XBootstrap, input: OperationInput, commentsOnly: boolean): Promise<unknown> {
  const id = postId(input.post_id, "input.post_id");
  const descriptor = await resolveDescriptor(bootstrap, "TweetDetail", "query");
  const response = await graphQl(bootstrap, descriptor, tweetDetailVariables(bootstrap, id, input), "GET", "posts.detail");
  const normalized = normalizeXWebGraphQlTimelineResponse("posts.detail", response);
  const posts = normalized.items.map(normalizedPost).filter((row) => row.kind === "post");
  const root = posts.find((row) => row.id === id);
  if (root === undefined) throw new Error("X TweetDetail response did not contain the requested focal post");
  if (!commentsOnly) return { post: root };
  const limit = integerInput(input, "limit", DEFAULT_LIMIT, 1, 100);
  const descendants: Readonly<Record<string, unknown>>[] = [];
  const acceptedIds = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of posts) {
      if (row.id === id || acceptedIds.has(row.id as string)) continue;
      if (typeof row.replyToPostId !== "string" || !acceptedIds.has(row.replyToPostId)) continue;
      acceptedIds.add(row.id as string);
      descendants.push(row);
      changed = true;
    }
  }
  return {
    comments: requireCompleteProviderPage(descendants, limit, "X conversation page"),
    cursor: normalized.cursors.bottom?.value ?? null,
  };
}

function graphQlData(value: unknown, label: string): JsonRecord {
  const body = record(value, label);
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors) || body.errors.length > 0) throw new Error(`${label} contained provider errors`);
  }
  return record(body.data, `${label}.data`);
}

function unwrapTweet(value: unknown, label: string): JsonRecord {
  let result = record(value, label);
  if (isRecord(result.tweet)) result = result.tweet;
  if (result.__typename === "TweetWithVisibilityResults" && isRecord(result.tweet)) result = result.tweet;
  return result;
}

async function tweetReadback(bootstrap: XBootstrap, id: string): Promise<JsonRecord> {
  const descriptor = await resolveDescriptor(bootstrap, "TweetResultByRestId", "query");
  const response = await graphQl(bootstrap, descriptor, {
    tweetId: id,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  }, "GET", "posts.by-id");
  const result = unwrapTweet(extractXWebGraphQlReadResponseRoot("posts.by-id", response), "X post readback result");
  if (postId(result.rest_id, "X post readback rest_id") !== id) {
    throw new Error("X desired-state readback did not bind the requested post");
  }
  return result;
}

async function desiredStateReadback(
  bootstrap: XBootstrap,
  id: string,
  kind: XWebDesiredStateKind | "repost",
): Promise<boolean> {
  const result = await tweetReadback(bootstrap, id);
  const legacy = record(result.legacy, "X desired-state readback legacy");
  const actual = kind === "like"
    ? legacy.favorited
    : kind === "bookmark" ? legacy.bookmarked : legacy.retweeted;
  if (typeof actual !== "boolean") {
    throw new Error(`X desired-state readback omitted the exact ${kind} boolean`);
  }
  return actual;
}

/**
 * Independently observe one X desired-state mutation target. This path only
 * performs the reviewed viewer and TweetResultByRestId reads; it cannot resolve
 * a mutation descriptor, create a transaction ID, or submit a provider write.
 */
export async function readXWebDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly dependencies?: XWebRuntimeDependencies;
  } = {},
): Promise<XWebDesiredStateReadback> {
  if (recipe.site !== "x" || (recipe.action !== "likes.set" && recipe.action !== "content.save")) {
    throw new Error("X recovery readback supports only likes.set and content.save");
  }
  const bootstrap = await bootstrapX(auth, recipe, options.dependencies);
  await requireBoundViewer(bootstrap, auth);
  const id = postId(input.post_id, "input.post_id");
  const kind: XWebDesiredStateKind = recipe.action === "likes.set" ? "like" : "bookmark";
  return {
    kind,
    enabled: await desiredStateReadback(bootstrap, id, kind),
    postId: id,
  };
}

export async function readXWebArticleDraftDesiredState(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly dependencies?: XWebRuntimeDependencies;
  } = {},
): Promise<{
  readonly matches: boolean;
  readonly draftId: string;
}> {
  if (
    recipe.site !== "x"
    || recipe.action !== "articles.draft.save"
    || recipe.contractVersion !== 1
  ) {
    throw new Error("X Article draft recovery supports only articles.draft.save@1");
  }
  const draftId = postId(input.draft_id, "input.draft_id");
  const title = requiredString(
    input.title,
    "input.title",
    MAX_ARTICLE_TITLE_CHARACTERS,
  );
  const document = parseArticleDraftDocument(input.document, {
    maximumBlocks: MAX_ARTICLE_BLOCKS,
    maximumCharacters: MAX_ARTICLE_BODY_CHARACTERS,
  });
  const expectedContent = buildXWebRichArticleContentState(document);
  const bootstrap = await bootstrapX(auth, recipe, options.dependencies);
  const currentViewer = await requireBoundViewer(bootstrap, auth);
  const article = await readArticleDraft(bootstrap, draftId);
  requirePrivateDraftArticle(article, draftId, currentViewer.id);
  const actualContent = normalizeArticleContentReadback(article.content_state);
  return {
    matches: article.title === title
      && canonicalJson(actualContent) === canonicalJson(expectedContent),
    draftId,
  };
}

function createdTweet(
  response: unknown,
  expectedText: string,
  replyTo: string | null,
  quote: string | null,
  expectedAuthorId: string,
): { readonly id: string; readonly url: string } {
  const data = graphQlData(response, "X CreateTweet response");
  const create = record(data.create_tweet, "X CreateTweet response.create_tweet");
  const results = record(create.tweet_results, "X CreateTweet response.tweet_results");
  const result = unwrapTweet(results.result, "X CreateTweet response.result");
  const id = postId(result.rest_id, "X created post rest_id");
  const legacy = record(result.legacy, "X created post legacy");
  const returnedText = typeof legacy.full_text === "string"
    ? legacy.full_text
    : isRecord(result.note_tweet) && isRecord(result.note_tweet.note_tweet_results)
      && isRecord(result.note_tweet.note_tweet_results.result)
      && typeof result.note_tweet.note_tweet_results.result.text === "string"
      ? result.note_tweet.note_tweet_results.result.text
      : null;
  if (returnedText !== expectedText) throw new Error("X created post response did not bind the confirmed text");
  if (legacy.user_id_str !== expectedAuthorId) throw new Error("X created post response did not bind the confirmed viewer");
  const returnedReply = typeof legacy.in_reply_to_status_id_str === "string" ? legacy.in_reply_to_status_id_str : null;
  if (returnedReply !== replyTo) throw new Error("X created post response did not bind the confirmed reply target");
  const returnedQuote = typeof legacy.quoted_status_id_str === "string" ? legacy.quoted_status_id_str : null;
  if (returnedQuote !== quote) throw new Error("X created post response did not bind the confirmed quote target");
  return { id, url: `${X_ORIGIN}/i/status/${id}` };
}

function createTweetVariables(text: string, replyTo: string | null, quote: string | null): Readonly<Record<string, unknown>> {
  return {
    tweet_text: text,
    dark_request: false,
    media: { media_entities: [], possibly_sensitive: false },
    semantic_annotation_ids: [],
    ...(replyTo === null ? {} : { reply: { in_reply_to_tweet_id: replyTo, exclude_reply_user_ids: [] } }),
    ...(quote === null ? {} : { attachment_url: `${X_ORIGIN}/i/status/${quote}` }),
  };
}

function articleEntityResult(response: unknown, rootName: string, label: string): JsonRecord {
  const data = graphQlData(response, label);
  const root = record(data[rootName], `${label}.${rootName}`);
  if (isRecord(root.result)) return record(root.result, `${label}.${rootName}.result`);
  if (isRecord(root.article_entity_results)) {
    const results = record(root.article_entity_results, `${label}.${rootName}.article_entity_results`);
    return record(results.result, `${label}.${rootName}.article_entity_results.result`);
  }
  return root;
}

function responseBoundArticle(
  response: unknown,
  rootName: string,
  expectedId: string | null,
  expectedTitle?: string,
): JsonRecord {
  const article = articleEntityResult(response, rootName, `X ${rootName} response`);
  const id = postId(article.rest_id, `X ${rootName} response rest_id`);
  if (expectedId !== null && id !== expectedId) {
    throw new Error(`X ${rootName} response changed the confirmed Article draft`);
  }
  if (expectedTitle !== undefined && article.title !== expectedTitle) {
    throw new Error(`X ${rootName} response did not bind the confirmed title`);
  }
  return article;
}

function articleAuthorId(article: JsonRecord): string {
  const metadata = record(article.metadata, "X Article metadata");
  const authorResults = record(metadata.author_results, "X Article metadata.author_results");
  const author = record(authorResults.result, "X Article metadata.author_results.result");
  return postId(author.rest_id, "X Article author rest_id");
}

function requirePrivateDraftArticle(
  article: JsonRecord,
  expectedId: string,
  expectedViewerId: string,
): void {
  if (postId(article.rest_id, "X Article rest_id") !== expectedId) {
    throw new Error("X Article readback changed the confirmed draft ID");
  }
  if (articleAuthorId(article) !== expectedViewerId) {
    throw new Error("X Article draft does not belong to the bound viewer");
  }
  const lifecycle = record(article.lifecycle_state, "X Article lifecycle_state");
  if (lifecycle.lifecycle !== "Draft") {
    throw new Error("X Article target must remain an unpublished private draft");
  }
}

function normalizedArticleEntityKey(value: unknown, label: string): string {
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_ARTICLE_BLOCKS
  ) {
    return `${value}`;
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,3})$/u.test(value)) {
    return value;
  }
  throw new Error(`${label} is not one bounded Article entity key`);
}

function articleReadbackEntityKeyMap(
  values: readonly unknown[],
  blocks: readonly unknown[],
  rangesKey: "entity_ranges" | "entityRanges",
): ReadonlyMap<string, string> {
  const known = new Set<string>();
  values.forEach((value, index) => {
    const entity = record(value, `X Article readback entity ${index}`);
    const source = normalizedArticleEntityKey(
      entity.key,
      `X Article readback entity ${index}.key`,
    );
    if (known.has(source)) {
      throw new Error("X Article readback repeated one entity key");
    }
    known.add(source);
  });
  const result = new Map<string, string>();
  blocks.forEach((value, blockIndex) => {
    const block = record(value, `X Article readback block ${blockIndex + 1}`);
    const ranges = block[rangesKey];
    if (!Array.isArray(ranges)) {
      throw new Error("X Article readback block ranges changed shape");
    }
    ranges.forEach((value) => {
      const range = record(value, "X Article readback entity range");
      const source = normalizedArticleEntityKey(
        range.key,
        "X Article readback entity range key",
      );
      if (!known.has(source)) {
        throw new Error("X Article readback range referenced an unknown entity");
      }
      if (result.has(source)) {
        throw new Error("X Article readback repeated one entity reference");
      }
      result.set(source, `${result.size}`);
    });
  });
  if (result.size !== values.length) {
    throw new Error("X Article readback contained one unreferenced entity");
  }
  return result;
}

function orderedArticleReadbackEntities(
  values: readonly unknown[],
  keys: ReadonlyMap<string, string>,
): readonly unknown[] {
  return [...values].sort((left, right) => {
    const leftKey = normalizedArticleEntityKey(
      record(left, "X Article readback entity").key,
      "X Article readback entity key",
    );
    const rightKey = normalizedArticleEntityKey(
      record(right, "X Article readback entity").key,
      "X Article readback entity key",
    );
    return Number(keys.get(leftKey)) - Number(keys.get(rightKey));
  });
}

function remappedArticleEntityKey(
  value: unknown,
  keys: ReadonlyMap<string, string>,
  label: string,
): string {
  const source = normalizedArticleEntityKey(value, label);
  const normalized = keys.get(source);
  if (normalized === undefined) {
    throw new Error(`${label} referenced an unknown Article entity`);
  }
  return normalized;
}

function normalizedArticleBlockData(
  value: unknown,
  label: string,
  blockText: unknown,
): Readonly<Record<string, never>> {
  if (typeof blockText !== "string") {
    throw new Error(`${label} has no bounded block text`);
  }
  const data = record(value, label);
  const keys = Object.keys(data);
  if (keys.length === 0) return Object.freeze({});
  if (keys.length !== 1 || keys[0] !== "urls" || !Array.isArray(data.urls)) {
    throw new Error(`${label} left the reviewed empty-or-urls shape`);
  }
  if (data.urls.length > 100) {
    throw new Error(`${label}.urls exceeded its reviewed bound`);
  }
  let previousEnd = 0;
  data.urls.forEach((value, index) => {
    const url = record(value, `${label}.urls[${index}]`);
    const urlKeys = Object.keys(url).sort();
    if (urlKeys.join(",") !== "fromIndex,text,toIndex") {
      throw new Error(`${label}.urls[${index}] left its reviewed range shape`);
    }
    if (
      !Number.isSafeInteger(url.fromIndex)
      || !Number.isSafeInteger(url.toIndex)
      || (url.fromIndex as number) < previousEnd
      || (url.fromIndex as number) < 0
      || (url.toIndex as number) <= (url.fromIndex as number)
      || (url.toIndex as number) > blockText.length
    ) {
      throw new Error(`${label}.urls[${index}] escaped its block text`);
    }
    if (
      typeof url.text !== "string"
      || /[\0\r\n]/u.test(url.text)
      || blockText.slice(
        url.fromIndex as number,
        url.toIndex as number,
      ) !== url.text
    ) {
      throw new Error(`${label}.urls[${index}].text did not bind its block range`);
    }
    previousEnd = url.toIndex as number;
  });
  return Object.freeze({});
}

function normalizedArticleBlockKey(
  value: unknown,
  index: number,
  observed: Set<string>,
): string {
  if (
    typeof value !== "string"
    || !/^[a-z0-9]{5}$/u.test(value)
    || observed.has(value)
  ) {
    throw new Error(`X Article readback block ${index + 1} has an invalid key`);
  }
  observed.add(value);
  return index.toString(36).padStart(5, "0");
}

function normalizeArticleContentReadback(value: unknown): XWebRichArticleContentState {
  const state = record(value, "X Article readback content_state");
  if (Array.isArray(state.entity_map)) {
    if (!Array.isArray(state.blocks)) {
      throw new Error("X Article readback omitted its rich content blocks");
    }
    const entityKeys = articleReadbackEntityKeyMap(
      state.entity_map,
      state.blocks,
      "entity_ranges",
    );
    const observedBlockKeys = new Set<string>();
    const blocks = state.blocks.map((value, index) => {
      const block = record(value, `X Article readback block ${index + 1}`);
      if (
        !Array.isArray(block.entity_ranges)
        || !Array.isArray(block.inline_style_ranges)
      ) {
        throw new Error("X Article readback block ranges changed shape");
      }
      return Object.freeze({
        data: normalizedArticleBlockData(
          block.data,
          `X Article readback block ${index + 1}.data`,
          block.text,
        ),
        text: block.text,
        key: normalizedArticleBlockKey(
          block.key,
          index,
          observedBlockKeys,
        ),
        type: block.type,
        entity_ranges: Object.freeze(block.entity_ranges.map((range) => {
          const item = record(range, "X Article readback entity range");
          return Object.freeze({
            key: Number(remappedArticleEntityKey(
              item.key,
              entityKeys,
              "X Article readback entity range key",
            )),
            offset: item.offset,
            length: item.length,
          });
        })),
        inline_style_ranges: Object.freeze(block.inline_style_ranges.map(
          (range) => {
            const item = record(range, "X Article readback style range");
            return Object.freeze({
              length: item.length,
              offset: item.offset,
              style: item.style,
            });
          },
        )),
      });
    });
    const entity_map = orderedArticleReadbackEntities(
      state.entity_map,
      entityKeys,
    ).map((value, index) => {
      const entity = record(value, `X Article readback entity ${index}`);
      normalizedArticleEntityKey(
        entity.key,
        `X Article readback entity ${index}.key`,
      );
      const entry = record(
        entity.value,
        `X Article readback entity ${index}.value`,
      );
      const data = record(
        entry.data,
        `X Article readback entity ${index}.data`,
      );
      return Object.freeze({
        key: `${index}`,
        value: Object.freeze({
          data: Object.freeze({ url: data.url }),
          type: entry.type,
          mutability: entry.mutability,
        }),
      });
    });
    const normalized = Object.freeze({
      blocks: Object.freeze(blocks),
      entity_map: Object.freeze(entity_map),
    });
    validateXWebRichArticleContentState(normalized);
    return normalized;
  }
  if (!Array.isArray(state.blocks) || !Array.isArray(state.entityMap)) {
    throw new Error("X Article readback omitted its rich content state");
  }
  const entityKeys = articleReadbackEntityKeyMap(
    state.entityMap,
    state.blocks,
    "entityRanges",
  );
  const observedBlockKeys = new Set<string>();
  const blocks = state.blocks.map((value, index) => {
    const block = record(value, `X Article readback block ${index + 1}`);
    if (!Array.isArray(block.entityRanges) || !Array.isArray(block.inlineStyleRanges)) {
      throw new Error("X Article readback block ranges changed shape");
    }
    return Object.freeze({
      data: normalizedArticleBlockData(
        block.data,
        `X Article readback block ${index + 1}.data`,
        block.text,
      ),
      text: block.text,
      key: normalizedArticleBlockKey(
        block.key,
        index,
        observedBlockKeys,
      ),
      type: block.type,
      entity_ranges: Object.freeze(block.entityRanges.map((range) => {
        const item = record(range, "X Article readback entity range");
        return Object.freeze({
          key: Number(remappedArticleEntityKey(
            item.key,
            entityKeys,
            "X Article readback entity range key",
          )),
          offset: item.offset,
          length: item.length,
        });
      })),
      inline_style_ranges: Object.freeze(block.inlineStyleRanges.map((range) => {
        const item = record(range, "X Article readback style range");
        return Object.freeze({ length: item.length, offset: item.offset, style: item.style });
      })),
    });
  });
  const entity_map = orderedArticleReadbackEntities(
    state.entityMap,
    entityKeys,
  ).map((value, index) => {
    const entity = record(value, `X Article readback entity ${index}`);
    normalizedArticleEntityKey(
      entity.key,
      `X Article readback entity ${index}.key`,
    );
    const entry = record(entity.value, `X Article readback entity ${index}.value`);
    const data = record(entry.data, `X Article readback entity ${index}.data`);
    return Object.freeze({
      key: `${index}`,
      value: Object.freeze({
        data: Object.freeze({ url: data.url }),
        type: entry.type,
        mutability: entry.mutability,
      }),
    });
  });
  const normalized = Object.freeze({ blocks: Object.freeze(blocks), entity_map: Object.freeze(entity_map) });
  validateXWebRichArticleContentState(normalized);
  return normalized;
}

async function readArticleDraft(
  bootstrap: XBootstrap,
  id: string,
): Promise<JsonRecord> {
  const descriptor = await resolveDescriptor(bootstrap, "ArticleEntityResultByRestId", "query");
  const response = await graphQl(bootstrap, descriptor, { articleEntityId: id }, "GET");
  return responseBoundArticle(response, "article_result_by_rest_id", id);
}

function verifyFinalRichArticle(
  article: JsonRecord,
  expected: {
    readonly id: string;
    readonly viewerId: string;
    readonly title: string;
    readonly contentState: XWebRichArticleContentState;
  },
): void {
  requirePrivateDraftArticle(article, expected.id, expected.viewerId);
  if (article.title !== expected.title) throw new Error("X Article readback did not bind the confirmed title");
  const content = normalizeArticleContentReadback(article.content_state);
  if (canonicalJson(content) !== canonicalJson(expected.contentState)) {
    throw new Error("X Article readback did not bind the confirmed rich content state");
  }
}

function dispatchEvent(id: string, index: number, planned: number, started: number, verified: number): WebSessionDispatchEvent {
  return { id, index, progress: { planned, started, verified } };
}

async function publishOne(
  bootstrap: XBootstrap,
  text: string,
  replyTo: string | null,
  quote: string | null,
  authorId: string,
  mutationOperation: XWebMutationOperationId,
  beforeRequest: () => Promise<void>,
): Promise<{ readonly id: string; readonly url: string }> {
  const descriptor = await resolveDescriptor(bootstrap, "CreateTweet", "mutation");
  const response = await graphQl(
    bootstrap,
    descriptor,
    createTweetVariables(text, replyTo, quote),
    "POST",
    undefined,
    mutationOperation,
    beforeRequest,
  );
  return createdTweet(response, text, replyTo, quote, authorId);
}

function rejectUnsupportedPostBranches(input: OperationInput): void {
  for (const name of ["media", "root_media"] as const) {
    if (input[name] !== undefined) throw new Error(`X internal ${name} upload requires a separately reviewed media contract`);
  }
  const replySettings = optionalStringInput(input, "reply_settings");
  if (replySettings !== undefined && replySettings !== "everyone") {
    throw new Error("X restricted reply settings require a separately reviewed conversation-control contract");
  }
}

async function executePublish(
  bootstrap: XBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  rejectUnsupportedPostBranches(input);
  const currentViewer = await requireBoundViewer(bootstrap, auth);
  const action = recipe.action;
  const texts = action === "threads.publish"
    ? threadTexts(input)
    : [stringInput(input, "body")];
  const planned = texts.length;
  const posts: { readonly id: string; readonly url: string }[] = [];
  let started = 0;
  let verified = 0;
  let previous: string | null = action === "replies.create" ? postId(input.post_id, "input.post_id") : null;
  const quote = action === "posts.quote" ? postId(input.post_id, "input.post_id") : null;
  try {
    for (const [offset, text] of texts.entries()) {
      const index = offset + 1;
      const id = action === "threads.publish" ? `${action}[${index}]` : action;
      const post = await publishOne(
        bootstrap,
        text,
        previous,
        quote,
        currentViewer.id,
        action === "threads.publish" && offset > 0 ? "threads.reply" : action as XWebMutationOperationId,
        async () => {
          await options.beforeDispatch?.(dispatchEvent(id, index, planned, started, verified));
          started = index;
        },
      );
      posts.push(post);
      previous = post.id;
      verified = index;
      await options.afterDispatchVerified?.(dispatchEvent(id, index, planned, started, verified));
    }
    return {
      status: "succeeded",
      output: { posts },
      finalUrl: posts.at(-1)?.url ?? X_ORIGIN,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
    };
  } catch {
    return {
      status: started > verified ? "indeterminate" : verified > 0 ? "partial" : "failed",
      output: posts.length === 0 ? null : { posts },
      finalUrl: posts.at(-1)?.url ?? null,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
      error: started > verified
        ? "X may have accepted the current post dispatch; reconcile before retrying"
        : "X post dispatch failed before a response-bound result was verified",
    };
  }
}

async function executeArticleDraftSave(
  bootstrap: XBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  if (recipe.contractVersion !== 1 || recipe.action !== "articles.draft.save") {
    throw new Error("X Article draft saving supports only articles.draft.save@1");
  }
  const title = requiredString(input.title, "input.title", MAX_ARTICLE_TITLE_CHARACTERS);
  if (/[\0\r\n]/u.test(title)) throw new Error("input.title must be one plain-text line");
  const document = parseArticleDraftDocument(input.document, {
    maximumBlocks: MAX_ARTICLE_BLOCKS,
    maximumCharacters: MAX_ARTICLE_BODY_CHARACTERS,
  });
  const contentState = buildXWebRichArticleContentState(document);
  await assertCurrentArticleRichContract(bootstrap);
  const currentViewer = await requireBoundViewer(bootstrap, auth);
  const requestedDraftId = input.draft_id === undefined ? null : postId(input.draft_id, "input.draft_id");
  if (requestedDraftId !== null) {
    requirePrivateDraftArticle(await readArticleDraft(bootstrap, requestedDraftId), requestedDraftId, currentViewer.id);
  }

  const planned = requestedDraftId === null ? 1 : 2;
  let started = 0;
  let verified = 0;
  let draftId = requestedDraftId;
  let nextIndex = 0;
  let failureStage = "binding the Article mutation session";
  const begin = async (id: string): Promise<number> => {
    const index = nextIndex + 1;
    await options.beforeDispatch?.(dispatchEvent(id, index, planned, started, verified));
    nextIndex = index;
    started = index;
    return index;
  };
  const complete = async (id: string, index: number): Promise<void> => {
    await options.afterDispatchVerified?.(dispatchEvent(id, index, planned, started, index));
    verified = index;
  };

  try {
    if (draftId === null) {
      const id = "articles.create";
      failureStage = "resolving the Article create mutation";
      const descriptor = await resolveDescriptor(bootstrap, "ArticleEntityDraftCreate", "mutation");
      let index = 0;
      failureStage = "preparing the Article create mutation";
      const response = await graphQl(
        bootstrap,
        descriptor,
        { content_state: contentState, title },
        "POST",
        undefined,
        "articles.create",
        async () => {
          index = await begin(id);
        },
      );
      const article = responseBoundArticle(response, "articleentity_create_draft", null, title);
      draftId = postId(article.rest_id, "X created Article draft rest_id");
      const finalArticle = await readArticleDraft(bootstrap, draftId);
      verifyFinalRichArticle(finalArticle, {
        id: draftId,
        viewerId: currentViewer.id,
        title,
        contentState,
      });
      await complete(id, index);
    } else {
      const titleId = "articles.title";
      failureStage = "resolving the Article title mutation";
      const titleDescriptor = await resolveDescriptor(bootstrap, "ArticleEntityUpdateTitle", "mutation");
      let titleIndex = 0;
      failureStage = "preparing the Article title mutation";
      const titleResponse = await graphQl(
        bootstrap,
        titleDescriptor,
        { articleEntityId: draftId, title },
        "POST",
        undefined,
        "articles.title",
        async () => {
          titleIndex = await begin(titleId);
        },
      );
      responseBoundArticle(titleResponse, "articleentity_update_title", draftId, title);
      await complete(titleId, titleIndex);

      const contentId = "articles.content";
      failureStage = "resolving the Article content mutation";
      const contentDescriptor = await resolveDescriptor(bootstrap, "ArticleEntityUpdateContent", "mutation");
      let contentIndex = 0;
      failureStage = "preparing the Article content mutation";
      const contentResponse = await graphQl(
        bootstrap,
        contentDescriptor,
        { content_state: contentState, article_entity: draftId },
        "POST",
        undefined,
        "articles.content",
        async () => {
          contentIndex = await begin(contentId);
        },
      );
      responseBoundArticle(contentResponse, "articleentity_update_content_state", draftId);
      const finalArticle = await readArticleDraft(bootstrap, draftId);
      verifyFinalRichArticle(finalArticle, {
        id: draftId,
        viewerId: currentViewer.id,
        title,
        contentState,
      });
      await complete(contentId, contentIndex);
    }

    if (draftId === null || nextIndex !== planned || verified !== planned) {
      throw new Error("X Article draft workflow did not complete its exact dispatch schedule");
    }
    const url = `${X_ORIGIN}/compose/articles/edit/${draftId}`;
    return {
      status: "succeeded",
      output: {
        provider: "x",
        operation: "articles.draft.save",
        published: false,
        mode: "draft",
        draftId,
        title,
        documentSchemaVersion: 1,
        url,
      },
      finalUrl: url,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
    };
  } catch {
    const url = draftId === null ? null : `${X_ORIGIN}/compose/articles/edit/${draftId}`;
    return {
      status: started > verified ? "indeterminate" : verified > 0 ? "partial" : "failed",
      output: null,
      finalUrl: url,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
      error: started > verified
        ? requestedDraftId === null
          ? "X may have accepted the private Article create, but the confirmed input has no exact draft ID for safe reconciliation; preserve the indeterminate run and do not retry"
          : "X may have accepted the current private Article replacement dispatch; reconcile the exact existing draft before retrying"
        : verified > 0
          ? "X verified only part of the confirmed private Article workflow; inspect the draft before retrying"
          : `X Article draft failed before remote submission while ${failureStage}`,
    };
  }
}

async function executeDesiredState(
  bootstrap: XBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  await requireBoundViewer(bootstrap, auth);
  const id = postId(input.post_id, "input.post_id");
  const kind = recipe.action === "likes.set" ? "like" : recipe.action === "content.save" ? "bookmark" : "repost";
  const enabled = recipe.action === "likes.set"
    ? booleanInput(input, "liked")
    : recipe.action === "content.save" ? booleanInput(input, "saved") : booleanInput(input, "reposted");
  const operationName = kind === "like"
    ? enabled ? "FavoriteTweet" : "UnfavoriteTweet"
    : kind === "bookmark"
      ? enabled ? "CreateBookmark" : "DeleteBookmark"
      : enabled ? "CreateRetweet" : "DeleteRetweet";
  const variables = kind === "repost" && !enabled
    ? { source_tweet_id: id, dark_request: false }
    : kind === "repost" ? { tweet_id: id, dark_request: false } : { tweet_id: id };
  let started = 0;
  let verified = 0;
  try {
    const initial = await desiredStateReadback(bootstrap, id, kind);
    if (initial === enabled) {
      return {
        status: "succeeded",
        output: {
          effect: "already-satisfied",
          kind,
          enabled,
          postId: id,
        },
        finalUrl: `${X_ORIGIN}/i/status/${id}`,
        noOp: true,
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
      };
    }
    const descriptor = await resolveDescriptor(bootstrap, operationName, "mutation");
    const mutationOperation = `${kind === "bookmark" ? "bookmarks" : kind === "like" ? "likes" : "reposts"}.${enabled ? "enable" : "disable"}` as XWebMutationOperationId;
    const response = await graphQl(
      bootstrap,
      descriptor,
      variables,
      "POST",
      undefined,
      mutationOperation,
      async () => {
        await options.beforeDispatch?.(dispatchEvent(recipe.action, 1, 1, 0, 0));
        started = 1;
      },
    );
    validateXWebDesiredStateMutation({ kind, enabled, targetPostId: id, response });
    const actual = await desiredStateReadback(bootstrap, id, kind);
    if (actual !== enabled) throw new Error("X desired-state readback did not match the confirmed state");
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1, 1, 1));
    return {
      status: "succeeded",
      output: { kind, enabled, postId: id },
      finalUrl: `${X_ORIGIN}/i/status/${id}`,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: `${X_ORIGIN}/i/status/${id}`,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "X may have changed the requested state but exact readback was not verified; reconcile before retrying"
        : "X desired-state dispatch failed before submission",
    };
  }
}

export async function executeXWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly signal?: AbortSignal;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: XWebRuntimeDependencies;
  } = {},
): Promise<WebSessionExecution> {
  const bootstrap = await bootstrapX(
    auth,
    recipe,
    options.dependencies,
    options,
  );
  if (recipe.action === "feeds.read") {
    await requireBoundViewer(bootstrap, auth);
    return {
      status: "succeeded",
      output: await readFeed(bootstrap, input),
      finalUrl: `${X_ORIGIN}/home`,
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    };
  }
  if (recipe.action === "posts.read" || recipe.action === "comments.read") {
    await requireBoundViewer(bootstrap, auth);
    const comments = recipe.action === "comments.read";
    const id = postId(input.post_id, "input.post_id");
    return {
      status: "succeeded",
      output: await readConversation(bootstrap, input, comments),
      finalUrl: `${X_ORIGIN}/i/status/${id}`,
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    };
  }
  if (
    recipe.action === "posts.publish"
    || recipe.action === "threads.publish"
    || recipe.action === "replies.create"
    || recipe.action === "posts.quote"
  ) return executePublish(bootstrap, recipe, input, auth, options);
  if (recipe.action === "articles.draft.save") {
    return executeArticleDraftSave(bootstrap, recipe, input, auth, options);
  }
  if (recipe.action === "likes.set" || recipe.action === "content.save" || recipe.action === "posts.repost") {
    return executeDesiredState(bootstrap, recipe, input, auth, options);
  }
  throw new Error(`X authenticated web operation ${recipe.action} has no executable reviewed contract`);
}
