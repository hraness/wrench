import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { WrenchAuth } from "./auth";
import {
  canonicalJson,
  sha256,
  type OperationInput,
  type OperationRisk,
} from "./model";
import {
  isProviderPluginOperationName,
  isProviderPluginSurfaceId,
  type ProviderPluginOperationName,
  type ProviderPluginSurfaceId,
} from "./provider-plugin-identifiers";
import {
  parsePortableOperationIdentityV1,
  type PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  listPrivateStateDirectory,
  readPrivateStateFileIfPresent,
  readRegularFile,
  removePrivateStateDirectoryTree,
  removePrivateStateFile,
  wrenchStateHome,
  snapshotPrivateStateDirectory,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

const RECOVERY_DIRECTORY = "recovery";
const CAPSULE_DIRECTORY = "capsules";
const PROVIDER_ACCEPTED_TARGET_DIRECTORY = "provider-accepted-targets";
const OBSERVATION_DIRECTORY = "observations";
const RECOVERY_KEY = ".recovery-encryption-key";
const MAX_KEY_BYTES = 128;
const MAX_CAPSULE_PLAINTEXT_BYTES = 1536 * 1024;
const MAX_CAPSULE_ENCRYPTED_BYTES = 3 * 1024 * 1024;
const MAX_PROVIDER_ACCEPTED_TARGET_PLAINTEXT_BYTES = 32 * 1024;
const MAX_PROVIDER_ACCEPTED_TARGET_ENCRYPTED_BYTES = 64 * 1024;
const MAX_PROVIDER_ACCEPTED_TARGET_BYTES = 8 * 1024;
const MAX_OBSERVATION_BYTES = 64 * 1024;
const PORTABLE_RECOVERY_CONTRACT_HASH_DOMAIN =
  "io-recovery-portable-contract-v1\0";

export type RecoveryContractIdentity =
  | {
      readonly transport: "provider-api";
      readonly provider: ProviderPluginSurfaceId;
      readonly action: ProviderPluginOperationName;
      readonly version: number;
      readonly hash: string;
    }
  | {
      readonly transport: "web-session-api";
      readonly site: ProviderPluginSurfaceId;
      readonly action: ProviderPluginOperationName;
      readonly version: number;
      readonly hash: string;
    }
  | {
      readonly transport: "reviewed-template-api";
      readonly version: 1;
      readonly hash: string;
    }
  | {
      readonly transport: "portable-provider-plugin";
      readonly identity: PortableOperationIdentityV1;
    };

export type RecoveryCapsule = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly planDigest: string;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly operation: string;
  readonly risk: Extract<OperationRisk, "R2" | "R3">;
  readonly input: OperationInput;
  readonly inputHash: string;
  readonly auth: {
    readonly id: string;
    readonly hash: string;
    readonly kind: WrenchAuth["kind"];
  };
  readonly contract: RecoveryContractIdentity;
};

export type RecoveryCapsuleListEntry =
  | {
      readonly capsule: RecoveryCapsule;
    }
  | {
      readonly runId: string;
      readonly invalid: true;
    };

export type ProviderAcceptedMutationTarget = {
  readonly schemaVersion: 1;
  /** Provider-owned stable identifier obtained from the accepted mutation response. */
  readonly identifier: string;
};

export type ProviderAcceptedMutationTargetDispatch = {
  readonly id: string;
  readonly index: number;
  readonly planned: number;
};

/**
 * Private evidence that one exact web-session dispatch received a strict
 * provider acceptance response. `target` is encrypted at rest and must never
 * be copied into receipts, journals, observations, or diagnostics.
 */
export type ProviderAcceptedMutationTargetEvidence = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly acceptedAt: string;
  readonly planDigest: string;
  readonly adapter: RecoveryCapsule["adapter"];
  readonly operation: string;
  readonly inputHash: string;
  readonly auth: RecoveryCapsule["auth"];
  readonly contract: Extract<
    RecoveryContractIdentity,
    { readonly transport: "web-session-api" }
  >;
  readonly dispatch: ProviderAcceptedMutationTargetDispatch;
  readonly target: ProviderAcceptedMutationTarget;
};

type EncryptedProviderAcceptedMutationTargetEvidence = {
  readonly schemaVersion: 1;
  readonly encryption: "aes-256-gcm";
  readonly runId: string;
  readonly adapterHash: string;
  readonly authHash: string;
  readonly contractHash: string;
  readonly inputHash: string;
  readonly dispatchId: string;
  readonly dispatchIndex: number;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

type EncryptedRecoveryCapsule = {
  readonly schemaVersion: 1;
  readonly encryption: "aes-256-gcm";
  readonly runId: string;
  readonly authId: string;
  readonly authHash: string;
  readonly contractHash: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

export type ReconciliationOutcome =
  | "desired-state-observed"
  | "desired-state-not-observed"
  | "inconclusive";

export type ReconciliationObservation = {
  readonly schemaVersion: 1;
  readonly observationId: string;
  readonly runId: string;
  readonly observedAt: string;
  readonly receiptHash: string;
  readonly adapterHash: string;
  readonly operation: string;
  readonly inputHash: string;
  readonly authHash: string;
  readonly contractHash: string;
  readonly inputSource: "capsule" | "provided";
  readonly outcome: ReconciliationOutcome;
  readonly desiredStateMatched: boolean | null;
  readonly actualState: boolean | null;
  readonly reason: "exact-readback" | "readback-failed";
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
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
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
}

function assertRunId(value: unknown, label = "recovery run ID"): asserts value is string {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) throw new Error(`${label} is malformed`);
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,47}$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} is malformed`);
}

function assertOperation(value: unknown, label: string): asserts value is string {
  if (!isProviderPluginOperationName(value)) {
    throw new Error(`${label} is malformed`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length > 64
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is malformed`);
  }
}

