import { describe, expect, test } from "bun:test";

import { xWebPlugin } from "./plugin";

const binding = xWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("X web-session binding is unavailable");
}

describe("X web provider plugin", () => {
  test("versions the profile-read source closure independently", () => {
    expect(xWebPlugin.version).toBe("1.3.0");
  });

  test("keeps the generic Article reservation inert beside the exact private-draft read", () => {
    const reads = binding.operations.filter((operation) =>
      operation.name === "articles.read");
    expect(reads.map((operation) => operation.contractVersion)).toEqual([1, 2]);
    const current = reads.find((operation) => operation.contractVersion === 2);
    const archived = reads.find((operation) => operation.contractVersion === 1);
    expect(current).toMatchObject({
      contractVersion: 2,
      risk: "R1",
      state: "observed",
      dispatch: "none",
      input: {
        properties: {
          article_id: { type: "string", minLength: 1, maxLength: 19 },
        },
        required: ["article_id"],
      },
    });
    expect(archived).toMatchObject({
      contractVersion: 1,
      risk: "R1",
      state: "capture-required",
      dispatch: "none",
    });
  });

  test("advertises the observed exact handle-bound profile read", () => {
    const profile = binding.operations.find((operation) =>
      operation.name === "profiles.read");
    expect(profile).toMatchObject({
      contractVersion: 1,
      risk: "R1",
      state: "observed",
      dispatch: "none",
      input: {
        properties: {
          handle: { type: "string", minLength: 1, maxLength: 15 },
        },
        required: ["handle"],
      },
    });
  });

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
