import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";
import {
  parseCaptureArguments,
  type CaptureArguments,
  type CaptureOutcome,
} from "@hraness/kb/capture";
import type { AcquiredPage } from "@hraness/kb/clip/acquire";

import {
  BROWSER_ADMISSION_STATE_DIRECTORY,
  BrowserAdmissionError,
  LOCAL_BROWSER_ADMISSION_LIMIT,
  acquireBrowserAdmission,
  acquireCaptureBrowserWithAdmission,
  runCaptureWithBrowserAdmission,
  type BrowserAdmission,
  type BrowserAdmissionDependencies,
} from "./browser-admission";
import { canonicalJson, sha256 } from "./canonical-json";
import { currentProcessStartIdentity } from "./process-identity";
import { ensurePrivateStateDirectory, wrenchStateHome } from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;

const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;

function state(): {
  readonly directory: string;
  readonly environment: Environment;
} {
  const directory = mkdtempSync(join(tmpdir(), "wrench-browser-admission-test-"));
  chmodSync(directory, 0o700);
  return { directory, environment: { WRENCH_STATE_HOME: directory } };
}

function captureArguments(...extra: readonly string[]): CaptureArguments {
  const parsed = parseCaptureArguments([
    "capture",
    "https://example.com/article",
    "--mode",
    "browser",
    "--stdout",
    ...extra,
  ]);
  if (!parsed.ok || parsed.value.command !== "capture") {
    throw new Error(parsed.ok ? "fixture did not parse as capture" : parsed.message);
  }
  return parsed.value;
}

function acquiredPage(): AcquiredPage {
  return {
    body: "<article>bounded</article>",
    contentType: "text/html; charset=utf-8",
    finalUrl: new URL("https://example.com/article"),
    method: "browser-fresh",
    warnings: [],
  };
}

function captureOutcome(): CaptureOutcome {
  return {
    status: "complete",
    sourceUrl: "https://example.com/article",
    canonicalUrl: "https://example.com/article",
    platform: "generic",
    scope: "page",
    slug: "article",
    acquisitionMethod: "browser-fresh",
    extractor: "fixture",
    wordCount: 1,
    capturedItems: 1,
    expectedItems: 1,
    outputDirectory: null,
    markdownPath: null,
    assetCount: 0,
    warnings: [],
    attempts: [],
    markdown: "# Article\n",
    manifest: null,
  };
}

function fakeAdmission(events: string[]): BrowserAdmission {
  return Object.freeze({
    slot: 0,
    acquiredAt: "2026-08-15T00:00:00.000Z",
    owner: Object.freeze({
      pid: process.pid,
      token: "11111111-1111-4111-8111-111111111111",
      bootId: "a".repeat(64),
      processStartId: "b".repeat(64),
    }),
    release: () => {
      events.push("admission-released");
    },
  });
}

function admissionDependencies(
  overrides: BrowserAdmissionDependencies = {},
): BrowserAdmissionDependencies {
  const identity = {
    bootId: "a".repeat(64),
    processStartId: "b".repeat(64),
  };
  return {
    currentProcessIdentity: () => identity,
    ownerStatus: (owner) =>
      owner.pid === process.pid
      && owner.bootId === identity.bootId
      && owner.processStartId === identity.processStartId
        ? "exact-live-owner"
        : "different-or-dead",
    ...overrides,
  };
}

function holdStateMutation(
  directory: string,
  targetName: string,
  claimId: string,
): string {
  const mutationPath = join(
    directory,
    `.io-mutation-${sha256(`io-state-mutation\0${targetName}`)}-held-${claimId}.lock`,
  );
  writeFileSync(mutationPath, `${JSON.stringify({
    kind: "io-state-mutation-claim",
    schemaVersion: 1,
    targetSha256: sha256(`io-state-mutation\0${targetName}`),
    claimId,
    pid: process.pid,
    ...currentProcessStartIdentity(),
  })}\n`, { mode: 0o600 });
  return mutationPath;
}

