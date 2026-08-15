import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { WrenchAuth } from "../auth";
import {
  browserCleanupBarrier,
  type BrowserFileResolver,
} from "../browser";
import type {
  FileInputValue,
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
const X_DEFAULT_UPLOAD_ORIGIN = "https://upload.x.com";
const X_UPLOAD_HOSTS = new Set(["upload.x.com", "upload-a.x.com", "upload-b.x.com"]);
const MAX_HOME_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const DEFAULT_LIMIT = 20;
const MAX_ARTICLE_TITLE_CHARACTERS = 100;
const MAX_ARTICLE_BODY_CHARACTERS = 20_000;
const MAX_ARTICLE_BLOCKS = 2_000;
const MAX_ARTICLE_DOCUMENT_BYTES = 128 * 1024;
const MAX_ARTICLE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ARTICLE_INLINE_IMAGES = 20;
const MAX_MEDIA_RESPONSE_BYTES = 2 * 1024 * 1024;

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

function exactObjectKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort().join(",");
  const expected = [...allowed].sort().join(",");
  if (actual !== expected) throw new Error(`${label} must contain exactly ${expected || "no fields"}`);
}

type XWebArticleTextBlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "blockquote"
  | "unordered-list-item"
  | "ordered-list-item";

type XWebArticleTextBlock = {
  readonly type: XWebArticleTextBlockType;
  readonly text: string;
  readonly links: readonly {
    readonly offset: number;
    readonly length: number;
    readonly url: string;
  }[];
  readonly styles: readonly {
    readonly offset: number;
    readonly length: number;
    readonly style: "bold" | "italic" | "strikethrough";
  }[];
};

type XWebArticleImageBlock = {
  readonly type: "image";
  readonly imageIndex: number;
  readonly caption?: string;
};

export type XWebRichArticleDocument = {
  readonly schemaVersion: 1;
  readonly blocks: readonly (XWebArticleTextBlock | XWebArticleImageBlock)[];
};

export type XWebRichArticleContentState = {
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
  readonly entity_map: readonly Readonly<Record<string, unknown>>[];
};

function boundedHttpsUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  return parsed.href;
}

function validTextRangeBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function boundedDocumentRange(
  value: unknown,
  text: string,
  label: string,
): { readonly offset: number; readonly length: number } {
  const range = record(value, label);
  const offset = range.offset;
  const length = range.length;
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || (offset as number) < 0
    || (length as number) < 1
    || (offset as number) + (length as number) > text.length
    || !validTextRangeBoundary(text, offset as number)
    || !validTextRangeBoundary(text, (offset as number) + (length as number))
  ) throw new Error(`${label} must stay on UTF-16 boundaries inside its text`);
  return Object.freeze({ offset: offset as number, length: length as number });
}

