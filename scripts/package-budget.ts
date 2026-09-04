// After a clean Bun 1.3.14 build, two `bun pm pack` artifacts of the
// LinkedIn profile-activity candidate were byte-identical: 2,050,616 packed bytes,
// 12,058,977 unpacked bytes, and 460 files. Their SHA-256 was
// 62b9b511386075f77fce7c49a57383e0fcbdc47f4c3b3f7d3b75578b69719474. Prior CI
// measured a 3,543-byte Linux/macOS gzip spread. Keep the existing 2,178,192 packed-byte ceiling
// and 13,702 unpacked bytes of bounded headroom. File inventory is exact at 460
// after adding linkedin-web-feed.ts, linkedin-web-feed-browser.ts, and
// wrench-web-adapter.v1.19.0.json.
export const MAX_PACKED_BYTES = 2_178_192;
export const MAX_PACKED_ENTRIES = 460;
export const MAX_PACKED_FILES = 460;
export const MAX_UNPACKED_BYTES = 12_072_679;

const TAR_BLOCK_BYTES = 512;
const TAR_ENTRY_ALLOWANCE_BYTES = TAR_BLOCK_BYTES + (TAR_BLOCK_BYTES - 1);
const TAR_TRAILER_BYTES = TAR_BLOCK_BYTES * 2;

// Each reviewed tar entry needs one 512-byte header plus at most 511 bytes of
// payload padding. Reserve that allowance for every admitted entry, the
// required two-block trailer, and round to the parser's 512-byte alignment.
export const MAX_PACKAGE_TAR_BYTES = Math.ceil(
  (
    MAX_UNPACKED_BYTES
    + MAX_PACKED_ENTRIES * TAR_ENTRY_ALLOWANCE_BYTES
    + TAR_TRAILER_BYTES
  ) / TAR_BLOCK_BYTES,
) * TAR_BLOCK_BYTES;

export const packageArtifactBudget = Object.freeze({
  entryCount: Object.freeze({ min: MAX_PACKED_ENTRIES, max: MAX_PACKED_ENTRIES }),
  fileCount: Object.freeze({ min: MAX_PACKED_FILES, max: MAX_PACKED_FILES }),
  packedBytes: Object.freeze({ min: 1_600_000, max: MAX_PACKED_BYTES }),
  unpackedBytes: Object.freeze({ min: 9_000_000, max: MAX_UNPACKED_BYTES }),
});
