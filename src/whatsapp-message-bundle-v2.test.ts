import { describe, expect, test } from "bun:test";

import {
  WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS,
  WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT,
  WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS,
  WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
  WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
  WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
  parseWhatsAppMessageBundleV2Manifest,
  parseWhatsAppMessageBundleV2Record,
  toLocalMessageBundleV1Record,
  whatsAppMessageBundleV2BundleSha256,
  type WhatsAppMessageBundleV2ManifestProjection,
  type WhatsAppMessageBundleV2Record,
} from "./whatsapp-message-bundle-v2";

const observedAt = "2026-08-28T12:00:00.000Z";
const selfJid = "15551234567@s.whatsapp.net";

function account(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
    kind: "account",
    id: "account-one",
    accountId: "account-one",
    network: "whatsapp",
    provenance: {
      providerId: selfJid,
      providerRevision: null,
      observedAt,
      connectedAccountProviderId: selfJid,
    },
    displayName: null,
    handle: "+15551234567",
    selfParticipantId: "participant-self",
    ...overrides,
  };
}

function manifest(accountCount: number): unknown {
  const counts = Object.freeze({
    account: accountCount,
    participant: 0,
    conversation: 0,
    message: 0,
    reaction: 0,
    tombstone: 0,
  });
  const projection: WhatsAppMessageBundleV2ManifestProjection = Object.freeze({
    schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
    format: WHATSAPP_MESSAGE_BUNDLE_V2_FORMAT,
    source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
    provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
    timestamps: Object.freeze({ startedAt: observedAt, finishedAt: observedAt, createdAt: observedAt }),
    completeness: Object.freeze({
      kind: "unknown",
      reason: null,
      observedFrom: null,
      observedThrough: null,
    }),
    warnings: Object.freeze([]),
    privacy: Object.freeze({
      classification: "private-local",
      attachments: "metadata-only",
      providerUrls: "excluded",
      credentials: "excluded",
    }),
    counts,
    artifacts: Object.freeze(WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS.map((artifact) => Object.freeze({
      path: artifact.path,
      mediaType: "application/x-ndjson" as const,
      recordKind: artifact.kind,
      records: counts[artifact.kind],
      bytes: 0,
      sha256: "0".repeat(64),
    }))),
  });
  return Object.freeze({
    ...projection,
    integrity: Object.freeze({
      algorithm: "sha256",
      bundleSha256: whatsAppMessageBundleV2BundleSha256(projection),
    }),
  });
}

describe("canonical WhatsApp Message Like Me v2 adapter", () => {
  test("uses the one-account canonical bound and rejects zero or multiple accounts", () => {
    expect(WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.accounts).toBe(1);
    expect(() => parseWhatsAppMessageBundleV2Manifest(manifest(0))).toThrow(
      "must contain exactly one connected account",
    );
    expect(() => parseWhatsAppMessageBundleV2Manifest(manifest(2))).toThrow(
      "exceeds the 1-account safety bound",
    );
  });

  test("enforces canonical JIDs and exact E.164 handles", () => {
    expect(() => parseWhatsAppMessageBundleV2Record(account({
      provenance: {
        providerId: "05551234567@s.whatsapp.net",
        providerRevision: null,
        observedAt,
        connectedAccountProviderId: "05551234567@s.whatsapp.net",
      },
      handle: "+05551234567",
    }))).toThrow("canonical user, LID, or group WhatsApp JID");
    expect(() => parseWhatsAppMessageBundleV2Record(account({ handle: null }))).toThrow(
      "exact E.164 projection",
    );
  });

  test("requires a complete two-person direct roster", () => {
    expect(() => parseWhatsAppMessageBundleV2Record({
      schemaVersion: 2,
      kind: "conversation",
      id: "conversation-one",
      accountId: "account-one",
      network: "whatsapp",
      provenance: {
        providerId: "15557654321@s.whatsapp.net",
        providerRevision: null,
        observedAt,
        connectedAccountProviderId: selfJid,
      },
      type: "direct",
      title: null,
      participantIds: ["participant-self"],
      participantsComplete: true,
      startedAt: null,
      lastMessageAt: null,
    })).toThrow("direct roster must contain exactly two proven participants");
  });

  test("infers record kind without evaluating accessors", () => {
    let evaluated = false;
    const candidate = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        evaluated = true;
        return "account";
      },
    });
    expect(() => parseWhatsAppMessageBundleV2Record(candidate)).toThrow(
      "enumerable string data properties",
    );
    expect(evaluated).toBe(false);
  });

  test("revalidates records before the safe v2-to-v1 compatibility conversion", () => {
    const parsed = parseWhatsAppMessageBundleV2Record(account());
    expect(toLocalMessageBundleV1Record(parsed)).toMatchObject({
      schemaVersion: 1,
      kind: "account",
      handle: "+15551234567",
    });
    const forged = { ...parsed, handle: null } as WhatsAppMessageBundleV2Record;
    expect(() => toLocalMessageBundleV1Record(forged)).toThrow("exact E.164 projection");
  });
});
