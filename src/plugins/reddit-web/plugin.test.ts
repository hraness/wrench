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
  test("keeps the broad media reservation inert beside metadata-only hosted-video reads", () => {
    expect(redditWebPlugin.version).toBe("1.4.0");
    const reads = binding.operations.filter((operation) =>
      operation.name === "media.read");
    expect(reads.map((operation) => operation.contractVersion)).toEqual([1, 2]);
    const current = reads.find((operation) => operation.contractVersion === 2);
    const archived = reads.find((operation) => operation.contractVersion === 1);
    expect(current).toMatchObject({
      contractVersion: 2,
      risk: "R1",
      state: "observed",
      dispatch: "none",
    });
    expect(archived).toMatchObject({
      contractVersion: 1,
      risk: "R1",
      state: "capture-required",
      dispatch: "none",
    });
  });

  test("declares exact desired-state and accepted-target reconciliation", async () => {
    const save = binding.operations.find((operation) => operation.name === "content.save");
    const deletion = binding.operations.find((operation) => operation.name === "content.delete");
    const media = binding.operations.find((operation) =>
      operation.name === "media.publish" && operation.contractVersion === 9
    );
    const archivedMedia = binding.operations.find((operation) =>
      operation.name === "media.publish" && operation.contractVersion === 1
    );
    const archivedMediaV2 = binding.operations.find((operation) =>
      operation.name === "media.publish" && operation.contractVersion === 2
    );
    const archivedMediaV3 = binding.operations.find((operation) =>
      operation.name === "media.publish" && operation.contractVersion === 3
    );
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
    expect(deletion?.reconciliation?.kind).toBe("boolean-desired-state");
    if (deletion?.reconciliation?.kind !== "boolean-desired-state") {
      throw new Error("expected boolean Reddit deletion reconciliation");
    }
    expect(deletion.reconciliation.desiredState({})).toBeFalse();
    expect(media?.reconciliation).toEqual({ kind: "provider-accepted-target-presence" });
    expect(media).toMatchObject({ contractVersion: 9, state: "observed" });
    expect(archivedMedia).toMatchObject({
      contractVersion: 1,
      state: "capture-required",
    });
    expect(archivedMedia?.reconciliation).toBeUndefined();
    expect(archivedMediaV2).toMatchObject({
      contractVersion: 2,
      state: "capture-required",
    });
    expect(archivedMediaV2?.reconciliation).toBeUndefined();
    expect(archivedMediaV3).toMatchObject({
      contractVersion: 3,
      state: "capture-required",
    });
    expect(archivedMediaV3?.reconciliation).toBeUndefined();
    expect(binding.operations
      .filter((operation) => operation.reconciliation !== undefined)
      .map((operation) => operation.name)).toEqual([
        "content.delete",
        "content.save",
        "media.publish",
      ]);

    const runtime = await binding.loadRuntime();
    expect(runtime.reconcile).toBeFunction();
    expect(runtime.reconcile!("reactions.set", {}, auth)).rejects.toThrow(
      "has no reconciliation hook",
    );
  });
});
