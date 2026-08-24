import type { WrenchAuth } from "./auth";
import { loadAuth } from "./auth";
import {
  canonicalJson,
  sha256,
  type OperationInput,
  type WebSessionRecipe,
} from "./model";
import { cleanupPlanAssets } from "./plan-assets";
import { requireProviderPluginAuth } from "./provider-plugin-auth";
import {
  runProviderPluginPlanConformance,
  type ProviderPluginReconciliationContextV1,
} from "./provider-plugin";
import type {
  ProviderPluginOperationResolutionV1,
  ProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  appendReconciliationObservation,
  readProviderAcceptedMutationTargetEvidence,
  readRecoveryCapsule,
  removeProviderAcceptedMutationTargetEvidence,
  removeRecoveryCapsule,
  type ReconciliationObservation,
  type RecoveryCapsule,
} from "./recovery";
import {
  readRunReceipt,
  releaseReconciledRunRecovery,
  type RunReceipt,
} from "./runtime";
import {
  getWebSessionContract,
  isCompatibleWebSessionContractHash,
} from "./web-session-contracts";

type Environment = Readonly<Record<string, string | undefined>>;

export const LEGACY_X_CONTENT_SAVE_CONTRACT_HASH =
  "7685de6bc2283991b5694b5f7ffda22f5251618ea76fe3e865d45ebe78f5d691";
export const LEGACY_X_CONTENT_SAVE_ADAPTER_HASH =
  "731d3dee1bbf60c2d1ca33d4089039d8a3fb1ca2c9f3c5fe735c0531ef4539b4";
export const PRE_PROVIDER_PLUGIN_X_CONTENT_SAVE_CONTRACT_HASH =
  "bcc3ae7768b24c0faa7654f9511570f2a85b4aced33e5f7f9bbfbbe559df99c9";
export const PRE_PROVIDER_PLUGIN_X_LIKES_SET_CONTRACT_HASH =
  "994ebbb3206063a4a12d89c4ad73c1e73d6f8868e1135ca4278b3bc08c6dec4b";
export const PRE_PROVIDER_PLUGIN_X_ADAPTER_VERSION = "1.1.0";
export const PRE_PROVIDER_PLUGIN_X_ADAPTER_HASH =
  "c9cec73197907ff846c4ef8142f3e8dd9d0cff3c9d4621102a35154d77f6265a";

export type ReconcileRunResult = {
  readonly ok: boolean;
  readonly status: "reconciliation-observed" | "reconciliation-inconclusive";
  readonly runId: string;
  readonly originalReceiptStatus: RunReceipt["status"];
  readonly receiptUnchanged: true;
  readonly providerWriteDispatched: false;
  readonly recoveryArtifactsReleased: boolean;
  readonly observation: ReconciliationObservation;
};

/**
 * A transport-neutral deterministic observation seam for recovery tests.
 * Production routing uses the resolved plugin binding's lazy reconciliation
 * hook. Values cross an untrusted boundary and are validated below.
 */
export type WebSessionRecoveryDependencies = {
  readonly observeActualState?: (
    recipe: WebSessionRecipe,
    input: OperationInput,
    auth: WrenchAuth,
    context?: ProviderPluginReconciliationContextV1,
  ) => Promise<unknown>;
  readonly releaseRecoveryArtifacts: (
    runId: string,
    planDigest: string,
    environment: Environment,
  ) => void;
};

const defaultReleaseRecoveryArtifacts:
  WebSessionRecoveryDependencies["releaseRecoveryArtifacts"] = (
    runId,
    planDigest,
    environment,
  ) => {
    // Remove the digest-bound media first so a cleanup failure leaves the
    // encrypted capsule available for another inspection.
    cleanupPlanAssets(planDigest, environment);
    removeProviderAcceptedMutationTargetEvidence(runId, environment);
    removeRecoveryCapsule(runId, environment);
  };

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

type SelectedReconciliation = {
  readonly receipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>;
  readonly resolution: ProviderPluginOperationResolutionV1;
  readonly input: OperationInput;
  readonly inputSource: "capsule" | "provided";
  readonly planDigest: string;
  readonly contractIdentity:
    | "current"
    | "pre-provider-plugin-x"
    | "ancient-x";
  readonly reconciliationContext?: ProviderPluginReconciliationContextV1;
};

type PreProviderPluginXContract = {
  readonly action: "content.save" | "likes.set";
  readonly version: 1 | 2;
  readonly hash: string;
};

