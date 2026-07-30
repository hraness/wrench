import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  type CommandArgv,
} from "./process";
import {
  parseRuntimeClosureRecord,
  runAttestedRuntimeProcess,
  sameRuntimeClosureRecord,
  type AttestedRuntimeProcessResult,
  type AttestRuntimeClosureOptions,
  type RuntimeClosureAttestation,
  type RuntimeClosureRecord,
} from "./runtime-closure";
import {
  parseStrictLocalWebVtt,
  stripWebVttMarkup,
  validateTranscriptCues,
  type TranscriptCue,
} from "./transcript";
import {
  normalizeWhisperCppLanguage,
  whisperCppLanguageArgument,
} from "./whisper-language";

export {
  normalizeWhisperCppLanguage,
  whisperCppLanguageArgument,
} from "./whisper-language";

/** Pinned Wrench media invocation contract; changing it changes transcript provenance. */
export const WHISPER_CPP_PROFILE = "wrench-media-whisper-cpp-v1";

/** Fixed PCM contract produced by Wrench media before invoking whisper.cpp. */
export const WHISPER_CPP_NORMALIZATION_PROFILE = "pcm-s16le-16000hz-mono-v1";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const PROCESS_STDOUT_LIMIT_BYTES = 64 * 1024;
const PROCESS_STDERR_LIMIT_BYTES = 1024 * 1024;
const MAX_VTT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const OUTPUT_STEM = "transcript";

type WhisperCppOutputKind = "vtt" | "json";

export type WhisperCppTranscription = Readonly<{
  language: string | null;
  cues: readonly TranscriptCue[];
  vtt: string;
  text: string;
  json: string;
}>;

export type WhisperCppFailureCode =
  | "invalid-request"
  | "runtime-closure-changed"
  | "work-directory"
  | "output-exists"
  | "process"
  | "output-missing"
  | "output-unsafe"
  | "output-too-large"
  | "output-changed"
  | "invalid-json"
  | "invalid-language"
  | "language-mismatch"
  | "invalid-vtt"
  | "output-mismatch";

export type ParsedWhisperCppResult =
  | Readonly<{ ok: true; status: "transcribed"; transcript: WhisperCppTranscription }>
  | Readonly<{ ok: true; status: "no-speech"; language: string | null }>
  | Readonly<{
      ok: false;
      status: "error";
      error: Readonly<{ code: WhisperCppFailureCode; message: string }>;
    }>;

export type WhisperCppResult =
  | Readonly<
      Extract<ParsedWhisperCppResult, { readonly ok: true }>
      & { runtimeClosure: RuntimeClosureAttestation }
    >
  | Extract<ParsedWhisperCppResult, { readonly ok: false }>;

export type RunWhisperCppOptions = Readonly<{
  executable: string;
  modelPath: string;
  pcmPath: string;
  requestedLanguage: string;
  signal?: AbortSignal;
  /** A fresh private directory owned by Wrench media's current transcription attempt. */
  workDirectory: string;
  /** Exact private runtime closure pinned by `wrench transcriber setup`. */
  runtimeClosure: RuntimeClosureRecord;
  timeoutMs?: number;
}>;

export type WhisperCppDependencies = Readonly<{
  runAttestedRuntimeProcess: (
    options: AttestRuntimeClosureOptions,
  ) => Promise<AttestedRuntimeProcessResult>;
  /** Test seam after pathname inspection and before the no-follow output open. */
  beforeOutputOpen?: (path: string, kind: WhisperCppOutputKind) => Promise<void>;
}>;

const defaultDependencies: WhisperCppDependencies = {
  runAttestedRuntimeProcess: (options) => runAttestedRuntimeProcess(options),
};

/**
 * Accepts `auto` or a deliberately small BCP-47-style language token. This is
 * an argv value rather than a path, so controls, separators, and tool grammar
 * are never admitted.
 */
