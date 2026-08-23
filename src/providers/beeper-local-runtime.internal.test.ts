import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import { boundedJsonOutput } from "../runtime";
import {
  materializeBeeperMessagingList,
  materializeBeeperMessagingRead,
} from "./beeper-omni";
import {
  executeBeeperLocalOperation,
  parseBeeperExportAccounts,
  parseBeeperExportMessages,
  probeBeeperLocalSubject,
  validateBeeperCliStore,
  type BeeperCliInvocation,
  type BeeperCliInvocationResult,
} from "./beeper-local-runtime";
import {
  parseBeeperMessagingReadInput,
  planBeeperAccountsListCommand,
  planBeeperMessageLikeMeExportCommand,
  planBeeperReadCommand,
} from "./beeper-local";

const ACCOUNT_ID = "account-beeper";
const NETWORK_ACCOUNT_ID = "account-signal";
const SELF_ID = "@self:beeper.local";
const CHAT_ID = "chat-synthetic";
const SUBJECT = `beeper:local:${createHash("sha256")
  .update(ACCOUNT_ID, "utf8")
  .update("\0", "utf8")
  .update(SELF_ID, "utf8")
  .digest("hex")}`;

function envelope(data: unknown): BeeperCliInvocationResult {
  return Object.freeze({
    exitCode: 0,
    stdout: `${JSON.stringify({ success: true, data, error: null })}\n`,
    stderr: "",
  });
}

function accounts(): readonly unknown[] {
  return Object.freeze([{
    accountID: ACCOUNT_ID,
    bridge: { id: "beeper", provider: "cloud", type: "matrix" },
    loginID: "redacted-login",
    network: "Beeper",
    status: "CONNECTED",
    user: {
      displayName: "Official Display Alias",
      displayText: "Fixture Self",
      email: "self@example.test",
      fullName: "Fixture Self",
      id: SELF_ID,
      imgURL: "file:///private/avatar-self",
      isSelf: true,
      name: "Official Name Alias",
      phoneNumber: "+15550000000",
      username: "fixture-self",
    },
  }, {
    accountID: NETWORK_ACCOUNT_ID,
    bridge: { id: "signal", provider: "cloud", type: "signal" },
    loginID: "+15550000000",
    network: "Signal",
    status: "CONNECTED",
    user: {
      fullName: "Fixture Self",
      id: "signal:self",
      isSelf: true,
    },
  }]);
}

function contacts(): readonly unknown[] {
  return Object.freeze([{
    accountID: NETWORK_ACCOUNT_ID,
    fullName: "Ada Fixture",
    id: "signal:ada",
  }]);
}

function chats(): readonly unknown[] {
  return Object.freeze([{
    accountID: NETWORK_ACCOUNT_ID,
    id: CHAT_ID,
    lastActivity: "2026-08-21T14:00:00.000Z",
    network: "Signal",
    participants: {
      hasMore: false,
      items: [{
        displayText: "Ada Fixture",
        fullName: "Ada Fixture",
        id: "signal:ada",
        isSelf: false,
      }, {
        fullName: "Fixture Self",
        id: "signal:self",
        isSelf: true,
      }],
      total: 2,
    },
    title: "Ada Fixture",
    type: "single",
    unreadCount: 0,
  }]);
}

