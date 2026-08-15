import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  futimesSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireCookieRecords, browserCookieCommands } from "@hraness/kb/clip/acquire";
import { isPrivateAddress, isPrivateHostname } from "@hraness/kb/clip/network";
import type { WrenchAuth } from "./auth";
import {
  agentBrowserFailure,
  browserResultData,
  isSafeNamedProfile,
  parseLastJson,
  profilePath,
  runCommand,
} from "./browser";
import {
  analyzeHarValue,
  analyzeHarFile,
  assertBrowserDerivationTargetAllowed,
  assertScaffoldOutput,
  MAX_HAR_BYTES,
  writeDerivationScaffold,
  type HarAnalysis,
} from "./har";
import { analyzeInternalHarFile, analyzeInternalHarValue, type InternalHarEvidence } from "./har-internal";
import {
  reviewDerivationHarText,
  type DerivationReviewResult,
  type DerivationReviewSelection,
} from "./derive-review";
import { sha256 } from "./canonical-json";
import type { PlatformSurfaceId } from "./platform-catalog";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import {
  createPrivateJsonIfAbsent,
  createPrivateStateDirectory,
  ensurePrivateDirectory,
  ensurePrivateStateDirectory,
  listPrivateStateDirectory,
  readPrivateStateFileIfPresent,
  readRegularFile,
  removePrivateDirectoryTree,
  removePrivateEmptyStateDirectory,
  removePrivateStateFile,
  removePrivateStateDirectoryTree,
  wrenchStateHome,
  writePrivateJson,
} from "./storage";

type DirectoryIdentity = { readonly device: string; readonly inode: string };

type SealedDerivationReview = {
  readonly schemaVersion: 1;
  readonly state: "sealed";
  readonly har: {
    readonly device: string;
    readonly inode: string;
    readonly byteLength: number;
    readonly sha256: string;
  };
};

const derivationReviewMarkerName = "review.json";
const derivationReadyMarkerName = "ready.json";
const derivationPhaseMarkerName = "phase.json";
const derivationInitializationMarkerName = "initializing.json";
const derivationLifecycleOwnerMarkerName = "owner.json";
export const DERIVATION_LIFECYCLE_ORPHAN_GRACE_MS = 15 * 60_000;

type PrivateFileEvidence = {
  readonly device: string;
  readonly inode: string;
  readonly byteLength: number;
  readonly sha256: string;
};

type ReadyDerivation = {
  readonly schemaVersion: 1;
  readonly state: "ready";
  readonly metadata: PrivateFileEvidence;
};

type DerivationInitialization = {
  readonly schemaVersion: 1;
  readonly kind: "io-derivation-initialization";
  readonly derivationId: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly socketDirectory: string;
  readonly socketIdentity: DirectoryIdentity;
};

type DerivationDirectoryPhase = {
  readonly schemaVersion: 1;
  readonly kind: "io-derivation-directory-phase";
  readonly derivationId: string;
  readonly directoryIdentity: DirectoryIdentity;
};

type DerivationLifecycleOwner = {
  readonly schemaVersion: 1;
  readonly kind: "io-derivation-lifecycle";
  readonly derivationId: string;
  readonly pid: number;
  readonly createdAtMs: number;
  readonly bootId: string;
  readonly processStartId: string;
  readonly nonce: string;
  readonly directoryIdentity: DirectoryIdentity;
};

export type DerivationLifecycleGate = {
  readonly path: string;
  readonly identity: DirectoryIdentity;
  release: () => void;
};

const derivationLifecycleHeartbeatMs = 30_000;

const deriveCommandHelperPath = join(dirname(fileURLToPath(import.meta.url)), "derive-command-helper.ts");
const profileCloneHelperPath = join(dirname(fileURLToPath(import.meta.url)), "profile-clone-helper.ts");
const trustedBunConfigPath = join(dirname(fileURLToPath(import.meta.url)), "state-helper.bunfig.toml");
const derivationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type HarContentMode = "none" | "text";

export type DerivationSession = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly adapterId: string;
  readonly targetUrl: string;
  readonly targetOrigin: string;
  readonly createdAt: string;
  readonly allowRemoteActions: boolean;
  readonly contentMode: HarContentMode;
  readonly browserDomains: readonly string[];
  readonly headed: boolean;
  readonly sessionName: string;
  readonly directory: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly socketDirectory: string;
  readonly socketIdentity: DirectoryIdentity;
  readonly configPath: string;
  readonly policyPath: string;
  readonly profilePath: string | null;
  readonly browserExecutable?: string;
};

function ownedByCurrentUser(uid: number | bigint): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return currentUid === undefined || uid === (typeof uid === "bigint" ? BigInt(currentUid) : currentUid);
}

function inspectDirectoryIdentity(path: string): DirectoryIdentity {
  const stats = lstatSync(path, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || !ownedByCurrentUser(stats.uid)
    || (stats.mode & 0o777n) !== 0o700n
  ) throw new Error("derivation session directory is unsafe");
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function parseDirectoryIdentity(value: unknown): DirectoryIdentity {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "device,inode"
    || !("device" in value)
    || typeof value.device !== "string"
    || !/^\d{1,40}$/u.test(value.device)
    || !("inode" in value)
    || typeof value.inode !== "string"
    || !/^\d{1,40}$/u.test(value.inode)
  ) throw new Error("derivation directory identity is malformed");
  return { device: value.device, inode: value.inode };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

type BoundProfileClone = {
  readonly profile: "profile" | "profile-user-data";
  readonly profileDirectory: "Default" | null;
};

const activeChromiumProfileMessage =
  "Chromium profile is active or retains a stale process lock; fully quit the browser and retry";

async function cloneProfileBound(source: string, directory: string, expected: DirectoryIdentity): Promise<BoundProfileClone> {
  const result = await runCommand(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      "--no-macros",
      "--no-addons",
      `--config=${trustedBunConfigPath}`,
      profileCloneHelperPath,
    ],
    {
      cwd: directory,
      environment: { NODE_ENV: "production" },
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
      stdin: JSON.stringify({
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        expectedDirectory: expected,
        source,
      }),
    },
  );
  if (result.exitCode !== 0) {
    const reason = result.stderr.includes(activeChromiumProfileMessage)
      ? `: ${activeChromiumProfileMessage}`
      : result.stderr.includes("ENOENT") ? " (ENOENT)" : "";
    throw new Error(`bound browser-profile clone failed${reason}`);
  }
  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error("bound browser-profile clone returned invalid JSON", { cause: error });
  }
  if (
    typeof response !== "object"
    || response === null
    || Array.isArray(response)
    || Object.keys(response).sort().join(",") !== "ok,profile,profileDirectory"
    || !("ok" in response)
    || response.ok !== true
    || !("profile" in response)
    || (response.profile !== "profile" && response.profile !== "profile-user-data")
    || !("profileDirectory" in response)
    || (response.profileDirectory !== null && response.profileDirectory !== "Default")
    || (response.profile === "profile" && response.profileDirectory !== null)
    || (response.profile === "profile-user-data" && response.profileDirectory !== "Default")
  ) throw new Error("bound browser-profile clone returned an invalid response");
  return {
    profile: response.profile,
    profileDirectory: response.profileDirectory,
  };
}

export function derivationPolicyActions(allowRemoteActions: boolean): readonly string[] {
  const actions = [
    "launch", "navigate", "snapshot", "scroll", "wait", "read", "get", "network", "state",
    "back", "forward", "reload", "scrollintoview", "url", "title", "text", "html", "value", "inputvalue", "attr",
    "getbyrole", "getbytext", "getbylabel", "getbyplaceholder", "getbyalttext", "getbytitle", "getbytestid",
    "waitfortext", "waitforurl", "har_start", "har_stop", "requests", "cookies_set", "close",
  ];
  if (allowRemoteActions) {
    actions.push("click", "dblclick", "fill", "type", "hover", "focus", "press", "check", "uncheck", "select", "interact");
  }
  return actions;
}

const allowedBrowserCommands = new Set([
  "open",
  "back",
  "forward",
  "reload",
  "snapshot",
  "get",
  "read",
  "network",
  "wait",
  "scroll",
  "scrollintoview",
  "find",
  "click",
  "dblclick",
  "focus",
  "fill",
  "type",
  "press",
  "hover",
  "check",
  "uncheck",
  "select",
]);

const mutatingBrowserTokens = new Set(["click", "dblclick", "fill", "type", "press", "hover", "focus", "check", "uncheck", "select"]);

function commandCanMutate(command: readonly string[]): boolean {
  const action = command[0] ?? "";
  if (mutatingBrowserTokens.has(action)) return true;
  return action === "find" && mutatingBrowserTokens.has(command[3] ?? "");
}

function derivationDirectory(id: string, environment: Readonly<Record<string, string | undefined>>): string {
  if (!derivationIdPattern.test(id)) throw new Error("derivation ID is invalid");
  return join(wrenchStateHome(environment), "derivations", id);
}

function metadataPath(id: string, environment: Readonly<Record<string, string | undefined>>): string {
  return join(derivationDirectory(id, environment), "session.json");
}

function derivationLifecycleLockPath(
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (!derivationIdPattern.test(id)) throw new Error("derivation ID is invalid");
  return join(wrenchStateHome(environment), "derivations", `.lifecycle-${id}`);
}

type ProcessIdentityInspection =
  | { readonly status: "alive"; readonly processStartId: string }
  | { readonly status: "missing" }
  | { readonly status: "unknown" };

let cachedBootId: string | null = null;
let cachedCurrentProcessStartId: string | null = null;

function identityDigest(kind: string, value: string): string {
  return sha256(`${kind}\u0000${value}`);
}

function commandText(command: string, arguments_: readonly string[]): string {
  const environment: NodeJS.ProcessEnv = process.platform === "win32"
    ? {
        NODE_ENV: "production",
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
      }
    : { LANG: "C", LC_ALL: "C", NODE_ENV: "production", TZ: "UTC" };
  return execFileSync(command, arguments_, {
    encoding: "utf8",
    env: environment,
    timeout: 2_000,
    windowsHide: true,
  }).trim();
}

function windowsPowerShellPath(): string {
  return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
}

