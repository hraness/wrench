import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson } from "./canonical-json";
import {
  PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION,
  PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
  isPortableProviderPluginVersion,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginManifestV1,
  type VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  currentProcessStartIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
} from "./process-identity";
import { ensurePrivateDirectory } from "./storage";

export const PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION = 1 as const;

export type PortableProviderPluginTrustApprovalV1 = {
  readonly decision: "trust-executable-code";
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly bundleSha256: string;
};

export type PortableProviderPluginTrustRecordV1 = {
  readonly schemaVersion:
    typeof PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION;
  readonly decision: "trust-executable-code";
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly hostApiVersion: typeof PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION;
  readonly bundleSha256: string;
  readonly manifestSha256: string;
  readonly provenance: PortableProviderPluginManifestV1["provenance"];
  readonly trustedAt: string;
};

type PortableProviderPluginActivationBaseV1 = {
  readonly schemaVersion:
    typeof PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly bundleSha256: string;
  readonly activatedAt: string;
};

export type PortableProviderPluginActiveRecordV1 =
  | PortableProviderPluginActivationBaseV1 & {
      readonly status: "enabled";
    }
  | PortableProviderPluginActivationBaseV1 & {
      readonly status: "disabled";
      readonly disabledAt: string;
    };

type PortableProviderPluginLockRecordV1 = ProcessOwnerIdentity & {
  readonly schemaVersion:
    typeof PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION;
  readonly pluginId: string;
  readonly acquiredAt: string;
};

type PortableProviderPluginCatalogLockRecordV1 = ProcessOwnerIdentity & {
  readonly schemaVersion:
    typeof PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION;
  readonly scope: "catalog-mutation";
  readonly acquiredAt: string;
};

type PortableProviderPluginLockClaimPhase =
  | "waiting"
  | "candidate"
  | "held";

type PortableProviderPluginLockClaimV1 = ProcessOwnerIdentity & {
  readonly schemaVersion:
    typeof PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION;
  readonly kind: "portable-provider-plugin-lock-claim";
  readonly targetSha256: string;
  readonly claimId: string;
};

export type PortableProviderPluginAssertActivatable = (
  verifiedPackage: VerifiedPortableProviderPluginPackage,
) => void;

export type PortableProviderPluginAssertQuiescent = (
  bundleSha256: string,
  artifactPath: string,
) => void;

export type InstalledPortableProviderPlugin = {
  readonly artifactPath: string;
  readonly package: VerifiedPortableProviderPluginPackage;
  readonly trust: PortableProviderPluginTrustRecordV1;
  readonly active: PortableProviderPluginActiveRecordV1;
};

export type PortableProviderPluginStorePaths = {
  readonly root: string;
  readonly artifacts: string;
  readonly trust: string;
  readonly active: string;
  readonly locks: string;
};

const MAX_STORE_RECORD_BYTES = 64 * 1024;
const MAX_LOCK_CLAIMS = 1_024;
const MAX_LOCK_PUBLICATIONS = 1_024;
const TEST_BARRIER_TIMEOUT_MS = 90_000;
const CATALOG_MUTATION_LOCK_NAME = ".catalog-mutation.lock";
const lockClaimIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const lockPublicationPrefix = ".lock-publication-";
const lockPublicationNamePattern =
  /^\.lock-publication-([1-9][0-9]*)-([a-f0-9]{64})-([a-f0-9]{64})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;
const pluginIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const activeCatalogMutationLocks = new Set<string>();
const activePluginMutations = new Set<string>();

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && "value" in descriptor;
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function pluginId(value: unknown, label: string): string {
  if (typeof value !== "string" || !pluginIdPattern.test(value)) {
    throw new Error(`${label} must be strict lowercase kebab-case`);
  }
  return value;
}

function pluginVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length > 128
    || !isPortableProviderPluginVersion(value)
  ) {
    throw new Error(`${label} must be strict semantic version text`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be one canonical UTC timestamp`);
  }
  return value;
}

function parseProvenance(
  value: unknown,
): PortableProviderPluginManifestV1["provenance"] {
  const parsed = record(value, "plugin trust provenance");
  if (parsed.kind === "local") {
    exactKeys(parsed, ["kind"], "local plugin trust provenance");
    return Object.freeze({ kind: "local" });
  }
  if (parsed.kind === "git") {
    exactKeys(
      parsed,
      ["kind", "repository", "revision"],
      "git plugin trust provenance",
    );
    if (
      typeof parsed.repository !== "string"
      || !parsed.repository.startsWith("https://")
      || typeof parsed.revision !== "string"
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(parsed.revision)
    ) {
      throw new Error("git plugin trust provenance is invalid");
    }
    return Object.freeze({
      kind: "git",
      repository: parsed.repository as `https://${string}`,
      revision: parsed.revision,
    });
  }
  throw new Error("plugin trust provenance kind is unsupported");
}

export function parsePortableProviderPluginTrustApproval(
  value: unknown,
): PortableProviderPluginTrustApprovalV1 {
  const parsed = record(value, "portable plugin trust approval");
  exactKeys(
    parsed,
    ["bundleSha256", "decision", "pluginId", "pluginVersion"],
    "portable plugin trust approval",
  );
  if (parsed.decision !== "trust-executable-code") {
    throw new Error(
      "portable plugin trust approval must explicitly trust executable code",
    );
  }
  return Object.freeze({
    decision: parsed.decision,
    pluginId: pluginId(parsed.pluginId, "approved plugin ID"),
    pluginVersion: pluginVersion(
      parsed.pluginVersion,
      "approved plugin version",
    ),
    bundleSha256: sha256(
      parsed.bundleSha256,
      "approved plugin bundle digest",
    ),
  });
}

function parseTrustRecord(value: unknown): PortableProviderPluginTrustRecordV1 {
  const parsed = record(value, "portable plugin trust record");
  exactKeys(
    parsed,
    [
      "bundleSha256",
      "decision",
      "hostApiVersion",
      "manifestSha256",
      "pluginId",
      "pluginVersion",
      "provenance",
      "schemaVersion",
      "trustedAt",
    ],
    "portable plugin trust record",
  );
  if (
    parsed.schemaVersion !== PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION
    || parsed.hostApiVersion !== PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION
    || parsed.decision !== "trust-executable-code"
  ) {
    throw new Error("portable plugin trust record version or decision is invalid");
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    decision: parsed.decision,
    pluginId: pluginId(parsed.pluginId, "trusted plugin ID"),
    pluginVersion: pluginVersion(
      parsed.pluginVersion,
      "trusted plugin version",
    ),
    hostApiVersion: parsed.hostApiVersion,
    bundleSha256: sha256(
      parsed.bundleSha256,
      "trusted plugin bundle digest",
    ),
    manifestSha256: sha256(
      parsed.manifestSha256,
      "trusted plugin manifest digest",
    ),
    provenance: parseProvenance(parsed.provenance),
    trustedAt: timestamp(parsed.trustedAt, "plugin trust time"),
  });
}

