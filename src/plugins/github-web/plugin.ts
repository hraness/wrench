import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  webImplementationSources,
  webSessionContractOperations,
} from "../../provider-plugin-builtins";
import { webSessionContractDefinitions } from "../../web-session-contract-definitions";

const githubContracts = webSessionContractDefinitions.github;
if (githubContracts === undefined) {
  throw new Error("GitHub web-session contracts are not installed");
}

const operations = webSessionContractOperations(
  Object.values(githubContracts),
  "e98e40c98b2ab018dc4dc08fd701d384939425240224631bde25be278695127b",
).map((operation) => Object.freeze({
  ...operation,
  access: "public" as const,
}));

export const githubWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "github-web",
  version: "1.0.0",
  displayName: "GitHub Public Profile API",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["providers/github-web.ts", "../../providers/github-web.ts"],
    ["providers/github-web-runtime.ts", "../../providers/github-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "github",
    origin: "https://api.github.com",
    manifestOrigins: ["https://github.com"],
    protectedHostnameFamilies: ["api.github.com", "github.com"],
    authKinds: ["browser-profile"],
    operations,
    subject: {
      format: "github:<username>",
      matches: (value) =>
        /^github:[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/github-web-runtime");
      return {
        probe: runtime.probeGitHubWebSubject,
        execute: runtime.executeGitHubAuthenticatedOperation,
        executePublic: (_manifest, recipe, input, options) =>
          runtime.executeGitHubPublicProfileRead(
            recipe,
            input,
            undefined,
            options.operationDeadline,
          ),
      };
    }),
  }],
});

export default githubWebPlugin;
