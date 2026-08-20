import { describe, expect, test } from "bun:test";

import { xWebPlugin } from "./plugin";

const binding = xWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("X web-session binding is unavailable");
}

describe("X web provider plugin", () => {
  test("declares exact accepted-target reconciliation for current post publishing", () => {
    const publish = binding.operations.filter((operation) =>
      operation.name === "posts.publish");
    expect(publish.map((operation) => operation.contractVersion)).toEqual([2, 3, 4]);
    const current = publish.find((operation) => operation.contractVersion === 4);
    expect(current).toMatchObject({
      contractVersion: 4,
      risk: "R3",
      state: "observed",
      dispatch: "single",
      reconciliation: {
        kind: "provider-accepted-target-presence",
      },
    });
    expect(current?.historicalContractVersions).toBeUndefined();
    expect(current?.input.properties.media).toMatchObject({
      mediaTypes: ["image/png", "video/mp4"],
    });
    expect(binding.reconcile).toBeFunction();
  });

  test("keeps PNG-only posts.publish recovery distinct from current MP4 admission", () => {
    const publish = binding.operations.filter((operation) =>
      operation.name === "posts.publish");
    const archivedV2 = publish.find((operation) => operation.contractVersion === 2);
    const archivedV3 = publish.find((operation) => operation.contractVersion === 3);
    expect(archivedV2).toMatchObject({
      contractVersion: 2,
      risk: "R3",
      state: "observed",
      dispatch: "single",
      reconciliation: {
        kind: "provider-accepted-target-presence",
      },
    });
    expect(archivedV3).toMatchObject({
      contractVersion: 3,
      risk: "R3",
      state: "observed",
      dispatch: "single",
      reconciliation: {
        kind: "provider-accepted-target-presence",
      },
    });
    expect(archivedV2?.input.properties.media).toMatchObject({
      mediaTypes: ["image/png"],
    });
    expect(archivedV3?.input.properties.media).toMatchObject({
      mediaTypes: ["image/png"],
    });
    expect(archivedV2?.historicalContractVersions).toBeUndefined();
    expect(archivedV3?.historicalContractVersions).toBeUndefined();
  });
});
