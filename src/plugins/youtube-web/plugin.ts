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

const youtubeContracts = webSessionContractDefinitions.youtube;
if (youtubeContracts === undefined) {
  throw new Error("YouTube web-session contracts are not installed");
}

const desiredStateKeys = Object.freeze({
  "likes.set": "liked",
  "content.save": "saved",
  "relationships.follow.set": "followed",
} as const);

const operations = webSessionContractOperations(
  Object.values(youtubeContracts),
  "9be9492c45496da027feb1661dbbffd2e241d7647eba96e3eea2d416d148b924",
).map((operation) => {
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
            `YouTube ${operation.name} reconciliation requires boolean input.${stateKey}`,
          );
        }
        return value;
      },
    }),
  });
});

export const youtubeWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "youtube-web",
  version: "1.1.0",
  displayName: "YouTube Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/youtube-web.ts", "../../providers/youtube-web.ts"],
    ["providers/youtube-web-runtime.ts", "../../providers/youtube-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "youtube",
    origin: "https://www.youtube.com",
    protectedHostnameFamilies: ["youtube.com"],
    authKinds: browserSessionAuthKinds,
    operations,
    subject: {
      format: "youtube:channel:<channel-id> with optional Gaia/delegate suffixes",
      matches: (value) => /^youtube:channel:UC[A-Za-z0-9_-]{22}(?:\/gaia:[0-9]{1,32})?(?:\/delegate:[A-Za-z0-9_-]{1,128})?$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/youtube-web-runtime");
      return {
        probe: runtime.probeYouTubeWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeYouTubeWebOperation(recipe, input, auth, options),
        reconcile: async (operation, input, auth) => {
          if (!Object.hasOwn(desiredStateKeys, operation)) {
            throw new Error(`YouTube ${operation} has no reconciliation hook`);
          }
          const readback = await runtime.readYouTubeWebDesiredState({
            site: "youtube",
            action: operation,
            contractVersion: 1,
            timeoutMs: 60_000,
            maxOutputBytes: 4 * 1024 * 1024,
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

export default youtubeWebPlugin;
