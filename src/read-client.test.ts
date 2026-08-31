import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createAuth, removeAuth, saveAuth, type WrenchAuth } from "./auth";
import { canonicalJson, manifestHash, sha256, type WrenchManifest } from "./model";
import { currentProcessStartIdentity } from "./process-identity";
import { providerPluginRegistry } from "./provider-plugins";
import {
  readCachedPreparedCapability,
  revalidatePreparedCapability,
} from "./read-client";
import type { ReadProjectionQuery } from "./read-projections";
import {
  createReadProjectionQueryForInvocation,
  prepareInvocation,
  type InvocationResult,
  type PreparedInvocation,
  type RunReceipt,
} from "./runtime";
import { installManifest } from "./storage";
import {
  persistedAuthAuthority,
  publicWebSessionAuthorityIdentityHash,
  publicWebSessionInvocationAuthority,
} from "./web-session-authentication-policy";

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly invocation: PreparedInvocation;
};

const FIRST_STARTED_AT = "2026-07-31T12:00:00.000Z";
const FIRST_FINISHED_AT = "2026-07-31T12:00:01.000Z";
const UNCHANGED_STARTED_AT = "2026-07-31T12:05:00.000Z";
const UNCHANGED_FINISHED_AT = "2026-07-31T12:05:01.000Z";
const CHANGED_STARTED_AT = "2026-07-31T12:10:00.000Z";
const CHANGED_FINISHED_AT = "2026-07-31T12:10:01.000Z";
const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;

function xManifest(): WrenchManifest {
  return JSON.parse(readFileSync(
    join(import.meta.dir, "assets", "adapters", "x", "wrench-adapter.json"),
    "utf8",
  )) as WrenchManifest;
}

function state(subject: string | null = "12345"): TestState {
  const directory = mkdtempSync(join(tmpdir(), "wrench-read-client-test-"));
  chmodSync(directory, 0o700);
  const environment = { WRENCH_STATE_HOME: directory };
  installManifest(xManifest(), {
    force: false,
    environment,
    registry: providerPluginRegistry,
  });
  saveAuth(createAuth("x-messages", {
    oauthProvider: "x",
    tokenFile: join(directory, "x-token.json"),
    scopes: ["dm.read", "tweet.read", "users.read"],
    ...(subject === null ? {} : { subject }),
  }), environment);
  return {
    directory,
    environment,
    invocation: prepareInvocation(
      "x",
      "messaging.list",
      { view: "all", limit: 25 },
      "x-messages",
      environment,
      providerPluginRegistry,
    ),
  };
}

function receipt(
  invocation: PreparedInvocation,
  options: {
    readonly runId: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly status?: "succeeded" | "failed";
  },
): RunReceipt {
  const operation = invocation.manifest.operations[invocation.operationId];
  if (operation === undefined || !("provider" in operation)) {
    throw new Error("expected an official provider read fixture");
  }
  const status = options.status ?? "succeeded";
  return {
    schemaVersion: 3,
    transport: "provider-api",
    providerContractHash: "a".repeat(64),
    runId: options.runId,
    planDigest: null,
    adapter: {
      id: invocation.manifest.id,
      version: invocation.manifest.version,
      hash: manifestHash(invocation.manifest),
    },
    operation: invocation.operationId,
    risk: "R1",
    inputHash: sha256(canonicalJson(invocation.input)),
    auth: {
      id: invocation.auth.id,
      hash: sha256(canonicalJson(invocation.auth)),
      kind: invocation.auth.kind,
    },
    status,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    finalOrigin: "https://api.x.com",
    error: status === "failed" ? "bounded synthetic read failure" : null,
  };
}

function result(
  invocation: PreparedInvocation,
  output: unknown,
  options: Parameters<typeof receipt>[1],
): InvocationResult {
  return {
    receipt: receipt(invocation, options),
    output,
    replayed: false,
  };
}

function execute(resultValue: InvocationResult) {
  return () => Promise.resolve(resultValue);
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected rejection to contain an Error");
  }
  throw new Error("expected promise to reject");
}

