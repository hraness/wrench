import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  type Stats,
  type BigIntStats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BoundedByteBuffer } from "@hraness/kb/clip/bounded-byte-buffer";

import type { WrenchAuth } from "../auth";
import type { BrowserFileResolver } from "../browser";
import type {
  FileInputValue,
  OperationInput,
  WebSessionRecipe,
} from "../model";
import { OperationDeadline } from "../operation-deadline";
import type {
  ProviderPluginLinkedDeviceAttemptBoundaryV1,
} from "../provider-plugin";
import { wrenchStateHome } from "../storage";
import type {
  WebSessionDispatchEvent,
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
  WHATSAPP_PROTOCOL_PIN,
  WHATSAPP_WEB_OPERATIONS,
  WHATSAPP_WEB_OPERATION_NAMES,
  isWhatsAppWriteAction,
  parseWhatsAppAuthStatusEnvelope,
  parseWhatsAppJid,
  parseWhatsAppWriteEnvelope,
  planWhatsAppWriteCommand,
  projectWhatsAppChatsEnvelope,
  projectWhatsAppMessageEnvelope,
  projectWhatsAppMessagesEnvelope,
  verifyWhatsAppWriteReadback,
  whatsappMessageId,
  whatsappTargetJid,
  type WhatsAppWebOperationName,
  type WhatsAppWritePlan,
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
  /**
   * Called immediately after the child process exists. Mutation accounting
   * must treat everything after this point as potentially dispatched.
   */
  readonly onSpawn?: () => void;
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
};

export type WhatsAppContactProjectionHelperResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export class WhatsAppContactProjectionCleanupUnverifiedError extends Error {
  constructor() {
    super(
      "WhatsApp contact projection helper cleanup could not be verified",
    );
    this.name = "WhatsAppContactProjectionCleanupUnverifiedError";
  }
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

async function pinnedBinaryCandidate(pathValue: string): Promise<string | null> {
  let canonical: string;
  try {
    canonical = await realpath(pathValue);
  } catch {
    return null;
  }
  const stats = await lstat(canonical);
  if (
    !stats.isFile()
    || (stats.mode & 0o022) !== 0
    || (stats.mode & 0o111) === 0
    || (!ownedByCurrentUser(stats) && stats.uid !== 0)
  ) return null;
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  return await sha256File(canonical)
      === WHATSAPP_PROTOCOL_PIN.darwinArm64BinarySha256
    ? canonical
    : null;
}

export async function resolvePinnedWacliBinary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const candidates = [
    join(
      wrenchStateHome(environment),
      "tools",
      "wacli",
      WHATSAPP_PROTOCOL_PIN.version,
      "wacli",
    ),
    "/opt/homebrew/bin/wacli",
    "/usr/local/bin/wacli",
  ];
  for (const candidate of candidates) {
    const found = await pinnedBinaryCandidate(candidate);
    if (found !== null) return found;
  }
  throw new Error(
    `pinned WhatsApp protocol runtime wacli ${WHATSAPP_PROTOCOL_PIN.version} is not installed or failed integrity verification`,
  );
}

