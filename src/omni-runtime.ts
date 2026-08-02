import { types as nodeTypes } from "node:util";

import { canonicalJson, sha256 } from "./canonical-json";
import { loadAuthSnapshotIfPresent } from "./auth";
import {
  isProviderOperation,
  isWebSessionOperation,
} from "./model";
import {
  markOmniSourceDriftV1,
  OMNI_MAX_SOURCE_PAGES,
  parseMaterializedPageV1,
  parseOmniSourceStateV1,
  queryOmniSourceStatesV1,
  reduceOmniSourceStateV1,
  type OmniEntityV1,
  type OmniJsonValue,
  type OmniNormalizationStatusV1,
  type OmniPageProvenanceV1,
  type OmniSourceIdentityV1,
  type OmniSourceStateV1,
  type OmniStoredPageV1,
} from "./omni-model";
import {
  boundedOmniText,
  OMNI_MAX_REASON_BYTES,
  OMNI_MAX_RESPONSE_BYTES,
} from "./omni-limits";
import {
  omniRequestDigest,
  openOmniViewCursorV1,
  parseOmniViewRequestV1,
  sealOmniViewCursorV1,
  type OmniViewRequestV1,
  type OmniViewSourceRequestV1,
} from "./omni-request";
import type {
  ProviderPluginOmniDefinitionV1,
} from "./provider-plugin";
import type {
  ProviderPluginOperationResolutionV1,
  ProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import { revalidatePreparedCapability } from "./read-client";
import {
  createOmniProjectionQuery,
  readOmniProjection,
  readReadProjectionForMaterialization,
  reduceOmniProjection,
  projectionAuthIdentityHash,
  type OmniProjectionQuery,
  type ReadProjectionExactHeadFence,
  type ReadProjectionMaterializationSnapshot,
  type ReadProjectionQuery,
} from "./read-projections";
import {
  createReadProjectionQueryForInvocation,
  prepareInvocation,
  type PreparedInvocation,
} from "./runtime";
import type { executeReadInvocation } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;
const MAX_MATERIALIZATION_SETTLEMENT_ATTEMPTS = 4;

export type OmniExactSourceStatusV1 =
  | {
      readonly state: "miss";
      readonly key: string;
    }
  | {
      readonly state: "hit";
      readonly key: string;
      readonly dataRevision: string;
      readonly validatedAt: string;
      readonly ageMs: number;
      readonly freshness: {
        readonly state: "fresh" | "stale" | "unclassified";
        readonly freshForMs: number | null;
      };
    }
  | {
      readonly state: "error";
      readonly key: string;
      readonly reason: string;
    };

export type OmniNormalizationSourceStatusV1 =
  | { readonly state: "missing" }
  | { readonly state: "unsupported"; readonly reason: string }
  | {
      readonly state: "current";
      readonly exactQueryKey: string;
      readonly exactDataRevision: string;
      readonly lastGoodAt: string;
    }
  | {
      readonly state: "retained-after-drift";
      readonly exactQueryKey: string;
      readonly reason: string;
      readonly failedExactDataRevision: string;
      readonly newerExactDataRevision: string | null;
      readonly lastGoodExactDataRevision: string | null;
      readonly lastGoodAt: string | null;
    }
  | {
      readonly state: "stale";
      readonly exactQueryKey: string;
      /** Null when a failed provider attempt produced no new exact revision. */
      readonly exactDataRevision: string | null;
      /** Null when this exact query has never produced a normalized page. */
      readonly normalizedExactDataRevision: string | null;
      readonly lastGoodAt: string | null;
      readonly reason: string;
    }
  | {
      readonly state: "error";
      readonly reason: string;
      readonly lastGoodAt: string | null;
    };

export type OmniSourceCoverageV1 =
  | {
      readonly state: "unavailable";
      readonly reason: string;
    }
  | {
      readonly state: "observed";
      readonly kind: OmniStoredPageV1["completeness"]["kind"];
      readonly continuation: "none" | "pending" | "unavailable";
      readonly reason: string | null;
    };

export type OmniViewSourceStatusV1 = {
  readonly adapterId: string;
  readonly operationId: "messaging.list" | "messaging.read";
  readonly authId: string;
  /** Client-verifiable identity of the exact raw request input. */
  readonly requestInputHash: string;
  /** Provider-parsed/defaulted identity used by the exact projection. */
  readonly projectionInputHash: string;
  /** Opaque keyed revision of the durable normalized source state, if any. */
  readonly normalizationDataRevision: string | null;
  readonly surfaceId: string;
  readonly exact: OmniExactSourceStatusV1;
  readonly normalization: OmniNormalizationSourceStatusV1;
  readonly coverage: OmniSourceCoverageV1;
};

export type OmniViewV1 = {
  readonly schemaVersion: 1;
  readonly viewRevision: string;
  readonly entities: readonly OmniEntityV1[];
  readonly nextCursor: string | null;
  readonly sources: readonly OmniViewSourceStatusV1[];
};

export type OmniViewIdentityV1 = {
  /** Full canonical SDK/CLI invocation identity, including the local cursor. */
  readonly invocationDigest: string;
  /** Cursor-independent logical request identity. */
  readonly requestDigest: string;
  readonly sourceSetDigest: string;
};

export type OmniReadResultV1 = {
  readonly ok: true;
  readonly schemaVersion: 1;
  readonly source:
    | "omni-cache"
    | "omni-live"
    | "omni-exact-cache"
    | "omni-identity";
  readonly identity: OmniViewIdentityV1;
  readonly view: OmniViewV1 | null;
};

type PreparedOmniSource = {
  readonly request: OmniViewSourceRequestV1;
  readonly invocation: PreparedInvocation;
  readonly exactQuery: ReadProjectionQuery;
  readonly resolution: ProviderPluginOperationResolutionV1 | null;
  readonly surfaceId: string;
  readonly omni: ProviderPluginOmniDefinitionV1 | null;
  readonly sourceIdentity: OmniSourceIdentityV1 | null;
  readonly omniQuery: OmniProjectionQuery | null;
  readonly identityDescriptor: unknown;
};

type OmniRuntimeOptions = {
  readonly environment?: Environment;
  readonly registry?: ProviderPluginRegistry;
  readonly now?: Date;
  readonly freshForMs?: number;
};

type OmniLiveRuntimeOptions = OmniRuntimeOptions & {
  readonly headed?: boolean;
  readonly signal?: AbortSignal;
  readonly executeRead?: typeof executeReadInvocation;
  /** Internal resource budget. The product default remains the schema cap. */
  readonly sourcePageLimit?: number;
};

type OmniSourceUpdateError = {
  readonly exactQueryKey: string;
  readonly reason: string;
};

type OmniMaterializationResult = ReturnType<typeof materializeCurrentExact>;

const EXACT_READ_ERROR_REASON = "exact provider snapshot could not be read";
const NORMALIZED_STATE_READ_ERROR_REASON = "normalized source state could not be read";
const NORMALIZED_STATE_PARSE_ERROR_REASON = "normalized source state could not be parsed";
const NORMALIZED_STATE_OBSERVE_ERROR_REASON = "normalized source state could not be observed";
const PROVIDER_READ_ERROR_REASON =
  "provider read failed before the normalized source could be refreshed";
const EXACT_PUBLICATION_ERROR_REASON =
  "exact provider snapshot could not be published during omni revalidation";
const NORMALIZATION_UPDATE_ERROR_REASON =
  "exact provider snapshot could not be normalized";
const CONTINUATION_PREPARATION_ERROR_REASON =
  "provider continuation could not be prepared from normalized state";

function parseSourcePageLimit(value: number | undefined): number {
  const parsed = value ?? OMNI_MAX_SOURCE_PAGES;
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > OMNI_MAX_SOURCE_PAGES
  ) {
    throw new Error(
      `omni source page limit must be an integer from 1 through ${String(OMNI_MAX_SOURCE_PAGES)}`,
    );
  }
  return parsed;
}

