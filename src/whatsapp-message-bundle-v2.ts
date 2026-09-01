import { types as nodeTypes } from "node:util";

import {
  LOCAL_MESSAGE_BUNDLE_V1_SCHEMA_VERSION,
  parseLocalMessageBundleV1Record,
  type LocalMessageBundleV1Record,
} from "@hraness/message-like-me/message-bundle-v1";
import {
  LOCAL_MESSAGE_BUNDLE_V2_ARTIFACTS,
  LOCAL_MESSAGE_BUNDLE_V2_FORMAT,
  LOCAL_MESSAGE_BUNDLE_V2_LIMITS,
  LOCAL_MESSAGE_BUNDLE_V2_NETWORK,
  LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_ID,
  LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_VERSION,
  LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
  LOCAL_MESSAGE_BUNDLE_V2_SOURCE_ID,
  LOCAL_MESSAGE_BUNDLE_V2_SOURCE_TRANSFORM_VERSION,
  MessageBundleV2ContractError,
  localMessageBundleV2BundleSha256,
  localMessageBundleV2ManifestProjection,
  parseLocalMessageBundleV2Manifest,
  parseLocalMessageBundleV2Record,
  type LocalMessageBundleV2AccountRecord,
  type LocalMessageBundleV2Artifact,
  type LocalMessageBundleV2AttachmentRecord,
  type LocalMessageBundleV2ConversationRecord,
  type LocalMessageBundleV2Manifest,
  type LocalMessageBundleV2ManifestProjection,
  type LocalMessageBundleV2MessageRecord,
  type LocalMessageBundleV2ParticipantRecord,
  type LocalMessageBundleV2Provenance,
  type LocalMessageBundleV2ReactionRecord,
  type LocalMessageBundleV2Record,
  type LocalMessageBundleV2RecordKind,
  type LocalMessageBundleV2TombstoneRecord,
} from "@hraness/message-like-me/message-bundle-v2";

import {
  parseBeeperMessageLikeMeCompletion,
  type BeeperMessageLikeMeCompletion,
} from "./beeper-message-bundle-v1";

export const WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION =
  LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION;
export const WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT = LOCAL_MESSAGE_BUNDLE_V2_FORMAT;
export const WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE = Object.freeze({
  id: LOCAL_MESSAGE_BUNDLE_V2_SOURCE_ID,
  version: LOCAL_MESSAGE_BUNDLE_V2_SOURCE_TRANSFORM_VERSION,
});
export const WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER = Object.freeze({
  id: LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_ID,
  version: LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_VERSION,
});
export const WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK = LOCAL_MESSAGE_BUNDLE_V2_NETWORK;
export const WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS = LOCAL_MESSAGE_BUNDLE_V2_ARTIFACTS;
export const WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS = LOCAL_MESSAGE_BUNDLE_V2_LIMITS;

export type WhatsAppMessageBundleV2Provenance = LocalMessageBundleV2Provenance;
export type WhatsAppMessageBundleV2Attachment = LocalMessageBundleV2AttachmentRecord;
export type WhatsAppMessageBundleV2Account = LocalMessageBundleV2AccountRecord;
export type WhatsAppMessageBundleV2Participant = LocalMessageBundleV2ParticipantRecord;
export type WhatsAppMessageBundleV2Conversation = LocalMessageBundleV2ConversationRecord;
export type WhatsAppMessageBundleV2Message = LocalMessageBundleV2MessageRecord;
export type WhatsAppMessageBundleV2Reaction = LocalMessageBundleV2ReactionRecord;
export type WhatsAppMessageBundleV2Tombstone = LocalMessageBundleV2TombstoneRecord;
export type WhatsAppMessageBundleV2Record = LocalMessageBundleV2Record;
export type WhatsAppMessageBundleV2Artifact = LocalMessageBundleV2Artifact;
export type WhatsAppMessageBundleV2ManifestProjection = LocalMessageBundleV2ManifestProjection;
export type WhatsAppMessageBundleV2Manifest = LocalMessageBundleV2Manifest;

export type WhatsAppMessageBundleV2Descriptor = Readonly<{
  source: typeof WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE;
  provider: typeof WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER;
}>;

export type WhatsAppMessageBundleV2Completion = BeeperMessageLikeMeCompletion;

type JsonRecord = Readonly<Record<string, unknown>>;

function fail(message: string): never {
  throw new MessageBundleV2ContractError(`WhatsApp Message Like Me v2 contract: ${message}`);
}

function plainRecord(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) return fail(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (
      typeof key !== "string"
      || descriptor === undefined
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) return fail(`${label} must contain only enumerable string data properties`);
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

function recordKind(value: unknown, index: number): LocalMessageBundleV2RecordKind {
  const label = `record[${String(index)}]`;
  const record = plainRecord(value, label);
  const kind = record.kind;
  if (
    kind !== "account"
    && kind !== "participant"
    && kind !== "conversation"
    && kind !== "message"
    && kind !== "reaction"
    && kind !== "tombstone"
  ) return fail(`${label}.kind is unsupported`);
  return kind;
}

export function parseWhatsAppMessageBundleV2Record(
  value: unknown,
  index = 0,
): WhatsAppMessageBundleV2Record {
  if (!Number.isSafeInteger(index) || index < 0 || index >= WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.records) {
    return fail("record index is outside the bundle bound");
  }
  const kind = recordKind(value, index);
  return parseLocalMessageBundleV2Record(value, kind, `WhatsApp ${kind} record[${String(index)}]`);
}

export function toLocalMessageBundleV1Record(
  value: WhatsAppMessageBundleV2Record,
): LocalMessageBundleV1Record {
  const parsed = parseWhatsAppMessageBundleV2Record(value);
  return parseLocalMessageBundleV1Record(
    Object.freeze({ ...parsed, schemaVersion: LOCAL_MESSAGE_BUNDLE_V1_SCHEMA_VERSION }),
    parsed.kind,
    "WhatsApp v1 compatibility record",
  );
}

export function parseWhatsAppMessageBundleV2Descriptor(
  value: unknown,
): WhatsAppMessageBundleV2Descriptor {
  const descriptor = plainRecord(value, "descriptor");
  exactKeys(descriptor, ["source", "provider"], "descriptor");
  const source = plainRecord(descriptor.source, "descriptor.source");
  const provider = plainRecord(descriptor.provider, "descriptor.provider");
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
): WhatsAppMessageBundleV2ManifestProjection {
  return localMessageBundleV2ManifestProjection(manifest);
}

export function whatsAppMessageBundleV2BundleSha256(
  projection: WhatsAppMessageBundleV2ManifestProjection,
): string {
  return localMessageBundleV2BundleSha256(projection);
}

export function parseWhatsAppMessageBundleV2Manifest(
  value: unknown,
): WhatsAppMessageBundleV2Manifest {
  return parseLocalMessageBundleV2Manifest(value);
}