/** Parse the versioned caller-owned rich document before any remote dispatch. */
export function parseXWebRichArticleDocument(value: unknown): XWebRichArticleDocument {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > MAX_ARTICLE_DOCUMENT_BYTES
    || value.includes("\0")
  ) throw new Error("input.document must be bounded version-1 rich Article JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("input.document must be valid version-1 rich Article JSON");
  }
  const root = record(parsed, "input.document");
  exactObjectKeys(root, ["schemaVersion", "blocks"], "input.document");
  if (root.schemaVersion !== 1 || !Array.isArray(root.blocks)) {
    throw new Error("input.document must use rich Article schemaVersion 1");
  }
  if (root.blocks.length < 1 || root.blocks.length > MAX_ARTICLE_BLOCKS) {
    throw new Error(`input.document must contain 1-${MAX_ARTICLE_BLOCKS} blocks`);
  }
  const blocks: (XWebArticleTextBlock | XWebArticleImageBlock)[] = [];
  const imageIndexes = new Set<number>();
  let totalCharacters = 0;
  const textTypes = new Set<XWebArticleTextBlockType>([
    "paragraph",
    "heading1",
    "heading2",
    "blockquote",
    "unordered-list-item",
    "ordered-list-item",
  ]);
  for (const [index, rawBlock] of root.blocks.entries()) {
    const label = `input.document.blocks[${index}]`;
    const block = record(rawBlock, label);
    if (block.type === "image") {
      const allowed = block.caption === undefined ? ["type", "imageIndex"] : ["type", "imageIndex", "caption"];
      exactObjectKeys(block, allowed, label);
      if (
        !Number.isSafeInteger(block.imageIndex)
        || (block.imageIndex as number) < 0
        || (block.imageIndex as number) >= MAX_ARTICLE_INLINE_IMAGES
        || imageIndexes.has(block.imageIndex as number)
      ) throw new Error(`${label}.imageIndex must be a unique zero-based image index`);
      const caption = block.caption;
      if (caption !== undefined && (
        typeof caption !== "string"
        || caption.length > 1_000
        || /[\0\r]/u.test(caption)
      )) throw new Error(`${label}.caption must be bounded text`);
      imageIndexes.add(block.imageIndex as number);
      blocks.push(Object.freeze({
        type: "image",
        imageIndex: block.imageIndex as number,
        ...(caption === undefined ? {} : { caption }),
      }));
      continue;
    }
    if (typeof block.type !== "string" || !textTypes.has(block.type as XWebArticleTextBlockType)) {
      throw new Error(`${label}.type is outside the reviewed rich Article block types`);
    }
    const allowed = ["type", "text", ...(block.links === undefined ? [] : ["links"]), ...(block.styles === undefined ? [] : ["styles"])];
    exactObjectKeys(block, allowed, label);
    if (typeof block.text !== "string" || /[\0\r\n]/u.test(block.text)) {
      throw new Error(`${label}.text must be one bounded line`);
    }
    totalCharacters += block.text.length;
    if (totalCharacters > MAX_ARTICLE_BODY_CHARACTERS) {
      throw new Error(`input.document text must contain at most ${MAX_ARTICLE_BODY_CHARACTERS} characters`);
    }
    const rawLinks = block.links ?? [];
    const rawStyles = block.styles ?? [];
    if (!Array.isArray(rawLinks) || rawLinks.length > 500 || !Array.isArray(rawStyles) || rawStyles.length > 500) {
      throw new Error(`${label} ranges exceeded their reviewed bounds`);
    }
    const links = rawLinks.map((rawLink, rangeIndex) => {
      const rangeLabel = `${label}.links[${rangeIndex}]`;
      const link = record(rawLink, rangeLabel);
      exactObjectKeys(link, ["offset", "length", "url"], rangeLabel);
      const range = boundedDocumentRange(link, block.text as string, rangeLabel);
      return Object.freeze({ ...range, url: boundedHttpsUrl(link.url, `${rangeLabel}.url`) });
    });
    let linkEnd = 0;
    for (const link of links) {
      if (link.offset < linkEnd) throw new Error(`${label}.links must be ordered and non-overlapping`);
      linkEnd = link.offset + link.length;
    }
    const styles = rawStyles.map((rawStyle, rangeIndex) => {
      const rangeLabel = `${label}.styles[${rangeIndex}]`;
      const style = record(rawStyle, rangeLabel);
      exactObjectKeys(style, ["offset", "length", "style"], rangeLabel);
      const range = boundedDocumentRange(style, block.text as string, rangeLabel);
      if (style.style !== "bold" && style.style !== "italic" && style.style !== "strikethrough") {
        throw new Error(`${rangeLabel}.style is outside the reviewed rich Article styles`);
      }
      return Object.freeze({ ...range, style: style.style });
    });
    blocks.push(Object.freeze({
      type: block.type as XWebArticleTextBlockType,
      text: block.text,
      links: Object.freeze(links),
      styles: Object.freeze(styles),
    }));
  }
  if (totalCharacters < 1) throw new Error("input.document must contain Article text");
  return Object.freeze({ schemaVersion: 1, blocks: Object.freeze(blocks) });
}

