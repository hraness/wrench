const META_ASSET_ORIGIN = "https://static.xx.fbcdn.net";
const MAX_ROOT_HTML_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_URL_CHARACTERS = 4_096;
const MAX_LINK_ELEMENTS = 4_096;
const MAX_JSON_SCRIPT_ELEMENTS = 512;
const MAX_JSON_SCRIPT_BYTES = 12 * 1024 * 1024;
const MAX_LINK_ATTRIBUTES = 128;
const MAX_ELEMENT_TAG_CHARACTERS = 64 * 1024;
const MAX_ASSET_URLS = 16;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLES = 64;
const UTF8_ENCODER = new TextEncoder();

const FRIENDLY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{2,160}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const HTML_ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/u;
const RAW_TEXT_ELEMENT_NAMES = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);
const CONTROL_HEADER_KEYWORDS = new Set([
  "catch",
  "for",
  "if",
  "switch",
  "while",
  "with",
]);
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

export type MetaRelayOperationRevision = {
  readonly schemaVersion: 1;
  readonly friendlyName: string;
  readonly moduleName: string;
  readonly docId: string;
  readonly agreeingBundleCount: number;
};

function utf8ByteLengthWithin(value: string, maximum: number): number {
  if (value.length > maximum) return maximum + 1;
  const bytes = UTF8_ENCODER.encode(value).byteLength;
  return bytes > maximum ? maximum + 1 : bytes;
}

function boundedText(
  value: unknown,
  maximumBytes: number,
  label: string,
): { readonly text: string; readonly bytes: number } {
  const bytes = typeof value === "string"
    ? utf8ByteLengthWithin(value, maximumBytes)
    : maximumBytes + 1;
  if (
    typeof value !== "string"
    || value.length < 1
    || bytes > maximumBytes
    || value.includes("\0")
  ) throw new Error(`${label} must be bounded inert text`);
  return { text: value, bytes };
}

function inspected<T>(read: () => T, label: string): T {
  try {
    return read();
  } catch {
    throw new Error(`${label} could not be inspected as plain data`);
  }
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!inspected(() => Array.isArray(value), label)) {
    throw new Error(`${label} must contain between 1 and ${maximum} entries`);
  }
  const array = value as readonly unknown[];
  const length = inspected(() => array.length, label);
  if (length < 1 || length > maximum) {
    throw new Error(`${label} must contain between 1 and ${maximum} entries`);
  }
  if (
    inspected(() => Object.getPrototypeOf(array) as unknown, label)
    !== Array.prototype
  ) {
    throw new Error(`${label} must be a dense plain array`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = inspected(
      () => Object.getOwnPropertyDescriptor(array, String(index)),
      label,
    );
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) throw new Error(`${label} must be a dense plain array`);
    result.push(descriptor.value);
  }
  const keys = inspected(() => Reflect.ownKeys(array), label);
  if (
    keys.length !== length + 1
    || keys.some((key) =>
      typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)))
  ) throw new Error(`${label} contained unsupported fields`);
  return result;
}

function exactFriendlyName(value: unknown): string {
  if (typeof value !== "string" || !FRIENDLY_NAME_PATTERN.test(value)) {
    throw new Error("Meta Relay friendly name changed its reviewed grammar");
  }
  return value;
}

function exactMetaAssetUrl(raw: string): string {
  if (
    raw.length < 1
    || raw.length > MAX_ASSET_URL_CHARACTERS
    || raw.includes("\\")
  ) throw new Error("Meta root HTML contained a malformed JavaScript asset source");
  if (
    !raw.startsWith(`${META_ASSET_ORIGIN}/rsrc.php/`)
    || raw.includes("?")
    || raw.includes("#")
    || raw.includes("%")
  ) throw new Error("Meta root HTML contained a noncanonical JavaScript asset source");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Meta root HTML contained a malformed JavaScript asset source");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== META_ASSET_ORIGIN
    || parsed.hostname !== "static.xx.fbcdn.net"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.href !== raw
    || parsed.pathname.length > 2_048
    || !/^\/rsrc\.php\/(?:[A-Za-z0-9_-]{1,128}\/){1,16}[A-Za-z0-9_-]{1,1024}\.js$/u.test(
      parsed.pathname,
    )
  ) throw new Error("Meta root HTML contained an unreviewed JavaScript asset source");
  return parsed.href;
}

