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

const hackerNewsContracts = webSessionContractDefinitions["hacker-news"];
if (hackerNewsContracts === undefined) {
  throw new Error("Hacker News web-session contracts are not installed");
}

export const hackerNewsWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "hacker-news-web",
  version: "1.1.0",
  displayName: "Hacker News Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/hacker-news-web.ts", "../../providers/hacker-news-web.ts"],
    ["providers/hacker-news-web-runtime.ts", "../../providers/hacker-news-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "hacker-news",
    origin: "https://news.ycombinator.com",
    protectedHostnameFamilies: ["news.ycombinator.com"],
    authKinds: browserSessionAuthKinds,
    operations: webSessionContractOperations(
      Object.values(hackerNewsContracts),
      "b26014667b42eb62464a56f89f95d1c54b947b20c8b174b4be72b5ed9d1cbfac",
    ),
    subject: {
      format: "hacker-news:<username>",
      matches: (value) => /^hacker-news:[A-Za-z0-9_-]{1,64}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/hacker-news-web-runtime");
      return {
        probe: runtime.probeHackerNewsWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeHackerNewsWebOperation(recipe, input, auth, options),
      };
    }),
  }],
});

export default hackerNewsWebPlugin;
