import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const DEFAULT_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_TERMINATE_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_DIAGNOSTIC_CODE_UNITS = 16 * 1024;
const MAX_URL_REDACTION_CODE_UNITS = 8 * 1024;
const MIN_DERIVED_URL_SECRET_CODE_UNITS = 4;

const SENSITIVE_SWITCHES = new Set([
  "--add-header",
  "--client-certificate",
  "--client-certificate-key",
  "--client-certificate-password",
  "--cookies",
  "--cookies-from-browser",
  "--http-header",
  "--netrc-location",
  "--password",
  "--proxy",
  "--username",
  "--video-password",
]);

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const HEADER_PATTERN = /\b(?:authorization|cookie|set-cookie|x-api-key)\s*:(?![ \t]*\[REDACTED\])[^\r\n]*/giu;
const KEY_VALUE_SECRET_PATTERN = /\b(?:access[_-]?token|api[_-]?key|auth(?:orization)?|cookie|password|passwd|secret|sig(?:nature)?|token)=([^\s&;]+)/giu;
const SWITCH_SECRET_PATTERN = /(--(?:add-header|client-certificate(?:-key|-password)?|cookies(?:-from-browser)?|http-header|netrc-location|password|proxy|username|video-password))(?:=|\s+)([^\s]+)/giu;
/* eslint-disable no-control-regex -- These are intentional ANSI C0/C1 terminal-control boundaries. */
const OSC_SEQUENCE_PATTERN = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C|$)/gu;
const ANSI_STRING_SEQUENCE_PATTERN = /(?:\u001B[P^_X]|[\u0090\u0098\u009E\u009F])[\s\S]*?(?:\u001B\\|\u009C|$)/gu;
const CSI_SEQUENCE_PATTERN = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
const TWO_BYTE_ESCAPE_PATTERN = /\u001B[@-_]/gu;
// Human diagnostics are deliberately one physical terminal line.
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/gu;
/* eslint-enable no-control-regex */
const DIAGNOSTIC_WHITESPACE_PATTERN = /\s+/gu;

export type CommandArgv = readonly [executable: string, ...arguments_: string[]];

export type ProcessSignal = "SIGTERM" | "SIGKILL";

export type SpawnedProcess = Readonly<{
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: (signal: ProcessSignal) => void;
}>;

export type ProcessSpawnOptions = Readonly<{
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type ProcessTimer = Readonly<{
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
}>;

export type ProcessDependencies = Readonly<{
  spawn: (argv: CommandArgv, options: ProcessSpawnOptions) => SpawnedProcess;
  timer: ProcessTimer;
  now: () => number;
}>;

export type RunProcessOptions = Readonly<{
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  terminateGraceMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  redactions?: readonly string[];
}>;

type ProcessOutput = Readonly<{
  command: readonly string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  elapsedMs: number;
}>;

export type ProcessSuccess = ProcessOutput &
  Readonly<{
    ok: true;
    exitCode: 0;
  }>;

export type ProcessFailureReason = "spawn" | "aborted" | "timeout" | "exit" | "io";

export type ProcessFailure = ProcessOutput &
  Readonly<{
    ok: false;
    reason: ProcessFailureReason;
    diagnostic: string;
  }>;

export type ProcessResult = ProcessSuccess | ProcessFailure;

export type ExecutableDiscoveryOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  extraDirectories?: readonly string[];
}>;

export type ExecutableDiscoveryDependencies = Readonly<{
  isExecutableFile: (path: string, platform: NodeJS.Platform) => Promise<boolean>;
}>;

type CaptureResult = Readonly<{
  text: string;
  truncated: boolean;
  error: string | null;
}>;

type Capture = Readonly<{
  result: Promise<CaptureResult>;
  cancel: () => Promise<void>;
}>;

type WaitResult<T> =
  | Readonly<{ kind: "value"; value: T }>
  | Readonly<{ kind: "error"; error: unknown }>
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ kind: "timeout" }>;

const defaultTimer: ProcessTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultProcessDependencies: ProcessDependencies = {
  spawn: (argv, options) => {
    const child = Bun.spawn([...argv], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      kill: (signal) => child.kill(signal),
    };
  },
  timer: defaultTimer,
  now: () => Date.now(),
};

