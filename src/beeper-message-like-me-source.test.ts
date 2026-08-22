import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  assertUniqueOfficialAccountSelector,
  createBeeperMessageLikeMeSource,
  enforceBeeperRawWorkingBudget,
  runExportCli,
  type BeeperExportCliInvocation,
  type BeeperMessageLikeMeProgress,
} from "./beeper-message-like-me-source";
import {
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";
import { parseBeeperExportAccounts } from "./providers/beeper-local-runtime";

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
      auth: {
        accessToken: "fixture-stored-access-token",
        source: "manual",
        tokenType: "Bearer",
      },
      baseURL: "http://127.0.0.1:23380",
      id: "desktop",
      managed: false,
      name: "Desktop",
      runtime: { install: "desktop", port: 23_373 },
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

function fixtureSelectedAccount(invocation: BeeperExportCliInvocation): string | null {
  if (invocation.arguments[0] !== "export") return null;
  const configDirectory = invocation.environment.BEEPER_CLI_CONFIG_DIR;
  if (configDirectory === undefined) {
    throw new Error("fixture export omitted BEEPER_CLI_CONFIG_DIR");
  }
  const config = JSON.parse(
    readFileSync(join(configDirectory, "config.json"), "utf8"),
  ) as Record<string, unknown>;
  return typeof config.defaultAccount === "string" ? config.defaultAccount : null;
}

function fixtureCli(invocation: BeeperExportCliInvocation): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  for (const value of [
    ...invocation.arguments,
    ...Object.values(invocation.environment),
    ...(invocation.workingRoot === undefined ? [] : [invocation.workingRoot]),
  ]) {
    expect(value).not.toContain(ACCOUNT_ID);
    expect(value).not.toContain(NETWORK_ACCOUNT_ID);
  }
  expect(invocation.environment.BEEPER_READONLY).toBe("1");
  const configDirectory = invocation.environment.BEEPER_CLI_CONFIG_DIR;
  if (configDirectory === undefined) {
    throw new Error("fixture invocation omitted BEEPER_CLI_CONFIG_DIR");
  }
  const privateConfig = JSON.parse(
    readFileSync(join(configDirectory, "config.json"), "utf8"),
  ) as Record<string, unknown>;
  const privateTarget = JSON.parse(
    readFileSync(join(configDirectory, "targets", "desktop.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(Object.keys(privateTarget).sort()).toEqual([
    "auth",
    "baseURL",
    "id",
    "managed",
    "type",
  ]);
  expect(privateTarget).toMatchObject({
    baseURL: "http://127.0.0.1:23380",
    id: "desktop",
    managed: false,
    type: "desktop",
  });
  expect((privateTarget.auth as Record<string, unknown>).tokenType).toBe("Bearer");
  expect(typeof (privateTarget.auth as Record<string, unknown>).accessToken).toBe("string");
  expect(privateConfig.auth).toBeUndefined();

  if (
    invocation.arguments[0] === "accounts"
    && invocation.arguments[1] === "list"
  ) {
    expect(invocation.arguments).toContain("--json");
    expect(invocation.arguments.indexOf("--read-only")).toBeGreaterThan(0);
    return Promise.resolve({
      exitCode: 0,
      stdout: `${JSON.stringify({ success: true, data: accounts(), error: null })}\n`,
      stderr: "",
    });
  }

  expect(invocation.arguments[0]).toBe("export");
  expect(invocation.maxWorkingBytes).toBe(4 * 1024 * 1024 * 1024);
  expect(invocation.workingRoot).toBeDefined();
  expect(invocation.arguments).toContain("--no-attachments");
  expect(invocation.arguments).not.toContain("--json");
  expect(invocation.arguments).not.toContain("--account");
  expect(invocation.arguments).not.toContain("--events");
  expect(invocation.arguments.indexOf("--read-only")).toBeGreaterThan(0);
  const selectedAccount = fixtureSelectedAccount(invocation);
  if (selectedAccount === null) throw new Error("fixture export omitted defaultAccount");
  expect([ACCOUNT_ID, NETWORK_ACCOUNT_ID]).toContain(selectedAccount);
  const outputIndex = invocation.arguments.indexOf("--out");
  const outputRoot = invocation.arguments[outputIndex + 1];
  if (outputRoot === undefined) throw new Error("fixture export omitted --out");
  const chatsRoot = join(outputRoot, "chats");
  mkdirSync(chatsRoot, { recursive: true, mode: 0o755 });
  const accountValues = accounts();
  const includesChat = selectedAccount === NETWORK_ACCOUNT_ID;
  const chatValues = includesChat ? [chat()] : [];
  const messageValues = includesChat ? messages() : [];
  writeJson(join(outputRoot, "accounts.json"), accountValues);
  writeJson(join(outputRoot, "chats.json"), chatValues);
  const createdAt = includesChat
    ? "2026-08-21T13:59:00.000Z"
    : "2026-08-21T14:01:00.000Z";
  const completedAt = includesChat
    ? "2026-08-21T14:01:00.000Z"
    : "2026-08-21T14:01:30.000Z";
  if (includesChat) {
    const chatRoot = join(chatsRoot, CHAT_ID);
    mkdirSync(join(chatRoot, "attachments"), { recursive: true, mode: 0o755 });
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
  }
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
    stdout: includesChat
      ? "Exported 1 chats, 2 messages, 0 attachments\n"
      : "Exported 0 chats, 0 messages, 0 attachments\n",
    stderr: "",
  });
}

function invocationOutputRoot(invocation: BeeperExportCliInvocation): string {
  const outputIndex = invocation.arguments.indexOf("--out");
  const outputRoot = invocation.arguments[outputIndex + 1];
  if (outputRoot === undefined) throw new Error("fixture export omitted --out");
  return outputRoot;
}

function whatsAppOutputRoot(invocation: BeeperExportCliInvocation): string | null {
  return fixtureSelectedAccount(invocation) === NETWORK_ACCOUNT_ID
    ? invocationOutputRoot(invocation)
    : null;
}

function ndjson(path: string): readonly Record<string, unknown>[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const MESSAGE_LIKE_ME_DATA_FILES = [
  "accounts.ndjson",
  "participants.ndjson",
  "conversations.ndjson",
  "messages.ndjson",
  "reactions.ndjson",
  "tombstones.ndjson",
] as const;

function messageLikeMeDataDigests(root: string): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(MESSAGE_LIKE_ME_DATA_FILES.map((file) => [
    file,
    createHash("sha256").update(readFileSync(join(root, file))).digest("hex"),
  ])));
}

const SELF_ALIAS_ID = "whatsapp:private-late-self-alias";

function aliasChatOrderKey(chatId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([NETWORK_ACCOUNT_ID, chatId]))
    .digest("hex");
}

function orderedSelfAliasChatIds(): readonly [string, string] {
  const ordered = ["alias-chat-alpha", "alias-chat-omega"]
    .sort((left, right) => aliasChatOrderKey(left).localeCompare(aliasChatOrderKey(right)));
  const early = ordered[0];
  const late = ordered[1];
  if (early === undefined || late === undefined) {
    throw new Error("self-alias fixture chat order disappeared");
  }
  return [early, late];
}

