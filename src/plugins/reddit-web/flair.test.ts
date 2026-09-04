import { describe, expect, test } from "bun:test";
import manifest from "../../assets/adapters/reddit/wrench-web-adapter.json";
import { createProviderPluginRegistry } from "../../provider-plugin-registry";
import { redditWebPlugin } from "./plugin";
import {
  REDDIT_FLAIR_OPERATION_NAMES, parseRedditFlairInput, redditFlairContracts,
} from "./flair";

const templateId = "01234567-89ab-cdef-0123-456789abcdef";
const choice = { community: "example", template_id: templateId, expected_text: "Discussion" };

test("flair routes inherit no predecessor identities while existing routes retain every reader", () => {
  const registry = createProviderPluginRegistry([redditWebPlugin]);
  const binding = registry.list()[0]!.bindings[0]!;
  let predecessorRoutes = 0;
  for (const operation of binding.operations) {
    for (const version of operation.contractVersions) {
      const aliases = registry.legacyContractImplementationHashes(binding, operation.name, version);
      if (operation.name.startsWith("flair.")) {
        expect(aliases).toEqual([]);
      } else {
        predecessorRoutes += 1;
        expect(aliases.map((hash) => hash.toString("hex"))).toEqual([
          "64a4c1e78ce8565a50613f63ff605f0f57f488617ef31386b5ddce5e3db885c9",
          "058987e5eac61505ca53f80d8494fb5505e697e0313e6e197a198649be7c3a3c",
          "05173089ec6d555845fa5fb7b08a70bd0bf810a18882c9ecdd784a437db791c5",
          "dea85e9a5bc2a134ce48769655c2e4df89d68a876012b4af3e08f40526d02512",
          "16e4e48609c12d5ffdaf47e622764e06cc9b3381c6b8ceb2c9f773fa9d99bdd9",
          "91cc3364ab1ccba66bd2e099f64fcccc187fde94145a8bf1eaa14f0f5533f6d7",
          "646a29b320373f50ccdf9ae8b8b60d5147428f0f899a226480c2c5b009294d8a",
        ]);
      }
    }
  }
  expect(predecessorRoutes).toBe(28);
});

describe("Reddit flair input boundaries", () => {
  test("user choices cannot select a different account", () => {
    expect(parseRedditFlairInput("flair.user.choices", { community: "example" }))
      .toEqual({ action: "choices", target: { kind: "user", community: "example" } });
    expect(() => parseRedditFlairInput("flair.user.choices", {
      community: "example", username: "another_account",
    })).toThrow("unsupported fields");
  });

  test("post choices bind one exact post instead of a comment or URL", () => {
    expect(parseRedditFlairInput("flair.post.choices", {
      community: "example", post_id: "t3_abc123",
    })).toEqual({ action: "choices", target: {
      kind: "post", community: "example", postId: "t3_abc123",
    } });
    for (const postId of ["t1_abc123", "abc123", "t3_abc/123", "https://reddit.com/"]) {
      expect(() => parseRedditFlairInput("flair.post.choices", {
        community: "example", post_id: postId,
      })).toThrow("post fullname");
    }
  });

  test("selection binds a template and expected label, never custom text", () => {
    expect(parseRedditFlairInput("flair.user.select", choice)).toEqual({
      action: "select", target: { kind: "user", community: "example" },
      templateId, expectedText: "Discussion",
    });
    expect(() => parseRedditFlairInput("flair.user.select", {
      ...choice, text: "Doctor",
    })).toThrow("unsupported fields");
    expect(() => parseRedditFlairInput("flair.user.select", {
      community: "example", template_id: templateId,
    })).toThrow("missing");
    for (const invalidId of ["", "Discussion", templateId.toUpperCase(), `${templateId}/`]) {
      expect(() => parseRedditFlairInput("flair.user.select", {
        ...choice, template_id: invalidId,
      })).toThrow("template ID");
    }
    for (const label of ["", " Discussion", "Discussion\n", "a".repeat(257)]) {
      expect(() => parseRedditFlairInput("flair.user.select", {
        ...choice, expected_text: label,
      })).toThrow("exact label");
    }
  });

  test("community input cannot introduce a path, origin, or hidden field", () => {
    for (const community of ["r/example", "../example", "example?x=1", "a", "a".repeat(22)]) {
      expect(() => parseRedditFlairInput("flair.user.choices", { community }))
        .toThrow("exact subreddit");
    }
    for (const value of [null, [], true, "example", {}]) {
      expect(() => parseRedditFlairInput("flair.user.choices", value)).toThrow();
    }
  });
});

test("flair manifest reservations match code-owned risk and input boundaries", () => {
  expect(redditFlairContracts.map((contract) => contract.operation))
    .toEqual([...REDDIT_FLAIR_OPERATION_NAMES]);
  for (const contract of redditFlairContracts) {
    const operation = manifest.operations[contract.operation as keyof typeof manifest.operations];
    expect<unknown>(operation.input).toEqual(contract.input);
    expect(operation.risk).toBe(contract.risk);
    expect(operation.sideEffect).toBe(contract.sideEffect);
    expect(operation.idempotency).toBe(contract.idempotency);
    expect(operation.dedupeWindowMs).toBe(contract.dedupeWindowMs);
    expect(operation.webSession.contractVersion).toBe(contract.contractVersion);
    expect(contract.state).toBe("capture-required");
  }
});