function replacementAuth(
  testState: TestState,
  subject: string,
  tokenFile = "replacement-x-token.json",
) {
  return createAuth("x-messages", {
    oauthProvider: "x",
    tokenFile: join(testState.directory, tokenFile),
    scopes: ["dm.read", "tweet.read", "users.read"],
    subject,
  });
}

type CrossProcessAdmissionAction =
  | { readonly kind: "hold" }
  | {
      readonly kind: "publish";
      readonly query: ReadProjectionQuery;
      readonly output: unknown;
      readonly options: {
        readonly runId: string;
        readonly startedAt: string;
        readonly finishedAt: string;
      };
    }
  | {
      readonly kind: "replace-auth";
      readonly replacements: readonly WrenchAuth[];
    };

async function startCrossProcessAdmissionHolder(
  testState: TestState,
  action: CrossProcessAdmissionAction,
  holdForMs = 750,
) {
  const readyPath = join(testState.directory, `.admission-ready-${randomUUID()}`);
  const projectionModuleUrl = pathToFileURL(
    join(import.meta.dir, "read-projections.ts"),
  ).href;
  const authModuleUrl = pathToFileURL(join(import.meta.dir, "auth.ts")).href;
  const child = Bun.spawn([
    process.execPath,
    "--eval",
    `
      const { writeFileSync } = await import("node:fs");
      const projection = await import(${JSON.stringify(projectionModuleUrl)});
      const auth = await import(${JSON.stringify(authModuleUrl)});
      const action = JSON.parse(process.env.WRENCH_TEST_ACTION);
      projection.withReadProjectionAuthAdmission(
        process.env.WRENCH_TEST_AUTH_ID,
        process.env,
        () => {
          writeFileSync(
            process.env.WRENCH_TEST_READY_PATH,
            "ready\\n",
            { mode: 0o600 },
          );
          if (action.kind === "publish") {
            projection.publishReadProjection(
              action.query,
              action.output,
              { ...action.options, environment: process.env },
            );
          } else if (action.kind === "replace-auth") {
            for (const replacement of action.replacements) {
              auth.saveAuth(replacement, process.env, { force: true });
            }
          }
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            Number(process.env.WRENCH_TEST_HOLD_MS),
          );
        },
      );
    `,
  ], {
    env: {
      ...process.env,
      WRENCH_STATE_HOME: testState.directory,
      WRENCH_TEST_AUTH_ID: testState.invocation.auth.id,
      WRENCH_TEST_READY_PATH: readyPath,
      WRENCH_TEST_HOLD_MS: String(holdForMs),
      WRENCH_TEST_ACTION: JSON.stringify(action),
    },
    detached: true,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const killAndReap = async (): Promise<void> => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child and its owned group already exited.
      }
    }
    await Promise.allSettled([child.exited, stderr]);
  };
  const deadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
  while (
    !existsSync(readyPath)
    && child.exitCode === null
    && performance.now() < deadline
  ) {
    await Bun.sleep(25);
  }
  if (!existsSync(readyPath)) {
    const observedExitCode = child.exitCode;
    await killAndReap();
    const exitCode = observedExitCode ?? await child.exited;
    const stderrText = await stderr;
    throw new Error(
      `cross-process admission holder did not become ready (exit ${exitCode}): ${stderrText}`,
    );
  }
  return Object.freeze({ child, killAndReap, stderr });
}

async function expectAdmissionHolderSuccess(
  holder: Awaited<ReturnType<typeof startCrossProcessAdmissionHolder>>,
): Promise<void> {
  const [exitCode, stderr] = await Promise.all([
    holder.child.exited,
    holder.stderr,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `cross-process admission holder failed (exit ${exitCode}): ${stderr}`,
    );
  }
  expect(stderr).toBe("");
}

