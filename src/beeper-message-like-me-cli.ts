import type { WrenchAuth } from "./auth";
import {
  exportBeeperMessageLikeMeBundle,
  type BeeperMessageLikeMeExportResult,
} from "./beeper-message-like-me-export";
import {
  createBeeperMessageLikeMeSource,
  type BeeperMessageLikeMeSourceLimits,
} from "./beeper-message-like-me-source";

export type BeeperMessageLikeMeCliRequest = Readonly<{
  auth: WrenchAuth;
  outputRoot: string;
  limits?: BeeperMessageLikeMeSourceLimits;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}>;

/**
 * Narrow CLI composition for the trusted Beeper source and private bundle
 * sink. AI runtimes consume the resulting local bundle; this boundary never
 * sends its contents to a model or network service.
 */
export async function exportBeeperMessageLikeMeFromAuth(
  request: BeeperMessageLikeMeCliRequest,
): Promise<BeeperMessageLikeMeExportResult> {
  const source = createBeeperMessageLikeMeSource({
    auth: request.auth,
    ...(request.limits === undefined ? {} : { limits: request.limits }),
    ...(request.environment === undefined
      ? {}
      : { environment: request.environment }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  return exportBeeperMessageLikeMeBundle({
    outputRoot: request.outputRoot,
    source,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}
