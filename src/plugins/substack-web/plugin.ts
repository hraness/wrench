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
  version: "1.0.0",
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
      "eec32e0d92a5560840fa679e698913eac744b2ed59cc1deb6ad25be3001c5b5a",
      {},
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
    ),
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
      };
    }),
  }],
});

export default substackWebPlugin;
