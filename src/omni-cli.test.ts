import { describe, expect, test } from "bun:test";

import type { OmniReadResultV1 } from "./omni-runtime";
import { providerPluginRegistry } from "./provider-plugins";
import { main } from "./wrench";

function response(
  source: OmniReadResultV1["source"],
): OmniReadResultV1 {
  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    source,
    identity: Object.freeze({
      invocationDigest: "0".repeat(64),
      requestDigest: "a".repeat(64),
      sourceSetDigest: "b".repeat(64),
    }),
    view: source === "omni-identity"
      ? null
      : Object.freeze({
          schemaVersion: 1,
          viewRevision: "c".repeat(64),
          entities: Object.freeze([]),
          nextCursor: null,
          sources: Object.freeze([]),
        }),
  });
}

const input = JSON.stringify({
  schemaVersion: 1,
  sources: [{
    adapterId: "reddit-web",
    operationId: "messaging.list",
    authId: "reddit-main",
    input: { folder: "inbox" },
  }],
});

describe("omni CLI dispatch", () => {
  test("keeps cache, identity, exact replay, and live modes disjoint", async () => {
    const calls: string[] = [];
    const overrides = {
      providerPluginRegistry,
      identifyOmniView: () => {
        calls.push("identity");
        return response("omni-identity");
      },
      readCachedOmniViewInternal: () => {
        calls.push("cache");
        return response("omni-cache");
      },
      rebuildOmniViewFromExactCache: () => {
        calls.push("exact");
        return response("omni-exact-cache");
      },
      revalidateOmniViewInternal: () => {
        calls.push("live");
        return Promise.resolve(response("omni-live"));
      },
    } as const;
    const run = async (mode: readonly string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await main(
        ["omni", "read", "--input", input, ...mode, "--json"],
        {},
        {
          stdout: (value) => { stdout += value; },
          stderr: (value) => { stderr += value; },
        },
        overrides,
      );
      expect(code).toBe(0);
      expect(stderr).toBe("");
      return JSON.parse(stdout) as { readonly source: string };
    };

    expect((await run(["--cache-only"])).source).toBe("omni-cache");
    expect(calls).toEqual(["cache"]);
    calls.length = 0;
    expect((await run(["--identity-only"])).source).toBe("omni-identity");
    expect(calls).toEqual(["identity"]);
    calls.length = 0;
    expect((await run(["--from-exact-cache"])).source).toBe("omni-exact-cache");
    expect(calls).toEqual(["exact"]);
    calls.length = 0;
    expect((await run([])).source).toBe("omni-live");
    expect(calls).toEqual(["live"]);
  });
});
