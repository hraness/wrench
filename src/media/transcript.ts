const MAX_WEBVTT_CODE_UNITS = 64 * 1024 * 1024;
const MAX_CUE_COUNT = 1_000_000;

const TIMESTAMP_SOURCE = String.raw`(?:\d{2,}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})`;
const TIMING_LINE_PATTERN = new RegExp(
  String.raw`^(${TIMESTAMP_SOURCE})[ \t]+-->[ \t]+(${TIMESTAMP_SOURCE})(?:[ \t]+.*)?$`,
  "u",
);
const STRICT_TIMING_LINE_PATTERN = new RegExp(
  String.raw`^(${TIMESTAMP_SOURCE})[ \t]+-->[ \t]+(${TIMESTAMP_SOURCE})$`,
  "u",
);
const VTT_TAG_PATTERN = /^(?:\/?(?:b|i|u|ruby|rt|br)|\/?c(?:\.[^\s.<>]+)*|\/?v(?:\s+[^<>]*)?|\/?lang(?:\s+[^<>]*)?)$/iu;
const VTT_TIMESTAMP_TAG_PATTERN = new RegExp(String.raw`^${TIMESTAMP_SOURCE}$`, "u");
const ENTITY_PATTERN = /&(?:#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]+);/gu;
// Intentional WebVTT control-code sanitation; printable whitespace is handled separately.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const WHITESPACE_PATTERN = /\s+/gu;
const TOKEN_EDGE_PATTERN = /^(?:[\p{P}\p{S}]+)|(?:[\p{P}\p{S}]+)$/gu;

export type TranscriptCue = Readonly<{
  startMs: number;
  endMs: number;
  text: string;
}>;

export type TranscriptDocument = Readonly<{
  version: 1;
  cues: readonly TranscriptCue[];
}>;

export type TranscriptParseErrorCode =
  | "invalid-input"
  | "input-too-large"
  | "invalid-webvtt-header"
  | "no-valid-cues"
  | "empty-transcript";

export type TranscriptParseError = Readonly<{
  code: TranscriptParseErrorCode;
  message: string;
}>;

export type TranscriptParseResult =
  | Readonly<{
      ok: true;
      cues: readonly TranscriptCue[];
      text: string;
      json: string;
    }>
  | Readonly<{
      ok: false;
      error: TranscriptParseError;
    }>;

export type StrictLocalWebVttResult =
  | Readonly<{ ok: true; cues: readonly TranscriptCue[] }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "invalid-input" | "input-too-large" | "invalid-header" | "invalid-cue-block" | "too-many-cues";
        message: string;
      }>;
    }>;

export type TranscriptCueValidationErrorCode =
  | "invalid-cues"
  | "too-many-cues"
  | "empty-transcript"
  | "invalid-cue"
  | "non-monotonic-cues";

export type TranscriptCueValidationResult =
  | Readonly<{
      ok: true;
      cues: readonly TranscriptCue[];
      vtt: string;
      text: string;
      json: string;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: TranscriptCueValidationErrorCode;
        message: string;
      }>;
    }>;

type ParsedTiming = Readonly<{
  startMs: number;
  endMs: number;
}>;

/**
 * Parses WebVTT into canonical transcript derivatives. Malformed cue blocks are
 * ignored so that one damaged provider cue cannot discard an otherwise useful
 * transcript, but the envelope, timestamps, and nonempty-success invariant are
 * strict.
 */
