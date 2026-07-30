import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { PCM_NORMALIZATION_PROFILE } from "./ffmpeg";
import {
  transcribeAudioLocally,
  type LocalTranscriptionDependencies,
  type LocalTranscriptionResult,
  type TranscribeAudioLocallyOptions,
} from "./local-transcription";
import type { MediaArtifact } from "./manifest";
import type { ReadyTranscriber } from "./transcriber-config";
import {
  computeRuntimeClosureSha256,
  type RuntimeClosureRecord,
} from "./runtime-closure";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

const sha256Arbitrary = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
  (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
);

const inertDependencies: LocalTranscriptionDependencies = {
  normalizeAudioForTranscription: () => Promise.reject(new Error("inert normalizer")),
  createMediaArtifact: () => Promise.reject(new Error("inert artifact verifier")),
  runWhisperCpp: () => Promise.reject(new Error("inert transcriber")),
  reverifyReadyTranscriber: () => Promise.reject(new Error("inert verifier")),
  reverifyReadyTranscriberAfterRun: () => Promise.reject(new Error("inert verifier")),
};

function runtimeClosure(
  executableSha256: string,
  root = "/runtime",
  dependencySha256 = "c".repeat(64),
  dependencyCount = 0,
): RuntimeClosureRecord {
  const dependencies = Array.from({ length: dependencyCount }, (_, index) => ({
    physicalPath: join(root, `lib-${String(index)}.dylib`),
    logicalName: `lib-${String(index)}.dylib`,
    sha256: dependencySha256,
    bytes: index + 1,
  }));
  return {
    profile: "wrench-media-native-runtime-closure-v1",
    platform: "darwin",
    evidence: "dynamic-loader",
    executableSha256,
    closureSha256: computeRuntimeClosureSha256("darwin", executableSha256, dependencies),
    dependencyCount: dependencies.length,
    dependencyBytes: dependencies.reduce((total, dependency) => total + dependency.bytes, 0),
    dependencies,
  };
}

function invokeUnknown(value: unknown): Promise<LocalTranscriptionResult> {
  return transcribeAudioLocally(value as TranscribeAudioLocallyOptions, inertDependencies);
}

test("property: arbitrary request and descriptor mutations remain total", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.anything({ maxDepth: 5, maxKeys: 24 }),
      async (value) => {
        const result = await invokeUnknown(value);

        expect(["transcribed", "no-speech", "failed"]).toContain(result.status);
        if (result.status === "failed") {
          expect(["cancelled", "preflight", "normalization", "hash", "transcriber"]).toContain(result.stage);
          expect(result.diagnostic.length).toBeGreaterThan(0);
        }
      },
    ),
    { numRuns: 300 },
  );
});

interface PropertyAttemptInput {
  readonly executableSha256: string;
  readonly modelSha256: string;
  readonly runtimeDependencySha256: string;
  readonly runtimeDependencyCount: number;
  readonly inputSha256: string;
  readonly normalizedSha256: string;
  readonly inputBytes: number;
  readonly normalizedBytes: number;
  readonly requestedLanguage: "en" | "fr";
}

