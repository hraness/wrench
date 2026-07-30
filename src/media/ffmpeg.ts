import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  runProcess,
  type CommandArgv,
  type ProcessResult,
  type RunProcessOptions,
} from "./process";

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_REMUX_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const PROBE_STDOUT_LIMIT_BYTES = 4 * 1024 * 1024;
const TOOL_STDERR_LIMIT_BYTES = 1024 * 1024;
const REMUX_STDOUT_LIMIT_BYTES = 64 * 1024;
const MAX_FFPROBE_JSON_CODE_UNITS = 4 * 1024 * 1024;
const MAX_INSPECTED_STREAMS = 16_384;

export const PCM_NORMALIZATION_PROFILE = "pcm-s16le-16000hz-mono-v1" as const;
export const PCM_NORMALIZATION_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const PCM_NORMALIZATION_MAX_BYTES = (4 * 1024 * 1024 * 1024) - 1;
const PCM_WAVE_HEADER_BYTES = 44;
const PCM_SAMPLE_RATE = 16_000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BLOCK_ALIGN = 2;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_BLOCK_ALIGN;

export type MediaStreamKind =
  | "video"
  | "audio"
  | "subtitle"
  | "data"
  | "attachment"
  | "other";

export type InspectedMediaStream = Readonly<{
  index: number;
  kind: MediaStreamKind;
  codecName: string | null;
}>;

export type MediaInspection = Readonly<{
  streams: readonly InspectedMediaStream[];
  hasVideo: boolean;
  hasAudio: boolean;
  firstVideoStreamIndex: number | null;
  firstAudioStreamIndex: number | null;
}>;

export type FfprobeParseErrorCode =
  | "invalid-json"
  | "invalid-root"
  | "invalid-streams"
  | "too-many-streams"
  | "invalid-stream";

export type FfprobeParseResult =
  | Readonly<{
      ok: true;
      inspection: MediaInspection;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: FfprobeParseErrorCode;
        message: string;
      }>;
    }>;

export type MediaProbeFailureReason = "process" | "runner" | "invalid-output";

export type MediaProbeResult =
  | Readonly<{
      ok: true;
      inspection: MediaInspection;
    }>
  | Readonly<{
      ok: false;
      reason: MediaProbeFailureReason;
      diagnostic: string;
    }>;

export type MediaDerivativeRole = "video" | "audio";

type DerivativeResultBase = Readonly<{
  role: MediaDerivativeRole;
  path: string;
}>;

export type MediaDerivativeResult =
  | (DerivativeResultBase &
      Readonly<{
        status: "created";
        sourceStreamIndex: number;
      }>)
  | (DerivativeResultBase &
      Readonly<{
        status: "not-present";
      }>)
  | (DerivativeResultBase &
      Readonly<{
        status: "not-requested";
      }>)
  | (DerivativeResultBase &
      Readonly<{
        status: "exists";
        sourceStreamIndex: number;
      }>)
  | (DerivativeResultBase &
      Readonly<{
        status: "failed";
        stage: "probe" | "output-check" | "remux" | "runner";
        diagnostic: string;
      }>);

export type MediaDerivativeReport = Readonly<{
  probe: MediaProbeResult;
  video: MediaDerivativeResult;
  audio: MediaDerivativeResult;
}>;

export type NormalizedPcmWaveHeaderResult =
  | Readonly<{
      ok: true;
      dataBytes: number;
    }>
  | Readonly<{
      ok: false;
      code: "invalid-input" | "invalid-container" | "invalid-format" | "invalid-length" | "empty-audio";
      diagnostic: string;
    }>;

export type PcmNormalizationResult =
  | Readonly<{
      status: "created";
      path: string;
      profile: typeof PCM_NORMALIZATION_PROFILE;
      bytes: number;
    }>
  | Readonly<{
      status: "failed";
      path: string;
      profile: typeof PCM_NORMALIZATION_PROFILE;
      stage: "preflight" | "runner" | "process" | "output-check";
      diagnostic: string;
    }>;

