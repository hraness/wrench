import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  initializeMessagingRun,
  readMessagingRun,
  updateMessagingRun,
} from "./messaging-action-store";
import { messagingTurnDigest, parseMessagingTurnV1 } from "./messaging-types";
import { sealAuthenticatedPrivatePayload } from "./read-projections";
import {
  invocationPlanDigest,
  loadInvocationPlan,
  messagingCompositeInputHash,
  readRunReceipt,
  repairInterruptedConfirmationClaims,
  saveInvocationPlan,
  type InvocationPlan,
  type RunReceipt,
  type StoredPlan,
} from "./runtime";
import {
  ensurePrivateStateDirectory,
  removePrivateStateFile,
  writePrivateJson,
} from "./storage";

const roots: string[] = [];
const routeRef = "wmroute_ABCDEFGHIJKLMNOPQRSTUV";
const contextRef = "wmcontext_ABCDEFGHIJKLMNOPQRSTUV";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state() {
  const root = mkdtempSync(join(tmpdir(), "wrench-messaging-confirmation-recovery-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return {
    root,
    environment: Object.freeze({ WRENCH_STATE_HOME: root }),
  };
}

function storedPlan(): StoredPlan {
  const turn = parseMessagingTurnV1({
    schemaVersion: 1,
    format: "wrench.messaging-turn",
    clientIntentSha256: "a".repeat(64),
    routeRef,
    contextRef,
    parts: [
      { partId: "part-1", text: "first private bubble", replyRef: null },
      { partId: "part-2", text: "second private bubble", replyRef: null },
    ],
  });
  const composite = {
    schemaVersion: 1 as const,
    format: "wrench.messaging-composite-invocation" as const,
    routeRef,
    contextRef,
    clientIntentSha256: turn.clientIntentSha256,
    contextBindingSha256: "8".repeat(64),
    sourceConversationCoordinateSha256: "9".repeat(64),
    turnDigest: messagingTurnDigest(turn),
    previewDigest: "0".repeat(64),
    contextLimit: 20,
    baseExactDataRevision: "b".repeat(64),
    baseLatestMessageRevision: "c".repeat(64),
    baseRouteStateRevision: "d".repeat(64),
    baseMessages: [],
    recipient: {
      network: "synthetic",
      conversation: {
        kind: "single" as const,
        title: "Exact Private Recipient",
        participantCount: 1,
      },
    },
    parts: turn.parts.map((part) => ({
      ...part,
      replyToProviderId: null,
      input: { text: part.text },
      inputHash: sha256(canonicalJson({ text: part.text })),
    })),
  };
  const plan: InvocationPlan = {
    schemaVersion: 4,
    transport: "web-session-api",
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-08-27T12:00:00.000Z",
    expiresAt: "2026-08-27T12:05:00.000Z",
    adapter: { id: "synthetic", version: "1.0.0", hash: "e".repeat(64) },
    operation: "messaging.send",
    risk: "R3",
    sideEffect: "submits the exact ordered messaging turn",
    input: { text: "first private bubble" },
    inputHash: messagingCompositeInputHash(composite),
    dispatches: [
      { id: "messaging.part[1]", description: "Submit ordered messaging turn part 1" },
      { id: "messaging.part[2]", description: "Submit ordered messaging turn part 2" },
    ],
    auth: { id: "synthetic-auth", hash: "1".repeat(64), kind: "cookie-source" },
    webSessionContract: {
      site: "synthetic",
      action: "messaging.send",
      version: 1,
      hash: "2".repeat(64),
    },
    messagingComposite: composite,
  };
  return Object.freeze({ digest: invocationPlanDigest(plan), plan });
}

function pendingReceipt(stored: StoredPlan, runId: string): RunReceipt {
  if (stored.plan.transport !== "web-session-api") {
    throw new Error("test fixture transport changed");
  }
  return Object.freeze({
    schemaVersion: 4,
    transport: "web-session-api",
    runId,
    planDigest: stored.digest,
    adapter: stored.plan.adapter,
    operation: stored.plan.operation,
    risk: stored.plan.risk,
    inputHash: stored.plan.inputHash,
    auth: stored.plan.auth,
    status: "pending",
    dispatchStarted: false,
    dispatch: Object.freeze({ planned: 2, started: 0, verified: 0 }),
    startedAt: "2026-08-27T12:00:00.000Z",
    finishedAt: "2026-08-27T12:00:00.000Z",
    finalOrigin: null,
    error: "messaging execution has no durable final outcome",
    webSessionContractHash: stored.plan.webSessionContract.hash,
  });
}

function deadClaim(digest: string, runId: string) {
  return Object.freeze({
    schemaVersion: 1,
    digest,
    runId,
    owner: Object.freeze({
      pid: 2_147_483_647,
      token: "123e4567-e89b-42d3-a456-426614174099",
      bootId: "0".repeat(64),
      processStartId: "0".repeat(64),
      leaseUntil: "2026-08-27T12:11:00.000Z",
    }),
    createdAt: "2026-08-27T12:00:00.000Z",
  });
}

function writePredecessorMessagingRun(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  run: ReturnType<typeof initializeMessagingRun>["run"],
): void {
  const {
    observedAcceptedPrefixCount: _legacyObservation,
    privateProviderOutcome: _laterPrivateOutcome,
    ...predecessor
  } = run;
  writePrivateJson(
    join(root, "messaging", "runs", `${run.runId}.json`),
    sealAuthenticatedPrivatePayload(
      predecessor,
      `wrench-messaging-run-v1:${run.runId}`,
      environment,
    ),
  );
}

describe("messaging confirmation crash recovery ordering", () => {
  for (const [name, receiptExists, planAlreadyRemoved, runId] of [
    [
      "run initialization before pending receipt",
      false,
      false,
      "123e4567-e89b-42d3-a456-426614174010",
    ],
    [
      "pending receipt before plan removal",
      true,
      false,
      "123e4567-e89b-42d3-a456-426614174011",
    ],
    [
      "plan removal before claim release",
      true,
      true,
      "123e4567-e89b-42d3-a456-426614174012",
    ],
  ] as const) {
    test(`consumes the elected plan after a crash at ${name}`, () => {
      const testState = state();
      const stored = storedPlan();
      const planPath = saveInvocationPlan(stored, testState.environment);
      const canonicalStateRoot = dirname(dirname(planPath));
      initializeMessagingRun(
        runId,
        stored.digest,
        stored.plan.messagingComposite!,
        testState.environment,
        "2026-08-27T12:00:00.000Z",
      );
      const receiptPath = join(canonicalStateRoot, "runs", `${runId}.json`);
      if (receiptExists) {
        ensurePrivateStateDirectory(dirname(receiptPath), testState.environment);
        writePrivateJson(receiptPath, pendingReceipt(stored, runId));
      }
      if (planAlreadyRemoved) {
        expect(removePrivateStateFile(planPath, testState.environment)).toBeTrue();
      }
      const claimPath = join(dirname(planPath), `${stored.digest}.claim.json`);
      writePrivateJson(claimPath, deadClaim(stored.digest, runId));

      expect(repairInterruptedConfirmationClaims(testState.environment)).toEqual({
        inspected: 1,
        released: 1,
        invalid: 0,
        active: 0,
      });

      expect(existsSync(planPath)).toBeFalse();
      expect(existsSync(claimPath)).toBeFalse();
      expect(() => loadInvocationPlan(stored.digest, testState.environment)).toThrow();
      expect(readMessagingRun(runId, testState.environment).run).toMatchObject({
        state: "failed",
        provenPartCount: 0,
        terminalReason: "journal-recovery-required",
      });
      expect(readRunReceipt(runId, testState.environment)).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 2, started: 0, verified: 0 },
        error: "messaging execution stopped: journal-recovery-required",
      });
      expect(repairInterruptedConfirmationClaims(testState.environment)).toEqual({
        inspected: 0,
        released: 0,
        invalid: 0,
        active: 0,
      });
    });
  }

  for (const [activeState, runId, expectedState, expectedStarted] of [
    [
      "unattempted",
      "123e4567-e89b-42d3-a456-426614174020",
      "partial",
      1,
    ],
    [
      "claimed",
      "123e4567-e89b-42d3-a456-426614174021",
      "partial",
      1,
    ],
    [
      "dispatching",
      "123e4567-e89b-42d3-a456-426614174022",
      "indeterminate",
      2,
    ],
  ] as const) {
    test(`repairs a predecessor ${activeState} run without dispatch or retry`, () => {
      const testState = state();
      const stored = storedPlan();
      const planPath = saveInvocationPlan(stored, testState.environment);
      let snapshot = initializeMessagingRun(
        runId,
        stored.digest,
        stored.plan.messagingComposite!,
        testState.environment,
        "2026-08-27T12:00:00.000Z",
      );
      snapshot = updateMessagingRun(snapshot, {
        type: "claimed",
        index: 0,
        observedAcceptedPrefixCount: 0,
        at: "2026-08-27T12:00:01.000Z",
      }, testState.environment);
      snapshot = updateMessagingRun(snapshot, {
        type: "dispatching",
        index: 0,
        at: "2026-08-27T12:00:02.000Z",
      }, testState.environment);
      snapshot = updateMessagingRun(snapshot, {
        type: "accepted",
        index: 0,
        providerMessageId: "accepted-before-upgrade",
        providerRevision: "revision-before-upgrade",
        at: "2026-08-27T12:00:03.000Z",
      }, testState.environment);
      if (activeState === "claimed" || activeState === "dispatching") {
        snapshot = updateMessagingRun(snapshot, {
          type: "claimed",
          index: 1,
          observedAcceptedPrefixCount: 1,
          at: "2026-08-27T12:00:04.000Z",
        }, testState.environment);
      }
      if (activeState === "dispatching") {
        snapshot = updateMessagingRun(snapshot, {
          type: "dispatching",
          index: 1,
          at: "2026-08-27T12:00:05.000Z",
        }, testState.environment);
      }
      writePredecessorMessagingRun(
        testState.root,
        testState.environment,
        snapshot.run,
      );
      const claimPath = join(dirname(planPath), `${stored.digest}.claim.json`);
      writePrivateJson(claimPath, deadClaim(stored.digest, runId));

      expect(repairInterruptedConfirmationClaims(testState.environment)).toEqual({
        inspected: 1,
        released: 1,
        invalid: 0,
        active: 0,
      });
      expect(readMessagingRun(runId, testState.environment).run).toMatchObject({
        state: expectedState,
        provenPartCount: 1,
        observedAcceptedPrefixCount: 1,
        terminalReason: "journal-recovery-required",
        parts: [
          { state: "accepted", providerMessageId: "accepted-before-upgrade" },
          { state: activeState === "dispatching" ? "indeterminate" : "failed-permanent" },
        ],
      });
      expect(readRunReceipt(runId, testState.environment)).toMatchObject({
        status: expectedState,
        dispatchStarted: true,
        dispatch: { planned: 2, started: expectedStarted, verified: 1 },
        error: "messaging execution stopped: journal-recovery-required",
      });
      expect(existsSync(planPath)).toBeFalse();
      expect(existsSync(claimPath)).toBeFalse();
      expect(repairInterruptedConfirmationClaims(testState.environment)).toEqual({
        inspected: 0,
        released: 0,
        invalid: 0,
        active: 0,
      });
    });
  }

  test("preserves private provider outcome while projecting a generic repaired receipt", () => {
    const testState = state();
    const stored = storedPlan();
    const planPath = saveInvocationPlan(stored, testState.environment);
    const canonicalStateRoot = dirname(dirname(planPath));
    const runId = "123e4567-e89b-42d3-a456-426614174013";
    let snapshot = initializeMessagingRun(
      runId,
      stored.digest,
      stored.plan.messagingComposite!,
      testState.environment,
      "2026-08-27T12:00:00.000Z",
    );
    snapshot = updateMessagingRun(snapshot, {
      type: "claimed",
      index: 0,
      observedAcceptedPrefixCount: 0,
      at: "2026-08-27T12:00:01.000Z",
    }, testState.environment);
    snapshot = updateMessagingRun(snapshot, {
      type: "dispatching",
      index: 0,
      at: "2026-08-27T12:00:02.000Z",
    }, testState.environment);
    snapshot = updateMessagingRun(snapshot, {
      type: "indeterminate",
      index: 0,
      reason: "provider-result-indeterminate",
      privateProviderOutcome: {
        schemaVersion: 1,
        messagingContractId: "wrench.provider-messaging.imessage-direct.v1",
        code: "unknown_post_dispatch",
      },
      at: "2026-08-27T12:00:03.000Z",
    }, testState.environment);
    const receiptPath = join(canonicalStateRoot, "runs", `${runId}.json`);
    ensurePrivateStateDirectory(dirname(receiptPath), testState.environment);
    writePrivateJson(receiptPath, pendingReceipt(stored, runId));
    const claimPath = join(dirname(planPath), `${stored.digest}.claim.json`);
    writePrivateJson(claimPath, deadClaim(stored.digest, runId));

    expect(repairInterruptedConfirmationClaims(testState.environment)).toEqual({
      inspected: 1,
      released: 1,
      invalid: 0,
      active: 0,
    });
    expect(readMessagingRun(runId, testState.environment).run.privateProviderOutcome)
      .toEqual(snapshot.run.privateProviderOutcome);
    const ordinaryReceipt = canonicalJson(readRunReceipt(runId, testState.environment));
    expect(ordinaryReceipt).not.toContain("unknown_post_dispatch");
    expect(ordinaryReceipt).not.toContain("imessage-direct");
    expect(ordinaryReceipt).toContain("provider-result-indeterminate");
    expect(existsSync(planPath)).toBeFalse();
    expect(existsSync(claimPath)).toBeFalse();
  });
});
