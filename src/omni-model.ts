import { types as nodeTypes } from "node:util";

import { canonicalJson, sha256 } from "./canonical-json";

export const OMNI_SCHEMA_VERSION = 1 as const;
export const OMNI_MAX_PAGE_ENTITIES = 1_000;
export const OMNI_MAX_SOURCE_ENTITIES = 5_000;
export const OMNI_MAX_SOURCE_PAGES = 256;
export const OMNI_MAX_COMPLETE_COVERAGE = 256;
export const OMNI_MAX_NORMALIZATION_FRONTIERS = 512;
export const OMNI_MAX_TOMBSTONES = 5_000;
export const OMNI_MAX_SOURCE_BYTES = 12 * 1024 * 1024;

/**
 * A provider-local shape diagnostic retained only inside encrypted normalized
 * state. Public boundaries must replace it with a categorical reason because
 * third-party materializers and foreign property names are not trusted text.
 */
export class OmniMaterializerDriftError extends Error {
  override readonly name = "OmniMaterializerDriftError";
  readonly provider: string;
  readonly path: string;
  readonly diagnostic: string;

  constructor(
    provider: string,
    path: string,
    diagnostic: string,
  ) {
    super(`${provider} omni ${path} ${diagnostic}`);
    this.provider = provider;
    this.path = path;
    this.diagnostic = diagnostic;
  }
}

export type OmniEntityKindV1 = "conversation" | "message" | "notification";
export type OmniCompletenessKindV1 =
  | "complete"
  | "page"
  | "unknown"
  | "first-page-only"
  | "bounded-local"
  | "search-window"
  | "truncated";

export type OmniJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OmniJsonValue[]
  | { readonly [key: string]: OmniJsonValue };

export type OmniParticipantV1 = {
  readonly providerId: string | null;
  readonly displayName: string | null;
  readonly handle: string | null;
};

export type OmniAttachmentV1 = {
  readonly kind: "audio" | "document" | "image" | "link" | "sticker" | "video" | "unknown";
  readonly mimeType: string | null;
  readonly name: string | null;
  readonly sizeBytes: number | null;
};

type ProviderEntityCommonV1 = {
  readonly providerId: string;
  readonly providerRevision: string | null;
  readonly orderedAt: string | null;
};

export type ProviderConversationV1 = ProviderEntityCommonV1 & {
  readonly kind: "conversation";
  readonly conversationKind: "single" | "group" | "unknown";
  readonly detail: "summary" | "full";
  readonly title: string | null;
  readonly summary: string | null;
  readonly participants: readonly OmniParticipantV1[];
  /** Independent provider marker; may be true even when unreadCount is zero. */
  readonly unread: boolean | null;
  readonly unreadCount: number | null;
  readonly archived: boolean | null;
  readonly pending: boolean | null;
};

export type ProviderMessageV1 = ProviderEntityCommonV1 & {
  readonly kind: "message";
  readonly conversationProviderId: string | null;
  readonly sender: OmniParticipantV1 | null;
  readonly recipients: readonly OmniParticipantV1[];
  readonly direction: "incoming" | "outgoing" | "unknown";
  readonly subject: string | null;
  readonly body: string | null;
  /** Present when a materializer can prove whether body is a bounded prefix. */
  readonly bodyTruncated?: boolean;
  readonly unread: boolean | null;
  readonly replyToProviderId: string | null;
  readonly state: "active" | "revoked" | "deleted-for-me" | "revoked-and-deleted-for-me";
  readonly attachments: readonly OmniAttachmentV1[];
};

export type ProviderNotificationV1 = ProviderEntityCommonV1 & {
  readonly kind: "notification";
  readonly actor: OmniParticipantV1 | null;
  readonly subject: string | null;
  readonly body: string | null;
  readonly unread: boolean | null;
  readonly context: string | null;
};

export type ProviderMaterializedEntityV1 =
  | ProviderConversationV1
  | ProviderMessageV1
  | ProviderNotificationV1;

export type ProviderMaterializedPageV1 = {
  readonly schemaVersion: 1;
  readonly partition: string;
  readonly completeness: {
    readonly kind: OmniCompletenessKindV1;
    readonly reason: string | null;
  };
  readonly cursor: {
    readonly direction: "forward" | "backward" | "none";
    /** Opaque provider cursor used to request this page, retained only in ciphertext. */
    readonly request: string | null;
    /** Exact validated provider input for the next page, retained only in ciphertext. */
    readonly nextInput: Readonly<Record<string, OmniJsonValue>> | null;
  };
  readonly entities: readonly ProviderMaterializedEntityV1[];
  readonly tombstones: readonly {
    readonly kind: OmniEntityKindV1;
    readonly providerId: string;
    readonly providerRevision: string | null;
  }[];
};

export type OmniSourceIdentityV1 = {
  readonly schemaVersion: 1;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly plugin: {
    readonly id: string;
    readonly version: string;
    readonly closureHash: string;
  };
  readonly surfaceId: string;
  readonly auth: {
    readonly id: string;
    readonly kind: string;
    readonly hash: string;
    readonly subject: string;
  };
};

export type OmniPageProvenanceV1 = {
  readonly operation: "messaging.list" | "messaging.read";
  readonly inputHash: string;
  readonly exactQueryKey: string;
  readonly exactDataRevision: string;
  readonly validatedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runId: string;
  readonly materializerId: string;
  readonly materializerVersion: number;
};

export type OmniEntityV1 = ProviderMaterializedEntityV1 & {
  /** Account-lifetime-scoped opaque Wrench identity. */
  readonly id: string;
  /** Canonical revision of the normalized semantic bytes. */
  readonly revision: string;
  readonly source: {
    readonly surfaceId: string;
    readonly authId: string;
    readonly providerId: string;
  };
  readonly conversationId: string | null;
};

export type OmniStoredEntityV1 = {
  readonly entity: OmniEntityV1;
  /** Partitions where this identity has been observed since their latest coverage reset. */
  readonly partitions: readonly string[];
  readonly observationOrder: string;
  readonly provenance: OmniPageProvenanceV1;
};

export type OmniStoredPageV1 = {
  readonly key: string;
  readonly partition: string;
  readonly completeness: ProviderMaterializedPageV1["completeness"];
  readonly cursor: ProviderMaterializedPageV1["cursor"];
  readonly orderedEntityIds: readonly string[];
  /** Explicit deletion observations, including their provider revision, are membership. */
  readonly tombstones: readonly {
    readonly id: string;
    readonly kind: OmniEntityKindV1;
    readonly providerId: string;
    readonly providerRevision: string | null;
  }[];
  readonly observationOrder: string;
  readonly provenance: OmniPageProvenanceV1;
};

export type OmniCompleteCoverageV1 = {
  readonly partition: string;
  readonly pageKey: string;
  /** Revision of the complete stored page, including entity and tombstone membership. */
  readonly pageRevision: string;
  readonly observationOrder: string;
  readonly provenance: OmniPageProvenanceV1;
};

export type OmniStoredTombstoneV1 = {
  readonly id: string;
  readonly kind: OmniEntityKindV1;
  readonly providerId: string;
  readonly providerRevision: string | null;
  readonly observationOrder: string;
  readonly provenance: OmniPageProvenanceV1;
};

