import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
  WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID,
  WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT,
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR,
  WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR,
  WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH,
  createBeeperMessageLikeMeContextBindingV1,
  createWrenchMessagingReceiptBindingV1,
  messageLikeMeSourceConversationCoordinateBindingV1,
  wrenchMessagingContextBindingSha256V1,
} from "./message-like-me-agentic-messaging";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function exactConversationRead(
  conversationOverrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
): unknown {
  return {
    provider: "beeper",
    operation: "conversations.read",
    accountSubject: "beeper-main",
    conversation: {
      id: "chat-synthetic-001",
      localChatId: null,
      accountId: "account-synthetic-001",
      network: "imessage",
      title: "Synthetic chat",
      type: "single",
      description: null,
      descriptionObserved: true,
      hasAvatar: false,
      avatarObserved: true,
      lastReadMessageSortKey: null,
      lastActivity: "2026-08-27T11:59:00.000Z",
      unreadCount: 0,
      unreadMentionsCount: null,
      isMarkedUnread: false,
      isArchived: false,
      isLowPriority: false,
      isMuted: false,
      isPinned: false,
      isReadOnly: false,
      messageExpirySeconds: null,
      messageExpiryObserved: true,
      draft: null,
      draftObserved: true,
      reminder: null,
      reminderObserved: true,
      participants: { items: [], total: 0, hasMore: false },
      ...conversationOverrides,
    },
    ...envelopeOverrides,
  };
}

function contextBinding() {
  return createBeeperMessageLikeMeContextBindingV1({
    conversationRead: exactConversationRead(),
    expectedAccountSubject: "beeper-main",
    routeRef: "route_ref_synthetic_001",
    contextRef: "context_ref_synthetic_001",
    exactDataRevision: HASH_A,
    latestMessageRevision: HASH_B,
    validatedAt: "2026-08-27T12:00:00.000Z",
    expiresAt: "2026-08-27T12:10:00.000Z",
  });
}

