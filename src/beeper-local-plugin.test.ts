import { describe, expect, test } from "bun:test";

import { providerPluginRegistry } from "./provider-plugins";

describe("Beeper linked-device provider plugin", () => {
  test("registers exactly the bounded read surface without lifecycle or mutations", () => {
    const plugin = providerPluginRegistry.get("beeper-linked-device");
    const binding = providerPluginRegistry.requireSessionRoute("beeper");
    expect(plugin?.displayName).toBe("Beeper Local Read-Only");
    expect(binding.transport).toBe("linked-device");
    if (binding.transport !== "linked-device") {
      throw new Error("Beeper installed the wrong transport");
    }
    expect(binding.authKinds).toEqual(["linked-device-store"]);
    expect(binding.linkedDeviceLifecycle).toBeUndefined();
    expect(binding.operations.map((operation) => operation.name)).toEqual([
      "contacts.list",
      "messaging.list",
      "messaging.read",
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
