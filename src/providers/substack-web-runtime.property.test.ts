import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { assertProperty, fc } from "../test-support";
import {
  createSubstackVideoMultipartDispatchCheckpoint,
  parseSubstackVideoBinding,
  parseSubstackNoteDeletionRecoveryTargetIdentifier,
  parseSubstackVideoUploadRecoveryTargetIdentifier,
  planSubstackVideoMultipartParts,
  revalidateAndSnapshotSubstackVideoMultipartDispatch,
  substackNoteDeletionRecoveryReadRequest,
  substackNoteDeletionRecoveryTargetIdentifier,
  substackVideoUploadRecoveryStatusRequest,
  substackVideoUploadRecoveryTargetIdentifier,
} from "./substack-web-runtime";

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

function mp4Fixture(mdat: Uint8Array): Buffer {
  const fileType = Buffer.alloc(16);
  fileType.write("isom", 0, 4, "ascii");
  fileType.writeUInt32BE(0x200, 4);
  fileType.write("isomiso2", 8, 8, "ascii");
  const trackHeader = Buffer.alloc(84);
  for (const [index, value] of [
    0x0001_0000, 0, 0,
    0, 0x0001_0000, 0,
    0, 0, 0x4000_0000,
  ].entries()) trackHeader.writeUInt32BE(value, 40 + index * 4);
  trackHeader.writeUInt32BE(640 * 65_536, 76);
  trackHeader.writeUInt32BE(360 * 65_536, 80);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, 4, "ascii");
  const mediaHeader = Buffer.alloc(24);
  mediaHeader.writeUInt32BE(1_000, 12);
  mediaHeader.writeUInt32BE(12_345, 16);
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
    isoBox("mdat", mdat),
  ]);
}

function videoBinding(bytesValue: Uint8Array): {
  bytes: Uint8Array;
  byteLength: number;
  durationSeconds: number;
  height: number;
  mediaType: "video/mp4";
  sha256: string;
  width: number;
} {
  const bytes = new Uint8Array(bytesValue);
  return {
    bytes,
    byteLength: bytes.byteLength,
    durationSeconds: 12.345,
    height: 360,
    mediaType: "video/mp4",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 640,
  };
}

const responseBoundIdentifier = fc.array(
  fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"),
  { minLength: 1, maxLength: 128 },
).map((characters) => characters.join(""));

test("property: Substack multipart plans cover every byte exactly once in order", () => {
  assertProperty(fc.property(
    fc.integer({ min: 24, max: 128 * 1024 * 1024 }),
    (byteLength) => {
      const count = Math.ceil(byteLength / (50 * 1024 * 1024));
      const parts = planSubstackVideoMultipartParts(byteLength, count);
      expect(parts).toHaveLength(count);
      let next = 0;
      for (const [index, part] of parts.entries()) {
        expect(part.partNumber).toBe(index + 1);
        expect(part.start).toBe(next);
        expect(part.endExclusive - part.start).toBe(part.byteLength);
        next = part.endExclusive;
      }
      expect(next).toBe(byteLength);
    },
  ));
});

test("property: Substack rejects same-metadata mdat mutations across a dispatch checkpoint", () => {
  assertProperty(fc.property(
    fc.uint8Array({ minLength: 4, maxLength: 64 }),
    fc.integer({ min: 0, max: 63 }),
    fc.integer({ min: 1, max: 255 }),
    (mdat, arbitraryIndex, mask) => {
      const original = videoBinding(mp4Fixture(mdat));
      const checkpoint = createSubstackVideoMultipartDispatchCheckpoint(original, 1);
      const mutatedBytes = new Uint8Array(original.bytes);
      const mdatIndex = mutatedBytes.byteLength - mdat.byteLength
        + (arbitraryIndex % mdat.byteLength);
      mutatedBytes[mdatIndex] = (mutatedBytes[mdatIndex]! ^ mask) & 0xff;

      expect(() => parseSubstackVideoBinding({
        ...original,
        bytes: mutatedBytes,
      })).toThrow("byte integrity changed from its exact bytes");

      const changedVersion = videoBinding(mutatedBytes);
      expect(changedVersion.durationSeconds).toBe(original.durationSeconds);
      expect(changedVersion.height).toBe(original.height);
      expect(changedVersion.width).toBe(original.width);
      expect(() => revalidateAndSnapshotSubstackVideoMultipartDispatch(
        changedVersion,
        checkpoint,
      )).toThrow("changed after its multipart dispatch checkpoint");
    },
  ));
});

test("property: Substack video status recovery identifiers round-trip canonically", () => {
  assertProperty(fc.property(responseBoundIdentifier, (mediaUploadId) => {
    const identifier = substackVideoUploadRecoveryTargetIdentifier(mediaUploadId);
    expect(parseSubstackVideoUploadRecoveryTargetIdentifier(identifier)).toEqual({
      mediaUploadId,
      schemaVersion: 1,
    });
    expect(substackVideoUploadRecoveryStatusRequest(identifier).url).toBe(
      `https://substack.com/api/v1/video/upload/${mediaUploadId}`,
    );
  }));
});

test("property: Substack personal-Note recovery identifiers round-trip canonically", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 2_147_483_647 }),
    (noteId) => {
      const target = { noteId, publicationId: null, schemaVersion: 1 } as const;
      const identifier = substackNoteDeletionRecoveryTargetIdentifier(target);
      expect(parseSubstackNoteDeletionRecoveryTargetIdentifier(identifier)).toEqual(target);
      expect(substackNoteDeletionRecoveryReadRequest(identifier)).toEqual({
        method: "GET",
        url: `https://substack.com/api/v1/reader/comment/${noteId}`,
      });
    },
  ));
});
