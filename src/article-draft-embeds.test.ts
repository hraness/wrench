import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { canonicalJson } from "./canonical-json";
import { parseArticleDraftDocument } from "./article-draft-document";
import {
  projectXStatusArticleEmbed,
} from "./article-draft-embeds";

describe("X status Article embed projection", () => {
  test("projects X text as a blockquote followed by one canonical native link", () => {
    expect(projectXStatusArticleEmbed({
      text: "Building at the frontier",
      url: "https://x.com/hraness/status/1935927175074734098?s=46",
    }, "x-web")).toEqual([
      {
        type: "blockquote",
        text: "Building at the frontier",
        links: [],
        styles: [],
      },
      {
        type: "paragraph",
        text: "https://x.com/hraness/status/1935927175074734098",
        links: [{
          offset: 0,
          length: 48,
          url: "https://x.com/hraness/status/1935927175074734098",
        }],
        styles: [],
      },
    ]);
  });

  test("uses native LinkedIn blockquotes and preserves non-empty post lines", () => {
    expect(projectXStatusArticleEmbed({
      text: "First line\n\nSecond line",
      url: "https://twitter.com/hraness/status/1935927175074734098",
    }, "linkedin-web").map(({ type, text }) => ({ type, text }))).toEqual([
      { type: "blockquote", text: "First line" },
      { type: "blockquote", text: "Second line" },
      { type: "paragraph", text: "https://x.com/hraness/status/1935927175074734098" },
    ]);
  });

  test("rejects ambiguous input, non-status URLs, empty text, and unknown targets", () => {
    expect(() => projectXStatusArticleEmbed({
      text: "Quoted",
      url: "https://example.com/hraness/status/1",
    }, "x-web")).toThrow("bounded X status URL");
    expect(() => projectXStatusArticleEmbed({
      text: "Quoted",
      url: "https://x.com/hraness/status/1\n",
    }, "x-web")).toThrow("bounded X status URL");
    expect(() => projectXStatusArticleEmbed({
      text: " ",
      url: "https://x.com/hraness/status/1",
    }, "x-web")).toThrow("embed text");
    expect(() => projectXStatusArticleEmbed({
      extra: true,
      text: "Quoted",
      url: "https://x.com/hraness/status/1",
    }, "x-web")).toThrow("exactly text,url");
    expect(() => projectXStatusArticleEmbed({
      text: "Quoted",
      url: "https://x.com/hraness/status/1",
    }, "x")).toThrow("target must be x-web or linkedin-web");

    let accessed = false;
    const accessor = { url: "https://x.com/hraness/status/1" } as Record<string, unknown>;
    Object.defineProperty(accessor, "text", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "Quoted";
      },
    });
    expect(() => projectXStatusArticleEmbed(accessor, "x-web"))
      .toThrow("plain text,url values");
    expect(accessed).toBe(false);
  });

  test("always emits a canonical schema-v1 text-block sequence", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Za-z0-9_]{1,15}$/u),
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      fc.string({ minLength: 1, maxLength: 200 })
        .filter((value) => !value.includes("\0") && value.trim().length > 0),
      (handle, statusId, text) => {
        const blocks = projectXStatusArticleEmbed({
          text,
          url: `https://x.com/${handle}/status/${statusId}?s=20`,
        }, "x-web");
        expect(parseArticleDraftDocument(canonicalJson({
          blocks,
          schemaVersion: 1,
        }), {
          maximumBlocks: 250,
          maximumCharacters: 5_000,
        }).blocks).toEqual(blocks);
      },
    ));
  });
});