export type OmniNormalizationStatusV1 =
  | {
      readonly state: "ready";
      readonly lastGoodAt: string;
      readonly exactDataRevision: string;
    }
  | {
      readonly state: "drift";
      readonly failedAt: string;
      readonly exactDataRevision: string;
      readonly code: "materializer-drift" | "capacity-exceeded";
      readonly message: string;
      readonly lastGoodAt: string | null;
      readonly lastGoodExactDataRevision: string | null;
    };

export type OmniNormalizationFrontierV1 = {
  readonly exactQueryKey: string;
  readonly status: OmniNormalizationStatusV1;
};

export type OmniSourceStateV1 = {
  readonly schemaVersion: 1;
  readonly source: OmniSourceIdentityV1;
  readonly entities: readonly OmniStoredEntityV1[];
  readonly pages: readonly OmniStoredPageV1[];
  readonly completeCoverage: readonly OmniCompleteCoverageV1[];
  readonly tombstones: readonly OmniStoredTombstoneV1[];
  readonly normalization: readonly OmniNormalizationFrontierV1[];
};

type JsonRecord = Readonly<Record<string, unknown>>;

function fail(label: string, message: string): never {
  throw new Error(`${label} ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return fail(label, "must be a plain non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return fail(label, "must not contain symbol properties");
  }
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label}.${key}`, "must be an enumerable data property");
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) return fail(label, `must contain exactly ${expected.join(", ")}`);
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) return fail(label, `must be a plain array of at most ${maximum} items`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    return fail(label, "must be a dense array without named properties");
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label}[${index}]`, "must be an enumerable data property");
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function text(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximum
    || (!allowEmpty && value.length === 0)
    || [...value].some((character) => {
      const code = character.codePointAt(0) ?? -1;
      return code === 0
        || code === 8
        || code === 11
        || code === 12
        || (code >= 14 && code <= 31)
        || code === 127;
    })
  ) return fail(label, "must be bounded text");
  return value;
}

function nullableText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string | null {
  return value === null ? null : text(value, label, maximum, allowEmpty);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return fail(label, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function nullableInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  return value === null ? null : integer(value, label, minimum, maximum);
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  return fail(label, "must be boolean or null");
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  return fail(label, "must be boolean");
}

function digest(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) return fail(label, "must be a SHA-256 digest");
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    return fail(label, "must be a canonical ISO timestamp");
  }
  return result;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function uuid(value: unknown, label: string): string {
  const result = text(value, label, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result)) {
    return fail(label, "must be a lowercase UUIDv4");
  }
  return result;
}

function oneOf<const T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    return fail(label, `must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function cloneJson(
  value: unknown,
  label: string,
  depth = 0,
  nodes = { count: 0 },
): OmniJsonValue {
  nodes.count += 1;
  if (depth > 16 || nodes.count > 10_000) return fail(label, "exceeds its JSON bound");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? text(value, label, 64 * 1024, true) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail(label, "must contain only finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(array(value, label, 1_000).map((entry, index) =>
      cloneJson(entry, `${label}[${index}]`, depth + 1, nodes)));
  }
  const source = record(value, label);
  const keys = Object.keys(source).sort();
  if (keys.length > 1_000) return fail(label, "has too many properties");
  const result: Record<string, OmniJsonValue> = Object.create(null) as Record<string, OmniJsonValue>;
  for (const key of keys) {
    text(key, `${label} key`, 256);
    result[key] = cloneJson(source[key], `${label}.${key}`, depth + 1, nodes);
  }
  return Object.freeze(result);
}

function jsonRecord(value: unknown, label: string): Readonly<Record<string, OmniJsonValue>> {
  const cloned = cloneJson(value, label);
  return record(cloned, label) as Readonly<Record<string, OmniJsonValue>>;
}

function participant(value: unknown, label: string): OmniParticipantV1 {
  const source = record(value, label);
  exactKeys(source, ["providerId", "displayName", "handle"], label);
  return Object.freeze({
    providerId: nullableText(source.providerId, `${label}.providerId`, 1_024),
    displayName: nullableText(source.displayName, `${label}.displayName`, 2_048, true),
    handle: nullableText(source.handle, `${label}.handle`, 512),
  });
}

function attachment(value: unknown, label: string): OmniAttachmentV1 {
  const source = record(value, label);
  exactKeys(source, ["kind", "mimeType", "name", "sizeBytes"], label);
  return Object.freeze({
    kind: oneOf(source.kind, ["audio", "document", "image", "link", "sticker", "video", "unknown"] as const, `${label}.kind`),
    mimeType: nullableText(source.mimeType, `${label}.mimeType`, 256),
    name: nullableText(source.name, `${label}.name`, 2_048, true),
    sizeBytes: nullableInteger(source.sizeBytes, `${label}.sizeBytes`, 0, Number.MAX_SAFE_INTEGER),
  });
}

function entity(value: unknown, label: string): ProviderMaterializedEntityV1 {
  const source = record(value, label);
  const kind = oneOf(source.kind, ["conversation", "message", "notification"] as const, `${label}.kind`);
  const common = {
    kind,
    providerId: text(source.providerId, `${label}.providerId`, 1_024),
    providerRevision: nullableText(source.providerRevision, `${label}.providerRevision`, 1_024),
    orderedAt: nullableTimestamp(source.orderedAt, `${label}.orderedAt`),
  } as const;
  if (kind === "conversation") {
    exactKeys(source, [
      "kind", "providerId", "providerRevision", "orderedAt", "conversationKind", "detail", "title",
      "summary", "participants", "unread", "unreadCount", "archived", "pending",
    ], label);
    return Object.freeze({
      ...common,
      kind,
      conversationKind: oneOf(
        source.conversationKind,
        ["single", "group", "unknown"] as const,
        `${label}.conversationKind`,
      ),
      detail: oneOf(source.detail, ["summary", "full"] as const, `${label}.detail`),
      title: nullableText(source.title, `${label}.title`, 4_096, true),
      summary: nullableText(source.summary, `${label}.summary`, 64 * 1024, true),
      participants: Object.freeze(array(source.participants, `${label}.participants`, 256)
        .map((entry, index) => participant(entry, `${label}.participants[${index}]`))),
      unread: nullableBoolean(source.unread, `${label}.unread`),
      unreadCount: nullableInteger(source.unreadCount, `${label}.unreadCount`, 0, Number.MAX_SAFE_INTEGER),
      archived: nullableBoolean(source.archived, `${label}.archived`),
      pending: nullableBoolean(source.pending, `${label}.pending`),
    });
  }
  if (kind === "message") {
    const hasBodyTruncated = Object.hasOwn(source, "bodyTruncated");
    exactKeys(source, [
      "kind", "providerId", "providerRevision", "orderedAt", "conversationProviderId",
      "sender", "recipients", "direction", "subject", "body", "unread",
      "replyToProviderId", "state", "attachments",
      ...(hasBodyTruncated ? ["bodyTruncated"] : []),
    ], label);
    const body = nullableText(source.body, `${label}.body`, 256 * 1024, true);
    const bodyTruncated = hasBodyTruncated
      ? boolean(source.bodyTruncated, `${label}.bodyTruncated`)
      : undefined;
    if (body === null && bodyTruncated === true) {
      return fail(`${label}.bodyTruncated`, "cannot be true when body is null");
    }
    return Object.freeze({
      ...common,
      kind,
      conversationProviderId: nullableText(source.conversationProviderId, `${label}.conversationProviderId`, 1_024),
      sender: source.sender === null ? null : participant(source.sender, `${label}.sender`),
      recipients: Object.freeze(array(source.recipients, `${label}.recipients`, 256)
        .map((entry, index) => participant(entry, `${label}.recipients[${index}]`))),
      direction: oneOf(source.direction, ["incoming", "outgoing", "unknown"] as const, `${label}.direction`),
      subject: nullableText(source.subject, `${label}.subject`, 8_192, true),
      body,
      ...(bodyTruncated === undefined ? {} : { bodyTruncated }),
      unread: nullableBoolean(source.unread, `${label}.unread`),
      replyToProviderId: nullableText(source.replyToProviderId, `${label}.replyToProviderId`, 1_024),
      state: oneOf(source.state, ["active", "revoked", "deleted-for-me", "revoked-and-deleted-for-me"] as const, `${label}.state`),
      attachments: Object.freeze(array(source.attachments, `${label}.attachments`, 64)
        .map((entry, index) => attachment(entry, `${label}.attachments[${index}]`))),
    });
  }
  exactKeys(source, [
    "kind", "providerId", "providerRevision", "orderedAt", "actor", "subject",
    "body", "unread", "context",
  ], label);
  return Object.freeze({
    ...common,
    kind,
    actor: source.actor === null ? null : participant(source.actor, `${label}.actor`),
    subject: nullableText(source.subject, `${label}.subject`, 8_192, true),
    body: nullableText(source.body, `${label}.body`, 256 * 1024, true),
    unread: nullableBoolean(source.unread, `${label}.unread`),
    context: nullableText(source.context, `${label}.context`, 8_192),
  });
}

