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
import {
  acquireBeeperMessageLikeMeExportAdmission,
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeExportAdmission,
  releaseBeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";
import { exportWhatsAppMessageLikeMeFromAuth } from "./whatsapp-message-like-me-cli";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function boundAuth(path: string): WrenchAuth {
  return Object.freeze({
    schemaVersion: 1,
    id: "whatsapp-main",
    kind: "linked-device-store",
    provider: "whatsapp",
    path,
    subject: "whatsapp:pn:15551234567",
  });
}

describe("WhatsApp Message Like Me CLI recovery preflight", () => {
  test("rejects an active private export before inspecting the WhatsApp store", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "wrench-whatsapp-cli-recovery-test-")),
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
    const missingStore = join(root, "must-not-be-inspected");
    const outputRoot = join(parent, "must-not-be-created");
    const progress: string[] = [];

    try {
      await expect(exportWhatsAppMessageLikeMeFromAuth({
        auth: boundAuth(missingStore),
        outputRoot,
        environment,
        onProgress: (event) => progress.push(event.phase),
      })).rejects.toThrow(
        "another private message export is active or prior recovery is indeterminate",
      );
      expect(existsSync(missingStore)).toBeFalse();
      expect(existsSync(outputRoot)).toBeFalse();
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
      mkdtempSync(join(tmpdir(), "wrench-whatsapp-cli-source-failure-test-")),
    );
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const parent = join(root, "private-exports");
    mkdirSync(parent, { mode: 0o700 });
    const outputRoot = join(parent, "must-not-be-created");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };
    const progress: string[] = [];

    await expect(exportWhatsAppMessageLikeMeFromAuth({
      auth: boundAuth(join(root, "missing-store")),
      outputRoot,
      environment,
      onProgress: (event) => progress.push(event.phase),
    })).rejects.toThrow();

    expect(progress).toEqual([
      "recovery-started",
      "recovery-completed",
      "preparing",
    ]);
    expect(existsSync(outputRoot)).toBeFalse();
    expect(readdirSync(parent)).toEqual([]);

    const admissionAfterFailure = acquireBeeperMessageLikeMeExportAdmission({
      environment,
    });
    releaseBeeperMessageLikeMeExportAdmission(admissionAfterFailure);
  });
});