describe("Message Like Me agentic messaging contracts", () => {
  test("pins a domain-separated canonical coordinate vector", () => {
    const binding = messageLikeMeSourceConversationCoordinateBindingV1({
      sourceAccountId: "account-synthetic-001",
      sourceExternalId: "account-synthetic-001",
      coordinate: {
        kind: "beeperConversation",
        network: "imessage",
        conversationId: "chat-synthetic-001",
      },
    });
    expect(binding).toEqual({
      contractId: MESSAGE_LIKE_ME_SOURCE_CONVERSATION_COORDINATE_V1_CONTRACT_ID,
      schemaVersion: 1,
      sha256: "c81caf9a9413cf8a9a777db460c079a0a0a1dd6a7013f2122eb9e31355c11471",
    });
  });

  test("derives the coordinate only from an exact resolved Beeper conversation", () => {
    const context = contextBinding();
    expect(context.sourceConversationCoordinate.sha256)
      .toBe("c81caf9a9413cf8a9a777db460c079a0a0a1dd6a7013f2122eb9e31355c11471");
    expect(context).not.toHaveProperty("sourceAccountId");
    expect(context).not.toHaveProperty("sourceExternalId");
    expect(context).not.toHaveProperty("coordinate");
    expect(() => createBeeperMessageLikeMeContextBindingV1({
      conversationRead: exactConversationRead({ accountId: null }),
      expectedAccountSubject: "beeper-main",
      routeRef: "route_ref_synthetic_001",
      contextRef: "context_ref_synthetic_001",
      exactDataRevision: HASH_A,
      latestMessageRevision: HASH_B,
      validatedAt: "2026-08-27T12:00:00.000Z",
      expiresAt: "2026-08-27T12:10:00.000Z",
    })).toThrow("accountId");
    expect(() => createBeeperMessageLikeMeContextBindingV1({
      conversationRead: {
        ...(exactConversationRead() as object),
        operation: "conversations.list",
      },
      expectedAccountSubject: "beeper-main",
      routeRef: "route_ref_synthetic_001",
      contextRef: "context_ref_synthetic_001",
      exactDataRevision: HASH_A,
      latestMessageRevision: HASH_B,
      validatedAt: "2026-08-27T12:00:00.000Z",
      expiresAt: "2026-08-27T12:10:00.000Z",
    })).toThrow("exact Beeper conversations.read");
    expect(() => createBeeperMessageLikeMeContextBindingV1({
      conversationRead: {
        provider: "beeper",
        operation: "conversations.read",
        accountSubject: "beeper-main",
        conversation: {
          id: "chat-synthetic-001",
          accountId: "account-synthetic-001",
          network: "imessage",
        },
      },
      expectedAccountSubject: "beeper-main",
      routeRef: "route_ref_synthetic_001",
      contextRef: "context_ref_synthetic_001",
      exactDataRevision: HASH_A,
      latestMessageRevision: HASH_B,
      validatedAt: "2026-08-27T12:00:00.000Z",
      expiresAt: "2026-08-27T12:10:00.000Z",
    })).toThrow("must contain exactly");
    expect(() => createBeeperMessageLikeMeContextBindingV1({
      conversationRead: exactConversationRead({}, { extra: true }),
      expectedAccountSubject: "beeper-main",
      routeRef: "route_ref_synthetic_001",
      contextRef: "context_ref_synthetic_001",
      exactDataRevision: HASH_A,
      latestMessageRevision: HASH_B,
      validatedAt: "2026-08-27T12:00:00.000Z",
      expiresAt: "2026-08-27T12:10:00.000Z",
    })).toThrow("must contain exactly");
    expect(() => createBeeperMessageLikeMeContextBindingV1({
      conversationRead: exactConversationRead(),
      expectedAccountSubject: "beeper-other",
      routeRef: "route_ref_synthetic_001",
      contextRef: "context_ref_synthetic_001",
      exactDataRevision: HASH_A,
      latestMessageRevision: HASH_B,
      validatedAt: "2026-08-27T12:00:00.000Z",
      expiresAt: "2026-08-27T12:10:00.000Z",
    })).toThrow("expected account subject");
  });

  test("rejects tag, account, external ID, and coordinate mismatches", () => {
    const valid = {
      sourceAccountId: "account-synthetic-001",
      sourceExternalId: "account-synthetic-001",
      coordinate: {
        kind: "beeperConversation",
        network: "imessage",
        conversationId: "chat-synthetic-001",
      },
    };
    const digest = messageLikeMeSourceConversationCoordinateBindingV1(valid).sha256;
    expect(messageLikeMeSourceConversationCoordinateBindingV1({
      ...valid,
      coordinate: {
        kind: "imessageChat",
        chatGuid: "chat-synthetic-001",
        service: "iMessage",
        observedChatRowId: null,
      },
      sourceAccountId: null,
    }).sha256).not.toBe(digest);
    expect(() => messageLikeMeSourceConversationCoordinateBindingV1({
      ...valid,
      sourceAccountId: "account-other",
    })).toThrow("must match");
    expect(() => messageLikeMeSourceConversationCoordinateBindingV1({
      ...valid,
      sourceExternalId: "account-other",
    })).toThrow("must match");
    expect(messageLikeMeSourceConversationCoordinateBindingV1({
      ...valid,
      coordinate: { ...valid.coordinate, conversationId: "chat-other" },
    }).sha256).not.toBe(digest);
  });

  test("pins context and receipt contracts and binds the coordinate into receipts", () => {
    expect(sha256(canonicalJson(WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_DESCRIPTOR)))
      .toBe(WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH);
    expect(WRENCH_MESSAGING_CONTEXT_BINDING_V1_CONTRACT_HASH)
      .toBe("3976f7f3e7baffe8e8b16b9fdceb11902628398e2337f4989446cef4338885e2");
    expect(sha256(canonicalJson(WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_DESCRIPTOR)))
      .toBe(WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH);
    expect(WRENCH_MESSAGING_RECEIPT_BINDING_V1_CONTRACT_HASH)
      .toBe("6b5694f183a6a39b40001a04c62cf767bb5d612cb7c9be5710befa3c7f223ffd");

    const context = contextBinding();
    const clientIntent = {
      schemaVersion: 1,
      format: WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_FORMAT,
      contractId: WRENCH_MESSAGING_CLIENT_INTENT_BINDING_V1_CONTRACT_ID,
      clientIntentSha256: HASH_A,
      contextBindingSha256: wrenchMessagingContextBindingSha256V1(context),
      sourceConversationCoordinateSha256: context.sourceConversationCoordinate.sha256,
      routeRefSha256: sha256(context.routeRef),
      contextRefSha256: sha256(context.contextRef),
      turnDigest: HASH_B,
      partCount: 2,
    };
    const receipt = createWrenchMessagingReceiptBindingV1({
      context,
      clientIntent,
      previewDigest: HASH_C,
      runId: "run_synthetic_001",
      state: "submitted",
      provenPartCount: 2,
      recordedAt: "2026-08-27T12:01:00.000Z",
    });
    expect(receipt.sourceConversationCoordinateSha256)
      .toBe(context.sourceConversationCoordinate.sha256);
    expect(receipt.receiptSha256).toBe(sha256(canonicalJson({
      ...receipt,
      receiptSha256: undefined,
    })));
    for (const changed of [
      { contextBindingSha256: HASH_C },
      { sourceConversationCoordinateSha256: HASH_B },
      { routeRefSha256: HASH_C },
      { contextRefSha256: HASH_A },
    ]) {
      expect(() => createWrenchMessagingReceiptBindingV1({
        context,
        clientIntent: { ...clientIntent, ...changed },
        previewDigest: HASH_C,
        runId: "run_synthetic_001",
        state: "submitted",
        provenPartCount: 2,
        recordedAt: "2026-08-27T12:01:00.000Z",
      })).toThrow("does not bind the exact context instance");
    }
    for (const changedContext of [
      { ...context, exactDataRevision: HASH_C },
      { ...context, latestMessageRevision: HASH_C },
      { ...context, validatedAt: "2026-08-27T12:00:01.000Z" },
      { ...context, expiresAt: "2026-08-27T12:09:59.000Z" },
    ]) {
      expect(() => createWrenchMessagingReceiptBindingV1({
        context: changedContext,
        clientIntent,
        previewDigest: HASH_C,
        runId: "run_synthetic_001",
        state: "submitted",
        provenPartCount: 2,
        recordedAt: "2026-08-27T12:01:00.000Z",
      })).toThrow("does not bind the exact context instance");
    }
    expect(() => createWrenchMessagingReceiptBindingV1({
      context: { ...context, contractHash: HASH_C },
      clientIntent,
      previewDigest: HASH_C,
      runId: "run_synthetic_001",
      state: "submitted",
      provenPartCount: 2,
      recordedAt: "2026-08-27T12:01:00.000Z",
    })).toThrow("unsupported contract identity");
  });
});
