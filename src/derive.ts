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
import { createConnection, isIP } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireCookieRecords,
  browserCookieCommands,
  type CookieRecordReader,
} from "@hraness/kb/clip/acquire";
import { isPrivateAddress, isPrivateHostname } from "@hraness/kb/clip/network";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "./auth";
import {
  agentBrowserFailure,
  browserResultData,
  isSafeNamedProfile,
  ownedChromeLaunchArguments,
  ownedDerivationGuardBrowserArguments,
  parseLastJsonWithExactLaunchHashes,
  profilePath,
  runCommand,
} from "./browser";
import {
  adoptDerivationNetworkBoundary,
  closeDerivationNetworkBoundary,
  closeInterruptedDerivationNetworkBoundary,
  createDerivationNetworkBoundary,
  UnsafeDerivationNetworkBoundaryCleanupError,
  verifyDerivationNetworkBoundary,
} from "./derivation-network-boundary";
import {
  DERIVATION_GUARD_EXTENSION_DIRECTORY,
  derivationGuardControlSocketPath,
  parseDerivationNetworkGuard,
  type DerivationNetworkGuard,
} from "./derivation-network-guard";
import {
  browserDomainsCover,
  validateDerivationBrowserDomains,
} from "./derivation-network-proxy";
import {
  initializeDerivationDnrReadiness,
  verifyDerivationDnrReadiness,
} from "./derivation-dnr-readiness";
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
import {
  assertDerivationFixtureFile,
  parseDerivationFixtures,
  stageDerivationFixtures,
  type DerivationFixture,
} from "./derive-fixtures";
import { localBrowserCdpUrl, uploadThroughInterceptedFileChooser } from "./derivation-file-chooser";
import { sha256 } from "./canonical-json";
import type { PlatformSurfaceId } from "./platform-catalog";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import {
  captureProcessOwnerIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
} from "./process-identity";
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
const derivationContainedBrowserOwnerMarkerName = "browser-owner.json";
const derivationContainedBrowserPinMarkerName = "browser-pin.json";
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

type ContainedDerivationBrowserMarker = {
  readonly schemaVersion: 1;
  readonly kind: "io-derivation-contained-browser-owner" | "io-derivation-contained-browser-pin";
  readonly derivationId: string;
  readonly sessionName: string;
  readonly cdpUrl: string;
  readonly browserIdentity: DerivationGuardBrowserIdentity;
  readonly daemonOwner: ProcessOwnerIdentity;
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
export const derivationDnrPolicyFileName = "network-readiness-policy.json";
export const derivationDnrPolicyActions = Object.freeze([
  "launch",
  "cdp_url",
  "url",
] as const);
const derivationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const singleFileInputReference = "@single-file-input";
const singleFileInputSelector = "input[type=file]";
const singleImageInputReference = "@single-image-input";
const singleImageInputSelector = "input[type=file][accept*='image']";
const singleVideoInputReference = "@single-video-input";
const singleVideoInputSelector = "input[type=file][accept*='video']";
const uploadSettlingDelayMs = 5_000;

export type HarContentMode = "none" | "text";

export type DerivationSession = {
  readonly schemaVersion: 1 | 2;
  readonly id: string;
  readonly adapterId: string;
  readonly targetUrl: string;
  readonly targetOrigin: string;
  readonly createdAt: string;
  readonly allowRemoteActions: boolean;
  readonly contentMode: HarContentMode;
  readonly browserDomains: readonly string[];
  readonly fixtures: readonly DerivationFixture[];
  readonly headed: boolean;
  readonly sessionName: string;
  readonly directory: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly socketDirectory: string;
  readonly socketIdentity: DirectoryIdentity;
  readonly configPath: string;
  readonly policyPath: string;
  readonly profilePath: string | null;
  /** Schema v2 binds contained sessions to their exact DNR/proxy boundary. */
  readonly networkGuard?: DerivationNetworkGuard | null;
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

export function derivationPolicyActions(
  allowRemoteActions: boolean,
  allowFixtureUpload = false,
): readonly string[] {
  const actions = [
    "launch", "navigate", "snapshot", "scroll", "wait", "get", "network", "state",
    "back", "forward", "reload", "scrollintoview", "url", "title", "text", "textcontent", "html", "innerhtml", "value", "inputvalue", "attr", "getattribute",
    "getbyrole", "getbytext", "getbylabel", "getbyplaceholder", "getbyalttext", "getbytitle", "getbytestid",
    "waitfortext", "waitforurl", "har_start", "har_stop", "requests", "cookies_set", "close",
    // These remain code-owned. The public derivation grammar never exposes
    // CDP endpoint reads or agent-browser's pending-action protocol.
    "cdp_url", "confirm", "session_info",
  ];
  if (allowRemoteActions) {
    actions.push("click", "dblclick", "fill", "type", "hover", "focus", "press", "check", "uncheck", "select", "interact");
    if (allowFixtureUpload) {
      actions.push("upload", "count");
    }
  }
  return actions;
}

export const derivationConfirmedPolicyActions = Object.freeze([
  "click",
  "dblclick",
  "fill",
  "type",
  "hover",
  "focus",
  "press",
  "check",
  "uncheck",
  "select",
  "interact",
  "upload",
  "getbyrole",
  "getbytext",
  "getbylabel",
  "getbyplaceholder",
  "getbyalttext",
  "getbytitle",
  "getbytestid",
] as const);

export function derivationActionPolicy(
  allowRemoteActions: boolean,
  allowFixtureUpload = false,
): {
  readonly allow: readonly string[];
  readonly confirm: readonly string[];
  readonly default: "deny";
  readonly deny: readonly string[];
} {
  const allow = derivationPolicyActions(allowRemoteActions, allowFixtureUpload);
  const allowed = new Set(allow);
  return {
    allow,
    confirm: allowRemoteActions
      ? derivationConfirmedPolicyActions.filter((action) => allowed.has(action))
      : [],
    default: "deny",
    deny: ["plugin:wrench-contained-relaunch-tripwire:launch.mutate"],
  };
}

export const derivationRelaunchTripwirePluginName = "wrench-contained-relaunch-tripwire";

export function derivationBrowserConfig(
  relaunchTripwire: boolean,
): Readonly<Record<string, unknown>> {
  return relaunchTripwire
    ? {
        plugins: [{
          args: [],
          capabilities: ["launch.mutate"],
          command: "wrench-contained-browser-relaunch-is-forbidden",
          name: derivationRelaunchTripwirePluginName,
        }],
      }
    : {};
}

const allowedBrowserCommands = new Set([
  "open",
  "back",
  "forward",
  "reload",
  "snapshot",
  "get",
  "network",
  "wait",
  "scroll",
  "scrollintoview",
  "find",
  "click",
  "dblclick",
  "focus",
  "fill",
  "cleartext",
  "type",
  "press",
  "hover",
  "check",
  "uncheck",
  "select",
  "close",
  "upload",
  "upload-and-seal",
  "choose-upload",
]);

const mutatingBrowserTokens = new Set(["click", "dblclick", "fill", "cleartext", "type", "press", "hover", "focus", "check", "uncheck", "select", "upload", "upload-and-seal", "choose-upload"]);

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
  const fixtures = parseDerivationFixtures(record.fixtures);
  const networkGuard = record.schemaVersion === 2
    ? record.networkGuard === null
      ? null
      : parseDerivationNetworkGuard(record.networkGuard)
    : undefined;
  const expectedKeys = [
    "schemaVersion", "id", "adapterId", "targetUrl", "targetOrigin", "createdAt", "allowRemoteActions", "contentMode",
    "browserDomains", "headed", "sessionName", "directory", "directoryIdentity", "socketDirectory", "socketIdentity", "configPath", "policyPath", "profilePath",
    ...(record.fixtures === undefined ? [] : ["fixtures"]),
    ...(record.schemaVersion === 2 ? ["networkGuard"] : []),
    ...(record.browserExecutable === undefined ? [] : ["browserExecutable"]),
  ].sort();
  const actualKeys = Object.keys(record).sort();
  if (
    (record.schemaVersion !== 1 && record.schemaVersion !== 2)
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
    record.schemaVersion === 2
    && (
      (record.profilePath === null && networkGuard === null)
      || (record.profilePath !== null && networkGuard !== null)
    )
  ) throw new Error("derivation session network boundary is malformed");
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
  const browserDomains = validateDerivationBrowserDomains(record.browserDomains.map((domain) => String(domain)), parsedTarget.hostname.toLowerCase());
  return {
    schemaVersion: record.schemaVersion,
    id,
    adapterId,
    targetUrl,
    targetOrigin,
    createdAt,
    allowRemoteActions: record.allowRemoteActions,
    contentMode: record.contentMode,
    browserDomains,
    fixtures,
    headed: record.headed,
    sessionName,
    directory,
    directoryIdentity,
    socketDirectory,
    socketIdentity,
    configPath,
    policyPath,
    profilePath: record.profilePath,
    ...(record.schemaVersion === 2 ? { networkGuard: networkGuard ?? null } : {}),
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
  if (session.profilePath === null && session.schemaVersion === 2) {
    readRegularFile(
      join(session.directory, derivationDnrPolicyFileName),
      64 * 1024,
      "derivation DNR readiness policy",
      session.directoryIdentity,
    );
  }
  return { session, socketAvailable, ready, metadataEvidence: metadata.evidence };
}

function loadSession(id: string, environment: Readonly<Record<string, string | undefined>>): DerivationSession {
  const session = loadSessionWithSocketPolicy(id, environment, "required", "required").session;
  if (
    session.profilePath === null
    && (session.schemaVersion !== 2 || session.networkGuard === null || session.networkGuard === undefined)
  ) {
    throw new Error(
      "legacy contained derivation lacks the bound network guard; only list or discard may recover it",
    );
  }
  return session;
}

function containedNetworkGuard(session: DerivationSession): DerivationNetworkGuard | null {
  if (session.profilePath !== null) return null;
  if (
    session.schemaVersion !== 2
    || session.networkGuard === null
    || session.networkGuard === undefined
  ) throw new Error("contained derivation network guard is unavailable");
  return session.networkGuard;
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
        const hasBoundControlOwner = session.profilePath === null
          && session.schemaVersion === 2
          && session.networkGuard != null;
        if (!hasBoundControlOwner && !derivationControlEndpointIsAbsent(entry.name)) {
          return { id: entry.name, invalid: true };
        }
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
            assertNoUnboundDerivationControl(entry.name);
            return {
              id: entry.name,
              ready: false,
              recoverable: true,
              socketAvailable: inspectInitializationSocket(initialization),
            };
          }
          const phaseEntry = entries.find((candidate) => candidate.name === derivationPhaseMarkerName);
          if (phaseEntry === undefined) {
            if (
              entries.length !== 0
              || inspectUnknownInitializationSocket(entry.name)
              || !derivationControlEndpointIsAbsent(entry.name)
            ) {
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
          assertNoUnboundDerivationControl(entry.name);
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
  const ownsChrome = session.profilePath === null
    || session.profilePath === genericProfile
    || session.profilePath === chromiumProfile;
  const guard = session.profilePath === null
    && session.schemaVersion === 2
    && session.networkGuard != null
    ? session.networkGuard
    : null;
  const guardArguments = guard === null
    ? []
    : ownedDerivationGuardBrowserArguments(
        `http://127.0.0.1:${guard.proxy.port}`,
        join(session.directory, DERIVATION_GUARD_EXTENSION_DIRECTORY),
      );
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
    ...(session.profilePath === null && guard === null
      ? ["--allowed-domains", session.browserDomains.join(",")]
      : []),
    ...guardArguments,
    ...(profile === null ? [] : ["--profile", profile]),
    ...(ownsChrome && guard === null
      ? [
          "--args",
          ownedChromeLaunchArguments(
            session.profilePath === chromiumProfile
              ? ["--profile-directory=Default"]
              : [],
          ),
        ]
      : []),
  ];
}

export function derivationPinSessionName(session: Pick<DerivationSession, "id" | "sessionName">): string {
  const expectedOwner = `io-derive-${session.id.replaceAll("-", "").slice(0, 12)}`;
  if (session.sessionName !== expectedOwner) throw new Error("derivation browser owner session name is invalid");
  return `io-derive-pin-${session.id.replaceAll("-", "").slice(0, 12)}`;
}

export function derivationExistingOwnerContextArguments(
  session: Pick<DerivationSession, "sessionName">,
): readonly string[] {
  if (!/^io-derive-[a-f0-9]{12}$/u.test(session.sessionName)) {
    throw new Error("derivation browser owner session name is invalid");
  }
  return [
    "--session",
    session.sessionName,
    "--content-boundaries",
    "--max-output",
    String(5 * 1024 * 1024),
    "batch",
    "--bail",
    "--json",
  ];
}

type DerivationBrowserPin = {
  readonly sessionName: string;
  readonly cdpUrl: string;
  readonly browserIdentity: DerivationGuardBrowserIdentity | null;
  readonly confirmationAction: string | null;
  readonly daemonOwner: ProcessOwnerIdentity | null;
};

function containedBrowserMarkerPath(
  session: DerivationSession,
  kind: ContainedDerivationBrowserMarker["kind"],
): string {
  return join(
    session.directory,
    kind === "io-derivation-contained-browser-owner"
      ? derivationContainedBrowserOwnerMarkerName
      : derivationContainedBrowserPinMarkerName,
  );
}

function parseContainedBrowserProcessOwner(value: unknown): ProcessOwnerIdentity {
  const record = guardBrowserRecord(value, "contained derivation browser process owner");
  exactGuardBrowserKeys(
    record,
    ["bootId", "pid", "processStartId"],
    "contained derivation browser process owner",
  );
  if (
    !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || typeof record.bootId !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.bootId)
    || typeof record.processStartId !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.processStartId)
  ) throw new Error("contained derivation browser process owner is malformed");
  return {
    pid: record.pid as number,
    bootId: record.bootId,
    processStartId: record.processStartId,
  };
}

