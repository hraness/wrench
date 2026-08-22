import type { WrenchAuth } from "./auth";
import {
  exportBeeperMessageLikeMeBundle,
  type BeeperMessageLikeMeExportResult,
} from "./beeper-message-like-me-export";
import {
  createBeeperMessageLikeMeSource,
  type BeeperMessageLikeMeProgress,
  type BeeperMessageLikeMeSourceLimits,
} from "./beeper-message-like-me-source";
import {
  acquireBeeperMessageLikeMeExportAdmission,
  recoverBeeperMessageLikeMeDirectoryLeases,
  releaseBeeperMessageLikeMeExportAdmission,
} from "./beeper-message-like-me-recovery";

export type BeeperMessageLikeMeCliRequest = Readonly<{
  auth: WrenchAuth;
  outputRoot: string;
  limits?: BeeperMessageLikeMeSourceLimits;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  onProgress?: (progress: BeeperMessageLikeMeProgress) => void;
}>;

/**
 * Narrow CLI composition for the trusted Beeper source and private bundle
 * sink. AI runtimes consume the resulting local bundle; this boundary never
 * sends its contents to a model or network service.
 */
export async function exportBeeperMessageLikeMeFromAuth(
  request: BeeperMessageLikeMeCliRequest,
): Promise<BeeperMessageLikeMeExportResult> {
  try {
    const environment = request.environment ?? process.env;
    request.onProgress?.(Object.freeze({ phase: "recovery-started" }));
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
    try {
      const recovery = await recoverBeeperMessageLikeMeDirectoryLeases({
        environment,
      });
      if (recovery.active > 0 || recovery.indeterminate > 0) {
        throw new Error(
          "Beeper Message Like Me export: another export is active or prior private export recovery is indeterminate",
        );
      }
      request.onProgress?.(Object.freeze({
        phase: "recovery-completed",
        recovered: recovery.recovered,
        published: recovery.published,
      }));
      const source = createBeeperMessageLikeMeSource({
        auth: request.auth,
        ...(request.limits === undefined ? {} : { limits: request.limits }),
        ...(request.environment === undefined
          ? {}
          : { environment: request.environment }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined
          ? {}
          : { onProgress: request.onProgress }),
      });
      return await exportBeeperMessageLikeMeBundle({
        outputRoot: request.outputRoot,
        source,
        ...(request.onProgress === undefined
          ? {}
          : { onProgress: request.onProgress }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        recoveryEnvironment: environment,
      });
    } finally {
      releaseBeeperMessageLikeMeExportAdmission(admission);
    }
  } catch (error) {
    if (
      error instanceof Error
      && /^(?:Beeper |Message Like Me |pinned Beeper CLI )/u.test(error.message)
    ) throw error;
    throw new Error(
      "Beeper Message Like Me export: private local file operation failed",
    );
  }
}
