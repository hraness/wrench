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
const DIGEST_D = "d".repeat(64);
const FIXED_TIME = "2026-08-28T12:34:56.000Z";
const FIXED_RUN = "123e4567-e89b-42d3-a456-426614174000";

function result() {
  return createApplePhotosContactEvidenceExportResult({
    runId: FIXED_RUN,
    startedAt: FIXED_TIME,
    finishedAt: FIXED_TIME,
    observedAt: FIXED_TIME,
    contactsDatabases: 2,
    libraryRealmSha256: DIGEST_D,
    generationSha256: DIGEST_A,
    photosSchemaSha256: DIGEST_B,
    contactsSchemaSha256: DIGEST_C,
    capture: {
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME,
      photos: { startedAt: FIXED_TIME, finishedAt: FIXED_TIME },
      contacts: [
        { ordinal: 0, startedAt: FIXED_TIME, finishedAt: FIXED_TIME },
        { ordinal: 1, startedAt: FIXED_TIME, finishedAt: FIXED_TIME },
      ],
      consistency: "independent-read-transactions",
      crossDatabaseAtomicity: "not-asserted",
    },
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

  test("enforces evidence count/date laws and ordered capture intervals", () => {
    const base = result();
    for (const evidence of [
      {
        ...base.output.evidence[0]!,
        linkedFaceCount: 1,
        linkedAssetCount: 2,
      },
      {
        ...base.output.evidence[0]!,
        linkedFaceCount: 0,
        linkedAssetCount: 0,
        firstAssetAt: FIXED_TIME,
        lastAssetAt: FIXED_TIME,
      },
      {
        ...base.output.evidence[0]!,
        firstAssetAt: FIXED_TIME,
        lastAssetAt: null,
      },
      {
        ...base.output.evidence[0]!,
        firstAssetAt: "2026-08-28T12:34:57.000Z",
        lastAssetAt: FIXED_TIME,
      },
    ]) {
      const foreign = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      foreign.output.evidence[0] = evidence;
      expect(() => parseApplePhotosContactEvidenceExportResult(foreign)).toThrow();
    }

    const reversed = JSON.parse(JSON.stringify(base)) as Record<string, any>;
    reversed.output.source.capture.contacts[1].startedAt =
      "2026-08-28T12:34:55.000Z";
    expect(() => parseApplePhotosContactEvidenceExportResult(reversed)).toThrow(
      "outside capture order",
    );

    const observedOutside = JSON.parse(JSON.stringify(base)) as Record<string, any>;
    observedOutside.output.observedAt = "2026-08-28T12:34:57.000Z";
    expect(() => parseApplePhotosContactEvidenceExportResult(observedOutside)).toThrow(
      "inside the enclosing capture interval",
    );

    const receiptOutside = JSON.parse(JSON.stringify(base)) as Record<string, any>;
    receiptOutside.receipt.startedAt = "2026-08-28T12:34:57.000Z";
    receiptOutside.receipt.finishedAt = "2026-08-28T12:34:58.000Z";
    expect(() => parseApplePhotosContactEvidenceExportResult(receiptOutside)).toThrow(
      "database capture must be inside the receipt interval",
    );
  });

  test("rejects proxy, accessor, sparse, named, and symbol evidence arrays", () => {
    const candidates: unknown[] = [];
    const ordinary = result().output.evidence;
    candidates.push(new Proxy([...ordinary], {}));
    candidates.push(Object.defineProperty([...ordinary], "0", {
      enumerable: true,
      get: () => ordinary[0],
    }));
    const sparse = new Array(ordinary.length + 1);
    sparse[0] = ordinary[0];
    candidates.push(sparse);
    candidates.push(Object.assign([...ordinary], { note: "foreign" }));
    const symbolic = [...ordinary];
    Object.defineProperty(symbolic, Symbol("foreign"), { value: true });
    candidates.push(symbolic);

    for (const evidence of candidates) {
      const foreign = JSON.parse(JSON.stringify(result())) as Record<string, any>;
      foreign.output.evidence = evidence;
      expect(() => parseApplePhotosContactEvidenceArtifact(foreign.output)).toThrow();
    }

    const contactIntervals = [...result().output.source.capture.contacts];
    for (const contacts of [
      new Proxy(contactIntervals, {}),
      Object.assign([...contactIntervals], { note: "foreign" }),
    ]) {
      const foreign = JSON.parse(JSON.stringify(result())) as Record<string, any>;
      foreign.output.source.capture.contacts = contacts;
      expect(() => parseApplePhotosContactEvidenceArtifact(foreign.output)).toThrow();
    }
  });

  test("is byte-idempotent for the same exact snapshot evidence", () => {
    expect(encodeApplePhotosContactEvidenceExportResult(result())).toBe(
      encodeApplePhotosContactEvidenceExportResult(result()),
    );
  });
});