function parseContainedBrowserMarker(
  value: unknown,
  session: DerivationSession,
  kind: ContainedDerivationBrowserMarker["kind"],
): ContainedDerivationBrowserMarker {
  const record = guardBrowserRecord(value, "contained derivation browser marker");
  exactGuardBrowserKeys(record, [
    "browserIdentity",
    "cdpUrl",
    "daemonOwner",
    "derivationId",
    "kind",
    "schemaVersion",
    "sessionName",
  ], "contained derivation browser marker");
  const expectedSessionName = kind === "io-derivation-contained-browser-owner"
    ? session.sessionName
    : derivationPinSessionName(session);
  const browserIdentity = guardBrowserRecord(
    record.browserIdentity,
    "contained derivation browser identity",
  );
  exactGuardBrowserKeys(
    browserIdentity,
    ["engine", "launchHash"],
    "contained derivation browser identity",
  );
  const parsedIdentity = guardBrowserLifecycle({
    effectiveLaunch: {
      browserLaunched: true,
      engine: browserIdentity.engine,
      launchHash: browserIdentity.launchHash,
    },
    launched: false,
    relaunchedBrowser: false,
    restartedBackground: false,
    restoreStatus: "not_configured",
    reused: true,
    saveStatus: "not_attempted",
  });
  if (
    record.schemaVersion !== 1
    || record.kind !== kind
    || record.derivationId !== session.id
    || record.sessionName !== expectedSessionName
  ) throw new Error("contained derivation browser marker is malformed");
  return {
    schemaVersion: 1,
    kind,
    derivationId: session.id,
    sessionName: expectedSessionName,
    cdpUrl: localBrowserCdpUrl(record.cdpUrl),
    browserIdentity: parsedIdentity,
    daemonOwner: parseContainedBrowserProcessOwner(record.daemonOwner),
  };
}

function publishContainedBrowserMarker(
  session: DerivationSession,
  marker: ContainedDerivationBrowserMarker,
): void {
  const path = containedBrowserMarkerPath(session, marker.kind);
  const publication = createPrivateJsonIfAbsent(path, marker, {
    expectedStateParent: session.directoryIdentity,
  });
  if (publication.created) return;
  const existing = parseContainedBrowserMarker(
    JSON.parse(readRegularFile(
      path,
      64 * 1024,
      "contained derivation browser marker",
      session.directoryIdentity,
    )) as unknown,
    session,
    marker.kind,
  );
  if (
    existing.cdpUrl !== marker.cdpUrl
    || !sameGuardBrowserIdentity(existing.browserIdentity, marker.browserIdentity)
    || existing.daemonOwner.pid !== marker.daemonOwner.pid
    || existing.daemonOwner.bootId !== marker.daemonOwner.bootId
    || existing.daemonOwner.processStartId !== marker.daemonOwner.processStartId
  ) throw new Error("contained derivation browser marker changed identity");
}

async function runBoundAgentBrowser(
  session: DerivationSession,
  arguments_: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly stdin?: string;
    readonly codeOwnedBrowserRequest?:
      | { readonly kind: "initial-contained-launch" }
      | { readonly kind: "readiness-context" }
      | { readonly kind: "pin-context"; readonly pin: DerivationBrowserPin }
      | { readonly kind: "pinned-batch"; readonly pin: DerivationBrowserPin }
      | { readonly kind: "pinned-confirm"; readonly pin: DerivationBrowserPin };
  },
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
        ownerSessionName: session.sessionName,
        allowRemoteActions: session.allowRemoteActions,
        allowFixtureUpload: session.fixtures.length > 0,
        guardedBrowserConfig: session.profilePath === null
          && session.schemaVersion === 2
          && session.networkGuard != null
          && options.codeOwnedBrowserRequest?.kind !== "initial-contained-launch",
        codeOwnedBrowserRequest: options.codeOwnedBrowserRequest?.kind ?? "none",
        browserPin: options.codeOwnedBrowserRequest !== undefined && "pin" in options.codeOwnedBrowserRequest
          ? options.codeOwnedBrowserRequest.pin
          : null,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        arguments: arguments_,
        browserStdin: options.stdin ?? null,
      }),
    },
  );
}

async function rawBatch(
  session: DerivationSession,
  commands: readonly (readonly string[])[],
  initialContainedLaunch = false,
): Promise<readonly Record<string, unknown>[]> {
  if (
    initialContainedLaunch
    && JSON.stringify(commands) !== JSON.stringify([["open", "about:blank"]])
  ) throw new Error("initial contained derivation launch command changed shape");
  const result = await runBoundAgentBrowser(
    session,
    [...derivationGlobalArguments(session), "batch", "--bail", "--json"],
    {
      timeoutMs: 120_000,
      maxOutputBytes: 10 * 1024 * 1024,
      stdin: JSON.stringify(commands),
      ...(initialContainedLaunch
        ? { codeOwnedBrowserRequest: { kind: "initial-contained-launch" } as const }
        : {}),
    },
  );
  if (result.exitCode !== 0) throw agentBrowserFailure(result, "agent-browser batch");
  const parsed = parseLastJsonWithExactLaunchHashes(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== commands.length) throw new Error("agent-browser returned a malformed batch result");
  return parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("agent-browser returned a malformed batch entry");
    const record = entry as Record<string, unknown>;
    if (record.success !== true) throw new Error(typeof record.error === "string" ? record.error : "agent-browser command failed");
    return record;
  });
}

export class IndeterminateDerivationConfirmationError extends Error {
  constructor() {
    super(
      "pinned derivation browser confirmation is indeterminate: the mutation may have applied; do not retry it and reconcile the exact page state before any further mutation",
    );
    this.name = "IndeterminateDerivationConfirmationError";
  }
}

export async function runPinnedDerivationConfirmationOnce<T>(
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch {
    // From the instant the confirmation helper is invoked, an ordinary
    // failure cannot prove whether the pending mutation ran. Never retry the
    // helper here or expose its ambiguous failure as a safe pre-dispatch error.
    throw new IndeterminateDerivationConfirmationError();
  }
}

