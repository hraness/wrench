import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { canonicalJson } from "./model";
import {
  LINKED_DEVICE_LIFECYCLE_JOURNAL_STATE_DIRECTORY,
  classifyLinkedDeviceLifecycleRestart,
  createLinkedDeviceLifecycleJournal,
  createLinkedDeviceLifecycleOwner,
  initialLinkedDeviceLifecycleJournal,
  listLinkedDeviceLifecycleJournalSnapshots,
  parseLinkedDeviceLifecycleJournal,
  readLinkedDeviceLifecycleJournal,
  repairInterruptedLinkedDeviceLifecycleJournal,
  transitionLinkedDeviceLifecycleJournal,
  updateLinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleOwner,
} from "./linked-device-lifecycle-journal";

const FIRST_JOURNAL_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_JOURNAL_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_TOKEN = "33333333-3333-4333-8333-333333333333";
const SECOND_TOKEN = "44444444-4444-4444-8444-444444444444";
const START = "2026-07-25T12:00:00.000Z";
const PAIR_AUTH_CONTENT_HASH = "8".repeat(64);

function at(seconds: number): string {
  return new Date(Date.parse(START) + seconds * 1_000).toISOString();
}

function owner(
  pid = 1_001,
  token = FIRST_TOKEN,
  leaseUntil = at(600),
): LinkedDeviceLifecycleOwner {
  return {
    pid,
    token,
    bootId: "a".repeat(64),
    processStartId: createHash("sha256")
      .update(`process:${pid}`)
      .digest("hex"),
    leaseUntil,
  };
}

function initial(
  kind: "pair" | "sync-once" = "pair",
  journalId = FIRST_JOURNAL_ID,
  journalOwner = owner(),
): LinkedDeviceLifecycleJournal {
  return initialLinkedDeviceLifecycleJournal({
    journalId,
    kind,
    pluginId: "whatsapp-linked-device",
    pluginVersion: "1.2.3",
    pluginImplementationHash: "9".repeat(64),
    lifecycleContractVersion: 1,
    surfaceId: "whatsapp",
    authId: "whatsapp-main",
    authRealmHash: "b".repeat(64),
    authContentHash: "c".repeat(64),
    initialSubjectState: kind === "pair" ? "unbound" : "bound",
    phoneProvided: kind === "pair",
    owner: journalOwner,
    startedAt: START,
  });
}