export function createOmniContinuationGuard(
  rootExactQueryKey: string,
  pageLimitValue?: number,
): Readonly<{
  beforeNext(): string | null;
  observe(exactQueryKey: string): string | null;
}> {
  const pageLimit = parseSourcePageLimit(pageLimitValue);
  let pages = 1;
  const visited = new Set([rootExactQueryKey]);
  return Object.freeze({
    beforeNext(): string | null {
      return pages >= pageLimit
        ? `provider continuation exceeds the ${String(pageLimit)}-page normalized capacity`
        : null;
    },
    observe(exactQueryKey: string): string | null {
      if (visited.has(exactQueryKey)) {
        return "provider continuation repeated an exact page query";
      }
      visited.add(exactQueryKey);
      pages += 1;
      return null;
    },
  });
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return boundedOmniText(value, OMNI_MAX_REASON_BYTES);
}

function privateDriftError(error: unknown): Error {
  if (!nodeTypes.isProxy(error) && error instanceof Error) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (
      descriptor !== undefined
      && "value" in descriptor
      && typeof descriptor.value === "string"
    ) {
      return new Error(boundedOmniText(descriptor.value, OMNI_MAX_REASON_BYTES));
    }
  }
  return new Error("provider materializer threw a non-Error diagnostic");
}

function internalDriftCode(
  error: unknown,
): "materializer-drift" | "capacity-exceeded" {
  const message = error instanceof Error ? error.message : "";
  return /(?:must be a plain array of at most \d+ items|exceeds its JSON bound|has too many properties|exceeds its (?:byte|entity, page, complete-coverage, tombstone, or normalization|normalization frontier) capacity)$/u
    .test(message)
    ? "capacity-exceeded"
    : "materializer-drift";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("omni revalidation was aborted", "AbortError");
}

function sourceUpdateError(
  source: PreparedOmniSource,
  reason: string,
): OmniSourceUpdateError {
  return Object.freeze({
    exactQueryKey: source.exactQuery.key,
    reason,
  });
}

function publicDriftReason(
  source: PreparedOmniSource,
  code: Extract<OmniNormalizationStatusV1, { readonly state: "drift" }>["code"],
): string {
  if (code === "capacity-exceeded") {
    return `${source.surfaceId} ${source.request.operationId} normalized state exceeded its reviewed capacity`;
  }
  const materializer = source.omni?.state === "supported"
    ? `${source.omni.materializerId}@${String(source.omni.materializerVersion)}`
    : "unavailable";
  return `${source.surfaceId} ${source.request.operationId} materializer ${materializer} rejected the exact provider shape`;
}

function publicCoverageReason(
  kind: OmniStoredPageV1["completeness"]["kind"],
): string {
  switch (kind) {
    case "complete":
      return "the provider materializer declared complete partition coverage";
    case "page":
      return "the provider materializer declared page-scoped coverage";
    case "unknown":
      return "the provider materializer could not establish coverage completeness";
    case "first-page-only":
      return "the provider contract supports only the first observed page";
    case "bounded-local":
      return "the provider materializer exposed a bounded local projection";
    case "search-window":
      return "the provider materializer exposed a bounded search window";
    case "truncated":
      return "the provider materializer reported truncated coverage";
  }
}

function resolvePluginOperation(
  invocation: PreparedInvocation,
  registry: ProviderPluginRegistry,
): ProviderPluginOperationResolutionV1 | null {
  const operation = invocation.manifest.operations[invocation.operationId];
  if (operation === undefined) throw new Error("omni source operation disappeared");
  if (isProviderOperation(operation)) {
    return registry.requireOperationDefinition(
      "provider-api",
      operation.provider.provider,
      operation.provider.action,
      operation.provider.contractVersion,
    );
  }
  if (isWebSessionOperation(operation)) {
    const binding = registry.requireSessionRoute(operation.webSession.site);
    return registry.requireOperationDefinition(
      binding.transport,
      operation.webSession.site,
      operation.webSession.action,
      operation.webSession.contractVersion,
    );
  }
  return null;
}

function materializerDescriptors(
  resolution: ProviderPluginOperationResolutionV1,
): readonly unknown[] {
  return Object.freeze(resolution.binding.operations
    .filter((operation) =>
      operation.name === "messaging.list" || operation.name === "messaging.read")
    .map((operation) => {
      if (operation.omni === undefined) {
        throw new Error(
          `provider plugin ${resolution.plugin.id} ${resolution.binding.surfaceId}/${operation.name} is missing its required omni declaration`,
        );
      }
      return Object.freeze({
        operation: operation.name,
        contractVersions: operation.contractVersions,
        ...(operation.omni.state === "supported"
          ? {
              state: "supported" as const,
              schemaVersion: operation.omni.schemaVersion,
              materializerId: operation.omni.materializerId,
              materializerVersion: operation.omni.materializerVersion,
            }
          : {
              state: "unsupported" as const,
              reason: operation.omni.reason,
            }),
      });
    })
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))));
}

