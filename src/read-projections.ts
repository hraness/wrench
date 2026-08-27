import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json";
import {
  parseLocalCliToolIdentityV1,
  type LocalCliToolIdentityV1,
} from "./local-cli-tool-identity";
import {
  READ_PROJECTION_TRANSITION_SETTLEMENT_WAIT_MS,
  withReadProjectionAuthAdmission,
  withSettledReadProjectionAuthAdmission,
} from "./read-projection-admission";
import {
  MAX_PRIVATE_STATE_BATCH_FILE_BYTES,
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  listPrivateStateDirectory,
  readPrivateStateChildFilesBatched,
  readPrivateStateFileBytesIfPresent,
  readPrivateStateFileIfPresent,
  readRegularFile,
  removePrivateStateDirectoryTree,
  removePrivateStateFile,
  snapshotPrivateStateDirectory,
  wrenchStateHome,
  writePrivateJsonIfUnchanged,
  type PrivateDirectoryIdentity,
} from "./storage";

export {
  ReadProjectionAdmissionContentionError,
  READ_PROJECTION_SHORT_SETTLEMENT_WAIT_MS,
  READ_PROJECTION_TRANSITION_SETTLEMENT_WAIT_MS,
  acquireReadProjectionAuthAdmission,
  ensureReadProjectionAuthIncarnation,
  projectionAuthIdentityHash,
  removeReadProjectionAuthIncarnation,
  rotateReadProjectionAuthIncarnation,
  withReadProjectionAuthAdmission,
  withSettledReadProjectionAuthAdmission,
  type ReadProjectionAdmissionContentionReason,
  type ReadProjectionAdmissionOwner,
  type ReadProjectionAdmissionSettlementOptions,
  type ReadProjectionAuthAdmission,
} from "./read-projection-admission";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

const STORE_DIRECTORY = "read-projections";
const OMNI_STORE_DIRECTORY = "omni-read-projections";
const CONTROL_DIRECTORY = "read-projection-control";
const KEY_FILE = ".projection-encryption-key";
const STORE_KEY_MARKER_FILE = "store-key.json";
const HEAD_FILE = "head.json";
const KEY_FILE_MAX_BYTES = 512;
const STORE_KEY_MARKER_MAX_BYTES = 512;
const INITIALIZATION_SETTLE_ATTEMPTS = 100;
const INITIALIZATION_SETTLE_WAIT_MS = 10;
const HEAD_MAX_BYTES = 16 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const MAX_ATTRIBUTABLE_CORRUPT_FILE_BYTES = 4 * 1024 * 1024;
const PLAINTEXT_CHUNK_BYTES = 1_200_000;
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS = 16;
const MAX_QUERY_DIRECTORY_ENTRIES = 2 * MAX_CHUNKS + 16;
const MAX_REALM_QUERY_DIRECTORIES = 32;
const MAX_REALM_STORAGE_BYTES = 128 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 110_000;
const MAX_FRESH_FOR_MS = 365 * 24 * 60 * 60 * 1_000;
const immutableManifestNamePattern = /^manifest--([a-f0-9]{32})\.json$/u;
const immutableChunkNamePattern = /^chunk--([a-f0-9]{32})--([0-9]{3})\.json$/u;
const queryDirectoryNamePattern = /^[a-f0-9]{64}$/u;
const authIdPattern = /^[a-z][a-z0-9-]{0,47}$/u;
const stateHelperArtifactNamePatterns = Object.freeze([
  /^\.io-write-[1-9][0-9]{0,9}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u,
  /^\.io-mutation-[a-f0-9]{64}-(?:waiting|candidate|held)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.lock$/u,
  /^\.io-mutation-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[1-9][0-9]{0,9}\.tmp$/u,
  /^\.io-remove-file-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.quarantine$/u,
  /^\.io-remove(?:-tree)?-[1-9][0-9]{0,9}-[1-9][0-9]{0,15}-[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}\.quarantine$/u,
]);

type ProjectionKey = {
  readonly id: string;
  readonly value: Buffer;
};

type ProjectionStoreKeyMarkerV1 = {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly authentication: string;
};

export type ReadProjectionQueryIdentity = {
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly operation: string;
  readonly input: unknown;
  readonly inputHash: string;
  readonly auth: {
    readonly id: string;
    readonly kind: string;
    readonly hash: string;
    readonly subject: string;
  };
  readonly contract: {
    readonly transport:
      | "browser"
      | "portable-provider-plugin"
      | "provider-api"
      | "reviewed-template-api"
      | "web-session-api";
    readonly hash: string;
  } | {
    readonly transport: "local-cli";
    readonly hash: string;
    readonly tool: LocalCliToolIdentityV1;
  };
};

export type ReadProjectionQuery = {
  /** Keyed digest safe to use as an opaque local cache identifier. */
  readonly key: string;
  /** Keyed auth-locator coordinate used only for private state custody. */
  readonly realmKey: string;
  readonly identity: ReadProjectionQueryIdentity;
};

export type OmniProjectionQuery = ReadProjectionQuery & {
  /** Runtime storage-class tag. Exact-query values deliberately have no tag. */
  readonly storageClass: "omni-v1";
};

type ProjectionStorageClass = "exact-v1" | "omni-v1";

export type OmniProjectionCurrent = {
  readonly key: string;
  /** Immutable encrypted revision named by the authoritative head. */
  readonly storageRevisionId: string;
  readonly output: unknown;
  readonly dataRevision: string;
  readonly createdAt: string;
  readonly dataChangedAt: string;
  readonly validatedAt: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
};

export type OmniProjectionPublication = ReadProjectionPublication & {
  readonly storageRevisionId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
};

export type OmniProjectionReductionResult = {
  readonly publication: OmniProjectionPublication;
  readonly current: OmniProjectionCurrent;
};

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

export type OmniProjectionCacheResult =
  | Extract<ReadProjectionCacheResult, { readonly status: "miss" }>
  | (Extract<ReadProjectionCacheResult, { readonly status: "hit" }> & {
      readonly storageRevisionId: string;
      readonly startedAt: string;
      readonly finishedAt: string;
    });

/** Internal exact-head observation used to bind a derivative to exact bytes. */
export type ReadProjectionMaterializationSnapshot = OmniProjectionCacheResult;

/** Exact immutable head that must still own the auth admission at reduction. */
export type ReadProjectionExactHeadFence = {
  readonly query: ReadProjectionQuery;
  readonly storageRevisionId: string;
  readonly dataRevision: string;
  readonly runId: string;
};

export type ReadProjectionPublication = {
  readonly key: string;
  readonly dataRevision: string;
  readonly validatedAt: string;
  readonly dataChangedAt: string;
  readonly disposition: "created" | "changed" | "unchanged" | "superseded";
  readonly currentDataRevision?: string;
};

type ProjectionPayloadV1 = {
  readonly schemaVersion: 1;
  readonly query: ReadProjectionQueryIdentity;
  readonly output: unknown;
  readonly dataRevision: string;
  readonly createdAt: string;
  readonly dataChangedAt: string;
  readonly validatedAt: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
};

export type ReadProjectionHeadPublication = {
  readonly dataRevision: string;
  readonly createdAt: string;
  readonly dataChangedAt: string;
  readonly validatedAt: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
};

type ProjectionHeadV1 = {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly revisionId: string;
  readonly manifestFile: string;
  readonly publication: ReadProjectionHeadPublication;
  readonly authentication: string;
};

type ProjectionManifestV1 = {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly revisionId: string;
  readonly plaintextBytes: number;
  readonly chunkFiles: readonly string[];
  readonly chunkHashes: readonly string[];
  readonly authentication: string;
};

type EncryptedProjectionChunkV1 = {
  readonly schemaVersion: 1;
  readonly encryption: "aes-256-gcm";
  readonly keyId: string;
  readonly revisionId: string;
  readonly index: number;
  readonly count: number;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

type LoadedProjection = {
  readonly head: ProjectionHeadV1;
  readonly headContentSha256: string;
  readonly payload: ProjectionPayloadV1;
};

type ProjectionHeadSnapshot = {
  readonly head: ProjectionHeadV1;
  readonly contentSha256: string;
};

type ReadProjectionCorruptionEvidence = {
  readonly storageClass: ProjectionStorageClass;
  readonly queryKey: string;
  readonly realmKey: string;
  readonly headContentSha256: string;
  readonly headPublication: ReadProjectionHeadPublication | null;
};

const corruptionConstructorToken = Symbol("read-projection-corruption");
const corruptionEvidence = new WeakMap<
  ReadProjectionCorruptionError,
  ReadProjectionCorruptionEvidence
>();

/**
 * Nominal evidence that one exact query's authenticated on-disk projection is
 * corrupt. Control-state failures, contention, caller errors, and ordinary I/O
 * failures deliberately retain their original error types.
 */
export class ReadProjectionCorruptionError extends Error {
  readonly #nominal = true;

  constructor(
    message: string,
    evidence: ReadProjectionCorruptionEvidence,
    options: { readonly cause?: unknown },
    token: typeof corruptionConstructorToken,
  ) {
    if (token !== corruptionConstructorToken) {
      throw new TypeError("read projection corruption evidence is internal");
    }
    super(message, options);
    this.name = "ReadProjectionCorruptionError";
    corruptionEvidence.set(this, evidence);
  }

  get authenticatedOnDiskQueryCorruption(): true {
    return this.#nominal;
  }

  get queryKey(): string {
    return corruptionEvidence.get(this)!.queryKey;
  }

  get storageClass(): ProjectionStorageClass {
    return corruptionEvidence.get(this)!.storageClass;
  }

  get realmKey(): string {
    return corruptionEvidence.get(this)!.realmKey;
  }

  get headContentSha256(): string {
    return corruptionEvidence.get(this)!.headContentSha256;
  }

  get headPublication(): ReadProjectionHeadPublication | null {
    return corruptionEvidence.get(this)!.headPublication;
  }
}

export function isReadProjectionCorruptionError(
  error: unknown,
): error is ReadProjectionCorruptionError {
  return error instanceof ReadProjectionCorruptionError
    && corruptionEvidence.has(error);
}

/**
 * The replacement head is already authoritative when this error is raised.
 * Only reclamation of unreachable prior state failed.
 */
export class ReadProjectionDurableRepairError extends Error {
  readonly durableRepair = true;
  readonly headIsAuthoritative = true;
  readonly queryKey: string;
  readonly publication: ReadProjectionPublication;

  constructor(
    queryKey: string,
    publicationValue: ReadProjectionPublication,
    cause: unknown,
  ) {
    super(
      "read projection repair is durable but post-publication reclamation failed",
      { cause },
    );
    this.name = "ReadProjectionDurableRepairError";
    this.queryKey = queryKey;
    this.publication = publicationValue;
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error(`${label} has unsupported symbol fields`);
  }
  const result: JsonRecord = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} has unsupported accessor fields`);
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function hexDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function safeString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) throw new Error(`${label} is malformed`);
  return value;
}

function authId(value: unknown): string {
  if (typeof value !== "string" || !authIdPattern.test(value)) {
    throw new Error("read projection auth ID must be lowercase kebab-case");
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = safeString(value, label, 64);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${label} is malformed`);
  }
  return text;
}

