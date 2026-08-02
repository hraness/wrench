import { describe, expect, test } from "bun:test";
import { MediaArchiveError } from "./archive";
import { runCli, type CliIo, type MediaCliDependencies } from "./cli";
import {
  WRENCH_MEDIA_SCHEMA_VERSION,
  WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
  type MediaManifest,
} from "./manifest";
import { providerIdentitySha256, sourceAssetKey } from "./metadata";
import {
  WhisperCppTranscriberSetupError,
  WHISPER_CPP_PROFILE,
  type ReadyTranscriber,
} from "./transcriber-config";
import {
  computeRuntimeClosureSha256,
  RUNTIME_CLOSURE_PROFILE,
  type RuntimeClosureAttestation,
  type RuntimeClosureDependency,
} from "./runtime-closure";
import {
  WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
  WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
  trackedRevisionAssetKey,
  type MediaTrackedRevision,
} from "./revision";

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) }, stdout, stderr };
}

const manifest: MediaManifest = {
  schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
  wrenchVersion: "0.4.0",
  assetKey: sourceAssetKey("Youtube", "abcdefghijk"),
  capturedAt: "2026-07-21T00:00:00.000Z",
  mode: "archive",
  source: { extractor: "Youtube", id: "abcdefghijk", canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk", title: "Fixture" },
  authentication: { mode: "public" },
  acquisition: {
    adapter: "direct-http",
    provenance: {
      requestedUrlSha256: "0".repeat(64),
      effectiveUrlSha256: "1".repeat(64),
      validator: { strength: "absent" },
      lastModified: null,
      declaredMediaType: null,
      container: "matroska",
      body: { bytes: 0, sha256: "2".repeat(64) },
      redirectCount: 0,
    },
  },
  tools: {},
  artifacts: [],
  transcript: { status: "unavailable", reason: "provider_has_no_captions" },
};

const revision: MediaTrackedRevision = {
  profile: WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
  sequence: 2,
  subjectAssetKey: sourceAssetKey("Youtube", "abcdefghijk"),
  previousAssetKey: `revision-v1-${"4".repeat(64)}`,
  content: {
    profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
    sha256: "5".repeat(64),
  },
};

const trackedManifest: MediaManifest = {
  ...manifest,
  schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
  wrenchVersion: "0.4.0",
  assetKey: trackedRevisionAssetKey(revision),
  acquisition: {
    adapter: "yt-dlp",
    version: "2026.07.04",
    identity: {
      profile: WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
      providerIdentitySha256: providerIdentitySha256("Youtube", "abcdefghijk"),
    },
  },
  revision,
};

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

function readyTranscriber(
  executablePath = "/tools/whisper-cli",
  modelPath = "/models/model.bin",
  modelBytes = 1_024,
): ReadyTranscriber {
  return {
    executablePath,
    modelPath,
    descriptor: {
      adapter: "whisper-cpp",
      profile: WHISPER_CPP_PROFILE,
      executableSha256: runtimeClosure.executableSha256,
      modelSha256: "2".repeat(64),
      modelBytes,
      runtimeProfile: runtimeClosure.profile,
      runtimeSha256: runtimeClosure.closureSha256,
      runtimeDependencyCount: runtimeClosure.dependencyCount,
    },
    runtimeClosure,
  };
}

function dependencies(overrides: Partial<MediaCliDependencies> = {}): MediaCliDependencies {
  return {
    mediaUrl: () => Promise.resolve({ status: "created", itemDirectory: "/tmp/wrench-media/youtube/abc", manifest, warnings: [] }),
    runDoctor: () => Promise.resolve({ ok: true, checks: [], warnings: [], errors: [], capabilities: { directHttp: true, acquisition: true, mediaSeparation: true, javascriptRuntime: false, localTranscription: false } }),
    verifyMediaItem: (itemDirectory) => Promise.resolve({ ok: true, itemDirectory, assetKey: "youtube-abc", checkedArtifacts: 0, failures: [] }),
    setupWhisperCppTranscriber: () => Promise.resolve(readyTranscriber()),
    ...overrides,
  };
}

describe("runCli", () => {
  test("propagates caller cancellation to the archive boundary", async () => {
    const output = captureIo();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const code = await runCli(["https://example.com/adaptive/index.m3u8"], {
      io: output.io,
      signal: controller.signal,
      environment: {},
      dependencies: dependencies({
        mediaUrl: (options) => {
          receivedSignal = options.signal;
          return Promise.resolve({
            status: "created",
            itemDirectory: "/tmp/wrench-media/external/adaptive",
            manifest,
            warnings: [],
          });
        },
      }),
    });

    expect(code).toBe(0);
    expect(receivedSignal).toBe(controller.signal);
  });

  test("keeps JSON capture output to one stdout record", async () => {
    const output = captureIo();
    const code = await runCli(["https://youtube.com/watch?v=abc", "--json"], { io: output.io, dependencies: dependencies(), homeDirectory: "/home/test", environment: {} });
    expect(code).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({ ok: true, assetKey: manifest.assetKey });
  });

  test("reports tracked revision identity in JSON and human capture summaries", async () => {
    const tracked = dependencies({
      mediaUrl: () => Promise.resolve({
        status: "created",
        itemDirectory: "/tmp/wrench-media/youtube/revision-2",
        manifest: trackedManifest,
        warnings: [],
      }),
    });
    const json = captureIo();
    expect(await runCli(["https://youtube.com/watch?v=abc", "--json"], {
      io: json.io,
      dependencies: tracked,
      homeDirectory: "/home/test",
      environment: {},
    })).toBe(0);
    expect(JSON.parse(json.stdout[0] ?? "")).toMatchObject({
      assetKey: trackedManifest.assetKey,
      revision: {
        sequence: 2,
        subjectAssetKey: revision.subjectAssetKey,
        previousAssetKey: revision.previousAssetKey,
        contentSha256: revision.content.sha256,
      },
    });

    const human = captureIo();
    expect(await runCli(["https://youtube.com/watch?v=abc"], {
      io: human.io,
      dependencies: tracked,
      homeDirectory: "/home/test",
      environment: {},
    })).toBe(0);
    expect(human.stdout.join("")).toContain("Saved Fixture · revision 2");
  });

  test("uses stable nonzero codes and redacts failure URLs", async () => {
    const output = captureIo();
    const code = await runCli(["https://example.com/v", "--json"], {
      io: output.io,
      homeDirectory: "/home/test",
      environment: {},
      dependencies: dependencies({ mediaUrl: () => Promise.reject(new MediaArchiveError("PROBE_FAILED", "failed https://example.com/v?token=secret")) }),
    });
    expect(code).toBe(4);
    expect(output.stdout).toEqual([]);
    expect(output.stderr).toHaveLength(1);
    expect(output.stderr.join("")).not.toContain("secret");
    expect(JSON.parse(output.stderr[0] ?? "")).toMatchObject({ ok: false, error: { code: "PROBE_FAILED" } });
  });

  test("returns shell cancellation status in JSON and human modes", async () => {
    for (const json of [true, false]) {
      const output = captureIo();
      const argv = json
        ? ["https://example.com/adaptive/index.m3u8", "--json"]
        : ["https://example.com/adaptive/index.m3u8"];
      const code = await runCli(argv, {
        io: output.io,
        homeDirectory: "/home/test",
        environment: {},
        dependencies: dependencies({
          mediaUrl: () => Promise.reject(new MediaArchiveError(
            "CANCELLED",
            "capture was cancelled",
          )),
        }),
      });

      expect(code).toBe(130);
      expect(output.stdout).toEqual([]);
      if (json) {
        expect(output.stderr).toHaveLength(1);
        expect(JSON.parse(output.stderr[0] ?? "")).toMatchObject({
          ok: false,
          error: { code: "CANCELLED", message: "capture was cancelled" },
        });
      } else {
        expect(output.stderr).toEqual([
          "Archiving media from example.com…\n",
          "wrench media: CANCELLED: capture was cancelled\n",
        ]);
      }
    }
  });

  test("redacts standalone decoded URL basenames and fragments from JSON and human failures", async () => {
    const url = "https://example.com/private%20route/signed%20basename.mp4#fragment%20token";
    const failing = dependencies({
      mediaUrl: () => Promise.reject(new MediaArchiveError(
        "CAPTURE_FAILED",
        "failed signed basename at private route for fragment token",
        { providerId: "signed basename", fragment: "fragment token" },
      )),
    });
    for (const json of [true, false]) {
      const output = captureIo();
      const argv = json ? [url, "--json"] : [url];
      expect(await runCli(argv, {
        io: output.io,
        dependencies: failing,
        homeDirectory: "/home/test",
        environment: {},
      })).toBe(6);
      const rendered = `${output.stdout.join("")}\n${output.stderr.join("")}`;
      for (const secret of ["signed basename", "private route", "fragment token"]) {
        expect(rendered).not.toContain(secret);
      }
    }
  });

  test("abbreviates home paths in JSON details and human staging diagnostics", async () => {
    const homeDirectory = "/Users/alice";
    const stagingDirectory = `${homeDirectory}/.local/share/wrench/media/private-item`;
    const failingDependencies = dependencies({
      mediaUrl: () => Promise.reject(new MediaArchiveError(
        "CAPTURE_FAILED",
        `capture failed in ${stagingDirectory}`,
        { stagingDirectory },
      )),
    });

    const json = captureIo();
    expect(await runCli(["https://example.com/video", "--json"], {
      io: json.io,
      homeDirectory,
      environment: {},
      dependencies: failingDependencies,
    })).toBe(6);
    expect(json.stderr.join("")).not.toContain(homeDirectory);
    expect(JSON.parse(json.stderr[0] ?? "")).toMatchObject({
      error: {
        message: "capture failed in ~/.local/share/wrench/media/private-item",
        details: { stagingDirectory: "~/.local/share/wrench/media/private-item" },
      },
    });

    const human = captureIo();
    expect(await runCli(["https://example.com/video"], {
      io: human.io,
      homeDirectory,
      environment: {},
      dependencies: failingDependencies,
    })).toBe(6);
    expect(human.stderr.join("")).not.toContain(homeDirectory);
    expect(human.stderr.join("")).toContain("wrench media: CAPTURE_FAILED: capture failed in ~/.local/share/wrench/media/private-item\n");
    expect(human.stderr.join("")).toContain("diagnostic staging: ~/.local/share/wrench/media/private-item\n");
  });

  test("prints concise human progress and completion", async () => {
    const output = captureIo();
    expect(await runCli(["https://youtube.com/watch?v=abc"], { io: output.io, dependencies: dependencies(), environment: {} })).toBe(0);
    expect(output.stderr.join("")).toContain("Archiving media from youtube.com");
    expect(output.stdout.join("")).toContain("Saved Fixture");
  });

  test("renders provider titles and failures as inert single terminal lines", async () => {
    const hostileTitle = "Visible\r\n\u001B]52;c;clipboard-secret\u0007\u001B[2J\u001B]8;;https://evil.test/?token=link-secret\u001B\\label\u001B]8;;\u001B\\ forged";
    const hostileManifest: MediaManifest = {
      ...manifest,
      source: { ...manifest.source, title: hostileTitle },
      transcript: {
        status: "available",
        source: "manual",
        language: "en\r\n\u001B]52;c;language-secret\u0007forged-language",
        timedPath: "data/captions/transcript.vtt",
        textPath: "data/captions/transcript.txt",
        cuesPath: "data/captions/transcript.json",
      },
    };
    const success = captureIo();
    expect(await runCli(["https://youtube.com/watch?v=abc"], {
      io: success.io,
      environment: {},
      dependencies: dependencies({
        mediaUrl: () => Promise.resolve({
          status: "created",
          itemDirectory: "/tmp/wrench-media/youtube/abc",
          manifest: hostileManifest,
          warnings: [],
        }),
      }),
    })).toBe(0);
    expect(success.stdout.join("")).toContain("Saved Visible label forged\n");
    expect(success.stdout.join("")).not.toContain("clipboard-secret");
    expect(success.stdout.join("")).not.toContain("link-secret");
    expect(success.stdout.join("")).not.toContain("language-secret");
    expect(success.stdout.join("")).toContain("manual en forged-language transcript");
    expect(success.stdout.join("")).not.toContain("\u001B");
    expect(success.stdout.join("")).not.toContain("\r");

    const failure = captureIo();
    expect(await runCli(["https://example.com/v"], {
      io: failure.io,
      environment: {},
      dependencies: dependencies({
        mediaUrl: () => Promise.reject(new MediaArchiveError(
          "PROBE_FAILED",
          "provider failed\r\nforged\u001B]52;c;diagnostic-secret\u0007\u001B[31m",
        )),
      }),
    })).toBe(4);
    expect(failure.stderr).toEqual(["Archiving media from example.com…\n", "wrench media: PROBE_FAILED: provider failed forged\n"]);
  });

  test("keeps JSON one-record output structurally escaped for terminal controls", async () => {
    const hostileTitle = "title\u001B[2J\u009B31m";
    const output = captureIo();
    expect(await runCli(["https://youtube.com/watch?v=abc", "--json"], {
      io: output.io,
      environment: {},
      dependencies: dependencies({
        mediaUrl: () => Promise.resolve({
          status: "created",
          itemDirectory: "/tmp/wrench-media/youtube/abc",
          manifest: { ...manifest, source: { ...manifest.source, title: hostileTitle } },
          warnings: [],
        }),
      }),
    })).toBe(0);
    expect(output.stdout).toHaveLength(1);
    expect(output.stdout[0]).not.toContain("\u001B");
    expect(output.stdout[0]).not.toContain("\u009B");
    expect(output.stdout[0]).toContain("\\u001b");
    expect(output.stdout[0]).toContain("\\u009b");
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({ title: hostileTitle });
  });

  test("rejects unsafe input before calling a provider", async () => {
    const output = captureIo();
    let called = false;
    const code = await runCli(["file:///private/video"], {
      io: output.io,
      dependencies: dependencies({ mediaUrl: () => { called = true; return Promise.reject(new Error("unreachable")); } }),
    });
    expect(code).toBe(2);
    expect(called).toBeFalse();
  });

  test("configures a local transcriber without exposing private paths", async () => {
    const output = captureIo();
    let received: unknown;
    const code = await runCli([
      "transcriber",
      "setup",
      "--engine",
      "whisper-cpp",
      "--model",
      "/private/models/model.bin",
      "--executable",
      "/private/bin/whisper-cli",
      "--json",
    ], {
      io: output.io,
      homeDirectory: "/home/test",
      environment: { PATH: "/bin" },
      dependencies: dependencies({
        setupWhisperCppTranscriber: (options) => {
          received = options;
          return Promise.resolve(readyTranscriber(
            "/private/bin/whisper-cli",
            "/private/models/model.bin",
            2_048,
          ));
        },
      }),
    });
    expect(code).toBe(0);
    expect(received).toMatchObject({
      modelPath: "/private/models/model.bin",
      executablePath: "/private/bin/whisper-cli",
      replace: false,
      homeDirectory: "/home/test",
    });
    expect(output.stderr).toEqual([]);
    const rendered = output.stdout.join("");
    expect(rendered).not.toContain("/private/");
    expect(rendered).not.toContain("libwhisper.dylib");
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual({
      ok: true,
      transcriber: {
        adapter: "whisper-cpp",
        profile: WHISPER_CPP_PROFILE,
        executableSha256: "1".repeat(64),
        modelSha256: "2".repeat(64),
        modelBytes: 2_048,
        runtimeProfile: RUNTIME_CLOSURE_PROFILE,
        runtimeSha256: runtimeClosure.closureSha256,
        runtimeDependencyCount: 1,
      },
    });
  });

  test("renders concise path-free human transcriber setup output", async () => {
    const output = captureIo();
    const code = await runCli([
      "transcriber",
      "setup",
      "--engine",
      "whisper-cpp",
      "--model",
      "/private/models/model.bin",
      "--executable",
      "/private/bin/whisper-cli",
    ], {
      io: output.io,
      homeDirectory: "/home/test",
      environment: {},
      dependencies: dependencies({
        setupWhisperCppTranscriber: () => Promise.resolve(readyTranscriber(
          "/private/bin/whisper-cli",
          "/private/models/model.bin",
          2_048,
        )),
      }),
    });

    expect(code).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toEqual([
      `Configured offline whisper.cpp transcription.\n2048 model bytes · 1 runtime dependency · ${WHISPER_CPP_PROFILE}\n`,
    ]);
    expect(output.stdout.join("")).not.toContain("/private/");
  });

  test("renders stable transcriber setup failures", async () => {
    const output = captureIo();
    const code = await runCli([
      "transcriber",
      "setup",
      "--engine",
      "whisper-cpp",
      "--model",
      "/private/model.bin",
      "--json",
    ], {
      io: output.io,
      homeDirectory: "/home/test",
      environment: {},
      dependencies: dependencies({
        setupWhisperCppTranscriber: () => Promise.reject(
          new WhisperCppTranscriberSetupError(
            "CAPABILITY_MISMATCH",
            "The executable is not compatible.",
          ),
        ),
      }),
    });
    expect(code).toBe(3);
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(output.stderr[0] ?? "")).toMatchObject({
      ok: false,
      error: { code: "TRANSCRIBER_CAPABILITY_MISMATCH" },
    });
  });
});
