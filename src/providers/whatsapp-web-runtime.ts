import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  type Stats,
  type BigIntStats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BoundedByteBuffer } from "@hraness/kb/clip/bounded-byte-buffer";

import type { WrenchAuth } from "../auth";
import { canonicalJson } from "../canonical-json";
import type { OperationInput, WebSessionRecipe } from "../model";
import { OperationDeadline } from "../operation-deadline";
import type {
  ProviderPluginLinkedDeviceAttemptBoundaryV1,
} from "../provider-plugin";
import { assertSafeStatePath, wrenchStateHome } from "../storage";
import type {
  WebSessionExecution,
  WebSessionCleanupBarrierRegistrar,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import { startWebSessionCleanupTrackedOperation } from "../web-session-execution";
import {
  WHATSAPP_CONTACT_PROJECTION_MAX_STDOUT_BYTES,
  WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
  isExactWhatsAppContactProjectionMode,
  parseWhatsAppContactProjectionResponse,
  parseWhatsAppContactProjectionSubject,
  type WhatsAppContactProjectionRequest,
} from "./whatsapp-contact-projection-protocol";
import {
  WHATSAPP_INTERACTION_PROJECTION_MAX_STDOUT_BYTES,
  WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION,
  parseWhatsAppInteractionProjectionRequest,
  parseWhatsAppInteractionProjectionResponse,
  parseWhatsAppInteractionRowid,
  type WhatsAppInteractionProjectionRequest,
} from "./whatsapp-interaction-projection-protocol";
import {
  WHATSAPP_PROTOCOL_PIN,
  WHATSAPP_WEB_OPERATIONS,
  WHATSAPP_WEB_OPERATION_NAMES,
  parseWhatsAppAuthStatusEnvelope,
  parseWhatsAppJid,
  projectWhatsAppChatsEnvelope,
  projectWhatsAppMessageEnvelope,
  projectWhatsAppMessagesEnvelope,
  whatsappMessageId,
  whatsappTargetJid,
  type WhatsAppWebOperationName,
} from "./whatsapp-web";
import { projectContactDirectionStats } from "./contact-projection";

const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
const DEFAULT_LIMIT = 50;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STORE_ENTRIES = 10_000;
const MAX_SYNC_MESSAGES = 200_000;
const MAX_SYNC_DB_SIZE = "2GB";
const MAX_CONTACT_PROJECTION_STDERR_BYTES = 16 * 1024;
const CONTACT_PROJECTION_FORCE_KILL_DELAY_MS = 1_000;
const MESSAGE_EXPORT_SESSION_MAX_TOTAL_STDOUT_BYTES = 512 * 1024 * 1024;
const MESSAGE_EXPORT_SESSION_MAX_FRAMES = 1_001;
const MESSAGE_EXPORT_SESSION_SPOOL_CHUNK_BYTES = 64 * 1024;
const MESSAGE_EXPORT_SESSION_PRIVATE_DIRECTORY_MODE = 0o700;
const MESSAGE_EXPORT_SESSION_PRIVATE_FILE_MODE = 0o600;
const WEB_SESSION_OPERATION_LABEL = "authenticated web operation deadline";

type WhatsAppAuth = Extract<
  WrenchAuth,
  { readonly kind: "linked-device-store" }
>;

export type WacliInvocation = {
  readonly binary: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
};

export type WacliInvocationResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type WhatsAppContactProjectionHelperInvocation = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes: number;
  readonly signal?: AbortSignal;
  /** Called exactly once after spawn with the owned helper PID. */
  readonly onSpawned?: (pid: number) => void;
  /** Internal streaming validator; called synchronously for each canonical frame. */
  readonly onCanonicalFrame?: (
    frame: WhatsAppMessageExportSessionCanonicalFrame,
  ) => void;
};

export type WhatsAppContactProjectionHelperResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type WhatsAppMessageExportSessionCanonicalFrame = Readonly<{
  index: number;
  canonical: string;
  value: unknown;
}>;

export type WhatsAppMessageExportSessionSpool = Readonly<{
  frameCount: number;
  totalBytes: number;
  stdoutSha256: string;
  replay: <Value>(
    project: (frame: WhatsAppMessageExportSessionCanonicalFrame) => Value,
  ) => AsyncGenerator<Value>;
  close: () => Promise<void>;
}>;

export type WhatsAppMessageExportSessionHelperResult = Readonly<{
  exitCode: number;
  spool: WhatsAppMessageExportSessionSpool;
  stderr: string;
}>;

export class WhatsAppContactProjectionCleanupUnverifiedError extends Error {
  constructor() {
    super(
      "WhatsApp contact projection helper cleanup could not be verified",
    );
    this.name = "WhatsAppContactProjectionCleanupUnverifiedError";
  }
}

export function containsWhatsAppContactProjectionCleanupUnverified(
  error: unknown,
): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current instanceof WhatsAppContactProjectionCleanupUnverifiedError) return true;
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof AggregateError) {
      try {
        pending.push(...current.errors);
      } catch {
        // A hostile wrapper cannot prove cleanup safety.
      }
    }
    try {
      if ("cause" in current) pending.push(current.cause);
    } catch {
      // A hostile wrapper cannot hide a directly reachable proved error.
    }
  }
  return false;
}

export type WhatsAppWebRuntimeDependencies = {
  /**
   * Test-only binary seam. Production resolution accepts only the pinned
   * release in fixed installation locations and verifies its SHA-256.
   */
  readonly binaryPath?: string;
  readonly run?: (
    invocation: WacliInvocation,
  ) => Promise<WacliInvocationResult>;
  readonly runInteractive?: (
    plan: WhatsAppPairingPlan,
  ) => Promise<number>;
  /** Test-only observation seam; production always uses the fixed Bun helper. */
  readonly runContactProjectionHelper?: (
    invocation: WhatsAppContactProjectionHelperInvocation,
  ) => Promise<WhatsAppContactProjectionHelperResult>;
  /** Test-only observation seam; production always uses the fixed Bun helper. */
  readonly runInteractionProjectionHelper?: (
    invocation: WhatsAppContactProjectionHelperInvocation,
  ) => Promise<WhatsAppContactProjectionHelperResult>;
};

function isWhatsAppOperation(
  value: string,
): value is WhatsAppWebOperationName {
  return (WHATSAPP_WEB_OPERATION_NAMES as readonly string[]).includes(value);
}

function requireWhatsAppAuth(auth: WrenchAuth): WhatsAppAuth {
  if (
    auth.kind !== "linked-device-store"
    || auth.provider !== "whatsapp"
  ) {
    throw new Error(
      "WhatsApp protocol operations require a WhatsApp linked-device-store auth realm",
    );
  }
  if (!isAbsolute(auth.path)) {
    throw new Error("WhatsApp linked-device store path must be absolute");
  }
  return auth;
}

function ownedByCurrentUser(stats: Stats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid === null || stats.uid === uid;
}

function assertPrivateOwned(
  stats: Stats,
  label: string,
  kind: "directory" | "file" | "socket",
): void {
  const matchesKind = kind === "directory"
    ? stats.isDirectory()
    : kind === "file"
      ? stats.isFile()
      : stats.isSocket();
  if (!matchesKind || !ownedByCurrentUser(stats)) {
    throw new Error(`${label} must be an owned ${kind}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or world access`);
  }
}

export type WhatsAppStoreValidationPurpose =
  | "pair"
  | "probe"
  | "sync"
  | "projection"
  | "contact-projection";

/**
 * Validate the complete top level of the credential/message store. This
 * complements wacli's own 0700/0600 creation policy and catches later
 * permission widening or symlink substitution before any trusted read.
 */
export async function validateWhatsAppStoreDirectory(
  pathValue: string,
  purpose: WhatsAppStoreValidationPurpose,
): Promise<string> {
  if (!isAbsolute(pathValue)) {
    throw new Error("WhatsApp linked-device store path must be absolute");
  }
  const lexical = resolve(pathValue);
  let directoryStats: Stats;
  try {
    directoryStats = await lstat(lexical);
  } catch (error) {
    if (
      purpose === "pair"
      && typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      await mkdir(lexical, { recursive: true, mode: 0o700 });
      await chmod(lexical, 0o700);
      directoryStats = await lstat(lexical);
    } else {
      throw new Error("WhatsApp linked-device store is unavailable");
    }
  }
  if (directoryStats.isSymbolicLink()) {
    throw new Error("WhatsApp linked-device store must not be a symbolic link");
  }
  assertPrivateOwned(directoryStats, "WhatsApp linked-device store", "directory");
  const canonical = await realpath(lexical);
  if (canonical !== lexical) {
    throw new Error("WhatsApp linked-device store path must be canonical");
  }

  const entries = await readdir(canonical, { withFileTypes: true });
  if (entries.length > MAX_STORE_ENTRIES) {
    throw new Error("WhatsApp linked-device store has too many entries");
  }
  for (const entry of entries) {
    if (
      entry.name.length < 1
      || entry.name.length > 255
      || entry.name.includes("\0")
      || entry.isSymbolicLink()
    ) throw new Error("WhatsApp linked-device store contains an unsafe entry");
    const entryPath = join(canonical, entry.name);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error("WhatsApp linked-device store contains a symbolic link");
    }
    if (stats.isDirectory()) {
      assertPrivateOwned(stats, "WhatsApp linked-device store entry", "directory");
    } else if (stats.isFile()) {
      assertPrivateOwned(stats, "WhatsApp linked-device store entry", "file");
    } else if (stats.isSocket()) {
      assertPrivateOwned(stats, "WhatsApp linked-device store entry", "socket");
    } else {
      throw new Error("WhatsApp linked-device store contains an unsupported entry");
    }
  }

  const requireRegular = async (name: string): Promise<void> => {
    let stats: Stats;
    try {
      stats = await lstat(join(canonical, name));
    } catch {
      throw new Error(`WhatsApp linked-device store omitted ${name}`);
    }
    assertPrivateOwned(stats, `WhatsApp ${name}`, "file");
  };
  if (
    purpose === "sync"
    || purpose === "projection"
    || purpose === "contact-projection"
  ) {
    await requireRegular("session.db");
  }
  if (purpose === "projection") {
    await requireRegular("wacli.db");
  }
  return canonical;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { flags: "r" });
  for await (const chunkValue of stream) {
    const chunk: unknown = chunkValue;
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("WhatsApp protocol binary stream returned non-byte data");
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
}

