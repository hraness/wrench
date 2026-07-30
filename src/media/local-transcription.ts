import { chmod, lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  normalizeAudioForTranscription,
  PCM_NORMALIZATION_MAX_BYTES,
  PCM_NORMALIZATION_PROFILE,
  PCM_NORMALIZATION_TIMEOUT_MS,
  type NormalizeAudioForTranscriptionOptions,
  type PcmNormalizationResult,
} from "./ffmpeg";
import {
  createMediaArtifact,
  type ArtifactRole,
  type MediaArtifact,
  type MediaLocalTranscriptProvenance,
} from "./manifest";
import {
  reverifyReadyTranscriber,
  reverifyReadyTranscriberAfterRun,
  WHISPER_CPP_PROFILE,
  type ReadyTranscriber,
  type ReverifyReadyTranscriberOptions,
  type ReverifyReadyTranscriberResult,
} from "./transcriber-config";
import {
  parseRuntimeClosureRecord,
  RUNTIME_CLOSURE_PROFILE,
  sameRuntimeClosureRecord,
  type RuntimeClosureAttestation,
} from "./runtime-closure";
import { validateTranscriptCues, type TranscriptCue } from "./transcript";
import {
  normalizeWhisperCppLanguage,
  runWhisperCpp,
  type RunWhisperCppOptions,
  type WhisperCppResult,
} from "./whisper-cpp";

const NORMALIZED_PCM_PATH = "input.wav" as const;
const WHISPER_DIRECTORY = "whisper" as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PATH_CODE_UNITS = 4_096;

export type TranscribeAudioLocallyOptions = Readonly<{
  audioPath: string;
  audioArtifact: MediaArtifact;
  attemptDirectory: string;
  ffmpegExecutable: string;
  requestedLanguage: string;
  transcriber: ReadyTranscriber;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type LocalTranscriptionTranscript = Readonly<{
  vtt: string;
  text: string;
  json: string;
  cues: readonly TranscriptCue[];
}>;

export type LocalTranscriptionFailureStage =
  | "cancelled"
  | "preflight"
  | "normalization"
  | "hash"
  | "transcriber";

export type LocalTranscriptionResult =
  | Readonly<{
      status: "transcribed";
      language: string;
      transcript: LocalTranscriptionTranscript;
      provenance: MediaLocalTranscriptProvenance;
    }>
  | Readonly<{
      status: "no-speech";
      language: string;
      provenance: MediaLocalTranscriptProvenance;
    }>
  | Readonly<{
      status: "failed";
      stage: LocalTranscriptionFailureStage;
      diagnostic: string;
    }>;

export type LocalTranscriptionDependencies = Readonly<{
  normalizeAudioForTranscription: (
    options: NormalizeAudioForTranscriptionOptions,
  ) => Promise<PcmNormalizationResult>;
  createMediaArtifact: (
    itemRoot: string,
    path: string,
    role: ArtifactRole,
  ) => Promise<MediaArtifact>;
  runWhisperCpp: (options: RunWhisperCppOptions) => Promise<WhisperCppResult>;
  reverifyReadyTranscriber: (
    expected: ReadyTranscriber,
    options?: ReverifyReadyTranscriberOptions,
  ) => Promise<ReverifyReadyTranscriberResult>;
  reverifyReadyTranscriberAfterRun: (
    expected: ReadyTranscriber,
    observedRuntimeClosure: RuntimeClosureAttestation,
  ) => Promise<ReverifyReadyTranscriberResult>;
}>;

interface ParsedRequest {
  readonly audioPath: string;
  readonly audioArtifact: MediaArtifact & Readonly<{ role: "audio" }>;
  readonly attemptDirectory: string;
  readonly ffmpegExecutable: string;
  readonly requestedLanguage: string;
  readonly transcriber: ReadyTranscriber;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
}

interface AttemptSnapshot {
  readonly root: string;
  readonly dev: number;
  readonly ino: number;
}

const defaultDependencies: LocalTranscriptionDependencies = {
  normalizeAudioForTranscription,
  createMediaArtifact,
  runWhisperCpp,
  reverifyReadyTranscriber: async (expected, options) =>
    await reverifyReadyTranscriber(expected, undefined, options),
  reverifyReadyTranscriberAfterRun,
};

const FAILURE_DIAGNOSTICS = {
  cancelled: "The local transcription attempt was cancelled.",
  preflight: "The local transcription request or private attempt directory is invalid.",
  normalization: "Audio normalization did not produce Wrench media's canonical PCM input.",
  hash: "Wrench media could not verify the normalized PCM input.",
  transcriber: "The local whisper.cpp transcription attempt did not produce a valid result.",
} as const satisfies Readonly<Record<LocalTranscriptionFailureStage, string>>;

function failure(stage: LocalTranscriptionFailureStage): LocalTranscriptionResult {
  return { status: "failed", stage, diagnostic: FAILURE_DIAGNOSTICS[stage] };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || (point >= 0x7f && point <= 0x9f))) {
      return true;
    }
  }
  return false;
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PATH_CODE_UNITS
    && !hasControlCharacter(value)
    && isAbsolute(value)
    && resolve(value) === value;
}

