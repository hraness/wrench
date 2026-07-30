import { describe, expect, test } from "bun:test";
import { authContextSha256 } from "./metadata";
import type { CaptureYtDlpOptions } from "./yt-dlp";
import {
  buildYtDlpCaptureArgv,
  buildYtDlpProbeArgv,
  captureWithYtDlp,
  isSafeYtDlpCaptureExtension,
  parseYtDlpCaptureIdentity,
  probeWithYtDlp,
} from "./yt-dlp";

const CAPTURE_IDENTITY_PREFIX = "WRENCH_MEDIA_CAPTURE_IDENTITY_V1\t";
const OWNED_PROBE_FLAGS = [
  "--no-remote-components",
  "--ignore-dynamic-mpd",
  "--no-wait-for-video",
  "--no-live-from-start",
  "--no-allow-unplayable-formats",
] as const;
const OWNED_CAPTURE_ONLY_FLAGS = [
  "--no-keep-fragments",
  "--no-hls-split-discontinuity",
] as const;

function captureOptions(
  overrides: Partial<CaptureYtDlpOptions> = {},
): CaptureYtDlpOptions {
  return {
    executable: "yt-dlp",
    url: "https://example.com/video",
    mode: "archive",
    captureDirectory: "/tmp/item/data/capture",
    temporaryDirectory: "/tmp/item/.tmp",
    caption: null,
    persistDescriptiveMetadata: true,
    inheritConfig: false,
    ...overrides,
  };
}

function identityRecord(extractor = "Youtube", id = "video-id", ext = "mkv"): string {
  return `${CAPTURE_IDENTITY_PREFIX}${JSON.stringify({ extractor, id, ext })}\n`;
}

function rawIdentityRecord(value: unknown): string {
  return `${CAPTURE_IDENTITY_PREFIX}${JSON.stringify(value)}`;
}