function completeness(value: unknown, label: string): ProviderMaterializedPageV1["completeness"] {
  const source = record(value, label);
  exactKeys(source, ["kind", "reason"], label);
  return Object.freeze({
    kind: oneOf(source.kind, ["complete", "page", "unknown", "first-page-only", "bounded-local", "search-window", "truncated"] as const, `${label}.kind`),
    reason: nullableText(source.reason, `${label}.reason`, 2_048),
  });
}

function cursor(value: unknown, label: string): ProviderMaterializedPageV1["cursor"] {
  const source = record(value, label);
  exactKeys(source, ["direction", "request", "nextInput"], label);
  const direction = oneOf(source.direction, ["forward", "backward", "none"] as const, `${label}.direction`);
  const request = nullableText(source.request, `${label}.request`, 8_192);
  const nextInput = source.nextInput === null
    ? null
    : jsonRecord(source.nextInput, `${label}.nextInput`);
  if (direction === "none" && (request !== null || nextInput !== null)) {
    return fail(label, "cannot retain provider cursors when direction is none");
  }
  return Object.freeze({ direction, request, nextInput });
}

export function parseMaterializedPageV1(value: unknown): ProviderMaterializedPageV1 {
  const source = record(value, "omni materialized page");
  exactKeys(source, [
    "schemaVersion", "partition", "completeness", "cursor", "entities",
    "tombstones",
  ], "omni materialized page");
  if (source.schemaVersion !== 1) return fail("omni materialized page.schemaVersion", "must be 1");
  const parsedCursor = cursor(source.cursor, "omni materialized page.cursor");
  const parsedCompleteness = completeness(source.completeness, "omni materialized page.completeness");
  if (
    parsedCompleteness.kind === "complete"
    && (parsedCursor.request !== null || parsedCursor.nextInput !== null)
  ) {
    return fail(
      "omni materialized page",
      "complete partition coverage must begin at the root and cannot name another provider page",
    );
  }
  if (
    parsedCompleteness.kind === "first-page-only"
    && (
      parsedCursor.direction !== "none"
      || parsedCursor.request !== null
      || parsedCursor.nextInput !== null
    )
  ) {
    return fail(
      "omni materialized page",
      "first-page-only coverage cannot declare a replayable provider continuation",
    );
  }
  const entities = array(source.entities, "omni materialized page.entities", OMNI_MAX_PAGE_ENTITIES)
    .map((entry, index) => entity(entry, `omni materialized page.entities[${index}]`));
  const entityKeys = entities.map((entry) => `${entry.kind}\0${entry.providerId}`);
  if (new Set(entityKeys).size !== entityKeys.length) {
    return fail("omni materialized page.entities", "must not repeat a stable entity identity");
  }
  const tombstones = array(source.tombstones, "omni materialized page.tombstones", OMNI_MAX_PAGE_ENTITIES)
    .map((entry, index) => {
      const label = `omni materialized page.tombstones[${index}]`;
      const value = record(entry, label);
      exactKeys(value, ["kind", "providerId", "providerRevision"], label);
      return Object.freeze({
        kind: oneOf(value.kind, ["conversation", "message", "notification"] as const, `${label}.kind`),
        providerId: text(value.providerId, `${label}.providerId`, 1_024),
        providerRevision: nullableText(value.providerRevision, `${label}.providerRevision`, 1_024),
      });
    });
  const tombstoneKeys = tombstones.map((entry) => `${entry.kind}\0${entry.providerId}`);
  if (
    new Set(tombstoneKeys).size !== tombstoneKeys.length
    || tombstoneKeys.some((key) => entityKeys.includes(key))
  ) return fail("omni materialized page.tombstones", "must be unique and cannot contradict present entities");
  return Object.freeze({
    schemaVersion: 1,
    partition: text(source.partition, "omni materialized page.partition", 1_024),
    completeness: parsedCompleteness,
    cursor: parsedCursor,
    entities: Object.freeze(entities),
    tombstones: Object.freeze(tombstones),
  });
}

function sourceIdentity(value: unknown, label: string): OmniSourceIdentityV1 {
  const source = record(value, label);
  exactKeys(source, ["schemaVersion", "adapter", "plugin", "surfaceId", "auth"], label);
  if (source.schemaVersion !== 1) return fail(`${label}.schemaVersion`, "must be 1");
  const adapter = record(source.adapter, `${label}.adapter`);
  exactKeys(adapter, ["id", "version", "hash"], `${label}.adapter`);
  const plugin = record(source.plugin, `${label}.plugin`);
  exactKeys(plugin, ["id", "version", "closureHash"], `${label}.plugin`);
  const auth = record(source.auth, `${label}.auth`);
  exactKeys(auth, ["id", "kind", "hash", "subject"], `${label}.auth`);
  return Object.freeze({
    schemaVersion: 1,
    adapter: Object.freeze({
      id: text(adapter.id, `${label}.adapter.id`, 64),
      version: text(adapter.version, `${label}.adapter.version`, 64),
      hash: digest(adapter.hash, `${label}.adapter.hash`),
    }),
    plugin: Object.freeze({
      id: text(plugin.id, `${label}.plugin.id`, 64),
      version: text(plugin.version, `${label}.plugin.version`, 64),
      closureHash: digest(plugin.closureHash, `${label}.plugin.closureHash`),
    }),
    surfaceId: text(source.surfaceId, `${label}.surfaceId`, 64),
    auth: Object.freeze({
      id: text(auth.id, `${label}.auth.id`, 64),
      kind: text(auth.kind, `${label}.auth.kind`, 64),
      hash: digest(auth.hash, `${label}.auth.hash`),
      subject: text(auth.subject, `${label}.auth.subject`, 512),
    }),
  });
}

