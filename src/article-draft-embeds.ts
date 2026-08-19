import type { ArticleDraftTextBlock } from "./article-draft-document";

export const MAX_X_STATUS_ARTICLE_EMBED_CHARACTERS = 25_000;

export type ArticleDraftEmbedTarget = "x-web" | "linkedin-web";

export type XStatusArticleEmbed = {
  readonly text: string;
  readonly url: string;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactEmbed(value: unknown): XStatusArticleEmbed {
  if (!isRecord(value)) {
    throw new Error("X status Article embed must contain exactly text,url");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || (keys as string[]).sort().join(",") !== "text,url"
  ) {
    throw new Error("X status Article embed must contain exactly text,url");
  }
  const textDescriptor = Object.getOwnPropertyDescriptor(value, "text");
  const urlDescriptor = Object.getOwnPropertyDescriptor(value, "url");
  if (
    textDescriptor === undefined
    || urlDescriptor === undefined
    || !("value" in textDescriptor)
    || !("value" in urlDescriptor)
    || !textDescriptor.enumerable
    || !urlDescriptor.enumerable
  ) throw new Error("X status Article embed must contain plain text,url values");
  const text = textDescriptor.value as unknown;
  const url = urlDescriptor.value as unknown;
  if (
    typeof text !== "string"
    || text.length < 1
    || text.length > MAX_X_STATUS_ARTICLE_EMBED_CHARACTERS
    || text.includes("\0")
    || text.trim().length < 1
  ) {
    throw new Error(
      `X status Article embed text must contain 1-${MAX_X_STATUS_ARTICLE_EMBED_CHARACTERS} characters`,
    );
  }
  if (
    typeof url !== "string"
    || url.length < 1
    || url.length > 8_192
    || /[\0\r\n]/u.test(url)
  ) {
    throw new Error("X status Article embed URL must be one bounded X status URL");
  }
  return Object.freeze({ text, url });
}

function canonicalXStatusUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("X status Article embed URL must be one bounded X status URL");
  }
  const hosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{1,32})\/?$/u.exec(url.pathname);
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || !hosts.has(url.hostname)
    || match === null
  ) throw new Error("X status Article embed URL must be one bounded X status URL");
  return `https://x.com/${match[1]}/status/${match[2]}`;
}

function textBlock(type: "blockquote" | "paragraph", text: string): ArticleDraftTextBlock {
  return Object.freeze({
    type,
    text,
    links: Object.freeze([]),
    styles: Object.freeze([]),
  });
}

/**
 * Project one source X status as quoted text followed by its canonical native
 * link. This is an editorial fallback, not a claim that the destination
 * provider created a proprietary embed card.
 */
export function projectXStatusArticleEmbed(
  value: unknown,
  target: unknown,
): readonly ArticleDraftTextBlock[] {
  const embed = exactEmbed(value);
  if (target !== "x-web" && target !== "linkedin-web") {
    throw new Error("X status Article embed target must be x-web or linkedin-web");
  }
  const canonicalUrl = canonicalXStatusUrl(embed.url);
  const quoteType = target === "x-web" ? "blockquote" : "paragraph";
  const quoteBlocks = embed.text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => textBlock(quoteType, line));
  return Object.freeze([
    ...quoteBlocks,
    Object.freeze({
      type: "paragraph" as const,
      text: canonicalUrl,
      links: Object.freeze([Object.freeze({
        offset: 0,
        length: canonicalUrl.length,
        url: canonicalUrl,
      })]),
      styles: Object.freeze([]),
    }),
  ]);
}