const defaultDiscoveryDependencies: ExecutableDiscoveryDependencies = {
  isExecutableFile: async (path, platform) => {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) return false;
      await access(path, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Runs one executable directly. The first element is always passed to Bun.spawn
 * as an executable and no shell option exists at this boundary.
 */
export async function runProcess(
  argv: CommandArgv,
  options: RunProcessOptions = {},
  dependencies: ProcessDependencies = defaultProcessDependencies,
): Promise<ProcessResult> {
  const startedAt = dependencies.now();
  const command = redactArguments(argv, options.redactions);
  const stdoutLimit = normalizeByteLimit(
    options.maxStdoutBytes ?? options.maxOutputBytes,
    DEFAULT_STDOUT_LIMIT_BYTES,
  );
  const stderrLimit = normalizeByteLimit(
    options.maxStderrBytes ?? options.maxOutputBytes,
    DEFAULT_STDERR_LIMIT_BYTES,
  );
  const timeoutMs = normalizeDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const terminateGraceMs = normalizeDuration(
    options.terminateGraceMs,
    DEFAULT_TERMINATE_GRACE_MS,
  );
  const killGraceMs = normalizeDuration(options.killGraceMs, DEFAULT_KILL_GRACE_MS);

  if (options.signal?.aborted === true) {
    return {
      ok: false,
      reason: "aborted",
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      elapsedMs: elapsed(startedAt, dependencies.now()),
      diagnostic: redactDiagnostic(
        `${renderCommand(command)}: cancelled before the process started`,
        redactionOptions(options),
      ),
    };
  }

  let child: SpawnedProcess;
  try {
    child = dependencies.spawn(argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch (error) {
    const detail = redactDiagnostic(errorMessage(error), redactionOptions(options));
    const diagnostic = redactDiagnostic(
      `Could not start ${renderCommand(command)}: ${detail}`,
      redactionOptions(options),
    );
    return {
      ok: false,
      reason: "spawn",
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      elapsedMs: elapsed(startedAt, dependencies.now()),
      diagnostic,
    };
  }

  const stdoutCapture = captureBounded(child.stdout, stdoutLimit);
  const stderrCapture = captureBounded(child.stderr, stderrLimit);
  let termination: "aborted" | "timeout" | null = null;
  let exitResult = await waitFor(
    child.exited,
    timeoutMs,
    dependencies.timer,
    options.signal,
  );

  if (exitResult.kind === "timeout" || exitResult.kind === "aborted") {
    termination = exitResult.kind;
    safelyKill(child, "SIGTERM");
    exitResult = await waitFor(child.exited, terminateGraceMs, dependencies.timer);
    if (exitResult.kind === "timeout") {
      safelyKill(child, "SIGKILL");
      exitResult = await waitFor(child.exited, killGraceMs, dependencies.timer);
    }
  }

  const captures = Promise.all([stdoutCapture.result, stderrCapture.result] as const);
  if (exitResult.kind === "timeout") {
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
  } else {
    const drained = await waitFor(captures, killGraceMs, dependencies.timer);
    if (drained.kind === "timeout") {
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    }
  }

  const [stdout, stderr] = await captures;
  const exitCode = exitResult.kind === "value" ? exitResult.value : null;
  const output: ProcessOutput = {
    command,
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    elapsedMs: elapsed(startedAt, dependencies.now()),
  };

  if (termination === null && exitResult.kind === "value" && exitCode === 0 && stdout.error === null && stderr.error === null) {
    return { ...output, ok: true, exitCode: 0 };
  }

  const reason: ProcessFailureReason = termination
    ?? (
      exitResult.kind === "error" || stdout.error !== null || stderr.error !== null
        ? "io"
        : "exit"
    );
  const failureDetail = failureDetailFor(reason, exitCode, stdout, stderr, exitResult);
  return {
    ...output,
    ok: false,
    reason,
    diagnostic: redactDiagnostic(
      `${renderCommand(command)}: ${failureDetail}`,
      redactionOptions(options),
    ),
  };
}

/** Finds an executable without invoking a shell or executing the candidate. */
export async function findExecutable(
  name: string,
  options: ExecutableDiscoveryOptions = {},
  dependencies: ExecutableDiscoveryDependencies = defaultDiscoveryDependencies,
): Promise<string | null> {
  if (!isSafeExecutableName(name)) return null;

  const platform = options.platform ?? process.platform;
  if (name.includes("/") || name.includes("\\")) {
    return (await dependencies.isExecutableFile(name, platform)) ? name : null;
  }

  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirectories = pathValue.split(delimiter).filter((entry) => entry.length > 0);
  const directories = unique([
    ...pathDirectories,
    ...(options.extraDirectories ?? []),
    ...commonExecutableDirectories(homeDirectory, platform),
  ]);
  const names = executableNames(name, env, platform);

  for (const directory of directories) {
    for (const candidateName of names) {
      const candidate = join(directory, candidateName);
      if (await dependencies.isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** Redacts argv while preserving enough structure for useful diagnostics. */
export function redactArguments(
  argv: readonly string[],
  additionalSecrets: readonly string[] = [],
): readonly string[] {
  const redacted: string[] = [];
  let redactNext = false;

  for (const argument of argv) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }

    const equalsIndex = argument.indexOf("=");
    const switchName = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (SENSITIVE_SWITCHES.has(switchName)) {
      if (equalsIndex === -1) {
        redacted.push(argument);
        redactNext = true;
      } else {
        redacted.push(`${switchName}=[REDACTED]`);
      }
      continue;
    }

    redacted.push(redactDiagnostic(argument, { secrets: additionalSecrets }));
  }
  return redacted;
}

/**
 * Derives bounded exact secrets that a downloader may echo without the URL
 * wrapper (for example a Generic extractor's basename-derived id or title).
 */
export function urlDerivedRedactions(value: string): readonly string[] {
  if (value.length === 0 || value.length > MAX_URL_REDACTION_CODE_UNITS) return [];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];

  const candidates: string[] = [];
  const add = (candidate: string): void => {
    if (
      candidate.length >= MIN_DERIVED_URL_SECRET_CODE_UNITS
      && candidate.length <= MAX_URL_REDACTION_CODE_UNITS
      && sanitizeTerminalText(candidate) === candidate
    ) candidates.push(candidate);
  };
  const addRawDecodedAndStem = (candidate: string): void => {
    add(candidate);
    const lastDot = candidate.lastIndexOf(".");
    if (lastDot > 0) add(candidate.slice(0, lastDot));
    try {
      const decoded = decodeURIComponent(candidate);
      add(decoded);
      const decodedLastDot = decoded.lastIndexOf(".");
      if (decodedLastDot > 0) add(decoded.slice(0, decodedLastDot));
    } catch {
      // Malformed percent encoding has no safe decoded variant.
    }
  };

  const rawSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  for (const segment of rawSegments) addRawDecodedAndStem(segment);
  const rawPath = rawSegments.join("/");
  if (rawSegments.length > 1) addRawDecodedAndStem(rawPath);
  for (const component of url.search.slice(1).split("&")) {
    if (component.length === 0) continue;
    const equals = component.indexOf("=");
    const rawKey = equals === -1 ? component : component.slice(0, equals);
    const rawValue = equals === -1 ? "" : component.slice(equals + 1);
    addRawDecodedAndStem(rawKey);
    addRawDecodedAndStem(rawValue);
  }
  for (const [queryKey, queryValue] of url.searchParams) {
    addRawDecodedAndStem(queryKey);
    addRawDecodedAndStem(queryValue);
  }
  addRawDecodedAndStem(url.hash.slice(1));
  addRawDecodedAndStem(url.username);
  addRawDecodedAndStem(url.password);
  return [...new Set(candidates)].toSorted((left, right) => right.length - left.length);
}

/** Sanitizes text before it crosses the human/JSON diagnostic boundary. */
export function redactDiagnostic(
  input: string,
  options: Readonly<{
    secrets?: readonly string[];
    homeDirectory?: string;
    maxCodeUnits?: number;
  }> = {},
): string {
  // Exact caller-provided values can contain material that the generic passes
  // deliberately rewrite, such as a private URL whose query is removed while
  // a path token remains. Remove exact values first so later normalization
  // cannot destroy the match and expose only part of the secret.
  let output = redactExactSecrets(input, options.secrets ?? []);
  output = redactSensitivePatterns(output);
  output = redactInlineSensitivePatterns(sanitizeTerminalText(output));
  if (options.homeDirectory !== undefined && options.homeDirectory.length > 1) {
    output = output.split(options.homeDirectory).join("~");
  }

  // Explicit redaction strings and home paths are caller-controlled. A final
  // terminal pass makes the invariant independent of their contents.
  output = sanitizeTerminalText(output);

  const limit = normalizeDiagnosticLimit(options.maxCodeUnits);
  return output.length <= limit ? output : `${output.slice(0, limit)}…[truncated]`;
}

function redactExactSecrets(input: string, secrets: readonly string[]): string {
  let output = input;
  const longestFirst = [...new Set(secrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of longestFirst) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function redactSensitivePatterns(input: string): string {
  return redactInlineSensitivePatterns(
    input.replace(HEADER_PATTERN, (value) => `${value.slice(0, value.indexOf(":"))}: [REDACTED]`),
  );
}

function redactInlineSensitivePatterns(input: string): string {
  return input
    .replace(URL_PATTERN, (value) => redactUrl(value))
    .replace(SWITCH_SECRET_PATTERN, (_match, switchName: string) => `${switchName} [REDACTED]`)
    .replace(KEY_VALUE_SECRET_PATTERN, (match) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`);
}

/**
 * Converts untrusted text into one inert terminal line. OSC payloads (including
 * clipboard and hyperlink commands), CSI commands, ANSI string controls, C0,
 * and C1 controls are removed before whitespace is collapsed.
 */
export function sanitizeTerminalText(input: string): string {
  return input
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(ANSI_STRING_SEQUENCE_PATTERN, "")
    .replace(CSI_SEQUENCE_PATTERN, "")
    .replace(TWO_BYTE_ESCAPE_PATTERN, "")
    .replace(TERMINAL_CONTROL_PATTERN, " ")
    .replace(DIAGNOSTIC_WHITESPACE_PATTERN, " ")
    .trim();
}

/** The fixed fallback locations searched after the caller's PATH. */
export function commonExecutableDirectories(
  homeDirectory: string,
  platform: NodeJS.Platform,
): readonly string[] {
  const userDirectories = [
    join(homeDirectory, ".local", "bin"),
    join(homeDirectory, "bin"),
    join(homeDirectory, ".bun", "bin"),
  ];
  if (platform === "win32") return userDirectories;
  return unique([
    ...userDirectories,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/local/bin",
    "/usr/bin",
    "/bin",
  ]);
}

function captureBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Capture {
  if (stream === null) {
    return {
      result: Promise.resolve({ text: "", truncated: false, error: null }),
      cancel: () => Promise.resolve(),
    };
  }

  const reader = stream.getReader();
  let canceled = false;
  const result = (async (): Promise<CaptureResult> => {
    const chunks: Uint8Array[] = [];
    let storedBytes = 0;
    let truncated = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (chunk.byteLength === 0) continue;
        const remaining = limit - storedBytes;
        if (remaining > 0) {
          const kept = chunk.byteLength <= remaining ? chunk.slice() : chunk.slice(0, remaining);
          chunks.push(kept);
          storedBytes += kept.byteLength;
        }
        if (chunk.byteLength > remaining) truncated = true;
      }
      return {
        text: decodeChunks(chunks, storedBytes),
        truncated: truncated || canceled,
        error: null,
      };
    } catch (error) {
      if (canceled) {
        return { text: decodeChunks(chunks, storedBytes), truncated: true, error: null };
      }
      return {
        text: decodeChunks(chunks, storedBytes),
        truncated,
        error: errorMessage(error),
      };
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    result,
    cancel: async () => {
      canceled = true;
      try {
        await reader.cancel("process did not exit after SIGKILL");
      } catch {
        // A stream may already be closed between timeout observation and cancel.
      }
    },
  };
}

function decodeChunks(chunks: readonly Uint8Array[], byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function waitFor<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timer: ProcessTimer,
  signal?: AbortSignal,
): Promise<WaitResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timerHandle: { value: unknown } = { value: undefined };
    const finish = (result: WaitResult<T>): void => {
      if (settled) return;
      settled = true;
      timer.clear(timerHandle.value);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => finish({ kind: "aborted" });
    timerHandle.value = timer.set(() => finish({ kind: "timeout" }), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      finish({ kind: "aborted" });
      return;
    }

    promise.then(
      (value) => finish({ kind: "value", value }),
      (error: unknown) => finish({ kind: "error", error }),
    );
  });
}

function failureDetailFor(
  reason: ProcessFailureReason,
  exitCode: number | null,
  stdout: CaptureResult,
  stderr: CaptureResult,
  exitResult: WaitResult<number>,
): string {
  if (reason === "aborted") return "was cancelled and terminated";
  if (reason === "timeout") return "timed out and was terminated";
  if (exitResult.kind === "error") return `could not observe process exit: ${errorMessage(exitResult.error)}`;
  if (stdout.error !== null) return `could not read stdout: ${stdout.error}`;
  if (stderr.error !== null) return `could not read stderr: ${stderr.error}`;
  const stderrSummary = stderr.text.trim();
  const suffix = stderrSummary.length === 0 ? "" : `; stderr: ${stderrSummary}`;
  return `exited with code ${String(exitCode)}${suffix}`;
}

function safelyKill(child: SpawnedProcess, signal: ProcessSignal): void {
  try {
    child.kill(signal);
  } catch {
    // The process can exit between the timeout race and signal delivery.
  }
}

function normalizeByteLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_OUTPUT_LIMIT_BYTES);
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_TIMEOUT_MS);
}

function normalizeDiagnosticLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_DIAGNOSTIC_CODE_UNITS;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_DIAGNOSTIC_CODE_UNITS);
}

function elapsed(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.trunc(finishedAt - startedAt));
}

function renderCommand(argv: readonly string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(" ");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown process error";
}

function homeFromOptions(options: RunProcessOptions): string | undefined {
  const candidate = options.env?.HOME;
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
}

function redactionOptions(options: RunProcessOptions): Readonly<{
  secrets?: readonly string[];
  homeDirectory?: string;
}> {
  const homeDirectory = homeFromOptions(options);
  return {
    ...(options.redactions === undefined ? {} : { secrets: options.redactions }),
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  };
}

function isSafeExecutableName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("\0");
}

function executableNames(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== "win32" || /\.[a-z0-9]+$/iu.test(name)) return [name];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.length > 0);
  return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`)];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}/[REDACTED]`;
  } catch {
    return "[REDACTED URL]";
  }
}
