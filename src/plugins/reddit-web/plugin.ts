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
    operations: webSessionContractOperations(
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
    ),
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
      };
    }),
  }],
});

export default redditWebPlugin;
