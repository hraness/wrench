import { describe, expect, test } from "bun:test";

import { canonicalJson } from "../../canonical-json";
import { linkedinWebPlugin } from "./plugin";

const binding = linkedinWebPlugin.bindings[0];
if (binding?.transport !== "web-session-api") {
  throw new Error("LinkedIn web-session binding is unavailable");
}

describe("LinkedIn web provider plugin", () => {
  test("versions the profile-stat source closure independently", () => {
    expect(linkedinWebPlugin.version).toBe("1.5.0");
  });

  test("advertises observed exact personal and organization profile reads", () => {
    const profile = binding.operations.find((operation) =>
      operation.name === "profiles.read");
    const organization = binding.operations.find((operation) =>
      operation.name === "organizations.read");
    expect(profile).toMatchObject({
      contractVersion: 1,
      risk: "R1",
      state: "observed",
      dispatch: "none",
      input: {
        properties: {
          profile_url: { type: "string", minLength: 25, maxLength: 2048 },
          include_connections: { type: "boolean" },
        },
        required: ["profile_url"],
      },
    });
    expect(organization).toMatchObject({
      contractVersion: 1,
      risk: "R1",
      state: "observed",
      dispatch: "none",
      input: {
        properties: {
          organization_url: { type: "string", minLength: 30, maxLength: 2048 },
        },
        required: ["organization_url"],
      },
    });
  });

  test("exposes exact one-dispatch post publishing with the reviewed browser source", () => {
    const operation = binding.operations.find((candidate) =>
      candidate.name === "posts.publish");
    expect(operation).toMatchObject({
      contractVersion: 3,
      risk: "R3",
      state: "observed",
      dispatch: "single",
      reconciliation: {
        kind: "provider-accepted-target-presence",
      },
    });
    expect(operation?.historicalContractVersions).toEqual([2]);
    expect(operation?.planDispatches({
      body: "how your email finds me",
      visibility: "public",
    })).toEqual([{
      id: "posts.publish",
      description: "Publish one externally visible LinkedIn post with the exact confirmed audience and content.",
    }]);
    expect(linkedinWebPlugin.implementationSources.map((source) => source.label))
      .toContain("providers/linkedin-web-post-browser.ts");
    expect(linkedinWebPlugin.implementationSources.map((source) => source.label))
      .toContain("providers/linkedin-web-profile-browser.ts");
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

  test("keeps current covered Article saving distinct from exact text-only recovery", () => {
    const articleOperations = binding.operations.filter((candidate) =>
      candidate.name === "articles.draft.save");
    expect(articleOperations.map((operation) => operation.contractVersion)).toEqual([2, 7]);
    const current = articleOperations.find((operation) => operation.contractVersion === 7);
    const archived = articleOperations.find((operation) => operation.contractVersion === 2);
    const document = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Before" },
        { type: "blockquote", text: "A quoted X post" },
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
      cover_image: { kind: "file" as const, reference: "cover" },
      inline_images: [{ kind: "file" as const, reference: "fixture" }],
    };
    expect(current).toMatchObject({
      contractVersion: 7,
      risk: "R2",
      state: "observed",
      dispatch: "bounded-items",
    });
    expect(current?.validateInput(input)).toEqual([]);
    const { cover_image: _coverImage, ...missingCover } = input;
    expect(current?.validateInput(missingCover)).toEqual([]);
    const { draft_id: _draftId, ...missingCreateCover } = missingCover;
    expect(current?.validateInput(missingCreateCover)).toContain(
      "input.cover_image is required when creating a LinkedIn Article draft",
    );
    expect(current?.planDispatches(input)).toEqual([
      {
        id: "articles.cover",
        description: "Upload and bind the exact Article cover image only to LinkedIn's banner slot",
      },
      { id: "articles.image[1]", description: "Upload and process exact inline image 1" },
      {
        id: "articles.replace",
        description: "Bring the exact private LinkedIn Article title, cover, document, and inline images to the confirmed state",
      },
    ]);
    expect(current?.planDispatches(missingCover)).toEqual([
      { id: "articles.image[1]", description: "Upload and process exact inline image 1" },
      {
        id: "articles.replace",
        description: "Bring the exact private LinkedIn Article title, document, and inline images to the confirmed state while preserving its existing banner",
      },
    ]);
    expect(archived).toMatchObject({
      contractVersion: 2,
      risk: "R2",
      state: "observed",
      dispatch: "bounded-items",
    });
    expect(archived?.input.properties.inline_images).toBeUndefined();
    expect(archived?.validateInput({
      title: "Historical text-only draft",
      draft_id: "7000000000000000001",
      document: canonicalJson({
        schemaVersion: 1,
        blocks: [{ type: "blockquote", text: "Not in the historical contract" }],
      }),
    })).toContain(
      "LinkedIn Article drafts currently support only paragraph, heading1, and heading2 blocks",
    );
    expect(linkedinWebPlugin.implementationSources.map((source) => source.label))
      .toContain("kernel/article-draft-images.ts");
  });
});
