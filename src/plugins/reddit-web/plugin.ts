import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  browserSessionAuthKinds,
  webSessionContractOperations,
  webImplementationSources,
} from "../../provider-plugin-builtins";
import archivedRedditWebManifest from "../../assets/adapters/reddit/wrench-web-adapter.v1.2.0.json";
import archivedRedditWebManifestV1_3 from "../../assets/adapters/reddit/wrench-web-adapter.v1.3.0.json";
import archivedRedditWebManifestV1_4 from "../../assets/adapters/reddit/wrench-web-adapter.v1.4.0.json";
import archivedRedditWebManifestV1_5 from "../../assets/adapters/reddit/wrench-web-adapter.v1.5.0.json";
import archivedRedditWebManifestV1_6 from "../../assets/adapters/reddit/wrench-web-adapter.v1.6.0.json";
import archivedRedditWebManifestV1_7 from "../../assets/adapters/reddit/wrench-web-adapter.v1.7.0.json";
import archivedRedditWebManifestV1_8 from "../../assets/adapters/reddit/wrench-web-adapter.v1.8.0.json";
import archivedRedditWebManifestV1_9 from "../../assets/adapters/reddit/wrench-web-adapter.v1.9.0.json";
import archivedRedditWebMediaReadV1Manifest from "../../assets/adapters/reddit/wrench-web-adapter.v1.10.0.json";
import type { OperationInput } from "../../model";
import { isRedditFlairOperation, parseRedditFlairInput } from "./flair";
import {
  planWebSessionContractDispatches,
  reviewedArchivedWebSessionContract,
  webSessionContractDefinitions,
} from "../../web-session-contract-definitions";
import {
  materializeRedditMessagingList,
  materializeRedditMessagingRead,
} from "../../providers/reddit-omni";

const redditContracts = webSessionContractDefinitions.reddit;
if (redditContracts === undefined) {
  throw new Error("Reddit web-session contracts are not installed");
}

const currentOperations = webSessionContractOperations(
  Object.values(redditContracts),
  "d9a60c84a901f6d23d285064ca7695fc2d757145c0ed9d30088df656f949345f",
  {},
  {
    "messaging.list": {
      state: "supported",
      schemaVersion: 1,
      materializerId: "reddit-messaging-list",
      materializerVersion: 1,
      materialize: materializeRedditMessagingList,
    },
    "messaging.read": {
      state: "supported",
      schemaVersion: 1,
      materializerId: "reddit-messaging-read",
      materializerVersion: 1,
      materialize: materializeRedditMessagingRead,
    },
  },
).map((operation) => {
  if (isRedditFlairOperation(operation.name)) {
    const name = operation.name;
    return Object.freeze({
      ...operation,
      validateInput: (input: OperationInput): readonly string[] => {
        try {
          parseRedditFlairInput(name, input);
          return [];
        } catch (error) {
          return [error instanceof Error ? error.message : "Invalid Reddit flair input"];
        }
      },
    });
  }
  if (operation.name === "media.publish") {
    return Object.freeze({
      ...operation,
      reconciliation: Object.freeze({
        kind: "provider-accepted-target-presence" as const,
      }),
    });
  }
  if (operation.name === "content.delete") {
    return Object.freeze({
      ...operation,
      reconciliation: Object.freeze({
        kind: "boolean-desired-state" as const,
        desiredState: (): boolean => false,
      }),
    });
  }
  if (operation.name !== "content.save") return operation;
  return Object.freeze({
    ...operation,
    reconciliation: Object.freeze({
      kind: "boolean-desired-state" as const,
      desiredState: (input: Readonly<Record<string, unknown>>): boolean => {
        const value = input.saved;
        if (typeof value !== "boolean") {
          throw new Error(
            "Reddit content.save reconciliation requires boolean input.saved",
          );
        }
        return value;
      },
    }),
  });
});

const archivedMediaPublishContract = reviewedArchivedWebSessionContract(
  archivedRedditWebManifest,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.2.0",
    site: "reddit",
    operation: "media.publish",
    contractVersion: 1,
    risk: "R3",
    state: "capture-required",
    implementation:
      "reddit media.publish requires a fresh reviewed authenticated first-party contract before execution",
  },
);

