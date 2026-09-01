import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  createApplePhotosContactEvidenceExportResult,
  encodeApplePhotosContactEvidenceExportResult,
  parseApplePhotosContactEvidenceArtifact,
  parseApplePhotosContactEvidenceExportResult,
} from "./apple-photos-contact-evidence";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const FIXED_TIME = "2026-08-28T12:34:56.000Z";
const FIXED_RUN = "123e4567-e89b-42d3-a456-426614174000";

function result() {
  return createApplePhotosContactEvidenceExportResult({
    runId: FIXED_RUN,
    startedAt: FIXED_TIME,
    finishedAt: FIXED_TIME,
    observedAt: FIXED_TIME,
    contactsDatabases: 2,
    generationSha256: DIGEST_A,
    photosSchemaSha256: DIGEST_B,
    contactsSchemaSha256: DIGEST_C,
    evidence: [
      {
        photosPersonId: "22222222-2222-4222-8222-222222222222",
        appleContactId: "contact-b:ABPerson",
        linkedFaceCount: 3,
        linkedAssetCount: 2,
        firstAssetAt: "2001-01-01T00:00:00.000Z",
        lastAssetAt: "2001-01-02T00:00:00.000Z",
      },
      {
        photosPersonId: "11111111-1111-4111-8111-111111111111",
        appleContactId: "contact-a:ABPerson",
        linkedFaceCount: 1,
        linkedAssetCount: 1,
        firstAssetAt: null,
        lastAssetAt: null,
      },
    ],
  });
}

describe("Apple Photos contact evidence artifact", () => {
  test("sorts exact relationships and binds artifact and receipt digests", () => {
    const value = result();
    expect(value.output.evidence.map((row) => row.appleContactId)).toEqual([
      "contact-a:ABPerson",
      "contact-b:ABPerson",
    ]);
    expect(value.output.counts).toEqual({
      matchedPeople: 2,
      uniqueContacts: 2,
      linkedFaces: 4,
      linkedAssets: 3,
    });
    expect(value.receipt.output.artifactSha256).toBe(
      value.output.integrity.artifactSha256,
    );
    expect(parseApplePhotosContactEvidenceExportResult(
      JSON.parse(encodeApplePhotosContactEvidenceExportResult(value)),
    )).toEqual(value);
    expect(parseApplePhotosContactEvidenceArtifact(
      JSON.parse(JSON.stringify(value.output)),
    )).toEqual(value.output);
  });

  test("rejects privacy drift, extra fields, reordering, and changed counts", () => {
    const value = JSON.parse(JSON.stringify(result())) as Record<string, any>;
    const candidates = [
      { ...value, secret: "no" },
      {
        ...value,
        output: {
          ...value.output,
          privacy: { ...value.output.privacy, names: "included" },
        },
      },
      {
        ...value,
        output: {
          ...value.output,
          evidence: [...value.output.evidence].reverse(),
        },
      },
      {
        ...value,
        output: {
          ...value.output,
          counts: { ...value.output.counts, linkedFaces: 999 },
        },
      },
    ];
    for (const candidate of candidates) {
      expect(() => parseApplePhotosContactEvidenceExportResult(candidate)).toThrow();
    }
  });

  test("strict parser rejects arbitrary one-field mutations", () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
      (foreign) => {
        const value = JSON.parse(JSON.stringify(result())) as Record<string, any>;
        value.output.evidence[0].photosPersonId = foreign;
        expect(() => parseApplePhotosContactEvidenceExportResult(value)).toThrow();
      },
    ), { numRuns: 100 });
  });

  test("is byte-idempotent for the same exact snapshot evidence", () => {
    expect(encodeApplePhotosContactEvidenceExportResult(result())).toBe(
      encodeApplePhotosContactEvidenceExportResult(result()),
    );
  });
});
