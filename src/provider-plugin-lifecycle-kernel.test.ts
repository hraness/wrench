import {
  chmodSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  initialLinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleJournalSnapshot,
} from "./linked-device-lifecycle-journal";
import type { PortableOperationIdentityV1 } from "./provider-plugin-portable-identity";
import type {
  PortableProviderPluginInvocationLeaseSnapshot,
} from "./provider-plugin-invocation-lease";
import {
  inspectPortableProviderPluginQuiescence,
  type PortableProviderPluginQuiescenceDependencies,
} from "./provider-plugin-lifecycle-kernel";
import type { RecoveryCapsule } from "./recovery";
import type { RunJournalSnapshot } from "./run-journal";
import type {
  ConfirmationClaimSnapshot,
  RunReceipt,
  StoredPlan,
} from "./runtime";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const runId = "12345678-1234-4123-8123-123456789abc";
const planDigest = "d".repeat(64);
const at = "2026-07-25T12:00:00.000Z";

const identity: PortableOperationIdentityV1 = Object.freeze({
  pluginId: "portable-test",
  pluginVersion: "1.0.0",
  hostApiVersion: 1,
  bundleSha256: hashA,
  manifestSha256: hashB,
  adapterId: "portable-test",
  transport: "web-session-api",
  surfaceId: "portable-test",
  operation: "records.write",
  contractVersion: 1,
  descriptorSha256: hashC,
});

const storedPlan: StoredPlan = Object.freeze({
  digest: planDigest,
  plan: Object.freeze({
    schemaVersion: 6,
    id: runId,
    createdAt: at,
    expiresAt: "2026-07-25T12:05:00.000Z",
    adapter: {
      id: "portable-test",
      version: "1.0.0",
      hash: hashB,
    },
    operation: "records.write",
    risk: "R2",
    sideEffect: "writes one record",
    input: {},
    inputHash: hashC,
    dispatches: [{
      id: "records.write",
      description: "writes one record",
    }],
    auth: {
      id: "portable-auth",
      hash: hashA,
      kind: "cookies-file" as const,
    },
    transport: "portable-provider-plugin",
    portablePluginContract: identity,
  }),
});

function journalSnapshot(
  settled: boolean,
): RunJournalSnapshot {
  return {
    journal: {
      schemaVersion: 1,
      revision: settled ? 8 : 0,
      runId,
      planDigest,
      adapter: {
        id: "portable-test",
        version: "1.0.0",
        hash: hashB,
      },
      operation: "records.write",
      risk: "R2",
      inputHash: hashC,
      auth: {
        id: "portable-auth",
        hash: hashA,
        kind: "cookies-file",
      },
      contract: {
        transport: "portable-provider-plugin",
        identity,
      },
      planHasAssets: false,
      planState: settled ? "consumed" : "available",
      phase: settled ? "terminal" : "prepared",
      status: settled ? "partial" : "pending",
      dispatch: {
        planned: 2,
        started: settled ? 1 : 0,
        verified: settled ? 1 : 0,
      },
      ledgerRelativePath: settled ? "idempotency/example.json" : null,
      ledgerState: settled ? "partial" : "unclaimed",
      recoveryState: settled ? "released" : "absent",
      assetState: "none",
      owner: {
        pid: 123,
        token: runId,
        bootId: hashA,
        processStartId: hashB,
        leaseUntil: "2026-07-25T12:10:00.000Z",
      },
      startedAt: at,
      updatedAt: at,
      dedupeExpiresAt: "2026-07-25T12:10:00.000Z",
      finalOrigin: null,
      error: settled ? "requires reconciliation" : null,
    },
    contentSha256: hashC,
  };
}

const pendingReceipt: RunReceipt = Object.freeze({
  schemaVersion: 6,
  runId,
  planDigest,
  adapter: {
    id: "portable-test",
    version: "1.0.0",
    hash: hashB,
  },
  operation: "records.write",
  risk: "R2",
  inputHash: hashC,
  auth: {
    id: "portable-auth",
    hash: hashA,
    kind: "cookies-file" as const,
  },
  transport: "portable-provider-plugin",
  portablePluginContract: identity,
  status: "partial",
  dispatchStarted: true,
  dispatch: { planned: 2, started: 1, verified: 1 },
  startedAt: at,
  finishedAt: at,
  finalOrigin: null,
  error: "requires reconciliation",
});

