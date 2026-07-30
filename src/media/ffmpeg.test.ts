import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  PCM_NORMALIZATION_MAX_BYTES,
  PCM_NORMALIZATION_PROFILE,
  PCM_NORMALIZATION_TIMEOUT_MS,
  buildFfmpegDerivativeArgv,
  buildFfprobeArgv,
  buildPcmNormalizationArgv,
  createMediaDerivatives,
  inspectMedia,
  normalizeAudioForTranscription,
  parseFfprobeJson,
  parseNormalizedPcmWaveHeader,
} from "./ffmpeg";
import type {
  CommandArgv,
  ProcessFailure,
  ProcessResult,
  ProcessSuccess,
  RunProcessOptions,
} from "./process";

function success(stdout = "", stderr = ""): ProcessSuccess {
  return {
    ok: true,
    command: ["tool"],
    exitCode: 0,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    elapsedMs: 1,
  };
}

function failure(diagnostic: string): ProcessFailure {
  return {
    ok: false,
    reason: "exit",
    diagnostic,
    command: ["ffmpeg"],
    exitCode: 1,
    stdout: "",
    stderr: diagnostic,
    stdoutTruncated: false,
    stderrTruncated: false,
    elapsedMs: 1,
  };
}

function abortedFailure(diagnostic: string): ProcessFailure {
  return {
    ...failure(diagnostic),
    reason: "aborted",
    exitCode: 143,
  };
}

function normalizedPcmWave(dataBytes = 4): Uint8Array {
  if (dataBytes <= 0 || dataBytes % 2 !== 0) {
    throw new Error("test PCM data must contain a positive whole number of samples");
  }
  const output = new Uint8Array(44 + dataBytes);
  const view = new DataView(output.buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const) {
    for (let index = 0; index < text.length; index += 1) {
      output[offset + index] = text.charCodeAt(index);
    }
  }
  view.setUint32(4, output.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, dataBytes, true);
  return output;
}

const audioVideoProbeJson = JSON.stringify({
  streams: [
    { index: 0, codec_name: "vp9", codec_type: "video" },
    { index: 1, codec_name: "opus", codec_type: "audio" },
    { index: 2, codec_name: "webvtt", codec_type: "subtitle" },
    { index: 3, codec_type: "vendor-private" },
  ],
});

describe("parseFfprobeJson", () => {
  test("parses untrusted JSON into stream presence and first stream indexes", () => {
    const parsed = parseFfprobeJson(audioVideoProbeJson);

    expect(parsed).toEqual({
      ok: true,
      inspection: {
        streams: [
          { index: 0, codecName: "vp9", kind: "video" },
          { index: 1, codecName: "opus", kind: "audio" },
          { index: 2, codecName: "webvtt", kind: "subtitle" },
          { index: 3, codecName: null, kind: "other" },
        ],
        hasVideo: true,
        hasAudio: true,
        firstVideoStreamIndex: 0,
        firstAudioStreamIndex: 1,
      },
    });
  });

  test("accepts an already parsed unknown object and reports absent media kinds", () => {
    const parsed = parseFfprobeJson({
      streams: [{ index: 8, codec_name: null, codec_type: "attachment" }],
    });

    expect(parsed).toMatchObject({
      ok: true,
      inspection: {
        hasVideo: false,
        hasAudio: false,
        firstVideoStreamIndex: null,
        firstAudioStreamIndex: null,
      },
    });
  });

  test("rejects malformed envelopes and streams without asserting their shape", () => {
    expect(parseFfprobeJson("not json")).toMatchObject({
      ok: false,
      error: { code: "invalid-json" },
    });
    expect(parseFfprobeJson([])).toMatchObject({
      ok: false,
      error: { code: "invalid-root" },
    });
    expect(parseFfprobeJson({ streams: "video" })).toMatchObject({
      ok: false,
      error: { code: "invalid-streams" },
    });
    expect(parseFfprobeJson({ streams: [{ index: -1, codec_type: "video" }] })).toMatchObject({
      ok: false,
      error: { code: "invalid-stream" },
    });
    expect(parseFfprobeJson({ streams: [{ index: 0, codec_type: 7 }] })).toMatchObject({
      ok: false,
      error: { code: "invalid-stream" },
    });
  });
});