function currentBootId(): string {
  if (cachedBootId !== null) return cachedBootId;
  let raw: string;
  if (process.platform === "linux") {
    raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[a-f0-9-]{36}$/iu.test(raw)) throw new Error("system boot identity is malformed");
  } else if (process.platform === "darwin") {
    const value = commandText("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
    const match = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/u.exec(value);
    if (match === null) throw new Error("system boot identity is malformed");
    raw = `${match[1]}:${match[2]}`;
  } else if (process.platform === "win32") {
    raw = commandText(windowsPowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks",
    ]);
    if (!/^\d{10,30}$/u.test(raw)) throw new Error("system boot identity is malformed");
  } else throw new Error(`system boot identity is unsupported on ${process.platform}`);
  cachedBootId = identityDigest("io-boot", raw);
  return cachedBootId;
}

function processIsDefinitelyMissing(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { readonly code?: unknown }).code === "ESRCH"
    );
  }
}

function inspectProcessStartId(pid: number, bootId: string): ProcessIdentityInspection {
  if (pid === process.pid && cachedCurrentProcessStartId !== null) {
    return { status: "alive", processStartId: cachedCurrentProcessStartId };
  }
  try {
    let raw: string;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
      const close = stat.lastIndexOf(")");
      if (close < 1) return { status: "unknown" };
      const fields = stat.slice(close + 1).trim().split(/\s+/u);
      const startTicks = fields[19];
      if (startTicks === undefined || !/^\d+$/u.test(startTicks)) return { status: "unknown" };
      raw = startTicks;
    } else if (process.platform === "win32") {
      raw = commandText(windowsPowerShellPath(), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p=[int]$args[0]; (Get-Process -Id $p -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
        String(pid),
      ]);
      if (!/^\d{10,30}$/u.test(raw)) return { status: "unknown" };
    } else if (process.platform === "darwin") {
      raw = commandText("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
      if (raw === "") return { status: "missing" };
    } else return { status: "unknown" };
    const processStartId = identityDigest("io-process-start", `${bootId}\u0000${raw}`);
    if (pid === process.pid) cachedCurrentProcessStartId = processStartId;
    return { status: "alive", processStartId };
  } catch (error) {
    if (
      processIsDefinitelyMissing(pid)
      || (
        process.platform === "linux"
        && typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { readonly code?: unknown }).code === "ENOENT"
      )
    ) return { status: "missing" };
    return { status: "unknown" };
  }
}

function currentLifecycleProcessIdentity(): {
  readonly bootId: string;
  readonly processStartId: string;
} {
  const bootId = currentBootId();
  const processIdentity = inspectProcessStartId(process.pid, bootId);
  if (processIdentity.status !== "alive") {
    throw new Error("current process start identity is unavailable");
  }
  return { bootId, processStartId: processIdentity.processStartId };
}

function lifecycleOwnerStatus(
  owner: DerivationLifecycleOwner,
): "exact-live-owner" | "different-or-dead" | "unknown" {
  const bootId = currentBootId();
  if (bootId !== owner.bootId) return "different-or-dead";
  const processIdentity = inspectProcessStartId(owner.pid, bootId);
  if (processIdentity.status === "unknown") return "unknown";
  if (processIdentity.status === "missing") return "different-or-dead";
  return processIdentity.processStartId === owner.processStartId
    ? "exact-live-owner"
    : "different-or-dead";
}

function parseDerivationLifecycleOwner(
  value: unknown,
  id: string,
  identity: DirectoryIdentity,
): DerivationLifecycleOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("derivation lifecycle owner is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",")
      !== "bootId,createdAtMs,derivationId,directoryIdentity,kind,nonce,pid,processStartId,schemaVersion"
    || record.schemaVersion !== 1
    || record.kind !== "io-derivation-lifecycle"
    || record.derivationId !== id
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || !Number.isSafeInteger(record.createdAtMs)
    || (record.createdAtMs as number) < 0
    || typeof record.bootId !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.bootId)
    || typeof record.processStartId !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.processStartId)
    || typeof record.nonce !== "string"
    || !/^[a-f0-9]{32}$/u.test(record.nonce)
  ) throw new Error("derivation lifecycle owner is malformed");
  const directoryIdentity = parseDirectoryIdentity(record.directoryIdentity);
  if (!sameDirectoryIdentity(directoryIdentity, identity)) {
    throw new Error("derivation lifecycle owner does not match its lock directory");
  }
  return {
    schemaVersion: 1,
    kind: "io-derivation-lifecycle",
    derivationId: id,
    pid: record.pid as number,
    createdAtMs: record.createdAtMs as number,
    bootId: record.bootId,
    processStartId: record.processStartId,
    nonce: record.nonce,
    directoryIdentity,
  };
}

function lifecycleLockIsPastRecoveryGrace(
  path: string,
  expected: DirectoryIdentity,
  nowMs: number,
): boolean {
  const stats = lstatSync(path, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || !ownedByCurrentUser(stats.uid)
    || (stats.mode & 0o777n) !== 0o700n
  ) throw new Error("derivation lifecycle lock is unsafe");
  const actual = { device: stats.dev.toString(), inode: stats.ino.toString() };
  if (!sameDirectoryIdentity(actual, expected)) {
    throw new Error("derivation lifecycle lock changed identity");
  }
  const age = nowMs - Number(stats.mtimeMs);
  if (!Number.isFinite(age) || age < 0) throw new Error("derivation lifecycle lock timestamp is invalid");
  return age >= DERIVATION_LIFECYCLE_ORPHAN_GRACE_MS;
}

/**
 * Claim one derivation from preflight through its final state transition.
 * The fixed, identity-bound directory is the atomic claim; the owner marker
 * and heartbeat allow conservative crash recovery without overlapping a
 * helper process that outlived its CLI parent.
 */
export function acquireDerivationLifecycleGate(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: {
    /** Deterministic crash-recovery test seams. Production callers leave these unset. */
    readonly nowMs?: number;
  } = {},
): DerivationLifecycleGate {
  if (!derivationIdPattern.test(id)) throw new Error("derivation ID is invalid");
  const nowMs = options.nowMs ?? Date.now();
  const ownerPid = process.pid;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(ownerPid) || ownerPid < 1) {
    throw new Error("derivation lifecycle owner is invalid");
  }
  const processIdentity = currentLifecycleProcessIdentity();
  const root = join(wrenchStateHome(environment), "derivations");
  const rootIdentity = ensurePrivateStateDirectory(root, environment);
  const path = derivationLifecycleLockPath(id, environment);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let identity: DirectoryIdentity | null = null;
    let descriptor: number | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    try {
      identity = createPrivateStateDirectory(path, environment, rootIdentity);
      const acquiredIdentity = identity;
      const owner: DerivationLifecycleOwner = {
        schemaVersion: 1,
        kind: "io-derivation-lifecycle",
        derivationId: id,
        pid: ownerPid,
        createdAtMs: nowMs,
        bootId: processIdentity.bootId,
        processStartId: processIdentity.processStartId,
        nonce: crypto.randomUUID().replaceAll("-", ""),
        directoryIdentity: acquiredIdentity,
      };
      const marker = createPrivateJsonIfAbsent(
        join(path, derivationLifecycleOwnerMarkerName),
        owner,
        {
          environment,
          expectedStateDirectories: [rootIdentity, acquiredIdentity],
        },
      );
      if (!marker.created) throw new Error("derivation lifecycle owner marker already exists");
      descriptor = openSync(
        path,
        constants.O_RDONLY
          | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
          | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
      );
      const descriptorStats = fstatSync(descriptor, { bigint: true });
      const descriptorIdentity = {
        device: descriptorStats.dev.toString(),
        inode: descriptorStats.ino.toString(),
      };
      if (
        !descriptorStats.isDirectory()
        || !ownedByCurrentUser(descriptorStats.uid)
        || (descriptorStats.mode & 0o777n) !== 0o700n
        || !sameDirectoryIdentity(descriptorIdentity, acquiredIdentity)
      ) throw new Error("derivation lifecycle lock changed identity during acquisition");
      heartbeat = setInterval(() => {
        if (descriptor === null || heartbeat === null) return;
        try {
          const timestamp = new Date();
          futimesSync(descriptor, timestamp, timestamp);
        } catch {
          // A live owner PID still prevents reclamation. Stopping the failed
          // heartbeat only delays crash recovery; it cannot permit overlap.
          clearInterval(heartbeat);
          heartbeat = null;
        }
      }, derivationLifecycleHeartbeatMs);
      heartbeat.unref();
      let released = false;
      return {
        path,
        identity: acquiredIdentity,
        release: (): void => {
          if (released) return;
          if (heartbeat !== null) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          if (descriptor !== null) {
            closeSync(descriptor);
            descriptor = null;
          }
          try {
            if (!removePrivateStateDirectoryTree(path, environment, acquiredIdentity, rootIdentity)) {
              throw new Error("derivation lifecycle gate ownership was lost");
            }
          } catch (error) {
            if (error instanceof Error && error.message === "derivation lifecycle gate ownership was lost") {
              throw error;
            }
            throw new Error("derivation lifecycle gate ownership was lost", { cause: error });
          }
          released = true;
        },
      };
    } catch (creationError) {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (descriptor !== null) {
        closeSync(descriptor);
        descriptor = null;
      }
      if (identity !== null) {
        try {
          removePrivateStateDirectoryTree(path, environment, identity, rootIdentity);
        } catch (cleanupError) {
          throw new AggregateError(
            [creationError, cleanupError],
            "derivation lifecycle gate setup failed and cleanup was incomplete",
          );
        }
        throw creationError;
      }
      const entry = listPrivateStateDirectory(root, environment, rootIdentity)
        .find((candidate) => candidate.name === `.lifecycle-${id}`);
      if (entry === undefined) {
        if (attempt < 3) continue;
        throw creationError;
      }
      if (entry.kind !== "directory" || entry.identity === undefined) {
        throw new Error("derivation lifecycle lock is unsafe", { cause: creationError });
      }
      const markerText = readPrivateStateFileIfPresent(
        join(path, derivationLifecycleOwnerMarkerName),
        4 * 1024,
        "derivation lifecycle owner",
        environment,
        [rootIdentity, entry.identity],
      );
      if (markerText === null) {
        if (!lifecycleLockIsPastRecoveryGrace(path, entry.identity, nowMs)) {
          throw new Error(`derivation ${id} lifecycle is busy; retry the command`);
        }
      } else {
        let markerValue: unknown;
        try {
          markerValue = JSON.parse(markerText) as unknown;
        } catch (error) {
          throw new Error("derivation lifecycle owner is malformed", { cause: error });
        }
        const owner = parseDerivationLifecycleOwner(markerValue, id, entry.identity);
        if (owner.createdAtMs > nowMs + 60_000) {
          throw new Error("derivation lifecycle owner timestamp is from the future");
        }
        const pastRecoveryGrace = lifecycleLockIsPastRecoveryGrace(path, entry.identity, nowMs);
        const ownerStatus = lifecycleOwnerStatus(owner);
        if (
          ownerStatus === "exact-live-owner"
          || ownerStatus === "unknown"
          || !pastRecoveryGrace
        ) {
          throw new Error(`derivation ${id} lifecycle is busy; retry the command`);
        }
      }
      if (!removePrivateStateDirectoryTree(path, environment, entry.identity, rootIdentity)) {
        continue;
      }
    }
  }
  throw new Error(`derivation ${id} lifecycle is busy; retry the command`);
}