const PRE_PROVIDER_PLUGIN_X_CONTRACTS = Object.freeze([
  Object.freeze({
    action: "content.save",
    version: 1,
    hash: PRE_PROVIDER_PLUGIN_X_CONTENT_SAVE_CONTRACT_HASH,
  }),
  Object.freeze({
    action: "likes.set",
    version: 2,
    hash: PRE_PROVIDER_PLUGIN_X_LIKES_SET_CONTRACT_HASH,
  }),
] as const satisfies readonly PreProviderPluginXContract[]);

function isUnsettled(status: RunReceipt["status"]): boolean {
  return status === "pending"
    || status === "partial"
    || status === "indeterminate";
}

function assertReconciliationReceipt(
  receipt: RunReceipt,
): asserts receipt is Extract<RunReceipt, { readonly schemaVersion: 4 }> {
  if (!isUnsettled(receipt.status)) {
    throw new Error("only an unsettled run can be reconciled");
  }
  if (receipt.planDigest === null) {
    throw new Error("the unsettled run has no exact confirmation-plan digest");
  }
  if (receipt.risk !== "R2" && receipt.risk !== "R3") {
    throw new Error(
      "this reconciliation contract supports only exact R2/R3 desired-state writes",
    );
  }
  if (
    receipt.risk === "R3"
    && receipt.adapter.id === "x-web"
    && receipt.operation === "content.save"
  ) {
    throw new Error(
      "this reconciliation contract supports only exact R2 X desired-state writes",
    );
  }
  if (
    receipt.dispatch.planned < 1
    || receipt.dispatch.started < 1
    || receipt.dispatch.started > receipt.dispatch.planned
    || receipt.dispatch.verified < 0
    || receipt.dispatch.verified > receipt.dispatch.started
  ) {
    throw new Error(
      "the unsettled run does not have the exact one-dispatch or plugin-declared dispatched write schedule",
    );
  }
  if (receipt.schemaVersion !== 4 || receipt.transport !== "web-session-api") {
    throw new Error(
      "this reconciliation command supports authenticated session plugin runs",
    );
  }
}

function isLegacyXContentSave(
  receipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>,
): boolean {
  return receipt.operation === "content.save"
    && receipt.webSessionContractHash === LEGACY_X_CONTENT_SAVE_CONTRACT_HASH
    && receipt.adapter.id === "x-web"
    && receipt.adapter.version === "1.0.0"
    && receipt.adapter.hash === LEGACY_X_CONTENT_SAVE_ADAPTER_HASH;
}

function isPreProviderPluginXContract(
  receipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>,
  capsule: RecoveryCapsule,
): boolean {
  const contractIdentity = capsule.contract;
  if (
    receipt.adapter.id !== "x-web"
    || receipt.adapter.version !== PRE_PROVIDER_PLUGIN_X_ADAPTER_VERSION
    || receipt.adapter.hash !== PRE_PROVIDER_PLUGIN_X_ADAPTER_HASH
    || contractIdentity.transport !== "web-session-api"
    || contractIdentity.site !== "x"
  ) {
    return false;
  }
  return PRE_PROVIDER_PLUGIN_X_CONTRACTS.some((contract) =>
    receipt.operation === contract.action
    && receipt.webSessionContractHash === contract.hash
    && contractIdentity.action === contract.action
    && contractIdentity.version === contract.version
    && contractIdentity.hash === contract.hash
  );
}

function legacyXRecipe(): WebSessionRecipe {
  return {
    site: "x",
    action: "content.save",
    contractVersion: 1,
    timeoutMs: 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
  };
}

function assertCapsuleMatchesReceipt(
  capsule: RecoveryCapsule,
  receipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>,
): void {
  if (
    capsule.runId !== receipt.runId
    || capsule.createdAt !== receipt.startedAt
    || capsule.planDigest !== receipt.planDigest
    || canonicalJson(capsule.adapter) !== canonicalJson(receipt.adapter)
    || capsule.operation !== receipt.operation
    || capsule.risk !== receipt.risk
    || capsule.inputHash !== receipt.inputHash
    || canonicalJson(capsule.auth) !== canonicalJson(receipt.auth)
    || capsule.contract.transport !== "web-session-api"
    || capsule.contract.action !== receipt.operation
    || capsule.contract.hash !== receipt.webSessionContractHash
  ) {
    throw new Error(
      "encrypted recovery capsule does not match the immutable run receipt",
    );
  }
}

