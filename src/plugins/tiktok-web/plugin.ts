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

const tiktokContracts = webSessionContractDefinitions.tiktok;
if (tiktokContracts === undefined) {
  throw new Error("TikTok web-session contracts are not installed");
}

export const tiktokWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "tiktok-web",
  version: "1.0.0",
  displayName: "TikTok Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/tiktok-web.ts", "../../providers/tiktok-web.ts"],
    ["providers/tiktok-web-runtime.ts", "../../providers/tiktok-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "tiktok",
    origin: "https://www.tiktok.com",
    protectedHostnameFamilies: ["tiktok.com"],
    authKinds: browserSessionAuthKinds,
    operations: webSessionContractOperations(
      Object.values(tiktokContracts),
      "1d14f603853acd6c44bb2a4de17bb7a71dace303712d1ed9ca9f25c3571ee145",
    ),
    subject: {
      format: "tiktok:uid:<id>/sec:<secondary-id>",
      matches: (value) => /^tiktok:uid:[0-9]{1,32}\/sec:[A-Za-z0-9._-]{16,256}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/tiktok-web-runtime");
      return {
        probe: runtime.probeTikTokWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeTikTokWebOperation(recipe, input, auth, options),
      };
    }),
  }],
});

export default tiktokWebPlugin;