describe("yt-dlp argv", () => {
  test("places an untrusted URL after the option separator and ignores ambient config", () => {
    const argv = buildYtDlpProbeArgv({
      executable: "/usr/bin/yt-dlp",
      url: "https://example.com/-danger",
      inheritConfig: false,
    });
    expect(argv.slice(-2)).toEqual(["--", "https://example.com/-danger"]);
    expect(argv).toContain("--ignore-config");
    expect(argv).toContain("--no-plugin-dirs");
    for (const flag of OWNED_PROBE_FLAGS) {
      expect(argv.filter((value) => value === flag)).toHaveLength(1);
    }
    for (const flag of OWNED_CAPTURE_ONLY_FLAGS) expect(argv).not.toContain(flag);
    expect(argv).not.toContain("--exec");
    expect(argv).not.toContain("--write-link");
  });

  test("keeps Wrench media-owned probe policy when ambient config is explicitly inherited", () => {
    const argv = buildYtDlpProbeArgv({
      executable: "yt-dlp",
      url: "https://example.com/manifest.mpd",
      inheritConfig: true,
      authContextSha256: authContextSha256("ambient"),
    });
    expect(argv).not.toContain("--ignore-config");
    expect(argv).not.toContain("--no-plugin-dirs");
    for (const flag of OWNED_PROBE_FLAGS) {
      expect(argv.filter((value) => value === flag)).toHaveLength(1);
    }
    expect(argv.slice(-2)).toEqual(["--", "https://example.com/manifest.mpd"]);
  });

  test("builds a preservation capture with exactly one selected caption source", () => {
    const argv = buildYtDlpCaptureArgv(captureOptions({
      caption: { source: "automatic", language: "en-US" },
      browser: "safari",
      authContextSha256: authContextSha256("personal"),
    }));
    expect(argv).toContain("--write-auto-subs");
    expect(argv).not.toContain("--write-subs");
    expect(argv).not.toContain("--max-downloads");
    expect(argv.filter((argument) => argument === "--no-playlist")).toHaveLength(1);
    expect(argv).not.toContain("--yes-playlist");
    expect(argv).toContain("--cookies-from-browser");
    expect(argv).toContain("--no-write-info-json");
    expect(argv).not.toContain("--write-info-json");
    expect(argv).not.toContain("--clean-info-json");
    expect(argv).toContain("--quiet");
    expect(argv).toContain("--no-progress");
    expect(argv).toContain("--no-simulate");
    expect(argv).not.toContain("--dump-json");
    expect(argv).not.toContain("--dump-single-json");
    expect(argv.filter((argument) => argument === "--print")).toHaveLength(1);
    for (const flag of [...OWNED_PROBE_FLAGS, ...OWNED_CAPTURE_ONLY_FLAGS]) {
      expect(argv.filter((value) => value === flag)).toHaveLength(1);
    }
    for (const positive of [
      "--remote-components",
      "--wait-for-video",
      "--live-from-start",
      "--keep-fragments",
      "--hls-split-discontinuity",
      "--allow-unplayable-formats",
    ]) expect(argv).not.toContain(positive);
    const printIndex = argv.indexOf("--print");
    expect(printIndex).toBeGreaterThan(-1);
    expect(argv[printIndex + 1]).toBe(
      'after_move:WRENCH_MEDIA_CAPTURE_IDENTITY_V1\t{"extractor":%(extractor_key,extractor|)j,"id":%(id|)j,"ext":%(ext|)j}',
    );
    expect(argv[printIndex + 1]).not.toContain("url");
    expect(argv[printIndex + 1]).not.toContain("format");
    expect(argv[printIndex + 1]).not.toContain("header");
    expect(argv[printIndex + 1]).not.toContain("cookie");
    expect(argv.slice(-2)).toEqual(["--", "https://example.com/video"]);
  });

  test("makes transcript-only acquisition skip media", () => {
    const argv = buildYtDlpCaptureArgv(captureOptions({
      mode: "transcript",
      caption: { source: "manual", language: "en" },
      inheritConfig: true,
      authContextSha256: authContextSha256("ambient"),
    }));
    expect(argv).toContain("--skip-download");
    expect(argv).toContain("--no-write-info-json");
    for (const flag of [...OWNED_PROBE_FLAGS, ...OWNED_CAPTURE_ONLY_FLAGS]) {
      expect(argv.filter((value) => value === flag)).toHaveLength(1);
    }
    expect(argv).not.toContain("--ignore-config");
    const printIndex = argv.indexOf("--print");
    expect(argv[printIndex + 1]).toStartWith("after_video:WRENCH_MEDIA_CAPTURE_IDENTITY_V1\t");
  });

  test("explicitly disables descriptive sidecars for unowned projections", () => {
    const argv = buildYtDlpCaptureArgv(captureOptions({
      persistDescriptiveMetadata: false,
      privateRedactions: ["raw-private-id"],
    }));
    expect(argv).toContain("--no-write-description");
    expect(argv).toContain("--no-write-thumbnail");
    expect(argv).not.toContain("--write-description");
    expect(argv).not.toContain("--write-thumbnail");
    expect(argv).not.toContain("raw-private-id");
  });

  test("fails closed on ambiguous or unscoped private access", () => {
    for (const browser of ["", "safari\nsecret", "x".repeat(513)]) {
      expect(() => buildYtDlpProbeArgv({
        executable: "yt-dlp",
        url: "https://example.com/video",
        browser,
        inheritConfig: false,
        authContextSha256: authContextSha256("personal"),
      })).toThrow("browser selector is malformed");
    }
    expect(() => buildYtDlpProbeArgv({
      executable: "yt-dlp",
      url: "https://example.com/video",
      browser: "safari",
      inheritConfig: false,
    })).toThrow("requires exactly one authorization context");
    expect(() => buildYtDlpProbeArgv({
      executable: "yt-dlp",
      url: "https://example.com/video",
      inheritConfig: false,
      authContextSha256: authContextSha256("personal"),
    })).toThrow("requires exactly one authorization context");
    expect(() => buildYtDlpProbeArgv({
      executable: "yt-dlp",
      url: "https://example.com/video",
      browser: "safari",
      inheritConfig: true,
      authContextSha256: authContextSha256("personal"),
    })).toThrow("mutually exclusive");
  });

  test("never passes subtitle selector grammar as a literal language", () => {
    for (const language of ["all", "live_chat", "en.*,fr"]) {
      expect(() => buildYtDlpCaptureArgv(captureOptions({
        caption: { source: "manual", language },
      }))).toThrow("literal BCP-47-style tag");
    }
    const safe = buildYtDlpCaptureArgv(captureOptions({
      caption: { source: "manual", language: "en-US" },
    }));
    const languageIndex = safe.indexOf("--sub-langs");
    expect(safe[languageIndex + 1]).toBe("en-US");
  });
});

