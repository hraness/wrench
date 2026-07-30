import { describe, expect, test } from "bun:test";

import {
  deduplicateRollingCaptionCues,
  longestTokenOverlap,
  parseStrictLocalWebVtt,
  parseWebVtt,
  renderTranscriptJson,
  renderTranscriptText,
  renderTranscriptVtt,
  stripWebVttMarkup,
  validateTranscriptCues,
  type TranscriptCue,
} from "./transcript";

describe("parseWebVtt", () => {
  test("parses, cleans, and deduplicates YouTube-style rolling captions", () => {
    const result = parseWebVtt(`\uFEFFWEBVTT - generated captions\r
Kind: captions\r
Language: en\r
\r
NOTE provider metadata\r
not a cue\r
\r
first\r
00:00:00.000 --> 00:00:02.500 align:start position:0%\r
<v Alice><c.green>Hello &amp; welcome</c></v>\r
\r
00:00:01.250 --> 00:00:04.000 align:start position:0%\r
hello &amp; welcome to <i>Wrench media.</i>\r
\r
00:00:03.500 --> 00:00:06.000\r
to Wrench media. Save &#x1F30D; locally.\r
`);

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.cues).toEqual([
      { startMs: 0, endMs: 2_500, text: "Hello & welcome" },
      { startMs: 1_250, endMs: 4_000, text: "to Wrench media." },
      { startMs: 3_500, endMs: 6_000, text: "Save 🌍 locally." },
    ]);
    expect(result.text).toBe("Hello & welcome\nto Wrench media.\nSave 🌍 locally.\n");
    expect(JSON.parse(result.json)).toEqual({ version: 1, cues: result.cues });
    expect(result.json.endsWith("\n")).toBeTrue();
  });

  test("skips malformed blocks without weakening valid cue boundaries", () => {
    const result = parseWebVtt(`WEBVTT

00:00:05.000 --> 00:00:04.000
backwards

not a cue

cue-id
00:01.000 --> 00:02.250 line:90%
valid cue
`);

    expect(result).toEqual({
      ok: true,
      cues: [{ startMs: 1_000, endMs: 2_250, text: "valid cue" }],
      text: "valid cue\n",
      json: renderTranscriptJson([{ startMs: 1_000, endMs: 2_250, text: "valid cue" }]),
    });
  });

  test("preserves repeated speech in non-overlapping cues", () => {
    const result = parseWebVtt(`WEBVTT

00:00.000 --> 00:01.000
No.

00:02.000 --> 00:03.000
No.
`);

    expect(result).toMatchObject({
      ok: true,
      cues: [
        { startMs: 0, endMs: 1_000, text: "No." },
        { startMs: 2_000, endMs: 3_000, text: "No." },
      ],
      text: "No.\nNo.\n",
    });
  });

  test("rejects foreign input, invalid envelopes, and empty transcripts", () => {
    expect(parseWebVtt({ WEBVTT: true })).toEqual({
      ok: false,
      error: { code: "invalid-input", message: "WebVTT input must be a string." },
    });
    expect(parseWebVtt("not WebVTT")).toMatchObject({
      ok: false,
      error: { code: "invalid-webvtt-header" },
    });
    expect(parseWebVtt("WEBVTT\n\n00:00.000 --> 00:01.000\n<b></b>\n")).toMatchObject({
      ok: false,
      error: { code: "no-valid-cues" },
    });
  });
});

describe("parseStrictLocalWebVtt", () => {
  test("accepts the exact whisper.cpp cue envelope, including empty no-speech output", () => {
    expect(parseStrictLocalWebVtt("WEBVTT\n\n")).toEqual({ ok: true, cues: [] });
    expect(parseStrictLocalWebVtt(`WEBVTT

00:00:00.000 --> 00:00:01.250
 Hello <i>world</i>

00:00:01.250 --> 00:00:02.000
Again
`)).toEqual({
      ok: true,
      cues: [
        { startMs: 0, endMs: 1_250, text: "Hello world" },
        { startMs: 1_250, endMs: 2_000, text: "Again" },
      ],
    });
  });

  test("rejects any malformed local block instead of recovering around it", () => {
    expect(parseStrictLocalWebVtt("WEBVTT")).toMatchObject({
      ok: false,
      error: { code: "invalid-header" },
    });
    expect(parseStrictLocalWebVtt(`WEBVTT

00:00:00.000 --> 00:00:01.000
first

not a cue

00:00:02.000 --> 00:00:03.000
third
`)).toMatchObject({ ok: false, error: { code: "invalid-cue-block" } });
    expect(parseStrictLocalWebVtt(`WEBVTT - provider

00:00:00.000 --> 00:00:01.000
text
`)).toMatchObject({ ok: false, error: { code: "invalid-header" } });
    expect(parseStrictLocalWebVtt(`WEBVTT

00:00:00.000 --> 00:00:01.000 align:start
text
`)).toMatchObject({ ok: false, error: { code: "invalid-cue-block" } });
  });
});