function isSafeRelativeArtifactPath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PATH_CODE_UNITS
    || isAbsolute(value)
    || value.includes("\\")
  ) return false;
  return value.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\0"),
  );
}

function parseArtifact(value: unknown): (MediaArtifact & Readonly<{ role: "audio" }>) | null {
  if (!isRecord(value)) return null;
  const path = value["path"];
  const bytes = value["bytes"];
  const sha256 = value["sha256"];
  const mediaType = value["mediaType"];
  if (
    value["role"] !== "audio"
    || !isSafeRelativeArtifactPath(path)
    || typeof bytes !== "number"
    || !Number.isSafeInteger(bytes)
    || bytes <= 0
    || typeof sha256 !== "string"
    || !SHA256_PATTERN.test(sha256)
    || typeof mediaType !== "string"
    || mediaType.length === 0
    || mediaType.length > 256
  ) return null;
  return { role: "audio", path, bytes, sha256, mediaType };
}

function parseTranscriber(value: unknown): ReadyTranscriber | null {
  if (!isRecord(value)) return null;
  const descriptor = value["descriptor"];
  if (!isRecord(descriptor)) return null;
  const executablePath = value["executablePath"];
  const modelPath = value["modelPath"];
  const executableSha256 = descriptor["executableSha256"];
  const modelSha256 = descriptor["modelSha256"];
  const modelBytes = descriptor["modelBytes"];
  const runtimeSha256 = descriptor["runtimeSha256"];
  const runtimeDependencyCount = descriptor["runtimeDependencyCount"];
  const runtimeClosure = parseRuntimeClosureRecord(value["runtimeClosure"]);
  if (
    !isSafeAbsolutePath(executablePath)
    || !isSafeAbsolutePath(modelPath)
    || descriptor["adapter"] !== "whisper-cpp"
    || descriptor["profile"] !== WHISPER_CPP_PROFILE
    || typeof executableSha256 !== "string"
    || !SHA256_PATTERN.test(executableSha256)
    || typeof modelSha256 !== "string"
    || !SHA256_PATTERN.test(modelSha256)
    || typeof modelBytes !== "number"
    || !Number.isSafeInteger(modelBytes)
    || modelBytes <= 0
    || descriptor["runtimeProfile"] !== RUNTIME_CLOSURE_PROFILE
    || typeof runtimeSha256 !== "string"
    || !SHA256_PATTERN.test(runtimeSha256)
    || typeof runtimeDependencyCount !== "number"
    || !Number.isSafeInteger(runtimeDependencyCount)
    || runtimeDependencyCount < 0
    || !runtimeClosure.ok
    || runtimeClosure.record.executableSha256 !== executableSha256
    || runtimeClosure.record.closureSha256 !== runtimeSha256
    || runtimeClosure.record.dependencyCount !== runtimeDependencyCount
  ) return null;
  return {
    executablePath,
    modelPath,
    descriptor: {
      adapter: "whisper-cpp",
      profile: WHISPER_CPP_PROFILE,
      executableSha256,
      modelSha256,
      modelBytes,
      runtimeProfile: RUNTIME_CLOSURE_PROFILE,
      runtimeSha256,
      runtimeDependencyCount,
    },
    runtimeClosure: runtimeClosure.record,
  };
}

