import {
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth, saveAuth, type WrenchAuth } from "./auth";
import { canonicalJson, sha256, type OperationInput, type WebSessionRecipe } from "./model";
import {
  listReconciliationObservations,
  readProviderAcceptedMutationTargetEvidence,
  readRecoveryCapsule,
  writeProviderAcceptedMutationTargetEvidence,
  writeRecoveryCapsule,
  type RecoveryCapsule,
} from "./recovery";
import {
  createRunJournal,
  parseRunJournal,
  readRunJournal,
  updateRunJournal,
  type RunJournal,
} from "./run-journal";
import { planAssetBundlePath } from "./plan-assets";
import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
  type ProviderPluginReconciliationContextV1,
  type WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";
import { createProviderPluginRegistry } from "./provider-plugin-registry";
import type { RunReceipt } from "./runtime";
import { writePrivateJson } from "./storage";
import {
  LEGACY_X_CONTENT_SAVE_ADAPTER_HASH,
  LEGACY_X_CONTENT_SAVE_CONTRACT_HASH,
  PRE_PROVIDER_PLUGIN_X_ADAPTER_HASH,
  PRE_PROVIDER_PLUGIN_X_ADAPTER_VERSION,
  PRE_PROVIDER_PLUGIN_X_CONTENT_SAVE_CONTRACT_HASH,
  PRE_PROVIDER_PLUGIN_X_LIKES_SET_CONTRACT_HASH,
  reconcileWebSessionRun,
} from "./web-session-recovery";
import {
  getWebSessionContract,
  webSessionContractHash,
} from "./web-session-contracts";
import { providerPluginRegistry } from "./provider-plugins";

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

type WebSessionRecoveryCapsule = Omit<RecoveryCapsule, "contract"> & {
  readonly contract: Extract<
    RecoveryCapsule["contract"],
    { readonly transport: "web-session-api" }
  >;
};

const RUN_ID = "30000000-0000-4000-8000-000000000003";
const PLAN_DIGEST = "1".repeat(64);
const CURRENT_ADAPTER_HASH = "2".repeat(64);
const POST_ID = "2078889282404569267";

type RecoveryOperation =
  | "articles.draft.save"
  | "content.save"
  | "likes.set";

function state(): TestState {
  const directory = mkdtempSync(join(tmpdir(), "wrench-web-recovery-test-"));
  chmodSync(directory, 0o700);
  return { directory, environment: { WRENCH_STATE_HOME: directory } };
}

function xAuth(profile = "Profile 1"): WrenchAuth {
  return createAuth("x-main", {
    source: "arc",
    profile,
    subject: "12345",
  });
}

function recipe(operation: RecoveryOperation): WebSessionRecipe {
  return operation === "articles.draft.save"
    ? {
        site: "x",
        action: operation,
        contractVersion: 1,
        timeoutMs: 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
      }
    : operation === "content.save"
    ? {
        site: "x",
        action: operation,
        contractVersion: 1,
        timeoutMs: 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
      }
    : {
        site: "x",
        action: operation,
        contractVersion: 2,
        timeoutMs: 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
      };
}

function desiredInput(operation: RecoveryOperation): OperationInput {
  return operation === "articles.draft.save"
    ? {
        title: "Uncertain private Article create",
        document: canonicalJson({
          schemaVersion: 1,
          blocks: [{ type: "paragraph", text: "Reviewed private draft body" }],
        }),
      }
    : operation === "content.save"
    ? { post_id: POST_ID, saved: true }
    : { post_id: POST_ID, liked: false };
}

function receipt(
  auth: WrenchAuth,
  options: {
    readonly operation?: RecoveryOperation;
    readonly legacy?: boolean;
    readonly preProviderPlugin?: boolean;
    readonly status?: RunReceipt["status"];
    readonly risk?: RunReceipt["risk"];
    readonly dispatch?: RunReceipt["dispatch"];
  } = {},
): Extract<RunReceipt, { readonly schemaVersion: 4 }> {
  const operation = options.operation ?? "content.save";
  const input = desiredInput(operation);
  const legacy = options.legacy === true;
  const preProviderPlugin = options.preProviderPlugin === true;
  return {
    schemaVersion: 4,
    transport: "web-session-api",
    runId: RUN_ID,
    planDigest: PLAN_DIGEST,
    adapter: {
      id: "x-web",
      version: legacy
        ? "1.0.0"
        : preProviderPlugin
        ? PRE_PROVIDER_PLUGIN_X_ADAPTER_VERSION
        : "2.0.0",
      hash: legacy
        ? LEGACY_X_CONTENT_SAVE_ADAPTER_HASH
        : preProviderPlugin
        ? PRE_PROVIDER_PLUGIN_X_ADAPTER_HASH
        : CURRENT_ADAPTER_HASH,
    },
    operation,
    risk: options.risk ?? "R2",
    inputHash: sha256(canonicalJson(input)),
    auth: {
      id: auth.id,
      hash: sha256(canonicalJson(auth)),
      kind: auth.kind,
    },
    status: options.status ?? "indeterminate",
    dispatchStarted: true,
    dispatch: options.dispatch ?? { planned: 1, started: 1, verified: 0 },
    startedAt: "2026-07-23T12:00:00.000Z",
    finishedAt: "2026-07-23T12:00:01.000Z",
    finalOrigin: "https://x.com",
    error: "authenticated web API result is indeterminate after the dispatch boundary",
    webSessionContractHash: legacy
      ? LEGACY_X_CONTENT_SAVE_CONTRACT_HASH
      : preProviderPlugin
      ? operation === "content.save"
        ? PRE_PROVIDER_PLUGIN_X_CONTENT_SAVE_CONTRACT_HASH
        : PRE_PROVIDER_PLUGIN_X_LIKES_SET_CONTRACT_HASH
      : webSessionContractHash(
          getWebSessionContract(recipe(operation), providerPluginRegistry),
          providerPluginRegistry,
        ),
  };
}

function capsuleFor(
  selectedReceipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>,
  input: OperationInput,
  overrides: Partial<WebSessionRecoveryCapsule> = {},
): WebSessionRecoveryCapsule {
  const selectedRecipe = recipe(selectedReceipt.operation as RecoveryOperation);
  return {
    schemaVersion: 1,
    runId: selectedReceipt.runId,
    createdAt: selectedReceipt.startedAt,
    planDigest: selectedReceipt.planDigest as string,
    adapter: selectedReceipt.adapter,
    operation: selectedReceipt.operation,
    risk: "R2",
    input,
    inputHash: selectedReceipt.inputHash,
    auth: selectedReceipt.auth,
    contract: {
      transport: "web-session-api",
      site: "x",
      action: selectedReceipt.operation,
      version: selectedRecipe.contractVersion,
      hash: selectedReceipt.webSessionContractHash,
    },
    ...overrides,
  };
}

