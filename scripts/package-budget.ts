// After a clean Bun 1.3.14 build, two `bun pm pack` artifacts of the
// combined LinkedIn profile-activity and Instagram profile-read candidate were
// byte-identical: 2,058,876 packed bytes,
// 12,117,845 unpacked bytes, and 462 files. Their SHA-256 was
// 276b0dfe0ef928a8a2c75fea8be53ea79cabaf999ea6dfa607b7bb4b8ec01ba1. Prior CI
// measured a 3,543-byte Linux/macOS gzip spread. Keep the existing 2,178,192 packed-byte ceiling
// and 4,244 unpacked bytes of bounded headroom. File inventory is exact at 462
// after retaining linkedin-web-feed.ts, linkedin-web-feed-browser.ts, and
// wrench-web-adapter.v1.19.0.json and adding instagram-web-profile-browser.ts
// plus wrench-web-adapter.v1.7.0.json.
export const MAX_PACKED_BYTES = 2_178_192;
export const MAX_PACKED_ENTRIES = 462;
export const MAX_PACKED_FILES = 462;
export const MAX_UNPACKED_BYTES = 12_122_089;

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
