import { expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support";

import {
  platformSurfaceIds,
  semanticOperationNames,
  socialPlatformCatalog,
  splitWeightedThread,
  textWeightPolicies,
  weightedTextLength,
} from "./platform-catalog";

const unicodeAtom = fc.constantFrom(
  "a",
  "Z",
  "é",
  "e\u0301",
  "🙂",
  "👍🏽",
  "👨‍👩‍👧‍👦",
  "🇺🇸",
  " ",
  "\n",
  " https://x.co ",
  ".",
);

const wellFormedText = fc.array(unicodeAtom, { maxLength: 100 }).map((parts) => parts.join(""));

test("every generated catalog coordinate resolves to an explicit policy", () => {
  assertProperty(fc.property(
    fc.constantFrom(...platformSurfaceIds),
    fc.constantFrom(...semanticOperationNames),
    (surfaceId, operationName) => {
      const surface = socialPlatformCatalog[surfaceId];
      expect(surface.id).toBe(surfaceId);
      expect(surface.operations[operationName]).toBeDefined();
    },
  ));
});

test("collection reads preserve the native post and messaging policy lanes", () => {
  assertProperty(fc.property(fc.constantFrom(...platformSurfaceIds), (surfaceId) => {
    const operations = socialPlatformCatalog[surfaceId].operations;
    const lane = (policy: (typeof operations)[keyof typeof operations]): string =>
      policy.state === "adapter-eligible" ? policy.risk : policy.state;
    const nativeItemRead = surfaceId === "facebook-marketplace"
      ? operations["listings.read"]
      : operations["posts.read"];
    expect(lane(operations["feeds.read"])).toBe(lane(nativeItemRead));
    expect(lane(operations["messaging.list"])).toBe(lane(operations["messaging.read"]));
    if (operations["feeds.read"].state === "adapter-eligible") expect(operations["feeds.read"].risk).toBe("R1");
    if (operations["messaging.list"].state === "adapter-eligible") expect(operations["messaging.list"].risk).toBe("R1");
  }));
});

test("code-point and UTF-16 policies agree with their Unicode definitions", () => {
  assertProperty(fc.property(wellFormedText, (value) => {
    expect(weightedTextLength(value, textWeightPolicies["unicode-code-points"])).toBe(Array.from(value).length);
    expect(weightedTextLength(value, textWeightPolicies["utf16-code-units"])).toBe(value.length);
  }));
});

test("bounded weighted splitting is lossless, deterministic, and within every limit", () => {
  assertProperty(fc.property(
    wellFormedText,
    fc.integer({ min: 23, max: 80 }),
    (value, maxWeightedLength) => {
      const options = {
        maxWeightedLength,
        maxItems: 200,
        weightPolicy: textWeightPolicies["x-conservative-weighted"],
      } as const;
      const first = splitWeightedThread(value, options);
      const second = splitWeightedThread(value, options);
      expect(second).toEqual(first);
      expect(first.ok).toBeTrue();
      if (!first.ok) return;

      expect(first.chunks.map((chunk) => chunk.text).join("")).toBe(value);
      expect(first.chunks.length).toBeLessThanOrEqual(options.maxItems);
      for (const chunk of first.chunks) {
        expect(chunk.text.length).toBeGreaterThan(0);
        expect(chunk.weightedLength).toBe(weightedTextLength(chunk.text, options.weightPolicy));
        expect(chunk.weightedLength).toBeLessThanOrEqual(maxWeightedLength);
      }
    },
  ));
});

test("a larger thread item budget never changes a successful split", () => {
  assertProperty(fc.property(
    wellFormedText,
    fc.integer({ min: 23, max: 80 }),
    fc.integer({ min: 1, max: 50 }),
    (value, maxWeightedLength, maxItems) => {
      const constrained = splitWeightedThread(value, {
        maxWeightedLength,
        maxItems,
        weightPolicy: textWeightPolicies["x-conservative-weighted"],
      });
      if (!constrained.ok) return;
      const expanded = splitWeightedThread(value, {
        maxWeightedLength,
        maxItems: maxItems + 100,
        weightPolicy: textWeightPolicies["x-conservative-weighted"],
      });
      expect(expanded).toEqual(constrained);
    },
  ));
});