function sameReadyTranscriber(
  left: ReadyTranscriber,
  right: ReadyTranscriber,
): boolean {
  return left.executablePath === right.executablePath
    && left.modelPath === right.modelPath
    && left.descriptor.adapter === right.descriptor.adapter
    && left.descriptor.profile === right.descriptor.profile
    && left.descriptor.executableSha256 === right.descriptor.executableSha256
    && left.descriptor.modelSha256 === right.descriptor.modelSha256
    && left.descriptor.modelBytes === right.descriptor.modelBytes
    && left.descriptor.runtimeProfile === right.descriptor.runtimeProfile
    && left.descriptor.runtimeSha256 === right.descriptor.runtimeSha256
    && left.descriptor.runtimeDependencyCount === right.descriptor.runtimeDependencyCount
    && sameRuntimeClosureRecord(left.runtimeClosure, right.runtimeClosure);
}

function parseRequest(value: unknown): ParsedRequest | null {
  if (!isRecord(value)) return null;
  const audioPath = value["audioPath"];
  const attemptDirectory = value["attemptDirectory"];
  const ffmpegExecutable = value["ffmpegExecutable"];
  const requestedLanguage = normalizeWhisperCppLanguage(value["requestedLanguage"]);
  const audioArtifact = parseArtifact(value["audioArtifact"]);
  const transcriber = parseTranscriber(value["transcriber"]);
  const signal = value["signal"];
  const timeoutMs = value["timeoutMs"];
  if (
    !isSafeAbsolutePath(audioPath)
    || !isSafeAbsolutePath(attemptDirectory)
    || !isSafeAbsolutePath(ffmpegExecutable)
    || requestedLanguage === null
    || audioArtifact === null
    || transcriber === null
    || (signal !== undefined && !(signal instanceof AbortSignal))
    || (
      timeoutMs !== undefined
      && (
        typeof timeoutMs !== "number"
        || !Number.isSafeInteger(timeoutMs)
        || timeoutMs <= 0
        || timeoutMs > PCM_NORMALIZATION_TIMEOUT_MS
      )
    )
  ) return null;
  return {
    audioPath,
    audioArtifact,
    attemptDirectory,
    ffmpegExecutable,
    requestedLanguage,
    transcriber,
    signal,
    timeoutMs,
  };
}

function wasCancelled(request: ParsedRequest): boolean {
  return request.signal?.aborted === true;
}

async function readDirectoryNames(path: string, limit: number): Promise<readonly string[]> {
  const directory = await opendir(path);
  const names: string[] = [];
  try {
    for (let count = 0; count < limit; count += 1) {
      const entry = await directory.read();
      if (entry === null) break;
      names.push(entry.name);
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // A failed close must not expose host diagnostics.
    }
  }
  return names;
}

async function inspectFreshAttempt(path: string): Promise<AttemptSnapshot | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
    if (process.platform !== "win32" && (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      return null;
    }
    if (await realpath(path) !== path) return null;
    if ((await readDirectoryNames(path, 1)).length !== 0) return null;
    return { root: path, dev: metadata.dev, ino: metadata.ino };
  } catch {
    return null;
  }
}

async function createWhisperDirectory(snapshot: AttemptSnapshot): Promise<string | null> {
  const whisperDirectory = join(snapshot.root, WHISPER_DIRECTORY);
  try {
    await mkdir(whisperDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(whisperDirectory, PRIVATE_DIRECTORY_MODE);
    const [root, whisper, physicalWhisper, entries] = await Promise.all([
      lstat(snapshot.root),
      lstat(whisperDirectory),
      realpath(whisperDirectory),
      readDirectoryNames(snapshot.root, 2),
    ]);
    if (
      !root.isDirectory()
      || root.isSymbolicLink()
      || root.dev !== snapshot.dev
      || root.ino !== snapshot.ino
      || !whisper.isDirectory()
      || whisper.isSymbolicLink()
      || physicalWhisper !== whisperDirectory
      || (process.platform !== "win32" && (whisper.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)
      || entries.length !== 1
      || entries[0] !== WHISPER_DIRECTORY
    ) return null;
    return whisperDirectory;
  } catch {
    return null;
  }
}

function artifactRootForAudioPath(audioPath: string, artifactPath: string): string | null {
  const segments = artifactPath.split("/");
  let cursor = audioPath;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined || basename(cursor) !== segment) return null;
    cursor = dirname(cursor);
  }
  return cursor;
}

