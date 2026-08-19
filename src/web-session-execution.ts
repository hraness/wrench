import type { WrenchAuth } from "./auth";
import type {
  BrowserCleanupResourceIdentity,
  BrowserFileResolver,
} from "./browser";
import type {
  WrenchManifest,
  OperationInput,
  WebSessionRecipe,
} from "./model";
import type { ProviderAcceptedMutationTarget } from "./recovery";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "./operation-deadline";
import type { WebSessionPluginOperationV1 } from "./provider-plugin";

const WEB_SESSION_OPERATION_LABEL = "authenticated web operation deadline";
export const WEB_SESSION_CLEANUP_JOIN_TIMEOUT_MS = 30_000;

export class WebSessionCleanupUnverifiedError extends Error {
  constructor(cause?: unknown) {
    super(
      "authenticated web cleanup could not be verified within its bounded join; retry is unsafe until wrench doctor proves exact browser-closed cleanup evidence, or a reboot proves the admitted resource cannot still be running",
      cause === undefined ? undefined : { cause },
    );
    this.name = "WebSessionCleanupUnverifiedError";
  }
}

export type WebSessionExecution = {
  readonly status: "succeeded" | "failed" | "partial" | "indeterminate";
  readonly output: unknown;
  readonly finalUrl: string | null;
  /**
   * A desired-state write was already satisfied by an independently bound
   * preflight, so no provider dispatch was started.
   */
  readonly noOp?: true;
  readonly dispatchStarted: boolean;
  readonly dispatch: {
    readonly planned: number;
    readonly started: number;
    readonly verified: number;
  };
  readonly error?: string;
};

export type WebSessionDispatchEvent = {
  readonly id: string;
  readonly index: number;
  readonly progress: WebSessionExecution["dispatch"];
};

export type WebSessionProviderAcceptedMutationTargetEvent = {
  readonly id: string;
  readonly index: number;
  readonly target: ProviderAcceptedMutationTarget;
};

export type WebSessionOperationDeadline = Pick<
  OperationDeadline,
  "signal" | "remainingTimeMs" | "run" | "throwIfUnavailable"
>;

export type WebSessionCleanupResourcePublisher = (
  resource: BrowserCleanupResourceIdentity,
) => void;

export type WebSessionCleanupBarrierRegistrar = (
  barrier: Promise<void>,
) => WebSessionCleanupResourcePublisher | void;

/**
 * Register cleanup before starting a resource-owning asynchronous operation.
 * If registration has closed, `start` is never called.
 */
export function startWebSessionCleanupTrackedOperation<T>(
  register: WebSessionCleanupBarrierRegistrar | undefined,
  start: (
    publishCleanupResource: WebSessionCleanupResourcePublisher | undefined,
  ) => Promise<T>,
  cleanupBoundary: (operation: Promise<T>) => Promise<void>,
): Promise<T> {
  if (register === undefined) return start(undefined);
  let begin: ((
    publishCleanupResource: WebSessionCleanupResourcePublisher | undefined,
  ) => void) | undefined;
  const operation = new Promise<T>((resolve, reject) => {
    begin = (publishCleanupResource) => {
      try {
        void start(publishCleanupResource).then(resolve, reject);
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error("authenticated web cleanup-tracked operation failed"),
        );
      }
    };
  });
  const registered = register(cleanupBoundary(operation));
  begin?.(
    typeof registered === "function"
      ? registered
      : undefined,
  );
  return operation;
}

export type WebSessionExecutionOptions = {
  readonly fileResolver?: BrowserFileResolver;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** Kernel-owned total budget shared by runtime loading and every provider step. */
  readonly operationDeadline?: WebSessionOperationDeadline;
  /** Internal deterministic-clock seam for an operation that owns its deadline. */
  readonly deadlineClock?: OperationDeadlineClock;
  /**
   * Kernel-owned post-abort join. Browser-backed runtimes register only their
   * bounded teardown proof, never arbitrary provider work.
   */
  readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
  readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
  /**
   * Persist the exact provider-owned target immediately after a strict
   * mutation response accepts the dispatch and before independent readback.
   * Implementations must never call this for an inferred or scraped target.
   */
  readonly afterProviderAcceptedMutationTarget?: (
    event: WebSessionProviderAcceptedMutationTargetEvent,
  ) => Promise<void>;
  readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
};

export type WebSessionOperationExecutor = (
  manifest: WrenchManifest,
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: WebSessionExecutionOptions,
) => Promise<WebSessionExecution>;

type TrackedWebSessionCleanupBarrier = {
  readonly promise: Promise<void>;
  readonly unsafe: (cause: unknown) => void;
  readonly verified: () => void;
};

function trackWebSessionCleanupBarrier(
  barrier: Promise<void>,
): TrackedWebSessionCleanupBarrier {
  let settled = false;
  let resolveTracked: (() => void) | undefined;
  let rejectTracked: ((cause: unknown) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveTracked = resolve;
    rejectTracked = reject;
  });
  // The barrier may fail before the operation reaches its join. Observe the
  // tracked rejection immediately while retaining it for the fail-closed join.
  void promise.catch(() => undefined);
  const verified = (): void => {
    if (settled) return;
    settled = true;
    resolveTracked?.();
  };
  const unsafe = (cause: unknown): void => {
    if (settled) return;
    settled = true;
    rejectTracked?.(cause);
  };
  void barrier.then(verified, unsafe);
  return Object.freeze({ promise, unsafe, verified });
}

