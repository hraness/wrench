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
var ARTICLE_DRAFT_DOCUMENT_IMAGE_SCHEMA_VERSION = 2;
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
function checkedImageLimits(value) {
  const text = checkedLimits(value);
  if (!Number.isSafeInteger(value.maximumImages) || value.maximumImages < 1 || value.maximumImages > 100)
    throw new Error("Article draft image limits are invalid");
  return Object.freeze({ ...text, maximumImages: value.maximumImages });
}
function optionalImageText(value, label, maximum) {
  if (value === undefined)
    return;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\0\r]/u.test(value))
    throw new Error(`${label} must be bounded text`);
  return value;
}
function parseArticleDraftDocumentV2(value, limitsValue) {
  const limits = checkedImageLimits(limitsValue);
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
  if (root.schemaVersion !== ARTICLE_DRAFT_DOCUMENT_IMAGE_SCHEMA_VERSION || !Array.isArray(root.blocks)) {
    throw new Error(`input.document must use ArticleDraftDocument schemaVersion ${ARTICLE_DRAFT_DOCUMENT_IMAGE_SCHEMA_VERSION}`);
  }
  if (root.blocks.length < 1 || root.blocks.length > limits.maximumBlocks) {
    throw new Error(`input.document must contain 1-${limits.maximumBlocks} blocks`);
  }
  const blocks = [];
  const imageIndexes = new Set;
  let totalCharacters = 0;
  for (const [index, rawBlock] of root.blocks.entries()) {
    const label = `input.document.blocks[${index}]`;
    const block = record(rawBlock, label);
    if (block.type === "image") {
      exactKeys(block, [
        "type",
        "imageIndex",
        ...block.altText === undefined ? [] : ["altText"],
        ...block.caption === undefined ? [] : ["caption"]
      ], label);
      if (!Number.isSafeInteger(block.imageIndex) || block.imageIndex < 0 || block.imageIndex >= limits.maximumImages || imageIndexes.has(block.imageIndex))
        throw new Error(`${label}.imageIndex must be a unique bounded zero-based image index`);
      const altText = optionalImageText(block.altText, `${label}.altText`, 1000);
      const caption = optionalImageText(block.caption, `${label}.caption`, 1000);
      imageIndexes.add(block.imageIndex);
      blocks.push(Object.freeze({
        type: "image",
        imageIndex: block.imageIndex,
        ...altText === undefined ? {} : { altText },
        ...caption === undefined ? {} : { caption }
      }));
      continue;
    }
    const parsedText = parseArticleDraftDocument(canonicalJson({
      schemaVersion: ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION,
      blocks: [rawBlock]
    }), {
      maximumBlocks: 1,
      maximumCharacters: limits.maximumCharacters
    }).blocks[0];
    if (parsedText === undefined)
      throw new Error(`${label} was omitted after validation`);
    totalCharacters += parsedText.text.length;
    if (totalCharacters > limits.maximumCharacters) {
      throw new Error(`input.document text must contain at most ${limits.maximumCharacters} UTF-16 code units`);
    }
    blocks.push(parsedText);
  }
  if (totalCharacters < 1)
    throw new Error("input.document must contain article text");
  const orderedIndexes = [...imageIndexes].sort((left, right) => left - right);
  if (orderedIndexes.some((value2, index) => value2 !== index)) {
    throw new Error("input.document imageIndex values must be contiguous from zero");
  }
  return Object.freeze({
    schemaVersion: ARTICLE_DRAFT_DOCUMENT_IMAGE_SCHEMA_VERSION,
    blocks: Object.freeze(blocks)
  });
}
function articleDraftDocumentV2Issues(value, limits) {
  try {
    parseArticleDraftDocumentV2(value, limits);
    return Object.freeze([]);
  } catch (error) {
    return Object.freeze([
      error instanceof Error ? error.message : "input.document is invalid"
    ]);
  }
}
// src/article-draft-embeds.ts
var MAX_X_STATUS_ARTICLE_EMBED_CHARACTERS = 25000;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactEmbed(value) {
  if (!isRecord2(value)) {
    throw new Error("X status Article embed must contain exactly text,url");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || keys.sort().join(",") !== "text,url") {
    throw new Error("X status Article embed must contain exactly text,url");
  }
  const textDescriptor = Object.getOwnPropertyDescriptor(value, "text");
  const urlDescriptor = Object.getOwnPropertyDescriptor(value, "url");
  if (textDescriptor === undefined || urlDescriptor === undefined || !("value" in textDescriptor) || !("value" in urlDescriptor) || !textDescriptor.enumerable || !urlDescriptor.enumerable)
    throw new Error("X status Article embed must contain plain text,url values");
  const text = textDescriptor.value;
  const url = urlDescriptor.value;
  if (typeof text !== "string" || text.length < 1 || text.length > MAX_X_STATUS_ARTICLE_EMBED_CHARACTERS || text.includes("\x00") || text.trim().length < 1) {
    throw new Error(`X status Article embed text must contain 1-${MAX_X_STATUS_ARTICLE_EMBED_CHARACTERS} characters`);
  }
  if (typeof url !== "string" || url.length < 1 || url.length > 8192 || /[\0\r\n]/u.test(url)) {
    throw new Error("X status Article embed URL must be one bounded X status URL");
  }
  return Object.freeze({ text, url });
}
function canonicalXStatusUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("X status Article embed URL must be one bounded X status URL");
  }
  const hosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{1,32})\/?$/u.exec(url.pathname);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || !hosts.has(url.hostname) || match === null)
    throw new Error("X status Article embed URL must be one bounded X status URL");
  return `https://x.com/${match[1]}/status/${match[2]}`;
}
function textBlock(type, text) {
  return Object.freeze({
    type,
    text,
    links: Object.freeze([]),
    styles: Object.freeze([])
  });
}
function projectXStatusArticleEmbed(value, target) {
  const embed = exactEmbed(value);
  if (target !== "x-web" && target !== "linkedin-web") {
    throw new Error("X status Article embed target must be x-web or linkedin-web");
  }
  const canonicalUrl = canonicalXStatusUrl(embed.url);
  const quoteBlocks = embed.text.replaceAll(`\r
`, `
`).replaceAll("\r", `
`).split(`
`).filter((line) => line.length > 0).map((line) => textBlock("blockquote", line));
  return Object.freeze([
    ...quoteBlocks,
    Object.freeze({
      type: "paragraph",
      text: canonicalUrl,
      links: Object.freeze([Object.freeze({
        offset: 0,
        length: canonicalUrl.length,
        url: canonicalUrl
      })]),
      styles: Object.freeze([])
    })
  ]);
}

