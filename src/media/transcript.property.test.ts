import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  deduplicateRollingCaptionCues,
  longestTokenOverlap,
  parseWebVtt,
  renderTranscriptVtt,
  validateTranscriptCues,
  type TranscriptCue,
} from "./transcript";

function normalizedToken(token: string): string {
  const trimmed = token
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^(?:[\p{P}\p{S}]+)|(?:[\p{P}\p{S}]+)$/gu, "");
  return trimmed.length === 0 ? token.normalize("NFKC").toLowerCase() : trimmed;
}

function expectedLongestOverlap(left: readonly string[], right: readonly string[]): number {
  for (let size = Math.min(left.length, right.length); size > 0; size -= 1) {
    const leftSuffix = left.slice(-size).map(normalizedToken);
    const rightPrefix = right.slice(0, size).map(normalizedToken);
    if (leftSuffix.every((token, index) => token === rightPrefix[index])) return size;
  }
  return 0;
}

test("property: arbitrary foreign input and WebVTT strings never throw", () => {
  fc.assert(
    fc.property(fc.anything(), (input) => {
      expect(() => parseWebVtt(input)).not.toThrow();
    }),
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 10_000 }), (input) => {
      expect(() => parseWebVtt(input)).not.toThrow();
    }),
  );
});

test("property: every success is nonempty, canonical, and internally consistent", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 10_000 }), (input) => {
      const result = parseWebVtt(input);
      if (!result.ok) return;

      expect(result.cues.length).toBeGreaterThan(0);
      expect(result.cues.every(({ text }) => text.trim().length > 0)).toBeTrue();
      expect(result.text.trim().length).toBeGreaterThan(0);
      expect(result.text.endsWith("\n")).toBeTrue();
      expect(JSON.parse(result.json)).toEqual({ version: 1, cues: result.cues });
    }),
  );
});

test("property: overlap equals the longest normalized suffix-prefix match", () => {
  const token = fc.string({
    unit: fc.constantFrom(..."abcABC019,!?"),
    minLength: 1,
    maxLength: 12,
  });
  fc.assert(
    fc.property(
      fc.array(token, { maxLength: 30 }),
      fc.array(token, { maxLength: 30 }),
      (left, right) => {
        expect(longestTokenOverlap(left, right)).toBe(expectedLongestOverlap(left, right));
      },
    ),
  );
});

test("property: a constructed rolling suffix is removed exactly once", () => {
  const word = fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
    minLength: 1,
    maxLength: 10,
  });
  fc.assert(
    fc.property(
      fc.uniqueArray(word, { minLength: 1, maxLength: 20 }),
      fc.nat({ max: 30 }),
      fc.uniqueArray(word, { minLength: 1, maxLength: 10 }),
      (history, requestedOverlap, rawNovel) => {
        const overlap = requestedOverlap % (history.length + 1);
        const historySet = new Set(history);
        const novel = rawNovel
          .filter((candidate) => !historySet.has(candidate))
          .map((candidate, index) => `novel${String(index)}_${candidate}`);
        const repeatedSuffix = overlap === 0 ? [] : history.slice(-overlap);
        const rolling = [...repeatedSuffix, ...novel];
        const cues: readonly TranscriptCue[] = [
          { startMs: 0, endMs: 1_000, text: history.join(" ") },
          { startMs: 500, endMs: 1_500, text: rolling.join(" ") },
        ];
        const deduplicated = deduplicateRollingCaptionCues(cues);
        const emitted = deduplicated.flatMap(({ text }) => text.split(/\s+/u));
        expect(emitted).toEqual([...history, ...novel]);
      },
    ),
  );
});

test("property: non-overlapping repeated speech is never deduplicated", () => {
  const speech = fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?"),
    minLength: 1,
    maxLength: 80,
  }).filter((value) => value.trim().length > 0);
  fc.assert(
    fc.property(speech, fc.nat({ max: 60_000 }), (text, gapMs) => {
      const canonical = text.replace(/\s+/gu, " ").trim().normalize("NFC");
      const cues: readonly TranscriptCue[] = [
        { startMs: 0, endMs: 1_000, text },
        { startMs: 1_000 + gapMs, endMs: 2_000 + gapMs, text },
      ];
      expect(deduplicateRollingCaptionCues(cues)).toEqual([
        { startMs: 0, endMs: 1_000, text: canonical },
        { startMs: 1_000 + gapMs, endMs: 2_000 + gapMs, text: canonical },
      ]);
    }),
  );
});

test("property: strict local cues round-trip through canonical WebVTT", () => {
  const safeText = fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 <>&.,!?"),
    minLength: 1,
    maxLength: 80,
  }).filter((value) => value.trim().length > 0);
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({ min: 1, max: 10_000 }), safeText), {
        minLength: 1,
        maxLength: 50,
      }),
      (steps) => {
        let cursor = 0;
        const cues = steps.map(([duration, text]) => {
          const cue = { startMs: cursor, endMs: cursor + duration, text };
          cursor += duration;
          return cue;
        });
        const validated = validateTranscriptCues(cues);
        expect(validated.ok).toBeTrue();
        if (!validated.ok) return;
        const reparsed = parseWebVtt(renderTranscriptVtt(validated.cues));
        expect(reparsed).toMatchObject({ ok: true, cues: validated.cues });
      },
    ),
  );
});

test("property: arbitrary local cue input never throws", () => {
  fc.assert(
    fc.property(fc.anything(), (input) => {
      expect(() => validateTranscriptCues(input)).not.toThrow();
    }),
  );
});