function provenance(value: unknown, label: string): OmniPageProvenanceV1 {
  const source = record(value, label);
  exactKeys(source, [
    "operation", "inputHash", "exactQueryKey", "exactDataRevision", "validatedAt",
    "startedAt", "finishedAt", "runId", "materializerId", "materializerVersion",
  ], label);
  const startedAt = timestamp(source.startedAt, `${label}.startedAt`);
  const finishedAt = timestamp(source.finishedAt, `${label}.finishedAt`);
  if (startedAt > finishedAt) return fail(label, "cannot finish before it starts");
  return Object.freeze({
    operation: oneOf(source.operation, ["messaging.list", "messaging.read"] as const, `${label}.operation`),
    inputHash: digest(source.inputHash, `${label}.inputHash`),
    exactQueryKey: digest(source.exactQueryKey, `${label}.exactQueryKey`),
    exactDataRevision: digest(source.exactDataRevision, `${label}.exactDataRevision`),
    validatedAt: timestamp(source.validatedAt, `${label}.validatedAt`),
    startedAt,
    finishedAt,
    runId: uuid(source.runId, `${label}.runId`),
    materializerId: text(source.materializerId, `${label}.materializerId`, 64),
    materializerVersion: integer(source.materializerVersion, `${label}.materializerVersion`, 1, 1_000_000),
  });
}

export function omniObservationOrder(value: OmniPageProvenanceV1): string {
  return `${value.startedAt}\0${value.finishedAt}\0${value.runId}`;
}

function observationOrderText(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256) {
    return fail(label, "must be a bounded observation order");
  }
  return value;
}

function normalizedId(
  source: OmniSourceIdentityV1,
  kind: OmniEntityKindV1,
  providerId: string,
): string {
  return sha256(canonicalJson({
    schemaVersion: 1,
    authHash: source.auth.hash,
    surfaceId: source.surfaceId,
    kind,
    providerId,
  }));
}

function publicEntity(
  source: OmniSourceIdentityV1,
  value: ProviderMaterializedEntityV1,
): OmniEntityV1 {
  const id = normalizedId(source, value.kind, value.providerId);
  const conversationId = value.kind === "message" && value.conversationProviderId !== null
    ? normalizedId(source, "conversation", value.conversationProviderId)
    : null;
  const semantic = Object.freeze({
    ...value,
    id,
    source: Object.freeze({
      surfaceId: source.surfaceId,
      authId: source.auth.id,
      providerId: value.providerId,
    }),
    conversationId,
  });
  return Object.freeze({
    ...semantic,
    revision: sha256(canonicalJson(semantic)),
  });
}

function parsePublicEntity(value: unknown, label: string): OmniEntityV1 {
  const source = record(value, label);
  const kind = oneOf(source.kind, ["conversation", "message", "notification"] as const, `${label}.kind`);
  const hasBodyTruncated = kind === "message" && Object.hasOwn(source, "bodyTruncated");
  const providerKeys = kind === "conversation"
    ? ["kind", "providerId", "providerRevision", "orderedAt", "conversationKind", "detail", "title", "summary", "participants", "unread", "unreadCount", "archived", "pending"]
    : kind === "message"
      ? ["kind", "providerId", "providerRevision", "orderedAt", "conversationProviderId", "sender", "recipients", "direction", "subject", "body", ...(hasBodyTruncated ? ["bodyTruncated"] : []), "unread", "replyToProviderId", "state", "attachments"]
      : ["kind", "providerId", "providerRevision", "orderedAt", "actor", "subject", "body", "unread", "context"];
  const expectedKeys = kind === "conversation"
    ? ["kind", "providerId", "providerRevision", "orderedAt", "conversationKind", "detail", "title", "summary", "participants", "unread", "unreadCount", "archived", "pending", "id", "revision", "source", "conversationId"]
    : kind === "message"
      ? ["kind", "providerId", "providerRevision", "orderedAt", "conversationProviderId", "sender", "recipients", "direction", "subject", "body", ...(hasBodyTruncated ? ["bodyTruncated"] : []), "unread", "replyToProviderId", "state", "attachments", "id", "revision", "source", "conversationId"]
      : ["kind", "providerId", "providerRevision", "orderedAt", "actor", "subject", "body", "unread", "context", "id", "revision", "source", "conversationId"];
  exactKeys(source, expectedKeys, label);
  const providerInput = Object.fromEntries(
    providerKeys.map((key) => [key, source[key]]),
  );
  const provider = entity(providerInput, `${label} provider fields`);
  const entitySource = record(source.source, `${label}.source`);
  exactKeys(entitySource, ["surfaceId", "authId", "providerId"], `${label}.source`);
  const semantic = Object.freeze({
    ...provider,
    id: digest(source.id, `${label}.id`),
    source: Object.freeze({
      surfaceId: text(entitySource.surfaceId, `${label}.source.surfaceId`, 64),
      authId: text(entitySource.authId, `${label}.source.authId`, 64),
      providerId: text(entitySource.providerId, `${label}.source.providerId`, 1_024),
    }),
    conversationId: source.conversationId === null
      ? null
      : digest(source.conversationId, `${label}.conversationId`),
  });
  const revision = digest(source.revision, `${label}.revision`);
  if (sha256(canonicalJson(semantic)) !== revision) {
    return fail(`${label}.revision`, "does not authenticate the normalized semantic bytes");
  }
  return Object.freeze({ ...semantic, revision });
}

function lastGoodNormalization(
  source: JsonRecord,
  label: string,
): Readonly<{
  lastGoodAt: string | null;
  lastGoodExactDataRevision: string | null;
}> {
  const lastGoodAt = source.lastGoodAt === null
    ? null
    : timestamp(source.lastGoodAt, `${label}.lastGoodAt`);
  const lastGoodExactDataRevision = source.lastGoodExactDataRevision === null
    ? null
    : digest(
        source.lastGoodExactDataRevision,
        `${label}.lastGoodExactDataRevision`,
      );
  if ((lastGoodAt === null) !== (lastGoodExactDataRevision === null)) {
    return fail(
      label,
      "must retain last-good time and exact data revision together",
    );
  }
  return Object.freeze({ lastGoodAt, lastGoodExactDataRevision });
}

function normalizationStatus(value: unknown, label: string): OmniNormalizationStatusV1 {
  const source = record(value, label);
  const state = oneOf(source.state, ["ready", "drift"] as const, `${label}.state`);
  if (state === "ready") {
    exactKeys(source, ["state", "lastGoodAt", "exactDataRevision"], label);
    return Object.freeze({
      state,
      lastGoodAt: timestamp(source.lastGoodAt, `${label}.lastGoodAt`),
      exactDataRevision: digest(source.exactDataRevision, `${label}.exactDataRevision`),
    });
  }
  exactKeys(source, [
    "state", "failedAt", "exactDataRevision", "code", "message", "lastGoodAt",
    "lastGoodExactDataRevision",
  ], label);
  const lastGood = lastGoodNormalization(source, label);
  return Object.freeze({
    state,
    failedAt: timestamp(source.failedAt, `${label}.failedAt`),
    exactDataRevision: digest(source.exactDataRevision, `${label}.exactDataRevision`),
    code: oneOf(source.code, ["materializer-drift", "capacity-exceeded"] as const, `${label}.code`),
    message: text(source.message, `${label}.message`, 8_192),
    ...lastGood,
  });
}