async function withDerivationLifecycleGate<T>(
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
  operation: () => Promise<T>,
): Promise<T> {
  const gate = acquireDerivationLifecycleGate(id, environment);
  try {
    return await operation();
  } finally {
    gate.release();
  }
}

function parseSession(value: unknown): DerivationSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("derivation session is malformed");
  const record = value as Record<string, unknown>;
  const id = record.id;
  const adapterId = record.adapterId;
  const targetUrl = record.targetUrl;
  const targetOrigin = record.targetOrigin;
  const createdAt = record.createdAt;
  const sessionName = record.sessionName;
  const directory = record.directory;
  const directoryIdentity = parseDirectoryIdentity(record.directoryIdentity);
  const socketDirectory = record.socketDirectory;
  const socketIdentity = parseDirectoryIdentity(record.socketIdentity);
  const configPath = record.configPath;
  const policyPath = record.policyPath;
  const expectedKeys = [
    "schemaVersion", "id", "adapterId", "targetUrl", "targetOrigin", "createdAt", "allowRemoteActions", "contentMode",
    "browserDomains", "headed", "sessionName", "directory", "directoryIdentity", "socketDirectory", "socketIdentity", "configPath", "policyPath", "profilePath",
    ...(record.browserExecutable === undefined ? [] : ["browserExecutable"]),
  ].sort();
  const actualKeys = Object.keys(record).sort();
  if (
    record.schemaVersion !== 1
    || typeof id !== "string"
    || typeof adapterId !== "string"
    || typeof targetUrl !== "string"
    || typeof targetOrigin !== "string"
    || typeof createdAt !== "string"
    || typeof sessionName !== "string"
    || typeof directory !== "string"
    || typeof socketDirectory !== "string"
    || typeof configPath !== "string"
    || typeof policyPath !== "string"
    || !Array.isArray(record.browserDomains)
    || record.browserDomains.some((domain) => typeof domain !== "string")
    || actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("derivation session is malformed");
  }
  if (typeof record.allowRemoteActions !== "boolean" || typeof record.headed !== "boolean" || (record.contentMode !== "none" && record.contentMode !== "text")) {
    throw new Error("derivation session is malformed");
  }
  if (record.profilePath !== null && typeof record.profilePath !== "string") throw new Error("derivation session is malformed");
  if (
    record.browserExecutable !== undefined
    && (
      typeof record.browserExecutable !== "string"
      || !isAbsolute(record.browserExecutable)
      || record.browserExecutable.length < 1
      || record.browserExecutable.length > 4_096
      || record.browserExecutable.includes("\u0000")
    )
  ) throw new Error("derivation session browser executable is malformed");
  if (
    !derivationIdPattern.test(id)
    || !/^[a-z][a-z0-9-]{0,47}$/u.test(adapterId)
    || !Number.isFinite(Date.parse(createdAt))
    || !/^io-derive-[a-f0-9]{12}$/u.test(sessionName)
  ) throw new Error("derivation session metadata is malformed");
  const parsedTarget = validateTarget(targetUrl);
  if (parsedTarget.origin !== targetOrigin) throw new Error("derivation target origin is malformed");
  const browserDomains = validateBrowserDomains(record.browserDomains.map((domain) => String(domain)), parsedTarget.hostname.toLowerCase());
  return {
    schemaVersion: 1,
    id,
    adapterId,
    targetUrl,
    targetOrigin,
    createdAt,
    allowRemoteActions: record.allowRemoteActions,
    contentMode: record.contentMode,
    browserDomains,
    headed: record.headed,
    sessionName,
    directory,
    directoryIdentity,
    socketDirectory,
    socketIdentity,
    configPath,
    policyPath,
    profilePath: record.profilePath,
    ...(typeof record.browserExecutable === "string"
      ? { browserExecutable: record.browserExecutable }
      : {}),
  };
}

function expectedSocketDirectory(id: string): string {
  const root = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(root, `io-derive-ab-${id}`);
}

function parseDerivationDirectoryPhase(
  value: unknown,
  id: string,
  directoryIdentity: DirectoryIdentity,
): DerivationDirectoryPhase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("derivation directory phase marker is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",")
      !== "derivationId,directoryIdentity,kind,schemaVersion"
    || record.schemaVersion !== 1
    || record.kind !== "io-derivation-directory-phase"
    || record.derivationId !== id
  ) throw new Error("derivation directory phase marker is malformed");
  const recordedDirectoryIdentity = parseDirectoryIdentity(record.directoryIdentity);
  if (!sameDirectoryIdentity(recordedDirectoryIdentity, directoryIdentity)) {
    throw new Error("derivation directory phase marker does not match its directory");
  }
  return {
    schemaVersion: 1,
    kind: "io-derivation-directory-phase",
    derivationId: id,
    directoryIdentity: recordedDirectoryIdentity,
  };
}

function readDerivationDirectoryPhase(
  id: string,
  directory: string,
  directoryIdentity: DirectoryIdentity,
  environment: Readonly<Record<string, string | undefined>>,
): DerivationDirectoryPhase {
  const entry = listPrivateStateDirectory(directory, environment, directoryIdentity)
    .find((candidate) => candidate.name === derivationPhaseMarkerName);
  if (entry?.kind !== "file") throw new Error("derivation directory phase marker is unavailable or unsafe");
  let value: unknown;
  try {
    value = JSON.parse(readRegularFile(
      phaseMarkerPath(directory),
      64 * 1024,
      "derivation directory phase marker",
      directoryIdentity,
    )) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("derivation directory phase marker is malformed", { cause: error });
    }
    throw error;
  }
  return parseDerivationDirectoryPhase(value, id, directoryIdentity);
}

function parseDerivationInitialization(
  value: unknown,
  id: string,
  directoryIdentity: DirectoryIdentity,
): DerivationInitialization {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("derivation initialization marker is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",")
      !== "derivationId,directoryIdentity,kind,schemaVersion,socketDirectory,socketIdentity"
    || record.schemaVersion !== 1
    || record.kind !== "io-derivation-initialization"
    || record.derivationId !== id
    || record.socketDirectory !== expectedSocketDirectory(id)
  ) throw new Error("derivation initialization marker is malformed");
  const recordedDirectoryIdentity = parseDirectoryIdentity(record.directoryIdentity);
  const socketIdentity = parseDirectoryIdentity(record.socketIdentity);
  if (!sameDirectoryIdentity(recordedDirectoryIdentity, directoryIdentity)) {
    throw new Error("derivation initialization marker does not match its directory");
  }
  return {
    schemaVersion: 1,
    kind: "io-derivation-initialization",
    derivationId: id,
    directoryIdentity: recordedDirectoryIdentity,
    socketDirectory: record.socketDirectory,
    socketIdentity,
  };
}

function readDerivationInitialization(
  id: string,
  directory: string,
  directoryIdentity: DirectoryIdentity,
  environment: Readonly<Record<string, string | undefined>>,
): DerivationInitialization {
  const entry = listPrivateStateDirectory(directory, environment, directoryIdentity)
    .find((candidate) => candidate.name === derivationInitializationMarkerName);
  if (entry?.kind !== "file") throw new Error("derivation initialization marker is unavailable or unsafe");
  let value: unknown;
  try {
    value = JSON.parse(readRegularFile(
      initializationMarkerPath(directory),
      64 * 1024,
      "derivation initialization marker",
      directoryIdentity,
    )) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("derivation initialization marker is malformed", { cause: error });
    }
    throw error;
  }
  return parseDerivationInitialization(value, id, directoryIdentity);
}

function initializationFromSession(session: DerivationSession): DerivationInitialization {
  return {
    schemaVersion: 1,
    kind: "io-derivation-initialization",
    derivationId: session.id,
    directoryIdentity: session.directoryIdentity,
    socketDirectory: session.socketDirectory,
    socketIdentity: session.socketIdentity,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function inspectPrivateFile(
  path: string,
  maximumBytes: number,
  label: string,
): Omit<PrivateFileEvidence, "sha256"> {
  const stats = (() => {
    try {
      return lstatSync(path, { bigint: true });
    } catch (error) {
      throw new Error(`${label} is unavailable or unsafe`, { cause: error });
    }
  })();
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || !ownedByCurrentUser(stats.uid)
    || (stats.mode & 0o077n) !== 0n
    || stats.size < 1n
    || stats.size > BigInt(maximumBytes)
  ) throw new Error(`${label} is unavailable or unsafe`);
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    byteLength: Number(stats.size),
  };
}

function samePrivateFile(
  left: Pick<PrivateFileEvidence, "device" | "inode" | "byteLength">,
  right: Pick<PrivateFileEvidence, "device" | "inode" | "byteLength">,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.byteLength === right.byteLength;
}

function readStablePrivateFileEvidence(
  path: string,
  maximumBytes: number,
  label: string,
  parentIdentity: DirectoryIdentity,
): { readonly text: string; readonly evidence: PrivateFileEvidence } {
  const before = inspectPrivateFile(path, maximumBytes, label);
  const text = readRegularFile(path, maximumBytes, label, parentIdentity);
  const after = inspectPrivateFile(path, maximumBytes, label);
  if (!samePrivateFile(before, after) || Buffer.byteLength(text, "utf8") !== before.byteLength) {
    throw new Error(`${label} changed while it was being read`);
  }
  return { text, evidence: { ...before, sha256: sha256(text) } };
}

function readyMarkerPath(session: DerivationSession): string {
  return join(session.directory, derivationReadyMarkerName);
}

