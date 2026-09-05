// After a clean Bun 1.3.14 build, two `bun pm pack` artifacts of the Beeper
// contacts.list@3 Desktop loopback, archived 2.3.0 adapter baseline, and
// rebuilt public beeper client were byte-identical: 2,072,396 packed bytes,
// 12,231,301 unpacked bytes, and 466 files. Their SHA-256 was
// eb1f11ee0573220c0eb415132b076b5885f39fc6e75136990df47ee32e44f878. Prior CI
// measured a 3,543-byte Linux/macOS gzip spread. Keep the existing 2,178,192 packed-byte ceiling
// and 4,244 unpacked bytes of bounded headroom. File
// inventory is exact at 466 after adding the immutable Beeper v2.3.0 adapter
// baseline so contacts.list@2 stays on official CLI v0.6.2.
export const MAX_PACKED_BYTES = 2_178_192;
export const MAX_PACKED_ENTRIES = 466;
export const MAX_PACKED_FILES = 466;
export const MAX_UNPACKED_BYTES = 12_235_545;

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
