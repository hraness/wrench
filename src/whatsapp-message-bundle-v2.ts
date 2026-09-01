import { types as nodeTypes } from "node:util";

import {
  LOCAL_MESSAGE_BUNDLE_V1_ARTIFACTS,
  LOCAL_MESSAGE_BUNDLE_V1_FORMAT,
  LOCAL_MESSAGE_BUNDLE_V1_LIMITS,
  parseLocalMessageBundleV1Manifest,
  parseLocalMessageBundleV1Record,
  type LocalMessageBundleV1AccountRecord,
  type LocalMessageBundleV1AttachmentRecord,
  type LocalMessageBundleV1ConversationRecord,
  type LocalMessageBundleV1MessageRecord,
  type LocalMessageBundleV1ParticipantRecord,
  type LocalMessageBundleV1Provenance,
  type LocalMessageBundleV1ReactionRecord,
  type LocalMessageBundleV1Record,
  type LocalMessageBundleV1RecordKind,
  type LocalMessageBundleV1TombstoneRecord,
} from "@hraness/message-like-me/message-bundle-v1";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  parseBeeperMessageLikeMeCompletion,
  type BeeperMessageLikeMeCompletion,
} from "./beeper-message-bundle-v1";

export const WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION = 2 as const;
export const WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT = LOCAL_MESSAGE_BUNDLE_V1_FORMAT;
export const WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE = Object.freeze({
  id: "wacli-local" as const,
  version: "1.0.0" as const,
});
export const WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER = Object.freeze({
  id: "whatsapp" as const,
  version: "0.15.0" as const,
});
export const WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK = "whatsapp" as const;
export const WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS = LOCAL_MESSAGE_BUNDLE_V1_ARTIFACTS;
export const WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS = LOCAL_MESSAGE_BUNDLE_V1_LIMITS;

type V2Record<Record extends { readonly schemaVersion: unknown }> =
  Omit<Record, "schemaVersion"> & Readonly<{
    schemaVersion: typeof WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION;
  }>;

export type WhatsAppMessageBundleV2Provenance = LocalMessageBundleV1Provenance;
export type WhatsAppMessageBundleV2Attachment = LocalMessageBundleV1AttachmentRecord;
export type WhatsAppMessageBundleV2Account = V2Record<LocalMessageBundleV1AccountRecord>;
export type WhatsAppMessageBundleV2Participant = V2Record<LocalMessageBundleV1ParticipantRecord>;
export type WhatsAppMessageBundleV2Conversation = V2Record<LocalMessageBundleV1ConversationRecord>;
export type WhatsAppMessageBundleV2Message = V2Record<LocalMessageBundleV1MessageRecord>;
export type WhatsAppMessageBundleV2Reaction = V2Record<LocalMessageBundleV1ReactionRecord>;
export type WhatsAppMessageBundleV2Tombstone = V2Record<LocalMessageBundleV1TombstoneRecord>;
export type WhatsAppMessageBundleV2Record =
  | WhatsAppMessageBundleV2Account
  | WhatsAppMessageBundleV2Participant
  | WhatsAppMessageBundleV2Conversation
  | WhatsAppMessageBundleV2Message
  | WhatsAppMessageBundleV2Reaction
  | WhatsAppMessageBundleV2Tombstone;

export type WhatsAppMessageBundleV2Descriptor = Readonly<{
  source: typeof WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE;
  provider: typeof WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER;
}>;

export type WhatsAppMessageBundleV2Completion = BeeperMessageLikeMeCompletion;

export type WhatsAppMessageBundleV2Artifact = Readonly<{
  path: typeof WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS[number]["path"];
  mediaType: "application/x-ndjson";
  recordKind: LocalMessageBundleV1RecordKind;
  records: number;
  bytes: number;
  sha256: string;
}>;