function assertAuthKind(value: unknown): asserts value is WrenchAuth["kind"] {
  if (
    value !== "cookie-source"
    && value !== "cookies-file"
    && value !== "browser-profile"
    && value !== "oauth-token-file"
    && value !== "linked-device-store"
  ) throw new Error("recovery capsule auth kind is malformed");
}

function parseContract(value: unknown): RecoveryContractIdentity {
  const record = dataRecord(value, "recovery capsule contract");
  if (record.transport === "portable-provider-plugin") {
    exactKeys(
      record,
      ["transport", "identity"],
      "recovery capsule contract",
    );
    return Object.freeze({
      transport: "portable-provider-plugin",
      identity: parsePortableOperationIdentityV1(record.identity),
    });
  }
  if (record.transport === "provider-api") {
    exactKeys(record, ["transport", "provider", "action", "version", "hash"], "recovery capsule contract");
    if (!isProviderPluginSurfaceId(record.provider)) {
      throw new Error("recovery capsule provider is malformed");
    }
    assertOperation(record.action, "recovery capsule provider action");
    if (!Number.isSafeInteger(record.version) || (record.version as number) < 1 || (record.version as number) > 1_000_000) {
      throw new Error("recovery capsule provider version is malformed");
    }
    assertHash(record.hash, "recovery capsule provider contract hash");
    return Object.freeze({
      transport: "provider-api",
      provider: record.provider,
      action: record.action,
      version: record.version as number,
      hash: record.hash,
    });
  }
  if (record.transport === "web-session-api") {
    exactKeys(record, ["transport", "site", "action", "version", "hash"], "recovery capsule contract");
    if (!isProviderPluginSurfaceId(record.site)) {
      throw new Error("recovery capsule site is malformed");
    }
    assertOperation(record.action, "recovery capsule web-session action");
    if (!Number.isSafeInteger(record.version) || (record.version as number) < 1 || (record.version as number) > 1_000_000) {
      throw new Error("recovery capsule web-session version is malformed");
    }
    assertHash(record.hash, "recovery capsule web-session contract hash");
    return Object.freeze({
      transport: "web-session-api",
      site: record.site,
      action: record.action,
      version: record.version as number,
      hash: record.hash,
    });
  }
  if (record.transport === "reviewed-template-api") {
    exactKeys(record, ["transport", "version", "hash"], "recovery capsule contract");
    if (record.version !== 1) throw new Error("recovery capsule reviewed-template version is malformed");
    assertHash(record.hash, "recovery capsule reviewed-template contract hash");
    return Object.freeze({
      transport: "reviewed-template-api",
      version: 1,
      hash: record.hash,
    });
  }
  throw new Error("recovery capsule transport is unsupported");
}

export function recoveryContractHash(
  contractValue: RecoveryContractIdentity,
): string {
  const contract = parseContract(contractValue);
  return contract.transport === "portable-provider-plugin"
    ? sha256(
        `${PORTABLE_RECOVERY_CONTRACT_HASH_DOMAIN}${canonicalJson(contract)}`,
      )
    : contract.hash;
}

function parseCapsule(value: unknown): RecoveryCapsule {
  if (!isRecord(value)) throw new Error("recovery capsule must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "runId",
      "createdAt",
      "planDigest",
      "adapter",
      "operation",
      "risk",
      "input",
      "inputHash",
      "auth",
      "contract",
    ],
    "recovery capsule",
  );
  if (value.schemaVersion !== 1) throw new Error("recovery capsule schema is unsupported");
  assertRunId(value.runId);
  assertTimestamp(value.createdAt, "recovery capsule creation time");
  assertHash(value.planDigest, "recovery capsule plan digest");
  assertOperation(value.operation, "recovery capsule operation");
  if (value.risk !== "R2" && value.risk !== "R3") {
    throw new Error("recovery capsule risk is not a recoverable write");
  }
  if (!isRecord(value.input)) throw new Error("recovery capsule input must be an object");
  assertHash(value.inputHash, "recovery capsule input hash");
  if (sha256(canonicalJson(value.input)) !== value.inputHash) {
    throw new Error("recovery capsule input no longer matches its canonical hash");
  }
  if (!isRecord(value.adapter)) throw new Error("recovery capsule adapter must be an object");
  exactKeys(value.adapter, ["id", "version", "hash"], "recovery capsule adapter");
  assertId(value.adapter.id, "recovery capsule adapter ID");
  assertBoundedString(value.adapter.version, "recovery capsule adapter version", 64);
  assertHash(value.adapter.hash, "recovery capsule adapter hash");
  if (!isRecord(value.auth)) throw new Error("recovery capsule auth must be an object");
  exactKeys(value.auth, ["id", "hash", "kind"], "recovery capsule auth");
  assertId(value.auth.id, "recovery capsule auth ID");
  assertHash(value.auth.hash, "recovery capsule auth hash");
  assertAuthKind(value.auth.kind);
  return {
    schemaVersion: 1,
    runId: value.runId,
    createdAt: value.createdAt,
    planDigest: value.planDigest,
    adapter: {
      id: value.adapter.id,
      version: value.adapter.version,
      hash: value.adapter.hash,
    },
    operation: value.operation,
    risk: value.risk,
    input: value.input as OperationInput,
    inputHash: value.inputHash,
    auth: {
      id: value.auth.id,
      hash: value.auth.hash,
      kind: value.auth.kind,
    },
    contract: parseContract(value.contract),
  };
}

function providerAcceptedTargetHasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function parseProviderAcceptedMutationTarget(
  value: unknown,
): ProviderAcceptedMutationTarget {
  const record = dataRecord(value, "provider-accepted mutation target");
  exactKeys(
    record,
    ["schemaVersion", "identifier"],
    "provider-accepted mutation target",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("provider-accepted mutation target schema is unsupported");
  }
  if (
    typeof record.identifier !== "string"
    || record.identifier.length < 1
    || Buffer.byteLength(record.identifier, "utf8")
      > MAX_PROVIDER_ACCEPTED_TARGET_BYTES
    || providerAcceptedTargetHasUnpairedSurrogate(record.identifier)
    || [...record.identifier].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined
        || codePoint === 0
        || codePoint === 0x7f
        || codePoint < 0x20;
    })
  ) {
    throw new Error("provider-accepted mutation target identifier is malformed");
  }
  return Object.freeze({
    schemaVersion: 1,
    identifier: record.identifier,
  });
}

function parseProviderAcceptedMutationTargetDispatch(
  value: unknown,
): ProviderAcceptedMutationTargetDispatch {
  const record = dataRecord(
    value,
    "provider-accepted mutation target dispatch",
  );
  exactKeys(
    record,
    ["id", "index", "planned"],
    "provider-accepted mutation target dispatch",
  );
  if (
    typeof record.id !== "string"
    || record.id.length > 256
    || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*(?:\[[1-9][0-9]*\])?$/u
      .test(record.id)
  ) {
    throw new Error("provider-accepted mutation target dispatch ID is malformed");
  }
  if (
    !Number.isSafeInteger(record.index)
    || !Number.isSafeInteger(record.planned)
    || (record.index as number) < 1
    || (record.planned as number) < 1
    || (record.planned as number) > 25
    || (record.index as number) > (record.planned as number)
  ) {
    throw new Error("provider-accepted mutation target dispatch position is malformed");
  }
  return Object.freeze({
    id: record.id,
    index: record.index as number,
    planned: record.planned as number,
  });
}

export function parseProviderAcceptedMutationTargetEvidence(
  value: unknown,
): ProviderAcceptedMutationTargetEvidence {
  const record = dataRecord(
    value,
    "provider-accepted mutation target evidence",
  );
  exactKeys(
    record,
    [
      "schemaVersion",
      "runId",
      "acceptedAt",
      "planDigest",
      "adapter",
      "operation",
      "inputHash",
      "auth",
      "contract",
      "dispatch",
      "target",
    ],
    "provider-accepted mutation target evidence",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("provider-accepted mutation target evidence schema is unsupported");
  }
  assertRunId(record.runId, "provider-accepted mutation target run ID");
  assertTimestamp(
    record.acceptedAt,
    "provider-accepted mutation target acceptance time",
  );
  assertHash(record.planDigest, "provider-accepted mutation target plan digest");
  assertOperation(record.operation, "provider-accepted mutation target operation");
  assertHash(record.inputHash, "provider-accepted mutation target input hash");

  const adapter = dataRecord(
    record.adapter,
    "provider-accepted mutation target adapter",
  );
  exactKeys(
    adapter,
    ["id", "version", "hash"],
    "provider-accepted mutation target adapter",
  );
  assertId(adapter.id, "provider-accepted mutation target adapter ID");
  assertBoundedString(
    adapter.version,
    "provider-accepted mutation target adapter version",
    64,
  );
  assertHash(adapter.hash, "provider-accepted mutation target adapter hash");

  const auth = dataRecord(
    record.auth,
    "provider-accepted mutation target auth",
  );
  exactKeys(
    auth,
    ["id", "hash", "kind"],
    "provider-accepted mutation target auth",
  );
  assertId(auth.id, "provider-accepted mutation target auth ID");
  assertHash(auth.hash, "provider-accepted mutation target auth hash");
  assertAuthKind(auth.kind);

  const contract = parseContract(record.contract);
  if (contract.transport !== "web-session-api") {
    throw new Error(
      "provider-accepted mutation target requires a web-session contract",
    );
  }
  if (contract.action !== record.operation) {
    throw new Error(
      "provider-accepted mutation target operation does not match its contract",
    );
  }
  const evidence: ProviderAcceptedMutationTargetEvidence = Object.freeze({
    schemaVersion: 1,
    runId: record.runId,
    acceptedAt: record.acceptedAt,
    planDigest: record.planDigest,
    adapter: Object.freeze({
      id: adapter.id,
      version: adapter.version,
      hash: adapter.hash,
    }),
    operation: record.operation,
    inputHash: record.inputHash,
    auth: Object.freeze({
      id: auth.id,
      hash: auth.hash,
      kind: auth.kind,
    }),
    contract,
    dispatch: parseProviderAcceptedMutationTargetDispatch(record.dispatch),
    target: parseProviderAcceptedMutationTarget(record.target),
  });
  canonicalJson(evidence);
  return evidence;
}