async function pinnedRawBatch(
  session: DerivationSession,
  commands: readonly (readonly string[])[],
  pin: DerivationBrowserPin & { readonly browserIdentity: DerivationGuardBrowserIdentity },
  expectedPageUrl: string,
): Promise<readonly Record<string, unknown>[]> {
  const completed: Record<string, unknown>[] = [];
  for (const command of commands) {
    const requestPin: DerivationBrowserPin = {
      ...pin,
      confirmationAction: null,
      daemonOwner: null,
    };
    const result = await runBoundAgentBrowser(
      session,
      ["batch", "--bail", "--json"],
      {
        timeoutMs: 120_000,
        maxOutputBytes: 10 * 1024 * 1024,
        stdin: JSON.stringify([command]),
        codeOwnedBrowserRequest: { kind: "pinned-batch", pin: requestPin },
      },
    );
    if (result.exitCode !== 0) throw agentBrowserFailure(result, "pinned agent-browser command");
    const parsed = parseLastJsonWithExactLaunchHashes(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw new Error("pinned agent-browser returned a malformed command result");
    }
    const record = guardBrowserRecord(parsed[0], "pinned derivation browser result");
    exactGuardBrowserKeys(record, ["command", "error", "result", "success"], "pinned derivation browser result");
    if (
      JSON.stringify(record.command) !== JSON.stringify(command)
      || record.success !== true
      || record.error !== null
    ) throw new Error("pinned derivation browser command did not succeed exactly");
    const data = guardBrowserRecord(record.result, "pinned derivation browser command result");
    const requiresConfirmation = commandCanMutate(command);
    if (!("lifecycle" in data)) {
      if (!requiresConfirmation) {
        throw new Error("read-only pinned derivation browser command requested confirmation");
      }
      exactGuardBrowserKeys(
        data,
        ["action", "confirmation_id", "confirmation_required"],
        "pinned derivation browser confirmation",
      );
      if (
        data.confirmation_required !== true
        || typeof data.confirmation_id !== "string"
        || !/^r\d{1,6}$/u.test(data.confirmation_id)
        || typeof data.action !== "string"
        || !(derivationConfirmedPolicyActions as readonly string[]).includes(data.action)
      ) throw new Error("pinned derivation browser confirmation changed shape");
      const confirmationId = data.confirmation_id;
      const confirmationAction = data.action;
      const daemonOwner = await bindDerivationBrowserDaemon(
        session,
        pin.sessionName,
        pin.browserIdentity,
      );
      publishContainedBrowserMarker(session, {
        schemaVersion: 1,
        kind: "io-derivation-contained-browser-pin",
        derivationId: session.id,
        sessionName: pin.sessionName,
        cdpUrl: pin.cdpUrl,
        browserIdentity: pin.browserIdentity,
        daemonOwner,
      });
      await runDerivationDnrReadiness(session, {
        cdpUrl: pin.cdpUrl,
        currentUrl: expectedPageUrl,
        browserIdentity: pin.browserIdentity,
      }, false);
      const reboundOwner = await bindDerivationBrowserDaemon(
        session,
        pin.sessionName,
        pin.browserIdentity,
      );
      if (
        reboundOwner.pid !== daemonOwner.pid
        || reboundOwner.bootId !== daemonOwner.bootId
        || reboundOwner.processStartId !== daemonOwner.processStartId
      ) throw new Error("pinned derivation daemon changed before confirmation");
      const confirmationPin: DerivationBrowserPin & {
        readonly browserIdentity: DerivationGuardBrowserIdentity;
        readonly daemonOwner: ProcessOwnerIdentity;
      } = {
        ...pin,
        confirmationAction,
        daemonOwner,
      };
      const confirmedData = await runPinnedDerivationConfirmationOnce(async () => {
        const confirmationResult = await runBoundAgentBrowser(
          session,
          ["confirm", confirmationId, "--json"],
          {
            timeoutMs: 120_000,
            maxOutputBytes: 10 * 1024 * 1024,
            codeOwnedBrowserRequest: { kind: "pinned-confirm", pin: confirmationPin },
          },
        );
        if (confirmationResult.exitCode !== 0) {
          throw agentBrowserFailure(confirmationResult, "pinned agent-browser confirmation");
        }
        const confirmationRoot = guardBrowserRecord(
          parseLastJsonWithExactLaunchHashes(confirmationResult.stdout),
          "pinned derivation browser confirmation result",
        );
        exactGuardBrowserKeys(
          confirmationRoot,
          ["_boundary", "data", "error", "success"],
          "pinned derivation browser confirmation result",
        );
        const confirmationBoundary = guardBrowserRecord(
          confirmationRoot._boundary,
          "pinned derivation browser confirmation boundary",
        );
        exactGuardBrowserKeys(
          confirmationBoundary,
          ["nonce", "origin"],
          "pinned derivation browser confirmation boundary",
        );
        const confirmationData = guardBrowserRecord(
          confirmationRoot.data,
          "pinned derivation browser confirmation data",
        );
        exactGuardBrowserKeys(
          confirmationData,
          ["action", "confirmed", "lifecycle", "result"],
          "pinned derivation browser confirmation data",
        );
        const confirmedResult = guardBrowserRecord(
          confirmationData.result,
          "pinned derivation browser confirmed result",
        );
        exactGuardBrowserKeys(
          confirmedResult,
          ["data", "id", "success"],
          "pinned derivation browser confirmed result",
        );
        const exactConfirmedData = guardBrowserRecord(
          confirmedResult.data,
          "pinned derivation browser confirmed data",
        );
        if (
          confirmationRoot.success !== true
          || confirmationRoot.error !== null
          || typeof confirmationBoundary.nonce !== "string"
          || !/^[a-f0-9]{32}$/u.test(confirmationBoundary.nonce)
          || confirmationBoundary.origin !== "unknown"
          || confirmationData.confirmed !== true
          || confirmationData.action !== confirmationAction
          || confirmedResult.id !== confirmationId
          || confirmedResult.success !== true
          || !("lifecycle" in exactConfirmedData)
          || ["confirmation_required", "confirmation_id", "confirmed", "denied"].some(
            (key) => key in exactConfirmedData,
          )
        ) throw new Error("pinned derivation browser confirmation did not complete exactly");
        exactGuardBrowserIdentity([
          guardBrowserLifecycle(confirmationData.lifecycle, false),
          guardBrowserLifecycle(exactConfirmedData.lifecycle, false),
        ], pin.browserIdentity);
        return exactConfirmedData;
      });
      completed.push({
        command,
        error: null,
        result: confirmedData,
        success: true,
      });
      continue;
    }
    if (requiresConfirmation) {
      throw new Error("mutating pinned derivation browser command bypassed confirmation");
    }
    exactGuardBrowserIdentity([guardBrowserLifecycle(data.lifecycle, false)], pin.browserIdentity);
    if (
      command[0] === "get"
      && command[1] === "cdp-url"
      && data.cdpUrl !== pin.cdpUrl
    ) throw new Error("pinned derivation browser returned a different private CDP URL");
    completed.push(record);
  }
  return completed;
}

export type DerivationGuardBrowserContext = {
  readonly cdpUrl: string;
  readonly currentUrl: string;
  readonly browserIdentity: DerivationGuardBrowserIdentity;
};

export type DerivationGuardBrowserIdentity = {
  readonly engine: "chrome";
  readonly launchHash: string;
};

export type DerivationPinnedBrowserContext = {
  readonly cdpUrl: string;
  readonly currentUrl: string;
  readonly browserIdentity: DerivationGuardBrowserIdentity;
};

const maximumU64 = (1n << 64n) - 1n;

function guardBrowserRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} changed shape`);
  }
  return value as Record<string, unknown>;
}

function exactGuardBrowserKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} changed shape`);
  }
}

function guardBrowserResult(
  value: unknown,
  expectedCommand: readonly string[],
): Record<string, unknown> {
  const record = guardBrowserRecord(value, "derivation guard browser result");
  exactGuardBrowserKeys(record, ["command", "error", "result", "success"], "derivation guard browser result");
  if (
    JSON.stringify(record.command) !== JSON.stringify(expectedCommand)
    || record.success !== true
    || record.error !== null
  ) throw new Error("derivation guard browser command did not succeed exactly");
  return guardBrowserRecord(record.result, "derivation guard browser command result");
}

function guardBrowserLifecycle(
  value: unknown,
  requireReusable = true,
): DerivationGuardBrowserIdentity {
  const lifecycle = guardBrowserRecord(value, "derivation guard browser lifecycle");
  exactGuardBrowserKeys(lifecycle, [
    "effectiveLaunch",
    "launched",
    "relaunchedBrowser",
    "restartedBackground",
    "restoreStatus",
    "reused",
    "saveStatus",
  ], "derivation guard browser lifecycle");
  const effectiveLaunch = guardBrowserRecord(
    lifecycle.effectiveLaunch,
    "derivation guard browser effective launch",
  );
  exactGuardBrowserKeys(
    effectiveLaunch,
    ["browserLaunched", "engine", "launchHash"],
    "derivation guard browser effective launch",
  );
  if (
    effectiveLaunch.browserLaunched !== true
    || effectiveLaunch.engine !== "chrome"
    || typeof effectiveLaunch.launchHash !== "string"
    || !/^(?:0|[1-9][0-9]{0,19})$/u.test(effectiveLaunch.launchHash)
    || BigInt(effectiveLaunch.launchHash) > maximumU64
    || lifecycle.launched !== false
    || lifecycle.relaunchedBrowser !== false
    || lifecycle.restartedBackground !== false
    || (requireReusable ? lifecycle.reused !== true : typeof lifecycle.reused !== "boolean")
    || lifecycle.restoreStatus !== "not_configured"
    || lifecycle.saveStatus !== "not_attempted"
  ) throw new Error("derivation guard browser lifecycle is not reusable");
  return {
    engine: "chrome",
    launchHash: effectiveLaunch.launchHash,
  };
}

function sameGuardBrowserIdentity(
  left: DerivationGuardBrowserIdentity,
  right: DerivationGuardBrowserIdentity,
): boolean {
  return left.engine === right.engine && left.launchHash === right.launchHash;
}

function exactGuardBrowserIdentity(
  identities: readonly DerivationGuardBrowserIdentity[],
  expected?: DerivationGuardBrowserIdentity,
): DerivationGuardBrowserIdentity {
  const first = identities[0];
  if (
    first === undefined
    || identities.some((identity) => !sameGuardBrowserIdentity(identity, first))
    || (expected !== undefined && !sameGuardBrowserIdentity(first, expected))
  ) throw new Error("derivation guard browser lifecycle changed identity");
  return first;
}

