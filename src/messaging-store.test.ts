import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadMessagingContextRecord,
  loadMessagingRouteRecord,
  purgeExpiredMessagingRecords,
  saveMessagingContextRecord,
  saveMessagingRouteRecord,
  type MessagingContextRecordV1,
  type MessagingRouteRecordV1,
} from "./messaging-store";

const roots: string[] = [];
const beforeExpiry = new Date("2026-08-27T12:10:00.000Z");
const afterExpiry = new Date("2026-08-27T12:16:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state(): {
  readonly root: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-messaging-store-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { root, environment: { ...process.env, WRENCH_STATE_HOME: root } };
}

function route(reference = "wmroute_ABCDEFGHIJKLMNOPQRSTUV"): MessagingRouteRecordV1 {
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-route-record",
    routeRef: reference,
    createdAt: "2026-08-27T12:00:00.000Z",
    expiresAt: "2026-08-27T12:15:00.000Z",
    adapter: Object.freeze({ id: "beeper", version: "1.0.0", hash: "a".repeat(64) }),
    plugin: Object.freeze({ id: "beeper-linked-device", version: "2.0.0", closureHash: "b".repeat(64) }),
    binding: Object.freeze({
      surfaceId: "beeper",
      transport: "local-cli",
      implementationIdentity: "c".repeat(64),
      messagingContractId: "wrench.provider-messaging.beeper.v1",
    }),
    auth: Object.freeze({
      id: "beeper-main",
      hash: "d".repeat(64),
      subject: "secret-account-subject",
    }),
    list: Object.freeze({
      operation: "messaging.list",
      input: Object.freeze({ account_id: "secret-account-coordinate", limit: 1 }),
      inputHash: "e".repeat(64),
      exactDataRevision: "f".repeat(64),
      validatedAt: "2026-08-27T12:00:00.000Z",
    }),
    target: Object.freeze({
      accountId: "secret-account-coordinate",
      conversationId: "secret-provider-conversation",
    }),
    resolution: "exact-coordinate",
    network: "imessage",
    sourceConversationCoordinate: Object.freeze({
      contractId: "wrench.message-like-me.source-conversation-coordinate.v1",
      schemaVersion: 1,
      sha256: "5".repeat(64),
    }),
    conversationProviderId: "secret-provider-conversation",
    conversation: Object.freeze({
      kind: "single",
      title: "Secret Recipient Title",
      participantCount: 1,
      participantFingerprint: "1".repeat(64),
      providerRevision: "secret-provider-revision",
    }),
  });
}

function context(reference = "wmcontext_ABCDEFGHIJKLMNOPQRSTUV"): MessagingContextRecordV1 {
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context-record",
    contextRef: reference,
    routeRef: "wmroute_ABCDEFGHIJKLMNOPQRSTUV",
    routeRecordHash: "2".repeat(64),
    sourceConversationCoordinate: Object.freeze({
      contractId: "wrench.message-like-me.source-conversation-coordinate.v1",
      schemaVersion: 1,
      sha256: "5".repeat(64),
    }),
    exactDataRevision: "3".repeat(64),
    latestMessageRevision: "4".repeat(64),
    validatedAt: "2026-08-27T12:00:00.000Z",
    expiresAt: "2026-08-27T12:15:00.000Z",
    limit: 20,
    liveness: "fresh-as-of-live-preflight",
    replyTargets: Object.freeze({
      wmreply_ABCDEFGHIJKLMNOPQRSTUV: "secret-provider-message-id",
    }),
  });
}

describe("encrypted messaging capability records", () => {
  test("encrypts private coordinates, authenticates reference replay, and is immutable", () => {
    const testState = state();
    const first = route();
    const second = route("wmroute_ZYXWVUTSRQPONMLKJIHGFE");
    saveMessagingRouteRecord(first, testState.environment);
    saveMessagingRouteRecord(second, testState.environment);
    const firstPath = join(testState.root, "messaging", "routes", `${first.routeRef}.json`);
    const secondPath = join(testState.root, "messaging", "routes", `${second.routeRef}.json`);
    const encrypted = readFileSync(firstPath, "utf8");
    expect(encrypted).toContain('"encryption":"aes-256-gcm"');
    expect(encrypted).not.toContain("secret-account-coordinate");
    expect(encrypted).not.toContain("Secret Recipient Title");
    expect(loadMessagingRouteRecord(first.routeRef, testState.environment, beforeExpiry))
      .toEqual(first);
    expect(() => saveMessagingRouteRecord(first, testState.environment))
      .toThrow("already exists");
    writeFileSync(secondPath, encrypted, { mode: 0o600 });
    expect(() => loadMessagingRouteRecord(
      second.routeRef,
      testState.environment,
      beforeExpiry,
    )).toThrow("failed authentication");
  });

  test("enforces load-time expiry and garbage-collects only expired valid records", () => {
    const testState = state();
    const routeRecord = route();
    const contextRecord = context();
    saveMessagingRouteRecord(routeRecord, testState.environment);
    saveMessagingContextRecord(contextRecord, testState.environment);
    expect(loadMessagingContextRecord(
      contextRecord.contextRef,
      testState.environment,
      beforeExpiry,
    )).toEqual(contextRecord);
    expect(() => loadMessagingRouteRecord(
      routeRecord.routeRef,
      testState.environment,
      afterExpiry,
    )).toThrow("expired");
    expect(() => loadMessagingContextRecord(
      contextRecord.contextRef,
      testState.environment,
      afterExpiry,
    )).toThrow("expired");
    expect(purgeExpiredMessagingRecords(testState.environment, afterExpiry)).toEqual({
      routes: 1,
      contexts: 1,
    });
    expect(existsSync(join(
      testState.root,
      "messaging",
      "routes",
      `${routeRecord.routeRef}.json`,
    ))).toBeFalse();
    expect(existsSync(join(
      testState.root,
      "messaging",
      "contexts",
      `${contextRecord.contextRef}.json`,
    ))).toBeFalse();
  });
});
