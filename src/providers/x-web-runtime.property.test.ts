import { expect, test } from "bun:test";

import { assertProperty, fc } from "../test-support";
import { resolveCurrentXWebChunkUrl } from "./x-web-runtime";

const BOOKMARKS_FAMILY = "shared~bundle.BookmarkFolders~bundle.Bookmarks";
const REVIEWED_SOURCE_CHUNK = `${BOOKMARKS_FAMILY}.12fa7b2a.js`;
const HEX = "0123456789abcdef";

const hexOfWidth = (width: number) =>
  fc.array(fc.constantFrom(...HEX), { minLength: width, maxLength: width })
    .map((characters) => characters.join(""));

function webpackMapHtml(hash: string): string {
  return [
    `prefix;p.u=e=>({202:"${BOOKMARKS_FAMILY}"}`,
    `)[e]||e)+"."+({202:"${hash}"}`,
    `)[e]+"a.js";suffix`,
  ].join("");
}

test("current webpack hash maps resolve Bookmarks for reviewed 7-hex and 16-hex widths", () => {
  assertProperty(fc.property(
    fc.oneof(hexOfWidth(7), hexOfWidth(16)),
    (hash) => {
      expect(resolveCurrentXWebChunkUrl(webpackMapHtml(hash), REVIEWED_SOURCE_CHUNK).href).toBe(
        `https://abs.twimg.com/responsive-web/client-web/${BOOKMARKS_FAMILY}.${hash}a.js`,
      );
    },
  ));
});

test("current webpack hash maps fail closed for unreviewed hash widths", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 24 }).filter((width) => width !== 7 && width !== 16),
    hexOfWidth(24),
    (width, pad) => {
      expect(() => resolveCurrentXWebChunkUrl(
        webpackMapHtml(pad.slice(0, width)),
        REVIEWED_SOURCE_CHUNK,
      )).toThrow("omitted the reviewed logical chunk hash");
    },
  ));
});
