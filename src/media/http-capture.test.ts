import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { captureDirectHttp, type DirectHttpCaptureSink } from "./http-capture";
import {
  DirectHttpProbeTransport,
  type DirectHttpFetchedResponse,
  type DirectHttpFetchOptions,
  type DirectHttpOwnedRequest,
  type DirectHttpProbe,
} from "./http-probe";

function mp4Bytes(length = 64): Uint8Array {
  const body = new Uint8Array(length);
  new DataView(body.buffer).setUint32(0, 16, false);
  body.set(new TextEncoder().encode("ftyp"), 4);
  for (let index = 16; index < body.byteLength; index += 1) body[index] = index % 251;
  return body;
}

const probeRequestUrl = "https://example.com/private/file.mp4?token=secret";
const captureEffectiveUrl = "https://cdn.example/file.mp4?signature=capture";
const probe: DirectHttpProbe = {
  transport: new DirectHttpProbeTransport(probeRequestUrl),
  publicOrigin: "https://example.com/",
  requestedUrlSha256: createHash("sha256").update(probeRequestUrl).digest("hex"),
  effectiveUrlSha256: createHash("sha256").update("https://cdn.example/file.mp4?signature=probe").digest("hex"),
  redirectCount: 1,
  declaredMediaType: "video/mp4",
  lastModified: null,
  validator: { strength: "strong", sha256: "a".repeat(64) },
  media: { container: "iso-bmff", extension: "mp4", mediaType: "video/mp4" },
  expectedBytes: 64,
};

function fetched(
  response: Response,
  effectiveUrl = captureEffectiveUrl,
  requestedUrl = probeRequestUrl,
  redirectCount = requestedUrl === effectiveUrl ? 0 : 1,
  dispose: () => void = () => {},
): DirectHttpFetchedResponse {
  return {
    response,
    requestedUrl: new URL(requestedUrl),
    effectiveUrl: new URL(effectiveUrl),
    redirectCount,
    dispose,
  };
}

function streamed(chunks: readonly Uint8Array[], failAfter = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) {
        controller.enqueue(chunk);
        return;
      }
      if (failAfter) controller.error(new Error("fixture interruption"));
      else controller.close();
    },
  });
}

function memorySink(): Readonly<{
  sink: DirectHttpCaptureSink;
  bytes: () => Uint8Array;
  restarts: () => number;
  closed: () => boolean;
  aborted: () => boolean;
}> {
  let chunks: Uint8Array[] = [];
  let restartCount = 0;
  let didClose = false;
  let didAbort = false;
  return {
    sink: {
      write: (chunk) => {
        chunks.push(chunk.slice());
        return Promise.resolve();
      },
      restart: () => {
        restartCount += 1;
        chunks = [];
        return Promise.resolve();
      },
      close: () => {
        didClose = true;
        return Promise.resolve();
      },
      abort: () => {
        didAbort = true;
        chunks = [];
        return Promise.resolve();
      },
    },
    bytes: () => {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    },
    restarts: () => restartCount,
    closed: () => didClose,
    aborted: () => didAbort,
  };
}

