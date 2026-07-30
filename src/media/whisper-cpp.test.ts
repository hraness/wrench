import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWhisperCppArgv,
  parseWhisperCppOutputs,
  runWhisperCpp,
  whisperCppLanguageArgument,
  WHISPER_CPP_NORMALIZATION_PROFILE,
  WHISPER_CPP_PROFILE,
} from "./whisper-cpp";
import type { ProcessSuccess } from "./process";
import {
  computeRuntimeClosureSha256,
  type AttestedRuntimeProcessResult,
  type AttestRuntimeClosureOptions,
  type RuntimeClosureRecord,
} from "./runtime-closure";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wrench-media-whisper-cpp-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

const EXECUTABLE_SHA256 = "a".repeat(64);

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

function processSuccess(): ProcessSuccess {
  return {
    ok: true,
    command: ["whisper-cli"],
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    elapsedMs: 1,
  };
}

function attestedSuccess(
  attestation: RuntimeClosureRecord = runtimeClosure(),
  process: ProcessSuccess = processSuccess(),
): AttestedRuntimeProcessResult {
  return { process, attestation };
}

function argvFromAttestationOptions(options: AttestRuntimeClosureOptions): readonly string[] {
  return [options.executablePath, ...(options.probeArguments ?? ["--help"])];
}

function validVtt(text = "Hello world"): string {
  return `WEBVTT\n\n00:00.000 --> 00:01.000\n${text}\n`;
}

function validJson(
  text = "Hello world",
  language = "en",
  startMs = 0,
  endMs = 1_000,
): string {
  return JSON.stringify({
    params: { language },
    result: { language },
    transcription: [{ offsets: { from: startMs, to: endMs }, text, tokens: [] }],
  });
}

function noSpeechJson(language = "en"): string {
  return JSON.stringify({
    params: { language },
    result: { language },
    transcription: [],
  });
}

describe("whisper.cpp argv", () => {
  test("pins Wrench media's tool and PCM profiles", () => {
    expect(WHISPER_CPP_PROFILE).toBe("wrench-media-whisper-cpp-v1");
    expect(WHISPER_CPP_NORMALIZATION_PROFILE).toBe("pcm-s16le-16000hz-mono-v1");
  });

  test("constructs a direct argv, preserving dangerous paths as one argument", () => {
    const argv = buildWhisperCppArgv({
      executable: "/tools/whisper-cli",
      modelPath: "/models/one;touch SHOULD_NOT_RUN.bin",
      pcmPath: "/attempt/audio $(bad).wav",
      requestedLanguage: "en-US",
      outputPrefix: "/attempt/transcript",
    });
    expect(argv).toEqual([
      "/tools/whisper-cli",
      "--model", "/models/one;touch SHOULD_NOT_RUN.bin",
      "--file", "/attempt/audio $(bad).wav",
      "--language", "en",
      "--threads", "4",
      "--processors", "1",
      "--no-gpu",
      "--output-vtt",
      "--output-json-full",
      "--output-file", "/attempt/transcript",
      "--no-prints",
    ]);
  });

  test("projects regional requests onto whisper.cpp's short language identifiers", () => {
    expect(whisperCppLanguageArgument("PT-BR")).toBe("pt");
    expect(whisperCppLanguageArgument("zh-Hans-CN")).toBe("zh");
    expect(whisperCppLanguageArgument("jv-ID")).toBe("jw");
    expect(whisperCppLanguageArgument("fil-PH")).toBe("tl");
    expect(whisperCppLanguageArgument("auto")).toBe("auto");
  });

  test("rejects language injection and nonliteral tool grammar", () => {
    for (const language of ["", "en --output-file /tmp/x", "en\u0000fr", "all", "../en", "en_US", "xx-US"]) {
      expect(() => buildWhisperCppArgv({
        executable: "whisper-cli",
        modelPath: "/model.bin",
        pcmPath: "/audio.wav",
        requestedLanguage: language,
        outputPrefix: "/out/transcript",
      })).toThrow("literal BCP-47-style tag");
    }
  });
});

