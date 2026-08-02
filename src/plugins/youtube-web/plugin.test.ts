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
      expect(operation?.reconciliation?.desiredState({ [key]: value })).toBe(value);
      expect(() => operation?.reconciliation?.desiredState({ [key]: "invalid" }))
        .toThrow(`requires boolean input.${key}`);
    }
    const runtime = await binding.loadRuntime();
    expect(runtime.reconcile).toBeFunction();
    expect(runtime.reconcile!("feeds.read", {}, auth)).rejects.toThrow(
      "has no reconciliation hook",
    );
  });
});