function initializationMarkerPath(directory: string): string {
  return join(directory, derivationInitializationMarkerName);
}

function phaseMarkerPath(directory: string): string {
  return join(directory, derivationPhaseMarkerName);
}

function parseReadyDerivation(value: unknown): ReadyDerivation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("derivation ready marker is malformed");
  }
  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  if (
    Object.keys(record).sort().join(",") !== "metadata,schemaVersion,state"
    || record.schemaVersion !== 1
    || record.state !== "ready"
    || typeof metadata !== "object"
    || metadata === null
    || Array.isArray(metadata)
  ) throw new Error("derivation ready marker is malformed");
  const evidence = metadata as Record<string, unknown>;
  if (
    Object.keys(evidence).sort().join(",") !== "byteLength,device,inode,sha256"
    || typeof evidence.device !== "string"
    || !/^\d{1,40}$/u.test(evidence.device)
    || typeof evidence.inode !== "string"
    || !/^\d{1,40}$/u.test(evidence.inode)
    || !Number.isSafeInteger(evidence.byteLength)
    || (evidence.byteLength as number) < 1
    || (evidence.byteLength as number) > 64 * 1024
    || typeof evidence.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(evidence.sha256)
  ) throw new Error("derivation ready marker is malformed");
  return {
    schemaVersion: 1,
    state: "ready",
    metadata: {
      device: evidence.device,
      inode: evidence.inode,
      byteLength: evidence.byteLength as number,
      sha256: evidence.sha256,
    },
  };
}

function readDerivationReady(
  session: DerivationSession,
  metadataEvidence: PrivateFileEvidence,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const entry = sessionEntry(session, derivationReadyMarkerName, environment);
  if (entry === undefined) return false;
  if (entry.kind !== "file") throw new Error("derivation ready marker is not a regular file");
  const text = readRegularFile(
    readyMarkerPath(session),
    64 * 1024,
    "derivation ready marker",
    session.directoryIdentity,
  );
  let marker: ReadyDerivation;
  try {
    marker = parseReadyDerivation(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("derivation ready marker is malformed", { cause: error });
    throw error;
  }
  if (
    !samePrivateFile(marker.metadata, metadataEvidence)
    || marker.metadata.sha256 !== metadataEvidence.sha256
  ) throw new Error("derivation ready marker does not match its final session metadata");
  const currentMetadata = inspectPrivateFile(metadataPath(session.id, environment), 64 * 1024, "derivation session metadata");
  if (!samePrivateFile(currentMetadata, metadataEvidence)) {
    throw new Error("derivation session metadata changed after readiness was checked");
  }
  return true;
}

function inspectSessionSocket(
  session: DerivationSession,
  policy: "required" | "allow-missing",
): boolean {
  let identity: DirectoryIdentity;
  try {
    identity = inspectDirectoryIdentity(session.socketDirectory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      if (policy === "allow-missing") return false;
      throw new Error("derivation socket directory is unavailable; only list or discard can recover this session", { cause: error });
    }
    throw error;
  }
  if (!sameDirectoryIdentity(identity, session.socketIdentity)) {
    throw new Error("derivation socket directory changed identity");
  }
  return true;
}

function loadSessionWithSocketPolicy(
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
  socketPolicy: "required" | "allow-missing",
  readyPolicy: "required" | "allow-missing" = "required",
): {
  readonly session: DerivationSession;
  readonly socketAvailable: boolean;
  readonly ready: boolean;
  readonly metadataEvidence: PrivateFileEvidence;
} {
  const directory = derivationDirectory(id, environment);
  const directoryIdentity = inspectDirectoryIdentity(directory);
  const metadata = readStablePrivateFileEvidence(
    metadataPath(id, environment),
    64 * 1024,
    "derivation session metadata",
    directoryIdentity,
  );
  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(metadata.text) as unknown;
  } catch (error) {
    throw new Error("derivation session metadata is malformed", { cause: error });
  }
  const session = parseSession(metadataValue);
  const expectedProfiles = new Set([join(directory, "profile"), join(directory, "profile-user-data")]);
  const namedProfile = session.profilePath !== null && isSafeNamedProfile(session.profilePath);
  if (
    session.id !== id
    || session.directory !== directory
    || session.socketDirectory !== expectedSocketDirectory(id)
    || session.configPath !== join(directory, "agent-browser.json")
    || session.policyPath !== join(directory, "action-policy.json")
    || (session.profilePath !== null && !expectedProfiles.has(session.profilePath) && !namedProfile)
  ) {
    throw new Error("derivation session paths do not match its ID");
  }
  if (!sameDirectoryIdentity(directoryIdentity, session.directoryIdentity)) {
    throw new Error("derivation session directory changed identity");
  }
  const ready = readDerivationReady(session, metadata.evidence, environment);
  if (!ready && readyPolicy === "required") {
    throw new Error("derivation is not ready; only list or discard can recover this interrupted session");
  }
  if (ready) {
    const phase = readDerivationDirectoryPhase(id, directory, directoryIdentity, environment);
    const initialization = readDerivationInitialization(id, directory, directoryIdentity, environment);
    if (
      !sameDirectoryIdentity(phase.directoryIdentity, session.directoryIdentity)
      || !sameDirectoryIdentity(initialization.directoryIdentity, session.directoryIdentity)
      || !sameDirectoryIdentity(initialization.socketIdentity, session.socketIdentity)
      || initialization.socketDirectory !== session.socketDirectory
    ) throw new Error("ready derivation does not match its initialization boundary");
  }
  const socketAvailable = inspectSessionSocket(session, socketPolicy);
  readRegularFile(session.configPath, 64 * 1024, "derivation browser config", session.directoryIdentity);
  readRegularFile(session.policyPath, 64 * 1024, "derivation action policy", session.directoryIdentity);
  return { session, socketAvailable, ready, metadataEvidence: metadata.evidence };
}

function loadSession(id: string, environment: Readonly<Record<string, string | undefined>>): DerivationSession {
  return loadSessionWithSocketPolicy(id, environment, "required", "required").session;
}

function publishDerivationReady(
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
): DerivationSession {
  const prepared = loadSessionWithSocketPolicy(id, environment, "required", "allow-missing");
  if (prepared.ready) throw new Error("derivation ready marker already exists");
  const marker: ReadyDerivation = {
    schemaVersion: 1,
    state: "ready",
    metadata: prepared.metadataEvidence,
  };
  const publication = createPrivateJsonIfAbsent(readyMarkerPath(prepared.session), marker, {
    environment,
    expectedStateParent: prepared.session.directoryIdentity,
  });
  if (!publication.created) throw new Error("derivation ready marker already exists");
  return loadSession(id, environment);
}

function reviewMarkerPath(session: DerivationSession): string {
  return join(session.directory, derivationReviewMarkerName);
}

function captureHarPath(session: DerivationSession): string {
  return join(session.directory, "capture.har");
}

function sessionEntry(
  session: DerivationSession,
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return listPrivateStateDirectory(session.directory, environment, session.directoryIdentity)
    .find((candidate) => candidate.name === name);
}

function parseSealedDerivationReview(value: unknown): SealedDerivationReview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("derivation review seal is malformed");
  }
  const record = value as Record<string, unknown>;
  const har = record.har;
  if (
    Object.keys(record).sort().join(",") !== "har,schemaVersion,state"
    || record.schemaVersion !== 1
    || record.state !== "sealed"
    || typeof har !== "object"
    || har === null
    || Array.isArray(har)
  ) throw new Error("derivation review seal is malformed");
  const harRecord = har as Record<string, unknown>;
  if (
    Object.keys(harRecord).sort().join(",") !== "byteLength,device,inode,sha256"
    || typeof harRecord.device !== "string"
    || !/^\d{1,40}$/u.test(harRecord.device)
    || typeof harRecord.inode !== "string"
    || !/^\d{1,40}$/u.test(harRecord.inode)
    || !Number.isSafeInteger(harRecord.byteLength)
    || (harRecord.byteLength as number) < 1
    || (harRecord.byteLength as number) > MAX_HAR_BYTES
    || typeof harRecord.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(harRecord.sha256)
  ) throw new Error("derivation review seal is malformed");
  return {
    schemaVersion: 1,
    state: "sealed",
    har: {
      device: harRecord.device,
      inode: harRecord.inode,
      byteLength: harRecord.byteLength as number,
      sha256: harRecord.sha256,
    },
  };
}

function readReviewSeal(
  session: DerivationSession,
  environment: Readonly<Record<string, string | undefined>>,
): SealedDerivationReview | null {
  const marker = sessionEntry(session, derivationReviewMarkerName, environment);
  if (marker === undefined) return null;
  if (marker.kind !== "file") throw new Error("derivation review seal is not a regular file");
  let value: unknown;
  try {
    value = JSON.parse(readRegularFile(
      reviewMarkerPath(session),
      64 * 1024,
      "derivation review seal",
      session.directoryIdentity,
    )) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("derivation review seal is malformed", { cause: error });
    throw error;
  }
  return parseSealedDerivationReview(value);
}

function inspectCapturedHar(path: string): {
  readonly device: string;
  readonly inode: string;
  readonly byteLength: number;
} {
  const stats = lstatSync(path, { bigint: true });
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || !ownedByCurrentUser(stats.uid)
    || stats.size < 1n
    || stats.size > BigInt(MAX_HAR_BYTES)
  ) throw new Error("derivation review HAR is unavailable or unsafe");
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    byteLength: Number(stats.size),
  };
}

function sameCapturedHar(
  left: { readonly device: string; readonly inode: string; readonly byteLength: number },
  right: { readonly device: string; readonly inode: string; readonly byteLength: number },
): boolean {
  return left.device === right.device && left.inode === right.inode && left.byteLength === right.byteLength;
}

function readSealedReviewHar(
  session: DerivationSession,
  seal: SealedDerivationReview,
): string {
  const path = captureHarPath(session);
  const before = inspectCapturedHar(path);
  if (!sameCapturedHar(before, seal.har)) throw new Error("sealed derivation review HAR changed identity or size");
  const text = readRegularFile(path, MAX_HAR_BYTES, "sealed derivation review HAR", session.directoryIdentity);
  const after = inspectCapturedHar(path);
  if (!sameCapturedHar(before, after) || Buffer.byteLength(text, "utf8") !== seal.har.byteLength || sha256(text) !== seal.har.sha256) {
    throw new Error("sealed derivation review HAR changed after it was sealed");
  }
  return text;
}

