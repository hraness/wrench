import { describe, expect, test } from "bun:test";

import { canonicalJson } from "./canonical-json";
import { xWebPlugin } from "./plugins/x-web/plugin";
import { linkedinWebPlugin } from "./plugins/linkedin-web/plugin";
import { webSessionContractDefinitions } from "./web-session-contract-definitions";
import { planWebSessionContractDispatches } from "./web-session-contract-planning";

describe("authenticated web contract planning", () => {
  test("requires Article adapters to own their bounded dispatch schedules", () => {
    const contract = webSessionContractDefinitions.x["articles.draft.save"];
    expect(contract).toMatchObject({ contractVersion: 1, dispatch: "bounded-items", risk: "R2" });
    expect(() => planWebSessionContractDispatches(contract, {
      title: "Harnessing Puerto Rico",
      document: "{}",
    })).toThrow("provider-owned bounded dispatch planner");
  });

  test("the X plugin plans create and exact replacement without media dispatches", () => {
    const operation = xWebPlugin.bindings[0]?.operations.find((candidate) =>
      candidate.name === "articles.draft.save");
    expect(operation).toBeDefined();
    expect(operation!.planDispatches({
      title: "Harnessing Puerto Rico",
      document: "{}",
      draft_id: "700000000000000001",
    }).map((dispatch) => dispatch.id)).toEqual([
      "articles.title",
      "articles.content",
    ]);
    expect(operation!.planDispatches({
      title: "New draft",
      document: "{}",
    }).map((dispatch) => dispatch.id)).toEqual(["articles.create"]);

    const document = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Read the source" }],
    });
    expect(operation!.validateInput({ title: "New draft", document })).toEqual([]);
    expect(operation!.validateInput({ title: "Bad\ntitle", document })).toContain(
      "input.title must be one bounded plain-text line",
    );
    expect(operation!.validateInput({
      title: "Existing draft",
      document,
      draft_id: "not-an-id",
    })).toContain("input.draft_id must be one exact 1-19 digit private X Article ID");

    const linkHeavyDocument = canonicalJson({
      schemaVersion: 1,
      blocks: [500, 500, 500, 500, 1].map((count, blockIndex) => ({
        type: "paragraph",
        text: "x".repeat(count),
        links: Array.from({ length: count }, (_value, index) => ({
          offset: index,
          length: 1,
          url: `https://example.com/${blockIndex}/${index}`,
        })),
      })),
    });
    expect(operation!.validateInput({
      title: "Too many links",
      document: linkHeavyDocument,
    })).toContain("input.document must contain at most 2000 native link ranges for X");

    const overlongUrlDocument = canonicalJson({
      schemaVersion: 1,
      blocks: [{
        type: "paragraph",
        text: "source",
        links: [{
          offset: 0,
          length: 6,
          url: `https://example.com/${"x".repeat(2_030)}`,
        }],
      }],
    });
    expect(operation!.validateInput({
      title: "Overlong link",
      document: overlongUrlDocument,
    })).toContain(
      "input.document native link URLs must contain at most 2048 UTF-16 code units for X",
    );
    expect(() => operation!.reconciliation?.desiredState({
      title: "New draft",
      document,
    })).toThrow(
      "create has no safe reconciliation because input.draft_id is absent",
    );
    expect(operation!.reconciliation?.desiredState({
      title: "Existing draft",
      document,
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

  test("the LinkedIn plugin plans only reviewed private title/content autosaves", () => {
    const contract = webSessionContractDefinitions.linkedin["articles.draft.save"];
    expect(contract).toMatchObject({
      contractVersion: 1,
      dispatch: "bounded-items",
      risk: "R2",
      state: "observed",
    });
    const operation = linkedinWebPlugin.bindings[0]?.operations.find((candidate) =>
      candidate.name === "articles.draft.save");
    expect(operation).toBeDefined();
    expect(operation!.planDispatches({
      title: "New private draft",
      document: "{}",
    }).map((dispatch) => dispatch.id)).toEqual([
      "articles.create",
      "articles.content",
    ]);
    expect(operation!.planDispatches({
      title: "Existing private draft",
      document: "{}",
      draft_id: "7000000000000000001",
    }).map((dispatch) => dispatch.id)).toEqual([
      "articles.title",
      "articles.content",
    ]);
    const supported = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "paragraph", text: "Native link" }],
    });
    expect(operation!.validateInput({ title: "Private", document: supported })).toEqual([]);
    const unsupported = canonicalJson({
      schemaVersion: 1,
      blocks: [{ type: "blockquote", text: "Not captured" }],
    });
    expect(operation!.validateInput({ title: "Private", document: unsupported })).toContain(
      "LinkedIn Article drafts currently support only paragraph, heading1, and heading2 blocks",
    );
    expect(() => operation!.reconciliation?.desiredState({
      title: "New private draft",
      document: supported,
    })).toThrow("create has no safe reconciliation because input.draft_id is absent");
    expect(operation!.reconciliation?.desiredState({
      title: "Existing private draft",
      document: supported,
      draft_id: "7000000000000000001",
    })).toBeTrue();
  });
});