function validateRecoveryInput(
  resolution: ProviderPluginOperationResolutionV1,
  value: OperationInput,
): OperationInput {
  const issues = resolution.operation.validateInput(value);
  if (issues.length > 0) {
    throw new Error(`reconciliation input is invalid: ${issues.join("; ")}`);
  }
  // The encrypted capsule parser already checks the bounded OperationInput
  // grammar. Canonicalizing here also rejects unsupported runtime values on
  // the legacy caller-supplied path.
  canonicalJson(value);
  return value;
}

function resolveOperation(
  site: string,
  action: string,
  version: number,
  registry: ProviderPluginRegistry,
): ProviderPluginOperationResolutionV1 {
  const binding = registry.requireSessionRoute(site);
  const resolution = registry.requireOperationDefinition(
    binding.transport,
    site,
    action,
    version,
  );
  if (resolution.binding.transport === "provider-api") {
    throw new Error("reconciliation resolved to the wrong plugin transport");
  }
  if (
    resolution.operation.reconciliation === undefined
    || resolution.binding.reconcile === undefined
  ) {
    throw new Error(
      `provider plugin operation ${site}/${action}@${version} has no registered reconciler`,
    );
  }
  return resolution;
}

function providerBoundTargetReconciliationContext(
  receipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>,
  capsule: RecoveryCapsule,
  resolution: ProviderPluginOperationResolutionV1,
  input: OperationInput,
  environment: Environment,
): ProviderPluginReconciliationContextV1 | undefined {
  const reconciliation = resolution.operation.reconciliation;
  if (
    reconciliation?.kind !== "provider-accepted-target-presence"
    && reconciliation?.kind !== "provider-bound-target-desired-state"
  ) {
    return undefined;
  }
  const targetKind = reconciliation.kind === "provider-accepted-target-presence"
    ? "provider-accepted"
    : "provider-bound";
  if (
    receipt.dispatchStarted !== true
    || receipt.dispatch.planned !== 1
    || receipt.dispatch.started !== 1
    || receipt.dispatch.verified < 0
    || receipt.dispatch.verified > 1
  ) {
    throw new Error(
      `${targetKind} target reconciliation requires one exact started dispatch`,
    );
  }
  const plannedDispatches = runProviderPluginPlanConformance(
    resolution.operation,
    input,
  );
  const plannedDispatch = plannedDispatches[0];
  if (plannedDispatches.length !== 1 || plannedDispatch === undefined) {
    throw new Error(
      `${targetKind} target reconciliation requires one exact confirmed dispatch`,
    );
  }
  const dispatch = Object.freeze({
    id: plannedDispatch.id,
    index: 1,
    planned: 1,
  });
  const evidence = readProviderAcceptedMutationTargetEvidence(
    capsule,
    dispatch,
    environment,
  );
  if (evidence === null) {
    throw new Error(
      reconciliation.kind === "provider-accepted-target-presence"
        ? "this provider-accepted target run has no encrypted response-derived target and is not safely reconcilable"
        : "this provider-bound target run has no encrypted exact pre-dispatch target and is not safely reconcilable",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: reconciliation.kind,
    dispatch,
    target: evidence.target,
  });
}