function runId(value: unknown): string {
  const text = safeString(value, "projection run ID", 64);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(text)) {
    throw new Error("projection run ID is malformed");
  }
  return text.toLowerCase();
}

function boundedJson(value: unknown, label: string): unknown {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error(`${label} exceeds its structural bound`);
    }
    if (
      candidate === null
      || typeof candidate === "boolean"
      || typeof candidate === "string"
    ) return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate !== "object") {
      throw new Error(`${label} must contain only JSON data`);
    }
    if (ancestors.has(candidate)) throw new Error(`${label} must not be circular`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new Error(`${label} arrays must use the standard prototype`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as Readonly<Record<string, PropertyDescriptor>>;
        if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
          throw new Error(`${label} arrays have unsupported symbol fields`);
        }
        const lengthDescriptor = descriptors.length;
        if (
          lengthDescriptor === undefined
          || !("value" in lengthDescriptor)
          || typeof lengthDescriptor.value !== "number"
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
        ) throw new Error(`${label} arrays are malformed`);
        const length = lengthDescriptor.value;
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        if (
          keys.length !== length
          || keys.some((key, index) => key !== String(index))
        ) throw new Error(`${label} arrays must be dense data arrays`);
        const cloned: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined
            || !descriptor.enumerable
            || !("value" in descriptor)
          ) throw new Error(`${label} arrays must contain only data elements`);
          cloned.push(visit(descriptor.value, depth + 1));
        }
        return cloned;
      }
      const data = record(candidate, label);
      const cloned: JsonRecord = {};
      for (const [key, item] of Object.entries(data)
        .sort(([left], [right]) => left.localeCompare(right))) {
        Object.defineProperty(cloned, key, {
          value: visit(item, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return cloned;
    } finally {
      ancestors.delete(candidate);
    }
  };
  const cloned = visit(value, 0);
  if (Buffer.byteLength(canonicalJson(cloned), "utf8") > MAX_PLAINTEXT_BYTES) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  return cloned;
}

function deeplyFreezeJson(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deeplyFreezeJson(descriptor.value);
  }
  return Object.freeze(value);
}

function immutableBoundedJson(value: unknown, label: string): unknown {
  return deeplyFreezeJson(boundedJson(value, label));
}

function hasThenableProtocol(value: unknown): boolean {
  if (
    (typeof value !== "object" || value === null)
    && typeof value !== "function"
  ) return false;
  const visited = new WeakSet<object>();
  let current: object | null = value;
  while (current !== null) {
    if (visited.has(current)) {
      throw new Error("omni projection reducer result has a cyclic prototype chain");
    }
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, "then");
    if (descriptor !== undefined) {
      return !("value" in descriptor) || typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function hashBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer, domain: string, value: string | Buffer): string {
  return createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value)
    .digest("hex");
}

function authenticated(
  left: string,
  right: string,
): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function storeDirectory(environment: Environment): string {
  return join(wrenchStateHome(environment), STORE_DIRECTORY);
}

function omniStoreDirectory(environment: Environment): string {
  return join(wrenchStateHome(environment), OMNI_STORE_DIRECTORY);
}

function storeDirectoryForClass(
  storageClass: ProjectionStorageClass,
  environment: Environment,
): string {
  return storageClass === "exact-v1"
    ? storeDirectory(environment)
    : omniStoreDirectory(environment);
}

function keyPath(environment: Environment): string {
  return join(wrenchStateHome(environment), KEY_FILE);
}

function controlDirectory(environment: Environment): string {
  return join(wrenchStateHome(environment), CONTROL_DIRECTORY);
}

function storeKeyMarkerPath(environment: Environment): string {
  return join(controlDirectory(environment), STORE_KEY_MARKER_FILE);
}

function realmDirectory(
  realmKey: string,
  environment: Environment,
  storageClass: ProjectionStorageClass = "exact-v1",
): string {
  return join(
    storeDirectoryForClass(storageClass, environment),
    hexDigest(realmKey, "projection realm key"),
  );
}

function queryDirectory(query: ReadProjectionQuery, environment: Environment): string {
  return join(
    realmDirectory(
      query.realmKey,
      environment,
      projectionStorageClass(query),
    ),
    query.key,
  );
}

function headPath(query: ReadProjectionQuery, environment: Environment): string {
  return join(queryDirectory(query, environment), HEAD_FILE);
}

function projectionKeyId(key: Buffer): string {
  return hmac(key, "wrench-read-projection-key-id-v1", key);
}

function projectionStoreKeyMarkerBody(keyId: string): Readonly<{
  schemaVersion: 1;
  keyId: string;
}> {
  return Object.freeze({ schemaVersion: 1, keyId });
}

function projectionStoreKeyMarker(key: ProjectionKey): ProjectionStoreKeyMarkerV1 {
  const body = projectionStoreKeyMarkerBody(key.id);
  return Object.freeze({
    ...body,
    authentication: hmac(
      key.value,
      "wrench-read-projection-store-key-marker-v1",
      canonicalJson(body),
    ),
  });
}

function parseProjectionStoreKeyMarker(
  text: string,
  key: ProjectionKey,
): ProjectionStoreKeyMarkerV1 {
  let marker: ProjectionStoreKeyMarkerV1;
  try {
    const value = record(
      JSON.parse(text) as unknown,
      "read projection store key marker",
    );
    exactKeys(
      value,
      ["schemaVersion", "keyId", "authentication"],
      "read projection store key marker",
    );
    if (value.schemaVersion !== 1) {
      throw new Error("unsupported read projection store key marker");
    }
    marker = Object.freeze({
      schemaVersion: 1,
      keyId: hexDigest(value.keyId, "read projection store key marker key ID"),
      authentication: hexDigest(
        value.authentication,
        "read projection store key marker authentication",
      ),
    });
    if (text !== `${canonicalJson(marker)}\n`) {
      throw new Error("read projection store key marker is not canonical");
    }
  } catch {
    throw new Error("read projection store key marker is malformed");
  }
  const expectedAuthentication = hmac(
    key.value,
    "wrench-read-projection-store-key-marker-v1",
    canonicalJson(projectionStoreKeyMarkerBody(marker.keyId)),
  );
  if (
    marker.keyId !== key.id
    || !authenticated(marker.authentication, expectedAuthentication)
  ) {
    throw new Error(
      "read projection store key marker does not match the projection encryption key",
    );
  }
  return marker;
}

function newProjectionKeyRecord(): Readonly<{
  schemaVersion: 1;
  keyId: string;
  key: string;
}> {
  const key = randomBytes(32);
  return Object.freeze({
    schemaVersion: 1,
    keyId: projectionKeyId(key),
    key: key.toString("hex"),
  });
}

function parseProjectionKey(text: string): ProjectionKey {
  try {
    const value = record(JSON.parse(text) as unknown, "projection encryption key");
    exactKeys(value, ["schemaVersion", "keyId", "key"], "projection encryption key");
    if (value.schemaVersion !== 1) throw new Error("unsupported projection encryption key");
    const id = hexDigest(value.keyId, "projection encryption key ID");
    const keyHex = hexDigest(value.key, "projection encryption key bytes");
    const key = Buffer.from(keyHex, "hex");
    if (projectionKeyId(key) !== id) throw new Error("projection encryption key is not identity-bound");
    return Object.freeze({ id, value: key });
  } catch {
    throw new Error("projection encryption key is malformed");
  }
}

function encryptedStoreHasState(environment: Environment): boolean {
  const directory = storeDirectory(environment);
  const identity = ensureProjectionStateDirectory(directory, environment);
  const exactHasState = listPrivateStateDirectory(
    directory,
    environment,
    identity,
    { recoverOrphanedMutationClaims: true },
  ).length > 0;
  if (exactHasState) return true;
  try {
    lstatSync(omniStoreDirectory(environment));
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return false;
    throw error;
  }
  return snapshotPrivateStateDirectory(
    omniStoreDirectory(environment),
    environment,
    undefined,
    { recoverOrphanedMutationClaims: true },
  ).entries.length > 0;
}

function readProjectionKeyIfPresent(environment: Environment): ProjectionKey | null {
  try {
    return parseProjectionKey(
      readRegularFile(keyPath(environment), KEY_FILE_MAX_BYTES, "projection encryption key").trim(),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "projection encryption key is malformed") {
      throw error;
    }
    return null;
  }
}

function readProjectionStoreKeyMarkerIfPresent(
  environment: Environment,
): string | null {
  for (let attempt = 0; attempt < INITIALIZATION_SETTLE_ATTEMPTS; attempt += 1) {
    try {
      return readPrivateStateFileIfPresent(
        storeKeyMarkerPath(environment),
        STORE_KEY_MARKER_MAX_BYTES,
        "read projection store key marker",
        environment,
      );
    } catch (error) {
      if (!isConcurrentDirectoryCreation(error)) throw error;
      waitForProjectionInitialization();
    }
  }
  throw new Error("read projection store marker lookup did not settle");
}

function waitForProjectionInitialization(): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    INITIALIZATION_SETTLE_WAIT_MS,
  );
}

function isActiveStateMutation(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("state file mutation is already active");
}

function isConcurrentDirectoryCreation(error: unknown): boolean {
  return error instanceof Error
    && (
      error.message.includes("state directory appeared where absence was required")
      || error.message.includes("state directory appeared while being created")
      || error.message.includes("state directory appeared where absence was expected")
    );
}

function ensureProjectionStateDirectory(
  path: string,
  environment: Environment,
): PrivateDirectoryIdentity {
  for (let attempt = 0; attempt < INITIALIZATION_SETTLE_ATTEMPTS; attempt += 1) {
    try {
      return ensurePrivateStateDirectory(path, environment);
    } catch (error) {
      if (!isConcurrentDirectoryCreation(error)) throw error;
      waitForProjectionInitialization();
    }
  }
  throw new Error("read projection state-directory initialization did not settle");
}

