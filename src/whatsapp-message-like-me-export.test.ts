import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { exportWhatsAppMessageLikeMeBundle } from "./whatsapp-message-like-me-export";
import {
  WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS,
  WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
  WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
  parseWhatsAppMessageBundleV2Manifest,
  parseWhatsAppMessageBundleV2Record,
  type WhatsAppMessageBundleV2Record,
} from "./whatsapp-message-bundle-v2";
import type { WhatsAppMessageLikeMeExportSource } from "./whatsapp-message-like-me-source";

const OBSERVED_AT = "2026-08-28T12:00:00.000Z";
const SELF_JID = "15551234567@s.whatsapp.net";
const PEER_JID = "15557654321@s.whatsapp.net";

function provenance(providerId: string) {
  return {
    providerId,
    providerRevision: null,
    observedAt: OBSERVED_AT,
    connectedAccountProviderId: SELF_JID,
  } as const;
}

function accountRecord(): WhatsAppMessageBundleV2Record {
  return {
    schemaVersion: 2,
    kind: "account",
    id: "account-1",
    accountId: "account-1",
    network: "whatsapp",
    provenance: provenance(SELF_JID),
    displayName: null,
    handle: "+15551234567",
    selfParticipantId: "participant-self",
  };
}

function participant(id: string, jid: string, isSelf: boolean): WhatsAppMessageBundleV2Record {
  return {
    schemaVersion: 2,
    kind: "participant",
    id,
    accountId: "account-1",
    network: "whatsapp",
    provenance: provenance(jid),
    displayName: null,
    handle: jid === SELF_JID ? "+15551234567" : "+15557654321",
    isSelf,
  };
}

function source(records: readonly WhatsAppMessageBundleV2Record[]): WhatsAppMessageLikeMeExportSource {
  return {
    descriptor: { source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE, provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER },
    records: (async function* () {
      yield* records;
    })(),
    completion: async () => ({
      completeness: {
        kind: "bounded-local",
        reason: "local-store-coverage-unknown",
        observedFrom: records.some((record) => record.kind === "message") ? OBSERVED_AT : null,
        observedThrough: records.some((record) => record.kind === "message") ? OBSERVED_AT : null,
      },
      warnings: ["remote-history-incomplete"],
    }),
  };
}

function privateParent(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wrench-whatsapp-v2-test-")));
  chmodSync(path, 0o700);
  return path;
}

describe("WhatsApp Message Like Me v2 bundle publication", () => {
  test("accepts messages before their participant/conversation graph and publishes exactly seven private files", async () => {
    const parent = privateParent();
    const output = resolve(parent, "bundle");
    try {
      const message: WhatsAppMessageBundleV2Record = {
        schemaVersion: 2,
        kind: "message",
        id: "message-1",
        accountId: "account-1",
        network: "whatsapp",
        provenance: provenance(`${PEER_JID}/MSG-1`),
        conversationId: "conversation-1",
        senderParticipantId: "participant-peer",
        direction: "incoming",
        sentAt: OBSERVED_AT,
        sortKey: "0000000000000000001",
        body: "hello",
        bodyTruncated: false,
        replyTo: null,
        edit: null,
        deletion: null,
        attachments: [],
      };
      const conversation: WhatsAppMessageBundleV2Record = {
        schemaVersion: 2,
        kind: "conversation",
        id: "conversation-1",
        accountId: "account-1",
        network: "whatsapp",
        provenance: provenance(PEER_JID),
        type: "direct",
        title: null,
        participantIds: ["participant-self", "participant-peer"],
        participantsComplete: true,
        startedAt: OBSERVED_AT,
        lastMessageAt: OBSERVED_AT,
      };
      const result = await exportWhatsAppMessageLikeMeBundle({
        outputRoot: output,
        source: source([
          accountRecord(),
          message,
          participant("participant-self", SELF_JID, true),
          participant("participant-peer", PEER_JID, false),
          conversation,
        ]),
        clock: () => new Date(OBSERVED_AT),
      });
      expect(result.manifest).toMatchObject({
        schemaVersion: 2,
        source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
        provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
        counts: { account: 1, participant: 2, conversation: 1, message: 1 },
      });
      expect(parseWhatsAppMessageBundleV2Manifest(
        JSON.parse(readFileSync(result.manifestPath, "utf8")) as unknown,
      )).toEqual(result.manifest);
      expect(readdirSync(output).sort()).toEqual([
        ...WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS.map((item) => item.path),
        "manifest.json",
      ].sort());
      expect(lstatSync(output).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(output)) {
        expect(lstatSync(join(output, name)).mode & 0o777).toBe(0o600);
      }
      const savedMessage = JSON.parse(
        readFileSync(join(output, "messages.ndjson"), "utf8").trim(),
      ) as unknown;
      expect(parseWhatsAppMessageBundleV2Record(savedMessage)).toMatchObject({
        schemaVersion: 2,
        network: "whatsapp",
        body: "hello",
      });
      expect(readFileSync(join(output, "messages.ndjson"), "utf8")).not.toContain("beeper");
      expect(readdirSync(parent).filter((name) => name.startsWith(".wrench-whatsapp-"))).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("publishes an empty local message store without inventing conversations or messages", async () => {
    const parent = privateParent();
    const output = resolve(parent, "empty-bundle");
    try {
      const result = await exportWhatsAppMessageLikeMeBundle({
        outputRoot: output,
        source: source([
          accountRecord(),
          participant("participant-self", SELF_JID, true),
        ]),
        clock: () => new Date(OBSERVED_AT),
      });
      expect(result.manifest.counts).toEqual({
        account: 1,
        participant: 1,
        conversation: 0,
        message: 0,
        reaction: 0,
        tombstone: 0,
      });
      expect(readFileSync(join(output, "messages.ndjson"), "utf8")).toBe("");
      expect(readFileSync(join(output, "conversations.ndjson"), "utf8")).toBe("");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
