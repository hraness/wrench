import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support";

import {
  parsePortableProviderPluginManifest,
  renderPortableProviderPluginManifest,
  type PortableProviderPluginManifestV1,
} from "./provider-plugin-package";
import {
  encodePortableProviderPluginMessage,
  parsePortableProviderPluginFrame,
  parsePortableProviderPluginMessage,
  PortableProviderPluginFrameDecoder,
  type PortableProviderPluginMessage,
} from "./provider-plugin-protocol";

const identifierPart = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
    minLength: 1,
    maxLength: 8,
  })
  .map((parts) => parts.join(""));

const pluginId = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),
    fc.array(identifierPart, { maxLength: 3 }),
  )
  .map(([first, rest]) => [first, ...rest].join("-"));

const semanticVersion = fc
  .tuple(
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 0, max: 100 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("portable manifests render and parse as one canonical value", () => {
  assertProperty(fc.property(
    pluginId,
    semanticVersion,
    fc.string({ minLength: 1, maxLength: 256 }),
    (id, version, source) => {
      const bytes = Buffer.byteLength(source);
      if (bytes < 1 || bytes > 8 * 1024 * 1024 || /[\0\r\n]/u.test(id)) return;
      const value: PortableProviderPluginManifestV1 = {
        schemaVersion: 1,
        hostApiVersion: 1,
        id,
        version,
        displayName: id,
        runtime: {
          kind: "bun-js",
          entrypoint: "plugin.mjs",
        },
        provenance: {
          kind: "local",
        },
        capabilities: {
          networkOrigins: ["https://example.com"],
          planFiles: "none",
          state: "none",
          sessionMaterial: [],
        },
        bindings: [
          {
            transport: "web-session-api",
            adapterId: "example-web",
            surfaceId: "example",
            origin: "https://example.com",
            authKinds: ["cookies-file"],
            subject: {
              format: "bounded example account identifier",
              kind: "opaque-token",
              probe: {
                operation: "feeds.read",
                contractVersion: 1,
              },
            },
            operations: [
              {
                name: "feeds.read",
                contractVersion: 1,
                timeoutMs: 30_000,
                maxOutputBytes: 256 * 1024,
                state: "observed",
                risk: "R1",
                dispatch: "none",
                sideEffect: "none",
                idempotency: "none",
                dedupeWindowMs: 0,
                input: {
                  properties: {},
                  required: [],
                },
                implementation: "Reads one bounded feed page.",
              },
            ],
          },
        ],
        files: [
          {
            path: "plugin.mjs",
            kind: "runtime",
            bytes,
            sha256: sha256(source),
          },
        ],
      };
      const rendered = renderPortableProviderPluginManifest(value);
      const parsed = parsePortableProviderPluginManifest(
        JSON.parse(rendered) as unknown,
      );
      expect(parsed).toEqual({ ok: true, value });
      if (parsed.ok) {
        expect(renderPortableProviderPluginManifest(parsed.value)).toBe(rendered);
      }
    },
  ));
});

test("portable protocol framing is invariant to stream chunk boundaries", () => {
  assertProperty(fc.property(
    fc.array(fc.jsonValue(), { maxLength: 20 }),
    fc.array(fc.integer({ min: 1, max: 97 }), {
      minLength: 1,
      maxLength: 30,
    }),
    (outputs, chunkSizes) => {
      const messages: PortableProviderPluginMessage[] = [];
      for (const [index, output] of outputs.entries()) {
        const candidate: unknown = {
          protocolVersion: 1,
          kind: "plugin.result",
          invocationId: `invocation:${index}`,
          output,
          finalUrl: null,
        };
        const parsed = parsePortableProviderPluginMessage(candidate);
        expect(parsed.ok).toBeTrue();
        if (parsed.ok) messages.push(parsed.value);
      }
      const stream = Buffer.from(
        messages.map(encodePortableProviderPluginMessage).join(""),
      );
      const decoder = new PortableProviderPluginFrameDecoder();
      const decoded: PortableProviderPluginMessage[] = [];
      let offset = 0;
      let sizeIndex = 0;
      while (offset < stream.byteLength) {
        const size = chunkSizes[sizeIndex % chunkSizes.length]!;
        decoded.push(...decoder.push(stream.subarray(offset, offset + size)));
        offset += size;
        sizeIndex += 1;
      }
      decoder.finish();
      expect(decoded).toEqual(messages);
      for (const message of decoded) {
        expect(
          parsePortableProviderPluginFrame(
            encodePortableProviderPluginMessage(message),
          ),
        ).toEqual(message);
      }
    },
  ));
});
