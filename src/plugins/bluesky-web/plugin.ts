import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  webSessionContractOperations,
  webImplementationSources,
} from "../../provider-plugin-builtins";
import { webSessionContractDefinitions } from "../../web-session-contract-definitions";

const blueskyContracts = webSessionContractDefinitions.bluesky;
if (blueskyContracts === undefined) {
  throw new Error("Bluesky web-session contracts are not installed");
}

const desiredStateKeys = Object.freeze({
  "likes.set": "liked",
  "content.save": "saved",
  "relationships.follow.set": "followed",
  "posts.repost": "reposted",
} as const);

const operations = webSessionContractOperations(
  Object.values(blueskyContracts),
  "e3e46da572247715e03a7a94038b74cb00c41afa230b0c473eb5d13ece097bba",
  {
    "posts.publish": [2],
  },
  {
    "messaging.list": {
      state: "unsupported",
      reason: "Bluesky inbox identity, pagination, completeness, and acknowledgement-free behavior remain capture-required",
    },
    "messaging.read": {
      state: "unsupported",
      reason: "Bluesky conversation reads remain capture-required despite the presence of unshipped parser code",
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
  if (!Object.hasOwn(desiredStateKeys, operation.name)) return operation;
  const stateKey = desiredStateKeys[
    operation.name as keyof typeof desiredStateKeys
  ];
  return Object.freeze({
    ...operation,
    reconciliation: Object.freeze({
      kind: "boolean-desired-state" as const,
      desiredState: (input: Readonly<Record<string, unknown>>): boolean => {
        const value = input[stateKey];
        if (typeof value !== "boolean") {
          throw new Error(
            `Bluesky ${operation.name} reconciliation requires boolean input.${stateKey}`,
          );
        }
        return value;
      },
    }),
  });
});

export const blueskyWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "bluesky-web",
  version: "1.0.0",
  displayName: "Bluesky Authenticated API",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/browser.ts", "../../browser.ts"],
    ["kernel/session-secrets.ts", "../../session-secrets.ts"],
    ["providers/bluesky-web.ts", "../../providers/bluesky-web.ts"],
    ["providers/bluesky-web-runtime.ts", "../../providers/bluesky-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "bluesky",
    origin: "https://bsky.app",
    protectedHostnameFamilies: ["bsky.app", "bsky.social", "host.bsky.network"],
    authKinds: ["browser-profile"],
    operations,
    subject: {
      format: "did:plc:<id> or did:web:<host>",
      matches: (value) => /^did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9._:%-]{1,240})$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/bluesky-web-runtime");
      return {
        probe: runtime.probeBlueskyWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeBlueskyWebOperation(recipe, input, auth, options),
        reconcile: async (operation, input, auth, context) => {
          if (operation === "posts.publish") {
            if (context?.kind !== "provider-accepted-target-presence") {
              throw new Error("Bluesky posts.publish reconciliation requires one exact accepted target");
            }
            const readback = await runtime.readBlueskyWebPublishedMutationTarget({
              site: "bluesky",
              action: operation,
              contractVersion: 3,
              timeoutMs: 60_000,
              maxOutputBytes: 8 * 1024 * 1024,
            }, input, auth, context.target.identifier);
            return {
              actualState: readback.present,
              reason: "exact-target-readback",
            };
          }
          if (operation === "content.delete") {
            const readback = await runtime.readBlueskyWebContentDeleteDesiredState({
              site: "bluesky",
              action: operation,
              contractVersion: 1,
              timeoutMs: 60_000,
              maxOutputBytes: 8 * 1024 * 1024,
            }, input, auth);
            return {
              actualState: readback.present,
              reason: "authoritative-record-readback",
            };
          }
          if (!Object.hasOwn(desiredStateKeys, operation)) {
            throw new Error(`Bluesky ${operation} has no reconciliation hook`);
          }
          const readback = await runtime.readBlueskyWebDesiredState({
            site: "bluesky",
            action: operation,
            contractVersion: 1,
            timeoutMs: 60_000,
            maxOutputBytes: 8 * 1024 * 1024,
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

export default blueskyWebPlugin;