function recoveryRoot(environment: Environment): string {
  return join(wrenchStateHome(environment), RECOVERY_DIRECTORY);
}

function capsuleDirectory(environment: Environment): string {
  return join(recoveryRoot(environment), CAPSULE_DIRECTORY);
}

function providerAcceptedTargetDirectory(environment: Environment): string {
  return join(recoveryRoot(environment), PROVIDER_ACCEPTED_TARGET_DIRECTORY);
}

function providerAcceptedTargetRunDirectory(
  runId: string,
  environment: Environment,
): string {
  assertRunId(runId, "provider-accepted mutation target run ID");
  return join(providerAcceptedTargetDirectory(environment), runId);
}

function providerAcceptedTargetPath(
  runId: string,
  dispatchIndex: number,
  environment: Environment,
): string {
  if (
    !Number.isSafeInteger(dispatchIndex)
    || dispatchIndex < 1
    || dispatchIndex > 25
  ) {
    throw new Error(
      "provider-accepted mutation target dispatch index is malformed",
    );
  }
  return join(
    providerAcceptedTargetRunDirectory(runId, environment),
    `${dispatchIndex}.json`,
  );
}

function capsulePath(runId: string, environment: Environment): string {
  assertRunId(runId);
  return join(capsuleDirectory(environment), `${runId}.json`);
}

function observationRunDirectory(runId: string, environment: Environment): string {
  assertRunId(runId);
  return join(recoveryRoot(environment), OBSERVATION_DIRECTORY, runId);
}

function keyPath(environment: Environment): string {
  return join(wrenchStateHome(environment), RECOVERY_KEY);
}

function parseRecoveryKey(text: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()) as unknown;
  } catch {
    throw new Error("recovery encryption key is malformed");
  }
  if (!isRecord(parsed)) throw new Error("recovery encryption key is malformed");
  exactKeys(parsed, ["schemaVersion", "key"], "recovery encryption key");
  if (
    parsed.schemaVersion !== 1
    || typeof parsed.key !== "string"
    || !/^[a-f0-9]{64}$/u.test(parsed.key)
  ) throw new Error("recovery encryption key is malformed");
  return Buffer.from(parsed.key, "hex");
}

function createRecoveryKey(environment: Environment): Buffer {
  const path = keyPath(environment);
  if (
    !existsSync(path)
    && (
      listPrivateStateDirectory(capsuleDirectory(environment), environment).length > 0
      || listPrivateStateDirectory(
        providerAcceptedTargetDirectory(environment),
        environment,
      ).length > 0
    )
  ) {
    throw new Error(
      "recovery encryption key is missing while encrypted recovery evidence still exists; refusing to replace it",
    );
  }
  createPrivateJsonIfAbsent(path, {
    schemaVersion: 1,
    key: randomBytes(32).toString("hex"),
  }, { environment, privateParent: true });
  return parseRecoveryKey(readRegularFile(path, MAX_KEY_BYTES, "recovery encryption key"));
}

function readRecoveryKey(environment: Environment): Buffer {
  return parseRecoveryKey(readRegularFile(
    keyPath(environment),
    MAX_KEY_BYTES,
    "recovery encryption key",
  ));
}

function capsuleAdditionalData(
  runId: string,
  authId: string,
  authHash: string,
  contractHash: string,
): Buffer {
  return Buffer.from(
    `io-recovery-capsule-v1\0${runId}\0${authId}\0${authHash}\0${contractHash}`,
    "utf8",
  );
}

function providerAcceptedTargetAdditionalData(
  evidence: Pick<
    ProviderAcceptedMutationTargetEvidence,
    "runId" | "planDigest" | "inputHash" | "operation"
  > & {
    readonly adapterHash: string;
    readonly authHash: string;
    readonly contractHash: string;
    readonly dispatchId: string;
    readonly dispatchIndex: number;
    readonly dispatchPlanned: number;
  },
): Buffer {
  return Buffer.from(
    [
      "io-provider-accepted-mutation-target-v1",
      evidence.runId,
      evidence.planDigest,
      evidence.adapterHash,
      evidence.operation,
      evidence.inputHash,
      evidence.authHash,
      evidence.contractHash,
      evidence.dispatchId,
      String(evidence.dispatchIndex),
      String(evidence.dispatchPlanned),
    ].join("\0"),
    "utf8",
  );
}

function boundedBase64(value: unknown, label: string, maximumBytes: number): Buffer {
  if (
    typeof value !== "string"
    || value.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) throw new Error(`${label} is malformed`);
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength > maximumBytes
    || bytes.toString("base64") !== value
  ) throw new Error(`${label} is malformed`);
  return bytes;
}

function parseEncryptedCapsule(value: unknown): EncryptedRecoveryCapsule {
  if (!isRecord(value)) throw new Error("encrypted recovery capsule must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "encryption",
      "runId",
      "authId",
      "authHash",
      "contractHash",
      "iv",
      "ciphertext",
      "tag",
    ],
    "encrypted recovery capsule",
  );
  if (value.schemaVersion !== 1 || value.encryption !== "aes-256-gcm") {
    throw new Error("encrypted recovery capsule schema is unsupported");
  }
  assertRunId(value.runId);
  assertId(value.authId, "encrypted recovery capsule auth ID");
  assertHash(value.authHash, "encrypted recovery capsule auth hash");
  assertHash(value.contractHash, "encrypted recovery capsule contract hash");
  boundedBase64(value.iv, "recovery capsule IV", 12);
  boundedBase64(value.ciphertext, "recovery capsule ciphertext", MAX_CAPSULE_PLAINTEXT_BYTES + 16);
  boundedBase64(value.tag, "recovery capsule authentication tag", 16);
  return value as EncryptedRecoveryCapsule;
}