function normalizationFrontiers(
  value: unknown,
  label: string,
): readonly OmniNormalizationFrontierV1[] {
  const frontiers = array(value, label, OMNI_MAX_NORMALIZATION_FRONTIERS)
    .map((entry, index) => {
      const entryLabel = `${label}[${index}]`;
      const frontier = record(entry, entryLabel);
      exactKeys(frontier, ["exactQueryKey", "status"], entryLabel);
      return Object.freeze({
        exactQueryKey: digest(
          frontier.exactQueryKey,
          `${entryLabel}.exactQueryKey`,
        ),
        status: normalizationStatus(frontier.status, `${entryLabel}.status`),
      });
    });
  if (
    new Set(frontiers.map((frontier) => frontier.exactQueryKey)).size
    !== frontiers.length
  ) return fail(label, "must not repeat exact query keys");
  if (frontiers.some((frontier, index) =>
    index > 0
    && frontiers[index - 1]!.exactQueryKey.localeCompare(frontier.exactQueryKey) >= 0)) {
    return fail(label, "must be canonically ordered by exact query key");
  }
  return Object.freeze(frontiers);
}

export function parseOmniSourceStateV1(value: unknown): OmniSourceStateV1 {
  const source = record(value, "omni source state");
  exactKeys(source, [
    "schemaVersion", "source", "entities", "pages", "completeCoverage",
    "tombstones", "normalization",
  ], "omni source state");
  if (source.schemaVersion !== 1) return fail("omni source state.schemaVersion", "must be 1");
  const parsedSource = sourceIdentity(source.source, "omni source state.source");
  const entities = array(source.entities, "omni source state.entities", OMNI_MAX_SOURCE_ENTITIES)
    .map((entry, index) => {
      const label = `omni source state.entities[${index}]`;
      const stored = record(entry, label);
      exactKeys(stored, [
        "entity", "partitions", "observationOrder", "provenance",
      ], label);
      const parsedEntity = parsePublicEntity(stored.entity, `${label}.entity`);
      const parsedProvenance = provenance(stored.provenance, `${label}.provenance`);
      const partitions = array(
        stored.partitions,
        `${label}.partitions`,
        OMNI_MAX_SOURCE_PAGES,
      ).map((partition, partitionIndex) =>
        text(partition, `${label}.partitions[${partitionIndex}]`, 1_024));
      if (
        partitions.length === 0
        || new Set(partitions).size !== partitions.length
        || partitions.some((partition, partitionIndex) =>
          partitionIndex > 0
          && partitions[partitionIndex - 1]!.localeCompare(partition) >= 0)
      ) return fail(label, "must retain unique canonically ordered partitions");
      const order = observationOrderText(stored.observationOrder, `${label}.observationOrder`);
      if (order !== omniObservationOrder(parsedProvenance)) return fail(label, "has inconsistent observation order");
      if (
        parsedEntity.source.surfaceId !== parsedSource.surfaceId
        || parsedEntity.source.authId !== parsedSource.auth.id
        || parsedEntity.id !== normalizedId(parsedSource, parsedEntity.kind, parsedEntity.providerId)
      ) return fail(label, "has inconsistent source identity");
      return Object.freeze({
        entity: parsedEntity,
        partitions: Object.freeze(partitions),
        observationOrder: order,
        provenance: parsedProvenance,
      });
    });
  if (new Set(entities.map((entry) => entry.entity.id)).size !== entities.length) {
    return fail("omni source state.entities", "must not repeat entity identities");
  }
  const pages = array(source.pages, "omni source state.pages", OMNI_MAX_SOURCE_PAGES)
    .map((entry, index) => {
      const label = `omni source state.pages[${index}]`;
      const page = record(entry, label);
      exactKeys(page, [
        "key", "partition", "completeness", "cursor", "orderedEntityIds",
        "tombstones", "observationOrder", "provenance",
      ], label);
      const parsedProvenance = provenance(page.provenance, `${label}.provenance`);
      const order = observationOrderText(page.observationOrder, `${label}.observationOrder`);
      if (order !== omniObservationOrder(parsedProvenance)) return fail(label, "has inconsistent observation order");
      const orderedEntityIds = array(page.orderedEntityIds, `${label}.orderedEntityIds`, OMNI_MAX_PAGE_ENTITIES)
        .map((id, entityIndex) => digest(id, `${label}.orderedEntityIds[${entityIndex}]`));
      if (new Set(orderedEntityIds).size !== orderedEntityIds.length) return fail(label, "repeats page membership");
      const pageTombstones = array(
        page.tombstones,
        `${label}.tombstones`,
        OMNI_MAX_PAGE_ENTITIES,
      ).map((entry, tombstoneIndex) => {
        const tombstoneLabel = `${label}.tombstones[${tombstoneIndex}]`;
        const tombstone = record(entry, tombstoneLabel);
        exactKeys(tombstone, [
          "id", "kind", "providerId", "providerRevision",
        ], tombstoneLabel);
        const kind = oneOf(
          tombstone.kind,
          ["conversation", "message", "notification"] as const,
          `${tombstoneLabel}.kind`,
        );
        const providerId = text(
          tombstone.providerId,
          `${tombstoneLabel}.providerId`,
          1_024,
        );
        const id = digest(tombstone.id, `${tombstoneLabel}.id`);
        if (id !== normalizedId(parsedSource, kind, providerId)) {
          return fail(tombstoneLabel, "has inconsistent source identity");
        }
        return Object.freeze({
          id,
          kind,
          providerId,
          providerRevision: nullableText(
            tombstone.providerRevision,
            `${tombstoneLabel}.providerRevision`,
            1_024,
          ),
        });
      });
      const pageTombstoneIds = pageTombstones.map((tombstone) => tombstone.id);
      if (
        new Set(pageTombstoneIds).size !== pageTombstoneIds.length
        || pageTombstoneIds.some((id) => orderedEntityIds.includes(id))
      ) return fail(label, "repeats or contradicts page entity and tombstone membership");
      return Object.freeze({
        key: digest(page.key, `${label}.key`),
        partition: text(page.partition, `${label}.partition`, 1_024),
        completeness: completeness(page.completeness, `${label}.completeness`),
        cursor: cursor(page.cursor, `${label}.cursor`),
        orderedEntityIds: Object.freeze(orderedEntityIds),
        tombstones: Object.freeze(pageTombstones),
        observationOrder: order,
        provenance: parsedProvenance,
      });
    });
  if (new Set(pages.map((page) => page.key)).size !== pages.length) {
    return fail("omni source state.pages", "must not repeat page identities");
  }
  const completeCoverage = array(
    source.completeCoverage,
    "omni source state.completeCoverage",
    OMNI_MAX_COMPLETE_COVERAGE,
  ).map((entry, index) => {
    const label = `omni source state.completeCoverage[${index}]`;
    const coverage = record(entry, label);
    exactKeys(coverage, [
      "partition", "pageKey", "pageRevision", "observationOrder", "provenance",
    ], label);
    const parsedProvenance = provenance(coverage.provenance, `${label}.provenance`);
    const observationOrder = observationOrderText(
      coverage.observationOrder,
      `${label}.observationOrder`,
    );
    if (observationOrder !== omniObservationOrder(parsedProvenance)) {
      return fail(label, "has inconsistent observation order");
    }
    return Object.freeze({
      partition: text(coverage.partition, `${label}.partition`, 1_024),
      pageKey: digest(coverage.pageKey, `${label}.pageKey`),
      pageRevision: digest(coverage.pageRevision, `${label}.pageRevision`),
      observationOrder,
      provenance: parsedProvenance,
    });
  });
  if (
    new Set(completeCoverage.map((coverage) => coverage.partition)).size
    !== completeCoverage.length
  ) return fail("omni source state.completeCoverage", "must not repeat partitions");
  if (completeCoverage.some((coverage, index) =>
    index > 0
    && completeCoverage[index - 1]!.partition.localeCompare(coverage.partition) >= 0)) {
    return fail(
      "omni source state.completeCoverage",
      "must be canonically ordered by partition",
    );
  }
  const tombstones = array(source.tombstones, "omni source state.tombstones", OMNI_MAX_TOMBSTONES)
    .map((entry, index) => {
      const label = `omni source state.tombstones[${index}]`;
      const tombstone = record(entry, label);
      exactKeys(tombstone, ["id", "kind", "providerId", "providerRevision", "observationOrder", "provenance"], label);
      const parsedProvenance = provenance(tombstone.provenance, `${label}.provenance`);
      const kind = oneOf(tombstone.kind, ["conversation", "message", "notification"] as const, `${label}.kind`);
      const providerId = text(tombstone.providerId, `${label}.providerId`, 1_024);
      const id = digest(tombstone.id, `${label}.id`);
      if (id !== normalizedId(parsedSource, kind, providerId)) return fail(label, "has inconsistent source identity");
      const order = observationOrderText(tombstone.observationOrder, `${label}.observationOrder`);
      if (order !== omniObservationOrder(parsedProvenance)) return fail(label, "has inconsistent observation order");
      return Object.freeze({
        id,
        kind,
        providerId,
        providerRevision: nullableText(tombstone.providerRevision, `${label}.providerRevision`, 1_024),
        observationOrder: order,
        provenance: parsedProvenance,
      });
    });
  if (new Set(tombstones.map((entry) => entry.id)).size !== tombstones.length) {
    return fail("omni source state.tombstones", "must not repeat tombstone identities");
  }
  const entitiesById = new Map(entities.map((entry) => [entry.entity.id, entry]));
  const entityIds = new Set(entitiesById.keys());
  const tombstoneIds = new Set(tombstones.map((entry) => entry.id));
  if ([...entityIds].some((id) => tombstoneIds.has(id))) {
    return fail(
      "omni source state",
      "must not retain one identity as both an entity and a tombstone",
    );
  }
  for (const page of pages) {
    if (page.orderedEntityIds.some((id) => !entityIds.has(id) && !tombstoneIds.has(id))) {
      return fail(
        "omni source state.pages",
        "must not reference an unknown entity identity",
      );
    }
    if (page.orderedEntityIds.some((id) => {
      const stored = entitiesById.get(id);
      return stored !== undefined && !stored.partitions.includes(page.partition);
    })) {
      return fail(
        "omni source state.pages",
        "entity membership must name the page partition",
      );
    }
    if (page.tombstones.some((tombstone) => !tombstoneIds.has(tombstone.id))) {
      return fail(
        "omni source state.pages",
        "must not reference an identity that is not a retained tombstone",
      );
    }
  }
  const coverageByPartition = new Map(
    completeCoverage.map((coverage) => [coverage.partition, coverage]),
  );
  for (const page of pages) {
    if (page.completeness.kind !== "complete") continue;
    const coverage = coverageByPartition.get(page.partition);
    if (
      coverage === undefined
      || coverage.pageKey !== page.key
      || coverage.observationOrder !== page.observationOrder
      || coverage.pageRevision !== sha256(canonicalJson(page))
    ) {
      return fail(
        "omni source state.pages",
        "complete page must match its partition coverage watermark",
      );
    }
  }
  for (const coverage of completeCoverage) {
    const retainedSnapshot = pages.find((page) =>
      page.key === coverage.pageKey
      && page.observationOrder === coverage.observationOrder);
    if (
      retainedSnapshot === undefined
      || (
        retainedSnapshot.partition !== coverage.partition
        || retainedSnapshot.completeness.kind !== "complete"
        || sha256(canonicalJson(retainedSnapshot)) !== coverage.pageRevision
      )
    ) {
      return fail(
        "omni source state.completeCoverage",
        "does not authenticate its retained complete page",
      );
    }
  }
  const result = Object.freeze({
    schemaVersion: 1 as const,
    source: parsedSource,
    entities: Object.freeze(entities),
    pages: Object.freeze(pages),
    completeCoverage: Object.freeze(completeCoverage),
    tombstones: Object.freeze(tombstones),
    normalization: normalizationFrontiers(
      source.normalization,
      "omni source state.normalization",
    ),
  });
  if (Buffer.byteLength(canonicalJson(result), "utf8") > OMNI_MAX_SOURCE_BYTES) {
    return fail("omni source state", "exceeds its byte capacity");
  }
  return result;
}

