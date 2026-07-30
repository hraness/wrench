import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  buildWhisperCppArgv,
  normalizeWhisperCppLanguage,
  parseWhisperCppOutputs,
  whisperCppLanguageArgument,
} from "./whisper-cpp";

test("property: arbitrary language values are either rejected or emitted as one literal argv value", () => {
  fc.assert(
    fc.property(fc.anything(), (language) => {
      const normalized = normalizeWhisperCppLanguage(language);
      if (normalized === null) return;
      const argv = buildWhisperCppArgv({
        executable: "whisper-cli",
        modelPath: "/model.bin",
        pcmPath: "/input.wav",
        requestedLanguage: normalized,
        outputPrefix: "/attempt/transcript",
      });
      const index = argv.indexOf("--language");
      const expected = whisperCppLanguageArgument(normalized);
      if (expected === null) throw new Error("A normalized language must have a CLI argument.");
      expect(argv[index + 1]).toBe(expected);
      expect(argv).toHaveLength(17);
    }),
  );
});

test("property: arbitrary tool outputs never throw or leak a successful empty transcript", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 100_000 }),
      fc.string({ maxLength: 100_000 }),
      fc.oneof(fc.constant("auto"), fc.constant("en"), fc.constant("fr-CA")),
      (vtt, json, language) => {
        expect(() => parseWhisperCppOutputs(vtt, json, language)).not.toThrow();
        const result = parseWhisperCppOutputs(vtt, json, language);
        if (result.ok && result.status === "transcribed") {
          expect(result.transcript.cues.length).toBeGreaterThan(0);
          expect(result.transcript.text.trim().length).toBeGreaterThan(0);
          expect(result.transcript.json.endsWith("\n")).toBeTrue();
        }
      },
    ),
  );
});
