import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "./auth";
import {
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
  type WhatsAppMessageExportProjectionItem,
} from "./providers/whatsapp-message-export-projection-protocol";
import {
  createWhatsAppMessageLikeMeSource,
  type WhatsAppMessageLikeMeSourceDependencies,
} from "./whatsapp-message-like-me-source";
import { parseWhatsAppMessageBundleV2Record } from "./whatsapp-message-bundle-v2";

function privateStore(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wrench-wa-source-")));
  chmodSync(path, 0o700);
  for (const name of ["session.db", "wacli.db"]) {
    writeFileSync(join(path, name), "fixed");
    chmodSync(join(path, name), 0o600);
  }
  return path;
}

function auth(path: string, subject = "whatsapp:pn:15551234567"): WrenchAuth {
  return {
    schemaVersion: 1,
    id: "personal-whatsapp",
    kind: "linked-device-store",
    provider: "whatsapp",
    path,
    subject,
  };
}

function item(overrides: Partial<WhatsAppMessageExportProjectionItem>): WhatsAppMessageExportProjectionItem {
  return {
    rowid: "1",
    chatJid: "15557654321@s.whatsapp.net",
    chatKind: "dm",
    chatName: "Peer",
    messageId: "MSG-1",
    senderJid: "15557654321:2@s.whatsapp.net",
    senderName: "Peer",
    timestamp: "2026-08-28T12:00:00.000Z",
    fromMe: false,
    text: "hello",
    displayText: null,
    quotedMessageId: null,
    quotedSenderJid: null,
    reactionToMessageId: null,
    reactionEmoji: null,
    mediaType: null,
    mediaCaption: null,
    fileName: null,
    mimeType: null,
    fileLength: null,
    revoked: false,
    deletedForMe: false,
    deletedAt: null,
    payloadPurgedAt: null,
    edited: false,
    editedAt: null,
    ...overrides,
  };
}

