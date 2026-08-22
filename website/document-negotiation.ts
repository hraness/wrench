import {
  HTML_MEDIA_TYPE,
  MARKDOWN_MEDIA_TYPE,
  negotiateDocumentRepresentation,
  notAcceptableBody,
} from "./content-negotiation";

const MARKDOWN_CONTENT_TYPE = `${MARKDOWN_MEDIA_TYPE}; charset=utf-8` as const;
const PLAIN_CONTENT_TYPE = "text/plain; charset=utf-8" as const;
const STATIC_ASSET = /\.[a-z0-9]+$/iu;

export type DocumentRetrieve = (url: URL) => Promise<Response>;

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
