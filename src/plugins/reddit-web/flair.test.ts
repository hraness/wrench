import { describe, expect, test } from "bun:test";
import manifest from "../../assets/adapters/reddit/wrench-web-adapter.json";
import { createProviderPluginRegistry } from "../../provider-plugin-registry";
import { redditWebPlugin } from "./plugin";
import {
  REDDIT_FLAIR_OPERATION_NAMES,
  parseRedditFlairChoicesResponse,
  parseRedditFlairInput,
  redditFlairContracts,
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

  test("post choices target a new submission without accepting a caller-selected post", () => {
    expect(parseRedditFlairInput("flair.post.choices", {
      community: "example",
    })).toEqual({
      action: "choices",
      target: { kind: "post", community: "example" },
    });
    for (const postId of ["t1_abc123", "abc123", "t3_abc/123", "https://reddit.com/"]) {
      expect(() => parseRedditFlairInput("flair.post.choices", {
        community: "example", post_id: postId,
      })).toThrow("unsupported fields");
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

describe("Reddit flair choice projection", () => {
  const firstId = "680f43b8-1fec-11e3-80d1-12313b0b80bc";
  const secondId = "16cabd0a-a68d-11e5-8349-0e8ff96e6679";
  const response = {
    choices: [
      {
        flair_css_class: "satisfied",
        flair_template_id: firstId,
        flair_text_editable: false,
        flair_position: "left",
        flair_text: "SATISFIED",
      },
      {
        flair_css_class: "",
        flair_template_id: secondId,
        flair_text_editable: true,
        flair_position: "right",
        flair_text: "STATS",
      },
    ],
    current: {
      flair_css_class: "satisfied",
      flair_template_id: firstId,
      flair_text: "SATISFIED",
      flair_position: "left",
    },
  };

  test("projects bounded choices and binds the current selection", () => {
    expect(parseRedditFlairChoicesResponse(response, {
      community: "subreddit_stats",
      kind: "post",
    })).toEqual({
      schemaVersion: 1,
      community: "subreddit_stats",
      kind: "post",
      choices: [
        {
          templateId: firstId,
          text: "SATISFIED",
          textEditable: false,
          position: "left",
          selected: true,
        },
        {
          templateId: secondId,
          text: "STATS",
          textEditable: true,
          position: "right",
          selected: false,
        },
      ],
      selectedTemplateId: firstId,
      selectedText: "SATISFIED",
    });
  });

  test("projects the captured old-Reddit selector HTML without exposing form state", () => {
    expect(parseRedditFlairChoicesResponse(`
      <h2>select flair</h2>
      <div class="flairoptionpane"><ul>
        <li class="flairsample-left selected" id="${firstId}">
          <span class="linkflairlabel" title="SATISFIED">SATISFIED</span>
        </li>
        <li class="flairsample-right texteditable" id="${secondId}">
          <span class="flair stats">STATS &amp; DATA</span>
        </li>
      </ul></div>
      <form action="/post/selectflair" method="post">
        <div class="flairselection"></div>
        <input type="hidden" name="flair_template_id">
        <input type="text" name="text">
        <button type="submit">save</button>
      </form>
    `, { community: "subreddit_stats", kind: "post" })).toMatchObject({
      choices: [
        { templateId: firstId, text: "SATISFIED", selected: true },
        {
          templateId: secondId,
          text: "STATS & DATA",
          textEditable: true,
          position: "right",
          selected: false,
        },
      ],
      selectedTemplateId: firstId,
      selectedText: "SATISFIED",
    });
  });

  test("accepts only the exact selector unavailable state when no choices exist", () => {
    expect(parseRedditFlairChoicesResponse(`
      <h2>select flair</h2><div class="error">flair selection unavailable</div>
    `, { community: "example", kind: "user" }).choices).toEqual([]);
    expect(() => parseRedditFlairChoicesResponse(
      "<html><body>please sign in</body></html>",
      { community: "example", kind: "user" },
    )).toThrow("full or active document");
  });

  test("rejects provider drift, duplicate IDs, partial current state, and unsafe text", () => {
    expect(() => parseRedditFlairChoicesResponse({
      ...response,
      future: true,
    }, { community: "example", kind: "user" })).toThrow("reviewed fields");
    expect(() => parseRedditFlairChoicesResponse({
      ...response,
      choices: [response.choices[0], response.choices[0]],
    }, { community: "example", kind: "user" })).toThrow("repeated a template ID");
    expect(() => parseRedditFlairChoicesResponse({
      ...response,
      current: { ...response.current, flair_text: null },
    }, { community: "example", kind: "user" })).toThrow("incomplete");
    expect(() => parseRedditFlairChoicesResponse({
      ...response,
      choices: [{ ...response.choices[0], flair_text: "unsafe\ntext" }],
    }, { community: "example", kind: "user" })).toThrow("bounded text");
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
    expect(contract.state).toBe(contract.operation.endsWith(".select")
      ? "capture-required"
      : "observed");
  }
});