export type WhatsAppMessageBundleV2Manifest = Readonly<{
  schemaVersion: typeof WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION;
  format: typeof WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT;
  source: typeof WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE;
  provider: typeof WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER;
  timestamps: Readonly<{ startedAt: string; finishedAt: string; createdAt: string }>;
  completeness: WhatsAppMessageBundleV2Completion["completeness"];
  warnings: readonly string[];
  privacy: Readonly<{
    classification: "private-local";
    attachments: "metadata-only";
    providerUrls: "excluded";
    credentials: "excluded";
  }>;
  counts: Readonly<Record<LocalMessageBundleV1RecordKind, number>>;
  artifacts: readonly WhatsAppMessageBundleV2Artifact[];
  integrity: Readonly<{ algorithm: "sha256"; bundleSha256: string }>;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;
const JID_PATTERN = /^(?:[0-9]{5,20}@s\.whatsapp\.net|[0-9]{5,32}@lid|[0-9]{5,32}(?:-[0-9]{5,20})?@g\.us)$/u;

function fail(message: string): never {
  throw new Error(`WhatsApp Message Like Me v2 contract: ${message}`);
}

function plainData(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) return fail(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail(`${label} must contain only enumerable string data fields`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label} must contain only enumerable string data fields`);
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  ));
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    return fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function v1Record(value: JsonRecord, kind: LocalMessageBundleV1RecordKind): LocalMessageBundleV1Record {
  return parseLocalMessageBundleV1Record(
    Object.freeze({ ...value, schemaVersion: 1 }),
    kind,
    `WhatsApp ${kind} record`,
  );
}

export function parseWhatsAppMessageBundleV2Record(
  value: unknown,
  index = 0,
): WhatsAppMessageBundleV2Record {
  if (!Number.isSafeInteger(index) || index < 0 || index >= WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.records) {
    return fail("record index is outside the bundle bound");
  }
  const candidate = plainData(value, `record[${String(index)}]`);
  if (candidate.schemaVersion !== WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION) {
    return fail("record schemaVersion must equal 2");
  }
  const kind = candidate.kind;
  if (
    kind !== "account"
    && kind !== "participant"
    && kind !== "conversation"
    && kind !== "message"
    && kind !== "reaction"
    && kind !== "tombstone"
  ) return fail("record kind is unsupported");
  const parsed = v1Record(candidate, kind);
  if (parsed.network !== WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK) {
    return fail("record network must equal whatsapp");
  }
  const connected = parsed.provenance.connectedAccountProviderId;
  if (!/^(?:[0-9]{5,20}@s\.whatsapp\.net|[0-9]{5,32}@lid)$/u.test(connected)) {
    return fail("connected account provider ID must be an exact canonical account JID");
  }
  if (
    (kind === "account" || kind === "participant" || kind === "conversation")
    && !JID_PATTERN.test(parsed.provenance.providerId)
  ) return fail(`${kind} provider ID must be an exact canonical JID`);
  return Object.freeze({
    ...parsed,
    schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
  }) as WhatsAppMessageBundleV2Record;
}

export function toLocalMessageBundleV1Record(
  value: WhatsAppMessageBundleV2Record,
): LocalMessageBundleV1Record {
  const candidate = plainData(value, "WhatsApp v2 record");
  return v1Record(candidate, value.kind);
}

export function parseWhatsAppMessageBundleV2Descriptor(
  value: unknown,
): WhatsAppMessageBundleV2Descriptor {
  const descriptor = plainData(value, "descriptor");
  exactKeys(descriptor, ["source", "provider"], "descriptor");
  const source = plainData(descriptor.source, "descriptor.source");
  const provider = plainData(descriptor.provider, "descriptor.provider");
  exactKeys(source, ["id", "version"], "descriptor.source");
  exactKeys(provider, ["id", "version"], "descriptor.provider");
  if (
    source.id !== WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE.id
    || source.version !== WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE.version
    || provider.id !== WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER.id
    || provider.version !== WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER.version
  ) return fail("descriptor does not match the pinned direct WhatsApp producer");
  return Object.freeze({
    source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
    provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
  });
}

export function parseWhatsAppMessageBundleV2Completion(
  value: unknown,
): WhatsAppMessageBundleV2Completion {
  return parseBeeperMessageLikeMeCompletion(value);
}

export function whatsAppMessageBundleV2Projection(
  manifest: WhatsAppMessageBundleV2Manifest,
): Omit<WhatsAppMessageBundleV2Manifest, "integrity"> {
  const { integrity: _integrity, ...projection } = manifest;
  return Object.freeze(projection);
}

export function parseWhatsAppMessageBundleV2Manifest(
  value: unknown,
): WhatsAppMessageBundleV2Manifest {
  const manifest = plainData(value, "manifest");
  exactKeys(manifest, [
    "schemaVersion", "format", "source", "provider", "timestamps", "completeness",
    "warnings", "privacy", "counts", "artifacts", "integrity",
  ], "manifest");
  if (
    manifest.schemaVersion !== WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION
    || manifest.format !== WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT
  ) return fail("manifest has the wrong schemaVersion or format");
  parseWhatsAppMessageBundleV2Descriptor({ source: manifest.source, provider: manifest.provider });
  const integrity = plainData(manifest.integrity, "manifest.integrity");
  exactKeys(integrity, ["algorithm", "bundleSha256"], "manifest.integrity");
  if (integrity.algorithm !== "sha256") return fail("manifest integrity algorithm is unsupported");
  const bundleSha256 = digest(integrity.bundleSha256, "manifest.integrity.bundleSha256");
  const { integrity: _ignoredIntegrity, ...projectionFields } = manifest;
  const projection = Object.freeze(projectionFields);
  if (sha256(canonicalJson(projection)) !== bundleSha256) {
    return fail("manifest bundle digest does not match its canonical projection");
  }

  const v1Projection = Object.freeze({
    ...projection,
    schemaVersion: 1 as const,
    source: Object.freeze({ id: "beeper-local" as const, version: "1.1.0" as const }),
    provider: Object.freeze({ id: "beeper" as const, version: "0.15.0" }),
  });
  const v1Manifest = Object.freeze({
    ...v1Projection,
    integrity: Object.freeze({
      algorithm: "sha256" as const,
      bundleSha256: sha256(canonicalJson(v1Projection)),
    }),
  });
  parseLocalMessageBundleV1Manifest(v1Manifest);
  return Object.freeze({
    ...manifest,
    schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
    format: WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT,
    source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
    provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
    integrity: Object.freeze({ algorithm: "sha256", bundleSha256 }),
  }) as WhatsAppMessageBundleV2Manifest;
}
