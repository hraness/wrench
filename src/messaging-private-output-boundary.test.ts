import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeMessagingRun } from "./messaging-action-store";
import {
  reserveMessagingPrivateOutputPair,
  writeMessagingPrivateOutput,
  writeReservedMessagingPrivateOutput,
} from "./messaging-runtime";
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

function thrownError(callback: () => void): Error {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected callback to throw");
}

function errorChainText(error: Error): string {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

describe("messaging private output state boundary", () => {
  test("physically reserves both body-free sinks before either final export", () => {
    const testState = state();
    const runId = "123e4567-e89b-42d3-a456-426614174099";
    const snapshot = initializeMessagingRun(
      runId,
      "7".repeat(64),
      plan(),
      testState.environment,
      "2026-08-27T12:00:00.000Z",
    );
    const outputRoot = mkdtempSync(join(tmpdir(), "wrench-messaging-reservations-"));
    chmodSync(outputRoot, 0o700);
    roots.push(outputRoot);
    const runPath = join(outputRoot, "run.json");
    const bindingPath = join(outputRoot, "binding.json");
    const reservations = reserveMessagingPrivateOutputPair(
      runPath,
      bindingPath,
      testState.environment,
    );

    for (const path of [runPath, bindingPath]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const marker = readFileSync(path, "utf8");
      expect(marker).toContain("wrench.messaging-private-output-reservation");
      expect(marker).not.toContain("private first body");
    }
    const existingSinkError = thrownError(() => reserveMessagingPrivateOutputPair(
      runPath,
      join(outputRoot, "another-binding.json"),
      testState.environment,
    ));
    expect(existingSinkError.message).toContain("already exists");
    expect(errorChainText(existingSinkError)).not.toContain(runPath);

    writeReservedMessagingPrivateOutput(
      reservations.run,
      snapshot.run,
      testState.environment,
    );
    expect(readFileSync(runPath, "utf8")).toContain("private first body");
    const tamperedRunPath = join(outputRoot, "tampered-run.json");
    const tampered = reserveMessagingPrivateOutputPair(
      tamperedRunPath,
      join(outputRoot, "tampered-binding.json"),
      testState.environment,
    );
    writeFileSync(tamperedRunPath, "{}\n", { mode: 0o600 });
    const changedReservationError = thrownError(() => writeReservedMessagingPrivateOutput(
      tampered.run,
      snapshot.run,
      testState.environment,
    ));
    expect(changedReservationError.message).toContain("reservation changed");
    expect(errorChainText(changedReservationError)).not.toContain(tamperedRunPath);

    const strandedRunPath = join(outputRoot, "stranded-run.json");
    const occupiedBindingPath = join(outputRoot, "occupied-binding.json");
    writeFileSync(occupiedBindingPath, "occupied\n", { mode: 0o600 });
    const pairReservationError = thrownError(() => reserveMessagingPrivateOutputPair(
      strandedRunPath,
      occupiedBindingPath,
      testState.environment,
    ));
    expect(pairReservationError.message).toContain("failed physical reservation");
    expect(errorChainText(pairReservationError)).not.toContain(strandedRunPath);
    expect(errorChainText(pairReservationError)).not.toContain(occupiedBindingPath);
  });

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
