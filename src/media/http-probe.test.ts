import { describe, expect, test } from "bun:test";
import {
  fetchWithDirectRedirects,
  probeDirectHttp,
  type DirectHttpFetchDependencies,
} from "./http-probe";

function mp4Bytes(length = 32): Uint8Array {
  const body = new Uint8Array(length);
  new DataView(body.buffer).setUint32(0, 16, false);
  body.set(new TextEncoder().encode("ftyp"), 4);
  return body;
}

function sequence(
  responses: readonly Response[],
  calls: Array<Readonly<{ url: string; init: RequestInit }>> = [],
): DirectHttpFetchDependencies {
  let index = 0;
  return {
    fetch: (url, init) => {
      calls.push({ url, init });
      const response = responses[index];
      index += 1;
      if (response === undefined) return Promise.reject(new Error("unexpected request"));
      return Promise.resolve(response);
    },
  };
}

async function expectTransportRejection(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected direct HTTP transport rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("fetchWithDirectRedirects", () => {
  test("manually follows safe redirects and rebuilds only owned headers", async () => {
    const calls: Array<Readonly<{ url: string; init: RequestInit }>> = [];
    const result = await fetchWithDirectRedirects(
      "https://example.com/private/file#local",
      { method: "GET", range: "bytes=0-9" },
      {},
      sequence([
        new Response(null, { status: 302, headers: { Location: "https://cdn.example/file" } }),
        new Response("ok", { status: 200 }),
      ], calls),
    );
    expect(result.requestedUrl.href).toBe("https://example.com/private/file");
    expect(result.effectiveUrl.href).toBe("https://cdn.example/file");
    expect(result.redirectCount).toBe(1);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://example.com/private/file",
      "https://cdn.example/file",
    ]);
    for (const { init } of calls) {
      const headers = new Headers(init.headers);
      expect(headers.get("accept-encoding")).toBe("identity");
      expect(headers.get("range")).toBe("bytes=0-9");
      expect(headers.get("if-range")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
    }
    result.dispose();
  });

  test("rejects downgrade, credential targets, missing targets, and redirect overflow", async () => {
    for (const location of ["http://example.com/file", "https://u:p@example.com/file"]) {
      await expectTransportRejection(fetchWithDirectRedirects(
        "https://example.com/file",
        { method: "GET" },
        {},
        sequence([new Response(null, { status: 302, headers: { Location: location } })]),
      ), "redirect-policy");
    }
    await expectTransportRejection(fetchWithDirectRedirects(
      "https://example.com/file",
      { method: "GET" },
      {},
      sequence([new Response(null, { status: 302 })]),
    ), "redirect-policy");
    await expectTransportRejection(fetchWithDirectRedirects(
      "https://example.com/file",
      { method: "GET" },
      { maxRedirects: 1 },
      sequence([
        new Response(null, { status: 302, headers: { Location: "/a" } }),
        new Response(null, { status: 302, headers: { Location: "/b" } }),
      ]),
    ), "too-many-redirects");
    await expectTransportRejection(fetchWithDirectRedirects(
      "https://example.com/file",
      { method: "GET", range: "bytes=9-1" },
      {},
      sequence([]),
    ), "invalid-request");
    const noRedirects = sequence([
      new Response(null, { status: 302, headers: { Location: "https://other.example/file" } }),
    ]);
    await expectTransportRejection(fetchWithDirectRedirects(
      "https://example.com/file",
      { method: "GET", range: "bytes=10-", ifRange: "\"private-validator\"" },
      { maxRedirects: 0 },
      noRedirects,
    ), "too-many-redirects");
    await expectTransportRejection(fetchWithDirectRedirects(
      "https://example.com/file",
      { method: "GET", ifRange: "unquoted" },
      {},
      sequence([]),
    ), "invalid-request");
    await expectTransportRejection(fetchWithDirectRedirects(
      "https://example.com/file",
      { method: "GET", range: "bytes=10-", ifRange: "\"private-validator\"" },
      {},
      sequence([]),
    ), "invalid-request");
  });

  test("keeps parent abort connected through body ownership and releases it on dispose", async () => {
    for (const disposeBeforeAbort of [false, true]) {
      const parent = new AbortController();
      let transportSignal: AbortSignal | undefined;
      const fetched = await fetchWithDirectRedirects(
        "https://example.com/file",
        { method: "GET" },
        { signal: parent.signal, timeoutMs: 1_000 },
        {
          fetch: (_url, init) => {
            transportSignal = init.signal ?? undefined;
            return Promise.resolve(new Response("body"));
          },
        },
      );
      if (disposeBeforeAbort) fetched.dispose();
      parent.abort();
      expect(transportSignal?.aborted).toBe(!disposeBeforeAbort);
      fetched.dispose();
      fetched.dispose();
    }
  });
});

