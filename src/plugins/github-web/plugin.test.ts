import { describe, expect, test } from "bun:test";

import { githubWebPlugin } from "./plugin";

const binding = githubWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("GitHub web-session binding is unavailable");
}

describe("GitHub provider plugin", () => {
  test("advertises public exact profile and organization statistics reads", () => {
    expect(githubWebPlugin).toMatchObject({
      id: "github-web",
      version: "1.1.0",
      sourceKind: "built-in",
    });
    expect(binding).toMatchObject({
      surfaceId: "github",
      origin: "https://api.github.com",
      manifestOrigins: ["https://github.com"],
      protectedHostnameFamilies: ["api.github.com", "github.com"],
      authKinds: ["browser-profile"],
    });
    const profile = binding.operations.find((operation) =>
      operation.name === "profiles.read");
    const organization = binding.operations.find((operation) =>
      operation.name === "organizations.read");
    expect(binding.operations).toHaveLength(2);
    expect(profile).toMatchObject({
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
    expect(organization).toMatchObject({
      name: "organizations.read",
      access: "public",
      contractVersion: 1,
      risk: "R1",
      state: "observed",
      dispatch: "none",
      input: {
        properties: {
          organization: { type: "string", minLength: 1, maxLength: 39 },
        },
        required: ["organization"],
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
    })).rejects.toThrow("do not use an auth realm");
  });
});
