import { describe, expect, test } from "bun:test";

import {
  findExecutable,
  redactArguments,
  redactDiagnostic,
  runProcess,
  sanitizeTerminalText,
  urlDerivedRedactions,
  type CommandArgv,
  type ProcessDependencies,
  type ProcessSpawnOptions,
  type ProcessTimer,
  type SpawnedProcess,
} from "./process";

function streamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

class ManualTimer implements ProcessTimer {
  readonly #pending = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  #nextId = 1;

  set = (callback: () => void, delayMs: number): unknown => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.set(id, { callback, delayMs });
    return id;
  };

  clear = (handle: unknown): void => {
    if (typeof handle === "number") this.#pending.delete(handle);
  };

  get size(): number {
    return this.#pending.size;
  }

  get delays(): readonly number[] {
    return [...this.#pending.values()].map(({ delayMs }) => delayMs);
  }

  fireNext(): void {
    const entry = this.#pending.entries().next().value as
      | [number, Readonly<{ callback: () => void; delayMs: number }>]
      | undefined;
    if (entry === undefined) throw new Error("No timer is pending.");
    this.#pending.delete(entry[0]);
    entry[1].callback();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached.");
}

describe("runProcess", () => {
  test("does not spawn when cancellation already happened", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawnCount = 0;
    const result = await runProcess(
      ["yt-dlp", "--", "https://example.test/never-started"],
      { signal: controller.signal },
      {
        spawn: () => {
          spawnCount += 1;
          throw new Error("unreachable");
        },
        timer: new ManualTimer(),
        now: () => 0,
      },
    );

    expect(spawnCount).toBe(0);
    expect(result).toMatchObject({ ok: false, reason: "aborted", exitCode: null });
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error("Expected cancelled process failure.");
    expect(result.diagnostic).toContain("cancelled before the process started");
  });

  test("terminates a running process when the caller cancels", async () => {
    const controller = new AbortController();
    const exit = deferred<number>();
    const signals: string[] = [];
    const timer = new ManualTimer();
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const child: SpawnedProcess = {
      stdout: new ReadableStream<Uint8Array>({
        start(value) { stdoutController = value; },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(value) { stderrController = value; },
      }),
      exited: exit.promise,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGTERM") {
          stdoutController?.close();
          stderrController?.close();
          exit.resolve(143);
        }
      },
    };
    const pending = runProcess(
      ["yt-dlp", "--", "https://example.test/adaptive-vod"],
      { signal: controller.signal, timeoutMs: 60_000 },
      { spawn: () => child, timer, now: () => 0 },
    );

    await waitUntil(() => timer.size === 1);
    controller.abort();
    const result = await pending;

    expect(signals).toEqual(["SIGTERM"]);
    expect(timer.size).toBe(0);
    expect(result).toMatchObject({ ok: false, reason: "aborted", exitCode: 143 });
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error("Expected cancelled process failure.");
    expect(result.diagnostic).toContain("was cancelled and terminated");
  });

  test("passes an argv array directly and bounds each output stream", async () => {
    const calls: Array<Readonly<{ argv: CommandArgv; options: ProcessSpawnOptions }>> = [];
    const timer = new ManualTimer();
    const dependencies: ProcessDependencies = {
      spawn: (argv, options) => {
        calls.push({ argv, options });
        return {
          stdout: streamOf("abc", "defgh"),
          stderr: streamOf("warning"),
          exited: Promise.resolve(0),
          kill: () => undefined,
        };
      },
      timer,
      now: () => 100,
    };

    const result = await runProcess(
      ["/opt/homebrew/bin/yt-dlp", "--", "https://example.test/video"],
      { maxStdoutBytes: 5, maxStderrBytes: 4 },
      dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "abcde",
      stderr: "warn",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([
      "/opt/homebrew/bin/yt-dlp",
      "--",
      "https://example.test/video",
    ]);
    expect("shell" in (calls[0]?.options ?? {})).toBeFalse();
    expect(timer.size).toBe(0);
  });

  test("escalates a timeout from SIGTERM to SIGKILL", async () => {
    const exit = deferred<number>();
    const signals: string[] = [];
    const timer = new ManualTimer();
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        stderrController = controller;
      },
    });
    const child: SpawnedProcess = {
      stdout,
      stderr,
      exited: exit.promise,
      kill: (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          stdoutController?.close();
          stderrController?.close();
          exit.resolve(137);
        }
      },
    };
    const pending = runProcess(
      ["yt-dlp", "--", "https://example.test/slow"],
      { timeoutMs: 10, terminateGraceMs: 5, killGraceMs: 5 },
      { spawn: () => child, timer, now: () => 0 },
    );

    await waitUntil(() => timer.size === 1);
    timer.fireNext();
    await waitUntil(() => signals.includes("SIGTERM") && timer.size === 1);
    timer.fireNext();
    await waitUntil(() => signals.includes("SIGKILL"));

    const result = await pending;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({ ok: false, reason: "timeout", exitCode: 137 });
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error("Expected timeout failure.");
    expect(result.diagnostic).toContain("timed out and was terminated");
  });

  test("does not hang when an exited process leaves an output pipe open", async () => {
    const timer = new ManualTimer();
    const neverClosingOutput = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    const pending = runProcess(
      ["ffprobe", "-version"],
      { timeoutMs: 1_000, killGraceMs: 7 },
      {
        spawn: () => ({
          stdout: neverClosingOutput,
          stderr: streamOf(),
          exited: Promise.resolve(0),
          kill: () => undefined,
        }),
        timer,
        now: () => 0,
      },
    );

    await waitUntil(() => timer.delays.includes(7));
    timer.fireNext();
    const result = await pending;
    expect(result.ok).toBeTrue();
    expect(result.stdout).toBe("partial");
    expect(result.stdoutTruncated).toBeTrue();
  });

  test("returns a redacted spawn diagnostic without echoing credentials", async () => {
    const secret = "profile-secret";
    const result = await runProcess(
      [
        "yt-dlp",
        "--cookies-from-browser",
        secret,
        "https://alice:password@example.test/watch?token=signed-value",
      ],
      { redactions: [secret], env: { HOME: "/Users/alice" } },
      {
        spawn: () => {
          throw new Error(
            "Authorization: Bearer abc\nfailed https://example.test/access-token-ABC/video?signature=signed-value in /Users/alice/cache",
          );
        },
        timer: new ManualTimer(),
        now: () => 0,
      },
    );

    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error("Expected spawn failure.");
    expect(result.reason).toBe("spawn");
    expect(result.command).toContain("[REDACTED]");
    expect(result.diagnostic).not.toContain(secret);
    expect(result.diagnostic).not.toContain("password");
    expect(result.diagnostic).not.toContain("access-token-ABC");
    expect(result.diagnostic).not.toContain("signed-value");
    expect(result.diagnostic).not.toContain("Bearer abc");
    expect(result.diagnostic).not.toContain("/Users/alice");
    expect(result.diagnostic).toContain("~/cache");
  });

  test("redacts URL paths and credentials from failed command argv and stderr", async () => {
    const signedUrl =
      "https://alice:password@cdn.example.test:8443/access-token-ABC/video?signature=signed-value#private";
    const result = await runProcess(
      ["yt-dlp", "--", signedUrl],
      {},
      {
        spawn: () => ({
          stdout: streamOf(),
          stderr: streamOf(`download failed for ${signedUrl}`),
          exited: Promise.resolve(1),
          kill: () => undefined,
        }),
        timer: new ManualTimer(),
        now: () => 0,
      },
    );

    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error("Expected process failure.");
    expect(result.command).toEqual([
      "yt-dlp",
      "--",
      "https://cdn.example.test:8443/[REDACTED]",
    ]);
    expect(result.diagnostic).toContain("https://cdn.example.test:8443/[REDACTED]");
    for (const secret of [
      "alice",
      "password",
      "access-token-ABC",
      "signed-value",
      "private",
    ]) {
      expect(result.command.join(" ")).not.toContain(secret);
      expect(result.diagnostic).not.toContain(secret);
    }
  });

  test("redacts standalone raw and decoded URL-derived identities on tool failure", async () => {
    const signedUrl = "https://example.test/private%20route/signed%20basename.mp4?private%20key=query%20token#fragment%20token";
    const derived = urlDerivedRedactions(signedUrl);
    for (const expected of [
      "private%20route",
      "private route",
      "signed%20basename.mp4",
      "signed basename",
      "private%20key",
      "private key",
      "query%20token",
      "query token",
      "fragment%20token",
      "fragment token",
    ]) expect(derived).toContain(expected);

    const result = await runProcess(
      ["yt-dlp", "--", signedUrl],
      { redactions: [signedUrl, ...derived] },
      {
        spawn: () => ({
          stdout: streamOf(),
          stderr: streamOf(
            "failed signed basename for private route; private key=query token; fragment token",
          ),
          exited: Promise.resolve(1),
          kill: () => undefined,
        }),
        timer: new ManualTimer(),
        now: () => 0,
      },
    );

    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error("Expected process failure.");
    for (const secret of [
      "signed basename",
      "private route",
      "private key",
      "query token",
      "fragment token",
    ]) expect(result.diagnostic).not.toContain(secret);
  });
});