describe("probeDirectHttp", () => {
  test("treats HEAD as advisory and recognizes a bounded ranged media response", async () => {
    const calls: Array<Readonly<{ url: string; init: RequestInit }>> = [];
    const body = mp4Bytes();
    const result = await probeDirectHttp(
      "https://example.com/signed/file.mp4?token=secret#fragment",
      {},
      sequence([
        new Response(null, { status: 405 }),
        new Response(body, {
          status: 206,
          headers: {
            "Content-Range": `bytes 0-${String(body.byteLength - 1)}/${String(body.byteLength)}`,
            "Content-Length": String(body.byteLength),
            "Content-Type": "video/mp4; charset=binary",
            ETag: "\"opaque-secret-validator\"",
            "Last-Modified": "Mon, 21 Jul 2025 12:34:56 GMT",
          },
        }),
      ], calls),
    );
    expect(result).toMatchObject({
      ok: true,
      probe: {
        publicOrigin: "https://example.com/",
        redirectCount: 0,
        declaredMediaType: "video/mp4",
        expectedBytes: body.byteLength,
        media: { container: "iso-bmff", extension: "mp4" },
        validator: { strength: "strong" },
      },
    });
    if (!result.ok) throw new Error("fixture did not probe");
    expect(result.probe.transport.requestUrl()).not.toContain("#");
    expect(result.probe.validator).not.toHaveProperty("raw");
    expect(Object.keys(result.probe.transport)).toEqual([]);
    expect({ ...result.probe }).not.toHaveProperty("requestedUrl");
    const serialized = JSON.stringify(result.probe);
    for (const secret of ["signed/file.mp4", "token=secret", "opaque-secret-validator"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(calls.map(({ init }) => init.method)).toEqual(["HEAD", "GET"]);
    expect(new Headers(calls[1]?.init.headers).get("range")).toBe("bytes=0-65535");
  });

  test("falls back for pages or unknown bytes and rejects declared text despite media magic", async () => {
    for (const [body, contentType, reason] of [
      [new TextEncoder().encode("<html>page</html>"), "text/html", "declared-text"],
      [new TextEncoder().encode("unknown"), "application/octet-stream", "unrecognized-media"],
      [mp4Bytes(), "application/json", "declared-text"],
    ] as const) {
      const result = await probeDirectHttp(
        "https://example.com/input",
        {},
        sequence([
          new Response(null, { status: 405 }),
          new Response(body, {
            status: 200,
            headers: { "Content-Type": contentType, "Content-Length": String(body.byteLength) },
          }),
        ]),
      );
      expect(result).toEqual({ ok: false, kind: "not-applicable", reason });
    }
  });

  test("fails closed on range disagreement, compression, and oversized declarations", async () => {
    const fixtures: readonly [Response, string][] = [
      [new Response(mp4Bytes(), { status: 206, headers: { "Content-Range": "bytes 1-32/33" } }), "invalid-response-length"],
      [new Response(mp4Bytes(), { status: 200, headers: { "Content-Encoding": "gzip" } }), "unsupported-content-encoding"],
      [new Response(mp4Bytes(), { status: 200, headers: { "Content-Length": String(65 * 1024 * 1024 * 1024) } }), "body-too-large"],
    ];
    for (const [response, code] of fixtures) {
      const result = await probeDirectHttp(
        "https://example.com/private/token",
        {},
        sequence([new Response(null, { status: 405 }), response]),
      );
      expect(result).toMatchObject({ ok: false, kind: "error", error: { code } });
      expect(JSON.stringify(result)).not.toContain("private/token");
    }
  });

  test("rejects invalid numeric options before any network request", async () => {
    const invalidOptions = [
      { maxRedirects: -1 },
      { maxRedirects: 6 },
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { headTimeoutMs: 0 },
      { probeBytes: 0 },
      { probeBytes: 65_537 },
      { maximumBodyBytes: 0 },
    ] as const;
    for (const options of invalidOptions) {
      let calls = 0;
      const result = await probeDirectHttp("https://example.com/file", options, {
        fetch: () => {
          calls += 1;
          return Promise.reject(new Error("must not run"));
        },
      });
      expect(result).toMatchObject({ ok: false, kind: "error", error: { code: "invalid-request" } });
      expect(calls).toBe(0);
    }
  });

  test("detects bytes beyond an exact bounded declaration across chunk shapes", async () => {
    const body = mp4Bytes(17);
    const streams = [
      new Response(body, { status: 200, headers: { "Content-Length": "16" } }),
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.subarray(0, 16));
          controller.enqueue(body.subarray(16));
          controller.close();
        },
      }), { status: 200, headers: { "Content-Length": "16" } }),
    ];
    for (const response of streams) {
      const result = await probeDirectHttp(
        "https://example.com/file",
        { probeBytes: 16 },
        sequence([new Response(null, { status: 405 }), response]),
      );
      expect(result).toMatchObject({
        ok: false,
        kind: "error",
        error: { code: "invalid-response-length" },
      });
    }
  });

  test("enforces the configured body maximum without relying on length headers", async () => {
    const body = mp4Bytes(32);
    const result = await probeDirectHttp(
      "https://example.com/file",
      { maximumBodyBytes: 16, probeBytes: 32 },
      sequence([
        new Response(null, { status: 405 }),
        new Response(body, { status: 200 }),
      ]),
    );
    expect(result).toMatchObject({ ok: false, kind: "error", error: { code: "body-too-large" } });
  });

  test("rejects an early EOF that disproves a larger declared body", async () => {
    const body = mp4Bytes(16);
    const result = await probeDirectHttp(
      "https://example.com/file",
      { probeBytes: 16 },
      sequence([
        new Response(null, { status: 405 }),
        new Response(body, { status: 200, headers: { "Content-Length": "100000" } }),
      ]),
    );
    expect(result).toMatchObject({
      ok: false,
      kind: "error",
      error: { code: "invalid-response-length" },
    });
  });

  test("rejects malformed explicit media types despite recognized bytes", async () => {
    for (const contentType of [
      "video/mp4, text/html",
      "video/mp4; charset=binary, text/html",
      "",
      `${"a".repeat(513)}/mp4`,
    ]) {
      const body = mp4Bytes();
      const result = await probeDirectHttp(
        "https://example.com/file",
        {},
        sequence([
          new Response(null, { status: 405 }),
          new Response(body, {
            status: 200,
            headers: { "Content-Length": String(body.byteLength), "Content-Type": contentType },
          }),
        ]),
      );
      expect(result).toMatchObject({
        ok: false,
        kind: "error",
        error: { code: "invalid-content-type" },
      });
    }
  });
});