export type InspectMediaOptions = Readonly<{
  capturePath: string;
  ffprobeExecutable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type CreateMediaDerivativesOptions = Readonly<{
  capturePath: string;
  derivativesDirectory: string;
  roles: readonly MediaDerivativeRole[];
  ffprobeExecutable?: string;
  ffmpegExecutable?: string;
  probeTimeoutMs?: number;
  remuxTimeoutMs?: number;
  signal?: AbortSignal;
}>;

export type NormalizeAudioForTranscriptionOptions = Readonly<{
  inputPath: string;
  outputPath: string;
  ffmpegExecutable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type MediaProcessDependencies = Readonly<{
  runProcess: (argv: CommandArgv, options: RunProcessOptions) => Promise<ProcessResult>;
}>;

export type MediaDerivativeDependencies = MediaProcessDependencies;

export type PcmNormalizationDependencies = MediaProcessDependencies & Readonly<{
  /** Test seam after a failed output is identified but before identity-checked cleanup. */
  beforeCleanup?: (path: string) => Promise<void>;
}>;

const defaultProcessDependencies: MediaProcessDependencies = {
  runProcess: (argv, options) => runProcess(argv, options),
};

const defaultDerivativeDependencies: MediaDerivativeDependencies = defaultProcessDependencies;

/** Parses the bounded JSON envelope emitted by Wrench media's ffprobe invocation. */
export function parseFfprobeJson(input: unknown): FfprobeParseResult {
  let value: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_FFPROBE_JSON_CODE_UNITS) {
      return parseFailure(
        "invalid-json",
        `ffprobe JSON exceeds the ${String(MAX_FFPROBE_JSON_CODE_UNITS)} code-unit limit.`,
      );
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return parseFailure("invalid-json", "ffprobe did not return valid JSON.");
    }
  }

  if (!isRecord(value)) {
    return parseFailure("invalid-root", "ffprobe JSON must be an object.");
  }
  const rawStreams = value.streams;
  if (!Array.isArray(rawStreams)) {
    return parseFailure("invalid-streams", "ffprobe JSON must contain a streams array.");
  }
  if (rawStreams.length > MAX_INSPECTED_STREAMS) {
    return parseFailure(
      "too-many-streams",
      `ffprobe reported more than ${String(MAX_INSPECTED_STREAMS)} streams.`,
    );
  }

  const streams: InspectedMediaStream[] = [];
  for (let position = 0; position < rawStreams.length; position += 1) {
    const rawStream: unknown = rawStreams[position];
    if (!isRecord(rawStream)) {
      return invalidStream(position, "must be an object");
    }
    const index = rawStream.index;
    if (!isNonnegativeSafeInteger(index)) {
      return invalidStream(position, "has an invalid index");
    }
    const codecType = rawStream.codec_type;
    if (typeof codecType !== "string" || codecType.length === 0) {
      return invalidStream(position, "has an invalid codec_type");
    }
    const codecName = rawStream.codec_name;
    if (codecName !== undefined && codecName !== null && typeof codecName !== "string") {
      return invalidStream(position, "has an invalid codec_name");
    }
    streams.push({
      index,
      kind: streamKind(codecType),
      codecName: typeof codecName === "string" && codecName.length > 0 ? codecName : null,
    });
  }

  const firstVideo = streams.find((stream) => stream.kind === "video");
  const firstAudio = streams.find((stream) => stream.kind === "audio");
  return {
    ok: true,
    inspection: {
      streams,
      hasVideo: firstVideo !== undefined,
      hasAudio: firstAudio !== undefined,
      firstVideoStreamIndex: firstVideo?.index ?? null,
      firstAudioStreamIndex: firstAudio?.index ?? null,
    },
  };
}

/** Builds the complete shell-free ffprobe argv used to inspect a capture. */
export function buildFfprobeArgv(
  capturePath: string,
  ffprobeExecutable = "ffprobe",
): CommandArgv {
  return [
    ffprobeExecutable,
    "-v",
    "error",
    "-show_entries",
    "stream=index,codec_type,codec_name",
    "-of",
    "json",
    capturePath,
  ];
}

/**
 * Builds a stream-copy command for one primary stream. `-n` is deliberately
 * retained even after a preflight check so a concurrent writer cannot be
 * overwritten between the check and FFmpeg opening the output.
 */
export function buildFfmpegDerivativeArgv(
  role: MediaDerivativeRole,
  capturePath: string,
  outputPath: string,
  ffmpegExecutable = "ffmpeg",
): CommandArgv {
  return [
    ffmpegExecutable,
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-i",
    capturePath,
    "-map",
    role === "video" ? "0:v:0" : "0:a:0",
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    "-c",
    "copy",
    "-f",
    "matroska",
    outputPath,
  ];
}

