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
import {
  materializeRedditMessagingList,
  materializeRedditMessagingRead,
} from "../../providers/reddit-omni";

const redditContracts = webSessionContractDefinitions.reddit;
if (redditContracts === undefined) {
  throw new Error("Reddit web-session contracts are not installed");
}

const operations = webSessionContractOperations(
  Object.values(redditContracts),
  "3220985112930ea777c3d816304f7a8afd5fb727d6844c5da55abc8a5aa70405",
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

export const redditWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "reddit-web",
  version: "1.0.0",
  displayName: "Reddit Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
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
        reconcile: async (operation, input, auth) => {
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
