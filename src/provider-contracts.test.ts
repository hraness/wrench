import { describe, expect, test } from "bun:test";

import {
  type OfficialProviderId,
  type OperationInput,
  type ProviderRecipe,
} from "./model";
import {
  officialProviderOperations,
  providerContracts,
} from "./provider-catalog-views";
import type { SemanticOperationName } from "./platform-catalog";
import {
  getProviderContract as getProviderContractWithRegistry,
  isCompatibleProviderContractHash as isCompatibleProviderContractHashWithRegistry,
  planProviderDispatches as planProviderDispatchesWithRegistry,
  providerConditionalInputIssues as providerConditionalInputIssuesWithRegistry,
  providerContractHash as providerContractHashWithRegistry,
  type ProviderContract,
} from "./provider-contracts";
import { providerPluginRegistry } from "./provider-plugins";

const getProviderContract = (
  value: Parameters<typeof getProviderContractWithRegistry>[0],
) => getProviderContractWithRegistry(value, providerPluginRegistry);
const providerContractHash = (
  value: Parameters<typeof providerContractHashWithRegistry>[0],
) => providerContractHashWithRegistry(value, providerPluginRegistry);
const isCompatibleProviderContractHash = (
  value: Parameters<typeof isCompatibleProviderContractHashWithRegistry>[0],
  candidate: Parameters<typeof isCompatibleProviderContractHashWithRegistry>[1],
) => isCompatibleProviderContractHashWithRegistry(
  value,
  candidate,
  providerPluginRegistry,
);
const planProviderDispatches = (
  value: Parameters<typeof planProviderDispatchesWithRegistry>[0],
  input: Parameters<typeof planProviderDispatchesWithRegistry>[1],
) => planProviderDispatchesWithRegistry(value, input, providerPluginRegistry);
const providerConditionalInputIssues = (
  value: Parameters<typeof providerConditionalInputIssuesWithRegistry>[0],
  input: Parameters<typeof providerConditionalInputIssuesWithRegistry>[1],
) => providerConditionalInputIssuesWithRegistry(
  value,
  input,
  providerPluginRegistry,
);

function recipe(provider: OfficialProviderId, action: SemanticOperationName, contractVersion = 1): ProviderRecipe {
  return { provider, action, contractVersion, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 };
}

