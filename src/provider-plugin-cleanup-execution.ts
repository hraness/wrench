import type { ProviderPluginCleanupResourceIdentity } from "./provider-plugin-cleanup-resource";

export type ProviderPluginCleanupResourcePublisher = (
  resource: ProviderPluginCleanupResourceIdentity,
) => void;

export type ProviderPluginCleanupBarrierRegistrar = (
  barrier: Promise<void>,
) => ProviderPluginCleanupResourcePublisher | void;

export type ProviderPluginCleanupProofController = {
  /** Call only after every published process/resource is exactly quiescent. */
  readonly verified: () => void;
  /** Preserve durable admission when exact cleanup cannot be proved. */
  readonly unsafe: (reason: unknown) => void;
};

/**
 * Register cleanup before starting resource-owning asynchronous work. If the
 * durable registrar has closed, `start` is never called.
 */
export function startProviderPluginCleanupTrackedOperation<T>(
  register: ProviderPluginCleanupBarrierRegistrar | undefined,
  start: (
    publishCleanupResource: ProviderPluginCleanupResourcePublisher | undefined,
    cleanup: ProviderPluginCleanupProofController,
  ) => Promise<T>,
): Promise<T> {
  if (register === undefined) {
    return start(undefined, Object.freeze({
      verified: () => undefined,
      unsafe: () => undefined,
    }));
  }
  let resolveCleanup: (() => void) | undefined;
  let rejectCleanup: ((reason: unknown) => void) | undefined;
  let settled = false;
  const cleanupBarrier = new Promise<void>((resolve, reject) => {
    resolveCleanup = resolve;
    rejectCleanup = reject;
  });
  // Prevent a rejection from becoming process-global before the outer cleanup
  // join observes the registered barrier.
  void cleanupBarrier.catch(() => undefined);
  const publishCleanupResource = register(cleanupBarrier);
  const cleanup: ProviderPluginCleanupProofController = Object.freeze({
    verified: () => {
      if (settled) return;
      settled = true;
      resolveCleanup?.();
    },
    unsafe: (reason) => {
      if (settled) return;
      settled = true;
      rejectCleanup?.(
        reason instanceof Error
          ? reason
          : new Error("provider cleanup could not be verified"),
      );
    },
  });
  try {
    return Promise.resolve(start(
      typeof publishCleanupResource === "function"
        ? publishCleanupResource
        : undefined,
      cleanup,
    )).catch((error: unknown) => {
      // A runtime that rejects before it can prove cleanup must never leave an
      // indefinitely pending barrier or accidentally release durable admission.
      // If cleanup was already verified, the settled guard preserves that proof.
      cleanup.unsafe(error);
      throw error;
    });
  } catch (error) {
    cleanup.unsafe(error);
    throw error;
  }
}