function writeSelfAliasFixture(
  outputRoot: string,
  conflict: "incoming" | "participant" | null,
  extraLateSelfAliases = 0,
): void {
  const [earlyChatId, lateChatId] = orderedSelfAliasChatIds();
  const baseChat = chat();
  const peer = baseChat.participants.items[0]!;
  const selfAlias = {
    fullName: "Private Late Self Alias",
    id: SELF_ALIAS_ID,
    isSelf: true,
  };
  const earlyParticipants = conflict === "participant"
    ? [peer, { ...selfAlias, isSelf: false }]
    : [peer];
  const earlyChat = {
    ...baseChat,
    id: earlyChatId,
    lastActivity: "2026-08-21T14:00:01.000Z",
    participants: {
      hasMore: false,
      items: earlyParticipants,
      total: earlyParticipants.length,
    },
    title: "Early Alias Fixture",
  };
  const lateChat = {
    ...baseChat,
    id: lateChatId,
    lastActivity: "2026-08-21T14:00:02.000Z",
    participants: {
      hasMore: false,
      items: [
        peer,
        selfAlias,
        ...Array.from({ length: extraLateSelfAliases }, (_, index) => ({
          fullName: `Private Extra Self Alias ${String(index)}`,
          id: `whatsapp:private-extra-self-alias-${String(index)}`,
          isSelf: true,
        })),
      ],
      total: 2 + extraLateSelfAliases,
    },
    title: "Late Alias Evidence Fixture",
  };
  const baseMessage = messages()[0] as Record<string, unknown>;
  const earlyMessage = {
    ...baseMessage,
    attachments: [],
    chatID: earlyChatId,
    editedTimestamp: null,
    id: "message-alias-early",
    isSender: conflict !== "incoming",
    linkedMessageID: null,
    reactions: [{
      emoji: true,
      id: "reaction-alias-self",
      participantID: SELF_ALIAS_ID,
      reactionKey: "👍",
    }, {
      emoji: true,
      id: "reaction-alias-self",
      participantID: "whatsapp:self",
      reactionKey: "👍",
    }],
    senderID: conflict === "incoming" ? SELF_ALIAS_ID : "whatsapp:self",
    senderName: conflict === "incoming" ? "Private Late Self Alias" : "Fixture Self",
    sortKey: "00000000000000000001",
    text: "synthetic early alias body",
    timestamp: "2026-08-21T14:00:01.000Z",
  };
  const lateMessage = {
    ...baseMessage,
    attachments: [],
    chatID: lateChatId,
    editedTimestamp: null,
    id: "message-alias-late",
    linkedMessageID: null,
    reactions: [],
    senderID: SELF_ALIAS_ID,
    senderName: "Private Late Self Alias",
    sortKey: "00000000000000000002",
    text: "synthetic late alias body",
    timestamp: "2026-08-21T14:00:02.000Z",
  };
  const chatsRoot = join(outputRoot, "chats");
  rmSync(chatsRoot, { recursive: true, force: true });
  mkdirSync(chatsRoot, { mode: 0o755 });
  for (const [chatValue, messageValue] of [
    [earlyChat, earlyMessage],
    [lateChat, lateMessage],
  ] as const) {
    const chatRoot = join(chatsRoot, chatValue.id);
    mkdirSync(join(chatRoot, "attachments"), { recursive: true, mode: 0o755 });
    writeJson(join(chatRoot, "chat.json"), chatValue);
    writeJson(join(chatRoot, "messages.json"), [messageValue]);
    writeFileSync(join(chatRoot, "messages.markdown"), "private duplicate markdown\n");
    writeFileSync(join(chatRoot, "messages.html"), "<p>private duplicate html</p>\n");
  }
  writeJson(join(outputRoot, "chats.json"), [earlyChat, lateChat]);
  writeJson(join(outputRoot, ".beeper-export-state.json"), {
    chats: {
      [earlyChatId]: {
        attachmentCount: 0,
        complete: true,
        cursor: null,
        messageCount: 1,
        startedAt: "2026-08-21T13:59:00.000Z",
        updatedAt: "2026-08-21T14:00:01.000Z",
      },
      [lateChatId]: {
        attachmentCount: 0,
        complete: true,
        cursor: null,
        messageCount: 1,
        startedAt: "2026-08-21T14:00:01.000Z",
        updatedAt: "2026-08-21T14:00:02.000Z",
      },
    },
    completedChatIDs: [earlyChatId, lateChatId],
    createdAt: "2026-08-21T13:59:00.000Z",
    exportVersion: 1,
  });
  writeJson(join(outputRoot, "manifest.json"), {
    accounts: accounts(),
    attachmentCount: 0,
    chatCount: 2,
    completedAt: "2026-08-21T14:00:02.000Z",
    createdAt: "2026-08-21T13:59:00.000Z",
    messageCount: 2,
    version: 1,
  });
}

const SHARED_METADATA_PEER_ID = "whatsapp:shared-metadata-peer";
const EXCLUDED_METADATA_NAME = "Excluded Fixture Metadata";
const EXCLUDED_METADATA_HANDLE = "+15550000999";

function orderedParticipantMetadataChatIds(): readonly [string, string] {
  const ordered = ["metadata-chat-alpha", "metadata-chat-omega"]
    .sort((left, right) => aliasChatOrderKey(left).localeCompare(aliasChatOrderKey(right)));
  const selected = ordered[0];
  const excluded = ordered[1];
  if (selected === undefined || excluded === undefined) {
    throw new Error("participant metadata fixture chat order disappeared");
  }
  return [selected, excluded];
}

