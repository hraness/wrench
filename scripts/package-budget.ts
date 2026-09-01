// npm 11.19.0 measured the merged PR #117 and PR #118 candidate at
// 11,200,629 unpacked bytes and 435 files. The v0.16.2 package-budget
// candidate packed twice on macOS at 2,021,302 packed bytes; prior CI for that
// same v0.16.2 payload measured a 3,543-byte Linux/macOS gzip spread. Keep
// bounded room for that observed transport variance and small reviewed payload
// drift.
export const MAX_PACKED_BYTES = 2_050_000;
export const MAX_PACKED_FILES = 450;
export const MAX_UNPACKED_BYTES = 11_300_000;

export const packageArtifactBudget = Object.freeze({
  entryCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  fileCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  packedBytes: Object.freeze({ min: 1_600_000, max: MAX_PACKED_BYTES }),
  unpackedBytes: Object.freeze({ min: 9_000_000, max: MAX_UNPACKED_BYTES }),
});