function guardBrowserData(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): DerivationGuardBrowserIdentity {
  exactGuardBrowserKeys(value, [...expected, "lifecycle"], label);
  return guardBrowserLifecycle(value.lifecycle);
}

function guardBrowserPageUrl(
  value: unknown,
  browserDomains: readonly string[],
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 64 * 1024
    || /[\0\r\n]/u.test(value)
  ) throw new Error("derivation guard browser URL is invalid");
  if (value === "about:blank") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("derivation guard browser URL is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || !browserDomainsCover(browserDomains, url.hostname.toLowerCase())
  ) throw new Error("derivation guard browser URL is outside its exact policy");
  return value;
}

export function parseDerivationGuardBrowserContextResult(
  value: unknown,
  browserDomains: readonly string[],
): DerivationGuardBrowserContext {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("derivation guard browser context changed shape");
  }
  const cdpData = guardBrowserResult(value[0], ["get", "cdp-url"]);
  const cdpIdentity = guardBrowserData(
    cdpData,
    ["cdpUrl"],
    "derivation guard browser CDP result",
  );
  const urlData = guardBrowserResult(value[1], ["get", "url"]);
  const urlIdentity = guardBrowserData(
    urlData,
    ["url"],
    "derivation guard browser URL result",
  );
  const currentUrl = guardBrowserPageUrl(urlData.url, browserDomains);
  const browserIdentity = exactGuardBrowserIdentity([
    cdpIdentity,
    urlIdentity,
  ]);
  return {
    cdpUrl: localBrowserCdpUrl(cdpData.cdpUrl),
    currentUrl,
    browserIdentity,
  };
}

export function parseDerivationPinnedBrowserContextResult(
  value: unknown,
  browserDomains: readonly string[],
): DerivationPinnedBrowserContext {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("pinned derivation browser context changed shape");
  }
  const cdpData = guardBrowserResult(value[0], ["get", "cdp-url"]);
  const cdpIdentity = guardBrowserData(
    cdpData,
    ["cdpUrl"],
    "pinned derivation browser CDP result",
  );
  const urlData = guardBrowserResult(value[1], ["get", "url"]);
  const urlIdentity = guardBrowserData(
    urlData,
    ["url"],
    "pinned derivation browser URL result",
  );
  return {
    cdpUrl: localBrowserCdpUrl(cdpData.cdpUrl),
    currentUrl: guardBrowserPageUrl(urlData.url, browserDomains),
    browserIdentity: exactGuardBrowserIdentity([cdpIdentity, urlIdentity]),
  };
}

async function privateDerivationGuardBrowserContext(
  session: DerivationSession,
): Promise<DerivationGuardBrowserContext> {
  const commands = [["get", "cdp-url"], ["get", "url"]] as const;
  const result = await runBoundAgentBrowser(
    session,
    derivationExistingOwnerContextArguments(session),
    {
      timeoutMs: 120_000,
      maxOutputBytes: 10 * 1024 * 1024,
      stdin: JSON.stringify(commands),
      codeOwnedBrowserRequest: { kind: "readiness-context" },
    },
  );
  if (result.exitCode !== 0) throw new Error("derivation guard browser context command failed");
  return parseDerivationGuardBrowserContextResult(
    parseLastJsonWithExactLaunchHashes(result.stdout),
    session.browserDomains,
  );
}


async function privateDerivationPinnedBrowserContext(
  session: DerivationSession,
  context: DerivationGuardBrowserContext,
): Promise<DerivationPinnedBrowserContext> {
  const commands = [["get", "cdp-url"], ["get", "url"]] as const;
  const result = await runBoundAgentBrowser(
    session,
    ["batch", "--bail", "--json"],
    {
      timeoutMs: 120_000,
      maxOutputBytes: 10 * 1024 * 1024,
      stdin: JSON.stringify(commands),
      codeOwnedBrowserRequest: {
        kind: "pin-context",
        pin: {
          sessionName: derivationPinSessionName(session),
          cdpUrl: context.cdpUrl,
          browserIdentity: null,
          confirmationAction: null,
          daemonOwner: null,
        },
      },
    },
  );
  if (result.exitCode !== 0) throw new Error("pinned derivation browser context command failed");
  const pinned = parseDerivationPinnedBrowserContextResult(
    parseLastJsonWithExactLaunchHashes(result.stdout),
    session.browserDomains,
  );
  if (pinned.currentUrl !== context.currentUrl) {
    throw new Error("pinned derivation browser page changed during guard verification");
  }
  if (pinned.cdpUrl !== context.cdpUrl) {
    throw new Error("pinned derivation browser endpoint changed during guard verification");
  }
  const daemonOwner = await bindDerivationBrowserDaemon(
    session,
    derivationPinSessionName(session),
    pinned.browserIdentity,
  );
  publishContainedBrowserMarker(session, {
    schemaVersion: 1,
    kind: "io-derivation-contained-browser-pin",
    derivationId: session.id,
    sessionName: derivationPinSessionName(session),
    cdpUrl: pinned.cdpUrl,
    browserIdentity: pinned.browserIdentity,
    daemonOwner,
  });
  return pinned;
}
async function runDerivationDnrReadiness(
  session: DerivationSession,
  context: DerivationGuardBrowserContext,
  initialize: boolean,
): Promise<void> {
  await (initialize ? initializeDerivationDnrReadiness : verifyDerivationDnrReadiness)(
    context.cdpUrl,
    context.currentUrl,
    session.browserDomains,
  );
}

async function verifyContainedNetworkGuard(
  session: DerivationSession,
): Promise<DerivationGuardBrowserContext | null> {
  const guard = containedNetworkGuard(session);
  if (guard === null) return null;
  await verifyDerivationNetworkBoundary({
    derivationId: session.id,
    directory: session.directory,
    directoryIdentity: session.directoryIdentity,
    socketDirectory: session.socketDirectory,
    socketIdentity: session.socketIdentity,
    browserDomains: session.browserDomains,
    guard,
  });
  const context = await privateDerivationGuardBrowserContext(session);
  await runDerivationDnrReadiness(session, context, false);
  return context;
}

async function initializeContainedNetworkGuard(session: DerivationSession): Promise<void> {
  const guard = containedNetworkGuard(session);
  if (guard === null) return;
  await verifyDerivationNetworkBoundary({
    derivationId: session.id,
    directory: session.directory,
    directoryIdentity: session.directoryIdentity,
    socketDirectory: session.socketDirectory,
    socketIdentity: session.socketIdentity,
    browserDomains: session.browserDomains,
    guard,
  });
  await rawBatch(session, [["open", "about:blank"]], true);
  writePrivateJson(session.configPath, derivationBrowserConfig(true));
  const context = await privateDerivationGuardBrowserContext(session);
  const daemonOwner = await bindDerivationBrowserDaemon(
    session,
    session.sessionName,
    context.browserIdentity,
  );
  publishContainedBrowserMarker(session, {
    schemaVersion: 1,
    kind: "io-derivation-contained-browser-owner",
    derivationId: session.id,
    sessionName: session.sessionName,
    cdpUrl: context.cdpUrl,
    browserIdentity: context.browserIdentity,
    daemonOwner,
  });
  await runDerivationDnrReadiness(session, context, true);
  await verifyContainedNetworkGuard(session);
}

async function batch(
  session: DerivationSession,
  commands: readonly (readonly string[])[],
): Promise<readonly Record<string, unknown>[]> {
  const context = await verifyContainedNetworkGuard(session);
  if (context === null) return rawBatch(session, commands);
  const pinContext = await privateDerivationPinnedBrowserContext(session, context);
  return pinnedRawBatch(session, commands, {
    sessionName: derivationPinSessionName(session),
    cdpUrl: context.cdpUrl,
    browserIdentity: pinContext.browserIdentity,
    confirmationAction: null,
    daemonOwner: null,
  }, pinContext.currentUrl);
}

function parseActiveDerivationBrowserDaemon(
  value: unknown,
  session: DerivationSession,
  sessionName: string,
  expectedBrowser: DerivationGuardBrowserIdentity,
): number {
  const root = guardBrowserRecord(value, "derivation browser daemon result");
  exactGuardBrowserKeys(root, ["data", "success"], "derivation browser daemon result");
  const data = guardBrowserRecord(root.data, "derivation browser daemon data");
  exactGuardBrowserKeys(data, [
    "active",
    "namespace",
    "pid",
    "runtime",
    "runtimeError",
    "session",
    "socketDir",
    "version",
  ], "derivation browser daemon data");
  const runtime = guardBrowserRecord(data.runtime, "derivation browser daemon runtime");
  exactGuardBrowserKeys(runtime, [
    "backgroundPid",
    "browserLaunched",
    "compatibilityStatus",
    "effectiveLaunch",
    "engine",
    "launchHash",
    "lifecycle",
    "namespace",
    "pageCount",
    "restoreCheckFn",
    "restoreCheckText",
    "restoreCheckUrl",
    "restoreKey",
    "restoreLoadedPath",
    "restoreSave",
    "restoreSavedPath",
    "restoreStatus",
    "restoreStatusDetail",
    "restoreValidationPending",
    "saveStatus",
    "session",
    "socketDir",
  ], "derivation browser daemon runtime");
  const effectiveLaunch = guardBrowserRecord(
    runtime.effectiveLaunch,
    "derivation browser daemon effective launch",
  );
  exactGuardBrowserKeys(
    effectiveLaunch,
    ["browserLaunched", "engine", "launchHash"],
    "derivation browser daemon effective launch",
  );
  const lifecycle = guardBrowserRecord(runtime.lifecycle, "derivation browser daemon lifecycle");
  exactGuardBrowserKeys(lifecycle, [
    "effectiveLaunch",
    "launched",
    "relaunchedBrowser",
    "restartedBackground",
    "restoreStatus",
    "reused",
    "saveStatus",
  ], "derivation browser daemon lifecycle");
  const lifecycleLaunch = guardBrowserRecord(
    lifecycle.effectiveLaunch,
    "derivation browser daemon lifecycle launch",
  );
  exactGuardBrowserKeys(
    lifecycleLaunch,
    ["browserLaunched", "engine", "launchHash"],
    "derivation browser daemon lifecycle launch",
  );
  if (
    root.success !== true
    || data.active !== true
    || data.namespace !== null
    || !Number.isSafeInteger(data.pid)
    || (data.pid as number) < 1
    || data.runtimeError !== null
    || data.session !== sessionName
    || data.socketDir !== session.socketDirectory
    || data.version !== "0.32.3"
    || runtime.backgroundPid !== data.pid
    || runtime.browserLaunched !== true
    || runtime.compatibilityStatus !== "current"
    || runtime.engine !== expectedBrowser.engine
    || runtime.launchHash !== expectedBrowser.launchHash
    || runtime.namespace !== null
    || runtime.pageCount !== 1
    || runtime.restoreCheckFn !== null
    || runtime.restoreCheckText !== null
    || runtime.restoreCheckUrl !== null
    || runtime.restoreKey !== null
    || runtime.restoreLoadedPath !== null
    || runtime.restoreSave !== "auto"
    || runtime.restoreSavedPath !== null
    || runtime.restoreStatus !== "not_configured"
    || runtime.restoreStatusDetail !== null
    || runtime.restoreValidationPending !== false
    || runtime.saveStatus !== "not_attempted"
    || runtime.session !== sessionName
    || runtime.socketDir !== session.socketDirectory
    || effectiveLaunch.browserLaunched !== true
    || effectiveLaunch.engine !== expectedBrowser.engine
    || effectiveLaunch.launchHash !== expectedBrowser.launchHash
    || lifecycleLaunch.browserLaunched !== true
    || lifecycleLaunch.engine !== expectedBrowser.engine
    || lifecycleLaunch.launchHash !== expectedBrowser.launchHash
    || lifecycle.launched !== false
    || lifecycle.relaunchedBrowser !== false
    || lifecycle.restartedBackground !== false
    || lifecycle.restoreStatus !== "not_configured"
    || lifecycle.reused !== false
    || lifecycle.saveStatus !== "not_attempted"
  ) throw new Error("derivation browser daemon identity changed or was relaunched");
  return data.pid as number;
}