function prepareSource(
  request: OmniViewSourceRequestV1,
  environment: Environment,
  registry: ProviderPluginRegistry,
): PreparedOmniSource {
  const invocation = prepareInvocation(
    request.adapterId,
    request.operationId,
    request.input,
    request.authId,
    environment,
    registry,
  );
  const exactQuery = createReadProjectionQueryForInvocation(
    invocation,
    environment,
    registry,
  );
  const resolution = resolvePluginOperation(invocation, registry);
  if (resolution === null) {
    return Object.freeze({
      request,
      invocation,
      exactQuery,
      resolution: null,
      surfaceId: invocation.manifest.id,
      omni: null,
      sourceIdentity: null,
      omniQuery: null,
      identityDescriptor: Object.freeze({
        request: Object.freeze({
          adapterId: request.adapterId,
          operationId: request.operationId,
          authId: request.authId,
          inputHash: exactQuery.identity.inputHash,
        }),
        exactQueryKey: exactQuery.key,
        surfaceId: invocation.manifest.id,
        materialization: Object.freeze({
          state: "unsupported",
          reason: "operation is not backed by a reviewed provider plugin materializer",
        }),
      }),
    });
  }
  const omni = resolution.operation.omni;
  if (omni === undefined) {
    throw new Error(
      `provider plugin ${resolution.plugin.id} ${resolution.binding.surfaceId}/${request.operationId} is missing its required omni declaration`,
    );
  }
  const closureHash = registry.reviewedImplementationClosureHash(resolution.binding);
  const sourceIdentity: OmniSourceIdentityV1 = Object.freeze({
    schemaVersion: 1,
    adapter: exactQuery.identity.adapter,
    plugin: Object.freeze({
      id: resolution.plugin.id,
      version: resolution.plugin.version,
      closureHash,
    }),
    surfaceId: resolution.binding.surfaceId,
    auth: exactQuery.identity.auth,
  });
  const descriptors = materializerDescriptors(resolution);
  const aggregateIdentity = Object.freeze({
    schemaVersion: 1,
    surfaceId: resolution.binding.surfaceId,
    plugin: sourceIdentity.plugin,
    materializers: descriptors,
  });
  const omniQuery = createOmniProjectionQuery({
    adapter: exactQuery.identity.adapter,
    operation: "omni.source.v1",
    input: aggregateIdentity,
    inputHash: sha256(canonicalJson(aggregateIdentity)),
    auth: exactQuery.identity.auth,
    contract: Object.freeze({
      transport: exactQuery.identity.contract.transport,
      hash: sha256(canonicalJson(aggregateIdentity)),
    }),
  }, environment);
  return Object.freeze({
    request,
    invocation,
    exactQuery,
    resolution,
    surfaceId: resolution.binding.surfaceId,
    omni,
    sourceIdentity,
    omniQuery,
    identityDescriptor: Object.freeze({
      request: Object.freeze({
        adapterId: request.adapterId,
        operationId: request.operationId,
        authId: request.authId,
        inputHash: exactQuery.identity.inputHash,
      }),
      exactQueryKey: exactQuery.key,
      omniQueryKey: omniQuery.key,
      source: sourceIdentity,
      materialization: omni.state === "supported"
        ? Object.freeze({
            state: "supported",
            schemaVersion: omni.schemaVersion,
            materializerId: omni.materializerId,
            materializerVersion: omni.materializerVersion,
          })
        : Object.freeze({ state: "unsupported", reason: omni.reason }),
    }),
  });
}

function prepareSources(
  requestValue: unknown,
  options: OmniRuntimeOptions,
): {
  readonly request: OmniViewRequestV1;
  readonly sources: readonly PreparedOmniSource[];
  readonly identity: OmniViewIdentityV1;
  readonly environment: Environment;
  readonly registry: ProviderPluginRegistry;
} {
  const request = parseOmniViewRequestV1(requestValue);
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? providerPluginRegistry;
  const sources = Object.freeze(request.sources.map((source) =>
    prepareSource(source, environment, registry)));
  const sourceSetDigest = sha256(canonicalJson(
    sources.map((source) => source.identityDescriptor),
  ));
  return Object.freeze({
    request,
    sources,
    identity: Object.freeze({
      invocationDigest: sha256(canonicalJson(request)),
      requestDigest: omniRequestDigest(request),
      sourceSetDigest,
    }),
    environment,
    registry,
  });
}

function exactStatus(
  source: PreparedOmniSource,
  options: OmniRuntimeOptions,
): {
  readonly snapshot: ReadProjectionMaterializationSnapshot | null;
  readonly status: OmniExactSourceStatusV1;
} {
  try {
    const snapshot = readReadProjectionForMaterialization(source.exactQuery, {
      environment: options.environment ?? process.env,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.freshForMs === undefined ? {} : { freshForMs: options.freshForMs }),
    });
    if (snapshot.status === "miss") {
      return Object.freeze({
        snapshot,
        status: Object.freeze({ state: "miss", key: snapshot.key }),
      });
    }
    return Object.freeze({
      snapshot,
      status: Object.freeze({
        state: "hit",
        key: snapshot.key,
        dataRevision: snapshot.dataRevision,
        validatedAt: snapshot.validatedAt,
        ageMs: snapshot.ageMs,
        freshness: snapshot.freshness,
      }),
    });
  } catch {
    return Object.freeze({
      snapshot: null,
      status: Object.freeze({
        state: "error",
        key: source.exactQuery.key,
        reason: EXACT_READ_ERROR_REASON,
      }),
    });
  }
}

function sameExactHead(
  left: ReadProjectionMaterializationSnapshot,
  right: ReadProjectionMaterializationSnapshot,
): boolean {
  return left.status === right.status
    && (
      left.status === "miss"
      || (
        right.status === "hit"
        && left.storageRevisionId === right.storageRevisionId
        && left.dataRevision === right.dataRevision
        && left.runId === right.runId
      )
    );
}

function provenance(
  source: PreparedOmniSource,
  exact: Extract<ReadProjectionMaterializationSnapshot, { readonly status: "hit" }>,
): OmniPageProvenanceV1 {
  if (source.omni?.state !== "supported") {
    throw new Error("unsupported omni source cannot produce provenance");
  }
  return Object.freeze({
    operation: source.request.operationId,
    inputHash: source.exactQuery.identity.inputHash,
    exactQueryKey: source.exactQuery.key,
    exactDataRevision: exact.dataRevision,
    validatedAt: exact.validatedAt,
    startedAt: exact.startedAt,
    finishedAt: exact.finishedAt,
    runId: exact.runId,
    materializerId: source.omni.materializerId,
    materializerVersion: source.omni.materializerVersion,
  });
}

