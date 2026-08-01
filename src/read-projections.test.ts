import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256 } from "./canonical-json";
import { currentProcessStartIdentity } from "./process-identity";
import {
  ReadProjectionCorruptionError,
  ReadProjectionDurableRepairError,
  ReadProjectionAdmissionContentionError,
  acquireReadProjectionAuthAdmission,
  createReadProjectionQuery,
  projectionAuthIdentityHash,
  publishReadProjection,
  readReadProjection,
  removeReadProjectionAuthIncarnation,
  removeReadProjectionsForAuth,
  repairReadProjection,
  rotateReadProjectionAuthIncarnation,
  withReadProjectionAuthAdmission,
  withSettledReadProjectionAuthAdmission,
  type ReadProjectionQueryIdentity,
} from "./read-projections";

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

function state(): TestState {
  const directory = mkdtempSync(join(tmpdir(), "wrench-read-projection-test-"));
  chmodSync(directory, 0o700);
  return {
    directory,
    environment: { WRENCH_STATE_HOME: directory },
  };
}

function identity(
  overrides: Partial<ReadProjectionQueryIdentity> = {},
): ReadProjectionQueryIdentity {
  const input = overrides.input ?? { folder: "inbox", limit: 25 };
  return {
    adapter: {
      id: "reddit-web",
      version: "1.0.0",
      hash: "a".repeat(64),
    },
    operation: "messaging.list",
    input,
    inputHash: sha256(canonicalJson(input)),
    auth: {
      id: "reddit-main",
      kind: "cookie-source",
      hash: "b".repeat(64),
      subject: "reddit:t2_example",
    },
    contract: {
      transport: "web-session-api",
      hash: "c".repeat(64),
    },
    ...overrides,
  };
}

function publicationOptions(
  index: number,
  startedAt: string,
  finishedAt: string,
) {
  return {
    runId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    startedAt,
    finishedAt,
  } as const;
}

function allFiles(directory: string): readonly string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(directory);
  return files.sort();
}

function captureCorruption(operation: () => unknown): ReadProjectionCorruptionError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ReadProjectionCorruptionError) return error;
    throw error;
  }
  throw new Error("expected read projection corruption");
}

function captureDurableRepair(
  operation: () => unknown,
): ReadProjectionDurableRepairError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ReadProjectionDurableRepairError) return error;
    throw error;
  }
  throw new Error("expected durable read projection repair error");
}

function projectionDirectory(
  testState: TestState,
  query: Readonly<{ readonly realmKey: string; readonly key: string }>,
): string {
  return join(
    testState.directory,
    "read-projections",
    query.realmKey,
    query.key,
  );
}

function projectionKeyPath(testState: TestState): string {
  return join(testState.directory, ".projection-encryption-key");
}

function projectionStoreKeyMarkerPath(testState: TestState): string {
  return join(
    testState.directory,
    "read-projection-control",
    "store-key.json",
  );
}

function directoryBytes(directory: string): number {
  return allFiles(directory).reduce(
    (total, path) => total + readFileSync(path).byteLength,
    0,
  );
}

function writeSparsePrivateFiles(
  directories: readonly string[],
  totalBytes: number,
): { readonly path: string; readonly bytes: number } {
  const maximumFileBytes = 2 * 1024 * 1024;
  let remaining = totalBytes;
  let index = 0;
  let last: { readonly path: string; readonly bytes: number } | null = null;
  while (remaining > 0) {
    const directory = directories[Math.floor(index / 48)];
    if (directory === undefined) {
      throw new Error("quota fixture exceeds its bounded query directories");
    }
    const bytes = Math.min(maximumFileBytes, remaining);
    const path = join(directory, `quota-${String(index).padStart(3, "0")}`);
    writeFileSync(path, "", { mode: 0o600 });
    truncateSync(path, bytes);
    last = Object.freeze({ path, bytes });
    remaining -= bytes;
    index += 1;
  }
  if (last === null) throw new Error("quota fixture must contain bytes");
  return last;
}

async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["/usr/bin/true"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
  return child.pid;
}

