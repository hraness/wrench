import { providerContractDefinitions } from "../../provider-contract-definitions";
import { linkedinProviderConditionalInputIssues } from "../../provider-contract-input-linkedin";
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
  const { executeLinkedInProvider } = await import("../../providers/linkedin");
  return { execute: executeLinkedInProvider };
});

export const linkedinOfficialPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "linkedin-official",
  version: "1.0.0",
  displayName: "LinkedIn Official API",
  sourceKind: "built-in",
  implementationSources: officialImplementationSources(import.meta.url, "linkedin"),
  bindings: [{
    transport: "provider-api",
    surfaceId: "linkedin",
    origin: "https://api.linkedin.com",
    manifestOrigins: ["https://www.linkedin.com"],
    protectedHostnameFamilies: ["linkedin.com"],
    authKinds: oauthTokenAuthKinds,
    operations: officialContractOperations(
      Object.values(providerContractDefinitions.linkedin),
      {
        semanticIdentity: "f596551d3ce0f5ec7ee35cb07d280567394d24fd214a2f51a01a30008c65daaf",
        validateInput: (contract, input) =>
          linkedinProviderConditionalInputIssues(contract.operation, input),
        validateSubjectInput: (contract, input, subject) => {
          if (contract.risk !== "R2" && contract.risk !== "R3") return [];
          const requestedActor = typeof input.actor === "string"
            ? input.actor
            : typeof input.author === "string" ? input.author : undefined;
          if (
            requestedActor === undefined
            || !/^urn:li:(?:person:[A-Za-z0-9_-]{1,256}|organization:[0-9]{1,32})$/u
              .test(requestedActor)
          ) {
            return [
              "R2/R3 LinkedIn provider API actions require an exact requested actor before preview",
            ];
          }
          return requestedActor === subject
            ? []
            : [
              "LinkedIn provider write actor must match the auth subject; administered-organization delegation has no reviewed preflight",
            ];
        },
      },
    ),
    subject: {
      format: "urn:li:person:<id> or urn:li:organization:<id>",
      matches: (value) =>
        /^urn:li:(?:person:[A-Za-z0-9_-]{1,256}|organization:[0-9]{1,32})$/u.test(
          value,
        ),
    },
    runtime,
  }],
});

export default linkedinOfficialPlugin;