function exactHeadFence(
  source: PreparedOmniSource,
  exact: Extract<ReadProjectionMaterializationSnapshot, { readonly status: "hit" }>,
): ReadProjectionExactHeadFence {
  return Object.freeze({
    query: source.exactQuery,
    storageRevisionId: exact.storageRevisionId,
    dataRevision: exact.dataRevision,
    runId: exact.runId,
  });
}

function assertCurrentAuthLifetime(
  source: PreparedOmniSource,
  environment: Environment,
): void {
  const expected = source.invocation.readProjectionAuthIdentityHash;
  if (expected === undefined) {
    throw new Error("prepared omni source is missing its auth lifetime identity");
  }
  const snapshot = loadAuthSnapshotIfPresent(source.invocation.auth.id, environment);
  if (snapshot === null) {
    throw new Error(`auth locator ${source.invocation.auth.id} was removed`);
  }
  const contentHash = sha256(canonicalJson(snapshot.auth));
  const current = projectionAuthIdentityHash(
    snapshot.auth.id,
    contentHash,
    environment,
  );
  if (
    current !== expected
    || source.exactQuery.identity.auth.hash !== expected
    || snapshot.auth.subject !== source.invocation.auth.subject
  ) {
    throw new Error(
      `auth locator ${source.invocation.auth.id} changed since this omni source was prepared`,
    );
  }
}

function markDrift(
  source: PreparedOmniSource,
  exact: Extract<ReadProjectionMaterializationSnapshot, { readonly status: "hit" }>,
  error: unknown,
  options: OmniRuntimeOptions,
  code: "materializer-drift" | "capacity-exceeded",
): void {
  if (source.omniQuery === null || source.sourceIdentity === null) {
    throw new Error("unsupported omni source cannot retain drift state");
  }
  const privateError = privateDriftError(error);
  reduceOmniProjection(source.omniQuery, (current) =>
    markOmniSourceDriftV1(current, {
      source: source.sourceIdentity!,
      exactQueryKey: source.exactQuery.key,
      exactDataRevision: exact.dataRevision,
      failedAt: (options.now ?? new Date()).toISOString(),
      error: privateError,
      code,
  }), {
    environment: options.environment ?? process.env,
    ...(options.now === undefined ? {} : { now: options.now }),
    exactHead: exactHeadFence(source, exact),
    assertCurrent: () => assertCurrentAuthLifetime(
      source,
      options.environment ?? process.env,
    ),
  });
}

function materializeCurrentExact(
  source: PreparedOmniSource,
  options: OmniRuntimeOptions,
):
  | { readonly state: "missing" }
  | {
      readonly state: "materialized";
      readonly page: ReturnType<typeof parseMaterializedPageV1>;
    }
  | { readonly state: "drift" } {
  if (
    source.omni?.state !== "supported"
    || source.omniQuery === null
    || source.sourceIdentity === null
  ) return Object.freeze({ state: "missing" });
  for (let attempt = 0; attempt < MAX_MATERIALIZATION_SETTLEMENT_ATTEMPTS; attempt += 1) {
    const before = readReadProjectionForMaterialization(source.exactQuery, {
      environment: options.environment ?? process.env,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.freshForMs === undefined ? {} : { freshForMs: options.freshForMs }),
    });
    if (before.status === "miss") return Object.freeze({ state: "missing" });
    let page: ReturnType<typeof parseMaterializedPageV1> | null = null;
    let materializerError: unknown = null;
    let driftCode: "materializer-drift" | "capacity-exceeded" =
      "materializer-drift";
    let materializedOutput: unknown;
    try {
      materializedOutput = source.omni.materialize(
        source.invocation.input,
        before.output,
      );
    } catch (error) {
      materializerError = error;
    }
    if (materializerError === null) {
      try {
        page = parseMaterializedPageV1(materializedOutput);
      } catch (error) {
        materializerError = error;
        driftCode = internalDriftCode(error);
      }
    }
    const fenced = readReadProjectionForMaterialization(source.exactQuery, {
      environment: options.environment ?? process.env,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.freshForMs === undefined ? {} : { freshForMs: options.freshForMs }),
    });
    if (!sameExactHead(before, fenced)) continue;
    if (materializerError !== null || page === null) {
      try {
        markDrift(source, before, materializerError, options, driftCode);
      } catch (error) {
        const changed = readReadProjectionForMaterialization(source.exactQuery, {
          environment: options.environment ?? process.env,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.freshForMs === undefined
            ? {}
            : { freshForMs: options.freshForMs }),
        });
        if (!sameExactHead(before, changed)) continue;
        throw error;
      }
    } else {
      try {
        const pageProvenance = provenance(source, before);
        reduceOmniProjection(source.omniQuery, (current) =>
          reduceOmniSourceStateV1(current, page, {
            source: source.sourceIdentity!,
            provenance: pageProvenance,
        }), {
          environment: options.environment ?? process.env,
          ...(options.now === undefined ? {} : { now: options.now }),
          exactHead: exactHeadFence(source, before),
          assertCurrent: () => assertCurrentAuthLifetime(
            source,
            options.environment ?? process.env,
          ),
        });
      } catch (error) {
        const changed = readReadProjectionForMaterialization(source.exactQuery, {
          environment: options.environment ?? process.env,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.freshForMs === undefined
            ? {}
            : { freshForMs: options.freshForMs }),
        });
        if (!sameExactHead(before, changed)) continue;
        markDrift(
          source,
          before,
          error,
          options,
          internalDriftCode(error),
        );
        materializerError = error;
      }
    }
    const after = readReadProjectionForMaterialization(source.exactQuery, {
      environment: options.environment ?? process.env,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.freshForMs === undefined ? {} : { freshForMs: options.freshForMs }),
    });
    if (!sameExactHead(before, after)) continue;
    return materializerError === null && page !== null
      ? Object.freeze({ state: "materialized" as const, page })
      : Object.freeze({ state: "drift" as const });
  }
  throw new Error(
    `exact projection ${source.exactQuery.key} did not settle while its normalized derivative was being updated`,
  );
}

