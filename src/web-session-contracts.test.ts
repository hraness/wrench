import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256, type WebSessionRecipe } from "./model";
import {
  getWebSessionContract as getWebSessionContractWithRegistry,
  isCompatibleWebSessionContractHash as isCompatibleWebSessionContractHashWithRegistry,
  webSessionContractHash as webSessionContractHashWithRegistry,
} from "./web-session-contracts";
import { providerPluginRegistry } from "./provider-plugins";

const webSessionContractHash = (
  contract: Parameters<typeof webSessionContractHashWithRegistry>[0],
) => webSessionContractHashWithRegistry(contract, providerPluginRegistry);
const isCompatibleWebSessionContractHash = (
  value: Parameters<typeof isCompatibleWebSessionContractHashWithRegistry>[0],
  candidate: Parameters<typeof isCompatibleWebSessionContractHashWithRegistry>[1],
) => isCompatibleWebSessionContractHashWithRegistry(
  value,
  candidate,
  providerPluginRegistry,
);

function contract(
  recipe: Pick<WebSessionRecipe, "site" | "action" | "contractVersion">,
) {
  return getWebSessionContractWithRegistry({
    ...recipe,
    timeoutMs: 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
  }, providerPluginRegistry);
}

describe("authenticated web-session contract identity", () => {
  test("binds executable implementation sources as reviewed hash fixtures", () => {
    const xLike = contract({ site: "x", action: "likes.set", contractVersion: 2 });
    const linkedinFeed = contract({ site: "linkedin", action: "feeds.read", contractVersion: 1 });
    const facebookFeed = contract({ site: "facebook", action: "feeds.read", contractVersion: 2 });
    const facebookGroupFeed = contract({
      site: "facebook-group",
      action: "feeds.read",
      contractVersion: 2,
    });
    const marketplaceFeed = contract({
      site: "facebook-marketplace",
      action: "feeds.read",
      contractVersion: 2,
    });
    const marketplaceListing = contract({
      site: "facebook-marketplace",
      action: "listings.read",
      contractVersion: 2,
    });

    // Writers use the exact predecessor runtime identities produced with
    // NODE_ENV unset. Runtime source closure is verified independently.
    expect(webSessionContractHash(xLike)).toBe(
      "5aeb891f8f11efee76410533e67004780530d3aace92c3f568e33cf6adf5249d",
    );
    expect(webSessionContractHash(linkedinFeed)).toBe(
      "aaa540ac05fab3c4025804ed732b7ef27ca23239cc97a660189463700e763e5c",
    );
    expect(webSessionContractHash(facebookFeed)).toBe(
      "0a8ce87112f248801d37c3e2ac9e51eb110fac2dd55ed3484c7d9e63767577c6",
    );
    expect(webSessionContractHash(facebookGroupFeed)).toBe(
      "4c38d484c22a519221103a13c691a8bee19b6aa1691e9228de4b7c38fdf00477",
    );
    expect(webSessionContractHash(marketplaceFeed)).toBe(
      "eff468a039212130bef21d454f5e013457edc79a1285f7016cf74f0f8e574337",
    );
    expect(webSessionContractHash(marketplaceListing)).toBe(
      "477ee5c357cabaafd7762316664a0c599a2c429acbd8e2157cd7a9635bf5f28f",
    );

    for (const value of [
      xLike,
      linkedinFeed,
      facebookFeed,
      facebookGroupFeed,
      marketplaceFeed,
      marketplaceListing,
    ]) {
      expect(webSessionContractHash(value)).not.toBe(sha256(canonicalJson(value)));
    }
  });

  test("accepts exact bounded predecessor hashes only as read aliases", () => {
    const xLike = contract({ site: "x", action: "likes.set", contractVersion: 2 });
    const marketplaceFeed = contract({
      site: "facebook-marketplace",
      action: "feeds.read",
      contractVersion: 2,
    });
    expect(isCompatibleWebSessionContractHash(
      xLike,
      "18ad1c307b5aeb1caaa6e057048ba53e0bf7dfca8f35dd7ee9613942c3d23afa",
    )).toBeTrue();
    expect(isCompatibleWebSessionContractHash(
      marketplaceFeed,
      "2200d78efc2489cf7d00105e91f05691aaa75528d3f2ff49607b905eaf32df65",
    )).toBeTrue();
    expect(isCompatibleWebSessionContractHash(
      xLike,
      "f".repeat(64),
    )).toBeFalse();
  });

  test("keeps distinct contracts distinct even when they share one implementation bundle", () => {
    const xLike = contract({ site: "x", action: "likes.set", contractVersion: 2 });
    const xBookmark = contract({ site: "x", action: "content.save", contractVersion: 1 });
    expect(webSessionContractHash(xLike)).not.toBe(webSessionContractHash(xBookmark));
  });

  test("preserves the exact durable identity of installed historical routes", () => {
    const historical = contract({ site: "x", action: "likes.set", contractVersion: 1 });
    const active = contract({ site: "x", action: "likes.set", contractVersion: 2 });
    expect(historical.contractVersion).toBe(1);
    expect(active.contractVersion).toBe(2);
    expect(webSessionContractHash(historical)).not.toBe(webSessionContractHash(active));

    const historicalMarketplaceFeed = contract({
      site: "facebook-marketplace",
      action: "feeds.read",
      contractVersion: 1,
    });
    expect(webSessionContractHash(historicalMarketplaceFeed)).toBe(
      "e2cbb33f532222bdb683a5c31456cbe43f712862e4f6dc27f39fba81538ce3f9",
    );
    expect(() => contract({
      site: "facebook-marketplace",
      action: "feeds.read",
      contractVersion: 3,
    })).toThrow("is not installed");
  });

  test("keeps LinkedIn inbox and discovery contracts inert until recapture", () => {
    for (const action of [
      "messaging.list",
      "profiles.read",
      "organizations.read",
      "relationships.recommendations.read",
    ] as const) {
      expect(contract({ site: "linkedin", action, contractVersion: 1 })).toMatchObject({
        site: "linkedin",
        operation: action,
        risk: "R1",
        state: "capture-required",
        dispatch: "none",
        sideEffect: "none",
        idempotency: "none",
      });
    }

    expect(contract({
      site: "linkedin",
      action: "relationships.connect",
      contractVersion: 1,
    })).toMatchObject({
      site: "linkedin",
      operation: "relationships.connect",
      risk: "R3",
      state: "capture-required",
      dispatch: "single",
      idempotency: "local-at-most-once",
      dedupeWindowMs: 86_400_000,
    });
  });

  test("keeps every Marketplace mutation capture-required", () => {
    const binding = providerPluginRegistry.requireSessionRoute(
      "facebook-marketplace",
    );
    for (const operation of binding.operations) {
      const value = contract({
        site: "facebook-marketplace",
        action: operation.name,
        contractVersion: operation.contractVersion,
      });
      if (value.sideEffect === "none") continue;
      expect(value.risk === "R2" || value.risk === "R3" || value.risk === "R4")
        .toBeTrue();
      expect(value.state).toBe("capture-required");
      expect(value.implementation).toContain(
        "requires a fresh reviewed authenticated first-party contract before execution",
      );
    }
  });
});