const archivedMediaPublishOperation = Object.freeze({
  name: archivedMediaPublishContract.operation,
  contractVersion: archivedMediaPublishContract.contractVersion,
  risk: archivedMediaPublishContract.risk,
  input: archivedMediaPublishContract.input,
  sideEffect: archivedMediaPublishContract.sideEffect,
  idempotency: archivedMediaPublishContract.idempotency,
  dedupeWindowMs: archivedMediaPublishContract.dedupeWindowMs,
  state: archivedMediaPublishContract.state,
  dispatch: archivedMediaPublishContract.dispatch,
  implementation: archivedMediaPublishContract.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaPublishContract, input),
  validateInput: () => Object.freeze([]),
});

const archivedMediaPublishContractV2 = reviewedArchivedWebSessionContract(
  archivedRedditWebManifestV1_3,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.3.0",
    site: "reddit",
    operation: "media.publish",
    contractVersion: 2,
    risk: "R3",
    state: "capture-required",
    implementation:
      "reddit media.publish@2 used an OAuth-only lease exchange and is retained solely as inert historical identity",
  },
);

const archivedMediaPublishOperationV2 = Object.freeze({
  name: archivedMediaPublishContractV2.operation,
  contractVersion: archivedMediaPublishContractV2.contractVersion,
  risk: archivedMediaPublishContractV2.risk,
  input: archivedMediaPublishContractV2.input,
  sideEffect: archivedMediaPublishContractV2.sideEffect,
  idempotency: archivedMediaPublishContractV2.idempotency,
  dedupeWindowMs: archivedMediaPublishContractV2.dedupeWindowMs,
  state: archivedMediaPublishContractV2.state,
  dispatch: archivedMediaPublishContractV2.dispatch,
  implementation: archivedMediaPublishContractV2.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaPublishContractV2, input),
  validateInput: () => Object.freeze([]),
});

const archivedMediaPublishContractV3 = reviewedArchivedWebSessionContract(
  archivedRedditWebManifestV1_4,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.4.0",
    site: "reddit",
    operation: "media.publish",
    contractVersion: 3,
    risk: "R3",
    state: "capture-required",
    implementation:
      "reddit media.publish@3 used a disproven serialized lease declaration and is retained solely as inert historical identity",
  },
);

const archivedMediaPublishOperationV3 = Object.freeze({
  name: archivedMediaPublishContractV3.operation,
  contractVersion: archivedMediaPublishContractV3.contractVersion,
  risk: archivedMediaPublishContractV3.risk,
  input: archivedMediaPublishContractV3.input,
  sideEffect: archivedMediaPublishContractV3.sideEffect,
  idempotency: archivedMediaPublishContractV3.idempotency,
  dedupeWindowMs: archivedMediaPublishContractV3.dedupeWindowMs,
  state: archivedMediaPublishContractV3.state,
  dispatch: archivedMediaPublishContractV3.dispatch,
  implementation: archivedMediaPublishContractV3.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaPublishContractV3, input),
  validateInput: () => Object.freeze([]),
});

const archivedMediaPublishContractV4 = reviewedArchivedWebSessionContract(
  archivedRedditWebManifestV1_5,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.5.0",
    site: "reddit",
    operation: "media.publish",
    contractVersion: 4,
    risk: "R3",
    state: "capture-required",
    implementation:
      "reddit media.publish@4 omitted the required modhash and same-origin AJAX lease headers and is retained solely as inert historical identity",
  },
);

const archivedMediaPublishOperationV4 = Object.freeze({
  name: archivedMediaPublishContractV4.operation,
  contractVersion: archivedMediaPublishContractV4.contractVersion,
  risk: archivedMediaPublishContractV4.risk,
  input: archivedMediaPublishContractV4.input,
  sideEffect: archivedMediaPublishContractV4.sideEffect,
  idempotency: archivedMediaPublishContractV4.idempotency,
  dedupeWindowMs: archivedMediaPublishContractV4.dedupeWindowMs,
  state: archivedMediaPublishContractV4.state,
  dispatch: archivedMediaPublishContractV4.dispatch,
  implementation: archivedMediaPublishContractV4.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaPublishContractV4, input),
  validateInput: () => Object.freeze([]),
});

