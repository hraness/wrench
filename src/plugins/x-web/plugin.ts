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

const operations = webSessionContractOperations(
  Object.values(webSessionContractDefinitions.x),
  "38b816f0c309d4768e48cc48fa4e6976c5a164422bd87bc56a4df9a028a61ada",
  { "articles.publish": [1, 2], "likes.set": [1] },
  {
    "messaging.list": {
      state: "unsupported",
      reason: "X web Chat inbox events are encrypted and require reviewed key recovery before plaintext normalization",
    },
    "messaging.read": {
      state: "unsupported",
      reason: "X web Chat conversation events are encrypted and require reviewed key recovery before plaintext normalization",
    },
  },
).map((operation) => {
  if (
    operation.name !== "content.save"
    && operation.name !== "likes.set"
    && operation.name !== "articles.publish"
  ) {
    return operation;
  }
  if (operation.name === "articles.publish") {
    return Object.freeze({
      ...operation,
      reconciliation: Object.freeze({
        kind: "boolean-desired-state" as const,
        desiredState: (input: Readonly<Record<string, unknown>>): boolean => {
          if (
            input.draft_only !== true
            || typeof input.draft_id !== "string"
            || input.inline_images !== undefined
            || input.cover_image !== undefined
          ) {
            throw new Error(
              "X articles.publish reconciliation requires one existing text-and-links-only private draft",
            );
          }
          return true;
        },
      }),
    });
  }
  const stateKey = operation.name === "content.save" ? "saved" : "liked";
  return Object.freeze({
    ...operation,
    reconciliation: Object.freeze({
      kind: "boolean-desired-state" as const,
      desiredState: (input: Readonly<Record<string, unknown>>): boolean => {
        const value = input[stateKey];
        if (typeof value !== "boolean") {
          throw new Error(
            `X ${operation.name} reconciliation requires boolean input.${stateKey}`,
          );
        }
        return value;
      },
    }),
  });
});

export const xWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "x-web",
  version: "1.0.0",
  displayName: "X Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/browser.ts", "../../browser.ts"],
    ["providers/x-web.ts", "../../providers/x-web.ts"],
    ["providers/x-web-runtime.ts", "../../providers/x-web-runtime.ts"],
    ["providers/x-transaction-id.ts", "../../providers/x-transaction-id.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "x",
    origin: "https://x.com",
    protectedHostnameFamilies: ["twitter.com", "x.com"],
    authKinds: browserSessionAuthKinds,
    operations,
    subject: {
      format: "1–19 digit X account ID",
      matches: (value) => /^[0-9]{1,19}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/x-web-runtime");
      return {
        probe: runtime.probeXWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeXWebOperation(recipe, input, auth, options),
        reconcile: async (operation, input, auth) => {
          if (operation === "articles.publish") {
            const readback = await runtime.readXWebRichArticleDesiredState({
              site: "x",
              action: operation,
              contractVersion: 3,
              timeoutMs: 60_000,
              maxOutputBytes: 2 * 1024 * 1024,
            }, input, auth);
            return {
              actualState: readback.matches,
              reason: "exact-readback",
            };
          }
          if (operation !== "content.save" && operation !== "likes.set") {
            throw new Error(`X ${operation} has no reconciliation hook`);
          }
          const readback = await runtime.readXWebDesiredState({
            site: "x",
            action: operation,
            contractVersion: operation === "content.save" ? 1 : 2,
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

export default xWebPlugin;