export function parseWebVtt(input: unknown): TranscriptParseResult {
  if (typeof input !== "string") {
    return failure("invalid-input", "WebVTT input must be a string.");
  }
  if (input.length > MAX_WEBVTT_CODE_UNITS) {
    return failure(
      "input-too-large",
      `WebVTT input exceeds the ${String(MAX_WEBVTT_CODE_UNITS)} code-unit limit.`,
    );
  }

  const normalizedInput = toUnicodeScalarString(input)
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n");
  const lines = normalizedInput.split("\n");
  const header = lines[0];
  if (header === undefined || !/^WEBVTT(?:[ \t].*)?$/u.test(header)) {
    return failure("invalid-webvtt-header", "WebVTT input must begin with a WEBVTT header.");
  }

  let cursor = 1;
  while (cursor < lines.length && !isBlank(lines[cursor])) cursor += 1;

  const parsedCues: TranscriptCue[] = [];
  while (cursor < lines.length && parsedCues.length < MAX_CUE_COUNT) {
    while (cursor < lines.length && isBlank(lines[cursor])) cursor += 1;
    if (cursor >= lines.length) break;

    const blockStart = cursor;
    while (cursor < lines.length && !isBlank(lines[cursor])) cursor += 1;
    const block = lines.slice(blockStart, cursor);
    const firstLine = block[0];
    if (firstLine === undefined || isMetadataBlock(firstLine)) continue;

    const timingIndex = timingLineIndex(block);
    if (timingIndex === -1) continue;
    const timingLine = block[timingIndex];
    if (timingLine === undefined) continue;
    const timing = parseTimingLine(timingLine);
    if (timing === undefined) continue;

    const cueText = stripWebVttMarkup(block.slice(timingIndex + 1).join("\n"));
    if (cueText.length === 0) continue;
    parsedCues.push({ ...timing, text: cueText });
  }

  if (parsedCues.length === 0) {
    return failure("no-valid-cues", "WebVTT input contains no valid, nonempty cues.");
  }

  const cues = deduplicateRollingCaptionCues(parsedCues);
  if (cues.length === 0) {
    return failure("empty-transcript", "WebVTT cues contain no transcript text after cleanup.");
  }

  const text = renderTranscriptText(cues);
  if (text.trim().length === 0) {
    return failure("empty-transcript", "WebVTT cues contain no transcript text after cleanup.");
  }

  return {
    ok: true,
    cues,
    text,
    json: renderTranscriptJson(cues),
  };
}

/**
 * Parses the exact WebVTT subset emitted by Wrench media's whisper.cpp profile. Unlike
 * provider caption recovery, every nonblank block must be one complete cue;
 * malformed or excess output fails the whole local attempt.
 */
export function parseStrictLocalWebVtt(input: unknown): StrictLocalWebVttResult {
  if (typeof input !== "string") {
    return strictVttFailure("invalid-input", "Local WebVTT input must be a string.");
  }
  if (input.length > MAX_WEBVTT_CODE_UNITS) {
    return strictVttFailure(
      "input-too-large",
      `Local WebVTT input exceeds the ${String(MAX_WEBVTT_CODE_UNITS)} code-unit limit.`,
    );
  }

  const scalarInput = toUnicodeScalarString(input);
  if (scalarInput !== input) {
    return strictVttFailure("invalid-input", "Local WebVTT must contain valid Unicode scalar text.");
  }
  const lines = input.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0] !== "WEBVTT" || lines[1] === undefined || !isBlank(lines[1])) {
    return strictVttFailure("invalid-header", "Local WebVTT must use Wrench media's exact WEBVTT envelope.");
  }

  const cues: TranscriptCue[] = [];
  let cursor = 2;
  while (cursor < lines.length) {
    while (cursor < lines.length && isBlank(lines[cursor])) cursor += 1;
    if (cursor >= lines.length) break;
    if (cues.length >= MAX_CUE_COUNT) {
      return strictVttFailure(
        "too-many-cues",
        `Local WebVTT exceeds the ${String(MAX_CUE_COUNT)} cue limit.`,
      );
    }

    const blockStart = cursor;
    while (cursor < lines.length && !isBlank(lines[cursor])) cursor += 1;
    const block = lines.slice(blockStart, cursor);
    const timingLine = block[0];
    if (
      timingLine === undefined
      || !STRICT_TIMING_LINE_PATTERN.test(timingLine)
      || block.length < 2
    ) {
      return strictVttFailure(
        "invalid-cue-block",
        `Local WebVTT cue ${String(cues.length)} is malformed.`,
      );
    }
    const timing = parseTimingLine(timingLine);
    const text = stripWebVttMarkup(block.slice(1).join("\n"));
    if (timing === undefined || text.length === 0) {
      return strictVttFailure(
        "invalid-cue-block",
        `Local WebVTT cue ${String(cues.length)} is malformed.`,
      );
    }
    cues.push({ ...timing, text });
  }
  return { ok: true, cues };
}