/** Build X's current API content-state shape after every referenced image has a verified media ID. */
export function buildXWebRichArticleContentState(
  document: XWebRichArticleDocument,
  uploadedImageIds: readonly string[],
): XWebRichArticleContentState {
  if (uploadedImageIds.length > MAX_ARTICLE_INLINE_IMAGES || uploadedImageIds.some((id) => !/^[0-9]{1,19}$/u.test(id))) {
    throw new Error("X rich Article image uploads must be exact media IDs");
  }
  const entities: Readonly<Record<string, unknown>>[] = [];
  const blocks: Readonly<Record<string, unknown>>[] = [];
  const usedImages = new Set<number>();
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
    if (block.type === "image") {
      const mediaId = uploadedImageIds[block.imageIndex];
      if (mediaId === undefined || usedImages.has(block.imageIndex)) {
        throw new Error("input.document imageIndex did not bind one uploaded inline image");
      }
      usedImages.add(block.imageIndex);
      const entityKey = `${entities.length}`;
      entities.push(Object.freeze({
        key: entityKey,
        value: Object.freeze({
          data: Object.freeze({
            ...(block.caption === undefined || block.caption === "" ? {} : { caption: block.caption }),
            entity_key: entityKey,
            media_items: Object.freeze([Object.freeze({
              local_media_id: block.imageIndex + 1,
              media_category: "DraftTweetImage",
              media_id: mediaId,
            })]),
          }),
          type: "MEDIA",
          mutability: "Immutable",
        }),
      }));
      blocks.push(Object.freeze({
        data: Object.freeze({}),
        key,
        text: " ",
        type: "atomic",
        entity_ranges: Object.freeze([Object.freeze({ key: Number(entityKey), offset: 0, length: 1 })]),
        inline_style_ranges: Object.freeze([]),
      }));
      continue;
    }
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
  if (usedImages.size !== uploadedImageIds.length) {
    throw new Error("every input.inline_images item must be referenced exactly once by input.document");
  }
  const contentState = Object.freeze({ blocks: Object.freeze(blocks), entity_map: Object.freeze(entities) });
  validateXWebRichArticleContentState(contentState);
  return contentState;
}

export type XWebArticleContentState = {
  readonly blocks: readonly {
    readonly type: "unstyled";
    readonly text: string;
    readonly data: Readonly<Record<string, never>>;
    readonly entity_ranges: readonly never[];
    readonly inline_style_ranges: readonly never[];
  }[];
  readonly entity_map: readonly never[];
};