function sameInputArtifact(expected: MediaArtifact, observed: MediaArtifact): boolean {
  return observed.role === "audio"
    && observed.path === expected.path
    && observed.bytes === expected.bytes
    && observed.sha256 === expected.sha256;
}

function validNormalizedArtifact(
  artifact: MediaArtifact,
  normalization: Extract<PcmNormalizationResult, { readonly status: "created" }>,
): boolean {
  return artifact.role === "audio"
    && artifact.path === NORMALIZED_PCM_PATH
    && artifact.bytes === normalization.bytes
    && artifact.bytes > 0
    && artifact.bytes <= PCM_NORMALIZATION_MAX_BYTES
    && SHA256_PATTERN.test(artifact.sha256);
}

function provenance(
  request: ParsedRequest,
  transcriber: ReadyTranscriber,
  normalizedArtifact: MediaArtifact,
): MediaLocalTranscriptProvenance {
  return {
    adapter: "whisper-cpp",
    profile: transcriber.descriptor.profile,
    executableSha256: transcriber.descriptor.executableSha256,
    runtimeProfile: transcriber.descriptor.runtimeProfile,
    runtimeSha256: transcriber.descriptor.runtimeSha256,
    runtimeDependencyCount: transcriber.descriptor.runtimeDependencyCount,
    modelSha256: transcriber.descriptor.modelSha256,
    requestedLanguage: request.requestedLanguage,
    input: {
      path: request.audioArtifact.path,
      bytes: request.audioArtifact.bytes,
      sha256: request.audioArtifact.sha256,
      normalized: {
        profile: PCM_NORMALIZATION_PROFILE,
        bytes: normalizedArtifact.bytes,
        sha256: normalizedArtifact.sha256,
      },
    },
  };
}

function effectiveLanguage(detected: unknown, requested: string): string | null {
  if (detected === null) return requested === "auto" ? null : requested;
  const normalized = normalizeWhisperCppLanguage(detected);
  return normalized === null || normalized === "auto" ? null : normalized;
}

function completedResult(
  value: unknown,
  request: ParsedRequest,
  attemptProvenance: MediaLocalTranscriptProvenance,
): LocalTranscriptionResult {
  if (!isRecord(value) || value["ok"] !== true) return failure("transcriber");
  if (value["status"] === "no-speech") {
    const language = effectiveLanguage(value["language"], request.requestedLanguage);
    return language === null
      ? failure("transcriber")
      : { status: "no-speech", language, provenance: attemptProvenance };
  }
  if (value["status"] !== "transcribed") return failure("transcriber");
  const transcript = value["transcript"];
  if (!isRecord(transcript)) return failure("transcriber");
  const language = effectiveLanguage(transcript["language"], request.requestedLanguage);
  if (language === null) return failure("transcriber");
  const validated = validateTranscriptCues(transcript["cues"]);
  if (
    !validated.ok
    || transcript["vtt"] !== validated.vtt
    || transcript["text"] !== validated.text
    || transcript["json"] !== validated.json
  ) return failure("transcriber");
  return {
    status: "transcribed",
    language,
    transcript: {
      vtt: validated.vtt,
      text: validated.text,
      json: validated.json,
      cues: validated.cues,
    },
    provenance: attemptProvenance,
  };
}

/**
 * Runs one private, path-free local transcription attempt. The caller owns the
 * attempt directory and decides whether to retain or discard its contents.
 */