function ensureProjectionStoreKeyMarker(
  key: ProjectionKey,
  environment: Environment,
  create: boolean,
): boolean {
  for (let attempt = 0; attempt < INITIALIZATION_SETTLE_ATTEMPTS; attempt += 1) {
    const content = readProjectionStoreKeyMarkerIfPresent(environment);
    if (content !== null) {
      parseProjectionStoreKeyMarker(content, key);
      return true;
    }
    if (encryptedStoreHasState(environment)) {
      throw new Error(
        "read projection store is missing its key ownership marker",
      );
    }
    if (!create) return false;

    const controlIdentity = ensureProjectionStateDirectory(
      controlDirectory(environment),
      environment,
    );
    try {
      createPrivateJsonIfAbsent(
        storeKeyMarkerPath(environment),
        projectionStoreKeyMarker(key),
        {
          environment,
          expectedStateParent: controlIdentity,
        },
      );
    } catch (error) {
      if (!isActiveStateMutation(error)) throw error;
      waitForProjectionInitialization();
      continue;
    }

    const settled = readPrivateStateFileIfPresent(
      storeKeyMarkerPath(environment),
      STORE_KEY_MARKER_MAX_BYTES,
      "read projection store key marker",
      environment,
      [controlIdentity],
    );
    if (settled !== null) {
      parseProjectionStoreKeyMarker(settled, key);
      return true;
    }
    waitForProjectionInitialization();
  }
  throw new Error("read projection store key marker did not settle");
}

function projectionKey(environment: Environment, create: boolean): ProjectionKey | null {
  let key = readProjectionKeyIfPresent(environment);
  if (key === null) {
    const markerExists = readProjectionStoreKeyMarkerIfPresent(environment) !== null;
    const storeHasState = markerExists
      ? false
      : encryptedStoreHasState(environment);
    if (markerExists || storeHasState) {
      key = readProjectionKeyIfPresent(environment);
      if (key === null) {
        throw new Error(
          "projection encryption key is unavailable while encrypted read projections exist",
        );
      }
    }
    if (key === null && !create) return null;
  }

  if (key === null) {
    for (let attempt = 0; attempt < INITIALIZATION_SETTLE_ATTEMPTS; attempt += 1) {
      try {
        createPrivateJsonIfAbsent(keyPath(environment), newProjectionKeyRecord(), {
          environment,
          privateParent: true,
        });
      } catch (error) {
        if (!isActiveStateMutation(error)) throw error;
      }
      key = readProjectionKeyIfPresent(environment);
      if (key !== null) break;
      waitForProjectionInitialization();
    }
    if (key === null) throw new Error("projection encryption key is unavailable");
  }

  return ensureProjectionStoreKeyMarker(key, environment, create)
    ? key
    : null;
}

function parseIdentity(value: unknown): ReadProjectionQueryIdentity {
  const identity = record(value, "read projection query identity");
  exactKeys(identity, ["adapter", "operation", "input", "inputHash", "auth", "contract"], "read projection query identity");
  const adapter = record(identity.adapter, "read projection adapter");
  exactKeys(adapter, ["id", "version", "hash"], "read projection adapter");
  const auth = record(identity.auth, "read projection auth");
  exactKeys(auth, ["id", "kind", "hash", "subject"], "read projection auth");
  const contract = record(identity.contract, "read projection contract");
  exactKeys(
    contract,
    contract.transport === "local-cli"
      ? ["transport", "hash", "tool"]
      : ["transport", "hash"],
    "read projection contract",
  );
  const input = boundedJson(identity.input, "read projection input");
  const inputHash = hexDigest(identity.inputHash, "read projection input hash");
  if (hashBytes(canonicalJson(input)) !== inputHash) {
    throw new Error("read projection input is not hash-bound");
  }
  const transport = contract.transport;
  if (
    transport !== "browser"
    && transport !== "portable-provider-plugin"
    && transport !== "provider-api"
    && transport !== "reviewed-template-api"
    && transport !== "web-session-api"
    && transport !== "local-cli"
  ) throw new Error("read projection contract transport is malformed");
  const contractHash = hexDigest(contract.hash, "read projection contract hash");
  const parsedContract = transport === "local-cli"
    ? Object.freeze({
        transport,
        hash: contractHash,
        tool: parseLocalCliToolIdentityV1(contract.tool),
      })
    : Object.freeze({ transport, hash: contractHash });
  return Object.freeze({
    adapter: Object.freeze({
      id: safeString(adapter.id, "read projection adapter ID", 64),
      version: safeString(adapter.version, "read projection adapter version", 64),
      hash: hexDigest(adapter.hash, "read projection adapter hash"),
    }),
    operation: safeString(identity.operation, "read projection operation", 128),
    input,
    inputHash,
    auth: Object.freeze({
      id: authId(auth.id),
      kind: safeString(auth.kind, "read projection auth kind", 64),
      hash: hexDigest(auth.hash, "read projection auth hash"),
      subject: safeString(auth.subject, "read projection auth subject", 512),
    }),
    contract: parsedContract,
  });
}

function queryForIdentity(
  identityValue: ReadProjectionQueryIdentity,
  environment: Environment,
  projectionKeyValue?: ProjectionKey,
): ReadProjectionQuery {
  const identity = parseIdentity(identityValue);
  const key = projectionKeyValue ?? projectionKey(environment, true);
  if (key === null) throw new Error("projection encryption key is unavailable");
  return Object.freeze({
    key: hmac(key.value, "wrench-read-projection-query-v1", canonicalJson(identity)),
    realmKey: hmac(key.value, "wrench-read-projection-realm-v1", identity.auth.id),
    identity,
  });
}

function omniQueryForIdentity(
  identityValue: ReadProjectionQueryIdentity,
  environment: Environment,
  projectionKeyValue?: ProjectionKey,
): OmniProjectionQuery {
  const identity = parseIdentity(identityValue);
  const key = projectionKeyValue ?? projectionKey(environment, true);
  if (key === null) throw new Error("projection encryption key is unavailable");
  return Object.freeze({
    storageClass: "omni-v1" as const,
    key: hmac(key.value, "wrench-omni-projection-query-v1", canonicalJson(identity)),
    realmKey: hmac(key.value, "wrench-omni-projection-realm-v1", identity.auth.id),
    identity,
  });
}

export function createReadProjectionQuery(
  identity: ReadProjectionQueryIdentity,
  environment: Environment = process.env,
): ReadProjectionQuery {
  return queryForIdentity(identity, environment);
}

export function createOmniProjectionQuery(
  identity: ReadProjectionQueryIdentity,
  environment: Environment = process.env,
): OmniProjectionQuery {
  return omniQueryForIdentity(identity, environment);
}

function parseQueryValue(value: unknown): ReadProjectionQuery {
  const query = record(value, "read projection query");
  exactKeys(
    query,
    ["key", "realmKey", "identity"],
    "read projection query",
  );
  return Object.freeze({
    key: hexDigest(query.key, "read projection query key"),
    realmKey: hexDigest(query.realmKey, "read projection realm key"),
    identity: parseIdentity(query.identity),
  });
}

function parseOmniQueryValue(value: unknown): OmniProjectionQuery {
  const query = record(value, "omni projection query");
  exactKeys(
    query,
    ["storageClass", "key", "realmKey", "identity"],
    "omni projection query",
  );
  if (query.storageClass !== "omni-v1") {
    throw new Error("omni projection storage class is malformed");
  }
  return Object.freeze({
    storageClass: "omni-v1",
    key: hexDigest(query.key, "omni projection query key"),
    realmKey: hexDigest(query.realmKey, "omni projection realm key"),
    identity: parseIdentity(query.identity),
  });
}

function projectionStorageClass(
  query: ReadProjectionQuery,
): ProjectionStorageClass {
  return Object.hasOwn(query, "storageClass")
    ? (query as OmniProjectionQuery).storageClass
    : "exact-v1";
}

function validateQuery(query: ReadProjectionQuery, environment: Environment): {
  readonly query: ReadProjectionQuery;
  readonly key: ProjectionKey;
} {
  const parsed = parseQueryValue(query);
  const key = projectionKey(environment, true);
  if (key === null) throw new Error("projection encryption key is unavailable");
  const expected = queryForIdentity(parsed.identity, environment, key);
  if (parsed.key !== expected.key || parsed.realmKey !== expected.realmKey) {
    throw new Error("read projection query is not bound to its current private key");
  }
  return { query: expected, key };
}

function validateOmniQuery(
  query: OmniProjectionQuery,
  environment: Environment,
): {
  readonly query: OmniProjectionQuery;
  readonly key: ProjectionKey;
} {
  const parsed = parseOmniQueryValue(query);
  const key = projectionKey(environment, true);
  if (key === null) throw new Error("projection encryption key is unavailable");
  const expected = omniQueryForIdentity(parsed.identity, environment, key);
  if (parsed.key !== expected.key || parsed.realmKey !== expected.realmKey) {
    throw new Error("omni projection query is not bound to its current private key");
  }
  return { query: expected, key };
}

function parseHeadPublication(value: unknown): ReadProjectionHeadPublication {
  const publication = record(value, "read projection head publication");
  exactKeys(
    publication,
    [
      "dataRevision",
      "createdAt",
      "dataChangedAt",
      "validatedAt",
      "runId",
      "startedAt",
      "finishedAt",
    ],
    "read projection head publication",
  );
  const createdAt = timestamp(
    publication.createdAt,
    "read projection head creation time",
  );
  const dataChangedAt = timestamp(
    publication.dataChangedAt,
    "read projection head data-change time",
  );
  const validatedAt = timestamp(
    publication.validatedAt,
    "read projection head validation time",
  );
  const startedAt = timestamp(
    publication.startedAt,
    "read projection head start time",
  );
  const finishedAt = timestamp(
    publication.finishedAt,
    "read projection head finish time",
  );
  if (
    createdAt > dataChangedAt
    || dataChangedAt > validatedAt
    || startedAt > finishedAt
    || validatedAt !== finishedAt
  ) throw new Error("read projection head timestamps are inconsistent");
  return Object.freeze({
    dataRevision: hexDigest(
      publication.dataRevision,
      "read projection head data revision",
    ),
    createdAt,
    dataChangedAt,
    validatedAt,
    runId: runId(publication.runId),
    startedAt,
    finishedAt,
  });
}

function headPublication(
  payload: Pick<
    ProjectionPayloadV1,
    | "dataRevision"
    | "createdAt"
    | "dataChangedAt"
    | "validatedAt"
    | "runId"
    | "startedAt"
    | "finishedAt"
  >,
): ReadProjectionHeadPublication {
  return Object.freeze({
    dataRevision: payload.dataRevision,
    createdAt: payload.createdAt,
    dataChangedAt: payload.dataChangedAt,
    validatedAt: payload.validatedAt,
    runId: payload.runId,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
  });
}

function headBody(head: Omit<ProjectionHeadV1, "authentication">): string {
  return canonicalJson(head);
}

function headAuthentication(
  key: ProjectionKey,
  query: ReadProjectionQuery,
  body: Omit<ProjectionHeadV1, "authentication">,
): string {
  return hmac(
    key.value,
    `wrench-read-projection-head-v1\0${query.realmKey}\0${query.key}`,
    headBody(body),
  );
}