function messages(includeDirection = true): readonly unknown[] {
  const outgoing: Record<string, unknown> = {
    accountID: NETWORK_ACCOUNT_ID,
    attachments: [{
      fileName: "photo.jpg",
      fileSize: 42,
      id: "private-attachment-id",
      mimeType: "image/jpeg",
      posterImg: "https://media.example.test/poster-token",
      size: { height: 20, width: 10 },
      srcURL: "file:///private/beeper/media/photo.jpg",
      type: "img",
    }],
    chatID: CHAT_ID,
    editedTimestamp: "2026-08-21T14:00:02.000Z",
    id: "message-outgoing",
    linkedMessageID: "message-prior",
    mentions: [],
    reactions: [{
      emoji: true,
      id: "reaction-private-id",
      imgURL: "https://media.example.test/reaction-token",
      participantID: "signal:ada",
      reactionKey: "👍",
    }],
    seen: true,
    senderID: "signal:self",
    senderName: "Fixture Self",
    sortKey: "00000000000000000001",
    text: "one synthetic outgoing message",
    timestamp: "2026-08-21T14:00:01.000Z",
    type: "TEXT",
  };
  if (includeDirection) outgoing.isSender = true;
  return Object.freeze([outgoing, {
    accountID: NETWORK_ACCOUNT_ID,
    chatID: CHAT_ID,
    id: "message-deleted",
    isDeleted: true,
    isHidden: false,
    isSender: false,
    senderID: "signal:ada",
    senderName: "Ada Fixture",
    sortKey: "00000000000000000002",
    text: "must not survive deletion projection",
    timestamp: "2026-08-21T14:00:03.000Z",
    type: "TEXT",
  }]);
}

