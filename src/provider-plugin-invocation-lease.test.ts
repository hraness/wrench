import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  acquirePortableProviderPluginInvocationLease,
  createPortableProviderPluginInvocationLeaseContainmentController,
  listPortableProviderPluginInvocationLeases,
  portableProviderPluginInvocationLeaseOwnerStatus,
  recoverPortableProviderPluginInvocationLeaseTombstones,
  releasePortableProviderPluginInvocationLease,
  repairPortableProviderPluginInvocationLeases,
  type PortableProviderPluginInvocationLease,
} from "./provider-plugin-invocation-lease";
import {
  createPortableOperationIdentityV1,
  type PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import {
  renderPortableProviderPluginManifest,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginManifestV1,
} from "./provider-plugin-package";
import {
  installPortableProviderPluginPackage,
} from "./provider-plugin-store";
import {
  captureProcessOwnerIdentity,
} from "./process-identity";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  wrenchStateHome,
} from "./storage";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const hashD = "d".repeat(64);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function installPortableTestPackage(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
): PortableOperationIdentityV1 {
  const packageRoot = join(root, "portable-test-package");
  const runtime = Buffer.from("export {};\n", "utf8");
  const operation = {
    name: "records.read",
    contractVersion: 1,
    timeoutMs: 3_000,
    maxOutputBytes: 4_096,
    state: "observed",
    risk: "R1",
    dispatch: "none",
    sideEffect: "none",
    idempotency: "none",
    dedupeWindowMs: 0,
    input: {
      properties: {},
      required: [],
    },
    implementation: "Reads bounded records.",
  } as const;
  const binding = {
    transport: "web-session-api",
    adapterId: "portable-test",
    surfaceId: "portable-test",
    origin: "https://portable.example",
    authKinds: ["cookies-file"],
    subject: {
      format: "portable test account",
      kind: "opaque-token",
      probe: {
        operation: operation.name,
        contractVersion: operation.contractVersion,
      },
    },
    operations: [operation],
  } as const;
  const manifest: PortableProviderPluginManifestV1 = {
    schemaVersion: 1,
    hostApiVersion: 1,
    id: "portable-test",
    version: "1.0.0",
    displayName: "Portable test",
    runtime: {
      kind: "bun-js",
      entrypoint: "dist/plugin.mjs",
    },
    provenance: { kind: "local" },
    capabilities: {
      networkOrigins: [binding.origin],
      planFiles: "none",
      state: "namespaced",
      sessionMaterial: [],
    },
    bindings: [binding],
    files: [{
      path: "dist/plugin.mjs",
      kind: "runtime",
      bytes: runtime.byteLength,
      sha256: sha256(runtime),
    }],
  };
  mkdirSync(join(packageRoot, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(packageRoot, "dist", "plugin.mjs"), runtime, {
    mode: 0o600,
  });
  writeFileSync(
    join(packageRoot, "wrench-plugin.json"),
    renderPortableProviderPluginManifest(manifest),
    { mode: 0o600 },
  );
  const verified = verifyPortableProviderPluginPackageDirectory(packageRoot);
  installPortableProviderPluginPackage(packageRoot, {
    storeRoot: join(wrenchStateHome(environment), "provider-plugins"),
    approval: {
      decision: "trust-executable-code",
      pluginId: verified.manifest.id,
      pluginVersion: verified.manifest.version,
      bundleSha256: verified.bundleSha256,
    },
    expectedCurrentBundleSha256: null,
    now: new Date("2026-07-25T12:00:00.000Z"),
    assertActivatable: () => undefined,
    assertCurrentQuiescent: () => undefined,
  });
  return createPortableOperationIdentityV1({
    package: {
      id: verified.manifest.id,
      version: verified.manifest.version,
      hostApiVersion: verified.manifest.hostApiVersion,
      bundleSha256: verified.bundleSha256,
      manifestSha256: verified.manifestSha256,
      capabilities: verified.manifest.capabilities,
    },
    binding,
    operation,
  });
}

function lease(
  leaseId: string,
  pid: number,
): PortableProviderPluginInvocationLease {
  return {
    schemaVersion: 2,
    leaseId,
    runId: leaseId,
    identity: {
      pluginId: "portable-test",
      pluginVersion: "1.0.0",
      hostApiVersion: 1,
      bundleSha256: hashA,
      manifestSha256: hashB,
      adapterId: "portable-test",
      transport: "provider-api",
      surfaceId: "portable-test",
      operation: "records.read",
      contractVersion: 1,
      descriptorSha256: hashC,
    },
    owner: {
      pid,
      token: leaseId,
      bootId: hashA,
      processStartId: hashB,
    },
    acquiredAt: "2026-07-25T12:00:00.000Z",
    containment: {
      status: "parent-owned",
    },
  };
}

describe("portable provider plugin invocation lease admission", () => {
  test("fails closed on unsafe or unverifiable state without serializing healthy live invocations", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-portable-lease-admission-"));
    chmodSync(root, 0o700);
    const requestedEnvironment = {
      WRENCH_STATE_HOME: join(root, "wrench-home"),
      HOME: root,
    };
    const environment = {
      ...requestedEnvironment,
      WRENCH_STATE_HOME: wrenchStateHome(requestedEnvironment),
    };
    const directory = join(
      environment.WRENCH_STATE_HOME,
      "provider-plugin-state",
      ".invocations",
    );
    const malformedId = "11000000-0000-4000-8000-000000000011";
    const unknownId = "12000000-0000-4000-8000-000000000012";
    const legacyId = "12500000-0000-4000-8000-000000000125";
    const unrelatedId = "12800000-0000-4000-8000-000000000128";
    try {
      const identity = installPortableTestPackage(root, environment);
      ensurePrivateStateDirectory(directory, environment);

      writeFileSync(
        join(directory, `${malformedId}.json`),
        "{\"schemaVersion\":2}\n",
        { mode: 0o600 },
      );
      expect(() =>
        acquirePortableProviderPluginInvocationLease(
          identity,
          "13000000-0000-4000-8000-000000000013",
          environment,
        )).toThrow("blocked by malformed lease");
      rmSync(join(directory, `${malformedId}.json`));

      createPrivateJsonIfAbsent(
        join(directory, `${unknownId}.json`),
        {
          ...lease(unknownId, 987_654_321),
          identity,
        },
        { environment },
      );
      expect(() =>
        acquirePortableProviderPluginInvocationLease(
          identity,
          "14000000-0000-4000-8000-000000000014",
          environment,
      )).toThrow("blocked by unverifiable non-complete lease");
      rmSync(join(directory, `${unknownId}.json`));

      const legacySource = lease(legacyId, 987_654_321);
      createPrivateJsonIfAbsent(
        join(directory, `${legacyId}.json`),
        {
          schemaVersion: 1,
          leaseId: legacySource.leaseId,
          runId: legacySource.runId,
          identity,
          owner: legacySource.owner,
          acquiredAt: legacySource.acquiredAt,
        },
        { environment },
      );
      expect(() =>
        acquirePortableProviderPluginInvocationLease(
          identity,
          "14500000-0000-4000-8000-000000000145",
          environment,
        )).toThrow("blocked by unverifiable non-complete lease");
      rmSync(join(directory, `${legacyId}.json`));

      createPrivateJsonIfAbsent(
        join(directory, `${unrelatedId}.json`),
        {
          ...lease(unrelatedId, 987_654_321),
          identity: {
            ...identity,
            pluginId: "portable-unrelated",
          },
          containment: {
            status: "cleanup-unsafe",
            host: null,
          },
        },
        { environment },
      );
      const besideUnrelated = acquirePortableProviderPluginInvocationLease(
        identity,
        "14800000-0000-4000-8000-000000000148",
        environment,
      );
      const besideUnrelatedContainment =
        createPortableProviderPluginInvocationLeaseContainmentController(
          besideUnrelated,
          environment,
        );
      besideUnrelatedContainment.cleanupComplete();
      releasePortableProviderPluginInvocationLease(
        besideUnrelatedContainment.current,
        environment,
      );
      rmSync(join(directory, `${unrelatedId}.json`));

      const first = acquirePortableProviderPluginInvocationLease(
        identity,
        "15000000-0000-4000-8000-000000000015",
        environment,
      );
      const second = acquirePortableProviderPluginInvocationLease(
        identity,
        "16000000-0000-4000-8000-000000000016",
        environment,
      );
      expect(listPortableProviderPluginInvocationLeases(environment))
        .toHaveLength(2);
      for (const current of [first, second]) {
        const containment =
          createPortableProviderPluginInvocationLeaseContainmentController(
            current,
            environment,
          );
        containment.cleanupComplete();
        releasePortableProviderPluginInvocationLease(
          containment.current,
          environment,
        );
      }

      const priorBundle = acquirePortableProviderPluginInvocationLease(
        identity,
        "16500000-0000-4000-8000-000000000165",
        environment,
      );
      if (priorBundle.lease.schemaVersion !== 2) {
        throw new Error("portable admission fixture lease is not schema v2");
      }
      const priorBundlePath = join(
        directory,
        `${priorBundle.lease.leaseId}.json`,
      );
      rmSync(priorBundlePath);
      createPrivateJsonIfAbsent(
        priorBundlePath,
        {
          ...priorBundle.lease,
          identity: {
            ...priorBundle.lease.identity,
            bundleSha256: hashD,
          },
          containment: {
            status: "cleanup-unsafe",
            host: null,
          },
        },
        { environment },
      );
      expect(() =>
        acquirePortableProviderPluginInvocationLease(
          identity,
          "16800000-0000-4000-8000-000000000168",
          environment,
        )).toThrow("blocked by cleanup-unsafe lease");
      rmSync(priorBundlePath);

      const unsafe =
        createPortableProviderPluginInvocationLeaseContainmentController(
          acquirePortableProviderPluginInvocationLease(
            identity,
            "17000000-0000-4000-8000-000000000017",
            environment,
          ),
          environment,
        );
      unsafe.cleanupUnsafe();
      expect(() =>
        acquirePortableProviderPluginInvocationLease(
          identity,
          "18000000-0000-4000-8000-000000000018",
          environment,
        )).toThrow("blocked by cleanup-unsafe lease");
      expect(listPortableProviderPluginInvocationLeases(environment))
        .toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("portable provider plugin invocation lease repair", () => {
  test("removes only exact dead owners and retains unknown or live state", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-portable-lease-repair-"));
    chmodSync(root, 0o700);
    const requestedEnvironment = {
      WRENCH_STATE_HOME: join(root, "wrench-home"),
      HOME: root,
    };
    const environment = {
      ...requestedEnvironment,
      WRENCH_STATE_HOME: wrenchStateHome(requestedEnvironment),
    };
    const directory = join(
      environment.WRENCH_STATE_HOME,
      "provider-plugin-state",
      ".invocations",
    );
    const deadId = "10000000-0000-4000-8000-000000000001";
    const liveId = "20000000-0000-4000-8000-000000000002";
    const unknownId = "30000000-0000-4000-8000-000000000003";
    const invalidId = "40000000-0000-4000-8000-000000000004";
    const legacyId = "70000000-0000-4000-8000-000000000007";
    try {
      ensurePrivateStateDirectory(directory, environment);
      createPrivateJsonIfAbsent(
        join(directory, `${deadId}.json`),
        {
          ...lease(deadId, 101),
          containment: {
            status: "cleanup-complete",
            host: null,
          },
        },
        { environment },
      );
      createPrivateJsonIfAbsent(
        join(directory, `${liveId}.json`),
        lease(liveId, 102),
        { environment },
      );
      createPrivateJsonIfAbsent(
        join(directory, `${unknownId}.json`),
        lease(unknownId, 103),
        { environment },
      );
      const legacySource = lease(legacyId, 104);
      createPrivateJsonIfAbsent(
        join(directory, `${legacyId}.json`),
        {
          schemaVersion: 1,
          leaseId: legacySource.leaseId,
          runId: legacySource.runId,
          identity: legacySource.identity,
          owner: legacySource.owner,
          acquiredAt: legacySource.acquiredAt,
        },
        { environment },
      );
      writeFileSync(
        join(directory, `${invalidId}.json`),
        "{\"schemaVersion\":1}\n",
        { mode: 0o600 },
      );

      expect(repairPortableProviderPluginInvocationLeases(
        environment,
        new Date("2026-07-25T12:01:00.000Z"),
        (owner) =>
          owner.pid === 101
            ? "different-or-dead"
            : owner.pid === 102
              ? "exact-live-owner"
              : "unknown",
      )).toEqual({
        inspected: 5,
        removed: 1,
        active: 1,
        unknown: 2,
        invalid: 1,
      });
      expect(listPortableProviderPluginInvocationLeases(environment).map(
        (entry) => "invalid" in entry
          ? entry.leaseId
          : entry.lease.leaseId,
      ).sort()).toEqual([invalidId, legacyId, liveId, unknownId].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("durably completes cleanup before releasing an exact lease", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-portable-lease-complete-"));
    chmodSync(root, 0o700);
    const requestedEnvironment = {
      WRENCH_STATE_HOME: join(root, "wrench-home"),
      HOME: root,
    };
    const environment = {
      ...requestedEnvironment,
      WRENCH_STATE_HOME: wrenchStateHome(requestedEnvironment),
    };
    const directory = join(
      environment.WRENCH_STATE_HOME,
      "provider-plugin-state",
      ".invocations",
    );
    const directId = "90000000-0000-4000-8000-000000000009";
    const hostedId = "a0000000-0000-4000-8000-00000000000a";
    const unsafeId = "b0000000-0000-4000-8000-00000000000b";
    const host = {
      pid: 202,
      bootId: hashB,
      processStartId: hashC,
    };
    try {
      ensurePrivateStateDirectory(directory, environment);
      for (const leaseId of [directId, hostedId, unsafeId]) {
        createPrivateJsonIfAbsent(
          join(directory, `${leaseId}.json`),
          lease(leaseId, 101),
          { environment },
        );
      }
      const snapshots = new Map(
        listPortableProviderPluginInvocationLeases(environment).flatMap(
          (entry) => "invalid" in entry
            ? []
            : [[entry.lease.leaseId, entry] as const],
        ),
      );
      const direct = snapshots.get(directId);
      const hosted = snapshots.get(hostedId);
      const unsafe = snapshots.get(unsafeId);
      if (direct === undefined || hosted === undefined || unsafe === undefined) {
        throw new Error("portable lease transition fixture is unavailable");
      }

      const directController =
        createPortableProviderPluginInvocationLeaseContainmentController(
          direct,
          environment,
        );
      expect(() =>
        releasePortableProviderPluginInvocationLease(
          directController.current,
          environment,
        )).toThrow("before durable cleanup completion");
      directController.cleanupComplete();
      expect(directController.current.lease).toMatchObject({
        containment: {
          status: "cleanup-complete",
          host: null,
        },
      });
      releasePortableProviderPluginInvocationLease(
        directController.current,
        environment,
      );

      const hostedController =
        createPortableProviderPluginInvocationLeaseContainmentController(
          hosted,
          environment,
        );
      hostedController.hostStarting(host);
      hostedController.hostStarted(host);
      hostedController.cleanupComplete();
      expect(hostedController.current.lease).toMatchObject({
        containment: {
          status: "cleanup-complete",
          host,
        },
      });
      releasePortableProviderPluginInvocationLease(
        hostedController.current,
        environment,
      );

      const unsafeController =
        createPortableProviderPluginInvocationLeaseContainmentController(
          unsafe,
          environment,
        );
      unsafeController.hostStarting(host);
      unsafeController.hostStarted(host);
      unsafeController.cleanupUnsafe();
      expect(() => unsafeController.cleanupComplete()).toThrow(
        "cannot complete after becoming unsafe",
      );
      expect(() =>
        releasePortableProviderPluginInvocationLease(
          unsafeController.current,
          environment,
        )).toThrow("before durable cleanup completion");
      expect(listPortableProviderPluginInvocationLeases(environment))
        .toMatchObject([{
          lease: {
            leaseId: unsafeId,
            containment: {
              status: "cleanup-unsafe",
            },
          },
        }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers pre-admission death but retains active or unsafe containment until reboot", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-portable-lease-containment-"));
    chmodSync(root, 0o700);
    const requestedEnvironment = {
      WRENCH_STATE_HOME: join(root, "wrench-home"),
      HOME: root,
    };
    const environment = {
      ...requestedEnvironment,
      WRENCH_STATE_HOME: wrenchStateHome(requestedEnvironment),
    };
    const directory = join(
      environment.WRENCH_STATE_HOME,
      "provider-plugin-state",
      ".invocations",
    );
    const startingId = "50000000-0000-4000-8000-000000000005";
    const activeId = "55000000-0000-4000-8000-000000000055";
    const unsafeId = "60000000-0000-4000-8000-000000000006";
    const rebootActiveId = "75000000-0000-4000-8000-000000000075";
    const rebootUnsafeId = "80000000-0000-4000-8000-000000000008";
    const parent = Bun.spawn(["/bin/sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const host = Bun.spawn(["/bin/sleep", "30"], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const parentIdentity = captureProcessOwnerIdentity(parent.pid);
      const hostIdentity = captureProcessOwnerIdentity(host.pid);
      ensurePrivateStateDirectory(directory, environment);
      const containedLease = (
        leaseId: string,
        containment: Extract<
          PortableProviderPluginInvocationLease,
          { readonly schemaVersion: 2 }
        >["containment"],
      ): Extract<
        PortableProviderPluginInvocationLease,
        { readonly schemaVersion: 2 }
      > => ({
        ...lease(leaseId, parent.pid),
        schemaVersion: 2,
        owner: {
          ...parentIdentity,
          token: leaseId,
        },
        containment,
      });
      createPrivateJsonIfAbsent(
        join(directory, `${startingId}.json`),
        containedLease(startingId, {
          status: "host-starting",
          host: hostIdentity,
        }),
        { environment },
      );
      createPrivateJsonIfAbsent(
        join(directory, `${activeId}.json`),
        containedLease(activeId, {
          status: "host-active",
          host: hostIdentity,
        }),
        { environment },
      );
      createPrivateJsonIfAbsent(
        join(directory, `${unsafeId}.json`),
        containedLease(unsafeId, {
          status: "cleanup-unsafe",
          host: hostIdentity,
        }),
        { environment },
      );

      parent.kill("SIGKILL");
      await parent.exited;
      expect(recoverPortableProviderPluginInvocationLeaseTombstones(
        environment,
      )).toMatchObject({
        inspected: 3,
        removed: 0,
        active: 1,
        unknown: 2,
      });

      host.kill("SIGKILL");
      await host.exited;
      expect(repairPortableProviderPluginInvocationLeases(
        environment,
      )).toMatchObject({
        inspected: 3,
        removed: 0,
        unknown: 3,
      });
      const retained = listPortableProviderPluginInvocationLeases(environment);
      expect(retained).toHaveLength(3);
      for (const entry of retained) {
        if ("invalid" in entry) {
          throw new Error("contained lease became invalid");
        }
        expect(portableProviderPluginInvocationLeaseOwnerStatus(entry))
          .toBe("unknown");
      }
      const oldBootId = parentIdentity.bootId === hashA ? hashB : hashA;
      const rebootActiveLease = containedLease(rebootActiveId, {
        status: "host-active",
        host: {
          ...hostIdentity,
          bootId: oldBootId,
        },
      });
      createPrivateJsonIfAbsent(
        join(directory, `${rebootActiveId}.json`),
        {
          ...rebootActiveLease,
          owner: {
            ...rebootActiveLease.owner,
            bootId: oldBootId,
          },
        },
        { environment },
      );
      const rebootUnsafeLease = containedLease(rebootUnsafeId, {
        status: "cleanup-unsafe",
        host: {
          ...hostIdentity,
          bootId: oldBootId,
        },
      });
      createPrivateJsonIfAbsent(
        join(directory, `${rebootUnsafeId}.json`),
        {
          ...rebootUnsafeLease,
          owner: {
            ...rebootUnsafeLease.owner,
            bootId: oldBootId,
          },
        },
        { environment },
      );
      expect(recoverPortableProviderPluginInvocationLeaseTombstones(
        environment,
      )).toMatchObject({
        inspected: 5,
        removed: 3,
        unknown: 2,
      });
      const afterRecovery =
        listPortableProviderPluginInvocationLeases(environment);
      expect(afterRecovery).toHaveLength(2);
      expect(afterRecovery.map((entry) =>
        "invalid" in entry
          ? entry.leaseId
          : entry.lease.leaseId,
      ).sort()).toEqual([activeId, unsafeId]);
    } finally {
      parent.kill("SIGKILL");
      host.kill("SIGKILL");
      await Promise.all([parent.exited, host.exited]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