function installCurrentRun(
  testState: TestState,
  operation: RecoveryOperation = "content.save",
): {
  readonly auth: WrenchAuth;
  readonly input: OperationInput;
  readonly receipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>;
  readonly receiptPath: string;
} {
  const auth = xAuth();
  saveAuth(auth, testState.environment);
  const selectedReceipt = receipt(auth, { operation });
  const input = desiredInput(operation);
  const receiptPath = join(testState.directory, "runs", `${RUN_ID}.json`);
  writePrivateJson(receiptPath, selectedReceipt, { privateParent: true });
  writeRecoveryCapsule(capsuleFor(selectedReceipt, input), testState.environment);
  return { auth, input, receipt: selectedReceipt, receiptPath };
}

function installRecoveryBundle(testState: TestState): string {
  const bundle = planAssetBundlePath(PLAN_DIGEST, testState.environment);
  mkdirSync(bundle, { recursive: true, mode: 0o700 });
  writeFileSync(join(bundle, "asset-01.png"), "private recovery attachment", { mode: 0o600 });
  return bundle;
}

function terminalJournalFor(
  selectedReceipt: Extract<RunReceipt, { readonly schemaVersion: 4 }>,
  options: {
    readonly error?: string;
    readonly ledgerRelativePath?: string;
    readonly hasPlanAssets?: boolean;
  } = {},
): RunJournal {
  const hasPlanAssets = options.hasPlanAssets ?? true;
  return parseRunJournal({
    schemaVersion: 1,
    revision: 5,
    runId: selectedReceipt.runId,
    planDigest: selectedReceipt.planDigest,
    adapter: selectedReceipt.adapter,
    operation: selectedReceipt.operation,
    risk: selectedReceipt.risk,
    inputHash: selectedReceipt.inputHash,
    auth: selectedReceipt.auth,
    contract: {
      transport: "web-session-api",
      hash: selectedReceipt.webSessionContractHash,
    },
    planHasAssets: hasPlanAssets,
    planState: "consumed",
    phase: "terminal",
    status: selectedReceipt.status,
    dispatch: selectedReceipt.dispatch,
    ledgerRelativePath: options.ledgerRelativePath
      ?? `idempotency/aa/${selectedReceipt.inputHash}.json`,
    ledgerState: selectedReceipt.status,
    recoveryState: "retained",
    assetState: hasPlanAssets ? "retained" : "none",
    owner: {
      pid: 2_147_483_647,
      token: "40000000-0000-4000-8000-000000000004",
      bootId: "a".repeat(64),
      processStartId: "b".repeat(64),
      leaseUntil: new Date(
        Date.parse(selectedReceipt.startedAt) + 90_000,
      ).toISOString(),
    },
    startedAt: selectedReceipt.startedAt,
    updatedAt: selectedReceipt.finishedAt,
    dedupeExpiresAt: new Date(
      Date.parse(selectedReceipt.startedAt) + 86_400_000,
    ).toISOString(),
    finalOrigin: selectedReceipt.finalOrigin,
    error: options.error ?? selectedReceipt.error,
  });
}

