import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BROWSER_SNAPSHOT_GC_GRACE_MS,
  createBrowserSnapshotDirectory,
  purgeOrphanedBrowserSnapshots,
  removeBrowserSnapshotDirectory,
} from "./browser-snapshots";
import { createPrivateStateDirectory } from "./storage";

setDefaultTimeout(20_000);

const markerName = ".io-browser-snapshot.json";

function testState(): {
  readonly root: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-browser-snapshot-test-"));
  chmodSync(root, 0o700);
  return { root, environment: { ...process.env, WRENCH_STATE_HOME: join(root, "io-state") } };
}

async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
  expect(await child.exited).toBe(0);
  return child.pid;
}

describe("managed browser snapshots", () => {
  test("rejects an invalid GC clock before creating state", () => {
    const state = testState();
    try {
      expect(() => purgeOrphanedBrowserSnapshots(state.environment, Number.NaN)).toThrow("GC time is invalid");
      expect(existsSync(state.environment.WRENCH_STATE_HOME ?? "")).toBeFalse();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("creates a private marked snapshot and removes only that owned directory", () => {
    const state = testState();
    try {
      const snapshot = createBrowserSnapshotDirectory(state.environment, 1_000);
      expect(dirname(snapshot.path)).toBe(realpathSync(join(state.environment.WRENCH_STATE_HOME ?? "", "browser-snapshots")));
      expect(lstatSync(snapshot.path).mode & 0o777).toBe(0o700);
      const marker = join(snapshot.path, markerName);
      expect(lstatSync(marker).mode & 0o077).toBe(0);
      writeFileSync(join(snapshot.path, "owned-data"), "private", { mode: 0o600 });

      removeBrowserSnapshotDirectory(snapshot, state.environment);
      expect(existsSync(snapshot.path)).toBeFalse();
      expect(existsSync(dirname(snapshot.path))).toBeTrue();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("recovers an unmarked hard-crash window only after its owner exits and grace elapses", async () => {
    const state = testState();
    try {
      const now = Date.now();
      const active = createBrowserSnapshotDirectory(state.environment, now);
      const deadPid = await exitedPid();
      const residue = join(
        dirname(active.path),
        `capture-${deadPid}-${now}-${"a".repeat(32)}`,
      );
      createPrivateStateDirectory(residue, state.environment, active.rootIdentity);
      expect(existsSync(join(residue, markerName))).toBeFalse();

      expect(purgeOrphanedBrowserSnapshots(state.environment, now + 1)).toBe(0);
      expect(existsSync(residue)).toBeTrue();
      expect(purgeOrphanedBrowserSnapshots(
        state.environment,
        now + BROWSER_SNAPSHOT_GC_GRACE_MS,
      )).toBe(1);
      expect(existsSync(residue)).toBeFalse();
      expect(existsSync(active.path)).toBeTrue();
      removeBrowserSnapshotDirectory(active, state.environment);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("recovers a state-helper removal quarantine after its helper owner exits", async () => {
    const state = testState();
    try {
      const now = Date.now();
      const active = createBrowserSnapshotDirectory(state.environment, now);
      const deadPid = await exitedPid();
      const quarantine = join(
        dirname(active.path),
        `.io-remove-${deadPid}-${now}-${"b".repeat(32)}.quarantine`,
      );
      createPrivateStateDirectory(quarantine, state.environment, active.rootIdentity);

      expect(purgeOrphanedBrowserSnapshots(state.environment, now + 1)).toBe(0);
      expect(existsSync(quarantine)).toBeTrue();
      expect(purgeOrphanedBrowserSnapshots(
        state.environment,
        now + BROWSER_SNAPSHOT_GC_GRACE_MS,
      )).toBe(1);
      expect(existsSync(quarantine)).toBeFalse();
      removeBrowserSnapshotDirectory(active, state.environment);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("fails closed instead of deleting an unrecognized entry", () => {
    const state = testState();
    try {
      const snapshot = createBrowserSnapshotDirectory(state.environment, 1_000);
      const unexpected = join(dirname(snapshot.path), "unexpected");
      writeFileSync(unexpected, "do-not-delete", { mode: 0o600 });
      expect(() => purgeOrphanedBrowserSnapshots(state.environment, 1_001)).toThrow("unrecognized entry");
      expect(existsSync(unexpected)).toBeTrue();
      removeBrowserSnapshotDirectory(snapshot, state.environment);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("binds the snapshot root before scanning it", () => {
    const state = testState();
    try {
      const snapshot = createBrowserSnapshotDirectory(state.environment, 1_000);
      const root = dirname(snapshot.path);
      const displaced = join(state.root, "displaced-browser-snapshots");
      const sentinel = join(root, "replacement-sentinel");

      expect(() => purgeOrphanedBrowserSnapshots(state.environment, 1_001, {
        beforeScan: () => {
          renameSync(root, displaced);
          mkdirSync(root, { mode: 0o700 });
          writeFileSync(sentinel, "must survive", { mode: 0o600 });
        },
      })).toThrow("identity");
      expect(readFileSync(sentinel, "utf8")).toBe("must survive");
      expect(existsSync(snapshot.path.replace(root, displaced))).toBeTrue();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("binds the listed child identity before reading its marker", () => {
    const state = testState();
    try {
      const snapshot = createBrowserSnapshotDirectory(state.environment, 1_000);
      const markerContent = readFileSync(join(snapshot.path, markerName), "utf8");
      const displaced = `${snapshot.path}-displaced`;
      const sentinel = join(snapshot.path, "replacement-sentinel");
      let swapped = false;

      expect(() => purgeOrphanedBrowserSnapshots(state.environment, 1_001, {
        beforeMarkerRead: () => {
          if (swapped) return;
          swapped = true;
          renameSync(snapshot.path, displaced);
          mkdirSync(snapshot.path, { mode: 0o700 });
          writeFileSync(join(snapshot.path, markerName), markerContent, { flag: "wx", mode: 0o600 });
          writeFileSync(sentinel, "must survive", { flag: "wx", mode: 0o600 });
        },
      })).toThrow("identity");
      expect(swapped).toBeTrue();
      expect(readFileSync(sentinel, "utf8")).toBe("must survive");
      expect(existsSync(displaced)).toBeTrue();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("does not accept a different marker inode and accepts the restored inode after ABA", () => {
    const state = testState();
    try {
      const snapshot = createBrowserSnapshotDirectory(state.environment, 1_000);
      const marker = join(snapshot.path, markerName);
      const displacedMarker = join(snapshot.path, ".original-owner-marker");
      const owner = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
      let swapped = false;

      expect(() => purgeOrphanedBrowserSnapshots(state.environment, 1_001, {
        beforeMarkerRead: () => {
          if (swapped) return;
          swapped = true;
          renameSync(marker, displacedMarker);
          writeFileSync(marker, `${JSON.stringify({ ...owner, nonce: "f".repeat(32) })}\n`, {
            flag: "wx",
            mode: 0o600,
          });
        },
      })).toThrow("does not match its directory");
      expect(swapped).toBeTrue();
      expect(existsSync(displacedMarker)).toBeTrue();
      rmSync(marker);
      renameSync(displacedMarker, marker);
      expect(purgeOrphanedBrowserSnapshots(state.environment, 1_002)).toBe(0);
      removeBrowserSnapshotDirectory(snapshot, state.environment);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("rejects a pathname replacement without deleting the replacement", () => {
    const state = testState();
    try {
      const snapshot = createBrowserSnapshotDirectory(state.environment, 1_000);
      const displaced = `${snapshot.path}-displaced`;
      renameSync(snapshot.path, displaced);
      mkdirSync(snapshot.path, { mode: 0o700 });
      const sentinel = join(snapshot.path, "replacement-sentinel");
      writeFileSync(sentinel, "must survive", { flag: "wx", mode: 0o600 });

      expect(() => removeBrowserSnapshotDirectory(snapshot, state.environment)).toThrow("identity");
      expect(existsSync(sentinel)).toBeTrue();
      expect(existsSync(displaced)).toBeTrue();
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});