function parseHead(
  value: unknown,
  query: ReadProjectionQuery,
  key: ProjectionKey,
): ProjectionHeadV1 {
  const head = record(value, "read projection head");
  exactKeys(
    head,
    [
      "schemaVersion",
      "keyId",
      "revisionId",
      "manifestFile",
      "publication",
      "authentication",
    ],
    "read projection head",
  );
  if (head.schemaVersion !== 1) throw new Error("unsupported read projection head schema");
  const revisionId = safeString(head.revisionId, "read projection revision ID", 64);
  if (!/^[a-f0-9]{32}$/u.test(revisionId)) throw new Error("read projection revision ID is malformed");
  const manifestFile = safeString(head.manifestFile, "read projection manifest filename", 128);
  if (manifestFile !== `manifest--${revisionId}.json`) {
    throw new Error("read projection head names the wrong manifest");
  }
  const body = {
    schemaVersion: 1 as const,
    keyId: hexDigest(head.keyId, "read projection head key ID"),
    revisionId,
    manifestFile,
    publication: parseHeadPublication(head.publication),
  };
  if (body.keyId !== key.id) throw new Error("read projection head uses another encryption key");
  const authentication = hexDigest(head.authentication, "read projection head authentication");
  if (!authenticated(authentication, headAuthentication(key, query, body))) {
    throw new Error("read projection head failed authentication");
  }
  return Object.freeze({ ...body, authentication });
}

function manifestAuthentication(
  key: ProjectionKey,
  query: ReadProjectionQuery,
  body: Omit<ProjectionManifestV1, "authentication">,
): string {
  return hmac(
    key.value,
    `wrench-read-projection-manifest-v1\0${query.realmKey}\0${query.key}`,
    canonicalJson(body),
  );
}

function parseManifest(
  value: unknown,
  query: ReadProjectionQuery,
  key: ProjectionKey,
  revisionId: string,
): ProjectionManifestV1 {
  const manifest = record(value, "read projection manifest");
  exactKeys(
    manifest,
    ["schemaVersion", "keyId", "revisionId", "plaintextBytes", "chunkFiles", "chunkHashes", "authentication"],
    "read projection manifest",
  );
  if (manifest.schemaVersion !== 1) throw new Error("unsupported read projection manifest schema");
  const rawChunkFiles = manifest.chunkFiles;
  const rawChunkHashes = manifest.chunkHashes;
  if (!Array.isArray(rawChunkFiles) || !Array.isArray(rawChunkHashes)) {
    throw new Error("read projection manifest has malformed chunks");
  }
  const count = rawChunkFiles.length;
  if (count < 1 || count > MAX_CHUNKS || rawChunkHashes.length !== count) {
    throw new Error("read projection manifest has malformed chunks");
  }
  const chunkFiles = rawChunkFiles.map((file, index) => {
    const name = safeString(file, `read projection chunk filename ${index}`, 128);
    const expected = `chunk--${revisionId}--${String(index).padStart(3, "0")}.json`;
    if (name !== expected) throw new Error("read projection manifest names the wrong chunk");
    return name;
  });
  const chunkHashes = rawChunkHashes.map((hash, index) =>
    hexDigest(hash, `read projection chunk hash ${index}`));
  const body = {
    schemaVersion: 1 as const,
    keyId: hexDigest(manifest.keyId, "read projection manifest key ID"),
    revisionId: safeString(manifest.revisionId, "read projection manifest revision ID", 64),
    plaintextBytes: safeInteger(manifest.plaintextBytes, "read projection plaintext bytes", 1, MAX_PLAINTEXT_BYTES),
    chunkFiles: Object.freeze(chunkFiles),
    chunkHashes: Object.freeze(chunkHashes),
  };
  if (body.keyId !== key.id || body.revisionId !== revisionId) {
    throw new Error("read projection manifest identity does not match its head");
  }
  const authentication = hexDigest(manifest.authentication, "read projection manifest authentication");
  if (!authenticated(authentication, manifestAuthentication(key, query, body))) {
    throw new Error("read projection manifest failed authentication");
  }
  return Object.freeze({ ...body, authentication });
}

function boundedBase64(value: unknown, label: string, maximumBytes: number): Buffer {
  if (
    typeof value !== "string"
    || value.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) throw new Error(`${label} is malformed`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maximumBytes || bytes.toString("base64") !== value) {
    throw new Error(`${label} is malformed`);
  }
  return bytes;
}

function chunkAdditionalData(
  key: ProjectionKey,
  query: ReadProjectionQuery,
  revisionId: string,
  index: number,
  count: number,
): Buffer {
  return Buffer.from(
    `wrench-read-projection-chunk-v1\0${key.id}\0${query.realmKey}\0${query.key}\0${revisionId}\0${index}\0${count}`,
    "utf8",
  );
}

function parseChunk(
  value: unknown,
  key: ProjectionKey,
  revisionId: string,
  index: number,
  count: number,
): EncryptedProjectionChunkV1 {
  const chunk = record(value, "encrypted read projection chunk");
  exactKeys(
    chunk,
    ["schemaVersion", "encryption", "keyId", "revisionId", "index", "count", "iv", "ciphertext", "tag"],
    "encrypted read projection chunk",
  );
  if (chunk.schemaVersion !== 1 || chunk.encryption !== "aes-256-gcm") {
    throw new Error("unsupported read projection chunk schema");
  }
  const parsed: EncryptedProjectionChunkV1 = Object.freeze({
    schemaVersion: 1,
    encryption: "aes-256-gcm",
    keyId: hexDigest(chunk.keyId, "read projection chunk key ID"),
    revisionId: safeString(chunk.revisionId, "read projection chunk revision ID", 64),
    index: safeInteger(chunk.index, "read projection chunk index", 0, MAX_CHUNKS - 1),
    count: safeInteger(chunk.count, "read projection chunk count", 1, MAX_CHUNKS),
    iv: boundedBase64(chunk.iv, "read projection chunk IV", 12).toString("base64"),
    ciphertext: boundedBase64(chunk.ciphertext, "read projection chunk ciphertext", PLAINTEXT_CHUNK_BYTES).toString("base64"),
    tag: boundedBase64(chunk.tag, "read projection chunk tag", 16).toString("base64"),
  });
  if (
    parsed.keyId !== key.id
    || parsed.revisionId !== revisionId
    || parsed.index !== index
    || parsed.count !== count
  ) throw new Error("read projection chunk identity is inconsistent");
  return parsed;
}

function parsePayload(
  value: unknown,
  query: ReadProjectionQuery,
  dataRevisionForOutput: (output: unknown) => string,
): ProjectionPayloadV1 {
  const payload = record(value, "read projection payload");
  exactKeys(
    payload,
    ["schemaVersion", "query", "output", "dataRevision", "createdAt", "dataChangedAt", "validatedAt", "runId", "startedAt", "finishedAt"],
    "read projection payload",
  );
  if (payload.schemaVersion !== 1) throw new Error("unsupported read projection payload schema");
  const identity = parseIdentity(payload.query);
  if (canonicalJson(identity) !== canonicalJson(query.identity)) {
    throw new Error("read projection payload names another query");
  }
  const output = boundedJson(payload.output, "read projection output");
  const dataRevision = hexDigest(payload.dataRevision, "read projection data revision");
  if (dataRevision !== dataRevisionForOutput(output)) {
    throw new Error("read projection output is not revision-bound");
  }
  const createdAt = timestamp(payload.createdAt, "read projection creation time");
  const dataChangedAt = timestamp(payload.dataChangedAt, "read projection data-change time");
  const validatedAt = timestamp(payload.validatedAt, "read projection validation time");
  const startedAt = timestamp(payload.startedAt, "read projection start time");
  const finishedAt = timestamp(payload.finishedAt, "read projection finish time");
  if (
    createdAt > dataChangedAt
    || dataChangedAt > validatedAt
    || startedAt > finishedAt
    || validatedAt !== finishedAt
  ) throw new Error("read projection timestamps are inconsistent");
  return Object.freeze({
    schemaVersion: 1,
    query: identity,
    output,
    dataRevision,
    createdAt,
    dataChangedAt,
    validatedAt,
    runId: runId(payload.runId),
    startedAt,
    finishedAt,
  });
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

function encryptedChunk(
  plaintext: Buffer,
  query: ReadProjectionQuery,
  key: ProjectionKey,
  revisionId: string,
  index: number,
  count: number,
): EncryptedProjectionChunkV1 {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.value, iv);
  cipher.setAAD(chunkAdditionalData(key, query, revisionId, index, count));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    schemaVersion: 1,
    encryption: "aes-256-gcm",
    keyId: key.id,
    revisionId,
    index,
    count,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  });
}