async function crossProcessAdmissionHolder(
  testState: TestState,
  authId: string,
  holdForMs: number,
) {
  const readyPath = join(testState.directory, `.admission-ready-${randomUUID()}`);
  const admissionModuleUrl = pathToFileURL(
    join(import.meta.dir, "read-projection-admission.ts"),
  ).href;
  const child = Bun.spawn([
    process.execPath,
    "--eval",
    `
      const { writeFileSync } = await import("node:fs");
      const { acquireReadProjectionAuthAdmission } = await import(${JSON.stringify(admissionModuleUrl)});
      const admission = acquireReadProjectionAuthAdmission(
        process.env.WRENCH_TEST_AUTH_ID,
        process.env,
      );
      writeFileSync(process.env.WRENCH_TEST_READY_PATH, "ready\\n", { mode: 0o600 });
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Number(process.env.WRENCH_TEST_HOLD_MS),
      );
      admission.release();
    `,
  ], {
    env: {
      ...process.env,
      WRENCH_STATE_HOME: testState.directory,
      WRENCH_TEST_AUTH_ID: authId,
      WRENCH_TEST_READY_PATH: readyPath,
      WRENCH_TEST_HOLD_MS: String(holdForMs),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = performance.now() + 5_000;
  while (!existsSync(readyPath) && performance.now() < deadline) {
    await Bun.sleep(5);
  }
  if (!existsSync(readyPath)) {
    child.kill();
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    throw new Error(
      `cross-process admission holder did not become ready (exit ${exitCode}): ${stderr}`,
    );
  }
  return child;
}

async function initializeProjectionStoreInChild(
  testState: TestState,
): Promise<Readonly<{ readonly key: string; readonly realmKey: string }>> {
  const projectionModuleUrl = pathToFileURL(
    join(import.meta.dir, "read-projections.ts"),
  ).href;
  const child = Bun.spawn([
    process.execPath,
    "--eval",
    `
      const { createReadProjectionQuery } = await import(${JSON.stringify(projectionModuleUrl)});
      const query = createReadProjectionQuery(
        JSON.parse(process.env.WRENCH_TEST_QUERY_IDENTITY),
        process.env,
      );
      console.log(JSON.stringify({ key: query.key, realmKey: query.realmKey }));
    `,
  ], {
    env: {
      ...process.env,
      WRENCH_STATE_HOME: testState.directory,
      WRENCH_TEST_QUERY_IDENTITY: JSON.stringify(identity()),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  if (exitCode !== 0) {
    throw new Error(
      `projection store child initialization failed (exit ${exitCode}): ${stderr}`,
    );
  }
  return JSON.parse(stdout) as Readonly<{
    readonly key: string;
    readonly realmKey: string;
  }>;
}

describe("encrypted read projections", () => {
  test("binds opaque query coordinates to every exact identity component", () => {
    const testState = state();
    try {
      const baseIdentity = identity();
      const base = createReadProjectionQuery(baseIdentity, testState.environment);
      const variations: readonly ReadProjectionQueryIdentity[] = [
        identity({ adapter: { ...baseIdentity.adapter, hash: "d".repeat(64) } }),
        identity({ operation: "messaging.read" }),
        identity({ input: { folder: "inbox", limit: 50 } }),
        identity({ auth: { ...baseIdentity.auth, hash: "e".repeat(64) } }),
        identity({ auth: { ...baseIdentity.auth, subject: "reddit:t2_other" } }),
        identity({ contract: { ...baseIdentity.contract, hash: "f".repeat(64) } }),
      ];
      const keys = variations.map((value) =>
        createReadProjectionQuery(value, testState.environment).key);
      expect(new Set([base.key, ...keys]).size).toBe(variations.length + 1);
      expect(keys.every((key) => /^[a-f0-9]{64}$/u.test(key))).toBeTrue();
      expect(variations.map((value) =>
        createReadProjectionQuery(value, testState.environment).realmKey))
        .toEqual(Array.from({ length: variations.length }, () => base.realmKey));

      const otherAuth = createReadProjectionQuery(identity({
        auth: { ...baseIdentity.auth, id: "reddit-alt" },
      }), testState.environment);
      expect(otherAuth.realmKey).not.toBe(base.realmKey);
      expect(otherAuth.key).not.toBe(base.key);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects projection auth IDs outside the bounded lowercase grammar", () => {
    const testState = state();
    try {
      for (const id of ["Reddit-main", "reddit_main", `r${"x".repeat(48)}`]) {
        expect(() => createReadProjectionQuery(identity({
          auth: { ...identity().auth, id },
        }), testState.environment)).toThrow(
          "read projection auth ID must be lowercase kebab-case",
        );
      }
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("binds an authenticated canonical ownership marker to the encryption key", () => {
    const testState = state();
    try {
      createReadProjectionQuery(identity(), testState.environment);
      const keyRecord = JSON.parse(
        readFileSync(projectionKeyPath(testState), "utf8"),
      ) as Record<string, unknown>;
      const markerText = readFileSync(
        projectionStoreKeyMarkerPath(testState),
        "utf8",
      );
      const marker = JSON.parse(markerText) as Record<string, unknown>;
      expect(markerText).toBe(`${canonicalJson(marker)}\n`);
      expect(Object.keys(marker).sort()).toEqual([
        "authentication",
        "keyId",
        "schemaVersion",
      ]);
      expect(marker).toMatchObject({
        schemaVersion: 1,
        keyId: keyRecord.keyId,
      });
      expect(marker).not.toHaveProperty("key");
      expect(markerText).not.toContain(String(keyRecord.key));
      expect(lstatSync(projectionStoreKeyMarkerPath(testState)).mode & 0o777)
        .toBe(0o600);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects a valid replacement key instead of opening a parallel store", () => {
    const originalState = state();
    const replacementState = state();
    try {
      const original = createReadProjectionQuery(
        identity(),
        originalState.environment,
      );
      publishReadProjection(original, { messages: ["owned"] }, {
        environment: originalState.environment,
        ...publicationOptions(
          101,
          "2026-07-31T21:00:00.000Z",
          "2026-07-31T21:00:01.000Z",
        ),
      });
      createReadProjectionQuery(identity(), replacementState.environment);
      writeFileSync(
        projectionKeyPath(originalState),
        readFileSync(projectionKeyPath(replacementState)),
        { mode: 0o600 },
      );

      expect(() => createReadProjectionQuery(
        identity(),
        originalState.environment,
      )).toThrow(
        "store key marker does not match the projection encryption key",
      );
      expect(readdirSync(join(originalState.directory, "read-projections")))
        .toEqual([original.realmKey]);
    } finally {
      rmSync(originalState.directory, { recursive: true, force: true });
      rmSync(replacementState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed on missing or malformed ownership proof for ciphertext", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["owned"] }, {
        environment: testState.environment,
        ...publicationOptions(
          102,
          "2026-07-31T21:01:00.000Z",
          "2026-07-31T21:01:01.000Z",
        ),
      });
      const markerPath = projectionStoreKeyMarkerPath(testState);
      rmSync(markerPath);
      expect(() => readReadProjection(query, {
        environment: testState.environment,
      })).toThrow("store is missing its key ownership marker");
      expect(existsSync(markerPath)).toBeFalse();

      writeFileSync(markerPath, "{\"schemaVersion\":1}\n", { mode: 0o600 });
      expect(() => createReadProjectionQuery(
        identity(),
        testState.environment,
      )).toThrow("store key marker is malformed");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed on a malformed encryption key even with valid ownership state", () => {
    const testState = state();
    try {
      createReadProjectionQuery(identity(), testState.environment);
      writeFileSync(
        projectionKeyPath(testState),
        "{\"schemaVersion\":1}\n",
        { mode: 0o600 },
      );
      expect(() => createReadProjectionQuery(
        identity(),
        testState.environment,
      )).toThrow("projection encryption key is malformed");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("recovers key-before-marker initialization and a dead marker claim", async () => {
    const testState = state();
    try {
      createReadProjectionQuery(identity(), testState.environment);
      const markerPath = projectionStoreKeyMarkerPath(testState);
      rmSync(markerPath);
      const deadPid = await exitedPid();
      const claimId = randomUUID();
      const targetSha256 = sha256("io-state-mutation\0store-key.json");
      const claimPath = join(
        testState.directory,
        "read-projection-control",
        `.io-mutation-${targetSha256}-held-${claimId}.lock`,
      );
      writeFileSync(
        claimPath,
        `${JSON.stringify({
          kind: "io-state-mutation-claim",
          schemaVersion: 1,
          targetSha256,
          claimId,
          pid: deadPid,
          ...currentProcessStartIdentity(),
        })}\n`,
        { mode: 0o600 },
      );

      const recovered = createReadProjectionQuery(
        identity(),
        testState.environment,
      );
      expect(recovered.key).toMatch(/^[a-f0-9]{64}$/u);
      expect(existsSync(markerPath)).toBeTrue();
      expect(existsSync(claimPath)).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("concurrent fresh initializers converge on one key and marker", async () => {
    const testState = state();
    try {
      const [first, second] = await Promise.all([
        initializeProjectionStoreInChild(testState),
        initializeProjectionStoreInChild(testState),
      ]);
      expect(first).toEqual(second);
      const markerText = readFileSync(
        projectionStoreKeyMarkerPath(testState),
        "utf8",
      );
      expect(markerText).toBe(
        `${canonicalJson(JSON.parse(markerText) as unknown)}\n`,
      );
      expect(readdirSync(join(testState.directory, "read-projections")))
        .toEqual([]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("recovers only a definitely dead admission owner and remains re-entrant", () => {
    const testState = state();
    try {
      const admission = acquireReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
      );
      const admissionDirectory = join(
        testState.directory,
        "read-projection-control",
        "admissions",
      );
      const [claimName] = readdirSync(admissionDirectory);
      if (claimName === undefined) throw new Error("expected admission claim");
      const claimPath = join(admissionDirectory, claimName);
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as {
        owner: { bootId: string };
      };
      expect(() => acquireReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
      )).toThrow("active read projection transition");
      let sameProcessContention: unknown;
      try {
        withSettledReadProjectionAuthAdmission(
          "reddit-main",
          testState.environment,
          () => undefined,
          { maximumWaitMs: 1_000 },
        );
      } catch (error) {
        sameProcessContention = error;
      }
      expect(sameProcessContention).toBeInstanceOf(
        ReadProjectionAdmissionContentionError,
      );
      expect(sameProcessContention).toMatchObject({
        authId: "reddit-main",
        reason: "same-process-owner",
      });
      admission.release();
      claim.owner.bootId = claim.owner.bootId === "f".repeat(64)
        ? "e".repeat(64)
        : "f".repeat(64);
      writeFileSync(claimPath, `${canonicalJson(claim)}\n`, { mode: 0o600 });

      let nested = false;
      withReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
        () => withReadProjectionAuthAdmission(
          "reddit-main",
          testState.environment,
          () => {
            nested = true;
          },
        ),
      );
      expect(nested).toBeTrue();
      expect(readdirSync(admissionDirectory)).toEqual([]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("adopts and releases its exact claim after a committed create error", async () => {
    const testState = state();
    try {
      let injected = 0;
      const deadHelperPid = await exitedPid();
      const admissionDirectory = join(
        testState.directory,
        "read-projection-control",
        "admissions",
      );
      let strandedHelperClaimPath: string | null = null;
      const admission = acquireReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
        {
          afterCreateCommitForTest: () => {
            injected += 1;
            const admissionFile = readdirSync(admissionDirectory).find(
              (name) => name.endsWith(".json"),
            );
            if (admissionFile === undefined) {
              throw new Error("expected committed admission file");
            }
            const targetSha256 = sha256(
              `io-state-mutation\0${admissionFile}`,
            );
            const helperClaimId = randomUUID();
            strandedHelperClaimPath = join(
              admissionDirectory,
              `.io-mutation-${targetSha256}-held-${helperClaimId}.lock`,
            );
            writeFileSync(
              strandedHelperClaimPath,
              `${JSON.stringify({
                kind: "io-state-mutation-claim",
                schemaVersion: 1,
                targetSha256,
                claimId: helperClaimId,
                pid: deadHelperPid,
                ...currentProcessStartIdentity(),
              })}\n`,
              { mode: 0o600 },
            );
            throw new Error("injected postcommit admission failure");
          },
        },
      );
      expect(injected).toBe(1);
      const claimName = readdirSync(admissionDirectory).find(
        (name) => name.endsWith(".json"),
      );
      if (claimName === undefined) throw new Error("expected admission claim");
      const claim = JSON.parse(
        readFileSync(join(admissionDirectory, claimName), "utf8"),
      ) as { readonly owner: { readonly token: string } };
      expect(claim.owner.token).toBe(admission.owner.token);
      if (strandedHelperClaimPath === null) {
        throw new Error("expected stranded helper claim");
      }
      expect(existsSync(strandedHelperClaimPath)).toBeTrue();

      admission.release();
      admission.release();
      expect(existsSync(strandedHelperClaimPath)).toBeFalse();
      expect(readdirSync(admissionDirectory)).toEqual([]);
      const reacquired = acquireReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
      );
      reacquired.release();
      expect(readdirSync(admissionDirectory)).toEqual([]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retries exact release after transient state-mutation contention", () => {
    const testState = state();
    try {
      const admissionDirectory = join(
        testState.directory,
        "read-projection-control",
        "admissions",
      );
      let mutationClaimPath: string | null = null;
      let releaseContentions = 0;
      const admission = acquireReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
        {
          afterCreateCommitForTest: () => {
            const admissionFile = readdirSync(admissionDirectory).find(
              (name) => name.endsWith(".json"),
            );
            if (admissionFile === undefined) {
              throw new Error("expected committed admission file");
            }
            const targetSha256 = sha256(
              `io-state-mutation\0${admissionFile}`,
            );
            const claimId = randomUUID();
            mutationClaimPath = join(
              admissionDirectory,
              `.io-mutation-${targetSha256}-held-${claimId}.lock`,
            );
            writeFileSync(
              mutationClaimPath,
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
          },
          afterReleaseContentionForTest: () => {
            releaseContentions += 1;
            if (mutationClaimPath === null) {
              throw new Error("expected active state-mutation claim");
            }
            rmSync(mutationClaimPath, { force: true });
          },
        },
      );

      admission.release();
      admission.release();
      expect(releaseContentions).toBe(1);
      expect(readdirSync(admissionDirectory)).toEqual([]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("settles only an exact-live admission owner in another process within a monotonic bound", async () => {
    const testState = state();
    let child: Awaited<
      ReturnType<typeof crossProcessAdmissionHolder>
    > | null = null;
    try {
      child = await crossProcessAdmissionHolder(
        testState,
        "reddit-main",
        750,
      );
      let exhausted: unknown;
      try {
        withSettledReadProjectionAuthAdmission(
          "reddit-main",
          testState.environment,
          () => "must-not-run",
          { maximumWaitMs: 20 },
        );
      } catch (error) {
        exhausted = error;
      }
      expect(exhausted).toBeInstanceOf(
        ReadProjectionAdmissionContentionError,
      );
      expect(exhausted).toMatchObject({
        authId: "reddit-main",
        reason: "settlement-exhausted",
      });

      expect(withSettledReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
        () => "settled",
        { maximumWaitMs: 2_000 },
      )).toBe("settled");
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      child = null;
    } finally {
      child?.kill();
      if (child !== null) await child.exited;
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects asynchronous and thenable admission operations before release", () => {
    const testState = state();
    try {
      expect(() => withReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
        async () => {
          await Promise.resolve();
          return "late";
        },
      )).toThrow("must be synchronous");
      expect(() => withReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
        () => ({ then: () => undefined }),
      )).toThrow("must be synchronous");

      const admission = acquireReadProjectionAuthAdmission(
        "reddit-main",
        testState.environment,
      );
      admission.release();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed on a corrupt incarnation while rotation and final removal recover it", () => {
    const testState = state();
    try {
      const exactAuthHash = "d".repeat(64);
      const first = projectionAuthIdentityHash(
        "reddit-main",
        exactAuthHash,
        testState.environment,
      );
      expect(first).not.toBe(exactAuthHash);
      expect(projectionAuthIdentityHash(
        "reddit-main",
        exactAuthHash,
        testState.environment,
      )).toBe(first);

      const incarnationDirectory = join(
        testState.directory,
        "read-projection-control",
        "incarnations",
      );
      const [incarnationName] = readdirSync(incarnationDirectory);
      if (incarnationName === undefined) throw new Error("expected incarnation");
      const incarnationPath = join(incarnationDirectory, incarnationName);
      writeFileSync(incarnationPath, "{\"corrupt\":true}\n", { mode: 0o600 });
      expect(() => projectionAuthIdentityHash(
        "reddit-main",
        exactAuthHash,
        testState.environment,
      )).toThrow("incarnation");

      const rotated = rotateReadProjectionAuthIncarnation(
        "reddit-main",
        testState.environment,
      );
      expect(rotated).toMatch(/^[a-f0-9]{64}$/u);
      const second = projectionAuthIdentityHash(
        "reddit-main",
        exactAuthHash,
        testState.environment,
      );
      expect(second).not.toBe(first);
      expect(removeReadProjectionAuthIncarnation(
        "reddit-main",
        testState.environment,
      )).toBeTrue();
      expect(removeReadProjectionAuthIncarnation(
        "reddit-main",
        testState.environment,
      )).toBeFalse();
      expect(projectionAuthIdentityHash(
        "reddit-main",
        exactAuthHash,
        testState.environment,
      )).not.toBe(second);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("publishes created, unchanged, and changed validations with explicit freshness", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      const firstOutput = {
        messages: [{ id: "t4_first", body: "hello" }],
        after: "t4_next",
      };
      const first = publishReadProjection(query, firstOutput, {
        environment: testState.environment,
        ...publicationOptions(
          1,
          "2026-07-31T12:00:00.000Z",
          "2026-07-31T12:00:01.000Z",
        ),
      });
      expect(first.disposition).toBe("created");

      const fresh = readReadProjection(query, {
        environment: testState.environment,
        now: new Date("2026-07-31T12:00:31.000Z"),
        freshForMs: 60_000,
      });
      expect(fresh).toMatchObject({
        status: "hit",
        source: "cache",
        output: firstOutput,
        dataRevision: first.dataRevision,
        createdAt: "2026-07-31T12:00:01.000Z",
        dataChangedAt: "2026-07-31T12:00:01.000Z",
        validatedAt: "2026-07-31T12:00:01.000Z",
        ageMs: 30_000,
        freshness: { state: "fresh", freshForMs: 60_000 },
      });

      const unchanged = publishReadProjection(query, firstOutput, {
        environment: testState.environment,
        ...publicationOptions(
          2,
          "2026-07-31T12:05:00.000Z",
          "2026-07-31T12:05:01.000Z",
        ),
      });
      expect(unchanged).toMatchObject({
        disposition: "unchanged",
        dataRevision: first.dataRevision,
        dataChangedAt: first.dataChangedAt,
        validatedAt: "2026-07-31T12:05:01.000Z",
      });

      const changedOutput = {
        messages: [
          { id: "t4_first", body: "hello" },
          { id: "t4_second", body: "new" },
        ],
        after: null,
      };
      const changed = publishReadProjection(query, changedOutput, {
        environment: testState.environment,
        ...publicationOptions(
          3,
          "2026-07-31T12:10:00.000Z",
          "2026-07-31T12:10:01.000Z",
        ),
      });
      expect(changed.disposition).toBe("changed");
      expect(changed.dataRevision).not.toBe(first.dataRevision);
      expect(readReadProjection(query, {
        environment: testState.environment,
        now: new Date("2026-07-31T12:11:01.001Z"),
        freshForMs: 60_000,
      })).toMatchObject({
        status: "hit",
        output: changedOutput,
        dataRevision: changed.dataRevision,
        dataChangedAt: "2026-07-31T12:10:01.000Z",
        validatedAt: "2026-07-31T12:10:01.000Z",
        freshness: { state: "stale", freshForMs: 60_000 },
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("does not let an older validation roll the published head backward", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      const current = publishReadProjection(query, { messages: ["new"] }, {
        environment: testState.environment,
        ...publicationOptions(
          8,
          "2026-07-31T12:08:00.000Z",
          "2026-07-31T12:08:01.000Z",
        ),
      });
      const older = publishReadProjection(query, { messages: ["old"] }, {
        environment: testState.environment,
        ...publicationOptions(
          7,
          "2026-07-31T12:07:00.000Z",
          "2026-07-31T12:07:01.000Z",
        ),
      });
      expect(older.disposition).toBe("superseded");
      expect(older.currentDataRevision).toBe(current.dataRevision);
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["new"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps a later-start winner reader-valid when it finished earlier", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["earlier-start"] }, {
        environment: testState.environment,
        ...publicationOptions(
          30,
          "2026-07-31T16:00:00.000Z",
          "2026-07-31T16:10:00.000Z",
        ),
      });
      const winner = publishReadProjection(
        query,
        { messages: ["later-start-earlier-finish"] },
        {
          environment: testState.environment,
          ...publicationOptions(
            31,
            "2026-07-31T16:05:00.000Z",
            "2026-07-31T16:06:00.000Z",
          ),
        },
      );
      expect(winner).toMatchObject({
        disposition: "changed",
        dataChangedAt: "2026-07-31T16:06:00.000Z",
        validatedAt: "2026-07-31T16:06:00.000Z",
      });
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({
          status: "hit",
          output: { messages: ["later-start-earlier-finish"] },
          createdAt: "2026-07-31T16:06:00.000Z",
          dataChangedAt: "2026-07-31T16:06:00.000Z",
          validatedAt: "2026-07-31T16:06:00.000Z",
        });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects sparse, decorated, accessor, symbol, and schema-extra data", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      const sparse: unknown[] = [];
      sparse.length = 1;
      const extraArray: unknown[] = ["value"];
      Object.defineProperty(extraArray, "extra", {
        value: true,
        enumerable: true,
      });
      let getterCalls = 0;
      const accessorArray: unknown[] = [];
      Object.defineProperty(accessorArray, "0", {
        get: () => {
          getterCalls += 1;
          return "secret";
        },
        enumerable: true,
      });
      accessorArray.length = 1;
      const symbolArray: unknown[] = ["value"];
      Object.defineProperty(symbolArray, Symbol("hidden"), {
        value: true,
        enumerable: true,
      });
      const accessorObject: Record<string, unknown> = {};
      Object.defineProperty(accessorObject, "secret", {
        get: () => {
          getterCalls += 1;
          return "secret";
        },
        enumerable: true,
      });
      const hiddenObject: Record<string, unknown> = { visible: true };
      Object.defineProperty(hiddenObject, "hidden", {
        value: true,
        enumerable: false,
      });
      const symbolObject: Record<string, unknown> = { visible: true };
      Object.defineProperty(symbolObject, Symbol("hidden"), {
        value: true,
        enumerable: true,
      });
      for (const [index, output] of [
        sparse,
        extraArray,
        accessorArray,
        symbolArray,
        accessorObject,
        hiddenObject,
        symbolObject,
      ].entries()) {
        expect(() => publishReadProjection(query, output, {
          environment: testState.environment,
          ...publicationOptions(
            40 + index,
            "2026-07-31T17:00:00.000Z",
            "2026-07-31T17:00:01.000Z",
          ),
        })).toThrow();
      }
      expect(getterCalls).toBe(0);

      const extraIdentity = { ...identity(), unsupported: true };
      expect(() => createReadProjectionQuery(
        extraIdentity as ReadProjectionQueryIdentity,
        testState.environment,
      )).toThrow("unsupported fields");
      const symbolIdentity = identity() as ReadProjectionQueryIdentity & {
        [key: symbol]: unknown;
      };
      Object.defineProperty(symbolIdentity, Symbol("hidden"), {
        value: true,
        enumerable: true,
      });
      expect(() => createReadProjectionQuery(
        symbolIdentity,
        testState.environment,
      )).toThrow("symbol fields");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("round-trips a multi-chunk result larger than the helper request ceiling without plaintext at rest", () => {
    const testState = state();
    try {
      const queryIdentity = identity({
        input: { folder: "inbox", cursor: "private-cursor-fixture" },
      });
      const query = createReadProjectionQuery(queryIdentity, testState.environment);
      const privateBody = `private-message-fixture-${"x".repeat(4_600_000)}`;
      const output = {
        messages: [{ id: "private-message-id", body: privateBody }],
        nextCursor: "private-next-cursor",
      };
      publishReadProjection(query, output, {
        environment: testState.environment,
        ...publicationOptions(
          10,
          "2026-07-31T13:00:00.000Z",
          "2026-07-31T13:00:01.000Z",
        ),
      });
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output });

      const files = allFiles(testState.directory);
      expect(files.filter((path) => path.includes("chunk--")).length)
        .toBeGreaterThan(3);
      for (const path of files) {
        const contents = readFileSync(path, "utf8");
        expect(contents).not.toContain("private-message-fixture");
        expect(contents).not.toContain("private-message-id");
        expect(contents).not.toContain("private-cursor-fixture");
        expect(contents).not.toContain("reddit:t2_example");
        expect(lstatSync(path).mode & 0o777).toBe(0o600);
      }
      expect(lstatSync(join(testState.directory, "read-projections")).mode & 0o777)
        .toBe(0o700);
      expect(lstatSync(join(testState.directory, ".projection-encryption-key")).mode & 0o777)
        .toBe(0o600);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reclaims crash-orphan immutable revision files before publication", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["first"] }, {
        environment: testState.environment,
        ...publicationOptions(
          50,
          "2026-07-31T18:00:00.000Z",
          "2026-07-31T18:00:01.000Z",
        ),
      });
      const queryDirectory = join(
        testState.directory,
        "read-projections",
        query.realmKey,
        query.key,
      );
      const orphanId = randomUUID().replaceAll("-", "");
      const orphanManifest = join(
        queryDirectory,
        `manifest--${orphanId}.json`,
      );
      const orphanChunk = join(
        queryDirectory,
        `chunk--${orphanId}--000.json`,
      );
      writeFileSync(orphanManifest, "{}\n", { mode: 0o600 });
      writeFileSync(orphanChunk, "{}\n", { mode: 0o600 });

      publishReadProjection(query, { messages: ["second"] }, {
        environment: testState.environment,
        ...publicationOptions(
          51,
          "2026-07-31T18:01:00.000Z",
          "2026-07-31T18:01:01.000Z",
        ),
      });
      expect(existsSync(orphanManifest)).toBeFalse();
      expect(existsSync(orphanChunk)).toBeFalse();
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["second"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reclaims a definitely dead valid head mutation claim before publication", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["first"] }, {
        environment: testState.environment,
        ...publicationOptions(
          54,
          "2026-07-31T18:04:00.000Z",
          "2026-07-31T18:04:01.000Z",
        ),
      });
      const queryDirectory = projectionDirectory(testState, query);
      const targetSha256 = sha256("io-state-mutation\0head.json");
      const claimId = "11111111-1111-4111-8111-111111111111";
      const claimPath = join(
        queryDirectory,
        `.io-mutation-${targetSha256}-held-${claimId}.lock`,
      );
      writeFileSync(
        claimPath,
        `${JSON.stringify({
          kind: "io-state-mutation-claim",
          schemaVersion: 1,
          targetSha256,
          claimId,
          pid: 999_999_999,
          bootId: "0".repeat(64),
          processStartId: "0".repeat(64),
        })}\n`,
        { mode: 0o600 },
      );

      publishReadProjection(query, { messages: ["second"] }, {
        environment: testState.environment,
        ...publicationOptions(
          55,
          "2026-07-31T18:05:00.000Z",
          "2026-07-31T18:05:01.000Z",
        ),
      });
      expect(existsSync(claimPath)).toBeFalse();
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["second"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reclaims a canonical mutation stage only for a provably dead owner", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["first"] }, {
        environment: testState.environment,
        ...publicationOptions(
          56,
          "2026-07-31T18:06:00.000Z",
          "2026-07-31T18:06:01.000Z",
        ),
      });
      const queryDirectory = projectionDirectory(testState, query);
      const targetSha256 = sha256("io-state-mutation\0head.json");
      const claimId = "33333333-3333-4333-8333-333333333333";
      const pid = 999_999_999;
      const stagePath = join(
        queryDirectory,
        `.io-mutation-stage-${claimId}-${pid}.tmp`,
      );
      writeFileSync(
        stagePath,
        `${JSON.stringify({
          kind: "io-state-mutation-claim",
          schemaVersion: 1,
          targetSha256,
          claimId,
          pid,
          bootId: "0".repeat(64),
          processStartId: "0".repeat(64),
        })}\n`,
        { mode: 0o600 },
      );

      publishReadProjection(query, { messages: ["second"] }, {
        environment: testState.environment,
        ...publicationOptions(
          57,
          "2026-07-31T18:07:00.000Z",
          "2026-07-31T18:07:01.000Z",
        ),
      });
      expect(existsSync(stagePath)).toBeFalse();
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["second"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reclaims stable empty and partial mutation stages after their owner exits", async () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["first"] }, {
        environment: testState.environment,
        ...publicationOptions(
          156,
          "2026-07-31T18:16:00.000Z",
          "2026-07-31T18:16:01.000Z",
        ),
      });
      const queryDirectory = projectionDirectory(testState, query);
      const deadPid = await exitedPid();
      const emptyStagePath = join(
        queryDirectory,
        `.io-mutation-stage-88888888-8888-4888-8888-888888888888-${deadPid}.tmp`,
      );
      const partialStagePath = join(
        queryDirectory,
        `.io-mutation-stage-99999999-9999-4999-8999-999999999999-${deadPid}.tmp`,
      );
      writeFileSync(emptyStagePath, "", { mode: 0o600 });
      writeFileSync(partialStagePath, '{"kind":', { mode: 0o600 });

      publishReadProjection(query, { messages: ["second"] }, {
        environment: testState.environment,
        ...publicationOptions(
          157,
          "2026-07-31T18:17:00.000Z",
          "2026-07-31T18:17:01.000Z",
        ),
      });
      expect(existsSync(emptyStagePath)).toBeFalse();
      expect(existsSync(partialStagePath)).toBeFalse();
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["second"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("preserves live and malformed mutation stages and fails closed", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["current"] }, {
        environment: testState.environment,
        ...publicationOptions(
          58,
          "2026-07-31T18:08:00.000Z",
          "2026-07-31T18:08:01.000Z",
        ),
      });
      const queryDirectory = projectionDirectory(testState, query);
      const targetSha256 = sha256("io-state-mutation\0head.json");
      const liveClaimId = "44444444-4444-4444-8444-444444444444";
      const liveStagePath = join(
        queryDirectory,
        `.io-mutation-stage-${liveClaimId}-${process.pid}.tmp`,
      );
      writeFileSync(
        liveStagePath,
        `${JSON.stringify({
          kind: "io-state-mutation-claim",
          schemaVersion: 1,
          targetSha256,
          claimId: liveClaimId,
          pid: process.pid,
          ...currentProcessStartIdentity(),
        })}\n`,
        { mode: 0o600 },
      );
      const malformedClaimId = "55555555-5555-4555-8555-555555555555";
      const malformedStagePath = join(
        queryDirectory,
        `.io-mutation-stage-${malformedClaimId}-${process.pid}.tmp`,
      );
      writeFileSync(malformedStagePath, "{}\n", { mode: 0o600 });

      expect(() => publishReadProjection(query, { messages: ["blocked"] }, {
        environment: testState.environment,
        ...publicationOptions(
          59,
          "2026-07-31T18:09:00.000Z",
          "2026-07-31T18:09:01.000Z",
        ),
      })).toThrow("unsupported state");
      expect(existsSync(liveStagePath)).toBeTrue();
      expect(existsSync(malformedStagePath)).toBeTrue();
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["current"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("checks the prospective query entry bound before immutable writes", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["current"] }, {
        environment: testState.environment,
        ...publicationOptions(
          52,
          "2026-07-31T18:02:00.000Z",
          "2026-07-31T18:02:01.000Z",
        ),
      });
      const queryDirectory = join(
        testState.directory,
        "read-projections",
        query.realmKey,
        query.key,
      );
      for (let index = 0; index < 44; index += 1) {
        writeFileSync(
          join(queryDirectory, `unsupported-${String(index).padStart(3, "0")}`),
          "bounded\n",
          { mode: 0o600 },
        );
      }
      const before = readdirSync(queryDirectory).sort();
      expect(() => publishReadProjection(query, { messages: ["next"] }, {
        environment: testState.environment,
        ...publicationOptions(
          53,
          "2026-07-31T18:03:00.000Z",
          "2026-07-31T18:03:01.000Z",
        ),
      })).toThrow("prospective entry bound");
      expect(readdirSync(queryDirectory).sort()).toEqual(before);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("skips a busy sibling when evicting at the 32-query bound", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      const realmDirectory = join(
        testState.directory,
        "read-projections",
        query.realmKey,
      );
      mkdirSync(realmDirectory, { recursive: true, mode: 0o700 });
      const siblingNames = Array.from(
        { length: 32 },
        (_, index) => (index + 1).toString(16).padStart(64, "0"),
      ).filter((name) => name !== query.key);
      while (siblingNames.length < 32) {
        siblingNames.push((siblingNames.length + 100).toString(16).padStart(64, "0"));
      }
      for (const name of siblingNames) {
        mkdirSync(join(realmDirectory, name), { mode: 0o700 });
      }
      const sortedSiblings = [...siblingNames].sort();
      const busySibling = sortedSiblings[0];
      const expectedEviction = sortedSiblings[1];
      if (busySibling === undefined || expectedEviction === undefined) {
        throw new Error("expected quota siblings");
      }
      const targetSha256 = sha256("io-state-mutation\0unrelated.json");
      const claimId = "66666666-6666-4666-8666-666666666666";
      const busyClaimPath = join(
        realmDirectory,
        busySibling,
        `.io-mutation-${targetSha256}-held-${claimId}.lock`,
      );
      writeFileSync(
        busyClaimPath,
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

      publishReadProjection(query, { messages: ["target"] }, {
        environment: testState.environment,
        ...publicationOptions(
          62,
          "2026-07-31T19:02:00.000Z",
          "2026-07-31T19:02:01.000Z",
        ),
      });
      expect(existsSync(join(realmDirectory, expectedEviction))).toBeFalse();
      expect(existsSync(join(realmDirectory, busySibling))).toBeTrue();
      expect(existsSync(busyClaimPath)).toBeTrue();
      expect(existsSync(projectionDirectory(testState, query))).toBeTrue();
      expect(readdirSync(realmDirectory)).toHaveLength(32);
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["target"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("enforces exact serialized byte quota without evicting the target", () => {
    const calibration = state();
    const output = { messages: ["quota-target"] };
    const firstOptions = publicationOptions(
      63,
      "2026-07-31T19:03:00.000Z",
      "2026-07-31T19:03:01.000Z",
    );
    let artifactBytes: number;
    try {
      const query = createReadProjectionQuery(identity(), calibration.environment);
      publishReadProjection(query, output, {
        environment: calibration.environment,
        ...firstOptions,
      });
      artifactBytes = directoryBytes(projectionDirectory(calibration, query));
    } finally {
      rmSync(calibration.directory, { recursive: true, force: true });
    }

    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      const realmDirectory = join(
        testState.directory,
        "read-projections",
        query.realmKey,
      );
      mkdirSync(realmDirectory, { recursive: true, mode: 0o700 });
      const siblingNames = ["0".repeat(64), "f".repeat(64)]
        .map((name, index) => name === query.key
          ? `${String(index + 1)}${"e".repeat(63)}`
          : name)
        .sort();
      const siblingDirectories = siblingNames.map((name) => {
        const directory = join(realmDirectory, name);
        mkdirSync(directory, { mode: 0o700 });
        return directory;
      });
      const quotaBytes = 128 * 1024 * 1024;
      expect(artifactBytes).toBeGreaterThan(0);
      expect(artifactBytes).toBeLessThan(2 * 1024 * 1024);
      const lastFixture = writeSparsePrivateFiles(
        siblingDirectories,
        quotaBytes - artifactBytes,
      );

      publishReadProjection(query, output, {
        environment: testState.environment,
        ...firstOptions,
      });
      expect(siblingDirectories.every((directory) => existsSync(directory)))
        .toBeTrue();
      expect(directoryBytes(projectionDirectory(testState, query)))
        .toBe(artifactBytes);

      truncateSync(lastFixture.path, statSync(lastFixture.path).size + 1);
      publishReadProjection(query, { messages: ["quota-updated"] }, {
        environment: testState.environment,
        ...publicationOptions(
          64,
          "2026-07-31T19:04:00.000Z",
          "2026-07-31T19:04:01.000Z",
        ),
      });
      expect(existsSync(siblingDirectories[0]!)).toBeFalse();
      expect(existsSync(siblingDirectories[1]!)).toBeTrue();
      expect(existsSync(projectionDirectory(testState, query))).toBeTrue();
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({
          status: "hit",
          output: { messages: ["quota-updated"] },
        });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("classifies exact corruption, repairs by CAS, and keeps key failures distinct", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: [{ body: "secret" }] }, {
        environment: testState.environment,
        ...publicationOptions(
          11,
          "2026-07-31T14:00:00.000Z",
          "2026-07-31T14:00:01.000Z",
        ),
      });
      const chunkPath = allFiles(testState.directory).find((path) => path.includes("chunk--"));
      if (chunkPath === undefined) throw new Error("expected encrypted chunk");
      const chunk = JSON.parse(readFileSync(chunkPath, "utf8")) as Record<string, unknown>;
      const ciphertext = String(chunk.ciphertext);
      chunk.ciphertext = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
      writeFileSync(chunkPath, `${canonicalJson(chunk)}\n`, { mode: 0o600 });
      const corruptionError = captureCorruption(() => {
        readReadProjection(query, { environment: testState.environment });
      });
      expect(corruptionError).toBeInstanceOf(ReadProjectionCorruptionError);
      expect(corruptionError).toMatchObject({
        message: "read projection chunk does not match its manifest",
      });

      const repaired = repairReadProjection(
        query,
        { messages: [{ body: "repaired" }] },
        {
          environment: testState.environment,
          ...publicationOptions(
            12,
            "2026-07-31T14:01:00.000Z",
            "2026-07-31T14:01:01.000Z",
          ),
          corruption: corruptionError,
          observedBeforeLive: true,
        },
      );
      expect(repaired.disposition).toBe("changed");
      expect(existsSync(chunkPath)).toBeFalse();
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({
          status: "hit",
          output: { messages: [{ body: "repaired" }] },
        });

      rmSync(join(testState.directory, ".projection-encryption-key"));
      let keyError: unknown;
      try {
        readReadProjection(query, { environment: testState.environment });
      } catch (error) {
        keyError = error;
      }
      expect(keyError).toBeInstanceOf(Error);
      expect(keyError).not.toBeInstanceOf(ReadProjectionCorruptionError);
      expect(keyError instanceof Error ? keyError.message : "").toContain(
        "key is unavailable while encrypted read projections exist",
      );
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("classifies and repairs an oversized exact head only from unchanged pre-live evidence", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["before"] }, {
        environment: testState.environment,
        ...publicationOptions(
          70,
          "2026-07-31T20:00:00.000Z",
          "2026-07-31T20:00:01.000Z",
        ),
      });
      const headPath = join(
        testState.directory,
        "read-projections",
        query.realmKey,
        query.key,
        "head.json",
      );
      const oversizedHead = `${"x".repeat(2 * 1024 * 1024)}\n`;
      expect(Buffer.byteLength(oversizedHead, "utf8"))
        .toBe(2 * 1024 * 1024 + 1);
      writeFileSync(headPath, oversizedHead, { mode: 0o600 });
      const observed = captureCorruption(() => readReadProjection(query, {
        environment: testState.environment,
      }));
      expect(observed).toMatchObject({
        message: "read projection head exceeds its byte bound",
        queryKey: query.key,
        realmKey: query.realmKey,
        headPublication: null,
      });

      expect(() => repairReadProjection(query, { messages: ["after"] }, {
        environment: testState.environment,
        ...publicationOptions(
          71,
          "2026-07-31T20:01:00.000Z",
          "2026-07-31T20:01:01.000Z",
        ),
        corruption: observed,
        observedBeforeLive: false,
      })).toThrow("was not observed before the live read");
      expect(readFileSync(headPath, "utf8")).toBe(oversizedHead);

      const repaired = repairReadProjection(query, { messages: ["after"] }, {
        environment: testState.environment,
        ...publicationOptions(
          71,
          "2026-07-31T20:01:00.000Z",
          "2026-07-31T20:01:01.000Z",
        ),
        corruption: observed,
        observedBeforeLive: true,
      });
      expect(repaired.disposition).toBe("changed");
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["after"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("repairs attributable manifest and chunk corruption above 2 MiB", () => {
    for (const [index, artifact] of ["manifest", "chunk"].entries()) {
      const testState = state();
      try {
        const query = createReadProjectionQuery(identity(), testState.environment);
        publishReadProjection(query, { messages: ["before"] }, {
          environment: testState.environment,
          ...publicationOptions(
            74 + index * 2,
            `2026-07-31T20:${String(4 + index * 2).padStart(2, "0")}:00.000Z`,
            `2026-07-31T20:${String(4 + index * 2).padStart(2, "0")}:01.000Z`,
          ),
        });
        const queryDirectory = projectionDirectory(testState, query);
        const artifactPath = allFiles(queryDirectory).find((path) =>
          path.includes(`${artifact}--`));
        if (artifactPath === undefined) {
          throw new Error(`expected projection ${artifact}`);
        }
        const oversized = `${"x".repeat(2 * 1024 * 1024)}\n`;
        writeFileSync(artifactPath, oversized, { mode: 0o600 });
        const observed = captureCorruption(() => readReadProjection(query, {
          environment: testState.environment,
        }));
        expect(observed.message).toContain(
          artifact === "manifest"
            ? "manifest exceeds its byte bound"
            : "chunk 0 exceeds its byte bound",
        );

        const repaired = repairReadProjection(query, {
          messages: [`after-${artifact}`],
        }, {
          environment: testState.environment,
          ...publicationOptions(
            75 + index * 2,
            `2026-07-31T20:${String(5 + index * 2).padStart(2, "0")}:00.000Z`,
            `2026-07-31T20:${String(5 + index * 2).padStart(2, "0")}:01.000Z`,
          ),
          corruption: observed,
          observedBeforeLive: false,
        });
        expect(repaired.disposition).toBe("changed");
        expect(existsSync(artifactPath)).toBeFalse();
        expect(readReadProjection(query, { environment: testState.environment }))
          .toMatchObject({
            status: "hit",
            output: { messages: [`after-${artifact}`] },
          });
      } finally {
        rmSync(testState.directory, { recursive: true, force: true });
      }
    }
  });

  test("repairs invalid UTF-8 in an owned head, manifest, or chunk", () => {
    for (const [index, artifact] of ["head", "manifest", "chunk"].entries()) {
      const testState = state();
      try {
        const query = createReadProjectionQuery(identity(), testState.environment);
        publishReadProjection(query, { messages: ["before"] }, {
          environment: testState.environment,
          ...publicationOptions(
            180 + index * 2,
            `2026-07-31T21:${String(index * 2).padStart(2, "0")}:00.000Z`,
            `2026-07-31T21:${String(index * 2).padStart(2, "0")}:01.000Z`,
          ),
        });
        const queryDirectory = projectionDirectory(testState, query);
        const artifactPath = artifact === "head"
          ? join(queryDirectory, "head.json")
          : allFiles(queryDirectory).find((path) =>
              path.includes(`${artifact}--`));
        if (artifactPath === undefined) {
          throw new Error(`expected projection ${artifact}`);
        }
        writeFileSync(artifactPath, Uint8Array.of(0xff), { mode: 0o600 });

        const observed = captureCorruption(() => readReadProjection(query, {
          environment: testState.environment,
        }));
        expect(observed.message).toContain(
          artifact === "chunk"
            ? "read projection chunk does not match its manifest"
            : `read projection ${artifact} is not valid UTF-8`,
        );

        const repaired = repairReadProjection(query, {
          messages: [`after-${artifact}`],
        }, {
          environment: testState.environment,
          ...publicationOptions(
            181 + index * 2,
            `2026-07-31T21:${String(index * 2 + 1).padStart(2, "0")}:00.000Z`,
            `2026-07-31T21:${String(index * 2 + 1).padStart(2, "0")}:01.000Z`,
          ),
          corruption: observed,
          observedBeforeLive: artifact === "head",
        });
        expect(repaired.disposition).toBe("changed");
        if (artifact === "head") {
          expect(readFileSync(artifactPath).equals(Buffer.from([0xff])))
            .toBeFalse();
        } else {
          expect(existsSync(artifactPath)).toBeFalse();
        }
        expect(readReadProjection(query, { environment: testState.environment }))
          .toMatchObject({
            status: "hit",
            output: { messages: [`after-${artifact}`] },
          });
      } finally {
        rmSync(testState.directory, { recursive: true, force: true });
      }
    }
  });

  test("never reclaims a live non-head mutation claim after durable repair", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["before"] }, {
        environment: testState.environment,
        ...publicationOptions(
          72,
          "2026-07-31T20:02:00.000Z",
          "2026-07-31T20:02:01.000Z",
        ),
      });
      const queryDirectory = projectionDirectory(testState, query);
      const chunkPath = allFiles(queryDirectory).find((path) =>
        path.includes("chunk--"));
      if (chunkPath === undefined) throw new Error("expected encrypted chunk");
      writeFileSync(chunkPath, "{}\n", { mode: 0o600 });
      const observed = captureCorruption(() => readReadProjection(query, {
        environment: testState.environment,
      }));

      const targetSha256 = sha256("io-state-mutation\0unrelated.json");
      const claimId = "22222222-2222-4222-8222-222222222222";
      const claimPath = join(
        queryDirectory,
        `.io-mutation-${targetSha256}-held-${claimId}.lock`,
      );
      const processIdentity = currentProcessStartIdentity();
      writeFileSync(
        claimPath,
        `${JSON.stringify({
          kind: "io-state-mutation-claim",
          schemaVersion: 1,
          targetSha256,
          claimId,
          pid: process.pid,
          ...processIdentity,
        })}\n`,
        { mode: 0o600 },
      );

      const durableError = captureDurableRepair(() => repairReadProjection(
        query,
        { messages: ["after"] },
        {
          environment: testState.environment,
          ...publicationOptions(
            73,
            "2026-07-31T20:03:00.000Z",
            "2026-07-31T20:03:01.000Z",
          ),
          corruption: observed,
          observedBeforeLive: false,
        },
      ));
      expect(durableError).toMatchObject({
        durableRepair: true,
        headIsAuthoritative: true,
        queryKey: query.key,
        publication: { disposition: "changed", key: query.key },
      });
      expect(durableError.cause).toBeInstanceOf(Error);
      expect(durableError.cause instanceof Error
        ? durableError.cause.message
        : "")
        .toContain("in-flight state-helper artifact prevents reclamation");
      expect(existsSync(claimPath)).toBeTrue();
      expect(existsSync(chunkPath)).toBeTrue();
      expect(readReadProjection(query, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { messages: ["after"] } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("does not let an older live result repair over a newer corrupt publication", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      const current = publishReadProjection(query, { messages: ["newer"] }, {
        environment: testState.environment,
        ...publicationOptions(
          80,
          "2026-07-31T20:10:00.000Z",
          "2026-07-31T20:10:01.000Z",
        ),
      });
      const queryDirectory = join(
        testState.directory,
        "read-projections",
        query.realmKey,
        query.key,
      );
      const headPath = join(queryDirectory, "head.json");
      const chunkPath = allFiles(queryDirectory).find((path) =>
        path.includes("chunk--"));
      if (chunkPath === undefined) throw new Error("expected encrypted chunk");
      writeFileSync(chunkPath, "{}\n", { mode: 0o600 });
      const observed = captureCorruption(() => readReadProjection(query, {
        environment: testState.environment,
      }));
      expect(observed.headPublication).toMatchObject({
        dataRevision: current.dataRevision,
        startedAt: "2026-07-31T20:10:00.000Z",
      });
      const originalHead = readFileSync(headPath, "utf8");

      const older = repairReadProjection(query, { messages: ["older"] }, {
        environment: testState.environment,
        ...publicationOptions(
          79,
          "2026-07-31T20:09:00.000Z",
          "2026-07-31T20:09:01.000Z",
        ),
        corruption: observed,
        observedBeforeLive: false,
      });
      expect(older).toMatchObject({
        disposition: "superseded",
        dataRevision: current.dataRevision,
        currentDataRevision: current.dataRevision,
      });
      expect(readFileSync(headPath, "utf8")).toBe(originalHead);
      expect(() => readReadProjection(query, {
        environment: testState.environment,
      })).toThrow(ReadProjectionCorruptionError);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses repair when the exact corrupt head changed after observation", () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["before"] }, {
        environment: testState.environment,
        ...publicationOptions(
          90,
          "2026-07-31T20:20:00.000Z",
          "2026-07-31T20:20:01.000Z",
        ),
      });
      const headPath = join(
        testState.directory,
        "read-projections",
        query.realmKey,
        query.key,
        "head.json",
      );
      writeFileSync(headPath, "{\"corrupt\":\"first\"}\n", { mode: 0o600 });
      const observed = captureCorruption(() => readReadProjection(query, {
        environment: testState.environment,
      }));
      const changedHead = "{\"corrupt\":\"second\"}\n";
      writeFileSync(headPath, changedHead, { mode: 0o600 });

      expect(() => repairReadProjection(query, { messages: ["after"] }, {
        environment: testState.environment,
        ...publicationOptions(
          91,
          "2026-07-31T20:21:00.000Z",
          "2026-07-31T20:21:01.000Z",
        ),
        corruption: observed,
        observedBeforeLive: true,
      })).toThrow("corrupt head changed after the repair observation");
      expect(readFileSync(headPath, "utf8")).toBe(changedHead);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("removes all exact queries for one auth locator without touching another", () => {
    const testState = state();
    try {
      const first = createReadProjectionQuery(identity(), testState.environment);
      const second = createReadProjectionQuery(identity({
        input: { folder: "sent", limit: 25 },
      }), testState.environment);
      const other = createReadProjectionQuery(identity({
        auth: { ...identity().auth, id: "reddit-alt" },
      }), testState.environment);
      for (const [index, query] of [first, second, other].entries()) {
        publishReadProjection(query, { query: index }, {
          environment: testState.environment,
          ...publicationOptions(
            20 + index,
            `2026-07-31T15:0${index}:00.000Z`,
            `2026-07-31T15:0${index}:01.000Z`,
          ),
        });
      }
      const markerBefore = readFileSync(
        projectionStoreKeyMarkerPath(testState),
        "utf8",
      );
      expect(removeReadProjectionsForAuth("reddit-main", testState.environment)).toBeTrue();
      expect(readFileSync(
        projectionStoreKeyMarkerPath(testState),
        "utf8",
      )).toBe(markerBefore);
      expect(readReadProjection(first, { environment: testState.environment }).status).toBe("miss");
      expect(readReadProjection(second, { environment: testState.environment }).status).toBe("miss");
      expect(readReadProjection(other, { environment: testState.environment }))
        .toMatchObject({ status: "hit", output: { query: 2 } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reclaims only a definitely dead state-helper removal quarantine", async () => {
    const testState = state();
    try {
      const query = createReadProjectionQuery(identity(), testState.environment);
      publishReadProjection(query, { messages: ["private"] }, {
        environment: testState.environment,
        ...publicationOptions(
          60,
          "2026-07-31T19:00:00.000Z",
          "2026-07-31T19:00:01.000Z",
        ),
      });
      const storeDirectory = join(testState.directory, "read-projections");
      const realmDirectory = join(storeDirectory, query.realmKey);
      const deadPid = await exitedPid();
      const deadQuarantine = join(
        storeDirectory,
        `.io-remove-tree-${deadPid}-${Date.now()}-${randomUUID().replaceAll("-", "")}.quarantine`,
      );
      renameSync(realmDirectory, deadQuarantine);
      expect(removeReadProjectionsForAuth(
        "reddit-main",
        testState.environment,
      )).toBeFalse();
      expect(existsSync(deadQuarantine)).toBeFalse();

      publishReadProjection(query, { messages: ["replacement"] }, {
        environment: testState.environment,
        ...publicationOptions(
          61,
          "2026-07-31T19:01:00.000Z",
          "2026-07-31T19:01:01.000Z",
        ),
      });
      const liveQuarantine = join(
        storeDirectory,
        `.io-remove-tree-${process.pid}-${Date.now()}-${randomUUID().replaceAll("-", "")}.quarantine`,
      );
      renameSync(realmDirectory, liveQuarantine);
      expect(removeReadProjectionsForAuth(
        "reddit-main",
        testState.environment,
      )).toBeFalse();
      expect(existsSync(liveQuarantine)).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
