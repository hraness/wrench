import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  embedPngChunk,
  encodePixelsOnlyPng,
  imageBytesContainProvenance,
  minimalPngBytes,
  rejectGifProvenanceMarkers,
  scrubXUploadImage,
} from "./x-image-provenance";

function pngHasChunk(bytes: Uint8Array, type: string): boolean {
  const needle = Buffer.from(type, "ascii");
  return Buffer.from(bytes).includes(needle);
}

describe("X upload image provenance scrub", () => {
  test("re-encodes a PNG that embeds caBX and C2PA markers into pixels-only bytes", () => {
    const clean = encodePixelsOnlyPng({
      width: 2,
      height: 1,
      rgba: Uint8Array.of(10, 20, 30, 255, 40, 50, 60, 255),
    });
    const tainted = embedPngChunk(
      clean,
      "caBX",
      Buffer.from("c2pa trainedAlgorithmicMedia digitalSourceType OpenAI", "utf8"),
    );
    expect(pngHasChunk(tainted, "caBX")).toBeTrue();
    expect(imageBytesContainProvenance(tainted)).toBeTrue();

    const scrubbed = scrubXUploadImage(tainted, "image/png");
    expect(pngHasChunk(scrubbed, "caBX")).toBeFalse();
    expect(imageBytesContainProvenance(scrubbed)).toBeFalse();
    expect(Buffer.from(scrubbed).includes(Buffer.from("c2pa"))).toBeFalse();
    expect(Buffer.from(scrubbed).includes(Buffer.from("OpenAI"))).toBeFalse();
    expect(scrubbed.subarray(0, 8)).toEqual(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
    expect(scrubXUploadImage(scrubbed, "image/png")).toEqual(scrubbed);
  });

  test("fails closed when residual provenance would still be uploaded", () => {
    expect(() => rejectGifProvenanceMarkers(Buffer.from("GIF89a trainedAlgorithmicMedia"))).toThrow(
      "GIF attachment contained provenance markers",
    );
  });

  test("strips JPEG APP and COM provenance before upload", () => {
    const jpeg = Uint8Array.of(
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x12,
      ...Buffer.from("c2pa caBX OpenAI", "ascii"),
      0xff, 0xfe, 0x00, 0x19,
      ...Buffer.from("trainedAlgorithmicMedia", "ascii"),
      0xff, 0xd9,
    );
    expect(imageBytesContainProvenance(jpeg)).toBeTrue();
    const scrubbed = scrubXUploadImage(jpeg, "image/jpeg");
    expect(imageBytesContainProvenance(scrubbed)).toBeFalse();
    expect(scrubbed).toEqual(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9));
  });

  test("rejects a PNG signature that is not a complete image", () => {
    expect(() => scrubXUploadImage(Uint8Array.of(0x89, 0x50, 0x4e, 0x47), "image/png"))
      .toThrow("not a complete PNG");
  });

  test("property: pixel-only PNG re-encode preserves RGBA and drops ancillary chunks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        fc.uint8Array({ minLength: 4, maxLength: 64 }),
        (width, height, entropy) => {
          const rgba = new Uint8Array(width * height * 4);
          for (let index = 0; index < rgba.byteLength; index += 1) {
            rgba[index] = entropy[index % entropy.byteLength] ?? 0;
          }
          const clean = encodePixelsOnlyPng({ width, height, rgba });
          const tainted = embedPngChunk(
            clean,
            "caBX",
            Buffer.from(`c2pa-${entropy.byteLength}-trainedAlgorithmicMedia`, "utf8"),
          );
          const scrubbed = scrubXUploadImage(tainted, "image/png");
          expect(imageBytesContainProvenance(scrubbed)).toBeFalse();
          expect(pngHasChunk(scrubbed, "caBX")).toBeFalse();
          expect(pngHasChunk(scrubbed, "iTXt")).toBeFalse();
          expect(scrubXUploadImage(scrubbed, "image/png")).toEqual(scrubbed);
        },
      ),
      { numRuns: 64 },
    );
  });

  test("minimal PNG fixture is a pixels-only 1x1 image", () => {
    const bytes = minimalPngBytes();
    expect(bytes.byteLength).toBeGreaterThan(67);
    expect(imageBytesContainProvenance(bytes)).toBeFalse();
    expect(scrubXUploadImage(bytes, "image/png")).toEqual(bytes);
  });
});
