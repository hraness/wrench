import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256 } from "./canonical-json";
import { currentProcessStartIdentity } from "./process-identity";
import {
  ReadProjectionCorruptionError,
  createOmniProjectionQuery,
  createReadProjectionQuery,
  publishReadProjection,
  readOmniProjection,
  readReadProjection,
  readReadProjectionForMaterialization,
  reduceOmniProjection,
  removeReadProjectionsForAuth,
  type OmniProjectionQuery,
  type ReadProjectionQuery,
  type ReadProjectionQueryIdentity,
} from "./read-projections";

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

function state(): TestState {
  const directory = mkdtempSync(join(tmpdir(), "wrench-omni-projection-test-"));
  chmodSync(directory, 0o700);
  return Object.freeze({
    directory,
    environment: Object.freeze({ WRENCH_STATE_HOME: directory }),
  });
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
    operation: "omni.message.list",
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

function exactPublicationOptions(index: number) {
  return {
    runId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    startedAt: `2026-08-01T12:${String(index).padStart(2, "0")}:00.000Z`,
    finishedAt: `2026-08-01T12:${String(index).padStart(2, "0")}:01.000Z`,
  } as const;
}

function queryDirectory(
  testState: TestState,
  query: Readonly<{ readonly realmKey: string; readonly key: string }>,
  storageClass: "exact-v1" | "omni-v1",
): string {
  return join(
    testState.directory,
    storageClass === "exact-v1"
      ? "read-projections"
      : "omni-read-projections",
    query.realmKey,
    query.key,
  );
}

function realmDirectory(
  testState: TestState,
  query: Readonly<{ readonly realmKey: string }>,
  storageClass: "exact-v1" | "omni-v1",
): string {
  return join(
    testState.directory,
    storageClass === "exact-v1"
      ? "read-projections"
      : "omni-read-projections",
    query.realmKey,
  );
}

function hmac(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function fillRealmToBound(directory: string, preserved: readonly string[]): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const names = new Set(readdirSync(directory));
  for (const name of preserved) names.add(name);
  for (let index = 0; names.size < 32; index += 1) {
    const name = index.toString(16).padStart(64, "0");
    if (names.has(name)) continue;
    mkdirSync(join(directory, name), { mode: 0o700 });
    names.add(name);
  }
}

function createBusyInvalidSibling(directory: string, queryKey: string): string {
  const name = queryKey === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
  const sibling = join(directory, name);
  mkdirSync(sibling, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 49; index += 1) {
    writeFileSync(
      join(sibling, `unsupported-${String(index).padStart(3, "0")}`),
      "bounded\n",
      { mode: 0o600 },
    );
  }
  const targetSha256 = sha256("io-state-mutation\0unrelated.json");
  const claimId = "77777777-7777-4777-8777-777777777777";
  writeFileSync(
    join(sibling, `.io-mutation-${targetSha256}-held-${claimId}.lock`),
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
  return sibling;
}

function headBytes(
  testState: TestState,
  query: OmniProjectionQuery,
): Buffer {
  return readFileSync(join(queryDirectory(testState, query, "omni-v1"), "head.json"));
}

function currentOutput(
  testState: TestState,
  query: OmniProjectionQuery,
): unknown {
  const result = readOmniProjection(query, {
    environment: testState.environment,
  });
  if (result.status !== "hit") throw new Error("expected current omni projection");
  return result.output;
}

describe("omni read projections", () => {
  test("keeps exact-v1 query derivation and disk shape stable", () => {
    const testState = state();
    try {
      const queryIdentity = identity({ operation: "messaging.list" });
      const exact = createReadProjectionQuery(queryIdentity, testState.environment);
      const keyRecord = JSON.parse(
        readFileSync(join(testState.directory, ".projection-encryption-key"), "utf8"),
      ) as { readonly key: string };
      const key = Buffer.from(keyRecord.key, "hex");

      expect(Object.keys(exact).sort()).toEqual(["identity", "key", "realmKey"]);
      expect(exact.key).toBe(hmac(
        key,
        "wrench-read-projection-query-v1",
        canonicalJson(exact.identity),
      ));
      expect(exact.realmKey).toBe(hmac(
        key,
        "wrench-read-projection-realm-v1",
        exact.identity.auth.id,
      ));

      publishReadProjection(exact, { messages: ["exact"] }, {
        environment: testState.environment,
        ...exactPublicationOptions(1),
      });
      expect(existsSync(queryDirectory(testState, exact, "exact-v1"))).toBeTrue();

      const omni = createOmniProjectionQuery(queryIdentity, testState.environment);
      expect(Object.keys(omni).sort()).toEqual([
        "identity",
        "key",
        "realmKey",
        "storageClass",
      ]);
      expect(omni.storageClass).toBe("omni-v1");
      expect(omni.key).not.toBe(exact.key);
      expect(omni.realmKey).not.toBe(exact.realmKey);
      expect(omni.key).toBe(hmac(
        key,
        "wrench-omni-projection-query-v1",
        canonicalJson(omni.identity),
      ));
      expect(omni.realmKey).toBe(hmac(
        key,
        "wrench-omni-projection-realm-v1",
        omni.identity.auth.id,
      ));
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("publishes immutable reducer results by aggregate mutation order", () => {
    const testState = state();
    try {
      const query = createOmniProjectionQuery(identity(), testState.environment);
      expect(readOmniProjection(query, { environment: testState.environment }))
        .toEqual({ status: "miss", key: query.key });

      const created = reduceOmniProjection(
        query,
        (current) => {
          expect(current).toBeNull();
          return { messages: [{ id: "a" }] };
        },
        {
          environment: testState.environment,
          now: new Date("2026-08-01T13:00:00.000Z"),
        },
      );
      expect(created.publication.disposition).toBe("created");
      expect(created.publication).toMatchObject({
        dataRevision: created.current.dataRevision,
        storageRevisionId: created.current.storageRevisionId,
        runId: created.current.runId,
        startedAt: "2026-08-01T13:00:00.000Z",
        finishedAt: "2026-08-01T13:00:00.000Z",
      });
      expect(created.current).toMatchObject({
        key: query.key,
        output: { messages: [{ id: "a" }] },
        createdAt: "2026-08-01T13:00:00.000Z",
        dataChangedAt: "2026-08-01T13:00:00.000Z",
        validatedAt: "2026-08-01T13:00:00.000Z",
        startedAt: "2026-08-01T13:00:00.000Z",
        finishedAt: "2026-08-01T13:00:00.000Z",
      });
      expect(Object.isFrozen(created.current)).toBeTrue();
      expect(Object.isFrozen(created.current.output)).toBeTrue();
      expect(Object.isFrozen(
        (created.current.output as { readonly messages: unknown[] }).messages,
      )).toBeTrue();

      const changed = reduceOmniProjection(
        query,
        (current) => {
          expect(Object.isFrozen(current)).toBeTrue();
          const value = current as { readonly messages: readonly { readonly id: string }[] };
          expect(Object.isFrozen(value.messages)).toBeTrue();
          return { messages: [...value.messages, { id: "b" }] };
        },
        {
          environment: testState.environment,
          now: new Date("2026-08-01T12:00:00.000Z"),
        },
      );
      expect(changed.publication.disposition).toBe("changed");
      expect(changed.current.validatedAt).toBe("2026-08-01T13:00:00.001Z");
      expect(changed.current.createdAt).toBe(created.current.createdAt);
      expect(changed.current.storageRevisionId)
        .not.toBe(created.current.storageRevisionId);
      expect(changed.publication.storageRevisionId)
        .toBe(changed.current.storageRevisionId);
      expect(changed.current.output).toEqual({
        messages: [{ id: "a" }, { id: "b" }],
      });

      const observed = readOmniProjection(query, {
        environment: testState.environment,
        now: new Date("2026-08-01T13:00:01.001Z"),
      });
      expect(observed).toMatchObject({
        status: "hit",
        dataRevision: changed.current.dataRevision,
        storageRevisionId: changed.current.storageRevisionId,
        runId: changed.current.runId,
        startedAt: changed.current.startedAt,
        finishedAt: changed.current.finishedAt,
      });

      const beforeUnchanged = headBytes(testState, query);
      const unchanged = reduceOmniProjection(
        query,
        (current) => current,
        {
          environment: testState.environment,
          now: new Date("2026-08-01T14:00:00.000Z"),
        },
      );
      expect(unchanged.publication.disposition).toBe("unchanged");
      expect(unchanged.publication.storageRevisionId)
        .toBe(changed.current.storageRevisionId);
      expect(unchanged.current.validatedAt).toBe(changed.current.validatedAt);
      expect(headBytes(testState, query)).toEqual(beforeUnchanged);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("isolates exact and omni realm quotas and eviction", () => {
    const testState = state();
    try {
      const exact = createReadProjectionQuery(
        identity({ operation: "messaging.list" }),
        testState.environment,
      );
      publishReadProjection(exact, { messages: ["exact-a"] }, {
        environment: testState.environment,
        ...exactPublicationOptions(2),
      });
      const omni = createOmniProjectionQuery(identity(), testState.environment);
      reduceOmniProjection(omni, () => ({ messages: ["omni-a"] }), {
        environment: testState.environment,
        now: new Date("2026-08-01T13:02:00.000Z"),
      });

      const exactRealm = realmDirectory(testState, exact, "exact-v1");
      const omniRealm = realmDirectory(testState, omni, "omni-v1");
      fillRealmToBound(exactRealm, [exact.key]);
      fillRealmToBound(omniRealm, [omni.key]);

      const omniBeforeExactEviction = readdirSync(omniRealm).sort();
      const exactNext = createReadProjectionQuery(
        identity({
          operation: "messaging.list",
          input: { folder: "archive", limit: 25 },
          inputHash: sha256(canonicalJson({ folder: "archive", limit: 25 })),
        }),
        testState.environment,
      );
      publishReadProjection(exactNext, { messages: ["exact-b"] }, {
        environment: testState.environment,
        ...exactPublicationOptions(3),
      });
      expect(readdirSync(exactRealm)).toHaveLength(32);
      expect(readdirSync(omniRealm).sort()).toEqual(omniBeforeExactEviction);

      const exactAfterExactEviction = readdirSync(exactRealm).sort();
      const omniInput = { folder: "archive", limit: 25 };
      const omniNext = createOmniProjectionQuery(
        identity({
          input: omniInput,
          inputHash: sha256(canonicalJson(omniInput)),
        }),
        testState.environment,
      );
      reduceOmniProjection(omniNext, () => ({ messages: ["omni-b"] }), {
        environment: testState.environment,
        now: new Date("2026-08-01T13:03:00.000Z"),
      });
      expect(readdirSync(omniRealm)).toHaveLength(32);
      expect(readdirSync(exactRealm).sort()).toEqual(exactAfterExactEviction);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("serializes disjoint reducers across processes without losing either change", async () => {
    const testState = state();
    try {
      const query = createOmniProjectionQuery(identity(), testState.environment);
      reduceOmniProjection(query, () => ({ byId: {} }), {
        environment: testState.environment,
        now: new Date("2026-08-01T13:10:00.000Z"),
      });
      const moduleUrl = pathToFileURL(join(import.meta.dir, "read-projections.ts")).href;
      const children = ["a", "b"].map((id) => Bun.spawn([
        process.execPath,
        "--eval",
        `
          const { reduceOmniProjection } = await import(${JSON.stringify(moduleUrl)});
          const query = JSON.parse(process.env.WRENCH_TEST_QUERY);
          const result = reduceOmniProjection(
            query,
            (current) => {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
              return { byId: { ...current.byId, [process.env.WRENCH_TEST_ID]: true } };
            },
            { environment: process.env },
          );
          console.log(JSON.stringify(result.publication));
        `,
      ], {
        env: {
          ...process.env,
          WRENCH_STATE_HOME: testState.directory,
          WRENCH_TEST_QUERY: JSON.stringify(query),
          WRENCH_TEST_ID: id,
        },
        stdout: "pipe",
        stderr: "pipe",
      }));
      const results = await Promise.all(children.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      }));
      for (const result of results) {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ disposition: "changed" });
      }
      expect(currentOutput(testState, query)).toEqual({
        byId: { a: true, b: true },
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("preserves the current head on reducer, bound, quota, and corruption failures", () => {
    const testState = state();
    try {
      const query = createOmniProjectionQuery(identity(), testState.environment);
      reduceOmniProjection(query, () => ({ messages: [{ id: "safe" }] }), {
        environment: testState.environment,
        now: new Date("2026-08-01T13:20:00.000Z"),
      });
      const originalHead = headBytes(testState, query);
      const originalOutput = currentOutput(testState, query);

      expect(() => reduceOmniProjection(query, () => {
        throw new Error("reducer failed");
      }, { environment: testState.environment })).toThrow("reducer failed");
      expect(headBytes(testState, query)).toEqual(originalHead);

      let reducerObserved = false;
      expect(() => reduceOmniProjection(query, () => {
        reducerObserved = true;
        return { messages: [{ id: "wrong-auth-lifetime" }] };
      }, {
        environment: testState.environment,
        assertCurrent: () => { throw new Error("auth lifetime changed"); },
      })).toThrow("auth lifetime changed");
      expect(reducerObserved).toBeFalse();
      expect(headBytes(testState, query)).toEqual(originalHead);

      const exact = createReadProjectionQuery(
        identity({ operation: "messaging.list" }),
        testState.environment,
      );
      publishReadProjection(exact, { messages: ["first"] }, {
        environment: testState.environment,
        ...exactPublicationOptions(6),
      });
      const interpreted = readReadProjectionForMaterialization(exact, {
        environment: testState.environment,
      });
      if (interpreted.status !== "hit") {
        throw new Error("expected exact projection fence fixture");
      }
      publishReadProjection(exact, { messages: ["replacement"] }, {
        environment: testState.environment,
        ...exactPublicationOptions(7),
      });
      let staleReducerObserved = false;
      expect(() => reduceOmniProjection(query, () => {
        staleReducerObserved = true;
        return { messages: [{ id: "stale-exact-head" }] };
      }, {
        environment: testState.environment,
        exactHead: {
          query: exact,
          storageRevisionId: interpreted.storageRevisionId,
          dataRevision: interpreted.dataRevision,
          runId: interpreted.runId,
        },
      })).toThrow("exact projection changed before normalized publication");
      expect(staleReducerObserved).toBeFalse();
      expect(headBytes(testState, query)).toEqual(originalHead);

      expect(() => reduceOmniProjection(
        query,
        () => ({ value: "x".repeat(16 * 1024 * 1024) }),
        { environment: testState.environment },
      )).toThrow("byte bound");
      expect(headBytes(testState, query)).toEqual(originalHead);

      const omniRealm = realmDirectory(testState, query, "omni-v1");
      const busySibling = createBusyInvalidSibling(omniRealm, query.key);
      expect(() => reduceOmniProjection(
        query,
        () => ({ messages: [{ id: "quota-attempt" }] }),
        { environment: testState.environment },
      )).toThrow("bounded storage quota");
      expect(headBytes(testState, query)).toEqual(originalHead);
      expect(currentOutput(testState, query)).toEqual(originalOutput);
      rmSync(busySibling, { recursive: true, force: true });

      const directory = queryDirectory(testState, query, "omni-v1");
      const headPath = join(directory, "head.json");
      const corruptedHead = Buffer.from(originalHead);
      corruptedHead[0] = corruptedHead[0] === 0x7b ? 0x5b : 0x7b;
      writeFileSync(headPath, corruptedHead, { mode: 0o600 });
      let invoked = false;
      let captured: unknown;
      try {
        reduceOmniProjection(query, () => {
          invoked = true;
          return { messages: [] };
        }, { environment: testState.environment });
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(ReadProjectionCorruptionError);
      expect((captured as ReadProjectionCorruptionError).storageClass).toBe("omni-v1");
      expect(invoked).toBeFalse();
      expect(readFileSync(headPath)).toEqual(corruptedHead);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects promises and thenables without replacing the current value", () => {
    const testState = state();
    try {
      const query = createOmniProjectionQuery(identity(), testState.environment);
      reduceOmniProjection(query, () => ({ messages: ["safe"] }), {
        environment: testState.environment,
      });
      const originalHead = headBytes(testState, query);

      expect(() => reduceOmniProjection(
        query,
        () => Promise.resolve({ messages: ["async"] }),
        { environment: testState.environment },
      )).toThrow("must not return promises or thenables");
      expect(headBytes(testState, query)).toEqual(originalHead);

      let getterInvoked = false;
      const thenable = Object.defineProperty({}, "then", {
        enumerable: true,
        get() {
          getterInvoked = true;
          return () => undefined;
        },
      });
      expect(() => reduceOmniProjection(
        query,
        () => thenable,
        { environment: testState.environment },
      )).toThrow("must not return promises or thenables");
      expect(getterInvoked).toBeFalse();
      expect(headBytes(testState, query)).toEqual(originalHead);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects cross-class and prototype-forged query values", () => {
    const testState = state();
    try {
      const exact = createReadProjectionQuery(identity(), testState.environment);
      const omni = createOmniProjectionQuery(identity(), testState.environment);

      expect(() => reduceOmniProjection(
        exact as unknown as OmniProjectionQuery,
        () => ({}),
        { environment: testState.environment },
      )).toThrow("unsupported fields");
      expect(() => readReadProjection(
        omni as unknown as ReadProjectionQuery,
        { environment: testState.environment },
      )).toThrow("unsupported fields");
      expect(() => readOmniProjection(
        { ...omni, storageClass: "exact-v1" } as unknown as OmniProjectionQuery,
        { environment: testState.environment },
      )).toThrow("storage class is malformed");
      expect(() => readOmniProjection(
        Object.create(omni) as OmniProjectionQuery,
        { environment: testState.environment },
      )).toThrow("unsupported prototype");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("detects key loss from omni-only state and removes both classes by auth", () => {
    const cleanupState = state();
    try {
      const targetIdentity = identity();
      const exact = createReadProjectionQuery(
        { ...targetIdentity, operation: "messaging.list" },
        cleanupState.environment,
      );
      const omni = createOmniProjectionQuery(targetIdentity, cleanupState.environment);
      const otherIdentity = identity({
        auth: {
          id: "reddit-other",
          kind: "cookie-source",
          hash: "d".repeat(64),
          subject: "reddit:t2_other",
        },
      });
      const otherExact = createReadProjectionQuery(
        { ...otherIdentity, operation: "messaging.list" },
        cleanupState.environment,
      );
      const otherOmni = createOmniProjectionQuery(
        otherIdentity,
        cleanupState.environment,
      );
      publishReadProjection(exact, { value: "exact" }, {
        environment: cleanupState.environment,
        ...exactPublicationOptions(4),
      });
      publishReadProjection(otherExact, { value: "other-exact" }, {
        environment: cleanupState.environment,
        ...exactPublicationOptions(5),
      });
      reduceOmniProjection(omni, () => ({ value: "omni" }), {
        environment: cleanupState.environment,
      });
      reduceOmniProjection(otherOmni, () => ({ value: "other-omni" }), {
        environment: cleanupState.environment,
      });

      expect(removeReadProjectionsForAuth(
        "reddit-main",
        cleanupState.environment,
      )).toBeTrue();
      expect(readReadProjection(exact, { environment: cleanupState.environment }).status)
        .toBe("miss");
      expect(readOmniProjection(omni, { environment: cleanupState.environment }).status)
        .toBe("miss");
      expect(readReadProjection(otherExact, { environment: cleanupState.environment }).status)
        .toBe("hit");
      expect(readOmniProjection(otherOmni, { environment: cleanupState.environment }).status)
        .toBe("hit");
      expect(removeReadProjectionsForAuth(
        "reddit-main",
        cleanupState.environment,
      )).toBeFalse();
    } finally {
      rmSync(cleanupState.directory, { recursive: true, force: true });
    }

    const keyLossState = state();
    try {
      const queryIdentity = identity();
      const omni = createOmniProjectionQuery(queryIdentity, keyLossState.environment);
      reduceOmniProjection(omni, () => ({ value: "omni-only" }), {
        environment: keyLossState.environment,
      });
      rmSync(join(keyLossState.directory, ".projection-encryption-key"));

      expect(() => readOmniProjection(omni, {
        environment: keyLossState.environment,
      })).toThrow("encryption key is unavailable while encrypted read projections exist");
      expect(() => createOmniProjectionQuery(
        queryIdentity,
        keyLossState.environment,
      )).toThrow("encryption key is unavailable while encrypted read projections exist");
      expect(() => removeReadProjectionsForAuth(
        "reddit-main",
        keyLossState.environment,
      )).toThrow("encryption key is unavailable while encrypted read projections exist");
    } finally {
      rmSync(keyLossState.directory, { recursive: true, force: true });
    }
  });
});
