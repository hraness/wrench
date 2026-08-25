import { describe, expect, test } from "bun:test";

import beeperManifest from "./assets/adapters/beeper/wrench-web-adapter.json";
import { providerPluginRegistry } from "./provider-plugins";

describe("Beeper linked-device provider plugin", () => {
  test("registers exactly the bounded read surface without lifecycle or mutations", () => {
    const plugin = providerPluginRegistry.get("beeper-linked-device");
    const binding = providerPluginRegistry.requireSessionRoute("beeper");
    expect(plugin?.displayName).toBe("Beeper Local Read-Only");
    expect(plugin?.version).toBe("1.1.0");
    expect(beeperManifest.version).toBe("1.1.0");
    expect(Object.keys(beeperManifest.operations)).toEqual([
      "contacts.list",
      "contacts.search",
      "messaging.list",
      "messaging.search",
      "messaging.read",
    ]);
    expect(binding.transport).toBe("linked-device");
    if (binding.transport !== "linked-device") {
      throw new Error("Beeper installed the wrong transport");
    }
    expect(binding.authKinds).toEqual(["linked-device-store"]);
    expect(binding.linkedDeviceLifecycle).toBeUndefined();
    expect(providerPluginRegistry.legacyContractImplementationHashes(binding, "contacts.list", 1)
      .map((value) => value.toString("hex")))
      .toContain("1110e1a6b99720c912451fa44d764f2f48590cbf7f2568aa199068adedf1c9f0");
    expect(providerPluginRegistry.legacyContractImplementationHashes(binding, "contacts.search", 1))
      .toEqual([]);
    expect(() =>
      providerPluginRegistry.legacyContractImplementationHashes(binding, "contacts.list", 2)
    ).toThrow("does not own operation contacts.list@2");
    expect(binding.operations.map((operation) => operation.name)).toEqual([
      "contacts.list",
      "contacts.search",
      "messaging.list",
      "messaging.read",
      "messaging.search",
    ]);
    expect(binding.operations.every((operation) =>
      operation.risk === "R1" && operation.state === "observed"
    )).toBeTrue();
    expect(binding.subject.matches(
      `beeper:local:${"a".repeat(64)}`,
    )).toBeTrue();
    expect(binding.subject.matches("beeper:mxid:reversible")).toBeFalse();
  });
});