describe("parseNormalizedPcmWaveHeader", () => {
  test("accepts only Wrench media's exact nonempty 16 kHz mono signed-16-bit WAV envelope", () => {
    const wave = normalizedPcmWave(8);
    expect(parseNormalizedPcmWaveHeader(wave.subarray(0, 44), wave.byteLength)).toEqual({
      ok: true,
      dataBytes: 8,
    });
  });

  test("rejects malformed containers, formats, empty audio, and inconsistent physical lengths", () => {
    const invalidContainer = normalizedPcmWave();
    invalidContainer[0] = 0;
    expect(parseNormalizedPcmWaveHeader(invalidContainer, invalidContainer.byteLength)).toMatchObject({
      ok: false,
      code: "invalid-container",
    });

    const stereo = normalizedPcmWave();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(parseNormalizedPcmWaveHeader(stereo, stereo.byteLength)).toMatchObject({
      ok: false,
      code: "invalid-format",
    });

    const empty = normalizedPcmWave();
    new DataView(empty.buffer).setUint32(40, 0, true);
    expect(parseNormalizedPcmWaveHeader(empty, 44)).toMatchObject({
      ok: false,
      code: "empty-audio",
    });

    const inconsistent = normalizedPcmWave();
    expect(parseNormalizedPcmWaveHeader(inconsistent, inconsistent.byteLength + 2)).toMatchObject({
      ok: false,
      code: "invalid-length",
    });
    expect(parseNormalizedPcmWaveHeader("RIFF", 4)).toMatchObject({
      ok: false,
      code: "invalid-input",
    });
  });
});

describe("argv construction", () => {
  test("builds an exact ffprobe argv without a shell", () => {
    expect(buildFfprobeArgv("/archive/capture media.webm", "/tools/ffprobe")).toEqual([
      "/tools/ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name",
      "-of",
      "json",
      "/archive/capture media.webm",
    ]);
  });

  test("builds exact race-safe primary video and audio stream-copy argvs", () => {
    expect(
      buildFfmpegDerivativeArgv(
        "video",
        "/archive/capture.webm",
        "/archive/video.mkv",
        "/tools/ffmpeg",
      ),
    ).toEqual([
      "/tools/ffmpeg",
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-i",
      "/archive/capture.webm",
      "-map",
      "0:v:0",
      "-map_metadata",
      "0",
      "-map_chapters",
      "0",
      "-c",
      "copy",
      "-f",
      "matroska",
      "/archive/video.mkv",
    ]);
    expect(
      buildFfmpegDerivativeArgv(
        "audio",
        "/archive/capture.webm",
        "/archive/audio.mka",
      ),
    ).toContain("0:a:0");
  });

  test("builds the exact PCM normalization argv and keeps injection characters inert", () => {
    const inputPath = "/archive/input $(touch nope); audio.mka";
    const outputPath = "/archive/output `touch nope` & normalized.wav";
    const argv = buildPcmNormalizationArgv(inputPath, outputPath, "/tools/ffmpeg");
    expect(argv).toEqual([
      "/tools/ffmpeg",
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
      "1",
      "-ar",
      "16000",
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
    ]);
    expect(argv.filter((argument) => argument === inputPath)).toHaveLength(1);
    expect(argv.filter((argument) => argument === outputPath)).toHaveLength(1);
  });
});