/** Convert confirmed plain text into X's reviewed native Article block shape. */
export function buildXWebArticleContentState(value: unknown): XWebArticleContentState {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_ARTICLE_BODY_CHARACTERS
    || /[\0\r]/u.test(value)
  ) {
    throw new Error("input.body must be a 1-20000 character plain-text Article body");
  }
  const lines = value.split("\n");
  if (lines.length > MAX_ARTICLE_BLOCKS) {
    throw new Error(`input.body must contain at most ${MAX_ARTICLE_BLOCKS} plain-text blocks`);
  }
  return Object.freeze({
    blocks: Object.freeze(lines.map((text) => Object.freeze({
      type: "unstyled" as const,
      text,
      data: Object.freeze({}),
      entity_ranges: Object.freeze([]),
      inline_style_ranges: Object.freeze([]),
    }))),
    entity_map: Object.freeze([]),
  });
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
  uploader: "shared~bundle.LoggedInMain~ondemand.HoverCard~loader.AudioDock~loader.Dock~bundle.BookmarkFolders~bundle.Book.a9bac6ba.js",
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
  const [uploader, entities, converter] = await Promise.all([
    currentChunkText(bootstrap, articleRichContractEvidence.uploader),
    currentChunkText(bootstrap, articleRichContractEvidence.entities),
    currentChunkText(bootstrap, articleRichContractEvidence.converter),
  ]);
  requireCurrentBundleTokens(uploader, [
    '"upload.x.com"',
    '"upload-a.x.com"',
    '"upload-b.x.com"',
    '/i/media/${l}',
    '"INIT"',
    '"APPEND"',
    '"FINALIZE"',
    'media_category=${p}',
    'TweetImage:"tweet_image"',
    'TwitterArticle:"twitter_article"',
  ], "media uploader");
  requireCurrentBundleTokens(entities, [
    'createEntity(p.LA.MEDIA,p.Ei.IMMUTABLE',
    'mediaCategory:E(e)',
    'mediaId:e.uploadId',
    'createEntity(w.Sg,"MUTABLE",{url:',
  ], "Article entity");
  requireCurrentBundleTokens(converter, [
    'media_items:r.data?.mediaItems?.map',
    'media_category:e.mediaCategory',
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

function featureStringValue(bootstrap: XBootstrap, name: string): string | undefined {
  const entry = bootstrap.features.get(name);
  if (entry === undefined) return undefined;
  if (!isRecord(entry) || (entry.value !== undefined && typeof entry.value !== "string")) {
    throw new Error(`X user feature configuration changed type for feature ${name}`);
  }
  return entry.value as string | undefined;
}

function articleUploadOrigin(bootstrap: XBootstrap): string {
  const configured = featureStringValue(bootstrap, "responsive_web_media_upload_host");
  if (configured === undefined) return X_DEFAULT_UPLOAD_ORIGIN;
  const host = configured;
  if (!X_UPLOAD_HOSTS.has(host)) throw new Error("X selected an unreviewed media upload host");
  return new URL(`https://${host}`).origin;
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

export async function readXWebRichArticleDesiredState(
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
    || recipe.action !== "articles.publish"
    || recipe.contractVersion !== 3
  ) {
    throw new Error("X rich Article recovery supports only articles.publish@3");
  }
  if (
    input.draft_only !== true
    || input.inline_images !== undefined
    || input.cover_image !== undefined
  ) {
    throw new Error(
      "X rich Article recovery supports only an existing text-and-links draft without pending media",
    );
  }
  const draftId = postId(input.draft_id, "input.draft_id");
  const title = requiredString(
    input.title,
    "input.title",
    MAX_ARTICLE_TITLE_CHARACTERS,
  );
  const document = parseXWebRichArticleDocument(input.document);
  const expectedContent = buildXWebRichArticleContentState(document, []);
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

function createdArticleDraft(
  response: unknown,
  expectedTitle: string,
): { readonly id: string; readonly title: string; readonly url: string } {
  const data = graphQlData(response, "X ArticleEntityDraftCreate response");
  const create = record(data.articleentity_create_draft, "X ArticleEntityDraftCreate response.articleentity_create_draft");
  const results = record(create.article_entity_results, "X ArticleEntityDraftCreate response.article_entity_results");
  const result = record(results.result, "X ArticleEntityDraftCreate response.result");
  const id = postId(result.rest_id, "X Article draft rest_id");
  if (result.title !== expectedTitle) {
    throw new Error("X Article draft response did not bind the confirmed title");
  }
  return { id, title: expectedTitle, url: `${X_ORIGIN}/compose/articles/edit/${id}` };
}

type BoundArticleImage = {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
};

function fileInput(value: OperationInput[string], label: string): FileInputValue {
  if (!isRecord(value)) throw new Error(`${label} must be one plan-bound file`);
  exactObjectKeys(value, ["kind", "reference"], label);
  if (value.kind !== "file" || typeof value.reference !== "string" || value.reference.length < 1) {
    throw new Error(`${label} must be one plan-bound file`);
  }
  return Object.freeze({ kind: "file", reference: value.reference });
}

function articleFileInputs(input: OperationInput): {
  readonly inline: readonly FileInputValue[];
  readonly cover: FileInputValue | null;
  readonly ordered: readonly FileInputValue[];
} {
  const rawInline = input.inline_images;
  if (rawInline !== undefined && !Array.isArray(rawInline)) {
    throw new Error("input.inline_images must be an ordered plan-bound file array");
  }
  const inline = Object.freeze((rawInline ?? []).map((value, index) =>
    fileInput(value, `input.inline_images[${index}]`)));
  if (inline.length > MAX_ARTICLE_INLINE_IMAGES) {
    throw new Error(`input.inline_images supports at most ${MAX_ARTICLE_INLINE_IMAGES} files`);
  }
  const cover = input.cover_image === undefined ? null : fileInput(input.cover_image, "input.cover_image");
  return Object.freeze({
    inline,
    cover,
    ordered: Object.freeze([...inline, ...(cover === null ? [] : [cover])]),
  });
}

function sniffArticleImage(bytes: Uint8Array): BoundArticleImage["mediaType"] {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  throw new Error("X Article images must be exact JPEG, PNG, or WebP bytes");
}

async function readArticleImage(
  path: string,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<BoundArticleImage> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = operationDeadline === undefined
    ? await open(path, constants.O_RDONLY | noFollow)
    : await operationDeadline.run(
        () => open(path, constants.O_RDONLY | noFollow),
        "authenticated web operation deadline",
      );
  try {
    const before = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(() => handle.stat(), "authenticated web operation deadline");
    if (!before.isFile() || before.size < 1 || before.size > MAX_ARTICLE_IMAGE_BYTES) {
      throw new Error(`X Article images must be regular files no larger than ${MAX_ARTICLE_IMAGE_BYTES} bytes`);
    }
    const raw = operationDeadline === undefined
      ? await handle.readFile()
      : await operationDeadline.run(() => handle.readFile(), "authenticated web operation deadline");
    const after = operationDeadline === undefined
      ? await handle.stat()
      : await operationDeadline.run(() => handle.stat(), "authenticated web operation deadline");
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || raw.byteLength !== before.size
    ) throw new Error("X Article image changed while it was materialized");
    const bytes = new Uint8Array(raw);
    return Object.freeze({ bytes, mediaType: sniffArticleImage(bytes) });
  } finally {
    await handle.close();
  }
}

async function materializeArticleImages(
  input: OperationInput,
  fileResolver: BrowserFileResolver | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<{ readonly inline: readonly BoundArticleImage[]; readonly cover: BoundArticleImage | null }> {
  const files = articleFileInputs(input);
  if (files.ordered.length === 0) return Object.freeze({ inline: Object.freeze([]), cover: null });
  if (fileResolver === undefined) throw new Error("X rich Article media requires the plan-bound file resolver");
  const paths = operationDeadline === undefined
    ? await fileResolver(files.ordered)
    : await operationDeadline.run(
        () => fileResolver(files.ordered),
        "authenticated web operation deadline",
      );
  operationDeadline?.throwIfUnavailable("authenticated web operation deadline");
  if (
    paths.length !== files.ordered.length
    || paths.some((path) => typeof path !== "string" || path.length < 1)
  ) throw new Error("X Article file resolver did not return every exact plan-bound path");
  const images: BoundArticleImage[] = [];
  for (const path of paths) images.push(await readArticleImage(path!, operationDeadline));
  return Object.freeze({
    inline: Object.freeze(images.slice(0, files.inline.length)),
    cover: files.cover === null ? null : images.at(-1)!,
  });
}

function xUploadHeaders(bootstrap: XBootstrap): Readonly<Record<string, string>> {
  const fixed = enforceXWebHeaderSinkPolicy({
    source: "code",
    sink: "network-request",
    headers: {
      accept: "application/json",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
    },
  }).values;
  const session = enforceXWebHeaderSinkPolicy({
    source: "in-origin-session",
    sink: "network-request",
    headers: {
      authorization: `Bearer ${bootstrap.bearer}`,
      "x-csrf-token": bootstrap.csrf,
    },
  }).values;
  return { ...fixed, ...session, origin: X_ORIGIN, referer: `${X_ORIGIN}/compose/articles` };
}

function mediaUploadUrl(
  origin: string,
  command: "INIT" | "APPEND" | "FINALIZE",
  values: Readonly<Record<string, string>>,
): URL {
  const url = new URL("/i/media/upload.json", origin);
  url.searchParams.set("command", command);
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  const expected = command === "INIT"
    ? ["command", "media_category", "media_type", "total_bytes"]
    : command === "APPEND" ? ["command", "media_id", "segment_index"] : ["command", "media_id"];
  if (Object.keys(Object.fromEntries(url.searchParams)).sort().join(",") !== expected.sort().join(",")) {
    throw new Error("X media upload request left its reviewed query shape");
  }
  return url;
}

function uploadMediaId(value: unknown, label: string): string {
  const response = record(value, label);
  const id = response.media_id_string;
  if (typeof id !== "string" || !/^[0-9]{1,19}$/u.test(id)) {
    throw new Error(`${label} did not return one exact media ID`);
  }
  if (
    response.expires_after_secs !== undefined
    && (!Number.isSafeInteger(response.expires_after_secs) || (response.expires_after_secs as number) < 1)
  ) throw new Error(`${label} returned an invalid expiry`);
  return id;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function articleMediaMultipart(image: BoundArticleImage): {
  readonly body: Uint8Array;
  readonly contentType: string;
} {
  const digest = createHash("sha256").update(image.bytes).digest("hex");
  let boundary = `----wrench-x-article-${digest}`;
  const encoder = new TextEncoder();
  for (let suffix = 0; containsBytes(image.bytes, encoder.encode(boundary)); suffix += 1) {
    if (suffix >= 16) throw new Error("X Article media could not bind a safe multipart boundary");
    boundary = `----wrench-x-article-${digest}-${suffix + 1}`;
  }
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="blob"\r\nContent-Type: ${image.mediaType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + image.bytes.length + suffix.length);
  body.set(prefix, 0);
  body.set(image.bytes, prefix.length);
  body.set(suffix, prefix.length + image.bytes.length);
  return Object.freeze({ body, contentType: `multipart/form-data; boundary=${boundary}` });
}

async function appendArticleMedia(
  client: WebSessionClient,
  url: URL,
  image: BoundArticleImage,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  const multipart = articleMediaMultipart(image);
  await client.requestStatus({
    url,
    method: "POST",
    headers: { ...headers, "content-type": multipart.contentType },
    body: multipart.body,
    expectedStatuses: [200, 204],
  });
}

async function uploadArticleImage(
  bootstrap: XBootstrap,
  client: WebSessionClient,
  image: BoundArticleImage,
  beforeInit: () => Promise<void>,
): Promise<string> {
  const origin = client.origin;
  const headers = xUploadHeaders(bootstrap);
  const initUrl = mediaUploadUrl(origin, "INIT", {
    total_bytes: `${image.bytes.byteLength}`,
    media_type: image.mediaType,
    media_category: "tweet_image",
  });
  await beforeInit();
  const init = await client.requestJson({
    url: initUrl,
    method: "POST",
    headers,
    maxBytes: MAX_MEDIA_RESPONSE_BYTES,
  });
  const mediaId = uploadMediaId(init, "X media INIT response");
  await appendArticleMedia(
    client,
    mediaUploadUrl(origin, "APPEND", { media_id: mediaId, segment_index: "0" }),
    image,
    headers,
  );
  const finalized = await client.requestJson({
    url: mediaUploadUrl(origin, "FINALIZE", { media_id: mediaId }),
    method: "POST",
    headers,
    maxBytes: MAX_MEDIA_RESPONSE_BYTES,
  });
  if (uploadMediaId(finalized, "X media FINALIZE response") !== mediaId) {
    throw new Error("X media FINALIZE response changed the uploaded media ID");
  }
  const finalRecord = record(finalized, "X media FINALIZE response");
  if (finalRecord.processing_info !== undefined) {
    throw new Error("X image upload unexpectedly entered an unreviewed processing branch");
  }
  return mediaId;
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
      const sourceEntityKey = normalizedArticleEntityKey(
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
      const normalizedData = entry.type === "MEDIA"
        ? Object.freeze({
            ...(data.caption === undefined || data.caption === null || data.caption === ""
              ? {}
              : { caption: data.caption }),
            entity_key: (() => {
              const sourceDataKey = normalizedArticleEntityKey(
                data.entity_key,
                `X Article readback entity ${index}.data.entity_key`,
              );
              if (sourceDataKey !== sourceEntityKey) {
                throw new Error(
                  `X Article readback entity ${index} changed its media entity key`,
                );
              }
              return `${index}`;
            })(),
            media_items: data.media_items,
          })
        : Object.freeze({ url: data.url });
      return Object.freeze({
        key: `${index}`,
        value: Object.freeze({
          data: normalizedData,
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
    const sourceEntityKey = normalizedArticleEntityKey(
      entity.key,
      `X Article readback entity ${index}.key`,
    );
    const entry = record(entity.value, `X Article readback entity ${index}.value`);
    const data = record(entry.data, `X Article readback entity ${index}.data`);
    const normalizedData = entry.type === "MEDIA"
      ? Object.freeze({
          ...(data.caption === undefined || data.caption === null || data.caption === "" ? {} : { caption: data.caption }),
          entity_key: (() => {
            const sourceDataKey = normalizedArticleEntityKey(
              data.entityKey,
              `X Article readback entity ${index}.data.entityKey`,
            );
            if (sourceDataKey !== sourceEntityKey) {
              throw new Error(
                `X Article readback entity ${index} changed its media entity key`,
              );
            }
            return `${index}`;
          })(),
          media_items: Array.isArray(data.mediaItems)
            ? Object.freeze(data.mediaItems.map((value) => {
                const item = record(value, "X Article readback media item");
                return Object.freeze({
                  local_media_id: item.localMediaId,
                  media_category: item.mediaCategory,
                  media_id: item.mediaId,
                });
              }))
            : data.mediaItems,
        })
      : Object.freeze({ url: data.url });
    return Object.freeze({
      key: `${index}`,
      value: Object.freeze({ data: normalizedData, type: entry.type, mutability: entry.mutability }),
    });
  });
  const normalized = Object.freeze({ blocks: Object.freeze(blocks), entity_map: Object.freeze(entity_map) });
  validateXWebRichArticleContentState(normalized);
  return normalized;
}

function articleCoverMediaId(article: JsonRecord): string | null {
  if (article.cover_media === undefined || article.cover_media === null) return null;
  const cover = record(article.cover_media, "X Article cover_media");
  if (typeof cover.media_id === "string" && /^[0-9]{1,19}$/u.test(cover.media_id)) return cover.media_id;
  if (typeof cover.media_id_string === "string" && /^[0-9]{1,19}$/u.test(cover.media_id_string)) {
    return cover.media_id_string;
  }
  if (typeof cover.media_key === "string") {
    const match = /^[0-9]+_([0-9]{1,19})$/u.exec(cover.media_key);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error("X Article cover_media omitted its exact media ID");
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
    readonly coverMediaId: string | null;
  },
): void {
  requirePrivateDraftArticle(article, expected.id, expected.viewerId);
  if (article.title !== expected.title) throw new Error("X Article readback did not bind the confirmed title");
  const content = normalizeArticleContentReadback(article.content_state);
  if (canonicalJson(content) !== canonicalJson(expected.contentState)) {
    throw new Error("X Article readback did not bind the confirmed rich content state");
  }
  if (expected.coverMediaId !== null && articleCoverMediaId(article) !== expected.coverMediaId) {
    throw new Error("X Article readback did not bind the confirmed cover image");
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

async function executeArticleDraft(
  bootstrap: XBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  await requireBoundViewer(bootstrap, auth);
  if (recipe.contractVersion !== 2 || input.draft_only !== true) {
    throw new Error("X authenticated web Articles support only contract v2 with input.draft_only=true");
  }
  const unsupported = ["cover", "cover_image", "cover_alt_text"].find((name) => input[name] !== undefined);
  if (unsupported !== undefined) {
    throw new Error(`X authenticated web Article drafts do not support input.${unsupported}`);
  }
  const title = requiredString(input.title, "input.title", MAX_ARTICLE_TITLE_CHARACTERS);
  if (/[\0\r\n]/u.test(title)) {
    throw new Error("input.title must be one plain-text line");
  }
  const contentState = buildXWebArticleContentState(input.body);
  let started = 0;
  let verified = 0;
  try {
    const descriptor = await resolveDescriptor(bootstrap, "ArticleEntityDraftCreate", "mutation");
    const response = await graphQl(
      bootstrap,
      descriptor,
      { content_state: contentState, title },
      "POST",
      undefined,
      "articles.draft",
      async () => {
        await options.beforeDispatch?.(dispatchEvent(recipe.action, 1, 1, 0, 0));
        started = 1;
      },
    );
    const draft = createdArticleDraft(response, title);
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1, 1, 1));
    verified = 1;
    return {
      status: "succeeded",
      output: {
        provider: "x",
        operation: "articles.publish",
        published: false,
        mode: "draft",
        draftId: draft.id,
        title: draft.title,
        url: draft.url,
      },
      finalUrl: draft.url,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: null,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "X may have created the private Article draft but its exact response was not verified; reconcile before retrying"
        : "X Article draft creation failed before submission",
    };
  }
}

async function executeRichArticleDraft(
  bootstrap: XBootstrap,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  },
): Promise<WebSessionExecution> {
  if (recipe.contractVersion !== 3 || input.draft_only !== true) {
    throw new Error("X rich Articles support only contract v3 with input.draft_only=true");
  }
  const title = requiredString(input.title, "input.title", MAX_ARTICLE_TITLE_CHARACTERS);
  if (/[\0\r\n]/u.test(title)) throw new Error("input.title must be one plain-text line");
  const document = parseXWebRichArticleDocument(input.document);
  const materialized = await materializeArticleImages(input, options.fileResolver, bootstrap.operationDeadline);
  // Prove the document/file bijection before the first remote media INIT.
  buildXWebRichArticleContentState(
    document,
    materialized.inline.map((_image, index) => `${index + 1}`),
  );
  await assertCurrentArticleRichContract(bootstrap);
  const currentViewer = await requireBoundViewer(bootstrap, auth);
  const requestedDraftId = input.draft_id === undefined ? null : postId(input.draft_id, "input.draft_id");
  if (requestedDraftId !== null) {
    requirePrivateDraftArticle(await readArticleDraft(bootstrap, requestedDraftId), requestedDraftId, currentViewer.id);
  }

  const imageCount = materialized.inline.length;
  const hasCover = materialized.cover !== null;
  const planned = imageCount + (hasCover ? 1 : 0) + (requestedDraftId === null ? 1 : 2) + (hasCover ? 1 : 0);
  let started = 0;
  let verified = 0;
  let draftId = requestedDraftId;
  let contentState: XWebRichArticleContentState | null = null;
  let coverMediaId: string | null = null;
  const uploadedInline: string[] = [];
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
    let uploadClient: WebSessionClient | null = null;
    if (imageCount > 0 || hasCover) {
      failureStage = "binding the media upload session";
      uploadClient = await createWebSessionClient(articleUploadOrigin(bootstrap), auth, {
        timeoutMs: bootstrap.timeoutMs,
        ...(bootstrap.signal === undefined ? {} : { signal: bootstrap.signal }),
        ...(bootstrap.operationDeadline === undefined ? {} : { operationDeadline: bootstrap.operationDeadline }),
        ...(bootstrap.dependencies === undefined ? {} : { dependencies: bootstrap.dependencies }),
      });
      if (webSessionCookie(uploadClient.cookies, "ct0") !== bootstrap.csrf) {
        throw new Error("X media upload session did not bind the Article session CSRF realm");
      }
    }
    for (const [offset, image] of materialized.inline.entries()) {
      const id = `articles.media.inline[${offset + 1}]`;
      failureStage = `uploading inline image ${offset + 1}`;
      let index = 0;
      const mediaId = await uploadArticleImage(bootstrap, uploadClient!, image, async () => {
        index = await begin(id);
      });
      uploadedInline.push(mediaId);
      await complete(id, index);
    }
    if (materialized.cover !== null) {
      const id = "articles.media.cover";
      failureStage = "uploading the cover image";
      let index = 0;
      coverMediaId = await uploadArticleImage(bootstrap, uploadClient!, materialized.cover, async () => {
        index = await begin(id);
      });
      await complete(id, index);
    }
    contentState = buildXWebRichArticleContentState(document, uploadedInline);

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
      if (!hasCover) {
        const finalArticle = await readArticleDraft(bootstrap, draftId);
        verifyFinalRichArticle(finalArticle, {
          id: draftId,
          viewerId: currentViewer.id,
          title,
          contentState,
          coverMediaId: null,
        });
      }
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
      if (!hasCover) {
        const finalArticle = await readArticleDraft(bootstrap, draftId);
        verifyFinalRichArticle(finalArticle, {
          id: draftId,
          viewerId: currentViewer.id,
          title,
          contentState,
          coverMediaId: null,
        });
      }
      await complete(contentId, contentIndex);
    }

    if (coverMediaId !== null) {
      const id = "articles.cover";
      failureStage = "resolving the Article cover mutation";
      const descriptor = await resolveDescriptor(bootstrap, "ArticleEntityUpdateCoverMedia", "mutation");
      let index = 0;
      failureStage = "preparing the Article cover mutation";
      const response = await graphQl(
        bootstrap,
        descriptor,
        {
          articleEntityId: draftId,
          coverMedia: { media_id: coverMediaId, media_category: "DraftTweetImage" },
        },
        "POST",
        undefined,
        "articles.cover",
        async () => {
          index = await begin(id);
        },
      );
      responseBoundArticle(response, "articleentity_update_cover_media", draftId);
      const finalArticle = await readArticleDraft(bootstrap, draftId!);
      verifyFinalRichArticle(finalArticle, {
        id: draftId!,
        viewerId: currentViewer.id,
        title,
        contentState: contentState!,
        coverMediaId,
      });
      await complete(id, index);
    }
    if (draftId === null || contentState === null || nextIndex !== planned || verified !== planned) {
      throw new Error("X rich Article workflow did not complete its exact dispatch schedule");
    }
    const url = `${X_ORIGIN}/compose/articles/edit/${draftId}`;
    return {
      status: "succeeded",
      output: {
        provider: "x",
        operation: "articles.publish",
        published: false,
        mode: "draft",
        draftId,
        title,
        rich: true,
        inlineImageCount: uploadedInline.length,
        hasCover,
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
        ? "X may have accepted the current private Article dispatch; reconcile the exact draft before retrying"
        : verified > 0
          ? "X verified only part of the confirmed private rich Article workflow; inspect the draft before retrying"
          : `X rich Article draft failed before remote submission while ${failureStage}`,
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
    readonly fileResolver?: BrowserFileResolver;
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
  if (recipe.action === "articles.publish") {
    return recipe.contractVersion === 3
      ? executeRichArticleDraft(bootstrap, recipe, input, auth, options)
      : executeArticleDraft(bootstrap, recipe, input, auth, options);
  }
  if (recipe.action === "likes.set" || recipe.action === "content.save" || recipe.action === "posts.repost") {
    return executeDesiredState(bootstrap, recipe, input, auth, options);
  }
  throw new Error(`X authenticated web operation ${recipe.action} has no executable reviewed contract`);
}
