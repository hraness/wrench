import { canonicalJson } from "./canonical-json";

export const ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_ARTICLE_DRAFT_DOCUMENT_BYTES = 512 * 1024;
export const MAX_ARTICLE_DRAFT_BLOCKS = 5_000;
export const MAX_ARTICLE_DRAFT_CHARACTERS = 125_000;

export type ArticleDraftTextBlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "blockquote"
  | "unordered-list-item"
  | "ordered-list-item";

export type ArticleDraftLinkRange = {
  readonly offset: number;
  readonly length: number;
  readonly url: string;
};

export type ArticleDraftStyleRange = {
  readonly offset: number;
  readonly length: number;
  readonly style: "bold" | "italic" | "strikethrough";
};

const articleDraftStyleOrder = Object.freeze({
  bold: 0,
  italic: 1,
  strikethrough: 2,
} as const satisfies Readonly<Record<ArticleDraftStyleRange["style"], number>>);

export type ArticleDraftTextBlock = {
  readonly type: ArticleDraftTextBlockType;
  readonly text: string;
  readonly links: readonly ArticleDraftLinkRange[];
  readonly styles: readonly ArticleDraftStyleRange[];
};

export type ArticleDraftDocument = {
  readonly schemaVersion: typeof ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION;
  readonly blocks: readonly ArticleDraftTextBlock[];
};

export type ArticleDraftDocumentLimits = {
  readonly maximumBlocks: number;
  readonly maximumCharacters: number;
};

const textBlockTypes = new Set<ArticleDraftTextBlockType>([
  "paragraph",
  "heading1",
  "heading2",
  "blockquote",
  "unordered-list-item",
  "ordered-list-item",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) throw new Error(`${label} must contain exactly ${expected || "no fields"}`);
}

function boundedHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} must be a bounded absolute HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a bounded absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.href !== value
  ) throw new Error(`${label} must be one canonical absolute HTTPS URL`);
  return parsed.href;
}

function validUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function boundedRange(
  value: Readonly<Record<string, unknown>>,
  text: string,
  label: string,
): { readonly offset: number; readonly length: number } {
  const offset = value.offset;
  const length = value.length;
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || (offset as number) < 0
    || (length as number) < 1
    || (offset as number) + (length as number) > text.length
    || !validUtf16Boundary(text, offset as number)
    || !validUtf16Boundary(text, (offset as number) + (length as number))
  ) throw new Error(`${label} must stay on UTF-16 boundaries inside its text`);
  return Object.freeze({ offset: offset as number, length: length as number });
}

function checkedLimits(value: ArticleDraftDocumentLimits): ArticleDraftDocumentLimits {
  if (
    !Number.isSafeInteger(value.maximumBlocks)
    || value.maximumBlocks < 1
    || value.maximumBlocks > MAX_ARTICLE_DRAFT_BLOCKS
    || !Number.isSafeInteger(value.maximumCharacters)
    || value.maximumCharacters < 1
    || value.maximumCharacters > MAX_ARTICLE_DRAFT_CHARACTERS
  ) throw new Error("Article draft document limits are invalid");
  return value;
}

function compareStyleRanges(left: ArticleDraftStyleRange, right: ArticleDraftStyleRange): number {
  return left.offset - right.offset
    || left.length - right.length
    || articleDraftStyleOrder[left.style] - articleDraftStyleOrder[right.style];
}

/** Parse one canonical, provider-neutral rich-text article draft document. */
export function parseArticleDraftDocument(
  value: unknown,
  limitsValue: ArticleDraftDocumentLimits,
): ArticleDraftDocument {
  const limits = checkedLimits(limitsValue);
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > MAX_ARTICLE_DRAFT_DOCUMENT_BYTES
    || value.includes("\0")
  ) throw new Error("input.document must be bounded canonical ArticleDraftDocument JSON");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
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

  const blocks: ArticleDraftTextBlock[] = [];
  let totalCharacters = 0;
  for (const [index, rawBlock] of root.blocks.entries()) {
    const label = `input.document.blocks[${index}]`;
    const block = record(rawBlock, label);
    const allowed = [
      "type",
      "text",
      ...(block.links === undefined ? [] : ["links"]),
      ...(block.styles === undefined ? [] : ["styles"]),
    ];
    exactKeys(block, allowed, label);
    if (typeof block.type !== "string" || !textBlockTypes.has(block.type as ArticleDraftTextBlockType)) {
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
    if (
      !Array.isArray(rawLinks)
      || rawLinks.length > 500
      || !Array.isArray(rawStyles)
      || rawStyles.length > 500
    ) throw new Error(`${label} ranges exceeded their bounds`);

    const links = rawLinks.map((rawLink, rangeIndex) => {
      const rangeLabel = `${label}.links[${rangeIndex}]`;
      const link = record(rawLink, rangeLabel);
      exactKeys(link, ["offset", "length", "url"], rangeLabel);
      const range = boundedRange(link, block.text as string, rangeLabel);
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
      exactKeys(style, ["offset", "length", "style"], rangeLabel);
      const range = boundedRange(style, block.text as string, rangeLabel);
      if (style.style !== "bold" && style.style !== "italic" && style.style !== "strikethrough") {
        throw new Error(`${rangeLabel}.style is outside ArticleDraftDocument schemaVersion 1`);
      }
      return Object.freeze({ ...range, style: style.style });
    });
    for (let rangeIndex = 1; rangeIndex < styles.length; rangeIndex += 1) {
      const previous = styles[rangeIndex - 1] as ArticleDraftStyleRange;
      const current = styles[rangeIndex] as ArticleDraftStyleRange;
      if (compareStyleRanges(previous, current) > 0) {
        throw new Error(`${label}.styles must be ordered by offset, then length, then style`);
      }
    }
    const styleEnds: Partial<Record<ArticleDraftStyleRange["style"], number>> = {};
    for (const style of styles) {
      const previousEnd = styleEnds[style.style];
      if (previousEnd !== undefined && style.offset < previousEnd) {
        throw new Error(`${label}.styles must not contain duplicate or overlapping same-style ranges`);
      }
      styleEnds[style.style] = style.offset + style.length;
    }

    blocks.push(Object.freeze({
      type: block.type as ArticleDraftTextBlockType,
      text: block.text,
      links: Object.freeze(links),
      styles: Object.freeze(styles),
    }));
  }
  if (totalCharacters < 1) throw new Error("input.document must contain article text");
  return Object.freeze({
    schemaVersion: ARTICLE_DRAFT_DOCUMENT_SCHEMA_VERSION,
    blocks: Object.freeze(blocks),
  });
}

/** Project strict parser failures into a provider-plugin validation hook. */
export function articleDraftDocumentIssues(
  value: unknown,
  limits: ArticleDraftDocumentLimits,
): readonly string[] {
  try {
    parseArticleDraftDocument(value, limits);
    return Object.freeze([]);
  } catch (error) {
    return Object.freeze([
      error instanceof Error ? error.message : "input.document is invalid",
    ]);
  }
}