function decryptChunk(
  chunk: EncryptedProjectionChunkV1,
  query: ReadProjectionQuery,
  key: ProjectionKey,
): Buffer {
  try {
    const iv = Buffer.from(chunk.iv, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key.value, iv);
    decipher.setAAD(
      chunkAdditionalData(key, query, chunk.revisionId, chunk.index, chunk.count),
    );
    decipher.setAuthTag(Buffer.from(chunk.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(chunk.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new Error("read projection chunk failed authentication");
  }
}

function dataRevision(
  key: ProjectionKey,
  output: unknown,
  storageClass: ProjectionStorageClass = "exact-v1",
): string {
  return hmac(
    key.value,
    storageClass === "exact-v1"
      ? "wrench-read-projection-data-v1"
      : "wrench-omni-projection-data-v1",
    canonicalJson(output),
  );
}

function corruptionContext(
  query: ReadProjectionQuery,
  headContentSha256: string,
  headPublicationValue: ReadProjectionHeadPublication | null,
): ReadProjectionCorruptionEvidence {
  return Object.freeze({
    storageClass: projectionStorageClass(query),
    queryKey: query.key,
    realmKey: query.realmKey,
    headContentSha256,
    headPublication: headPublicationValue,
  });
}

function corruption(
  evidence: ReadProjectionCorruptionEvidence,
  message: string,
  cause?: unknown,
): ReadProjectionCorruptionError {
  if (isReadProjectionCorruptionError(cause)) return cause;
  return new ReadProjectionCorruptionError(
    message,
    evidence,
    { cause },
    corruptionConstructorToken,
  );
}

function decodeProjectionArtifact(
  bytes: Buffer,
  evidence: ReadProjectionCorruptionEvidence,
  label: string,
): string {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch (error) {
    throw corruption(evidence, `${label} is not valid UTF-8`, error);
  }
}

function readHead(
  query: ReadProjectionQuery,
  key: ProjectionKey,
  environment: Environment,
): ProjectionHeadSnapshot | null {
  const bytes = readPrivateStateFileBytesIfPresent(
    headPath(query, environment),
    MAX_ATTRIBUTABLE_CORRUPT_FILE_BYTES,
    "read projection head",
    environment,
  );
  if (bytes === null) return null;
  const contentSha256 = hashBytes(bytes);
  const evidence = corruptionContext(query, contentSha256, null);
  if (bytes.byteLength > HEAD_MAX_BYTES) {
    throw corruption(evidence, "read projection head exceeds its byte bound");
  }
  const text = decodeProjectionArtifact(
    bytes,
    evidence,
    "read projection head",
  );
  let head: ProjectionHeadV1;
  try {
    head = parseHead(parseJson(text, "read projection head"), query, key);
  } catch (error) {
    throw corruption(evidence, "read projection head is corrupt", error);
  }
  return Object.freeze({ head, contentSha256 });
}

function loadFromHead(
  query: ReadProjectionQuery,
  key: ProjectionKey,
  headSnapshot: ProjectionHeadSnapshot,
  environment: Environment,
): LoadedProjection {
  const directory = queryDirectory(query, environment);
  const evidence = corruptionContext(
    query,
    headSnapshot.contentSha256,
    headSnapshot.head.publication,
  );
  const manifestBytes = readPrivateStateFileBytesIfPresent(
    join(directory, headSnapshot.head.manifestFile),
    MAX_ATTRIBUTABLE_CORRUPT_FILE_BYTES,
    "read projection manifest",
    environment,
  );
  if (manifestBytes === null) {
    throw corruption(evidence, "read projection head names a missing manifest");
  }
  if (manifestBytes.byteLength > MANIFEST_MAX_BYTES) {
    throw corruption(
      evidence,
      "read projection manifest exceeds its byte bound",
    );
  }
  const manifestText = decodeProjectionArtifact(
    manifestBytes,
    evidence,
    "read projection manifest",
  );
  let manifest: ProjectionManifestV1;
  try {
    manifest = parseManifest(
      parseJson(manifestText, "read projection manifest"),
      query,
      key,
      headSnapshot.head.revisionId,
    );
  } catch (error) {
    throw corruption(evidence, "read projection manifest is corrupt", error);
  }
  const plaintext: Buffer[] = [];
  for (const [index, file] of manifest.chunkFiles.entries()) {
    const bytes = readPrivateStateFileBytesIfPresent(
      join(directory, file),
      MAX_ATTRIBUTABLE_CORRUPT_FILE_BYTES,
      `read projection chunk ${index}`,
      environment,
    );
    if (bytes === null) {
      throw corruption(evidence, "read projection manifest names a missing chunk");
    }
    if (bytes.byteLength > MAX_PRIVATE_STATE_BATCH_FILE_BYTES) {
      throw corruption(
        evidence,
        `read projection chunk ${index} exceeds its byte bound`,
      );
    }
    if (hashBytes(bytes) !== manifest.chunkHashes[index]) {
      throw corruption(evidence, "read projection chunk does not match its manifest");
    }
    const text = decodeProjectionArtifact(
      bytes,
      evidence,
      `read projection chunk ${index}`,
    );
    try {
      const chunk = parseChunk(
        parseJson(text, `read projection chunk ${index}`),
        key,
        manifest.revisionId,
        index,
        manifest.chunkFiles.length,
      );
      plaintext.push(decryptChunk(chunk, query, key));
    } catch (error) {
      throw corruption(evidence, `read projection chunk ${index} is corrupt`, error);
    }
  }
  const bytes = Buffer.concat(plaintext);
  if (bytes.byteLength !== manifest.plaintextBytes) {
    throw corruption(
      evidence,
      "read projection plaintext length does not match its manifest",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw corruption(evidence, "read projection plaintext is malformed", error);
  }
  let payload: ProjectionPayloadV1;
  try {
    payload = parsePayload(
      parsed,
      query,
      (output) => dataRevision(key, output, projectionStorageClass(query)),
    );
  } catch (error) {
    throw corruption(evidence, "read projection payload is corrupt", error);
  }
  if (
    canonicalJson(headPublication(payload))
    !== canonicalJson(headSnapshot.head.publication)
  ) {
    throw corruption(
      evidence,
      "read projection payload does not match its authenticated head publication",
    );
  }
  return Object.freeze({
    head: headSnapshot.head,
    headContentSha256: headSnapshot.contentSha256,
    payload,
  });
}

function loadProjection(
  query: ReadProjectionQuery,
  key: ProjectionKey,
  environment: Environment,
): LoadedProjection | null {
  let first = readHead(query, key, environment);
  if (first === null) return null;
  try {
    return loadFromHead(query, key, first, environment);
  } catch (error) {
    const second = readHead(query, key, environment);
    if (second === null) return null;
    if (second.contentSha256 === first.contentSha256) throw error;
    first = second;
    return loadFromHead(query, key, first, environment);
  }
}

function freshness(
  validatedAt: string,
  now: Date,
  freshForMs: number | undefined,
): { readonly state: "fresh" | "stale" | "unclassified"; readonly freshForMs: number | null; readonly ageMs: number } {
  if (!Number.isFinite(now.getTime())) throw new Error("read projection observation time is invalid");
  const ageMs = Math.max(0, now.getTime() - new Date(validatedAt).getTime());
  if (freshForMs === undefined) {
    return { state: "unclassified", freshForMs: null, ageMs };
  }
  safeInteger(freshForMs, "read projection freshness window", 0, MAX_FRESH_FOR_MS);
  return {
    state: ageMs <= freshForMs ? "fresh" : "stale",
    freshForMs,
    ageMs,
  };
}

export function readReadProjection(
  queryValue: ReadProjectionQuery,
  options: {
    readonly environment?: Environment;
    readonly now?: Date;
    readonly freshForMs?: number;
  } = {},
): ReadProjectionCacheResult {
  const environment = options.environment ?? process.env;
  const authId = parseQueryValue(queryValue).identity.auth.id;
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const { query, key } = validateQuery(queryValue, environment);
    const loaded = loadProjection(query, key, environment);
    if (loaded === null) {
      return Object.freeze({ status: "miss" as const, key: query.key });
    }
    const observed = freshness(
      loaded.payload.validatedAt,
      options.now ?? new Date(),
      options.freshForMs,
    );
    return Object.freeze({
      status: "hit" as const,
      source: "cache" as const,
      key: query.key,
      output: loaded.payload.output,
      dataRevision: loaded.payload.dataRevision,
      createdAt: loaded.payload.createdAt,
      dataChangedAt: loaded.payload.dataChangedAt,
      validatedAt: loaded.payload.validatedAt,
      runId: loaded.payload.runId,
      ageMs: observed.ageMs,
      freshness: Object.freeze({
        state: observed.state,
        freshForMs: observed.freshForMs,
      }),
    });
  });
}

export function readOmniProjection(
  queryValue: OmniProjectionQuery,
  options: {
    readonly environment?: Environment;
    readonly now?: Date;
    readonly freshForMs?: number;
  } = {},
): OmniProjectionCacheResult {
  const environment = options.environment ?? process.env;
  const authId = parseOmniQueryValue(queryValue).identity.auth.id;
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const { query, key } = validateOmniQuery(queryValue, environment);
    const loaded = loadProjection(query, key, environment);
    if (loaded === null) {
      return Object.freeze({ status: "miss" as const, key: query.key });
    }
    const observed = freshness(
      loaded.payload.validatedAt,
      options.now ?? new Date(),
      options.freshForMs,
    );
    return Object.freeze({
      status: "hit" as const,
      source: "cache" as const,
      key: query.key,
      storageRevisionId: loaded.head.revisionId,
      output: immutableBoundedJson(
        loaded.payload.output,
        "omni projection current output",
      ),
      dataRevision: loaded.payload.dataRevision,
      createdAt: loaded.payload.createdAt,
      dataChangedAt: loaded.payload.dataChangedAt,
      validatedAt: loaded.payload.validatedAt,
      runId: loaded.payload.runId,
      startedAt: loaded.payload.startedAt,
      finishedAt: loaded.payload.finishedAt,
      ageMs: observed.ageMs,
      freshness: Object.freeze({
        state: observed.state,
        freshForMs: observed.freshForMs,
      }),
    });
  });
}

/**
 * Observe the authoritative exact head with the immutable storage revision and
 * execution interval required by a provider-owned materializer. The ordinary
 * exact cache API intentionally keeps its existing public shape.
 */
export function readReadProjectionForMaterialization(
  queryValue: ReadProjectionQuery,
  options: {
    readonly environment?: Environment;
    readonly now?: Date;
    readonly freshForMs?: number;
  } = {},
): ReadProjectionMaterializationSnapshot {
  const environment = options.environment ?? process.env;
  const authId = parseQueryValue(queryValue).identity.auth.id;
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const { query, key } = validateQuery(queryValue, environment);
    const loaded = loadProjection(query, key, environment);
    if (loaded === null) {
      return Object.freeze({ status: "miss" as const, key: query.key });
    }
    const observed = freshness(
      loaded.payload.validatedAt,
      options.now ?? new Date(),
      options.freshForMs,
    );
    return Object.freeze({
      status: "hit" as const,
      source: "cache" as const,
      key: query.key,
      storageRevisionId: loaded.head.revisionId,
      output: immutableBoundedJson(
        loaded.payload.output,
        "exact projection materialization output",
      ),
      dataRevision: loaded.payload.dataRevision,
      createdAt: loaded.payload.createdAt,
      dataChangedAt: loaded.payload.dataChangedAt,
      validatedAt: loaded.payload.validatedAt,
      runId: loaded.payload.runId,
      startedAt: loaded.payload.startedAt,
      finishedAt: loaded.payload.finishedAt,
      ageMs: observed.ageMs,
      freshness: Object.freeze({
        state: observed.state,
        freshForMs: observed.freshForMs,
      }),
    });
  });
}

function publicationOrder(payload: Pick<ProjectionPayloadV1, "startedAt" | "finishedAt" | "runId">): string {
  return `${payload.startedAt}\0${payload.finishedAt}\0${payload.runId}`;
}

function revisionFiles(revisionId: string, count: number): readonly string[] {
  return Object.freeze([
    `manifest--${revisionId}.json`,
    ...Array.from(
      { length: count },
      (_, index) => `chunk--${revisionId}--${String(index).padStart(3, "0")}.json`,
    ),
  ]);
}

function isImmutableRevisionFile(name: string): boolean {
  const manifest = immutableManifestNamePattern.exec(name);
  if (manifest !== null) return true;
  const chunk = immutableChunkNamePattern.exec(name);
  if (chunk === null || chunk[2] === undefined) return false;
  const index = Number(chunk[2]);
  return Number.isSafeInteger(index) && index >= 0 && index < MAX_CHUNKS;
}