/** Builds the complete, shell-free command for Wrench media's transcription PCM profile. */
export function buildPcmNormalizationArgv(
  inputPath: string,
  outputPath: string,
  ffmpegExecutable = "ffmpeg",
): CommandArgv {
  return [
    ffmpegExecutable,
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-ac",
    String(PCM_CHANNELS),
    "-ar",
    String(PCM_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    "-flags:a",
    "+bitexact",
    "-fflags",
    "+bitexact",
    "-f",
    "wav",
    "-fs",
    String(PCM_NORMALIZATION_MAX_BYTES),
    outputPath,
  ];
}

/**
 * Parses only the canonical seekable RIFF/WAVE envelope emitted by Wrench media's
 * fixed PCM command. Extra chunks and streaming/RF64 variants fail closed.
 */
export function parseNormalizedPcmWaveHeader(
  input: unknown,
  fileBytes: unknown,
): NormalizedPcmWaveHeaderResult {
  if (!(input instanceof Uint8Array) || !Number.isSafeInteger(fileBytes)) {
    return pcmHeaderFailure("invalid-input", "Normalized PCM validation requires a bounded byte header and file length.");
  }
  const boundedFileBytes = fileBytes as number;
  if (
    input.byteLength < PCM_WAVE_HEADER_BYTES
    || boundedFileBytes < PCM_WAVE_HEADER_BYTES
    || boundedFileBytes > PCM_NORMALIZATION_MAX_BYTES
  ) {
    return pcmHeaderFailure("invalid-length", "Normalized PCM WAV has an invalid bounded length.");
  }
  if (
    !asciiEquals(input, 0, "RIFF")
    || !asciiEquals(input, 8, "WAVE")
    || !asciiEquals(input, 12, "fmt ")
    || !asciiEquals(input, 36, "data")
  ) {
    return pcmHeaderFailure("invalid-container", "Normalized PCM output is not Wrench media's canonical RIFF/WAVE envelope.");
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const riffBytes = view.getUint32(4, true);
  const formatChunkBytes = view.getUint32(16, true);
  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  if (
    formatChunkBytes !== 16
    || audioFormat !== 1
    || channels !== PCM_CHANNELS
    || sampleRate !== PCM_SAMPLE_RATE
    || byteRate !== PCM_BYTES_PER_SECOND
    || blockAlign !== PCM_BLOCK_ALIGN
    || bitsPerSample !== PCM_BITS_PER_SAMPLE
  ) {
    return pcmHeaderFailure("invalid-format", "Normalized PCM WAV does not match signed 16-bit little-endian mono at 16 kHz.");
  }
  if (dataBytes === 0) {
    return pcmHeaderFailure("empty-audio", "Normalized PCM WAV contains no audio samples.");
  }
  if (
    dataBytes % PCM_BLOCK_ALIGN !== 0
    || riffBytes !== boundedFileBytes - 8
    || dataBytes !== boundedFileBytes - PCM_WAVE_HEADER_BYTES
  ) {
    return pcmHeaderFailure("invalid-length", "Normalized PCM WAV chunk lengths do not match the physical file.");
  }
  return { ok: true, dataBytes };
}

/**
 * Produces one bounded, canonical PCM file for a local transcriber. Existing
 * output paths are never accepted or replaced, and failed output is removed
 * only while it still has the exact identity observed after this invocation.
 */
export async function normalizeAudioForTranscription(
  options: NormalizeAudioForTranscriptionOptions,
  dependencies: PcmNormalizationDependencies = defaultProcessDependencies,
): Promise<PcmNormalizationResult> {
  const timeoutMs = options.timeoutMs ?? PCM_NORMALIZATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > PCM_NORMALIZATION_TIMEOUT_MS
  ) {
    return pcmNormalizationFailure(
      options.outputPath,
      "preflight",
      `PCM normalization timeout must be between 1 and ${String(PCM_NORMALIZATION_TIMEOUT_MS)} milliseconds.`,
    );
  }

  let before: PcmPathEntry;
  try {
    before = await inspectPcmPath(options.outputPath);
  } catch {
    return pcmNormalizationFailure(
      options.outputPath,
      "preflight",
      "Could not safely inspect the normalized PCM output path.",
    );
  }
  if (before.kind !== "missing") {
    return pcmNormalizationFailure(
      options.outputPath,
      "preflight",
      before.kind === "regular"
        ? "The normalized PCM output path already exists; refusing to replace it."
        : `The normalized PCM output path is a foreign ${before.entryType}; refusing to replace it.`,
    );
  }

  const argv = buildPcmNormalizationArgv(
    options.inputPath,
    options.outputPath,
    options.ffmpegExecutable,
  );
  let processResult: ProcessResult;
  try {
    processResult = await dependencies.runProcess(argv, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs,
      maxStdoutBytes: REMUX_STDOUT_LIMIT_BYTES,
      maxStderrBytes: TOOL_STDERR_LIMIT_BYTES,
    });
  } catch {
    const cleanup = await discardCreatedPcmOutput(options.outputPath, dependencies);
    return cleanup.ok
      ? pcmNormalizationFailure(
          options.outputPath,
          "runner",
          "The PCM normalization process runner failed unexpectedly.",
        )
      : pcmNormalizationFailure(options.outputPath, "output-check", cleanup.diagnostic);
  }

  if (!processResult.ok) {
    const cleanup = await discardCreatedPcmOutput(options.outputPath, dependencies);
    return cleanup.ok
      ? pcmNormalizationFailure(options.outputPath, "process", processResult.diagnostic)
      : pcmNormalizationFailure(options.outputPath, "output-check", cleanup.diagnostic);
  }

  const validation = await validatePcmOutput(options.outputPath);
  if (validation.kind === "valid") {
    return {
      status: "created",
      path: options.outputPath,
      profile: PCM_NORMALIZATION_PROFILE,
      bytes: Number(validation.file.bytes),
    };
  }
  if (validation.kind === "invalid") {
    const cleanup = await removeKnownPcmFile(
      options.outputPath,
      validation.file,
      dependencies,
    );
    if (!cleanup.ok) {
      return pcmNormalizationFailure(options.outputPath, "output-check", cleanup.diagnostic);
    }
  }
  return pcmNormalizationFailure(
    options.outputPath,
    "output-check",
    validation.kind === "missing"
      ? "FFmpeg did not create the normalized PCM output."
      : validation.diagnostic,
  );
}

