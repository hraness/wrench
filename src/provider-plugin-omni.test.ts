import { describe, expect, test } from "bun:test";

import { providerPluginRegistry } from "./provider-plugins";

const supported = new Set([
  "beeper-linked-device/beeper/messaging.list",
  "beeper-linked-device/beeper/messaging.read",
  "gmail-official/gmail/messaging.list",
  "gmail-official/gmail/messaging.read",
  "imessage-direct/imessage/messaging.list",
  "imessage-direct/imessage/messaging.read",
  "meta-web/instagram/messaging.list",
  "reddit-web/reddit/messaging.list",
  "reddit-web/reddit/messaging.read",
  "substack-web/substack/messaging.list",
  "whatsapp-linked-device/whatsapp/messaging.list",
  "whatsapp-linked-device/whatsapp/messaging.read",
]);

describe("provider plugin omni declarations", () => {
  test("every installed messaging read declares support or a bounded reason", () => {
    const observed = new Set<string>();
    for (const plugin of providerPluginRegistry.list()) {
      for (const binding of plugin.bindings) {
        for (const operation of binding.operations) {
          if (operation.name !== "messaging.list" && operation.name !== "messaging.read") continue;
          const key = `${plugin.id}/${binding.surfaceId}/${operation.name}`;
          const omni = operation.omni;
          expect(omni, key).toBeDefined();
          if (omni?.state === "supported") {
            observed.add(key);
            expect(omni.schemaVersion).toBe(1);
            expect(omni.materializerVersion).toBeGreaterThan(0);
            expect(typeof omni.materialize).toBe("function");
          } else {
            expect(omni?.reason.length ?? 0, key).toBeGreaterThan(10);
          }
        }
      }
    }
    expect(observed).toEqual(supported);
  });

  test("legacy explicit roots retain each provider-owned materializer", () => {
    const expectedLabels = new Map([
      ["gmail-official", "providers/gmail-omni.ts"],
      ["meta-web", "providers/meta-omni.ts"],
      ["reddit-web", "providers/reddit-omni.ts"],
      ["substack-web", "providers/substack-omni.ts"],
      ["whatsapp-linked-device", "providers/whatsapp-omni.ts"],
    ]);
    for (const [pluginId, label] of expectedLabels) {
      const plugin = providerPluginRegistry.get(pluginId);
      expect(plugin, pluginId).toBeDefined();
      expect(plugin?.implementationSources.some((source) => source.label === label), pluginId)
        .toBeTrue();
    }
  });
});
