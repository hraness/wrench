/**
 * Self-contained data transfer types for the public Wrench client.
 *
 * Keep this module free of runtime and provider-kernel imports so TypeScript
 * consumers can inspect `@hraness/wrench/client` without loading Wrench's
 * internal type graph.
 */

export type WrenchClientEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type CapabilityReadRequest = {
  readonly adapterId: string;
  readonly operationId: string;
  readonly input?: unknown;
  readonly authId?: string;
};

export type ReadCapabilityOptions = {
  readonly environment?: WrenchClientEnvironment;
  readonly freshForMs?: number;
  readonly now?: Date;
};

export type RevalidateCapabilityOptions = ReadCapabilityOptions & {
  readonly headed?: boolean;
  readonly signal?: AbortSignal;
};

export type InvokeCapabilityOptions = Readonly<{
  readonly environment?: WrenchClientEnvironment;
  readonly headed?: boolean;
  readonly signal?: AbortSignal;
}>;

export type InvokeCapabilitySyncOptions = Readonly<{
  readonly environment?: WrenchClientEnvironment;
  readonly headed?: boolean;
}>;

export type ReadProjectionCacheResult =
  | {
      readonly status: "miss";
      readonly key: string;
    }
  | {
      readonly status: "hit";
      readonly source: "cache";
      readonly key: string;
      readonly output: unknown;
      readonly dataRevision: string;
      readonly createdAt: string;
      readonly dataChangedAt: string;
      readonly validatedAt: string;
      readonly runId: string;
      readonly ageMs: number;
      readonly freshness: {
        readonly state: "fresh" | "stale" | "unclassified";
        readonly freshForMs: number | null;
      };
    };

export type ReadProjectionPublication = {
  readonly key: string;
  readonly dataRevision: string;
  readonly validatedAt: string;
  readonly dataChangedAt: string;
  readonly disposition: "created" | "changed" | "unchanged" | "superseded";
  readonly currentDataRevision?: string;
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

export type WrenchClientPortableOperationIdentity = {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly hostApiVersion: 1;
  readonly bundleSha256: string;
  readonly manifestSha256: string;
  readonly adapterId: string;
  readonly transport: "linked-device" | "provider-api" | "web-session-api";
  readonly surfaceId: string;
  readonly operation: string;
  readonly contractVersion: number;
  readonly descriptorSha256: string;
};

export type WrenchClientLocalCliToolArtifactIdentity = {
  readonly platform: string;
  readonly arch: string;
  readonly executableSha256: string;
  readonly archiveSha256?: string;
  readonly downloadUrl?: string;
};

export type WrenchClientLocalCliToolIdentity = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly implementation: string;
  readonly versionScheme: "semver" | "opaque";
  readonly version: string;
  readonly releaseCommit?: string;
  readonly releaseManifestSha256?: string;
  readonly releaseManifestUrl?: string;
  readonly sourceUrl?: string;
  readonly artifacts: readonly WrenchClientLocalCliToolArtifactIdentity[];
};

export type WrenchClientLocalCliContractIdentity = {
  readonly surface: string;
  readonly action: string;
  readonly version: number;
  readonly hash: string;
  readonly tool: WrenchClientLocalCliToolIdentity;
};

