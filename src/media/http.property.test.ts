import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  detectDirectHttpMedia,
  normalizeDeclaredMediaType,
  parseContentLength,
  parseContentRange,
  parsePublicHttpUrl,
  validatorFromEtag,
} from "./http";

test("property: arbitrary HTTP boundary values never throw pure parsers", () => {
  fc.assert(
    fc.property(fc.string(), fc.uint8Array({ maxLength: 1_024 }), (value, body) => {
      expect(() => parseContentLength(value)).not.toThrow();
      expect(() => parseContentRange(value)).not.toThrow();
      expect(() => normalizeDeclaredMediaType(value)).not.toThrow();
      expect(() => validatorFromEtag(value)).not.toThrow();
      expect(() => detectDirectHttpMedia(body)).not.toThrow();
    }),
    { numRuns: 500 },
  );
});

test("property: accepted content ranges always describe a nonempty exact interval", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const parsed = parseContentRange(value);
      if (parsed === null) return;
      expect(parsed.start).toBeGreaterThanOrEqual(0);
      expect(parsed.end).toBeGreaterThanOrEqual(parsed.start);
      if (parsed.total !== null) expect(parsed.total).toBeGreaterThan(parsed.end);
    }),
    { numRuns: 500 },
  );
});

test("property: fragment changes cannot change the normalized direct request", () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z0-9]{1,32}$/u), fc.string(), fc.string(), (path, left, right) => {
      const base = `https://example.com/${path}`;
      const leftUrl = parsePublicHttpUrl(`${base}#${encodeURIComponent(left)}`);
      const rightUrl = parsePublicHttpUrl(`${base}#${encodeURIComponent(right)}`);
      expect(leftUrl.href).toBe(rightUrl.href);
    }),
    { numRuns: 300 },
  );
});
