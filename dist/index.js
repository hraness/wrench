// @bun
import {
  canonicalJson
} from "./index-dqv16dt0.js";

// src/provider-plugin-identifiers.ts
var PROVIDER_PLUGIN_ID_MAX_LENGTH = 63;
var PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH = 163;
var strictKebabPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
var strictKebabSegmentPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
var portableProviderPluginVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
function isPortableProviderPluginVersion(value) {
  if (typeof value !== "string" || value.length > 128)
    return false;
  const match = portableProviderPluginVersionPattern.exec(value);
  if (match === null)
    return false;
  const prerelease = match[1];
  return prerelease === undefined || prerelease.split(".").every((identifier) => !/^[0-9]+$/u.test(identifier) || identifier === "0" || !identifier.startsWith("0"));
}
function isProviderPluginId(value) {
  return typeof value === "string" && value.length <= PROVIDER_PLUGIN_ID_MAX_LENGTH && strictKebabPattern.test(value);
}
function isProviderPluginSurfaceId(value) {
  return isProviderPluginId(value);
}
function isProviderPluginOperationName(value) {
  if (typeof value !== "string" || value.length > PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH) {
    return false;
  }
  const segments = value.split(".");
  return segments.length >= 2 && segments.length <= 4 && segments.every((segment) => segment.length <= 40 && strictKebabSegmentPattern.test(segment));
}

