import { describe, expect, test } from "bun:test";

import { substackWebPlugin } from "./plugin";

const binding = substackWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("Substack web-session binding is unavailable");
}

describe("Substack web provider plugin", () => {
  test("declares exact accepted-target reconciliation for current Note publishing", () => {
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