function prepareContinuationSource(
  parent: PreparedOmniSource,
  nextInput: Readonly<Record<string, OmniJsonValue>>,
  prepared: ReturnType<typeof prepareSources>,
): PreparedOmniSource {
  const continuation = prepareSource(Object.freeze({
    adapterId: parent.request.adapterId,
    operationId: parent.request.operationId,
    authId: parent.request.authId,
    input: nextInput,
  }), prepared.environment, prepared.registry);
  if (
    parent.omni?.state !== "supported"
    || continuation.omni?.state !== "supported"
    || parent.omni.materializerId !== continuation.omni.materializerId
    || parent.omni.materializerVersion !== continuation.omni.materializerVersion
    || parent.omniQuery === null
    || continuation.omniQuery === null
    || parent.omniQuery.key !== continuation.omniQuery.key
    || parent.sourceIdentity === null
    || continuation.sourceIdentity === null
    || canonicalJson(parent.sourceIdentity)
      !== canonicalJson(continuation.sourceIdentity)
  ) {
    throw new Error(
      "provider continuation crossed its source, materializer, or auth identity",
    );
  }
  return continuation;
}

function rebuildExactContinuationChain(
  root: PreparedOmniSource,
  prepared: ReturnType<typeof prepareSources>,
  options: OmniRuntimeOptions,
): OmniSourceUpdateError | undefined {
  let current = root;
  let materialized: OmniMaterializationResult;
  try {
    materialized = materializeCurrentExact(current, options);
  } catch {
    return sourceUpdateError(current, NORMALIZATION_UPDATE_ERROR_REASON);
  }
  const guard = createOmniContinuationGuard(root.exactQuery.key);
  for (; materialized.state === "materialized";) {
    const nextInput = materialized.page.cursor.nextInput;
    if (nextInput === null) return undefined;
    const capacityReason = guard.beforeNext();
    if (capacityReason !== null) return sourceUpdateError(current, capacityReason);
    let continuation: PreparedOmniSource;
    try {
      continuation = prepareContinuationSource(root, nextInput, prepared);
    } catch {
      return sourceUpdateError(current, CONTINUATION_PREPARATION_ERROR_REASON);
    }
    const repeatedReason = guard.observe(continuation.exactQuery.key);
    if (repeatedReason !== null) {
      return sourceUpdateError(continuation, repeatedReason);
    }
    current = continuation;
    try {
      materialized = materializeCurrentExact(current, options);
    } catch {
      return sourceUpdateError(current, NORMALIZATION_UPDATE_ERROR_REASON);
    }
  }
  return undefined;
}

type OmniSourceRevalidation =
  | {
      readonly state: "observed";
      readonly materialized: OmniMaterializationResult;
      readonly error?: string;
    }
  | {
      readonly state: "failed";
      readonly error: string;
    };

async function revalidateOneOmniSource(
  source: PreparedOmniSource,
  prepared: ReturnType<typeof prepareSources>,
  options: OmniLiveRuntimeOptions,
): Promise<OmniSourceRevalidation> {
  let live;
  try {
    live = await revalidatePreparedCapability(source.invocation, {
      environment: prepared.environment,
      registry: prepared.registry,
      headed: options.headed ?? false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.freshForMs === undefined
        ? {}
        : { freshForMs: options.freshForMs }),
      ...(options.executeRead === undefined
        ? {}
        : { executeRead: options.executeRead }),
    });
  } catch {
    throwIfAborted(options.signal);
    return Object.freeze({
      state: "failed" as const,
      error: PROVIDER_READ_ERROR_REASON,
    });
  }
  throwIfAborted(options.signal);
  const error = live.live.receipt.status !== "succeeded"
    ? PROVIDER_READ_ERROR_REASON
    : live.cache.status === "error"
      ? EXACT_PUBLICATION_ERROR_REASON
      : undefined;
  let materialized: OmniMaterializationResult;
  try {
    materialized = materializeCurrentExact(source, options);
  } catch {
    throwIfAborted(options.signal);
    return Object.freeze({
      state: "failed" as const,
      error: NORMALIZATION_UPDATE_ERROR_REASON,
    });
  }
  return Object.freeze({
    state: "observed" as const,
    materialized,
    ...(error === undefined ? {} : { error }),
  });
}

async function revalidateOmniSourceChain(
  root: PreparedOmniSource,
  prepared: ReturnType<typeof prepareSources>,
  options: OmniLiveRuntimeOptions,
): Promise<OmniSourceUpdateError | undefined> {
  const guard = createOmniContinuationGuard(
    root.exactQuery.key,
    options.sourcePageLimit,
  );
  let observed = await revalidateOneOmniSource(root, prepared, options);
  throwIfAborted(options.signal);
  if (observed.state === "failed") {
    return sourceUpdateError(root, observed.error);
  }
  if (observed.error !== undefined) {
    return sourceUpdateError(root, observed.error);
  }
  let current = root;
  for (; observed.materialized.state === "materialized";) {
    throwIfAborted(options.signal);
    const nextInput = observed.materialized.page.cursor.nextInput;
    if (nextInput === null) return undefined;
    const capacityReason = guard.beforeNext();
    if (capacityReason !== null) return sourceUpdateError(current, capacityReason);
    let continuation: PreparedOmniSource;
    try {
      continuation = prepareContinuationSource(root, nextInput, prepared);
    } catch {
      return sourceUpdateError(current, CONTINUATION_PREPARATION_ERROR_REASON);
    }
    const repeatedReason = guard.observe(continuation.exactQuery.key);
    if (repeatedReason !== null) {
      return Object.freeze({
        exactQueryKey: continuation.exactQuery.key,
        reason: repeatedReason,
      });
    }
    current = continuation;
    observed = await revalidateOneOmniSource(continuation, prepared, options);
    throwIfAborted(options.signal);
    if (observed.state === "failed") {
      return sourceUpdateError(continuation, observed.error);
    }
    if (observed.error !== undefined) {
      return sourceUpdateError(continuation, observed.error);
    }
  }
  return undefined;
}

type StoredOmniChainObservation = {
  readonly coverage: OmniSourceCoverageV1;
  readonly frontiers: readonly {
    readonly exactQueryKey: string;
    readonly status: OmniNormalizationStatusV1;
  }[];
  readonly exact: readonly {
    readonly exactQueryKey: string;
    readonly status: OmniExactSourceStatusV1;
  }[];
  readonly issue: StoredOmniStaleEvidence | null;
};

type StoredOmniStaleEvidence = {
  readonly exactQueryKey: string;
  readonly exactDataRevision: string | null;
  readonly normalizedExactDataRevision: string | null;
  readonly lastGoodAt: string | null;
  readonly reason: string;
};

function normalizationFrontier(
  state: OmniSourceStateV1,
  exactQueryKey: string,
) {
  return state.normalization.find((entry) =>
    entry.exactQueryKey === exactQueryKey) ?? null;
}

