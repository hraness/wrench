import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "./auth";
import { exportBeeperMessageLikeMeBundle } from "./beeper-message-like-me-export";
import {
  createBeeperMessageLikeMeSource,
  type BeeperExportCliInvocation,
} from "./beeper-message-like-me-source";

const ACCOUNT_ID = "account-beeper";
const NETWORK_ACCOUNT_ID = "account-whatsapp";
const SELF_ID = "@self:beeper.local";
const CHAT_ID = "chat-synthetic";
const SUBJECT = `beeper:local:${createHash("sha256")
  .update(ACCOUNT_ID, "utf8")
  .update("\0", "utf8")
  .update(SELF_ID, "utf8")
  .digest("hex")}`;

function privateDirectory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(path, 0o700);
  return path;
}

function configStore(parent: string): string {
  const path = join(parent, "beeper-config");
  mkdirSync(join(path, "targets"), { recursive: true, mode: 0o755 });
  chmodSync(path, 0o755);
  writeFileSync(
    join(path, "config.json"),
    `${JSON.stringify({ defaultTarget: "desktop" })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(path, "targets", "desktop.json"),
    `${JSON.stringify({
      auth: { token: "fixture" },
      baseURL: "http://127.0.0.1:23380",
      id: "desktop",
      managed: true,
      name: "Desktop",
      runtime: "desktop",
      type: "desktop",
    })}\n`,
    { mode: 0o600 },
  );
  return path;
}

function auth(path: string): WrenchAuth {
  return {
    schemaVersion: 1,
    id: "beeper-export-fixture",
    kind: "linked-device-store",
    provider: "beeper",
    path,
    subject: SUBJECT,
  };
}

function accounts(): readonly unknown[] {
  return [{
    accountID: ACCOUNT_ID,
    bridge: { id: "beeper", provider: "cloud", type: "matrix" },
    network: "Beeper",
    status: "CONNECTED",
    user: {
      fullName: "Fixture Self",
      id: SELF_ID,
      isSelf: true,
    },
  }, {
    accountID: NETWORK_ACCOUNT_ID,
    bridge: { id: "whatsapp", provider: "cloud", type: "whatsapp" },
    network: "WhatsApp Personal",
    status: "CONNECTED",
    user: {
      fullName: "Fixture Self",
      id: "whatsapp:self",
      isSelf: true,
      phoneNumber: "+15550000000",
    },
  }];
}

function chat() {
  return {
    accountID: NETWORK_ACCOUNT_ID,
    id: CHAT_ID,
    lastActivity: "2026-08-21T14:00:03.000Z",
    network: "WhatsApp Personal",
    participants: {
      hasMore: false,
      items: [{
        fullName: "Ada Fixture",
        id: "whatsapp:ada",
        isSelf: false,
        phoneNumber: "+15550000001",
      }],
      total: 1,
    },
    title: "Ada Fixture",
    type: "single",
    unreadCount: 0,
  };
}

function messages(): readonly unknown[] {
  return [{
    accountID: NETWORK_ACCOUNT_ID,
    attachments: [{
      fileName: "folder/private-photo.jpg",
      fileSize: 123,
      id: "private-media-id",
      mimeType: "image/jpeg",
      srcURL: "file:///private/media/photo.jpg",
      type: "img",
    }],
    chatID: CHAT_ID,
    editedTimestamp: "2026-08-21T14:00:02.000Z",
    id: "message-outgoing",
    isSender: true,
    linkedMessageID: "message-outside-window",
    reactions: [{
      emoji: true,
      id: "reaction-1",
      participantID: "whatsapp:ada",
      reactionKey: "👍",
    }, {
      emoji: false,
      id: "reaction-2",
      participantID: "whatsapp:ada",
      reactionKey: "https://provider.invalid/private-custom-reaction",
    }],
    senderID: "whatsapp:self",
    senderName: "Fixture Self",
    sortKey: "00000000000000000001",
    text: "synthetic outgoing body",
    timestamp: "2026-08-21T14:00:01.000Z",
    type: "TEXT",
  }, {
    accountID: NETWORK_ACCOUNT_ID,
    chatID: CHAT_ID,
    id: "message-deleted",
    isDeleted: true,
    isHidden: false,
    isSender: false,
    senderID: "whatsapp:ada",
    senderName: "Ada Fixture",
    sortKey: "00000000000000000002",
    text: "deleted foreign body",
    timestamp: "2026-08-21T14:00:03.000Z",
    type: "TEXT",
  }];
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o644 });
}

function fixtureExport(invocation: BeeperExportCliInvocation): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  expect(invocation.arguments[0]).toBe("export");
  expect(invocation.arguments).toContain("--no-attachments");
  expect(invocation.arguments).not.toContain("--json");
  expect(invocation.arguments.indexOf("--read-only")).toBeGreaterThan(0);
  expect(invocation.environment.BEEPER_READONLY).toBe("1");
  const outputIndex = invocation.arguments.indexOf("--out");
  const outputRoot = invocation.arguments[outputIndex + 1];
  if (outputRoot === undefined) throw new Error("fixture export omitted --out");
  const chatsRoot = join(outputRoot, "chats");
  const chatRoot = join(chatsRoot, CHAT_ID);
  mkdirSync(join(chatRoot, "attachments"), { recursive: true, mode: 0o755 });
  const accountValues = accounts();
  const chatValues = [chat()];
  const messageValues = messages();
  writeJson(join(outputRoot, "accounts.json"), accountValues);
  writeJson(join(outputRoot, "chats.json"), chatValues);
  writeJson(join(chatRoot, "chat.json"), chat());
  writeJson(join(chatRoot, "messages.json"), messageValues);
  writeFileSync(
    join(chatRoot, "messages.markdown"),
    "private duplicate markdown\n",
    { mode: 0o644 },
  );
  writeFileSync(
    join(chatRoot, "messages.html"),
    "<p>private duplicate html</p>\n",
    { mode: 0o644 },
  );
  const createdAt = "2026-08-21T13:59:00.000Z";
  const completedAt = "2026-08-21T14:01:00.000Z";
  writeJson(join(outputRoot, ".beeper-export-state.json"), {
    chats: {
      [CHAT_ID]: {
        attachmentCount: 0,
        complete: true,
        cursor: null,
        messageCount: messageValues.length,
        startedAt: createdAt,
        updatedAt: completedAt,
      },
    },
    completedChatIDs: [CHAT_ID],
    createdAt,
    exportVersion: 1,
  });
  writeJson(join(outputRoot, "manifest.json"), {
    accounts: accountValues,
    attachmentCount: 0,
    chatCount: chatValues.length,
    completedAt,
    createdAt,
    messageCount: messageValues.length,
    version: 1,
  });
  return Promise.resolve({
    exitCode: 0,
    stdout: "Exported 1 chats, 2 messages, 0 attachments\n",
    stderr: "",
  });
}

function invocationOutputRoot(invocation: BeeperExportCliInvocation): string {
  const outputIndex = invocation.arguments.indexOf("--out");
  const outputRoot = invocation.arguments[outputIndex + 1];
  if (outputRoot === undefined) throw new Error("fixture export omitted --out");
  return outputRoot;
}

function ndjson(path: string): readonly Record<string, unknown>[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Beeper Message Like Me source", () => {
  test("converts one private official export without media or duplicate renderings", async () => {
    const parent = privateDirectory("wrench-beeper-source-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    let removed = false;
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
            removed = true;
          },
          runExport: fixtureExport,
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({
        outputRoot: output,
        source,
        clock: (() => {
          const values = [
            new Date("2026-08-21T14:02:00.000Z"),
            new Date("2026-08-21T14:03:00.000Z"),
          ];
          return () => values.shift() ?? new Date("invalid");
        })(),
      });

      expect(removed).toBeTrue();
      expect(existsSync(working)).toBeFalse();
      expect(result.manifest.completeness).toEqual({
        kind: "bounded-local",
        reason: "desktop-local-export",
        observedFrom: "2026-08-21T14:00:01.000Z",
        observedThrough: "2026-08-21T14:00:03.000Z",
      });
      expect(result.manifest.counts).toEqual({
        account: 2,
        participant: 3,
        conversation: 1,
        message: 2,
        reaction: 2,
        tombstone: 1,
      });
      expect(result.manifest.warnings).toEqual([
        "attachments-metadata-only",
        "connected-account-backfill-coverage-unknown",
        "remote-history-not-claimed",
      ]);

      const accountRows = ndjson(join(output, "accounts.ndjson"));
      expect(accountRows.find((row) => row.network === "whatsapp-personal"))
        .toMatchObject({ handle: "+15550000000" });
      const conversationRows = ndjson(join(output, "conversations.ndjson"));
      expect(conversationRows[0]).toMatchObject({
        participantsComplete: true,
        type: "direct",
      });
      expect((conversationRows[0]?.participantIds as readonly unknown[]).length)
        .toBeGreaterThanOrEqual(2);
      const messageRows = ndjson(join(output, "messages.ndjson"));
      expect(messageRows).toMatchObject([{
        attachments: [{ name: "private-photo.jpg" }],
        direction: "outgoing",
        edit: { kind: "in-place" },
        replyTo: { messageId: null },
      }, {
        body: null,
        deletion: { state: "revoked" },
        direction: "incoming",
      }]);
      expect(JSON.stringify(messageRows)).not.toContain("private-media-id");
      expect(JSON.stringify(messageRows)).not.toContain("file:///private");
      const reactionRows = ndjson(join(output, "reactions.ndjson"));
      expect(reactionRows[0]).toMatchObject({
        body: "👍",
        messageId: messageRows[0]?.id,
        messageProviderId: (messageRows[0]?.provenance as Record<string, unknown>).providerId,
        reactedAt: null,
      });
      expect(reactionRows[1]).toMatchObject({
        body: "custom-reaction",
        reactedAt: null,
      });
      expect(JSON.stringify(reactionRows)).not.toContain("provider.invalid");
      const tombstoneRows = ndjson(join(output, "tombstones.ndjson"));
      expect(tombstoneRows[0]).toMatchObject({
        entityId: messageRows[1]?.id,
        entityProviderId: (messageRows[1]?.provenance as Record<string, unknown>).providerId,
        scope: "remote",
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("marks explicit chat and message limits as truncation", async () => {
    const parent = privateDirectory("wrench-beeper-source-limit-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        limits: { limitChats: 1, limitMessages: 2 },
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          runExport: fixtureExport,
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.completeness.kind).toBe("truncated");
      expect(result.manifest.warnings).toContain("chat-limit-reached");
      expect(result.manifest.warnings).toContain("message-limit-reached");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("projects an irregular complete direct roster conservatively as incomplete", async () => {
    const parent = privateDirectory("wrench-beeper-source-direct-roster-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          runExport: async (invocation) => {
            const result = await fixtureExport(invocation);
            const extraPeer = {
              fullName: "Extra Fixture",
              id: "whatsapp:extra",
              isSelf: false,
              phoneNumber: "+15550000002",
            };
            const irregular = chat();
            irregular.participants.items.push(extraPeer);
            irregular.participants.total = 2;
            const outputRoot = invocationOutputRoot(invocation);
            writeJson(join(outputRoot, "chats.json"), [irregular]);
            writeJson(join(outputRoot, "chats", CHAT_ID, "chat.json"), irregular);
            return result;
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.warnings).toContain("participant-roster-incomplete");
      expect(ndjson(join(output, "conversations.ndjson"))[0]).toMatchObject({
        participantsComplete: false,
        type: "direct",
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("publishes a coherent truncated bundle at the global record budget", async () => {
    const parent = privateDirectory("wrench-beeper-source-record-limit-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          maxBundleRecords: 7,
          runExport: fixtureExport,
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.completeness).toMatchObject({
        kind: "truncated",
        reason: "bundle-record-limit",
      });
      expect(result.manifest.warnings).toContain("bundle-record-limit-reached");
      expect(result.manifest.counts).toEqual({
        account: 2,
        participant: 2,
        conversation: 0,
        message: 0,
        reaction: 0,
        tombstone: 0,
      });
      expect(existsSync(join(output, "manifest.json"))).toBeTrue();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("publishes a coherent truncated bundle at the global byte budget", async () => {
    const parent = privateDirectory("wrench-beeper-source-byte-limit-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          maxBundleBytes: 2_500,
          runExport: fixtureExport,
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.completeness).toMatchObject({
        kind: "truncated",
        reason: "bundle-byte-limit",
      });
      expect(result.manifest.warnings).toContain("bundle-byte-limit-reached");
      expect(result.manifest.counts.conversation).toBe(0);
      expect(existsSync(join(output, "manifest.json"))).toBeTrue();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects an official export whose accounts do not match the bound auth subject", async () => {
    const parent = privateDirectory("wrench-beeper-source-subject-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    let removed = false;
    try {
      const locator = auth(configStore(parent));
      const source = createBeeperMessageLikeMeSource({
        auth: {
          ...locator,
          subject: `beeper:local:${"0".repeat(64)}`,
        },
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
            removed = true;
          },
          runExport: fixtureExport,
        },
      });
      await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
        .rejects.toThrow("did not match the bound auth realm");
      expect(removed).toBeTrue();
      expect(existsSync(working)).toBeFalse();
      expect(existsSync(join(output, "manifest.json"))).toBeFalse();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("compares only bounded parsed account projections from the official manifest", async () => {
    const parent = privateDirectory("wrench-beeper-source-deep-account-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          runExport: async (invocation) => {
            const result = await fixtureExport(invocation);
            const outputRoot = invocationOutputRoot(invocation);
            const deepCapability = `${'{"next":'.repeat(5_000)}null${"}".repeat(5_000)}`;
            const accountRows = accounts().map((account, index) => {
              const encoded = JSON.stringify(account);
              return index === 0
                ? `${encoded.slice(0, -1)},"capabilities":${deepCapability}}`
                : encoded;
            });
            const accountsJson = `[${accountRows.join(",")}]`;
            writeFileSync(join(outputRoot, "accounts.json"), `${accountsJson}\n`, {
              mode: 0o644,
            });
            const manifest = {
              accounts: "__BOUNDED_ACCOUNTS__",
              attachmentCount: 0,
              chatCount: 1,
              completedAt: "2026-08-21T14:01:00.000Z",
              createdAt: "2026-08-21T13:59:00.000Z",
              messageCount: messages().length,
              version: 1,
            };
            writeFileSync(
              join(outputRoot, "manifest.json"),
              `${JSON.stringify(manifest).replace(
                '"__BOUNDED_ACCOUNTS__"',
                accountsJson,
              )}\n`,
              { mode: 0o644 },
            );
            return result;
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.counts.account).toBe(2);
      expect(existsSync(join(output, "manifest.json"))).toBeTrue();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects malformed and symlinked official export inputs and cleans private staging", async () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (outputRoot: string) => void;
      readonly error: string;
    }[] = [{
      name: "malformed-manifest",
      mutate: (outputRoot) => {
        writeJson(join(outputRoot, "manifest.json"), {
          accounts: accounts(),
          attachmentCount: 0,
          chatCount: 1,
          completedAt: "2026-08-21T14:01:00.000Z",
          createdAt: "2026-08-21T13:59:00.000Z",
          messageCount: 2,
          unreviewed: true,
          version: 1,
        });
      },
      error: "contains an unreviewed field",
    }, {
      name: "symlinked-messages",
      mutate: (outputRoot) => {
        const chatRoot = join(outputRoot, "chats", CHAT_ID);
        const messagesPath = join(chatRoot, "messages.json");
        unlinkSync(messagesPath);
        symlinkSync("chat.json", messagesPath);
      },
      error: "must not be a symbolic link",
    }];

    for (const item of cases) {
      const parent = privateDirectory(`wrench-beeper-source-${item.name}-test.`);
      const working = join(parent, "working");
      const output = join(parent, "message-like-me");
      mkdirSync(working, { mode: 0o700 });
      let removed = false;
      try {
        const source = createBeeperMessageLikeMeSource({
          auth: auth(configStore(parent)),
          dependencies: {
            binaryPath: "/fixture/beeper-0.6.2",
            createWorkingDirectory: async () => working,
            removeWorkingDirectory: async (path) => {
              rmSync(path, { recursive: true, force: true });
              removed = true;
            },
            runExport: async (invocation) => {
              const result = await fixtureExport(invocation);
              item.mutate(invocationOutputRoot(invocation));
              return result;
            },
          },
        });
        await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
          .rejects.toThrow(item.error);
        expect(removed).toBeTrue();
        expect(existsSync(working)).toBeFalse();
        expect(existsSync(join(output, "manifest.json"))).toBeFalse();
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });

  test("skips one oversized chat and publishes truthful truncated completeness", async () => {
    const parent = privateDirectory("wrench-beeper-source-size-bound-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    let removed = false;
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
            removed = true;
          },
          maxMessagesJsonBytes: 32,
          runExport: fixtureExport,
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.completeness).toMatchObject({
        kind: "truncated",
        reason: "oversized-chat",
      });
      expect(result.manifest.warnings).toContain("oversized-chat-skipped");
      expect(result.manifest.counts).toEqual({
        account: 2,
        participant: 2,
        conversation: 0,
        message: 0,
        reaction: 0,
        tombstone: 0,
      });
      expect(removed).toBeTrue();
      expect(existsSync(join(output, "manifest.json"))).toBeTrue();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
