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
      "5f0c08ad357254f86200c7c8361842ef2f92da191ebfd15cf3d08b63ed67c8f7",
    );
    expect(webSessionContractHash(facebookFeed)).toBe(
      "cb0e4de0914f571021d53285160bdbe6da7b1709edd5c3d7057a727c8f133d31",
    );
    expect(webSessionContractHash(facebookGroupFeed)).toBe(
      "e80d4c9932d035a8a76709bd03eaa13faa54f36b931ac69134e4bbcc6447d80e",
    );
    expect(webSessionContractHash(marketplaceFeed)).toBe(
      "d23fdd180adbf41c4571d84ff86f49787e34000606a6f5852db38d165a77b56f",
    );
    expect(webSessionContractHash(marketplaceListing)).toBe(
      "06186e24a8f7299df5c07da3931a5f0c5f6d48996c449ed924fc739f58072083",
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
      "79c88540eaa000472a95eef33ea7c24e6fe52c68a03f185c59cce83d6163df14",
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
