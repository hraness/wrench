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

const linkedinContracts = webSessionContractDefinitions.linkedin;
if (linkedinContracts === undefined) {
  throw new Error("LinkedIn web-session contracts are not installed");
}

export const linkedinWebPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "linkedin-web",
  version: "1.0.0",
  displayName: "LinkedIn Authenticated Web",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/browser.ts", "../../browser.ts"],
    ["kernel/session-secrets.ts", "../../session-secrets.ts"],
    ["providers/linkedin-web.ts", "../../providers/linkedin-web.ts"],
    ["providers/linkedin-web-bootstrap.ts", "../../providers/linkedin-web-bootstrap.ts"],
    ["providers/linkedin-web-runtime.ts", "../../providers/linkedin-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "web-session-api",
    surfaceId: "linkedin",
    origin: "https://www.linkedin.com",
    protectedHostnameFamilies: ["linkedin.com"],
    authKinds: browserSessionAuthKinds,
    operations: webSessionContractOperations(
      Object.values(linkedinContracts),
      "03f83133f668712b5fa776ab3982e27d52a7645f0ae7dde52d5452bff6f31827",
    ),
    subject: {
      format: "urn:li:fsd_profile:<numeric-id>",
      matches: (value) => /^urn:li:fsd_profile:[0-9]{1,32}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/linkedin-web-runtime");
      return {
        probe: runtime.probeLinkedInWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeLinkedInWebOperation(recipe, input, auth, options),
      };
    }),
  }],
});

export default linkedinWebPlugin;