describe("official provider contract registry", () => {
  test("exhaustively binds every advertised action to one provider, operation, version, and risk", () => {
    for (const provider of ["linkedin", "x"] as const) {
      const contracts = providerContracts[provider] as Readonly<Record<string, ProviderContract>>;
      const advertised = officialProviderOperations[provider];
      if (advertised === undefined) {
        throw new Error(`provider plugin surface ${provider} is not registered`);
      }
      expect(Object.keys(contracts).sort()).toEqual([...advertised].sort());
      for (const [operation, contract] of Object.entries(contracts)) {
        expect(contract).toMatchObject({ provider, operation, contractVersion: 1 });
        expect(getProviderContract(recipe(provider, operation as SemanticOperationName))).toBe(contract);
        expect(contract.requiredScopeSets.length).toBeGreaterThan(0);
        expect(contract.requiredScopeSets.every((set) => set.length > 0 && new Set(set).size === set.length)).toBeTrue();
        expect(contract.coverage.length).toBeGreaterThan(0);
      }
    }
    expect("likes.set" in providerContracts.x).toBeFalse();
  });

  test("hashes canonical contract semantics deterministically", () => {
    // Writers use the exact predecessor runtime identities produced with
    // NODE_ENV unset. Runtime source closure is verified independently.
    expect(providerContractHash(providerContracts.linkedin["posts.read"]))
      .toBe("9556a8001eaeddf5c29830af38c537f7865609d2692e32939b6e7390a799add9");
    expect(providerContractHash(providerContracts.x["feeds.read"]))
      .toBe("15279e85ef6993084cc63726fc82dc0fc4e87601e3395ce6d512e958b72f9fd6");

    const contracts: readonly ProviderContract[] = [
      ...Object.values(providerContracts.linkedin),
      ...Object.values(providerContracts.x),
    ];
    const hashes = contracts.map((contract) => providerContractHash(contract));
    expect(hashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash))).toBeTrue();
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(providerContractHash(structuredClone(providerContracts.x["feeds.read"])))
      .toBe(providerContractHash(providerContracts.x["feeds.read"]));
    expect(() => getProviderContract(recipe("x", "feeds.read", 2))).toThrow("x/feeds.read@2 is not installed");
  });

  test("accepts exact bounded predecessor hashes only as read aliases", () => {
    expect(isCompatibleProviderContractHash(
      providerContracts.linkedin["posts.read"],
      "9430dad8b4014a2159966c85e230c6659b6da2704c965830a81f892323ad6146",
    )).toBeTrue();
    expect(isCompatibleProviderContractHash(
      providerContracts.x["feeds.read"],
      "9e92465a393d4586d48d4728a9d697ae5080810e048e6a84d4b8414a969d6085",
    )).toBeTrue();
    expect(isCompatibleProviderContractHash(
      providerContracts.x["feeds.read"],
      "f".repeat(64),
    )).toBeFalse();
    // Arbitrary predecessor NODE_ENV values are intentionally not wildcarded:
    // retained work from such a mode must be previewed again before execution.
    expect(isCompatibleProviderContractHash(
      providerContracts.linkedin["posts.read"],
      "386355fbf6d512b5e63b94785fa01b1554883d7b6b1ca7b5e2ada31926b6042f",
    )).toBeFalse();
  });

  test("plans zero, one, and exact ordered thread dispatches without provider input drift", () => {
    expect(planProviderDispatches(recipe("x", "feeds.read"), { feed: "home-reverse-chronological" })).toEqual([]);
    expect(planProviderDispatches(recipe("linkedin", "comments.create"), {
      actor: "urn:li:person:1",
      target_urn: "urn:li:share:2",
      object_urn: "urn:li:activity:2",
      body: "hello",
    })).toEqual([{ id: "comments-create", description: "Execute linkedin comments.create" }]);
    expect(planProviderDispatches(recipe("x", "threads.publish"), { items: ["first", "second", "third"] })).toEqual([
      { id: "publish-item[1]", description: "Publish confirmed thread item 1" },
      { id: "publish-item[2]", description: "Publish confirmed thread item 2" },
      { id: "publish-item[3]", description: "Publish confirmed thread item 3" },
    ]);
    expect(() => planProviderDispatches(recipe("x", "threads.publish"), {})).toThrow("validated items array");
  });

  test("binds truthful feed, inbox, and pagination coverage", () => {
    const feeds = providerContracts.x["feeds.read"];
    expect(feeds.coverage).toEqual([
      "home-reverse-chronological",
      "user-posts",
      "mentions",
      "list-posts",
      "recent-search-7-days",
      "bookmarks",
    ]);
    expect(feeds.implementation).toContain("never For You");
    expect(feeds.input.properties.cursor).toMatchObject({ type: "string", maxLength: 4_096 });
    expect(feeds.input.properties.limit).toMatchObject({ type: "number", maximum: 100 });

    const messages = providerContracts.x["messaging.list"];
    expect(messages.coverage).toEqual(["dm-events-30-days", "chat-conversations", "chat-encrypted-events"]);
    expect(messages.implementation).toContain("ciphertext envelopes but not plaintext or inbox folders");
    expect(messages.input.properties.cursor).toMatchObject({ type: "string", maxLength: 4_096 });
    expect(messages.input.properties.limit).toMatchObject({ type: "number", maximum: 100 });

    const send = providerContracts.x["messaging.send"];
    expect(send.requiredScopeSets).toEqual([["dm.write", "dm.read", "tweet.read", "users.read"]]);
    expect(send.input.required).not.toContain("body");

    const publish = providerContracts.x["posts.publish"];
    expect(publish.input.required).not.toContain("body");
    expect(publish.input.properties.reply_settings.enum).toEqual([
      "everyone",
      "mentionedUsers",
      "following",
      "subscribers",
      "verified",
    ]);
    expect(publish.input.properties.media_alt_texts.items).toMatchObject({ type: "string", maxLength: 1_000 });

    expect(providerContracts.x["comments.read"].coverage).toEqual([
      "replies-recent-search-7-days",
      "replies-full-archive-search",
    ]);
    expect(providerContracts.x["threads.publish"].input.properties.media).toMatchObject({ maxItems: 25 });

    expect(providerContracts.linkedin["posts.read"].implementation).toContain("no home-feed reconstruction");
    expect("messaging.list" in providerContracts.linkedin).toBeFalse();

    const linkedInPublish = providerContracts.linkedin["posts.publish"];
    expect(linkedInPublish.input.properties.media.items.mediaTypes).toContain("video/mp4");
    expect(linkedInPublish.input.properties.media.items.mediaTypes).not.toContain("video/quicktime");
    expect(linkedInPublish.input.properties.media.items.description).toContain("at least 75,000 bytes");
    expect(linkedInPublish.input.properties.article_title).toMatchObject({ maxLength: 399 });
    expect(linkedInPublish.implementation).toContain("poll assets to AVAILABLE");
    expect(linkedInPublish.implementation).toContain("omit thumbnail; no URL scraping");

    const linkedInReaction = providerContracts.linkedin["reactions.set"];
    expect(linkedInReaction.input.required).not.toContain("reaction");
    expect(linkedInReaction.implementation).toContain("clears any current actor reaction");
  });
});