describe("yt-dlp capture identity", () => {
  test("parses only the allowlisted identity without mutating opaque provider strings", () => {
    const output = [
      "ambient config output that may contain https://private.invalid/?token=secret",
      identityRecord("Cafe\u0301\ud83d\udd2e", " item-id ", "webm").trimEnd(),
      "",
    ].join("\n");
    const result = parseYtDlpCaptureIdentity(output);
    expect(result).toEqual({
      ok: true,
      identity: { extractor: "Cafe\u0301\ud83d\udd2e", id: " item-id ", ext: "webm" },
    });
    expect(JSON.stringify(result)).not.toContain("private.invalid");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("rejects a missing or non-string completion record", () => {
    for (const output of [undefined, null, 1, {}, "", "ordinary yt-dlp progress\n"]) {
      expect(parseYtDlpCaptureIdentity(output)).toEqual({
        ok: false,
        diagnostic: "yt-dlp capture did not return an identity record",
      });
    }
  });

  test("rejects malformed, overbroad, and unbounded identity records", () => {
    const malformed = [
      `${CAPTURE_IDENTITY_PREFIX}{`,
      `${CAPTURE_IDENTITY_PREFIX}null`,
      `${CAPTURE_IDENTITY_PREFIX}[]`,
      rawIdentityRecord({ extractor: "Youtube", id: "id" }),
      rawIdentityRecord({ extractor: "Youtube", id: "id", ext: "mkv", url: "https://secret.invalid" }),
      rawIdentityRecord({ extractor: 1, id: "id", ext: "mkv" }),
      rawIdentityRecord({ extractor: "Youtube", id: "", ext: "mkv" }),
      rawIdentityRecord({ extractor: "You\u0000tube", id: "id", ext: "mkv" }),
      rawIdentityRecord({ extractor: "Youtube", id: "line\nbreak", ext: "mkv" }),
      rawIdentityRecord({ extractor: "Youtube", id: "del\u007f", ext: "mkv" }),
      rawIdentityRecord({ extractor: "Youtube", id: "c1\u0085", ext: "mkv" }),
      rawIdentityRecord({ extractor: "bad\ud800", id: "id", ext: "mkv" }),
      rawIdentityRecord({ extractor: "Youtube", id: "bad\udfff", ext: "mkv" }),
      rawIdentityRecord({ extractor: "x".repeat(513), id: "id", ext: "mkv" }),
      rawIdentityRecord({ extractor: "Youtube", id: "x".repeat(513), ext: "mkv" }),
      `${rawIdentityRecord({ extractor: "Youtube", id: "id", ext: "mkv" })}trailing`,
    ];
    for (const output of malformed) {
      expect(parseYtDlpCaptureIdentity(output)).toEqual({
        ok: false,
        diagnostic: "yt-dlp capture returned a malformed identity record",
      });
    }
  });

  test("accepts only bounded lowercase primary-media extensions", () => {
    for (const ext of ["3gp", "m4a", "mkv", "webm", "a1", "x".repeat(16)]) {
      expect(isSafeYtDlpCaptureExtension(ext)).toBeTrue();
      expect(parseYtDlpCaptureIdentity(identityRecord("Generic", "item", ext))).toEqual({
        ok: true,
        identity: { extractor: "Generic", id: "item", ext },
      });
    }

    for (const ext of [
      "",
      "MP4",
      ".mp4",
      "media.mp4",
      "../mp4",
      "a/b",
      "a\\b",
      "m-p4",
      "m_p4",
      "x".repeat(17),
      "mp4\u0000",
      "vtt",
      "srt",
      "ttml",
      "json",
      "xml",
      "jpg",
      "webp",
      "svg",
      "part",
      "ytdl",
      "description",
    ]) {
      expect(isSafeYtDlpCaptureExtension(ext)).toBeFalse();
      expect(parseYtDlpCaptureIdentity(identityRecord("Generic", "item", ext))).toEqual({
        ok: false,
        diagnostic: "yt-dlp capture returned a malformed identity record",
      });
    }
    for (const value of [undefined, null, 1, {}, [], true]) {
      expect(isSafeYtDlpCaptureExtension(value)).toBeFalse();
    }
  });

  test("rejects multiple prefixed records even when they agree", () => {
    expect(parseYtDlpCaptureIdentity(`${identityRecord()}${identityRecord()}`)).toEqual({
      ok: false,
      diagnostic: "yt-dlp capture returned multiple identity records",
    });
  });

  test("returns the identity only after an untruncated successful process", async () => {
    let maximumStdoutBytes: number | undefined;
    let redactions: readonly string[] = [];
    const result = await captureWithYtDlp(captureOptions({
      url: "https://example.com/private%20route/signed%20basename.mp4?signature=query%20token#fragment%20token",
      privateRedactions: ["raw-private-id", "normalized-private-title"],
    }), {
      runProcess: (_argv, options) => {
        maximumStdoutBytes = options.maxStdoutBytes;
        redactions = options.redactions ?? [];
        return Promise.resolve({
          ok: true,
          command: [],
          exitCode: 0,
          stdout: identityRecord(),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          elapsedMs: 1,
        });
      },
    });
    expect(maximumStdoutBytes).toBe(16 * 1024);
    for (const secret of [
      "signed basename",
      "private route",
      "query token",
      "fragment token",
      "raw-private-id",
      "normalized-private-title",
    ]) expect(redactions).toContain(secret);
    expect(result).toEqual({
      ok: true,
      identity: { extractor: "Youtube", id: "video-id", ext: "mkv" },
    });
  });

  test("fails closed when stdout is truncated, even if a complete record fit", async () => {
    const result = await captureWithYtDlp(captureOptions(), {
      runProcess: () => Promise.resolve({
        ok: true,
        command: [],
        exitCode: 0,
        stdout: identityRecord(),
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
        elapsedMs: 1,
      }),
    });
    expect(result).toEqual({
      ok: false,
      diagnostic: "yt-dlp capture exceeded Wrench media's identity output limit",
    });
  });

  test("forwards cancellation and preserves an aborted process reason", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const result = await captureWithYtDlp(captureOptions({ signal: controller.signal }), {
      runProcess: (_argv, options) => {
        observedSignal = options.signal;
        return Promise.resolve({
          ok: false,
          reason: "aborted",
          command: [],
          exitCode: 143,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          elapsedMs: 1,
          diagnostic: "yt-dlp was cancelled",
        });
      },
    });
    expect(observedSignal).toBe(controller.signal);
    expect(result).toEqual({
      ok: false,
      diagnostic: "yt-dlp was cancelled",
      processReason: "aborted",
    });
  });
});

test("probe parses only the allowlisted metadata surface", async () => {
  const result = await probeWithYtDlp(
    { executable: "yt-dlp", url: "https://example.com/v", inheritConfig: false },
    {
      runProcess: () => Promise.resolve({
        ok: true,
        command: [],
        exitCode: 0,
        stdout: JSON.stringify({ id: "v", extractor: "generic", webpage_url: "https://example.com/v", formats: [{ url: "secret" }] }),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        elapsedMs: 1,
      }),
    },
  );
  expect(result).toMatchObject({
    ok: true,
    metadata: {
      acquisitionIdentity: { extractor: "generic", id: "v" },
      projection: "opaque",
      extractor: "External",
    },
  });
  if (!result.ok) {
    throw new Error("diagnostic" in result ? result.diagnostic : result.message);
  }
  expect(result.metadata.id).toMatch(/^opaque-v2-[0-9a-f]{64}$/u);
  expect(JSON.stringify(result)).not.toContain("formats");
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("probe preserves typed unsupported source results", async () => {
  const result = await probeWithYtDlp(
    { executable: "yt-dlp", url: "https://example.com/live", inheritConfig: false },
    {
      runProcess: () => Promise.resolve({
        ok: true,
        command: [],
        exitCode: 0,
        stdout: JSON.stringify({
          id: "live",
          extractor: "generic",
          webpage_url: "https://example.com/live",
          is_live: true,
        }),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        elapsedMs: 1,
      }),
    },
  );
  expect(result).toEqual({
    ok: false,
    kind: "unsupported",
    reason: "live",
    message: "yt-dlp probe returned an unsupported live source",
  });
  expect(result).not.toHaveProperty("diagnostic");
});

test("probe forwards cancellation and preserves an aborted process reason", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const result = await probeWithYtDlp(
    {
      executable: "yt-dlp",
      url: "https://example.com/video",
      inheritConfig: false,
      signal: controller.signal,
    },
    {
      runProcess: (_argv, options) => {
        observedSignal = options.signal;
        return Promise.resolve({
          ok: false,
          reason: "aborted",
          command: [],
          exitCode: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          elapsedMs: 0,
          diagnostic: "yt-dlp was cancelled before start",
        });
      },
    },
  );
  expect(observedSignal).toBe(controller.signal);
  expect(result).toEqual({
    ok: false,
    diagnostic: "yt-dlp was cancelled before start",
    processReason: "aborted",
  });
});

test("probe and capture prefer the same case-sensitive extractor key", async () => {
  const publicId = "video-id001";
  const probe = await probeWithYtDlp(
    { executable: "yt-dlp", url: `https://www.youtube.com/watch?v=${publicId}`, inheritConfig: false },
    {
      runProcess: () => Promise.resolve({
        ok: true,
        command: [],
        exitCode: 0,
        stdout: JSON.stringify({
          id: publicId,
          extractor: "youtube",
          extractor_key: "Youtube",
          webpage_url: `https://www.youtube.com/watch?v=${publicId}`,
        }),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        elapsedMs: 1,
      }),
    },
  );
  const capture = parseYtDlpCaptureIdentity(identityRecord("Youtube", publicId));
  expect(probe).toMatchObject({
    ok: true,
    metadata: {
      acquisitionIdentity: { extractor: "Youtube", id: publicId },
      projection: "youtube",
      extractor: "Youtube",
      id: publicId,
    },
  });
  expect(capture).toEqual({
    ok: true,
    identity: { extractor: "Youtube", id: publicId, ext: "mkv" },
  });
});
