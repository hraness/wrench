import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { WrenchAuth } from "./auth";
import {
  acquireBeeperMessageLikeMeExportAdmission,
  createBeeperMessageLikeMeDirectoryLease,
  recoverBeeperMessageLikeMeDirectoryLeases,
  releaseBeeperMessageLikeMeExportAdmission,
  releaseBeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";
import { exportWhatsAppMessageLikeMeFromAuth } from "./whatsapp-message-like-me-cli";
import { WhatsAppContactProjectionCleanupUnverifiedError } from "./providers/whatsapp-web-runtime";

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
  test("keeps a durable helper lease and admission when process death is unproven", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "wrench-whatsapp-cli-indeterminate-test-")),
    );
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const store = join(root, "store");
    mkdirSync(store, { mode: 0o700 });
    for (const name of ["session.db", "wacli.db"]) {
      writeFileSync(join(store, name), "fixed");
    }
    chmodSync(join(store, "session.db"), 0o600);
    chmodSync(join(store, "wacli.db"), 0o600);
    const outputRoot = join(root, "bundle");
    const environment = { WRENCH_STATE_HOME: join(root, "state") };

    await expect(exportWhatsAppMessageLikeMeFromAuth({
      auth: boundAuth(store),
      outputRoot,
      environment,
      sourceDependencies: {
        helperPath: "/private/fixed/helper.ts",
        configPath: "/private/fixed/config.toml",
        runSessionHelper: async (invocation) => {
          invocation.onSpawned?.(process.pid);
          throw new WhatsAppContactProjectionCleanupUnverifiedError();
        },
      },
    })).rejects.toBeInstanceOf(WhatsAppContactProjectionCleanupUnverifiedError);

    const recovery = await recoverBeeperMessageLikeMeDirectoryLeases({ environment });
    expect(recovery).toMatchObject({ active: 1, indeterminate: 0 });
    expect(() => acquireBeeperMessageLikeMeExportAdmission({ environment }))
      .toThrow("another export is active");

    const cleanup = await recoverBeeperMessageLikeMeDirectoryLeases({
      environment,
      inspectOwner: () => "different-or-dead",
    });
    expect(cleanup.recovered).toBe(1);
  });

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