async function awaitWebSessionCleanupBarriers(
  barriers: readonly TrackedWebSessionCleanupBarrier[],
  clock: OperationDeadlineClock | undefined,
): Promise<void> {
  if (barriers.length === 0) return;
  const failures: unknown[] = [];
  let joined = 0;
  const join = async (): Promise<void> => {
    for (;;) {
      const pending = barriers.slice(joined).map((barrier) => barrier.promise);
      joined = barriers.length;
      if (pending.length > 0) {
        const results = await Promise.allSettled(pending);
        for (const result of results) {
          if (result.status === "rejected") failures.push(result.reason);
        }
        continue;
      }
      await Promise.resolve();
      if (joined === barriers.length) break;
    }
    if (failures.length > 0) {
      const failure = failures[0];
      throw failure instanceof WebSessionCleanupUnverifiedError
        ? failure
        : new WebSessionCleanupUnverifiedError(failure);
    }
  };
  let cancelTimeout: (() => void) | undefined;
  let rejectForTimeout: ((error: Error) => void) | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    rejectForTimeout = reject;
  });
  const timeout = (): void => {
    const error = new WebSessionCleanupUnverifiedError();
    for (const barrier of barriers) barrier.unsafe(error);
    rejectForTimeout?.(error);
  };
  try {
    if (clock === undefined) {
      const timer = setTimeout(timeout, WEB_SESSION_CLEANUP_JOIN_TIMEOUT_MS);
      cancelTimeout = () => clearTimeout(timer);
    } else {
      cancelTimeout = clock.schedule(
        timeout,
        WEB_SESSION_CLEANUP_JOIN_TIMEOUT_MS,
      );
    }
  } catch (error) {
    const unverified = new WebSessionCleanupUnverifiedError(error);
    for (const barrier of barriers) barrier.unsafe(unverified);
    throw unverified;
  }
  try {
    await Promise.race([join(), timedOut]);
  } finally {
    cancelTimeout?.();
  }
}

/**
 * Bound the complete lazy web runtime hook, including module loading and any
 * work that does not cooperate with cancellation.
 */
export async function runWebSessionOperationWithDeadline<T>(
  recipe: WebSessionRecipe,
  options: WebSessionExecutionOptions,
  execute: (boundedOptions: WebSessionExecutionOptions) => Promise<T>,
): Promise<T> {
  const ownedDeadline = options.operationDeadline === undefined
    ? new OperationDeadline(recipe.timeoutMs, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.deadlineClock === undefined
          ? {}
          : { clock: options.deadlineClock }),
      })
    : null;
  const deadline = options.operationDeadline ?? ownedDeadline;
  if (deadline === null) {
    throw new Error("authenticated web operation deadline is unavailable");
  }
  const guardDispatch = (
    callback: ((event: WebSessionDispatchEvent) => Promise<void>) | undefined,
  ): ((event: WebSessionDispatchEvent) => Promise<void>) | undefined =>
    callback === undefined
      ? undefined
      : (event) => deadline.run(
          () => callback(event),
          WEB_SESSION_OPERATION_LABEL,
        );
  const beforeDispatch = guardDispatch(options.beforeDispatch);
  const afterProviderAcceptedMutationTarget =
    options.afterProviderAcceptedMutationTarget === undefined
      ? undefined
      : (event: WebSessionProviderAcceptedMutationTargetEvent) => deadline.run(
          () => options.afterProviderAcceptedMutationTarget!(event),
          WEB_SESSION_OPERATION_LABEL,
        );
  const afterDispatchVerified = guardDispatch(options.afterDispatchVerified);
  const cleanupBarriers: TrackedWebSessionCleanupBarrier[] = [];
  let acceptingCleanupBarriers = true;
  const registerCleanupBarrier: WebSessionCleanupBarrierRegistrar = (barrier) => {
    if (!acceptingCleanupBarriers) {
      throw new Error("authenticated web cleanup registration is already closed");
    }
    const tracked = trackWebSessionCleanupBarrier(barrier);
    try {
      const registered =
        options.registerCleanupBarrier?.(tracked.promise);
      cleanupBarriers.push(tracked);
      return typeof registered === "function" ? registered : undefined;
    } catch (error) {
      // Registration happens before its resource starts. If an outer registrar
      // retained the promise before throwing, settle it safely so that scope
      // does not wait forever for an operation that was never begun.
      tracked.verified();
      throw error;
    }
  };
  const fileResolver = options.fileResolver === undefined
    ? undefined
    : (files: Parameters<BrowserFileResolver>[0]) => deadline.run(
        () => options.fileResolver!(files),
        WEB_SESSION_OPERATION_LABEL,
      );
  const boundedOptions: WebSessionExecutionOptions = {
    ...(fileResolver === undefined ? {} : { fileResolver }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    signal: deadline.signal,
    operationDeadline: deadline,
    registerCleanupBarrier,
    ...(beforeDispatch === undefined ? {} : { beforeDispatch }),
    ...(afterProviderAcceptedMutationTarget === undefined
      ? {}
      : { afterProviderAcceptedMutationTarget }),
    ...(afterDispatchVerified === undefined ? {} : { afterDispatchVerified }),
  };
  let outcome:
    | { readonly status: "fulfilled"; readonly value: T }
    | { readonly status: "rejected"; readonly reason: unknown };
  try {
    try {
      outcome = {
        status: "fulfilled",
        value: await deadline.run(
          () => execute(boundedOptions),
          WEB_SESSION_OPERATION_LABEL,
        ),
      };
    } catch (reason) {
      outcome = { status: "rejected", reason };
    }
    acceptingCleanupBarriers = false;
    await awaitWebSessionCleanupBarriers(
      cleanupBarriers,
      options.deadlineClock,
    );
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  } finally {
    ownedDeadline?.dispose();
  }
}

export function requireValidWebSessionOperationInput(
  operation: Pick<WebSessionPluginOperationV1, "validateInput">,
  input: OperationInput,
): void {
  const inputIssues = operation.validateInput(input);
  if (inputIssues.length > 0) throw new Error(inputIssues.join("; "));
}
