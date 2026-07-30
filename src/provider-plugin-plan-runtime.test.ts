import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAuth,
  saveAuth,
  type WrenchAuth,
} from "./auth";
import {
  parseRuntimeManifest,
  type BrowserDispatchPlan,
  type WrenchManifest,
  type OperationInput,
  type OperationRisk,
} from "./model";
import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
  type ProviderPluginPlanOperationV1,
  type WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";
import {
  createProviderPluginRegistry,
  type ProviderPluginRegistry,
} from "./provider-plugin-registry";
import {
  confirmInvocation,
  createAndSaveInvocationPlan,
  executeReadInvocation,
  type PreparedInvocation,
} from "./runtime";

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

type UnsafePlanner = (input: OperationInput) => unknown;

type RuntimeHarness = {
  readonly registry: ProviderPluginRegistry;
  readonly manifest: WrenchManifest;
  readonly auth: WrenchAuth;
  readonly invocation: PreparedInvocation;
  readonly executions: () => number;
};

const sourcePluginImplementationUrl = new URL(
  "./provider-plugin-test-fixture.ts",
  import.meta.url,
);

function state(): TestState {
  const directory = mkdtempSync(join(tmpdir(), "wrench-plugin-plan-runtime-"));
  chmodSync(directory, 0o700);
  return {
    directory,
    environment: { WRENCH_STATE_HOME: directory },
  };
}

function harness(
  risk: Extract<OperationRisk, "R1" | "R2">,
  planner: UnsafePlanner,
): RuntimeHarness {
  const write = risk === "R2";
  const operationName = write ? "records.publish" : "records.read";
  const operation: WebSessionPluginOperationDefinitionV1 = {
    name: operationName,
    contractVersion: 1,
    risk,
    input: {
      properties: {},
      required: [],
    },
    sideEffect: write ? "publishes one record" : "none",
    idempotency: write ? "local-at-most-once" : "none",
    dedupeWindowMs: write ? 60_000 : 0,
    state: "observed",
    dispatch: write ? "single" : "none",
    implementation: "synthetic plan-conformance runtime",
    planDispatches: planner as ProviderPluginPlanOperationV1["planDispatches"],
    validateInput: () => [],
  };
  let executionCount = 0;
  const plugin = defineProviderPlugin({
    apiVersion: 1,
    id: "plan-conformance-plugin",
    version: "1.0.0",
    displayName: "Plan conformance plugin",
    sourceKind: "source",
    implementationSources: [{
      label: "plugin.ts",
      url: sourcePluginImplementationUrl,
    }],
    bindings: [{
      transport: "web-session-api",
      surfaceId: "plan-conformance",
      origin: "https://plan-conformance.example",
      authKinds: ["cookie-source"],
      operations: [operation],
      subject: {
        format: "plan-conformance:<id>",
        matches: (value) => value === "plan-conformance:viewer",
      },
      runtime: lazyWebSessionRuntime(() => Promise.resolve({
        probe: () => Promise.resolve("plan-conformance:viewer"),
        execute: () => {
          executionCount += 1;
          return Promise.resolve({
            status: "succeeded" as const,
            output: null,
            finalUrl: "https://plan-conformance.example",
            dispatchStarted: false,
            dispatch: { planned: 0, started: 0, verified: 0 },
          });
        },
      })),
    }],
  });
  const registry = createProviderPluginRegistry([plugin]);
  const parsed = parseRuntimeManifest({
    schemaVersion: 4,
    id: "plan-conformance-adapter",
    version: "1.0.0",
    displayName: "Plan conformance adapter",
    surfaceId: "plan-conformance",
    origins: ["https://plan-conformance.example"],
    browserDomains: ["plan-conformance.example"],
    operations: {
      [operationName]: {
        description: operation.implementation,
        risk: operation.risk,
        sideEffect: operation.sideEffect,
        idempotency: operation.idempotency,
        dedupeWindowMs: operation.dedupeWindowMs,
        input: operation.input,
        webSession: {
          site: "plan-conformance",
          action: operationName,
          contractVersion: 1,
          timeoutMs: 30_000,
          maxOutputBytes: 1_024,
        },
      },
    },
  }, registry);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  const auth = createAuth("plan-conformance-auth", {
    source: "chrome",
    subject: "plan-conformance:viewer",
  });
  return {
    registry,
    manifest: parsed.value,
    auth,
    invocation: {
      manifest: parsed.value,
      operationId: operationName,
      input: {},
      auth,
    },
    executions: () => executionCount,
  };
}

