import { expect, test } from "bun:test";
import fc from "fast-check";

import { compareUtf8 } from "./utf8-order";

function sign(value: number): -1 | 0 | 1 {
  return value === 0 ? 0 : value < 0 ? -1 : 1;
}

test("property: UTF-8 ordering is total, antisymmetric, and transitive", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), fc.string(), (left, middle, right) => {
      expect(sign(compareUtf8(left, middle))).toBe(sign(-compareUtf8(middle, left)));
      expect(compareUtf8(left, middle) === 0).toBe(left === middle);
      if (compareUtf8(left, middle) <= 0 && compareUtf8(middle, right) <= 0) {
        expect(compareUtf8(left, right)).toBeLessThanOrEqual(0);
      }
    }),
    { numRuns: 1_000 },
  );
});

test("canonically distinct spellings and lone surrogates never collapse", () => {
  expect(compareUtf8("é", "e\u0301")).not.toBe(0);
  expect(compareUtf8("\ud800", "\ud801")).not.toBe(0);
  expect(["é", "e\u0301"].toSorted(compareUtf8)).toEqual(["e\u0301", "é"]);
});
