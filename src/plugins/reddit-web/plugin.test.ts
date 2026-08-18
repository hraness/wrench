import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../../auth";
import { redditWebPlugin } from "./plugin";

const binding = redditWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("Reddit web-session binding is unavailable");
}

const auth = {
  schemaVersion: 1,
  id: "reddit-plugin-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: "reddit:t2_viewer1",
} as const satisfies WrenchAuth;

describe("Reddit provider plugin", () => {
  test("declares boolean reconciliation only for saved state", async () => {
    const save = binding.operations.find((operation) => operation.name === "content.save");
    const reaction = binding.operations.find((operation) => operation.name === "reactions.set");
    expect(save?.state).toBe("capture-required");
    const reconciliation = save?.reconciliation;
    if (reconciliation?.kind !== "boolean-desired-state") {
      throw new Error("expected boolean Reddit reconciliation");
    }
    expect(reconciliation.desiredState({ saved: true })).toBeTrue();
    expect(() => reconciliation.desiredState({ saved: 1 }))
      .toThrow("requires boolean input.saved");
    expect(reaction?.state).toBe("capture-required");
    expect(reaction?.reconciliation).toBeUndefined();
    expect(binding.operations
      .filter((operation) => operation.reconciliation !== undefined)
      .map((operation) => operation.name)).toEqual(["content.save"]);

    const runtime = await binding.loadRuntime();
    expect(runtime.reconcile).toBeFunction();
    expect(runtime.reconcile!("reactions.set", {}, auth)).rejects.toThrow(
      "has no reconciliation hook",
    );
  });
});
