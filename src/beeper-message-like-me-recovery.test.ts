import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import { canonicalJson } from "./canonical-json";

import {
  acquireBeeperMessageLikeMeExportAdmission,
  beginBeeperMessageLikeMeHelperLaunch,
  bindBeeperMessageLikeMeHelperOwner,
  createBeeperMessageLikeMeDirectoryLease,
  markBeeperMessageLikeMeHelperCleanupUnsafe,
  recoverBeeperMessageLikeMeDirectoryLeases,
  releaseBeeperMessageLikeMeExportAdmission,
  releaseBeeperMessageLikeMeDirectoryLease,
  settleBeeperMessageLikeMeHelper,
  updateBeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function recoveryFixture(name: string): Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  outputRoot: string;
  parent: string;
  root: string;
  target: string;
}> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `wrench-beeper-recovery-${name}-`)),
  );
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  const parent = join(root, "private-exports");
  mkdirSync(parent, { mode: 0o700 });
  const target = join(parent, "working");
  mkdirSync(target, { mode: 0o700 });
  return Object.freeze({
    environment: Object.freeze({ WRENCH_STATE_HOME: join(root, "state") }),
    outputRoot: join(parent, "published"),
    parent,
    root,
    target,
  });
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (performance.now() >= deadline) {
      throw new Error("timed out waiting for synchronized admission children");
    }
    await Bun.sleep(10);
  }
}

