import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { types as nodeTypes } from "node:util";

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
import { localBrowserCdpUrl } from "./derivation-file-chooser";
import { DOM_ACTION_TRANSPORT_DISABLED_MESSAGE } from "./transport-policy";
import {
  captureProcessOwnerIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
  type ProcessOwnerStatus,
} from "./process-identity";

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
  /** Internal seam for deterministic cleanup quiescence and deletion reproof. */
  readonly cleanupLifecycle: AgentBrowserLifecycleDependencies;
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
   * The durable registrar reconciles an ambiguous commit before returning.
   * Any other throw is still treated as potentially committed, so Wrench
   * preserves the roots instead of destroying recovery evidence.
   */
  readonly publishCleanupResource?: ((
    resource: BrowserCleanupResourceIdentity,
  ) => void) & {
    /** Durably records that the closed browser and its private roots are idle. */
    readonly markBrowserCleanupQuiescent?: (
      resource: BrowserCleanupResourceIdentity,
    ) => void;
    /** Journals one exact root only after its identity-bound removal succeeds. */
    readonly markBrowserCleanupRootRemoved?: (
      resource: BrowserCleanupResourceIdentity,
      root: BrowserCleanupResourceRoot,
    ) => void;
  };
  readonly dependencies?: Partial<BrowserSessionDependencies>;
};

export type BrowserPrivateDirectoryIdentityV1 = {
  readonly device: string;
  readonly inode: string;
};

/** Legacy public name retained for v1 claim parsing compatibility. */
export type BrowserPrivateDirectoryIdentity =
  BrowserPrivateDirectoryIdentityV1;

export type BrowserPrivateDirectoryIdentityV2 =
  BrowserPrivateDirectoryIdentityV1 & {
    readonly birthtimeNs: string;
    /** Decimal POSIX permission bits. V2 admits only 0700 (`448`). */
    readonly mode: "448";
    readonly uid: string;
  };

export type AgentBrowserControlWitnessV1 = {
  readonly kind: "agent-browser-control-v1";
  readonly version: "0.32.3";
  readonly session: string;
  readonly socketDirectory: string;
  readonly daemonOwner: ProcessOwnerIdentity;
  readonly engine: "chrome";
  readonly launchHash: string;
  readonly cdpUrl: string;
};

export type BrowserCleanupResourceIdentityV1 = {
  readonly kind: "agent-browser-session-v1";
  readonly recoveryHandle: string;
  readonly session: string;
  readonly socketDirectory: string;
  readonly socketDirectoryIdentity: BrowserPrivateDirectoryIdentityV1;
  readonly artifactsDirectory: string;
  readonly artifactsDirectoryIdentity: BrowserPrivateDirectoryIdentityV1;
};

type BrowserCleanupResourceIdentityV2Base = {
  readonly kind: "agent-browser-session-v2";
  readonly recoveryHandle: string;
  readonly session: string;
  readonly socketDirectory: string;
  readonly socketDirectoryIdentity: BrowserPrivateDirectoryIdentityV2;
  readonly artifactsDirectory: string;
  readonly artifactsDirectoryIdentity: BrowserPrivateDirectoryIdentityV2;
};

/**
 * Durable browser cleanup progression. Prepared roots have no launch intent,
 * launch-intent is persisted immediately before launch, and controlled binds
 * one immutable daemon/browser/CDP witness. Progression is strictly monotonic.
 */
export type BrowserCleanupResourceIdentityV2 =
  BrowserCleanupResourceIdentityV2Base & (
    | {
        readonly phase: "prepared";
        readonly control: null;
      }
    | {
        readonly phase: "launch-intent";
        readonly control: null;
      }
    | {
        readonly phase: "controlled";
        readonly control: AgentBrowserControlWitnessV1;
      }
  );

export type BrowserCleanupResourceIdentity =
  | BrowserCleanupResourceIdentityV1
  | BrowserCleanupResourceIdentityV2;

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

const browserIdentityDecimalPattern = /^(?:0|[1-9][0-9]{0,39})$/u;
const processIdentityDigestPattern = /^[a-f0-9]{64}$/u;
const agentBrowserLaunchHashPattern = /^(?:0|[1-9][0-9]{0,19})$/u;
const maximumAgentBrowserControlLaunchHash = (1n << 64n) - 1n;

