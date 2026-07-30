import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  acquireCookieRecords,
  agentBrowserCommand as packageAgentBrowserCommand,
  browserCookieCommands,
  browserProxyArguments,
  type CookieRecordReader,
} from "@hraness/kb/clip/acquire";
import { BoundedByteBuffer } from "@hraness/kb/clip/bounded-byte-buffer";
import {
  cloneBrowserProfile,
  cloneProfile,
  copyBoundedLocalState,
  isSafeNamedProfile,
  profilePath,
  type ClonedBrowserProfile,
} from "@hraness/kb/browser-profiles";
import { startNetworkProxy, type LocalNetworkProxy } from "@hraness/kb/clip/network-proxy";
import { redactSensitiveText } from "@hraness/kb/clip/persist";
import { sanitizeTerminalLine } from "@hraness/kb/clip/terminal";
import type { WrenchAuth } from "./auth";
import type { OperationDeadline } from "./operation-deadline";
import type {
  BrowserRecipe,
  FileInputValue,
  OperationInput,
  WrenchManifest,
} from "./model";
import { DOM_ACTION_TRANSPORT_DISABLED_MESSAGE } from "./transport-policy";

type JsonRecord = Record<string, unknown>;

/** Browser recipes are never an action transport for registered signed-in sites. */
export function assertBrowserManifestOriginPolicy(
  manifest: WrenchManifest,
  isProtectedHostname: (hostname: string) => boolean,
): void {
  for (const domain of manifest.browserDomains) {
    if (isProtectedHostname(domain)) {
      throw new Error(
        `scripted browser actions are prohibited on protected signed-in site domain ${domain}; use a code-owned schemaVersion 3 official provider or schemaVersion 4 authenticated internal API`,
      );
    }
  }
  for (const origin of manifest.origins) {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      throw new Error("browser action manifest contains an invalid origin");
    }
    if (isProtectedHostname(hostname)) {
      throw new Error(
        `scripted browser actions are prohibited on protected signed-in site hostname ${hostname}; use a code-owned schemaVersion 3 official provider or schemaVersion 4 authenticated internal API`,
      );
    }
  }
}

export type BrowserExecution = {
  readonly status: "succeeded" | "failed" | "partial" | "indeterminate";
  readonly output: unknown;
  readonly finalUrl: string | null;
  readonly dispatchStarted: boolean;
  readonly dispatch: {
    readonly planned: number;
    readonly started: number;
    readonly verified: number;
  };
  readonly error?: string;
  readonly privateArtifactsPreserved?: boolean;
  readonly recoveryHandle?: string;
};

export type BrowserDispatchEvent = {
  readonly id: string;
  readonly index: number;
  readonly progress: BrowserExecution["dispatch"];
};

export type BrowserFileResolver = (
  files: readonly FileInputValue[],
) => Promise<readonly string[]>;

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type BrowserSession = {
  readonly runBatch: (commands: readonly (readonly string[])[], timeoutMs: number, maxOutputBytes: number) => Promise<readonly JsonRecord[]>;
  /** Waits for every in-flight batch to settle before closing the browser. */
  readonly close: () => Promise<void>;
  /** Refuses to touch private resources until close has been verified. */
  readonly cleanup: () => Promise<void>;
  readonly recoveryHandle?: string;
  readonly cleanupResourceIdentity?: BrowserCleanupResourceIdentity;
};

type BrowserPrivateArtifactRemover = (path: string) => void;

export type BrowserSessionDependencies = {
  /** Abort-aware runner that settles only after its child process tree is reaped. */
  readonly runCommand: typeof runCommand;
  readonly startNetworkProxy: typeof startNetworkProxy;
  readonly acquireCookieRecords: CookieRecordReader;
  /** Internal deterministic seam for independently removing owned private roots. */
  readonly removePrivateArtifact: BrowserPrivateArtifactRemover;
};

/** Provider-neutral borrowed operation budget used by browser bootstraps. */
export type BrowserOperationDeadline = Pick<
  OperationDeadline,
  "signal" | "remainingTimeMs" | "run" | "throwIfUnavailable"
>;

export type CreateBrowserSessionOptions = {
  readonly headed: boolean;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Kernel-owned total budget. Browser setup borrows and never disposes it. */
  readonly operationDeadline?: BrowserOperationDeadline;
  /**
   * Internal code-owned resolvers may opt into the pinned evaluate command.
   * Manifest recipes and derivation must never populate this option.
   */
  readonly allowCodeOwnedEvaluation?: true;
  /**
   * Internal code-owned bootstraps may inspect bounded request metadata while
   * discovering a current first-party operation revision. Raw observations
   * must be projected before they leave the provider module.
   */
  readonly allowCodeOwnedNetworkObservation?: true;
  /**
   * Persists the exact private roots before a proxy or browser can launch.
   * Throwing prevents resource activation and rolls the unpublished roots
   * back.
   */
  readonly publishCleanupResource?: (
    resource: BrowserCleanupResourceIdentity,
  ) => void;
  readonly dependencies?: Partial<BrowserSessionDependencies>;
};