export type WhatsAppProtocolRuntimeStatus = {
  readonly ready: boolean;
  readonly implementation: typeof WHATSAPP_PROTOCOL_PIN.implementation;
  readonly version: typeof WHATSAPP_PROTOCOL_PIN.version;
  readonly integrity: "sha256-pinned";
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
    integrity: "sha256-pinned",
    setupCommand: `/bin/sh ${shellQuote(installer)}`,
  });
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<string> {
  const reader = stream.getReader();
  const output = new BoundedByteBuffer(maximum);
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
  invocation.onSpawn?.();
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
    readonly onSpawn?: () => void;
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
    ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
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
  const resolveBinary = () => resolvePinnedWacliBinary(environment);
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

function writeArguments(
  store: string,
  timeoutMs: number,
  command: readonly string[],
): readonly string[] {
  return Object.freeze([
    "--store",
    store,
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

function exactContactInput(input: OperationInput): {
  readonly cursor: string | null;
  readonly limit: number;
} {
  const unexpected = Object.keys(input).filter(
    (key) => key !== "cursor" && key !== "limit",
  );
  if (unexpected.length > 0) {
    throw new Error("WhatsApp contacts.list input contained unsupported fields");
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
    cursor,
    limit: inputInteger(input, "limit", DEFAULT_LIMIT, 100),
  });
}

type ContactProjectionParentIdentity = Readonly<{
  store: BigIntStats;
  session: BigIntStats;
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

async function resolveFixedContactProjectionFiles(): Promise<
  FixedContactProjectionFiles
> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    {
      helper: resolve(
        moduleDirectory,
        "whatsapp-contact-projection-helper.ts",
      ),
      config: resolve(moduleDirectory, "../state-helper.bunfig.toml"),
    },
    {
      helper: resolve(
        moduleDirectory,
        "../src/providers/whatsapp-contact-projection-helper.ts",
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
    });
  } catch {
    throw new Error("WhatsApp contact projection helper could not start");
  }

  let timedOut = false;
  let cancelled = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let terminationStarted = false;
  const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
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
      if (error instanceof WhatsAppContactProjectionCleanupUnverifiedError) {
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

function dispatchEvent(
  action: string,
  started: number,
  verified: number,
): WebSessionDispatchEvent {
  return {
    id: action,
    index: 1,
    progress: { planned: 1, started, verified },
  };
}

async function materializedAttachment(
  input: OperationInput,
  resolver: BrowserFileResolver | undefined,
): Promise<string | undefined> {
  if (input.attachment === undefined) return undefined;
  const attachment = input.attachment;
  if (!isFileInputValue(attachment)) {
    throw new Error("input.attachment must be a plan-bound file");
  }
  if (resolver === undefined) {
    throw new Error("WhatsApp attachment send requires the plan-bound file resolver");
  }
  const paths = await resolver([attachment]);
  if (paths.length !== 1 || typeof paths[0] !== "string" || !isAbsolute(paths[0])) {
    throw new Error("WhatsApp file resolver did not return one exact absolute path");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(paths[0], constants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 1 || stats.size > 1024 * 1024 * 1024) {
      throw new Error("WhatsApp attachment must be a regular file no larger than 1 GiB");
    }
  } finally {
    await handle.close();
  }
  return paths[0];
}

function isFileInputValue(value: unknown): value is FileInputValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).sort().join(",") === "kind,reference"
    && candidate.kind === "file"
    && typeof candidate.reference === "string"
    && candidate.reference.length >= 1
    && candidate.reference.length <= 512
  );
}

/**
 * Full response/readback accounting for the future mutation transport.
 *
 * This function is intentionally unreachable while every mutation contract is
 * capture-required. The audited wacli 0.13.0 CLI retries selected send errors
 * once and carries text in process argv, so promotion also requires a no-retry
 * private payload transport rather than merely flipping contract state.
 */
async function executeMutation(
  runtime: Awaited<ReturnType<typeof boundRuntime>>,
  action: WhatsAppWritePlan["action"],
  recipe: WebSessionRecipe,
  input: OperationInput,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly operationDeadline?: WebSessionOperationDeadline;
  },
): Promise<WebSessionExecution> {
  const attachment = action === "messaging.send"
    ? await materializedAttachment(input, options.fileResolver)
    : undefined;
  const plan = planWhatsAppWriteCommand(
    action,
    input,
    attachment,
  );
  let started = 0;
  let verified = 0;
  try {
    await options.beforeDispatch?.(dispatchEvent(recipe.action, 0, 0));
    const dispatchTimeoutMs = remainingTimeoutMs(
      recipe.timeoutMs,
      options.operationDeadline,
    );
    const response = await checkedRun(
      runtime.binary,
      writeArguments(runtime.store, dispatchTimeoutMs, plan.argv),
      {
        timeoutMs: dispatchTimeoutMs,
        maxOutputBytes: recipe.maxOutputBytes,
        readOnly: false,
        onSpawn: () => {
          started = 1;
        },
        ...(options.dependencies === undefined
          ? {}
          : { dependencies: options.dependencies }),
        ...(options.operationDeadline === undefined
          ? {}
          : { operationDeadline: options.operationDeadline }),
      },
    );
    if (started !== 1) {
      throw new Error("WhatsApp protocol runner omitted dispatch accounting");
    }
    const receipt = parseWhatsAppWriteEnvelope(plan, response);
    const readbackTimeoutMs = remainingTimeoutMs(
      recipe.timeoutMs,
      options.operationDeadline,
    );
    const readback = await checkedRun(
      runtime.binary,
      readOnlyArguments(runtime.store, readbackTimeoutMs, [
        "messages",
        "show",
        "--chat",
        receipt.readbackChatJid,
        "--id",
        receipt.messageId,
      ]),
      {
        timeoutMs: readbackTimeoutMs,
        maxOutputBytes: recipe.maxOutputBytes,
        readOnly: true,
        ...(options.dependencies === undefined
          ? {}
          : { dependencies: options.dependencies }),
        ...(options.operationDeadline === undefined
          ? {}
          : { operationDeadline: options.operationDeadline }),
      },
    );
    const output = verifyWhatsAppWriteReadback(plan, receipt, readback);
    verified = 1;
    await options.afterDispatchVerified?.(dispatchEvent(recipe.action, 1, 1));
    return {
      status: "succeeded",
      output,
      finalUrl: WHATSAPP_ORIGIN,
      dispatchStarted: true,
      dispatch: { planned: 1, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: WHATSAPP_ORIGIN,
      dispatchStarted: started > 0,
      dispatch: { planned: 1, started, verified },
      error: started > 0
        ? "WhatsApp may have changed the requested state but exact readback was not verified; reconcile before retrying"
        : "WhatsApp linked-device operation failed before dispatch",
    };
  }
}

export async function executeWhatsAppWebOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly fileResolver?: BrowserFileResolver;
    readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
    readonly dependencies?: WhatsAppWebRuntimeDependencies;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly operationDeadline?: WebSessionOperationDeadline;
    readonly registerCleanupBarrier?: WebSessionCleanupBarrierRegistrar;
  } = {},
): Promise<WebSessionExecution> {
  if (
    recipe.site !== "whatsapp"
    || recipe.contractVersion !== 1
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
  const writeAction = isWhatsAppWriteAction(recipe.action)
    ? recipe.action
    : undefined;
  if (!localProjection && writeAction === undefined) {
    throw new Error(
      `WhatsApp linked-device operation ${recipe.action} has no reviewed write plan`,
    );
  }
  options.operationDeadline?.throwIfUnavailable(
    WEB_SESSION_OPERATION_LABEL,
  );
  if (recipe.action === "contacts.list") {
    exactContactInput(input);
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
  if (writeAction === undefined) {
    throw new Error("WhatsApp write-plan classification changed during execution");
  }
  return executeMutation(runtime, writeAction, recipe, input, options);
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
