import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  MESSAGING_CONTEXT_BINDING_CONTRACT_DESCRIPTOR,
  MESSAGING_CONTEXT_BINDING_CONTRACT_HASH,
  MESSAGING_RECEIPT_BINDING_CONTRACT_DESCRIPTOR,
  MESSAGING_RECEIPT_BINDING_CONTRACT_HASH,
  messagingTurnDigest,
  parseMessagingRouteResolveRequestV1,
  parseMessagingReceiptBindingV1,
  parseMessagingTurnV1,
} from "./messaging-types";

const routeRef = "wmroute_ABCDEFGHIJKLMNOPQRSTUV";
const contextRef = "wmcontext_ABCDEFGHIJKLMNOPQRSTUV";

describe("provider-neutral messaging contracts", () => {
  test("freezes the cross-repository context and receipt descriptors", () => {
    expect(canonicalJson(MESSAGING_CONTEXT_BINDING_CONTRACT_DESCRIPTOR)).toBe(
      '{"contractId":"wrench.messaging-context-binding.v1","fields":["schemaVersion:1","format:wrench.messaging-context-binding","contractId:wrench.messaging-context-binding.v1","contractHash:sha256","sourceConversationCoordinate:{contractId,schemaVersion,sha256}","routeRef:opaque","contextRef:opaque","exactDataRevision:sha256","latestMessageRevision:sha256","validatedAt:rfc3339","expiresAt:rfc3339"],"format":"wrench.messaging-contract-descriptor","schemaVersion":1}',
    );
    expect(sha256(canonicalJson(MESSAGING_CONTEXT_BINDING_CONTRACT_DESCRIPTOR)))
      .toBe(MESSAGING_CONTEXT_BINDING_CONTRACT_HASH);
    expect(canonicalJson(MESSAGING_RECEIPT_BINDING_CONTRACT_DESCRIPTOR)).toBe(
      '{"contractId":"wrench.messaging-receipt-binding.v1","fields":["schemaVersion:1","format:wrench.messaging-receipt-binding","contractId:wrench.messaging-receipt-binding.v1","contractHash:sha256","clientIntentSha256:sha256","contextBindingSha256:sha256","sourceConversationCoordinateSha256:sha256","routeRefSha256:sha256","contextRefSha256:sha256","turnDigest:sha256","previewDigest:sha256","runId:opaque","state:submitted|failed|partial|indeterminate","partCount:uint","provenPartCount:uint","receiptSha256:sha256","recordedAt:rfc3339"],"format":"wrench.messaging-contract-descriptor","schemaVersion":1}',
    );
    expect(sha256(canonicalJson(MESSAGING_RECEIPT_BINDING_CONTRACT_DESCRIPTOR)))
      .toBe(MESSAGING_RECEIPT_BINDING_CONTRACT_HASH);
  });

  test("freezes the canonical client-intent-bound turn digest", () => {
    const turn = parseMessagingTurnV1({
      schemaVersion: 1,
      format: "wrench.messaging-turn",
      clientIntentSha256: "a".repeat(64),
      routeRef,
      contextRef,
      parts: [{ partId: "part-1", text: "hello\nthere", replyRef: null }],
    });
    expect(canonicalJson(turn)).toBe(
      String.raw`{"clientIntentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contextRef":"wmcontext_ABCDEFGHIJKLMNOPQRSTUV","format":"wrench.messaging-turn","parts":[{"partId":"part-1","replyRef":null,"text":"hello\nthere"}],"routeRef":"wmroute_ABCDEFGHIJKLMNOPQRSTUV","schemaVersion":1}`,
    );
    expect(messagingTurnDigest(turn)).toBe(
      "041938fee352c9f77e4876bcdbcc7d8138473249c7d0ee4afe2f46f75247c150",
    );
    expect(() => parseMessagingTurnV1({
      ...turn,
      parts: [{ partId: "part-1", text: "hello", replyRef: undefined }],
    })).toThrow("replyRef");
    expect(() => parseMessagingTurnV1({
      ...turn,
      clientIntentSha256: undefined,
      handoffSha256: "a".repeat(64),
    })).toThrow("unsupported or missing fields");
    expect(() => parseMessagingTurnV1({
      ...turn,
      sourceConversationCoordinateSha256: "b".repeat(64),
    })).toThrow("unsupported or missing fields");
  });

  test("freezes the shared two-part turn vector", () => {
    const turn = parseMessagingTurnV1({
      schemaVersion: 1,
      format: "wrench.messaging-turn",
      clientIntentSha256: "a".repeat(64),
      routeRef,
      contextRef,
      parts: [
        { partId: "part_1", text: "synthetic first bubble", replyRef: null },
        {
          partId: "part_2",
          text: "synthetic second bubble",
          replyRef: "wmreply_ABCDEFGHIJKLMNOPQRSTUV",
        },
      ],
    });
    expect(canonicalJson(turn)).toBe(
      '{"clientIntentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contextRef":"wmcontext_ABCDEFGHIJKLMNOPQRSTUV","format":"wrench.messaging-turn","parts":[{"partId":"part_1","replyRef":null,"text":"synthetic first bubble"},{"partId":"part_2","replyRef":"wmreply_ABCDEFGHIJKLMNOPQRSTUV","text":"synthetic second bubble"}],"routeRef":"wmroute_ABCDEFGHIJKLMNOPQRSTUV","schemaVersion":1}',
    );
    expect(messagingTurnDigest(turn)).toBe(
      "aef4f36bf0f38570a7142e11affe06683130f50ba2e55b1df42cf27e1b021b79",
    );
  });

  test("accepts only the closed tagged exact-route coordinate union", () => {
    const source = {
      adapterId: "adapter",
      authId: "auth",
      listInput: { account_id: "account", limit: 100 },
    } as const;
    for (const coordinate of [
      {
        kind: "beeperConversation",
        network: "imessage",
        conversationId: "chat-1",
      },
      {
        kind: "imessageChat",
        chatGuid: "iMessage;-;+15551234567",
        service: "iMessage",
        observedChatRowId: 42,
      },
      { kind: "whatsappJid", jid: "15551234567@s.whatsapp.net" },
    ] as const) {
      expect(parseMessagingRouteResolveRequestV1({
        schemaVersion: 1,
        format: "wrench.messaging-route-resolve-request",
        source,
        candidate: { coordinate },
      }).candidate.coordinate).toEqual(coordinate);
    }
    expect(() => parseMessagingRouteResolveRequestV1({
      schemaVersion: 1,
      format: "wrench.messaging-route-resolve-request",
      source,
      candidate: { conversationProviderId: "chat-1" },
    })).toThrow("unsupported or missing fields");
    expect(() => parseMessagingRouteResolveRequestV1({
      schemaVersion: 1,
      format: "wrench.messaging-route-resolve-request",
      source,
      candidate: {
        coordinate: {
          kind: "beeperConversation",
          network: "imessage",
          conversationId: "chat-1",
          participant: "+15551234567",
        },
      },
    })).toThrow("unsupported or missing fields");
  });

  test("enforces the receipt self-hash and proven-prefix algebra", () => {
    const base = {
      schemaVersion: 1,
      format: "wrench.messaging-receipt-binding",
      contractId: "wrench.messaging-receipt-binding.v1",
      contractHash: MESSAGING_RECEIPT_BINDING_CONTRACT_HASH,
      clientIntentSha256: "a".repeat(64),
      contextBindingSha256: "f".repeat(64),
      sourceConversationCoordinateSha256: "9".repeat(64),
      routeRefSha256: "b".repeat(64),
      contextRefSha256: "c".repeat(64),
      turnDigest: "d".repeat(64),
      previewDigest: "e".repeat(64),
      runId: "123e4567-e89b-42d3-a456-426614174000",
      state: "submitted",
      partCount: 2,
      provenPartCount: 2,
      recordedAt: "2026-08-27T12:00:00.000Z",
    } as const;
    const receipt = {
      ...base,
      receiptSha256: sha256(canonicalJson(base)),
    } as const;
    expect(parseMessagingReceiptBindingV1(receipt)).toEqual(receipt);
    expect(() => parseMessagingReceiptBindingV1({
      ...receipt,
      receiptSha256: "f".repeat(64),
    })).toThrow("does not bind the canonical receipt");
    for (const invalid of [
      { state: "submitted", partCount: 2, provenPartCount: 1 },
      { state: "failed", partCount: 2, provenPartCount: 1 },
      { state: "partial", partCount: 2, provenPartCount: 0 },
      { state: "partial", partCount: 2, provenPartCount: 2 },
      { state: "indeterminate", partCount: 2, provenPartCount: 2 },
    ] as const) {
      expect(() => parseMessagingReceiptBindingV1({
        ...receipt,
        ...invalid,
      })).toThrow("proven-prefix state law");
    }
  });
});