type HtmlAttribute = {
  readonly value: string | null;
  readonly quoted: boolean;
};

type HtmlTag = {
  readonly closing: boolean;
  readonly end: number;
  readonly name: string;
  readonly nameEnd: number;
};

function isHtmlSpace(value: string | undefined): boolean {
  return value === " "
    || value === "\t"
    || value === "\n"
    || value === "\r"
    || value === "\f";
}

function isHtmlNameCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_:-]/u.test(value);
}

function htmlTagAt(source: string, start: number): HtmlTag | null {
  let index = start + 1;
  let closing = false;
  if (source[index] === "/") {
    closing = true;
    index += 1;
  }
  const nameStart = index;
  while (isHtmlNameCharacter(source[index])) index += 1;
  if (index === nameStart) return null;
  const boundary = source[index];
  if (
    boundary !== ">"
    && boundary !== "/"
    && !isHtmlSpace(boundary)
  ) return null;

  let quote: "'" | "\"" | null = null;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    if ((cursor + 1) - start > MAX_ELEMENT_TAG_CHARACTERS) {
      throw new Error("Meta root HTML contained an oversized element");
    }
    const character = source[cursor];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (character === "<") {
      throw new Error("Meta root HTML contained a malformed element");
    }
    if (character === ">") {
      return {
        closing,
        end: cursor + 1,
        name: source.slice(nameStart, index).toLowerCase(),
        nameEnd: index,
      };
    }
  }
  throw new Error("Meta root HTML contained a malformed element");
}

function isExactRawTextClosingTag(
  source: string,
  tag: HtmlTag | null,
  elementName: string,
): tag is HtmlTag {
  if (
    tag?.closing !== true
    || tag.name !== elementName
  ) return false;
  for (let index = tag.nameEnd; index < tag.end - 1; index += 1) {
    if (!isHtmlSpace(source[index])) return false;
  }
  return true;
}

function skipHtmlComment(source: string, start: number): number {
  const end = source.indexOf("-->", start + 4);
  if (end < 0) throw new Error("Meta root HTML contained a malformed comment");
  return end + 3;
}

function skipHtmlDeclaration(source: string, start: number): number {
  if (source.startsWith("<![CDATA[", start)) {
    const end = source.indexOf("]]>", start + 9);
    if (end < 0) throw new Error("Meta root HTML contained malformed CDATA");
    return end + 3;
  }
  const end = source.indexOf(">", start + 2);
  if (end < 0) throw new Error("Meta root HTML contained a malformed declaration");
  return end + 1;
}

function rawTextElementEnd(
  source: string,
  start: number,
  elementName: string,
): number {
  let index = start;
  while (index < source.length) {
    const candidate = source.indexOf("</", index);
    if (candidate < 0) {
      throw new Error("Meta root HTML contained an unterminated raw-text element");
    }
    const tag = htmlTagAt(source, candidate);
    if (isExactRawTextClosingTag(source, tag, elementName)) return tag.end;
    index = candidate + 2;
  }
  throw new Error("Meta root HTML contained an unterminated raw-text element");
}

function rawTextElementClosingTag(
  source: string,
  start: number,
  elementName: string,
): { readonly start: number; readonly end: number } {
  let index = start;
  while (index < source.length) {
    const candidate = source.indexOf("</", index);
    if (candidate < 0) {
      throw new Error("Meta root HTML contained an unterminated raw-text element");
    }
    const tag = htmlTagAt(source, candidate);
    if (isExactRawTextClosingTag(source, tag, elementName)) {
      return { start: candidate, end: tag.end };
    }
    index = candidate + 2;
  }
  throw new Error("Meta root HTML contained an unterminated raw-text element");
}