function writeParticipantMetadataFixture(
  outputRoot: string,
  includeExcluded: boolean,
): void {
  const [selectedChatId, excludedChatId] = orderedParticipantMetadataChatIds();
  const baseChat = chat();
  const selectedChat = {
    ...baseChat,
    id: selectedChatId,
    lastActivity: "2026-08-21T14:00:01.000Z",
    participants: {
      hasMore: false,
      items: [{ id: SHARED_METADATA_PEER_ID, isSelf: false }],
      total: 1,
    },
    title: "Selected Metadata Fixture",
  };
  const excludedChat = {
    ...baseChat,
    id: excludedChatId,
    lastActivity: "2026-08-21T14:00:02.000Z",
    participants: {
      hasMore: false,
      items: [{
        fullName: EXCLUDED_METADATA_NAME,
        id: SHARED_METADATA_PEER_ID,
        isSelf: false,
        phoneNumber: EXCLUDED_METADATA_HANDLE,
      }, {
        fullName: "Excluded Self Alias",
        id: SELF_ALIAS_ID,
        isSelf: true,
      }],
      total: 2,
    },
    title: "Excluded Metadata Fixture",
  };
  const baseMessage = messages()[0] as Record<string, unknown>;
  const selectedMessage = {
    ...baseMessage,
    attachments: [],
    chatID: selectedChatId,
    editedTimestamp: null,
    id: "message-metadata-selected",
    linkedMessageID: null,
    reactions: [{
      emoji: true,
      id: "reaction-metadata-selected",
      participantID: SELF_ALIAS_ID,
      reactionKey: "👍",
    }],
    sortKey: "00000000000000000001",
    text: "synthetic selected metadata body",
    timestamp: "2026-08-21T14:00:01.000Z",
  };
  const excludedMessage = {
    ...baseMessage,
    attachments: [],
    chatID: excludedChatId,
    editedTimestamp: null,
    id: "message-metadata-excluded",
    linkedMessageID: null,
    reactions: [{
      emoji: true,
      id: "reaction-metadata-excluded",
      participantID: SHARED_METADATA_PEER_ID,
      reactionKey: "👍",
    }],
    senderID: SELF_ALIAS_ID,
    senderName: "Excluded Self Alias",
    sortKey: "00000000000000000002",
    text: "synthetic excluded metadata body",
    timestamp: "2026-08-21T14:00:02.000Z",
  };
  const entries = includeExcluded
    ? [[selectedChat, selectedMessage], [excludedChat, excludedMessage]] as const
    : [[selectedChat, selectedMessage]] as const;
  const chatsRoot = join(outputRoot, "chats");
  rmSync(chatsRoot, { recursive: true, force: true });
  mkdirSync(chatsRoot, { mode: 0o755 });
  for (const [chatValue, messageValue] of entries) {
    const chatRoot = join(chatsRoot, chatValue.id);
    mkdirSync(join(chatRoot, "attachments"), { recursive: true, mode: 0o755 });
    writeJson(join(chatRoot, "chat.json"), chatValue);
    writeJson(join(chatRoot, "messages.json"), [messageValue]);
    writeFileSync(join(chatRoot, "messages.markdown"), "private duplicate markdown\n");
    writeFileSync(join(chatRoot, "messages.html"), "<p>private duplicate html</p>\n");
  }
  const chatValues = entries.map(([chatValue]) => chatValue);
  writeJson(join(outputRoot, "chats.json"), chatValues);
  const stateChats = Object.fromEntries(entries.map(([chatValue], index) => [
    chatValue.id,
    {
      attachmentCount: 0,
      complete: true,
      cursor: null,
      messageCount: 1,
      startedAt: index === 0
        ? "2026-08-21T13:59:00.000Z"
        : "2026-08-21T14:00:01.000Z",
      updatedAt: index === 0
        ? "2026-08-21T14:00:01.000Z"
        : "2026-08-21T14:00:02.000Z",
    },
  ]));
  writeJson(join(outputRoot, ".beeper-export-state.json"), {
    chats: stateChats,
    completedChatIDs: entries.map(([chatValue]) => chatValue.id),
    createdAt: "2026-08-21T13:59:00.000Z",
    exportVersion: 1,
  });
  writeJson(join(outputRoot, "manifest.json"), {
    accounts: accounts(),
    attachmentCount: 0,
    chatCount: entries.length,
    completedAt: "2026-08-21T14:00:03.000Z",
    createdAt: "2026-08-21T13:59:00.000Z",
    messageCount: entries.length,
    version: 1,
  });
}

