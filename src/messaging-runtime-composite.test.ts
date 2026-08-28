import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json";
import { messagingTurnDigest, parseMessagingTurnV1 } from "./messaging-types";
import {
  loadMessagingPreviewForConfirmationInternal,
  previewFromStoredMessagingPlan,
  verifyStoredMessagingPreview,
} from "./messaging-runtime";
import {
  invocationPlanDigest,
  loadInvocationPlan,
  messagingCompositeInputHash,
  saveInvocationPlan,
  type InvocationPlan,
  type StoredPlan,
} from "./runtime";
import { main } from "./wrench";

const routeRef = "wmroute_ABCDEFGHIJKLMNOPQRSTUV";
const contextRef = "wmcontext_ABCDEFGHIJKLMNOPQRSTUV";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state(): Readonly<Record<string, string | undefined>> {
  const root = mkdtempSync(join(tmpdir(), "wrench-messaging-preview-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { ...process.env, WRENCH_STATE_HOME: root };
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
      {
        partId: "part-2",
        text: "second private bubble",
        replyRef: "wmreply_ABCDEFGHIJKLMNOPQRSTUV",
      },
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
      conversation: { kind: "single" as const, title: "Exact Private Recipient", participantCount: 1 },
    },
    parts: turn.parts.map((part, index) => ({
      ...part,
      replyToProviderId: index === 0 ? null : "provider-reply-id",
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
    webSessionContract: { site: "synthetic", action: "messaging.send", version: 1, hash: "2".repeat(64) },
    messagingComposite: composite,
  };
  const provisional = { digest: invocationPlanDigest(plan), plan };
  const preview = previewFromStoredMessagingPlan(provisional);
  return {
    ...provisional,
    plan: {
      ...plan,
      messagingComposite: {
        ...composite,
        previewDigest: sha256(canonicalJson(preview)),
      },
    },
  };
}

describe("messaging composite preview binding", () => {
  test("reconstructs the exact private recipient and bubbles before accepting its hash", () => {
    const stored = storedPlan();
    const preview = verifyStoredMessagingPreview(stored);
    expect(preview.recipient.conversation.title).toBe("Exact Private Recipient");
    expect(preview.bubbles.map((bubble) => bubble.text)).toEqual([
      "first private bubble",
      "second private bubble",
    ]);
    expect(preview.planDigest).toBe(stored.digest);
  });

  test("rejects an authenticated but wrong preview digest or altered exact bubble", () => {
    const stored = storedPlan();
    expect(() => verifyStoredMessagingPreview({
      ...stored,
      plan: {
        ...stored.plan,
        messagingComposite: {
          ...stored.plan.messagingComposite!,
          previewDigest: "4".repeat(64),
        },
      },
    })).toThrow("does not match");
    expect(() => verifyStoredMessagingPreview({
      ...stored,
      plan: {
        ...stored.plan,
        messagingComposite: {
          ...stored.plan.messagingComposite!,
          parts: stored.plan.messagingComposite!.parts.map((part, index) =>
            index === 1 ? { ...part, text: "altered bubble" } : part),
        },
      },
    })).toThrow("does not match");
  });

  test("rechecks authenticated preview bytes and rejects identical private output paths", async () => {
    const validEnvironment = state();
    const stored = storedPlan();
    saveInvocationPlan(stored, validEnvironment);
    const outputRoot = mkdtempSync(join(tmpdir(), "wrench-messaging-preview-output-"));
    chmodSync(outputRoot, 0o700);
    roots.push(outputRoot);
    const privateOutput = join(outputRoot, "same.json");
    const stderr: string[] = [];
    expect(await main([
      "confirm",
      stored.digest,
      "--private-output",
      privateOutput,
      "--receipt-binding-output",
      privateOutput,
      "--json",
    ], validEnvironment, { stdout: () => {}, stderr: (value) => stderr.push(value) })).toBe(3);
    expect(stderr.join("")).toContain("distinct private output and receipt-binding paths");
    expect(loadInvocationPlan(stored.digest, validEnvironment)).toEqual(stored);
    expect(existsSync(privateOutput)).toBeFalse();

    const wrongEnvironment = state();
    const wrong = {
      ...stored,
      plan: {
        ...stored.plan,
        messagingComposite: {
          ...stored.plan.messagingComposite!,
          previewDigest: "4".repeat(64),
        },
      },
    } satisfies StoredPlan;
    saveInvocationPlan(wrong, wrongEnvironment);
    expect(() => loadMessagingPreviewForConfirmationInternal(
      wrong.digest,
      { environment: wrongEnvironment },
    )).toThrow("exact reconstructed artifact");
  });

  test("keeps only the circular preview hash outside the canonical confirmation digest", () => {
    const stored = storedPlan();
    const changedPreviewHash: InvocationPlan = {
      ...stored.plan,
      messagingComposite: {
        ...stored.plan.messagingComposite!,
        previewDigest: "5".repeat(64),
      },
    };
    const changedBody: InvocationPlan = {
      ...stored.plan,
      messagingComposite: {
        ...stored.plan.messagingComposite!,
        parts: stored.plan.messagingComposite!.parts.map((part, index) =>
          index === 0 ? { ...part, text: "different exact body" } : part),
      },
    };
    expect(invocationPlanDigest(changedPreviewHash)).toBe(invocationPlanDigest(stored.plan));
    expect(invocationPlanDigest(changedBody)).not.toBe(invocationPlanDigest(stored.plan));
  });
});