function pageForExactQuery(
  state: OmniSourceStateV1,
  exactQueryKey: string,
): OmniStoredPageV1 | null {
  const pages = state.pages.filter((page) =>
    page.provenance.exactQueryKey === exactQueryKey);
  if (pages.length > 1) {
    throw new Error(
      "normalized state retained multiple pages for one exact provider query",
    );
  }
  return pages[0] ?? null;
}

function staleEvidence(
  exactQueryKey: string,
  frontier: ReturnType<typeof normalizationFrontier>,
  exact: OmniExactSourceStatusV1,
  reason: string,
  options: { readonly omitExactRevision?: boolean } = {},
): StoredOmniStaleEvidence {
  const normalizedExactDataRevision = frontier === null
    ? null
    : frontier.status.state === "ready"
      ? frontier.status.exactDataRevision
      : frontier.status.lastGoodExactDataRevision;
  return Object.freeze({
    exactQueryKey,
    exactDataRevision: options.omitExactRevision === true
      ? null
      : exact.state === "hit"
        ? exact.dataRevision
        : null,
    normalizedExactDataRevision,
    lastGoodAt: frontier?.status.lastGoodAt ?? null,
    reason: boundedError(reason),
  });
}

function observeStoredOmniChain(
  root: PreparedOmniSource,
  state: OmniSourceStateV1,
  prepared: ReturnType<typeof prepareSources>,
  options: OmniRuntimeOptions,
  rootExact: OmniExactSourceStatusV1,
): StoredOmniChainObservation {
  let current = root;
  const visited = new Set<string>();
  const frontiers: {
    readonly exactQueryKey: string;
    readonly status: OmniNormalizationStatusV1;
  }[] = [];
  const exact: {
    readonly exactQueryKey: string;
    readonly status: OmniExactSourceStatusV1;
  }[] = [];
  let rootPage: OmniStoredPageV1 | null = null;
  let issue: StoredOmniStaleEvidence | null = null;
  for (let pages = 0; pages < OMNI_MAX_SOURCE_PAGES; pages += 1) {
    if (visited.has(current.exactQuery.key)) {
      const reason = "normalized provider continuation repeats an exact page query";
      const frontier = normalizationFrontier(state, current.exactQuery.key);
      const currentExact = exact.find((entry) =>
        entry.exactQueryKey === current.exactQuery.key)?.status
        ?? exactStatus(current, options).status;
      return Object.freeze({
        coverage: Object.freeze({ state: "unavailable" as const, reason }),
        frontiers: Object.freeze(frontiers),
        exact: Object.freeze(exact),
        issue: staleEvidence(
          current.exactQuery.key,
          frontier,
          currentExact,
          reason,
        ),
      });
    }
    visited.add(current.exactQuery.key);
    const frontier = normalizationFrontier(state, current.exactQuery.key);
    const page = pageForExactQuery(state, current.exactQuery.key);
    if (frontier !== null) frontiers.push(frontier);
    const currentExact = current.exactQuery.key === root.exactQuery.key
      ? rootExact
      : exactStatus(current, options).status;
    exact.push(Object.freeze({
      exactQueryKey: current.exactQuery.key,
      status: currentExact,
    }));
    if (frontier?.status.state === "ready") {
      if (
        current.exactQuery.key !== root.exactQuery.key
        && currentExact.state === "hit"
        && currentExact.freshness.state === "stale"
      ) {
        issue ??= staleEvidence(
          current.exactQuery.key,
          frontier,
          currentExact,
          "a provider continuation exact snapshot is stale",
        );
      } else if (
        currentExact.state === "hit"
        && currentExact.dataRevision !== frontier.status.exactDataRevision
      ) {
        issue ??= staleEvidence(
          current.exactQuery.key,
          frontier,
          currentExact,
          current.exactQuery.key === root.exactQuery.key
            ? "the normalized derivative has not observed the current exact revision"
            : "a provider continuation exact snapshot is newer than its normalized frontier",
        );
      } else if (currentExact.state === "miss") {
        issue ??= staleEvidence(
          current.exactQuery.key,
          frontier,
          currentExact,
          current.exactQuery.key === root.exactQuery.key
            ? "the exact provider snapshot is unavailable"
            : "a normalized provider continuation has no exact snapshot",
        );
      } else if (currentExact.state === "error") {
        issue ??= staleEvidence(
          current.exactQuery.key,
          frontier,
          currentExact,
          currentExact.reason,
        );
      }
    }
    if (frontier === null || page === null) {
      if (frontier?.status.state !== "drift") {
        issue ??= staleEvidence(
          current.exactQuery.key,
          frontier,
          currentExact,
          frontier === null
            ? "a provider continuation has not reached a normalized frontier"
            : "a normalized provider continuation has no retained page",
        );
      }
      if (rootPage === null) {
        const reason = frontier === null
          ? "the requested exact query has no normalized frontier"
          : "the requested exact query has no retained normalized page";
        return Object.freeze({
          coverage: Object.freeze({ state: "unavailable" as const, reason }),
          frontiers: Object.freeze(frontiers),
          exact: Object.freeze(exact),
          issue,
        });
      }
      return Object.freeze({
        coverage: Object.freeze({
          state: "observed" as const,
          kind: rootPage.completeness.kind,
          continuation: "pending" as const,
          reason: publicCoverageReason(rootPage.completeness.kind),
        }),
        frontiers: Object.freeze(frontiers),
        exact: Object.freeze(exact),
        issue,
      });
    }
    rootPage ??= page;
    if (page.cursor.nextInput === null) {
      const continuation = page.completeness.kind === "complete"
        || page.completeness.kind === "page"
        ? "none" as const
        : "unavailable" as const;
      return Object.freeze({
        coverage: Object.freeze({
          state: "observed" as const,
          kind: rootPage.completeness.kind,
          continuation,
          reason: publicCoverageReason(rootPage.completeness.kind),
        }),
        frontiers: Object.freeze(frontiers),
        exact: Object.freeze(exact),
        issue,
      });
    }
    try {
      current = prepareContinuationSource(root, page.cursor.nextInput, prepared);
    } catch {
      const reason = CONTINUATION_PREPARATION_ERROR_REASON;
      return Object.freeze({
        coverage: Object.freeze({ state: "unavailable" as const, reason }),
        frontiers: Object.freeze(frontiers),
        exact: Object.freeze(exact),
        issue: issue ?? staleEvidence(
          current.exactQuery.key,
          frontier,
          currentExact,
          reason,
        ),
      });
    }
  }
  const reason = `normalized provider continuation exceeds the ${String(OMNI_MAX_SOURCE_PAGES)}-page capacity`;
  return Object.freeze({
    coverage: Object.freeze({ state: "unavailable" as const, reason }),
    frontiers: Object.freeze(frontiers),
    exact: Object.freeze(exact),
    issue: issue ?? staleEvidence(
      current.exactQuery.key,
      normalizationFrontier(state, current.exactQuery.key),
      exactStatus(current, options).status,
      reason,
    ),
  });
}