describe("Beeper Message Like Me source", () => {
  test("settles a durable raw lease after a real immediately exiting child", async () => {
    const parent = privateDirectory("wrench-beeper-fast-child-test.");
    const working = join(parent, "working");
    mkdirSync(working, { mode: 0o700 });
    const environment = { WRENCH_STATE_HOME: join(parent, "state") };
    const nowMs = Date.now();
    const lease = await createBeeperMessageLikeMeDirectoryLease({
      role: "raw-working",
      path: working,
      recoverAfterMs: nowMs + 60_000,
      environment,
      nowMs,
    });
    try {
      const result = await runExportCli({
        binary: "/usr/bin/true",
        arguments: [],
        environment: { PATH: "/usr/bin:/bin" },
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
        maxStderrBytes: 1_024,
        directoryLease: lease,
      });

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(lease.claim.phase).toBe("settled");
      expect(lease.claim.childOwner).toBeNull();
    } finally {
      releaseBeeperMessageLikeMeDirectoryLease(lease);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("matches the exact pinned CLI account selector fields", () => {
    const selectedId = "account.selected-private";
    const rows = [{
      accountID: selectedId,
      bridge: { id: "selected", provider: "cloud", type: "signal" },
      network: "Signal",
      status: "CONNECTED",
      user: { fullName: "Selected Person", id: "selected:self", isSelf: true },
    }, {
      accountID: "account-other",
      bridge: { id: "other", provider: "cloud", type: "whatsapp" },
      network: "WhatsApp",
      status: "CONNECTED",
      user: { fullName: "Other Person", id: "other:self", isSelf: true },
    }] as const;
    for (const field of ["displayName", "name"] as const) {
      const colliding = rows.map((row, index) => index === 1
        ? { ...row, user: { ...row.user, [field]: " account selected_private " } }
        : row);
      const parsed = parseBeeperExportAccounts(colliding);
      const selected = parsed.find((account) => account.accountId === selectedId);
      expect(selected).toBeDefined();
      try {
        assertUniqueOfficialAccountSelector(selected!, parsed);
        throw new Error("selector collision was not rejected");
      } catch (error) {
        expect(String(error)).toContain("ambiguous under the pinned CLI selector rules");
        expect(String(error)).not.toContain(selectedId);
        expect(String(error)).not.toContain("account-other");
      }
    }
    const fullNameOnly = rows.map((row, index) => index === 1
      ? { ...row, user: { ...row.user, fullName: " account selected_private " } }
      : row);
    const parsed = parseBeeperExportAccounts(fullNameOnly);
    const selected = parsed.find((account) => account.accountId === selectedId);
    expect(selected).toBeDefined();
    expect(() => assertUniqueOfficialAccountSelector(selected!, parsed)).not.toThrow();
  });

  test("enforces the operation-wide raw staging byte and entry policy", async () => {
    const parent = privateDirectory("wrench-beeper-source-raw-budget-test.");
    try {
      writeFileSync(join(parent, "raw.json"), `${"x".repeat(64)}\n`, { mode: 0o600 });
      const measured = await enforceBeeperRawWorkingBudget(
        parent,
        1024 * 1024,
        0,
      );
      expect(measured.entries).toBe(1);
      expect(measured.bytes).toBeGreaterThanOrEqual(65);
      await expect(enforceBeeperRawWorkingBudget(parent, 32, 0))
        .rejects.toThrow("raw export staging exceeded its byte budget");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("accepts and charges the official relative CLI payload-cache link shape", async () => {
    const root = privateDirectory("wrench-beeper-source-cache-links-test.");
    const cacheRoot = join(root, "cli-payload-cache");
    const filesRoot = join(cacheRoot, "files");
    const linksRoot = join(cacheRoot, "links");
    const entries = [cacheRoot, filesRoot, linksRoot];
    const linkEntries: string[] = [];
    try {
      mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
      mkdirSync(linksRoot, { mode: 0o700 });
      for (let index = 0; index < 56; index += 1) {
        const segment = String(index).padStart(2, "0");
        const target = join(filesRoot, `payload-${segment}.bin`);
        const link = join(linksRoot, `payload-${segment}`);
        writeFileSync(target, `official-cache-payload-${segment}\n`, { mode: 0o600 });
        symlinkSync(`../files/payload-${segment}.bin`, link);
        entries.push(target, link);
        linkEntries.push(link);
      }

      const measured = await enforceBeeperRawWorkingBudget(
        root,
        1024 * 1024,
        0,
      );
      const expectedBytes = entries.reduce((total, path) => {
        const metadata = lstatSync(path);
        return total + Math.max(metadata.size, metadata.blocks * 512);
      }, 0);

      expect(measured.entries).toBe(entries.length);
      expect(measured.bytes).toBe(expectedBytes);
      const linkBytes = linkEntries.reduce((total, path) => {
        const metadata = lstatSync(path);
        return total + Math.max(metadata.size, metadata.blocks * 512);
      }, 0);
      const nonLinkBytes = entries
        .filter((path) => !linkEntries.includes(path))
        .reduce((total, path) => {
          const metadata = lstatSync(path);
          return total + Math.max(metadata.size, metadata.blocks * 512);
        }, 0);
      expect(measured.bytes - nonLinkBytes).toBe(linkBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects every unsafe CLI payload-cache symbolic-link shape", async () => {
    const cases: readonly {
      readonly name: string;
      readonly prepare: (fixture: Readonly<{
        cacheRoot: string;
        parent: string;
        working: string;
      }>) => void;
      readonly error: string;
    }[] = [{
      name: "outside-cache",
      prepare: ({ cacheRoot, working }) => {
        writeFileSync(join(cacheRoot, "payload.bin"), "payload\n", { mode: 0o600 });
        symlinkSync("cli-payload-cache/payload.bin", join(working, "outside-link"));
      },
      error: "symbolic link outside its CLI payload cache",
    }, {
      name: "absolute-target",
      prepare: ({ cacheRoot }) => {
        const target = join(cacheRoot, "zz-payload.bin");
        writeFileSync(target, "payload\n", { mode: 0o600 });
        symlinkSync(target, join(cacheRoot, "aa-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "escaping-target",
      prepare: ({ cacheRoot, parent }) => {
        writeFileSync(join(parent, "outside.bin"), "payload\n", { mode: 0o600 });
        symlinkSync("../../outside.bin", join(cacheRoot, "aa-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "dangling-target",
      prepare: ({ cacheRoot }) => {
        symlinkSync("missing.bin", join(cacheRoot, "aa-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "control-target",
      prepare: ({ cacheRoot }) => {
        symlinkSync("payload\n.bin", join(cacheRoot, "aa-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "control-name",
      prepare: ({ cacheRoot }) => {
        writeFileSync(join(cacheRoot, "zz-payload.bin"), "payload\n", { mode: 0o600 });
        symlinkSync("zz-payload.bin", join(cacheRoot, "aa-link\n"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "overlong-target",
      prepare: ({ cacheRoot }) => {
        symlinkSync("a".repeat(513), join(cacheRoot, "aa-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "chained-target",
      prepare: ({ cacheRoot }) => {
        writeFileSync(join(cacheRoot, "zz-payload.bin"), "payload\n", { mode: 0o600 });
        symlinkSync("zz-payload.bin", join(cacheRoot, "bb-inner-link"));
        symlinkSync("bb-inner-link", join(cacheRoot, "aa-outer-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "directory-target",
      prepare: ({ cacheRoot }) => {
        mkdirSync(join(cacheRoot, "zz-directory"), { mode: 0o700 });
        symlinkSync("zz-directory", join(cacheRoot, "aa-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "writable-target",
      prepare: ({ cacheRoot }) => {
        const target = join(cacheRoot, "zz-payload.bin");
        writeFileSync(target, "payload\n", { mode: 0o600 });
        chmodSync(target, 0o620);
        symlinkSync("zz-payload.bin", join(cacheRoot, "aa-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "multiply-linked-target",
      prepare: ({ cacheRoot, parent }) => {
        const target = join(cacheRoot, "zz-payload.bin");
        writeFileSync(target, "payload\n", { mode: 0o600 });
        linkSync(target, join(parent, "second-hard-link.bin"));
        symlinkSync("zz-payload.bin", join(cacheRoot, "aa-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }, {
      name: "symlink-directory-escape",
      prepare: ({ cacheRoot, parent }) => {
        const outside = join(parent, "outside-directory");
        mkdirSync(outside, { mode: 0o700 });
        writeFileSync(join(outside, "payload.bin"), "payload\n", { mode: 0o600 });
        symlinkSync("../../outside-directory", join(cacheRoot, "bb-alias"));
        symlinkSync("bb-alias/payload.bin", join(cacheRoot, "aa-outer-link"));
      },
      error: "unsafe CLI payload-cache symbolic link",
    }];

    for (const item of cases) {
      const parent = privateDirectory(
        `wrench-beeper-source-cache-link-${item.name}-test.`,
      );
      const working = join(parent, "working");
      const cacheRoot = join(working, "cli-payload-cache");
      mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
      try {
        item.prepare({ cacheRoot, parent, working });
        await expect(enforceBeeperRawWorkingBudget(
          working,
          1024 * 1024,
          0,
        )).rejects.toThrow(item.error);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });

  test("preserves a categorical initial raw-staging failure without paths", async () => {
    const parent = privateDirectory("wrench-beeper-source-preflight-error-test.");
    const working = join(parent, "working");
    const cacheRoot = join(working, "cli-payload-cache");
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheRoot, "payload.bin"), "private-payload\n", {
      mode: 0o600,
    });
    symlinkSync(
      "cli-payload-cache/payload.bin",
      join(working, "outside-link"),
    );
    try {
      const error = await runExportCli({
        binary: "/usr/bin/true",
        arguments: [],
        environment: { PATH: "/usr/bin:/bin" },
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
        maxStderrBytes: 1_024,
        workingRoot: working,
        maxWorkingBytes: 1024 * 1024,
      }).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "raw export staging contained a symbolic link outside its CLI payload cache",
      );
      expect((error as Error).message).not.toContain(parent);
      expect((error as Error).message).not.toContain("private-payload");
      expect((error as Error).message).not.toContain(
        "official export raw staging safety check failed",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("converts one private official export without media or duplicate renderings", async () => {
    const parent = privateDirectory("wrench-beeper-source-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    let removed = false;
    const invocations: BeeperExportCliInvocation[] = [];
    const progress: BeeperMessageLikeMeProgress[] = [];
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        onProgress: (item) => progress.push(item),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            expect(existsSync(join(
              working,
              "account-shards",
              "account-001",
              "manifest.json",
            ))).toBeTrue();
            expect(readdirSync(output).sort()).toEqual([
              "accounts.ndjson",
              "conversations.ndjson",
              "manifest.json",
              "messages.ndjson",
              "participants.ndjson",
              "reactions.ndjson",
              "tombstones.ndjson",
            ]);
            rmSync(path, { recursive: true, force: true });
            removed = true;
          },
          runCli: async (invocation) => {
            invocations.push(invocation);
            invocation.onHeartbeat?.(30);
            return fixtureCli(invocation);
          },
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
      expect(invocations.map((invocation) =>
        invocation.arguments.slice(0, 2).join(" "))).toEqual([
        "accounts list",
        "export --out",
        "export --out",
        "accounts list",
      ]);
      const exportInvocations = invocations.filter((invocation) =>
        invocation.arguments[0] === "export");
      expect(exportInvocations.map((invocation) => {
        const index = invocation.arguments.indexOf("--limit-chats");
        return invocation.arguments[index + 1];
      })).toEqual(["100000", "99999"]);
      expect(exportInvocations.map((invocation) => {
        const index = invocation.arguments.indexOf("--limit-messages");
        return invocation.arguments[index + 1];
      })).toEqual(["1000000", "1000000"]);
      expect(invocations.filter((invocation) =>
        invocation.arguments[0] === "export").map((invocation) =>
        invocation.environment.BEEPER_CLI_CONFIG_DIR)).toEqual([
        join(working, "account-selectors", "account-001"),
        join(working, "account-selectors", "account-002"),
      ]);
      expect(invocations.filter((invocation) =>
        invocation.arguments[0] === "accounts").map((invocation) =>
        invocation.environment.BEEPER_CLI_CONFIG_DIR)).toEqual([
        join(working, "account-selectors", "inventory"),
        join(working, "account-selectors", "inventory"),
      ]);
      expect(JSON.stringify(progress)).not.toContain(ACCOUNT_ID);
      expect(JSON.stringify(progress)).not.toContain(NETWORK_ACCOUNT_ID);
      expect(progress).toEqual([
        { phase: "preparing" },
        {
          phase: "accounts-progress",
          stage: "discovering",
          elapsedSeconds: 30,
        },
        { phase: "accounts-discovered", accounts: 2 },
        { phase: "account-started", account: 1, accounts: 2 },
        {
          phase: "account-progress",
          account: 1,
          accounts: 2,
          elapsedSeconds: 30,
        },
        {
          phase: "account-validating",
          account: 1,
          accounts: 2,
          elapsedSeconds: 0,
        },
        {
          phase: "account-completed",
          account: 1,
          accounts: 2,
          chats: 1,
          messages: 2,
        },
        { phase: "account-started", account: 2, accounts: 2 },
        {
          phase: "account-progress",
          account: 2,
          accounts: 2,
          elapsedSeconds: 30,
        },
        {
          phase: "account-validating",
          account: 2,
          accounts: 2,
          elapsedSeconds: 0,
        },
        {
          phase: "account-completed",
          account: 2,
          accounts: 2,
          chats: 1,
          messages: 2,
        },
        { phase: "accounts-verifying", accounts: 2 },
        {
          phase: "accounts-progress",
          stage: "verifying",
          elapsedSeconds: 30,
        },
        {
          phase: "conversion-started",
          accounts: 2,
          chats: 1,
          messages: 2,
        },
      ]);
      expect(result.manifest.completeness).toEqual({
        kind: "bounded-local",
        reason: "desktop-local-sequential-export",
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
      expect(result.manifest.source).toEqual({
        id: "beeper-local",
        version: "1.1.0",
      });
      expect(result.manifest.warnings).toEqual([
        "attachments-metadata-only",
        "connected-account-backfill-coverage-unknown",
        "remote-history-not-claimed",
        "sequential-account-snapshot",
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

  test("normalizes a late cross-chat self alias before exact record and byte budgets", async () => {
    const parents: string[] = [];
    const exportAliasFixture = async (maxBundleBytes?: number) => {
      const parent = privateDirectory("wrench-beeper-source-self-alias-test.");
      parents.push(parent);
      const working = join(parent, "working");
      const output = join(parent, "message-like-me");
      mkdirSync(working, { mode: 0o700 });
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          maxBundleRecords: 11,
          ...(maxBundleBytes === undefined ? {} : { maxBundleBytes }),
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeSelfAliasFixture(outputRoot, null);
            return result;
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      return { output, result };
    };

    try {
      const baseline = await exportAliasFixture();
      const exactRecordBytes = baseline.result.manifest.artifacts.reduce(
        (sum, artifact) => sum + artifact.bytes,
        0,
      );
      const byteBounded = await exportAliasFixture(exactRecordBytes);
      for (const { output, result } of [baseline, byteBounded]) {
        expect(result.manifest.completeness.kind).toBe("bounded-local");
        expect(result.manifest.counts).toEqual({
          account: 2,
          participant: 3,
          conversation: 2,
          message: 2,
          reaction: 2,
          tombstone: 0,
        });
        expect(Object.values(result.manifest.counts).reduce((sum, value) => sum + value, 0))
          .toBe(11);
        expect(result.manifest.warnings).not.toContain("bundle-record-limit-reached");
        expect(result.manifest.warnings).not.toContain("bundle-byte-limit-reached");
        expect(result.manifest.warnings).not.toContain("participant-roster-incomplete");
        expect(result.manifest.warnings).not.toContain("self-alias-evidence-limit-reached");
        expect(result.manifest.warnings).toContain("reaction-provider-id-non-unique");
        const accountRows = ndjson(join(output, "accounts.ndjson"));
        const accountRow = accountRows.find(({ network }) => network === "whatsapp-personal");
        expect(accountRow).toBeDefined();
        const selfParticipantId = accountRow!.selfParticipantId;
        const participantRows = ndjson(join(output, "participants.ndjson"));
        expect(participantRows.filter((row) =>
          row.accountId === accountRow!.id && row.isSelf === true)).toEqual([
          expect.objectContaining({ id: selfParticipantId }),
        ]);
        const conversationRows = ndjson(join(output, "conversations.ndjson"));
        expect(conversationRows).toHaveLength(2);
        for (const conversation of conversationRows) {
          expect(conversation.participantsComplete).toBeTrue();
          expect(conversation.participantIds).toContain(selfParticipantId);
          expect(conversation.participantIds).toHaveLength(2);
        }
        const messageRows = ndjson(join(output, "messages.ndjson"));
        expect(messageRows).toHaveLength(2);
        expect(messageRows.every((message) =>
          message.direction === "outgoing"
          && message.senderParticipantId === selfParticipantId)).toBeTrue();
        const reactionRows = ndjson(join(output, "reactions.ndjson"));
        expect(reactionRows).toHaveLength(2);
        expect(reactionRows.every((reaction) =>
          reaction.participantId === selfParticipantId)).toBeTrue();
        expect(new Set(reactionRows.map(({ id }) => id)).size).toBe(2);
        expect(new Set(reactionRows.map((reaction) =>
          (reaction.provenance as Record<string, unknown>).providerId)).size).toBe(2);
        expect(JSON.stringify({
          accountRows,
          conversationRows,
          messageRows,
          participantRows,
          reactionRows,
        })).not.toContain(SELF_ALIAS_ID);
      }
      expect(byteBounded.result.manifest.artifacts.reduce(
        (sum, artifact) => sum + artifact.bytes,
        0,
      )).toBe(exactRecordBytes);
    } finally {
      for (const parent of parents) rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects incoming and roster peer evidence for a later self alias", async () => {
    for (const conflict of ["incoming", "participant"] as const) {
      const parent = privateDirectory(
        `wrench-beeper-source-self-alias-${conflict}-conflict-test.`,
      );
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
            maxBundleRecords: 11,
            runCli: async (invocation) => {
              const result = await fixtureCli(invocation);
              const outputRoot = whatsAppOutputRoot(invocation);
              if (outputRoot !== null) writeSelfAliasFixture(outputRoot, conflict);
              return result;
            },
          },
        });
        await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
          .rejects.toThrow("official export has peer evidence for an account self alias");
        expect(removed).toBeTrue();
        expect(existsSync(working)).toBeFalse();
        expect(existsSync(output)).toBeFalse();
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });

  test("publishes a truthful prefix when bounded self-alias evidence is exhausted", async () => {
    const parent = privateDirectory("wrench-beeper-source-self-alias-limit-test.");
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
          maxBundleRecords: 11,
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeSelfAliasFixture(outputRoot, null, 12);
            return result;
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.completeness).toMatchObject({
        kind: "truncated",
        reason: "self-alias-evidence-limit",
      });
      expect(result.manifest.warnings).toContain("self-alias-evidence-limit-reached");
      expect(result.manifest.warnings).not.toContain("bundle-record-limit-reached");
      expect(result.manifest.counts.conversation).toBe(1);
      expect(existsSync(join(output, "manifest.json"))).toBeTrue();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects an account user that contradicts its explicit self anchor", async () => {
    const parent = privateDirectory("wrench-beeper-source-account-self-conflict-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    const conflictingAccounts = accounts().map((value) => {
      const account = value as Record<string, unknown>;
      if (account.accountID !== NETWORK_ACCOUNT_ID) return account;
      return {
        ...account,
        user: {
          ...(account.user as Record<string, unknown>),
          isSelf: false,
        },
      };
    });
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            if (invocation.arguments[0] === "accounts") {
              return {
                ...result,
                stdout: `${JSON.stringify({
                  success: true,
                  data: conflictingAccounts,
                  error: null,
                })}\n`,
              };
            }
            const outputRoot = invocationOutputRoot(invocation);
            writeJson(join(outputRoot, "accounts.json"), conflictingAccounts);
            const manifest = JSON.parse(
              readFileSync(join(outputRoot, "manifest.json"), "utf8"),
            ) as Record<string, unknown>;
            writeJson(join(outputRoot, "manifest.json"), {
              ...manifest,
              accounts: conflictingAccounts,
            });
            return result;
          },
        },
      });
      await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
        .rejects.toThrow("Beeper account user contradicts its self identity anchor");
      expect(existsSync(working)).toBeFalse();
      expect(existsSync(output)).toBeFalse();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("deduplicates exact official reactions before participant and bundle budgets", async () => {
    const parents: string[] = [];
    const exportDeduplicatedFixture = async (maxBundleBytes?: number) => {
      const parent = privateDirectory("wrench-beeper-source-reaction-dedup-test.");
      parents.push(parent);
      const working = join(parent, "working");
      const output = join(parent, "message-like-me");
      mkdirSync(working, { mode: 0o700 });
      const reaction = {
        emoji: true,
        id: "reaction-exact-duplicate",
        participantID: "whatsapp:reaction-only-participant",
        reactionKey: "🔥",
      };
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          maxBundleRecords: 11,
          ...(maxBundleBytes === undefined ? {} : { maxBundleBytes }),
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot === null) return result;
            const [first, ...remaining] = messages();
            writeJson(join(outputRoot, "chats", CHAT_ID, "messages.json"), [{
              ...(first as Record<string, unknown>),
              reactions: [{
                ...reaction,
                imgURL: "https://media.example.test/first-reaction-image",
              }, {
                ...reaction,
                emoji: false,
                imgURL: "file:///private/different-ignored-reaction-image",
              }],
            }, ...remaining]);
            return result;
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      return { output, result };
    };

    try {
      const baseline = await exportDeduplicatedFixture();
      const exactRecordBytes = baseline.result.manifest.artifacts.reduce(
        (sum, artifact) => sum + artifact.bytes,
        0,
      );
      const byteBounded = await exportDeduplicatedFixture(exactRecordBytes);

      for (const { output, result } of [baseline, byteBounded]) {
        expect(result.manifest.counts).toEqual({
          account: 2,
          participant: 4,
          conversation: 1,
          message: 2,
          reaction: 1,
          tombstone: 1,
        });
        expect(Object.values(result.manifest.counts).reduce((sum, value) => sum + value, 0))
          .toBe(11);
        expect(result.manifest.warnings).not.toContain("bundle-record-limit-reached");
        expect(result.manifest.warnings).not.toContain("bundle-byte-limit-reached");
        expect(result.manifest.warnings).not.toContain("reaction-provider-id-non-unique");
        const reactionRows = ndjson(join(output, "reactions.ndjson"));
        const participantRows = ndjson(join(output, "participants.ndjson"));
        expect(reactionRows).toHaveLength(1);
        expect(participantRows.filter(({ id }) => id === reactionRows[0]!.participantId))
          .toHaveLength(1);
        expect(reactionRows[0]!.provenance).toMatchObject({
          providerRevision: null,
        });
        expect(JSON.stringify(reactionRows)).not.toContain("reaction-exact-duplicate");
        expect(JSON.stringify(reactionRows)).not.toContain("different-ignored");
      }
      expect(byteBounded.result.manifest.artifacts.reduce(
        (sum, artifact) => sum + artifact.bytes,
        0,
      )).toBe(exactRecordBytes);
    } finally {
      for (const parent of parents) rmSync(parent, { recursive: true, force: true });
    }
  });

  test("preserves nonunique official reaction provider IDs with composite identities", async () => {
    const cases = [{
      name: "reaction-key",
      second: { reactionKey: "private-provider-reaction-beta" },
      participantCount: 3,
      reactionParticipantCount: 1,
      maxBundleRecords: 11,
    }, {
      name: "participant",
      second: { participantID: "whatsapp:self" },
      participantCount: 3,
      reactionParticipantCount: 2,
      maxBundleRecords: 11,
    }] as const;

    for (const item of cases) {
      const parent = privateDirectory(
        `wrench-beeper-source-reaction-nonunique-${item.name}-test.`,
      );
      const working = join(parent, "working");
      const output = join(parent, "message-like-me");
      mkdirSync(working, { mode: 0o700 });
      try {
        const reaction = {
          emoji: true,
          id: "whatsapp:ada/private-provider-reaction-id",
          participantID: "whatsapp:ada",
          reactionKey: "private-provider-reaction-alpha",
        };
        const source = createBeeperMessageLikeMeSource({
          auth: auth(configStore(parent)),
          dependencies: {
            binaryPath: "/fixture/beeper-0.6.2",
            createWorkingDirectory: async () => working,
            removeWorkingDirectory: async (path) => {
              rmSync(path, { recursive: true, force: true });
            },
            maxBundleRecords: item.maxBundleRecords,
            runCli: async (invocation) => {
              const result = await fixtureCli(invocation);
              const outputRoot = whatsAppOutputRoot(invocation);
              if (outputRoot === null) return result;
              const [first, ...remaining] = messages();
              writeJson(join(outputRoot, "chats", CHAT_ID, "messages.json"), [{
                ...(first as Record<string, unknown>),
                reactions: [reaction, { ...reaction, ...item.second }],
              }, ...remaining]);
              return result;
            },
          },
        });
        const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });

        expect(result.manifest.completeness.kind).toBe("bounded-local");
        expect(result.manifest.counts).toEqual({
          account: 2,
          participant: item.participantCount,
          conversation: 1,
          message: 2,
          reaction: 2,
          tombstone: 1,
        });
        expect(Object.values(result.manifest.counts).reduce((sum, value) => sum + value, 0))
          .toBe(item.maxBundleRecords);
        expect(result.manifest.warnings).toEqual([
          "attachments-metadata-only",
          "connected-account-backfill-coverage-unknown",
          "reaction-provider-id-non-unique",
          "remote-history-not-claimed",
          "sequential-account-snapshot",
        ]);
        const reactionRows = ndjson(join(output, "reactions.ndjson"));
        expect(reactionRows).toHaveLength(2);
        expect(new Set(reactionRows.map(({ id }) => id)).size).toBe(2);
        expect(new Set(reactionRows.map((row) =>
          (row.provenance as Record<string, unknown>).providerId)).size).toBe(2);
        expect(new Set(reactionRows.map(({ participantId }) => participantId)).size)
          .toBe(item.reactionParticipantCount);
        expect(reactionRows.map(({ body }) => body)).toEqual([
          "custom-reaction",
          "custom-reaction",
        ]);
        expect(reactionRows.every((row) =>
          (row.provenance as Record<string, unknown>).providerRevision === null))
          .toBeTrue();
        const publicProjection = JSON.stringify({
          manifest: result.manifest,
          reactionRows,
        });
        expect(publicProjection).not.toContain("private-provider-reaction-id");
        expect(publicProjection).not.toContain("private-provider-reaction-alpha");
        expect(publicProjection).not.toContain("private-provider-reaction-beta");
        expect(publicProjection).not.toContain("whatsapp:ada");
        expect(publicProjection).not.toContain("whatsapp:self");
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });

  test("marks explicit chat and message limits as truncation", async () => {
    const parent = privateDirectory("wrench-beeper-source-limit-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    const invocations: BeeperExportCliInvocation[] = [];
    const progress: BeeperMessageLikeMeProgress[] = [];
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        limits: { limitChats: 1, limitMessages: 2 },
        onProgress: (item) => progress.push(item),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          runCli: async (invocation) => {
            invocations.push(invocation);
            return fixtureCli(invocation);
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      const exportInvocations = invocations.filter((invocation) =>
        invocation.arguments[0] === "export");
      expect(exportInvocations).toHaveLength(1);
      const chatLimitIndex = exportInvocations[0]?.arguments.indexOf("--limit-chats") ?? -1;
      expect(exportInvocations[0]?.arguments[chatLimitIndex + 1]).toBe("1");
      expect(progress).toContainEqual({
        phase: "account-skipped",
        account: 2,
        accounts: 2,
        reason: "chat-limit-reached",
      });
      expect(progress.at(-1)).toEqual({
        phase: "conversion-started",
        accounts: 2,
        chats: 1,
        messages: 2,
      });
      expect(result.manifest.completeness.kind).toBe("truncated");
      expect(result.manifest.warnings).toContain("chat-limit-reached");
      expect(result.manifest.warnings).toContain("message-limit-reached");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("honors cancellation before validating a completed account shard", async () => {
    const parent = privateDirectory("wrench-beeper-source-validation-cancel-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    const controller = new AbortController();
    let removed = false;
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === "account-validating") controller.abort();
        },
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
            removed = true;
          },
          runCli: fixtureCli,
        },
      });
      await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
        .rejects.toThrow("export was cancelled");
      expect(removed).toBeTrue();
      expect(existsSync(working)).toBeFalse();
      expect(existsSync(output)).toBeFalse();
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
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot === null) return result;
            const extraPeer = {
              fullName: "Extra Fixture",
              id: "whatsapp:extra",
              isSelf: false,
              phoneNumber: "+15550000002",
            };
            const irregular = chat();
            irregular.participants.items.push(extraPeer);
            irregular.participants.total = 2;
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
          runCli: fixtureCli,
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
          runCli: fixtureCli,
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

  test("does not retain participant metadata from a record-rejected chat", async () => {
    const parent = privateDirectory("wrench-beeper-source-record-metadata-test.");
    const prefixWorking = join(parent, "prefix-working");
    const prefixOutput = join(parent, "prefix-bundle");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(prefixWorking, { mode: 0o700 });
    mkdirSync(working, { mode: 0o700 });
    try {
      const prefixSource = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => prefixWorking,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeParticipantMetadataFixture(outputRoot, false);
            return result;
          },
        },
      });
      await exportBeeperMessageLikeMeBundle({ outputRoot: prefixOutput, source: prefixSource });

      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          maxBundleRecords: 10,
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeParticipantMetadataFixture(outputRoot, true);
            return result;
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.warnings).toContain("bundle-record-limit-reached");
      expect(result.manifest.counts).toMatchObject({
        conversation: 1,
        message: 1,
        reaction: 1,
      });
      const peer = ndjson(join(output, "participants.ndjson"))
        .find((record) => record.isSelf === false);
      expect(peer).toMatchObject({ displayName: null, handle: null, isSelf: false });
      const participantBytes = readFileSync(join(output, "participants.ndjson"), "utf8");
      expect(participantBytes).not.toContain(EXCLUDED_METADATA_NAME);
      expect(participantBytes).not.toContain(EXCLUDED_METADATA_HANDLE);
      const selfParticipantIds = new Set(ndjson(join(output, "accounts.ndjson"))
        .map((record) => record.selfParticipantId));
      const reaction = ndjson(join(output, "reactions.ndjson"))[0];
      expect(reaction).toBeDefined();
      expect(selfParticipantIds.has(reaction!.participantId)).toBeFalse();
      expect(messageLikeMeDataDigests(output)).toEqual(
        messageLikeMeDataDigests(prefixOutput),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("does not charge or retain participant metadata from a byte-rejected chat", async () => {
    const parent = privateDirectory("wrench-beeper-source-byte-metadata-test.");
    const prefixWorking = join(parent, "prefix-working");
    const prefixOutput = join(parent, "prefix-bundle");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(prefixWorking, { mode: 0o700 });
    mkdirSync(working, { mode: 0o700 });
    try {
      const prefixSource = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => prefixWorking,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeParticipantMetadataFixture(outputRoot, false);
            return result;
          },
        },
      });
      await exportBeeperMessageLikeMeBundle({ outputRoot: prefixOutput, source: prefixSource });
      const selectedPrefixBytes = MESSAGE_LIKE_ME_DATA_FILES.reduce(
        (total, file) => total + lstatSync(join(prefixOutput, file)).size,
        0,
      );

      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          maxBundleBytes: selectedPrefixBytes,
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeParticipantMetadataFixture(outputRoot, true);
            return result;
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.warnings).toContain("bundle-byte-limit-reached");
      expect(result.manifest.counts).toMatchObject({
        conversation: 1,
        message: 1,
        reaction: 1,
      });
      const peer = ndjson(join(output, "participants.ndjson"))
        .find((record) => record.isSelf === false);
      expect(peer).toMatchObject({ displayName: null, handle: null, isSelf: false });
      const participantBytes = readFileSync(join(output, "participants.ndjson"), "utf8");
      expect(participantBytes).not.toContain(EXCLUDED_METADATA_NAME);
      expect(participantBytes).not.toContain(EXCLUDED_METADATA_HANDLE);
      const selfParticipantIds = new Set(ndjson(join(output, "accounts.ndjson"))
        .map((record) => record.selfParticipantId));
      const reaction = ndjson(join(output, "reactions.ndjson"))[0];
      expect(reaction).toBeDefined();
      expect(selfParticipantIds.has(reaction!.participantId)).toBeFalse();
      expect(messageLikeMeDataDigests(output)).toEqual(
        messageLikeMeDataDigests(prefixOutput),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects message size-class drift between alias refinement passes", async () => {
    const parent = privateDirectory("wrench-beeper-source-size-class-drift-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    let refinements = 0;
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
          maxBundleRecords: 10,
          maxMessagesJsonBytes: 4_096,
          onSelfAliasRefinementPass: async (pass) => {
            refinements += 1;
            expect(pass).toBe(1);
            const [selectedChatId] = orderedParticipantMetadataChatIds();
            const messagesPath = join(
              working,
              "account-shards",
              "account-001",
              "chats",
              selectedChatId,
              "messages.json",
            );
            const original = readFileSync(messagesPath, "utf8");
            expect(Buffer.byteLength(original)).toBeLessThan(4_096);
            writeFileSync(messagesPath, original.padEnd(4_097, " "));
          },
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeParticipantMetadataFixture(outputRoot, true);
            return result;
          },
        },
      });
      await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
        .rejects.toThrow("official export messages changed between self-alias passes");
      expect(refinements).toBe(1);
      expect(removed).toBeTrue();
      expect(existsSync(working)).toBeFalse();
      expect(existsSync(output)).toBeFalse();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("bounds repeated participant work before excluded alias evidence is admitted", async () => {
    const parent = privateDirectory("wrench-beeper-source-occurrence-limit-test.");
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
          maxParticipantOccurrences: 6,
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeParticipantMetadataFixture(outputRoot, true);
            return result;
          },
        },
      });
      const result = await exportBeeperMessageLikeMeBundle({ outputRoot: output, source });
      expect(result.manifest.completeness).toMatchObject({
        kind: "truncated",
        reason: "participant-occurrence-limit",
      });
      expect(result.manifest.warnings).toContain("participant-occurrence-limit-reached");
      expect(result.manifest.counts).toMatchObject({
        conversation: 1,
        message: 1,
        reaction: 1,
      });
      const selfParticipantIds = new Set(ndjson(join(output, "accounts.ndjson"))
        .map((record) => record.selfParticipantId));
      const reaction = ndjson(join(output, "reactions.ndjson"))[0];
      expect(reaction).toBeDefined();
      expect(selfParticipantIds.has(reaction!.participantId)).toBeFalse();
      const participantBytes = readFileSync(join(output, "participants.ndjson"), "utf8");
      expect(participantBytes).not.toContain(EXCLUDED_METADATA_NAME);
      expect(participantBytes).not.toContain(EXCLUDED_METADATA_HANDLE);
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
          runCli: fixtureCli,
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

  test("rejects connected account realm drift across the sequential snapshot", async () => {
    const parent = privateDirectory("wrench-beeper-source-realm-drift-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    let accountInventories = 0;
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
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            if (
              invocation.arguments[0] !== "accounts"
              || invocation.arguments[1] !== "list"
              || ++accountInventories !== 2
            ) return result;
            const changedAccounts = accounts().map((value, index) => {
              if (index !== 1) return value;
              const account = value as Record<string, unknown>;
              return {
                ...account,
                user: {
                  ...(account.user as Record<string, unknown>),
                  displayName: "Changed selector alias",
                },
              };
            });
            return {
              ...result,
              stdout: `${JSON.stringify({
                success: true,
                data: changedAccounts,
                error: null,
              })}\n`,
            };
          },
        },
      });
      await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
        .rejects.toThrow("connected Beeper account inventory changed during export");
      expect(accountInventories).toBe(2);
      expect(removed).toBeTrue();
      expect(existsSync(working)).toBeFalse();
      expect(existsSync(join(output, "manifest.json"))).toBeFalse();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects self-alias evidence drift between accounting and emission", async () => {
    const parent = privateDirectory("wrench-beeper-source-self-alias-drift-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    try {
      const baseSource = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          maxBundleRecords: 11,
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot !== null) writeSelfAliasFixture(outputRoot, null);
            return result;
          },
        },
      });
      let mutated = false;
      const source = {
        ...baseSource,
        records: (async function* () {
          for await (const record of baseSource.records) {
            yield record;
            if (!mutated) {
              const [, lateChatId] = orderedSelfAliasChatIds();
              const messagesPath = join(
                working,
                "account-shards",
                "account-001",
                "chats",
                lateChatId,
                "messages.json",
              );
              const original = readFileSync(messagesPath, "utf8");
              const changed = original.replace(
                SELF_ALIAS_ID,
                "whatsapp:private-late-peer-alias",
              );
              expect(changed.length).toBe(original.length);
              expect(changed).not.toBe(original);
              writeFileSync(messagesPath, changed);
              mutated = true;
            }
          }
        })(),
      };

      await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
        .rejects.toThrow("official export messages changed between validated passes");
      expect(mutated).toBeTrue();
      expect(existsSync(working)).toBeFalse();
      expect(existsSync(output)).toBeFalse();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects reaction tuple bytes changed between validation and emission", async () => {
    const parent = privateDirectory("wrench-beeper-source-message-drift-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    try {
      const baseSource = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            rmSync(path, { recursive: true, force: true });
          },
          runCli: fixtureCli,
        },
      });
      let mutated = false;
      const source = {
        ...baseSource,
        records: (async function* () {
          for await (const record of baseSource.records) {
            yield record;
            if (!mutated) {
              const messagesPath = join(
                working,
                "account-shards",
                "account-001",
                "chats",
                CHAT_ID,
                "messages.json",
              );
              const original = readFileSync(messagesPath, "utf8");
              const changed = original.replace("reaction-1", "reaction-x");
              expect(changed.length).toBe(original.length);
              expect(changed).not.toBe(original);
              writeFileSync(messagesPath, changed);
              mutated = true;
            }
          }
        })(),
      };

      await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
        .rejects.toThrow("messages changed between validated passes");
      expect(mutated).toBeTrue();
      expect(existsSync(working)).toBeFalse();
      expect(existsSync(output)).toBeFalse();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("retains raw working data for a retry when source disposal fails", async () => {
    const parent = privateDirectory("wrench-beeper-source-disposal-retry-test.");
    const working = join(parent, "working");
    const output = join(parent, "message-like-me");
    mkdirSync(working, { mode: 0o700 });
    let attempts = 0;
    try {
      const source = createBeeperMessageLikeMeSource({
        auth: auth(configStore(parent)),
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createWorkingDirectory: async () => working,
          removeWorkingDirectory: async (path) => {
            attempts += 1;
            if (attempts === 1) throw new Error("synthetic transient cleanup failure");
            rmSync(path, { recursive: true, force: true });
          },
          runCli: fixtureCli,
        },
      });

      await expect(exportBeeperMessageLikeMeBundle({ outputRoot: output, source }))
        .rejects.toThrow("synthetic transient cleanup failure");
      expect(existsSync(output)).toBeFalse();
      expect(existsSync(working)).toBeTrue();
      await source.dispose?.(false);
      expect(attempts).toBe(2);
      expect(existsSync(working)).toBeFalse();
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
          runCli: async (invocation) => {
            const result = await fixtureCli(invocation);
            const outputRoot = whatsAppOutputRoot(invocation);
            if (outputRoot === null) return result;
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
            runCli: async (invocation) => {
              const result = await fixtureCli(invocation);
              const outputRoot = whatsAppOutputRoot(invocation);
              if (outputRoot !== null) item.mutate(outputRoot);
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
          runCli: fixtureCli,
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
