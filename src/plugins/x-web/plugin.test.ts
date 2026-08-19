import { describe, expect, test } from "bun:test";

import { xWebPlugin } from "./plugin";

const binding = xWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("X web-session binding is unavailable");
}

describe("X web provider plugin", () => {
  test("declares exact accepted-target reconciliation for current post publishing", () => {
    const publish = binding.operations.find((operation) =>
      operation.name === "posts.publish");
    expect(publish).toMatchObject({
      contractVersion: 3,
      risk: "R3",
      state: "observed",
      dispatch: "single",
      historicalContractVersions: [2],
      reconciliation: {
        kind: "provider-accepted-target-presence",
      },
    });
    expect(binding.reconcile).toBeFunction();
  });
});
