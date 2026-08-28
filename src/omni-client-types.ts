/**
 * Dependency-free public data transfer types for `@hraness/wrench/omni`.
 *
 * Keep this module free of runtime, provider, Bun, and internal model imports
 * so consumers can inspect the SDK contract without loading Wrench internals.
 */

export type OmniClientEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type OmniEntityKindV1 = "conversation" | "message" | "notification";

export type OmniJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OmniJsonValue[]
  | { readonly [key: string]: OmniJsonValue };

export type OmniViewSourceRequest = {
  readonly adapterId: string;
  readonly operationId: "messaging.list" | "messaging.read";
  readonly authId: string;
  readonly input?: unknown;
};

export type OmniViewRequest = {
  readonly schemaVersion: 1;
  readonly sources: readonly OmniViewSourceRequest[];
  readonly filter?: {
    readonly kinds?: readonly OmniEntityKindV1[];
    readonly conversationId?: string;
    readonly unread?: boolean;
  };
  readonly page?: {
    readonly limit?: number;
    readonly cursor?: string;
  };
};

export type ReadOmniViewOptions = {
  readonly environment?: OmniClientEnvironment;
};

export type RevalidateOmniViewOptions = ReadOmniViewOptions & {
  readonly headed?: boolean;
  readonly signal?: AbortSignal;
};

export type OmniParticipantV1 = {
  readonly providerId: string | null;
  readonly displayName: string | null;
  readonly handle: string | null;
};

export type OmniAttachmentV1 = {
  readonly kind:
    | "audio"
    | "document"
    | "image"
    | "link"
    | "sticker"
    | "video"
    | "unknown";
  readonly mimeType: string | null;
  readonly name: string | null;
  readonly sizeBytes: number | null;
};

type OmniEntityCommonV1 = {
  readonly id: string;
  readonly revision: string;
  readonly providerId: string;
  readonly providerRevision: string | null;
  readonly orderedAt: string | null;
  readonly source: {
    readonly surfaceId: string;
    readonly authId: string;
    readonly providerId: string;
  };
  readonly conversationId: string | null;
};

export type OmniConversationV1 = OmniEntityCommonV1 & {
  readonly kind: "conversation";
  readonly conversationKind: "single" | "group" | "unknown";
  readonly detail: "summary" | "full";
  readonly title: string | null;
  readonly summary: string | null;
  readonly participants: readonly OmniParticipantV1[];
  readonly unread: boolean | null;
  readonly unreadCount: number | null;
  readonly archived: boolean | null;
  readonly pending: boolean | null;
};

export type OmniMessageV1 = OmniEntityCommonV1 & {
  readonly kind: "message";
  readonly conversationProviderId: string | null;
  readonly sender: OmniParticipantV1 | null;
  readonly recipients: readonly OmniParticipantV1[];
  readonly direction: "incoming" | "outgoing" | "unknown";
  readonly subject: string | null;
  readonly body: string | null;
  /** Present when the materializer declares whether body is a bounded prefix. */
  readonly bodyTruncated?: boolean;
  readonly unread: boolean | null;
  readonly replyToProviderId: string | null;
  readonly state:
    | "active"
    | "revoked"
    | "deleted-for-me"
    | "revoked-and-deleted-for-me";
  readonly attachments: readonly OmniAttachmentV1[];
};

export type OmniNotificationV1 = OmniEntityCommonV1 & {
  readonly kind: "notification";
  readonly actor: OmniParticipantV1 | null;
  readonly subject: string | null;
  readonly body: string | null;
  readonly unread: boolean | null;
  readonly context: string | null;
};

export type OmniEntityV1 =
  | OmniConversationV1
  | OmniMessageV1
  | OmniNotificationV1;

export type OmniExactFreshnessV1 = {
  readonly state: "fresh" | "stale" | "unclassified";
  readonly freshForMs: number | null;
};

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
      readonly freshness: OmniExactFreshnessV1;
    }
  | {
      readonly state: "error";
      readonly key: string;
      readonly reason: string;
    };

