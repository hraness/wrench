import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  markOmniSourceDriftV1,
  parseMaterializedPageV1,
  parseOmniSourceStateV1,
  queryOmniSourceStatesV1,
  reduceOmniSourceStateV1,
  type OmniPageProvenanceV1,
  type OmniSourceIdentityV1,
  type ProviderMaterializedEntityV1,
  type ProviderMaterializedPageV1,
  type ProviderMessageV1,
} from "./omni-model";

const source: OmniSourceIdentityV1 = Object.freeze({
  schemaVersion: 1,
  adapter: Object.freeze({ id: "reddit-web", version: "1.0.0", hash: "a".repeat(64) }),
  plugin: Object.freeze({ id: "reddit-web", version: "1.0.0", closureHash: "b".repeat(64) }),
  surfaceId: "reddit",
  auth: Object.freeze({
    id: "reddit-main",
    kind: "cookie-source",
    hash: "c".repeat(64),
    subject: "reddit:t2_account",
  }),
});

function provenance(
  run: number,
  overrides: Partial<OmniPageProvenanceV1> = {},
): OmniPageProvenanceV1 {
  const second = String(run).padStart(2, "0");
  return Object.freeze({
    operation: "messaging.list",
    inputHash: sha256(`input-${run}`),
    exactQueryKey: sha256(`query-${run}`),
    exactDataRevision: sha256(`data-${run}`),
    validatedAt: `2026-08-01T00:00:${second}.000Z`,
    startedAt: `2026-08-01T00:00:${second}.000Z`,
    finishedAt: `2026-08-01T00:00:${second}.500Z`,
    runId: `00000000-0000-4000-8000-${String(run).padStart(12, "0")}`,
    materializerId: "reddit-inbox",
    materializerVersion: 1,
    ...overrides,
  });
}

function participant(id: string | null) {
  return Object.freeze({ providerId: id, displayName: id, handle: id });
}

function message(
  providerId: string,
  orderedAt: string,
  body: string | null = providerId,
): ProviderMessageV1 {
  return Object.freeze({
    kind: "message" as const,
    providerId,
    providerRevision: null,
    orderedAt,
    conversationProviderId: null,
    sender: participant("alice"),
    recipients: Object.freeze([participant("bob")]),
    direction: "incoming" as const,
    subject: null,
    body,
    unread: true,
    replyToProviderId: null,
    state: "active" as const,
    attachments: Object.freeze([]),
  });
}

function page(
  partition: string,
  entities: readonly ProviderMaterializedEntityV1[],
  options: Partial<ProviderMaterializedPageV1> = {},
): ProviderMaterializedPageV1 {
  return Object.freeze({
    schemaVersion: 1,
    partition,
    completeness: Object.freeze({ kind: "page" as const, reason: null }),
    cursor: Object.freeze({ direction: "forward" as const, request: null, nextInput: null }),
    entities: Object.freeze(entities),
    tombstones: Object.freeze([]),
    ...options,
  });
}

