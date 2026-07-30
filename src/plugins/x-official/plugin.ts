import { providerContractDefinitions } from "../../provider-contract-definitions";
import { xProviderConditionalInputIssues } from "../../provider-contract-input-x";
import {
  defineProviderPlugin,
  lazyProviderApiRuntime,
} from "../../provider-plugin";
import {
  oauthTokenAuthKinds,
  officialContractOperations,
  officialImplementationSources,
} from "../../provider-plugin-builtins";

const runtime = lazyProviderApiRuntime(async () => {
  const { executeXProvider } = await import("../../providers/x");
  return { execute: executeXProvider };
});

export const xOfficialPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "x-official",
  version: "1.0.0",
  displayName: "X Official API",
  sourceKind: "built-in",
  implementationSources: officialImplementationSources(import.meta.url, "x"),
  bindings: [{
    transport: "provider-api",
    surfaceId: "x",
    origin: "https://api.x.com",
    manifestOrigins: ["https://x.com"],
    protectedHostnameFamilies: ["twitter.com", "x.com"],
    authKinds: oauthTokenAuthKinds,
    operations: officialContractOperations(
      Object.values(providerContractDefinitions.x),
      {
        semanticIdentity: "2e0c82c2a43c84d5acd79ae734943e2bc8290f8580d3f2435d979bb92f574c8d",
        validateInput: (contract, input) =>
          xProviderConditionalInputIssues(contract.operation, input),
      },
    ),
    subject: {
      format: "1–19 digit X account ID",
      matches: (value) => /^[0-9]{1,19}$/u.test(value),
    },
    runtime,
  }],
});

export default xOfficialPlugin;