describe("provider conditional input laws", () => {
  const conditionalIssues = (
    provider: OfficialProviderId,
    action: SemanticOperationName,
    input: OperationInput,
  ): readonly string[] => providerConditionalInputIssues(recipe(provider, action), input);

  test("makes LinkedIn post lookup modes and post content unions unambiguous", () => {
    expect(conditionalIssues("linkedin", "posts.read", { mode: "one", post_urn: "urn:li:share:1" })).toEqual([]);
    expect(conditionalIssues("linkedin", "posts.read", { mode: "author", author: "urn:li:person:1" })).toEqual([]);
    expect(conditionalIssues("linkedin", "posts.read", { mode: "one" })).toContain("input.post_urn is required when mode is one");
    expect(conditionalIssues("linkedin", "posts.read", {
      mode: "one",
      post_urn: "urn:li:share:1",
      author: "urn:li:person:1",
    })).toContain("input.author is not accepted when mode is one");
    expect(conditionalIssues("linkedin", "posts.read", {
      mode: "author",
      author: "urn:li:person:1",
      post_urn: "urn:li:share:1",
    })).toContain("input.post_urn is not accepted when mode is author");

    expect(conditionalIssues("linkedin", "posts.publish", {
      author: "urn:li:person:1",
      body: "post",
      article_url: "http://example.com/article",
    })).toContain("input.article_url must be a credential-free HTTPS URL");
    expect(conditionalIssues("linkedin", "posts.publish", {
      author: "urn:li:person:1",
      body: "post",
      article_url: "https://example.com/article",
    })).toContain("input.article_title is required with input.article_url");
    expect(conditionalIssues("linkedin", "posts.publish", {
      author: "urn:li:person:1",
      body: "post",
      article_title: "orphaned title",
    })).toContain("input.article_title and input.article_description require input.article_url");
    expect(conditionalIssues("linkedin", "posts.publish", {
      author: "urn:li:person:1",
      body: "post",
      article_url: "https://example.com/article",
      media: [{ kind: "file", reference: "asset:1" }],
    })).toContain("input.media and input.article_url are mutually exclusive");
  });

  test("requires a reaction only for create and forbids a misleading type for clear", () => {
    expect(conditionalIssues("linkedin", "reactions.set", {
      actor: "urn:li:person:1",
      target_urn: "urn:li:share:2",
      enabled: true,
    })).toContain("input.reaction is required when input.enabled is true");
    expect(conditionalIssues("linkedin", "reactions.set", {
      actor: "urn:li:person:1",
      target_urn: "urn:li:share:2",
      reaction: "LIKE",
      enabled: false,
    })).toContain("input.reaction is not accepted when input.enabled is false because the operation clears any current reaction");
    expect(conditionalIssues("linkedin", "reactions.set", {
      actor: "urn:li:person:1",
      target_urn: "urn:li:share:2",
      reaction: "LIKE",
      enabled: true,
    })).toEqual([]);
    expect(conditionalIssues("linkedin", "reactions.set", {
      actor: "urn:li:person:1",
      target_urn: "urn:li:share:2",
      enabled: false,
    })).toEqual([]);
  });

  test("requires exactly the selector used by each X feed and message view", () => {
    expect(conditionalIssues("x", "feeds.read", { feed: "home-reverse-chronological" })).toEqual([]);
    expect(conditionalIssues("x", "feeds.read", { feed: "user" })).toContain("input.user_id is required for user and mentions feeds");
    expect(conditionalIssues("x", "feeds.read", { feed: "list" })).toContain("input.list_id is required for the list feed");
    expect(conditionalIssues("x", "feeds.read", { feed: "recent-search" })).toContain("input.query is required for recent-search");
    expect(conditionalIssues("x", "feeds.read", {
      feed: "home-reverse-chronological",
      query: "from:someone",
    })).toContain("input.query is accepted only for recent-search");
    expect(conditionalIssues("x", "feeds.read", { feed: "list", list_id: "1", since_id: "2" }))
      .toContain("input.since_id is not accepted for list");
    expect(conditionalIssues("x", "feeds.read", { feed: "bookmarks", exclude_replies: true }))
      .toContain("input.exclude_replies is not accepted for bookmarks");
    expect(conditionalIssues("x", "feeds.read", { feed: "mentions", user_id: "1", sort: "recency" }))
      .toContain("input.sort is accepted only for recent-search");
    expect(conditionalIssues("x", "feeds.read", { feed: ["invalid"], since_id: "2" }))
      .toContain("input.since_id is not accepted for unknown feed");

    expect(conditionalIssues("x", "messaging.list", { view: "all" })).toEqual([]);
    expect(conditionalIssues("x", "messaging.list", { view: "participant" }))
      .toContain("input.target_id is required for participant, conversation, and chat-events views");
    expect(conditionalIssues("x", "messaging.list", { view: "all", target_id: "123" }))
      .toContain("input.target_id is not accepted when view is all");
    expect(conditionalIssues("x", "messaging.list", { view: "chat-conversations" })).toEqual([]);
    expect(conditionalIssues("x", "messaging.list", { view: "chat-events" }))
      .toContain("input.target_id is required for participant, conversation, and chat-events views");
    expect(conditionalIssues("x", "messaging.list", { view: "chat-events", target_id: "g123" })).toEqual([]);
    expect(conditionalIssues("x", "messaging.list", { view: "chat-events", target_id: "group-123" }))
      .toContain("input.target_id must be an exact X Chat recipient or conversation ID");
    expect(conditionalIssues("x", "messaging.list", { view: "chat-events", target_id: "42-42" }))
      .toContain("input.target_id must identify two different X Chat participants");
  });

  test("requires complete polls and rejects media/poll ambiguity", () => {
    expect(conditionalIssues("x", "posts.publish", { body: "post" })).toEqual([]);
    expect(conditionalIssues("x", "posts.publish", { body: "post", poll_options: ["yes", "no"] }))
      .toContain("input.poll_options and input.poll_duration_minutes must be supplied together");
    expect(conditionalIssues("x", "posts.publish", {
      body: "post",
      poll_options: ["yes", "no"],
      poll_duration_minutes: 60,
      media: [{ kind: "file", reference: "asset:1" }],
    })).toContain("input.media and poll inputs are mutually exclusive");
    expect(conditionalIssues("x", "posts.publish", {}))
      .toContain("input.body, input.media, or complete poll inputs are required for an X post");
    expect(conditionalIssues("x", "posts.publish", {
      media: [{ kind: "file", reference: "asset:1" }],
      made_with_ai: true,
    })).toEqual([]);
    expect(conditionalIssues("x", "posts.publish", { body: "text", made_with_ai: true }))
      .toContain("input.made_with_ai can be true only when reviewed media is attached");
    expect(conditionalIssues("x", "posts.publish", { poll_options: ["yes", "no"], poll_duration_minutes: 1.5 }))
      .toContain("input.poll_duration_minutes must be a safe integer");
  });

  test("accepts attachment-only replies and DMs while rejecting empty content", () => {
    expect(conditionalIssues("x", "replies.create", {
      target_post_id: "1",
      media: [{ kind: "file", reference: "asset:1" }],
      recipient_opted_in: true,
      author_invited_reply: true,
    })).toEqual([]);
    expect(conditionalIssues("x", "replies.create", {
      target_post_id: "1",
      recipient_opted_in: true,
      author_invited_reply: true,
    })).toContain("input.body or input.media is required for an X reply");
    expect(conditionalIssues("x", "messaging.send", {
      target_kind: "participant",
      target_id: "2",
      media: { kind: "file", reference: "asset:2" },
      recipient_opted_in: true,
    })).toEqual([]);
    expect(conditionalIssues("x", "messaging.send", {
      target_kind: "participant",
      target_id: "2",
      recipient_opted_in: true,
    })).toContain("input.body or input.media is required for an X Direct Message");
    expect(conditionalIssues("x", "messaging.send", {
      target_kind: "participant",
      target_id: "2",
      body: "text",
      media_alt_text: "orphaned",
      recipient_opted_in: true,
    })).toContain("input.media_alt_text requires input.media");
    expect(conditionalIssues("x", "posts.publish", {
      media: [{ kind: "file", reference: "asset:1" }],
      media_alt_texts: ["one", "two"],
    })).toContain("input.media_alt_texts must align one-to-one with input.media");
  });

  test("binds thread media to exact one-based items", () => {
    expect(conditionalIssues("x", "threads.publish", {
      items: ["one", "two"],
      media: [{ kind: "file", reference: "asset:1" }],
      media_item_indices: [2],
      media_alt_texts: ["description"],
    })).toEqual([]);
    expect(conditionalIssues("x", "threads.publish", {
      items: ["one"],
      media: [{ kind: "file", reference: "asset:1" }],
    })).toContain("input.media and input.media_item_indices must be supplied together");
    expect(conditionalIssues("x", "threads.publish", {
      items: ["one"],
      media: [{ kind: "file", reference: "asset:1" }],
      media_item_indices: [2],
    })).toContain("input.media_item_indices[0] must name an existing one-based thread item");
  });

  test("rejects malformed and duplicate X identifiers", () => {
    expect(conditionalIssues("x", "posts.read", { post_ids: ["1", "1"] }))
      .toContain("input.post_ids must contain unique X post IDs");
    expect(conditionalIssues("x", "comments.read", { post_id: "not-an-id" }))
      .toContain("input.post_id must be a 1-19 digit X object ID");
    expect(conditionalIssues("x", "feeds.read", { feed: "user", user_id: "1", limit: 4 }))
      .toContain("input.limit must be at least 5 for user and mentions feeds");
    expect(conditionalIssues("x", "feeds.read", { feed: "recent-search", query: "x", limit: 10.5 }))
      .toContain("input.limit must be a safe integer");
  });
});