function parseActiveRecord(value: unknown): PortableProviderPluginActiveRecordV1 {
  const parsed = record(value, "portable plugin active record");
  const disabled = parsed.status === "disabled";
  exactKeys(
    parsed,
    [
      "activatedAt",
      "bundleSha256",
      ...(disabled ? ["disabledAt"] : []),
      "pluginId",
      "pluginVersion",
      "schemaVersion",
      "status",
    ],
    "portable plugin active record",
  );
  if (
    parsed.schemaVersion !== PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION
    || (parsed.status !== "enabled" && parsed.status !== "disabled")
  ) {
    throw new Error("portable plugin active record version is invalid");
  }
  const base = {
    schemaVersion: parsed.schemaVersion,
    pluginId: pluginId(parsed.pluginId, "active plugin ID"),
    pluginVersion: pluginVersion(
      parsed.pluginVersion,
      "active plugin version",
    ),
    bundleSha256: sha256(
      parsed.bundleSha256,
      "active plugin bundle digest",
    ),
    activatedAt: timestamp(parsed.activatedAt, "plugin activation time"),
  } as const;
  return parsed.status === "enabled"
    ? Object.freeze({ ...base, status: parsed.status })
    : Object.freeze({
        ...base,
        status: parsed.status,
        disabledAt: timestamp(
          parsed.disabledAt,
          "plugin disable time",
        ),
      });
}

function parseLockRecord(value: unknown): PortableProviderPluginLockRecordV1 {
  const parsed = record(value, "portable plugin activation lock");
  exactKeys(
    parsed,
    [
      "acquiredAt",
      "bootId",
      "pid",
      "pluginId",
      "processStartId",
      "schemaVersion",
    ],
    "portable plugin activation lock",
  );
  if (
    parsed.schemaVersion !== PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION
    || !Number.isSafeInteger(parsed.pid)
    || typeof parsed.pid !== "number"
    || parsed.pid < 1
    || typeof parsed.bootId !== "string"
    || !sha256Pattern.test(parsed.bootId)
    || typeof parsed.processStartId !== "string"
    || !sha256Pattern.test(parsed.processStartId)
  ) {
    throw new Error("portable plugin activation lock is invalid");
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    pluginId: pluginId(parsed.pluginId, "locked plugin ID"),
    acquiredAt: timestamp(parsed.acquiredAt, "plugin lock acquisition time"),
    pid: parsed.pid,
    bootId: parsed.bootId,
    processStartId: parsed.processStartId,
  });
}

function parseCatalogLockRecord(
  value: unknown,
): PortableProviderPluginCatalogLockRecordV1 {
  const parsed = record(value, "portable plugin catalog mutation lock");
  exactKeys(
    parsed,
    [
      "acquiredAt",
      "bootId",
      "pid",
      "processStartId",
      "schemaVersion",
      "scope",
    ],
    "portable plugin catalog mutation lock",
  );
  if (
    parsed.schemaVersion !== PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION
    || parsed.scope !== "catalog-mutation"
    || !Number.isSafeInteger(parsed.pid)
    || typeof parsed.pid !== "number"
    || parsed.pid < 1
    || typeof parsed.bootId !== "string"
    || !sha256Pattern.test(parsed.bootId)
    || typeof parsed.processStartId !== "string"
    || !sha256Pattern.test(parsed.processStartId)
  ) {
    throw new Error("portable plugin catalog mutation lock is invalid");
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    scope: parsed.scope,
    acquiredAt: timestamp(
      parsed.acquiredAt,
      "plugin catalog lock acquisition time",
    ),
    pid: parsed.pid,
    bootId: parsed.bootId,
    processStartId: parsed.processStartId,
  });
}

function parseLockClaimRecord(
  value: unknown,
  targetSha256: string,
  claimId: string,
): PortableProviderPluginLockClaimV1 {
  const parsed = record(value, "portable plugin lock arbitration claim");
  exactKeys(
    parsed,
    [
      "bootId",
      "claimId",
      "kind",
      "pid",
      "processStartId",
      "schemaVersion",
      "targetSha256",
    ],
    "portable plugin lock arbitration claim",
  );
  if (
    parsed.schemaVersion !== PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION
    || parsed.kind !== "portable-provider-plugin-lock-claim"
    || parsed.targetSha256 !== targetSha256
    || parsed.claimId !== claimId
    || !lockClaimIdPattern.test(claimId)
    || !Number.isSafeInteger(parsed.pid)
    || typeof parsed.pid !== "number"
    || parsed.pid < 1
    || typeof parsed.bootId !== "string"
    || !sha256Pattern.test(parsed.bootId)
    || typeof parsed.processStartId !== "string"
    || !sha256Pattern.test(parsed.processStartId)
  ) {
    throw new Error("portable plugin lock arbitration claim is invalid");
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    kind: parsed.kind,
    targetSha256: parsed.targetSha256,
    claimId: parsed.claimId,
    pid: parsed.pid,
    bootId: parsed.bootId,
    processStartId: parsed.processStartId,
  });
}

function physicalPathThroughExistingAncestor(path: string): string {
  let ancestor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return join(
        realpathSync(ancestor),
        ...[...missingSegments].reverse(),
      );
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) {
        throw new Error(
          "portable plugin store path could not be resolved safely",
          { cause: error },
        );
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw new Error(
          "portable plugin store path has no resolvable physical ancestor",
          { cause: error },
        );
      }
      missingSegments.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

function physicalPathThroughExistingParent(path: string): string {
  const absolute = resolve(path);
  return join(
    physicalPathThroughExistingAncestor(dirname(absolute)),
    basename(absolute),
  );
}

export function portableProviderPluginStorePaths(
  root: string,
): PortableProviderPluginStorePaths {
  const canonicalRoot = physicalPathThroughExistingAncestor(root);
  return Object.freeze({
    root: canonicalRoot,
    artifacts: join(canonicalRoot, "artifacts"),
    trust: join(canonicalRoot, "trust"),
    active: join(canonicalRoot, "active"),
    locks: join(canonicalRoot, "locks"),
  });
}

function ownedByCurrentUser(stats: { readonly uid: number }): boolean {
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
  return currentUid === undefined || stats.uid === currentUid;
}

