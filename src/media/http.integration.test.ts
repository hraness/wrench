import { afterEach, describe, expect, test } from "bun:test";
import { captureDirectHttp, type DirectHttpCaptureSink } from "./http-capture";
import { probeDirectHttp } from "./http-probe";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.stop(true)));
});

function mp4Bytes(length = 96): Uint8Array {
  const body = new Uint8Array(length);
  new DataView(body.buffer).setUint32(0, 16, false);
  body.set(new TextEncoder().encode("ftyp"), 4);
  for (let index = 16; index < body.byteLength; index += 1) body[index] = index % 251;
  return body;
}

function memorySink(): Readonly<{ sink: DirectHttpCaptureSink; bytes: () => Uint8Array }> {
  let chunks: Uint8Array[] = [];
  return {
    sink: {
      write: (chunk) => {
        chunks.push(chunk.slice());
        return Promise.resolve();
      },
      restart: () => {
        chunks = [];
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
      abort: () => {
        chunks = [];
        return Promise.resolve();
      },
    },
    bytes: () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    },
  };
}

describe("direct HTTP local transport", () => {
  test("follows redirects, probes a range, and streams the full body with owned headers", async () => {
    const body = mp4Bytes();
    const observed: Array<Readonly<{
      method: string;
      path: string;
      range: string | null;
      acceptEncoding: string | null;
      cookie: string | null;
      authorization: string | null;
      referer: string | null;
    }>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        observed.push({
          method: request.method,
          path: url.pathname,
          range: request.headers.get("range"),
          acceptEncoding: request.headers.get("accept-encoding"),
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
          referer: request.headers.get("referer"),
        });
        if (url.pathname === "/start") {
          return new Response(null, {
            status: 302,
            headers: { Location: "/media?signature=redirect-secret" },
          });
        }
        if (url.pathname !== "/media") return new Response("missing", { status: 404 });
        const headers = {
          "Content-Type": "video/mp4",
          "Content-Length": String(body.byteLength),
          ETag: "\"local-strong-validator\"",
        };
        if (request.method === "HEAD") return new Response(null, { status: 200, headers });
        if (request.headers.get("range") === "bytes=0-65535") {
          return new Response(body, {
            status: 206,
            headers: {
              ...headers,
              "Content-Range": `bytes 0-${String(body.byteLength - 1)}/${String(body.byteLength)}`,
            },
          });
        }
        return new Response(body, { status: 200, headers });
      },
    });
    servers.push(server);
    const input = `http://127.0.0.1:${String(server.port)}/start?token=request-secret#local-fragment`;
    const probed = await probeDirectHttp(input);
    expect(probed).toMatchObject({
      ok: true,
      probe: { media: { container: "iso-bmff" }, redirectCount: 1 },
    });
    if (!probed.ok) throw new Error("local direct probe failed");
    const destination = memorySink();
    const captured = await captureDirectHttp(probed.probe, destination.sink);
    expect(captured).toMatchObject({ ok: true, capture: { bytes: body.byteLength } });
    expect(destination.bytes()).toEqual(body);
    expect(observed.map(({ method, path, range }) => [method, path, range])).toEqual([
      ["HEAD", "/start", null],
      ["HEAD", "/media", null],
      ["GET", "/start", "bytes=0-65535"],
      ["GET", "/media", "bytes=0-65535"],
      ["GET", "/start", null],
      ["GET", "/media", null],
    ]);
    for (const request of observed) {
      expect(request.acceptEncoding).toBe("identity");
      expect(request.cookie).toBeNull();
      expect(request.authorization).toBeNull();
      expect(request.referer).toBeNull();
    }
    expect(JSON.stringify(captured)).not.toContain("request-secret");
    expect(JSON.stringify(captured)).not.toContain("redirect-secret");
    expect(JSON.stringify(captured)).not.toContain("local-strong-validator");
  });

  test("classifies an ordinary HTML response as yt-dlp fallback", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return request.method === "HEAD"
          ? new Response(null, { status: 200, headers: { "Content-Type": "text/html" } })
          : new Response("<!doctype html><title>page</title>", {
              status: 200,
              headers: { "Content-Type": "text/html" },
            });
      },
    });
    servers.push(server);
    const result = await probeDirectHttp(`http://127.0.0.1:${String(server.port)}/page`);
    expect(result).toEqual({ ok: false, kind: "not-applicable", reason: "declared-text" });
  });
});