/** Runs ffprobe directly and validates its stdout before exposing it. */
export async function inspectMedia(
  options: InspectMediaOptions,
  dependencies: MediaProcessDependencies = defaultProcessDependencies,
): Promise<MediaProbeResult> {
  const argv = buildFfprobeArgv(options.capturePath, options.ffprobeExecutable);
  let processResult: ProcessResult;
  try {
    processResult = await dependencies.runProcess(argv, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxStdoutBytes: PROBE_STDOUT_LIMIT_BYTES,
      maxStderrBytes: TOOL_STDERR_LIMIT_BYTES,
    });
  } catch {
    return {
      ok: false,
      reason: "runner",
      diagnostic: "The ffprobe process runner failed unexpectedly.",
    };
  }

  if (!processResult.ok) {
    return {
      ok: false,
      reason: "process",
      diagnostic: processResult.diagnostic,
    };
  }
  if (processResult.stdoutTruncated) {
    return {
      ok: false,
      reason: "invalid-output",
      diagnostic: "ffprobe output exceeded Wrench media's inspection limit.",
    };
  }

  const parsed = parseFfprobeJson(processResult.stdout);
  return parsed.ok
    ? { ok: true, inspection: parsed.inspection }
    : {
        ok: false,
        reason: "invalid-output",
        diagnostic: parsed.error.message,
      };
}

/**
 * Creates the requested independent, lossless primary-stream derivatives.
 * The capture is read-only and each remux settles independently, so one failed
 * output never discards the capture or prevents the other output from finishing.
 */
