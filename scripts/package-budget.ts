// npm 11.19.0 packed the converged v0.16.3 product candidate at 2,157,703
// packed bytes, 11,909,013 unpacked bytes, and 451 files. Prior CI measured a
// 3,543-byte Linux/macOS gzip spread. Keep bounded room for that observed
// transport variance and small reviewed payload drift without admitting another
// archive-sized expansion.
export const MAX_PACKED_BYTES = 2_180_000;
export const MAX_PACKED_FILES = 455;
export const MAX_UNPACKED_BYTES = 12_025_000;

export const packageArtifactBudget = Object.freeze({
  entryCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  fileCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  packedBytes: Object.freeze({ min: 1_600_000, max: MAX_PACKED_BYTES }),
  unpackedBytes: Object.freeze({ min: 9_000_000, max: MAX_UNPACKED_BYTES }),
});
