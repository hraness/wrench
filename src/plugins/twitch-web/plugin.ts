import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  browserSessionAuthKinds,
  webImplementationSources,
  webSessionContractOperations,
} from "../../provider-plugin-builtins";
import { webSessionContractDefinitions } from "../../web-session-contract-definitions";

const twitchContracts = webSessionContractDefinitions.twitch;
if (twitchContracts === undefined) {
  throw new Error("Twitch web-session contracts are not installed");
}

export const twitchWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "twitch-web",
  version: "1.0.0",
  displayName: "Twitch Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/twitch-web.ts", "../../providers/twitch-web.ts"],
    ["providers/twitch-web-runtime.ts", "../../providers/twitch-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "twitch",
    origin: "https://gql.twitch.tv",
    manifestOrigins: ["https://www.twitch.tv"],
    protectedHostnameFamilies: ["twitch.tv"],
    authKinds: browserSessionAuthKinds,
    operations: webSessionContractOperations(
      Object.values(twitchContracts),
      "f82840e92d2512dd43f83adb00a6b7e5bdfa7384ee9b7e298454dac5408f7811",
    ),
    subject: {
      format: "twitch:<viewer-id>",
      matches: (value) => /^twitch:[1-9][0-9]{0,31}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/twitch-web-runtime");
      return {
        probe: runtime.probeTwitchWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeTwitchWebOperation(recipe, input, auth, options),
      };
    }),
  }],
});

export default twitchWebPlugin;