export function parseMarkedDerivationBrowserDaemonForCleanup(
  value: unknown,
  session: DerivationSession,
  marker: {
    readonly daemonOwner: ProcessOwnerIdentity;
    readonly sessionName: string;
  },
): number {
  const root = guardBrowserRecord(value, "marked derivation browser daemon result");
  exactGuardBrowserKeys(root, ["data", "success"], "marked derivation browser daemon result");
  const data = guardBrowserRecord(root.data, "marked derivation browser daemon data");
  exactGuardBrowserKeys(data, [
    "active",
    "namespace",
    "pid",
    "runtime",
    "runtimeError",
    "session",
    "socketDir",
    "version",
  ], "marked derivation browser daemon data");
  const runtime = guardBrowserRecord(data.runtime, "marked derivation browser daemon runtime");
  exactGuardBrowserKeys(runtime, [
    "backgroundPid",
    "browserLaunched",
    "compatibilityStatus",
    "effectiveLaunch",
    "engine",
    "launchHash",
    "lifecycle",
    "namespace",
    "pageCount",
    "restoreCheckFn",
    "restoreCheckText",
    "restoreCheckUrl",
    "restoreKey",
    "restoreLoadedPath",
    "restoreSave",
    "restoreSavedPath",
    "restoreStatus",
    "restoreStatusDetail",
    "restoreValidationPending",
    "saveStatus",
    "session",
    "socketDir",
  ], "marked derivation browser daemon runtime");
  const effectiveLaunch = guardBrowserRecord(
    runtime.effectiveLaunch,
    "marked derivation browser daemon effective launch",
  );
  exactGuardBrowserKeys(
    effectiveLaunch,
    ["browserLaunched", "engine", "launchHash"],
    "marked derivation browser daemon effective launch",
  );
  const lifecycle = guardBrowserRecord(runtime.lifecycle, "marked derivation browser daemon lifecycle");
  exactGuardBrowserKeys(lifecycle, [
    "effectiveLaunch",
    "launched",
    "relaunchedBrowser",
    "restartedBackground",
    "restoreStatus",
    "reused",
    "saveStatus",
  ], "marked derivation browser daemon lifecycle");
  const lifecycleLaunch = guardBrowserRecord(
    lifecycle.effectiveLaunch,
    "marked derivation browser daemon lifecycle launch",
  );
  exactGuardBrowserKeys(
    lifecycleLaunch,
    ["browserLaunched", "engine", "launchHash"],
    "marked derivation browser daemon lifecycle launch",
  );
  const validLaunch = (
    launch: Record<string, unknown>,
    browserLaunched: boolean,
  ): boolean => (
    launch.browserLaunched === browserLaunched
    && launch.engine === "chrome"
    && (
      browserLaunched
        ? typeof launch.launchHash === "string"
          && /^(?:0|[1-9][0-9]{0,19})$/u.test(launch.launchHash)
          && BigInt(launch.launchHash) <= maximumU64
        : launch.launchHash === null
    )
  );
  const boundedNullableText = (candidate: unknown): boolean => (
    candidate === null
    || (
      typeof candidate === "string"
      && candidate.length <= 64 * 1024
      && !candidate.includes("\u0000")
    )
  );
  if (
    root.success !== true
    || data.active !== true
    || data.namespace !== null
    || data.pid !== marker.daemonOwner.pid
    || data.runtimeError !== null
    || data.session !== marker.sessionName
    || data.socketDir !== session.socketDirectory
    || data.version !== "0.32.3"
    || runtime.backgroundPid !== marker.daemonOwner.pid
    || typeof runtime.browserLaunched !== "boolean"
    || typeof runtime.compatibilityStatus !== "string"
    || runtime.compatibilityStatus.length < 1
    || runtime.compatibilityStatus.length > 256
    || runtime.engine !== "chrome"
    || (
      runtime.browserLaunched
        ? typeof runtime.launchHash !== "string"
          || !/^(?:0|[1-9][0-9]{0,19})$/u.test(runtime.launchHash)
          || BigInt(runtime.launchHash) > maximumU64
        : runtime.launchHash !== null
    )
    || runtime.namespace !== null
    || !Number.isSafeInteger(runtime.pageCount)
    || (runtime.pageCount as number) < 0
    || (runtime.pageCount as number) > 100
    || !boundedNullableText(runtime.restoreCheckFn)
    || !boundedNullableText(runtime.restoreCheckText)
    || !boundedNullableText(runtime.restoreCheckUrl)
    || !boundedNullableText(runtime.restoreKey)
    || !boundedNullableText(runtime.restoreLoadedPath)
    || !["auto", "always", "never"].includes(
      typeof runtime.restoreSave === "string" ? runtime.restoreSave : "",
    )
    || !boundedNullableText(runtime.restoreSavedPath)
    || typeof runtime.restoreStatus !== "string"
    || runtime.restoreStatus.length < 1
    || runtime.restoreStatus.length > 256
    || !boundedNullableText(runtime.restoreStatusDetail)
    || typeof runtime.restoreValidationPending !== "boolean"
    || typeof runtime.saveStatus !== "string"
    || runtime.saveStatus.length < 1
    || runtime.saveStatus.length > 256
    || runtime.session !== marker.sessionName
    || runtime.socketDir !== session.socketDirectory
    || !validLaunch(effectiveLaunch, runtime.browserLaunched)
    || !validLaunch(lifecycleLaunch, runtime.browserLaunched)
    || typeof lifecycle.launched !== "boolean"
    || typeof lifecycle.relaunchedBrowser !== "boolean"
    || typeof lifecycle.restartedBackground !== "boolean"
    || typeof lifecycle.restoreStatus !== "string"
    || lifecycle.restoreStatus.length < 1
    || lifecycle.restoreStatus.length > 256
    || typeof lifecycle.reused !== "boolean"
    || typeof lifecycle.saveStatus !== "string"
    || lifecycle.saveStatus.length < 1
    || lifecycle.saveStatus.length > 256
  ) throw new Error("marked derivation browser daemon identity changed shape");
  return marker.daemonOwner.pid;
}

function parseInactiveDerivationBrowserDaemon(
  value: unknown,
  session: DerivationSession,
  sessionName: string,
): void {
  const root = guardBrowserRecord(value, "inactive derivation browser daemon result");
  exactGuardBrowserKeys(root, ["data", "success"], "inactive derivation browser daemon result");
  const data = guardBrowserRecord(root.data, "inactive derivation browser daemon data");
  exactGuardBrowserKeys(data, [
    "active",
    "namespace",
    "pid",
    "runtime",
    "runtimeError",
    "session",
    "socketDir",
    "version",
  ], "inactive derivation browser daemon data");
  if (
    root.success !== true
    || data.active !== false
    || data.namespace !== null
    || data.pid !== null
    || data.runtime !== null
    || data.runtimeError !== null
    || data.session !== sessionName
    || data.socketDir !== session.socketDirectory
    || data.version !== null
  ) throw new Error("derivation browser daemon did not become inactive exactly");
}

async function derivationBrowserSessionInfo(
  session: DerivationSession,
  sessionName: string,
): Promise<unknown> {
  const result = await runBoundAgentBrowser(
    session,
    ["--session", sessionName, "session", "info", "--json"],
    { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 },
  );
  if (result.exitCode !== 0) throw new Error("derivation browser daemon inspection failed");
  return parseLastJsonWithExactLaunchHashes(result.stdout);
}

async function bindDerivationBrowserDaemon(
  session: DerivationSession,
  sessionName: string,
  expectedBrowser: DerivationGuardBrowserIdentity,
): Promise<ProcessOwnerIdentity> {
  const firstPid = parseActiveDerivationBrowserDaemon(
    await derivationBrowserSessionInfo(session, sessionName),
    session,
    sessionName,
    expectedBrowser,
  );
  const owner = captureProcessOwnerIdentity(firstPid);
  const secondPid = parseActiveDerivationBrowserDaemon(
    await derivationBrowserSessionInfo(session, sessionName),
    session,
    sessionName,
    expectedBrowser,
  );
  if (secondPid !== owner.pid || processOwnerStatus(owner) !== "exact-live-owner") {
    throw new Error("derivation browser daemon changed while its process identity was bound");
  }
  return owner;
}