const archivedMediaPublishContractV5 = reviewedArchivedWebSessionContract(
  archivedRedditWebManifestV1_6,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.6.0",
    site: "reddit",
    operation: "media.publish",
    contractVersion: 5,
    risk: "R3",
    state: "capture-required",
    implementation:
      "reddit media.publish@5 modeled an obsolete twelve-field lease order and is retained solely as inert historical identity",
  },
);

const archivedMediaPublishOperationV5 = Object.freeze({
  name: archivedMediaPublishContractV5.operation,
  contractVersion: archivedMediaPublishContractV5.contractVersion,
  risk: archivedMediaPublishContractV5.risk,
  input: archivedMediaPublishContractV5.input,
  sideEffect: archivedMediaPublishContractV5.sideEffect,
  idempotency: archivedMediaPublishContractV5.idempotency,
  dedupeWindowMs: archivedMediaPublishContractV5.dedupeWindowMs,
  state: archivedMediaPublishContractV5.state,
  dispatch: archivedMediaPublishContractV5.dispatch,
  implementation: archivedMediaPublishContractV5.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaPublishContractV5, input),
  validateInput: () => Object.freeze([]),
});

const archivedMediaPublishContractV6 = reviewedArchivedWebSessionContract(
  archivedRedditWebManifestV1_7,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.7.0",
    site: "reddit",
    operation: "media.publish",
    contractVersion: 6,
    risk: "R3",
    state: "capture-required",
    implementation:
      "reddit media.publish@6 applied the video lease order to image posters and is retained solely as inert historical identity",
  },
);

const archivedMediaPublishOperationV6 = Object.freeze({
  name: archivedMediaPublishContractV6.operation,
  contractVersion: archivedMediaPublishContractV6.contractVersion,
  risk: archivedMediaPublishContractV6.risk,
  input: archivedMediaPublishContractV6.input,
  sideEffect: archivedMediaPublishContractV6.sideEffect,
  idempotency: archivedMediaPublishContractV6.idempotency,
  dedupeWindowMs: archivedMediaPublishContractV6.dedupeWindowMs,
  state: archivedMediaPublishContractV6.state,
  dispatch: archivedMediaPublishContractV6.dispatch,
  implementation: archivedMediaPublishContractV6.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaPublishContractV6, input),
  validateInput: () => Object.freeze([]),
});

const archivedMediaPublishContractV7 = reviewedArchivedWebSessionContract(
  archivedRedditWebManifestV1_8,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.8.0",
    site: "reddit",
    operation: "media.publish",
    contractVersion: 7,
    risk: "R3",
    state: "capture-required",
    implementation:
      "reddit media.publish@7 bound a provider-nondeterministic lease-field order and is retained solely as inert historical identity",
  },
);

const archivedMediaPublishOperationV7 = Object.freeze({
  name: archivedMediaPublishContractV7.operation,
  contractVersion: archivedMediaPublishContractV7.contractVersion,
  risk: archivedMediaPublishContractV7.risk,
  input: archivedMediaPublishContractV7.input,
  sideEffect: archivedMediaPublishContractV7.sideEffect,
  idempotency: archivedMediaPublishContractV7.idempotency,
  dedupeWindowMs: archivedMediaPublishContractV7.dedupeWindowMs,
  state: archivedMediaPublishContractV7.state,
  dispatch: archivedMediaPublishContractV7.dispatch,
  implementation: archivedMediaPublishContractV7.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaPublishContractV7, input),
  validateInput: () => Object.freeze([]),
});

const archivedMediaPublishContractV8 = reviewedArchivedWebSessionContract(
  archivedRedditWebManifestV1_9,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.9.0",
    site: "reddit",
    operation: "media.publish",
    contractVersion: 8,
    risk: "R3",
    state: "capture-required",
    implementation:
      "reddit media.publish@8 routed signed third-party S3 transfers through an authenticated same-origin client and is retained solely as inert historical identity",
  },
);

const archivedMediaPublishOperationV8 = Object.freeze({
  name: archivedMediaPublishContractV8.operation,
  contractVersion: archivedMediaPublishContractV8.contractVersion,
  risk: archivedMediaPublishContractV8.risk,
  input: archivedMediaPublishContractV8.input,
  sideEffect: archivedMediaPublishContractV8.sideEffect,
  idempotency: archivedMediaPublishContractV8.idempotency,
  dedupeWindowMs: archivedMediaPublishContractV8.dedupeWindowMs,
  state: archivedMediaPublishContractV8.state,
  dispatch: archivedMediaPublishContractV8.dispatch,
  implementation: archivedMediaPublishContractV8.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaPublishContractV8, input),
  validateInput: () => Object.freeze([]),
});

