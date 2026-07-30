import { basename, join } from "node:path";

import {
  createPrivateJsonIfAbsent,
  createPrivateStateDirectory,
  ensurePrivateStateDirectory,
  listPrivateStateDirectory,
  readPrivateStateFileIfPresent,
  removePrivateStateDirectoryTree,
  wrenchStateHome,
  type PrivateDirectoryIdentity,
  type PrivateStateDirectoryEntry,
} from "./storage";

const snapshotDirectoryName = "browser-snapshots";
const snapshotNamePattern = /^capture-(\d{1,10})-(\d{1,16})-([0-9a-f]{32})$/u;
const quarantineNamePattern = /^\.io-remove-(\d{1,10})-(\d{1,16})-([0-9a-f]{32})\.quarantine$/u;
const ownerMarkerName = ".io-browser-snapshot.json";
const ownerMarkerMaximumBytes = 512;
const maximumSnapshotEntries = 256;
const maximumFutureSkewMs = 5 * 60_000;
export const BROWSER_SNAPSHOT_GC_GRACE_MS = 15 * 60_000;

type SnapshotOwner = {
  readonly schemaVersion: 1;
  readonly kind: "io-browser-snapshot";
  readonly pid: number;
  readonly createdAtMs: number;
  readonly nonce: string;
};

type RecoverableDirectoryOwner = {
  readonly pid: number;
  readonly createdAtMs: number;
};

type BrowserSnapshotRoot = {
  readonly path: string;
  readonly identity: PrivateDirectoryIdentity;
};

export type BrowserSnapshotDirectory = {
  readonly path: string;
  readonly identity: PrivateDirectoryIdentity;
  readonly rootIdentity: PrivateDirectoryIdentity;
};

/** Deterministic adversarial-test seams. Production callers must leave these unset. */
export type BrowserSnapshotGcHooks = {
  readonly beforeScan?: (root: Readonly<BrowserSnapshotRoot>) => void;
  readonly beforeMarkerRead?: (
    root: Readonly<BrowserSnapshotRoot>,
    entry: Readonly<PrivateStateDirectoryEntry>,
  ) => void;
};

function ensureSnapshotRoot(
  environment: Readonly<Record<string, string | undefined>>,
): BrowserSnapshotRoot {
  const path = join(wrenchStateHome(environment), snapshotDirectoryName);
  return { path, identity: ensurePrivateStateDirectory(path, environment) };
}

function parsePositiveSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value ? parsed : null;
}

function parseNonnegativeSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value ? parsed : null;
}

function snapshotOwnerFromName(name: string): SnapshotOwner | null {
  const match = snapshotNamePattern.exec(name);
  if (match === null) return null;
  const pid = parsePositiveSafeInteger(match[1] ?? "");
  const createdAtMs = parseNonnegativeSafeInteger(match[2] ?? "");
  const nonce = match[3];
  if (pid === null || createdAtMs === null || nonce === undefined) return null;
  return { schemaVersion: 1, kind: "io-browser-snapshot", pid, createdAtMs, nonce };
}

function quarantineOwnerFromName(name: string): RecoverableDirectoryOwner | null {
  const match = quarantineNamePattern.exec(name);
  if (match === null) return null;
  const pid = parsePositiveSafeInteger(match[1] ?? "");
  const createdAtMs = parseNonnegativeSafeInteger(match[2] ?? "");
  return pid === null || createdAtMs === null ? null : { pid, createdAtMs };
}

function parseOwnerMarker(content: string): SnapshotOwner {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error("wrench browser-snapshot owner marker is unreadable", { cause: error });
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "createdAtMs,kind,nonce,pid,schemaVersion"
    || !("schemaVersion" in value)
    || value.schemaVersion !== 1
    || !("kind" in value)
    || value.kind !== "io-browser-snapshot"
    || !("pid" in value)
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) < 1
    || !("createdAtMs" in value)
    || !Number.isSafeInteger(value.createdAtMs)
    || Number(value.createdAtMs) < 0
    || !("nonce" in value)
    || typeof value.nonce !== "string"
    || !/^[0-9a-f]{32}$/u.test(value.nonce)
  ) throw new Error("wrench browser-snapshot owner marker is malformed");
  return value as SnapshotOwner;
}

function sameOwner(left: Readonly<SnapshotOwner>, right: Readonly<SnapshotOwner>): boolean {
  return left.pid === right.pid
    && left.createdAtMs === right.createdAtMs
    && left.nonce === right.nonce;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { readonly code?: unknown }).code === "ESRCH"
    );
  }
}