export async function createMediaDerivatives(
  options: CreateMediaDerivativesOptions,
  dependencies: MediaDerivativeDependencies = defaultDerivativeDependencies,
): Promise<MediaDerivativeReport> {
  const videoPath = join(options.derivativesDirectory, "video.mkv");
  const audioPath = join(options.derivativesDirectory, "audio.mka");
  const requestedRoles = new Set(options.roles);
  const probe = await inspectMedia(
    {
      capturePath: options.capturePath,
      ...(options.ffprobeExecutable === undefined
        ? {}
        : { ffprobeExecutable: options.ffprobeExecutable }),
      ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    dependencies,
  );

  if (!probe.ok) {
    return {
      probe,
      video: requestedRoles.has("video")
        ? probeDerivativeFailure("video", videoPath, probe.diagnostic)
        : { role: "video", path: videoPath, status: "not-requested" },
      audio: requestedRoles.has("audio")
        ? probeDerivativeFailure("audio", audioPath, probe.diagnostic)
        : { role: "audio", path: audioPath, status: "not-requested" },
    };
  }

  const [video, audio] = await Promise.all([
    requestedRoles.has("video") ? settleDerivative(
      "video",
      probe.inspection.firstVideoStreamIndex,
      options.capturePath,
      videoPath,
      options.ffprobeExecutable ?? "ffprobe",
      options.ffmpegExecutable ?? "ffmpeg",
      options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      options.remuxTimeoutMs ?? DEFAULT_REMUX_TIMEOUT_MS,
      options.signal,
      dependencies,
    ) : Promise.resolve({ role: "video", path: videoPath, status: "not-requested" } as const),
    requestedRoles.has("audio") ? settleDerivative(
      "audio",
      probe.inspection.firstAudioStreamIndex,
      options.capturePath,
      audioPath,
      options.ffprobeExecutable ?? "ffprobe",
      options.ffmpegExecutable ?? "ffmpeg",
      options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      options.remuxTimeoutMs ?? DEFAULT_REMUX_TIMEOUT_MS,
      options.signal,
      dependencies,
    ) : Promise.resolve({ role: "audio", path: audioPath, status: "not-requested" } as const),
  ]);
  return { probe, video, audio };
}

async function settleDerivative(
  role: MediaDerivativeRole,
  sourceStreamIndex: number | null,
  capturePath: string,
  outputPath: string,
  ffprobeExecutable: string,
  ffmpegExecutable: string,
  probeTimeoutMs: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  dependencies: MediaDerivativeDependencies,
): Promise<MediaDerivativeResult> {
  const partPath = derivativePartPath(outputPath);
  const finalValidation = await validateDerivativePath(
    role,
    outputPath,
    ffprobeExecutable,
    probeTimeoutMs,
    signal,
    dependencies,
  );
  if (finalValidation.kind === "invalid" || finalValidation.kind === "unsafe") {
    return derivativeFailure(role, outputPath, "output-check", finalValidation.diagnostic);
  }

  const partValidation = await validateDerivativePath(
    role,
    partPath,
    ffprobeExecutable,
    probeTimeoutMs,
    signal,
    dependencies,
  );
  if (partValidation.kind === "unsafe") {
    return derivativeFailure(role, outputPath, "output-check", partValidation.diagnostic);
  }

  if (finalValidation.kind === "valid") {
    if (partValidation.kind !== "missing") {
      const cleanup = await removeKnownRegularFile(partPath, partValidation.file);
      if (!cleanup.ok) {
        return derivativeFailure(role, outputPath, "output-check", cleanup.diagnostic);
      }
    }
    if (sourceStreamIndex === null) {
      return derivativeFailure(
        role,
        outputPath,
        "output-check",
        `A ${role} derivative exists even though the capture has no ${role} stream.`,
      );
    }
    return { role, path: outputPath, status: "exists", sourceStreamIndex };
  }

  if (sourceStreamIndex === null) {
    if (partValidation.kind !== "missing") {
      const cleanup = await removeKnownRegularFile(partPath, partValidation.file);
      if (!cleanup.ok) {
        return derivativeFailure(role, outputPath, "output-check", cleanup.diagnostic);
      }
    }
    return { role, path: outputPath, status: "not-present" };
  }

  if (partValidation.kind === "valid") {
    return await publishValidatedDerivative(
      role,
      sourceStreamIndex,
      outputPath,
      partPath,
      partValidation.file,
      ffprobeExecutable,
      probeTimeoutMs,
      signal,
      dependencies,
    );
  }

  if (partValidation.kind === "invalid") {
    const cleanup = await removeKnownRegularFile(partPath, partValidation.file);
    if (!cleanup.ok) {
      return derivativeFailure(role, outputPath, "output-check", cleanup.diagnostic);
    }
  }

  const argv = buildFfmpegDerivativeArgv(
    role,
    capturePath,
    partPath,
    ffmpegExecutable,
  );
  let processResult: ProcessResult;
  try {
    processResult = await dependencies.runProcess(argv, {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs,
      maxStdoutBytes: REMUX_STDOUT_LIMIT_BYTES,
      maxStderrBytes: TOOL_STDERR_LIMIT_BYTES,
    });
  } catch {
    const cleanup = await discardFailedPartial(partPath);
    return cleanup.ok
      ? derivativeFailure(
          role,
          outputPath,
          "runner",
          `The ${role} FFmpeg process runner failed unexpectedly.`,
        )
      : derivativeFailure(role, outputPath, "output-check", cleanup.diagnostic);
  }

  if (!processResult.ok) {
    const cleanup = await discardFailedPartial(partPath);
    return cleanup.ok
      ? derivativeFailure(role, outputPath, "remux", processResult.diagnostic)
      : derivativeFailure(role, outputPath, "output-check", cleanup.diagnostic);
  }

  const generatedValidation = await validateDerivativePath(
    role,
    partPath,
    ffprobeExecutable,
    probeTimeoutMs,
    signal,
    dependencies,
  );
  if (generatedValidation.kind !== "valid") {
    if (generatedValidation.kind === "invalid") {
      const cleanup = await removeKnownRegularFile(partPath, generatedValidation.file);
      if (!cleanup.ok) {
        return derivativeFailure(role, outputPath, "output-check", cleanup.diagnostic);
      }
    }
    const diagnostic =
      generatedValidation.kind === "missing"
        ? `FFmpeg did not create the ${role} derivative partial.`
        : generatedValidation.diagnostic;
    return derivativeFailure(role, outputPath, "output-check", diagnostic);
  }

  return await publishValidatedDerivative(
    role,
    sourceStreamIndex,
    outputPath,
    partPath,
    generatedValidation.file,
    ffprobeExecutable,
    probeTimeoutMs,
    signal,
    dependencies,
  );
}

type RegularDerivativeFile = Readonly<{
  kind: "regular";
  bytes: bigint;
  device: bigint;
  inode: bigint;
}>;

type DerivativePathEntry =
  | Readonly<{ kind: "missing" }>
  | RegularDerivativeFile
  | Readonly<{
      kind: "unsafe";
      entryType: "symbolic link" | "directory" | "non-regular entry";
    }>;

type DerivativeValidation =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "valid"; file: RegularDerivativeFile }>
  | Readonly<{ kind: "invalid"; file: RegularDerivativeFile; diagnostic: string }>
  | Readonly<{ kind: "unsafe"; diagnostic: string }>;

type FileMutationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; diagnostic: string }>;

