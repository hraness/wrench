import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { exportApplePhotosContactEvidenceForCli } from "./apple-photos-cli";
import {
  acquireBeeperMessageLikeMeExportAdmission,
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeExportAdmission,
  releaseBeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";

const temporaryRoots: string[] = [];
const expectedRealWorkerValidationFailure = process.platform === "darwin"
  ? "Photos library"
  : "requires macOS";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function privateRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label)));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function blockingWorkerArgv(
  phase: "photos-capture" | "evidence-validation" | "generation-hashing",
  options: Readonly<{
    diagnosticOverflow?: boolean;
    createLease?: boolean;
    readyPath?: string;
  }> = {},
): readonly string[] {
  const recoveryModule = new URL(
    "./beeper-message-like-me-recovery.ts",
    import.meta.url,
  ).href;
  const source = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    options.createLease === true
      ? [
          `const recovery = await import(${JSON.stringify(recoveryModule)});`,
          "const parent = join(process.env.WRENCH_STATE_HOME, 'retained');",
          "const working = join(parent, 'snapshot-worker');",
          "mkdirSync(working, { recursive: true, mode: 0o700 });",
          "const lease = await recovery.createBeeperMessageLikeMeDirectoryLease({ role: 'raw-working', path: working, recoverAfterMs: Date.now() + 60_000, environment: process.env });",
          "recovery.updateBeeperMessageLikeMeDirectoryLease(lease, 'launching');",
          "recovery.updateBeeperMessageLikeMeDirectoryLease(lease, 'running', process.pid);",
        ].join("\n")
      : "",
    "process.on('SIGTERM', () => undefined);",
    "for await (const _chunk of process.stdin) { break; }",
    options.readyPath === undefined
      ? ""
      : `writeFileSync(${JSON.stringify(options.readyPath)}, 'ready\\n', { mode: 0o600 });`,
    options.diagnosticOverflow === true
      ? "process.stderr.write('x'.repeat(40 * 1024));"
      : `process.stderr.write(${JSON.stringify(`wrench-apple-photos-progress:{\"phase\":\"${phase}\"}\n`)});`,
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  return Object.freeze([process.execPath, "--no-env-file", "-e", source]);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for worker fixture");
    await Bun.sleep(10);
  }
}