function sameFileIdentity(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameInodeIdentity(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type PrivateRecordSnapshot<T> = {
  readonly value: T;
  readonly identity: ReturnType<typeof fstatSync>;
};

class PrivateRecordChangedDuringReadError extends Error {}

function changedDuringPrivateRecordRead(
  label: string,
): PrivateRecordChangedDuringReadError {
  return new PrivateRecordChangedDuringReadError(
    `${label} changed while it was being read`,
  );
}

function pauseAfterLockClaimReadForTest(
  path: string,
  label: string,
): void {
  if (
    process.env.NODE_ENV !== "test"
    || label !== "portable plugin lock arbitration claim"
  ) {
    return;
  }
  const readyPath = process.env.WRENCH_TEST_PLUGIN_LOCK_CLAIM_READ_READY;
  const releasePath = process.env.WRENCH_TEST_PLUGIN_LOCK_CLAIM_READ_RELEASE;
  const targetName = process.env.WRENCH_TEST_PLUGIN_LOCK_CLAIM_READ_TARGET;
  if (
    readyPath === undefined
    || releasePath === undefined
    || targetName === undefined
    || basename(path) !== targetName
    || existsSync(readyPath)
  ) {
    return;
  }
  writePrivateFile(readyPath, Buffer.from("read\n", "utf8"));
  syncDirectory(dirname(readyPath));
  const deadline = Date.now() + TEST_BARRIER_TIMEOUT_MS;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error("portable plugin lock claim read test barrier timed out");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function readPrivateRecordSnapshotIfPresent<T>(
  path: string,
  label: string,
  parse: (value: unknown) => T,
): PrivateRecordSnapshot<T> | null {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw new Error(`could not safely open ${label}`, { cause: error });
  }
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile()
      || !ownedByCurrentUser(before)
      || (before.mode & 0o077) !== 0
      || before.size < 2
      || before.size > MAX_STORE_RECORD_BYTES
    ) {
      throw new Error(`${label} must be one bounded private regular file`);
    }
    const bytes = readFileSync(descriptor);
    pauseAfterLockClaimReadForTest(path, label);
    const after = fstatSync(descriptor);
    if (
      bytes.byteLength !== before.size
      || !sameFileIdentity(before, after)
    ) {
      throw changedDuringPrivateRecordRead(label);
    }
    let linked: ReturnType<typeof lstatSync>;
    try {
      linked = lstatSync(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw changedDuringPrivateRecordRead(label);
      }
      throw new Error(`could not safely verify ${label}`, { cause: error });
    }
    if (
      linked.isSymbolicLink()
      || !linked.isFile()
      || !sameInodeIdentity(after, linked)
    ) {
      throw changedDuringPrivateRecordRead(label);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} must contain valid UTF-8`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${label} must contain valid JSON`);
    }
    const result = parse(value);
    if (text !== `${canonicalJson(result)}\n`) {
      throw new Error(`${label} must use canonical JSON encoding`);
    }
    return Object.freeze({ value: result, identity: after });
  } finally {
    closeSync(descriptor);
  }
}

function readPrivateRecordIfPresent<T>(
  path: string,
  label: string,
  parse: (value: unknown) => T,
): T | null {
  return readPrivateRecordSnapshotIfPresent(path, label, parse)?.value ?? null;
}

function syncDirectory(path: string): void {
  const directoryFlag = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type LockPublicationKind = "claim" | "lock";

type PublishedPrivateLockFile = {
  readonly descriptor: number;
  readonly identity: ReturnType<typeof fstatSync>;
};

function lockPublicationStagePath(
  parent: string,
  owner: ProcessOwnerIdentity,
): string {
  return join(
    parent,
    `${lockPublicationPrefix}${owner.pid}-${owner.bootId}-`
      + `${owner.processStartId}-${randomUUID()}.tmp`,
  );
}

function parseLockPublicationOwner(name: string): ProcessOwnerIdentity {
  const match = lockPublicationNamePattern.exec(name);
  if (match === null) {
    throw new Error("portable plugin lock publication filename is invalid");
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("portable plugin lock publication owner is invalid");
  }
  return Object.freeze({
    pid,
    bootId: match[2]!,
    processStartId: match[3]!,
  });
}

function stableProcessOwnerStatus(
  owner: ProcessOwnerIdentity,
): ReturnType<typeof processOwnerStatus> {
  let status = processOwnerStatus(owner);
  for (let attempt = 0; status === "unknown" && attempt < 3; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    status = processOwnerStatus(owner);
  }
  return status;
}

function reclaimDeadLockPublications(parent: string): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const names = readdirSync(parent)
      .filter((name) => name.startsWith(lockPublicationPrefix))
      .sort();
    if (names.length > MAX_LOCK_PUBLICATIONS) {
      throw new Error("portable plugin lock publication count exceeds its bound");
    }
    let retry = false;
    let removed = false;
    for (const name of names) {
      const owner = parseLockPublicationOwner(name);
      const status = stableProcessOwnerStatus(owner);
      if (status === "unknown") {
        throw new Error(
          "portable plugin lock publication owner cannot be inspected safely",
        );
      }
      if (status === "exact-live-owner") continue;
      const path = join(parent, name);
      let identity: ReturnType<typeof fstatSync>;
      try {
        const descriptor = openSync(
          path,
          constants.O_RDONLY
            | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
        );
        try {
          identity = fstatSync(descriptor);
          if (
            !identity.isFile()
            || !ownedByCurrentUser(identity)
            || (identity.mode & 0o077) !== 0
            || identity.size > MAX_STORE_RECORD_BYTES
          ) {
            throw new Error(
              "portable plugin lock publication must be one bounded "
                + "private regular file",
            );
          }
        } finally {
          closeSync(descriptor);
        }
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          retry = true;
          break;
        }
        throw error;
      }
      if (removeExactPrivateFile(
        path,
        identity,
        "portable plugin lock publication",
      )) {
        removed = true;
      } else {
        retry = true;
        break;
      }
    }
    if (retry || removed) continue;
    return;
  }
  throw new Error(
    "portable plugin lock publications did not reach a stable snapshot",
  );
}

function crashLockPublicationForTest(
  kind: LockPublicationKind,
  logicalLockPath: string,
  descriptor: number,
  bytes: Uint8Array,
): void {
  if (process.env.NODE_ENV !== "test") return;
  const fault = process.env.WRENCH_TEST_PLUGIN_LOCK_PUBLICATION_CRASH;
  const targetName = process.env.WRENCH_TEST_PLUGIN_LOCK_PUBLICATION_TARGET;
  if (
    targetName === undefined
    || basename(logicalLockPath) !== targetName
    || (
      fault !== `${kind}-empty-stage`
      && fault !== `${kind}-partial-stage`
    )
  ) {
    return;
  }
  if (fault.endsWith("partial-stage")) {
    writeFileSync(
      descriptor,
      bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2))),
    );
  }
  fchmodSync(descriptor, 0o600);
  fsyncSync(descriptor);
  process.exit(92);
}

function unlinkIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function cleanupFailedLockPublication(
  path: string,
  stage: string,
  parent: string,
  descriptor: number | null,
  identity: ReturnType<typeof fstatSync> | null,
  targetLinked: boolean,
  directoryChanged: boolean,
): void {
  let cleanupError: unknown;
  if (targetLinked && identity !== null) {
    try {
      removeExactPrivateFile(
        path,
        identity,
        "portable plugin lock publication",
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  if (descriptor !== null) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  try {
    if (unlinkIfPresent(stage)) directoryChanged = true;
  } catch (error) {
    cleanupError ??= error;
  }
  if (directoryChanged) {
    try {
      syncDirectory(parent);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error("portable plugin lock publication cleanup failed", {
          cause: cleanupError,
        });
  }
}

function publishPrivateLockFileExclusive(
  path: string,
  bytes: Uint8Array,
  owner: ProcessOwnerIdentity,
  kind: LockPublicationKind,
  logicalLockPath: string,
): PublishedPrivateLockFile | null {
  const parent = dirname(path);
  const stage = lockPublicationStagePath(parent, owner);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let descriptor: number | null = null;
  let identity: ReturnType<typeof fstatSync> | null = null;
  let targetLinked = false;
  let transferred = false;
  let directoryChanged = false;
  try {
    // The stage name carries enough process identity to reclaim even an empty
    // crash remnant. The hard link below is the only publication point, so a
    // reader can observe either no lock or one complete, fsynced record.
    descriptor = openSync(
      stage,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | noFollow,
      0o600,
    );
    directoryChanged = true;
    crashLockPublicationForTest(
      kind,
      logicalLockPath,
      descriptor,
      bytes,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    identity = fstatSync(descriptor);
    try {
      linkSync(stage, path);
      targetLinked = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      return null;
    }
    unlinkSync(stage);
    syncDirectory(parent);
    directoryChanged = false;
    transferred = true;
    return Object.freeze({ descriptor, identity });
  } finally {
    if (!transferred) {
      cleanupFailedLockPublication(
        path,
        stage,
        parent,
        descriptor,
        identity,
        targetLinked,
        directoryChanged,
      );
    }
  }
}

function writePrivateFile(path: string, bytes: Uint8Array): void {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(
    path,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | noFollow,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function lockClaimTargetSha256(path: string): string {
  return createHash("sha256")
    .update("portable-provider-plugin-lock", "utf8")
    .update("\0", "utf8")
    .update(path, "utf8")
    .digest("hex");
}

function lockClaimPrefix(targetSha256: string): string {
  return `.lock-claim-${targetSha256}-`;
}

function lockClaimName(
  parent: string,
  targetSha256: string,
  phase: PortableProviderPluginLockClaimPhase,
  claimId: string,
): string {
  return join(
    parent,
    `${lockClaimPrefix(targetSha256)}${phase}-${claimId}.json`,
  );
}

function parseLockClaimName(
  name: string,
  targetSha256: string,
): {
  readonly phase: PortableProviderPluginLockClaimPhase;
  readonly claimId: string;
} {
  const prefix = lockClaimPrefix(targetSha256);
  if (!name.startsWith(prefix)) {
    throw new Error("portable plugin lock claim does not match its target");
  }
  const match =
    /^(waiting|candidate|held)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u
      .exec(name.slice(prefix.length));
  if (match === null) {
    throw new Error("portable plugin lock claim filename is invalid");
  }
  return {
    phase: match[1] as PortableProviderPluginLockClaimPhase,
    claimId: match[2]!,
  };
}

function listLiveLockClaims(
  parent: string,
  targetSha256: string,
): readonly {
  readonly path: string;
  readonly phase: PortableProviderPluginLockClaimPhase;
  readonly claim: PortableProviderPluginLockClaimV1;
}[] {
  const prefix = lockClaimPrefix(targetSha256);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const names = readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .sort();
    if (names.length > MAX_LOCK_CLAIMS) {
      throw new Error("portable plugin lock claim count exceeds its bound");
    }
    let retry = false;
    let removedStaleClaim = false;
    const live: {
      readonly path: string;
      readonly phase: PortableProviderPluginLockClaimPhase;
      readonly claim: PortableProviderPluginLockClaimV1;
    }[] = [];
    for (const name of names) {
      const parsedName = parseLockClaimName(name, targetSha256);
      const path = join(parent, name);
      let snapshot: PrivateRecordSnapshot<
        PortableProviderPluginLockClaimV1
      > | null;
      try {
        snapshot = readPrivateRecordSnapshotIfPresent(
          path,
          "portable plugin lock arbitration claim",
          (value) => parseLockClaimRecord(
            value,
            targetSha256,
            parsedName.claimId,
          ),
        );
      } catch (error) {
        if (error instanceof PrivateRecordChangedDuringReadError) {
          retry = true;
          break;
        }
        throw error;
      }
      if (snapshot === null) {
        retry = true;
        break;
      }
      const status = stableProcessOwnerStatus(snapshot.value);
      if (status === "unknown") {
        throw new Error(
          "portable plugin lock arbitration owner cannot be inspected safely",
        );
      }
      if (status === "different-or-dead") {
        if (removeExactPrivateFile(
          path,
          snapshot.identity,
          "portable plugin lock arbitration claim",
        )) {
          removedStaleClaim = true;
        } else {
          retry = true;
          break;
        }
        continue;
      }
      live.push({
        path,
        phase: parsedName.phase,
        claim: snapshot.value,
      });
    }
    if (retry || removedStaleClaim) continue;
    return live;
  }
  throw new Error(
    "portable plugin lock claims did not reach a stable snapshot",
  );
}

function acquireLockClaim(path: string): (() => void) | null {
  const logicalLockPath = physicalPathThroughExistingParent(path);
  const parent = dirname(logicalLockPath);
  const targetSha256 = lockClaimTargetSha256(logicalLockPath);
  const claimId = randomUUID();
  const claim: PortableProviderPluginLockClaimV1 = Object.freeze({
    schemaVersion: PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION,
    kind: "portable-provider-plugin-lock-claim",
    targetSha256,
    claimId,
    pid: process.pid,
    ...currentProcessStartIdentity(),
  });
  let claimPath = lockClaimName(
    parent,
    targetSha256,
    "waiting",
    claimId,
  );
  reclaimDeadLockPublications(parent);
  const publication = publishPrivateLockFileExclusive(
    claimPath,
    Buffer.from(`${canonicalJson(claim)}\n`, "utf8"),
    claim,
    "claim",
    logicalLockPath,
  );
  if (publication === null) {
    throw new Error("portable plugin lock claim ID was already published");
  }
  const claimIdentity = publication.identity;
  const release = (): void => {
    removeExactPrivateFile(
      claimPath,
      claimIdentity,
      "portable plugin lock arbitration claim",
    );
  };
  try {
    closeSync(publication.descriptor);
    pauseAfterWaitingLockClaimForTest(logicalLockPath);
    const waiting = listLiveLockClaims(parent, targetSha256);
    if (
      waiting.some((candidate) =>
        candidate.claim.claimId !== claimId
        && (
          candidate.phase !== "waiting"
          || candidate.claim.claimId < claimId
        )
      )
    ) {
      release();
      return null;
    }

    const candidatePath = lockClaimName(
      parent,
      targetSha256,
      "candidate",
      claimId,
    );
    renameSync(claimPath, candidatePath);
    claimPath = candidatePath;
    syncDirectory(parent);
    const candidates = listLiveLockClaims(parent, targetSha256);
    if (
      candidates.some((candidate) =>
        candidate.claim.claimId !== claimId
        && (
          candidate.phase === "held"
          || candidate.claim.claimId < claimId
        )
      )
    ) {
      release();
      return null;
    }

    const heldPath = lockClaimName(
      parent,
      targetSha256,
      "held",
      claimId,
    );
    renameSync(claimPath, heldPath);
    claimPath = heldPath;
    syncDirectory(parent);
    const held = listLiveLockClaims(parent, targetSha256);
    if (
      held.some((candidate) =>
        candidate.claim.claimId !== claimId
        && candidate.phase === "held"
      )
    ) {
      throw new Error(
        "portable plugin lock arbitration admitted two owners",
      );
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function pauseBeforeLockClaimForTest(path: string): void {
  if (process.env.NODE_ENV !== "test") return;
  const readyPath = process.env.WRENCH_TEST_PLUGIN_LOCK_CLAIM_READY;
  const releasePath = process.env.WRENCH_TEST_PLUGIN_LOCK_CLAIM_RELEASE;
  const targetName = process.env.WRENCH_TEST_PLUGIN_LOCK_CLAIM_TARGET;
  if (
    readyPath === undefined
    || releasePath === undefined
    || targetName === undefined
    || basename(path) !== targetName
  ) {
    return;
  }
  writePrivateFile(readyPath, Buffer.from("ready\n", "utf8"));
  syncDirectory(dirname(readyPath));
  const deadline = Date.now() + TEST_BARRIER_TIMEOUT_MS;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error("portable plugin lock claim test barrier timed out");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function pauseAfterWaitingLockClaimForTest(path: string): void {
  if (process.env.NODE_ENV !== "test") return;
  const readyPath = process.env.WRENCH_TEST_PLUGIN_LOCK_WAITING_READY;
  const releasePath = process.env.WRENCH_TEST_PLUGIN_LOCK_WAITING_RELEASE;
  const targetName = process.env.WRENCH_TEST_PLUGIN_LOCK_WAITING_TARGET;
  if (
    readyPath === undefined
    || releasePath === undefined
    || targetName === undefined
    || basename(path) !== targetName
  ) {
    return;
  }
  if (existsSync(readyPath)) return;
  writePrivateFile(readyPath, Buffer.from("waiting\n", "utf8"));
  syncDirectory(dirname(readyPath));
  const deadline = Date.now() + TEST_BARRIER_TIMEOUT_MS;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error("portable plugin waiting-claim test barrier timed out");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function removeExactPrivateFile(
  path: string,
  expectedIdentity: ReturnType<typeof fstatSync>,
  label: string,
  changedMessage = `${label} changed during exact removal`,
): boolean {
  const parent = dirname(path);
  const quarantine = join(
    parent,
    `.lock-reclaim-${process.pid}-${randomUUID()}`,
  );
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  const moved = lstatSync(quarantine);
  if (
    moved.isSymbolicLink()
    || !moved.isFile()
    || !sameInodeIdentity(expectedIdentity, moved)
    || !ownedByCurrentUser(moved)
    || (moved.mode & 0o077) !== 0
  ) {
    try {
      linkSync(quarantine, path);
      unlinkSync(quarantine);
      syncDirectory(parent);
    } catch (error) {
      throw new Error(
        `${changedMessage} and could not be restored`,
        { cause: error },
      );
    }
    throw new Error(changedMessage);
  }
  unlinkSync(quarantine);
  syncDirectory(parent);
  return true;
}

function removeExactStaleLock<T>(
  path: string,
  snapshot: PrivateRecordSnapshot<T>,
  label: string,
): boolean {
  return removeExactPrivateFile(path, snapshot.identity, label);
}

function writeAtomicPrivateRecord(path: string, value: unknown): void {
  const parent = dirname(path);
  const temporary = join(
    parent,
    `.${basename(path)}.stage-${process.pid}-${randomUUID()}`,
  );
  try {
    writePrivateFile(
      temporary,
      Buffer.from(`${canonicalJson(value)}\n`, "utf8"),
    );
    renameSync(temporary, path);
    syncDirectory(parent);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeImmutablePrivateRecord<T>(
  path: string,
  value: T,
  label: string,
  parse: (candidate: unknown) => T,
): T {
  const parent = dirname(path);
  const temporary = join(
    parent,
    `.${basename(path)}.stage-${process.pid}-${randomUUID()}`,
  );
  try {
    writePrivateFile(
      temporary,
      Buffer.from(`${canonicalJson(value)}\n`, "utf8"),
    );
    try {
      linkSync(temporary, path);
      syncDirectory(parent);
      return value;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = readPrivateRecordIfPresent(path, label, parse);
      if (existing === null || canonicalJson(existing) !== canonicalJson(value)) {
        throw new Error(`${label} already exists with different content`);
      }
      return existing;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function ensureStore(root: string): PortableProviderPluginStorePaths {
  const paths = portableProviderPluginStorePaths(root);
  ensurePrivateDirectory(paths.root);
  ensurePrivateDirectory(paths.artifacts);
  ensurePrivateDirectory(paths.trust);
  ensurePrivateDirectory(paths.active);
  ensurePrivateDirectory(paths.locks);
  return paths;
}

function openStoreIfPresent(
  root: string,
): PortableProviderPluginStorePaths | null {
  const paths = portableProviderPluginStorePaths(root);
  if (!existsSync(paths.root)) return null;
  ensurePrivateDirectory(paths.root);
  for (const directory of [
    paths.artifacts,
    paths.trust,
    paths.active,
    paths.locks,
  ]) {
    if (!existsSync(directory)) {
      throw new Error("portable plugin store is missing a required directory");
    }
    ensurePrivateDirectory(directory);
  }
  return paths;
}

function writeVerifiedArtifact(
  artifactsRoot: string,
  source: VerifiedPortableProviderPluginPackage,
): string {
  const destination = join(artifactsRoot, source.bundleSha256);
  if (existsSync(destination)) {
    const existing = verifyPortableProviderPluginPackageDirectory(destination);
    if (existing.bundleSha256 !== source.bundleSha256) {
      throw new Error("installed portable plugin artifact digest is corrupt");
    }
    return destination;
  }
  const stage = join(
    artifactsRoot,
    `.stage-${source.bundleSha256}-${process.pid}-${randomUUID()}`,
  );
  mkdirSync(stage, { mode: 0o700 });
  chmodSync(stage, 0o700);
  try {
    for (const file of source.files) {
      const target = join(stage, ...file.path.split("/"));
      ensurePrivateDirectory(dirname(target));
      writePrivateFile(target, file.bytes);
    }
    writePrivateFile(
      join(stage, PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME),
      source.manifestBytes,
    );
    const staged = verifyPortableProviderPluginPackageDirectory(stage);
    if (staged.bundleSha256 !== source.bundleSha256) {
      throw new Error("staged portable plugin artifact digest changed");
    }
    try {
      renameSync(stage, destination);
      syncDirectory(artifactsRoot);
    } catch (error) {
      if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) {
        throw error;
      }
      const existing = verifyPortableProviderPluginPackageDirectory(destination);
      if (existing.bundleSha256 !== source.bundleSha256) {
        throw new Error("concurrent portable plugin artifact is corrupt");
      }
    }
    return destination;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function acquireOwnedLock<T extends ProcessOwnerIdentity>(
  path: string,
  value: T,
  options: {
    readonly label: string;
    readonly parse: (candidate: unknown) => T;
    readonly assertExisting?: (existing: T) => void;
    readonly liveOwnerMessage: string;
    readonly unknownOwnerMessage: string;
    readonly acquisitionFailureMessage: string;
    readonly changedBeforeReleaseMessage: string;
  },
): () => void {
  const lockPath = physicalPathThroughExistingParent(path);
  let descriptor: number | null = null;
  let owned: ReturnType<typeof fstatSync> | null = null;
  if (existsSync(lockPath)) pauseBeforeLockClaimForTest(lockPath);

  acquire: for (let claimAttempt = 0; claimAttempt < 64; claimAttempt += 1) {
    const releaseClaim = acquireLockClaim(lockPath);
    if (releaseClaim === null) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const publication = publishPrivateLockFileExclusive(
          lockPath,
          Buffer.from(`${canonicalJson(value)}\n`, "utf8"),
          value,
          "lock",
          lockPath,
        );
        if (publication !== null) {
          descriptor = publication.descriptor;
          owned = publication.identity;
          break acquire;
        }
        const existing = readPrivateRecordSnapshotIfPresent(
          lockPath,
          options.label,
          options.parse,
        );
        if (existing === null) continue;
        options.assertExisting?.(existing.value);
        const status = processOwnerStatus(existing.value);
        if (status === "exact-live-owner") {
          throw new Error(options.liveOwnerMessage);
        }
        if (status === "unknown") {
          throw new Error(options.unknownOwnerMessage);
        }
        removeExactStaleLock(lockPath, existing, options.label);
      }
    } finally {
      releaseClaim();
    }
  }
  if (descriptor === null || owned === null) {
    throw new Error(options.acquisitionFailureMessage);
  }
  const ownedDescriptor = descriptor;
  const ownedIdentity = owned;
  return () => {
    try {
      if (!removeExactPrivateFile(
        lockPath,
        ownedIdentity,
        options.label,
        options.changedBeforeReleaseMessage,
      )) {
        throw new Error(options.changedBeforeReleaseMessage);
      }
    } finally {
      closeSync(ownedDescriptor);
    }
  };
}

function acquirePluginLock(
  path: string,
  id: string,
  now: Date,
): () => void {
  const processIdentity = currentProcessStartIdentity();
  const lock: PortableProviderPluginLockRecordV1 = Object.freeze({
    schemaVersion: PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION,
    pluginId: id,
    acquiredAt: canonicalNow(now),
    pid: process.pid,
    ...processIdentity,
  });
  return acquireOwnedLock(path, lock, {
    label: "portable plugin activation lock",
    parse: parseLockRecord,
    assertExisting: (existing) => {
      if (existing.pluginId !== id) {
        throw new Error(
          "portable plugin activation lock does not match its filename",
        );
      }
    },
    liveOwnerMessage: "portable plugin activation is already locked",
    unknownOwnerMessage:
      "portable plugin activation lock owner cannot be inspected safely",
    acquisitionFailureMessage:
      "portable plugin activation lock could not be acquired",
    changedBeforeReleaseMessage:
      "portable plugin activation lock changed before release",
  });
}

function acquireCatalogMutationLock(
  paths: PortableProviderPluginStorePaths,
  now: Date,
): () => void {
  const processIdentity = currentProcessStartIdentity();
  const lock: PortableProviderPluginCatalogLockRecordV1 = Object.freeze({
    schemaVersion: PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION,
    scope: "catalog-mutation",
    acquiredAt: canonicalNow(now),
    pid: process.pid,
    ...processIdentity,
  });
  return acquireOwnedLock(
    join(paths.locks, CATALOG_MUTATION_LOCK_NAME),
    lock,
    {
      label: "portable plugin catalog mutation lock",
      parse: parseCatalogLockRecord,
      liveOwnerMessage:
        "portable plugin catalog mutation is already locked",
      unknownOwnerMessage:
        "portable plugin catalog mutation lock owner cannot be inspected safely",
      acquisitionFailureMessage:
        "portable plugin catalog mutation lock could not be acquired",
      changedBeforeReleaseMessage:
        "portable plugin catalog mutation lock changed before release",
    },
  );
}

function runSynchronousCatalogOperation<T>(operation: () => T): T {
  const result = operation();
  if (result instanceof Promise) {
    throw new Error(
      "portable plugin catalog lock callback must complete synchronously",
    );
  }
  return result;
}

function withCatalogMutationLock<T>(
  paths: PortableProviderPluginStorePaths,
  now: Date,
  operation: () => T,
): T {
  const lockPath = join(paths.locks, CATALOG_MUTATION_LOCK_NAME);
  if (activeCatalogMutationLocks.has(lockPath)) {
    return runSynchronousCatalogOperation(operation);
  }
  const release = acquireCatalogMutationLock(paths, now);
  activeCatalogMutationLocks.add(lockPath);
  try {
    return runSynchronousCatalogOperation(operation);
  } finally {
    activeCatalogMutationLocks.delete(lockPath);
    release();
  }
}

/**
 * Serialize a synchronous kernel transition against every portable-plugin
 * activation mutation. The callback receives no auth or session material.
 */
export function withPortableProviderPluginCatalogLock<T>(
  storeRoot: string,
  now: Date,
  operation: () => T,
): T {
  return withCatalogMutationLock(ensureStore(storeRoot), now, operation);
}

function withPluginMutationLocks<T>(
  paths: PortableProviderPluginStorePaths,
  id: string,
  now: Date,
  operation: () => T,
): T {
  return withCatalogMutationLock(paths, now, () => {
    if (activePluginMutations.has(paths.root)) {
      throw new Error("portable plugin catalog mutation cannot be nested");
    }
    activePluginMutations.add(paths.root);
    try {
      const releasePlugin = acquirePluginLock(
        join(paths.locks, `${id}.lock`),
        id,
        now,
      );
      try {
        return operation();
      } finally {
        releasePlugin();
      }
    } finally {
      activePluginMutations.delete(paths.root);
    }
  });
}

export function assertPortableProviderPluginTrustApprovalMatches(
  approval: PortableProviderPluginTrustApprovalV1,
  source: VerifiedPortableProviderPluginPackage,
): void {
  if (
    approval.pluginId !== source.manifest.id
    || approval.pluginVersion !== source.manifest.version
    || approval.bundleSha256 !== source.bundleSha256
  ) {
    throw new Error(
      "portable plugin trust approval does not match the verified package identity",
    );
  }
}

function assertExpectedActive(
  current: PortableProviderPluginActiveRecordV1 | null,
  expectedBundleSha256: string | null,
): void {
  if (expectedBundleSha256 === null) {
    if (current !== null) {
      throw new Error(
        "portable plugin activation changed: an installed version already exists",
      );
    }
    return;
  }
  const expected = sha256(
    expectedBundleSha256,
    "expected active plugin bundle digest",
  );
  if (current?.bundleSha256 !== expected) {
    throw new Error(
      "portable plugin activation changed from its expected bundle digest",
    );
  }
}

function canonicalNow(now: Date): string {
  const value = now.toISOString();
  return timestamp(value, "portable plugin store time");
}

function runAssertActivatable(
  hook: PortableProviderPluginAssertActivatable,
  verifiedPackage: VerifiedPortableProviderPluginPackage,
): void {
  const result: unknown = hook(verifiedPackage);
  if (result !== undefined) {
    throw new Error(
      "portable plugin activatability hook must complete synchronously without returning a value",
    );
  }
}

function runAssertQuiescent(
  hook: PortableProviderPluginAssertQuiescent,
  bundleSha256: string,
  artifactPath: string,
): void {
  const result: unknown = hook(bundleSha256, artifactPath);
  if (result !== undefined) {
    throw new Error(
      "portable plugin quiescence hook must complete synchronously without returning a value",
    );
  }
}

function trustMatchesPackage(
  trust: PortableProviderPluginTrustRecordV1,
  packageValue: VerifiedPortableProviderPluginPackage,
): boolean {
  return (
    trust.bundleSha256 === packageValue.bundleSha256
    && trust.pluginId === packageValue.manifest.id
    && trust.pluginVersion === packageValue.manifest.version
    && trust.hostApiVersion === packageValue.manifest.hostApiVersion
    && trust.manifestSha256 === packageValue.manifestSha256
    && canonicalJson(trust.provenance)
      === canonicalJson(packageValue.manifest.provenance)
  );
}

export function installPortableProviderPluginPackage(
  sourcePath: string,
  options: {
    readonly storeRoot: string;
    readonly approval: unknown;
    /**
     * `null` means the plugin must be absent. An update must name the exact
     * currently active digest; blind replacement is intentionally unsupported.
     */
    readonly expectedCurrentBundleSha256: string | null;
    /**
     * Kernel catalog check. It receives only the verified immutable package
     * and runs under the catalog-wide mutation lock.
     */
    readonly assertActivatable: PortableProviderPluginAssertActivatable;
    /**
     * Kernel lease/journal check for the exact activation being replaced. It is
     * required for a uniform fail-closed API and invoked only for an update.
     */
    readonly assertCurrentQuiescent: PortableProviderPluginAssertQuiescent;
    readonly now?: Date;
    /** Test seam for a deterministic activation race. */
    readonly beforeActivate?: () => void;
  },
): InstalledPortableProviderPlugin {
  const source = verifyPortableProviderPluginPackageDirectory(sourcePath);
  const approval = parsePortableProviderPluginTrustApproval(options.approval);
  assertPortableProviderPluginTrustApprovalMatches(approval, source);
  const paths = ensureStore(options.storeRoot);
  const nowValue = options.now ?? new Date();
  return withPluginMutationLocks(
    paths,
    source.manifest.id,
    nowValue,
    () => {
      const activePath = join(paths.active, `${source.manifest.id}.json`);
      const current = readPrivateRecordIfPresent(
        activePath,
        "portable plugin active record",
        parseActiveRecord,
      );
      assertExpectedActive(current, options.expectedCurrentBundleSha256);
      const currentInstallation = current === null
        ? null
        : loadInstalledWithPaths(paths, source.manifest.id);
      if (current !== null && currentInstallation === null) {
        throw new Error("current portable plugin installation is incomplete");
      }

      const artifactPath = writeVerifiedArtifact(paths.artifacts, source);
      const storedPackage =
        verifyPortableProviderPluginPackageDirectory(artifactPath);
      if (storedPackage.bundleSha256 !== source.bundleSha256) {
        throw new Error("installed portable plugin artifact digest changed");
      }
      const now = canonicalNow(nowValue);
      const trust: PortableProviderPluginTrustRecordV1 = Object.freeze({
        schemaVersion: PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION,
        decision: "trust-executable-code",
        pluginId: source.manifest.id,
        pluginVersion: source.manifest.version,
        hostApiVersion: source.manifest.hostApiVersion,
        bundleSha256: source.bundleSha256,
        manifestSha256: source.manifestSha256,
        provenance: source.manifest.provenance,
        trustedAt: now,
      });
      const trustPath = join(paths.trust, `${source.bundleSha256}.json`);
      const existingTrust = readPrivateRecordIfPresent(
        trustPath,
        "portable plugin trust record",
        parseTrustRecord,
      );
      if (
        existingTrust !== null
        && !trustMatchesPackage(existingTrust, source)
      ) {
        throw new Error(
          "portable plugin trust record does not match its content-addressed package",
        );
      }
      const storedTrust = existingTrust ?? writeImmutablePrivateRecord(
        trustPath,
        trust,
        "portable plugin trust record",
        parseTrustRecord,
      );
      const active: PortableProviderPluginActiveRecordV1 = Object.freeze({
        schemaVersion: PORTABLE_PROVIDER_PLUGIN_STORE_SCHEMA_VERSION,
        pluginId: source.manifest.id,
        pluginVersion: source.manifest.version,
        bundleSha256: source.bundleSha256,
        activatedAt: now,
        status: "enabled",
      });
      options.beforeActivate?.();
      const currentAfterWork = readPrivateRecordIfPresent(
        activePath,
        "portable plugin active record",
        parseActiveRecord,
      );
      if (canonicalJson(currentAfterWork) !== canonicalJson(current)) {
        throw new Error(
          "portable plugin activation changed during installation",
        );
      }
      runAssertActivatable(options.assertActivatable, storedPackage);
      const currentAfterHook = readPrivateRecordIfPresent(
        activePath,
        "portable plugin active record",
        parseActiveRecord,
      );
      if (canonicalJson(currentAfterHook) !== canonicalJson(current)) {
        throw new Error(
          "portable plugin activation changed during activatability check",
        );
      }
      if (currentInstallation !== null) {
        runAssertQuiescent(
          options.assertCurrentQuiescent,
          currentInstallation.package.bundleSha256,
          currentInstallation.artifactPath,
        );
      }
      const currentAfterQuiescence = readPrivateRecordIfPresent(
        activePath,
        "portable plugin active record",
        parseActiveRecord,
      );
      if (
        canonicalJson(currentAfterQuiescence) !== canonicalJson(current)
      ) {
        throw new Error(
          "portable plugin activation changed during current-bundle quiescence check",
        );
      }
      if (currentInstallation !== null) {
        const installationAfterQuiescence = loadInstalledWithPaths(
          paths,
          source.manifest.id,
        );
        if (
          installationAfterQuiescence === null
          || installationAfterQuiescence.package.bundleSha256
            !== currentInstallation.package.bundleSha256
          || installationAfterQuiescence.artifactPath
            !== currentInstallation.artifactPath
        ) {
          throw new Error(
            "current portable plugin artifact changed during quiescence check",
          );
        }
      }
      const packageAfterHook =
        verifyPortableProviderPluginPackageDirectory(artifactPath);
      if (packageAfterHook.bundleSha256 !== source.bundleSha256) {
        throw new Error(
          "portable plugin artifact changed during activatability check",
        );
      }
      writeAtomicPrivateRecord(activePath, active);
      return Object.freeze({
        artifactPath,
        package: packageAfterHook,
        trust: storedTrust,
        active,
      });
    },
  );
}

export function disablePortableProviderPluginPackage(
  storeRoot: string,
  id: string,
  options: {
    readonly expectedBundleSha256: string;
    /**
     * Kernel lease/journal check. It receives only immutable artifact identity
     * and runs under the catalog-wide mutation lock.
     */
    readonly assertQuiescent: PortableProviderPluginAssertQuiescent;
    readonly now?: Date;
  },
): InstalledPortableProviderPlugin {
  const paths = openStoreIfPresent(storeRoot);
  if (paths === null) {
    throw new Error("portable plugin is not installed");
  }
  const safeId = pluginId(id, "installed plugin ID");
  const nowValue = options.now ?? new Date();
  return withPluginMutationLocks(
    paths,
    safeId,
    nowValue,
    () => {
      const activePath = join(paths.active, `${safeId}.json`);
      const current = readPrivateRecordIfPresent(
        activePath,
        "portable plugin active record",
        parseActiveRecord,
      );
      if (current === null) throw new Error("portable plugin is not installed");
      assertExpectedActive(current, options.expectedBundleSha256);
      const installed = loadInstalledWithPaths(paths, safeId);
      if (installed === null) throw new Error("portable plugin is not installed");
      if (current.status === "disabled") return installed;
      const disabled: PortableProviderPluginActiveRecordV1 = Object.freeze({
        ...current,
        status: "disabled",
        disabledAt: canonicalNow(nowValue),
      });
      runAssertQuiescent(
        options.assertQuiescent,
        installed.package.bundleSha256,
        installed.artifactPath,
      );
      const installedAfterHook = loadInstalledWithPaths(paths, safeId);
      if (
        installedAfterHook === null
        || canonicalJson(installedAfterHook.active) !== canonicalJson(current)
        || installedAfterHook.package.bundleSha256
          !== installed.package.bundleSha256
        || installedAfterHook.artifactPath !== installed.artifactPath
      ) {
        throw new Error(
          "portable plugin installation changed during quiescence check",
        );
      }
      writeAtomicPrivateRecord(activePath, disabled);
      return Object.freeze({ ...installedAfterHook, active: disabled });
    },
  );
}

export function removePortableProviderPluginPackage(
  storeRoot: string,
  id: string,
  options: {
    readonly expectedBundleSha256: string;
    /**
     * Kernel lease/journal check. It receives only immutable artifact identity
     * and runs under the catalog-wide mutation lock.
     */
    readonly assertQuiescent: PortableProviderPluginAssertQuiescent;
    readonly now?: Date;
  },
): InstalledPortableProviderPlugin {
  const paths = openStoreIfPresent(storeRoot);
  if (paths === null) {
    throw new Error("portable plugin is not installed");
  }
  const safeId = pluginId(id, "installed plugin ID");
  const nowValue = options.now ?? new Date();
  return withPluginMutationLocks(
    paths,
    safeId,
    nowValue,
    () => {
      const activePath = join(paths.active, `${safeId}.json`);
      const current = readPrivateRecordIfPresent(
        activePath,
        "portable plugin active record",
        parseActiveRecord,
      );
      if (current === null) throw new Error("portable plugin is not installed");
      assertExpectedActive(current, options.expectedBundleSha256);
      const installed = loadInstalledWithPaths(paths, safeId);
      if (installed === null) throw new Error("portable plugin is not installed");
      runAssertQuiescent(
        options.assertQuiescent,
        installed.package.bundleSha256,
        installed.artifactPath,
      );
      const installedAfterHook = loadInstalledWithPaths(paths, safeId);
      if (
        installedAfterHook === null
        || canonicalJson(installedAfterHook.active) !== canonicalJson(current)
        || installedAfterHook.package.bundleSha256
          !== installed.package.bundleSha256
        || installedAfterHook.artifactPath !== installed.artifactPath
      ) {
        throw new Error(
          "portable plugin installation changed during quiescence check",
        );
      }
      unlinkSync(activePath);
      syncDirectory(paths.active);
      return installedAfterHook;
    },
  );
}

function loadInstalledWithPaths(
  paths: PortableProviderPluginStorePaths,
  id: string,
): InstalledPortableProviderPlugin | null {
  const safeId = pluginId(id, "installed plugin ID");
  const active = readPrivateRecordIfPresent(
    join(paths.active, `${safeId}.json`),
    "portable plugin active record",
    parseActiveRecord,
  );
  if (active === null) return null;
  if (active.pluginId !== safeId) {
    throw new Error("portable plugin active record does not match its filename");
  }
  const artifactPath = join(paths.artifacts, active.bundleSha256);
  const packageValue =
    verifyPortableProviderPluginPackageDirectory(artifactPath);
  const trust = readPrivateRecordIfPresent(
    join(paths.trust, `${active.bundleSha256}.json`),
    "portable plugin trust record",
    parseTrustRecord,
  );
  if (trust === null) {
    throw new Error("active portable plugin has no executable-code trust record");
  }
  if (
    packageValue.bundleSha256 !== active.bundleSha256
    || packageValue.manifest.id !== active.pluginId
    || packageValue.manifest.version !== active.pluginVersion
    || !trustMatchesPackage(trust, packageValue)
  ) {
    throw new Error(
      "portable plugin artifact, trust, and active records do not share one exact identity",
    );
  }
  return Object.freeze({
    artifactPath,
    package: packageValue,
    trust,
    active,
  });
}

export function loadInstalledPortableProviderPlugin(
  storeRoot: string,
  id: string,
): InstalledPortableProviderPlugin | null {
  const paths = openStoreIfPresent(storeRoot);
  if (paths === null) return null;
  const installed = loadInstalledWithPaths(paths, id);
  return installed?.active.status === "enabled" ? installed : null;
}

export function loadPortableProviderPluginInstallation(
  storeRoot: string,
  id: string,
): InstalledPortableProviderPlugin | null {
  const paths = openStoreIfPresent(storeRoot);
  return paths === null ? null : loadInstalledWithPaths(paths, id);
}

export function listPortableProviderPluginInstallations(
  storeRoot: string,
): readonly InstalledPortableProviderPlugin[] {
  const paths = openStoreIfPresent(storeRoot);
  if (paths === null) return Object.freeze([]);
  const ids: string[] = [];
  for (const entry of readdirSync(paths.active, { withFileTypes: true })) {
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || !entry.name.endsWith(".json")
    ) {
      throw new Error(
        `portable plugin active store contains unexpected entry ${entry.name}`,
      );
    }
    ids.push(
      pluginId(
        entry.name.slice(0, -".json".length),
        "installed plugin filename",
      ),
    );
  }
  ids.sort();
  return Object.freeze(
    ids.map((id) => {
      const installed = loadInstalledWithPaths(paths, id);
      if (installed === null) {
        throw new Error("portable plugin disappeared while listing the store");
      }
      return installed;
    }),
  );
}

export function listInstalledPortableProviderPlugins(
  storeRoot: string,
): readonly InstalledPortableProviderPlugin[] {
  return Object.freeze(
    listPortableProviderPluginInstallations(storeRoot)
      .filter((installed) => installed.active.status === "enabled"),
  );
}
