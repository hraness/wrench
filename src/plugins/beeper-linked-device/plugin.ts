import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
} from "../../provider-plugin";
import {
  linkedDeviceAuthKinds,
  webImplementationSources,
  webSessionContractOperations,
} from "../../provider-plugin-builtins";
import { webSessionContractDefinitions } from "../../web-session-contract-definitions";
import {
  materializeBeeperMessagingList,
  materializeBeeperMessagingRead,
} from "../../providers/beeper-omni";

const beeperContracts = webSessionContractDefinitions.beeper;
if (beeperContracts === undefined) {
  throw new Error("Beeper local read contracts are not installed");
}

export const beeperLinkedDevicePlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "beeper-linked-device",
  version: "1.0.0",
  displayName: "Beeper Local Read-Only",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/auth.ts", "../../auth.ts"],
    ["kernel/storage.ts", "../../storage.ts"],
    ["providers/contact-projection.ts", "../../providers/contact-projection.ts"],
    ["providers/beeper-local.ts", "../../providers/beeper-local.ts"],
    ["providers/beeper-local-runtime.ts", "../../providers/beeper-local-runtime.ts"],
    ["providers/beeper-omni.ts", "../../providers/beeper-omni.ts"],
  ]),
  bindings: [{
    transport: "linked-device",
    surfaceId: "beeper",
    origin: "https://www.beeper.com",
    protectedHostnameFamilies: ["beeper.com"],
    authKinds: linkedDeviceAuthKinds,
    operations: webSessionContractOperations(
      Object.values(beeperContracts),
      "b80358d83a7062ea4e901b2b5564d1e72a5198ea5c2bb48f39ff815d15367aee",
      {},
      {
        "messaging.list": {
          state: "supported",
          schemaVersion: 1,
          materializerId: "beeper-messaging-list",
          materializerVersion: 1,
          materialize: materializeBeeperMessagingList,
        },
        "messaging.read": {
          state: "supported",
          schemaVersion: 1,
          materializerId: "beeper-messaging-read",
          materializerVersion: 1,
          materialize: materializeBeeperMessagingRead,
        },
      },
    ),
    subject: {
      format: "beeper:local:<sha256-account-coordinate>",
      matches: (value) => /^beeper:local:[a-f0-9]{64}$/u.test(value),
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/beeper-local-runtime");
      return {
        probe: runtime.probeBeeperLocalSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeBeeperLocalOperation(recipe, input, auth, options),
      };
    }),
  }],
});

export default beeperLinkedDevicePlugin;