describe("local browser admission", () => {
  test("admits at most two of eight child processes on a warmed state root", async () => {
    const testState = state();
    ensurePrivateStateDirectory(
      join(wrenchStateHome(testState.environment), "run-journals"),
      testState.environment,
    );
    expect(existsSync(join(testState.directory, "captures"))).toBeFalse();
    const controllerDirectory = mkdtempSync(
      join(tmpdir(), "wrench-browser-admission-controller-"),
    );
    chmodSync(controllerDirectory, 0o700);
    const startPath = join(controllerDirectory, "start");
    const releasePath = join(controllerDirectory, "release");
    const admissionModuleUrl = pathToFileURL(
      join(import.meta.dir, "browser-admission.ts"),
    ).href;
    const workerSource = `
      const { existsSync, writeFileSync } = await import("node:fs");
      const { acquireBrowserAdmission } = await import(${JSON.stringify(admissionModuleUrl)});
      const required = (name) => {
        const value = process.env[name];
        if (value === undefined || value.length === 0) {
          throw new Error(\`missing child environment: \${name}\`);
        }
        return value;
      };
      writeFileSync(required("WRENCH_TEST_READY"), "ready\\n", { mode: 0o600 });
      while (!existsSync(required("WRENCH_TEST_START"))) await Bun.sleep(5);
      const admission = await acquireBrowserAdmission({
        timeoutMs: 30_000,
        environment: process.env,
      });
      writeFileSync(required("WRENCH_TEST_ACQUIRED"), "acquired\\n", { mode: 0o600 });
      while (!existsSync(required("WRENCH_TEST_RELEASE"))) await Bun.sleep(5);
      admission.release();
      process.stdout.write(JSON.stringify({
        slot: admission.slot,
      }) + "\\n");
    `;
    const children = Array.from({ length: 8 }, (_value, index) => {
      const readyPath = join(controllerDirectory, `ready-${index}`);
      const acquiredPath = join(controllerDirectory, `acquired-${index}`);
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "--eval", workerSource],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            WRENCH_STATE_HOME: testState.directory,
            WRENCH_TEST_READY: readyPath,
            WRENCH_TEST_START: startPath,
            WRENCH_TEST_ACQUIRED: acquiredPath,
            WRENCH_TEST_RELEASE: releasePath,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return {
        child,
        readyPath,
        acquiredPath,
        stdout: new Response(child.stdout).text(),
        stderr: new Response(child.stderr).text(),
      };
    });
    try {
      const readyDeadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
      while (
        children.some((entry) => !existsSync(entry.readyPath))
        && performance.now() < readyDeadline
      ) {
        const exited = children.find((entry) => entry.child.exitCode !== null);
        if (exited !== undefined) {
          throw new Error(
            `cold-start child exited before release: ${await exited.stderr}`,
          );
        }
        await Bun.sleep(10);
      }
      expect(children.every((entry) => existsSync(entry.readyPath))).toBeTrue();
      writeFileSync(startPath, "start\n", { mode: 0o600 });

      const overlapDeadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
      while (
        children.filter((entry) => existsSync(entry.acquiredPath)).length
          < LOCAL_BROWSER_ADMISSION_LIMIT
        && performance.now() < overlapDeadline
      ) {
        const exited = children.find((entry) => entry.child.exitCode !== null);
        if (exited !== undefined) {
          throw new Error(
            `admission child exited before overlap: ${await exited.stderr}`,
          );
        }
        await Bun.sleep(10);
      }
      const acquiredBeforeRelease = children.filter((entry) =>
        existsSync(entry.acquiredPath)
      ).length;
      let thirdAdmissionOutcome: "admitted" | "timed-out";
      try {
        const unexpected = await acquireBrowserAdmission({
          timeoutMs: 3_000,
          environment: testState.environment,
        });
        unexpected.release();
        thirdAdmissionOutcome = "admitted";
      } catch (error) {
        expect(error).toMatchObject({ failure: "timed-out" });
        thirdAdmissionOutcome = "timed-out";
      }
      const acquiredAfterProbe = children.filter((entry) =>
        existsSync(entry.acquiredPath)
      ).length;
      writeFileSync(releasePath, "release\n", { mode: 0o600 });
      expect(acquiredBeforeRelease).toBe(LOCAL_BROWSER_ADMISSION_LIMIT);
      expect(acquiredAfterProbe).toBe(LOCAL_BROWSER_ADMISSION_LIMIT);
      expect(thirdAdmissionOutcome).toBe("timed-out");

      const results = await Promise.all(children.map(async (entry) => ({
        exitCode: await entry.child.exited,
        stdout: await entry.stdout,
        stderr: await entry.stderr,
      })));
      const failures = results.filter((result) => result.exitCode !== 0);
      expect(failures).toEqual([]);
      const intervals = results.map((result) => JSON.parse(result.stdout) as {
        readonly slot: 0 | 1;
      });
      expect(intervals).toHaveLength(8);
      expect(results.every((result) => result.stderr.length === 0)).toBeTrue();
      expect(new Set(intervals.map((interval) => interval.slot)))
        .toEqual(new Set([0, 1]));
    } finally {
      for (const entry of children) entry.child.kill(9);
      await Promise.allSettled(children.map((entry) => entry.child.exited));
      rmSync(controllerDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("admits exactly two owners and reuses only a released slot", async () => {
    const testState = state();
    try {
      const first = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      const second = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      expect(LOCAL_BROWSER_ADMISSION_LIMIT).toBe(2);
      expect(new Set([first.slot, second.slot])).toEqual(new Set([0, 1]));

      await expect(acquireBrowserAdmission({
        timeoutMs: 0,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      })).rejects.toMatchObject({ failure: "timed-out" });

      first.release();
      const replacement = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      expect(replacement.slot).toBe(first.slot);
      expect(replacement.owner.token).not.toBe(first.owner.token);
      replacement.release();
      second.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("adopts its exact claim after a committed create reports failure", async () => {
    const testState = state();
    let injected = 0;
    try {
      const admission = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies({
          afterCreateCommitForTest: () => {
            injected += 1;
            throw new Error("injected postcommit browser admission failure");
          },
        }),
      });
      expect(injected).toBe(1);
      expect(admission.slot).toBe(0);
      admission.release();
      expect(existsSync(join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
        "slot-0.json",
      ))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retries exact read drift on the first claim read", async () => {
    const testState = state();
    let reads = 0;
    let waits = 0;
    try {
      const initialized = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      initialized.release();
      const directory = join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
      );
      writeFileSync(join(directory, "slot-1.json"), "{}\n", { mode: 0o600 });

      const admission = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies({
          beforeClaimReadForTest: (slot) => {
            reads += 1;
            if (reads !== 1) return;
            expect(slot).toBe(0);
            throw new Error(
              "could not safely open optional browser admission claim",
              {
                cause: new Error(
                  "state helper: state file changed while it was read",
                ),
              },
            );
          },
          random: () => 0,
          sleep: async () => {
            waits += 1;
          },
        }),
      });

      expect(admission.slot).toBe(0);
      expect(reads).toBe(3);
      expect(waits).toBe(1);
      admission.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps unrelated first-read storage failures fatal", async () => {
    const testState = state();
    try {
      await expect(acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies({
          beforeClaimReadForTest: () => {
            throw new Error("unrelated first-read storage failure");
          },
        }),
      })).rejects.toThrow("unrelated first-read storage failure");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retries exact read drift after create contention", async () => {
    const testState = state();
    let mutationPath: string | null = null;
    let contendedReads = 0;
    let waits = 0;
    try {
      const initialized = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      initialized.release();
      const directory = join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
      );
      writeFileSync(join(directory, "slot-1.json"), "{}\n", { mode: 0o600 });
      mutationPath = holdStateMutation(
        directory,
        "slot-0.json",
        "44444444-4444-4444-8444-444444444444",
      );

      const admission = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies({
          beforeContendedClaimReadForTest: (slot) => {
            contendedReads += 1;
            expect(slot).toBe(0);
            throw new Error(
              "could not safely open optional browser admission claim",
              {
                cause: new Error(
                  "state helper: state file changed while it was read",
                ),
              },
            );
          },
          random: () => 0,
          sleep: async () => {
            waits += 1;
            if (mutationPath === null) {
              throw new Error("expected browser admission mutation claim");
            }
            rmSync(mutationPath, { force: true });
          },
        }),
      });

      expect(admission.slot).toBe(0);
      expect(contendedReads).toBe(1);
      expect(waits).toBe(1);
      admission.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps unrelated contended-read storage failures fatal", async () => {
    const testState = state();
    try {
      const initialized = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      initialized.release();
      const directory = join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
      );
      holdStateMutation(
        directory,
        "slot-0.json",
        "55555555-5555-4555-8555-555555555555",
      );

      await expect(acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies({
          beforeContendedClaimReadForTest: () => {
            throw new Error("unrelated contended-read storage failure");
          },
        }),
      })).rejects.toThrow("unrelated contended-read storage failure");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retries exact release after transient state-mutation contention", async () => {
    const testState = state();
    let mutationClaimPath: string | null = null;
    let releaseContentions = 0;
    let releaseNow = 0;
    try {
      const admission = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies({
          afterReleaseContentionForTest: () => {
            releaseContentions += 1;
          },
          releaseMonotonicNowForTest: () => releaseNow,
          releaseWaitForTest: () => {
            if (mutationClaimPath === null) {
              throw new Error("expected browser admission mutation claim");
            }
            releaseNow = 30_500;
            rmSync(mutationClaimPath, { force: true });
          },
        }),
      });
      const directory = join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
      );
      const claimName = `slot-${admission.slot}.json`;
      const targetSha256 = sha256(`io-state-mutation\0${claimName}`);
      const claimId = "33333333-3333-4333-8333-333333333333";
      mutationClaimPath = join(
        directory,
        `.io-mutation-${targetSha256}-held-${claimId}.lock`,
      );
      writeFileSync(mutationClaimPath, `${JSON.stringify({
        kind: "io-state-mutation-claim",
        schemaVersion: 1,
        targetSha256,
        claimId,
        pid: process.pid,
        ...currentProcessStartIdentity(),
      })}\n`, { mode: 0o600 });

      admission.release();
      admission.release();
      expect(releaseContentions).toBe(1);
      expect(releaseNow).toBeGreaterThan(30_000);
      expect(existsSync(mutationClaimPath)).toBeFalse();
      expect(existsSync(join(directory, claimName))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("caps local admission queueing at thirty seconds", async () => {
    const testState = state();
    let now = 0;
    try {
      const dependencies = admissionDependencies({ monotonicNow: () => now });
      const first = await acquireBrowserAdmission({
        timeoutMs: 60_000,
        environment: testState.environment,
        dependencies,
      });
      const second = await acquireBrowserAdmission({
        timeoutMs: 60_000,
        environment: testState.environment,
        dependencies,
      });
      await expect(acquireBrowserAdmission({
        timeoutMs: 60_000,
        environment: testState.environment,
        dependencies: admissionDependencies({
          monotonicNow: () => now,
          random: () => 0,
          sleep: async () => {
            now = 30_000;
          },
        }),
      })).rejects.toThrow("polling budget cap: 30 seconds");
      first.release();
      second.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reclaims only a verified claim from a prior operating-system boot", async () => {
    const testState = state();
    try {
      const initialized = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      initialized.release();
      const directory = join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
      );
      writeFileSync(join(directory, "slot-0.json"), `${canonicalJson({
        schemaVersion: 1,
        slot: 0,
        acquiredAt: "2026-08-15T00:00:00.000Z",
        owner: {
          pid: 2_147_483_647,
          token: "22222222-2222-4222-8222-222222222222",
          bootId: "c".repeat(64),
          processStartId: "d".repeat(64),
        },
      })}\n`, { mode: 0o600 });

      const reclaimed = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      expect(reclaimed.slot).toBe(0);
      expect(reclaimed.owner.pid).toBe(process.pid);
      reclaimed.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps a same-boot dead-owner claim occupied", async () => {
    const testState = state();
    let now = 0;
    try {
      const initialized = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      initialized.release();
      const directory = join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
      );
      const stalePath = join(directory, "slot-0.json");
      const staleContent = `${canonicalJson({
        schemaVersion: 1,
        slot: 0,
        acquiredAt: "2026-08-15T00:00:00.000Z",
        owner: {
          pid: 2_147_483_647,
          token: "22222222-2222-4222-8222-222222222222",
          bootId: "a".repeat(64),
          processStartId: "d".repeat(64),
        },
      })}\n`;
      writeFileSync(stalePath, staleContent, { mode: 0o600 });

      const second = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      expect(second.slot).toBe(1);
      await expect(acquireBrowserAdmission({
        timeoutMs: 10,
        environment: testState.environment,
        dependencies: admissionDependencies({
          monotonicNow: () => now,
          random: () => 0,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
        }),
      })).rejects.toMatchObject({ failure: "timed-out" });
      expect(readFileSync(stalePath, "utf8")).toBe(staleContent);
      second.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps a killed child claim occupied and denies a third admission", async () => {
    const testState = state();
    const controllerDirectory = mkdtempSync(
      join(tmpdir(), "wrench-browser-killed-owner-"),
    );
    chmodSync(controllerDirectory, 0o700);
    const readyPath = join(controllerDirectory, "ready.json");
    const admissionModuleUrl = pathToFileURL(
      join(import.meta.dir, "browser-admission.ts"),
    ).href;
    const initialized = await acquireBrowserAdmission({
      timeoutMs: 10_000,
      environment: testState.environment,
      dependencies: admissionDependencies(),
    });
    initialized.release();
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `
          const { writeFileSync } = await import("node:fs");
          const { acquireBrowserAdmission } = await import(${JSON.stringify(admissionModuleUrl)});
          const admission = await acquireBrowserAdmission({
            timeoutMs: 10_000,
            environment: process.env,
          });
          writeFileSync(
            process.env.WRENCH_TEST_READY,
            JSON.stringify({ slot: admission.slot, owner: admission.owner }) + "\\n",
            { mode: 0o600 },
          );
          await Bun.sleep(60_000);
          admission.release();
        `,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          WRENCH_STATE_HOME: testState.directory,
          WRENCH_TEST_READY: readyPath,
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const childStderr = new Response(child.stderr).text();
    let second: BrowserAdmission | null = null;
    try {
      const readyDeadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
      while (
        !existsSync(readyPath)
        && child.exitCode === null
        && performance.now() < readyDeadline
      ) {
        await Bun.sleep(10);
      }
      if (!existsSync(readyPath)) {
        throw new Error(
          `killed-owner child did not acquire admission: ${await childStderr}`,
        );
      }
      const childClaim = JSON.parse(readFileSync(readyPath, "utf8")) as {
        readonly slot: 0 | 1;
        readonly owner: { readonly pid: number; readonly bootId: string };
      };
      child.kill(9);
      expect(await child.exited).not.toBe(0);

      second = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
      });
      expect(second.slot).not.toBe(childClaim.slot);
      await expect(acquireBrowserAdmission({
        timeoutMs: 150,
        environment: testState.environment,
      })).rejects.toMatchObject({ failure: "timed-out" });

      const retained = JSON.parse(readFileSync(join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
        `slot-${childClaim.slot}.json`,
      ), "utf8")) as { readonly owner: { readonly pid: number } };
      expect(retained.owner.pid).toBe(child.pid);
      expect(childClaim.owner.pid).toBe(child.pid);
      expect(childClaim.owner.bootId).toBe(currentProcessStartIdentity().bootId);
    } finally {
      second?.release();
      child.kill(9);
      await Promise.allSettled([child.exited, childStderr]);
      rmSync(controllerDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rolls back a slot acquired after its monotonic deadline", async () => {
    const testState = state();
    let clockReads = 0;
    try {
      await expect(acquireBrowserAdmission({
        timeoutMs: 50,
        environment: testState.environment,
        dependencies: admissionDependencies({
          monotonicNow: () => {
            clockReads += 1;
            return clockReads < 4 ? 0 : 50;
          },
        }),
      })).rejects.toMatchObject({ failure: "timed-out" });

      const replacement = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      expect(replacement.slot).toBe(0);
      replacement.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps malformed claims occupied and bounds jittered cancellation", async () => {
    const testState = state();
    const controller = new AbortController();
    let now = 0;
    const delays: number[] = [];
    try {
      const initialized = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      initialized.release();
      const directory = join(
        testState.directory,
        ...BROWSER_ADMISSION_STATE_DIRECTORY.split("/"),
      );
      const malformedPath = join(directory, "slot-0.json");
      writeFileSync(malformedPath, "{\"schemaVersion\":1}\n", { mode: 0o600 });
      const second = await acquireBrowserAdmission({
        timeoutMs: 10_000,
        environment: testState.environment,
        dependencies: admissionDependencies(),
      });
      expect(second.slot).toBe(1);

      await expect(acquireBrowserAdmission({
        timeoutMs: 1_000,
        environment: testState.environment,
        signal: controller.signal,
        dependencies: admissionDependencies({
          monotonicNow: () => now,
          ownerStatus: () => "unknown",
          random: () => 0,
          sleep: (milliseconds) => {
            delays.push(milliseconds);
            now += milliseconds;
            controller.abort();
            return Promise.reject(new BrowserAdmissionError("cancelled"));
          },
        }),
      })).rejects.toMatchObject({ failure: "cancelled" });
      expect(delays).toEqual([19]);
      expect(readFileSync(malformedPath, "utf8")).toBe("{\"schemaVersion\":1}\n");
      second.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("browser admission wiring", () => {
  test("holds a local capture slot through upstream acquisition cleanup settlement", async () => {
    const events: string[] = [];
    let now = 100;
    const page = await acquireCaptureBrowserWithAdmission(
      captureArguments("--timeout-ms", "1000"),
      tmpdir(),
      false,
      {},
      {
        monotonicNow: () => now,
        acquireAdmission: () => {
          events.push("admission-acquired");
          now = 175;
          return Promise.resolve(fakeAdmission(events));
        },
        acquireBrowser: (options) => {
          events.push(`browser-timeout-${options.timeoutMs}`);
          events.push("browser-cleanup-settled");
          return Promise.resolve(acquiredPage());
        },
      },
    );
    expect(page.method).toBe("browser-fresh");
    expect(events).toEqual([
      "admission-acquired",
      "browser-timeout-925",
      "browser-cleanup-settled",
      "admission-released",
    ]);
  });

  test("does not admit browser-live or explicit CDP attachments", async () => {
    for (const arguments_ of [
      captureArguments("--browser-live"),
      captureArguments("--cdp", "9222"),
    ]) {
      let acquisitions = 0;
      await acquireCaptureBrowserWithAdmission(
        arguments_,
        tmpdir(),
        false,
        {},
        {
          acquireAdmission: () => {
            throw new Error("attached browser must not acquire a local slot");
          },
          acquireBrowser: () => {
            acquisitions += 1;
            return Promise.resolve(acquiredPage());
          },
        },
      );
      expect(acquisitions).toBe(1);
    }
  });

  test("releases admission after upstream browser acquisition fails", async () => {
    const events: string[] = [];
    await expect(acquireCaptureBrowserWithAdmission(
      captureArguments(),
      tmpdir(),
      false,
      {},
      {
        acquireAdmission: () => {
          events.push("admission-acquired");
          return Promise.resolve(fakeAdmission(events));
        },
        acquireBrowser: () => {
          events.push("browser-failed");
          return Promise.reject(new Error("injected browser acquisition failure"));
        },
      },
    )).rejects.toThrow("injected browser acquisition failure");
    expect(events).toEqual([
      "admission-acquired",
      "browser-failed",
      "admission-released",
    ]);
  });

  test("passes command cancellation into local admission", async () => {
    const controller = new AbortController();
    controller.abort();
    let observedSignal: AbortSignal | undefined;
    await expect(acquireCaptureBrowserWithAdmission(
      captureArguments(),
      tmpdir(),
      false,
      {},
      {
        signal: controller.signal,
        acquireAdmission: (options) => {
          observedSignal = options.signal;
          return Promise.reject(new BrowserAdmissionError("cancelled"));
        },
        acquireBrowser: () => {
          throw new Error("cancelled admission must not launch a browser");
        },
      },
    )).rejects.toMatchObject({ failure: "cancelled" });
    expect(observedSignal).toBe(controller.signal);
  });

  test("releases without launching when cancellation wins the admission handoff", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await expect(acquireCaptureBrowserWithAdmission(
      captureArguments(),
      tmpdir(),
      false,
      {},
      {
        signal: controller.signal,
        acquireAdmission: () => {
          events.push("admission-acquired");
          controller.abort();
          return Promise.resolve(fakeAdmission(events));
        },
        acquireBrowser: () => {
          events.push("browser-launched");
          return Promise.resolve(acquiredPage());
        },
      },
    )).rejects.toMatchObject({ failure: "cancelled" });
    expect(events).toEqual([
      "admission-acquired",
      "admission-released",
    ]);
  });

  test("injects the admitted browser seam into @hraness/kb runCapture", async () => {
    const events: string[] = [];
    const outcome = await runCaptureWithBrowserAdmission(
      captureArguments(),
      {},
      {
        acquireAdmission: () => {
          events.push("admission-acquired");
          return Promise.resolve(fakeAdmission(events));
        },
        acquireBrowser: () => {
          events.push("browser-settled");
          return Promise.resolve(acquiredPage());
        },
        runCapture: async (options, dependencies) => {
          const acquireBrowser = dependencies?.acquireBrowser;
          if (acquireBrowser === undefined) {
            throw new Error("browser admission seam was not installed");
          }
          await acquireBrowser(options, tmpdir(), false);
          return captureOutcome();
        },
      },
    );
    expect(outcome.status).toBe("complete");
    expect(events).toEqual([
      "admission-acquired",
      "browser-settled",
      "admission-released",
    ]);
  });
});