function removeRevision(
  query: ReadProjectionQuery,
  revisionId: string,
  count: number,
  environment: Environment,
): void {
  const directory = queryDirectory(query, environment);
  for (const file of revisionFiles(revisionId, count)) {
    try {
      removePrivateStateFile(join(directory, file), environment);
    } catch {
      // The promoted head is authoritative. Unreachable immutable files are
      // inert and can be reclaimed later without changing cache truth.
    }
  }
}

function currentChunkCount(
  loaded: LoadedProjection,
  query: ReadProjectionQuery,
  key: ProjectionKey,
  environment: Environment,
): number {
  const manifestText = readPrivateStateFileIfPresent(
    join(queryDirectory(query, environment), loaded.head.manifestFile),
    MANIFEST_MAX_BYTES,
    "read projection manifest",
    environment,
  );
  if (manifestText === null) throw new Error("read projection head names a missing manifest");
  return parseManifest(
    parseJson(manifestText, "read projection manifest"),
    query,
    key,
    loaded.head.revisionId,
  ).chunkFiles.length;
}

function reclaimNonHeadRevisionFiles(
  query: ReadProjectionQuery,
  current: LoadedProjection | null,
  currentCount: number,
  prospectiveRevisionEntries: number,
  environment: Environment,
): void {
  const directory = queryDirectory(query, environment);
  const directoryIdentity = ensurePrivateStateDirectory(directory, environment);
  const expected = current === null
    ? new Set<string>()
    : new Set([HEAD_FILE, ...revisionFiles(current.head.revisionId, currentCount)]);
  const initial = listPrivateStateDirectory(
    directory,
    environment,
    directoryIdentity,
    { recoverOrphanedMutationClaims: true },
  );
  for (const entry of initial) {
    if (
      entry.kind === "file"
      && !expected.has(entry.name)
      && isImmutableRevisionFile(entry.name)
    ) {
      removePrivateStateFile(join(directory, entry.name), environment);
    }
  }

  const settled = listPrivateStateDirectory(
    directory,
    environment,
    directoryIdentity,
    { recoverOrphanedMutationClaims: true },
  );
  if (
    settled.length
      + prospectiveRevisionEntries
      + (current === null ? 1 : 0)
      > MAX_QUERY_DIRECTORY_ENTRIES
  ) {
    throw new Error(
      "read projection query directory exceeds its prospective entry bound",
    );
  }
  if (
    settled.some((entry) =>
      entry.kind !== "file" || !expected.has(entry.name))
  ) {
    throw new Error("read projection query directory has unsupported state");
  }
  if (
    current !== null
    && [...expected].some((name) =>
      !settled.some((entry) => entry.name === name))
  ) {
    throw corruption(
      corruptionContext(
        query,
        current.headContentSha256,
        current.head.publication,
      ),
      "read projection current revision became incomplete",
    );
  }
}

type RealmQueryUsage = {
  readonly name: string;
  readonly identity: PrivateDirectoryIdentity;
  readonly bytes: number;
  readonly state: "usable" | "invalid" | "busy";
};

function readRealmQueryUsage(
  storeIdentity: PrivateDirectoryIdentity,
  realm: string,
  realmIdentity: PrivateDirectoryIdentity,
  name: string,
  identity: PrivateDirectoryIdentity,
  environment: Environment,
  targetFileMaximumBytes?: number,
): RealmQueryUsage {
  const entries = listPrivateStateDirectory(
    join(realm, name),
    environment,
    identity,
    { recoverOrphanedMutationClaims: true },
  );
  const busy = entries.some((entry) =>
    stateHelperArtifactNamePatterns.some((pattern) =>
      pattern.test(entry.name)));
  if (
    entries.length > MAX_QUERY_DIRECTORY_ENTRIES
    || entries.some((entry) => entry.kind !== "file")
  ) {
    return Object.freeze({
      name,
      identity,
      bytes: MAX_REALM_STORAGE_BYTES + 1,
      state: busy ? "busy" : "invalid",
    });
  }
  let bytes = 0;
  if (targetFileMaximumBytes !== undefined) {
    for (const entry of entries) {
      const content = readPrivateStateFileBytesIfPresent(
        join(realm, name, entry.name),
        targetFileMaximumBytes,
        `read projection repair quota file ${entry.name}`,
        environment,
        [storeIdentity, realmIdentity, identity],
      );
      if (content === null) {
        return Object.freeze({
          name,
          identity,
          bytes: MAX_REALM_STORAGE_BYTES + 1,
          state: busy ? "busy" : "invalid",
        });
      }
      bytes += content.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > MAX_REALM_STORAGE_BYTES) {
        return Object.freeze({
          name,
          identity,
          bytes: MAX_REALM_STORAGE_BYTES + 1,
          state: busy ? "busy" : "invalid",
        });
      }
    }
  } else {
    const results = readPrivateStateChildFilesBatched(
      realm,
      entries.map((entry) => ({
        directoryName: name,
        directoryIdentity: identity,
        fileName: entry.name,
      })),
      {
        maximumBytesPerFile: MAX_PRIVATE_STATE_BATCH_FILE_BYTES,
        environment,
        expectedDirectoryIdentity: realmIdentity,
      },
    );
    for (const result of results) {
      if (result.status !== "present") {
        return Object.freeze({
          name,
          identity,
          bytes: MAX_REALM_STORAGE_BYTES + 1,
          state: busy ? "busy" : "invalid",
        });
      }
      bytes += Buffer.byteLength(result.content, "utf8");
      if (!Number.isSafeInteger(bytes) || bytes > MAX_REALM_STORAGE_BYTES) {
        return Object.freeze({
          name,
          identity,
          bytes: MAX_REALM_STORAGE_BYTES + 1,
          state: busy ? "busy" : "invalid",
        });
      }
    }
  }
  return Object.freeze({
    name,
    identity,
    bytes,
    state: busy ? "busy" : "usable",
  });
}

function realmUsage(
  query: ReadProjectionQuery,
  environment: Environment,
  targetFileMaximumBytes?: number,
): {
  readonly realm: string;
  readonly realmIdentity: PrivateDirectoryIdentity;
  readonly queries: readonly RealmQueryUsage[];
} {
  const storageClass = projectionStorageClass(query);
  const storeIdentity = ensurePrivateStateDirectory(
    storeDirectoryForClass(storageClass, environment),
    environment,
  );
  const realm = realmDirectory(query.realmKey, environment, storageClass);
  const realmIdentity = ensurePrivateStateDirectory(realm, environment);
  const snapshot = snapshotPrivateStateDirectory(
    realm,
    environment,
    realmIdentity,
  );
  if (snapshot.identity === null) {
    throw new Error("read projection realm disappeared during quota inspection");
  }
  const queries: RealmQueryUsage[] = [];
  for (const entry of snapshot.entries) {
    if (
      entry.kind !== "directory"
      || entry.identity === undefined
      || !queryDirectoryNamePattern.test(entry.name)
    ) {
      throw new Error("read projection realm contains unsupported state");
    }
    queries.push(readRealmQueryUsage(
      storeIdentity,
      realm,
      snapshot.identity,
      entry.name,
      entry.identity,
      environment,
      entry.name === query.key ? targetFileMaximumBytes : undefined,
    ));
  }
  return Object.freeze({
    realm,
    realmIdentity: snapshot.identity,
    queries: Object.freeze(queries),
  });
}

function admitRealmStorage(
  query: ReadProjectionQuery,
  prospectiveBytes: number,
  environment: Environment,
  targetFileMaximumBytes?: number,
): void {
  for (let attempt = 0; attempt <= MAX_REALM_QUERY_DIRECTORIES; attempt += 1) {
    const usage = realmUsage(query, environment, targetFileMaximumBytes);
    const target = usage.queries.find((entry) => entry.name === query.key);
    if (target?.state === "invalid") {
      throw new Error("read projection target query has invalid quota state");
    }
    const prospectiveCount = usage.queries.length + (target === undefined ? 1 : 0);
    const storedBytes = usage.queries.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    if (
      prospectiveCount <= MAX_REALM_QUERY_DIRECTORIES
      && storedBytes + prospectiveBytes <= MAX_REALM_STORAGE_BYTES
    ) return;

    const candidate = usage.queries
      .filter((entry) =>
        entry.name !== query.key && entry.state !== "busy")
      .sort((left, right) => {
        if (left.state !== right.state) {
          return left.state === "invalid" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })[0];
    if (candidate === undefined) {
      throw new Error("read projection realm exceeds its bounded storage quota");
    }
    if (!removePrivateStateDirectoryTree(
      join(usage.realm, candidate.name),
      environment,
      candidate.identity,
      usage.realmIdentity,
    )) {
      throw new Error("read projection realm reclamation did not settle");
    }
  }
  throw new Error("read projection realm reclamation exceeded its retry bound");
}

type PreparedProjectionRevision = {
  readonly revisionId: string;
  readonly chunks: readonly Readonly<{
    file: string;
    value: EncryptedProjectionChunkV1;
  }>[];
  readonly manifestFile: string;
  readonly manifest: ProjectionManifestV1;
  readonly head: ProjectionHeadV1;
  readonly serializedArtifactBytes: number;
};

function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(`${canonicalJson(value)}\n`, "utf8");
}

function prepareRevision(
  query: ReadProjectionQuery,
  key: ProjectionKey,
  payload: ProjectionPayloadV1,
  plaintext: Buffer,
  chunkCount: number,
): PreparedProjectionRevision {
  const revisionId = randomUUID().replaceAll("-", "");
  const chunks: Array<Readonly<{
    file: string;
    value: EncryptedProjectionChunkV1;
  }>> = [];
  const chunkHashes: string[] = [];
  let serializedArtifactBytes = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const file = `chunk--${revisionId}--${String(index).padStart(3, "0")}.json`;
    const value = encryptedChunk(
      plaintext.subarray(
        index * PLAINTEXT_CHUNK_BYTES,
        Math.min(plaintext.byteLength, (index + 1) * PLAINTEXT_CHUNK_BYTES),
      ),
      query,
      key,
      revisionId,
      index,
      chunkCount,
    );
    const serialized = `${canonicalJson(value)}\n`;
    chunks.push(Object.freeze({ file, value }));
    chunkHashes.push(hashBytes(serialized));
    serializedArtifactBytes += Buffer.byteLength(serialized, "utf8");
  }
  const manifestBody = {
    schemaVersion: 1 as const,
    keyId: key.id,
    revisionId,
    plaintextBytes: plaintext.byteLength,
    chunkFiles: Object.freeze(chunks.map((chunk) => chunk.file)),
    chunkHashes: Object.freeze(chunkHashes),
  };
  const manifest: ProjectionManifestV1 = Object.freeze({
    ...manifestBody,
    authentication: manifestAuthentication(key, query, manifestBody),
  });
  const manifestFile = `manifest--${revisionId}.json`;
  serializedArtifactBytes += serializedJsonBytes(manifest);
  const headBodyValue = {
    schemaVersion: 1 as const,
    keyId: key.id,
    revisionId,
    manifestFile,
    publication: headPublication(payload),
  };
  const head: ProjectionHeadV1 = Object.freeze({
    ...headBodyValue,
    authentication: headAuthentication(key, query, headBodyValue),
  });
  serializedArtifactBytes += serializedJsonBytes(head);
  return Object.freeze({
    revisionId,
    chunks: Object.freeze(chunks),
    manifestFile,
    manifest,
    head,
    serializedArtifactBytes,
  });
}

