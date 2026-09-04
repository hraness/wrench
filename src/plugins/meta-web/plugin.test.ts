import { describe, expect, test } from "bun:test";

import { metaWebPlugin } from "./plugin";

function binding(surfaceId: string) {
  const result = metaWebPlugin.bindings.find((candidate) =>
    candidate.surfaceId === surfaceId);
  if (result === undefined) throw new Error(`missing Meta binding ${surfaceId}`);
  return result;
}

describe("Meta web plugin account subjects", () => {
  test("ships the browser-contained Instagram profile reader in the current plugin", () => {
    expect(metaWebPlugin.version).toBe("1.5.0");
    expect(metaWebPlugin.implementationSources.map((source) => source.label))
      .toContain("providers/instagram-web-profile-browser.ts");
  });

  test("accepts only canonical positive decimal account IDs", () => {
    const cases = [
      ["instagram", "instagram:"],
      ["threads", "threads:"],
      ["facebook", "facebook:user:"],
      ["facebook-page", "facebook:user:"],
      ["facebook-group", "facebook:user:"],
      ["facebook-marketplace", "facebook:user:"],
    ] as const;

    for (const [surfaceId, prefix] of cases) {
      const subject = binding(surfaceId).subject;
      expect(subject.matches(`${prefix}1`)).toBeTrue();
      expect(subject.matches(`${prefix}${"9".repeat(32)}`)).toBeTrue();
      for (const id of ["", "0", "00", "01", "001", "1.0", "-1", "9".repeat(33)]) {
        expect(subject.matches(`${prefix}${id}`)).toBeFalse();
      }
    }
  });

  test("declares exact accepted-target reconciliation only for Threads publishing", () => {
    const threadsPublish = binding("threads").operations.find((operation) =>
      operation.name === "posts.publish");
    const threadsVideoPublish = binding("threads").operations.find((operation) =>
      operation.name === "media.publish");
    expect(threadsPublish?.historicalContractVersions).toEqual([1, 2, 3, 4]);
    expect(threadsPublish?.reconciliation).toEqual({
      kind: "provider-accepted-target-presence",
    });
    expect(threadsVideoPublish).toMatchObject({
      state: "observed",
      contractVersion: 1,
      reconciliation: { kind: "provider-accepted-target-presence" },
    });
    for (const surfaceId of [
      "facebook",
      "facebook-page",
      "facebook-group",
      "facebook-marketplace",
    ]) {
      expect(binding(surfaceId).operations.some((operation) =>
        operation.reconciliation !== undefined)).toBeFalse();
    }
  });

  test("keeps narrowed Instagram video publishing inert and exposes authored deletion", () => {
    const instagram = binding("instagram");
    const videoPublish = instagram.operations.find((operation) =>
      operation.name === "media.publish" && operation.contractVersion === 3);
    expect(videoPublish).toMatchObject({
        contractVersion: 3,
        risk: "R3",
        state: "capture-required",
        dispatch: "single",
      });
    expect(videoPublish?.reconciliation).toBeUndefined();
    expect(videoPublish?.input.properties.media).toMatchObject({
      maxBytes: 128 * 1024 * 1024,
      mediaTypes: ["video/mp4"],
      type: "file",
    });
    expect(videoPublish?.input.properties.thumbnail).toMatchObject({
      maxBytes: 8 * 1024 * 1024,
      mediaTypes: ["image/jpeg"],
      type: "file",
    });
    expect(instagram.operations.find((operation) => operation.name === "messaging.send")
      ?.input.properties.attachment).toMatchObject({ maxBytes: 1024 * 1024 * 1024 });
    expect(instagram.operations.find((operation) =>
      operation.name === "content.delete" && operation.contractVersion === 2))
      .toMatchObject({
        contractVersion: 2,
        risk: "R3",
        state: "observed",
        dispatch: "single",
        reconciliation: {
          kind: "provider-bound-target-desired-state",
          desiredState: false,
        },
      });
  });
});
