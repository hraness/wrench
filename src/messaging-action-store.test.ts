import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json";
import { assertProperty, fc } from "./test-support";
import {
  initializeMessagingRun,
  messagingExpectedOwnPrefix,
  messagingReceiptBinding,
  messagingRunReceipt,
  parseMessagingRunV1,
  readMessagingRun,
  transitionMessagingRun,
  updateMessagingRun,
} from "./messaging-action-store";
import type { MessagingCompositeInvocationPlanV1 } from "./runtime";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state() {
  const root = mkdtempSync(join(tmpdir(), "wrench-messaging-action-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { root, environment: { WRENCH_STATE_HOME: root } };
}

function plan(): MessagingCompositeInvocationPlanV1 {
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-composite-invocation",
    routeRef: "wmroute_ABCDEFGHIJKLMNOPQRSTUV",
    contextRef: "wmcontext_ABCDEFGHIJKLMNOPQRSTUV",
    clientIntentSha256: "a".repeat(64),
    contextBindingSha256: "8".repeat(64),
    sourceConversationCoordinateSha256: "9".repeat(64),
    turnDigest: "b".repeat(64),
    previewDigest: "c".repeat(64),
    contextLimit: 20,
    baseExactDataRevision: "d".repeat(64),
    baseLatestMessageRevision: "e".repeat(64),
    baseRouteStateRevision: "f".repeat(64),
    baseMessages: Object.freeze([]),
    recipient: Object.freeze({
      network: "synthetic",
      conversation: Object.freeze({ kind: "single", title: "Private Recipient", participantCount: 1 }),
    }),
    parts: Object.freeze([
      Object.freeze({
        partId: "part-1",
        text: "private first body",
        replyRef: null,
        replyToProviderId: null,
        input: Object.freeze({ text: "private first body" }),
        inputHash: "1".repeat(64),
      }),
      Object.freeze({
        partId: "part-2",
        text: "private second body",
        replyRef: "wmreply_ABCDEFGHIJKLMNOPQRSTUV",
        replyToProviderId: "provider-reply-id",
        input: Object.freeze({ text: "private second body", reply_to: "provider-reply-id" }),
        inputHash: "2".repeat(64),
      }),
    ]),
  });
}

function threePartPlan(): MessagingCompositeInvocationPlanV1 {
  const base = plan();
  return Object.freeze({
    ...base,
    parts: Object.freeze([
      ...base.parts,
      Object.freeze({
        partId: "part-3",
        text: "private third body",
        replyRef: null,
        replyToProviderId: null,
        input: Object.freeze({ text: "private third body" }),
        inputHash: "3".repeat(64),
      }),
    ]),
  });
}

const runId = "123e4567-e89b-42d3-a456-426614174000";
const startedAt = "2026-08-27T12:00:00.000Z";

