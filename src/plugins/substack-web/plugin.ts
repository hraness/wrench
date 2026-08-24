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
  version: "1.2.0",
  displayName: "Substack Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/substack-web.ts", "../../providers/substack-web.ts"],
    ["providers/substack-web-runtime.ts", "../../providers/substack-web-runtime.ts"],
    ["providers/substack-video-mp4.ts", "../../providers/substack-video-mp4.ts"],
    ["providers/iso-bmff.ts", "../../providers/iso-bmff.ts"],
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
      "55e4f65e820c41cff2795eedfdfd5d0086be5af7d86f7bd8e7ea3da6a3be9b22",
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
    ).map((operation) => {
      if (operation.name === "posts.publish") {
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
      return operation;
    }),
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
          if (operation === "content.delete") {
            const readback = await runtime.readSubstackWebContentDeleteDesiredState({
              site: "substack",
              action: operation,
              contractVersion: 1,
              timeoutMs: 60_000,
              maxOutputBytes: 8 * 1024 * 1024,
            }, input, auth);
            return {
              actualState: readback.present,
              reason: "exact-target-absence-readback",
            };
          }
          if (operation !== "posts.publish") {
            throw new Error(`Substack ${operation} has no reconciliation hook`);
          }
          if (context?.kind !== "provider-accepted-target-presence") {
            throw new Error("Substack posts.publish reconciliation requires one exact accepted target");
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
