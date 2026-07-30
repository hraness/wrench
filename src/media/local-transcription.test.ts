import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPcmNormalizationArgv,
  PCM_NORMALIZATION_PROFILE,
  type NormalizeAudioForTranscriptionOptions,
} from "./ffmpeg";
import {
  transcribeAudioLocally,
  type LocalTranscriptionDependencies,
  type TranscribeAudioLocallyOptions,
} from "./local-transcription";
import { createMediaArtifact, type MediaArtifact } from "./manifest";
import type { ReadyTranscriber } from "./transcriber-config";
import {
  computeRuntimeClosureSha256,
  sameRuntimeClosureRecord,
  type RuntimeClosureRecord,
} from "./runtime-closure";
import { validateTranscriptCues } from "./transcript";
import {
  buildWhisperCppArgv,
  type RunWhisperCppOptions,
  type WhisperCppResult,
} from "./whisper-cpp";

const NORMALIZED_BYTES = new TextEncoder().encode("canonical-normalized-pcm");
const EXECUTABLE_SHA256 = "a".repeat(64);
const MODEL_SHA256 = "b".repeat(64);

function runtimeClosure(
  executableSha256 = EXECUTABLE_SHA256,
): RuntimeClosureRecord {
  return {
    profile: "wrench-media-native-runtime-closure-v1",
    platform: "darwin",
    evidence: "dynamic-loader",
    executableSha256,
    closureSha256: computeRuntimeClosureSha256("darwin", executableSha256, []),
    dependencyCount: 0,
    dependencyBytes: 0,
    dependencies: [],
  };
}

