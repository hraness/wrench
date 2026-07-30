import { expect, test } from "bun:test";
import {
  WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
  WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
  parseRevisionItemLeaf,
  revisionContentSha256,
  revisionItemLeaf,
  trackedRevisionAssetKey,
  type MediaTrackedRevision,
  type RevisionArtifactInput,
} from "./revision";

const artifact = (
  role: string,
  sha256: string,
  overrides: Partial<RevisionArtifactInput> = {},
): RevisionArtifactInput => ({
  role,
  bytes: 12,
  sha256,
  mediaType: "application/octet-stream",
  ...overrides,
});

const baseRevision = (overrides: Partial<MediaTrackedRevision> = {}): MediaTrackedRevision => ({
  profile: WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
  sequence: 1,
  subjectAssetKey: `source-v3-${"1".repeat(64)}`,
  content: {
    profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
    sha256: "2".repeat(64),
  },
  ...overrides,
});

test("fingerprints retained provider inputs independent of order and derivatives", () => {
  const retained = [
    artifact("capture", "1".repeat(64), { mediaType: "video/mp4" }),
    artifact("provider_metadata", "2".repeat(64), { mediaType: "application/json" }),
    artifact("thumbnail", "3".repeat(64), { mediaType: "image/png" }),
  ];
  const first = revisionContentSha256([
    ...retained,
    artifact("audio", "4".repeat(64), { mediaType: "audio/ogg" }),
  ]);
  const second = revisionContentSha256([
    retained[2]!,
    artifact("video", "5".repeat(64), { mediaType: "video/webm" }),
    retained[0]!,
    retained[1]!,
  ]);
  expect(first).toBe(second);
  expect(revisionContentSha256([
    retained[0]!,
    retained[1]!,
    artifact("thumbnail", "6".repeat(64), { mediaType: "image/png" }),
  ])).not.toBe(first);
});

test("fingerprints Wrench media's canonical UTF-8 text media type", () => {
  expect(revisionContentSha256([
    artifact("transcript_text", "7".repeat(64), {
      mediaType: "text/plain; charset=utf-8",
    }),
  ])).toMatch(/^[0-9a-f]{64}$/u);
});

test("rejects empty, duplicate, or malformed retained input sets", () => {
  expect(() => revisionContentSha256([artifact("audio", "1".repeat(64))])).toThrow();
  expect(() => revisionContentSha256([
    artifact("capture", "1".repeat(64)),
    artifact("capture", "2".repeat(64)),
  ])).toThrow();
  expect(() => revisionContentSha256([artifact("capture", "not-a-digest")])).toThrow();
  expect(() => revisionContentSha256([
    artifact("capture", "1".repeat(64), { bytes: -1 }),
  ])).toThrow();
});

test("revision keys include sequence, predecessor presence, subject, and content", () => {
  const first = baseRevision();
  const key = trackedRevisionAssetKey(first);
  expect(key).toMatch(/^revision-v1-[0-9a-f]{64}$/u);
  expect(trackedRevisionAssetKey(first)).toBe(key);
  expect(trackedRevisionAssetKey(baseRevision({ sequence: 2 }))).not.toBe(key);
  expect(trackedRevisionAssetKey(baseRevision({
    previousAssetKey: first.subjectAssetKey,
  }))).not.toBe(key);
  expect(trackedRevisionAssetKey(baseRevision({
    subjectAssetKey: `variant-v1-${"3".repeat(64)}`,
  }))).not.toBe(key);
  expect(trackedRevisionAssetKey(baseRevision({
    content: { profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE, sha256: "4".repeat(64) },
  }))).not.toBe(key);
});

test("revision leaves round-trip only canonical positive safe sequences", () => {
  const key = trackedRevisionAssetKey(baseRevision());
  const leaf = revisionItemLeaf(42, key);
  expect(leaf).toBe(`0000000000000042-${key}`);
  expect(parseRevisionItemLeaf(leaf)).toEqual({ sequence: 42, assetKey: key });
  for (const invalid of [
    `42-${key}`,
    `0000000000000000-${key}`,
    `9007199254740992-${key}`,
    `0000000000000042-source-v1-${"1".repeat(64)}`,
    `0000000000000042-${key}/other`,
  ]) expect(parseRevisionItemLeaf(invalid)).toBeNull();
});
