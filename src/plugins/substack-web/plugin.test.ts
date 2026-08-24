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

  test("keeps video inert while graduating exact personal-Note deletion", () => {
    const video = binding.operations.find((candidate) => candidate.name === "media.publish");
    expect(video).toMatchObject({
      contractVersion: 1,
      risk: "R3",
      state: "capture-required",
      dispatch: "single",
    });
    expect(video).not.toHaveProperty("reconciliation");
    const deletion = binding.operations.find((candidate) => candidate.name === "content.delete");
    expect(deletion).toMatchObject({
        contractVersion: 1,
        risk: "R3",
        state: "observed",
        dispatch: "single",
        reconciliation: { kind: "boolean-desired-state" },
      });
    expect(deletion?.planDispatches({
      expected_body: "temporary",
      note_id: 404,
    })).toEqual([{
      id: "content.delete",
      description: "Dispatch one reviewed content.delete internal API action",
    }]);
    expect(deletion?.reconciliation?.kind === "boolean-desired-state"
      ? deletion.reconciliation.desiredState({})
      : null).toBeFalse();
    expect(binding.operations.find((operation) => operation.name === "media.publish")
      ?.input.properties.media).toMatchObject({
        maxBytes: 128 * 1024 * 1024,
        mediaTypes: ["video/mp4"],
        type: "file",
      });
    expect(binding.operations.find((operation) => operation.name === "articles.publish")
      ?.input.properties.media).toMatchObject({ maxBytes: 512 * 1024 * 1024 });
  });
});
