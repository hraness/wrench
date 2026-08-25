import { isoBmffMp4VideoMetadata } from "./iso-bmff";

const TIKTOK_MP4_COMPATIBILITY_POLICY = Object.freeze({
  compatibleBrands: Object.freeze([
    "M4V ",
    "MSNV",
    "avc1",
    "iso2",
    "isom",
    "mp41",
    "mp42",
  ]),
  rejectedMajorBrands: Object.freeze(["qt  "]),
});

/**
 * Apply TikTok's explicit standards-compatible MP4 brand policy before the
 * capture-required upload reservation can label plan-bound bytes video/mp4.
 */
export function tiktokMp4Metadata(
  bytes: Uint8Array,
  label: string,
): Readonly<{
  durationSeconds: number;
  height: number;
  width: number;
}> {
  return isoBmffMp4VideoMetadata(
    bytes,
    label,
    TIKTOK_MP4_COMPATIBILITY_POLICY,
  );
}
