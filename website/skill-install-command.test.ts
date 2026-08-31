import { describe, expect, test } from "bun:test";

import { copyText } from "./source/skill-install-command";

describe("Agent Skill install command", () => {
  test("prefers the async clipboard and copies the exact command", async () => {
    const command = "npx skills add hraness/wrench#v0.17.0";
    const writes: string[] = [];
    let fallbackCalls = 0;
    const result = await copyText(
      command,
      { writeText: async (value) => { writes.push(value); } },
      () => {
        fallbackCalls += 1;
        return true;
      },
    );

    expect(result).toBe("clipboard");
    expect(writes).toEqual([command]);
    expect(fallbackCalls).toBe(0);
  });

  test("uses selection-based copy when clipboard access is denied", async () => {
    const result = await copyText(
      "npx skills add hraness/wrench#v0.17.0",
      { writeText: () => Promise.reject(new Error("denied")) },
      () => true,
    );

    expect(result).toBe("fallback");
  });

  test("reports manual selection when neither copy path succeeds", async () => {
    expect(await copyText("command", undefined, () => false)).toBe("manual");
    expect(await copyText("command", undefined, () => { throw new Error("blocked"); }))
      .toBe("manual");
  });
});
