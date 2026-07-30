import { AsyncLocalStorage } from "node:async_hooks";

import type { ProcessOwnerIdentity } from "./process-identity";

export type PortableProviderPluginCleanupContainment = {
  readonly hostStarting: (host: ProcessOwnerIdentity) => void;
  readonly hostStarted: (host: ProcessOwnerIdentity) => void;
  readonly cleanupUnsafe: (cause?: unknown) => void;
};

type CleanupBarrierScope = {
  readonly barriers: Promise<void>[];
  readonly containment?: PortableProviderPluginCleanupContainment;
  accepting: boolean;
};

export type PortableProviderPluginCleanupBarrier = {
  readonly settled: boolean;
  readonly verified: () => void;
  readonly unsafe: (cause?: unknown) => void;
};

export type PortableProviderPluginOperationOutcome<T> =
  | {
      readonly status: "fulfilled";
      readonly value: T;
    }
  | {
      readonly status: "rejected";
      readonly reason: unknown;
    };

/**
 * Cleanup safety is intentionally separate from the provider result. A
 * provider failure can be safely quiescent; an unverified cleanup cannot.
 */
export class PortableProviderPluginCleanupUnverifiedError extends Error {
  constructor(cause?: unknown) {
    super(
      "portable provider plugin cleanup could not be verified; its invocation lease was preserved",
      cause === undefined ? undefined : { cause },
    );
    this.name = "PortableProviderPluginCleanupUnverifiedError";
  }
}

const cleanupBarrierStorage = new AsyncLocalStorage<CleanupBarrierScope>();

/**
 * Register cleanup work in the current exact invocation-lease scope. The
 * handle is still useful outside a scope, but no global state is retained.
 */
export function registerPortableProviderPluginCleanupBarrier():
  PortableProviderPluginCleanupBarrier {
  const scope = cleanupBarrierStorage.getStore();
  if (scope?.accepting === false) {
    throw new Error(
      "portable provider plugin cleanup registration began after its operation scope closed",
    );
  }
  let settled = false;
  let resolveBarrier: (() => void) | undefined;
  let rejectBarrier: ((cause: unknown) => void) | undefined;
  if (scope !== undefined) {
    const barrier = new Promise<void>((resolve, reject) => {
      resolveBarrier = resolve;
      rejectBarrier = reject;
    });
    // Cleanup may fail before the lease owner reaches its join gate. Observe
    // the rejection immediately while retaining the original promise for the
    // fail-closed allSettled join.
    void barrier.catch(() => undefined);
    scope.barriers.push(barrier);
  }
  const handle: PortableProviderPluginCleanupBarrier = {
    get settled() {
      return settled;
    },
    verified: () => {
      if (settled) return;
      settled = true;
      resolveBarrier?.();
    },
    unsafe: (cause?: unknown) => {
      if (settled) return;
      settled = true;
      let unsafeCause: unknown = cause ?? new Error(
        "portable provider plugin cleanup was not verified",
      );
      try {
        scope?.containment?.cleanupUnsafe(unsafeCause);
      } catch (error) {
        unsafeCause = error;
      }
      rejectBarrier?.(unsafeCause);
    },
  };
  return Object.freeze(handle);
}

/**
 * Announce the exact admission-gated host before portable code is allowed to
 * execute. A lease-backed scope persists this identity synchronously.
 */
export function announcePortableProviderPluginHostStarting(
  host: ProcessOwnerIdentity,
): void {
  cleanupBarrierStorage.getStore()?.containment?.hostStarting(host);
}

/**
 * Announce that the already-bound host crossed its admission gate.
 */
export function announcePortableProviderPluginHostStarted(
  host: ProcessOwnerIdentity,
): void {
  cleanupBarrierStorage.getStore()?.containment?.hostStarted(host);
}

/**
 * Keep a host promise in the lease scope even when an outer operation
 * deadline has already returned a terminal outcome. A real host separately
 * reports whether its cleanup was safe; a test or alternate host's settled
 * promise is its cleanup boundary.
 */
export function trackPortableProviderPluginHostCompletion<T>(
  host: Promise<T>,
): Promise<T> {
  const barrier = registerPortableProviderPluginCleanupBarrier();
  void host.then(
    () => barrier.verified(),
    () => barrier.verified(),
  );
  return host;
}

async function awaitCleanupBarriers(
  scope: CleanupBarrierScope,
): Promise<void> {
  const failures: unknown[] = [];
  let joined = 0;
  for (;;) {
    const pending = scope.barriers.slice(joined);
    joined = scope.barriers.length;
    if (pending.length > 0) {
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      continue;
    }
    // Give descendants resumed by the last barrier one microtask to register
    // their own narrower cleanup boundary before declaring quiescence.
    await Promise.resolve();
    if (joined === scope.barriers.length) break;
  }
  if (failures.length > 0) {
    throw new PortableProviderPluginCleanupUnverifiedError(failures[0]);
  }
}

/**
 * Settle an operation independently from its cleanup join. Callers may publish
 * an ordinary provider failure, but may release the exact durable lease only
 * after this function returns an outcome.
 */
export async function settlePortableProviderPluginCleanup<T>(
  operation: () => Promise<T>,
  options: {
    readonly containment?: PortableProviderPluginCleanupContainment;
    /**
     * Persist the outer lease owner's cleanup-complete transition only after
     * every barrier in this exact scope has joined successfully.
     */
    readonly cleanupComplete?: () => void;
  } = {},
): Promise<PortableProviderPluginOperationOutcome<T>> {
  const parentScope = cleanupBarrierStorage.getStore();
  const parentJoin = parentScope === undefined
    ? undefined
    : registerPortableProviderPluginCleanupBarrier();
  const containment = options.containment ?? parentScope?.containment;
  const scope: CleanupBarrierScope = {
    barriers: [],
    accepting: true,
    ...(containment === undefined ? {} : { containment }),
  };
  try {
    const outcome = await cleanupBarrierStorage.run(
      scope,
      async (): Promise<PortableProviderPluginOperationOutcome<T>> => {
        try {
          return Object.freeze({
            status: "fulfilled" as const,
            value: await operation(),
          });
        } catch (reason) {
          return Object.freeze({
            status: "rejected" as const,
            reason,
          });
        }
      },
    );
    // Resource owners must register their barrier before starting the
    // resource. Once the operation settles, descendants may finish already
    // registered cleanup but cannot introduce a late unjoined boundary.
    scope.accepting = false;
    await awaitCleanupBarriers(scope);
    options.cleanupComplete?.();
    parentJoin?.verified();
    return outcome;
  } catch (error) {
    scope.accepting = false;
    parentJoin?.unsafe(error);
    throw error;
  }
}
