import { expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support";

import {
  initialRunJournal,
  parseRunJournal,
  transitionRunJournal,
  type RunJournal,
  type RunJournalContract,
} from "./run-journal";
import type { PortableOperationIdentityV1 } from "./provider-plugin-portable-identity";

function initial(
  plannedDispatches: number,
  hasPlanAssets: boolean,
  contract: RunJournalContract = {
    transport: "provider-api",
    hash: "e".repeat(64),
  },
): RunJournal {
  return initialRunJournal({
    runId: "11111111-1111-4111-8111-111111111111",
    planDigest: "a".repeat(64),
    adapter: {
      id: "property-provider",
      version: "1.0.0",
      hash: "b".repeat(64),
    },
    operation: "content.save",
    risk: "R2",
    inputHash: "c".repeat(64),
    auth: {
      id: "property-main",
      hash: "d".repeat(64),
      kind: "oauth-token-file",
    },
    contract,
    plannedDispatches,
    hasPlanAssets,
    owner: {
      pid: 1234,
      token: "22222222-2222-4222-8222-222222222222",
      bootId: "1".repeat(64),
      processStartId: "2".repeat(64),
      leaseUntil: "2026-07-25T13:00:00.000Z",
    },
    startedAt: "2026-07-25T12:00:00.000Z",
    dedupeExpiresAt: "2026-07-26T12:00:00.000Z",
  });
}

function timestamp(step: number): string {
  return new Date(Date.parse("2026-07-25T12:00:00.000Z") + step * 1_000)
    .toISOString();
}

function ready(planned: number, assets: boolean): RunJournal {
  const consumed = transitionRunJournal(initial(planned, assets), {
    type: "confirmation-consumed",
    at: timestamp(0),
  });
  const claimed = transitionRunJournal(consumed, {
    type: "ledger-claimed",
    ledgerRelativePath: `idempotency/ff/${"f".repeat(64)}.json`,
    at: timestamp(1),
  });
  return transitionRunJournal(claimed, {
    type: "recovery-stored",
    at: timestamp(2),
  });
}

test("every bounded complete dispatch sequence reaches one canonical successful state", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 25 }),
    fc.boolean(),
    (planned, assets) => {
      let journal = ready(planned, assets);
      for (let index = 1; index <= planned; index += 1) {
        journal = transitionRunJournal(journal, {
          type: "dispatch-started",
          index,
          at: timestamp(index * 2 + 1),
        });
        journal = transitionRunJournal(journal, {
          type: "dispatch-verified",
          index,
          at: timestamp(index * 2 + 2),
        });
      }
      journal = transitionRunJournal(journal, {
        type: "finished",
        status: "submitted",
        finalOrigin: "https://property.example",
        error: null,
        at: timestamp(planned * 2 + 3),
      });

      expect(parseRunJournal(JSON.parse(JSON.stringify(journal)) as unknown))
        .toEqual(journal);
      expect(journal.dispatch).toEqual({
        planned,
        started: planned,
        verified: planned,
      });
      expect(journal.ledgerState).toBe("succeeded");
      expect(journal.recoveryState).toBe("released");
      expect(journal.assetState).toBe(assets ? "released" : "none");
    },
  ));
});

test("every verified proper prefix can finish only as partial", () => {
  assertProperty(fc.property(
    fc.integer({ min: 2, max: 25 }),
    fc.boolean(),
    (planned, assets) => {
      const verified = Math.max(1, Math.floor(planned / 2));
      let journal = ready(planned, assets);
      for (let index = 1; index <= verified; index += 1) {
        journal = transitionRunJournal(journal, {
          type: "dispatch-started",
          index,
          at: timestamp(index * 2 + 1),
        });
        journal = transitionRunJournal(journal, {
          type: "dispatch-verified",
          index,
          at: timestamp(index * 2 + 2),
        });
      }
      journal = transitionRunJournal(journal, {
        type: "finished",
        status: "partial",
        finalOrigin: null,
        error: "bounded property fixture",
        at: timestamp(verified * 2 + 3),
      });

      expect(journal.dispatch.verified).toBe(verified);
      expect(journal.recoveryState).toBe("retained");
      expect(journal.assetState).toBe(assets ? "retained" : "none");
      expect(() => transitionRunJournal(journal, {
        type: "finished",
        status: "submitted",
        finalOrigin: null,
        error: null,
        at: timestamp(verified * 2 + 4),
      })).toThrow();
    },
  ));
});

test("arbitrary JSON never bypasses strict journal parsing", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    try {
      const parsed = parseRunJournal(value);
      expect(parseRunJournal(JSON.parse(JSON.stringify(parsed)) as unknown))
        .toEqual(parsed);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(Buffer.byteLength((error as Error).message, "utf8"))
        .toBeLessThanOrEqual(256);
    }
  }));
});

