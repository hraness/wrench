import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  PreservedBrowserArtifactsError,
  browserRecoveryHandle,
  type BrowserCleanupResourceIdentity,
} from "./browser";
import {
  WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
  WebSessionCleanupAdmissionBlockedError,
  acquireWebSessionCleanupAdmission,
  listWebSessionCleanupAdmissions,
  parseWebSessionCleanupAdmissionClaim,
  recoverWebSessionCleanupAdmissions,
  webSessionCleanupRealmKey,
  withWebSessionCleanupAdmission,
  type WebSessionCleanupAdmissionContainment,
  type WebSessionCleanupAdmissionIdentity,
  type WebSessionCleanupAdmissionResource,
} from "./web-session-cleanup-admission";
import {
  currentProcessStartIdentity,
} from "./process-identity";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  wrenchStateHome,
} from "./storage";
import {
  startProviderPluginCleanupTrackedOperation,
} from "./provider-plugin-cleanup-execution";
import {
  captureLocalCliCleanupResource,
  inspectLocalCliCleanupFilesystemReadiness,
  localCliCleanupResourceExtends,
  parseLocalCliCleanupResourceIdentityV1,
} from "./provider-plugin-cleanup-resource";

type Environment = Readonly<Record<string, string | undefined>>;

async function withState(
  callback: (
    environment: Environment,
  ) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(
    join(tmpdir(), "wrench-web-session-cleanup-admission-"),
  );
  chmodSync(root, 0o700);
  const environment = {
    WRENCH_STATE_HOME: join(root, "wrench-home"),
    HOME: root,
  };
  try {
    await callback(environment);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function identity(
  overrides: Partial<WebSessionCleanupAdmissionIdentity> = {},
): WebSessionCleanupAdmissionIdentity {
  return Object.freeze({
    runId: randomUUID(),
    pluginId: "source-web",
    pluginVersion: "1.0.0",
    pluginImplementationHash: "1".repeat(64),
    adapterId: "source-web",
    adapterHash: "2".repeat(64),
    surfaceId: "source-web",
    authId: "main-account",
    authHash: "3".repeat(64),
    ...overrides,
  });
}

function differentDigest(value: string): string {
  return value === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
}

function writeAdmissionFixture(
  environment: Environment,
  containment: WebSessionCleanupAdmissionContainment,
  ownerOverrides: {
    readonly pid?: number;
    readonly bootId?: string;
    readonly processStartId?: string;
  } = {},
  resources?: readonly WebSessionCleanupAdmissionResource[],
  identityOverrides: Partial<WebSessionCleanupAdmissionIdentity> = {},
): void {
  const selectedIdentity = identity(identityOverrides);
  const processIdentity = currentProcessStartIdentity();
  const realmKey = webSessionCleanupRealmKey(
    selectedIdentity.surfaceId,
    selectedIdentity.authId,
  );
  const claim = parseWebSessionCleanupAdmissionClaim({
    schemaVersion: 1,
    realmKey,
    ...selectedIdentity,
    owner: {
      pid: ownerOverrides.pid ?? process.pid,
      token: randomUUID(),
      bootId: ownerOverrides.bootId ?? processIdentity.bootId,
      processStartId:
        ownerOverrides.processStartId ?? processIdentity.processStartId,
    },
    acquiredAt: "2026-07-26T12:00:00.000Z",
    containment,
    resources: resources ?? (
      containment.status === "resource-active"
        || containment.status === "cleanup-unsafe"
        ? [{
            resourceId: randomUUID(),
            status: "unpublished",
          }]
        : []
    ),
  });
  const admissionDirectory = join(
    wrenchStateHome(environment),
    WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
  );
  ensurePrivateStateDirectory(admissionDirectory, environment);
  if (!createPrivateJsonIfAbsent(
    join(admissionDirectory, `${realmKey}.json`),
    claim,
    { environment },
  ).created) {
    throw new Error("cleanup admission fixture already exists");
  }
}

function privateDirectoryIdentity(path: string): {
  readonly device: string;
  readonly inode: string;
} {
  const stats = lstatSync(path, { bigint: true });
  return Object.freeze({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
  });
}

function browserCleanupResourceFixture(): {
  readonly resource: BrowserCleanupResourceIdentity;
  readonly socketDirectory: string;
  readonly artifactsDirectory: string;
} {
  const socketDirectory = mkdtempSync("/tmp/io-ab-");
  const artifactsDirectory = mkdtempSync(
    join(tmpdir(), "io-browser-"),
  );
  chmodSync(socketDirectory, 0o700);
  chmodSync(artifactsDirectory, 0o700);
  const session = `io-${process.pid}-abcdef12-abc`;
  const recoveryHandle = browserRecoveryHandle({
    session,
    configPath: join(artifactsDirectory, "agent-browser.json"),
    socketDirectory,
    artifactsDirectory,
  });
  return Object.freeze({
    socketDirectory,
    artifactsDirectory,
    resource: Object.freeze({
      kind: "agent-browser-session-v1",
      recoveryHandle,
      session,
      socketDirectory,
      socketDirectoryIdentity:
        privateDirectoryIdentity(socketDirectory),
      artifactsDirectory,
      artifactsDirectoryIdentity:
        privateDirectoryIdentity(artifactsDirectory),
    }),
  });
}

describe("web-session cleanup admission", () => {
  test("persists resource ownership before registration returns", async () => {
    await withState((environment) => {
      const admission = acquireWebSessionCleanupAdmission(
        identity(),
        environment,
      );
      let resolveCleanup: (() => void) | undefined;
      const cleanup = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });

      admission.registerCleanupBarrier(cleanup);

      expect(listWebSessionCleanupAdmissions(environment)).toMatchObject([{
        claim: {
          containment: { status: "resource-active" },
          surfaceId: "source-web",
          authId: "main-account",
        },
      }]);
      resolveCleanup?.();
    });
  });

  test("releases only after every registered cleanup barrier fulfills", async () => {
    await withState(async (environment) => {
      let firstResolve: (() => void) | undefined;
      let secondResolve: (() => void) | undefined;
      const first = new Promise<void>((resolve) => {
        firstResolve = resolve;
      });
      const second = new Promise<void>((resolve) => {
        secondResolve = resolve;
      });
      let operationSettled = false;
      const execution = withWebSessionCleanupAdmission(
        identity(),
        environment,
        (register) => {
          register(first);
          register(second);
          return Promise.resolve("bounded-result");
        },
      );
      void execution.finally(() => {
        operationSettled = true;
      });
      await Promise.resolve();
      firstResolve?.();
      await Promise.resolve();
      expect(operationSettled).toBeFalse();
      expect(listWebSessionCleanupAdmissions(environment)).toHaveLength(1);

      secondResolve?.();
      expect(await execution).toBe("bounded-result");
      expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
    });
  });

  test("keeps cleanup completion ordered after immutable barrier observation", async () => {
    await withState(async (environment) => {
      const admission = acquireWebSessionCleanupAdmission(
        identity(),
        environment,
      );
      let resolveCleanup: (() => void) | undefined;
      const cleanup = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });
      admission.registerCleanupBarrier(cleanup);

      const observedBarriers = admission.barriers;
      expect(Object.isFrozen(observedBarriers)).toBeTrue();
      expect(() => {
        (observedBarriers as Promise<void>[]).push(Promise.resolve());
      }).toThrow();
      expect(admission.barriers).toHaveLength(1);
      expect(() => admission.cleanupComplete()).toThrow(
        "registration must close",
      );
      expect(() => admission.release()).toThrow(
        "before cleanup completion",
      );

      admission.closeRegistration();
      expect(() => admission.cleanupComplete()).toThrow(
        "barriers have not all settled",
      );
      resolveCleanup?.();
      await Promise.allSettled(admission.barriers);
      admission.cleanupComplete();
      admission.release();
      expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
    });
  });

  test("does not fail a completed owner when a safe reclaimer publishes its successor", async () => {
    await withState((environment) => {
      const originalIdentity = identity();
      const original = acquireWebSessionCleanupAdmission(
        originalIdentity,
        environment,
      );
      original.closeRegistration();
      original.cleanupComplete();
      expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 1,
        issues: [],
      });
      const successorIdentity = identity({ runId: randomUUID() });
      const successor = acquireWebSessionCleanupAdmission(
        successorIdentity,
        environment,
      );

      expect(() => original.release()).not.toThrow();
      expect(listWebSessionCleanupAdmissions(environment)).toMatchObject([{
        claim: {
          runId: successorIdentity.runId,
          containment: { status: "parent-owned" },
        },
      }]);
      successor.closeRegistration();
      successor.cleanupComplete();
      successor.release();
    });
  });

  test("retains cleanup-unsafe separately from a fulfilled operation result", async () => {
    await withState(async (environment) => {
      const result = await withWebSessionCleanupAdmission(
        identity(),
        environment,
        (register) => {
          register(Promise.reject(new Error("cleanup did not settle")));
          return Promise.resolve("truthful-provider-result");
        },
      );

      expect(result).toBe("truthful-provider-result");
      expect(listWebSessionCleanupAdmissions(environment)).toMatchObject([{
        claim: {
          containment: { status: "cleanup-unsafe" },
        },
      }]);
      expect(() =>
        acquireWebSessionCleanupAdmission(
          identity({ runId: randomUUID() }),
          environment,
        )).toThrow("active or cleanup-unsafe state");

      let operationCalls = 0;
      let blockedCalls = 0;
      const blocked = await withWebSessionCleanupAdmission(
        identity({ runId: randomUUID() }),
        environment,
        () => {
          operationCalls += 1;
          return Promise.resolve("must-not-run");
        },
        new Date(),
        (error) => {
          blockedCalls += 1;
          expect(error).toBeInstanceOf(
            WebSessionCleanupAdmissionBlockedError,
          );
          expect(error.message).toContain("active or cleanup-unsafe state");
          return Promise.resolve("cleanup-required");
        },
      );
      expect(blocked).toBe("cleanup-required");
      expect(operationCalls).toBe(0);
      expect(blockedCalls).toBe(1);

      const unrelated = acquireWebSessionCleanupAdmission(
        identity({
          runId: randomUUID(),
          authId: "other-account",
          authHash: "4".repeat(64),
        }),
        environment,
      );
      expect(unrelated.current.claim.authId).toBe("other-account");
    });
  });

  test("separates ordinary work failure from verified cleanup proof", async () => {
    await withState(async (environment) => {
      const execution = withWebSessionCleanupAdmission(
        identity(),
        environment,
        (register) => startProviderPluginCleanupTrackedOperation(
          register,
          async (_publish, cleanup) => {
            cleanup.verified();
            throw new Error("ordinary provider work failure");
          },
        ),
      );

      await expect(execution).rejects.toThrow("ordinary provider work failure");
      expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
    });
  });

  test("preserves durable admission when the cleanup controller reports unsafe", async () => {
    await withState(async (environment) => {
      const result = await withWebSessionCleanupAdmission(
        identity(),
        environment,
        (register) => startProviderPluginCleanupTrackedOperation(
          register,
          async (_publish, cleanup) => {
            cleanup.unsafe(new Error("private root could not be verified"));
            return "provider-result";
          },
        ),
      );

      expect(result).toBe("provider-result");
      expect(listWebSessionCleanupAdmissions(environment)).toMatchObject([{
        claim: { containment: { status: "cleanup-unsafe" } },
      }]);
      expect(() => acquireWebSessionCleanupAdmission(
        identity({ runId: randomUUID() }),
        environment,
      )).toThrow("active or cleanup-unsafe state");
    });
  });

  test("accepts only monotonic multi-process-group local cleanup histories", () => {
    const root = join(
      realpathSync(tmpdir()),
      `wrench-local-groups-${randomUUID()}`,
    );
    mkdirSync(root, { mode: 0o700 });
    try {
      const captured = captureLocalCliCleanupResource(root);
      const group = (pid: number, fill: string) => ({
        kind: "posix-process-group-v1" as const,
        platform: process.platform === "linux" ? "linux" as const : "darwin" as const,
        processGroupId: pid,
        leader: {
          pid,
          bootId: fill.repeat(64),
          processStartId: (fill === "a" ? "b" : "c").repeat(64),
        },
      });
      const first = parseLocalCliCleanupResourceIdentityV1({
        ...captured,
        processGroups: [group(101, "a")],
      });
      const second = parseLocalCliCleanupResourceIdentityV1({
        ...captured,
        processGroups: [group(101, "a"), group(202, "d")],
      });
      const replaced = parseLocalCliCleanupResourceIdentityV1({
        ...captured,
        processGroups: [group(303, "e"), group(202, "d")],
      });

      expect(second.processGroups).toHaveLength(2);
      expect(localCliCleanupResourceExtends(captured, first)).toBeTrue();
      expect(localCliCleanupResourceExtends(first, second)).toBeTrue();
      expect(localCliCleanupResourceExtends(second, first)).toBeFalse();
      expect(localCliCleanupResourceExtends(first, replaced)).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires an immutable private-root generation before local CLI readiness", () => {
    const readiness = inspectLocalCliCleanupFilesystemReadiness();
    expect(readiness).toEqual({ ready: true, reason: null });

    const root = join(
      realpathSync(tmpdir()),
      `wrench-local-generation-${randomUUID()}`,
    );
    mkdirSync(root, { mode: 0o700 });
    try {
      const captured = captureLocalCliCleanupResource(root);
      expect(() => parseLocalCliCleanupResourceIdentityV1({
        ...captured,
        root: { ...captured.root, birthtimeNs: "0" },
      })).toThrow("birth time is malformed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains a same-boot local private root with no published process group", async () => {
    await withState((environment) => {
      const root = join(
        realpathSync(tmpdir()),
        `wrench-local-recovery-${randomUUID()}`,
      );
      mkdirSync(root, { mode: 0o700 });
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "resource-active" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "active",
            identity: captureLocalCliCleanupResource(root),
          }],
          {
            transport: "local-cli",
            executionIdentityHash: "4".repeat(64),
          },
        );

        expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
          scanned: 1,
          repaired: 0,
          retained: 1,
          issues: [{ kind: "cleanup-unsafe" }],
        });
        expect(existsSync(root)).toBeTrue();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("binds browser-closed cleanup evidence to the exact published private roots", async () => {
    await withState(async (environment) => {
      const fixture = browserCleanupResourceFixture();
      try {
        const admission = acquireWebSessionCleanupAdmission(
          identity(),
          environment,
        );
        let rejectCleanup: ((reason: unknown) => void) | undefined;
        const cleanup = new Promise<void>((_resolve, reject) => {
          rejectCleanup = reject;
        });
        const publish = admission.registerCleanupBarrier(cleanup);
        if (typeof publish !== "function") {
          throw new Error("cleanup admission omitted its resource publisher");
        }
        publish(fixture.resource);
        expect(listWebSessionCleanupAdmissions(environment)).toMatchObject([{
          claim: {
            containment: { status: "resource-active" },
            resources: [{
              status: "active",
              identity: {
                recoveryHandle: fixture.resource.recoveryHandle,
                socketDirectoryIdentity:
                  fixture.resource.socketDirectoryIdentity,
                artifactsDirectoryIdentity:
                  fixture.resource.artifactsDirectoryIdentity,
              },
            }],
          },
        }]);

        admission.closeRegistration();
        rejectCleanup?.(new PreservedBrowserArtifactsError(
          "browser close was verified but private roots remain",
          fixture.resource.recoveryHandle,
          new Error("synthetic artifact cleanup failure"),
          {
            kind: "agent-browser-closed-artifacts-v1",
            resource: fixture.resource,
          },
        ));
        await Promise.allSettled(admission.barriers);
        admission.cleanupUnsafe();

        expect(listWebSessionCleanupAdmissions(environment)).toMatchObject([{
          claim: {
            containment: { status: "cleanup-unsafe" },
            resources: [{
              status: "browser-closed-artifacts",
              identity: {
                recoveryHandle: fixture.resource.recoveryHandle,
              },
            }],
          },
        }]);
      } finally {
        rmSync(fixture.socketDirectory, {
          recursive: true,
          force: true,
        });
        rmSync(fixture.artifactsDirectory, {
          recursive: true,
          force: true,
        });
      }
    });
  });

  test("repairs same-boot cleanup-unsafe state only from browser-closed inode-bound evidence", async () => {
    await withState((environment) => {
      const fixture = browserCleanupResourceFixture();
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "browser-closed-artifacts",
            identity: fixture.resource,
          }],
        );

        expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
          scanned: 1,
          repaired: 1,
          retained: 0,
          invalid: 0,
          issues: [],
        });
        expect(existsSync(fixture.socketDirectory)).toBeFalse();
        expect(existsSync(fixture.artifactsDirectory)).toBeFalse();
        expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
      } finally {
        rmSync(fixture.socketDirectory, {
          recursive: true,
          force: true,
        });
        rmSync(fixture.artifactsDirectory, {
          recursive: true,
          force: true,
        });
      }
    });
    await withState((environment) => {
      const fixture = browserCleanupResourceFixture();
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "browser-closed-artifacts",
            identity: fixture.resource,
          }],
        );

        const successorIdentity = identity({ runId: randomUUID() });
        const successor = acquireWebSessionCleanupAdmission(
          successorIdentity,
          environment,
        );

        expect(successor.current.claim.runId).toBe(
          successorIdentity.runId,
        );
        expect(existsSync(fixture.socketDirectory)).toBeFalse();
        expect(existsSync(fixture.artifactsDirectory)).toBeFalse();
        successor.closeRegistration();
        successor.cleanupComplete();
        successor.release();
      } finally {
        rmSync(fixture.socketDirectory, {
          recursive: true,
          force: true,
        });
        rmSync(fixture.artifactsDirectory, {
          recursive: true,
          force: true,
        });
      }
    });
  });

  test("retains same-boot cleanup uncertainty when browser-closed proof is absent or identity-changed", async () => {
    await withState((environment) => {
      const current = currentProcessStartIdentity();
      writeAdmissionFixture(
        environment,
        { status: "cleanup-unsafe" },
        { processStartId: differentDigest(current.processStartId) },
      );
      expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 0,
        retained: 1,
        issues: [{ kind: "cleanup-unsafe" }],
      });
    });
    await withState((environment) => {
      const fixture = browserCleanupResourceFixture();
      const displacedArtifactsDirectory =
        `${fixture.artifactsDirectory}.displaced`;
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "browser-closed-artifacts",
            identity: fixture.resource,
          }],
        );
        // Keep the original inode alive so filesystems that eagerly recycle
        // directory inodes cannot accidentally make this replacement look
        // identity-equal to the resource recorded in the admission claim.
        renameSync(
          fixture.artifactsDirectory,
          displacedArtifactsDirectory,
        );
        mkdirSync(fixture.artifactsDirectory, { mode: 0o700 });

        expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
          scanned: 1,
          repaired: 0,
          retained: 1,
          issues: [{ kind: "recovery-conflict" }],
        });
        expect(listWebSessionCleanupAdmissions(environment)).toHaveLength(1);
      } finally {
        rmSync(fixture.socketDirectory, {
          recursive: true,
          force: true,
        });
        rmSync(fixture.artifactsDirectory, {
          recursive: true,
          force: true,
        });
        rmSync(displacedArtifactsDirectory, {
          recursive: true,
          force: true,
        });
      }
    });
  });

  test("repairs pre-resource owner death but requires a reboot after resource admission", async () => {
    await withState((environment) => {
      const current = currentProcessStartIdentity();
      writeAdmissionFixture(
        environment,
        { status: "parent-owned" },
        { processStartId: differentDigest(current.processStartId) },
      );
      expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 1,
        retained: 0,
        invalid: 0,
      });
    });
    await withState((environment) => {
      writeAdmissionFixture(
        environment,
        { status: "resource-active" },
      );
      expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 0,
        retained: 1,
        issues: [{
          kind: "resource-active",
        }],
      });
    });
    await withState((environment) => {
      const current = currentProcessStartIdentity();
      writeAdmissionFixture(
        environment,
        { status: "resource-active" },
        { bootId: differentDigest(current.bootId) },
      );
      expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 1,
        retained: 0,
        issues: [],
      });
    });
  });

  test("production recovery ignores caller-forged liveness and boot evidence", async () => {
    await withState((environment) => {
      const unsafe = acquireWebSessionCleanupAdmission(
        identity(),
        environment,
      );
      unsafe.registerCleanupBarrier(
        new Promise<void>(() => undefined),
      );
      unsafe.closeRegistration();
      unsafe.cleanupUnsafe();
      const [snapshot] = listWebSessionCleanupAdmissions(environment);
      if (snapshot === undefined || "invalid" in snapshot) {
        throw new Error("cleanup-unsafe admission fixture is unavailable");
      }
      const differentBootId =
        snapshot.claim.owner.bootId === "f".repeat(64)
          ? "e".repeat(64)
          : "f".repeat(64);
      const attemptForgedRecovery =
        recoverWebSessionCleanupAdmissions as unknown as (
          selectedEnvironment: Environment,
          forgedEvidence: {
            readonly inspectOwner: () => "different-or-dead";
            readonly currentBootId: string;
          },
        ) => ReturnType<typeof recoverWebSessionCleanupAdmissions>;

      expect(attemptForgedRecovery(environment, {
        inspectOwner: () => "different-or-dead",
        currentBootId: differentBootId,
      })).toMatchObject({
        scanned: 1,
        repaired: 0,
        retained: 1,
        // The public entry point ignores the forged second argument and uses
        // the real process probe, which correctly observes this test owner as
        // live even though the retained claim is cleanup-unsafe.
        issues: [{ kind: "resource-active" }],
      });
    });
  });

  test("ignores exact storage-helper artifacts but reports near-matches", async () => {
    await withState((environment) => {
      const directory = join(
        wrenchStateHome(environment),
        WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
      );
      ensurePrivateStateDirectory(directory, environment);
      const claimId = randomUUID();
      const artifactNames = [
        `.io-write-${process.pid}-${randomUUID()}.tmp`,
        `.io-mutation-${"f".repeat(64)}-held-${claimId}.lock`,
        `.io-mutation-stage-${randomUUID()}-${process.pid}.tmp`,
        `.io-remove-file-${randomUUID()}.quarantine`,
      ];
      for (const name of artifactNames) {
        writeFileSync(join(directory, name), "private helper artifact\n", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }

      expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
      const admission = acquireWebSessionCleanupAdmission(
        identity(),
        environment,
      );
      expect(admission.current.claim.containment.status).toBe("parent-owned");
      writeFileSync(
        join(directory, `.io-write-not-a-real-helper-${randomUUID()}.tmp`),
        "private malformed value\n",
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      const invalidCount = (): number =>
        listWebSessionCleanupAdmissions(environment).filter((entry) =>
          "invalid" in entry
        ).length;
      expect(invalidCount()).toBe(1);
      mkdirSync(
        join(directory, `.io-remove-file-${randomUUID()}.quarantine`),
        { mode: 0o700 },
      );
      expect(invalidCount()).toBe(2);
    });
  });

  test("acquires one realm without parsing one thousand unrelated entries", async () => {
    await withState((environment) => {
      const directory = join(
        wrenchStateHome(environment),
        WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
      );
      ensurePrivateStateDirectory(directory, environment);
      for (let index = 0; index < 1_000; index += 1) {
        writeFileSync(
          join(directory, `${index.toString(16).padStart(64, "0")}.json`),
          "{}\n",
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      }

      const admission = acquireWebSessionCleanupAdmission(
        identity(),
        environment,
      );

      expect(admission.current.claim.containment.status).toBe("parent-owned");
    });
  });

  test("fails closed on malformed requested state and diagnoses unexpected state", async () => {
    await withState((environment) => {
      const directory = join(
        wrenchStateHome(environment),
        WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
      );
      ensurePrivateStateDirectory(directory, environment);
      expect(createPrivateJsonIfAbsent(
        join(directory, "unexpected.json"),
        { schemaVersion: 1 },
        { environment },
      ).created).toBeTrue();

      const [invalidAdmission] =
        listWebSessionCleanupAdmissions(environment);
      if (
        invalidAdmission === undefined
        || !("invalid" in invalidAdmission)
      ) {
        throw new Error("invalid cleanup admission fixture is unavailable");
      }
      expect(typeof invalidAdmission.coordinate).toBe("string");
      expect(invalidAdmission.invalid).toBeTrue();
      expect(recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 0,
        invalid: 1,
        issues: [{ kind: "invalid-admission" }],
      });
      const unrelated = acquireWebSessionCleanupAdmission(
        identity(),
        environment,
      );
      expect(unrelated.current.claim.containment.status).toBe("parent-owned");
    });
    await withState((environment) => {
      const selectedIdentity = identity();
      const directory = join(
        wrenchStateHome(environment),
        WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
      );
      ensurePrivateStateDirectory(directory, environment);
      writeFileSync(
        join(
          directory,
          `${webSessionCleanupRealmKey(
            selectedIdentity.surfaceId,
            selectedIdentity.authId,
          )}.json`,
        ),
        "{}\n",
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      let blocked: unknown;
      try {
        acquireWebSessionCleanupAdmission(
          selectedIdentity,
          environment,
        );
      } catch (error) {
        blocked = error;
      }
      expect(blocked).toBeInstanceOf(
        WebSessionCleanupAdmissionBlockedError,
      );
      expect(blocked).toBeInstanceOf(Error);
      if (!(blocked instanceof Error)) {
        throw new Error("invalid admission did not return a typed error");
      }
      expect(blocked.message).toContain(
        "requested web-session cleanup admission is invalid",
      );
      expect(blocked.cause).toBeInstanceOf(Error);
    });
  });
});
