// npm 11.19.0 packed the converged v0.16.3 product candidate at 2,157,703
// packed bytes, 11,909,013 unpacked bytes, and 451 files. Prior CI measured a
// 3,543-byte Linux/macOS gzip spread. Keep bounded room for that observed
// transport variance and small reviewed payload drift without admitting another
// archive-sized expansion.
export const MAX_PACKED_BYTES = 2_180_000;
export const MAX_PACKED_ENTRIES = 455;
export const MAX_PACKED_FILES = 455;
export const MAX_UNPACKED_BYTES = 12_025_000;

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
  entryCount: Object.freeze({ min: 350, max: MAX_PACKED_ENTRIES }),
  fileCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  packedBytes: Object.freeze({ min: 1_600_000, max: MAX_PACKED_BYTES }),
  unpackedBytes: Object.freeze({ min: 9_000_000, max: MAX_UNPACKED_BYTES }),
});
