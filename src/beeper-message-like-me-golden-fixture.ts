import type { BeeperMessageLikeMeExportSource } from "./beeper-message-like-me-export";

export const BEEPER_MESSAGE_LIKE_ME_GOLDEN_STARTED_AT =
  "2026-08-21T16:00:00.000Z";
export const BEEPER_MESSAGE_LIKE_ME_GOLDEN_FINISHED_AT =
  "2026-08-21T16:00:01.000Z";

const observedAt = "2026-08-21T15:59:00.000Z";
const accountId = "account:synthetic:primary";
const connectedAccountProviderId = "beeper-account:synthetic-primary";
const selfParticipantId = "participant:synthetic:self";
const peerParticipantId = "participant:synthetic:peer";
const conversationId = "conversation:synthetic:friend";
const editedMessageId = "message:synthetic:edited";
const editedMessageProviderId = "beeper-message:synthetic-edited";
const deletedMessageId = "message:synthetic:deleted";
const deletedMessageProviderId = "beeper-message:synthetic-deleted";

function provenance(providerId: string, providerRevision: string | null) {
  return Object.freeze({
    providerId,
    providerRevision,
    observedAt,
    connectedAccountProviderId,
  });
}

const records = Object.freeze([{
  schemaVersion: 1,
  kind: "account",
  id: accountId,
  accountId,
  network: "synthetic",
  provenance: provenance(connectedAccountProviderId, null),
  displayName: "Synthetic Primary",
  handle: "+15555550100",
  selfParticipantId,
}, {
  schemaVersion: 1,
  kind: "participant",
  id: selfParticipantId,
  accountId,
  network: "synthetic",
  provenance: provenance("beeper-participant:synthetic-self", null),
  displayName: "Synthetic Self",
  handle: "+15555550100",
  isSelf: true,
}, {
  schemaVersion: 1,
  kind: "participant",
  id: peerParticipantId,
  accountId,
  network: "synthetic",
  provenance: provenance("beeper-participant:synthetic-peer", null),
  displayName: "Synthetic Peer",
  handle: "+15555550101",
  isSelf: false,
}, {
  schemaVersion: 1,
  kind: "conversation",
  id: conversationId,
  accountId,
  network: "synthetic",
  provenance: provenance("beeper-conversation:synthetic-friend", "chat-r1"),
  type: "direct",
  title: "Synthetic Friend",
  participantIds: [selfParticipantId, peerParticipantId],
  participantsComplete: true,
  startedAt: "2026-08-21T15:50:00.000Z",
  lastMessageAt: "2026-08-21T15:58:45.000Z",
}, {
  schemaVersion: 1,
  kind: "message",
  id: editedMessageId,
  accountId,
  network: "synthetic",
  provenance: provenance(editedMessageProviderId, "edit-r2"),
  conversationId,
  senderParticipantId: selfParticipantId,
  direction: "outgoing",
  sentAt: "2026-08-21T15:58:00.000Z",
  sortKey: "00000000000000000001",
  body: "edited synthetic reply",
  bodyTruncated: false,
  replyTo: {
    messageId: null,
    providerId: "beeper-message:synthetic-external-reply-target",
  },
  edit: {
    kind: "in-place",
    editedAt: "2026-08-21T15:58:30.000Z",
    providerRevision: "edit-r2",
  },
  deletion: null,
  attachments: [],
}, {
  schemaVersion: 1,
  kind: "message",
  id: deletedMessageId,
  accountId,
  network: "synthetic",
  provenance: provenance(deletedMessageProviderId, "delete-r3"),
  conversationId,
  senderParticipantId: peerParticipantId,
  direction: "incoming",
  sentAt: "2026-08-21T15:58:45.000Z",
  sortKey: "00000000000000000002",
  body: null,
  bodyTruncated: false,
  replyTo: null,
  edit: null,
  deletion: {
    state: "revoked",
    observedAt,
    providerRevision: "delete-r3",
  },
  attachments: [],
}, {
  schemaVersion: 1,
  kind: "reaction",
  id: "reaction:synthetic:undated",
  accountId,
  network: "synthetic",
  provenance: provenance("beeper-reaction:synthetic-undated", "reaction-r1"),
  messageId: editedMessageId,
  messageProviderId: editedMessageProviderId,
  participantId: peerParticipantId,
  body: "👍",
  reactedAt: null,
  state: "active",
}, {
  schemaVersion: 1,
  kind: "tombstone",
  id: "tombstone:synthetic:message",
  accountId,
  network: "synthetic",
  provenance: provenance("beeper-tombstone:synthetic-message", "delete-r3"),
  entityKind: "message",
  entityId: deletedMessageId,
  entityProviderId: deletedMessageProviderId,
  deletedAt: observedAt,
  scope: "remote",
  providerRevision: "delete-r3",
}] as const);

export function createBeeperMessageLikeMeGoldenSource(): BeeperMessageLikeMeExportSource {
  return Object.freeze({
    descriptor: Object.freeze({
      source: Object.freeze({ id: "beeper-local", version: "1.0.0" }),
      provider: Object.freeze({ id: "beeper", version: "0.6.2" }),
    }),
    records: (async function* () {
      for (const record of records) yield record;
    })(),
    completion: () => Promise.resolve(Object.freeze({
      completeness: Object.freeze({
        kind: "truncated",
        reason: "explicit-source-limit",
        observedFrom: "2026-08-21T15:50:00.000Z",
        observedThrough: "2026-08-21T15:59:00.000Z",
      }),
      warnings: Object.freeze([
        "attachments-metadata-only",
        "remote-history-not-claimed",
        "synthetic-golden-fixture",
      ]),
    })),
  });
}
