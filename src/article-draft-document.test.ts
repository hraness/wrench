import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { canonicalJson } from "./canonical-json";
import {
  parseArticleDraftDocument,
  type ArticleDraftDocumentLimits,
} from "./article-draft-document";

const limits = Object.freeze({ maximumBlocks: 20, maximumCharacters: 2_000 }) satisfies ArticleDraftDocumentLimits;

function document(blocks: readonly unknown[]): string {
  return canonicalJson({ schemaVersion: 1, blocks });
}

describe("ArticleDraftDocument", () => {
  test("parses provider-neutral structure, native links, and styles", () => {
    expect(parseArticleDraftDocument(document([
      {
        type: "heading1",
        text: "A linked heading",
        links: [{ offset: 2, length: 6, url: "https://example.com/source" }],
        styles: [{ offset: 0, length: 1, style: "bold" }],
      },
      { type: "ordered-list-item", text: "One", links: [], styles: [] },
      { type: "blockquote", text: "Quoted", links: [], styles: [] },
    ]), limits)).toEqual({
      schemaVersion: 1,
      blocks: [
        {
          type: "heading1",
          text: "A linked heading",
          links: [{ offset: 2, length: 6, url: "https://example.com/source" }],
          styles: [{ offset: 0, length: 1, style: "bold" }],
        },
        { type: "ordered-list-item", text: "One", links: [], styles: [] },
        { type: "blockquote", text: "Quoted", links: [], styles: [] },
      ],
    });
  });

  test("requires canonical JSON and exact schema fields", () => {
    expect(() => parseArticleDraftDocument('{ "blocks": [], "schemaVersion": 1 }', limits))
      .toThrow("canonical JSON");
    expect(() => parseArticleDraftDocument(document([{ type: "image", imageIndex: 0 }]), limits))
      .toThrow("exactly text,type");
    expect(() => parseArticleDraftDocument(document([{ type: "paragraph", text: "x", extra: true }]), limits))
      .toThrow("exactly text,type");
  });

  test("rejects malformed URLs, overlapping links, and split surrogate pairs", () => {
    expect(() => parseArticleDraftDocument(document([{
      type: "paragraph",
      text: "abc",
      links: [{ offset: 0, length: 1, url: "http://example.com/" }],
    }]), limits)).toThrow("canonical absolute HTTPS URL");
    expect(() => parseArticleDraftDocument(document([{
      type: "paragraph",
      text: "abc",
      links: [
        { offset: 0, length: 2, url: "https://example.com/a" },
        { offset: 1, length: 2, url: "https://example.com/b" },
      ],
    }]), limits)).toThrow("ordered and non-overlapping");
    expect(() => parseArticleDraftDocument(document([{
      type: "paragraph",
      text: "A😀B",
      styles: [{ offset: 1, length: 1, style: "bold" }],
    }]), limits)).toThrow("UTF-16 boundaries");
  });

  test("requires deterministic style range ordering", () => {
    const cases = [
      [
        { offset: 2, length: 1, style: "bold" },
        { offset: 0, length: 1, style: "bold" },
      ],
      [
        { offset: 0, length: 2, style: "bold" },
        { offset: 0, length: 1, style: "italic" },
      ],
      [
        { offset: 0, length: 1, style: "strikethrough" },
        { offset: 0, length: 1, style: "italic" },
      ],
    ] as const;

    for (const styles of cases) {
      expect(() => parseArticleDraftDocument(document([{
        type: "paragraph",
        text: "abc",
        styles,
      }]), limits)).toThrow("styles must be ordered by offset, then length, then style");
    }
  });

  test("rejects duplicate, contained, and partially overlapping same-style ranges", () => {
    const cases = [
      [
        { offset: 0, length: 2, style: "bold" },
        { offset: 0, length: 2, style: "bold" },
      ],
      [
        { offset: 0, length: 2, style: "italic" },
        { offset: 0, length: 4, style: "italic" },
      ],
      [
        { offset: 0, length: 3, style: "strikethrough" },
        { offset: 2, length: 2, style: "strikethrough" },
      ],
      [
        { offset: 0, length: 3, style: "bold" },
        { offset: 1, length: 1, style: "italic" },
        { offset: 2, length: 2, style: "bold" },
      ],
    ] as const;

    for (const styles of cases) {
      expect(() => parseArticleDraftDocument(document([{
        type: "paragraph",
        text: "abcd",
        styles,
      }]), limits)).toThrow("duplicate or overlapping same-style ranges");
    }
  });

  test("allows canonical overlaps between distinct styles", () => {
    expect(parseArticleDraftDocument(document([{
      type: "paragraph",
      text: "abcdef",
      styles: [
        { offset: 0, length: 4, style: "bold" },
        { offset: 0, length: 4, style: "italic" },
        { offset: 2, length: 4, style: "strikethrough" },
      ],
    }]), limits).blocks[0]?.styles).toEqual([
      { offset: 0, length: 4, style: "bold" },
      { offset: 0, length: 4, style: "italic" },
      { offset: 2, length: 4, style: "strikethrough" },
    ]);
  });

  test("applies style ordering and overlap checks at valid UTF-16 boundaries", () => {
    expect(parseArticleDraftDocument(document([{
      type: "paragraph",
      text: "A\ud83d\ude00e\u0301B",
      styles: [
        { offset: 1, length: 2, style: "bold" },
        { offset: 1, length: 4, style: "italic" },
        { offset: 3, length: 2, style: "bold" },
      ],
    }]), limits).blocks[0]?.styles).toEqual([
      { offset: 1, length: 2, style: "bold" },
      { offset: 1, length: 4, style: "italic" },
      { offset: 3, length: 2, style: "bold" },
    ]);

    for (const style of [
      { offset: 2, length: 1, style: "bold" },
      { offset: 0, length: 2, style: "italic" },
    ] as const) {
      expect(() => parseArticleDraftDocument(document([{
        type: "paragraph",
        text: "A\ud83d\ude00B",
        styles: [style],
      }]), limits)).toThrow("UTF-16 boundaries");
    }
  });

  test("enforces caller-selected bounded limits", () => {
    expect(() => parseArticleDraftDocument(document([
      { type: "paragraph", text: "one" },
      { type: "paragraph", text: "two" },
    ]), { maximumBlocks: 1, maximumCharacters: 20 })).toThrow("1-1 blocks");
    expect(() => parseArticleDraftDocument(document([{ type: "paragraph", text: "toolong" }]), {
      maximumBlocks: 1,
      maximumCharacters: 3,
    })).toThrow("at most 3 UTF-16 code units");
  });

  test("round trips canonical single-block documents", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 100 }).filter((value) => !/[\0\r\n]/u.test(value)),
      (text) => {
        const encoded = document([{ type: "paragraph", text }]);
        expect(parseArticleDraftDocument(encoded, limits).blocks[0]?.text).toBe(text);
      },
    ));
  });
});
