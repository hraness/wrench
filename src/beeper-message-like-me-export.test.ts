import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { canonicalJson } from "./canonical-json";
import {
  exportBeeperMessageLikeMeBundle,
  type BeeperMessageLikeMeExportSource,
} from "./beeper-message-like-me-export";
import {
  BEEPER_MESSAGE_LIKE_ME_GOLDEN_FINISHED_AT,
  BEEPER_MESSAGE_LIKE_ME_GOLDEN_STARTED_AT,
  createBeeperMessageLikeMeGoldenSource,
} from "./beeper-message-like-me-golden-fixture";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function privateTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beeper-message-like-me-export-test-"));
  temporaryRoots.push(root);
  await chmod(root, 0o700);
  return realpath(root);
}

function provenance(providerId: string, revision: string | null = "r1") {
  return {
    providerId,
    providerRevision: revision,
    observedAt: "2026-08-21T12:00:00.000Z",
    connectedAccountProviderId: "beeper-account-whatsapp",
  };
}

function records(): readonly unknown[] {
  return [
    {
      schemaVersion: 1,
      kind: "account",
      id: "account:whatsapp:primary",
      accountId: "account:whatsapp:primary",
      network: "whatsapp",
      provenance: provenance("beeper-account-whatsapp"),
      displayName: "Primary WhatsApp",
      handle: "+15555550100",
      selfParticipantId: "participant:self",
    },
    {
      schemaVersion: 1,
      kind: "participant",
      id: "participant:self",
      accountId: "account:whatsapp:primary",
      network: "whatsapp",
      provenance: provenance("beeper-user-self"),
      displayName: "Me",
      handle: "+15555550100",
      isSelf: true,
    },
    {
      schemaVersion: 1,
      kind: "conversation",
      id: "conversation:friend",
      accountId: "account:whatsapp:primary",
      network: "whatsapp",
      provenance: provenance("beeper-chat-1"),
      type: "direct",
      title: "Friend",
      participantIds: ["participant:self", "participant:peer"],
      participantsComplete: true,
      startedAt: "2026-08-20T12:00:00.000Z",
      lastMessageAt: "2026-08-21T11:59:00.000Z",
    },
    {
      schemaVersion: 1,
      kind: "message",
      id: "message:edited",
      accountId: "account:whatsapp:primary",
      network: "whatsapp",
      provenance: provenance("beeper-message-2", "message-r3"),
      conversationId: "conversation:friend",
      senderParticipantId: "participant:self",
      direction: "outgoing",
      sentAt: "2026-08-21T11:58:00.000Z",
      sortKey: "00000000000000000042",
      body: null,
      bodyTruncated: false,
      replyTo: {
        messageId: null,
        providerId: "beeper-message-1",
      },
      edit: {
        kind: "in-place",
        editedAt: "2026-08-21T11:59:00.000Z",
        providerRevision: "message-r3",
      },
      deletion: {
        state: "deleted-for-me",
        observedAt: "2026-08-21T12:00:00.000Z",
        providerRevision: "message-r4",
      },
      attachments: [{
        kind: "image",
        mimeType: "image/jpeg",
        name: "photo.jpg",
        sizeBytes: 1234,
      }],
    },
    {
      schemaVersion: 1,
      kind: "reaction",
      id: "reaction:1",
      accountId: "account:whatsapp:primary",
      network: "whatsapp",
      provenance: provenance("beeper-reaction-1"),
      messageId: "message:edited",
      messageProviderId: "beeper-message-2",
      participantId: "participant:self",
      body: "👍",
      reactedAt: null,
      state: "active",
    },
    {
      schemaVersion: 1,
      kind: "tombstone",
      id: "tombstone:message:old",
      accountId: "account:whatsapp:primary",
      network: "whatsapp",
      provenance: provenance("beeper-message-old", "deleted-r2"),
      entityKind: "message",
      entityId: null,
      entityProviderId: "beeper-message-old",
      deletedAt: "2026-08-21T10:00:00.000Z",
      scope: "remote",
      providerRevision: "deleted-r2",
    },
    {
      schemaVersion: 1,
      kind: "participant",
      id: "participant:peer",
      accountId: "account:whatsapp:primary",
      network: "whatsapp",
      provenance: provenance("beeper-user-peer"),
      displayName: "Friend",
      handle: "+15555550101",
      isSelf: false,
    },
  ];
}