function privateStore(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wrench-beeper-store.")));
  // The official CLI uses an owned 0755 directory with private 0600 files.
  chmodSync(path, 0o755);
  mkdirSync(join(path, "targets"), { mode: 0o755 });
  writeFileSync(
    join(path, "config.json"),
    `${JSON.stringify({ defaultTarget: "desktop" })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(path, "targets", "desktop.json"),
    `${JSON.stringify({
      auth: {
        accessToken: "fixture-never-read-by-test-runner",
        source: "manual",
        tokenType: "Bearer",
      },
      baseURL: "http://127.0.0.1:23384",
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
    id: "beeper-fixture",
    kind: "linked-device-store",
    provider: "beeper",
    path,
    subject: SUBJECT,
  };
}

function recipe(action: string): WebSessionRecipe {
  return {
    site: "beeper",
    action,
    contractVersion: 1,
    timeoutMs: 60_000,
    maxOutputBytes: 32 * 1024 * 1024,
  };
}

function runner(
  calls: BeeperCliInvocation[],
  options: { readonly includeDirection?: boolean } = {},
): (invocation: BeeperCliInvocation) => Promise<BeeperCliInvocationResult> {
  return async (invocation) => {
    calls.push(invocation);
    const command = invocation.arguments.slice(0, 2).join(" ");
    if (invocation.arguments[0] === "version") {
      return envelope({ name: "@beeper/cli", version: "0.6.2" });
    }
    if (command === "accounts list") return envelope(accounts());
    if (command === "contacts list") return envelope(contacts());
    if (command === "chats list") return envelope(chats());
    if (command === "messages list") {
      return envelope(messages(options.includeDirection ?? true));
    }
    throw new Error(`unexpected fixture command ${command}`);
  };
}

async function execute(
  path: string,
  action: string,
  input: OperationInput,
  calls: BeeperCliInvocation[],
  options: { readonly includeDirection?: boolean } = {},
) {
  return executeBeeperLocalOperation(recipe(action), input, auth(path), {
    dependencies: {
      binaryPath: "/fixture/beeper-0.6.2",
      createCacheDirectory: async () => join(path, "ephemeral-cache"),
      removeCacheDirectory: async () => undefined,
      run: runner(calls, options),
    },
  });
}

describe("Beeper local read runtime", () => {
  test("preserves the pinned CLI account selector aliases independently", () => {
    const parsed = parseBeeperExportAccounts(accounts());
    expect(parsed[0]?.selectorAliases).toEqual({
      displayName: "Official Display Alias",
      name: "Official Name Alias",
    });
    expect(parsed[0]?.user).toMatchObject({
      fullName: "Fixture Self",
    });
    expect(Object.keys(parsed[0] ?? {})).not.toContain("selectorAliases");
  });

  test("plans only fixed read commands with command paths before Oclif global flags", () => {
    expect(planBeeperAccountsListCommand(1_500).argv).toEqual([
      "accounts",
      "list",
      "--read-only",
      "--json",
      "--full",
      "--quiet",
      "--target",
      "desktop",
      "--timeout",
      "2s",
    ]);
    const input = parseBeeperMessagingReadInput({
      account_id: NETWORK_ACCOUNT_ID,
      conversation_id: CHAT_ID,
      before_cursor: "message-cursor",
      limit: 2,
    });
    const command = planBeeperReadCommand("messaging.read", input, 60_000);
    expect(command.argv.slice(0, 2)).toEqual(["messages", "list"]);
    expect(command.argv.indexOf("--read-only")).toBeGreaterThan(1);
    expect(command.argv).toContain("--before-cursor");
    expect(command.argv.join(" ")).not.toMatch(/\b(?:api|export|send|download|watch)\b/u);
    expect(() => parseBeeperMessagingReadInput({
      account_id: NETWORK_ACCOUNT_ID,
      conversation_id: CHAT_ID,
      before_cursor: "before",
      after_cursor: "after",
    })).toThrow("only one cursor direction");
  });

  test("plans the official export without an account or diagnostic surface", () => {
    expect(planBeeperMessageLikeMeExportCommand({
      outputDirectory: "/private/export/account-1",
      limitChats: 12,
      limitMessages: 345,
      maxParticipants: 67,
    }, 61_001)).toEqual([
      "export",
      "--out",
      "/private/export/account-1",
      "--no-attachments",
      "--max-participants",
      "67",
      "--limit-chats",
      "12",
      "--limit-messages",
      "345",
      "--read-only",
      "--quiet",
      "--target",
      "desktop",
      "--timeout",
      "62s",
    ]);
    const hardBounded = planBeeperMessageLikeMeExportCommand({
      outputDirectory: "/private/export/account-2",
      limitChats: 100_000,
      limitMessages: 1_000_000,
      maxParticipants: 500,
    }, 3_600_001);
    expect(hardBounded).not.toContain("--account");
    expect(hardBounded).not.toContain("--events");
    expect(hardBounded).not.toContain("--json");
    expect(hardBounded).not.toContain("--full");
    expect(hardBounded).not.toContain("--debug");
    expect(hardBounded).not.toContain("--base-url");
    expect(hardBounded).toEqual([
      "export",
      "--out",
      "/private/export/account-2",
      "--no-attachments",
      "--max-participants",
      "500",
      "--limit-chats",
      "100000",
      "--limit-messages",
      "1000000",
      "--read-only",
      "--quiet",
      "--target",
      "desktop",
      "--timeout",
      "3601s",
    ]);
  });

  test("executes contacts, chats, and messages through strict synthetic JSON", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    try {
      const contactsResult = await execute(
        path,
        "contacts.list",
        { account_id: NETWORK_ACCOUNT_ID, limit: 2 },
        calls,
      );
      const listResult = await execute(
        path,
        "messaging.list",
        { account_id: NETWORK_ACCOUNT_ID, limit: 2 },
        calls,
      );
      const readResult = await execute(
        path,
        "messaging.read",
        { account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, limit: 2 },
        calls,
      );

      expect(contactsResult).toMatchObject({
        status: "succeeded",
        dispatchStarted: false,
        output: {
          accountSubject: SUBJECT,
          contacts: [{ accountId: NETWORK_ACCOUNT_ID, fullName: "Ada Fixture" }],
          operation: "contacts.list",
          provider: "beeper",
        },
      });
      expect(listResult).toMatchObject({
        status: "succeeded",
        output: {
          conversations: [{ accountId: NETWORK_ACCOUNT_ID, id: CHAT_ID }],
          operation: "messaging.list",
        },
      });
      expect(readResult).toMatchObject({
        status: "succeeded",
        output: {
          continuation: { cursor: "message-deleted", direction: "before" },
          messages: [{
            attachments: [{ fileName: "photo.jpg", mimeType: "image/jpeg" }],
            id: "message-outgoing",
            isSender: true,
            linkedMessageId: "message-prior",
          }, {
            id: "message-deleted",
            isDeleted: true,
            text: null,
          }],
          tombstones: [{ messageId: "message-deleted", state: "deleted" }],
        },
      });
      const serialized = JSON.stringify(readResult.output);
      expect(serialized).not.toContain("file:///private");
      expect(serialized).not.toContain("media.example.test");
      expect(serialized).not.toContain("private-attachment-id");

      const listPage = materializeBeeperMessagingList(
        { account_id: NETWORK_ACCOUNT_ID, limit: 2 },
        listResult.output,
      );
      expect(listPage).toMatchObject({
        completeness: { kind: "bounded-local" },
        cursor: { direction: "none", nextInput: null },
        entities: [{ kind: "conversation", title: "Ada Fixture" }],
      });
      const readPage = materializeBeeperMessagingRead(
        { account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, limit: 2 },
        readResult.output,
      );
      expect(readPage).toMatchObject({
        completeness: { kind: "bounded-local" },
        cursor: {
          direction: "backward",
          nextInput: { before_cursor: "message-deleted" },
        },
        entities: [{
          direction: "outgoing",
          replyToProviderId: expect.stringContaining("message:"),
          state: "active",
        }, {
          body: null,
          direction: "incoming",
          state: "revoked",
        }],
      });

      expect(calls).toHaveLength(9);
      for (const invocation of calls) {
        expect(invocation.environment.BEEPER_READONLY).toBe("1");
        expect(invocation.environment.BEEPER_DESKTOP_BASE_URL).toBeUndefined();
        expect(invocation.arguments.indexOf("--read-only")).toBeGreaterThan(0);
      }
      expect(calls.filter((call) => call.arguments[0] === "accounts")).toHaveLength(3);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("keeps selector aliases internal while public projections cross bounded JSON", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    try {
      const contactsResult = await execute(
        path,
        "contacts.list",
        { account_id: NETWORK_ACCOUNT_ID, limit: 2 },
        calls,
      );
      const listResult = await execute(
        path,
        "messaging.list",
        { account_id: NETWORK_ACCOUNT_ID, limit: 2 },
        calls,
      );
      const readResult = await execute(
        path,
        "messaging.read",
        { account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, limit: 2 },
        calls,
      );

      for (const result of [contactsResult, listResult, readResult]) {
        expect(boundedJsonOutput(result.output, 32 * 1024 * 1024))
          .toEqual(result.output);
      }
      for (const result of [contactsResult, listResult]) {
        const output = result.output as Readonly<{
          accounts: readonly Readonly<Record<string, unknown>>[];
        }>;
        expect(output.accounts).toHaveLength(2);
        for (const account of output.accounts) {
          expect(Reflect.ownKeys(account)).not.toContain("selectorAliases");
          expect(Object.values(Object.getOwnPropertyDescriptors(account)).every(
            (descriptor) => descriptor.enumerable && "value" in descriptor,
          )).toBeTrue();
        }
        expect(JSON.stringify(output)).not.toContain("Official Display Alias");
        expect(JSON.stringify(output)).not.toContain("Official Name Alias");
      }
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects message drift when style-critical isSender is absent", async () => {
    const path = privateStore();
    try {
      await expect(execute(
        path,
        "messaging.read",
        { account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, limit: 2 },
        [],
        { includeDirection: false },
      )).rejects.toThrow("isSender is required");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("aligns exported sort keys and attachment metadata with the bundle contract", () => {
    const first = messages()[0] as Record<string, unknown>;
    expect(() => parseBeeperExportMessages([{
      ...first,
      sortKey: "s".repeat(1_025),
    }], NETWORK_ACCOUNT_ID, CHAT_ID, 1)).toThrow("sortKey must be bounded text");
    expect(() => parseBeeperExportMessages([{
      ...first,
      attachments: [{
        type: "img",
        mimeType: "m".repeat(257),
      }],
    }], NETWORK_ACCOUNT_ID, CHAT_ID, 1)).toThrow("mimeType must be bounded text");
    expect(() => parseBeeperExportMessages([{
      ...first,
      attachments: Array.from({ length: 257 }, () => ({ type: "img" })),
    }], NETWORK_ACCOUNT_ID, CHAT_ID, 1)).toThrow("attachments must be an array of at most 256 items");
  });

  test("collapses retained reaction tuples regardless of dropped fields", () => {
    const first = messages()[0] as Record<string, unknown>;
    const original = (first.reactions as readonly Record<string, unknown>[])[0]!;
    const distinct = {
      emoji: false,
      id: "reaction-distinct",
      participantID: "signal:self",
      reactionKey: "custom-reaction",
    };
    const nullableEmoji = {
      id: "reaction-nullable-emoji",
      participantID: "signal:ada",
      reactionKey: "nullable-emoji-reaction",
    };
    const parsed = parseBeeperExportMessages([{
      ...first,
      reactions: [{
        ...original,
        imgURL: "https://media.example.test/first-token",
      }, distinct, {
        ...original,
        emoji: false,
        imgURL: "file:///private/different-ignored-reaction-image",
      }, nullableEmoji, {
        ...nullableEmoji,
        emoji: true,
      }],
    }], NETWORK_ACCOUNT_ID, CHAT_ID, 1);

    expect(parsed[0]!.reactions.map(({ id }) => id)).toEqual([
      "reaction-private-id",
      "reaction-distinct",
      "reaction-nullable-emoji",
    ]);
    expect(parsed[0]!.reactions[0]).toEqual({
      emoji: true,
      id: "reaction-private-id",
      participantId: "signal:ada",
      providerIdNonUnique: false,
      reactionKey: "👍",
    });
    expect(parsed[0]!.reactions[2]!.emoji).toBeNull();
    expect(parsed[0]!.reactions.every((reaction) => !reaction.providerIdNonUnique))
      .toBeTrue();
    expect(JSON.stringify(parsed[0]!.reactions)).not.toContain("first-token");
    expect(JSON.stringify(parsed[0]!.reactions)).not.toContain("different-ignored");
    expect(() => parseBeeperExportMessages([{
      ...first,
      reactions: [original, {
        ...original,
        imgURL: "x".repeat(16_385),
      }],
    }], NETWORK_ACCOUNT_ID, CHAT_ID, 1)).toThrow("imgURL must be bounded text");
  });

  test("retains and marks every tuple in a nonunique reaction provider-ID group", () => {
    const first = messages()[0] as Record<string, unknown>;
    const original = (first.reactions as readonly Record<string, unknown>[])[0]!;
    const parsed = parseBeeperExportMessages([{
      ...first,
      reactions: [original, {
        ...original,
        reactionKey: "second-private-reaction-key",
      }, {
        ...original,
        participantID: "signal:second-private-participant",
        reactionKey: "second-private-reaction-key",
      }, {
        ...original,
        emoji: false,
        imgURL: "file:///private/ignored-duplicate-image",
      }, {
        emoji: false,
        id: "reaction-unique-provider-id",
        participantID: "signal:ada",
        reactionKey: "unique-reaction-key",
      }],
    }], NETWORK_ACCOUNT_ID, CHAT_ID, 1);

    expect(parsed[0]!.reactions.map((reaction) => ({
      id: reaction.id,
      participantId: reaction.participantId,
      reactionKey: reaction.reactionKey,
      providerIdNonUnique: reaction.providerIdNonUnique,
    }))).toEqual([{
      id: "reaction-private-id",
      participantId: "signal:ada",
      reactionKey: "👍",
      providerIdNonUnique: true,
    }, {
      id: "reaction-private-id",
      participantId: "signal:ada",
      reactionKey: "second-private-reaction-key",
      providerIdNonUnique: true,
    }, {
      id: "reaction-private-id",
      participantId: "signal:second-private-participant",
      reactionKey: "second-private-reaction-key",
      providerIdNonUnique: true,
    }, {
      id: "reaction-unique-provider-id",
      participantId: "signal:ada",
      reactionKey: "unique-reaction-key",
      providerIdNonUnique: false,
    }]);
    expect(JSON.stringify(parsed[0]!.reactions)).not.toContain("ignored-duplicate-image");
  });

  test("keeps first-run CLI payload extraction inside the overall probe deadline", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    try {
      const subject = await probeBeeperLocalSubject(auth(path), {
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createCacheDirectory: async () => join(path, "fresh-payload-cache"),
          removeCacheDirectory: async () => undefined,
          run: async (invocation) => {
            calls.push(invocation);
            if (invocation.arguments[0] === "version") {
              expect(invocation.timeoutMs).toBeGreaterThan(5_000);
              await new Promise((resolve) => setTimeout(resolve, 10));
              return envelope({ name: "@beeper/cli", version: "0.6.2" });
            }
            if (invocation.arguments.slice(0, 2).join(" ") === "accounts list") {
              return envelope(accounts());
            }
            throw new Error("unexpected subject-probe fixture command");
          },
        },
      });
      expect(subject).toBe(SUBJECT);
      expect(calls.map((call) => call.arguments[0])).toEqual([
        "version",
        "accounts",
      ]);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("accepts the official 0755/0600 target shape and rejects target drift and symlinks", async () => {
    const path = privateStore();
    try {
      await expect(validateBeeperCliStore(path)).resolves.toBe(path);
      const targetPath = join(path, "targets", "desktop.json");
      const target = JSON.parse(readFileSync(targetPath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        targetPath,
        `${JSON.stringify({ ...target, auth: undefined })}\n`,
        { mode: 0o600 },
      );
      await expect(validateBeeperCliStore(path)).rejects.toThrow(
        "no effective stored access token",
      );
      writeFileSync(
        targetPath,
        `${JSON.stringify({ ...target, managed: true, port: 23_392 })}\n`,
        { mode: 0o600 },
      );
      await expect(validateBeeperCliStore(path)).rejects.toThrow(
        "active endpoint override",
      );
      writeFileSync(targetPath, `${JSON.stringify(target)}\n`, { mode: 0o600 });
      writeFileSync(
        join(path, "config.json"),
        `${JSON.stringify({ defaultTarget: "other" })}\n`,
        { mode: 0o600 },
      );
      chmodSync(join(path, "config.json"), 0o600);
      await expect(validateBeeperCliStore(path)).rejects.toThrow(
        "must select the fixed desktop target",
      );
      writeFileSync(
        join(path, "config.json"),
        `${JSON.stringify({ defaultTarget: "desktop" })}\n`,
        { mode: 0o600 },
      );
      chmodSync(join(path, "config.json"), 0o600);
      renameSync(join(path, "targets"), join(path, "targets.real"));
      symlinkSync("targets.real", join(path, "targets"));
      await expect(validateBeeperCliStore(path)).rejects.toThrow(
        "targets directory must be an owned physical",
      );
      unlinkSync(join(path, "targets"));
      renameSync(join(path, "targets.real"), join(path, "targets"));

      const realConfig = join(path, "config.real.json");
      writeFileSync(
        realConfig,
        `${JSON.stringify({ defaultTarget: "desktop" })}\n`,
        { mode: 0o600 },
      );
      unlinkSync(join(path, "config.json"));
      symlinkSync(realConfig, join(path, "config.json"));
      await expect(validateBeeperCliStore(path)).rejects.toThrow();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("does not disclose a rejected config-store path in diagnostics", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "wrench-beeper-private-path.")));
    const missing = join(parent, "sensitive-account-store-name");
    try {
      await expect(validateBeeperCliStore(missing)).rejects.toThrow(
        "Beeper CLI config directory could not be validated safely",
      );
      try {
        await validateBeeperCliStore(missing);
      } catch (error) {
        expect(String(error)).not.toContain(missing);
        expect(String(error)).not.toContain("sensitive-account-store-name");
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