function hasCapturedHar(
  session: DerivationSession,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const entry = sessionEntry(session, "capture.har", environment);
  if (entry === undefined) return false;
  if (entry.kind !== "file") throw new Error("derivation capture HAR is not a regular file");
  return true;
}

export type DerivationSummary = {
  readonly id: string;
  readonly adapterId?: string;
  readonly targetOrigin?: string;
  readonly createdAt?: string;
  readonly allowRemoteActions?: boolean;
  readonly contentMode?: HarContentMode;
  readonly headed?: boolean;
  readonly browserDomains?: readonly string[];
  readonly rawHarPresent?: boolean;
  readonly reviewSealed?: boolean;
  readonly socketAvailable?: boolean;
  readonly ready?: boolean;
  readonly recoverable?: boolean;
  readonly invalid?: true;
};

export function listDerivations(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly DerivationSummary[] {
  const directory = join(wrenchStateHome(environment), "derivations");
  return listPrivateStateDirectory(directory, environment)
    .filter((entry) => entry.kind === "directory" && derivationIdPattern.test(entry.name))
    .map((entry): DerivationSummary => {
      try {
        const loaded = loadSessionWithSocketPolicy(entry.name, environment, "allow-missing", "allow-missing");
        const { session } = loaded;
        return {
          id: session.id,
          adapterId: session.adapterId,
          targetOrigin: session.targetOrigin,
          createdAt: session.createdAt,
          allowRemoteActions: session.allowRemoteActions,
          contentMode: session.contentMode,
          headed: session.headed,
          browserDomains: session.browserDomains,
          rawHarPresent: listPrivateStateDirectory(session.directory, environment, session.directoryIdentity)
            .some((candidate) => candidate.kind === "file" && candidate.name === "capture.har"),
          reviewSealed: readReviewSeal(session, environment) !== null,
          socketAvailable: loaded.socketAvailable,
          ready: loaded.ready,
          ...(!loaded.ready ? { recoverable: true } : {}),
        };
      } catch {
        try {
          if (entry.identity === undefined) throw new Error("derivation directory identity is unavailable");
          const sessionDirectory = join(directory, entry.name);
          const entries = listPrivateStateDirectory(
            sessionDirectory,
            environment,
            entry.identity,
          );
          const readyEntry = entries.find((candidate) => candidate.name === derivationReadyMarkerName);
          if (readyEntry !== undefined) throw new Error("ready derivation is malformed");
          const initializationEntry = entries
            .find((candidate) => candidate.name === derivationInitializationMarkerName);
          if (initializationEntry !== undefined) {
            const initialization = readDerivationInitialization(
              entry.name,
              sessionDirectory,
              entry.identity,
              environment,
            );
            return {
              id: entry.name,
              ready: false,
              recoverable: true,
              socketAvailable: inspectInitializationSocket(initialization),
            };
          }
          const phaseEntry = entries.find((candidate) => candidate.name === derivationPhaseMarkerName);
          if (phaseEntry === undefined) {
            if (entries.length !== 0 || inspectUnknownInitializationSocket(entry.name)) {
              throw new Error("markerless derivation state is not safely recoverable");
            }
            return {
              id: entry.name,
              ready: false,
              recoverable: true,
              socketAvailable: false,
            };
          }
          readDerivationDirectoryPhase(
            entry.name,
            sessionDirectory,
            entry.identity,
            environment,
          );
          return {
            id: entry.name,
            ready: false,
            recoverable: true,
            socketAvailable: inspectUnknownInitializationSocket(entry.name),
          };
        } catch {
          return { id: entry.name, invalid: true };
        }
      }
    });
}

export function derivationGlobalArguments(session: DerivationSession): readonly string[] {
  const genericProfile = join(session.directory, "profile");
  const chromiumProfile = join(session.directory, "profile-user-data");
  const profile = session.profilePath === genericProfile
    ? "./profile"
    : session.profilePath === chromiumProfile ? "./profile-user-data" : session.profilePath;
  return [
    "--session",
    session.sessionName,
    "--content-boundaries",
    "--max-output",
    String(5 * 1024 * 1024),
    ...(session.headed ? ["--headed"] : []),
    ...(session.browserExecutable === undefined
      ? []
      : ["--executable-path", session.browserExecutable]),
    ...(session.profilePath === null ? ["--allowed-domains", session.browserDomains.join(",")] : []),
    ...(profile === null ? [] : ["--profile", profile]),
    ...(session.profilePath === chromiumProfile ? ["--args", "--profile-directory=Default"] : []),
  ];
}

async function runBoundAgentBrowser(
  session: DerivationSession,
  arguments_: readonly string[],
  options: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly stdin?: string },
) {
  return runCommand(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      "--no-macros",
      "--no-addons",
      `--config=${trustedBunConfigPath}`,
      deriveCommandHelperPath,
    ],
    {
      cwd: session.directory,
      environment: { NODE_ENV: "production" },
      timeoutMs: options.timeoutMs + 5_000,
      maxOutputBytes: options.maxOutputBytes,
      stdin: JSON.stringify({
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        expectedDirectory: session.directoryIdentity,
        socketDirectory: session.socketDirectory,
        expectedSocketDirectory: session.socketIdentity,
        allowRemoteActions: session.allowRemoteActions,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        arguments: arguments_,
        browserStdin: options.stdin ?? null,
      }),
    },
  );
}

async function batch(session: DerivationSession, commands: readonly (readonly string[])[]): Promise<readonly Record<string, unknown>[]> {
  const result = await runBoundAgentBrowser(
    session,
    [...derivationGlobalArguments(session), "batch", "--bail", "--json"],
    { timeoutMs: 120_000, maxOutputBytes: 10 * 1024 * 1024, stdin: JSON.stringify(commands) },
  );
  if (result.exitCode !== 0) throw agentBrowserFailure(result, "agent-browser batch");
  const parsed = parseLastJson(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== commands.length) throw new Error("agent-browser returned a malformed batch result");
  return parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("agent-browser returned a malformed batch entry");
    const record = entry as Record<string, unknown>;
    if (record.success !== true) throw new Error(typeof record.error === "string" ? record.error : "agent-browser command failed");
    return record;
  });
}

async function closeSession(session: DerivationSession): Promise<boolean> {
  const result = await runBoundAgentBrowser(
    session,
    [...derivationGlobalArguments(session), "close", "--json"],
    { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 },
  ).catch(() => null);
  return result?.exitCode === 0;
}

function removeSessionTrees(
  session: DerivationSession,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  removePrivateDirectoryTree(session.socketDirectory, session.socketIdentity);
  removePrivateStateDirectoryTree(session.directory, environment, session.directoryIdentity);
}

function removeInterruptedSessionTrees(
  initialization: DerivationInitialization,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const socketPresent = inspectInitializationSocket(initialization);
  if (socketPresent) {
    removePrivateDirectoryTree(initialization.socketDirectory, initialization.socketIdentity);
  }
  removePrivateStateDirectoryTree(
    derivationDirectory(initialization.derivationId, environment),
    environment,
    initialization.directoryIdentity,
  );
}

function inspectInitializationSocket(initialization: DerivationInitialization): boolean {
  try {
    const actualSocketIdentity = inspectDirectoryIdentity(initialization.socketDirectory);
    if (!sameDirectoryIdentity(actualSocketIdentity, initialization.socketIdentity)) {
      throw new Error("derivation socket directory changed identity");
    }
    return true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    return false;
  }
}

function inspectUnknownInitializationSocket(id: string): boolean {
  const socketDirectory = expectedSocketDirectory(id);
  try {
    inspectDirectoryIdentity(socketDirectory);
    return true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    return false;
  }
}

function removeDirectoryPhaseState(
  phase: DerivationDirectoryPhase,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const directory = derivationDirectory(phase.derivationId, environment);
  const assertNoUnknownSocket = (): void => {
    const actualIdentity = inspectDirectoryIdentity(directory);
    if (!sameDirectoryIdentity(actualIdentity, phase.directoryIdentity)) {
      throw new Error("derivation directory phase changed identity");
    }
    if (inspectUnknownInitializationSocket(phase.derivationId)) {
      throw new Error(
        `derivation ${phase.derivationId} has an unbound browser socket; its private state was preserved`,
      );
    }
  };
  assertNoUnknownSocket();
  assertNoUnknownSocket();
  removePrivateStateDirectoryTree(
    directory,
    environment,
    phase.directoryIdentity,
  );
}

function removeEmptyMarkerlessDirectoryState(
  id: string,
  directoryIdentity: DirectoryIdentity,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const directory = derivationDirectory(id, environment);
  const parentIdentity = ensurePrivateStateDirectory(dirname(directory), environment);
  const assertStillRecoverable = (): void => {
    const actualIdentity = inspectDirectoryIdentity(directory);
    if (!sameDirectoryIdentity(actualIdentity, directoryIdentity)) {
      throw new Error("markerless derivation directory changed identity");
    }
    if (listPrivateStateDirectory(directory, environment, directoryIdentity).length !== 0) {
      throw new Error("markerless derivation directory is not empty; its state was preserved");
    }
    if (inspectUnknownInitializationSocket(id)) {
      throw new Error(`derivation ${id} has an unbound browser socket; its private state was preserved`);
    }
  };
  assertStillRecoverable();
  assertStillRecoverable();
  if (!removePrivateEmptyStateDirectory(
    directory,
    environment,
    directoryIdentity,
    parentIdentity,
  )) {
    throw new Error("markerless derivation directory was no longer empty; its state was preserved");
  }
}

async function currentDerivationUrl(session: DerivationSession): Promise<URL> {
  const [record] = await batch(session, [["get", "url"]]);
  const data = record === undefined ? undefined : browserResultData(record);
  if (typeof data !== "object" || data === null || Array.isArray(data) || typeof (data as Record<string, unknown>).url !== "string") {
    throw new Error("agent-browser returned no current URL for the derivation");
  }
  let url: URL;
  try {
    url = new URL((data as Record<string, unknown>).url as string);
  } catch {
    throw new Error("agent-browser returned an invalid current URL for the derivation");
  }
  return url;
}

async function assertDerivationOrigin(session: DerivationSession): Promise<void> {
  const url = await currentDerivationUrl(session);
  if (url.origin !== session.targetOrigin) throw new Error(`derivation left its target origin: ${url.origin}`);
}