/** Builds Wrench media's complete whisper.cpp argv; `Bun.spawn` receives this directly. */
export function buildWhisperCppArgv(
  options: Readonly<{
    executable: string;
    modelPath: string;
    pcmPath: string;
    requestedLanguage: string;
    outputPrefix: string;
  }>,
): CommandArgv {
  const language = normalizeWhisperCppLanguage(options.requestedLanguage);
  if (language === null) throw new TypeError("whisper.cpp language must be auto or a literal BCP-47-style tag");
  const toolLanguage = whisperCppLanguageArgument(language);
  if (toolLanguage === null) throw new TypeError("whisper.cpp language must have a supported primary subtag");
  for (const value of [options.executable, options.modelPath, options.pcmPath, options.outputPrefix]) {
    if (!isNonemptyNulFreeString(value)) {
      throw new TypeError("whisper.cpp executable and filesystem paths must be nonempty and NUL-free");
    }
  }
  return [
    options.executable,
    "--model",
    options.modelPath,
    "--file",
    options.pcmPath,
    "--language",
    toolLanguage,
    "--threads",
    "4",
    "--processors",
    "1",
    "--no-gpu",
    "--output-vtt",
    "--output-json-full",
    "--output-file",
    options.outputPrefix,
    "--no-prints",
  ];
}

/**
 * Runs whisper.cpp in a caller-created fresh directory. The adapter consumes
 * only its fixed output names, validates them, and never exposes tool stderr.
 */
export async function runWhisperCpp(
  options: RunWhisperCppOptions,
  dependencies: WhisperCppDependencies = defaultDependencies,
): Promise<WhisperCppResult> {
  const language = normalizeWhisperCppLanguage(options.requestedLanguage);
  if (language === null) return failure("invalid-request", "local transcription language is invalid");
  if (![options.executable, options.modelPath, options.pcmPath, options.workDirectory].every(isNonemptyNulFreeString)) {
    return failure("invalid-request", "local transcription executable and filesystem paths are invalid");
  }
  const expectedRuntime = parseRuntimeClosureRecord(options.runtimeClosure);
  if (!expectedRuntime.ok) {
    return failure("invalid-request", "local transcription runtime identity is invalid");
  }

  const prepared = await prepareOutputDirectory(options.workDirectory);
  if (!prepared.ok) return prepared.result;
  const { outputPrefix } = prepared;

  let process: AttestedRuntimeProcessResult;
  try {
    const argv = buildWhisperCppArgv({
      executable: options.executable,
      modelPath: options.modelPath,
      pcmPath: options.pcmPath,
      requestedLanguage: language,
      outputPrefix,
    });
    process = await dependencies.runAttestedRuntimeProcess({
      executablePath: options.executable,
      executableSha256: expectedRuntime.record.executableSha256,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      probeArguments: argv.slice(1),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: PROCESS_STDOUT_LIMIT_BYTES,
      maxStderrBytes: PROCESS_STDERR_LIMIT_BYTES,
    });
  } catch {
    return failure("process", "local transcription process did not complete safely");
  }
  if (!sameRuntimeClosureRecord(process.attestation, expectedRuntime.record)) {
    return failure(
      "runtime-closure-changed",
      "local transcription runtime closure changed during inference",
    );
  }

  const vtt = await readOwnedOutput(outputPrefix, "vtt", MAX_VTT_BYTES, dependencies);
  if (!vtt.ok) return vtt.result;
  const json = await readOwnedOutput(outputPrefix, "json", MAX_JSON_BYTES, dependencies);
  if (!json.ok) return json.result;

  const parsed = parseWhisperCppOutputs(vtt.value, json.value, language);
  return parsed.ok
    ? { ...parsed, runtimeClosure: process.attestation }
    : parsed;
}

/**
 * Parses already bounded whisper.cpp output. The public result contains only
 * Wrench media's canonical transcript derivatives, not the tool's JSON envelope.
 */
