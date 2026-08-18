import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  linkedDeviceAuthKinds,
  webSessionContractOperations,
  webImplementationSources,
} from "../../provider-plugin-builtins";
import { webSessionContractDefinitions } from "../../web-session-contract-definitions";
import {
  materializeWhatsAppMessagingList,
  materializeWhatsAppMessagingRead,
} from "../../providers/whatsapp-omni";

const whatsappContracts = webSessionContractDefinitions.whatsapp;
if (whatsappContracts === undefined) {
  throw new Error("WhatsApp linked-device contracts are not installed");
}

export const whatsappLinkedDevicePlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "whatsapp-linked-device",
  version: "1.0.0",
  displayName: "WhatsApp Linked Device",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/auth.ts", "../../auth.ts"],
    ["kernel/state-helper.bunfig.toml", "../../state-helper.bunfig.toml"],
    ["kernel/storage.ts", "../../storage.ts"],
    ["providers/contact-projection.ts", "../../providers/contact-projection.ts"],
    ["providers/whatsapp-contact-projection-helper.ts", "../../providers/whatsapp-contact-projection-helper.ts"],
    ["providers/whatsapp-contact-projection-protocol.ts", "../../providers/whatsapp-contact-projection-protocol.ts"],
    ["providers/whatsapp-interaction-projection-helper.ts", "../../providers/whatsapp-interaction-projection-helper.ts"],
    ["providers/whatsapp-interaction-projection-protocol.ts", "../../providers/whatsapp-interaction-projection-protocol.ts"],
    ["providers/whatsapp-web.ts", "../../providers/whatsapp-web.ts"],
    ["providers/whatsapp-web-runtime.ts", "../../providers/whatsapp-web-runtime.ts"],
    ["providers/whatsapp-omni.ts", "../../providers/whatsapp-omni.ts"],
  ]),
  bindings: [{
    transport: "linked-device",
    surfaceId: "whatsapp",
    origin: "https://web.whatsapp.com",
    protectedHostnameFamilies: ["whatsapp.com"],
    authKinds: linkedDeviceAuthKinds,
    operations: webSessionContractOperations(
      Object.values(whatsappContracts),
      "a5c32c0b7c210fd98aee086455b2fde1151c7cf1806fd2e0f6c3e269d10ac13f",
      { "contacts.list": [1] },
      {
        "messaging.list": {
          state: "supported",
          schemaVersion: 1,
          materializerId: "whatsapp-messaging-list",
          materializerVersion: 1,
          materialize: materializeWhatsAppMessagingList,
        },
        "messaging.read": {
          state: "supported",
          schemaVersion: 1,
          materializerId: "whatsapp-messaging-read",
          materializerVersion: 1,
          materialize: materializeWhatsAppMessagingRead,
        },
      },
    ),
    subject: {
      format: "whatsapp:pn:<phone> or whatsapp:lid:<linked-id>",
      matches: (value) => /^whatsapp:(?:pn:[0-9]{5,20}|lid:[0-9]{5,32})$/u.test(value),
    },
    linkedDeviceLifecycle: {
      inspect: true,
      pair: true,
      syncOnce: true,
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/whatsapp-web-runtime");
      return {
        probe: runtime.probeWhatsAppWebSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeWhatsAppWebOperation(recipe, input, auth, options),
        linkedDeviceLifecycle: {
          inspect: runtime.inspectWhatsAppProtocolRuntime,
          pair: (auth, options) => runtime.pairWhatsAppAuth(auth, options),
          syncOnce: async (auth, options) => {
            const result = await runtime.syncWhatsAppAuthOnce(auth, options);
            return {
              itemsStored: result.messagesStored,
              projection: "local-store",
              emitsProtocolAcknowledgements: true,
            };
          },
        },
      };
    }),
  }],
});

export default whatsappLinkedDevicePlugin;