function htmlAttributes(
  source: string,
  tagStart: number,
  tag: HtmlTag,
): ReadonlyMap<string, HtmlAttribute> {
  if (tag.end - tagStart > MAX_ELEMENT_TAG_CHARACTERS) {
    throw new Error("Meta root HTML contained an oversized element");
  }

  const attributes = new Map<string, HtmlAttribute>();
  const bodyEnd = tag.end - 1;
  let index = tag.nameEnd;
  while (index < bodyEnd) {
    let spaces = 0;
    while (isHtmlSpace(source[index])) {
      index += 1;
      spaces += 1;
    }
    if (index >= bodyEnd) break;
    if (source[index] === "/") {
      index += 1;
      while (isHtmlSpace(source[index])) index += 1;
      if (index !== bodyEnd) {
        throw new Error("Meta root HTML contained malformed element attributes");
      }
      break;
    }
    if (spaces < 1) {
      throw new Error("Meta root HTML contained ambiguous element attributes");
    }

    const nameStart = index;
    while (
      source[index] !== undefined
      && /[A-Za-z0-9_.:-]/u.test(source[index] ?? "")
    ) index += 1;
    const rawName = source.slice(nameStart, index);
    if (!HTML_ATTRIBUTE_NAME_PATTERN.test(rawName)) {
      throw new Error("Meta root HTML contained malformed element attributes");
    }
    const name = rawName.toLowerCase();
    if (attributes.has(name)) {
      throw new Error("Meta root HTML contained duplicate element attributes");
    }
    if (attributes.size >= MAX_LINK_ATTRIBUTES) {
      throw new Error("Meta root HTML exceeded its reviewed element-attribute bound");
    }

    const afterName = index;
    while (isHtmlSpace(source[index])) index += 1;
    let value: string | null = null;
    let quoted = false;
    if (source[index] === "=") {
      index += 1;
      while (isHtmlSpace(source[index])) index += 1;
      const quote = source[index];
      if (quote === "'" || quote === "\"") {
        quoted = true;
        index += 1;
        const valueStart = index;
        while (index < bodyEnd && source[index] !== quote) index += 1;
        if (index >= bodyEnd) {
          throw new Error("Meta root HTML contained malformed element attributes");
        }
        value = source.slice(valueStart, index);
        index += 1;
        if (
          index < bodyEnd
          && !isHtmlSpace(source[index])
          && source[index] !== "/"
        ) {
          throw new Error("Meta root HTML contained ambiguous element attributes");
        }
      } else {
        const valueStart = index;
        while (
          index < bodyEnd
          && !isHtmlSpace(source[index])
        ) index += 1;
        value = source.slice(valueStart, index);
        if (
          value.length < 1
          || /["'`=<>]/u.test(value)
        ) {
          throw new Error("Meta root HTML contained malformed element attributes");
        }
      }
    } else {
      index = afterName;
    }
    attributes.set(name, { value, quoted });
  }
  return attributes;
}

function exactPreloadScriptHref(
  attributes: ReadonlyMap<string, HtmlAttribute>,
): string | null {
  const rel = attributes.get("rel");
  const as = attributes.get("as");
  const relTokens = rel?.value?.split(/[\t\n\f\r ]+/u).filter(
    (token) => token.length > 0,
  ) ?? [];
  const hasPreloadSemantics = relTokens.some(
    (token) => token.toLowerCase() === "preload",
  );
  if (hasPreloadSemantics && rel?.value !== "preload") {
    throw new Error("Meta root HTML contained an ambiguous preload relation");
  }
  const hasScriptSemantics = as?.value?.toLowerCase() === "script";
  if (hasScriptSemantics && as?.value !== "script") {
    throw new Error("Meta root HTML contained an ambiguous script destination");
  }
  if (!hasPreloadSemantics || !hasScriptSemantics) return null;

  const href = attributes.get("href");
  if (href?.quoted !== true || href.value === null) {
    throw new Error("Meta preload-script link omitted one quoted href");
  }
  return href.value;
}

/**
 * Extract canonical first-party JavaScript bundle URLs from actual inert HTML
 * preload-script links. The helper never parses resource-map text or fetches a
 * returned URL.
 */
export function extractMetaRelayBundleUrls(htmlValue: unknown): readonly string[] {
  const { text: html } = boundedText(
    htmlValue,
    MAX_ROOT_HTML_BYTES,
    "Meta root HTML",
  );
  const urls: string[] = [];
  const unique = new Set<string>();
  let linkElements = 0;
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart < 0) break;
    if (html.startsWith("<!--", tagStart)) {
      index = skipHtmlComment(html, tagStart);
      continue;
    }
    if (html.startsWith("<!", tagStart) || html.startsWith("<?", tagStart)) {
      index = skipHtmlDeclaration(html, tagStart);
      continue;
    }

    const tag = htmlTagAt(html, tagStart);
    if (tag === null) {
      index = tagStart + 1;
      continue;
    }
    index = tag.end;
    if (!tag.closing && RAW_TEXT_ELEMENT_NAMES.has(tag.name)) {
      index = rawTextElementEnd(html, tag.end, tag.name);
      continue;
    }
    if (tag.closing || tag.name !== "link") continue;

    linkElements += 1;
    if (linkElements > MAX_LINK_ELEMENTS) {
      throw new Error("Meta root HTML exceeded its reviewed link-element bound");
    }
    const href = exactPreloadScriptHref(htmlAttributes(html, tagStart, tag));
    if (href === null) continue;
    const exact = exactMetaAssetUrl(href);
    if (unique.has(exact)) continue;
    unique.add(exact);
    urls.push(exact);
    if (urls.length > MAX_ASSET_URLS) {
      throw new Error("Meta root HTML exposed too many preload-script assets");
    }
  }
  if (urls.length < 1) {
    throw new Error("Meta root HTML omitted a reviewed preload-script asset");
  }
  return Object.freeze(urls);
}

