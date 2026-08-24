import { describe, expect, test } from "bun:test";

import { substackMp4Metadata } from "./substack-video-mp4";

const IDENTITY_MATRIX = Object.freeze([
  0x0001_0000,
  0,
  0,
  0,
  0x0001_0000,
  0,
  0,
  0,
  0x4000_0000,
] as const);

function isoBox(type: string, ...payloads: readonly Uint8Array[]): Buffer {
  const payloadBytes = payloads.reduce((total, payload) => total + payload.byteLength, 0);
  const result = Buffer.alloc(8 + payloadBytes);
  result.writeUInt32BE(result.byteLength, 0);
  result.write(type, 4, 4, "ascii");
  let offset = 8;
  for (const payload of payloads) {
    Buffer.from(payload).copy(result, offset);
    offset += payload.byteLength;
  }
  return result;
}

function fixture(
  durationVersion: 0 | 1,
  majorBrand = "isom",
  durationUnits = 12_345n,
): Buffer {
  const fileType = Buffer.alloc(16);
  fileType.write(majorBrand, 0, 4, "ascii");
  fileType.writeUInt32BE(0x200, 4);
  fileType.write("isomiso2", 8, 8, "ascii");
  const trackHeader = Buffer.alloc(84);
  const matrixOffset = 40;
  for (const [index, value] of IDENTITY_MATRIX.entries()) {
    trackHeader.writeUInt32BE(value, matrixOffset + index * 4);
  }
  trackHeader.writeUInt32BE(640 * 65_536, 76);
  trackHeader.writeUInt32BE(360 * 65_536, 80);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  const mediaHeader = Buffer.alloc(durationVersion === 0 ? 24 : 36);
  mediaHeader[0] = durationVersion;
  const timescaleOffset = durationVersion === 0 ? 12 : 20;
  const durationOffset = durationVersion === 0 ? 16 : 24;
  mediaHeader.writeUInt32BE(1_000, timescaleOffset);
  if (durationVersion === 0) {
    mediaHeader.writeUInt32BE(Number(durationUnits), durationOffset);
  } else {
    mediaHeader.writeBigUInt64BE(durationUnits, durationOffset);
  }
  return Buffer.concat([
    isoBox("ftyp", fileType),
    isoBox(
      "moov",
      isoBox(
        "trak",
        isoBox("tkhd", trackHeader),
        isoBox("mdia", isoBox("hdlr", handler), isoBox("mdhd", mediaHeader)),
      ),
    ),
    isoBox("mdat", Buffer.from([1, 2, 3, 4])),
  ]);
}

describe("Substack MP4 metadata", () => {
  test("projects exact duration and dimensions from both media-header versions", () => {
    expect(substackMp4Metadata(fixture(0), "fixture")).toEqual({
      durationSeconds: 12.345,
      height: 360,
      width: 640,
    });
    expect(substackMp4Metadata(fixture(1), "fixture")).toEqual({
      durationSeconds: 12.345,
      height: 360,
      width: 640,
    });
  });

  test("rejects missing, zero, and unreviewed duration metadata", () => {
    const missing = fixture(0);
    missing.write("free", missing.indexOf(Buffer.from("mdhd", "ascii")), 4, "ascii");
    expect(() => substackMp4Metadata(missing, "fixture"))
      .toThrow("must contain exactly one mdhd box");

    const zero = fixture(0);
    const zeroHeader = zero.indexOf(Buffer.from("mdhd", "ascii")) + 4;
    zero.writeUInt32BE(0, zeroHeader + 16);
    expect(() => substackMp4Metadata(zero, "fixture"))
      .toThrow("media duration is outside the reviewed bound");

    const drifted = fixture(0);
    const driftedHeader = drifted.indexOf(Buffer.from("mdhd", "ascii")) + 4;
    drifted[driftedHeader] = 2;
    expect(() => substackMp4Metadata(drifted, "fixture"))
      .toThrow("media header changed from the reviewed shape");
  });

  test("rejects the ISO BMFF unknown-duration sentinel in both header versions", () => {
    expect(() => substackMp4Metadata(
      fixture(0, "isom", 0xffff_ffffn),
      "fixture",
    )).toThrow("unknown-duration sentinel");
    expect(() => substackMp4Metadata(
      fixture(1, "isom", 0xffff_ffff_ffff_ffffn),
      "fixture",
    )).toThrow("unknown-duration sentinel");
  });

  test("rejects a QuickTime file-type claim from the MP4-only operation", () => {
    expect(() => substackMp4Metadata(fixture(0, "qt  "), "fixture"))
      .toThrow("file-type box is not MP4-compatible");

    const withoutCompatibleBrand = fixture(0, "zzzz");
    withoutCompatibleBrand.write("yyyyyyyy", 16, 8, "ascii");
    expect(() => substackMp4Metadata(withoutCompatibleBrand, "fixture"))
      .toThrow("file-type box is not MP4-compatible");
  });
});