function sourceState(
  source: PreparedOmniSource,
  prepared: ReturnType<typeof prepareSources>,
  options: OmniRuntimeOptions,
  updateError: OmniSourceUpdateError | undefined,
): {
  readonly status: OmniViewSourceStatusV1;
  readonly state: OmniSourceStateV1 | null;
} {
  const exact = exactStatus(source, options).status;
  const common = Object.freeze({
    adapterId: source.request.adapterId,
    operationId: source.request.operationId,
    authId: source.request.authId,
    requestInputHash: sha256(canonicalJson(source.request.input)),
    projectionInputHash: source.exactQuery.identity.inputHash,
    normalizationDataRevision: null,
    surfaceId: source.surfaceId,
    exact,
  });
  if (source.omni === null || source.omni.state === "unsupported") {
    const reason = source.omni?.state === "unsupported"
      ? source.omni.reason
      : "operation is not backed by a reviewed provider plugin materializer";
    return Object.freeze({
      state: null,
      status: Object.freeze({
        ...common,
        normalization: Object.freeze({
          state: "unsupported",
          reason,
        }),
        coverage: Object.freeze({ state: "unavailable", reason }),
      }),
    });
  }
  if (source.omniQuery === null) throw new Error("supported omni source has no private query");
  let cached;
  try {
    cached = readOmniProjection(source.omniQuery, {
      environment: options.environment ?? process.env,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.freshForMs === undefined ? {} : { freshForMs: options.freshForMs }),
    });
  } catch {
    const reason = NORMALIZED_STATE_READ_ERROR_REASON;
    return Object.freeze({
      state: null,
      status: Object.freeze({
        ...common,
        normalization: Object.freeze({
          state: "error",
          reason,
          lastGoodAt: null,
        }),
        coverage: Object.freeze({ state: "unavailable", reason }),
      }),
    });
  }
  if (cached.status === "miss") {
    const reason = updateError?.reason
      ?? "the requested source has no normalized state";
    return Object.freeze({
      state: null,
      status: Object.freeze({
        ...common,
        normalization: updateError === undefined
          ? Object.freeze({ state: "missing" })
          : Object.freeze({
              state: "error",
              reason: updateError.reason,
              lastGoodAt: null,
            }),
        coverage: Object.freeze({ state: "unavailable", reason }),
      }),
    });
  }
  const normalizedCommon = Object.freeze({
    ...common,
    normalizationDataRevision: cached.dataRevision,
  });
  let state: OmniSourceStateV1;
  try {
    state = parseOmniSourceStateV1(cached.output);
  } catch {
    const reason = NORMALIZED_STATE_PARSE_ERROR_REASON;
    return Object.freeze({
      state: null,
      status: Object.freeze({
        ...normalizedCommon,
        normalization: Object.freeze({
          state: "error",
          reason,
          lastGoodAt: null,
        }),
        coverage: Object.freeze({ state: "unavailable", reason }),
      }),
    });
  }
  let chain: StoredOmniChainObservation;
  try {
    chain = observeStoredOmniChain(source, state, prepared, options, exact);
  } catch {
    const reason = NORMALIZED_STATE_OBSERVE_ERROR_REASON;
    return Object.freeze({
      state: null,
      status: Object.freeze({
        ...normalizedCommon,
        normalization: Object.freeze({
          state: "error",
          reason,
          lastGoodAt: null,
        }),
        coverage: Object.freeze({ state: "unavailable", reason }),
      }),
    });
  }
  const rootFrontier = normalizationFrontier(state, source.exactQuery.key);
  const exactForQuery = (exactQueryKey: string): OmniExactSourceStatusV1 =>
    exactQueryKey === source.exactQuery.key
      ? exact
      : chain.exact.find((entry) =>
        entry.exactQueryKey === exactQueryKey)?.status
        ?? Object.freeze({ state: "miss", key: exactQueryKey });
  let normalization: OmniNormalizationSourceStatusV1;
  const drift = chain.frontiers.find((entry) =>
    entry.status.state === "drift");
  const chainPosition = (exactQueryKey: string): number => {
    const index = chain.exact.findIndex((entry) =>
      entry.exactQueryKey === exactQueryKey);
    if (index >= 0) return index;
    return exactQueryKey === source.exactQuery.key ? 0 : chain.exact.length;
  };
  const driftPosition = drift === undefined
    ? Number.POSITIVE_INFINITY
    : chainPosition(drift.exactQueryKey);
  const issuePosition = chain.issue === null
    ? Number.POSITIVE_INFINITY
    : chainPosition(chain.issue.exactQueryKey);
  const updatePosition = updateError === undefined
    ? Number.POSITIVE_INFINITY
    : chainPosition(updateError.exactQueryKey);
  if (
    drift?.status.state === "drift"
    && driftPosition <= issuePosition
    && driftPosition < updatePosition
  ) {
    const driftExact = exactForQuery(drift.exactQueryKey);
    normalization = Object.freeze({
      state: "retained-after-drift",
      exactQueryKey: drift.exactQueryKey,
      reason: publicDriftReason(source, drift.status.code),
      failedExactDataRevision: drift.status.exactDataRevision,
      newerExactDataRevision: driftExact.state === "hit"
        && driftExact.dataRevision !== drift.status.exactDataRevision
        ? driftExact.dataRevision
        : null,
      lastGoodExactDataRevision: drift.status.lastGoodExactDataRevision,
      lastGoodAt: drift.status.lastGoodAt,
    });
  } else if (
    chain.issue !== null
    && issuePosition < updatePosition
  ) {
    normalization = Object.freeze({ state: "stale", ...chain.issue });
  } else if (updateError !== undefined) {
    const updateFrontier = normalizationFrontier(
      state,
      updateError.exactQueryKey,
    );
    const updateExact = exactForQuery(updateError.exactQueryKey);
    const normalizedUpdateRevision = updateFrontier === null
      ? null
      : updateFrontier.status.state === "ready"
        ? updateFrontier.status.exactDataRevision
        : updateFrontier.status.lastGoodExactDataRevision;
    const evidence = staleEvidence(
      updateError.exactQueryKey,
      updateFrontier,
      updateExact,
      updateError.reason,
      {
        omitExactRevision: updateExact.state !== "hit"
          || updateExact.dataRevision === normalizedUpdateRevision,
      },
    );
    normalization = Object.freeze({ state: "stale", ...evidence });
  } else if (rootFrontier === null) {
    normalization = Object.freeze({ state: "missing" });
  } else {
    if (rootFrontier.status.state !== "ready") {
      throw new Error("normalized root drift was omitted from its observed chain");
    }
    normalization = Object.freeze({
      state: "current",
      exactQueryKey: source.exactQuery.key,
      exactDataRevision: rootFrontier.status.exactDataRevision,
      lastGoodAt: rootFrontier.status.lastGoodAt,
    });
  }
  return Object.freeze({
    state,
    status: Object.freeze({
      ...normalizedCommon,
      normalization,
      coverage: chain.coverage,
    }),
  });
}

