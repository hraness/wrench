import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LOCAL_MESSAGE_BUNDLE_V1_LIMITS,
} from "@hraness/message-like-me/message-bundle-v1";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  BEEPER_CONTACT_INTERACTION_IMPLEMENTATION,
  createBeeperContactInteractionExportResult,
  encodeBeeperContactInteractionExportResult,
  parseBeeperContactInteractionExportResult,
  parseBeeperContactInteractionSummary,
  summarizeBeeperContactInteractions,
} from "./beeper-contact-interactions";
import {
  assertBeeperContactInteractionExportRuntime,
} from "./beeper-contact-interactions-cli";
import type {
  BeeperMessageLikeMeExportSource,
  BeeperMessageLikeMeMessage,
  BeeperMessageLikeMeRecord,
} from "./beeper-message-like-me-export";
import type {
  BeeperMessageLikeMeSourceCoordinate,
} from "./beeper-message-like-me-source";
import { WRENCH_VERSION } from "./version";

function localId(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${sha256(canonicalJson(parts))}`;
}

function providerId(kind: string, ...parts: readonly string[]): string {
  return `beeper-${kind}:${sha256(canonicalJson(parts))}`;
}

function fixture(options: Readonly<{
  accountId?: string;
  selfId?: string;
  peerId?: string;
  directConversationId?: string;
}> = {}) {
  const accountId = options.accountId ?? "raw-account/signal";
  const selfId = options.selfId ?? "raw-self";
  const peerId = options.peerId ?? "raw-peer";
  const groupPeerId = "raw-group-peer";
  const directConversationId = options.directConversationId ?? "raw-direct-chat";
  const groupConversationId = "raw-group-chat";
  const accountLocalId = localId("account", accountId);
  const selfLocalId = localId("participant", accountId, selfId);
  const peerLocalId = localId("participant", accountId, peerId);
  const groupPeerLocalId = localId("participant", accountId, groupPeerId);
  const directConversationLocalId = localId(
    "conversation",
    accountId,
    directConversationId,
  );
  const groupConversationLocalId = localId(
    "conversation",
    accountId,
    groupConversationId,
  );
  const observedAt = "2026-08-26T12:00:04.000Z";
  const accountProviderId = providerId("account", accountId);
  const provenance = (kind: string, ...parts: readonly string[]) => Object.freeze({
    providerId: providerId(kind, ...parts),
    providerRevision: null,
    observedAt,
    connectedAccountProviderId: accountProviderId,
  });
  const values: Array<Readonly<{
    record: BeeperMessageLikeMeRecord;
    coordinate?: BeeperMessageLikeMeSourceCoordinate;
  }>> = [];
  const push = (
    record: BeeperMessageLikeMeRecord,
    coordinate?: BeeperMessageLikeMeSourceCoordinate,
  ): void => {
    values.push(Object.freeze({
      record,
      ...(coordinate === undefined ? {} : { coordinate }),
    }));
  };
  push(Object.freeze({
    schemaVersion: 1,
    kind: "account",
    id: accountLocalId,
    accountId: accountLocalId,
    network: "signal",
    provenance: Object.freeze({
      providerId: accountProviderId,
      providerRevision: null,
      observedAt,
      connectedAccountProviderId: accountProviderId,
    }),
    displayName: "Must not survive",
    handle: "+15555550123",
    selfParticipantId: selfLocalId,
  }), Object.freeze({ kind: "account", accountId }));
  for (const [participantId, participantLocalId, isSelf] of [
    [selfId, selfLocalId, true],
    [peerId, peerLocalId, false],
    [groupPeerId, groupPeerLocalId, false],
  ] as const) {
    push(Object.freeze({
      schemaVersion: 1,
      kind: "participant",
      id: participantLocalId,
      accountId: accountLocalId,
      network: "signal",
      provenance: provenance("participant", accountId, participantId),
      displayName: `Secret name ${participantId}`,
      handle: `secret-${participantId}@example.invalid`,
      isSelf,
    }), Object.freeze({ kind: "participant", accountId, participantId }));
  }
  push(Object.freeze({
    schemaVersion: 1,
    kind: "conversation",
    id: directConversationLocalId,
    accountId: accountLocalId,
    network: "signal",
    provenance: provenance("conversation", accountId, directConversationId),
    type: "direct",
    title: "Secret direct title",
    participantIds: Object.freeze([selfLocalId, peerLocalId]),
    participantsComplete: true,
    startedAt: "2026-08-26T12:00:01.000Z",
    lastMessageAt: "2026-08-26T12:00:03.000Z",
  }), Object.freeze({
    kind: "conversation",
    accountId,
    conversationId: directConversationId,
  }));
  push(Object.freeze({
    schemaVersion: 1,
    kind: "conversation",
    id: groupConversationLocalId,
    accountId: accountLocalId,
    network: "signal",
    provenance: provenance("conversation", accountId, groupConversationId),
    type: "group",
    title: "Secret group title",
    participantIds: Object.freeze([selfLocalId, peerLocalId, groupPeerLocalId]),
    participantsComplete: true,
    startedAt: "2026-08-26T12:00:01.000Z",
    lastMessageAt: "2026-08-26T12:00:04.000Z",
  }), Object.freeze({
    kind: "conversation",
    accountId,
    conversationId: groupConversationId,
  }));
  const addMessage = (input: Readonly<{
    id: string;
    conversationId: string;
    conversationLocalId: string;
    direction: "incoming" | "outgoing";
    sentAt: string;
    body: string;
    edit?: NonNullable<BeeperMessageLikeMeMessage["edit"]>;
  }>): void => {
    push(Object.freeze({
      schemaVersion: 1,
      kind: "message",
      id: localId("message", accountId, input.conversationId, input.id),
      accountId: accountLocalId,
      network: "signal",
      provenance: Object.freeze({
        ...provenance("message", accountId, input.conversationId, input.id),
        providerRevision: `revision-${input.id}`,
      }),
      conversationId: input.conversationLocalId,
      senderParticipantId: input.direction === "outgoing" ? selfLocalId : peerLocalId,
      direction: input.direction,
      sentAt: input.sentAt,
      sortKey: input.sentAt,
      body: input.body,
      bodyTruncated: false,
      replyTo: null,
      edit: input.edit ?? null,
      deletion: null,
      attachments: Object.freeze([Object.freeze({
        kind: "image" as const,
        mimeType: "image/png",
        name: "private-photo.png",
        sizeBytes: 123,
      })]),
    }), Object.freeze({
      kind: "message",
      accountId,
      conversationId: input.conversationId,
      messageId: input.id,
    }));
  };
  addMessage({
    id: "old",
    conversationId: directConversationId,
    conversationLocalId: directConversationLocalId,
    direction: "outgoing",
    sentAt: "2026-08-26T12:00:01.000Z",
    body: "SECRET OLD BODY",
  });
  addMessage({
    id: "replacement",
    conversationId: directConversationId,
    conversationLocalId: directConversationLocalId,
    direction: "outgoing",
    sentAt: "2026-08-26T12:00:02.000Z",
    body: "SECRET REPLACEMENT BODY",
    edit: Object.freeze({
      kind: "replacement",
      replacesMessageId: localId(
        "message",
        accountId,
        directConversationId,
        "old",
      ),
      replacesProviderId: providerId(
        "message",
        accountId,
        directConversationId,
        "old",
      ),
      editedAt: "2026-08-26T12:00:02.000Z",
      providerRevision: "replacement-r1",
    }),
  });
  addMessage({
    id: "incoming",
    conversationId: directConversationId,
    conversationLocalId: directConversationLocalId,
    direction: "incoming",
    sentAt: "2026-08-26T12:00:03.000Z",
    body: "SECRET INCOMING BODY",
  });
  addMessage({
    id: "group",
    conversationId: groupConversationId,
    conversationLocalId: groupConversationLocalId,
    direction: "incoming",
    sentAt: "2026-08-26T12:00:04.000Z",
    body: "SECRET GROUP BODY",
  });
  const coordinates = new WeakMap<object, BeeperMessageLikeMeSourceCoordinate>();
  for (const value of values) {
    if (value.coordinate !== undefined) coordinates.set(value.record, value.coordinate);
  }
  const source: BeeperMessageLikeMeExportSource = Object.freeze({
    descriptor: Object.freeze({
      source: Object.freeze({ id: "beeper-local", version: "1.1.0" }),
      provider: Object.freeze({ id: "beeper", version: "0.6.2" }),
    }),
    records: (async function* () {
      for (const value of values) yield value.record;
    })(),
    completion: () => Promise.resolve(Object.freeze({
      completeness: Object.freeze({
        kind: "bounded-local",
        reason: "desktop-local-sequential-export",
        observedFrom: "2026-08-26T12:00:01.000Z",
        observedThrough: "2026-08-26T12:00:04.000Z",
      }),
      warnings: Object.freeze([
        "remote-history-not-claimed",
        "sequential-account-snapshot",
      ]),
    })),
  });
  return {
    source,
    records: Object.freeze(values.map((value) => value.record)),
    coordinateForRecord: (value: unknown) => (
      typeof value === "object" && value !== null
        ? coordinates.get(value)
        : undefined
    ),
  };
}

describe("Beeper contact interaction summary", () => {
  test("keeps the released schema-1 writer on its exact pinned platform", () => {
    expect(() => assertBeeperContactInteractionExportRuntime("darwin", "arm64"))
      .not.toThrow();
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
    ] as const) {
      expect(() => assertBeeperContactInteractionExportRuntime(platform, arch))
        .toThrow("schema-1 export requires the pinned darwin/arm64 Beeper CLI artifact");
    }
  });

  test("derives exact content-free direct relationship lower bounds", async () => {
    const summary = await summarizeBeeperContactInteractions(fixture());
    expect(summary.accounts).toEqual([expect.objectContaining({
      accountId: "raw-account/signal",
      selfParticipantId: "raw-self",
      network: "signal",
    })]);
    expect(summary.interactions).toEqual([expect.objectContaining({
      accountId: "raw-account/signal",
      contactId: "raw-peer",
      sentCount: 1,
      receivedCount: 1,
      interactionCount: 2,
      conversationCount: 1,
      firstInteractionAt: "2026-08-26T12:00:02.000Z",
      lastInteractionAt: "2026-08-26T12:00:03.000Z",
      reciprocal: true,
      completeness: "lower-bound",
    })]);
    expect(summary.counts).toEqual({
      accounts: 1,
      directRelationships: 1,
      directConversations: 1,
      interactions: 2,
      sent: 1,
      received: 1,
    });
    expect(parseBeeperContactInteractionSummary(
      JSON.parse(JSON.stringify(summary)) as unknown,
    )).toEqual(summary);
  });

  test("never emits bodies, names, attachment metadata, group content, or paths", async () => {
    const summary = await summarizeBeeperContactInteractions(fixture());
    const encoded = canonicalJson(summary);
    for (const forbidden of [
      "SECRET",
      "Secret name",
      "Secret direct title",
      "Secret group title",
      "private-photo.png",
      "image/png",
      "/tmp/",
    ]) expect(encoded).not.toContain(forbidden);
    expect(summary.privacy).toEqual({
      messageBodies: "excluded",
      attachments: "excluded",
      reactions: "excluded",
      media: "excluded",
      groupMessages: "excluded",
      localPaths: "excluded",
      credentials: "excluded",
    });
  });

  test("binds a strict content-free execution receipt to the exact summary", async () => {
    const summary = await summarizeBeeperContactInteractions(fixture());
    const result = createBeeperContactInteractionExportResult({
      runId: "00000000-0000-4000-8000-000000000123",
      startedAt: "2026-08-26T11:59:59.000Z",
      finishedAt: "2026-08-26T12:00:05.000Z",
      authId: "beeper-main",
      authIdentitySha256: "a".repeat(64),
      bounds: Object.freeze({
        limitChats: 100,
        limitMessages: null,
        maxParticipants: 500,
      }),
      output: summary,
    });
    expect(parseBeeperContactInteractionExportResult(
      JSON.parse(JSON.stringify(result)) as unknown,
    )).toEqual(result);
    expect(result.receipt.output.summarySha256).toBe(
      summary.integrity.summarySha256,
    );
    expect(result.receipt.transport).toBe("linked-device");
    expect(result.receipt.implementation).toEqual(
      BEEPER_CONTACT_INTERACTION_IMPLEMENTATION,
    );
    const encoded = canonicalJson(result);
    for (const forbidden of [
      "SECRET",
      "private-photo.png",
      "image/png",
      "/private/",
      "/tmp/",
    ]) expect(encoded).not.toContain(forbidden);

    let getterCalls = 0;
    const malicious: Record<string, unknown> = {};
    Object.defineProperty(malicious, "receipt", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return result.receipt;
      },
    });
    Object.defineProperty(malicious, "output", {
      enumerable: true,
      value: result.output,
    });
    expect(() => parseBeeperContactInteractionExportResult(malicious)).toThrow(
      "enumerable data property",
    );
    expect(getterCalls).toBe(0);

    const transportDrift = JSON.parse(JSON.stringify(result)) as {
      receipt: { transport: string };
    };
    transportDrift.receipt.transport = "provider-api";
    expect(() => parseBeeperContactInteractionExportResult(transportDrift)).toThrow(
      "export receipt identity is unsupported",
    );

    const implementationDrift = JSON.parse(JSON.stringify(result)) as {
      receipt: { implementation: { officialCli: { commit: string } } };
    };
    implementationDrift.receipt.implementation.officialCli.commit = "b".repeat(40);
    expect(() => parseBeeperContactInteractionExportResult(implementationDrift)).toThrow(
      "export receipt implementation identity is unsupported",
    );
  });

  test("keeps the receipt producer synchronized with the package release", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version?: string };
    if (manifest.version !== WRENCH_VERSION) {
      throw new Error("Wrench package and runtime versions diverged");
    }
    expect(manifest.version).toBe(WRENCH_VERSION);
    expect(BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.producer).toEqual({
      package: "@hraness/wrench",
      version: WRENCH_VERSION,
    });
  });

  test("encodes the exact result as compact bounded terminal-safe JSON", async () => {
    const summary = await summarizeBeeperContactInteractions(fixture({
      accountId: "raw-account\u0080signal",
    }));
    const result = createBeeperContactInteractionExportResult({
      runId: "00000000-0000-4000-8000-000000000124",
      startedAt: "2026-08-26T11:59:59.000Z",
      finishedAt: "2026-08-26T12:00:05.000Z",
      authId: "beeper-main",
      authIdentitySha256: "a".repeat(64),
      bounds: Object.freeze({
        limitChats: null,
        limitMessages: null,
        maxParticipants: null,
      }),
      output: summary,
    });
    const wire = encodeBeeperContactInteractionExportResult(result);
    expect(wire).toContain("\\u0080");
    expect(wire).not.toContain("\u0080");
    expect(wire).not.toContain("\n  \"");
    expect(JSON.parse(wire)).toEqual(result);
  });

  test("fails closed on raw-coordinate drift and digest tampering", async () => {
    const mismatched = fixture();
    await expect(summarizeBeeperContactInteractions({
      ...mismatched,
      coordinateForRecord: (value) => {
        const original = mismatched.coordinateForRecord(value);
        return original?.kind === "account"
          ? Object.freeze({ kind: "account", accountId: "different-account" })
          : original;
      },
    })).rejects.toThrow("coordinate does not bind");

    const summary = await summarizeBeeperContactInteractions(fixture());
    const tampered = JSON.parse(JSON.stringify(summary)) as {
      counts: { sent: number };
    };
    tampered.counts.sent += 1;
    expect(() => parseBeeperContactInteractionSummary(tampered)).toThrow(
      "summary counts are inconsistent",
    );
  });

  test("rejects impossible relationship and conversation counts", async () => {
    const summary = await summarizeBeeperContactInteractions(fixture());
    const undercounted = JSON.parse(JSON.stringify(summary)) as {
      counts: { directConversations: number };
    };
    undercounted.counts.directConversations = 0;
    expect(() => parseBeeperContactInteractionSummary(undercounted)).toThrow(
      "summary counts are inconsistent",
    );

    const impossible = JSON.parse(JSON.stringify(summary)) as {
      counts: { directConversations: number };
      interactions: Array<{ conversationCount: number }>;
    };
    impossible.interactions[0]!.conversationCount = 3;
    impossible.counts.directConversations = 3;
    expect(() => parseBeeperContactInteractionSummary(impossible)).toThrow(
      "an interaction has inconsistent counts or completeness",
    );
  });

  test("rejects replacement local and provider target disagreement", async () => {
    const invalid = fixture();
    const records = invalid.records.map((record) =>
      record.kind === "message" && record.edit?.kind === "replacement"
        ? Object.freeze({
            ...record,
            edit: Object.freeze({
              ...record.edit,
              replacesProviderId: providerId(
                "message",
                "raw-account/signal",
                "raw-direct-chat",
                "missing-provider-target",
              ),
            }),
          })
        : record);
    const coordinates = new Map(records.map((record, index) => [
      record,
      invalid.coordinateForRecord(invalid.records[index]),
    ]));
    await expect(summarizeBeeperContactInteractions({
      source: Object.freeze({
        ...invalid.source,
        records: (async function* () { yield* records; })(),
      }),
      coordinateForRecord: (value) =>
        coordinates.get(value as BeeperMessageLikeMeRecord),
    })).rejects.toThrow("replacement local and provider coordinates disagree");
  });

  test("reserves room for every transform warning after a maximum source set", async () => {
    const bounded = fixture();
    const sourceWarnings = Object.freeze(Array.from(
      { length: LOCAL_MESSAGE_BUNDLE_V1_LIMITS.warnings },
      (_, index) => `source-warning-${String(index).padStart(3, "0")}`,
    ));
    const summary = await summarizeBeeperContactInteractions({
      source: Object.freeze({
        ...bounded.source,
        records: (async function* () { yield* bounded.records; })(),
        completion: () => Promise.resolve(Object.freeze({
          completeness: Object.freeze({
            kind: "bounded-local" as const,
            reason: "desktop-local-sequential-export",
            observedFrom: "2026-08-26T12:00:01.000Z",
            observedThrough: "2026-08-26T12:00:04.000Z",
          }),
          warnings: sourceWarnings,
        })),
      }),
      coordinateForRecord: bounded.coordinateForRecord,
    });
    expect(summary.warnings).toHaveLength(
      LOCAL_MESSAGE_BUNDLE_V1_LIMITS.warnings + 4,
    );
    expect(parseBeeperContactInteractionSummary(
      JSON.parse(JSON.stringify(summary)) as unknown,
    )).toEqual(summary);
  });

  test("counts account-scoped conversation coordinates independently", async () => {
    const first = fixture({
      accountId: "account-a",
      selfId: "self-a",
      peerId: "peer-a",
      directConversationId: "same-provider-chat-id",
    });
    const second = fixture({
      accountId: "account-b",
      selfId: "self-b",
      peerId: "peer-b",
      directConversationId: "same-provider-chat-id",
    });
    const summary = await summarizeBeeperContactInteractions({
      source: Object.freeze({
        descriptor: first.source.descriptor,
        records: (async function* () {
          yield* first.records;
          yield* second.records;
        })(),
        completion: first.source.completion,
      }),
      coordinateForRecord: (value) =>
        first.coordinateForRecord(value) ?? second.coordinateForRecord(value),
    });
    expect(summary.counts.accounts).toBe(2);
    expect(summary.counts.directRelationships).toBe(2);
    expect(summary.counts.directConversations).toBe(2);
  });

  test("uses one locale-independent canonical coordinate order", async () => {
    const accented = fixture({
      accountId: "account-é",
      selfId: "self-é",
      peerId: "peer-é",
    });
    const punctuated = fixture({
      accountId: "account-z_",
      selfId: "self-z_",
      peerId: "peer-z_",
    });
    const summary = await summarizeBeeperContactInteractions({
      source: Object.freeze({
        descriptor: accented.source.descriptor,
        records: (async function* () {
          yield* accented.records;
          yield* punctuated.records;
        })(),
        completion: accented.source.completion,
      }),
      coordinateForRecord: (value) =>
        accented.coordinateForRecord(value) ?? punctuated.coordinateForRecord(value),
    });
    expect(summary.accounts.map((account) => account.accountId)).toEqual([
      "account-z_",
      "account-é",
    ]);
    expect(summary.interactions.map((interaction) => interaction.accountId)).toEqual([
      "account-z_",
      "account-é",
    ]);
    expect(parseBeeperContactInteractionSummary(
      JSON.parse(JSON.stringify(summary)) as unknown,
    )).toEqual(summary);
  });

  test("rejects a recomputed-digest relationship to the account self", async () => {
    const summary = await summarizeBeeperContactInteractions(fixture());
    const tampered = JSON.parse(JSON.stringify(summary)) as Record<string, unknown> & {
      accounts: Array<{
        selfParticipantId: string;
        selfParticipantProviderId: string;
      }>;
      interactions: Array<{
        contactId: string;
        contactProviderId: string;
      }>;
      integrity: { algorithm: "sha256"; summarySha256: string };
    };
    tampered.interactions[0]!.contactId = tampered.accounts[0]!.selfParticipantId;
    tampered.interactions[0]!.contactProviderId =
      tampered.accounts[0]!.selfParticipantProviderId;
    const { integrity: _integrity, ...projection } = tampered;
    tampered.integrity.summarySha256 = sha256(canonicalJson(projection));
    expect(() => parseBeeperContactInteractionSummary(tampered)).toThrow(
      "an interaction contact cannot be the account self participant",
    );
  });

  test("rejects a recomputed digest whose observation misses retained facts", async () => {
    const summary = await summarizeBeeperContactInteractions(fixture());
    for (const observedAt of [null, "2026-08-26T12:00:00.000Z"] as const) {
      const tampered = JSON.parse(JSON.stringify(summary)) as Record<string, unknown> & {
        observedAt: string | null;
        integrity: { algorithm: "sha256"; summarySha256: string };
      };
      tampered.observedAt = observedAt;
      const { integrity: _integrity, ...projection } = tampered;
      tampered.integrity.summarySha256 = sha256(canonicalJson(projection));
      expect(() => parseBeeperContactInteractionSummary(tampered)).toThrow(
        "summary observation does not cover retained relationship facts",
      );
    }
  });

  test("rejects direction and complete-roster contradictions", async () => {
    const invalidDirection = fixture();
    const incomingId = localId(
      "message",
      "raw-account/signal",
      "raw-direct-chat",
      "incoming",
    );
    const records = invalidDirection.records.map((record) =>
      record.kind === "message" && record.id === incomingId
        ? Object.freeze({ ...record, direction: "outgoing" as const })
        : record);
    const coordinates = new Map(records.map((record, index) => [
      record,
      invalidDirection.coordinateForRecord(invalidDirection.records[index]),
    ]));
    await expect(summarizeBeeperContactInteractions({
      source: Object.freeze({
        ...invalidDirection.source,
        records: (async function* () { yield* records; })(),
      }),
      coordinateForRecord: (value) => coordinates.get(value as BeeperMessageLikeMeRecord),
    })).rejects.toThrow("direction conflicts");

    const invalidRoster = fixture();
    const rosterRecords = invalidRoster.records.map((record) =>
      record.kind === "message" && record.id === incomingId
        ? Object.freeze({
            ...record,
            senderParticipantId: localId(
              "participant",
              "raw-account/signal",
              "raw-group-peer",
            ),
          })
        : record);
    const rosterCoordinates = new Map(rosterRecords.map((record, index) => [
      record,
      invalidRoster.coordinateForRecord(invalidRoster.records[index]),
    ]));
    await expect(summarizeBeeperContactInteractions({
      source: Object.freeze({
        ...invalidRoster.source,
        records: (async function* () { yield* rosterRecords; })(),
      }),
      coordinateForRecord: (value) =>
        rosterCoordinates.get(value as BeeperMessageLikeMeRecord),
    })).rejects.toThrow("absent from the complete conversation roster");
  });
});