/**
 * Extract bodies from actual `<script type="application/json">` elements.
 * Attribute names are parsed exactly, duplicates are rejected, and lookalikes
 * such as `data-type` never acquire script-type semantics.
 */
export function extractMetaJsonScriptTexts(
  htmlValue: unknown,
): readonly string[] {
  const { text: html } = boundedText(
    htmlValue,
    MAX_ROOT_HTML_BYTES,
    "Meta root HTML",
  );
  const texts: string[] = [];
  let scriptElements = 0;
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart < 0) break;
    if (html.startsWith("<!--", tagStart)) {
      index = skipHtmlComment(html, tagStart);
      continue;
    }
    if (html.startsWith("<!", tagStart) || html.startsWith("<?", tagStart)) {
      index = skipHtmlDeclaration(html, tagStart);
      continue;
    }
    const tag = htmlTagAt(html, tagStart);
    if (tag === null) {
      index = tagStart + 1;
      continue;
    }
    index = tag.end;
    if (tag.closing || tag.name !== "script") {
      if (!tag.closing && RAW_TEXT_ELEMENT_NAMES.has(tag.name)) {
        index = rawTextElementEnd(html, tag.end, tag.name);
      }
      continue;
    }
    scriptElements += 1;
    if (scriptElements > MAX_JSON_SCRIPT_ELEMENTS) {
      throw new Error("Meta root HTML exceeded its reviewed script-element bound");
    }
    const attributes = htmlAttributes(html, tagStart, tag);
    const closing = rawTextElementClosingTag(html, tag.end, "script");
    index = closing.end;
    const type = attributes.get("type");
    if (type?.value?.toLowerCase() === "application/json") {
      if (type.quoted !== true || type.value !== "application/json") {
        throw new Error("Meta JSON script contained an ambiguous type attribute");
      }
      const text = html.slice(tag.end, closing.start);
      if (utf8ByteLengthWithin(text, MAX_JSON_SCRIPT_BYTES) > MAX_JSON_SCRIPT_BYTES) {
        throw new Error("Meta bootloader JSON script exceeded its reviewed bound");
      }
      texts.push(text);
    }
  }
  if (texts.length < 1) {
    throw new Error("Meta HTML response omitted bootloader JSON");
  }
  return Object.freeze(texts);
}

function skipQuoted(
  source: string,
  start: number,
  quote: "'" | "\"" | "`",
): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) return index + 1;
    if (quote !== "`" && isLineTerminator(character)) {
      throw new Error("Meta Relay bundle contained malformed JavaScript");
    }
  }
  throw new Error("Meta Relay bundle contained malformed JavaScript");
}

function isLineTerminator(value: string | undefined): boolean {
  return value === "\n"
    || value === "\r"
    || value === "\u2028"
    || value === "\u2029";
}