describe("findExecutable", () => {
  test("searches PATH first, then user and Homebrew fallback directories", async () => {
    const checkedCandidates: string[] = [];
    const found = await findExecutable(
      "yt-dlp",
      {
        env: { PATH: "/custom/bin:/second/bin" },
        homeDirectory: "/Users/tester",
        platform: "darwin",
      },
      {
        isExecutableFile: (candidate) => {
          checkedCandidates.push(candidate);
          return Promise.resolve(candidate === "/opt/homebrew/bin/yt-dlp");
        },
      },
    );

    expect(found).toBe("/opt/homebrew/bin/yt-dlp");
    expect(checkedCandidates.slice(0, 5)).toEqual([
      "/custom/bin/yt-dlp",
      "/second/bin/yt-dlp",
      "/Users/tester/.local/bin/yt-dlp",
      "/Users/tester/bin/yt-dlp",
      "/Users/tester/.bun/bin/yt-dlp",
    ]);
    expect(checkedCandidates).toContain("/opt/homebrew/bin/yt-dlp");
  });

  test("rejects unsafe names and never treats an empty PATH entry as cwd", async () => {
    const checkedCandidates: string[] = [];
    const dependencies = {
      isExecutableFile: (candidate: string) => {
        checkedCandidates.push(candidate);
        return Promise.resolve(false);
      },
    };
    expect(await findExecutable("", {}, dependencies)).toBeNull();
    expect(await findExecutable("..", {}, dependencies)).toBeNull();
    await findExecutable(
      "ffmpeg",
      { env: { PATH: ":/usr/local/bin:" }, homeDirectory: "/home/test", platform: "linux" },
      dependencies,
    );
    expect(checkedCandidates).not.toContain("ffmpeg");
  });
});