type RegularPcmFile = Readonly<{
  kind: "regular";
  bytes: bigint;
  device: bigint;
  inode: bigint;
  modifiedAtNanoseconds: bigint;
  changedAtNanoseconds: bigint;
}>;

type PcmPathEntry =
  | Readonly<{ kind: "missing" }>
  | RegularPcmFile
  | Readonly<{
      kind: "unsafe";
      entryType: "symbolic link" | "directory" | "non-regular entry";
    }>;

type PcmOutputValidation =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "valid"; file: RegularPcmFile }>
  | Readonly<{ kind: "invalid"; file: RegularPcmFile; diagnostic: string }>
  | Readonly<{ kind: "unsafe"; diagnostic: string }>;

function derivativePartPath(outputPath: string): string {
  return join(dirname(outputPath), `.${basename(outputPath)}.part`);
}

async function validateDerivativePath(
  role: MediaDerivativeRole,
  path: string,
  ffprobeExecutable: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  dependencies: MediaProcessDependencies,
): Promise<DerivativeValidation> {
  let before: DerivativePathEntry;
  try {
    before = await inspectDerivativePath(path);
  } catch {
    return {
      kind: "unsafe",
      diagnostic: `Could not safely inspect the ${role} derivative path.`,
    };
  }
  if (before.kind === "missing") return before;
  if (before.kind === "unsafe") {
    return {
      kind: "unsafe",
      diagnostic: `The ${role} derivative path is a foreign ${before.entryType}; refusing to replace it.`,
    };
  }
  if (before.bytes === 0n) {
    return {
      kind: "invalid",
      file: before,
      diagnostic: `The ${role} derivative is an empty regular file.`,
    };
  }

  const probe = await inspectMedia(
    {
      capturePath: path,
      ffprobeExecutable,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    },
    dependencies,
  );
  if (!probe.ok) {
    return {
      kind: "invalid",
      file: before,
      diagnostic: `The ${role} derivative failed ffprobe validation: ${probe.diagnostic}`,
    };
  }
  if (!hasExactPrimaryKind(probe.inspection, role)) {
    return {
      kind: "invalid",
      file: before,
      diagnostic: `The ${role} derivative must contain exactly one ${role} stream and no ${oppositeRole(role)} stream.`,
    };
  }

  let after: DerivativePathEntry;
  try {
    after = await inspectDerivativePath(path);
  } catch {
    return {
      kind: "unsafe",
      diagnostic: `Could not re-inspect the ${role} derivative after ffprobe validation.`,
    };
  }
  if (after.kind !== "regular" || !sameRegularFile(before, after)) {
    return {
      kind: "unsafe",
      diagnostic: `The ${role} derivative changed during ffprobe validation.`,
    };
  }
  return { kind: "valid", file: after };
}

async function inspectDerivativePath(path: string): Promise<DerivativePathEntry> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) return { kind: "unsafe", entryType: "symbolic link" };
    if (metadata.isDirectory()) return { kind: "unsafe", entryType: "directory" };
    if (!metadata.isFile()) return { kind: "unsafe", entryType: "non-regular entry" };
    return {
      kind: "regular",
      bytes: metadata.size,
      device: metadata.dev,
      inode: metadata.ino,
    };
  } catch (error) {
    if (isFileNotFoundError(error)) return { kind: "missing" };
    throw error;
  }
}

async function validatePcmOutput(path: string): Promise<PcmOutputValidation> {
  let before: PcmPathEntry;
  try {
    before = await inspectPcmPath(path);
  } catch {
    return { kind: "unsafe", diagnostic: "Could not safely inspect the normalized PCM output." };
  }
  if (before.kind === "missing") return before;
  if (before.kind === "unsafe") {
    return {
      kind: "unsafe",
      diagnostic: `The normalized PCM output became a foreign ${before.entryType}; refusing to trust or remove it.`,
    };
  }
  if (before.bytes <= BigInt(PCM_WAVE_HEADER_BYTES)) {
    return {
      kind: "invalid",
      file: before,
      diagnostic: "The normalized PCM output is empty or lacks audio samples.",
    };
  }
  if (before.bytes > BigInt(PCM_NORMALIZATION_MAX_BYTES)) {
    return {
      kind: "invalid",
      file: before,
      diagnostic: `The normalized PCM output exceeds the ${String(PCM_NORMALIZATION_MAX_BYTES)} byte limit.`,
    };
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return { kind: "unsafe", diagnostic: "Could not safely open the normalized PCM output without following links." };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const openedFile = pcmFileFromStats(opened);
    if (openedFile === null || !samePcmFile(before, openedFile)) {
      return { kind: "unsafe", diagnostic: "The normalized PCM output changed before validation." };
    }

    const header = new Uint8Array(PCM_WAVE_HEADER_BYTES);
    let offset = 0;
    while (offset < header.byteLength) {
      const read = await handle.read(
        header,
        offset,
        header.byteLength - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const parsed = parseNormalizedPcmWaveHeader(header.subarray(0, offset), Number(before.bytes));

    const [finished, after] = await Promise.all([
      handle.stat({ bigint: true }),
      inspectPcmPath(path),
    ]);
    const finishedFile = pcmFileFromStats(finished);
    if (
      finishedFile === null
      || after.kind !== "regular"
      || !samePcmFile(before, finishedFile)
      || !samePcmFile(before, after)
    ) {
      return { kind: "unsafe", diagnostic: "The normalized PCM output changed during validation." };
    }
    return parsed.ok
      ? { kind: "valid", file: after }
      : { kind: "invalid", file: after, diagnostic: parsed.diagnostic };
  } catch {
    return { kind: "unsafe", diagnostic: "Could not safely validate the normalized PCM output." };
  } finally {
    try {
      await handle.close();
    } catch {
      // Validation already treats the pathname and opened identity as closed
      // data. A close failure must not escape the owned result boundary.
    }
  }
}

async function inspectPcmPath(path: string): Promise<PcmPathEntry> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) return { kind: "unsafe", entryType: "symbolic link" };
    if (metadata.isDirectory()) return { kind: "unsafe", entryType: "directory" };
    const file = pcmFileFromStats(metadata);
    return file ?? { kind: "unsafe", entryType: "non-regular entry" };
  } catch (error) {
    if (isFileNotFoundError(error)) return { kind: "missing" };
    throw error;
  }
}