type FixedCommandResult = {
  readonly exitCode: number;
  readonly output: string;
};

async function runFixedCodesign(
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<FixedCommandResult> {
  const isAborted = (): boolean => signal?.aborted === true;
  if (isAborted()) {
    return Object.freeze({ exitCode: -1, output: "" });
  }
  const child = Bun.spawn(["/usr/bin/codesign", ...arguments_], {
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // child.exited remains the process-cleanup proof.
    }
  };
  const onAbort = (): void => interrupt();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (isAborted()) onAbort();
  const timeout = setTimeout(interrupt, 5_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, 64 * 1024),
      readBoundedStream(child.stderr, 64 * 1024),
      child.exited,
    ]);
    return Object.freeze({
      exitCode: interrupted ? -1 : exitCode,
      output: interrupted ? "" : `${stdout}${stderr}`,
    });
  } catch (error) {
    interrupt();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function codeSignatureValue(
  display: string,
  key: string,
): string | null {
  const prefix = `${key}=`;
  const lines = display.split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return null;
  return lines[0]?.slice(prefix.length) ?? null;
}

function normalizeCodeRequirement(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/"([A-Za-z0-9.]+)"/gu, "$1")
    .trim();
}

async function verifyPinnedWacliSignature(
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const verified = await runFixedCodesign([
    "--verify",
    "--strict",
    "--verbose=4",
    path,
  ], signal);
  if (verified.exitCode !== 0) return false;

  const display = await runFixedCodesign([
    "--display",
    "--verbose=4",
    path,
  ], signal);
  if (display.exitCode !== 0) return false;
  const signature = WHATSAPP_PROTOCOL_PIN.signature;
  const authorities = display.output.split(/\r?\n/u)
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice("Authority=".length))
    .filter((authority) => authority.startsWith("Developer ID Application:"));
  if (
    codeSignatureValue(display.output, "Identifier") !== signature.identifier
    || codeSignatureValue(display.output, "TeamIdentifier")
      !== signature.teamIdentifier
    || codeSignatureValue(display.output, "CDHash") !== signature.cdHash
    || codeSignatureValue(display.output, "CandidateCDHashFull sha256")
      !== signature.cdHashFull
    || authorities.length !== 1
    || authorities[0] !== signature.authority
    || !/\bflags=0x[0-9a-f]+\(runtime\)/iu.test(display.output)
    || !/^Timestamp=(?!none$).+/mu.test(display.output)
  ) return false;

  const requirements = await runFixedCodesign([
    "--display",
    "--requirements",
    "-",
    path,
  ], signal);
  if (requirements.exitCode !== 0) return false;
  const embeddedRequirements = requirements.output.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("designated =>"));
  if (
    embeddedRequirements.length !== 1
    || normalizeCodeRequirement(embeddedRequirements[0] ?? "")
      !== normalizeCodeRequirement(signature.designatedRequirement)
  ) return false;

  return true;
}

async function pinnedBinaryCandidate(
  pathValue: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let canonical: string;
  try {
    canonical = await realpath(pathValue);
  } catch {
    return null;
  }
  try {
    const stats = await lstat(canonical);
    if (
      !stats.isFile()
      || (stats.mode & 0o077) !== 0
      || (stats.mode & 0o111) === 0
      || !ownedByCurrentUser(stats)
    ) return null;
    if (process.platform !== "darwin" || process.arch !== "arm64") return null;
    if (
      await sha256File(canonical)
        !== WHATSAPP_PROTOCOL_PIN.darwinArm64BinarySha256
    ) return null;
    if (!await verifyPinnedWacliSignature(canonical, signal)) return null;
    const finalStats = await lstat(canonical);
    if (
      !finalStats.isFile()
      || finalStats.dev !== stats.dev
      || finalStats.ino !== stats.ino
      || finalStats.size !== stats.size
      || finalStats.mode !== stats.mode
      || !ownedByCurrentUser(finalStats)
      || await sha256File(canonical)
        !== WHATSAPP_PROTOCOL_PIN.darwinArm64BinarySha256
    ) return null;
    return canonical;
  } catch {
    return null;
  }
}

export async function resolvePinnedWacliBinary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
): Promise<string> {
  const candidates = [
    join(
      wrenchStateHome(environment),
      "tools",
      "wacli",
      WHATSAPP_PROTOCOL_PIN.version,
      WHATSAPP_PROTOCOL_PIN.transport,
      "wacli",
    ),
  ];
  for (const candidate of candidates) {
    try {
      assertSafeStatePath(candidate, environment);
    } catch {
      continue;
    }
    const found = await pinnedBinaryCandidate(candidate, signal);
    if (found === null) continue;
    try {
      assertSafeStatePath(candidate, environment);
      if (await realpath(candidate) === found) return found;
    } catch {
      // The lexical state path changed after validation.
    }
  }
  throw new Error(
    `pinned WhatsApp protocol runtime wacli ${WHATSAPP_PROTOCOL_PIN.version} is not installed or failed integrity verification`,
  );
}

export type WhatsAppProtocolRuntimeStatus = {
  readonly ready: boolean;
  readonly implementation: typeof WHATSAPP_PROTOCOL_PIN.implementation;
  readonly version: typeof WHATSAPP_PROTOCOL_PIN.version;
  readonly integrity: "official-release+sha256+developer-id+notarization";
  readonly transport: typeof WHATSAPP_PROTOCOL_PIN.transport;
  readonly archiveSha256:
    typeof WHATSAPP_PROTOCOL_PIN.darwinArm64ArchiveSha256;
  readonly binarySha256:
    typeof WHATSAPP_PROTOCOL_PIN.darwinArm64BinarySha256;
  readonly signature: typeof WHATSAPP_PROTOCOL_PIN.signature;
  readonly qualification: "read-only-runtime";
  readonly setupCommand: string;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function inspectWhatsAppProtocolRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<WhatsAppProtocolRuntimeStatus> {
  const installer = fileURLToPath(
    new URL("../scripts/install-whatsapp-protocol.sh", import.meta.url),
  );
  let ready = false;
  try {
    await resolvePinnedWacliBinary(environment);
    ready = true;
  } catch {
    // Doctor exposes categorical readiness and a deterministic setup command,
    // never candidate paths or integrity failure details.
  }
  return Object.freeze({
    ready,
    implementation: WHATSAPP_PROTOCOL_PIN.implementation,
    version: WHATSAPP_PROTOCOL_PIN.version,
    integrity: "official-release+sha256+developer-id+notarization",
    transport: WHATSAPP_PROTOCOL_PIN.transport,
    archiveSha256: WHATSAPP_PROTOCOL_PIN.darwinArm64ArchiveSha256,
    binarySha256: WHATSAPP_PROTOCOL_PIN.darwinArm64BinarySha256,
    signature: WHATSAPP_PROTOCOL_PIN.signature,
    qualification: "read-only-runtime",
    setupCommand: `/bin/sh ${shellQuote(installer)}`,
  });
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<string> {
  return readBoundedStreamControlled(stream, maximum).promise;
}

function readBoundedStreamControlled(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Readonly<{ promise: Promise<string>; cancel: () => Promise<void> }> {
  const reader = stream.getReader();
  const output = new BoundedByteBuffer(maximum);
  const promise = (async (): Promise<string> => {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        if (!output.append(item.value)) {
          throw new Error("WhatsApp protocol process output exceeded its bound");
        }
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      output.toUint8Array(),
    );
  })();
  return Object.freeze({
    promise,
    cancel: async () => {
      try { await reader.cancel(); } catch { /* settlement remains authoritative */ }
    },
  });
}

async function runWacli(
  invocation: WacliInvocation,
): Promise<WacliInvocationResult> {
  const cancellationSignal = invocation.signal;
  const isCancelled = (): boolean =>
    cancellationSignal?.aborted === true;
  if (isCancelled()) {
    throw new Error("WhatsApp protocol command was cancelled");
  }
  const ownsProcessGroup = (
    cancellationSignal !== undefined
    && process.platform !== "win32"
  );
  const child = Bun.spawn(
    [invocation.binary, ...invocation.arguments],
    {
      env: { ...invocation.environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: ownsProcessGroup,
    },
  );
  let timedOut = false;
  let cancelled = false;
  let forceKill: ReturnType<typeof setTimeout> | null = null;
  const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
    if (ownsProcessGroup) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ESRCH"
        ) return;
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The process already exited between the state check and the signal.
    }
  };
  const terminate = (): void => {
    signalChild("SIGTERM");
    if (forceKill === null) {
      forceKill = setTimeout(() => signalChild("SIGKILL"), 1_000);
    }
  };
  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  cancellationSignal?.addEventListener("abort", onAbort, { once: true });
  if (isCancelled()) onAbort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, invocation.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(child.stdout, invocation.maxOutputBytes),
      readBoundedStream(
        child.stderr,
        Math.min(invocation.maxOutputBytes, MAX_STDERR_BYTES),
      ),
      child.exited,
    ]);
    if (cancelled) throw new Error("WhatsApp protocol command was cancelled");
    if (timedOut) throw new Error("WhatsApp protocol command timed out");
    return { exitCode, stdout, stderr };
  } catch (error) {
    signalChild("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (forceKill !== null) clearTimeout(forceKill);
    cancellationSignal?.removeEventListener("abort", onAbort);
  }
}

function wacliEnvironment(
  readOnly: boolean,
): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    ...(readOnly ? { WACLI_READONLY: "1" } : {}),
  });
}

function remainingTimeoutMs(
  timeoutMs: number,
  operationDeadline: WebSessionOperationDeadline | undefined,
): number {
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const remaining = Math.min(
    timeoutMs,
    operationDeadline?.remainingTimeMs() ?? timeoutMs,
  );
  if (remaining < 1) {
    throw new Error("WhatsApp authenticated web operation timed out");
  }
  return remaining;
}

