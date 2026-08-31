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

const telegramContracts = webSessionContractDefinitions.telegram;
if (telegramContracts === undefined) {
  throw new Error("Telegram TDLib contracts are not installed");
}

export const telegramLinkedDevicePlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "telegram-linked-device",
  version: "1.0.0",
  displayName: "Telegram TDLib User Session",
  sourceKind: "built-in",
  implementationSources: webImplementationSources(import.meta.url, [
    ["kernel/auth.ts", "../../auth.ts"],
    ["kernel/storage.ts", "../../storage.ts"],
    ["providers/contact-projection.ts", "../../providers/contact-projection.ts"],
    ["providers/telegram-tdlib.ts", "../../providers/telegram-tdlib.ts"],
    ["providers/telegram-tdlib-runtime.ts", "../../providers/telegram-tdlib-runtime.ts"],
    ["scripts/install-telegram-tdlib.sh", "../../scripts/install-telegram-tdlib.sh"],
    ["vendor/telegram-tdlib/CMakeLists.txt", "../../vendor/telegram-tdlib/CMakeLists.txt"],
    ["vendor/telegram-tdlib/LICENSE_1_0.txt", "../../vendor/telegram-tdlib/LICENSE_1_0.txt"],
    ["vendor/telegram-tdlib/README.md", "../../vendor/telegram-tdlib/README.md"],
    ["vendor/telegram-tdlib/manifest.json", "../../vendor/telegram-tdlib/manifest.json"],
    ["vendor/telegram-tdlib/wrench_telegram_tdlib.cpp", "../../vendor/telegram-tdlib/wrench_telegram_tdlib.cpp"],
  ]),
  bindings: [{
    transport: "linked-device",
    surfaceId: "telegram",
    origin: "https://telegram.org",
    protectedHostnameFamilies: ["telegram.org"],
    authKinds: linkedDeviceAuthKinds,
    operations: webSessionContractOperations(
      Object.values(telegramContracts),
      "b68eb737333a43c4c6ea21bd02e365ec4733962c125e3ea4e8a4b183328e281a",
    ),
    subject: {
      format: "telegram:user:<numeric-user-id>",
      matches: (value) => {
        const match = /^telegram:user:([1-9][0-9]{0,15})$/u.exec(value);
        const userId = match?.[1];
        if (userId === undefined) return false;
        const numericUserId = Number(userId);
        return Number.isSafeInteger(numericUserId)
          && numericUserId > 0
          && String(numericUserId) === userId;
      },
    },
    linkedDeviceLifecycle: {
      inspect: true,
      pair: true,
      syncOnce: true,
    },
    runtime: lazyWebSessionRuntime(async () => {
      const runtime = await import("../../providers/telegram-tdlib-runtime");
      return {
        probe: runtime.probeTelegramSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeTelegramTdlibOperation(recipe, input, auth, options),
        linkedDeviceLifecycle: {
          inspect: runtime.inspectTelegramTdlibRuntime,
          pair: (auth, options) => runtime.pairTelegramAuth(auth, options),
          syncOnce: async (auth, options) => {
            const result = await runtime.syncTelegramAuthOnce(auth, options);
            return {
              itemsStored: result.contactsStored,
              projection: "local-store",
              emitsProtocolAcknowledgements: true,
            };
          },
        },
      };
    }),
  }],
});

export default telegramLinkedDevicePlugin;