function pcmFileFromStats(metadata: BigIntStats): RegularPcmFile | null {
  if (!metadata.isFile()) return null;
  return {
    kind: "regular",
    bytes: metadata.size,
    device: metadata.dev,
    inode: metadata.ino,
    modifiedAtNanoseconds: metadata.mtimeNs,
    changedAtNanoseconds: metadata.ctimeNs,
  };
}

function samePcmFile(left: RegularPcmFile, right: RegularPcmFile): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.bytes === right.bytes
    && left.modifiedAtNanoseconds === right.modifiedAtNanoseconds
    && left.changedAtNanoseconds === right.changedAtNanoseconds;
}

async function discardCreatedPcmOutput(
  path: string,
  dependencies: PcmNormalizationDependencies,
): Promise<FileMutationResult> {
  let entry: PcmPathEntry;
  try {
    entry = await inspectPcmPath(path);
  } catch {
    return { ok: false, diagnostic: "Could not safely inspect failed normalized PCM output." };
  }
  if (entry.kind === "missing") return { ok: true };
  if (entry.kind === "unsafe") {
    return {
      ok: false,
      diagnostic: `Failed normalized PCM output became a foreign ${entry.entryType}; refusing to remove it.`,
    };
  }
  return await removeKnownPcmFile(path, entry, dependencies);
}

async function removeKnownPcmFile(
  path: string,
  expected: RegularPcmFile,
  dependencies: PcmNormalizationDependencies,
): Promise<FileMutationResult> {
  try {
    await dependencies.beforeCleanup?.(path);
  } catch {
    return { ok: false, diagnostic: "Could not safely prepare normalized PCM cleanup." };
  }
  let current: PcmPathEntry;
  try {
    current = await inspectPcmPath(path);
  } catch {
    return { ok: false, diagnostic: "Could not safely re-inspect normalized PCM output before cleanup." };
  }
  if (current.kind === "missing") return { ok: true };
  if (current.kind !== "regular" || !samePcmFile(current, expected)) {
    return {
      ok: false,
      diagnostic: "Normalized PCM output changed before cleanup; refusing to remove it.",
    };
  }
  try {
    await unlink(path);
    return { ok: true };
  } catch (error) {
    if (isFileNotFoundError(error)) return { ok: true };
    return { ok: false, diagnostic: "Could not safely remove failed normalized PCM output." };
  }
}

function hasExactPrimaryKind(
  inspection: MediaInspection,
  role: MediaDerivativeRole,
): boolean {
  const opposite = oppositeRole(role);
  return (
    inspection.streams.filter((stream) => stream.kind === role).length === 1 &&
    inspection.streams.every((stream) => stream.kind !== opposite)
  );
}

function oppositeRole(role: MediaDerivativeRole): MediaDerivativeRole {
  return role === "video" ? "audio" : "video";
}

function sameRegularFile(
  left: RegularDerivativeFile,
  right: RegularDerivativeFile,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.bytes === right.bytes
  );
}

async function removeKnownRegularFile(
  path: string,
  expected: RegularDerivativeFile,
): Promise<FileMutationResult> {
  let current: DerivativePathEntry;
  try {
    current = await inspectDerivativePath(path);
  } catch {
    return { ok: false, diagnostic: "Could not safely re-inspect a derivative partial." };
  }
  if (current.kind === "missing") return { ok: true };
  if (current.kind !== "regular" || !sameRegularFile(current, expected)) {
    return {
      ok: false,
      diagnostic: "A derivative partial changed before cleanup; refusing to remove it.",
    };
  }
  try {
    await unlink(path);
    return { ok: true };
  } catch (error) {
    if (isFileNotFoundError(error)) return { ok: true };
    return { ok: false, diagnostic: "Could not safely remove a derivative partial." };
  }
}