const capsule: RecoveryCapsule = Object.freeze({
  schemaVersion: 1,
  runId,
  createdAt: at,
  planDigest,
  adapter: {
    id: "portable-test",
    version: "1.0.0",
    hash: hashB,
  },
  operation: "records.write",
  risk: "R2",
  input: {},
  inputHash: hashC,
  auth: {
    id: "portable-auth",
    hash: hashA,
    kind: "cookies-file" as const,
  },
  contract: {
    transport: "portable-provider-plugin" as const,
    identity,
  },
});

function linkedSnapshot(): LinkedDeviceLifecycleJournalSnapshot {
  return {
    journal: initialLinkedDeviceLifecycleJournal({
      journalId: runId,
      kind: "sync-once",
      pluginId: "portable-test",
      pluginVersion: "1.0.0",
      pluginImplementationHash: hashA,
      lifecycleContractVersion: 1,
      surfaceId: "portable-test",
      authId: "portable-auth",
      authRealmHash: hashB,
      authContentHash: hashC,
      initialSubjectState: "bound",
      phoneProvided: false,
      owner: {
        pid: 123,
        token: runId,
        bootId: hashA,
        processStartId: hashB,
        leaseUntil: "2026-07-25T12:10:00.000Z",
      },
      startedAt: at,
    }),
    contentSha256: hashA,
  };
}

function leaseSnapshot(): PortableProviderPluginInvocationLeaseSnapshot {
  return {
    lease: {
      schemaVersion: 1,
      leaseId: runId,
      runId,
      identity,
      owner: {
        pid: 123,
        token: runId,
        bootId: hashA,
        processStartId: hashB,
      },
      acquiredAt: at,
    },
    contentSha256: hashA,
  };
}

function confirmationClaim(): ConfirmationClaimSnapshot {
  return {
    claim: {
      schemaVersion: 1,
      digest: planDigest,
      runId,
      owner: {
        pid: 123,
        token: runId,
        bootId: hashA,
        processStartId: hashB,
        leaseUntil: "2026-07-25T12:10:00.000Z",
      },
      createdAt: at,
    },
    contentSha256: hashA,
  };
}

function dependencies(
  overrides: Partial<PortableProviderPluginQuiescenceDependencies> = {},
): PortableProviderPluginQuiescenceDependencies {
  return {
    listPlans: () => [],
    loadPlan: () => {
      throw new Error("unexpected plan load");
    },
    listConfirmationClaims: () => [],
    listInvocationLeases: () => [],
    invocationLeaseOwnerStatus: () => "different-or-dead",
    listStateDirectory: () => [],
    listReceipts: () => [],
    listJournals: () => [],
    listRecoveryCapsules: () => [],
    listLinkedDeviceLifecycles: () => [],
    ...overrides,
  };
}

const roots: string[] = [];