export async function exactCdpEndpointStatus(
  cdpUrl: string,
): Promise<"available" | "unavailable" | "indeterminate"> {
  const endpoint = localBrowserCdpUrl(cdpUrl);
  const url = new URL(endpoint);
  const port = Number(url.port);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  if (host !== "127.0.0.1" && host !== "::1") return "indeterminate";
  return new Promise<"available" | "unavailable" | "indeterminate">((resolve) => {
    const socket = createConnection({
      host,
      port,
    });
    let settled = false;
    const finish = (status: "available" | "unavailable" | "indeterminate"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => finish("indeterminate"), 250);
    socket.once("connect", () => finish("available"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "unavailable" : "indeterminate");
    });
    socket.once("close", () => finish("indeterminate"));
  });
}

function readContainedBrowserMarkerIfPresent(
  session: DerivationSession,
  kind: ContainedDerivationBrowserMarker["kind"],
  environment: Readonly<Record<string, string | undefined>>,
): ContainedDerivationBrowserMarker | null {
  const name = kind === "io-derivation-contained-browser-owner"
    ? derivationContainedBrowserOwnerMarkerName
    : derivationContainedBrowserPinMarkerName;
  const entry = sessionEntry(session, name, environment);
  if (entry === undefined) return null;
  if (entry.kind !== "file") throw new Error("contained derivation browser marker is unavailable or unsafe");
  let value: unknown;
  try {
    value = JSON.parse(readRegularFile(
      containedBrowserMarkerPath(session, kind),
      64 * 1024,
      "contained derivation browser marker",
      session.directoryIdentity,
    )) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("contained derivation browser marker is malformed", { cause: error });
    }
    throw error;
  }
  return parseContainedBrowserMarker(value, session, kind);
}

async function inspectContainedDaemonBeforeCleanup(
  session: DerivationSession,
  sessionName: string,
  marker: ContainedDerivationBrowserMarker | null,
): Promise<ProcessOwnerIdentity | null> {
  const status = marker === null
    ? "different-or-dead"
    : processOwnerStatus(marker.daemonOwner);
  if (status === "unknown") {
    throw new Error("contained derivation browser process identity is indeterminate");
  }
  const info = await derivationBrowserSessionInfo(session, sessionName);
  if (marker === null || status === "different-or-dead") {
    parseInactiveDerivationBrowserDaemon(info, session, sessionName);
    return null;
  }
  const pid = parseMarkedDerivationBrowserDaemonForCleanup(
    info,
    session,
    marker,
  );
  if (
    pid !== marker.daemonOwner.pid
    || processOwnerStatus(marker.daemonOwner) !== "exact-live-owner"
  ) throw new Error("contained derivation browser daemon changed before cleanup");
  return marker.daemonOwner;
}

async function terminateContainedDerivationBrowsers(
  session: DerivationSession,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const ownerMarker = readContainedBrowserMarkerIfPresent(
    session,
    "io-derivation-contained-browser-owner",
    environment,
  );
  if (ownerMarker === null) {
    throw new Error("contained derivation browser owner marker is unavailable");
  }
  const pinMarker = readContainedBrowserMarkerIfPresent(
    session,
    "io-derivation-contained-browser-pin",
    environment,
  );
  if (pinMarker !== null && pinMarker.cdpUrl !== ownerMarker.cdpUrl) {
    throw new Error("contained derivation browser markers disagree on their exact CDP endpoint");
  }
  const pinName = derivationPinSessionName(session);
  const terminateOne = async (
    sessionName: string,
    marker: ContainedDerivationBrowserMarker | null,
    forbiddenPid: number | null,
  ): Promise<number | null> => {
    const identity = await inspectContainedDaemonBeforeCleanup(session, sessionName, marker);
    if (identity === null) return null;
    if (forbiddenPid !== null && identity.pid === forbiddenPid) {
      throw new Error("contained derivation browser daemons share an invalid process identity");
    }
    if (processOwnerStatus(identity) !== "exact-live-owner") {
      throw new Error("contained derivation browser daemon changed before termination");
    }
    try {
      process.kill(identity.pid, "SIGTERM");
    } catch (error) {
      if (processOwnerStatus(identity) === "exact-live-owner") throw error;
    }
    const processDeadline = Date.now() + 5_000;
    for (;;) {
      const status = processOwnerStatus(identity);
      if (status === "unknown") {
        throw new Error("contained derivation browser termination became indeterminate");
      }
      if (status === "different-or-dead") break;
      if (Date.now() >= processDeadline) {
        throw new Error("contained derivation browser daemon did not terminate after SIGTERM");
      }
      await Bun.sleep(25);
    }
    parseInactiveDerivationBrowserDaemon(
      await derivationBrowserSessionInfo(session, sessionName),
      session,
      sessionName,
    );
    return identity.pid;
  };
  const pinPid = await terminateOne(pinName, pinMarker, null);
  await terminateOne(session.sessionName, ownerMarker, pinPid);
  const deadline = Date.now() + 5_000;
  let consecutiveRefusals = 0;
  while (consecutiveRefusals < 3) {
    const endpointStatus = await exactCdpEndpointStatus(ownerMarker.cdpUrl);
    if (endpointStatus === "indeterminate") {
      throw new Error("exact derivation browser CDP endpoint state became indeterminate");
    }
    consecutiveRefusals = endpointStatus === "unavailable"
      ? consecutiveRefusals + 1
      : 0;
    if (consecutiveRefusals >= 3) break;
    if (Date.now() >= deadline) {
      throw new Error("exact derivation browser CDP endpoint remained available");
    }
    await Bun.sleep(25);
  }
}

async function closeSession(
  session: DerivationSession,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const guard = session.profilePath === null
    && session.schemaVersion === 2
    && session.networkGuard != null
    ? session.networkGuard
    : null;
  if (guard !== null) {
    try {
      await terminateContainedDerivationBrowsers(session, environment);
    } catch {
      return false;
    }
    try {
      if (!await closeSessionNetworkBoundary(session)) return false;
    } catch {
      return false;
    }
  } else {
    const result = await runBoundAgentBrowser(
      session,
      [...derivationGlobalArguments(session), "close", "--json"],
      { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 },
    ).catch(() => null);
    if (result?.exitCode !== 0) return false;
    try {
      assertNoUnboundDerivationControl(session.id);
    } catch {
      return false;
    }
  }
  return true;
}

async function closeSessionNetworkBoundary(session: DerivationSession): Promise<boolean> {
  const guard = session.profilePath === null
    && session.schemaVersion === 2
    && session.networkGuard != null
    ? session.networkGuard
    : null;
  try {
    if (guard !== null) {
      await closeDerivationNetworkBoundary({
        derivationId: session.id,
        guard,
      });
    }
    assertNoUnboundDerivationControl(session.id);
    return true;
  } catch {
    return false;
  }
}

function sessionNetworkOwner(session: DerivationSession): ProcessOwnerIdentity | null {
  return session.profilePath === null
    && session.schemaVersion === 2
    && session.networkGuard != null
    ? session.networkGuard.proxy.owner
    : null;
}

function assertRecordedNetworkOwnerQuiescent(owner: ProcessOwnerIdentity | null): void {
  if (owner === null) return;
  if (processOwnerStatus(owner) !== "different-or-dead") {
    throw new Error("derivation network proxy owner could not be proved quiescent");
  }
}

function assertSessionNetworkBoundaryQuiescent(session: DerivationSession): void {
  assertRecordedNetworkOwnerQuiescent(sessionNetworkOwner(session));
  assertNoUnboundDerivationControl(session.id);
}

function removeSessionStateWithoutSocket(
  session: DerivationSession,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  assertSessionNetworkBoundaryQuiescent(session);
  assertSessionNetworkBoundaryQuiescent(session);
  removePrivateStateDirectoryTree(session.directory, environment, session.directoryIdentity);
}

function removeSessionTrees(
  session: DerivationSession,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  assertSessionNetworkBoundaryQuiescent(session);
  removePrivateDirectoryTree(session.socketDirectory, session.socketIdentity);
  assertSessionNetworkBoundaryQuiescent(session);
  removePrivateStateDirectoryTree(session.directory, environment, session.directoryIdentity);
}