async function discardFailedPartial(partPath: string): Promise<FileMutationResult> {
  let entry: DerivativePathEntry;
  try {
    entry = await inspectDerivativePath(partPath);
  } catch {
    return { ok: false, diagnostic: "Could not safely inspect a failed derivative partial." };
  }
  if (entry.kind === "missing") return { ok: true };
  if (entry.kind === "unsafe") {
    return {
      ok: false,
      diagnostic: `A failed derivative partial became a foreign ${entry.entryType}; refusing to remove it.`,
    };
  }
  return await removeKnownRegularFile(partPath, entry);
}

async function publishValidatedDerivative(
  role: MediaDerivativeRole,
  sourceStreamIndex: number,
  outputPath: string,
  partPath: string,
  validatedPart: RegularDerivativeFile,
  ffprobeExecutable: string,
  probeTimeoutMs: number,
  signal: AbortSignal | undefined,
  dependencies: MediaProcessDependencies,
): Promise<MediaDerivativeResult> {
  try {
    await link(partPath, outputPath);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      return derivativeFailure(
        role,
        outputPath,
        "output-check",
        `Could not atomically publish the ${role} derivative without overwrite.`,
      );
    }
    const concurrent = await validateDerivativePath(
      role,
      outputPath,
      ffprobeExecutable,
      probeTimeoutMs,
      signal,
      dependencies,
    );
    if (concurrent.kind !== "valid") {
      const diagnostic =
        concurrent.kind === "missing"
          ? `The ${role} derivative disappeared during no-clobber publication.`
          : concurrent.diagnostic;
      return derivativeFailure(
        role,
        outputPath,
        "output-check",
        `Refused to clobber an existing derivative. ${diagnostic}`,
      );
    }
    const cleanup = await removeKnownRegularFile(partPath, validatedPart);
    return cleanup.ok
      ? { role, path: outputPath, status: "exists", sourceStreamIndex }
      : derivativeFailure(role, outputPath, "output-check", cleanup.diagnostic);
  }

  let published: DerivativePathEntry;
  try {
    published = await inspectDerivativePath(outputPath);
  } catch {
    return derivativeFailure(
      role,
      outputPath,
      "output-check",
      `Could not verify the atomically published ${role} derivative.`,
    );
  }
  if (published.kind !== "regular" || !sameRegularFile(published, validatedPart)) {
    return derivativeFailure(
      role,
      outputPath,
      "output-check",
      `The atomically published ${role} derivative does not match its validated partial.`,
    );
  }
  const cleanup = await removeKnownRegularFile(partPath, validatedPart);
  return cleanup.ok
    ? { role, path: outputPath, status: "created", sourceStreamIndex }
    : derivativeFailure(role, outputPath, "output-check", cleanup.diagnostic);
}

function derivativeFailure(
  role: MediaDerivativeRole,
  path: string,
  stage: "probe" | "output-check" | "remux" | "runner",
  diagnostic: string,
): MediaDerivativeResult {
  return { role, path, status: "failed", stage, diagnostic };
}

function probeDerivativeFailure(
  role: MediaDerivativeRole,
  path: string,
  diagnostic: string,
): MediaDerivativeResult {
  return { role, path, status: "failed", stage: "probe", diagnostic };
}

function pcmNormalizationFailure(
  path: string,
  stage: "preflight" | "runner" | "process" | "output-check",
  diagnostic: string,
): PcmNormalizationResult {
  return {
    status: "failed",
    path,
    profile: PCM_NORMALIZATION_PROFILE,
    stage,
    diagnostic,
  };
}

function pcmHeaderFailure(
  code: "invalid-input" | "invalid-container" | "invalid-format" | "invalid-length" | "empty-audio",
  diagnostic: string,
): NormalizedPcmWaveHeaderResult {
  return { ok: false, code, diagnostic };
}

function asciiEquals(input: Uint8Array, offset: number, expected: string): boolean {
  if (offset < 0 || offset + expected.length > input.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (input[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function parseFailure(
  code: FfprobeParseErrorCode,
  message: string,
): FfprobeParseResult {
  return { ok: false, error: { code, message } };
}

function invalidStream(position: number, detail: string): FfprobeParseResult {
  return parseFailure(
    "invalid-stream",
    `ffprobe stream at position ${String(position)} ${detail}.`,
  );
}

function streamKind(codecType: string): MediaStreamKind {
  switch (codecType) {
    case "video":
    case "audio":
    case "subtitle":
    case "data":
    case "attachment":
      return codecType;
    default:
      return "other";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFileNotFoundError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
