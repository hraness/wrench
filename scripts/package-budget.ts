// Bun 1.3.14 packed this v0.17.0 package-budget candidate twice on macOS to
// identical 1,923,565-byte archives with 11,224,464 unpacked bytes. Prior CI
// for v0.16.2 measured a 3,543-byte Linux/macOS gzip spread. Keep bounded room
// for that observed transport variance and small reviewed payload drift.
export const MAX_PACKED_BYTES = 2_050_000;
export const MAX_PACKED_FILES = 450;
export const MAX_UNPACKED_BYTES = 11_300_000;

export const packageArtifactBudget = Object.freeze({
  entryCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  fileCount: Object.freeze({ min: 350, max: MAX_PACKED_FILES }),
  packedBytes: Object.freeze({ min: 1_600_000, max: MAX_PACKED_BYTES }),
  unpackedBytes: Object.freeze({ min: 9_000_000, max: MAX_UNPACKED_BYTES }),
});
