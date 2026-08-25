import { canonicalJson, sha256 } from "./canonical-json";
import { loadAuthSnapshotIfPresent } from "./auth";
import {
  createPortableProviderPluginCatalog,
} from "./provider-plugin-portable-catalog";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  ReadProjectionDurableRepairError,
  READ_PROJECTION_TRANSITION_SETTLEMENT_WAIT_MS,
  isReadProjectionCorruptionError,
  publishReadProjection,
  readReadProjection,
  repairReadProjection,
  removeReadProjection,
  projectionAuthIdentityHash,
  withSettledReadProjectionAuthAdmission,
  type ReadProjectionCacheResult,
  type ReadProjectionPublication,
  type ReadProjectionQuery,
  type ReadProjectionAdmissionSettlementOptions,
} from "./read-projections";
import {
  isPublicWebSessionInvocationAuthority,
  publicWebSessionAuthorityIdentityHash,
} from "./web-session-authentication-policy";
import {
  createReadProjectionQueryForInvocation,
  executeReadInvocation,
  prepareInvocation,
  type InvocationResult,
  type PreparedInvocation,
} from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;
const MAX_FRESH_FOR_MS = 365 * 24 * 60 * 60 * 1_000;

export type CapabilityReadRequest = {
  readonly adapterId: string;
  readonly operationId: string;
  readonly input?: unknown;
  readonly authId?: string;
};

export type ReadCapabilityOptions = {
  readonly environment?: Environment;
  readonly registry?: ProviderPluginRegistry;
  readonly freshForMs?: number;
  readonly now?: Date;
};

export type RevalidateCapabilityOptions = ReadCapabilityOptions & {
  readonly headed?: boolean;
  readonly signal?: AbortSignal;
};

export type ReadProjectionCacheOutcome =
  | {
      readonly status: "stored";
      readonly publication: ReadProjectionPublication;
    }
  | {
      readonly status: "retained";
      readonly reason: "live-read-failed";
    }
  | {
      readonly status: "miss";
      readonly reason: "no-cached-snapshot";
    }
  | {
      readonly status: "skipped";
      readonly reason: "auth-subject-unbound";
    }
  | {
      readonly status: "error";
      readonly message: string;
    };

export type RevalidatedCapability = {
  readonly cachedBefore: ReadProjectionCacheResult | null;
  readonly live: InvocationResult;
  readonly cache: ReadProjectionCacheOutcome;
};

type PreparedReadOptions = RevalidateCapabilityOptions & {
  readonly registry: ProviderPluginRegistry;
  readonly executeRead?: typeof executeReadInvocation;
};

function selectedRegistry(
  environment: Environment,
  registry: ProviderPluginRegistry | undefined,
): ProviderPluginRegistry {
  return registry
    ?? createPortableProviderPluginCatalog(
      providerPluginRegistry,
      environment,
    ).registry;
}

function prepareCapability(
  request: CapabilityReadRequest,
  environment: Environment,
  registry: ProviderPluginRegistry,
): PreparedInvocation {
  return prepareInvocation(
    request.adapterId,
    request.operationId,
    request.input === undefined ? {} : request.input,
    request.authId,
    environment,
    registry,
  );
}

function exactAuthHash(invocation: PreparedInvocation): string {
  return sha256(canonicalJson(invocation.auth));
}

function withInvocationAuthorityAdmission<T>(
  invocation: PreparedInvocation,
  environment: Environment,
  operation: () => T,
  options: ReadProjectionAdmissionSettlementOptions = {},
): T {
  return isPublicWebSessionInvocationAuthority(invocation.auth)
    ? operation()
    : withSettledReadProjectionAuthAdmission(
        invocation.auth.id,
        environment,
        operation,
        options,
      );
}

function liveReadDiscardedError(
  invocation: PreparedInvocation,
  cause?: unknown,
): Error {
  return new Error(
    `auth locator ${invocation.auth.id} changed while the live read was running; its result was discarded`,
    cause === undefined ? undefined : { cause },
  );
}

function isOptionalAdmissionRewrite(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("could not safely open optional read projection admission")
    && error.message.includes("state file changed while it was read");
}

type AuthRealmState = "matches" | "missing" | "changed";

