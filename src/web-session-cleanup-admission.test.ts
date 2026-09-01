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
  parseBrowserCleanupResourceIdentity,
  type BrowserCleanupResourceIdentity,
  type BrowserCleanupResourceIdentityV2,
} from "./browser";
import {
  WEB_SESSION_CLEANUP_ADMISSION_STATE_DIRECTORY,
  WebSessionCleanupAdmissionBlockedError,
  acquireWebSessionCleanupAdmission,
  listWebSessionCleanupAdmissions,
  parseWebSessionCleanupAdmissionClaim,
  recoverWebSessionCleanupAdmissions,
  recoverWebSessionCleanupAdmissionsCore,
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
  claimVersion: 1 | 2 = 1,
  recovery?: {
    readonly status: "active";
    readonly owner: {
      readonly pid: number;
      readonly token: string;
      readonly bootId: string;
      readonly processStartId: string;
    };
    readonly acquiredAt: string;
  },
): void {
  const selectedIdentity = identity(identityOverrides);
  const processIdentity = currentProcessStartIdentity();
  const realmKey = webSessionCleanupRealmKey(
    selectedIdentity.surfaceId,
    selectedIdentity.authId,
  );
  const claim = parseWebSessionCleanupAdmissionClaim({
    schemaVersion: claimVersion,
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
    ...(claimVersion === 2
      ? { recovery: recovery ?? { status: "idle" } }
      : {}),
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

function privateDirectoryIdentityV2(path: string): {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
  readonly mode: "448";
  readonly uid: string;
} {
  const stats = lstatSync(path, { bigint: true });
  return Object.freeze({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
    mode: "448",
    uid: stats.uid.toString(),
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
  writeFileSync(
    join(artifactsDirectory, "agent-browser.json"),
    "{}\n",
    { mode: 0o600, flag: "wx" },
  );
  writeFileSync(
    join(artifactsDirectory, "action-policy.json"),
    "{}\n",
    { mode: 0o600, flag: "wx" },
  );
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

function pinnedBrowserCleanupResourceFixture(): {
  readonly resource: BrowserCleanupResourceIdentityV2;
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
  return Object.freeze({
    socketDirectory,
    artifactsDirectory,
    resource: Object.freeze({
      kind: "agent-browser-session-v2",
      recoveryHandle: browserRecoveryHandle({
        session,
        configPath: join(artifactsDirectory, "agent-browser.json"),
        socketDirectory,
        artifactsDirectory,
      }),
      session,
      socketDirectory,
      socketDirectoryIdentity:
        privateDirectoryIdentityV2(socketDirectory),
      artifactsDirectory,
      artifactsDirectoryIdentity:
        privateDirectoryIdentityV2(artifactsDirectory),
      phase: "controlled",
      control: Object.freeze({
        kind: "agent-browser-control-v1",
        version: "0.32.3",
        session,
        socketDirectory,
        daemonOwner: Object.freeze({
          pid: 424_242,
          bootId: "a".repeat(64),
          processStartId: "b".repeat(64),
        }),
        engine: "chrome",
        launchHash: "42",
        cdpUrl: "ws://127.0.0.1:43125/devtools/browser/exact-test",
      }),
    }),
  });
}

function inactiveAgentBrowserSessionResult(
  resource: BrowserCleanupResourceIdentity,
): {
  readonly stdout: string;
  readonly stderr: "";
  readonly exitCode: 0;
} {
  return Object.freeze({
    stdout: `${JSON.stringify({
      success: true,
      data: {
        active: false,
        namespace: null,
        pid: null,
        runtime: null,
        runtimeError: null,
        session: resource.session,
        socketDir: resource.socketDirectory,
        version: null,
      },
    })}\n`,
    stderr: "",
    exitCode: 0,
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
    await withState(async (environment) => {
      const originalIdentity = identity();
      const original = acquireWebSessionCleanupAdmission(
        originalIdentity,
        environment,
      );
      original.closeRegistration();
      original.cleanupComplete();
      expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
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
    await withState(async (environment) => {
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

        expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
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

  test("binds preserved prepared roots when initial publication cannot be reconciled", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      const prepared: BrowserCleanupResourceIdentityV2 = Object.freeze({
        ...fixture.resource,
        phase: "prepared",
        control: null,
      });
      try {
        const admission = acquireWebSessionCleanupAdmission(
          identity(),
          environment,
        );
        let rejectCleanup: ((reason: unknown) => void) | undefined;
        const cleanup = new Promise<void>((_resolve, reject) => {
          rejectCleanup = reject;
        });
        admission.registerCleanupBarrier(cleanup);
        admission.closeRegistration();
        rejectCleanup?.(new PreservedBrowserArtifactsError(
          "initial publication was ambiguous",
          prepared.recoveryHandle,
          new Error("synthetic pre-commit publication failure"),
          {
            kind: "agent-browser-closed-artifacts-v1",
            resource: prepared,
          },
        ));
        await Promise.allSettled(admission.barriers);
        admission.cleanupUnsafe();

        expect(admission.current.claim.resources).toMatchObject([{
          status: "browser-closed-artifacts",
          identity: prepared,
        }]);
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("adopts an exact cleanup-resource publication after a post-commit throw", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      let injected = 0;
      try {
        const admission = acquireWebSessionCleanupAdmission(
          identity(),
          environment,
          new Date(),
          {
            afterResourceStateCommitForTest: () => {
              if (injected > 0) return;
              injected += 1;
              throw new Error("simulated post-commit publication failure");
            },
          },
        );
        let resolveCleanup: (() => void) | undefined;
        const cleanup = new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        });
        const publish = admission.registerCleanupBarrier(cleanup);
        if (typeof publish !== "function") {
          throw new Error("cleanup admission omitted its resource publisher");
        }

        expect(() => publish(fixture.resource)).not.toThrow();
        expect(injected).toBe(1);
        expect(admission.current.claim.resources).toMatchObject([{
          status: "active",
          identity: fixture.resource,
        }]);

        admission.closeRegistration();
        resolveCleanup?.();
        await Promise.allSettled(admission.barriers);
        admission.cleanupComplete();
        admission.release();
        expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("durably journals ordinary browser cleanup in exact root order", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      try {
        const admission = acquireWebSessionCleanupAdmission(
          identity(),
          environment,
        );
        let resolveCleanup: (() => void) | undefined;
        const cleanup = new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        });
        const publish = admission.registerCleanupBarrier(cleanup);
        if (typeof publish !== "function") {
          throw new Error("cleanup admission omitted its resource publisher");
        }
        const journal = publish as typeof publish & {
          readonly markBrowserCleanupQuiescent: (
            resource: BrowserCleanupResourceIdentityV2,
          ) => void;
          readonly markBrowserCleanupRootRemoved: (
            resource: BrowserCleanupResourceIdentityV2,
            root: "artifacts" | "socket",
          ) => void;
        };

        publish(fixture.resource);
        expect(() => journal.markBrowserCleanupQuiescent(Object.freeze({
          ...fixture.resource,
          phase: "prepared",
          control: null,
        }))).toThrow("changed resource identity");
        journal.markBrowserCleanupQuiescent(fixture.resource);
        expect(admission.current.claim.resources).toMatchObject([{
          status: "browser-quiescent-artifacts",
          removedRoots: [],
        }]);
        expect(() => journal.markBrowserCleanupRootRemoved(
          fixture.resource,
          "artifacts",
        )).toThrow("not exact");

        rmSync(fixture.artifactsDirectory, { recursive: true });
        journal.markBrowserCleanupRootRemoved(
          fixture.resource,
          "artifacts",
        );
        expect(admission.current.claim.resources).toMatchObject([{
          status: "browser-quiescent-artifacts",
          removedRoots: ["artifacts"],
        }]);
        expect(() => journal.markBrowserCleanupRootRemoved(
          fixture.resource,
          "socket",
        )).toThrow("not exact");

        rmSync(fixture.socketDirectory, { recursive: true });
        journal.markBrowserCleanupRootRemoved(fixture.resource, "socket");
        expect(admission.current.claim.resources).toMatchObject([{
          status: "browser-quiescent-artifacts",
          removedRoots: ["artifacts", "socket"],
        }]);

        admission.closeRegistration();
        resolveCleanup?.();
        await Promise.allSettled(admission.barriers);
        admission.cleanupComplete();
        admission.release();
        expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("persists only monotonic browser pins and finalizes against the latest pin", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
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
        const controlled = parseBrowserCleanupResourceIdentity(
          fixture.resource,
        );
        if (
          controlled.kind !== "agent-browser-session-v2"
          || controlled.phase !== "controlled"
        ) {
          throw new Error("expected a controlled v2 cleanup resource");
        }
        const prepared: BrowserCleanupResourceIdentityV2 = Object.freeze({
          ...controlled,
          phase: "prepared",
          control: null,
        });
        const launchIntent: BrowserCleanupResourceIdentityV2 = Object.freeze({
          ...controlled,
          phase: "launch-intent",
          control: null,
        });
        publish(prepared);
        publish(launchIntent);
        publish(controlled);
        expect(() => publish(prepared)).toThrow("changed after publication");
        expect(() => publish({
          ...controlled,
          control: {
            ...controlled.control,
            launchHash: "43",
          },
        })).toThrow("changed after publication");
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
            resources: [{
              status: "browser-closed-artifacts",
              identity: fixture.resource,
            }],
          },
        }]);
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("retains dead legacy browser claims that lack root-generation evidence", async () => {
    await withState(async (environment) => {
      const fixture = browserCleanupResourceFixture();
      let sessionReads = 0;
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

        const report = await recoverWebSessionCleanupAdmissionsCore(
          environment,
          {
            currentBootId: current.bootId,
            inspectOwner: () => "different-or-dead",
            browserLifecycle: {
              runCommand: (command) => {
                sessionReads += 1;
                expect(command.slice(-3)).toEqual([
                  "session",
                  "info",
                  "--json",
                ]);
                return Promise.resolve(
                  inactiveAgentBrowserSessionResult(fixture.resource),
                );
              },
            },
          },
        );

        expect(report).toMatchObject({
          scanned: 1,
          repaired: 0,
          retained: 1,
          invalid: 0,
          issues: [{ kind: "cleanup-unsafe" }],
        });
        expect(sessionReads).toBe(1);
        expect(existsSync(fixture.socketDirectory)).toBeTrue();
        expect(existsSync(fixture.artifactsDirectory)).toBeTrue();
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

        expect(() => acquireWebSessionCleanupAdmission(
          identity({ runId: randomUUID() }),
          environment,
        )).toThrow(WebSessionCleanupAdmissionBlockedError);
        expect(existsSync(fixture.socketDirectory)).toBeTrue();
        expect(existsSync(fixture.artifactsDirectory)).toBeTrue();
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

  test("retains browser resources from a different boot without probing them", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          {
            bootId: differentDigest(current.bootId),
            processStartId: differentDigest(current.processStartId),
          },
          [{
            resourceId: randomUUID(),
            status: "active",
            identity: fixture.resource,
          }],
          {},
          2,
        );

        const report = await recoverWebSessionCleanupAdmissionsCore(
          environment,
          {
            currentBootId: current.bootId,
            inspectOwner: () => "different-or-dead",
            browserLifecycle: {
              runCommand: () => {
                throw new Error("cross-boot browser recovery was attempted");
              },
            },
          },
        );

        expect(report).toMatchObject({
          scanned: 1,
          repaired: 0,
          retained: 1,
          issues: [{ kind: "cleanup-unsafe" }],
        });
        expect(existsSync(fixture.socketDirectory)).toBeTrue();
        expect(existsSync(fixture.artifactsDirectory)).toBeTrue();
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("leases and removes only an exact pinned inactive browser generation", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      let observedLease = false;
      let endpointRefusals = 0;
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "active",
            identity: fixture.resource,
          }],
          {},
          2,
          {
            status: "active",
            owner: {
              pid: 424_243,
              token: randomUUID(),
              bootId: "c".repeat(64),
              processStartId: "d".repeat(64),
            },
            acquiredAt: "2026-08-30T11:59:00.000Z",
          },
        );
        const report = await recoverWebSessionCleanupAdmissionsCore(
          environment,
          {
            currentBootId: current.bootId,
            inspectOwner: () => "different-or-dead",
            browserLifecycle: {
              ownerStatus: () => "different-or-dead",
              runCommand: () => {
                const [entry] = listWebSessionCleanupAdmissions(environment);
                if (
                  entry !== undefined
                  && !("invalid" in entry)
                  && entry.claim.schemaVersion === 2
                  && entry.claim.recovery.status === "active"
                ) observedLease = true;
                return Promise.resolve({
                  stdout: `${JSON.stringify({
                    success: true,
                    data: {
                      active: false,
                      namespace: null,
                      pid: null,
                      runtime: null,
                      runtimeError: null,
                      session: fixture.resource.session,
                      socketDir: fixture.resource.socketDirectory,
                      version: null,
                    },
                  })}\n`,
                  stderr: "",
                  exitCode: 0,
                });
              },
              cdpEndpointStatus: () => {
                endpointRefusals += 1;
                return Promise.resolve("unavailable");
              },
              sleep: () => Promise.resolve(),
            },
          },
        );
        expect(report).toMatchObject({
          scanned: 1,
          repaired: 1,
          retained: 0,
          issues: [],
        });
        expect(observedLease).toBeTrue();
        expect(endpointRefusals).toBe(12);
        expect(existsSync(fixture.socketDirectory)).toBeFalse();
        expect(existsSync(fixture.artifactsDirectory)).toBeFalse();
        expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("recovers exact prepared roots without inventing a launch", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      const prepared: BrowserCleanupResourceIdentityV2 = Object.freeze({
        ...fixture.resource,
        phase: "prepared",
        control: null,
      });
      let sessionReads = 0;
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "active",
            identity: prepared,
          }],
          {},
          2,
        );

        const report = await recoverWebSessionCleanupAdmissionsCore(
          environment,
          {
            currentBootId: current.bootId,
            inspectOwner: () => "different-or-dead",
            browserLifecycle: {
              runCommand: () => {
                sessionReads += 1;
                return Promise.resolve(
                  inactiveAgentBrowserSessionResult(prepared),
                );
              },
              cdpEndpointStatus: () => {
                throw new Error("prepared recovery probed an unbound endpoint");
              },
            },
          },
        );

        expect(report).toMatchObject({
          scanned: 1,
          repaired: 1,
          retained: 0,
          issues: [],
        });
        expect(sessionReads).toBe(6);
        expect(existsSync(fixture.socketDirectory)).toBeFalse();
        expect(existsSync(fixture.artifactsDirectory)).toBeFalse();
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("retains an unpinned launch-intent crash when the live control is absent", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      const launchIntent: BrowserCleanupResourceIdentityV2 = Object.freeze({
        ...fixture.resource,
        phase: "launch-intent",
        control: null,
      });
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "active",
            identity: launchIntent,
          }],
          {},
          2,
        );

        const report = await recoverWebSessionCleanupAdmissionsCore(
          environment,
          {
            currentBootId: current.bootId,
            inspectOwner: () => "different-or-dead",
            browserLifecycle: {
              runCommand: () => Promise.resolve(
                inactiveAgentBrowserSessionResult(launchIntent),
              ),
            },
          },
        );

        expect(report).toMatchObject({
          scanned: 1,
          repaired: 0,
          retained: 1,
          issues: [{ kind: "recovery-conflict" }],
        });
        expect(existsSync(fixture.socketDirectory)).toBeTrue();
        expect(existsSync(fixture.artifactsDirectory)).toBeTrue();
        expect(listWebSessionCleanupAdmissions(environment)).toHaveLength(1);
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("resumes a quiescent root journal after deletion precedes its CAS", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      let endpointRefusals = 0;
      let sessionReads = 0;
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "browser-quiescent-artifacts",
            identity: fixture.resource,
            removedRoots: [],
          }],
          {},
          2,
        );
        rmSync(fixture.artifactsDirectory, { recursive: true });

        const report = await recoverWebSessionCleanupAdmissionsCore(
          environment,
          {
            currentBootId: current.bootId,
            inspectOwner: () => "different-or-dead",
            browserLifecycle: {
              ownerStatus: () => "different-or-dead",
              runCommand: () => {
                sessionReads += 1;
                return Promise.resolve(
                  inactiveAgentBrowserSessionResult(fixture.resource),
                );
              },
              cdpEndpointStatus: () => {
                endpointRefusals += 1;
                return Promise.resolve("unavailable");
              },
              sleep: () => Promise.resolve(),
            },
          },
        );

        expect(report).toMatchObject({
          scanned: 1,
          repaired: 1,
          retained: 0,
          issues: [],
        });
        expect(existsSync(fixture.socketDirectory)).toBeFalse();
        expect(existsSync(fixture.artifactsDirectory)).toBeFalse();
        expect(sessionReads).toBe(2);
        expect(endpointRefusals).toBe(6);
        expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("resumes after socket deletion precedes its final journal CAS", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "browser-quiescent-artifacts",
            identity: fixture.resource,
            removedRoots: ["artifacts"],
          }],
          {},
          2,
        );
        rmSync(fixture.artifactsDirectory, { recursive: true });
        rmSync(fixture.socketDirectory, { recursive: true });

        const report = await recoverWebSessionCleanupAdmissionsCore(
          environment,
          {
            currentBootId: current.bootId,
            inspectOwner: () => "different-or-dead",
            browserLifecycle: {
              runCommand: () => {
                throw new Error("final journal recovery repeated browser effects");
              },
            },
          },
        );

        expect(report).toMatchObject({
          scanned: 1,
          repaired: 1,
          retained: 0,
          issues: [],
        });
        expect(listWebSessionCleanupAdmissions(environment)).toEqual([]);
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("retains a replacement encountered while resuming root deletion", async () => {
    await withState(async (environment) => {
      const fixture = pinnedBrowserCleanupResourceFixture();
      const displacedSocket = `${fixture.socketDirectory}.displaced`;
      try {
        const current = currentProcessStartIdentity();
        writeAdmissionFixture(
          environment,
          { status: "cleanup-unsafe" },
          { processStartId: differentDigest(current.processStartId) },
          [{
            resourceId: randomUUID(),
            status: "browser-quiescent-artifacts",
            identity: fixture.resource,
            removedRoots: [],
          }],
          {},
          2,
        );
        rmSync(fixture.artifactsDirectory, { recursive: true });
        renameSync(fixture.socketDirectory, displacedSocket);
        mkdirSync(fixture.socketDirectory, { mode: 0o700 });

        const report = await recoverWebSessionCleanupAdmissionsCore(
          environment,
          {
            currentBootId: current.bootId,
            inspectOwner: () => "different-or-dead",
            browserLifecycle: {
              runCommand: () => {
                throw new Error("quiescent journal reran browser effects");
              },
            },
          },
        );

        expect(report).toMatchObject({
          scanned: 1,
          repaired: 0,
          retained: 1,
          issues: [{ kind: "recovery-conflict" }],
        });
        expect(listWebSessionCleanupAdmissions(environment)).toMatchObject([{
          claim: {
            resources: [{
              status: "browser-quiescent-artifacts",
              removedRoots: ["artifacts"],
            }],
          },
        }]);
        expect(existsSync(fixture.socketDirectory)).toBeTrue();
        expect(existsSync(displacedSocket)).toBeTrue();
      } finally {
        rmSync(fixture.socketDirectory, { recursive: true, force: true });
        rmSync(displacedSocket, { recursive: true, force: true });
        rmSync(fixture.artifactsDirectory, { recursive: true, force: true });
      }
    });
  });

  test("retains same-boot cleanup uncertainty when browser-closed proof is absent or identity-changed", async () => {
    await withState(async (environment) => {
      const current = currentProcessStartIdentity();
      writeAdmissionFixture(
        environment,
        { status: "cleanup-unsafe" },
        { processStartId: differentDigest(current.processStartId) },
      );
      expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 0,
        retained: 1,
        issues: [{ kind: "cleanup-unsafe" }],
      });
    });
    await withState(async (environment) => {
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

        expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
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

  test("repairs pre-resource owner death and retains unproved resource state", async () => {
    await withState(async (environment) => {
      const current = currentProcessStartIdentity();
      writeAdmissionFixture(
        environment,
        { status: "parent-owned" },
        { processStartId: differentDigest(current.processStartId) },
      );
      expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 1,
        retained: 0,
        invalid: 0,
      });
    });
    await withState(async (environment) => {
      writeAdmissionFixture(
        environment,
        { status: "resource-active" },
      );
      expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 0,
        retained: 1,
        issues: [{
          kind: "resource-active",
        }],
      });
    });
    await withState(async (environment) => {
      const current = currentProcessStartIdentity();
      writeAdmissionFixture(
        environment,
        { status: "resource-active" },
        { processStartId: differentDigest(current.processStartId) },
      );
      expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 0,
        retained: 1,
        issues: [{ kind: "cleanup-unsafe" }],
      });
      expect(listWebSessionCleanupAdmissions(environment)).toHaveLength(1);
    });
    await withState(async (environment) => {
      const current = currentProcessStartIdentity();
      writeAdmissionFixture(
        environment,
        { status: "resource-active" },
        { bootId: differentDigest(current.bootId) },
      );
      expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 0,
        retained: 1,
        issues: [{ kind: "cleanup-unsafe" }],
      });
    });
  });

  test("blocks acquisition and a second doctor while an exact recovery owner is live", async () => {
    await withState(async (environment) => {
      const current = currentProcessStartIdentity();
      writeAdmissionFixture(
        environment,
        { status: "resource-active" },
        { processStartId: differentDigest(current.processStartId) },
        undefined,
        {},
        2,
        {
          status: "active",
          owner: {
            pid: process.pid,
            token: randomUUID(),
            ...current,
          },
          acquiredAt: "2026-08-30T12:00:00.000Z",
        },
      );
      expect(() => acquireWebSessionCleanupAdmission(
        identity({ runId: randomUUID() }),
        environment,
      )).toThrow("cleanup recovery is active");
      expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
        scanned: 1,
        repaired: 0,
        active: 1,
        retained: 0,
        issues: [{ kind: "recovery-active" }],
      });
    });
  });

  test("production recovery ignores caller-forged liveness and boot evidence", async () => {
    await withState(async (environment) => {
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

      expect(await attemptForgedRecovery(environment, {
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
    await withState(async (environment) => {
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
      expect(await recoverWebSessionCleanupAdmissions(environment)).toMatchObject({
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