function removeInterruptedSessionTrees(
  initialization: DerivationInitialization,
  environment: Readonly<Record<string, string | undefined>>,
  owner: ProcessOwnerIdentity | null,
): void {
  assertRecordedNetworkOwnerQuiescent(owner);
  assertNoUnboundDerivationControl(initialization.derivationId);
  const socketPresent = inspectInitializationSocket(initialization);
  if (socketPresent) {
    removePrivateDirectoryTree(initialization.socketDirectory, initialization.socketIdentity);
  }
  assertRecordedNetworkOwnerQuiescent(owner);
  assertNoUnboundDerivationControl(initialization.derivationId);
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

function derivationControlEndpointIsAbsent(id: string): boolean {
  try {
    lstatSync(derivationGuardControlSocketPath(id));
    return false;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    return true;
  }
}

function assertNoUnboundDerivationControl(id: string): void {
  if (!derivationControlEndpointIsAbsent(id)) {
    throw new Error(
      `derivation ${id} has an unbound network control endpoint; its private state was preserved`,
    );
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
    assertNoUnboundDerivationControl(phase.derivationId);
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
    assertNoUnboundDerivationControl(id);
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

/**
 * Initialize the contained browser on a harmless allowed origin before
 * seeding cookies. When explicitly supplied, the first exact cookie origin is
 * the code-owned bootstrap; this lets redirect-prone application origins use
 * a stable first-party page without broadening the browser allowlist.
 */
export function derivationBootstrapUrl(
  target: URL,
  cookieOrigins: readonly URL[] = [],
): string {
  const selected = cookieOrigins[0] ?? target;
  const bootstrap = new URL("/robots.txt", selected.origin);
  if (bootstrap.origin !== selected.origin) {
    throw new Error("derivation bootstrap escaped its selected origin");
  }
  return bootstrap.href;
}

function validateDerivationCookieOrigins(
  values: readonly string[],
  browserDomains: readonly string[],
  target: URL,
  auth: WrenchAuth,
): readonly URL[] {
  if (values.length > 16) {
    throw new Error("derivation accepts at most 16 cookie origins");
  }
  if (
    values.length > 0
    && auth.kind !== "cookie-source"
    && auth.kind !== "cookies-file"
  ) {
    throw new Error(
      "derivation cookie origins require cookie-source or cookies-file auth so the browser remains domain-contained",
    );
  }
  const origins: URL[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let origin: URL;
    try {
      origin = validateTarget(value);
    } catch {
      throw new Error("derivation cookie origins must be exact public HTTPS origins");
    }
    if (value !== origin.origin && value !== `${origin.origin}/`) {
      throw new Error("derivation cookie origins must be exact public HTTPS origins");
    }
    if (!browserDomainsCover(browserDomains, origin.hostname.toLowerCase())) {
      throw new Error("every derivation cookie origin must be covered by browser domains");
    }
    if (seen.has(origin.origin)) {
      throw new Error("derivation cookie origins must be unique");
    }
    seen.add(origin.origin);
    if (origin.origin !== target.origin) origins.push(new URL(origin.origin));
  }
  return Object.freeze(origins);
}

function sameCookie(left: StrictCookie, right: StrictCookie): boolean {
  return left.name === right.name
    && left.value === right.value
    && left.domain === right.domain
    && left.hostOnly === right.hostOnly
    && left.path === right.path
    && left.secure === right.secure
    && left.httpOnly === right.httpOnly
    && left.sameSite === right.sameSite
    && left.expires === right.expires;
}

/**
 * Read every explicit origin before emitting any secret-bearing stdin command.
 * Exact duplicate cookies are injected once; an identity collision with any
 * differing value or attribute fails before the browser receives a cookie.
 */
export async function derivationCookieCommands(
  auth: Extract<WrenchAuth, { readonly kind: "cookie-source" | "cookies-file" }>,
  target: URL,
  cookieOrigins: readonly URL[],
  reader: CookieRecordReader = acquireCookieRecords,
): Promise<readonly (readonly string[])[]> {
  const targets = [target, ...cookieOrigins];
  const selected = new Map<
    string,
    { readonly cookie: StrictCookie; readonly target: URL }
  >();
  for (const cookieTarget of targets) {
    const result = await reader({
      cookieSources: auth.kind === "cookie-source" ? [auth.source] : [],
      cookieProfile: auth.kind === "cookie-source" ? auth.profile : undefined,
      cookiesFile: auth.kind === "cookies-file" ? auth.path : undefined,
      timeoutMs: 60_000,
      ...(cookieOrigins.length === 0 ? {} : { requireExplicitCookieScope: true }),
    }, cookieTarget);
    for (const cookie of result.cookies) {
      const identity = `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
      const previous = selected.get(identity);
      if (previous !== undefined) {
        if (!sameCookie(previous.cookie, cookie)) {
          throw new Error("cookie origins returned conflicting duplicate cookie identities");
        }
        continue;
      }
      selected.set(identity, { cookie, target: cookieTarget });
    }
  }
  return Object.freeze([...selected.values()].flatMap(({ cookie, target: cookieTarget }) =>
    browserCookieCommands([cookie], cookieTarget)));
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
    readonly cookieOrigins?: readonly string[];
    readonly fixtureSources?: readonly string[];
    readonly headed: boolean;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
): Promise<DerivationSession> {
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(adapterId)) throw new Error("adapter ID must be lowercase kebab-case");
  const environment = options.environment ?? process.env;
  const target = validateTarget(targetValue);
  assertBrowserDerivationTargetAllowed(target);
  assertDerivationAuthCompatibility(target, auth);
  const browserDomains = validateDerivationBrowserDomains(options.browserDomains, target.hostname.toLowerCase());
  const cookieOrigins = validateDerivationCookieOrigins(
    options.cookieOrigins ?? [],
    browserDomains,
    target,
    auth,
  );
  const fixtureSources = options.fixtureSources ?? [];
  if (fixtureSources.length > 0 && !options.allowRemoteActions) {
    throw new Error("derivation fixtures require --allow-remote-actions because upload changes remote draft state");
  }
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
    let initializedNetworkGuard: DerivationNetworkGuard | null = null;
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
      const fixtures = stageDerivationFixtures(fixtureSources, directory);
      writePrivateJson(configPath, derivationBrowserConfig(false));
      // Pinned agent-browser 0.32.3 checks both documented categories and
      // concrete commands such as getbyrole, inputvalue, and har_start.
      writePrivateJson(
        policyPath,
        derivationActionPolicy(options.allowRemoteActions, fixtures.length > 0),
      );
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
      if (clonedProfile === null) {
        writePrivateJson(join(directory, derivationDnrPolicyFileName), {
          default: "deny",
          allow: derivationDnrPolicyActions,
        });
        initializedNetworkGuard = await createDerivationNetworkBoundary({
          derivationId: id,
          directory,
          directoryIdentity,
          socketDirectory,
          socketIdentity,
          browserDomains,
        });
      }
      session = {
        schemaVersion: 2,
        id,
        adapterId,
        targetUrl: target.href,
        targetOrigin: target.origin,
        createdAt: new Date().toISOString(),
        allowRemoteActions: options.allowRemoteActions,
        contentMode: options.contentMode,
        browserDomains,
        fixtures,
        headed: options.headed,
        sessionName: `io-derive-${id.replaceAll("-", "").slice(0, 12)}`,
        directory,
        directoryIdentity,
        socketDirectory,
        socketIdentity,
        configPath,
        policyPath,
        profilePath: clonedProfile,
        networkGuard: initializedNetworkGuard,
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
      if (initializedNetworkGuard !== null) {
        await adoptDerivationNetworkBoundary({
          derivationId: id,
          guard: initializedNetworkGuard,
        });
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      let networkBoundaryQuiescent = true;
      if (error instanceof UnsafeDerivationNetworkBoundaryCleanupError) {
        throw error;
      }
      if (initializedNetworkGuard !== null && socketIdentity !== null) {
        try {
          await closeDerivationNetworkBoundary({
            derivationId: id,
            guard: initializedNetworkGuard,
          });
        } catch (cleanupError) {
          networkBoundaryQuiescent = false;
          cleanupErrors.push(cleanupError);
        }
      }
      if (!networkBoundaryQuiescent) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "derivation initialization failed and its live network boundary was preserved",
        );
      }
      if (socketCreated && socketIdentity !== null) {
        try {
          removePrivateDirectoryTree(socketDirectory, socketIdentity);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        assertRecordedNetworkOwnerQuiescent(initializedNetworkGuard?.proxy.owner ?? null);
        assertNoUnboundDerivationControl(id);
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
      // A contained session launches on about:blank, proves the exact extension
      // and proxy boundary through private CDP/control channels, and only then
      // permits the first provider navigation. The bootstrap remains unrecorded.
      await initializeContainedNetworkGuard(session);
      await batch(session, [["open", derivationBootstrapUrl(target, cookieOrigins)]]);
      if (auth.kind === "cookie-source" || auth.kind === "cookies-file") {
        await batch(
          session,
          await derivationCookieCommands(auth, target, cookieOrigins),
        );
      } else if (auth.kind === "browser-profile" && auth.cookieSource !== undefined) {
        const cookies = await acquireCookieRecords({
          cookieSources: [auth.cookieSource],
          cookieProfile: auth.cookieProfile,
          cookiesFile: undefined,
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
      if (await closeSession(session, environment)) {
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
  policy: {
    readonly allowRemoteActions: boolean;
    readonly targetOrigin: string;
    readonly fixtures?: readonly DerivationFixture[];
  },
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
  else if (action === "back" || action === "forward" || action === "reload" || action === "close") {
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
  else if (action === "cleartext") {
    if (command.length !== 2 || !isReference(command[1])) {
      throw new Error("derive browser cleartext requires one snapshot textbox reference");
    }
  }
  else if (action === "press") {
    if (command.length !== 2 || !/^[A-Za-z0-9+_-]{1,100}$/u.test(command[1] ?? "")) throw new Error("derive browser press key is invalid");
  }
  else if (action === "select") {
    if (command.length < 3 || command.length > 20 || !isReference(command[1]) || command.slice(2).some((value) => !safePlainArgument(value, 2_000))) {
      throw new Error("derive browser select requires a reference and bounded values");
    }
  }
  else if (action === "upload" || action === "upload-and-seal" || action === "choose-upload") {
    const references = command.slice(2);
    const available = new Set((policy.fixtures ?? []).map((fixture) => fixture.reference));
    if (
      command.length < 3
      || command.length > 22
      || (
        action === "choose-upload"
          ? !isReference(command[1])
          : !isReference(command[1])
            && command[1] !== singleFileInputReference
            && command[1] !== singleImageInputReference
            && command[1] !== singleVideoInputReference
      )
      || references.length !== new Set(references).size
      || references.some((reference) => !/^fixture:(?:[1-9]|1[0-9]|20)$/u.test(reference) || !available.has(reference))
    ) {
      throw new Error(
        action === "choose-upload"
          ? "derive browser choose-upload requires one snapshot upload-control reference and unique staged fixture:<n> references"
          : `derive browser ${action} requires a snapshot, @single-file-input, @single-image-input, or @single-video-input reference and unique staged fixture:<n> references`,
      );
    }
    if (
      command[1] === singleVideoInputReference
      && references.some((reference) =>
        policy.fixtures?.find((fixture) => fixture.reference === reference)?.mediaType !== "video/mp4")
    ) {
      throw new Error("derive browser @single-video-input accepts MP4 fixtures only");
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

export function derivationFixedUploadInputSelector(uploadTarget: string): string | null {
  return uploadTarget === singleFileInputReference
    ? singleFileInputSelector
    : uploadTarget === singleImageInputReference
      ? singleImageInputSelector
      : uploadTarget === singleVideoInputReference
        ? singleVideoInputSelector
        : null;
}

export function resolveDerivationFixedUploadInputTarget(
  uploadTarget: string,
  countData: unknown,
): string {
  const fixedInputSelector = derivationFixedUploadInputSelector(uploadTarget);
  if (fixedInputSelector === null) return uploadTarget;
  const count = typeof countData === "number"
    ? countData
    : typeof countData === "object"
        && countData !== null
        && !Array.isArray(countData)
        && Object.keys(countData).sort().join(",") === "count,lifecycle,selector"
        && typeof (countData as Record<string, unknown>).count === "number"
        && (countData as Record<string, unknown>).selector === fixedInputSelector
        && typeof (countData as Record<string, unknown>).lifecycle === "object"
        && (countData as Record<string, unknown>).lifecycle !== null
        && !Array.isArray((countData as Record<string, unknown>).lifecycle)
      ? (countData as Record<string, number>).count
      : null;
  if (!Number.isSafeInteger(count) || count !== 1) {
    const shape = Array.isArray(countData)
      ? "array"
      : typeof countData === "object" && countData !== null
        ? `object(${Object.keys(countData).sort().slice(0, 20).join(",")})`
        : typeof countData;
    throw new Error(`derive browser ${uploadTarget} requires exactly one matching file input on the current page${Number.isSafeInteger(count) ? `; found ${count}` : `; browser returned ${shape}`}`);
  }
  return fixedInputSelector;
}

export async function runDerivationBrowserCommand(
  id: string,
  command: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<unknown> {
  return withDerivationLifecycleGate(id, environment, async () => {
    const session = loadSession(id, environment);
    assertDerivationRecorderCommandAllowed(
      command,
      readReviewSeal(session, environment) !== null || hasCapturedHar(session, environment),
    );
    assertBrowserDerivationTargetAllowed(new URL(session.targetOrigin));
    validateDerivationBrowserCommand(session, command);
    if (command[0] === "close") {
      if (!await closeSession(session, environment)) throw new Error(`derivation ${id} could not be closed safely`);
      return { closed: true };
    }
    if (command[0] === "wait" && command.length === 2 && /^\d{1,5}$/u.test(command[1] ?? "")) {
      const waitedMs = Number(command[1]);
      await assertDerivationOrigin(session);
      await Bun.sleep(waitedMs);
      await assertDerivationOrigin(session);
      return { waitedMs };
    }
    const chooserUploadAction = command[0] === "choose-upload";
    const uploadAction = command[0] === "upload" || command[0] === "upload-and-seal" || chooserUploadAction;
    const requestedFixtures = uploadAction
      ? command.slice(2).map((reference) => {
          const fixture = session.fixtures.find((candidate) => candidate.reference === reference);
          if (fixture === undefined) throw new Error("derivation fixture reference is unavailable");
          return fixture;
        })
      : [];
    const fixturePaths = requestedFixtures.map((fixture) => {
      assertDerivationFixtureFile(session.directory, fixture);
      // The persistent browser daemon may outlive the short helper process
      // that launched it and therefore need not retain that helper's cwd.
      // Resolve only Wrench-owned, identity-verified staged files here; raw
      // caller paths remain outside the browser command grammar and errors
      // redact the private derivation directory below.
      return join(session.directory, fixture.fileName);
    });
    try {
      if (commandCanMutate(command)) await assertDerivationOrigin(session);
      if (command[0] === "cleartext") {
        const reference = command[1] ?? "";
        await batch(session, [["fill", reference, ""]]);
        await assertDerivationOrigin(session);
        return { cleared: reference };
      }
      if (chooserUploadAction) {
        const currentUrl = await currentDerivationUrl(session);
        if (currentUrl.origin !== session.targetOrigin) {
          throw new Error(`derivation left its target origin: ${currentUrl.origin}`);
        }
        const [cdpRecord] = await batch(session, [["get", "cdp-url"]]);
        const cdpData = cdpRecord === undefined ? null : browserResultData(cdpRecord);
        const cdpUrl = typeof cdpData === "object" && cdpData !== null && !Array.isArray(cdpData)
          ? localBrowserCdpUrl((cdpData as Record<string, unknown>).cdpUrl)
          : localBrowserCdpUrl(null);
        await uploadThroughInterceptedFileChooser({
          cdpUrl,
          click: async () => {
            await batch(session, [["click", command[1] ?? ""]]);
          },
          currentUrl: currentUrl.href,
          filePaths: fixturePaths,
        });
        await batch(session, [["wait", String(uploadSettlingDelayMs)]]);
        for (const fixture of requestedFixtures) assertDerivationFixtureFile(session.directory, fixture);
        await assertDerivationOrigin(session);
        return { attachedFiles: requestedFixtures.length };
      }
      let uploadTarget = command[1] ?? "";
      const fixedInputSelector = derivationFixedUploadInputSelector(uploadTarget);
      if (uploadAction && fixedInputSelector !== null) {
        const [countRecord] = await batch(session, [["get", "count", fixedInputSelector]]);
        const countData = countRecord === undefined ? null : browserResultData(countRecord);
        uploadTarget = resolveDerivationFixedUploadInputTarget(uploadTarget, countData);
      }
      const browserCommand = uploadAction
        ? ["upload", uploadTarget, ...fixturePaths]
        : command;
      if (command[0] === "upload-and-seal") {
        let records: readonly Record<string, unknown>[];
        try {
          records = await batch(session, [
            browserCommand,
            ["wait", String(uploadSettlingDelayMs)],
            ["network", "har", "stop", "capture.har"],
          ]);
        } catch {
          for (const fixture of requestedFixtures) assertDerivationFixtureFile(session.directory, fixture);
          throw new Error("managed browser could not upload and seal the staged derivation fixture");
        }
        for (const fixture of requestedFixtures) assertDerivationFixtureFile(session.directory, fixture);
        if (!hasCapturedHar(session, environment)) {
          throw new Error("managed browser upload completed without a sealed derivation recorder");
        }
        const uploadRecord = records[0];
        return {
          upload: uploadRecord === undefined ? null : browserResultData(uploadRecord),
          recorder: "sealed",
        };
      }
      let record: Record<string, unknown> | undefined;
      try {
        // Keep the pinned browser batch alive while page code consumes the
        // selected File and settles its first-party upload. Ending the batch
        // immediately after setInputFiles can abort a deferred request even
        // though the page already rendered a local blob preview.
        const records = await batch(
          session,
          uploadAction
            ? [browserCommand, ["wait", String(uploadSettlingDelayMs)]]
            : [browserCommand],
        );
        [record] = records;
      } catch (error) {
        for (const fixture of requestedFixtures) assertDerivationFixtureFile(session.directory, fixture);
        if (uploadAction) {
          let detail = error instanceof Error ? error.message : "";
          detail = detail.replaceAll(session.directory, "<private-derivation>");
          for (const fixture of requestedFixtures) {
            detail = detail
              .replaceAll(`./${fixture.fileName}`, fixture.reference)
              .replaceAll(fixture.fileName, fixture.reference);
          }
          if (
            detail.length < 1
            || detail.length > 1_000
            || /[\u0000-\u001f\u007f]/u.test(detail)
            || detail.includes("/Users/")
            || detail.includes("/private/")
            || detail.includes("/tmp/")
            || detail.includes("\\")
          ) detail = "";
          throw new Error(`managed browser could not upload the staged derivation fixture${detail === "" ? "" : `: ${detail}`}`);
        }
        throw error;
      }
      for (const fixture of requestedFixtures) assertDerivationFixtureFile(session.directory, fixture);
      await assertDerivationOrigin(session);
      const data = record === undefined ? null : browserResultData(record);
      return command[0] === "network" ? sanitizeDerivationNetworkResult(data) : data;
    } catch (error) {
      if (error instanceof Error && error.message.includes("left its target origin")) {
        if (!await closeSession(session, environment)) {
          throw new Error(`derivation ${id} left its target origin and could not be closed; its private session was preserved`, { cause: error });
        }
        removeSessionTrees(session, environment);
      }
      throw error;
    }
  });
}

export function assertDerivationRecorderCommandAllowed(
  command: readonly string[],
  sealed: boolean,
): void {
  if (sealed && command[0] !== "close") {
    throw new Error("derivation recorder is sealed for private review; only review, finish, discard, or close is allowed");
  }
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
      if (!await closeSession(session, environment)) {
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
      if (!await closeSession(session, environment)) {
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
        const owner = await closeInterruptedDerivationNetworkBoundary({
          derivationId: initialization.derivationId,
          directory: derivationDirectory(initialization.derivationId, environment),
          directoryIdentity: initialization.directoryIdentity,
          socketDirectory: initialization.socketDirectory,
          socketIdentity: initialization.socketIdentity,
        });
        removeInterruptedSessionTrees(initialization, environment, owner);
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
        && !await closeSession(session, environment)
        && inspectInitializationSocket(initialization)
      ) {
        throw new Error(`derivation ${id} could not be closed; its interrupted private session was preserved`);
      }
      if (!await closeSessionNetworkBoundary(session)) {
        throw new Error(`derivation ${id} network boundary could not be closed; its interrupted private session was preserved`);
      }
      removeInterruptedSessionTrees(initialization, environment, sessionNetworkOwner(session));
      return true;
    }
    if (loaded.socketAvailable) {
      if (!await closeSession(session, environment)) {
        if (inspectSessionSocket(session, "allow-missing")) {
          throw new Error(`derivation ${id} could not be closed; its private session was preserved`);
        }
        // Recheck the exact ephemeral boundary immediately before terminal
        // cleanup. A replacement directory remains fatal; a live boundary that
        // reappeared preserves the state for an ordinary close.
        if (inspectSessionSocket(session, "allow-missing")) {
          throw new Error(`derivation ${id} socket directory reappeared; its private session was preserved`);
        }
        if (!await closeSessionNetworkBoundary(session)) {
          throw new Error(`derivation ${id} network boundary could not be closed; its private session was preserved`);
        }
        removeSessionStateWithoutSocket(session, environment);
        return true;
      }
      removeSessionTrees(session, environment);
    } else {
      if (inspectSessionSocket(session, "allow-missing")) {
        throw new Error(`derivation ${id} socket directory reappeared; its private session was preserved`);
      }
      if (!await closeSessionNetworkBoundary(session)) {
        throw new Error(`derivation ${id} network boundary could not be closed; its private session was preserved`);
      }
      removeSessionStateWithoutSocket(session, environment);
    }
    return true;
  });
}
