import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalJson,
  parseDiagnosticManifest,
  parseRuntimeManifest,
  sha256,
  type WebSessionRecipe,
} from "./model";
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
      "1c79b86a2133354878d44483e5a78efa9560f8c7f8f2c1014a20d0c998c0024f",
    );
    expect(webSessionContractHash(linkedinFeed)).toBe(
      "0ae0b0279917a5964578558aa3e761d467a121b6fe4d04c09441f279fcb0f30f",
    );
    expect(webSessionContractHash(facebookFeed)).toBe(
      "c87f38bc96f0e54dd58a58cb91a7877284322729db9d7cdb21c18bfd0e0091bd",
    );
    expect(webSessionContractHash(facebookGroupFeed)).toBe(
      "b6cc776e9a81a359dd50c07922b567789ece27a765dc8b7a670b7f1b71b896e7",
    );
    expect(webSessionContractHash(marketplaceFeed)).toBe(
      "bda0da0b1e00d2e240f1acd7e70f78e9e6db89246578e5508810baa5a8cbcdb2",
    );
    expect(webSessionContractHash(marketplaceListing)).toBe(
      "33dc0285d94e8f682b2f487de88a61077adb6e1b4c5070b65e6670a74924db42",
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
    const historicalMarketplaceFeed = contract({
      site: "facebook-marketplace",
      action: "feeds.read",
      contractVersion: 1,
    });
    expect(isCompatibleWebSessionContractHash(
      xLike,
      "18ad1c307b5aeb1caaa6e057048ba53e0bf7dfca8f35dd7ee9613942c3d23afa",
    )).toBeTrue();
    expect(isCompatibleWebSessionContractHash(
      facebookFeed,
      "208db74b57370fb1e5014cd65ac3f4df317a889147609f473524c11a7bd25b0a",
    )).toBeTrue();
    expect(isCompatibleWebSessionContractHash(
      facebookGroupFeed,
      "c4278bec1e4c44f60a99214a0a9662296345a6f9973ad332114da387f9bb4eaa",
    )).toBeTrue();
    expect(isCompatibleWebSessionContractHash(
      marketplaceFeed,
      "a9cad660c87a3bd8b112d9032560e93895ff26d7ae990b828dd580eb7a22d63e",
    )).toBeTrue();
    expect(isCompatibleWebSessionContractHash(
      marketplaceListing,
      "1541620ea7a56f072901d676fefbb24f55ce2fd63726c8c8ceeef7043d0deec6",
    )).toBeTrue();
    expect(isCompatibleWebSessionContractHash(
      historicalMarketplaceFeed,
      "c6a59efe3cd132112a3c4516007f0224e51af9f7288219b124c4820551ae89c7",
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
      "dabc37e84a27c799b978298f6c87f8b392968105475ea62b5b48fb7ac055828d",
    );
    expect(() => contract({
      site: "facebook-marketplace",
      action: "feeds.read",
      contractVersion: 3,
    })).toThrow("is not installed");

    expect(contract({
      site: "x",
      action: "articles.publish",
      contractVersion: 4,
    })).toMatchObject({ contractVersion: 4, state: "capture-required" });
    for (const contractVersion of [1, 2, 3, 5]) {
      expect(() => contract({
        site: "x",
        action: "articles.publish",
        contractVersion,
      })).toThrow("is not installed");
    }

    const historicalXArticleDraft = contract({
      site: "x",
      action: "articles.draft.save",
      contractVersion: 1,
    });
    const activeXArticleDraft = contract({
      site: "x",
      action: "articles.draft.save",
      contractVersion: 2,
    });
    expect(historicalXArticleDraft.input.required).toEqual(["title", "document"]);
    expect(historicalXArticleDraft.input.properties.inline_images).toBeUndefined();
    expect(activeXArticleDraft.input.required).toEqual(["title", "document", "inline_images"]);
    expect(webSessionContractHash(historicalXArticleDraft)).not.toBe(
      webSessionContractHash(activeXArticleDraft),
    );

    const historicalLinkedInArticleDraft = contract({
      site: "linkedin",
      action: "articles.draft.save",
      contractVersion: 2,
    });
    const activeLinkedInArticleDraft = contract({
      site: "linkedin",
      action: "articles.draft.save",
      contractVersion: 7,
    });
    expect(historicalLinkedInArticleDraft.input.required).toEqual(["title", "document"]);
    expect(historicalLinkedInArticleDraft.input.properties.inline_images).toBeUndefined();
    expect(activeLinkedInArticleDraft.input.required).toEqual([
      "title",
      "document",
      "inline_images",
    ]);
    expect(activeLinkedInArticleDraft.input.properties.cover_image).toMatchObject({
      type: "file",
      maxBytes: 5 * 1024 * 1024,
    });
    expect(webSessionContractHash(historicalLinkedInArticleDraft)).not.toBe(
      webSessionContractHash(activeLinkedInArticleDraft),
    );
    expect(() => contract({
      site: "linkedin",
      action: "articles.draft.save",
      contractVersion: 3,
    })).toThrow("is not installed");
  });

  test("keeps retired X Article manifests diagnostic-only instead of projecting v4 semantics", () => {
    for (const adapterVersion of ["1.1.0", "1.2.0", "1.3.0"]) {
      const archived = JSON.parse(readFileSync(join(
        import.meta.dir,
        "assets",
        "adapters",
        "x",
        `wrench-web-adapter.v${adapterVersion}.json`,
      ), "utf8")) as unknown;
      expect(parseDiagnosticManifest(archived, providerPluginRegistry).ok).toBeTrue();
      const runtime = parseRuntimeManifest(archived, providerPluginRegistry);
      expect(runtime.ok).toBeFalse();
      if (runtime.ok) continue;
      expect(runtime.issues.some((issue) => issue.includes("posts.publish@1")))
        .toBeTrue();
      expect(runtime.issues.some((issue) => issue.includes("articles.publish")))
        .toBeTrue();
    }
  });

  test("observes bounded LinkedIn profile reads while keeping unrelated discovery inert", () => {
    for (const action of [
      "messaging.list",
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

    for (const action of ["profiles.read", "organizations.read"] as const) {
      expect(contract({ site: "linkedin", action, contractVersion: 1 })).toMatchObject({
        site: "linkedin",
        operation: action,
        risk: "R1",
        state: "observed",
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

  test("observes exact Meta and Substack profile-stat reads", () => {
    for (const site of ["instagram", "threads"] as const) {
      expect(contract({ site, action: "profiles.read", contractVersion: 1 })).toMatchObject({
        site,
        operation: "profiles.read",
        risk: "R1",
        state: "observed",
        dispatch: "none",
        sideEffect: "none",
        idempotency: "none",
      });
    }

    for (const action of ["profiles.read", "organizations.read"] as const) {
      expect(contract({ site: "substack", action, contractVersion: 1 })).toMatchObject({
        site: "substack",
        operation: action,
        risk: "R1",
        state: "observed",
        dispatch: "none",
        sideEffect: "none",
        idempotency: "none",
      });
    }
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