function changedSha256(value: string): string {
  return `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;
}

function changedLanguage(value: "en" | "fr"): "en" | "fr" {
  return value === "en" ? "fr" : "en";
}

async function runPropertyAttempt(
  root: string,
  sequence: number,
  input: PropertyAttemptInput,
): Promise<Exclude<LocalTranscriptionResult, { readonly status: "failed" }>> {
  const artifact: MediaArtifact = {
    role: "audio",
    path: "data/audio.mka",
    bytes: input.inputBytes,
    sha256: input.inputSha256,
    mediaType: "audio/x-matroska",
  };
  const normalizedArtifact: MediaArtifact = {
    role: "audio",
    path: "input.wav",
    bytes: input.normalizedBytes,
    sha256: input.normalizedSha256,
    mediaType: "audio/wav",
  };
  const closure = runtimeClosure(
    input.executableSha256,
    root,
    input.runtimeDependencySha256,
    input.runtimeDependencyCount,
  );
  const transcriber: ReadyTranscriber = {
    executablePath: join(root, "whisper-cli"),
    modelPath: join(root, "model.bin"),
    descriptor: {
      adapter: "whisper-cpp",
      profile: "wrench-media-whisper-cpp-v1",
      executableSha256: input.executableSha256,
      modelSha256: input.modelSha256,
      modelBytes: 1,
      runtimeProfile: closure.profile,
      runtimeSha256: closure.closureSha256,
      runtimeDependencyCount: closure.dependencyCount,
    },
    runtimeClosure: closure,
  };
  const attemptDirectory = join(root, `attempt-${String(sequence)}`);
  await mkdir(attemptDirectory, { mode: 0o700 });
  await chmod(attemptDirectory, 0o700);
  const dependencies: LocalTranscriptionDependencies = {
    normalizeAudioForTranscription: (options) => Promise.resolve({
      status: "created",
      path: options.outputPath,
      profile: PCM_NORMALIZATION_PROFILE,
      bytes: input.normalizedBytes,
    }),
    createMediaArtifact: (_itemRoot, path) => Promise.resolve(
      path === "input.wav" ? normalizedArtifact : artifact,
    ),
    runWhisperCpp: () => Promise.resolve({
      ok: true,
      status: "no-speech",
      language: "de",
      runtimeClosure: closure,
    }),
    reverifyReadyTranscriber: (expected) => Promise.resolve({
      kind: "ready",
      transcriber: expected,
    }),
    reverifyReadyTranscriberAfterRun: (expected) => Promise.resolve({
      kind: "ready",
      transcriber: expected,
    }),
  };
  const result = await transcribeAudioLocally(
    {
      audioPath: join(root, "item", "data", "audio.mka"),
      audioArtifact: artifact,
      attemptDirectory,
      ffmpegExecutable: join(root, "ffmpeg"),
      requestedLanguage: input.requestedLanguage,
      transcriber,
    },
    dependencies,
  );
  if (result.status === "failed") throw new Error(`Valid property fixture failed at ${result.stage}.`);
  return result;
}

test("property: descriptor, runtime, input, and language identities are provenance-sensitive", async () => {
  const requestedRoot = await mkdtemp(join(tmpdir(), "media-local-provenance-property-"));
  temporaryRoots.push(requestedRoot);
  const root = await realpath(requestedRoot);
  let sequence = 0;
  await fc.assert(
    fc.asyncProperty(
      sha256Arbitrary,
      sha256Arbitrary,
      sha256Arbitrary,
      fc.integer({ min: 1, max: 2 }),
      sha256Arbitrary,
      sha256Arbitrary,
      fc.integer({ min: 1, max: 1024 * 1024 }),
      fc.integer({ min: 1, max: 1024 * 1024 }),
      fc.constantFrom("en", "fr"),
      async (
        executableSha256,
        modelSha256,
        runtimeDependencySha256,
        runtimeDependencyCount,
        inputSha256,
        normalizedSha256,
        inputBytes,
        normalizedBytes,
        requestedLanguage,
      ) => {
        const base: PropertyAttemptInput = {
          executableSha256,
          modelSha256,
          runtimeDependencySha256,
          runtimeDependencyCount,
          inputSha256,
          normalizedSha256,
          inputBytes,
          normalizedBytes,
          requestedLanguage,
        };
        const initial = await runPropertyAttempt(root, sequence += 1, base);
        const descriptorMutation = await runPropertyAttempt(root, sequence += 1, {
          ...base,
          executableSha256: changedSha256(executableSha256),
        });
        const languageMutation = await runPropertyAttempt(root, sequence += 1, {
          ...base,
          requestedLanguage: changedLanguage(requestedLanguage),
        });
        const runtimeHashMutation = await runPropertyAttempt(root, sequence += 1, {
          ...base,
          runtimeDependencySha256: changedSha256(runtimeDependencySha256),
        });
        const runtimeCountMutation = await runPropertyAttempt(root, sequence += 1, {
          ...base,
          runtimeDependencyCount: runtimeDependencyCount === 1 ? 2 : 1,
        });

        expect(initial.provenance).toMatchObject({
          executableSha256,
          modelSha256,
          runtimeDependencyCount,
          requestedLanguage,
          input: {
            bytes: inputBytes,
            sha256: inputSha256,
            normalized: { bytes: normalizedBytes, sha256: normalizedSha256 },
          },
        });
        expect(descriptorMutation.provenance).not.toEqual(initial.provenance);
        expect(runtimeHashMutation.provenance).not.toEqual(initial.provenance);
        expect(runtimeCountMutation.provenance).not.toEqual(initial.provenance);
        expect(languageMutation.provenance).not.toEqual(initial.provenance);
        for (const result of [
          initial,
          descriptorMutation,
          runtimeHashMutation,
          runtimeCountMutation,
          languageMutation,
        ]) {
          expect(JSON.stringify(result)).not.toContain(root);
        }
      },
    ),
    {
      interruptAfterTimeLimit: 20_000,
      markInterruptAsFailure: true,
      numRuns: 60,
    },
  );
});