function validDispatch(): readonly BrowserDispatchPlan[] {
  return [{
    id: "records.publish",
    description: "Publish one record",
  }];
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("expected promise to reject");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("provider plugin planner runtime boundary", () => {
  test("rejects malformed preview output before a plan or receipt is persisted", () => {
    const testState = state();
    const runtime = harness("R2", () => [{
      ...validDispatch()[0],
      extra: "not allowed",
    }]);
    try {
      saveAuth(runtime.auth, testState.environment);
      expect(() => createAndSaveInvocationPlan(
        runtime.invocation,
        testState.environment,
        new Date("2026-07-25T12:00:00.000Z"),
        runtime.registry,
      )).toThrow("only id and description");
      expect(existsSync(join(testState.directory, "plans"))).toBeFalse();
      expect(existsSync(join(testState.directory, "runs"))).toBeFalse();
      expect(runtime.executions()).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects an unstable confirmation replan before receipt persistence or dispatch", async () => {
    const testState = state();
    let unstable = false;
    let unstableCalls = 0;
    const runtime = harness("R2", () => {
      if (!unstable) return validDispatch();
      unstableCalls += 1;
      return [{
        id: unstableCalls % 2 === 1
          ? "records.publish"
          : "records.publish-again",
        description: "Publish one record",
      }];
    });
    let persistedReceipts = 0;
    try {
      saveAuth(runtime.auth, testState.environment);
      const stored = createAndSaveInvocationPlan(
        runtime.invocation,
        testState.environment,
        new Date("2026-07-25T12:00:00.000Z"),
        runtime.registry,
      );
      unstable = true;
      const message = await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        registry: runtime.registry,
        now: new Date("2026-07-25T12:00:01.000Z"),
        loadManifest: () => ({ ok: true, value: runtime.manifest }),
        persistReceipt: () => {
          persistedReceipts += 1;
        },
      }));
      expect(message).toContain("unstable for identical input");
      expect(unstableCalls).toBe(2);
      expect(persistedReceipts).toBe(0);
      expect(runtime.executions()).toBe(0);
      expect(existsSync(join(testState.directory, "runs"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rebinds the confirmed schedule immediately before execution", async () => {
    const testState = state();
    let calls = 0;
    const runtime = harness("R2", () => {
      calls += 1;
      return [{
        id: calls <= 4 ? "records.publish" : "records.publish-again",
        description: "Publish one record",
      }];
    });
    let persistedReceipts = 0;
    try {
      saveAuth(runtime.auth, testState.environment);
      const stored = createAndSaveInvocationPlan(
        runtime.invocation,
        testState.environment,
        new Date("2026-07-25T12:00:00.000Z"),
        runtime.registry,
      );
      const message = await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        registry: runtime.registry,
        now: new Date("2026-07-25T12:00:01.000Z"),
        loadManifest: () => ({ ok: true, value: runtime.manifest }),
        persistReceipt: () => {
          persistedReceipts += 1;
        },
      }));
      expect(message).toContain("changed before execution");
      expect(calls).toBe(6);
      expect(persistedReceipts).toBe(0);
      expect(runtime.executions()).toBe(0);
      expect(existsSync(join(testState.directory, "runs"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed direct-read planning before receipt persistence or execution", async () => {
    const testState = state();
    const returned: unknown[] = [];
    Object.defineProperty(returned, "extra", {
      enumerable: true,
      value: true,
    });
    const runtime = harness("R1", () => returned);
    let persistedReceipts = 0;
    try {
      const message = await rejectionMessage(executeReadInvocation(
        runtime.invocation,
        {
          headed: false,
          environment: testState.environment,
          registry: runtime.registry,
          persistReceipt: () => {
            persistedReceipts += 1;
          },
        },
      ));
      expect(message).toContain("dense array without extra properties");
      expect(persistedReceipts).toBe(0);
      expect(runtime.executions()).toBe(0);
      expect(existsSync(join(testState.directory, "runs"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
