/** Self-contained DTO types for the side-effect-free Apple Photos client. */

export type ApplePhotosContactEvidence = Readonly<{
  photosPersonId: string;
  appleContactId: string;
  linkedFaceCount: number;
  linkedAssetCount: number;
  firstAssetAt: string | null;
  lastAssetAt: string | null;
}>;

export type ApplePhotosContactEvidenceCompleteness = Readonly<{
  kind: "complete-local-snapshot";
  localPhotos: "complete";
  localContacts: "all-discovered-address-book-stores";
  remoteSync: "not-asserted";
  unmatchedPeople: "excluded";
  reason: string;
}>;

export type ApplePhotosContactEvidencePrivacy = Readonly<{
  names: "excluded";
  localPaths: "excluded";
  images: "excluded";
  media: "excluded";
  locations: "excluded";
  rawContactData: "excluded";
  rawPhotosData: "excluded";
  faceprints: "excluded";
  faceCrops: "excluded";
  unmatchedPeople: "excluded";
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
    generationSha256: string;
    photosSchemaSha256: string;
    contactsSchemaSha256: string;
  }>;
  observedAt: string;
  scope: Readonly<{
    people: "exact-zpersonuri-zuniqueid-matches-only";
    faces: "all-detected-face-links-in-local-snapshot";
    assets: "distinct-assets-linked-through-detected-faces";
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
  transport: "local-sqlite-snapshot";
  implementation: Readonly<{
    producer: Readonly<{
      package: "@hraness/wrench";
      version: "0.16.2";
    }>;
    source: Readonly<{
      id: "apple-photos-local";
      version: "1.0.0";
    }>;
  }>;
  startedAt: string;
  finishedAt: string;
  bounds: Readonly<{
    snapshotAttempts: 3;
    maximumPhotosDatabaseBytes: number;
    maximumContactsDatabases: number;
    maximumContactsDatabaseBytes: number;
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