function skipLineComment(source: string, start: number): number {
  for (let index = start + 2; index < source.length; index += 1) {
    if (isLineTerminator(source[index])) {
      return source[index] === "\r" && source[index + 1] === "\n"
        ? index + 2
        : index + 1;
    }
  }
  return source.length;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  if (end < 0) throw new Error("Meta Relay bundle contained malformed JavaScript");
  return end + 2;
}

function skipRegexLiteral(source: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (isLineTerminator(character)) {
      throw new Error("Meta Relay bundle contained malformed JavaScript");
    }
    if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) {
      index += 1;
      while (/[A-Za-z]/u.test(source[index] ?? "")) index += 1;
      return index;
    }
  }
  throw new Error("Meta Relay bundle contained malformed JavaScript");
}

function identifierEnd(source: string, start: number): number {
  let index = start + 1;
  while (/[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
  return index;
}

function numberEnd(source: string, start: number): number {
  let index = start + 1;
  while (/[A-Za-z0-9._]/u.test(source[index] ?? "")) index += 1;
  return index;
}

function nextNonWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  return index;
}

function previousNonWhitespace(source: string, start: number): string | null {
  for (let index = start - 1; index >= 0; index -= 1) {
    const character = source[index];
    if (character !== undefined && !/\s/u.test(character)) return character;
  }
  return null;
}

function hasReviewedCallTerminator(source: string, start: number): boolean {
  let index = start;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character !== undefined && /\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    return character === ";";
  }
  return true;
}

function findCallEnd(source: string, openParenthesis: number): number {
  let depth = 1;
  let index = openParenthesis + 1;
  let canStartRegex = true;
  let pendingControlParenthesis = false;
  const controlParentheses = [false];
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "'" || character === "\"" || character === "`") {
      index = skipQuoted(source, index, character);
      canStartRegex = false;
      pendingControlParenthesis = false;
      continue;
    }
    if (character === "/" && next === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === "/" && canStartRegex) {
      index = skipRegexLiteral(source, index);
      canStartRegex = false;
      pendingControlParenthesis = false;
      continue;
    }
    if (character === "/") {
      index += 1;
      canStartRegex = true;
      pendingControlParenthesis = false;
      continue;
    }
    if (character !== undefined && /[A-Za-z_$]/u.test(character)) {
      const end = identifierEnd(source, index);
      const identifier = source.slice(index, end);
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(identifier);
      pendingControlParenthesis = CONTROL_HEADER_KEYWORDS.has(identifier);
      index = end;
      continue;
    }
    if (character !== undefined && /[0-9]/u.test(character)) {
      index = numberEnd(source, index);
      canStartRegex = false;
      pendingControlParenthesis = false;
      continue;
    }
    if (character === "(") {
      depth += 1;
      controlParentheses.push(pendingControlParenthesis);
      canStartRegex = true;
      pendingControlParenthesis = false;
    } else if (character === ")") {
      depth -= 1;
      const closedControlHeader = controlParentheses.pop() ?? false;
      if (depth === 0) return index + 1;
      if (depth < 0) throw new Error("Meta Relay bundle contained malformed JavaScript");
      canStartRegex = closedControlHeader;
      pendingControlParenthesis = false;
    } else if (character === "]" || character === "}") {
      canStartRegex = false;
      pendingControlParenthesis = false;
    } else if (character !== undefined && !/\s/u.test(character)) {
      canStartRegex = character !== "." && character !== "?";
      pendingControlParenthesis = false;
    }
    index += 1;
  }
  throw new Error("Meta Relay bundle contained malformed JavaScript");
}