describe("Beeper Message Like Me export admission", () => {
  test("rejects a second live owner and permits acquisition after release", () => {
    const fixture = recoveryFixture("export-admission-live");
    const first = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    });

    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    })).toThrow("another export is active");
    expect(existsSync(first.claimPath)).toBeTrue();

    releaseBeeperMessageLikeMeExportAdmission(first);
    releaseBeeperMessageLikeMeExportAdmission(first);
    expect(first.released).toBeTrue();
    expect(existsSync(first.claimPath)).toBeFalse();

    const second = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    });
    expect(second.claimId).not.toBe(first.claimId);
    releaseBeeperMessageLikeMeExportAdmission(second);
  });

  test("reclaims a dead owner before admitting the next export", () => {
    const fixture = recoveryFixture("export-admission-dead");
    const first = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    });
    const second = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
    });

    expect(second.claimId).not.toBe(first.claimId);
    expect(() => releaseBeeperMessageLikeMeExportAdmission(first))
      .toThrow("export admission changed before release");
    expect(existsSync(second.claimPath)).toBeTrue();
    releaseBeeperMessageLikeMeExportAdmission(second);
  });

  test("retains an owner whose liveness cannot be inspected", () => {
    const fixture = recoveryFixture("export-admission-unknown");
    const first = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    });
    const original = readFileSync(first.claimPath, "utf8");

    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "unknown",
    })).toThrow("prior export owner cannot be inspected safely");
    expect(readFileSync(first.claimPath, "utf8")).toBe(original);

    releaseBeeperMessageLikeMeExportAdmission(first);
  });

  test("fails closed without removing a claim changed before release", () => {
    const fixture = recoveryFixture("export-admission-cas");
    const admission = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    });
    const replacement = `${readFileSync(admission.claimPath, "utf8")} `;
    writeFileSync(admission.claimPath, replacement, { mode: 0o600 });

    expect(() => releaseBeeperMessageLikeMeExportAdmission(admission))
      .toThrow("export admission changed before release");
    expect(readFileSync(admission.claimPath, "utf8")).toBe(replacement);
    expect(admission.released).toBeFalse();
  });

  test("keeps same-boot launch uncertainty but recovers it after a proved reboot", () => {
    const fixture = recoveryFixture("export-admission-launch-reboot");
    const first = acquireBeeperMessageLikeMeExportAdmission({ environment: fixture.environment });
    beginBeeperMessageLikeMeHelperLaunch(first);
    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: first.claim.owner.bootId,
    })).toThrow("prior export owner cannot be inspected safely");

    const rebootBootId = first.claim.owner.bootId === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    const afterReboot = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: rebootBootId,
    });
    expect(afterReboot.claimId).not.toBe(first.claimId);
    releaseBeeperMessageLikeMeExportAdmission(afterReboot);
  });

  test("keeps a dead legacy-v1 owner indeterminate until a proved reboot", () => {
    const fixture = recoveryFixture("export-admission-legacy-v1");
    const current = acquireBeeperMessageLikeMeExportAdmission({ environment: fixture.environment });
    const claimPath = current.claimPath;
    const legacy = Object.freeze({
      schemaVersion: 1 as const,
      kind: "beeper-message-like-me-export-admission" as const,
      id: current.claim.id,
      owner: current.claim.owner,
    });
    releaseBeeperMessageLikeMeExportAdmission(current);
    writeFileSync(claimPath, `${canonicalJson(legacy)}\n`, { mode: 0o600 });

    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: legacy.owner.bootId,
    })).toThrow("prior export owner cannot be inspected safely");
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual(legacy);

    const rebootBootId = legacy.owner.bootId === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    const recovered = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: rebootBootId,
    });
    expect(recovered.claim.id).not.toBe(legacy.id);
    expect(recovered.claim.revision).toMatch(/^[0-9a-f-]{36}$/u);
    releaseBeeperMessageLikeMeExportAdmission(recovered);
  });

  test("migrates a recoverable pre-revision v2 claim to a revisioned owner", () => {
    const fixture = recoveryFixture("export-admission-legacy-v2");
    const current = acquireBeeperMessageLikeMeExportAdmission({ environment: fixture.environment });
    const claimPath = current.claimPath;
    const { revision: _revision, ...legacyV2 } = current.claim;
    releaseBeeperMessageLikeMeExportAdmission(current);
    writeFileSync(claimPath, `${canonicalJson(legacyV2)}\n`, { mode: 0o600 });

    const migrated = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: legacyV2.owner.bootId,
    });
    expect(migrated.claim.id).not.toBe(legacyV2.id);
    expect(migrated.claim.revision).toMatch(/^[0-9a-f-]{36}$/u);
    releaseBeeperMessageLikeMeExportAdmission(migrated);
  });

  test("keeps helper-active same-boot after owner death and recovers it only after reboot", () => {
    const fixture = recoveryFixture("export-admission-helper-dead");
    const first = acquireBeeperMessageLikeMeExportAdmission({ environment: fixture.environment });
    beginBeeperMessageLikeMeHelperLaunch(first);
    bindBeeperMessageLikeMeHelperOwner(first, process.pid);
    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "unknown",
      currentBootIdForTest: first.claim.owner.bootId,
    })).toThrow("prior export owner cannot be inspected safely");
    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: first.claim.owner.bootId,
    })).toThrow("prior export owner cannot be inspected safely");

    const rebootBootId = first.claim.owner.bootId === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    const recovered = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: rebootBootId,
    });
    releaseBeeperMessageLikeMeExportAdmission(recovered);
  });

  test("keeps stale helper-active same-boot when cleanup-unsafe CAS fails", () => {
    const fixture = recoveryFixture("export-admission-cleanup-unsafe-cas");
    const admission = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    });
    beginBeeperMessageLikeMeHelperLaunch(admission);
    bindBeeperMessageLikeMeHelperOwner(admission, process.pid);
    const retainedClaim = Object.freeze({
      ...(JSON.parse(readFileSync(admission.claimPath, "utf8")) as Readonly<
        Record<string, unknown>
      >),
      id: "00000000-0000-4000-8000-000000000001",
    });
    const retained = `${canonicalJson(retainedClaim)}\n`;
    writeFileSync(admission.claimPath, retained, { mode: 0o600 });

    expect(() => markBeeperMessageLikeMeHelperCleanupUnsafe(admission))
      .toThrow("export admission changed before lifecycle update");
    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: admission.claim.owner.bootId,
    })).toThrow("prior export owner cannot be inspected safely");
    expect(readFileSync(admission.claimPath, "utf8")).toBe(retained);

    const rebootBootId = admission.claim.owner.bootId === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    const afterReboot = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: rebootBootId,
    });
    releaseBeeperMessageLikeMeExportAdmission(afterReboot);
  });

  test("keeps cleanup-unsafe across same-boot process death and recovers only after reboot", async () => {
    const fixture = recoveryFixture("export-admission-cleanup-unsafe-reboot");
    const moduleUrl = pathToFileURL(join(
      import.meta.dir,
      "beeper-message-like-me-recovery.ts",
    )).href;
    const source = `
      import {
        acquireBeeperMessageLikeMeExportAdmission,
        beginBeeperMessageLikeMeHelperLaunch,
        bindBeeperMessageLikeMeHelperOwner,
        markBeeperMessageLikeMeHelperCleanupUnsafe,
      } from ${JSON.stringify(moduleUrl)};
      const environment = Object.freeze({
        WRENCH_STATE_HOME: ${JSON.stringify(fixture.environment.WRENCH_STATE_HOME)},
      });
      const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
      beginBeeperMessageLikeMeHelperLaunch(admission);
      bindBeeperMessageLikeMeHelperOwner(admission, process.pid);
      markBeeperMessageLikeMeHelperCleanupUnsafe(admission);
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      env: { ...process.env, NODE_ENV: "test" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");

    const admissionPath = join(
      fixture.root,
      "state",
      "recovery",
      "beeper-message-like-me-export-admission",
      "active.json",
    );
    const retained = readFileSync(admissionPath, "utf8");
    const claim = JSON.parse(retained) as Readonly<{
      readonly id: string;
      readonly owner: Readonly<{ readonly bootId: string }>;
    }>;
    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    })).toThrow("prior export owner cannot be inspected safely");
    expect(readFileSync(admissionPath, "utf8")).toBe(retained);

    const rebootBootId = claim.owner.bootId === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    const afterReboot = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: rebootBootId,
    });
    expect(afterReboot.claimId).not.toBe(claim.id);
    releaseBeeperMessageLikeMeExportAdmission(afterReboot);
  });
  test("lifecycle updates are compare-and-swap guarded against a stale controller", () => {
    const fixture = recoveryFixture("export-admission-lifecycle-cas");
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment: fixture.environment });
    writeFileSync(admission.claimPath, `${readFileSync(admission.claimPath, "utf8")} `, { mode: 0o600 });
    expect(() => beginBeeperMessageLikeMeHelperLaunch(admission))
      .toThrow("export admission changed before lifecycle update");
  });

  test("rotates lifecycle revisions so an ABA-stale controller cannot write", () => {
    const fixture = recoveryFixture("export-admission-lifecycle-aba");
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment: fixture.environment });
    const stale = { ...admission };
    const initialRevision = admission.claim.revision;

    beginBeeperMessageLikeMeHelperLaunch(admission);
    bindBeeperMessageLikeMeHelperOwner(admission, process.pid);
    settleBeeperMessageLikeMeHelper(admission);
    expect(admission.claim.phase).toBe("parent-owned");
    expect(admission.claim.revision).not.toBe(initialRevision);
    expect(() => beginBeeperMessageLikeMeHelperLaunch(stale))
      .toThrow("export admission changed before lifecycle update");

    releaseBeeperMessageLikeMeExportAdmission(admission);
  });

  test("preserves same-boot launch uncertainty as cleanup-unsafe admission", () => {
    const fixture = recoveryFixture("export-admission-cleanup-unsafe");
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment: fixture.environment });
    beginBeeperMessageLikeMeHelperLaunch(admission);
    const launchingRevision = admission.claim.revision;
    markBeeperMessageLikeMeHelperCleanupUnsafe(admission);
    expect(admission.claim).toMatchObject({ phase: "cleanup-unsafe", helperOwner: null });
    expect(admission.claim.revision).not.toBe(launchingRevision);
    expect(() => releaseBeeperMessageLikeMeExportAdmission(admission))
      .toThrow("cannot release an unsettled helper lifecycle");
    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: admission.claim.owner.bootId,
    })).toThrow("prior export owner cannot be inspected safely");
  });

  test("preserves same-boot active-helper cleanup uncertainty after the recorded child dies", () => {
    const fixture = recoveryFixture("export-admission-cleanup-unsafe-dead-helper");
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment: fixture.environment });
    beginBeeperMessageLikeMeHelperLaunch(admission);
    bindBeeperMessageLikeMeHelperOwner(admission, process.pid);
    markBeeperMessageLikeMeHelperCleanupUnsafe(admission);
    expect(admission.claim).toMatchObject({ phase: "cleanup-unsafe" });
    expect(admission.claim.helperOwner).not.toBeNull();

    expect(() => acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: admission.claim.owner.bootId,
    })).toThrow("prior export owner cannot be inspected safely");

    const rebootBootId = admission.claim.owner.bootId === "f".repeat(64)
      ? "e".repeat(64)
      : "f".repeat(64);
    const recovered = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
      inspectOwnerForTest: () => "different-or-dead",
      currentBootIdForTest: rebootBootId,
    });
    expect(recovered.claim.id).not.toBe(admission.claim.id);
    releaseBeeperMessageLikeMeExportAdmission(recovered);
  });

  test("admits exactly one of two synchronized processes", async () => {
    const fixture = recoveryFixture("export-admission-race");
    const barrier = join(fixture.root, "start");
    const release = join(fixture.root, "release");
    const moduleUrl = pathToFileURL(join(
      import.meta.dir,
      "beeper-message-like-me-recovery.ts",
    )).href;
    const children = [0, 1].map((index) => {
      const ready = join(fixture.root, `ready-${index}`);
      const result = join(fixture.root, `result-${index}`);
      const source = `
        import { existsSync, writeFileSync } from "node:fs";
        import {
          acquireBeeperMessageLikeMeExportAdmission,
          releaseBeeperMessageLikeMeExportAdmission,
        } from ${JSON.stringify(moduleUrl)};
        const environment = Object.freeze({
          WRENCH_STATE_HOME: ${JSON.stringify(fixture.environment.WRENCH_STATE_HOME)},
        });
        writeFileSync(${JSON.stringify(ready)}, "ready\\n", { mode: 0o600 });
        while (!existsSync(${JSON.stringify(barrier)})) await Bun.sleep(5);
        let admission;
        try {
          admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
        } catch {
          writeFileSync(${JSON.stringify(result)}, "blocked\\n", { mode: 0o600 });
        }
        if (admission !== undefined) {
          writeFileSync(${JSON.stringify(result)}, "acquired\\n", { mode: 0o600 });
          while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
          releaseBeeperMessageLikeMeExportAdmission(admission);
        }
      `;
      return Object.freeze({
        child: Bun.spawn([process.execPath, "-e", source], {
          env: { ...process.env, NODE_ENV: "test" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
        ready,
        result,
      });
    });

    let exitCodes: readonly number[] = [];
    try {
      await waitForFiles(children.map((child) => child.ready));
      writeFileSync(barrier, "start\n", { mode: 0o600 });
      await waitForFiles(children.map((child) => child.result));
      expect(children.map((child) => readFileSync(child.result, "utf8").trim()).sort())
        .toEqual(["acquired", "blocked"]);
    } finally {
      writeFileSync(release, "release\n", { mode: 0o600 });
      exitCodes = await Promise.all(children.map((child) => child.child.exited));
    }
    expect(exitCodes).toEqual([0, 0]);

    const after = acquireBeeperMessageLikeMeExportAdmission({
      environment: fixture.environment,
    });
    releaseBeeperMessageLikeMeExportAdmission(after);
  });
});

describe("Beeper Message Like Me directory lease recovery", () => {
  test("retains an exact live owner's raw directory and claim", async () => {
    const fixture = recoveryFixture("active");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: fixture.target,
      recoverAfterMs: 2_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });

    const report = await recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 10_000,
      inspectOwner: () => "exact-live-owner",
    });

    expect(report).toEqual({
      recovered: 0,
      published: 0,
      active: 1,
      indeterminate: 0,
    });
    expect(existsSync(fixture.target)).toBeTrue();
    expect(existsSync(lease.claimPath)).toBeTrue();
  });

  test("reclaims a settled raw directory owned by a dead process", async () => {
    const fixture = recoveryFixture("settled");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: fixture.target,
      recoverAfterMs: 50_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });
    updateBeeperMessageLikeMeDirectoryLease(lease, "launching");
    updateBeeperMessageLikeMeDirectoryLease(lease, "settled");

    const report = await recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 1_001,
      inspectOwner: () => "different-or-dead",
    });

    expect(report).toEqual({
      recovered: 1,
      published: 0,
      active: 0,
      indeterminate: 0,
    });
    expect(existsSync(fixture.target)).toBeFalse();
    expect(existsSync(lease.claimPath)).toBeFalse();
  });

  test("retains a dead launching lease until its deadline, then reclaims it", async () => {
    const fixture = recoveryFixture("launching-deadline");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: fixture.target,
      recoverAfterMs: 2_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });
    updateBeeperMessageLikeMeDirectoryLease(lease, "launching");

    const retained = await recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 1_999,
      inspectOwner: () => "different-or-dead",
    });
    expect(retained).toEqual({
      recovered: 0,
      published: 0,
      active: 0,
      indeterminate: 1,
    });
    expect(existsSync(fixture.target)).toBeTrue();
    expect(existsSync(lease.claimPath)).toBeTrue();

    const recovered = await recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 2_000,
      inspectOwner: () => "different-or-dead",
    });
    expect(recovered).toEqual({
      recovered: 1,
      published: 0,
      active: 0,
      indeterminate: 0,
    });
    expect(existsSync(fixture.target)).toBeFalse();
    expect(existsSync(lease.claimPath)).toBeFalse();
  });

  test("classifies an orphaned running child before recovering raw data", async () => {
    const cases = [
      {
        name: "live-child",
        childStatus: "exact-live-owner" as const,
        report: { recovered: 0, published: 0, active: 1, indeterminate: 0 },
        retained: true,
      },
      {
        name: "unknown-child",
        childStatus: "unknown" as const,
        report: { recovered: 0, published: 0, active: 0, indeterminate: 1 },
        retained: true,
      },
      {
        name: "dead-child",
        childStatus: "different-or-dead" as const,
        report: { recovered: 1, published: 0, active: 0, indeterminate: 0 },
        retained: false,
      },
    ];

    for (const item of cases) {
      const fixture = recoveryFixture(item.name);
      const lease = await createBeeperMessageLikeMeDirectoryLease({
        role: "raw-working",
        path: fixture.target,
        recoverAfterMs: 50_000,
        environment: fixture.environment,
        nowMs: 1_000,
      });
      updateBeeperMessageLikeMeDirectoryLease(lease, "launching");
      updateBeeperMessageLikeMeDirectoryLease(lease, "running", process.pid);
      let inspections = 0;

      const report = await recoverBeeperMessageLikeMeDirectoryLeases({
        environment: fixture.environment,
        nowMs: 1_001,
        inspectOwner: () => {
          inspections += 1;
          return inspections === 1 ? "different-or-dead" : item.childStatus;
        },
      });

      expect(report).toEqual(item.report);
      expect(inspections).toBe(2);
      expect(existsSync(fixture.target)).toBe(item.retained);
      expect(existsSync(lease.claimPath)).toBe(item.retained);
    }
  });

  test("fails closed and preserves a replacement at the leased path", async () => {
    const fixture = recoveryFixture("replacement");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: fixture.target,
      recoverAfterMs: 1_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });
    updateBeeperMessageLikeMeDirectoryLease(lease, "launching");
    updateBeeperMessageLikeMeDirectoryLease(lease, "settled");
    const displaced = join(fixture.parent, "displaced-original");
    renameSync(fixture.target, displaced);
    mkdirSync(fixture.target, { mode: 0o700 });
    const replacementMarker = join(fixture.target, "replacement.txt");
    writeFileSync(replacementMarker, "replacement\n", { mode: 0o600 });

    await expect(recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 1_001,
      inspectOwner: () => "different-or-dead",
    })).rejects.toThrow("directory lease target changed before recovery");

    expect(readFileSync(replacementMarker, "utf8")).toBe("replacement\n");
    expect(existsSync(displaced)).toBeTrue();
    expect(existsSync(lease.claimPath)).toBeTrue();
  });

  test("reclaims an unpublished bundle stage owned by a dead process", async () => {
    const fixture = recoveryFixture("stage-dead");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "bundle-stage",
      path: fixture.target,
      outputRoot: fixture.outputRoot,
      recoverAfterMs: 1_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });

    const report = await recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 1_001,
      inspectOwner: () => "different-or-dead",
    });

    expect(report).toEqual({
      recovered: 1,
      published: 0,
      active: 0,
      indeterminate: 0,
    });
    expect(existsSync(fixture.target)).toBeFalse();
    expect(existsSync(lease.claimPath)).toBeFalse();
  });

  test("preserves and reports a stage atomically renamed to its output", async () => {
    const fixture = recoveryFixture("stage-published");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "bundle-stage",
      path: fixture.target,
      outputRoot: fixture.outputRoot,
      recoverAfterMs: 1_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });
    const marker = join(fixture.target, "published.txt");
    writeFileSync(marker, "published\n", { mode: 0o600 });
    renameSync(fixture.target, fixture.outputRoot);

    const report = await recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 1_001,
      inspectOwner: () => "different-or-dead",
    });

    expect(report).toEqual({
      recovered: 0,
      published: 1,
      active: 0,
      indeterminate: 0,
    });
    expect(readFileSync(join(fixture.outputRoot, "published.txt"), "utf8"))
      .toBe("published\n");
    expect(existsSync(lease.claimPath)).toBeFalse();
  });

  test("fails closed when an unrelated directory appears at a staged output", async () => {
    const fixture = recoveryFixture("stage-output-replacement");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "bundle-stage",
      path: fixture.target,
      outputRoot: fixture.outputRoot,
      recoverAfterMs: 1_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });
    rmSync(fixture.target, { recursive: true });
    mkdirSync(fixture.outputRoot, { mode: 0o700 });
    // Model the Linux inode-reuse ABA deterministically: the replacement has
    // the recorded device/inode coordinate but a different directory birth.
    const output = statSync(fixture.outputRoot, { bigint: true });
    const stored = JSON.parse(readFileSync(lease.claimPath, "utf8")) as {
      directoryIdentity: { birthtimeNs: string; device: string; inode: string };
    };
    stored.directoryIdentity = {
      device: output.dev.toString(),
      inode: output.ino.toString(),
      birthtimeNs: output.birthtimeNs === 1n ? "2" : "1",
    };
    writeFileSync(lease.claimPath, `${canonicalJson(stored)}\n`, { mode: 0o600 });
    const marker = join(fixture.outputRoot, "replacement.txt");
    writeFileSync(marker, "replacement\n", { mode: 0o600 });

    await expect(recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 1_001,
      inspectOwner: () => "different-or-dead",
    })).rejects.toThrow("directory lease output changed before recovery");

    expect(readFileSync(marker, "utf8")).toBe("replacement\n");
    expect(existsSync(lease.claimPath)).toBeTrue();
  });

  test("rejects a directory lease without its generation identity", async () => {
    const fixture = recoveryFixture("missing-generation");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: fixture.target,
      recoverAfterMs: 1_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });
    const stored = JSON.parse(readFileSync(lease.claimPath, "utf8")) as {
      directoryIdentity: { birthtimeNs?: string };
    };
    delete stored.directoryIdentity.birthtimeNs;
    writeFileSync(lease.claimPath, `${canonicalJson(stored)}\n`, { mode: 0o600 });

    await expect(recoverBeeperMessageLikeMeDirectoryLeases({
      environment: fixture.environment,
      nowMs: 1_001,
      inspectOwner: () => "different-or-dead",
    })).rejects.toThrow("directory lease directory identity has an unsupported shape");

    expect(existsSync(fixture.target)).toBeTrue();
    expect(existsSync(lease.claimPath)).toBeTrue();
  });

  test("updates and releases by compare-and-swap while rejecting a changed claim", async () => {
    const fixture = recoveryFixture("lifecycle-cas");
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: fixture.target,
      recoverAfterMs: 2_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });

    updateBeeperMessageLikeMeDirectoryLease(lease, "launching");
    expect(lease.claim.phase).toBe("launching");
    updateBeeperMessageLikeMeDirectoryLease(lease, "running", process.pid);
    expect(lease.claim.phase).toBe("running");
    expect(lease.claim.childOwner?.pid).toBe(process.pid);
    updateBeeperMessageLikeMeDirectoryLease(lease, "settled");
    expect(lease.claim.phase).toBe("settled");
    expect(lease.claim.childOwner).toBeNull();
    releaseBeeperMessageLikeMeDirectoryLease(lease);
    releaseBeeperMessageLikeMeDirectoryLease(lease);
    expect(lease.released).toBeTrue();
    expect(existsSync(lease.claimPath)).toBeFalse();
    expect(existsSync(fixture.target)).toBeTrue();

    const secondTarget = join(fixture.parent, "second-working");
    mkdirSync(secondTarget, { mode: 0o700 });
    const changed = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: secondTarget,
      recoverAfterMs: 2_000,
      environment: fixture.environment,
      nowMs: 1_000,
    });
    writeFileSync(
      changed.claimPath,
      `${readFileSync(changed.claimPath, "utf8")} `,
      { mode: 0o600 },
    );

    expect(() => updateBeeperMessageLikeMeDirectoryLease(changed, "launching"))
      .toThrow("directory lease changed before its lifecycle update");
    expect(changed.claim.phase).toBe("preparing");
    expect(existsSync(secondTarget)).toBeTrue();
    expect(existsSync(changed.claimPath)).toBeTrue();
  });
});
