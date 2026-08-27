import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WrenchAuth } from "./auth";
import imsgManifest from "./assets/adapters/imessage/wrench-web-adapter.json";
import type { LocalCliRecipe } from "./model";
import { providerPluginRegistry } from "./provider-plugins";
import {
  IMSG_DIRECT_OPERATION_NAMES,
  IMSG_EXACT_CHAT_PATCH_SHA256,
  IMSG_PRIVATE_TRANSPORT_PATCH_SHA256,
  IMSG_REVIEWED_VERSION,
  IMSG_TOOL_PIN,
} from "./providers/imessage-direct";
import {
  imsgInstalledBinaryPath,
  installReviewedImsgBinary,
} from "./providers/imessage-direct-install";
import { imsgDirectMessagingDefinition } from "./providers/imessage-direct-messaging";
import {
  imsgMessageProviderId,
  materializeImsgMessagingRead,
} from "./providers/imessage-direct-omni";
import {
  executeImsgDirectOperation,
  executeImsgDirectMessagingPart,
  runImsgRpc,
  type ImsgRpcInvocation,
  type ImsgRpcInvocationResult,
  type ImsgTransportOutcome,
} from "./providers/imessage-direct-runtime";

const CHAT_GUID = "iMessage;+;fixture-chat";
const MESSAGE_GUID = "fixture-outgoing-guid";
const PRIVATE_TEXT = "private canary text\nwith a second line";

const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(path, 0o700);
  temporaryRoots.push(path);
  return path;
}

function cleanupTemporaryRoots(): void {
  while (temporaryRoots.length > 0) {
    const path = temporaryRoots.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
}

function auth(storePath: string): Extract<
  WrenchAuth,
  { readonly kind: "linked-device-store" }
> {
  const databasePath = join(storePath, "chat.db");
  if (!existsSync(databasePath)) writeFileSync(databasePath, "", { mode: 0o600 });
  return {
    schemaVersion: 1,
    id: "imessage-fixture",
    kind: "linked-device-store",
    provider: "imessage",
    path: storePath,
  };
}

function recipe(action: string): LocalCliRecipe {
  return {
    surface: "imessage",
    action,
    contractVersion: 1,
    timeoutMs: 5_000,
    maxOutputBytes: 1024 * 1024,
  };
}

function statusResult(databasePath: string): Readonly<Record<string, unknown>> {
  const methods = [
    "status",
    "chats.list",
    "chats.get",
    "messages.history",
    "send",
    "message.send_status",
  ];
  return Object.freeze({
    version: "0.14.1",
    protocol_version: 1,
    database: Object.freeze({
      path: databasePath,
      ready: true,
      features: Object.freeze({}),
    }),
    bridge: Object.freeze({ ready: false, error: "not running" }),
    contacts: Object.freeze({ available: true }),
    methods: Object.freeze(methods),
    supported_methods: Object.freeze(methods),
  });
}

function chat(): Readonly<Record<string, unknown>> {
  return Object.freeze({
      id: 7,
      name: "Fixture chat",
      identifier: "fixture@example.test",
      service: "iMessage",
      last_message_at: "2026-08-27T12:00:00Z",
      guid: CHAT_GUID,
      display_name: "Fixture Person",
      contact_name: "Fixture Person",
      is_group: false,
      participants: Object.freeze(["fixture@example.test"]),
      account_id: "observed-account-id",
      account_login: "observed@example.test",
      last_addressed_handle: "fixture@example.test",
      unread_count: 0,
  });
}

function chatListResult(): Readonly<Record<string, unknown>> {
  return Object.freeze({ chats: Object.freeze([chat()]) });
}

function exactChatResult(): Readonly<Record<string, unknown>> {
  return Object.freeze({ chat: chat() });
}

function messageResult(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    messages: Object.freeze([Object.freeze({
      id: 88,
      chat_id: 7,
      guid: "fixture-incoming-guid",
      reply_to_guid: null,
      sender: "fixture@example.test",
      sender_name: "Fixture Person",
      is_from_me: false,
      text: "current private context",
      created_at: "2026-08-27T12:00:00Z",
      attachments: Object.freeze([]),
      reactions: Object.freeze([]),
      chat_identifier: "fixture@example.test",
      chat_guid: CHAT_GUID,
      chat_name: "Fixture chat",
      participants: Object.freeze(["fixture@example.test"]),
      is_group: false,
    })]),
  });
}

