import { describe, expect, test } from "bun:test";

import { metaWebPlugin } from "./plugin";

function binding(surfaceId: string) {
  const result = metaWebPlugin.bindings.find((candidate) =>
    candidate.surfaceId === surfaceId);
  if (result === undefined) throw new Error(`missing Meta binding ${surfaceId}`);
  return result;
}

describe("Meta web plugin account subjects", () => {
  test("accepts only canonical positive decimal account IDs", () => {
    const cases = [
      ["instagram", "instagram:"],
      ["threads", "threads:"],
      ["facebook", "facebook:user:"],
      ["facebook-page", "facebook:user:"],
      ["facebook-group", "facebook:user:"],
      ["facebook-marketplace", "facebook:user:"],
    ] as const;

    for (const [surfaceId, prefix] of cases) {
      const subject = binding(surfaceId).subject;
      expect(subject.matches(`${prefix}1`)).toBeTrue();
      expect(subject.matches(`${prefix}${"9".repeat(32)}`)).toBeTrue();
      for (const id of ["", "0", "00", "01", "001", "1.0", "-1", "9".repeat(33)]) {
        expect(subject.matches(`${prefix}${id}`)).toBeFalse();
      }
    }
  });
});