function moduleNameFromCall(call: string): string | null {
  const match = /^__d\s*\(\s*"([A-Za-z][A-Za-z0-9_]{2,220})"\s*,/u.exec(call);
  return match?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function docIdFromReviewedModule(call: string, moduleName: string): string {
  const escapedName = escapeRegExp(moduleName);
  const wrapper = new RegExp(
    `^__d\\s*\\(\\s*"${escapedName}"\\s*,\\s*\\[\\s*\\]\\s*,\\s*\\(\\s*function\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*)\\}\\s*\\)\\s*,\\s*(?:null|-?[0-9]{1,7})\\s*\\)$`,
    "u",
  );
  const wrapped = wrapper.exec(call);
  if (wrapped?.[1] === undefined || wrapped[2] === undefined) {
    throw new Error("Meta Relay operation module changed its reviewed boundary");
  }
  const parameters = wrapped[1].split(",").map((value) => value.trim());
  if (
    parameters.length !== 6
    || parameters.some((value) => !IDENTIFIER_PATTERN.test(value))
    || new Set(parameters).size !== parameters.length
  ) throw new Error("Meta Relay operation module changed its reviewed function shape");
  const exporter = parameters[4];
  if (exporter === undefined) {
    throw new Error("Meta Relay operation module omitted its reviewed exporter");
  }
  const exportPattern = new RegExp(
    `^\\s*(?:"use strict";\\s*)?${escapeRegExp(exporter)}\\.exports\\s*=\\s*(["'])([0-9]{10,24})\\1\\s*;?\\s*$`,
    "u",
  );
  const exported = exportPattern.exec(wrapped[2]);
  if (exported?.[2] === undefined) {
    throw new Error("Meta Relay operation module did not uniquely export a bounded doc ID");
  }
  return exported[2];
}

function parsedTargetCallPositions(
  source: string,
  moduleName: string,
): {
  readonly all: ReadonlySet<number>;
  readonly directStatements: ReadonlySet<number>;
} {
  const sourceFile = ts.createSourceFile(
    "meta-relay-bundle.js",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const diagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    throw new Error("Meta Relay bundle contained malformed JavaScript");
  }
  const isTargetCall = (node: ts.Node): node is ts.CallExpression => {
    if (!ts.isCallExpression(node)) return false;
    const first = node.arguments[0];
    if (
      first === undefined
      || (!ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first))
      || first.text !== moduleName
    ) return false;
    return ts.isIdentifier(node.expression)
      ? node.expression.text === "__d"
      : ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "__d";
  };
  const all = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (isTargetCall(node)) {
      const expression = node.expression;
      all.add(
        ts.isIdentifier(expression)
          ? expression.getStart(sourceFile)
          : ts.isPropertyAccessExpression(expression)
            ? expression.name.getStart(sourceFile)
            : node.getStart(sourceFile),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const directStatements = new Set<number>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExpressionStatement(statement)
      && isTargetCall(statement.expression)
      && ts.isIdentifier(statement.expression.expression)
    ) {
      directStatements.add(statement.expression.getStart(sourceFile));
    }
  }
  return { all, directStatements };
}

function targetModuleDocIds(source: string, moduleName: string): readonly string[] {
  const ids: string[] = [];
  const parsedPositions = parsedTargetCallPositions(source, moduleName);
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let canStartRegex = true;
  let atStatementBoundary = true;
  let pendingControlParenthesis = false;
  const controlParentheses: boolean[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "'" || character === "\"" || character === "`") {
      index = skipQuoted(source, index, character);
      canStartRegex = false;
      atStatementBoundary = false;
      pendingControlParenthesis = false;
      continue;
    }
    if (character === "/" && next === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === "/" && canStartRegex) {
      index = skipRegexLiteral(source, index);
      canStartRegex = false;
      atStatementBoundary = false;
      pendingControlParenthesis = false;
      continue;
    }
    if (character === "/") {
      index += 1;
      canStartRegex = true;
      atStatementBoundary = false;
      pendingControlParenthesis = false;
      continue;
    }
    if (character !== undefined && /[A-Za-z_$]/u.test(character)) {
      const end = identifierEnd(source, index);
      const identifier = source.slice(index, end);
      const open = nextNonWhitespace(source, end);
      if (
        identifier === "__d"
        && source[open] === "("
        && parenthesisDepth === 0
        && bracketDepth === 0
        && braceDepth === 0
        && parsedPositions.all.has(index)
      ) {
        const callEnd = findCallEnd(source, open);
        const call = source.slice(index, callEnd);
        if (moduleNameFromCall(call) === moduleName) {
          if (
            !parsedPositions.directStatements.has(index)
            || !atStatementBoundary
            || previousNonWhitespace(source, index) === "."
            || !hasReviewedCallTerminator(source, callEnd)
          ) {
            throw new Error("Meta Relay operation module changed its reviewed boundary");
          }
          ids.push(docIdFromReviewedModule(call, moduleName));
          if (ids.length > 1) {
            throw new Error("Meta Relay bundle contained a duplicate operation module");
          }
        }
        index = callEnd;
        canStartRegex = false;
        atStatementBoundary = false;
        pendingControlParenthesis = false;
        continue;
      }
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(identifier);
      atStatementBoundary = false;
      pendingControlParenthesis = CONTROL_HEADER_KEYWORDS.has(identifier);
      index = end;
      continue;
    }
    if (character !== undefined && /[0-9]/u.test(character)) {
      index = numberEnd(source, index);
      canStartRegex = false;
      atStatementBoundary = false;
      pendingControlParenthesis = false;
      continue;
    }

    let closedControlHeader = false;
    if (character === "(") {
      parenthesisDepth += 1;
      controlParentheses.push(pendingControlParenthesis);
      pendingControlParenthesis = false;
    } else if (character === ")") {
      parenthesisDepth -= 1;
      closedControlHeader = controlParentheses.pop() ?? false;
      pendingControlParenthesis = false;
    } else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth -= 1;
    if (parenthesisDepth < 0 || bracketDepth < 0 || braceDepth < 0) {
      throw new Error("Meta Relay bundle contained malformed JavaScript");
    }
    if (
      character === ";"
      && parenthesisDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
    ) {
      atStatementBoundary = true;
    } else if (
      character === "}"
      && parenthesisDepth === 0
      && bracketDepth === 0
      && braceDepth === 0
    ) {
      atStatementBoundary = true;
    } else if (character !== undefined && !/\s/u.test(character)) {
      atStatementBoundary = false;
      pendingControlParenthesis = false;
    }
    if (character === ")") {
      canStartRegex = closedControlHeader;
    } else if (character === "]" || character === "}") {
      canStartRegex = false;
    } else if (character !== undefined && !/\s/u.test(character)) {
      canStartRegex = character !== "." && character !== "?";
    }
    index += 1;
  }

  if (parenthesisDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0) {
    throw new Error("Meta Relay bundle contained malformed JavaScript");
  }
  return ids;
}