function response(id: string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(
  id: string,
  disposition: "not_started" | "may_have_completed" | "still_in_flight",
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32001,
      message: "categorical fixture",
      data: {
        disposition,
        retry_safe: disposition === "not_started",
        transport: "applescript",
        operation: "send",
        detail: "fixture detail that is parsed but never returned",
      },
    },
  });
}

function runner(
  calls: ImsgRpcInvocation[],
  storePath: string,
  sendResult: "accepted" | "not_started" | "may_have_completed" | "still_in_flight" =
    "accepted",
): (invocation: ImsgRpcInvocation) => Promise<ImsgRpcInvocationResult> {
  return async (invocation) => {
    calls.push(invocation);
    await invocation.beforeSpawn?.();
    const requests = invocation.stdin.trimEnd().split("\n").map((line) =>
      JSON.parse(line) as { readonly id: string; readonly method: string });
    const lines = requests.map((request) => {
      if (request.method === "status") {
        return response(request.id, statusResult(join(storePath, "chat.db")));
      }
      if (request.method === "chats.list") return response(request.id, chatListResult());
      if (request.method === "chats.get") return response(request.id, exactChatResult());
      if (request.method === "messages.history") {
        return response(request.id, messageResult());
      }
      if (request.method === "send") {
        return sendResult === "accepted"
          ? response(request.id, {
              ok: true,
              transport: "applescript",
              id: 99,
              guid: MESSAGE_GUID,
              message_id: MESSAGE_GUID,
              chat_guid: CHAT_GUID,
              service: "iMessage",
            })
          : rpcError(request.id, sendResult);
      }
      throw new Error(`unexpected fixture method ${request.method}`);
    });
    return Object.freeze({
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    });
  };
}

