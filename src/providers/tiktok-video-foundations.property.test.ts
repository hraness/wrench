import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { assertProperty, fc } from "../test-support";
import {
  buildTikTokPublishedPostDeleteBody,
  parseTikTokDeletePermissionProjection,
} from "./tiktok-web";
import { tiktokMp4Metadata } from "./tiktok-video-mp4";
import { revalidateTikTokVideoPublishBindingForDispatch } from "./tiktok-web-runtime";

const POST_ID = "7491234567890123456";
const PROJECT_ID = "project-1";
const TIKTOK_COMPATIBLE_MP4_BRANDS = new Set([
  "M4V ",
  "MSNV",
  "avc1",
  "iso2",
  "isom",
  "mp41",
  "mp42",
]);
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

function mp4Fixture(majorBrand: string, compatibleBrand: string): Buffer {
  const fileType = Buffer.alloc(12);
  fileType.write(majorBrand, 0, 4, "ascii");
  fileType.writeUInt32BE(0x200, 4);
  fileType.write(compatibleBrand, 8, 4, "ascii");
  const trackHeader = Buffer.alloc(84);
  for (const [index, value] of IDENTITY_MATRIX.entries()) {
    trackHeader.writeUInt32BE(value, 40 + index * 4);
  }
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

function dispatchBinding(): Readonly<Record<string, unknown>> {
  const bytes = new Uint8Array(mp4Fixture("isom", "iso2"));
  return Object.freeze({
    allowAiRemix: false,
    allowComments: false,
    allowContentReuse: false,
    allowDuet: false,
    allowStitch: false,
    audience: "private",
    byteLength: bytes.byteLength,
    bytes,
    caption: "Exact temporary fixture",
    commercialContent: "none",
    containsSyntheticMedia: false,
    durationSeconds: 12.345,
    height: 360,
    mediaSha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: "video/mp4",
    width: 640,
  });
}

const unknownMp4Brand = fc.array(
  fc.constantFrom(
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  ),
  { minLength: 4, maxLength: 4 },
).map((characters) => characters.join(""))
  .filter((brand) => !TIKTOK_COMPATIBLE_MP4_BRANDS.has(brand));

const permissionCode = fc.integer({ min: 0, max: 1_000_000 });
const exactPermission = fc.record({
  biz_reason: permissionCode,
  biz_status: permissionCode,
  biz_type: permissionCode,
});
const exactPermissionWithoutTrue = fc.oneof(
  exactPermission,
  exactPermission.map((permission) => ({ ...permission, is_recyclable: false })),
);

test("property: TikTok recyclable permission is selected uniquely across exact permission objects", () => {
  assertProperty(fc.property(
    fc.boolean(),
    exactPermission,
    fc.array(exactPermissionWithoutTrue, { maxLength: 20 }),
    fc.array(exactPermissionWithoutTrue, { maxLength: 20 }),
    (recyclable, owner, before, after) => {
      expect(parseTikTokDeletePermissionProjection({
        biz_permissions: [
          ...before,
          { ...owner, is_recyclable: recyclable },
          ...after,
        ],
      })).toEqual({ recyclable });
    },
  ));
});

test("property: TikTok recycle-bin deletion admits only exact true eligibility", () => {
  assertProperty(fc.property(
    fc.jsonValue().filter((value) => value !== true),
    (recyclable) => {
      expect(() => buildTikTokPublishedPostDeleteBody({
        postId: POST_ID,
        projectId: PROJECT_ID,
        recyclable,
      }))
        .toThrow("requires exact is_recyclable true permission");
    },
  ));
});

test("property: TikTok normal recycle deletion omits only an undefined project ID", () => {
  const providerProjectId = fc.array(
    fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~:@+/=-"),
    { minLength: 1, maxLength: 128 },
  ).map((characters) => characters.join(""));
  assertProperty(fc.property(
    fc.option(providerProjectId, { nil: undefined }),
    (projectId) => {
      const body = buildTikTokPublishedPostDeleteBody({
        postId: POST_ID,
        projectId,
        recyclable: true,
      });
      expect(body).toEqual({
        aweme_id: POST_ID,
        ...(projectId === undefined ? {} : { project_id: projectId }),
        scene: 1,
        delete: { delete_type: 1 },
      });
      expect(Object.hasOwn(body, "project_id")).toBe(projectId !== undefined);
    },
  ));
});

test("property: TikTok permission projections treat every missing true grant as not recyclable", () => {
  assertProperty(fc.property(
    fc.array(exactPermissionWithoutTrue, { minLength: 1, maxLength: 64 }),
    (bizPermissions) => {
      expect(parseTikTokDeletePermissionProjection({
        biz_permissions: bizPermissions,
      })).toEqual({ recyclable: false });
    },
  ));
});

test("property: TikTok permission projections reject every unknown permission field", () => {
  assertProperty(fc.property(
    exactPermission,
    fc.string({ minLength: 1, maxLength: 32 }).filter((key) =>
      !["biz_reason", "biz_status", "biz_type", "is_recyclable"].includes(key)
    ),
    fc.jsonValue(),
    (permission, key, value) => {
      expect(() => parseTikTokDeletePermissionProjection({
        biz_permissions: [{ ...permission, [key]: value }],
      })).toThrow("bundle-proven fields");
    },
  ));
});

test("property: TikTok video metadata rejects unknown-only file-type brands", () => {
  assertProperty(fc.property(
    unknownMp4Brand,
    unknownMp4Brand,
    (majorBrand, compatibleBrand) => {
      expect(() => tiktokMp4Metadata(
        mp4Fixture(majorBrand, compatibleBrand),
        "TikTok video",
      )).toThrow("file-type box is not MP4-compatible");
    },
  ));
});

test("property: TikTok dispatch bindings reject every unknown top-level field", () => {
  const binding = dispatchBinding();
  assertProperty(fc.property(
    fc.string({ minLength: 1, maxLength: 64 }),
    fc.jsonValue(),
    (key, value) => {
      fc.pre(!Object.hasOwn(binding, key));
      expect(() => revalidateTikTokVideoPublishBindingForDispatch({
        ...binding,
        [key]: value,
      })).toThrow("unsupported fields");
    },
  ));
});

test("property: TikTok dispatch bindings reject non-boolean creator declarations", () => {
  const binding = dispatchBinding();
  assertProperty(fc.property(
    fc.constantFrom(
      "allowAiRemix",
      "allowComments",
      "allowContentReuse",
      "allowDuet",
      "allowStitch",
      "containsSyntheticMedia",
    ),
    fc.jsonValue().filter((value) => typeof value !== "boolean"),
    (field, value) => {
      expect(() => revalidateTikTokVideoPublishBindingForDispatch({
        ...binding,
        [field]: value,
      })).toThrow("creator declarations are invalid");
    },
  ));
});

test("property: TikTok dispatch rebinding detects every mdat byte mutation", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 255 }),
    (xorMask) => {
      const binding = dispatchBinding();
      const bytes = binding.bytes as Uint8Array;
      bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ xorMask;
      expect(() => revalidateTikTokVideoPublishBindingForDispatch(binding))
        .toThrow("changed from its exact bytes");
    },
  ));
});