/**
 * Removes WebVTT cue tags and decodes a conservative entity allowlist. Unknown
 * angle-bracket text and named entities remain literal instead of being guessed.
 */
export function stripWebVttMarkup(input: string): string {
  const scalarInput = toUnicodeScalarString(input);
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < scalarInput.length) {
    const tagStart = scalarInput.indexOf("<", cursor);
    if (tagStart === -1) {
      chunks.push(scalarInput.slice(cursor));
      break;
    }
    chunks.push(scalarInput.slice(cursor, tagStart));
    const tagEnd = scalarInput.indexOf(">", tagStart + 1);
    if (tagEnd === -1) {
      chunks.push(scalarInput.slice(tagStart));
      break;
    }

    const tag = scalarInput.slice(tagStart + 1, tagEnd).trim();
    if (!VTT_TAG_PATTERN.test(tag) && !VTT_TIMESTAMP_TAG_PATTERN.test(tag)) {
      chunks.push(scalarInput.slice(tagStart, tagEnd + 1));
      cursor = tagEnd + 1;
      continue;
    }

    if (/^br$/iu.test(tag)) chunks.push(" ");
    cursor = tagEnd + 1;
  }

  const decoded = chunks.join("").replace(ENTITY_PATTERN, (entity) => decodeEntity(entity));
  return decoded
    .replace(CONTROL_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim()
    .normalize("NFC");
}

/** Returns the largest token count shared by the left suffix and right prefix. */
export function longestTokenOverlap(
  leftTokens: readonly string[],
  rightTokens: readonly string[],
): number {
  const maximum = Math.min(leftTokens.length, rightTokens.length);
  if (maximum === 0) return 0;

  const pattern = rightTokens.slice(0, maximum).map(normalizeToken);
  const prefixLengths = new Array<number>(pattern.length).fill(0);
  for (let index = 1; index < pattern.length; index += 1) {
    let matched = prefixLengths[index - 1] ?? 0;
    const token = pattern[index];
    while (matched > 0 && pattern[matched] !== token) {
      matched = prefixLengths[matched - 1] ?? 0;
    }
    if (pattern[matched] === token) matched += 1;
    prefixLengths[index] = matched;
  }

  let matched = 0;
  for (const rawToken of leftTokens.slice(-maximum)) {
    const token = normalizeToken(rawToken);
    while (matched > 0 && (matched === pattern.length || pattern[matched] !== token)) {
      matched = prefixLengths[matched - 1] ?? 0;
    }
    if (matched < pattern.length && pattern[matched] === token) matched += 1;
  }
  return matched;
}

/**
 * Removes the repeated prefix emitted by YouTube-style rolling captions while
 * retaining each cue's original surface spelling and timing.
 */
export function deduplicateRollingCaptionCues(
  cues: readonly TranscriptCue[],
): readonly TranscriptCue[] {
  const output: TranscriptCue[] = [];
  let previousCue: Readonly<{
    endMs: number;
    tokens: readonly string[];
  }> | undefined;

  for (const cue of cues) {
    const cueText = canonicalCueText(cue.text);
    if (cueText.length === 0) continue;
    const cueTokens = tokenize(cueText);
    // Rolling captions repeat the suffix of the immediately preceding cue
    // while that cue is still on screen. Equal words spoken again after the
    // prior cue ends are new speech and must remain in durable derivatives.
    const overlap = previousCue !== undefined && cue.startMs < previousCue.endMs
      ? longestTokenOverlap(previousCue.tokens, cueTokens)
      : 0;
    const novelTokens = cueTokens.slice(overlap);
    previousCue = { endMs: cue.endMs, tokens: cueTokens };
    if (novelTokens.length === 0) continue;

    output.push({
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: novelTokens.join(" "),
    });
  }

  return output;
}

