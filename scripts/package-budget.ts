// Keep enough packed-byte room for reviewed gzip and tar variance while retaining tight payload gates.
export const MAX_PACKED_BYTES = 2_050_000;
export const MAX_PACKED_FILES = 450;
export const MAX_UNPACKED_BYTES = 11_000_000;

export const packageArtifactBudget = Object.freeze({
  entryCount: { min: 350, max: 450 },
  fileCount: { min: 350, max: MAX_PACKED_FILES },
  packedBytes: { min: 1_600_000, max: MAX_PACKED_BYTES },
  unpackedBytes: { min: 9_000_000, max: MAX_UNPACKED_BYTES },
});
