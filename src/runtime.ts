import { existsSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";

import { redactSensitiveText } from "@hraness/kb/clip/persist";
import {
  loadAuth,
  parseAuth,
  type WrenchAuth,
} from "./auth";
import {
  createReadProjectionQuery,
  projectionAuthIdentityHash,
  withSettledReadProjectionAuthAdmission,
  type ReadProjectionQuery,
} from "./read-projections";
import {
  executeBrowserRecipe,
  PreservedBrowserArtifactsError,
  type BrowserDispatchEvent,
  type BrowserFileResolver,
} from "./browser";
import {
  canonicalJson,
  DOM_ACTION_TRANSPORT_DISABLED_MESSAGE,
  expandBrowserRecipe,
  isLocalCliOperation,
  isProviderOperation,
  isReviewedTemplateOperation,
  isWebSessionOperation,
  operationRisks,
  manifestHash,
  parseRuntimeManifest,
  sha256,
  validateOperationInput,
  validatePlatformOperationInput,
  type BrowserDispatchPlan,
  type FileInputValue,
  type InputValue,
  type OperationInput,
  type OperationRisk,
  type WrenchManifest,
} from "./model";
import { OperationDeadlineError } from "./operation-deadline";
import {
  getLocalCliContract,
  localCliContractHash,
  localCliContractIdentity,
  parseLocalCliContractIdentityV1,
  type LocalCliContractIdentityV1,
} from "./local-cli-contracts";
import type {
  LocalCliDispatchEvent,
  LocalCliExecutionOptions,
  LocalCliOperationExecutor,
} from "./local-cli-execution";
import { runLocalCliOperationWithDeadline } from "./local-cli-execution";
import { localCliToolArtifactForCurrentRuntime } from "./local-cli-tool-identity";
import type { OperationDeadlineClock } from "./operation-deadline";
import {
  getProviderContract,
  providerContractHash,
} from "./provider-contracts";
import {
  executeProviderOperation,
  type ProviderDispatchEvent,
} from "./provider";
import { runProviderPluginPlanConformance } from "./provider-plugin";
import { requireProviderPluginAuth } from "./provider-plugin-auth";
import type {
  ProviderPluginOperationResolutionV1,
  ProviderPluginRegistry,
} from "./provider-plugin-registry";
import {
  isProviderPluginOperationName,
  isProviderPluginSurfaceId,
} from "./provider-plugin-identifiers";
import {
  parsePortableOperationIdentityV1,
  type PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import {
  acquirePortableProviderPluginInvocationLease,
  createPortableProviderPluginInvocationLeaseContainmentController,
  releasePortableProviderPluginInvocationLease,
} from "./provider-plugin-invocation-lease";
import {
  settlePortableProviderPluginCleanup,
} from "./provider-plugin-cleanup-barrier";
import {
  loadInstalledPortableProviderPlugin,
  withPortableProviderPluginCatalogLock,
} from "./provider-plugin-store";
import { providerPluginRegistry } from "./provider-plugins";
import {
  getWebSessionContract,
  webSessionContractHash,
} from "./web-session-contracts";
import {
  parseReadFailureProjection,
  readFailureProjection,
  runWebSessionOperationWithDeadline,
  WebSessionCleanupUnverifiedError,
  type ReadFailureProjection,
  type WebSessionCleanupBarrierRegistrar,
  type WebSessionExecutionOptions,
  type WebSessionDispatchEvent,
  type WebSessionOperationExecutor,
  type PublicWebSessionOperationExecutor,
  type WebSessionProviderAcceptedMutationTargetEvent,
  type WebSessionProviderBoundMutationTargetEvent,
} from "./web-session-execution";
import {
  withWebSessionCleanupAdmission,
  type WebSessionCleanupAdmissionIdentity,
} from "./web-session-cleanup-admission";
import {
  isPublicWebSessionInvocationAuthority,
  parsePublicWebSessionInvocationAuthority,
  persistedAuthAuthority,
  publicWebSessionInvocationAuthority,
  publicWebSessionAuthorityIdentityHash,
  webSessionAuthenticationPolicy,
  type InvocationAuthority,
  type WebSessionAuthenticationPolicy,
} from "./web-session-authentication-policy";
import {
  executeReviewedTemplateOperation,
  isCookieCapableWebAuth,
  planReviewedTemplateDispatches,
  reviewedTemplateHash,
  type ReviewedTemplateDispatchEvent,
} from "./reviewed-template";
import {
  cleanupPlanAssets,
  isPlanBoundFile,
  purgeOrphanedPlanAssets,
  resolvePlanAssetFiles,
  stagePlanAssets,
} from "./plan-assets";
import {
  readRecoveryCapsule,
  removeProviderAcceptedMutationTargetEvidence,
  removeRecoveryCapsule,
  writeProviderAcceptedMutationTargetEvidence,
  writeRecoveryCapsule,
  type RecoveryContractIdentity,
} from "./recovery";
import {
  createRunJournal,
  initialRunJournal,
  listRunJournalSnapshots,
  readRunJournal,
  runJournalNeedsRepair,
  transitionRunJournal,
  updateRunJournal,
  type RunJournal,
  type RunJournalSnapshot,
} from "./run-journal";
import {
  currentProcessStartIdentity,
  processOwnerStatus,
} from "./process-identity";
import {
  messagingReceiptBinding,
  messagingRunReceipt,
  readMessagingRun,
  readMessagingRunIfPresent,
  updateMessagingRun,
} from "./messaging-action-store";
import type {
  MessagingReceiptBinding,
  MessagingRunReceipt,
  MessagingRunV1,
} from "./messaging-types";
import {
  MAX_WRENCH_JSON_BYTES,
  loadInstalledManifest,
  loadInstalledManifestSnapshot,
  createPrivateJsonIfAbsent,
  ensurePrivateDirectory,
  listPrivateStateDirectory,
  readPrivateStateFilesBatched,
  readPrivateStateFileIfPresent,
  readRegularFile,
  readJsonFile,
  removePrivateStateFile,
  removePrivateStateFileIfUnchanged,
  wrenchStateHome,
  snapshotPrivateStateDirectory,
  writePrivateJsonIfUnchanged,
  writePrivateJson,
} from "./storage";

export const PLAN_TTL_MS = 5 * 60_000;
const MAX_PLAN_INPUT_BYTES = 1024 * 1024;

function assertPreparedInvocationBrowserPolicy(invocation: PreparedInvocation): void {
  const operation = invocation.manifest.operations[invocation.operationId];
  if (operation === undefined) throw new Error("operation disappeared while enforcing browser origin policy");
  if (
    !isProviderOperation(operation)
    && !isWebSessionOperation(operation)
    && !isReviewedTemplateOperation(operation)
    && !isLocalCliOperation(operation)
  ) {
    throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
  }
}

const MAX_PLAN_PLAINTEXT_BYTES = 1536 * 1024;
const MAX_ENCRYPTED_PLAN_BYTES = 3 * 1024 * 1024;

type InvocationPlanCommon = {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly operation: string;
  readonly risk: OperationRisk;
  readonly sideEffect: string;
  readonly input: OperationInput;
  readonly inputHash: string;
  readonly dispatches: readonly BrowserDispatchPlan[];
  readonly auth: {
    readonly id: string;
    readonly hash: string;
    readonly kind: WrenchAuth["kind"];
  };
  readonly duplicateRisk?: InvocationDuplicateRiskV1;
  readonly messagingComposite?: MessagingCompositeInvocationPlanV1;
};

export type MessagingCompositeInvocationPartV1 = {
  readonly partId: string;
  readonly text: string;
  readonly replyRef: string | null;
  readonly replyToProviderId: string | null;
  readonly input: OperationInput;
  readonly inputHash: string;
};

export type MessagingCompositeInvocationPlanV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-composite-invocation";
  readonly routeRef: string;
  readonly contextRef: string;
  readonly clientIntentSha256: string;
  /** Null only when reading an exact #72 predecessor plan. */
  readonly contextBindingSha256: string | null;
  /** Null only when reading an exact #72 predecessor plan. */
  readonly sourceConversationCoordinateSha256: string | null;
  readonly turnDigest: string;
  readonly previewDigest: string;
  readonly contextLimit: number;
  readonly baseExactDataRevision: string;
  readonly baseLatestMessageRevision: string;
  readonly baseRouteStateRevision: string;
  readonly baseMessages: readonly {
    readonly providerMessageId: string;
    readonly providerRevision: string | null;
    readonly orderedAt: string | null;
    readonly messageSha256: string;
  }[];
  readonly recipient: {
    readonly network: string;
    readonly conversation: {
      readonly kind: "single" | "group" | "unknown";
      readonly title: string | null;
      readonly participantCount: number;
    };
  };
  readonly parts: readonly MessagingCompositeInvocationPartV1[];
};

export type CreateMessagingCompositeInvocationPartV1 = {
  readonly partId: string;
  readonly text: string;
  readonly replyRef: string | null;
  readonly replyToProviderId: string | null;
  readonly invocation: PreparedInvocation;
};

export type CreateMessagingCompositeInvocationMetadataV1 = Omit<
  MessagingCompositeInvocationPlanV1,
  | "schemaVersion"
  | "format"
  | "previewDigest"
  | "parts"
  | "contextBindingSha256"
  | "sourceConversationCoordinateSha256"
> & {
  readonly contextBindingSha256: string;
  readonly sourceConversationCoordinateSha256: string;
};

export type InvocationDuplicateRiskV1 = {
  readonly schemaVersion: 1;
  readonly kind: "duplicate-risk";
  readonly sourceRunId: string;
  readonly sourcePlanDigest: string;
  readonly sourceReceiptHash: string;
  readonly sourceJournalHash: string;
  readonly sourceJournalRevision: number;
  readonly sourceLedgerHash: string;
  readonly sourceCapsuleHash: string;
  readonly scopeHash: string;
  readonly intentHash: string;
  readonly successorRunId: string | null;
};

export type CreateInvocationPlanOptions = {
  /**
   * Explicit prior uncertain runs accepted as duplicate risks. Version 1 is
   * deliberately limited to exactly one retained indeterminate posts.publish
   * dispatch.
   */
  readonly duplicateRiskOf?: readonly string[];
};

export type InvocationPlan = InvocationPlanCommon & (
  | {
      readonly schemaVersion: 2;
      readonly transport: "browser";
    }
  | {
      readonly schemaVersion: 3;
      readonly transport: "provider-api";
      readonly providerContract: {
        readonly provider: string;
        readonly action: string;
        readonly version: number;
        readonly hash: string;
      };
    }
  | {
      readonly schemaVersion: 4;
      readonly transport: "web-session-api";
      readonly webSessionContract: {
        readonly site: string;
        readonly action: string;
        readonly version: number;
        readonly hash: string;
      };
    }
  | {
      readonly schemaVersion: 5;
      readonly transport: "reviewed-template-api";
      readonly reviewedTemplateContract: {
        readonly version: 1;
        readonly hash: string;
      };
    }
  | {
      readonly schemaVersion: 6;
      readonly transport: "portable-provider-plugin";
      readonly portablePluginContract: PortableOperationIdentityV1;
    }
  | {
      readonly schemaVersion: 7;
      readonly transport: "local-cli";
      readonly localCliContract: LocalCliContractIdentityV1;
    }
);

export type StoredPlan = {
  readonly digest: string;
  readonly plan: InvocationPlan;
};

type RunReceiptCommon = {
  readonly runId: string;
  readonly planDigest: string | null;
  readonly adapter: { readonly id: string; readonly version: string; readonly hash: string };
  readonly operation: string;
  readonly risk: OperationRisk;
  readonly inputHash: string;
  readonly auth: { readonly id: string; readonly hash: string; readonly kind: InvocationAuthority["kind"] };
  readonly status: "pending" | "succeeded" | "submitted" | "failed" | "partial" | "indeterminate";
  readonly dispatchStarted: boolean;
  readonly dispatch: {
    readonly planned: number;
    readonly started: number;
    readonly verified: number;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly finalOrigin: string | null;
  readonly error: string | null;
};

export type RunReceipt = RunReceiptCommon & (
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
      readonly portablePluginContract: PortableOperationIdentityV1;
    }
  | {
      readonly schemaVersion: 7;
      readonly transport: "local-cli";
      readonly localCliContract: LocalCliContractIdentityV1;
    }
);

export type PreparedInvocation = {
  readonly manifest: WrenchManifest;
  readonly operationId: string;
  readonly input: OperationInput;
  /**
   * Invocation authority. The historical property name is retained for SDK
   * compatibility; public authorities are never persisted auth locators.
   */
  readonly auth: InvocationAuthority;
  /** Exact authority identity observed during preparation. */
  readonly readProjectionAuthIdentityHash?: string;
  /** Recomputed from the selected command-scoped registry; caller input is ignored. */
  readonly portablePluginContract?: PortableOperationIdentityV1;
};

function resolveCodeOwnedPluginOperation(
  operation: WrenchManifest["operations"][string],
  registry: ProviderPluginRegistry,
): ProviderPluginOperationResolutionV1 | null {
  if (isProviderOperation(operation)) {
    return registry.requireOperationDefinition(
      "provider-api",
      operation.provider.provider,
      operation.provider.action,
      operation.provider.contractVersion,
    );
  }
  if (isWebSessionOperation(operation)) {
    const binding = registry.requireSessionRoute(operation.webSession.site);
    return registry.requireOperationDefinition(
      binding.transport,
      operation.webSession.site,
      operation.webSession.action,
      operation.webSession.contractVersion,
    );
  }
  if (isLocalCliOperation(operation)) {
    return registry.requireOperationDefinition(
      "local-cli",
      operation.localCli.surface,
      operation.localCli.action,
      operation.localCli.contractVersion,
    );
  }
  return null;
}

function resolvedWebSessionAuthenticationPolicy(
  adapterId: string,
  operationId: string,
  operation: WrenchManifest["operations"][string],
  resolution: ProviderPluginOperationResolutionV1 | null,
): WebSessionAuthenticationPolicy {
  if (!isWebSessionOperation(operation)) return Object.freeze({ kind: "required" });
  if (
    resolution === null
    || resolution.binding.transport === "provider-api"
    || resolution.binding.transport === "local-cli"
  ) {
    throw new Error("authenticated session operation resolved to the wrong plugin transport");
  }
  return webSessionAuthenticationPolicy({
    adapterId,
    // Access policy belongs only to the descriptor's active contract. A
    // historical routing alias remains readable for archive compatibility,
    // but cannot inherit a newer public-authority/cache coordinate.
    ...(resolution.contractVersion !== resolution.operation.contractVersion
      || resolution.operation.access === undefined
      ? {}
      : { access: resolution.operation.access }),
    operationId,
    recipe: operation.webSession,
    pluginSourceKind: resolution.plugin.sourceKind,
    portable: resolution.portableIdentity !== null,
    risk: resolution.operation.risk,
    state: resolution.operation.state,
    dispatch: resolution.operation.dispatch,
  });
}

function assertCodeOwnedWriteSubject(
  operation: WrenchManifest["operations"][string],
  input: OperationInput,
  authority: InvocationAuthority,
  resolution: ProviderPluginOperationResolutionV1 | null,
): void {
  if (operation.risk !== "R2" && operation.risk !== "R3") return;
  const auth = persistedAuthAuthority(
    authority,
    "R2/R3 operations require a persisted auth locator",
  );
  if (resolution === null || resolution.operation.state !== "observed") return;
  if (auth.subject === undefined) {
    throw new Error(
      "R2/R3 code-owned authenticated API actions require an account-bound auth subject before preview",
    );
  }
  if (!resolution.binding.subject.matches(auth.subject)) {
    throw new Error(
      `R2/R3 ${resolution.binding.surfaceId} authenticated API actions require an exact current-account subject matching ${resolution.binding.subject.format} before preview`,
    );
  }
  const issues = resolution.operation.validateSubjectInput?.(input, auth.subject)
    ?? [];
  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }
}

function assertInvocationTransport(
  manifest: WrenchManifest,
  operationId: string,
  operation: WrenchManifest["operations"][string],
  input: OperationInput,
  authority: InvocationAuthority,
  registry: ProviderPluginRegistry,
): void {
  const resolution = resolveCodeOwnedPluginOperation(operation, registry);
  const authenticationPolicy = resolvedWebSessionAuthenticationPolicy(
    manifest.id,
    operationId,
    operation,
    resolution,
  );
  if (isProviderOperation(operation)) {
    const auth = persistedAuthAuthority(authority);
    if (resolution === null || resolution.binding.transport !== "provider-api") {
      throw new Error("official provider operation resolved to the wrong plugin transport");
    }
    if (!resolution.binding.authKinds.includes(auth.kind)) {
      throw new Error(
        `official ${resolution.binding.surfaceId} API capabilities require an ${resolution.binding.authKinds.join(" or ")} auth locator`,
      );
    }
    requireProviderPluginAuth(resolution.binding, auth);
    const contract = getProviderContract(operation.provider, registry);
    if (
      contract.provider !== operation.provider.provider
      || resolution.operation.name !== operationId
      || contract.operation !== resolution.operation.name
      || contract.risk !== operation.risk
      || contract.sideEffect !== operation.sideEffect
      || contract.idempotency !== operation.idempotency
      || contract.dedupeWindowMs !== operation.dedupeWindowMs
      || canonicalJson(contract.input) !== canonicalJson(operation.input)
    ) {
      throw new Error(`official provider contract semantics changed for ${operation.provider.provider}/${operationId}`);
    }
    if (resolution.operation.state !== "observed") {
      throw new Error(
        `${operation.provider.provider} ${operation.provider.action} is capture-required: ${resolution.operation.implementation}`,
      );
    }
    const conditionalIssues = resolution.operation.validateInput(input);
    if (conditionalIssues.length > 0) throw new Error(conditionalIssues.join("; "));
  } else if (isWebSessionOperation(operation)) {
    if (
      resolution === null
      || resolution.binding.transport === "provider-api"
      || resolution.binding.transport === "local-cli"
    ) {
      throw new Error("authenticated session operation resolved to the wrong plugin transport");
    }
    if (authenticationPolicy.kind === "public") {
      const publicAuthority = parsePublicWebSessionInvocationAuthority(
        authority,
        authenticationPolicy.authority,
      );
      if (
        canonicalJson(publicAuthority)
        !== canonicalJson(authenticationPolicy.authority)
      ) {
        throw new Error("public web-session invocation authority changed");
      }
      if (operation.risk !== "R1") {
        throw new Error("public web-session operations must be R1 reads");
      }
    } else {
      requireProviderPluginAuth(
        resolution.binding,
        persistedAuthAuthority(authority),
      );
    }
    const contract = getWebSessionContract(operation.webSession, registry);
    if (
      contract.site !== operation.webSession.site
      || resolution.operation.name !== operationId
      || contract.operation !== resolution.operation.name
      || contract.risk !== operation.risk
      || contract.sideEffect !== operation.sideEffect
      || contract.idempotency !== operation.idempotency
      || contract.dedupeWindowMs !== operation.dedupeWindowMs
      || canonicalJson(contract.input) !== canonicalJson(operation.input)
    ) {
      throw new Error(`authenticated web contract semantics changed for ${operation.webSession.site}/${operationId}`);
    }
    if (contract.state !== "observed") {
      throw new Error(`${operation.webSession.site} ${operation.webSession.action} is capture-required: ${contract.implementation}`);
    }
    const inputIssues = resolution.operation.validateInput(input);
    if (inputIssues.length > 0) throw new Error(inputIssues.join("; "));
  } else if (isLocalCliOperation(operation)) {
    const auth = persistedAuthAuthority(authority);
    if (resolution === null || resolution.binding.transport !== "local-cli") {
      throw new Error("local CLI operation resolved to the wrong plugin transport");
    }
    requireProviderPluginAuth(resolution.binding, auth);
    const contract = getLocalCliContract(operation.localCli, registry);
    if (
      contract.surface !== operation.localCli.surface
      || resolution.operation.name !== operationId
      || contract.operation !== resolution.operation.name
      || contract.risk !== operation.risk
      || contract.sideEffect !== operation.sideEffect
      || contract.idempotency !== operation.idempotency
      || contract.dedupeWindowMs !== operation.dedupeWindowMs
      || canonicalJson(contract.input) !== canonicalJson(operation.input)
      || canonicalJson(contract.tool) !== canonicalJson(resolution.binding.tool)
    ) {
      throw new Error(
        `local CLI contract semantics changed for ${operation.localCli.surface}/${operationId}`,
      );
    }
    if (contract.state !== "observed") {
      throw new Error(
        `${operation.localCli.surface} ${operation.localCli.action} is capture-required: ${contract.implementation}`,
      );
    }
    const inputIssues = resolution.operation.validateInput(input);
    if (inputIssues.length > 0) throw new Error(inputIssues.join("; "));
  } else if (isReviewedTemplateOperation(operation)) {
    const auth = persistedAuthAuthority(authority);
    if (operation.reviewedTemplate.state !== "reviewed") {
      throw new Error(`${operationId} is capture-required: ${operation.reviewedTemplate.instructions}`);
    }
    if (!isCookieCapableWebAuth(auth)) {
      throw new Error("reviewed templates require cookie-source, cookies-file, or cookie-backed browser-profile auth");
    }
  } else {
    throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
  }
  assertCodeOwnedWriteSubject(operation, input, authority, resolution);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFileInputValue = (value: unknown): value is FileInputValue =>
  isRecord(value) && value.kind === "file" && typeof value.reference === "string";

const isInputArray = (value: InputValue): value is readonly (string | number | boolean | FileInputValue)[] =>
  Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function preparedInputAsRawJson(input: OperationInput): Record<string, unknown> {
  if (!isRecord(input) || Object.keys(input).length > 100) {
    throw new Error("prepared input must be a bounded JSON object");
  }
  const raw: Record<string, unknown> = {};
  const scalarOrFile = (value: unknown, path: string): string | number | boolean => {
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (
      isFileInputValue(value)
      && hasExactKeys(value, ["kind", "reference"])
    ) return value.reference;
    throw new Error(`${path} contains unsupported prepared state`);
  };
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      if (
        value.length > 1_000
        || Object.keys(value).length !== value.length
      ) throw new Error(`input.${key} must be a bounded dense array`);
      raw[key] = value.map((item, index) => scalarOrFile(item, `input.${key}[${index}]`));
    } else {
      raw[key] = scalarOrFile(value, `input.${key}`);
    }
  }
  return raw;
}

function revalidatePreparedInvocation(
  invocation: PreparedInvocation,
  registry: ProviderPluginRegistry = providerPluginRegistry,
): {
  readonly invocation: PreparedInvocation;
  readonly operation: WrenchManifest["operations"][string];
} {
  const parsedManifest = parseRuntimeManifest(invocation.manifest, registry);
  if (!parsedManifest.ok) {
    throw new Error(`prepared manifest is invalid: ${parsedManifest.issues.join("; ")}`);
  }
  if (canonicalJson(parsedManifest.value) !== canonicalJson(invocation.manifest)) {
    throw new Error("prepared manifest contains unsupported or non-canonical state");
  }
  const operation = parsedManifest.value.operations[invocation.operationId];
  if (operation === undefined) throw new Error("operation disappeared while validating the prepared invocation");
  const input = validateOperationInput(
    operation.input,
    preparedInputAsRawJson(invocation.input),
    parsedManifest.value.origins,
  );
  if (!input.ok) throw new Error(input.issues.join("; "));
  const platformInput = validatePlatformOperationInput(parsedManifest.value, invocation.operationId, input.value);
  if (!platformInput.ok) throw new Error(platformInput.issues.join("; "));
  if (canonicalJson(platformInput.value) !== canonicalJson(invocation.input)) {
    throw new Error("prepared input contains unsupported or non-canonical state");
  }
  const resolution = resolveCodeOwnedPluginOperation(operation, registry);
  const authenticationPolicy = resolvedWebSessionAuthenticationPolicy(
    parsedManifest.value.id,
    invocation.operationId,
    operation,
    resolution,
  );
  const auth: InvocationAuthority = authenticationPolicy.kind === "public"
    ? parsePublicWebSessionInvocationAuthority(
        invocation.auth,
        authenticationPolicy.authority,
      )
    : parseAuth(invocation.auth);
  if (canonicalJson(auth) !== canonicalJson(invocation.auth)) {
    throw new Error("prepared invocation authority contains unsupported state");
  }
  const readProjectionAuthIdentityHash =
    invocation.readProjectionAuthIdentityHash;
  if (
    readProjectionAuthIdentityHash !== undefined
    && !/^[a-f0-9]{64}$/u.test(readProjectionAuthIdentityHash)
  ) {
    throw new Error("prepared auth lifetime identity is malformed");
  }
  if (
    authenticationPolicy.kind === "public"
    && (
      !isPublicWebSessionInvocationAuthority(auth)
      || readProjectionAuthIdentityHash
        !== publicWebSessionAuthorityIdentityHash(auth)
    )
  ) {
    throw new Error("prepared public invocation authority identity changed");
  }
  const checkedBase: PreparedInvocation = {
    manifest: parsedManifest.value,
    operationId: invocation.operationId,
    input: platformInput.value,
    auth,
    ...(readProjectionAuthIdentityHash === undefined
      ? {}
      : { readProjectionAuthIdentityHash }),
  };
  assertPreparedInvocationBrowserPolicy(checkedBase);
  assertInvocationTransport(
    checkedBase.manifest,
    checkedBase.operationId,
    operation,
    checkedBase.input,
    checkedBase.auth,
    registry,
  );
  const portablePluginContract = resolution?.portableIdentity ?? null;
  const checked: PreparedInvocation = portablePluginContract === null
    ? checkedBase
    : {
        ...checkedBase,
        portablePluginContract,
      };
  return { invocation: checked, operation };
}

