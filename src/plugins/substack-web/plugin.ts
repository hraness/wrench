import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  browserSessionAuthKinds,
  webSessionContractOperations,
  webImplementationSources,
} from "../../provider-plugin-builtins";
import { webSessionContractDefinitions } from "../../web-session-contract-definitions";
import { materializeSubstackMessagingList } from "../../providers/substack-omni";

const substackContracts = webSessionContractDefinitions.substack;
if (substackContracts === undefined) {
  throw new Error("Substack web-session contracts are not installed");
}

export const substackWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "substack-web",
  version: "1.1.0",
  displayName: "Substack Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/substack-web.ts", "../../providers/substack-web.ts"],
    ["providers/substack-web-runtime.ts", "../../providers/substack-web-runtime.ts"],
    ["providers/substack-omni.ts", "../../providers/substack-omni.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "substack",
    origin: "https://substack.com",
    protectedHostnameFamilies: ["substack.com"],
    authKinds: browserSessionAuthKinds,
    operations: webSessionContractOperations(
      Object.values(substackContracts),
      "fd182df8adf7dc5a0148dd33960d3ac9f1ba86210873848acc00f07f7a1d8f62",
      {
        "posts.publish": [2],
      },
      {
        "messaging.list": {
          state: "supported",
          schemaVersion: 1,
          materializerId: "substack-messaging-list",
          materializerVersion: 1,
          materialize: materializeSubstackMessagingList,
        },
        "messaging.read": {
          state: "unsupported",
          reason: "Substack message reads remain capture-required",
        },
      },
    ).map((operation) => operation.name === "posts.publish"
      ? Object.freeze({
          ...operation,
          reconciliation: Object.freeze({
            kind: "provider-accepted-target-presence" as const,
          }),
        })
      : operation),
    subject: {
      format: "substack:<numeric-id>",
      matches: (value) => /^substack:[0-9]{1,32}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/substack-web-runtime");
      return {
        probe: runtime.probeSubstackWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeSubstackWebOperation(recipe, input, auth, options),
        reconcile: async (operation, input, auth, context) => {
          if (
            operation !== "posts.publish"
            || context?.kind !== "provider-accepted-target-presence"
          ) {
            throw new Error(`Substack ${operation} has no reconciliation hook`);
          }
          const readback = await runtime.readSubstackWebAcceptedNoteTargetPresence({
            site: "substack",
            action: operation,
            contractVersion: 3,
            timeoutMs: 60_000,
            maxOutputBytes: 8 * 1024 * 1024,
          }, input, auth, context.target.identifier);
          return {
            actualState: readback.present,
            reason: "exact-target-readback",
          };
        },
      };
    }),
  }],
});

export default substackWebPlugin;
