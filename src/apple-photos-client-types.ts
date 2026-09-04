/** Self-contained DTO types for the side-effect-free Apple Photos client. */

import type { WRENCH_VERSION } from "./version";

export type ApplePhotosContactEvidence = Readonly<{
  photosPersonId: string;
  appleContactId: string;
  linkedFaceCount: number;
  /** Count of distinct ZASSET rows linked through the detected faces. */
  linkedAssetCount: number;
  firstAssetAt: string | null;
  lastAssetAt: string | null;
}>;

export type ApplePhotosDatabaseCaptureInterval = Readonly<{
  startedAt: string;
  finishedAt: string;
}>;

export type ApplePhotosContactsDatabaseCaptureInterval = Readonly<{
  ordinal: number;
  startedAt: string;
  finishedAt: string;
}>;

export type ApplePhotosContactEvidenceCapture = Readonly<{
  startedAt: string;
  finishedAt: string;
  photos: ApplePhotosDatabaseCaptureInterval;
  contacts: readonly ApplePhotosContactsDatabaseCaptureInterval[];
  consistency: "independent-read-transactions";
  crossDatabaseAtomicity: "not-asserted";
}>;

export type ApplePhotosContactEvidenceCompleteness = Readonly<{
  kind: "bounded-local-observation";
  localPhotos: "one-reviewed-library-database-capture";
  localContacts: "ordered-discovered-address-book-database-captures";
  crossDatabaseAtomicity: "not-asserted";
  remoteSync: "not-asserted";
  unmatchedPeople: "excluded";
  reason: string;
}>;

export type ApplePhotosContactEvidencePrivacy = Readonly<{
  names: "excluded-from-returned-json";
  localPaths: "excluded-from-returned-json";
  images: "excluded-from-returned-json";
  media: "excluded-from-returned-json";
  locations: "excluded-from-returned-json";
  rawContactData: "excluded-from-returned-json";
  rawPhotosData: "excluded-from-returned-json";
  faceClusterIdentifiers: "included-biometric-derived-private-metadata";
  faceClusterCounts: "included-biometric-derived-private-metadata";
  faceprintTemplates: "excluded-from-returned-json";
  faceCrops: "excluded-from-returned-json";
  unmatchedPeople: "excluded-from-returned-json";
}>;

export type ApplePhotosContactEvidenceArtifact = Readonly<{
  schemaVersion: 1;
  format: "wrench.apple-photos-contact-evidence";
  transform: Readonly<{
    id: "apple-photos-person-contact-evidence";
    version: 1;
  }>;
  source: Readonly<{
    id: "apple-photos-local";
    version: "1.0.0";
    platform: "darwin";
    libraryRealmSha256: string;
    generationSha256: string;
    photosSchemaSha256: string;
    contactsSchemaSha256: string;
    capture: ApplePhotosContactEvidenceCapture;
  }>;
  observedAt: string;
  scope: Readonly<{
    people: "exact-zpersonuri-zuniqueid-matches-only";
    faces: "detected-face-links-present-in-photos-capture";
    assets: "distinct-zasset-rows-linked-through-detected-faces";
  }>;
  completeness: ApplePhotosContactEvidenceCompleteness;
  privacy: ApplePhotosContactEvidencePrivacy;
  counts: Readonly<{
    matchedPeople: number;
    uniqueContacts: number;
    linkedFaces: number;
    linkedAssets: number;
  }>;
  evidence: readonly ApplePhotosContactEvidence[];
  integrity: Readonly<{
    algorithm: "sha256";
    artifactSha256: string;
  }>;
}>;

export type ApplePhotosContactEvidenceExportReceipt = Readonly<{
  schemaVersion: 1;
  format: "wrench.apple-photos-contact-evidence-export-receipt";
  runId: string;
  operation: "apple-photos.export-contact-evidence";
  status: "succeeded";
  transport: "local-sqlite-vacuum-capture";
  implementation: Readonly<{
    producer: Readonly<{
      package: "@hraness/wrench";
      version: typeof WRENCH_VERSION;
    }>;
    source: Readonly<{
      id: "apple-photos-local";
      version: "1.0.0";
    }>;
  }>;
  startedAt: string;
  finishedAt: string;
  bounds: Readonly<{
    captureAttemptsPerDatabase: 1;
    maximumPhotosDatabaseBytes: number;
    maximumContactsDatabases: number;
    maximumContactsDatabaseBytes: number;
    maximumDirectoryEntries: number;
    maximumContactsSourceDirectories: number;
    maximumPeople: number;
    maximumContacts: number;
  }>;
  source: ApplePhotosContactEvidenceArtifact["source"];
  completeness: ApplePhotosContactEvidenceCompleteness;
  counts: ApplePhotosContactEvidenceArtifact["counts"] & Readonly<{
    contactsDatabases: number;
  }>;
  output: Readonly<{
    schemaVersion: 1;
    format: "wrench.apple-photos-contact-evidence";
    artifactSha256: string;
  }>;
  privacy: ApplePhotosContactEvidencePrivacy;
  integrity: Readonly<{
    algorithm: "sha256";
    receiptSha256: string;
  }>;
}>;

export type ApplePhotosContactEvidenceExportResult = Readonly<{
  receipt: ApplePhotosContactEvidenceExportReceipt;
  output: ApplePhotosContactEvidenceArtifact;
}>;

export type ApplePhotosContactEvidenceClientRequest = Readonly<{
  library?: string;
}>;

export type ApplePhotosContactEvidenceClientOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
}>;

export declare function exportApplePhotosContactEvidenceSync(
  request?: ApplePhotosContactEvidenceClientRequest,
  options?: ApplePhotosContactEvidenceClientOptions,
): ApplePhotosContactEvidenceExportResult;

export declare function parseApplePhotosContactEvidenceArtifact(
  value: unknown,
): ApplePhotosContactEvidenceArtifact;

export declare function parseApplePhotosContactEvidenceExportResult(
  value: unknown,
): ApplePhotosContactEvidenceExportResult;
