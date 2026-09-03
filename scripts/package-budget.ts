// After a clean Bun 1.3.14 build, two npm 11.19.0 packs of the converged
// v0.16.4 product candidate were byte-identical: 2,158,266 packed bytes,
// 11,911,298 unpacked bytes, and 451 files. Their SHA-256 was
// 3c2a51d706cdc5a34e7e88cfd850f727d344e957856deea4fae2809232100fa3. Prior CI
// measured a 3,543-byte Linux/macOS gzip spread. Keep 6,734 packed bytes and
// 13,702 unpacked bytes of bounded headroom, while admitting no package-inventory
// expansion.
export const MAX_PACKED_BYTES = 2_165_000;
export const MAX_PACKED_ENTRIES = 451;
export const MAX_PACKED_FILES = 451;
export const MAX_UNPACKED_BYTES = 11_925_000;

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