describe("whisper.cpp output parsing", () => {
  test("returns canonical transcript derivatives and recognizes documented JSON envelopes", () => {
    const result = parseWhisperCppOutputs(
      validVtt("Hello <i>world</i>"),
      validJson(" Hello world"),
      "en-US",
    );
    expect(result).toEqual({
      ok: true,
      status: "transcribed",
      transcript: {
        language: "en",
        cues: [{ startMs: 0, endMs: 1_000, text: "Hello world" }],
        vtt: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHello world\n",
        text: "Hello world\n",
        json: '{\n  "version": 1,\n  "cues": [\n    {\n      "startMs": 0,\n      "endMs": 1000,\n      "text": "Hello world"\n    }\n  ]\n}\n',
      },
    });
  });

  test("recognizes a valid no-speech result without representing it as a transcript", () => {
    expect(parseWhisperCppOutputs("WEBVTT\n\n", noSpeechJson(), "auto")).toEqual({
      ok: true,
      status: "no-speech",
      language: "en",
    });
  });

  test("matches detected canonical codes to accepted requested aliases", () => {
    expect(parseWhisperCppOutputs(validVtt(), validJson("Hello world", "he"), "iw-IL")).toMatchObject({
      ok: true,
      status: "transcribed",
      transcript: { language: "he" },
    });
    expect(parseWhisperCppOutputs(validVtt(), validJson("Hello world", "jw"), "jv-ID")).toMatchObject({
      ok: true,
      status: "transcribed",
      transcript: { language: "jw" },
    });
  });

  test("rejects malformed JSON, malformed VTT, invalid language, and mismatches", () => {
    expect(parseWhisperCppOutputs(validVtt(), "{", "auto")).toMatchObject({ ok: false, error: { code: "invalid-json" } });
    expect(parseWhisperCppOutputs("not vtt", validJson(), "auto")).toMatchObject({ ok: false, error: { code: "invalid-vtt" } });
    expect(parseWhisperCppOutputs(validVtt(), validJson("Hello world", "all"), "auto")).toMatchObject({ ok: false, error: { code: "invalid-language" } });
    expect(parseWhisperCppOutputs(validVtt(), validJson("Hello world", "fr"), "en")).toMatchObject({ ok: false, error: { code: "language-mismatch" } });
    expect(parseWhisperCppOutputs(`WEBVTT

00:01.000 --> 00:03.000
first

00:02.000 --> 00:02.500
end moves backwards
`, validJson(), "auto")).toMatchObject({ ok: false, error: { code: "invalid-vtt" } });
  });

  test("rejects malformed local blocks and cross-format cue disagreement", () => {
    expect(parseWhisperCppOutputs(`WEBVTT

not a cue
`, noSpeechJson(), "auto")).toMatchObject({
      ok: false,
      error: { code: "invalid-vtt" },
    });
    expect(parseWhisperCppOutputs(`WEBVTT

00:00.000 --> 00:01.000
Hello world

malformed middle block

00:02.000 --> 00:03.000
Third
`, validJson(), "en")).toMatchObject({
      ok: false,
      error: { code: "invalid-vtt" },
    });
    expect(parseWhisperCppOutputs(validVtt(), validJson("Different text"), "en")).toMatchObject({
      ok: false,
      error: { code: "output-mismatch" },
    });
    expect(parseWhisperCppOutputs("WEBVTT\n\n", validJson(), "en")).toMatchObject({
      ok: false,
      error: { code: "output-mismatch" },
    });
  });
});

