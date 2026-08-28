import { describe, expect, test } from "bun:test";

import { twitchWebPlugin } from "./plugin";

const binding = twitchWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("Twitch web-session binding is unavailable");
}

describe("Twitch provider plugin", () => {
  test("advertises one exact authenticated profile statistics read", () => {
    expect(twitchWebPlugin).toMatchObject({
      id: "twitch-web",
      version: "1.1.0",
      sourceKind: "built-in",
    });
    expect(binding).toMatchObject({
      surfaceId: "twitch",
      origin: "https://gql.twitch.tv",
      manifestOrigins: ["https://www.twitch.tv"],
      protectedHostnameFamilies: ["twitch.tv"],
      authKinds: ["browser-profile", "cookie-source", "cookies-file"],
      operations: [{
        name: "profiles.read",
        contractVersion: 1,
        contractVersions: [1],
        risk: "R1",
        state: "observed",
        dispatch: "none",
        input: {
          properties: {
            profile: { type: "string", minLength: 4, maxLength: 25 },
          },
          required: ["profile"],
        },
      }],
    });
    expect(binding.subject.matches("twitch:123456789")).toBeTrue();
    expect(binding.subject.matches("twitch:not-a-number")).toBeFalse();
  });

  test("loads only the code-owned Twitch runtime", async () => {
    const runtime = await binding.loadRuntime();
    expect(runtime.probe).toBeFunction();
    expect(runtime.execute).toBeFunction();
    expect(binding.operations[0]?.planDispatches({ profile: "wrench_test" }))
      .toEqual([]);
  });
});
