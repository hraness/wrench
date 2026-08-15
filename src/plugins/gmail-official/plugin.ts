import { providerContractDefinitions } from "../../provider-contract-definitions";
import { gmailProviderConditionalInputIssues } from "../../provider-contract-input-gmail";
import {
  defineProviderPlugin,
  lazyProviderApiRuntime,
} from "../../provider-plugin";
import {
  oauthTokenAuthKinds,
  officialContractOperations,
} from "../../provider-plugin-builtins";
import { isGmailAccountSubject } from "../../provider-subject";
import {
  materializeGmailMessagingList,
  materializeGmailMessagingRead,
} from "../../providers/gmail-omni";

function source(label: string, relativePath: string) {
  return Object.freeze({ label, url: new URL(relativePath, import.meta.url) });
}

const implementationSources = Object.freeze([
  source("plugin.ts", "./plugin.ts"),
  source("kernel/provider-plugin-builtins.ts", "../../provider-plugin-builtins.ts"),
  source("kernel/provider-contract-planning.ts", "../../provider-contract-planning.ts"),
  source("kernel/provider-contract-semantic-identity.ts", "../../provider-contract-semantic-identity.ts"),
  source("kernel/provider-context.ts", "../../provider-context.ts"),
  source("kernel/provider-subject.ts", "../../provider-subject.ts"),
  source("contracts/gmail-input.ts", "../../provider-contract-input-gmail.ts"),
  source("kernel/provider-http.ts", "../../provider-http.ts"),
  source("kernel/operation-deadline.ts", "../../operation-deadline.ts"),
  source("providers/gmail-api.ts", "../../providers/gmail-api.ts"),
  source("providers/contact-projection.ts", "../../providers/contact-projection.ts"),
  source("providers/gmail.ts", "../../providers/gmail.ts"),
  source("providers/gmail-omni.ts", "../../providers/gmail-omni.ts"),
]);

const runtime = lazyProviderApiRuntime(async () => {
  const { executeGmailProvider } = await import("../../providers/gmail");
  return { execute: executeGmailProvider };
});

export const gmailOfficialPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "gmail-official",
  version: "1.2.0",
  displayName: "Gmail Official API",
  sourceKind: "built-in",
  implementationSources,
  bindings: [{
    transport: "provider-api",
    surfaceId: "gmail",
    origin: "https://gmail.googleapis.com",
    runtimeOrigins: [
      "https://gmail.googleapis.com",
      "https://people.googleapis.com",
    ],
    manifestOrigins: [
      "https://mail.google.com",
      "https://contacts.google.com",
    ],
    protectedHostnameFamilies: [
      "gmail.googleapis.com",
      "people.googleapis.com",
      "mail.google.com",
      "contacts.google.com",
    ],
    authKinds: oauthTokenAuthKinds,
    operations: officialContractOperations(
      Object.values(providerContractDefinitions.gmail),
      {
        semanticIdentity: "48c6afcb50558029ca0822b84bc91a9fc5a27f02ccf138db535a38f4f3353ddf",
        validateInput: (contract, input) =>
          gmailProviderConditionalInputIssues(contract.operation, input),
        omni: {
          "messaging.list": {
            state: "supported",
            schemaVersion: 1,
            materializerId: "gmail-messaging-list",
            materializerVersion: 1,
            materialize: materializeGmailMessagingList,
          },
          "messaging.read": {
            state: "supported",
            schemaVersion: 1,
            materializerId: "gmail-messaging-read",
            materializerVersion: 2,
            materialize: materializeGmailMessagingRead,
          },
        },
      },
    ),
    subject: {
      format: "bounded ASCII Gmail mailbox email address",
      matches: isGmailAccountSubject,
    },
    runtime,
  }],
});

export default gmailOfficialPlugin;
