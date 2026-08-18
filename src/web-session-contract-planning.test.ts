import { describe, expect, test } from "bun:test";

import { canonicalJson } from "./canonical-json";
import { xWebPlugin } from "./plugins/x-web/plugin";
import { linkedinWebPlugin } from "./plugins/linkedin-web/plugin";
import { webSessionContractDefinitions } from "./web-session-contract-definitions";
import { planWebSessionContractDispatches } from "./web-session-contract-planning";

describe("authenticated web contract planning", () => {
  test("requires Article adapters to own their bounded dispatch schedules", () => {
    const contract = webSessionContractDefinitions.x["articles.draft.save"];
    expect(contract).toMatchObject({ contractVersion: 2, dispatch: "bounded-items", risk: "R2" });
    expect(() => planWebSessionContractDispatches(contract, {
      title: "Harnessing Puerto Rico",
      document: "{}",
    })).toThrow("provider-owned bounded dispatch planner");
  });

  test("the X plugin plans bounded image uploads and preserves exact text-only recovery", () => {
    const operation = xWebPlugin.bindings[0]?.operations.find((candidate) =>
      candidate.name === "articles.draft.save" && candidate.contractVersion === 2);
    expect(operation).toBeDefined();
    expect(operation!.planDispatches({
      title: "Harnessing Puerto Rico",
      document: "{}",
      draft_id: "700000000000000001",
      inline_images: [{ kind: "file" as const, reference: "one" }],
    }).map((dispatch) => dispatch.id)).toEqual([
      "articles.media.inline[1]",
      "articles.title",
      "articles.content",
    ]);
    expect(operation!.planDispatches({
      title: "New draft",
      document: "{}",
      inline_images: [
        { kind: "file" as const, reference: "one" },
        { kind: "file" as const, reference: "two" },
      ],
    }).map((dispatch) => dispatch.id)).toEqual([
      "articles.media.inline[1]",
      "articles.media.inline[2]",
      "articles.create",
    ]);

    const document = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Read the source" },
        { type: "image", imageIndex: 0, caption: "Puerto Rico" },
      ],
    });
    const inline_images = [{ kind: "file" as const, reference: "one" }];
    expect(operation!.validateInput({ title: "New draft", document, inline_images })).toEqual([]);
    expect(operation!.validateInput({ title: "Bad\ntitle", document, inline_images })).toContain(
      "input.title must be one bounded plain-text line",
    );
    expect(operation!.validateInput({
      title: "Existing draft",
      document,
      draft_id: "not-an-id",
      inline_images,
    })).toContain("input.draft_id must be one exact 1-19 digit private X Article ID");

    const linkHeavyDocument = canonicalJson({
      schemaVersion: 2,
      blocks: [
        ...[500, 500, 500, 500, 1].map((count, blockIndex) => ({
          type: "paragraph",
          text: "x".repeat(count),
          links: Array.from({ length: count }, (_value, index) => ({
            offset: index,
            length: 1,
            url: `https://example.com/${blockIndex}/${index}`,
          })),
        })),
        { type: "image", imageIndex: 0 },
      ],
    });
    expect(operation!.validateInput({
      title: "Too many links",
      document: linkHeavyDocument,
      inline_images,
    })).toContain("input.document must contain at most 2000 native link ranges for X");

    const overlongUrlDocument = canonicalJson({
      schemaVersion: 2,
      blocks: [
        {
          type: "paragraph",
          text: "source",
          links: [{
            offset: 0,
            length: 6,
            url: `https://example.com/${"x".repeat(2_030)}`,
          }],
        },
        { type: "image", imageIndex: 0 },
      ],
    });
    expect(operation!.validateInput({
      title: "Overlong link",
      document: overlongUrlDocument,
      inline_images,
    })).toContain(
      "input.document native link URLs must contain at most 2048 UTF-16 code units for X",
    );
    expect(operation!.reconciliation).toBeUndefined();
    expect(operation!.validateInput({
      title: "Alt remains unobserved",
      document: canonicalJson({
        schemaVersion: 2,
        blocks: [
          { type: "paragraph", text: "Body" },
          { type: "image", imageIndex: 0, altText: "Not captured" },
        ],
      }),
      inline_images,
    })).toContain("X Article inline-image alternative text remains capture-required");

    const historical = xWebPlugin.bindings[0]?.operations.find((candidate) =>
      candidate.name === "articles.draft.save" && candidate.contractVersion === 1);
    expect(historical).toBeDefined();
    const historicalDocument = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Text-only recovery" }],
    });
    expect(historical!.reconciliation?.desiredState({
      title: "Existing draft",
      document: historicalDocument,
      draft_id: "700000000000000001",
    })).toBeTrue();
  });

  test("the X plugin keeps retired Article publication contracts out of the runtime route", () => {
    const operation = xWebPlugin.bindings[0]?.operations.find((candidate) =>
      candidate.name === "articles.publish");
    expect(operation).toMatchObject({
      contractVersion: 4,
      contractVersions: [4],
      risk: "R3",
      state: "capture-required",
    });
    expect(operation?.historicalContractVersions).toBeUndefined();
  });

  test("the LinkedIn plugin plans bounded images while retaining text-only recovery", () => {
    const contract = webSessionContractDefinitions.linkedin["articles.draft.save"];
    expect(contract).toMatchObject({
      contractVersion: 3,
      dispatch: "bounded-items",
      risk: "R2",
      state: "observed",
    });
    const operation = linkedinWebPlugin.bindings[0]?.operations.find((candidate) =>
      candidate.name === "articles.draft.save" && candidate.contractVersion === 3);
    expect(operation).toBeDefined();
    expect(operation!.planDispatches({
      title: "New private draft",
      document: "{}",
      inline_images: [{ kind: "file" as const, reference: "one" }],
    }).map((dispatch) => dispatch.id)).toEqual([
      "articles.create",
      "articles.image[1]",
      "articles.content",
    ]);
    expect(operation!.planDispatches({
      title: "Existing private draft",
      document: "{}",
      draft_id: "7000000000000000001",
      inline_images: [
        { kind: "file" as const, reference: "one" },
        { kind: "file" as const, reference: "two" },
      ],
    }).map((dispatch) => dispatch.id)).toEqual([
      "articles.image[1]",
      "articles.image[2]",
      "articles.replace",
    ]);
    const supported = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "paragraph", text: "Native link" },
        { type: "image", imageIndex: 0, altText: "A descriptive fixture" },
      ],
    });
    const inline_images = [{ kind: "file" as const, reference: "one" }];
    expect(operation!.validateInput({
      title: "Private",
      document: supported,
      inline_images,
    })).toEqual([]);
    const unsupported = canonicalJson({
      schemaVersion: 2,
      blocks: [
        { type: "blockquote", text: "Not captured" },
        { type: "image", imageIndex: 0, altText: "A descriptive fixture" },
      ],
    });
    expect(operation!.validateInput({
      title: "Private",
      document: unsupported,
      inline_images,
    })).toContain(
      "LinkedIn Article drafts currently support only paragraph, heading1, and heading2 blocks",
    );
    expect(operation!.reconciliation).toBeUndefined();
    expect(operation!.validateInput({
      title: "Missing alt",
      document: canonicalJson({
        schemaVersion: 2,
        blocks: [
          { type: "paragraph", text: "Body" },
          { type: "image", imageIndex: 0 },
        ],
      }),
      inline_images,
    })).toContain("LinkedIn Article inline images require descriptive altText");

    const historical = linkedinWebPlugin.bindings[0]?.operations.find((candidate) =>
      candidate.name === "articles.draft.save" && candidate.contractVersion === 2);
    expect(historical).toBeDefined();
    const historicalDocument = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Text-only recovery" }],
    });
    expect(historical!.reconciliation?.desiredState({
      title: "Existing private draft",
      document: historicalDocument,
      draft_id: "7000000000000000001",
    })).toBeTrue();
  });
});