describe("persistent read client", () => {
  test("stores the first live result and tracks unchanged and changed revisions", async () => {
    const testState = state();
    try {
      const firstOutput = {
        conversations: [{ id: "conversation-1", preview: "hello" }],
        nextCursor: "page-2",
      };
      const first = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, firstOutput, {
          runId: "00000000-0000-4000-8000-000000000001",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });

      expect(first.cachedBefore?.status).toBe("miss");
      expect(first.cachedBefore?.key).toMatch(/^[a-f0-9]{64}$/u);
      expect(first.cache.status).toBe("stored");
      if (first.cache.status !== "stored") throw new Error("expected stored projection");
      expect(first.cache.publication.disposition).toBe("created");

      const firstCached = readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        freshForMs: 60_000,
        now: new Date("2026-07-31T12:00:31.000Z"),
      });
      expect(firstCached.status).toBe("hit");
      if (firstCached.status !== "hit") throw new Error("expected cached projection");
      expect(firstCached.output).toEqual(firstOutput);
      expect(firstCached.ageMs).toBe(30_000);
      expect(firstCached.freshness).toEqual({
        state: "fresh",
        freshForMs: 60_000,
      });

      const unchanged = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, firstOutput, {
          runId: "00000000-0000-4000-8000-000000000002",
          startedAt: UNCHANGED_STARTED_AT,
          finishedAt: UNCHANGED_FINISHED_AT,
        })),
      });
      expect(unchanged.cache.status).toBe("stored");
      if (unchanged.cache.status !== "stored") {
        throw new Error("expected unchanged projection publication");
      }
      expect(unchanged.cache.publication.disposition).toBe("unchanged");

      const unchangedCached = readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      });
      expect(unchangedCached.status).toBe("hit");
      if (unchangedCached.status !== "hit") {
        throw new Error("expected unchanged cached projection");
      }
      expect(unchangedCached.dataRevision).toBe(firstCached.dataRevision);
      expect(unchangedCached.dataChangedAt).toBe(firstCached.dataChangedAt);
      expect(unchangedCached.validatedAt).toBe(UNCHANGED_FINISHED_AT);

      const changedOutput = {
        conversations: [
          { id: "conversation-1", preview: "hello" },
          { id: "conversation-2", preview: "new" },
        ],
        nextCursor: null,
      };
      const changed = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, changedOutput, {
          runId: "00000000-0000-4000-8000-000000000003",
          startedAt: CHANGED_STARTED_AT,
          finishedAt: CHANGED_FINISHED_AT,
        })),
      });
      expect(changed.cache.status).toBe("stored");
      if (changed.cache.status !== "stored") {
        throw new Error("expected changed projection publication");
      }
      expect(changed.cache.publication.disposition).toBe("changed");

      const changedCached = readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      });
      expect(changedCached.status).toBe("hit");
      if (changedCached.status !== "hit") {
        throw new Error("expected changed cached projection");
      }
      expect(changedCached.output).toEqual(changedOutput);
      expect(changedCached.dataRevision).not.toBe(firstCached.dataRevision);
      expect(changedCached.dataChangedAt).toBe(CHANGED_FINISHED_AT);
      expect(changedCached.validatedAt).toBe(CHANGED_FINISHED_AT);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("settles a successful live result after another process releases the auth coordinate", async () => {
    const testState = state();
    const holder = {
      current: null as Awaited<
        ReturnType<typeof startCrossProcessAdmissionHolder>
      > | null,
    };
    try {
      const output = {
        conversations: [{ id: "conversation-after-contention" }],
      };
      const settled = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: async () => {
          holder.current = await startCrossProcessAdmissionHolder(
            testState,
            { kind: "hold" },
          );
          return result(testState.invocation, output, {
            runId: "00000000-0000-4000-8000-000000000004",
            startedAt: FIRST_STARTED_AT,
            finishedAt: FIRST_FINISHED_AT,
          });
        },
      });

      expect(settled.live.output).toEqual(output);
      expect(settled.cache).toMatchObject({
        status: "stored",
        publication: { disposition: "created" },
      });
      if (holder.current === null) throw new Error("expected an admission holder");
      await expectAdmissionHolderSuccess(holder.current);
      holder.current = null;
      expect(readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      })).toMatchObject({ status: "hit", output });
    } finally {
      if (holder.current !== null) await holder.current.killAndReap();
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("returns superseded after a contending later-start publication and retains its head", async () => {
    const testState = state();
    const holder = {
      current: null as Awaited<
        ReturnType<typeof startCrossProcessAdmissionHolder>
      > | null,
    };
    try {
      const query = createReadProjectionQueryForInvocation(
        testState.invocation,
        testState.environment,
        providerPluginRegistry,
      );
      const newerOutput = {
        conversations: [{ id: "later-start-winner" }],
      };
      const olderOutput = {
        conversations: [{ id: "older-live-result" }],
      };
      const settled = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: async () => {
          holder.current = await startCrossProcessAdmissionHolder(testState, {
            kind: "publish",
            query,
            output: newerOutput,
            options: {
              runId: "00000000-0000-4000-8000-000000000006",
              startedAt: CHANGED_STARTED_AT,
              finishedAt: CHANGED_FINISHED_AT,
            },
          });
          return result(testState.invocation, olderOutput, {
            runId: "00000000-0000-4000-8000-000000000005",
            startedAt: UNCHANGED_STARTED_AT,
            finishedAt: UNCHANGED_FINISHED_AT,
          });
        },
      });

      expect(settled.live.output).toEqual(olderOutput);
      expect(settled.cache).toMatchObject({
        status: "stored",
        publication: { disposition: "superseded" },
      });
      if (holder.current === null) throw new Error("expected an admission holder");
      await expectAdmissionHolderSuccess(holder.current);
      holder.current = null;
      expect(readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      })).toMatchObject({
        status: "hit",
        output: newerOutput,
        validatedAt: CHANGED_FINISHED_AT,
      });
    } finally {
      if (holder.current !== null) await holder.current.killAndReap();
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retains the last good snapshot when a live read fails", async () => {
    const testState = state();
    try {
      const output = { conversations: [{ id: "conversation-1" }] };
      await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, output, {
          runId: "00000000-0000-4000-8000-000000000011",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });
      const before = readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      });
      if (before.status !== "hit") throw new Error("expected cached projection");

      const failed = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, null, {
          runId: "00000000-0000-4000-8000-000000000012",
          startedAt: UNCHANGED_STARTED_AT,
          finishedAt: UNCHANGED_FINISHED_AT,
          status: "failed",
        })),
      });
      expect(failed.cache).toEqual({
        status: "retained",
        reason: "live-read-failed",
      });
      expect(failed.cachedBefore).toMatchObject({
        status: "hit",
        key: before.key,
        output: before.output,
        dataRevision: before.dataRevision,
        validatedAt: before.validatedAt,
      });

      const after = readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      });
      expect(after).toMatchObject({
        status: "hit",
        key: before.key,
        output: before.output,
        dataRevision: before.dataRevision,
        validatedAt: before.validatedAt,
      });
      expect(after.status === "hit" ? after.output : null).toEqual(output);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retains the last good snapshot for a cleanup-blocked live read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-read-client-public-test-"));
    chmodSync(directory, 0o700);
    const environment = { WRENCH_STATE_HOME: directory };
    try {
      const manifest = JSON.parse(readFileSync(join(
        import.meta.dir,
        "assets",
        "adapters",
        "bluesky",
        "wrench-web-adapter.json",
      ), "utf8")) as WrenchManifest;
      const authority = publicWebSessionInvocationAuthority(
        manifest.id,
        "profiles.read",
      );
      const invocation: PreparedInvocation = {
        manifest,
        operationId: "profiles.read",
        input: { handle: "hraness.bsky.social" },
        auth: authority,
        readProjectionAuthIdentityHash:
          publicWebSessionAuthorityIdentityHash(authority),
      };
      const output = {
        metrics: { followers: { value: 54 } },
      };
      const cachedBefore = {
        status: "hit" as const,
        source: "cache" as const,
        key: "e".repeat(64),
        output,
        dataRevision: "a".repeat(64),
        createdAt: FIRST_STARTED_AT,
        dataChangedAt: FIRST_FINISHED_AT,
        validatedAt: FIRST_FINISHED_AT,
        runId: "00000000-0000-4000-8000-000000000014",
        ageMs: 0,
        freshness: { state: "fresh" as const, freshForMs: 60_000 },
      };

      const cleanupBlocked = {
        receipt: {
          schemaVersion: 4 as const,
          transport: "web-session-api" as const,
          webSessionContractHash: "d".repeat(64),
          runId: "00000000-0000-4000-8000-000000000015",
          planDigest: null,
          adapter: {
            id: manifest.id,
            version: manifest.version,
            hash: manifestHash(manifest),
          },
          operation: invocation.operationId,
          risk: "R1" as const,
          inputHash: sha256(canonicalJson(invocation.input)),
          auth: {
            id: authority.id,
            hash: sha256(canonicalJson(authority)),
            kind: authority.kind,
          },
          status: "failed" as const,
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
          startedAt: UNCHANGED_STARTED_AT,
          finishedAt: UNCHANGED_FINISHED_AT,
          finalOrigin: null,
          error:
            "authenticated web API operation failed before the dispatch boundary",
        },
        output: null,
        replayed: false,
        readFailure: {
          category: "cleanup-required" as const,
          retryDisposition: "do-not-retry" as const,
        },
        privateArtifactsPreserved: false,
      } satisfies InvocationResult;
      const failed = await revalidatePreparedCapability(invocation, {
        environment,
        registry: providerPluginRegistry,
        executeRead: execute(cleanupBlocked),
      }, cachedBefore);

      expect(failed.live).toEqual(cleanupBlocked);
      expect(failed.live.readFailure).toEqual({
        category: "cleanup-required",
        retryDisposition: "do-not-retry",
      });
      expect(failed.cache).toEqual({
        status: "retained",
        reason: "live-read-failed",
      });
      expect(failed.cachedBefore).toMatchObject({
        status: "hit",
        output,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports an initial cache miss when the first live read fails", async () => {
    const testState = state();
    try {
      const failed = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, null, {
          runId: "00000000-0000-4000-8000-000000000013",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
          status: "failed",
        })),
      });

      expect(failed.cachedBefore?.status).toBe("miss");
      expect(failed.cachedBefore?.key).toMatch(/^[a-f0-9]{64}$/u);
      expect(failed.cache).toEqual({
        status: "miss",
        reason: "no-cached-snapshot",
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("allows an unbound live read but skips persistence", async () => {
    const testState = state(null);
    try {
      const output = { conversations: [{ id: "conversation-1" }] };
      const live = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, output, {
          runId: "00000000-0000-4000-8000-000000000021",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });

      expect(live.live.output).toEqual(output);
      expect(live.cachedBefore).toBeNull();
      expect(live.cache).toEqual({
        status: "skipped",
        reason: "auth-subject-unbound",
      });
      expect(() => readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      })).toThrow("wrench auth bind x-messages");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("discards private live output and removes old projections when the auth realm changes during revalidation", async () => {
    const testState = state();
    try {
      const firstOutput = { conversations: [{ id: "conversation-1" }] };
      await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, firstOutput, {
          runId: "00000000-0000-4000-8000-000000000031",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });

      const changedRealmResult = result(testState.invocation, {
        conversations: [{ id: "conversation-from-wrong-realm" }],
      }, {
        runId: "00000000-0000-4000-8000-000000000032",
        startedAt: UNCHANGED_STARTED_AT,
        finishedAt: UNCHANGED_FINISHED_AT,
      });
      const raced = await rejectedError(revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: () => {
          saveAuth(replacementAuth(testState, "67890"), testState.environment, {
            force: true,
          });
          return Promise.resolve(changedRealmResult);
        },
      }));

      expect(raced).toMatchObject({
        message: "auth locator x-messages changed while the live read was running; its result was discarded",
      });
      const after = readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      });
      expect(after.status).toBe("miss");
      expect(after.key).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test.each(["a-to-b", "a-to-b-to-a"] as const)(
    "discards live output when an admission holder replaces auth %s",
    async (cycle) => {
      const testState = state();
      const holder = {
        current: null as Awaited<
          ReturnType<typeof startCrossProcessAdmissionHolder>
        > | null,
      };
      try {
        const replacement = replacementAuth(testState, "67890");
        const replacements = cycle === "a-to-b"
          ? [replacement]
          : [replacement, persistedAuthAuthority(testState.invocation.auth)];
        const raced = await rejectedError(revalidatePreparedCapability(
          testState.invocation,
          {
            environment: testState.environment,
            registry: providerPluginRegistry,
            executeRead: async () => {
              holder.current = await startCrossProcessAdmissionHolder(testState, {
                kind: "replace-auth",
                replacements,
              });
              return result(testState.invocation, {
                conversations: [{ id: `discarded-${cycle}` }],
              }, {
                runId: cycle === "a-to-b"
                  ? "00000000-0000-4000-8000-000000000043"
                  : "00000000-0000-4000-8000-000000000044",
                startedAt: UNCHANGED_STARTED_AT,
                finishedAt: UNCHANGED_FINISHED_AT,
              });
            },
          },
        ));

        expect(raced.message).toContain(
          "changed while the live read was running; its result was discarded",
        );
        if (holder.current === null) {
          throw new Error("expected an admission holder");
        }
        await expectAdmissionHolderSuccess(holder.current);
        holder.current = null;
        expect(readCachedPreparedCapability(testState.invocation, {
          environment: testState.environment,
          registry: providerPluginRegistry,
        })).toMatchObject({ status: "miss" });
      } finally {
        if (holder.current !== null) await holder.current.killAndReap();
        rmSync(testState.directory, { recursive: true, force: true });
      }
    },
  );

  test("does not retain a cached snapshot when a failed read races auth replacement", async () => {
    const testState = state();
    try {
      const cachedOutput = { conversations: [{ id: "conversation-1" }] };
      await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, cachedOutput, {
          runId: "00000000-0000-4000-8000-000000000033",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });

      const failed = await rejectedError(revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: () => {
          saveAuth(replacementAuth(testState, "67890"), testState.environment, {
            force: true,
          });
          return Promise.resolve(result(testState.invocation, null, {
            runId: "00000000-0000-4000-8000-000000000034",
            startedAt: UNCHANGED_STARTED_AT,
            finishedAt: UNCHANGED_FINISHED_AT,
            status: "failed",
          }));
        },
      }));

      expect(failed).toMatchObject({
        message: "auth locator x-messages changed while the live read was running; its result was discarded",
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects a prepared invocation after its auth is removed without running live I/O", async () => {
    const testState = state();
    try {
      expect(removeAuth(testState.invocation.auth.id, testState.environment))
        .toBeTrue();
      let executions = 0;

      const error = await rejectedError(revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: () => {
          executions += 1;
          return Promise.resolve(result(testState.invocation, null, {
            runId: "00000000-0000-4000-8000-000000000035",
            startedAt: FIRST_STARTED_AT,
            finishedAt: FIRST_FINISHED_AT,
            status: "failed",
          }));
        },
      }));
      expect(error.message).toContain("changed since this invocation was prepared");
      expect(executions).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects a prepared invocation after forced auth replacement without running live I/O", async () => {
    const testState = state();
    try {
      saveAuth(replacementAuth(testState, "67890"), testState.environment, {
        force: true,
      });
      let executions = 0;

      const error = await rejectedError(revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: () => {
          executions += 1;
          return Promise.resolve(result(testState.invocation, null, {
            runId: "00000000-0000-4000-8000-000000000036",
            startedAt: FIRST_STARTED_AT,
            finishedAt: FIRST_FINISHED_AT,
            status: "failed",
          }));
        },
      }));
      expect(error.message).toContain("changed since this invocation was prepared");
      expect(executions).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects a prepared invocation after an A-to-B-to-A auth cycle without running live I/O", async () => {
    const testState = state();
    try {
      saveAuth(replacementAuth(testState, "67890"), testState.environment, {
        force: true,
      });
      saveAuth(
        persistedAuthAuthority(testState.invocation.auth),
        testState.environment,
        { force: true },
      );
      let executions = 0;

      const error = await rejectedError(revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: () => {
          executions += 1;
          return Promise.resolve(result(testState.invocation, null, {
            runId: "00000000-0000-4000-8000-000000000037",
            startedAt: FIRST_STARTED_AT,
            finishedAt: FIRST_FINISHED_AT,
            status: "failed",
          }));
        },
      }));
      expect(error.message).toContain("changed since this invocation was prepared");
      expect(executions).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed on malformed auth bytes before serving cache or running live I/O", async () => {
    const testState = state();
    try {
      await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, {
          conversations: [{ id: "private-conversation" }],
        }, {
          runId: "00000000-0000-4000-8000-000000000038",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });
      writeFileSync(
        join(testState.directory, "auth", "x-messages.json"),
        "{malformed\n",
        { mode: 0o600 },
      );

      expect(() => readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      })).toThrow("auth record is malformed JSON");

      let executions = 0;
      const error = await rejectedError(revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: () => {
          executions += 1;
          return Promise.resolve(result(testState.invocation, null, {
            runId: "00000000-0000-4000-8000-000000000039",
            startedAt: UNCHANGED_STARTED_AT,
            finishedAt: UNCHANGED_FINISHED_AT,
            status: "failed",
          }));
        },
      }));
      expect(error.message).toContain("auth record is malformed JSON");
      expect(executions).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("atomically repairs corruption introduced after the initial cache hit", async () => {
    const testState = state();
    try {
      const firstOutput = {
        conversations: [{ id: "conversation-before-corruption" }],
      };
      await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, firstOutput, {
          runId: "00000000-0000-4000-8000-000000000051",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });
      const query = createReadProjectionQueryForInvocation(
        testState.invocation,
        testState.environment,
        providerPluginRegistry,
      );
      const queryDirectory = join(
        testState.directory,
        "read-projections",
        query.realmKey,
        query.key,
      );
      const chunkName = readdirSync(queryDirectory).find((name) =>
        name.startsWith("chunk--"));
      if (chunkName === undefined) throw new Error("expected encrypted projection chunk");
      const corruptChunkPath = join(queryDirectory, chunkName);
      const changedOutput = {
        conversations: [{ id: "conversation-after-repair" }],
      };

      const repaired = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: () => {
          const chunk = JSON.parse(
            readFileSync(corruptChunkPath, "utf8"),
          ) as Record<string, unknown>;
          const ciphertext = String(chunk.ciphertext);
          chunk.ciphertext = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
          writeFileSync(corruptChunkPath, `${canonicalJson(chunk)}\n`, {
            mode: 0o600,
          });
          return Promise.resolve(result(testState.invocation, changedOutput, {
            runId: "00000000-0000-4000-8000-000000000052",
            startedAt: CHANGED_STARTED_AT,
            finishedAt: CHANGED_FINISHED_AT,
          }));
        },
      });

      expect(repaired.cachedBefore).toMatchObject({
        status: "hit",
        output: firstOutput,
      });
      expect(repaired.cache).toMatchObject({
        status: "stored",
        publication: {
          disposition: "changed",
          dataChangedAt: CHANGED_FINISHED_AT,
          validatedAt: CHANGED_FINISHED_AT,
        },
      });
      expect(existsSync(corruptChunkPath)).toBeFalse();
      expect(readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      })).toMatchObject({
        status: "hit",
        output: changedOutput,
        dataChangedAt: CHANGED_FINISHED_AT,
        validatedAt: CHANGED_FINISHED_AT,
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reports stored when repair is durable but a live helper claim blocks cleanup", async () => {
    const testState = state();
    try {
      await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, {
          conversations: [{ id: "conversation-before-cleanup-race" }],
        }, {
          runId: "00000000-0000-4000-8000-000000000053",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });
      const query = createReadProjectionQueryForInvocation(
        testState.invocation,
        testState.environment,
        providerPluginRegistry,
      );
      const queryDirectory = join(
        testState.directory,
        "read-projections",
        query.realmKey,
        query.key,
      );
      const chunkName = readdirSync(queryDirectory).find((name) =>
        name.startsWith("chunk--"));
      if (chunkName === undefined) throw new Error("expected encrypted projection chunk");
      const corruptChunkPath = join(queryDirectory, chunkName);
      const targetSha256 = sha256("io-state-mutation\0unrelated.json");
      const claimId = "77777777-7777-4777-8777-777777777777";
      const claimPath = join(
        queryDirectory,
        `.io-mutation-${targetSha256}-held-${claimId}.lock`,
      );
      const changedOutput = {
        conversations: [{ id: "conversation-after-durable-repair" }],
      };

      const repaired = await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: () => {
          writeFileSync(corruptChunkPath, "{}\n", { mode: 0o600 });
          writeFileSync(
            claimPath,
            `${JSON.stringify({
              kind: "io-state-mutation-claim",
              schemaVersion: 1,
              targetSha256,
              claimId,
              pid: process.pid,
              ...currentProcessStartIdentity(),
            })}\n`,
            { mode: 0o600 },
          );
          return Promise.resolve(result(testState.invocation, changedOutput, {
            runId: "00000000-0000-4000-8000-000000000054",
            startedAt: CHANGED_STARTED_AT,
            finishedAt: CHANGED_FINISHED_AT,
          }));
        },
      });

      expect(repaired.cache).toMatchObject({
        status: "stored",
        publication: {
          disposition: "changed",
          validatedAt: CHANGED_FINISHED_AT,
        },
      });
      expect(existsSync(claimPath)).toBeTrue();
      expect(existsSync(corruptChunkPath)).toBeTrue();
      expect(readCachedPreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      })).toMatchObject({
        status: "hit",
        output: changedOutput,
        validatedAt: CHANGED_FINISHED_AT,
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("does not revive an orphaned snapshot after exact auth removal and recreation", async () => {
    const testState = state();
    try {
      const output = { conversations: [{ id: "old-account-conversation" }] };
      await revalidatePreparedCapability(testState.invocation, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        executeRead: execute(result(testState.invocation, output, {
          runId: "00000000-0000-4000-8000-000000000041",
          startedAt: FIRST_STARTED_AT,
          finishedAt: FIRST_FINISHED_AT,
        })),
      });
      const oldQuery = createReadProjectionQueryForInvocation(
        testState.invocation,
        testState.environment,
        providerPluginRegistry,
      );
      const realm = join(
        testState.directory,
        "read-projections",
        oldQuery.realmKey,
      );
      const orphan = join(testState.directory, "orphaned-read-projection-realm");
      renameSync(realm, orphan);

      expect(removeAuth(testState.invocation.auth.id, testState.environment))
        .toBeTrue();
      saveAuth(
        persistedAuthAuthority(testState.invocation.auth),
        testState.environment,
      );
      renameSync(orphan, realm);

      const recreated = prepareInvocation(
        "x",
        "messaging.list",
        { view: "all", limit: 25 },
        "x-messages",
        testState.environment,
        providerPluginRegistry,
      );
      const recreatedQuery = createReadProjectionQueryForInvocation(
        recreated,
        testState.environment,
        providerPluginRegistry,
      );
      expect(recreatedQuery.key).not.toBe(oldQuery.key);
      expect(readCachedPreparedCapability(recreated, {
        environment: testState.environment,
        registry: providerPluginRegistry,
      })).toEqual({
        status: "miss",
        key: recreatedQuery.key,
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
