import { isoBmffMp4VideoMetadata } from "./iso-bmff";

const SUBSTACK_MP4_COMPATIBILITY_POLICY = Object.freeze({
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
 * Apply Substack's explicit MP4 brand policy to the provider-neutral structural
 * duration and dimension projection used by its transcode request.
 */
export function substackMp4Metadata(
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
    SUBSTACK_MP4_COMPATIBILITY_POLICY,
  );
}
