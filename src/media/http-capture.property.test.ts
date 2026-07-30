import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import fc from "fast-check";
import { captureDirectHttp, type DirectHttpCaptureSink } from "./http-capture";
import { DirectHttpProbeTransport, type DirectHttpProbe } from "./http-probe";

function mediaBody(tail: Uint8Array): Uint8Array {
  const output = new Uint8Array(16 + tail.byteLength);
  new DataView(output.buffer).setUint32(0, 16, false);
  output.set(new TextEncoder().encode("ftyp"), 4);
  output.set(tail, 16);
  return output;
}

const probe: DirectHttpProbe = {
  transport: new DirectHttpProbeTransport("https://example.com/file"),
  publicOrigin: "https://example.com/",
  requestedUrlSha256: createHash("sha256").update("https://example.com/file").digest("hex"),
  effectiveUrlSha256: createHash("sha256").update("https://example.com/file").digest("hex"),
  redirectCount: 0,
  declaredMediaType: null,
  lastModified: null,
  validator: { strength: "absent" },
  media: { container: "iso-bmff", extension: "mp4", mediaType: "video/mp4" },
  expectedBytes: null,
};

test("property: stream chunk partitioning cannot change capture bytes or digest", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 2_048 }),
      fc.array(fc.integer({ min: 1, max: 128 }), { minLength: 1, maxLength: 32 }),
      async (tail, widths) => {
        const body = mediaBody(tail);
        const chunks: Uint8Array[] = [];
        let offset = 0;
        let widthIndex = 0;
        while (offset < body.byteLength) {
          const width = widths[widthIndex % widths.length] ?? 1;
          chunks.push(body.subarray(offset, Math.min(body.byteLength, offset + width)));
          offset += width;
          widthIndex += 1;
        }
        const written: Uint8Array[] = [];
        const sink: DirectHttpCaptureSink = {
          write: (chunk) => {
            written.push(chunk.slice());
            return Promise.resolve();
          },
          restart: () => Promise.reject(new Error("unexpected restart")),
          close: () => Promise.resolve(),
          abort: () => Promise.resolve(),
        };
        const response = new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk === undefined) controller.close();
            else controller.enqueue(chunk);
          },
        }), { status: 200, headers: { "Content-Length": String(body.byteLength) } });
        const result = await captureDirectHttp(probe, sink, { maximumAttempts: 1 }, {
          request: () => Promise.resolve({
            response,
            requestedUrl: new URL(probe.transport.requestUrl()),
            effectiveUrl: new URL(probe.transport.requestUrl()),
            redirectCount: 0,
            dispose: () => {},
          }),
        });
        expect(result.ok).toBeTrue();
        if (!result.ok) return;
        expect(result.capture.bytes).toBe(body.byteLength);
        expect(result.capture.sha256).toBe(createHash("sha256").update(body).digest("hex"));
        expect(written.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(body.byteLength);
      },
    ),
    { numRuns: 100 },
  );
});
