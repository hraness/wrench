import { expect, test } from "bun:test";
import fc from "fast-check";
import { normalizeAuthContextName, parseArgs } from "./args";

test("property: arbitrary argv never makes parsing throw", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 30 }), (argv) => {
      expect(() => parseArgs(argv)).not.toThrow();
    }),
    { numRuns: 300 },
  );
});

test("property: authorization contexts are canonical or rejected without throwing", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      expect(() => normalizeAuthContextName(value)).not.toThrow();
      const normalized = normalizeAuthContextName(value);
      if (normalized === null) return;
      expect(normalized).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
      expect(normalizeAuthContextName(normalized)).toBe(normalized);
    }),
    { numRuns: 300 },
  );
});

test("property: option-shaped URLs remain positional after the separator and are rejected safely", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (value) => {
      const result = parseArgs(["archive", "--", `-${value}`]);
      expect(result.ok).toBeFalse();
    }),
    { numRuns: 200 },
  );
});
