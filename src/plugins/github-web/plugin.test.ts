import { describe, expect, test } from "bun:test";

import { githubWebPlugin } from "./plugin";

const binding = githubWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("GitHub web-session binding is unavailable");
}

describe("GitHub provider plugin", () => {
  test("advertises one public exact profile read", () => {
    expect(githubWebPlugin).toMatchObject({
      id: "github-web",
      version: "1.0.0",
      sourceKind: "built-in",
    });
    expect(binding).toMatchObject({
      surfaceId: "github",
      origin: "https://api.github.com",
      manifestOrigins: ["https://github.com"],
      protectedHostnameFamilies: ["api.github.com", "github.com"],
      authKinds: ["browser-profile"],
    });
    expect(binding.operations).toHaveLength(1);
    expect(binding.operations[0]).toMatchObject({
      name: "profiles.read",
      access: "public",
      contractVersion: 1,
      risk: "R1",
      state: "observed",
      dispatch: "none",
      input: {
        properties: {
          username: { type: "string", minLength: 1, maxLength: 39 },
        },
        required: ["username"],
      },
    });
    expect(binding.executePublic).toBeFunction();
  });

  test("keeps authenticated hooks inert", async () => {
    const runtime = await binding.loadRuntime();
    await expect(runtime.probe({
      schemaVersion: 1,
      id: "unused",
      kind: "browser-profile",
      profile: "unused",
      trustUnfilteredEgress: true,
    })).rejects.toThrow("is public and does not use an auth realm");
  });
});
