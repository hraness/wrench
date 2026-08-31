import { describe, expect, test } from "bun:test";

import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY,
  INDEXNOW_KEY_LOCATION,
  parseWrenchSitemap,
  readBoundedText,
  SITE_ORIGIN,
  SITEMAP_URL,
  submitCurrentWrenchSitemap,
} from "./indexnow-submit.mjs";

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://wrench.rip/</loc>
  </url>
  <url>
    <loc>https://wrench.rip/getting-started/</loc>
    <image:image>
      <image:loc>https://wrench.rip/images/example.webp</image:loc>
      <image:title>Bounded &amp; exact</image:title>
      <image:caption>A canonical fixture.</image:caption>
    </image:image>
  </url>
</urlset>
`;

describe("IndexNow release notification", () => {
  test("parses only bounded canonical Wrench sitemap locations", () => {
    expect(parseWrenchSitemap(sitemap)).toEqual([
      "https://wrench.rip/",
      "https://wrench.rip/getting-started/",
    ]);
    for (const changed of [
      sitemap.replace("https://wrench.rip/</loc>", "https://example.com/</loc>"),
      sitemap.replace("getting-started/", "getting-started/?utm_source=x"),
      sitemap.replace("getting-started/", "getting-started"),
      sitemap.replace("    <loc>https://wrench.rip/</loc>\n", ""),
      sitemap.replace("  <url>\n    <loc>https://wrench.rip/</loc>\n  </url>\n", "    <loc>https://wrench.rip/</loc>\n"),
      sitemap.replace("xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"", "xmlns=\"https://example.com/wrong\""),
      sitemap.replace("<urlset", "<!DOCTYPE x><urlset"),
      sitemap.replace("</urlset>", "<extra/>\n</urlset>"),
    ]) expect(() => parseWrenchSitemap(changed)).toThrow();
  });

  test("streams text under an exact byte bound", async () => {
    await expect(readBoundedText(
      new Response("exact", { headers: { "content-length": "5" } }),
      5,
      "fixture",
    )).resolves.toBe("exact");
    await expect(readBoundedText(
      new Response("oversize"),
      4,
      "fixture",
    )).rejects.toThrow("exceeded 4 bytes");
  });

  test("validates the live sitemap and key before one exact notification", async () => {
    const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
    const fetchImplementation: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === SITEMAP_URL) {
        return new Response(sitemap, {
          headers: { "content-type": "application/xml; charset=utf-8" },
        });
      }
      if (url === INDEXNOW_KEY_LOCATION) {
        return new Response(`${INDEXNOW_KEY}\n`, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url === INDEXNOW_ENDPOINT) return new Response("", { status: 202 });
      throw new Error(`Unexpected request ${url}`);
    };

    const result = await submitCurrentWrenchSitemap(fetchImplementation);
    expect(result).toEqual({
      status: 202,
      urls: [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/getting-started/`],
    });
    expect(requests.map(({ url }) => url)).toEqual([
      SITEMAP_URL,
      INDEXNOW_KEY_LOCATION,
      INDEXNOW_ENDPOINT,
    ]);
    expect(requests[0]?.init).toMatchObject({ redirect: "error" });
    expect(requests[1]?.init).toMatchObject({ redirect: "error" });
    expect(requests[2]?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "user-agent": "hraness-wrench-indexnow/1.0",
      },
    });
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({
      host: "wrench.rip",
      key: INDEXNOW_KEY,
      keyLocation: INDEXNOW_KEY_LOCATION,
      urlList: [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/getting-started/`],
    });
  });

  test("fails closed before notification when public evidence drifts", async () => {
    for (const [sitemapResponse, keyResponse, expected] of [
      [new Response("missing", { status: 404 }), undefined, "sitemap returned HTTP 404"],
      [
        new Response(sitemap, { headers: { "content-type": "text/html" } }),
        undefined,
        "unsupported Content-Type",
      ],
      [
        new Response(sitemap, { headers: { "content-type": "application/xml" } }),
        new Response("wrong\n", { headers: { "content-type": "text/plain" } }),
        "does not match",
      ],
    ] as const) {
      let calls = 0;
      const fetchImplementation: typeof fetch = async () => {
        calls += 1;
        if (calls === 1) return sitemapResponse;
        if (calls === 2 && keyResponse !== undefined) return keyResponse;
        throw new Error("notification must not run");
      };
      await expect(submitCurrentWrenchSitemap(fetchImplementation)).rejects.toThrow(expected);
      expect(calls).toBe(keyResponse === undefined ? 1 : 2);
    }
  });

  test("accepts only documented successful IndexNow status codes", async () => {
    const fetchForStatus = (status: number): typeof fetch => {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(sitemap, { headers: { "content-type": "application/xml" } });
        }
        if (calls === 2) {
          return new Response(`${INDEXNOW_KEY}\n`, { headers: { "content-type": "text/plain" } });
        }
        return new Response("status", { status });
      };
    };
    await expect(submitCurrentWrenchSitemap(fetchForStatus(200))).resolves.toMatchObject({ status: 200 });
    await expect(submitCurrentWrenchSitemap(fetchForStatus(202))).resolves.toMatchObject({ status: 202 });
    await expect(submitCurrentWrenchSitemap(fetchForStatus(429))).rejects.toThrow(
      "IndexNow returned HTTP 429: status",
    );
  });

  test("does not retain or bound an unused successful response body", async () => {
    let calls = 0;
    const oversizedSuccess = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024));
      },
    });
    const fetchImplementation: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(sitemap, { headers: { "content-type": "application/xml" } });
      }
      if (calls === 2) {
        return new Response(`${INDEXNOW_KEY}\n`, { headers: { "content-type": "text/plain" } });
      }
      return new Response(oversizedSuccess, { status: 200 });
    };
    await expect(submitCurrentWrenchSitemap(fetchImplementation)).resolves.toMatchObject({
      status: 200,
    });
  });
});
