import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth, saveAuth } from "./auth";
import {
  isProviderOperation,
  parseRuntimeManifest,
  type WrenchManifest,
  type OperationInput,
} from "./model";
import {
  getProviderContract,
  providerContractHash,
} from "./provider-contracts";
import {
  defineProviderPlugin,
  lazyProviderApiRuntime,
  lazyWebSessionRuntime,
  type ProviderApiPluginOperationDefinitionV1,
  type WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";
import { createProviderPluginRegistry } from "./provider-plugin-registry";
import { readRecoveryCapsule } from "./recovery";
import {
  confirmInvocation,
  createAndSaveInvocationPlan,
  createInvocationPlan,
  executeReadInvocation,
  prepareInvocation,
  readRunReceipt,
  type PreparedInvocation,
} from "./runtime";
import {
  installManifest,
} from "./storage";
import { reconcileWebSessionRun } from "./web-session-recovery";

setDefaultTimeout(15_000);

const sourcePluginImplementationUrl = new URL(
  "./provider-plugin-test-fixture.ts",
  import.meta.url,
);

function state(): {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
} {
  const directory = mkdtempSync(join(tmpdir(), "wrench-plugin-runtime-test-"));
  chmodSync(directory, 0o700);
  return { directory, environment: { WRENCH_STATE_HOME: directory } };
}

function parseCustomManifest(
  value: unknown,
  registry: ReturnType<typeof createProviderPluginRegistry>,
): WrenchManifest {
  const parsed = parseRuntimeManifest(value, registry);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.value;
}

const inputSchema = Object.freeze({
  properties: Object.freeze({
    actor: Object.freeze({
      type: "string" as const,
      description: "Exact custom actor",
      minLength: 1,
      maxLength: 100,
    }),
    enabled: Object.freeze({
      type: "boolean" as const,
      description: "Desired state",
    }),
    guard: Object.freeze({
      type: "string" as const,
      description: "Provider-owned validation guard",
      minLength: 1,
      maxLength: 20,
    }),
  }),
  required: Object.freeze(["actor", "enabled", "guard"]),
});

function customOperation(): WebSessionPluginOperationDefinitionV1 {
  return {
    name: "custom-feed.items-set",
    contractVersion: 1,
    risk: "R2",
    input: inputSchema,
    sideEffect: "sets one custom item state",
    idempotency: "local-at-most-once",
    dedupeWindowMs: 60_000,
    state: "observed",
    dispatch: "single",
    implementation: "synthetic plugin runtime",
    planDispatches: () => [{
      id: "custom-feed.items-set",
      description: "Set one custom item state",
    }],
    validateInput: (input) => input.guard === "allow"
      ? []
      : ["synthetic plugin validateInput rejected input.guard"],
    validateSubjectInput: (input, subject) => input.actor === subject
      ? []
      : ["synthetic plugin actor must match its auth subject"],
    reconciliation: {
      kind: "boolean-desired-state",
      desiredState: (input) => {
        if (typeof input.enabled !== "boolean") {
          throw new Error("synthetic desired state is malformed");
        }
        return input.enabled;
      },
    },
  };
}

function manifestFor(
  surface: string,
  operation: WebSessionPluginOperationDefinitionV1,
  transport: "web-session-api" | "linked-device",
): unknown {
  return {
    schemaVersion: 4,
    id: `${surface}-adapter`,
    version: "1.0.0",
    displayName: `${surface} adapter`,
    surfaceId: surface,
    origins: [`https://${surface}.example`],
    browserDomains: [`${surface}.example`],
    operations: {
      [operation.name]: {
        description: operation.implementation,
        risk: operation.risk,
        sideEffect: operation.sideEffect,
        idempotency: operation.idempotency,
        dedupeWindowMs: operation.dedupeWindowMs,
        input: operation.input,
        webSession: {
          site: surface,
          action: operation.name,
          contractVersion: operation.contractVersion,
          timeoutMs: 60_000,
          maxOutputBytes: 1_048_576,
        },
      },
    },
    _transportEvidence: transport,
  };
}

describe("provider plugin runtime integration", () => {
  test("runs a non-built-in provider-api plugin through installed preparation and the default executor", async () => {
    const testState = state();
    const surfaceId = "custom-official";
    const operation: ProviderApiPluginOperationDefinitionV1 = {
      name: "records.read",
      contractVersion: 1,
      risk: "R1",
      input: {
        properties: {},
        required: [],
      },
      sideEffect: "none",
      idempotency: "none",
      dedupeWindowMs: 0,
      state: "observed",
      dispatch: "none",
      implementation: "synthetic bounded official-provider read",
      planDispatches: () => [],
      validateInput: (input) => Object.keys(input).length === 0
        ? []
        : ["synthetic official provider accepts no input"],
      requiredScopeSets: [["records.read"]],
      coverage: ["records"],
    };
    const pluginOutput = {
      records: [{ id: "record-1", summary: "bounded synthetic result" }],
    };
    const accessToken = "private-synthetic-provider-token";
    let runtimeLoads = 0;
    let executions = 0;
    let observedAccessToken = "";
    const plugin = defineProviderPlugin({
      apiVersion: 1,
      id: "custom-official-plugin",
      version: "1.0.0",
      displayName: "Custom Official Plugin",
      sourceKind: "source",
      implementationSources: [{
        label: "plugin.ts",
        url: sourcePluginImplementationUrl,
      }],
      bindings: [{
        transport: "provider-api",
        surfaceId,
        origin: "https://api.custom-official.example",
        manifestOrigins: ["https://custom-official.example"],
        authKinds: ["oauth-token-file"],
        operations: [operation],
        subject: {
          format: "custom-official:<id>",
          matches: (value) =>
            /^custom-official:[a-z0-9-]{1,40}$/u.test(value),
        },
        runtime: lazyProviderApiRuntime(() => {
          runtimeLoads += 1;
          return Promise.resolve({
            execute: (context) => {
              executions += 1;
              observedAccessToken = context.token.accessToken;
              context.setOutput(pluginOutput);
              context.setFinalUrl(
                "https://custom-official.example/records/record-1",
              );
              return Promise.resolve();
            },
          });
        }),
      }],
    });
    const registry = createProviderPluginRegistry([plugin]);
    const rawManifest = {
      schemaVersion: 3,
      id: "custom-official-adapter",
      version: "1.0.0",
      displayName: "Custom Official Adapter",
      surfaceId,
      origins: ["https://custom-official.example"],
      browserDomains: ["custom-official.example"],
      operations: {
        [operation.name]: {
          description: operation.implementation,
          risk: operation.risk,
          sideEffect: operation.sideEffect,
          idempotency: operation.idempotency,
          dedupeWindowMs: operation.dedupeWindowMs,
          input: operation.input,
          provider: {
            provider: surfaceId,
            action: operation.name,
            contractVersion: operation.contractVersion,
            timeoutMs: 60_000,
            maxOutputBytes: 1_024,
          },
        },
      },
    };
    try {
      const manifest = parseCustomManifest(rawManifest, registry);
      installManifest(manifest, {
        force: false,
        environment: testState.environment,
        registry,
      });
      const tokenPath = join(testState.directory, "custom-official-token.json");
      const auth = createAuth("custom-official-auth", {
        oauthProvider: surfaceId,
        tokenFile: tokenPath,
        scopes: ["records.read"],
        subject: "custom-official:viewer",
      });
      writeFileSync(tokenPath, JSON.stringify({
        schemaVersion: 1,
        provider: surfaceId,
        subject: "custom-official:viewer",
        scopes: auth.kind === "oauth-token-file" ? auth.scopes : [],
        accessToken,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }), { mode: 0o600 });
      saveAuth(auth, testState.environment);

      const invocation = prepareInvocation(
        manifest.id,
        operation.name,
        {},
        auth.id,
        testState.environment,
        registry,
      );
      expect(invocation.manifest).toEqual(manifest);
      expect({ runtimeLoads, executions }).toEqual({
        runtimeLoads: 0,
        executions: 0,
      });
      const manifestOperation = invocation.manifest.operations[operation.name];
      if (
        manifestOperation === undefined
        || !isProviderOperation(manifestOperation)
      ) throw new Error("synthetic official provider operation disappeared");
      const expectedContractHash = providerContractHash(
        getProviderContract(manifestOperation.provider, registry),
        registry,
      );

      const result = await executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        registry,
      });
      expect({ runtimeLoads, executions, observedAccessToken }).toEqual({
        runtimeLoads: 1,
        executions: 1,
        observedAccessToken: accessToken,
      });
      expect(result.output).toEqual(pluginOutput);
      expect(result.output).not.toBe(pluginOutput);
      expect(
        Buffer.byteLength(JSON.stringify(result.output), "utf8"),
      ).toBeLessThanOrEqual(1_024);
      expect(result.receipt).toMatchObject({
        schemaVersion: 3,
        transport: "provider-api",
        adapter: {
          id: manifest.id,
          version: manifest.version,
        },
        operation: operation.name,
        status: "succeeded",
        auth: {
          id: auth.id,
          kind: "oauth-token-file",
        },
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
        finalOrigin: "https://custom-official.example",
        error: null,
      });
      if (result.receipt.schemaVersion !== 3) {
        throw new Error("synthetic official provider emitted the wrong receipt");
      }
      expect(result.receipt.providerContractHash).toBe(expectedContractHash);
      expect(readRunReceipt(
        result.receipt.runId,
        testState.environment,
      )).toEqual(result.receipt);
      expect(JSON.stringify({
        output: result.output,
        receipt: result.receipt,
      })).not.toContain(accessToken);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("runs and reconciles a non-built-in hyphenated operation with no catalog edit", async () => {
    const testState = state();
    let runtimeLoads = 0;
    let probes = 0;
    let executions = 0;
    let reconciliations = 0;
    const operation = customOperation();
    const plugin = defineProviderPlugin({
      apiVersion: 1,
      id: "custom-feed-plugin",
      version: "1.0.0",
      displayName: "Custom Feed Plugin",
      sourceKind: "source",
      implementationSources: [{
        label: "plugin.ts",
        url: sourcePluginImplementationUrl,
      }],
      bindings: [{
        transport: "web-session-api",
        surfaceId: "custom-feed",
        origin: "https://custom-feed.example",
        authKinds: ["cookie-source"],
        operations: [operation],
        subject: {
          format: "custom:<id>",
          matches: (value) => /^custom:[a-z0-9-]{1,40}$/u.test(value),
        },
        runtime: lazyWebSessionRuntime(() => {
          runtimeLoads += 1;
          return Promise.resolve({
            probe: () => {
              probes += 1;
              return Promise.resolve("custom:viewer");
            },
            execute: async (_manifest, _recipe, _input, _auth, options) => {
              executions += 1;
              await options.beforeDispatch?.({
                id: "custom-feed.items-set",
                index: 1,
                progress: { planned: 1, started: 0, verified: 0 },
              });
              return {
                status: "indeterminate",
                output: null,
                finalUrl: "https://custom-feed.example",
                dispatchStarted: true,
                dispatch: { planned: 1, started: 1, verified: 0 },
                error: "synthetic ambiguous write",
              };
            },
            reconcile: () => {
              reconciliations += 1;
              return Promise.resolve({
                actualState: true,
                reason: "synthetic exact readback",
              });
            },
          });
        }),
      }],
    });
    const registry = createProviderPluginRegistry([plugin]);
    try {
      const binding = registry.requireSessionRoute("custom-feed");
      expect(runtimeLoads).toBe(0);
      expect(await binding.subject.probe?.(createAuth("probe-auth", {
        source: "chrome",
      }))).toBe("custom:viewer");
      expect({ runtimeLoads, probes }).toEqual({ runtimeLoads: 1, probes: 1 });

      const rawManifest = manifestFor(
        "custom-feed",
        operation,
        "web-session-api",
      ) as Record<string, unknown>;
      delete rawManifest._transportEvidence;
      const manifest = parseCustomManifest(rawManifest, registry);
      const auth = createAuth("custom-auth", {
        source: "chrome",
        subject: "custom:viewer",
      });
      saveAuth(auth, testState.environment);
      const validInput: OperationInput = {
        actor: "custom:viewer",
        enabled: true,
        guard: "allow",
      };
      const invocation: PreparedInvocation = {
        manifest,
        operationId: operation.name,
        input: validInput,
        auth,
      };

      expect(() => createInvocationPlan({
        ...invocation,
        input: { ...validInput, guard: "deny" },
      }, new Date(), registry)).toThrow(
        "synthetic plugin validateInput rejected",
      );
      expect(() => createInvocationPlan({
        ...invocation,
        input: { ...validInput, actor: "custom:other" },
      }, new Date(), registry)).toThrow(
        "synthetic plugin actor must match",
      );

      const stored = createAndSaveInvocationPlan(
        invocation,
        testState.environment,
        new Date("2026-07-24T12:00:00.000Z"),
        registry,
      );
      expect(stored.plan).toMatchObject({
        schemaVersion: 4,
        transport: "web-session-api",
        operation: "custom-feed.items-set",
        webSessionContract: {
          site: "custom-feed",
          action: "custom-feed.items-set",
          version: 1,
        },
      });
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        now: new Date("2026-07-24T12:00:01.000Z"),
        registry,
        loadManifest: () => ({ ok: true, value: manifest }),
      });
      expect(result.receipt).toMatchObject({
        schemaVersion: 4,
        transport: "web-session-api",
        operation: "custom-feed.items-set",
        status: "indeterminate",
      });
      expect(executions).toBe(1);
      expect(runtimeLoads).toBe(1);
      expect(readRecoveryCapsule(
        result.receipt.runId,
        auth.id,
        result.receipt.auth.hash,
        testState.environment,
      )?.contract).toMatchObject({
        transport: "web-session-api",
        site: "custom-feed",
        action: "custom-feed.items-set",
        version: 1,
      });

      const reconciliation = await reconcileWebSessionRun(
        result.receipt.runId,
        undefined,
        {
          environment: testState.environment,
          registry,
          now: new Date("2026-07-24T12:00:02.000Z"),
        },
      );
      expect(reconciliation).toMatchObject({
        ok: true,
        providerWriteDispatched: false,
        observation: {
          operation: "custom-feed.items-set",
          desiredStateMatched: true,
          actualState: true,
        },
      });
      expect(reconciliations).toBe(1);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("persists a linked-device plugin through durable schema 4", async () => {
    const {
      validateSubjectInput: ignoredValidateSubjectInput,
      reconciliation: ignoredReconciliation,
      ...baseOperation
    } = customOperation();
    void ignoredValidateSubjectInput;
    void ignoredReconciliation;
    const operation: WebSessionPluginOperationDefinitionV1 = {
      ...baseOperation,
      name: "custom-device.status-read",
      risk: "R1",
      sideEffect: "none",
      idempotency: "none",
      dedupeWindowMs: 0,
      dispatch: "none",
      planDispatches: () => [],
    };
    const plugin = defineProviderPlugin({
      apiVersion: 1,
      id: "custom-device-plugin",
      version: "1.0.0",
      displayName: "Custom Device Plugin",
      sourceKind: "source",
      implementationSources: [{
        label: "plugin.ts",
        url: sourcePluginImplementationUrl,
      }],
      bindings: [{
        transport: "linked-device",
        surfaceId: "custom-device",
        origin: "https://custom-device.example",
        authKinds: ["linked-device-store"],
        operations: [operation],
        subject: {
          format: "custom-device:<id>",
          matches: (value) => value.startsWith("custom-device:"),
        },
        linkedDeviceLifecycle: {
          inspect: true,
          pair: true,
          syncOnce: true,
        },
        runtime: lazyWebSessionRuntime(() => Promise.resolve({
          probe: () => Promise.resolve("custom-device:viewer"),
          execute: () => Promise.resolve({
            status: "succeeded",
            output: null,
            finalUrl: "https://custom-device.example",
            dispatchStarted: false,
            dispatch: { planned: 0, started: 0, verified: 0 },
          }),
          linkedDeviceLifecycle: {
            inspect: () => Promise.resolve({
              ready: true,
              implementation: "synthetic-device",
              version: "1.0.0",
              integrity: "test-pinned",
            }),
            pair: async (_auth, options) => {
              await options.attempt.beforeExternalBegin();
              return "custom-device:viewer";
            },
            syncOnce: async (_auth, options) => {
              await options.attempt.beforeExternalBegin();
              return {
                itemsStored: 7,
                projection: "synthetic-store",
                emitsProtocolAcknowledgements: true,
              };
            },
          },
        })),
      }],
    });
    const registry = createProviderPluginRegistry([plugin]);
    const rawManifest = manifestFor(
      "custom-device",
      operation,
      "linked-device",
    ) as Record<string, unknown>;
    delete rawManifest._transportEvidence;
    const manifest = parseCustomManifest(rawManifest, registry);
    const auth = createAuth("custom-device-auth", {
      linkedDeviceProvider: "custom-device",
      deviceStore: "/tmp/wrench-custom-device-store",
      subject: "custom-device:viewer",
    });
    const plan = createInvocationPlan({
      manifest,
      operationId: operation.name,
      input: {
        actor: "custom-device:viewer",
        enabled: true,
        guard: "allow",
      },
      auth,
    }, new Date("2026-07-24T12:00:00.000Z"), registry).plan;
    expect(plan).toMatchObject({
      schemaVersion: 4,
      transport: "web-session-api",
      webSessionContract: {
        site: "custom-device",
        action: "custom-device.status-read",
      },
    });
    const binding = registry.requireSessionRoute("custom-device");
    if (
      binding.transport !== "linked-device"
      || binding.linkedDeviceLifecycle === undefined
    ) {
      throw new Error("synthetic linked-device lifecycle disappeared");
    }
    expect(await binding.linkedDeviceLifecycle.inspect({})).toMatchObject({
      ready: true,
      implementation: "synthetic-device",
    });
    expect(await binding.linkedDeviceLifecycle.pair(auth, {
      environment: {},
      attempt: {
        journalId: "00000000-0000-4000-8000-000000000001",
        beforeExternalBegin: () => Promise.resolve(),
      },
    })).toBe("custom-device:viewer");
    expect(await binding.linkedDeviceLifecycle.syncOnce(auth, {
      environment: {},
      attempt: {
        journalId: "00000000-0000-4000-8000-000000000002",
        beforeExternalBegin: () => Promise.resolve(),
      },
    })).toEqual({
      itemsStored: 7,
      projection: "synthetic-store",
      emitsProtocolAcknowledgements: true,
    });
  });

  test("runs an R3 plugin without reconciliation and reports the missing capability", async () => {
    const testState = state();
    const {
      reconciliation: ignoredReconciliation,
      ...baseOperation
    } = customOperation();
    void ignoredReconciliation;
    const operation: WebSessionPluginOperationDefinitionV1 = {
      ...baseOperation,
      name: "custom-chat.messages-send",
      risk: "R3",
      sideEffect: "sends one custom message",
      planDispatches: () => [{
        id: "custom-chat.messages-send",
        description: "Send one custom message",
      }],
    };
    const plugin = defineProviderPlugin({
      apiVersion: 1,
      id: "custom-chat-plugin",
      version: "1.0.0",
      displayName: "Custom Chat Plugin",
      sourceKind: "source",
      implementationSources: [{
        label: "plugin.ts",
        url: sourcePluginImplementationUrl,
      }],
      bindings: [{
        transport: "web-session-api",
        surfaceId: "custom-chat",
        origin: "https://custom-chat.example",
        authKinds: ["cookie-source"],
        operations: [operation],
        subject: {
          format: "custom:<id>",
          matches: (value) => value.startsWith("custom:"),
        },
        runtime: lazyWebSessionRuntime(() => Promise.resolve({
          probe: () => Promise.resolve("custom:viewer"),
          execute: async (_manifest, _recipe, _input, _auth, options) => {
            await options.beforeDispatch?.({
              id: "custom-chat.messages-send",
              index: 1,
              progress: { planned: 1, started: 0, verified: 0 },
            });
            return {
              status: "indeterminate",
              output: null,
              finalUrl: "https://custom-chat.example",
              dispatchStarted: true,
              dispatch: { planned: 1, started: 1, verified: 0 },
              error: "synthetic ambiguous send",
            };
          },
        })),
      }],
    });
    const registry = createProviderPluginRegistry([plugin]);
    try {
      const rawManifest = manifestFor(
        "custom-chat",
        operation,
        "web-session-api",
      ) as Record<string, unknown>;
      delete rawManifest._transportEvidence;
      const manifest = parseCustomManifest(rawManifest, registry);
      const auth = createAuth("custom-chat-auth", {
        source: "chrome",
        subject: "custom:viewer",
      });
      saveAuth(auth, testState.environment);
      const stored = createAndSaveInvocationPlan({
        manifest,
        operationId: operation.name,
        input: {
          actor: "custom:viewer",
          enabled: true,
          guard: "allow",
        },
        auth,
      }, testState.environment, new Date(), registry);
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        registry,
        loadManifest: () => ({ ok: true, value: manifest }),
      });
      expect(result.receipt.status).toBe("indeterminate");
      let reconciliationError = "";
      try {
        await reconcileWebSessionRun(
          result.receipt.runId,
          undefined,
          { environment: testState.environment, registry },
        );
      } catch (error) {
        reconciliationError = error instanceof Error
          ? error.message
          : String(error);
      }
      expect(reconciliationError).toContain("has no registered reconciler");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
