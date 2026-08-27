// @bun
import {
  PROVIDER_PLUGIN_ID_MAX_LENGTH,
  PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH,
  isPortableProviderPluginVersion,
  isProviderPluginId,
  isProviderPluginOperationName,
  isProviderPluginSurfaceId
} from "./index-26yq8q16.js";
import {
  canonicalJson
} from "./index-dqv16dt0.js";

// src/local-cli-tool-identity.ts
import { types as nodeTypes } from "util";
var strictSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
var sha256Pattern = /^[a-f0-9]{64}$/u;
var releaseCommitPattern = /^[a-f0-9]{40}$/u;
var tokenPattern = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/u;
var implementationPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._/+:-]{0,254}[A-Za-z0-9])?$/u;
function hasWellFormedUnicode(value) {
  for (let index = 0;index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      if (index + 1 >= value.length)
        return false;
      const next = value.charCodeAt(index + 1);
      if (next < 56320 || next > 57343)
        return false;
      index += 1;
    } else if (code >= 56320 && code <= 57343) {
      return false;
    }
  }
  return true;
}
function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error(`${label} has unsupported symbol fields`);
  }
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor) || !hasWellFormedUnicode(key) || /[\u0000-\u001f\u007f-\u009f]/u.test(key)) {
      throw new Error(`${label} has unsupported accessor fields`);
    }
    result[key] = descriptor.value;
  }
  return result;
}
function denseArray(value, label, maximum) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} is malformed`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") || Object.keys(descriptors).length !== value.length + 1) {
    throw new Error(`${label} is malformed`);
  }
  return Object.freeze(Array.from({ length: value.length }, (_unused, index) => {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} is malformed`);
    }
    return descriptor.value;
  }));
}
function exactKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported keys: ${unexpected.join(", ")}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key) && key !== "sourceUrl" && key !== "releaseCommit" && key !== "releaseManifestSha256" && key !== "releaseManifestUrl" && key !== "archiveSha256" && key !== "downloadUrl") {
      throw new Error(`${label}.${key} is required`);
    }
  }
}
function exactHttpsUrl(value, label) {
  if (typeof value !== "string" || value.length > 2000) {
    throw new Error(`${label} must be a bounded exact HTTPS URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a bounded exact HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.search !== "" || parsed.href !== value) {
    throw new Error(`${label} must be a credential-free exact HTTPS URL without a query or fragment`);
  }
  return value;
}
function optionalDigest(value, label) {
  if (value === undefined)
    return;
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be one lowercase SHA-256 digest`);
  }
  return value;
}
function optionalUrl(value, label) {
  return value === undefined ? undefined : exactHttpsUrl(value, label);
}
function parseLocalCliToolIdentityV1(value) {
  const tool = record(value, "local CLI tool identity");
  exactKeys(tool, [
    "schemaVersion",
    "id",
    "implementation",
    "versionScheme",
    "version",
    "releaseCommit",
    "releaseManifestSha256",
    "releaseManifestUrl",
    "sourceUrl",
    "artifacts"
  ], "local CLI tool identity");
  if (tool.schemaVersion !== 1) {
    throw new Error("local CLI tool identity schemaVersion must be 1");
  }
  if (typeof tool.id !== "string" || !tokenPattern.test(tool.id)) {
    throw new Error("local CLI tool identity id is malformed");
  }
  if (typeof tool.implementation !== "string" || !implementationPattern.test(tool.implementation)) {
    throw new Error("local CLI tool identity implementation is malformed");
  }
  if (tool.versionScheme !== "semver" && tool.versionScheme !== "opaque") {
    throw new Error("local CLI tool identity versionScheme must be semver or opaque");
  }
  if (typeof tool.version !== "string" || tool.version.length < 1 || tool.version.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(tool.version) || !hasWellFormedUnicode(tool.version) || tool.versionScheme === "semver" && !strictSemverPattern.test(tool.version)) {
    throw new Error("local CLI tool identity version is malformed");
  }
  const hasReleaseCommit = tool.releaseCommit !== undefined;
  if (hasReleaseCommit && (typeof tool.releaseCommit !== "string" || !releaseCommitPattern.test(tool.releaseCommit))) {
    throw new Error("local CLI tool identity releaseCommit must be one lowercase 40-character commit ID");
  }
  const releaseManifestSha256 = optionalDigest(tool.releaseManifestSha256, "local CLI tool identity releaseManifestSha256");
  const sourceUrl = optionalUrl(tool.sourceUrl, "local CLI tool identity sourceUrl");
  const releaseManifestUrl = optionalUrl(tool.releaseManifestUrl, "local CLI tool identity releaseManifestUrl");
  if (releaseManifestSha256 === undefined !== (releaseManifestUrl === undefined)) {
    throw new Error("local CLI tool identity release manifest URL and digest must be declared together");
  }
  const rawArtifacts = denseArray(tool.artifacts, "local CLI tool identity artifacts", 16);
  const artifacts = rawArtifacts.map((rawArtifact, index) => {
    const artifact = record(rawArtifact, `local CLI tool artifact ${index}`);
    exactKeys(artifact, [
      "platform",
      "arch",
      "executableSha256",
      "archiveSha256",
      "downloadUrl"
    ], `local CLI tool artifact ${index}`);
    if (typeof artifact.platform !== "string" || !tokenPattern.test(artifact.platform)) {
      throw new Error(`local CLI tool artifact ${index}.platform is malformed`);
    }
    if (typeof artifact.arch !== "string" || !tokenPattern.test(artifact.arch)) {
      throw new Error(`local CLI tool artifact ${index}.arch is malformed`);
    }
    if (typeof artifact.executableSha256 !== "string" || !sha256Pattern.test(artifact.executableSha256)) {
      throw new Error(`local CLI tool artifact ${index}.executableSha256 must be one lowercase SHA-256 digest`);
    }
    const archiveSha256 = optionalDigest(artifact.archiveSha256, `local CLI tool artifact ${index}.archiveSha256`);
    const downloadUrl = optionalUrl(artifact.downloadUrl, `local CLI tool artifact ${index}.downloadUrl`);
    if (archiveSha256 === undefined !== (downloadUrl === undefined)) {
      throw new Error(`local CLI tool artifact ${index} archive URL and digest must be declared together`);
    }
    return Object.freeze({
      platform: artifact.platform,
      arch: artifact.arch,
      executableSha256: artifact.executableSha256,
      ...archiveSha256 === undefined ? {} : { archiveSha256 },
      ...downloadUrl === undefined ? {} : { downloadUrl }
    });
  }).sort((left, right) => {
    const leftCoordinate = `${left.platform}\x00${left.arch}`;
    const rightCoordinate = `${right.platform}\x00${right.arch}`;
    return leftCoordinate < rightCoordinate ? -1 : leftCoordinate > rightCoordinate ? 1 : 0;
  });
  const coordinates = artifacts.map((artifact) => `${artifact.platform}/${artifact.arch}`);
  if (new Set(coordinates).size !== coordinates.length) {
    throw new Error("local CLI tool identity repeats a platform/architecture artifact");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: tool.id,
    implementation: tool.implementation,
    versionScheme: tool.versionScheme,
    version: tool.version,
    ...hasReleaseCommit ? { releaseCommit: tool.releaseCommit } : {},
    ...releaseManifestSha256 === undefined ? {} : { releaseManifestSha256, releaseManifestUrl },
    ...sourceUrl === undefined ? {} : { sourceUrl },
    artifacts: Object.freeze(artifacts)
  });
}
function localCliToolArtifactForCurrentRuntime(tool) {
  const artifact = tool.artifacts.find((candidate) => candidate.platform === process.platform && candidate.arch === process.arch);
  if (artifact === undefined) {
    throw new Error(`local CLI tool ${tool.id}@${tool.version} does not support ${process.platform}/${process.arch}`);
  }
  return artifact;
}
// src/provider-plugin-cleanup-execution.ts
function startProviderPluginCleanupTrackedOperation(register, start) {
  if (register === undefined) {
    return start(undefined, Object.freeze({
      verified: () => {
        return;
      },
      unsafe: () => {
        return;
      }
    }));
  }
  let resolveCleanup;
  let rejectCleanup;
  let settled = false;
  const cleanupBarrier = new Promise((resolve, reject) => {
    resolveCleanup = resolve;
    rejectCleanup = reject;
  });
  cleanupBarrier.catch(() => {
    return;
  });
  const publishCleanupResource = register(cleanupBarrier);
  const cleanup = Object.freeze({
    verified: () => {
      if (settled)
        return;
      settled = true;
      resolveCleanup?.();
    },
    unsafe: (reason) => {
      if (settled)
        return;
      settled = true;
      rejectCleanup?.(reason instanceof Error ? reason : new Error("provider cleanup could not be verified"));
    }
  });
  try {
    return Promise.resolve(start(typeof publishCleanupResource === "function" ? publishCleanupResource : undefined, cleanup)).catch((error) => {
      cleanup.unsafe(error);
      throw error;
    });
  } catch (error) {
    cleanup.unsafe(error);
    throw error;
  }
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
function record2(value, label) {
  if (!isRecord(value))
    throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys2(value, keys, label) {
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
  const root = record2(parsed, "input.document");
  exactKeys2(root, ["schemaVersion", "blocks"], "input.document");
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
    const block = record2(rawBlock, label);
    const allowed = [
      "type",
      "text",
      ...block.links === undefined ? [] : ["links"],
      ...block.styles === undefined ? [] : ["styles"]
    ];
    exactKeys2(block, allowed, label);
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
      const link = record2(rawLink, rangeLabel);
      exactKeys2(link, ["offset", "length", "url"], rangeLabel);
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
      const style = record2(rawStyle, rangeLabel);
      exactKeys2(style, ["offset", "length", "style"], rangeLabel);
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
  const root = record2(parsed, "input.document");
  exactKeys2(root, ["schemaVersion", "blocks"], "input.document");
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
    const block = record2(rawBlock, label);
    if (block.type === "image") {
      exactKeys2(block, [
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
  startProviderPluginCleanupTrackedOperation,
  projectXStatusArticleEmbed,
  parseLocalCliToolIdentityV1,
  parseArticleDraftDocumentV2,
  parseArticleDraftDocument,
  localCliToolArtifactForCurrentRuntime,
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