describe("redaction", () => {
  test("removes sensitive switches, URL credentials, queries, headers, and explicit secrets", () => {
    const redacted = redactArguments([
      "yt-dlp",
      "--password=hunter2",
      "--cookies",
      "/tmp/private-cookies.txt",
      "https://me:pw@example.test/v?id=123&token=abc#private",
    ]);
    const diagnostic = redactDiagnostic(
      `Cookie: session=abc\n${redacted.join(" ")} api_key=key-value explicit-secret`,
      { secrets: ["explicit-secret"] },
    );

    expect(diagnostic).not.toContain("hunter2");
    expect(diagnostic).not.toContain("private-cookies");
    expect(diagnostic).not.toContain("me:pw");
    expect(diagnostic).not.toContain("id=123");
    expect(diagnostic).not.toContain("session=abc");
    expect(diagnostic).not.toContain("key-value");
    expect(diagnostic).not.toContain("explicit-secret");
  });

  test("removes an exact private URL before generic URL redaction can expose its path", () => {
    const privateUrl = "https://private.example/access-token-ABC/video?sig=SECRET";
    const diagnostic = redactDiagnostic(
      `failed ${privateUrl} via https://public.example/watch?id=visible-structure`,
      { secrets: [privateUrl] },
    );

    expect(diagnostic).toBe(
      "failed [REDACTED] via https://public.example/[REDACTED]",
    );
    expect(diagnostic).not.toContain("access-token-ABC");
    expect(diagnostic).not.toContain("SECRET");
    expect(diagnostic).not.toContain("visible-structure");
  });

  test("redacts exact private URLs in argv and handles contained secrets longest-first", () => {
    const privateUrl = "https://private.example/access-token-ABC/video?sig=SECRET";

    expect(redactArguments(
      ["yt-dlp", "--", privateUrl],
      ["access-token-ABC", privateUrl],
    )).toEqual(["yt-dlp", "--", "[REDACTED]"]);
    expect(redactDiagnostic(
      `${privateUrl} access-token-ABC`,
      { secrets: ["access-token-ABC", privateUrl] },
    )).toBe("[REDACTED] [REDACTED]");
  });

  test("removes OSC clipboard and hyperlink commands, CSI, C0, and C1 controls", () => {
    const dangerous = [
      "before",
      "\u001B]52;c;clipboard-secret\u0007",
      "\u001B]8;;https://evil.test/?token=hyperlink-secret\u001B\\click\u001B]8;;\u001B\\",
      "\u001B[2J",
      "\u009B31m",
      "after\r\ninjected\u0085",
    ].join(" ");
    const sanitized = sanitizeTerminalText(dangerous);

    expect(sanitized).toBe("before click after injected");
    expect(sanitized).not.toContain("clipboard-secret");
    expect(sanitized).not.toContain("hyperlink-secret");
    expect([...sanitized].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })).toBeTrue();
  });

  test("renders external multiline diagnostics as one inert redacted line", () => {
    const diagnostic = redactDiagnostic(
      "failed\r\n\u001B]52;c;clipboard-secret\u0007\u001B[2J https://example.test/v?session=url-secret",
    );
    expect(diagnostic).toBe("failed https://example.test/[REDACTED]");
    expect(diagnostic).not.toContain("clipboard-secret");
    expect(diagnostic).not.toContain("url-secret");
    expect(diagnostic).not.toContain("\n");
    expect(diagnostic).not.toContain("\r");
    expect(diagnostic).not.toContain("\u001B");
  });
});