async function waitForDerivationOrigin(
  session: DerivationSession,
  targetUrl: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nextNavigationAttempt = Date.now() + 1_000;
  for (;;) {
    const url = await currentDerivationUrl(session);
    if (url.origin === session.targetOrigin) return;
    if (url.href !== "about:blank") throw new Error(`derivation left its target origin: ${url.origin}`);
    if (Date.now() >= deadline) throw new Error("derivation navigation did not reach its target origin");
    if (Date.now() >= nextNavigationAttempt) {
      await batch(session, [["open", targetUrl]]);
      nextNavigationAttempt = Date.now() + 1_000;
    }
    await Bun.sleep(100);
  }
}

function validateTarget(value: string): URL {
  if (value.length > 64 * 1024) throw new Error("target URL is too long");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("derivation target must be HTTPS and contain no embedded credentials");
  }
  if (isPrivateHostname(url.hostname) || (isIP(url.hostname) !== 0 && isPrivateAddress(url.hostname))) {
    throw new Error("derivation target cannot use a private network host");
  }
  return url;
}

/** Initialize the contained browser on a harmless in-origin URL before seeding cookies. */
export function derivationBootstrapUrl(target: URL): string {
  const bootstrap = new URL("/robots.txt", target.origin);
  if (bootstrap.origin !== target.origin) throw new Error("derivation bootstrap escaped its target origin");
  return bootstrap.href;
}

function validateBrowserDomains(domains: readonly string[], hostname: string): readonly string[] {
  if (
    domains.length < 1
    || domains.length > 100
    || domains.some((domain) => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(domain) || domain.includes(".."))
  ) throw new Error("browser domains must contain 1-100 exact or wildcard hostnames");
  const normalized = [...new Set(domains.map((domain) => domain.toLowerCase()))];
  const covered = normalized.some((domain) => domain === hostname || (domain.startsWith("*.") && (hostname === domain.slice(2) || hostname.endsWith(`.${domain.slice(2)}`))));
  if (!covered) throw new Error("browser domains must cover the derivation target hostname");
  return normalized;
}

/**
 * LinkedIn's authenticated app creates execution contexts that the pinned
 * agent-browser domain-containment bootstrap cannot reliably retain. The
 * daemon can survive while its Chrome child exits, after which agent-browser
 * transparently relaunches about:blank and the in-memory HAR is gone.
 *
 * A path-backed profile locator is the explicit uncontained-egress boundary
 * for this case. It still uses a task-private clone and may seed filtered
 * cookies, but it must have been stored with --trust-profile-egress and an
 * exact browser executable. Named agent-browser profiles are deliberately
 * rejected because they would be opened directly instead of cloned.
 */
export function assertDerivationAuthCompatibility(target: URL, auth: WrenchAuth): void {
  const isArcExecutable = (path: string): boolean => {
    const hasArcExecutableName = (candidate: string): boolean =>
      ["arc", "arc.exe"].includes(basename(candidate).toLowerCase());
    if (hasArcExecutableName(path)) return true;
    try {
      return hasArcExecutableName(realpathSync(path));
    } catch {
      // Path validity is owned by auth/execution boundaries. Do not disclose
      // a local executable path through this provider-specific safety check.
      return false;
    }
  };
  if (
    auth.kind === "browser-profile"
    && auth.browserExecutable !== undefined
    && isArcExecutable(auth.browserExecutable)
  ) {
    throw new Error(
      "managed derivation cannot use Arc as --browser-executable because Arc may attach its source user-data root "
      + "to task-private launches; keep Arc fully closed as the --browser-profile or --cookie-source and use an exact "
      + "Chrome or Chromium executable for the isolated clone",
    );
  }
  const hostname = target.hostname.toLowerCase();
  const linkedin = hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  if (!linkedin) return;
  if (auth.kind !== "browser-profile" || auth.browserExecutable === undefined) {
    throw new Error(
      "LinkedIn managed derivation requires a path-backed browser-profile auth locator stored with --trust-profile-egress; "
      + "the pinned contained cookie-only browser can lose LinkedIn's authenticated execution context and its HAR. "
      + "Use a private disposable --browser-profile with --browser-executable and optional --cookie-source, then retry",
    );
  }
  if (profilePath(auth.profile) === null) {
    throw new Error(
      "LinkedIn managed derivation requires a path-backed browser-profile auth locator so wrench can clone it "
      + "into the task-private derivation directory; named browser profiles would be opened directly",
    );
  }
}

export async function startDerivation(
  adapterId: string,
  targetValue: string,
  auth: WrenchAuth,
  options: {
    readonly allowRemoteActions: boolean;
    readonly contentMode: HarContentMode;
    readonly browserDomains: readonly string[];
    readonly headed: boolean;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
): Promise<DerivationSession> {
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(adapterId)) throw new Error("adapter ID must be lowercase kebab-case");
  const environment = options.environment ?? process.env;
  const target = validateTarget(targetValue);
  assertBrowserDerivationTargetAllowed(target);
  assertDerivationAuthCompatibility(target, auth);
  const browserDomains = validateBrowserDomains(options.browserDomains, target.hostname.toLowerCase());
  const id = crypto.randomUUID();
  const gate = acquireDerivationLifecycleGate(id, environment);
  try {
    const directory = derivationDirectory(id, environment);
    const derivationsRoot = dirname(directory);
    const derivationsRootIdentity = ensurePrivateStateDirectory(derivationsRoot, environment);
    const directoryIdentity = createPrivateStateDirectory(
      directory,
      environment,
      derivationsRootIdentity,
    );
    const socketDirectory = expectedSocketDirectory(id);
    const configPath = join(directory, "agent-browser.json");
    const policyPath = join(directory, "action-policy.json");
    let socketCreated = false;
    let socketIdentity: DirectoryIdentity | null = null;
    let session: DerivationSession | null = null;
    try {
      const phase: DerivationDirectoryPhase = {
        schemaVersion: 1,
        kind: "io-derivation-directory-phase",
        derivationId: id,
        directoryIdentity,
      };
      const phasePublication = createPrivateJsonIfAbsent(
        phaseMarkerPath(directory),
        phase,
        { environment, expectedStateParent: directoryIdentity },
      );
      if (!phasePublication.created) {
        throw new Error("derivation directory phase marker already exists");
      }
      ensurePrivateDirectory(socketDirectory);
      socketCreated = true;
      socketIdentity = inspectDirectoryIdentity(socketDirectory);
      const initialization: DerivationInitialization = {
        schemaVersion: 1,
        kind: "io-derivation-initialization",
        derivationId: id,
        directoryIdentity,
        socketDirectory,
        socketIdentity,
      };
      const initializationPublication = createPrivateJsonIfAbsent(
        initializationMarkerPath(directory),
        initialization,
        { environment, expectedStateParent: directoryIdentity },
      );
      if (!initializationPublication.created) {
        throw new Error("derivation initialization marker already exists");
      }
      writePrivateJson(configPath, {});
      // Pinned agent-browser 0.32.3 checks both documented categories and
      // concrete commands such as getbyrole, inputvalue, and har_start.
      const allowedActions = derivationPolicyActions(options.allowRemoteActions);
      writePrivateJson(policyPath, { default: "deny", allow: allowedActions });
      let clonedProfile: string | null = null;
      if (auth.kind === "browser-profile") {
        const source = profilePath(auth.profile);
        if (source === null) {
          clonedProfile = auth.profile;
        } else {
          const cloned = await cloneProfileBound(source, directory, directoryIdentity);
          clonedProfile = join(directory, cloned.profile);
        }
      }
      session = {
        schemaVersion: 1,
        id,
        adapterId,
        targetUrl: target.href,
        targetOrigin: target.origin,
        createdAt: new Date().toISOString(),
        allowRemoteActions: options.allowRemoteActions,
        contentMode: options.contentMode,
        browserDomains,
        headed: options.headed,
        sessionName: `io-derive-${id.replaceAll("-", "").slice(0, 12)}`,
        directory,
        directoryIdentity,
        socketDirectory,
        socketIdentity,
        configPath,
        policyPath,
        profilePath: clonedProfile,
        ...(auth.kind === "browser-profile" && auth.browserExecutable !== undefined
          ? { browserExecutable: auth.browserExecutable }
          : {}),
      };
      if (!sameDirectoryIdentity(inspectDirectoryIdentity(directory), directoryIdentity)) {
        throw new Error("derivation session directory changed identity during initialization");
      }
      const metadataPublication = createPrivateJsonIfAbsent(metadataPath(id, environment), session, {
        environment,
        expectedStateParent: directoryIdentity,
      });
      if (!metadataPublication.created) throw new Error("derivation session metadata already exists");
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (socketCreated && socketIdentity !== null) {
        try {
          removePrivateDirectoryTree(socketDirectory, socketIdentity);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        removePrivateStateDirectoryTree(directory, environment, directoryIdentity);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "derivation initialization failed and private cleanup was incomplete");
      }
      throw error;
    }
    if (session === null) throw new Error("derivation session was not initialized");
    try {
      // Current agent-browser domain containment rejects about:blank because it has
      // no hostname. A harmless, unrecorded in-origin bootstrap initializes the
      // browser without allowing an unauthenticated target-page request into HAR.
      await batch(session, [["open", derivationBootstrapUrl(target)]]);
      if (
        auth.kind === "cookie-source"
        || auth.kind === "cookies-file"
        || (auth.kind === "browser-profile" && auth.cookieSource !== undefined)
      ) {
        const cookies = await acquireCookieRecords({
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
          timeoutMs: 60_000,
        }, target);
        await batch(session, browserCookieCommands(cookies.cookies, target));
      }
      await batch(session, [["network", "har", "start", "--content", options.contentMode]]);
      await batch(session, [["open", target.href]]);
      await waitForDerivationOrigin(session, target.href);
      await assertDerivationOrigin(session);
      return publishDerivationReady(id, environment);
    } catch (error) {
      if (await closeSession(session)) {
        removeSessionTrees(session, environment);
        throw error;
      }
      throw new Error(`derivation ${id} failed to start and could not be closed; its private session was preserved for 'wrench derive discard ${id} --yes'`, { cause: error });
    }
  } finally {
    gate.release();
  }
}

function isReference(value: string | undefined): boolean {
  return value !== undefined && /^@e\d+$/u.test(value);
}

