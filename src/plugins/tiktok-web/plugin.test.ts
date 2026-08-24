import { describe, expect, test } from "bun:test";

import { tiktokWebPlugin } from "./plugin";

const binding = tiktokWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("TikTok web-session binding is unavailable");
}

describe("TikTok provider plugin", () => {
  test("versions the narrow MP4 and exact authored-post deletion reservations", () => {
    expect(tiktokWebPlugin.version).toBe("1.2.0");
    const publish = binding.operations.find((operation) => operation.name === "media.publish");
    expect(publish).toMatchObject({
      contractVersion: 2,
      historicalContractVersions: [1],
      risk: "R3",
      state: "capture-required",
      dispatch: "single",
    });
    expect(publish?.input.required).toEqual([
      "media",
      "audience",
      "allow_comments",
      "allow_duet",
      "allow_stitch",
      "allow_content_reuse",
      "allow_ai_remix",
      "contains_synthetic_media",
      "commercial_content",
    ]);
    expect(publish?.input.properties.media).toMatchObject({
      maxBytes: 128 * 1024 * 1024,
      type: "file",
      mediaTypes: ["video/mp4"],
    });
    expect(binding.operations.find((operation) => operation.name === "messaging.send")
      ?.input.properties.media).toMatchObject({ maxBytes: 512 * 1024 * 1024 });
    expect(binding.operations.find((operation) => operation.name === "content.schedule")
      ?.input.properties.media).toMatchObject({ maxBytes: 1024 * 1024 * 1024 });
    const deletion = binding.operations.find((operation) => operation.name === "content.delete");
    expect(deletion).toMatchObject({
      contractVersion: 1,
      risk: "R3",
      state: "capture-required",
      dispatch: "single",
    });
    expect(deletion?.input.required).toEqual(["post_id", "expected_caption"]);
    expect(Object.keys(deletion?.input.properties ?? {}).sort()).toEqual([
      "expected_caption",
      "post_id",
    ]);
    expect(binding.reconcile).toBeUndefined();
  });
});