function planDirectory(environment: Readonly<Record<string, string | undefined>>): string {
  return join(wrenchStateHome(environment), "plans");
}

function planPath(digest: string, environment: Readonly<Record<string, string | undefined>>): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("confirmation digest must be 64 lowercase hexadecimal characters");
  return join(planDirectory(environment), `${digest}.json`);
}

export function invocationPlanDigest(plan: InvocationPlan): string {
  if (plan.messagingComposite === undefined) return sha256(canonicalJson(plan));
  const {
    contextBindingSha256,
    sourceConversationCoordinateSha256,
    ...predecessorComposite
  } = plan.messagingComposite;
  if (
    (contextBindingSha256 === null)
    !== (sourceConversationCoordinateSha256 === null)
  ) throw new Error("messaging composite invocation has partial context evidence");
  const messagingComposite = contextBindingSha256 === null
    ? predecessorComposite
    : {
        ...predecessorComposite,
        contextBindingSha256,
        sourceConversationCoordinateSha256,
      };
  return sha256(canonicalJson({
    ...plan,
    messagingComposite: {
      ...messagingComposite,
      // The preview artifact contains this digest, so its own hash is bound by
      // authenticated plan storage and validation rather than a circular hash.
      previewDigest: null,
    },
  }));
}

function portablePluginStoreRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(wrenchStateHome(environment), "provider-plugins");
}

function assertPortableOperationIdentityIsActive(
  identity: PortableOperationIdentityV1,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const installed = loadInstalledPortableProviderPlugin(
    portablePluginStoreRoot(environment),
    identity.pluginId,
  );
  if (installed === null) {
    throw new Error(
      `portable provider plugin ${identity.pluginId} is no longer enabled; preview the action again`,
    );
  }
  const packageValue = installed.package;
  if (
    packageValue.manifest.id !== identity.pluginId
    || packageValue.manifest.version !== identity.pluginVersion
    || packageValue.manifest.hostApiVersion !== identity.hostApiVersion
    || packageValue.bundleSha256 !== identity.bundleSha256
    || packageValue.manifestSha256 !== identity.manifestSha256
  ) {
    throw new Error(
      `portable provider plugin ${identity.pluginId} changed before its preview became durable; preview the action again`,
    );
  }
}

const CONFIRMATION_CLAIM_LEASE_MS = 11 * 60_000;
const MAX_CONFIRMATION_CLAIM_BYTES = 4 * 1024;

export type ConfirmationClaim = {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly runId: string;
  readonly owner: {
    readonly pid: number;
    readonly token: string;
    readonly bootId: string;
    readonly processStartId: string;
    readonly leaseUntil: string;
  };
  readonly createdAt: string;
};

export type ConfirmationClaimSnapshot = {
  readonly claim: ConfirmationClaim;
  readonly contentSha256: string;
};

function confirmationClaimPath(
  digest: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(
      "confirmation digest must be 64 lowercase hexadecimal characters",
    );
  }
  return join(planDirectory(environment), `${digest}.claim.json`);
}

function parseConfirmationClaim(value: unknown): ConfirmationClaim {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      ["schemaVersion", "digest", "runId", "owner", "createdAt"],
    )
    || value.schemaVersion !== 1
    || typeof value.digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.digest)
    || typeof value.runId !== "string"
    || !/^[0-9a-f-]{36}$/u.test(value.runId)
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || !isRecord(value.owner)
    || !hasExactKeys(
      value.owner,
      ["pid", "token", "bootId", "processStartId", "leaseUntil"],
    )
    || typeof value.owner.pid !== "number"
    || !Number.isSafeInteger(value.owner.pid)
    || value.owner.pid < 1
    || value.owner.pid > 2_147_483_647
    || typeof value.owner.token !== "string"
    || !/^[0-9a-f-]{36}$/u.test(value.owner.token)
    || typeof value.owner.bootId !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.owner.bootId)
    || typeof value.owner.processStartId !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.owner.processStartId)
    || typeof value.owner.leaseUntil !== "string"
    || !Number.isFinite(Date.parse(value.owner.leaseUntil))
  ) {
    throw new Error("confirmation ownership claim is malformed");
  }
  return Object.freeze({
    schemaVersion: 1,
    digest: value.digest,
    runId: value.runId,
    owner: Object.freeze({
      pid: value.owner.pid,
      token: value.owner.token,
      bootId: value.owner.bootId,
      processStartId: value.owner.processStartId,
      leaseUntil: value.owner.leaseUntil,
    }),
    createdAt: value.createdAt,
  });
}

function readConfirmationClaim(
  digest: string,
  environment: Readonly<Record<string, string | undefined>>,
): ConfirmationClaimSnapshot | null {
  const text = readPrivateStateFileIfPresent(
    confirmationClaimPath(digest, environment),
    MAX_CONFIRMATION_CLAIM_BYTES,
    "confirmation ownership claim",
    environment,
  );
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("confirmation ownership claim is malformed");
  }
  const claim = parseConfirmationClaim(value);
  if (claim.digest !== digest) {
    throw new Error("confirmation ownership claim coordinate is malformed");
  }
  return Object.freeze({
    claim,
    contentSha256: sha256(text),
  });
}

export type ListedConfirmationClaim =
  | ConfirmationClaimSnapshot
  | {
      readonly digest: string;
      readonly invalid: true;
    };

export function listConfirmationClaimSnapshots(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly ListedConfirmationClaim[] {
  return Object.freeze(
    listPrivateStateDirectory(planDirectory(environment), environment)
      .filter((entry) =>
        entry.kind === "file"
        && /^[a-f0-9]{64}\.claim\.json$/u.test(entry.name)
      )
      .map((entry): ListedConfirmationClaim => {
        const digest = entry.name.slice(0, 64);
        try {
          return readConfirmationClaim(digest, environment)
            ?? { digest, invalid: true };
        } catch {
          return { digest, invalid: true };
        }
      }),
  );
}

function acquireConfirmationClaim(
  digest: string,
  runId: string,
  environment: Readonly<Record<string, string | undefined>>,
  now: Date,
): ConfirmationClaimSnapshot {
  const processIdentity = currentProcessStartIdentity();
  const claim = parseConfirmationClaim({
    schemaVersion: 1,
    digest,
    runId,
    owner: {
      pid: process.pid,
      token: crypto.randomUUID(),
      ...processIdentity,
      leaseUntil: new Date(
        now.getTime() + CONFIRMATION_CLAIM_LEASE_MS,
      ).toISOString(),
    },
    createdAt: now.toISOString(),
  });
  const created = createPrivateJsonIfAbsent(
    confirmationClaimPath(digest, environment),
    claim,
    { environment, privateParent: true },
  );
  if (!created.created) {
    throw new Error(
      "confirmation plan is already being confirmed, cancelled, or expired",
    );
  }
  return Object.freeze({
    claim,
    contentSha256: sha256(`${canonicalJson(claim)}\n`),
  });
}

function releaseConfirmationClaim(
  snapshot: ConfirmationClaimSnapshot,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return removePrivateStateFileIfUnchanged(
    confirmationClaimPath(snapshot.claim.digest, environment),
    { expectedCurrentContentSha256: snapshot.contentSha256 },
    environment,
  );
}

function planKeyPath(environment: Readonly<Record<string, string | undefined>>): string {
  return join(wrenchStateHome(environment), ".plan-encryption-key");
}

type PlanKey = {
  readonly bytes: Buffer;
  readonly id: string;
};

function planKeyId(key: Uint8Array): string {
  return createHash("sha256")
    .update("io-plan-key-id-v1\0", "utf8")
    .update(key)
    .digest("hex");
}

function planKey(environment: Readonly<Record<string, string | undefined>>): PlanKey {
  const path = planKeyPath(environment);
  ensurePrivateDirectory(wrenchStateHome(environment));
  if (!existsSync(path)) {
    const existingPlans = listPrivateStateDirectory(
      planDirectory(environment),
      environment,
    ).some((entry) =>
      entry.kind === "file"
      && /^[a-f0-9]{64}\.json$/u.test(entry.name)
    );
    if (existingPlans) {
      throw new Error(
        "plan encryption key is missing while encrypted plans still exist; refusing to replace it",
      );
    }
    const key = randomBytes(32);
    createPrivateJsonIfAbsent(path, {
      schemaVersion: 2,
      keyId: planKeyId(key),
      key: key.toString("hex"),
    }, { environment, privateParent: true });
  }
  const text = readRegularFile(path, 512, "plan encryption key").trim();
  let keyHex = text;
  let recordedKeyId: string | null = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Accept the initial newline-delimited hex format for local upgrade compatibility.
    parsed = undefined;
  }
  if (parsed !== undefined) {
    if (
      !isRecord(parsed)
      || (
        !hasExactKeys(parsed, ["schemaVersion", "key"])
        && !hasExactKeys(parsed, ["schemaVersion", "keyId", "key"])
      )
      || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2)
      || typeof parsed.key !== "string"
      || (parsed.schemaVersion === 1 && !hasExactKeys(parsed, ["schemaVersion", "key"]))
      || (parsed.schemaVersion === 2 && !hasExactKeys(parsed, ["schemaVersion", "keyId", "key"]))
    ) {
      throw new Error("plan encryption key is malformed");
    }
    keyHex = parsed.key;
    if (parsed.schemaVersion === 2) {
      if (typeof parsed.keyId !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.keyId)) {
        throw new Error("plan encryption key is malformed");
      }
      recordedKeyId = parsed.keyId;
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(keyHex)) throw new Error("plan encryption key is malformed");
  const bytes = Buffer.from(keyHex, "hex");
  const id = planKeyId(bytes);
  if (recordedKeyId !== null && recordedKeyId !== id) {
    throw new Error("plan encryption key identity is malformed");
  }
  return { bytes, id };
}

