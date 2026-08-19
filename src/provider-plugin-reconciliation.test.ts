import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "./auth";
import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
  parseProviderPluginReconciliationContextV1,
  type ProviderPluginReconciliationContextV1,
  type WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";
import { createProviderPluginRegistry } from "./provider-plugin-registry";

const auth = Object.freeze({
  schemaVersion: 1,
  id: "accepted-target-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: "accepted-target:viewer",
}) satisfies WrenchAuth;

const context = Object.freeze({
  schemaVersion: 1,
  kind: "provider-accepted-target-presence",
  dispatch: Object.freeze({
    id: "posts.publish",
    index: 1,
    planned: 1,
  }),
  target: Object.freeze({
    schemaVersion: 1,
    identifier: "accepted-target:post:private-123",
  }),
}) satisfies ProviderPluginReconciliationContextV1;

function presenceOperation(): WebSessionPluginOperationDefinitionV1 {
  return {
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
    implementation: "synthetic exact target presence test",
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
}

describe("provider-accepted target reconciliation kernel", () => {
  test("passes one strictly parsed target context to the declared runtime", async () => {
    let runtimeLoads = 0;
    let receivedContext: ProviderPluginReconciliationContextV1 | undefined;
    const plugin = defineProviderPlugin({
      apiVersion: 1,
      id: "accepted-target-reconciliation-test",
      version: "1.0.0",
      displayName: "Accepted Target Reconciliation Test",
      sourceKind: "source",
      implementationSources: [{
        label: "plugin.ts",
        url: new URL("./provider-plugin-test-fixture.ts", import.meta.url),
      }],
      bindings: [{
        transport: "web-session-api",
        surfaceId: "accepted-target-test",
        origin: "https://accepted-target-test.example",
        authKinds: ["cookie-source"],
        operations: [presenceOperation()],
        subject: {
          format: "accepted-target:<id>",
          matches: (value) => /^accepted-target:[a-z0-9-]{1,40}$/u.test(value),
        },
        runtime: lazyWebSessionRuntime(() => {
          runtimeLoads += 1;
          return Promise.resolve({
            probe: () => Promise.resolve("accepted-target:viewer"),
            execute: () => Promise.resolve({
              status: "failed",
              output: null,
              finalUrl: null,
              dispatchStarted: false,
              dispatch: { planned: 1, started: 0, verified: 0 },
              error: "inert exact target fixture",
            }),
            reconcile: (_operation, _input, _auth, selectedContext) => {
              receivedContext = selectedContext;
              return Promise.resolve({
                actualState: true,
                reason: "exact target is present",
              });
            },
          });
        }),
      }],
    });
    const registry = createProviderPluginRegistry([plugin]);
    const binding = registry.requireSessionRoute("accepted-target-test");
    if (binding.transport !== "web-session-api" || binding.reconcile === undefined) {
      throw new Error("expected an exact target web-session reconciler");
    }

    await expect(binding.reconcile(
      "posts.publish",
      { body: "private test body" },
      auth,
    )).rejects.toThrow("must be a plain data object");
    await expect(binding.reconcile(
      "posts.publish",
      { body: "private test body" },
      auth,
      { ...context, unexpected: true } as unknown as ProviderPluginReconciliationContextV1,
    )).rejects.toThrow("must contain exactly");
    expect(runtimeLoads).toBe(0);

    await expect(binding.reconcile(
      "posts.publish",
      { body: "private test body" },
      auth,
      context,
    )).resolves.toEqual({
      actualState: true,
      reason: "exact target is present",
    });
    expect(runtimeLoads).toBe(1);
    expect(receivedContext).toEqual(context);
    expect(receivedContext).not.toBe(context);
    expect(Object.isFrozen(receivedContext)).toBeTrue();
    expect(Object.isFrozen(receivedContext?.dispatch)).toBeTrue();
    expect(Object.isFrozen(receivedContext?.target)).toBeTrue();
  });

  test("rejects invalid presence declarations and strict target context input", () => {
    const invalidDispatch = {
      ...presenceOperation(),
      dispatch: "bounded-items",
    } as unknown as WebSessionPluginOperationDefinitionV1;
    expect(() => defineProviderPlugin({
      apiVersion: 1,
      id: "invalid-accepted-target-dispatch-test",
      version: "1.0.0",
      displayName: "Invalid Accepted Target Dispatch Test",
      sourceKind: "source",
      implementationSources: [{
        label: "plugin.ts",
        url: new URL("./provider-plugin-test-fixture.ts", import.meta.url),
      }],
      bindings: [{
        transport: "web-session-api",
        surfaceId: "invalid-accepted-target-dispatch",
        origin: "https://invalid-accepted-target-dispatch.example",
        authKinds: ["cookie-source"],
        operations: [invalidDispatch],
        subject: {
          format: "invalid:<id>",
          matches: () => true,
        },
        runtime: lazyWebSessionRuntime(() => Promise.resolve({
          probe: () => Promise.resolve("invalid:viewer"),
          execute: () => Promise.resolve({
            status: "failed",
            output: null,
            finalUrl: null,
            dispatchStarted: false,
            dispatch: { planned: 0, started: 0, verified: 0 },
            error: "inert invalid fixture",
          }),
        })),
      }],
    })).toThrow("requires one exact dispatch");

    expect(() => parseProviderPluginReconciliationContextV1({
      ...context,
      dispatch: { ...context.dispatch, extra: true },
    })).toThrow("must contain exactly");
    expect(() => parseProviderPluginReconciliationContextV1({
      ...context,
      target: { ...context.target, identifier: "post\nprivate" },
    })).toThrow("target is malformed");
    expect(() => parseProviderPluginReconciliationContextV1({
      ...context,
      dispatch: { ...context.dispatch, planned: 2 },
    })).toThrow("dispatch is malformed");
    expect(() => parseProviderPluginReconciliationContextV1({
      ...context,
      target: { ...context.target, identifier: "\ud800" },
    })).toThrow("target is malformed");

    const accessor = { ...context } as Record<string, unknown>;
    Object.defineProperty(accessor, "target", {
      enumerable: true,
      get: () => context.target,
    });
    expect(() => parseProviderPluginReconciliationContextV1(accessor))
      .toThrow("must be an enumerable data property");
  });
});