const archivedMediaReadContract = reviewedArchivedWebSessionContract(
  archivedRedditWebMediaReadV1Manifest,
  {
    adapterId: "reddit-web",
    adapterVersion: "1.10.0",
    site: "reddit",
    operation: "media.read",
    contractVersion: 1,
    risk: "R1",
    state: "capture-required",
    implementation:
      "reddit media.read@1 was an unbounded media-variant reservation and remains inert historical identity",
  },
);

const archivedMediaReadOperation = Object.freeze({
  name: archivedMediaReadContract.operation,
  contractVersion: archivedMediaReadContract.contractVersion,
  risk: archivedMediaReadContract.risk,
  input: archivedMediaReadContract.input,
  sideEffect: archivedMediaReadContract.sideEffect,
  idempotency: archivedMediaReadContract.idempotency,
  dedupeWindowMs: archivedMediaReadContract.dedupeWindowMs,
  state: archivedMediaReadContract.state,
  dispatch: archivedMediaReadContract.dispatch,
  implementation: archivedMediaReadContract.implementation,
  planDispatches: (input: OperationInput) =>
    planWebSessionContractDispatches(archivedMediaReadContract, input),
  validateInput: () => Object.freeze([]),
});

const operations = Object.freeze([
  ...currentOperations,
  archivedMediaReadOperation,
  archivedMediaPublishOperation,
  archivedMediaPublishOperationV2,
  archivedMediaPublishOperationV3,
  archivedMediaPublishOperationV4,
  archivedMediaPublishOperationV5,
  archivedMediaPublishOperationV6,
  archivedMediaPublishOperationV7,
  archivedMediaPublishOperationV8,
]);

export const redditWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "reddit-web",
  version: "1.4.0",
  displayName: "Reddit Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/read-failure.ts", "../../providers/read-failure.ts"],
    ["providers/reddit-web.ts", "../../providers/reddit-web.ts"],
    ["providers/reddit-web-runtime.ts", "../../providers/reddit-web-runtime.ts"],
    ["providers/reddit-omni.ts", "../../providers/reddit-omni.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "reddit",
    origin: "https://www.reddit.com",
    protectedHostnameFamilies: ["reddit.com"],
    authKinds: browserSessionAuthKinds,
    operations,
    subject: {
      format: "reddit:t2_<account-id>",
      matches: (value) => /^reddit:t2_[a-z0-9]{1,32}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/reddit-web-runtime");
      return {
        probe: runtime.probeRedditWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeRedditWebOperation(recipe, input, auth, options),
        reconcile: async (operation, input, auth, context) => {
          if (operation === "media.publish") {
            if (context?.kind !== "provider-accepted-target-presence") {
              throw new Error("Reddit media.publish reconciliation requires one exact accepted target");
            }
            const readback = await runtime.readRedditWebPublishedMutationTarget({
              site: "reddit",
              action: operation,
              contractVersion: 9,
              timeoutMs: 60_000,
              maxOutputBytes: 4 * 1024 * 1024,
            }, input, auth, context.target.identifier);
            return {
              actualState: readback.present,
              reason: "exact-target-readback",
            };
          }
          if (operation === "content.delete") {
            const readback = await runtime.readRedditWebContentDeleteDesiredState({
              site: "reddit",
              action: operation,
              contractVersion: 1,
              timeoutMs: 60_000,
              maxOutputBytes: 4 * 1024 * 1024,
            }, input, auth);
            return {
              actualState: readback.present,
              reason: "exact-target-absence-readback",
            };
          }
          if (operation !== "content.save") {
            throw new Error(`Reddit ${operation} has no reconciliation hook`);
          }
          const readback = await runtime.readRedditWebDesiredState({
            site: "reddit",
            action: operation,
            contractVersion: 1,
            timeoutMs: 60_000,
            maxOutputBytes: 2 * 1024 * 1024,
          }, input, auth);
          return {
            actualState: readback.enabled,
            reason: "exact-readback",
          };
        },
      };
    }),
  }],
});

export default redditWebPlugin;