export async function transcribeAudioLocally(
  options: TranscribeAudioLocallyOptions,
  dependencies: LocalTranscriptionDependencies = defaultDependencies,
): Promise<LocalTranscriptionResult> {
  let request: ParsedRequest | null;
  try {
    request = parseRequest(options);
  } catch {
    return failure("preflight");
  }
  if (request === null) return failure("preflight");
  if (wasCancelled(request)) return failure("cancelled");

  const artifactRoot = artifactRootForAudioPath(
    request.audioPath,
    request.audioArtifact.path,
  );
  if (artifactRoot === null) return failure("preflight");
  const attempt = await inspectFreshAttempt(request.attemptDirectory);
  if (attempt === null) return failure("preflight");
  if (wasCancelled(request)) return failure("cancelled");

  let observedInput: MediaArtifact;
  try {
    observedInput = await dependencies.createMediaArtifact(
      artifactRoot,
      request.audioArtifact.path,
      "audio",
    );
  } catch {
    return failure("preflight");
  }
  if (wasCancelled(request)) return failure("cancelled");
  if (!sameInputArtifact(request.audioArtifact, observedInput)) return failure("preflight");

  const whisperDirectory = await createWhisperDirectory(attempt);
  if (whisperDirectory === null) return failure("preflight");
  const normalizedPath = join(attempt.root, NORMALIZED_PCM_PATH);

  let normalization: PcmNormalizationResult;
  try {
    normalization = await dependencies.normalizeAudioForTranscription({
      inputPath: request.audioPath,
      outputPath: normalizedPath,
      ffmpegExecutable: request.ffmpegExecutable,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
  } catch {
    return wasCancelled(request) ? failure("cancelled") : failure("normalization");
  }
  if (wasCancelled(request)) return failure("cancelled");
  if (
    normalization.status !== "created"
    || normalization.path !== normalizedPath
    || normalization.profile !== PCM_NORMALIZATION_PROFILE
    || !Number.isSafeInteger(normalization.bytes)
    || normalization.bytes <= 0
    || normalization.bytes > PCM_NORMALIZATION_MAX_BYTES
  ) return failure("normalization");

  let normalizedArtifact: MediaArtifact;
  try {
    normalizedArtifact = await dependencies.createMediaArtifact(
      attempt.root,
      NORMALIZED_PCM_PATH,
      "audio",
    );
  } catch {
    return failure("hash");
  }
  if (wasCancelled(request)) return failure("cancelled");
  if (!validNormalizedArtifact(normalizedArtifact, normalization)) return failure("hash");

  let preRunVerification: ReverifyReadyTranscriberResult;
  try {
    preRunVerification = await dependencies.reverifyReadyTranscriber(
      request.transcriber,
      request.signal === undefined ? {} : { signal: request.signal },
    );
  } catch {
    return wasCancelled(request) ? failure("cancelled") : failure("transcriber");
  }
  if (wasCancelled(request)) return failure("cancelled");
  if (
    preRunVerification.kind !== "ready"
    || !sameReadyTranscriber(preRunVerification.transcriber, request.transcriber)
  ) return failure("transcriber");
  const preRunTranscriber = preRunVerification.transcriber;

  let result: WhisperCppResult;
  try {
    result = await dependencies.runWhisperCpp({
      executable: preRunTranscriber.executablePath,
      modelPath: preRunTranscriber.modelPath,
      pcmPath: normalizedPath,
      requestedLanguage: request.requestedLanguage,
      workDirectory: whisperDirectory,
      runtimeClosure: preRunTranscriber.runtimeClosure,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
  } catch {
    return wasCancelled(request) ? failure("cancelled") : failure("transcriber");
  }
  if (wasCancelled(request)) return failure("cancelled");
  if (!result.ok) return failure("transcriber");

  let postRunVerification: ReverifyReadyTranscriberResult;
  try {
    postRunVerification = await dependencies.reverifyReadyTranscriberAfterRun(
      preRunTranscriber,
      result.runtimeClosure,
    );
  } catch {
    return failure("transcriber");
  }
  if (wasCancelled(request)) return failure("cancelled");
  if (
    postRunVerification.kind !== "ready"
    || !sameReadyTranscriber(postRunVerification.transcriber, preRunTranscriber)
  ) return failure("transcriber");

  const attemptProvenance = provenance(
    request,
    postRunVerification.transcriber,
    normalizedArtifact,
  );
  return completedResult(result, request, attemptProvenance);
}
