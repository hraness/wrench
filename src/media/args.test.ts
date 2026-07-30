import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  test("makes a URL the ergonomic archive command", () => {
    expect(parseArgs(["https://www.youtube.com/watch?v=abc"])).toEqual({
      ok: true,
      command: {
        kind: "capture",
        mode: "archive",
        url: "https://www.youtube.com/watch?v=abc",
        language: "en",
        inheritYtDlpConfig: false,
        refresh: false,
        json: false,
      },
    });
  });

  test("parses focused capture options without leaking them into the URL", () => {
    const result = parseArgs([
      "audio",
      "https://example.com/watch/1",
      "--lang",
      "pt-BR",
      "--browser",
      "safari",
      "--auth-context",
      "Personal",
      "--json",
    ]);
    expect(result).toMatchObject({
      ok: true,
      command: {
        kind: "capture",
        mode: "audio",
        language: "pt-BR",
        browser: "safari",
        authContext: "personal",
        inheritYtDlpConfig: false,
        refresh: false,
        json: true,
      },
    });
  });

  test("parses refresh only for capture commands", () => {
    expect(parseArgs(["https://example.com/video", "--refresh"])).toMatchObject({
      ok: true,
      command: { kind: "capture", mode: "archive", refresh: true },
    });
    expect(parseArgs(["audio", "https://example.com/video", "--refresh"])).toMatchObject({
      ok: true,
      command: { kind: "capture", mode: "audio", refresh: true },
    });
    expect(parseArgs(["doctor", "--refresh"])).toEqual({
      ok: false,
      json: false,
      message: "doctor accepts only --json",
    });
    expect(parseArgs(["verify", "./item", "--refresh"])).toEqual({
      ok: false,
      json: false,
      message: "verify requires exactly one item directory and accepts only --json",
    });
  });

  test("rejects non-web and credential-bearing URLs", () => {
    expect(parseArgs(["file:///etc/passwd"])).toMatchObject({ ok: false });
    expect(parseArgs(["https://user:secret@example.com/video"])).toMatchObject({ ok: false });
  });

  test("keeps doctor and verify narrow", () => {
    expect(parseArgs(["doctor", "--json"])).toEqual({
      ok: true,
      command: { kind: "doctor", json: true },
    });
    expect(parseArgs(["verify", "./item"])).toMatchObject({
      ok: true,
      command: { kind: "verify", json: false },
    });
    expect(parseArgs(["doctor", "--lang", "en"])).toMatchObject({ ok: false });
  });

  test("parses explicit network-free whisper.cpp setup", () => {
    const result = parseArgs([
      "transcriber",
      "setup",
      "--engine",
      "whisper-cpp",
      "--model",
      "./models/ggml-base.en.bin",
      "--executable",
      "./bin/whisper-cli",
      "--replace",
      "--json",
    ]);
    expect(result).toMatchObject({
      ok: true,
      command: {
        kind: "transcriber-setup",
        engine: "whisper-cpp",
        replace: true,
        json: true,
      },
    });
    if (!result.ok || result.command.kind !== "transcriber-setup") return;
    expect(result.command.modelPath.endsWith("/models/ggml-base.en.bin")).toBeTrue();
    expect(result.command.executablePath?.endsWith("/bin/whisper-cli")).toBeTrue();
  });

  test("keeps transcriber setup explicit and command-scoped", () => {
    for (const argv of [
      ["transcriber"],
      ["transcriber", "remove"],
      ["transcriber", "setup", "--model", "model.bin"],
      ["transcriber", "setup", "--engine", "openai-whisper", "--model", "model.bin"],
      ["transcriber", "setup", "--engine", "whisper-cpp"],
      ["transcriber", "setup", "--engine", "whisper-cpp", "--model", "model.bin", "--lang", "en"],
      ["transcriber", "setup", "--engine", "whisper-cpp", "--model", "bad\u0000path"],
    ]) {
      expect(parseArgs(argv)).toMatchObject({ ok: false });
    }
  });

  test("rejects duplicate and unknown options", () => {
    expect(parseArgs(["https://example.com", "--json", "--json"])).toMatchObject({ ok: false });
    expect(parseArgs(["https://example.com", "--exec", "oops"])).toMatchObject({ ok: false });
  });

  test("rejects yt-dlp subtitle selectors where a literal language is required", () => {
    for (const language of ["all", "live_chat", "en.*,fr"]) {
      expect(parseArgs([
        "https://example.com/item",
        "--lang",
        language,
      ])).toMatchObject({ ok: false });
    }
  });

  test("rejects ambiguous browser and ambient-config authentication", () => {
    expect(parseArgs([
      "https://example.com/video",
      "--browser",
      "safari",
      "--inherit-yt-dlp-config",
    ])).toEqual({
      ok: false,
      json: false,
      message: "choose either --browser or --inherit-yt-dlp-config, not both",
    });
    expect(parseArgs([
      "https://example.com/video",
      "--browser",
      "",
      "--auth-context",
      "personal",
    ])).toMatchObject({ ok: false });
  });

  test("requires one canonical authorization context for every private access mode", () => {
    expect(parseArgs([
      "https://example.com/video",
      "--browser",
      "firefox:Work",
    ])).toEqual({
      ok: false,
      json: false,
      message: "--browser and --inherit-yt-dlp-config require --auth-context",
    });
    expect(parseArgs([
      "https://example.com/video",
      "--auth-context",
      "personal",
    ])).toEqual({
      ok: false,
      json: false,
      message: "--auth-context requires --browser or --inherit-yt-dlp-config",
    });
    expect(parseArgs([
      "https://example.com/video",
      "--inherit-yt-dlp-config",
      "--auth-context",
      "Work.Profile-1",
    ])).toMatchObject({
      ok: true,
      command: {
        kind: "capture",
        inheritYtDlpConfig: true,
        authContext: "work.profile-1",
      },
    });
    for (const context of ["", ".hidden", "contains space", "é", "x".repeat(65)]) {
      expect(parseArgs([
        "https://example.com/video",
        "--browser",
        "safari",
        "--auth-context",
        context,
      ])).toMatchObject({ ok: false });
    }
  });
});
