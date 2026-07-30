import { createHash } from "node:crypto";
import { compareUtf8 } from "./utf8-order";

export const REVISION_CAPTURE_NAMESPACE = ".wrench-media-revisions" as const;
export const WRENCH_MEDIA_TRACKED_REVISION_PROFILE = "wrench-media-tracked-revision-v1" as const;
export const WRENCH_MEDIA_REVISION_CONTENT_PROFILE = "wrench-media-retained-input-set-v1" as const;
export const MAX_REVISION_SEQUENCE = Number.MAX_SAFE_INTEGER;
export const MAX_TRACKED_REVISION_ITEMS = 4_096 as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ASSET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const REVISION_ASSET_KEY_PATTERN = /^revision-v1-[0-9a-f]{64}$/u;
const REVISION_LEAF_PATTERN = /^([0-9]{16})-(revision-v1-[0-9a-f]{64})$/u;
const NORMALIZED_MEDIA_TYPE_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,127}\/[a-z0-9!#$%&'*+.^_`|~-]{1,127}(?:; charset=utf-8)?$/u;

export type RevisionContentRole =
  | "capture"
  | "transcript_vtt"
  | "transcript_text"
  | "transcript_json"
  | "provider_metadata"
  | "description"
  | "thumbnail";

const revisionContentRoles = new Set<RevisionContentRole>([
  "capture",
  "transcript_vtt",
  "transcript_text",
  "transcript_json",
  "provider_metadata",
  "description",
  "thumbnail",
]);

export interface RevisionArtifactInput {
  readonly role: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mediaType: string;
}

export interface MediaTrackedRevision {
  readonly profile: typeof WRENCH_MEDIA_TRACKED_REVISION_PROFILE;
  readonly sequence: number;
  readonly subjectAssetKey: string;
  readonly previousAssetKey?: string;
  readonly content: {
    readonly profile: typeof WRENCH_MEDIA_REVISION_CONTENT_PROFILE;
    readonly sha256: string;
  };
}

function updateComponent(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = new TextEncoder().encode(value);
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(bytes.byteLength), false);
  hash.update(length);
  hash.update(bytes);
}

function revisionHash(domain: string, components: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("wrench-media-revision-key\0", "utf8");
  for (const component of [domain, ...components]) updateComponent(hash, component);
  return hash.digest("hex");
}

function isRevisionContentRole(value: string): value is RevisionContentRole {
  return revisionContentRoles.has(value as RevisionContentRole);
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_REVISION_SEQUENCE) {
    throw new TypeError("revision sequence must be a positive safe integer");
  }
}

function assertAssetKey(value: string, label: string): void {
  if (!ASSET_KEY_PATTERN.test(value)) throw new TypeError(`${label} is malformed`);
}

/**
 * Fingerprints retained provider inputs, not Wrench media's audio/video derivatives.
 * Paths and input ordering are intentionally excluded from equivalence.
 */
export function revisionContentSha256(
  artifacts: readonly RevisionArtifactInput[],
): string {
  const selected = artifacts
    .filter((artifact): artifact is RevisionArtifactInput & { readonly role: RevisionContentRole } =>
      isRevisionContentRole(artifact.role))
    .toSorted((left, right) => compareUtf8(left.role, right.role));
  if (selected.length === 0) throw new TypeError("revision content has no retained provider inputs");
  if (new Set(selected.map((artifact) => artifact.role)).size !== selected.length) {
    throw new TypeError("revision content has duplicate singleton roles");
  }
  const components: string[] = [WRENCH_MEDIA_REVISION_CONTENT_PROFILE];
  for (const artifact of selected) {
    if (
      !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 0
      || !SHA256_PATTERN.test(artifact.sha256)
      || !NORMALIZED_MEDIA_TYPE_PATTERN.test(artifact.mediaType)
    ) {
      throw new TypeError("revision content artifact is malformed");
    }
    components.push(
      artifact.role,
      String(artifact.bytes),
      artifact.mediaType,
      artifact.sha256,
    );
  }
  return revisionHash("retained-input-set", components);
}

/** Reconstructs the immutable key for one occurrence in a revision chain. */
export function trackedRevisionAssetKey(revision: MediaTrackedRevision): string {
  if (
    revision.profile !== WRENCH_MEDIA_TRACKED_REVISION_PROFILE
    || revision.content.profile !== WRENCH_MEDIA_REVISION_CONTENT_PROFILE
    || !SHA256_PATTERN.test(revision.content.sha256)
  ) {
    throw new TypeError("tracked revision identity is malformed");
  }
  assertSequence(revision.sequence);
  assertAssetKey(revision.subjectAssetKey, "revision subject asset key");
  if (revision.previousAssetKey !== undefined) {
    assertAssetKey(revision.previousAssetKey, "revision predecessor asset key");
  }
  return `revision-v1-${revisionHash("tracked-revision", [
    revision.profile,
    revision.subjectAssetKey,
    String(revision.sequence),
    revision.previousAssetKey === undefined ? "absent" : "present",
    revision.previousAssetKey ?? "",
    revision.content.profile,
    revision.content.sha256,
  ])}`;
}

export function revisionItemLeaf(sequence: number, assetKey: string): string {
  assertSequence(sequence);
  if (!REVISION_ASSET_KEY_PATTERN.test(assetKey)) {
    throw new TypeError("revision asset key is malformed");
  }
  return `${String(sequence).padStart(16, "0")}-${assetKey}`;
}

export function parseRevisionItemLeaf(
  value: string,
): Readonly<{ sequence: number; assetKey: string }> | null {
  const match = REVISION_LEAF_PATTERN.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  let parsed: bigint;
  try {
    parsed = BigInt(match[1]);
  } catch {
    return null;
  }
  if (parsed < 1n || parsed > BigInt(MAX_REVISION_SEQUENCE)) return null;
  const sequence = Number(parsed);
  return revisionItemLeaf(sequence, match[2]) === value
    ? { sequence, assetKey: match[2] }
    : null;
}
