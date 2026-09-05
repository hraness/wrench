// After a clean Bun 1.3.14 tree, two `npm pack --ignore-scripts` artifacts
// from npm 11.19.0 of Wrench 0.16.6 (Beeper contacts.list@3 Desktop loopback
// and archived 2.3.0 adapter baseline) were byte-identical: 2,214,175 packed
// bytes, 12,232,594 unpacked bytes, and 466 files. Their SHA-256 was
// e49aa949b885960aa42a0ee5f99a70cfd1bc115934bdc8131a2823fe62f5ff03. Two `bun pm pack --ignore-scripts` artifacts
// of the same tree were also byte-identical at 2,072,758 packed bytes
// (SHA-256 3b5ddf86f79e98be42179ee26eb75c3ed572196c97761ab055910193944f138f).
// The Linux staging job uses npm pack, which is 141,417 bytes larger than bun's
// gzip. Prior CI measured a 3,543-byte Linux/macOS gzip spread.
// Set the packed-byte ceiling to 2,217,718 and keep 4,244 unpacked bytes of bounded headroom.
// File inventory is exact at 466.
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
