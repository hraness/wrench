import { describe, expect, test } from "bun:test";

import type { FileInputValue } from "./model";
import { webSessionContractDefinitions } from "./web-session-contract-definitions";
import { planWebSessionContractDispatches } from "./web-session-contract-planning";

const file = (reference: string): FileInputValue => ({ kind: "file", reference });

describe("authenticated web contract planning", () => {
  test("plans every private rich X Article dispatch in its exact durable order", () => {
    const contract = webSessionContractDefinitions.x["articles.publish"];
    expect(contract).toMatchObject({ contractVersion: 3, dispatch: "article-rich-draft" });
    expect(planWebSessionContractDispatches(contract, {
      title: "Harnessing Puerto Rico",
      document: "{}",
      inline_images: [file("inline-1"), file("inline-2"), file("inline-3")],
      cover_image: file("cover"),
      draft_id: "700000000000000001",
      draft_only: true,
    }).map((dispatch) => dispatch.id)).toEqual([
      "articles.media.inline[1]",
      "articles.media.inline[2]",
      "articles.media.inline[3]",
      "articles.media.cover",
      "articles.title",
      "articles.content",
      "articles.cover",
    ]);
    expect(planWebSessionContractDispatches(contract, {
      title: "New draft",
      document: "{}",
      draft_only: true,
    }).map((dispatch) => dispatch.id)).toEqual(["articles.create"]);
  });
});