async function checkedRun(
  binary: string,
  arguments_: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly readOnly: boolean;
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly operationDeadline?: WebSessionOperationDeadline;
  },
): Promise<unknown> {
  const timeoutMs = remainingTimeoutMs(
    options.timeoutMs,
    options.operationDeadline,
  );
  const run = options.dependencies?.run ?? runWacli;
  const invoke = () => run({
    binary,
    arguments: arguments_,
    environment: wacliEnvironment(options.readOnly),
    timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    ...(options.operationDeadline === undefined
      ? {}
      : { signal: options.operationDeadline.signal }),
  });
  const result = options.operationDeadline === undefined
    ? await invoke()
    : await options.operationDeadline.run(
        invoke,
        WEB_SESSION_OPERATION_LABEL,
      );
  options.operationDeadline?.throwIfUnavailable(
    WEB_SESSION_OPERATION_LABEL,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "WhatsApp protocol command failed before producing reviewed output",
    );
  }
  const raw = result.stdout.trim();
  if (raw.length < 1) {
    throw new Error("WhatsApp protocol command omitted JSON output");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("WhatsApp protocol command returned malformed JSON");
  }
}

async function runtimeBinary(
  dependencies: WhatsAppWebRuntimeDependencies | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<string> {
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const resolveBinary = () => resolvePinnedWacliBinary(
    environment,
    operationDeadline?.signal,
  );
  const binary = dependencies?.binaryPath
    ?? (operationDeadline === undefined
      ? await resolveBinary()
      : await operationDeadline.run(
          resolveBinary,
          WEB_SESSION_OPERATION_LABEL,
        ));
  if (dependencies?.binaryPath !== undefined && !isAbsolute(binary)) {
    throw new Error("test WhatsApp protocol binary path must be absolute");
  }
  const timeoutMs = remainingTimeoutMs(5_000, operationDeadline);
  const run = dependencies?.run ?? runWacli;
  const invoke = () => run({
    binary,
    arguments: ["version"],
    environment: wacliEnvironment(true),
    timeoutMs,
    maxOutputBytes: 1_024,
    ...(operationDeadline === undefined
      ? {}
      : { signal: operationDeadline.signal }),
  });
  const result = operationDeadline === undefined
    ? await invoke()
    : await operationDeadline.run(
        invoke,
        WEB_SESSION_OPERATION_LABEL,
      );
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  if (
    result.exitCode !== 0
    || result.stdout.trim() !== WHATSAPP_PROTOCOL_PIN.version
  ) {
    throw new Error("WhatsApp protocol runtime version did not match its pin");
  }
  return binary;
}

function readOnlyArguments(
  store: string,
  timeoutMs: number,
  command: readonly string[],
): readonly string[] {
  return Object.freeze([
    "--store",
    store,
    "--read-only",
    "--json",
    "--full",
    "--timeout",
    `${Math.max(1, timeoutMs)}ms`,
    ...command,
  ]);
}

async function authStatus(
  binary: string,
  store: string,
  timeoutMs: number,
  dependencies: WhatsAppWebRuntimeDependencies | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<ReturnType<typeof parseWhatsAppAuthStatusEnvelope>> {
  const commandTimeoutMs = remainingTimeoutMs(
    timeoutMs,
    operationDeadline,
  );
  return parseWhatsAppAuthStatusEnvelope(await checkedRun(
    binary,
    readOnlyArguments(store, commandTimeoutMs, ["auth", "status"]),
    {
      timeoutMs: commandTimeoutMs,
      maxOutputBytes: 64 * 1024,
      readOnly: true,
      ...(dependencies === undefined ? {} : { dependencies }),
      ...(operationDeadline === undefined
        ? {}
        : { operationDeadline }),
    },
  ));
}

async function boundRuntime(
  auth: WrenchAuth,
  purpose: "probe" | "projection",
  timeoutMs: number,
  dependencies: WhatsAppWebRuntimeDependencies | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<{
  readonly auth: WhatsAppAuth;
  readonly binary: string;
  readonly store: string;
  readonly subject: string;
}> {
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const linked = requireWhatsAppAuth(auth);
  const validateStore = () =>
    validateWhatsAppStoreDirectory(linked.path, purpose);
  const store = operationDeadline === undefined
    ? await validateStore()
    : await operationDeadline.run(
        validateStore,
        WEB_SESSION_OPERATION_LABEL,
      );
  const binary = await runtimeBinary(
    dependencies,
    environment,
    operationDeadline,
  );
  const status = await authStatus(
    binary,
    store,
    timeoutMs,
    dependencies,
    operationDeadline,
  );
  if (!status.authenticated || status.subject === null) {
    throw new Error(
      "WhatsApp linked-device store is not paired; run the explicit auth pairing flow",
    );
  }
  if (purpose === "projection") {
    if (linked.subject === undefined) {
      throw new Error(
        "WhatsApp linked-device auth must be bound to its current account before private reads",
      );
    }
    if (linked.subject !== status.subject) {
      throw new Error(
        "WhatsApp linked-device account did not match the bound auth realm",
      );
    }
  }
  return {
    auth: linked,
    binary,
    store,
    subject: status.subject,
  };
}

export async function probeWhatsAppWebSubject(
  auth: WrenchAuth,
  options: {
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = new OperationDeadline(timeoutMs, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    const runtime = await boundRuntime(
      auth,
      "probe",
      timeoutMs,
      options.dependencies,
      options.environment ?? process.env,
      deadline,
    );
    deadline.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
    return runtime.subject;
  } finally {
    deadline.dispose();
  }
}

function inputInteger(
  input: OperationInput,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = input[name] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`input.${name} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function inputFolder(input: OperationInput): "all" | "active" | "archived" | "unread" {
  const value = input.folder ?? "all";
  if (
    value !== "all"
    && value !== "active"
    && value !== "archived"
    && value !== "unread"
  ) throw new Error("input.folder must be all, active, archived, or unread");
  return value;
}

type ExactContactInput =
  | { readonly collection: "contacts"; readonly cursor: string | null; readonly limit: number }
  | { readonly collection: "interactions"; readonly cursor: string; readonly cursorAnchor: string | null; readonly limit: number };

function exactContactInput(input: OperationInput): ExactContactInput {
  const unexpected = Object.keys(input).filter(
    (key) => key !== "collection" && key !== "cursor" && key !== "cursor_anchor" && key !== "limit",
  );
  if (unexpected.length > 0) {
    throw new Error("WhatsApp contacts.list input contained unsupported fields");
  }
  const collection = input.collection ?? "contacts";
  if (collection !== "contacts" && collection !== "interactions") {
    throw new Error("input.collection must be contacts or interactions");
  }
  if (collection === "interactions") {
    const cursor = input.cursor === undefined
      ? "0"
      : parseWhatsAppInteractionRowid(input.cursor, "input.cursor");
    const cursorAnchor = input.cursor_anchor === undefined
      ? null
      : typeof input.cursor_anchor === "string" && /^[a-f0-9]{64}$/u.test(input.cursor_anchor)
        ? input.cursor_anchor
        : (() => { throw new Error("input.cursor_anchor must be a SHA-256 digest"); })();
    if ((cursor === "0") !== (cursorAnchor === null)) {
      throw new Error("input.cursor_anchor must bind every nonzero interaction cursor");
    }
    return Object.freeze({
      collection,
      cursor,
      cursorAnchor,
      limit: inputInteger(input, "limit", DEFAULT_LIMIT, 1_000),
    });
  }
  if (input.cursor_anchor !== undefined) {
    throw new Error("input.cursor_anchor is only supported for interaction scans");
  }
  let cursor: string | null = null;
  if (input.cursor !== undefined) {
    const parsed = parseWhatsAppJid(input.cursor, "input.cursor");
    if (
      (parsed.kind !== "user" && parsed.kind !== "lid")
      || parsed.jid.includes(":")
    ) {
      throw new Error("input.cursor must be one exact contact user or LID JID");
    }
    cursor = parsed.jid;
  }
  return Object.freeze({
    collection,
    cursor,
    limit: inputInteger(input, "limit", DEFAULT_LIMIT, 100),
  });
}

type ContactProjectionParentIdentity = Readonly<{
  store: BigIntStats;
  session: BigIntStats;
}>;

type InteractionProjectionParentIdentity = Readonly<{
  store: BigIntStats;
  session: BigIntStats;
  messageStore: BigIntStats;
}>;

function sameContactProjectionSnapshot(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function currentBigIntUid(): bigint | null {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

function assertParentContactProjectionIdentity(
  store: BigIntStats,
  session: BigIntStats,
): void {
  const uid = currentBigIntUid();
  if (
    !store.isDirectory()
    || store.isSymbolicLink()
    || (uid !== null && store.uid !== uid)
    || !isExactWhatsAppContactProjectionMode(store.mode, 0o700)
    || !session.isFile()
    || session.isSymbolicLink()
    || session.nlink !== 1n
    || (uid !== null && session.uid !== uid)
    || !isExactWhatsAppContactProjectionMode(session.mode, 0o600)
    || session.size < 1n
    || session.size > 128n * 1024n * 1024n
  ) {
    throw new Error(
      "WhatsApp contact projection parent could not verify its private session store",
    );
  }
}

async function captureContactProjectionParentIdentity(
  store: string,
): Promise<ContactProjectionParentIdentity> {
  try {
    if (await realpath(store) !== store) {
      throw new Error("non-canonical");
    }
    const [storeStats, sessionStats] = await Promise.all([
      lstat(store, { bigint: true }),
      lstat(join(store, "session.db"), { bigint: true }),
    ]);
    assertParentContactProjectionIdentity(storeStats, sessionStats);
    return Object.freeze({ store: storeStats, session: sessionStats });
  } catch {
    throw new Error(
      "WhatsApp contact projection parent could not bind its private session store",
    );
  }
}

async function revalidateContactProjectionParentIdentity(
  store: string,
  initial: ContactProjectionParentIdentity,
): Promise<void> {
  try {
    if (await realpath(store) !== store) throw new Error("non-canonical");
    const [storeStats, sessionStats] = await Promise.all([
      lstat(store, { bigint: true }),
      lstat(join(store, "session.db"), { bigint: true }),
    ]);
    assertParentContactProjectionIdentity(storeStats, sessionStats);
    if (
      !sameContactProjectionSnapshot(initial.store, storeStats)
      || !sameContactProjectionSnapshot(initial.session, sessionStats)
    ) throw new Error("identity changed");
  } catch {
    throw new Error(
      "WhatsApp contact projection parent binding changed during the helper read",
    );
  }
}

function assertParentInteractionProjectionIdentity(
  store: BigIntStats,
  session: BigIntStats,
  messageStore: BigIntStats,
): void {
  assertParentContactProjectionIdentity(store, session);
  const uid = currentBigIntUid();
  if (
    !messageStore.isFile()
    || messageStore.isSymbolicLink()
    || messageStore.nlink !== 1n
    || (uid !== null && messageStore.uid !== uid)
    || !isExactWhatsAppContactProjectionMode(messageStore.mode, 0o600)
    || messageStore.size < 1n
    || messageStore.size > 2n * 1024n * 1024n * 1024n
  ) {
    throw new Error(
      "WhatsApp interaction projection parent could not verify its private message store",
    );
  }
}

async function captureInteractionProjectionParentIdentity(
  store: string,
): Promise<InteractionProjectionParentIdentity> {
  try {
    if (await realpath(store) !== store) throw new Error("non-canonical");
    const [storeStats, sessionStats, messageStoreStats] = await Promise.all([
      lstat(store, { bigint: true }),
      lstat(join(store, "session.db"), { bigint: true }),
      lstat(join(store, "wacli.db"), { bigint: true }),
    ]);
    assertParentInteractionProjectionIdentity(
      storeStats,
      sessionStats,
      messageStoreStats,
    );
    return Object.freeze({
      store: storeStats,
      session: sessionStats,
      messageStore: messageStoreStats,
    });
  } catch {
    throw new Error(
      "WhatsApp interaction projection parent could not bind its private stores",
    );
  }
}

async function revalidateInteractionProjectionParentIdentity(
  store: string,
  initial: InteractionProjectionParentIdentity,
): Promise<void> {
  try {
    if (await realpath(store) !== store) throw new Error("non-canonical");
    const [storeStats, sessionStats, messageStoreStats] = await Promise.all([
      lstat(store, { bigint: true }),
      lstat(join(store, "session.db"), { bigint: true }),
      lstat(join(store, "wacli.db"), { bigint: true }),
    ]);
    assertParentInteractionProjectionIdentity(
      storeStats,
      sessionStats,
      messageStoreStats,
    );
    if (
      !sameContactProjectionSnapshot(initial.store, storeStats)
      || !sameContactProjectionSnapshot(initial.session, sessionStats)
      || !sameContactProjectionSnapshot(initial.messageStore, messageStoreStats)
    ) throw new Error("identity changed");
  } catch {
    throw new Error(
      "WhatsApp interaction projection parent binding changed during the helper read",
    );
  }
}

type FixedContactProjectionFiles = Readonly<{
  helper: string;
  config: string;
}>;

async function fixedContactProjectionFile(
  pathValue: string,
): Promise<string | null> {
  try {
    const stats = await lstat(pathValue);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.nlink !== 1
      || stats.size < 1
      || stats.size > 2 * 1024 * 1024
      || (stats.mode & 0o022) !== 0
      || (uid !== null && stats.uid !== uid && stats.uid !== 0)
      || await realpath(pathValue) !== pathValue
    ) {
      throw new Error("unsafe fixed file");
    }
    return pathValue;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return null;
    throw new Error(
      "WhatsApp contact projection fixed helper files failed validation",
    );
  }
}

async function resolveFixedContactProjectionFiles(
  helperName = "whatsapp-contact-projection-helper.ts",
): Promise<
  FixedContactProjectionFiles
> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    {
      helper: resolve(
        moduleDirectory,
        helperName,
      ),
      config: resolve(moduleDirectory, "../state-helper.bunfig.toml"),
    },
    {
      helper: resolve(
        moduleDirectory,
        `../src/providers/${helperName}`,
      ),
      config: resolve(
        moduleDirectory,
        "../src/state-helper.bunfig.toml",
      ),
    },
  ] as const;
  for (const candidate of candidates) {
    const [helper, config] = await Promise.all([
      fixedContactProjectionFile(candidate.helper),
      fixedContactProjectionFile(candidate.config),
    ]);
    if (helper === null && config === null) continue;
    if (helper === null || config === null) {
      throw new Error(
        "WhatsApp contact projection fixed helper installation is incomplete",
      );
    }
    return Object.freeze({ helper, config });
  }
  throw new Error(
    "WhatsApp contact projection fixed helper is not installed",
  );
}

function contactProjectionEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  });
}

export async function runWhatsAppContactProjectionHelperChild(
  invocation: WhatsAppContactProjectionHelperInvocation,
): Promise<WhatsAppContactProjectionHelperResult> {
  const isAborted = (): boolean => invocation.signal?.aborted === true;
  if (isAborted()) {
    throw new Error("WhatsApp contact projection helper was cancelled");
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([...invocation.command], {
      cwd: invocation.cwd,
      env: { ...invocation.environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch {
    throw new Error("WhatsApp contact projection helper could not start");
  }

  if (invocation.onSpawned !== undefined) {
    try {
      invocation.onSpawned(child.pid);
    } catch (error) {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // child.exited below is still the exact cleanup proof.
      }
      try {
        await child.exited;
      } catch {
        throw new WhatsAppContactProjectionCleanupUnverifiedError();
      }
      throw error;
    }
  }

  let timedOut = false;
  let cancelled = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let terminationStarted = false;
  const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ESRCH"
        ) return;
      }
    }
    try {
      child.kill(signal);
    } catch {
      // child.exited remains the cleanup proof. If it cannot settle, the
      // registered cleanup barrier reaches the kernel's unsafe bounded join.
    }
  };
  const terminate = (): void => {
    if (!terminationStarted) {
      terminationStarted = true;
      signalChild("SIGTERM");
    }
    forceKill ??= setTimeout(
      () => signalChild("SIGKILL"),
      CONTACT_PROJECTION_FORCE_KILL_DELAY_MS,
    );
  };
  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  invocation.signal?.addEventListener("abort", onAbort, { once: true });
  if (isAborted()) onAbort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, invocation.timeoutMs);

  const guarded = <T>(promise: Promise<T>): Promise<T> =>
    promise.catch((error: unknown) => {
      terminate();
      throw error;
    });
  const stdin = guarded((async () => {
    await child.stdin.write(invocation.stdin);
    await child.stdin.end();
  })());
  const stdout = guarded(readBoundedStream(
    child.stdout,
    invocation.maxOutputBytes,
  ));
  const stderr = guarded(readBoundedStream(
    child.stderr,
    invocation.maxStderrBytes,
  ));
  const exited = child.exited;
  try {
    const [stdinResult, stdoutResult, stderrResult, exitResult] =
      await Promise.allSettled([stdin, stdout, stderr, exited]);
    if (exitResult.status === "rejected") {
      throw new WhatsAppContactProjectionCleanupUnverifiedError();
    }
    if (
      stdinResult.status === "rejected"
      || stdoutResult.status === "rejected"
      || stderrResult.status === "rejected"
    ) {
      throw new Error(
        "WhatsApp contact projection helper stream failed within its bound",
      );
    }
    if (cancelled) {
      throw new Error("WhatsApp contact projection helper was cancelled");
    }
    if (timedOut) {
      throw new Error("WhatsApp contact projection helper timed out");
    }
    return Object.freeze({
      exitCode: exitResult.value,
      stdout: stdoutResult.value,
      stderr: stderrResult.value,
    });
  } finally {
    clearTimeout(timeout);
    if (forceKill !== undefined) clearTimeout(forceKill);
    invocation.signal?.removeEventListener("abort", onAbort);
  }
}

class CanonicalSessionFrameDecoder {
  readonly #maximumFrameBytes: number;
  readonly #onFrame: (frame: WhatsAppMessageExportSessionCanonicalFrame) => void;
  #chunks: Buffer[] = [];
  #pendingBytes = 0;
  #frameCount = 0;

  constructor(
    maximumFrameBytes: number,
    onFrame: (frame: WhatsAppMessageExportSessionCanonicalFrame) => void,
  ) {
    this.#maximumFrameBytes = maximumFrameBytes;
    this.#onFrame = onFrame;
  }

  get frameCount(): number {
    return this.#frameCount;
  }

  #append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#pendingBytes += bytes.byteLength;
    if (this.#pendingBytes + 1 > this.#maximumFrameBytes) {
      throw new Error("WhatsApp projection session frame exceeded its bound");
    }
    // Copy bounded pieces so replay may safely reuse its fixed read buffer.
    this.#chunks.push(Buffer.from(bytes));
  }

  #finishLine(): void {
    if (
      this.#pendingBytes < 2
      || this.#pendingBytes + 1 > this.#maximumFrameBytes
      || this.#frameCount >= MESSAGE_EXPORT_SESSION_MAX_FRAMES
    ) throw new Error("WhatsApp projection session frame exceeded its bound");
    const bytes = this.#chunks.length === 1
      ? this.#chunks[0]!
      : Buffer.concat(this.#chunks, this.#pendingBytes);
    this.#chunks = [];
    this.#pendingBytes = 0;
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("WhatsApp projection session frame was malformed");
    }
    if (line.includes("\r")) {
      throw new Error("WhatsApp projection session frame exceeded its bound");
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("WhatsApp projection session frame was malformed");
    }
    const canonical = canonicalJson(value);
    if (canonical !== line || !Buffer.from(canonical, "utf8").equals(bytes)) {
      throw new Error("WhatsApp projection session frame was not canonical");
    }
    this.#frameCount += 1;
    this.#onFrame(Object.freeze({
      index: this.#frameCount,
      canonical,
      value,
    }));
  }

  push(bytes: Uint8Array): void {
    let start = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      this.#append(bytes.subarray(start, index));
      this.#finishLine();
      start = index + 1;
    }
    this.#append(bytes.subarray(start));
  }

  finish(): void {
    if (this.#pendingBytes !== 0 || this.#chunks.length !== 0) {
      throw new Error("WhatsApp projection session ended inside a frame");
    }
  }
}

type MutableWhatsAppMessageExportSessionSpool = Readonly<{
  handle: FileHandle;
  capture: (
    stream: ReadableStream<Uint8Array>,
    maximumFrameBytes: number,
    onFrame: ((frame: WhatsAppMessageExportSessionCanonicalFrame) => void) | undefined,
  ) => Readonly<{ promise: Promise<void>; cancel: () => Promise<void> }>;
  publicSpool: WhatsAppMessageExportSessionSpool;
}>;

function sameSpoolDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.birthtimeNs === right.birthtimeNs;
}

function assertPrivateSpoolDirectory(stats: BigIntStats): void {
  const uid = process.getuid?.();
  if (
    uid === undefined
    || !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(uid)
    || (stats.mode & 0o777n) !== BigInt(MESSAGE_EXPORT_SESSION_PRIVATE_DIRECTORY_MODE)
  ) throw new WhatsAppContactProjectionCleanupUnverifiedError();
}

function assertPrivateSpoolFile(
  stats: BigIntStats,
  identity: Readonly<{ dev: bigint; ino: bigint }>,
  expectedBytes?: number,
): void {
  const uid = process.getuid?.();
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || uid === undefined
    || stats.uid !== BigInt(uid)
    || (stats.mode & 0o777n) !== BigInt(MESSAGE_EXPORT_SESSION_PRIVATE_FILE_MODE)
    || stats.nlink !== 0n
    || stats.dev !== identity.dev
    || stats.ino !== identity.ino
    || (expectedBytes !== undefined && stats.size !== BigInt(expectedBytes))
  ) throw new WhatsAppContactProjectionCleanupUnverifiedError();
}

async function writeSpoolBytes(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (written.bytesWritten < 1) {
      throw new WhatsAppContactProjectionCleanupUnverifiedError();
    }
    offset += written.bytesWritten;
  }
}

async function createWhatsAppMessageExportSessionSpool(): Promise<
  MutableWhatsAppMessageExportSessionSpool
> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "wrench-whatsapp-stdout-")));
  const path = join(directory, "stdout.ndjson");
  let handle: FileHandle | undefined;
  let directoryHandle: FileHandle | undefined;
  let cleanupDirectoryIdentity: BigIntStats | undefined;
  try {
    await chmod(directory, MESSAGE_EXPORT_SESSION_PRIVATE_DIRECTORY_MODE);
    const directoryFlags = fsConstants.O_RDONLY
      | fsConstants.O_NOFOLLOW
      | (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0);
    directoryHandle = await open(directory, directoryFlags);
    const directoryIdentity = await directoryHandle.stat({ bigint: true });
    cleanupDirectoryIdentity = directoryIdentity;
    assertPrivateSpoolDirectory(directoryIdentity);
    const directoryPathIdentity = await lstat(directory, { bigint: true });
    assertPrivateSpoolDirectory(directoryPathIdentity);
    if (!sameSpoolDirectory(directoryIdentity, directoryPathIdentity)) {
      throw new WhatsAppContactProjectionCleanupUnverifiedError();
    }
    const assertDirectoryBinding = async (): Promise<void> => {
      const [descriptor, current] = await Promise.all([
        directoryHandle!.stat({ bigint: true }),
        lstat(directory, { bigint: true }),
      ]);
      assertPrivateSpoolDirectory(descriptor);
      assertPrivateSpoolDirectory(current);
      if (
        !sameSpoolDirectory(directoryIdentity, descriptor)
        || !sameSpoolDirectory(directoryIdentity, current)
      ) throw new WhatsAppContactProjectionCleanupUnverifiedError();
    };
    const uid = process.getuid?.();
    if (uid === undefined) throw new WhatsAppContactProjectionCleanupUnverifiedError();
    handle = await open(
      path,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      MESSAGE_EXPORT_SESSION_PRIVATE_FILE_MODE,
    );
    await handle.chmod(MESSAGE_EXPORT_SESSION_PRIVATE_FILE_MODE);
    const linked = await handle.stat({ bigint: true });
    const entry = await lstat(path, { bigint: true });
    if (
      !linked.isFile()
      || linked.isSymbolicLink()
      || linked.nlink !== 1n
      || linked.dev !== entry.dev
      || linked.ino !== entry.ino
      || linked.uid !== BigInt(uid)
      || (linked.mode & 0o777n) !== BigInt(MESSAGE_EXPORT_SESSION_PRIVATE_FILE_MODE)
    ) throw new Error("WhatsApp projection session private spool file was invalid");
    const fileIdentity = Object.freeze({ dev: linked.dev, ino: linked.ino });
    await assertDirectoryBinding();
    await unlink(path);
    assertPrivateSpoolFile(await handle.stat({ bigint: true }), fileIdentity, 0);
    await assertDirectoryBinding();

    let sealed: Readonly<{
      frameCount: number;
      totalBytes: number;
      stdoutSha256: string;
      maximumFrameBytes: number;
      metadata: BigIntStats;
    }> | undefined;
    let closed = false;
    let replayStarted = false;
    let replayActive = false;

    const capture = (
      stream: ReadableStream<Uint8Array>,
      maximumFrameBytes: number,
      onFrame: ((frame: WhatsAppMessageExportSessionCanonicalFrame) => void) | undefined,
    ) => {
      const reader = stream.getReader();
      const digest = createHash("sha256");
      const decoder = new CanonicalSessionFrameDecoder(
        maximumFrameBytes,
        onFrame ?? (() => undefined),
      );
      let totalBytes = 0;
      const promise = (async (): Promise<void> => {
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            const nextTotal = totalBytes + item.value.byteLength;
            if (nextTotal > MESSAGE_EXPORT_SESSION_MAX_TOTAL_STDOUT_BYTES) {
              throw new Error("WhatsApp projection session output exceeded its total bound");
            }
            await writeSpoolBytes(handle!, item.value, totalBytes);
            digest.update(item.value);
            decoder.push(item.value);
            totalBytes = nextTotal;
          }
          decoder.finish();
          await assertDirectoryBinding();
          await handle!.sync();
          const metadata = await handle!.stat({ bigint: true });
          assertPrivateSpoolFile(metadata, fileIdentity, totalBytes);
          sealed = Object.freeze({
            frameCount: decoder.frameCount,
            totalBytes,
            stdoutSha256: digest.digest("hex"),
            maximumFrameBytes,
            metadata,
          });
        } finally {
          reader.releaseLock();
        }
      })();
      return Object.freeze({
        promise,
        cancel: async () => {
          try { await reader.cancel(); } catch { /* settlement remains authoritative */ }
        },
      });
    };

    const replay = async function* <Value>(
      project: (frame: WhatsAppMessageExportSessionCanonicalFrame) => Value,
    ): AsyncGenerator<Value> {
      if (closed || sealed === undefined || replayStarted || replayActive) {
        throw new WhatsAppContactProjectionCleanupUnverifiedError();
      }
      replayStarted = true;
      replayActive = true;
      const expected = sealed;
      const digest = createHash("sha256");
      const decoded: WhatsAppMessageExportSessionCanonicalFrame[] = [];
      const decoder = new CanonicalSessionFrameDecoder(
        expected.maximumFrameBytes,
        (frame) => decoded.push(frame),
      );
      const buffer = Buffer.allocUnsafe(MESSAGE_EXPORT_SESSION_SPOOL_CHUNK_BYTES);
      let position = 0;
      try {
        await assertDirectoryBinding();
        assertPrivateSpoolFile(await handle!.stat({ bigint: true }), fileIdentity, expected.totalBytes);
        while (position < expected.totalBytes) {
          const length = Math.min(buffer.byteLength, expected.totalBytes - position);
          const item = await handle!.read(buffer, 0, length, position);
          if (item.bytesRead < 1) throw new WhatsAppContactProjectionCleanupUnverifiedError();
          const bytes = buffer.subarray(0, item.bytesRead);
          digest.update(bytes);
          decoder.push(bytes);
          position += item.bytesRead;
          while (decoded.length > 0) yield project(decoded.shift()!);
        }
        decoder.finish();
        if (
          position !== expected.totalBytes
          || decoder.frameCount !== expected.frameCount
          || digest.digest("hex") !== expected.stdoutSha256
        ) throw new WhatsAppContactProjectionCleanupUnverifiedError();
        await assertDirectoryBinding();
        const after = await handle!.stat({ bigint: true });
        assertPrivateSpoolFile(after, fileIdentity, expected.totalBytes);
        if (
          after.mtimeNs !== expected.metadata.mtimeNs
          || after.ctimeNs !== expected.metadata.ctimeNs
        ) throw new WhatsAppContactProjectionCleanupUnverifiedError();
      } finally {
        replayActive = false;
      }
    };

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try {
        await handle!.close();
      } catch (error) {
        failure = error;
      }
      try {
        const descriptor = await directoryHandle!.stat({ bigint: true });
        const current = await lstat(directory, { bigint: true });
        const entries = await readdir(directory);
        assertPrivateSpoolDirectory(descriptor);
        assertPrivateSpoolDirectory(current);
        if (
          !sameSpoolDirectory(directoryIdentity, descriptor)
          || !sameSpoolDirectory(directoryIdentity, current)
          || entries.length !== 0
        ) {
          throw new WhatsAppContactProjectionCleanupUnverifiedError();
        }
        await rmdir(directory);
      } catch (error) {
        failure = failure === undefined
          ? error
          : new AggregateError([failure, error], "WhatsApp projection spool cleanup failed");
      }
      try {
        await directoryHandle!.close();
      } catch (error) {
        failure = failure === undefined
          ? error
          : new AggregateError([failure, error], "WhatsApp projection spool cleanup failed");
      }
      if (failure !== undefined) throw new WhatsAppContactProjectionCleanupUnverifiedError();
    };

    const publicSpool: WhatsAppMessageExportSessionSpool = Object.freeze({
      get frameCount() { return sealed?.frameCount ?? 0; },
      get totalBytes() { return sealed?.totalBytes ?? 0; },
      get stdoutSha256() { return sealed?.stdoutSha256 ?? ""; },
      replay,
      close,
    });
    return Object.freeze({ handle, capture, publicSpool });
  } catch (error) {
    try { await handle?.close(); } catch { /* original creation failure remains primary */ }
    let exactDirectory = false;
    if (directoryHandle !== undefined && cleanupDirectoryIdentity !== undefined) {
      try {
        const [descriptor, current] = await Promise.all([
          directoryHandle.stat({ bigint: true }),
          lstat(directory, { bigint: true }),
        ]);
        exactDirectory = sameSpoolDirectory(cleanupDirectoryIdentity, descriptor)
          && sameSpoolDirectory(cleanupDirectoryIdentity, current);
      } catch {
        exactDirectory = false;
      }
    }
    if (exactDirectory) {
      try { await unlink(path); } catch { /* it may already be anonymous */ }
      try {
        if ((await readdir(directory)).length === 0) await rmdir(directory);
      } catch { /* empty private residue contains no stdout bytes */ }
    }
    try { await directoryHandle?.close(); } catch { /* original creation failure remains primary */ }
    throw error;
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * Runs the one-process Message Like Me projection session. Its anonymous
 * parent-owned stdout spool is withheld until stdout EOF, bounded stderr,
 * exact child exit, and process-group absence all settle. Any unproved reap is
 * a durable cleanup-boundary failure.
 */
export async function runWhatsAppMessageExportSessionHelperChild(
  invocation: WhatsAppContactProjectionHelperInvocation,
): Promise<WhatsAppMessageExportSessionHelperResult> {
  const isAborted = (): boolean => invocation.signal?.aborted === true;
  if (isAborted()) {
    throw new Error("WhatsApp projection session helper was cancelled");
  }
  const spool = await createWhatsAppMessageExportSessionSpool();
  if (isAborted()) {
    await spool.publicSpool.close();
    throw new Error("WhatsApp projection session helper was cancelled");
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([...invocation.command], {
      cwd: invocation.cwd,
      env: { ...invocation.environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    try {
      await spool.publicSpool.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "WhatsApp projection session spawn and spool cleanup both failed",
      );
    }
    throw new Error("WhatsApp projection session helper could not start");
  }

  let childExited = false;
  const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if (errnoCode(error) === "ESRCH") return;
        // Fall through to the exact child handle when group signalling is not
        // available; child.exited and the post-join group probe remain proof.
      }
    }
    try { child.kill(signal); } catch { /* exact child.exited remains authoritative */ }
  };
  let terminationStarted = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectCleanupDeadline: ((error: unknown) => void) | undefined;
  let cleanupDeadlineExpired = false;
  const cleanupDeadline = new Promise<never>((_resolve, reject) => {
    rejectCleanupDeadline = reject;
  });
  const terminate = (): void => {
    if (!terminationStarted) {
      terminationStarted = true;
      signalChild("SIGTERM");
      forceKill = setTimeout(() => {
        signalChild("SIGKILL");
      }, CONTACT_PROJECTION_FORCE_KILL_DELAY_MS);
      reapTimer = setTimeout(
        () => {
          cleanupDeadlineExpired = true;
          rejectCleanupDeadline?.(new WhatsAppContactProjectionCleanupUnverifiedError());
        },
        CONTACT_PROJECTION_FORCE_KILL_DELAY_MS * 2,
      );
      unrefTimer(forceKill);
      unrefTimer(reapTimer);
    }
  };
  let timedOut = false;
  let cancelled = false;
  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  invocation.signal?.addEventListener("abort", onAbort, { once: true });
  if (isAborted()) onAbort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, invocation.timeoutMs);
  unrefTimer(timeout);
  const guarded = <T>(promise: Promise<T>): Promise<T> => promise.catch((error: unknown) => {
    terminate();
    throw error;
  });
  const capture = spool.capture(
    child.stdout,
    invocation.maxOutputBytes,
    invocation.onCanonicalFrame,
  );
  const frames = guarded(capture.promise);
  const stderrRead = readBoundedStreamControlled(child.stderr, invocation.maxStderrBytes);
  const stderr = guarded(stderrRead.promise);
  const exited = child.exited.then(
    (exitCode) => {
      childExited = true;
      return exitCode;
    },
    (error: unknown) => {
      terminate();
      throw error;
    },
  );
  let callbackFailure: unknown;
  try {
    invocation.onSpawned?.(child.pid);
  } catch (error) {
    callbackFailure = error;
    terminate();
  }
  const stdin = callbackFailure === undefined
    ? guarded((async () => {
        await child.stdin.write(invocation.stdin);
        await child.stdin.end();
      })())
    : guarded((async () => {
        await child.stdin.end();
      })());

  const processGroupIsAbsent = (): boolean => {
    if (process.platform === "win32") return true;
    try {
      process.kill(-child.pid, 0);
      return false;
    } catch (error) {
      if (errnoCode(error) === "ESRCH") return true;
      throw new WhatsAppContactProjectionCleanupUnverifiedError();
    }
  };
  let unexpectedDescendantObserved = false;
  const joinProcessGroup = async (): Promise<void> => {
    if (processGroupIsAbsent()) return;
    unexpectedDescendantObserved = true;
    terminate();
    for (;;) {
      if (cleanupDeadlineExpired) {
        throw new WhatsAppContactProjectionCleanupUnverifiedError();
      }
      if (processGroupIsAbsent()) return;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  };
  let transferred = false;
  try {
    const settled = await Promise.race([
      Promise.allSettled([stdin, frames, stderr, exited]),
      cleanupDeadline,
    ]);
    const [stdinResult, framesResult, stderrResult, exitResult] = settled;
    await Promise.race([joinProcessGroup(), cleanupDeadline]);
    if (exitResult.status === "rejected") {
      throw new WhatsAppContactProjectionCleanupUnverifiedError();
    }
    if (unexpectedDescendantObserved) {
      throw new Error("WhatsApp projection session helper left an unexpected descendant");
    }
    if (callbackFailure !== undefined) throw callbackFailure;
    if (cancelled) throw new Error("WhatsApp projection session helper was cancelled");
    if (timedOut) throw new Error("WhatsApp projection session helper timed out");
    if (
      stdinResult.status === "rejected"
      || framesResult.status === "rejected"
      || stderrResult.status === "rejected"
    ) {
      const failure = framesResult.status === "rejected"
        ? framesResult.reason
        : stderrResult.status === "rejected"
          ? stderrResult.reason
          : stdinResult.status === "rejected"
            ? stdinResult.reason
            : undefined;
      throw failure instanceof Error
        ? failure
        : new Error("WhatsApp projection session stream failed within its bound");
    }
    transferred = true;
    return Object.freeze({
      exitCode: exitResult.value,
      spool: spool.publicSpool,
      stderr: stderrResult.value,
    });
  } catch (error) {
    const detach = (): void => {
      void capture.cancel();
      void stderrRead.cancel();
      void Promise.resolve(child.stdin.end()).catch(() => undefined);
      if (!childExited) child.unref();
    };
    detach();
    if (cleanupDeadlineExpired) {
      void spool.publicSpool.close().catch(() => undefined);
      throw error;
    }
    await Promise.allSettled([
      capture.promise,
      stderrRead.promise,
      child.stdin.end(),
    ]);
    try {
      await spool.publicSpool.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "WhatsApp projection session operation and spool cleanup both failed",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (reapTimer !== undefined) clearTimeout(reapTimer);
    if (forceKill !== undefined) clearTimeout(forceKill);
    invocation.signal?.removeEventListener("abort", onAbort);
    if (!transferred && !childExited) child.unref();
  }
}

/**
 * Ordinary projection and schema errors have no live-resource consequence.
 * Only the dedicated process-cleanup uncertainty crosses the cleanup barrier.
 */
export function whatsappContactProjectionCleanupBarrier(
  operation: Promise<unknown>,
): Promise<void> {
  return operation.then(
    () => undefined,
    (error: unknown) => {
      if (containsWhatsAppContactProjectionCleanupUnverified(error)) {
        throw error;
      }
    },
  );
}

function unavailableWhatsAppDirectionStats() {
  return Object.freeze({
    count: null,
    complete: false,
    lowerBound: false,
    truncated: false,
    lastAt: null,
    lastAtComplete: false,
    lastAtBasis: "unavailable" as const,
    incompleteReasons: Object.freeze([
      "whatsapp-message-store-account-owner-unavailable",
    ]),
  });
}

async function projectWhatsAppLocalContacts(
  auth: WhatsAppAuth,
  recipe: WebSessionRecipe,
  input: OperationInput,
  dependencies: WhatsAppWebRuntimeDependencies | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
  registerCleanupBarrier: WebSessionCleanupBarrierRegistrar | undefined,
): Promise<WebSessionExecution> {
  const parsedInput = exactContactInput(input);
  if (parsedInput.collection !== "contacts") {
    throw new Error("WhatsApp contact projection requires collection=contacts");
  }
  if (auth.subject === undefined) {
    throw new Error(
      "WhatsApp linked-device auth must be bound to its current account before private reads",
    );
  }
  let accountSubject: string;
  try {
    accountSubject = parseWhatsAppContactProjectionSubject(
      auth.subject,
    ).subject;
  } catch {
    throw new Error(
      "WhatsApp linked-device auth subject is not a PN or LID account",
    );
  }
  const rawOperation = startWebSessionCleanupTrackedOperation(
    registerCleanupBarrier,
    async () => {
      operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
      const store = await validateWhatsAppStoreDirectory(
        auth.path,
        "contact-projection",
      );
      const initial = await captureContactProjectionParentIdentity(store);
      const fixed = await resolveFixedContactProjectionFiles();
      const request = Object.freeze({
        schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
        operation: "contacts.list",
        accountSubject,
        cursor: parsedInput.cursor,
        limit: parsedInput.limit,
        storeIdentity: Object.freeze({
          dev: initial.store.dev.toString(),
          ino: initial.store.ino.toString(),
        }),
        sessionIdentity: Object.freeze({
          dev: initial.session.dev.toString(),
          ino: initial.session.ino.toString(),
        }),
      }) satisfies WhatsAppContactProjectionRequest;
      const timeoutMs = remainingTimeoutMs(
        recipe.timeoutMs,
        operationDeadline,
      );
      const invocation = Object.freeze({
        command: Object.freeze([
          process.execPath,
          "--no-env-file",
          "--no-install",
          "--no-macros",
          "--no-addons",
          `--config=${fixed.config}`,
          fixed.helper,
        ]),
        cwd: store,
        environment: contactProjectionEnvironment(),
        stdin: `${JSON.stringify(request)}\n`,
        timeoutMs,
        maxOutputBytes: Math.min(
          recipe.maxOutputBytes,
          WHATSAPP_CONTACT_PROJECTION_MAX_STDOUT_BYTES,
        ),
        maxStderrBytes: MAX_CONTACT_PROJECTION_STDERR_BYTES,
        ...(operationDeadline === undefined
          ? {}
          : { signal: operationDeadline.signal }),
      }) satisfies WhatsAppContactProjectionHelperInvocation;
      const run = dependencies?.runContactProjectionHelper
        ?? runWhatsAppContactProjectionHelperChild;
      let childResult: WhatsAppContactProjectionHelperResult | undefined;
      let helperFailure: unknown;
      try {
        childResult = await run(invocation);
      } catch (error) {
        helperFailure = error;
      }
      let identityFailure: unknown;
      try {
        await revalidateContactProjectionParentIdentity(store, initial);
      } catch (error) {
        identityFailure = error;
      }
      if (
        helperFailure
          instanceof WhatsAppContactProjectionCleanupUnverifiedError
      ) {
        throw helperFailure;
      }
      if (identityFailure !== undefined) {
        throw identityFailure instanceof Error
          ? identityFailure
          : new Error(
              "WhatsApp contact projection parent binding became unverifiable",
            );
      }
      if (helperFailure !== undefined) {
        throw helperFailure instanceof Error
          ? helperFailure
          : new Error("WhatsApp contact projection helper failed");
      }
      if (childResult === undefined) {
        throw new Error("WhatsApp contact projection helper omitted its result");
      }
      if (childResult.exitCode !== 0 || childResult.stderr.length !== 0) {
        throw new Error(
          "WhatsApp contact projection helper failed before reviewed output",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(childResult.stdout.trim()) as unknown;
      } catch {
        throw new Error(
          "WhatsApp contact projection helper returned malformed output",
        );
      }
      let response: ReturnType<typeof parseWhatsAppContactProjectionResponse>;
      try {
        response = parseWhatsAppContactProjectionResponse(parsed, request);
      } catch {
        throw new Error(
          "WhatsApp contact projection helper returned unsupported output",
        );
      }
      if (response.status === "failed") {
        throw new Error(
          `WhatsApp contact projection helper rejected the local store (${response.errorCode})`,
        );
      }
      return response;
    },
    whatsappContactProjectionCleanupBarrier,
  );
  const response = operationDeadline === undefined
    ? await rawOperation
    : await operationDeadline.run(
        () => rawOperation,
        WEB_SESSION_OPERATION_LABEL,
      );
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);

  const directionStats = unavailableWhatsAppDirectionStats();
  const projectedStats = projectContactDirectionStats(
    directionStats,
    directionStats,
  );
  const output = Object.freeze({
    provider: "whatsapp",
    operation: "contacts.list",
    accountSubject,
    projection: "quiescent-account-bound-session-store",
    contacts: Object.freeze(response.contacts.map((contact) => Object.freeze({
      ...contact,
      alias: null,
      tags: Object.freeze([]),
      updatedAt: null,
      localProjectionStatsComplete: false,
      ...projectedStats,
    }))),
    nextCursor: response.nextCursor,
    localContactTablePageComplete: response.localContactTablePageComplete,
    remoteContactSetComplete: false,
    contactSetIncompleteReasons: Object.freeze([
      "linked-device-contact-sync-coverage-unknown",
    ]),
    statsScope: "unavailable",
    statsCompleteness: "unavailable",
  });
  return {
    status: "succeeded",
    output: outputWithinBound(output, recipe.maxOutputBytes),
    finalUrl: WHATSAPP_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

async function projectWhatsAppLocalInteractions(
  auth: WhatsAppAuth,
  recipe: WebSessionRecipe,
  parsedInput: Extract<ExactContactInput, { readonly collection: "interactions" }>,
  dependencies: WhatsAppWebRuntimeDependencies | undefined,
  operationDeadline: WebSessionOperationDeadline | undefined,
  registerCleanupBarrier: WebSessionCleanupBarrierRegistrar | undefined,
): Promise<WebSessionExecution> {
  if (auth.subject === undefined) {
    throw new Error(
      "WhatsApp linked-device auth must be bound to its current account before private reads",
    );
  }
  const accountSubject = auth.subject;
  const rawOperation = startWebSessionCleanupTrackedOperation(
    registerCleanupBarrier,
    async () => {
      operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
      const store = await validateWhatsAppStoreDirectory(auth.path, "projection");
      const initial = await captureInteractionProjectionParentIdentity(store);
      const fixed = await resolveFixedContactProjectionFiles(
        "whatsapp-interaction-projection-helper.ts",
      );
      const request = parseWhatsAppInteractionProjectionRequest({
        schemaVersion: WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION,
        operation: "contacts.interactions.list",
        accountSubject,
        cursor: parsedInput.cursor,
        cursorAnchor: parsedInput.cursorAnchor,
        limit: parsedInput.limit,
        storeIdentity: {
          dev: initial.store.dev.toString(),
          ino: initial.store.ino.toString(),
        },
        sessionIdentity: {
          dev: initial.session.dev.toString(),
          ino: initial.session.ino.toString(),
        },
        messageStoreIdentity: {
          dev: initial.messageStore.dev.toString(),
          ino: initial.messageStore.ino.toString(),
        },
      }) satisfies WhatsAppInteractionProjectionRequest;
      const timeoutMs = remainingTimeoutMs(recipe.timeoutMs, operationDeadline);
      const invocation = Object.freeze({
        command: Object.freeze([
          process.execPath,
          "--no-env-file",
          "--no-install",
          "--no-macros",
          "--no-addons",
          `--config=${fixed.config}`,
          fixed.helper,
        ]),
        cwd: store,
        environment: contactProjectionEnvironment(),
        stdin: `${JSON.stringify(request)}\n`,
        timeoutMs,
        maxOutputBytes: Math.min(
          recipe.maxOutputBytes,
          WHATSAPP_INTERACTION_PROJECTION_MAX_STDOUT_BYTES,
        ),
        maxStderrBytes: MAX_CONTACT_PROJECTION_STDERR_BYTES,
        ...(operationDeadline === undefined ? {} : { signal: operationDeadline.signal }),
      }) satisfies WhatsAppContactProjectionHelperInvocation;
      const run = dependencies?.runInteractionProjectionHelper
        ?? runWhatsAppContactProjectionHelperChild;
      let childResult: WhatsAppContactProjectionHelperResult | undefined;
      let helperFailure: unknown;
      try {
        childResult = await run(invocation);
      } catch (error) {
        helperFailure = error;
      }
      let identityFailure: unknown;
      try {
        await revalidateInteractionProjectionParentIdentity(store, initial);
      } catch (error) {
        identityFailure = error;
      }
      if (helperFailure instanceof WhatsAppContactProjectionCleanupUnverifiedError) {
        throw helperFailure;
      }
      if (identityFailure !== undefined) {
        throw identityFailure instanceof Error
          ? identityFailure
          : new Error("WhatsApp interaction projection parent binding became unverifiable");
      }
      if (helperFailure !== undefined) {
        throw helperFailure instanceof Error
          ? helperFailure
          : new Error("WhatsApp interaction projection helper failed");
      }
      if (
        childResult === undefined
        || childResult.exitCode !== 0
        || childResult.stderr.length !== 0
      ) {
        throw new Error(
          "WhatsApp interaction projection helper failed before reviewed output",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(childResult.stdout.trim()) as unknown;
      } catch {
        throw new Error("WhatsApp interaction projection helper returned malformed output");
      }
      let response: ReturnType<typeof parseWhatsAppInteractionProjectionResponse>;
      try {
        response = parseWhatsAppInteractionProjectionResponse(parsed, request);
      } catch {
        throw new Error("WhatsApp interaction projection helper returned unsupported output");
      }
      if (response.status === "failed") {
        throw new Error(
          `WhatsApp interaction projection helper rejected the local store (${response.errorCode})`,
        );
      }
      return response;
    },
    whatsappContactProjectionCleanupBarrier,
  );
  const response = operationDeadline === undefined
    ? await rawOperation
    : await operationDeadline.run(() => rawOperation, WEB_SESSION_OPERATION_LABEL);
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const output = Object.freeze({
    provider: "whatsapp",
    operation: "contacts.list",
    accountSubject,
    contactCollection: "interactions",
    projection: "quiescent-account-bound-local-message-inserts",
    projectionGeneration: response.projectionGeneration,
    interactions: response.interactions,
    nextCursor: response.nextCursor,
    localInsertPageComplete: response.localInsertPageComplete,
    checkpoint: response.checkpoint,
    remoteHistoryComplete: false,
    incompleteReasons: Object.freeze([
      "linked-device-history-coverage-unknown",
      "rowid-cursor-discovers-inserts-only",
    ]),
  });
  return {
    status: "succeeded",
    output: outputWithinBound(output, recipe.maxOutputBytes),
    finalUrl: WHATSAPP_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}
export type WhatsAppReadPlan =
  | {
      readonly action: "messaging.list";
      readonly command: readonly string[];
      readonly limit: number;
      readonly folder: "all" | "active" | "archived" | "unread";
    }
  | {
      readonly action: "messaging.read";
      readonly command: readonly string[];
      readonly limit: number;
      readonly conversationJid: string;
    }
  | {
      readonly action: "media.read";
      readonly command: readonly string[];
      readonly conversationJid: string;
      readonly messageId: string;
    };

export function planWhatsAppReadCommand(
  action: "messaging.list",
  input: OperationInput,
): Extract<WhatsAppReadPlan, { readonly action: "messaging.list" }>;
export function planWhatsAppReadCommand(
  action: "messaging.read",
  input: OperationInput,
): Extract<WhatsAppReadPlan, { readonly action: "messaging.read" }>;
export function planWhatsAppReadCommand(
  action: "media.read",
  input: OperationInput,
): Extract<WhatsAppReadPlan, { readonly action: "media.read" }>;
export function planWhatsAppReadCommand(
  action: WhatsAppReadPlan["action"],
  input: OperationInput,
): WhatsAppReadPlan;
export function planWhatsAppReadCommand(
  action: WhatsAppReadPlan["action"],
  input: OperationInput,
): WhatsAppReadPlan {
  if (action === "messaging.list") {
    const limit = inputInteger(input, "limit", DEFAULT_LIMIT, 100);
    const folder = inputFolder(input);
    const flags = folder === "active"
      ? ["--no-archived"]
      : folder === "archived"
        ? ["--archived"]
        : folder === "unread"
          ? ["--unread"]
          : [];
    return Object.freeze({
      action,
      limit,
      folder,
      command: Object.freeze([
        "chats",
        "list",
        "--limit",
        String(limit),
        ...flags,
      ]),
    });
  }
  const conversationJid = whatsappTargetJid(
    input.conversation_jid,
    "input.conversation_jid",
  );
  if (action === "messaging.read") {
    const limit = inputInteger(input, "limit", DEFAULT_LIMIT, 200);
    return Object.freeze({
      action,
      limit,
      conversationJid,
      command: Object.freeze([
        "messages",
        "list",
        "--chat",
        conversationJid,
        "--limit",
        String(limit),
      ]),
    });
  }
  const messageId = whatsappMessageId(
    input.message_id,
    "input.message_id",
  );
  return Object.freeze({
    action,
    conversationJid,
    messageId,
    command: Object.freeze([
      "messages",
      "show",
      "--chat",
      conversationJid,
      "--id",
      messageId,
    ]),
  });
}

function outputWithinBound(value: unknown, maximum: number): unknown {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    throw new Error("WhatsApp projected output exceeded its reviewed byte limit");
  }
  return value;
}

async function executeLocalProjection(
  runtime: Awaited<ReturnType<typeof boundRuntime>>,
  recipe: WebSessionRecipe,
  input: OperationInput,
  dependencies: WhatsAppWebRuntimeDependencies | undefined,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<WebSessionExecution> {
  let output: unknown;
  if (recipe.action === "messaging.list") {
    const plan = planWhatsAppReadCommand(recipe.action, input);
    const timeoutMs = remainingTimeoutMs(
      recipe.timeoutMs,
      operationDeadline,
    );
    const raw = await checkedRun(
      runtime.binary,
      readOnlyArguments(runtime.store, timeoutMs, plan.command),
      {
        timeoutMs,
        maxOutputBytes: recipe.maxOutputBytes,
        readOnly: true,
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(operationDeadline === undefined
          ? {}
          : { operationDeadline }),
      },
    );
    output = Object.freeze({
      accountSubject: runtime.subject,
      projection: "local-store",
      completeness: "bounded-current-local-projection",
      chats: projectWhatsAppChatsEnvelope(raw, plan.limit),
    });
  } else if (recipe.action === "messaging.read") {
    const plan = planWhatsAppReadCommand(recipe.action, input);
    const timeoutMs = remainingTimeoutMs(
      recipe.timeoutMs,
      operationDeadline,
    );
    const raw = await checkedRun(
      runtime.binary,
      readOnlyArguments(runtime.store, timeoutMs, plan.command),
      {
        timeoutMs,
        maxOutputBytes: recipe.maxOutputBytes,
        readOnly: true,
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(operationDeadline === undefined
          ? {}
          : { operationDeadline }),
      },
    );
    output = Object.freeze({
      accountSubject: runtime.subject,
      projection: "local-store",
      completeness: "bounded-current-local-projection",
      conversationJid: plan.conversationJid,
      ...projectWhatsAppMessagesEnvelope(
        raw,
        plan.conversationJid,
        plan.limit,
      ),
    });
  } else if (recipe.action === "media.read") {
    const plan = planWhatsAppReadCommand(recipe.action, input);
    const timeoutMs = remainingTimeoutMs(
      recipe.timeoutMs,
      operationDeadline,
    );
    const raw = await checkedRun(
      runtime.binary,
      readOnlyArguments(runtime.store, timeoutMs, plan.command),
      {
        timeoutMs,
        maxOutputBytes: recipe.maxOutputBytes,
        readOnly: true,
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(operationDeadline === undefined
          ? {}
          : { operationDeadline }),
      },
    );
    const message = projectWhatsAppMessageEnvelope(
      raw,
      plan.conversationJid,
      plan.messageId,
    );
    output = Object.freeze({
      accountSubject: runtime.subject,
      projection: "local-store",
      completeness: "one-local-message",
      conversationJid: plan.conversationJid,
      messageId: plan.messageId,
      media: message.media,
    });
  } else {
    throw new Error("WhatsApp operation has no local projection");
  }
  return {
    status: "succeeded",
    output: outputWithinBound(output, recipe.maxOutputBytes),
    finalUrl: WHATSAPP_ORIGIN,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

export async function executeWhatsAppWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "whatsapp"
    || (recipe.action === "contacts.list"
      ? recipe.contractVersion !== 2
      : recipe.contractVersion !== 1)
    || !isWhatsAppOperation(recipe.action)
  ) throw new Error("WhatsApp linked-device recipe is not installed");
  const contract = WHATSAPP_WEB_OPERATIONS[recipe.action];
  if (contract.state !== "observed") {
    throw new Error(
      `WhatsApp linked-device operation ${recipe.action} is capture-required: ${contract.reason}`,
    );
  }
  const localProjection = recipe.action === "contacts.list"
    || recipe.action === "messaging.list"
    || recipe.action === "messaging.read"
    || recipe.action === "media.read";
  if (!localProjection) {
    throw new Error(
      `WhatsApp linked-device operation ${recipe.action} has no executable local projection`,
    );
  }
  options.operationDeadline?.throwIfUnavailable(
    WEB_SESSION_OPERATION_LABEL,
  );
  if (recipe.action === "contacts.list") {
    const parsedInput = exactContactInput(input);
    if (parsedInput.collection === "interactions") {
      return projectWhatsAppLocalInteractions(
        requireWhatsAppAuth(auth),
        recipe,
        parsedInput,
        options.dependencies,
        options.operationDeadline,
        options.registerCleanupBarrier,
      );
    }
    return projectWhatsAppLocalContacts(
      requireWhatsAppAuth(auth),
      recipe,
      input,
      options.dependencies,
      options.operationDeadline,
      options.registerCleanupBarrier,
    );
  }
  const runtime = await boundRuntime(
    auth,
    "projection",
    recipe.timeoutMs,
    options.dependencies,
    options.environment ?? process.env,
    options.operationDeadline,
  );
  if (localProjection) {
    return executeLocalProjection(
      runtime,
      recipe,
      input,
      options.dependencies,
      options.operationDeadline,
    );
  }
  throw new Error("WhatsApp local projection classification changed during execution");
}

export type WhatsAppPairingPlan = {
  readonly binary: string;
  readonly store: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
};

export async function planWhatsAppPairing(
  auth: WrenchAuth,
  options: {
    readonly phone?: string;
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<WhatsAppPairingPlan> {
  const linked = requireWhatsAppAuth(auth);
  const store = await validateWhatsAppStoreDirectory(linked.path, "pair");
  const binary = await runtimeBinary(
    options.dependencies,
    options.environment ?? process.env,
  );
  const phone = options.phone;
  if (
    phone !== undefined
    && !/^\+?[0-9]{5,20}$/u.test(phone)
  ) throw new Error("WhatsApp pairing phone must be one international number");
  return Object.freeze({
    binary,
    store,
    arguments: Object.freeze([
      "--store",
      store,
      "--timeout",
      "10m",
      "auth",
      "--idle-exit",
      "30s",
      "--qr-format",
      "terminal",
      ...(phone === undefined ? [] : ["--phone", phone]),
    ]),
    environment: Object.freeze({
      ...wacliEnvironment(false),
      WACLI_SYNC_MAX_MESSAGES: String(MAX_SYNC_MESSAGES),
      WACLI_SYNC_MAX_DB_SIZE: MAX_SYNC_DB_SIZE,
    }),
  });
}

async function runInteractivePairing(
  plan: WhatsAppPairingPlan,
): Promise<number> {
  const child = Bun.spawn(
    [plan.binary, ...plan.arguments],
    {
      env: { ...plan.environment },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return child.exited;
}

export async function pairWhatsAppAuth(
  auth: WrenchAuth,
  options: {
    readonly phone?: string;
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
  },
): Promise<string> {
  const plan = await planWhatsAppPairing(auth, options);
  const run = options.dependencies?.runInteractive ?? runInteractivePairing;
  await options.attempt.beforeExternalBegin();
  if (await run(plan) !== 0) {
    throw new Error("WhatsApp linked-device pairing did not complete");
  }
  return probeWhatsAppWebSubject(auth, {
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    timeoutMs: 10_000,
  });
}

export type WhatsAppSyncPlan = {
  readonly binary: string;
  readonly store: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly emitsProtocolAcknowledgements: true;
};

export async function planWhatsAppSyncOnce(
  auth: WrenchAuth,
  options: {
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<WhatsAppSyncPlan> {
  const linked = requireWhatsAppAuth(auth);
  const store = await validateWhatsAppStoreDirectory(linked.path, "sync");
  const binary = await runtimeBinary(
    options.dependencies,
    options.environment ?? process.env,
  );
  return Object.freeze({
    binary,
    store,
    arguments: Object.freeze([
      "--store",
      store,
      "--json",
      "--full",
      "--timeout",
      "5m",
      "sync",
      "--once",
      "--presence-mode",
      "quiet",
      "--idle-exit",
      "30s",
      "--max-reconnect",
      "1m",
      "--max-messages",
      String(MAX_SYNC_MESSAGES),
      "--max-db-size",
      MAX_SYNC_DB_SIZE,
    ]),
    environment: wacliEnvironment(false),
    emitsProtocolAcknowledgements: true,
  });
}

export async function syncWhatsAppAuthOnce(
  auth: WrenchAuth,
  options: {
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
  },
): Promise<{ readonly messagesStored: number }> {
  const linked = requireWhatsAppAuth(auth);
  if (linked.subject === undefined) {
    throw new Error("WhatsApp linked-device auth must be account-bound before sync");
  }
  const currentSubject = await probeWhatsAppWebSubject(linked, {
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    timeoutMs: 10_000,
  });
  if (currentSubject !== linked.subject) {
    throw new Error("WhatsApp sync account did not match the bound auth realm");
  }
  const plan = await planWhatsAppSyncOnce(auth, options);
  const run = options.dependencies?.run ?? runWacli;
  await options.attempt.beforeExternalBegin();
  const result = await run({
    binary: plan.binary,
    arguments: plan.arguments,
    environment: plan.environment,
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error("WhatsApp linked-device synchronization failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw new Error("WhatsApp linked-device synchronization returned malformed JSON");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",") !== "data,error,success"
    || !("success" in parsed)
    || parsed.success !== true
    || !("error" in parsed)
    || parsed.error !== null
    || !("data" in parsed)
    || typeof parsed.data !== "object"
    || parsed.data === null
    || Array.isArray(parsed.data)
  ) throw new Error("WhatsApp linked-device synchronization returned an unsupported response");
  const data = parsed.data as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(",") !== "messages_stored,synced"
    || data.synced !== true
    || !Number.isSafeInteger(data.messages_stored)
    || (data.messages_stored as number) < 0
  ) throw new Error("WhatsApp linked-device synchronization returned an unsupported response");
  const finalSubject = await probeWhatsAppWebSubject(linked, {
    ...(options.dependencies === undefined
      ? {}
      : { dependencies: options.dependencies }),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    timeoutMs: 10_000,
  });
  if (finalSubject !== linked.subject) {
    throw new Error("WhatsApp linked-device account changed during sync");
  }
  return Object.freeze({ messagesStored: data.messages_stored as number });
}
