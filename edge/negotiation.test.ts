import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  handleDocumentNegotiation,
  markdownAssetPath,
  negotiateDocumentRepresentation,
  notAcceptableBody,
  parseAcceptMediaRanges,
} from "./negotiation";

function request(path: string, accept?: string, method = "GET"): Request {
  return new Request(`https://wrench.rip${path}`, accept === undefined
    ? { method }
    : { headers: { Accept: accept }, method });
}

describe("document Accept negotiation", () => {
  test("serves HTML when Accept is absent, empty, or unrestricted", () => {
    expect(negotiateDocumentRepresentation(null)).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("")).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("*/*")).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("text/*")).toEqual({ kind: "html" });
  });

  test("honors q-values, specificity, client order, and q=0", () => {
    expect(negotiateDocumentRepresentation("text/markdown")).toEqual({ kind: "markdown" });
    expect(negotiateDocumentRepresentation("text/html")).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("text/markdown, text/html")).toEqual({
      kind: "markdown",
    });
    expect(negotiateDocumentRepresentation("text/html, text/markdown")).toEqual({ kind: "html" });
    expect(negotiateDocumentRepresentation("text/markdown;q=0.8, text/html;q=0.9")).toEqual({
      kind: "html",
    });
    expect(negotiateDocumentRepresentation("text/html;q=0.1, text/markdown;q=1")).toEqual({
      kind: "markdown",
    });
    expect(negotiateDocumentRepresentation("text/html;q=0, text/markdown")).toEqual({
      kind: "markdown",
    });
    expect(negotiateDocumentRepresentation("text/html;q=0, */*")).toEqual({ kind: "markdown" });
    expect(negotiateDocumentRepresentation("text/markdown;charset=utf-8")).toEqual({
      kind: "markdown",
    });
  });

  test("returns 406 only when every owned representation is rejected", () => {
    expect(negotiateDocumentRepresentation("application/pdf")).toEqual({
      accept: "application/pdf",
      kind: "not-acceptable",
    });
    expect(negotiateDocumentRepresentation("text/markdown;q=0, text/html;q=0")).toEqual({
      accept: "text/markdown;q=0, text/html;q=0",
      kind: "not-acceptable",
    });
    expect(notAcceptableBody("application/pdf")).toContain("- text/html");
    expect(notAcceptableBody("application/pdf")).toContain("- text/markdown");
    expect(notAcceptableBody("application/pdf")).toContain("You requested: application/pdf");
  });

  test("property: arbitrary Accept values stay inside the documented decision set", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (header) => {
        const decision = negotiateDocumentRepresentation(header);
        expect(["html", "markdown", "not-acceptable"]).toContain(decision.kind);
        if (decision.kind === "not-acceptable") {
          expect(decision.accept).toBe(header ?? "");
          expect(parseAcceptMediaRanges(header).some((range) => range.q > 0 && (
            (range.type === "*" && range.subtype === "*")
            || (range.type === "text" && (range.subtype === "*" || range.subtype === "html" || range.subtype === "markdown"))
          ))).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("document negotiation runtime", () => {
  test("maps canonical document paths to sibling markdown assets", () => {
    expect(markdownAssetPath("/")).toBe("/index.md");
    expect(markdownAssetPath("/getting-started/")).toBe("/getting-started.md");
    expect(markdownAssetPath("/getting-started")).toBe("/getting-started.md");
    expect(markdownAssetPath("/about/")).toBe("/about.md");
    expect(markdownAssetPath("/llms.txt")).toBeNull();
    expect(markdownAssetPath("/../secret")).toBeNull();
  });

  test("leaves HTML and static assets to the static origin", async () => {
    const retrieve = async (): Promise<Response> => {
      throw new Error("static HTML and assets must not be fetched by the negotiator");
    };
    expect(await handleDocumentNegotiation(request("/getting-started/", "text/html"), retrieve))
      .toBeNull();
    expect(await handleDocumentNegotiation(request("/llms.txt", "text/markdown"), retrieve))
      .toBeNull();
    expect(await handleDocumentNegotiation(request("/assets/styles.css", "text/markdown"), retrieve))
      .toBeNull();
    expect(await handleDocumentNegotiation(request("/getting-started.md", "text/markdown"), retrieve))
      .toBeNull();
  });

  test("serves markdown, 406, and markdown 404 bodies from sibling assets", async () => {
    const files = new Map([
      ["/index.md", "# Wrench\n"],
      ["/404.md", "# Missing\n"],
    ]);
    const retrieve = async (url: URL): Promise<Response> => {
      const body = files.get(url.pathname);
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { status: 200 });
    };

    const markdown = await handleDocumentNegotiation(request("/", "text/markdown"), retrieve);
    expect(markdown?.status).toBe(200);
    expect(markdown?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(markdown?.headers.get("vary")).toBe("Accept");
    expect(await markdown?.text()).toBe("# Wrench\n");

    const missing = await handleDocumentNegotiation(
      request("/no-such-page/", "text/markdown"),
      retrieve,
    );
    expect(missing?.status).toBe(404);
    expect(missing?.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(missing?.headers.get("vary")).toBe("Accept");
    expect(await missing?.text()).toBe("# Missing\n");

    const rejected = await handleDocumentNegotiation(request("/", "application/pdf"), retrieve);
    expect(rejected?.status).toBe(406);
    expect(rejected?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(rejected?.headers.get("vary")).toBe("Accept");
    expect(rejected?.headers.get("cache-control")).toBe("no-store");
    expect(await rejected?.text()).toContain("You requested: application/pdf");

    const head = await handleDocumentNegotiation(request("/", "text/markdown", "HEAD"), retrieve);
    expect(head?.status).toBe(200);
    expect(await head?.text()).toBe("");
  });
});