function environment(): Readonly<Record<string, string | undefined>> {
  const root = mkdtempSync(join(tmpdir(), "wrench-plugin-lifecycle-kernel-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { WRENCH_STATE_HOME: join(root, "wrench-home"), HOME: root };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("portable provider plugin lifecycle kernel", () => {
  test("fails closed on every malformed or unexpected durable coordinate", () => {
    const report = inspectPortableProviderPluginQuiescence(
      hashA,
      environment(),
      dependencies({
        listStateDirectory: () => [{
          name: "mystery",
          kind: "symbolic-link",
        }],
        listPlans: () => [{ digest: planDigest, invalid: true }],
        listConfirmationClaims: () => [{
          digest: planDigest,
          invalid: true,
        }],
        listInvocationLeases: () => [{
          leaseId: runId,
          invalid: true,
        }],
        listReceipts: () => [{ runId, invalid: true }],
        listJournals: () => [{ runId, invalid: true }],
        listRecoveryCapsules: () => [{ runId, invalid: true }],
        listLinkedDeviceLifecycles: () => [{
          journalId: runId,
          invalid: true,
        }],
      }),
    );
    expect(report.quiescent).toBeFalse();
    expect(new Set(report.blockers.map((blocker) => blocker.kind))).toEqual(
      new Set([
        "unexpected-state-entry",
        "invalid-plan",
        "invalid-confirmation-claim",
        "invalid-invocation-lease",
        "invalid-run-receipt",
        "invalid-run-journal",
        "invalid-recovery-capsule",
        "invalid-linked-device-lifecycle",
      ]),
    );
  });

  test("blocks every direct or indirect live reference to the exact bundle", () => {
    const report = inspectPortableProviderPluginQuiescence(
      hashA,
      environment(),
      dependencies({
        listPlans: () => [{
          digest: planDigest,
          createdAt: at,
          expiresAt: "2026-07-25T12:05:00.000Z",
          adapter: { id: "portable-test", version: "1.0.0" },
          operation: "records.write",
          risk: "R2",
          auth: { id: "portable-auth", kind: "cookies-file" },
        }],
        loadPlan: () => storedPlan,
        listConfirmationClaims: () => [confirmationClaim()],
        listInvocationLeases: () => [leaseSnapshot()],
        invocationLeaseOwnerStatus: () => "exact-live-owner",
        listReceipts: () => [pendingReceipt],
        listJournals: () => [journalSnapshot(false)],
        listRecoveryCapsules: () => [{ capsule }],
        listLinkedDeviceLifecycles: () => [linkedSnapshot()],
      }),
    );
    expect(report.quiescent).toBeFalse();
    expect(new Set(report.blockers.map((blocker) => blocker.kind))).toEqual(
      new Set([
        "invocation-lease",
        "confirmation-plan",
        "confirmation-claim",
        "run-journal",
        "run-receipt",
        "recovery-capsule",
        "linked-device-lifecycle",
      ]),
    );
  });

  test("blocks a matching v2 host-active tombstone with unknown ownership", () => {
    const activeLease: PortableProviderPluginInvocationLeaseSnapshot = {
      lease: {
        schemaVersion: 2,
        leaseId: runId,
        runId,
        identity,
        owner: {
          pid: 123,
          token: runId,
          bootId: hashA,
          processStartId: hashB,
        },
        acquiredAt: at,
        containment: {
          status: "host-active",
          host: {
            pid: 456,
            bootId: hashA,
            processStartId: hashC,
          },
        },
      },
      contentSha256: hashA,
    };
    const report = inspectPortableProviderPluginQuiescence(
      hashA,
      environment(),
      dependencies({
        listInvocationLeases: () => [activeLease],
        invocationLeaseOwnerStatus: () => "unknown",
      }),
    );

    expect(report).toMatchObject({
      quiescent: false,
      blockerCount: 1,
      blockers: [{
        kind: "invocation-lease",
        coordinate: runId,
      }],
    });
  });

  test("accepts historical receipts once their exact journal released recovery", () => {
    const report = inspectPortableProviderPluginQuiescence(
      hashA,
      environment(),
      dependencies({
        listInvocationLeases: () => [leaseSnapshot()],
        invocationLeaseOwnerStatus: () => "different-or-dead",
        listReceipts: () => [pendingReceipt],
        listJournals: () => [journalSnapshot(true)],
      }),
    );
    expect(report).toMatchObject({
      bundleSha256: hashA,
      quiescent: true,
      blockerCount: 0,
      blockers: [],
    });
  });

  test("whitelists the linked-device admission directory but inspects its exact shape", () => {
    const valid = inspectPortableProviderPluginQuiescence(
      hashA,
      environment(),
      dependencies({
        listStateDirectory: (path) => {
          if (path.endsWith("/run-journals")) {
            return [
              { name: "linked-device-lifecycle", kind: "directory" },
              {
                name: "linked-device-lifecycle-admissions",
                kind: "directory",
              },
            ];
          }
          if (path.endsWith("/linked-device-lifecycle-admissions")) {
            return [{ name: `${hashB}.json`, kind: "file" }];
          }
          return [];
        },
      }),
    );
    expect(valid).toMatchObject({
      quiescent: true,
      blockerCount: 0,
    });

    const invalid = inspectPortableProviderPluginQuiescence(
      hashA,
      environment(),
      dependencies({
        listStateDirectory: (path) =>
          path.endsWith("/linked-device-lifecycle-admissions")
            ? [{ name: "mystery", kind: "symbolic-link" }]
            : [],
      }),
    );
    expect(invalid.blockers).toContainEqual({
      kind: "unexpected-state-entry",
      coordinate: "linked-device lifecycle admissions/mystery",
      reason: "unexpected symbolic-link state can hide portable plugin ownership",
    });
  });
});