function safePlainArgument(value: string | undefined, maximum = 64 * 1024): value is string {
  return value !== undefined && value.length > 0 && value.length <= maximum && !value.startsWith("--") && !value.includes("\u0000");
}

function safeFillValue(value: string | undefined): value is string {
  return value !== undefined && value.length <= 64 * 1024 && !value.includes("\u0000");
}

function validateFindCommand(command: readonly string[]): void {
  const locator = command[1];
  const locatorValue = command[2];
  if (!["role", "text", "label", "placeholder", "alt", "title", "testid"].includes(locator ?? "")) {
    throw new Error("derive browser permits semantic find locators only");
  }
  if (!safePlainArgument(locatorValue, 2_000)) throw new Error("derive browser locator is invalid");
  const action = command[3];
  // The pinned 0.32.3 help advertises semantic `find ... focus`, but the
  // implementation rejects it as an unknown subaction. Use `focus @ref`.
  if (!["click", "fill", "type", "hover"].includes(action ?? "")) throw new Error("derive browser find action is invalid");
  let cursor = 4;
  if (action === "fill" || action === "type") {
    if (action === "fill" ? !safeFillValue(command[cursor]) : !safePlainArgument(command[cursor])) {
      throw new Error(`derive browser ${action} requires a bounded value`);
    }
    cursor += 1;
  }
  let sawName = false;
  let sawExact = false;
  while (cursor < command.length) {
    const option = command[cursor];
    if (option === "--name" && locator === "role" && !sawName) {
      if (!safePlainArgument(command[cursor + 1], 2_000)) throw new Error("derive browser role name is invalid");
      sawName = true;
      cursor += 2;
    } else if (option === "--exact" && !sawExact) {
      sawExact = true;
      cursor += 1;
    } else throw new Error(`derive browser find option is not allowed: ${option ?? "missing"}`);
  }
}

export function validateDerivationBrowserCommand(
  policy: { readonly allowRemoteActions: boolean; readonly targetOrigin: string },
  command: readonly string[],
): void {
  if (command.length < 1 || command.length > 100 || command.some((part) => part.length > 64 * 1024 || part.includes("\u0000"))) {
    throw new Error("derive browser command is empty or exceeds its argument bounds");
  }
  const action = command[0] ?? "";
  if (!allowedBrowserCommands.has(action)) throw new Error(`derive browser does not allow ${action}`);
  if (command.some((token) => ["--fn", "--download", "--headers", "--require-md", "--llms", "cdp-url"].includes(token))) {
    throw new Error("derive browser command requests a disallowed escape or file/network feature");
  }
  if (action === "open") {
    if (command.length !== 2) throw new Error("derive browser open accepts exactly one URL");
    const target = validateTarget(command[1] ?? "");
    if (target.origin !== policy.targetOrigin) throw new Error("derive browser navigation must stay on the target origin");
  }
  else if (action === "back" || action === "forward" || action === "reload" || action === "read") {
    if (command.length !== 1) throw new Error(`derive browser ${action} accepts no arguments`);
  }
  else if (action === "snapshot") {
    const options = command.slice(1);
    if (
      options.length > 3
      || new Set(options).size !== options.length
      || options.some((option) => option !== "-i" && option !== "-c" && option !== "-u")
    ) {
      throw new Error("derive browser snapshot accepts only unique -i, -c, and -u options");
    }
  }
  else if (action === "get") {
    const kind = command[1];
    if ((kind === "url" || kind === "title") && command.length === 2) {
      // Fixed no-target metadata reads.
    } else if (["text", "html", "value"].includes(kind ?? "") && command.length === 3 && isReference(command[2])) {
      // Snapshot-bound element reads.
    } else if (kind === "attr" && command.length === 4 && isReference(command[2]) && /^[A-Za-z_:][-A-Za-z0-9_:.]{0,127}$/u.test(command[3] ?? "")) {
      // Snapshot-bound attribute reads.
    } else throw new Error("derive browser get is limited to URL/title or snapshot references");
  }
  else if (action === "network") {
    if (command[1] !== "requests") throw new Error("derive browser network permits request listing only");
    if (command.length === 2) {
      // The browser returns request metadata only; raw headers and bodies stay in managed HAR state.
    } else if (command.length !== 4 || command[2] !== "--filter" || !safePlainArgument(command[3], 2_000)) {
      throw new Error("derive browser network requests accepts only one bounded --filter value");
    }
  }
  else if (action === "wait") {
    const milliseconds = command.length === 2 && /^\d{1,5}$/u.test(command[1] ?? "") ? Number(command[1]) : null;
    const semanticWait = command.length === 3 && (command[1] === "--text" || command[1] === "--url") && safePlainArgument(command[2], 2_000);
    if ((milliseconds === null || milliseconds < 1 || milliseconds > 30_000) && !semanticWait) {
      throw new Error("derive browser wait accepts 1-30000ms, --text, or --url only");
    }
  }
  else if (action === "scroll") {
    if (command.length < 2 || command.length > 3 || !["up", "down"].includes(command[1] ?? "")) {
      throw new Error("derive browser scroll requires up or down and an optional bounded distance");
    }
    if (command[2] !== undefined && (!/^\d{1,5}$/u.test(command[2]) || Number(command[2]) > 10_000)) {
      throw new Error("derive browser scroll distance is invalid");
    }
  }
  else if (action === "scrollintoview" || action === "focus" || action === "hover" || action === "click" || action === "dblclick" || action === "check" || action === "uncheck") {
    if (command.length !== 2 || !isReference(command[1])) throw new Error(`derive browser ${action} requires one snapshot reference`);
  }
  else if (action === "fill" || action === "type") {
    const validValue = action === "fill" ? safeFillValue(command[2]) : safePlainArgument(command[2]);
    if (command.length !== 3 || !isReference(command[1]) || !validValue) throw new Error(`derive browser ${action} requires a reference and bounded value`);
  }
  else if (action === "press") {
    if (command.length !== 2 || !/^[A-Za-z0-9+_-]{1,100}$/u.test(command[1] ?? "")) throw new Error("derive browser press key is invalid");
  }
  else if (action === "select") {
    if (command.length < 3 || command.length > 20 || !isReference(command[1]) || command.slice(2).some((value) => !safePlainArgument(value, 2_000))) {
      throw new Error("derive browser select requires a reference and bounded values");
    }
  }
  else if (action === "find") validateFindCommand(command);
  if (!policy.allowRemoteActions && commandCanMutate(command)) {
    throw new Error("derive session is read-only; restart it with --allow-remote-actions only after the remote action is authorized");
  }
}

function boundedNetworkLabel(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return value;
}

/** Strip credentials, header values, query values, timestamps, and browser internals. */
export function sanitizeDerivationNetworkResult(value: unknown): {
  readonly requests: readonly Readonly<Record<string, unknown>>[];
  readonly truncated: boolean;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("agent-browser returned malformed network request metadata");
  }
  const raw = (value as Record<string, unknown>).requests;
  if (!Array.isArray(raw)) throw new Error("agent-browser returned malformed network request metadata");
  const maximum = 1_000;
  const requests: Readonly<Record<string, unknown>>[] = [];
  for (const candidate of raw.slice(0, maximum)) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const method = boundedNetworkLabel(record.method, 16);
    const rawUrl = boundedNetworkLabel(record.url, 64 * 1024);
    if (method === null || rawUrl === null || !/^[A-Z]{3,10}$/u.test(method)) continue;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") continue;
    const status = Number.isSafeInteger(record.status) && (record.status as number) >= 0 && (record.status as number) <= 999
      ? record.status as number
      : null;
    const mimeType = boundedNetworkLabel(record.mimeType, 256);
    const resourceType = boundedNetworkLabel(record.resourceType, 128);
    requests.push({
      method,
      origin: url.origin,
      path: url.pathname,
      queryNames: [...new Set(url.searchParams.keys())].sort(),
      ...(status === null ? {} : { status }),
      ...(mimeType === null ? {} : { mimeType }),
      ...(resourceType === null ? {} : { resourceType }),
    });
  }
  return { requests, truncated: raw.length > maximum };
}

