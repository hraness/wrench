import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../../auth";
import { youtubeWebPlugin } from "./plugin";

const binding = youtubeWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("YouTube web-session binding is unavailable");
}

const auth = {
  schemaVersion: 1,
  id: "youtube-plugin-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
  subject: `youtube:channel:UC${"a".repeat(22)}`,
} as const satisfies WrenchAuth;

describe("YouTube provider plugin", () => {
  test("versions the narrowed MP4 and authored-video delete reservations", () => {
    expect(youtubeWebPlugin.version).toBe("1.3.0");
    const videoPublish = binding.operations.find((operation) =>
      operation.name === "media.publish");
    expect(videoPublish?.contractVersion).toBe(2);
    expect(videoPublish?.risk).toBe("R3");
    expect(videoPublish?.state).toBe("capture-required");
    expect(videoPublish?.implementation).toContain("selected MP4 remained at 0%");
    const videoMedia = videoPublish?.input.properties.media;
    if (videoMedia?.type !== "file") {
      throw new Error("YouTube video publishing media input is unavailable");
    }
    expect(videoMedia.maxBytes).toBe(128 * 1024 * 1024);
    const videoMediaTypes = videoMedia.mediaTypes;
    if (videoMediaTypes === undefined) {
      throw new Error("YouTube video publishing media types are unavailable");
    }
    expect(videoMediaTypes).toHaveLength(1);
    expect(videoMediaTypes[0]).toBe("video/mp4");

    const postMedia = binding.operations.find((operation) =>
      operation.name === "posts.publish")?.input.properties.media;
    if (postMedia?.type !== "file") {
      throw new Error("YouTube post publishing media input is unavailable");
    }
    expect(postMedia.maxBytes).toBe(20 * 1024 * 1024);

    const contentDelete = binding.operations.find((operation) =>
      operation.name === "content.delete");
    expect(contentDelete?.contractVersion).toBe(1);
    expect(contentDelete?.risk).toBe("R3");
    expect(contentDelete?.state).toBe("capture-required");
    expect(contentDelete?.implementation).toContain(
      "discarded the stalled incomplete Studio draft",
    );
    expect(Object.isFrozen(videoPublish)).toBeTrue();
    expect(Object.isFrozen(videoMedia)).toBeTrue();
    expect(Object.isFrozen(postMedia)).toBeTrue();
    expect(Object.isFrozen(contentDelete)).toBeTrue();
  });

  test("keeps all three boolean reconciliations capture-required", async () => {
    const expected = {
      "likes.set": ["liked", true],
      "content.save": ["saved", false],
      "relationships.follow.set": ["followed", true],
    } as const;
    expect(binding.operations
      .filter((operation) => operation.reconciliation !== undefined)
      .map((operation) => operation.name)
      .sort()).toEqual(Object.keys(expected).sort());
    for (const [name, [key, value]] of Object.entries(expected)) {
      const operation = binding.operations.find((candidate) => candidate.name === name);
      expect(operation?.state).toBe("capture-required");
      const reconciliation = operation?.reconciliation;
      if (reconciliation?.kind !== "boolean-desired-state") {
        throw new Error("expected boolean YouTube reconciliation");
      }
      expect(reconciliation.desiredState({ [key]: value })).toBe(value);
      expect(() => reconciliation.desiredState({ [key]: "invalid" }))
        .toThrow(`requires boolean input.${key}`);
    }
    const runtime = await binding.loadRuntime();
    expect(runtime.reconcile).toBeFunction();
    expect(runtime.reconcile!("feeds.read", {}, auth)).rejects.toThrow(
      "has no reconciliation hook",
    );
  });
});