describe("Apple Photos CLI recovery preflight", () => {
  test("fails non-macOS before admission, state, source inspection, or recovery", async () => {
    const root = privateRoot("wrench-apple-photos-cli-platform-test-");
    const environment = {
      HOME: join(root, "missing-home"),
      WRENCH_STATE_HOME: join(root, "must-not-exist"),
    };
    const phases: string[] = [];
    await expect(exportApplePhotosContactEvidenceForCli({
      library: join(root, "Missing.photoslibrary"),
      environment,
      dependencies: { platform: "linux" },
      progress: (event) => phases.push(event.phase),
    })).rejects.toThrow("requires macOS");
    expect(phases).toEqual(["platform-check"]);
    expect(existsSync(environment.HOME)).toBeFalse();
    expect(existsSync(environment.WRENCH_STATE_HOME)).toBeFalse();
  });

  test("rejects an active private export before inspecting the Photos library", async () => {
    const root = privateRoot("wrench-apple-photos-cli-recovery-test-");
    const parent = join(root, "private-exports");
    mkdirSync(parent, { mode: 0o700 });
    const working = join(parent, "active-working");
    mkdirSync(working, { mode: 0o700 });
    const environment = {
      HOME: join(root, "home"),
      WRENCH_STATE_HOME: join(root, "state"),
    };
    mkdirSync(environment.HOME, { mode: 0o700 });
    const nowMs = Date.now();
    const activeLease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: working,
      recoverAfterMs: nowMs + 60_000,
      environment,
      nowMs,
    });
    const missingLibrary = join(environment.HOME, "Must Not Be Inspected.photoslibrary");

    try {
      await expect(exportApplePhotosContactEvidenceForCli({
        library: missingLibrary,
        environment,
        dependencies: { platform: "darwin" },
      })).rejects.toThrow(
        "another private export is active or prior recovery is indeterminate",
      );
      expect(existsSync(missingLibrary)).toBeFalse();
      expect(existsSync(activeLease.claimPath)).toBeTrue();

      const admissionAfterFailure = acquireBeeperMessageLikeMeExportAdmission({
        environment,
      });
      releaseBeeperMessageLikeMeExportAdmission(admissionAfterFailure);
    } finally {
      releaseBeeperMessageLikeMeDirectoryLease(activeLease);
    }
  });

  test("releases global admission after source validation fails", async () => {
    const root = privateRoot("wrench-apple-photos-cli-source-failure-test-");
    const home = join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    const environment = {
      HOME: home,
      WRENCH_STATE_HOME: join(root, "state"),
    };

    await expect(exportApplePhotosContactEvidenceForCli({
      library: join(home, "Missing.photoslibrary"),
      environment,
      dependencies: { platform: "darwin" },
    })).rejects.toThrow(expectedRealWorkerValidationFailure);

    const admissionAfterFailure = acquireBeeperMessageLikeMeExportAdmission({
      environment,
    });
    releaseBeeperMessageLikeMeExportAdmission(admissionAfterFailure);
  });

  test("honors a pre-aborted signal before admission, state, or worker launch", async () => {
    const root = privateRoot("wrench-apple-photos-cli-pre-abort-test-");
    const environment = {
      WRENCH_STATE_HOME: join(root, "must-not-exist"),
    };
    const controller = new AbortController();
    controller.abort(new Error("fixture pre-abort"));
    await expect(exportApplePhotosContactEvidenceForCli({
      environment,
      signal: controller.signal,
      dependencies: { platform: "darwin" },
      supervisorDependencies: { argv: blockingWorkerArgv("photos-capture") },
    })).rejects.toThrow("fixture pre-abort");
    expect(existsSync(environment.WRENCH_STATE_HOME)).toBeFalse();
  });

  test("rechecks abort immediately after listener registration", async () => {
    const root = privateRoot("wrench-apple-photos-cli-abort-race-test-");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const controller = new AbortController();
    await expect(exportApplePhotosContactEvidenceForCli({
      environment,
      signal: controller.signal,
      dependencies: { platform: "darwin" },
      supervisorDependencies: {
        argv: blockingWorkerArgv("photos-capture"),
        timeoutMs: 5_000,
        terminationGraceMs: 20,
        afterAbortListenerForTest: () => controller.abort(new Error("fixture abort race")),
      },
    })).rejects.toThrow("fixture abort race");
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
    releaseBeeperMessageLikeMeExportAdmission(admission);
  });

  test("binds the exact helper owner durably before sending worker input", async () => {
    const root = privateRoot("wrench-apple-photos-cli-helper-handoff-test-");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const ready = join(root, "worker-ready");
    const controller = new AbortController();
    const operation = exportApplePhotosContactEvidenceForCli({
      environment,
      signal: controller.signal,
      dependencies: { platform: "darwin" },
      supervisorDependencies: {
        argv: blockingWorkerArgv("photos-capture", { readyPath: ready }),
        timeoutMs: 5_000,
        terminationGraceMs: 20,
      },
    });
    await waitForPath(ready);
    const active = JSON.parse(readFileSync(join(
      environment.WRENCH_STATE_HOME,
      "recovery",
      "beeper-message-like-me-export-admission",
      "active.json",
    ), "utf8")) as Record<string, unknown>;
    expect(active.phase).toBe("helper-active");
    expect(active.helperOwner).toMatchObject({ pid: expect.any(Number) });
    controller.abort(new Error("fixture handoff complete"));
    await expect(operation).rejects.toThrow("fixture handoff complete");
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
    releaseBeeperMessageLikeMeExportAdmission(admission);
  });

  test("uses one canonical state namespace for legacy aliases and the child", async () => {
    const root = privateRoot("wrench-apple-photos-cli-state-namespace-test-");
    const state = join(root, "legacy-state");
    const home = join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    const environment = {
      HOME: home,
      OH_STATE_HOME: state,
      IO_HOME: state,
      XDG_DATA_HOME: join(root, "xdg-data"),
    };
    await expect(exportApplePhotosContactEvidenceForCli({
      library: join(home, "Missing.photoslibrary"),
      environment,
      dependencies: { platform: "darwin" },
    })).rejects.toThrow(expectedRealWorkerValidationFailure);
    expect(existsSync(join(
      state,
      "recovery",
      "beeper-message-like-me-export-admission",
    ))).toBeTrue();
    expect(existsSync(join(
      state,
      "recovery",
      "beeper-message-like-me-directory-leases",
    ))).toBeTrue();
  });

  test("counts admission time against the single total deadline", async () => {
    const root = privateRoot("wrench-apple-photos-cli-admission-deadline-test-");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const ready = join(root, "must-not-launch");
    await expect(exportApplePhotosContactEvidenceForCli({
      environment,
      dependencies: { platform: "darwin" },
      supervisorDependencies: {
        argv: blockingWorkerArgv("photos-capture", { readyPath: ready }),
        timeoutMs: 1,
        terminationGraceMs: 20,
      },
    })).rejects.toThrow("total operation deadline");
    expect(existsSync(ready)).toBeFalse();
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
    releaseBeeperMessageLikeMeExportAdmission(admission);
  });

  test("ignores caller Bun config and preload when launching the fixed worker", () => {
    const root = privateRoot("wrench-apple-photos-cli-bun-config-test-");
    const cwd = join(root, "caller");
    const home = join(root, "home");
    const state = join(root, "state");
    const marker = join(root, "untrusted-preload-ran");
    mkdirSync(cwd, { mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./untrusted-preload.ts"]\n', { mode: 0o600 });
    writeFileSync(
      join(cwd, "untrusted-preload.ts"),
      `await Bun.write(${JSON.stringify(marker)}, "ran\\n");\n`,
      { mode: 0o600 },
    );
    const moduleUrl = new URL("./apple-photos-cli.ts", import.meta.url).href;
    const config = join(import.meta.dir, "state-helper.bunfig.toml");
    const source = [
      `const runtime = await import(${JSON.stringify(moduleUrl)});`,
      "try {",
      "  await runtime.exportApplePhotosContactEvidenceForCli({",
      `    library: ${JSON.stringify(join(home, "Missing.photoslibrary"))},`,
      `    environment: { HOME: ${JSON.stringify(home)}, WRENCH_STATE_HOME: ${JSON.stringify(state)}, BUN_CONFIG_FILE: ${JSON.stringify(join(cwd, "bunfig.toml"))} },`,
      "    dependencies: { platform: 'darwin' },",
      "  });",
      "  process.exitCode = 2;",
      "} catch (error) {",
      "  const expected = process.platform === 'darwin' ? 'Photos library' : 'requires macOS';",
      "  if (!(error instanceof Error) || !error.message.includes(expected)) process.exitCode = 3;",
      "}",
    ].join("\n");
    const result = spawnSync(process.execPath, [
      "--no-env-file",
      "--no-install",
      "--no-macros",
      "--no-addons",
      `--config=${config}`,
      "-e",
      source,
    ], {
      cwd,
      env: { NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(marker)).toBeFalse();
  });

  test("settles a child spawn error without waiting for the operation deadline", async () => {
    const root = privateRoot("wrench-apple-photos-cli-spawn-error-test-");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const startedAt = performance.now();
    await expect(exportApplePhotosContactEvidenceForCli({
      environment,
      dependencies: { platform: "darwin" },
      supervisorDependencies: {
        argv: [join(root, "missing-worker")],
        timeoutMs: 10_000,
        terminationGraceMs: 50,
      },
    })).rejects.toThrow("launch failed");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
    releaseBeeperMessageLikeMeExportAdmission(admission);
  });

  for (const [label, phase] of [
    ["VACUUM", "photos-capture"],
    ["quick_check", "evidence-validation"],
    ["evidence query", "generation-hashing"],
  ] as const) {
    test(`hard-kills a ${label} worker that ignores TERM under one total deadline`, async () => {
      const root = privateRoot(`wrench-apple-photos-cli-${phase}-test-`);
      const environment = { WRENCH_STATE_HOME: join(root, "state") };
      await expect(exportApplePhotosContactEvidenceForCli({
        environment,
        dependencies: { platform: "darwin" },
        supervisorDependencies: {
          argv: blockingWorkerArgv(phase),
          timeoutMs: 40,
          terminationGraceMs: 20,
        },
      })).rejects.toThrow("total operation deadline");
      const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
      releaseBeeperMessageLikeMeExportAdmission(admission);
    });
  }

  test("recovers a proven-KILL snapshot lease before the next source inspection", async () => {
    const root = privateRoot("wrench-apple-photos-cli-kill-recovery-test-");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const retained = join(environment.WRENCH_STATE_HOME, "retained", "snapshot-worker");
    const leaseRoot = join(
      environment.WRENCH_STATE_HOME,
      "recovery",
      "beeper-message-like-me-directory-leases",
    );
    const admissionPath = join(
      environment.WRENCH_STATE_HOME,
      "recovery",
      "beeper-message-like-me-export-admission",
      "active.json",
    );
    const ready = join(root, "worker-ready");
    const controller = new AbortController();
    const operation = exportApplePhotosContactEvidenceForCli({
      environment,
      signal: controller.signal,
      dependencies: { platform: "darwin" },
      supervisorDependencies: {
        argv: blockingWorkerArgv("photos-capture", {
          createLease: true,
          readyPath: ready,
        }),
        timeoutMs: 5_000,
        terminationGraceMs: 20,
      },
    });
    await waitForPath(ready);
    controller.abort(new Error("fixture proven kill"));
    await expect(operation).rejects.toThrow("fixture proven kill");

    expect(existsSync(admissionPath)).toBeFalse();
    expect(readdirSync(leaseRoot)).toHaveLength(1);
    expect(existsSync(retained)).toBeTrue();

    await expect(exportApplePhotosContactEvidenceForCli({
      library: join(root, "Must Not Exist.photoslibrary"),
      environment,
      dependencies: { platform: "darwin" },
    })).rejects.toThrow("Apple Photos");

    expect(existsSync(admissionPath)).toBeFalse();
    expect(readdirSync(leaseRoot)).toEqual([]);
    expect(existsSync(retained)).toBeFalse();
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
    releaseBeeperMessageLikeMeExportAdmission(admission);
  });

  test("terminates bounded-stream overflow without publishing partial stdout", async () => {
    const root = privateRoot("wrench-apple-photos-cli-overflow-test-");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    await expect(exportApplePhotosContactEvidenceForCli({
      environment,
      dependencies: { platform: "darwin" },
      supervisorDependencies: {
        argv: blockingWorkerArgv("photos-capture", { diagnosticOverflow: true }),
        timeoutMs: 2_000,
        terminationGraceMs: 20,
      },
    })).rejects.toThrow("diagnostic exceeded its byte bound");
  });

  test("retains global admission when post-KILL process-group exit is unproven", async () => {
    const root = privateRoot("wrench-apple-photos-cli-unproven-test-");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const ready = join(root, "worker-ready");
    const controller = new AbortController();
    const operation = exportApplePhotosContactEvidenceForCli({
      environment,
      signal: controller.signal,
      dependencies: { platform: "darwin" },
      supervisorDependencies: {
        argv: blockingWorkerArgv("photos-capture", {
          createLease: true,
          readyPath: ready,
        }),
        timeoutMs: 5_000,
        terminationGraceMs: 20,
        processGroupAlive: () => true,
      },
    });
    await waitForPath(ready);
    const startedAt = performance.now();
    controller.abort(new Error("fixture unproven kill"));
    await expect(operation).rejects.toThrow("termination is indeterminate");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(() => acquireBeeperMessageLikeMeExportAdmission({ environment }))
      .toThrow("another export is active");
    const leaseRoot = join(
      environment.WRENCH_STATE_HOME,
      "recovery",
      "beeper-message-like-me-directory-leases",
    );
    expect(readdirSync(leaseRoot)).toHaveLength(1);
    expect(existsSync(join(environment.WRENCH_STATE_HOME, "retained", "snapshot-worker")))
      .toBeTrue();
    const active = JSON.parse(readFileSync(join(
      environment.WRENCH_STATE_HOME,
      "recovery",
      "beeper-message-like-me-export-admission",
      "active.json",
    ), "utf8")) as Record<string, unknown>;
    expect(active.phase).toBe("cleanup-unsafe");
  });
});
