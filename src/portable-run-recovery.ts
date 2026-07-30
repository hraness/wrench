import { join } from "node:path";

import { loadAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  parsePortableOperationIdentityV1,
  type PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import {
  readRecoveryCapsule,
  recoveryContractHash,
} from "./recovery";
import {
  readRunReceipt,
  releaseReconciledRunRecovery,
  type RunReceipt,
} from "./runtime";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  wrenchStateHome,
  readPrivateStateFileIfPresent,
} from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;
type PortableReceipt = Extract<
  RunReceipt,
  { readonly schemaVersion: 6 }
>;

const RESOLUTION_DIRECTORY = "recovery/portable-resolutions";
const MAX_RESOLUTION_BYTES = 32 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const runIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type PortableRunReconciliationInput = {
  readonly outcome: "applied" | "not-applied";
  readonly evidenceHash: string;
};

export type PortableRunResolutionV1 = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly resolvedAt: string;
  readonly receiptHash: string;
  readonly planDigest: string;
  readonly adapterHash: string;
  readonly inputHash: string;
  readonly authHash: string;
  readonly contractHash: string;
  readonly portablePluginContract: PortableOperationIdentityV1;
  readonly outcome: PortableRunReconciliationInput["outcome"];
  readonly evidenceHash: string;
};

export type ReconcilePortableRunResult = {
  readonly ok: true;
  readonly kind: "portable-provider-plugin-reconciliation";
  readonly runId: string;
  readonly originalReceiptStatus: PortableReceipt["status"];
  readonly receiptUnchanged: true;
  readonly providerWriteDispatched: false;
  readonly outcome: PortableRunReconciliationInput["outcome"];
  readonly status: "succeeded" | "safe-retry";
  readonly evidenceHash: string;
  readonly recoveryArtifactsReleased: true;
};

function strictRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) =>
      typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new Error(`${label} has unsupported accessor fields`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function parsePortableRunReconciliationInput(
  value: unknown,
): PortableRunReconciliationInput {
  const record = strictRecord(
    value,
    ["outcome", "evidenceHash"],
    "portable run reconciliation input",
  );
  if (
    (record.outcome !== "applied" && record.outcome !== "not-applied")
    || typeof record.evidenceHash !== "string"
    || !sha256Pattern.test(record.evidenceHash)
  ) {
    throw new Error("portable run reconciliation input is malformed");
  }
  return Object.freeze({
    outcome: record.outcome,
    evidenceHash: record.evidenceHash,
  });
}

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error("portable run resolution timestamp is malformed");
  }
  return value;
}

function parseResolution(value: unknown): PortableRunResolutionV1 {
  const record = strictRecord(
    value,
    [
      "schemaVersion",
      "runId",
      "resolvedAt",
      "receiptHash",
      "planDigest",
      "adapterHash",
      "inputHash",
      "authHash",
      "contractHash",
      "portablePluginContract",
      "outcome",
      "evidenceHash",
    ],
    "portable run resolution",
  );
  if (
    record.schemaVersion !== 1
    || typeof record.runId !== "string"
    || !runIdPattern.test(record.runId)
    || (
      record.outcome !== "applied"
      && record.outcome !== "not-applied"
    )
  ) {
    throw new Error("portable run resolution is malformed");
  }
  for (const [key, candidate] of [
    ["receipt", record.receiptHash],
    ["plan", record.planDigest],
    ["adapter", record.adapterHash],
    ["input", record.inputHash],
    ["auth", record.authHash],
    ["contract", record.contractHash],
    ["evidence", record.evidenceHash],
  ] as const) {
    if (typeof candidate !== "string" || !sha256Pattern.test(candidate)) {
      throw new Error(`portable run resolution ${key} hash is malformed`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: record.runId,
    resolvedAt: canonicalTimestamp(record.resolvedAt),
    receiptHash: record.receiptHash as string,
    planDigest: record.planDigest as string,
    adapterHash: record.adapterHash as string,
    inputHash: record.inputHash as string,
    authHash: record.authHash as string,
    contractHash: record.contractHash as string,
    portablePluginContract: parsePortableOperationIdentityV1(
      record.portablePluginContract,
    ),
    outcome: record.outcome,
    evidenceHash: record.evidenceHash as string,
  });
}

function resolutionDirectory(environment: Environment): string {
  return join(wrenchStateHome(environment), ...RESOLUTION_DIRECTORY.split("/"));
}

function resolutionPath(runId: string, environment: Environment): string {
  if (!runIdPattern.test(runId)) {
    throw new Error("portable reconciliation run ID is malformed");
  }
  return join(resolutionDirectory(environment), `${runId}.json`);
}

export function readPortableRunResolution(
  runId: string,
  environment: Environment = process.env,
): PortableRunResolutionV1 | null {
  const text = readPrivateStateFileIfPresent(
    resolutionPath(runId, environment),
    MAX_RESOLUTION_BYTES,
    "portable run resolution",
    environment,
  );
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("portable run resolution is malformed JSON");
  }
  const resolution = parseResolution(value);
  if (
    resolution.runId !== runId
    || text !== `${canonicalJson(resolution)}\n`
  ) {
    throw new Error(
      "portable run resolution does not match its durable coordinate",
    );
  }
  return resolution;
}