function authRealmState(
  invocation: PreparedInvocation,
  query: ReadProjectionQuery | null,
  environment: Environment,
): AuthRealmState {
  if (isPublicWebSessionInvocationAuthority(invocation.auth)) {
    const expected = publicWebSessionAuthorityIdentityHash(invocation.auth);
    return invocation.readProjectionAuthIdentityHash === expected
      && (query === null || query.identity.auth.hash === expected)
      ? "matches"
      : "changed";
  }
  const snapshot = loadAuthSnapshotIfPresent(
    invocation.auth.id,
    environment,
  );
  if (snapshot === null) return "missing";
  const current = snapshot.auth;
  const currentHash = sha256(canonicalJson(current));
  const preparedAuthIdentityHash =
    invocation.readProjectionAuthIdentityHash;
  if (preparedAuthIdentityHash === undefined) {
    throw new Error(
      "prepared invocation is missing its auth lifetime identity; prepare it again",
    );
  }
  if (
    currentHash !== exactAuthHash(invocation)
    || current.subject !== invocation.auth.subject
  ) return "changed";
  const currentAuthIdentityHash = projectionAuthIdentityHash(
    current.id,
    currentHash,
    environment,
  );
  if (
    currentAuthIdentityHash !== preparedAuthIdentityHash
    || (
      query !== null
      && query.identity.auth.hash !== preparedAuthIdentityHash
    )
  ) return "changed";
  return "matches";
}

function requireCurrentAuthRealm(
  invocation: PreparedInvocation,
  query: ReadProjectionQuery | null,
  environment: Environment,
): void {
  if (authRealmState(invocation, query, environment) !== "matches") {
    throw new Error(
      `auth locator ${invocation.auth.id} changed since this invocation was prepared`,
    );
  }
}

function validateReadOptions(options: ReadCapabilityOptions): void {
  if (
    options.now !== undefined
    && (
      !(options.now instanceof Date)
      || !Number.isFinite(options.now.getTime())
    )
  ) throw new Error("read projection observation time is invalid");
  if (
    options.freshForMs !== undefined
    && (
      typeof options.freshForMs !== "number"
      || !Number.isSafeInteger(options.freshForMs)
      || options.freshForMs < 0
      || options.freshForMs > MAX_FRESH_FOR_MS
    )
  ) throw new Error("read projection freshness window is malformed");
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.byteLength(message, "utf8") <= 8 * 1024
    ? message
    : `${Buffer.from(message, "utf8").subarray(0, 8 * 1024).toString("utf8")}…`;
}

export function readCachedPreparedCapability(
  invocation: PreparedInvocation,
  options: ReadCapabilityOptions & { readonly registry: ProviderPluginRegistry },
): ReadProjectionCacheResult {
  const environment = options.environment ?? process.env;
  validateReadOptions(options);
  return withInvocationAuthorityAdmission(
    invocation,
    environment,
    () => {
      const query = createReadProjectionQueryForInvocation(
        invocation,
        environment,
        options.registry,
      );
      if (authRealmState(invocation, query, environment) !== "matches") {
        return Object.freeze({ status: "miss" as const, key: query.key });
      }
      const cached = readReadProjection(query, {
        environment,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.freshForMs === undefined
          ? {}
          : { freshForMs: options.freshForMs }),
      });
      if (authRealmState(invocation, query, environment) !== "matches") {
        return Object.freeze({ status: "miss" as const, key: query.key });
      }
      return cached;
    },
  );
}

export function readCachedCapability(
  request: CapabilityReadRequest,
  options: ReadCapabilityOptions = {},
): ReadProjectionCacheResult {
  const environment = options.environment ?? process.env;
  const registry = selectedRegistry(environment, options.registry);
  return readCachedPreparedCapability(
    prepareCapability(request, environment, registry),
    { ...options, environment, registry },
  );
}

