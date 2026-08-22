import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { WrenchAuth } from "./auth";
import { exportBeeperMessageLikeMeFromAuth } from "./beeper-message-like-me-cli";
import {
  acquireBeeperMessageLikeMeExportAdmission,
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeExportAdmission,
  releaseBeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Beeper Message Like Me CLI recovery preflight", () => {
  test("rejects an active export before inspecting the requested auth", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "wrench-beeper-cli-recovery-test-")),
    );
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const parent = join(root, "private-exports");
    mkdirSync(parent, { mode: 0o700 });
    const working = join(parent, "active-working");
    mkdirSync(working, { mode: 0o700 });
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const nowMs = Date.now();
    const activeLease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: working,
      recoverAfterMs: nowMs + 60_000,
      environment,
      nowMs,
    });
    const deliberatelyInvalidAuth = {
      schemaVersion: 999,
      kind: "not-an-auth-kind",
    } as unknown as WrenchAuth;
    const progress: string[] = [];

    try {
      await expect(exportBeeperMessageLikeMeFromAuth({
        auth: deliberatelyInvalidAuth,
        outputRoot: join(parent, "must-not-be-created"),
        environment,
        onProgress: (event) => progress.push(event.phase),
      })).rejects.toThrow(
        "another export is active or prior private export recovery is indeterminate",
      );
      expect(existsSync(working)).toBeTrue();
      expect(existsSync(join(parent, "must-not-be-created"))).toBeFalse();
      expect(existsSync(activeLease.claimPath)).toBeTrue();
      expect(progress).toEqual(["recovery-started"]);

      const admissionAfterFailure = acquireBeeperMessageLikeMeExportAdmission({
        environment,
      });
      releaseBeeperMessageLikeMeExportAdmission(admissionAfterFailure);
    } finally {
      releaseBeeperMessageLikeMeDirectoryLease(activeLease);
    }
  });

  test("releases global admission after post-recovery source setup fails", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "wrench-beeper-cli-source-failure-test-")),
    );
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const parent = join(root, "private-exports");
    mkdirSync(parent, { mode: 0o700 });
    const outputRoot = join(parent, "must-not-be-created");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const deliberatelyInvalidAuth = {
      schemaVersion: 999,
      kind: "not-an-auth-kind",
    } as unknown as WrenchAuth;
    const progress: string[] = [];

    await expect(exportBeeperMessageLikeMeFromAuth({
      auth: deliberatelyInvalidAuth,
      outputRoot,
      environment,
      onProgress: (event) => progress.push(event.phase),
    })).rejects.toThrow();

    expect(progress).toEqual(["recovery-started", "recovery-completed"]);
    expect(existsSync(outputRoot)).toBeFalse();
    expect(readdirSync(parent)).toEqual([]);

    const admissionAfterFailure = acquireBeeperMessageLikeMeExportAdmission({
      environment,
    });
    releaseBeeperMessageLikeMeExportAdmission(admissionAfterFailure);
  });
});
