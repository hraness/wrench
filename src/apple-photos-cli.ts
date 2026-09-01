import {
  encodeApplePhotosContactEvidenceExportResult,
} from "./apple-photos-contact-evidence";
import type {
  ApplePhotosContactEvidenceExportResult,
} from "./apple-photos-client-types";
import {
  exportApplePhotosContactEvidence,
  type ApplePhotosLocalSourceRequest,
} from "./apple-photos-local-source";

export type ApplePhotosContactEvidenceCliRequest = Readonly<{
  library?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}>;

export async function exportApplePhotosContactEvidenceForCli(
  request: ApplePhotosContactEvidenceCliRequest = {},
): Promise<ApplePhotosContactEvidenceExportResult> {
  const sourceRequest: ApplePhotosLocalSourceRequest = {
    ...(request.library === undefined ? {} : { library: request.library }),
    ...(request.environment === undefined
      ? {}
      : { environment: request.environment }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
  return exportApplePhotosContactEvidence(sourceRequest);
}

export { encodeApplePhotosContactEvidenceExportResult };