export type BrowserPrivateDirectoryIdentity = {
  readonly device: string;
  readonly inode: string;
};

export type BrowserCleanupResourceIdentity = {
  readonly kind: "agent-browser-session-v1";
  readonly recoveryHandle: string;
  readonly session: string;
  readonly socketDirectory: string;
  readonly socketDirectoryIdentity: BrowserPrivateDirectoryIdentity;
  readonly artifactsDirectory: string;
  readonly artifactsDirectoryIdentity: BrowserPrivateDirectoryIdentity;
};

export type BrowserClosedCleanupEvidence = {
  readonly kind: "agent-browser-closed-artifacts-v1";
  readonly resource: BrowserCleanupResourceIdentity;
};

export class PreservedBrowserArtifactsError extends Error {
  readonly recoveryHandle: string;
  readonly cleanupEvidence?: BrowserClosedCleanupEvidence;

  constructor(
    message: string,
    recoveryHandle: string,
    cause: unknown,
    cleanupEvidence?: BrowserClosedCleanupEvidence,
  ) {
    super(message, { cause });
    this.name = "PreservedBrowserArtifactsError";
    this.recoveryHandle = recoveryHandle;
    if (cleanupEvidence !== undefined) {
      this.cleanupEvidence = cleanupEvidence;
    }
  }
}

class BrowserCommandCleanupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserCommandCleanupError";
  }
}

function recoveryHandleComponent(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Fixed-order v1 recovery handle. Every value is unpadded base64url-encoded
 * UTF-8, so valid POSIX and Windows paths remain unambiguous and transport-safe.
 * An empty socket value means setup failed before a socket root was created.
 */
export function browserRecoveryHandle(input: {
  readonly session: string;
  readonly configPath: string;
  readonly socketDirectory: string | null;
  readonly artifactsDirectory: string;
}): string {
  return [
    "v1",
    `session=${recoveryHandleComponent(input.session)}`,
    `config=${recoveryHandleComponent(input.configPath)}`,
    `socket=${input.socketDirectory === null
      ? ""
      : recoveryHandleComponent(input.socketDirectory)}`,
    `artifacts=${recoveryHandleComponent(input.artifactsDirectory)}`,
  ].join(";");
}

const encodedRecoveryHandleComponentPattern = /^[A-Za-z0-9_-]{1,4096}$/u;
const browserSessionPattern = /^io-([1-9][0-9]{0,9})-[a-f0-9-]{12}$/u;

function decodeRecoveryHandleComponent(
  value: string,
  label: string,
): string {
  if (!encodedRecoveryHandleComponentPattern.test(value)) {
    throw new Error(`browser recovery ${label} is malformed`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new Error(`browser recovery ${label} is not canonical`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new Error(`browser recovery ${label} is not UTF-8`);
  }
  if (decoded === "" || decoded.includes("\0")) {
    throw new Error(`browser recovery ${label} is malformed`);
  }
  return decoded;
}

function canonicalAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`browser recovery ${label} is not canonical`);
  }
  return value;
}

export function parseBrowserRecoveryHandle(
  value: string,
): {
  readonly session: string;
  readonly configPath: string;
  readonly socketDirectory: string;
  readonly artifactsDirectory: string;
} {
  if (value.length < 1 || value.length > 16 * 1024) {
    throw new Error("browser recovery handle is malformed");
  }
  const parts = value.split(";");
  if (
    parts.length !== 5
    || parts[0] !== "v1"
    || !parts[1]?.startsWith("session=")
    || !parts[2]?.startsWith("config=")
    || !parts[3]?.startsWith("socket=")
    || !parts[4]?.startsWith("artifacts=")
  ) {
    throw new Error("browser recovery handle is malformed");
  }
  const session = decodeRecoveryHandleComponent(
    parts[1].slice("session=".length),
    "session",
  );
  if (!browserSessionPattern.test(session)) {
    throw new Error("browser recovery session is malformed");
  }
  const configPath = canonicalAbsolutePath(
    decodeRecoveryHandleComponent(
      parts[2].slice("config=".length),
      "config path",
    ),
    "config path",
  );
  const encodedSocket = parts[3].slice("socket=".length);
  if (encodedSocket === "") {
    throw new Error("browser recovery socket directory is unavailable");
  }
  const socketDirectory = canonicalAbsolutePath(
    decodeRecoveryHandleComponent(encodedSocket, "socket directory"),
    "socket directory",
  );
  const artifactsDirectory = canonicalAbsolutePath(
    decodeRecoveryHandleComponent(
      parts[4].slice("artifacts=".length),
      "artifacts directory",
    ),
    "artifacts directory",
  );
  if (
    basename(socketDirectory).match(/^io-ab-[A-Za-z0-9_-]{6,64}$/u) === null
    || dirname(socketDirectory) !== "/tmp"
    || basename(artifactsDirectory).match(
      /^io-browser-[A-Za-z0-9_-]{6,64}$/u,
    ) === null
    || dirname(artifactsDirectory) !== resolve(tmpdir())
    || configPath !== join(artifactsDirectory, "agent-browser.json")
    || dirname(configPath) !== artifactsDirectory
  ) {
    throw new Error("browser recovery handle does not bind owned private roots");
  }
  return Object.freeze({
    session,
    configPath,
    socketDirectory,
    artifactsDirectory,
  });
}