describe("omni normalized model", () => {
  test("strictly parses reviewed page shapes and rejects foreign object tricks", () => {
    expect(parseMaterializedPageV1(page(
      "folder:inbox",
      [message("t4_one", "2026-08-01T00:00:01.000Z")],
    )).entities).toHaveLength(1);

    const withAccessor: Record<string, unknown> = { ...page("folder:inbox", []) };
    Object.defineProperty(withAccessor, "partition", {
      get: () => "folder:inbox",
      enumerable: true,
    });
    expect(() => parseMaterializedPageV1(withAccessor)).toThrow("enumerable data property");

    const sparse: Record<string, unknown> = { ...page("folder:inbox", []) };
    const entities = new Array(1);
    expect(() => parseMaterializedPageV1({ ...sparse, entities })).toThrow("dense array");

    let numericGetterCalls = 0;
    const accessorEntities: unknown[] = [];
    Object.defineProperty(accessorEntities, "0", {
      enumerable: true,
      configurable: true,
      get() {
        numericGetterCalls += 1;
        return message("t4_trap", "2026-08-01T00:00:01.000Z");
      },
    });
    accessorEntities.length = 1;
    expect(() => parseMaterializedPageV1({
      ...page("folder:inbox", []),
      entities: accessorEntities,
    })).toThrow("enumerable data property");
    expect(numericGetterCalls).toBe(0);
    expect(() => parseMaterializedPageV1(page("folder:inbox", [], {
      completeness: Object.freeze({ kind: "complete", reason: "unsafe continuation" }),
      cursor: Object.freeze({
        direction: "backward",
        request: "provider-cursor",
        nextInput: null,
      }),
    }))).toThrow("complete partition coverage must begin at the root");
    expect(() => parseMaterializedPageV1(page("folder:inbox", [], {
      completeness: Object.freeze({
        kind: "first-page-only",
        reason: "continuation is unavailable",
      }),
      cursor: Object.freeze({
        direction: "backward",
        request: null,
        nextInput: Object.freeze({ after: "private-provider-cursor" }),
      }),
    }))).toThrow(
      "first-page-only coverage cannot declare a replayable provider continuation",
    );
    expect(() => parseMaterializedPageV1(page("folder:inbox", [
      message("t4_same", "2026-08-01T00:00:01.000Z"),
      message("t4_same", "2026-08-01T00:00:01.000Z"),
    ]))).toThrow("repeat a stable entity identity");
    expect(() => parseMaterializedPageV1({
      ...page("folder:inbox", []),
      invalidationTags: ["speculative-delete"],
    })).toThrow("must contain exactly");
  });

  test("round-trips optional body truncation evidence without forging legacy declarations", () => {
    const legacyPage = page("folder:legacy", [
      message("t4_legacy", "2026-08-01T00:00:01.000Z"),
    ]);
    const parsedLegacy = parseMaterializedPageV1(legacyPage);
    expect(Object.hasOwn(parsedLegacy.entities[0]!, "bodyTruncated")).toBeFalse();
    expect(canonicalJson(parsedLegacy)).toBe(canonicalJson(legacyPage));

    const declaredPage = page("folder:declared", [{
      ...message("t4_declared", "2026-08-01T00:00:02.000Z"),
      bodyTruncated: true,
    }]);
    const parsedDeclared = parseMaterializedPageV1(declaredPage);
    expect(parsedDeclared.entities[0]).toMatchObject({
      body: "t4_declared",
      bodyTruncated: true,
    });

    const state = reduceOmniSourceStateV1(null, parsedDeclared, {
      source,
      provenance: provenance(1),
    });
    const reparsed = parseOmniSourceStateV1(
      JSON.parse(canonicalJson(state)),
    );
    expect(reparsed.entities[0]?.entity).toMatchObject({
      body: "t4_declared",
      bodyTruncated: true,
    });

    const undefinedDeclaration = {
      ...message("t4_invalid", "2026-08-01T00:00:03.000Z"),
      bodyTruncated: undefined,
    } as unknown as ProviderMaterializedEntityV1;
    expect(() => parseMaterializedPageV1(page(
      "folder:invalid",
      [undefinedDeclaration],
    ))).toThrow("bodyTruncated must be boolean");
    expect(() => parseMaterializedPageV1(page("folder:null", [{
      ...message("t4_null", "2026-08-01T00:00:04.000Z", null),
      bodyTruncated: true,
    }]))).toThrow("cannot be true when body is null");
  });

  test("replays one page idempotently and rejects same-observation conflicts", () => {
    const first = reduceOmniSourceStateV1(null, page(
      "folder:inbox",
      [message("t4_one", "2026-08-01T00:00:01.000Z")],
    ), { source, provenance: provenance(1) });
    const replayed = reduceOmniSourceStateV1(first, page(
      "folder:inbox",
      [message("t4_one", "2026-08-01T00:00:01.000Z")],
    ), { source, provenance: provenance(1) });
    expect(canonicalJson(replayed)).toBe(canonicalJson(first));
    expect(() => reduceOmniSourceStateV1(first, page(
      "folder:inbox",
      [message("t4_one", "2026-08-01T00:00:01.000Z", "changed")],
    ), { source, provenance: provenance(1) })).toThrow("conflicting bytes");

    const completePage = page(
      "folder:complete",
      [message("t4_first", "2026-08-01T00:00:01.000Z")],
      {
        completeness: Object.freeze({ kind: "complete", reason: "sealed" }),
        cursor: Object.freeze({
          direction: "none",
          request: null,
          nextInput: null,
        }),
      },
    );
    const complete = reduceOmniSourceStateV1(null, completePage, {
      source,
      provenance: provenance(4),
    });
    expect(() => reduceOmniSourceStateV1(complete, page(
      "folder:complete",
      [message("t4_different", "2026-08-01T00:00:01.000Z")],
      {
        completeness: Object.freeze({ kind: "complete", reason: "sealed" }),
        cursor: Object.freeze({
          direction: "none",
          request: null,
          nextInput: null,
        }),
      },
    ), { source, provenance: provenance(4) })).toThrow(
      "conflicting membership",
    );
  });

  test("merges independent pages commutatively and keeps deterministic order", () => {
    const pageA = page("folder:inbox", [message("t4_a", "2026-08-01T00:00:01.000Z")]);
    const pageB = page("folder:sent", [message("t4_b", "2026-08-01T00:00:02.000Z")]);
    const ab = reduceOmniSourceStateV1(
      reduceOmniSourceStateV1(null, pageA, { source, provenance: provenance(1) }),
      pageB,
      { source, provenance: provenance(2) },
    );
    const ba = reduceOmniSourceStateV1(
      reduceOmniSourceStateV1(null, pageB, { source, provenance: provenance(2) }),
      pageA,
      { source, provenance: provenance(1) },
    );
    expect(canonicalJson(ab)).toBe(canonicalJson(ba));
    expect(queryOmniSourceStatesV1([ab]).map((entity) => entity.providerId)).toEqual([
      "t4_b",
      "t4_a",
    ]);
  });

  test("complete coverage removes only stale membership in its own partition", () => {
    const initial = reduceOmniSourceStateV1(
      reduceOmniSourceStateV1(null, page("folder:inbox", [
        message("t4_old", "2026-08-01T00:00:01.000Z"),
      ]), { source, provenance: provenance(1) }),
      page("folder:sent", [message("t4_sent", "2026-08-01T00:00:02.000Z")]),
      { source, provenance: provenance(2) },
    );
    const complete = reduceOmniSourceStateV1(initial, page(
      "folder:inbox",
      [message("t4_new", "2026-08-01T00:00:03.000Z")],
      {
        completeness: Object.freeze({ kind: "complete", reason: "provider-sealed snapshot" }),
        cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
      },
    ), { source, provenance: provenance(3) });
    expect(complete.entities.map((entry) => entry.entity.providerId).sort()).toEqual([
      "t4_new",
      "t4_sent",
    ]);
    expect(complete.completeCoverage).toHaveLength(1);
    expect(complete.completeCoverage[0]).toMatchObject({
      partition: "folder:inbox",
      provenance: { exactDataRevision: provenance(3).exactDataRevision },
    });

    const tampered = structuredClone(complete);
    Object.defineProperty(tampered.completeCoverage[0]!, "observationOrder", {
      value: "2026-08-01T00:00:00.000Z",
      enumerable: true,
    });
    expect(() => parseOmniSourceStateV1(tampered)).toThrow(
      "inconsistent observation order",
    );
  });

  test("complete coverage rejects stale pages in its partition but not independent partitions", () => {
    const completePage = page(
      "folder:inbox",
      [message("t4_current", "2026-08-01T00:00:05.000Z")],
      {
        completeness: Object.freeze({
          kind: "complete",
          reason: "provider-sealed snapshot",
        }),
        cursor: Object.freeze({
          direction: "none",
          request: null,
          nextInput: null,
        }),
      },
    );
    const completeFirst = reduceOmniSourceStateV1(null, completePage, {
      source,
      provenance: provenance(5),
    });
    const staleAfterComplete = reduceOmniSourceStateV1(
      completeFirst,
      page("folder:inbox", [
        message("t4_removed", "2026-08-01T00:00:01.000Z"),
      ]),
      { source, provenance: provenance(1) },
    );
    expect(canonicalJson(staleAfterComplete)).toBe(canonicalJson(completeFirst));
    expect(() => reduceOmniSourceStateV1(
      completeFirst,
      page("folder:inbox", [
        message("t4_current", "2026-08-01T00:00:06.000Z"),
      ]),
      {
        source,
        provenance: provenance(6, {
          inputHash: provenance(5).inputHash,
        }),
      },
    )).toThrow("cannot weaken a complete root coordinate");

    const staleBeforeComplete = reduceOmniSourceStateV1(
      reduceOmniSourceStateV1(null, page("folder:inbox", [
        message("t4_removed", "2026-08-01T00:00:01.000Z"),
      ]), { source, provenance: provenance(1) }),
      completePage,
      { source, provenance: provenance(5) },
    );
    expect(staleBeforeComplete.entities).toEqual(completeFirst.entities);
    expect(staleBeforeComplete.pages).toEqual(completeFirst.pages);
    expect(staleBeforeComplete.completeCoverage).toEqual(
      completeFirst.completeCoverage,
    );

    const withIndependentPartition = reduceOmniSourceStateV1(
      completeFirst,
      page("folder:sent", [
        message("t4_sent", "2026-08-01T00:00:02.000Z"),
      ]),
      { source, provenance: provenance(2) },
    );
    expect(withIndependentPartition.entities.map((entry) =>
      entry.entity.providerId).sort()).toEqual(["t4_current", "t4_sent"]);
  });

  test("complete coverage resets durable membership only for its partition", () => {
    const firstProvenance = provenance(1);
    const replacementProvenance = provenance(2, {
      inputHash: firstProvenance.inputHash,
    });
    const sentWithHistory = reduceOmniSourceStateV1(
      reduceOmniSourceStateV1(null, page("folder:sent", [
        message("t4_sent_history", "2026-08-01T00:00:01.000Z"),
      ]), { source, provenance: firstProvenance }),
      page("folder:sent", []),
      { source, provenance: replacementProvenance },
    );
    expect(sentWithHistory.entities[0]?.partitions).toEqual(["folder:sent"]);

    const completeInbox = page("folder:inbox", [], {
      completeness: Object.freeze({ kind: "complete", reason: "sealed" }),
      cursor: Object.freeze({
        direction: "none",
        request: null,
        nextInput: null,
      }),
    });
    const independent = reduceOmniSourceStateV1(sentWithHistory, completeInbox, {
      source,
      provenance: provenance(3),
    });
    expect(independent.entities.map((entry) => entry.entity.providerId)).toEqual([
      "t4_sent_history",
    ]);

    const inboxWithHistory = reduceOmniSourceStateV1(
      reduceOmniSourceStateV1(null, page("folder:inbox", [
        message("t4_inbox_history", "2026-08-01T00:00:01.000Z"),
      ]), { source, provenance: firstProvenance }),
      page("folder:inbox", []),
      { source, provenance: replacementProvenance },
    );
    const reset = reduceOmniSourceStateV1(inboxWithHistory, completeInbox, {
      source,
      provenance: provenance(3),
    });
    expect(reset.entities).toEqual([]);
  });

  test("explicit tombstones win and older or implicit absence cannot resurrect", () => {
    const initial = reduceOmniSourceStateV1(null, page("folder:inbox", [
      message("t4_one", "2026-08-01T00:00:01.000Z"),
    ]), { source, provenance: provenance(1) });
    const deleted = reduceOmniSourceStateV1(initial, page("folder:inbox", [], {
      tombstones: Object.freeze([Object.freeze({
        kind: "message",
        providerId: "t4_one",
        providerRevision: "deleted-v1",
      })]),
    }), { source, provenance: provenance(2) });
    expect(deleted.entities).toHaveLength(0);
    expect(deleted.tombstones).toHaveLength(1);
    expect(deleted.pages.some((storedPage) =>
      storedPage.tombstones.some((tombstone) =>
        tombstone.id === deleted.tombstones[0]!.id
        && tombstone.providerRevision === "deleted-v1"))).toBeTrue();
    expect(() => reduceOmniSourceStateV1(deleted, page("folder:inbox", [], {
      tombstones: Object.freeze([Object.freeze({
        kind: "message",
        providerId: "t4_one",
        providerRevision: "deleted-v2",
      })]),
    }), { source, provenance: provenance(2) })).toThrow(
      "conflicting membership",
    );
    expect(() => reduceOmniSourceStateV1(deleted, page("folder:inbox", [
      message("t4_one", "2026-08-01T00:00:03.000Z"),
    ]), { source, provenance: provenance(3) })).toThrow("cannot resurrect");

    const laterEntity = reduceOmniSourceStateV1(null, page("folder:inbox", [
      message("t4_late", "2026-08-01T00:00:03.000Z"),
    ]), { source, provenance: provenance(3) });
    expect(() => reduceOmniSourceStateV1(laterEntity, page("folder:inbox", [], {
      tombstones: Object.freeze([Object.freeze({
        kind: "message",
        providerId: "t4_late",
        providerRevision: "deleted-before-entity",
      })]),
    }), { source, provenance: provenance(2) })).toThrow(
      "entity observed after a tombstone",
    );
  });

  test("auth lifetime is part of identity and drift retains last-good entities", () => {
    const ready = reduceOmniSourceStateV1(null, page("folder:inbox", [
      message("t4_one", "2026-08-01T00:00:01.000Z"),
    ]), { source, provenance: provenance(1) });
    const drift = markOmniSourceDriftV1(ready, {
      source,
      exactQueryKey: provenance(1).exactQueryKey,
      exactDataRevision: "d".repeat(64),
      failedAt: "2026-08-01T00:00:04.000Z",
      error: new Error("reddit omni output.messages[0].id is required"),
    });
    expect(drift.normalization[0]).toMatchObject({
      exactQueryKey: provenance(1).exactQueryKey,
      status: {
      state: "drift",
      code: "materializer-drift",
        lastGoodAt: provenance(1).validatedAt,
        lastGoodExactDataRevision: provenance(1).exactDataRevision,
      },
    });
    expect(drift.entities).toEqual(ready.entities);
    expect(() => reduceOmniSourceStateV1(ready, page("folder:sent", []), {
      source: {
        ...source,
        auth: { ...source.auth, hash: "e".repeat(64) },
      },
      provenance: provenance(2),
    })).toThrow("cannot cross source");
  });

  test("normalization frontiers isolate exact queries and retain last-good revisions", () => {
    const readyA = reduceOmniSourceStateV1(null, page("folder:inbox", [
      message("t4_a", "2026-08-01T00:00:01.000Z"),
    ]), { source, provenance: provenance(1) });
    const driftA = markOmniSourceDriftV1(readyA, {
      source,
      exactQueryKey: provenance(1).exactQueryKey,
      exactDataRevision: "d".repeat(64),
      failedAt: "2026-08-01T00:00:03.000Z",
      error: new Error("folder A drifted"),
    });
    const successfulB = reduceOmniSourceStateV1(driftA, page("folder:sent", [
      message("t4_b", "2026-08-01T00:00:02.000Z"),
    ]), { source, provenance: provenance(2) });
    expect(successfulB.normalization).toHaveLength(2);
    expect(successfulB.normalization.find((entry) =>
      entry.exactQueryKey === provenance(1).exactQueryKey)?.status).toMatchObject({
      state: "drift",
      exactDataRevision: "d".repeat(64),
      lastGoodExactDataRevision: provenance(1).exactDataRevision,
    });
    expect(successfulB.normalization.find((entry) =>
      entry.exactQueryKey === provenance(2).exactQueryKey)?.status).toMatchObject({
      state: "ready",
      exactDataRevision: provenance(2).exactDataRevision,
    });

    const readyBoth = reduceOmniSourceStateV1(readyA, page("folder:sent", [
      message("t4_b", "2026-08-01T00:00:02.000Z"),
    ]), { source, provenance: provenance(2) });
    const driftB = markOmniSourceDriftV1(readyBoth, {
      source,
      exactQueryKey: provenance(2).exactQueryKey,
      exactDataRevision: "e".repeat(64),
      failedAt: "2026-08-01T00:00:04.000Z",
      error: new Error("folder B drifted"),
    });
    expect(driftB.normalization.find((entry) =>
      entry.exactQueryKey === provenance(1).exactQueryKey)?.status.state).toBe(
      "ready",
    );
    expect(driftB.normalization.find((entry) =>
      entry.exactQueryKey === provenance(2).exactQueryKey)?.status).toMatchObject({
      state: "drift",
      lastGoodExactDataRevision: provenance(2).exactDataRevision,
    });

    const repeatedDrift = markOmniSourceDriftV1(driftB, {
      source,
      exactQueryKey: provenance(2).exactQueryKey,
      exactDataRevision: "f".repeat(64),
      failedAt: "2026-08-01T00:00:05.000Z",
      error: new Error("folder B still drifted"),
    });
    expect(repeatedDrift.normalization.find((entry) =>
      entry.exactQueryKey === provenance(2).exactQueryKey)?.status).toMatchObject({
      exactDataRevision: "f".repeat(64),
      lastGoodExactDataRevision: provenance(2).exactDataRevision,
    });
  });

  test("cross-version source snapshots choose the newest observation and reject revision conflicts", () => {
    const oldSource = {
      ...source,
      adapter: { ...source.adapter, hash: "d".repeat(64) },
    };
    const newSource = {
      ...source,
      adapter: { ...source.adapter, hash: "e".repeat(64) },
    };
    const oldState = reduceOmniSourceStateV1(null, page("folder:inbox", [
      { ...message("t4_same", "2026-08-01T00:00:01.000Z", "old"), providerRevision: "r1" },
    ]), { source: oldSource, provenance: provenance(1) });
    const newState = reduceOmniSourceStateV1(null, page("folder:inbox", [
      {
        ...message("t4_same", "2026-08-01T00:00:02.000Z", "new"),
        providerRevision: "r2",
        unread: false,
      },
    ]), { source: newSource, provenance: provenance(2) });
    expect(queryOmniSourceStatesV1([newState, oldState])[0]).toMatchObject({
      body: "new",
      providerRevision: "r2",
    });
    expect(queryOmniSourceStatesV1([oldState, newState], { unread: true }))
      .toEqual([]);
    expect(queryOmniSourceStatesV1([oldState, newState], { unread: false })[0])
      .toMatchObject({ body: "new", unread: false });

    const conflict = reduceOmniSourceStateV1(null, page("folder:inbox", [
      { ...message("t4_same", "2026-08-01T00:00:03.000Z", "conflict"), providerRevision: "r2" },
    ]), { source: oldSource, provenance: provenance(3) });
    expect(() => queryOmniSourceStatesV1([newState, conflict]))
      .toThrow("conflicting normalized bytes for one provider revision");
  });

  test("cross-state tombstones suppress older entities and fail closed on resurrection", () => {
    const oldSource = {
      ...source,
      adapter: { ...source.adapter, hash: "d".repeat(64) },
    };
    const newSource = {
      ...source,
      adapter: { ...source.adapter, hash: "e".repeat(64) },
    };
    const oldEntity = reduceOmniSourceStateV1(null, page("folder:inbox", [
      message("t4_deleted", "2026-08-01T00:00:01.000Z"),
    ]), { source: oldSource, provenance: provenance(1) });
    const tombstonePage = (providerRevision: string) => page(
      "folder:inbox",
      [],
      {
        tombstones: Object.freeze([Object.freeze({
          kind: "message" as const,
          providerId: "t4_deleted",
          providerRevision,
        })]),
      },
    );
    const deleted = reduceOmniSourceStateV1(
      null,
      tombstonePage("deleted-v1"),
      { source: newSource, provenance: provenance(2) },
    );
    expect(queryOmniSourceStatesV1([oldEntity, deleted])).toEqual([]);

    const resurrected = reduceOmniSourceStateV1(null, page("folder:inbox", [
      message("t4_deleted", "2026-08-01T00:00:03.000Z"),
    ]), { source: oldSource, provenance: provenance(3) });
    expect(() => queryOmniSourceStatesV1([deleted, resurrected])).toThrow(
      "entity observed after a tombstone",
    );

    const sameObservationEntity = reduceOmniSourceStateV1(
      null,
      page("folder:inbox", [
        message("t4_deleted", "2026-08-01T00:00:02.000Z"),
      ]),
      { source: oldSource, provenance: provenance(2) },
    );
    expect(() => queryOmniSourceStatesV1([
      sameObservationEntity,
      deleted,
    ])).toThrow("one exact observation");

    const conflictingTombstone = reduceOmniSourceStateV1(
      null,
      tombstonePage("deleted-v2"),
      { source: oldSource, provenance: provenance(2) },
    );
    expect(() => queryOmniSourceStatesV1([
      deleted,
      conflictingTombstone,
    ])).toThrow("conflicting entity or tombstone bytes");
  });

  test("persisted state reparsing detects semantic revision tampering", () => {
    const ready = reduceOmniSourceStateV1(null, page("folder:inbox", [
      message("t4_one", "2026-08-01T00:00:01.000Z"),
    ]), { source, provenance: provenance(1) });
    const tampered = structuredClone(ready);
    (tampered.entities[0]!.entity as unknown as { body: string }).body = "tampered";
    expect(() => parseOmniSourceStateV1(tampered)).toThrow("does not authenticate");

    const badMembership = structuredClone(ready);
    (badMembership.pages[0]!.orderedEntityIds as unknown as string[])[0] = "f".repeat(64);
    expect(() => parseOmniSourceStateV1(badMembership)).toThrow(
      "must not reference an unknown entity identity",
    );

    const invalidated = structuredClone(ready);
    Object.defineProperty(invalidated.normalization, "0", {
      value: {
        exactQueryKey: provenance(1).exactQueryKey,
        status: {
          state: "invalidated",
        },
      },
      enumerable: true,
    });
    expect(() => parseOmniSourceStateV1(invalidated)).toThrow(
      "must be one of ready, drift",
    );

    const drift = markOmniSourceDriftV1(ready, {
      source,
      exactQueryKey: provenance(1).exactQueryKey,
      exactDataRevision: "d".repeat(64),
      failedAt: "2026-08-01T00:00:06.000Z",
      error: new Error("shape drift"),
    });
    const missingLastGoodRevision = structuredClone(drift);
    Reflect.deleteProperty(
      missingLastGoodRevision.normalization[0]!.status,
      "lastGoodExactDataRevision",
    );
    expect(() => parseOmniSourceStateV1(missingLastGoodRevision)).toThrow(
      "must contain exactly",
    );
    const splitLastGood = structuredClone(drift);
    Object.defineProperty(
      splitLastGood.normalization[0]!.status,
      "lastGoodAt",
      { value: null, enumerable: true },
    );
    expect(() => parseOmniSourceStateV1(splitLastGood)).toThrow(
      "last-good time and exact data revision together",
    );
  });

  test("property: disjoint stable IDs merge associatively and idempotently", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u), {
        minLength: 1,
        maxLength: 20,
      }),
      (ids) => {
        const pages = ids.map((id, index) => ({
          value: page(`partition:${index}`, [message(
            id,
            `2026-08-01T00:01:${String(index).padStart(2, "0")}.000Z`,
          )]),
          provenance: provenance(index + 10),
        }));
        const forward = pages.reduce(
          (state, entry) => reduceOmniSourceStateV1(state, entry.value, {
            source,
            provenance: entry.provenance,
          }),
          null as ReturnType<typeof reduceOmniSourceStateV1> | null,
        );
        const reverse = [...pages].reverse().reduce(
          (state, entry) => reduceOmniSourceStateV1(state, entry.value, {
            source,
            provenance: entry.provenance,
          }),
          null as ReturnType<typeof reduceOmniSourceStateV1> | null,
        );
        expect(canonicalJson(forward)).toBe(canonicalJson(reverse));
      },
    ), { numRuns: 100 });
  });

  test("property: filters observe only the winning revision", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.boolean(),
      (oldUnread, newUnread) => {
        const oldSource = {
          ...source,
          adapter: { ...source.adapter, hash: "d".repeat(64) },
        };
        const newSource = {
          ...source,
          adapter: { ...source.adapter, hash: "e".repeat(64) },
        };
        const oldState = reduceOmniSourceStateV1(null, page("folder:inbox", [{
          ...message("t4_filter", "2026-08-01T00:00:01.000Z"),
          providerRevision: "r1",
          unread: oldUnread,
        }]), { source: oldSource, provenance: provenance(1) });
        const newState = reduceOmniSourceStateV1(null, page("folder:inbox", [{
          ...message("t4_filter", "2026-08-01T00:00:02.000Z"),
          providerRevision: "r2",
          unread: newUnread,
        }]), { source: newSource, provenance: provenance(2) });
        for (const states of [
          [oldState, newState],
          [newState, oldState],
        ] as const) {
          expect(queryOmniSourceStatesV1(states, { unread: true })).toHaveLength(
            newUnread ? 1 : 0,
          );
          expect(queryOmniSourceStatesV1(states, { unread: false })).toHaveLength(
            newUnread ? 0 : 1,
          );
        }
      },
    ), { numRuns: 100 });
  });
});