describe("reviewed direct iMessage provider", () => {
  test("registers one exact local-CLI identity and semantic surface", () => {
    const plugin = providerPluginRegistry.get("imessage-direct");
    const binding = providerPluginRegistry.requireRoute("local-cli", "imessage");
    expect(plugin?.displayName).toBe("iMessage Reviewed Direct Transport");
    expect(imsgManifest.schemaVersion).toBe(6);
    expect(Object.keys(imsgManifest.operations).sort()).toEqual(
      [...IMSG_DIRECT_OPERATION_NAMES].sort(),
    );
    expect(binding.transport).toBe("local-cli");
    if (binding.transport !== "local-cli") throw new Error("wrong transport");
    expect(binding.authKinds).toEqual(["linked-device-store"]);
    expect(binding.tool).toMatchObject({
      id: IMSG_TOOL_PIN.id,
      implementation: IMSG_TOOL_PIN.implementation,
      version: IMSG_REVIEWED_VERSION,
      releaseCommit: IMSG_TOOL_PIN.upstreamCommit,
    });
    expect(binding.tool.artifacts).toEqual(IMSG_TOOL_PIN.artifacts);
    expect(binding.operations.map((operation) => operation.name).sort()).toEqual(
      [...IMSG_DIRECT_OPERATION_NAMES].sort(),
    );
    expect(binding.messaging?.action).toMatchObject({
      state: "supported",
      operation: "messaging.send",
      reply: "unsupported",
    });
    expect(binding.subject.matches(`imessage:device-default:${"a".repeat(64)}`))
      .toBeTrue();
    expect(binding.subject.matches("imessage:apple-id:reversible"))
      .toBeFalse();
  });

  test("keeps one private bubble out of both outer argv and environment", async () => {
    const storePath = temporaryRoot("wrench-imessage-store-");
    const calls: ImsgRpcInvocation[] = [];
    const events: string[] = [];
    try {
      const result = await executeImsgDirectMessagingPart(
        recipe("messaging.send"),
        {
          chat_guid: CHAT_GUID,
          service: "iMessage",
          observed_chat_row_id: 7,
          text: PRIVATE_TEXT,
        },
        auth(storePath),
        {
          dependencies: {
            binaryPath: "/fixture/reviewed-imsg",
            expectedMessagesStorePath: storePath,
            run: runner(calls, storePath),
          },
          beforeDispatch: async () => {
            events.push("durable-dispatch");
          },
          afterProviderAcceptedMutationTarget: async () => {
            events.push("accepted-target");
          },
          afterDispatchVerified: async () => {
            events.push("verified");
          },
        },
      );
      expect(result.status).toBe("succeeded");
      expect(result.dispatch).toEqual({ planned: 1, started: 1, verified: 1 });
      expect(result.output).toMatchObject({
        accountSelection: "device-default",
        service: "iMessage",
        transport: "applescript",
        smsFallback: false,
        transportOutcome: "accepted",
        acceptanceEvidence: "matching-outgoing-chat-db-row",
        messageGuid: MESSAGE_GUID,
      });
      if (imsgDirectMessagingDefinition.action.state !== "supported") {
        throw new Error("direct iMessage messaging action is unexpectedly unavailable");
      }
      expect(
        imsgDirectMessagingDefinition.action.mapAcceptedResult(result.output),
      ).toEqual({
        state: "submitted",
        providerMessageId: imsgMessageProviderId(MESSAGE_GUID),
        providerRevision: `99:${MESSAGE_GUID}`,
      });
      expect(events).toEqual(["durable-dispatch", "accepted-target", "verified"]);
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => JSON.stringify(call.arguments) === '["rpc"]'))
        .toBeTrue();
      expect(calls.some((call) => call.stdin.includes("private canary text"))).toBeTrue();
      for (const call of calls) {
        expect(JSON.stringify({
          arguments: call.arguments,
          environment: call.environment,
        })).not.toContain(PRIVATE_TEXT);
      }
      const requests: Array<{
        readonly method: string;
        readonly params: Record<string, unknown>;
      }> = calls.flatMap((call) =>
        call.stdin.trimEnd().split("\n").map((line) =>
          JSON.parse(line) as {
            readonly method: string;
            readonly params: Record<string, unknown>;
          }));
      const sendRequests = requests.filter((request) => request.method === "send");
      expect(sendRequests).toHaveLength(1);
      expect(sendRequests[0]?.params).toEqual({
        chat_guid: CHAT_GUID,
        text: PRIVATE_TEXT,
        service: "imessage",
        transport: "applescript",
        allow_sms_fallback: false,
      });
    } finally {
      cleanupTemporaryRoots();
    }
  });

  test("rejects non-send recipes at the dedicated messaging-part seam", async () => {
    const storePath = temporaryRoot("wrench-imessage-store-");
    try {
      await expect(executeImsgDirectMessagingPart(
        recipe("messaging.read"),
        { limit: 1 },
        auth(storePath),
        {
          dependencies: {
            binaryPath: "/fixture/reviewed-imsg",
            expectedMessagesStorePath: storePath,
            run: async () => {
              throw new Error("non-send messaging-part recipe started a process");
            },
          },
        },
      )).rejects.toThrow("requires messaging.send");
    } finally {
      cleanupTemporaryRoots();
    }
  });

  test("revalidates the exact live chat before materializing current context", async () => {
    const storePath = temporaryRoot("wrench-imessage-store-");
    const calls: ImsgRpcInvocation[] = [];
    const input = {
      chat_guid: CHAT_GUID,
      service: "iMessage",
      observed_chat_row_id: 7,
      limit: 25,
    } as const;
    try {
      const result = await executeImsgDirectOperation(
        recipe("messaging.read"),
        input,
        auth(storePath),
        {
          dependencies: {
            binaryPath: "/fixture/reviewed-imsg",
            expectedMessagesStorePath: storePath,
            run: runner(calls, storePath),
          },
        },
      );
      expect(result.status).toBe("succeeded");
      expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      expect(calls).toHaveLength(2);
      const operationMethods = calls[1]?.stdin.trimEnd().split("\n").map((line) =>
        (JSON.parse(line) as { readonly method: string }).method);
      expect(operationMethods).toEqual(["chats.get", "messages.history"]);
      const page = materializeImsgMessagingRead(input, result.output);
      expect(page.completeness.kind).toBe("bounded-local");
      expect(page.entities).toHaveLength(1);
      expect(page.entities[0]).toMatchObject({
        kind: "message",
        direction: "incoming",
        body: "current private context",
      });
      const exactTarget = imsgDirectMessagingDefinition.parseTarget({
        chatGuid: CHAT_GUID,
        service: "iMessage",
        observedChatRowId: "7",
      });
      expect(imsgDirectMessagingDefinition.contextInput(exactTarget, 25)).toEqual(input);
      expect(() => imsgDirectMessagingDefinition.action.state === "supported"
        ? imsgDirectMessagingDefinition.action.compileTurnPart(exactTarget, {
            partId: "reply",
            text: "not sent",
            replyToProviderId: "imessage:message:parent",
          })
        : undefined).toThrow("does not support threaded replies");
    } finally {
      cleanupTemporaryRoots();
    }
  });

  test("rejects a status probe bound to a different Messages database", async () => {
    const storePath = temporaryRoot("wrench-imessage-store-");
    const otherStorePath = temporaryRoot("wrench-imessage-other-store-");
    auth(otherStorePath);
    let calls = 0;
    try {
      const result = await executeImsgDirectOperation(
        recipe("messaging.list"),
        { limit: 10 },
        auth(storePath),
        {
          dependencies: {
            binaryPath: "/fixture/reviewed-imsg",
            expectedMessagesStorePath: storePath,
            run: async () => {
              calls += 1;
              return Object.freeze({
                exitCode: 0,
                stdout: `${response(
                  "status",
                  statusResult(join(otherStorePath, "chat.db")),
                )}\n`,
                stderr: "",
              });
            },
          },
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
      expect(calls).toBe(1);
    } finally {
      cleanupTemporaryRoots();
    }
  });

  for (const outcome of [
    "not_started",
    "may_have_completed",
    "still_in_flight",
  ] as const) {
    test(`preserves ${outcome} after spawn and never authorizes retry`, async () => {
      const storePath = temporaryRoot("wrench-imessage-store-");
      const calls: ImsgRpcInvocation[] = [];
      try {
        const result = await executeImsgDirectOperation(
          recipe("messaging.send"),
          {
            chat_guid: CHAT_GUID,
            service: "iMessage",
            observed_chat_row_id: 7,
            text: PRIVATE_TEXT,
          },
          auth(storePath),
          {
            dependencies: {
              binaryPath: "/fixture/reviewed-imsg",
              expectedMessagesStorePath: storePath,
              run: runner(calls, storePath, outcome),
            },
            beforeDispatch: async () => undefined,
          },
        );
        expect(result.status).toBe("indeterminate");
        expect(result.dispatch).toEqual({ planned: 1, started: 1, verified: 0 });
        expect(result.output).toMatchObject({
          transportOutcome: outcome satisfies ImsgTransportOutcome,
          retryAuthorized: false,
        });
        expect(calls).toHaveLength(2);
      } finally {
        cleanupTemporaryRoots();
      }
    });
  }

  test("treats a lost post-spawn response as indeterminate without retry", async () => {
    const storePath = temporaryRoot("wrench-imessage-store-");
    let calls = 0;
    try {
      const result = await executeImsgDirectOperation(
        recipe("messaging.send"),
        {
          chat_guid: CHAT_GUID,
          service: "iMessage",
          observed_chat_row_id: 7,
          text: PRIVATE_TEXT,
        },
        auth(storePath),
        {
          dependencies: {
            binaryPath: "/fixture/reviewed-imsg",
            expectedMessagesStorePath: storePath,
            run: async (invocation) => {
              calls += 1;
              await invocation.beforeSpawn?.();
              if (calls === 1) {
                return {
                  exitCode: 0,
                  stdout: `${response("status", statusResult(join(storePath, "chat.db")))}\n`,
                  stderr: "",
                };
              }
              throw new Error("lost fixture response");
            },
          },
          beforeDispatch: async () => undefined,
        },
      );
      expect(result.status).toBe("indeterminate");
      expect(result.output).toMatchObject({
        transportOutcome: "unknown_post_dispatch",
        retryAuthorized: false,
      });
      expect(calls).toBe(2);
    } finally {
      cleanupTemporaryRoots();
    }
  });

  test("reaps a timed-out detached RPC process group", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-imessage-timeout-")));
    chmodSync(root, 0o700);
    const executable = join(root, "imsg-fixture");
    const pidPath = join(root, "leader.pid");
    const nestedPidPath = join(root, "nested.pid");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s' \"$$\" > \"${pidPath}\"\nsleep 60 &\nprintf '%s' \"$!\" > \"${nestedPidPath}\"\nwait\n`,
      { mode: 0o500 },
    );
    let leaderPid = 0;
    try {
      await expect(runImsgRpc({
        binary: executable,
        arguments: ["rpc"],
        stdin: "{}\n",
        environment: { PATH: "/usr/bin:/bin", TMPDIR: root },
        timeoutMs: 3_000,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
        afterSpawn: (pid) => {
          leaderPid = pid;
        },
      })).rejects.toThrow("timed out");
      expect(leaderPid).toBeGreaterThan(0);
      expect(readFileSync(pidPath, "utf8")).toBe(String(leaderPid));
      const nestedPid = Number(readFileSync(nestedPidPath, "utf8"));
      expect(nestedPid).toBeGreaterThan(0);
      expect(() => process.kill(leaderPid, 0)).toThrow();
      expect(() => process.kill(nestedPid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reaps a crashing RPC child and reports its exit without foreign stderr", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-imessage-crash-")));
    chmodSync(root, 0o700);
    const executable = join(root, "imsg-fixture");
    writeFileSync(executable, "#!/bin/sh\nexit 23\n", { mode: 0o500 });
    try {
      const result = await runImsgRpc({
        binary: executable,
        arguments: ["rpc"],
        stdin: "{}\n",
        environment: { PATH: "/usr/bin:/bin", TMPDIR: root },
        timeoutMs: 2_000,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
      });
      expect(result).toEqual({ exitCode: 23, stdout: "", stderr: "" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("vendors the exact reviewed nested-argv and filesystem test patch", () => {
    const patchPath = join(
      import.meta.dir,
      "plugins",
      "imessage-direct",
      "vendor",
      "0001-fix-keep-AppleScript-send-payloads-out-of-child-argv.patch",
    );
    const bytes = readFileSync(patchPath);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(IMSG_PRIVATE_TRANSPORT_PATCH_SHA256);
    const source = bytes.toString("utf8");
    for (const proof of [
      "osascriptChildArgvContainsOnlyTheOpaquePayloadLocator",
      "privatePayloadRejectsSymlinkedFields",
      "privatePayloadRejectsSameModeSameSizeFileSubstitution",
      "privatePayloadRejectsSameInodeSameSizeContentChanges",
      "privatePayloadRejectsUnexpectedOwnerBeforeLaunch",
      "crashedChildIsReapedAndPrivatePayloadIsRemoved",
      "timedOutChildIsReapedBeforePrivatePayloadCleanup",
    ]) expect(source).toContain(proof);
  });

  test("vendors the exact row lookup required for live route revalidation", () => {
    const patchPath = join(
      import.meta.dir,
      "plugins",
      "imessage-direct",
      "vendor",
      "0002-feat-rpc-add-exact-chat-lookup.patch",
    );
    const bytes = readFileSync(patchPath);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(IMSG_EXACT_CHAT_PATCH_SHA256);
    const source = bytes.toString("utf8");
    expect(source).toContain("func handleChatsGet");
    expect(source).toContain('RPCMethodDescriptor("chats.get"');
    expect(source).toContain("rpcChatsGetReturnsOneExactChatPayload");
    expect(source).toContain("rpcChatsGetRejectsAnUnknownChatRow");
  });

  test("refuses to install unreviewed current-platform bytes", async () => {
    const state = temporaryRoot("wrench-imessage-state-");
    const sourceRoot = temporaryRoot("wrench-imessage-unreviewed-");
    const source = join(sourceRoot, "imsg");
    writeFileSync(source, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
    try {
      await expect(installReviewedImsgBinary(source, {
        WRENCH_STATE_HOME: state,
      })).rejects.toThrow("reviewed digest");
      expect(existsSync(imsgInstalledBinaryPath({ WRENCH_STATE_HOME: state })))
        .toBeFalse();
    } finally {
      cleanupTemporaryRoots();
    }
  });
});
