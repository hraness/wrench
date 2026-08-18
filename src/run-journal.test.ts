import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRunJournal,
  initialRunJournal,
  listRunJournalSnapshots,
  parseRunJournal,
  readRunJournal,
  runJournalNeedsRepair,
  transitionRunJournal,
  updateRunJournal,
  type RunJournal,
  type RunJournalContract,
  type RunJournalSnapshot,
} from "./run-journal";
import type { PortableOperationIdentityV1 } from "./provider-plugin-portable-identity";

const roots: string[] = [];
const startedAt = "2026-07-25T12:00:00.000Z";
const portableIdentity: PortableOperationIdentityV1 = Object.freeze({
  pluginId: "example-portable",
  pluginVersion: "1.2.3",
  hostApiVersion: 1,
  bundleSha256: "3".repeat(64),
  manifestSha256: "4".repeat(64),
  adapterId: "example-portable-web",
  transport: "web-session-api",
  surfaceId: "example-portable",
  operation: "likes.set",
  contractVersion: 7,
  descriptorSha256: "5".repeat(64),
});

function portableContract(
  identity: PortableOperationIdentityV1 = portableIdentity,
): RunJournalContract {
  return Object.freeze({
    transport: "portable-provider-plugin",
    identity,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function environment(): Readonly<Record<string, string | undefined>> {
  const root = mkdtempSync(join(tmpdir(), "wrench-run-journal-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { ...process.env, WRENCH_STATE_HOME: root };
}

function initial(overrides: {
  readonly plannedDispatches?: number;
  readonly hasPlanAssets?: boolean;
  readonly leaseUntil?: string;
  readonly contract?: RunJournalContract;
} = {}): RunJournal {
  return initialRunJournal({
    runId: "11111111-1111-4111-8111-111111111111",
    planDigest: "a".repeat(64),
    adapter: {
      id: "example-web",
      version: "1.0.0",
      hash: "b".repeat(64),
    },
    operation: "likes.set",
    risk: "R2",
    inputHash: "c".repeat(64),
    auth: {
      id: "example-main",
      hash: "d".repeat(64),
      kind: "cookies-file",
    },
    contract: overrides.contract ?? {
      transport: "web-session-api",
      hash: "e".repeat(64),
    },
    plannedDispatches: overrides.plannedDispatches ?? 2,
    hasPlanAssets: overrides.hasPlanAssets ?? true,
    owner: {
      pid: 1234,
      token: "22222222-2222-4222-8222-222222222222",
      bootId: "1".repeat(64),
      processStartId: "2".repeat(64),
      leaseUntil: overrides.leaseUntil ?? "2026-07-25T12:10:00.000Z",
    },
    startedAt,
    dedupeExpiresAt: "2026-07-26T12:00:00.000Z",
  });
}

function ready(journal = initial()): RunJournal {
  const consumed = transitionRunJournal(journal, {
    type: "confirmation-consumed",
    at: "2026-07-25T12:00:00.500Z",
  });
  const claimed = transitionRunJournal(consumed, {
    type: "ledger-claimed",
    ledgerRelativePath: `idempotency/ff/${"f".repeat(64)}.json`,
    at: "2026-07-25T12:00:01.000Z",
  });
  return transitionRunJournal(claimed, {
    type: "recovery-stored",
    at: "2026-07-25T12:00:02.000Z",
  });
}

function dispatch(
  journal: RunJournal,
  index: number,
  second: number,
): RunJournal {
  const started = transitionRunJournal(journal, {
    type: "dispatch-started",
    index,
    at: `2026-07-25T12:00:${String(second).padStart(2, "0")}.000Z`,
  });
  return transitionRunJournal(started, {
    type: "dispatch-verified",
    index,
    at: `2026-07-25T12:00:${String(second + 1).padStart(2, "0")}.000Z`,
  });
}

describe("run journal reducer", () => {
  test("models a complete two-dispatch write and derives cleanup intent", () => {
    let journal = ready();
    journal = dispatch(journal, 1, 3);
    journal = dispatch(journal, 2, 5);
    journal = transitionRunJournal(journal, {
      type: "finished",
      status: "submitted",
      finalOrigin: "https://example.com",
      error: null,
      at: "2026-07-25T12:00:07.000Z",
    });

    expect(journal).toMatchObject({
      revision: 8,
      phase: "terminal",
      status: "submitted",
      dispatch: { planned: 2, started: 2, verified: 2 },
      ledgerState: "succeeded",
      recoveryState: "released",
      assetState: "released",
    });
    expect(() => transitionRunJournal(journal, {
      type: "lease-renewed",
      leaseUntil: "2026-07-25T12:20:00.000Z",
      at: "2026-07-25T12:00:08.000Z",
    })).toThrow("terminal run journals cannot transition");
  });

  test("distinguishes safe pre-dispatch failure, explicit no-op, partial, and indeterminate", () => {
    const failed = transitionRunJournal(
      ready(initial({ hasPlanAssets: false })),
      {
      type: "finished",
      status: "failed",
      finalOrigin: null,
      error: "preflight failed",
      at: "2026-07-25T12:00:03.000Z",
      },
    );
    expect(failed).toMatchObject({
      ledgerState: "released",
      recoveryState: "released",
      assetState: "none",
    });

    const noOp = transitionRunJournal(ready(), {
      type: "finished",
      status: "succeeded",
      noOp: true,
      finalOrigin: "https://example.com",
      error: null,
      at: "2026-07-25T12:00:03.000Z",
    });
    expect(noOp.status).toBe("succeeded");

    const partial = transitionRunJournal(dispatch(ready(), 1, 3), {
      type: "finished",
      status: "partial",
      finalOrigin: "https://example.com",
      error: "second dispatch did not start",
      at: "2026-07-25T12:00:05.000Z",
    });
    expect(partial).toMatchObject({
      ledgerState: "partial",
      recoveryState: "retained",
      assetState: "retained",
    });

    const started = transitionRunJournal(ready(), {
      type: "dispatch-started",
      index: 1,
      at: "2026-07-25T12:00:03.000Z",
    });
    const indeterminate = transitionRunJournal(started, {
      type: "finished",
      status: "indeterminate",
      finalOrigin: null,
      error: "executor exited after dispatch start",
      at: "2026-07-25T12:00:04.000Z",
    });
    expect(indeterminate).toMatchObject({
      dispatch: { started: 1, verified: 0 },
      ledgerState: "indeterminate",
      recoveryState: "retained",
    });
  });

  test("releases the idempotency fence only for explicit not-applied evidence", () => {
    const started = transitionRunJournal(ready(), {
      type: "dispatch-started",
      index: 1,
      at: "2026-07-25T12:00:03.000Z",
    });
    const indeterminate = transitionRunJournal(started, {
      type: "finished",
      status: "indeterminate",
      finalOrigin: null,
      error: "outcome unknown",
      at: "2026-07-25T12:00:04.000Z",
    });
    const applied = transitionRunJournal(indeterminate, {
      type: "recovery-released",
      outcome: "applied",
      at: "2026-07-25T12:00:05.000Z",
    });
    expect(applied).toMatchObject({
      ledgerState: "indeterminate",
      recoveryState: "released",
      assetState: "released",
    });
    expect(() => transitionRunJournal(applied, {
      type: "recovery-released",
      outcome: "not-applied",
      at: "2026-07-25T12:00:05.000Z",
    })).toThrow("different reconciliation outcome");

    const notApplied = transitionRunJournal(indeterminate, {
      type: "recovery-released",
      outcome: "not-applied",
      at: "2026-07-25T12:00:05.000Z",
    });
    expect(notApplied).toMatchObject({
      ledgerState: "released",
      recoveryState: "released",
      assetState: "released",
    });
    expect(transitionRunJournal(notApplied, {
      type: "recovery-released",
      outcome: "not-applied",
      at: "2026-07-25T12:00:05.000Z",
    })).toEqual(notApplied);

    const verified = transitionRunJournal(dispatch(ready(), 1, 3), {
      type: "finished",
      status: "indeterminate",
      finalOrigin: "https://example.com",
      error: "plugin failed after verifying the dispatch",
      at: "2026-07-25T12:00:05.000Z",
    });
    expect(() => transitionRunJournal(verified, {
      type: "recovery-released",
      outcome: "not-applied",
      at: "2026-07-25T12:00:06.000Z",
    })).toThrow("verified dispatch");
  });

  test("elects one immutable duplicate successor without releasing source evidence", () => {
    const sourceInitial = parseRunJournal({
      ...initial({ plannedDispatches: 1 }),
      operation: "posts.publish",
      risk: "R3",
    });
    const started = transitionRunJournal(ready(sourceInitial), {
      type: "dispatch-started",
      index: 1,
      at: "2026-07-25T12:00:03.000Z",
    });
    const source = transitionRunJournal(started, {
      type: "finished",
      status: "indeterminate",
      finalOrigin: null,
      error: "provider outcome is uncertain",
      at: "2026-07-25T12:00:04.000Z",
    });
    const claimed = transitionRunJournal(source, {
      type: "duplicate-successor-claimed",
      intentHash: "9".repeat(64),
      runId: "33333333-3333-4333-8333-333333333333",
      at: "2026-07-25T12:00:05.000Z",
    });

    expect(claimed).toMatchObject({
      revision: source.revision + 1,
      updatedAt: source.updatedAt,
      status: "indeterminate",
      ledgerState: "indeterminate",
      recoveryState: "retained",
      assetState: "retained",
      duplicateSuccessor: {
        schemaVersion: 1,
        intentHash: "9".repeat(64),
        sourceRunId: source.runId,
        runId: "33333333-3333-4333-8333-333333333333",
        claimedAt: "2026-07-25T12:00:05.000Z",
      },
    });
    expect(parseRunJournal(JSON.parse(JSON.stringify(claimed)) as unknown))
      .toEqual(claimed);
    expect(() => parseRunJournal({
      ...claimed,
      duplicateSuccessor: {
        ...claimed.duplicateSuccessor!,
        runId: claimed.runId,
      },
    })).toThrow("contradictory source state");
    expect(() => parseRunJournal({
      ...claimed,
      duplicateSuccessor: {
        ...claimed.duplicateSuccessor!,
        claimedAt: "2026-07-25T12:00:03.000Z",
      },
    })).toThrow("contradictory source state");
    expect(() => transitionRunJournal(claimed, {
      type: "recovery-released",
      outcome: "applied",
      at: "2026-07-25T12:00:06.000Z",
    })).toThrow("duplicate successor intent was claimed");
    const reconciledFirst = transitionRunJournal(source, {
      type: "recovery-released",
      outcome: "not-applied",
      at: "2026-07-25T12:00:06.000Z",
    });
    expect(() => transitionRunJournal(reconciledFirst, {
      type: "duplicate-successor-claimed",
      intentHash: "9".repeat(64),
      runId: "33333333-3333-4333-8333-333333333333",
      at: "2026-07-25T12:00:07.000Z",
    })).toThrow("retained terminal indeterminate");
    expect(() => transitionRunJournal(claimed, {
      type: "duplicate-successor-claimed",
      intentHash: "8".repeat(64),
      runId: "44444444-4444-4444-8444-444444444444",
      at: "2026-07-25T12:00:06.000Z",
    })).toThrow("different duplicate successor");

    const childPrepared = initialRunJournal({
      runId: claimed.duplicateSuccessor!.runId,
      planDigest: "7".repeat(64),
      adapter: claimed.adapter,
      operation: "posts.publish",
      risk: "R3",
      inputHash: claimed.inputHash,
      auth: claimed.auth,
      contract: claimed.contract,
      duplicateIntent: {
        schemaVersion: 1,
        intentHash: claimed.duplicateSuccessor!.intentHash,
        sourceRunId: claimed.runId,
      },
      plannedDispatches: 1,
      hasPlanAssets: true,
      owner: claimed.owner,
      startedAt,
      dedupeExpiresAt: "2026-07-26T12:00:00.000Z",
    });
    const childReadyAtClaimCrash = ready(childPrepared);
    const repairedChild = transitionRunJournal(childReadyAtClaimCrash, {
      type: "finished",
      status: "failed",
      finalOrigin: null,
      error: "process exited after source claim and before dispatch start",
      at: "2026-07-25T12:00:06.000Z",
    });
    expect(repairedChild).toMatchObject({
      phase: "terminal",
      status: "failed",
      dispatch: { planned: 1, started: 0, verified: 0 },
      ledgerState: "released",
      recoveryState: "released",
      assetState: "released",
      duplicateIntent: childPrepared.duplicateIntent,
    });
    // The source election is intentionally fail-closed even if the child exits
    // in the tiny claim-to-dispatch-start window.
    expect(claimed).toEqual(parseRunJournal(JSON.parse(JSON.stringify(claimed)) as unknown));

    expect(() => initialRunJournal({
      ...{
        runId: "55555555-5555-4555-8555-555555555555",
        planDigest: "7".repeat(64),
        adapter: claimed.adapter,
        operation: "posts.publish" as const,
        risk: "R3" as const,
        inputHash: claimed.inputHash,
        auth: claimed.auth,
        contract: claimed.contract,
        plannedDispatches: 1,
        hasPlanAssets: false,
        owner: claimed.owner,
        startedAt,
        dedupeExpiresAt: "2026-07-26T12:00:00.000Z",
      },
      duplicateIntent: {
        schemaVersion: 1,
        intentHash: "9".repeat(64),
        sourceRunId: "55555555-5555-4555-8555-555555555555",
      },
    })).toThrow("contradictory successor state");
  });

  test("rejects skipped, duplicate, and contradictory progress", () => {
    const journal = ready();
    expect(() => transitionRunJournal(journal, {
      type: "dispatch-started",
      index: 2,
      at: "2026-07-25T12:00:03.000Z",
    })).toThrow("out of order");
    const started = transitionRunJournal(journal, {
      type: "dispatch-started",
      index: 1,
      at: "2026-07-25T12:00:03.000Z",
    });
    expect(() => transitionRunJournal(started, {
      type: "dispatch-started",
      index: 2,
      at: "2026-07-25T12:00:04.000Z",
    })).toThrow("out of order");
    expect(() => transitionRunJournal(started, {
      type: "finished",
      status: "failed",
      finalOrigin: null,
      error: "unsafe classification",
      at: "2026-07-25T12:00:04.000Z",
    })).toThrow("cannot finish as failed");
  });

  test("rejects extra fields and accessors without invoking them", () => {
    expect(() => parseRunJournal({
      ...initial(),
      unexpected: true,
    })).toThrow("unsupported fields");

    let invoked = false;
    const value: Record<string, unknown> = { ...initial() };
    Object.defineProperty(value, "error", {
      enumerable: true,
      get() {
        invoked = true;
        return null;
      },
    });
    expect(() => parseRunJournal(value)).toThrow("unsupported accessor");
    expect(invoked).toBeFalse();
  });

  test("enforces the dispatch ceiling before persistence", () => {
    expect(() => initial({ plannedDispatches: 26 })).toThrow(
      "run journal dispatch is malformed",
    );
  });

  test("retains one exact frozen portable identity through every transition", () => {
    const prepared = initial({ contract: portableContract() });
    const progressed = dispatch(ready(prepared), 1, 3);

    expect(prepared.contract).toEqual(portableContract());
    expect(progressed.contract).toEqual(portableContract());
    expect(Object.isFrozen(prepared.contract)).toBeTrue();
    expect(
      prepared.contract.transport === "portable-provider-plugin"
      && Object.isFrozen(prepared.contract.identity),
    ).toBeTrue();
    expect(
      progressed.contract.transport === "portable-provider-plugin"
      && Object.isFrozen(progressed.contract.identity),
    ).toBeTrue();
    expect(
      parseRunJournal(JSON.parse(JSON.stringify(progressed)) as unknown)
        .contract,
    ).toEqual(portableContract());
  });

  test("rejects portable identity extensions, accessors, and malformed tampering", () => {
    const base = initial({ contract: portableContract() });
    expect(() => parseRunJournal({
      ...base,
      contract: {
        transport: "portable-provider-plugin",
        identity: {
          ...portableIdentity,
          extension: true,
        },
      },
    })).toThrow("unsupported fields");
    expect(() => parseRunJournal({
      ...base,
      contract: {
        transport: "portable-provider-plugin",
        identity: {
          ...portableIdentity,
          descriptorSha256: "A".repeat(64),
        },
      },
    })).toThrow("malformed");

    let invoked = false;
    const identity: Record<string, unknown> = { ...portableIdentity };
    Object.defineProperty(identity, "descriptorSha256", {
      enumerable: true,
      get() {
        invoked = true;
        return "5".repeat(64);
      },
    });
    expect(() => parseRunJournal({
      ...base,
      contract: {
        transport: "portable-provider-plugin",
        identity,
      },
    })).toThrow("unsupported accessor");
    expect(invoked).toBeFalse();
  });
});

describe("run journal persistence", () => {
  test("uses content-hash CAS so a stale writer cannot replace newer progress", () => {
    const env = environment();
    const original = createRunJournal(initial(), env);
    const consumed = updateRunJournal(original, {
      type: "confirmation-consumed",
      at: "2026-07-25T12:00:00.500Z",
    }, env);
    const claimed = updateRunJournal(consumed, {
      type: "ledger-claimed",
      ledgerRelativePath: `idempotency/ff/${"f".repeat(64)}.json`,
      at: "2026-07-25T12:00:01.000Z",
    }, env);

    expect(() => updateRunJournal(consumed, {
      type: "ledger-claimed",
      ledgerRelativePath: `idempotency/ff/${"e".repeat(64)}.json`,
      at: "2026-07-25T12:00:01.000Z",
    }, env)).toThrow("changed concurrently");
    expect(readRunJournal(original.journal.runId, env)).toEqual(claimed);
  });

  test("stores no operation input or secret-bearing material", () => {
    const env = environment();
    const created = createRunJournal(initial(), env);
    const root = env.WRENCH_STATE_HOME as string;
    const raw = readFileSync(
      join(root, "run-journals", `${created.journal.runId}.json`),
      "utf8",
    );
    expect(raw).not.toContain("access-token-canary");
    expect(raw).not.toContain("\"input\"");
    expect(raw).toContain(`"inputHash":"${"c".repeat(64)}"`);
  });

  test("repairs only terminally unowned or expired nonterminal journals", () => {
    const active = initial({ leaseUntil: "2026-07-25T12:10:00.000Z" });
    expect(runJournalNeedsRepair(
      active,
      new Date("2026-07-25T12:05:00.000Z"),
      () => "exact-live-owner",
    )).toBeFalse();
    expect(runJournalNeedsRepair(
      active,
      new Date("2026-07-25T12:05:00.000Z"),
      () => "different-or-dead",
    )).toBeTrue();
    expect(runJournalNeedsRepair(
      active,
      new Date("2026-07-25T12:10:00.000Z"),
      () => "exact-live-owner",
    )).toBeFalse();

    const terminal = transitionRunJournal(ready(), {
      type: "finished",
      status: "failed",
      finalOrigin: null,
      error: "preflight failed",
      at: "2026-07-25T12:00:03.000Z",
    });
    expect(runJournalNeedsRepair(
      terminal,
      new Date("2026-07-25T12:20:00.000Z"),
      () => "different-or-dead",
    )).toBeFalse();
  });

  test("returns exact persisted snapshots", () => {
    const env = environment();
    const created: RunJournalSnapshot = createRunJournal(initial(), env);
    expect(readRunJournal(created.journal.runId, env)).toEqual(created);
  });

  test("binds journal CAS to the exact persisted UTF-8 bytes", () => {
    const env = environment();
    const created = createRunJournal(initial(), env);
    const path = join(
      env.WRENCH_STATE_HOME as string,
      "run-journals",
      `${created.journal.runId}.json`,
    );
    const padded = ` \n\t${readFileSync(path, "utf8")}`;
    writeFileSync(path, padded, { mode: 0o600 });

    const rebound = readRunJournal(created.journal.runId, env);
    expect(rebound).not.toBeNull();
    if (rebound === null) throw new Error("run journal disappeared");
    expect(rebound.contentSha256).toBe(
      createHash("sha256").update(Buffer.from(padded, "utf8")).digest("hex"),
    );
    expect(rebound.contentSha256).not.toBe(created.contentSha256);
    const updated = updateRunJournal(rebound, {
      type: "confirmation-consumed",
      at: "2026-07-25T12:00:00.500Z",
    }, env);
    expect(updated.journal.revision).toBe(1);
  });

  test("binds snapshot hashes to the complete portable identity", () => {
    const first = createRunJournal(
      initial({ contract: portableContract() }),
      environment(),
    );
    const second = createRunJournal(
      initial({
        contract: portableContract(Object.freeze({
          ...portableIdentity,
          bundleSha256: "6".repeat(64),
        })),
      }),
      environment(),
    );

    expect(first.contentSha256).not.toBe(second.contentSha256);
    expect(first.journal.contract).toEqual(portableContract());
    expect(
      first.journal.contract.transport === "portable-provider-plugin"
      && Object.isFrozen(first.journal.contract.identity),
    ).toBeTrue();
  });

  test("batch-lists exact snapshots and marks malformed journals inert", () => {
    const env = environment();
    const created = createRunJournal(initial(), env);
    const invalidRunId = "22222222-2222-4222-8222-222222222222";
    writeFileSync(
      join(
        env.WRENCH_STATE_HOME as string,
        "run-journals",
        `${invalidRunId}.json`,
      ),
      "private malformed journal\n",
      { mode: 0o600 },
    );

    const listed = listRunJournalSnapshots(env);
    expect(listed).toContainEqual(created);
    expect(listed).toContainEqual({ runId: invalidRunId, invalid: true });
    expect(JSON.stringify(listed)).not.toContain("private malformed journal");
  });
});