function shouldRetain(owner: Readonly<RecoverableDirectoryOwner>, nowMs: number): boolean {
  if (owner.createdAtMs > nowMs + maximumFutureSkewMs) {
    throw new Error("wrench browser-snapshot recovery metadata is from the future");
  }
  if (nowMs - owner.createdAtMs < BROWSER_SNAPSHOT_GC_GRACE_MS) return true;
  return owner.pid === process.pid || processIsAlive(owner.pid);
}

function removeBoundDirectory(
  root: Readonly<BrowserSnapshotRoot>,
  entry: Readonly<PrivateStateDirectoryEntry>,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (entry.kind !== "directory" || entry.identity === undefined) {
    throw new Error("wrench browser-snapshot root contains an unrecognized entry");
  }
  return removePrivateStateDirectoryTree(
    join(root.path, entry.name),
    environment,
    entry.identity,
    root.identity,
  );
}

function purgeBoundBrowserSnapshots(
  root: Readonly<BrowserSnapshotRoot>,
  environment: Readonly<Record<string, string | undefined>>,
  nowMs: number,
  hooks: Readonly<BrowserSnapshotGcHooks>,
): number {
  hooks.beforeScan?.(root);
  const entries = listPrivateStateDirectory(root.path, environment, root.identity);
  if (entries.length > maximumSnapshotEntries) {
    throw new Error(`wrench browser-snapshot root exceeds ${maximumSnapshotEntries} entries`);
  }
  let removed = 0;
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.kind !== "directory" || entry.identity === undefined) {
      throw new Error("wrench browser-snapshot root contains an unrecognized entry");
    }
    const quarantineOwner = quarantineOwnerFromName(entry.name);
    if (quarantineOwner !== null) {
      if (!shouldRetain(quarantineOwner, nowMs) && removeBoundDirectory(root, entry, environment)) removed += 1;
      continue;
    }
    const nameOwner = snapshotOwnerFromName(entry.name);
    if (nameOwner === null) throw new Error("wrench browser-snapshot root contains an unrecognized entry");
    hooks.beforeMarkerRead?.(root, entry);
    const marker = readPrivateStateFileIfPresent(
      join(root.path, entry.name, ownerMarkerName),
      ownerMarkerMaximumBytes,
      "browser-snapshot owner marker",
      environment,
      [root.identity, entry.identity],
    );
    if (marker !== null && !sameOwner(parseOwnerMarker(marker), nameOwner)) {
      throw new Error("wrench browser-snapshot owner marker does not match its directory");
    }
    if (!shouldRetain(nameOwner, nowMs) && removeBoundDirectory(root, entry, environment)) removed += 1;
  }
  return removed;
}

export function purgeOrphanedBrowserSnapshots(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  nowMs = Date.now(),
  hooks: Readonly<BrowserSnapshotGcHooks> = {},
): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("browser-snapshot GC time is invalid");
  return purgeBoundBrowserSnapshots(ensureSnapshotRoot(environment), environment, nowMs, hooks);
}

export function createBrowserSnapshotDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  nowMs = Date.now(),
): BrowserSnapshotDirectory {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("browser-snapshot creation time is invalid");
  const root = ensureSnapshotRoot(environment);
  purgeBoundBrowserSnapshots(root, environment, nowMs, {});
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const owner: SnapshotOwner = {
    schemaVersion: 1,
    kind: "io-browser-snapshot",
    pid: process.pid,
    createdAtMs: nowMs,
    nonce,
  };
  const path = join(root.path, `capture-${owner.pid}-${owner.createdAtMs}-${owner.nonce}`);
  const snapshot: BrowserSnapshotDirectory = {
    path,
    identity: createPrivateStateDirectory(path, environment, root.identity),
    rootIdentity: root.identity,
  };
  try {
    const marker = createPrivateJsonIfAbsent(join(path, ownerMarkerName), owner, {
      environment,
      expectedStateDirectories: [root.identity, snapshot.identity],
    });
    if (!marker.created) throw new Error("browser-snapshot owner marker already exists");
    return snapshot;
  } catch (error) {
    removePrivateStateDirectoryTree(path, environment, snapshot.identity, root.identity);
    throw error;
  }
}

export function removeBrowserSnapshotDirectory(
  snapshot: Readonly<BrowserSnapshotDirectory>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (snapshotOwnerFromName(basename(snapshot.path)) === null) {
    throw new Error("refusing to remove an unrecognized browser snapshot");
  }
  removePrivateStateDirectoryTree(
    snapshot.path,
    environment,
    snapshot.identity,
    snapshot.rootIdentity,
  );
}