function parseEncryptedProviderAcceptedMutationTargetEvidence(
  value: unknown,
): EncryptedProviderAcceptedMutationTargetEvidence {
  const record = dataRecord(
    value,
    "encrypted provider-accepted mutation target evidence",
  );
  exactKeys(
    record,
    [
      "schemaVersion",
      "encryption",
      "runId",
      "adapterHash",
      "authHash",
      "contractHash",
      "inputHash",
      "dispatchId",
      "dispatchIndex",
      "iv",
      "ciphertext",
      "tag",
    ],
    "encrypted provider-accepted mutation target evidence",
  );
  if (record.schemaVersion !== 1 || record.encryption !== "aes-256-gcm") {
    throw new Error(
      "encrypted provider-accepted mutation target evidence schema is unsupported",
    );
  }
  assertRunId(record.runId, "encrypted provider-accepted mutation target run ID");
  assertHash(
    record.adapterHash,
    "encrypted provider-accepted mutation target adapter hash",
  );
  assertHash(
    record.authHash,
    "encrypted provider-accepted mutation target auth hash",
  );
  assertHash(
    record.contractHash,
    "encrypted provider-accepted mutation target contract hash",
  );
  assertHash(
    record.inputHash,
    "encrypted provider-accepted mutation target input hash",
  );
  if (
    typeof record.dispatchId !== "string"
    || record.dispatchId.length > 256
    || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*(?:\[[1-9][0-9]*\])?$/u
      .test(record.dispatchId)
    || !Number.isSafeInteger(record.dispatchIndex)
    || (record.dispatchIndex as number) < 1
    || (record.dispatchIndex as number) > 25
  ) {
    throw new Error(
      "encrypted provider-accepted mutation target dispatch is malformed",
    );
  }
  boundedBase64(record.iv, "provider-accepted mutation target IV", 12);
  boundedBase64(
    record.ciphertext,
    "provider-accepted mutation target ciphertext",
    MAX_PROVIDER_ACCEPTED_TARGET_PLAINTEXT_BYTES + 16,
  );
  boundedBase64(
    record.tag,
    "provider-accepted mutation target authentication tag",
    16,
  );
  return Object.freeze({
    schemaVersion: 1,
    encryption: "aes-256-gcm",
    runId: record.runId,
    adapterHash: record.adapterHash,
    authHash: record.authHash,
    contractHash: record.contractHash,
    inputHash: record.inputHash,
    dispatchId: record.dispatchId,
    dispatchIndex: record.dispatchIndex as number,
    iv: record.iv as string,
    ciphertext: record.ciphertext as string,
    tag: record.tag as string,
  });
}

function decryptCapsule(
  encrypted: EncryptedRecoveryCapsule,
  environment: Environment,
): RecoveryCapsule {
  const iv = boundedBase64(encrypted.iv, "recovery capsule IV", 12);
  const ciphertext = boundedBase64(
    encrypted.ciphertext,
    "recovery capsule ciphertext",
    MAX_CAPSULE_PLAINTEXT_BYTES + 16,
  );
  const tag = boundedBase64(encrypted.tag, "recovery capsule authentication tag", 16);
  if (iv.byteLength !== 12 || tag.byteLength !== 16) {
    throw new Error("encrypted recovery capsule has invalid cryptographic parameters");
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", readRecoveryKey(environment), iv);
    decipher.setAAD(capsuleAdditionalData(
      encrypted.runId,
      encrypted.authId,
      encrypted.authHash,
      encrypted.contractHash,
    ));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new Error("encrypted recovery capsule failed authentication", { cause: error });
  }
  if (plaintext.byteLength > MAX_CAPSULE_PLAINTEXT_BYTES) {
    throw new Error("decrypted recovery capsule exceeded its byte bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    throw new Error("decrypted recovery capsule is malformed");
  }
  const capsule = parseCapsule(parsed);
  const contractHash = recoveryContractHash(capsule.contract);
  if (
    capsule.runId !== encrypted.runId
    || capsule.auth.id !== encrypted.authId
    || capsule.auth.hash !== encrypted.authHash
    || contractHash !== encrypted.contractHash
  ) throw new Error("encrypted recovery capsule coordinates do not match its plaintext");
  return capsule;
}

export function writeRecoveryCapsule(
  capsuleValue: RecoveryCapsule,
  environment: Environment = process.env,
): void {
  const capsule = parseCapsule(capsuleValue);
  const plaintext = Buffer.from(canonicalJson(capsule), "utf8");
  if (plaintext.byteLength > MAX_CAPSULE_PLAINTEXT_BYTES) {
    throw new Error("recovery capsule exceeded its plaintext byte bound");
  }
  ensurePrivateStateDirectory(capsuleDirectory(environment), environment);
  const contractHash = recoveryContractHash(capsule.contract);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createRecoveryKey(environment), iv);
  cipher.setAAD(capsuleAdditionalData(
    capsule.runId,
    capsule.auth.id,
    capsule.auth.hash,
    contractHash,
  ));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encrypted: EncryptedRecoveryCapsule = {
    schemaVersion: 1,
    encryption: "aes-256-gcm",
    runId: capsule.runId,
    authId: capsule.auth.id,
    authHash: capsule.auth.hash,
    contractHash,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  const path = capsulePath(capsule.runId, environment);
  const created = createPrivateJsonIfAbsent(path, encrypted, {
    environment,
    privateParent: true,
  });
  if (created.created) return;
  const existing = readRecoveryCapsule(
    capsule.runId,
    capsule.auth.id,
    capsule.auth.hash,
    environment,
  );
  if (existing === null || canonicalJson(existing) !== canonicalJson(capsule)) {
    throw new Error("an existing recovery capsule does not match this run");
  }
}

export function readRecoveryCapsule(
  runId: string,
  authId: string,
  authHash: string,
  environment: Environment = process.env,
): RecoveryCapsule | null {
  assertRunId(runId);
  assertId(authId, "recovery capsule auth ID");
  assertHash(authHash, "recovery capsule auth hash");
  ensurePrivateStateDirectory(capsuleDirectory(environment), environment);
  const text = readPrivateStateFileIfPresent(
    capsulePath(runId, environment),
    MAX_CAPSULE_ENCRYPTED_BYTES,
    "encrypted recovery capsule",
    environment,
  );
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("encrypted recovery capsule is malformed");
  }
  const encrypted = parseEncryptedCapsule(parsed);
  if (
    encrypted.runId !== runId
    || encrypted.authId !== authId
    || encrypted.authHash !== authHash
  ) throw new Error("encrypted recovery capsule is bound to different run or auth coordinates");
  return decryptCapsule(encrypted, environment);
}