export function parseWhisperCppOutputs(
  vttInput: unknown,
  jsonInput: unknown,
  requestedLanguage: unknown,
): ParsedWhisperCppResult {
  const language = normalizeWhisperCppLanguage(requestedLanguage);
  if (language === null) return failure("invalid-request", "local transcription language is invalid");
  if (typeof vttInput !== "string") return failure("invalid-vtt", "local transcription did not produce WebVTT");
  if (typeof jsonInput !== "string") return failure("invalid-json", "local transcription did not produce JSON");
  if (vttInput.length > MAX_VTT_BYTES) return failure("output-too-large", "local transcription WebVTT exceeds Wrench media's limit");
  if (jsonInput.length > MAX_JSON_BYTES) return failure("output-too-large", "local transcription JSON exceeds Wrench media's limit");

  const json = parseWhisperCppJson(jsonInput);
  if (!json.ok) return json.result;
  if (
    language !== "auto"
    && json.language !== null
    && !languagesMatch(language, json.language)
  ) return failure("language-mismatch", "local transcription returned an unexpected language");

  const parsedVtt = parseStrictLocalWebVtt(vttInput);
  if (!parsedVtt.ok) {
    return failure("invalid-vtt", "local transcription returned invalid WebVTT");
  }
  if (parsedVtt.cues.length === 0 || json.cues.length === 0) {
    if (parsedVtt.cues.length !== json.cues.length) {
      return failure("output-mismatch", "local transcription WebVTT and JSON disagree");
    }
    return { ok: true, status: "no-speech", language: json.language };
  }
  const validated = validateTranscriptCues(parsedVtt.cues);
  const validatedJson = validateTranscriptCues(json.cues);
  if (!validated.ok) {
    return failure("invalid-vtt", "local transcription returned invalid timed cues");
  }
  if (!validatedJson.ok) {
    return failure("invalid-json", "local transcription JSON contains invalid timed cues");
  }
  if (validated.json !== validatedJson.json) {
    return failure("output-mismatch", "local transcription WebVTT and JSON disagree");
  }
  return {
    ok: true,
    status: "transcribed",
    transcript: {
      language: json.language,
      cues: validated.cues,
      vtt: validated.vtt,
      text: validated.text,
      json: validated.json,
    },
  };
}

function failure(code: WhisperCppFailureCode, message: string): Extract<
  ParsedWhisperCppResult,
  { readonly ok: false }
> {
  return { ok: false, status: "error", error: { code, message } };
}

async function prepareOutputDirectory(
  candidate: string,
): Promise<Readonly<{ ok: true; directory: string; outputPrefix: string }> | Readonly<{ ok: false; result: WhisperCppResult }>> {
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return { ok: false, result: failure("work-directory", "local transcription work directory is unsafe") };
    }
    const directory = await realpath(candidate);
    const outputPrefix = join(directory, OUTPUT_STEM);
    if (!isContainedPath(directory, outputPrefix)) {
      return { ok: false, result: failure("work-directory", "local transcription work directory is unsafe") };
    }
    for (const suffix of ["vtt", "json"] as const) {
      try {
        await lstat(`${outputPrefix}.${suffix}`);
        return { ok: false, result: failure("output-exists", "local transcription output already exists") };
      } catch (error) {
        if (isMissing(error)) continue;
        return { ok: false, result: failure("work-directory", "local transcription work directory cannot be inspected") };
      }
    }
    return { ok: true, directory, outputPrefix };
  } catch {
    return { ok: false, result: failure("work-directory", "local transcription work directory is unsafe") };
  }
}

