import { xProviderContractDefinitions } from "../../provider-contract-definitions-x";
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
  implementationSources: Object.freeze([
    ...officialImplementationSources(import.meta.url, "x"),
    Object.freeze({
      label: "contracts/x-versioned.ts",
      url: new URL("../../provider-contract-definitions-x.ts", import.meta.url),
    }),
  ]),
  bindings: [{
    transport: "provider-api",
    surfaceId: "x",
    origin: "https://api.x.com",
    manifestOrigins: ["https://x.com"],
    protectedHostnameFamilies: ["twitter.com", "x.com"],
    authKinds: oauthTokenAuthKinds,
    operations: officialContractOperations(
      xProviderContractDefinitions,
      {
        semanticIdentity: "efdfe84cea39e04c98800486f476e31c678e43ae93eb83eb47070c7e66b3d6d8",
        validateInput: (contract, input) =>
          xProviderConditionalInputIssues(contract.operation, input),
        omni: {
          "messaging.list": {
            state: "unsupported",
            reason: "X official messaging output retains raw or encrypted nested provider data without a strict plaintext materializer",
          },
          "messaging.read": {
            state: "unsupported",
            reason: "X official message reads retain raw provider data without a strict provider-owned output materializer",
          },
        },
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