describe("messaging composite run journal", () => {
  test("encrypts exact parts and enforces CAS updates", () => {
    const testState = state();
    const first = initializeMessagingRun(
      runId,
      "9".repeat(64),
      plan(),
      testState.environment,
      startedAt,
    );
    expect(first.run.observedAcceptedPrefixCount).toBe(0);
    const raw = readFileSync(join(testState.root, "messaging", "runs", `${runId}.json`), "utf8");
    expect(raw).toContain('"encryption":"aes-256-gcm"');
    expect(raw).not.toContain("private first body");
    expect(raw).not.toContain("wmroute_");
    const claimed = updateMessagingRun(first, {
      type: "claimed",
      index: 0,
      observedAcceptedPrefixCount: 0,
      at: "2026-08-27T12:00:01.000Z",
    }, testState.environment);
    expect(claimed.run.parts[0]!.state).toBe("claimed");
    expect(() => updateMessagingRun(first, {
      type: "claimed",
      index: 0,
      observedAcceptedPrefixCount: 0,
      at: "2026-08-27T12:00:02.000Z",
    }, testState.environment)).toThrow("changed concurrently");
    expect(readMessagingRun(runId, testState.environment).run).toEqual(claimed.run);
  });

  test("persists only monotonic accepted-prefix observations before dispatch", () => {
    const base = initializeMessagingRun(
      runId,
      "9".repeat(64),
      threePartPlan(),
      state().environment,
      startedAt,
    ).run;
    const claim = (
      run: typeof base,
      index: number,
      observedAcceptedPrefixCount: number,
      second: number,
    ) => transitionMessagingRun(run, {
      type: "claimed",
      index,
      observedAcceptedPrefixCount,
      at: `2026-08-27T12:00:0${second}.000Z`,
    });
    const dispatch = (run: typeof base, index: number, second: number) =>
      transitionMessagingRun(run, {
        type: "dispatching",
        index,
        at: `2026-08-27T12:00:0${second}.000Z`,
      });
    const accept = (run: typeof base, index: number, second: number) =>
      transitionMessagingRun(run, {
        type: "accepted",
        index,
        providerMessageId: `provider-${index + 1}`,
        providerRevision: `revision-${index + 1}`,
        at: `2026-08-27T12:00:0${second}.000Z`,
      });

    expect(() => claim(base, 0, 1, 1)).toThrow("not monotonic");
    const acceptedFirst = accept(dispatch(claim(base, 0, 0, 1), 0, 2), 0, 3);
    const acceptedSecond = accept(
      dispatch(claim(acceptedFirst, 1, 1, 4), 1, 5),
      1,
      6,
    );
    expect(acceptedSecond.observedAcceptedPrefixCount).toBe(1);
    expect(() => claim(acceptedSecond, 2, 0, 7)).toThrow("not monotonic");
    expect(() => claim(acceptedSecond, 2, 3, 7)).toThrow("not monotonic");
    expect(claim(acceptedSecond, 2, 2, 7).observedAcceptedPrefixCount).toBe(2);

    assertProperty(fc.property(
      fc.integer({ min: -2, max: 4 }),
      (candidate) => {
        const transition = () => claim(acceptedSecond, 2, candidate, 7);
        if (candidate >= 1 && candidate <= 2) {
          expect(transition().observedAcceptedPrefixCount).toBe(candidate);
        } else {
          expect(transition).toThrow("not monotonic");
        }
      },
    ));
  });

  test("normalizes the exact predecessor terminal run to a conservative prefix high-water", () => {
    const initial = initializeMessagingRun(
      runId,
      "9".repeat(64),
      plan(),
      state().environment,
      startedAt,
    ).run;
    const claimedFirst = transitionMessagingRun(initial, {
      type: "claimed",
      index: 0,
      observedAcceptedPrefixCount: 0,
      at: "2026-08-27T12:00:01.000Z",
    });
    const dispatchingFirst = transitionMessagingRun(claimedFirst, {
      type: "dispatching",
      index: 0,
      at: "2026-08-27T12:00:02.000Z",
    });
    const acceptedFirst = transitionMessagingRun(dispatchingFirst, {
      type: "accepted",
      index: 0,
      providerMessageId: "provider-1",
      providerRevision: "revision-provider-1",
      at: "2026-08-27T12:00:03.000Z",
    });
    const claimedSecond = transitionMessagingRun(acceptedFirst, {
      type: "claimed",
      index: 1,
      observedAcceptedPrefixCount: 1,
      at: "2026-08-27T12:00:04.000Z",
    });
    const dispatchingSecond = transitionMessagingRun(claimedSecond, {
      type: "dispatching",
      index: 1,
      at: "2026-08-27T12:00:05.000Z",
    });
    const submitted = transitionMessagingRun(dispatchingSecond, {
      type: "accepted",
      index: 1,
      providerMessageId: "provider-2",
      providerRevision: "revision-provider-2",
      at: "2026-08-27T12:00:06.000Z",
    });
    const {
      observedAcceptedPrefixCount: _legacyObservation,
      privateProviderOutcome: _laterPrivateOutcome,
      ...predecessor
    } = submitted;

    expect(parseMessagingRunV1(predecessor)).toMatchObject({
      state: "submitted",
      provenPartCount: 2,
      observedAcceptedPrefixCount: 2,
      privateProviderOutcome: null,
    });
  });

  test("implements all four frozen proven-prefix terminal states", () => {
    const base = initializeMessagingRun(
      runId,
      "9".repeat(64),
      plan(),
      state().environment,
      startedAt,
    ).run;
    const at = (second: number) => `2026-08-27T12:00:0${second}.000Z`;
    const claim = (run: typeof base, index: number, second: number) => transitionMessagingRun(run, {
      type: "claimed", index, observedAcceptedPrefixCount: index, at: at(second),
    });
    const dispatch = (run: typeof base, index: number, second: number) => transitionMessagingRun(run, {
      type: "dispatching", index, at: at(second),
    });
    const accept = (run: typeof base, index: number, id: string, second: number) => transitionMessagingRun(run, {
      type: "accepted", index, providerMessageId: id, providerRevision: `revision-${id}`, at: at(second),
    });

    const failed = transitionMessagingRun(claim(base, 0, 1), {
      type: "categorical-stop",
      index: 0,
      partState: "failed-before-dispatch",
      reason: "provider-failed-before-dispatch",
      at: at(2),
    });
    expect([failed.state, failed.provenPartCount]).toEqual(["failed", 0]);

    const acceptedFirst = accept(dispatch(claim(base, 0, 1), 0, 2), 0, "provider-1", 3);
    const partial = transitionMessagingRun(claim(acceptedFirst, 1, 4), {
      type: "categorical-stop",
      index: 1,
      partState: "failed-permanent",
      reason: "context-drift",
      at: at(5),
    });
    expect([partial.state, partial.provenPartCount]).toEqual(["partial", 1]);

    const indeterminate = transitionMessagingRun(dispatch(claim(acceptedFirst, 1, 4), 1, 5), {
      type: "indeterminate",
      index: 1,
      reason: "provider-result-indeterminate",
      privateProviderOutcome: null,
      at: at(6),
    });
    expect([indeterminate.state, indeterminate.provenPartCount, indeterminate.possibleSubmittedPartIndex])
      .toEqual(["indeterminate", 1, 1]);

    const submitted = accept(
      dispatch(claim(acceptedFirst, 1, 4), 1, 5),
      1,
      "provider-2",
      6,
    );
    expect([submitted.state, submitted.provenPartCount]).toEqual(["submitted", 2]);
    expect(submitted.parts[0]).toMatchObject({
      providerMessageId: "provider-1",
      providerRevision: "revision-provider-1",
      direction: "outgoing",
      replyToProviderId: null,
    });
    expect(submitted.parts[0]!.bodySha256).toBe(sha256("private first body"));
    expect(submitted.parts[1]).toMatchObject({
      providerMessageId: "provider-2",
      providerRevision: "revision-provider-2",
      direction: "outgoing",
      replyToProviderId: "provider-reply-id",
    });
    expect(messagingExpectedOwnPrefix(submitted)).toEqual([
      {
        providerMessageId: "provider-1",
        providerRevision: "revision-provider-1",
        direction: "outgoing",
        bodySha256: sha256("private first body"),
        replyToProviderId: null,
      },
      {
        providerMessageId: "provider-2",
        providerRevision: "revision-provider-2",
        direction: "outgoing",
        bodySha256: sha256("private second body"),
        replyToProviderId: "provider-reply-id",
      },
    ]);
    const binding = messagingReceiptBinding(submitted);
    expect(binding.state).toBe("submitted");
    expect(binding.contextBindingSha256).toBe(plan().contextBindingSha256);
    expect(binding.sourceConversationCoordinateSha256)
      .toBe(plan().sourceConversationCoordinateSha256);
    expect(binding.routeRefSha256).not.toContain("wmroute");
    expect(messagingRunReceipt(submitted)).toMatchObject({
      contextBindingSha256: plan().contextBindingSha256,
      sourceConversationCoordinateSha256:
        plan().sourceConversationCoordinateSha256,
      receiptBindingSha256: binding.receiptSha256,
    });
  });

  test("retains bounded private provider outcomes only in the encrypted run", () => {
    const testState = state();
    const initial = initializeMessagingRun(
      runId,
      "9".repeat(64),
      plan(),
      testState.environment,
      startedAt,
    );
    const claimed = updateMessagingRun(initial, {
      type: "claimed",
      index: 0,
      observedAcceptedPrefixCount: 0,
      at: "2026-08-27T12:00:01.000Z",
    }, testState.environment);
    const dispatching = updateMessagingRun(claimed, {
      type: "dispatching",
      index: 0,
      at: "2026-08-27T12:00:02.000Z",
    }, testState.environment);
    const privateProviderOutcome = Object.freeze({
      schemaVersion: 1 as const,
      messagingContractId: "wrench.provider-messaging.imessage-direct.v1",
      code: "still_in_flight",
    });
    const terminal = updateMessagingRun(dispatching, {
      type: "indeterminate",
      index: 0,
      reason: "provider-result-indeterminate",
      privateProviderOutcome,
      at: "2026-08-27T12:00:03.000Z",
    }, testState.environment);
    expect(terminal.run.privateProviderOutcome).toEqual(privateProviderOutcome);
    expect(readMessagingRun(runId, testState.environment).run.privateProviderOutcome)
      .toEqual(privateProviderOutcome);

    const encrypted = readFileSync(
      join(testState.root, "messaging", "runs", `${runId}.json`),
      "utf8",
    );
    expect(encrypted).not.toContain("still_in_flight");
    expect(encrypted).not.toContain("imessage-direct");
    const ordinaryReceipts = canonicalJson({
      receipt: messagingRunReceipt(terminal.run),
      receiptBinding: messagingReceiptBinding(terminal.run),
    });
    expect(ordinaryReceipts).not.toContain("still_in_flight");
    expect(ordinaryReceipts).not.toContain("imessage-direct");

    const { privateProviderOutcome: _legacyMissing, ...legacy } = initial.run;
    expect(parseMessagingRunV1(legacy).privateProviderOutcome).toBeNull();
    expect(() => transitionMessagingRun(dispatching.run, {
      type: "indeterminate",
      index: 0,
      reason: "provider-result-indeterminate",
      privateProviderOutcome: {
        ...privateProviderOutcome,
        code: "private body must not fit",
      },
      at: "2026-08-27T12:00:03.000Z",
    })).toThrow("private provider outcome");
    expect(() => parseMessagingRunV1({
      ...initial.run,
      privateProviderOutcome,
    })).toThrow("private provider outcome is contradictory");
  });

  test("strictly rejects extra fields, null accepted IDs, and impossible prefix vectors", () => {
    const testState = state();
    const base = initializeMessagingRun(
      runId,
      "9".repeat(64),
      plan(),
      testState.environment,
      startedAt,
    ).run;
    expect(() => parseMessagingRunV1({ ...base, unexpected: true })).toThrow("unsupported fields");
    const { observedAcceptedPrefixCount: _omitted, ...withoutObservation } = base;
    expect(() => parseMessagingRunV1(withoutObservation)).toThrow("unsupported fields");
    expect(() => parseMessagingRunV1({
      ...base,
      observedAcceptedPrefixCount: -1,
    })).toThrow("malformed");
    expect(() => parseMessagingRunV1({
      ...base,
      observedAcceptedPrefixCount: 1,
    })).toThrow("malformed");
    expect(() => parseMessagingRunV1({
      ...base,
      state: "submitted",
      provenPartCount: 2,
      parts: base.parts.map((part) => ({
        ...part,
        state: "accepted",
        providerMessageId: null,
        providerRevision: null,
      })),
    })).toThrow("part is malformed");
    expect(() => parseMessagingRunV1({
      ...base,
      state: "submitted",
      provenPartCount: 2,
      parts: base.parts.map((part) => ({
        ...part,
        state: "accepted",
        providerMessageId: "reused-provider-id",
        providerRevision: "reused-provider-revision",
      })),
    })).toThrow("ordered-prefix invariant");
    expect(() => parseMessagingRunV1({
      ...base,
      parts: base.parts.map((part, index) => index === 0
        ? { ...part, bodySha256: "0".repeat(64) }
        : part),
    })).toThrow("body digest disagrees");
    expect(() => parseMessagingRunV1({
      ...base,
      recordedAt: "2026-08-27T12:00:00Z",
    })).toThrow("timestamp is malformed");
    const sparseParts = [...base.parts] as unknown[];
    delete sparseParts[1];
    expect(() => parseMessagingRunV1({ ...base, parts: sparseParts }))
      .toThrow("dense array");
    expect(() => parseMessagingRunV1({
      ...base,
      state: "indeterminate",
      provenPartCount: 2,
      possibleSubmittedPartIndex: 2,
    })).toThrow("malformed");
  });
});