test("duplicate intent lineage round-trips only in its exact bounded scope", () => {
  assertProperty(fc.property(
    fc.record({
      assets: fc.boolean(),
      intentNibble: fc.integer({ min: 0, max: 15 }),
      claimStep: fc.integer({ min: 5, max: 3_600 }),
    }),
    ({ assets, intentNibble, claimStep }) => {
      const intentHash = intentNibble.toString(16).repeat(64);
      const sourceInitial = initialRunJournal({
        runId: "11111111-1111-4111-8111-111111111111",
        planDigest: "a".repeat(64),
        adapter: {
          id: "property-web",
          version: "1.0.0",
          hash: "b".repeat(64),
        },
        operation: "posts.publish",
        risk: "R3",
        inputHash: "c".repeat(64),
        auth: {
          id: "property-main",
          hash: "d".repeat(64),
          kind: "cookies-file",
        },
        contract: {
          transport: "web-session-api",
          hash: "e".repeat(64),
        },
        plannedDispatches: 1,
        hasPlanAssets: assets,
        owner: initial(1, assets).owner,
        startedAt: timestamp(0),
        dedupeExpiresAt: "2026-07-26T12:00:00.000Z",
      });
      let source = transitionRunJournal(sourceInitial, {
        type: "confirmation-consumed",
        at: timestamp(0),
      });
      source = transitionRunJournal(source, {
        type: "ledger-claimed",
        ledgerRelativePath: `idempotency/ff/${"f".repeat(64)}.json`,
        at: timestamp(1),
      });
      source = transitionRunJournal(source, {
        type: "recovery-stored",
        at: timestamp(2),
      });
      source = transitionRunJournal(source, {
        type: "dispatch-started",
        index: 1,
        at: timestamp(3),
      });
      source = transitionRunJournal(source, {
        type: "finished",
        status: "indeterminate",
        finalOrigin: null,
        error: "property fixture",
        at: timestamp(4),
      });
      const claimed = transitionRunJournal(source, {
        type: "duplicate-successor-claimed",
        intentHash,
        runId: "33333333-3333-4333-8333-333333333333",
        at: timestamp(claimStep),
      });
      const child = initialRunJournal({
        runId: claimed.duplicateSuccessor!.runId,
        planDigest: "7".repeat(64),
        adapter: claimed.adapter,
        operation: claimed.operation,
        risk: claimed.risk,
        inputHash: claimed.inputHash,
        auth: claimed.auth,
        contract: claimed.contract,
        duplicateIntent: {
          schemaVersion: 1,
          intentHash,
          sourceRunId: claimed.runId,
        },
        plannedDispatches: 1,
        hasPlanAssets: assets,
        owner: claimed.owner,
        startedAt: timestamp(0),
        dedupeExpiresAt: "2026-07-26T12:00:00.000Z",
      });

      expect(parseRunJournal(JSON.parse(JSON.stringify(claimed)) as unknown))
        .toEqual(claimed);
      expect(parseRunJournal(JSON.parse(JSON.stringify(child)) as unknown))
        .toEqual(child);
      expect(() => parseRunJournal({
        ...child,
        dispatch: { ...child.dispatch, planned: 2 },
      })).toThrow("contradictory successor state");
      expect(() => parseRunJournal({
        ...claimed,
        duplicateSuccessor: {
          ...claimed.duplicateSuccessor!,
          claimedAt: timestamp(3),
        },
      })).toThrow("contradictory source state");
    },
  ));
});

test("portable identities round-trip exactly and nested extensions are always inert", () => {
  assertProperty(fc.property(
    fc.record({
      contractVersion: fc.integer({ min: 1, max: 1_000_000 }),
      transport: fc.constantFrom(
        "provider-api" as const,
        "web-session-api" as const,
        "linked-device" as const,
      ),
      bundleNibble: fc.integer({ min: 0, max: 15 }),
      manifestNibble: fc.integer({ min: 0, max: 15 }),
      descriptorNibble: fc.integer({ min: 0, max: 15 }),
    }),
    (value) => {
      const identity: PortableOperationIdentityV1 = {
        pluginId: "property-portable",
        pluginVersion: "1.2.3",
        hostApiVersion: 1,
        bundleSha256: value.bundleNibble.toString(16).repeat(64),
        manifestSha256: value.manifestNibble.toString(16).repeat(64),
        adapterId: "property-portable",
        transport: value.transport,
        surfaceId: "property-portable",
        operation: "content.save",
        contractVersion: value.contractVersion,
        descriptorSha256: value.descriptorNibble.toString(16).repeat(64),
      };
      const journal = initial(1, false, {
        transport: "portable-provider-plugin",
        identity,
      });
      const roundTripped = parseRunJournal(
        JSON.parse(JSON.stringify(journal)) as unknown,
      );

      expect(roundTripped).toEqual(journal);
      expect(
        roundTripped.contract.transport === "portable-provider-plugin"
        && Object.isFrozen(roundTripped.contract.identity),
      ).toBeTrue();
      expect(() => parseRunJournal({
        ...roundTripped,
        contract: {
          transport: "portable-provider-plugin",
          identity: {
            ...identity,
            extension: value.contractVersion,
          },
        },
      })).toThrow("unsupported fields");
    },
  ));
});
