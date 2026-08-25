import { describe, expect, test } from "bun:test";

import {
  isoBmffMp4VideoMetadata,
  isoBmffVideoDimensions,
} from "./iso-bmff";

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
const MP4_POLICY = Object.freeze({
  compatibleBrands: Object.freeze(["iso2", "isom", "mp41", "mp42"]),
  rejectedMajorBrands: Object.freeze(["qt  "]),
});

function isoBox(type: string, ...payloads: readonly Uint8Array[]): Buffer {
  const payloadBytes = payloads.reduce(
    (total, payload) => total + payload.byteLength,
    0,
  );
  const bytes = Buffer.alloc(8 + payloadBytes);
  bytes.writeUInt32BE(bytes.byteLength, 0);
  bytes.write(type, 4, 4, "ascii");
  let offset = 8;
  for (const payload of payloads) {
    Buffer.from(payload).copy(bytes, offset);
    offset += payload.byteLength;
  }
  return bytes;
}

function trackHeader(
  version: 0 | 1,
  width: number,
  height: number,
  matrix: readonly number[] = IDENTITY_MATRIX,
): Buffer {
  const dimensionOffset = version === 0 ? 76 : 88;
  const bytes = Buffer.alloc(dimensionOffset + 8);
  bytes[0] = version;
  const matrixOffset = dimensionOffset - 36;
  for (const [index, value] of matrix.entries()) {
    bytes.writeUInt32BE(value, matrixOffset + index * 4);
  }
  bytes.writeUInt32BE(width * 65_536, dimensionOffset);
  bytes.writeUInt32BE(height * 65_536, dimensionOffset + 4);
  return bytes;
}

function mp4Fixture(
  version: 0 | 1,
  matrix: readonly number[] = IDENTITY_MATRIX,
  durationUnits = 12_345n,
): Buffer {
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write("isom", 0, 4, "ascii");
  ftypPayload.writeUInt32BE(0x200, 4);
  ftypPayload.write("isomiso2", 8, 8, "ascii");
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  const mediaHeader = Buffer.alloc(version === 0 ? 24 : 36);
  mediaHeader[0] = version;
  const timescaleOffset = version === 0 ? 12 : 20;
  const durationOffset = version === 0 ? 16 : 24;
  mediaHeader.writeUInt32BE(1_000, timescaleOffset);
  if (version === 0) {
    mediaHeader.writeUInt32BE(Number(durationUnits), durationOffset);
  } else {
    mediaHeader.writeBigUInt64BE(durationUnits, durationOffset);
  }
  return Buffer.concat([
    isoBox("ftyp", ftypPayload),
    isoBox(
      "moov",
      isoBox(
        "trak",
        isoBox("tkhd", trackHeader(version, 640, 360, matrix)),
        isoBox(
          "mdia",
          isoBox("hdlr", handler),
          isoBox("mdhd", mediaHeader),
        ),
      ),
    ),
    isoBox("mdat", Buffer.from([1, 2, 3, 4])),
  ]);
}

describe("ISO BMFF video metadata", () => {
  test("accepts the identity transform in both reviewed track-header versions", () => {
    expect(isoBmffVideoDimensions(mp4Fixture(0), "fixture")).toEqual({
      height: 360,
      width: 640,
    });
    expect(isoBmffVideoDimensions(mp4Fixture(1), "fixture")).toEqual({
      height: 360,
      width: 640,
    });
  });

  test("rejects rotated and scaled track transforms", () => {
    const rotated = [
      0,
      0x0001_0000,
      0,
      0xffff_0000,
      0,
      0,
      0,
      0,
      0x4000_0000,
    ];
    const scaled: number[] = [...IDENTITY_MATRIX];
    scaled[0] = 0x0002_0000;

    expect(() => isoBmffVideoDimensions(mp4Fixture(0, rotated), "fixture"))
      .toThrow("fixture track header has an unsupported transform matrix");
    expect(() => isoBmffVideoDimensions(mp4Fixture(1, scaled), "fixture"))
      .toThrow("fixture track header has an unsupported transform matrix");
  });

  test("shares one finite box budget across nested containers", () => {
    const ftypPayload = Buffer.alloc(8);
    ftypPayload.write("isom", 0, 4, "ascii");
    const topLevelPadding = Array.from({ length: 3_000 }, () => isoBox("free"));
    const moviePadding = Buffer.concat(
      Array.from({ length: 2_000 }, () => isoBox("free")),
    );
    const adversarial = Buffer.concat([
      isoBox("ftyp", ftypPayload),
      ...topLevelPadding,
      isoBox("moov", moviePadding),
    ]);

    expect(() => isoBmffVideoDimensions(adversarial, "adversarial fixture"))
      .toThrow("adversarial fixture movie box exceeds the reviewed ISO BMFF box-count bound");
  });

  test("projects duration under an explicit MP4 policy", () => {
    expect(isoBmffMp4VideoMetadata(mp4Fixture(0), "fixture", MP4_POLICY))
      .toEqual({ durationSeconds: 12.345, height: 360, width: 640 });
    expect(isoBmffMp4VideoMetadata(mp4Fixture(1), "fixture", MP4_POLICY))
      .toEqual({ durationSeconds: 12.345, height: 360, width: 640 });
  });

  test("rejects both ISO BMFF unknown-duration sentinels", () => {
    expect(() => isoBmffMp4VideoMetadata(
      mp4Fixture(0, IDENTITY_MATRIX, 0xffff_ffffn),
      "fixture",
      MP4_POLICY,
    )).toThrow("unknown-duration sentinel");
    expect(() => isoBmffMp4VideoMetadata(
      mp4Fixture(1, IDENTITY_MATRIX, 0xffff_ffff_ffff_ffffn),
      "fixture",
      MP4_POLICY,
    )).toThrow("unknown-duration sentinel");
  });
});
