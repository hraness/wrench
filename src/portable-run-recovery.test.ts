import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { canonicalJson } from "./model";
import {
  parsePortableRunReconciliationInput,
  readPortableRunResolution,
  reconcilePortableProviderPluginRun,
} from "./portable-run-recovery";
import { createProviderPluginRegistry } from "./provider-plugin-registry";

const roots: string[] = [];
const runId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function environment(): Readonly<Record<string, string | undefined>> {
  const root = mkdtempSync(join(tmpdir(), "wrench-portable-recovery-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { ...process.env, WRENCH_STATE_HOME: root };
}

function resolution() {
  return {
    schemaVersion: 1,
    runId,
    resolvedAt: "2026-07-25T12:00:00.000Z",
    receiptHash: "1".repeat(64),
    planDigest: "2".repeat(64),
    adapterHash: "3".repeat(64),
    inputHash: "4".repeat(64),
    authHash: "5".repeat(64),
    contractHash: "6".repeat(64),
    portablePluginContract: {
      pluginId: "example-portable",
      pluginVersion: "1.2.3",
      hostApiVersion: 1,
      bundleSha256: "7".repeat(64),
      manifestSha256: "8".repeat(64),
      adapterId: "example-portable-web",
      transport: "web-session-api",
      surfaceId: "example-portable",
      operation: "likes.set",
      contractVersion: 1,
      descriptorSha256: "9".repeat(64),
    },
    outcome: "not-applied",
    evidenceHash: "a".repeat(64),
  } as const;
}

function writeResolution(
  value: unknown,
  environmentValue: Readonly<Record<string, string | undefined>>,
): string {
  const root = environmentValue.WRENCH_STATE_HOME;
  if (root === undefined) throw new Error("test WRENCH_STATE_HOME is unavailable");
  const recovery = join(root, "recovery");
  const directory = join(recovery, "portable-resolutions");
  mkdirSync(recovery, { mode: 0o700, recursive: true });
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const path = join(directory, `${runId}.json`);
  writeFileSync(path, `${canonicalJson(value)}\n`, { mode: 0o600 });
  return path;
}

test("parses only the exact frozen portable reconciliation observation", () => {
  const parsed = parsePortableRunReconciliationInput({
    outcome: "applied",
    evidenceHash: "a".repeat(64),
  });
  expect(parsed).toEqual({
    outcome: "applied",
    evidenceHash: "a".repeat(64),
  });
  expect(Object.isFrozen(parsed)).toBeTrue();

  for (const candidate of [
    null,
    [],
    { outcome: "unknown", evidenceHash: "a".repeat(64) },
    { outcome: "applied", evidenceHash: "A".repeat(64) },
    { outcome: "applied", evidenceHash: "a".repeat(63) },
    {
      outcome: "applied",
      evidenceHash: "a".repeat(64),
      result: "unsupported",
    },
    Object.assign(Object.create({ inherited: true }), {
      outcome: "applied",
      evidenceHash: "a".repeat(64),
    }),
  ]) {
    expect(() => parsePortableRunReconciliationInput(candidate)).toThrow();
  }

  const accessor = { outcome: "applied" };
  Object.defineProperty(accessor, "evidenceHash", {
    enumerable: true,
    get: () => {
      throw new Error("must not evaluate reconciliation accessors");
    },
  });
  expect(() => parsePortableRunReconciliationInput(accessor))
    .toThrow("unsupported accessor");
});

test("reads only a canonical resolution bound to its durable run coordinate", () => {
  const environmentValue = environment();
  const path = writeResolution(resolution(), environmentValue);
  expect(readPortableRunResolution(runId, environmentValue)).toEqual(
    resolution(),
  );

  writeFileSync(path, `${JSON.stringify(resolution(), null, 2)}\n`, {
    mode: 0o600,
  });
  expect(() => readPortableRunResolution(runId, environmentValue))
    .toThrow("durable coordinate");

  writeResolution({
    ...resolution(),
    runId: "22222222-2222-4222-8222-222222222222",
  }, environmentValue);
  expect(() => readPortableRunResolution(runId, environmentValue))
    .toThrow("durable coordinate");
});

test("rejects malformed run coordinates before touching local state", () => {
  const environmentValue = environment();
  expect(() => readPortableRunResolution("../private", environmentValue))
    .toThrow("run ID is malformed");
});

test("never releases a verified dispatch for retry", () => {
  const environmentValue = environment();
  const root = environmentValue.WRENCH_STATE_HOME;
  if (root === undefined) throw new Error("test WRENCH_STATE_HOME is unavailable");
  const runs = join(root, "runs");
  mkdirSync(runs, { mode: 0o700 });
  writeFileSync(join(runs, `${runId}.json`), `${canonicalJson({
    schemaVersion: 6,
    runId,
    planDigest: "1".repeat(64),
    adapter: {
      id: "example-portable-web",
      version: "1.0.0",
      hash: "2".repeat(64),
    },
    operation: "likes.set",
    risk: "R2",
    inputHash: "3".repeat(64),
    auth: {
      id: "example-auth",
      hash: "4".repeat(64),
      kind: "cookies-file",
    },
    transport: "portable-provider-plugin",
    status: "indeterminate",
    dispatchStarted: true,
    dispatch: { planned: 2, started: 1, verified: 1 },
    startedAt: "2026-07-25T12:00:00.000Z",
    finishedAt: "2026-07-25T12:00:01.000Z",
    finalOrigin: "https://example.com",
    error: "plugin failed after verifying the first dispatch",
    portablePluginContract: resolution().portablePluginContract,
  })}\n`, { mode: 0o600 });

  expect(() => reconcilePortableProviderPluginRun(
    runId,
    { outcome: "not-applied", evidenceHash: "b".repeat(64) },
    {
      environment: environmentValue,
      registry: createProviderPluginRegistry([]),
    },
  )).toThrow("verified dispatch");
  expect(readPortableRunResolution(runId, environmentValue)).toBeNull();
  expect(existsSync(join(root, "recovery", "portable-resolutions"))).toBeFalse();
});