/**
 * Enumerate encrypted recovery capsules without trusting filenames, headers,
 * or plaintext coordinates. Invalid or concurrently changed entries remain
 * visible so lifecycle decisions can fail closed instead of silently skipping
 * unknown recovery ownership.
 */
export function listRecoveryCapsuleSnapshots(
  environment: Environment = process.env,
): readonly RecoveryCapsuleListEntry[] {
  const directory = capsuleDirectory(environment);
  const snapshot = snapshotPrivateStateDirectory(directory, environment);
  const directoryIdentity = snapshot.identity;
  if (directoryIdentity === null) return Object.freeze([]);
  const candidates = snapshot.entries.filter((entry) =>
    /^[0-9a-f-]{36}\.json$/u.test(entry.name)
  );
  return Object.freeze(candidates.map((entry): RecoveryCapsuleListEntry => {
    const runId = entry.name.slice(0, -5);
    if (entry.kind !== "file") return { runId, invalid: true };
    try {
      const content = readRegularFile(
        join(directory, entry.name),
        MAX_CAPSULE_ENCRYPTED_BYTES,
        "encrypted recovery capsule",
        directoryIdentity,
      );
      const encrypted = parseEncryptedCapsule(
        JSON.parse(content) as unknown,
      );
      if (encrypted.runId !== runId) return { runId, invalid: true };
      const capsule = decryptCapsule(encrypted, environment);
      return { capsule };
    } catch {
      return { runId, invalid: true };
    }
  }));
}

export function removeRecoveryCapsule(
  runId: string,
  environment: Environment = process.env,
): boolean {
  return removePrivateStateFile(capsulePath(runId, environment), environment);
}

type ProviderAcceptedMutationTargetBinding = Omit<
  ProviderAcceptedMutationTargetEvidence,
  "schemaVersion" | "acceptedAt" | "target"
>;

function providerAcceptedMutationTargetBinding(
  evidence: ProviderAcceptedMutationTargetEvidence,
): ProviderAcceptedMutationTargetBinding {
  return {
    runId: evidence.runId,
    planDigest: evidence.planDigest,
    adapter: evidence.adapter,
    operation: evidence.operation,
    inputHash: evidence.inputHash,
    auth: evidence.auth,
    contract: evidence.contract,
    dispatch: evidence.dispatch,
  };
}

function providerAcceptedMutationTargetBindingFromCapsule(
  capsuleValue: unknown,
  dispatchValue: unknown,
): ProviderAcceptedMutationTargetBinding {
  const capsule = parseCapsule(capsuleValue);
  if (capsule.contract.transport !== "web-session-api") {
    throw new Error(
      "provider-accepted mutation target requires a web-session recovery capsule",
    );
  }
  return {
    runId: capsule.runId,
    planDigest: capsule.planDigest,
    adapter: capsule.adapter,
    operation: capsule.operation,
    inputHash: capsule.inputHash,
    auth: capsule.auth,
    contract: capsule.contract,
    dispatch: parseProviderAcceptedMutationTargetDispatch(dispatchValue),
  };
}