// src/index.ts
var PROVIDER_PLUGIN_ID_MAX_LENGTH2 = PROVIDER_PLUGIN_ID_MAX_LENGTH;
var PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH2 = PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH;
var isPortableProviderPluginVersion2 = isPortableProviderPluginVersion;
var isProviderPluginId2 = isProviderPluginId;
var isProviderPluginOperationName2 = isProviderPluginOperationName;
var isProviderPluginSurfaceId2 = isProviderPluginSurfaceId;
export {
  projectXStatusArticleEmbed,
  parseArticleDraftDocumentV2,
  parseArticleDraftDocument,
  isProviderPluginSurfaceId2 as isProviderPluginSurfaceId,
  isProviderPluginOperationName2 as isProviderPluginOperationName,
  isProviderPluginId2 as isProviderPluginId,
  isPortableProviderPluginVersion2 as isPortableProviderPluginVersion,
  articleDraftDocumentV2Issues,
  articleDraftDocumentIssues,
  PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH2 as PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH,
  PROVIDER_PLUGIN_ID_MAX_LENGTH2 as PROVIDER_PLUGIN_ID_MAX_LENGTH,
  MAX_X_STATUS_ARTICLE_EMBED_CHARACTERS,
  MAX_ARTICLE_DRAFT_DOCUMENT_BYTES,
  MAX_ARTICLE_DRAFT_CHARACTERS,
  MAX_ARTICLE_DRAFT_BLOCKS,
  ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION,
  ARTICLE_DRAFT_DOCUMENT_IMAGE_SCHEMA_VERSION
};