function privateBrowserDirectoryIdentity(
  path: string,
): BrowserPrivateDirectoryIdentity {
  const stats = lstatSync(path, { bigint: true });
  const currentUid = process.getuid?.();
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || (stats.mode & 0o077n) !== 0n
    || (
      currentUid !== undefined
      && stats.uid !== BigInt(currentUid)
    )
  ) {
    throw new Error("browser cleanup resource is not a private owned directory");
  }
  return Object.freeze({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
  });
}

function browserCleanupResourceIdentity(input: {
  readonly recoveryHandle: string;
  readonly session: string;
  readonly socketDirectory: string;
  readonly artifactsDirectory: string;
}): BrowserCleanupResourceIdentity {
  const parsed = parseBrowserRecoveryHandle(input.recoveryHandle);
  if (
    parsed.session !== input.session
    || parsed.socketDirectory !== input.socketDirectory
    || parsed.artifactsDirectory !== input.artifactsDirectory
  ) {
    throw new Error("browser cleanup resource does not match its recovery handle");
  }
  return Object.freeze({
    kind: "agent-browser-session-v1",
    recoveryHandle: input.recoveryHandle,
    session: parsed.session,
    socketDirectory: parsed.socketDirectory,
    socketDirectoryIdentity: privateBrowserDirectoryIdentity(
      parsed.socketDirectory,
    ),
    artifactsDirectory: parsed.artifactsDirectory,
    artifactsDirectoryIdentity: privateBrowserDirectoryIdentity(
      parsed.artifactsDirectory,
    ),
  });
}

/**
 * Observe a browser-backed operation until teardown finishes. Ordinary
 * operation failures are already reported by the provider; only an unsafe
 * cleanup rejects this distinct quiescence barrier.
 */
export function browserCleanupBarrier(
  operation: Promise<unknown>,
): Promise<void> {
  return operation.then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof PreservedBrowserArtifactsError) throw error;
    },
  );
}

export function classifyBrowserProcessGroupProbe(
  status: number | null,
  stderr: string,
): "live" | "gone" | "unknown" {
  if (status === 0) return "live";
  if (status === 1 && stderr.includes("No such process")) return "gone";
  if (status === 1 && stderr.includes("Operation not permitted")) return "live";
  return "unknown";
}

const inheritedProxyKeys = new Set([
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

/** Exact policy vocabulary required by the pinned agent-browser release. */
export const runtimeBrowserPolicyActions = [
  "launch", "navigate", "snapshot", "click", "fill", "scroll", "wait", "read", "get", "interact", "state",
  "type", "hover", "focus", "press", "url", "inputvalue", "waitfortext", "waitforurl", "cookies_set", "close",
  "upload", "select", "check", "uncheck", "ischecked",
  "getbyrole", "getbytext", "getbylabel", "getbyplaceholder", "getbyalttext", "getbytitle", "getbytestid",
] as const;

export function agentBrowserCommand(): readonly string[] {
  return packageAgentBrowserCommand();
}

export function isolatedEnvironment(socketDirectory: string): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("AGENT_BROWSER_") || inheritedProxyKeys.has(key)) continue;
    output[key] = value;
  }
  output.AGENT_BROWSER_SOCKET_DIR = socketDirectory;
  return output;
}

const BROWSER_COMMAND_RESOURCE_SETTLEMENT_TIMEOUT_MS = 1_000;

async function promiseSettlesWithin(
  promise: Promise<unknown>,
  maximumMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => true as const,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), maximumMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  cancellation: AbortSignal,
): Promise<string> {
  const bytes = new BoundedByteBuffer(maxBytes);
  const reader = stream.getReader();
  const cancel = (): void => {
    void reader.cancel("browser command was terminated").catch(() => undefined);
  };
  cancellation.addEventListener("abort", cancel, { once: true });
  try {
    if (cancellation.aborted) cancel();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (!bytes.append(result.value)) {
        throw new Error(`process output exceeded ${maxBytes} bytes`);
      }
    }
  } finally {
    cancellation.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.toUint8Array());
}

