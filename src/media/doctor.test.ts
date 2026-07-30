import { describe, expect, test } from "bun:test";

import {
  isFfmpegVersionStale,
  isYtDlpVersionStale,
  parseDenoVersion,
  parseFfmpegVersion,
  parseYtDlpVersion,
  renderDoctorReport,
  runDoctor,
  type DoctorDependencies,
  type DoctorToolName,
} from "./doctor";
import type { ProcessResult } from "./process";
import {
  WHISPER_CPP_PROFILE,
  type LoadConfiguredTranscriberResult,
} from "./transcriber-config";
import {
  computeRuntimeClosureSha256,
  RUNTIME_CLOSURE_PROFILE,
  type RuntimeClosureAttestation,
  type RuntimeClosureDependency,
} from "./runtime-closure";

const runtimeDependencies: readonly RuntimeClosureDependency[] = [
  {
    physicalPath: "/private/lib/libwhisper.dylib",
    logicalName: "libwhisper.dylib",
    sha256: "4".repeat(64),
    bytes: 4_096,
  },
];

const runtimeClosure: RuntimeClosureAttestation = {
  profile: RUNTIME_CLOSURE_PROFILE,
  platform: "darwin",
  evidence: "dynamic-loader",
  executableSha256: "1".repeat(64),
  closureSha256: computeRuntimeClosureSha256(
    "darwin",
    "1".repeat(64),
    runtimeDependencies,
  ),
  dependencyCount: runtimeDependencies.length,
  dependencyBytes: 4_096,
  dependencies: runtimeDependencies,
};

function successfulProcess(stdout: string, stderr = ""): ProcessResult {
  return {
    ok: true,
    command: ["probe"],
    exitCode: 0,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    elapsedMs: 1,
  };
}

function fakeDependencies(
  versions: Readonly<Partial<Record<DoctorToolName, string | null>>>,
  calls: string[][] = [],
  transcriber: LoadConfiguredTranscriberResult = { kind: "not-configured" },
): DoctorDependencies {
  return {
    findExecutable: (name) =>
      Promise.resolve(
        Object.hasOwn(versions, name) && versions[name] !== null ? `/tools/${name}` : null,
      ),
    runProcess: (argv) => {
      calls.push([...argv]);
      const name = argv[0]?.slice("/tools/".length) as DoctorToolName | undefined;
      if (name === undefined) throw new Error("Missing fake tool name.");
      const output = versions[name];
      if (typeof output !== "string") throw new Error(`Missing fake output for ${name}.`);
      return Promise.resolve(successfulProcess(output));
    },
    loadConfiguredTranscriber: () => Promise.resolve(transcriber),
  };
}