function decryptProviderAcceptedMutationTargetEvidence(
  encrypted: EncryptedProviderAcceptedMutationTargetEvidence,
  expected: ProviderAcceptedMutationTargetBinding,
  environment: Environment,
): ProviderAcceptedMutationTargetEvidence {
  const contractHash = recoveryContractHash(expected.contract);
  if (
    encrypted.runId !== expected.runId
    || encrypted.adapterHash !== expected.adapter.hash
    || encrypted.authHash !== expected.auth.hash
    || encrypted.contractHash !== contractHash
    || encrypted.inputHash !== expected.inputHash
    || encrypted.dispatchId !== expected.dispatch.id
    || encrypted.dispatchIndex !== expected.dispatch.index
  ) {
    throw new Error(
      "encrypted provider-accepted mutation target is bound to different run coordinates",
    );
  }
  const iv = boundedBase64(
    encrypted.iv,
    "provider-accepted mutation target IV",
    12,
  );
  const ciphertext = boundedBase64(
    encrypted.ciphertext,
    "provider-accepted mutation target ciphertext",
    MAX_PROVIDER_ACCEPTED_TARGET_PLAINTEXT_BYTES + 16,
  );
  const tag = boundedBase64(
    encrypted.tag,
    "provider-accepted mutation target authentication tag",
    16,
  );
  if (iv.byteLength !== 12 || tag.byteLength !== 16) {
    throw new Error(
      "encrypted provider-accepted mutation target has invalid cryptographic parameters",
    );
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      readRecoveryKey(environment),
      iv,
    );
    decipher.setAAD(providerAcceptedTargetAdditionalData({
      runId: expected.runId,
      planDigest: expected.planDigest,
      adapterHash: expected.adapter.hash,
      operation: expected.operation,
      inputHash: expected.inputHash,
      authHash: expected.auth.hash,
      contractHash,
      dispatchId: expected.dispatch.id,
      dispatchIndex: expected.dispatch.index,
      dispatchPlanned: expected.dispatch.planned,
    }));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new Error(
      "encrypted provider-accepted mutation target failed authentication",
      { cause: error },
    );
  }
  if (plaintext.byteLength > MAX_PROVIDER_ACCEPTED_TARGET_PLAINTEXT_BYTES) {
    throw new Error(
      "decrypted provider-accepted mutation target exceeded its byte bound",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    ) as unknown;
  } catch {
    throw new Error("decrypted provider-accepted mutation target is malformed");
  }
  const evidence = parseProviderAcceptedMutationTargetEvidence(parsed);
  if (
    canonicalJson(providerAcceptedMutationTargetBinding(evidence))
      !== canonicalJson(expected)
  ) {
    throw new Error(
      "decrypted provider-accepted mutation target does not match its run binding",
    );
  }
  return evidence;
}

/**
 * Persist one provider-accepted target before any independent readback. A
 * byte-for-byte equivalent repeated callback is idempotent; any contradictory
 * duplicate fails closed and leaves the first encrypted evidence untouched.
 */