function selectReconciliation(
  receipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>,
  providedInput: unknown,
  environment: Environment,
  registry: ProviderPluginRegistry,
): SelectedReconciliation {
  const capsule = readRecoveryCapsule(
    receipt.runId,
    receipt.auth.id,
    receipt.auth.hash,
    environment,
  );
  if (capsule !== null) {
    assertCapsuleMatchesReceipt(capsule, receipt);
    if (capsule.contract.transport !== "web-session-api") {
      throw new Error("recovery capsule transport changed unexpectedly");
    }
    const resolution = resolveOperation(
      capsule.contract.site,
      capsule.contract.action,
      capsule.contract.version,
      registry,
    );
    const input = validateRecoveryInput(resolution, capsule.input);
    if (
      providedInput !== undefined
      && canonicalJson(providedInput) !== canonicalJson(input)
    ) {
      throw new Error(
        "provided reconciliation input does not match the encrypted recovery capsule",
      );
    }
    const reconciliationContext =
      providerBoundTargetReconciliationContext(
        receipt,
        capsule,
        resolution,
        input,
        environment,
      );
    return {
      receipt,
      resolution,
      input,
      inputSource: "capsule",
      planDigest: receipt.planDigest as string,
      contractIdentity: isPreProviderPluginXContract(receipt, capsule)
        ? "pre-provider-plugin-x"
        : "current",
      ...(reconciliationContext === undefined
        ? {}
        : { reconciliationContext }),
    };
  }

  if (!isLegacyXContentSave(receipt)) {
    throw new Error(
      "this run should have an encrypted recovery capsule; refusing caller-supplied replacement input",
    );
  }
  if (
    typeof providedInput !== "object"
    || providedInput === null
    || Array.isArray(providedInput)
  ) {
    throw new Error(
      "this legacy run has no encrypted recovery capsule; provide its exact original input with --input",
    );
  }
  const recipe = legacyXRecipe();
  const resolution = resolveOperation(
    recipe.site,
    recipe.action,
    recipe.contractVersion,
    registry,
  );
  const input = validateRecoveryInput(
    resolution,
    providedInput as OperationInput,
  );
  if (sha256(canonicalJson(input)) !== receipt.inputHash) {
    throw new Error(
      "provided reconciliation input does not match the run's canonical input hash",
    );
  }
  if (receipt.planDigest === null) {
    throw new Error("the unsettled run has no exact confirmation-plan digest");
  }
  return {
    receipt,
    resolution,
    input,
    inputSource: "provided",
    planDigest: receipt.planDigest,
    contractIdentity: "ancient-x",
  };
}

function assertExactHistoricalXSchedule(
  receipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>,
): void {
  if (receipt.risk !== "R2") {
    throw new Error(
      "this reconciliation contract supports only exact R2 X desired-state writes",
    );
  }
  if (
    receipt.dispatchStarted !== true
    || receipt.dispatch.planned !== 1
    || receipt.dispatch.started !== 1
    || receipt.dispatch.verified < 0
    || receipt.dispatch.verified > 1
  ) {
    throw new Error(
      "the unsettled X run does not have the exact one-dispatch desired-state schedule",
    );
  }
}

function assertSupportedContract(
  selected: SelectedReconciliation,
  registry: ProviderPluginRegistry,
): void {
  const { binding, operation, contractVersion } = selected.resolution;
  if (binding.transport === "provider-api") {
    throw new Error("reconciliation resolved to the wrong plugin transport");
  }
  if (operation.risk !== selected.receipt.risk) {
    throw new Error(
      "the unsettled run risk does not match its resolved plugin operation",
    );
  }
  if (selected.contractIdentity !== "current") {
    assertExactHistoricalXSchedule(selected.receipt);
    return;
  }
  const contract = getWebSessionContract({
    site: binding.surfaceId,
    action: operation.name,
    contractVersion,
    timeoutMs: 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
  }, registry);
  if (!isCompatibleWebSessionContractHash(
    contract,
    selected.receipt.webSessionContractHash,
    registry,
  )) {
    throw new Error(
      "the unsettled run is bound to an unsupported authenticated session contract hash; its receipt, encrypted recovery capsule, and plan assets were retained. Run `wrench doctor`, then use the exact predecessor build or complete a manual evidence review before reconciliation",
    );
  }
}

async function observeActualState(
  selected: SelectedReconciliation,
  auth: WrenchAuth,
  dependency:
    | WebSessionRecoveryDependencies["observeActualState"]
    | undefined,
): Promise<boolean> {
  const { binding, operation, contractVersion } = selected.resolution;
  if (binding.transport === "provider-api" || binding.reconcile === undefined) {
    throw new Error(
      `provider plugin operation ${binding.surfaceId}/${operation.name}@${contractVersion} has no registered reconciler`,
    );
  }
  const value = dependency === undefined
    ? await binding.reconcile(
        operation.name,
        selected.input,
        auth,
        selected.reconciliationContext,
      )
    : await dependency(
        {
          site: binding.surfaceId,
          action: operation.name,
          contractVersion,
          timeoutMs: 60_000,
          maxOutputBytes: 2 * 1024 * 1024,
        },
        selected.input,
        auth,
        selected.reconciliationContext,
      );
  if (
    !isUnknownRecord(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "actualState")
    || !Object.hasOwn(value, "reason")
    || typeof value.actualState !== "boolean"
    || typeof value.reason !== "string"
    || value.reason.length < 1
    || value.reason.length > 200
  ) {
    throw new Error("provider plugin reconciliation returned an invalid readback");
  }
  return value.actualState;
}