function assertPortableReceipt(
  receipt: RunReceipt,
): asserts receipt is PortableReceipt & {
  readonly risk: "R2" | "R3";
  readonly planDigest: string;
} {
  if (
    receipt.schemaVersion !== 6
    || receipt.transport !== "portable-provider-plugin"
  ) {
    throw new Error(
      "portable reconciliation requires a portable provider plugin run",
    );
  }
  if (
    receipt.status !== "partial"
    && receipt.status !== "indeterminate"
  ) {
    throw new Error(
      "only an unsettled portable provider plugin run can be reconciled",
    );
  }
  if (
    (receipt.risk !== "R2" && receipt.risk !== "R3")
    || receipt.planDigest === null
    || receipt.dispatch.started < 1
    || receipt.dispatch.started > receipt.dispatch.planned
    || receipt.dispatch.verified < 0
    || receipt.dispatch.verified > receipt.dispatch.started
  ) {
    throw new Error(
      "portable run has no exact recoverable write schedule",
    );
  }
}

function assertCurrentContract(
  receipt: PortableReceipt,
  registry: ProviderPluginRegistry,
): void {
  const identity = receipt.portablePluginContract;
  const resolution = registry.requireOperationDefinition(
    identity.transport,
    identity.surfaceId,
    identity.operation,
    identity.contractVersion,
  );
  if (
    resolution.portableIdentity === null
    || canonicalJson(resolution.portableIdentity) !== canonicalJson(identity)
  ) {
    throw new Error(
      "portable plugin artifact or operation no longer matches the unsettled run",
    );
  }
}

function assertCapsuleMatchesReceipt(
  receipt: PortableReceipt & {
    readonly risk: "R2" | "R3";
    readonly planDigest: string;
  },
  environment: Environment,
): void {
  const capsule = readRecoveryCapsule(
    receipt.runId,
    receipt.auth.id,
    receipt.auth.hash,
    environment,
  );
  if (
    capsule === null
    || capsule.runId !== receipt.runId
    || capsule.planDigest !== receipt.planDigest
    || canonicalJson(capsule.adapter) !== canonicalJson(receipt.adapter)
    || capsule.operation !== receipt.operation
    || capsule.risk !== receipt.risk
    || capsule.inputHash !== receipt.inputHash
    || canonicalJson(capsule.auth) !== canonicalJson(receipt.auth)
    || capsule.contract.transport !== "portable-provider-plugin"
    || canonicalJson(capsule.contract.identity)
      !== canonicalJson(receipt.portablePluginContract)
  ) {
    throw new Error(
      "encrypted recovery capsule does not match the portable run receipt",
    );
  }
}