export function reduceOmniSourceStateV1(
  currentValue: unknown,
  pageValue: unknown,
  options: {
    readonly source: OmniSourceIdentityV1;
    readonly provenance: OmniPageProvenanceV1;
  },
): OmniSourceStateV1 {
  const expectedSource = sourceIdentity(options.source, "omni reduction source");
  const nextProvenance = provenance(options.provenance, "omni reduction provenance");
  const page = parseMaterializedPageV1(pageValue);
  const current = currentValue === null ? null : parseOmniSourceStateV1(currentValue);
  if (current !== null && canonicalJson(current.source) !== canonicalJson(expectedSource)) {
    return fail("omni reduction", "cannot cross source, auth lifetime, adapter, or implementation identity");
  }
  const order = omniObservationOrder(nextProvenance);
  const entityMap = new Map((current?.entities ?? []).map((entry) => [entry.entity.id, entry]));
  const tombstoneMap = new Map((current?.tombstones ?? []).map((entry) => [entry.id, entry]));
  const incomingEntities = page.entities.map((providerEntity) =>
    publicEntity(expectedSource, providerEntity));
  const incomingTombstones = page.tombstones.map((providerTombstone) =>
    Object.freeze({
      id: normalizedId(
        expectedSource,
        providerTombstone.kind,
        providerTombstone.providerId,
      ),
      kind: providerTombstone.kind,
      providerId: providerTombstone.providerId,
      providerRevision: providerTombstone.providerRevision,
    }));
  const pageKey = sha256(canonicalJson({
    schemaVersion: 1,
    partition: page.partition,
    operation: nextProvenance.operation,
    inputHash: nextProvenance.inputHash,
    request: page.cursor.request,
  }));
  const nextPage: OmniStoredPageV1 = Object.freeze({
    key: pageKey,
    partition: page.partition,
    completeness: page.completeness,
    cursor: page.cursor,
    orderedEntityIds: Object.freeze(incomingEntities.map((entity) => entity.id)),
    tombstones: Object.freeze(incomingTombstones),
    observationOrder: order,
    provenance: nextProvenance,
  });
  const nextPageRevision = sha256(canonicalJson(nextPage));
  const pageMap = new Map((current?.pages ?? []).map((entry) => [entry.key, entry]));
  const coverageMap = new Map(
    (current?.completeCoverage ?? []).map((entry) => [entry.partition, entry]),
  );
  const normalizationMap = new Map(
    (current?.normalization ?? []).map((entry) => [entry.exactQueryKey, entry]),
  );
  const existingPage = pageMap.get(pageKey);
  if (
    existingPage !== undefined
    && existingPage.observationOrder === order
    && canonicalJson(existingPage) !== canonicalJson(nextPage)
  ) {
    return fail(
      "omni reduction",
      "received conflicting membership for one exact page observation",
    );
  }

  // Check all entity/deletion collisions before ignoring an out-of-order page.
  // An old observation can still reveal an impossible later resurrection.
  for (const nextEntity of incomingEntities) {
    const tombstone = tombstoneMap.get(nextEntity.id);
    if (tombstone !== undefined) {
      if (tombstone.observationOrder === order) {
        return fail(
          "omni reduction",
          "received an entity and tombstone for one exact observation",
        );
      }
      if (tombstone.observationOrder < order) {
        return fail(
          "omni reduction",
          "cannot resurrect a tombstoned entity without an explicit provider resurrection contract",
        );
      }
    }
    const existing = entityMap.get(nextEntity.id);
    if (existing !== undefined) {
      if (
        existing.entity.providerRevision !== null
        && existing.entity.providerRevision === nextEntity.providerRevision
        && existing.entity.revision !== nextEntity.revision
      ) return fail("omni reduction", "received conflicting bytes for one provider entity revision");
      if (existing.observationOrder === order) {
        if (existing.entity.revision !== nextEntity.revision) {
          return fail("omni reduction", "received conflicting bytes for one exact observation");
        }
      }
    }
  }
  for (const nextTombstone of incomingTombstones) {
    const existingEntity = entityMap.get(nextTombstone.id);
    if (existingEntity !== undefined && existingEntity.observationOrder >= order) {
      return fail(
        "omni reduction",
        existingEntity.observationOrder === order
          ? "received an entity and tombstone for one exact observation"
          : "cannot retain an entity observed after a tombstone without an explicit provider resurrection contract",
      );
    }
    const existingTombstone = tombstoneMap.get(nextTombstone.id);
    if (
      existingTombstone !== undefined
      && existingTombstone.observationOrder === order
      && (
        existingTombstone.kind !== nextTombstone.kind
        || existingTombstone.providerId !== nextTombstone.providerId
        || existingTombstone.providerRevision !== nextTombstone.providerRevision
      )
    ) {
      return fail(
        "omni reduction",
        "received conflicting tombstone bytes for one exact observation",
      );
    }
  }

  const coverage = coverageMap.get(page.partition);
  if (
    coverage !== undefined
    && coverage.pageKey === pageKey
    && page.completeness.kind !== "complete"
  ) {
    return fail(
      "omni reduction",
      "cannot weaken a complete root coordinate without a new reviewed coverage contract",
    );
  }
  if (coverage !== undefined && order <= coverage.observationOrder) {
    if (
      order === coverage.observationOrder
      && (
        page.completeness.kind !== "complete"
        || coverage.pageKey !== pageKey
        || coverage.pageRevision !== nextPageRevision
      )
    ) {
      return fail(
        "omni reduction",
        "received conflicting partition membership for one complete observation",
      );
    }
    if (current === null) return fail("omni reduction", "lost its coverage state");
    return current;
  }
  if (existingPage !== undefined && existingPage.observationOrder >= order) {
    if (current === null) return fail("omni reduction", "lost its page state");
    return current;
  }

  for (const nextEntity of incomingEntities) {
    const tombstone = tombstoneMap.get(nextEntity.id);
    if (tombstone !== undefined) continue;
    const existing = entityMap.get(nextEntity.id);
    const selected = existing !== undefined && existing.observationOrder >= order
      ? existing
      : Object.freeze({
          entity: nextEntity,
          partitions: Object.freeze([page.partition]),
          observationOrder: order,
          provenance: nextProvenance,
        });
    const partitions = [...new Set([
      ...(existing?.partitions ?? []),
      page.partition,
    ])].sort((left, right) => left.localeCompare(right));
    entityMap.set(nextEntity.id, Object.freeze({
      ...selected,
      partitions: Object.freeze(partitions),
    }));
  }
  for (const nextTombstone of incomingTombstones) {
    const existingTombstone = tombstoneMap.get(nextTombstone.id);
    if (
      existingTombstone !== undefined
      && existingTombstone.observationOrder >= order
    ) continue;
    entityMap.delete(nextTombstone.id);
    tombstoneMap.set(nextTombstone.id, Object.freeze({
      ...nextTombstone,
      observationOrder: order,
      provenance: nextProvenance,
    }));
  }

  if (page.completeness.kind === "complete") {
    for (const [key, stored] of pageMap) {
      if (
        stored.partition === page.partition
        && stored.observationOrder <= order
      ) pageMap.delete(key);
    }
    coverageMap.set(page.partition, Object.freeze({
      partition: page.partition,
      pageKey,
      pageRevision: nextPageRevision,
      observationOrder: order,
      provenance: nextProvenance,
    }));
  }
  pageMap.set(pageKey, nextPage);
  if (page.completeness.kind === "complete") {
    const partitionMembership = new Set([...pageMap.values()]
      .filter((storedPage) => storedPage.partition === page.partition)
      .flatMap((storedPage) => storedPage.orderedEntityIds));
    for (const [id, stored] of entityMap) {
      if (
        !stored.partitions.includes(page.partition)
        || partitionMembership.has(id)
      ) continue;
      const partitions = stored.partitions.filter((partition) =>
        partition !== page.partition);
      if (partitions.length === 0) {
        entityMap.delete(id);
      } else {
        entityMap.set(id, Object.freeze({
          ...stored,
          partitions: Object.freeze(partitions),
        }));
      }
    }
  }
  normalizationMap.set(nextProvenance.exactQueryKey, Object.freeze({
    exactQueryKey: nextProvenance.exactQueryKey,
    status: Object.freeze({
      state: "ready",
      lastGoodAt: nextProvenance.validatedAt,
      exactDataRevision: nextProvenance.exactDataRevision,
    }),
  }));
  const entities = [...entityMap.values()].sort((left, right) =>
    left.entity.id.localeCompare(right.entity.id));
  const pages = [...pageMap.values()].sort((left, right) => left.key.localeCompare(right.key));
  const completeCoverage = [...coverageMap.values()].sort((left, right) =>
    left.partition.localeCompare(right.partition));
  const tombstones = [...tombstoneMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  const normalization = [...normalizationMap.values()].sort((left, right) =>
    left.exactQueryKey.localeCompare(right.exactQueryKey));
  if (
    entities.length > OMNI_MAX_SOURCE_ENTITIES
    || pages.length > OMNI_MAX_SOURCE_PAGES
    || completeCoverage.length > OMNI_MAX_COMPLETE_COVERAGE
    || tombstones.length > OMNI_MAX_TOMBSTONES
    || normalization.length > OMNI_MAX_NORMALIZATION_FRONTIERS
  ) return fail(
    "omni reduction",
    "exceeds its entity, page, complete-coverage, tombstone, or normalization capacity",
  );
  if (pages.length === 0) return fail("omni reduction", "must retain its applied page");
  return parseOmniSourceStateV1(Object.freeze({
    schemaVersion: 1,
    source: expectedSource,
    entities: Object.freeze(entities),
    pages: Object.freeze(pages),
    completeCoverage: Object.freeze(completeCoverage),
    tombstones: Object.freeze(tombstones),
    normalization: Object.freeze(normalization),
  }));
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bytes = Buffer.from(message, "utf8");
  return bytes.byteLength <= 8_192
    ? message
    : `${bytes.subarray(0, 8_192).toString("utf8")}…`;
}

export function markOmniSourceDriftV1(
  currentValue: unknown,
  options: {
    readonly source: OmniSourceIdentityV1;
    readonly exactQueryKey: string;
    readonly exactDataRevision: string;
    readonly failedAt: string;
    readonly error: unknown;
    readonly code?: "materializer-drift" | "capacity-exceeded";
  },
): OmniSourceStateV1 {
  const source = sourceIdentity(options.source, "omni drift source");
  const current = currentValue === null ? null : parseOmniSourceStateV1(currentValue);
  if (current !== null && canonicalJson(current.source) !== canonicalJson(source)) {
    return fail("omni drift", "cannot cross source identity");
  }
  const failedAt = timestamp(options.failedAt, "omni drift failure time");
  const exactQueryKey = digest(
    options.exactQueryKey,
    "omni drift exact query key",
  );
  const normalizationMap = new Map(
    (current?.normalization ?? []).map((entry) => [entry.exactQueryKey, entry]),
  );
  const prior = normalizationMap.get(exactQueryKey)?.status;
  normalizationMap.set(exactQueryKey, Object.freeze({
    exactQueryKey,
    status: Object.freeze({
      state: "drift",
      failedAt,
      exactDataRevision: digest(
        options.exactDataRevision,
        "omni drift exact data revision",
      ),
      code: options.code ?? "materializer-drift",
      message: boundedErrorMessage(options.error),
      lastGoodAt: prior?.state === "ready"
        ? prior.lastGoodAt
        : prior?.lastGoodAt ?? null,
      lastGoodExactDataRevision: prior?.state === "ready"
        ? prior.exactDataRevision
        : prior?.lastGoodExactDataRevision ?? null,
    }),
  }));
  const normalization = [...normalizationMap.values()].sort((left, right) =>
    left.exactQueryKey.localeCompare(right.exactQueryKey));
  if (normalization.length > OMNI_MAX_NORMALIZATION_FRONTIERS) {
    return fail("omni drift", "exceeds its normalization frontier capacity");
  }
  return parseOmniSourceStateV1(Object.freeze({
    schemaVersion: 1,
    source,
    entities: current?.entities ?? Object.freeze([]),
    pages: current?.pages ?? Object.freeze([]),
    completeCoverage: current?.completeCoverage ?? Object.freeze([]),
    tombstones: current?.tombstones ?? Object.freeze([]),
    normalization: Object.freeze(normalization),
  }));
}

export function compareOmniEntitiesV1(left: OmniEntityV1, right: OmniEntityV1): number {
  const leftTime = left.orderedAt ?? "";
  const rightTime = right.orderedAt ?? "";
  return rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id);
}