function browserIdentityRecord(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) throw new Error(`${label} is malformed`);
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} is malformed`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: JsonRecord = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error(`${label} is malformed`);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
      || /[\u0000-\u001f\u007f-\u009f]/u.test(key)
    ) throw new Error(`${label} is malformed`);
    output[key] = descriptor.value as unknown;
  }
  return output;
}

function browserIdentityExactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) throw new Error(`${label} is malformed`);
}

function browserIdentityDecimal(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !browserIdentityDecimalPattern.test(value)
  ) throw new Error(`${label} is malformed`);
  return value;
}

function parseBrowserPrivateDirectoryIdentityV1(
  value: unknown,
  label: string,
): BrowserPrivateDirectoryIdentityV1 {
  const identity = browserIdentityRecord(value, label);
  browserIdentityExactKeys(identity, ["device", "inode"], label);
  return Object.freeze({
    device: browserIdentityDecimal(identity.device, `${label} device`),
    inode: browserIdentityDecimal(identity.inode, `${label} inode`),
  });
}

function parseBrowserPrivateDirectoryIdentityV2(
  value: unknown,
  label: string,
): BrowserPrivateDirectoryIdentityV2 {
  const identity = browserIdentityRecord(value, label);
  browserIdentityExactKeys(
    identity,
    ["birthtimeNs", "device", "inode", "mode", "uid"],
    label,
  );
  const birthtimeNs = browserIdentityDecimal(
    identity.birthtimeNs,
    `${label} birth time`,
  );
  if (birthtimeNs === "0" || identity.mode !== "448") {
    throw new Error(`${label} is malformed`);
  }
  return Object.freeze({
    device: browserIdentityDecimal(identity.device, `${label} device`),
    inode: browserIdentityDecimal(identity.inode, `${label} inode`),
    birthtimeNs,
    mode: "448",
    uid: browserIdentityDecimal(identity.uid, `${label} owner`),
  });
}

function parseBrowserProcessOwner(value: unknown): ProcessOwnerIdentity {
  const owner = browserIdentityRecord(value, "browser cleanup daemon owner");
  browserIdentityExactKeys(
    owner,
    ["bootId", "pid", "processStartId"],
    "browser cleanup daemon owner",
  );
  if (
    typeof owner.pid !== "number"
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
    || typeof owner.bootId !== "string"
    || !processIdentityDigestPattern.test(owner.bootId)
    || typeof owner.processStartId !== "string"
    || !processIdentityDigestPattern.test(owner.processStartId)
  ) throw new Error("browser cleanup daemon owner is malformed");
  return Object.freeze({
    pid: owner.pid,
    bootId: owner.bootId,
    processStartId: owner.processStartId,
  });
}

function canonicalAgentBrowserLaunchHash(value: unknown): string {
  if (
    typeof value !== "string"
    || !agentBrowserLaunchHashPattern.test(value)
    || BigInt(value) > maximumAgentBrowserControlLaunchHash
  ) throw new Error("browser cleanup launch identity is malformed");
  return value;
}

function literalLoopbackAgentBrowserCdpUrl(value: unknown): string {
  let cdpUrl: string;
  try {
    cdpUrl = localBrowserCdpUrl(value);
  } catch {
    throw new Error("browser cleanup control witness is malformed");
  }
  const hostname = new URL(cdpUrl).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "[::1]") {
    throw new Error("browser cleanup control witness is malformed");
  }
  return cdpUrl;
}

function parseAgentBrowserControlWitness(
  value: unknown,
): AgentBrowserControlWitnessV1 {
  const control = browserIdentityRecord(
    value,
    "browser cleanup control witness",
  );
  browserIdentityExactKeys(control, [
    "cdpUrl",
    "daemonOwner",
    "engine",
    "kind",
    "launchHash",
    "session",
    "socketDirectory",
    "version",
  ], "browser cleanup control witness");
  if (
    control.kind !== "agent-browser-control-v1"
    || control.version !== "0.32.3"
    || typeof control.session !== "string"
    || !browserSessionPattern.test(control.session)
    || typeof control.socketDirectory !== "string"
    || control.engine !== "chrome"
    || typeof control.cdpUrl !== "string"
  ) throw new Error("browser cleanup control witness is malformed");
  const cdpUrl = literalLoopbackAgentBrowserCdpUrl(control.cdpUrl);
  if (cdpUrl !== control.cdpUrl) {
    throw new Error("browser cleanup control witness is malformed");
  }
  return Object.freeze({
    kind: "agent-browser-control-v1",
    version: "0.32.3",
    session: control.session,
    socketDirectory: canonicalAbsolutePath(
      control.socketDirectory,
      "control socket directory",
    ),
    daemonOwner: parseBrowserProcessOwner(control.daemonOwner),
    engine: "chrome",
    launchHash: canonicalAgentBrowserLaunchHash(control.launchHash),
    cdpUrl,
  });
}

function browserCleanupResourceBase(value: JsonRecord): {
  readonly recoveryHandle: string;
  readonly session: string;
  readonly socketDirectory: string;
  readonly artifactsDirectory: string;
} {
  if (
    typeof value.recoveryHandle !== "string"
    || typeof value.session !== "string"
    || typeof value.socketDirectory !== "string"
    || typeof value.artifactsDirectory !== "string"
  ) throw new Error("browser cleanup resource identity is malformed");
  const recovery = parseBrowserRecoveryHandle(value.recoveryHandle);
  if (
    recovery.session !== value.session
    || recovery.socketDirectory !== value.socketDirectory
    || recovery.artifactsDirectory !== value.artifactsDirectory
  ) throw new Error("browser cleanup resource does not match its recovery handle");
  return {
    recoveryHandle: value.recoveryHandle,
    session: recovery.session,
    socketDirectory: recovery.socketDirectory,
    artifactsDirectory: recovery.artifactsDirectory,
  };
}

export function parseBrowserCleanupResourceIdentity(
  value: unknown,
): BrowserCleanupResourceIdentity {
  const identity = browserIdentityRecord(
    value,
    "browser cleanup resource identity",
  );
  const commonKeys = [
    "artifactsDirectory",
    "artifactsDirectoryIdentity",
    "kind",
    "recoveryHandle",
    "session",
    "socketDirectory",
    "socketDirectoryIdentity",
  ] as const;
  if (identity.kind === "agent-browser-session-v1") {
    browserIdentityExactKeys(identity, commonKeys, "browser cleanup resource identity");
    const base = browserCleanupResourceBase(identity);
    return Object.freeze({
      kind: "agent-browser-session-v1",
      ...base,
      socketDirectoryIdentity: parseBrowserPrivateDirectoryIdentityV1(
        identity.socketDirectoryIdentity,
        "browser cleanup socket identity",
      ),
      artifactsDirectoryIdentity: parseBrowserPrivateDirectoryIdentityV1(
        identity.artifactsDirectoryIdentity,
        "browser cleanup artifacts identity",
      ),
    });
  }
  if (identity.kind !== "agent-browser-session-v2") {
    throw new Error("browser cleanup resource identity kind is unsupported");
  }
  browserIdentityExactKeys(
    identity,
    [...commonKeys, "control", "phase"],
    "browser cleanup resource identity",
  );
  const base = browserCleanupResourceBase(identity);
  const roots = Object.freeze({
    kind: "agent-browser-session-v2",
    ...base,
    socketDirectoryIdentity: parseBrowserPrivateDirectoryIdentityV2(
      identity.socketDirectoryIdentity,
      "browser cleanup socket identity",
    ),
    artifactsDirectoryIdentity: parseBrowserPrivateDirectoryIdentityV2(
      identity.artifactsDirectoryIdentity,
      "browser cleanup artifacts identity",
    ),
  });
  if (identity.phase === "prepared" || identity.phase === "launch-intent") {
    if (identity.control !== null) {
      throw new Error("browser cleanup phase and control witness are inconsistent");
    }
    return Object.freeze({
      ...roots,
      phase: identity.phase,
      control: null,
    });
  }
  if (identity.phase !== "controlled" || identity.control === null) {
    throw new Error("browser cleanup phase is malformed");
  }
  const control = parseAgentBrowserControlWitness(identity.control);
  if (
    control.session !== base.session
    || control.socketDirectory !== base.socketDirectory
  ) throw new Error("browser cleanup control witness changed resource identity");
  return Object.freeze({
    ...roots,
    phase: "controlled",
    control,
  });
}

function privateBrowserDirectoryIdentityV2(
  path: string,
): BrowserPrivateDirectoryIdentityV2 {
  const stats = lstatSync(path, { bigint: true });
  const currentUid = process.getuid?.();
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || currentUid === undefined
    || stats.uid !== BigInt(currentUid)
    || (stats.mode & 0o777n) !== 0o700n
    || stats.birthtimeNs <= 0n
  ) {
    throw new Error("browser cleanup resource is not a recoverable private directory");
  }
  return Object.freeze({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
    mode: "448",
    uid: stats.uid.toString(),
  });
}

function sameBrowserIdentity(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBrowserCleanupResourceBase(
  left: BrowserCleanupResourceIdentity,
  right: BrowserCleanupResourceIdentity,
): boolean {
  return left.recoveryHandle === right.recoveryHandle
    && left.session === right.session
    && left.socketDirectory === right.socketDirectory
    && left.artifactsDirectory === right.artifactsDirectory;
}

/** True only for equality or one strictly stronger, immutable browser pin. */
export function browserCleanupResourceExtends(
  current: BrowserCleanupResourceIdentity,
  next: BrowserCleanupResourceIdentity,
): boolean {
  const left = parseBrowserCleanupResourceIdentity(current);
  const right = parseBrowserCleanupResourceIdentity(next);
  if (!sameBrowserCleanupResourceBase(left, right)) return false;
  if (left.kind === "agent-browser-session-v1") {
    if (right.kind === "agent-browser-session-v1") {
      return sameBrowserIdentity(left, right);
    }
    const matchesLegacyRoots = right.control !== null
      && left.socketDirectoryIdentity.device
        === right.socketDirectoryIdentity.device
      && left.socketDirectoryIdentity.inode
        === right.socketDirectoryIdentity.inode
      && left.artifactsDirectoryIdentity.device
        === right.artifactsDirectoryIdentity.device
      && left.artifactsDirectoryIdentity.inode
        === right.artifactsDirectoryIdentity.inode;
    if (!matchesLegacyRoots) return false;
    try {
      assertBrowserCleanupResourceRootsMatch(right);
      return true;
    } catch {
      return false;
    }
  }
  if (
    right.kind !== "agent-browser-session-v2"
    || !sameBrowserIdentity(
      left.socketDirectoryIdentity,
      right.socketDirectoryIdentity,
    )
    || !sameBrowserIdentity(
      left.artifactsDirectoryIdentity,
      right.artifactsDirectoryIdentity,
    )
  ) return false;
  if (left.phase === "prepared") {
    return right.phase === "prepared" || right.phase === "launch-intent";
  }
  if (left.phase === "launch-intent") {
    return right.phase === "launch-intent" || right.phase === "controlled";
  }
  return right.phase === "controlled"
    && sameBrowserIdentity(left.control, right.control);
}

export type BrowserCleanupResourceRoot = "socket" | "artifacts";
export type BrowserCleanupResourceRootStatus = "match" | "absent" | "conflict";

/** Classify one exact private root without treating a replacement as absent. */
export function browserCleanupResourceRootStatus(
  value: BrowserCleanupResourceIdentityV2,
  root: BrowserCleanupResourceRoot,
): BrowserCleanupResourceRootStatus {
  const resource = parseBrowserCleanupResourceIdentity(value);
  if (resource.kind !== "agent-browser-session-v2") {
    throw new Error("browser cleanup resource does not have recoverable roots");
  }
  const path = root === "socket"
    ? resource.socketDirectory
    : resource.artifactsDirectory;
  const expected = root === "socket"
    ? resource.socketDirectoryIdentity
    : resource.artifactsDirectoryIdentity;
  let actual: BrowserPrivateDirectoryIdentityV2;
  try {
    actual = privateBrowserDirectoryIdentityV2(path);
  } catch (error) {
    return (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) ? "absent" : "conflict";
  }
  return sameBrowserIdentity(actual, expected) ? "match" : "conflict";
}

export function assertBrowserCleanupResourceRootsMatch(
  value: BrowserCleanupResourceIdentityV2,
): void {
  const resource = parseBrowserCleanupResourceIdentity(value);
  if (resource.kind !== "agent-browser-session-v2") {
    throw new Error("browser cleanup resource does not have recoverable roots");
  }
  if (
    browserCleanupResourceRootStatus(resource, "socket") !== "match"
    || browserCleanupResourceRootStatus(resource, "artifacts") !== "match"
  ) throw new Error("browser cleanup private root identity changed");
}

function browserCleanupResourceIdentity(input: {
  readonly recoveryHandle: string;
  readonly session: string;
  readonly socketDirectory: string;
  readonly artifactsDirectory: string;
}): BrowserCleanupResourceIdentityV2 {
  const parsed = parseBrowserRecoveryHandle(input.recoveryHandle);
  if (
    parsed.session !== input.session
    || parsed.socketDirectory !== input.socketDirectory
    || parsed.artifactsDirectory !== input.artifactsDirectory
  ) {
    throw new Error("browser cleanup resource does not match its recovery handle");
  }
  return parseBrowserCleanupResourceIdentity({
    kind: "agent-browser-session-v2",
    recoveryHandle: input.recoveryHandle,
    session: parsed.session,
    socketDirectory: parsed.socketDirectory,
    socketDirectoryIdentity: privateBrowserDirectoryIdentityV2(
      parsed.socketDirectory,
    ),
    artifactsDirectory: parsed.artifactsDirectory,
    artifactsDirectoryIdentity: privateBrowserDirectoryIdentityV2(
      parsed.artifactsDirectory,
    ),
    phase: "prepared",
    control: null,
  }) as BrowserCleanupResourceIdentityV2;
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

export const ownedChromeOnboardingArguments = Object.freeze([
  "--no-first-run",
  "--no-default-browser-check",
] as const);

const reviewedOwnedChromeArguments = new Set([
  "--profile-directory=Default",
  "--disable-quic",
  "--disable-dns-prefetch",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-features=AsyncDns",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--proxy-bypass-list=<-loopback>",
]);

/**
 * Build one pinned --args value for a Wrench-owned fresh or cloned Chrome.
 * Callers supply only code-owned arguments; Wrench never accepts raw launch
 * arguments from manifests, operation input, auth locators, or the CLI.
 */
export function ownedChromeLaunchArguments(
  additional: readonly string[] = [],
): string {
  if (
    additional.some((argument) =>
      !reviewedOwnedChromeArguments.has(argument)
      || /[\0\r\n,]/u.test(argument))
  ) {
    throw new Error("owned Chrome launch arguments are not reviewed");
  }
  return [...new Set([
    ...additional,
    ...ownedChromeOnboardingArguments,
  ])].join("\n");
}

export function ownedBrowserProxyArguments(
  proxyUrl: string,
  profileDirectory?: "Default",
): readonly string[] {
  const generated = browserProxyArguments(proxyUrl, profileDirectory);
  if (
    generated.length !== 4
    || generated[0] !== "--proxy"
    || generated[1] !== proxyUrl
    || generated[2] !== "--args"
    || typeof generated[3] !== "string"
  ) {
    throw new Error("pinned browser proxy arguments are malformed");
  }
  return Object.freeze([
    "--proxy",
    proxyUrl,
    "--args",
    ownedChromeLaunchArguments(generated[3].split("\n")),
  ]);
}

/**
 * Add the one Wrench-owned MV3 guard to the already reviewed proxy launch.
 * The path is derived from a private derivation root; caller-selected Chrome
 * arguments remain impossible.
 */
export function ownedDerivationGuardBrowserArguments(
  proxyUrl: string,
  extensionDirectory: string,
): readonly string[] {
  if (
    !isAbsolute(extensionDirectory)
    || basename(extensionDirectory) !== "network-guard-extension"
    || /[\0\r\n,]/u.test(extensionDirectory)
  ) throw new Error("owned derivation guard extension path is invalid");
  const base = ownedBrowserProxyArguments(proxyUrl);
  if (base.length !== 4 || base[0] !== "--proxy" || base[2] !== "--args") {
    throw new Error("owned derivation proxy arguments changed shape");
  }
  const chromeArguments = base[3];
  if (typeof chromeArguments !== "string") {
    throw new Error("owned derivation proxy arguments changed shape");
  }
  return Object.freeze([
    base[0],
    base[1] as string,
    base[2],
    [
      chromeArguments,
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ].join("\n"),
  ]);
}

export function isolatedEnvironment(
  socketDirectory: string,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnvironment)) {
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

const maximumAgentBrowserLaunchHash = (1n << 64n) - 1n;
const maximumAgentBrowserJsonNesting = 256;

class AgentBrowserLaunchHashParseError extends Error {}

type JsonTextReplacement = {
  readonly start: number;
  readonly end: number;
  readonly value: string;
};

/**
 * Rewrites only object values whose decoded key is exactly `launchHash`.
 * The surrounding JSON is parsed normally after every u64 token has become
 * a quoted canonical decimal string, avoiding JavaScript Number rounding.
 */
class AgentBrowserLaunchHashRewriter {
  readonly #input: string;
  readonly #replacements: JsonTextReplacement[] = [];
  #index = 0;

  constructor(input: string) {
    this.#input = input;
  }

  rewrite(): string {
    this.#parseValue(false, 0);
    this.#skipWhitespace();
    if (this.#index !== this.#input.length) {
      throw new AgentBrowserLaunchHashParseError("agent-browser JSON is malformed");
    }
    let rewritten = this.#input;
    for (const replacement of this.#replacements.toReversed()) {
      rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
    }
    return rewritten;
  }

  #parseValue(launchHash: boolean, depth: number): void {
    this.#skipWhitespace();
    if (launchHash) {
      if (this.#input.startsWith("null", this.#index)) {
        this.#parseLiteral("null");
        return;
      }
      this.#parseLaunchHash();
      return;
    }
    const token = this.#input[this.#index];
    if (token === "{") {
      this.#parseObject(depth + 1);
      return;
    }
    if (token === "[") {
      this.#parseArray(depth + 1);
      return;
    }
    if (token === '"') {
      this.#parseString();
      return;
    }
    if (token === "t") {
      this.#parseLiteral("true");
      return;
    }
    if (token === "f") {
      this.#parseLiteral("false");
      return;
    }
    if (token === "n") {
      this.#parseLiteral("null");
      return;
    }
    this.#parseNumber();
  }

  #parseObject(depth: number): void {
    this.#assertNesting(depth);
    let sawLaunchHash = false;
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#input[this.#index] === "}") {
      this.#index += 1;
      return;
    }
    for (;;) {
      this.#skipWhitespace();
      const key = this.#parseString();
      if (key === "launchHash") {
        if (sawLaunchHash) {
          throw new AgentBrowserLaunchHashParseError(
            "agent-browser JSON contains a duplicate launchHash field",
          );
        }
        sawLaunchHash = true;
      }
      this.#skipWhitespace();
      if (this.#input[this.#index] !== ":") {
        throw new AgentBrowserLaunchHashParseError("agent-browser JSON is malformed");
      }
      this.#index += 1;
      this.#parseValue(key === "launchHash", depth);
      this.#skipWhitespace();
      const separator = this.#input[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return;
      }
      if (separator !== ",") {
        throw new AgentBrowserLaunchHashParseError("agent-browser JSON is malformed");
      }
      this.#index += 1;
    }
  }

  #parseArray(depth: number): void {
    this.#assertNesting(depth);
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#input[this.#index] === "]") {
      this.#index += 1;
      return;
    }
    for (;;) {
      this.#parseValue(false, depth);
      this.#skipWhitespace();
      const separator = this.#input[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return;
      }
      if (separator !== ",") {
        throw new AgentBrowserLaunchHashParseError("agent-browser JSON is malformed");
      }
      this.#index += 1;
    }
  }

  #parseString(): string {
    const start = this.#index;
    if (this.#input[this.#index] !== '"') {
      throw new AgentBrowserLaunchHashParseError("agent-browser JSON is malformed");
    }
    this.#index += 1;
    for (;;) {
      const token = this.#input[this.#index];
      if (token === undefined) {
        throw new AgentBrowserLaunchHashParseError("agent-browser JSON is malformed");
      }
      if (token === '"') {
        this.#index += 1;
        return JSON.parse(this.#input.slice(start, this.#index)) as string;
      }
      if (token === "\\") {
        this.#index += 2;
      } else {
        this.#index += 1;
      }
    }
  }

  #parseLiteral(literal: "true" | "false" | "null"): void {
    if (!this.#input.startsWith(literal, this.#index)) {
      throw new AgentBrowserLaunchHashParseError("agent-browser JSON is malformed");
    }
    this.#index += literal.length;
  }

  #parseNumber(): void {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.#input.slice(this.#index),
    );
    if (match === null) {
      throw new AgentBrowserLaunchHashParseError("agent-browser JSON is malformed");
    }
    this.#index += match[0].length;
  }

  #parseLaunchHash(): void {
    const start = this.#index;
    const match = /^(?:0|[1-9][0-9]*)/u.exec(this.#input.slice(start));
    if (match === null) {
      throw new AgentBrowserLaunchHashParseError(
        "agent-browser launchHash is not an unsigned 64-bit integer",
      );
    }
    const value = match[0];
    this.#index += value.length;
    const following = this.#input[this.#index];
    if (
      following !== undefined
      && following !== ","
      && following !== "}"
      && following !== "]"
      && following !== " "
      && following !== "\t"
      && following !== "\r"
      && following !== "\n"
    ) {
      throw new AgentBrowserLaunchHashParseError(
        "agent-browser launchHash is not an unsigned 64-bit integer",
      );
    }
    if (BigInt(value) > maximumAgentBrowserLaunchHash) {
      throw new AgentBrowserLaunchHashParseError(
        "agent-browser launchHash exceeds an unsigned 64-bit integer",
      );
    }
    this.#replacements.push({
      start,
      end: this.#index,
      value: JSON.stringify(value),
    });
  }

  #skipWhitespace(): void {
    while (
      this.#input[this.#index] === " "
      || this.#input[this.#index] === "\t"
      || this.#input[this.#index] === "\r"
      || this.#input[this.#index] === "\n"
    ) this.#index += 1;
  }

  #assertNesting(depth: number): void {
    if (depth > maximumAgentBrowserJsonNesting) {
      throw new AgentBrowserLaunchHashParseError(
        "agent-browser JSON exceeds its nesting bound",
      );
    }
  }
}

/**
 * Parse the last valid JSON output line without rounding agent-browser's u64
 * launch identities. Every object field decoded as `launchHash` is returned
 * as its exact canonical decimal string, while a disconnected browser's
 * `launchHash: null` remains null; every other JSON value is unchanged.
 */
export function parseLastJsonWithExactLaunchHashes(output: string): unknown {
  let lineEnd = output.length;
  while (lineEnd >= 0) {
    const newline = output.lastIndexOf("\n", lineEnd - 1);
    const line = output.slice(newline + 1, lineEnd).trim();
    lineEnd = newline;
    if (line.startsWith("[") || line.startsWith("{")) {
      try {
        JSON.parse(line);
      } catch {
        // Continue past diagnostics emitted before the JSON result.
        continue;
      }
      const rewritten = new AgentBrowserLaunchHashRewriter(line).rewrite();
      return JSON.parse(rewritten) as unknown;
    }
  }
  throw new Error("agent-browser did not return JSON");
}

type AgentBrowserSessionStateBase = {
  readonly state: "active";
  readonly pid: number;
};

type LaunchedAgentBrowserSessionState = AgentBrowserSessionStateBase & {
  readonly browserLaunched: true;
  readonly engine: "chrome";
  readonly launchHash: string;
};

type ClosedAgentBrowserDaemonState = AgentBrowserSessionStateBase & {
  readonly browserLaunched: false;
  readonly engine: "chrome";
  readonly launchHash: null;
};

type ActiveAgentBrowserSessionState =
  | LaunchedAgentBrowserSessionState
  | ClosedAgentBrowserDaemonState;

type InactiveAgentBrowserSessionState = {
  readonly state: "inactive";
};

type AgentBrowserSessionState =
  | ActiveAgentBrowserSessionState
  | InactiveAgentBrowserSessionState;

type AgentBrowserLifecycleRunCommand = (
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal?: AbortSignal;
  },
) => Promise<CommandResult>;

export type AgentBrowserLifecycleDependencies = {
  readonly runCommand?: AgentBrowserLifecycleRunCommand;
  readonly captureOwner?: (pid: number) => ProcessOwnerIdentity;
  readonly ownerStatus?: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus;
  readonly terminateOwner?: (owner: ProcessOwnerIdentity) => void;
  readonly cdpEndpointStatus?: (
    cdpUrl: string,
  ) => Promise<"available" | "unavailable" | "indeterminate">;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  /** Active-session setup only: borrow the kernel-owned cancellation signal. */
  readonly commandSignal?: AbortSignal;
  /** Recomputed before each setup command so no subcommand resets the budget. */
  readonly commandTimeoutMs?: () => number;
};

function boundedAgentBrowserText(value: unknown): boolean {
  return value === null
    || (
      typeof value === "string"
      && value.length <= 64 * 1024
      && !/[\0\r\n]/u.test(value)
    );
}

function parseAgentBrowserEffectiveLaunch(
  value: unknown,
  label: string,
):
  | {
      readonly browserLaunched: true;
      readonly engine: "chrome";
      readonly launchHash: string;
    }
  | {
      readonly browserLaunched: false;
      readonly engine: "chrome";
      readonly launchHash: null;
    } {
  const launch = browserIdentityRecord(value, label);
  browserIdentityExactKeys(
    launch,
    ["browserLaunched", "engine", "launchHash"],
    label,
  );
  if (launch.engine !== "chrome") {
    throw new Error("agent-browser control identity changed");
  }
  if (launch.browserLaunched === false) {
    if (launch.launchHash !== null) {
      throw new Error("agent-browser control identity changed");
    }
    return Object.freeze({
      browserLaunched: false,
      engine: "chrome",
      launchHash: null,
    });
  }
  if (launch.browserLaunched !== true) {
    throw new Error("agent-browser control identity changed");
  }
  return Object.freeze({
    browserLaunched: true,
    engine: "chrome",
    launchHash: canonicalAgentBrowserLaunchHash(launch.launchHash),
  });
}

function parseAgentBrowserLifecycle(
  value: unknown,
  requireNonMutatingCdpSemantics = false,
): ReturnType<typeof parseAgentBrowserEffectiveLaunch> {
  const lifecycle = browserIdentityRecord(
    value,
    "agent-browser lifecycle",
  );
  browserIdentityExactKeys(lifecycle, [
    "effectiveLaunch",
    "launched",
    "relaunchedBrowser",
    "restartedBackground",
    "restoreStatus",
    "reused",
    "saveStatus",
  ], "agent-browser lifecycle");
  if (
    typeof lifecycle.launched !== "boolean"
    || typeof lifecycle.relaunchedBrowser !== "boolean"
    || typeof lifecycle.restartedBackground !== "boolean"
    || typeof lifecycle.reused !== "boolean"
    || typeof lifecycle.restoreStatus !== "string"
    || lifecycle.restoreStatus.length < 1
    || lifecycle.restoreStatus.length > 256
    || typeof lifecycle.saveStatus !== "string"
    || lifecycle.saveStatus.length < 1
    || lifecycle.saveStatus.length > 256
    || (
      requireNonMutatingCdpSemantics
      && (
        lifecycle.launched !== false
        || lifecycle.relaunchedBrowser !== false
        || lifecycle.restartedBackground !== false
        || lifecycle.reused !== true
        || lifecycle.restoreStatus !== "not_configured"
        || lifecycle.saveStatus !== "not_attempted"
      )
    )
  ) throw new Error("agent-browser lifecycle changed shape");
  return parseAgentBrowserEffectiveLaunch(
    lifecycle.effectiveLaunch,
    "agent-browser lifecycle launch",
  );
}

function parseAgentBrowserSessionState(
  value: unknown,
  resource: BrowserCleanupResourceIdentity,
): AgentBrowserSessionState {
  const root = browserIdentityRecord(value, "agent-browser session result");
  browserIdentityExactKeys(root, ["data", "success"], "agent-browser session result");
  const data = browserIdentityRecord(root.data, "agent-browser session data");
  browserIdentityExactKeys(data, [
    "active",
    "namespace",
    "pid",
    "runtime",
    "runtimeError",
    "session",
    "socketDir",
    "version",
  ], "agent-browser session data");
  if (
    root.success !== true
    || data.namespace !== null
    || data.runtimeError !== null
    || data.session !== resource.session
    || data.socketDir !== resource.socketDirectory
  ) throw new Error("agent-browser session identity changed");
  if (data.active === false) {
    if (
      data.pid !== null
      || data.runtime !== null
      || data.version !== null
    ) throw new Error("agent-browser inactive session changed shape");
    return Object.freeze({ state: "inactive" });
  }
  if (
    data.active !== true
    || typeof data.pid !== "number"
    || !Number.isSafeInteger(data.pid)
    || data.pid < 1
    || data.version !== "0.32.3"
  ) throw new Error("agent-browser active session changed shape");
  const runtime = browserIdentityRecord(
    data.runtime,
    "agent-browser session runtime",
  );
  browserIdentityExactKeys(runtime, [
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
  ], "agent-browser session runtime");
  const launch = parseAgentBrowserEffectiveLaunch(
    runtime.effectiveLaunch,
    "agent-browser session effective launch",
  );
  const lifecycle = parseAgentBrowserLifecycle(runtime.lifecycle, true);
  const browserLaunched = launch.browserLaunched;
  if (
    runtime.backgroundPid !== data.pid
    || runtime.browserLaunched !== browserLaunched
    || runtime.compatibilityStatus !== "current"
    || runtime.engine !== "chrome"
    || runtime.launchHash !== launch.launchHash
    || runtime.namespace !== null
    || typeof runtime.pageCount !== "number"
    || !Number.isSafeInteger(runtime.pageCount)
    || runtime.pageCount < 0
    || runtime.pageCount > 100
    || !boundedAgentBrowserText(runtime.restoreCheckFn)
    || !boundedAgentBrowserText(runtime.restoreCheckText)
    || !boundedAgentBrowserText(runtime.restoreCheckUrl)
    || !boundedAgentBrowserText(runtime.restoreKey)
    || !boundedAgentBrowserText(runtime.restoreLoadedPath)
    || !["auto", "always", "never"].includes(
      typeof runtime.restoreSave === "string" ? runtime.restoreSave : "",
    )
    || !boundedAgentBrowserText(runtime.restoreSavedPath)
    || typeof runtime.restoreStatus !== "string"
    || runtime.restoreStatus.length < 1
    || runtime.restoreStatus.length > 256
    || !boundedAgentBrowserText(runtime.restoreStatusDetail)
    || typeof runtime.restoreValidationPending !== "boolean"
    || typeof runtime.saveStatus !== "string"
    || runtime.saveStatus.length < 1
    || runtime.saveStatus.length > 256
    || runtime.session !== resource.session
    || runtime.socketDir !== resource.socketDirectory
    || lifecycle.browserLaunched !== browserLaunched
    || lifecycle.engine !== launch.engine
    || lifecycle.launchHash !== launch.launchHash
    || (!browserLaunched && runtime.pageCount !== 0)
  ) throw new Error("agent-browser active session identity changed");
  if (launch.browserLaunched) {
    return Object.freeze({
      state: "active" as const,
      pid: data.pid,
      browserLaunched: true as const,
      engine: "chrome" as const,
      launchHash: launch.launchHash,
    });
  }
  return Object.freeze({
    state: "active" as const,
    pid: data.pid,
    browserLaunched: false as const,
    engine: "chrome" as const,
    launchHash: null,
  });
}

function parseAgentBrowserCdpControl(
  value: unknown,
): {
  readonly cdpUrl: string;
  readonly engine: "chrome";
  readonly launchHash: string;
} {
  const root = browserIdentityRecord(value, "agent-browser CDP result");
  browserIdentityExactKeys(root, ["data", "success"], "agent-browser CDP result");
  const data = browserIdentityRecord(root.data, "agent-browser CDP data");
  browserIdentityExactKeys(data, ["cdpUrl", "lifecycle"], "agent-browser CDP data");
  if (root.success !== true || typeof data.cdpUrl !== "string") {
    throw new Error("agent-browser CDP identity changed");
  }
  const lifecycle = parseAgentBrowserLifecycle(data.lifecycle, true);
  if (!lifecycle.browserLaunched) {
    throw new Error("agent-browser CDP identity changed");
  }
  return Object.freeze({
    cdpUrl: literalLoopbackAgentBrowserCdpUrl(data.cdpUrl),
    engine: lifecycle.engine,
    launchHash: lifecycle.launchHash,
  });
}

function browserLifecycleCommandContext(
  resource: BrowserCleanupResourceIdentity,
  dependencies: AgentBrowserLifecycleDependencies,
): {
  readonly inspectSession: () => Promise<unknown>;
  readonly inspectCdp: () => Promise<unknown>;
  readonly close: () => Promise<boolean>;
} {
  const recovery = parseBrowserRecoveryHandle(resource.recoveryHandle);
  const runner = dependencies.runCommand ?? runCommand;
  const environment = isolatedEnvironment(resource.socketDirectory);
  const common = [
    ...agentBrowserCommand(),
    "--config",
    recovery.configPath,
    "--session",
    resource.session,
    "--content-boundaries",
    "--max-output",
    "1048576",
  ] as const;
  const invoke = async (
    suffix: readonly string[],
    label: string,
  ): Promise<CommandResult> => {
    try {
      return await runner([...common, ...suffix], {
        cwd: resource.artifactsDirectory,
        environment,
        timeoutMs: dependencies.commandTimeoutMs?.() ?? 10_000,
        maxOutputBytes: 1024 * 1024,
        ...(dependencies.commandSignal === undefined
          ? {}
          : { signal: dependencies.commandSignal }),
      });
    } catch {
      throw new Error(`agent-browser ${label} could not be verified`);
    }
  };
  return Object.freeze({
    inspectSession: async () => {
      const result = await invoke(
        ["session", "info", "--json"],
        "session inspection",
      );
      if (result.exitCode !== 0) {
        throw new Error("agent-browser session inspection could not be verified");
      }
      try {
        return parseLastJsonWithExactLaunchHashes(result.stdout);
      } catch {
        throw new Error("agent-browser session inspection changed shape");
      }
    },
    inspectCdp: async () => {
      const result = await invoke(
        [
          "--action-policy",
          join(resource.artifactsDirectory, "action-policy.json"),
          "--json",
          "get",
          "cdp-url",
        ],
        "control inspection",
      );
      if (result.exitCode !== 0) {
        throw new Error("agent-browser control inspection could not be verified");
      }
      try {
        return parseLastJsonWithExactLaunchHashes(result.stdout);
      } catch {
        throw new Error("agent-browser control inspection changed shape");
      }
    },
    close: async () => {
      const result = await invoke(["close", "--json"], "graceful close");
      return result.exitCode === 0;
    },
  });
}

/**
 * Prove that prepared roots never crossed the durable launch-intent boundary.
 * Two exact inactive-session reads bracket an unchanged-root observation.
 */
export async function provePreparedAgentBrowserCleanupResourceQuiescent(
  value: BrowserCleanupResourceIdentityV2,
  dependencies: AgentBrowserLifecycleDependencies = {},
): Promise<BrowserCleanupResourceIdentityV2> {
  const resource = parseBrowserCleanupResourceIdentity(value);
  if (
    resource.kind !== "agent-browser-session-v2"
    || resource.phase !== "prepared"
  ) {
    throw new Error("browser cleanup resource is not prepared");
  }
  const lifecycle = browserLifecycleCommandContext(resource, dependencies);
  assertBrowserCleanupResourceRootsMatch(resource);
  const first = parseAgentBrowserSessionState(
    await lifecycle.inspectSession(),
    resource,
  );
  if (first.state !== "inactive") {
    throw new Error("prepared browser cleanup session became active");
  }
  assertBrowserCleanupResourceRootsMatch(resource);
  const second = parseAgentBrowserSessionState(
    await lifecycle.inspectSession(),
    resource,
  );
  if (second.state !== "inactive") {
    throw new Error("prepared browser cleanup session state changed");
  }
  assertBrowserCleanupResourceRootsMatch(resource);
  return resource;
}

function exactActiveAgentBrowserControl(
  state: AgentBrowserSessionState,
  control: AgentBrowserControlWitnessV1,
): LaunchedAgentBrowserSessionState {
  if (
    state.state !== "active"
    || !state.browserLaunched
    || state.pid !== control.daemonOwner.pid
    || state.engine !== control.engine
    || state.launchHash !== control.launchHash
  ) throw new Error("agent-browser control identity changed");
  return state;
}

function exactClosedAgentBrowserDaemon(
  state: AgentBrowserSessionState,
  control: AgentBrowserControlWitnessV1,
): ClosedAgentBrowserDaemonState {
  if (
    state.state !== "active"
    || state.browserLaunched
    || state.pid !== control.daemonOwner.pid
    || state.engine !== control.engine
    || state.launchHash !== null
  ) throw new Error("agent-browser control identity changed");
  return state;
}

function exactPinnedAgentBrowserCdpControl(
  value: unknown,
  control: AgentBrowserControlWitnessV1,
): void {
  const current = parseAgentBrowserCdpControl(value);
  if (
    current.cdpUrl !== control.cdpUrl
    || current.engine !== control.engine
    || current.launchHash !== control.launchHash
  ) throw new Error("agent-browser CDP control identity changed");
}

function promoteLegacyBrowserCleanupResource(
  value: BrowserCleanupResourceIdentityV1,
): BrowserCleanupResourceIdentityV2 {
  const legacy = parseBrowserCleanupResourceIdentity(value);
  if (legacy.kind !== "agent-browser-session-v1") {
    throw new Error("legacy browser cleanup resource is malformed");
  }
  const promoted = parseBrowserCleanupResourceIdentity({
    ...legacy,
    kind: "agent-browser-session-v2",
    socketDirectoryIdentity: privateBrowserDirectoryIdentityV2(
      legacy.socketDirectory,
    ),
    artifactsDirectoryIdentity: privateBrowserDirectoryIdentityV2(
      legacy.artifactsDirectory,
    ),
    phase: "launch-intent",
    control: null,
  });
  if (
    promoted.kind !== "agent-browser-session-v2"
    || legacy.socketDirectoryIdentity.device
      !== promoted.socketDirectoryIdentity.device
    || legacy.socketDirectoryIdentity.inode
      !== promoted.socketDirectoryIdentity.inode
    || legacy.artifactsDirectoryIdentity.device
      !== promoted.artifactsDirectoryIdentity.device
    || legacy.artifactsDirectoryIdentity.inode
      !== promoted.artifactsDirectoryIdentity.inode
  ) throw new Error("legacy browser cleanup private root identity changed");
  return promoted;
}

/**
 * Bind one running private agent-browser session to a durable daemon-start,
 * browser-launch, and CDP witness. Three stable session reads bracket two
 * identical CDP reads and process-owner capture; any drift leaves the prior
 * launch-intent identity intact.
 */
export async function bindLiveAgentBrowserCleanupResource(
  value: BrowserCleanupResourceIdentityV2,
  dependencies: AgentBrowserLifecycleDependencies = {},
): Promise<BrowserCleanupResourceIdentityV2> {
  const resource = parseBrowserCleanupResourceIdentity(value);
  if (
    resource.kind !== "agent-browser-session-v2"
    || resource.phase !== "launch-intent"
  ) {
    throw new Error("browser cleanup resource cannot accept a control witness");
  }
  assertBrowserCleanupResourceRootsMatch(resource);
  const lifecycle = browserLifecycleCommandContext(resource, dependencies);
  const first = parseAgentBrowserSessionState(
    await lifecycle.inspectSession(),
    resource,
  );
  if (first.state !== "active" || !first.browserLaunched) {
    throw new Error("agent-browser live control identity is unavailable");
  }
  const captureOwner = dependencies.captureOwner
    ?? captureProcessOwnerIdentity;
  let owner: ProcessOwnerIdentity;
  try {
    owner = captureOwner(first.pid);
  } catch {
    throw new Error("agent-browser live control identity is unavailable");
  }
  const cdp = parseAgentBrowserCdpControl(await lifecycle.inspectCdp());
  const second = parseAgentBrowserSessionState(
    await lifecycle.inspectSession(),
    resource,
  );
  const repeatedCdp = parseAgentBrowserCdpControl(
    await lifecycle.inspectCdp(),
  );
  const third = parseAgentBrowserSessionState(
    await lifecycle.inspectSession(),
    resource,
  );
  const inspectOwner = dependencies.ownerStatus ?? processOwnerStatus;
  if (
    second.state !== "active"
    || !second.browserLaunched
    || second.pid !== first.pid
    || second.engine !== first.engine
    || second.launchHash !== first.launchHash
    || cdp.engine !== first.engine
    || cdp.launchHash !== first.launchHash
    || repeatedCdp.cdpUrl !== cdp.cdpUrl
    || repeatedCdp.engine !== cdp.engine
    || repeatedCdp.launchHash !== cdp.launchHash
    || third.state !== "active"
    || !third.browserLaunched
    || third.pid !== first.pid
    || third.engine !== first.engine
    || third.launchHash !== first.launchHash
    || owner.pid !== first.pid
    || inspectOwner(owner) !== "exact-live-owner"
  ) throw new Error("agent-browser control identity changed while it was bound");
  assertBrowserCleanupResourceRootsMatch(resource);
  const next = parseBrowserCleanupResourceIdentity({
    ...resource,
    phase: "controlled",
    control: {
      kind: "agent-browser-control-v1",
      version: "0.32.3",
      session: resource.session,
      socketDirectory: resource.socketDirectory,
      daemonOwner: owner,
      engine: "chrome",
      launchHash: first.launchHash,
      cdpUrl: cdp.cdpUrl,
    },
  });
  if (
    next.kind !== "agent-browser-session-v2"
    || !browserCleanupResourceExtends(resource, next)
  ) throw new Error("browser cleanup control identity is not monotonic");
  return next;
}

/** Existing v1 claims may be upgraded only while their exact daemon is live. */
export async function adoptLiveLegacyBrowserCleanupResource(
  value: BrowserCleanupResourceIdentityV1,
  dependencies: AgentBrowserLifecycleDependencies = {},
): Promise<BrowserCleanupResourceIdentityV2> {
  const legacy = parseBrowserCleanupResourceIdentity(value);
  if (legacy.kind !== "agent-browser-session-v1") {
    throw new Error("legacy browser cleanup resource is malformed");
  }
  const promoted = promoteLegacyBrowserCleanupResource(legacy);
  const pinned = await bindLiveAgentBrowserCleanupResource(
    promoted,
    dependencies,
  );
  if (!browserCleanupResourceExtends(legacy, pinned)) {
    throw new Error("legacy browser cleanup resource could not be adopted");
  }
  return pinned;
}

export async function exactAgentBrowserCdpEndpointStatus(
  cdpUrl: string,
): Promise<"available" | "unavailable" | "indeterminate"> {
  let endpoint: string;
  try {
    endpoint = literalLoopbackAgentBrowserCdpUrl(cdpUrl);
  } catch {
    return "indeterminate";
  }
  const url = new URL(endpoint);
  const port = Number(url.port);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  if (host !== "127.0.0.1" && host !== "::1") {
    return "indeterminate";
  }
  return new Promise((resolveStatus) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (
      status: "available" | "unavailable" | "indeterminate",
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveStatus(status);
    };
    const timer = setTimeout(() => finish("indeterminate"), 250);
    socket.once("connect", () => finish("available"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "unavailable" : "indeterminate");
    });
    socket.once("close", () => finish("indeterminate"));
  });
}

/**
 * Prove one pinned daemon and browser endpoint quiescent within fixed bounds.
 * The only signal permitted for the exact pinned owner is SIGTERM. This
 * function never deletes roots; its caller must CAS the durable claim and
 * recheck the same identities immediately before deletion.
 */
export async function recoverPinnedAgentBrowserCleanupResource(
  value: BrowserCleanupResourceIdentityV2,
  dependencies: AgentBrowserLifecycleDependencies = {},
): Promise<BrowserCleanupResourceIdentityV2> {
  const resource = parseBrowserCleanupResourceIdentity(value);
  if (
    resource.kind !== "agent-browser-session-v2"
    || resource.phase !== "controlled"
  ) {
    throw new Error("browser cleanup resource does not have an exact control witness");
  }
  const control = resource.control;
  const lifecycle = browserLifecycleCommandContext(resource, dependencies);
  const inspectOwner = dependencies.ownerStatus ?? processOwnerStatus;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const now = dependencies.now ?? Date.now;
  const endpointStatus = dependencies.cdpEndpointStatus
    ?? exactAgentBrowserCdpEndpointStatus;
  const terminateOwner = dependencies.terminateOwner
    ?? ((owner: ProcessOwnerIdentity): void => {
      process.kill(owner.pid, "SIGTERM");
    });
  assertBrowserCleanupResourceRootsMatch(resource);
  const initialOwnerStatus = inspectOwner(control.daemonOwner);
  if (initialOwnerStatus === "unknown") {
    throw new Error("browser cleanup daemon state is indeterminate");
  }
  if (initialOwnerStatus === "exact-live-owner") {
    const initialSession = parseAgentBrowserSessionState(
      await lifecycle.inspectSession(),
      resource,
    );
    if (initialSession.state !== "active") {
      throw new Error("browser cleanup daemon and session identity disagree");
    }
    if (initialSession.browserLaunched) {
      exactActiveAgentBrowserControl(initialSession, control);
      exactPinnedAgentBrowserCdpControl(await lifecycle.inspectCdp(), control);
      exactActiveAgentBrowserControl(
        parseAgentBrowserSessionState(
          await lifecycle.inspectSession(),
          resource,
        ),
        control,
      );
      if (inspectOwner(control.daemonOwner) !== "exact-live-owner") {
        throw new Error("browser cleanup daemon identity changed before close");
      }
      assertBrowserCleanupResourceRootsMatch(resource);
      const closeSucceeded = await lifecycle.close();
      const afterClose = parseAgentBrowserSessionState(
        await lifecycle.inspectSession(),
        resource,
      );
      const afterCloseOwnerStatus = inspectOwner(control.daemonOwner);
      if (afterCloseOwnerStatus === "unknown") {
        throw new Error("browser cleanup daemon state became indeterminate");
      }
      if (afterCloseOwnerStatus === "exact-live-owner") {
        if (afterClose.state === "active" && afterClose.browserLaunched) {
          exactActiveAgentBrowserControl(afterClose, control);
          exactPinnedAgentBrowserCdpControl(await lifecycle.inspectCdp(), control);
          exactActiveAgentBrowserControl(
            parseAgentBrowserSessionState(
              await lifecycle.inspectSession(),
              resource,
            ),
            control,
          );
        } else if (afterClose.state === "active") {
          if (!closeSucceeded) {
            throw new Error("agent-browser graceful close could not be verified");
          }
          exactClosedAgentBrowserDaemon(afterClose, control);
          exactClosedAgentBrowserDaemon(
            parseAgentBrowserSessionState(
              await lifecycle.inspectSession(),
              resource,
            ),
            control,
          );
        } else {
          const repeatedInactive = parseAgentBrowserSessionState(
            await lifecycle.inspectSession(),
            resource,
          );
          if (repeatedInactive.state !== "inactive") {
            throw new Error("browser cleanup session state changed before termination");
          }
        }
      }
    } else {
      exactClosedAgentBrowserDaemon(initialSession, control);
      exactClosedAgentBrowserDaemon(
        parseAgentBrowserSessionState(
          await lifecycle.inspectSession(),
          resource,
        ),
        control,
      );
    }
    const beforeTermination = inspectOwner(control.daemonOwner);
    if (beforeTermination === "unknown") {
      throw new Error("browser cleanup daemon state became indeterminate");
    }
    if (beforeTermination === "exact-live-owner") {
      assertBrowserCleanupResourceRootsMatch(resource);
      try {
        terminateOwner(control.daemonOwner);
      } catch {
        if (inspectOwner(control.daemonOwner) === "exact-live-owner") {
          throw new Error("browser cleanup daemon did not accept graceful termination");
        }
      }
      const ownerDeadline = now() + 5_000;
      for (;;) {
        const status = inspectOwner(control.daemonOwner);
        if (status === "unknown") {
          throw new Error("browser cleanup daemon state became indeterminate");
        }
        if (status === "different-or-dead") break;
        if (now() >= ownerDeadline) {
          throw new Error("browser cleanup daemon did not stop after SIGTERM");
        }
        await sleep(25);
      }
    }
  }
  const finalOwnerStatus = inspectOwner(control.daemonOwner);
  if (finalOwnerStatus !== "different-or-dead") {
    throw new Error("browser cleanup daemon quiescence is unproved");
  }
  const inactive = parseAgentBrowserSessionState(
    await lifecycle.inspectSession(),
    resource,
  );
  if (inactive.state !== "inactive") {
    throw new Error("browser cleanup session remained active");
  }
  const endpointDeadline = now() + 5_000;
  let consecutiveRefusals = 0;
  while (consecutiveRefusals < 3) {
    const status = await endpointStatus(control.cdpUrl);
    if (status === "indeterminate") {
      throw new Error("browser cleanup endpoint state is indeterminate");
    }
    consecutiveRefusals = status === "unavailable"
      ? consecutiveRefusals + 1
      : 0;
    if (consecutiveRefusals >= 3) break;
    if (now() >= endpointDeadline) {
      throw new Error("browser cleanup endpoint remained available");
    }
    await sleep(25);
  }
  if (inspectOwner(control.daemonOwner) !== "different-or-dead") {
    throw new Error("browser cleanup daemon quiescence changed");
  }
  const finalInactive = parseAgentBrowserSessionState(
    await lifecycle.inspectSession(),
    resource,
  );
  if (finalInactive.state !== "inactive") {
    throw new Error("browser cleanup session quiescence changed");
  }
  assertBrowserCleanupResourceRootsMatch(resource);
  return resource;
}

/**
 * Refresh full-root quiescence without weakening a launch-intent boundary.
 * Prepared roots require only their exact inactive proof; controlled roots
 * use the pinned close/TERM/CDP recovery protocol.
 */
export async function refreshBrowserCleanupResourceQuiescence(
  value: BrowserCleanupResourceIdentityV2,
  dependencies: AgentBrowserLifecycleDependencies = {},
): Promise<BrowserCleanupResourceIdentityV2> {
  const resource = parseBrowserCleanupResourceIdentity(value);
  if (resource.kind !== "agent-browser-session-v2") {
    throw new Error("browser cleanup resource is not recoverable");
  }
  if (resource.phase === "prepared") {
    return provePreparedAgentBrowserCleanupResourceQuiescent(
      resource,
      dependencies,
    );
  }
  if (resource.phase === "controlled") {
    return recoverPinnedAgentBrowserCleanupResource(resource, dependencies);
  }
  throw new Error("browser cleanup launch intent is not durably controlled");
}

function assertBrowserDeletionBoundaryRoots(
  resource: BrowserCleanupResourceIdentityV2,
): void {
  if (
    browserCleanupResourceRootStatus(resource, "socket") !== "match"
    || browserCleanupResourceRootStatus(resource, "artifacts") !== "absent"
  ) {
    throw new Error("browser cleanup deletion-boundary roots changed");
  }
}

async function proveControlledDeletionBoundary(
  resource: BrowserCleanupResourceIdentityV2,
  dependencies: AgentBrowserLifecycleDependencies,
): Promise<void> {
  if (resource.phase !== "controlled") {
    throw new Error("browser cleanup resource is not durably controlled");
  }
  const inspectOwner = dependencies.ownerStatus ?? processOwnerStatus;
  if (inspectOwner(resource.control.daemonOwner) !== "different-or-dead") {
    throw new Error("browser cleanup pinned owner is not quiescent");
  }
  const endpointStatus = dependencies.cdpEndpointStatus
    ?? exactAgentBrowserCdpEndpointStatus;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await endpointStatus(resource.control.cdpUrl) !== "unavailable") {
      throw new Error("browser cleanup endpoint refusal is unproved");
    }
  }
  if (inspectOwner(resource.control.daemonOwner) !== "different-or-dead") {
    throw new Error("browser cleanup pinned owner quiescence changed");
  }
}

/**
 * Re-prove deletion safety after the artifacts root has already been removed.
 * This helper performs session-info reads only. It never launches, closes, or
 * signals a browser process, and its temporary config remains inside the exact
 * socket root that is already scheduled for deletion.
 */
export async function reproveBrowserCleanupAfterArtifactsRemoval(
  value: BrowserCleanupResourceIdentityV2,
  dependencies: AgentBrowserLifecycleDependencies = {},
): Promise<BrowserCleanupResourceIdentityV2> {
  const resource = parseBrowserCleanupResourceIdentity(value);
  if (
    resource.kind !== "agent-browser-session-v2"
    || resource.phase === "launch-intent"
  ) {
    throw new Error("browser cleanup resource is ineligible for deletion reproof");
  }
  assertBrowserDeletionBoundaryRoots(resource);
  if (resource.phase === "controlled") {
    await proveControlledDeletionBoundary(resource, dependencies);
  }
  const temporaryConfig = join(
    resource.socketDirectory,
    `.wrench-cleanup-${crypto.randomUUID()}.json`,
  );
  try {
    try {
      writeFileSync(temporaryConfig, "{}\n", {
        flag: "wx",
        mode: 0o600,
      });
      const stats = lstatSync(temporaryConfig, { bigint: true });
      const currentUid = process.getuid?.();
      if (
        stats.isSymbolicLink()
        || !stats.isFile()
        || currentUid === undefined
        || stats.uid !== BigInt(currentUid)
        || (stats.mode & 0o777n) !== 0o600n
      ) throw new Error("temporary cleanup config identity changed");
    } catch {
      throw new Error("browser cleanup session inspection could not be prepared");
    }
    assertBrowserDeletionBoundaryRoots(resource);
    const runner = dependencies.runCommand ?? runCommand;
    const environment = isolatedEnvironment(resource.socketDirectory);
    const inspectSession = async (): Promise<AgentBrowserSessionState> => {
      let result: CommandResult;
      try {
        result = await runner([
          ...agentBrowserCommand(),
          "--config",
          temporaryConfig,
          "--session",
          resource.session,
          "--content-boundaries",
          "--max-output",
          "1048576",
          "session",
          "info",
          "--json",
        ], {
          cwd: resource.socketDirectory,
          environment,
          timeoutMs: dependencies.commandTimeoutMs?.() ?? 10_000,
          maxOutputBytes: 1024 * 1024,
          ...(dependencies.commandSignal === undefined
            ? {}
            : { signal: dependencies.commandSignal }),
        });
      } catch {
        throw new Error("browser cleanup session inspection could not be verified");
      }
      if (result.exitCode !== 0) {
        throw new Error("browser cleanup session inspection could not be verified");
      }
      let parsed: unknown;
      try {
        parsed = parseLastJsonWithExactLaunchHashes(result.stdout);
      } catch {
        throw new Error("browser cleanup session inspection changed shape");
      }
      return parseAgentBrowserSessionState(parsed, resource);
    };
    const first = await inspectSession();
    if (first.state !== "inactive") {
      throw new Error("browser cleanup session remained active");
    }
    assertBrowserDeletionBoundaryRoots(resource);
    const second = await inspectSession();
    if (second.state !== "inactive") {
      throw new Error("browser cleanup session quiescence changed");
    }
    assertBrowserDeletionBoundaryRoots(resource);
    if (resource.phase === "controlled") {
      await proveControlledDeletionBoundary(resource, dependencies);
    }
  } finally {
    try {
      rmSync(temporaryConfig, { force: true });
    } catch {
      // A retained mode-0600 config remains inside the root being deleted.
    }
  }
  assertBrowserDeletionBoundaryRoots(resource);
  return resource;
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
  let cleanupResourceIdentity: BrowserCleanupResourceIdentityV2 | null = null;
  let cleanupResourcePublication:
    | "unpublished"
    | "uncertain"
    | "published" = "unpublished";
  const recoveryHandle = (): string => browserRecoveryHandle({
    session,
    configPath,
    socketDirectory,
    artifactsDirectory: directory,
  });
  const failInitialization = (
    error: unknown,
    cleanupEvidenceResource: BrowserCleanupResourceIdentity | null =
      cleanupResourceIdentity,
  ): never => {
    if (cleanupResourcePublication !== "unpublished") {
      throw new PreservedBrowserArtifactsError(
        "browser session initialization failed after its cleanup roots may have been durably published",
        recoveryHandle(),
        error,
        cleanupEvidenceResource === null
          ? undefined
          : Object.freeze({
              kind: "agent-browser-closed-artifacts-v1" as const,
              resource: cleanupEvidenceResource,
            }),
      );
    }
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
  } catch (error) {
    failInitialization(error);
  }
  const initializedSocketDirectory = socketDirectory
    ?? failInitialization(new Error("browser socket directory was not initialized"));
  cleanupResourceIdentity = (() => {
    let identity: BrowserCleanupResourceIdentityV2 | null = null;
    try {
      identity = browserCleanupResourceIdentity({
        recoveryHandle: recoveryHandle(),
        session,
        socketDirectory: initializedSocketDirectory,
        artifactsDirectory: directory,
      });
      // A throwing publisher may have committed before reporting failure. The
      // durable registrar normally reconciles that exact commit, but custom or
      // interrupted publishers cannot disprove it. Preserve both roots.
      cleanupResourcePublication = options.publishCleanupResource === undefined
        ? "unpublished"
        : "uncertain";
      options.publishCleanupResource?.(identity);
      cleanupResourcePublication = options.publishCleanupResource === undefined
        ? "unpublished"
        : "published";
      return identity;
    } catch (error) {
      return failInitialization(error, identity);
    }
  })();
  try {
    guardBrowserSetup(operationDeadline);
    const sourceProfile = auth.kind === "browser-profile"
      ? profilePath(auth.profile)
      : null;
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
  if (cleanupResourceIdentity === null) {
    failInitialization(new Error("browser cleanup resource was not initialized"));
  }
  const publishCleanupResourceExtension = (
    next: BrowserCleanupResourceIdentityV2,
  ): void => {
    const current = cleanupResourceIdentity;
    if (current === null || !browserCleanupResourceExtends(current, next)) {
      throw new Error("browser cleanup resource extension is not monotonic");
    }
    if (options.publishCleanupResource !== undefined) {
      cleanupResourcePublication = "uncertain";
      options.publishCleanupResource(next);
      cleanupResourcePublication = "published";
    }
    cleanupResourceIdentity = next;
  };
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
      const resource = cleanupResourceIdentity;
      const publisher = options.publishCleanupResource;
      const markQuiescent = publisher?.markBrowserCleanupQuiescent;
      const markRootRemoved = publisher?.markBrowserCleanupRootRemoved;
      if (resource === null) {
        failures.push(new Error("browser cleanup resource identity is unavailable"));
      } else if (publisher !== undefined) {
        if (
          markQuiescent === undefined
          || markRootRemoved === undefined
        ) {
          failures.push(new Error(
            "durable browser cleanup journaling is unavailable",
          ));
        } else {
          try {
            // This transition must commit while both roots still match. Once
            // durable, recovery may accept an absent root as a crash between
            // its removal and the following journal CAS.
            await refreshBrowserCleanupResourceQuiescence(
              resource,
              {
                ...options.dependencies?.cleanupLifecycle,
                runCommand: runBrowserCommand,
              },
            );
            markQuiescent(resource);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length === 0 && resource !== null) {
        for (const [rootName, path] of [
          ["artifacts", directory],
          ["socket", initializedSocketDirectory],
        ] as const) {
          try {
            removePrivateArtifact(path);
            if (browserCleanupResourceRootStatus(resource, rootName) !== "absent") {
              throw new Error(
                "browser cleanup root removal could not be verified",
              );
            }
          } catch (error) {
            failures.push(error);
            break;
          }
          if (publisher !== undefined && markRootRemoved !== undefined) {
            try {
              markRootRemoved(resource, rootName);
            } catch (error) {
              failures.push(error);
              break;
            }
          }
          if (rootName === "artifacts" && publisher !== undefined) {
            try {
              await reproveBrowserCleanupAfterArtifactsRemoval(
                resource,
                {
                  ...options.dependencies?.cleanupLifecycle,
                  runCommand: runBrowserCommand,
                },
              );
            } catch (error) {
              failures.push(error);
              break;
            }
          }
        }
      }
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
    const proxyArguments = ownedBrowserProxyArguments(
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
    const preparedResource = cleanupResourceIdentity;
    if (preparedResource === null || preparedResource.phase !== "prepared") {
      throw new Error("browser cleanup resource is not prepared for launch");
    }
    const launchIntentResource = parseBrowserCleanupResourceIdentity({
      ...preparedResource,
      phase: "launch-intent",
      control: null,
    });
    if (launchIntentResource.kind !== "agent-browser-session-v2") {
      throw new Error("browser cleanup launch intent is malformed");
    }
    publishCleanupResourceExtension(launchIntentResource);
    launchAttempted = true;
    await runBatch(
      [["open", launchUrl]],
      remainingBrowserSetupTime(options.timeoutMs, operationDeadline),
      options.maxOutputBytes,
    );
    if (options.publishCleanupResource !== undefined) {
      guardBrowserSetup(operationDeadline);
      const pinnedCleanupResource = await runBrowserSetupStep(
        operationDeadline,
        () => bindLiveAgentBrowserCleanupResource(
          launchIntentResource,
          {
            runCommand: runBrowserCommand,
            ...(operationDeadline === undefined
              ? {}
              : {
                  commandSignal: operationDeadline.signal,
                  commandTimeoutMs: () => remainingBrowserSetupTime(
                    options.timeoutMs,
                    operationDeadline,
                  ),
                }),
          },
        ),
      );
      guardBrowserSetup(operationDeadline);
      publishCleanupResourceExtension(pinnedCleanupResource);
    }
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
      get cleanupResourceIdentity() {
        return options.publishCleanupResource === undefined
          ? undefined
          : cleanupResourceIdentity ?? undefined;
      },
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
    if (cleanupResourcePublication !== "unpublished") {
      cleanupFailures.push(
        new Error("durably published browser roots require exact recovery"),
      );
    } else if (
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