function writeRevision(
  query: ReadProjectionQuery,
  key: ProjectionKey,
  payload: ProjectionPayloadV1,
  current: LoadedProjection | null,
  environment: Environment,
  mode: "normal" | "preserve-for-repair" = "normal",
): { readonly head: ProjectionHeadV1; readonly chunkCount: number } {
  const directory = queryDirectory(query, environment);
  const plaintext = Buffer.from(canonicalJson(payload), "utf8");
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error("read projection payload exceeds its byte bound");
  }
  const chunkCount = Math.ceil(plaintext.byteLength / PLAINTEXT_CHUNK_BYTES);
  if (chunkCount < 1 || chunkCount > MAX_CHUNKS) {
    throw new Error("read projection payload exceeds its chunk bound");
  }
  const revision = prepareRevision(
    query,
    key,
    payload,
    plaintext,
    chunkCount,
  );
  if (mode === "normal") {
    const oldChunkCount = current === null
      ? 0
      : currentChunkCount(current, query, key, environment);
    reclaimNonHeadRevisionFiles(
      query,
      current,
      oldChunkCount,
      chunkCount + 1,
      environment,
    );
  } else {
    const directoryIdentity = ensurePrivateStateDirectory(directory, environment);
    const entries = listPrivateStateDirectory(
      directory,
      environment,
      directoryIdentity,
      { recoverOrphanedMutationClaims: true },
    );
    if (entries.length + chunkCount + 1 > MAX_QUERY_DIRECTORY_ENTRIES) {
      throw new Error(
        "read projection repair exceeds its prospective entry bound",
      );
    }
  }
  admitRealmStorage(
    query,
    revision.serializedArtifactBytes,
    environment,
    mode === "preserve-for-repair"
      ? MAX_ATTRIBUTABLE_CORRUPT_FILE_BYTES
      : undefined,
  );
  try {
    for (const chunk of revision.chunks) {
      if (!createPrivateJsonIfAbsent(
        join(directory, chunk.file),
        chunk.value,
        { environment },
      ).created) {
        throw new Error("read projection revision collided with existing chunk state");
      }
    }
    if (!createPrivateJsonIfAbsent(
      join(directory, revision.manifestFile),
      revision.manifest,
      { environment },
    ).created) {
      throw new Error("read projection revision collided with existing manifest state");
    }
    return Object.freeze({
      head: revision.head,
      chunkCount,
    });
  } catch (error) {
    removeRevision(query, revision.revisionId, chunkCount, environment);
    throw error;
  }
}

function publication(
  query: ReadProjectionQuery,
  payload: Pick<
    ProjectionPayloadV1,
    "dataRevision" | "validatedAt" | "dataChangedAt"
  >,
  disposition: ReadProjectionPublication["disposition"],
  currentDataRevision?: string,
): ReadProjectionPublication {
  return Object.freeze({
    key: query.key,
    dataRevision: payload.dataRevision,
    validatedAt: payload.validatedAt,
    dataChangedAt: payload.dataChangedAt,
    disposition,
    ...(currentDataRevision === undefined ? {} : { currentDataRevision }),
  });
}

export function publishReadProjection(
  queryValue: ReadProjectionQuery,
  outputValue: unknown,
  options: {
    readonly environment?: Environment;
    readonly runId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
  },
): ReadProjectionPublication {
  const environment = options.environment ?? process.env;
  const authId = parseQueryValue(queryValue).identity.auth.id;
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const { query, key } = validateQuery(queryValue, environment);
    const output = boundedJson(outputValue, "read projection output");
    const startedAt = timestamp(options.startedAt, "read projection start time");
    const finishedAt = timestamp(options.finishedAt, "read projection finish time");
    if (startedAt > finishedAt) {
      throw new Error("read projection finished before it started");
    }
    const normalizedRunId = runId(options.runId);
    const nextRevision = dataRevision(key, output);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = loadProjection(query, key, environment);
      const nextOrder = publicationOrder({
        startedAt,
        finishedAt,
        runId: normalizedRunId,
      });
      if (current !== null && nextOrder <= publicationOrder(current.payload)) {
        return publication(
          query,
          current.payload,
          "superseded",
          current.payload.dataRevision,
        );
      }
      const unchanged = current?.payload.dataRevision === nextRevision;
      const createdAt = current === null
        ? finishedAt
        : current.payload.createdAt < finishedAt
          ? current.payload.createdAt
          : finishedAt;
      const dataChangedAt = unchanged
        ? current.payload.dataChangedAt < finishedAt
          ? current.payload.dataChangedAt
          : finishedAt
        : finishedAt;
      const payload: ProjectionPayloadV1 = Object.freeze({
        schemaVersion: 1,
        query: query.identity,
        output,
        dataRevision: nextRevision,
        createdAt,
        dataChangedAt,
        validatedAt: finishedAt,
        runId: normalizedRunId,
        startedAt,
        finishedAt,
      });
      const revision = writeRevision(query, key, payload, current, environment);
      const promoted = current === null
        ? createPrivateJsonIfAbsent(
            headPath(query, environment),
            revision.head,
            { environment },
          ).created
        : writePrivateJsonIfUnchanged(
            headPath(query, environment),
            revision.head,
            { expectedCurrentContentSha256: current.headContentSha256 },
          );
      if (!promoted) {
        removeRevision(
          query,
          revision.head.revisionId,
          revision.chunkCount,
          environment,
        );
        continue;
      }
      if (current !== null) {
        const oldCount = currentChunkCount(current, query, key, environment);
        removeRevision(query, current.head.revisionId, oldCount, environment);
      }
      return publication(
        query,
        payload,
        current === null ? "created" : unchanged ? "unchanged" : "changed",
      );
    }
    throw new Error(
      "read projection publication could not settle after concurrent updates",
    );
  });
}

function omniCurrent(
  query: OmniProjectionQuery,
  payload: ProjectionPayloadV1,
  storageRevisionId: string,
): OmniProjectionCurrent {
  return Object.freeze({
    key: query.key,
    storageRevisionId,
    output: immutableBoundedJson(
      payload.output,
      "omni projection current output",
    ),
    dataRevision: payload.dataRevision,
    createdAt: payload.createdAt,
    dataChangedAt: payload.dataChangedAt,
    validatedAt: payload.validatedAt,
    runId: payload.runId,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
  });
}

function omniPublication(
  query: OmniProjectionQuery,
  payload: ProjectionPayloadV1,
  storageRevisionId: string,
  disposition: OmniProjectionPublication["disposition"],
): OmniProjectionPublication {
  return Object.freeze({
    ...publication(query, payload, disposition),
    storageRevisionId,
    runId: payload.runId,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
  });
}

function omniMutationTime(
  now: Date,
  current: LoadedProjection | null,
): string {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("omni projection mutation time is invalid");
  }
  let milliseconds = now.getTime();
  if (current !== null) {
    milliseconds = Math.max(
      milliseconds,
      new Date(current.payload.validatedAt).getTime() + 1,
    );
  }
  try {
    return timestamp(
      new Date(milliseconds).toISOString(),
      "omni projection mutation time",
    );
  } catch (error) {
    throw new Error("omni projection mutation time cannot advance", { cause: error });
  }
}

/**
 * Serialize one pure synchronous aggregate transition under the auth admission.
 * The reducer sees an immutable JSON snapshot. A candidate revision remains
 * unreachable until its head wins the compare-and-swap publication.
 */
export function reduceOmniProjection(
  queryValue: OmniProjectionQuery,
  reducer: (currentOutput: unknown) => unknown,
  options: {
    readonly environment?: Environment;
    readonly now?: Date;
    /** Runs inside the auth admission before any reducer state is observed. */
    readonly assertCurrent?: () => void;
    /** Exact head whose bytes the reducer interpreted. */
    readonly exactHead?: ReadProjectionExactHeadFence;
  } = {},
): OmniProjectionReductionResult {
  if (typeof reducer !== "function") {
    throw new Error("omni projection reducer must be a function");
  }
  const environment = options.environment ?? process.env;
  const parsedOmniQuery = parseOmniQueryValue(queryValue);
  const authId = parsedOmniQuery.identity.auth.id;
  return withSettledReadProjectionAuthAdmission(
    authId,
    environment,
    () => {
      if (
        options.assertCurrent !== undefined
        && typeof options.assertCurrent !== "function"
      ) {
        throw new Error("omni projection current-authority guard is malformed");
      }
      options.assertCurrent?.();
      if (options.exactHead !== undefined) {
        const fence = record(options.exactHead, "omni projection exact-head fence");
        exactKeys(
          fence,
          ["query", "storageRevisionId", "dataRevision", "runId"],
          "omni projection exact-head fence",
        );
        const { query: exactQuery, key: exactKey } = validateQuery(
          fence.query as ReadProjectionQuery,
          environment,
        );
        if (
          exactQuery.identity.auth.id !== parsedOmniQuery.identity.auth.id
          || exactQuery.identity.auth.hash !== parsedOmniQuery.identity.auth.hash
        ) {
          throw new Error(
            "omni projection exact-head fence belongs to another auth lifetime",
          );
        }
        const expectedStorageRevisionId = safeString(
          fence.storageRevisionId,
          "omni projection exact storage revision ID",
          64,
        );
        if (!/^[a-f0-9]{32}$/u.test(expectedStorageRevisionId)) {
          throw new Error("omni projection exact storage revision ID is malformed");
        }
        const expectedDataRevision = hexDigest(
          fence.dataRevision,
          "omni projection exact data revision",
        );
        const expectedRunId = runId(fence.runId);
        const exact = loadProjection(exactQuery, exactKey, environment);
        if (
          exact === null
          || exact.head.revisionId !== expectedStorageRevisionId
          || exact.payload.dataRevision !== expectedDataRevision
          || exact.payload.runId !== expectedRunId
        ) {
          throw new Error(
            "exact projection changed before normalized publication admission",
          );
        }
      }
      const { query, key } = validateOmniQuery(queryValue, environment);
      const current = loadProjection(query, key, environment);
      const mutationTime = omniMutationTime(options.now ?? new Date(), current);
      const currentOutput = current === null
        ? null
        : immutableBoundedJson(
            current.payload.output,
            "omni projection reducer input",
          );
      const reduced = reducer(currentOutput);
      if (hasThenableProtocol(reduced)) {
        throw new Error(
          "omni projection reducers must be synchronous and must not return promises or thenables",
        );
      }
      const output = immutableBoundedJson(reduced, "omni projection output");
      const nextRevision = dataRevision(key, output, "omni-v1");
      if (current?.payload.dataRevision === nextRevision) {
        return Object.freeze({
          publication: omniPublication(
            query,
            current.payload,
            current.head.revisionId,
            "unchanged",
          ),
          current: omniCurrent(
            query,
            current.payload,
            current.head.revisionId,
          ),
        });
      }

      const normalizedRunId = randomUUID();
      const payload: ProjectionPayloadV1 = Object.freeze({
        schemaVersion: 1,
        query: query.identity,
        output,
        dataRevision: nextRevision,
        createdAt: current?.payload.createdAt ?? mutationTime,
        dataChangedAt: mutationTime,
        validatedAt: mutationTime,
        runId: normalizedRunId,
        startedAt: mutationTime,
        finishedAt: mutationTime,
      });
      const oldChunkCount = current === null
        ? 0
        : currentChunkCount(current, query, key, environment);
      const revision = writeRevision(query, key, payload, current, environment);
      const promoted = current === null
        ? createPrivateJsonIfAbsent(
            headPath(query, environment),
            revision.head,
            { environment },
          ).created
        : writePrivateJsonIfUnchanged(
            headPath(query, environment),
            revision.head,
            { expectedCurrentContentSha256: current.headContentSha256 },
          );
      if (!promoted) {
        removeRevision(
          query,
          revision.head.revisionId,
          revision.chunkCount,
          environment,
        );
        throw new Error(
          "omni projection publication lost its authenticated compare-and-swap",
        );
      }
      if (current !== null) {
        removeRevision(
          query,
          current.head.revisionId,
          oldChunkCount,
          environment,
        );
      }
      return Object.freeze({
        publication: omniPublication(
          query,
          payload,
          revision.head.revisionId,
          current === null ? "created" : "changed",
        ),
        current: omniCurrent(query, payload, revision.head.revisionId),
      });
    },
    { maximumWaitMs: READ_PROJECTION_TRANSITION_SETTLEMENT_WAIT_MS },
  );
}

