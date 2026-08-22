export const HTML_MEDIA_TYPE = "text/html" as const;
export const MARKDOWN_MEDIA_TYPE = "text/markdown" as const;
const MARKDOWN_CONTENT_TYPE = `${MARKDOWN_MEDIA_TYPE}; charset=utf-8` as const;
const PLAIN_CONTENT_TYPE = "text/plain; charset=utf-8" as const;
const STATIC_ASSET = /\.[a-z0-9]+$/iu;

export type DocumentRepresentation = "html" | "markdown";

export type DocumentNegotiation =
  | { readonly kind: "html" }
  | { readonly kind: "markdown" }
  | { readonly kind: "not-acceptable"; readonly accept: string };

export type DocumentRetrieve = (url: URL) => Promise<Response>;

type MediaRange = Readonly<{
  index: number;
  q: number;
  specificity: number;
  subtype: string;
  type: string;
}>;

const DOCUMENT_REPRESENTATIONS = [
  { preference: 0, representation: "html", subtype: "html", type: "text" },
  { preference: 1, representation: "markdown", subtype: "markdown", type: "text" },
] as const;

function parseQuality(value: string | undefined): number | null {
  if (value === undefined) return 1000;
  if (!/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u.test(value)) return null;
  return Math.round(Number.parseFloat(value) * 1000);
}

function parseMediaRange(value: string, index: number): MediaRange | null {
  const parts = value.split(";").map((part) => part.trim()).filter((part) => part !== "");
  const media = parts[0]?.toLowerCase();
  if (media === undefined || media === "") return null;
  const [type, subtype, ...rest] = media.split("/");
  if (type === undefined || subtype === undefined || rest.length > 0) return null;
  if (type !== "*" && !/^[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(type)) return null;
  if (subtype !== "*" && !/^[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(subtype)) return null;
  if (type === "*" && subtype !== "*") return null;

  let q = 1000;
  for (const parameter of parts.slice(1)) {
    const separator = parameter.indexOf("=");
    if (separator <= 0) continue;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== "q") continue;
    const parsed = parseQuality(parameter.slice(separator + 1).trim());
    if (parsed === null) return null;
    q = parsed;
  }
  return {
    index,
    q,
    specificity: type === "*" ? 1 : subtype === "*" ? 2 : 3,
    subtype,
    type,
  };
}

export function parseAcceptMediaRanges(header: string | null): readonly MediaRange[] {
  if (header === null) return [];
  const ranges: MediaRange[] = [];
  for (const [index, value] of header.split(",").entries()) {
    const range = parseMediaRange(value, index);
    if (range !== null) ranges.push(range);
  }
  return ranges;
}

function rangeMatches(range: MediaRange, type: string, subtype: string): boolean {
  return (range.type === "*" || range.type === type)
    && (range.subtype === "*" || range.subtype === subtype);
}

function bestRangeFor(
  ranges: readonly MediaRange[],
  type: string,
  subtype: string,
): MediaRange | null {
  let best: MediaRange | null = null;
  for (const range of ranges) {
    if (!rangeMatches(range, type, subtype)) continue;
    if (best === null) {
      best = range;
      continue;
    }
    if (range.specificity !== best.specificity) {
      if (range.specificity > best.specificity) best = range;
      continue;
    }
    if (range.q !== best.q) {
      if (range.q > best.q) best = range;
      continue;
    }
    if (range.index < best.index) best = range;
  }
  return best;
}

export function negotiateDocumentRepresentation(
  acceptHeader: string | null,
): DocumentNegotiation {
  const ranges = parseAcceptMediaRanges(acceptHeader);
  if (ranges.length === 0) return { kind: "html" };

  let selected: {
    preference: number;
    q: number;
    rangeIndex: number;
    representation: DocumentRepresentation;
    specificity: number;
  } | null = null;

  for (const candidate of DOCUMENT_REPRESENTATIONS) {
    const range = bestRangeFor(ranges, candidate.type, candidate.subtype);
    if (range === null || range.q === 0) continue;
    const next = {
      preference: candidate.preference,
      q: range.q,
      rangeIndex: range.index,
      representation: candidate.representation,
      specificity: range.specificity,
    };
    if (selected === null) {
      selected = next;
      continue;
    }
    if (next.q !== selected.q) {
      if (next.q > selected.q) selected = next;
      continue;
    }
    if (next.specificity !== selected.specificity) {
      if (next.specificity > selected.specificity) selected = next;
      continue;
    }
    if (next.rangeIndex !== selected.rangeIndex) {
      if (next.rangeIndex < selected.rangeIndex) selected = next;
      continue;
    }
    if (next.preference < selected.preference) selected = next;
  }

  if (selected === null) {
    return { kind: "not-acceptable", accept: acceptHeader ?? "" };
  }
  return { kind: selected.representation };
}

export function notAcceptableBody(accept: string): string {
  return [
    "This resource is available in:",
    `- ${HTML_MEDIA_TYPE}`,
    `- ${MARKDOWN_MEDIA_TYPE}`,
    "",
    `You requested: ${accept}`,
    "",
  ].join("\n");
}

export function isNegotiableDocumentPath(pathname: string): boolean {
  return pathname === "/" || !pathname.includes(".") && !pathname.includes("\\") && !pathname.includes("\0");
}

export function markdownAssetPath(pathname: string): string | null {
  if (!isNegotiableDocumentPath(pathname) || pathname.includes("..")) return null;
  if (pathname === "/") return "/index.md";
  const trimmed = pathname.replace(/\/+$/u, "");
  if (trimmed === "" || !trimmed.startsWith("/") || trimmed.includes("//")) return null;
  return `${trimmed}.md`;
}

function markdownHeaders(): Headers {
  return new Headers({
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Content-Type": MARKDOWN_CONTENT_TYPE,
    Vary: "Accept",
  });
}

function notAcceptableHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": PLAIN_CONTENT_TYPE,
    Vary: "Accept",
  });
}

async function readBody(response: Response, method: string): Promise<string | null> {
  if (method === "HEAD") return null;
  return await response.text();
}

export async function handleDocumentNegotiation(
  request: Request,
  retrieve: DocumentRetrieve,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/assets/") || STATIC_ASSET.test(url.pathname)) return null;

  const decision = negotiateDocumentRepresentation(request.headers.get("accept"));
  if (decision.kind === "html") return null;
  if (decision.kind === "not-acceptable") {
    return new Response(request.method === "HEAD" ? null : notAcceptableBody(decision.accept), {
      headers: notAcceptableHeaders(),
      status: 406,
    });
  }

  const assetPath = markdownAssetPath(url.pathname);
  if (assetPath !== null) {
    const asset = await retrieve(new URL(assetPath, url.origin));
    if (asset.ok) {
      return new Response(await readBody(asset, request.method), {
        headers: markdownHeaders(),
        status: 200,
      });
    }
  }

  const missing = await retrieve(new URL("/404.md", url.origin));
  if (!missing.ok) {
    throw new Error("The markdown 404 document is missing.");
  }
  return new Response(await readBody(missing, request.method), {
    headers: markdownHeaders(),
    status: 404,
  });
}

export const DOCUMENT_MEDIA_TYPES = [HTML_MEDIA_TYPE, MARKDOWN_MEDIA_TYPE] as const;