export function queryOmniSourceStatesV1(
  states: readonly OmniSourceStateV1[],
  options: {
    readonly kinds?: readonly OmniEntityKindV1[];
    readonly conversationId?: string;
    readonly unread?: boolean;
  } = {},
): readonly OmniEntityV1[] {
  const kinds = options.kinds === undefined ? null : new Set(options.kinds);
  const entityById = new Map<string, OmniStoredEntityV1>();
  const tombstoneById = new Map<string, OmniStoredTombstoneV1>();
  const providerRevisionBytes = new Map<string, string>();
  const exactEvents = new Map<
    string,
    Readonly<{ kind: "entity" | "tombstone"; revision: string }>
  >();
  const observeExactEvent = (
    id: string,
    observationOrder: string,
    event: Readonly<{ kind: "entity" | "tombstone"; revision: string }>,
  ): void => {
    const key = `${id}\0${observationOrder}`;
    const existing = exactEvents.get(key);
    if (
      existing !== undefined
      && (existing.kind !== event.kind || existing.revision !== event.revision)
    ) {
      return fail(
        "omni query",
        "encountered conflicting entity or tombstone bytes for one exact observation",
      );
    }
    exactEvents.set(key, event);
  };
  for (const stateValue of states) {
    const state = parseOmniSourceStateV1(stateValue);
    for (const stored of state.entities) {
      const value = stored.entity;
      if (value.providerRevision !== null) {
        const providerRevisionKey = `${value.id}\0${value.providerRevision}`;
        const existingRevision = providerRevisionBytes.get(providerRevisionKey);
        if (
          existingRevision !== undefined
          && existingRevision !== value.revision
        ) {
          return fail(
            "omni query",
            "encountered conflicting normalized bytes for one provider revision",
          );
        }
        providerRevisionBytes.set(providerRevisionKey, value.revision);
      }
      observeExactEvent(value.id, stored.observationOrder, {
        kind: "entity",
        revision: value.revision,
      });
      const existing = entityById.get(value.id);
      if (
        existing === undefined
        || existing.observationOrder < stored.observationOrder
      ) {
        entityById.set(value.id, stored);
      }
    }
    for (const tombstone of state.tombstones) {
      const revision = sha256(canonicalJson({
        kind: tombstone.kind,
        providerId: tombstone.providerId,
        providerRevision: tombstone.providerRevision,
      }));
      observeExactEvent(tombstone.id, tombstone.observationOrder, {
        kind: "tombstone",
        revision,
      });
      const existing = tombstoneById.get(tombstone.id);
      if (
        existing === undefined
        || existing.observationOrder < tombstone.observationOrder
      ) {
        tombstoneById.set(tombstone.id, tombstone);
      }
    }
  }
  const winners: OmniEntityV1[] = [];
  for (const [id, stored] of entityById) {
    const tombstone = tombstoneById.get(id);
    if (tombstone !== undefined) {
      if (stored.observationOrder > tombstone.observationOrder) {
        return fail(
          "omni query",
          "cannot expose an entity observed after a tombstone without an explicit provider resurrection contract",
        );
      }
      if (stored.observationOrder === tombstone.observationOrder) {
        return fail(
          "omni query",
          "encountered an entity and tombstone for one exact observation",
        );
      }
      continue;
    }
    const value = stored.entity;
    if (kinds !== null && !kinds.has(value.kind)) continue;
    if (
      options.conversationId !== undefined
      && value.conversationId !== options.conversationId
    ) continue;
    if (options.unread !== undefined) {
      const unread = value.kind === "conversation"
        ? value.unread ?? (value.unreadCount === null ? null : value.unreadCount > 0)
        : value.unread;
      if (unread !== options.unread) continue;
    }
    winners.push(value);
  }
  return Object.freeze(winners.sort(compareOmniEntitiesV1));
}