export async function runCommand(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly stdin?: string;
    readonly signal?: AbortSignal;
  },
): Promise<CommandResult> {
  if (process.platform === "win32") {
    throw new Error(
      "contained browser commands require process-tree containment that is unavailable on Windows",
    );
  }
  const isCancelled = (): boolean => options.signal?.aborted === true;
  if (isCancelled()) {
    throw new Error("agent-browser command was cancelled");
  }
  const ownsProcessGroup = true;
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    detached: ownsProcessGroup,
    env: options.environment,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let childExited = false;
  const exited = child.exited.then((exitCode) => {
    childExited = true;
    return exitCode;
  });
  const outputCancellation = new AbortController();
  const signalProcessTree = (signal: "SIGTERM" | "SIGKILL"): void => {
    if (ownsProcessGroup) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The group may have exited between inspection and signaling.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Killing an already-exited direct child is harmless.
    }
  };
  const processTreeIsLive = (): boolean => {
    if (!ownsProcessGroup) return !childExited;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ESRCH"
      ) return false;
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "EPERM"
      ) {
        const probe = spawnSync(
          "/bin/kill",
          ["-0", `-${child.pid}`],
          {
            encoding: "utf8",
            env: {
              LANG: "C",
              LC_ALL: "C",
              NODE_ENV: "production",
              PATH: "/usr/bin:/bin",
            },
          },
        );
        if (probe.error === undefined) {
          const result = classifyBrowserProcessGroupProbe(
            probe.status,
            probe.stderr,
          );
          if (result === "live") return true;
          if (result === "gone") return false;
        }
      }
      // An ambiguous process-group probe must never be treated as safe exit.
      return true;
    }
  };
  const waitUntilStopped = async (maximumMs: number): Promise<boolean> => {
    const deadline = performance.now() + maximumMs;
    for (;;) {
      if (!processTreeIsLive()) return true;
      if (performance.now() >= deadline) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  };
  const terminate = async (): Promise<void> => {
    signalProcessTree("SIGTERM");
    if (!await waitUntilStopped(1_000)) {
      signalProcessTree("SIGKILL");
      if (!await waitUntilStopped(1_000)) {
        throw new BrowserCommandCleanupError(
          "agent-browser process group survived forced termination",
        );
      }
    }
  };
  const state: {
    failure: Error | null;
    termination: Promise<void> | null;
  } = {
    failure: null,
    termination: null,
  };
  let rejectForStop: ((error: Error) => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectForStop = reject;
  });
  const requestStop = (error: Error): void => {
    if (state.failure !== null) return;
    state.failure = error;
    outputCancellation.abort();
    state.termination = terminate();
    void state.termination.catch(() => undefined);
    rejectForStop?.(error);
  };
  const onAbort = (): void => {
    requestStop(new Error("agent-browser command was cancelled"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (isCancelled()) onAbort();
  const timeout = setTimeout(() => {
    requestStop(new Error(`agent-browser timed out after ${options.timeoutMs}ms`));
  }, options.timeoutMs);
  const stdout = readBoundedStream(
    child.stdout,
    options.maxOutputBytes,
    outputCancellation.signal,
  ).catch((error: unknown) => {
    requestStop(error instanceof Error ? error : new Error(String(error)));
    throw error;
  });
  const stderr = readBoundedStream(
    child.stderr,
    Math.min(options.maxOutputBytes, 2 * 1024 * 1024),
    outputCancellation.signal,
  ).catch((error: unknown) => {
    requestStop(error instanceof Error ? error : new Error(String(error)));
    throw error;
  });
  const completed = Promise.all([stdout, stderr, exited]);
  try {
    const [stdoutText, stderrText, exitCode] = await Promise.race([
      completed,
      stopped,
    ]);
    if (state.failure !== null) throw state.failure;
    return { stdout: stdoutText, stderr: stderrText, exitCode };
  } catch (error) {
    requestStop(error instanceof Error ? error : new Error(String(error)));
    let terminationFailure: unknown;
    try {
      await state.termination;
    } catch (terminationError) {
      terminationFailure = terminationError;
    }
    if (terminationFailure !== undefined) child.unref();
    const resourcesSettled = await promiseSettlesWithin(
      Promise.allSettled([stdout, stderr, exited]),
      BROWSER_COMMAND_RESOURCE_SETTLEMENT_TIMEOUT_MS,
    );
    if (!resourcesSettled) child.unref();
    if (terminationFailure !== undefined) {
      throw terminationFailure instanceof BrowserCommandCleanupError
        ? terminationFailure
        : new BrowserCommandCleanupError(
            "agent-browser termination failed",
            terminationFailure,
          );
    }
    if (!resourcesSettled) {
      throw new BrowserCommandCleanupError(
        "agent-browser resources did not settle after process termination",
      );
    }
    const failure = state.failure ?? error;
    const normalizedFailure = failure instanceof Error
      ? failure
      : new Error(String(failure));
    if (normalizedFailure instanceof BrowserCommandCleanupError) {
      throw normalizedFailure;
    }
    // A POSIX process group cannot prove that a descendant did not call
    // setsid(2) and become reparented before termination began. Any command
    // that required forced stopping therefore has an unprovable containment
    // boundary even when its original process group and streams are gone.
    throw new BrowserCommandCleanupError(
      `${normalizedFailure.message}; descendant process cleanup could not be verified`,
      normalizedFailure,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function parseLastJson(output: string): unknown {
  let lineEnd = output.length;
  while (lineEnd >= 0) {
    const newline = output.lastIndexOf("\n", lineEnd - 1);
    const line = output.slice(newline + 1, lineEnd).trim();
    lineEnd = newline;
    if (line.startsWith("[") || line.startsWith("{")) {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        // Continue past diagnostics emitted before the JSON result.
      }
    }
  }
  throw new Error("agent-browser did not return JSON");
}

export function agentBrowserFailure(result: CommandResult, context: string): Error {
  let detail: string | null = null;
  try {
    const parsed = parseLastJson(result.stdout);
    const failures = Array.isArray(parsed) ? parsed : [parsed];
    for (const failure of failures) {
      if (typeof failure !== "object" || failure === null || Array.isArray(failure)) continue;
      const record = failure as Record<string, unknown>;
      if (record.success === false && typeof record.error === "string") {
        detail = sanitizeTerminalLine(redactSensitiveText(record.error)).slice(0, 1_000);
        break;
      }
    }
  } catch {
    // A structured error is optional; never echo arbitrary stdout or stderr.
  }
  return new Error(`${context} failed with exit code ${result.exitCode}${detail === null || detail === "" ? "" : `: ${detail}`}`);
}

function parsedBatch(output: string, expected: number): readonly JsonRecord[] {
  const parsed = parseLastJson(output);
  if (!Array.isArray(parsed) || parsed.length !== expected) throw new Error("agent-browser returned a malformed batch result");
  const records: JsonRecord[] = [];
  for (const value of parsed) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("agent-browser returned a malformed batch entry");
    records.push(value as JsonRecord);
  }
  return records;
}

export {
  cloneBrowserProfile,
  cloneProfile,
  copyBoundedLocalState,
  isSafeNamedProfile,
  profilePath,
};
export type { ClonedBrowserProfile };

export function browserResultData(record: JsonRecord): unknown {
  if (record.success !== true) {
    const error = typeof record.error === "string" ? record.error : "agent-browser command failed";
    throw new Error(error);
  }
  if (Object.hasOwn(record, "result")) return record.result;
  if (Object.hasOwn(record, "data")) return record.data;
  throw new Error("agent-browser command omitted its result");
}

const BROWSER_SETUP_DEADLINE_LABEL = "browser session setup";
const BROWSER_CLOSE_TEARDOWN_TIMEOUT_MS = 17_500;
const BROWSER_RESOURCE_TEARDOWN_TIMEOUT_MS = 2_000;
const BROWSER_ACTIVE_BATCH_SETTLEMENT_TIMEOUT_MS = 2_500;

function guardBrowserSetup(deadline: BrowserOperationDeadline | undefined): void {
  deadline?.throwIfUnavailable(BROWSER_SETUP_DEADLINE_LABEL);
}

function remainingBrowserSetupTime(
  requestedTimeoutMs: number,
  deadline: BrowserOperationDeadline | undefined,
): number {
  if (deadline === undefined) return requestedTimeoutMs;
  deadline.throwIfUnavailable(BROWSER_SETUP_DEADLINE_LABEL);
  const remaining = Math.min(requestedTimeoutMs, deadline.remainingTimeMs());
  if (remaining < 1) {
    deadline.throwIfUnavailable(BROWSER_SETUP_DEADLINE_LABEL);
    throw new Error(`${BROWSER_SETUP_DEADLINE_LABEL} timed out`);
  }
  return remaining;
}

function runBrowserSetupStep<T>(
  deadline: BrowserOperationDeadline | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (deadline === undefined) return work();
  deadline.throwIfUnavailable(BROWSER_SETUP_DEADLINE_LABEL);
  return deadline.run(
    () => work(),
    BROWSER_SETUP_DEADLINE_LABEL,
  );
}

async function teardownCompletesWithin(
  teardown: Promise<unknown>,
  maximumMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = teardown.then(
    () => true as const,
    () => false as const,
  );
  try {
    return await Promise.race([
      observed,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), maximumMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function removePrivateArtifacts(
  paths: readonly (string | null)[],
  remove: BrowserPrivateArtifactRemover,
): readonly unknown[] {
  const failures: unknown[] = [];
  for (const path of paths) {
    if (path === null) continue;
    try {
      remove(path);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function cleanupFailureCause(
  operationFailure: unknown,
  cleanupFailures: readonly unknown[],
): unknown {
  if (cleanupFailures.length === 0) return operationFailure;
  return new AggregateError(
    [operationFailure, ...cleanupFailures],
    "browser private-artifact cleanup failed",
  );
}

export async function createBrowserSession(
  manifest: WrenchManifest,
  auth: WrenchAuth,
  options: CreateBrowserSessionOptions,
): Promise<BrowserSession> {
  if (process.platform === "win32") {
    throw new Error(
      "contained browser sessions require process-tree containment that is unavailable on Windows",
    );
  }
  const operationDeadline = options.operationDeadline;
  guardBrowserSetup(operationDeadline);
  const runBrowserCommand = options.dependencies?.runCommand ?? runCommand;
  const createNetworkProxy = options.dependencies?.startNetworkProxy ?? startNetworkProxy;
  const readCookies = options.dependencies?.acquireCookieRecords ?? acquireCookieRecords;
  const removePrivateArtifact = options.dependencies?.removePrivateArtifact
    ?? ((path: string): void => rmSync(path, { recursive: true, force: true }));
  guardBrowserSetup(operationDeadline);
  const session = `io-${process.pid}-${crypto.randomUUID().slice(0, 12)}`;
  const directory = mkdtempSync(join(tmpdir(), "io-browser-"));
  const configPath = join(directory, "agent-browser.json");
  const policyPath = join(directory, "action-policy.json");
  const globalArguments: string[] = [];
  let selectedProfileDirectory: "Default" | null = null;
  let socketDirectory: string | null = null;
  const recoveryHandle = (): string => browserRecoveryHandle({
    session,
    configPath,
    socketDirectory,
    artifactsDirectory: directory,
  });
  const failInitialization = (error: unknown): never => {
    const cleanupFailures = removePrivateArtifacts(
      [socketDirectory, directory],
      removePrivateArtifact,
    );
    if (cleanupFailures.length > 0) {
      throw new PreservedBrowserArtifactsError(
        "browser session initialization failed and private artifacts were preserved because rollback was incomplete",
        recoveryHandle(),
        cleanupFailureCause(error, cleanupFailures),
      );
    }
    throw error;
  };
  try {
    globalArguments.push(
      "--config",
      configPath,
      "--session",
      session,
      "--content-boundaries",
      "--max-output",
      String(options.maxOutputBytes),
      "--action-policy",
      policyPath,
      ...(auth.kind === "browser-profile" && auth.browserExecutable !== undefined
        ? ["--executable-path", auth.browserExecutable]
        : []),
      ...(options.headed ? ["--headed"] : []),
    );
    if (auth.kind !== "browser-profile") {
      globalArguments.push("--allowed-domains", manifest.browserDomains.join(","));
    }
    guardBrowserSetup(operationDeadline);
    chmodSync(directory, 0o700);
    guardBrowserSetup(operationDeadline);
    socketDirectory = mkdtempSync(join("/tmp", "io-ab-"));
    guardBrowserSetup(operationDeadline);
    chmodSync(socketDirectory, 0o700);
    guardBrowserSetup(operationDeadline);
    writeFileSync(configPath, "{}\n", { mode: 0o600, flag: "wx" });
    guardBrowserSetup(operationDeadline);
    writeFileSync(policyPath, `${JSON.stringify({
      default: "deny",
      // Pinned agent-browser 0.32.3 checks both documented categories and
      // concrete commands such as getbyrole, inputvalue, and waitfortext.
      allow: [
        ...runtimeBrowserPolicyActions,
        ...(options.allowCodeOwnedEvaluation === true ? ["evaluate"] : []),
        ...(options.allowCodeOwnedNetworkObservation === true ? ["network", "requests", "request"] : []),
      ],
    })}\n`, { mode: 0o600, flag: "wx" });
    guardBrowserSetup(operationDeadline);
    const sourceProfile = auth.kind === "browser-profile" ? profilePath(auth.profile) : null;
    if (sourceProfile !== null) {
      guardBrowserSetup(operationDeadline);
      const clonedProfile = cloneBrowserProfile(sourceProfile, directory);
      guardBrowserSetup(operationDeadline);
      globalArguments.push("--profile", clonedProfile.userDataPath);
      selectedProfileDirectory = clonedProfile.profileDirectory ?? null;
    } else if (auth.kind === "browser-profile") {
      guardBrowserSetup(operationDeadline);
      globalArguments.push("--profile", auth.profile);
    }
  } catch (error) {
    failInitialization(error);
  }
  const initializedSocketDirectory = socketDirectory
    ?? failInitialization(new Error("browser socket directory was not initialized"));
  const cleanupResourceIdentity = (() => {
    try {
      const identity = browserCleanupResourceIdentity({
        recoveryHandle: recoveryHandle(),
        session,
        socketDirectory: initializedSocketDirectory,
        artifactsDirectory: directory,
      });
      options.publishCleanupResource?.(identity);
      return identity;
    } catch (error) {
      return failInitialization(error);
    }
  })();
  let environment: Readonly<Record<string, string>>;
  try {
    environment = isolatedEnvironment(initializedSocketDirectory);
  } catch (error) {
    failInitialization(error);
  }
  let networkProxy: LocalNetworkProxy | null = null;
  const networkProxyCreation: {
    pending: Promise<LocalNetworkProxy> | null;
  } = { pending: null };
  let closed = false;
  let closeOperation: Promise<void> | null = null;
  let launchAttempted = false;
  const activeBatches = new Set<Promise<readonly JsonRecord[]>>();
  let unsafeCommandCleanup: BrowserCommandCleanupError | null = null;
  const runBatch = async (
    commands: readonly (readonly string[])[],
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<readonly JsonRecord[]> => {
    if (closed || closeOperation !== null) {
      throw new Error("browser session is closed");
    }
    return runBrowserSetupStep(
      operationDeadline,
      () => {
        const batch = (async (): Promise<readonly JsonRecord[]> => {
          const result = await runBrowserCommand(
            [...agentBrowserCommand(), ...globalArguments, "batch", "--bail", "--json"],
            {
              cwd: directory,
              environment,
              timeoutMs: remainingBrowserSetupTime(timeoutMs, operationDeadline),
              maxOutputBytes,
              stdin: JSON.stringify(commands),
              ...(operationDeadline === undefined
                ? {}
                : { signal: operationDeadline.signal }),
            },
          );
          if (result.exitCode !== 0) throw agentBrowserFailure(result, "agent-browser batch");
          const entries = parsedBatch(result.stdout, commands.length);
          for (const entry of entries) browserResultData(entry);
          return entries;
        })();
        activeBatches.add(batch);
        void batch.then(
          () => activeBatches.delete(batch),
          (error: unknown) => {
            if (error instanceof BrowserCommandCleanupError) {
              unsafeCommandCleanup = error;
            }
            activeBatches.delete(batch);
          },
        );
        return batch;
      },
    );
  };
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closeOperation !== null) return closeOperation;
    closeOperation = (async () => {
      if (activeBatches.size > 0) {
        const settled = await teardownCompletesWithin(
          Promise.allSettled([...activeBatches]),
          BROWSER_ACTIVE_BATCH_SETTLEMENT_TIMEOUT_MS,
        );
        if (!settled || activeBatches.size > 0) {
          throw new Error(
            "refusing to close the browser while a batch command remains active",
          );
        }
      }
      if (unsafeCommandCleanup !== null) {
        throw unsafeCommandCleanup;
      }
      const result = await runBrowserCommand(
        [...agentBrowserCommand(), ...globalArguments, "close", "--json"],
        { cwd: directory, environment, timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 },
      );
      if (result.exitCode !== 0) throw agentBrowserFailure(result, "agent-browser close");
      closed = true;
    })();
    return closeOperation;
  };
  const cleanup = async (): Promise<void> => {
    if (!closed && closeOperation === null) {
      throw new Error("refusing to delete private browser artifacts before the session closes");
    }
    const failures: unknown[] = [];
    let resourcesQuiescent = true;
    if (networkProxy !== null) {
      const proxy = networkProxy;
      if (await teardownCompletesWithin(
        Promise.resolve().then(() => proxy.close()),
        BROWSER_RESOURCE_TEARDOWN_TIMEOUT_MS,
      )) {
        if (networkProxy === proxy) networkProxy = null;
      } else {
        resourcesQuiescent = false;
        failures.push(
          new Error("browser network proxy cleanup did not settle safely"),
        );
      }
    }
    const rootsAreUnused = closed && activeBatches.size === 0;
    if (!rootsAreUnused) {
      failures.push(
        new Error(
          "refusing to delete private browser artifacts before the session closes",
        ),
      );
    }
    if (resourcesQuiescent && rootsAreUnused) {
      failures.push(...removePrivateArtifacts(
        [initializedSocketDirectory, directory],
        removePrivateArtifact,
      ));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "browser session cleanup did not remove every private resource",
      );
    }
  };
  try {
    networkProxy = await runBrowserSetupStep(operationDeadline, () => {
      const creation = createNetworkProxy({
        allowPrivateNetwork: false,
        timeoutMs: remainingBrowserSetupTime(options.timeoutMs, operationDeadline),
        maxTransferredBytes: 1024 * 1024 * 1024,
      });
      networkProxyCreation.pending = creation;
      return creation;
    });
    networkProxyCreation.pending = null;
    guardBrowserSetup(operationDeadline);
    const proxyArguments = browserProxyArguments(
      networkProxy.url,
      selectedProfileDirectory ?? undefined,
    );
    guardBrowserSetup(operationDeadline);
    globalArguments.push(...proxyArguments);
    const launchUrl = auth.kind === "browser-profile"
      ? "about:blank"
      : manifest.origins[0];
    if (launchUrl === undefined) throw new Error("contained browser session requires one reviewed origin");
    guardBrowserSetup(operationDeadline);
    launchAttempted = true;
    await runBatch(
      [["open", launchUrl]],
      remainingBrowserSetupTime(options.timeoutMs, operationDeadline),
      options.maxOutputBytes,
    );
    if (
      auth.kind === "cookie-source"
      || auth.kind === "cookies-file"
      || (auth.kind === "browser-profile" && auth.cookieSource !== undefined)
    ) {
      for (const origin of manifest.origins) {
        guardBrowserSetup(operationDeadline);
        const target = new URL(origin);
        const cookieResult = await runBrowserSetupStep(
          operationDeadline,
          () => readCookies({
            cookieSources: auth.kind === "cookie-source"
              ? [auth.source]
              : auth.kind === "browser-profile" && auth.cookieSource !== undefined
                ? [auth.cookieSource]
                : [],
            cookieProfile: auth.kind === "cookie-source"
              ? auth.profile
              : auth.kind === "browser-profile"
                ? auth.cookieProfile
                : undefined,
            cookiesFile: auth.kind === "cookies-file" ? auth.path : undefined,
            timeoutMs: remainingBrowserSetupTime(options.timeoutMs, operationDeadline),
            requireExplicitCookieScope: true,
          }, target),
        );
        guardBrowserSetup(operationDeadline);
        const cookieCommands = browserCookieCommands(cookieResult.cookies, target);
        guardBrowserSetup(operationDeadline);
        await runBatch(
          cookieCommands,
          remainingBrowserSetupTime(options.timeoutMs, operationDeadline),
          options.maxOutputBytes,
        );
      }
    }
    guardBrowserSetup(operationDeadline);
    return {
      runBatch,
      close,
      cleanup,
      recoveryHandle: recoveryHandle(),
      cleanupResourceIdentity,
    };
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    let resourcesQuiescent = true;
    let commandCleanupUnsafe = error instanceof BrowserCommandCleanupError;
    if (networkProxyCreation.pending !== null) {
      const closeLateProxy = networkProxyCreation.pending.then(
        (proxy) => proxy.close(),
        () => undefined,
      );
      if (!await teardownCompletesWithin(
        closeLateProxy,
        BROWSER_RESOURCE_TEARDOWN_TIMEOUT_MS,
      )) {
        resourcesQuiescent = false;
        cleanupFailures.push(
          new Error("browser setup proxy creation did not settle safely"),
        );
      }
      networkProxyCreation.pending = null;
    }
    if (!launchAttempted) closed = true;
    if (launchAttempted && !commandCleanupUnsafe) {
      if (!await teardownCompletesWithin(
        close(),
        BROWSER_CLOSE_TEARDOWN_TIMEOUT_MS,
      )) {
        cleanupFailures.push(
          new Error("browser close could not be verified after setup failure"),
        );
      }
      if (unsafeCommandCleanup !== null) {
        commandCleanupUnsafe = true;
        cleanupFailures.push(
          new Error("a late browser command cleanup failure was preserved"),
        );
      }
    } else if (commandCleanupUnsafe) {
      cleanupFailures.push(
        new Error("browser command cleanup could not be verified"),
      );
    }
    if (networkProxy !== null) {
      const proxy = networkProxy;
      if (await teardownCompletesWithin(
        Promise.resolve().then(() => proxy.close()),
        BROWSER_RESOURCE_TEARDOWN_TIMEOUT_MS,
      )) {
        if (networkProxy === proxy) networkProxy = null;
      } else {
        resourcesQuiescent = false;
        cleanupFailures.push(
          new Error("browser network proxy could not be closed safely"),
        );
      }
    }
    if (
      resourcesQuiescent
      && closed
      && activeBatches.size === 0
      && !commandCleanupUnsafe
    ) {
      cleanupFailures.push(...removePrivateArtifacts(
        [initializedSocketDirectory, directory],
        removePrivateArtifact,
      ));
    } else {
      cleanupFailures.push(
        new Error("browser private roots remain in use by an unclosed session"),
      );
    }
    if (cleanupFailures.length > 0) {
      throw new PreservedBrowserArtifactsError(
        "browser session setup failed and private artifacts were preserved because cleanup could not be verified",
        recoveryHandle(),
        cleanupFailureCause(error, cleanupFailures),
      );
    }
    throw error;
  }
}

/** Retired DOM-action boundary. Browsers remain capture/bootstrap-only. */
export function executeBrowserRecipe(
  manifest: WrenchManifest,
  recipe: BrowserRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly headed: boolean;
    readonly createSession?: typeof createBrowserSession;
    readonly fileResolver?: BrowserFileResolver;
    /** Called after origin validation and before a dispatch command can start. */
    readonly beforeDispatch?: (event: BrowserDispatchEvent) => Promise<void>;
    /** Called only after every observation in the matching verification group succeeds. */
    readonly afterDispatchVerified?: (event: BrowserDispatchEvent) => Promise<void>;
  },
): Promise<BrowserExecution> {
  void manifest;
  void recipe;
  void input;
  void auth;
  void options;
  return Promise.reject(new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE));
}
