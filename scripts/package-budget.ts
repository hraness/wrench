// npm 11.19.0 packed the rebased v0.16.2 Beeper direct-read candidate at
// 2,052,563 packed bytes, 11,320,511 unpacked bytes, and 437 files. Prior CI for
// the earlier v0.16.2 payload measured a 3,543-byte Linux/macOS gzip spread.
// Keep bounded room for that observed transport variance and small reviewed
// payload drift.
export const MAX_PACKED_BYTES = 2_075_000;
export const MAX_PACKED_FILES = 450;
export const MAX_UNPACKED_BYTES = 11_425_000;

export const packageArtifactBudget = Object.freeze({
  entryCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  fileCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  packedBytes: Object.freeze({ min: 1_600_000, max: MAX_PACKED_BYTES }),
  unpackedBytes: Object.freeze({ min: 9_000_000, max: MAX_UNPACKED_BYTES }),
});