function fakeDependencies(
  store: string,
  messages: readonly WhatsAppMessageExportProjectionItem[],
  systemChatExcluded = false,
): WhatsAppMessageLikeMeSourceDependencies {
  return {
    helperPath: "/private/fixed/helper.ts",
    configPath: "/private/fixed/config.toml",
    runHelper: async (invocation) => {
      const request = JSON.parse(invocation.stdin) as {
        readonly messageStoreIdentity: { readonly dev: string; readonly ino: string };
      };
      const stats = lstatSync(join(store, "wacli.db"), { bigint: true });
      const last = messages.at(-1);
      return {
        exitCode: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          schemaVersion: 1,
          status: "succeeded",
          projectionGeneration: {
            messageStoreIdentity: request.messageStoreIdentity,
            size: stats.size.toString(),
            mtimeNs: stats.mtimeNs.toString(),
            ctimeNs: stats.ctimeNs.toString(),
            schemaFingerprint: WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
          },
          systemChatExcluded,
          messages,
          nextCursor: null,
          localInsertPageComplete: true,
          checkpoint: last === undefined
            ? { cursor: "0", anchor: null }
            : { cursor: last.rowid, anchor: "a".repeat(64) },
        })}\n`,
      };
    },
  };
}

async function collect(
  path: string,
  messages: readonly WhatsAppMessageExportProjectionItem[],
  subject = "whatsapp:pn:15551234567",
  systemChatExcluded = false,
) {
  const source = createWhatsAppMessageLikeMeSource({
    auth: auth(path, subject),
    dependencies: fakeDependencies(path, messages, systemChatExcluded),
  });
  const records = [];
  let index = 0;
  for await (const record of source.records) {
    records.push(parseWhatsAppMessageBundleV2Record(record, index));
    index += 1;
  }
  return { records, completion: await source.completion() };
}

describe("WhatsApp Message Like Me source mapping", () => {
  test("preserves bubbles, replies, edits, deletions, reactions, rosters, and safe user handles", async () => {
    const path = privateStore();
    try {
      const result = await collect(path, [
        item({
          rowid: "1",
          messageId: "MSG-1",
          quotedMessageId: "MSG-0",
          mediaType: "image",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          fileLength: 42,
          edited: true,
          editedAt: "2026-08-28T12:00:05.000Z",
        }),
        item({
          rowid: "2",
          chatJid: "120363123456789012@g.us",
          chatKind: "group",
          chatName: "Group",
          messageId: "MSG-2",
          senderJid: "222222222222222:4@lid",
          senderName: "LID member",
          timestamp: "2026-08-28T12:01:00.000Z",
          text: null,
          reactionToMessageId: "TARGET-1",
          reactionEmoji: "❤️",
        }),
        item({
          rowid: "3",
          messageId: "MSG-3",
          timestamp: "2026-08-28T12:02:00.000Z",
          revoked: true,
          deletedAt: "2026-08-28T12:02:02.000Z",
          payloadPurgedAt: "2026-08-28T12:02:03.000Z",
        }),
      ]);
      expect(result.records.every((record) => record.schemaVersion === 2 && record.network === "whatsapp")).toBe(true);
      expect(result.records.find((record) => record.kind === "account")).toMatchObject({
        handle: "+15551234567",
        provenance: { providerId: "15551234567@s.whatsapp.net" },
      });
      expect(result.records.find((record) =>
        record.kind === "participant" && record.provenance.providerId === "15557654321@s.whatsapp.net"
      )).toMatchObject({ handle: "+15557654321" });
      expect(result.records.find((record) =>
        record.kind === "participant" && record.provenance.providerId === "222222222222222@lid"
      )).toMatchObject({ handle: null });
      const messages = result.records.filter((record) => record.kind === "message");
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        provenance: { providerId: "15557654321@s.whatsapp.net/MSG-1" },
        sortKey: "0000000000000000001",
        body: "hello",
        replyTo: { providerId: "15557654321@s.whatsapp.net/MSG-0" },
        edit: { kind: "in-place", editedAt: "2026-08-28T12:00:05.000Z" },
        attachments: [{ kind: "image", name: "photo.jpg", sizeBytes: 42 }],
      });
      expect(messages[1]).toMatchObject({
        body: null,
        deletion: { state: "revoked", observedAt: "2026-08-28T12:02:02.000Z" },
      });
      expect(result.records.filter((record) => record.kind === "reaction")).toEqual([
        expect.objectContaining({
          messageProviderId: "120363123456789012@g.us/TARGET-1",
          body: "❤️",
          state: "active",
        }),
      ]);
      const conversations = result.records.filter((record) => record.kind === "conversation");
      const direct = conversations.find((record) => record.type === "direct");
      expect(direct).toMatchObject({
        participantsComplete: true,
      });
      expect(direct?.participantIds).toHaveLength(2);
      expect(conversations.find((record) => record.type === "group")).toMatchObject({
        participantsComplete: false,
      });
      expect(result.completion).toMatchObject({
        completeness: { kind: "bounded-local", reason: "local-store-coverage-unknown" },
        warnings: ["remote-history-incomplete"],
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("keeps a bound LID as provenance while emitting no fake phone handle", async () => {
    const path = privateStore();
    try {
      const result = await collect(path, [], "whatsapp:lid:222222222222222");
      expect(result.records).toEqual([
        expect.objectContaining({
          kind: "account",
          handle: null,
          provenance: expect.objectContaining({
            providerId: "222222222222222@lid",
            connectedAccountProviderId: "222222222222222@lid",
          }),
        }),
        expect.objectContaining({
          kind: "participant",
          handle: null,
          provenance: expect.objectContaining({ providerId: "222222222222222@lid" }),
        }),
      ]);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("reports a categorical warning when system, status, broadcast, or newsletter chats are excluded", async () => {
    const path = privateStore();
    try {
      const result = await collect(
        path,
        [],
        "whatsapp:pn:15551234567",
        true,
      );
      expect(result.completion).toMatchObject({
        warnings: ["remote-history-incomplete", "non-conversation-chats-excluded"],
      });
      expect(JSON.stringify(result)).not.toContain("0@s.whatsapp.net");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("keeps actorless group messages but skips reactions whose actor is unproven", async () => {
    const path = privateStore();
    try {
      const result = await collect(path, [
        item({
          rowid: "1",
          chatJid: "120363123456789012@g.us",
          chatKind: "group",
          chatName: "Group",
          messageId: "GROUP-1",
          senderJid: null,
          senderName: null,
          text: "actorless group message",
        }),
        item({
          rowid: "2",
          chatJid: "120363123456789012@g.us",
          chatKind: "group",
          chatName: "Group",
          messageId: "REACTION-1",
          senderJid: null,
          senderName: null,
          text: null,
          reactionToMessageId: "GROUP-1",
          reactionEmoji: "👍",
        }),
      ]);
      expect(result.records.filter((record) => record.kind === "message")).toEqual([
        expect.objectContaining({
          body: "actorless group message",
          senderParticipantId: null,
        }),
      ]);
      expect(result.records.filter((record) => record.kind === "reaction")).toEqual([]);
      expect(result.completion).toMatchObject({
        warnings: ["remote-history-incomplete", "reaction-actor-unproven"],
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("omits reaction removals and reports the exact unproven-removal warning", async () => {
    const path = privateStore();
    try {
      const result = await collect(path, [
        item({
          rowid: "1",
          messageId: "REACTION-REMOVAL-NULL",
          text: null,
          reactionToMessageId: "TARGET-1",
          reactionEmoji: null,
        }),
        item({
          rowid: "2",
          messageId: "REACTION-REMOVAL-EMPTY",
          text: null,
          reactionToMessageId: "TARGET-2",
          reactionEmoji: "",
        }),
      ]);
      expect(result.records.filter((record) =>
        record.kind === "message" || record.kind === "reaction")).toEqual([]);
      expect(result.completion).toMatchObject({
        warnings: ["remote-history-incomplete", "reaction-removal-unproven"],
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("uses capture observation time for flag-only deletion and never infers deletion from absence", async () => {
    const path = privateStore();
    try {
      const result = await collect(path, [
        item({ rowid: "1", messageId: "PRESENT", deletedAt: null }),
        item({
          rowid: "2",
          messageId: "FLAG-ONLY",
          timestamp: "2026-08-28T12:01:00.000Z",
          revoked: true,
          deletedAt: null,
        }),
      ]);
      const messages = result.records.filter((record) => record.kind === "message");
      expect(messages[0]).toMatchObject({ deletion: null });
      expect(messages[1]).toMatchObject({
        deletion: {
          state: "revoked",
          observedAt: expect.any(String),
          providerRevision: null,
        },
      });
      expect(messages[1]?.deletion?.observedAt).not.toBe(messages[1]?.sentAt);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects sender directions that contradict the exact account and conversation", async () => {
    const path = privateStore();
    try {
      for (const invalid of [
        item({ senderJid: "15551234567@s.whatsapp.net", fromMe: false }),
        item({ senderJid: "15557654321@s.whatsapp.net", fromMe: true }),
        item({
          chatJid: "120363123456789012@g.us",
          chatKind: "group",
          senderJid: "15551234567@lid",
          fromMe: true,
        }),
        item({
          chatJid: "120363123456789012@g.us",
          chatKind: "group",
          senderJid: "15551234567@s.whatsapp.net",
          fromMe: false,
        }),
      ]) {
        await expect(collect(path, [invalid])).rejects.toThrow(
          "WhatsApp message export projection protocol",
        );
      }
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("excludes message-yourself rows without aborting the account export", async () => {
    const path = privateStore();
    try {
      const result = await collect(path, [
        item({
          chatJid: "15551234567@s.whatsapp.net",
          chatKind: "dm",
          chatName: "Me",
          messageId: "SELF-1",
          senderJid: null,
          senderName: null,
          fromMe: true,
          text: "private note",
        }),
      ]);
      expect(result.records.map((record) => record.kind)).toEqual([
        "account",
        "participant",
      ]);
      expect(result.completion).toMatchObject({
        completeness: { observedFrom: null, observedThrough: null },
        warnings: ["remote-history-incomplete", "self-chat-excluded"],
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("never turns whitespace or the proven audio placeholder into shared message text", async () => {
    const path = privateStore();
    try {
      const result = await collect(path, [
        item({
          rowid: "1",
          messageId: "SYNTHETIC-1",
          text: " \t\n ",
          displayText: "Messages are end-to-end encrypted",
        }),
        item({
          rowid: "2",
          messageId: "MEDIA-1",
          text: null,
          displayText: "Image",
          mediaType: "image",
          mediaCaption: "  \n",
          mimeType: "image/jpeg",
        }),
        item({
          rowid: "3",
          messageId: "MEDIA-2",
          text: null,
          displayText: "Image",
          mediaType: "image",
          mediaCaption: "real caption",
          mimeType: "image/jpeg",
        }),
        item({
          rowid: "4",
          messageId: "AUDIO-PLACEHOLDER",
          text: "[Audio]",
          displayText: "[Audio]",
          mediaType: "AuDiO",
          mediaCaption: "[Audio]",
          mimeType: "audio/ogg",
        }),
        item({
          rowid: "5",
          messageId: "AUDIO-CAPTION",
          text: "[Audio]",
          displayText: "[Audio]",
          mediaType: "audio",
          mediaCaption: "voice memo note",
          mimeType: "audio/ogg",
        }),
        item({
          rowid: "6",
          messageId: "VIDEO-CAPTION",
          text: null,
          displayText: "Video",
          mediaType: "video",
          mediaCaption: "real video caption",
          mimeType: "video/mp4",
        }),
        item({
          rowid: "7",
          messageId: "DOCUMENT-CAPTION",
          text: null,
          displayText: "Document",
          mediaType: "document",
          mediaCaption: "real document caption",
          mimeType: "application/pdf",
        }),
        item({
          rowid: "8",
          messageId: "PTT-PLACEHOLDER",
          text: "[Audio]",
          displayText: "[Audio]",
          mediaType: "PtT",
          mediaCaption: "[Audio]",
          mimeType: "audio/ogg",
        }),
      ]);
      expect(result.records.filter((record) => record.kind === "message").map((record) => ({
        body: record.body,
        attachments: record.attachments,
      }))).toEqual([
        { body: null, attachments: [] },
        { body: null, attachments: [expect.objectContaining({ kind: "image" })] },
        { body: "real caption", attachments: [expect.objectContaining({ kind: "image" })] },
        { body: null, attachments: [expect.objectContaining({ kind: "audio" })] },
        { body: "voice memo note", attachments: [expect.objectContaining({ kind: "audio" })] },
        { body: "real video caption", attachments: [expect.objectContaining({ kind: "video" })] },
        { body: "real document caption", attachments: [expect.objectContaining({ kind: "document" })] },
        { body: null, attachments: [expect.objectContaining({ kind: "audio" })] },
      ]);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("marks a locally purged payload as unavailable prose evidence", async () => {
    const path = privateStore();
    try {
      const result = await collect(path, [
        item({
          rowid: "1",
          messageId: "PURGED-PAYLOAD",
          text: "stale body must not survive",
          payloadPurgedAt: "2026-08-28T12:00:01.000Z",
        }),
        item({
          rowid: "2",
          messageId: "PURGED-DELETED-PAYLOAD",
          text: "deleted stale body must not survive",
          revoked: true,
          deletedAt: "2026-08-28T12:00:02.000Z",
          payloadPurgedAt: "2026-08-28T12:00:03.000Z",
        }),
      ]);
      const messages = result.records.filter((record) => record.kind === "message");
      expect(messages[0]).toMatchObject({
        body: null,
        bodyTruncated: true,
        deletion: null,
        provenance: { providerRevision: "2026-08-28T12:00:01.000Z" },
      });
      expect(messages[1]).toMatchObject({
        body: null,
        bodyTruncated: false,
        deletion: { state: "revoked" },
        provenance: { providerRevision: "2026-08-28T12:00:02.000Z" },
      });
      expect(result.completion).toMatchObject({
        warnings: ["remote-history-incomplete", "message-payload-purged"],
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects account subjects and projected JIDs outside the released v2 grammar", async () => {
    const path = privateStore();
    try {
      for (const subject of [
        "whatsapp:pn:01234",
        "whatsapp:pn:1234567890123456",
        "whatsapp:lid:01234",
        "whatsapp:lid:123456789012345678901",
      ]) {
        await expect(collect(path, [], subject)).rejects.toThrow(
          "a bound WhatsApp linked-device-store auth locator is required",
        );
      }
      for (const chatJid of [
        "01234@s.whatsapp.net",
        "1234567890123456@s.whatsapp.net",
        "01234@lid",
        "123456789012345678901@lid",
        "12345-01234@g.us",
      ]) {
        await expect(collect(path, [item({ chatJid })])).rejects.toThrow(
          "WhatsApp message export projection protocol",
        );
      }
      for (const projection of [
        item({ chatJid: "15557654321:2@s.whatsapp.net" }),
        item({ chatJid: "120363123456789012@g.us", chatKind: "dm" }),
        item({ senderJid: "120363123456789012@g.us" }),
      ]) {
        await expect(collect(path, [projection])).rejects.toThrow(
          "WhatsApp message export projection protocol",
        );
      }
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
