import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import { canonicalJson } from "../canonical-json";
import type { LocalCliRecipe, OperationInput } from "../model";
import { OperationDeadline } from "../operation-deadline";
import type { ProviderPluginReconciliationContextV1 } from "../provider-plugin";
import { beeperLinkedDevicePlugin } from "../plugins/beeper-linked-device/plugin";
import { boundedJsonOutput } from "../runtime";
import {
  materializeBeeperExactConversation,
  materializeBeeperMessagingList,
  materializeBeeperMessagingRead,
  materializeBeeperMessagingReadV1,
} from "./beeper-omni";
import {
  BEEPER_LOCAL_MUTATION_ERROR_CODES,
  executeBeeperLocalOperation,
  beeperSubjectFromAccountsAndTarget,
  beeperDesiredChatStateForTest,
  materializeBeeperPlanBoundFileForTest,
  parseBeeperExportAccounts,
  parseBeeperExportConversation,
  parseBeeperExportMessages,
  probeBeeperLocalSubject,
  reconcileBeeperLocalOperation,
  validateBeeperCliStore,
  type BeeperCliInvocation,
  type BeeperCliInvocationResult,
} from "./beeper-local-runtime";
import {
  BEEPER_CLI_V062_SURFACE_CONTRACT,
  BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS,
  BEEPER_LOCAL_OPERATION_NAMES,
  BEEPER_LOCAL_OPERATIONS,
  isBeeperLocalOperation,
  isBeeperLocalOperationContractVersion,
  parseBeeperContactsListInput,
  parseBeeperContactsSearchInput,
  parseBeeperOperationInput,
  parseBeeperMessagingSearchInput,
  parseBeeperMessagingReadInput,
  parseBeeperMessagingReadInputV2,
  planBeeperAccountsListCommand,
  planBeeperMessageLikeMeExportCommand,
  planBeeperReadCommand,
  planBeeperVersionCommand,
  type BeeperLocalOperationName,
} from "./beeper-local";

const ACCOUNT_ID = "account-beeper";
const NETWORK_ACCOUNT_ID = "account-signal";
const SELF_ID = "@self:beeper.local";
const CHAT_ID = "!chat-synthetic:beeper.local";
const BUNDLE_ID = "com.automattic.beeper.desktop" as const;

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
    status: "connected",
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
    status: "connected",
    user: {
      fullName: "Fixture Self",
      id: "signal:self",
      isSelf: true,
    },
  }]);
}

const SUBJECT = beeperSubjectFromAccountsAndTarget(
  parseBeeperExportAccounts(accounts()),
  "http://127.0.0.1:23384",
  BUNDLE_ID,
  "4.2.0-fixture",
);

function targetStatus(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return Object.freeze({
    target: Object.freeze({
      id: "desktop",
      type: "desktop",
      baseURL: "http://127.0.0.1:23384",
      auth: Object.freeze({ accessToken: "fixture-stored-access-token", tokenType: "Bearer" }),
      managed: false,
    }),
    reachable: true,
    version: "4.2.0-fixture",
    bundleID: BUNDLE_ID,
    actualType: "desktop",
    ...overrides,
  });
}

function directInfo(): unknown {
  return Object.freeze({
    app: Object.freeze({
      bundle_id: BUNDLE_ID,
      name: "Beeper",
      version: "4.2.0-fixture",
    }),
    endpoints: Object.freeze({}),
    platform: Object.freeze({}),
    server: Object.freeze({
      base_url: "http://127.0.0.1:23384",
      hostname: "127.0.0.1",
      mcp_enabled: true,
      port: 23_384,
      remote_access: false,
      status: "serving-fixture",
    }),
  });
}

function directJsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function bridges(): readonly unknown[] {
  return Object.freeze(["signal", "whatsapp"].map((id) => Object.freeze({
    id,
    accounts: Object.freeze([]),
    activeAccountCount: 0,
    displayName: `${id} fixture`,
    provider: "cloud",
    status: "available",
    supportsMultipleAccounts: true,
    type: id,
  })));
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
    sortKey: "00000000000000000002",
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
    sortKey: "00000000000000000001",
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
      runtime: { install: "desktop", port: 23_384 },
      type: "desktop",
    })}\n`,
    { mode: 0o600 },
  );
  return path;
}

function auth(path: string): Extract<WrenchAuth, { readonly kind: "linked-device-store" }> {
  return {
    schemaVersion: 1,
    id: "beeper-fixture",
    kind: "linked-device-store",
    provider: "beeper",
    path,
    subject: SUBJECT,
  };
}

function recipe(action: string, contractVersion?: number): LocalCliRecipe {
  if (!isBeeperLocalOperation(action)) throw new Error("fixture action is not installed");
  return {
    surface: "beeper",
    action,
    contractVersion: contractVersion
      ?? (action === "bridges.list" || action === "contacts.list" ? 2 : 1),
    timeoutMs: 60_000,
    maxOutputBytes: 10 * 1024 * 1024,
  };
}

function runner(
  calls: BeeperCliInvocation[],
  options: {
    readonly includeDirection?: boolean;
    readonly contactsData?: readonly unknown[];
    readonly chatsData?: readonly unknown[];
    readonly chatReadData?: unknown;
    readonly bridgesData?: readonly unknown[];
    readonly contactReadData?: unknown;
    readonly targetStatusData?: unknown;
    readonly messageReadData?: unknown;
    readonly messagesData?: readonly unknown[];
  } = {},
): (invocation: BeeperCliInvocation) => Promise<BeeperCliInvocationResult> {
  return async (invocation) => {
    calls.push(invocation);
    const command = invocation.arguments.slice(0, 2).join(" ");
    if (invocation.arguments[0] === "version") {
      return envelope({ name: "@beeper/cli", version: "0.6.2" });
    }
    if (command === "targets status") {
      return envelope(options.targetStatusData ?? targetStatus());
    }
    if (command === "accounts list") return envelope(accounts());
    if (command === "bridges list") return envelope(options.bridgesData ?? bridges());
    if (command === "contacts list" || command === "contacts search") {
      return envelope(options.contactsData ?? contacts());
    }
    if (command === "contacts show") {
      return envelope(options.contactReadData ?? {
        accountID: NETWORK_ACCOUNT_ID,
        contact: contacts()[0],
      });
    }
    if (command === "chats list") return envelope(options.chatsData ?? chats());
    if (command === "chats search") return envelope(options.chatsData ?? chats());
    if (command === "chats show") return envelope(options.chatReadData ?? chats()[0]);
    if (command === "messages list") {
      return envelope(options.messagesData ?? messages(options.includeDirection ?? true));
    }
    if (command === "messages show") {
      return envelope(options.messageReadData ?? messages()[0]);
    }
    throw new Error(`unexpected fixture command ${command}`);
  };
}

async function execute(
  path: string,
  action: string,
  input: OperationInput,
  calls: BeeperCliInvocation[],
  options: {
    readonly includeDirection?: boolean;
    readonly contactsData?: readonly unknown[];
    readonly chatsData?: readonly unknown[];
    readonly chatReadData?: unknown;
    readonly bridgesData?: readonly unknown[];
    readonly contactReadData?: unknown;
    readonly targetStatusData?: unknown;
    readonly messageReadData?: unknown;
    readonly messagesData?: readonly unknown[];
  } = {},
) {
  return executeBeeperLocalOperation(recipe(action), input, auth(path), {
    dependencies: {
      binaryPath: "/fixture/beeper-0.6.2",
      run: runner(calls, options),
    },
  });
}

const MATRIX_CONTACT_ID = "@ada:beeper.local";
const MATRIX_REMINDER_AT = "2026-09-01T12:00:00.000Z";

type MutationMatrixCase = Readonly<{
  action: BeeperLocalOperationName;
  input: OperationInput;
  reconciliation: "accepted-target" | "desired-state" | "none";
}>;

const BEEPER_WRITE_MUTATION_MATRIX = Object.freeze([
  Object.freeze({
    action: "messaging.send",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID,
      kind: "text", text: "matrix send text",
    }),
    reconciliation: "accepted-target",
  }),
  Object.freeze({
    action: "reactions.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID,
      message_id: "message-outgoing", reaction: "👍", enabled: true,
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "messaging.edit",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID,
      message_id: "message-outgoing", text: "matrix edited text",
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.start",
    input: Object.freeze({ account_id: NETWORK_ACCOUNT_ID, user_id: MATRIX_CONTACT_ID }),
    reconciliation: "accepted-target",
  }),
  ...[
    ["conversations.archive.set", "enabled", true],
    ["conversations.pin.set", "enabled", true],
    ["conversations.mute.set", "enabled", true],
  ].map(([action, field, value]) => Object.freeze({
    action: action as BeeperLocalOperationName,
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, [field as string]: value,
    }) as OperationInput,
    reconciliation: "desired-state" as const,
  })),
  Object.freeze({
    action: "conversations.read-state.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, unread: true,
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.priority.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, level: "low",
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.notify",
    input: Object.freeze({ account_id: ACCOUNT_ID, conversation_id: CHAT_ID }),
    reconciliation: "none",
  }),
  Object.freeze({
    action: "conversations.title.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, title: "Matrix title",
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.description.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID,
      clear: false, description: "Matrix description",
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.avatar.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, clear: true,
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.draft.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID,
      clear: false, text: "Matrix draft",
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.disappearing.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, seconds: 3_600,
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.reminder.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID,
      clear: false, when: MATRIX_REMINDER_AT, dismiss_on_message: false,
    }),
    reconciliation: "desired-state",
  }),
  Object.freeze({
    action: "conversations.focus",
    input: Object.freeze({ account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID }),
    reconciliation: "none",
  }),
  Object.freeze({
    action: "presence.set",
    input: Object.freeze({
      account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, state: "typing",
    }),
    reconciliation: "none",
  }),
] as const satisfies readonly MutationMatrixCase[]);

const BEEPER_SUPPORTED_WRITE_COMMAND_SEMANTICS = Object.freeze([
  ["chats start", "conversations.start", {}],
  ["chats archive", "conversations.archive.set", { enabled: true }],
  ["chats unarchive", "conversations.archive.set", { enabled: false }],
  ["chats pin", "conversations.pin.set", { enabled: true }],
  ["chats unpin", "conversations.pin.set", { enabled: false }],
  ["chats mute", "conversations.mute.set", { enabled: true }],
  ["chats unmute", "conversations.mute.set", { enabled: false }],
  ["chats mark-read", "conversations.read-state.set", { unread: false }],
  ["chats mark-unread", "conversations.read-state.set", { unread: true }],
  ["chats priority", "conversations.priority.set", {}],
  ["chats notify-anyway", "conversations.notify", {}],
  ["chats rename", "conversations.title.set", {}],
  ["chats description", "conversations.description.set", {}],
  ["chats avatar", "conversations.avatar.set", {}],
  ["chats draft", "conversations.draft.set", {}],
  ["chats disappear", "conversations.disappearing.set", {}],
  ["chats remind", "conversations.reminder.set", { clear: false }],
  ["chats unremind", "conversations.reminder.set", { clear: true }],
  ["chats focus", "conversations.focus", {}],
  ["messages edit", "messaging.edit", {}],
  ["send text", "messaging.send", { kind: "text" }],
  ["send file", "messaging.send", { kind: "file" }],
  ["send react", "reactions.set", { enabled: true }],
  ["send sticker", "messaging.send", { kind: "sticker" }],
  ["send unreact", "reactions.set", { enabled: false }],
  ["send voice", "messaging.send", { kind: "voice" }],
  ["presence", "presence.set", {}],
] as const);

function mutationAccounts(): readonly unknown[] {
  return Object.freeze(accounts().map((account, index) => index === 0
    ? Object.freeze({
        ...(account as Record<string, unknown>),
        bridge: Object.freeze({ id: "imessage", provider: "local", type: "imessage" }),
      })
    : account));
}

const MATRIX_SUBJECT = beeperSubjectFromAccountsAndTarget(
  parseBeeperExportAccounts(mutationAccounts()),
  "http://127.0.0.1:23384",
  BUNDLE_ID,
  "4.2.0-fixture",
);

function mutationAuth(path: string): Extract<WrenchAuth, { readonly kind: "linked-device-store" }> {
  return { ...auth(path), subject: MATRIX_SUBJECT };
}

function mutationCaseAccount(testCase: MutationMatrixCase): string {
  return testCase.action === "conversations.notify" ? ACCOUNT_ID : NETWORK_ACCOUNT_ID;
}

function matrixChat(
  testCase: MutationMatrixCase,
  desired: boolean,
): Readonly<Record<string, unknown>> {
  const accountId = mutationCaseAccount(testCase);
  const input = testCase.input as Readonly<Record<string, unknown>>;
  const base: Record<string, unknown> = {
    ...(chats()[0] as Record<string, unknown>),
    accountID: accountId,
    network: accountId === ACCOUNT_ID ? "iMessage" : "Signal",
    type: "group",
    title: "Matrix original title",
    description: "Matrix original description",
    imgURL: "mxc://fixture/original-avatar",
    draft: null,
    isArchived: false,
    isLowPriority: false,
    isMarkedUnread: false,
    isMuted: false,
    isPinned: false,
    messageExpirySeconds: 0,
    reminder: null,
    unreadCount: 0,
  };
  if (!desired) return Object.freeze(base);
  if (testCase.action === "conversations.archive.set") base.isArchived = input.enabled;
  if (testCase.action === "conversations.pin.set") base.isPinned = input.enabled;
  if (testCase.action === "conversations.mute.set") base.isMuted = input.enabled;
  if (testCase.action === "conversations.read-state.set") {
    base.isMarkedUnread = input.unread;
    base.unreadCount = input.unread === true ? 1 : 0;
  }
  if (testCase.action === "conversations.priority.set") {
    base.isLowPriority = input.level === "low";
  }
  if (testCase.action === "conversations.title.set") base.title = input.title;
  if (testCase.action === "conversations.description.set") {
    base.description = input.clear === true ? null : input.description;
  }
  if (testCase.action === "conversations.avatar.set") {
    base.imgURL = input.clear === true ? null : "mxc://fixture/new-avatar";
  }
  if (testCase.action === "conversations.draft.set") {
    base.draft = input.clear === true
      ? null
      : Object.freeze({ text: input.text, attachments: Object.freeze({}) });
  }
  if (testCase.action === "conversations.disappearing.set") {
    base.messageExpirySeconds = input.seconds;
  }
  if (testCase.action === "conversations.reminder.set") {
    base.reminder = input.clear === true
      ? null
      : Object.freeze({
          remindAt: input.when,
          dismissOnIncomingMessage: input.dismiss_on_message ?? false,
        });
  }
  return Object.freeze(base);
}

function matrixMessage(
  testCase: MutationMatrixCase,
  desired: boolean,
): Readonly<Record<string, unknown>> {
  const input = testCase.input as Readonly<Record<string, unknown>>;
  const base = { ...(messages()[0] as Record<string, unknown>) };
  if (testCase.action === "messaging.edit" && desired) base.text = input.text;
  if (testCase.action === "reactions.set" && desired) {
    base.reactions = [{
      emoji: true,
      id: "matrix-self-reaction",
      participantID: "signal:self",
      reactionKey: input.reaction,
    }];
  }
  if (testCase.action === "messaging.send" && desired) {
    base.id = "matrix-final-message";
    base.text = input.text;
    base.isSender = true;
  }
  return Object.freeze(base);
}

function matrixMutationSuccess(
  testCase: MutationMatrixCase,
): unknown {
  const input = testCase.input as Readonly<Record<string, unknown>>;
  if (testCase.action === "messaging.send") return Object.freeze({
    accepted: true,
    state: "accepted",
    chatID: CHAT_ID,
    pendingMessageID: "matrix-pending-message",
    hint: "Desktop accepted the send request. Pass --wait to wait for the final message or failure.",
  });
  if (testCase.action === "reactions.set") return Object.freeze({
    chatID: CHAT_ID,
    messageID: input.message_id,
    reactionKey: input.reaction,
    success: true,
    transactionID: "matrix-reaction-transaction",
  });
  if (testCase.action === "messaging.edit") return Object.freeze({
    ...matrixMessage(testCase, true),
    messageID: input.message_id,
    success: true,
  });
  if (testCase.action === "conversations.start") return Object.freeze({
    ...matrixChat(testCase, true),
    participants: Object.freeze({
      hasMore: false,
      items: Object.freeze([{
        fullName: "Ada Fixture", id: MATRIX_CONTACT_ID, isSelf: false,
      }, {
        fullName: "Fixture Self", id: "signal:self", isSelf: true,
      }]),
      total: 2,
    }),
    chatID: CHAT_ID,
    status: "created",
  });
  if (testCase.action === "conversations.reminder.set") return Object.freeze({
    message: input.clear === true ? "Reminder cleared" : "Reminder set",
    chatID: CHAT_ID,
    ...(input.clear === true ? {} : { detail: input.when, remindAt: input.when }),
  });
  if (testCase.action === "conversations.focus") return Object.freeze({ success: true });
  if (testCase.action === "presence.set") return Object.freeze({
    message: `Sent ${String(input.state)} indicator`,
    chatID: CHAT_ID,
    state: input.state,
  });
  return matrixChat(testCase, true);
}

function matrixRunner(
  testCase: MutationMatrixCase,
  mode: "success" | "readback",
  counters: { mutationInvocations: number; spawned: number; commands?: string[] },
): (invocation: BeeperCliInvocation) => Promise<BeeperCliInvocationResult> {
  let desired = mode === "readback";
  return async (invocation) => {
    const command = invocation.arguments.slice(0, 2).join(" ");
    counters.commands?.push(command);
    if (mode === "readback") {
      expect(invocation.environment.BEEPER_READONLY, `${testCase.action} reconciliation ${command}`)
        .toBe("1");
    }
    if (invocation.arguments[0] === "version") {
      return envelope({ name: "@beeper/cli", version: "0.6.2" });
    }
    if (command === "targets status") return envelope(targetStatus());
    if (command === "accounts list") return envelope(mutationAccounts());
    if (command === "contacts show") return envelope({
      accountID: NETWORK_ACCOUNT_ID,
      contact: Object.freeze({
        cannotMessage: false,
        fullName: "Ada Fixture",
        id: MATRIX_CONTACT_ID,
      }),
    });
    if (command === "chats show") return envelope(matrixChat(testCase, desired));
    if (command === "messages show") return envelope(matrixMessage(testCase, desired));
    if (invocation.environment.BEEPER_READONLY !== "1") {
      expect(invocation.arguments, `${testCase.action} mutation argv`).toContain("--yes");
      expect(Object.hasOwn(invocation.environment, "BEEPER_READONLY"), testCase.action).toBeFalse();
      counters.mutationInvocations += 1;
      await invocation.beforeSpawn?.();
      counters.spawned += 1;
      desired = true;
      return envelope(matrixMutationSuccess(testCase));
    }
    throw new Error(`unexpected matrix fixture command ${command}`);
  };
}

describe("Beeper exact write runtime matrix", () => {
  test("binds every supported write command path to its exact semantic inputs", () => {
    const actual = Object.freeze(BEEPER_CLI_V062_SURFACE_CONTRACT.commands
      .filter((command) =>
        command.decision.disposition === "supported"
        && command.reviewedEffect === "write")
      .map((command) => Object.freeze([
        command.path.join(" "),
        command.decision.operation,
        command.pathSemanticInputs,
      ])));
    expect(actual).toEqual(BEEPER_SUPPORTED_WRITE_COMMAND_SEMANTICS);
    expect(actual).toHaveLength(27);
  });

  test("proves failure, success, uncertainty, reconciliation, and no retry for all 18 writes", async () => {
    const declaredWrites = BEEPER_LOCAL_OPERATION_NAMES.filter((action) =>
      BEEPER_LOCAL_OPERATIONS[action].effect === "write");
    const matrixActions = BEEPER_WRITE_MUTATION_MATRIX.map((testCase) => testCase.action);
    expect(declaredWrites).toHaveLength(18);
    expect(new Set(matrixActions)).toHaveLength(18);
    expect(new Set(matrixActions)).toEqual(new Set(declaredWrites));

    for (const testCase of BEEPER_WRITE_MUTATION_MATRIX) {
      const path = privateStore();
      try {
        const preDispatch = { mutationInvocations: 0, spawned: 0, commands: [] as string[] };
        let failed: Awaited<ReturnType<typeof executeBeeperLocalOperation>>;
        try {
          failed = await executeBeeperLocalOperation(
            recipe(testCase.action),
            testCase.input,
            mutationAuth(path),
            {
              beforeDispatch: async () => {
                throw new Error("matrix durable fence rejected before spawn");
              },
              dependencies: {
                binaryPath: "/fixture/beeper-0.6.2",
                run: matrixRunner(testCase, "success", preDispatch),
              },
            },
          );
        } catch {
          throw new Error(`${testCase.action} escaped before the matrix dispatch boundary after ${preDispatch.commands.join(",")}`);
        }
        expect(failed.status, testCase.action).toBe("failed");
        expect(failed.error, testCase.action).toBe(
          BEEPER_LOCAL_MUTATION_ERROR_CODES.preDispatchFailed,
        );
        expect(failed.dispatch, testCase.action).toEqual({ planned: 1, started: 0, verified: 0 });
        expect({ mutationInvocations: preDispatch.mutationInvocations, spawned: preDispatch.spawned }, testCase.action)
          .toEqual({ mutationInvocations: 1, spawned: 0 });

        const acceptedEvents: Array<Readonly<{
          id: string;
          index: number;
          target: Readonly<{ schemaVersion: 1; identifier: string }>;
        }>> = [];
        const successCounters = { mutationInvocations: 0, spawned: 0 };
        let verifiedEvents = 0;
        const succeeded = await executeBeeperLocalOperation(
          recipe(testCase.action),
          testCase.input,
          mutationAuth(path),
          {
            afterProviderAcceptedMutationTarget: async (event) => {
              acceptedEvents.push(event);
            },
            afterDispatchVerified: async () => {
              verifiedEvents += 1;
            },
            dependencies: {
              binaryPath: "/fixture/beeper-0.6.2",
              run: matrixRunner(testCase, "success", successCounters),
            },
          },
        );
        expect(succeeded.status, testCase.action).toBe("succeeded");
        expect(succeeded.dispatch, testCase.action).toEqual({ planned: 1, started: 1, verified: 1 });
        expect(succeeded.noOp, testCase.action).not.toBeTrue();
        expect(successCounters, testCase.action).toEqual({ mutationInvocations: 1, spawned: 1 });
        expect(verifiedEvents, testCase.action).toBe(1);
        expect(acceptedEvents, testCase.action).toHaveLength(
          testCase.reconciliation === "accepted-target" ? 1 : 0,
        );

        const uncertainAcceptedEvents = [...acceptedEvents.slice(0, 0)];
        const uncertainCounters = { mutationInvocations: 0, spawned: 0 };
        let uncertaintyHookCalls = 0;
        const uncertain = await executeBeeperLocalOperation(
          recipe(testCase.action),
          testCase.input,
          mutationAuth(path),
          {
            afterProviderAcceptedMutationTarget: async (event) => {
              uncertainAcceptedEvents.push(event);
            },
            afterDispatchVerified: async () => {
              uncertaintyHookCalls += 1;
              throw new Error("matrix durable verification write failed after provider success");
            },
            dependencies: {
              binaryPath: "/fixture/beeper-0.6.2",
              run: matrixRunner(testCase, "success", uncertainCounters),
            },
          },
        );
        expect(uncertain.status, testCase.action).toBe("indeterminate");
        expect(uncertain.error, testCase.action).toBe(
          BEEPER_LOCAL_MUTATION_ERROR_CODES.postDispatchUncertain,
        );
        expect(uncertain.dispatch, testCase.action).toEqual({ planned: 1, started: 1, verified: 0 });
        expect(uncertainCounters, testCase.action).toEqual({ mutationInvocations: 1, spawned: 1 });
        expect(uncertaintyHookCalls, testCase.action).toBe(1);

        const reconciliationCounters = { mutationInvocations: 0, spawned: 0 };
        const accepted = uncertainAcceptedEvents[0];
        const context: ProviderPluginReconciliationContextV1 | undefined = accepted === undefined
          ? undefined
          : Object.freeze({
              schemaVersion: 1,
              kind: "provider-accepted-target-presence",
              dispatch: Object.freeze({ id: accepted.id, index: accepted.index, planned: 1 }),
              target: accepted.target,
            });
        const reconcile = () => reconcileBeeperLocalOperation(
          testCase.action,
          testCase.input,
          mutationAuth(path),
          context,
          {
            dependencies: {
              binaryPath: "/fixture/beeper-0.6.2",
              run: matrixRunner(testCase, "readback", reconciliationCounters),
            },
          },
        );
        if (testCase.reconciliation === "none") {
          const descriptor = beeperLinkedDevicePlugin.bindings[0]?.operations.find((operation) =>
            operation.name === testCase.action);
          expect(descriptor?.reconciliation, testCase.action).toBeUndefined();
          await expect(reconcile(), testCase.action).rejects.toThrow(
            "could not obtain definitive protected evidence",
          );
        } else {
          expect((await reconcile()).actualState, testCase.action).toBeTrue();
        }
        expect(reconciliationCounters, testCase.action)
          .toEqual({ mutationInvocations: 0, spawned: 0 });
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  test("rejects the three input-dependent irreconcilable variants without dispatch", async () => {
    const variants = Object.freeze([
      Object.freeze({
        action: "conversations.avatar.set" as const,
        input: Object.freeze({
          account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, clear: false,
          avatar: Object.freeze({ kind: "file" as const, reference: "unsafe-avatar" }),
        }),
      }),
      Object.freeze({
        action: "conversations.draft.set" as const,
        input: Object.freeze({
          account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID,
          clear: false, text: "unsafe attachment draft",
          attachment: Object.freeze({ kind: "file" as const, reference: "unsafe-draft" }),
        }),
      }),
      Object.freeze({
        action: "conversations.read-state.set" as const,
        input: Object.freeze({
          account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID,
          unread: false, message_id: "message-outgoing",
        }),
      }),
    ]);
    for (const variant of variants) {
      const path = privateStore();
      try {
        const testCase = BEEPER_WRITE_MUTATION_MATRIX.find((item) =>
          item.action === variant.action)!;
        const counters = { mutationInvocations: 0, spawned: 0, commands: [] as string[] };
        await expect(reconcileBeeperLocalOperation(
          variant.action,
          variant.input,
          mutationAuth(path),
          undefined,
          {
            dependencies: {
              binaryPath: "/fixture/beeper-0.6.2",
              run: matrixRunner(testCase, "readback", counters),
            },
          },
        ), variant.action).rejects.toThrow("could not obtain definitive protected evidence");
        expect({ mutationInvocations: counters.mutationInvocations, spawned: counters.spawned }, variant.action)
          .toEqual({ mutationInvocations: 0, spawned: 0 });
        expect(counters.commands.some((command) =>
          command === "chats show" || command === "messages show"
        ), variant.action).toBeFalse();
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });
});

describe("Beeper local read runtime", () => {
  test("admits every historical and current coordinate and rejects every uninstalled version", async () => {
    const invalidInput = Object.freeze({ __contract_probe: true });
    const fixtureAuth = auth("/fixture/not-opened-for-input-rejection");
    for (const action of BEEPER_LOCAL_OPERATION_NAMES) {
      for (const contractVersion of [0, 1, 2, 3, 4]) {
        let error: unknown;
        try {
          await executeBeeperLocalOperation(
            recipe(action, contractVersion),
            invalidInput,
            fixtureAuth,
          );
        } catch (caught) {
          error = caught;
        }
        expect(error, `${action}@${String(contractVersion)}`).toBeInstanceOf(Error);
        if (isBeeperLocalOperationContractVersion(action, contractVersion)) {
          expect((error as Error).message).not.toContain("recipe is not installed");
        } else {
          expect((error as Error).message).toContain("recipe is not installed");
        }
      }
      expect(BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS[action]).toBeGreaterThanOrEqual(1);
    }
  });

  test("proves and materializes one exact account/network conversation", async () => {
    const path = privateStore();
    try {
      const input = {
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        max_participants: 500,
      } as const;
      const result = await execute(path, "conversations.read", input, []);
      expect(materializeBeeperExactConversation(input, result.output)).toMatchObject({
        kind: "conversation",
        conversationKind: "single",
        detail: "summary",
        title: "Ada Fixture",
        participants: [{ displayName: "Ada Fixture" }, { displayName: "Fixture Self" }],
      });
      expect(() => materializeBeeperExactConversation({
        ...input,
        conversation_id: "another-chat",
      }, result.output)).toThrow("must bind the exact requested account and conversation");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

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

  test("proves the exact official Desktop target before authenticated account reads", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    try {
      const result = await execute(path, "accounts.list", {}, calls);
      expect(calls.map((call) => call.arguments.slice(0, 2).join(" "))).toEqual([
        "version --read-only",
        "targets status",
        "accounts list",
        "accounts list",
      ]);
      expect(calls[1]?.arguments).toEqual([
        "targets",
        "status",
        "desktop",
        "--read-only",
        "--json",
        "--full",
        "--quiet",
        "--target",
        "desktop",
        "--timeout",
        "60s",
      ]);
      expect(JSON.stringify(result.output)).not.toContain("fixture-stored-access-token");

      const rejectedCalls: BeeperCliInvocation[] = [];
      await expect(execute(path, "accounts.list", {}, rejectedCalls, {
        targetStatusData: targetStatus({ bundleID: "com.example.lookalike.desktop" }),
      })).rejects.toThrow("failed at a protected local boundary");
      expect(rejectedCalls.some((call) => call.arguments[0] === "accounts")).toBeFalse();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("reconciles a present exact outgoing pending send as provider-accepted", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    const pendingMessageId = "pending-message-fixture";
    const finalMessage = {
      ...(messages()[0] as Record<string, unknown>),
      id: "provider-final-message-fixture",
      isSender: true,
      sendStatus: {
        status: "PENDING",
        timestamp: "2026-08-21T14:00:01.000Z",
      },
    };
    try {
      const result = await reconcileBeeperLocalOperation(
        "messaging.send",
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          kind: "text",
          text: "one synthetic outgoing message",
        },
        auth(path),
        {
          schemaVersion: 1,
          kind: "provider-accepted-target-presence",
          dispatch: { id: "send-1", index: 1, planned: 1 },
          target: {
            schemaVersion: 1,
            identifier: canonicalJson({
              accountId: NETWORK_ACCOUNT_ID,
              conversationId: CHAT_ID,
              pendingMessageId,
            }),
          },
        },
        {
          dependencies: {
            binaryPath: "/fixture/beeper-0.6.2",
            run: runner(calls, { messageReadData: finalMessage }),
          },
        },
      );
      expect(result.actualState).toBeTrue();
      expect(calls.some((call) => call.arguments.includes(pendingMessageId))).toBeTrue();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("returns an exact partial result when bounded presence is cancelled between dispatches", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    const controller = new AbortController();
    const deadline = new OperationDeadline(60_000, { signal: controller.signal });
    try {
      const result = await executeBeeperLocalOperation(
        recipe("presence.set"),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          state: "typing",
          duration_seconds: 1,
        },
        auth(path),
        {
          operationDeadline: deadline,
          afterDispatchVerified: async () => {
            controller.abort();
          },
          dependencies: {
            binaryPath: "/fixture/beeper-0.6.2",
            run: async (invocation) => {
              calls.push(invocation);
              const command = invocation.arguments.slice(0, 2).join(" ");
              if (invocation.arguments[0] === "version") {
                return envelope({ name: "@beeper/cli", version: "0.6.2" });
              }
              if (command === "targets status") return envelope(targetStatus());
              if (command === "accounts list") return envelope(accounts());
              if (command === "chats show") return envelope(chats()[0]);
              if (invocation.arguments[0] === "presence") {
                await invocation.beforeSpawn?.();
                return envelope({
                  message: "Sent typing indicator",
                  chatID: CHAT_ID,
                  state: "typing",
                });
              }
              throw new Error(`unexpected fixture command ${command}`);
            },
          },
        },
      );
      expect(result).toMatchObject({
        status: "partial",
        dispatchStarted: true,
        dispatch: { planned: 2, started: 1, verified: 1 },
      });
      expect(calls.filter((call) => call.arguments[0] === "presence")).toHaveLength(1);
      expect(calls.some((call) => call.arguments.includes("paused"))).toBeFalse();
    } finally {
      deadline.dispose();
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects exact read-only chats before a messaging dispatch", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    try {
      await expect(executeBeeperLocalOperation(
        recipe("presence.set"),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          state: "typing",
        },
        auth(path),
        {
          dependencies: {
            binaryPath: "/fixture/beeper-0.6.2",
            run: runner(calls, {
              chatReadData: { ...(chats()[0] as Record<string, unknown>), isReadOnly: true },
            }),
          },
        },
      )).rejects.toThrow("execution failed at a protected local boundary");
      expect(calls.some((call) => call.arguments[0] === "presence")).toBeFalse();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects an exact non-messageable start contact before dispatch", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    const contactId = "@ada:beeper.local";
    try {
      await expect(executeBeeperLocalOperation(
        recipe("conversations.start"),
        { account_id: NETWORK_ACCOUNT_ID, user_id: contactId },
        auth(path),
        {
          dependencies: {
            binaryPath: "/fixture/beeper-0.6.2",
            run: runner(calls, {
              contactReadData: {
                accountID: NETWORK_ACCOUNT_ID,
                contact: {
                  accountID: NETWORK_ACCOUNT_ID,
                  cannotMessage: true,
                  fullName: "Ada Fixture",
                  id: contactId,
                },
              },
            }),
          },
        },
      )).rejects.toThrow("execution failed at a protected local boundary");
      expect(calls.some((call) =>
        call.arguments[0] === "chats" && call.arguments[1] === "start"
      )).toBeFalse();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("slices a complete bounded bridge catalog without pretending the projection is complete", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    try {
      const result = await execute(path, "bridges.list", { limit: 1 }, calls);
      const output = result.output as Readonly<{
        bridges: readonly Readonly<{ id: string }>[];
        completeness: Readonly<{
          providerCatalogComplete: boolean;
          projectedCatalogComplete: boolean;
          requestedLimitReached: boolean;
          truncated: boolean;
        }>;
      }>;
      expect(output.bridges.map((bridge) => bridge.id)).toEqual(["signal"]);
      expect(output.completeness).toEqual({
        providerCatalogComplete: true,
        projectedCatalogComplete: false,
        requestedLimitReached: true,
        truncated: true,
      });
      expect(calls.filter((call) => call.arguments.slice(0, 2).join(" ") === "bridges list"))
        .toHaveLength(1);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("filters platform-sdk locally without passing an unsupported upstream provider flag", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    const platform = {
      ...(bridges()[0] as Record<string, unknown>),
      id: "imessage",
      displayName: "iMessage fixture",
      provider: "platform-sdk",
      type: "imessage",
    };
    try {
      const result = await execute(path, "bridges.list", {
        provider: "platform-sdk",
        limit: 10,
      }, calls, { bridgesData: [bridges()[0], platform] });
      expect((result.output as { bridges: readonly { id: string }[] }).bridges)
        .toMatchObject([{ id: "imessage" }]);
      const invocation = calls.find((call) =>
        call.arguments.slice(0, 2).join(" ") === "bridges list");
      expect(invocation?.arguments).not.toContain("--provider");
      expect(invocation?.arguments).not.toContain("platform-sdk");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects valid bridge and chat rows that contradict exact requested filters", async () => {
    const path = privateStore();
    try {
      await expect(execute(path, "bridges.list", {
        provider: "self-hosted",
        limit: 10,
      }, [], { bridgesData: bridges() })).rejects.toThrow(
        "failed at a protected local boundary",
      );
      await expect(execute(path, "messaging.list", {
        account_id: NETWORK_ACCOUNT_ID,
        archived: true,
        limit: 10,
      }, [], { chatsData: chats() })).rejects.toThrow(
        "failed at a protected local boundary",
      );
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("binds contacts.read directly to the strict account and contact returned by contacts show", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    const contactId = "signal:outside-first-200";
    try {
      const result = await execute(path, "contacts.read", {
        account_id: NETWORK_ACCOUNT_ID,
        contact_id: contactId,
      }, calls, {
        contactReadData: {
          accountID: NETWORK_ACCOUNT_ID,
          contact: { id: contactId, fullName: "Outside Window" },
        },
      });
      expect((result.output as { contact: { id: string } }).contact.id).toBe(contactId);
      expect(calls.some((call) => call.arguments.slice(0, 2).join(" ") === "contacts list"))
        .toBeFalse();
      expect(calls.filter((call) => call.arguments.slice(0, 2).join(" ") === "contacts show"))
        .toHaveLength(1);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("treats an omitted reminder dismissal flag as pinned default false", () => {
    const parsedAccounts = parseBeeperExportAccounts(accounts());
    const chat = parseBeeperExportConversation({
      ...(chats()[0] as Record<string, unknown>),
      reminder: { remindAt: "2026-09-01T12:00:00.000Z" },
    }, parsedAccounts);
    expect(beeperDesiredChatStateForTest("conversations.reminder.set", {
      when: "2026-09-01T12:00:00.000Z",
      dismissOnMessage: false,
    }, chat)).toBeTrue();
    expect(beeperDesiredChatStateForTest("conversations.reminder.set", {
      when: "2026-09-01T12:00:00.000Z",
      dismissOnMessage: true,
    }, chat)).toBeFalse();
  });

  test("normalizes omitted pinned Chat state booleans as false desired-state evidence", () => {
    const chat = parseBeeperExportConversation(
      chats()[0],
      parseBeeperExportAccounts(accounts()),
    );
    for (const action of [
      "conversations.archive.set",
      "conversations.pin.set",
      "conversations.mute.set",
    ] as const) {
      expect(beeperDesiredChatStateForTest(action, { enabled: false }, chat)).toBeTrue();
      expect(beeperDesiredChatStateForTest(action, { enabled: true }, chat)).toBeFalse();
    }
    expect(beeperDesiredChatStateForTest(
      "conversations.priority.set",
      { level: "inbox" },
      chat,
    )).toBeTrue();
  });

  test("reconciles conversation booleans as actual state without false-state inversion", async () => {
    const path = privateStore();
    try {
      for (const [action, rawField] of [
        ["conversations.archive.set", "isArchived"],
        ["conversations.pin.set", "isPinned"],
        ["conversations.mute.set", "isMuted"],
      ] as const) {
        const input = {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          enabled: false,
        };
        const correct = await reconcileBeeperLocalOperation(
          action,
          input,
          auth(path),
          undefined,
          {
            dependencies: {
              binaryPath: "/fixture/beeper-0.6.2",
              run: runner([], { chatReadData: { ...chats()[0] as object, [rawField]: false } }),
            },
          },
        );
        const wrong = await reconcileBeeperLocalOperation(
          action,
          input,
          auth(path),
          undefined,
          {
            dependencies: {
              binaryPath: "/fixture/beeper-0.6.2",
              run: runner([], { chatReadData: { ...chats()[0] as object, [rawField]: true } }),
            },
          },
        );
        expect(correct.actualState, action).toBeFalse();
        expect(correct.actualState === input.enabled, action).toBeTrue();
        expect(wrong.actualState, action).toBeTrue();
        expect(wrong.actualState === input.enabled, action).toBeFalse();
      }
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects lossy opaque IDs and non-data bounded JSON arrays", () => {
    expect(() => parseBeeperOperationInput("contacts.read", {
      account_id: NETWORK_ACCOUNT_ID,
      contact_id: "signal:\ud800",
    })).toThrow("well-formed opaque text");
    for (const [action, input] of [
      ["contacts.search", { query: "query-\ud800" }],
      ["messaging.search", { query: "query-\ud800" }],
      ["messaging.content.search", { query: "query-\ud800" }],
    ] as const) {
      expect(() => parseBeeperOperationInput(action, input))
        .toThrow("nonempty normalized non-flag text");
    }
    const base = accounts()[0] as Record<string, unknown>;
    const accessor: unknown[] = [null];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => "secret" });
    const withSymbol: unknown[] = [null];
    Object.defineProperty(withSymbol, Symbol("secret"), { value: true });
    const sparse = new Array(1);
    for (const capabilities of [accessor, withSymbol, sparse]) {
      expect(() => parseBeeperExportAccounts([{ ...base, capabilities }]))
        .toThrow();
    }
  });

  test("copies only stable confirmed file bytes into one read-only private snapshot", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "wrench-beeper-file-copy.")));
    const bytes = Buffer.from("confirmed plan-bound bytes\n", "utf8");
    const expected = Object.freeze({
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const makeCase = (name: string) => {
      const root = join(parent, name);
      mkdirSync(root, { mode: 0o700 });
      const source = join(parent, `${name}.txt`);
      writeFileSync(source, bytes, { mode: 0o600 });
      return { root, source };
    };
    try {
      const stable = makeCase("stable");
      const copied = await materializeBeeperPlanBoundFileForTest(
        stable.source,
        stable.root,
        expected,
      );
      expect(readFileSync(copied)).toEqual(bytes);
      expect(statSync(copied).mode & 0o777).toBe(0o400);
      expect(copied.startsWith(`${stable.root}/`)).toBeTrue();

      const replaced = makeCase("replaced");
      await expect(materializeBeeperPlanBoundFileForTest(
        replaced.source,
        replaced.root,
        expected,
        async () => {
          renameSync(replaced.source, `${replaced.source}.original`);
          writeFileSync(replaced.source, bytes, { mode: 0o600 });
        },
      )).rejects.toThrow("changed while its private snapshot was created");

      const mutated = makeCase("mutated");
      await expect(materializeBeeperPlanBoundFileForTest(
        mutated.source,
        mutated.root,
        expected,
        async () => {
          writeFileSync(mutated.source, "mutated after open\n", { mode: 0o600 });
        },
      )).rejects.toThrow();

      const linkedRoot = join(parent, "linked");
      mkdirSync(linkedRoot, { mode: 0o700 });
      const linkedSource = join(parent, "linked.txt");
      symlinkSync(stable.source, linkedSource);
      await expect(materializeBeeperPlanBoundFileForTest(
        linkedSource,
        linkedRoot,
        expected,
      )).rejects.toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("plans only fixed read commands with command paths before Oclif global flags", () => {
    expect(planBeeperVersionCommand()).toEqual({
      action: "version",
      argv: ["version", "--read-only", "--json", "--quiet"],
      mutation: false,
    });
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
    const input = parseBeeperMessagingReadInputV2({
      account_id: NETWORK_ACCOUNT_ID,
      conversation_id: CHAT_ID,
      before_cursor: "message-cursor",
      limit: 2,
    });
    const command = planBeeperReadCommand("messaging.read", input, 60_000);
    expect(command.argv.slice(0, 2)).toEqual(["messages", "list"]);
    expect(command.argv.indexOf("--read-only")).toBeGreaterThan(1);
    expect(command.argv).toContain("--before-cursor");
    expect(command.argv).not.toContain("--sender");
    expect(command.argv.join(" ")).not.toMatch(/\b(?:api|export|send|download|watch)\b/u);
    expect(() => parseBeeperMessagingReadInput({
      account_id: NETWORK_ACCOUNT_ID,
      conversation_id: CHAT_ID,
      before_cursor: "before",
      after_cursor: "after",
    })).toThrow("only one cursor direction");
    for (const sender of [undefined, "others"] as const) {
      const directOnly = parseBeeperMessagingReadInput({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        ...(sender === undefined ? {} : { sender }),
      });
      expect(() => planBeeperReadCommand(
        "messaging.read",
        directOnly,
        60_000,
      )).toThrow("contract v3 is direct-only");
    }

    const contactList = parseBeeperContactsListInput({
      account_id: NETWORK_ACCOUNT_ID,
      query: "  Åda Fixture  ",
      limit: 7,
    });
    expect(contactList.query).toBe("Åda Fixture");
    expect(planBeeperReadCommand("contacts.list", contactList, 60_000).argv)
      .toEqual(expect.arrayContaining(["--query", "Åda Fixture"]));

  });

  test("normalizes and bounds fuzzy search queries and plans only pinned search commands", () => {
    const contactInput = parseBeeperContactsSearchInput({
      account_id: NETWORK_ACCOUNT_ID,
      query: "  Åda Fixture  ",
      limit: 7,
    });
    expect(contactInput.query).toBe("Åda Fixture");
    expect(planBeeperReadCommand("contacts.search", contactInput, 60_000).argv)
      .toEqual([
        "contacts",
        "search",
        "Åda Fixture",
        "--account",
        NETWORK_ACCOUNT_ID,
        "--read-only",
        "--json",
        "--full",
        "--quiet",
        "--target",
        "desktop",
        "--timeout",
        "60s",
      ]);
    const conversationInput = parseBeeperMessagingSearchInput({
      query: "Ada Fixture",
    });
    expect(conversationInput.limit).toBe(20);
    expect(planBeeperReadCommand(
      "messaging.search",
      conversationInput,
      60_000,
    ).argv.slice(0, 5)).toEqual([
      "chats",
      "search",
      "Ada Fixture",
      "--limit",
      "20",
    ]);
    expect(() => parseBeeperContactsSearchInput({ query: "  " }))
      .toThrow("nonempty normalized non-flag text");
    expect(() => parseBeeperContactsSearchInput({ query: "Ada\nFixture" }))
      .toThrow("nonempty normalized non-flag text");
    expect(() => parseBeeperContactsSearchInput({ query: "é".repeat(129) }))
      .toThrow("at most 256 UTF-8 bytes");
    expect(() => parseBeeperMessagingSearchInput({
      query: "Ada",
      limit: 21,
    })).toThrow("integer from 1 through 20");
    expect(() => parseBeeperMessagingSearchInput({
      query: "Ada",
      raw_endpoint: "/private",
    })).toThrow("unsupported fields");
  });

  test("rejects an empty group description before planning a mutation", () => {
    expect(() => parseBeeperOperationInput("conversations.description.set", {
      account_id: NETWORK_ACCOUNT_ID,
      conversation_id: CHAT_ID,
      clear: false,
      description: "",
    })).toThrow("description must be nonempty bounded text");
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
      maxParticipants: 2_000,
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
      "2000",
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
    expect(() => planBeeperMessageLikeMeExportCommand({
      outputDirectory: "/private/export/account-3",
      limitChats: 1,
      limitMessages: 1,
      maxParticipants: 2_001,
    }, 1_000)).toThrow("integer from 1 through 2000");
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
          completeness: {
            continuationAvailable: false,
            localPageComplete: false,
            remoteContactSetComplete: false,
            resultWindowComplete: false,
          },
        },
      });
      expect(listResult).toMatchObject({
        status: "succeeded",
        output: {
          conversations: [{ accountId: NETWORK_ACCOUNT_ID, id: CHAT_ID }],
          operation: "messaging.list",
          completeness: {
            continuationAvailable: false,
            localPageComplete: false,
            remoteConversationSetComplete: false,
            resultWindowComplete: false,
          },
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
      const readPage = materializeBeeperMessagingReadV1(
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
      const nonTerminal = structuredClone(readResult.output) as Record<string, unknown>;
      (nonTerminal.continuation as { cursor: string }).cursor = "message-outgoing";
      expect(() => materializeBeeperMessagingReadV1(
        { account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, limit: 2 },
        nonTerminal,
      )).toThrow("terminal returned message ID");
      const loop = structuredClone(readResult.output) as Record<string, unknown>;
      loop.requestCursor = "message-deleted";
      expect(() => materializeBeeperMessagingReadV1({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        before_cursor: "message-deleted",
        limit: 2,
      }, loop)).toThrow("must exclude the prior request cursor");
      const overlap = structuredClone(readResult.output) as Record<string, unknown>;
      overlap.requestCursor = "message-outgoing";
      expect(() => materializeBeeperMessagingReadV1({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        before_cursor: "message-outgoing",
        limit: 2,
      }, overlap)).toThrow("exclude the prior request cursor");

      expect(calls).toHaveLength(12);
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

  test("projects fuzzy search as incomplete candidate-only identity metadata", async () => {
    const path = privateStore();
    const calls: BeeperCliInvocation[] = [];
    try {
      const blendedListResult = await execute(
        path,
        "contacts.list",
        { account_id: NETWORK_ACCOUNT_ID, query: "  Ada Fixture ", limit: 2 },
        calls,
      );
      const contactResult = await execute(
        path,
        "contacts.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "  Ada Fixture ", limit: 2 },
        calls,
      );
      const conversationResult = await execute(
        path,
        "messaging.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Ada Fixture", limit: 2 },
        calls,
      );

      expect(blendedListResult.output).toMatchObject({
        operation: "contacts.list",
        projection: "bounded-local-desktop-provider-blended-candidates",
        query: "Ada Fixture",
        completeness: {
          resultWindowComplete: false,
          continuationAvailable: false,
          warnings: expect.arrayContaining([
            "beeper-cli-v0.6.2-contact-list-query-is-provider-blended-candidate-matching",
          ]),
        },
      });

      expect(contactResult.output).toEqual({
        provider: "beeper",
        operation: "contacts.search",
        accountSubject: SUBJECT,
        projection: "bounded-local-desktop-search",
        requestedAccountId: NETWORK_ACCOUNT_ID,
        query: "Ada Fixture",
        searchSemantics: "provider-fuzzy-candidates",
        contacts: [{
          accountId: NETWORK_ACCOUNT_ID,
          network: "Signal",
          id: "signal:ada",
          fullName: "Ada Fixture",
          username: null,
          isSelf: null,
        }],
        completeness: {
          resultWindowComplete: false,
          remoteContactSetComplete: false,
          continuationAvailable: false,
          requestedLimitReached: false,
          warnings: [
            "beeper-cli-v0.6.2-search-results-are-fuzzy-candidates",
            "beeper-cli-v0.6.2-contact-search-result-window-has-no-continuation",
            "provider-history-coverage-varies-by-connected-account",
          ],
        },
      });
      expect(conversationResult.output).toMatchObject({
        provider: "beeper",
        operation: "messaging.search",
        accountSubject: SUBJECT,
        projection: "bounded-local-desktop-search",
        requestedAccountId: NETWORK_ACCOUNT_ID,
        query: "Ada Fixture",
        searchSemantics: "provider-fuzzy-candidates",
        conversations: [{
          id: CHAT_ID,
          accountId: NETWORK_ACCOUNT_ID,
          network: "Signal",
          title: "Ada Fixture",
          type: "single",
          direct: true,
          participants: {
            total: 2,
            hasMore: false,
            items: [{
              id: "signal:ada",
              fullName: "Ada Fixture",
              username: null,
              isSelf: false,
            }, {
              id: "signal:self",
              fullName: "Fixture Self",
              username: null,
              isSelf: true,
            }],
          },
        }],
        completeness: {
          resultWindowComplete: false,
          remoteConversationSetComplete: false,
          continuationAvailable: false,
          requestedLimitReached: false,
        },
      });
      const encoded = JSON.stringify([contactResult.output, conversationResult.output]);
      for (const omitted of [
        "loginId",
        "statusText",
        "description",
        "lastActivity",
        "unreadCount",
        "isArchived",
        "cannotMessage",
        "phoneNumber",
        "email",
        "imgURL",
        "preview",
      ]) expect(encoded).not.toContain(omitted);
      expect(calls.map((call) => call.arguments.slice(0, 2).join(" ")))
        .toEqual([
          "version --read-only",
          "targets status",
          "accounts list",
          "contacts list",
          "version --read-only",
          "targets status",
          "accounts list",
          "contacts search",
          "version --read-only",
          "targets status",
          "accounts list",
          "chats search",
        ]);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects local list and fuzzy-search output beyond the requested bound", async () => {
    const path = privateStore();
    const repeatedContacts = [
      ...(contacts() as readonly Record<string, unknown>[]),
      {
        ...(contacts()[0] as Record<string, unknown>),
        id: "signal:grace",
        fullName: "Grace Fixture",
      },
    ];
    const repeatedChats = [
      ...(chats() as readonly Record<string, unknown>[]),
      {
        ...(chats()[0] as Record<string, unknown>),
        id: "chat-second-synthetic",
        title: "Grace Fixture",
      },
    ];
    try {
      await expect(execute(
        path,
        "contacts.list",
        { account_id: NETWORK_ACCOUNT_ID, limit: 1 },
        [],
        { contactsData: repeatedContacts },
      )).rejects.toThrow("failed at a protected local boundary");
      const contactSearch = await execute(
        path,
        "contacts.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 1 },
        [],
        { contactsData: repeatedContacts },
      );
      expect((contactSearch.output as { contacts: readonly unknown[] }).contacts)
        .toHaveLength(1);
      expect((contactSearch.output as {
        completeness: { requestedLimitReached: boolean };
      }).completeness.requestedLimitReached).toBeTrue();
      await expect(execute(
        path,
        "messaging.list",
        { account_id: NETWORK_ACCOUNT_ID, limit: 1 },
        [],
        { chatsData: repeatedChats },
      )).rejects.toThrow("failed at a protected local boundary");
      await expect(execute(
        path,
        "messaging.read",
        { account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, limit: 1 },
        [],
        { messagesData: messages() },
      )).rejects.toThrow("failed at a protected local boundary");
      await expect(execute(
        path,
        "messaging.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 1 },
        [],
        { chatsData: repeatedChats },
      )).rejects.toThrow("failed at a protected local boundary");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects malformed search identity text and contradictory participant evidence", async () => {
    const path = privateStore();
    const contact = contacts()[0] as Record<string, unknown>;
    const chat = chats()[0] as Record<string, unknown>;
    const participants = chat.participants as Record<string, unknown>;
    const items = participants.items as readonly Record<string, unknown>[];
    try {
      await expect(execute(
        path,
        "contacts.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 2 },
        [],
        { contactsData: [{ ...contact, id: "signal:\ud800" }] },
      )).rejects.toThrow("failed at a protected local boundary");
      await expect(execute(
        path,
        "contacts.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 2 },
        [],
        { contactsData: [{ ...contact, id: "signal:\nada" }] },
      )).rejects.toThrow("failed at a protected local boundary");
      await expect(execute(
        path,
        "messaging.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 2 },
        [],
        {
          chatsData: [{
            ...chat,
            participants: { ...participants, total: 3, hasMore: false },
          }],
        },
      )).rejects.toThrow("failed at a protected local boundary");
      await expect(execute(
        path,
        "messaging.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 2 },
        [],
        {
          chatsData: [{
            ...chat,
            participants: {
              ...participants,
              items: [items[0], { ...items[1], id: items[0]!.id }],
            },
          }],
        },
      )).rejects.toThrow("failed at a protected local boundary");
      await expect(execute(
        path,
        "messaging.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 2 },
        [],
        {
          chatsData: [{
            ...chat,
            participants: {
              ...participants,
              items: items.map((item) => ({ ...item, isSelf: true })),
            },
          }],
        },
      )).rejects.toThrow("failed at a protected local boundary");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("strictly validates discarded nested chat-search metadata", async () => {
    const path = privateStore();
    const chat = chats()[0] as Record<string, unknown>;
    const preview = messages()[0] as Record<string, unknown>;
    try {
      const accepted = await execute(
        path,
        "messaging.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 2 },
        [],
        {
          chatsData: [{
            ...chat,
            capabilities: {
              archive: true,
              reaction: 2,
              attachments: {
                "m.image": {
                  mimeTypes: { "image/*": 2 },
                  maxSize: 10_000_000,
                },
              },
            },
            draft: { text: "first line\nsecond line" },
            preview,
            reminder: {
              dismissOnIncomingMessage: true,
              remindAt: "2026-08-22T12:00:00.000Z",
            },
            snooze: {
              snoozeUntil: "2026-08-22T13:00:00.000Z",
              userSnoozedAt: "2026-08-22T11:00:00.000Z",
            },
          }],
        },
      );
      expect(JSON.stringify(accepted.output)).not.toContain("first line");
      expect(JSON.stringify(accepted.output)).not.toContain("message-outgoing");

      await expect(execute(
        path,
        "messaging.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 2 },
        [],
        { chatsData: [{ ...chat, capabilities: { unreviewed: true } }] },
      )).rejects.toThrow("failed at a protected local boundary");
      await expect(execute(
        path,
        "messaging.search",
        { account_id: NETWORK_ACCOUNT_ID, query: "Fixture", limit: 2 },
        [],
        { chatsData: [{ ...chat, preview: { ...preview, unreviewed: true } }] },
      )).rejects.toThrow("failed at a protected local boundary");
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
        expect(boundedJsonOutput(result.output, 10 * 1024 * 1024))
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

  test("projects an omitted optional isSender field as unknown direction", async () => {
    const path = privateStore();
    try {
      const result = await execute(
        path,
        "messaging.read",
        { account_id: NETWORK_ACCOUNT_ID, conversation_id: CHAT_ID, limit: 2 },
        [],
        { includeDirection: false },
      );
      const omni = materializeBeeperMessagingReadV1({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        limit: 2,
      }, result.output);
      expect(omni.entities[0]?.kind).toBe("message");
      expect(omni.entities[0]?.kind === "message" && omni.entities[0].direction)
        .toBe("unknown");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("filters direct read v3 by exact sender without splitting provider pages", async () => {
    const path = privateStore();
    try {
      const outgoing = messages()[0]!;
      const incoming = messages()[1]!;
      const malformedIdentifiers = Object.freeze([
        "opaque\r\nforged",
        `opaque-${String.fromCharCode(0xd800)}`,
        "opaque\tforged",
        "opaque-\u0085forged",
      ] as const);
      const urls: URL[] = [];
      let cliCalls = 0;
      const result = await executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "others",
          limit: 1,
        },
        auth(path),
        {
          dependencies: {
            binaryPath: "/fixture/beeper-0.6.2",
            run: () => {
              cliCalls += 1;
              return Promise.reject(new Error("direct read must not start the CLI"));
            },
          },
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              if (url.endsWith("/v1/info")) return Promise.resolve(directJsonResponse(directInfo()));
              if (url.endsWith("/v1/accounts")) return Promise.resolve(directJsonResponse(accounts()));
              const parsed = new URL(url);
              urls.push(parsed);
              return Promise.resolve(directJsonResponse(urls.length === 1
                ? {
                    items: [outgoing],
                    hasMore: true,
                    oldestCursor: "opaque-before-outgoing",
                    newestCursor: "opaque-after-outgoing",
                  }
                : {
                    items: [incoming],
                    hasMore: true,
                    oldestCursor: "opaque-before-incoming",
                    newestCursor: "opaque-after-incoming",
                  }));
            },
          },
        },
      );
      expect(result.output).toMatchObject({
        requestedSender: "others",
        requestDirection: "before",
        messages: [{ id: "message-deleted", isSender: false }],
        continuation: { direction: "before", cursor: "opaque-before-incoming" },
        completeness: { localPageComplete: false, limitReached: true },
      });
      expect(materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        sender: "others",
        limit: 1,
      }, result.output).cursor.nextInput).toEqual({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        sender: "others",
        limit: 1,
        before_cursor: "opaque-before-incoming",
      });
      expect(urls.map((url) => url.searchParams.get("cursor")))
        .toEqual([null, "opaque-before-outgoing"]);
      expect(cliCalls).toBe(0);
      expect(() => parseBeeperMessagingReadInput({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        sender: "--raw-flag",
      })).toThrow("non-flag user ID");
      for (const malformed of malformedIdentifiers) {
        expect(() => parseBeeperMessagingReadInput({
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: malformed,
        }), `raw sender ${JSON.stringify(malformed)}`).toThrow();
        expect(() => parseBeeperMessagingReadInput({
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          before_cursor: malformed,
        }), `raw cursor ${JSON.stringify(malformed)}`).toThrow();
      }

      for (const selfEvidence of [false, null, undefined] as const) {
        let messageRequests = 0;
        const unprovenAccounts = accounts().map((item) => {
          const account = item as Record<string, unknown>;
          if (account.accountID !== NETWORK_ACCOUNT_ID) return item;
          const user = {
            ...(account.user as Record<string, unknown>),
          };
          if (selfEvidence === undefined) delete user.isSelf;
          else user.isSelf = selfEvidence;
          return { ...account, user };
        });
        await expect(executeBeeperLocalOperation(
          recipe("messaging.read", 3),
          {
            account_id: NETWORK_ACCOUNT_ID,
            conversation_id: CHAT_ID,
            sender: "me",
            limit: 1,
          },
          auth(path),
          {
            directDependencies: {
              fetch: (request) => {
                const url = String(request);
                if (url.endsWith("/v1/info")) {
                  return Promise.resolve(directJsonResponse(directInfo()));
                }
                if (url.endsWith("/v1/accounts")) {
                  return Promise.resolve(directJsonResponse(unprovenAccounts));
                }
                messageRequests += 1;
                return Promise.resolve(directJsonResponse({
                  items: [outgoing],
                  hasMore: false,
                  oldestCursor: null,
                  newestCursor: null,
                }));
              },
            },
          },
        ), `isSelf=${String(selfEvidence)}`)
          .rejects.toThrow("failed at a protected local boundary");
        expect(messageRequests, `isSelf=${String(selfEvidence)}`).toBe(0);
      }

      const noMatch = await executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "others",
          limit: 1,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              return Promise.resolve(directJsonResponse(
                url.endsWith("/v1/info")
                  ? directInfo()
                  : url.endsWith("/v1/accounts")
                    ? accounts()
                    : {
                        items: [outgoing],
                        hasMore: false,
                        oldestCursor: null,
                        newestCursor: null,
                      },
              ));
            },
          },
        },
      );
      expect(noMatch.output).toMatchObject({
        requestedSender: "others",
        messages: [],
        continuation: null,
        completeness: { localPageComplete: true, limitReached: false },
      });

      for (const malformed of malformedIdentifiers) {
        await expect(executeBeeperLocalOperation(
          recipe("messaging.read", 3),
          {
            account_id: NETWORK_ACCOUNT_ID,
            conversation_id: CHAT_ID,
            sender: "me",
            limit: 1,
          },
          auth(path),
          {
            directDependencies: {
              fetch: (request) => {
                const url = String(request);
                return Promise.resolve(directJsonResponse(
                  url.endsWith("/v1/info")
                    ? directInfo()
                    : url.endsWith("/v1/accounts")
                      ? accounts()
                      : {
                          items: [outgoing],
                          hasMore: true,
                          oldestCursor: malformed,
                          newestCursor: "valid-newest-cursor",
                        },
                ));
              },
            },
          },
        ), `provider cursor ${JSON.stringify(malformed)}`)
          .rejects.toThrow("failed at a protected local boundary");
      }

      await expect(executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "me",
          limit: 1,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              return Promise.resolve(directJsonResponse(
                url.endsWith("/v1/info")
                  ? directInfo()
                  : url.endsWith("/v1/accounts")
                    ? accounts()
                    : {
                        items: [messages(false)[0]],
                        hasMore: false,
                        oldestCursor: null,
                        newestCursor: null,
                      },
              ));
            },
          },
        },
      )).rejects.toThrow("failed at a protected local boundary");

      const opaque = await executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "signal:ada",
          limit: 1,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              return Promise.resolve(directJsonResponse(
                url.endsWith("/v1/info")
                  ? directInfo()
                  : url.endsWith("/v1/accounts")
                    ? accounts()
                    : {
                        items: [{
                          ...(messages(false)[0] as Record<string, unknown>),
                          senderID: "signal:ada",
                        }],
                        hasMore: false,
                        oldestCursor: null,
                        newestCursor: null,
                      },
              ));
            },
          },
        },
      );
      expect(opaque.output).toMatchObject({
        requestedSender: "signal:ada",
        messages: [{ senderId: "signal:ada", isSender: null }],
      });
      const opaqueOmni = materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        sender: "signal:ada",
        limit: 1,
      }, opaque.output);
      expect(opaqueOmni.entities).toHaveLength(1);
      expect(opaqueOmni.cursor.nextInput).toBeNull();

      const senderNullNonSelfDirection = structuredClone(result.output) as Record<string, unknown>;
      senderNullNonSelfDirection.requestedSender = null;
      ((senderNullNonSelfDirection.messages as Record<string, unknown>[])[0]!).isSender = true;
      expect(() => materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        limit: 1,
      }, senderNullNonSelfDirection)).toThrow("must bind direction to the exact self user ID");

      const senderNullSelfDirection = structuredClone(result.output) as Record<string, unknown>;
      senderNullSelfDirection.requestedSender = null;
      senderNullSelfDirection.selfUserId = "signal:ada";
      expect(() => materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        limit: 1,
      }, senderNullSelfDirection)).toThrow("must bind direction to the exact self user ID");

      const explicitDirectionContradiction = structuredClone(opaque.output) as Record<string, unknown>;
      ((explicitDirectionContradiction.messages as Record<string, unknown>[])[0]!).isSender = true;
      expect(() => materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        sender: "signal:ada",
        limit: 1,
      }, explicitDirectionContradiction)).toThrow("must bind direction to the exact self user ID");

      const malformedSelf = structuredClone(opaque.output) as Record<string, unknown>;
      malformedSelf.selfUserId = "signal:\tself";
      expect(() => materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        sender: "signal:ada",
        limit: 1,
      }, malformedSelf)).toThrow("must be one bounded Beeper identifier");

      for (const contradiction of [
        {
          label: "me with non-self sender",
          sender: "me",
          row: { ...(outgoing as Record<string, unknown>), senderID: "signal:ada", isSender: true },
        },
        {
          label: "others with self sender",
          sender: "others",
          row: { ...(incoming as Record<string, unknown>), senderID: "signal:self", isSender: false },
        },
        {
          label: "opaque other with contradictory self direction",
          sender: "signal:ada",
          row: { ...(outgoing as Record<string, unknown>), senderID: "signal:ada", isSender: true },
        },
        {
          label: "opaque self with contradictory other direction",
          sender: "signal:self",
          row: { ...(incoming as Record<string, unknown>), senderID: "signal:self", isSender: false },
        },
      ] as const) {
        await expect(executeBeeperLocalOperation(
          recipe("messaging.read", 3),
          {
            account_id: NETWORK_ACCOUNT_ID,
            conversation_id: CHAT_ID,
            sender: contradiction.sender,
            limit: 1,
          },
          auth(path),
          {
            directDependencies: {
              fetch: (request) => {
                const url = String(request);
                return Promise.resolve(directJsonResponse(
                  url.endsWith("/v1/info")
                    ? directInfo()
                    : url.endsWith("/v1/accounts")
                      ? accounts()
                      : {
                          items: [contradiction.row],
                          hasMore: false,
                          oldestCursor: null,
                          newestCursor: null,
                        },
                ));
              },
            },
          },
        ), contradiction.label).rejects.toThrow("failed at a protected local boundary");
      }

      const afterUrls: URL[] = [];
      const after = await executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          after_cursor: "opaque-after-start",
          sender: "me",
          limit: 1,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              if (url.endsWith("/v1/info")) return Promise.resolve(directJsonResponse(directInfo()));
              if (url.endsWith("/v1/accounts")) return Promise.resolve(directJsonResponse(accounts()));
              const parsed = new URL(url);
              afterUrls.push(parsed);
              return Promise.resolve(directJsonResponse({
                items: [outgoing],
                hasMore: true,
                oldestCursor: "opaque-before-outgoing",
                newestCursor: "opaque-after-outgoing",
              }));
            },
          },
        },
      );
      expect(afterUrls[0]?.searchParams.get("direction")).toBe("after");
      expect(after.output).toMatchObject({
        requestDirection: "after",
        continuation: { direction: "after", cursor: "opaque-after-outgoing" },
      });
      expect(materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        after_cursor: "opaque-after-start",
        sender: "me",
        limit: 1,
      }, after.output).cursor.nextInput).toMatchObject({
        after_cursor: "opaque-after-outgoing",
        sender: "me",
      });

      await expect(executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "others",
          limit: 1,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              return Promise.resolve(directJsonResponse(
                url.endsWith("/v1/info")
                  ? directInfo()
                  : url.endsWith("/v1/accounts")
                    ? accounts()
                    : {
                        items: [incoming, {
                          ...(incoming as Record<string, unknown>),
                          id: "message-incoming-second",
                          sortKey: "00000000000000000000",
                        }],
                        hasMore: true,
                        oldestCursor: "opaque-overflow",
                        newestCursor: "opaque-overflow-newest",
                      },
              ));
            },
          },
        },
      )).rejects.toThrow("failed at a protected local boundary");

      let page = 0;
      const bounded = await executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "others",
          limit: 1,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              if (url.endsWith("/v1/info")) return Promise.resolve(directJsonResponse(directInfo()));
              if (url.endsWith("/v1/accounts")) return Promise.resolve(directJsonResponse(accounts()));
              page += 1;
              return Promise.resolve(directJsonResponse(page === 1
                ? {
                    items: [outgoing],
                    hasMore: true,
                    oldestCursor: "opaque-before-page-2",
                    newestCursor: "opaque-after-page-1",
                  }
                : {
                    items: [incoming, {
                      ...(incoming as Record<string, unknown>),
                      id: "message-incoming-second",
                      sortKey: "00000000000000000000",
                    }],
                    hasMore: true,
                    oldestCursor: "opaque-before-page-3",
                    newestCursor: "opaque-after-page-2",
                  }));
            },
          },
        },
      );
      expect(bounded.output).toMatchObject({
        messages: [],
        continuation: {
          direction: "before",
          cursor: "opaque-before-page-2",
        },
        completeness: { localPageComplete: false, limitReached: false },
      });

      let repeatedPage = 0;
      await expect(executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "others",
          limit: 2,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              if (url.endsWith("/v1/info")) return Promise.resolve(directJsonResponse(directInfo()));
              if (url.endsWith("/v1/accounts")) return Promise.resolve(directJsonResponse(accounts()));
              repeatedPage += 1;
              return Promise.resolve(directJsonResponse({
                items: [repeatedPage === 1 ? outgoing : incoming],
                hasMore: true,
                oldestCursor: "opaque-repeated",
                newestCursor: `opaque-newest-${String(repeatedPage)}`,
              }));
            },
          },
        },
      )).rejects.toThrow("failed at a protected local boundary");

      await expect(executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          limit: 2,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              return Promise.resolve(directJsonResponse(
                url.endsWith("/v1/info")
                  ? directInfo()
                  : url.endsWith("/v1/accounts")
                    ? accounts()
                    : {
                        items: [outgoing, outgoing],
                        hasMore: false,
                        oldestCursor: null,
                        newestCursor: null,
                      },
              ));
            },
          },
        },
      )).rejects.toThrow("failed at a protected local boundary");

      await expect(executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          limit: 2,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              return Promise.resolve(directJsonResponse(
                url.endsWith("/v1/info")
                  ? directInfo()
                  : url.endsWith("/v1/accounts")
                    ? accounts()
                    : {
                        items: [incoming, outgoing],
                        hasMore: false,
                        oldestCursor: null,
                        newestCursor: null,
                      },
              ));
            },
          },
        },
      )).rejects.toThrow("failed at a protected local boundary");

      let boundedPages = 0;
      const eightPageBound = await executeBeeperLocalOperation(
        recipe("messaging.read", 3),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "signal:missing",
          limit: 2,
        },
        auth(path),
        {
          directDependencies: {
            fetch: (request) => {
              const url = String(request);
              if (url.endsWith("/v1/info")) return Promise.resolve(directJsonResponse(directInfo()));
              if (url.endsWith("/v1/accounts")) return Promise.resolve(directJsonResponse(accounts()));
              boundedPages += 1;
              return Promise.resolve(directJsonResponse({
                items: [{
                  ...(outgoing as Record<string, unknown>),
                  id: `bounded-message-${String(boundedPages)}`,
                  sortKey: String(100 - boundedPages).padStart(20, "0"),
                }],
                hasMore: true,
                oldestCursor: `opaque-before-bounded-${String(boundedPages)}`,
                newestCursor: `opaque-after-bounded-${String(boundedPages)}`,
              }));
            },
          },
        },
      );
      expect(boundedPages).toBe(8);
      expect(eightPageBound.output).toMatchObject({
        messages: [],
        continuation: {
          direction: "before",
          cursor: "opaque-before-bounded-8",
        },
      });

      await expect(executeBeeperLocalOperation(
        recipe("messaging.read", 2),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "others",
          limit: 1,
        },
        auth(path),
      )).rejects.toThrow("messaging.read input contained unsupported fields");
      await expect(executeBeeperLocalOperation(
        recipe("messaging.read", 1),
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "others",
          limit: 1,
        },
        auth(path),
      )).rejects.toThrow("messaging.read input contained unsupported fields");

      const v1Calls: BeeperCliInvocation[] = [];
      const v1 = await execute(
        path,
        "messaging.read",
        {
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          limit: 1,
        },
        v1Calls,
        { messagesData: [outgoing] },
      );
      expect(v1.output).toMatchObject({ messages: [{ id: "message-outgoing" }] });
      expect(v1Calls.some((call) => call.arguments[0] === "messages")).toBeTrue();

      for (const malformed of malformedIdentifiers) {
        expect(() => materializeBeeperMessagingRead({
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: malformed,
          limit: 1,
        }, result.output), `sender ${JSON.stringify(malformed)}`)
          .toThrow("must be one bounded Beeper identifier");
        expect(() => materializeBeeperMessagingRead({
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          before_cursor: malformed,
          sender: "others",
          limit: 1,
        }, result.output), `request cursor ${JSON.stringify(malformed)}`)
          .toThrow("must be one bounded Beeper identifier");
        const malformedContinuation = structuredClone(result.output) as Record<string, unknown>;
        malformedContinuation.continuation = {
          direction: "before",
          cursor: malformed,
        };
        expect(() => materializeBeeperMessagingRead({
          account_id: NETWORK_ACCOUNT_ID,
          conversation_id: CHAT_ID,
          sender: "others",
          limit: 1,
        }, malformedContinuation), `continuation cursor ${JSON.stringify(malformed)}`)
          .toThrow("must be one bounded Beeper identifier");
      }

      const forged = structuredClone(result.output) as Record<string, unknown>;
      forged.requestedSender = "me";
      expect(() => materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        sender: "others",
        limit: 1,
      }, forged)).toThrow("must bind the requested sender");
      const forgedContinuation = structuredClone(result.output) as Record<string, unknown>;
      forgedContinuation.continuation = {
        direction: "before",
        cursor: "opaque-before-incoming",
      };
      forgedContinuation.requestCursor = "opaque-before-incoming";
      expect(() => materializeBeeperMessagingRead({
        account_id: NETWORK_ACCOUNT_ID,
        conversation_id: CHAT_ID,
        before_cursor: "opaque-before-incoming",
        sender: "others",
        limit: 1,
      }, forgedContinuation)).toThrow("must advance");
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

  test("rediscovers a stale bound subject through the authenticated direct realm", async () => {
    const path = privateStore();
    const requests: Array<{ route: string; authorization: string | null }> = [];
    let cliRuns = 0;
    try {
      const staleSubject = `beeper:local:${"0".repeat(64)}`;
      const subject = await probeBeeperLocalSubject({
        ...auth(path),
        subject: staleSubject,
      }, {
        dependencies: {
          run: () => {
            cliRuns += 1;
            throw new Error("the subject probe must not start a CLI child");
          },
        },
        directDependencies: {
          fetch: (input, init) => {
            const url = String(input);
            requests.push({
              route: `${init?.method ?? "GET"} ${new URL(url).pathname}`,
              authorization: new Headers(init?.headers).get("Authorization"),
            });
            return Promise.resolve(directJsonResponse(
              url.endsWith("/v1/info") ? directInfo() : accounts(),
            ));
          },
        },
      });
      expect(subject).toBe(SUBJECT);
      expect(subject).not.toBe(staleSubject);
      expect(requests).toEqual([
        { route: "GET /v1/info", authorization: "Bearer fixture-never-read-by-test-runner" },
        { route: "GET /v1/accounts", authorization: "Bearer fixture-never-read-by-test-runner" },
      ]);
      expect(cliRuns).toBe(0);
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

  test("requires a durable private-root publisher when a cleanup registrar is present", async () => {
    const path = privateStore();
    let created = false;
    let barrier: Promise<void> | undefined;
    try {
      await expect(executeBeeperLocalOperation(recipe("accounts.list"), {}, auth(path), {
        registerCleanupBarrier: (value) => {
          barrier = value;
        },
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createCacheDirectory: async () => {
            created = true;
            return join(path, "must-not-exist");
          },
          run: runner([]),
        },
      })).rejects.toThrow("cleanup could not be proven");
      expect(created).toBeFalse();
      await expect(barrier!).rejects.toThrow("cleanup could not be proven");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("preserves a successful result while durable admission retains unsafe cleanup", async () => {
    const path = privateStore();
    const operationRoot = join(
      realpathSync(tmpdir()),
      `wrench-beeper-cli-cleanup-proof-${process.pid}-${Date.now().toString(36)}`,
    );
    let barrier: Promise<void> | undefined;
    let published = 0;
    try {
      const result = await executeBeeperLocalOperation(recipe("accounts.list"), {}, auth(path), {
        registerCleanupBarrier: (value) => {
          barrier = value;
          return () => {
            published += 1;
          };
        },
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createCacheDirectory: async () => operationRoot,
          removeCacheDirectory: async () => {
            throw new Error("fixture cleanup failure with a private path");
          },
          run: runner([]),
        },
      });
      expect(result.status).toBe("succeeded");
      expect(published).toBe(1);
      await expect(barrier!).rejects.toThrow("cleanup could not be proven");
    } finally {
      rmSync(path, { recursive: true, force: true });
      rmSync(operationRoot, { recursive: true, force: true });
    }
  });

  test("fulfills durable cleanup after an ordinary provider failure", async () => {
    const path = privateStore();
    const operationRoot = join(
      realpathSync(tmpdir()),
      `wrench-beeper-cli-cleanup-ordinary-${process.pid}-${Date.now().toString(36)}`,
    );
    let barrier: Promise<void> | undefined;
    let published = 0;
    try {
      await expect(executeBeeperLocalOperation(recipe("accounts.list"), {}, auth(path), {
        registerCleanupBarrier: (value) => {
          barrier = value;
          return () => {
            published += 1;
          };
        },
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          createCacheDirectory: async () => operationRoot,
          run: async (invocation) => {
            if (invocation.arguments[0] === "version") {
              return envelope({ name: "@beeper/cli", version: "0.6.2" });
            }
            if (invocation.arguments.slice(0, 2).join(" ") === "targets status") {
              return envelope(targetStatus());
            }
            throw new Error("ordinary fixture provider failure");
          },
        },
      })).rejects.toThrow("execution failed at a protected local boundary");
      expect(published).toBe(1);
      await expect(barrier!).resolves.toBeUndefined();
      expect(existsSync(operationRoot)).toBeFalse();
    } finally {
      rmSync(path, { recursive: true, force: true });
      rmSync(operationRoot, { recursive: true, force: true });
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
      await expect(probeBeeperLocalSubject({ ...auth(missing), path: missing }, {
        dependencies: {
          binaryPath: "/fixture/beeper-0.6.2",
          run: runner([]),
        },
      })).rejects.toThrow("subject probe failed at a protected local boundary");
      try {
        await probeBeeperLocalSubject({ ...auth(missing), path: missing }, {
          dependencies: {
            binaryPath: "/fixture/beeper-0.6.2",
            run: runner([]),
          },
        });
      } catch (error) {
        expect(String(error)).not.toContain(missing);
        expect(String(error)).not.toContain("sensitive-account-store-name");
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