describe("whisper.cpp execution", () => {
  test("runs through runtime attestation with bounded output and reads only owned outputs", async () => {
    const directory = await temporaryDirectory();
    const closure = runtimeClosure();
    const controller = new AbortController();
    const calls: AttestRuntimeClosureOptions[] = [];
    const result = await runWhisperCpp({
      executable: "/tools/whisper-cli",
      modelPath: "/models/model.bin",
      pcmPath: "/attempt/input.wav",
      requestedLanguage: "en",
      workDirectory: directory,
      runtimeClosure: closure,
      signal: controller.signal,
      timeoutMs: 1234,
    }, {
      runAttestedRuntimeProcess: async (options) => {
        calls.push(options);
        const argv = argvFromAttestationOptions(options);
        const index = argv.indexOf("--output-file");
        const prefix = argv[index + 1];
        if (prefix === undefined) throw new Error("missing output prefix");
        await writeFile(`${prefix}.vtt`, validVtt());
        await writeFile(`${prefix}.json`, validJson());
        return attestedSuccess(closure);
      },
    });
    expect(result).toMatchObject({ ok: true, status: "transcribed", transcript: { language: "en" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls[0]).toMatchObject({
      executablePath: "/tools/whisper-cli",
      executableSha256: EXECUTABLE_SHA256,
      timeoutMs: 1234,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 1024 * 1024,
    });
    expect([calls[0]?.executablePath, ...(calls[0]?.probeArguments ?? [])]).toEqual([...buildWhisperCppArgv({
      executable: "/tools/whisper-cli",
      modelPath: "/models/model.bin",
      pcmPath: "/attempt/input.wav",
      requestedLanguage: "en",
      outputPrefix: join(await realpath(directory), "transcript"),
    })]);
  });

  test("accepts drained stdout truncation because output files are authoritative", async () => {
    const directory = await temporaryDirectory();
    const closure = runtimeClosure();
    const result = await runWhisperCpp({
      executable: "/tools/whisper-cli",
      modelPath: "/models/model.bin",
      pcmPath: "/attempt/input.wav",
      requestedLanguage: "en",
      workDirectory: directory,
      runtimeClosure: closure,
    }, {
      runAttestedRuntimeProcess: async (options) => {
        const argv = argvFromAttestationOptions(options);
        const prefix = argv[argv.indexOf("--output-file") + 1] ?? "";
        await writeFile(`${prefix}.vtt`, validVtt());
        await writeFile(`${prefix}.json`, validJson());
        return attestedSuccess(closure, { ...processSuccess(), stdoutTruncated: true });
      },
    });
    expect(result).toMatchObject({ ok: true, status: "transcribed" });
  });

  test("fails closed for process and runtime-closure changes", async () => {
    const failedDirectory = await temporaryDirectory();
    const closure = runtimeClosure();
    const failure = await runWhisperCpp({
      executable: "whisper-cli",
      modelPath: "/m",
      pcmPath: "/a",
      requestedLanguage: "auto",
      workDirectory: failedDirectory,
      runtimeClosure: closure,
    }, {
      runAttestedRuntimeProcess: () => Promise.reject(new Error("private path")),
    });
    expect(failure).toMatchObject({ ok: false, error: { code: "process" } });

    const changedDirectory = await temporaryDirectory();
    const changed = await runWhisperCpp({
      executable: "whisper-cli",
      modelPath: "/m",
      pcmPath: "/a",
      requestedLanguage: "auto",
      workDirectory: changedDirectory,
      runtimeClosure: closure,
    }, {
      runAttestedRuntimeProcess: () => Promise.resolve(
        attestedSuccess(runtimeClosure("b".repeat(64))),
      ),
    });
    expect(changed).toMatchObject({
      ok: false,
      error: { code: "runtime-closure-changed" },
    });
  });

  test("fails closed for symlinked, oversized, and stale outputs", async () => {
    const closure = runtimeClosure();
    const symlinkDirectory = await temporaryDirectory();
    const target = join(symlinkDirectory, "target.vtt");
    await writeFile(target, validVtt());
    const symlinkResult = await runWhisperCpp({ executable: "whisper-cli", modelPath: "/m", pcmPath: "/a", requestedLanguage: "auto", workDirectory: symlinkDirectory, runtimeClosure: closure }, {
      runAttestedRuntimeProcess: async (options) => {
        const argv = argvFromAttestationOptions(options);
        const prefix = argv[argv.indexOf("--output-file") + 1] ?? "";
        await symlink(target, `${prefix}.vtt`);
        await writeFile(`${prefix}.json`, "{}");
        return attestedSuccess(closure);
      },
    });
    expect(symlinkResult).toMatchObject({ ok: false, error: { code: "output-unsafe" } });

    const largeDirectory = await temporaryDirectory();
    const large = await runWhisperCpp({ executable: "whisper-cli", modelPath: "/m", pcmPath: "/a", requestedLanguage: "auto", workDirectory: largeDirectory, runtimeClosure: closure }, {
      runAttestedRuntimeProcess: async (options) => {
        const argv = argvFromAttestationOptions(options);
        const prefix = argv[argv.indexOf("--output-file") + 1] ?? "";
        await writeFile(`${prefix}.vtt`, validVtt());
        await writeFile(`${prefix}.json`, " ".repeat((16 * 1024 * 1024) + 1));
        return attestedSuccess(closure);
      },
    });
    expect(large).toMatchObject({ ok: false, error: { code: "output-too-large" } });

    const staleDirectory = await temporaryDirectory();
    await writeFile(join(staleDirectory, "transcript.vtt"), validVtt());
    const stale = await runWhisperCpp({ executable: "whisper-cli", modelPath: "/m", pcmPath: "/a", requestedLanguage: "auto", workDirectory: staleDirectory, runtimeClosure: closure }, { runAttestedRuntimeProcess: () => Promise.resolve(attestedSuccess(closure)) });
    expect(stale).toMatchObject({ ok: false, error: { code: "output-exists" } });
  });

  test("rejects a symlinked work directory before invoking the runner", async () => {
    const root = await temporaryDirectory();
    const owned = join(root, "owned");
    const linked = join(root, "linked");
    await mkdir(owned);
    await symlink(owned, linked);
    let called = false;
    const closure = runtimeClosure();
    const result = await runWhisperCpp({ executable: "whisper-cli", modelPath: "/m", pcmPath: "/a", requestedLanguage: "auto", workDirectory: linked, runtimeClosure: closure }, { runAttestedRuntimeProcess: () => { called = true; return Promise.resolve(attestedSuccess(closure)); } });
    expect(result).toMatchObject({ ok: false, error: { code: "work-directory" } });
    expect(called).toBeFalse();
  });

  test("does not block when an output is swapped for a FIFO before open", async () => {
    const directory = await temporaryDirectory();
    const result = runWhisperCpp({
      executable: "whisper-cli",
      modelPath: "/m",
      pcmPath: "/a",
      requestedLanguage: "en",
      workDirectory: directory,
      runtimeClosure: runtimeClosure(),
    }, {
      runAttestedRuntimeProcess: async (options) => {
        const argv = argvFromAttestationOptions(options);
        const prefix = argv[argv.indexOf("--output-file") + 1] ?? "";
        await writeFile(`${prefix}.vtt`, validVtt());
        await writeFile(`${prefix}.json`, validJson());
        return attestedSuccess();
      },
      beforeOutputOpen: async (path, kind) => {
        if (kind !== "vtt") return;
        await rename(path, `${path}.replaced`);
        const process = Bun.spawn(["mkfifo", path], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([
          process.exited,
          new Response(process.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error(`mkfifo failed: ${stderr}`);
      },
    });

    expect(await result).toMatchObject({
      ok: false,
      error: { code: "output-unsafe" },
    });
  });
});
