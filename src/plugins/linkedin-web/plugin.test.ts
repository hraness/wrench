import { describe, expect, test } from "bun:test";

import { canonicalJson } from "../../canonical-json";
import { linkedinWebPlugin } from "./plugin";

const binding = linkedinWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("LinkedIn web-session binding is unavailable");
}

describe("LinkedIn web provider plugin", () => {
  test("exposes exact one-dispatch post publishing with the reviewed browser source", () => {
    const operation = binding.operations.find((candidate) =>
      candidate.name === "posts.publish");
    expect(operation).toMatchObject({
      contractVersion: 2,
      risk: "R3",
      state: "observed",
      dispatch: "single",
    });
    expect(operation?.historicalContractVersions).toBeUndefined();
    expect(operation?.planDispatches({
      body: "how your email finds me",
      visibility: "public",
    })).toEqual([{
      id: "posts.publish",
      description: "Publish one externally visible LinkedIn post with the exact confirmed audience and content.",
    }]);
    expect(linkedinWebPlugin.implementationSources.map((source) => source.label))
      .toContain("providers/linkedin-web-post-browser.ts");
  });

  test("requires an image whenever alternative text is supplied", () => {
    const operation = binding.operations.find((candidate) =>
      candidate.name === "posts.publish");
    expect(operation?.validateInput({
      alt_text: "Exact image description",
      body: "how your email finds me",
      visibility: "public",
    })).toEqual(["input.alt_text requires exactly one input.media PNG"]);
    expect(operation?.validateInput({
      alt_text: "Exact image description",
      body: "how your email finds me",
      media: [{ kind: "file", reference: "fixture" }],
      visibility: "public",
    })).toEqual([]);
  });

  test("keeps current inline-image Article saving distinct from exact text-only recovery", () => {
    const articleOperations = binding.operations.filter((candidate) =>
      candidate.name === "articles.draft.save");
    expect(articleOperations.map((operation) => operation.contractVersion)).toEqual([2, 3]);
    const current = articleOperations.find((operation) => operation.contractVersion === 3);
    const archived = articleOperations.find((operation) => operation.contractVersion === 2);
    const document = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Before" },
        {
          type: "image",
          imageIndex: 0,
          altText: "Palm trees beside the Puerto Rican coast.",
          caption: "Puerto Rico",
        },
      ],
    });
    const input = {
      title: "Harnessing Puerto Rico",
      draft_id: "7000000000000000001",
      document,
      inline_images: [{ kind: "file" as const, reference: "fixture" }],
    };
    expect(current).toMatchObject({
      contractVersion: 3,
      risk: "R2",
      state: "observed",
      dispatch: "bounded-items",
    });
    expect(current?.validateInput(input)).toEqual([]);
    expect(current?.planDispatches(input)).toEqual([
      { id: "articles.image[1]", description: "Upload and process exact inline image 1" },
      {
        id: "articles.replace",
        description: "Bring the exact private LinkedIn Article title, document, and images to the confirmed state",
      },
    ]);
    expect(archived).toMatchObject({
      contractVersion: 2,
      risk: "R2",
      state: "observed",
      dispatch: "bounded-items",
    });
    expect(archived?.input.properties.inline_images).toBeUndefined();
    expect(linkedinWebPlugin.implementationSources.map((source) => source.label))
      .toContain("kernel/article-draft-images.ts");
  });
});
