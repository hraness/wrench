import { expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support";

import {
  classifyLinkedDeviceLifecycleRestart,
  initialLinkedDeviceLifecycleJournal,
  parseLinkedDeviceLifecycleJournal,
  transitionLinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleJournal,
  type LinkedDeviceLifecycleJournalEvent,
  type LinkedDeviceLifecycleResult,
} from "./linked-device-lifecycle-journal";
import type { ProcessOwnerStatus } from "./process-identity";

const START = "2026-07-25T12:00:00.000Z";

function at(step: number): string {
  return new Date(Date.parse(START) + step * 1_000).toISOString();
}

type LifecycleKind = LinkedDeviceLifecycleJournal["kind"];

function initial(kind: LifecycleKind): LinkedDeviceLifecycleJournal {
  return initialLinkedDeviceLifecycleJournal({
    journalId: "11111111-1111-4111-8111-111111111111",
    kind,
    pluginId: "property-linked-device",
    pluginVersion: "1.2.3-alpha.1+property",
    pluginImplementationHash: "9".repeat(64),
    lifecycleContractVersion: 1,
    surfaceId: "property-device",
    authId: "property-main",
    authRealmHash: "a".repeat(64),
    authContentHash: "b".repeat(64),
    initialSubjectState: kind === "pair" ? "unbound" : "bound",
    phoneProvided: kind === "pair",
    owner: {
      pid: 1234,
      token: "22222222-2222-4222-8222-222222222222",
      bootId: "c".repeat(64),
      processStartId: "d".repeat(64),
      leaseUntil: at(10_000),
    },
    startedAt: START,
  });
}

function result(
  kind: LifecycleKind,
  amount: number,
): LinkedDeviceLifecycleResult {
  return kind === "pair"
    ? {
        kind: "pair",
        resultingAuthContentHash: amount.toString(16).padStart(64, "0"),
      }
    : {
        kind: "sync",
        itemsStored: amount,
        projection: "linked-device-local-store",
        emitsProtocolAcknowledgements: true,
      };
}

test("every bounded pair or sync success follows the same durable boundary law", () => {
  assertProperty(fc.property(
    fc.constantFrom<LifecycleKind>("pair", "sync-once"),
    fc.integer({ min: 0, max: 1_000_000 }),
    (kind, amount) => {
      const prepared = initial(kind);
      const begun = transitionLinkedDeviceLifecycleJournal(prepared, {
        type: "external-begin",
        at: at(1),
      });
      const completed = transitionLinkedDeviceLifecycleJournal(begun, {
        type: "external-complete",
        result: result(kind, amount),
        at: at(2),
      });
      const committed = transitionLinkedDeviceLifecycleJournal(completed, {
        type: "committed",
        result: completed.result!,
        at: at(3),
      });

      expect(committed.revision).toBe(3);
      expect(committed.status).toBe("succeeded");
      expect(committed.phase).toBe("terminal");
      expect(committed.result).toEqual(result(kind, amount));
      expect(
        parseLinkedDeviceLifecycleJournal(
          JSON.parse(JSON.stringify(committed)) as unknown,
        ),
      ).toEqual(committed);
    },
  ));
});

const commands = [
  "begin",
  "complete",
  "commit",
  "abort",
  "indeterminate",
  "reconcile-applied",
  "reconcile-not-applied",
  "renew",
] as const;
type Command = (typeof commands)[number];
const commandArbitrary = fc.constantFrom<Command>(...commands);

const faultCommands = [
  "clock-rollback",
  "extra-field",
  "wrong-result-kind",
  "bad-evidence-hash",
  "lease-regression",
] as const;
type FaultCommand = (typeof faultCommands)[number];
type WorkloadCommand = Command | FaultCommand;
const workloadCommandArbitrary = fc.constantFrom<WorkloadCommand>(
  ...commands,
  ...faultCommands,
);

function eventFor(
  command: Command,
  journal: LinkedDeviceLifecycleJournal,
  step: number,
): LinkedDeviceLifecycleJournalEvent {
  if (command === "begin") {
    return { type: "external-begin", at: at(step) };
  }
  if (command === "complete") {
    return {
      type: "external-complete",
      result: result(journal.kind, step),
      at: at(step),
    };
  }
  if (command === "commit") {
    return {
      type: "committed",
      result: journal.result ?? result(journal.kind, step),
      at: at(step),
    };
  }
  if (command === "abort") {
    return {
      type: "aborted-before-external",
      reasonCode: "preflight-failed",
      at: at(step),
    };
  }
  if (command === "indeterminate") {
    return {
      type: "outcome-not-durable",
      reasonCode: "runtime-error-after-begin",
      at: at(step),
    };
  }
  if (command === "reconcile-applied") {
    return {
      type: "reconciled",
      outcome: "applied",
      evidenceHash: "e".repeat(64),
      result: journal.result ?? result(journal.kind, step),
      at: at(step),
    };
  }
  if (command === "reconcile-not-applied") {
    return {
      type: "reconciled",
      outcome: "not-applied",
      evidenceHash: "f".repeat(64),
      at: at(step),
    };
  }
  return {
    type: "lease-renewed",
    leaseUntil: at(10_000 + step),
    at: at(step),
  };
}

function faultEventFor(
  command: FaultCommand,
  journal: LinkedDeviceLifecycleJournal,
  step: number,
): LinkedDeviceLifecycleJournalEvent {
  if (command === "clock-rollback") {
    return { type: "external-begin", at: at(-1) };
  }
  if (command === "extra-field") {
    return {
      type: "external-begin",
      at: at(step),
      unexpected: true,
    } as unknown as LinkedDeviceLifecycleJournalEvent;
  }
  if (command === "wrong-result-kind") {
    return {
      type: "external-complete",
      result: journal.kind === "pair"
        ? {
            kind: "sync",
            itemsStored: step,
            projection: "linked-device-local-store",
            emitsProtocolAcknowledgements: true,
          }
        : {
            kind: "pair",
            resultingAuthContentHash: step.toString(16).padStart(64, "0"),
          },
      at: at(step),
    };
  }
  if (command === "bad-evidence-hash") {
    return {
      type: "reconciled",
      outcome: "applied",
      evidenceHash: "not-a-digest",
      result: journal.result ?? result(journal.kind, step),
      at: at(step),
    };
  }
  return {
    type: "lease-renewed",
    leaseUntil: at(9_999),
    at: at(step),
  };
}

function assertSafety(journal: LinkedDeviceLifecycleJournal): void {
  expect(
    parseLinkedDeviceLifecycleJournal(
      JSON.parse(JSON.stringify(journal)) as unknown,
    ),
  ).toEqual(journal);
  if (journal.phase === "terminal") {
    expect(journal.status).not.toBe("pending");
    expect(journal.finishedAt).not.toBeNull();
  }
  if (journal.status === "succeeded") {
    expect(journal.result).not.toBeNull();
  }
  if (journal.status === "safe-retry" && journal.externalStartedAt !== null) {
    expect(journal.reconciliation).toBe("resolved-not-applied");
    expect(journal.externalCompletedAt).toBeNull();
    expect(journal.result).toBeNull();
    expect(journal.reasonCode).toBe("reconciled-not-applied");
  }
  if (journal.externalCompletedAt !== null) {
    expect(journal.externalStartedAt).not.toBeNull();
    expect(journal.result).not.toBeNull();
  }
}

type TransitionAttempt =
  | Readonly<{ kind: "success"; journal: LinkedDeviceLifecycleJournal }>
  | Readonly<{ kind: "failure"; error: unknown }>;

function attemptTransition(
  journal: LinkedDeviceLifecycleJournal,
  event: LinkedDeviceLifecycleJournalEvent,
): TransitionAttempt {
  try {
    return {
      kind: "success",
      journal: transitionLinkedDeviceLifecycleJournal(journal, event),
    };
  } catch (error) {
    return { kind: "failure", error };
  }
}

function terminalizeWithSuppliedEvidence(
  journal: LinkedDeviceLifecycleJournal,
  firstStep: number,
): Readonly<{ journal: LinkedDeviceLifecycleJournal; steps: number }> {
  let current = journal;
  let step = firstStep;
  let steps = 0;
  const apply = (event: LinkedDeviceLifecycleJournalEvent): void => {
    current = transitionLinkedDeviceLifecycleJournal(current, event);
    step += 1;
    steps += 1;
  };
  if (current.phase === "prepared") {
    apply({
      type: "aborted-before-external",
      reasonCode: "cancelled-before-begin",
      at: at(step),
    });
  } else if (current.phase === "external-begun") {
    apply({
      type: "outcome-not-durable",
      reasonCode: "runtime-error-after-begin",
      at: at(step),
    });
  } else if (current.phase === "external-completed") {
    if (current.result === null) {
      throw new Error("external-completed workload lost its durable result");
    }
    apply({ type: "committed", result: current.result, at: at(step) });
  }
  if (current.status === "indeterminate") {
    apply({
      type: "reconciled",
      outcome: "applied",
      evidenceHash: "e".repeat(64),
      result: current.result ?? result(current.kind, step),
      at: at(step),
    });
  }
  return Object.freeze({ journal: current, steps });
}

test("arbitrary event schedules either fail closed or advance one monotonic revision", () => {
  assertProperty(fc.property(
    fc.constantFrom<LifecycleKind>("pair", "sync-once"),
    fc.array(commandArbitrary, { minLength: 0, maxLength: 32 }),
    (kind, commands) => {
      let journal = initial(kind);
      for (const [index, command] of commands.entries()) {
        const before = journal;
        const attempt = attemptTransition(
          journal,
          eventFor(command, journal, index + 1),
        );
        if (attempt.kind === "failure") {
          expect(attempt.error).toBeInstanceOf(Error);
          expect(journal).toBe(before);
          continue;
        }
        journal = attempt.journal;
        expect(journal.revision).toBe(before.revision + 1);
        expect(Date.parse(journal.updatedAt))
          .toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
        expect(journal.journalId).toBe(before.journalId);
        expect(journal.kind).toBe(before.kind);
        expect(journal.pluginId).toBe(before.pluginId);
        expect(journal.pluginVersion).toBe(before.pluginVersion);
        expect(journal.pluginImplementationHash)
          .toBe(before.pluginImplementationHash);
        expect(journal.lifecycleContractVersion)
          .toBe(before.lifecycleContractVersion);
        expect(journal.authRealmHash).toBe(before.authRealmHash);
        expect(journal.authContentHash).toBe(before.authContentHash);
        expect(journal.initialSubjectState)
          .toBe(before.initialSubjectState);
        expect(journal.phoneProvided).toBe(before.phoneProvided);
      }
      expect(
        parseLinkedDeviceLifecycleJournal(
          JSON.parse(JSON.stringify(journal)) as unknown,
        ),
      ).toEqual(journal);
    },
  ));
});

test("bounded action and fault workloads terminalize with supplied evidence", () => {
  assertProperty(fc.property(
    fc.constantFrom<LifecycleKind>("pair", "sync-once"),
    fc.array(workloadCommandArbitrary, { minLength: 0, maxLength: 48 }),
    (kind, trace) => {
      let journal = initial(kind);
      assertSafety(journal);
      for (const [index, command] of trace.entries()) {
        const before = journal;
        const isFault = (faultCommands as readonly string[]).includes(command);
        const attempt = attemptTransition(
          journal,
          isFault
            ? faultEventFor(command as FaultCommand, journal, index + 1)
            : eventFor(command as Command, journal, index + 1),
        );
        if (attempt.kind === "failure") {
          expect(attempt.error).toBeInstanceOf(Error);
          expect(journal).toBe(before);
          assertSafety(journal);
          continue;
        }
        if (isFault) {
          throw new Error(
            `fault command was accepted at trace ${JSON.stringify(trace.slice(0, index + 1))}`,
          );
        }
        journal = attempt.journal;
        expect(journal.revision).toBe(before.revision + 1);
        assertSafety(journal);
      }

      const settled = terminalizeWithSuppliedEvidence(journal, trace.length + 1);
      assertSafety(settled.journal);
      expect(settled.steps).toBeLessThanOrEqual(2);
      expect(settled.journal.phase).toBe("terminal");
      expect(["succeeded", "safe-retry"]).toContain(settled.journal.status);
    },
  ), { numRuns: 300 });
});

test("restart classification depends only on exact owner status and external begin", () => {
  assertProperty(fc.property(
    fc.boolean(),
    fc.constantFrom<ProcessOwnerStatus>(
      "exact-live-owner",
      "different-or-dead",
      "unknown",
    ),
    (crossedExternalBegin, ownerStatus) => {
      const prepared = initial("pair");
      const journal = crossedExternalBegin
        ? transitionLinkedDeviceLifecycleJournal(prepared, {
            type: "external-begin",
            at: at(1),
          })
        : prepared;
      const disposition = classifyLinkedDeviceLifecycleRestart(
        journal,
        () => ownerStatus,
      );
      expect(disposition.kind).toBe(
        ownerStatus === "exact-live-owner"
          ? "live-owner"
          : ownerStatus === "unknown"
            ? "owner-unknown"
            : crossedExternalBegin
              ? "reconciliation-required"
              : "safe-retry",
      );
    },
  ));
});

test("arbitrary JSON never bypasses strict bounded journal parsing", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    try {
      const parsed = parseLinkedDeviceLifecycleJournal(value);
      expect(
        parseLinkedDeviceLifecycleJournal(
          JSON.parse(JSON.stringify(parsed)) as unknown,
        ),
      ).toEqual(parsed);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(Buffer.byteLength((error as Error).message, "utf8"))
        .toBeLessThanOrEqual(256);
    }
  }));
});