describe("captureDirectHttp", () => {
  test("streams chunks into one content-qualified success", async () => {
    const body = mp4Bytes();
    const destination = memorySink();
    const result = await captureDirectHttp(probe, destination.sink, {}, {
      request: () => Promise.resolve(fetched(new Response(streamed([
        body.subarray(0, 7),
        body.subarray(7, 31),
        body.subarray(31),
      ]), {
        status: 200,
        headers: {
          "Content-Length": String(body.byteLength),
          "Content-Type": "video/mp4; charset=binary",
          ETag: "\"capture-secret\"",
        },
      }))),
    });
    expect(result).toMatchObject({
      ok: true,
      capture: {
        bytes: body.byteLength,
        media: { container: "iso-bmff" },
        attempts: 1,
        resumed: false,
        provenance: {
          requestedUrlSha256: probe.requestedUrlSha256,
          redirectCount: 1,
          validator: { strength: "strong" },
          body: { bytes: body.byteLength },
        },
      },
    });
    if (!result.ok) throw new Error("fixture did not capture");
    expect(destination.bytes()).toEqual(body);
    expect(result.capture.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(JSON.stringify(result)).not.toContain("capture-secret");
    expect(JSON.stringify(result)).not.toContain("signature=capture");
    expect(destination.closed()).toBeTrue();
    expect(destination.aborted()).toBeFalse();
  });

  test("resumes only an exact strong-validator continuation", async () => {
    const body = mp4Bytes(96);
    const split = 37;
    const requests: Array<Readonly<{
      url: string;
      request: DirectHttpOwnedRequest;
      options: DirectHttpFetchOptions;
    }>> = [];
    const responses = [
      fetched(new Response(streamed([body.subarray(0, split)], true), {
        status: 200,
        headers: { "Content-Length": String(body.byteLength), ETag: "\"same\"" },
      })),
      fetched(new Response(body.subarray(split), {
        status: 206,
        headers: {
          "Content-Length": String(body.byteLength - split),
          "Content-Range": `bytes ${String(split)}-${String(body.byteLength - 1)}/${String(body.byteLength)}`,
          ETag: "\"same\"",
        },
      }), captureEffectiveUrl, captureEffectiveUrl, 0),
    ];
    const destination = memorySink();
    const result = await captureDirectHttp(probe, destination.sink, {}, {
      request: (url, request, options) => {
        requests.push({ url, request, options });
        const response = responses.shift();
        return response === undefined ? Promise.reject(new Error("extra request")) : Promise.resolve(response);
      },
    });
    expect(result).toMatchObject({ ok: true, capture: { attempts: 2, resumed: true } });
    expect(requests.map(({ url, request }) => ({ url, request }))).toEqual([
      { url: probeRequestUrl, request: { method: "GET" } },
      {
        url: captureEffectiveUrl,
        request: { method: "GET", range: `bytes=${String(split)}-`, ifRange: "\"same\"" },
      },
    ]);
    expect(requests[1]?.options.maxRedirects).toBe(0);
    expect(destination.bytes()).toEqual(body);
    expect(destination.restarts()).toBe(0);
  });

  test("restarts from zero for a weak validator or rejected strong continuation", async () => {
    const body = mp4Bytes(80);
    for (const scenario of ["weak", "changed"] as const) {
      const destination = memorySink();
      const firstEtag = scenario === "weak" ? "W/\"weak\"" : "\"first\"";
      const responses: DirectHttpFetchedResponse[] = [
        fetched(new Response(streamed([body.subarray(0, 20)], true), {
          status: 200,
          headers: { "Content-Length": String(body.byteLength), ETag: firstEtag },
        })),
        ...(scenario === "changed" ? [
          fetched(new Response(body.subarray(20), {
            status: 206,
            headers: {
              "Content-Length": String(body.byteLength - 20),
              "Content-Range": `bytes 20-${String(body.byteLength - 1)}/${String(body.byteLength)}`,
              ETag: "\"changed\"",
            },
          }), captureEffectiveUrl, captureEffectiveUrl, 0),
        ] : []),
        fetched(new Response(body, {
          status: 200,
          headers: { "Content-Length": String(body.byteLength), ETag: "\"fresh\"" },
        })),
      ];
      const result = await captureDirectHttp(probe, destination.sink, {}, {
        request: () => {
          const response = responses.shift();
          return response === undefined ? Promise.reject(new Error("extra request")) : Promise.resolve(response);
        },
      });
      expect(result).toMatchObject({ ok: true, capture: { attempts: scenario === "weak" ? 2 : 3, resumed: false } });
      expect(destination.restarts()).toBe(1);
      expect(destination.bytes()).toEqual(body);
    }
  });

  test("never follows a failed resume and restarts from the original request without validators", async () => {
    const body = mp4Bytes(80);
    const requests: Array<Readonly<{
      url: string;
      request: DirectHttpOwnedRequest;
      options: DirectHttpFetchOptions;
    }>> = [];
    let attempt = 0;
    const destination = memorySink();
    const result = await captureDirectHttp(probe, destination.sink, {}, {
      request: (url, request, options) => {
        requests.push({ url, request, options });
        attempt += 1;
        if (attempt === 1) {
          return Promise.resolve(fetched(new Response(streamed([body.subarray(0, 20)], true), {
            status: 200,
            headers: { "Content-Length": String(body.byteLength), ETag: "\"private-resume\"" },
          })));
        }
        if (attempt === 2) return Promise.reject(new Error("resume redirect rejected"));
        return Promise.resolve(fetched(new Response(body, {
          status: 200,
          headers: { "Content-Length": String(body.byteLength), ETag: "\"fresh\"" },
        })));
      },
    });
    expect(result).toMatchObject({ ok: true, capture: { attempts: 3, resumed: false } });
    expect(requests.map(({ url, request }) => ({ url, request }))).toEqual([
      { url: probeRequestUrl, request: { method: "GET" } },
      {
        url: captureEffectiveUrl,
        request: { method: "GET", range: "bytes=20-", ifRange: "\"private-resume\"" },
      },
      { url: probeRequestUrl, request: { method: "GET" } },
    ]);
    expect(requests[1]?.options.maxRedirects).toBe(0);
    expect(destination.restarts()).toBe(1);
    expect(destination.bytes()).toEqual(body);
  });

  test("disposes every owned response on success and terminal failure", async () => {
    const body = mp4Bytes();
    for (const response of [
      new Response(body, { status: 200, headers: { "Content-Length": String(body.byteLength) } }),
      new Response(body, { status: 200, headers: { "Content-Length": "1" } }),
    ]) {
      let disposals = 0;
      const result = await captureDirectHttp(probe, memorySink().sink, { maximumAttempts: 1 }, {
        request: () => Promise.resolve(fetched(
          response,
          captureEffectiveUrl,
          probeRequestUrl,
          1,
          () => { disposals += 1; },
        )),
      });
      expect(result.ok).toBe(response.headers.get("content-length") !== "1");
      expect(disposals).toBe(1);
    }
  });

  test("rejects malformed media metadata and numeric options before network I/O", async () => {
    const invalidOptions = [
      { maxRedirects: -1 },
      { maxRedirects: 6 },
      { timeoutMs: 0 },
      { maximumBodyBytes: 0 },
      { maximumAttempts: 0 },
      { inactivityTimeoutMs: 0 },
      { totalTimeoutMs: 0 },
      { totalTimeoutMs: Number.POSITIVE_INFINITY },
    ] as const;
    for (const options of invalidOptions) {
      const destination = memorySink();
      let calls = 0;
      const result = await captureDirectHttp(probe, destination.sink, options, {
        request: () => {
          calls += 1;
          return Promise.reject(new Error("must not run"));
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid-request" } });
      expect(destination.aborted()).toBeTrue();
      expect(calls).toBe(0);
    }

    const forgedProbe = {
      ...probe,
      media: { ...probe.media, extension: "../escape" },
    } as unknown as DirectHttpProbe;
    const destination = memorySink();
    const result = await captureDirectHttp(forgedProbe, destination.sink);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(destination.aborted()).toBeTrue();
  });

  test("bounds stalled sink writes by the total timeout", async () => {
    const body = mp4Bytes();
    let aborted = false;
    const sink: DirectHttpCaptureSink = {
      write: () => new Promise<void>(() => {}),
      restart: () => Promise.resolve(),
      close: () => Promise.resolve(),
      abort: () => {
        aborted = true;
        return Promise.resolve();
      },
    };
    const startedAt = Date.now();
    const result = await captureDirectHttp(probe, sink, {
      maximumAttempts: 1,
      totalTimeoutMs: 20,
    }, {
      request: () => Promise.resolve(fetched(new Response(body, {
        status: 200,
        headers: { "Content-Length": String(body.byteLength) },
      }))),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "total-timeout" } });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(aborted).toBeTrue();
  });

  test("parent cancellation interrupts stalled sink work immediately", async () => {
    const body = mp4Bytes();
    const parent = new AbortController();
    let enteredWrite: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
    const sink: DirectHttpCaptureSink = {
      write: () => {
        enteredWrite?.();
        return new Promise<void>(() => {});
      },
      restart: () => Promise.resolve(),
      close: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
    const capture = captureDirectHttp(probe, sink, {
      signal: parent.signal,
      totalTimeoutMs: 5_000,
    }, {
      request: () => Promise.resolve(fetched(new Response(body, {
        status: 200,
        headers: { "Content-Length": String(body.byteLength) },
      }))),
    });
    await entered;
    parent.abort();
    expect(await capture).toMatchObject({ ok: false, error: { code: "aborted" } });
  });

  test("recomputes request identity instead of serializing a forged probe digest", async () => {
    const destination = memorySink();
    const forged: DirectHttpProbe = {
      ...probe,
      requestedUrlSha256: "https://secret.example/path?token=LEAK",
    };
    const result = await captureDirectHttp(forged, destination.sink);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(JSON.stringify(result)).not.toContain("secret.example");
    expect(destination.aborted()).toBeTrue();
  });

  test("aborts on length, media, and declared-text failures", async () => {
    const body = mp4Bytes();
    const fixtures: readonly [Response, string][] = [
      [new Response(body, { status: 200, headers: { "Content-Length": "1" } }), "invalid-response-length"],
      [new Response(new TextEncoder().encode("not-media"), { status: 200 }), "media-unrecognized"],
      [new Response(body, { status: 200, headers: { "Content-Type": "text/html" } }), "declared-text"],
      [new Response(body, { status: 200, headers: { "Content-Type": "video/mp4, text/html" } }), "invalid-content-type"],
      [new Response(body, { status: 200, headers: { "Content-Type": "video/mp4; charset=binary, text/html" } }), "invalid-content-type"],
    ];
    for (const [response, code] of fixtures) {
      const destination = memorySink();
      const result = await captureDirectHttp(probe, destination.sink, { maximumAttempts: 1 }, {
        request: () => Promise.resolve(fetched(response)),
      });
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(destination.aborted()).toBeTrue();
      expect(destination.closed()).toBeFalse();
    }
  });
});
