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

const blueskyContracts = webSessionContractDefinitions.bluesky;
if (blueskyContracts === undefined) {
  throw new Error("Bluesky web-session contracts are not installed");
}

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
    protectedHostnameFamilies: ["bsky.app"],
    authKinds: browserSessionAuthKinds,
    operations: webSessionContractOperations(
      Object.values(blueskyContracts),
      "abc79ec47122e0f027f009ff03155f54ae3b73df20641f1024b85921195df550",
    ),
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
      };
    }),
  }],
});

export default blueskyWebPlugin;