describe("inspectMedia", () => {
  test("runs the exact probe argv and parses bounded stdout", async () => {
    const controller = new AbortController();
    const calls: Array<Readonly<{ argv: CommandArgv; options: RunProcessOptions }>> = [];
    const result = await inspectMedia(
      {
        capturePath: "/capture/input.webm",
        ffprobeExecutable: "/tools/ffprobe",
        timeoutMs: 1234,
        signal: controller.signal,
      },
      {
        runProcess: (argv, options) => {
          calls.push({ argv, options });
          return Promise.resolve(success(audioVideoProbeJson));
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      inspection: { hasVideo: true, hasAudio: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(
      buildFfprobeArgv("/capture/input.webm", "/tools/ffprobe"),
    );
    expect(calls[0]?.options).toMatchObject({
      timeoutMs: 1234,
      signal: controller.signal,
    });
    expect(calls[0]?.options.signal).toBe(controller.signal);
    expect("shell" in (calls[0]?.options ?? {})).toBeFalse();
  });

  test("reports truncated and malformed process output as invalid", async () => {
    const truncated: ProcessSuccess = {
      ...success(audioVideoProbeJson),
      stdoutTruncated: true,
    };
    expect(
      await inspectMedia(
        { capturePath: "/capture.webm" },
        { runProcess: () => Promise.resolve(truncated) },
      ),
    ).toMatchObject({ ok: false, reason: "invalid-output" });
    expect(
      await inspectMedia(
        { capturePath: "/capture.webm" },
        { runProcess: () => Promise.resolve(success("{}")) },
      ),
    ).toMatchObject({ ok: false, reason: "invalid-output" });
  });
});

const videoOnlyProbeJson = JSON.stringify({
  streams: [{ index: 0, codec_name: "vp9", codec_type: "video" }],
});
const audioOnlyProbeJson = JSON.stringify({
  streams: [{ index: 0, codec_name: "opus", codec_type: "audio" }],
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function mediaFixture(): Promise<Readonly<{
  root: string;
  capturePath: string;
  derivativesDirectory: string;
  videoPath: string;
  audioPath: string;
  videoPartPath: string;
  audioPartPath: string;
}>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "media-ffmpeg-test-")));
  temporaryRoots.push(root);
  const capturePath = join(root, "capture.webm");
  const derivativesDirectory = join(root, "derivatives");
  await mkdir(derivativesDirectory);
  await writeFile(capturePath, "original capture");
  const videoPath = join(derivativesDirectory, "video.mkv");
  const audioPath = join(derivativesDirectory, "audio.mka");
  return {
    root,
    capturePath,
    derivativesDirectory,
    videoPath,
    audioPath,
    videoPartPath: partPath(videoPath),
    audioPartPath: partPath(audioPath),
  };
}

function partPath(path: string): string {
  return join(dirname(path), "." + basename(path) + ".part");
}

function lastArgument(argv: CommandArgv): string {
  const value = argv[argv.length - 1];
  if (value === undefined) throw new Error("expected a command output or input path");
  return value;
}

function expectMissing(path: string): void {
  expect(lstat(path)).rejects.toThrow();
}

describe("normalizeAudioForTranscription", () => {
  test("creates and validates one bounded canonical PCM output", async () => {
    const fixture = await mediaFixture();
    const controller = new AbortController();
    const outputPath = join(fixture.root, "transcription.wav");
    const calls: Array<Readonly<{ argv: CommandArgv; options: RunProcessOptions }>> = [];
    const result = await normalizeAudioForTranscription(
      {
        inputPath: fixture.audioPath,
        outputPath,
        ffmpegExecutable: "/tools/ffmpeg",
        timeoutMs: 1_234,
        signal: controller.signal,
      },
      {
        runProcess: async (argv, options) => {
          calls.push({ argv, options });
          await writeFile(outputPath, normalizedPcmWave(8));
          return success();
        },
      },
    );

    expect(result).toEqual({
      status: "created",
      path: outputPath,
      profile: PCM_NORMALIZATION_PROFILE,
      bytes: 52,
    });
    expect(calls).toEqual([{
      argv: buildPcmNormalizationArgv(fixture.audioPath, outputPath, "/tools/ffmpeg"),
      options: {
        signal: controller.signal,
        timeoutMs: 1_234,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 1024 * 1024,
      },
    }]);
    expect("shell" in (calls[0]?.options ?? {})).toBeFalse();
    expect(calls[0]?.options.signal).toBe(controller.signal);
    expect(await readFile(outputPath)).toEqual(Buffer.from(normalizedPcmWave(8)));
  });

  test("refuses every pre-existing regular, symlink, or directory output without invoking FFmpeg", async () => {
    for (const kind of ["regular", "symlink", "directory"] as const) {
      const fixture = await mediaFixture();
      const outputPath = join(fixture.root, `preexisting-${kind}.wav`);
      if (kind === "regular") {
        await writeFile(outputPath, normalizedPcmWave());
      } else if (kind === "directory") {
        await mkdir(outputPath);
      } else {
        const target = join(fixture.root, "foreign.wav");
        await writeFile(target, normalizedPcmWave());
        await symlink(target, outputPath);
      }
      let runCount = 0;
      const result = await normalizeAudioForTranscription(
        { inputPath: fixture.capturePath, outputPath },
        {
          runProcess: () => {
            runCount += 1;
            return Promise.resolve(success());
          },
        },
      );
      expect(result).toMatchObject({ status: "failed", stage: "preflight" });
      expect(runCount).toBe(0);
      expect(await lstat(outputPath)).toBeDefined();
    }
  });

  test("returns owned runner and process failures and removes only their stable new regular outputs", async () => {
    const processFixture = await mediaFixture();
    const processOutput = join(processFixture.root, "process-failure.wav");
    const processResult = await normalizeAudioForTranscription(
      { inputPath: processFixture.capturePath, outputPath: processOutput },
      {
        runProcess: async () => {
          await writeFile(processOutput, normalizedPcmWave());
          return failure("sanitized FFmpeg failure");
        },
      },
    );
    expect(processResult).toMatchObject({
      status: "failed",
      stage: "process",
      diagnostic: "sanitized FFmpeg failure",
    });
    expectMissing(processOutput);

    const runnerFixture = await mediaFixture();
    const runnerOutput = join(runnerFixture.root, "runner-failure.wav");
    const runnerResult = await normalizeAudioForTranscription(
      { inputPath: runnerFixture.capturePath, outputPath: runnerOutput },
      {
        runProcess: async () => {
          await writeFile(runnerOutput, normalizedPcmWave());
          throw new Error("private runner detail");
        },
      },
    );
    expect(runnerResult).toMatchObject({
      status: "failed",
      stage: "runner",
      diagnostic: "The PCM normalization process runner failed unexpectedly.",
    });
    expect(runnerResult.status === "failed" ? runnerResult.diagnostic : "").not.toContain("private runner detail");
    expectMissing(runnerOutput);
  });

  test("forwards cancellation and removes an aborted process output", async () => {
    const fixture = await mediaFixture();
    const outputPath = join(fixture.root, "cancelled-normalization.wav");
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const result = await normalizeAudioForTranscription(
      {
        inputPath: fixture.capturePath,
        outputPath,
        signal: controller.signal,
      },
      {
        runProcess: async (_argv, options) => {
          observedSignal = options.signal;
          await writeFile(outputPath, normalizedPcmWave());
          return abortedFailure("PCM normalization was cancelled");
        },
      },
    );

    expect(observedSignal).toBe(controller.signal);
    expect(result).toMatchObject({
      status: "failed",
      stage: "process",
      diagnostic: "PCM normalization was cancelled",
    });
    expectMissing(outputPath);
  });

  test("rejects missing, empty, oversized, and malformed successful output and removes known regular files", async () => {
    for (const kind of ["missing", "empty", "oversized", "malformed"] as const) {
      const fixture = await mediaFixture();
      const outputPath = join(fixture.root, `${kind}.wav`);
      const result = await normalizeAudioForTranscription(
        { inputPath: fixture.capturePath, outputPath },
        {
          runProcess: async () => {
            if (kind === "empty") {
              await writeFile(outputPath, new Uint8Array());
            } else if (kind === "malformed") {
              await writeFile(outputPath, new Uint8Array(48));
            } else if (kind === "oversized") {
              const handle = await open(outputPath, "w");
              try {
                await handle.truncate(PCM_NORMALIZATION_MAX_BYTES + 1);
              } finally {
                await handle.close();
              }
            }
            return success();
          },
        },
      );
      expect(result).toMatchObject({ status: "failed", stage: "output-check" });
      expectMissing(outputPath);
    }
  });

  test("fails closed and preserves an unsafe output created during the process", async () => {
    const fixture = await mediaFixture();
    const target = join(fixture.root, "foreign-target.wav");
    const outputPath = join(fixture.root, "appeared-symlink.wav");
    await writeFile(target, normalizedPcmWave());
    const result = await normalizeAudioForTranscription(
      { inputPath: fixture.capturePath, outputPath },
      {
        runProcess: async () => {
          await symlink(target, outputPath);
          return failure("process failed");
        },
      },
    );
    expect(result).toMatchObject({ status: "failed", stage: "output-check" });
    expect((await lstat(outputPath)).isSymbolicLink()).toBeTrue();
    expect(await readFile(target)).toEqual(Buffer.from(normalizedPcmWave()));
  });

  test("refuses cleanup when a newly-created regular output changes identity", async () => {
    const fixture = await mediaFixture();
    const outputPath = join(fixture.root, "changed.wav");
    const originalPath = join(fixture.root, "our-failed-output.wav");
    const result = await normalizeAudioForTranscription(
      { inputPath: fixture.capturePath, outputPath },
      {
        runProcess: async () => {
          await writeFile(outputPath, normalizedPcmWave());
          return failure("process failed");
        },
        beforeCleanup: async () => {
          await rename(outputPath, originalPath);
          await writeFile(outputPath, "foreign replacement");
        },
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      stage: "output-check",
      diagnostic: "Normalized PCM output changed before cleanup; refusing to remove it.",
    });
    expect(await readFile(outputPath, "utf8")).toBe("foreign replacement");
    expect(await readFile(originalPath)).toEqual(Buffer.from(normalizedPcmWave()));
  });

  test("rejects unbounded timeout requests before invoking FFmpeg", async () => {
    const fixture = await mediaFixture();
    let runCount = 0;
    const result = await normalizeAudioForTranscription(
      {
        inputPath: fixture.capturePath,
        outputPath: join(fixture.root, "timeout.wav"),
        timeoutMs: PCM_NORMALIZATION_TIMEOUT_MS + 1,
      },
      {
        runProcess: () => {
          runCount += 1;
          return Promise.resolve(success());
        },
      },
    );
    expect(result).toMatchObject({ status: "failed", stage: "preflight" });
    expect(runCount).toBe(0);
  });
});

describe("createMediaDerivatives", () => {
  test("writes only same-directory partials, validates them, and publishes both derivatives", async () => {
    const fixture = await mediaFixture();
    const controller = new AbortController();
    const calls: CommandArgv[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
        ffprobeExecutable: "/tools/ffprobe",
        ffmpegExecutable: "/tools/ffmpeg",
        signal: controller.signal,
      },
      {
        runProcess: async (argv, options) => {
          calls.push(argv);
          signals.push(options.signal);
          const path = lastArgument(argv);
          if (argv[0] === "/tools/ffprobe") {
            if (path === fixture.capturePath) return success(audioVideoProbeJson);
            if (path === fixture.videoPartPath) return success(videoOnlyProbeJson);
            if (path === fixture.audioPartPath) return success(audioOnlyProbeJson);
            return failure("unexpected probe path");
          }
          await writeFile(path, argv.includes("0:v:0") ? "validated video" : "validated audio");
          return success();
        },
      },
    );

    expect(report.video).toMatchObject({ status: "created", sourceStreamIndex: 0 });
    expect(report.audio).toMatchObject({ status: "created", sourceStreamIndex: 1 });
    expect(await readFile(fixture.videoPath, "utf8")).toBe("validated video");
    expect(await readFile(fixture.audioPath, "utf8")).toBe("validated audio");
    expectMissing(fixture.videoPartPath);
    expectMissing(fixture.audioPartPath);

    const remuxOutputs = calls
      .filter((argv) => argv[0] === "/tools/ffmpeg")
      .map((argv) => lastArgument(argv))
      .sort();
    expect(remuxOutputs).toEqual(
      [fixture.audioPartPath, fixture.videoPartPath].sort(),
    );
    expect(remuxOutputs).not.toContain(fixture.videoPath);
    expect(remuxOutputs).not.toContain(fixture.audioPath);
    const probeInputs = calls
      .filter((argv) => argv[0] === "/tools/ffprobe")
      .map((argv) => lastArgument(argv));
    expect(probeInputs).toContain(fixture.videoPartPath);
    expect(probeInputs).toContain(fixture.audioPartPath);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal === controller.signal)).toBeTrue();
  });

  test("runs and publishes only explicitly requested derivative roles", async () => {
    for (const role of ["audio", "video"] as const) {
      const fixture = await mediaFixture();
      const calls: CommandArgv[] = [];
      const requestedPart = role === "audio" ? fixture.audioPartPath : fixture.videoPartPath;
      const requestedFinal = role === "audio" ? fixture.audioPath : fixture.videoPath;
      const oppositeFinal = role === "audio" ? fixture.videoPath : fixture.audioPath;
      const report = await createMediaDerivatives(
        {
          capturePath: fixture.capturePath,
          derivativesDirectory: fixture.derivativesDirectory,
          ffprobeExecutable: "/tools/ffprobe",
          ffmpegExecutable: "/tools/ffmpeg",
          roles: [role],
        },
        {
          runProcess: async (argv) => {
            calls.push(argv);
            const path = lastArgument(argv);
            if (argv[0] === "/tools/ffprobe") {
              if (path === fixture.capturePath) return success(audioVideoProbeJson);
              if (path === requestedPart) {
                return success(role === "audio" ? audioOnlyProbeJson : videoOnlyProbeJson);
              }
              return failure("unexpected probe path");
            }
            await writeFile(path, `${role} derivative`);
            return success();
          },
        },
      );

      expect(report[role]).toMatchObject({ status: "created" });
      expect(report[role === "audio" ? "video" : "audio"]).toMatchObject({
        status: "not-requested",
      });
      expect(calls.filter((argv) => argv[0] === "/tools/ffmpeg")).toHaveLength(1);
      expect(await readFile(requestedFinal, "utf8")).toBe(`${role} derivative`);
      expectMissing(oppositeFinal);
    }
  });

  test("removes a truncated stale partial and retries it through validation", async () => {
    const fixture = await mediaFixture();
    await writeFile(fixture.videoPartPath, "truncated");
    let generated = false;
    let remuxCount = 0;
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
      },
      {
        runProcess: async (argv) => {
          const path = lastArgument(argv);
          if (argv[0] === "ffprobe") {
            if (path === fixture.capturePath) return success(videoOnlyProbeJson);
            return generated ? success(videoOnlyProbeJson) : failure("truncated media");
          }
          remuxCount += 1;
          expect(path).toBe(fixture.videoPartPath);
          await writeFile(path, "repaired video");
          generated = true;
          return success();
        },
      },
    );

    expect(report.video).toMatchObject({ status: "created" });
    expect(report.audio).toMatchObject({ status: "not-present" });
    expect(remuxCount).toBe(1);
    expect(await readFile(fixture.videoPath, "utf8")).toBe("repaired video");
    expectMissing(fixture.videoPartPath);
  });

  test("resumes a complete validated partial without running FFmpeg again", async () => {
    const fixture = await mediaFixture();
    await writeFile(fixture.videoPartPath, "complete resumed video");
    const probes: string[] = [];
    let remuxCount = 0;
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
      },
      {
        runProcess: (argv) => {
          if (argv[0] === "ffmpeg") remuxCount += 1;
          probes.push(lastArgument(argv));
          return Promise.resolve(success(videoOnlyProbeJson));
        },
      },
    );

    expect(report.video).toMatchObject({ status: "created", sourceStreamIndex: 0 });
    expect(report.audio).toMatchObject({ status: "not-present" });
    expect(remuxCount).toBe(0);
    expect(probes).toContain(fixture.videoPartPath);
    expect(await readFile(fixture.videoPath, "utf8")).toBe("complete resumed video");
    expectMissing(fixture.videoPartPath);
  });

  test("validates an existing derivative and removes a safe stale partial", async () => {
    const fixture = await mediaFixture();
    await writeFile(fixture.videoPath, "existing video");
    await writeFile(fixture.videoPartPath, "stale duplicate");
    const probes: string[] = [];
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
      },
      {
        runProcess: (argv) => {
          expect(argv[0]).toBe("ffprobe");
          const path = lastArgument(argv);
          probes.push(path);
          return Promise.resolve(success(videoOnlyProbeJson));
        },
      },
    );

    expect(report.video).toMatchObject({ status: "exists", sourceStreamIndex: 0 });
    expect(probes).toContain(fixture.videoPath);
    expect(probes).toContain(fixture.videoPartPath);
    expect(await readFile(fixture.videoPath, "utf8")).toBe("existing video");
    expectMissing(fixture.videoPartPath);
  });

  test("removes a killed FFmpeg partial while allowing the other derivative to settle", async () => {
    const fixture = await mediaFixture();
    const remuxOutputs: string[] = [];
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
      },
      {
        runProcess: async (argv): Promise<ProcessResult> => {
          const path = lastArgument(argv);
          if (argv[0] === "ffprobe") {
            if (path === fixture.capturePath) return success(audioVideoProbeJson);
            return path === fixture.audioPartPath
              ? success(audioOnlyProbeJson)
              : success(videoOnlyProbeJson);
          }
          remuxOutputs.push(path);
          await writeFile(path, argv.includes("0:v:0") ? "killed partial" : "audio complete");
          return argv.includes("0:v:0") ? failure("video mux killed") : success();
        },
      },
    );

    expect(report.video).toMatchObject({
      status: "failed",
      stage: "remux",
      diagnostic: "video mux killed",
    });
    expect(report.audio).toMatchObject({ status: "created" });
    expect(remuxOutputs.sort()).toEqual(
      [fixture.audioPartPath, fixture.videoPartPath].sort(),
    );
    expect(await readFile(fixture.capturePath, "utf8")).toBe("original capture");
    expect(await readFile(fixture.audioPath, "utf8")).toBe("audio complete");
    expectMissing(fixture.videoPartPath);
  });

  test("forwards cancellation to probe and remux and removes the aborted partial", async () => {
    const fixture = await mediaFixture();
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video"],
        signal: controller.signal,
      },
      {
        runProcess: async (argv, options) => {
          signals.push(options.signal);
          const path = lastArgument(argv);
          if (argv[0] === "ffprobe") return success(videoOnlyProbeJson);
          await writeFile(path, "aborted video partial");
          return abortedFailure("video remux was cancelled");
        },
      },
    );

    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.every((signal) => signal === controller.signal)).toBeTrue();
    expect(report.video).toMatchObject({
      status: "failed",
      stage: "remux",
      diagnostic: "video remux was cancelled",
    });
    expect(report.audio).toMatchObject({ status: "not-requested" });
    expectMissing(fixture.videoPartPath);
    expectMissing(fixture.videoPath);
  });

  test("rejects and removes invalid successful FFmpeg output instead of promoting it", async () => {
    const fixture = await mediaFixture();
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
      },
      {
        runProcess: async (argv) => {
          const path = lastArgument(argv);
          if (argv[0] === "ffprobe") {
            return path === fixture.capturePath
              ? success(videoOnlyProbeJson)
              : success(audioOnlyProbeJson);
          }
          await writeFile(path, "wrong primary kind");
          return success();
        },
      },
    );

    expect(report.video).toMatchObject({ status: "failed", stage: "output-check" });
    expect(report.video.status === "failed" ? report.video.diagnostic : "").toContain(
      "exactly one video stream",
    );
    expectMissing(fixture.videoPath);
    expectMissing(fixture.videoPartPath);
  });

  test("publishes without clobbering a concurrently created final path", async () => {
    const fixture = await mediaFixture();
    let generated = false;
    let insertedConcurrentOutput = false;
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
      },
      {
        runProcess: async (argv) => {
          const path = lastArgument(argv);
          if (argv[0] === "ffmpeg") {
            await writeFile(path, "our validated video");
            generated = true;
            return success();
          }
          if (path === fixture.capturePath) return success(videoOnlyProbeJson);
          if (path === fixture.videoPartPath && generated) {
            await writeFile(fixture.videoPath, "foreign concurrent output");
            insertedConcurrentOutput = true;
            return success(videoOnlyProbeJson);
          }
          if (path === fixture.videoPath && insertedConcurrentOutput) {
            return success(audioOnlyProbeJson);
          }
          return failure("unexpected probe");
        },
      },
    );

    expect(report.video).toMatchObject({ status: "failed", stage: "output-check" });
    expect(report.video.status === "failed" ? report.video.diagnostic : "").toContain(
      "Refused to clobber",
    );
    expect(await readFile(fixture.videoPath, "utf8")).toBe("foreign concurrent output");
    expect(await readFile(fixture.videoPartPath, "utf8")).toBe("our validated video");
  });

  test("never accepts truncated, symlinked, or directory final outputs as existing", async () => {
    for (const entryType of ["truncated", "symlink", "directory"] as const) {
      const fixture = await mediaFixture();
      if (entryType === "truncated") {
        await writeFile(fixture.videoPath, "truncated final");
      } else if (entryType === "directory") {
        await mkdir(fixture.videoPath);
      } else {
        const target = join(fixture.root, "foreign-target");
        await writeFile(target, "foreign target");
        await symlink(target, fixture.videoPath);
      }
      let remuxCount = 0;
      const report = await createMediaDerivatives(
        {
          capturePath: fixture.capturePath,
          derivativesDirectory: fixture.derivativesDirectory,
          roles: ["video", "audio"],
        },
        {
          runProcess: (argv) => {
            if (argv[0] === "ffmpeg") remuxCount += 1;
            const path = lastArgument(argv);
            if (path === fixture.capturePath) {
              return Promise.resolve(success(videoOnlyProbeJson));
            }
            return Promise.resolve(failure("invalid final media"));
          },
        },
      );

      expect(report.video).toMatchObject({ status: "failed", stage: "output-check" });
      expect(report.video.status).not.toBe("exists");
      expect(remuxCount).toBe(0);
    }
  });

  test("fails closed on a foreign unsafe partial without removing it", async () => {
    const fixture = await mediaFixture();
    const target = join(fixture.root, "foreign-part-target");
    await writeFile(target, "foreign");
    await symlink(target, fixture.videoPartPath);
    let remuxCount = 0;
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
      },
      {
        runProcess: (argv) => {
          if (argv[0] === "ffmpeg") remuxCount += 1;
          return Promise.resolve(success(videoOnlyProbeJson));
        },
      },
    );

    expect(report.video).toMatchObject({ status: "failed", stage: "output-check" });
    expect(remuxCount).toBe(0);
    expect((await lstat(fixture.videoPartPath)).isSymbolicLink()).toBeTrue();
  });

  test("reports capture probe failure for both derivatives without touching outputs", async () => {
    const fixture = await mediaFixture();
    let callCount = 0;
    const report = await createMediaDerivatives(
      {
        capturePath: fixture.capturePath,
        derivativesDirectory: fixture.derivativesDirectory,
        roles: ["video", "audio"],
      },
      {
        runProcess: () => {
          callCount += 1;
          return Promise.resolve(failure("probe failed"));
        },
      },
    );

    expect(report.probe).toMatchObject({ ok: false, reason: "process" });
    expect(report.video).toMatchObject({ status: "failed", stage: "probe" });
    expect(report.audio).toMatchObject({ status: "failed", stage: "probe" });
    expect(callCount).toBe(1);
  });
});