export type OmniNormalizationSourceStatusV1 =
  | {
      readonly state: "missing";
    }
  | {
      readonly state: "unsupported";
      readonly reason: string;
    }
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
      readonly exactDataRevision: string | null;
      readonly normalizedExactDataRevision: string | null;
      readonly lastGoodAt: string | null;
      readonly reason: string;
    }
  | {
      readonly state: "error";
      readonly reason: string;
      readonly lastGoodAt: string | null;
    };

export type OmniCoverageSourceStatusV1 =
  | {
      readonly state: "unavailable";
      readonly reason: string;
    }
  | {
      readonly state: "observed";
      readonly kind:
        | "complete"
        | "page"
        | "unknown"
        | "first-page-only"
        | "bounded-local"
        | "search-window"
        | "truncated";
      readonly continuation: "none" | "pending" | "unavailable";
      readonly reason: string | null;
    };

export type OmniViewSourceStatusV1 = {
  readonly adapterId: string;
  readonly operationId: "messaging.list" | "messaging.read";
  readonly authId: string;
  /** SHA-256 of the exact canonical input in the public source request. */
  readonly requestInputHash: string;
  /** SHA-256 of the provider-parsed/defaulted projection input. */
  readonly projectionInputHash: string;
  /** Opaque keyed revision of the durable normalized source state, if any. */
  readonly normalizationDataRevision: string | null;
  readonly surfaceId: string;
  readonly exact: OmniExactSourceStatusV1;
  readonly normalization: OmniNormalizationSourceStatusV1;
  readonly coverage: OmniCoverageSourceStatusV1;
};

export type OmniViewV1 = {
  readonly schemaVersion: 1;
  readonly viewRevision: string;
  readonly entities: readonly OmniEntityV1[];
  readonly nextCursor: string | null;
  readonly sources: readonly OmniViewSourceStatusV1[];
};

export type OmniViewIdentity = {
  /** Full canonical SDK/CLI invocation, including the local page cursor. */
  readonly invocationDigest: string;
  /** Cursor-independent semantic view request identity. */
  readonly requestDigest: string;
  readonly sourceSetDigest: string;
};

export type OmniViewCacheResult = {
  readonly schemaVersion: 1;
  readonly source: "omni-cache";
  readonly identity: OmniViewIdentity;
  readonly view: OmniViewV1;
};

export type OmniViewLiveResult = {
  readonly schemaVersion: 1;
  readonly source: "omni-live";
  readonly identity: OmniViewIdentity;
  readonly view: OmniViewV1;
};

/**
 * A causally merged post-live view: durable rows/cursors come from the later
 * cache observation while source-local transient live failures are retained.
 */
export type OmniViewMergedResult = {
  readonly schemaVersion: 1;
  readonly source: "omni-merged";
  readonly identity: OmniViewIdentity;
  readonly view: OmniViewV1;
};

export type OmniViewExactCacheResult = {
  readonly schemaVersion: 1;
  readonly source: "omni-exact-cache";
  readonly identity: OmniViewIdentity;
  readonly view: OmniViewV1;
};

export type RevalidatedOmniViewCurrent =
  | OmniViewCacheResult
  | OmniViewLiveResult
  | OmniViewMergedResult;

export type RevalidatedOmniView = {
  readonly cachedBefore: OmniViewCacheResult | null;
  readonly cachedAfter: OmniViewCacheResult | null;
  readonly live: OmniViewLiveResult;
  readonly current: RevalidatedOmniViewCurrent;
};

export declare function readCachedOmniView(
  request: OmniViewRequest,
  options?: ReadOmniViewOptions,
): OmniViewCacheResult;

export declare function revalidateOmniView(
  request: OmniViewRequest,
  options?: RevalidateOmniViewOptions,
): Promise<RevalidatedOmniView>;

export declare function staleWhileRevalidateOmniView(
  request: OmniViewRequest,
  options?: RevalidateOmniViewOptions,
): {
  readonly cached: OmniViewCacheResult | null;
  readonly revalidation: Promise<RevalidatedOmniView>;
};