/** Renders one canonical NFC cue per line with exactly one trailing newline. */
export function renderTranscriptText(cues: readonly TranscriptCue[]): string {
  const lines = cues
    .map(({ text }) => canonicalCueText(text))
    .filter((text) => text.length > 0);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Renders stable, newline-terminated JSON for durable transcript interchange. */
export function renderTranscriptJson(cues: readonly TranscriptCue[]): string {
  const document: TranscriptDocument = {
    version: 1,
    cues: cues.map(({ startMs, endMs, text }) => ({
      startMs,
      endMs,
      text: canonicalCueText(text),
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Validates the stricter cue contract used for locally generated transcripts.
 * Provider WebVTT remains recoverable cue-by-cue; output from a configured
 * local engine must instead be complete, ordered, exact, and independently
 * renderable before Wrench media can promote an archive.
 */
export function validateTranscriptCues(input: unknown): TranscriptCueValidationResult {
  if (!Array.isArray(input)) {
    return cueValidationFailure("invalid-cues", "Transcript cues must be an array.");
  }
  if (input.length > MAX_CUE_COUNT) {
    return cueValidationFailure(
      "too-many-cues",
      `Transcript output exceeds the ${String(MAX_CUE_COUNT)} cue limit.`,
    );
  }
  if (input.length === 0) {
    return cueValidationFailure("empty-transcript", "Transcript output contains no cues.");
  }

  const cues: TranscriptCue[] = [];
  let previousStartMs = -1;
  let previousEndMs = -1;
  for (let index = 0; index < input.length; index += 1) {
    const value: unknown = input[index];
    if (!isExactCue(value)) {
      return cueValidationFailure(
        "invalid-cue",
        `Transcript cue ${String(index)} is not an exact timed-text cue.`,
      );
    }
    const text = canonicalCueText(value.text);
    if (text.length === 0) {
      return cueValidationFailure(
        "invalid-cue",
        `Transcript cue ${String(index)} has no printable text.`,
      );
    }
    if (value.startMs < previousStartMs || value.endMs < previousEndMs) {
      return cueValidationFailure(
        "non-monotonic-cues",
        `Transcript cue ${String(index)} moves backwards in time.`,
      );
    }
    const cue = { startMs: value.startMs, endMs: value.endMs, text };
    cues.push(cue);
    previousStartMs = cue.startMs;
    previousEndMs = cue.endMs;
  }

  const text = renderTranscriptText(cues);
  if (text.length === 0) {
    return cueValidationFailure("empty-transcript", "Transcript output contains no text.");
  }
  return {
    ok: true,
    cues,
    vtt: renderTranscriptVtt(cues),
    text,
    json: renderTranscriptJson(cues),
  };
}

/** Renders plain canonical cues as deterministic, newline-terminated WebVTT. */
export function renderTranscriptVtt(cues: readonly TranscriptCue[]): string {
  if (cues.length === 0) return "WEBVTT\n\n";
  const blocks = cues.map((cue, index) => [
    String(index + 1),
    `${renderWebVttTimestamp(cue.startMs)} --> ${renderWebVttTimestamp(cue.endMs)}`,
    escapeWebVttText(canonicalCueText(cue.text)),
  ].join("\n"));
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

function cueValidationFailure(
  code: TranscriptCueValidationErrorCode,
  message: string,
): TranscriptCueValidationResult {
  return { ok: false, error: { code, message } };
}

function strictVttFailure(
  code: "invalid-input" | "input-too-large" | "invalid-header" | "invalid-cue-block" | "too-many-cues",
  message: string,
): StrictLocalWebVttResult {
  return { ok: false, error: { code, message } };
}

function isExactCue(value: unknown): value is TranscriptCue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 3
    && keys[0] === "endMs"
    && keys[1] === "startMs"
    && keys[2] === "text"
    && Number.isSafeInteger(record["startMs"])
    && (record["startMs"] as number) >= 0
    && Number.isSafeInteger(record["endMs"])
    && (record["endMs"] as number) > (record["startMs"] as number)
    && typeof record["text"] === "string"
  );
}

function renderWebVttTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function escapeWebVttText(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function failure(code: TranscriptParseErrorCode, message: string): TranscriptParseResult {
  return { ok: false, error: { code, message } };
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || /^[ \t]*$/u.test(line);
}

function isMetadataBlock(line: string): boolean {
  return /^(?:NOTE(?:[ \t].*)?|STYLE|REGION)$/u.test(line);
}

function timingLineIndex(block: readonly string[]): number {
  if (block[0] !== undefined && TIMING_LINE_PATTERN.test(block[0])) return 0;
  if (block[1] !== undefined && TIMING_LINE_PATTERN.test(block[1])) return 1;
  return -1;
}

function parseTimingLine(line: string): ParsedTiming | undefined {
  const match = TIMING_LINE_PATTERN.exec(line);
  const startText = match?.[1];
  const endText = match?.[2];
  if (startText === undefined || endText === undefined) return undefined;
  const startMs = parseTimestamp(startText);
  const endMs = parseTimestamp(endText);
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;
  return { startMs, endMs };
}

function parseTimestamp(timestamp: string): number | undefined {
  const parts = timestamp.split(":");
  if (parts.length !== 2 && parts.length !== 3) return undefined;

  const secondsPart = parts.at(-1);
  const minutesPart = parts.at(-2);
  const hoursPart = parts.length === 3 ? parts[0] : "0";
  if (secondsPart === undefined || minutesPart === undefined || hoursPart === undefined) {
    return undefined;
  }

  const secondsMatch = /^(\d{2})\.(\d{3})$/u.exec(secondsPart);
  if (secondsMatch === null || !/^\d{2}$/u.test(minutesPart) || !/^\d+$/u.test(hoursPart)) {
    return undefined;
  }

  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  const seconds = Number(secondsMatch[1]);
  const milliseconds = Number(secondsMatch[2]);
  if (
    !Number.isSafeInteger(hours)
    || minutes > 59
    || seconds > 59
  ) {
    return undefined;
  }

  const result = (((hours * 60) + minutes) * 60 + seconds) * 1_000 + milliseconds;
  return Number.isSafeInteger(result) ? result : undefined;
}

function decodeEntity(entity: string): string {
  const namedEntities: Readonly<Record<string, string>> = {
    "&amp;": "&",
    "&apos;": "'",
    "&gt;": ">",
    "&lrm;": "\u200E",
    "&lt;": "<",
    "&nbsp;": "\u00A0",
    "&quot;": '"',
    "&rlm;": "\u200F",
  };
  const named = namedEntities[entity.toLowerCase()];
  if (named !== undefined) return named;

  const numericMatch = /^&#(?:([xX])([0-9a-fA-F]+)|(\d+));$/u.exec(entity);
  if (numericMatch === null) return entity;
  const radix = numericMatch[1] === undefined ? 10 : 16;
  const digits = numericMatch[2] ?? numericMatch[3];
  if (digits === undefined) return entity;
  const codePoint = Number.parseInt(digits, radix);
  if (
    !Number.isInteger(codePoint)
    || codePoint === 0
    || codePoint > 0x10_FFFF
    || (codePoint >= 0xD800 && codePoint <= 0xDFFF)
  ) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function tokenize(text: string): string[] {
  return text.split(WHITESPACE_PATTERN).filter((token) => token.length > 0);
}

function normalizeToken(token: string): string {
  const normalized = toUnicodeScalarString(token)
    .normalize("NFKC")
    .toLowerCase()
    .replace(TOKEN_EDGE_PATTERN, "");
  return normalized.length === 0 ? token.normalize("NFKC").toLowerCase() : normalized;
}

function canonicalCueText(text: string): string {
  return toUnicodeScalarString(text)
    .replace(CONTROL_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim()
    .normalize("NFC");
}

function toUnicodeScalarString(input: string): string {
  if (!/[\uD800-\uDFFF]/u.test(input)) return input;

  const chunks: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        chunks.push(input.slice(index, index + 2));
        index += 1;
      } else {
        chunks.push("\uFFFD");
      }
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      chunks.push("\uFFFD");
    } else {
      chunks.push(input[index] ?? "");
    }
  }
  return chunks.join("");
}
