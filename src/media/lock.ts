import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LOCK_SCHEMA_VERSION = 1 as const;
const MAX_LOCK_BYTES = 4 * 1024;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const MAX_RECLAIM_ATTEMPTS = 8;

interface LockOwner {
  readonly version: typeof LOCK_SCHEMA_VERSION;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

interface RegularObservedLock {
  readonly kind: "regular";
  readonly dev: number;
  readonly ino: number;
  readonly modifiedAtMs: number;
  readonly owner: LockOwner | null;
}

interface UnsafeObservedLock {
  readonly kind: "unsafe";
}

type ObservedLock = RegularObservedLock | UnsafeObservedLock;

export interface ItemLock {
  readonly path: string;
  readonly assertOwned: () => Promise<void>;
  readonly release: () => Promise<void>;
}

export interface ItemLockDependencies {
  readonly pid: number;
  readonly now: () => Date;
  readonly token: () => string;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly staleAfterMs: number;
  readonly heartbeatMs: number;
  /** Deterministic race seam after a lock path is moved to a tombstone. */
  readonly afterTombstoneMove?: (tombstone: string, lockPath: string) => Promise<void>;
}

export class ItemLockBusyError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super("this item is already being archived");
    this.name = "ItemLockBusyError";
    this.lockPath = lockPath;
  }
}

export class ItemLockLostError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super("the item lock is no longer owned by this process");
    this.name = "ItemLockLostError";
    this.lockPath = lockPath;
  }
}

const defaultDependencies: ItemLockDependencies = {
  pid: process.pid,
  now: () => new Date(),
  token: () => randomUUID(),
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isErrno(error, "EPERM");
    }
  },
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
  heartbeatMs: DEFAULT_HEARTBEAT_MS,
};

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function parseOwner(value: unknown): LockOwner | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const version = record["version"];
  const pid = record["pid"];
  const token = record["token"];
  const acquiredAt = record["acquiredAt"];
  if (
    version !== LOCK_SCHEMA_VERSION
    || typeof pid !== "number"
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || typeof token !== "string"
    || !/^[0-9a-f-]{16,64}$/iu.test(token)
    || typeof acquiredAt !== "string"
    || Number.isNaN(Date.parse(acquiredAt))
  ) return null;
  return { version, pid, token, acquiredAt };
}

async function observeLock(path: string): Promise<ObservedLock | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_LOCK_BYTES) {
    return { kind: "unsafe" };
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return isErrno(error, "ENOENT") ? null : { kind: "unsafe" };
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size !== metadata.size
      || opened.size > MAX_LOCK_BYTES
    ) {
      return { kind: "unsafe" };
    }
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) return { kind: "unsafe" };
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, opened.size)).bytesRead !== 0) {
      return { kind: "unsafe" };
    }
    const [finished, finalPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !finalPath.isFile()
      || finalPath.isSymbolicLink()
      || finalPath.dev !== opened.dev
      || finalPath.ino !== opened.ino
      || finalPath.size !== opened.size
      || finished.size !== opened.size
      || finished.mtimeMs !== opened.mtimeMs
      || finished.ctimeMs !== opened.ctimeMs
    ) {
      return { kind: "unsafe" };
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      value = null;
    }
    return {
      kind: "regular",
      dev: opened.dev,
      ino: opened.ino,
      modifiedAtMs: opened.mtimeMs,
      owner: parseOwner(value),
    };
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: RegularObservedLock, right: RegularObservedLock): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function restoreUnexpectedLock(tombstone: string, lockPath: string): Promise<void> {
  try {
    // POSIX rename would overwrite a lock created after the tombstone move.
    // Hard-link restoration is atomic and fails without clobbering that owner.
    await link(tombstone, lockPath);
  } catch {
    return;
  }
  try {
    await unlink(tombstone);
  } catch {
    // Both names still identify the same inode. Leaving the quarantine name is
    // safer than removing an entry after another path race.
  }
}

async function reclaimObservedLock(
  lockPath: string,
  observed: RegularObservedLock,
  token: string,
  dependencies: ItemLockDependencies,
): Promise<boolean> {
  const tombstone = `${lockPath}.stale-${token}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST")) return false;
    throw error;
  }
  await dependencies.afterTombstoneMove?.(tombstone, lockPath);
  const moved = await observeLock(tombstone);
  if (moved === null || moved.kind !== "regular" || !sameIdentity(observed, moved)) {
    await restoreUnexpectedLock(tombstone, lockPath);
    return false;
  }
  await unlink(tombstone);
  return true;
}

async function releaseOwnedLock(
  lockPath: string,
  owner: LockOwner,
  dependencies: ItemLockDependencies,
): Promise<void> {
  const tombstone = `${lockPath}.release-${owner.token}`;
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  await dependencies.afterTombstoneMove?.(tombstone, lockPath);
  const moved = await observeLock(tombstone);
  if (moved?.kind !== "regular" || moved.owner?.token !== owner.token) {
    await restoreUnexpectedLock(tombstone, lockPath);
    return;
  }
  await unlink(tombstone);
}

export async function acquireItemLock(
  lockPathInput: string,
  dependencies: ItemLockDependencies = defaultDependencies,
): Promise<ItemLock> {
  const lockPath = resolve(lockPathInput);
  if (dirname(lockPath) === lockPath) throw new Error("item lock must name a file");

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    const owner: LockOwner = {
      version: LOCK_SCHEMA_VERSION,
      pid: dependencies.pid,
      token: dependencies.token(),
      acquiredAt: dependencies.now().toISOString(),
    };
    let handle;
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const observed = await observeLock(lockPath);
      if (observed === null) continue;
      if (observed.kind === "unsafe") throw new ItemLockBusyError(lockPath);
      const ageMs = Math.max(0, dependencies.now().getTime() - observed.modifiedAtMs);
      const ownerAlive = observed.owner === null
        ? false
        : dependencies.isProcessAlive(observed.owner.pid);
      if (
        (observed.owner === null && ageMs <= dependencies.staleAfterMs)
        || ownerAlive
      ) {
        throw new ItemLockBusyError(lockPath);
      }
      if (await reclaimObservedLock(lockPath, observed, owner.token, dependencies)) continue;
      continue;
    }

    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: "utf8" });
      await handle.sync();
    } catch (error) {
      await handle.close();
      await releaseOwnedLock(lockPath, owner, dependencies);
      throw error;
    }

    const timer = setInterval(() => {
      const now = dependencies.now();
      void handle.utimes(now, now).catch(() => undefined);
    }, dependencies.heartbeatMs);
    timer.unref();
    let released = false;
    return {
      path: lockPath,
      assertOwned: async () => {
        const observed = await observeLock(lockPath);
        if (observed?.kind !== "regular" || observed.owner?.token !== owner.token) {
          throw new ItemLockLostError(lockPath);
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        await handle.close();
        await releaseOwnedLock(lockPath, owner, dependencies);
      },
    };
  }
  throw new ItemLockBusyError(lockPath);
}