function withState(
  callback: (
    environment: Readonly<Record<string, string | undefined>>,
    stateRoot: string,
  ) => void,
): void {
  const temporary = mkdtempSync(join(tmpdir(), "wrench-linked-lifecycle-test-"));
  const stateRoot = join(temporary, "state");
  try {
    callback({ WRENCH_STATE_HOME: stateRoot }, stateRoot);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe("linked-device lifecycle journal state machine", () => {
  test("records one pair boundary, result, and local commit monotonically", () => {
    const prepared = initial();
    const begun = transitionLinkedDeviceLifecycleJournal(prepared, {
      type: "external-begin",
      at: at(1),
    });
    const completed = transitionLinkedDeviceLifecycleJournal(begun, {
      type: "external-complete",
      result: {
        kind: "pair",
        resultingAuthContentHash: PAIR_AUTH_CONTENT_HASH,
      },
      at: at(2),
    });
    expect(() => transitionLinkedDeviceLifecycleJournal(completed, {
      type: "committed",
      result: {
        kind: "pair",
        resultingAuthContentHash: "7".repeat(64),
      },
      at: at(3),
    })).toThrow("does not match");
    const committed = transitionLinkedDeviceLifecycleJournal(completed, {
      type: "committed",
      result: completed.result!,
      at: at(3),
    });

    expect([
      prepared.revision,
      begun.revision,
      completed.revision,
      committed.revision,
    ]).toEqual([0, 1, 2, 3]);
    expect(committed).toMatchObject({
      phase: "terminal",
      status: "succeeded",
      reconciliation: "not-required",
      externalStartedAt: at(1),
      externalCompletedAt: at(2),
      finishedAt: at(3),
      result: {
        kind: "pair",
        resultingAuthContentHash: PAIR_AUTH_CONTENT_HASH,
      },
      reasonCode: null,
    });
    expect(
      parseLinkedDeviceLifecycleJournal(
        JSON.parse(JSON.stringify(committed)) as unknown,
      ),
    ).toEqual(committed);
    expect(() => transitionLinkedDeviceLifecycleJournal(committed, {
      type: "committed",
      result: committed.result!,
      at: at(4),
    })).toThrow("only after external completion");
  });

  test("keeps every post-begin failure indeterminate until read-only reconciliation", () => {
    const begun = transitionLinkedDeviceLifecycleJournal(initial("sync-once"), {
      type: "external-begin",
      at: at(1),
    });
    const indeterminate = transitionLinkedDeviceLifecycleJournal(begun, {
      type: "outcome-not-durable",
      reasonCode: "runtime-error-after-begin",
      at: at(2),
    });
    expect(indeterminate).toMatchObject({
      phase: "terminal",
      status: "indeterminate",
      reconciliation: "required",
    });
    expect(() => transitionLinkedDeviceLifecycleJournal(indeterminate, {
      type: "aborted-before-external",
      reasonCode: "cancelled-before-begin",
      at: at(3),
    })).toThrow("only before external begin");

    const retryable = transitionLinkedDeviceLifecycleJournal(indeterminate, {
      type: "reconciled",
      outcome: "not-applied",
      evidenceHash: "d".repeat(64),
      at: at(4),
    });
    expect(retryable).toMatchObject({
      phase: "terminal",
      status: "safe-retry",
      reconciliation: "resolved-not-applied",
      reconciliationHash: "d".repeat(64),
      reconciledAt: at(4),
      result: null,
    });

    const returnedBeforePersistence =
      transitionLinkedDeviceLifecycleJournal(begun, {
        type: "outcome-not-durable",
        reasonCode: "external-returned-before-completion-persisted",
        at: at(2),
      });
    expect(() => transitionLinkedDeviceLifecycleJournal(
      returnedBeforePersistence,
      {
        type: "reconciled",
        outcome: "not-applied",
        evidenceHash: "e".repeat(64),
        at: at(4),
      },
    )).toThrow("contradicts durable external completion");

    const returnedWithoutDurableBegin =
      transitionLinkedDeviceLifecycleJournal(initial("pair"), {
        type: "outcome-not-durable",
        reasonCode: "external-returned-before-completion-persisted",
        at: at(1),
      });
    expect(returnedWithoutDurableBegin).toMatchObject({
      revision: 1,
      phase: "terminal",
      status: "indeterminate",
      reconciliation: "required",
      externalStartedAt: at(1),
      externalCompletedAt: null,
      result: null,
      reasonCode: "external-returned-before-completion-persisted",
    });
    expect(() => transitionLinkedDeviceLifecycleJournal(
      returnedWithoutDurableBegin,
      {
        type: "reconciled",
        outcome: "not-applied",
        evidenceHash: "f".repeat(64),
        at: at(4),
      },
    )).toThrow("contradicts durable external completion");
  });

  test("requires applied reconciliation to agree with a completed result", () => {
    const begun = transitionLinkedDeviceLifecycleJournal(initial("sync-once"), {
      type: "external-begin",
      at: at(1),
    });
    const completed = transitionLinkedDeviceLifecycleJournal(begun, {
      type: "external-complete",
      result: {
        kind: "sync",
        itemsStored: 12,
        projection: "linked-device-local-store",
        emitsProtocolAcknowledgements: true,
      },
      at: at(2),
    });
    const indeterminate = transitionLinkedDeviceLifecycleJournal(completed, {
      type: "outcome-not-durable",
      reasonCode: "runtime-error-after-begin",
      at: at(3),
    });
    expect(() => transitionLinkedDeviceLifecycleJournal(indeterminate, {
      type: "reconciled",
      outcome: "not-applied",
      evidenceHash: "f".repeat(64),
      at: at(4),
    })).toThrow("contradicts durable external completion");
    expect(indeterminate.result).toEqual(completed.result);
    expect(() => transitionLinkedDeviceLifecycleJournal(indeterminate, {
      type: "reconciled",
      outcome: "applied",
      evidenceHash: "e".repeat(64),
      result: {
        kind: "sync",
        itemsStored: 13,
        projection: "linked-device-local-store",
        emitsProtocolAcknowledgements: true,
      },
      at: at(4),
    })).toThrow("contradicts the previously completed result");
    const resolved = transitionLinkedDeviceLifecycleJournal(indeterminate, {
      type: "reconciled",
      outcome: "applied",
      evidenceHash: "e".repeat(64),
      result: completed.result!,
      at: at(4),
    });
    expect(resolved.status).toBe("succeeded");
    expect(resolved.reconciliation).toBe("resolved-applied");
  });

  test("never erases a completed pair result with not-applied evidence", () => {
    const begun = transitionLinkedDeviceLifecycleJournal(initial("pair"), {
      type: "external-begin",
      at: at(1),
    });
    const completed = transitionLinkedDeviceLifecycleJournal(begun, {
      type: "external-complete",
      result: {
        kind: "pair",
        resultingAuthContentHash: PAIR_AUTH_CONTENT_HASH,
      },
      at: at(2),
    });
    const indeterminate = transitionLinkedDeviceLifecycleJournal(completed, {
      type: "outcome-not-durable",
      reasonCode: "runtime-error-after-begin",
      at: at(3),
    });

    expect(() => transitionLinkedDeviceLifecycleJournal(indeterminate, {
      type: "reconciled",
      outcome: "not-applied",
      evidenceHash: "f".repeat(64),
      at: at(4),
    })).toThrow("contradicts durable external completion");
    expect(indeterminate.result).toEqual({
      kind: "pair",
      resultingAuthContentHash: PAIR_AUTH_CONTENT_HASH,
    });
  });

  test("classifies restart repair from owner liveness and the durable begin boundary", () => {
    const prepared = initial();
    const begun = transitionLinkedDeviceLifecycleJournal(prepared, {
      type: "external-begin",
      at: at(1),
    });
    expect(classifyLinkedDeviceLifecycleRestart(
      prepared,
      () => "exact-live-owner",
    ).kind).toBe("live-owner");
    expect(classifyLinkedDeviceLifecycleRestart(
      prepared,
      () => "unknown",
    ).kind).toBe("owner-unknown");
    expect(classifyLinkedDeviceLifecycleRestart(
      prepared,
      () => "different-or-dead",
    ).kind).toBe("safe-retry");
    expect(classifyLinkedDeviceLifecycleRestart(
      begun,
      () => "different-or-dead",
    ).kind).toBe("reconciliation-required");
  });

  test("rejects extra fields, accessors, wrong result kinds, and backward time", () => {
    const valid = initial();
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...valid,
      surprise: true,
    })).toThrow("unsupported fields");
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...valid,
      ["__proto__"]: { poisoned: true },
    })).toThrow("unsupported fields");

    let getterCalls = 0;
    const accessor: Record<string, unknown> = { ...valid };
    Object.defineProperty(accessor, "owner", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return valid.owner;
      },
    });
    expect(() => parseLinkedDeviceLifecycleJournal(accessor))
      .toThrow("accessor fields");
    expect(getterCalls).toBe(0);

    const begun = transitionLinkedDeviceLifecycleJournal(valid, {
      type: "external-begin",
      at: at(1),
    });
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...begun,
      revision: 0,
    })).toThrow("contradictory");
    expect(() => transitionLinkedDeviceLifecycleJournal(begun, {
      type: "external-complete",
      result: {
        kind: "sync",
        itemsStored: 1,
        projection: "linked-device-local-store",
        emitsProtocolAcknowledgements: true,
      },
      at: at(2),
    })).toThrow("result kind does not match");
    expect(() => transitionLinkedDeviceLifecycleJournal(begun, {
      type: "outcome-not-durable",
      reasonCode: "runtime-error-after-begin",
      at: START,
    })).toThrow("moved backward");
    expect(() => transitionLinkedDeviceLifecycleJournal(valid, {
      type: "lease-renewed",
      at: at(1),
      leaseUntil: at(599),
    })).toThrow("moved backward");
    const completed = transitionLinkedDeviceLifecycleJournal(begun, {
      type: "external-complete",
      result: {
        kind: "pair",
        resultingAuthContentHash: PAIR_AUTH_CONTENT_HASH,
      },
      at: at(2),
    });
    const succeeded = transitionLinkedDeviceLifecycleJournal(completed, {
      type: "committed",
      result: completed.result!,
      at: at(3),
    });
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...succeeded,
      revision: 0,
    })).toThrow("contradictory");
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...succeeded,
      finishedAt: START,
    })).toThrow("moved backward");
    const eventWithExtraField = {
      type: "external-begin",
      at: at(1),
      surprise: true,
    } as const;
    expect(() => transitionLinkedDeviceLifecycleJournal(
      valid,
      eventWithExtraField,
    )).toThrow("unsupported fields");
  });

  test("binds exact plugin and auth context without persisting sensitive payloads", () => {
    const valid = initial();
    expect(valid).toMatchObject({
      pluginId: "whatsapp-linked-device",
      pluginVersion: "1.2.3",
      pluginImplementationHash: "9".repeat(64),
      lifecycleContractVersion: 1,
      authContentHash: "c".repeat(64),
      initialSubjectState: "unbound",
      phoneProvided: true,
    });

    const begun = transitionLinkedDeviceLifecycleJournal(valid, {
      type: "external-begin",
      at: at(1),
    });
    const pairResultWithSubject = {
      type: "external-complete",
      result: {
        kind: "pair",
        resultingAuthContentHash: PAIR_AUTH_CONTENT_HASH,
        subject: "whatsapp:pn:15551234567",
      },
      at: at(2),
    } as const;
    expect(() => transitionLinkedDeviceLifecycleJournal(
      begun,
      pairResultWithSubject,
    )).toThrow("unsupported fields");
    const outcomeWithRawError = {
      type: "outcome-not-durable",
      reasonCode: "runtime-error-after-begin",
      error: "raw subprocess stderr must never enter the journal",
      at: at(2),
    } as const;
    expect(() => transitionLinkedDeviceLifecycleJournal(
      begun,
      outcomeWithRawError,
    )).toThrow("unsupported fields");
    expect(JSON.stringify(valid)).not.toContain("15551234567");

    expect(() => parseLinkedDeviceLifecycleJournal({
      ...valid,
      pluginVersion: "1.0.0-01",
    })).toThrow("plugin version is malformed");
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...valid,
      owner: {
        ...valid.owner,
        commandLine: "secret --phone 15551234567",
      },
    })).toThrow("unsupported fields");

    const sync = initial("sync-once");
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...sync,
      phoneProvided: true,
    })).toThrow("forbids phone input");
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...sync,
      initialSubjectState: "unbound",
    })).toThrow("requires bound auth");

    const syncBegun = transitionLinkedDeviceLifecycleJournal(sync, {
      type: "external-begin",
      at: at(1),
    });
    const syncCompleted = transitionLinkedDeviceLifecycleJournal(syncBegun, {
      type: "external-complete",
      result: {
        kind: "sync",
        itemsStored: 1,
        projection: "linked-device-local-store",
        emitsProtocolAcknowledgements: true,
      },
      at: at(2),
    });
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...syncCompleted,
      result: {
        ...syncCompleted.result,
        emitsProtocolAcknowledgements: false,
      },
    })).toThrow("sync result is malformed");
    expect(() => parseLinkedDeviceLifecycleJournal({
      ...syncCompleted,
      result: {
        ...syncCompleted.result,
        projection: "phone-15551234567",
      },
    })).toThrow("sync result is malformed");
  });
});

