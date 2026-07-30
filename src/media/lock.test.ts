import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ItemLockBusyError,
  ItemLockLostError,
  acquireItemLock,
  type ItemLockDependencies,
} from "./lock";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "media-lock-test-"));
  roots.push(root);
  return { root, lockPath: join(root, "youtube-item.lock") };
}

function dependencies(overrides: Partial<ItemLockDependencies> = {}): ItemLockDependencies {
  let sequence = 0;
  return {
    pid: 1234,
    now: () => new Date("2026-07-21T12:00:00.000Z"),
    token: () => `00000000-0000-4000-8000-${String(sequence += 1).padStart(12, "0")}`,
    isProcessAlive: () => true,
    staleAfterMs: 60_000,
    heartbeatMs: 60_000,
    ...overrides,
  };
}

async function expectBusy(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected lock acquisition to be busy");
  } catch (error) {
    expect(error).toBeInstanceOf(ItemLockBusyError);
  }
}

describe("item locks", () => {
  test("exclude a live owner, release idempotently, and permit reacquisition", async () => {
    const { lockPath } = await fixture();
    const first = await acquireItemLock(lockPath, dependencies());
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ version: 1, pid: 1234 });
    await first.assertOwned();
    expect(acquireItemLock(lockPath, dependencies())).rejects.toBeInstanceOf(ItemLockBusyError);
    await first.release();
    await first.release();
    const second = await acquireItemLock(lockPath, dependencies());
    await second.release();
  });

  test("reclaims a dead owner immediately without deleting the new lock", async () => {
    const { lockPath } = await fixture();
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 999_999,
      token: "11111111-1111-4111-8111-111111111111",
      acquiredAt: "2026-07-21T11:59:59.000Z",
    })}\n`, { mode: 0o600 });
    const lock = await acquireItemLock(lockPath, dependencies({ isProcessAlive: () => false }));
    expect((await stat(lockPath)).isFile()).toBeTrue();
    await lock.release();
  });

  test("never reclaims a parseable owner while its PID is alive, even with an old heartbeat", async () => {
    const { lockPath } = await fixture();
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 1234,
      token: "11111111-1111-4111-8111-111111111111",
      acquiredAt: "2026-07-20T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const old = new Date("2026-07-20T00:00:00.000Z");
    await utimes(lockPath, old, old);
    expect(acquireItemLock(lockPath, dependencies())).rejects.toBeInstanceOf(ItemLockBusyError);
  });

  test("holds a recent incomplete owner but reclaims it after the lease expires", async () => {
    const { lockPath } = await fixture();
    await writeFile(lockPath, "", { mode: 0o600 });
    const current = new Date("2026-07-21T12:00:00.000Z");
    await utimes(lockPath, current, current);
    expect(acquireItemLock(lockPath, dependencies())).rejects.toBeInstanceOf(ItemLockBusyError);

    const old = new Date("2026-07-21T11:00:00.000Z");
    await utimes(lockPath, old, old);
    const lock = await acquireItemLock(lockPath, dependencies());
    await lock.release();
  });

  test("never reclaims an old foreign directory at the lock path", async () => {
    const { root } = await fixture();
    const lockPath = join(root, "victim.lock");
    const sentinel = join(lockPath, "sentinel");
    await mkdir(lockPath);
    await writeFile(sentinel, "caller-owned\n", { mode: 0o600 });
    const old = new Date("2026-07-20T00:00:00.000Z");
    await utimes(lockPath, old, old);

    await expectBusy(acquireItemLock(lockPath, dependencies({ isProcessAlive: () => false })));

    expect(await readFile(sentinel, "utf8")).toBe("caller-owned\n");
    expect((await lstat(lockPath)).isDirectory()).toBeTrue();
  });

  test("never reclaims symlinked or oversized foreign lock entries", async () => {
    const symlinkFixture = await fixture();
    const target = join(symlinkFixture.root, "caller-owned.txt");
    await writeFile(target, "caller-owned\n", { mode: 0o600 });
    await symlink(target, symlinkFixture.lockPath);

    await expectBusy(acquireItemLock(
      symlinkFixture.lockPath,
      dependencies({ isProcessAlive: () => false }),
    ));
    expect((await lstat(symlinkFixture.lockPath)).isSymbolicLink()).toBeTrue();
    expect(await readFile(target, "utf8")).toBe("caller-owned\n");

    const oversizedFixture = await fixture();
    const oversized = "x".repeat((4 * 1024) + 1);
    await writeFile(oversizedFixture.lockPath, oversized, { mode: 0o600 });
    await expectBusy(acquireItemLock(
      oversizedFixture.lockPath,
      dependencies({ isProcessAlive: () => false }),
    ));
    expect(await readFile(oversizedFixture.lockPath, "utf8")).toBe(oversized);
  });

  test("release never removes a replacement lock owned by another process", async () => {
    const { root, lockPath } = await fixture();
    const lock = await acquireItemLock(lockPath, dependencies());
    await rm(lockPath);
    const replacement = `${JSON.stringify({
      version: 1,
      pid: 5678,
      token: "22222222-2222-4222-8222-222222222222",
      acquiredAt: "2026-07-21T12:00:00.000Z",
    })}\n`;
    await writeFile(lockPath, replacement, { mode: 0o600 });
    expect(lock.assertOwned()).rejects.toBeInstanceOf(ItemLockLostError);
    await lock.release();
    expect(await readFile(lockPath, "utf8")).toBe(replacement);
    expect((await stat(root)).isDirectory()).toBeTrue();
  });

  test("no-clobber restore never overwrites a lock created after a tombstone move", async () => {
    const { root, lockPath } = await fixture();
    const thirdOwner = `${JSON.stringify({
      version: 1,
      pid: 9012,
      token: "33333333-3333-4333-8333-333333333333",
      acquiredAt: "2026-07-21T12:00:00.000Z",
    })}\n`;
    let injected = false;
    const lock = await acquireItemLock(lockPath, dependencies({
      afterTombstoneMove: async (_tombstone, movedLockPath) => {
        injected = true;
        await writeFile(movedLockPath, thirdOwner, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      },
    }));
    await rm(lockPath);
    const replacement = `${JSON.stringify({
      version: 1,
      pid: 5678,
      token: "22222222-2222-4222-8222-222222222222",
      acquiredAt: "2026-07-21T12:00:00.000Z",
    })}\n`;
    await writeFile(lockPath, replacement, { mode: 0o600 });

    await lock.release();

    expect(injected).toBeTrue();
    expect(await readFile(lockPath, "utf8")).toBe(thirdOwner);
    const quarantine = (await readdir(root)).find((name) => name.includes(".release-"));
    expect(quarantine).toBeDefined();
    expect(await readFile(join(root, quarantine ?? "missing"), "utf8")).toBe(replacement);
  });
});