function ledgerFor(
  journal: RunJournal,
  overrides: Partial<{
    readonly keyHash: string;
    readonly adapterHash: string;
    readonly authHash: string;
    readonly inputHash: string;
    readonly planDigest: string;
    readonly status: "pending" | "succeeded" | "partial" | "indeterminate";
    readonly runId: string;
  }> = {},
) {
  return {
    schemaVersion: 2,
    keyHash: overrides.keyHash ?? journal.inputHash,
    adapterHash: overrides.adapterHash ?? journal.adapter.hash,
    authHash: overrides.authHash ?? journal.auth.hash,
    inputHash: overrides.inputHash ?? journal.inputHash,
    planDigest: overrides.planDigest ?? journal.planDigest,
    status: overrides.status ?? "indeterminate",
    dispatch: journal.dispatch,
    runId: overrides.runId ?? journal.runId,
    updatedAt: journal.updatedAt,
    expiresAt: journal.dedupeExpiresAt,
  } as const;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const PRESENCE_RUN_ID = "80000000-0000-4000-8000-000000000008";
const PRESENCE_PLAN_DIGEST = "8".repeat(64);
const PRESENCE_TARGET = "presence:post:private-123";
const presenceOperation: WebSessionPluginOperationDefinitionV1 = {
  name: "posts.publish",
  contractVersion: 1,
  risk: "R3",
  input: {
    properties: {
      body: {
        type: "string",
        description: "Exact post body",
        minLength: 1,
        maxLength: 2_000,
      },
    },
    required: ["body"],
  },
  sideEffect: "publishes one post",
  idempotency: "local-at-most-once",
  dedupeWindowMs: 86_400_000,
  state: "observed",
  dispatch: "single",
  implementation: "synthetic accepted-target presence fixture",
  planDispatches: () => [{
    id: "posts.publish",
    description: "Publish one post",
  }],
  validateInput: (input) => typeof input.body === "string"
    ? []
    : ["input.body must be a string"],
  reconciliation: {
    kind: "provider-accepted-target-presence",
  },
};

function presenceRegistry() {
  const plugin = defineProviderPlugin({
    apiVersion: 1,
    id: "presence-test-plugin",
    version: "1.0.0",
    displayName: "Presence Test Plugin",
    sourceKind: "source",
    implementationSources: [{
      label: "plugin.ts",
      url: new URL("./provider-plugin-test-fixture.ts", import.meta.url),
    }],
    bindings: [{
      transport: "web-session-api",
      surfaceId: "presence-test",
      origin: "https://presence-test.example",
      authKinds: ["cookie-source"],
      operations: [presenceOperation],
      subject: {
        format: "presence:<id>",
        matches: (value) => /^presence:[a-z0-9-]{1,40}$/u.test(value),
      },
      runtime: lazyWebSessionRuntime(() => Promise.resolve({
        probe: () => Promise.resolve("presence:viewer"),
        execute: () => Promise.resolve({
          status: "failed",
          output: null,
          finalUrl: null,
          dispatchStarted: false,
          dispatch: { planned: 1, started: 0, verified: 0 },
          error: "inert recovery fixture",
        }),
        reconcile: () => Promise.resolve({
          actualState: true,
          reason: "synthetic presence",
        }),
      })),
    }],
  });
  return createProviderPluginRegistry([plugin]);
}

function installPresenceRun(
  testState: TestState,
  withTargetEvidence: boolean,
) {
  const registry = presenceRegistry();
  const auth = createAuth("presence-main", {
    source: "arc",
    profile: "Profile 1",
    subject: "presence:viewer",
  });
  saveAuth(auth, testState.environment);
  const input = { body: "private presence reconciliation body" };
  const selectedRecipe: WebSessionRecipe = {
    site: "presence-test",
    action: "posts.publish",
    contractVersion: 1,
    timeoutMs: 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
  };
  const contractHash = webSessionContractHash(
    getWebSessionContract(selectedRecipe, registry),
    registry,
  );
  const selectedReceipt: Extract<
    RunReceipt,
    { readonly schemaVersion: 4 }
  > = {
    schemaVersion: 4,
    transport: "web-session-api",
    runId: PRESENCE_RUN_ID,
    planDigest: PRESENCE_PLAN_DIGEST,
    adapter: {
      id: "presence-test-web",
      version: "1.0.0",
      hash: sha256("presence-test-adapter"),
    },
    operation: "posts.publish",
    risk: "R3",
    inputHash: sha256(canonicalJson(input)),
    auth: {
      id: auth.id,
      hash: sha256(canonicalJson(auth)),
      kind: auth.kind,
    },
    status: "indeterminate",
    dispatchStarted: true,
    dispatch: { planned: 1, started: 1, verified: 0 },
    startedAt: "2026-08-18T12:00:00.000Z",
    finishedAt: "2026-08-18T12:00:01.000Z",
    finalOrigin: "https://presence-test.example",
    error: "authenticated web API result is indeterminate after the dispatch boundary",
    webSessionContractHash: contractHash,
  };
  const selectedCapsule: WebSessionRecoveryCapsule = {
    schemaVersion: 1,
    runId: selectedReceipt.runId,
    createdAt: selectedReceipt.startedAt,
    planDigest: PRESENCE_PLAN_DIGEST,
    adapter: selectedReceipt.adapter,
    operation: selectedReceipt.operation,
    risk: "R3",
    input,
    inputHash: selectedReceipt.inputHash,
    auth: selectedReceipt.auth,
    contract: {
      transport: "web-session-api",
      site: "presence-test",
      action: "posts.publish",
      version: 1,
      hash: contractHash,
    },
  };
  writePrivateJson(
    join(testState.directory, "runs", `${PRESENCE_RUN_ID}.json`),
    selectedReceipt,
    { privateParent: true },
  );
  writeRecoveryCapsule(selectedCapsule, testState.environment);
  if (withTargetEvidence) {
    writeProviderAcceptedMutationTargetEvidence({
      schemaVersion: 1,
      runId: selectedCapsule.runId,
      acceptedAt: "2026-08-18T12:00:00.500Z",
      planDigest: selectedCapsule.planDigest,
      adapter: selectedCapsule.adapter,
      operation: selectedCapsule.operation,
      inputHash: selectedCapsule.inputHash,
      auth: selectedCapsule.auth,
      contract: selectedCapsule.contract,
      dispatch: { id: "posts.publish", index: 1, planned: 1 },
      target: { schemaVersion: 1, identifier: PRESENCE_TARGET },
    }, testState.environment);
  }
  return Object.freeze({
    auth,
    input,
    receipt: selectedReceipt,
    capsule: selectedCapsule,
    recipe: selectedRecipe,
    registry,
  });
}

describe("web-session run reconciliation", () => {
  test("reconciles an exact provider-accepted target only when it is present", async () => {
    const testState = state();
    try {
      const installed = installPresenceRun(testState, true);
      let observedContext: ProviderPluginReconciliationContextV1 | undefined;
      const result = await reconcileWebSessionRun(
        PRESENCE_RUN_ID,
        undefined,
        {
          environment: testState.environment,
          registry: installed.registry,
          now: new Date("2026-08-18T12:00:02.000Z"),
          dependencies: {
            observeActualState: (selectedRecipe, input, auth, context) => {
              expect(selectedRecipe).toEqual(installed.recipe);
              expect(input).toEqual(installed.input);
              expect(auth).toEqual(installed.auth);
              observedContext = context;
              return Promise.resolve({
                actualState: true,
                reason: "exact target readback",
              });
            },
          },
        },
      );

      expect(observedContext).toEqual({
        schemaVersion: 1,
        kind: "provider-accepted-target-presence",
        dispatch: { id: "posts.publish", index: 1, planned: 1 },
        target: { schemaVersion: 1, identifier: PRESENCE_TARGET },
      });
      expect(result).toMatchObject({
        ok: true,
        status: "reconciliation-observed",
        recoveryArtifactsReleased: true,
        observation: {
          outcome: "desired-state-observed",
          desiredStateMatched: true,
          actualState: true,
          reason: "exact-readback",
        },
      });
      expect(JSON.stringify(result)).not.toContain(PRESENCE_TARGET);
      expect(readRecoveryCapsule(
        PRESENCE_RUN_ID,
        installed.auth.id,
        installed.receipt.auth.hash,
        testState.environment,
      )).toBeNull();
      expect(existsSync(join(
        testState.directory,
        "recovery",
        "provider-accepted-targets",
        PRESENCE_RUN_ID,
      ))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retains exact source evidence when successor election wins reconciliation CAS", async () => {
    const testState = state();
    try {
      const installed = installPresenceRun(testState, true);
      const journal = terminalJournalFor(installed.receipt, {
        hasPlanAssets: false,
      });
      createRunJournal(journal, testState.environment);
      if (journal.ledgerRelativePath === null) {
        throw new Error("expected duplicate-risk source ledger coordinate");
      }
      const ledgerPath = join(
        testState.directory,
        ...journal.ledgerRelativePath.split("/"),
      );
      writePrivateJson(ledgerPath, ledgerFor(journal), {
        privateParent: true,
      });
      const capsulePath = join(
        testState.directory,
        "recovery",
        "capsules",
        `${PRESENCE_RUN_ID}.json`,
      );
      const targetPath = join(
        testState.directory,
        "recovery",
        "provider-accepted-targets",
        PRESENCE_RUN_ID,
        "1.json",
      );
      const receiptBefore = readFileSync(
        join(testState.directory, "runs", `${PRESENCE_RUN_ID}.json`),
        "utf8",
      );
      const ledgerBefore = readFileSync(ledgerPath, "utf8");
      const capsuleBefore = readFileSync(capsulePath, "utf8");
      const targetBefore = readFileSync(targetPath, "utf8");

      const result = await reconcileWebSessionRun(
        PRESENCE_RUN_ID,
        undefined,
        {
          environment: testState.environment,
          registry: installed.registry,
          now: new Date("2026-08-18T12:00:03.000Z"),
          dependencies: {
            observeActualState: () => {
              const source = readRunJournal(
                PRESENCE_RUN_ID,
                testState.environment,
              );
              if (source === null) throw new Error("source journal missing");
              updateRunJournal(source, {
                type: "duplicate-successor-claimed",
                intentHash: "9".repeat(64),
                runId: "90000000-0000-4000-8000-000000000009",
                at: "2026-08-18T12:00:02.000Z",
              }, testState.environment);
              return Promise.resolve({
                actualState: true,
                reason: "exact target readback",
              });
            },
          },
        },
      );

      expect(result).toMatchObject({
        ok: true,
        status: "reconciliation-observed",
        receiptUnchanged: true,
        providerWriteDispatched: false,
        recoveryArtifactsReleased: false,
      });
      expect(readRunJournal(
        PRESENCE_RUN_ID,
        testState.environment,
      )?.journal).toMatchObject({
        status: "indeterminate",
        ledgerState: "indeterminate",
        recoveryState: "retained",
        duplicateSuccessor: {
          intentHash: "9".repeat(64),
          runId: "90000000-0000-4000-8000-000000000009",
        },
      });
      expect(listReconciliationObservations(
        PRESENCE_RUN_ID,
        testState.environment,
      )).toHaveLength(1);
      expect(readFileSync(
        join(testState.directory, "runs", `${PRESENCE_RUN_ID}.json`),
        "utf8",
      )).toBe(receiptBefore);
      expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
      expect(readFileSync(capsulePath, "utf8")).toBe(capsuleBefore);
      expect(readFileSync(targetPath, "utf8")).toBe(targetBefore);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects targetless historical create runs before provider readback", async () => {
    const testState = state();
    try {
      const installed = installPresenceRun(testState, false);
      let readbacks = 0;
      const message = await rejectionMessage(reconcileWebSessionRun(
        PRESENCE_RUN_ID,
        undefined,
        {
          environment: testState.environment,
          registry: installed.registry,
          dependencies: {
            observeActualState: () => {
              readbacks += 1;
              return Promise.resolve({
                actualState: true,
                reason: "must not run",
              });
            },
          },
        },
      ));

      expect(message).toContain("no encrypted response-derived target");
      expect(message).toContain("not safely reconcilable");
      expect(readbacks).toBe(0);
      expect(listReconciliationObservations(
        PRESENCE_RUN_ID,
        testState.environment,
      )).toEqual([]);
      expect(readRecoveryCapsule(
        PRESENCE_RUN_ID,
        installed.auth.id,
        installed.receipt.auth.hash,
        testState.environment,
      )).toEqual(installed.capsule);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("treats accepted-target absence as inconclusive and retains recovery", async () => {
    const testState = state();
    try {
      const installed = installPresenceRun(testState, true);
      const result = await reconcileWebSessionRun(
        PRESENCE_RUN_ID,
        undefined,
        {
          environment: testState.environment,
          registry: installed.registry,
          dependencies: {
            observeActualState: () => Promise.resolve({
              actualState: false,
              reason: "exact target absent",
            }),
          },
        },
      );

      expect(result).toMatchObject({
        ok: false,
        status: "reconciliation-inconclusive",
        recoveryArtifactsReleased: false,
        observation: {
          outcome: "inconclusive",
          desiredStateMatched: null,
          actualState: null,
          reason: "readback-failed",
        },
      });
      expect(JSON.stringify(result)).not.toContain("exact target absent");
      expect(readRecoveryCapsule(
        PRESENCE_RUN_ID,
        installed.auth.id,
        installed.receipt.auth.hash,
        testState.environment,
      )).toEqual(installed.capsule);
      expect(readProviderAcceptedMutationTargetEvidence(
        installed.capsule,
        { id: "posts.publish", index: 1, planned: 1 },
        testState.environment,
      )?.target.identifier).toBe(PRESENCE_TARGET);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("treats accepted-target provider errors as inconclusive and retains recovery", async () => {
    const testState = state();
    try {
      const installed = installPresenceRun(testState, true);
      const result = await reconcileWebSessionRun(
        PRESENCE_RUN_ID,
        undefined,
        {
          environment: testState.environment,
          registry: installed.registry,
          dependencies: {
            observeActualState: () => Promise.reject(
              new Error("private provider error containing secret target"),
            ),
          },
        },
      );

      expect(result).toMatchObject({
        ok: false,
        status: "reconciliation-inconclusive",
        recoveryArtifactsReleased: false,
        observation: {
          outcome: "inconclusive",
          desiredStateMatched: null,
          actualState: null,
          reason: "readback-failed",
        },
      });
      expect(JSON.stringify(result)).not.toContain("private provider error");
      expect(readRecoveryCapsule(
        PRESENCE_RUN_ID,
        installed.auth.id,
        installed.receipt.auth.hash,
        testState.environment,
      )).toEqual(installed.capsule);
      expect(readProviderAcceptedMutationTargetEvidence(
        installed.capsule,
        { id: "posts.publish", index: 1, planned: 1 },
        testState.environment,
      )?.target.identifier).toBe(PRESENCE_TARGET);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("records a matching exact R1 readback without changing the receipt or ledger", async () => {
    const testState = state();
    try {
      const installed = installCurrentRun(testState);
      const recoveryBundle = installRecoveryBundle(testState);
      const ledgerPath = join(testState.directory, "idempotency", "aa", "guard.json");
      writePrivateJson(ledgerPath, { immutable: "ledger-evidence" }, { privateParent: true });
      const receiptBefore = readFileSync(installed.receiptPath, "utf8");
      const ledgerBefore = readFileSync(ledgerPath, "utf8");
      const calls: Array<{
        readonly recipe: WebSessionRecipe;
        readonly input: OperationInput;
        readonly auth: WrenchAuth;
      }> = [];

      const result = await reconcileWebSessionRun(RUN_ID, undefined, {
        environment: testState.environment,
        now: new Date("2026-07-23T12:02:00.000Z"),
        dependencies: {
          observeActualState: (selectedRecipe, input, auth) => {
            calls.push({ recipe: selectedRecipe, input, auth });
            return Promise.resolve({
              actualState: true,
              reason: "deterministic-test-readback",
            });
          },
        },
      });

      expect(result).toMatchObject({
        ok: true,
        status: "reconciliation-observed",
        runId: RUN_ID,
        originalReceiptStatus: "indeterminate",
        receiptUnchanged: true,
        providerWriteDispatched: false,
        recoveryArtifactsReleased: true,
        observation: {
          inputSource: "capsule",
          outcome: "desired-state-observed",
          desiredStateMatched: true,
          actualState: true,
          reason: "exact-readback",
        },
      });
      expect(calls).toEqual([{
        recipe: recipe("content.save"),
        input: desiredInput("content.save"),
        auth: installed.auth,
      }]);
      expect(readFileSync(installed.receiptPath, "utf8")).toBe(receiptBefore);
      expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
      expect(listReconciliationObservations(RUN_ID, testState.environment))
        .toEqual([result.observation]);
      expect(readRecoveryCapsule(
        RUN_ID,
        installed.auth.id,
        sha256(canonicalJson(installed.auth)),
        testState.environment,
      )).toBeNull();
      expect(existsSync(recoveryBundle)).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses indeterminate Article creates before readback and retains every recovery artifact", async () => {
    const testState = state();
    try {
      const installed = installCurrentRun(testState, "articles.draft.save");
      expect(installed.input).not.toHaveProperty("draft_id");
      const recoveryBundle = installRecoveryBundle(testState);
      const journal = terminalJournalFor(installed.receipt);
      createRunJournal(journal, testState.environment);
      if (journal.ledgerRelativePath === null) {
        throw new Error("expected an Article create ledger coordinate");
      }
      const ledgerPath = join(
        testState.directory,
        ...journal.ledgerRelativePath.split("/"),
      );
      writePrivateJson(ledgerPath, ledgerFor(journal), {
        privateParent: true,
      });
      const capsuleBefore = readRecoveryCapsule(
        RUN_ID,
        installed.auth.id,
        sha256(canonicalJson(installed.auth)),
        testState.environment,
      );
      const journalBefore = readRunJournal(RUN_ID, testState.environment)?.journal;
      const receiptBefore = readFileSync(installed.receiptPath);
      const ledgerBefore = readFileSync(ledgerPath);
      const assetPath = join(recoveryBundle, "asset-01.png");
      const assetBefore = readFileSync(assetPath);
      let readbacks = 0;
      let releases = 0;

      const message = await rejectionMessage(reconcileWebSessionRun(
        RUN_ID,
        undefined,
        {
          environment: testState.environment,
          dependencies: {
            observeActualState: () => {
              readbacks += 1;
              return Promise.resolve({
                actualState: true,
                reason: "must-not-run",
              });
            },
            releaseRecoveryArtifacts: () => {
              releases += 1;
            },
          },
        },
      ));

      expect(message).toContain(
        "X articles.draft.save create has no safe reconciliation because input.draft_id is absent",
      );
      expect(message).toContain("preserve the indeterminate run and do not retry");
      expect(readbacks).toBe(0);
      expect(releases).toBe(0);
      expect(listReconciliationObservations(RUN_ID, testState.environment))
        .toEqual([]);
      expect(readRecoveryCapsule(
        RUN_ID,
        installed.auth.id,
        sha256(canonicalJson(installed.auth)),
        testState.environment,
      )).toEqual(capsuleBefore);
      expect(readRunJournal(RUN_ID, testState.environment)?.journal)
        .toEqual(journalBefore);
      expect(readFileSync(installed.receiptPath)).toEqual(receiptBefore);
      expect(readFileSync(ledgerPath)).toEqual(ledgerBefore);
      expect(readFileSync(assetPath)).toEqual(assetBefore);
      expect(existsSync(recoveryBundle)).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("journal-backed reconciliation releases only the matching receipt while preserving successor state", async () => {
    const testState = state();
    try {
      const installed = installCurrentRun(testState);
      const recoveryBundle = installRecoveryBundle(testState);
      const journal = terminalJournalFor(installed.receipt);
      createRunJournal(journal, testState.environment);
      const successor = parseRunJournal({
        ...journal,
        revision: 0,
        runId: "50000000-0000-4000-8000-000000000005",
        planState: "available",
        phase: "prepared",
        status: "pending",
        dispatch: { planned: 1, started: 0, verified: 0 },
        ledgerRelativePath: null,
        ledgerState: "unclaimed",
        recoveryState: "absent",
        assetState: "none",
        owner: {
          ...journal.owner,
          token: "50000000-0000-4000-8000-000000000005",
          leaseUntil: "2026-07-23T12:04:00.000Z",
        },
        startedAt: "2026-07-23T12:01:00.000Z",
        updatedAt: "2026-07-23T12:01:00.000Z",
        dedupeExpiresAt: "2026-07-24T12:01:00.000Z",
        finalOrigin: null,
        error: "execution was prepared but no durable final outcome was recorded",
      });
      createRunJournal(successor, testState.environment);
      const successorJournalBefore = readRunJournal(
        successor.runId,
        testState.environment,
      )?.journal;
      if (journal.ledgerRelativePath === null) {
        throw new Error("expected a journal ledger coordinate");
      }
      const journalLedgerPath = join(
        testState.directory,
        ...journal.ledgerRelativePath.split("/"),
      );
      writePrivateJson(journalLedgerPath, ledgerFor(journal), {
        privateParent: true,
      });
      const successorRunId = "70000000-0000-4000-8000-000000000007";
      const successorPath = join(
        testState.directory,
        "idempotency",
        "aa",
        `${journal.inputHash}.${"f".repeat(64)}.json`,
      );
      writePrivateJson(successorPath, ledgerFor(journal, {
        planDigest: "e".repeat(64),
        runId: successorRunId,
      }), { privateParent: true });
      const successorLedgerBefore = readFileSync(successorPath, "utf8");

      writePrivateJson(installed.receiptPath, {
        ...installed.receipt,
        error: "synthetic stale receipt projection",
      }, { privateParent: true });
      expect(await rejectionMessage(reconcileWebSessionRun(
        RUN_ID,
        undefined,
        {
          environment: testState.environment,
          now: new Date(installed.receipt.finishedAt),
          dependencies: {
            observeActualState: () => Promise.resolve({
              actualState: true,
              reason: "deterministic-test-readback",
            }),
          },
        },
      ))).toContain("recovery artifacts could not be fully released");
      expect(readRunJournal(RUN_ID, testState.environment)?.journal)
        .toMatchObject({
          phase: "terminal",
          status: "indeterminate",
          recoveryState: "retained",
          assetState: "retained",
        });
      expect(readRecoveryCapsule(
        RUN_ID,
        installed.auth.id,
        sha256(canonicalJson(installed.auth)),
        testState.environment,
      )).not.toBeNull();
      expect(existsSync(recoveryBundle)).toBeTrue();
      expect(readFileSync(successorPath, "utf8")).toBe(successorLedgerBefore);

      writePrivateJson(
        installed.receiptPath,
        installed.receipt,
        { privateParent: true },
      );
      const receiptBefore = readFileSync(installed.receiptPath, "utf8");
      const result = await reconcileWebSessionRun(RUN_ID, undefined, {
        environment: testState.environment,
        now: new Date("2026-07-23T12:02:00.000Z"),
        dependencies: {
          observeActualState: () => Promise.resolve({
            actualState: true,
            reason: "deterministic-test-readback",
          }),
        },
      });

      expect(result).toMatchObject({
        ok: true,
        receiptUnchanged: true,
        providerWriteDispatched: false,
        recoveryArtifactsReleased: true,
      });
      expect(readFileSync(installed.receiptPath, "utf8")).toBe(receiptBefore);
      expect(readRunJournal(RUN_ID, testState.environment)?.journal)
        .toMatchObject({
          phase: "terminal",
          status: "indeterminate",
          ledgerState: "indeterminate",
          recoveryState: "released",
          assetState: "released",
        });
      expect(readRecoveryCapsule(
        RUN_ID,
        installed.auth.id,
        sha256(canonicalJson(installed.auth)),
        testState.environment,
      )).toBeNull();
      expect(existsSync(recoveryBundle)).toBeTrue();
      expect(readFileSync(successorPath, "utf8")).toBe(successorLedgerBefore);
      expect(readRunJournal(successor.runId, testState.environment)?.journal)
        .toEqual(successorJournalBefore);
      expect(JSON.parse(readFileSync(journalLedgerPath, "utf8")))
        .toMatchObject({
          runId: RUN_ID,
          status: "indeterminate",
        });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("stores the matching observation before cleanup and retains artifacts when cleanup fails", async () => {
    const testState = state();
    try {
      const installed = installCurrentRun(testState);
      const recoveryBundle = installRecoveryBundle(testState);
      const receiptBefore = readFileSync(installed.receiptPath, "utf8");
      let releases = 0;

      expect(await rejectionMessage(reconcileWebSessionRun(RUN_ID, undefined, {
        environment: testState.environment,
        dependencies: {
          observeActualState: () =>
            Promise.resolve({
              actualState: true,
              reason: "deterministic-test-readback",
            }),
          releaseRecoveryArtifacts: () => {
            releases += 1;
            expect(listReconciliationObservations(RUN_ID, testState.environment))
              .toHaveLength(1);
            expect(readRecoveryCapsule(
              RUN_ID,
              installed.auth.id,
              sha256(canonicalJson(installed.auth)),
              testState.environment,
            )).not.toBeNull();
            expect(existsSync(recoveryBundle)).toBeTrue();
            throw new Error("synthetic cleanup failure");
          },
        },
      }))).toContain("observation was stored");

      expect(releases).toBe(1);
      expect(readFileSync(installed.receiptPath, "utf8")).toBe(receiptBefore);
      expect(readRecoveryCapsule(
        RUN_ID,
        installed.auth.id,
        sha256(canonicalJson(installed.auth)),
        testState.environment,
      )).not.toBeNull();
      expect(existsSync(recoveryBundle)).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("records absence as an observation, never as proof the earlier write did not happen", async () => {
    const testState = state();
    try {
      const installed = installCurrentRun(testState, "likes.set");
      const recoveryBundle = installRecoveryBundle(testState);
      const result = await reconcileWebSessionRun(RUN_ID, undefined, {
        environment: testState.environment,
        dependencies: {
          observeActualState: () =>
            Promise.resolve({
              actualState: true,
              reason: "deterministic-test-readback",
            }),
        },
      });

      expect(result).toMatchObject({
        ok: false,
        status: "reconciliation-observed",
        originalReceiptStatus: "indeterminate",
        receiptUnchanged: true,
        providerWriteDispatched: false,
        recoveryArtifactsReleased: false,
        observation: {
          outcome: "desired-state-not-observed",
          desiredStateMatched: false,
          actualState: true,
          reason: "exact-readback",
        },
      });
      expect(readRecoveryCapsule(
        RUN_ID,
        installed.auth.id,
        sha256(canonicalJson(installed.auth)),
        testState.environment,
      )).not.toBeNull();
      expect(existsSync(recoveryBundle)).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "readback failure",
      readback: () => Promise.reject(new Error("private provider diagnostic")),
    },
    {
      label: "wrong actual state type",
      readback: () =>
        Promise.resolve({
          actualState: "true",
          reason: "deterministic-test-readback",
        }),
    },
    {
      label: "empty readback reason",
      readback: () =>
        Promise.resolve({ actualState: true, reason: "" }),
    },
  ])("records $label as inconclusive without leaking the diagnostic", async ({ readback }) => {
    const testState = state();
    try {
      const installed = installCurrentRun(testState);
      const recoveryBundle = installRecoveryBundle(testState);
      const receiptBefore = readFileSync(installed.receiptPath, "utf8");
      const result = await reconcileWebSessionRun(RUN_ID, undefined, {
        environment: testState.environment,
        dependencies: { observeActualState: readback },
      });

      expect(result).toMatchObject({
        ok: false,
        status: "reconciliation-inconclusive",
        originalReceiptStatus: "indeterminate",
        receiptUnchanged: true,
        providerWriteDispatched: false,
        recoveryArtifactsReleased: false,
        observation: {
          outcome: "inconclusive",
          desiredStateMatched: null,
          actualState: null,
          reason: "readback-failed",
        },
      });
      expect(JSON.stringify(result)).not.toContain("private provider diagnostic");
      expect(readFileSync(installed.receiptPath, "utf8")).toBe(receiptBefore);
      expect(readRecoveryCapsule(
        RUN_ID,
        installed.auth.id,
        sha256(canonicalJson(installed.auth)),
        testState.environment,
      )).not.toBeNull();
      expect(existsSync(recoveryBundle)).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test.each([
    {
      operation: "content.save" as const,
      contractHash: PRE_PROVIDER_PLUGIN_X_CONTENT_SAVE_CONTRACT_HASH,
    },
    {
      operation: "likes.set" as const,
      contractHash: PRE_PROVIDER_PLUGIN_X_LIKES_SET_CONTRACT_HASH,
    },
  ])(
    "accepts the exact pre-provider-plugin X $operation contract as a read-only, target-bound readback",
    async ({ operation, contractHash }) => {
      const testState = state();
      try {
        const auth = xAuth();
        saveAuth(auth, testState.environment);
        const selectedReceipt = receipt(auth, {
          operation,
          preProviderPlugin: true,
        });
        const input = desiredInput(operation);
        const receiptPath = join(
          testState.directory,
          "runs",
          `${RUN_ID}.json`,
        );
        writePrivateJson(receiptPath, selectedReceipt, {
          privateParent: true,
        });
        writeRecoveryCapsule(
          capsuleFor(selectedReceipt, input),
          testState.environment,
        );
        const receiptBefore = readFileSync(receiptPath, "utf8");
        const calls: Array<{
          readonly recipe: WebSessionRecipe;
          readonly input: OperationInput;
        }> = [];

        const result = await reconcileWebSessionRun(RUN_ID, undefined, {
          environment: testState.environment,
          dependencies: {
            observeActualState: (selectedRecipe, selectedInput) => {
              calls.push({
                recipe: selectedRecipe,
                input: selectedInput,
              });
              return Promise.resolve({
                actualState: operation === "content.save",
                reason: "deterministic-test-readback",
              });
            },
          },
        });

        expect(result).toMatchObject({
          ok: true,
          receiptUnchanged: true,
          providerWriteDispatched: false,
          recoveryArtifactsReleased: true,
          observation: {
            inputSource: "capsule",
            outcome: "desired-state-observed",
            contractHash,
          },
        });
        expect(calls).toEqual([{
          recipe: recipe(operation),
          input,
        }]);
        expect(readFileSync(receiptPath, "utf8")).toBe(receiptBefore);
      } finally {
        rmSync(testState.directory, { recursive: true, force: true });
      }
    },
  );

  test("rejects every near miss of the pre-provider-plugin X compatibility tuples before readback", async () => {
    type ReceiptV4 = Extract<RunReceipt, { readonly schemaVersion: 4 }>;
    type Fixture = {
      readonly receipt: ReceiptV4;
      readonly capsule: WebSessionRecoveryCapsule;
    };
    const changeLastHashDigit = (hash: string): string =>
      `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
    const cases: readonly {
      readonly label: string;
      readonly mutate: (fixture: Fixture) => Fixture;
    }[] = [
      {
        label: "contract hash",
        mutate: ({ receipt: value, capsule }) => {
          const hash = changeLastHashDigit(value.webSessionContractHash);
          return {
            receipt: { ...value, webSessionContractHash: hash },
            capsule: {
              ...capsule,
              contract: { ...capsule.contract, hash },
            },
          };
        },
      },
      {
        label: "operation/hash pairing",
        mutate: ({ receipt: value, capsule }) => ({
          receipt: {
            ...value,
            webSessionContractHash:
              PRE_PROVIDER_PLUGIN_X_LIKES_SET_CONTRACT_HASH,
          },
          capsule: {
            ...capsule,
            contract: {
              ...capsule.contract,
              hash: PRE_PROVIDER_PLUGIN_X_LIKES_SET_CONTRACT_HASH,
            },
          },
        }),
      },
      {
        label: "route action",
        mutate: ({ receipt: value, capsule }) => ({
          receipt: value,
          capsule: {
            ...capsule,
            contract: {
              ...capsule.contract,
              action: "likes.set",
              version: 2,
            },
          },
        }),
      },
      {
        label: "route version",
        mutate: ({ receipt: value, capsule }) => ({
          receipt: value,
          capsule: {
            ...capsule,
            contract: { ...capsule.contract, version: 2 },
          },
        }),
      },
      {
        label: "adapter id",
        mutate: ({ receipt: value, capsule }) => {
          const adapter = { ...value.adapter, id: "x-web-near-miss" };
          return {
            receipt: { ...value, adapter },
            capsule: { ...capsule, adapter },
          };
        },
      },
      {
        label: "adapter version",
        mutate: ({ receipt: value, capsule }) => {
          const adapter = { ...value.adapter, version: "1.1.1" };
          return {
            receipt: { ...value, adapter },
            capsule: { ...capsule, adapter },
          };
        },
      },
      {
        label: "adapter hash",
        mutate: ({ receipt: value, capsule }) => {
          const adapter = {
            ...value.adapter,
            hash: changeLastHashDigit(value.adapter.hash),
          };
          return {
            receipt: { ...value, adapter },
            capsule: { ...capsule, adapter },
          };
        },
      },
      {
        label: "target",
        mutate: ({ receipt: value, capsule }) => {
          const input = { post_id: "1", saved: true };
          return {
            receipt: value,
            capsule: {
              ...capsule,
              input,
              inputHash: sha256(canonicalJson(input)),
            },
          };
        },
      },
    ];

    for (const fixture of cases) {
      const testState = state();
      try {
        const auth = xAuth();
        saveAuth(auth, testState.environment);
        const exactReceipt = receipt(auth, {
          operation: "content.save",
          preProviderPlugin: true,
        });
        const nearMiss = fixture.mutate({
          receipt: exactReceipt,
          capsule: capsuleFor(
            exactReceipt,
            desiredInput("content.save"),
          ),
        });
        writePrivateJson(
          join(testState.directory, "runs", `${RUN_ID}.json`),
          nearMiss.receipt,
          { privateParent: true },
        );
        writeRecoveryCapsule(nearMiss.capsule, testState.environment);
        let reads = 0;

        expect(await rejectionMessage(reconcileWebSessionRun(
          RUN_ID,
          undefined,
          {
            environment: testState.environment,
            dependencies: {
              observeActualState: () => {
                reads += 1;
                return Promise.resolve({
                  actualState: true,
                  reason: "must-not-run",
                });
              },
            },
          },
        )), fixture.label).not.toBe("resolved");
        expect(reads, fixture.label).toBe(0);
      } finally {
        rmSync(testState.directory, { recursive: true, force: true });
      }
    }
  });

  test("requires the capsule for new runs and accepts exact hash-bound input only for the legacy run", async () => {
    const currentState = state();
    try {
      const auth = xAuth();
      saveAuth(auth, currentState.environment);
      const selectedReceipt = receipt(auth);
      writePrivateJson(
        join(currentState.directory, "runs", `${RUN_ID}.json`),
        selectedReceipt,
        { privateParent: true },
      );
      let reads = 0;
      expect(await rejectionMessage(reconcileWebSessionRun(
        RUN_ID,
        desiredInput("content.save"),
        {
          environment: currentState.environment,
          dependencies: {
            observeActualState: () => {
              reads += 1;
              return Promise.resolve({
                actualState: true,
                reason: "deterministic-test-readback",
              });
            },
          },
        },
      ))).toContain("should have an encrypted recovery capsule");
      expect(reads).toBe(0);
    } finally {
      rmSync(currentState.directory, { recursive: true, force: true });
    }

    const legacyState = state();
    try {
      const auth = xAuth();
      saveAuth(auth, legacyState.environment);
      const selectedReceipt = receipt(auth, { legacy: true });
      writePrivateJson(
        join(legacyState.directory, "runs", `${RUN_ID}.json`),
        selectedReceipt,
        { privateParent: true },
      );
      expect(await rejectionMessage(reconcileWebSessionRun(RUN_ID, undefined, {
        environment: legacyState.environment,
      }))).toContain("provide its exact original input");
      expect(await rejectionMessage(reconcileWebSessionRun(
        RUN_ID,
        { post_id: POST_ID, saved: false },
        { environment: legacyState.environment },
      ))).toContain("does not match the run's canonical input hash");

      const result = await reconcileWebSessionRun(
        RUN_ID,
        desiredInput("content.save"),
        {
          environment: legacyState.environment,
          dependencies: {
            observeActualState: () =>
              Promise.resolve({
                actualState: true,
                reason: "deterministic-test-readback",
              }),
          },
        },
      );
      expect(result.observation.inputSource).toBe("provided");
      expect(result.observation.contractHash).toBe(LEGACY_X_CONTENT_SAVE_CONTRACT_HASH);
    } finally {
      rmSync(legacyState.directory, { recursive: true, force: true });
    }
  });

  test("rejects an unknown current contract hash before readback and retains recovery evidence", async () => {
    const testState = state();
    try {
      const auth = xAuth();
      saveAuth(auth, testState.environment);
      const input = desiredInput("content.save");
      const unsupportedHash = "e".repeat(64);
      const selectedReceipt = {
        ...receipt(auth),
        webSessionContractHash: unsupportedHash,
      };
      const receiptPath = join(
        testState.directory,
        "runs",
        `${RUN_ID}.json`,
      );
      writePrivateJson(receiptPath, selectedReceipt, { privateParent: true });
      writeRecoveryCapsule(
        capsuleFor(selectedReceipt, input, {
          contract: {
            transport: "web-session-api",
            site: "x",
            action: "content.save",
            version: 1,
            hash: unsupportedHash,
          },
        }),
        testState.environment,
      );
      const bundle = installRecoveryBundle(testState);
      const capsulePath = join(
        testState.directory,
        "recovery",
        "capsules",
        `${RUN_ID}.json`,
      );
      const receiptBefore = readFileSync(receiptPath);
      const capsuleBefore = readFileSync(capsulePath);
      const assetPath = join(bundle, "asset-01.png");
      const assetBefore = readFileSync(assetPath);
      let reads = 0;

      const message = await rejectionMessage(reconcileWebSessionRun(
        RUN_ID,
        undefined,
        {
          environment: testState.environment,
          dependencies: {
            observeActualState: () => {
              reads += 1;
              return Promise.resolve({
                actualState: true,
                reason: "must-not-run",
              });
            },
          },
        },
      ));

      expect(message).toContain("unsupported authenticated session contract hash");
      expect(message).toContain("were retained");
      expect(message).toContain("`wrench doctor`");
      expect(message).toContain("exact predecessor build");
      expect(message).toContain("manual evidence review");
      expect(reads).toBe(0);
      expect(readFileSync(receiptPath)).toEqual(receiptBefore);
      expect(readFileSync(capsulePath)).toEqual(capsuleBefore);
      expect(readFileSync(assetPath)).toEqual(assetBefore);
      expect(readRecoveryCapsule(
        RUN_ID,
        selectedReceipt.auth.id,
        selectedReceipt.auth.hash,
        testState.environment,
      )).not.toBeNull();
      expect(listReconciliationObservations(RUN_ID, testState.environment))
        .toEqual([]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed on capsule, auth, receipt-state, risk, and dispatch drift before readback", async () => {
    const cases = [
      {
        label: "settled receipt",
        mutateReceipt: (value: ReturnType<typeof receipt>) => ({
          ...value,
          status: "submitted" as const,
        }),
        expected: "only an unsettled run",
      },
      {
        label: "wrong risk",
        mutateReceipt: (value: ReturnType<typeof receipt>) => ({
          ...value,
          risk: "R3" as const,
        }),
        expected: "only exact R2",
      },
      {
        label: "wrong dispatch",
        mutateReceipt: (value: ReturnType<typeof receipt>) => ({
          ...value,
          dispatchStarted: false,
          dispatch: { planned: 1, started: 0, verified: 0 },
        }),
        expected: "exact one-dispatch",
      },
    ] as const;
    for (const fixture of cases) {
      const testState = state();
      try {
        const auth = xAuth();
        saveAuth(auth, testState.environment);
        const selectedReceipt = fixture.mutateReceipt(receipt(auth));
        writePrivateJson(
          join(testState.directory, "runs", `${RUN_ID}.json`),
          selectedReceipt,
          { privateParent: true },
        );
        let reads = 0;
        expect(await rejectionMessage(reconcileWebSessionRun(RUN_ID, undefined, {
          environment: testState.environment,
          dependencies: {
            observeActualState: () => {
              reads += 1;
              return Promise.resolve({
                actualState: true,
                reason: "deterministic-test-readback",
              });
            },
          },
        }))).toContain(fixture.expected);
        expect(reads).toBe(0);
      } finally {
        rmSync(testState.directory, { recursive: true, force: true });
      }
    }

    const capsuleState = state();
    try {
      const installed = installCurrentRun(capsuleState);
      saveAuth(xAuth("Profile 2"), capsuleState.environment, { force: true });
      expect(await rejectionMessage(reconcileWebSessionRun(RUN_ID, undefined, {
        environment: capsuleState.environment,
      }))).toContain("auth locator no longer matches");

      saveAuth(installed.auth, capsuleState.environment, { force: true });
      const mismatched = capsuleFor(installed.receipt, installed.input, {
        createdAt: "2026-07-23T11:59:59.000Z",
      });
      const secondState = state();
      try {
        saveAuth(installed.auth, secondState.environment);
        writePrivateJson(
          join(secondState.directory, "runs", `${RUN_ID}.json`),
          installed.receipt,
          { privateParent: true },
        );
        writeRecoveryCapsule(mismatched, secondState.environment);
        let reads = 0;
        expect(await rejectionMessage(reconcileWebSessionRun(RUN_ID, undefined, {
          environment: secondState.environment,
          dependencies: {
            observeActualState: () => {
              reads += 1;
              return Promise.resolve({
                actualState: true,
                reason: "deterministic-test-readback",
              });
            },
          },
        }))).toContain("does not match the immutable run receipt");
        expect(reads).toBe(0);
      } finally {
        rmSync(secondState.directory, { recursive: true, force: true });
      }
    } finally {
      rmSync(capsuleState.directory, { recursive: true, force: true });
    }
  });
});