describe("runDoctor", () => {
  test("reports stale required tools as warnings without failing readiness", async () => {
    const report = await runDoctor(
      {},
      fakeDependencies({
        "yt-dlp": "2026.07.03\n",
        ffmpeg: "ffmpeg version 6.1.2 Copyright FFmpeg",
        ffprobe: "ffprobe version 6.1.2 Copyright FFmpeg",
        deno: null,
      }),
    );

    expect(report.ok).toBeTrue();
    expect(report.errors).toEqual([]);
    expect(report.warnings).toHaveLength(3);
    expect(report.checks.map(({ name, status }) => [name, status])).toEqual([
      ["yt-dlp", "warning"],
      ["ffmpeg", "warning"],
      ["ffprobe", "warning"],
      ["deno", "optional-missing"],
      ["transcriber", "optional-missing"],
    ]);
    expect(report.capabilities).toEqual({
      directHttp: true,
      acquisition: true,
      mediaSeparation: true,
      javascriptRuntime: false,
      localTranscription: false,
    });
  });

  test("fails only for a missing or broken required executable", async () => {
    const report = await runDoctor(
      {},
      fakeDependencies({
        "yt-dlp": "2026.07.20",
        ffmpeg: "ffmpeg version 8.0",
        ffprobe: null,
        deno: null,
      }),
    );

    expect(report.ok).toBeFalse();
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("ffprobe");
    expect(report.capabilities).toEqual({
      directHttp: true,
      acquisition: true,
      mediaSeparation: false,
      javascriptRuntime: false,
      localTranscription: false,
    });
  });

  test("checks current tools and an explicitly configured offline transcriber", async () => {
    const calls: string[][] = [];
    const report = await runDoctor(
      { probeTimeoutMs: 500 },
      fakeDependencies(
        {
          "yt-dlp": "2026.07.20",
          ffmpeg: "ffmpeg version 8.0.1 built with Apple clang",
          ffprobe: "ffprobe version 8.0.1 built with Apple clang",
          deno: "deno 2.4.1\nv8 13.7",
        },
        calls,
        {
          kind: "ready",
          transcriber: {
            executablePath: "/private/tools/whisper-cli",
            modelPath: "/private/models/model.bin",
            descriptor: {
              adapter: "whisper-cpp",
              profile: WHISPER_CPP_PROFILE,
              executableSha256: "1".repeat(64),
              modelSha256: "2".repeat(64),
              modelBytes: 1024,
              runtimeProfile: runtimeClosure.profile,
              runtimeSha256: runtimeClosure.closureSha256,
              runtimeDependencyCount: runtimeClosure.dependencyCount,
            },
            runtimeClosure,
          },
        },
      ),
    );

    expect(report.ok).toBeTrue();
    expect(report.warnings).toEqual([]);
    expect(report.checks.every(({ status }) => status === "ok")).toBeTrue();
    expect(report.capabilities.javascriptRuntime).toBeTrue();
    expect(report.capabilities.localTranscription).toBeTrue();
    expect(calls).toEqual([
      ["/tools/yt-dlp", "--version"],
      ["/tools/ffmpeg", "-version"],
      ["/tools/ffprobe", "-version"],
      ["/tools/deno", "--version"],
    ]);
    const rendered = renderDoctorReport(report);
    expect(rendered).toContain("Wrench media is ready.\n");
    expect(rendered).toContain("1024 model bytes; 1 runtime dependency");
    expect(rendered).not.toContain("/private/");
    expect(rendered).not.toContain("libwhisper.dylib");
    expect(JSON.stringify(report)).not.toContain("/private/");
  });

  test("reports a changed configured transcriber as an optional warning", async () => {
    const report = await runDoctor(
      {},
      fakeDependencies(
        {
          "yt-dlp": "2026.07.20",
          ffmpeg: "ffmpeg version 8.0",
          ffprobe: "ffprobe version 8.0",
          deno: null,
        },
        [],
        {
          kind: "invalid",
          reason: "model-hash-mismatch",
          message: "private path must not render",
        },
      ),
    );
    expect(report.ok).toBeTrue();
    expect(report.capabilities.localTranscription).toBeFalse();
    expect(report.warnings).toEqual([
      "transcriber: configuration is invalid (model-hash-mismatch); rerun transcriber setup with --replace",
    ]);
    expect(renderDoctorReport(report)).not.toContain("private path");
  });

  test("can omit optional probes while preserving a stable required-tool order", async () => {
    const report = await runDoctor(
      { includeOptional: false },
      fakeDependencies({
        "yt-dlp": "2026.07.20",
        ffmpeg: "ffmpeg version 8.0",
        ffprobe: "ffprobe version 8.0",
      }),
    );

    expect(report.checks.map(({ name }) => name)).toEqual(["yt-dlp", "ffmpeg", "ffprobe"]);
    expect(report.ok).toBeTrue();
  });
});

describe("version policy", () => {
  test("parses provider formats and compares the yt-dlp date floor exactly", () => {
    expect(parseYtDlpVersion("2026.07.04")).toBe("2026.07.04");
    expect(parseYtDlpVersion("2026.7.4.232945 nightly")).toBe("2026.07.04");
    expect(parseYtDlpVersion("release unknown")).toBeNull();
    expect(isYtDlpVersionStale("2026.07.03")).toBeTrue();
    expect(isYtDlpVersionStale("2026.07.04")).toBeFalse();
    expect(isYtDlpVersionStale("2027.01.01")).toBeFalse();
  });

  test("parses FFmpeg, ffprobe, and Deno banners and detects old FFmpeg majors", () => {
    expect(parseFfmpegVersion("ffmpeg version 8.0.1-static build")).toBe("8.0.1");
    expect(parseFfmpegVersion("ffprobe version 7.1.2-0+deb13u1")).toBe("7.1.2");
    expect(parseDenoVersion("deno 2.4.1\nv8 13.7")).toBe("2.4.1");
    expect(isFfmpegVersionStale("6.1.2")).toBeTrue();
    expect(isFfmpegVersionStale("7.1.4")).toBeTrue();
    expect(isFfmpegVersionStale("7.1.5")).toBeFalse();
  });
});
