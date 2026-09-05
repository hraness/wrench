// After a clean checkout of current 0.16.6 main, two `npm pack --ignore-scripts`
// artifacts of the same tree were byte-identical: 2,214,175 packed bytes,
// 12,232,594 unpacked bytes, and 466 files. Their SHA-256 was
// e49aa949b885960aa42a0ee5f99a70cfd1bc115934bdc8131a2823fe62f5ff03.
// GitHub-hosted Stage Verify (npm 11.19.0) reported the same packed size.
// Staging and Release pack with npm, not `bun pm pack`; the older bun-pack
// measurement sat under the previous ceiling until that npm tarball exceeded
// it. Prior CI measured a 3,543-byte Linux/macOS gzip spread. Set the packed
// ceiling to the measured npm pack plus that spread, and keep 4,244 unpacked
// bytes of bounded headroom. File inventory stays exact at 466.
export const MAX_PACKED_BYTES = 2_217_718;
export const MAX_PACKED_ENTRIES = 466;
export const MAX_PACKED_FILES = 466;
export const MAX_UNPACKED_BYTES = 12_236_838;

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
