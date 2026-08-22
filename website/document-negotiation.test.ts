import { describe, expect, test } from "bun:test";

import { handleDocumentNegotiation, markdownAssetPath } from "./document-negotiation";

function request(path: string, accept?: string, method = "GET"): Request {
  return new Request(`https://wrench.rip${path}`, accept === undefined
    ? { method }
    : { headers: { Accept: accept }, method });
}

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