export type WrenchClientRunReceiptCommon = {
  readonly runId: string;
  readonly planDigest: null;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly operation: string;
  readonly risk: "R1";
  readonly inputHash: string;
  readonly auth: {
    readonly id: string;
    readonly hash: string;
    readonly kind:
      | "browser-profile"
      | "cookie-source"
      | "cookies-file"
      | "linked-device-store"
      | "oauth-token-file"
      | "public-web-session";
  };
  readonly status: "succeeded" | "failed";
  readonly dispatchStarted: false;
  readonly dispatch: {
    readonly planned: 0;
    readonly started: 0;
    readonly verified: 0;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly finalOrigin: string | null;
  readonly error: string | null;
};

export type WrenchClientRunReceipt = WrenchClientRunReceiptCommon & (
  | {
      readonly schemaVersion: 2;
      readonly transport: "browser";
    }
  | {
      readonly schemaVersion: 3;
      readonly transport: "provider-api";
      readonly providerContractHash: string;
    }
  | {
      readonly schemaVersion: 4;
      readonly transport: "web-session-api";
      readonly webSessionContractHash: string;
    }
  | {
      readonly schemaVersion: 5;
      readonly transport: "reviewed-template-api";
      readonly reviewedTemplateContractHash: string;
    }
  | {
      readonly schemaVersion: 6;
      readonly transport: "portable-provider-plugin";
      readonly portablePluginContract: WrenchClientPortableOperationIdentity;
    }
  | {
      readonly schemaVersion: 7;
      readonly transport: "local-cli";
      readonly localCliContract: WrenchClientLocalCliContractIdentity;
    }
);

export type WrenchClientReadFailure =
  | {
      readonly category: "target-unavailable";
      readonly retryDisposition: "do-not-retry";
    }
  | {
      readonly category: "auth-repair-required";
      readonly retryDisposition: "repair-auth";
    }
  | {
      readonly category:
        | "account-mismatch"
        | "contract-drift"
        | "cleanup-required";
      readonly retryDisposition: "do-not-retry";
    }
  | {
      readonly category:
        | "provider-throttled"
        | "provider-temporary"
        | "operation-timeout";
      readonly retryDisposition: "retry-once-after-60s";
    };

type WrenchClientInvocationCommon = {
  readonly replayed: boolean;
};

export type WrenchClientInvocationResult = WrenchClientInvocationCommon & (
  | {
      /** Receipt-bound top-level discriminant for ordinary control flow. */
      readonly status: "succeeded";
      readonly receipt: WrenchClientRunReceipt & { readonly status: "succeeded" };
      readonly output: unknown;
      readonly readFailure?: never;
    }
  | {
      /** Receipt-bound top-level discriminant for ordinary control flow. */
      readonly status: "failed";
      readonly receipt: WrenchClientRunReceipt & { readonly status: "failed" };
      readonly output: null;
      readonly readFailure: WrenchClientReadFailure;
    }
);

export type RevalidatedCapabilityCurrent =
  | Extract<ReadProjectionCacheResult, { readonly status: "hit" }>
  | {
      readonly source: "live";
      readonly output: unknown;
    }
  | null;

export type RevalidatedCapability = {
  readonly cachedBefore: ReadProjectionCacheResult | null;
  readonly cachedAfter: ReadProjectionCacheResult | null;
  readonly current: RevalidatedCapabilityCurrent;
  readonly live: WrenchClientInvocationResult;
  readonly cache: ReadProjectionCacheOutcome;
};

export declare function readCachedCapability(
  request: CapabilityReadRequest,
  options?: ReadCapabilityOptions,
): ReadProjectionCacheResult;

export declare function revalidateCapability(
  request: CapabilityReadRequest,
  options?: RevalidateCapabilityOptions,
): Promise<RevalidatedCapability>;

/**
 * Invoke one live R1 capability and return a discriminated result whose failed
 * branch carries the closed read-failure category and retry disposition.
 */
export declare function invokeCapability(
  request: CapabilityReadRequest,
  options?: InvokeCapabilityOptions,
): Promise<WrenchClientInvocationResult>;

/**
 * Synchronous form for local CLI applications that cannot make their command
 * surface asynchronous. It retains the same pre/post identity fences and
 * discriminated failure policy.
 */
export declare function invokeCapabilitySync(
  request: CapabilityReadRequest,
  options?: InvokeCapabilitySyncOptions,
): WrenchClientInvocationResult;

export declare function staleWhileRevalidateCapability(
  request: CapabilityReadRequest,
  options?: RevalidateCapabilityOptions,
): {
  readonly cached: ReadProjectionCacheResult | null;
  readonly revalidation: Promise<RevalidatedCapability>;
};