interface Fixture {
  readonly root: string;
  readonly itemRoot: string;
  readonly audioPath: string;
  readonly audioArtifact: MediaArtifact;
  readonly attemptDirectory: string;
  readonly ffmpegExecutable: string;
  readonly transcriber: ReadyTranscriber;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(
  names: Readonly<{
    audio?: string;
    attempt?: string;
    ffmpeg?: string;
    whisper?: string;
    model?: string;
  }> = {},
): Promise<Fixture> {
  const requestedRoot = await mkdtemp(join(tmpdir(), "media-local-transcription-"));
  temporaryRoots.push(requestedRoot);
  const root = await realpath(requestedRoot);
  const itemRoot = join(root, "item");
  const dataDirectory = join(itemRoot, "data");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const audioName = names.audio ?? "audio.mka";
  const audioPath = join(dataDirectory, audioName);
  await writeFile(audioPath, "source-audio-contents");
  const audioArtifact = await createMediaArtifact(itemRoot, `data/${audioName}`, "audio");
  const attemptDirectory = join(root, names.attempt ?? "attempt");
  await mkdir(attemptDirectory, { mode: 0o700 });
  await chmod(attemptDirectory, 0o700);
  const closure = runtimeClosure();
  return {
    root,
    itemRoot,
    audioPath,
    audioArtifact,
    attemptDirectory,
    ffmpegExecutable: join(root, names.ffmpeg ?? "ffmpeg"),
    transcriber: {
      executablePath: join(root, names.whisper ?? "whisper-cli"),
      modelPath: join(root, names.model ?? "model.bin"),
      descriptor: {
        adapter: "whisper-cpp",
        profile: "wrench-media-whisper-cpp-v1",
        executableSha256: EXECUTABLE_SHA256,
        modelSha256: MODEL_SHA256,
        modelBytes: 1_024,
        runtimeProfile: closure.profile,
        runtimeSha256: closure.closureSha256,
        runtimeDependencyCount: closure.dependencyCount,
      },
      runtimeClosure: closure,
    },
  };
}

function request(
  item: Fixture,
  overrides: Partial<TranscribeAudioLocallyOptions> = {},
): TranscribeAudioLocallyOptions {
  return {
    audioPath: item.audioPath,
    audioArtifact: item.audioArtifact,
    attemptDirectory: item.attemptDirectory,
    ffmpegExecutable: item.ffmpegExecutable,
    requestedLanguage: "en",
    transcriber: item.transcriber,
    ...overrides,
  };
}

function canonicalTranscription(
  language: string | null,
  closure: RuntimeClosureRecord = runtimeClosure(),
): WhisperCppResult {
  const validated = validateTranscriptCues([
    { startMs: 0, endMs: 1_250, text: "A local transcript." },
  ]);
  if (!validated.ok) throw new Error("Canonical transcript fixture is invalid.");
  return {
    ok: true,
    status: "transcribed",
    transcript: {
      language,
      cues: validated.cues,
      vtt: validated.vtt,
      text: validated.text,
      json: validated.json,
    },
    runtimeClosure: closure,
  };
}

function successfulDependencies(
  result: WhisperCppResult,
  observers: Readonly<{
    normalize?: (options: NormalizeAudioForTranscriptionOptions) => void;
    transcribe?: (options: RunWhisperCppOptions) => void;
  }> = {},
): LocalTranscriptionDependencies {
  return {
    normalizeAudioForTranscription: async (options) => {
      observers.normalize?.(options);
      await writeFile(options.outputPath, NORMALIZED_BYTES, { flag: "wx" });
      return {
        status: "created",
        path: options.outputPath,
        profile: PCM_NORMALIZATION_PROFILE,
        bytes: NORMALIZED_BYTES.byteLength,
      };
    },
    createMediaArtifact: (root, path, role) => createMediaArtifact(root, path, role),
    runWhisperCpp: (options) => {
      observers.transcribe?.(options);
      return Promise.resolve(result);
    },
    reverifyReadyTranscriber: (expected) => Promise.resolve({
      kind: "ready",
      transcriber: expected,
    }),
    reverifyReadyTranscriberAfterRun: (expected, observedRuntimeClosure) => (
      sameRuntimeClosureRecord(expected.runtimeClosure, observedRuntimeClosure)
        ? Promise.resolve({ kind: "ready", transcriber: expected })
        : Promise.resolve({
            kind: "invalid",
            reason: "runtime-closure-mismatch",
            message: "runtime closure changed",
          })
    ),
  };
}

function normalizedSha256(): string {
  return createHash("sha256").update(NORMALIZED_BYTES).digest("hex");
}

describe("transcribeAudioLocally", () => {
  test("stops before work when cancelled and forwards one signal through long-running stages", async () => {
    const cancelledItem = await fixture();
    const cancelledController = new AbortController();
    cancelledController.abort();
    let cancelledCalls = 0;
    const cancelledDependencies = successfulDependencies(canonicalTranscription("en"), {
      normalize: () => { cancelledCalls += 1; },
      transcribe: () => { cancelledCalls += 1; },
    });
    expect(await transcribeAudioLocally(
      request(cancelledItem, { signal: cancelledController.signal }),
      cancelledDependencies,
    )).toMatchObject({ status: "failed", stage: "cancelled" });
    expect(cancelledCalls).toBe(0);

    const item = await fixture();
    const controller = new AbortController();
    let reverifySignal: AbortSignal | undefined;
    const base = successfulDependencies(canonicalTranscription("en"), {
      normalize: (options) => expect(options.signal).toBe(controller.signal),
      transcribe: (options) => expect(options.signal).toBe(controller.signal),
    });
    const result = await transcribeAudioLocally(
      request(item, { signal: controller.signal }),
      {
        ...base,
        reverifyReadyTranscriber: (expected, options) => {
          reverifySignal = options?.signal;
          return Promise.resolve({ kind: "ready", transcriber: expected });
        },
      },
    );
    expect(result.status).toBe("transcribed");
    expect(reverifySignal).toBe(controller.signal);
  });

  test("returns a canonical transcript and path-free provenance", async () => {
    const item = await fixture();
    const result = await transcribeAudioLocally(
      request(item, { requestedLanguage: "auto" }),
      successfulDependencies(canonicalTranscription("fr")),
    );

    expect(result).toMatchObject({
      status: "transcribed",
      language: "fr",
      provenance: {
        adapter: "whisper-cpp",
        profile: "wrench-media-whisper-cpp-v1",
        executableSha256: EXECUTABLE_SHA256,
        runtimeProfile: "wrench-media-native-runtime-closure-v1",
        runtimeSha256: item.transcriber.runtimeClosure.closureSha256,
        runtimeDependencyCount: 0,
        modelSha256: MODEL_SHA256,
        requestedLanguage: "auto",
        input: {
          path: item.audioArtifact.path,
          bytes: item.audioArtifact.bytes,
          sha256: item.audioArtifact.sha256,
          normalized: {
            profile: PCM_NORMALIZATION_PROFILE,
            bytes: NORMALIZED_BYTES.byteLength,
            sha256: normalizedSha256(),
          },
        },
      },
    });
    if (result.status !== "transcribed") throw new Error("Expected a transcript.");
    expect(result.transcript.text).toBe("A local transcript.\n");
    expect(await readFile(join(item.attemptDirectory, "input.wav"))).toEqual(
      Buffer.from(NORMALIZED_BYTES),
    );
    expect((await lstat(join(item.attemptDirectory, "whisper"))).isDirectory()).toBeTrue();

    const persisted = JSON.stringify(result);
    for (const localPath of [
      item.root,
      item.audioPath,
      item.attemptDirectory,
      item.ffmpegExecutable,
      item.transcriber.executablePath,
      item.transcriber.modelPath,
    ]) expect(persisted).not.toContain(localPath);
  });

  test("reverifies after normalization and again after the attested inference", async () => {
    const item = await fixture();
    const events: string[] = [];
    const base = successfulDependencies(
      canonicalTranscription("en", item.transcriber.runtimeClosure),
      {
        normalize: () => events.push("normalize"),
        transcribe: (options) => {
          events.push("transcribe");
          expect(sameRuntimeClosureRecord(
            options.runtimeClosure,
            item.transcriber.runtimeClosure,
          )).toBeTrue();
        },
      },
    );
    const dependencies: LocalTranscriptionDependencies = {
      ...base,
      reverifyReadyTranscriber: (expected) => {
        events.push("pre-run-reverify");
        return Promise.resolve({ kind: "ready", transcriber: expected });
      },
      reverifyReadyTranscriberAfterRun: (expected, observedRuntimeClosure) => {
        events.push("post-run-reverify");
        expect(sameRuntimeClosureRecord(
          observedRuntimeClosure,
          item.transcriber.runtimeClosure,
        )).toBeTrue();
        return Promise.resolve({ kind: "ready", transcriber: expected });
      },
    };

    expect(await transcribeAudioLocally(request(item), dependencies)).toMatchObject({
      status: "transcribed",
    });
    expect(events).toEqual([
      "normalize",
      "pre-run-reverify",
      "transcribe",
      "post-run-reverify",
    ]);

    const postFailureItem = await fixture();
    const postFailureDependencies = successfulDependencies(
      canonicalTranscription("en", postFailureItem.transcriber.runtimeClosure),
    );
    expect(await transcribeAudioLocally(request(postFailureItem), {
      ...postFailureDependencies,
      reverifyReadyTranscriberAfterRun: () => Promise.resolve({
        kind: "invalid",
        reason: "model-hash-mismatch",
        message: "private model changed",
      }),
    })).toMatchObject({ status: "failed", stage: "transcriber" });

    const preFailureItem = await fixture();
    let transcriberCalled = false;
    const preFailureDependencies = successfulDependencies(
      canonicalTranscription("en", preFailureItem.transcriber.runtimeClosure),
      { transcribe: () => { transcriberCalled = true; } },
    );
    expect(await transcribeAudioLocally(request(preFailureItem), {
      ...preFailureDependencies,
      reverifyReadyTranscriber: () => Promise.resolve({
        kind: "invalid",
        reason: "runtime-closure-mismatch",
        message: "private runtime changed",
      }),
    })).toMatchObject({ status: "failed", stage: "transcriber" });
    expect(transcriberCalled).toBeFalse();
  });

  test("uses the requested language when no-speech has no detected language", async () => {
    const item = await fixture();
    const result = await transcribeAudioLocally(
      request(item, { requestedLanguage: "PT-BR" }),
      successfulDependencies({
        ok: true,
        status: "no-speech",
        language: null,
        runtimeClosure: item.transcriber.runtimeClosure,
      }),
    );

    expect(result).toMatchObject({
      status: "no-speech",
      language: "pt-br",
      provenance: { requestedLanguage: "pt-br" },
    });
  });

  test("fails preflight for a foreign artifact, mismatched hash, or nonfresh attempt", async () => {
    const item = await fixture();
    let calls = 0;
    const dependencies = successfulDependencies(canonicalTranscription("en"), {
      normalize: () => { calls += 1; },
      transcribe: () => { calls += 1; },
    });
    const foreignArtifact = { ...item.audioArtifact, role: "capture" as const };
    expect(await transcribeAudioLocally(
      request(item, { audioArtifact: foreignArtifact }),
      dependencies,
    )).toMatchObject({ status: "failed", stage: "preflight" });
    expect(await transcribeAudioLocally(
      request(item, { audioArtifact: { ...item.audioArtifact, sha256: "f".repeat(64) } }),
      dependencies,
    )).toMatchObject({ status: "failed", stage: "preflight" });

    await writeFile(join(item.attemptDirectory, "foreign-entry"), "do not replace");
    expect(await transcribeAudioLocally(request(item), dependencies)).toMatchObject({
      status: "failed",
      stage: "preflight",
    });
    expect(calls).toBe(0);
  });

  test("rejects a symlink attempt directory without touching its target", async () => {
    const item = await fixture();
    const target = join(item.root, "target-attempt");
    const linked = join(item.root, "linked-attempt");
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o700);
    await symlink(target, linked);

    const result = await transcribeAudioLocally(
      request(item, { attemptDirectory: linked }),
      successfulDependencies(canonicalTranscription("en")),
    );

    expect(result).toMatchObject({ status: "failed", stage: "preflight" });
    expect((await lstat(target)).isDirectory()).toBeTrue();
  });

  test("owns normalization failures without exposing diagnostics or deleting the attempt", async () => {
    const item = await fixture();
    const dependencies = successfulDependencies(canonicalTranscription("en"));
    const failing: LocalTranscriptionDependencies = {
      ...dependencies,
      normalizeAudioForTranscription: (options) => Promise.resolve({
        status: "failed",
        path: options.outputPath,
        profile: PCM_NORMALIZATION_PROFILE,
        stage: "process",
        diagnostic: `raw stderr secret at ${item.audioPath}`,
      }),
    };

    const result = await transcribeAudioLocally(request(item), failing);

    expect(result).toMatchObject({ status: "failed", stage: "normalization" });
    if (result.status !== "failed") throw new Error("Expected normalization failure.");
    expect(result.diagnostic).not.toContain("raw stderr secret");
    expect(result.diagnostic).not.toContain(item.audioPath);
    expect((await lstat(item.attemptDirectory)).isDirectory()).toBeTrue();
    expect((await lstat(join(item.attemptDirectory, "whisper"))).isDirectory()).toBeTrue();
  });

  test("fails at hashing when the normalizer's byte claim differs from the physical PCM", async () => {
    const item = await fixture();
    const dependencies = successfulDependencies(canonicalTranscription("en"));
    const mismatched: LocalTranscriptionDependencies = {
      ...dependencies,
      normalizeAudioForTranscription: async (options) => {
        await writeFile(options.outputPath, NORMALIZED_BYTES, { flag: "wx" });
        return {
          status: "created",
          path: options.outputPath,
          profile: PCM_NORMALIZATION_PROFILE,
          bytes: NORMALIZED_BYTES.byteLength + 1,
        };
      },
    };

    expect(await transcribeAudioLocally(request(item), mismatched)).toMatchObject({
      status: "failed",
      stage: "hash",
    });
  });

  test("owns transcriber errors and rejects auto when no language was detected", async () => {
    const failedItem = await fixture();
    const rawFailure: WhisperCppResult = {
      ok: false,
      status: "error",
      error: { code: "process", message: `secret stderr ${failedItem.audioPath}` },
    };
    const failed = await transcribeAudioLocally(
      request(failedItem),
      successfulDependencies(rawFailure),
    );
    expect(failed).toMatchObject({ status: "failed", stage: "transcriber" });
    if (failed.status !== "failed") throw new Error("Expected transcriber failure.");
    expect(failed.diagnostic).not.toContain("secret stderr");
    expect(failed.diagnostic).not.toContain(failedItem.audioPath);

    const autoItem = await fixture();
    expect(await transcribeAudioLocally(
      request(autoItem, { requestedLanguage: "auto" }),
      successfulDependencies({
        ok: true,
        status: "no-speech",
        language: null,
        runtimeClosure: autoItem.transcriber.runtimeClosure,
      }),
    )).toMatchObject({ status: "failed", stage: "transcriber" });
  });

  test("keeps shell-shaped paths as distinct argv values", async () => {
    const item = await fixture({
      audio: "audio `touch nope` & source.mka",
      attempt: "attempt $(touch nope) ;",
      ffmpeg: "ffmpeg `touch nope`",
      whisper: "whisper ; touch nope",
      model: "model $(touch nope).bin",
    });
    let normalizationArgv: readonly string[] = [];
    let whisperArgv: readonly string[] = [];
    const dependencies = successfulDependencies(
      {
        ok: true,
        status: "no-speech",
        language: "en",
        runtimeClosure: item.transcriber.runtimeClosure,
      },
      {
        normalize: (options) => {
          normalizationArgv = buildPcmNormalizationArgv(
            options.inputPath,
            options.outputPath,
            options.ffmpegExecutable,
          );
        },
        transcribe: (options) => {
          whisperArgv = buildWhisperCppArgv({
            executable: options.executable,
            modelPath: options.modelPath,
            pcmPath: options.pcmPath,
            requestedLanguage: options.requestedLanguage,
            outputPrefix: join(options.workDirectory, "transcript"),
          });
        },
      },
    );

    const result = await transcribeAudioLocally(request(item), dependencies);

    expect(result.status).toBe("no-speech");
    expect(normalizationArgv[0]).toBe(item.ffmpegExecutable);
    expect(normalizationArgv).toContain(item.audioPath);
    expect(whisperArgv[0]).toBe(item.transcriber.executablePath);
    expect(whisperArgv).toContain(item.transcriber.modelPath);
    expect(whisperArgv).toContain(join(item.attemptDirectory, "input.wav"));
    expect(normalizationArgv).not.toContain("sh");
    expect(whisperArgv).not.toContain("sh");
  });
});
