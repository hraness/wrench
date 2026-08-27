import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "./canonical-json";
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
    const raw = readFileSync(join(testState.root, "messaging", "runs", `${runId}.json`), "utf8");
    expect(raw).toContain('"encryption":"aes-256-gcm"');
    expect(raw).not.toContain("private first body");
    expect(raw).not.toContain("wmroute_");
    const claimed = updateMessagingRun(first, {
      type: "claimed",
      index: 0,
      at: "2026-08-27T12:00:01.000Z",
    }, testState.environment);
    expect(claimed.run.parts[0]!.state).toBe("claimed");
    expect(() => updateMessagingRun(first, {
      type: "claimed",
      index: 0,
      at: "2026-08-27T12:00:02.000Z",
    }, testState.environment)).toThrow("changed concurrently");
    expect(readMessagingRun(runId, testState.environment).run).toEqual(claimed.run);
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
      type: "claimed", index, at: at(second),
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
    expect(binding.routeRefSha256).not.toContain("wmroute");
    expect(messagingRunReceipt(submitted).receiptBindingSha256).toBe(binding.receiptSha256);
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