function view(
  prepared: ReturnType<typeof prepareSources>,
  options: OmniRuntimeOptions,
  updateErrors: ReadonlyMap<string, OmniSourceUpdateError> = new Map(),
): OmniViewV1 {
  const observed = prepared.sources.map((source) => sourceState(
    source,
    prepared,
    options,
    updateErrors.get(canonicalJson(source.request)),
  ));
  const uniqueStates = new Map<string, OmniSourceStateV1>();
  for (let index = 0; index < observed.length; index += 1) {
    const state = observed[index]?.state;
    const query = prepared.sources[index]?.omniQuery;
    if (state !== null && state !== undefined && query !== null && query !== undefined) {
      uniqueStates.set(query.key, state);
    }
  }
  const entities = queryOmniSourceStatesV1(
    [...uniqueStates.values()],
    prepared.request.filter,
  );
  const viewRevision = sha256(canonicalJson({
    schemaVersion: 1,
    requestDigest: prepared.identity.requestDigest,
    sourceSetDigest: prepared.identity.sourceSetDigest,
    entities: entities.map((entity) => Object.freeze({ id: entity.id, revision: entity.revision })),
  }));
  const cursor = prepared.request.page?.cursor;
  let offset = 0;
  if (cursor !== undefined) {
    const anchor = openOmniViewCursorV1(
      prepared.request,
      prepared.identity.sourceSetDigest,
      viewRevision,
      cursor,
      prepared.environment,
    );
    const index = entities.findIndex((entity) =>
      entity.id === anchor.id && entity.orderedAt === anchor.orderedAt);
    if (index < 0) throw new Error("omni cursor anchor is absent from its authenticated view");
    offset = index + 1;
  }
  const limit = prepared.request.page?.limit ?? 100;
  const pageEntities = Object.freeze(entities.slice(offset, offset + limit));
  const hasMore = offset + pageEntities.length < entities.length;
  const last = pageEntities.at(-1);
  const nextCursor = hasMore && last !== undefined
    ? sealOmniViewCursorV1(
        prepared.request,
        prepared.identity.sourceSetDigest,
        viewRevision,
        Object.freeze({ orderedAt: last.orderedAt, id: last.id }),
        prepared.environment,
      )
    : null;
  const currentSet = prepareSources(prepared.request, {
    environment: prepared.environment,
    registry: prepared.registry,
  });
  if (
    currentSet.identity.invocationDigest !== prepared.identity.invocationDigest
    || currentSet.identity.requestDigest !== prepared.identity.requestDigest
    || currentSet.identity.sourceSetDigest !== prepared.identity.sourceSetDigest
  ) {
    throw new Error(
      "omni source or auth identity changed while the local view was being observed",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    viewRevision,
    entities: pageEntities,
    nextCursor,
    sources: Object.freeze(observed.map((entry) => entry.status)),
  });
}

function result(
  source: OmniReadResultV1["source"],
  prepared: ReturnType<typeof prepareSources>,
  selectedView: OmniViewV1 | null,
): OmniReadResultV1 {
  const envelope = Object.freeze({
    ok: true,
    schemaVersion: 1,
    source,
    identity: prepared.identity,
    view: selectedView,
  });
  // The CLI writes one trailing newline. Keep the complete process envelope
  // inside the same bound enforced by the public SDK.
  if (
    Buffer.byteLength(canonicalJson(envelope), "utf8") + 1
    > OMNI_MAX_RESPONSE_BYTES
  ) {
    throw new Error("omni response exceeds its aggregate byte bound");
  }
  return envelope;
}

export function identifyOmniView(
  requestValue: unknown,
  options: OmniRuntimeOptions = {},
): OmniReadResultV1 {
  const prepared = prepareSources(requestValue, options);
  return result("omni-identity", prepared, null);
}

export function readCachedOmniViewInternal(
  requestValue: unknown,
  options: OmniRuntimeOptions = {},
): OmniReadResultV1 {
  const prepared = prepareSources(requestValue, options);
  return result("omni-cache", prepared, view(prepared, options));
}

export function rebuildOmniViewFromExactCache(
  requestValue: unknown,
  options: OmniRuntimeOptions = {},
): OmniReadResultV1 {
  const prepared = prepareSources(requestValue, options);
  const errors = new Map<string, OmniSourceUpdateError>();
  for (const source of prepared.sources) {
    if (source.omni?.state !== "supported") continue;
    try {
      const error = rebuildExactContinuationChain(source, prepared, options);
      if (error !== undefined) {
        errors.set(canonicalJson(source.request), error);
      }
    } catch {
      errors.set(
        canonicalJson(source.request),
        sourceUpdateError(source, NORMALIZATION_UPDATE_ERROR_REASON),
      );
    }
  }
  return result("omni-exact-cache", prepared, view(prepared, options, errors));
}

export async function revalidateOmniViewInternal(
  requestValue: unknown,
  options: OmniLiveRuntimeOptions = {},
): Promise<OmniReadResultV1> {
  parseSourcePageLimit(options.sourcePageLimit);
  const prepared = prepareSources(requestValue, options);
  const errors = new Map<string, OmniSourceUpdateError>();
  for (const source of prepared.sources) {
    throwIfAborted(options.signal);
    if (source.omni?.state !== "supported") continue;
    try {
      const error = await revalidateOmniSourceChain(source, prepared, options);
      if (error !== undefined) {
        errors.set(
          canonicalJson(source.request),
          error,
        );
      }
    } catch {
      throwIfAborted(options.signal);
      errors.set(
        canonicalJson(source.request),
        sourceUpdateError(source, PROVIDER_READ_ERROR_REASON),
      );
    }
  }
  throwIfAborted(options.signal);
  const selectedView = view(prepared, options, errors);
  throwIfAborted(options.signal);
  return result("omni-live", prepared, selectedView);
}