export function writeProviderAcceptedMutationTargetEvidence(
  evidenceValue: unknown,
  environment: Environment = process.env,
): void {
  const evidence = parseProviderAcceptedMutationTargetEvidence(evidenceValue);
  const plaintext = Buffer.from(canonicalJson(evidence), "utf8");
  if (plaintext.byteLength > MAX_PROVIDER_ACCEPTED_TARGET_PLAINTEXT_BYTES) {
    throw new Error(
      "provider-accepted mutation target exceeded its plaintext byte bound",
    );
  }
  const recoveryKey = readRecoveryKey(environment);
  ensurePrivateStateDirectory(
    providerAcceptedTargetRunDirectory(evidence.runId, environment),
    environment,
  );
  const contractHash = recoveryContractHash(evidence.contract);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    recoveryKey,
    iv,
  );
  cipher.setAAD(providerAcceptedTargetAdditionalData({
    runId: evidence.runId,
    planDigest: evidence.planDigest,
    adapterHash: evidence.adapter.hash,
    operation: evidence.operation,
    inputHash: evidence.inputHash,
    authHash: evidence.auth.hash,
    contractHash,
    dispatchId: evidence.dispatch.id,
    dispatchIndex: evidence.dispatch.index,
    dispatchPlanned: evidence.dispatch.planned,
  }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encrypted: EncryptedProviderAcceptedMutationTargetEvidence = {
    schemaVersion: 1,
    encryption: "aes-256-gcm",
    runId: evidence.runId,
    adapterHash: evidence.adapter.hash,
    authHash: evidence.auth.hash,
    contractHash,
    inputHash: evidence.inputHash,
    dispatchId: evidence.dispatch.id,
    dispatchIndex: evidence.dispatch.index,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
  const path = providerAcceptedTargetPath(
    evidence.runId,
    evidence.dispatch.index,
    environment,
  );
  const created = createPrivateJsonIfAbsent(path, encrypted, {
    environment,
    privateParent: true,
  });
  if (created.created) return;
  const text = readPrivateStateFileIfPresent(
    path,
    MAX_PROVIDER_ACCEPTED_TARGET_ENCRYPTED_BYTES,
    "encrypted provider-accepted mutation target evidence",
    environment,
  );
  if (text === null) {
    throw new Error(
      "provider-accepted mutation target changed during create-once verification",
    );
  }
  let existingValue: unknown;
  try {
    existingValue = JSON.parse(text) as unknown;
  } catch {
    throw new Error("encrypted provider-accepted mutation target is malformed");
  }
  const existing = decryptProviderAcceptedMutationTargetEvidence(
    parseEncryptedProviderAcceptedMutationTargetEvidence(existingValue),
    providerAcceptedMutationTargetBinding(evidence),
    environment,
  );
  if (canonicalJson(existing) !== canonicalJson(evidence)) {
    throw new Error(
      "a contradictory provider-accepted mutation target already exists for this dispatch",
    );
  }
}

/**
 * Read only evidence whose complete run and dispatch binding matches the exact
 * encrypted recovery capsule. Historical runs without evidence return null;
 * callers must not infer or manufacture a replacement target.
 */
export function readProviderAcceptedMutationTargetEvidence(
  capsuleValue: unknown,
  dispatchValue: unknown,
  environment: Environment = process.env,
): ProviderAcceptedMutationTargetEvidence | null {
  const expected = providerAcceptedMutationTargetBindingFromCapsule(
    capsuleValue,
    dispatchValue,
  );
  const text = readPrivateStateFileIfPresent(
    providerAcceptedTargetPath(
      expected.runId,
      expected.dispatch.index,
      environment,
    ),
    MAX_PROVIDER_ACCEPTED_TARGET_ENCRYPTED_BYTES,
    "encrypted provider-accepted mutation target evidence",
    environment,
  );
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("encrypted provider-accepted mutation target is malformed");
  }
  return decryptProviderAcceptedMutationTargetEvidence(
    parseEncryptedProviderAcceptedMutationTargetEvidence(parsed),
    expected,
    environment,
  );
}

export function removeProviderAcceptedMutationTargetEvidence(
  runId: string,
  environment: Environment = process.env,
): boolean {
  assertRunId(runId, "provider-accepted mutation target run ID");
  return removePrivateStateDirectoryTree(
    providerAcceptedTargetRunDirectory(runId, environment),
    environment,
  );
}

function parseObservation(value: unknown): ReconciliationObservation {
  if (!isRecord(value)) throw new Error("reconciliation observation must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "observationId",
      "runId",
      "observedAt",
      "receiptHash",
      "adapterHash",
      "operation",
      "inputHash",
      "authHash",
      "contractHash",
      "inputSource",
      "outcome",
      "desiredStateMatched",
      "actualState",
      "reason",
    ],
    "reconciliation observation",
  );
  if (value.schemaVersion !== 1) throw new Error("reconciliation observation schema is unsupported");
  assertRunId(value.observationId, "reconciliation observation ID");
  assertRunId(value.runId, "reconciliation run ID");
  assertTimestamp(value.observedAt, "reconciliation observation time");
  assertHash(value.receiptHash, "reconciliation receipt hash");
  assertHash(value.adapterHash, "reconciliation adapter hash");
  assertOperation(value.operation, "reconciliation operation");
  assertHash(value.inputHash, "reconciliation input hash");
  assertHash(value.authHash, "reconciliation auth hash");
  assertHash(value.contractHash, "reconciliation contract hash");
  if (value.inputSource !== "capsule" && value.inputSource !== "provided") {
    throw new Error("reconciliation input source is malformed");
  }
  if (
    value.outcome !== "desired-state-observed"
    && value.outcome !== "desired-state-not-observed"
    && value.outcome !== "inconclusive"
  ) throw new Error("reconciliation outcome is malformed");
  if (
    value.desiredStateMatched !== null
    && typeof value.desiredStateMatched !== "boolean"
  ) throw new Error("reconciliation desired-state match is malformed");
  if (value.actualState !== null && typeof value.actualState !== "boolean") {
    throw new Error("reconciliation actual state is malformed");
  }
  if (value.reason !== "exact-readback" && value.reason !== "readback-failed") {
    throw new Error("reconciliation reason is malformed");
  }
  if (
    value.outcome === "inconclusive"
      ? (
        value.desiredStateMatched !== null
        || value.actualState !== null
        || value.reason !== "readback-failed"
      )
      : (
        typeof value.desiredStateMatched !== "boolean"
        || typeof value.actualState !== "boolean"
        || value.reason !== "exact-readback"
        || (value.outcome === "desired-state-observed") !== value.desiredStateMatched
      )
  ) throw new Error("reconciliation observation fields disagree");
  return value as ReconciliationObservation;
}

export function appendReconciliationObservation(
  observationValue: ReconciliationObservation,
  environment: Environment = process.env,
): string {
  const observation = parseObservation(observationValue);
  const directory = observationRunDirectory(observation.runId, environment);
  const identity = ensurePrivateStateDirectory(directory, environment);
  const path = join(directory, `${observation.observationId}.json`);
  const result = createPrivateJsonIfAbsent(path, observation, {
    environment,
    expectedStateParent: identity,
  });
  if (!result.created) throw new Error("reconciliation observation ID already exists");
  return path;
}

export function listReconciliationObservations(
  runId: string,
  environment: Environment = process.env,
): readonly ReconciliationObservation[] {
  const directory = observationRunDirectory(runId, environment);
  const identity = ensurePrivateStateDirectory(directory, environment);
  return listPrivateStateDirectory(directory, environment, identity)
    .filter((entry) => entry.kind === "file" && /^[0-9a-f-]{36}\.json$/u.test(entry.name))
    .map((entry) => {
      const path = join(directory, entry.name);
      const text = readRegularFile(path, MAX_OBSERVATION_BYTES, "reconciliation observation", identity);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("reconciliation observation is malformed");
      }
      const observation = parseObservation(parsed);
      if (observation.runId !== runId || `${observation.observationId}.json` !== entry.name) {
        throw new Error("reconciliation observation coordinates do not match its path");
      }
      return observation;
    })
    .sort((left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.observationId.localeCompare(right.observationId));
}