describe("cue cleanup", () => {
  test("strips WebVTT markup while conservatively decoding entities", () => {
    expect(
      stripWebVttMarkup(
        "<v Roger><c.yellow><b>A&nbsp;B</b></c></v> <00:00:01.000>&lt;ok&gt; &bogus; <widget>x</widget>",
      ),
    ).toBe("A B <ok> &bogus; <widget>x</widget>");
  });

  test("replaces lone UTF-16 surrogates and controls in canonical output", () => {
    expect(stripWebVttMarkup("hello\uD800\u0000world")).toBe("hello� world");
  });
});

describe("rolling-caption overlap", () => {
  test("finds the longest normalized suffix-prefix overlap", () => {
    expect(
      longestTokenOverlap(
        ["This", "is", "a", "test."],
        ["A", "test", "of", "Wrench media"],
      ),
    ).toBe(2);
    expect(longestTokenOverlap(["one", "two"], ["three", "four"])).toBe(0);
    expect(longestTokenOverlap(["a", "b", "a", "b"], ["a", "b", "a"])).toBe(2);
  });

  test("drops complete repeats and retains novel surface tokens and timing", () => {
    const cues: readonly TranscriptCue[] = [
      { startMs: 0, endMs: 2_000, text: "we can save" },
      { startMs: 1_000, endMs: 3_000, text: "we can save" },
      { startMs: 2_000, endMs: 4_000, text: "can save anything now" },
    ];
    expect(deduplicateRollingCaptionCues(cues)).toEqual([
      { startMs: 0, endMs: 2_000, text: "we can save" },
      { startMs: 2_000, endMs: 4_000, text: "anything now" },
    ]);
  });
});

describe("canonical derivatives", () => {
  test("normalizes cue whitespace and terminates nonempty text exactly once", () => {
    const cues = [{ startMs: 0, endMs: 1, text: "  first\tline  " }];
    expect(renderTranscriptText(cues)).toBe("first line\n");
    expect(renderTranscriptText([])).toBe("");
    expect(renderTranscriptJson(cues)).toBe(
      '{\n  "version": 1,\n  "cues": [\n    {\n      "startMs": 0,\n      "endMs": 1,\n      "text": "first line"\n    }\n  ]\n}\n',
    );
  });

  test("strictly validates local cues and renders canonical WebVTT", () => {
    const cues = [
      { startMs: 0, endMs: 1_250, text: "  A <local> & cue  " },
      { startMs: 1_100, endMs: 3_661_001, text: "second\tline" },
    ];
    const validated = validateTranscriptCues(cues);
    expect(validated).toMatchObject({ ok: true, cues: [
      { startMs: 0, endMs: 1_250, text: "A <local> & cue" },
      { startMs: 1_100, endMs: 3_661_001, text: "second line" },
    ] });
    if (!validated.ok) throw new Error(validated.error.message);
    expect(validated.vtt).toBe(`WEBVTT

1
00:00:00.000 --> 00:00:01.250
A &lt;local&gt; &amp; cue

2
00:00:01.100 --> 01:01:01.001
second line
`);
    expect(parseWebVtt(validated.vtt)).toMatchObject({
      ok: true,
      cues: validated.cues,
      text: validated.text,
    });
    expect(renderTranscriptVtt(validated.cues)).toBe(validated.vtt);
  });

  test("rejects empty, inexact, invalid, and non-monotonic local cues", () => {
    expect(validateTranscriptCues(null)).toMatchObject({
      ok: false,
      error: { code: "invalid-cues" },
    });
    expect(validateTranscriptCues([])).toMatchObject({
      ok: false,
      error: { code: "empty-transcript" },
    });
    expect(validateTranscriptCues([
      { startMs: 0, endMs: 1, text: "ok", extra: true },
    ])).toMatchObject({ ok: false, error: { code: "invalid-cue" } });
    expect(validateTranscriptCues([
      { startMs: 0, endMs: 1, text: " \u0000 " },
    ])).toMatchObject({ ok: false, error: { code: "invalid-cue" } });
    expect(validateTranscriptCues([
      { startMs: 100, endMs: 300, text: "first" },
      { startMs: 50, endMs: 400, text: "backwards start" },
    ])).toMatchObject({ ok: false, error: { code: "non-monotonic-cues" } });
    expect(validateTranscriptCues([
      { startMs: 100, endMs: 500, text: "first" },
      { startMs: 200, endMs: 400, text: "backwards end" },
    ])).toMatchObject({ ok: false, error: { code: "non-monotonic-cues" } });
  });
});