function source(values: readonly unknown[] = records()): BeeperMessageLikeMeExportSource {
  return {
    descriptor: {
      source: { id: "beeper-local", version: "1.0.0" },
      provider: { id: "beeper", version: "4.1.0" },
    },
    records: (async function* () {
      for (const value of values) yield value;
    })(),
    completion: async () => ({
      completeness: {
        kind: "bounded-local",
        reason: "desktop-local-cache",
        observedFrom: "2026-08-20T12:00:00.000Z",
        observedThrough: "2026-08-21T12:00:00.000Z",
      },
      warnings: ["attachments-metadata-only", "remote-history-not-claimed"],
    }),
  };
}

function clock(...values: readonly string[]): () => Date {
  let index = 0;
  return () => new Date(values[index++] ?? "invalid");
}

describe("exportBeeperMessageLikeMeBundle", () => {
  test("reproduces the checked v1 cross-repository golden bundle byte for byte", async () => {
    const parent = await privateTemporaryRoot();
    const outputRoot = join(parent, "golden");
    const result = await exportBeeperMessageLikeMeBundle({
      outputRoot,
      source: createBeeperMessageLikeMeGoldenSource(),
      clock: clock(
        BEEPER_MESSAGE_LIKE_ME_GOLDEN_STARTED_AT,
        BEEPER_MESSAGE_LIKE_ME_GOLDEN_FINISHED_AT,
      ),
    });
    const fixtureRoot = join(
      import.meta.dir,
      "fixtures",
      "beeper-message-like-me-v1",
    );
    const expectedFiles = (await readdir(fixtureRoot)).sort();
    expect((await readdir(outputRoot)).sort()).toEqual(expectedFiles);
    for (const fileName of expectedFiles) {
      expect(await readFile(join(outputRoot, fileName))).toEqual(
        await readFile(join(fixtureRoot, fileName)),
      );
    }
    expect(result.manifestSha256).toBe(
      "e46f4a524d53f849cfac594fb5bc8cf28e7a9743c138039b81a0aad4ff4830ef",
    );
    expect(result.manifest.completeness).toMatchObject({
      kind: "truncated",
      reason: "explicit-source-limit",
    });
    const goldenMessages = (await readFile(join(outputRoot, "messages.ndjson"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(goldenMessages).toHaveLength(2);
    expect(goldenMessages[0]).toMatchObject({
      body: "edited synthetic reply",
      replyTo: { messageId: null },
      edit: { kind: "in-place" },
      deletion: null,
    });
    expect(goldenMessages[1]).toMatchObject({
      body: null,
      edit: null,
      deletion: { state: "revoked" },
    });
    const goldenReaction = JSON.parse(
      await readFile(join(outputRoot, "reactions.ndjson"), "utf8"),
    ) as Record<string, unknown>;
    expect(goldenReaction.reactedAt).toBeNull();
  });

  test("streams a private provenance-preserving bundle and publishes its manifest last", async () => {
    const parent = await privateTemporaryRoot();
    const outputRoot = join(parent, "message-like-me");
    const result = await exportBeeperMessageLikeMeBundle({
      outputRoot,
      source: source(),
      clock: clock("2026-08-21T12:01:00.000Z", "2026-08-21T12:02:00.000Z"),
    });

    expect(result.outputRoot).toBe(outputRoot);
    expect(result.manifest.counts).toEqual({
      account: 1,
      participant: 2,
      conversation: 1,
      message: 1,
      reaction: 1,
      tombstone: 1,
    });
    expect(result.manifest.timestamps).toEqual({
      startedAt: "2026-08-21T12:01:00.000Z",
      finishedAt: "2026-08-21T12:02:00.000Z",
      createdAt: "2026-08-21T12:02:00.000Z",
    });
    expect(result.manifest.completeness.kind).toBe("bounded-local");
    expect(result.manifest.privacy).toEqual({
      classification: "private-local",
      attachments: "metadata-only",
      providerUrls: "excluded",
      credentials: "excluded",
    });

    const expectedFiles = [
      "accounts.ndjson",
      "conversations.ndjson",
      "manifest.json",
      "messages.ndjson",
      "participants.ndjson",
      "reactions.ndjson",
      "tombstones.ndjson",
    ];
    expect((await readdir(outputRoot)).sort()).toEqual(expectedFiles);
    expect((await lstat(outputRoot)).mode & 0o777).toBe(0o700);

    for (const artifact of result.manifest.artifacts) {
      const path = join(outputRoot, artifact.path);
      const contents = await readFile(path);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(contents.byteLength).toBe(artifact.bytes);
      expect(createHash("sha256").update(contents).digest("hex")).toBe(artifact.sha256);
    }
    expect((await lstat(result.manifestPath)).mode & 0o777).toBe(0o600);
    const manifestSource = await readFile(result.manifestPath, "utf8");
    expect(createHash("sha256").update(manifestSource).digest("hex")).toBe(result.manifestSha256);
    expect(JSON.parse(manifestSource)).toEqual(result.manifest);

    const integrityInput = {
      schemaVersion: result.manifest.schemaVersion,
      format: result.manifest.format,
      source: result.manifest.source,
      provider: result.manifest.provider,
      timestamps: result.manifest.timestamps,
      completeness: result.manifest.completeness,
      warnings: result.manifest.warnings,
      privacy: result.manifest.privacy,
      counts: result.manifest.counts,
      artifacts: result.manifest.artifacts,
    };
    expect(result.manifest.integrity.bundleSha256).toBe(
      createHash("sha256").update(canonicalJson(integrityInput)).digest("hex"),
    );

    const message = JSON.parse(await readFile(join(outputRoot, "messages.ndjson"), "utf8"));
    expect(message).toMatchObject({
      accountId: "account:whatsapp:primary",
      network: "whatsapp",
      sortKey: "00000000000000000042",
      body: null,
      replyTo: { providerId: "beeper-message-1" },
      edit: { providerRevision: "message-r3" },
      deletion: { providerRevision: "message-r4" },
      provenance: {
        connectedAccountProviderId: "beeper-account-whatsapp",
        providerId: "beeper-message-2",
      },
    });
    expect(manifestSource).not.toContain(outputRoot);
    expect(manifestSource).not.toContain("token");
  });

  test("rejects foreign fields before they can introduce provider URLs", async () => {
    const parent = await privateTemporaryRoot();
    const outputRoot = join(parent, "strict");
    const account = { ...records()[0] as Record<string, unknown>, mediaUrl: "https://provider.invalid/private" };

    await expect(exportBeeperMessageLikeMeBundle({
      outputRoot,
      source: source([account]),
    })).rejects.toThrow("must contain exactly");

    expect((await lstat(outputRoot)).mode & 0o777).toBe(0o700);
    await expect(lstat(join(outputRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("enforces the async stream record bound", async () => {
    const parent = await privateTemporaryRoot();
    const outputRoot = join(parent, "bounded");
    const second = {
      ...records()[0] as Record<string, unknown>,
      id: "account:whatsapp:secondary",
      accountId: "account:whatsapp:secondary",
      selfParticipantId: "participant:self:secondary",
    };

    await expect(exportBeeperMessageLikeMeBundle({
      outputRoot,
      source: source([records()[0], second]),
      limits: { maxRecords: 1 },
    })).rejects.toThrow("record stream exceeds the configured record bound");
    await expect(lstat(join(outputRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("enforces importer-compatible bundle and connected-account bounds", async () => {
    const parent = await privateTemporaryRoot();
    const oversizedLimitsOutput = join(parent, "oversized-limits");
    await expect(exportBeeperMessageLikeMeBundle({
      outputRoot: oversizedLimitsOutput,
      source: source([]),
      limits: { maxRecords: 500_001 },
    })).rejects.toThrow("maxRecords");
    await expect(lstat(oversizedLimitsOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const accounts = Array.from({ length: 129 }, (_, index) => {
      const providerAccountId = `provider-account-${String(index)}`;
      return {
        schemaVersion: 1,
        kind: "account",
        id: `account:${String(index)}`,
        accountId: `account:${String(index)}`,
        network: "beeper",
        provenance: {
          providerId: providerAccountId,
          providerRevision: null,
          observedAt: "2026-08-21T12:00:00.000Z",
          connectedAccountProviderId: providerAccountId,
        },
        displayName: null,
        handle: null,
        selfParticipantId: `participant:self:${String(index)}`,
      };
    });
    const accountBoundOutput = join(parent, "account-bound");
    await expect(exportBeeperMessageLikeMeBundle({
      outputRoot: accountBoundOutput,
      source: source(accounts),
    })).rejects.toThrow("connected-account bound");
    await expect(lstat(join(accountBoundOutput, "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses relative, existing, and symlink-traversing output roots", async () => {
    const parent = await privateTemporaryRoot();

    await expect(exportBeeperMessageLikeMeBundle({
      outputRoot: "relative-bundle",
      source: source([]),
    })).rejects.toThrow("normalized absolute path");

    const existing = join(parent, "existing");
    await chmod(parent, 0o700);
    await Bun.write(existing, "owned by caller");
    await expect(exportBeeperMessageLikeMeBundle({
      outputRoot: existing,
      source: source([]),
    })).rejects.toThrow("already exists");

    const permissive = join(parent, "permissive");
    await mkdir(permissive, { mode: 0o700 });
    await chmod(permissive, 0o777);
    await expect(exportBeeperMessageLikeMeBundle({
      outputRoot: join(permissive, "bundle"),
      source: source([]),
    })).rejects.toThrow("must not be writable by the group or other users");

    const physical = join(parent, "physical");
    const linked = join(parent, "linked");
    await mkdir(physical, { mode: 0o700 });
    await symlink(physical, linked);
    await expect(exportBeeperMessageLikeMeBundle({
      outputRoot: join(linked, "bundle"),
      source: source([]),
    })).rejects.toThrow("parent must be a real directory");
  });

  test("validates provider identities and cross-record references without echoing foreign IDs", async () => {
    const cases: readonly {
      readonly name: string;
      readonly values: readonly unknown[];
      readonly message: string;
      readonly secret?: string;
    }[] = [
      {
        name: "duplicate provider coordinate",
        values: [
          ...records(),
          {
            ...records()[1] as Record<string, unknown>,
            id: "participant:duplicate",
            isSelf: false,
          },
        ],
        message: "repeats an account-scoped provider identity",
      },
      {
        name: "missing self participant",
        values: records().map((value, index) => index === 0
          ? {
              ...value as Record<string, unknown>,
              selfParticipantId: "private-matrix-self-identifier",
            }
          : value),
        message: "account self participant does not resolve",
        secret: "private-matrix-self-identifier",
      },
      {
        name: "conversation participant realm",
        values: records().map((value, index) => index === 2
          ? {
              ...value as Record<string, unknown>,
              participantIds: ["private-matrix-participant-identifier"],
            }
          : value),
        message: "conversation participant does not resolve",
        secret: "private-matrix-participant-identifier",
      },
      {
        name: "sender direction",
        values: records().map((value, index) => index === 3
          ? { ...value as Record<string, unknown>, direction: "incoming" }
          : value),
        message: "message direction conflicts",
      },
      {
        name: "reaction provider coordinate",
        values: records().map((value, index) => index === 4
          ? {
              ...value as Record<string, unknown>,
              messageProviderId: "private-provider-target-identifier",
            }
          : value),
        message: "reaction message target provider coordinate does not match",
        secret: "private-provider-target-identifier",
      },
      {
        name: "tombstone provider coordinate",
        values: records().map((value, index) => index === 5
          ? {
              ...value as Record<string, unknown>,
              entityId: "message:edited",
              entityProviderId: "private-provider-tombstone-identifier",
            }
          : value),
        message: "tombstone entity provider coordinate does not match",
        secret: "private-provider-tombstone-identifier",
      },
    ];

    for (const item of cases) {
      const parent = await privateTemporaryRoot();
      let failure: unknown;
      try {
        await exportBeeperMessageLikeMeBundle({
          outputRoot: join(parent, item.name.replaceAll(" ", "-")),
          source: source(item.values),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(item.message);
      if (item.secret !== undefined) {
        expect((failure as Error).message).not.toContain(item.secret);
      }
    }
  });

  test("enforces reply, replacement, and complete-roster graph semantics", async () => {
    const base = records();
    const otherConversation = {
      ...base[2] as Record<string, unknown>,
      id: "conversation:other",
      provenance: provenance("beeper-chat-2"),
      title: "Other",
    };
    const message = (
      id: string,
      providerId: string,
      conversationId = "conversation:friend",
      edit: unknown = null,
    ) => ({
      ...base[3] as Record<string, unknown>,
      id,
      provenance: provenance(providerId, `${providerId}-revision`),
      conversationId,
      sortKey: `${providerId}-sort-key`,
      body: "synthetic graph fixture",
      replyTo: null,
      edit,
      deletion: null,
      attachments: [],
    });
    const otherMessage = message(
      "message:other",
      "beeper-message-3",
      "conversation:other",
    );
    const participant = {
      ...base[1] as Record<string, unknown>,
      id: "participant:other",
      provenance: provenance("beeper-user-other"),
      displayName: "Other",
      handle: null,
      isSelf: false,
    };
    const replace = (providerId: string, localId: string | null = null) => ({
      kind: "replacement",
      replacesMessageId: localId,
      replacesProviderId: providerId,
      editedAt: "2026-08-21T11:59:00.000Z",
      providerRevision: "replacement-r1",
    });
    const mutateMain = (changes: Record<string, unknown>) =>
      base.map((value, index) => index === 3
        ? { ...value as Record<string, unknown>, ...changes }
        : value);

    const cases: readonly {
      readonly name: string;
      readonly values: readonly unknown[];
      readonly message: string;
    }[] = [{
      name: "complete direct missing peer",
      values: base.map((value, index) => index === 2
        ? {
            ...value as Record<string, unknown>,
            participantIds: ["participant:self"],
          }
        : value),
      message: "must contain exactly one self participant and one peer",
    }, {
      name: "provider-only cross-conversation reply",
      values: [
        ...mutateMain({
          replyTo: { messageId: null, providerId: "beeper-message-3" },
        }),
        otherConversation,
        otherMessage,
      ],
      message: "reply target belongs to a different conversation",
    }, {
      name: "self reply",
      values: mutateMain({
        replyTo: { messageId: null, providerId: "beeper-message-2" },
      }),
      message: "must not reply to itself",
    }, {
      name: "provider-only cross-conversation replacement",
      values: [
        ...mutateMain({ edit: replace("beeper-message-3") }),
        otherConversation,
        otherMessage,
      ],
      message: "replacement edit target belongs to a different conversation",
    }, {
      name: "multiple replacements",
      values: [
        ...mutateMain({ edit: replace("beeper-message-3") }),
        message("message:target", "beeper-message-3"),
        message(
          "message:second-replacer",
          "beeper-message-4",
          "conversation:friend",
          replace("beeper-message-3"),
        ),
      ],
      message: "more than one replacement",
    }, {
      name: "replacement cycle",
      values: [
        ...mutateMain({ edit: replace("beeper-message-3") }),
        message(
          "message:cycle",
          "beeper-message-3",
          "conversation:friend",
          replace("beeper-message-2"),
        ),
      ],
      message: "replacement edit graph contains a cycle",
    }, {
      name: "sender absent from complete roster",
      values: [
        ...mutateMain({
          senderParticipantId: "participant:other",
          direction: "incoming",
        }),
        participant,
      ],
      message: "sender is absent from the complete conversation roster",
    }, {
      name: "reaction actor absent from complete roster",
      values: [
        ...base.map((value, index) => index === 4
          ? {
              ...value as Record<string, unknown>,
              messageId: null,
              participantId: "participant:other",
            }
          : value),
        participant,
      ],
      message: "reaction participant is absent from the complete conversation roster",
    }, {
      name: "stable account realm",
      values: [
        ...base,
        {
          ...base[0] as Record<string, unknown>,
          id: "account:duplicate-realm",
          accountId: "account:duplicate-realm",
          network: "renamed-whatsapp",
          selfParticipantId: "participant:self:duplicate-realm",
        },
        {
          ...base[1] as Record<string, unknown>,
          id: "participant:self:duplicate-realm",
          accountId: "account:duplicate-realm",
          network: "renamed-whatsapp",
        },
      ],
      message: "repeat one stable provider realm",
    }];

    for (const item of cases) {
      const parent = await privateTemporaryRoot();
      await expect(exportBeeperMessageLikeMeBundle({
        outputRoot: join(parent, item.name.replaceAll(" ", "-")),
        source: source(item.values),
      })).rejects.toThrow(item.message);
    }
  });
});