async function readOwnedOutput(
  outputPrefix: string,
  kind: WhisperCppOutputKind,
  maximumBytes: number,
  dependencies: WhisperCppDependencies,
): Promise<Readonly<{ ok: true; value: string }> | Readonly<{ ok: false; result: WhisperCppResult }>> {
  const path = `${outputPrefix}.${kind}`;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return unsafeOutput();
    if (before.size === 0) return missingOutput();
    if (before.size > maximumBytes) return tooLargeOutput();

    await dependencies.beforeOutputOpen?.(path, kind);
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size === 0) return unsafeOutput();
      if (opened.size > maximumBytes) return tooLargeOutput();
      const bytes = await handle.readFile();
      const [after, finalPath] = await Promise.all([handle.stat(), lstat(path)]);
      if (
        !finalPath.isFile()
        || finalPath.isSymbolicLink()
        || !sameFileState(before, opened)
        || !sameFileState(opened, after)
        || !sameFileState(opened, finalPath)
        || bytes.byteLength !== opened.size
      ) {
        return { ok: false, result: failure("output-changed", "local transcription output changed while being read") };
      }
      return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissing(error)) return missingOutput();
    return unsafeOutput();
  }
}

function parseWhisperCppJson(
  input: string,
): Readonly<{ ok: true; language: string | null; cues: readonly TranscriptCue[] }> | Readonly<{ ok: false; result: WhisperCppResult }> {
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    return { ok: false, result: failure("invalid-json", "local transcription returned invalid JSON") };
  }
  if (!isRecord(value)) {
    return { ok: false, result: failure("invalid-json", "local transcription JSON must be an object") };
  }

  const candidates = [
    value.language,
    recordProperty(value.result, "language"),
    recordProperty(value.transcription, "language"),
    recordProperty(value.transcription_info, "language"),
  ].filter((candidate): candidate is unknown => candidate !== undefined);
  const languages: string[] = [];
  for (const candidate of candidates) {
    const language = normalizeWhisperCppLanguage(candidate);
    if (language === null || language === "auto") {
      return { ok: false, result: failure("invalid-language", "local transcription JSON language is invalid") };
    }
    languages.push(language);
  }
  const unique = [...new Set(languages)];
  if (unique.length > 1) {
    return { ok: false, result: failure("invalid-language", "local transcription JSON languages disagree") };
  }
  const transcription = value.transcription;
  if (!Array.isArray(transcription)) {
    return { ok: false, result: failure("invalid-json", "local transcription JSON has no segment array") };
  }
  const cues: TranscriptCue[] = [];
  for (let index = 0; index < transcription.length; index += 1) {
    const segment: unknown = transcription[index];
    if (!isRecord(segment) || !isRecord(segment.offsets) || typeof segment.text !== "string") {
      return { ok: false, result: failure("invalid-json", "local transcription JSON contains an invalid segment") };
    }
    const startMs = segment.offsets.from;
    const endMs = segment.offsets.to;
    const text = stripWebVttMarkup(segment.text);
    if (
      !Number.isSafeInteger(startMs)
      || !Number.isSafeInteger(endMs)
      || (startMs as number) < 0
      || (endMs as number) <= (startMs as number)
      || text.length === 0
    ) {
      return { ok: false, result: failure("invalid-json", "local transcription JSON contains an invalid segment") };
    }
    cues.push({ startMs: startMs as number, endMs: endMs as number, text });
  }
  return { ok: true, language: unique[0] ?? null, cues };
}

function recordProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyNulFreeString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function languagesMatch(requested: string, detected: string): boolean {
  const requestedToolLanguage = whisperCppLanguageArgument(requested);
  const detectedToolLanguage = whisperCppLanguageArgument(detected);
  return requestedToolLanguage !== null
    && requestedToolLanguage !== "auto"
    && requestedToolLanguage === detectedToolLanguage;
}

function isContainedPath(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !relativePath.includes("\\0");
}

function sameFileState(
  left: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>,
  right: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function missingOutput(): Readonly<{ ok: false; result: WhisperCppResult }> {
  return { ok: false, result: failure("output-missing", "local transcription did not produce its expected output") };
}

function unsafeOutput(): Readonly<{ ok: false; result: WhisperCppResult }> {
  return { ok: false, result: failure("output-unsafe", "local transcription output is unsafe") };
}

function tooLargeOutput(): Readonly<{ ok: false; result: WhisperCppResult }> {
  return { ok: false, result: failure("output-too-large", "local transcription output exceeds Wrench media's limit") };
}