export async function reconcileWebSessionRun(
  runId: string,
  providedInput: unknown,
  options: {
    readonly environment?: Environment;
    readonly now?: Date;
    readonly dependencies?: Partial<WebSessionRecoveryDependencies>;
    readonly registry?: ProviderPluginRegistry;
  } = {},
): Promise<ReconcileRunResult> {
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? providerPluginRegistry;
  const receipt = readRunReceipt(runId, environment);
  assertReconciliationReceipt(receipt);
  const selected = selectReconciliation(
    receipt,
    providedInput,
    environment,
    registry,
  );
  assertSupportedContract(selected, registry);

  const auth = loadAuth(receipt.auth.id, environment);
  if (
    sha256(canonicalJson(auth)) !== receipt.auth.hash
    || auth.kind !== receipt.auth.kind
  ) {
    throw new Error(
      "the current auth locator no longer matches the unsettled run's exact realm",
    );
  }
  requireProviderPluginAuth(selected.resolution.binding, auth);
  if (
    auth.subject === undefined
    || !selected.resolution.binding.subject.matches(auth.subject)
  ) {
    throw new Error(
      "the current auth locator no longer has the plugin's exact bound subject",
    );
  }
  if (sha256(canonicalJson(selected.input)) !== receipt.inputHash) {
    throw new Error(
      "reconciliation input does not match the run's canonical input hash",
    );
  }

  const reconciliation = selected.resolution.operation.reconciliation;
  if (reconciliation === undefined) {
    throw new Error("provider plugin operation has no registered reconciler");
  }
  const desired = reconciliation.kind === "boolean-desired-state"
    ? reconciliation.desiredState(selected.input)
    : reconciliation.kind === "provider-accepted-target-presence"
      ? true
      : reconciliation.desiredState;
  if (typeof desired !== "boolean") {
    throw new Error(
      "provider plugin reconciliation desired state is invalid",
    );
  }
  const common = {
    schemaVersion: 1 as const,
    observationId: crypto.randomUUID(),
    runId: receipt.runId,
    observedAt: (options.now ?? new Date()).toISOString(),
    receiptHash: sha256(canonicalJson(receipt)),
    adapterHash: receipt.adapter.hash,
    operation: receipt.operation,
    inputHash: receipt.inputHash,
    authHash: receipt.auth.hash,
    contractHash: receipt.webSessionContractHash,
    inputSource: selected.inputSource,
  };
  let observation: ReconciliationObservation;
  try {
    const actual = await observeActualState(
      selected,
      auth,
      options.dependencies?.observeActualState,
    );
    if (
      reconciliation.kind === "provider-accepted-target-presence"
      && actual !== true
    ) {
      throw new Error(
        "provider-accepted target absence is not proof that the earlier write was not applied",
      );
    }
    const matched = actual === desired;
    observation = {
      ...common,
      outcome: matched
        ? "desired-state-observed"
        : "desired-state-not-observed",
      desiredStateMatched: matched,
      actualState: actual,
      reason: "exact-readback",
    };
  } catch {
    observation = {
      ...common,
      outcome: "inconclusive",
      desiredStateMatched: null,
      actualState: null,
      reason: "readback-failed",
    };
  }
  appendReconciliationObservation(observation, environment);

  let recoveryArtifactsReleased = false;
  if (observation.outcome === "desired-state-observed") {
    try {
      const releaseKind = releaseReconciledRunRecovery(
        receipt.runId,
        common.receiptHash,
        environment,
        options.now ?? new Date(),
      );
      if (releaseKind === "legacy-no-journal") {
        (
          options.dependencies?.releaseRecoveryArtifacts
          ?? defaultReleaseRecoveryArtifacts
        )(receipt.runId, selected.planDigest, environment);
      }
      recoveryArtifactsReleased =
        releaseKind !== "journal-retained-for-duplicate-successor";
    } catch (error) {
      throw new Error(
        "the desired-state observation was stored, but its recovery artifacts could not be fully released; rerun reconciliation",
        { cause: error },
      );
    }
  }
  return {
    ok: observation.outcome === "desired-state-observed",
    status: observation.outcome === "inconclusive"
      ? "reconciliation-inconclusive"
      : "reconciliation-observed",
    runId: receipt.runId,
    originalReceiptStatus: receipt.status,
    receiptUnchanged: true,
    providerWriteDispatched: false,
    recoveryArtifactsReleased,
    observation,
  };
}