// src/article-draft-document.ts
var ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION = 1;
var MAX_ARTICLE_DRAFT_DOCUMENT_BYTES = 512 * 1024;
var MAX_ARTICLE_DRAFT_BLOCKS = 5000;
var MAX_ARTICLE_DRAFT_CHARACTERS = 125000;
var articleDraftStyleOrder = Object.freeze({
  bold: 0,
  italic: 1,
  strikethrough: 2
});
var textBlockTypes = new Set([
  "paragraph",
  "heading1",
  "heading2",
  "blockquote",
  "unordered-list-item",
  "ordered-list-item"
]);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value, label) {
  if (!isRecord(value))
    throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected)
    throw new Error(`${label} must contain exactly ${expected || "no fields"}`);
}
function boundedHttpsUrl(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must be a bounded absolute HTTPS URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a bounded absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.href !== value)
    throw new Error(`${label} must be one canonical absolute HTTPS URL`);
  return parsed.href;
}
function validUtf16Boundary(text, offset) {
  if (offset <= 0 || offset >= text.length)
    return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(previous >= 55296 && previous <= 56319 && next >= 56320 && next <= 57343);
}
function boundedRange(value, text, label) {
  const offset = value.offset;
  const length = value.length;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > text.length || !validUtf16Boundary(text, offset) || !validUtf16Boundary(text, offset + length))
    throw new Error(`${label} must stay on UTF-16 boundaries inside its text`);
  return Object.freeze({ offset, length });
}
function checkedLimits(value) {
  if (!Number.isSafeInteger(value.maximumBlocks) || value.maximumBlocks < 1 || value.maximumBlocks > MAX_ARTICLE_DRAFT_BLOCKS || !Number.isSafeInteger(value.maximumCharacters) || value.maximumCharacters < 1 || value.maximumCharacters > MAX_ARTICLE_DRAFT_CHARACTERS)
    throw new Error("Article draft document limits are invalid");
  return value;
}
function compareStyleRanges(left, right) {
  return left.offset - right.offset || left.length - right.length || articleDraftStyleOrder[left.style] - articleDraftStyleOrder[right.style];
}
function parseArticleDraftDocument(value, limitsValue) {
  const limits = checkedLimits(limitsValue);
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_ARTICLE_DRAFT_DOCUMENT_BYTES || value.includes("\x00"))
    throw new Error("input.document must be bounded canonical ArticleDraftDocument JSON");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("input.document must be valid ArticleDraftDocument JSON");
  }
  if (canonicalJson(parsed) !== value) {
    throw new Error("input.document must use canonical JSON encoding");
  }
  const root = record(parsed, "input.document");
  exactKeys(root, ["schemaVersion", "blocks"], "input.document");
  if (root.schemaVersion !== ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION || !Array.isArray(root.blocks)) {
    throw new Error(`input.document must use ArticleDraftDocument schemaVersion ${ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION}`);
  }
  if (root.blocks.length < 1 || root.blocks.length > limits.maximumBlocks) {
    throw new Error(`input.document must contain 1-${limits.maximumBlocks} blocks`);
  }
  const blocks = [];
  let totalCharacters = 0;
  for (const [index, rawBlock] of root.blocks.entries()) {
    const label = `input.document.blocks[${index}]`;
    const block = record(rawBlock, label);
    const allowed = [
      "type",
      "text",
      ...block.links === undefined ? [] : ["links"],
      ...block.styles === undefined ? [] : ["styles"]
    ];
    exactKeys(block, allowed, label);
    if (typeof block.type !== "string" || !textBlockTypes.has(block.type)) {
      throw new Error(`${label}.type is outside ArticleDraftDocument schemaVersion 1`);
    }
    if (typeof block.text !== "string" || /[\0\r\n]/u.test(block.text)) {
      throw new Error(`${label}.text must be one bounded line`);
    }
    totalCharacters += block.text.length;
    if (totalCharacters > limits.maximumCharacters) {
      throw new Error(`input.document text must contain at most ${limits.maximumCharacters} UTF-16 code units`);
    }
    const rawLinks = block.links ?? [];
    const rawStyles = block.styles ?? [];
    if (!Array.isArray(rawLinks) || rawLinks.length > 500 || !Array.isArray(rawStyles) || rawStyles.length > 500)
      throw new Error(`${label} ranges exceeded their bounds`);
    const links = rawLinks.map((rawLink, rangeIndex) => {
      const rangeLabel = `${label}.links[${rangeIndex}]`;
      const link = record(rawLink, rangeLabel);
      exactKeys(link, ["offset", "length", "url"], rangeLabel);
      const range = boundedRange(link, block.text, rangeLabel);
      return Object.freeze({ ...range, url: boundedHttpsUrl(link.url, `${rangeLabel}.url`) });
    });
    let linkEnd = 0;
    for (const link of links) {
      if (link.offset < linkEnd)
        throw new Error(`${label}.links must be ordered and non-overlapping`);
      linkEnd = link.offset + link.length;
    }
    const styles = rawStyles.map((rawStyle, rangeIndex) => {
      const rangeLabel = `${label}.styles[${rangeIndex}]`;
      const style = record(rawStyle, rangeLabel);
      exactKeys(style, ["offset", "length", "style"], rangeLabel);
      const range = boundedRange(style, block.text, rangeLabel);
      if (style.style !== "bold" && style.style !== "italic" && style.style !== "strikethrough") {
        throw new Error(`${rangeLabel}.style is outside ArticleDraftDocument schemaVersion 1`);
      }
      return Object.freeze({ ...range, style: style.style });
    });
    for (let rangeIndex = 1;rangeIndex < styles.length; rangeIndex += 1) {
      const previous = styles[rangeIndex - 1];
      const current = styles[rangeIndex];
      if (compareStyleRanges(previous, current) > 0) {
        throw new Error(`${label}.styles must be ordered by offset, then length, then style`);
      }
    }
    const styleEnds = {};
    for (const style of styles) {
      const previousEnd = styleEnds[style.style];
      if (previousEnd !== undefined && style.offset < previousEnd) {
        throw new Error(`${label}.styles must not contain duplicate or overlapping same-style ranges`);
      }
      styleEnds[style.style] = style.offset + style.length;
    }
    blocks.push(Object.freeze({
      type: block.type,
      text: block.text,
      links: Object.freeze(links),
      styles: Object.freeze(styles)
    }));
  }
  if (totalCharacters < 1)
    throw new Error("input.document must contain article text");
  return Object.freeze({
    schemaVersion: ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION,
    blocks: Object.freeze(blocks)
  });
}
function articleDraftDocumentIssues(value, limits) {
  try {
    parseArticleDraftDocument(value, limits);
    return Object.freeze([]);
  } catch (error) {
    return Object.freeze([
      error instanceof Error ? error.message : "input.document is invalid"
    ]);
  }
}

// src/index.ts
var PROVIDER_PLUGIN_ID_MAX_LENGTH2 = PROVIDER_PLUGIN_ID_MAX_LENGTH;
var PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH2 = PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH;
var isPortableProviderPluginVersion2 = isPortableProviderPluginVersion;
var isProviderPluginId2 = isProviderPluginId;
var isProviderPluginOperationName2 = isProviderPluginOperationName;
var isProviderPluginSurfaceId2 = isProviderPluginSurfaceId;
export {
  parseArticleDraftDocument,
  isProviderPluginSurfaceId2 as isProviderPluginSurfaceId,
  isProviderPluginOperationName2 as isProviderPluginOperationName,
  isProviderPluginId2 as isProviderPluginId,
  isPortableProviderPluginVersion2 as isPortableProviderPluginVersion,
  articleDraftDocumentIssues,
  PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH2 as PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH,
  PROVIDER_PLUGIN_ID_MAX_LENGTH2 as PROVIDER_PLUGIN_ID_MAX_LENGTH,
  MAX_ARTICLE_DRAFT_DOCUMENT_BYTES,
  MAX_ARTICLE_DRAFT_CHARACTERS,
  MAX_ARTICLE_DRAFT_BLOCKS,
  ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION
};
