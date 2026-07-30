import { test } from "bun:test";
import { assertProperty, fc } from "../test-support";

import { extractMetaJsonScriptTexts } from "./meta-relay-bundle";

const safeText = fc.array(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_"),
  { maxLength: 80 },
).map((characters) => characters.join(""));

test("property: exact JSON script attributes round-trip without lookalike promotion", () => {
  const attributeOrder = fc.constantFrom(
    ["type", "nonce", "data-purpose"],
    ["nonce", "type", "data-purpose"],
    ["data-purpose", "nonce", "type"],
    ["data-purpose", "type", "nonce"],
  );
  const whitespace = fc.constantFrom(" ", "\t", "\n");
  assertProperty(fc.property(
    safeText,
    fc.integer(),
    attributeOrder,
    whitespace,
    (text, count, order, separator) => {
      const values: Readonly<Record<string, string>> = {
        type: 'type="application/json"',
        nonce: 'nonce="fixture"',
        "data-purpose": 'data-purpose="bootloader"',
      };
      const body = JSON.stringify({ count, text });
      const attributes = order.map((name) => values[name]).join(separator);
      const html = [
        `<script data-type="application/json">${body}</script>`,
        `<script ${attributes}>${body}</script>`,
      ].join("");
      const extracted = extractMetaJsonScriptTexts(html);
      if (extracted.length !== 1 || extracted[0] !== body) return false;
      return JSON.stringify(JSON.parse(extracted[0]) as unknown) === body;
    },
  ));
});