describe("linked-device lifecycle journal persistence", () => {
  test("creates private state, enforces owner authority, and rejects stale CAS updates", () => {
    withState((environment, stateRoot) => {
      const journalOwner = createLinkedDeviceLifecycleOwner(at(600));
      expect(() => createLinkedDeviceLifecycleJournal(initial(
        "pair",
        FIRST_JOURNAL_ID,
        owner(),
      ), environment)).toThrow("not the current process");
      const fabricatedBegun = transitionLinkedDeviceLifecycleJournal(initial(
        "pair",
        SECOND_JOURNAL_ID,
        journalOwner,
      ), {
        type: "external-begin",
        at: at(1),
      });
      expect(() => createLinkedDeviceLifecycleJournal(
        fabricatedBegun,
        environment,
      )).toThrow("must start prepared at revision zero");
      const created = createLinkedDeviceLifecycleJournal(initial(
        "pair",
        FIRST_JOURNAL_ID,
        journalOwner,
      ), environment);
      expect(existsSync(join(
        stateRoot,
        ...LINKED_DEVICE_LIFECYCLE_JOURNAL_STATE_DIRECTORY.split("/"),
      ))).toBeTrue();
      const begun = updateLinkedDeviceLifecycleJournal(created, {
        type: "external-begin",
        at: at(1),
      }, {
        owner: journalOwner,
        environment,
      });
      expect(readLinkedDeviceLifecycleJournal(
        FIRST_JOURNAL_ID,
        environment,
      )).toEqual(begun);
      expect(listLinkedDeviceLifecycleJournalSnapshots(environment))
        .toEqual([begun]);

      expect(() => updateLinkedDeviceLifecycleJournal(created, {
        type: "external-begin",
        at: at(1),
      }, {
        owner: journalOwner,
        environment,
      })).toThrow("changed concurrently");

      expect(() => updateLinkedDeviceLifecycleJournal(begun, {
        type: "outcome-not-durable",
        reasonCode: "runtime-error-after-begin",
        at: at(2),
      }, {
        owner: {
          ...journalOwner,
          token: SECOND_TOKEN,
        },
        environment,
      })).toThrow("does not own the journal");
    });
  });

  test("repairs dead owners with safe-retry before begin and indeterminate after begin", () => {
    withState((environment, stateRoot) => {
      const oldOwner = owner(1_001, FIRST_TOKEN);
      const activeOwner = createLinkedDeviceLifecycleOwner(at(900));
      createLinkedDeviceLifecycleJournal(initial(
        "pair",
        FIRST_JOURNAL_ID,
        activeOwner,
      ), environment);
      const firstPath = join(
        stateRoot,
        ...LINKED_DEVICE_LIFECYCLE_JOURNAL_STATE_DIRECTORY.split("/"),
        `${FIRST_JOURNAL_ID}.json`,
      );
      writeFileSync(
        firstPath,
        `${canonicalJson(initial("pair", FIRST_JOURNAL_ID, oldOwner))}\n`,
      );
      const prepared = readLinkedDeviceLifecycleJournal(
        FIRST_JOURNAL_ID,
        environment,
      );
      if (prepared === null) throw new Error("prepared fixture is missing");
      const newOwner = createLinkedDeviceLifecycleOwner(at(900));
      const retryable = repairInterruptedLinkedDeviceLifecycleJournal(
        prepared,
        {
          owner: newOwner,
          at: at(5),
          environment,
        },
      );
      expect(retryable.journal).toMatchObject({
        status: "safe-retry",
        reconciliation: "not-required",
        owner: newOwner,
      });

      const secondActiveOwner = createLinkedDeviceLifecycleOwner(at(900));
      const secondPrepared = createLinkedDeviceLifecycleJournal(initial(
        "sync-once",
        SECOND_JOURNAL_ID,
        secondActiveOwner,
      ), environment);
      const begun = updateLinkedDeviceLifecycleJournal(secondPrepared, {
        type: "external-begin",
        at: at(1),
      }, {
        owner: secondActiveOwner,
        environment,
      });
      const secondPath = join(
        stateRoot,
        ...LINKED_DEVICE_LIFECYCLE_JOURNAL_STATE_DIRECTORY.split("/"),
        `${SECOND_JOURNAL_ID}.json`,
      );
      writeFileSync(
        secondPath,
        `${canonicalJson(parseLinkedDeviceLifecycleJournal({
          ...begun.journal,
          owner: oldOwner,
        }))}\n`,
      );
      const interrupted = readLinkedDeviceLifecycleJournal(
        SECOND_JOURNAL_ID,
        environment,
      );
      if (interrupted === null) throw new Error("begun fixture is missing");
      const indeterminate = repairInterruptedLinkedDeviceLifecycleJournal(
        interrupted,
        {
          owner: newOwner,
          at: at(5),
          environment,
        },
      );
      expect(indeterminate.journal).toMatchObject({
        status: "indeterminate",
        reconciliation: "required",
        owner: newOwner,
      });
      expect(() => repairInterruptedLinkedDeviceLifecycleJournal(
        indeterminate,
        {
          owner: oldOwner,
          at: at(6),
          environment,
        },
      )).toThrow("not the current process");
      expect(() => repairInterruptedLinkedDeviceLifecycleJournal(
        indeterminate,
        {
          owner: activeOwner,
          at: at(6),
          environment,
        },
      )).toThrow("exact process owner is still live");
    });
  });

  test("marks malformed canonical files invalid without parsing attacker accessors", () => {
    withState((environment, stateRoot) => {
      const journalOwner = createLinkedDeviceLifecycleOwner(at(600));
      createLinkedDeviceLifecycleJournal(initial(
        "pair",
        FIRST_JOURNAL_ID,
        journalOwner,
      ), environment);
      const path = join(
        stateRoot,
        ...LINKED_DEVICE_LIFECYCLE_JOURNAL_STATE_DIRECTORY.split("/"),
        `${FIRST_JOURNAL_ID}.json`,
      );
      writeFileSync(path, `${JSON.stringify(initial())}\n`);
      expect(() => readLinkedDeviceLifecycleJournal(
        FIRST_JOURNAL_ID,
        environment,
      )).toThrow("not canonical JSON");
      expect(listLinkedDeviceLifecycleJournalSnapshots(environment)).toEqual([
        { journalId: FIRST_JOURNAL_ID, invalid: true },
      ]);

      writeFileSync(path, `${JSON.stringify({
        ...initial(),
        surprise: true,
      })}\n`);
      expect(() => readLinkedDeviceLifecycleJournal(
        FIRST_JOURNAL_ID,
        environment,
      )).toThrow("unsupported fields");
      expect(listLinkedDeviceLifecycleJournalSnapshots(environment)).toEqual([
        { journalId: FIRST_JOURNAL_ID, invalid: true },
      ]);
    });
  });

  test("fails closed on every unexpected durable journal entry", () => {
    withState((environment, stateRoot) => {
      const journalOwner = createLinkedDeviceLifecycleOwner(at(600));
      createLinkedDeviceLifecycleJournal(initial(
        "pair",
        FIRST_JOURNAL_ID,
        journalOwner,
      ), environment);
      const directory = join(
        stateRoot,
        ...LINKED_DEVICE_LIFECYCLE_JOURNAL_STATE_DIRECTORY.split("/"),
      );
      writeFileSync(
        join(directory, "legacy-secret-coordinate.json"),
        "{}\n",
        { mode: 0o600 },
      );

      const entries = listLinkedDeviceLifecycleJournalSnapshots(environment);
      expect(entries).toHaveLength(2);
      const invalid = entries.find((entry) => "invalid" in entry);
      expect(invalid?.journalId).toMatch(/^invalid-[a-f0-9]{64}$/u);
      expect(JSON.stringify(invalid)).not.toContain(
        "legacy-secret-coordinate",
      );
    });
  });
});