/**
 * Resolve current registered-operation evidence from already-fetched,
 * first-party bundle text. Duplicate evidence may agree only across bundles.
 */
export function resolveMetaRelayOperationRevision(
  bundleTextsValue: unknown,
  friendlyNameValue: unknown,
): MetaRelayOperationRevision {
  const friendlyName = exactFriendlyName(friendlyNameValue);
  const moduleName = `${friendlyName}_facebookRelayOperation`;
  const values = denseArray(bundleTextsValue, "Meta Relay bundle list", MAX_BUNDLES);
  const texts: string[] = [];
  let totalBytes = 0;

  for (const value of values) {
    const { text, bytes } = boundedText(
      value,
      MAX_BUNDLE_BYTES,
      "Meta Relay bundle",
    );
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BUNDLE_BYTES) {
      throw new Error("Meta Relay bundles exceeded their reviewed aggregate byte bound");
    }
    texts.push(text);
  }

  const ids: string[] = [];
  for (const text of texts) {
    const matches = targetModuleDocIds(text, moduleName);
    if (matches[0] !== undefined) ids.push(matches[0]);
  }

  if (ids.length < 1) {
    throw new Error("Meta Relay bundles omitted the exact reviewed operation module");
  }
  if (new Set(ids).size !== 1) {
    throw new Error("Meta Relay bundles contained ambiguous registered-operation revisions");
  }
  const docId = ids[0];
  if (docId === undefined) {
    throw new Error("Meta Relay bundles omitted the exact reviewed operation module");
  }
  return Object.freeze({
    schemaVersion: 1,
    friendlyName,
    moduleName,
    docId,
    agreeingBundleCount: ids.length,
  });
}

export function resolveMetaRelayDocId(
  bundleTextsValue: unknown,
  friendlyNameValue: unknown,
): string {
  return resolveMetaRelayOperationRevision(bundleTextsValue, friendlyNameValue).docId;
}
import ts from "typescript";
