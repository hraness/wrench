import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  MAX_REVISION_SEQUENCE,
  WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
  WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
  parseRevisionItemLeaf,
  revisionContentSha256,
  revisionItemLeaf,
  trackedRevisionAssetKey,
  type RevisionArtifactInput,
} from "./revision";

const sha256Arbitrary = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
  (bytes) => Buffer.from(bytes).toString("hex"),
);

const retainedArtifactArbitrary = fc.record({
  role: fc.constantFrom(
    "capture" as const,
    "provider_metadata" as const,
    "description" as const,
    "thumbnail" as const,
    "transcript_vtt" as const,
    "transcript_text" as const,
    "transcript_json" as const,
  ),
  bytes: fc.integer({ min: 0, max: 1_000_000 }),
  sha256: sha256Arbitrary,
  mediaType: fc.constantFrom("application/json", "application/octet-stream", "text/vtt", "video/mp4"),
});

test("property: retained-input fingerprints are permutation-invariant", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(retainedArtifactArbitrary, {
        minLength: 1,
        maxLength: 7,
        selector: (value) => value.role,
      }),
      (artifacts) => {
        expect(revisionContentSha256(artifacts)).toBe(
          revisionContentSha256(artifacts.toReversed()),
        );
      },
    ),
    { numRuns: 300 },
  );
});

test("property: every canonical revision leaf round-trips", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: MAX_REVISION_SEQUENCE }),
      sha256Arbitrary,
      sha256Arbitrary,
      fc.option(sha256Arbitrary, { nil: undefined }),
      (sequence, subjectDigest, contentDigest, predecessorDigest) => {
        const subjectAssetKey = `source-v3-${subjectDigest}`;
        const previousAssetKey = predecessorDigest === undefined
          ? undefined
          : `revision-v1-${predecessorDigest}`;
        const revision = {
          profile: WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
          sequence,
          subjectAssetKey,
          ...(previousAssetKey === undefined ? {} : { previousAssetKey }),
          content: {
            profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
            sha256: contentDigest,
          },
        } as const;
        const assetKey = trackedRevisionAssetKey(revision);
        expect(parseRevisionItemLeaf(revisionItemLeaf(sequence, assetKey))).toEqual({
          sequence,
          assetKey,
        });
      },
    ),
    { numRuns: 300 },
  );
});

test("property: changing one retained record changes the fingerprint", () => {
  fc.assert(
    fc.property(
      retainedArtifactArbitrary,
      sha256Arbitrary,
      (input, differentDigest) => {
        fc.pre(input.sha256 !== differentDigest);
        const changed: RevisionArtifactInput = { ...input, sha256: differentDigest };
        expect(revisionContentSha256([input])).not.toBe(revisionContentSha256([changed]));
      },
    ),
    { numRuns: 300 },
  );
});

test("property: every tracked chronology component participates in its key", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: MAX_REVISION_SEQUENCE - 1 }),
      sha256Arbitrary,
      sha256Arbitrary,
      sha256Arbitrary,
      sha256Arbitrary,
      sha256Arbitrary,
      (sequence, subject, otherSubject, content, otherContent, predecessor) => {
        fc.pre(subject !== otherSubject);
        fc.pre(content !== otherContent);
        const base = {
          profile: WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
          sequence,
          subjectAssetKey: `source-v3-${subject}`,
          content: {
            profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
            sha256: content,
          },
        } as const;
        const keys = [
          trackedRevisionAssetKey(base),
          trackedRevisionAssetKey({ ...base, sequence: sequence + 1 }),
          trackedRevisionAssetKey({ ...base, subjectAssetKey: `source-v3-${otherSubject}` }),
          trackedRevisionAssetKey({
            ...base,
            content: { profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE, sha256: otherContent },
          }),
          trackedRevisionAssetKey({
            ...base,
            previousAssetKey: `revision-v1-${predecessor}`,
          }),
        ];
        expect(new Set(keys).size).toBe(keys.length);
      },
    ),
    { numRuns: 300 },
  );
});

test("property: arbitrary leaf strings never throw", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      expect(() => parseRevisionItemLeaf(value)).not.toThrow();
    }),
    { numRuns: 300 },
  );
});