export async function runDerivationBrowserCommand(
  id: string,
  command: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<unknown> {
  return withDerivationLifecycleGate(id, environment, async () => {
    const session = loadSession(id, environment);
    if (readReviewSeal(session, environment) !== null || hasCapturedHar(session, environment)) {
      throw new Error("derivation recorder is sealed for private review; only review, finish, or discard is allowed");
    }
    assertBrowserDerivationTargetAllowed(new URL(session.targetOrigin));
    validateDerivationBrowserCommand(session, command);
    try {
      if (commandCanMutate(command)) await assertDerivationOrigin(session);
      const [record] = await batch(session, [command]);
      await assertDerivationOrigin(session);
      const data = record === undefined ? null : browserResultData(record);
      return command[0] === "network" ? sanitizeDerivationNetworkResult(data) : data;
    } catch (error) {
      if (error instanceof Error && error.message.includes("left its target origin")) {
        if (!await closeSession(session)) {
          throw new Error(`derivation ${id} left its target origin and could not be closed; its private session was preserved`, { cause: error });
        }
        removeSessionTrees(session, environment);
      }
      throw error;
    }
  });
}

async function sealDerivationReview(
  session: DerivationSession,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly seal: SealedDerivationReview; readonly text: string }> {
  const existing = readReviewSeal(session, environment);
  if (existing !== null) return { seal: existing, text: readSealedReviewHar(session, existing) };

  assertBrowserDerivationTargetAllowed(new URL(session.targetOrigin));
  let stopFailure: unknown = null;
  if (!hasCapturedHar(session, environment)) {
    await assertDerivationOrigin(session);
    try {
      await batch(session, [["network", "har", "stop", "capture.har"]]);
    } catch (error) {
      stopFailure = error;
    }
  }
  if (!hasCapturedHar(session, environment)) {
    if (stopFailure instanceof Error) throw stopFailure;
    throw new Error("derivation recorder did not produce its managed HAR");
  }

  const path = captureHarPath(session);
  const before = inspectCapturedHar(path);
  const text = readRegularFile(path, MAX_HAR_BYTES, "derivation review HAR", session.directoryIdentity);
  const after = inspectCapturedHar(path);
  if (!sameCapturedHar(before, after) || Buffer.byteLength(text, "utf8") !== before.byteLength) {
    throw new Error("derivation review HAR changed while it was being sealed");
  }
  // Parse before persisting the seal. A crash after HAR stop but before this
  // write is recoverable: the next review validates and seals the retained HAR.
  reviewDerivationHarText(text, session.targetOrigin, { kind: "list", offset: 0, limit: 1 });
  const seal: SealedDerivationReview = {
    schemaVersion: 1,
    state: "sealed",
    har: { ...before, sha256: sha256(text) },
  };
  createPrivateJsonIfAbsent(reviewMarkerPath(session), seal, {
    environment,
    expectedStateParent: session.directoryIdentity,
  });
  const persisted = readReviewSeal(session, environment);
  if (persisted === null) throw new Error("derivation review seal was not persisted");
  if (
    persisted.schemaVersion !== seal.schemaVersion
    || persisted.state !== seal.state
    || !sameCapturedHar(persisted.har, seal.har)
    || persisted.har.sha256 !== seal.har.sha256
  ) {
    throw new Error("derivation review seal publication elected a different HAR");
  }
  return { seal: persisted, text: readSealedReviewHar(session, persisted) };
}

export async function reviewDerivation(
  id: string,
  selection: DerivationReviewSelection,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DerivationReviewResult> {
  return withDerivationLifecycleGate(id, environment, async () => {
    const session = loadSession(id, environment);
    const sealed = await sealDerivationReview(session, environment);
    return reviewDerivationHarText(sealed.text, session.targetOrigin, selection);
  });
}

export async function finishDerivation(
  id: string,
  outputDirectory: string,
  options: {
    readonly force: boolean;
    readonly registry: ProviderPluginRegistry;
    readonly surfaceId?: PlatformSurfaceId;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
): Promise<{
  readonly analysis: HarAnalysis;
  readonly internalEvidence: InternalHarEvidence;
  readonly manifestPath: string;
  readonly candidatesPath: string;
  readonly reservationPath: string;
  readonly evidencePath: string;
}> {
  const environment = options.environment ?? process.env;
  return withDerivationLifecycleGate(id, environment, async () => {
    const session = loadSession(id, environment);
    assertBrowserDerivationTargetAllowed(new URL(session.targetOrigin));
    assertScaffoldOutput(outputDirectory, options.force);
    const harPath = captureHarPath(session);
    let reviewSeal = readReviewSeal(session, environment);
    if (reviewSeal === null && hasCapturedHar(session, environment)) {
      reviewSeal = (await sealDerivationReview(session, environment)).seal;
    }
    const sealedReview = reviewSeal !== null;
    let completed: {
      readonly analysis: HarAnalysis;
      readonly internalEvidence: InternalHarEvidence;
      readonly manifestPath: string;
      readonly candidatesPath: string;
      readonly reservationPath: string;
      readonly evidencePath: string;
    } | null = null;
    let failure: unknown = null;
    try {
      let analysis: HarAnalysis;
      let internalEvidence: InternalHarEvidence;
      if (reviewSeal !== null) {
        const text = readSealedReviewHar(session, reviewSeal);
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch (error) {
          throw new Error("sealed derivation review HAR is not valid JSON", { cause: error });
        }
        analysis = analyzeHarValue(
          value,
          session.adapterId,
          session.targetOrigin,
          new Date(),
          session.browserDomains,
        );
        internalEvidence = analyzeInternalHarValue(
          value,
          session.adapterId,
          session.targetOrigin,
        );
      } else {
        await batch(session, [["network", "har", "stop", "capture.har"]]);
        analysis = analyzeHarFile(
          harPath,
          session.adapterId,
          session.targetOrigin,
          session.browserDomains,
          session.directoryIdentity,
        );
        internalEvidence = analyzeInternalHarFile(
          harPath,
          session.adapterId,
          session.targetOrigin,
          session.directoryIdentity,
        );
      }
      const written = writeDerivationScaffold(outputDirectory, analysis, {
        force: options.force,
        registry: options.registry,
        ...(options.surfaceId === undefined ? {} : { surfaceId: options.surfaceId }),
        extraFiles: { "internal-api-evidence.json": internalEvidence },
      });
      completed = {
        analysis,
        internalEvidence,
        ...written,
        evidencePath: join(outputDirectory, "internal-api-evidence.json"),
      };
    } catch (error) {
      failure = error;
    }
    if (completed !== null) {
      if (!await closeSession(session)) {
        throw new Error(`derivation ${id} finished its scaffold but the browser could not be closed; discard the preserved private session`);
      }
      removePrivateStateFile(harPath, environment, session.directoryIdentity);
      if (sealedReview) removePrivateStateFile(reviewMarkerPath(session), environment, session.directoryIdentity);
      removeSessionTrees(session, environment);
      return completed;
    }
    if (sealedReview) {
      if (failure === null) throw new Error("sealed derivation failed without an error");
      throw failure instanceof Error
        ? failure
        : new Error(typeof failure === "string" ? failure : "sealed derivation failed with a non-error rejection");
    }
    removePrivateStateFile(harPath, environment, session.directoryIdentity);
    try {
      await batch(session, [["network", "har", "start", "--content", session.contentMode]]);
    } catch (error) {
      if (!await closeSession(session)) {
        throw new Error(`derivation ${id} failed and could not be closed; its private session was preserved`, { cause: error });
      }
      removeSessionTrees(session, environment);
    }
    if (failure === null) throw new Error("derivation failed without an error");
    throw failure instanceof Error
      ? failure
      : new Error(typeof failure === "string" ? failure : "derivation failed with a non-error rejection");
  });
}

export async function discardDerivation(
  id: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  return withDerivationLifecycleGate(id, environment, async () => {
    const directory = derivationDirectory(id, environment);
    if (!existsSync(directory)) return false;
    const directoryIdentity = inspectDirectoryIdentity(directory);
    const boundaryEntries = listPrivateStateDirectory(directory, environment, directoryIdentity);
    const phaseMarkerPresent = boundaryEntries
      .some((entry) => entry.name === derivationPhaseMarkerName);
    const initializationMarkerPresent = boundaryEntries
      .some((entry) => entry.name === derivationInitializationMarkerName);
    let phase: DerivationDirectoryPhase | null = null;
    let phaseFailure: unknown = null;
    if (phaseMarkerPresent) {
      try {
        phase = readDerivationDirectoryPhase(id, directory, directoryIdentity, environment);
      } catch (error) {
        phaseFailure = error;
      }
    }
    let initialization: DerivationInitialization | null = null;
    let initializationFailure: unknown = null;
    if (initializationMarkerPresent) {
      try {
        initialization = readDerivationInitialization(id, directory, directoryIdentity, environment);
      } catch (error) {
        initializationFailure = error;
      }
    }
    let loaded: ReturnType<typeof loadSessionWithSocketPolicy>;
    try {
      loaded = loadSessionWithSocketPolicy(id, environment, "allow-missing", "allow-missing");
    } catch (error) {
      const readyEntry = listPrivateStateDirectory(directory, environment, directoryIdentity)
        .find((entry) => entry.name === derivationReadyMarkerName);
      if (readyEntry !== undefined) throw error;
      if (initializationMarkerPresent && initialization === null) {
        throw initializationFailure instanceof Error ? initializationFailure : error;
      }
      if (initialization !== null && inspectInitializationSocket(initialization)) {
        throw new Error(
          `derivation ${id} is interrupted but its browser socket is still present; its private session was preserved`,
          { cause: error },
        );
      }
      if (initialization !== null) {
        removeInterruptedSessionTrees(initialization, environment);
        return true;
      }
      if (phaseMarkerPresent && phase === null) {
        throw phaseFailure instanceof Error ? phaseFailure : error;
      }
      if (phase !== null) {
        removeDirectoryPhaseState(phase, environment);
        return true;
      }
      if (boundaryEntries.length === 0) {
        removeEmptyMarkerlessDirectoryState(id, directoryIdentity, environment);
        return true;
      }
      throw error;
    }
    if (phaseMarkerPresent && phase === null) {
      throw phaseFailure instanceof Error
        ? phaseFailure
        : new Error("derivation directory phase marker is unavailable or unsafe");
    }
    if (initializationMarkerPresent && initialization === null) {
      throw initializationFailure instanceof Error
        ? initializationFailure
        : new Error("derivation initialization marker is unavailable or unsafe");
    }
    if (initialization === null) {
      if (loaded.ready) {
        throw initializationFailure instanceof Error
          ? initializationFailure
          : new Error("derivation initialization marker is unavailable or unsafe");
      }
      if (phase !== null) {
        removeDirectoryPhaseState(phase, environment);
        return true;
      }
      initialization = initializationFromSession(loaded.session);
    }
    const { session } = loaded;
    if (
      (phase !== null && !sameDirectoryIdentity(session.directoryIdentity, phase.directoryIdentity))
      || !sameDirectoryIdentity(session.directoryIdentity, initialization.directoryIdentity)
      || !sameDirectoryIdentity(session.socketIdentity, initialization.socketIdentity)
      || session.socketDirectory !== initialization.socketDirectory
    ) throw new Error("derivation session does not match its initialization boundary");
    if (!loaded.ready) {
      if (
        loaded.socketAvailable
        && !await closeSession(session)
        && inspectInitializationSocket(initialization)
      ) {
        throw new Error(`derivation ${id} could not be closed; its interrupted private session was preserved`);
      }
      removeInterruptedSessionTrees(initialization, environment);
      return true;
    }
    if (loaded.socketAvailable) {
      if (!await closeSession(session)) {
        if (inspectSessionSocket(session, "allow-missing")) {
          throw new Error(`derivation ${id} could not be closed; its private session was preserved`);
        }
        // Recheck the exact ephemeral boundary immediately before terminal
        // cleanup. A replacement directory remains fatal; a live boundary that
        // reappeared preserves the state for an ordinary close.
        if (inspectSessionSocket(session, "allow-missing")) {
          throw new Error(`derivation ${id} socket directory reappeared; its private session was preserved`);
        }
        removePrivateStateDirectoryTree(session.directory, environment, session.directoryIdentity);
        return true;
      }
      removeSessionTrees(session, environment);
    } else {
      if (inspectSessionSocket(session, "allow-missing")) {
        throw new Error(`derivation ${id} socket directory reappeared; its private session was preserved`);
      }
      removePrivateStateDirectoryTree(session.directory, environment, session.directoryIdentity);
    }
    return true;
  });
}
