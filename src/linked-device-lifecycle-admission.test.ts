import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  LINKED_DEVICE_LIFECYCLE_ADMISSION_STATE_DIRECTORY,
  acquireLinkedDeviceLifecycleAdmission,
  recoverLinkedDeviceLifecycleAdmissions,
} from "./linked-device-lifecycle-admission";
import { canonicalJson } from "./model";

describe("linked-device lifecycle admission", () => {
  test("serializes one auth and fails closed on unexpected claim state", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "wrench-linked-device-claim-test-"),
    );
    chmodSync(directory, 0o700);
    const environment = { WRENCH_STATE_HOME: directory };
    const acquiredAt = "2026-07-25T12:00:00.000Z";
    const realmKey = "a".repeat(64);
    try {
      const admission = acquireLinkedDeviceLifecycleAdmission(
        realmKey,
        "whatsapp-main",
        acquiredAt,
        environment,
      );
      expect(() => acquireLinkedDeviceLifecycleAdmission(
        realmKey,
        "whatsapp-main",
        acquiredAt,
        environment,
      )).toThrow("active linked-device lifecycle");
      expect(recoverLinkedDeviceLifecycleAdmissions(environment))
        .toMatchObject({
          scanned: 1,
          live: 1,
          repaired: 0,
          invalid: 0,
          issues: [],
        });

      admission.release();
      expect(recoverLinkedDeviceLifecycleAdmissions(environment))
        .toMatchObject({
          scanned: 0,
          live: 0,
          invalid: 0,
          issues: [],
        });

      const claimDirectory = join(
        directory,
        ...LINKED_DEVICE_LIFECYCLE_ADMISSION_STATE_DIRECTORY.split("/"),
      );
      acquireLinkedDeviceLifecycleAdmission(
        realmKey,
        "whatsapp-main",
        acquiredAt,
        environment,
      );
      writeFileSync(
        join(claimDirectory, `${realmKey}.json`),
        `${canonicalJson({
          schemaVersion: 1,
          realmKey,
          authId: "whatsapp-main",
          acquiredAt,
          owner: {
            pid: 2_147_483_647,
            token: "11111111-1111-4111-8111-111111111111",
            bootId: "b".repeat(64),
            processStartId: "c".repeat(64),
            leaseUntil: "2026-07-25T12:30:00.000Z",
          },
        })}\n`,
        { mode: 0o600 },
      );
      expect(recoverLinkedDeviceLifecycleAdmissions(environment))
        .toMatchObject({
          scanned: 1,
          live: 0,
          repaired: 1,
          invalid: 0,
          issues: [],
        });

      writeFileSync(
        join(claimDirectory, "unexpected-secret-name"),
        "{}\n",
        { mode: 0o600 },
      );
      const report = recoverLinkedDeviceLifecycleAdmissions(environment);
      expect(report).toMatchObject({
        scanned: 1,
        live: 0,
        repaired: 0,
        invalid: 1,
      });
      expect(report.issues[0]).toMatchObject({
        authId: null,
        kind: "invalid-admission",
      });
      expect(report.issues[0]?.coordinate).toMatch(
        /^admission-[a-f0-9]{64}$/u,
      );
      expect(JSON.stringify(report)).not.toContain(
        "unexpected-secret-name",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
