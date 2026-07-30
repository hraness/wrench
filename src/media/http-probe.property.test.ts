import { expect, test } from "bun:test";
import fc from "fast-check";
import { fetchWithDirectRedirects, probeDirectHttp } from "./http-probe";

test("property: every redirect hop receives the same closed owned header set", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 5 }),
      async (redirects) => {
        const headersSeen: string[][] = [];
        let call = 0;
        const fetched = await fetchWithDirectRedirects(
          "https://example.com/start",
          { method: "GET", range: "bytes=0-9" },
          {},
          {
            fetch: (_url, init) => {
              headersSeen.push([...new Headers(init.headers).keys()].toSorted());
              const current = call;
              call += 1;
              return Promise.resolve(current < redirects
                ? new Response(null, { status: 302, headers: { Location: `/hop-${String(current)}` } })
                : new Response("ok", { status: 200 }));
            },
          },
        );
        expect(headersSeen).toHaveLength(redirects + 1);
        expect(new Set(headersSeen.map((headers) => JSON.stringify(headers))).size).toBe(1);
        for (const headers of headersSeen) {
          expect(headers).not.toContain("authorization");
          expect(headers).not.toContain("cookie");
          expect(headers).not.toContain("referer");
          expect(headers).not.toContain("if-range");
        }
        fetched.dispose();
      },
    ),
    { numRuns: 100 },
  );
});

test("property: chunk partitioning cannot hide bytes beyond the probe declaration", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 17 }), { minLength: 1, maxLength: 12 }),
      async (widths) => {
        const body = new Uint8Array(17);
        new DataView(body.buffer).setUint32(0, 16, false);
        body.set(new TextEncoder().encode("ftyp"), 4);
        const chunks: Uint8Array[] = [];
        let offset = 0;
        let index = 0;
        while (offset < body.byteLength) {
          const width = widths[index % widths.length] ?? 1;
          chunks.push(body.subarray(offset, Math.min(body.byteLength, offset + width)));
          offset += width;
          index += 1;
        }
        let calls = 0;
        const result = await probeDirectHttp("https://example.com/file", { probeBytes: 16 }, {
          fetch: () => {
            calls += 1;
            if (calls === 1) return Promise.resolve(new Response(null, { status: 405 }));
            return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = chunks.shift();
                if (chunk === undefined) controller.close();
                else controller.enqueue(chunk);
              },
            }), { status: 200, headers: { "Content-Length": "16" } }));
          },
        });
        expect(result).toMatchObject({
          ok: false,
          kind: "error",
          error: { code: "invalid-response-length" },
        });
      },
    ),
    { numRuns: 100 },
  );
});
