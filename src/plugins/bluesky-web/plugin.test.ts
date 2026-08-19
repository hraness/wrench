import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../../auth";
import { blueskyWebPlugin } from "./plugin";

const binding = blueskyWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("Bluesky web-session binding is unavailable");
}

const auth = {
  schemaVersion: 1,
  id: "bluesky-plugin-test",
  kind: "browser-profile",
  profile: "Test Profile",
  trustUnfilteredEgress: true,
  subject: `did:plc:${"a".repeat(24)}`,
} as const satisfies WrenchAuth;

describe("Bluesky provider plugin", () => {
  test("advertises exactly the runtime auth and protected hostname families", () => {
    expect(binding.authKinds).toEqual(["browser-profile"]);
    expect(binding.protectedHostnameFamilies).toEqual([
      "bsky.app",
      "bsky.social",
      "host.bsky.network",
    ]);
  });

  test("keeps reversible state capture-required and deletion exact-target reconciliable", async () => {
    const expected = {
      "likes.set": ["liked", true],
      "content.save": ["saved", false],
      "relationships.follow.set": ["followed", true],
      "posts.repost": ["reposted", false],
    } as const;
    expect(binding.operations
      .filter((operation) => operation.reconciliation !== undefined)
      .map((operation) => operation.name)
      .sort()).toEqual([...Object.keys(expected), "content.delete", "posts.publish"].sort());
    for (const [name, [key, value]] of Object.entries(expected)) {
      const operation = binding.operations.find((candidate) => candidate.name === name);
      expect(operation?.state).toBe("capture-required");
      const reconciliation = operation?.reconciliation;
      if (reconciliation?.kind !== "boolean-desired-state") {
        throw new Error("expected boolean Bluesky reconciliation");
      }
      expect(reconciliation.desiredState({ [key]: value })).toBe(value);
      expect(() => reconciliation.desiredState({ [key]: "invalid" }))
        .toThrow(`requires boolean input.${key}`);
    }
    const deletion = binding.operations.find((operation) =>
      operation.name === "content.delete");
    expect(deletion?.state).toBe("observed");
    expect(deletion?.risk).toBe("R3");
    if (deletion?.reconciliation?.kind !== "boolean-desired-state") {
      throw new Error("expected boolean Bluesky deletion reconciliation");
    }
    expect(deletion.reconciliation.desiredState({})).toBeFalse();
    const publish = binding.operations.find((operation) =>
      operation.name === "posts.publish");
    expect(publish?.historicalContractVersions).toEqual([2]);
    expect(publish?.reconciliation).toEqual({
      kind: "provider-accepted-target-presence",
    });
    const runtime = await binding.loadRuntime();
    expect(runtime.reconcile).toBeFunction();
    expect(runtime.reconcile!("feeds.read", {}, auth)).rejects.toThrow(
      "has no reconciliation hook",
    );
  });
});
