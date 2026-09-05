// After a clean Bun 1.3.14 build, two npm 10.9.7 packs of the 0.16.6 Beeper
// contacts.list@3 Desktop loopback, archived 2.3.0 adapter baseline, LinkedIn
// profile-activity, Instagram profile-read, and Reddit flair candidate were
// byte-identical: 2,214,175 packed bytes, 12,232,594 unpacked bytes, and 466 files.
// Their SHA-256 was
// e49aa949b885960aa42a0ee5f99a70cfd1bc115934bdc8131a2823fe62f5ff03.
// Published 0.16.5 is 2,175,150 packed bytes. The 39,025-byte packed growth is
// the required Beeper v2.3.0 upgrade baseline plus the other 0.16.6 adapter
// snapshots and implementations. bun pm pack remasurements of 2,072,396
// understated the npm-stage artifact and left the 2,178,192 v0.16.4 ceiling
// 35,983 bytes short. Prior CI measured a 3,543-byte Linux/macOS gzip spread.
// Keep 6,734 packed bytes and 2,951 unpacked bytes of bounded headroom. File
// inventory is exact at 466 after adding the immutable Beeper v2.3.0 adapter
// baseline so contacts.list@2 stays on official CLI v0.6.2.
export const MAX_PACKED_BYTES = 2_220_909;
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