function rawHeadSnapshot(
  query: ReadProjectionQuery,
  environment: Environment,
): { readonly contentSha256: string } | null {
  const content = readPrivateStateFileBytesIfPresent(
    headPath(query, environment),
    MAX_ATTRIBUTABLE_CORRUPT_FILE_BYTES,
    "read projection repair head",
    environment,
  );
  return content === null
    ? null
    : Object.freeze({ contentSha256: hashBytes(content) });
}

function reclaimAfterDurableRepair(
  query: ReadProjectionQuery,
  revisionId: string,
  chunkCount: number,
  environment: Environment,
): void {
  const directory = queryDirectory(query, environment);
  const directoryIdentity = ensurePrivateStateDirectory(directory, environment);
  const expected = new Set([HEAD_FILE, ...revisionFiles(revisionId, chunkCount)]);
  const entries = listPrivateStateDirectory(
    directory,
    environment,
    directoryIdentity,
    { recoverOrphanedMutationClaims: true },
  );
  if (
    entries.some((entry) =>
      stateHelperArtifactNamePatterns.some((pattern) =>
        pattern.test(entry.name)))
  ) {
    throw new Error(
      "read projection repaired durably but an in-flight state-helper artifact prevents reclamation",
    );
  }
  for (const entry of entries) {
    if (expected.has(entry.name)) continue;
    if (entry.kind === "file") {
      removePrivateStateFile(join(directory, entry.name), environment);
      continue;
    }
    if (entry.kind === "directory" && entry.identity !== undefined) {
      removePrivateStateDirectoryTree(
        join(directory, entry.name),
        environment,
        entry.identity,
        directoryIdentity,
      );
      continue;
    }
    throw new Error(
      "read projection repaired durably but inert corrupt state could not be reclaimed",
    );
  }
  const settled = listPrivateStateDirectory(
    directory,
    environment,
    directoryIdentity,
    { recoverOrphanedMutationClaims: true },
  );
  if (
    settled.length !== expected.size
    || settled.some((entry) =>
      entry.kind !== "file" || !expected.has(entry.name))
  ) {
    throw new Error(
      "read projection repaired durably but old revision reclamation did not settle",
    );
  }
}

/**
 * Replace a corrupt exact-query head only after a complete new immutable
 * revision is durable. If the cache recovered or changed meanwhile, ordinary
 * publication ordering remains authoritative.
 */
export function repairReadProjection(
  queryValue: ReadProjectionQuery,
  outputValue: unknown,
  options: {
    readonly environment?: Environment;
    readonly runId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly corruption: ReadProjectionCorruptionError;
    readonly observedBeforeLive: boolean;
  },
): ReadProjectionPublication {
  const environment = options.environment ?? process.env;
  const authId = parseQueryValue(queryValue).identity.auth.id;
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const { query, key } = validateQuery(queryValue, environment);
    const output = boundedJson(outputValue, "read projection output");
    const startedAt = timestamp(options.startedAt, "read projection start time");
    const finishedAt = timestamp(options.finishedAt, "read projection finish time");
    if (startedAt > finishedAt) {
      throw new Error("read projection finished before it started");
    }
    const normalizedRunId = runId(options.runId);
    if (typeof options.observedBeforeLive !== "boolean") {
      throw new Error("read projection repair observation timing is malformed");
    }
    const observed = corruptionEvidence.get(options.corruption);
    if (
      observed === undefined
      || observed.storageClass !== "exact-v1"
      || observed.queryKey !== query.key
      || observed.realmKey !== query.realmKey
    ) {
      throw new Error(
        "read projection repair requires exact observed corruption evidence",
      );
    }
    const nextOrder = publicationOrder({
      startedAt,
      finishedAt,
      runId: normalizedRunId,
    });
    const nextRevision = dataRevision(key, output);

    const publishAgainstCurrentState = (): ReadProjectionPublication => {
      try {
        return publishReadProjection(query, output, {
          environment,
          runId: normalizedRunId,
          startedAt,
          finishedAt,
        });
      } catch (error) {
        if (!isReadProjectionCorruptionError(error)) throw error;
        throw new Error(
          "read projection corrupt head changed after the repair observation",
          { cause: error },
        );
      }
    };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const currentRaw = rawHeadSnapshot(query, environment);
      if (
        currentRaw === null
        || currentRaw.contentSha256 !== observed.headContentSha256
      ) {
        return publishAgainstCurrentState();
      }

      try {
        const recovered = loadProjection(query, key, environment);
        if (recovered === null) continue;
        return publishAgainstCurrentState();
      } catch (error) {
        if (!isReadProjectionCorruptionError(error)) throw error;
        if (error.headContentSha256 !== observed.headContentSha256) continue;
      }

      if (observed.headPublication === null && !options.observedBeforeLive) {
        throw new Error(
          "unorderable read projection corruption was not observed before the live read",
        );
      }
      if (
        observed.headPublication !== null
        && nextOrder <= publicationOrder(observed.headPublication)
      ) {
        return publication(
          query,
          observed.headPublication,
          "superseded",
          observed.headPublication.dataRevision,
        );
      }
      const unchanged = observed.headPublication?.dataRevision === nextRevision;
      const createdAt = observed.headPublication === null
        ? finishedAt
        : observed.headPublication.createdAt < finishedAt
          ? observed.headPublication.createdAt
          : finishedAt;
      const dataChangedAt = unchanged && observed.headPublication !== null
        ? observed.headPublication.dataChangedAt < finishedAt
          ? observed.headPublication.dataChangedAt
          : finishedAt
        : finishedAt;
      const payload: ProjectionPayloadV1 = Object.freeze({
        schemaVersion: 1,
        query: query.identity,
        output,
        dataRevision: nextRevision,
        createdAt,
        dataChangedAt,
        validatedAt: finishedAt,
        runId: normalizedRunId,
        startedAt,
        finishedAt,
      });
      const revision = writeRevision(
        query,
        key,
        payload,
        null,
        environment,
        "preserve-for-repair",
      );
      const promoted = writePrivateJsonIfUnchanged(
        headPath(query, environment),
        revision.head,
        {
          expectedCurrentContentSha256: observed.headContentSha256,
          maximumExpectedCurrentBytes: MAX_ATTRIBUTABLE_CORRUPT_FILE_BYTES,
        },
      );
      if (!promoted) {
        removeRevision(
          query,
          revision.head.revisionId,
          revision.chunkCount,
          environment,
        );
        continue;
      }
      const published = publication(
        query,
        payload,
        observed.headPublication === null
          ? "changed"
          : unchanged
            ? "unchanged"
            : "changed",
      );
      try {
        reclaimAfterDurableRepair(
          query,
          revision.head.revisionId,
          revision.chunkCount,
          environment,
        );
      } catch (error) {
        throw new ReadProjectionDurableRepairError(
          query.key,
          published,
          error,
        );
      }
      return published;
    }
    throw new Error(
      "read projection repair could not settle after concurrent updates",
    );
  });
}

export function removeReadProjectionsForAuth(
  authIdValue: string,
  environment: Environment = process.env,
): boolean {
  return withReadProjectionAuthAdmission(authIdValue, environment, () => {
    const key = projectionKey(environment, false);
    if (key === null) return false;
    const exactRealmKey = hmac(
      key.value,
      "wrench-read-projection-realm-v1",
      authIdValue,
    );
    const omniRealmKey = hmac(
      key.value,
      "wrench-omni-projection-realm-v1",
      authIdValue,
    );
    let removed = false;
    const failures: unknown[] = [];
    for (const [storageClass, realmKey] of [
      ["exact-v1", exactRealmKey],
      ["omni-v1", omniRealmKey],
    ] as const) {
      try {
        removed = removePrivateStateDirectoryTree(
          realmDirectory(realmKey, environment, storageClass),
          environment,
        ) || removed;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "read projection auth cleanup failed for exact and omni stores",
      );
    }
    return removed;
  });
}

/** Remove only one exact query revision tree, never sibling queries or a replacement realm. */
export function removeReadProjection(
  queryValue: ReadProjectionQuery,
  environment: Environment = process.env,
): boolean {
  const authId = parseQueryValue(queryValue).identity.auth.id;
  return withReadProjectionAuthAdmission(authId, environment, () => {
    const { query } = validateQuery(queryValue, environment);
    return removePrivateStateDirectoryTree(
      queryDirectory(query, environment),
      environment,
    );
  });
}
