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
    ["kernel/storage.ts", "../../storage.ts"],
    ["providers/whatsapp-web.ts", "../../providers/whatsapp-web.ts"],
    ["providers/whatsapp-web-runtime.ts", "../../providers/whatsapp-web-runtime.ts"],
  ]),
  bindings: [{
    transport: "linked-device",
    surfaceId: "whatsapp",
    origin: "https://web.whatsapp.com",
    protectedHostnameFamilies: ["whatsapp.com"],
    authKinds: linkedDeviceAuthKinds,
    operations: webSessionContractOperations(
      Object.values(whatsappContracts),
      "fec7017105b6d31e8913ccda4c451cb2a4dcd967e20f6dde7190fdec69a2afde",
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