function resolutionFor(
  receipt: PortableReceipt & {
    readonly risk: "R2" | "R3";
    readonly planDigest: string;
  },
  input: PortableRunReconciliationInput,
  now: Date,
): PortableRunResolutionV1 {
  if (!Number.isFinite(now.valueOf())) {
    throw new Error("portable reconciliation clock is invalid");
  }
  return parseResolution({
    schemaVersion: 1,
    runId: receipt.runId,
    resolvedAt: now.toISOString(),
    receiptHash: sha256(canonicalJson(receipt)),
    planDigest: receipt.planDigest,
    adapterHash: receipt.adapter.hash,
    inputHash: receipt.inputHash,
    authHash: receipt.auth.hash,
    contractHash: recoveryContractHash({
      transport: "portable-provider-plugin",
      identity: receipt.portablePluginContract,
    }),
    portablePluginContract: receipt.portablePluginContract,
    outcome: input.outcome,
    evidenceHash: input.evidenceHash,
  });
}

function assertResolutionMatches(
  current: PortableRunResolutionV1,
  expected: PortableRunResolutionV1,
): void {
  const currentComparable = {
    ...current,
    resolvedAt: expected.resolvedAt,
  };
  if (canonicalJson(currentComparable) !== canonicalJson(expected)) {
    throw new Error(
      "portable run is already resolved with different evidence or outcome",
    );
  }
}

export function reconcilePortableProviderPluginRun(
  runId: string,
  inputValue: unknown,
  options: {
    readonly registry: ProviderPluginRegistry;
    readonly environment?: Environment;
    readonly now?: Date;
  },
): ReconcilePortableRunResult {
  const input = parsePortableRunReconciliationInput(inputValue);
  const environment = options.environment ?? process.env;
  const receipt = readRunReceipt(runId, environment);
  assertPortableReceipt(receipt);
  if (input.outcome === "not-applied" && receipt.dispatch.verified !== 0) {
    throw new Error(
      "not-applied evidence cannot release a run with a verified dispatch",
    );
  }
  const expected = resolutionFor(
    receipt,
    input,
    options.now ?? new Date(),
  );
  let resolution = readPortableRunResolution(runId, environment);
  if (resolution === null) {
    assertCurrentContract(receipt, options.registry);
    const auth = loadAuth(receipt.auth.id, environment);
    if (
      auth.kind !== receipt.auth.kind
      || sha256(canonicalJson(auth)) !== receipt.auth.hash
    ) {
      throw new Error(
        "current auth locator no longer matches the unsettled portable run",
      );
    }
    assertCapsuleMatchesReceipt(receipt, environment);
    const directoryIdentity = ensurePrivateStateDirectory(
      resolutionDirectory(environment),
      environment,
    );
    const created = createPrivateJsonIfAbsent(
      resolutionPath(runId, environment),
      expected,
      {
        environment,
        expectedStateParent: directoryIdentity,
      },
    );
    resolution = created.created
      ? expected
      : readPortableRunResolution(runId, environment);
    if (resolution === null) {
      throw new Error(
        "portable run resolution disappeared during publication",
      );
    }
  }
  assertResolutionMatches(resolution, expected);
  try {
    const released = releaseReconciledRunRecovery(
      receipt.runId,
      expected.receiptHash,
      environment,
      options.now ?? new Date(),
      input.outcome,
    );
    if (released !== "journal-released") {
      throw new Error(
        "portable run is missing its mandatory recovery journal",
      );
    }
  } catch (error) {
    throw new Error(
      "portable run evidence was stored, but recovery artifacts could not be fully released; rerun reconciliation",
      { cause: error },
    );
  }
  return Object.freeze({
    ok: true,
    kind: "portable-provider-plugin-reconciliation",
    runId: receipt.runId,
    originalReceiptStatus: receipt.status,
    receiptUnchanged: true,
    providerWriteDispatched: false,
    outcome: input.outcome,
    status: input.outcome === "applied" ? "succeeded" : "safe-retry",
    evidenceHash: input.evidenceHash,
    recoveryArtifactsReleased: true,
  });
}