type EncryptedPlanV1 = {
  readonly schemaVersion: 1;
  readonly encryption: "aes-256-gcm";
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

type EncryptedPlanV2 = {
  readonly schemaVersion: 2;
  readonly encryption: "aes-256-gcm";
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

type EncryptedPlan = EncryptedPlanV1 | EncryptedPlanV2;

function encryptPlan(stored: StoredPlan, environment: Readonly<Record<string, string | undefined>>): EncryptedPlan {
  const plaintext = Buffer.from(canonicalJson(stored), "utf8");
  if (plaintext.byteLength > MAX_PLAN_PLAINTEXT_BYTES) throw new Error("confirmation plan exceeds its encrypted size bound");
  const iv = randomBytes(12);
  const key = planKey(environment);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv);
  cipher.setAAD(Buffer.from(`io-plan-v2\0${key.id}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schemaVersion: 2,
    encryption: "aes-256-gcm",
    keyId: key.id,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function boundedBase64(value: unknown, label: string, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > maximum || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return Buffer.from(value, "base64");
}

function decryptPlan(value: unknown, environment: Readonly<Record<string, string | undefined>>): StoredPlan {
  if (!isRecord(value)) {
    throw new Error("encrypted plan is malformed");
  }
  const record = value;
  const legacy = record.schemaVersion === 1;
  if (
    (legacy
      ? !hasExactKeys(record, ["schemaVersion", "encryption", "iv", "ciphertext", "tag"])
      : !hasExactKeys(record, ["schemaVersion", "encryption", "keyId", "iv", "ciphertext", "tag"]))
    || (!legacy && record.schemaVersion !== 2)
    || record.encryption !== "aes-256-gcm"
    || (!legacy && (typeof record.keyId !== "string" || !/^[a-f0-9]{64}$/u.test(record.keyId)))
  ) throw new Error("encrypted plan is malformed");
  const iv = boundedBase64(record.iv, "plan IV", 64);
  const ciphertext = boundedBase64(record.ciphertext, "plan ciphertext", MAX_ENCRYPTED_PLAN_BYTES);
  const tag = boundedBase64(record.tag, "plan authentication tag", 64);
  if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error("encrypted plan has invalid cryptographic parameters");
  const key = planKey(environment);
  if (!legacy && record.keyId !== key.id) {
    throw new Error("encrypted plan was written under a different key identity");
  }
  const decipher = createDecipheriv("aes-256-gcm", key.bytes, iv);
  if (!legacy) decipher.setAAD(Buffer.from(`io-plan-v2\0${key.id}`, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.byteLength > MAX_PLAN_PLAINTEXT_BYTES) throw new Error("decrypted plan exceeds its size bound");
  return parseStoredPlan(JSON.parse(plaintext.toString("utf8")) as unknown);
}

function receiptPath(runId: string, environment: Readonly<Record<string, string | undefined>>): string {
  if (!/^[0-9a-f-]{36}$/u.test(runId)) throw new Error("run ID is invalid");
  return join(wrenchStateHome(environment), "runs", `${runId}.json`);
}

function authHash(auth: InvocationAuthority): string {
  return sha256(canonicalJson(auth));
}

function finalOrigin(value: string | null, origins: readonly string[]): string | null {
  if (value === null) return null;
  try {
    const origin = new URL(value).origin;
    return origins.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

const MAX_RECOVERY_HANDLE_BYTES = 8 * 1024;
const MAX_RUN_RECEIPT_ERROR_BYTES = 12 * 1024;

function boundedRecoveryHandle(value: string | undefined): string | null {
  if (
    value === undefined
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > MAX_RECOVERY_HANDLE_BYTES
  ) return null;
  return /^[A-Za-z0-9_./:;=+-]+$/u.test(value) ? value : null;
}

function loadInstalledManifestWithRegistry(
  adapterId: string,
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): ReturnType<typeof loadInstalledManifest> {
  const owned = registry.resolveOwnedManifest(adapterId);
  if (owned === undefined) {
    return loadInstalledManifest(adapterId, environment, registry);
  }
  const stored = loadInstalledManifestSnapshot(
    adapterId,
    environment,
    registry,
  );
  if (stored.availability !== "absent") {
    return {
      ok: false,
      issues: [
        `adapter ${adapterId} collides with an enabled portable provider plugin`,
      ],
    };
  }
  return parseRuntimeManifest(owned, registry);
}

export function prepareInvocation(
  adapterId: string,
  operationId: string,
  rawInput: unknown,
  authId?: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  registry: ProviderPluginRegistry = providerPluginRegistry,
): PreparedInvocation {
  const manifestResult = loadInstalledManifestWithRegistry(adapterId, environment, registry);
  if (!manifestResult.ok) throw new Error(`adapter ${adapterId} is invalid: ${manifestResult.issues.join("; ")}`);
  const operation = manifestResult.value.operations[operationId];
  if (operation === undefined) throw new Error(`adapter ${adapterId} does not provide ${operationId}`);
  const inputResult = validateOperationInput(operation.input, rawInput, manifestResult.value.origins);
  if (!inputResult.ok) throw new Error(inputResult.issues.join("; "));
  const platformInput = validatePlatformOperationInput(manifestResult.value, operationId, inputResult.value);
  if (!platformInput.ok) throw new Error(platformInput.issues.join("; "));
  const resolution = resolveCodeOwnedPluginOperation(operation, registry);
  const authenticationPolicy = resolvedWebSessionAuthenticationPolicy(
    manifestResult.value.id,
    operationId,
    operation,
    resolution,
  );
  if (authenticationPolicy.kind === "public") {
    if (!isWebSessionOperation(operation)) {
      throw new Error("public invocation authority requires a web-session operation");
    }
    if (authId !== undefined) {
      throw new Error(
        `${operation.webSession.site} ${operationId} is public and does not accept an auth locator`,
      );
    }
    const authority = authenticationPolicy.authority;
    return revalidatePreparedInvocation({
      manifest: manifestResult.value,
      operationId,
      input: platformInput.value,
      auth: authority,
      readProjectionAuthIdentityHash:
        publicWebSessionAuthorityIdentityHash(authority),
    }, registry).invocation;
  }
  const selectedAuthId = authId ?? adapterId;
  const preparedAuth = withSettledReadProjectionAuthAdmission(
    selectedAuthId,
    environment,
    () => {
      const auth = loadAuth(selectedAuthId, environment);
      return Object.freeze({
        auth,
        readProjectionAuthIdentityHash: projectionAuthIdentityHash(
          auth.id,
          authHash(auth),
          environment,
        ),
      });
    },
  );
  return revalidatePreparedInvocation({
    manifest: manifestResult.value,
    operationId,
    input: platformInput.value,
    auth: preparedAuth.auth,
    readProjectionAuthIdentityHash:
      preparedAuth.readProjectionAuthIdentityHash,
  }, registry).invocation;
}

/**
 * Derive the exact private read-projection coordinate from the same checked
 * adapter, auth realm, transport, and executable contract used for a live
 * invocation. A verified subject is mandatory because an unbound browser
 * locator can change accounts without changing its local path.
 */
export function createReadProjectionQueryForInvocation(
  invocation: PreparedInvocation,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  registry: ProviderPluginRegistry = providerPluginRegistry,
): ReadProjectionQuery {
  const checked = revalidatePreparedInvocation(invocation, registry);
  const operation = checked.operation;
  if (operation.risk !== "R1") {
    throw new Error("only R1 capabilities have read projections");
  }
  const subject = checked.invocation.auth.subject;
  if (subject === undefined) {
    throw new Error(
      `auth locator ${checked.invocation.auth.id} must be bound to a verified subject before private read projections can be stored or served; run wrench auth bind ${checked.invocation.auth.id}`,
    );
  }
  const pluginResolution = resolveCodeOwnedPluginOperation(operation, registry);
  if (
    pluginResolution !== null
    && pluginResolution.operation.state === "observed"
    && !isPublicWebSessionInvocationAuthority(checked.invocation.auth)
    && !pluginResolution.binding.subject.matches(subject)
  ) {
    throw new Error(
      `auth locator ${checked.invocation.auth.id} has a subject that does not match ${pluginResolution.binding.subject.format}`,
    );
  }
  const portableIdentity = pluginResolution?.portableIdentity ?? null;
  const preparedAuthIdentityHash =
    checked.invocation.readProjectionAuthIdentityHash;
  if (preparedAuthIdentityHash === undefined) {
    throw new Error(
      "prepared invocation is missing its auth lifetime identity; prepare it again",
    );
  }
  const contract = portableIdentity !== null
    ? {
        transport: "portable-provider-plugin" as const,
        hash: sha256(canonicalJson(portableIdentity)),
      }
    : isProviderOperation(operation)
      ? {
          transport: "provider-api" as const,
          hash: providerContractHash(
            getProviderContract(operation.provider, registry),
            registry,
          ),
        }
      : isWebSessionOperation(operation)
        ? {
            transport: "web-session-api" as const,
            hash: webSessionContractHash(
              getWebSessionContract(operation.webSession, registry),
              registry,
            ),
          }
        : isLocalCliOperation(operation)
          ? {
              transport: "local-cli" as const,
              hash: localCliContractHash(
                getLocalCliContract(operation.localCli, registry),
                registry,
              ),
              tool: getLocalCliContract(operation.localCli, registry).tool,
            }
        : isReviewedTemplateOperation(operation)
          ? {
              transport: "reviewed-template-api" as const,
              hash: reviewedTemplateHash(operation.reviewedTemplate),
            }
          : {
              transport: "browser" as const,
              hash: manifestHash(checked.invocation.manifest),
            };
  return createReadProjectionQuery({
    adapter: {
      id: checked.invocation.manifest.id,
      version: checked.invocation.manifest.version,
      hash: manifestHash(checked.invocation.manifest),
    },
    operation: checked.invocation.operationId,
    input: checked.invocation.input,
    inputHash: sha256(canonicalJson(checked.invocation.input)),
    auth: {
      id: checked.invocation.auth.id,
      kind: checked.invocation.auth.kind,
      hash: preparedAuthIdentityHash,
      subject,
    },
    contract,
  }, environment);
}

export function createInvocationPlan(
  invocation: PreparedInvocation,
  now = new Date(),
  registry: ProviderPluginRegistry = providerPluginRegistry,
): StoredPlan {
  const checked = revalidatePreparedInvocation(invocation, registry);
  invocation = checked.invocation;
  const operation = checked.operation;
  const planAuth = persistedAuthAuthority(
    invocation.auth,
    "public reads do not create confirmation plans",
  );
  if (operation.risk === "R4") throw new Error("R4 capabilities are blocked by wrench");
  if (Buffer.byteLength(canonicalJson(invocation.input), "utf8") > MAX_PLAN_INPUT_BYTES) {
    throw new Error("planned input exceeds its size bound");
  }
  const pluginResolution = resolveCodeOwnedPluginOperation(operation, registry);
  const dispatches = pluginResolution !== null
    ? runProviderPluginPlanConformance(
        pluginResolution.operation,
        invocation.input,
      )
      : isReviewedTemplateOperation(operation)
        ? planReviewedTemplateDispatches(invocation.operationId, operation.risk, operation.reviewedTemplate)
        : operation.browser === undefined
          ? (() => {
            throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
          })()
          : expandBrowserRecipe(operation.browser, invocation.input).dispatches;
  if ((operation.risk === "R2" || operation.risk === "R3") && dispatches.length < 1) {
    throw new Error("remote writes must schedule at least one confirmed dispatch");
  }
  for (const value of Object.values(invocation.input)) {
    const files = isInputArray(value) ? value.filter(isFileInputValue) : isFileInputValue(value) ? [value] : [];
    if (files.some((file) => !isPlanBoundFile(file))) {
      throw new Error("file inputs must be copied into a private plan bundle before a confirmation plan is created");
    }
  }
  const common: InvocationPlanCommon = {
    id: crypto.randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    adapter: {
      id: invocation.manifest.id,
      version: invocation.manifest.version,
      hash: manifestHash(invocation.manifest),
    },
    operation: invocation.operationId,
    risk: operation.risk,
    sideEffect: operation.sideEffect,
    input: invocation.input,
    inputHash: sha256(canonicalJson(invocation.input)),
    dispatches,
    auth: {
      id: planAuth.id,
      hash: authHash(planAuth),
      kind: planAuth.kind,
    },
  };
  const portablePluginContract = pluginResolution?.portableIdentity ?? null;
  const plan: InvocationPlan = portablePluginContract !== null
    ? {
        ...common,
        schemaVersion: 6,
        transport: "portable-provider-plugin",
        portablePluginContract,
      }
    : isProviderOperation(operation)
      ? {
        ...common,
        schemaVersion: 3,
        transport: "provider-api",
        providerContract: {
          provider: operation.provider.provider,
          action: operation.provider.action,
          version: operation.provider.contractVersion,
          hash: providerContractHash(
            getProviderContract(operation.provider, registry),
            registry,
          ),
        },
        }
      : isWebSessionOperation(operation)
        ? {
          ...common,
          schemaVersion: 4,
          transport: "web-session-api",
          webSessionContract: {
            site: operation.webSession.site,
            action: operation.webSession.action,
            version: operation.webSession.contractVersion,
            hash: webSessionContractHash(
              getWebSessionContract(operation.webSession, registry),
              registry,
            ),
          },
          }
        : isLocalCliOperation(operation)
          ? {
            ...common,
            schemaVersion: 7,
            transport: "local-cli",
            localCliContract: localCliContractIdentity(
              operation.localCli,
              registry,
            ),
          }
        : isReviewedTemplateOperation(operation)
          ? {
            ...common,
            schemaVersion: 5,
            transport: "reviewed-template-api",
            reviewedTemplateContract: {
              version: operation.reviewedTemplate.contractVersion,
              hash: reviewedTemplateHash(operation.reviewedTemplate),
            },
            }
          : { ...common, schemaVersion: 2, transport: "browser" };
  return { digest: invocationPlanDigest(plan), plan };
}

export function messagingCompositeInputHash(
  composite: MessagingCompositeInvocationPlanV1,
): string {
  if (
    (composite.contextBindingSha256 === null)
    !== (composite.sourceConversationCoordinateSha256 === null)
  ) throw new Error("messaging composite invocation has partial context evidence");
  return sha256(canonicalJson({
    schemaVersion: composite.schemaVersion,
    format: composite.format,
    routeRef: composite.routeRef,
    contextRef: composite.contextRef,
    clientIntentSha256: composite.clientIntentSha256,
    ...(composite.contextBindingSha256 === null
      ? {}
      : {
          contextBindingSha256: composite.contextBindingSha256,
          sourceConversationCoordinateSha256:
            composite.sourceConversationCoordinateSha256,
        }),
    turnDigest: composite.turnDigest,
    contextLimit: composite.contextLimit,
    baseExactDataRevision: composite.baseExactDataRevision,
    baseLatestMessageRevision: composite.baseLatestMessageRevision,
    baseRouteStateRevision: composite.baseRouteStateRevision,
    baseMessages: composite.baseMessages,
    parts: composite.parts.map((part) => ({
      partId: part.partId,
      replyToProviderId: part.replyToProviderId,
      inputHash: part.inputHash,
    })),
  }));
}

export function createMessagingCompositeInvocationPlan(
  parts: readonly CreateMessagingCompositeInvocationPartV1[],
  metadata: CreateMessagingCompositeInvocationMetadataV1,
  now = new Date(),
  registry: ProviderPluginRegistry = providerPluginRegistry,
): StoredPlan {
  if (parts.length < 1 || parts.length > 8) {
    throw new Error("messaging composite requires one to eight exact parts");
  }
  const planned = parts.map((part) => createInvocationPlan(part.invocation, now, registry));
  const first = planned[0]!;
  for (let index = 0; index < planned.length; index += 1) {
    const candidate = planned[index]!;
    if (
      candidate.plan.risk !== "R3"
      || candidate.plan.dispatches.length !== 1
      || candidate.plan.adapter.hash !== first.plan.adapter.hash
      || candidate.plan.operation !== first.plan.operation
      || candidate.plan.auth.hash !== first.plan.auth.hash
      || candidate.plan.transport !== first.plan.transport
    ) throw new Error("messaging parts do not share one exact single-dispatch R3 action");
    const withoutPart = (plan: InvocationPlan): unknown => {
      const { id: _id, input: _input, inputHash: _inputHash, dispatches: _dispatches, ...identity } = plan;
      return identity;
    };
    if (canonicalJson(withoutPart(candidate.plan)) !== canonicalJson(withoutPart(first.plan))) {
      throw new Error("messaging action identity changed between ordered parts");
    }
  }
  const composite = parseMessagingCompositeInvocationPlan({
    schemaVersion: 1,
    format: "wrench.messaging-composite-invocation",
    ...metadata,
    previewDigest: "0".repeat(64),
    parts: parts.map((part, index) => ({
      partId: part.partId,
      text: part.text,
      replyRef: part.replyRef,
      replyToProviderId: part.replyToProviderId,
      input: planned[index]!.plan.input,
      inputHash: sha256(canonicalJson(planned[index]!.plan.input)),
    })),
  });
  const plan: InvocationPlan = {
    ...first.plan,
    inputHash: messagingCompositeInputHash(composite),
    dispatches: Object.freeze(parts.map((_part, index) => Object.freeze({
      id: `messaging.part[${index + 1}]`,
      description: `Submit ordered messaging turn part ${index + 1}`,
    }))),
    messagingComposite: composite,
  };
  return Object.freeze({ digest: invocationPlanDigest(plan), plan });
}

export function bindMessagingCompositePreviewDigest(
  stored: StoredPlan,
  previewDigest: string,
): StoredPlan {
  if (stored.plan.messagingComposite === undefined) {
    throw new Error("confirmation plan is not a messaging composite");
  }
  const digest = messagingDigest(previewDigest, "messaging preview digest");
  const plan: InvocationPlan = {
    ...stored.plan,
    messagingComposite: Object.freeze({
      ...stored.plan.messagingComposite,
      previewDigest: digest,
    }),
  };
  const rebound = Object.freeze({ digest: stored.digest, plan });
  if (invocationPlanDigest(plan) !== stored.digest) {
    throw new Error("messaging preview binding changed its confirmation digest");
  }
  return rebound;
}

const DUPLICATE_RISK_SCOPE_DOMAIN = "wrench-duplicate-risk-scope-v1\0";
const DUPLICATE_RISK_INTENT_DOMAIN = "wrench-duplicate-risk-intent-v1\0";

function planRecoveryContract(plan: InvocationPlan): RecoveryContractIdentity {
  if (plan.transport === "portable-provider-plugin") {
    return {
      transport: "portable-provider-plugin",
      identity: plan.portablePluginContract,
    };
  }
  if (plan.transport === "provider-api") {
    return {
      transport: "provider-api",
      provider: plan.providerContract.provider,
      action: plan.providerContract.action,
      version: plan.providerContract.version,
      hash: plan.providerContract.hash,
    };
  }
  if (plan.transport === "web-session-api") {
    return {
      transport: "web-session-api",
      site: plan.webSessionContract.site,
      action: plan.webSessionContract.action,
      version: plan.webSessionContract.version,
      hash: plan.webSessionContract.hash,
    };
  }
  if (plan.transport === "local-cli") {
    return {
      transport: "local-cli",
      identity: plan.localCliContract,
    };
  }
  if (plan.transport === "reviewed-template-api") {
    return {
      transport: "reviewed-template-api",
      version: 1,
      hash: plan.reviewedTemplateContract.hash,
    };
  }
  throw new Error(
    "duplicate-tolerant fresh intents require a code-owned provider transport",
  );
}

function planRunJournalContract(plan: InvocationPlan): RunJournal["contract"] {
  const contract = planRecoveryContract(plan);
  return contract.transport === "portable-provider-plugin"
    ? contract
    : contract.transport === "local-cli"
      ? contract
    : { transport: contract.transport, hash: contract.hash };
}

function planFileInputs(input: OperationInput): readonly FileInputValue[] {
  const files: FileInputValue[] = [];
  for (const value of Object.values(input)) {
    if (isInputArray(value)) {
      for (const item of value) if (isFileInputValue(item)) files.push(item);
    } else if (isFileInputValue(value)) files.push(value);
  }
  return Object.freeze(files);
}

function duplicateRiskScopeHash(plan: InvocationPlan): string {
  return sha256(`${DUPLICATE_RISK_SCOPE_DOMAIN}${canonicalJson({
    adapter: plan.adapter,
    operation: plan.operation,
    risk: plan.risk,
    input: plan.input,
    inputHash: plan.inputHash,
    dispatches: plan.dispatches,
    auth: plan.auth,
    contract: planRecoveryContract(plan),
  })}`);
}

function resolveInvocationDuplicateRisk(
  plan: InvocationPlan,
  requestedRunIds: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): InvocationDuplicateRiskV1 | undefined {
  if (requestedRunIds.length === 0) return undefined;
  if (
    requestedRunIds.length !== 1
    || new Set(requestedRunIds).size !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      requestedRunIds[0] ?? "",
    )
  ) {
    throw new Error(
      "duplicate-tolerant intent v1 requires exactly one lowercase UUID source run",
    );
  }
  if (
    plan.operation !== "posts.publish"
    || plan.risk !== "R3"
    || plan.dispatches.length !== 1
    || plan.transport !== "web-session-api"
  ) {
    throw new Error(
      "duplicate-tolerant intent v1 supports only one-dispatch authenticated-session posts.publish writes",
    );
  }
  const sourceRunId = requestedRunIds[0] as string;
  const source = readRunJournal(sourceRunId, environment);
  if (source === null) {
    throw new Error(`duplicate-risk source run ${sourceRunId} has no durable journal`);
  }
  const journal = source.journal;
  if (
    journal.operation !== "posts.publish"
    || journal.phase !== "terminal"
    || journal.status !== "indeterminate"
    || journal.dispatch.planned !== 1
    || journal.dispatch.started !== 1
    || journal.ledgerState !== "indeterminate"
    || journal.recoveryState !== "retained"
    || journal.duplicateSuccessor !== undefined
  ) {
    throw new Error(
      `duplicate-risk source run ${sourceRunId} is not an unclaimed retained terminal indeterminate posts.publish dispatch`,
    );
  }
  if (
    canonicalJson(journal.adapter) !== canonicalJson(plan.adapter)
    || journal.operation !== plan.operation
    || journal.risk !== plan.risk
    || journal.inputHash !== plan.inputHash
    || canonicalJson(journal.auth) !== canonicalJson(plan.auth)
    || canonicalJson(journal.contract)
      !== canonicalJson(planRunJournalContract(plan))
  ) {
    throw new Error(
      `duplicate-risk source run ${sourceRunId} does not match the exact adapter, auth, operation, risk, and input scope`,
    );
  }
  const receipt = readRunReceipt(sourceRunId, environment);
  if (
    canonicalJson(receipt) !== canonicalJson(runJournalReceipt(journal))
    || receipt.status !== "indeterminate"
    || receipt.planDigest !== journal.planDigest
  ) {
    throw new Error(
      `duplicate-risk source run ${sourceRunId} receipt does not match its durable journal`,
    );
  }
  const capsule = readRecoveryCapsule(
    sourceRunId,
    journal.auth.id,
    journal.auth.hash,
    environment,
  );
  if (
    capsule === null
    || capsule.runId !== sourceRunId
    || capsule.planDigest !== journal.planDigest
    || canonicalJson(capsule.adapter) !== canonicalJson(plan.adapter)
    || capsule.operation !== plan.operation
    || capsule.risk !== plan.risk
    || capsule.inputHash !== plan.inputHash
    || canonicalJson(capsule.input) !== canonicalJson(plan.input)
    || canonicalJson(capsule.auth) !== canonicalJson(plan.auth)
    || canonicalJson(capsule.contract) !== canonicalJson(planRecoveryContract(plan))
  ) {
    throw new Error(
      `duplicate-risk source run ${sourceRunId} capsule does not match the exact new intent scope`,
    );
  }
  const ledgers = matchingJournalLedgers(journal, environment);
  const ledger = ledgers[0];
  if (
    ledgers.length !== 1
    || ledger === undefined
    || ledger.entry.status !== "indeterminate"
    || canonicalJson(ledger.entry.dispatch) !== canonicalJson(journal.dispatch)
  ) {
    throw new Error(
      `duplicate-risk source run ${sourceRunId} does not retain one exact indeterminate ledger`,
    );
  }
  const sourceFiles = planFileInputs(capsule.input);
  if (
    journal.planHasAssets !== (sourceFiles.length > 0)
    || (
      sourceFiles.length > 0
      && journal.assetState !== "retained"
    )
  ) {
    throw new Error(
      `duplicate-risk source run ${sourceRunId} retained attachment state is inconsistent`,
    );
  }
  if (sourceFiles.length > 0) {
    resolvePlanAssetFiles(sourceFiles, journal.planDigest, environment);
  }
  const scopeHash = duplicateRiskScopeHash(plan);
  const intentHash = sha256(
    `${DUPLICATE_RISK_INTENT_DOMAIN}${scopeHash}\0${sourceRunId}\0${journal.planDigest}`,
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "duplicate-risk",
    sourceRunId,
    sourcePlanDigest: journal.planDigest,
    sourceReceiptHash: sha256(canonicalJson(receipt)),
    sourceJournalHash: source.contentSha256,
    sourceJournalRevision: journal.revision,
    sourceLedgerHash: ledger.contentSha256,
    sourceCapsuleHash: sha256(canonicalJson(capsule)),
    scopeHash,
    intentHash,
    successorRunId: null,
  });
}

function claimDuplicateRiskSource(
  binding: InvocationDuplicateRiskV1,
  successorRunId: string,
  environment: Readonly<Record<string, string | undefined>>,
  now: Date,
): void {
  const source = readRunJournal(binding.sourceRunId, environment);
  if (
    source === null
    || source.contentSha256 !== binding.sourceJournalHash
    || source.journal.revision !== binding.sourceJournalRevision
    || source.journal.planDigest !== binding.sourcePlanDigest
    || source.journal.duplicateSuccessor !== undefined
  ) {
    throw new Error(
      "duplicate-risk source journal changed before successor election",
    );
  }
  const receipt = readRunReceipt(binding.sourceRunId, environment);
  const capsule = readRecoveryCapsule(
    binding.sourceRunId,
    source.journal.auth.id,
    source.journal.auth.hash,
    environment,
  );
  const ledgers = matchingJournalLedgers(source.journal, environment);
  if (
    sha256(canonicalJson(receipt)) !== binding.sourceReceiptHash
    || capsule === null
    || sha256(canonicalJson(capsule)) !== binding.sourceCapsuleHash
    || ledgers.length !== 1
    || ledgers[0]?.contentSha256 !== binding.sourceLedgerHash
  ) {
    throw new Error(
      "duplicate-risk source receipt, capsule, or ledger changed before successor election",
    );
  }
  updateRunJournal(source, {
    type: "duplicate-successor-claimed",
    intentHash: binding.intentHash,
    runId: successorRunId,
    at: new Date(Math.max(
      now.getTime(),
      Date.parse(source.journal.updatedAt),
    )).toISOString(),
  }, environment);
}

/**
 * Atomically bind mutable attachment paths into a private, content-addressed
 * preview bundle and persist the encrypted plan that references that bundle.
 */
export function createAndSaveInvocationPlan(
  invocation: PreparedInvocation,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
  registry: ProviderPluginRegistry = providerPluginRegistry,
  options: CreateInvocationPlanOptions = {},
): StoredPlan {
  const checked = revalidatePreparedInvocation(invocation, registry);
  const portableIdentity = checked.invocation.portablePluginContract ?? null;
  if (portableIdentity !== null) {
    return withPortableProviderPluginCatalogLock(
      portablePluginStoreRoot(environment),
      now,
      () => {
        assertPortableOperationIdentityIsActive(
          portableIdentity,
          environment,
        );
        return createAndSaveInvocationPlanUnlocked(
          checked.invocation,
          environment,
          now,
          registry,
          options,
        );
      },
    );
  }
  return createAndSaveInvocationPlanUnlocked(
    checked.invocation,
    environment,
    now,
    registry,
    options,
  );
}

function createAndSaveInvocationPlanUnlocked(
  invocation: PreparedInvocation,
  environment: Readonly<Record<string, string | undefined>>,
  now: Date,
  registry: ProviderPluginRegistry,
  options: CreateInvocationPlanOptions,
): StoredPlan {
  const checked = revalidatePreparedInvocation(invocation, registry);
  invocation = checked.invocation;
  const operation = checked.operation;
  purgeExpiredPlans(environment);
  const staged = stagePlanAssets(invocation.input, operation.input, environment);
  try {
    const base = createInvocationPlan(
      { ...invocation, input: staged.input },
      now,
      registry,
    );
    const duplicateRisk = resolveInvocationDuplicateRisk(
      base.plan,
      options.duplicateRiskOf ?? [],
      environment,
    );
    const plan: InvocationPlan = duplicateRisk === undefined
      ? base.plan
      : { ...base.plan, duplicateRisk };
    const stored: StoredPlan = duplicateRisk === undefined
      ? base
      : { digest: invocationPlanDigest(plan), plan };
    const claim = acquireConfirmationClaim(
      stored.digest,
      crypto.randomUUID(),
      environment,
      now,
    );
    try {
      staged.commit(stored.digest);
      saveInvocationPlanWithClaim(stored, environment);
    } catch (error) {
      if (!planDigestHasRetainingJournal(stored.digest, environment)) {
        cleanupPlanAssets(stored.digest, environment);
      }
      throw error;
    } finally {
      releaseConfirmationClaim(claim, environment);
    }
    return stored;
  } catch (error) {
    staged.abort();
    throw error;
  }
}

export function saveInvocationPlan(
  stored: StoredPlan,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (stored.plan.transport === "portable-provider-plugin") {
    const portableIdentity = stored.plan.portablePluginContract;
    return withPortableProviderPluginCatalogLock(
      portablePluginStoreRoot(environment),
      new Date(),
      () => {
        assertPortableOperationIdentityIsActive(
          portableIdentity,
          environment,
        );
        return saveInvocationPlanUnlocked(stored, environment);
      },
    );
  }
  return saveInvocationPlanUnlocked(stored, environment);
}

function saveInvocationPlanUnlocked(
  stored: StoredPlan,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  repairInterruptedConfirmationClaims(environment);
  const claim = acquireConfirmationClaim(
    stored.digest,
    crypto.randomUUID(),
    environment,
    new Date(),
  );
  try {
    return saveInvocationPlanWithClaim(stored, environment);
  } finally {
    releaseConfirmationClaim(claim, environment);
  }
}

function saveInvocationPlanWithClaim(
  stored: StoredPlan,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const computed = invocationPlanDigest(stored.plan);
  if (computed !== stored.digest) throw new Error("plan digest does not match its contents");
  const path = planPath(stored.digest, environment);
  purgeExpiredPlans(environment);
  const created = createPrivateJsonIfAbsent(
    path,
    encryptPlan(stored, environment),
    { environment, privateParent: true },
  );
  if (!created.created) {
    // Plans are content-addressed and immutable. Never replace existing
    // ciphertext: a valid-looking replacement key must not be allowed to erase
    // the only evidence that the path belongs to a different key epoch.
    const existing = loadInvocationPlan(stored.digest, environment);
    if (canonicalJson(existing) !== canonicalJson(stored)) {
      throw new Error("an existing confirmation plan disagrees with its digest");
    }
  }
  return path;
}

function parsePlanInput(value: Record<string, unknown>): OperationInput {
  if (Object.keys(value).length > 100) throw new Error("stored plan input is malformed");
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch {
    throw new Error("stored plan input is malformed");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_PLAN_INPUT_BYTES) throw new Error("stored plan input exceeds its size bound");
  const output: Record<string, InputValue> = {};
  const parseValue = (candidate: unknown): Exclude<InputValue, readonly unknown[]> => {
    if (typeof candidate === "string") {
      if (candidate.includes(String.fromCharCode(0))) throw new Error("stored plan input is malformed");
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("stored plan input is malformed");
      return candidate;
    }
    if (typeof candidate === "boolean") return candidate;
    if (
      isRecord(candidate)
      && hasExactKeys(candidate, ["kind", "reference"])
      && candidate.kind === "file"
      && typeof candidate.reference === "string"
      && candidate.reference.length <= 4_096
    ) {
      const file = { kind: "file", reference: candidate.reference } as const;
      if (!isPlanBoundFile(file)) throw new Error("stored plan file reference is malformed");
      return file;
    }
    throw new Error("stored plan input is malformed");
  };
  for (const [key, candidate] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) throw new Error("stored plan input is malformed");
    if (Array.isArray(candidate)) {
      if (candidate.length > 25) throw new Error("stored plan input array is malformed");
      output[key] = candidate.map(parseValue);
    } else output[key] = parseValue(candidate);
  }
  return output;
}

function parseInvocationDuplicateRisk(
  value: unknown,
): InvocationDuplicateRiskV1 {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "sourceRunId",
      "sourcePlanDigest",
      "sourceReceiptHash",
      "sourceJournalHash",
      "sourceJournalRevision",
      "sourceLedgerHash",
      "sourceCapsuleHash",
      "scopeHash",
      "intentHash",
      "successorRunId",
    ])
    || value.schemaVersion !== 1
    || value.kind !== "duplicate-risk"
    || typeof value.sourceRunId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.sourceRunId)
    || value.successorRunId !== null
    || !Number.isSafeInteger(value.sourceJournalRevision)
    || typeof value.sourceJournalRevision !== "number"
    || value.sourceJournalRevision < 0
  ) {
    throw new Error("stored duplicate-risk binding is malformed");
  }
  const hashes = [
    value.sourcePlanDigest,
    value.sourceReceiptHash,
    value.sourceJournalHash,
    value.sourceLedgerHash,
    value.sourceCapsuleHash,
    value.scopeHash,
    value.intentHash,
  ];
  if (hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))) {
    throw new Error("stored duplicate-risk binding hashes are malformed");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "duplicate-risk",
    sourceRunId: value.sourceRunId,
    sourcePlanDigest: value.sourcePlanDigest as string,
    sourceReceiptHash: value.sourceReceiptHash as string,
    sourceJournalHash: value.sourceJournalHash as string,
    sourceJournalRevision: value.sourceJournalRevision,
    sourceLedgerHash: value.sourceLedgerHash as string,
    sourceCapsuleHash: value.sourceCapsuleHash as string,
    scopeHash: value.scopeHash as string,
    intentHash: value.intentHash as string,
    successorRunId: null,
  });
}

function messagingDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

export function parseMessagingCompositeInvocationPlan(
  value: unknown,
): MessagingCompositeInvocationPlanV1 {
  const hasContextBinding = isRecord(value)
    && Object.hasOwn(value, "contextBindingSha256");
  const hasSourceCoordinate = isRecord(value)
    && Object.hasOwn(value, "sourceConversationCoordinateSha256");
  if (hasContextBinding !== hasSourceCoordinate) {
    throw new Error("messaging composite invocation has partial context evidence");
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "format",
    "routeRef",
    "contextRef",
    "clientIntentSha256",
    ...(hasContextBinding
      ? ["contextBindingSha256", "sourceConversationCoordinateSha256"]
      : []),
    "turnDigest",
    "previewDigest",
    "contextLimit",
    "baseExactDataRevision",
    "baseLatestMessageRevision",
    "baseRouteStateRevision",
    "baseMessages",
    "recipient",
    "parts",
  ])) throw new Error("messaging composite invocation is malformed");
  if (
    hasContextBinding
    && (
      value.contextBindingSha256 === null
      || value.sourceConversationCoordinateSha256 === null
    )
  ) throw new Error("messaging composite invocation has malformed context evidence");
  const hasCurrentContextEvidence = hasContextBinding;
  if (
    value.schemaVersion !== 1
    || value.format !== "wrench.messaging-composite-invocation"
    || typeof value.routeRef !== "string"
    || !/^wmroute_[A-Za-z0-9_-]{22}$/u.test(value.routeRef)
    || typeof value.contextRef !== "string"
    || !/^wmcontext_[A-Za-z0-9_-]{22}$/u.test(value.contextRef)
    || typeof value.contextLimit !== "number"
    || !Number.isSafeInteger(value.contextLimit)
    || value.contextLimit < 1
    || value.contextLimit > 200
    || !Array.isArray(value.baseMessages)
    || Object.getPrototypeOf(value.baseMessages) !== Array.prototype
    || Object.keys(value.baseMessages).length !== value.baseMessages.length
    || value.baseMessages.length > value.contextLimit
    || value.baseMessages.length > 200
    || !isRecord(value.recipient)
    || !hasExactKeys(value.recipient, ["network", "conversation"])
    || typeof value.recipient.network !== "string"
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.recipient.network)
    || !isRecord(value.recipient.conversation)
    || !hasExactKeys(value.recipient.conversation, ["kind", "title", "participantCount"])
    || value.recipient.conversation.kind !== "single"
      && value.recipient.conversation.kind !== "group"
      && value.recipient.conversation.kind !== "unknown"
    || value.recipient.conversation.title !== null
      && (typeof value.recipient.conversation.title !== "string"
        || Buffer.byteLength(value.recipient.conversation.title, "utf8") > 4_096
        || /[\0\r\n]/u.test(value.recipient.conversation.title))
    || typeof value.recipient.conversation.participantCount !== "number"
    || !Number.isSafeInteger(value.recipient.conversation.participantCount)
    || value.recipient.conversation.participantCount < 0
    || value.recipient.conversation.participantCount > 10_000
    || !Array.isArray(value.parts)
    || Object.getPrototypeOf(value.parts) !== Array.prototype
    || Object.keys(value.parts).length !== value.parts.length
    || value.parts.length < 1
    || value.parts.length > 8
  ) throw new Error("messaging composite invocation is malformed");
  const seenBaseMessageIds = new Set<string>();
  let previousBaseMessageSortKey: string | null = null;
  const baseMessages = value.baseMessages.map((candidate, index) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      "providerMessageId", "providerRevision", "orderedAt", "messageSha256",
    ])) throw new Error("messaging composite base message is malformed");
    if (
      typeof candidate.providerMessageId !== "string"
      || candidate.providerMessageId.length < 1
      || Buffer.byteLength(candidate.providerMessageId, "utf8") > 4_096
      || /[\0\r\n]/u.test(candidate.providerMessageId)
      || seenBaseMessageIds.has(candidate.providerMessageId)
      || candidate.providerRevision !== null
        && (typeof candidate.providerRevision !== "string"
          || candidate.providerRevision.length < 1
          || Buffer.byteLength(candidate.providerRevision, "utf8") > 4_096
          || /[\0\r\n]/u.test(candidate.providerRevision))
      || candidate.orderedAt !== null
        && (typeof candidate.orderedAt !== "string"
          || candidate.orderedAt.length < 1
          || candidate.orderedAt.length > 64
          || !Number.isFinite(Date.parse(candidate.orderedAt))
          || new Date(candidate.orderedAt).toISOString() !== candidate.orderedAt)
    ) throw new Error(`messaging composite base message ${index + 1} is malformed`);
    const providerMessageId = candidate.providerMessageId;
    const orderedAt = candidate.orderedAt as string | null;
    const sortKey = `${orderedAt ?? ""}\0${providerMessageId}`;
    if (previousBaseMessageSortKey !== null && sortKey <= previousBaseMessageSortKey) {
      throw new Error("messaging composite base messages are not in canonical order");
    }
    previousBaseMessageSortKey = sortKey;
    seenBaseMessageIds.add(providerMessageId);
    return Object.freeze({
      providerMessageId,
      providerRevision: candidate.providerRevision as string | null,
      orderedAt,
      messageSha256: messagingDigest(
        candidate.messageSha256,
        "messaging composite base message hash",
      ),
    });
  });
  const seen = new Set<string>();
  const parts = value.parts.map((candidate, index): MessagingCompositeInvocationPartV1 => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      "partId", "text", "replyRef", "replyToProviderId", "input", "inputHash",
    ])) throw new Error("messaging composite invocation part is malformed");
    if (
      typeof candidate.partId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(candidate.partId)
      || seen.has(candidate.partId)
      || typeof candidate.text !== "string"
      || candidate.text.length < 1
      || Buffer.byteLength(candidate.text, "utf8") > 65_536
      || candidate.replyRef !== null
        && (typeof candidate.replyRef !== "string" || !/^wmreply_[A-Za-z0-9_-]{22}$/u.test(candidate.replyRef))
      || candidate.replyToProviderId !== null
        && (typeof candidate.replyToProviderId !== "string"
          || candidate.replyToProviderId.length < 1
          || Buffer.byteLength(candidate.replyToProviderId, "utf8") > 4_096
          || /[\0\r\n]/u.test(candidate.replyToProviderId))
      || !isRecord(candidate.input)
    ) throw new Error(`messaging composite invocation part ${index + 1} is malformed`);
    seen.add(candidate.partId);
    const input = parsePlanInput(candidate.input);
    const inputHash = messagingDigest(candidate.inputHash, "messaging composite invocation part input hash");
    if (sha256(canonicalJson(input)) !== inputHash) {
      throw new Error("messaging composite invocation part input hash disagrees");
    }
    return Object.freeze({
      partId: candidate.partId,
      text: candidate.text,
      replyRef: candidate.replyRef as string | null,
      replyToProviderId: candidate.replyToProviderId as string | null,
      input,
      inputHash,
    });
  });
  const parsed: MessagingCompositeInvocationPlanV1 = Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-composite-invocation",
    routeRef: value.routeRef,
    contextRef: value.contextRef,
    clientIntentSha256: messagingDigest(value.clientIntentSha256, "messaging composite client intent"),
    contextBindingSha256: hasCurrentContextEvidence
      ? messagingDigest(
          value.contextBindingSha256,
          "messaging composite context binding",
        )
      : null,
    sourceConversationCoordinateSha256: hasCurrentContextEvidence
      ? messagingDigest(
          value.sourceConversationCoordinateSha256,
          "messaging composite source conversation coordinate",
        )
      : null,
    turnDigest: messagingDigest(value.turnDigest, "messaging composite turn digest"),
    previewDigest: messagingDigest(value.previewDigest, "messaging composite preview digest"),
    contextLimit: value.contextLimit,
    baseExactDataRevision: messagingDigest(value.baseExactDataRevision, "messaging composite base data revision"),
    baseLatestMessageRevision: messagingDigest(value.baseLatestMessageRevision, "messaging composite base message revision"),
    baseRouteStateRevision: messagingDigest(value.baseRouteStateRevision, "messaging composite base route-state revision"),
    baseMessages: Object.freeze(baseMessages),
    recipient: Object.freeze({
      network: value.recipient.network,
      conversation: Object.freeze({
        kind: value.recipient.conversation.kind,
        title: value.recipient.conversation.title as string | null,
        participantCount: value.recipient.conversation.participantCount,
      }),
    }),
    parts: Object.freeze(parts),
  });
  const exactTurnDigest = sha256(canonicalJson({
    schemaVersion: 1,
    format: "wrench.messaging-turn",
    clientIntentSha256: parsed.clientIntentSha256,
    routeRef: parsed.routeRef,
    contextRef: parsed.contextRef,
    parts: parsed.parts.map((part) => ({
      partId: part.partId,
      text: part.text,
      replyRef: part.replyRef,
    })),
  }));
  if (exactTurnDigest !== parsed.turnDigest) {
    throw new Error("messaging composite turn digest disagrees with its exact parts");
  }
  return parsed;
}

function parseStoredPlan(value: unknown): StoredPlan {
  if (!isRecord(value) || !hasExactKeys(value, ["digest", "plan"]) || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest) || !isRecord(value.plan)) {
    throw new Error("stored plan is malformed");
  }
  const raw = value.plan;
  const providerPlan = raw.schemaVersion === 3;
  const webSessionPlan = raw.schemaVersion === 4;
  const reviewedTemplatePlan = raw.schemaVersion === 5;
  const portablePluginPlan = raw.schemaVersion === 6;
  const localCliPlan = raw.schemaVersion === 7;
  const planKeys = ["schemaVersion", "id", "createdAt", "expiresAt", "adapter", "operation", "risk", "sideEffect", "input", "inputHash", "dispatches", "auth", "transport"];
  if (providerPlan) planKeys.push("providerContract");
  if (webSessionPlan) planKeys.push("webSessionContract");
  if (reviewedTemplatePlan) planKeys.push("reviewedTemplateContract");
  if (portablePluginPlan) planKeys.push("portablePluginContract");
  if (localCliPlan) planKeys.push("localCliContract");
  if (Object.hasOwn(raw, "duplicateRisk")) planKeys.push("duplicateRisk");
  if (Object.hasOwn(raw, "messagingComposite")) planKeys.push("messagingComposite");
  if (!hasExactKeys(raw, planKeys)) {
    throw new Error("stored plan is malformed");
  }
  const { id, createdAt, expiresAt, operation, risk, sideEffect, inputHash, transport } = raw;
  if (
    (
      raw.schemaVersion !== 2
      && raw.schemaVersion !== 3
      && raw.schemaVersion !== 4
      && raw.schemaVersion !== 5
      && raw.schemaVersion !== 6
      && raw.schemaVersion !== 7
    )
    || typeof id !== "string"
    || !/^[0-9a-f-]{36}$/u.test(id)
    || typeof createdAt !== "string"
    || !Number.isFinite(Date.parse(createdAt))
    || typeof expiresAt !== "string"
    || !Number.isFinite(Date.parse(expiresAt))
    || !isProviderPluginOperationName(operation)
    || typeof risk !== "string"
    || !operationRisks.includes(risk as OperationRisk)
    || typeof sideEffect !== "string"
    || sideEffect.length < 1
    || sideEffect.length > 500
    || typeof inputHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(inputHash)
    || (raw.schemaVersion === 2
      ? transport !== "browser"
      : raw.schemaVersion === 3
        ? transport !== "provider-api"
        : raw.schemaVersion === 4
          ? transport !== "web-session-api"
          : raw.schemaVersion === 5
            ? transport !== "reviewed-template-api"
            : raw.schemaVersion === 6
              ? transport !== "portable-provider-plugin"
              : transport !== "local-cli")
    || !isRecord(raw.adapter)
    || !isRecord(raw.auth)
    || !isRecord(raw.input)
    || !Array.isArray(raw.dispatches)
  ) throw new Error("stored plan is malformed");
  const adapter = raw.adapter;
  if (
    !hasExactKeys(adapter, ["id", "version", "hash"])
    || typeof adapter.id !== "string"
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(adapter.id)
    || typeof adapter.version !== "string"
    || typeof adapter.hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(adapter.hash)
  ) throw new Error("stored plan adapter is malformed");
  const auth = raw.auth;
  if (
    !hasExactKeys(auth, ["id", "hash", "kind"])
    || typeof auth.id !== "string"
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(auth.id)
    || typeof auth.hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(auth.hash)
    || (auth.kind !== "cookie-source" && auth.kind !== "cookies-file" && auth.kind !== "browser-profile" && auth.kind !== "oauth-token-file" && auth.kind !== "linked-device-store")
  ) throw new Error("stored plan auth is malformed");
  let providerContract: Extract<InvocationPlan, { readonly schemaVersion: 3 }>["providerContract"] | null = null;
  let webSessionContract: Extract<InvocationPlan, { readonly schemaVersion: 4 }>["webSessionContract"] | null = null;
  let reviewedTemplateContract: Extract<InvocationPlan, { readonly schemaVersion: 5 }>["reviewedTemplateContract"] | null = null;
  let portablePluginContract: PortableOperationIdentityV1 | null = null;
  let localCliContract: LocalCliContractIdentityV1 | null = null;
  if (providerPlan) {
    const candidate = raw.providerContract;
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ["provider", "action", "version", "hash"])
      || !isProviderPluginSurfaceId(candidate.provider)
      || !isProviderPluginOperationName(candidate.action)
      || typeof candidate.version !== "number"
      || !Number.isSafeInteger(candidate.version)
      || candidate.version < 1
      || candidate.version > 1_000_000
      || typeof candidate.hash !== "string"
      || !/^[a-f0-9]{64}$/u.test(candidate.hash)
    ) throw new Error("stored provider contract is malformed");
    providerContract = {
      provider: candidate.provider,
      action: candidate.action,
      version: candidate.version,
      hash: candidate.hash,
    };
  }
  if (webSessionPlan) {
    const candidate = raw.webSessionContract;
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ["site", "action", "version", "hash"])
      || !isProviderPluginSurfaceId(candidate.site)
      || !isProviderPluginOperationName(candidate.action)
      || typeof candidate.version !== "number"
      || !Number.isSafeInteger(candidate.version)
      || candidate.version < 1
      || candidate.version > 1_000_000
      || typeof candidate.hash !== "string"
      || !/^[a-f0-9]{64}$/u.test(candidate.hash)
    ) throw new Error("stored authenticated web contract is malformed");
    webSessionContract = {
      site: candidate.site,
      action: candidate.action,
      version: candidate.version,
      hash: candidate.hash,
    };
  }
  if (reviewedTemplatePlan) {
    const candidate = raw.reviewedTemplateContract;
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ["version", "hash"])
      || candidate.version !== 1
      || typeof candidate.hash !== "string"
      || !/^[a-f0-9]{64}$/u.test(candidate.hash)
    ) throw new Error("stored reviewed template contract is malformed");
    reviewedTemplateContract = { version: 1, hash: candidate.hash };
  }
  if (portablePluginPlan) {
    portablePluginContract = parsePortableOperationIdentityV1(
      raw.portablePluginContract,
    );
    if (
      portablePluginContract.adapterId !== adapter.id
      || portablePluginContract.operation !== operation
    ) {
      throw new Error(
        "stored portable plugin contract does not match its plan route",
      );
    }
  }
  if (localCliPlan) {
    localCliContract = parseLocalCliContractIdentityV1(raw.localCliContract);
    if (localCliContract.action !== operation) {
      throw new Error("stored local CLI contract does not match its plan route");
    }
  }
  const input = parsePlanInput(raw.input);
  if (raw.dispatches.length > 25) throw new Error("stored plan dispatch schedule is malformed");
  if ((risk === "R2" || risk === "R3") && raw.dispatches.length < 1) {
    throw new Error("stored write plan has no dispatch schedule");
  }
  const dispatches: BrowserDispatchPlan[] = [];
  const dispatchIds = new Set<string>();
  for (const candidate of raw.dispatches) {
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ["id", "description"])
      || typeof candidate.id !== "string"
      || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*(?:\[[1-9][0-9]*\])?$/u.test(candidate.id)
      || candidate.id.length > 80
      || dispatchIds.has(candidate.id)
      || typeof candidate.description !== "string"
      || candidate.description.length < 1
      || candidate.description.length > 500
    ) throw new Error("stored plan dispatch schedule is malformed");
    dispatchIds.add(candidate.id);
    dispatches.push({ id: candidate.id, description: candidate.description });
  }
  const common: InvocationPlanCommon = {
    id,
    createdAt,
    expiresAt,
    adapter: { id: adapter.id, version: adapter.version, hash: adapter.hash },
    operation,
    risk: risk as OperationRisk,
    sideEffect,
    input,
    inputHash,
    dispatches,
    auth: { id: auth.id, hash: auth.hash, kind: auth.kind },
    ...(Object.hasOwn(raw, "duplicateRisk")
      ? { duplicateRisk: parseInvocationDuplicateRisk(raw.duplicateRisk) }
      : {}),
    ...(Object.hasOwn(raw, "messagingComposite")
      ? { messagingComposite: parseMessagingCompositeInvocationPlan(raw.messagingComposite) }
      : {}),
  };
  if (
    common.duplicateRisk !== undefined
    && (
      operation !== "posts.publish"
      || risk !== "R3"
      || dispatches.length !== 1
      || transport !== "web-session-api"
    )
  ) {
    throw new Error("stored duplicate-risk plan is outside the supported v1 scope");
  }
  if (common.messagingComposite !== undefined) {
    const composite = common.messagingComposite;
    if (
      risk !== "R3"
      || dispatches.length !== composite.parts.length
      || dispatches.some((dispatch, index) =>
        dispatch.id !== `messaging.part[${index + 1}]`
        || dispatch.description !== `Submit ordered messaging turn part ${index + 1}`)
      || canonicalJson(input) !== canonicalJson(composite.parts[0]!.input)
      || inputHash !== messagingCompositeInputHash(composite)
      || common.duplicateRisk !== undefined
    ) throw new Error("stored messaging composite has contradictory invocation state");
  }
  const plan: InvocationPlan =
    localCliPlan && localCliContract !== null
      ? {
          ...common,
          schemaVersion: 7,
          transport: "local-cli",
          localCliContract,
        }
    : portablePluginPlan && portablePluginContract !== null
      ? {
          ...common,
          schemaVersion: 6,
          transport: "portable-provider-plugin",
          portablePluginContract,
        }
      : providerPlan && providerContract !== null
        ? { ...common, schemaVersion: 3, transport: "provider-api", providerContract }
        : webSessionPlan && webSessionContract !== null
          ? { ...common, schemaVersion: 4, transport: "web-session-api", webSessionContract }
          : reviewedTemplatePlan && reviewedTemplateContract !== null
            ? { ...common, schemaVersion: 5, transport: "reviewed-template-api", reviewedTemplateContract }
            : { ...common, schemaVersion: 2, transport: "browser" };
  if (invocationPlanDigest(plan) !== value.digest) throw new Error("stored plan failed its digest check");
  return { digest: value.digest, plan };
}

export function loadInvocationPlan(
  digest: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): StoredPlan {
  const stored = decryptPlan(
    JSON.parse(readRegularFile(planPath(digest, environment), MAX_ENCRYPTED_PLAN_BYTES, "encrypted plan")) as unknown,
    environment,
  );
  if (stored.digest !== digest) throw new Error("stored plan filename does not match its digest");
  return stored;
}

export function purgeExpiredPlans(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): number {
  repairInterruptedConfirmationClaims(environment);
  const directory = planDirectory(environment);
  let removed = 0;
  for (const entry of listPrivateStateDirectory(directory, environment)) {
    if (entry.kind !== "file" || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const stored = decryptPlan(JSON.parse(readRegularFile(path, MAX_ENCRYPTED_PLAN_BYTES, "encrypted plan")) as unknown, environment);
      if (Date.parse(stored.plan.expiresAt) < now.getTime()) {
        const claim = acquireConfirmationClaim(
          stored.digest,
          crypto.randomUUID(),
          environment,
          now,
        );
        try {
          // The fixed digest claim serializes expiry, cancellation, and
          // confirmation before the plan or its shared asset bundle changes.
          if (removePrivateStateFile(path, environment)) {
            if (
              !planDigestHasRetainingJournal(
                stored.digest,
                environment,
              )
            ) {
              cleanupPlanAssets(stored.digest, environment);
            }
            removed += 1;
          }
        } finally {
          releaseConfirmationClaim(claim, environment);
        }
      }
    } catch {
      // Leave malformed files for explicit inspection; never delete an unresolved path.
    }
  }
  try {
    purgeOrphanedPlanAssets(
      () => protectedPlanAssetDigests(environment),
      environment,
      now,
    );
  } catch {
    // Unknown ownership is never evidence of orphanhood.
  }
  return removed;
}

function protectedPlanAssetDigests(
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  const protectedDigests = new Set<string>();
  for (const entry of listPrivateStateDirectory(planDirectory(environment), environment)) {
    const match = /^([a-f0-9]{64})(?:\.claim)?\.json$/u.exec(
      entry.kind === "file" ? entry.name : "",
    );
    if (match?.[1] !== undefined) protectedDigests.add(match[1]);
  }
  const runDirectory = join(wrenchStateHome(environment), "runs");
  for (const entry of listPrivateStateDirectory(runDirectory, environment)) {
    const match = /^([0-9a-f-]{36})\.json$/u.exec(entry.kind === "file" ? entry.name : "");
    if (match?.[1] === undefined) continue;
    try {
      const receipt = readRunReceipt(match[1], environment);
      if (receiptProtectsPlanAssets(receipt) && receipt.planDigest !== null) {
        protectedDigests.add(receipt.planDigest);
      }
    } catch {
      throw new Error(
        "invalid run receipts make plan-asset ownership unresolved",
      );
    }
  }
  for (const entry of listRunJournalSnapshots(environment)) {
    if ("invalid" in entry) {
      throw new Error(
        "invalid run journals make plan-asset ownership unresolved",
      );
    }
    if (
      entry.journal.planHasAssets
      && (
        entry.journal.planState === "available"
        ||
        entry.journal.assetState === "bound"
        || entry.journal.assetState === "retained"
      )
    ) {
      protectedDigests.add(entry.journal.planDigest);
    }
  }
  return protectedDigests;
}

function planDigestHasRetainingJournal(
  digest: string,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  for (const entry of listRunJournalSnapshots(environment)) {
    if ("invalid" in entry) return true;
    if (
      entry.journal.planDigest === digest
      && entry.journal.planHasAssets
      && (
        entry.journal.planState === "available"
        || entry.journal.assetState === "bound"
        || entry.journal.assetState === "retained"
      )
    ) {
      return true;
    }
  }
  return false;
}

function receiptProtectsPlanAssets(receipt: RunReceipt): boolean {
  return receipt.planDigest !== null
    && (
      receipt.status === "pending"
      || receipt.status === "partial"
      || receipt.status === "indeterminate"
      || receipt.error?.includes("private browser artifacts were preserved") === true
    );
}

export type ListedInvocationPlan = {
  readonly digest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly adapter: { readonly id: string; readonly version: string };
  readonly operation: string;
  readonly risk: OperationRisk;
  readonly auth: { readonly id: string; readonly kind: WrenchAuth["kind"] };
} | { readonly digest: string; readonly invalid: true };

export function listInvocationPlans(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly ListedInvocationPlan[] {
  const directory = planDirectory(environment);
  const plans = listPrivateStateDirectory(directory, environment)
    .filter((entry) => entry.kind === "file" && /^[a-f0-9]{64}\.json$/u.test(entry.name))
    .map((entry): ListedInvocationPlan => {
      const digest = entry.name.slice(0, -5);
      try {
        const stored = loadInvocationPlan(digest, environment);
        return {
          digest,
          createdAt: stored.plan.createdAt,
          expiresAt: stored.plan.expiresAt,
          adapter: { id: stored.plan.adapter.id, version: stored.plan.adapter.version },
          operation: stored.plan.operation,
          risk: stored.plan.risk,
          auth: { id: stored.plan.auth.id, kind: stored.plan.auth.kind },
        };
      } catch {
        return { digest, invalid: true };
      }
    });
  return plans.sort((left, right) => {
    const leftTime = "createdAt" in left ? Date.parse(left.createdAt) : Number.NEGATIVE_INFINITY;
    const rightTime = "createdAt" in right ? Date.parse(right.createdAt) : Number.NEGATIVE_INFINITY;
    return rightTime - leftTime || left.digest.localeCompare(right.digest);
  });
}

export function cancelInvocationPlan(
  digest: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  repairInterruptedConfirmationClaims(environment);
  const claim = acquireConfirmationClaim(
    digest,
    crypto.randomUUID(),
    environment,
    new Date(),
  );
  try {
    const removedPlan = removePrivateStateFile(
      planPath(digest, environment),
      environment,
    );
    if (!removedPlan) return false;
    if (!planDigestHasRetainingJournal(digest, environment)) {
      cleanupPlanAssets(digest, environment);
    }
    return true;
  } finally {
    releaseConfirmationClaim(claim, environment);
  }
}

function validateFreshPlan(
  stored: StoredPlan,
  environment: Readonly<Record<string, string | undefined>>,
  now: Date,
  registry: ProviderPluginRegistry,
  loadManifest: typeof loadInstalledManifest = loadInstalledManifest,
): PreparedInvocation {
  const plan = stored.plan;
  const expiry = Date.parse(plan.expiresAt);
  if (!Number.isFinite(expiry) || expiry < now.getTime()) throw new Error("confirmation plan expired; preview the action again");
  const manifestResult = loadManifest(plan.adapter.id, environment);
  if (!manifestResult.ok) throw new Error(`adapter ${plan.adapter.id} is invalid: ${manifestResult.issues.join("; ")}`);
  const manifest = manifestResult.value;
  if (manifest.version !== plan.adapter.version || manifestHash(manifest) !== plan.adapter.hash) {
    throw new Error("adapter changed after preview; preview the action again");
  }
  const operation = manifest.operations[plan.operation];
  if (operation === undefined || operation.risk !== plan.risk || operation.sideEffect !== plan.sideEffect) {
    throw new Error("operation changed after preview; preview the action again");
  }
  const rawInput = Object.fromEntries(Object.entries(plan.input).map(([key, value]) => [
    key,
    isInputArray(value)
      ? value.map((item) => isFileInputValue(item) ? item.reference : item)
      : isFileInputValue(value) ? value.reference : value,
  ]));
  const inputResult = validateOperationInput(operation.input, rawInput, manifest.origins);
  const platformInput = inputResult.ok
    ? validatePlatformOperationInput(manifest, plan.operation, inputResult.value)
    : inputResult;
  const plannedInputIsCurrent = plan.messagingComposite === undefined
    ? sha256(canonicalJson(platformInput.ok ? platformInput.value : null)) === plan.inputHash
    : platformInput.ok
      && canonicalJson(platformInput.value) === canonicalJson(plan.messagingComposite.parts[0]!.input)
      && messagingCompositeInputHash(plan.messagingComposite) === plan.inputHash;
  if (!platformInput.ok || !plannedInputIsCurrent) {
    throw new Error("planned input failed validation; preview the action again");
  }
  const pluginResolution = resolveCodeOwnedPluginOperation(operation, registry);
  const dispatches = plan.messagingComposite !== undefined
    ? (() => {
        if (pluginResolution === null) {
          throw new Error("messaging composite action lost its provider plugin binding");
        }
        for (const part of plan.messagingComposite.parts) {
          const raw = Object.fromEntries(Object.entries(part.input).map(([key, value]) => [
            key,
            isInputArray(value)
              ? value.map((item) => isFileInputValue(item) ? item.reference : item)
              : isFileInputValue(value) ? value.reference : value,
          ]));
          const checked = validateOperationInput(operation.input, raw, manifest.origins);
          const normalized = checked.ok
            ? validatePlatformOperationInput(manifest, plan.operation, checked.value)
            : checked;
          if (
            !normalized.ok
            || canonicalJson(normalized.value) !== canonicalJson(part.input)
            || pluginResolution.operation.validateInput(normalized.value).length > 0
            || runProviderPluginPlanConformance(pluginResolution.operation, normalized.value).length !== 1
          ) throw new Error("messaging composite part changed validity; preview the action again");
        }
        return plan.messagingComposite.parts.map((_part, index) => ({
          id: `messaging.part[${index + 1}]`,
          description: `Submit ordered messaging turn part ${index + 1}`,
        }));
      })()
    : pluginResolution !== null
      ? runProviderPluginPlanConformance(
          pluginResolution.operation,
          platformInput.value,
        )
      : isReviewedTemplateOperation(operation)
      ? planReviewedTemplateDispatches(plan.operation, operation.risk, operation.reviewedTemplate)
        : operation.browser === undefined
          ? (() => {
            throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
          })()
          : expandBrowserRecipe(operation.browser, platformInput.value).dispatches;
  if (canonicalJson(dispatches) !== canonicalJson(plan.dispatches)) {
    throw new Error("planned dispatch schedule changed; preview the action again");
  }
  const currentPortablePluginContract =
    pluginResolution?.portableIdentity ?? null;
  if (currentPortablePluginContract !== null) {
    if (
      plan.schemaVersion !== 6
      || plan.transport !== "portable-provider-plugin"
      || canonicalJson(plan.portablePluginContract)
        !== canonicalJson(currentPortablePluginContract)
    ) {
      throw new Error(
        "portable provider plugin artifact or operation changed after preview; preview the action again",
      );
    }
  } else if (isProviderOperation(operation)) {
    if (plan.schemaVersion !== 3 || plan.transport !== "provider-api") {
      throw new Error("operation transport changed after preview; preview the action again");
    }
    const contract = getProviderContract(operation.provider, registry);
    if (
      plan.providerContract.provider !== operation.provider.provider
      || plan.providerContract.action !== operation.provider.action
      || plan.providerContract.version !== operation.provider.contractVersion
      || plan.providerContract.hash !== providerContractHash(contract, registry)
    ) throw new Error("official provider contract changed after preview; preview the action again");
    const issues = pluginResolution?.operation.validateInput(platformInput.value)
      ?? ["provider plugin operation disappeared after preview"];
    if (issues.length > 0) throw new Error("planned provider input changed validity; preview the action again");
  } else if (isWebSessionOperation(operation)) {
    if (plan.schemaVersion !== 4 || plan.transport !== "web-session-api") {
      throw new Error("operation transport changed after preview; preview the action again");
    }
    const contract = getWebSessionContract(operation.webSession, registry);
    if (contract.state !== "observed" || contract.risk !== operation.risk) {
      throw new Error("authenticated web contract is no longer observed; preview the action again");
    }
    if (
      plan.webSessionContract.site !== operation.webSession.site
      || plan.webSessionContract.action !== operation.webSession.action
      || plan.webSessionContract.version !== operation.webSession.contractVersion
      || plan.webSessionContract.hash !== webSessionContractHash(contract, registry)
    ) throw new Error("authenticated web contract changed after preview; preview the action again");
  } else if (isLocalCliOperation(operation)) {
    if (plan.schemaVersion !== 7 || plan.transport !== "local-cli") {
      throw new Error("operation transport changed after preview; preview the action again");
    }
    const currentIdentity = localCliContractIdentity(operation.localCli, registry);
    if (canonicalJson(plan.localCliContract) !== canonicalJson(currentIdentity)) {
      throw new Error("local CLI tool or contract changed after preview; preview the action again");
    }
  } else if (isReviewedTemplateOperation(operation)) {
    if (plan.schemaVersion !== 5 || plan.transport !== "reviewed-template-api") {
      throw new Error("operation transport changed after preview; preview the action again");
    }
    if (
      plan.reviewedTemplateContract.version !== operation.reviewedTemplate.contractVersion
      || plan.reviewedTemplateContract.hash !== reviewedTemplateHash(operation.reviewedTemplate)
    ) throw new Error("reviewed template contract changed after preview; preview the action again");
  } else if (plan.schemaVersion !== 2 || plan.transport !== "browser") {
    throw new Error("operation transport changed after preview; preview the action again");
  }
  const auth = loadAuth(plan.auth.id, environment);
  if (auth.kind !== plan.auth.kind || authHash(auth) !== plan.auth.hash) {
    throw new Error("authentication selection changed after preview; preview the action again");
  }
  if (pluginResolution !== null) {
    try {
      requireProviderPluginAuth(pluginResolution.binding, auth);
    } catch {
      throw new Error(
        "provider plugin authentication changed after preview; preview the action again",
      );
    }
  } else if (isReviewedTemplateOperation(operation)) {
    if (!isCookieCapableWebAuth(auth)) {
      throw new Error("reviewed template authentication changed after preview; preview the action again");
    }
  } else if (auth.kind === "oauth-token-file") {
    throw new Error("browser authentication changed after preview; preview the action again");
  }
  return revalidatePreparedInvocation({
    manifest,
    operationId: plan.operation,
    input: platformInput.value,
    auth,
  }, registry).invocation;
}

type LedgerEntry = {
  readonly schemaVersion: 2 | 3;
  readonly keyHash: string;
  readonly adapterHash: string;
  readonly authHash: string;
  readonly inputHash: string;
  readonly planDigest: string;
  readonly status: "pending" | "succeeded" | "partial" | "indeterminate";
  readonly dispatch: RunReceipt["dispatch"];
  readonly runId: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly duplicateIntentHash?: string;
};

type LedgerSnapshot = {
  readonly path: string;
  readonly entry: LedgerEntry;
  readonly contentSha256: string;
};

const MAX_LEDGER_BYTES = 64 * 1024;

function isDispatchProgress(value: unknown): value is RunReceipt["dispatch"] {
  if (!isRecord(value) || !hasExactKeys(value, ["planned", "started", "verified"])) return false;
  const { planned, started, verified } = value;
  return Number.isSafeInteger(planned)
    && typeof planned === "number"
    && planned >= 0
    && planned <= 25
    && Number.isSafeInteger(started)
    && typeof started === "number"
    && started >= 0
    && started <= planned
    && Number.isSafeInteger(verified)
    && typeof verified === "number"
    && verified >= 0
    && verified <= started;
}

function ledgerPath(
  adapterHash: string,
  authHashValue: string,
  operationId: string,
  inputHash: string,
  environment: Readonly<Record<string, string | undefined>>,
  duplicateIntentHash?: string,
): string {
  const bucket = sha256(
    duplicateIntentHash === undefined
      ? `${adapterHash}\0${authHashValue}\0${operationId}\0${inputHash}`
      : `${adapterHash}\0${authHashValue}\0${operationId}\0${inputHash}\0duplicate-intent-v1\0${duplicateIntentHash}`,
  );
  return join(wrenchStateHome(environment), "idempotency", bucket.slice(0, 2), `${bucket}.json`);
}

function parseLedger(value: unknown): LedgerEntry {
  if (!isRecord(value)) {
    throw new Error("idempotency ledger is malformed");
  }
  const record = value;
  const legacy = record.schemaVersion === 1;
  const duplicateIntent = record.schemaVersion === 3;
  const keys = legacy
    ? ["schemaVersion", "keyHash", "adapterHash", "authHash", "inputHash", "planDigest", "status", "runId", "updatedAt", "expiresAt"]
    : [
        "schemaVersion", "keyHash", "adapterHash", "authHash", "inputHash", "planDigest", "status", "dispatch", "runId", "updatedAt", "expiresAt",
        ...(duplicateIntent ? ["duplicateIntentHash"] : []),
      ];
  if (!hasExactKeys(record, keys)) throw new Error("idempotency ledger is malformed");
  const legacyStatus = record.status === "pending" || record.status === "succeeded" || record.status === "indeterminate";
  const currentStatus = legacyStatus || record.status === "partial";
  const dispatch: RunReceipt["dispatch"] = legacy
    ? record.status === "succeeded"
      ? { planned: 1, started: 1, verified: 1 }
      : { planned: 1, started: 1, verified: 0 }
    : isDispatchProgress(record.dispatch) ? record.dispatch : { planned: -1, started: -1, verified: -1 };
  if (
    (!legacy && record.schemaVersion !== 2 && record.schemaVersion !== 3)
    || typeof record.keyHash !== "string"
    || typeof record.adapterHash !== "string"
    || typeof record.authHash !== "string"
    || typeof record.inputHash !== "string"
    || typeof record.planDigest !== "string"
    || !currentStatus
    || !isDispatchProgress(dispatch)
    || typeof record.runId !== "string"
    || typeof record.updatedAt !== "string"
    || typeof record.expiresAt !== "string"
  ) throw new Error("idempotency ledger is malformed");
  if (
    duplicateIntent
    && (
      typeof record.duplicateIntentHash !== "string"
      || !/^[a-f0-9]{64}$/u.test(record.duplicateIntentHash)
      || record.keyHash !== record.duplicateIntentHash
    )
  ) throw new Error("duplicate-intent ledger is malformed");
  if (![record.keyHash, record.adapterHash, record.authHash, record.inputHash, record.planDigest].every((candidate) => /^[a-f0-9]{64}$/u.test(candidate))) {
    throw new Error("idempotency ledger hashes are malformed");
  }
  if (!/^[0-9a-f-]{36}$/u.test(record.runId) || !Number.isFinite(Date.parse(record.updatedAt)) || !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new Error("idempotency ledger metadata is malformed");
  }
  return {
    schemaVersion: duplicateIntent ? 3 : 2,
    keyHash: record.keyHash,
    adapterHash: record.adapterHash,
    authHash: record.authHash,
    inputHash: record.inputHash,
    planDigest: record.planDigest,
    status: record.status as LedgerEntry["status"],
    dispatch,
    runId: record.runId,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ...(duplicateIntent
      ? { duplicateIntentHash: record.duplicateIntentHash as string }
      : {}),
  };
}

function acquireLedger(
  path: string,
  entry: LedgerEntry,
  environment: Readonly<Record<string, string | undefined>>,
  now: Date,
):
  | { readonly acquired: true; readonly snapshot: LedgerSnapshot }
  | { readonly acquired: false; readonly existing: LedgerEntry } {
  const stem = basename(path, ".json");
  let candidatePath = path;
  for (let generation = 0; generation < 10_000; generation += 1) {
    const created = createPrivateJsonIfAbsent(candidatePath, entry, { environment, privateParent: true });
    if (created.created) {
      return {
        acquired: true,
        snapshot: {
          path: candidatePath,
          entry,
          contentSha256: sha256(`${canonicalJson(entry)}\n`),
        },
      };
    }
    const existingText = readPrivateStateFileIfPresent(
      candidatePath,
      MAX_LEDGER_BYTES,
      "idempotency ledger",
      environment,
    );
    if (existingText === null) continue;
    let existingValue: unknown;
    try {
      existingValue = JSON.parse(existingText) as unknown;
    } catch {
      throw new Error("idempotency ledger is malformed");
    }
    const existing = parseLedger(existingValue);
    if (
      existing.schemaVersion === 3
      || existing.status !== "succeeded"
      || Date.parse(existing.expiresAt) >= now.getTime()
    ) {
      return { acquired: false, existing };
    }
    // Successful generations are immutable once their window expires. Every contender
    // derives the same successor name, so exclusive creation elects exactly one next run
    // without deleting a path another process could have just reacquired (an ABA race).
    candidatePath = join(dirname(path), `${stem}.${sha256(existing.runId)}.json`);
  }
  throw new Error("idempotency ledger exceeded its bounded generation history");
}

function updateLedger(
  current: LedgerSnapshot,
  entry: LedgerEntry,
): LedgerSnapshot {
  if (
    current.entry.runId !== entry.runId
    || current.entry.schemaVersion !== entry.schemaVersion
    || current.entry.keyHash !== entry.keyHash
    || current.entry.duplicateIntentHash !== entry.duplicateIntentHash
    || current.entry.adapterHash !== entry.adapterHash
    || current.entry.authHash !== entry.authHash
    || current.entry.inputHash !== entry.inputHash
    || current.entry.planDigest !== entry.planDigest
  ) {
    throw new Error("idempotency ledger ownership changed");
  }
  const written = writePrivateJsonIfUnchanged(
    current.path,
    entry,
    { expectedCurrentContentSha256: current.contentSha256 },
  );
  if (!written) {
    throw new Error("idempotency ledger changed concurrently");
  }
  return {
    path: current.path,
    entry,
    contentSha256: sha256(`${canonicalJson(entry)}\n`),
  };
}

function removeLedger(
  current: LedgerSnapshot,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return removePrivateStateFileIfUnchanged(
    current.path,
    { expectedCurrentContentSha256: current.contentSha256 },
    environment,
  );
}

function writeReceipt(
  receipt: RunReceipt,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  writePrivateJson(receiptPath(receipt.runId, environment), receipt, { privateParent: true });
}

function messagingDispatchProgress(run: MessagingRunV1): RunReceipt["dispatch"] {
  const active = run.parts[run.provenPartCount];
  const possibleCurrentDispatch = active?.state === "dispatching"
    || active?.state === "indeterminate";
  return Object.freeze({
    planned: run.partCount,
    started: run.provenPartCount + (possibleCurrentDispatch ? 1 : 0),
    verified: run.provenPartCount,
  });
}

function messagingRunError(run: MessagingRunV1): string | null {
  return run.terminalReason === null
    ? run.state === "pending"
      ? "messaging execution has no durable final outcome"
      : null
    : `messaging execution stopped: ${run.terminalReason}`;
}

function projectMessagingReceipt(
  receipt: RunReceipt,
  run: MessagingRunV1,
): RunReceipt {
  if (
    receipt.runId !== run.runId
    || receipt.planDigest !== run.planDigest
    || receipt.dispatch.planned !== run.partCount
  ) throw new Error("messaging ordinary receipt belongs to another run");
  const dispatch = messagingDispatchProgress(run);
  return Object.freeze({
    ...receipt,
    status: run.state,
    dispatchStarted: dispatch.started > 0,
    dispatch,
    finishedAt: run.recordedAt,
    error: messagingRunError(run),
  });
}

function messagingReceiptForPlan(
  stored: StoredPlan,
  run: MessagingRunV1,
): RunReceipt {
  const plan = stored.plan;
  const common: RunReceiptCommon = {
    runId: run.runId,
    planDigest: stored.digest,
    adapter: plan.adapter,
    operation: plan.operation,
    risk: plan.risk,
    inputHash: plan.inputHash,
    auth: plan.auth,
    status: "pending",
    dispatchStarted: false,
    dispatch: Object.freeze({ planned: run.partCount, started: 0, verified: 0 }),
    startedAt: run.startedAt,
    finishedAt: run.recordedAt,
    finalOrigin: null,
    error: "messaging execution has no durable final outcome",
  };
  const pending: RunReceipt = plan.transport === "provider-api"
    ? Object.freeze({
        ...common,
        schemaVersion: 3 as const,
        transport: "provider-api" as const,
        providerContractHash: plan.providerContract.hash,
      })
    : plan.transport === "web-session-api"
      ? Object.freeze({
          ...common,
          schemaVersion: 4 as const,
          transport: "web-session-api" as const,
          webSessionContractHash: plan.webSessionContract.hash,
        })
      : plan.transport === "reviewed-template-api"
        ? Object.freeze({
            ...common,
            schemaVersion: 5 as const,
            transport: "reviewed-template-api" as const,
            reviewedTemplateContractHash: plan.reviewedTemplateContract.hash,
          })
        : plan.transport === "portable-provider-plugin"
          ? Object.freeze({
              ...common,
              schemaVersion: 6 as const,
              transport: "portable-provider-plugin" as const,
              portablePluginContract: plan.portablePluginContract,
            })
          : plan.transport === "local-cli"
            ? Object.freeze({
                ...common,
                schemaVersion: 7 as const,
                transport: "local-cli" as const,
                localCliContract: plan.localCliContract,
              })
            : Object.freeze({
                ...common,
                schemaVersion: 2 as const,
                transport: "browser" as const,
              });
  return projectMessagingReceipt(pending, run);
}

function runJournalReceipt(journal: RunJournal): RunReceipt {
  const common: RunReceiptCommon = {
    runId: journal.runId,
    planDigest: journal.planDigest,
    adapter: journal.adapter,
    operation: journal.operation,
    risk: journal.risk,
    inputHash: journal.inputHash,
    auth: journal.auth,
    status: journal.status,
    dispatchStarted: journal.dispatch.started > 0,
    dispatch: journal.dispatch,
    startedAt: journal.startedAt,
    finishedAt: journal.updatedAt,
    finalOrigin: journal.finalOrigin,
    error: journal.error,
  };
  if (journal.contract.transport === "portable-provider-plugin") {
    return {
      ...common,
      schemaVersion: 6,
      transport: "portable-provider-plugin",
      portablePluginContract: journal.contract.identity,
    };
  }
  if (journal.contract.transport === "local-cli") {
    return {
      ...common,
      schemaVersion: 7,
      transport: "local-cli",
      localCliContract: journal.contract.identity,
    };
  }
  if (journal.contract.transport === "provider-api") {
    return {
      ...common,
      schemaVersion: 3,
      transport: "provider-api",
      providerContractHash: journal.contract.hash,
    };
  }
  if (journal.contract.transport === "web-session-api") {
    return {
      ...common,
      schemaVersion: 4,
      transport: "web-session-api",
      webSessionContractHash: journal.contract.hash,
    };
  }
  return {
    ...common,
    schemaVersion: 5,
    transport: "reviewed-template-api",
    reviewedTemplateContractHash: journal.contract.hash,
  };
}

function runJournalLedgerEntry(journal: RunJournal): LedgerEntry {
  if (
    journal.ledgerState === "unclaimed"
    || journal.ledgerState === "released"
  ) {
    throw new Error("released run journals have no ledger projection");
  }
  return {
    schemaVersion: journal.duplicateIntent === undefined ? 2 : 3,
    keyHash: journal.duplicateIntent?.intentHash ?? journal.inputHash,
    adapterHash: journal.adapter.hash,
    authHash: journal.auth.hash,
    inputHash: journal.inputHash,
    planDigest: journal.planDigest,
    status: journal.ledgerState,
    dispatch: journal.dispatch,
    runId: journal.runId,
    updatedAt: journal.updatedAt,
    expiresAt: journal.dedupeExpiresAt,
    ...(journal.duplicateIntent === undefined
      ? {}
      : { duplicateIntentHash: journal.duplicateIntent.intentHash }),
  };
}

function relativeStatePath(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const root = wrenchStateHome(environment);
  const child = relative(root, path);
  if (
    child === ""
    || child === ".."
    || child.startsWith(`..${sep}`)
  ) {
    throw new Error("run journal ledger path escaped WRENCH_STATE_HOME");
  }
  return child.split(sep).join("/");
}

function absoluteStatePath(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(wrenchStateHome(environment), ...path.split("/"));
}

function readLedgerSnapshot(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): LedgerSnapshot | null {
  const text = readPrivateStateFileIfPresent(
    path,
    MAX_LEDGER_BYTES,
    "idempotency ledger",
    environment,
  );
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("idempotency ledger is malformed");
  }
  return {
    path,
    entry: parseLedger(value),
    contentSha256: sha256(text),
  };
}

function ledgerBelongsToJournal(
  ledger: LedgerEntry,
  journal: RunJournal,
): boolean {
  return ledger.runId === journal.runId
    && ledger.adapterHash === journal.adapter.hash
    && ledger.authHash === journal.auth.hash
    && ledger.inputHash === journal.inputHash
    && ledger.keyHash === (journal.duplicateIntent?.intentHash ?? journal.inputHash)
    && ledger.duplicateIntentHash === journal.duplicateIntent?.intentHash
    && ledger.planDigest === journal.planDigest;
}

function matchingJournalLedgers(
  journal: RunJournal,
  environment: Readonly<Record<string, string | undefined>>,
): readonly LedgerSnapshot[] {
  if (journal.ledgerRelativePath !== null) {
    const snapshot = readLedgerSnapshot(
      absoluteStatePath(journal.ledgerRelativePath, environment),
      environment,
    );
    return snapshot !== null && ledgerBelongsToJournal(snapshot.entry, journal)
      ? [snapshot]
      : [];
  }
  const base = ledgerPath(
    journal.adapter.hash,
    journal.auth.hash,
    journal.operation,
    journal.inputHash,
    environment,
    journal.duplicateIntent?.intentHash,
  );
  const directory = dirname(base);
  const stem = basename(base, ".json");
  const snapshots: LedgerSnapshot[] = [];
  for (const entry of listPrivateStateDirectory(directory, environment)) {
    if (
      entry.kind !== "file"
      || (
        entry.name !== `${stem}.json`
        && !new RegExp(`^${stem}\\.[a-f0-9]{64}\\.json$`, "u").test(entry.name)
      )
    ) continue;
    const path = join(directory, entry.name);
    try {
      const snapshot = readLedgerSnapshot(path, environment);
      if (
        snapshot !== null
        && ledgerBelongsToJournal(snapshot.entry, journal)
      ) {
        snapshots.push(snapshot);
      }
    } catch {
      // An invalid ledger is preserved for inspection and still blocks reuse.
    }
  }
  return Object.freeze(snapshots);
}

function projectRunJournalReceipt(
  journal: RunJournal,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const path = receiptPath(journal.runId, environment);
  const receipt = runJournalReceipt(journal);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const text = readPrivateStateFileIfPresent(
      path,
      MAX_WRENCH_JSON_BYTES,
      "run receipt",
      environment,
    );
    if (text === null) {
      const created = createPrivateJsonIfAbsent(
        path,
        receipt,
        { environment, privateParent: true },
      );
      if (created.created) return;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("run receipt is malformed");
    }
    const existing = parseRunReceiptValue(journal.runId, value);
    if (canonicalJson(existing) === canonicalJson(receipt)) return;
    if (
      existing.status !== "pending"
      && journal.status === "pending"
    ) {
      throw new Error("a terminal run receipt cannot regress to pending");
    }
    if (
      writePrivateJsonIfUnchanged(
        path,
        receipt,
        { expectedCurrentContentSha256: sha256(text) },
      )
    ) {
      return;
    }
  }
  throw new Error("run receipt changed concurrently during journal projection");
}

function planAssetsHaveAnotherOwner(
  journal: RunJournal,
  environment: Readonly<Record<string, string | undefined>>,
  ownClaim: ConfirmationClaimSnapshot,
): boolean {
  for (const entry of listPrivateStateDirectory(planDirectory(environment), environment)) {
    if (
      entry.kind === "file"
      && (
        entry.name === `${journal.planDigest}.json`
      )
    ) {
      return true;
    }
    if (
      entry.kind === "file"
      && entry.name === `${journal.planDigest}.claim.json`
    ) {
      try {
        const claim = readConfirmationClaim(journal.planDigest, environment);
        if (
          claim === null
          || claim.claim.owner.token !== ownClaim.claim.owner.token
        ) {
          return true;
        }
      } catch {
        return true;
      }
    }
  }
  for (const entry of listRunJournalSnapshots(environment)) {
    if ("invalid" in entry) return true;
    if (
      entry.journal.runId !== journal.runId
      && entry.journal.planDigest === journal.planDigest
      && entry.journal.planHasAssets
      && (
        entry.journal.planState === "available"
        || entry.journal.assetState === "bound"
        || entry.journal.assetState === "retained"
      )
    ) {
      return true;
    }
  }
  return false;
}

function projectRunJournal(
  journal: RunJournal,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (journal.phase !== "terminal") {
    throw new Error("only terminal run journals can be projected");
  }
  projectRunJournalReceipt(journal, environment);
  const ledgers = matchingJournalLedgers(journal, environment);
  if (journal.ledgerState === "released") {
    for (const ledger of ledgers) removeLedger(ledger, environment);
  } else {
    const desired = runJournalLedgerEntry(journal);
    const [existing] = ledgers;
    if (ledgers.length > 1) {
      throw new Error("terminal run journal has multiple ledger projections");
    }
    if (existing === undefined) {
      if (journal.ledgerRelativePath === null) {
        throw new Error("terminal run journal has no ledger coordinate");
      }
      const path = absoluteStatePath(
        journal.ledgerRelativePath,
        environment,
      );
      const created = createPrivateJsonIfAbsent(
        path,
        desired,
        { environment, privateParent: true },
      );
      if (!created.created) {
        const raced = readLedgerSnapshot(path, environment);
        if (
          raced === null
          || !ledgerBelongsToJournal(raced.entry, journal)
        ) {
          throw new Error("terminal run journal ledger is owned by another run");
        }
        updateLedger(raced, desired);
      }
    } else {
      updateLedger(existing, desired);
    }
  }
  if (journal.recoveryState === "released") {
    removeProviderAcceptedMutationTargetEvidence(journal.runId, environment);
    removeRecoveryCapsule(journal.runId, environment);
  }
  if (journal.assetState === "released") {
    let claim: ConfirmationClaimSnapshot | null = null;
    try {
      claim = acquireConfirmationClaim(
        journal.planDigest,
        journal.runId,
        environment,
        new Date(),
      );
      if (!planAssetsHaveAnotherOwner(journal, environment, claim)) {
        cleanupPlanAssets(journal.planDigest, environment);
      }
    } catch {
      // An active or invalid ownership claim makes deletion unsafe. A later
      // repair pass can retry after that exact owner is settled.
    } finally {
      if (claim !== null) releaseConfirmationClaim(claim, environment);
    }
  }
}

export type RunJournalRepairReport = {
  readonly inspected: number;
  readonly repaired: number;
  readonly projected: number;
  readonly invalid: number;
  readonly issues: readonly {
    readonly runId: string;
    readonly reason: "invalid-journal" | "transition-failed" | "projection-failed";
  }[];
};

export type ConfirmationClaimRepairReport = {
  readonly inspected: number;
  readonly released: number;
  readonly invalid: number;
  readonly active: number;
};

export function repairInterruptedConfirmationClaims(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ConfirmationClaimRepairReport {
  const entries = listPrivateStateDirectory(planDirectory(environment), environment)
    .filter((entry) =>
      entry.kind === "file"
      && /^[a-f0-9]{64}\.claim\.json$/u.test(entry.name)
    );
  let released = 0;
  let invalid = 0;
  let active = 0;
  for (const entry of entries) {
    const digest = entry.name.slice(0, 64);
    let claim: ConfirmationClaimSnapshot;
    try {
      const snapshot = readConfirmationClaim(digest, environment);
      if (snapshot === null) continue;
      claim = snapshot;
    } catch {
      invalid += 1;
      continue;
    }
    if (processOwnerStatus(claim.claim.owner) !== "different-or-dead") {
      active += 1;
      continue;
    }
    try {
      const messaging = readMessagingRunIfPresent(
        claim.claim.runId,
        environment,
      );
      if (messaging !== null) {
        if (messaging.run.planDigest !== claim.claim.digest) {
          throw new Error("messaging run belongs to another confirmation claim");
        }
        const run = messaging.run.state === "pending"
          ? terminalizeMessagingRecovery(
              claim.claim.runId,
              environment,
              new Date(),
            )
          : messaging.run;
        let ordinary: RunReceipt;
        try {
          ordinary = readRunReceipt(claim.claim.runId, environment);
        } catch {
          const stored = loadInvocationPlan(claim.claim.digest, environment);
          ordinary = messagingReceiptForPlan(stored, run);
        }
        writeReceipt(projectMessagingReceipt(ordinary, run), environment);
        // Run creation elects the one durable execution for this digest. A
        // crash can occur before the normal confirmation path removes the
        // plan, so consume any survivor before releasing its ownership claim.
        // Repeating this ordering is safe after a later crash: both receipt
        // projection and absent-plan removal are idempotent.
        removePrivateStateFile(
          planPath(claim.claim.digest, environment),
          environment,
        );
        if (releaseConfirmationClaim(claim, environment)) released += 1;
        continue;
      }
    } catch {
      invalid += 1;
      continue;
    }
    let journal: RunJournalSnapshot | null;
    try {
      journal = readRunJournal(claim.claim.runId, environment);
    } catch {
      invalid += 1;
      continue;
    }
    if (
      journal !== null
      && journal.journal.phase !== "terminal"
      && !runJournalNeedsRepair(journal.journal)
    ) {
      active += 1;
      continue;
    }
    if (releaseConfirmationClaim(claim, environment)) released += 1;
  }
  return Object.freeze({
    inspected: entries.length,
    released,
    invalid,
    active,
  });
}

export function repairInterruptedRunJournals(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): RunJournalRepairReport {
  const entries = listRunJournalSnapshots(environment);
  const issues: {
    readonly runId: string;
    readonly reason: "invalid-journal" | "transition-failed" | "projection-failed";
  }[] = [];
  let repaired = 0;
  let projected = 0;
  let invalid = 0;
  for (const entry of entries) {
    if ("invalid" in entry) {
      invalid += 1;
      issues.push({ runId: entry.runId, reason: "invalid-journal" });
      continue;
    }
    let snapshot = entry;
    if (
      snapshot.journal.phase !== "terminal"
      && runJournalNeedsRepair(snapshot.journal, now)
    ) {
      const transitionAt = new Date(Math.max(
        now.getTime(),
        Date.parse(snapshot.journal.updatedAt),
      )).toISOString();
      try {
        if (
          snapshot.journal.planState === "available"
          && !listPrivateStateDirectory(
            planDirectory(environment),
            environment,
          ).some((planEntry) =>
            planEntry.kind === "file"
            && planEntry.name === `${snapshot.journal.planDigest}.json`
          )
        ) {
          snapshot = updateRunJournal(snapshot, {
            type: "confirmation-consumed",
            at: transitionAt,
          }, environment);
        }
        snapshot = updateRunJournal(snapshot, {
          type: "finished",
          status: snapshot.journal.dispatch.started > 0
            ? "indeterminate"
            : "failed",
          finalOrigin: null,
          error: snapshot.journal.dispatch.started > 0
            ? "execution owner exited after a dispatch boundary; reconcile before retrying"
            : "execution owner exited before dispatch; create a new preview before retrying",
          at: transitionAt,
        }, environment);
        repaired += 1;
      } catch {
        issues.push({
          runId: snapshot.journal.runId,
          reason: "transition-failed",
        });
        continue;
      }
    }
    if (snapshot.journal.phase !== "terminal") continue;
    try {
      projectRunJournal(snapshot.journal, environment);
      projected += 1;
    } catch {
      issues.push({
        runId: snapshot.journal.runId,
        reason: "projection-failed",
      });
    }
  }
  return Object.freeze({
    inspected: entries.length,
    repaired,
    projected,
    invalid,
    issues: Object.freeze(issues),
  });
}

export function releaseReconciledRunRecovery(
  runId: string,
  expectedReceiptHash: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
  outcome: "applied" | "not-applied" = "applied",
):
  | "journal-released"
  | "journal-retained-for-duplicate-successor"
  | "legacy-no-journal" {
  if (!/^[a-f0-9]{64}$/u.test(expectedReceiptHash)) {
    throw new Error("reconciliation receipt hash is malformed");
  }
  let snapshot = readRunJournal(runId, environment);
  if (snapshot === null) return "legacy-no-journal";
  if (
    snapshot.journal.phase !== "terminal"
    || (
      snapshot.journal.status !== "partial"
      && snapshot.journal.status !== "indeterminate"
    )
  ) {
    throw new Error(
      "run journal is not an unsettled terminal write eligible for reconciliation",
    );
  }
  if (
    sha256(canonicalJson(runJournalReceipt(snapshot.journal)))
    !== expectedReceiptHash
  ) {
    throw new Error(
      "run journal no longer matches the reconciled receipt",
    );
  }
  if (snapshot.journal.duplicateSuccessor !== undefined) {
    return "journal-retained-for-duplicate-successor";
  }
  if (snapshot.journal.recoveryState !== "released") {
    try {
      snapshot = updateRunJournal(snapshot, {
        type: "recovery-released",
        outcome,
        at: new Date(Math.max(
          now.getTime(),
          Date.parse(snapshot.journal.updatedAt),
        )).toISOString(),
      }, environment);
    } catch (error) {
      const raced = readRunJournal(runId, environment);
      if (raced?.journal.duplicateSuccessor !== undefined) {
        return "journal-retained-for-duplicate-successor";
      }
      throw error;
    }
  } else {
    // Re-enter the pure transition to verify an idempotent retry carries the
    // same reconciliation outcome as the durable journal.
    transitionRunJournal(snapshot.journal, {
      type: "recovery-released",
      outcome,
      at: snapshot.journal.updatedAt,
    });
  }
  projectRunJournal(snapshot.journal, environment);
  return "journal-released";
}

export type InvocationResult = {
  readonly receipt: RunReceipt;
  readonly output: unknown;
  readonly replayed: boolean;
  /** Stable, secret-free retry policy for a failed R1 invocation. */
  readonly readFailure?: ReadFailureProjection;
  /** Internal cleanup signal; public renderers intentionally omit it. */
  readonly privateArtifactsPreserved?: boolean;
  /** Exact bounded handle retained even when receipt or journal projection fails. */
  readonly recoveryHandle?: string;
};

type BoundedExecution = {
  readonly status: "succeeded" | "failed" | "partial" | "indeterminate";
  readonly output: unknown;
  readonly finalUrl: string | null;
  readonly dispatchStarted: boolean;
  readonly dispatch: RunReceipt["dispatch"];
  readonly error?: string;
  readonly readFailure?: ReadFailureProjection;
  readonly noOp?: true;
  readonly privateArtifactsPreserved?: boolean;
  readonly recoveryHandle?: string;
};

const MAX_EXECUTION_ERROR_BYTES = 8 * 1024;
const MAX_FINAL_URL_BYTES = 8 * 1024;
const MAX_JSON_OUTPUT_DEPTH = 64;
const MAX_JSON_OUTPUT_NODES = 100_000;

function foreignDataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype: unknown = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return null;
    const record: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) return null;
      Object.defineProperty(record, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return record;
  } catch {
    return null;
  }
}

/** @internal Exported only for owned runtime-boundary tests. */
export function boundedJsonOutput(value: unknown, maxBytes: number): unknown {
  const state = { bytes: 0, nodes: 0 };
  const ancestors = new WeakSet<object>();
  const charge = (bytes: number): void => {
    state.bytes += bytes;
    if (state.bytes > maxBytes) throw new Error("executor output exceeds its byte bound");
  };
  const visit = (candidate: unknown, depth: number): unknown => {
    state.nodes += 1;
    if (state.nodes > MAX_JSON_OUTPUT_NODES || depth > MAX_JSON_OUTPUT_DEPTH) {
      throw new Error("executor output exceeds its structural bound");
    }
    if (
      candidate === null
      || typeof candidate === "boolean"
      || typeof candidate === "string"
    ) {
      charge(Buffer.byteLength(JSON.stringify(candidate), "utf8"));
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("executor output contains a non-finite number");
      charge(Buffer.byteLength(JSON.stringify(candidate), "utf8"));
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new Error("executor output is not JSON-compatible");
    }
    if (ancestors.has(candidate)) throw new Error("executor output is circular");
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as Readonly<
          Record<string, PropertyDescriptor>
        >;
        const symbols = Reflect.ownKeys(descriptors).filter((key) => typeof key !== "string");
        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
        if (
          symbols.length > 0
          || lengthDescriptor === undefined
          || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value)
          || typeof lengthDescriptor.value !== "number"
          || lengthDescriptor.value < 0
        ) {
          throw new Error("executor output contains a malformed array");
        }
        const length = lengthDescriptor.value;
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        if (
          keys.length !== length
          || keys.some((key, index) => key !== String(index))
        ) {
          throw new Error("executor output arrays must be dense data arrays");
        }
        charge(2 + Math.max(0, length - 1));
        const output: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error("executor output arrays must contain only data elements");
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      const record = foreignDataRecord(candidate);
      if (record === null) throw new Error("executor output objects must be plain data objects");
      const entries = Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
      charge(2 + Math.max(0, entries.length - 1));
      const output: Record<string, unknown> = {};
      for (const [key, item] of entries) {
        charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        Object.defineProperty(output, key, {
          value: visit(item, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value, 0);
}

function executionOutputLimit(
  operation: WrenchManifest["operations"][string],
): number {
  if (isProviderOperation(operation)) return operation.provider.maxOutputBytes;
  if (isWebSessionOperation(operation)) return operation.webSession.maxOutputBytes;
  if (isLocalCliOperation(operation)) return operation.localCli.maxOutputBytes;
  if (isReviewedTemplateOperation(operation)) {
    if (operation.reviewedTemplate.state !== "reviewed") {
      throw new Error("capture-required reviewed templates have no output bound");
    }
    return operation.reviewedTemplate.template.response.maxBytes;
  }
  return operation.browser.maxOutputBytes;
}

const GENERIC_EXECUTOR_TERMINATION =
  "provider executor terminated without returning a bounded result";

function boundedThrownExecutorReason(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : "";
  const redacted = redactSensitiveText(raw).replaceAll("\0", "").trim();
  if (redacted.length === 0) return GENERIC_EXECUTOR_TERMINATION;
  return redacted.slice(0, 2_000);
}

function boundedExecutionResult(
  value: unknown,
  kind:
    | "browser"
    | "provider"
    | "web-session"
    | "local-cli"
    | "reviewed-template",
  maxOutputBytes: number,
): BoundedExecution {
  const record = foreignDataRecord(value);
  if (record === null) throw new Error("executor result must be a plain data object");
  const requiredKeys = ["status", "output", "finalUrl", "dispatchStarted", "dispatch"];
  const allowedKeys = new Set([
    ...requiredKeys,
    "error",
    "readFailure",
    ...(kind === "web-session" || kind === "local-cli" ? ["noOp"] : []),
    ...(kind === "browser" ? ["privateArtifactsPreserved", "recoveryHandle"] : []),
  ]);
  if (
    requiredKeys.some((key) => !(key in record))
    || Object.keys(record).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error("executor result has unsupported fields");
  }
  const supportedStatuses = kind === "reviewed-template"
    ? new Set(["succeeded", "failed", "indeterminate"])
    : new Set(["succeeded", "failed", "partial", "indeterminate"]);
  if (typeof record.status !== "string" || !supportedStatuses.has(record.status)) {
    throw new Error("executor result has an unsupported status");
  }
  const status = record.status as BoundedExecution["status"];
  if (typeof record.dispatchStarted !== "boolean") {
    throw new Error("executor result has a malformed dispatchStarted flag");
  }
  const dispatch = foreignDataRecord(record.dispatch);
  if (dispatch === null || !isDispatchProgress(dispatch)) {
    throw new Error("executor result has malformed dispatch progress");
  }
  let finalUrl: string | null;
  if (record.finalUrl === null) {
    finalUrl = null;
  } else if (
    typeof record.finalUrl === "string"
    && record.finalUrl.length > 0
    && Buffer.byteLength(record.finalUrl, "utf8") <= MAX_FINAL_URL_BYTES
  ) {
    const parsed = new URL(record.finalUrl);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username !== ""
      || parsed.password !== ""
    ) throw new Error("executor result has a malformed finalUrl");
    finalUrl = record.finalUrl;
  } else {
    throw new Error("executor result has a malformed finalUrl");
  }
  let error: string | undefined;
  if ("error" in record) {
    if (
      typeof record.error !== "string"
      || Buffer.byteLength(record.error, "utf8") > MAX_EXECUTION_ERROR_BYTES
      || status === "succeeded"
    ) {
      throw new Error("executor result has a malformed error");
    }
    error = record.error;
  }
  const readFailure = record.readFailure === undefined
    ? undefined
    : parseReadFailureProjection(record.readFailure);
  if (status === "failed" && record.output !== null) {
    throw new Error("executor failed result retained an output");
  }
  if (
    readFailure !== undefined
    && (
      status !== "failed"
      || record.dispatchStarted !== false
      || dispatch.planned !== 0
      || dispatch.started !== 0
      || dispatch.verified !== 0
    )
  ) {
    throw new Error(
      "executor read failure projection crossed a dispatch or success boundary",
    );
  }
  const noOp = record.noOp;
  if (noOp !== undefined && noOp !== true) {
    throw new Error("executor result has a malformed noOp flag");
  }
  const privateArtifactsPreserved = record.privateArtifactsPreserved;
  if (
    privateArtifactsPreserved !== undefined
    && typeof privateArtifactsPreserved !== "boolean"
  ) {
    throw new Error("executor result has a malformed privateArtifactsPreserved flag");
  }
  let recoveryHandle: string | undefined;
  if ("recoveryHandle" in record) {
    if (
      typeof record.recoveryHandle !== "string"
      || privateArtifactsPreserved !== true
      || boundedRecoveryHandle(record.recoveryHandle) !== record.recoveryHandle
    ) {
      throw new Error("executor result has a malformed recovery handle");
    }
    recoveryHandle = record.recoveryHandle;
  }
  return {
    status,
    output: boundedJsonOutput(record.output, maxOutputBytes),
    finalUrl,
    dispatchStarted: record.dispatchStarted,
    dispatch,
    ...(error === undefined ? {} : { error }),
    ...(readFailure === undefined ? {} : { readFailure }),
    ...(noOp === true ? { noOp: true as const } : {}),
    ...(privateArtifactsPreserved === undefined ? {} : { privateArtifactsPreserved }),
    ...(recoveryHandle === undefined ? {} : { recoveryHandle }),
  };
}

type RunPreparedOptions = {
  readonly headed: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly registry?: ProviderPluginRegistry;
  readonly now?: Date;
  readonly executeRecipe?: typeof executeBrowserRecipe;
  readonly executeProvider?: typeof executeProviderOperation;
  readonly executeWebSession?: WebSessionOperationExecutor;
  readonly executeLocalCli?: LocalCliOperationExecutor;
  readonly executePublicWebSession?: PublicWebSessionOperationExecutor;
  readonly executeReviewedTemplate?: typeof executeReviewedTemplateOperation;
  readonly fileResolver?: BrowserFileResolver;
  readonly confirmedDispatches?: readonly BrowserDispatchPlan[];
  readonly hasPlanAssets?: boolean;
  readonly runId?: string;
  readonly confirmationClaim?: ConfirmationClaimSnapshot;
  readonly duplicateRisk?: InvocationDuplicateRiskV1;
  readonly signal?: AbortSignal;
  readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
  readonly persistReceipt?: (
    receipt: RunReceipt,
    environment: Readonly<Record<string, string | undefined>>,
  ) => void;
};

async function runPreparedCore(
  invocation: PreparedInvocation,
  planDigest: string | null,
  options: RunPreparedOptions,
): Promise<InvocationResult> {
  const registry = options.registry ?? providerPluginRegistry;
  const checked = revalidatePreparedInvocation(invocation, registry);
  invocation = checked.invocation;
  const persistReceipt = options.persistReceipt ?? writeReceipt;
  const operation = checked.operation;
  if (operation.risk === "R4") throw new Error("R4 capabilities are blocked by wrench");
  const isWrite = operation.risk === "R2" || operation.risk === "R3";
  if (isWrite) {
    const claimRepair = repairInterruptedConfirmationClaims(
      options.environment,
    );
    const journalRepair = repairInterruptedRunJournals(
      options.environment,
      options.now ?? new Date(),
    );
    if (claimRepair.invalid > 0 || journalRepair.issues.length > 0) {
      throw new Error(
        "local execution recovery has unresolved state; run wrench doctor before starting another write",
      );
    }
  }
  const providerOperation = isProviderOperation(operation);
  const webSessionOperation = isWebSessionOperation(operation);
  const localCliOperation = isLocalCliOperation(operation);
  const reviewedTemplateOperation = isReviewedTemplateOperation(operation);
  const pluginResolution = resolveCodeOwnedPluginOperation(operation, registry);
  const plannedDispatches = pluginResolution !== null
    ? runProviderPluginPlanConformance(
        pluginResolution.operation,
        invocation.input,
      )
      : reviewedTemplateOperation
        ? planReviewedTemplateDispatches(invocation.operationId, operation.risk, operation.reviewedTemplate)
        : operation.browser === undefined
          ? (() => {
            throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
          })()
          : expandBrowserRecipe(operation.browser, invocation.input).dispatches;
  if (
    options.confirmedDispatches !== undefined
    && canonicalJson(plannedDispatches) !== canonicalJson(options.confirmedDispatches)
  ) {
    throw new Error(
      "planned dispatch schedule changed before execution; preview the action again",
    );
  }
  const planned = plannedDispatches.length;
  if (operation.risk === "R1" && planned !== 0) {
    throw new Error("R1 operations must not schedule remote dispatches");
  }
  const currentProviderContractHash = providerOperation
    ? providerContractHash(
        getProviderContract(operation.provider, registry),
        registry,
      )
    : null;
  const currentWebSessionContractHash = webSessionOperation
    ? webSessionContractHash(
        getWebSessionContract(operation.webSession, registry),
        registry,
      )
    : null;
  const currentLocalCliContractIdentity = localCliOperation
    ? localCliContractIdentity(operation.localCli, registry)
    : null;
  const currentReviewedTemplateContractHash = reviewedTemplateOperation
    ? reviewedTemplateHash(operation.reviewedTemplate)
    : null;
  const currentPortablePluginContract =
    pluginResolution?.portableIdentity ?? null;
  const recoveryContract = (): RecoveryContractIdentity => {
    if (currentPortablePluginContract !== null) {
      return {
        transport: "portable-provider-plugin",
        identity: currentPortablePluginContract,
      };
    }
    if (providerOperation) {
      if (currentProviderContractHash === null) throw new Error("official provider contract hash is unavailable");
      return {
        transport: "provider-api",
        provider: operation.provider.provider,
        action: operation.provider.action,
        version: operation.provider.contractVersion,
        hash: currentProviderContractHash,
      };
    }
    if (webSessionOperation) {
      if (currentWebSessionContractHash === null) throw new Error("authenticated web contract hash is unavailable");
      return {
        transport: "web-session-api",
        site: operation.webSession.site,
        action: operation.webSession.action,
        version: operation.webSession.contractVersion,
        hash: currentWebSessionContractHash,
      };
    }
    if (localCliOperation) {
      if (currentLocalCliContractIdentity === null) {
        throw new Error("local CLI contract identity is unavailable");
      }
      return {
        transport: "local-cli",
        identity: currentLocalCliContractIdentity,
      };
    }
    if (reviewedTemplateOperation) {
      if (currentReviewedTemplateContractHash === null) throw new Error("reviewed template contract hash is unavailable");
      return {
        transport: "reviewed-template-api",
        version: operation.reviewedTemplate.contractVersion,
        hash: currentReviewedTemplateContractHash,
      };
    }
    throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
  };
  const inputHash = sha256(canonicalJson(invocation.input));
  const runId = options.runId ?? crypto.randomUUID();
  if (!/^[0-9a-f-]{36}$/u.test(runId)) {
    throw new Error("run ID is malformed");
  }
  const startedAt = (options.now ?? new Date()).toISOString();
  const adapter = {
    id: invocation.manifest.id,
    version: invocation.manifest.version,
    hash: manifestHash(invocation.manifest),
  };
  const auth = { id: invocation.auth.id, hash: authHash(invocation.auth), kind: invocation.auth.kind };
  const durableWriteAuth = (): InvocationPlanCommon["auth"] => {
    if (!isWrite) throw new Error("read invocation has no durable write auth");
    const selected = persistedAuthAuthority(invocation.auth);
    return {
      id: selected.id,
      hash: authHash(selected),
      kind: selected.kind,
    };
  };
  const withTransport = (value: RunReceiptCommon): RunReceipt => {
    if (currentPortablePluginContract !== null) {
      return {
        ...value,
        schemaVersion: 6,
        transport: "portable-provider-plugin",
        portablePluginContract: currentPortablePluginContract,
      };
    }
    if (providerOperation) {
      if (currentProviderContractHash === null) throw new Error("official provider contract hash is unavailable");
      return {
        ...value,
        schemaVersion: 3,
        transport: "provider-api",
        providerContractHash: currentProviderContractHash,
      };
    }
    if (webSessionOperation) {
      if (currentWebSessionContractHash === null) throw new Error("authenticated web contract hash is unavailable");
      return {
        ...value,
        schemaVersion: 4,
        transport: "web-session-api",
        webSessionContractHash: currentWebSessionContractHash,
      };
    }
    if (localCliOperation) {
      if (currentLocalCliContractIdentity === null) {
        throw new Error("local CLI contract identity is unavailable");
      }
      return {
        ...value,
        schemaVersion: 7,
        transport: "local-cli",
        localCliContract: currentLocalCliContractIdentity,
      };
    }
    if (reviewedTemplateOperation) {
      if (currentReviewedTemplateContractHash === null) throw new Error("reviewed template contract hash is unavailable");
      return {
        ...value,
        schemaVersion: 5,
        transport: "reviewed-template-api",
        reviewedTemplateContractHash: currentReviewedTemplateContractHash,
      };
    }
    return { ...value, schemaVersion: 2, transport: "browser" };
  };
  let journal: RunJournalSnapshot | null = null;
  let durableReceipt: RunReceipt = withTransport({
    runId,
    planDigest,
    adapter,
    operation: invocation.operationId,
    risk: operation.risk,
    inputHash,
    auth,
    status: "pending",
    dispatchStarted: false,
    dispatch: { planned, started: 0, verified: 0 },
    startedAt,
    finishedAt: startedAt,
    finalOrigin: null,
    error: "execution was prepared but no durable final outcome was recorded",
  });
  if (isWrite) {
    if (planDigest === null) throw new Error("remote writes require a confirmation plan");
    if (
      options.confirmationClaim === undefined
      || options.confirmationClaim.claim.digest !== planDigest
      || options.confirmationClaim.claim.runId !== runId
    ) {
      throw new Error(
        "remote writes require an exact durable confirmation ownership claim",
      );
    }
    if (!isProviderPluginOperationName(invocation.operationId)) {
      throw new Error("run journal operation name is malformed");
    }
    const contract = recoveryContract();
    const timeoutMs = providerOperation
      ? operation.provider.timeoutMs
      : webSessionOperation
        ? operation.webSession.timeoutMs
        : localCliOperation
          ? operation.localCli.timeoutMs
        : reviewedTemplateOperation
          ? operation.reviewedTemplate.state === "reviewed"
            ? operation.reviewedTemplate.timeoutMs
            : 10 * 60_000
          : operation.browser?.timeoutMs ?? 10 * 60_000;
    const processIdentity = currentProcessStartIdentity();
    try {
      journal = createRunJournal(initialRunJournal({
        runId,
        planDigest,
        adapter,
        operation: invocation.operationId,
        risk: operation.risk,
        inputHash,
        auth: durableWriteAuth(),
        contract: contract.transport === "portable-provider-plugin"
          || contract.transport === "local-cli"
          ? contract
          : {
              transport: contract.transport,
              hash: contract.hash,
            },
        ...(options.duplicateRisk === undefined
          ? {}
          : {
              duplicateIntent: {
                schemaVersion: 1 as const,
                intentHash: options.duplicateRisk.intentHash,
                sourceRunId: options.duplicateRisk.sourceRunId,
              },
            }),
        plannedDispatches: planned,
        hasPlanAssets: options.hasPlanAssets === true,
        owner: {
          pid: process.pid,
          token: crypto.randomUUID(),
          ...processIdentity,
          leaseUntil: new Date(
            Date.parse(startedAt) + timeoutMs + 30_000,
          ).toISOString(),
        },
        startedAt,
        dedupeExpiresAt: new Date(
          Date.parse(startedAt) + operation.dedupeWindowMs,
        ).toISOString(),
      }), options.environment);
    } catch (error) {
      releaseConfirmationClaim(
        options.confirmationClaim,
        options.environment,
      );
      throw error;
    }
    if (
      !removePrivateStateFile(
        planPath(planDigest, options.environment),
        options.environment,
      )
    ) {
      try {
        journal = updateRunJournal(journal, {
          type: "finished",
          status: "failed",
          finalOrigin: null,
          error: "confirmation ownership was lost before plan consumption",
          at: startedAt,
        }, options.environment);
        projectRunJournal(journal.journal, options.environment);
      } finally {
        releaseConfirmationClaim(
          options.confirmationClaim,
          options.environment,
        );
      }
      throw new Error("confirmation plan was already consumed or cancelled");
    }
    try {
      journal = updateRunJournal(journal, {
        type: "confirmation-consumed",
        at: startedAt,
      }, options.environment);
    } catch (error) {
      // The still-present claim plus absent plan is a durable recovery witness.
      throw new Error(
        "confirmation plan was consumed, but its run journal could not claim ownership; run wrench doctor before retrying",
        { cause: error },
      );
    }
    if (
      !releaseConfirmationClaim(
        options.confirmationClaim,
        options.environment,
      )
    ) {
      try {
        journal = updateRunJournal(journal, {
          type: "finished",
          status: "failed",
          finalOrigin: null,
          error: "confirmation ownership claim changed before release",
          at: startedAt,
        }, options.environment);
        projectRunJournal(journal.journal, options.environment);
      } catch {
        // The consumed journal remains fail-closed and repairable.
      }
      throw new Error(
        "confirmation ownership claim changed unexpectedly; run wrench doctor before retrying",
      );
    }
    durableReceipt = runJournalReceipt(journal.journal);
  }
  const finalizePreDispatchFailure = (message: string): void => {
    if (journal === null) return;
    try {
      if (journal.journal.phase !== "terminal") {
        journal = updateRunJournal(journal, {
          type: "finished",
          status: "failed",
          finalOrigin: null,
          error: message,
          at: (options.now ?? new Date()).toISOString(),
        }, options.environment);
      }
      projectRunJournal(journal.journal, options.environment);
      durableReceipt = runJournalReceipt(journal.journal);
    } catch {
      // Never delete or rewrite subordinate state when the source journal did
      // not durably accept the terminal transition.
    }
  };
  try {
    persistReceipt(durableReceipt, options.environment);
  } catch (error) {
    if (journal !== null) {
      try {
        journal = updateRunJournal(journal, {
          type: "finished",
          status: "failed",
          finalOrigin: null,
          error: "provisional receipt could not be projected before dispatch",
          at: (options.now ?? new Date()).toISOString(),
        }, options.environment);
      } catch {
        // The prepared journal still proves that dispatch never started.
      }
    }
    throw new Error("refusing to start execution because its provisional receipt could not be stored", { cause: error });
  }
  if (isWrite) {
    if (planDigest === null) throw new Error("remote writes require a confirmation plan");
    const path = ledgerPath(
      adapter.hash,
      auth.hash,
      invocation.operationId,
      inputHash,
      options.environment,
      options.duplicateRisk?.intentHash,
    );
    const entry: LedgerEntry = {
      schemaVersion: options.duplicateRisk === undefined ? 2 : 3,
      keyHash: options.duplicateRisk?.intentHash ?? inputHash,
      adapterHash: adapter.hash,
      authHash: auth.hash,
      inputHash,
      planDigest: planDigest ?? "",
      status: "pending",
      dispatch: durableReceipt.dispatch,
      runId,
      updatedAt: startedAt,
      expiresAt: new Date(Date.parse(startedAt) + operation.dedupeWindowMs).toISOString(),
      ...(options.duplicateRisk === undefined
        ? {}
        : { duplicateIntentHash: options.duplicateRisk.intentHash }),
    };
    let acquired: ReturnType<typeof acquireLedger>;
    try {
      acquired = acquireLedger(
        path,
        entry,
        options.environment,
        options.now ?? new Date(),
      );
    } catch (error) {
      finalizePreDispatchFailure(
        "idempotency state could not be inspected before dispatch",
      );
      throw new Error(
        "refusing to start a remote write because its idempotency state could not be inspected",
        { cause: error },
      );
    }
    if (!acquired.acquired) {
      finalizePreDispatchFailure(
        "another run already owns this idempotency scope",
      );
      if (
        acquired.existing.inputHash !== inputHash
        || acquired.existing.adapterHash !== adapter.hash
        || acquired.existing.authHash !== auth.hash
      ) throw new Error("idempotency key was already used in a different action scope");
      if (acquired.existing.status === "succeeded") {
        return {
          receipt: readRunReceipt(acquired.existing.runId, options.environment),
          output: null,
          replayed: true,
          privateArtifactsPreserved: false,
        };
      }
      throw new Error(`a prior attempt (${acquired.existing.runId}) may have reached the provider; inspect 'wrench runs show ${acquired.existing.runId}' and reconcile it before retrying`);
    }
    try {
      if (journal === null) throw new Error("remote write has no run journal");
      journal = updateRunJournal(journal, {
        type: "ledger-claimed",
        ledgerRelativePath: relativeStatePath(
          acquired.snapshot.path,
          options.environment,
        ),
        at: (options.now ?? new Date()).toISOString(),
      }, options.environment);
    } catch (error) {
      finalizePreDispatchFailure(
        "idempotency claim could not be bound to the run journal",
      );
      throw new Error(
        "refusing to start a remote write because its run journal could not claim the idempotency ledger",
        { cause: error },
      );
    }
    try {
      writeRecoveryCapsule({
        schemaVersion: 1,
        runId,
        createdAt: startedAt,
        planDigest,
        adapter,
        operation: invocation.operationId,
        risk: operation.risk,
        input: invocation.input,
        inputHash,
        auth: durableWriteAuth(),
        contract: recoveryContract(),
      }, options.environment);
      if (journal === null) throw new Error("remote write has no run journal");
      journal = updateRunJournal(journal, {
        type: "recovery-stored",
        at: (options.now ?? new Date()).toISOString(),
      }, options.environment);
      durableReceipt = runJournalReceipt(journal.journal);
    } catch (error) {
      finalizePreDispatchFailure(
        "encrypted recovery state could not be made durable before dispatch",
      );
      throw new Error("refusing to start a remote write because its encrypted recovery capsule could not be stored", {
        cause: error,
      });
    }
  }
  let duplicateSourceClaimed = false;
  const persistDispatchProgress = (
    event:
      | BrowserDispatchEvent
      | ProviderDispatchEvent
      | WebSessionDispatchEvent
      | LocalCliDispatchEvent
      | ReviewedTemplateDispatchEvent,
    phase: "starting" | "verified",
  ): Promise<void> => {
    const expectedDispatch = plannedDispatches[event.index - 1];
    const prior = durableReceipt.dispatch;
    const expectedPrior = phase === "starting"
      ? { planned, started: event.index - 1, verified: event.index - 1 }
      : { planned, started: event.index, verified: event.index - 1 };
    if (
      !isDispatchProgress(event.progress)
      || event.progress.planned !== planned
      || event.index < 1
      || event.index > planned
      || expectedDispatch === undefined
      || event.id !== expectedDispatch.id
      || canonicalJson(prior) !== canonicalJson(expectedPrior)
      || (phase === "starting"
        ? event.progress.started !== event.index - 1
          || event.progress.verified !== event.index - 1
        : event.progress.started !== event.index
          || event.progress.verified !== event.index)
    ) {
      return Promise.reject(new Error("dispatch progress diverged from the confirmed schedule"));
    }
    const dispatch = phase === "starting"
      ? { planned, started: event.index, verified: event.progress.verified }
      : event.progress;
    if (!isDispatchProgress(dispatch)) return Promise.reject(new Error("dispatch progress is malformed"));
    const progressAt = (options.now ?? new Date()).toISOString();
    let next: RunReceipt = {
      ...durableReceipt,
      status: "pending",
      dispatchStarted: dispatch.started > 0,
      dispatch,
      finishedAt: progressAt,
      error: phase === "starting"
        ? "a dispatch was durably marked before provider submission; a missing final outcome requires reconciliation"
        : "verified dispatch progress was stored; execution has not reached a durable final outcome",
    };
    try {
      if (
        phase === "starting"
        && event.index === 1
        && options.duplicateRisk !== undefined
        && !duplicateSourceClaimed
      ) {
        claimDuplicateRiskSource(
          options.duplicateRisk,
          runId,
          options.environment,
          options.now ?? new Date(),
        );
        duplicateSourceClaimed = true;
      }
      if (journal !== null) {
        journal = updateRunJournal(journal, {
          type: phase === "starting" ? "dispatch-started" : "dispatch-verified",
          index: event.index,
          at: progressAt,
        }, options.environment);
        next = runJournalReceipt(journal.journal);
        durableReceipt = next;
      } else {
        persistReceipt(next, options.environment);
      }
      durableReceipt = next;
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(new Error("refusing provider dispatch because durable progress could not be stored", { cause: error }));
    }
  };
  const persistProviderBoundMutationTarget = (
    eventValue:
      | WebSessionProviderAcceptedMutationTargetEvent
      | WebSessionProviderBoundMutationTargetEvent,
  ): Promise<void> => {
    const event = foreignDataRecord(eventValue);
    if (
      event === null
      || !hasExactKeys(event, ["id", "index", "target"])
      || typeof event.id !== "string"
      || !Number.isSafeInteger(event.index)
    ) {
      return Promise.reject(new Error(
        "provider-accepted mutation target event is malformed",
      ));
    }
    const index = event.index as number;
    const expectedDispatch = plannedDispatches[index - 1];
    const current = durableReceipt.dispatch;
    if (
      !isWrite
      || (!webSessionOperation && !localCliOperation)
      || journal === null
      || expectedDispatch === undefined
      || event.id !== expectedDispatch.id
      || index < 1
      || index > planned
      || current.planned !== planned
      || current.started !== index
      || current.verified !== index - 1
    ) {
      return Promise.reject(new Error(
        "provider-accepted mutation target diverged from the active dispatch",
      ));
    }
    const contract = recoveryContract();
    if (
      contract.transport !== "web-session-api"
      && contract.transport !== "local-cli"
    ) {
      return Promise.reject(new Error(
        "provider-accepted mutation target requires a session or local CLI contract",
      ));
    }
    try {
      writeProviderAcceptedMutationTargetEvidence({
        schemaVersion: 1,
        runId,
        acceptedAt: (options.now ?? new Date()).toISOString(),
        planDigest,
        adapter,
        operation: invocation.operationId,
        inputHash,
        auth,
        contract,
        dispatch: {
          id: event.id,
          index,
          planned,
        },
        target: event.target,
      }, options.environment);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(new Error(
        "provider-accepted mutation target could not be stored",
        { cause: error },
      ));
    }
  };
  const executionKind = providerOperation
    ? "provider"
    : webSessionOperation
      ? "web-session"
      : localCliOperation
        ? "local-cli"
      : reviewedTemplateOperation ? "reviewed-template" : "browser";
  const exactTargetReconciliationKind =
    pluginResolution?.operation.reconciliation?.kind;
  const maxOutputBytes = executionOutputLimit(operation);
  const publicWebSessionOperation = webSessionOperation
    && isPublicWebSessionInvocationAuthority(invocation.auth);
  let execution: BoundedExecution;
  try {
    const rawExecution: unknown = providerOperation
      ? await (options.executeProvider ?? executeProviderOperation)(
          invocation.manifest,
          operation.provider,
          invocation.input,
          persistedAuthAuthority(invocation.auth),
          {
            registry,
            ...(options.fileResolver === undefined ? {} : { fileResolver: options.fileResolver }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            environment: options.environment,
            beforeDispatch: (event) => persistDispatchProgress(event, "starting"),
            afterDispatchVerified: (event) => persistDispatchProgress(event, "verified"),
          },
        )
      : webSessionOperation
        ? await runWebSessionOperationWithDeadline(
            operation.webSession,
            {
              ...(options.fileResolver === undefined ? {} : { fileResolver: options.fileResolver }),
              environment: options.environment,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              ...(options.registerCleanupBarrier === undefined
                ? {}
                : {
                  registerCleanupBarrier: options.registerCleanupBarrier,
                }),
              beforeDispatch: (event) => persistDispatchProgress(event, "starting"),
              ...(isWrite
                && exactTargetReconciliationKind
                  === "provider-accepted-target-presence"
                ? {
                  afterProviderAcceptedMutationTarget:
                    persistProviderBoundMutationTarget,
                }
                : {}),
              ...(isWrite
                && exactTargetReconciliationKind
                  === "provider-bound-target-desired-state"
                ? {
                  afterProviderBoundMutationTarget:
                    persistProviderBoundMutationTarget,
                }
                : {}),
              afterDispatchVerified: (event) => persistDispatchProgress(event, "verified"),
            },
            async (executionOptions: WebSessionExecutionOptions) => {
              if (
                pluginResolution === null
                || (
                  pluginResolution.binding.transport !== "web-session-api"
                  && pluginResolution.binding.transport !== "linked-device"
                )
              ) {
                throw new Error(
                  "authenticated session operation resolved to the wrong plugin transport",
                );
              }
              if (publicWebSessionOperation) {
                if (pluginResolution.binding.transport !== "web-session-api") {
                  throw new Error(
                    "public access is available only to a web-session plugin binding",
                  );
                }
                const executePublic = options.executePublicWebSession
                  ?? pluginResolution.binding.executePublic;
                if (executePublic === undefined) {
                  throw new Error(
                    "reviewed public web-session operation has no public runtime hook",
                  );
                }
                return executePublic(
                  invocation.manifest,
                  operation.webSession,
                  invocation.input,
                  executionOptions,
                );
              }
              return (options.executeWebSession
                ?? pluginResolution.binding.execute)(
                invocation.manifest,
                operation.webSession,
                invocation.input,
                persistedAuthAuthority(invocation.auth),
                executionOptions,
              );
            },
          )
        : localCliOperation
          ? await runLocalCliOperationWithDeadline(
              operation.localCli,
              {
                ...(options.fileResolver === undefined
                  ? {}
                  : { fileResolver: options.fileResolver }),
                environment: options.environment,
                ...(options.signal === undefined
                  ? {}
                  : { signal: options.signal }),
                ...(options.registerCleanupBarrier === undefined
                  ? {}
                  : { registerCleanupBarrier: options.registerCleanupBarrier }),
                beforeDispatch: (event) =>
                  persistDispatchProgress(event, "starting"),
                ...(isWrite
                  && exactTargetReconciliationKind
                    === "provider-accepted-target-presence"
                  ? {
                    afterProviderAcceptedMutationTarget:
                      persistProviderBoundMutationTarget,
                  }
                  : {}),
                ...(isWrite
                  && exactTargetReconciliationKind
                    === "provider-bound-target-desired-state"
                  ? {
                    afterProviderBoundMutationTarget:
                      persistProviderBoundMutationTarget,
                  }
                  : {}),
                afterDispatchVerified: (event) =>
                  persistDispatchProgress(event, "verified"),
              },
              async (executionOptions: LocalCliExecutionOptions) => {
                if (
                  pluginResolution === null
                  || pluginResolution.binding.transport !== "local-cli"
                ) {
                  throw new Error(
                    "local CLI operation resolved to the wrong plugin transport",
                  );
                }
                return (options.executeLocalCli
                  ?? pluginResolution.binding.execute)(
                  invocation.manifest,
                  operation.localCli,
                  invocation.input,
                  persistedAuthAuthority(invocation.auth),
                  executionOptions,
                );
              },
            )
        : reviewedTemplateOperation
          ? await (options.executeReviewedTemplate ?? executeReviewedTemplateOperation)(
              invocation.manifest,
              invocation.operationId,
              operation.reviewedTemplate,
              invocation.input,
              persistedAuthAuthority(invocation.auth),
              {
                beforeDispatch: (event) => persistDispatchProgress(event, "starting"),
                afterDispatchVerified: (event) => persistDispatchProgress(event, "verified"),
              },
            )
          : await (options.executeRecipe ?? executeBrowserRecipe)(
          invocation.manifest,
          operation.browser,
          invocation.input,
          persistedAuthAuthority(invocation.auth),
          {
            headed: options.headed,
            ...(options.fileResolver === undefined ? {} : { fileResolver: options.fileResolver }),
            beforeDispatch: (event) => persistDispatchProgress(event, "starting"),
            afterDispatchVerified: (event) => persistDispatchProgress(event, "verified"),
          },
        );
    try {
      execution = boundedExecutionResult(rawExecution, executionKind, maxOutputBytes);
    } catch {
      const { started } = durableReceipt.dispatch;
      execution = {
        status: started > 0 ? "indeterminate" : "failed",
        output: null,
        finalUrl: null,
        dispatchStarted: started > 0,
        dispatch: durableReceipt.dispatch,
        error: GENERIC_EXECUTOR_TERMINATION,
      };
    }
  } catch (error) {
    const { started } = durableReceipt.dispatch;
    const preservedArtifactsError =
      error instanceof PreservedBrowserArtifactsError
        ? error
        : error instanceof WebSessionCleanupUnverifiedError
          && error.cause instanceof PreservedBrowserArtifactsError
          ? error.cause
          : null;
    execution = {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: null,
      dispatchStarted: started > 0,
      dispatch: durableReceipt.dispatch,
      error: preservedArtifactsError !== null
        ? "provider browser cleanup could not be verified; private artifacts were preserved and durable cleanup admission requires wrench doctor before retry"
        : error instanceof WebSessionCleanupUnverifiedError
          ? localCliOperation
            ? "local CLI child/private-root cleanup could not be verified; durable cleanup admission blocks retry until wrench doctor proves every pinned process group quiescent and removes the exact private root, or reboot recovery proves quiescence"
            : "authenticated web cleanup could not be verified; durable cleanup admission blocks retry until wrench doctor proves exact browser-closed evidence, or reboot recovery proves quiescence"
          : boundedThrownExecutorReason(error),
      ...(operation.risk === "R1"
        && error instanceof WebSessionCleanupUnverifiedError
        ? { readFailure: readFailureProjection("cleanup-required") }
        : operation.risk === "R1"
          && started === 0
          && error instanceof OperationDeadlineError
          && error.failure === "timed-out"
          ? { readFailure: readFailureProjection("operation-timeout") }
          : {}),
      ...(preservedArtifactsError === null
        ? {}
        : {
            privateArtifactsPreserved: true,
            recoveryHandle: preservedArtifactsError.recoveryHandle,
          }),
    };
  }
  const executionNoOp = "noOp" in execution && execution.noOp === true;
  const validExecutionProgress = isDispatchProgress(execution.dispatch)
    && execution.dispatch.planned === planned
    && (execution.readFailure === undefined || operation.risk === "R1")
    && execution.dispatch.started === durableReceipt.dispatch.started
    && execution.dispatch.verified === durableReceipt.dispatch.verified
    && execution.dispatchStarted === (execution.dispatch.started > 0)
    && (!executionNoOp || (
      isWrite
      && planned > 0
      && execution.status === "succeeded"
      && execution.dispatch.started === 0
      && execution.dispatch.verified === 0
      && execution.dispatchStarted === false
    ))
    && (execution.status !== "succeeded" || executionNoOp || (
      execution.dispatch.started === planned && execution.dispatch.verified === planned
    ))
    && (execution.status !== "failed" || execution.dispatch.started === 0)
    && (execution.status !== "partial" || (
      execution.dispatch.verified > 0
      && execution.dispatch.started === execution.dispatch.verified
      && execution.dispatch.verified < planned
    ))
    && (execution.status !== "indeterminate" || execution.dispatch.started > 0);
  if (!validExecutionProgress) {
    const { started } = durableReceipt.dispatch;
    execution = {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: null,
      dispatchStarted: started > 0,
      dispatch: durableReceipt.dispatch,
      error: "provider executor returned invalid dispatch progress",
    };
  }
  const receiptStatus: RunReceipt["status"] = execution.status === "succeeded"
    ? isWrite && !executionNoOp ? "submitted" : "succeeded"
    : execution.status;
  const readFailure = operation.risk === "R1" && receiptStatus === "failed"
    ? execution.readFailure ?? readFailureProjection("contract-drift")
    : undefined;
  const publishedOutput = readFailure === undefined ? execution.output : null;
  const finishedAt = (options.now ?? new Date()).toISOString();
  const privateArtifactsPreserved = "privateArtifactsPreserved" in execution
    && execution.privateArtifactsPreserved === true;
  const recoveryHandle = boundedRecoveryHandle("recoveryHandle" in execution ? execution.recoveryHandle : undefined);
  const privateArtifactRecoveryMessage = privateArtifactsPreserved
    ? `private browser artifacts were preserved; manual recovery is required unless wrench doctor can remove exact browser-closed artifacts, and reboot is required when quiescence evidence is unavailable${recoveryHandle === null
        ? ""
        : `; recovery handle: ${recoveryHandle}`}`
    : null;
  const apiOperation = providerOperation
    || webSessionOperation
    || localCliOperation
    || reviewedTemplateOperation;
  const transportLabel = providerOperation
    ? "official API"
    : webSessionOperation
      ? "authenticated web API"
      : localCliOperation
        ? "local CLI"
        : reviewedTemplateOperation
          ? "reviewed authenticated API"
          : "browser";
  const providerReason = apiOperation && execution.error !== undefined
    ? redactSensitiveText(execution.error).slice(0, 2_000)
    : null;
  const withProviderReason = (message: string): string => providerReason === null
    ? message
    : `${message}; reason: ${providerReason}`;
  let receipt: RunReceipt = withTransport({
    runId,
    planDigest,
    adapter,
    operation: invocation.operationId,
    risk: operation.risk,
    inputHash,
    auth,
    status: receiptStatus,
    dispatchStarted: execution.dispatch.started > 0,
    dispatch: execution.dispatch,
    startedAt,
    finishedAt,
    finalOrigin: finalOrigin(execution.finalUrl, invocation.manifest.origins),
    error: execution.error === undefined
      ? null
      : privateArtifactRecoveryMessage !== null
        ? privateArtifactRecoveryMessage
        : redactSensitiveText(receiptStatus === "partial"
            ? withProviderReason(`${transportLabel} stopped after verified dispatches before completing the confirmed schedule; reconcile before retrying`)
            : receiptStatus === "indeterminate"
              ? withProviderReason(`${transportLabel} result is indeterminate after the dispatch boundary`)
              : apiOperation
                ? withProviderReason(`${transportLabel} operation failed before the dispatch boundary`)
                : "browser recipe failed before the dispatch boundary"),
  });
  if (journal !== null) {
    if (
      receiptStatus !== "succeeded"
      && receiptStatus !== "submitted"
      && receiptStatus !== "failed"
      && receiptStatus !== "partial"
      && receiptStatus !== "indeterminate"
    ) {
      throw new Error("remote write produced an unsupported terminal journal status");
    }
    try {
      journal = updateRunJournal(journal, {
        type: "finished",
        status: receiptStatus,
        finalOrigin: receipt.finalOrigin,
        error: receipt.error,
        ...(executionNoOp ? { noOp: true as const } : {}),
        at: finishedAt,
      }, options.environment);
      receipt = runJournalReceipt(journal.journal);
    } catch {
      try {
        const reloaded = readRunJournal(runId, options.environment);
        if (reloaded !== null) journal = reloaded;
      } catch {
        // Retain the last exact durable snapshot.
      }
    }
    if (journal.journal.phase === "terminal") {
      receipt = runJournalReceipt(journal.journal);
      try {
        projectRunJournal(journal.journal, options.environment);
      } catch {
        // The terminal journal remains the source of truth for later repair.
      }
      return {
        receipt,
        output: publishedOutput,
        replayed: false,
        privateArtifactsPreserved,
        ...(recoveryHandle === null ? {} : { recoveryHandle }),
      };
    }
    const pending = runJournalReceipt(journal.journal);
    return {
      receipt: {
        ...pending,
        error: `${execution.dispatch.started > 0
          ? `${transportLabel} execution crossed dispatch, but its final run journal could not be stored; reconcile this run before any retry`
          : `${transportLabel} execution ended before dispatch, but its final run journal could not be stored; run wrench doctor before retrying`}${privateArtifactRecoveryMessage === null
            ? ""
            : `; ${privateArtifactRecoveryMessage}`}`,
      },
      output: null,
      replayed: false,
      privateArtifactsPreserved,
      ...(recoveryHandle === null ? {} : { recoveryHandle }),
    };
  }
  try {
    persistReceipt(receipt, options.environment);
  } catch {
    return {
      receipt: {
        ...receipt,
        status: "failed",
        error: `${transportLabel} read completed, but its final receipt could not be stored${privateArtifactRecoveryMessage === null
          ? ""
          : `; ${privateArtifactRecoveryMessage}`}`,
      },
      output: null,
      replayed: false,
      readFailure: readFailure?.category === "cleanup-required"
        ? readFailure
        : readFailureProjection("contract-drift"),
      privateArtifactsPreserved,
      ...(recoveryHandle === null ? {} : { recoveryHandle }),
    };
  }
  return {
    receipt,
    output: publishedOutput,
    replayed: false,
    ...(readFailure === undefined ? {} : { readFailure }),
    privateArtifactsPreserved,
    ...(recoveryHandle === null ? {} : { recoveryHandle }),
  };
}

async function runPrepared(
  invocation: PreparedInvocation,
  planDigest: string | null,
  options: RunPreparedOptions,
): Promise<InvocationResult> {
  const registry = options.registry ?? providerPluginRegistry;
  const checked = revalidatePreparedInvocation(invocation, registry);
  const portableIdentity =
    checked.invocation.portablePluginContract ?? null;
  const runId = options.runId ?? crypto.randomUUID();
  const pluginResolution = resolveCodeOwnedPluginOperation(
    checked.operation,
    registry,
  );
  if (portableIdentity === null) {
    if (
      (
        isWebSessionOperation(checked.operation)
        || isLocalCliOperation(checked.operation)
      )
      && pluginResolution !== null
      && !isPublicWebSessionInvocationAuthority(checked.invocation.auth)
    ) {
      const executionIdentityHash = pluginResolution.binding.transport
          === "local-cli"
        ? sha256(canonicalJson({
            transport: "local-cli",
            tool: pluginResolution.binding.tool,
            artifact: localCliToolArtifactForCurrentRuntime(
              pluginResolution.binding.tool,
            ),
          }))
        : registry.implementationHash(pluginResolution.binding).toString("hex");
      const cleanupIdentity: WebSessionCleanupAdmissionIdentity = {
        runId,
        pluginId: pluginResolution.plugin.id,
        pluginVersion: pluginResolution.plugin.version,
        pluginImplementationHash: registry
          .implementationHash(pluginResolution.binding)
          .toString("hex"),
        adapterId: checked.invocation.manifest.id,
        adapterHash: manifestHash(checked.invocation.manifest),
        surfaceId: pluginResolution.binding.surfaceId,
        authId: checked.invocation.auth.id,
        authHash: authHash(checked.invocation.auth),
        transport: isLocalCliOperation(checked.operation)
          ? "local-cli"
          : "web-session-api",
        executionIdentityHash,
      };
      return withWebSessionCleanupAdmission(
        cleanupIdentity,
        options.environment,
        (registerCleanupBarrier) => runPreparedCore(
          checked.invocation,
          planDigest,
          {
            ...options,
            runId,
            registerCleanupBarrier,
          },
        ),
        options.now,
      );
    }
    return runPreparedCore(
      checked.invocation,
      planDigest,
      { ...options, runId },
    );
  }
  const now = options.now ?? new Date();
  const lease = acquirePortableProviderPluginInvocationLease(
    portableIdentity,
    runId,
    options.environment,
    now,
  );
  const containment =
    createPortableProviderPluginInvocationLeaseContainmentController(
      lease,
      options.environment,
    );
  const outcome = await settlePortableProviderPluginCleanup(
    () => runPreparedCore(
      checked.invocation,
      planDigest,
      { ...options, runId },
    ),
    {
      containment,
      cleanupComplete: containment.cleanupComplete,
    },
  );
  releasePortableProviderPluginInvocationLease(
    containment.current,
    options.environment,
    new Date(),
  );
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

export async function executeReadInvocation(
  invocation: PreparedInvocation,
  options: {
    readonly headed: boolean;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly registry?: ProviderPluginRegistry;
    readonly executeRecipe?: typeof executeBrowserRecipe;
    readonly executeProvider?: typeof executeProviderOperation;
    readonly executeWebSession?: WebSessionOperationExecutor;
    readonly executeLocalCli?: LocalCliOperationExecutor;
    readonly executePublicWebSession?: PublicWebSessionOperationExecutor;
    readonly executeReviewedTemplate?: typeof executeReviewedTemplateOperation;
    readonly signal?: AbortSignal;
    readonly persistReceipt?: (receipt: RunReceipt, environment: Readonly<Record<string, string | undefined>>) => void;
  },
): Promise<InvocationResult> {
  const operation = invocation.manifest.operations[invocation.operationId];
  if (operation?.risk !== "R1") throw new Error("remote writes require preview and confirmation");
  return runPrepared(invocation, null, {
    headed: options.headed,
    environment: options.environment ?? process.env,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.executeRecipe === undefined ? {} : { executeRecipe: options.executeRecipe }),
    ...(options.executeProvider === undefined ? {} : { executeProvider: options.executeProvider }),
    ...(options.executeWebSession === undefined ? {} : { executeWebSession: options.executeWebSession }),
    ...(options.executeLocalCli === undefined ? {} : { executeLocalCli: options.executeLocalCli }),
    ...(options.executePublicWebSession === undefined
      ? {}
      : { executePublicWebSession: options.executePublicWebSession }),
    ...(options.executeReviewedTemplate === undefined ? {} : { executeReviewedTemplate: options.executeReviewedTemplate }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.persistReceipt === undefined ? {} : { persistReceipt: options.persistReceipt }),
  });
}

export async function confirmInvocation(
  digest: string,
  options: {
    readonly headed: boolean;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly registry?: ProviderPluginRegistry;
    readonly loadManifest?: typeof loadInstalledManifest;
    readonly now?: Date;
    readonly executeRecipe?: typeof executeBrowserRecipe;
    readonly executeProvider?: typeof executeProviderOperation;
    readonly executeWebSession?: WebSessionOperationExecutor;
    readonly executeLocalCli?: LocalCliOperationExecutor;
    readonly executeReviewedTemplate?: typeof executeReviewedTemplateOperation;
    readonly signal?: AbortSignal;
    readonly persistReceipt?: (receipt: RunReceipt, environment: Readonly<Record<string, string | undefined>>) => void;
  },
): Promise<InvocationResult> {
  const environment = options.environment ?? process.env;
  if (loadInvocationPlan(digest, environment).plan.messagingComposite !== undefined) {
    throw new Error(
      "messaging composite execution is unavailable until a reviewed provider executor is installed",
    );
  }
  const registry = options.registry ?? providerPluginRegistry;
  const now = options.now ?? new Date();
  const claimRepair = repairInterruptedConfirmationClaims(environment);
  const journalRepair = repairInterruptedRunJournals(environment, now);
  if (claimRepair.invalid > 0 || journalRepair.issues.length > 0) {
    throw new Error(
      "local execution recovery has unresolved state; run wrench doctor before confirming",
    );
  }
  const runId = crypto.randomUUID();
  const claim = acquireConfirmationClaim(
    digest,
    runId,
    environment,
    now,
  );
  let stored: StoredPlan | null = null;
  let invocation: PreparedInvocation | null = null;
  try {
    stored = loadInvocationPlan(digest, environment);
    const loadManifest: typeof loadInstalledManifest = options.loadManifest
      ?? ((adapterId, selectedEnvironment = process.env) =>
        loadInstalledManifestWithRegistry(adapterId, selectedEnvironment, registry));
    invocation = validateFreshPlan(
      stored,
      environment,
      now,
      registry,
      loadManifest,
    );
    if (stored.plan.duplicateRisk !== undefined) {
      const current = resolveInvocationDuplicateRisk(
        stored.plan,
        [stored.plan.duplicateRisk.sourceRunId],
        environment,
      );
      if (
        current === undefined
        || canonicalJson(current) !== canonicalJson(stored.plan.duplicateRisk)
      ) {
        throw new Error(
          "duplicate-risk source evidence changed after preview; inspect the source run and preview again",
        );
      }
    }
  } finally {
    if (invocation === null && stored !== null) {
      if (removePrivateStateFile(planPath(digest, environment), environment)) {
        if (!planDigestHasRetainingJournal(digest, environment)) {
          cleanupPlanAssets(digest, environment);
        }
      }
      releaseConfirmationClaim(claim, environment);
    } else if (invocation === null) {
      releaseConfirmationClaim(claim, environment);
    }
  }
  let result: InvocationResult | null = null;
  let runPreparedStarted = false;
  try {
    const fileInputs: FileInputValue[] = [];
    for (const value of Object.values(invocation.input)) {
      if (isInputArray(value)) {
        for (const item of value) {
          if (isFileInputValue(item)) fileInputs.push(item);
        }
      } else if (isFileInputValue(value)) fileInputs.push(value);
    }
    // Verify every bound byte before crossing either execution boundary. Keep
    // this inside cleanup so a corrupt or missing bundle never becomes orphaned.
    if (fileInputs.length > 0) resolvePlanAssetFiles(fileInputs, digest, environment);
    const operation = invocation.manifest.operations[invocation.operationId];
    if (operation?.risk !== "R2" && operation?.risk !== "R3") {
      throw new Error("only R2 and R3 plans use confirmation");
    }
    runPreparedStarted = true;
    result = await runPrepared(invocation, digest, {
      headed: options.headed,
      environment,
      registry,
      ...(fileInputs.length === 0 ? {} : {
        fileResolver: (files) => Promise.resolve(resolvePlanAssetFiles(files, digest, environment)),
      }),
      hasPlanAssets: fileInputs.length > 0,
      runId,
      confirmationClaim: claim,
      confirmedDispatches: stored.plan.dispatches,
      ...(stored.plan.duplicateRisk === undefined
        ? {}
        : { duplicateRisk: stored.plan.duplicateRisk }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.executeRecipe === undefined ? {} : { executeRecipe: options.executeRecipe }),
      ...(options.executeProvider === undefined ? {} : { executeProvider: options.executeProvider }),
      ...(options.executeWebSession === undefined ? {} : { executeWebSession: options.executeWebSession }),
      ...(options.executeLocalCli === undefined ? {} : { executeLocalCli: options.executeLocalCli }),
      ...(options.executeReviewedTemplate === undefined ? {} : { executeReviewedTemplate: options.executeReviewedTemplate }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.persistReceipt === undefined ? {} : { persistReceipt: options.persistReceipt }),
    });
    return result;
  } finally {
    if (!runPreparedStarted && result === null && stored !== null) {
      removePrivateStateFile(planPath(digest, environment), environment);
      if (!planDigestHasRetainingJournal(digest, environment)) {
        cleanupPlanAssets(digest, environment);
      }
    }
    releaseConfirmationClaim(claim, environment);
  }
}

export type MessagingConfirmationResult = {
  readonly run: MessagingRunV1;
  readonly receipt: MessagingRunReceipt;
  readonly receiptBinding: MessagingReceiptBinding;
  readonly ordinaryReceipt: RunReceipt;
};

function terminalizeMessagingRecovery(
  runId: string,
  environment: Readonly<Record<string, string | undefined>>,
  observedAt: Date,
): MessagingRunV1 {
  const snapshot = readMessagingRun(runId, environment);
  if (snapshot.run.state !== "pending") return snapshot.run;
  const active = snapshot.run.parts[snapshot.run.provenPartCount];
  if (active === undefined) {
    throw new Error("pending messaging recovery has no active part");
  }
  const at = Math.max(
    observedAt.getTime(),
    Date.parse(snapshot.run.recordedAt),
  );
  const event = active.state === "dispatching"
    ? {
        type: "indeterminate" as const,
        index: snapshot.run.provenPartCount,
        reason: "journal-recovery-required" as const,
        at: new Date(at).toISOString(),
      }
    : active.state === "unattempted" || active.state === "claimed"
      ? {
          type: "categorical-stop" as const,
          index: snapshot.run.provenPartCount,
          partState: snapshot.run.provenPartCount === 0
            ? "failed-before-dispatch" as const
            : "failed-permanent" as const,
          reason: "journal-recovery-required" as const,
          at: new Date(at).toISOString(),
        }
      : null;
  if (event === null) {
    throw new Error("pending messaging recovery state is contradictory");
  }
  return updateMessagingRun(snapshot, event, environment).run;
}

/** Confirm one composite messaging preview under one durable ownership claim. */
export async function confirmMessagingInvocation(
  digest: string,
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly registry?: ProviderPluginRegistry;
    readonly loadManifest?: typeof loadInstalledManifest;
    readonly now?: Date;
    readonly signal?: AbortSignal;
    /** Internal deterministic-clock seam for per-bubble deadline tests. */
    readonly deadlineClock?: OperationDeadlineClock;
  } = {},
): Promise<MessagingConfirmationResult> {
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? providerPluginRegistry;
  const observation = options.now ?? new Date();
  if (!Number.isFinite(observation.getTime())) {
    throw new Error("messaging confirmation time is invalid");
  }
  const claimRepair = repairInterruptedConfirmationClaims(environment);
  const journalRepair = repairInterruptedRunJournals(environment, observation);
  if (claimRepair.invalid > 0 || journalRepair.issues.length > 0) {
    throw new Error(
      "local execution recovery has unresolved state; run wrench doctor before confirming",
    );
  }
  const runId = crypto.randomUUID();
  const claim = acquireConfirmationClaim(digest, runId, environment, observation);
  let planConsumed = false;
  let terminal = false;
  let stored: StoredPlan | null = null;
  let run: MessagingRunV1 | null = null;
  try {
    stored = loadInvocationPlan(digest, environment);
    if (stored.plan.messagingComposite === undefined) {
      throw new Error("confirmation plan is not a messaging composite");
    }
    if (
      stored.plan.messagingComposite.contextBindingSha256 === null
      || stored.plan.messagingComposite.sourceConversationCoordinateSha256 === null
    ) {
      throw new Error(
        "predecessor messaging plan lacks current context evidence; preview the action again",
      );
    }
    if (stored.plan.duplicateRisk !== undefined) {
      throw new Error("messaging composite confirmations cannot accept duplicate risk");
    }
    const loadManifest: typeof loadInstalledManifest = options.loadManifest
      ?? ((adapterId, selectedEnvironment = process.env) =>
        loadInstalledManifestWithRegistry(adapterId, selectedEnvironment, registry));
    const invocation = validateFreshPlan(
      stored,
      environment,
      observation,
      registry,
      loadManifest,
    );
    const messagingRuntime = await import("./messaging-runtime");
    let snapshot = messagingRuntime.initializeMessagingCompositeRunInternal(
      stored,
      runId,
      { environment, now: observation },
    );
    run = snapshot.run;
    writeReceipt(messagingReceiptForPlan(stored, run), environment);
    if (!removePrivateStateFile(planPath(digest, environment), environment)) {
      run = terminalizeMessagingRecovery(runId, environment, observation);
      const ordinaryReceipt = messagingReceiptForPlan(stored, run);
      writeReceipt(ordinaryReceipt, environment);
      terminal = true;
      return Object.freeze({
        run,
        receipt: messagingRunReceipt(run),
        receiptBinding: messagingReceiptBinding(run),
        ordinaryReceipt,
      });
    }
    planConsumed = true;
    try {
      snapshot = await messagingRuntime.executeMessagingCompositeInternal(
        stored,
        invocation,
        snapshot,
        {
          environment,
          registry,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.deadlineClock === undefined
            ? {}
            : { deadlineClock: options.deadlineClock }),
        },
      );
      run = snapshot.run;
    } catch {
      run = terminalizeMessagingRecovery(runId, environment, observation);
    }
    if (run.state === "pending") {
      throw new Error(
        "messaging execution remained pending; run wrench doctor before another write",
      );
    }
    const ordinaryReceipt = messagingReceiptForPlan(stored, run);
    writeReceipt(ordinaryReceipt, environment);
    terminal = true;
    return Object.freeze({
      run,
      receipt: messagingRunReceipt(run),
      receiptBinding: messagingReceiptBinding(run),
      ordinaryReceipt,
    });
  } finally {
    if (!terminal && run !== null && run.state === "pending" && !planConsumed) {
      try {
        run = terminalizeMessagingRecovery(runId, environment, observation);
        if (stored !== null) {
          writeReceipt(messagingReceiptForPlan(stored, run), environment);
        }
        terminal = true;
      } catch {
        // Keep the claim as a durable recovery witness when local journaling
        // itself cannot prove that no effect crossed the provider boundary.
      }
    }
    if (terminal || !planConsumed) {
      releaseConfirmationClaim(claim, environment);
    }
  }
}

export function readRunReceipt(
  runId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RunReceipt {
  return parseRunReceiptValue(
    runId,
    readJsonFile(receiptPath(runId, environment)),
  );
}

function parseRunReceiptValue(runId: string, value: unknown): RunReceipt {
  if (!isRecord(value) || value.runId !== runId) {
    throw new Error("run receipt is malformed");
  }
  const legacy = value.schemaVersion === 1;
  const providerReceipt = value.schemaVersion === 3;
  const webSessionReceipt = value.schemaVersion === 4;
  const reviewedTemplateReceipt = value.schemaVersion === 5;
  const portablePluginReceipt = value.schemaVersion === 6;
  const localCliReceipt = value.schemaVersion === 7;
  const keys = legacy
    ? [
        "schemaVersion", "runId", "planDigest", "adapter", "operation", "risk", "inputHash", "auth", "transport", "status",
        "dispatchStarted", "startedAt", "finishedAt", "finalOrigin", "error",
      ]
    : providerReceipt
      ? [
          "schemaVersion", "runId", "planDigest", "adapter", "operation", "risk", "inputHash", "auth", "transport", "status",
          "dispatchStarted", "dispatch", "startedAt", "finishedAt", "finalOrigin", "error", "providerContractHash",
        ]
      : webSessionReceipt
        ? [
          "schemaVersion", "runId", "planDigest", "adapter", "operation", "risk", "inputHash", "auth", "transport", "status",
          "dispatchStarted", "dispatch", "startedAt", "finishedAt", "finalOrigin", "error", "webSessionContractHash",
        ]
        : reviewedTemplateReceipt
          ? [
            "schemaVersion", "runId", "planDigest", "adapter", "operation", "risk", "inputHash", "auth", "transport", "status",
            "dispatchStarted", "dispatch", "startedAt", "finishedAt", "finalOrigin", "error", "reviewedTemplateContractHash",
          ]
          : portablePluginReceipt
            ? [
              "schemaVersion", "runId", "planDigest", "adapter", "operation", "risk", "inputHash", "auth", "transport", "status",
              "dispatchStarted", "dispatch", "startedAt", "finishedAt", "finalOrigin", "error", "portablePluginContract",
            ]
            : localCliReceipt
              ? [
                "schemaVersion", "runId", "planDigest", "adapter", "operation", "risk", "inputHash", "auth", "transport", "status",
                "dispatchStarted", "dispatch", "startedAt", "finishedAt", "finalOrigin", "error", "localCliContract",
              ]
            : [
              "schemaVersion", "runId", "planDigest", "adapter", "operation", "risk", "inputHash", "auth", "transport", "status",
              "dispatchStarted", "dispatch", "startedAt", "finishedAt", "finalOrigin", "error",
            ];
  if (
    (
      !legacy
      && value.schemaVersion !== 2
      && value.schemaVersion !== 3
      && value.schemaVersion !== 4
      && value.schemaVersion !== 5
      && value.schemaVersion !== 6
      && value.schemaVersion !== 7
    )
    || !hasExactKeys(value, keys)
  ) throw new Error("run receipt is malformed");
  let portablePluginContract: PortableOperationIdentityV1 | null = null;
  let localCliContract: LocalCliContractIdentityV1 | null = null;
  if (portablePluginReceipt) {
    portablePluginContract = parsePortableOperationIdentityV1(
      value.portablePluginContract,
    );
  }
  if (localCliReceipt) {
    localCliContract = parseLocalCliContractIdentityV1(value.localCliContract);
  }
  const { planDigest, operation, risk, inputHash, transport, status, dispatchStarted, startedAt, finishedAt, finalOrigin, error } = value;
  const dispatch: RunReceipt["dispatch"] = legacy && typeof dispatchStarted === "boolean"
    ? {
        planned: dispatchStarted ? 1 : 0,
        started: dispatchStarted ? 1 : 0,
        verified: status === "submitted" && dispatchStarted ? 1 : 0,
      }
    : isDispatchProgress(value.dispatch) ? value.dispatch : { planned: -1, started: -1, verified: -1 };
  if (
    (planDigest !== null && (typeof planDigest !== "string" || !/^[a-f0-9]{64}$/u.test(planDigest)))
    || !isProviderPluginOperationName(operation)
    || typeof risk !== "string"
    || !operationRisks.includes(risk as OperationRisk)
    || typeof inputHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(inputHash)
    || (providerReceipt
      ? transport !== "provider-api"
      : webSessionReceipt
        ? transport !== "web-session-api"
        : reviewedTemplateReceipt
          ? transport !== "reviewed-template-api"
          : portablePluginReceipt
            ? transport !== "portable-provider-plugin"
            : localCliReceipt
              ? transport !== "local-cli"
              : transport !== "browser")
    || (providerReceipt && (typeof value.providerContractHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.providerContractHash)))
    || (webSessionReceipt && (typeof value.webSessionContractHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.webSessionContractHash)))
    || (reviewedTemplateReceipt
      && (typeof value.reviewedTemplateContractHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.reviewedTemplateContractHash)))
    || (status !== "pending" && status !== "succeeded" && status !== "submitted" && status !== "failed" && status !== "partial" && status !== "indeterminate")
    || typeof dispatchStarted !== "boolean"
    || !isDispatchProgress(dispatch)
    || dispatchStarted !== (dispatch.started > 0)
    || typeof startedAt !== "string"
    || typeof finishedAt !== "string"
    || (finalOrigin !== null && typeof finalOrigin !== "string")
    || (
      error !== null
      && (
        typeof error !== "string"
        || Buffer.byteLength(error, "utf8") > MAX_RUN_RECEIPT_ERROR_BYTES
      )
    )
    || !isRecord(value.adapter)
    || !isRecord(value.auth)
  ) throw new Error("run receipt is malformed");
  const adapter = value.adapter;
  const auth = value.auth;
  if (
    !hasExactKeys(adapter, ["id", "version", "hash"])
    || !hasExactKeys(auth, ["id", "hash", "kind"])
    || typeof adapter.id !== "string"
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(adapter.id)
    || typeof adapter.version !== "string"
    || adapter.version.length < 1
    || adapter.version.length > 64
    || typeof adapter.hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(adapter.hash)
    || typeof auth.id !== "string"
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(auth.id)
    || typeof auth.hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(auth.hash)
    || (auth.kind !== "cookie-source" && auth.kind !== "cookies-file" && auth.kind !== "browser-profile" && auth.kind !== "oauth-token-file" && auth.kind !== "linked-device-store" && auth.kind !== "public-web-session")
  ) throw new Error("run receipt is malformed");
  if (auth.kind === "public-web-session") {
    const expected = publicWebSessionInvocationAuthority(adapter.id, operation);
    if (
      !webSessionReceipt
      || risk !== "R1"
      || planDigest !== null
      || dispatchStarted
      || dispatch.planned !== 0
      || auth.id !== expected.id
      || auth.hash !== authHash(expected)
    ) {
      throw new Error("run receipt public invocation authority is malformed");
    }
  }
  const common: RunReceiptCommon = {
    runId,
    planDigest,
    adapter: { id: adapter.id, version: adapter.version, hash: adapter.hash },
    operation,
    risk: risk as OperationRisk,
    inputHash,
    auth: {
      id: auth.id,
      hash: auth.hash,
      kind: auth.kind as InvocationAuthority["kind"],
    },
    status,
    dispatchStarted,
    dispatch,
    startedAt,
    finishedAt,
    finalOrigin,
    error,
  };
  if (portablePluginReceipt && portablePluginContract !== null) {
    if (
      portablePluginContract.adapterId !== adapter.id
      || portablePluginContract.operation !== operation
    ) {
      throw new Error("run receipt portable plugin route is malformed");
    }
    return {
      ...common,
      schemaVersion: 6,
      transport: "portable-provider-plugin",
      portablePluginContract,
    };
  }
  if (localCliReceipt && localCliContract !== null) {
    if (localCliContract.action !== operation) {
      throw new Error("run receipt local CLI route is malformed");
    }
    return {
      ...common,
      schemaVersion: 7,
      transport: "local-cli",
      localCliContract,
    };
  }
  return providerReceipt
    ? {
        ...common,
        schemaVersion: 3,
        transport: "provider-api",
        providerContractHash: value.providerContractHash as string,
      }
    : webSessionReceipt
      ? {
          ...common,
          schemaVersion: 4,
          transport: "web-session-api",
          webSessionContractHash: value.webSessionContractHash as string,
        }
      : reviewedTemplateReceipt
        ? {
            ...common,
            schemaVersion: 5,
            transport: "reviewed-template-api",
            reviewedTemplateContractHash: value.reviewedTemplateContractHash as string,
          }
        : { ...common, schemaVersion: 2, transport: "browser" };
}

export type ListedRunReceipt = RunReceipt | { readonly runId: string; readonly invalid: true };

export function listRunReceipts(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly ListedRunReceipt[] {
  const directory = join(wrenchStateHome(environment), "runs");
  const snapshot = snapshotPrivateStateDirectory(directory, environment);
  if (snapshot.identity === null) return [];
  const names = snapshot.entries
    .filter((entry) => entry.kind === "file" && /^[0-9a-f-]{36}\.json$/u.test(entry.name))
    .map((entry) => entry.name);
  const values = readPrivateStateFilesBatched(directory, names, {
    maximumBytesPerFile: MAX_WRENCH_JSON_BYTES,
    environment,
    expectedDirectoryIdentity: snapshot.identity,
  }).map((file): ListedRunReceipt => {
    const runId = file.name.slice(0, -5);
    if (file.status !== "present") return { runId, invalid: true };
    try {
      return parseRunReceiptValue(
        runId,
        JSON.parse(file.content) as unknown,
      );
    } catch {
      return { runId, invalid: true };
    }
  });
  return values.sort((left, right) => {
    const leftTime = "startedAt" in left ? Date.parse(left.startedAt) : Number.NEGATIVE_INFINITY;
    const rightTime = "startedAt" in right ? Date.parse(right.startedAt) : Number.NEGATIVE_INFINITY;
    return rightTime - leftTime || left.runId.localeCompare(right.runId);
  });
}
