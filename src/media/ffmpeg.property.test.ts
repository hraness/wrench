import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  buildPcmNormalizationArgv,
  parseNormalizedPcmWaveHeader,
} from "./ffmpeg";

test("property: arbitrary PCM headers and lengths never make the parser throw", () => {
  fc.assert(
    fc.property(
      fc.anything(),
      fc.anything(),
      (header, bytes) => {
        expect(() => parseNormalizedPcmWaveHeader(header, bytes)).not.toThrow();
      },
    ),
    { numRuns: 500 },
  );
});

test("property: arbitrary paths remain inert FFmpeg argument values", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 512 }),
      fc.string({ maxLength: 512 }),
      fc.string({ minLength: 1, maxLength: 128 }),
      (inputPath, outputPath, executable) => {
        const argv = buildPcmNormalizationArgv(inputPath, outputPath, executable);
        expect(argv[0]).toBe(executable);
        expect(argv[6]).toBe("-i");
        expect(argv[7]).toBe(inputPath);
        expect(argv.at(-1)).toBe(outputPath);
      },
    ),
    { numRuns: 500 },
  );
});
