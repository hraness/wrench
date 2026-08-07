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
  implementationSources: Object.freeze([
    ...officialImplementationSources(import.meta.url, "linkedin"),
    Object.freeze({
      label: "providers/contact-projection.ts",
      url: new URL("../../providers/contact-projection.ts", import.meta.url),
    }),
  ]),
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
        semanticIdentity: "ee66fdcc3c9ade03be01aa1e8dbe799159ee2fffccbd4c9850fd98e4a6359519",
        validateInput: (contract, input) =>
          linkedinProviderConditionalInputIssues(contract.operation, input),
        validateSubjectInput: (contract, input, subject) => {
          if (contract.operation === "contacts.list") {
            return /^urn:li:person:[A-Za-z0-9_-]{1,256}$/u.test(subject)
              ? []
              : [
                "LinkedIn contacts.list requires an OAuth locator with an exact person URN subject",
              ];
          }
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