export async function revalidatePreparedCapability(
  invocation: PreparedInvocation,
  options: PreparedReadOptions,
  cachedBeforeOverride?: ReadProjectionCacheResult | null,
): Promise<RevalidatedCapability> {
  const environment = options.environment ?? process.env;
  validateReadOptions(options);
  const query = withInvocationAuthorityAdmission(
    invocation,
    environment,
    () => {
      const prepared = invocation.auth.subject === undefined
        ? null
        : createReadProjectionQueryForInvocation(
            invocation,
            environment,
            options.registry,
          );
      requireCurrentAuthRealm(invocation, prepared, environment);
      return prepared;
    },
  );
  let cacheReadError: unknown = null;
  let cachedBefore: ReadProjectionCacheResult | null;
  try {
    cachedBefore = cachedBeforeOverride !== undefined
      ? cachedBeforeOverride
      : query === null
        ? null
        : readCachedPreparedCapability(invocation, {
            environment,
            registry: options.registry,
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.freshForMs === undefined
              ? {}
              : { freshForMs: options.freshForMs }),
          });
  } catch (error) {
    withInvocationAuthorityAdmission(
      invocation,
      environment,
      () => requireCurrentAuthRealm(invocation, query, environment),
    );
    cacheReadError = error;
    cachedBefore = null;
  }
  withInvocationAuthorityAdmission(
    invocation,
    environment,
    () => requireCurrentAuthRealm(invocation, query, environment),
  );
  const live = await (options.executeRead ?? executeReadInvocation)(
    invocation,
    {
      headed: options.headed ?? false,
      environment,
      registry: options.registry,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  try {
    return withInvocationAuthorityAdmission(
      invocation,
      environment,
      () => {
      if (authRealmState(invocation, query, environment) !== "matches") {
        throw liveReadDiscardedError(invocation);
      }
      if (query === null) {
        return Object.freeze({
          cachedBefore,
          live,
          cache: Object.freeze({
            status: "skipped" as const,
            reason: "auth-subject-unbound" as const,
          }),
        });
      }
      if (live.receipt.status !== "succeeded") {
        if (cacheReadError !== null) {
          return Object.freeze({
            cachedBefore,
            live,
            cache: Object.freeze({
              status: "error" as const,
              message: boundedErrorMessage(cacheReadError),
            }),
          });
        }
        if (cachedBefore?.status !== "hit") {
          return Object.freeze({
            cachedBefore,
            live,
            cache: Object.freeze({
              status: "miss" as const,
              reason: "no-cached-snapshot" as const,
            }),
          });
        }
        return Object.freeze({
          cachedBefore,
          live,
          cache: Object.freeze({
            status: "retained" as const,
            reason: "live-read-failed" as const,
          }),
        });
      }
      const publicationOptions = {
        environment,
        runId: live.receipt.runId,
        startedAt: live.receipt.startedAt,
        finishedAt: live.receipt.finishedAt,
      } as const;
      let publication: ReadProjectionPublication;
      try {
        if (isReadProjectionCorruptionError(cacheReadError)) {
          publication = repairReadProjection(
            query,
            live.output,
            {
              ...publicationOptions,
              corruption: cacheReadError,
              observedBeforeLive: true,
            },
          );
        } else {
          try {
            publication = publishReadProjection(
              query,
              live.output,
              publicationOptions,
            );
          } catch (error) {
            if (!isReadProjectionCorruptionError(error)) throw error;
            publication = repairReadProjection(
              query,
              live.output,
              {
                ...publicationOptions,
                corruption: error,
                observedBeforeLive: false,
              },
            );
          }
        }
      } catch (error) {
        if (
          error instanceof ReadProjectionDurableRepairError
          && error.queryKey === query.key
        ) {
          publication = error.publication;
        } else {
          return Object.freeze({
            cachedBefore,
            live,
            cache: Object.freeze({
              status: "error" as const,
              message: boundedErrorMessage(error),
            }),
          });
        }
      }
      if (authRealmState(invocation, query, environment) !== "matches") {
        removeReadProjection(query, environment);
        throw new Error(
          `auth locator ${invocation.auth.id} changed while the live read was being published; its result was discarded`,
        );
      }
      return Object.freeze({
        cachedBefore,
        live,
        cache: Object.freeze({
          status: "stored" as const,
          publication,
        }),
      });
    },
      { maximumWaitMs: READ_PROJECTION_TRANSITION_SETTLEMENT_WAIT_MS },
    );
  } catch (error) {
    if (isOptionalAdmissionRewrite(error)) {
      throw liveReadDiscardedError(invocation, error);
    }
    throw error;
  }
}

export async function revalidateCapability(
  request: CapabilityReadRequest,
  options: RevalidateCapabilityOptions = {},
): Promise<RevalidatedCapability> {
  const environment = options.environment ?? process.env;
  const registry = selectedRegistry(environment, options.registry);
  return revalidatePreparedCapability(
    prepareCapability(request, environment, registry),
    { ...options, environment, registry },
  );
}

/**
 * Return the current exact snapshot synchronously and start one explicit live
 * R1 revalidation. UI callers can render `cached` before awaiting
 * `revalidation`; Wrench never hides a transport refresh in a cache lookup.
 */
export function staleWhileRevalidateCapability(
  request: CapabilityReadRequest,
  options: RevalidateCapabilityOptions = {},
): {
  readonly cached: ReadProjectionCacheResult | null;
  readonly revalidation: Promise<RevalidatedCapability>;
} {
  const environment = options.environment ?? process.env;
  const registry = selectedRegistry(environment, options.registry);
  const invocation = prepareCapability(request, environment, registry);
  validateReadOptions(options);
  let cached: ReadProjectionCacheResult | null = null;
  let cacheReadCompleted = false;
  if (invocation.auth.subject !== undefined) {
    try {
      cached = readCachedPreparedCapability(invocation, {
        ...options,
        environment,
        registry,
      });
      cacheReadCompleted = true;
    } catch {
      // A corrupt or unavailable local projection must not prevent the live
      // R1 contract from running and reporting its independent outcome.
    }
  }
  return Object.freeze({
    cached,
    revalidation: revalidatePreparedCapability(
      invocation,
      { ...options, environment, registry },
      cacheReadCompleted ? cached : undefined,
    ),
  });
}
