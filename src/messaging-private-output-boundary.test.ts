import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeMessagingRun } from "./messaging-action-store";
import { writeMessagingPrivateOutput } from "./messaging-runtime";
import type { MessagingCompositeInvocationPlanV1 } from "./runtime";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state() {
  const root = mkdtempSync(join(tmpdir(), "wrench-messaging-output-boundary-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return {
    root,
    environment: Object.freeze({ WRENCH_STATE_HOME: root }),
  };
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
      conversation: Object.freeze({
        kind: "single",
        title: "Private Recipient",
        participantCount: 1,
      }),
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
    ]),
  });
}

describe("messaging private output state boundary", () => {
  test("cannot overwrite encrypted journals or root encryption keys with plaintext artifacts", () => {
    const testState = state();
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const snapshot = initializeMessagingRun(
      runId,
      "9".repeat(64),
      plan(),
      testState.environment,
      "2026-08-27T12:00:00.000Z",
    );
    const runPath = join(testState.root, "messaging", "runs", `${runId}.json`);
    const keyPath = join(testState.root, ".projection-encryption-key");
    const runBytes = readFileSync(runPath);
    const keyBytes = readFileSync(keyPath);

    expect(() => writeMessagingPrivateOutput(
      runPath,
      snapshot.run,
      testState.environment,
    )).toThrow("outside WRENCH_STATE_HOME");
    expect(() => writeMessagingPrivateOutput(
      keyPath,
      snapshot.run,
      testState.environment,
    )).toThrow("outside WRENCH_STATE_HOME");
    expect(() => writeMessagingPrivateOutput(
      join(testState.root, "new-private-output.json"),
      snapshot.run,
      testState.environment,
    )).toThrow("outside WRENCH_STATE_HOME");

    expect(readFileSync(runPath)).toEqual(runBytes);
    expect(readFileSync(keyPath)).toEqual(keyBytes);
  });

  test("rejects an outside symlink whose target is inside the state root", () => {
    const testState = state();
    const runId = "123e4567-e89b-42d3-a456-426614174001";
    const snapshot = initializeMessagingRun(
      runId,
      "8".repeat(64),
      plan(),
      testState.environment,
      "2026-08-27T12:00:00.000Z",
    );
    const outside = mkdtempSync(join(tmpdir(), "wrench-messaging-output-alias-"));
    chmodSync(outside, 0o700);
    roots.push(outside);
    const alias = join(outside, "state-alias");
    symlinkSync(testState.root, alias, "dir");

    expect(() => writeMessagingPrivateOutput(
      join(alias, "private-output.json"),
      snapshot.run,
      testState.environment,
    )).toThrow();
  });
});
